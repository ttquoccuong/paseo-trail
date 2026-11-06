import type { PluginButtonContentProps, PluginButtonIcon, PluginButtonMenuEntry } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { ChecklistItem } from "../shared/links";
import type { Translate } from "./i18n";

// Named icons take the menu's text color, so a colored one has to be inline: Lucide's CircleCheck.
export const DONE_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
};

// Lucide's CirclePause.
export const WAITING_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/></svg>',
};

const STATUS_ICON: Record<ChecklistItem["status"], PluginButtonIcon> = {
  todo: "Circle",
  doing: "CircleDot",
  waiting: WAITING_ICON,
  done: DONE_ICON,
  dropped: "CircleX",
};

// A waiting or in-progress item unchanged for this long shows its age on its row: what it waits on
// may have happened, or the agent may have stopped reporting it.
const STALE_MS = 3 * 60 * 60 * 1000;
// About as much of a waiting item's note as a row has room for after the item's own text.
const ROW_NOTE_LENGTH = 40;

/** How long ago `iso` was, as 5m, 3h or 2d; undefined when unknown. */
export function ageOf(iso: string | undefined, now: number): string | undefined {
  const minutes = Math.floor((now - Date.parse(iso ?? "")) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  if (minutes < 60) return `${minutes}m`;
  return minutes < 48 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (24 * 60))}d`;
}

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;
}

/** A row's text: the item, what a waiting one waits on, and its age once it has stood still for hours. */
function rowTitle(item: ChecklistItem, now: number): string {
  const waitsOn = item.status === "waiting" && item.note ? ` — ${clip(item.note, ROW_NOTE_LENGTH)}` : "";
  const isOpen = item.status === "waiting" || item.status === "doing";
  const isStale = isOpen && now - Date.parse(item.updatedAt ?? "") > STALE_MS;
  return `${item.text}${waitsOn}${isStale ? ` · ${ageOf(item.updatedAt, now)}` : ""}`;
}

// A dropped item stays visible but is no longer work to finish.
function progress(items: ChecklistItem[]) {
  const open = items.filter((item) => item.status !== "dropped");
  return { done: open.filter((item) => item.status === "done").length, total: open.length };
}

/** The task button's own face: progress comes first because the bar cuts long labels short. */
export function taskPillLook(name: string, items: ChecklistItem[], t: Translate): { label: string; icon: PluginButtonIcon } {
  if (items.length === 0) return { label: t("task.label", { name }), icon: "FileText" };
  return {
    label: t("task.labelProgress", { ...progress(items), name }),
    icon: items.some((item) => item.status === "waiting") ? WAITING_ICON : "FileText",
  };
}

/**
 * The top of the task menu: progress, then the items in order, then a separator. Rows are only
 * read here; an item's status changes when the agent reports it, so pressing one only opens
 * `details(item)`: a popover telling why it is on the list and what came of it. A menu row cannot
 * wrap, so a row shows only the start of a waiting item's note; `now` dates the stale ones.
 */
export function checklistEntries(
  items: ChecklistItem[],
  t: Translate,
  details: (item: ChecklistItem) => ComponentType<PluginButtonContentProps>,
  now: number,
): PluginButtonMenuEntry[] {
  if (items.length === 0) return [];
  const line = (id: string, title: string): PluginButtonMenuEntry => ({
    kind: "item",
    id,
    title,
    disabled: true,
    behavior: { kind: "action", onPress: () => undefined },
  });
  return [
    line("checklist-progress", t("checklist.progress", progress(items))),
    ...items.map((item): PluginButtonMenuEntry => ({
      kind: "item",
      id: `checklist-${item.id}`,
      title: rowTitle(item, now),
      icon: STATUS_ICON[item.status],
      behavior: { kind: "popover", Content: details(item) },
    })),
    { kind: "separator", id: "after-checklist" },
  ];
}

/** What an item's popover says under its text: why it is on the list, its note, and when it last changed. */
export function itemDetails(item: ChecklistItem, t: Translate, now: number): string[] {
  const age = ageOf(item.updatedAt, now);
  return [
    t("checklist.why", { text: item.why }),
    ...(item.note ? [t("checklist.note", { text: item.note })] : []),
    ...(age ? [t("checklist.updated", { age })] : []),
  ];
}
