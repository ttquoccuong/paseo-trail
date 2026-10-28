/**
 * The GitLab hosts that only appear in conversations. Up to `limit` are tracked; a tracked host
 * stays tracked until it goes unseen for `ttlMs`, so the set never churns from poll to poll. A
 * host seen while the set is full is reported as over the limit, also until it goes unseen.
 */
export class HostTracker {
  private readonly tracked = new Map<string, number>();
  private readonly overLimit = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly overLimitCap = 50,
  ) {}

  /** Whether the host is tracked or listed as over the limit. */
  holds(host: string): boolean {
    return this.tracked.has(host) || this.overLimit.has(host);
  }

  /** Notes a sighting and says whether the host is tracked or over the limit. */
  see(host: string, now: number): "tracked" | "overLimit" {
    if (this.tracked.has(host) || this.tracked.size < this.limit) {
      this.tracked.set(host, now);
      this.overLimit.delete(host);
      return "tracked";
    }
    this.overLimit.delete(host);
    this.overLimit.set(host, now);
    while (this.overLimit.size > this.overLimitCap) this.overLimit.delete(this.overLimit.keys().next().value as string);
    return "overLimit";
  }

  /** Forgets hosts not seen for the time limit, unless `keep` says otherwise; returns those dropped. */
  prune(now: number, keep: (host: string) => boolean): string[] {
    const dropped: string[] = [];
    for (const hosts of [this.tracked, this.overLimit]) {
      for (const [host, seenAt] of hosts) {
        if (now - seenAt <= this.ttlMs) continue;
        hosts.delete(host);
        if (!keep(host)) dropped.push(host);
      }
    }
    return dropped;
  }
}
