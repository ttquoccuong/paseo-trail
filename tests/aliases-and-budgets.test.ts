import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fenceFor } from "../client/markdown";
import { Credentials, gitLabCredentialId } from "../server/credentials";
import { findChangeRequests, taskDocRules } from "../server/extract";
import { requireShownOptions } from "../server/forges";
import { GitLab } from "../server/gitlab";
import { HostTracker } from "../server/host-tracker";
import { mergeCatalogs, resolveMentions, type ProjectCandidate } from "../server/mr-refs";
import { scanTimeline, type TimelineItemLike } from "../server/scan";
import { LinkStore } from "../server/store";
import { LIMITS, projectConfigSchema } from "../shared/config";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

async function timed<T>(run: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

afterEach(() => vi.unstubAllGlobals());

describe("names a config declares for projects", () => {
  const host = "gitlab.example.test";

  it("resolve through `projects` and through a catalog's name field", () => {
    const fromProjects = [{ name: "be", project: "team/backend/api", host }];
    const fromCatalog = [{ name: "web", project: "team/frontend/dashboard-spa", host }];
    expect(resolveMentions(["be!3"], [], fromProjects, undefined)).toEqual([`https://${host}/team/backend/api/-/merge_requests/3`]);
    expect(resolveMentions(["web!4"], [], fromCatalog, undefined)).toEqual([`https://${host}/team/frontend/dashboard-spa/-/merge_requests/4`]);
    // The project's own last segment still works too.
    expect(resolveMentions(["api!5"], [], fromProjects, undefined)).toEqual([`https://${host}/team/backend/api/-/merge_requests/5`]);
  });

  it("prefer a declared name over a project whose last segment is the same word", () => {
    const catalog = [
      { name: "api", project: "team/backend/gateway", host },
      { name: "legacy-api", project: "old/api", host },
    ];
    expect(resolveMentions(["api!1"], [], catalog, undefined)).toEqual([`https://${host}/team/backend/gateway/-/merge_requests/1`]);
  });
});

describe("task doc globs the schema allows", () => {
  const parses = (taskDocs: string[]) => projectConfigSchema.safeParse({ focus: { taskDocs } }).success;

  it("fold repeated `**`, allow at most two, and require a file pattern last", () => {
    expect(projectConfigSchema.parse({ focus: { taskDocs: ["docs/**/**/**/*.md"] } }).focus?.taskDocs).toEqual(["docs/**/*.md"]);
    expect(parses([Array(16).fill("**").join("/")])).toBe(false);
    expect(parses(["a/**/b/**/c/**/*.md"])).toBe(false);
    expect(parses(["tasks/**"])).toBe(false);
    expect(parses(["**"])).toBe(false);
    expect(parses(["tasks/**/*.md"])).toBe(true);
  });

  // The slowest globs still allowed: 32 of them, 16 segments, two `**`, star-heavy segments.
  const worstGlob = ["**", ...Array(LIMITS.globSegments - 3).fill("*a*a*a*a*a*a*a*b"), "**", "*.md"].join("/");
  const config = projectConfigSchema.parse({ focus: { root: ".", taskDocs: Array(LIMITS.taskDocs).fill(worstGlob) } });
  const rules = taskDocRules({ file: "/p/.paseo/trail/config.json", projectRoot: "/p", personal: false, config }, null);

  it("scan 2 MB of prose and of path-like text within 250 ms", async () => {
    const prose = "lorem/ipsum dolor/sit amet/a.md ".repeat(2100).slice(0, 64 * 1024);
    const paths = `${Array(250).fill("a".repeat(250)).join("/")}/x.md`.slice(-64 * 1024);
    for (const text of [prose, paths]) {
      const items: TimelineItemLike[] = Array.from({ length: 300 }, () => ({ type: "user_message", text }));
      const { ms } = await timed(() => scanTimeline(items, rules));
      expect(ms).toBeLessThan(250);
    }
  }, 20_000);

  it("list links for 50 pins of 2,048 characters within 50 ms", async () => {
    const state = tempDir();
    const pins = Array.from({ length: 50 }, (_, i) => ({ target: `${i}/${"a/".repeat(1100)}x.md`.slice(0, 2048), at: String(i) }));
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify(pins));
    const store = new LinkStore(state);
    await store.links("agent-a", { rules, catalog: [], defaultHost: undefined });
    const { ms } = await timed(() => store.links("agent-a", { rules, catalog: [], defaultHost: undefined }));
    expect(ms).toBeLessThan(50);
  });
});

