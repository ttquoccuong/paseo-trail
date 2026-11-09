#!/usr/bin/env node
// Stdio MCP server that the Trail plugin attaches to new agents. It only records what
// the agent reports into <state>/<agentId>.reported.json; the plugin daemon turns that into
// composer pills. Kept dependency-free so it runs straight from the plugin checkout.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { age } from "./age.mjs";

const TOOL = "pin_link";
// Pins beyond this many push out the oldest; the daemon applies the same cap.
const MAX_PINS = 50;
const MAX_TARGET_LENGTH = 2048;
const MAX_LABEL_LENGTH = 200;
// Fifty pins of 2,048 characters, even in four-byte characters, stay under this.
const MAX_PIN_FILE_BYTES = 1024 * 1024;
const KINDS = ["task", "mr", "link"];
// Paseo agent ids are UUIDs; the id names the state file, so nothing else is accepted.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const stateDir = process.env.TRAIL_STATE_DIR;

// Clients put server instructions in the agent's system prompt and may cut a long one short, so
// what the session's task needs comes first. Some clients also defer MCP tools until searched for,
// which the agent has to be told, or it never calls them. Tool names there follow the server key
// the daemon attaches this script under (`trail`). Trail finds MRs and PRs in the conversation; a
// bare `!N` or a number away from its project name cannot be traced to a project.
const INSTRUCTIONS =
  "Trail's tools (pin_link, set_main_task, add_checklist_item, update_checklist_item) may be listed as " +
  "deferred, with only their names known. Load all four before the first call; in Claude Code: ToolSearch " +
  "`select:mcp__trail__pin_link,mcp__trail__set_main_task,mcp__trail__add_checklist_item,mcp__trail__update_checklist_item`. " +
  "As soon as the user's first message, or a later one that moves the session to other work, names " +
  "exactly one task doc, issue or task ID as the work to do, call pin_link for it (kind=task, " +
  "primary=true) before anything else. Otherwise the link bar guesses the task from the conversation, " +
  "and a doc that was only quoted or pasted along the way can win. Pinning names the task; it does not " +
  "make its checklist, which comes right after, as below. " +
  "Keep one checklist for the session's main task, so that whoever opens it can always tell what this " +
  "session is for, what is done and what is left. When the user gives the main task, pin it, or call " +
  "set_main_task when it was given in chat with no doc; either way, add_checklist_item for each thing it " +
  "needs, in working order, before you start changing files. Every main task that changes files gets a " +
  "list, however short; only questions and read-only lookups go without one. Report progress with update_checklist_item as it happens. When the user moves the session on to " +
  "a different task, call set_main_task with new_task=true so the finished list is put away. An item belongs on the list only if " +
  "the main task cannot finish without it. Side work does not belong there, however long it takes: bugs " +
  "you happen to notice, questions along the way, experiments. While you are on side work, the item you " +
  "left stays `doing`, which is how the user finds the way back. When an item cannot move until the user " +
  "or something else does, mark it `waiting` instead of leaving it `doing`. If you are unsure whether something " +
  "belongs, ask the user instead of adding it; the user adding or dropping an item always wins. " +
  "When you mention a merge request or pull request, write its full URL, or at least the project and " +
  "number together: `group/project!N` for GitLab, `owner/repo#N` for GitHub. Do not write a bare `!N` " +
  "or `#N`, or put the number apart from the project name (\"release MR !111 of billing\"), because " +
  "the session's link bar cannot tell which project such a number belongs to. " +
  "If this session starts from a chat-history summary of another session (a fork), do this before " +
  "continuing, since the link bar cannot see the summary and the fork would otherwise start with an empty " +
  "bar: call pin_link once for that session's main task (kind=task, primary=true, with its doc path, " +
  "issue URL or ID) and once for each merge or pull request it worked on that the summary names, then " +
  "repeat set_main_task and re-add the checklist items the summary names, with their statuses.";

// Claude Code keeps MCP tools out of the prompt until the agent searches for them, and an agent
// rarely searches for a tool it was only told about. These few small tools are listed up front.
// Clients that do not know this key ignore it.
const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

