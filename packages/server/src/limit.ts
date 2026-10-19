/**
 * A rate limit, kept as the recent attempt times for each key.
 *
 * Two places need one and they are guarding different things. `/login` has a
 * shared password and no lockout, so the only thing standing between it and
 * an afternoon of guesses is how fast the guesses can be made. `/ws/agent`
 * cannot be authenticated at all — the agent runs in a browser that is not
 * ours and holds no secret it can keep — so what is left is to bound how much
 * one caller can create.
 *
 * The window slides rather than resets: a caller that keeps knocking while
 * refused does not get a fresh allowance at the top of the next period, which
 * a fixed-window counter would hand them.
 */

/** How often to drop keys whose attempts have all aged out. */
const SWEEP_MS = 60_000;

export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  private readonly timer: ReturnType<typeof setInterval>;

  /** `max` attempts in `windowMs`, per key. */
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    // Nothing here is worth keeping the process alive for.
    this.timer.unref?.();
  }

  /** Whether this attempt is within the allowance, counting it if it is. */
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      // Stored without the new attempt, so being refused costs nothing and the
      // window keeps sliding off the old attempts rather than never expiring.
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Attempts left for this key, for a Retry-After or a log line. */
  remaining(key: string): number {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    return Math.max(0, this.max - recent.length);
  }

  /** Forget a key, as a successful sign-in should. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }

  /** For tests and shutdown; the timer is unref'd, so this is tidiness. */
  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * Who to count against. `remoteAddress` and not a forwarded header: this
 * relay is meant to sit behind a proxy the operator runs, and a header the
 * caller can set is a limit the caller can opt out of.
 */
export function limitKey(address: string | undefined): string {
  return address ?? 'unknown';
}
