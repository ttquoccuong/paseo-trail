import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSvgIconProblem } from "@getpaseo/plugin";
import { ageOf, checklistEntries, DONE_ICON, itemDetails, taskPillLook, WAITING_ICON } from "../client/checklist";
import { scanTimeline } from "../server/scan";
import { LinkStore } from "../server/store";

const MCP_SCRIPT = join(__dirname, "..", "bin", "trail-mcp.mjs");
const CLI_SCRIPT = join(__dirname, "..", "bin", "trail-task.mjs");
const context = { rules: null, catalog: [], defaultHost: undefined };
const AGENT = "agent-a";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trail-test-"));
}

/** Calls one tool of the real MCP server; each call is a process of its own, as across a restart. */
function call(state: string, name: string, args: object): { text: string; isError: boolean } {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const output = execFileSync(process.execPath, [MCP_SCRIPT], {
    input: `${request}\n`,
    env: { ...process.env, TRAIL_STATE_DIR: state, PASEO_AGENT_ID: AGENT, ELECTRON_RUN_AS_NODE: "1" },
  }).toString();
  const result = JSON.parse(output).result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

function add(state: string, text: string, extra: object = {}) {
  return call(state, "add_checklist_item", { text, why: `needed for ${text}`, ...extra });
}

async function items(state: string) {
  return (await new LinkStore(state).task(AGENT)).items;
}

describe("a main task given only in chat", () => {
  it("becomes the session's task link", async () => {
    const state = tempDir();
    expect(call(state, "set_main_task", { title: "Checklist for the Task pill" }).isError).toBe(false);
    const [link] = await new LinkStore(state).links(AGENT, context);
    expect(link).toMatchObject({ kind: "task", label: "Checklist for the Task pill", url: "task:session" });
  });

  it("beats a task doc the scan merely guessed", async () => {
    const state = tempDir();
    const root = tempDir();
    const rules = { globs: [["tasks", "*.md"]], root, bundle: "none" as const };
    const store = new LinkStore(state);
    mkdirSync(join(root, "tasks"));
    writeFileSync(join(root, "tasks", "other.md"), "# Other");
    await store.saveScan(AGENT, scanTimeline([{ type: "tool_call", detail: { type: "edit", filePath: join(root, "tasks", "other.md") } }], rules));
    expect((await store.links(AGENT, { ...context, rules }))[0].title).toBe("tasks/other.md");
    call(state, "set_main_task", { title: "The real one" });
    const links = await store.links(AGENT, { ...context, rules });
    expect(links[0].label).toBe("The real one");
  });

  it("gives way to a pinned task doc or issue, and the checklist stays", async () => {
    const state = tempDir();
    call(state, "set_main_task", { title: "From chat" });
    add(state, "first");
    call(state, "pin_link", { target: "https://example.test/issues/7", kind: "task", label: "Issue 7", primary: true });
    const links = await new LinkStore(state).links(AGENT, context);
    expect(links.map((link) => link.label)).toEqual(["Issue 7"]);
    expect((await items(state)).map((item) => item.text)).toEqual(["first"]);
  });

  it("never reads its title as a file, even one naming a file under the docs root", async () => {
    const state = tempDir();
    const root = tempDir();
    writeFileSync(join(root, "private.md"), "https://gitlab.example.test/a/b/-/merge_requests/1");
    const rules = { globs: [["tasks", "*.md"]], root, bundle: "none" as const };
    call(state, "set_main_task", { title: "private.md" });
    const links = await new LinkStore(state).links(AGENT, { ...context, rules });
    expect(links).toHaveLength(1);
    expect(links[0].localPath).toBeUndefined();
  });

  it("puts the old list away when a different task starts, and keeps it in the file", async () => {
    const state = tempDir();
    call(state, "set_main_task", { title: "Old" });
    add(state, "first");
    expect(call(state, "set_main_task", { title: "New", new_task: true }).isError).toBe(false);
    expect(await new LinkStore(state).task(AGENT)).toEqual({ title: "New", items: [] });
    add(state, "second");
    const stored = JSON.parse(readFileSync(join(state, `${AGENT}.task.json`), "utf8"));
    expect(stored.previous).toMatchObject([{ title: "Old", items: [{ text: "first" }] }]);
    expect(stored.items.map((item: { text: string }) => item.text)).toEqual(["second"]);
  });

  it("keeps only the last few finished tasks", () => {
    const state = tempDir();
    for (let index = 0; index < 8; index += 1) call(state, "set_main_task", { title: `Task ${index}`, new_task: true });
    const stored = JSON.parse(readFileSync(join(state, `${AGENT}.task.json`), "utf8"));
    expect(stored.previous.map((task: { title: string }) => task.title)).toEqual(["Task 2", "Task 3", "Task 4", "Task 5", "Task 6"]);
  });

  it("keeps the items when the title changes", async () => {
    const state = tempDir();
    call(state, "set_main_task", { title: "Old" });
    add(state, "first");
    call(state, "set_main_task", { title: "New" });
    const task = await new LinkStore(state).task(AGENT);
    expect(task.title).toBe("New");
    expect(task.items.map((item) => item.text)).toEqual(["first"]);
  });
});

describe("what may join the checklist", () => {
  it("refuses an item without a reason it is needed", async () => {
    const state = tempDir();
    expect(call(state, "add_checklist_item", { text: "tidy up an unrelated file" }).isError).toBe(true);
    expect(call(state, "add_checklist_item", { text: "tidy up", why: "  " }).isError).toBe(true);
    expect(await items(state)).toEqual([]);
  });

  it("refuses the same open item twice", async () => {
    const state = tempDir();
    add(state, "write the store");
    expect(add(state, " Write the store ").isError).toBe(true);
    expect(await items(state)).toHaveLength(1);
  });

  it("refuses items past the cap, so the list stays a map and not a log", async () => {
    const state = tempDir();
    for (let index = 0; index < 30; index += 1) expect(add(state, `item ${index}`).isError).toBe(false);
    expect(add(state, "one too many").isError).toBe(true);
    expect(await items(state)).toHaveLength(30);
  });

  it("keeps the order of the work, inserting after a named item", async () => {
    const state = tempDir();
    add(state, "first");
    add(state, "third");
    const [first] = await items(state);
    add(state, "second", { after: first.id });
    expect((await items(state)).map((item) => item.text)).toEqual(["first", "second", "third"]);
  });

  it("refuses to insert after an item that does not exist", () => {
    const state = tempDir();
    expect(add(state, "second", { after: "nope" }).isError).toBe(true);
  });
});

describe("item status", () => {
  it("starts as todo and records the reason it was added", async () => {
    const state = tempDir();
    add(state, "first");
    expect(await items(state)).toMatchObject([{ text: "first", status: "todo", why: "needed for first" }]);
  });

  it("has one item in progress at a time; starting another returns the first to todo", async () => {
    const state = tempDir();
    add(state, "first");
    add(state, "second");
    const [first, second] = await items(state);
    call(state, "update_checklist_item", { id: first.id, status: "doing" });
    call(state, "update_checklist_item", { id: second.id, status: "doing" });
    expect((await items(state)).map((item) => item.status)).toEqual(["todo", "doing"]);
  });

  it("keeps a dropped item on the list, and refuses to drop one without saying why", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    expect(call(state, "update_checklist_item", { id: first.id, status: "dropped" }).isError).toBe(true);
    expect(call(state, "update_checklist_item", { id: first.id, status: "dropped", note: "@reviewer cut it" }).isError).toBe(false);
    expect(await items(state)).toMatchObject([{ status: "dropped", note: "@reviewer cut it" }]);
  });

  it("refuses to mark an item done without evidence", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    expect(call(state, "update_checklist_item", { id: first.id, status: "done" }).isError).toBe(true);
    expect(call(state, "update_checklist_item", { id: first.id, status: "done", note: "tests 24/24" }).isError).toBe(false);
    expect(await items(state)).toMatchObject([{ status: "done", note: "tests 24/24" }]);
  });

  it("refuses to mark an item waiting without saying on whom or what", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    expect(call(state, "update_checklist_item", { id: first.id, status: "waiting" }).isError).toBe(true);
    expect(call(state, "update_checklist_item", { id: first.id, status: "waiting", note: "@reviewer picks" }).isError).toBe(false);
    expect(await items(state)).toMatchObject([{ status: "waiting", note: "@reviewer picks" }]);
  });

  it("clears the old note when the status changes, so it cannot contradict the new one", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    call(state, "update_checklist_item", { id: first.id, status: "waiting", note: "waiting for CI" });
    call(state, "update_checklist_item", { id: first.id, status: "doing" });
    expect((await items(state))[0].note).toBeUndefined();
  });

  it("does not let the old note stand in for a new status's evidence", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    call(state, "update_checklist_item", { id: first.id, status: "waiting", note: "waiting for CI" });
    expect(call(state, "update_checklist_item", { id: first.id, status: "done" }).isError).toBe(true);
    expect(await items(state)).toMatchObject([{ status: "waiting", note: "waiting for CI" }]);
  });

  it("keeps the note when the status stays the same", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    call(state, "update_checklist_item", { id: first.id, status: "waiting", note: "@reviewer picks" });
    call(state, "update_checklist_item", { id: first.id, status: "waiting" });
    expect((await items(state))[0].note).toBe("@reviewer picks");
  });

  it("refuses an unknown id or status", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    expect(call(state, "update_checklist_item", { id: "nope", status: "done" }).isError).toBe(true);
    expect(call(state, "update_checklist_item", { id: first.id, status: "finished" }).isError).toBe(true);
  });

  it("answers every change with the whole list, so the agent re-reads where it is", () => {
    const state = tempDir();
    add(state, "first");
    const answer = add(state, "second").text;
    expect(answer).toContain("first");
    expect(answer).toContain("second");
  });
});

