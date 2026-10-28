import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "trail";
/** The stdio MCP server attached to new agents, under the plugin's `bin/`. */
export const MCP_SCRIPT_NAME = "trail-mcp.mjs";

export interface Environment {
  paseoHome: string;
  /** Where this plugin's source sits; null when the daemon config does not list it. */
  pluginDir: string | null;
  /**
   * Everything that belongs to this user rather than to a project, in one folder outside the
   * plugin directory (which may be read-only, for example baked into an image).
   */
  homeDir: string;
  /** Personal config, used when no project config is found. */
  personalConfig: string;
  /** Collected links and per-session choices. */
  stateDir: string;
  /** Tokens pasted in Settings, readable only by the daemon's user. */
  secretsDir: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// The plugin runs from a compiled bundle with cwd `/` and no module URL, and Paseo passes it no
// install id or directory, so the daemon's own plugin registry is the only record of where the
// source lives. Directory, Git and npm installs all record a path there (managed ones point at
// their checkout). The registry key is the install id, which `--id` can change, so entries are
// matched on the manifest id; disabled entries and copies without the MCP script are skipped, and
// when several copies remain, the one installed under the plain id wins.
function findPluginDir(paseoHome: string): string | null {
  const config = readJson(join(paseoHome, "config.json")) as
    | { plugins?: Record<string, { path?: string; enabled?: boolean }> }
    | undefined;
  const candidates = Object.entries(config?.plugins ?? {}).filter(([, entry]) => {
    if (!entry?.path || entry.enabled === false) return false;
    const manifest = readJson(join(entry.path, "paseo-plugin.json")) as { id?: string } | undefined;
    return manifest?.id === PLUGIN_ID && existsSync(join(entry.path, "bin", MCP_SCRIPT_NAME));
  });
  const preferred = candidates.find(([key]) => key === PLUGIN_ID) ?? candidates[0];
  return preferred?.[1].path ?? null;
}

export function detectEnvironment(): Environment {
  const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const homeDir = join(paseoHome, PLUGIN_ID);
  return {
    paseoHome,
    pluginDir: findPluginDir(paseoHome),
    homeDir,
    personalConfig: join(homeDir, "config.json"),
    stateDir: join(homeDir, "state"),
    secretsDir: join(homeDir, "secrets"),
  };
}
