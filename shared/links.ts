import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Every field falls back to a neutral value: forges send null or omit fields now and then, and the
// app validates each RPC answer as a whole, so one odd request would otherwise empty every bar.
export const mergeRequestStatusSchema = z.object({
  state: z.enum(["opened", "merged", "closed", "locked"]).catch("opened"),
  draft: z.boolean().catch(false),
  /** GitLab's `detailed_merge_status`, e.g. mergeable, not_approved, need_rebase, conflict. */
  mergeStatus: z.string().catch("unknown"),
  hasConflicts: z.boolean().catch(false),
  /** Commits on the target branch that the source branch lacks. */
  behind: z.number().catch(0),
  pipeline: z.object({ status: z.string(), url: z.string() }).nullable().catch(null),
  approved: z.boolean().catch(false),
  approvedBy: z.array(z.string()).catch([]),
  sourceBranch: z.string().catch(""),
  targetBranch: z.string().catch(""),
  /** Head commit the status describes; merge is refused if the branch moved since. Empty when unknown. */
  sha: z.string().catch(""),
  squash: z.boolean().catch(false),
  removeSourceBranch: z.boolean().catch(false),
  fetchedAt: z.string().catch(""),
});

export type MergeRequestStatus = z.infer<typeof mergeRequestStatusSchema>;

export const sessionLinkSchema = z.object({
  url: z.string(),
  /** `file` is a local file the agent touched; `doc` a page on a document or design tool. */
  kind: z.enum(["task", "mr", "file", "doc", "link"]),
  label: z.string(),
  title: z.string(),
  /** For a `file` link: the agent changed it, not only read it. */
  edited: z.boolean().optional(),
  /** Absolute path of a task doc's working copy on the daemon host, when it exists. */
  localPath: z.string().optional(),
  /** Other Markdown files in the task's bundle folder, relative to it; README.md excluded. */
  bundle: z.array(z.string()).optional(),
  /** Last known GitLab state of an MR link; absent until the first fetch succeeds. */
  status: mergeRequestStatusSchema.optional(),
});

export type SessionLink = z.infer<typeof sessionLinkSchema>;

/** `task`: only what belongs to the session's task. `all`: every link the session touched. */
/**
 * Paseo agent ids are UUIDs. State files are named after them, so anything else (a path
 * separator, `..`) is refused before it can reach the file system.
 */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const agentIdSchema = z.string().regex(AGENT_ID_PATTERN);

export const displayModeSchema = z.enum(["task", "all"]);

export type DisplayMode = z.infer<typeof displayModeSchema>;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    defaultMode: displayModeSchema.default("task"),
    /** `app` follows Paseo's language; the others override it, since Paseo has no Vietnamese. */
    language: z.enum(["app", "en", "vi"]).default("app"),
  }),
});

// Links come back already ordered for display: main task first, then MRs, then everything else.
// `mode` is what the session shows; `canToggle` is false when there is no task to narrow to.
export const listLinksRpc = defineRpc({
  name: "links.list",
  input: z.object({ agentIds: z.array(agentIdSchema) }),
  output: z.object({
    /** The interface language chosen in settings, so non-React code can word labels in it. */
    language: z.enum(["app", "en", "vi"]),
    sessions: z.record(
      z.string(),
      z.object({ mode: displayModeSchema, canToggle: z.boolean(), links: z.array(sessionLinkSchema) }),
    ),
  }),
});

/** Pins or unpins a link for one session, the way the agent's `pin_link` tool does. */
export const pinLinkRpc = defineRpc({
  name: "links.pin",
  input: z.object({ agentId: agentIdSchema, target: z.string().min(1), label: z.string().optional(), unpin: z.boolean() }),
  /** For an unpin: whether there was such a pin. */
  output: z.object({ removed: z.boolean().optional() }),
});

