// Bookmarks + read-later. ONE storage key holds both id lists and the snapshots, so they can never
// disagree (V1 kept three keys and a GC effect that could wipe every snapshot).
//
//   - The snapshot is written AT TOGGLE TIME from the article the reader clicked, so a saved story
//     survives the hourly payload rotation by construction.
//   - Every mutation is read-merge-write (another tab's changes are kept) and tabs stay in sync
//     through the `storage` event.
//   - GC is part of the same atomic write: a snapshot is dropped only when neither list holds its id.
//   - Snapshot URLs are re-validated on every read: localStorage is shared with every other project
//     on the origin, so a stored "javascript:" URL must never reach an href.

import type { ArticleId, ArticleV2 } from "../../shared/contract";
import { isArticleId } from "../../shared/ids";
import { sourceName, type Edition } from "../../shared/select";
import { isHttpUrl } from "../../shared/url";
import { STORAGE_KEYS, type SavedSnapshot, type SavedState, type SavedStore, type SavedTab } from "../app/services";
import { createPersistedStore, defineKey, isRecord, stringList, type KeySpec, type StorageEventSource, type StorageLike } from "./storage";

export const SAVED_VERSION = 1;
const MAX_TITLE = 300;

const isIsoOrNull = (x: unknown): x is string | null => x === null || (typeof x === "string" && !Number.isNaN(Date.parse(x)));

/** A valid snapshot for `id`, or null. Never trusts the stored URL scheme. */
export function parseSnapshot(x: unknown, id: ArticleId): SavedSnapshot | null {
  if (!isRecord(x)) return null;
  if (typeof x.title !== "string" || !x.title.trim()) return null;
  if (typeof x.url !== "string" || !isHttpUrl(x.url)) return null;
  const savedAt = typeof x.savedAt === "string" && !Number.isNaN(Date.parse(x.savedAt)) ? x.savedAt : new Date(0).toISOString();
  return {
    id,
    title: x.title.slice(0, MAX_TITLE),
    url: x.url,
    sourceName: typeof x.sourceName === "string" ? x.sourceName : "",
    publishedAt: isIsoOrNull(x.publishedAt) ? x.publishedAt : null,
    savedAt,
  };
}

function parseSaved(data: unknown): SavedState | null {
  if (!isRecord(data)) return null;
  const bookmarks = new Set(stringList(data.bookmarks, isArticleId));
  const later = new Set(stringList(data.later, isArticleId));
  const snapshots: Record<ArticleId, SavedSnapshot> = {};
  if (isRecord(data.snapshots)) {
    for (const id of Object.keys(data.snapshots)) {
      if (!bookmarks.has(id) && !later.has(id)) continue; // unreferenced: GC on read
      const snap = parseSnapshot(data.snapshots[id], id);
      if (snap) snapshots[id] = snap;
    }
  }
  return { bookmarks, later, snapshots };
}

export const SAVED_KEY: KeySpec<SavedState> = defineKey({
  key: STORAGE_KEYS.saved,
  version: SAVED_VERSION,
  parse: parseSaved,
  encode: (s) => ({ bookmarks: [...s.bookmarks], later: [...s.later], snapshots: s.snapshots }),
});

export const EMPTY_SAVED: SavedState = { bookmarks: new Set(), later: new Set(), snapshots: {} };

export function snapshotOf(a: Pick<ArticleV2, "id" | "title" | "url" | "publishedAt">, name: string, savedAt: string): SavedSnapshot {
  return { id: a.id, title: a.title.slice(0, MAX_TITLE), url: a.url, sourceName: name, publishedAt: a.publishedAt, savedAt };
}

/** Remove `id` from one list; its snapshot goes only when the other list does not hold it either. */
function without(s: SavedState, tab: SavedTab, id: ArticleId): SavedState {
  if (!s[tab].has(id)) return s;
  const set = new Set(s[tab]);
  set.delete(id);
  const other = tab === "bookmarks" ? s.later : s.bookmarks;
  if (other.has(id)) return { ...s, [tab]: set };
  const snapshots = { ...s.snapshots };
  delete snapshots[id];
  return { ...s, [tab]: set, snapshots };
}

