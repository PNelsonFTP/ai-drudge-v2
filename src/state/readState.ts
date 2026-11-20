// Seen-dimming. A row counts as seen after 1.5 s at >= 60 % visibility, or when it is opened.
//
// Fixes of the V1 hook (review: read-state-observer-flaws):
//   - Observation is keyed by ELEMENT, so a story rendered in two sections is tracked per instance
//     and marked when ANY instance completes its dwell.
//   - It does not depend on re-renders or mount order: the observer is created lazily on the first
//     observe(); re-registering the same element is a no-op and does not restart its dwell timer;
//     a `observe(null, id)` / cleanup that is immediately followed by a re-attach (React re-running
//     an unstable ref callback) is ignored.
//   - True LRU (re-seen ids move to the end), capped at SEEN_LIMIT; writes are batched and
//     read-merge-write, so two tabs do not clobber each other.
//   - `wasSeen` answers from a snapshot taken at creation: it reflects PREVIOUS page loads only, so
//     nothing fades while it is being read.

import type { ArticleId } from "../../shared/contract";
import { isArticleId } from "../../shared/ids";
import { SEEN_LIMIT, STORAGE_KEYS, type ReadStateStore } from "../app/services";
import { defineKey, readKey, removeKey, stringList, writeKey, type KeySpec, type StorageLike } from "./storage";

export const SEEN_VERSION = 1;
export const DWELL_MS = 1500;
export const VISIBILITY_THRESHOLD = 0.6;
/** Ids marked within this window are written in one storage write. */
export const SEEN_FLUSH_MS = 250;

/** Oldest first, most recently seen last. */
export const SEEN_KEY: KeySpec<ArticleId[]> = defineKey({
  key: STORAGE_KEYS.seen,
  version: SEEN_VERSION,
  parse: (data) => (Array.isArray(data) ? stringList(data, isArticleId) : null),
});

