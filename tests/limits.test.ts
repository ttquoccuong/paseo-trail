import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Credentials, gitLabCredentialId } from "../server/credentials";
import { findChangeRequests, taskDocRules } from "../server/extract";
import { setBounded } from "../server/files";
import { GitLab } from "../server/gitlab";
import { findGlobPaths, ProjectConfigs, splitGlob } from "../server/project-config";
import { findUrls } from "../server/scan";
import { LinkStore } from "../server/store";
import { LIMITS, projectConfigSchema } from "../shared/config";
import { credentialStatusSchema } from "../shared/links";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

function writeConfig(dir: string, config: object): void {
  mkdirSync(join(dir, ".paseo", "trail"), { recursive: true });
  writeFileSync(join(dir, ".paseo", "trail", "config.json"), JSON.stringify(config));
}

describe("how much a project file may ask for", () => {
  const parses = (taskDocs: string[]) => projectConfigSchema.safeParse({ focus: { taskDocs } }).success;

  it("bounds the number, length and depth of task doc globs", () => {
    expect(parses(Array(LIMITS.taskDocs).fill("tasks/*.md"))).toBe(true);
    expect(parses(Array(LIMITS.taskDocs + 1).fill("tasks/*.md"))).toBe(false);
    expect(parses([`${"a".repeat(LIMITS.globLength)}.md`])).toBe(false);
    expect(parses([Array(LIMITS.globSegments + 1).fill("a").join("/")])).toBe(false);
  });

  it("matches chat text quickly with every glob at its limits", () => {
    const segment = "*a*a*a*a*a*a*a*b";
    const glob = ["**", ...Array(LIMITS.globSegments - 2).fill(segment), "*.md"].join("/").slice(0, LIMITS.globLength);
    const globs = Array(LIMITS.taskDocs).fill(splitGlob(glob));
    const token = `${Array(40).fill("a".repeat(250)).join("/")}/a.md`;
    const { ms } = timed(() => findGlobPaths(Array(200).fill(token).join(" "), globs));
    expect(ms).toBeLessThan(500);
  }, 10_000);
});

describe("trailing characters on long runs", () => {
  it("strips sentence punctuation after a URL in linear time", () => {
    const { value, ms } = timed(() => findUrls(`see https://a.example${"!".repeat(150_000)}`));
    expect(value).toEqual(["https://a.example"]);
    expect(ms).toBeLessThan(200);
    expect(timed(() => findUrls(`https://a.example${"!".repeat(150_000)}b`)).ms).toBeLessThan(200);
  }, 10_000);

  it("strips dots after a path in linear time", () => {
    const { ms } = timed(() => findGlobPaths(`tasks/a.md${".".repeat(150_000)}`, [splitGlob("tasks/*.md")]));
    expect(ms).toBeLessThan(200);
  }, 10_000);
});

describe("tokens pasted for a host with a port", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ scopes: ["api"] }), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the host back exactly as it was written", async () => {
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test:8443", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test:8443"), "glpat-sample");
    expect(await credentials.storedGitLabHosts()).toEqual(["gitlab.example.test:8443"]);
  });

  it("never reads a host out of a file name it did not write", async () => {
    const secrets = tempDir();
    // `gitlab_8443` is a valid hostname; a name like this must not turn into that host.
    writeFileSync(join(secrets, "gitlab_8443.token"), "glpat-earlier\n");
    const credentials = new Credentials(secrets);
    expect(await credentials.storedGitLabHosts()).toEqual([]);
    expect(existsSync(join(secrets, "gitlab_8443.token"))).toBe(true);
  });
});

