// Time for DURATIONS (timeouts, backoff, deadlines) - injected so pool / http tests run on a virtual
// clock. This is NOT the build clock: "now" for health and state decisions is always ctx.now.

export interface Timers {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** [0, 1) - jitter source. */
  random(): number;
}

export const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  random: () => Math.random(),
};

/** Resolves after `ms`, or immediately when `signal` aborts (callers re-check their deadline). */
export function sleep(timers: Timers, ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      timers.clearTimeout(handle);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const handle = timers.setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A point in time after which no new work starts and in-flight requests are aborted. */
export interface Deadline {
  /** timers.now() value of the deadline. */
  readonly at: number;
  readonly signal: AbortSignal;
  expired(): boolean;
  remaining(): number;
  /** Stop the underlying timer (call when the guarded work is done). */
  cancel(): void;
}

export function createDeadline(timers: Timers, ms: number): Deadline {
  const at = timers.now() + ms;
  const ctl = new AbortController();
  const handle = timers.setTimeout(() => ctl.abort(), ms);
  return {
    at,
    signal: ctl.signal,
    expired: () => ctl.signal.aborted || timers.now() >= at,
    remaining: () => Math.max(0, at - timers.now()),
    cancel: () => timers.clearTimeout(handle),
  };
}