/** Move `ids` to the most-recent end of `list` and keep the newest `limit` entries. */
export function lruTouch(list: readonly ArticleId[], ids: Iterable<ArticleId>, limit: number): ArticleId[] {
  const touched = new Set(ids);
  if (touched.size === 0) return list.length > limit ? list.slice(list.length - limit) : [...list];
  const out = list.filter((id) => !touched.has(id));
  for (const id of touched) out.push(id);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

export interface ObserverEntryLike {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
}

export interface ObserverLike {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (callback: (entries: readonly ObserverEntryLike[]) => void, options: { threshold: number }) => ObserverLike;

export interface ReadStateTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ReadStateOptions {
  storage: StorageLike;
  /** Default: the browser's IntersectionObserver when it exists; without one only markSeen() records. */
  createObserver?: ObserverFactory | null;
  timers?: ReadStateTimers;
  /** Runs a callback after the current synchronous work (default queueMicrotask). */
  defer?: (fn: () => void) => void;
  /** LRU size (default SEEN_LIMIT). */
  limit?: number;
}

export interface ReadStateStoreImpl extends ReadStateStore {
  /**
   * Same as ReadStateStore.observe, and additionally returns a cleanup for that exact element
   * (React 19 ref-cleanup form); `observe(null, id)` still works.
   */
  observe(el: Element | null, id: ArticleId): (() => void) | undefined;
  /** Write pending ids now (call on pagehide / when the tab is hidden). */
  flush(): void;
  /** Ids seen during THIS page load (not reflected by wasSeen). */
  seenNow(): ReadonlySet<ArticleId>;
  dispose(): void;
}

const defaultTimers: ReadStateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultObserverFactory(): ObserverFactory | null {
  if (typeof IntersectionObserver !== "function") return null;
  return (callback, options) => new IntersectionObserver((entries) => callback(entries), options);
}

const defaultDefer = (fn: () => void): void => {
  if (typeof queueMicrotask === "function") queueMicrotask(fn);
  else void Promise.resolve().then(fn);
};

export function createReadStateStore(opts: ReadStateOptions): ReadStateStoreImpl {
  const { storage } = opts;
  const limit = opts.limit ?? SEEN_LIMIT;
  const timers = opts.timers ?? defaultTimers;
  const defer = opts.defer ?? defaultDefer;
  const factory = opts.createObserver === undefined ? defaultObserverFactory() : opts.createObserver;

  const initial = readKey(storage, SEEN_KEY);
  const seenAtLoad = new Set<ArticleId>(initial.status === "ok" ? initial.value : []);
  // A list written by a newer client is left alone.
  const readOnly = initial.status === "unreadable" && initial.reason === "newer";

  const seenThisLoad = new Set<ArticleId>();
  let pending: ArticleId[] = [];
  let flushTimer: unknown = null;

  const idByEl = new Map<Element, ArticleId>();
  const elsById = new Map<ArticleId, Set<Element>>();
  const dwell = new Map<Element, unknown>();
  const releasing = new Set<Element>();
  let observer: ObserverLike | null = null;
  let pruneQueued = false;
  let disposed = false;

  const flush = (): void => {
    if (flushTimer !== null) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0 || readOnly) {
      pending = [];
      return;
    }
    const stored = readKey(storage, SEEN_KEY);
    if (stored.status === "unreadable" && (stored.reason === "newer" || stored.reason === "storage")) return;
    const base = stored.status === "ok" ? stored.value : [];
    if (writeKey(storage, SEEN_KEY, lruTouch(base, pending, limit))) pending = [];
  };

  const markSeen = (id: ArticleId): void => {
    if (!isArticleId(id) || seenThisLoad.has(id)) return;
    seenThisLoad.add(id);
    pending.push(id);
    // Nothing left to learn about this story: stop watching every instance of it.
    for (const el of [...(elsById.get(id) ?? [])]) drop(el);
    if (flushTimer === null) flushTimer = timers.setTimeout(flush, SEEN_FLUSH_MS);
  };

  const stopDwell = (el: Element): void => {
    const t = dwell.get(el);
    if (t === undefined) return;
    timers.clearTimeout(t);
    dwell.delete(el);
  };

  function drop(el: Element): void {
    const id = idByEl.get(el);
    if (id === undefined) return;
    stopDwell(el);
    releasing.delete(el);
    idByEl.delete(el);
    const set = elsById.get(id);
    if (set) {
      set.delete(el);
      if (set.size === 0) elsById.delete(id);
    }
    observer?.unobserve(el);
  }

  const onEntries = (entries: readonly ObserverEntryLike[]): void => {
    for (const entry of entries) {
      const el = entry.target;
      if (!idByEl.has(el)) continue;
      if (entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_THRESHOLD) {
        if (dwell.has(el)) continue;
        dwell.set(
          el,
          timers.setTimeout(() => {
            dwell.delete(el);
            const id = idByEl.get(el);
            if (id !== undefined && el.isConnected !== false) markSeen(id);
          }, DWELL_MS),
        );
      } else {
        stopDwell(el);
      }
    }
  };

  // Releases are applied after the current synchronous work, so "detach then re-attach the same
  // element" (a re-render with a new ref callback) never unobserves it or restarts its dwell timer.
  const prune = (): void => {
    pruneQueued = false;
    for (const el of [...releasing]) drop(el);
  };
  const release = (el: Element): void => {
    if (!idByEl.has(el)) return;
    releasing.add(el);
    if (!pruneQueued) {
      pruneQueued = true;
      defer(prune);
    }
  };

  const observe = (el: Element | null, id: ArticleId): (() => void) | undefined => {
    if (disposed) return undefined;
    if (el === null) {
      // No element reference: release the instances of this id that have left the document. With a
      // single instance that is unambiguous even before the DOM is updated.
      const set = elsById.get(id);
      if (!set) return undefined;
      if (set.size === 1) for (const only of set) release(only);
      else defer(() => void [...(elsById.get(id) ?? [])].filter((e) => e.isConnected === false).forEach(drop));
      return undefined;
    }
    releasing.delete(el);
    const cleanup = (): void => release(el);
    if (idByEl.get(el) === id) return cleanup;
    if (idByEl.has(el)) drop(el); // element re-used for another story
    if (seenThisLoad.has(id)) return cleanup;
    if (!observer && factory) observer = factory(onEntries, { threshold: VISIBILITY_THRESHOLD });
    if (!observer) return cleanup;
    idByEl.set(el, id);
    let set = elsById.get(id);
    if (!set) elsById.set(id, (set = new Set()));
    set.add(el);
    observer.observe(el);
    return cleanup;
  };

  return {
    wasSeen: (id) => seenAtLoad.has(id),
    observe,
    markSeen,
    flush,
    clear: () => {
      // The reader asked for the history to go: nothing waiting to be written survives either.
      if (flushTimer !== null) {
        timers.clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending = [];
      seenAtLoad.clear();
      removeKey(storage, STORAGE_KEYS.seen);
    },
    seenNow: () => seenThisLoad,
    dispose: () => {
      flush();
      disposed = true;
      for (const t of dwell.values()) timers.clearTimeout(t);
      dwell.clear();
      idByEl.clear();
      elsById.clear();
      releasing.clear();
      observer?.disconnect();
      observer = null;
    },
  };
}
