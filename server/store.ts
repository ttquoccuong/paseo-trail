import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_ID_PATTERN, checklistItemSchema, displayModeSchema, type ChecklistItem, type DisplayMode, type SessionLink } from "../shared/links";
import { bundleFiles } from "./bundle";
import { displayPath } from "./display-paths";
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
import { gitlabIssueUrls, hashReferenceRepository, resolveMentions, type ProjectCandidate } from "./mr-refs";
import { canonicalHost } from "./extract";
import { isProjectPath } from "../shared/config";
import { isReallyInsideSync, readTextFile, setBounded } from "./files";
import { POLL_GLOB_BUDGET } from "./project-config";
import { boundScan, canonicalUrl, emptyScan, mergeScans, withoutUserInfo, type ScanState, type TimelineScan } from "./scan";
import { closeCandidates, emptyLedger, migrateWeights, rankTasks, type TaskEvidence, type TaskLedger } from "./task-evidence";

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
  /** GitLab projects this machine's sessions opened pages of, with their host (`gitlabProjects()`). */
  gitlabProjects?: ReadonlyMap<string, string>;
}

// A GitLab page: everything before `/-/` is the project path. `groups/…` pages belong to a group.
const GITLAB_PAGE = /^https?:\/\/([^/\s]+)\/((?!groups\/)[^\s]+?)\/-\//;
// Every session's scan is read to learn them; past these counts the rest are left out.
const MAX_SCANS_READ = 500;
const MAX_GITLAB_PROJECTS = 1000;
const GITLAB_PROJECTS_TTL_MS = 30_000;
// `https://github.com/<owner>/<repo>…`; paths that are github.com's own pages are not repositories.
const GITHUB_PAGE = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/;
const GITHUB_NOT_OWNERS = new Set(["settings", "orgs", "users", "apps", "marketplace", "sponsors", "notifications", "login", "features", "topics", "collections", "search", "pulls", "issues", "explore"]);

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
// Docs offered when the guessed task is unsure, the guess included.
const MAX_TASK_CANDIDATES = 4;

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

