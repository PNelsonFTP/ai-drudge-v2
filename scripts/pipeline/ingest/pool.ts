// Concurrency for the fetch phase.
//
//   HostPool.run(key, fn)   at most `perHost` tasks per host key, at most `maxTotal` in flight overall
//
// V1 nested these the wrong way round (global gate OUTSIDE the host pool), so feeds queued behind a
// slow host sat in the global gate and starved everything listed after them. Here a task takes its
// HOST slot first and a global slot second: a hung host can hold at most `perHost` global slots, and
// a task waiting for its host never occupies a global slot. `fn` (and therefore the request timeout)
// starts only once both slots are held.

import { bareHost } from "../../../shared/url";

type Release = () => void;

/** FIFO counting semaphore. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!(max >= 1)) throw new Error(`Semaphore: max must be >= 1 (got ${max})`);
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(): Promise<Release> {
    const release: Release = () => {
      const next = this.waiters.shift();
      // Hand the slot straight to the next waiter (active count unchanged) so nobody can jump the queue.
      if (next) next();
      else this.active--;
    };
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve) => this.waiters.push(() => resolve(once(release))));
  }
}

function once(fn: Release): Release {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export interface HostPoolOptions {
  /** Concurrent tasks per host key (default 2). */
  perHost?: number;
  /** Per-key overrides of perHost. */
  perHostOverrides?: Readonly<Record<string, number>>;
  /** Upper bound on tasks in flight across all hosts (default 24). Taken AFTER the host slot. */
  maxTotal?: number;
  /** Minimum time between two task STARTS on one host key, ms (default: DEFAULT_HOST_GAPS_MS). */
  minGapMs?: Readonly<Record<string, number>>;
  /** Clock + sleep used for minGapMs (default: the real clock). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_PER_HOST = 2;
export const DEFAULT_MAX_TOTAL = 24;
/** github.com serves ~40 release feeds; 4 at a time is what the review measured as safe and faster. */
export const DEFAULT_HOST_OVERRIDES: Readonly<Record<string, number>> = {
  "github.com": 4,
  // hnrss is fragile: parallel queries from one address were answered 502 during curation, and on
  // the first live builds (2026-11-20) its backend returned 502 for the same 7 of 11 queries three
  // builds running, even to single spaced requests. Be the polite client: one at a time, spaced out
  // (DEFAULT_HOST_GAPS_MS); carry-forward covers the outages.
  "hnrss.org": 1,
};
export const DEFAULT_HOST_GAPS_MS: Readonly<Record<string, number>> = { "hnrss.org": 1000 };

export class HostPool {
  private readonly hosts = new Map<string, Semaphore>();
  private readonly total: Semaphore;
  private readonly perHost: number;
  private readonly overrides: Readonly<Record<string, number>>;
  private readonly gaps: Readonly<Record<string, number>>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nextStart = new Map<string, number>();
  private peak = 0;

  constructor(opts: HostPoolOptions = {}) {
    this.perHost = opts.perHost ?? DEFAULT_PER_HOST;
    this.overrides = opts.perHostOverrides ?? DEFAULT_HOST_OVERRIDES;
    this.gaps = opts.minGapMs ?? DEFAULT_HOST_GAPS_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.total = new Semaphore(opts.maxTotal ?? DEFAULT_MAX_TOTAL);
  }

  /** Highest number of tasks that were in flight at once. */
  get peakInFlight(): number {
    return this.peak;
  }

  private hostSemaphore(key: string): Semaphore {
    let s = this.hosts.get(key);
    if (!s) {
      s = new Semaphore(this.overrides[key] ?? this.perHost);
      this.hosts.set(key, s);
    }
    return s;
  }

  /**
   * `opts.noGap` is asked once the host slot is held: when it answers true the minimum gap is not
   * waited for and not reserved (the task will not touch the host - e.g. the host is in backoff).
   */
  async run<T>(key: string, fn: () => Promise<T>, opts: { noGap?: () => boolean } = {}): Promise<T> {
    const releaseHost = await this.hostSemaphore(key).acquire();
    try {
      const gap = opts.noGap?.() ? 0 : (this.gaps[key] ?? 0);
      if (gap > 0) {
        // Reserve the next start before sleeping, so concurrent holders of one host queue up in order.
        const start = Math.max(this.now(), this.nextStart.get(key) ?? 0);
        this.nextStart.set(key, start + gap);
        if (start > this.now()) await this.sleep(start - this.now());
      }
      const releaseTotal = await this.total.acquire();
      try {
        this.peak = Math.max(this.peak, this.total.inFlight);
        return await fn();
      } finally {
        releaseTotal();
      }
    } finally {
      releaseHost();
    }
  }
}

