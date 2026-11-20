// The app clock: epoch ms that ticks once a minute, so "updated 12m ago", row ages and NEW badges
// move in an open tab (V1 computed them at render time and froze). One timer for the whole app.
//
// The timer only runs while someone is subscribed and the tab is visible; coming back to a hidden
// tab ticks immediately. Nothing is scheduled at creation, so SSR and tests never leak a timer.

import { createStore, type Store } from "./services";

export const CLOCK_TICK_MS = 60_000;

export interface ClockEnv {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Page visibility; omit where there is no document. */
  isHidden?(): boolean;
  onVisibilityChange?(listener: () => void): () => void;
}

export interface ClockOptions {
  tickMs?: number;
  env?: ClockEnv;
}

export interface ClockStore extends Store<number> {
  /** Re-read the time now (e.g. after a data refresh). */
  tick(): void;
}

function browserClockEnv(): ClockEnv {
  const hasDocument = typeof document !== "undefined";
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    isHidden: hasDocument ? () => document.visibilityState === "hidden" : undefined,
    onVisibilityChange: hasDocument
      ? (listener) => {
          document.addEventListener("visibilitychange", listener);
          return () => document.removeEventListener("visibilitychange", listener);
        }
      : undefined,
  };
}

export function createClock(opts: ClockOptions = {}): ClockStore {
  const env = opts.env ?? browserClockEnv();
  const tickMs = opts.tickMs ?? CLOCK_TICK_MS;
  const store = createStore<number>(env.now());
  let subscribers = 0;
  let timer: unknown = null;
  let stopVisibility: (() => void) | null = null;

  const tick = (): void => store.set(env.now());

  const startTimer = (): void => {
    if (timer === null) timer = env.setInterval(tick, tickMs);
  };
  const stopTimer = (): void => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };

  const onVisibility = (): void => {
    if (env.isHidden?.()) {
      stopTimer();
    } else {
      tick();
      startTimer();
    }
  };

  const start = (): void => {
    // Catch up only when the value is at least a tick old. Re-reading it on every first subscribe
    // would change the snapshot between render and commit and re-render every consumer at mount.
    if (env.now() - store.get() >= tickMs) tick();
    if (!env.isHidden?.()) startTimer();
    stopVisibility = env.onVisibilityChange?.(onVisibility) ?? null;
  };
  const stop = (): void => {
    stopTimer();
    stopVisibility?.();
    stopVisibility = null;
  };

  return {
    get: store.get,
    subscribe(listener) {
      const unsubscribe = store.subscribe(listener);
      if (subscribers++ === 0) start();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        unsubscribe();
        if (--subscribers === 0) stop();
      };
    },
    tick,
  };
}
