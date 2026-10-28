import { statSync } from "node:fs";
import { GITHUB_OWNER, isProjectPath } from "../shared/config";
import { findChangeRequests, parseMergeRequestUrl } from "./extract";
import { isReallyInsideSync, readTextFileSync, setBounded } from "./files";

/**
 * Agents often name an MR as `billing !110` or `group/project!110` instead of pasting its URL.
 * These references are kept as written and turned into URLs only when the project is certain.
 */

// `group/project!N`: GitLab's own cross-project reference. The path is taken whole inside a
// lookahead and matched again by reference, which the engine cannot backtrack into: a long
// path-like run with no `!` after it then fails once, instead of once per way to split it.
const FULL_REF = /(?<![\w./-])(?=([\w.-]+(?:\/[\w.-]+)+))\1!(\d+)\b/g;
// `name !N`, with the name optionally in backticks: how people write it in prose and tables.
const SHORT_REF = /(?<![\w./-])`?([A-Za-z][\w.-]*)`?[ \t]*!(\d+)\b/g;
// `owner/repo#N`: GitHub's cross-repository reference. A bare `#N` names no repository. GitHub
// owners are letters, digits and hyphens, never dots, which keeps `docs/README.md#12` (a heading
// link) from reading as one; a "repo" ending like a document file is not taken either.
const GITHUB_REF = new RegExp(`(?<![\\w./-])(${GITHUB_OWNER}\\/[\\w.-]+)#(\\d+)\\b`, "g");
const GITHUB_MENTION = new RegExp(`^(${GITHUB_OWNER}\\/[\\w.-]+)#(\\d+)$`);
const FILE_LIKE = /\.(md|mdx|markdown|txt|rst|adoc|json|ya?ml|toml|lock|html?|csv|log)$/i;

export function findMergeRequestRefs(text: string): string[] {
  const refs = new Set<string>();
  // Most text has neither marker; then no pattern needs to run over it at all.
  const hasBang = text.includes("!");
  const hasHash = text.includes("#");
  if (!hasBang && !hasHash) return [];
  if (hasBang) {
    for (const [, project, iid] of text.matchAll(FULL_REF)) refs.add(`${project}!${iid}`);
    for (const [, name, iid] of text.matchAll(SHORT_REF)) refs.add(`${name}!${iid}`);
  }
  if (hasHash) {
    for (const [, repository, number] of text.matchAll(GITHUB_REF)) {
      if (!FILE_LIKE.test(repository)) refs.add(`${repository}#${number}`);
    }
  }
  return [...refs];
}

export interface ProjectCandidate {
  host: string;
  project: string;
}

export interface CatalogSpec {
  host: string;
  /** Absolute path of a JSON file listing projects. */
  file: string;
  /** For a catalog named by a project file: the project it must resolve inside. */
  root?: string;
  items: string;
  name: string;
  project: string;
}

function dig(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);
}

// Catalogs are small; anything larger is not one and is not read. Each poll resolves references
// against every entry, so only this many are kept.
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_ENTRIES = 2000;

const catalogCache = new Map<string, { mtimeMs: number; entries: Array<ProjectCandidate & { name: string }> }>();

/**
 * Reads a project catalog; re-read only when the file changes, so a file that cannot be used is
 * not retried on every poll. Empty when it is missing, too large, not a regular file or, for a
 * project's catalog, resolves outside the project.
 */
export function readCatalog(spec: CatalogSpec): Array<ProjectCandidate & { name: string }> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(spec.file).mtimeMs;
  } catch {
    return [];
  }
  const key = JSON.stringify(spec);
  const cached = catalogCache.get(key);
  if (cached?.mtimeMs === mtimeMs) return cached.entries;
  let entries: Array<ProjectCandidate & { name: string }> = [];
  const read = spec.root === undefined || isReallyInsideSync(spec.root, spec.file) ? readTextFileSync(spec.file, MAX_CATALOG_BYTES) : null;
  if (read?.kind === "text") {
    try {
      const items = dig(JSON.parse(read.text), spec.items);
      entries = (Array.isArray(items) ? items.slice(0, MAX_CATALOG_ENTRIES) : []).flatMap((item) => {
        const name = dig(item, spec.name);
        const project = dig(item, spec.project);
        // Entries follow the same project path rules as links; anything else could never resolve.
        return typeof name === "string" && typeof project === "string" && project.includes("/") && isProjectPath(project)
          ? [{ name, project, host: spec.host }]
          : [];
      });
    } catch {
      // Not JSON: no entries until the file changes.
    }
  }
  setBounded(catalogCache, key, { mtimeMs, entries });
  return entries;
}

