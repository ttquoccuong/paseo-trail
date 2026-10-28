import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { GITHUB_OWNER, isProjectPath } from "../shared/config";
import type { SessionLink } from "../shared/links";
import { findGlobPaths, resolveIn, splitGlob, type GlobBudget, type LoadedConfig } from "./project-config";

const MAX_SLUG_LENGTH = 32;

// Any GitLab instance: the `/-/merge_requests/<iid>` shape is GitLab's, whatever the host.
const MERGE_REQUEST = /https?:\/\/([\w.-]+(?::\d+)?)\/([\w.\-/]+?)\/-\/merge_requests\/(\d+)/g;

export interface TaskDocRules {
  /** Task doc globs, each split into path segments; empty without doc globs. */
  globs: string[][];
  taskId?: { pattern: RegExp; url?: string };
  /** Absolute directory doc paths are relative to. */
  root: string;
  /** For rules from a project file: the project, which no opened doc may resolve outside of. */
  boundary?: string;
  remoteUrl?: string;
  relatedSection?: string;
  bundle: "siblings" | "none";
}

// Branch names and titles are short; a longer source is cut before a configured pattern runs on it.
const MAX_TASK_ID_SOURCE = 256;

/**
 * Task doc rules from the config that applies to the agent. The task ID pattern is a regular
 * expression run on every poll, so it only ever comes from the user's own personal config.
 */
export function taskDocRules(loaded: LoadedConfig | null, personal: LoadedConfig | null = null): TaskDocRules | null {
  const taskId = personal?.config.focus?.taskId;
  let taskIdPattern: RegExp | undefined;
  try {
    taskIdPattern = taskId ? new RegExp(taskId.pattern) : undefined;
  } catch {
    // An invalid expression disables ID matching; the config's other settings still apply.
  }
  const idRule = taskIdPattern ? { pattern: taskIdPattern, url: taskId?.url } : undefined;
  // A project without task docs, or whose file was refused, can still take its task from an ID in
  // the branch or title; with no doc globs the root is never used.
  const focus = loaded?.config.focus;
  if (!loaded || !focus) return idRule ? { globs: [], taskId: idRule, root: loaded?.projectRoot ?? "/", bundle: "none" } : null;
  return {
    globs: focus.taskDocs.map(splitGlob),
    taskId: idRule,
    root: resolveIn(loaded.projectRoot, focus.root),
    ...(loaded.personal ? {} : { boundary: loaded.projectRoot }),
    remoteUrl: focus.remoteUrl,
    relatedSection: focus.relatedSection,
    bundle: focus.bundle,
  };
}

export function findTaskDocs(text: string, rules: TaskDocRules | null, budget?: GlobBudget): string[] {
  return rules ? findGlobPaths(text, rules.globs, budget) : [];
}

/** The first task ID found in the given texts (branch first, then title), with its link. */
export function taskIdLink(sources: Array<string | null | undefined>, rules: TaskDocRules | null): SessionLink | null {
  const taskId = rules?.taskId;
  if (!taskId) return null;
  for (const source of sources) {
    const match = source ? taskId.pattern.exec(source.slice(0, MAX_TASK_ID_SOURCE)) : null;
    if (!match) continue;
    const id = match[1] ?? match[0];
    return {
      url: taskId.url ? taskId.url.replace("{id}", encodeURIComponent(id)) : `task:${id}`,
      kind: "task",
      label: shorten(id),
      title: id,
    };
  }
  return null;
}

/**
 * The host as the URL parser writes it: lowercase, default port dropped. Null for anything a URL
 * cannot hold (`h:99999`, `1.2.3.4.5`), so such text never becomes a link a client would choke on.
 */
export function canonicalHost(host: string): string | null {
  try {
    return new URL(`https://${host}`).host || null;
  } catch {
    return null;
  }
}


export function parseMergeRequestUrl(url: string): { host: string; project: string; iid: string } | null {
  const match = new RegExp(`^${MERGE_REQUEST.source}$`).exec(url);
  const host = match ? canonicalHost(match[1]) : null;
  return match && host && isProjectPath(match[2]) ? { host, project: match[2], iid: match[3] } : null;
}

export function findMergeRequests(text: string): string[] {
  return [...text.matchAll(MERGE_REQUEST)].flatMap(([, rawHost, project, iid]) => {
    const host = canonicalHost(rawHost);
    return host && isProjectPath(project) ? [`https://${host}/${project}/-/merge_requests/${iid}`] : [];
  });
}

function shorten(text: string): string {
  return text.length > MAX_SLUG_LENGTH ? `${text.slice(0, MAX_SLUG_LENGTH - 1)}…` : text;
}

/**
 * A task doc link. Its `url` is the forge page when the config gives one, otherwise the local
 * file, so the link still has a stable identity on a project with no remote.
 */
