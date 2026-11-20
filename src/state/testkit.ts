// Test doubles for the WP7 stores: fake timers, fake fetch, fake event targets, linked "tabs".
// Pure TypeScript (no node:, no DOM globals beyond setTimeout) and imported ONLY by *.test.ts files,
// so it never reaches the bundle.

import { createMemoryStorage, type StorageEventLike, type StorageEventSource, type StorageLike } from "./storage";

/** Let every pending promise chain settle (one real macrotask). */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ------------------------------------------------------------------------------------------------
// Timers / clock
// ------------------------------------------------------------------------------------------------

export interface FakeTimers {
  /** Injected clock (epoch ms). */
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Move the clock forward, running due timers in order and letting promises settle after each. */
  advance(ms: number): Promise<void>;
  /** Number of timers waiting. */
  pending(): number;
  /** Move the clock without running timers. */
  set(ms: number): void;
}

export function createFakeTimers(startMs = 0): FakeTimers {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const nextDue = (limit: number): [number, { at: number; fn: () => void }] | null => {
    let best: [number, { at: number; fn: () => void }] | null = null;
    for (const entry of timers) {
      if (entry[1].at > limit) continue;
      if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[0] < best[0])) best = entry;
    }
    return best;
  };
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: nowMs + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance: async (ms) => {
      const target = nowMs + ms;
      await flush();
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        timers.delete(due[0]);
        nowMs = Math.max(nowMs, due[1].at);
        due[1].fn();
        await flush();
      }
      nowMs = target;
      await flush();
    },
    pending: () => timers.size,
    set: (ms) => {
      nowMs = ms;
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Fetch
// ------------------------------------------------------------------------------------------------

export interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** What a route serves: a JSON-able body (200), {status, body}, "hang" (never answers), or "fail" (network error). */
export type FakeRoute = unknown | (() => unknown);

export interface FakeFetchCall {
  url: string;
  cache: string | undefined;
}

export interface FakeFetch {
  fetch: (input: string, init?: { cache?: "default" | "no-cache"; signal?: AbortSignal }) => Promise<FakeResponse>;
  calls: FakeFetchCall[];
  /** Replace or add a route (key = URL suffix, e.g. "front.json"). */
  set(suffix: string, route: FakeRoute): void;
  /** Number of requests whose URL ends with `suffix`. */
  count(suffix: string): number;
}

export const HANG = Symbol("hang");
export const FAIL = Symbol("fail");

export function httpStatus(status: number, body: unknown = null): { __status: number; body: unknown } {
  return { __status: status, body };
}

function isStatus(x: unknown): x is { __status: number; body: unknown } {
  return typeof x === "object" && x !== null && "__status" in x;
}

export function createFakeFetch(routes: Record<string, FakeRoute> = {}): FakeFetch {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const calls: FakeFetchCall[] = [];
  const fetch: FakeFetch["fetch"] = (input, init) => {
    calls.push({ url: input, cache: init?.cache });
    let route: FakeRoute | undefined;
    for (const [suffix, r] of table) if (input.endsWith(suffix)) route = r;
    const value = typeof route === "function" ? (route as () => unknown)() : route;
    if (value === HANG) {
      return new Promise<FakeResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (value === undefined || value === FAIL) return Promise.reject(new TypeError(`network error: ${input}`));
    if (isStatus(value)) {
      const { __status, body } = value;
      return Promise.resolve({ ok: __status >= 200 && __status < 300, status: __status, json: async () => body });
    }
    // Round-trip through JSON so the store never shares object identity with the fixture.
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) as unknown });
  };
  return {
    fetch,
    calls,
    set: (suffix, route) => void table.set(suffix, route),
    count: (suffix) => calls.filter((c) => c.url.endsWith(suffix)).length,
  };
}

// ------------------------------------------------------------------------------------------------
// Events
// ------------------------------------------------------------------------------------------------

export interface FakeEvents<E> {
  addEventListener(type: string, listener: (event: E) => void): void;
  removeEventListener(type: string, listener: (event: E) => void): void;
  emit(type: string, event: E): void;
  listenerCount(type?: string): number;
}

export function createFakeEvents<E = unknown>(): FakeEvents<E> {
  const listeners = new Map<string, Set<(event: E) => void>>();
  return {
    addEventListener: (type, listener) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    emit: (type, event) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(event);
    },
    listenerCount: (type) => {
      if (type) return listeners.get(type)?.size ?? 0;
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

/** A fake `document` for visibility handling. */
export interface FakeVisibility extends FakeEvents<unknown> {
  visibilityState: "visible" | "hidden";
  show(): void;
  hide(): void;
}

export function createFakeVisibility(initial: "visible" | "hidden" = "visible"): FakeVisibility {
  const events = createFakeEvents<unknown>();
  const doc: FakeVisibility = {
    ...events,
    visibilityState: initial,
    show: () => {
      doc.visibilityState = "visible";
      events.emit("visibilitychange", {});
    },
    hide: () => {
      doc.visibilityState = "hidden";
      events.emit("visibilitychange", {});
    },
  };
  return doc;
}

// ------------------------------------------------------------------------------------------------
// Tabs sharing one localStorage
// ------------------------------------------------------------------------------------------------

export interface FakeTab {
  storage: StorageLike;
  events: StorageEventSource;
}

/**
 * `n` browser tabs over ONE shared storage. As in a browser, a write in one tab dispatches a
 * `storage` event to every OTHER tab (never to the writer).
 */
export function createTabs(n: number, initial?: Readonly<Record<string, string>>): { shared: StorageLike; tabs: FakeTab[] } {
  const shared = createMemoryStorage(initial);
  const sources = Array.from({ length: n }, () => createFakeEvents<StorageEventLike>());
  const tabs: FakeTab[] = sources.map((events, i) => {
    const notify = (key: string): void => {
      sources.forEach((other, j) => {
        if (j !== i) other.emit("storage", { key });
      });
    };
    const storage: StorageLike = {
      getItem: (key) => shared.getItem(key),
      setItem: (key, value) => {
        const before = shared.getItem(key);
        shared.setItem(key, value);
        if (before !== value) notify(key);
      },
      removeItem: (key) => {
        const had = shared.getItem(key) !== null;
        shared.removeItem(key);
        if (had) notify(key);
      },
      get length() {
        return shared.length;
      },
      key: (index) => shared.key(index),
    };
    return { storage, events };
  });
  return { shared, tabs };
}

/** Storage wrapper that records every mutation (for "never writes a V1 key" assertions). */
export function recordWrites(inner: StorageLike): { storage: StorageLike; writes: { op: "set" | "remove"; key: string }[] } {
  const writes: { op: "set" | "remove"; key: string }[] = [];
  const storage: StorageLike = {
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      writes.push({ op: "set", key });
      inner.setItem(key, value);
    },
    removeItem: (key) => {
      writes.push({ op: "remove", key });
      inner.removeItem(key);
    },
    get length() {
      return inner.length;
    },
    key: (index) => inner.key(index),
  };
  return { storage, writes };
}

/** Storage whose writes always fail (quota exceeded). Reads work. */
export function quotaStorage(inner: StorageLike = createMemoryStorage()): StorageLike {
  return {
    getItem: (key) => inner.getItem(key),
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: (key) => inner.removeItem(key),
    get length() {
      return inner.length;
    },
    key: (index) => inner.key(index),
  };
}

/** Storage that throws on every access (disabled storage). */
export function brokenStorage(): StorageLike {
  const boom = (): never => {
    throw new Error("SecurityError");
  };
  return { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length(): number { return boom(); } };
}
