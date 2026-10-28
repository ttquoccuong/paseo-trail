import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_ID_PATTERN, displayModeSchema, type DisplayMode, type SessionLink } from "../shared/links";
import { bundleFiles } from "./bundle";
import {
  fileLink,
  findChangeRequests,
  changeRequestLink,
  reportedLink,
  taskIdLink,
  taskLink,
  urlLink,
  type TaskDocRules,
} from "./extract";
import { resolveMentions, type ProjectCandidate } from "./mr-refs";
import { isReallyInsideSync, readTextFile, setBounded } from "./files";
import { POLL_GLOB_BUDGET } from "./project-config";
import { canonicalUrl, emptyScan, mainScannedTask, mergeScans, withoutUserInfo, type ScanState } from "./scan";

/** What the agent's project config contributes to its links. */
export interface LinkContext {
  /** Without task-doc rules the session has no task doc. */
  rules: TaskDocRules | null;
  /** Projects `name !N` references may name. */
  catalog: Array<ProjectCandidate & { name: string }>;
  /** Host for `group/project!N` references when the config names exactly one GitLab. */
  defaultHost: string | undefined;
  /** Where a task ID may appear when the session has no task doc: git branch, agent title. */
  taskIdSources?: Array<string | null | undefined>;
}

/**
 * One pin. The agent's MCP server (bin/trail-mcp.mjs) writes `<agent>.reported.json` and this
 * daemon writes `<agent>.pins.json`, each process only its own file, so neither can overwrite a
 * pin the other just made. Reading merges both: per target, the latest entry wins, and an entry
 * marked `removed` hides earlier pins of that target.
 */
interface ReportedEntry {
  target: string;
  kind?: SessionLink["kind"];
  label?: string;
  primary?: boolean;
  at?: string;
  removed?: boolean;
}

// Pins beyond this many push out the oldest; the MCP server applies the same cap and lengths.
const MAX_PINS = 50;
const MAX_TARGET_LENGTH = 2048;
const MAX_LABEL_LENGTH = 200;
// A task doc cloned from elsewhere may list any number of MRs; each listed one is polled.
const MAX_DOC_MERGE_REQUESTS = 20;
// Shell output that lists many MRs would otherwise crowd the bar; keep the latest ones.
const MAX_MERGE_REQUESTS = 5;
// A long session touches dozens of files and pages; each group keeps its most recent ones.
const MAX_PER_GROUP = 15;

// A task doc lists its own MRs. Agents usually read the doc through the shell, which the scan
// skips, and name MRs as `repo !N` without a URL, so the doc is the reliable source. A configured
// section (such as `Related`) narrows that to the links the doc says belong to the task.
// The doc is read on every poll; it is bounded like any file a project names, and re-read only
// when it changes, failures included.
const MAX_TASK_DOC_BYTES = 512 * 1024;
const taskDocCache = new Map<string, { mtimeMs: number; urls: string[] }>();

async function taskDocMergeRequests(path: string, section: string | undefined): Promise<string[]> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return [];
  }
  const key = `${path}\u0000${section ?? ""}`;
  const cached = taskDocCache.get(key);
  if (cached?.mtimeMs === mtimeMs) return cached.urls;
  const read = await readTextFile(path, MAX_TASK_DOC_BYTES);
  let urls: string[] = [];
  if (read?.kind === "text") {
    const text = read.text;
    if (!section) {
      urls = findChangeRequests(text);
    } else {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = new RegExp(`^#{1,6} ${escaped}[ \\t]*$([\\s\\S]*?)(?=^#{1,6} |(?![\\s\\S]))`, "m").exec(text)?.[1];
      urls = findChangeRequests(body ?? "");
    }
  }
  setBounded(taskDocCache, key, { mtimeMs, urls });
  return urls;
}

// State files are rewritten by this daemon and by each agent's MCP server; one that was cut short or
// edited by hand is read as empty instead of breaking the session for good.
const scanSchema = z
  .object({
    tasks: z.record(z.string(), z.number()).catch({}),
    mergeRequests: z.array(z.string()).catch([]),
    // Earlier versions kept references apart from URLs; they are folded into the one list.
    mergeRequestRefs: z.array(z.string()).optional().catch(undefined),
    urls: z.array(z.string()).catch([]),
    files: z.record(z.string(), z.enum(["read", "edited"])).catch({}),
  })
  .transform(({ mergeRequestRefs, ...scan }) =>
    // Merging into an empty scan also applies the current caps to a file written before them.
    mergeScans(emptyScan(), { ...scan, mergeRequests: [...scan.mergeRequests, ...(mergeRequestRefs ?? [])] }),
  );
