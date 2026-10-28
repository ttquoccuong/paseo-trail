import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { CommandResult } from "../shared/links";
import { useTranslate } from "./i18n";
import type { MessageKey } from "./messages";

const TEXT: Record<Exclude<CommandResult["code"], "status">, MessageKey> = {
  modeAll: "feedback.modeAll",
  modeTask: "feedback.modeTask",
  pinned: "feedback.pinned",
  unpinned: "feedback.unpinned",
  copied: "feedback.copied",
  nothingToCopy: "feedback.nothingToCopy",
  notPinnable: "feedback.notPinnable",
  notPinned: "feedback.notPinned",
};

const DONE = new Set<CommandResult["code"]>(["modeAll", "modeTask", "pinned", "unpinned", "copied"]);

// Shown for a bare or unrecognised `/trail`: what the session shows now and what can be typed.
const COMMANDS: Array<[string, MessageKey]> = [
  ["/trail-all", "command.allDescription"],
  ["/trail-task", "command.taskDescription"],
  ["/trail-copy", "command.copyDescription"],
  ["/trail-pin <url> [label]", "command.pinDescription"],
  ["/trail-unpin <url>", "command.unpinDescription"],
];

/** A muted confirmation, or the session's state and the commands, left by a `/trail` command. */
export function CommandResultRow({ theme, item }: PluginTimelineItemProps<CommandResult>) {
  const t = useTranslate();
  const styles = useMemo(
    () => ({
      block: { gap: 2, paddingVertical: 4 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      text: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      command: { color: theme.colors.foreground, fontSize: 12 },
    }),
    [theme],
  );
  const { code, values } = item.data;
  const done = DONE.has(code);
  const headline =
    code === "status"
      ? t("feedback.status", {
          mode: t(values.mode === "task" ? "feedback.statusModeTask" : "feedback.statusModeAll"),
          count: values.count ?? 0,
        })
      : t(TEXT[code], values);
  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <Icon name={done ? "Check" : "Info"} size={14} color={done ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
        <Text style={styles.text}>{headline}</Text>
      </View>
      {code === "status" && !values.canToggle ? <Text style={styles.text}>{t("feedback.statusNoTask")}</Text> : null}
      {code === "status"
        ? COMMANDS.map(([command, description]) => (
            <Text key={command} style={styles.text}>
              <Text style={styles.command}>{command}</Text> · {t(description)}
            </Text>
          ))
        : null}
    </View>
  );
}