const STATUSES = ["todo", "doing", "waiting", "done", "dropped"];
// What a note has to say for a status to be set; the old status's note does not count.
const NOTE_REQUIRED = {
  done: "A done item needs a note with evidence: a commit, a test count, the command that measured it.",
  waiting: "A waiting item needs a note saying who or what it waits on.",
  dropped: "A dropped item needs a note saying why.",
};
// The list is a map of the task, not a log of the session; the daemon reads what is written here.
const MAX_ITEMS = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_TASK_FILE_BYTES = 256 * 1024;
// Finished tasks kept in the file; five lists of thirty items stay far under the size cap.
const MAX_PREVIOUS_TASKS = 5;

const tools = [
  {
    name: "set_main_task",
    description:
      "Name this session's main task, which shows on the Task button above the chat. Use it when the task " +
      "was given in chat, or to rename it; its checklist stays. When the user moves the session on to a " +
      "different task, pass new_task=true: the finished list is put away and the new task starts empty. " +
      "A task doc or issue pinned with pin_link takes over the button, and the checklist stays with it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A few words naming the task." },
        new_task: { type: "boolean", description: "A different task, not a rename: put the current checklist away." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "add_checklist_item",
    description:
      "Add something the main task cannot finish without to its checklist. Not for side work, or for every " +
      "step of a turn: that is what your own todo list is for. Unsure whether it belongs? Ask the user first. " +
      "One item per step that can finish on its own: a hotfix that needs approval, merge, build and upload is " +
      "four items, two platforms are two items. Add an item as soon as the work is known, even if it already " +
      "waits on someone, not after it has happened.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The work, named so it stays true as the work moves: never its state, a count or a time " +
            "(\"Submit the Android build for review\", not \"… (sent 13:35, waiting)\"). Status and note carry " +
            "the state. Short enough to read in a menu.",
        },
        why: { type: "string", description: "One line: why the main task cannot finish without this." },
        after: { type: "string", description: "Id of the item this comes after; the end of the list when omitted." },
      },
      required: ["text", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "update_checklist_item",
    description:
      "Change a checklist item's status. One item is `doing` at a time, and it stays so during side work. " +
      "`waiting` means it cannot move until someone or something else does, and the note says who or what. " +
      "`done` needs a note with evidence, and means nothing of the item is left: add what remains as items " +
      "first. Items are never deleted: `dropped` keeps one on the list and needs " +
      "a note saying why. Changing the status clears the old note.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: STATUSES },
        note: {
          type: "string",
          description:
            "About the new status, in one short line (about 100 characters): for `done`, point to the evidence " +
            "(a commit, a test count, the command that measured it) rather than retell it; who or what for " +
            "`waiting`; why for `dropped`.",
        },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
];

const tool = {
  name: TOOL,
  description:
    "Pin a link to this session's Trail bar in Paseo (buttons above the chat box). Call it as soon as the " +
    "user names the main task, in the first message or when moving the session to other work (kind=task, " +
    "primary=true; pass its doc path, issue URL or tracker ID), when you create or " +
    "start reviewing a merge or pull request (kind=mr), or for any other page the user will want to reopen " +
    "(kind=link). Task docs and MR/PR URLs in the conversation are picked up automatically; use " +
    "this to set the main task explicitly or to add links that would not be detected. Pinning the main " +
    "task does not make its checklist: add the items it needs right after.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "http(s) URL, the path of a task doc, or a task ID such as ABC-123." },
      kind: { type: "string", enum: ["task", "mr", "link"] },
      label: { type: "string", description: "Short button text. Derived from the target when omitted." },
      primary: { type: "boolean", description: "Mark this task doc as the session's main task." },
    },
    required: ["target"],
    additionalProperties: false,
  },
};

