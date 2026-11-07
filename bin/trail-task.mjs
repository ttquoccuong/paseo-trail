#!/usr/bin/env node
// The agent tools of trail-mcp.mjs from a shell, for sessions whose MCP server was attached before
// these tools existed. It runs the MCP server itself, so the rules and the files stay the same.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = ["pin_link", "set_main_task", "add_checklist_item", "update_checklist_item"];
const USAGE = `Usage: trail-task.mjs <tool> '<json arguments>'
Tools: ${TOOLS.join(", ")}
Run inside a Paseo agent's shell, which sets PASEO_AGENT_ID.`;

function stop(code, message) {
  console.error(message);
  process.exit(code);
}

const [name, json = "{}"] = process.argv.slice(2);
if (!name) stop(2, USAGE);
if (!TOOLS.includes(name)) stop(2, `Unknown tool: ${name}\n${USAGE}`);
let args;
try {
  args = JSON.parse(json);
} catch {
  stop(2, `The arguments are not valid JSON: ${json}\n${USAGE}`);
}

const script = join(dirname(fileURLToPath(import.meta.url)), "trail-mcp.mjs");
const stateDir = process.env.TRAIL_STATE_DIR || join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "trail", "state");
const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const run = spawnSync(process.execPath, [script], {
  input: `${request}\n`,
  env: { ...process.env, TRAIL_STATE_DIR: stateDir },
  encoding: "utf8",
});
if (run.status !== 0) stop(1, run.stderr || `The MCP server exited with ${run.status}.`);
const { result } = JSON.parse(run.stdout);
const text = result.content[0].text;
if (result.isError) stop(1, text);
console.log(text);