describe("the task file", () => {
  it("is empty when missing, cut short or edited into something else", async () => {
    const state = tempDir();
    const store = new LinkStore(state);
    expect(await store.task(AGENT)).toEqual({ items: [] });
    writeFileSync(join(state, `${AGENT}.task.json`), '{"title": "cut sho');
    expect(await store.task(AGENT)).toEqual({ items: [] });
    writeFileSync(join(state, `${AGENT}.task.json`), JSON.stringify({ title: 7, items: "many" }));
    expect((await store.task(AGENT)).items).toEqual([]);
    expect(await store.links(AGENT, context)).toEqual([]);
  });

  it("leaves out one broken item and keeps the others", async () => {
    const state = tempDir();
    writeFileSync(
      join(state, `${AGENT}.task.json`),
      JSON.stringify({ items: [{ id: "a", text: "ok", status: "todo", why: "w" }, { id: "b", status: "todo" }] }),
    );
    expect((await new LinkStore(state).task(AGENT)).items.map((item) => item.id)).toEqual(["a"]);
  });

  it("shows items that have no title under a task link, since they still need a pill", async () => {
    const state = tempDir();
    add(state, "first");
    const [link] = await new LinkStore(state).links(AGENT, context);
    expect(link).toMatchObject({ kind: "task", url: "task:session" });
  });
});

