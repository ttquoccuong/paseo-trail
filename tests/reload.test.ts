import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";

const AGENT = "agent-a";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

type Handler = (input: unknown, context: { paseo: unknown }) => Promise<unknown>;

/** The plugin as the daemon loads it, with Paseo's side faked; returns its RPC handlers by name. */
function load(paseoHome: string) {
  vi.stubEnv("PASEO_HOME", paseoHome);
  const handlers = new Map<string, Handler>();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { defaultMode: "task", language: "app" } }),
      subscribe: () => () => undefined,
    }),
    handle: (rpc: { name: string }, handler: Handler) => handlers.set(rpc.name, handler),
    on: () => () => undefined,
    before: () => () => undefined,
  };
  const dispose = contribute(server as never) as () => void;
  return { handlers, dispose };
}

/** An agent whose snapshot names `cwd`, and whose timeline never arrives, like a scan still running. */
function paseoWith(cwd: string, refresh = vi.fn(async () => undefined)) {
  return {
    agents: {
      ref: () => {
        let current: { cwd: string; title: string } | null = null;
        return {
          refresh: async () => {
            await refresh();
            current = { cwd, title: "Agent" };
          },
          get cwd() {
            return current?.cwd ?? null;
          },
          current: () => current,
          timeline: { refetch: () => new Promise(() => undefined) },
        };
      },
    },
  };
}

/** A project whose config makes `docs/tasks/*.md` task docs, holding one of them. */
function project(): string {
  const root = tempDir();
  mkdirSync(join(root, ".paseo", "trail"), { recursive: true });
  writeFileSync(join(root, ".paseo", "trail", "config.json"), JSON.stringify({ focus: { root: "docs", taskDocs: ["tasks/*.md"] } }));
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(join(root, "docs", "tasks", "a.md"), "# A\n");
  return root;
}

describe("right after the plugin reloads", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    vi.unstubAllEnvs();
  });

  it("keeps a pinned task doc, by asking the agent for its directory before its first scan", async () => {
    const home = tempDir();
    const state = join(home, "trail", "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `${AGENT}.pins.json`), JSON.stringify([{ target: "tasks/a.md", kind: "task", primary: true, at: "2026-01-01T00:00:00Z" }]));
    const loaded = load(home);
    dispose = loaded.dispose;
    const refresh = vi.fn(async () => undefined);
    const paseo = paseoWith(project(), refresh);
    const list = () => loaded.handlers.get("links.list")!({ agentIds: [AGENT] }, { paseo }) as Promise<{ sessions: Record<string, { links: Array<{ kind: string; title: string }> }> }>;

    const first = await list();
    expect(first.sessions[AGENT].links.find((link) => link.kind === "task")?.title).toBe("tasks/a.md");
    await list();
    // Asked once per run, not on every poll.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still answers when the agent cannot be read", async () => {
    const loaded = load(tempDir());
    dispose = loaded.dispose;
    const paseo = paseoWith(project(), vi.fn(async () => Promise.reject(new Error("gone"))));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = (await loaded.handlers.get("links.list")!({ agentIds: [AGENT] }, { paseo })) as { sessions: Record<string, unknown> };
    expect(result.sessions[AGENT]).toMatchObject({ links: [] });
  });
});
