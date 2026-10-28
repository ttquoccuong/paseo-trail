import { findChangeRequests, findTaskDocs, type TaskDocRules } from "./extract";
import { findMergeRequestRefs } from "./mr-refs";
import { SCAN_GLOB_BUDGET, trimEnd } from "./project-config";

export interface ScanState {
  /** Task doc path → strongest evidence that this session works on it; least recently seen first. */
  tasks: Record<string, number>;
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
  tasks: 50,
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

// The user naming a doc or the agent editing it says far more about the session's main
// task than the agent reading it or mentioning it while searching around.
const WEIGHT = { userMessage: 5, edit: 4, read: 1, assistantMessage: 1 } as const;
// Only evidence at this weight or above can make a doc the main task.
export const MAIN_TASK_MIN_WEIGHT = WEIGHT.edit;

export interface TimelineItemLike {
  type: string;
  text?: string;
  detail?: { type?: string; filePath?: string };
}

export function emptyScan(): ScanState {
  return { tasks: {}, mergeRequests: [], urls: [], files: {} };
}

// Accumulates evidence in insertion order, newest last, so each list keeps its most recent part.
class ScanBuilder {
  readonly tasks = new Map<string, number>();
  readonly mergeRequests = new Set<string>();
  readonly urls = new Set<string>();
  readonly files = new Map<string, "read" | "edited">();

  noteTask(doc: string, weight: number) {
    const best = Math.max(this.tasks.get(doc) ?? 0, weight);
    this.tasks.delete(doc);
    this.tasks.set(doc, best);
  }

  noteFile(path: string, use: "read" | "edited") {
    const kept = this.files.get(path) === "edited" ? "edited" : use;
    this.files.delete(path);
    this.files.set(path, kept);
  }

  add(scan: ScanState) {
    for (const [doc, weight] of Object.entries(scan.tasks)) this.noteTask(doc, weight);
    for (const request of scan.mergeRequests) touch(this.mergeRequests, request);
    for (const url of scan.urls ?? []) touch(this.urls, url);
    for (const [path, use] of Object.entries(scan.files ?? {})) this.noteFile(path, use);
  }

  build(): ScanState {
    return {
      tasks: Object.fromEntries(newest(this.tasks, SCAN_LIMITS.tasks)),
      mergeRequests: newest(this.mergeRequests, SCAN_LIMITS.mergeRequests),
      urls: newest(this.urls, SCAN_LIMITS.urls),
      files: Object.fromEntries(newest(this.files, SCAN_LIMITS.files)),
    };
  }
}

export function scanTimeline(items: readonly TimelineItemLike[], rules: TaskDocRules | null): ScanState {
  const scan = new ScanBuilder();
  // One matching budget for the whole scan, however many messages it reads.
  const globBudget = { left: SCAN_GLOB_BUDGET };
  const noteTasks = (text: string | undefined, weight: number) => {
    for (const doc of findTaskDocs((text ?? "").slice(0, SCAN_LIMITS.textLength), rules, globBudget)) scan.noteTask(doc, weight);
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
      noteTasks(item.text, WEIGHT.userMessage);
      noteMergeRequests(item.text);
    } else if (item.type === "assistant_message") {
      noteTasks(item.text, WEIGHT.assistantMessage);
      noteMergeRequests(item.text);
    } else if (item.type === "tool_call" && item.detail) {
      const { detail } = item;
      if (detail.type === "read") {
        noteTasks(detail.filePath, WEIGHT.read);
        noteFile(detail.filePath, "read");
      }
      if (detail.type === "edit" || detail.type === "write") {
        noteTasks(detail.filePath, WEIGHT.edit);
        noteFile(detail.filePath, "edited");
      }
      // Shell commands and output are skipped: anything they print (fixtures, listings, other
      // sessions' state) would surface as a link. An MR the agent creates gets named in its reply.
    }
  }
  return scan.build();
}

/** Older evidence stays even after it scrolls out of the scanned window; newer comes last. */
export function mergeScans(previous: ScanState, next: ScanState): ScanState {
  const scan = new ScanBuilder();
  scan.add(previous);
  scan.add(next);
  return scan.build();
}

export function mainScannedTask(scan: ScanState): string | undefined {
  let best: string | undefined;
  for (const [doc, weight] of Object.entries(scan.tasks)) {
    if (weight < MAIN_TASK_MIN_WEIGHT) continue;
    if (best === undefined || weight > scan.tasks[best]) best = doc;
  }
  return best;
}
