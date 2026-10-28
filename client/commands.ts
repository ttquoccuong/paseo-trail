import type { PluginClientContext } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { listLinksRpc, pinLinkRpc, reportCommandRpc, setModeRpc, type CommandResult } from "../shared/links";
import { translator } from "./i18n";
import { asMarkdown } from "./markdown";
import { messages } from "./messages";

type Subcommand = "all" | "task" | "pin" | "unpin" | "copy";

interface RunInput {
  agentId: string;
  rpc: Parameters<Parameters<PluginClientContext["addSlashCommand"]>[0]["onSubmit"]>[0]["rpc"];
  subcommand: string;
  words: string[];
}

async function run(client: PluginClientContext, refresh: () => void, { agentId, rpc, subcommand, words }: RunInput) {
  const [target, ...rest] = words;
  const { sessions, language } = await rpc(listLinksRpc, { agentIds: [agentId] });
  const t = translator(client, language);
  const session = sessions[agentId];
  const links = session?.links ?? [];
  // A command that cannot act answers with the session's state instead of an error toast.
  const status: CommandResult = {
    code: "status",
    values: { mode: session?.mode ?? "all", count: links.length, canToggle: session?.canToggle ? 1 : 0 },
  };
  let result: CommandResult;
  switch (subcommand) {
    case "all":
    case "task":
      await rpc(setModeRpc, { agentId, mode: subcommand });
      result = { code: subcommand === "all" ? "modeAll" : "modeTask", values: {} };
      break;
    case "pin":
    case "unpin":
      if (!target) {
        result = status;
        break;
      }
      try {
        const { removed } = await rpc(pinLinkRpc, { agentId, target, label: rest.join(" ") || undefined, unpin: subcommand === "unpin" });
        result = { code: subcommand === "pin" ? "pinned" : removed === false ? "notPinned" : "unpinned", values: { target } };
      } catch {
        // The daemon refuses text that is no URL, task doc or task ID.
        result = { code: "notPinnable", values: { target } };
      }
      break;
    case "copy":
      if (links.length === 0) {
        result = { code: "nothingToCopy", values: {} };
        break;
      }
      await copyText(asMarkdown(links, t));
      result = { code: "copied", values: { count: links.length } };
      break;
    default:
      result = status;
  }
  refresh();
  await rpc(reportCommandRpc, { agentId, result });
}

// One command per action as well as `/trail <action>`: on a phone, picking `/trail-copy` from the
// suggestions runs it, while `/trail` would still need an argument typed after it.
const SHORTCUTS: Array<{ action: Subcommand; hint: "" | "command.urlHint" | "command.pinHint" }> = [
  { action: "all", hint: "" },
  { action: "task", hint: "" },
  { action: "copy", hint: "" },
  { action: "pin", hint: "command.pinHint" },
  { action: "unpin", hint: "command.urlHint" },
];

export function registerTrailCommand(client: PluginClientContext, refresh: () => void): () => void {
  const removers = [
    client.addSlashCommand({
      name: "trail",
      description: messages.message("command.description"),
      argumentHint: messages.message("command.argumentHint"),
      context: "agent",
      onSubmit: ({ args, agent, rpc }) => {
        const [subcommand = "", ...words] = args.split(/\s+/).filter(Boolean);
        return run(client, refresh, { agentId: agent.id, rpc, subcommand, words });
      },
    }),
    ...SHORTCUTS.map(({ action, hint }) =>
      client.addSlashCommand({
        name: `trail-${action}`,
        description: messages.message(`command.${action}Description`),
        argumentHint: hint ? messages.message(hint) : "",
        context: "agent",
        onSubmit: ({ args, agent, rpc }) =>
          run(client, refresh, { agentId: agent.id, rpc, subcommand: action, words: args.split(/\s+/).filter(Boolean) }),
      }),
    ),
  ];
  return () => removers.forEach((remove) => remove());
}
