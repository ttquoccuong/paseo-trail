import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credentials } from "../server/credentials";
import { GitLab } from "../server/gitlab";
import { withPreferredGitLab } from "../server/hash-references";
import { resolveMentions } from "../server/mr-refs";
import { LinkStore } from "../server/store";

const HOST = "gitlab.example.test:8081";
const context = { rules: null, catalog: [], defaultHost: undefined };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function scan(state: string, agent: string, mergeRequests: string[], urls: string[] = []) {
  writeFileSync(join(state, `${agent}.scanned.json`), JSON.stringify({ tasks: {}, mergeRequests, urls, files: {} }));
}

describe("`group/project#N` for a project known to live on GitLab", () => {
  const gitlab = new Map([["booknow/playbook", HOST]]);

  it("is a GitLab issue, not a GitHub pull request", () => {
    expect(resolveMentions(["booknow/playbook#199"], [], [], undefined, gitlab)).toEqual([]);
  });

  it("stays a GitHub pull request for a repository never seen on GitLab", () => {
    expect(resolveMentions(["ttquoccuong/paseo-trail#3"], [], [], undefined, gitlab)).toEqual([
      "https://github.com/ttquoccuong/paseo-trail/pull/3",
    ]);
  });

  it("is a GitLab issue when the config's catalog names the project", () => {
    const catalog = [{ name: "playbook", project: "booknow/playbook", host: HOST }];
    expect(resolveMentions(["booknow/playbook#199"], [], catalog, undefined)).toEqual([]);
  });

  it("lets a `group/project!N` reference find its host without a config", () => {
    expect(resolveMentions(["booknow/playbook!193"], [], [], undefined, gitlab)).toEqual([
      `https://${HOST}/booknow/playbook/-/merge_requests/193`,
    ]);
  });
});

describe("GitLab projects learned from this machine's sessions", () => {
  it("come from GitLab pages any session opened, with their host", async () => {
    const state = tempDir();
    scan(state, "agent-a", [`https://${HOST}/booknow/frontend/-/merge_requests/1`], [`https://${HOST}/booknow/playbook/-/issues/5`]);
    scan(state, "agent-b", [], ["https://github.com/ttquoccuong/paseo-trail/pull/3", "https://example.test/a/b/-/c"]);
    const projects = await new LinkStore(state).gitlabProjects(new Set([HOST, "example.test"]));
    expect(Object.fromEntries(projects)).toEqual({
      "booknow/frontend": HOST,
      "booknow/playbook": HOST,
      "a/b": "example.test",
    });
  });

  it("come only from hosts the user trusts, so a page elsewhere cannot redirect a GitHub reference", async () => {
    const state = tempDir();
    scan(state, "agent-a", [], ["https://evil.example/ttquoccuong/paseo-trail/-/issues/1", `https://${HOST}/booknow/playbook/-/issues/5`]);
    const projects = await new LinkStore(state).gitlabProjects(new Set([HOST]));
    expect(Object.fromEntries(projects)).toEqual({ "booknow/playbook": HOST });
  });

  it("leave out a project seen on two hosts, since either could be meant", async () => {
    const state = tempDir();
    scan(state, "agent-a", [`https://${HOST}/team/app/-/merge_requests/1`]);
    scan(state, "agent-b", ["https://gitlab.com/team/app/-/merge_requests/2"]);
    expect((await new LinkStore(state).gitlabProjects(new Set([HOST, "gitlab.com"]))).has("team/app")).toBe(false);
  });

  it("turn one session's `#N` into the GitLab issue, not a GitHub pull request", async () => {
    const state = tempDir();
    scan(state, "agent-a", [`https://${HOST}/booknow/playbook/-/merge_requests/193`]);
    scan(state, "agent-b", ["booknow/playbook#199", "ttquoccuong/paseo-trail#3"]);
    const store = new LinkStore(state);
    const withProjects = { ...context, gitlabProjects: await store.gitlabProjects(new Set([HOST])) };
    const links = await store.links("agent-b", withProjects);
    expect(links.map((link) => link.url)).toEqual(["https://github.com/ttquoccuong/paseo-trail/pull/3"]);
    const other = await store.otherLinks("agent-b", links, undefined, withProjects);
    expect(other).toContainEqual(
      expect.objectContaining({ url: `https://${HOST}/booknow/playbook/-/issues/199`, kind: "link", label: "#199 playbook" }),
    );
  });
});

