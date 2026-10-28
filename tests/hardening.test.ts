import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Credentials,
  fetchWithToken,
  gitLabCredentialId,
  GITHUB_CREDENTIAL_ID,
  RedirectError,
} from "../server/credentials";
import { findTaskDocs, taskDocRules } from "../server/extract";
import { readTextFile, readTextFileSync } from "../server/files";
import { Forges } from "../server/forges";
import type { GitHub } from "../server/github";
import type { GitLab } from "../server/gitlab";
import { readCatalog } from "../server/mr-refs";
import { findGlobPaths, ProjectConfigs, splitGlob } from "../server/project-config";
import { LinkStore } from "../server/store";
import { mergeRequestStatusSchema } from "../shared/links";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");
const DEV_ZERO = "/dev/zero";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function writeConfig(dir: string, config: object): void {
  mkdirSync(join(dir, ".paseo", "trail"), { recursive: true });
  writeFileSync(join(dir, ".paseo", "trail", "config.json"), JSON.stringify(config));
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe("patterns a project cannot make slow", () => {
  it("matches a glob of many stars against a long path-like run quickly", () => {
    const text = `${"a-".repeat(400)}x`;
    const { value, ms } = timed(() => findGlobPaths(text, [splitGlob("*-*-*-*-*-*-*.md")]));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(200);
  }, 5_000);

  it("matches `**` against a deep path quickly", () => {
    const text = `${"a/".repeat(200)}b.txt`;
    const { ms } = timed(() => findGlobPaths(text, [splitGlob("**/*-*-*/**/*.md")]));
    expect(ms).toBeLessThan(200);
  }, 5_000);

  it("refuses a task ID pattern in a project file and never runs one from there", () => {
    const project = tempDir();
    writeConfig(project, { focus: { root: ".", taskId: { pattern: "^(a+)+$" } } });
    const configs = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(configs.forDirectory(project)).toBeNull();
    expect(configs.known().problems[0].error).toMatch(/taskId/);
  });

  it("takes the task ID pattern from the personal config only", () => {
    const project = tempDir();
    writeConfig(project, { focus: { root: "." } });
    const home = tempDir();
    const personalFile = join(home, "config.json");
    writeFileSync(personalFile, JSON.stringify({ focus: { root: ".", taskId: { pattern: "([A-Z]+-\\d+)" } } }));
    const configs = new ProjectConfigs(personalFile);
    const rules = taskDocRules(configs.forDirectory(project), configs.personal());
    expect(rules?.taskId?.pattern.source).toBe("([A-Z]+-\\d+)");
    expect(taskDocRules(configs.forDirectory(project), null)?.taskId).toBeUndefined();
  });
});

describe("glob boundaries", () => {
  const rules = taskDocRules(
    { file: "/p/.paseo/trail/config.json", projectRoot: "/p", personal: false, config: { focus: { root: ".", taskDocs: ["tasks/*.md"], bundle: "none" }, gitlab: [] } },
    null,
  );

  it("matches a whole path only", () => {
    expect(findTaskDocs("see tasks/foo.md.", rules)).toEqual(["tasks/foo.md"]);
    expect(findTaskDocs("/home/me/repo/tasks/foo.md", rules)).toEqual(["tasks/foo.md"]);
    expect(findTaskDocs("oldtasks/foo.md", rules)).toEqual([]);
    expect(findTaskDocs("tasks/foo.mdx", rules)).toEqual([]);
    expect(findTaskDocs("tasks/foo.md.bak", rules)).toEqual([]);
  });
});

describe("files a project points at", () => {
  it("does not read a device, however small it claims to be", async () => {
    const { value, ms } = timed(() => readTextFileSync(DEV_ZERO, 1024));
    expect(value?.kind).toBe("notFile");
    expect(ms).toBeLessThan(200);
    expect((await readTextFile(DEV_ZERO, 1024))?.kind).toBe("notFile");
  });

  it("does not wait on a FIFO", async () => {
    const fifo = join(tempDir(), "pipe");
    execFileSync("mkfifo", [fifo]);
    expect((await readTextFile(fifo, 1024))?.kind).toBe("notFile");
    expect(readTextFileSync(fifo, 1024)?.kind).toBe("notFile");
  });

  it("counts bytes while reading instead of trusting the size", async () => {
    const file = join(tempDir(), "big.md");
    writeFileSync(file, "x".repeat(2048));
    expect((await readTextFile(file, 1024))?.kind).toBe("tooLarge");
    expect((await readTextFile(file, 4096))?.kind).toBe("text");
  });

  it("ignores a project config that is a symlink to a device or outside the project", () => {
    const project = tempDir();
    mkdirSync(join(project, ".paseo", "trail"), { recursive: true });
    symlinkSync(DEV_ZERO, join(project, ".paseo", "trail", "config.json"));
    const configs = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(configs.forDirectory(project)).toBeNull();
    expect(configs.known().problems[0].error).toMatch(/outside the project|not a regular file/);

    const other = tempDir();
    const secret = join(tempDir(), "secret.json");
    writeFileSync(secret, "secret-file-contents-outside-the-project");
    mkdirSync(join(other, ".paseo", "trail"), { recursive: true });
    symlinkSync(secret, join(other, ".paseo", "trail", "config.json"));
    const second = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(second.forDirectory(other)).toBeNull();
    expect(JSON.stringify(second.known().problems)).not.toMatch(/secret-file-contents/);
  });

  it("reads no catalog that resolves outside the project or is a device", () => {
    const project = tempDir();
    const outside = join(tempDir(), "catalog.json");
    writeFileSync(outside, JSON.stringify({ repositories: [{ name: "api", path: "team/api" }] }));
    symlinkSync(outside, join(project, "catalog.json"));
    symlinkSync(DEV_ZERO, join(project, "zero.json"));
    const spec = { host: "gitlab.example.test", items: "repositories", name: "name", project: "path", root: project };
    expect(readCatalog({ ...spec, file: join(project, "catalog.json") })).toEqual([]);
    const { value, ms } = timed(() => readCatalog({ ...spec, file: join(project, "zero.json") }));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  it("does not open a task doc that is a symlink out of the docs root", async () => {
    const project = tempDir();
    mkdirSync(join(project, "tasks"));
    const secret = join(tempDir(), "secret.md");
    writeFileSync(secret, "# not a task");
    symlinkSync(secret, join(project, "tasks", "evil.md"));
    writeFileSync(join(project, "tasks", "fine.md"), "# fine");
    const rules = taskDocRules(
      { file: join(project, ".paseo/trail/config.json"), projectRoot: project, personal: false, config: { focus: { root: ".", taskDocs: ["tasks/*.md"], bundle: "none" }, gitlab: [] } },
      null,
    );
    const state = tempDir();
    const store = new LinkStore(state);
    for (const [agentId, target] of [["agent-a", "tasks/evil.md"], ["agent-b", "tasks/fine.md"]]) {
      writeFileSync(join(state, `${agentId}.reported.json`), JSON.stringify([{ target, kind: "task", primary: true }]));
    }
    const context = { rules, catalog: [], defaultHost: undefined };
    expect((await store.links("agent-a", context))[0].localPath).toBeUndefined();
    expect((await store.links("agent-b", context))[0].localPath).toBe(join(project, "tasks", "fine.md"));
  });
});

describe("tokens", () => {
  const saved = { github: process.env.GITHUB_TOKEN };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ scopes: ["api"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.github === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.github;
  });

  it("only asks glab about hosts in the personal config", () => {
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("seen-in-chat.example.test", undefined);
    credentials.requireGitLab("listed.example.test", { tokenFiles: [], tokenKey: "GITLAB_TOKEN" });
    return credentials.statuses().then(([unlisted, listed]) => {
      expect(unlisted.checked.some((source) => source.type === "cli")).toBe(false);
      expect(listed.checked.some((source) => source.type === "cli")).toBe(true);
    });
  });

  it("never follows a redirect with a token, and says where it went", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://sso.example.test/login" } }));
    await expect(fetchWithToken("https://gitlab.example.test/api/v4/user", { headers: { "PRIVATE-TOKEN": "t" } })).rejects.toBeInstanceOf(RedirectError);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });

    const secrets = tempDir();
    const credentials = new Credentials(secrets);
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    const [status] = await credentials.statuses();
    expect(status.detail).toEqual({ code: "redirected", values: { host: "gitlab.example.test", target: "sso.example.test" } });
  });

  it("refuses to save a token with spaces or line breaks", async () => {
    const credentials = new Credentials(tempDir());
    credentials.requireGitHub();
    await expect(credentials.store(GITHUB_CREDENTIAL_ID, "abc\ndef")).rejects.toThrow(/visible characters/);
    await expect(credentials.store(GITHUB_CREDENTIAL_ID, "abc def")).rejects.toThrow();
  });

  it("never sends a malformed token found elsewhere", async () => {
    process.env.GITHUB_TOKEN = "abc\u0007def";
    const credentials = new Credentials(tempDir());
    credentials.requireGitHub();
    const [status] = await credentials.statuses();
    expect(status.detail.code).toBe("malformed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await credentials.value(GITHUB_CREDENTIAL_ID)).toBeNull();
  });

  it("reports a failed request by code, never by a message that quotes the token", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Headers.append: "secret-token-value" is an invalid header value.');
    });
    process.env.GITHUB_TOKEN = "secret-token-value";
    const credentials = new Credentials(tempDir());
    credentials.requireGitHub();
    const [status] = await credentials.statuses();
    expect(status.state).toBe("unchecked");
    expect(JSON.stringify(status)).not.toContain("secret-token-value");
  });
});