const reportedEntrySchema = z.object({
  target: z.string().max(MAX_TARGET_LENGTH),
  kind: z.enum(["task", "mr", "file", "doc", "link"]).optional().catch(undefined),
  label: z.string().max(MAX_LABEL_LENGTH).optional().catch(undefined),
  primary: z.boolean().optional().catch(undefined),
  at: z.string().optional().catch(undefined),
  removed: z.boolean().optional().catch(undefined),
});
const modeSchema = z.object({ mode: displayModeSchema.optional().catch(undefined) });

// The MCP server writes the same pin file from another process; each writer uses its own
// temporary name so two pins at once never rename one another's half-written file.
async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

// State files hold a few capped lists; anything larger, or not a regular file, is read as empty.
const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** How a pin target is stored: trimmed, and a URL without any `user:password@` it carried. */
function pinKey(target: string): string {
  const trimmed = target.trim();
  return /^https?:\/\//i.test(trimmed) ? (withoutUserInfo(trimmed) ?? trimmed) : trimmed;
}

async function readJson(file: string, maxBytes = MAX_STATE_BYTES): Promise<unknown> {
  const read = await readTextFile(file, maxBytes);
  if (read?.kind !== "text") return undefined;
  try {
    return JSON.parse(read.text);
  } catch {
    return undefined;
  }
}

async function readScan(file: string): Promise<ScanState> {
  const parsed = scanSchema.safeParse(await readJson(file));
  return parsed.success ? parsed.data : emptyScan();
}

// Fifty pins of 2,048 characters, even in four-byte characters, stay under this; a larger file is
// not a pin file.
const MAX_PIN_FILE_BYTES = 1024 * 1024;

