// About as many characters as a menu row shows before it cuts the rest off.
const MAX_TITLE_LENGTH = 48;

/**
 * `path` cut in the middle when too long for a menu row, which would otherwise cut its end, where
 * the file name is: the first folder, `…`, then as many of the last segments as fit.
 */
export function fitPath(path: string, max = MAX_TITLE_LENGTH): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  // `a/name` has no middle to leave out; a leading `/` makes the first part empty.
  if (parts.length > 2) {
    const head = `${parts[0]}/…/`;
    let tail = name;
    for (let index = parts.length - 2; index >= 1; index -= 1) {
      const longer = `${parts[index]}/${tail}`;
      if (head.length + longer.length > max) break;
      tail = longer;
    }
    if (head.length + tail.length <= max) return head + tail;
  }
  return `…${path.slice(-(max - 1))}`;
}

/** A page as host and path, without the scheme, query or fragment; the raw text when it is no URL. */
export function pageText(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname}${pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