// Anything that is not a list of pins (a cut-short write, a hand edit) counts as no pins.
// Opened without blocking (a FIFO would never answer) and read only when it is a regular file no
// larger than fifty pins can be.
function readEntries(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_PIN_FILE_BYTES) return [];
    const entries = JSON.parse(readFileSync(fd, "utf8"));
    return Array.isArray(entries) ? entries.slice(-MAX_PINS).filter((entry) => typeof entry?.target === "string") : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function addLink({ target, kind, label, primary }) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!stateDir || !agentId) {
    throw new Error("Not running inside a Paseo agent (PASEO_AGENT_ID is not set).");
  }
  if (!AGENT_ID.test(agentId)) throw new Error(`Unexpected agent id: ${agentId}`);
  if (typeof target !== "string" || target.trim() === "") throw new Error("target is required.");
  if (target.length > MAX_TARGET_LENGTH) throw new Error(`target is longer than ${MAX_TARGET_LENGTH} characters.`);
  if (typeof label === "string" && label.length > MAX_LABEL_LENGTH) throw new Error(`label is longer than ${MAX_LABEL_LENGTH} characters.`);
  if (/^https?:\/\//i.test(target.trim())) {
    try {
      new URL(target.trim());
    } catch {
      throw new Error(`Not a valid URL: ${target}`);
    }
  }
  if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}.`);
  if (label !== undefined && typeof label !== "string") throw new Error("label must be a string.");
  if (primary !== undefined && typeof primary !== "boolean") throw new Error("primary must be a boolean.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, `${agentId}.reported.json`);
  let key = target.trim();
  // A URL is kept without any `user:password@` it carried, since this file is plain state; any
  // other URL is kept exactly as given.
  if (/^https?:\/\//i.test(key)) {
    const url = new URL(key);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      key = url.href;
    }
  }
  if (key.length > MAX_TARGET_LENGTH) throw new Error(`target is longer than ${MAX_TARGET_LENGTH} characters.`);
  const entries = readEntries(file).filter((entry) => entry.target.trim() !== key);
  entries.push({ target: key, kind, label, primary, at: new Date().toISOString() });
  // Only this process writes this file (the daemon keeps its own); a temporary name of our own
  // still keeps a half-written file from ever being read.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries.slice(-MAX_PINS)));
  renameSync(temporary, file);
  // A pinned main task gets the same reminder as a named one, at the moment it is declared.
  const isMainTask = kind === "task" || primary === true;
  return isMainTask && readTask(taskFile()).items.length === 0 ? `Pinned ${target}.\n${EMPTY_CHECKLIST}` : `Pinned ${target}.`;
}

function taskFile() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!stateDir || !agentId) {
    throw new Error("Not running inside a Paseo agent (PASEO_AGENT_ID is not set).");
  }
  if (!AGENT_ID.test(agentId)) throw new Error(`Unexpected agent id: ${agentId}`);
  return join(stateDir, `${agentId}.task.json`);
}

// Like the pin file, anything that is not a task file counts as an empty task.
function readTask(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_TASK_FILE_BYTES) return { items: [] };
    const task = JSON.parse(readFileSync(fd, "utf8"));
    const items = Array.isArray(task?.items) ? task.items.filter((item) => typeof item?.id === "string" && typeof item?.text === "string") : [];
    const previous = Array.isArray(task?.previous) ? task.previous.slice(-MAX_PREVIOUS_TASKS) : [];
    return { ...(typeof task?.title === "string" ? { title: task.title } : {}), items, ...(previous.length > 0 ? { previous } : {}) };
  } catch {
    return { items: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeTask(file, task) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(task));
  renameSync(temporary, file);
}

// Every answer repeats the list, so the agent re-reads where it stands each time it reports.
// Said whenever the main task is named or pinned while its list is empty. Agents tend to take
// declaring the task for the whole job and only write the list much later, after changing files.
// Worded as an order for the very next step: agents took a softer reminder as advice and skipped the
// list on short tasks.
const EMPTY_CHECKLIST =
  "The checklist is empty. Before your next tool call, add what this task needs with add_checklist_item, " +
  "in working order. Every task that changes files needs a list, even a one-step task; only questions and " +
  "read-only lookups go without one.";

// A waiting item that has not moved for this long may wait on something that already happened.
const STALE_WAITING_MS = 3 * 60 * 60 * 1000;

function describeTask({ title, items }) {
  // A waiting item shows how long it has waited, so the agent sees which ones to check again.
  const label = (item) => (item.status === "waiting" && age(item.updatedAt) ? `waiting ${age(item.updatedAt)}` : item.status);
  const lines = items.map((item) => `- [${label(item)}] ${item.id}: ${item.text}${item.note ? ` (${item.note})` : ""}`);
  const stale = items.some((item) => item.status === "waiting" && Date.now() - Date.parse(item.updatedAt ?? "") > STALE_WAITING_MS);
  return [
    `Main task: ${title ?? "(not named; call set_main_task)"}`,
    ...(lines.length > 0 ? lines : [EMPTY_CHECKLIST]),
    ...(stale ? ["Some items have waited for hours: check whether what they wait on has happened, and update them."] : []),
  ].join("\n");
}

function requireText(value, name, maxLength) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  if (value.length > maxLength) throw new Error(`${name} is longer than ${maxLength} characters.`);
  return value.trim();
}

function setMainTask({ title, new_task: newTask }) {
  const file = taskFile();
  const name = requireText(title, "title", MAX_TITLE_LENGTH);
  if (newTask !== undefined && typeof newTask !== "boolean") throw new Error("new_task must be a boolean.");
  const current = readTask(file);
  // A different task starts with an empty list; the finished one is kept in the file, out of the menu.
  const task = newTask
    ? {
        title: name,
        items: [],
        previous: [...(current.previous ?? []), { title: current.title, items: current.items, closedAt: new Date().toISOString() }].slice(-MAX_PREVIOUS_TASKS),
      }
    : { ...current, title: name };
  writeTask(file, task);
  return describeTask(task);
}

function addChecklistItem({ text, why, after }) {
  const file = taskFile();
  const task = readTask(file);
  const name = requireText(text, "text", MAX_TEXT_LENGTH);
  const reason = requireText(why, "why", MAX_REASON_LENGTH);
  if (task.items.length >= MAX_ITEMS) {
    throw new Error(`The checklist already has ${MAX_ITEMS} items. It maps the main task, so merge or drop items instead of adding more.`);
  }
  const same = name.toLowerCase();
  if (task.items.some((item) => item.status !== "dropped" && item.text.toLowerCase() === same)) {
    throw new Error(`The checklist already has this item: ${name}`);
  }
  const previous = after === undefined ? task.items.length - 1 : task.items.findIndex((item) => item.id === after);
  if (after !== undefined && previous === -1) throw new Error(`No checklist item has the id ${after}.`);
  const item = { id: randomUUID().slice(0, 8), text: name, why: reason, status: "todo", updatedAt: new Date().toISOString() };
  task.items.splice(previous + 1, 0, item);
  writeTask(file, task);
  return describeTask(task);
}

function updateChecklistItem({ id, status, note }) {
  const file = taskFile();
  const task = readTask(file);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}.`);
  const item = task.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No checklist item has the id ${id}.`);
  const statusChanged = item.status !== status;
  const newNote = note === undefined ? undefined : requireText(note, "note", MAX_REASON_LENGTH);
  if (NOTE_REQUIRED[status] && !newNote && (statusChanged || !item.note)) throw new Error(NOTE_REQUIRED[status]);
  // When it last changed, so menus and this list can tell a fresh item from a stale one.
  const now = new Date().toISOString();
  if (status === "doing") {
    for (const other of task.items) {
      if (other.status === "doing" && other !== item) Object.assign(other, { status: "todo", updatedAt: now });
    }
  }
  // A note describes one status; carried over, it would contradict the next ("waiting for CI" on a done item).
  if (newNote) item.note = newNote;
  else if (statusChanged) delete item.note;
  item.status = status;
  item.updatedAt = now;
  writeTask(file, task);
  return describeTask(task);
}

const handlers = {
  [TOOL]: addLink,
  set_main_task: setMainTask,
  add_checklist_item: addChecklistItem,
  update_checklist_item: updateChecklistItem,
};

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  // Notifications carry no id and expect no answer.
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "trail", version: "0.2.1" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [tool, ...tools].map((definition) => ({ ...definition, _meta: ALWAYS_LOAD })) });
    case "tools/call":
      if (!Object.hasOwn(handlers, params?.name)) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: "text", text: handlers[params.name](params.arguments ?? {}) }] });
      } catch (error) {
        return reply(id, { content: [{ type: "text", text: String(error.message) }], isError: true });
      }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  try {
    handle(JSON.parse(line));
  } catch {
    fail(null, -32700, "Parse error");
  }
});
