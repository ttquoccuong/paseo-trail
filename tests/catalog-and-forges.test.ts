import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openableUrl } from "../client/urls";
import { bundleFiles } from "../server/bundle";
import { Credentials, gitLabCredentialId } from "../server/credentials";
import { reportedLink } from "../server/extract";
import { GitLab } from "../server/gitlab";
import { findMergeRequestRefs, MAX_CATALOG_CANDIDATES, mergeCatalogs, resolveMentions, type ProjectCandidate } from "../server/mr-refs";
import { scanTimeline, type TimelineItemLike } from "../server/scan";
import { LinkStore } from "../server/store";
import { LIMITS, projectConfigSchema } from "../shared/config";
import { credentialStatusSchema } from "../shared/links";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a catalog at the schema's limits", () => {
  // 16 hosts, each with the most named projects allowed and the same 2,000-entry catalog, all
  // pointing at one project: 40,000 candidates before deduplication.
  const parts: Array<Array<ProjectCandidate & { name: string }>> = Array.from({ length: LIMITS.gitlabHosts }, (_, h) => [
    ...Array.from({ length: LIMITS.projects }, (_, i) => ({ name: `n${i}`, project: "a/b", host: `h${h}.example.test` })),
    ...Array.from({ length: 2000 }, (_, i) => ({ name: `c${i}`, project: "a/b", host: `h${h}.example.test` })),
  ]);
  const mentions = Array.from({ length: 40 }, (_, i) => `n${i}!${i}`);

  it("merges into a bounded catalog quickly", () => {
    const { value, ms } = timed(() => mergeCatalogs(parts));
    expect(value.length).toBeLessThanOrEqual(MAX_CATALOG_CANDIDATES);
    expect(ms).toBeLessThan(200);
  });

  it("resolves a poll's references quickly, and faster once the index is built", () => {
    const catalog = mergeCatalogs(parts);
    const first = timed(() => resolveMentions(mentions, [], catalog, undefined));
    expect(first.ms).toBeLessThan(300);
    const later = timed(() => {
      for (let poll = 0; poll < 10; poll += 1) resolveMentions(mentions, [], catalog, undefined);
    });
    expect(later.ms).toBeLessThan(100);
  });

  it("refuses a GitLab host listed twice, and host names that hide another host", () => {
    const parses = (gitlab: object[]) => projectConfigSchema.safeParse({ gitlab }).success;
    expect(parses([{ host: "gitlab.example.test" }, { host: "GitLab.Example.test" }])).toBe(false);
    expect(parses([{ host: "gitlab.example.test:443@evil.example" }])).toBe(false);
    expect(parses([{ host: "gitlab.example.test/path" }])).toBe(false);
    expect(parses([{ host: "gitlab example.test" }])).toBe(false);
    expect(parses([{ host: "gitlab.example.test:99999" }])).toBe(false);
    expect(projectConfigSchema.parse({ gitlab: [{ host: "GitLab.Example.test:443" }] }).gitlab[0].host).toBe("gitlab.example.test");
  });
});

describe("status fetches that fail", () => {
  it("are not retried on every poll, and are logged once", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.endsWith("/personal_access_tokens/self")
          ? new Response(JSON.stringify({ scopes: ["api"] }), { status: 200 })
          : new Response('{"message":"404 Project Not Found"}', { status: 404 });
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    const gitlab = new GitLab(credentials);
    const url = "https://gitlab.example.test/a/b/-/merge_requests/3";
    gitlab.cachedStatus(url);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    for (let poll = 0; poll < 5; poll += 1) {
      gitlab.cachedStatus(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls.filter((call) => call.includes("/merge_requests/3")).length).toBeLessThanOrEqual(2);
    expect(errors).toHaveBeenCalledTimes(1);
    gitlab.dispose();
  });
});

