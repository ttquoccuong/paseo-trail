import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CredentialSource, CredentialStatus } from "../shared/links";

const DEFAULT_GITLAB_HOST = "gitlab.com";
const CHECK_TTL_MS = 10 * 60_000;
const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 86_400_000;
const CLI_TIMEOUT_MS = 5_000;
/** Variables through which glab and gh hand out a token for any host they are asked about. */
const CLI_TOKEN_VARIABLES = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "GITLAB_HOST",
  "GL_HOST",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

type Verdict = Pick<CredentialStatus, "state" | "detail" | "limits">;

// A token is a single run of visible ASCII. Anything else (a line break inside a pasted token, a
// stray space) cannot go into a header, and the error fetch throws for it quotes the token.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

export function isWellFormedToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * What a failed request is reported and logged as: a code, never the error's own message, which
 * for an invalid header value contains the token itself.
 */
export function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  return error instanceof Error ? error.name : "Error";
}

// A forge that stalls or answers with an endless body cannot hold a request, or memory, for long,
// and a task listing many requests cannot flood the forge: only a few requests run at once.
const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;

/** The time limit ran out while a request was still waiting for a slot: the forge was not even asked. */
export class QueueTimeoutError extends Error {
  constructor() {
    super("timed out waiting for a request slot");
    this.name = "QueueTimeoutError";
  }
}

// A check that never got a slot says nothing about the token; it is tried again soon.
const QUEUED_CHECK_TTL_MS = 30_000;

/** A few request slots; a request that gives up while waiting leaves the queue. */
class RequestPool {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; cancel: () => void }> = [];

  constructor(private readonly size: number) {}

  async run<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    if (this.active < this.size) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: () => {
            signal.removeEventListener("abort", waiter.cancel);
            resolve();
          },
          cancel: () => {
            this.waiting.splice(this.waiting.indexOf(waiter), 1);
            reject(new QueueTimeoutError());
          },
        };
        signal.addEventListener("abort", waiter.cancel, { once: true });
        this.waiting.push(waiter);
      });
    }
    const startedAt = Date.now();
    try {
      return await request();
    } catch (error) {
      // Cut off before it had even half its time, the request mostly waited: say so, so the
      // failure is not taken for the forge's answer.
      if (signal.aborted && Date.now() - startedAt < REQUEST_TIMEOUT_MS / 2) throw new QueueTimeoutError();
      throw error;
    } finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.active -= 1;
    }
  }
}

// Token checks have their own slots: a forge that stalls status requests cannot hold up the check
// that would tell the user about it, and the other way round.
const pools = { status: new RequestPool(MAX_CONCURRENT_REQUESTS), check: new RequestPool(2) };

/** GitLab takes personal, project and OAuth tokens alike as a bearer token. */
export function gitLabHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Requests carrying a token never follow redirects, so a forge behind a sign-in gateway cannot
 * hand the token to the gateway; a redirect is reported instead. Each request has a time limit,
 * and at most a few run at once.
 */
export function fetchWithToken(url: string, init: RequestInit, pool: keyof typeof pools = "status"): Promise<Response> {
  // The time limit starts now, so it covers waiting for a slot, the request and reading the body;
  // once all of that is done the abort is harmless.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS).unref();
  return pools[pool].run(controller.signal, () => fetchOnce(url, init, controller.signal));
}

async function fetchOnce(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    let target = "another address";
    try {
      if (location) target = new URL(location, url).host;
    } catch {
      // Keep the generic wording.
    }
    throw new RedirectError(target);
  }
  return response;
}

/** A response body as text, refusing one larger than `maxBytes` instead of buffering it. */
export async function readBody(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T>(response: Response): Promise<T> {
  return JSON.parse(await readBody(response)) as T;
}

export class RedirectError extends Error {
  constructor(readonly target: string) {
    super(`redirected to ${target}`);
    this.name = "RedirectError";
  }
}

interface Source {
  /** Sent to the client, which words it in the user's language. */
  describe: CredentialSource;
  read(): Promise<string | null>;
}

interface Requirement {
  id: string;
  kind: CredentialStatus["kind"];
  host: string;
  origin?: CredentialStatus["origin"];
  /** Past the number of unlisted hosts Trail tracks: shown, never looked up or contacted. */
  overLimit?: boolean;
  sources: Source[];
  validate(value: string): Promise<Verdict>;
}

/** Token files for one GitLab host, which only the user's personal config may name. */
export interface GitLabTokenConfig {
  tokenFiles: string[];
  tokenKey: string;
}

function verdict(state: CredentialStatus["state"], code: CredentialStatus["detail"]["code"], values = {}, limits: CredentialStatus["limits"] = []): Verdict {
  return { state, detail: { code, values }, limits };
}

/** `GITLAB_HOST` may be written as a URL (glab accepts `https://host`); compare hostnames. */
export function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function envSource(name: string): Source {
  return { describe: { type: "env", name }, read: async () => process.env[name] || null };
}

// `KEY=value` lines, the shape of a dotenv file. The key is checked against the schema's
// identifier pattern before it gets here, and escaped again so it can never act as a pattern.
function envFileSource(path: string, key: string): Source {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    describe: { type: "file", path, key },
    read: async () => {
      try {
        const match = new RegExp(`^(?:export\\s+)?${escaped}=["']?([^"'\\s]+)`, "m").exec(await readFile(path, "utf8"));
        return match?.[1] ?? null;
      } catch {
        return null;
      }
    },
  };
}