describe("the trail-task command", () => {
  function run(state: string, args: string[], agent: string | null = AGENT) {
    const { PASEO_AGENT_ID: _ignored, ...inherited } = process.env;
    const result = spawnSync(process.execPath, [CLI_SCRIPT, ...args], {
      env: { ...inherited, TRAIL_STATE_DIR: state, ELECTRON_RUN_AS_NODE: "1", ...(agent ? { PASEO_AGENT_ID: agent } : {}) },
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  }

  it("writes the same task file as the agent's tools", async () => {
    const state = tempDir();
    const result = run(state, ["set_main_task", '{"title":"From the shell"}']);
    expect(result).toMatchObject({ status: 0 });
    expect(result.out).toContain("From the shell");
    expect((await new LinkStore(state).task(AGENT)).title).toBe("From the shell");
  });

  it("fails with the tool's reason when the tool refuses", () => {
    const result = run(tempDir(), ["add_checklist_item", '{"text":"no reason"}']);
    expect(result.status).toBe(1);
    expect(result.err).toContain("why is required");
  });

  it("explains itself when the arguments are wrong, not with a stack trace", () => {
    const state = tempDir();
    const usage = run(state, []);
    expect(usage.status).toBe(2);
    expect(usage.err).toContain("set_main_task");
    const badJson = run(state, ["set_main_task", "{title"]);
    expect(badJson.status).toBe(2);
    expect(badJson.err).toContain("JSON");
    const unknown = run(state, ["delete_everything", "{}"]);
    expect(unknown.status).toBe(2);
    expect(unknown.err).toContain("delete_everything");
  });

  it("refuses outside a Paseo agent", () => {
    const result = run(tempDir(), ["set_main_task", '{"title":"x"}'], null);
    expect(result.status).toBe(1);
    expect(result.err).toContain("PASEO_AGENT_ID");
  });
});

describe("the task button", () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;
  const item = (status: "todo" | "doing" | "waiting" | "done" | "dropped") => ({ id: status, text: status, why: "w", status });

  it("stays as it was without a checklist", () => {
    expect(taskPillLook("Name", [], t)).toEqual({ label: 'task.label{"name":"Name"}', icon: "FileText" });
  });

  it("puts progress before the name, since the bar cuts long labels short", () => {
    const { label } = taskPillLook("Name", [item("done"), item("doing"), item("dropped")], t);
    expect(label).toBe('task.labelProgress{"done":1,"total":2,"name":"Name"}');
  });

  it("changes its icon when an item is waiting, so a waiting session stands out", () => {
    expect(taskPillLook("Name", [item("done"), item("doing")], t).icon).toBe("FileText");
    expect(taskPillLook("Name", [item("done"), item("waiting")], t).icon).toBe(WAITING_ICON);
  });
});

describe("the checklist in the task menu", () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;
  const item = (id: string, status: "todo" | "doing" | "waiting" | "done" | "dropped", note?: string) => ({
    id,
    text: `text ${id}`,
    why: `why ${id}`,
    status,
    ...(note ? { note } : {}),
  });
  const NOW = Date.parse("2026-01-01T12:00:00Z");
  // Stands in for the popover component, which needs React Native to render.
  const Details = () => null;
  const details = () => Details;

  it("is nothing at all without items, so a session without a list keeps today's menu", () => {
    expect(checklistEntries([], t, details, NOW)).toEqual([]);
  });

  it("opens with progress, lists items in order with a status icon, and ends with a separator", () => {
    const entries = checklistEntries([item("a", "done"), item("b", "doing"), item("c", "todo"), item("d", "dropped", "cut")], t, details, NOW);
    expect(entries[0]).toMatchObject({ kind: "item", disabled: true, title: 'checklist.progress{"done":1,"total":3}' });
    const rows = entries.slice(1, -1).map((entry) => (entry.kind === "item" ? [entry.title, entry.icon] : null));
    expect(rows).toEqual([
      ["text a", DONE_ICON],
      ["text b", "CircleDot"],
      ["text c", "Circle"],
      ["text d", "CircleX"],
    ]);
    expect(entries[entries.length - 1].kind).toBe("separator");
  });

  it("draws done and waiting items in their own colors, with icons Paseo accepts", () => {
    const strokes = [DONE_ICON, WAITING_ICON].map(({ svg }) => {
      expect(svg).not.toContain("currentColor");
      expect(findSvgIconProblem(svg)).toBeNull();
      return /stroke="(#[0-9a-f]{6})"/i.exec(svg)?.[1];
    });
    expect(strokes[0]).toBeDefined();
    expect(strokes[1]).toBeDefined();
    expect(strokes[0]).not.toBe(strokes[1]);
  });

  it("lists a waiting item with its icon and counts it as still open", () => {
    const entries = checklistEntries([item("a", "done"), item("b", "waiting", "@reviewer")], t, details, NOW);
    expect(entries[0]).toMatchObject({ title: 'checklist.progress{"done":1,"total":2}' });
    expect(entries[2]).toMatchObject({ title: "text b — @reviewer", icon: WAITING_ICON });
  });

  it("opens an item's reason and note in a popover, where a long note wraps instead of widening the menu", () => {
    const entries = checklistEntries([item("d", "dropped", "cut")], t, details, NOW);
    const row = entries[1];
    if (row.kind !== "item" || row.behavior.kind !== "popover") throw new Error("expected a popover");
    expect(row.behavior.Content).toBe(Details);
    expect(itemDetails(item("d", "dropped", "cut"), t, NOW)).toEqual(['checklist.why{"text":"why d"}', 'checklist.note{"text":"cut"}']);
    expect(itemDetails(item("e", "todo"), t, NOW)).toEqual(['checklist.why{"text":"why e"}']);
  });
});

