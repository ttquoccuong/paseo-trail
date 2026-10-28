import { mergeRequestStatusSchema, type MergeRequestStatus } from "../shared/links";
import { errorCode, fetchWithToken, gitLabCredentialId, gitLabHeaders, readBody, readJsonBody, RedirectError, type Credentials } from "./credentials";
import { parseMergeRequestUrl } from "./extract";
import { FailureBackoff, HttpError } from "./failures";
import { setBounded } from "./files";
import { requireShownOptions, type MergeOptions } from "./forges";
// Open MRs change with every push, approval and pipeline; merged or closed ones are settled.
const OPEN_TTL_MS = 60_000;
const SETTLED_TTL_MS = 30 * 60_000;
// Project settings are read again after this long.
const SETTINGS_TTL_MS = 10 * 60_000;
// After an action GitLab needs a moment (rebase runs async), so re-check sooner than the TTL.
const AFTER_ACTION_DELAY_MS = 5_000;

interface ApiMergeRequest {
  state: MergeRequestStatus["state"];
  draft?: boolean;
  work_in_progress?: boolean;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  diverged_commits_count?: number;
  head_pipeline?: { status: string; web_url: string } | null;
  source_branch: string;
  target_branch: string;
  sha: string;
  squash?: boolean;
  squash_on_merge?: boolean;
  force_remove_source_branch?: boolean | null;
}

interface ApiProject {
  squash_option?: "always" | "default_on" | "default_off" | "never";
}

interface ApiApprovals {
  approved?: boolean;
  approved_by?: Array<{ user?: { username?: string } | null } | null>;
}

function parseUrl(url: string): { host: string; project: string; iid: string } {
  const parsed = parseMergeRequestUrl(url);
  if (!parsed) throw new Error(`Not a GitLab MR URL: ${url}`);
  return parsed;
}

// A page link from the API is shown as a menu entry that opens it; only an https page, or an http
// one on the forge itself, is kept.
function isForgePage(url: unknown, host: string): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.host === host);
  } catch {
    return false;
  }
}

export class GitLab {
  private readonly cache = new Map<string, { status: MergeRequestStatus; expiresAt: number }>();
  private readonly inFlight = new Set<string>();
  private readonly failures = new FailureBackoff("GitLab");
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  // A project's squash rule rarely changes, but does; it is read again after this long.
  private readonly squashOptions = new Map<string, { option: ApiProject["squash_option"]; until: number }>();

  constructor(private readonly credentials: Credentials) {}

  private async request<T>(host: string, method: "GET" | "PUT", path: string): Promise<T> {
    const credential = gitLabCredentialId(host);
    const token = await this.credentials.value(credential);
    if (!token) throw new Error(`No usable GitLab token for ${host}; see Settings → Trail.`);
    let response: Response;
    try {
      response = await fetchWithToken(`https://${host}/api/v4/${path}`, { method, headers: gitLabHeaders(token) });
    } catch (error) {
      // Never the original message: for a malformed header value it quotes the token.
      const reason = error instanceof RedirectError ? error.message : errorCode(error);
      throw new Error(`GitLab ${method} ${path}: ${reason}`);
    }
    // A token rotated or revoked since the last check: re-check on the next call.
    if (response.status === 401) this.credentials.invalidate(credential);
    if (!response.ok) {
      const body = (await readBody(response).catch(() => "")).slice(0, 300);
      throw new HttpError(`GitLab ${method} ${path}: HTTP ${response.status} ${body}`, response.status);
    }
    return readJsonBody<T>(response);
  }

  // A project that requires squash answers HTTP 422 to an unsquashed merge, so the project setting
  // decides first and the MR's own checkbox only matters where the project leaves it open.
  private async squashFor(url: string, mrSquash: boolean): Promise<boolean> {
    const { host, project } = parseUrl(url);
    const key = `${host}/${project}`;
    const cached = this.squashOptions.get(key);
    let option = cached && cached.until > Date.now() ? cached.option : undefined;
    if (!cached || cached.until <= Date.now()) {
      const info = await this.request<ApiProject>(host, "GET", `projects/${encodeURIComponent(project)}`);
      option = info.squash_option;
      setBounded(this.squashOptions, key, { option, until: Date.now() + SETTINGS_TTL_MS });
    }
    if (option === "always") return true;
    if (option === "never") return false;
    return mrSquash;
  }