describe("GitLab hosts seen only in conversations", () => {
  it("keep the first ones tracked and report the rest, without churn", () => {
    const tracker = new HostTracker(10, 24 * 60 * 60_000);
    const hosts = Array.from({ length: 12 }, (_, i) => `h${i}.example.test`);
    for (let poll = 0; poll < 5; poll += 1) {
      const states = hosts.map((host) => tracker.see(host, poll));
      expect(states.filter((state) => state === "tracked")).toHaveLength(10);
      expect(states.slice(10)).toEqual(["overLimit", "overLimit"]);
    }
    expect(tracker.prune(5, () => false)).toEqual([]);
    expect(tracker.prune(24 * 60 * 60_000 + 10, () => false)).toHaveLength(12);
  });

  it("are shown as too many and never contacted when over the limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const credentials = new Credentials(tempDir());
    credentials.requireOverLimit("h11.example.test", { kind: "link" });
    const [status] = await credentials.statuses();
    expect(status.detail.code).toBe("tooManyHosts");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("references resolved on every poll", () => {
  it("are answered from a cache once resolved", async () => {
    const catalog: Array<ProjectCandidate & { name: string }> = mergeCatalogs([
      Array.from({ length: 5000 }, (_, i) => ({ name: `n${i}`, project: `g${i}/api`, host: "gitlab.example.test" })),
    ]);
    const mentions = Array.from({ length: 40 }, (_, i) => `api!${i}`);
    resolveMentions(mentions, [], catalog, undefined);
    const { ms } = await timed(() => {
      for (let poll = 0; poll < 100; poll += 1) resolveMentions(mentions, [], catalog, undefined);
    });
    expect(ms).toBeLessThan(20);
  });
});

describe("merging with what the confirmation showed", () => {
  it("is refused when the settings changed since", async () => {
    expect(() => requireShownOptions({ squash: true, removeSourceBranch: false }, { squash: false, removeSourceBranch: false })).toThrow(
      /changed since the confirmation/,
    );
    const answers: Record<string, unknown> = {
      "personal_access_tokens/self": { scopes: ["api"] },
      "projects/a%2Fb/merge_requests/3": { state: "opened", source_branch: "x", target_branch: "main", sha: "abc", squash_on_merge: true },
      "projects/a%2Fb/merge_requests/3/approvals": { approved: true, approved_by: [] },
      "projects/a%2Fb": { squash_option: "default_on" },
    };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const path = url.split("/api/v4/")[1].split("?")[0];
        return new Response(JSON.stringify(answers[path] ?? {}), { status: answers[path] ? 200 : 404 });
      }),
    );
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    const gitlab = new GitLab(credentials);
    const url = "https://gitlab.example.test/a/b/-/merge_requests/3";
    gitlab.cachedStatus(url);
    await vi.waitFor(() => expect(gitlab.cachedStatus(url)).toBeDefined());
    await expect(gitlab.merge(url, "abc", { squash: false, removeSourceBranch: false })).rejects.toThrow(/changed since/);
    expect(calls.some((call) => call.includes("/merge?"))).toBe(false);
    gitlab.dispose();
  });
});

describe("other inputs", () => {
  it("reads an oversized state file as empty, quickly", async () => {
    const state = tempDir();
    writeFileSync(join(state, "agent-a.scanned.json"), `{"mergeRequests":["${"x".repeat(5 * 1024 * 1024)}"]}`);
    const { value, ms } = await timed(() => new LinkStore(state).links("agent-a", { rules: null, catalog: [], defaultHost: undefined }));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  it("drops request links whose project path has `.` or `..` segments", () => {
    expect(findChangeRequests("https://gitlab.example.test/../x/-/merge_requests/1")).toEqual([]);
    expect(findChangeRequests("https://gitlab.example.test/a/./b/-/merge_requests/1")).toEqual([]);
    expect(findChangeRequests("https://github.com/../x/pull/1")).toEqual([]);
    expect(findChangeRequests("https://github.com/owner/../pull/1")).toEqual([]);
  });

  it("fences code with more backticks than the file contains", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ````` b")).toBe("``````");
  });
});