describe("state that was cut short or edited by hand", () => {
  it("reads a scan, pin or mode file of the wrong shape as empty", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    const context = { rules: null, catalog: [], defaultHost: undefined };
    writeFileSync(join(state, "agent-a.scanned.json"), "null");
    writeFileSync(join(state, "agent-a.reported.json"), "{}");
    writeFileSync(join(state, "agent-a.mode.json"), '"all"');
    await expect(store.links("agent-a", context)).resolves.toEqual([]);
    await expect(store.otherLinks("agent-a", [])).resolves.toEqual([]);
    expect(await store.mode("agent-a")).toBeUndefined();
    await store.pin("agent-a", { target: "https://example.test/page", kind: "link" }, "https://example.test/page");
    expect((await store.links("agent-a", context)).map((link) => link.url)).toEqual(["https://example.test/page"]);

    writeFileSync(join(state, "agent-b.scanned.json"), "{}");
    await store.saveScan("agent-b", { tasks: {}, mergeRequests: ["https://gitlab.example.test/a/b/-/merge_requests/1"] });
    expect((await store.links("agent-b", context)).map((link) => link.kind)).toEqual(["mr"]);
  });

  it("lets the MCP tool pin over a pin file of the wrong shape", () => {
    const state = tempDir();
    writeFileSync(join(state, "agent-1.reported.json"), '{"not":"a list"}');
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pin_link", arguments: { target: "https://example.test" } } });
    const output = execFileSync(process.execPath, [MCP_SCRIPT], {
      input: `${request}\n`,
      env: { ...process.env, TRAIL_STATE_DIR: state, PASEO_AGENT_ID: "agent-1", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(JSON.parse(output.toString()).result.isError).toBeUndefined();
  });
});

describe("forge answers with missing fields", () => {
  it("keeps a status whose fields are null or absent", () => {
    const status = mergeRequestStatusSchema.parse({ state: "opened", sha: null, pipeline: { status: "success", url: null } });
    expect(status).toMatchObject({ sha: "", pipeline: null, approvedBy: [], behind: 0 });
  });

  it("refuses to merge without a head commit", async () => {
    const forge = { merge: vi.fn() };
    const forges = new Forges(forge as unknown as GitLab, forge as unknown as GitHub);
    await expect(forges.merge("https://gitlab.example.test/a/b/-/merge_requests/1", "", { squash: false, removeSourceBranch: false })).rejects.toThrow(/head commit/);
    expect(forge.merge).not.toHaveBeenCalled();
  });
});
