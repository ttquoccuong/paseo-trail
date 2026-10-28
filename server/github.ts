import { mergeRequestStatusSchema, type MergeRequestStatus } from "../shared/links";
import { errorCode, fetchWithToken, GITHUB_CREDENTIAL_ID, readBody, readJsonBody, RedirectError, type Credentials } from "./credentials";
import { parsePullRequestUrl } from "./extract";
import { FailureBackoff, HttpError } from "./failures";
import { setBounded } from "./files";
import { requireShownOptions, type MergeOptions } from "./forges";

const API = "https://api.github.com";
// Same cadence as GitLab: open PRs move with every push and review, closed ones are settled.
const OPEN_TTL_MS = 60_000;
const SETTLED_TTL_MS = 30 * 60_000;
const AFTER_ACTION_DELAY_MS = 5_000;
// Repository settings are read again after this long.
const SETTINGS_TTL_MS = 10 * 60_000;
// Merge methods in order of preference when a repository allows several.
const MERGE_METHODS = ["squash", "merge", "rebase"] as const;

type MergeMethod = (typeof MERGE_METHODS)[number];

interface ApiPull {
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface ApiRepo {
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  delete_branch_on_merge?: boolean;
}

interface ApiCheckRuns {
  check_runs: Array<{ status: string; conclusion: string | null }>;
}

// GitHub's `mergeable_state` in the vocabulary the menu already uses for GitLab.
const MERGE_STATUS: Record<string, string> = {
  clean: "mergeable",
  has_hooks: "mergeable",
  behind: "need_rebase",
  dirty: "conflict",
  blocked: "not_approved",
  unstable: "ci_must_pass",
  draft: "draft_status",
};

function parse(url: string) {
  const parsed = parsePullRequestUrl(url);
  if (!parsed) throw new Error(`Not a GitHub PR URL: ${url}`);
  return parsed;
}

function summariseChecks(runs: ApiCheckRuns["check_runs"]): string | null {
  if (runs.length === 0) return null;
  if (runs.some((run) => run.status !== "completed")) return "running";
  if (runs.some((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? ""))) {
    return "failed";
  }
  return "success";
}

export class GitHub {
  private readonly cache = new Map<string, { status: MergeRequestStatus; expiresAt: number }>();
  private readonly inFlight = new Set<string>();
  private readonly failures = new FailureBackoff("GitHub");
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  // A repository's merge settings rarely change, but do; they are read again after this long.
  private readonly repos = new Map<string, { info: ApiRepo; until: number }>();

  constructor(private readonly credentials: Credentials) {}

