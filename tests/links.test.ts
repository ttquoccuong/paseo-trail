import { describe, expect, it } from "vitest";
import {
  changeRequestLink,
  findChangeRequests,
  findTaskDocs,
  taskDocRules,
  taskIdLink,
  urlLink,
} from "../server/extract";
import { findMergeRequestRefs, resolveMergeRequestRefs } from "../server/mr-refs";
import { globMatches, type LoadedConfig } from "../server/project-config";
import { findUrls, mainScannedTask, scanTimeline } from "../server/scan";
import { projectConfigSchema } from "../shared/config";

function rules(focus: object) {
  const loaded: LoadedConfig = {
    file: "/project/.paseo/trail.json",
    projectRoot: "/project",
    personal: false,
    config: projectConfigSchema.parse({ focus }),
  };
  // The same file stands in for the personal config, which alone may set a task ID pattern.
  return taskDocRules(loaded, loaded);
}

const docs = rules({ taskDocs: ["tasks/*/README.md", "tasks/*.md"] });

describe("task docs", () => {
  it("finds a doc in prose and in an absolute path", () => {
    expect(findTaskDocs("see tasks/login-fix/README.md and /x/tasks/other.md", docs)).toEqual([
      "tasks/login-fix/README.md",
      "tasks/other.md",
    ]);
  });

  it("does not take a sibling file of a task folder for the task doc", () => {
    expect(findTaskDocs("tasks/login-fix/solution-review.md", docs)).toEqual([]);
  });

  it("keeps `*` inside one path segment", () => {
    expect(globMatches(["a", "*", "b.md"], ["a", "x", "y", "b.md"])).toBe(false);
    expect(globMatches(["a", "**", "b.md"], ["a", "x", "y", "b.md"])).toBe(true);
    expect(globMatches(["a", "**", "b.md"], ["a", "b.md"])).toBe(true);
  });

  it("makes a doc the main task only on strong evidence", () => {
    const read = scanTimeline([{ type: "tool_call", detail: { type: "read", filePath: "/p/tasks/a.md" } }], docs);
    expect(mainScannedTask(read)).toBeUndefined();
    const edited = scanTimeline([{ type: "tool_call", detail: { type: "edit", filePath: "/p/tasks/a.md" } }], docs);
    expect(mainScannedTask(edited)).toBe("tasks/a.md");
  });
});

describe("task IDs", () => {
  const ids = rules({ taskId: { pattern: "\\b([A-Z]+-\\d+)\\b", url: "https://jira.example/browse/{id}" } });

  it("reads the ID from the branch before the title", () => {
    expect(taskIdLink(["feature/ABC-12-login", "Fix XYZ-9"], ids)).toMatchObject({
      url: "https://jira.example/browse/ABC-12",
      label: "ABC-12",
    });
  });

  it("gives no task when nothing matches", () => {
    expect(taskIdLink(["main", "no ticket"], ids)).toBeNull();
  });
});

describe("merge and pull requests", () => {
  it("recognises GitLab on any host and GitHub", () => {
    expect(
      findChangeRequests(
        "https://gitlab.example.com/team/api/-/merge_requests/5 https://github.com/acme/web/pull/7",
      ),
    ).toEqual(["https://gitlab.example.com/team/api/-/merge_requests/5", "https://github.com/acme/web/pull/7"]);
    expect(changeRequestLink("https://github.com/acme/web/pull/7").label).toBe("#7 web");
  });

  it("finds references written without a URL", () => {
    expect(findMergeRequestRefs("`billing` !110, team/api!3 and acme/web#7")).toEqual([
      "team/api!3",
      "billing!110",
      "acme/web#7",
    ]);
  });

  it("resolves a name through the session, then the catalog, and drops what stays ambiguous", () => {
    const catalog = [
      { name: "users", project: "team/a/users", host: "gitlab.example.com" },
      { name: "users", project: "team/b/users", host: "gitlab.example.com" },
      { name: "events", project: "team/a/events", host: "gitlab.example.com" },
    ];
    const known = ["https://gitlab.example.com/team/a/users/-/merge_requests/1"];
    expect(resolveMergeRequestRefs(["users!2", "events!3"], known, catalog, "gitlab.example.com")).toEqual([
      "https://gitlab.example.com/team/a/users/-/merge_requests/2",
      "https://gitlab.example.com/team/a/events/-/merge_requests/3",
    ]);
    expect(resolveMergeRequestRefs(["users!2"], [], catalog, "gitlab.example.com")).toEqual([]);
  });

  it("drops a full path that mistypes a known project", () => {
    const known = ["https://gitlab.example.com/team/a/util/-/merge_requests/1"];
    expect(resolveMergeRequestRefs(["team/util!2"], known, [], "gitlab.example.com")).toEqual([]);
    expect(resolveMergeRequestRefs(["team/new!2"], known, [], "gitlab.example.com")).toEqual([
      "https://gitlab.example.com/team/new/-/merge_requests/2",
    ]);
  });
});

describe("other links", () => {
  it("treats a trailing slash and sentence punctuation as part of the sentence", () => {
    expect(findUrls("see https://a.example/ and https://a.example, then https://a.example/x/?q=1.")).toEqual([
      "https://a.example",
      "https://a.example",
      "https://a.example/x?q=1",
    ]);
  });

  it("groups document tools apart from other pages", () => {
    expect(urlLink("https://www.figma.com/design/abc").kind).toBe("doc");
    expect(urlLink("https://example.com/status").kind).toBe("link");
  });
});

describe("config paths", () => {
  it("expands ~/ to the home directory and resolves the rest against the root", async () => {
    const { homedir } = await import("node:os");
    const { resolveIn } = await import("../server/project-config");
    expect(resolveIn("/project", "~/.config/gitlab/token.env")).toBe(`${homedir()}/.config/gitlab/token.env`);
    expect(resolveIn("/project", "docs")).toBe("/project/docs");
    expect(resolveIn("/project", "/etc/x")).toBe("/etc/x");
  });
});

describe("copy as Markdown", () => {
  it("groups links under headings and keeps MR status", async () => {
    const { asMarkdown } = await import("../client/markdown");
    const t = (key: string, values?: Record<string, string | number>) =>
      key === "mr.merged" ? "merged" : key.startsWith("command.") ? key.slice(8) : `${key}${values ? JSON.stringify(values) : ""}`;
    const text = asMarkdown(
      [
        { url: "https://x/doc", kind: "task", label: "login-fix", title: "tasks/login-fix.md" },
        {
          url: "https://g/team/api/-/merge_requests/5",
          kind: "mr",
          label: "!5 api",
          title: "team/api!5",
          status: { state: "merged" } as never,
        },
        { url: "file:///p/a.ts", kind: "file", label: "a.ts", title: "/p/a.ts" },
      ],
      t as never,
    );
    expect(text).toBe(
      "**task**\n- [login-fix](https://x/doc)\n\n**requests**\n- [!5 api](https://g/team/api/-/merge_requests/5) · merged\n\n**files**\n- `/p/a.ts`",
    );
  });
});