async function readReported(file: string): Promise<ReportedEntry[]> {
  const stored = await readJson(file, MAX_PIN_FILE_BYTES);
  // Only the newest pins count, so only they are checked.
  return (Array.isArray(stored) ? stored.slice(-MAX_PINS) : []).flatMap((entry) => {
    const parsed = reportedEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export class LinkStore {
  private readonly scans = new Map<string, ScanState>();

  /** Drops what is held in memory for an agent that was closed or archived; its files stay. */
  forget(agentId: string): void {
    this.scans.delete(agentId);
  }

  constructor(private readonly stateDir: string) {
    // A folder made by an earlier version, or by hand, may be readable by others; it holds the
    // links of every session.
    void chmod(stateDir, 0o700).catch(() => undefined);
  }

  // The RPC schemas already check agent ids; this is the last guard before a file name is built.
  private stateFile(agentId: string, suffix: string) {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error(`Not an agent id: ${agentId}`);
    return join(this.stateDir, `${agentId}.${suffix}.json`);
  }

  private scanFile(agentId: string) {
    return this.stateFile(agentId, "scanned");
  }

  reportedFile(agentId: string) {
    return this.stateFile(agentId, "reported");
  }

  private pinsFile(agentId: string) {
    return this.stateFile(agentId, "pins");
  }

  /** The agent's current pins, from both files, oldest first. */
  async pins(agentId: string): Promise<ReportedEntry[]> {
    const entries = [...(await readReported(this.reportedFile(agentId))), ...(await readReported(this.pinsFile(agentId)))];
    const latest = new Map<string, ReportedEntry>();
    // Stable sort: entries without a time (older versions) count as oldest.
    for (const entry of entries.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))) {
      const key = entry.target.trim();
      latest.delete(key);
      latest.set(key, { ...entry, target: key });
    }
    return [...latest.values()].filter((entry) => !entry.removed).slice(-MAX_PINS);
  }

  private modeFile(agentId: string) {
    return this.stateFile(agentId, "mode");
  }

  /** The mode chosen for this session, or undefined to use the default. */
  async mode(agentId: string): Promise<DisplayMode | undefined> {
    const parsed = modeSchema.safeParse(await readJson(this.modeFile(agentId)));
    return parsed.success ? parsed.data.mode : undefined;
  }

  async setMode(agentId: string, mode: DisplayMode): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const file = this.modeFile(agentId);
    await writeAtomically(file, JSON.stringify({ mode }));
  }

  /** Adds a pin (replacing an earlier pin of the same target) or removes it, in the MCP tool's format. */
  /** Removes a pin; false when there was no pin of that target, and nothing is written. */
  async unpin(agentId: string, target: string): Promise<boolean> {
    const key = pinKey(target);
    if (!(await this.pins(agentId)).some((pin) => pin.target === key)) return false;
    await this.pin(agentId, null, target);
    return true;
  }

  // Pins of one agent are read, changed and written one at a time, so two at once both land.
  private readonly pinQueues = new Map<string, Promise<void>>();

  pin(agentId: string, entry: ReportedEntry | null, target: string): Promise<void> {
    const previous = this.pinQueues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writePin(agentId, entry, target));
    this.pinQueues.set(agentId, next);
    const settle = () => {
      if (this.pinQueues.get(agentId) === next) this.pinQueues.delete(agentId);
    };
    next.then(settle, settle);
    return next;
  }

  private async writePin(agentId: string, entry: ReportedEntry | null, target: string): Promise<void> {
    const file = this.pinsFile(agentId);
    const key = pinKey(target);
    const entries = (await readReported(file)).filter((existing) => existing.target.trim() !== key);
    // Unpinning leaves a marker, so a pin of the same target in the MCP server's file is hidden too.
    entries.push(entry ? { ...entry, target: key, at: new Date().toISOString() } : { target: key, removed: true, at: new Date().toISOString() });
    entries.splice(0, Math.max(0, entries.length - MAX_PINS));
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeAtomically(file, JSON.stringify(entries));
  }

  /** Local files the agent touched, for checking a file read request against. */
  async sessionFiles(agentId: string): Promise<string[]> {
    return Object.keys((await this.scan(agentId)).files ?? {});
  }

  /**
   * What "all links" adds to the task view: files the agent touched, then pages from messages,
   * each group newest last and capped. Links already shown elsewhere are left to their button.
   */
  async otherLinks(agentId: string, shown: SessionLink[]): Promise<SessionLink[]> {
    const scan = await this.scan(agentId);
    const taken = new Set(shown.map((link) => link.url));
    const files = Object.entries(scan.files ?? {})
      .flatMap(([path, use]) => each(path, (file) => fileLink(file, use === "edited")))
      .filter((link) => !shown.some((other) => other.localPath === link.localPath));
    // Scans saved before URLs were normalised can hold both spellings of one page.
    const pages = [...new Set((scan.urls ?? []).map(canonicalUrl))]
      .flatMap((url) => each(url, urlLink))
      .filter((link) => !taken.has(link.url));
    const group = (kind: SessionLink["kind"], links: SessionLink[]) =>
      links.filter((link) => link.kind === kind).slice(-MAX_PER_GROUP);
    return [...group("file", files), ...group("doc", pages), ...group("link", pages)];
  }

  private async scan(agentId: string): Promise<ScanState> {
    const cached = this.scans.get(agentId);
    if (cached) return cached;
    const stored = await readScan(this.scanFile(agentId));
    this.scans.set(agentId, stored);
    return stored;
  }

  async saveScan(agentId: string, next: ScanState): Promise<void> {
    const merged = mergeScans(await this.scan(agentId), next);
    this.scans.set(agentId, merged);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const file = this.scanFile(agentId);
    await writeAtomically(file, JSON.stringify(merged));
  }

  async links(agentId: string, { rules, catalog, defaultHost, taskIdSources = [] }: LinkContext): Promise<SessionLink[]> {
    const scan = await this.scan(agentId);
    // One matching budget for every pin of this poll, however many there are.
    const budget = { left: POLL_GLOB_BUDGET };
    const reported = (await this.pins(agentId))
      .flatMap((entry) => each(entry, (pin) => ({ entry: pin, link: reportedLink(pin.target, pin.kind, pin.label, rules, budget) })))
      .filter((item): item is { entry: ReportedEntry; link: SessionLink } => item.link !== null);

    const reportedTasks = reported.filter(({ link }) => link.kind === "task");
    const scannedTask = mainScannedTask(scan);
    // What the agent explicitly pinned beats what the scan guesses.
    const mainTask =
      reportedTasks.findLast(({ entry }) => entry.primary)?.link ??
      reportedTasks[reportedTasks.length - 1]?.link ??
      (scannedTask && rules ? each(scannedTask, (doc) => taskLink(doc, rules))[0] : undefined) ??
      taskIdLink(taskIdSources, rules) ??
      undefined;

    // The doc's MRs are the task's own and are never capped; MRs seen in the session come after
    // them because they are usually newer, and the menu lists the last entry first.
    const docPath = mainTask && rules && withLocalPath(mainTask, rules, false).localPath;
    const docUrls = docPath ? (await taskDocMergeRequests(docPath, rules?.relatedSection)).slice(0, MAX_DOC_MERGE_REQUESTS) : [];
    const reportedMergeRequests = reported.filter(({ link }) => link.kind === "mr").map(({ link }) => link);
    const knownUrls = [...docUrls, ...reportedMergeRequests.map(({ url }) => url)];
    const docMergeRequests = docUrls.flatMap((url) => each(url, changeRequestLink));
    // The task doc's requests and the ones the agent pinned are always listed. Only requests that
    // were merely mentioned are capped: the most recent ones not already listed. Mentions are least
    // recent first, and one request can be mentioned several ways, so its last mention counts.
    const listed = new Set([...docMergeRequests, ...reportedMergeRequests].map((link) => link.url));
    const mentioned = latestByUrl(
      resolveMentions(scan.mergeRequests, knownUrls, catalog, defaultHost).flatMap((url) => each(url, changeRequestLink)),
    ).filter((link) => !listed.has(link.url));

    const ordered = [
      ...(mainTask ? [mainTask] : []),
      ...reportedTasks.map(({ link }) => link),
      ...docMergeRequests,
      ...reportedMergeRequests,
      ...mentioned.slice(-MAX_MERGE_REQUESTS),
      ...reported.filter(({ link }) => link.kind === "link").map(({ link }) => link),
    ];
    // Only the session's main task lists its bundle; other pinned tasks get their local file alone,
    // so no number of pins makes a poll walk more than one folder.
    return uniqueByUrl(ordered).flatMap((link) => (rules ? each(link, (item) => withLocalPath(item, rules, item === mainTask)) : [link]));
  }

  async mainTask(agentId: string, context: LinkContext): Promise<SessionLink | undefined> {
    return (await this.links(agentId, context)).find((link) => link.kind === "task");
  }
}

