// "New since your last visit". V1 overwrote its timestamp on every page load, so an accidental
// reload zeroed the banner, and it compared the reader's clock against publishedAt.
//
// V2 keeps a small session record:
//   - A visit is a SESSION: loads less than SESSION_GAP_MS apart belong to the same one, so a reload
//     keeps `previousMs` (and the banner).
//   - When a new session starts, `previousMs` becomes the generatedAt of the newest edition the
//     reader was shown in the previous session (noteEdition), falling back to the last time the page
//     was open. Editions and ArticleV2.firstSeenAt are both stamped by the build clock, so
//     `firstSeenAt > previousMs` means exactly "was not in anything the reader has been shown" -
//     independent of the reader's clock and of the build-to-deploy gap.
//   - A tab that stays open rolls the session the same way: noteEdition() is the heartbeat (wire.ts
//     calls it only while the tab is visible), and a heartbeat more than SESSION_GAP_MS after the
//     previous one starts a new session whose cut-off is the newest edition shown before the gap.
//   - "Mark all seen" moves the cut-off to the newest edition SHOWN, not to the reader's clock: a
//     build stamped before the click but not deployed yet keeps its stories "new".

import { STORAGE_KEYS, createStore, type LastVisitStore } from "../app/services";
import { defineKey, isRecord, readKey, removeKey, writeKey, type KeySpec, type StorageLike } from "./storage";

export const LAST_VISIT_VERSION = 1;
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface LastVisitRecord {
  /** Cut-off of the CURRENT session: what was new when it started (or "mark all seen"); null on a first visit. */
  previousMs: number | null;
  /** Last time the page was known to be open (epoch ms, reader's clock). */
  lastSeenMs: number;
  /** generatedAt (epoch ms) of the newest edition shown in the current session; null before any. */
  seenEditionMs: number | null;
}

const isMs = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

export const LAST_VISIT_KEY: KeySpec<LastVisitRecord> = defineKey({
  key: STORAGE_KEYS.lastVisit,
  version: LAST_VISIT_VERSION,
  parse: (data) => {
    if (!isRecord(data) || !isMs(data.lastSeenMs)) return null;
    return {
      previousMs: isMs(data.previousMs) ? data.previousMs : null,
      lastSeenMs: data.lastSeenMs,
      seenEditionMs: isMs(data.seenEditionMs) ? data.seenEditionMs : null,
    };
  },
});

/** AppServices.lastVisit plus the hook wireStores() feeds. */
export interface LastVisit extends LastVisitStore {
  /**
   * Record that an edition generated at `generatedAtMs` is on screen and visible now. Also the
   * session heartbeat: after a gap longer than SESSION_GAP_MS the cut-off rolls to the newest edition
   * noted before the gap.
   */
  noteEdition(generatedAtMs: number, nowMs: number): void;
}

/** The record a page load at `nowMs` should continue with, given what was stored. */
export function nextVisitRecord(stored: LastVisitRecord | null, nowMs: number): LastVisitRecord {
  if (!stored) return { previousMs: null, lastSeenMs: nowMs, seenEditionMs: null };
  // A clock that jumped backwards counts as the same session rather than inventing a new one.
  const sameSession = nowMs - stored.lastSeenMs <= SESSION_GAP_MS;
  if (sameSession) return { ...stored, lastSeenMs: Math.max(stored.lastSeenMs, nowMs) };
  return { previousMs: stored.seenEditionMs ?? stored.lastSeenMs, lastSeenMs: nowMs, seenEditionMs: null };
}

/**
 * Read the previous visit and record this one. Call ONCE per page load, after migrateV1 (which
 * seeds the record from V1's last-visit) and before the stores are created.
 */
export function readLastVisit(storage: StorageLike, nowMs: number): LastVisit {
  const read = (): { record: LastVisitRecord | null; writable: boolean } => {
    const res = readKey(storage, LAST_VISIT_KEY);
    if (res.status === "ok") return { record: res.value, writable: true };
    return { record: null, writable: !(res.status === "unreadable" && (res.reason === "newer" || res.reason === "storage")) };
  };
  const first = read();
  // The record of THIS page load; the fallback when storage has been cleared since.
  let record = nextVisitRecord(first.record, nowMs);
  // A refused write (quota) leaves storage behind this tab: keep building on the in-memory record
  // instead of re-reading the stale stored one.
  let unsaved = first.writable && !writeKey(storage, LAST_VISIT_KEY, record);
  const store = createStore({ previousMs: record.previousMs });
  /** Apply a change to the stored record (re-read first: another tab of the same session may have written). */
  const update = (change: (base: LastVisitRecord) => LastVisitRecord | null): void => {
    const cur = read();
    const next = change(unsaved ? record : (cur.record ?? record));
    if (!next) return;
    record = next;
    if (cur.writable) unsaved = !writeKey(storage, LAST_VISIT_KEY, next);
  };
  /** The record may have moved the cut-off (here or in another tab of the session). */
  const syncStore = (): void => {
    if (store.get().previousMs !== record.previousMs) store.set({ previousMs: record.previousMs });
  };
  return {
    get: store.get,
    subscribe: store.subscribe,
    markAllSeen: (now) => {
      if (!isMs(now)) return;
      // The cut-off moves forward only; it is stored so a reload inside the session keeps it.
      update((base) => {
        // Build clock when an edition was shown; the reader's clock only as a fallback.
        const cut = base.seenEditionMs ?? now;
        return base.previousMs !== null && base.previousMs >= cut ? null : { ...base, previousMs: cut, lastSeenMs: Math.max(base.lastSeenMs, now) };
      });
      syncStore();
    },
    clear: () => {
      // As on a first visit: no cut-off, no edition noted. The session heartbeat (noteEdition) writes
      // a fresh record from here, so the NEXT visit has a cut-off again.
      removeKey(storage, STORAGE_KEYS.lastVisit);
      record = { previousMs: null, lastSeenMs: record.lastSeenMs, seenEditionMs: null };
      unsaved = false;
      syncStore();
    },
    noteEdition: (generatedAtMs, now) => {
      if (!isMs(generatedAtMs) || !isMs(now)) return;
      update((base) => {
        const seenEditionMs = Math.max(base.seenEditionMs ?? 0, generatedAtMs);
        if (now - base.lastSeenMs > SESSION_GAP_MS && base.seenEditionMs !== null) {
          // Back after a long gap in a tab that stayed open: a new session. Its cut-off is the newest
          // edition shown BEFORE the gap (never the reader's clock, and never an edition that was only
          // fetched while the tab was hidden - those are not noted).
          return { previousMs: Math.max(base.previousMs ?? 0, base.seenEditionMs), lastSeenMs: now, seenEditionMs };
        }
        const lastSeenMs = Math.max(base.lastSeenMs, now);
        return seenEditionMs === base.seenEditionMs && lastSeenMs === base.lastSeenMs ? null : { ...base, seenEditionMs, lastSeenMs };
      });
      syncStore();
    },
  };
}
