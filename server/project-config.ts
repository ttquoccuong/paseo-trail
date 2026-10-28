import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isInside, isReallyInsideSync, readTextFileSync } from "./files";
import { PROJECT_CONFIG_PATH, projectConfigSchema, type ProjectConfig } from "../shared/config";

export interface LoadedConfig {
  /** Absolute path of the config file. */
  file: string;
  /**
   * Relative paths in the file resolve against this: the directory holding `.paseo` for a
   * project file, the agent's working directory for the personal file.
   */
  projectRoot: string;
  /** The user's own file. Only it may name token files, and it may point anywhere on disk. */
  personal: boolean;
  config: ProjectConfig;
}

export interface ConfigProblem {
  file: string;
  error: string;
}

// Doc paths are matched without regular expressions: globs come from project files, and a glob
// turned into a pattern can backtrack for minutes on a long path-like string in the chat.
const PATH_TOKEN = /[\w.\-/]+/g;
const MAX_SEGMENTS = 32;
const MAX_SEGMENT_LENGTH = 255;

/**
 * How much matching work one search may do, counted in characters compared. Globs with `?` can
 * still take time quadratic in a segment's length, so a search stops when its budget runs out and
 * keeps what it found; a scan shares one budget across all of its messages.
 */
export interface GlobBudget {
  left: number;
}

export const SCAN_GLOB_BUDGET = 4_000_000;
export const POLL_GLOB_BUDGET = 200_000;
const CALL_GLOB_BUDGET = 1_000_000;

class BudgetSpent extends Error {}

let budget: GlobBudget = { left: Infinity };

function spend(work: number): void {
  budget.left -= work;
  if (budget.left < 0) throw new BudgetSpent();
}

/** Whether one path segment matches one glob segment, where `*` is any run and `?` one character. */
function segmentMatches(pattern: string, segment: string): boolean {
  spend(pattern.length + segment.length);
  return pattern.includes("?") ? wildcardMatches(pattern, segment) : starMatches(pattern, segment);
}

