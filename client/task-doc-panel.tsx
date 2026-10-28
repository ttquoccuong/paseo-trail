import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { readTaskDocRpc } from "../shared/links";
import { useTranslate } from "./i18n";
import { fenceFor } from "./markdown";
import { selectFile, useSelectedFile, type FileSelection } from "./selection";

// Re-read often enough that edits made by the agent show up while the tab is open.
const REFRESH_INTERVAL_MS = 3000;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const TASK_DOC_LABEL = "README.md";

// Markdown would render YAML frontmatter as a rule plus loose text; show it as a code block.
function withFencedFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, (_, yaml: string) => {
    const fence = fenceFor(yaml);
    return `${fence}yaml\n${yaml}\n${fence}\n\n`;
  });
}

// Anything that is not Markdown is shown verbatim, highlighted by its extension.
function asMarkdown(path: string, text: string): string {
  if (/\.(md|markdown)$/i.test(path)) return withFencedFrontmatter(text);
  const extension = path.split(".").pop() ?? "";
  const fence = fenceFor(text);
  return `${fence}${extension}\n${text}\n${fence}`;
}

function requestFor(selection: FileSelection): { file?: string; path?: string } {
  if (selection.kind === "bundle") return { file: selection.file };
  if (selection.kind === "path") return { path: selection.path };
  return {};
}

function isSame(a: FileSelection, b: FileSelection): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TaskDocPanel({ theme, layout, params }: PluginAgentPanelProps) {
  const { agentId } = params;
  const selection = useSelectedFile(agentId);
  const t = useTranslate();
  const readTaskDoc = useRpc(readTaskDocRpc);
  const query = useQuery({
    queryKey: ["task-doc", agentId, selection],
    queryFn: () => readTaskDoc({ agentId, ...requestFor(selection) }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 12 },
      tabs: { flexDirection: "row" as const, gap: 6 },
      tab: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      activeTab: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      tabText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      activeTabText: { color: theme.colors.foreground, fontSize: 12 },
      path: { color: theme.colors.foregroundMuted, fontSize: 12 },
      message: { color: theme.colors.foregroundMuted, padding: layout.compact ? 16 : 24 },
    }),
    [theme, layout.compact],
  );

  if (query.isLoading) return <Loading />;
  if (query.isError) {
    return <Text style={styles.message}>{t("panel.readError", { error: String(query.error) })}</Text>;
  }
  const doc = query.data;
  if (!doc?.path) {
    return <Text style={styles.message}>{t("panel.noDoc")}</Text>;
  }

  // The switcher belongs to the task's folder; a single touched file has nothing to switch to.
  const tabs: Array<{ selection: FileSelection; label: string }> =
    selection.kind === "path"
      ? []
      : [
          { selection: { kind: "task" }, label: TASK_DOC_LABEL },
          ...doc.bundle.map((file) => ({ selection: { kind: "bundle", file } as FileSelection, label: file })),
        ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {tabs.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.tabs}>
            {tabs.map((tab) => {
              const isActive = isSame(tab.selection, selection);
              return (
                <Pressable
                  key={tab.label}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={`Show ${tab.label}`}
                  style={isActive ? styles.activeTab : styles.tab}
                  onPress={() => selectFile(agentId, tab.selection)}
                >
                  <Text style={isActive ? styles.activeTabText : styles.tabText}>{tab.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
      <View>
        <Text style={styles.path} selectable>
          {doc.path}
        </Text>
        {doc.modifiedAt ? (
          <Text style={styles.path}>{t("panel.modified", { date: new Date(doc.modifiedAt).toLocaleString() })}</Text>
        ) : null}
      </View>
      {doc.text === null ? (
        <Text style={styles.message}>
          {doc.notShown?.reason === "tooLarge"
            ? t("panel.tooLarge", { limit: doc.notShown.limitKb })
            : doc.notShown?.reason === "binary"
              ? t("panel.binary")
              : t("panel.unreadable")}
        </Text>
      ) : (
        <Markdown>{asMarkdown(doc.path, doc.text)}</Markdown>
      )}
    </ScrollView>
  );
}