// glab answers `config get token --host X` with GITLAB_TOKEN whatever X is, so the CLIs run
// without those variables: what they return is then only a token stored for that very host.
function cliSource(command: string, args: string[]): Source {
  const env = { ...process.env };
  for (const name of CLI_TOKEN_VARIABLES) delete env[name];
  return {
    describe: { type: "cli", command: [command, ...args].join(" ") },
    read: async () => {
      try {
        const { stdout } = await promisify(execFile)(command, args, { timeout: CLI_TIMEOUT_MS, env });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

function expiryVerdict(value: unknown, limits: CredentialStatus["limits"]): Verdict {
  // Only a parseable date string counts; anything else a forge sends is treated as no expiry.
  const expiresAt = typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  if (!expiresAt) return verdict("ok", "ok", {}, limits);
  const days = Math.floor((Date.parse(expiresAt) - Date.now()) / DAY_MS);
  return days <= EXPIRY_WARNING_DAYS
    ? verdict("expiring", "expiring", { date: expiresAt, days }, limits)
    : verdict("ok", "okExpires", { date: expiresAt }, limits);
}

async function probe(host: string, url: string, headers: Record<string, string>): Promise<Response | Verdict> {
  let response: Response;
  try {
    response = await fetchWithToken(url, { headers }, "check");
  } catch (error) {
    if (error instanceof RedirectError) return verdict("unchecked", "redirected", { host, target: error.target });
    return verdict("unchecked", "unreachable", { host, error: errorCode(error) });
  }
  if (response.status === 401) return verdict("invalid", "unauthorized", { host });
  if (!response.ok) return verdict("unchecked", "httpError", { host, status: response.status });
  return response;
}

function gitLabValidator(host: string) {
  return async (token: string): Promise<Verdict> => {
    const response = await probe(host, `https://${host}/api/v4/personal_access_tokens/self`, gitLabHeaders(token));
    // An OAuth token, such as a browser `glab auth login`, has no access-token record; whether it
    // works at all is checked on the user endpoint, and its scopes are not reported.
    if (!(response instanceof Response) && (response.detail.code === "unauthorized" || response.detail.values.status === 404)) {
      const user = await probe(host, `https://${host}/api/v4/user`, gitLabHeaders(token));
      if (user instanceof Response) return verdict("ok", "ok");
      return user;
    }
    if (!(response instanceof Response)) return response;
    const info = await readJsonBody<{ scopes?: string[]; expires_at?: unknown }>(response);
    const scopes = info.scopes ?? [];
    if (!scopes.includes("api") && !scopes.includes("read_api")) return verdict("invalid", "noScope");
    return expiryVerdict(info.expires_at, scopes.includes("api") ? [] : ["readOnly"]);
  };
}

async function validateGitHubToken(token: string): Promise<Verdict> {
  const response = await probe("github.com", "https://api.github.com/user", {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  });
  if (!(response instanceof Response)) return response;
  // Classic tokens list their scopes; fine-grained tokens send no header and are judged per repo.
  const scopes = response.headers.get("x-oauth-scopes");
  const limits: CredentialStatus["limits"] = scopes !== null && !/\brepo\b/.test(scopes) ? ["readOnly"] : [];
  return expiryVerdict(response.headers.get("github-authentication-token-expiration"), limits);
}

export function gitLabCredentialId(host: string): string {
  return `gitlab:${host}`;
}

export const GITHUB_CREDENTIAL_ID = "github:github.com";

// What a decoded stored-token name must look like to count as a GitLab host's token.
const STORED_GITLAB_ID = /^gitlab:[a-z0-9.-]+(?::\d+)?$/;

type Entry = { status: CredentialStatus; value: string | null; expiresAt: number };

/**
 * Every credential the plugin uses is declared through here, with every place it is looked for,
 * so a missing one can be reported with the exact places that were checked. Requirements are
 * added as they become relevant: a forge once one of its MRs or PRs shows up in a session.
 *
 * A token only ever goes to the host it was set up for: one pasted for that host, GITLAB_TOKEN
 * when GITLAB_HOST is that host, or, for a host listed in the user's personal config, the files it
 * names and the glab login. A host named only by a project file or a URL in the chat gets no
 * other token, so unless one was pasted for it, it shows as missing and is never contacted.
 */
export class Credentials {
  private readonly requirements = new Map<string, Requirement>();
  private readonly checked = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Entry>>();
  // Bumped whenever a credential changes, so a check that started before the change is discarded.
  private readonly generations = new Map<string, number>();

  constructor(private readonly secretsDir: string) {}

  // The file name encodes the credential id reversibly, so a host with a port is read back as
  // exactly that host.
  private storedFile(id: string): string {
    return join(this.secretsDir, `${Buffer.from(id).toString("base64url")}.token`);
  }

  // A token pasted in Settings is the user's explicit choice, so it is searched first.
  private storedSource(id: string): Source {
    return {
      describe: { type: "stored" },
      read: async () => {
        try {
          return (await readFile(this.storedFile(id), "utf8")).trim() || null;
        } catch {
          return null;
        }
      },
    };
  }

  private forget(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.checked.delete(id);
    this.inFlight.delete(id);
  }

  /** Saves a pasted token readable only by the daemon's user, or forgets it when `token` is null. */
  async store(id: string, token: string | null): Promise<void> {
    if (!this.requirements.has(id)) throw new Error(`Unknown credential: ${id}`);
    const file = this.storedFile(id);
    if (token === null) {
      await rm(file, { force: true });
    } else {
      if (!isWellFormedToken(token.trim())) {
        throw new Error("A token is one run of visible characters, without spaces or line breaks.");
      }
      await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
      // `mode` only applies when something is created; an existing folder or file keeps its bits.
      await chmod(this.secretsDir, 0o700);
      // Written to a new file of our own and renamed into place, so a file or symlink already
      // sitting at the token's name is replaced, never written through.
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${token.trim()}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    }
    this.forget(id);
  }

  /** Declares (or re-declares, when the personal config changes) the token for one GitLab host. */
  requireGitLab(host: string, personal: GitLabTokenConfig | undefined, origin?: CredentialStatus["origin"]): void {
    const id = gitLabCredentialId(host);
    const key = personal?.tokenKey ?? "GITLAB_TOKEN";
    // glab's convention: GITLAB_TOKEN belongs to GITLAB_HOST, or to gitlab.com when that is unset.
    const envHost = normalizeHost(process.env.GITLAB_HOST) ?? DEFAULT_GITLAB_HOST;
    const sources = [
      this.storedSource(id),
      // Files come before the variable: a long-running daemon keeps the value it started with,
      // which is already revoked once the token in the file has been rotated.
      ...(personal?.tokenFiles ?? []).map((file) => envFileSource(file, key)),
      ...(envHost === host ? [envSource("GITLAB_TOKEN")] : []),
      // glab answers for any host with a token stored at the top of its config, so it is only
      // asked about hosts the user listed in the personal config.
      ...(personal ? [cliSource("glab", ["config", "get", "token", "--host", host])] : []),
    ];
    const signature = (list: Source[]) => JSON.stringify(list.map((source) => source.describe));
    const previous = this.requirements.get(id);
    if (previous && signature(previous.sources) === signature(sources)) {
      // Where the host was named only changes what Settings says about it, not where its token is
      // read from or whether it works, so the last check stays.
      if (JSON.stringify(previous.origin) !== JSON.stringify(origin)) {
        previous.origin = origin;
        const checked = this.checked.get(id);
        if (checked) checked.status = { ...checked.status, ...(origin ? { origin } : {}) };
      }
      return;
    }
    this.requirements.set(id, { id, kind: "gitlab", host, origin, sources, validate: gitLabValidator(host) });
    this.forget(id);
  }

  /** Lists a GitLab host past the tracking limit: it shows in Settings but is never checked. */
  requireOverLimit(host: string, origin?: CredentialStatus["origin"]): void {
    const id = gitLabCredentialId(host);
    if (this.requirements.get(id)?.overLimit) return;
    this.requirements.set(id, { id, kind: "gitlab", host, origin, overLimit: true, sources: [], validate: async () => verdict("unchecked", "tooManyHosts") });
    this.forget(id);
  }

  /** Declares the github.com token; it has no per-project configuration. */
  requireGitHub(): void {
    if (this.requirements.has(GITHUB_CREDENTIAL_ID)) return;
    this.requirements.set(GITHUB_CREDENTIAL_ID, {
      id: GITHUB_CREDENTIAL_ID,
      kind: "github",
      host: "github.com",
      sources: [
        this.storedSource(GITHUB_CREDENTIAL_ID),
        envSource("GITHUB_TOKEN"),
        envSource("GH_TOKEN"),
        cliSource("gh", ["auth", "token", "--hostname", "github.com"]),
      ],
      validate: validateGitHubToken,
    });
  }

  // A proxy or captive portal can answer 200 with a page that is not JSON; that is a failed
  // check, not a reason for the credential to stay unresolved.
  private async validate(requirement: Requirement, value: string): Promise<Verdict> {
    try {
      return await requirement.validate(value);
    } catch (error) {
      return verdict("unchecked", "unreachable", { host: requirement.host, error: errorCode(error) });
    }
  }

  private async evaluate(requirement: Requirement): Promise<Entry> {
    let found: { value: string; source: CredentialSource } | null = null;
    for (const source of requirement.sources) {
      const value = await source.read();
      if (value) {
        found = { value, source: source.describe };
        break;
      }
    }
    const base = {
      id: requirement.id,
      kind: requirement.kind,
      host: requirement.host,
      checked: requirement.sources.map((source) => source.describe),
      ...(requirement.origin ? { origin: requirement.origin } : {}),
    };
    // A value that cannot be a token is never sent anywhere, wherever it was found.
    const wellFormed = found !== null && isWellFormedToken(found.value);
    if (requirement.overLimit) {
      return { status: { ...base, ...verdict("unchecked", "tooManyHosts", { host: requirement.host }) }, value: null, expiresAt: Date.now() + CHECK_TTL_MS };
    }
    const status: CredentialStatus = !found
      ? { ...base, ...verdict("missing", "missing") }
      : wellFormed
        ? { ...base, source: found.source, ...(await this.validate(requirement, found.value)) }
        : { ...base, source: found.source, ...verdict("invalid", "malformed") };
    const queued = status.detail.values.error === "QueueTimeoutError";
    return { status, value: wellFormed ? (found?.value ?? null) : null, expiresAt: Date.now() + (queued ? QUEUED_CHECK_TTL_MS : CHECK_TTL_MS) };
  }

  // Concurrent callers share one check, and its result is only kept if nothing changed meanwhile.
  private check(requirement: Requirement): Promise<Entry> {
    const { id } = requirement;
    const cached = this.checked.get(id);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
    const running = this.inFlight.get(id);
    if (running) return running;
    const generation = this.generations.get(id) ?? 0;
    const pending = this.evaluate(requirement)
      .then((entry) => {
        if ((this.generations.get(id) ?? 0) === generation) this.checked.set(id, entry);
        return entry;
      })
      .finally(() => {
        // A newer check may have taken the slot after a change; only this check's own is cleared.
        if (this.inFlight.get(id) === pending) this.inFlight.delete(id);
      });
    this.inFlight.set(id, pending);
    return pending;
  }

  async statuses(): Promise<CredentialStatus[]> {
    return Promise.all([...this.requirements.values()].map(async (requirement) => (await this.check(requirement)).status));
  }

  /** The value to use, or null when the credential is undeclared, missing or rejected. */
  async value(id: string): Promise<string | null> {
    const requirement = this.requirements.get(id);
    if (!requirement) return null;
    const { status, value } = await this.check(requirement);
    return status.state === "missing" || status.state === "invalid" ? null : value;
  }

  /** Stops tracking a host that is no longer in use; a token pasted for it stays on disk. */
  drop(id: string): void {
    this.requirements.delete(id);
    this.forget(id);
  }

  /** Hosts with a token pasted in Settings, which count as set up by the user. */
  async storedGitLabHosts(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.secretsDir);
    } catch {
      return [];
    }
    const hosts: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".token")) continue;
      const id = Buffer.from(name.slice(0, -".token".length), "base64url").toString();
      if (STORED_GITLAB_ID.test(id)) hosts.push(id.slice("gitlab:".length));
    }
    return hosts;
  }

  /** Called when an API rejects the value, so the next read re-checks instead of reusing it. */
  invalidate(id: string): void {
    this.forget(id);
  }
}
