#!/usr/bin/env node
// Claude Code `UserPromptSubmit` hook: with every user message, tells the agent where its Trail
// checklist stands, so the list changes when the message changes the work. Plugins have no hook of
// their own that runs per message. Silent outside a Paseo agent, in sessions without a main task and
// once every item is finished. Enable it in a Claude Code settings file:
//   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//     "command": "node <plugin>/bin/trail-reminder.mjs" }] }] }
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { age } from "./age.mjs";

// Paseo agent ids are UUIDs; the id names the state files, so nothing else is accepted.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
// State files hold short lists; anything larger, or not a regular file, is read as nothing.
const MAX_FILE_BYTES = 1024 * 1024;
// The reminder is read with every message, so it names items briefly and only a few waiting ones.
const MAX_TEXT_LENGTH = 60;
const MAX_WAITING_LISTED = 3;

function readJson(file) {
  let fd;
  try {
    // Opened without blocking, so a FIFO in place of the file cannot hang the user's message.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const clip = (text) => (text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…`);

/** The task pinned last, from the MCP server's pins and the daemon's, honouring unpins. */
function pinnedTask(stateDir, agentId) {
  const entries = ["reported", "pins"]
    .flatMap((suffix) => readJson(join(stateDir, `${agentId}.${suffix}.json`)) ?? [])
    .filter((entry) => typeof entry?.target === "string")
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const latest = new Map();
  for (const entry of entries) latest.set(entry.target.trim(), entry);
  return [...latest.values()].filter((entry) => !entry.removed && entry.kind === "task").pop() ?? null;
}

function reminder() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId || !AGENT_ID.test(agentId)) return null;
  const stateDir = process.env.TRAIL_STATE_DIR || join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "trail", "state");
  const task = readJson(join(stateDir, `${agentId}.task.json`)) ?? {};
  const items = (Array.isArray(task.items) ? task.items : []).filter(
    (item) => typeof item?.text === "string" && typeof item?.status === "string",
  );
  const pin = pinnedTask(stateDir, agentId);
  const name = typeof task.title === "string" ? task.title : (pin?.label ?? pin?.target);
  if (!name) return null;
  if (items.length === 0) {
    return (
      `Trail: the main task "${clip(name)}" has no checklist yet. Before your next tool call, add the items it ` +
      "needs with add_checklist_item; every task that changes files needs a list, even a one-step task."
    );
  }
  const open = items.filter((item) => item.status !== "done" && item.status !== "dropped");
  if (open.length === 0) return null;
  const counted = items.filter((item) => item.status !== "dropped");
  const doing = items.find((item) => item.status === "doing");
  const waiting = items.filter((item) => item.status === "waiting");
  const parts = [`${counted.length - open.length}/${counted.length} done`];
  if (doing) parts.push(`doing: ${clip(doing.text)}`);
  if (waiting.length > 0) {
    const listed = waiting.slice(0, MAX_WAITING_LISTED).map((item) => `${clip(item.text)} (${age(item.updatedAt) ?? "?"})`);
    parts.push(`waiting: ${listed.join(", ")}${waiting.length > MAX_WAITING_LISTED ? ", …" : ""}`);
  }
  return (
    `Trail checklist for "${clip(name)}": ${parts.join("; ")}. If this message changes any of it ` +
    "(a step done, a new step, something to wait on, other work), update the list."
  );
}

const text = reminder();
if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
