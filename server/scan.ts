import { createHash } from "node:crypto";
import { findChangeRequests, findTaskDocs, type TaskDocRules } from "./extract";
import { findMergeRequestRefs } from "./mr-refs";
import { SCAN_GLOB_BUDGET, trimEnd } from "./project-config";
import { emptyLedger, recordSightings, type TaskLedger, type TaskSighting } from "./task-evidence";

export interface ScanState {
  /** Evidence of which task doc this session works on. */
  tasks: TaskLedger;
  /**
   * MR and PR URLs, and `name!N` / `group/project!N` references written without one (resolved when
   * listed), least recently mentioned first.
   */
  mergeRequests: string[];
  /** Other http(s) URLs from messages, least recently mentioned first. */
  urls?: string[];
  /** Absolute paths of local files the agent read or changed, least recently touched first. */
  files?: Record<string, "read" | "edited">;
}

// A session is scanned every 30 seconds and its state kept on disk, so every list is capped at a
// few times what the bar shows (5 requests, 15 entries per group) and every text is cut short.
export const SCAN_LIMITS = {
  mergeRequests: 40,
  urls: 60,
  files: 60,
  /** Per message. */
  textLength: 64 * 1024,
  /** Per scan: the newest messages up to this much text are read, older ones were read before. */
  totalText: 2 * 1024 * 1024,
} as const;

/** Moves `value` to the most recent end of an insertion-ordered set or map. */
function touch<T>(set: Set<T>, value: T): void {
  set.delete(value);
  set.add(value);
}

function newest<T>(values: Iterable<T>, limit: number): T[] {
  return [...values].slice(-limit);
}

