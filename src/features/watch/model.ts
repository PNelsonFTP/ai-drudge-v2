// Watchlist page model (#/watch): hits of each watch term over the 7-day river, grouped by term.
// Matching is shared/text.ts compileTerms (word boundaries, "*" wildcard, plural s/es) on TITLES
// only - the same matcher the headline rows use to highlight. Pure.

import type { ArticleId, RiverFile } from "../../../shared/contract";
import { collapseStories, riverMatching, type MuteSet } from "../../../shared/select";
import { compileTerms } from "../../../shared/text";
import { DAY_MS } from "../../../shared/time";
import { riverRef, type RowRef } from "../export/kit/rows";

export const WATCH_WINDOW_DAYS = 7;
export const TERM_MAX_LENGTH = 60;
export const TERMS_MAX = 100;

export interface WatchGroup {
  term: string;
  /** One row per story (the newest matching headline of each story), newest first. */
  rows: RowRef[];
  /** Stories in the window. */
  count: number;
  /** Of `count`: stories from the last 24 hours. */
  last24h: number;
}

export interface WatchView {
  /** Terms with hits: most hits first, ties in the reader's term order. */
  groups: WatchGroup[];
  /** Terms without a hit in the window, in the reader's order. */
  quiet: string[];
  /** Distinct stories across all terms (a story matching two terms counts once). */
  stories: number;
}

export interface WatchInput {
  river: RiverFile;
  terms: readonly string[];
  mutes: MuteSet;
  nowMs: number;
}

export function buildWatchView(input: WatchInput): WatchView {
  const { river, terms, mutes, nowMs } = input;
  const from = nowMs - WATCH_WINDOW_DAYS * DAY_MS;
  const dayAgo = nowMs - DAY_MS;
  const groups: (WatchGroup & { order: number })[] = [];
  const quiet: string[] = [];
  const all = new Set<ArticleId>();

  terms.forEach((term, order) => {
    // One matcher per term: with a combined matcher the longer of two overlapping terms would win
    // and "open source" would lose its hits to "open source model".
    const matcher = compileTerms([term], { plural: true });
    const hits = matcher.size === 0 ? [] : collapseStories(riverMatching(river, matcher, mutes).filter((r) => r.effectiveMs >= from));
    if (hits.length === 0) {
      quiet.push(term);
      return;
    }
    for (const r of hits) all.add(r.leadId ?? r.id);
    groups.push({ term, order, rows: hits.map(riverRef), count: hits.length, last24h: hits.filter((r) => r.effectiveMs >= dayAgo).length });
  });

  groups.sort((a, b) => b.count - a.count || a.order - b.order);
  return { groups: groups.map(({ order: _order, ...g }) => g), quiet, stories: all.size };
}

export type TermCheck = { ok: true; term: string } | { ok: false; error: string };

/** Validate a term typed by the reader against the current list. */
export function checkTerm(raw: string, existing: readonly string[]): TermCheck {
  const term = raw.trim().replace(/\s+/g, " ");
  if (!term) return { ok: false, error: "Type a word or phrase to watch." };
  if (term.length > TERM_MAX_LENGTH) return { ok: false, error: `Keep a term under ${TERM_MAX_LENGTH} characters.` };
  if (compileTerms([term]).size === 0) return { ok: false, error: "A term needs at least one letter or digit besides the * wildcard." };
  if (existing.some((t) => t.toLowerCase() === term.toLowerCase())) return { ok: false, error: `“${term}” is already on your watchlist.` };
  if (existing.length >= TERMS_MAX) return { ok: false, error: `The watchlist holds at most ${TERMS_MAX} terms. Remove one first.` };
  return { ok: true, term };
}

/** How many terms of a preset are not on the list yet. */
export function presetMissing(presetTerms: readonly string[], existing: readonly string[]): number {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  return presetTerms.filter((t) => !have.has(t.toLowerCase())).length;
}
