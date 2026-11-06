import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateEntries, guessedTaskLook } from "../client/candidates";
import type { Translate } from "../client/i18n";
import type { TaskDocRules } from "../server/extract";
import { emptyScan, mergeScans, scanTimeline, type ScanState, type TimelineItemLike } from "../server/scan";
import { LinkStore } from "../server/store";
import { rankTasks } from "../server/task-evidence";

const AGENT = "agent-a";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

/** A docs root holding `docs`, with rules for both single-file and folder task docs. */
function project(docs: string[]): TaskDocRules {
  const root = tempDir();
  for (const doc of docs) {
    mkdirSync(dirname(join(root, doc)), { recursive: true });
    writeFileSync(join(root, doc), `# ${doc}\n`);
  }
  return { globs: [["tasks", "*.md"], ["tasks", "*", "README.md"]], root, bundle: "none" };
}

// Every user message gets its own time, as Paseo's timeline entries do.
let clock = Date.parse("2026-01-01T00:00:00Z");
const user = (text: string): TimelineItemLike => ({ type: "user_message", text, timestamp: new Date((clock += 1000)).toISOString() });
const reply = (text: string): TimelineItemLike => ({ type: "assistant_message", text });
const edit = (rules: TaskDocRules, doc: string): TimelineItemLike => ({ type: "tool_call", detail: { type: "edit", filePath: join(rules.root, doc) } });
const read = (rules: TaskDocRules, doc: string): TimelineItemLike => ({ type: "tool_call", detail: { type: "read", filePath: join(rules.root, doc) } });

/** Scans `timeline` once, from its first message, as a session's first scan does. */
function scanOnce(timeline: TimelineItemLike[], rules: TaskDocRules): ScanState {
  return mergeScans(emptyScan(), scanTimeline(timeline, rules, { fromStart: true }));
}

const ranked = (scan: ScanState) => rankTasks(scan.tasks).map(({ doc }) => doc);

async function mainTask(state: string, rules: TaskDocRules) {
  return (await new LinkStore(state).links(AGENT, { rules, catalog: [], defaultHost: undefined })).find((link) => link.kind === "task");
}

describe("guessing the main task", () => {
  it("is not taken over by a pasted message that lists many docs", () => {
    const rules = project([]);
    const scan = scanOnce(
      [
        user("Please finish tasks/login/README.md"),
        edit(rules, "tasks/login/README.md"),
        user("go on"),
        edit(rules, "tasks/login/README.md"),
        // A chat screen pasted for context, naming five other tasks.
        user("Release notes: tasks/a.md tasks/b.md tasks/c.md tasks/d.md tasks/e.md"),
        reply("Noted; back to tasks/login/README.md"),
      ],
      rules,
    );
    expect(ranked(scan)[0]).toBe("tasks/login/README.md");
    // Five docs share one message's points, so none of them alone is enough to be the task.
    expect(ranked(scan)).toEqual(["tasks/login/README.md"]);
  });

  it("follows the session when it moves on to another task", () => {
    const rules = project([]);
    const before = [user("Work on tasks/first.md"), ...Array.from({ length: 5 }, () => [user("next"), edit(rules, "tasks/first.md")]).flat()];
    const after = [user("Now switch to tasks/second.md"), ...Array.from({ length: 8 }, () => [user("next"), edit(rules, "tasks/second.md")]).flat()];
    expect(ranked(scanOnce(before, rules))[0]).toBe("tasks/first.md");
    expect(ranked(scanOnce([...before, ...after], rules))[0]).toBe("tasks/second.md");
  });

  it("anchors the task named in the session's first message", () => {
    const rules = project([]);
    const timeline = [user("Task: tasks/main.md"), user("By the way, what about tasks/aside.md?")];
    expect(ranked(scanOnce(timeline, rules))[0]).toBe("tasks/main.md");
    // A window that does not reach the session's start cannot tell which message opened it.
    const midSession = mergeScans(emptyScan(), scanTimeline(timeline, rules, { fromStart: false }));
    expect(ranked(midSession)[0]).toBe("tasks/aside.md");
  });

  it("gives a tie to the doc seen most recently", () => {
    const rules = project([]);
    const scan = scanOnce([user("hi"), edit(rules, "tasks/older.md"), edit(rules, "tasks/newer.md")], rules);
    expect(ranked(scan)).toEqual(["tasks/newer.md", "tasks/older.md"]);
  });

  it("never makes a doc the task from reads and passing mentions alone", () => {
    const rules = project([]);
    const turns = Array.from({ length: 6 }, () => [user("look around"), read(rules, "tasks/x.md"), reply("tasks/x.md says so")]).flat();
    expect(ranked(scanOnce(turns, rules))).toEqual([]);
  });

  it("counts a single-file doc and the folder it grew into as one task, in the spelling that exists", async () => {
    const rules = project(["tasks/grown/README.md", "tasks/steady.md"]);
    const timeline = [
      user("start"),
      edit(rules, "tasks/grown.md"),
      edit(rules, "tasks/steady.md"),
      user("next"),
      edit(rules, "tasks/grown.md"),
      edit(rules, "tasks/steady.md"),
      user("moved the doc into a folder"),
      edit(rules, "tasks/grown/README.md"),
    ];
    const state = tempDir();
    await new LinkStore(state).saveScan(AGENT, scanTimeline(timeline, rules, { fromStart: true }));
    expect(await mainTask(state, rules)).toMatchObject({ title: "tasks/grown/README.md", localPath: join(rules.root, "tasks/grown/README.md") });
  });

  it("drops a doc whose file is gone", async () => {
    const rules = project(["tasks/kept.md"]);
    const state = tempDir();
    const timeline = [user("go"), edit(rules, "tasks/kept.md"), user("go"), edit(rules, "tasks/deleted.md"), edit(rules, "tasks/deleted.md")];
    await new LinkStore(state).saveScan(AGENT, scanTimeline(timeline, rules, { fromStart: true }));
    expect((await mainTask(state, rules))?.title).toBe("tasks/kept.md");
  });
});