// Without `?`, the literal pieces between stars are anchored at both ends and found left to right
// in the middle, which is linear in the segment for any number of stars.
function starMatches(pattern: string, segment: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === segment;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (segment.length < first.length + last.length || !segment.startsWith(first) || !segment.endsWith(last)) return false;
  let at = first.length;
  const end = segment.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = segment.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

function wildcardMatches(pattern: string, segment: string): boolean {
  // Greedy matching with a single remembered `*`: linear in practice, quadratic at worst.
  let p = 0;
  let s = 0;
  let star = -1;
  let starAt = 0;
  while (s < segment.length) {
    spend(1);
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === segment[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      starAt = s;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      starAt += 1;
      s = starAt;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * For every start position j, whether `path.slice(j)` matches the whole glob, computed in one
 * pass over both (`**` spans zero or more segments).
 */
function suffixMatches(glob: string[], path: string[]): boolean[] {
  let next = new Array<boolean>(path.length + 1).fill(false);
  next[path.length] = true;
  for (let i = glob.length - 1; i >= 0; i -= 1) {
    const current = new Array<boolean>(path.length + 1).fill(false);
    for (let j = path.length; j >= 0; j -= 1) {
      // Every cell costs, `**` ones included, so no glob shape escapes the budget.
      spend(1);
      current[j] =
        glob[i] === "**"
          ? next[j] || (j < path.length && current[j + 1])
          : j < path.length && next[j + 1] && segmentMatches(glob[i], path[j]);
    }
    next = current;
  }
  return next;
}

/** Whether a whole relative path, split into segments, matches a glob split the same way. */
export function globMatches(glob: string[], path: string[]): boolean {
  return suffixMatches(glob, path)[0];
}

function isPlainSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && segment.length <= MAX_SEGMENT_LENGTH;
}

/** The earliest start from which `segments` matches `glob` to its end, or -1. */
function earliestMatch(glob: string[], segments: string[], firstAllowed: number): number {
  const last = glob[glob.length - 1];
  // Most path-like words fail on their last segment, so that is checked before anything else.
  if (last !== "**" && !segmentMatches(last, segments[segments.length - 1])) return -1;
  if (!glob.includes("**")) {
    const start = segments.length - glob.length;
    if (start < firstAllowed) return -1;
    return glob.every((pattern, index) => segmentMatches(pattern, segments[start + index])) ? start : -1;
  }
  const matches = suffixMatches(glob, segments);
  for (let start = firstAllowed; start < segments.length; start += 1) if (matches[start]) return start;
  return -1;
}

/**
 * Paths in free text that match one of the globs. A path counts only as a whole: a match must end
 * where the path-like run of characters ends and start at a `/` inside it, so `tasks/a.md.bak`
 * and `oldtasks/a.md` do not match `tasks/*.md`, while `/home/me/repo/tasks/a.md` does.
 */
export function findGlobPaths(text: string, globs: string[][], workBudget: GlobBudget = { left: CALL_GLOB_BUDGET }): string[] {
  if (globs.length === 0) return [];
  const found: string[] = [];
  const previous = budget;
  budget = workBudget;
  try {
    collectGlobPaths(text, globs, found);
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
  } finally {
    budget = previous;
  }
  return found;
}

function collectGlobPaths(text: string, globs: string[][], found: string[]): void {
  for (const [token] of text.matchAll(PATH_TOKEN)) {
    // A sentence may end right after a path; only the last segments can belong to a doc path.
    const segments = trimEnd(token, ".").split("/").slice(-MAX_SEGMENTS);
    // A match may not include an empty, `.` or `..` segment, so it starts after the last one.
    let firstAllowed = 0;
    segments.forEach((segment, index) => {
      if (!isPlainSegment(segment)) firstAllowed = index + 1;
    });
    if (firstAllowed >= segments.length) continue;
    let best = -1;
    for (const glob of globs) {
      const start = earliestMatch(glob, segments, firstAllowed);
      if (start >= 0 && (best < 0 || start < best)) best = start;
    }
    if (best >= 0) found.push(segments.slice(best).join("/"));
  }
}

/** `text` without any of `chars` at its end; a loop, since `/[…]+$/` is quadratic on long runs. */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

export function splitGlob(glob: string): string[] {
  return glob.split("/").filter((segment) => segment !== "");
}

/** `~/` is the daemon user's home; other relative paths resolve against the config's root. */
export function resolveIn(projectRoot: string, path: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export { isInside };

const MAX_CONFIG_BYTES = 256 * 1024;
const PROJECT_MARKER = join(...PROJECT_CONFIG_PATH.split("/"));

/**
 * A project file is shared with everyone who clones the project, so it may only describe the
 * project: paths stay inside the project, and nothing in it decides which local file a token is
 * read from. Returns the problem, or null when the file is acceptable.
 */
function projectFileProblem(config: ProjectConfig, projectRoot: string): string | null {
  const paths = [
    ...(config.focus ? [["focus.root", config.focus.root]] : []),
    ...config.gitlab.flatMap((entry, index) =>
      entry.projectCatalog ? [[`gitlab[${index}].projectCatalog.file`, entry.projectCatalog.file]] : [],
    ),
  ];
  for (const [field, value] of paths) {
    const resolved = resolveIn(projectRoot, value);
    // Through symlinks too: a `docs` link to `/` is as far outside as `../..`.
    const inside = existsSync(resolved) ? isReallyInsideSync(projectRoot, resolved) : isInside(projectRoot, resolved);
    if (value.startsWith("~") || !inside) {
      return `${field} must stay inside the project (${value})`;
    }
  }
  if (config.focus?.taskId) {
    return "focus.taskId is only read from the personal config, because its pattern runs on every branch name and title";
  }
  const tokenField = config.gitlab.findIndex((entry) => entry.tokenFiles.length > 0 || entry.tokenKey !== "GITLAB_TOKEN");
  if (tokenField >= 0) {
    return `gitlab[${tokenField}].tokenFiles and tokenKey are only read from the personal config`;
  }
  return null;
}

/**
 * Finds and parses the nearest project config above a directory, falling back to a personal file
 * for setups where the project tree is shared and should not carry it. Files are re-read when
 * their modification time changes, so edits apply without reloading the plugin.
 */
export class ProjectConfigs {
  constructor(private readonly personalFile: string) {}

  private readonly cache = new Map<string, { mtimeMs: number; loaded: LoadedConfig | null }>();
  private readonly problems = new Map<string, ConfigProblem>();

  private load(file: string): LoadedConfig | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(file);
      this.problems.delete(file);
      return null;
    }
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.loaded;
    let loaded: LoadedConfig | null = null;
    try {
      const personal = file === this.personalFile;
      // A project file sits at <root>/.paseo/trail/config.json; the personal file's relative
      // paths resolve against its own folder, or the agent's working directory when used for focus.
      const projectRoot = !personal && file.endsWith(`${sep}${PROJECT_MARKER}`)
        ? file.slice(0, -PROJECT_MARKER.length - 1)
        : dirname(file);
      const parsed = projectConfigSchema.safeParse(this.readJson(file, personal ? null : projectRoot));
      const problem = !parsed.success
        ? parsed.error.message
        : personal
          ? null
          : projectFileProblem(parsed.data, projectRoot);
      if (parsed.success && !problem) {
        loaded = { file, projectRoot, personal, config: parsed.data };
        this.problems.delete(file);
      } else {
        this.problems.set(file, { file, error: problem ?? "invalid" });
      }
    } catch (error) {
      this.problems.set(file, { file, error: error instanceof Error ? error.message : "unreadable" });
    }
    this.cache.set(file, { mtimeMs, loaded });
    return loaded;
  }

  // A project's config may be a symlink to anything, so it must resolve inside the project, be a
  // regular file and stay small. Parse errors are reported without their text, which quotes input.
  private readJson(file: string, projectRoot: string | null): unknown {
    if (projectRoot !== null && !isReallyInsideSync(projectRoot, file)) {
      throw new Error("the file resolves outside the project");
    }
    const read = readTextFileSync(file, MAX_CONFIG_BYTES);
    if (!read) throw new Error("the file cannot be read");
    if (read.kind === "notFile") throw new Error("not a regular file");
    if (read.kind === "tooLarge") throw new Error(`larger than ${MAX_CONFIG_BYTES / 1024} KB`);
    try {
      return JSON.parse(read.text);
    } catch {
      throw new Error("not valid JSON");
    }
  }

  /** The user's own config, which alone may say where tokens are read from. */
  personal(): LoadedConfig | null {
    return this.load(this.personalFile);
  }

  /**
   * The nearest project config at or above `cwd`, else the personal file. A project file that is
   * refused stops the search (a file further up is not this project's) and is reported in Settings,
   * and the personal file applies instead, as if the project had none.
   */
  forDirectory(cwd: string | null): LoadedConfig | null {
    for (let dir = cwd; dir && dir !== dirname(dir); dir = dirname(dir)) {
      const file = join(dir, PROJECT_MARKER);
      // `$PASEO_HOME` may sit above the working directory and hold the personal file at this very
      // path; that file is never a project's, and is used below with the right root.
      if (file === this.personalFile) continue;
      const loaded = this.load(file);
      if (loaded) return loaded;
      if (this.problems.has(file)) break;
    }
    const personal = this.personal();
    return personal && cwd ? { ...personal, projectRoot: cwd } : personal;
  }

  /** Every config read so far, valid or not, for the status screen. */
  known(): { loaded: LoadedConfig[]; problems: ConfigProblem[] } {
    return {
      loaded: [...this.cache.values()].flatMap(({ loaded }) => (loaded ? [loaded] : [])),
      problems: [...this.problems.values()],
    };
  }
}
