import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { writeMcpLauncher } from "../server/mcp-launcher";

const PLUGIN = join(__dirname, "..");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

/** The name the MCP server behind `script` gives when a client opens it, with Paseo's home at `home`. */
function serverName(script: string, home: string): string {
  const output = execFileSync(process.execPath, [script], {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    env: { ...process.env, PASEO_HOME: home, ELECTRON_RUN_AS_NODE: "1" },
  }).toString();
  return JSON.parse(output.trim().split("\n")[0]).result.serverInfo.name;
}

/** A copy of the plugin in a folder of its own, as a Git install keeps it; returns the folder. */
function install(): string {
  const folder = tempDir();
  cpSync(join(PLUGIN, "bin"), join(folder, "bin"), { recursive: true });
  cpSync(join(PLUGIN, "paseo-plugin.json"), join(folder, "paseo-plugin.json"));
  return folder;
}

/** Paseo's plugin registry naming `folder` as the Trail install. */
function register(home: string, folder: string) {
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { trail: { path: folder, enabled: true } } }));
}

describe("the MCP launcher", () => {
  it("starts the MCP server of the install Paseo lists", () => {
    const home = tempDir();
    const folder = install();
    register(home, folder);
    const launcher = writeMcpLauncher(join(home, "trail"), home, join(folder, "bin", "trail-mcp.mjs"));
    expect(launcher).not.toBeNull();
    expect(serverName(launcher as string, home)).toBe("trail");
  });

  it("follows an update that moves the plugin and deletes the old folder, without being written again", () => {
    // Measured on a Git install: Paseo reloads the plugin while the registry still names the old
    // folder, then records the new one and deletes the old, so the launcher is written too early.
    const home = tempDir();
    const before = install();
    register(home, before);
    const launcher = writeMcpLauncher(join(home, "trail"), home, join(before, "bin", "trail-mcp.mjs"));
    const after = install();
    register(home, after);
    rmSync(before, { recursive: true });
    expect(serverName(launcher as string, home)).toBe("trail");
  });

  it("falls back to the script it was written for when the registry names no usable copy", () => {
    const home = tempDir();
    const launcher = writeMcpLauncher(join(home, "trail"), home, join(PLUGIN, "bin", "trail-mcp.mjs"));
    expect(serverName(launcher as string, home)).toBe("trail");
  });
});

type AgentRequest = { config: { provider: string; mcpServers: Record<string, { args: string[] }> } };

describe("a new agent", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    vi.unstubAllEnvs();
  });

  /** The plugin loaded with Paseo's home at `home`; the request it makes of a new `provider` agent. */
  function create(home: string, provider: string): { request: AgentRequest; result: AgentRequest | undefined } {
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { trail: { path: PLUGIN } } }));
    vi.stubEnv("PASEO_HOME", home);
    let handler: ((input: { request: AgentRequest }) => AgentRequest) | undefined;
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "loading" }), subscribe: () => () => undefined }),
      handle: () => undefined,
      on: () => () => undefined,
      before: (name: string, before: typeof handler) => {
        if (name === "agent.create") handler = before;
        return () => undefined;
      },
    };
    dispose = contribute(server as never) as () => void;
    const request = { config: { provider, mcpServers: {} } };
    return { request, result: handler?.({ request }) };
  }

  it("is given the launcher, not a path inside the plugin's install folder", () => {
    const home = tempDir();
    const args = create(home, "claude").result?.config.mcpServers.trail.args ?? [];
    expect(args).toEqual([join(home, "trail", "bin", "trail-mcp.mjs")]);
    expect(serverName(args[0], home)).toBe("trail");
  });

  it("gets no Trail MCP server unless it runs Claude Code, the only agent Trail is tested with", () => {
    const { request, result } = create(tempDir(), "codex");
    expect(result).toEqual(request);
  });
});
