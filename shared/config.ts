import { z } from "zod";

// A project file is matched against chat text on every poll; these bounds keep that work small
// however the file is written.
export const LIMITS = {
  taskDocs: 32,
  globLength: 256,
  globSegments: 16,
  globSpans: 2,
  text: 256,
  url: 2048,
  projects: 500,
  gitlabHosts: 16,
} as const;

const shortText = z.string().max(LIMITS.text);

/**
 * A forge project path as Trail accepts it everywhere, in links, references and config: one or
 * more segments of letters, digits, `_`, `.` and `-`, none of them `.` or `..`.
 */
export function isProjectPath(path: string): boolean {
  return path.split("/").every((segment) => /^[\w.-]+$/.test(segment) && segment !== "." && segment !== "..");
}

/** A GitHub owner: letters, digits and single inner hyphens, never a dot. */
export const GITHUB_OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";

const projectPath = shortText.refine((path) => path.includes("/") && isProjectPath(path), {
  message: "a project path is group/name, without spaces, `.` or `..` segments",
});

/**
 * A host as an https URL writes it: lowercase, an optional port, default port dropped. Anything
 * else is refused, notably `user@host` forms (`gitlab.example.com:443@evil.example` would send a
 * token to `evil.example`) and paths or spaces.
 */
export function canonicalHostName(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  try {
    const url = new URL(`https://${host}`);
    return url.username === "" && url.pathname === "/" && url.host !== "" ? url.host : null;
  } catch {
    return null;
  }
}

const hostName = z
  .string()
  .max(LIMITS.text)
  .transform((value, context) => {
    const host = canonicalHostName(value);
    if (host === null) {
      context.addIssue({ code: "custom", message: `not a host name: ${value}` });
      return z.NEVER;
    }
    return host;
  });
// A link template: an http(s) URL once its `{path}` or `{id}` placeholder is filled in.
const url = z
  .string()
  .max(LIMITS.url)
  .refine(
    (template) => {
      try {
        return ["http:", "https:"].includes(new URL(template.replace(/\{(path|id)\}/g, "x")).protocol);
      } catch {
        return false;
      }
    },
    { message: "must be an http(s) URL" },
  );

/**
 * Project file `.paseo/trail/config.json`, found by walking up from an agent's working
 * directory. Everything specific to one team's layout lives here, so the plugin itself only
 * knows generic link shapes. Relative paths resolve against the directory that holds `.paseo`.
 */
export const projectConfigSchema = z.object({
  /** How to recognise the document a session is working on, and what counts as related to it. */
  focus: z
    .object({
      /** Directory the globs and the remote URL are relative to. */
      root: shortText.default("."),
      /** Globs for task documents; `*` matches one path segment and never crosses `/`. */
      taskDocs: z
        .array(
          z
            .string()
            .min(1)
            .max(LIMITS.globLength)
            // `**/**` means the same as `**`; one is kept so the matcher never walks a run of them.
            .transform((glob) => glob.split("/").filter((segment, i, all) => !(segment === "**" && all[i - 1] === "**")).join("/"))
            .refine((glob) => glob.split("/").length <= LIMITS.globSegments, {
              message: `a glob has at most ${LIMITS.globSegments} path segments`,
            })
            .refine((glob) => glob.split("/").filter((segment) => segment === "**").length <= LIMITS.globSpans, {
              message: `a glob has at most ${LIMITS.globSpans} \`**\``,
            })
            // A task doc is a file, so the last segment names one; this also lets matching reject
            // most words on their last segment before anything else.
            .refine((glob) => !["", "**"].includes(glob.split("/").pop() ?? ""), {
              message: "a glob ends with a file name pattern, not `**`",
            }),
        )
        .max(LIMITS.taskDocs)
        .default([]),
      /**
       * A task ID read from the agent's git branch or title, for projects that track work in an
       * issue tracker rather than in docs. Used when no task doc is found.
       */
      taskId: z
        .object({
          /** JavaScript regular expression; the first capture group is the ID when present. */
          pattern: shortText,
          /** Issue page; `{id}` is replaced with the ID. */
          url: url.optional(),
        })
        .optional(),
      /** Page of a task doc on the forge; `{path}` is the doc path relative to `root`. */
      remoteUrl: url.optional(),
      /** Heading whose links belong to the task, such as `Related`; omitted means the whole doc. */
      relatedSection: shortText.optional(),
      /** `siblings`: other Markdown files in a `<name>/README.md` task's folder belong to the task. */
      bundle: z.enum(["siblings", "none"]).default("none"),
    })
    .optional(),
  /** Self-hosted GitLab instances and where their tokens live. gitlab.com needs no entry. */
  gitlab: z
    .array(
      z.object({
        host: hostName,
        /**
         * `KEY=value` files searched before the environment and `glab`, in order. Personal config
         * only: a project file that sets them is rejected, so a cloned project cannot choose which
         * local file is read and sent to its host.
         */
        tokenFiles: z.array(shortText).max(8).default([]),
        /** The variable name in those files; letters, digits and underscores only. */
        tokenKey: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default("GITLAB_TOKEN"),
        /** Short names for `name !N` references: project path by name. */
        projects: z
          .record(shortText, projectPath)
          .refine((projects) => Object.keys(projects).length <= LIMITS.projects, {
            message: `at most ${LIMITS.projects} projects`,
          })
          .default({}),
        /** A JSON file listing projects, for teams that already keep one. Fields are dot paths. */
        projectCatalog: z
          .object({
            file: shortText,
            items: shortText,
            name: shortText.default("name"),
            project: shortText.default("project"),
          })
          .optional(),
      }),
    )
    .max(LIMITS.gitlabHosts)
    .refine((entries) => new Set(entries.map((entry) => entry.host)).size === entries.length, {
      message: "each GitLab host is listed once",
    })
    .default([]),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const PROJECT_CONFIG_PATH = ".paseo/trail/config.json";
