import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostOf } from "../client/urls";
import { Credentials, fetchWithToken, gitLabCredentialId, readBody } from "../server/credentials";
import { findChangeRequests, taskDocRules } from "../server/extract";
import { findGlobPaths, splitGlob } from "../server/project-config";
import { findUrls, mergeScans, SCAN_LIMITS, scanTimeline, type TimelineItemLike } from "../server/scan";
import { LinkStore } from "../server/store";
import { projectConfigSchema } from "../shared/config";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");
const context = { rules: null, catalog: [], defaultHost: undefined };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

const message = (text: string): TimelineItemLike => ({ type: "assistant_message", text });

describe("links no client can parse", () => {
  it("drops MR links whose host a URL cannot hold, and writes hosts one way", () => {
    for (const host of ["h:99999", "256.0.0.1", "1.2.3.4.5"]) {
      expect(findChangeRequests(`https://${host}/a/b/-/merge_requests/1`)).toEqual([]);
    }
    expect(findChangeRequests("https://gitlab.com:443/a/b/-/merge_requests/1")).toEqual([
      "https://gitlab.com/a/b/-/merge_requests/1",
    ]);
    expect(findUrls("see https://h:99999/x and https://ok.example/y")).toEqual(["https://ok.example/y"]);
  });

  it("drops a stored link of that kind instead of failing the session", async () => {
    const state = tempDir();
    writeFileSync(
      join(state, "agent-a.scanned.json"),
      JSON.stringify({ tasks: {}, mergeRequests: ["https://h:99999/a/b/-/merge_requests/1", "https://gitlab.example.test/a/b/-/merge_requests/2"] }),
    );
    const links = await new LinkStore(state).links("agent-a", context);
    expect(links.map((link) => link.url)).toEqual(["https://gitlab.example.test/a/b/-/merge_requests/2"]);
  });

  it("refuses link templates that are not http(s) URLs", () => {
    const parses = (focus: object) => projectConfigSchema.safeParse({ focus }).success;
    expect(parses({ remoteUrl: "http//x/{path}" })).toBe(false);
    expect(parses({ remoteUrl: "javascript:alert(1)//{path}" })).toBe(false);
    expect(parses({ remoteUrl: "https://forge.example/docs/{path}" })).toBe(true);
    expect(parses({ taskId: { pattern: "x", url: "not a url {id}" } })).toBe(false);
  });

  it("gives the client an empty host rather than an exception", () => {
    expect(hostOf("https://h:99999/x")).toBe("");
    expect(hostOf("https://GitLab.Example.test/x")).toBe("gitlab.example.test");
  });
});

describe("scan state stays small and fast", () => {
  it("scans one huge message quickly and keeps only the newest entries", () => {
    const text = Array.from({ length: 60_000 }, (_, i) => `https://u${i}.example/`).join(" ");
    const { value, ms } = timed(() => scanTimeline([message(text)], null));
    expect(ms).toBeLessThan(500);
    expect(value.urls?.length).toBeLessThanOrEqual(SCAN_LIMITS.urls);
  }, 10_000);

  it("merges large states in bounded time and size", () => {
    const big = {
      tasks: {},
      mergeRequests: Array.from({ length: 8000 }, (_, i) => (i % 2 ? `grp/p${i}!${i}` : `https://gitlab.example.test/g/p${i}/-/merge_requests/${i}`)),
      urls: Array.from({ length: 60_000 }, (_, i) => `https://u${i}.example`),
      files: {},
    };
    const { value, ms } = timed(() => mergeScans(big, big));
    expect(ms).toBeLessThan(500);
    expect(value.mergeRequests).toHaveLength(SCAN_LIMITS.mergeRequests);
    expect(value.urls).toHaveLength(SCAN_LIMITS.urls);
  }, 10_000);

  it("lists links for a session whose stored state is huge in bounded time", async () => {
    const state = tempDir();
    writeFileSync(
      join(state, "agent-a.scanned.json"),
      JSON.stringify({
        tasks: {},
        mergeRequests: Array.from({ length: 3000 }, (_, i) => `https://gitlab.example.test/grp/p${i}/-/merge_requests/${i}`),
        mergeRequestRefs: Array.from({ length: 5000 }, (_, i) => `grp/p${i}!${i}`),
      }),
    );
    const catalog = Array.from({ length: 2000 }, (_, i) => ({ name: `p${i}`, project: `grp/p${i}`, host: "gitlab.example.test" }));
    const { ms } = await timedAsync(() => new LinkStore(state).links("agent-a", { rules: null, catalog, defaultHost: "gitlab.example.test" }));
    expect(ms).toBeLessThan(500);
  }, 10_000);

  it("keeps the requests mentioned most recently, not the first ones seen", async () => {
    const mr = (n: number) => `https://gitlab.example.test/a/b/-/merge_requests/${n}`;
    // User messages stay separate items; consecutive assistant pieces would be joined into one.
    const scan = scanTimeline([1, 2, 3, 4, 5, 6, 1].map((n): TimelineItemLike => ({ type: "user_message", text: mr(n) })), null);
    const state = tempDir();
    writeFileSync(join(state, "agent-a.scanned.json"), JSON.stringify(scan));
    const links = await new LinkStore(state).links("agent-a", context);
    expect(links.map((link) => link.url)).toEqual([3, 4, 5, 6, 1].map(mr));
  });

  it("tracks at most 20 of the requests a task doc lists", async () => {
    const project = tempDir();
    mkdirSync(join(project, "tasks"));
    const listed = Array.from({ length: 100 }, (_, i) => `- https://gitlab.example.test/a/b/-/merge_requests/${i + 1}`).join("\n");
    writeFileSync(join(project, "tasks", "big.md"), `# Big\n\n${listed}\n`);
    const rules = taskDocRules(
      { file: join(project, ".paseo/trail/config.json"), projectRoot: project, personal: false, config: { focus: { root: ".", taskDocs: ["tasks/*.md"], bundle: "none" }, gitlab: [] } },
      null,
    );
    const state = tempDir();
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify([{ target: "tasks/big.md", kind: "task", primary: true }]));
    const links = await new LinkStore(state).links("agent-a", { rules, catalog: [], defaultHost: undefined });
    expect(links.filter((link) => link.kind === "mr")).toHaveLength(20);
  });
});