// Stops at whitespace, quotes and brackets, which in prose and Markdown end a URL.
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]`"']+/g;
// Sentence punctuation directly after a URL belongs to the sentence.
const TRAILING_PUNCTUATION = ".,;:!?";

// `https://host` and `https://host/` are one page; a trailing slash on a path is the same page too.
export function canonicalUrl(url: string): string {
  return url.replace(/(?<=[^/:])\/(?=$|[?#])/, "");
}

// Longer than any page address worth a button; such text is data, not a link.
const MAX_URL_LENGTH = 2048;

/** URLs in text, each one a client can parse, without any `user:password@`; anything else is dropped. */
export function findUrls(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].flatMap(([raw]) => {
    const url = withoutUserInfo(canonicalUrl(trimEnd(raw, TRAILING_PUNCTUATION)));
    return url !== null && url.length <= MAX_URL_LENGTH ? [url] : [];
  });
}

/**
 * `url` with any user name and password taken out, since links are kept in state files and shown
 * in menus; null when it does not parse.
 */
export function withoutUserInfo(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return canonicalUrl(parsed.href);
  } catch {
    return null;
  }
}

export interface TimelineItemLike {
  type: string;
  text?: string;
  /** When the entry was recorded; tells two user messages with the same text apart. */
  timestamp?: string;
  detail?: { type?: string; filePath?: string };
}

/** The links one scan of the timeline found, and the task docs it saw, for `mergeScans`. */
export interface TimelineScan extends Omit<ScanState, "tasks"> {
  sightings: TaskSighting[];
  /** The scan began at the session's first message. */
  fromStart: boolean;
}

export function emptyScan(): ScanState {
  return { tasks: emptyLedger(), mergeRequests: [], urls: [], files: {} };
}

// The same user message is read again by every scan whose window still holds it; its key says
// which turn it was without keeping its text.
function userMessageKey(item: TimelineItemLike, text: string): string {
  return createHash("sha256").update(`${item.timestamp ?? ""}\u0000${text}`).digest("hex").slice(0, 16);
}

// Accumulates links in insertion order, newest last, so each list keeps its most recent part.
class ScanBuilder {
  readonly mergeRequests = new Set<string>();
  readonly urls = new Set<string>();
  readonly files = new Map<string, "read" | "edited">();

  noteFile(path: string, use: "read" | "edited") {
    const kept = this.files.get(path) === "edited" ? "edited" : use;
    this.files.delete(path);
    this.files.set(path, kept);
  }

  add(scan: Omit<ScanState, "tasks">) {
    for (const request of scan.mergeRequests) touch(this.mergeRequests, request);
    for (const url of scan.urls ?? []) touch(this.urls, url);
    for (const [path, use] of Object.entries(scan.files ?? {})) this.noteFile(path, use);
  }

  build(): Omit<ScanState, "tasks"> {
    return {
      mergeRequests: newest(this.mergeRequests, SCAN_LIMITS.mergeRequests),
      urls: newest(this.urls, SCAN_LIMITS.urls),
      files: Object.fromEntries(newest(this.files, SCAN_LIMITS.files)),
    };
  }
}

/**
 * Reads one window of the timeline, oldest first. `fromStart` says the window begins at the
 * session's first message, when the first user message in it opened the session.
 */
export function scanTimeline(
  items: readonly TimelineItemLike[],
  rules: TaskDocRules | null,
  { fromStart = false }: { fromStart?: boolean } = {},
): TimelineScan {
  const scan = new ScanBuilder();
  const sightings: TaskSighting[] = [];
  // One matching budget for the whole scan, however many messages it reads.
  const globBudget = { left: SCAN_GLOB_BUDGET };
  const docsIn = (text: string | undefined) => findTaskDocs((text ?? "").slice(0, SCAN_LIMITS.textLength), rules, globBudget);
  const noteTasks = (text: string | undefined, signal: "edit" | "read" | "mention") => {
    const docs = docsIn(text);
    if (docs.length > 0) sightings.push({ signal, docs });
  };
  const noteMergeRequests = (raw: string | undefined) => {
    const text = (raw ?? "").slice(0, SCAN_LIMITS.textLength);
    const mergeRequests = new Set(findChangeRequests(text));
    for (const url of mergeRequests) touch(scan.mergeRequests, url);
    // Strip URLs first so the `!N` inside a link's own text is not counted a second time.
    for (const ref of findMergeRequestRefs(text.replace(/https?:\/\/\S+/g, " "))) touch(scan.mergeRequests, ref);
    // MR URLs keep their own button; every other URL is listed under the generic groups.
    for (const url of findUrls(text)) {
      if (findChangeRequests(url).some((found) => mergeRequests.has(found))) continue;
      touch(scan.urls, url);
    }
  };
  const noteFile = (path: string | undefined, use: "read" | "edited") => {
    if (path) scan.noteFile(path, use);
  };

  // Assistant text can be stored in pieces, which would split a URL across two items.
  const merged: TimelineItemLike[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (item.type === "assistant_message" && previous?.type === "assistant_message") {
      merged[merged.length - 1] = { ...previous, text: ((previous.text ?? "") + (item.text ?? "")).slice(0, SCAN_LIMITS.textLength) };
    } else {
      merged.push(item);
    }
  }

  let first = merged.length;
  for (let total = 0; first > 0; first -= 1) {
    total += Math.min(merged[first - 1].text?.length ?? 0, SCAN_LIMITS.textLength);
    if (total > SCAN_LIMITS.totalText) break;
  }
  for (const item of merged.slice(first)) {
    if (item.type === "user_message") {
      // Every user message counts as a turn, naming a doc or not, so evidence can fade by turns.
      const text = (item.text ?? "").slice(0, SCAN_LIMITS.textLength);
      sightings.push({ signal: "user", key: userMessageKey(item, text), docs: docsIn(text) });
      noteMergeRequests(item.text);
    } else if (item.type === "assistant_message") {
      noteTasks(item.text, "mention");
      noteMergeRequests(item.text);
    } else if (item.type === "tool_call" && item.detail) {
      const { detail } = item;
      if (detail.type === "read") {
        noteTasks(detail.filePath, "read");
        noteFile(detail.filePath, "read");
      }
      if (detail.type === "edit" || detail.type === "write") {
        noteTasks(detail.filePath, "edit");
        noteFile(detail.filePath, "edited");
      }
      // Shell commands and output are skipped: anything they print (fixtures, listings, other
      // sessions' state) would surface as a link. An MR the agent creates gets named in its reply.
    }
  }
  // Messages older than the text budget were left out, so the window no longer starts the session.
  return { ...scan.build(), sightings, fromStart: fromStart && first === 0 };
}

/** Older evidence stays even after it scrolls out of the scanned window; newer comes last. */
export function mergeScans(previous: ScanState, next: TimelineScan): ScanState {
  const scan = new ScanBuilder();
  scan.add(previous);
  scan.add(next);
  return { tasks: recordSightings(previous.tasks, next.sightings, next.fromStart), ...scan.build() };
}

/** `scan` with the current caps applied to its lists, for state written before them. */
export function boundScan(scan: ScanState): ScanState {
  const lists = new ScanBuilder();
  lists.add(scan);
  return { tasks: recordSightings(scan.tasks, [], false), ...lists.build() };
}
