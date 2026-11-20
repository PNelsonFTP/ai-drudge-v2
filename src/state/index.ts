// Reader state - public surface for src/app/createServices.ts.
//
//   const env = browserEnv();
//   const state = createReaderState({ storage: env.local, events: env.events, now: Date.now,
//                                     root: env.root, matchMedia: env.matchMedia });
//   const edition = createEditionStore({ baseUrl, fetch: env.fetch, storage: env.session, now: Date.now,
//                                        visibility: env.visibility, connectivity: env.connectivity });
//   const sourcesData = createSourcesStore({ baseUrl, fetch: env.fetch });
//   wireStores({ edition, sourcesData, saved: state.saved, mutes: state.mutes, lastVisit: state.lastVisit,
//                visibility: env.visibility, now: Date.now });
//   env.onPageHide(() => state.readState.flush());

import type { MigrationReport } from "../app/services";
import { createBackupService, type BackupServiceImpl } from "./backup";
import { readLastVisit, type LastVisit } from "./lastVisit";
import { migrateV1 } from "./migrateV1";
import { createMutesStore, type MutesStoreImpl, type NamedSource } from "./mutes";
import { createReadStateStore, type ObserverFactory, type ReadStateStoreImpl, type ReadStateTimers } from "./readState";
import { createSavedStore, type SavedStoreImpl } from "./saved";
import { createSettingsStore, type AppearanceRoot, type MediaQueryLike, type SettingsStoreImpl } from "./settings";
import { listKeys, removeKey, safeStorage, type StorageEventSource, type StorageLike } from "./storage";
import { createWatchlistStore, type WatchlistStoreImpl } from "./watchlist";

export * from "./backup";
export * from "./lastVisit";
export * from "./migrateV1";
export * from "./mutes";
export * from "./readState";
export * from "./saved";
export * from "./settings";
export * from "./storage";
export * from "./watchlist";
export * from "./wire";

export interface ReaderStateEnv {
  /** localStorage (use browserEnv().local, which falls back to memory when storage is blocked). */
  storage: StorageLike;
  /** Clock, epoch ms. */
  now: () => number;
  /** `window`: cross-tab sync through the `storage` event. */
  events?: StorageEventSource | null;
  /** document.documentElement: theme + density are applied to it. */
  root?: AppearanceRoot | null;
  matchMedia?: ((query: string) => MediaQueryLike) | null;
  /** Override the IntersectionObserver (tests). */
  createObserver?: ObserverFactory | null;
  timers?: ReadStateTimers;
  /** Known sources for mapping V1 muted display names during the import (usually not available yet). */
  sources?: Iterable<NamedSource> | null;
  /** A storage write was refused (quota / disabled): the change lives in memory only. */
  onWriteError?: (key: string) => void;
}

export interface ReaderState {
  saved: SavedStoreImpl;
  mutes: MutesStoreImpl;
  readState: ReadStateStoreImpl;
  settings: SettingsStoreImpl;
  watchlist: WatchlistStoreImpl;
  backup: BackupServiceImpl;
  lastVisit: LastVisit;
  /** Outcome of the one-time V1 import of this page load. */
  migration: MigrationReport;
  /**
   * Import V1 state again (Settings: "Re-import from V1") and refresh the live stores. `sources`: the
   * sources known by now (edition / river / sources.json), so muted display names map to ids at once
   * instead of being parked as pending names.
   */
  reimportV1(sources?: Iterable<NamedSource> | null): MigrationReport;
  dispose(): void;
}

/**
 * Build every reader-state service in the one order that is correct:
 * V1 import -> last visit -> stores (so the first render already sees imported state).
 */
export function createReaderState(env: ReaderStateEnv): ReaderState {
  const { storage, now, events, onWriteError } = env;
  const migration = migrateV1(storage, { now, sources: env.sources });
  const lastVisit = readLastVisit(storage, now());
  const saved = createSavedStore({ storage, now, events, onWriteError });
  const mutes = createMutesStore({ storage, events, onWriteError });
  const settings = createSettingsStore({ storage, events, root: env.root, matchMedia: env.matchMedia, onWriteError });
  const watchlist = createWatchlistStore({ storage, events, onWriteError });
  const readState = createReadStateStore({ storage, createObserver: env.createObserver, timers: env.timers });
  const reloadAll = (): void => {
    saved.reload();
    mutes.reload();
    settings.reload();
    watchlist.reload();
  };
  const backup = createBackupService({ storage, now, onRestore: reloadAll });
  return {
    saved,
    mutes,
    readState,
    settings,
    watchlist,
    backup,
    lastVisit,
    migration,
    reimportV1: (sources) => {
      const report = migrateV1(storage, { now, sources: sources ?? env.sources, force: true });
      reloadAll();
      return report;
    },
    dispose: () => {
      saved.dispose();
      mutes.dispose();
      settings.dispose();
      watchlist.dispose();
      readState.dispose();
    },
  };
}

/**
 * "Reset local data": remove every V2 key ("aid2:*") from a storage - localStorage for reader state,
 * sessionStorage for the payload cache. V1's "ai-drudge:*" keys are never touched. Returns the keys
 * removed; reload the page afterwards (live stores keep their in-memory state).
 */
export function resetV2Storage(storage: StorageLike): string[] {
  return listKeys(storage).filter((key) => removeKey(storage, key));
}

export interface BrowserEnv {
  local: StorageLike;
  session: StorageLike;
  events: StorageEventSource | null;
  root: AppearanceRoot | null;
  matchMedia: ((query: string) => MediaQueryLike) | null;
  fetch: (input: string, init?: { cache?: "default" | "no-cache"; signal?: AbortSignal }) => Promise<Response>;
  visibility: Document | null;
  connectivity: Window | null;
  /** Run `fn` when the page is being hidden or unloaded (flush pending writes). */
  onPageHide(fn: () => void): void;
}

/**
 * The real browser, with every access guarded: blocked storage falls back to memory, and outside a
 * browser (tests, SSR) everything is inert. The only place in WP7 that touches window / document.
 */
export function browserEnv(): BrowserEnv {
  const win = typeof window === "undefined" ? null : window;
  const doc = typeof document === "undefined" ? null : document;
  return {
    local: safeStorage(() => win?.localStorage),
    session: safeStorage(() => win?.sessionStorage),
    events: win,
    root: doc?.documentElement ?? null,
    matchMedia: win && typeof win.matchMedia === "function" ? (query) => win.matchMedia(query) : null,
    fetch: (input, init) => fetch(input, init),
    visibility: doc,
    connectivity: win,
    onPageHide: (fn) => {
      win?.addEventListener("pagehide", fn);
      doc?.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "hidden") fn();
      });
    },
  };
}