describe("scans that read the same messages again", () => {
  const rules = project([]);
  const timeline = [
    reply("Session starts"),
    user("Do tasks/one.md"),
    edit(rules, "tasks/one.md"),
    read(rules, "tasks/two.md"),
    reply("Editing tasks/one.md"),
    user("And tasks/two.md"),
    edit(rules, "tasks/two.md"),
    edit(rules, "tasks/two.md"),
    reply("tasks/two.md done"),
    user("Back to tasks/one.md"),
    edit(rules, "tasks/one.md"),
    user("thanks"),
  ];

  it("count each message once, however the windows overlap", () => {
    const once = scanOnce(timeline, rules);
    // Tail windows that overlap and start anywhere, mid-turn included, as successive scans do.
    let repeated = emptyScan();
    for (const [start, end] of [[0, 4], [1, 7], [3, 9], [5, 12], [6, 12], [0, 12]]) {
      repeated = mergeScans(repeated, scanTimeline(timeline.slice(start, end), rules, { fromStart: start === 0 }));
    }
    expect(repeated.tasks).toEqual(once.tasks);
  });

  it("tell two user messages with the same text apart by their time", () => {
    const scan = scanOnce([user("go on"), user("go on")], rules);
    expect(scan.tasks.turn).toBe(2);
  });
});

describe("scan state written by an older version", () => {
  const write = (weights: Record<string, number>) => {
    const state = tempDir();
    writeFileSync(join(state, `${AGENT}.scanned.json`), JSON.stringify({ tasks: weights, mergeRequests: [] }));
    return state;
  };

  it("reads its weights as evidence, the most recently seen doc winning a tie", async () => {
    const rules = project(["tasks/a.md", "tasks/b.md", "tasks/c.md"]);
    expect((await mainTask(write({ "tasks/a.md": 5, "tasks/c.md": 5, "tasks/b.md": 5 }), rules))?.title).toBe("tasks/b.md");
  });

  it("adds up the spellings of one doc and ignores weak evidence", async () => {
    const rules = project(["tasks/real/README.md", "tasks/other.md", "tasks/read.md"]);
    const state = write({ "tasks/real.md": 5, "tasks/other.md": 5, "tasks/real/README.md": 4, "tasks/read.md": 1 });
    expect((await mainTask(state, rules))?.title).toBe("tasks/real/README.md");
    expect(rankTasks((await readScanned(state)).tasks).map(({ doc }) => doc)).not.toContain("tasks/read.md");
  });

  it("gives way to new evidence", async () => {
    const rules = project(["tasks/old.md", "tasks/new.md"]);
    const state = write({ "tasks/old.md": 5 });
    const turns = Array.from({ length: 3 }, () => [user("next"), edit(rules, "tasks/new.md")]).flat();
    await new LinkStore(state).saveScan(AGENT, scanTimeline(turns, rules));
    expect((await mainTask(state, rules))?.title).toBe("tasks/new.md");
  });
});

async function readScanned(state: string): Promise<ScanState> {
  const store = new LinkStore(state);
  // Saving nothing new returns what was read, with the current caps applied.
  await store.saveScan(AGENT, { sightings: [], fromStart: false, mergeRequests: [] });
  return JSON.parse(readFileSync(join(state, `${AGENT}.scanned.json`), "utf8")) as ScanState;
}

