// Virtual clock for pool / http / ingest tests: timers fire only when the test advances time, so a
// "hung for 8 seconds" host costs no wall time. Imported by *.test.ts files only.

import type { Timers } from "../timers";

interface Pending {
  id: number;
  at: number;
  fn: () => void;
}

export interface VirtualClock extends Timers {
  /** Let every pending promise continuation run without advancing time. */
  flush(): Promise<void>;
  /** Advance virtual time by `ms`, firing due timers in order. */
  advance(ms: number): Promise<void>;
  /** Fire timers until none are left (or `maxMs` of virtual time has passed). Returns the virtual time. */
  runAll(maxMs?: number): Promise<number>;
  /** Run timers until `p` settles; rejects if virtual time runs out first. */
  settle<T>(p: Promise<T>, maxMs?: number): Promise<T>;
  pending(): number;
}

export function createVirtualClock(startMs = 0): VirtualClock {
  let now = startMs;
  let seq = 0;
  let rand = 0;
  const timers: Pending[] = [];

  const flush = async (): Promise<void> => {
    // Several macrotask turns: fake Responses resolve their bodies on real I/O-less ticks.
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const fireNext = (limit: number): boolean => {
    let best = -1;
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].at > limit) continue;
      if (best < 0 || timers[i].at < timers[best].at || (timers[i].at === timers[best].at && timers[i].id < timers[best].id)) best = i;
    }
    if (best < 0) return false;
    const [t] = timers.splice(best, 1);
    now = Math.max(now, t.at);
    t.fn();
    return true;
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    await flush();
    while (fireNext(target)) await flush();
    now = target;
  };

  const runAll = async (maxMs = 3_600_000): Promise<number> => {
    const limit = now + maxMs;
    await flush();
    while (fireNext(limit)) await flush();
    return now;
  };

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    // Deterministic jitter that still varies between calls.
    random: () => {
      rand = (rand + 0.37) % 1;
      return rand;
    },
    flush,
    advance,
    runAll,
    async settle<T>(p: Promise<T>, maxMs = 3_600_000): Promise<T> {
      let state: "pending" | "done" = "pending";
      const tracked = p.finally(() => {
        state = "done";
      });
      tracked.catch(() => undefined);
      const limit = now + maxMs;
      await flush();
      while (state === "pending" && fireNext(limit)) await flush();
      if (state === "pending") throw new Error(`virtual clock: promise still pending after ${maxMs} ms and no timers left`);
      return tracked;
    },
    pending: () => timers.length,
  };
}