// A task link's title is its doc path relative to the configured root.
function withLocalPath(link: SessionLink, rules: TaskDocRules, listBundle: boolean): SessionLink {
  if (link.kind !== "task") return link;
  const localPath = join(rules.root, link.title);
  // Doc paths come from conversation text; one that resolves out of the root, through `..` or a
  // symlink, or is not a regular file, is not opened.
  if (!isReallyInsideSync(rules.root, localPath) || !isRegularFile(localPath)) return link;
  // The docs root itself may be a symlink out of the project.
  if (rules.boundary !== undefined && !isReallyInsideSync(rules.boundary, localPath)) return link;
  const bundle = listBundle && rules.bundle === "siblings" ? bundleFiles(localPath) : [];
  return bundle.length > 0 ? { ...link, localPath, bundle } : { ...link, localPath };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `make(item)` as a one-item list, or an empty one when it throws. Everything here is built from
 * chat text and state files; one entry that cannot become a link is left out instead of failing
 * the whole session's bar.
 */
function each<T, U>(item: T, make: (item: T) => U): U[] {
  try {
    return [make(item)];
  } catch {
    return [];
  }
}

/** Each URL once, at the place of its last occurrence. */
function latestByUrl(links: SessionLink[]): SessionLink[] {
  const latest = new Map<string, SessionLink>();
  for (const link of links) {
    latest.delete(link.url);
    latest.set(link.url, link);
  }
  return [...latest.values()];
}

function uniqueByUrl(links: SessionLink[]): SessionLink[] {
  const seen = new Set<string>();
  return links.filter((link) => !seen.has(link.url) && seen.add(link.url));
}
