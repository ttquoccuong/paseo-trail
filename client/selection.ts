import { useSyncExternalStore } from "react";

/** What the file panel shows: the task doc, one of its bundle files, or a file the agent touched. */
export type FileSelection = { kind: "task" } | { kind: "bundle"; file: string } | { kind: "path"; path: string };

// Panels open with only an agent id, so menus leave the chosen file here for the panel to pick up.
const selected = new Map<string, FileSelection>();
const listeners = new Set<() => void>();
const TASK: FileSelection = { kind: "task" };

export function selectFile(agentId: string, selection: FileSelection): void {
  selected.set(agentId, selection);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSelectedFile(agentId: string): FileSelection {
  return useSyncExternalStore(subscribe, () => selected.get(agentId) ?? TASK);
}
