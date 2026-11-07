import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `<home>/bin/trail-mcp.mjs` and returns its path; null when it cannot be written.
 *
 * An agent keeps the command of its MCP server from the moment it was created. A Git install of the
 * plugin moves to a new folder on every update and the old folder is deleted, so a session created
 * before an update would start a script that no longer exists and lose its tools. Agents are given
 * this file instead, whose path never changes.
 *
 * It cannot name the install it was written by: Paseo reloads the plugin before it records the new
 * folder, so the plugin would still see, and write, the folder about to be deleted. The launcher
 * looks the install up in Paseo's plugin registry each time it starts, the way the plugin itself
 * does, and falls back to `mcpScript` when the registry names no usable copy.
 */
export function writeMcpLauncher(home: string, paseoHome: string, mcpScript: string): string | null {
  const folder = join(home, "bin");
  const launcher = join(folder, "trail-mcp.mjs");
  try {
    mkdirSync(folder, { recursive: true });
    // Written beside the target and renamed, so an agent starting meanwhile never reads half a file.
    const temporary = `${launcher}.${process.pid}.tmp`;
    writeFileSync(temporary, launcherSource(paseoHome, mcpScript));
    renameSync(temporary, launcher);
    return launcher;
  } catch (error) {
    console.error("trail: could not write the MCP launcher", error);
    return null;
  }
}

function launcherSource(paseoHome: string, mcpScript: string): string {
  return `// Written by the Trail plugin. Starts the MCP server of the Trail install Paseo lists when this
// runs, so a session outlives an update that moves the plugin to a new folder.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.PASEO_HOME || ${JSON.stringify(paseoHome)};
const fallback = ${JSON.stringify(mcpScript)};
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
// Enabled copies of the plugin whose MCP script exists; the one under the plain id wins.
const copies = Object.entries(read(join(home, "config.json"))?.plugins ?? {}).filter(
  ([, entry]) =>
    typeof entry?.path === "string" &&
    entry.enabled !== false &&
    read(join(entry.path, "paseo-plugin.json"))?.id === "trail" &&
    existsSync(join(entry.path, "bin", "trail-mcp.mjs")),
);
const folder = (copies.find(([id]) => id === "trail") ?? copies[0])?.[1].path;
await import(pathToFileURL(folder ? join(folder, "bin", "trail-mcp.mjs") : fallback).href);
`;
}
