// Keyword watchlist: terms in localStorage, matched with THE word-boundary matcher of the project
// (shared/text.ts compileTerms, plural on). Ships empty; presets are one-click additions.

import { NO_TERMS, compileTerms, type TermMatcher } from "../../shared/text";
import { WATCH_PRESETS } from "../app/presets";
import { STORAGE_KEYS, type WatchPreset, type WatchlistState, type WatchlistStore } from "../app/services";
import { createPersistedStore, defineKey, isRecord, type KeySpec, type StorageEventSource, type StorageLike } from "./storage";

export const WATCHLIST_VERSION = 1;
export const MAX_TERM_LENGTH = 80;
export const MAX_TERMS = 200;

/** Trimmed, inner whitespace collapsed. "" when the term is unusable (blank, too long, nothing to match). */
export function cleanTerm(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const term = raw.trim().replace(/\s+/g, " ");
  if (!term || term.length > MAX_TERM_LENGTH) return "";
  // "*" or "-" alone compile to nothing: do not store what can never match.
  return compileTerms([term]).size === 1 ? term : "";
}

/** Clean terms, de-duplicated case-insensitively, insertion order kept, capped at MAX_TERMS. */
export function mergeTerms(existing: readonly string[], added: readonly unknown[]): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const out = [...existing];
  for (const raw of added) {
    if (out.length >= MAX_TERMS) break;
    const term = cleanTerm(raw);
    if (!term || have.has(term.toLowerCase())) continue;
    have.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

function parseWatchlist(data: unknown): WatchlistState | null {
  if (!isRecord(data) || !Array.isArray(data.terms)) return null;
  return { terms: mergeTerms([], data.terms) };
}

export const WATCHLIST_KEY: KeySpec<WatchlistState> = defineKey({
  key: STORAGE_KEYS.watchlist,
  version: WATCHLIST_VERSION,
  parse: parseWatchlist,
});

export const EMPTY_WATCHLIST: WatchlistState = { terms: [] };

export interface WatchlistStoreOptions {
  storage: StorageLike;
  events?: StorageEventSource | null;
  /** Default: WATCH_PRESETS ("CISO", "Local LLM", "Finance regulation"). */
  presets?: readonly WatchPreset[];
  onWriteError?: (key: string) => void;
}

export interface WatchlistStoreImpl extends WatchlistStore {
  reload(): void;
  dispose(): void;
}

export function createWatchlistStore(opts: WatchlistStoreOptions): WatchlistStoreImpl {
  const presets = opts.presets ?? WATCH_PRESETS;
  const store = createPersistedStore<WatchlistState>({
    storage: opts.storage,
    spec: WATCHLIST_KEY,
    fallback: EMPTY_WATCHLIST,
    events: opts.events,
    onWriteError: opts.onWriteError,
  });

  const addAll = (terms: readonly unknown[]): void => {
    store.update((s) => {
      const next = mergeTerms(s.terms, terms);
      return next.length === s.terms.length ? s : { terms: next };
    });
  };

  let compiledFor: readonly string[] | null = null;
  let compiled: TermMatcher = NO_TERMS;

  return {
    get: store.get,
    subscribe: store.subscribe,
    add: (term) => addAll([term]),
    remove: (term) => {
      const key = term.trim().replace(/\s+/g, " ").toLowerCase();
      store.update((s) => {
        const next = s.terms.filter((t) => t.toLowerCase() !== key);
        return next.length === s.terms.length ? s : { terms: next };
      });
    },
    addPreset: (id) => addAll(presets.find((p) => p.id === id)?.terms ?? []),
    clear: () => void store.update((s) => (s.terms.length === 0 ? s : EMPTY_WATCHLIST)),
    matcher: () => {
      const terms = store.get().terms;
      if (terms !== compiledFor) {
        compiledFor = terms;
        compiled = terms.length > 0 ? compileTerms(terms, { plural: true }) : NO_TERMS;
      }
      return compiled;
    },
    presets,
    reload: store.reload,
    dispose: store.dispose,
  };
}
