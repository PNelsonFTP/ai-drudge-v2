// One section's ranked row list: hard window -> soft window -> diversity caps -> starvation fill
// -> allRows cap. Pure; the caller passes candidates already ranked best first.

import type { ArticleId } from "../../../shared/contract";
import type { SectionDef } from "../../../shared/sections";
import type { Clock } from "../../../shared/time";
import type { ScoredStory } from "../types";
import { DiversityCounter, diversify, type DiversityKeys } from "./diversity";
import { starvationFill } from "./fill";
import { ROUTE_POLICY } from "./rules";
import { splitByWindow } from "./windows";

export type CutReason = "window" | "diversity" | "cap";

export interface SectionResult {
  rows: ScoredStory[];
  /** Candidates that did not make the list, by lead id. */
  cut: Map<ArticleId, CutReason>;
}

/** Diversity identity of a story = its lead item's publisher and feed. */
export function diversityKeys(story: ScoredStory): DiversityKeys {
  const lead = story.items[0];
  return { publisher: lead.publisher, source: lead.sourceId };
}

/**
 * Move `held` items out of the first `rows` positions when enough other items exist; relative order
 * is otherwise unchanged.
 */
export function holdBack<T>(ranked: readonly T[], isHeld: (item: T) => boolean, rows: number): T[] {
  const out: T[] = [];
  const waiting: T[] = [];
  for (const item of ranked) {
    if (isHeld(item) && out.length < rows) {
      waiting.push(item);
      continue;
    }
    out.push(item);
    if (out.length >= rows && waiting.length) out.push(...waiting.splice(0));
  }
  return [...out, ...waiting];
}

/**
 * A slow, high-signal source may carry an explicit `maxAgeDays` that EXTENDS the section's hard
 * window for its stories (FINRA alerts: 30 d in a 7-day section); normalize copies it onto the item
 * only when the registry sets it. Extended stories sit in the backfill band: they only surface
 * through the starvation fill.
 */
function ownHardDays(story: ScoredStory): number | undefined {
  return story.items[0].maxAgeDays;
}

const isRelease = (s: ScoredStory): boolean => s.items[0].kind === "github-release" || s.items[0].flags.includes("release");

export function buildSection(def: SectionDef, ranked: readonly ScoredStory[], now: Clock): SectionResult {
  const cut = new Map<ArticleId, CutReason>();
  const { soft, backfill, expired } = splitByWindow(ranked, def.window, now, ownHardDays);
  for (const s of expired) cut.set(s.lead, "window");

  // A release tag routed in from the release radar must not headline a news section (V1: a
  // llama.cpp build tag was #1 in two sections).
  const guestRelease = (s: ScoredStory): boolean => isRelease(s) && s.items[0].home !== def.id;
  const ordered = holdBack(soft, guestRelease, ROUTE_POLICY.releaseHoldBackRows);

  const div = diversify(ordered, { share: def.maxPublisherShare, homeRows: def.homeRows, limit: def.allRows, keysOf: diversityKeys });
  for (const s of div.overflow) cut.set(s.lead, "cap");

  const fits = (candidate: ScoredStory, rows: readonly ScoredStory[]): boolean => {
    const counter = new DiversityCounter<ScoredStory>(def.maxPublisherShare, def.homeRows, diversityKeys);
    for (const r of rows) counter.add(r);
    return counter.fits(candidate, rows.length + 1);
  };
  const min = Math.min(def.window.minItems, def.allRows);
  // Older stories that keep the caps first; then, rather than starve, relax the caps.
  const older = starvationFill(div.kept, backfill, min, fits);
  const relaxed = starvationFill(older.rows, div.deferred, min);
  const last = starvationFill(relaxed.rows, older.unused, min);

  for (const s of relaxed.unused) cut.set(s.lead, "diversity");
  for (const s of last.unused) cut.set(s.lead, "window");
  return { rows: last.rows, cut };
}