  private mergeRequestPath(url: string): string {
    const { project, iid } = parseUrl(url);
    return `projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  }

  /** Last fetched status, without waiting; a stale or missing entry is refreshed in the background. */
  cachedStatus(url: string): MergeRequestStatus | undefined {
    const entry = this.cache.get(url);
    if ((!entry || entry.expiresAt <= Date.now()) && !this.failures.waiting(url)) void this.refresh(url);
    return entry?.status;
  }

  private async hasToken(url: string): Promise<boolean> {
    return (await this.credentials.value(gitLabCredentialId(parseUrl(url).host))) !== null;
  }

  private async refresh(url: string): Promise<void> {
    if (this.inFlight.has(url)) return;
    this.inFlight.add(url);
    try {
      // Without a token the warning is shown once through the credential status, not logged per MR.
      if (!(await this.hasToken(url))) return;
      const { host } = parseUrl(url);
      const path = this.mergeRequestPath(url);
      const [mr, approvals] = await Promise.all([
        this.request<ApiMergeRequest>(host, "GET", `${path}?include_diverged_commits_count=true`),
        this.request<ApiApprovals>(host, "GET", `${path}/approvals`),
      ]);
      const status: MergeRequestStatus = mergeRequestStatusSchema.parse({
        state: mr.state,
        draft: mr.draft ?? mr.work_in_progress ?? false,
        mergeStatus: mr.detailed_merge_status ?? "unknown",
        hasConflicts: mr.has_conflicts ?? false,
        behind: mr.diverged_commits_count ?? 0,
        pipeline:
          mr.head_pipeline && isForgePage(mr.head_pipeline.web_url, host)
            ? { status: mr.head_pipeline.status, url: mr.head_pipeline.web_url }
            : null,
        approved: approvals.approved ?? false,
        approvedBy: (approvals.approved_by ?? []).flatMap((entry) => (entry?.user?.username ? [entry.user.username] : [])),
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        sha: mr.sha,
        squash: await this.squashFor(url, mr.squash_on_merge ?? mr.squash ?? false),
        removeSourceBranch: mr.force_remove_source_branch ?? false,
        fetchedAt: new Date().toISOString(),
      });
      const ttl = status.state === "opened" ? OPEN_TTL_MS : SETTLED_TTL_MS;
      this.failures.clear(url);
      this.cache.set(url, { status, expiresAt: Date.now() + ttl });
    } catch (error) {
      this.failures.record(url, error);
      // Keep the old status but retry on the next normal cycle rather than every poll.
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

  async rebase(url: string): Promise<void> {
    await this.request(parseUrl(url).host, "PUT", `${this.mergeRequestPath(url)}/rebase`);
    this.recheckSoon(url);
  }

  /**
   * Merges with the MR's own squash and branch-removal settings, so release and hotfix branches
   * keep their source branch unless the MR says otherwise. `sha` must still be the head commit:
   * GitLab rejects the merge if anything was pushed after the user looked at the status.
   */
  async merge(url: string, sha: string, shown: MergeOptions): Promise<string> {
    const status = this.cache.get(url)?.status;
    if (!status) throw new Error("MR status not loaded yet; try again in a moment.");
    requireShownOptions(status, shown);
    const query = new URLSearchParams({
      sha,
      squash: String(status.squash),
      should_remove_source_branch: String(status.removeSourceBranch),
    });
    const result = await this.request<{ state: string }>(
      parseUrl(url).host,
      "PUT",
      `${this.mergeRequestPath(url)}/merge?${query}`,
    );
    this.recheckSoon(url);
    return result.state;
  }
}
