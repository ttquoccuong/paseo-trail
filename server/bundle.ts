import { opendirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { setBounded } from "./files";
import { basename, dirname, join, relative } from "node:path";

// Bundles hold hundreds of screenshots and JSON evidence; only the Markdown is worth a menu entry.
const MAX_FILES = 20;
const MAX_DEPTH = 2;
// A bundle is a handful of notes. Listing one reads at most this many directory entries in all,
// across the folder and its subfolders, so a huge folder (or many symlinks to one) costs little.
const MAX_ENTRIES_PER_BUNDLE = 200;
// Each poll lists the bundle of every task link; the listing is reused while the folder's
// modification time is unchanged, and at least re-read this often for changes in subfolders.
const BUNDLE_TTL_MS = 30_000;
// Keyed by the folder's real path, so task folders that link to the same place share one listing.
const bundles = new Map<string, { mtimeMs: number; until: number; files: string[] }>();

/** Entries read one by one while the bundle's budget lasts, so a huge folder is never listed whole. */
function firstEntries(dir: string, budget: { left: number }): Dirent[] {
  const entries: Dirent[] = [];
  let handle;
  try {
    handle = opendirSync(dir);
    for (let entry = budget.left > 0 ? handle.readSync() : null; entry; entry = budget.left > 0 ? handle.readSync() : null) {
      budget.left -= 1;
      entries.push(entry);
    }
  } catch {
    // An unreadable folder lists nothing.
  } finally {
    handle?.closeSync();
  }
  return entries;
}

function markdownFiles(dir: string, depth: number, budget: { left: number }): string[] {
  const entries = firstEntries(dir, budget);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name))
    .sort();
  if (depth >= MAX_DEPTH) return files;
  const nested: string[] = [];
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of folders) {
    // Once the budget is spent no further folder is even opened.
    if (budget.left <= 0) break;
    nested.push(...markdownFiles(join(dir, entry.name), depth + 1, budget));
  }
  return [...files, ...nested];
}

/** Siblings of a `<slug>/README.md` task doc; a flat `<slug>.md` task has no bundle. */
export function bundleFiles(taskDocPath: string): string[] {
  if (basename(taskDocPath) !== "README.md") return [];
  const root = dirname(taskDocPath);
  let realRoot: string;
  let mtimeMs: number;
  try {
    realRoot = realpathSync(root);
    mtimeMs = statSync(realRoot).mtimeMs;
  } catch {
    return [];
  }
  const cached = bundles.get(realRoot);
  if (cached && cached.mtimeMs === mtimeMs && cached.until > Date.now()) return cached.files;
  const files = markdownFiles(realRoot, 1, { left: MAX_ENTRIES_PER_BUNDLE })
    .filter((file) => basename(file) !== "README.md" || dirname(file) !== realRoot)
    .slice(0, MAX_FILES)
    .map((file) => relative(realRoot, file));
  setBounded(bundles, realRoot, { mtimeMs, until: Date.now() + BUNDLE_TTL_MS, files });
  return files;
}
