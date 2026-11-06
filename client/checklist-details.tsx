import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useMemo, type ComponentType } from "react";
import { Text, View } from "react-native";
import type { ChecklistItem } from "../shared/links";
import { itemDetails } from "./checklist";
import { useTranslate } from "./i18n";

// As wide as the merge confirmations; a long note wraps here instead of widening the menu.
const MAX_WIDTH = 380;

/** The popover of one checklist item: its text, then why it is on the list and its note. */
export function checklistItemDetails(item: ChecklistItem): ComponentType<PluginButtonContentProps> {
  const Details: ComponentType<PluginButtonContentProps> = ({ theme }) => {
    const t = useTranslate();
    const styles = useMemo(
      () => ({
        container: { gap: 6, maxWidth: MAX_WIDTH },
        heading: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
        line: { color: theme.colors.foregroundMuted, fontSize: 12 },
      }),
      [theme],
    );
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>{item.text}</Text>
        {itemDetails(item, t, Date.now()).map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
      </View>
    );
  };
  return Details;
}
