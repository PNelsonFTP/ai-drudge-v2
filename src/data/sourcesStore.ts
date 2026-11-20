// sources.json + health.json for the Sources page. Lazy: nothing is fetched until load().
// The registry is what the page needs; feed health is a bonus - when only health.json fails the
// store is "ready" with `health: null`, and the next load() asks for health again.

import { DATA_FILES, type HealthFile, type SourcesFile } from "../../shared/contract";
import { validateHealthFile, validateSourcesFile } from "../../shared/guards";
import { createStore, type SourcesState, type SourcesStore } from "../app/services";
import { RETRY_DELAYS_MS, TIMEOUT_MS, createLoader, describeFailure, isTransient, realTimers, sleep, type FetchLike, type LoadResult, type Timers } from "./fetchJson";

export interface SourcesStoreOptions {
  baseUrl: string;
  fetch: FetchLike;
  timers?: Timers;
  retryDelaysMs?: readonly number[];
}

export interface SourcesStoreImpl extends SourcesStore {
  /** Fetch both files again (after the edition moved to a new build). Keeps the current data on failure. */
  reload(): Promise<void>;
}

export function createSourcesStore(opts: SourcesStoreOptions): SourcesStoreImpl {
  const timers = opts.timers ?? realTimers;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const fetchFile = createLoader({ baseUrl: opts.baseUrl, fetch: opts.fetch, timers });
  const store = createStore<SourcesState>({ status: "idle", sources: null, health: null });
  let flight: Promise<void> | null = null;

  async function withRetry<T>(file: string, validate: (x: unknown) => string | null, fresh: boolean): Promise<LoadResult<T>> {
    let res = await fetchFile<T>(file, validate, { fresh, timeoutMs: TIMEOUT_MS.edition });
    for (let attempt = 0; attempt < delays.length && !res.ok && isTransient(res.reason); attempt++) {
      await sleep(timers, delays[attempt]);
      res = await fetchFile<T>(file, validate, { fresh: true, timeoutMs: TIMEOUT_MS.edition });
    }
    return res;
  }

  async function cycle(fresh: boolean): Promise<void> {
    const prev = store.get();
    const needSources = fresh || prev.sources === null;
    if (prev.sources === null) store.set({ ...prev, status: "loading", error: undefined });
    const [sources, health] = await Promise.all([
      needSources ? withRetry<SourcesFile>(DATA_FILES.sources, validateSourcesFile, fresh) : null,
      // One attempt: health is optional, and a missing health.json must not delay the page by the backoff.
      fetchFile<HealthFile>(DATA_FILES.health, validateHealthFile, { fresh, timeoutMs: TIMEOUT_MS.aux }),
    ]);
    const cur = store.get();
    const nextSources = sources?.ok ? sources.data : cur.sources;
    const nextHealth = health.ok ? health.data : cur.health;
    if (nextSources === null) {
      const why = sources && !sources.ok ? describeFailure(sources.reason, sources.detail) : "unknown error";
      store.set({ status: "error", sources: null, health: nextHealth, error: `Failed to load the source list: ${why}.` });
      return;
    }
    store.set({ status: "ready", sources: nextSources, health: nextHealth });
  }

  const run = (fresh: boolean): Promise<void> => {
    if (flight) return flight;
    const f = cycle(fresh).finally(() => {
      if (flight === f) flight = null;
    });
    flight = f;
    return f;
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    load: () => {
      const s = store.get();
      if (s.status === "ready" && s.health !== null) return Promise.resolve();
      return run(false);
    },
    reload: () => run(true),
  };
}
