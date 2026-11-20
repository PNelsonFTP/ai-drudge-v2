// The edition store: the one place the client loads headline data.
//
// Stale-while-revalidate, in this order:
//   1. sessionStorage cache, read ONCE at creation and run through the same guards as network data
//      (a V1-shaped or otherwise wrong payload is dropped, never painted);
//   2. front.json (always fetched, so index.html's preload is consumed) - the page is usable here;
//   3. rest.json when the browser is idle; river.json only on demand.
// brief.json and stocks.json load in parallel and can never hold up or fail the headlines.
// status.json travels with them for ONE number: `staleAfterMinutes`, the age at which the pipeline
// itself calls the data stale (the shell's "Headlines may be delayed" threshold).
//
// Fixes of the V1 hook (reviews: frontend-logic, performance):
//   - loadRest() / loadRiver() are single-flight AND retry (1 s, 3 s backoff); a failed cycle clears
//     itself so the next call starts a new one (V1 cached the failed promise forever).
//   - every payload passes shared/guards.ts; a newer schemaVersion raises `outdatedClient`.
//   - buildId mismatch between front and rest/river -> front is refetched once.
//   - refresh() + auto-refresh every REFRESH_INTERVAL_MS while the tab is visible (V1 fetched once
//     per page load); a complete edition is swapped for the next complete edition in one step.
//   - the cache is written only when a build changes (V1 rewrote 380 KB on every keystroke).

import { DATA_FILES, type BriefFile, type EditionFront, type EditionMeta, type EditionRest, type RiverFile, type StocksFile } from "../../shared/contract";
import { validateBriefFile, validateEditionFront, validateEditionRest, validateRiverFile, validateStocksFile } from "../../shared/guards";
import { mergeEdition } from "../../shared/select";
import { staleHours } from "../../shared/time";
import { CACHE_KEYS, REFRESH_INTERVAL_MS, createStore, type EditionState, type EditionStore } from "../app/services";
import { readRaw, removeKey, writeRaw, type StorageLike } from "../state/storage";
import { RETRY_DELAYS_MS, TIMEOUT_MS, createLoader, describeFailure, isTransient, realTimers, sleep, type FetchLike, type LoadResult, type Timers } from "./fetchJson";

/** The slice of `document` used for pausing auto-refresh. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The slice of `window` used to retry when the connection returns. */
export interface OnlineSource {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

export interface EditionStoreOptions {
  /** Site base ending in "/" (import.meta.env.BASE_URL). Data lives under `${baseUrl}data/v2/`. */
  baseUrl: string;
  fetch: FetchLike;
  /** sessionStorage for the guarded payload cache; null disables caching. */
  storage: StorageLike | null;
  /** Clock, epoch ms. */
  now: () => number;
  timers?: Timers;
  /** Runs rest.json loading when the browser is idle (default requestIdleCallback, else a short timeout). */
  idle?: (run: () => void) => void;
  /** `document`: auto-refresh pauses while hidden. Omit to treat the tab as always visible. */
  visibility?: VisibilitySource | null;
  /** `window`: a refresh is attempted when the connection comes back. */
  connectivity?: OnlineSource | null;
  /** Backoff between the attempts of one load cycle (default 1 s, 3 s -> 3 attempts). */
  retryDelaysMs?: readonly number[];
  /** Auto-refresh period (default REFRESH_INTERVAL_MS); 0 disables auto-refresh. */
  refreshIntervalMs?: number;
  /** Start loading at creation (default true). With false, call start(). */
  autoStart?: boolean;
}

/** The two optional EditionState fields this store adds to the required ones (src/app/services.ts documents them). */
export type EditionStateExtras = Pick<EditionState, "staleAfterMinutes" | "retrying">;

/** Alias kept for the store's own code and tests: the state is the contract's EditionState. */
export type EditionStoreState = EditionState;

/**
 * Guard of the one field read from status.json. Deliberately not shared/guards.ts validateStatusFile:
 * the client must not stop honouring the threshold because an ops-only field changed shape.
 */
export function validateStaleAfter(x: unknown): string | null {
  const minutes = typeof x === "object" && x !== null ? (x as { staleAfterMinutes?: unknown }).staleAfterMinutes : undefined;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? null : "status.staleAfterMinutes: expected a positive number";
}

export interface EditionStoreImpl extends EditionStore {
  get(): EditionStoreState;
  /** Begin the first network load (idempotent). Resolves when front, brief and stocks have settled. */
  start(): Promise<void>;
  /** Stop timers and listeners; in-flight responses are ignored. */
  dispose(): void;
}

type FrontOutcome = "same" | "changed" | "kept" | "failed";

const defaultIdle = (run: () => void): void => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown }).requestIdleCallback;
  if (typeof ric === "function") ric(run, { timeout: 2_000 });
  else setTimeout(run, 200);
};

