import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Credentials, fetchWithToken, gitLabCredentialId, GITHUB_CREDENTIAL_ID } from "../server/credentials";
import { findChangeRequests, taskDocRules } from "../server/extract";
import { GitLab } from "../server/gitlab";
import { findMergeRequestRefs, resolveMentions } from "../server/mr-refs";
import { findUrls } from "../server/scan";
import { LinkStore } from "../server/store";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

async function timed<T>(run: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bundles of pinned tasks that all link to one huge folder", () => {
  // A folder of 500 subfolders with 100 empty files each, and ten task folders linking to it.
  const project = tempDir();
  const pins: Array<{ target: string; kind: "task"; at: string }> = [];

  beforeAll(() => {
    const big = join(project, "big");
    mkdirSync(big);
    writeFileSync(join(big, "README.md"), "# Big");
    for (let folder = 0; folder < 500; folder += 1) {
      mkdirSync(join(big, `d${folder}`));
      for (let file = 0; file < 100; file += 1) writeFileSync(join(big, `d${folder}`, `f${file}.md`), "");
    }
    mkdirSync(join(project, "tasks"));
    for (let task = 0; task < 10; task += 1) {
      symlinkSync(big, join(project, "tasks", `t${task}`));
      pins.push({ target: `tasks/t${task}/README.md`, kind: "task", at: String(task) });
    }
  }, 120_000);

  it("are listed within a poll budget of 50 ms", async () => {
    const rules = taskDocRules(
      {
        file: join(project, ".paseo/trail/config.json"),
        projectRoot: project,
        personal: false,
        config: { focus: { root: ".", taskDocs: ["tasks/*/README.md"], bundle: "siblings" }, gitlab: [] },
      },
      null,
    );
    const state = tempDir();
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify(pins));
    const store = new LinkStore(state);
    const context = { rules, catalog: [], defaultHost: undefined };
    const first = await timed(() => store.links("agent-a", context));
    expect(first.ms).toBeLessThan(50);
    const tasks = first.value.filter((link) => link.kind === "task");
    expect(tasks).toHaveLength(10);
    // Only the main task may list a bundle, and that list stays small. Here the folder's first 200
    // entries are all subfolders, so the budget ends before any file is found and the list is empty.
    expect(tasks.filter((link) => link.bundle !== undefined).length).toBeLessThanOrEqual(1);
    expect(tasks[0].bundle?.length ?? 0).toBeLessThanOrEqual(20);
    const again = await timed(() => store.links("agent-a", context));
    expect(again.ms).toBeLessThan(50);
  });
});

describe("references", () => {
  it("drop a declared name shared by two projects instead of matching a last segment", () => {
    const catalog = [
      { name: "api", project: "a/api", host: "h1.example.test" },
      { name: "api", project: "b/web", host: "h2.example.test" },
    ];
    expect(resolveMentions(["api!5"], [], catalog, undefined)).toEqual([]);
  });

  it("take GitHub owners without dots and repositories that are not document files", () => {
    expect(findMergeRequestRefs("see docs/README.md#12")).toEqual([]);
    expect(findMergeRequestRefs("see my.org/repo#1")).toEqual([]);
    expect(findMergeRequestRefs("see vercel/next.js#1")).toEqual(["vercel/next.js#1"]);
    expect(findChangeRequests("https://github.com/my.org/repo/pull/1")).toEqual([]);
  });
});

describe("request slots", () => {
  it("count the wait for a slot in the time limit", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      ),
    );
    const busy = Array.from({ length: 4 }, () => fetchWithToken("https://gitlab.example.test/api/v4/x", {}).catch(() => "done"));
    const waiting = fetchWithToken("https://gitlab.example.test/api/v4/y", {});
    const outcome = expect(waiting).rejects.toThrow(/request slot|aborted/);
    await vi.advanceTimersByTimeAsync(15_001);
    await outcome;
    await Promise.all(busy);
  });

  it("keep token checks moving while status requests are stuck", async () => {
    const release: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("/stuck")
          ? new Promise<Response>((resolve) => release.push(() => resolve(new Response("{}", { status: 200 }))))
          : Promise.resolve(new Response(JSON.stringify({ scopes: ["api"] }), { status: 200 })),
      ),
    );
    const stuck = Array.from({ length: 4 }, () => fetchWithToken("https://gitlab.example.test/stuck", {}).catch(() => "done"));
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined);
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    const { value, ms } = await timed(() => credentials.statuses());
    expect(value[0].state).toBe("ok");
    expect(ms).toBeLessThan(1000);
    // Free the status slots for the tests after this one.
    for (const free of release) free();
    await Promise.all(stuck);
  });
});

