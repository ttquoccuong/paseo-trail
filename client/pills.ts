import {
  openExternalUrl,
  type PluginButton,
  type PluginButtonBehavior,
  type PluginButtonMenuEntry,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import {
  credentialStatusRpc,
  listLinksRpc,
  setModeRpc,
  type CredentialStatus,
  type DisplayMode,
  type SessionLink,
} from "../shared/links";
import { translator, type Translate } from "./i18n";
import { credentialIdOf, mergeRequestsButton, mergeRequestsSignature } from "./merge-requests";
import { hostOf, openableUrl } from "./urls";
import type { MessageKey } from "./messages";
import { selectFile } from "./selection";

export const TASK_DOC_PANEL = "task-doc";

// The daemon cannot push to the client, so links reported mid-turn surface on the next poll.
const POLL_INTERVAL_MS = 5000;
// The daemon caches credential checks for minutes; this only bounds how often the client asks.
const CREDENTIAL_POLL_MS = 60_000;
// A forge seen for the first time has no token status yet, and Rebase and Merge stay hidden until
// it arrives; it is fetched again this soon instead of a whole poll later.
const CREDENTIAL_SOON_MS = 5_000;
// Agent updates arrive in bursts while a turn streams.
const UPDATE_DEBOUNCE_MS = 1000;

const ICON: Record<SessionLink["kind"], string> = {
  task: "FileText",
  mr: "GitPullRequest",
  file: "FileCode",
  doc: "BookOpen",
  link: "Link",
};

// In "all" mode these kinds collapse into one button each, newest first in its menu.
const GROUPS: Array<{ kind: SessionLink["kind"]; label: MessageKey; title: MessageKey }> = [
  { kind: "file", label: "groups.file", title: "groups.fileTitle" },
  { kind: "doc", label: "groups.doc", title: "groups.docTitle" },
  { kind: "link", label: "groups.link", title: "groups.linkTitle" },
];

/** Where a task's remote page lives, for the menu's wording. */
function remoteName(url: string): string | null {
  const host = hostOf(url);
  if (host === "github.com") return "GitHub";
  return host.includes("gitlab") ? "GitLab" : null;
}

interface SessionView {
  mode: DisplayMode;
  canToggle: boolean;
  links: SessionLink[];
}

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

export interface PillSync {
  /** Re-reads links now instead of at the next poll, after a command changed them. */
  refresh(): void;
  stop(): void;
}

export function syncSessionLinkPills(client: PluginClientContext): PillSync {
  const lifetime = new AbortController();
  const workspaceByAgent = new Map<string, string>();
  const shown = new Map<string, Array<{ key: string; signature: string; pill: PluginButtonRegistration }>>();
  let credentials: CredentialStatus[] = [];
  let credentialsFetchedAt = 0;
  let refreshing = false;
  // Labels are worded when built, so a language change has to rebuild every pill.
  let t: Translate = (key) => key;
  let languageKey = "";
  let refreshQueued = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function clearPills(agentId: string) {
    for (const { pill } of shown.get(agentId) ?? []) pill.remove();
    shown.delete(agentId);
  }

  function openLocal(agentId: string, workspaceId: string, selection: Parameters<typeof selectFile>[1]) {
    selectFile(agentId, selection);
    client.openPanel(TASK_DOC_PANEL, { workspaceId, agentId });
  }

  function groupButton(
    agentId: string,
    workspaceId: string,
    group: (typeof GROUPS)[number],
    links: SessionLink[],
  ): PluginButton {
    return {
      title: t(group.title),
      label: t(group.label, { count: links.length }),
      icon: ICON[links[0].kind],
      behavior: {
        kind: "menu",
        items: [...links].reverse().map((link, index) => ({
          kind: "item" as const,
          id: `item-${index}`,
          title: link.kind === "file" && link.edited ? t("groups.edited", { path: link.title }) : link.kind === "file" ? link.title : link.label,
          icon: ICON[link.kind],
          behavior: {
            kind: "action" as const,
            onPress: () =>
              link.kind === "file" && link.localPath
                ? openLocal(agentId, workspaceId, { kind: "path", path: link.localPath })
                : openExternalUrl(link.url),
          },
        })),
      },
    };
  }

  function desiredPills(agentId: string, workspaceId: string, view: SessionView) {
    const { links } = view;
    const mergeRequests = links.filter((link) => link.kind === "mr");
    const pills: Array<{ key: string; signature: string; button: PluginButton }> = [];
    for (const link of links) {
      if (link.kind === "task" || (link.kind === "link" && view.mode === "task")) {
        pills.push({
          key: link.url,
          signature: JSON.stringify({ link, mode: view.mode, canToggle: view.canToggle, languageKey }),
          button: {
            title: link.title,
            label: link.kind === "task" ? t("task.label", { name: link.label }) : link.label,
            icon: ICON[link.kind],
            behavior: linkBehavior(link, workspaceId, agentId, link.kind === "task" ? view : undefined),
          },
        });
      } else if (link === mergeRequests[0]) {
        pills.push({
          key: "merge-requests",
          signature: mergeRequestsSignature(mergeRequests, credentials) + languageKey,
          button: mergeRequestsButton(agentId, mergeRequests, credentials, t),
        });
      }
    }
    if (view.mode === "all") {
      for (const group of GROUPS) {
        const members = links.filter((link) => link.kind === group.kind);
        if (members.length === 0) continue;
        pills.push({
          key: `group-${group.kind}`,
          signature: JSON.stringify(members) + languageKey,
          button: groupButton(agentId, workspaceId, group, members),
        });
      }
    }
    return pills;
  }

  async function setMode(agentId: string, mode: DisplayMode) {
    await client.rpc(setModeRpc, { agentId, mode });
    void refresh();
  }

  /** Fetches token statuses when due; true when new ones arrived. */
  async function refreshCredentials(soon = false): Promise<boolean> {
    const age = Date.now() - credentialsFetchedAt;
    if (age < (soon ? CREDENTIAL_SOON_MS : CREDENTIAL_POLL_MS)) return false;
    credentialsFetchedAt = Date.now();
    try {
      credentials = (await client.rpc(credentialStatusRpc, {})).credentials;
      return !lifetime.signal.aborted;
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("trail: could not read token statuses", error);
      return false;
    }
  }

  let lastSessions: { agentIds: string[]; sessions: Record<string, SessionView> } | null = null;

  function redraw() {
    if (lifetime.signal.aborted || !lastSessions) return;
    const { agentIds, sessions } = lastSessions;
    for (const agentId of agentIds) {
      // Each session draws on its own; one that fails keeps its last bar and the others go on.
      try {
        render(agentId, sessions[agentId] ?? { mode: "all", canToggle: false, links: [] });
      } catch (error) {
        console.error(`trail: could not draw the bar for ${agentId}`, error);
      }
    }
  }

  function render(agentId: string, view: SessionView) {
    const workspaceId = workspaceByAgent.get(agentId);
    if (!workspaceId) return;
    const desired = desiredPills(agentId, workspaceId, view);
    const current = shown.get(agentId) ?? [];
    const sameKeys =
      current.length === desired.length && current.every((pill, index) => pill.key === desired[index].key);
    if (sameKeys) {
      // Update only pills whose data changed: replacing a behavior closes that pill's open menu,
      // and MR statuses refresh every minute.
      desired.forEach((pill, index) => {
        if (current[index].signature === pill.signature) return;
        current[index].pill.update(pill.button);
        current[index].signature = pill.signature;
      });
      return;
    }
    clearPills(agentId);
    // Pills keep registration order, so re-adding the whole set keeps the main task in front.
    shown.set(
      agentId,
      desired.map((pill, index) => ({
        key: pill.key,
        signature: pill.signature,
        pill: client.addComposerPill({ id: `link-${index}`, workspaceId, agentId, button: pill.button }),
      })),
    );
  }

  // GitLab only shows what is pushed, so a task doc with a working copy also offers the local
  // files. Both submenus list the whole bundle: the task doc first, then its sibling docs.
  // `view` is given for the task pill, whose menu also switches the session between modes.
  function linkBehavior(
    link: SessionLink,
    workspaceId: string,
    agentId: string,
    view?: SessionView,
  ): PluginButtonBehavior {
    const toggle: PluginButtonMenuEntry[] = view?.canToggle
      ? [
          {
            kind: "item",
            id: "mode",
            title: view.mode === "task" ? t("task.showAll") : t("task.showTask"),
            icon: view.mode === "task" ? "ListPlus" : "ListFilter",
            behavior: { kind: "action", onPress: () => setMode(agentId, view.mode === "task" ? "all" : "task") },
          },
          { kind: "separator", id: "after-mode" },
        ]
      : [];
    if (!link.localPath) {
      // A task ID with no tracker URL (`task:ABC-12`) has no page to open, only the mode toggle.
      const page = openableUrl(link.url, link.url);
      if (!page) return { kind: "menu", items: toggle.filter((entry) => entry.kind === "item") };
      if (toggle.length === 0) return { kind: "action", onPress: () => openExternalUrl(page) };
      return {
        kind: "menu",
        items: [
          ...toggle,
          {
            kind: "item",
            id: "open",
            title: remoteName(page) ? t("task.openRemote", { forge: remoteName(page) ?? "" }) : t("task.openPage"),
            icon: "Globe",
            behavior: { kind: "action", onPress: () => openExternalUrl(page) },
          },
        ],
      };
    }
    const docs: Array<{ file: string | undefined; title: string }> = [
      // A task link's title is its path below the configured root; the last segment is README.md or <slug>.md.
      { file: undefined, title: link.title.split("/").pop() ?? link.title },
      ...(link.bundle ?? []).map((file) => ({ file, title: file })),
    ];
    const submenu = (onPress: (file: string | undefined) => void): PluginButtonBehavior => ({
      kind: "menu",
      items: docs.map((doc, index) => ({
        kind: "item" as const,
        id: `doc-${index}`,
        title: doc.title,
        icon: "FileText",
        behavior: { kind: "action" as const, onPress: () => onPress(doc.file) },
      })),
    });
    return {
      kind: "menu",
      items: [
        ...toggle,
        {
          kind: "item",
          id: "local",
          title: t("task.viewLocal"),
          icon: "FolderOpen",
          behavior: submenu((file) =>
            openLocal(agentId, workspaceId, file === undefined ? { kind: "task" } : { kind: "bundle", file }),
          ),
        },
        // A project without `remoteUrl` gives the task a file:// identity; there is no page to open.
        ...(link.url.startsWith("http") ? [{
          kind: "item" as const,
          id: "gitlab",
          title: remoteName(link.url) ? t("task.openRemote", { forge: remoteName(link.url) ?? "" }) : t("task.openPage"),
          icon: "Globe",
          // Bundle files sit beside the task's README.md, so their pages share its folder URL.
          behavior: submenu((file) =>
            // A callback, so `$` in a file name is not read as a replacement pattern, and each path
            // segment encoded, so spaces and `#` stay part of the name.
            openExternalUrl(
              file === undefined
                ? link.url
                : link.url.replace(/README\.md$/, () => file.split("/").map(encodeURIComponent).join("/")),
            ),
          ),
        }] : []),
      ],
    };
  }

  async function refresh() {
    if (lifetime.signal.aborted) return;
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      const agentIds = [...workspaceByAgent.keys()];
      if (agentIds.length > 0) {
        // Token statuses come in on their own: a slow check never holds the links back, and the
        // bars are drawn again when it lands.
        void refreshCredentials().then((changed) => changed && redraw());
        const { sessions, language } = await client.rpc(listLinksRpc, { agentIds });
        t = translator(client, language);
        languageKey = `${language}:${client.i18n.locale}`;
        lastSessions = { agentIds, sessions };
        redraw();
        const unknownForge = Object.values(sessions).some((view) =>
          view.links.some((link) => link.kind === "mr" && !credentials.some((status) => status.id === credentialIdOf(link))),
        );
        if (unknownForge) void refreshCredentials(true).then((changed) => changed && redraw());
      }
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("trail: refresh failed", error);
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  }

  function scheduleRefresh() {
    clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), UPDATE_DEBOUNCE_MS);
  }

  function untrack(agentId: string) {
    workspaceByAgent.delete(agentId);
    clearPills(agentId);
  }

  function track(agent: AgentLike) {
    if (agent.archivedAt || !agent.workspaceId) return untrack(agent.id);
    workspaceByAgent.set(agent.id, agent.workspaceId);
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }: { subscription: any }) => {
      subscription.subscribe({
        snapshot: ({ entries }: { entries: Array<{ agent: AgentLike }> }) => {
          const present = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...workspaceByAgent.keys()]) {
            if (!present.has(agentId)) untrack(agentId);
          }
          for (const { agent } of entries) track(agent);
          void refresh();
        },
        update: (message: any) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") track(update.agent);
          else untrack(update.agentId);
          scheduleRefresh();
        },
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("trail: agent observation failed", error);
    });

  const poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);

  return {
    refresh: () => void refresh(),
    stop: () => {
      lifetime.abort();
      clearInterval(poll);
      clearTimeout(debounce);
      for (const agentId of [...shown.keys()]) clearPills(agentId);
    },
  };
}
