import type { MergeRequestStatus } from "../shared/links";

/** The merge settings the user confirmed. */
export interface MergeOptions {
  squash: boolean;
  removeSourceBranch: boolean;
}

/** Refuses a merge whose settings changed after the confirmation showed them. */
export function requireShownOptions(current: MergeOptions, shown: MergeOptions): void {
  if (current.squash !== shown.squash || current.removeSourceBranch !== shown.removeSourceBranch) {
    throw new Error("The merge settings changed since the confirmation was shown; open it again.");
  }
}
import { parseMergeRequestUrl, parsePullRequestUrl } from "./extract";
import type { GitHub } from "./github";
import type { GitLab } from "./gitlab";

/** Sends each MR/PR to the forge its URL belongs to. */
export class Forges {
  constructor(
    private readonly gitlab: GitLab,
    private readonly github: GitHub,
  ) {}

  private forUrl(url: string): GitLab | GitHub | null {
    if (parsePullRequestUrl(url)) return this.github;
    return parseMergeRequestUrl(url) ? this.gitlab : null;
  }

  private require(url: string): GitLab | GitHub {
    const forge = this.forUrl(url);
    if (!forge) throw new Error(`Not a merge or pull request URL: ${url}`);
    return forge;
  }

  cachedStatus(url: string): MergeRequestStatus | undefined {
    return this.forUrl(url)?.cachedStatus(url);
  }

  rebase(url: string): Promise<void> {
    return this.require(url).rebase(url);
  }

  merge(url: string, sha: string, shown: MergeOptions): Promise<string> {
    // Without a head commit the forge would merge whatever the branch holds by then.
    if (!sha) return Promise.reject(new Error("The request's head commit is unknown; refresh its status first."));
    return this.require(url).merge(url, sha, shown);
  }

  /** Cancels the status re-checks scheduled after an action. */
  dispose(): void {
    this.gitlab.dispose();
    this.github.dispose();
  }
}
