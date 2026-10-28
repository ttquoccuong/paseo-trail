import type { PluginClientContext } from "@getpaseo/plugin/client";
import { syncSessionLinkPills, TASK_DOC_PANEL } from "./client/pills";
import { COMMAND_RESULT_KIND, commandResultSchema } from "./shared/links";
import { CommandResultRow } from "./client/command-result";
import { registerTrailCommand } from "./client/commands";
import { TrailSettings } from "./client/credentials-view";
import { messages } from "./client/messages";
import { TaskDocPanel } from "./client/task-doc-panel";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addAgentPanel({
    id: TASK_DOC_PANEL,
    title: messages.message("task.panelTitle"),
    icon: "FileText",
    Component: TaskDocPanel,
  });
  const removeSettings = client.addSettingsScreen({
    id: "status",
    title: "Trail",
    icon: "KeyRound",
    Component: TrailSettings,
  });
  const pills = syncSessionLinkPills(client);
  const removeCommand = registerTrailCommand(client, pills.refresh);
  const removeRenderer = client.addTimelineRenderer({
    kind: COMMAND_RESULT_KIND,
    version: 1,
    schema: commandResultSchema,
    Component: CommandResultRow,
  });
  return () => {
    removeCommand();
    removeRenderer();
    pills.stop();
    removeSettings();
    removePanel();
  };
}