describe("credentials", () => {
  it("keep their last check when only the reason a host is known changes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scopes: ["api"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const credentials = new Credentials(tempDir());
    credentials.requireGitLab("gitlab.example.test", undefined, { kind: "project", file: "/repo/.paseo/trail/config.json" });
    await credentials.store(gitLabCredentialId("gitlab.example.test"), "glpat-sample");
    await credentials.statuses();
    credentials.requireGitLab("gitlab.example.test", undefined, { kind: "link" });
    const [status] = await credentials.statuses();
    credentials.requireGitLab("gitlab.example.test", undefined, { kind: "project", file: "/repo/.paseo/trail/config.json" });
    await credentials.statuses();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.origin).toEqual({ kind: "link" });
  });

  it("replace a symlink at the token's name instead of writing through it", async () => {
    const secrets = tempDir();
    const elsewhere = join(tempDir(), "elsewhere");
    writeFileSync(elsewhere, "keep me");
    const credentials = new Credentials(secrets);
    credentials.requireGitHub();
    const tokenFile = join(secrets, `${Buffer.from(GITHUB_CREDENTIAL_ID).toString("base64url")}.token`);
    symlinkSync(elsewhere, tokenFile);
    await credentials.store(GITHUB_CREDENTIAL_ID, "ghp_sample");
    expect(readFileSync(elsewhere, "utf8")).toBe("keep me");
    expect(lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe("state", () => {
  it("is kept in a folder only the daemon's user can read", async () => {
    const state = join(tempDir(), "state");
    await new LinkStore(state).setMode("agent-a", "all");
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });

  it("reads only a bounded pin file, and only its newest pins", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    writeFileSync(join(state, "agent-a.reported.json"), JSON.stringify([{ target: "https://example.test/x", pad: "x".repeat(1100 * 1024) }]));
    expect(await store.pins("agent-a")).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => ({ target: `https://example.test/${i}`, at: String(i).padStart(3, "0") }));
    writeFileSync(join(state, "agent-b.reported.json"), JSON.stringify(many));
    const pins = await store.pins("agent-b");
    expect(pins).toHaveLength(50);
    expect(pins[0].target).toBe("https://example.test/30");
  });

  it("keeps links without the user name and password they were written with", async () => {
    expect(findUrls("see https://me:secret@example.test/page")).toEqual(["https://example.test/page"]);
    const store = new LinkStore(tempDir());
    await store.pin("agent-a", { target: "https://me:secret@example.test/a", kind: "link" }, "https://me:secret@example.test/a");
    expect((await store.pins("agent-a")).map((pin) => pin.target)).toEqual(["https://example.test/a"]);
    expect(await store.unpin("agent-a", "https://me:secret@example.test/a")).toBe(true);
  });
});

describe("forge settings", () => {
  it("are read again after ten minutes", async () => {
    let offset = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      "personal_access_tokens/self": { scopes: ["api"] },
      "projects/a%2Fb/merge_requests/3": { state: "opened", source_branch: "x", target_branch: "main", sha: "abc" },
      "projects/a%2Fb/merge_requests/3/approvals": { approved: false, approved_by: [] },
      "projects/a%2Fb": { squash_option: "default_off" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("/api/v4/")[1].split("?")[0];
        calls.push(path);
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
    offset = 11 * 60_000;
    gitlab.cachedStatus(url);
    await vi.waitFor(() => expect(calls.filter((path) => path === "projects/a%2Fb")).toHaveLength(2));
    gitlab.dispose();
    vi.restoreAllMocks();
  });
});