describe("what a pinned request may claim", () => {
  it("shows a merge request by its own name whatever label it was pinned with", () => {
    const link = reportedLink("https://gitlab.example.test/other/project/-/merge_requests/7", "mr", "!12 my-feature", null);
    expect(link).toMatchObject({ label: "!7 project", title: "other/project!7" });
  });

  it("marks a host that only a project file or a link named", async () => {
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined, { kind: "project", file: "/repo/.paseo/trail/config.json" });
    const [status] = await credentials.statuses();
    expect(status.origin).toEqual({ kind: "project", file: "/repo/.paseo/trail/config.json" });
    expect(credentialStatusSchema.safeParse(status).success).toBe(true);
  });
});

describe("URLs a forge answers with", () => {
  it("opens only https pages, or http on the forge's own host", () => {
    const mr = "https://gitlab.example.test/a/b/-/merge_requests/1";
    expect(openableUrl("javascript:alert(1)", mr)).toBeNull();
    expect(openableUrl("file:///etc/passwd", mr)).toBeNull();
    expect(openableUrl("http://elsewhere.example/x", mr)).toBeNull();
    expect(openableUrl("http://gitlab.example.test/a/b/-/pipelines/1", "http://gitlab.example.test/a/b/-/merge_requests/1")).not.toBeNull();
    expect(openableUrl("https://ci.example/x", mr)).toBe("https://ci.example/x");
  });

  it("drops a pipeline link that is not a web page", async () => {
    const answers: Record<string, unknown> = {
      "personal_access_tokens/self": { scopes: ["api"] },
      "projects/a%2Fb/merge_requests/3": {
        state: "opened",
        source_branch: "x",
        target_branch: "main",
        sha: "abc",
        head_pipeline: { status: "success", web_url: "javascript:alert(1)" },
      },
      "projects/a%2Fb/merge_requests/3/approvals": { approved: false, approved_by: [] },
      "projects/a%2Fb": {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    expect(gitlab.cachedStatus(url)?.pipeline).toBeNull();
    gitlab.dispose();
  });
});

describe("globs with `?` at their worst", () => {
  it("keeps a whole scan of long path-like messages within a fixed budget", () => {
    const rules = {
      globs: Array.from({ length: LIMITS.taskDocs }, () => ["**", `*${"a".repeat(200)}?b`, "**", "*.md"]),
      root: "/",
      bundle: "none" as const,
    };
    const text = `${Array(250).fill("a".repeat(250)).join("/")}/x.md`.slice(0, 64 * 1024);
    const items: TimelineItemLike[] = Array.from({ length: 300 }, () => ({ type: "user_message", text }));
    const { ms } = timed(() => scanTimeline(items, rules));
    expect(ms).toBeLessThan(500);
  }, 20_000);
});

describe("references in long path-like text", () => {
  it("are looked for without backtracking", () => {
    const text = `${Array(250).fill("a".repeat(250)).join("/")} !1 #2`.slice(-64 * 1024);
    const { ms } = timed(() => {
      for (let message = 0; message < 50; message += 1) findMergeRequestRefs(text);
    });
    expect(ms).toBeLessThan(500);
    expect(findMergeRequestRefs("see group/project!12 and owner/repo#3")).toEqual(["group/project!12", "owner/repo#3"]);
  });
});

describe("bundles", () => {
  it("lists a big folder quickly, a bounded number of entries, and reuses the listing", () => {
    const task = join(tempDir(), "big-task");
    mkdirSync(task);
    writeFileSync(join(task, "README.md"), "# Big");
    for (let i = 0; i < 2000; i += 1) writeFileSync(join(task, `note-${i}.md`), "x");
    const first = timed(() => bundleFiles(join(task, "README.md")));
    expect(first.value.length).toBeLessThanOrEqual(20);
    const again = timed(() => {
      for (let poll = 0; poll < 100; poll += 1) bundleFiles(join(task, "README.md"));
    });
    expect(again.ms).toBeLessThan(50);
  });
});

describe("unpinning", () => {
  it("says when there was nothing to unpin, and writes nothing", async () => {
    const store = new LinkStore(tempDir());
    expect(await store.unpin("agent-a", "https://example.test/never")).toBe(false);
    await store.pin("agent-a", { target: "https://example.test/a", kind: "link" }, "https://example.test/a");
    expect(await store.unpin("agent-a", " https://example.test/a ")).toBe(true);
    expect(await store.pins("agent-a")).toEqual([]);
  });
});
