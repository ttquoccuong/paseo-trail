import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

function inside(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/**
 * How the Files menu names a file: its path from the agent's working directory, as the
 * workspace's file tree shows it; outside that directory, from the home folder as `~/…`, or its
 * full path.
 */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && inside(cwd, path)) return relative(cwd, path);
  const home = homedir();
  if (inside(home, path)) return join("~", relative(home, path));
  return path;
}