/** What a `/trail` command did, for the confirmation row it leaves in the conversation. */
export const commandResultSchema = z.object({
  /**
   * `status` answers a bare or unrecognised `/trail` with the session's state and the commands;
   * `nothingToCopy`, `notPinnable` and `notPinned` explain a command that had nothing to act on.
   */
  code: z.enum(["modeAll", "modeTask", "pinned", "unpinned", "copied", "status", "nothingToCopy", "notPinnable", "notPinned"]),
  /** Language-neutral details the client words: a pinned target, a link count. */
  values: z.record(z.string(), z.union([z.string(), z.number()])),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

export const COMMAND_RESULT_KIND = "trail-command";

export const reportCommandRpc = defineRpc({
  name: "command.report",
  input: z.object({ agentId: agentIdSchema, result: commandResultSchema }),
  output: z.object({}),
});

export const setModeRpc = defineRpc({
  name: "mode.set",
  input: z.object({ agentId: agentIdSchema, mode: displayModeSchema }),
  output: z.object({}),
});

// Reads only the agent's task doc, its bundle or files the agent touched, so the client cannot
// name an arbitrary path.
export const readTaskDocRpc = defineRpc({
  name: "doc.read",
  /**
   * `file` picks a bundle file by its relative path, `path` a local file the agent touched;
   * neither means the task doc itself.
   */
  input: z.object({ agentId: agentIdSchema, file: z.string().optional(), path: z.string().optional() }),
  output: z.object({
    path: z.string().nullable(),
    bundle: z.array(z.string()),
    text: z.string().nullable(),
    modifiedAt: z.string().nullable(),
    /** Why `text` is null for a file that exists: too large, or not text. */
    notShown: z.object({ reason: z.enum(["tooLarge", "binary", "unreadable"]), limitKb: z.number() }).optional(),
  }),
});


// MR actions name the MR by URL and the agent whose links contain it; the daemon refuses any
// other MR, so the client cannot act on arbitrary projects with the user's token.
const mergeRequestActionInput = z.object({ agentId: agentIdSchema, url: z.string() });

export const rebaseMergeRequestRpc = defineRpc({
  name: "mr.rebase",
  input: mergeRequestActionInput,
  output: z.object({}),
});

export const mergeMergeRequestRpc = defineRpc({
  name: "mr.merge",
  /** `squash` and `removeSourceBranch` are what the confirmation showed; a merge with others is refused. */
  input: mergeRequestActionInput.extend({ sha: z.string(), squash: z.boolean(), removeSourceBranch: z.boolean() }),
  output: z.object({ state: z.string() }),
});

/** A place a credential is looked for; the client words it in the user's language. */
export const credentialSourceSchema = z.discriminatedUnion("type", [
  /** Pasted in Settings and kept by the daemon; the value never travels back to a client. */
  z.object({ type: z.literal("stored") }),
  z.object({ type: z.literal("file"), path: z.string(), key: z.string() }),
  z.object({ type: z.literal("env"), name: z.string() }),
  z.object({ type: z.literal("cli"), command: z.string() }),
]);

export type CredentialSource = z.infer<typeof credentialSourceSchema>;

export const credentialStatusSchema = z.object({
  id: z.string(),
  kind: z.enum(["gitlab", "github"]),
  host: z.string(),
  /** missing: found nowhere · invalid: rejected · expiring: works but ends soon · unchecked: could not verify. */
  state: z.enum(["ok", "missing", "invalid", "expiring", "unchecked"]),
  /** Language-neutral reason; the client turns it into text. */
  detail: z.object({
    code: z.enum(["ok", "okExpires", "expiring", "unauthorized", "httpError", "unreachable", "redirected", "noScope", "malformed", "missing", "tooManyHosts"]),
    values: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
  /** `readOnly`: the token can read status but not rebase or merge. */
  limits: z.array(z.enum(["readOnly"])),
  /** Every place that was searched, in order. */
  checked: z.array(credentialSourceSchema),
  /** Where the value in use came from. */
  source: credentialSourceSchema.optional(),
  /**
   * Why Trail knows this host: your personal config, a token you pasted, a project's config file
   * (`file`), or only a link in a conversation. The last two are not the user's own word.
   */
  origin: z
    .object({ kind: z.enum(["personal", "stored", "project", "link"]), file: z.string().optional() })
    .optional(),
});

export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const setTokenRpc = defineRpc({
  name: "credentials.set-token",
  /** `token: null` forgets the saved token. */
  input: z.object({ id: z.string(), token: z.string().min(1).nullable() }),
  output: z.object({}),
});

export const credentialStatusRpc = defineRpc({
  name: "credentials.status",
  input: z.object({}),
  output: z.object({
    credentials: z.array(credentialStatusSchema),
    /** Paths the daemon resolved; null means not found, which disables the features that need it. */
    environment: z.object({
      pluginDir: z.string().nullable(),
      stateDir: z.string(),
    }),
    /** Project config files read so far, and the ones that could not be used. */
    configs: z.object({
      loaded: z.array(z.string()),
      problems: z.array(z.object({ file: z.string(), error: z.string() })),
      /** Used when no project file is found above the agent's working directory. */
      personalFile: z.string(),
    }),
  }),
});

/** Usable for reading; `canWrite` additionally requires that no limit was reported. */
export function isUsable(status: CredentialStatus | undefined): boolean {
  return status?.state === "ok" || status?.state === "expiring" || status?.state === "unchecked";
}