export function taskLink(docPath: string, rules: TaskDocRules): SessionLink {
  const segments = docPath.split("/");
  const slug = docPath.endsWith("/README.md")
    ? segments[segments.length - 2]
    : segments[segments.length - 1].replace(/\.md$/, "");
  return {
    url: rules.remoteUrl ? rules.remoteUrl.replace("{path}", () => docPath) : pathToFileURL(join(rules.root, docPath)).href,
    kind: "task",
    label: shorten(slug),
    title: docPath,
  };
}

export function mergeRequestLink(url: string): SessionLink {
  const parsed = parseMergeRequestUrl(url);
  if (!parsed) throw new Error(`Not a GitLab MR URL: ${url}`);
  const repo = parsed.project.split("/").pop();
  return { url, kind: "mr", label: `!${parsed.iid} ${repo}`, title: `${parsed.project}!${parsed.iid}` };
}

// Turns whatever the agent reported (a task doc path, an MR URL, any other URL) into a link,
// or null when the target is a local path that no client could open.
export function reportedLink(
  target: string,
  kind: SessionLink["kind"] | undefined,
  label: string | undefined,
  rules: TaskDocRules | null,
  budget?: GlobBudget,
): SessionLink | null {
  // Only a target that looks like a path is matched against the task doc globs; free text,
  // however long, never reaches the matcher.
  const looksLikePath = !/\s/.test(target) && (target.includes("/") || target.endsWith(".md"));
  const docPath = looksLikePath ? findTaskDocs(target, rules, budget)[0] : undefined;
  if (docPath && rules) return { ...taskLink(docPath, rules), ...(label ? { label } : {}) };
  // A task pinned by its tracker ID rather than a doc path.
  const byId = kind === "task" ? taskIdLink([target], rules) : null;
  if (byId) return { ...byId, ...(label ? { label } : {}) };
  const changeRequest = findChangeRequests(target)[0];
  // A merge or pull request always shows its own name, never a pinned label: the bar and the
  // Rebase and Merge confirmations must say which request they act on.
  if (changeRequest) return changeRequestLink(changeRequest);
  if (!/^https?:\/\//.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  // A pinned link is shown and kept without any `user:password@` it was pinned with.
  url.username = "";
  url.password = "";
  return {
    url: url.href,
    // A real MR or PR was matched above; anything else asked to be one is an ordinary link,
    // so the forges are never asked for the status of a page that is not theirs.
    kind: kind === "mr" || !kind ? "link" : kind,
    label: label ?? shorten(url.hostname + url.pathname.replace(/\/$/, "")),
    title: url.href,
  };
}

// Hosts whose pages are documents, designs or tickets rather than tools or code.
const DOC_HOSTS = [
  /(^|\.)figma\.com$/,
  /(^|\.)notion\.(so|site)$/,
  /^(docs|drive|sheets|slides)\.google\.com$/,
  /\.atlassian\.net$/,
  /(^|\.)linear\.app$/,
  /(^|\.)miro\.com$/,
  /(^|\.)loom\.com$/,
];

export function urlLink(url: string): SessionLink {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname.replace(/\/$/, "");
  } catch {
    // Kept as an ordinary link; the label falls back to the raw text.
  }
  return {
    url,
    kind: DOC_HOSTS.some((pattern) => pattern.test(host)) ? "doc" : "link",
    label: shorten(host ? host + path : url),
    title: url,
  };
}

export function fileLink(path: string, edited: boolean): SessionLink {
  return {
    url: pathToFileURL(path).href,
    kind: "file",
    label: shorten(basename(path) || path),
    title: path,
    localPath: path,
    edited,
  };
}

// GitHub pull requests; only github.com, whose URL shape is fixed.
// Owner and repository follow the same rules as everywhere else (see shared/config.ts).
const PULL_REQUEST = new RegExp(`https?:\\/\\/github\\.com\\/(${GITHUB_OWNER})\\/([\\w.-]+)\\/pull\\/(\\d+)`, "g");

export function parsePullRequestUrl(url: string): { owner: string; repo: string; number: string } | null {
  const match = new RegExp(`^${PULL_REQUEST.source}$`).exec(url);
  return match && isProjectPath(`${match[1]}/${match[2]}`) ? { owner: match[1], repo: match[2], number: match[3] } : null;
}

export function findPullRequests(text: string): string[] {
  return [...text.matchAll(PULL_REQUEST)].flatMap(([, owner, repo, number]) =>
    isProjectPath(`${owner}/${repo}`) ? [`https://github.com/${owner}/${repo}/pull/${number}`] : [],
  );
}

/** GitLab MRs and GitHub PRs share one button; both are `kind: "mr"`. */
export function findChangeRequests(text: string): string[] {
  return [...findMergeRequests(text), ...findPullRequests(text)];
}

export function changeRequestLink(url: string): SessionLink {
  const pull = parsePullRequestUrl(url);
  if (pull) return { url, kind: "mr", label: `#${pull.number} ${pull.repo}`, title: `${pull.owner}/${pull.repo}#${pull.number}` };
  return mergeRequestLink(url);
}