function parentGroup(project: string): string {
  return project.split("/").slice(0, -1).join("/");
}

// Every lookup goes through these indexes; across all of a config's projects and catalogs at most
// this many distinct candidates are kept.
export const MAX_CATALOG_CANDIDATES = 5000;

const lastSegment = (project: string) => project.slice(project.lastIndexOf("/") + 1);

interface CandidateIndex<T extends ProjectCandidate> {
  /** By the name a config declares for it (`projects` key, catalog `name`), each project once. */
  byAlias: Map<string, T[]>;
  /** By full path and by last segment, each candidate (host + project) listed once per name. */
  byName: Map<string, T[]>;
  /** Project paths by their last segment. */
  bySegment: Map<string, Set<string>>;
}

function addOnce<T extends ProjectCandidate>(map: Map<string, T[]>, listed: Set<string>, name: string, candidate: T): void {
  const key = `${name}\u0000${candidate.host}\u0000${candidate.project}`;
  if (listed.has(key)) return;
  listed.add(key);
  const list = map.get(name);
  if (list) list.push(candidate);
  else map.set(name, [candidate]);
}

function indexCandidates<T extends ProjectCandidate & { name?: string }>(candidates: readonly T[]): CandidateIndex<T> {
  const byAlias = new Map<string, T[]>();
  const byName = new Map<string, T[]>();
  const bySegment = new Map<string, Set<string>>();
  const aliased = new Set<string>();
  const listed = new Set<string>();
  for (const candidate of candidates) {
    const segment = lastSegment(candidate.project);
    if (candidate.name) addOnce(byAlias, aliased, candidate.name, candidate);
    for (const name of new Set([candidate.project, segment])) addOnce(byName, listed, name, candidate);
    const projects = bySegment.get(segment);
    if (projects) projects.add(candidate.project);
    else bySegment.set(segment, new Set([candidate.project]));
  }
  return { byAlias, byName, bySegment };
}

// A config's catalog is the same array from poll to poll while nothing changes (see
// `catalogFor`), so its index is built once and kept with it.
const catalogIndexes = new WeakMap<object, CandidateIndex<ProjectCandidate & { name: string }>>();

function indexCatalog(catalog: Array<ProjectCandidate & { name: string }>): CandidateIndex<ProjectCandidate & { name: string }> {
  let index = catalogIndexes.get(catalog);
  if (!index) {
    index = indexCandidates(catalog);
    catalogIndexes.set(catalog, index);
  }
  return index;
}

/**
 * One catalog from a config's named projects and catalog files: duplicates (same name, host and
 * project) dropped, and at most `MAX_CATALOG_CANDIDATES` kept, however many entries list them.
 */
