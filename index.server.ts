import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Credentials, gitLabCredentialId, normalizeHost } from "./server/credentials";
import { HostTracker } from "./server/host-tracker";
import { detectEnvironment, MCP_SCRIPT_NAME } from "./server/environment";
import { parseMergeRequestUrl, reportedLink, taskDocRules } from "./server/extract";
import { Forges } from "./server/forges";
import { GitHub } from "./server/github";
import { GitLab } from "./server/gitlab";
import { mergeCatalogs, readCatalog, type ProjectCandidate } from "./server/mr-refs";
import { isReallyInside, readTextFile, setBounded } from "./server/files";
import { ProjectConfigs, resolveIn, type LoadedConfig } from "./server/project-config";
import { scanTimeline, type TimelineItemLike } from "./server/scan";
import { LinkStore, type LinkContext } from "./server/store";
import {
  COMMAND_RESULT_KIND,
  credentialStatusRpc,
  pinLinkRpc,
  reportCommandRpc,
  preferences,
  setTokenRpc,
  setModeRpc,
  type DisplayMode,
  listLinksRpc,
  mergeMergeRequestRpc,
  readTaskDocRpc,
  rebaseMergeRequestRpc,
  type SessionLink,
} from "./shared/links";

const MCP_SERVER = "trail";
const MCP_TOOL = "pin_link";
// Providers known to accept stdio MCP servers; others would fail agent creation.
const MCP_PROVIDERS = new Set(["claude", "codex"]);
const SCAN_WINDOW = 300;
// The file view shows source and docs, not build output or media.
const MAX_FILE_BYTES = 512 * 1024;
// A branch changes rarely; re-reading it on every poll would spawn git every few seconds.
const BRANCH_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 3_000;
// A turn can run for many minutes; files and links it produces should not wait for its end.
const MID_TURN_SCAN_MS = 30_000;
const MAX_CONCURRENT_SCANS = 2;
// A turn that never reports its end (a crashed provider, a lost event) stops being polled after this.
const MAX_MID_TURN_SCAN_MS = 3 * 60 * 60_000;
// GitLab hosts seen only in conversations are tracked for Settings, but not without bound.
const MAX_UNLISTED_HOSTS = 10;
const UNLISTED_HOST_TTL_MS = 24 * 60 * 60_000;
const STORED_HOSTS_REFRESH_MS = 60_000;
// The MCP server runs on the daemon's own runtime, so no `node` has to be on the agent's PATH.
// The desktop app's daemon is an Electron binary, which acts as Node only when told to.
const MCP_RUNTIME = existsSync(process.execPath)
  ? { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} }
  : { command: "node", env: {} };