const evidenceSchema = z.object({
  doc: z.string().max(MAX_TARGET_LENGTH),
  signal: z.enum(["user", "edit", "read", "mention", "legacy"]),
  turn: z.number().int().nonnegative(),
  points: z.number().nonnegative().finite(),
});
const ledgerSchema = z.object({
  turn: z.number().int().nonnegative(),
  turnKeys: z.array(z.string().max(64)),
  // One malformed entry is left out rather than dropping the rest.
  evidence: z.array(z.unknown()).transform((entries) =>
    entries.flatMap((entry): TaskEvidence[] => {
      const parsed = evidenceSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});

// State files are rewritten by this daemon and by each agent's MCP server; one that was cut short or
// edited by hand is read as empty instead of breaking the session for good.
const scanSchema = z
  .object({
    // Earlier versions kept one weight per doc.
    tasks: z
      .union([ledgerSchema, z.record(z.string(), z.number()).transform(migrateWeights)])
      .catch((): TaskLedger => emptyLedger()),
    mergeRequests: z.array(z.string()).catch([]),
    // Earlier versions kept references apart from URLs; they are folded into the one list.
    mergeRequestRefs: z.array(z.string()).optional().catch(undefined),
    urls: z.array(z.string()).catch([]),
    files: z.record(z.string(), z.enum(["read", "edited"])).catch({}),
  })
  .transform(({ mergeRequestRefs, ...scan }) =>
    // The current caps also apply to a file written before them.
    boundScan({ ...scan, mergeRequests: [...scan.mergeRequests, ...(mergeRequestRefs ?? [])] }),
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

// The agent's MCP server is the only writer of the task file; the daemon only reads it. Thirty
// items of a few hundred characters each stay far under this.
const MAX_TASK_FILE_BYTES = 256 * 1024;
const MAX_TASK_TITLE_LENGTH = 200;
// Stands in for the task's identity when it has only a title, not a doc or a tracker page.
const SESSION_TASK_URL = "task:session";

export interface SessionTask {
  title?: string;
  items: ChecklistItem[];
}

async function readTask(file: string): Promise<SessionTask> {
  const stored = (await readJson(file, MAX_TASK_FILE_BYTES)) as { title?: unknown; items?: unknown } | undefined;
  const title = typeof stored?.title === "string" ? stored.title.slice(0, MAX_TASK_TITLE_LENGTH).trim() : "";
  const items = (Array.isArray(stored?.items) ? stored.items : []).flatMap((item) => {
    const parsed = checklistItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return title ? { title, items } : { items };
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

  /** The session's main task as the agent stated it, and the checklist of what it needs. */
  task(agentId: string): Promise<SessionTask> {
    return readTask(this.stateFile(agentId, "task"));
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
   * A file's label is its path from `cwd`, the agent's working directory.
   */
  async otherLinks(
    agentId: string,
    shown: SessionLink[],
    cwd?: string,
    { catalog = [], gitlabProjects }: Pick<LinkContext, "gitlabProjects"> & { catalog?: LinkContext["catalog"] } = {},
  ): Promise<SessionLink[]> {
    const scan = await this.scan(agentId);
    const taken = new Set(shown.map((link) => link.url));
    // `group/project#N` of a GitLab project is an issue; it joins the other pages, never the MRs.
    const issues = gitlabIssueUrls(scan.mergeRequests, catalog, gitlabProjects ?? new Map()).flatMap((url) => each(url, gitlabIssueLink));
    const files = Object.entries(scan.files ?? {})
      .flatMap(([path, use]) => each(path, (file) => fileLink(file, use === "edited")))
      .filter((link) => !shown.some((other) => other.localPath === link.localPath));
    // Scans saved before URLs were normalised can hold both spellings of one page.
    const pages = [...new Set([...(scan.urls ?? []).map(canonicalUrl), ...issues.map((link) => link.url)])]
      .flatMap((url) => issues.find((issue) => issue.url === url) ?? each(url, urlLink))
      .filter((link) => !taken.has(link.url));
    const group = (kind: SessionLink["kind"], links: SessionLink[]) =>
      links.filter((link) => link.kind === kind).slice(-MAX_PER_GROUP);
    const listedFiles = group("file", files).map((link) => ({ ...link, label: displayPath(link.title, cwd) }));
    return [...listedFiles, ...group("doc", pages), ...group("link", pages)];
  }

  private gitlabCache: { at: number; trusted: string; projects: ReadonlyMap<string, string> } | undefined;

  /**
   * GitLab projects named by pages any session on this machine opened, each with its host. Only
   * `trustedHosts` count (the user's own GitLab hosts): a page anywhere else in a conversation must not
   * turn a GitHub reference into a link to that site. A project seen on two hosts is left out, since
   * either could be meant. Re-read at most every 30 seconds.
   */
  async gitlabProjects(trustedHosts: ReadonlySet<string>): Promise<ReadonlyMap<string, string>> {
    const trusted = [...trustedHosts].sort().join(" ");
    const cached = this.gitlabCache;
    if (cached && cached.trusted === trusted && Date.now() - cached.at < GITLAB_PROJECTS_TTL_MS) return cached.projects;
    const hosts = new Map<string, Set<string>>();
    for (const url of await this.machineUrls()) {
      const page = GITLAB_PAGE.exec(url);
      const host = page ? canonicalHost(page[1]) : null;
      if (!page || !host || !trustedHosts.has(host) || !page[2].includes("/") || !isProjectPath(page[2])) continue;
      const seen = hosts.get(page[2]) ?? new Set<string>();
      seen.add(host);
      if (hosts.size < MAX_GITLAB_PROJECTS || hosts.has(page[2])) hosts.set(page[2], seen);
    }
    const projects = new Map([...hosts].flatMap(([project, on]) => (on.size === 1 ? [[project, [...on][0]] as const] : [])));
    this.gitlabCache = { at: Date.now(), trusted, projects };
    return projects;
  }

  private urlsCache: { at: number; urls: string[] } | undefined;

  /** Every URL any session on this machine has, from MR mentions and pages; re-read every 30 seconds. */
  private async machineUrls(): Promise<string[]> {
    if (this.urlsCache && Date.now() - this.urlsCache.at < GITLAB_PROJECTS_TTL_MS) return this.urlsCache.urls;
    let names: string[] = [];
    try {
      names = (await readdir(this.stateDir)).filter((name) => name.endsWith(".scanned.json")).slice(0, MAX_SCANS_READ);
    } catch {
      // No state yet.
    }
    const urls: string[] = [];
    for (const name of names) {
      const scan = await readScan(join(this.stateDir, name));
      urls.push(...scan.mergeRequests.filter((mention) => /^https?:\/\//.test(mention)), ...(scan.urls ?? []));
    }
    this.urlsCache = { at: Date.now(), urls };
    return urls;
  }

  /** Repositories any session on this machine opened on github.com: `owner/repo`. */
  async githubRepos(): Promise<ReadonlySet<string>> {
    const repos = new Set<string>();
    for (const url of await this.machineUrls()) {
      const match = GITHUB_PAGE.exec(url);
      if (match && !GITHUB_NOT_OWNERS.has(match[1]) && isProjectPath(`${match[1]}/${match[2]}`)) repos.add(`${match[1]}/${match[2]}`);
    }
    return repos;
  }

  /** Repositories this session named as `owner/repo#N`, each once. */
  async hashReferenceRepos(agentId: string): Promise<string[]> {
    return [...new Set((await this.scan(agentId)).mergeRequests.flatMap((mention) => hashReferenceRepository(mention) ?? []))];
  }

  private async scan(agentId: string): Promise<ScanState> {
    const cached = this.scans.get(agentId);
    if (cached) return cached;
    const stored = await readScan(this.scanFile(agentId));
    this.scans.set(agentId, stored);
    return stored;
  }

  async saveScan(agentId: string, next: TimelineScan): Promise<void> {
    const merged = mergeScans(await this.scan(agentId), next);
    this.scans.set(agentId, merged);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const file = this.scanFile(agentId);
    await writeAtomically(file, JSON.stringify(merged));
  }

  async links(agentId: string, { rules, catalog, defaultHost, taskIdSources = [], gitlabProjects }: LinkContext): Promise<SessionLink[]> {
    const scan = await this.scan(agentId);
    // One matching budget for every pin of this poll, however many there are.
    const budget = { left: POLL_GLOB_BUDGET };
    const reported = (await this.pins(agentId))
      .flatMap((entry) => each(entry, (pin) => ({ entry: pin, link: reportedLink(pin.target, pin.kind, pin.label, rules, budget) })))
      .filter((item): item is { entry: ReportedEntry; link: SessionLink } => item.link !== null);

    const reportedTasks = reported.filter(({ link }) => link.kind === "task");
    const stated = await this.task(agentId);
    // What the agent explicitly pinned beats what the scan guesses, and so does a task it named:
    // reading some other doc along the way must not move the session's task.
    const declaredTask =
      reportedTasks.findLast(({ entry }) => entry.primary)?.link ??
      reportedTasks[reportedTasks.length - 1]?.link ??
      (stated.title || stated.items.length > 0 ? sessionTaskLink(stated.title) : undefined);
    const mainTask = declaredTask ?? (rules ? guessedTask(scan.tasks, rules) : undefined) ?? taskIdLink(taskIdSources, rules) ?? undefined;

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
      resolveMentions(scan.mergeRequests, knownUrls, catalog, defaultHost, gitlabProjects).flatMap((url) => each(url, changeRequestLink)),
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

/**
 * The doc the conversation points to most, among those still on disk. When others come close, the
 * link carries them all so the user can pick, since the guess may be wrong.
 */
function guessedTask(ledger: TaskLedger, rules: TaskDocRules): SessionLink | undefined {
  const ranked = rankTasks(ledger, (doc) => taskDocPath(doc, rules) !== undefined);
  const [guess] = ranked.flatMap(({ doc }) => each(doc, (path) => taskLink(path, rules)));
  if (!guess) return undefined;
  const candidates = closeCandidates(ranked, MAX_TASK_CANDIDATES).flatMap(({ doc }) =>
    each(doc, (path) => ({ target: path, label: taskLink(path, rules).label, title: path })),
  );
  return candidates.length > 0 ? { ...guess, candidates } : guess;
}

// `https://host/group/project/-/issues/N`, labelled the way the bar labels requests: `#N project`.
function gitlabIssueLink(url: string): SessionLink {
  const match = /^https:\/\/[^/]+\/(.+)\/-\/issues\/(\d+)$/.exec(url);
  if (!match) throw new Error(`Not a GitLab issue URL: ${url}`);
  return { url, kind: "link", label: `#${match[2]} ${match[1].split("/").pop()}`, title: `${match[1]}#${match[2]}` };
}

// A checklist with no named task still needs a pill to open from.
function sessionTaskLink(title: string | undefined): SessionLink {
  const name = title ?? "Checklist";
  return { url: SESSION_TASK_URL, kind: "task", label: name, title: name };
}

// A task link's title is its doc path relative to the configured root.
function withLocalPath(link: SessionLink, rules: TaskDocRules, listBundle: boolean): SessionLink {
  // A stated task's title is free text from the agent, not a path that matched the doc globs.
  if (link.kind !== "task" || link.url === SESSION_TASK_URL) return link;
  const localPath = taskDocPath(link.title, rules);
  if (localPath === undefined) return link;
  const bundle = listBundle && rules.bundle === "siblings" ? bundleFiles(localPath) : [];
  return bundle.length > 0 ? { ...link, localPath, bundle } : { ...link, localPath };
}

/** A task doc's working copy under the docs root; undefined when there is none to open. */
function taskDocPath(doc: string, rules: TaskDocRules): string | undefined {
  const localPath = join(rules.root, doc);
  // Doc paths come from conversation text; one that resolves out of the root, through `..` or a
  // symlink, or is not a regular file, is not opened.
  if (!isReallyInsideSync(rules.root, localPath) || !isRegularFile(localPath)) return undefined;
  // The docs root itself may be a symlink out of the project.
  if (rules.boundary !== undefined && !isReallyInsideSync(rules.boundary, localPath)) return undefined;
  return localPath;
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