describe("an unsure guess", () => {
  const t: Translate = (key, values) => `${key}${values ? JSON.stringify(values) : ""}`;

  it("offers the close docs when the runner-up scores at least 60% of the guess", async () => {
    const rules = project(["tasks/one.md", "tasks/two.md", "tasks/far.md"]);
    const state = tempDir();
    // One edit each; a mention puts `one` ahead, `two` stays within 60% of it, `far` was only read.
    const timeline = [user("go"), edit(rules, "tasks/one.md"), edit(rules, "tasks/two.md"), read(rules, "tasks/far.md"), reply("tasks/one.md first")];
    await new LinkStore(state).saveScan(AGENT, scanTimeline(timeline, rules));
    const task = await mainTask(state, rules);
    expect(task?.title).toBe("tasks/one.md");
    expect(task?.candidates?.map(({ target }) => target)).toEqual(["tasks/one.md", "tasks/two.md"]);
  });

  it("offers nothing when the guess is clear", async () => {
    const rules = project(["tasks/one.md", "tasks/two.md"]);
    const state = tempDir();
    const timeline = [user("Do tasks/one.md"), edit(rules, "tasks/one.md"), edit(rules, "tasks/two.md")];
    await new LinkStore(state).saveScan(AGENT, scanTimeline(timeline, rules, { fromStart: true }));
    expect((await mainTask(state, rules))?.candidates).toBeUndefined();
  });

  it("is settled by picking a doc, which then wins over any guess", async () => {
    const rules = project(["tasks/one.md", "tasks/two.md"]);
    const state = tempDir();
    const store = new LinkStore(state);
    await store.saveScan(AGENT, scanTimeline([user("go"), edit(rules, "tasks/one.md"), edit(rules, "tasks/two.md")], rules));
    expect((await mainTask(state, rules))?.candidates).toHaveLength(2);
    // What the menu's pick sends: the same pin as the links.pin RPC makes for a task doc.
    await store.pin(AGENT, { target: "tasks/one.md", kind: "task", primary: true }, "tasks/one.md");
    const task = await mainTask(state, rules);
    expect(task?.title).toBe("tasks/one.md");
    expect(task?.candidates).toBeUndefined();
  });

  it("shows a question mark and one row per candidate, the guess marked", () => {
    const link = {
      url: "file:///r/tasks/one.md",
      kind: "task" as const,
      label: "one",
      title: "tasks/one.md",
      candidates: [
        { target: "tasks/one.md", label: "one", title: "tasks/one.md" },
        { target: "tasks/two.md", label: "two", title: "tasks/two.md" },
      ],
    };
    expect(guessedTaskLook("one", t).label).toBe('task.labelGuess{"name":"one"}');
    const picked: string[] = [];
    const entries = candidateEntries(link, t, (target) => picked.push(target));
    const rows = entries.filter((entry) => entry.kind === "item" && entry.id.startsWith("candidate-"));
    expect(rows.map((row) => row.kind === "item" && [row.title, row.icon])).toEqual([
      ['task.setMain{"name":"one"}', "CircleDot"],
      ['task.setMain{"name":"two"}', "Circle"],
    ]);
    const second = rows[1];
    if (second.kind === "item" && second.behavior.kind === "action") void second.behavior.onPress();
    expect(picked).toEqual(["tasks/two.md"]);
    expect(candidateEntries({ ...link, candidates: undefined }, t, () => undefined)).toEqual([]);
  });
});

describe("the agent's instructions", () => {
  // One initialize and one tools/list against the real MCP server.
  const [init, list] = execFileSync(process.execPath, [join(__dirname, "..", "bin", "trail-mcp.mjs")], {
    input: ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', ""].join("\n"),
    env: { ...process.env, TRAIL_STATE_DIR: tempDir(), PASEO_AGENT_ID: AGENT, ELECTRON_RUN_AS_NODE: "1" },
  })
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).result);
  const instructions: string = init.instructions;

  it("say how to load deferred tools, naming every tool the server has", () => {
    const names: string[] = list.tools.map((tool: { name: string }) => tool.name);
    const loaded = /select:(\S+?)`/.exec(instructions)?.[1].split(",");
    // The daemon attaches the server as `trail`, which is how clients prefix its tools.
    expect(loaded?.sort()).toEqual(names.map((name) => `mcp__trail__${name}`).sort());
  });

  it("ask clients to list every tool up front instead of deferring it", () => {
    expect(list.tools.map((tool: { _meta?: Record<string, unknown> }) => tool._meta?.["anthropic/alwaysLoad"])).toEqual([true, true, true, true]);
  });

  it("ask for notes short enough to read at a glance", () => {
    const update = list.tools.find((tool: { name: string }) => tool.name === "update_checklist_item");
    expect(update.inputSchema.properties.note.description).toContain("one short line");
  });

  it("put the task first, before the rules for writing requests", () => {
    const at = (text: string) => instructions.indexOf(text);
    expect(at("deferred")).toBeGreaterThanOrEqual(0);
    expect(at("deferred")).toBeLessThan(at("call pin_link for it"));
    expect(at("call pin_link for it")).toBeLessThan(at("call set_main_task"));
    expect(at("call set_main_task")).toBeLessThan(at("When you mention a merge request"));
  });
});