describe("preferring GitLab for `#N` (hashReferences: gitlab)", () => {
  const learned = new Map([["booknow/frontend", HOST]]);
  const base = { learned, githubRepos: new Set(["ttquoccuong/paseo-trail"]), host: HOST, onGitLab: () => "unknown" as const };

  it("reads an unknown repository's `#N` as a GitLab issue on the preferred host", () => {
    const projects = withPreferredGitLab({ ...base, mentioned: ["booknow/playbook", "ttquoccuong/paseo-trail"] });
    expect(projects.get("booknow/playbook")).toBe(HOST);
    expect(resolveMentions(["booknow/playbook#199"], [], [], undefined, projects)).toEqual([]);
  });

  it("keeps a repository this machine opened on github.com a GitHub pull request", () => {
    const projects = withPreferredGitLab({ ...base, mentioned: ["ttquoccuong/paseo-trail"] });
    expect(resolveMentions(["ttquoccuong/paseo-trail#3"], [], [], undefined, projects)).toEqual([
      "https://github.com/ttquoccuong/paseo-trail/pull/3",
    ]);
  });

  it("falls back to GitHub once GitLab says the project does not exist", () => {
    const projects = withPreferredGitLab({ ...base, mentioned: ["someone/tool"], onGitLab: () => "no" as const });
    expect(projects.has("someone/tool")).toBe(false);
  });

  it("keeps a learned host over the preferred one", () => {
    const projects = withPreferredGitLab({ ...base, host: "other.example", mentioned: ["booknow/frontend"] });
    expect(projects.get("booknow/frontend")).toBe(HOST);
  });

  it("changes nothing without a preferred host", () => {
    expect(withPreferredGitLab({ ...base, host: null, mentioned: ["booknow/playbook"] })).toBe(learned);
  });
});

describe("repositories this machine opened on github.com", () => {
  it("come from github.com pages in any session", async () => {
    const state = tempDir();
    scan(state, "agent-a", ["https://github.com/ttquoccuong/paseo-trail/pull/3"], ["https://github.com/getpaseo/plugins/blob/main/x.md", "https://github.com/settings/tokens"]);
    expect([...(await new LinkStore(state).githubRepos())].sort()).toEqual(["getpaseo/plugins", "ttquoccuong/paseo-trail"]);
  });

  it("and a session's own `#N` references name their repositories", async () => {
    const state = tempDir();
    scan(state, "agent-a", ["booknow/playbook#199", "booknow/frontend!12", "getpaseo/plugins#4"]);
    expect(await new LinkStore(state).hashReferenceRepos("agent-a")).toEqual(["booknow/playbook", "getpaseo/plugins"]);
  });
});

describe("asking GitLab whether a project exists", () => {
  afterEach(() => vi.unstubAllGlobals());
  const credentials = { value: async () => "token", invalidate: () => undefined } as unknown as Credentials;

  it("answers unknown at first, then what GitLab said, without asking twice", async () => {
    const fetch = vi.fn(async (url: string) => new Response("{}", { status: url.includes("booknow%2Fplaybook") ? 200 : 404 }));
    vi.stubGlobal("fetch", fetch);
    const gitlab = new GitLab(credentials);
    expect(gitlab.projectOnHost(HOST, "booknow/playbook")).toBe("unknown");
    expect(gitlab.projectOnHost(HOST, "someone/tool")).toBe("unknown");
    await vi.waitFor(() => expect(gitlab.projectOnHost(HOST, "someone/tool")).toBe("no"));
    expect(gitlab.projectOnHost(HOST, "booknow/playbook")).toBe("yes");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe(`https://${HOST}/api/v4/projects/booknow%2Fplaybook`);
  });

  it("stays unknown on other errors and does not ask without a token", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const gitlab = new GitLab(credentials);
    gitlab.projectOnHost(HOST, "booknow/playbook");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gitlab.projectOnHost(HOST, "booknow/playbook")).toBe("unknown");
    const noToken = new GitLab({ value: async () => null, invalidate: () => undefined } as unknown as Credentials);
    noToken.projectOnHost(HOST, "x/y");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