describe("declaring the main task", () => {
  const EMPTY = "The checklist is empty";

  it("reminds the agent to list what the task needs when it pins the task", () => {
    const state = tempDir();
    const text = call(state, "pin_link", { target: "https://example.test/issues/7", kind: "task", primary: true }).text;
    expect(text).toContain(EMPTY);
    // Worded as an order for the next step, with the rule for which tasks need a list.
    expect(text).toContain("Before your next tool call");
    expect(text).toContain("Every task that changes files needs a list");
  });

  it("reminds it when it names the task, until the list has an item", () => {
    const state = tempDir();
    expect(call(state, "set_main_task", { title: "From chat" }).text).toContain(EMPTY);
    add(state, "first");
    expect(call(state, "set_main_task", { title: "Renamed" }).text).not.toContain(EMPTY);
    expect(call(state, "pin_link", { target: "https://example.test/issues/8", kind: "task", primary: true }).text).not.toContain(EMPTY);
  });

  it("says nothing about the checklist when other links are pinned", () => {
    const state = tempDir();
    expect(call(state, "pin_link", { target: "https://example.test/page", kind: "link" }).text).toBe("Pinned https://example.test/page.");
  });
});

describe("how fresh an item is", () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;
  const NOW = Date.parse("2026-01-01T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
  const details = () => () => null;
  const row = (item: object) => {
    const entries = checklistEntries([{ id: "a", text: "Submit the build", why: "w", status: "todo", ...item }], t, details, NOW);
    return entries[1].kind === "item" ? entries[1].title : "";
  };

  it("shows on a waiting item's row what it waits on, cut to fit", () => {
    expect(row({ status: "waiting", note: "store review", updatedAt: hoursAgo(1) })).toBe("Submit the build — store review");
    expect(row({ status: "waiting", note: "x".repeat(80), updatedAt: hoursAgo(1) })).toBe(`Submit the build — ${"x".repeat(39)}…`);
  });

  it("adds the age of a waiting or in-progress item that has stood still for hours, and only then", () => {
    expect(row({ status: "waiting", note: "store review", updatedAt: hoursAgo(5) })).toBe("Submit the build — store review · 5h");
    expect(row({ status: "doing", updatedAt: hoursAgo(50) })).toBe("Submit the build · 2d");
    expect(row({ status: "doing", updatedAt: hoursAgo(1) })).toBe("Submit the build");
    expect(row({ status: "done", note: "ok", updatedAt: hoursAgo(50) })).toBe("Submit the build");
    // A list written before items kept a time has nothing to show.
    expect(row({ status: "doing" })).toBe("Submit the build");
  });

  it("says in the popover when the item last changed", () => {
    const lines = itemDetails({ id: "a", text: "x", why: "w", status: "waiting", note: "n", updatedAt: hoursAgo(3) }, t, NOW);
    expect(lines[lines.length - 1]).toBe('checklist.updated{"age":"3h"}');
    expect(ageOf(undefined, NOW)).toBeUndefined();
    expect(ageOf(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m");
  });

  it("is recorded by the agent's tools and read back by the daemon", async () => {
    const state = tempDir();
    add(state, "first");
    const [first] = await items(state);
    expect(Date.parse(first.updatedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("tells the agent how long its items have waited, and to check the old ones", () => {
    const state = tempDir();
    writeFileSync(
      join(state, `${AGENT}.task.json`),
      JSON.stringify({ title: "T", items: [{ id: "a", text: "Store review", why: "w", status: "waiting", note: "Apple", updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }] }),
    );
    const text = call(state, "set_main_task", { title: "T" }).text;
    expect(text).toContain("[waiting 5h] a: Store review");
    expect(text).toContain("check whether what they wait on has happened");
    call(state, "update_checklist_item", { id: "a", status: "waiting", note: "Apple, asked again" });
    expect(call(state, "set_main_task", { title: "T" }).text).not.toContain("check whether");
  });
});