  private async request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
    const token = await this.credentials.value(GITHUB_CREDENTIAL_ID);
    if (!token) throw new Error("No usable GitHub token; see Settings → Trail.");
    let response: Response;
    try {
      response = await fetchWithToken(`${API}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const reason = error instanceof RedirectError ? error.message : errorCode(error);
      throw new Error(`GitHub ${method} ${path}: ${reason}`);
    }
    if (response.status === 401) this.credentials.invalidate(GITHUB_CREDENTIAL_ID);
    if (!response.ok) {
      const text = (await readBody(response).catch(() => "")).slice(0, 300);
      throw new HttpError(`GitHub ${method} ${path}: HTTP ${response.status} ${text}`, response.status);
    }
    return readJsonBody<T>(response);
  }

  private async repo(owner: string, name: string): Promise<ApiRepo> {
    const key = `${owner}/${name}`;
    const cached = this.repos.get(key);
    if (cached && cached.until > Date.now()) return cached.info;
    const info = await this.request<ApiRepo>("GET", `repos/${key}`);
    setBounded(this.repos, key, { info, until: Date.now() + SETTINGS_TTL_MS });
    return info;
  }

  private mergeMethod(repo: ApiRepo): MergeMethod {
    const allowed: Record<MergeMethod, boolean | undefined> = {
      squash: repo.allow_squash_merge,
      merge: repo.allow_merge_commit,
      rebase: repo.allow_rebase_merge,
    };
    return MERGE_METHODS.find((method) => allowed[method]) ?? "merge";
  }

  cachedStatus(url: string): MergeRequestStatus | undefined {
    const entry = this.cache.get(url);
    if ((!entry || entry.expiresAt <= Date.now()) && !this.failures.waiting(url)) void this.refresh(url);
    return entry?.status;
  }

  private async refresh(url: string): Promise<void> {
    if (this.inFlight.has(url)) return;
    this.inFlight.add(url);
    try {
      if ((await this.credentials.value(GITHUB_CREDENTIAL_ID)) === null) return;
      const { owner, repo, number } = parse(url);
      const base = `repos/${owner}/${repo}`;
      const pull = await this.request<ApiPull>("GET", `${base}/pulls/${number}`);
      const [repoInfo, checks, reviews, compare] = await Promise.all([
        this.repo(owner, repo),
        this.request<ApiCheckRuns>("GET", `${base}/commits/${pull.head.sha}/check-runs?per_page=100`),
        this.request<Array<{ user: { login: string } | null; state: string }>>("GET", `${base}/pulls/${number}/reviews?per_page=100`),
        this.request<{ behind_by?: number }>("GET", `${base}/compare/${encodeURIComponent(pull.base.ref)}...${pull.head.sha}`),
      ]);
      // A reviewer's latest review is the one that counts.
      const latest = new Map<string, string>();
      for (const review of reviews) if (review.user) latest.set(review.user.login, review.state);
      const approvedBy = [...latest].filter(([, state]) => state === "APPROVED").map(([login]) => login);
      const pipeline = summariseChecks(checks.check_runs);
      const status: MergeRequestStatus = mergeRequestStatusSchema.parse({
        state: pull.merged ? "merged" : pull.state === "open" ? "opened" : "closed",
        draft: pull.draft ?? false,
        mergeStatus: pull.draft ? "draft_status" : (MERGE_STATUS[pull.mergeable_state ?? ""] ?? "unknown"),
        hasConflicts: pull.mergeable === false,
        behind: compare.behind_by ?? 0,
        // Built from the PR's own github.com URL rather than from a URL in the answer.
        pipeline: pipeline ? { status: pipeline, url: `${url}/checks` } : null,
        approved: approvedBy.length > 0,
        approvedBy,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        sha: pull.head.sha,
        squash: this.mergeMethod(repoInfo) === "squash",
        removeSourceBranch: repoInfo.delete_branch_on_merge ?? false,
        fetchedAt: new Date().toISOString(),
      });
      const ttl = status.state === "opened" ? OPEN_TTL_MS : SETTLED_TTL_MS;
      this.failures.clear(url);
      this.cache.set(url, { status, expiresAt: Date.now() + ttl });
    } catch (error) {
      this.failures.record(url, error);
      const entry = this.cache.get(url);
      if (entry) entry.expiresAt = Date.now() + OPEN_TTL_MS;
    } finally {
      this.inFlight.delete(url);
    }
  }

  private recheckSoon(url: string) {
    this.cache.delete(url);
    this.failures.clear(url);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.refresh(url);
    }, AFTER_ACTION_DELAY_MS);
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** GitHub's "Update branch": merges the base into the PR branch; it does not rewrite history. */
  async rebase(url: string): Promise<void> {
    const { owner, repo, number } = parse(url);
    const sha = this.cache.get(url)?.status.sha;
    await this.request("PUT", `repos/${owner}/${repo}/pulls/${number}/update-branch`, sha ? { expected_head_sha: sha } : {});
    this.recheckSoon(url);
  }

  /** Merges with the repository's preferred allowed method, refused if the head moved past `sha`. */
  async merge(url: string, sha: string, shown: MergeOptions): Promise<string> {
    const { owner, repo, number } = parse(url);
    const repository = await this.repo(owner, repo);
    const method = this.mergeMethod(repository);
    requireShownOptions({ squash: method === "squash", removeSourceBranch: repository.delete_branch_on_merge ?? false }, shown);
    const result = await this.request<{ merged: boolean; message: string }>(
      "PUT",
      `repos/${owner}/${repo}/pulls/${number}/merge`,
      { sha, merge_method: method },
    );
    this.recheckSoon(url);
    return result.merged ? "merged" : result.message;
  }
}
