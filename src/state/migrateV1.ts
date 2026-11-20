// One-time, READ-ONLY import of V1 reader state ("ai-drudge:*" localStorage keys) into the V2
// namespace. V1 and V2 may be served from the same github.io origin and V1 stays live, so this
// module only ever calls getItem on V1 keys: every write goes through storage.ts, which refuses any
// key outside "aid2:". The three V1 sessionStorage cache keys are never read at all.
//
// Imported: bookmarks, read-later, article snapshots, muted sources (display name -> SourceId via
// sources.json names/aliases when given, otherwise parked as pending names), muted categories (a V2
// section is muted only when every V1 category folded into it was muted), seen ids, theme, last visit.
//
// Everything is MERGED into whatever V2 state already exists (a forced re-import must not lose V2
// bookmarks), validated on the way in (the origin is shared - stored URLs are not trusted), and a
// V2 key written by a newer client is left alone.

import type { ArticleId } from "../../shared/contract";
import { isArticleId } from "../../shared/ids";
import { SECTIONS, type SectionId } from "../../shared/sections";
import { DEFAULT_SETTINGS, SEEN_LIMIT, STORAGE_KEYS, V1_STORAGE_KEYS, type MigrationCounts, type MigrationReport, type MutesState, type SavedSnapshot, type SavedState, type Theme } from "../app/services";

export type { MigrationCounts, MigrationReport, MigrationStatus } from "../app/services";
import { LAST_VISIT_KEY } from "./lastVisit";
import { EMPTY_MUTES, MUTES_KEY, resolveNames, type NamedSource } from "./mutes";
import { SEEN_KEY, lruTouch } from "./readState";
import { EMPTY_SAVED, SAVED_KEY, parseSnapshot } from "./saved";
import { SETTINGS_KEY } from "./settings";
import { defineKey, isRecord, readKey, readRaw, stringList, writeKey, type KeySpec, type ReadResult, type StorageLike } from "./storage";

export interface MigrationMarker {
  /** ISO time of the import. */
  at: string;
  imported: MigrationCounts;
}

export const MIGRATION_VERSION = 1;

const NO_COUNTS: MigrationCounts = {
  bookmarks: 0,
  later: 0,
  snapshots: 0,
  mutedSources: 0,
  pendingSourceNames: 0,
  mutedSections: 0,
  seen: 0,
  theme: false,
  lastVisit: false,
};

/** Most V1 category ids kept from a stored marker (V1 had 13 categories). */
const MAX_SKIPPED_CATEGORIES = 32;

/**
 * The counts of a stored marker, field by field. The marker is reader state on an origin other
 * pages share (github.io), so it is untrusted like every other key: a number must be a finite,
 * non-negative number, a flag must be `true`, and `skippedCategories` a list of strings - the
 * Settings page iterates it while rendering, and a marker holding `5` there took the whole page
 * (backup and "Erase all reader data" included) down on every visit.
 */
export function parseCounts(raw: unknown): MigrationCounts {
  if (!isRecord(raw)) return NO_COUNTS;
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const skipped = Array.isArray(raw.skippedCategories) ? stringList(raw.skippedCategories).slice(0, MAX_SKIPPED_CATEGORIES) : [];
  return {
    bookmarks: count(raw.bookmarks),
    later: count(raw.later),
    snapshots: count(raw.snapshots),
    mutedSources: count(raw.mutedSources),
    pendingSourceNames: count(raw.pendingSourceNames),
    mutedSections: count(raw.mutedSections),
    seen: count(raw.seen),
    theme: raw.theme === true,
    lastVisit: raw.lastVisit === true,
    ...(skipped.length > 0 ? { skippedCategories: skipped } : {}),
  };
}

export const MIGRATED_KEY: KeySpec<MigrationMarker> = defineKey({
  key: STORAGE_KEYS.migratedFromV1,
  version: MIGRATION_VERSION,
  parse: (data) => {
    if (!isRecord(data) || typeof data.at !== "string") return null;
    return { at: data.at, imported: parseCounts(data.imported) };
  },
});

export interface MigrateV1Options {
  /** Clock, epoch ms (default Date.now). */
  now?: () => number;
  /** sources.json entries (or any id/name/aliases list) to map V1 muted display names to ids. */
  sources?: Iterable<NamedSource> | null;
  /** Import again even though the marker exists (Settings: "Re-import from V1"). */
  force?: boolean;
}

/** What V1 left in localStorage, validated. Reading never throws and never writes. */
export interface V1State {
  found: boolean;
  bookmarks: ArticleId[];
  later: ArticleId[];
  snapshots: Record<ArticleId, SavedSnapshot>;
  mutedSourceNames: string[];
  mutedCategories: string[];
  seen: ArticleId[];
  theme: Theme | null;
  lastVisitMs: number | null;
}

