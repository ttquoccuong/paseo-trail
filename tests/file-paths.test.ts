import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fitPath, pageText } from "../client/file-titles";
import { displayPath } from "../server/display-paths";
import { LinkStore } from "../server/store";

/** A folder holding `files`. */
function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "trail-test-"));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

describe("file names in the Files menu", () => {
  it("are paths from the working directory, as the workspace's file tree shows them", () => {
    const cwd = tree(["paseo-plugins/trail/server/scan.ts"]);
    expect(displayPath(join(cwd, "paseo-plugins/trail/server/scan.ts"), cwd)).toBe("paseo-plugins/trail/server/scan.ts");
  });

  it("name a file outside it from the home folder, else by its full path", () => {
    const root = tree(["elsewhere/x.md"]);
    expect(displayPath(join(homedir(), "notes/today.md"), join(root, "cwd"))).toBe(join("~", "notes/today.md"));
    expect(displayPath(join(root, "elsewhere/x.md"), join(root, "cwd"))).toBe(join(root, "elsewhere/x.md"));
    expect(displayPath(join(root, "elsewhere/x.md"), undefined)).toBe(join(root, "elsewhere/x.md"));
  });

  it("reach the menu as each file link's label", async () => {
    const root = tree(["app/src/a.ts"]);
    const state = mkdtempSync(join(tmpdir(), "trail-test-"));
    writeFileSync(join(state, "agent-a.scanned.json"), JSON.stringify({ mergeRequests: [], files: { [join(root, "app/src/a.ts")]: "edited" } }));
    const [file] = await new LinkStore(state).otherLinks("agent-a", [], root);
    expect(file).toMatchObject({ kind: "file", label: "app/src/a.ts", title: join(root, "app/src/a.ts"), edited: true });
  });
});

describe("a path too long for a menu row", () => {
  it("is left whole when it fits", () => {
    expect(fitPath("server/scan.ts", 48)).toBe("server/scan.ts");
  });

  it("keeps its first folder and its end, cutting the middle", () => {
    expect(fitPath("src/modules/settings/components/cost/CostTable.vue", 32)).toBe("src/…/cost/CostTable.vue");
  });

  it("keeps the end of a file name that alone is too long", () => {
    const path = `docs/${"x".repeat(60)}-final.md`;
    expect(fitPath(path, 20)).toBe(`…${path.slice(-19)}`);
    expect(fitPath(path, 20)).toHaveLength(20);
  });
});

describe("a page in the Docs and Other menus", () => {
  it("is named by host and path, cut in the middle so its end stays", () => {
    const url = "https://gitlab.example.test/group/subgroup/project/-/merge_requests/63?tab=diffs#note_1";
    expect(pageText(url)).toBe("gitlab.example.test/group/subgroup/project/-/merge_requests/63");
    expect(fitPath(pageText(url))).toBe("gitlab.example.test/…/-/merge_requests/63");
    expect(pageText("https://example.test/")).toBe("example.test");
    expect(pageText("not a url")).toBe("not a url");
  });
});
