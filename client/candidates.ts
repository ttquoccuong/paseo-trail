import type { PluginButtonIcon, PluginButtonMenuEntry } from "@getpaseo/plugin/client";
import type { SessionLink } from "../shared/links";
import type { Translate } from "./i18n";

/** The face of a task button whose task Trail guessed while other docs came close. */
export function guessedTaskLook(name: string, t: Translate): { label: string; icon: PluginButtonIcon } {
  return { label: t("task.labelGuess", { name }), icon: "FileText" };
}

/**
 * The top of such a task's menu: one row per close doc, the guess first. Picking one pins it as the
 * session's task, which no later guess overrides.
 */
export function candidateEntries(link: SessionLink, t: Translate, pick: (target: string) => void): PluginButtonMenuEntry[] {
  const candidates = link.candidates ?? [];
  if (candidates.length === 0) return [];
  return [
    {
      kind: "item",
      id: "candidates-note",
      title: t("task.guessed"),
      disabled: true,
      behavior: { kind: "action", onPress: () => undefined },
    },
    ...candidates.map(
      (candidate, index): PluginButtonMenuEntry => ({
        kind: "item",
        id: `candidate-${index}`,
        title: t("task.setMain", { name: candidate.label }),
        icon: candidate.title === link.title ? "CircleDot" : "Circle",
        behavior: { kind: "action", onPress: () => pick(candidate.target) },
      }),
    ),
    { kind: "separator", id: "after-candidates" },
  ];
}
