import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Credentials, GITHUB_CREDENTIAL_ID, gitLabCredentialId, normalizeHost } from "../server/credentials";
import { reportedLink } from "../server/extract";
import { Forges } from "../server/forges";
import type { GitHub } from "../server/github";
import type { GitLab } from "../server/gitlab";
import { findGlobPaths, isInside, ProjectConfigs, splitGlob } from "../server/project-config";
import { LinkStore } from "../server/store";
import { projectConfigSchema } from "../shared/config";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

function writeConfig(dir: string, config: object): string {
  const file = join(dir, ".paseo", "trail", "config.json");
  mkdirSync(join(dir, ".paseo", "trail"), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  return file;
}

function okResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("token sources a project cannot choose", () => {
  it("rejects a project config that names token files", () => {
    const project = tempDir();
    writeConfig(project, { gitlab: [{ host: "gitlab.example.test", tokenFiles: ["~/.ssh/id_rsa"] }] });
    const configs = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(configs.forDirectory(project)).toBeNull();
    expect(configs.known().problems[0].error).toMatch(/personal config/);
  });

  it("rejects a project config whose paths leave the project", () => {
    const project = tempDir();
    writeConfig(project, { focus: { root: "../elsewhere" } });
    const configs = new ProjectConfigs(join(tempDir(), "config.json"));
    expect(configs.forDirectory(project)).toBeNull();
    expect(configs.known().problems[0].error).toMatch(/inside the project/);
  });

  it("accepts token files from the personal config", () => {
    const home = tempDir();
    const personalFile = join(home, "config.json");
    writeFileSync(personalFile, JSON.stringify({ gitlab: [{ host: "gitlab.example.test", tokenFiles: ["/x/gitlab.env"] }] }));
    expect(new ProjectConfigs(personalFile).personal()?.config.gitlab[0].tokenFiles).toEqual(["/x/gitlab.env"]);
  });

  it("only takes a plain variable name as the token key", () => {
    const parse = (tokenKey: string) => projectConfigSchema.safeParse({ gitlab: [{ host: "h", tokenKey }] }).success;
    expect(parse("GITLAB_TOKEN")).toBe(true);
    expect(parse(".*")).toBe(false);
    expect(parse("A|B")).toBe(false);
  });
});

describe("credentials", () => {
  const saved = { token: process.env.GITLAB_TOKEN, host: process.env.GITLAB_HOST };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({ scopes: ["api"], expires_at: null }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.GITLAB_TOKEN = saved.token;
    process.env.GITLAB_HOST = saved.host;
    if (saved.token === undefined) delete process.env.GITLAB_TOKEN;
    if (saved.host === undefined) delete process.env.GITLAB_HOST;
  });

  it("never offers GITLAB_TOKEN to a host other than GITLAB_HOST", async () => {
    process.env.GITLAB_TOKEN = "env-token";
    delete process.env.GITLAB_HOST;
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("attacker.example.test", undefined);
    const [status] = await credentials.statuses();
    expect(status.checked.some((source) => source.type === "env")).toBe(false);
    expect(status.state).toBe("missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches GITLAB_HOST written as a URL", async () => {
    process.env.GITLAB_TOKEN = "env-token";
    process.env.GITLAB_HOST = "https://GitLab.Example.test/";
    expect(normalizeHost(process.env.GITLAB_HOST)).toBe("gitlab.example.test");
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    expect(await credentials.value(gitLabCredentialId("gitlab.example.test"))).toBe("env-token");
    expect(fetchMock.mock.calls[0][0]).toBe("https://gitlab.example.test/api/v4/personal_access_tokens/self");
  });

  it("reads the configured key from a token file, literally", async () => {
    const dir = tempDir();
    const file = join(dir, "gitlab.env");
    writeFileSync(file, "AXB=wrong\nA.B=right\n");
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", { tokenFiles: [file], tokenKey: "A.B" });
    expect(await credentials.value(gitLabCredentialId("gitlab.example.test"))).toBe("right");
  });

  it("shares one check between concurrent callers and drops a check overtaken by a change", async () => {
    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    process.env.GITHUB_TOKEN = "gh-token";
    const credentials = new Credentials(tempDir());
    credentials.requireGitHub();
    const first = credentials.value(GITHUB_CREDENTIAL_ID);
    const second = credentials.value(GITHUB_CREDENTIAL_ID);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    credentials.invalidate(GITHUB_CREDENTIAL_ID);
    release(new Response("{}", { status: 200 }));
    await Promise.all([first, second]);
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    await credentials.value(GITHUB_CREDENTIAL_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    delete process.env.GITHUB_TOKEN;
  });

  it("settles a check whose forge answers with something that is not JSON", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>portal</html>", { status: 200 }));
    const file = join(tempDir(), "gitlab.env");
    writeFileSync(file, "GITLAB_TOKEN=abc\n");
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", { tokenFiles: [file], tokenKey: "GITLAB_TOKEN" });
    const [status] = await credentials.statuses();
    expect(status.state).toBe("unchecked");
    credentials.invalidate(gitLabCredentialId("gitlab.example.test"));
    fetchMock.mockImplementation(async () => okResponse({ scopes: ["api"], expires_at: null }));
    expect((await credentials.statuses())[0].state).toBe("ok");
  });

  it("keeps the secrets folder private even when it already existed", async () => {
    const secrets = tempDir();
    const credentials = new Credentials(secrets);
    credentials.requireGitHub();
    await credentials.store(GITHUB_CREDENTIAL_ID, "pasted");
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
  });
});

describe("paths", () => {
  it("never lets a glob match `.` or `..` segments", () => {
    const matches = (glob: string, text: string) => findGlobPaths(text, [splitGlob(glob)]);
    expect(matches("tasks/*.md", "tasks/..md")).toEqual(["tasks/..md"]);
    expect(matches("tasks/*/README.md", "tasks/../README.md")).toEqual([]);
    expect(matches("tasks/??/README.md", "tasks/../README.md")).toEqual([]);
    expect(matches("tasks/**/x.md", "tasks/../../x.md")).toEqual([]);
    expect(matches("tasks/**/x.md", "tasks/a/b/x.md")).toEqual(["tasks/a/b/x.md"]);
  });

  it("tells whether a path stays under a root", () => {
    expect(isInside("/root", "/root/a/b")).toBe(true);
    expect(isInside("/root", "/root/../etc")).toBe(false);
    expect(isInside("/root", "/rootish")).toBe(false);
  });

  it("refuses agent ids that would name a file outside the state folder", async () => {
    const state = tempDir();
    const store = new LinkStore(join(state, "state"));
    await expect(store.setMode("../../escaped", "all")).rejects.toThrow(/agent id/);
    expect(existsSync(join(state, "escaped.mode.json"))).toBe(false);
  });
});

describe("bad pins", () => {
  it("ignores a URL that does not parse instead of throwing", () => {
    expect(reportedLink("http://", "link", undefined, null)).toBeNull();
  });

  it("does not treat an arbitrary page pinned as `mr` as a merge request", () => {
    expect(reportedLink("https://example.test/page", "mr", undefined, null)?.kind).toBe("link");
  });

  it("asks no forge about a URL that is neither an MR nor a PR", () => {
    const forge = { cachedStatus: vi.fn() };
    const forges = new Forges(forge as unknown as GitLab, forge as unknown as GitHub);
    expect(forges.cachedStatus("https://example.test/page")).toBeUndefined();
    expect(forge.cachedStatus).not.toHaveBeenCalled();
  });

  it("has the MCP tool refuse a bad URL and a bad agent id", () => {
    const call = (agentId: string, target: string) => {
      const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pin_link", arguments: { target } } });
      const output = execFileSync(process.execPath, [MCP_SCRIPT], {
        input: `${request}\n`,
        env: { ...process.env, TRAIL_STATE_DIR: tempDir(), PASEO_AGENT_ID: agentId, ELECTRON_RUN_AS_NODE: "1" },
      });
      return JSON.parse(output.toString()).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(call("agent-1", "http://").isError).toBe(true);
    expect(call("../agent", "https://example.test").isError).toBe(true);
    expect(call("agent-1", "https://example.test").isError).toBeUndefined();
  });
});