describe("config edge cases", () => {
  it("refuses a docs root that is a symlink out of the project", () => {
    const project = tempDir();
    symlinkSync(tempDir(), join(project, "docs"));
    writeConfig(project, { focus: { root: "docs" } });
    const configs = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(configs.forDirectory(project)).toBeNull();
    expect(configs.known().problems[0].error).toMatch(/inside the project/);
  });

  it("does not take the personal file for a project file when walking up", () => {
    const paseoHome = tempDir();
    writeConfig(paseoHome, { gitlab: [{ host: "gitlab.example.test" }] });
    const personalFile = join(paseoHome, ".paseo", "trail", "config.json");
    const cwd = join(paseoHome, "work", "repo");
    mkdirSync(cwd, { recursive: true });
    const loaded = new ProjectConfigs(personalFile).forDirectory(cwd);
    expect(loaded?.personal).toBe(true);
    expect(loaded?.projectRoot).toBe(cwd);
  });

  it("uses the personal task ID pattern when the project file has no focus block", () => {
    const project = tempDir();
    writeConfig(project, { gitlab: [] });
    const personalFile = join(tempDir(), "config.json");
    writeFileSync(personalFile, JSON.stringify({ focus: { taskId: { pattern: "([A-Z]+-\\d+)" } } }));
    const configs = new ProjectConfigs(personalFile);
    expect(taskDocRules(configs.forDirectory(project), configs.personal())?.taskId).toBeDefined();
  });

  it("treats hosts as case-insensitive", () => {
    expect(findChangeRequests("https://GitLab.Example.test/a/b/-/merge_requests/3")).toEqual([
      "https://gitlab.example.test/a/b/-/merge_requests/3",
    ]);
    expect(projectConfigSchema.parse({ gitlab: [{ host: "GitLab.Example.test" }] }).gitlab[0].host).toBe("gitlab.example.test");
  });
});

describe("odd forge answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the settings screen readable when a token's expiry is not a date", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ scopes: ["api"], expires_at: true }), { status: 200 })));
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    const [status] = await credentials.statuses();
    expect(status.detail.code).toBe("ok");
    expect(credentialStatusSchema.safeParse(status).success).toBe(true);
  });

  it("reads approvals that include a deleted user", async () => {
    const answers: Record<string, unknown> = {
      "personal_access_tokens/self": { scopes: ["api"] },
      "projects/a%2Fb/merge_requests/3": { state: "opened", source_branch: "x", target_branch: "main", sha: "abc" },
      "projects/a%2Fb/merge_requests/3/approvals": { approved: true, approved_by: [{ user: null }, null, { user: { username: "maya" } }] },
      "projects/a%2Fb": { squash_option: "default_off" },
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
    await vi.waitFor(() => expect(gitlab.cachedStatus(url)?.approvedBy).toEqual(["maya"]));
    gitlab.dispose();
  });
});

describe("pins", () => {
  it("keeps every one of many pins made at once, up to the cap", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.pin("agent-a", { target: `https://example.test/${i}`, kind: "link" }, `https://example.test/${i}`)),
    );
    expect(await store.pins("agent-a")).toHaveLength(20);
    for (let i = 20; i < 70; i += 1) await store.pin("agent-a", { target: `https://example.test/${i}`, kind: "link" }, `https://example.test/${i}`);
    expect(await store.pins("agent-a")).toHaveLength(50);
  });

  it("treats a target with stray spaces as the same pin", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    await store.pin("agent-a", { target: "https://example.test/a", kind: "link" }, "https://example.test/a");
    await store.pin("agent-a", { target: " https://example.test/a ", kind: "link" }, " https://example.test/a ");
    expect(await store.pins("agent-a")).toHaveLength(1);
  });
});

describe("housekeeping", () => {
  it("keeps bounded caches bounded", () => {
    const cache = new Map<number, number>();
    for (let i = 0; i < 1000; i += 1) setBounded(cache, i, i);
    expect(cache.size).toBeLessThanOrEqual(200);
    expect(cache.has(999)).toBe(true);
  });

  it("reports the package version from the MCP server", () => {
    const version = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
    expect(readFileSync(MCP_SCRIPT, "utf8")).toContain(`version: "${version}"`);
  });
});