function readJson(storage: StorageLike, key: string): { present: boolean; value: unknown } {
  const raw = readRaw(storage, key);
  if (raw === undefined || raw === null) return { present: false, value: null };
  try {
    return { present: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { present: true, value: null };
  }
}

export function readV1State(storage: StorageLike, savedAt: string): V1State {
  const bookmarks = readJson(storage, V1_STORAGE_KEYS.bookmarks);
  const later = readJson(storage, V1_STORAGE_KEYS.readLater);
  const snaps = readJson(storage, V1_STORAGE_KEYS.snapshots);
  const sources = readJson(storage, V1_STORAGE_KEYS.mutedSources);
  const categories = readJson(storage, V1_STORAGE_KEYS.mutedCategories);
  const seen = readJson(storage, V1_STORAGE_KEYS.seen);
  // V1 stored the theme and the last visit as bare strings, not JSON.
  const themeRaw = readRaw(storage, V1_STORAGE_KEYS.theme);
  const visitRaw = readRaw(storage, V1_STORAGE_KEYS.lastVisit);

  const snapshots: Record<ArticleId, SavedSnapshot> = {};
  if (isRecord(snaps.value)) {
    for (const id of Object.keys(snaps.value)) {
      const v = snaps.value[id];
      if (!isArticleId(id) || !isRecord(v)) continue;
      // V1 Article: { id, title, url, source, publishedAt, ... }
      const snap = parseSnapshot({ title: v.title, url: v.url, sourceName: v.source, publishedAt: v.publishedAt ?? null, savedAt }, id);
      if (snap) snapshots[id] = snap;
    }
  }
  const visit = typeof visitRaw === "string" ? Date.parse(visitRaw) : NaN;
  return {
    found: bookmarks.present || later.present || snaps.present || sources.present || categories.present || seen.present || typeof themeRaw === "string" || typeof visitRaw === "string",
    bookmarks: stringList(bookmarks.value, isArticleId),
    later: stringList(later.value, isArticleId),
    snapshots,
    mutedSourceNames: stringList(sources.value, (s) => s.trim().length > 0 && s.length <= 200),
    mutedCategories: stringList(categories.value),
    seen: stringList(seen.value, isArticleId),
    theme: themeRaw === "dark" || themeRaw === "light" ? themeRaw : null,
    lastVisitMs: Number.isNaN(visit) ? null : visit,
  };
}

/**
 * V2 sections to mute for a set of muted V1 categories. Several V2 sections fold two V1 categories
 * (LOCAL & OPEN MODELS = local_models + open_source, CYBER WIRE = cyber_threats + cyber_defense, ...):
 * such a section is muted only when EVERY V1 category it folds was muted. Muting half of it in V1
 * must not hide the other half - a section that comes back is one click to mute again, a priority
 * section that silently disappears is not noticed. (safety_policy still mutes both POLICY and SAFETY:
 * each has that single V1 id.)
 */
export function mutedSectionsOf(v1Categories: readonly string[]): SectionId[] {
  const muted = new Set(v1Categories);
  return SECTIONS.filter((s) => s.legacyIds.length > 0 && s.legacyIds.every((l) => muted.has(l))).map((s) => s.id);
}

/**
 * The V1 muted category ids that mutedSectionsOf() does NOT carry over: half of a merged section
 * (the section stays visible) and ids no V2 section knows. Distinct, in V1 order. Reported as
 * MigrationCounts.skippedCategories so Settings can name them instead of losing them silently.
 */
export function skippedCategoriesOf(v1Categories: readonly string[]): string[] {
  const mutedSections = new Set<SectionId>(mutedSectionsOf(v1Categories));
  const carried = new Set<string>(SECTIONS.filter((s) => mutedSections.has(s.id)).flatMap((s) => s.legacyIds));
  return [...new Set(v1Categories)].filter((id) => !carried.has(id));
}

/** The existing V2 value to merge into; `skip` when it must not be touched (newer client / no storage). */
function existing<T>(res: ReadResult<T>, fallback: T): { base: T; skip: boolean; empty: boolean } {
  if (res.status === "ok") return { base: res.value, skip: false, empty: false };
  if (res.status === "unreadable" && (res.reason === "newer" || res.reason === "storage")) return { base: fallback, skip: true, empty: false };
  return { base: fallback, skip: false, empty: true };
}

function added<T>(into: ReadonlySet<T>, values: readonly T[]): { set: Set<T>; count: number } {
  const set = new Set(into);
  let count = 0;
  for (const v of values) {
    if (set.has(v)) continue;
    set.add(v);
    count++;
  }
  return { set, count };
}

/**
 * Import V1 state once. Never writes, removes or rewrites an "ai-drudge:*" key.
 * Call before readLastVisit() and before any store is created, so the first render already sees
 * the imported state.
 */
export function migrateV1(storage: StorageLike, opts: MigrateV1Options = {}): MigrationReport {
  const marker = readKey(storage, MIGRATED_KEY);
  if (!opts.force && marker.status !== "empty") {
    // Present (or unreadable / from a newer client): the import has run, do not repeat it.
    return marker.status === "ok" ? { status: "already", imported: marker.value.imported, at: marker.value.at } : { status: "already", imported: NO_COUNTS };
  }
  const nowMs = (opts.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const v1 = readV1State(storage, nowIso);
  if (!v1.found) return { status: "nothing", imported: NO_COUNTS };

  const counts: MigrationCounts = { ...NO_COUNTS };
  let ok = true;

  // ---- bookmarks, read-later, snapshots
  const saved = existing(readKey(storage, SAVED_KEY), EMPTY_SAVED);
  if (!saved.skip && (v1.bookmarks.length > 0 || v1.later.length > 0)) {
    const b = added(saved.base.bookmarks, v1.bookmarks);
    const l = added(saved.base.later, v1.later);
    const snapshots: Record<ArticleId, SavedSnapshot> = { ...saved.base.snapshots };
    for (const id of new Set([...b.set, ...l.set])) {
      // An existing V2 snapshot is newer than anything V1 has.
      if (!snapshots[id] && v1.snapshots[id]) {
        snapshots[id] = v1.snapshots[id];
        counts.snapshots++;
      }
    }
    counts.bookmarks = b.count;
    counts.later = l.count;
    const next: SavedState = { bookmarks: b.set, later: l.set, snapshots };
    if (b.count + l.count + counts.snapshots > 0) ok = writeKey(storage, SAVED_KEY, next) && ok;
  }

  // ---- mutes
  const mutes = existing(readKey(storage, MUTES_KEY), EMPTY_MUTES);
  if (!mutes.skip && (v1.mutedSourceNames.length > 0 || v1.mutedCategories.length > 0)) {
    const { ids, unresolved } = resolveNames(v1.mutedSourceNames, opts.sources ?? []);
    const sources = added(mutes.base.sources, ids);
    const sectionIds = mutedSectionsOf(v1.mutedCategories);
    const sections = added(mutes.base.sections, sectionIds);
    const havePending = new Set(mutes.base.pendingNames.map((n) => n.toLowerCase()));
    const newPending = unresolved.filter((n) => !havePending.has(n.toLowerCase()));
    counts.mutedSources = sources.count;
    counts.mutedSections = sections.count;
    counts.pendingSourceNames = newPending.length;
    // Only when there is something to name: the field stays absent otherwise (see services.ts).
    const skipped = skippedCategoriesOf(v1.mutedCategories);
    if (skipped.length > 0) counts.skippedCategories = skipped;
    const next: MutesState = { sources: sources.set, sections: sections.set, pendingNames: [...mutes.base.pendingNames, ...newPending] };
    if (sources.count + sections.count + newPending.length > 0) ok = writeKey(storage, MUTES_KEY, next) && ok;
  }

  // ---- seen ids (V1 order is oldest -> newest, same as V2)
  const seen = existing(readKey(storage, SEEN_KEY), []);
  if (!seen.skip && v1.seen.length > 0) {
    const have = new Set(seen.base);
    const fresh = v1.seen.filter((id) => !have.has(id));
    counts.seen = fresh.length;
    // V1 ids are older than anything V2 recorded: they go to the old end of the LRU.
    if (fresh.length > 0) ok = writeKey(storage, SEEN_KEY, lruTouch([...fresh, ...seen.base], [], SEEN_LIMIT)) && ok;
  }

  // ---- theme: only when the reader has not chosen anything in V2 yet
  const settings = existing(readKey(storage, SETTINGS_KEY), DEFAULT_SETTINGS);
  if (!settings.skip && settings.empty && v1.theme) {
    counts.theme = true;
    ok = writeKey(storage, SETTINGS_KEY, { ...DEFAULT_SETTINGS, theme: v1.theme }) && ok;
  }

  // ---- last visit: seeds the session record; readLastVisit() turns it into previousMs
  const visit = existing(readKey(storage, LAST_VISIT_KEY), null);
  if (!visit.skip && visit.empty && v1.lastVisitMs !== null && v1.lastVisitMs <= nowMs) {
    counts.lastVisit = true;
    ok = writeKey(storage, LAST_VISIT_KEY, { previousMs: null, lastSeenMs: v1.lastVisitMs, seenEditionMs: null }) && ok;
  }

  if (!ok) return { status: "failed", imported: counts };
  if (!writeKey(storage, MIGRATED_KEY, { at: nowIso, imported: counts })) return { status: "failed", imported: counts };
  return { status: "migrated", imported: counts, at: nowIso };
}
