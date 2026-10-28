#!/usr/bin/env node
// Stdio MCP server that the Trail plugin attaches to new agents. It only records what
// the agent reports into <state>/<agentId>.reported.json; the plugin daemon turns that into
// composer pills. Kept dependency-free so it runs straight from the plugin checkout.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

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

// Clients put server instructions in the agent's system prompt. Trail finds MRs and PRs in the
// conversation; a bare `!N` or a number away from its project name cannot be traced to a project.
const INSTRUCTIONS =
  "When you mention a merge request or pull request, write its full URL, or at least the project and " +
  "number together: `group/project!N` for GitLab, `owner/repo#N` for GitHub. Do not write a bare `!N` " +
  "or `#N`, or put the number apart from the project name (\"release MR !111 of billing\"), because " +
  "the session's link bar cannot tell which project such a number belongs to. " +
  "If this session starts from a chat-history summary of another session (a fork), call pin_link " +
  "before continuing: once for that session's main task (kind=task, primary=true, with its doc path, " +
  "issue URL or ID) and once for each merge or pull request it worked on that the summary names. The " +
  "link bar cannot see the summary, so without this the fork starts with an empty bar.";

const tool = {
  name: TOOL,
  description:
    "Pin a link to this session's Trail bar in Paseo (buttons above the chat box). Call it when you " +
    "start on the main task (kind=task, primary=true; pass its doc path or tracker ID), when you create or " +
    "start reviewing a merge or pull request (kind=mr), or for any other page the user will want to reopen " +
    "(kind=link). Task docs and MR/PR URLs in the conversation are picked up automatically; use " +
    "this to set the main task explicitly or to add links that would not be detected.",
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
  return `Pinned ${target}.`;
}

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
        serverInfo: { name: "trail", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [tool] });
    case "tools/call":
      if (params?.name !== TOOL) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: "text", text: addLink(params.arguments ?? {}) }] });
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