// Platforms whose tenants share one rate limiter: every *.substack.com feed counts against the same
// bucket (V1 lesson: Substack / Reddit 429 as soon as their feeds are fetched in parallel).
const SHARED_PLATFORMS = ["substack.com", "reddit.com", "medium.com", "beehiiv.com", "blogspot.com", "wordpress.com", "feedburner.com"];

/** Rate-limit bucket of a URL: the bare host, with multi-tenant platforms collapsed to the platform. */
export function hostKey(url: string): string {
  const host = bareHost(url);
  if (!host) return "unknown";
  for (const platform of SHARED_PLATFORMS) {
    if (host === platform || host.endsWith(`.${platform}`)) return platform;
  }
  return host;
}

/**
 * Trips per host key after `threshold` timed-out attempts in one run; later requests to that host
 * fail fast instead of each waiting out the full timeout x retries. Only timeouts count - a host
 * answering 5xx quickly costs nothing to ask again.
 */
export class TimeoutBreaker {
  private readonly timeouts = new Map<string, number>();

  constructor(readonly threshold = 3) {}

  recordTimeout(key: string): void {
    this.timeouts.set(key, (this.timeouts.get(key) ?? 0) + 1);
  }

  recordResponse(key: string): void {
    this.timeouts.delete(key);
  }

  isOpen(key: string): boolean {
    return (this.timeouts.get(key) ?? 0) >= this.threshold;
  }
}

/** Requests in a row ending in 5xx / 429 after which a host is left alone for the rest of the run. */
export const DEFAULT_HOST_BACKOFF_AFTER = 2;

/** HTTP statuses that say "this host is overloaded or broken right now", not "this URL is wrong". */
export function isHostTrouble(httpStatus: number | undefined): boolean {
  return httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599);
}

/**
 * Host-level backoff for one run. When `threshold` requests IN A ROW to one host key end in 5xx or
 * 429 (each after its own retries), the host is left alone for the rest of the run: ingest carries
 * its remaining sources forward instead of asking again (hnrss.org answered 502 to five sources in
 * a row on 2026-11-20 - fifteen requests, about ten seconds of the build, for nothing).
 *
 * "In a row": any other answer from the host (200, 304, even a 404) resets the count, so a host
 * that fails for single URLs while serving the others is never cut off. Once open, it stays open until
 * the run ends - the state is per run and is not persisted, so the next build asks again.
 * Timeouts are the TimeoutBreaker's business, not this one's.
 */
export class HostBackoff {
  private readonly streak = new Map<string, number>();
  private readonly open = new Map<string, { httpStatus: number; failures: number }>();

  /** `threshold` requests in a row open the backoff (default 2); Infinity disables it. */
  constructor(readonly threshold: number = DEFAULT_HOST_BACKOFF_AFTER) {}

  /** A request to `key` ended (after retries) with 5xx / 429. Returns true when this call opened the backoff. */
  recordFailure(key: string, httpStatus: number): boolean {
    if (this.open.has(key)) return false;
    const n = (this.streak.get(key) ?? 0) + 1;
    this.streak.set(key, n);
    if (n < this.threshold) return false;
    this.open.set(key, { httpStatus, failures: n });
    return true;
  }

  /** The host answered a request with something other than 5xx / 429: the failures so far were not "in a row". */
  recordAnswer(key: string): void {
    this.streak.delete(key);
  }

  isOpen(key: string): boolean {
    return this.open.has(key);
  }

  /** Host keys in backoff, in the order they opened. */
  get openHosts(): string[] {
    return [...this.open.keys()];
  }

  /** "hnrss.org answered HTTP 502 to 2 requests in a row"; "" when the host is not in backoff. */
  describe(key: string): string {
    const o = this.open.get(key);
    return o ? `${key} answered HTTP ${o.httpStatus} to ${o.failures} requests in a row` : "";
  }
}
