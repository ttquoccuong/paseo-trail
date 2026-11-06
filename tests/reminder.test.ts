import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = join(__dirname, "..", "bin", "trail-reminder.mjs");
const AGENT = "agent-a";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

/** Runs the hook as Claude Code would before a user message; the context it adds, or "" for none. */
function remind(state: string, agentId: string | undefined = AGENT): string {
  // This test may itself run inside a Paseo agent; its id must not leak into the hook.
  const { PASEO_AGENT_ID: _own, ...inherited } = process.env;
  const env = { ...inherited, TRAIL_STATE_DIR: state, ELECTRON_RUN_AS_NODE: "1" };
  const output = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "go on" }),
    env: agentId === undefined ? env : { ...env, PASEO_AGENT_ID: agentId },
  }).toString();
  return output === "" ? "" : JSON.parse(output).hookSpecificOutput.additionalContext;
}

function writeTask(state: string, task: object) {
  writeFileSync(join(state, `${AGENT}.task.json`), JSON.stringify(task));
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe("the reminder before each user message", () => {
  it("is silent outside a Paseo agent and in a session without a main task", () => {
    const state = tempDir();
    expect(remind(state, undefined)).toBe("");
    expect(remind(state)).toBe("");
    expect(remind(state, "../escape")).toBe("");
  });

  it("asks for a checklist when the task has none, whether it was named or pinned", () => {
    const named = tempDir();
    writeTask(named, { title: "Release", items: [] });
    expect(remind(named)).toContain('the main task "Release" has no checklist yet');
    expect(remind(named)).toContain("Before your next tool call");
    const pinned = tempDir();
    writeFileSync(join(pinned, `${AGENT}.reported.json`), JSON.stringify([{ target: "tasks/a.md", kind: "task", primary: true, label: "Task A", at: hoursAgo(1) }]));
    expect(remind(pinned)).toContain('"Task A" has no checklist yet');
  });

  it("forgets a pin the user removed", () => {
    const state = tempDir();
    writeFileSync(join(state, `${AGENT}.reported.json`), JSON.stringify([{ target: "tasks/a.md", kind: "task", at: hoursAgo(2) }]));
    writeFileSync(join(state, `${AGENT}.pins.json`), JSON.stringify([{ target: "tasks/a.md", removed: true, at: hoursAgo(1) }]));
    expect(remind(state)).toBe("");
  });

  it("sums up progress, the item in progress and how long items have waited", () => {
    const state = tempDir();
    writeTask(state, {
      title: "Release",
      items: [
        { id: "a", text: "Cut the branch", why: "w", status: "done", note: "ok" },
        { id: "b", text: "Merge the hotfix", why: "w", status: "doing" },
        { id: "c", text: "Store review", why: "w", status: "waiting", note: "Apple", updatedAt: hoursAgo(5) },
        { id: "d", text: "Old idea", why: "w", status: "dropped", note: "cut" },
      ],
    });
    const text = remind(state);
    expect(text).toContain('Trail checklist for "Release": 1/3 done; doing: Merge the hotfix; waiting: Store review (5h)');
    expect(text).toContain("update the list");
  });

  it("stays quiet once every item is finished", () => {
    const state = tempDir();
    writeTask(state, { title: "Release", items: [{ id: "a", text: "x", why: "w", status: "done", note: "ok" }] });
    expect(remind(state)).toBe("");
  });

  it("reads a broken state file as nothing instead of failing the user's message", () => {
    const state = tempDir();
    writeFileSync(join(state, `${AGENT}.task.json`), "{not json");
    expect(remind(state)).toBe("");
  });
});