export default function contribute(server: PluginServerContext) {
  const environment = detectEnvironment();
  const mcpScript = environment.pluginDir && join(environment.pluginDir, "bin", MCP_SCRIPT_NAME);
  const store = new LinkStore(environment.stateDir);
  const credentials = new Credentials(environment.secretsDir);
  // GitHub needs no configuration, so its token can be set before any PR shows up.
  credentials.requireGitHub();
  const forges = new Forges(new GitLab(credentials), new GitHub(credentials));
  const configs = new ProjectConfigs(environment.personalConfig);
  const settings = server.registerSettings(preferences);
  let defaultMode: DisplayMode = "task";
  let language: "app" | "en" | "vi" = "app";
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    defaultMode = state.values.defaultMode;
    language = state.values.language;
  };
  settings
    .read()
    .then(applySettings)
    .catch((error: unknown) => console.error("trail: could not read settings", error));
  const stopSettings = settings.subscribe(applySettings);
  // The project config is looked up from each agent's working directory.
  const cwdByAgent = new Map<string, string>();
  const titleByAgent = new Map<string, string>();
  const branches = new Map<string, { branch: string | null; expiresAt: number }>();

  async function branchOf(cwd: string | undefined): Promise<string | null> {
    if (!cwd) return null;
    const cached = branches.get(cwd);
    if (cached && cached.expiresAt > Date.now()) return cached.branch;
    let branch: string | null = null;
    try {
      const { stdout } = await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: GIT_TIMEOUT_MS,
      });
      branch = stdout.trim() || null;
    } catch {
      // Not a git checkout; the title may still carry the ID.
    }
    setBounded(branches, cwd, { branch, expiresAt: Date.now() + BRANCH_TTL_MS });
    return branch;
  }
  console.log(`trail: ${JSON.stringify(environment)}`);

  // The catalog is rebuilt only when the config or one of its catalog files changes, so the same
  // array (and the index built for it) serves every poll in between.
  const catalogs = new WeakMap<object, { parts: unknown[]; catalog: Array<ProjectCandidate & { name: string }> }>();

  function catalogFor(loaded: LoadedConfig | null): Array<ProjectCandidate & { name: string }> {
    if (!loaded) return [];
    const parts = loaded.config.gitlab.flatMap((entry) => [
      Object.entries(entry.projects).map(([name, project]) => ({ name, project, host: entry.host })),
      entry.projectCatalog
        ? readCatalog({
            ...entry.projectCatalog,
            file: resolveIn(loaded.projectRoot, entry.projectCatalog.file),
            host: entry.host,
            ...(loaded.personal ? {} : { root: loaded.projectRoot }),
          })
        : [],
    ]);
    const cached = catalogs.get(loaded.config);
    // Named projects are rebuilt each time but compared by content; catalog files by identity.
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    if (cached && cached.parts.length === parts.length && cached.parts.every((part, i) => same(part, parts[i]))) {
      return cached.catalog;
    }
    const catalog = mergeCatalogs(parts);
    catalogs.set(loaded.config, { parts, catalog });
    return catalog;
  }

  function contextFor(agentId: string): LinkContext {
    const loaded = configs.forDirectory(cwdByAgent.get(agentId) ?? null);
    const gitlabs = loaded?.config.gitlab ?? [];
    return {
      rules: taskDocRules(loaded, configs.personal()),
      catalog: catalogFor(loaded),
      defaultHost: gitlabs.length === 1 ? gitlabs[0].host : undefined,
    };
  }

  // A GitLab host's token is declared once a config names the host, a token was pasted for it or
  // one of its MRs appears, so Settings can show it. Where its token may be read from comes from
  // the personal config alone; see Credentials for why other hosts get none.
  // Hosts the user did not set up are tracked in two pools, so a project file naming many hosts
  // cannot crowd out the ones seen in conversations, or the other way round.
  const unlistedHosts = {
    project: new HostTracker(MAX_UNLISTED_HOSTS, UNLISTED_HOST_TTL_MS),
    link: new HostTracker(MAX_UNLISTED_HOSTS, UNLISTED_HOST_TTL_MS),
  };
  let storedHosts = new Set<string>();
  const refreshStoredHosts = async () => {
    storedHosts = new Set(await credentials.storedGitLabHosts());
  };
  void refreshStoredHosts();
  const storedHostsTimer = setInterval(() => void refreshStoredHosts(), STORED_HOSTS_REFRESH_MS);

  function requireHosts(agentId: string, links: SessionLink[]): void {
    const project = configs.forDirectory(cwdByAgent.get(agentId) ?? null);
    const personal = configs.personal();
    const seenHosts = links.flatMap((link) => {
      const host = link.kind === "mr" ? parseMergeRequestUrl(link.url)?.host : undefined;
      return host ? [host] : [];
    });
    const named = [...(personal?.config.gitlab ?? []), ...(project?.config.gitlab ?? [])].map((entry) => entry.host);
    const now = Date.now();
    const projectHosts = new Set(project && !project.personal ? project.config.gitlab.map((entry) => entry.host) : []);
    // GITLAB_HOST is the user's own setting (gitlab.com when unset), so its host is never limited.
    const environmentHost = normalizeHost(process.env.GITLAB_HOST) ?? "gitlab.com";
    for (const host of new Set([...named, ...storedHosts, ...seenHosts])) {
      const entry = personal?.config.gitlab.find((candidate) => candidate.host === host);
      const origin = entry
        ? { kind: "personal" as const }
        : storedHosts.has(host)
          ? { kind: "stored" as const }
          : projectHosts.has(host) && project
            ? { kind: "project" as const, file: project.file }
            : { kind: "link" as const };
      if (!entry && !storedHosts.has(host) && host !== environmentHost) {
        // Hosts already tracked stay tracked; a new one is tracked only while there is room, so
        // the set never churns. Past the limit a host is shown as such and never contacted.
        const pool = origin.kind === "project" ? unlistedHosts.project : unlistedHosts.link;
        if (pool.see(host, now) === "overLimit") {
          credentials.requireOverLimit(host, origin);
          continue;
        }
      }
      credentials.requireGitLab(
        host,
        entry && personal
          ? { tokenFiles: entry.tokenFiles.map((file) => resolveIn(dirname(personal.file), file)), tokenKey: entry.tokenKey }
          : undefined,
        origin,
      );
    }
    pruneUnlistedHosts(now, personal?.config.gitlab.map((entry) => entry.host) ?? []);
  }

  // Only time frees a tracked host: one not seen for a day is dropped, which makes room again.
  function pruneUnlistedHosts(now: number, listed: string[]): void {
    const keep = (host: string) => listed.includes(host) || storedHosts.has(host);
    const dropped = [unlistedHosts.project, unlistedHosts.link].flatMap((pool) => pool.prune(now, keep));
    // A host both pools know stays declared while either one still holds it.
    for (const host of new Set(dropped)) {
      if (!unlistedHosts.project.holds(host) && !unlistedHosts.link.holds(host)) credentials.drop(gitLabCredentialId(host));
    }
  }

  async function linksFor(agentId: string): Promise<SessionLink[]> {
    const taskIdSources = [await branchOf(cwdByAgent.get(agentId)), titleByAgent.get(agentId)];
    const links = await store.links(agentId, { ...contextFor(agentId), taskIdSources });
    requireHosts(agentId, links);
    return links;
  }

  // One scan per agent at a time; a turn that ends mid-scan queues exactly one rerun.
  const running = new Map<string, { rerun: boolean }>();
  const waiting: Array<() => void> = [];
  let active = 0;
  const scannedThisRun = new Set<string>();

  async function acquireSlot() {
    if (active < MAX_CONCURRENT_SCANS) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  // Set when the plugin unloads, so queued and repeating scans stop instead of running on.
  let disposed = false;

  function scan(paseo: PluginHandlerContext["paseo"], agentId: string): void {
    if (disposed) return;
    scannedThisRun.add(agentId);
    const current = running.get(agentId);
    if (current) {
      current.rerun = true;
      return;
    }
    const state = { rerun: false };
    running.set(agentId, state);
    void (async () => {
      do {
        state.rerun = false;
        await acquireSlot();
        if (disposed) {
          releaseSlot();
          break;
        }
        try {
          const agent = paseo.agents.ref(agentId);
          const page = await agent.timeline.refetch({ direction: "tail", limit: SCAN_WINDOW });
          // A refetch also delivers the agent snapshot, which carries its working directory.
          if (agent.cwd) cwdByAgent.set(agentId, agent.cwd);
          const title = (agent.current() as { title?: string | null } | null)?.title;
          if (title) titleByAgent.set(agentId, title);
          const items = page.entries.map((entry: { item: TimelineItemLike }) => entry.item);
          await store.saveScan(agentId, scanTimeline(items, contextFor(agentId).rules));
        } catch (error) {
          console.error(`trail: scan failed for ${agentId}`, error);
        } finally {
          releaseSlot();
        }
      } while (state.rerun);
      running.delete(agentId);
    })();
  }

  server.handle(listLinksRpc, async ({ agentIds }, { paseo }) => {
    const sessions: Record<string, { mode: DisplayMode; canToggle: boolean; links: SessionLink[] }> = {};
    for (const agentId of agentIds) {
      // One session's broken state must not empty the bar of every other session.
      try {
        // History before this daemon run (or before the plugin was installed) is read once, lazily.
        if (!scannedThisRun.has(agentId)) scan(paseo, agentId);
        // MR status comes from a cache refreshed in the background, so polling never waits on GitLab.
        const taskLinks = (await linksFor(agentId)).map((link) =>
          link.kind === "mr" ? withStatus(link, forges.cachedStatus(link.url)) : link,
        );
        // Without a task there is nothing to narrow to, so the session shows everything.
        const canToggle = taskLinks.some((link) => link.kind === "task");
        const mode = canToggle ? ((await store.mode(agentId)) ?? defaultMode) : "all";
        const links = mode === "all" ? [...taskLinks, ...(await store.otherLinks(agentId, taskLinks))] : taskLinks;
        sessions[agentId] = { mode, canToggle, links };
      } catch (error) {
        console.error(`trail: links failed for ${agentId}`, error);
        sessions[agentId] = { mode: "all", canToggle: false, links: [] };
      }
    }
    return { language, sessions };
  });

  server.handle(pinLinkRpc, async ({ agentId, target, label, unpin }) => {
    if (unpin) return { removed: await store.unpin(agentId, target) };
    // The same recognition as the pin_link tool: task doc path or ID, MR/PR, or any http(s) URL.
    const link = reportedLink(target, undefined, label, contextFor(agentId).rules);
    if (!link) throw new Error(`Not a link Trail can pin: ${target}`);
    await store.pin(agentId, { target, kind: link.kind, label, primary: link.kind === "task" }, target);
    return {};
  });

  // Slash commands have no success feedback of their own, so a confirmation row goes into the
  // conversation. It is drawn by the client and never sent to the agent's provider.
  server.handle(reportCommandRpc, async ({ agentId, result }, { paseo }) => {
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: `command-${Date.now()}`,
      kind: COMMAND_RESULT_KIND,
      version: 1,
      data: result,
    });
    return {};
  });

  server.handle(setModeRpc, async ({ agentId, mode }) => {
    await store.setMode(agentId, mode);
    return {};
  });

  async function requireAgentMergeRequest(agentId: string, url: string): Promise<void> {
    const links = await linksFor(agentId);
    if (!links.some((link) => link.kind === "mr" && link.url === url)) {
      throw new Error(`Not one of this session's merge requests: ${url}`);
    }
  }

  server.handle(rebaseMergeRequestRpc, async ({ agentId, url }) => {
    await requireAgentMergeRequest(agentId, url);
    await forges.rebase(url);
    return {};
  });

  server.handle(mergeMergeRequestRpc, async ({ agentId, url, sha, squash, removeSourceBranch }) => {
    await requireAgentMergeRequest(agentId, url);
    return { state: await forges.merge(url, sha, { squash, removeSourceBranch }) };
  });

  server.handle(readTaskDocRpc, async ({ agentId, file, path: requested }) => {
    const task = await store.mainTask(agentId, contextFor(agentId));
    const bundle = task?.bundle ?? [];
    // Only paths the daemon listed itself are readable, so the client cannot name arbitrary files.
    let path: string | undefined;
    if (requested !== undefined) {
      if (!(await store.sessionFiles(agentId)).includes(requested)) {
        throw new Error(`Not a file this session touched: ${requested}`);
      }
      path = requested;
    } else if (task?.localPath) {
      if (file !== undefined && !bundle.includes(file)) throw new Error(`Not in the task bundle: ${file}`);
      path = file === undefined ? task.localPath : join(dirname(task.localPath), file);
      // Bundle names are listed by the daemon, but a name like `..` or a symlink would still leave
      // the folder, so the resolved path must stay inside the task's own folder.
      if (!(await isReallyInside(dirname(task.localPath), path))) throw new Error(`Not in the task folder: ${file}`);
    }
    if (!path) return { path: null, bundle: [], text: null, modifiedAt: null };
    // Size is counted while reading: a device or FIFO reports none, and is not a file anyway.
    const read = await readTextFile(path, MAX_FILE_BYTES);
    if (!read || read.kind === "notFile") {
      return { path, bundle, text: null, modifiedAt: null, notShown: { reason: "unreadable" as const, limitKb: 0 } };
    }
    const modifiedAt = read.modifiedAt.toISOString();
    if (read.kind === "tooLarge") {
      return { path, bundle, text: null, modifiedAt, notShown: { reason: "tooLarge" as const, limitKb: MAX_FILE_BYTES / 1024 } };
    }
    if (read.text.includes("\u0000")) return { path, bundle, text: null, modifiedAt, notShown: { reason: "binary" as const, limitKb: 0 } };
    return { path, bundle, text: read.text, modifiedAt };
  });

  server.handle(setTokenRpc, async ({ id, token }) => {
    await credentials.store(id, token);
    await refreshStoredHosts();
    return {};
  });

  server.handle(credentialStatusRpc, async () => ({
    credentials: await credentials.statuses(),
    environment: { pluginDir: environment.pluginDir, stateDir: environment.stateDir },
    configs: {
      loaded: configs.known().loaded.map(({ file }) => file),
      problems: configs.known().problems,
      personalFile: environment.personalConfig,
    },
  }));

  const midTurnScans = new Map<string, ReturnType<typeof setInterval>>();

  function stopMidTurnScan(agentId: string) {
    clearInterval(midTurnScans.get(agentId));
    midTurnScans.delete(agentId);
  }

  server.on("agent.turn_started", (event, { paseo }) => {
    cwdByAgent.set(event.agent.id, event.agent.cwd);
    const agentId = event.agent.id;
    stopMidTurnScan(agentId);
    const startedAt = Date.now();
    midTurnScans.set(
      agentId,
      setInterval(() => {
        if (Date.now() - startedAt > MAX_MID_TURN_SCAN_MS) stopMidTurnScan(agentId);
        else scan(paseo, agentId);
      }, MID_TURN_SCAN_MS),
    );
  });

  server.on("agent.turn_ended", (event, { paseo }) => {
    stopMidTurnScan(event.agent.id);
    cwdByAgent.set(event.agent.id, event.agent.cwd);
    if (event.agent.title) titleByAgent.set(event.agent.id, event.agent.title);
    scan(paseo, event.agent.id);
  });

  // A closed or archived agent's in-memory state goes; its state files stay for when it reopens.
  function forgetAgent(agentId: string) {
    stopMidTurnScan(agentId);
    cwdByAgent.delete(agentId);
    titleByAgent.delete(agentId);
    scannedThisRun.delete(agentId);
    store.forget(agentId);
  }

  server.on("agent.closed", (event) => forgetAgent(event.agent.id));
  server.on("agent.archived", (event) => forgetAgent(event.agent.id));

  server.before("agent.create", ({ request }) => {
    const provider = request.config.provider.split("/")[0];
    if (!MCP_PROVIDERS.has(provider) || !mcpScript || !existsSync(mcpScript)) return request;
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_SERVER]: {
            type: "stdio",
            ...MCP_RUNTIME,
            args: [mcpScript],
            env: { ...MCP_RUNTIME.env, TRAIL_STATE_DIR: environment.stateDir },
          },
        },
        toolPolicy: {
          ...request.config.toolPolicy,
          preapproved: [
            ...(request.config.toolPolicy?.preapproved ?? []),
            { kind: "mcp", server: MCP_SERVER, tool: MCP_TOOL },
          ],
        },
      },
    };
  });

  return () => {
    disposed = true;
    clearInterval(storedHostsTimer);
    forges.dispose();
    stopSettings();
    for (const agentId of [...midTurnScans.keys()]) stopMidTurnScan(agentId);
  };
}

function withStatus(link: SessionLink, status: SessionLink["status"]): SessionLink {
  return status ? { ...link, status } : link;
}