describe("globs at their worst", () => {
  it("matches the slowest glob the schema allows against a megabyte quickly", () => {
    const globs = Array(32).fill(splitGlob(`*${"a".repeat(240)}b`));
    const text = `${"a".repeat(250)} `.repeat(4000);
    const { ms } = timed(() => findGlobPaths(text, globs));
    expect(ms).toBeLessThan(300);
  }, 10_000);
});

describe("pins", () => {
  it("never loses a pin made by the agent while the daemon pins, and honours unpinning", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    const callTool = (target: string) => {
      const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pin_link", arguments: { target } } });
      return JSON.parse(
        execFileSync(process.execPath, [MCP_SCRIPT], {
          input: `${request}\n`,
          env: { ...process.env, TRAIL_STATE_DIR: state, PASEO_AGENT_ID: "agent-a", ELECTRON_RUN_AS_NODE: "1" },
        }).toString(),
      ).result as { isError?: boolean };
    };
    callTool("https://example.test/from-agent");
    await store.pin("agent-a", { target: "https://example.test/from-user", kind: "link" }, "https://example.test/from-user");
    expect((await store.pins("agent-a")).map((pin) => pin.target).sort()).toEqual(["https://example.test/from-agent", "https://example.test/from-user"]);

    await store.pin("agent-a", null, "https://example.test/from-agent");
    expect((await store.pins("agent-a")).map((pin) => pin.target)).toEqual(["https://example.test/from-user"]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    callTool("https://example.test/from-agent");
    expect((await store.pins("agent-a")).map((pin) => pin.target)).toContain("https://example.test/from-agent");
  });

  it("refuses an over-long target from the agent and ignores one in a file", async () => {
    const state = tempDir();
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pin_link", arguments: { target: `https://example.test/${"a".repeat(3000)}` } } });
    const output = execFileSync(process.execPath, [MCP_SCRIPT], {
      input: `${request}\n`,
      env: { ...process.env, TRAIL_STATE_DIR: state, PASEO_AGENT_ID: "agent-a", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(JSON.parse(output.toString()).result.isError).toBe(true);
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify([{ target: `https://example.test/${"a".repeat(3000)}` }]));
    expect(await new LinkStore(state).pins("agent-a")).toEqual([]);
  });
});

describe("forge requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs at most four at once", async () => {
    let active = 0;
    let most = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response("{}", { status: 200 });
      }),
    );
    await Promise.all(Array.from({ length: 20 }, () => fetchWithToken("https://gitlab.example.test/api/v4/x", {})));
    expect(most).toBeLessThanOrEqual(4);
  });

  it("gives up on a forge that does not answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      ),
    );
    const pending = fetchWithToken("https://gitlab.example.test/api/v4/x", {});
    const outcome = expect(pending).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(15_001);
    await outcome;
  });

  it("refuses a body larger than the limit", async () => {
    const huge = new Response(new Uint8Array(3 * 1024 * 1024));
    await expect(readBody(huge)).rejects.toThrow(/larger than/);
  });

  it("sends GitLab tokens as a bearer token, and accepts an OAuth token that has no access-token record", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, authorization: new Headers(init.headers).get("authorization") });
        return url.endsWith("/personal_access_tokens/self") ? new Response("{}", { status: 404 }) : new Response('{"id":1}', { status: 200 });
      }),
    );
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "oauth-sample");
    const [status] = await credentials.statuses();
    expect(status.state).toBe("ok");
    expect(seen.map((call) => call.authorization)).toEqual(["Bearer oauth-sample", "Bearer oauth-sample"]);
    expect(seen[1].url).toBe("https://gitlab.example.test/api/v4/user");
  });
});