export function mergeCatalogs(parts: Array<Array<ProjectCandidate & { name: string }>>): Array<ProjectCandidate & { name: string }> {
  const seen = new Set<string>();
  const merged: Array<ProjectCandidate & { name: string }> = [];
  for (const part of parts) {
    for (const candidate of part) {
      if (merged.length >= MAX_CATALOG_CANDIDATES) return merged;
      const key = `${candidate.name}\u0000${candidate.host}\u0000${candidate.project}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged;
}

/**
 * Resolves references against, in order: projects whose MR URLs the session already has, then a
 * catalog entry whose name is unique, then the catalog entry in the group most of the session's
 * MRs come from. Anything still ambiguous is dropped rather than guessed. `mentions` may mix MR
 * URLs and references; the result keeps their order, URLs as they are.
 */
export function resolveMentions(
  mentions: string[],
  knownUrls: string[],
  catalog: Array<ProjectCandidate & { name: string }>,
  defaultHost: string | undefined,
): string[] {
  // Every session is polled every few seconds with mostly the same mentions; the answer only
  // changes with them, the known URLs, the default host or the catalog (a new array when it changes).
  let results = resolvedByCatalog.get(catalog);
  if (!results) {
    results = new Map();
    resolvedByCatalog.set(catalog, results);
  }
  const key = JSON.stringify([mentions, knownUrls, defaultHost ?? null]);
  const cached = results.get(key);
  if (cached) return cached;
  const resolved = resolveMentionsNow(mentions, knownUrls, catalog, defaultHost);
  setBounded(results, key, resolved);
  return resolved;
}

const resolvedByCatalog = new WeakMap<object, Map<string, string[]>>();

function resolveMentionsNow(
  mentions: string[],
  knownUrls: string[],
  catalog: Array<ProjectCandidate & { name: string }>,
  defaultHost: string | undefined,
): string[] {
  const isUrl = (mention: string) => /^https?:\/\//.test(mention);
  const seen = [...knownUrls, ...mentions.filter(isUrl)].flatMap((url) => {
    const parsed = parseMergeRequestUrl(url);
    return parsed ? [{ host: parsed.host, project: parsed.project }] : [];
  });
  const groupCounts = new Map<string, number>();
  for (const { project } of seen) groupCounts.set(parentGroup(project), (groupCounts.get(parentGroup(project)) ?? 0) + 1);

  const seenIndex = indexCandidates(seen);
  const catalogIndex = indexCatalog(catalog);
  const seenByName = seenIndex.byName;
  const catalogByName = catalogIndex.byName;
  const projectsWithSegment = (segment: string) => [
    ...(seenIndex.bySegment.get(segment) ?? []),
    ...(catalogIndex.bySegment.get(segment) ?? []),
  ];

  // Several projects share a declared name: only the session's own links, or the group most of
  // its requests come from, may single one out; nothing outside that set is considered.
  const pickAmong = (candidates: ProjectCandidate[]): ProjectCandidate | null => {
    const known = new Set(seen.map((c) => `${c.host}/${c.project}`));
    const fromSession = candidates.filter((c) => known.has(`${c.host}/${c.project}`));
    if (fromSession.length === 1) return fromSession[0];
    const ranked = candidates
      .map((candidate) => ({ candidate, score: groupCounts.get(parentGroup(candidate.project)) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    return ranked.length > 1 && ranked[0].score > ranked[1].score ? ranked[0].candidate : null;
  };

  const resolveProject = (name: string): ProjectCandidate | null => {
    // A name the config declares for a project says what it means. Declared for one project, it
    // wins; declared for several, the reference is ambiguous and is dropped rather than matched
    // some other way.
    const declared = catalogIndex.byAlias.get(name) ?? [];
    if (declared.length === 1) return declared[0];
    if (declared.length > 1) return pickAmong(declared);
    const fromSession = [...new Map((seenByName.get(name) ?? []).map((c) => [`${c.host}/${c.project}`, c])).values()];
    if (fromSession.length === 1) return fromSession[0];
    const fromCatalog = catalogByName.get(name) ?? [];
    if (fromCatalog.length === 1) return fromCatalog[0];
    const ranked = fromCatalog
      .map((candidate) => ({ candidate, score: groupCounts.get(parentGroup(candidate.project)) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 1 && ranked[0].score > ranked[1].score) return ranked[0].candidate;
    // A full path names the project exactly and only lacks the host, unless a known project has
    // the same name under another path: then the reference is a mistyped path, not a new project.
    const knownElsewhere = projectsWithSegment(lastSegment(name)).some((project) => project !== name);
    if (name.includes("/") && defaultHost && !knownElsewhere) return { host: defaultHost, project: name };
    return null;
  };

  // Whatever is built here must read back through the same parser the rest of Trail uses; a
  // reference that only looks like one (`a/../b!1`, a project path with a space) is dropped here
  // rather than failing later when the link is made.
  const checked = (url: string) => (findChangeRequests(url)[0] === url ? [url] : []);
  return mentions.flatMap((mention) => {
    // Kept in canonical form; a stored URL the current parser rejects is dropped.
    if (isUrl(mention)) return findChangeRequests(mention).slice(0, 1);
    // A GitHub reference already names its repository; github.com is the only host it can mean.
    const github = GITHUB_MENTION.exec(mention);
    if (github) return checked(`https://github.com/${github[1]}/pull/${github[2]}`);
    const at = mention.lastIndexOf("!");
    if (at <= 0) return [];
    const target = resolveProject(mention.slice(0, at));
    return target ? checked(`https://${target.host}/${target.project}/-/merge_requests/${mention.slice(at + 1)}`) : [];
  });
}

/** References alone, resolved as `resolveMentions` does. */
export function resolveMergeRequestRefs(
  refs: string[],
  knownUrls: string[],
  catalog: Array<ProjectCandidate & { name: string }>,
  defaultHost: string | undefined,
): string[] {
  return resolveMentions(refs, knownUrls, catalog, defaultHost);
}