function toggled(s: SavedState, tab: SavedTab, a: ArticleV2, name: string, savedAt: string): SavedState {
  if (s[tab].has(a.id)) return without(s, tab, a.id);
  if (!isHttpUrl(a.url)) return s;
  const set = new Set(s[tab]);
  set.add(a.id);
  return { ...s, [tab]: set, snapshots: { ...s.snapshots, [a.id]: snapshotOf(a, name, savedAt) } };
}

function cleared(s: SavedState, tab: SavedTab): SavedState {
  if (s[tab].size === 0) return s;
  const other = tab === "bookmarks" ? s.later : s.bookmarks;
  const snapshots: Record<ArticleId, SavedSnapshot> = {};
  for (const id of other) if (s.snapshots[id]) snapshots[id] = s.snapshots[id];
  return { ...s, [tab]: new Set<ArticleId>(), snapshots };
}

/**
 * Bring saved items in line with a freshly loaded edition:
 * - refresh the snapshot of every saved story the edition carries (titles change after publication),
 * - create the snapshot of an id that has none (ids imported from V1 without a snapshot),
 * - once the edition is complete, drop ids that have neither a snapshot nor an article - they can
 *   never be shown, and would only inflate the count.
 */
export function reconciled(s: SavedState, e: Edition, nowIso: string): SavedState {
  let snapshots: Record<ArticleId, SavedSnapshot> | null = null;
  const drop: ArticleId[] = [];
  for (const id of new Set([...s.bookmarks, ...s.later])) {
    const a = e.articles[id];
    const snap = s.snapshots[id];
    if (!a) {
      if (!snap && e.complete) drop.push(id);
      continue;
    }
    if (!isHttpUrl(a.url)) continue;
    const name = sourceName(e, a.src);
    if (snap && snap.title === a.title && snap.url === a.url && snap.sourceName === name && snap.publishedAt === a.publishedAt) continue;
    snapshots ??= { ...s.snapshots };
    snapshots[id] = snapshotOf(a, name, snap?.savedAt ?? nowIso);
  }
  if (!snapshots && drop.length === 0) return s;
  const next: SavedState = { bookmarks: s.bookmarks, later: s.later, snapshots: snapshots ?? s.snapshots };
  if (drop.length === 0) return next;
  const bookmarks = new Set(s.bookmarks);
  const later = new Set(s.later);
  for (const id of drop) {
    bookmarks.delete(id);
    later.delete(id);
  }
  return { ...next, bookmarks, later };
}

export interface SavedStoreOptions {
  /** localStorage (or any StorageLike). */
  storage: StorageLike;
  /** Clock, epoch ms. */
  now: () => number;
  /** `window`, for cross-tab sync. */
  events?: StorageEventSource | null;
  onWriteError?: (key: string) => void;
}

export interface SavedStoreImpl extends SavedStore {
  /** Refresh / complete snapshots from a loaded edition (call on every edition change). */
  reconcile(edition: Edition | null): void;
  /** Re-read storage (after a backup restore). */
  reload(): void;
  dispose(): void;
}

export function createSavedStore(opts: SavedStoreOptions): SavedStoreImpl {
  const store = createPersistedStore<SavedState>({
    storage: opts.storage,
    spec: SAVED_KEY,
    fallback: EMPTY_SAVED,
    events: opts.events,
    onWriteError: opts.onWriteError,
  });
  const nowIso = (): string => new Date(opts.now()).toISOString();
  return {
    get: store.get,
    subscribe: store.subscribe,
    toggleBookmark: (a, name) => void store.update((s) => toggled(s, "bookmarks", a, name, nowIso())),
    toggleLater: (a, name) => void store.update((s) => toggled(s, "later", a, name, nowIso())),
    consume: (id) => void store.update((s) => without(s, "later", id)),
    remove: (tab, id) => void store.update((s) => without(s, tab, id)),
    clear: (tab) => void store.update((s) => cleared(s, tab)),
    reconcile: (edition) => {
      if (!edition) return;
      const s = store.get();
      if (s.bookmarks.size === 0 && s.later.size === 0) return;
      store.update((fresh) => reconciled(fresh, edition, nowIso()));
    },
    reload: store.reload,
    dispose: store.dispose,
  };
}