const sameBuild = (a: EditionMeta | null | undefined, b: EditionMeta | null | undefined): boolean => !!a && !!b && a.buildId === b.buildId;

function isOlder(candidate: EditionMeta, current: EditionMeta): boolean {
  const a = Date.parse(candidate.generatedAt);
  const b = Date.parse(current.generatedAt);
  return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
}

export function createEditionStore(opts: EditionStoreOptions): EditionStoreImpl {
  const { storage, now } = opts;
  const timers = opts.timers ?? realTimers;
  const idle = opts.idle ?? defaultIdle;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const interval = opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  const load = createLoader({ baseUrl: opts.baseUrl, fetch: opts.fetch, timers });

  // ---- guarded sessionStorage cache -------------------------------------------------------------

  function cacheRead<T>(key: string, validate: (x: unknown) => string | null): T | null {
    if (!storage) return null;
    const raw = readRaw(storage, key);
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    if (value === undefined || validate(value) !== null) {
      removeKey(storage, key);
      return null;
    }
    return value as T;
  }
  const cacheWrite = (key: string, value: unknown): void => {
    // A refused write (quota) must not leave an older build behind under the same key.
    if (storage && !writeRaw(storage, key, JSON.stringify(value))) removeKey(storage, key);
  };
  const cacheDrop = (key: string): void => {
    if (storage) removeKey(storage, key);
  };

  // ---- state --------------------------------------------------------------------------------------

  let front: EditionFront | null = cacheRead<EditionFront>(CACHE_KEYS.front, validateEditionFront);
  let rest: EditionRest | null = null;
  if (front) {
    const cachedRest = cacheRead<EditionRest>(CACHE_KEYS.rest, validateEditionRest);
    if (cachedRest && sameBuild(cachedRest, front)) rest = cachedRest;
    else if (cachedRest) cacheDrop(CACHE_KEYS.rest);
  }

  const store = createStore<EditionStoreState>({
    status: front ? (rest ? "complete" : "front") : "loading",
    edition: front ? mergeEdition(front, rest) : null,
    brief: cacheRead<BriefFile>(CACHE_KEYS.brief, validateBriefFile),
    stocks: cacheRead<StocksFile>(CACHE_KEYS.stocks, validateStocksFile),
    river: null,
    riverStatus: "idle",
    fetchedAtMs: null,
    outdatedClient: false,
    restStatus: rest ? "ready" : "idle",
  });

  let disposed = false;
  const set = (patch: Partial<EditionStoreState>): void => {
    if (disposed) return;
    store.update((prev) => {
      for (const k of Object.keys(patch) as (keyof EditionStoreState)[]) {
        if (!Object.is(prev[k], patch[k])) return { ...prev, ...patch };
      }
      return prev;
    });
  };

  let wantRiver = false;
  let frontFlight: Promise<FrontOutcome> | null = null;
  let frontFlightFresh = false;
  let restFlight: Promise<void> | null = null;
  let riverFlight: Promise<void> | null = null;
  let bootFlight: Promise<void> | null = null;
  let refreshFlight: Promise<void> | null = null;
  let restQueued = false;
  let refreshTimer: unknown = null;
  let lastAttemptMs: number | null = null;

  /**
   * One file with backoff. Gives up early on failures that will not heal within seconds.
   * `onRetry` runs each time a failed attempt is about to be followed by another one.
   */
  async function loadWithRetry<T>(file: string, validate: (x: unknown) => string | null, fresh: boolean, timeoutMs: number, onRetry?: () => void): Promise<LoadResult<T>> {
    let res = await load<T>(file, validate, { fresh, timeoutMs });
    for (let attempt = 0; attempt < delays.length && !res.ok && isTransient(res.reason) && !disposed; attempt++) {
      onRetry?.();
      await sleep(timers, delays[attempt]);
      if (disposed) break;
      res = await load<T>(file, validate, { fresh: true, timeoutMs });
    }
    return res;
  }

  // ---- front --------------------------------------------------------------------------------------

  /** Patch that ends "still trying" - empty unless the flag is up, so it never adds a key or a notification. */
  const doneRetrying = (): Partial<EditionStoreState> => (store.get().retrying ? { retrying: false } : {});

  function commit(f: EditionFront, r: EditionRest | null, fetchedAtMs: number): void {
    front = f;
    rest = r;
    cacheWrite(CACHE_KEYS.front, f);
    if (r) cacheWrite(CACHE_KEYS.rest, r);
    else cacheDrop(CACHE_KEYS.rest);
    set({
      status: r ? "complete" : "front",
      edition: mergeEdition(f, r),
      error: undefined,
      fetchedAtMs,
      restStatus: r ? "ready" : restFlight ? "loading" : "idle",
      ...doneRetrying(),
    });
    if (!r) queueRest();
  }

  async function fetchFront(fresh: boolean): Promise<FrontOutcome> {
    if (!front) set({ status: "loading", error: undefined });
    // With nothing on screen a failed attempt is said out loud: three attempts of up to 25 s each
    // are otherwise 80 s of an unchanging "loading…".
    const res = await loadWithRetry<EditionFront>(DATA_FILES.front, validateEditionFront, fresh, TIMEOUT_MS.edition, () => {
      if (!front) set({ retrying: true });
    });
    if (disposed) return "failed";
    if (!res.ok) {
      if (res.newer) set({ outdatedClient: true });
      if (!front) {
        const why = res.newer ? "A newer version of AI DRUDGE is available - reload the page." : `Failed to load headlines: ${describeFailure(res.reason, res.detail)}.`;
        set({ status: "error", error: why, ...doneRetrying() });
      } else if (!res.newer) {
        // An edition is on screen: keep it and its status, but say that it could not be refreshed
        // (the shell shows "Could not refresh" + Retry). Not for `newer`: the Reload banner covers it.
        set({ error: `Failed to refresh headlines: ${describeFailure(res.reason, res.detail)}.` });
      }
      return "failed";
    }
    const f = res.data;
    const t = now();
    // Every success clears a "could not refresh" left by an earlier attempt, not only commit().
    if (front && sameBuild(f, front)) {
      set({ fetchedAtMs: t, error: undefined });
      return "same";
    }
    // A CDN node (or the HTTP cache) can answer with an OLDER build than the one on screen.
    if (front && isOlder(f, front)) {
      set({ fetchedAtMs: t, error: undefined });
      return "kept";
    }
    let r: EditionRest | null = null;
    if (rest) {
      // Complete edition on screen: fetch the new rest first and swap both in one step, so section
      // pages do not shrink to homepage rows and grow back.
      const rr = await load<EditionRest>(DATA_FILES.rest, validateEditionRest, { fresh, timeoutMs: TIMEOUT_MS.edition });
      if (disposed) return "failed";
      if (rr.ok && sameBuild(rr.data, f)) r = rr.data;
    }
    commit(f, r, t);
    if (wantRiver && !sameBuild(store.get().river, f)) void startRiver(true);
    return "changed";
  }

  function checkFront(fresh: boolean): Promise<FrontOutcome> {
    if (disposed) return Promise.resolve("failed");
    if (frontFlight) {
      if (frontFlightFresh || !fresh) return frontFlight;
      // A cache-tolerant request is in flight but the caller needs a revalidated copy: run after it.
      return frontFlight.then(() => checkFront(true));
    }
    frontFlightFresh = fresh;
    const flight = fetchFront(fresh).finally(() => {
      if (frontFlight === flight) frontFlight = null;
    });
    frontFlight = flight;
    return flight;
  }

  // ---- brief + stocks + status --------------------------------------------------------------------

  async function loadAux(fresh: boolean): Promise<void> {
    const brief = load<BriefFile>(DATA_FILES.brief, validateBriefFile, { fresh, timeoutMs: TIMEOUT_MS.aux }).then((res) => {
      if (!res.ok) {
        if (res.newer) set({ outdatedClient: true });
        return;
      }
      if (disposed || sameBuild(res.data, store.get().brief)) return;
      cacheWrite(CACHE_KEYS.brief, res.data);
      set({ brief: res.data });
    });
    const stocks = load<StocksFile>(DATA_FILES.stocks, validateStocksFile, { fresh, timeoutMs: TIMEOUT_MS.aux }).then((res) => {
      if (!res.ok) {
        if (res.newer) set({ outdatedClient: true });
        return;
      }
      if (disposed || sameBuild(res.data, store.get().stocks)) return;
      cacheWrite(CACHE_KEYS.stocks, res.data);
      set({ stocks: res.data });
    });
    // Ops metadata, read for its stale threshold only. A failure keeps the last known value.
    const status = load<{ staleAfterMinutes: number }>(DATA_FILES.status, validateStaleAfter, { fresh, timeoutMs: TIMEOUT_MS.aux }).then((res) => {
      if (res.ok) set({ staleAfterMinutes: res.data.staleAfterMinutes });
    });
    await Promise.all([brief, stocks, status]);
  }

  // ---- rest ---------------------------------------------------------------------------------------

  function mergeRest(r: EditionRest): boolean {
    if (!front || !sameBuild(r, front)) return false;
    rest = r;
    cacheWrite(CACHE_KEYS.rest, r);
    set({ status: "complete", edition: mergeEdition(front, r), restStatus: "ready" });
    return true;
  }

  async function restCycle(): Promise<void> {
    if (!front) {
      // Wait for front.json only: the boot cycle also covers brief/stocks, whose 8 s timeout must
      // never delay the headlines' second half.
      void start();
      if (frontFlight) await frontFlight;
    }
    if (disposed || !front || rest) return;
    set({ restStatus: "loading" });
    let refetchedFront = false;
    let fresh = false;
    let attempt = 0;
    for (;;) {
      const res = await load<EditionRest>(DATA_FILES.rest, validateEditionRest, { fresh, timeoutMs: TIMEOUT_MS.edition });
      if (disposed) return;
      if (rest) return; // an atomic refresh merged it meanwhile
      if (res.ok) {
        if (mergeRest(res.data)) return;
        if (!refetchedFront) {
          // Another build's rest: refetch front ONCE; if they still disagree, ask for rest again.
          refetchedFront = true;
          fresh = true;
          await checkFront(true);
          if (disposed || rest) return;
          if (mergeRest(res.data)) return;
          continue;
        }
      } else {
        if (res.newer) set({ outdatedClient: true });
        if (!isTransient(res.reason)) break;
      }
      if (attempt >= delays.length) break;
      await sleep(timers, delays[attempt]);
      attempt += 1;
      fresh = true;
      if (disposed) return;
      if (rest) return;
    }
    set({ restStatus: "error" });
  }

  function loadRest(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (restFlight) return restFlight;
    if (front && rest) return Promise.resolve();
    const flight = restCycle().finally(() => {
      if (restFlight === flight) restFlight = null;
    });
    restFlight = flight;
    return flight;
  }

  function queueRest(): void {
    if (restQueued || disposed || !front || rest) return;
    restQueued = true;
    idle(() => {
      restQueued = false;
      if (!disposed) void loadRest();
    });
  }

  // ---- river --------------------------------------------------------------------------------------

  async function riverCycle(fresh: boolean): Promise<void> {
    if (!store.get().river) set({ riverStatus: "loading" });
    if (!fresh) {
      const cached = cacheRead<RiverFile>(CACHE_KEYS.river, validateRiverFile);
      if (cached && front && sameBuild(cached, front)) {
        set({ river: cached, riverStatus: "ready" });
        return;
      }
    }
    const res = await loadWithRetry<RiverFile>(DATA_FILES.river, validateRiverFile, fresh, TIMEOUT_MS.edition);
    if (disposed) return;
    if (!res.ok) {
      if (res.newer) set({ outdatedClient: true });
      // Keep an older river on screen rather than replacing it with an error.
      set({ riverStatus: store.get().river ? "ready" : "error" });
      return;
    }
    // The river is self-contained, so it is shown even if front could not be brought to its build.
    if (front && !sameBuild(res.data, front)) await checkFront(true);
    if (disposed) return;
    cacheWrite(CACHE_KEYS.river, res.data);
    set({ river: res.data, riverStatus: "ready" });
  }

  function startRiver(fresh: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    if (riverFlight) return riverFlight;
    const flight = riverCycle(fresh).finally(() => {
      if (riverFlight === flight) riverFlight = null;
    });
    riverFlight = flight;
    return flight;
  }

  function loadRiver(): Promise<void> {
    wantRiver = true;
    if (riverFlight) return riverFlight;
    const river = store.get().river;
    if (river && (!front || sameBuild(river, front))) return Promise.resolve();
    return startRiver(river !== null);
  }

  // ---- revalidation + auto-refresh ----------------------------------------------------------------

  const visible = (): boolean => !opts.visibility || opts.visibility.visibilityState !== "hidden";

  function schedule(): void {
    if (refreshTimer !== null) {
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (disposed || interval <= 0 || !visible()) return;
    const due = Math.max(0, (lastAttemptMs ?? now()) + interval - now());
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, due);
  }

  async function revalidate(fresh: boolean): Promise<void> {
    // front.json goes on the wire first: it is the one request first paint waits for.
    const frontDone = checkFront(fresh);
    const aux = loadAux(fresh);
    await frontDone;
    if (front && !rest) queueRest();
    const river = store.get().river;
    if (wantRiver && fresh && (!river || (front !== null && !sameBuild(river, front)))) void startRiver(true);
    await aux;
    lastAttemptMs = now();
    schedule();
  }

  function start(): Promise<void> {
    if (disposed) return Promise.resolve();
    bootFlight ??= revalidate(false);
    return bootFlight;
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshFlight) return refreshFlight;
    const flight = revalidate(true).finally(() => {
      if (refreshFlight === flight) refreshFlight = null;
    });
    refreshFlight = flight;
    return flight;
  }

  const overdue = (): boolean => lastAttemptMs !== null && now() - lastAttemptMs >= interval;

  const onVisibility = (): void => {
    if (disposed || interval <= 0) return;
    if (!visible()) {
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = null;
      return;
    }
    if (overdue()) void refresh();
    else if (lastAttemptMs !== null) schedule();
  };
  const onOnline = (): void => {
    if (disposed || lastAttemptMs === null) return;
    const s = store.get();
    // `error` with an edition on screen = the last refresh failed (often: woke up before Wi-Fi did).
    if (s.status === "error" || s.error !== undefined || s.fetchedAtMs === null || overdue()) void refresh();
  };
  opts.visibility?.addEventListener("visibilitychange", onVisibility);
  opts.connectivity?.addEventListener("online", onOnline);

  if (opts.autoStart !== false) void start();

  return {
    get: store.get,
    subscribe: store.subscribe,
    loadRest,
    loadRiver,
    refresh,
    staleHours: (nowMs) => staleHours(store.get().edition?.meta.generatedAt, nowMs),
    start,
    dispose: () => {
      disposed = true;
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = null;
      opts.visibility?.removeEventListener("visibilitychange", onVisibility);
      opts.connectivity?.removeEventListener("online", onOnline);
    },
  };
}
