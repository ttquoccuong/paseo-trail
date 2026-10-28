import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Files named by a project (task docs, catalogs, the config itself) may be symlinks to anything:
 * a device that never ends, a FIFO that never opens, a secret outside the project. Every such read
 * goes through here: regular files only, opened without blocking, and never more than a set number
 * of bytes, whatever the file claims its size is.
 */

export type FileRead =
  | { kind: "text"; text: string; modifiedAt: Date }
  | { kind: "tooLarge"; modifiedAt: Date }
  | { kind: "notFile" };

// O_NONBLOCK keeps opening a FIFO from waiting for a writer; regular files ignore it.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Whether `path` is `root` itself or somewhere below it, by path alone. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Like `isInside`, after resolving symlinks in both; false when either does not exist. */
export async function isReallyInside(root: string, path: string): Promise<boolean> {
  try {
    return isInside(await realpath(root), await realpath(path));
  } catch {
    return false;
  }
}

export function isReallyInsideSync(root: string, path: string): boolean {
  try {
    return isInside(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

/** Reads up to `maxBytes` of a regular file as UTF-8; null when it cannot be opened. */
export async function readTextFile(path: string, maxBytes: number): Promise<FileRead | null> {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "notFile" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { kind: "tooLarge", modifiedAt: info.mtime };
    return { kind: "text", text: buffer.toString("utf8", 0, filled), modifiedAt: info.mtime };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The synchronous form, for small files read while answering a poll. */
export function readTextFileSync(path: string, maxBytes: number): FileRead | null {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: "notFile" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const bytesRead = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { kind: "tooLarge", modifiedAt: info.mtime };
    return { kind: "text", text: buffer.toString("utf8", 0, filled), modifiedAt: info.mtime };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const MAX_CACHE_ENTRIES = 200;

/** Sets a cache entry, dropping the oldest ones past a fixed size so a long run stays small. */
export function setBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as K);
}
