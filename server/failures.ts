import { setBounded } from "./files";

/** An HTTP answer that was not a success, with its status kept for deciding when to try again. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// A request that does not exist or cannot be seen with this token (404, 403, 410) will not change
// soon; anything else is tried again after a normal status cycle.
const LASTING_STATUSES = new Set([403, 404, 410]);
const LASTING_FAILURE_MS = 30 * 60_000;
const PASSING_FAILURE_MS = 60_000;

/**
 * Remembers status fetches that failed, so a request the forge refuses is not asked for again on
 * every poll, and is logged once until the reason changes.
 */
export class FailureBackoff {
  private readonly failures = new Map<string, { until: number; reason: string }>();

  constructor(private readonly forge: string) {}

  /** Whether the last fetch of `url` failed recently enough that it should not be retried yet. */
  waiting(url: string): boolean {
    return (this.failures.get(url)?.until ?? 0) > Date.now();
  }

  record(url: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError ? error.status : 0;
    const previous = this.failures.get(url);
    if (previous?.reason !== reason) console.error(`trail: ${this.forge} status failed for ${url}: ${reason}`);
    const wait = LASTING_STATUSES.has(status) ? LASTING_FAILURE_MS : PASSING_FAILURE_MS;
    setBounded(this.failures, url, { until: Date.now() + wait, reason });
  }

  clear(url: string): void {
    this.failures.delete(url);
  }
}
