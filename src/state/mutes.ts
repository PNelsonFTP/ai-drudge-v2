// Mutes, keyed on stable ids: SourceId and SectionId (V1 keyed on display names, so a rename
// silently un-muted). V1 names that could not be mapped to a SourceId at migration time are kept as
// `pendingNames` and resolved as soon as an edition or sources.json supplies the name -> id mapping.

import type { SourceId } from "../../shared/contract";
import { isSectionId, type SectionId } from "../../shared/sections";
import { STORAGE_KEYS, type MutesState, type MutesStore } from "../app/services";
import { createPersistedStore, defineKey, isRecord, stringList, type KeySpec, type StorageEventSource, type StorageLike } from "./storage";

export const MUTES_VERSION = 1;
const MAX_ID = 200;

export type { MutesState } from "../app/services";

/** A source as far as name resolution cares (SourceInfo, or an edition's SourceRef with its id). */
export interface NamedSource {
  id: SourceId;
  name: string;
  aliases?: readonly string[];
}

const okId = (s: string): boolean => s.length > 0 && s.length <= MAX_ID;
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

function parseMutes(data: unknown): MutesState | null {
  if (!isRecord(data)) return null;
  return {
    sources: new Set(stringList(data.sources, okId)),
    sections: new Set(stringList(data.sections, isSectionId) as SectionId[]),
    pendingNames: stringList(data.pendingNames, okId),
  };
}

export const MUTES_KEY: KeySpec<MutesState> = defineKey({
  key: STORAGE_KEYS.mutes,
  version: MUTES_VERSION,
  parse: parseMutes,
  encode: (m) => ({ sources: [...m.sources], sections: [...m.sections], pendingNames: m.pendingNames }),
});

export const EMPTY_MUTES: MutesState = { sources: new Set(), sections: new Set(), pendingNames: [] };

function flip<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Lower-cased display name / alias -> SourceId. The first source to claim a name keeps it. */
export function nameIndex(sources: Iterable<NamedSource>): Map<string, SourceId> {
  const index = new Map<string, SourceId>();
  const add = (name: string, id: SourceId): void => {
    const k = nameKey(name);
    if (k && !index.has(k)) index.set(k, id);
  };
  const list = [...sources];
  for (const s of list) add(s.name, s.id);
  for (const s of list) for (const alias of s.aliases ?? []) add(alias, s.id);
  return index;
}

/** Split display names into resolved ids and names that no source claims. */
export function resolveNames(names: readonly string[], sources: Iterable<NamedSource>): { ids: SourceId[]; unresolved: string[] } {
  const index = nameIndex(sources);
  const ids: SourceId[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const id = index.get(nameKey(name));
    if (id === undefined) unresolved.push(name);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unresolved };
}

function resolved(m: MutesState, sources: Iterable<NamedSource>, final: boolean): MutesState {
  if (m.pendingNames.length === 0) return m;
  const { ids, unresolved } = resolveNames(m.pendingNames, sources);
  if (ids.length === 0 && !final) return m;
  return { ...m, sources: new Set([...m.sources, ...ids]), pendingNames: final ? [] : unresolved };
}

export interface MutesStoreOptions {
  storage: StorageLike;
  events?: StorageEventSource | null;
  onWriteError?: (key: string) => void;
}

export interface MutesStoreImpl extends MutesStore {
  /**
   * Map pending V1 display names to ids. Returns how many names are still pending.
   * `final: true` (the full registry, sources.json, was consulted) drops names nobody claims: such a
   * source no longer exists, and keeping the name would re-trigger the lookup on every visit.
   */
  resolvePending(sources: Iterable<NamedSource>, opts?: { final?: boolean }): number;
  reload(): void;
  dispose(): void;
}

export function createMutesStore(opts: MutesStoreOptions): MutesStoreImpl {
  const store = createPersistedStore<MutesState>({
    storage: opts.storage,
    spec: MUTES_KEY,
    fallback: EMPTY_MUTES,
    events: opts.events,
    onWriteError: opts.onWriteError,
  });
  return {
    get: store.get,
    subscribe: store.subscribe,
    toggleSource: (id) => {
      if (okId(id)) store.update((m) => ({ ...m, sources: flip(m.sources, id) }));
    },
    toggleSection: (id) => {
      if (isSectionId(id)) store.update((m) => ({ ...m, sections: flip(m.sections, id) }));
    },
    dropPendingName: (name) => {
      const key = nameKey(name);
      store.update((m) => (m.pendingNames.some((n) => nameKey(n) === key) ? { ...m, pendingNames: m.pendingNames.filter((n) => nameKey(n) !== key) } : m));
    },
    clear: () =>
      void store.update((m) => (m.sources.size === 0 && m.sections.size === 0 && m.pendingNames.length === 0 ? m : EMPTY_MUTES)),
    resolvePending: (sources, o) => {
      if (store.get().pendingNames.length === 0) return 0;
      const list = [...sources];
      store.update((m) => resolved(m, list, o?.final ?? false));
      return store.get().pendingNames.length;
    },
    reload: store.reload,
    dispose: store.dispose,
  };
}
