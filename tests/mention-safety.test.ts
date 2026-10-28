import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleFiles } from "../server/bundle";
import { Credentials, gitLabCredentialId } from "../server/credentials";
import { HostTracker } from "../server/host-tracker";
import { resolveMentions } from "../server/mr-refs";
import { LinkStore } from "../server/store";
import { projectConfigSchema } from "../shared/config";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");
const HOST = "gitlab.example.test";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mentions that only look like requests", () => {
  it("are dropped one by one while the rest of the bar stays", async () => {
    const state = tempDir();
    const valid = `https://${HOST}/team/app/-/merge_requests/7`;
    writeFileSync(
      join(state, "agent-a.scanned.json"),
      JSON.stringify({ tasks: {}, mergeRequests: ["a/../b!1", "team/./x!2", "my.org/repo#1", "-/-#4", valid] }),
    );
    const links = await new LinkStore(state).links("agent-a", { rules: null, catalog: [], defaultHost: HOST });
    expect(links.map((link) => link.url)).toEqual([valid]);
  });

  it("never resolve to a project path a link could not hold", () => {
    expect(resolveMentions(["api!1"], [], [{ name: "api", project: "a b", host: HOST }], HOST)).toEqual([]);
    expect(resolveMentions(["a/../b!1", "team/./x!2"], [], [], HOST)).toEqual([]);
    expect(resolveMentions(["owner/repo#3"], [], [], undefined)).toEqual(["https://github.com/owner/repo/pull/3"]);
  });

  it("are refused in a config's named projects", () => {
    const parses = (projects: Record<string, string>) => projectConfigSchema.safeParse({ gitlab: [{ host: HOST, projects }] }).success;
    expect(parses({ api: "a b" })).toBe(false);
    expect(parses({ api: "a/../b" })).toBe(false);
    expect(parses({ api: "api" })).toBe(false);
    expect(parses({ api: "team/backend/api" })).toBe(true);
  });
});

describe("requests the agent pinned", () => {
  it("stay listed however many other requests the session mentions later", async () => {
    const state = tempDir();
    const mr = (repo: string, n: number) => `https://${HOST}/team/${repo}/-/merge_requests/${n}`;
    const pinned = [mr("api", 1), mr("worker", 2), mr("billing", 3)];
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify(pinned.map((target, i) => ({ target, kind: "mr", at: String(i) }))));
    // Mentioned before the pins (as references) and then six newer web requests.
    const mentions = ["api!1", "worker!2", "billing!3", ...[10, 11, 12, 13, 14, 15].map((n) => mr("web", n))];
    writeFileSync(join(state, "agent-a.scanned.json"), JSON.stringify({ tasks: {}, mergeRequests: mentions }));
    const catalog = ["api", "worker", "billing"].map((name) => ({ name, project: `team/${name}`, host: HOST }));
    const links = await new LinkStore(state).links("agent-a", { rules: null, catalog, defaultHost: HOST });
    const urls = links.filter((link) => link.kind === "mr").map((link) => link.url);
    expect(urls.slice(0, 3)).toEqual(pinned);
    expect(urls.slice(3)).toEqual([11, 12, 13, 14, 15].map((n) => mr("web", n)));
  });
});

describe("token checks that never got a slot", () => {
  it("are tried again after 30 seconds, not ten minutes", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        asked.push(new URL(url).host);
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }),
    );
    const credentials = new Credentials(tempDir());
    const hosts = ["one.example.test", "two.example.test", "three.example.test"];
    for (const host of hosts) {
      credentials.requireGitLab(host, undefined);
      await credentials.store(gitLabCredentialId(host), "glpat-sample");
    }
    // Only timers and the clock: file reads must still run for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Real I/O (reading the saved tokens) comes first; the clock moves only once requests wait.
    const settle = async (count: number) => {
      for (let turn = 0; turn < 1000 && asked.length < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const first = credentials.statuses();
    await settle(2);
    await vi.advanceTimersByTimeAsync(15_001);
    const statuses = await first;
    const queued = statuses.filter((status) => status.detail.values.error === "QueueTimeoutError");
    expect(queued).toHaveLength(1);
    // The third check got a slot just as its time ran out: sent, cut off at once, and counted as
    // a wait rather than as the forge's answer.
    expect(asked).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(31_000);
    const second = credentials.statuses();
    await settle(4);
    await vi.advanceTimersByTimeAsync(15_001);
    await second;
    // Only the check that waited is sent again; the other two keep their result for ten minutes.
    expect(asked).toHaveLength(4);
    expect(asked[3]).toBe(queued[0].host);
  });
});

describe("bundles", () => {
  it("stop opening folders once the entry budget is spent", () => {
    const task = join(tempDir(), "task");
    mkdirSync(task);
    writeFileSync(join(task, "README.md"), "# Task");
    for (let folder = 0; folder < 400; folder += 1) {
      mkdirSync(join(task, `d${folder}`));
      writeFileSync(join(task, `d${folder}`, "note.md"), "");
    }
    const started = performance.now();
    const files = bundleFiles(join(task, "README.md"));
    expect(performance.now() - started).toBeLessThan(30);
    expect(files.length).toBeLessThanOrEqual(20);
  });
});

describe("hosts in both pools", () => {
  it("are held by a pool until that pool lets them go", () => {
    const project = new HostTracker(10, 1000);
    const link = new HostTracker(10, 1000);
    project.see("shared.example.test", 0);
    link.see("shared.example.test", 900);
    expect(project.prune(1500, () => false)).toEqual(["shared.example.test"]);
    // The other pool still holds it, so it must stay declared.
    expect(link.holds("shared.example.test")).toBe(true);
  });
});

describe("the agent's pin file", () => {
  const callTool = (state: string, target: string) => {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pin_link", arguments: { target } } });
    return JSON.parse(
      execFileSync(process.execPath, [MCP_SCRIPT], {
        input: `${request}\n`,
        timeout: 5000,
        env: { ...process.env, TRAIL_STATE_DIR: state, PASEO_AGENT_ID: "agent-a", ELECTRON_RUN_AS_NODE: "1" },
      }).toString(),
    ).result as { isError?: boolean };
  };

  it("is not waited on when it is a FIFO", () => {
    const state = tempDir();
    execFileSync("mkfifo", [join(state, "agent-a.reported.json")]);
    expect(callTool(state, "https://example.test/a").isError).toBeUndefined();
  });

  it("holds fifty long pins in four-byte characters", async () => {
    const state = tempDir();
    const long = (i: number) => `https://example.test/${i}/${"😀".repeat(1000)}`;
    for (let i = 0; i < 50; i += 1) expect(callTool(state, long(i)).isError).toBeUndefined();
    expect(await new LinkStore(state).pins("agent-a")).toHaveLength(50);
  }, 60_000);
});

describe("a state folder that already exists", () => {
  it("is made private when the store starts", async () => {
    const state = tempDir();
    chmodSync(state, 0o755);
    new LinkStore(state);
    await vi.waitFor(() => expect(statSync(state).mode & 0o777).toBe(0o700));
  });
});
