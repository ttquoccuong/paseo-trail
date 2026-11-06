/**
 * `group/project#N` is an issue in GitLab and a pull request in GitHub. With `hashReferences:
 * "gitlab"` in the personal config, a repository Trail has not placed yet is read as a GitLab project
 * on the preferred host, unless this machine opened it on github.com or GitLab answered that no such
 * project exists there.
 */

/** What GitLab said about a project: it exists, it does not, or there is no answer yet. */
export type ProjectAnswer = "yes" | "no" | "unknown";

export interface PreferredGitLab {
  /** Projects already placed on a GitLab host (catalog, learned pages); never overridden. */
  learned: ReadonlyMap<string, string>;
  /** Repositories this machine opened on github.com. */
  githubRepos: ReadonlySet<string>;
  /** Repositories the session named as `owner/repo#N`. */
  mentioned: string[];
  /** The GitLab host `#N` means; null leaves every reference as it was. */
  host: string | null;
  onGitLab: (host: string, project: string) => ProjectAnswer;
}

export function withPreferredGitLab({ learned, githubRepos, mentioned, host, onGitLab }: PreferredGitLab): ReadonlyMap<string, string> {
  if (!host) return learned;
  // Until GitLab answers, the reference is still read as GitLab's: linking a GitHub page that may
  // not exist is the mistake this setting is there to avoid.
  const added = mentioned.filter((repo) => !learned.has(repo) && !githubRepos.has(repo) && onGitLab(host, repo) !== "no");
  return added.length === 0 ? learned : new Map([...learned, ...added.map((repo) => [repo, host] as const)]);
}
