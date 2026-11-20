// Every constant of the score stage. Nothing else in scripts/pipeline/score holds a number.
//
//   score = recency + fade x (tier + coverage + importance + hn)
//
// Scale (points, before the fade):               typical story
//   recency     0 .. 50   half-life 36 h, counted from the  50 new, 25 at 36 h, 12.5 at 72 h
//                         time the story last gained a
//                         publisher (index.ts freshAt)
//   tier        0 .. 30   source tier of the lead           20
//   coverage    0 .. 88   22 x log2(publishers)             0 / 22 / 35 / 51 / 66 for 1 / 2 / 3 / 5 / 8
//   importance  0 .. 12   title-only event signals, or a      0 or 5-10
//                         regulator's own publication
//   hn          0 .. 10   exact-URL Hacker News points      0
//
// Coverage is the only part that can exceed recency, so an eight-publisher story from yesterday
// outranks whatever a single source posted a minute ago, while among single-source items the page
// still reads newest-first with tier as the tiebreak. (V1 had no coverage term and a 100-point
// recency: a 2-hour-old build tag outranked the day's frontier-model launch.)
//
// The fade (half-life 96 h, on the LEAD's age) is what keeps a section fresh: without it a
// six-publisher story would sit above today's news for as long as the section's window lets it
// live. It multiplies every part except recency, so two stories of the SAME age that are no longer
// growing always compare on tier + coverage + importance + hn alone.

import type { Tier } from "../../../shared/contract";
import { PIPELINE } from "../context";

export const SCORE = {
  /** Base points by the lead's source tier (1 critical .. 4 low). */
  tierBase: { 1: 30, 2: 20, 3: 10, 4: 0 } satisfies Record<Tier, number>,
  /** A release line never gets more tier points than this, whatever tier its repo feed has. */
  releaseTierCap: 10,
  /** Recency points of a brand-new story; halves every `halfLifeHours`. */
  recencyMax: 50,
  halfLifeHours: PIPELINE.recencyHalfLifeHours,
  /** Half-life of the fade applied to tier + coverage + importance + hn. */
  fadeHalfLifeHours: 96,
  /** Age assumed when effectiveAt cannot be parsed (the contract says it always can). */
  unknownAgeHours: 168,
  /** Coverage points per doubling of the publisher count (one publisher = 0). */
  coveragePerDoubling: 22,
  /** Publisher counts above this add nothing more. */
  coverageMaxPublishers: 16,
  importance: {
    /** Launch / release verb together with a model or vendor name. */
    launch: 6,
    /** ... and the title names a versioned model ("Gemini 4", "GPT-6.2", "Qwen3.8"). */
    versionedModel: 3,
    /** A money amount with a funding / deal word, or an IPO / acquisition. */
    funding: 5,
    /** A regulatory or legal action. */
    regulatory: 5,
    /** A security incident. */
    security: 5,
    /**
     * A regulator's own publication (source tags "regulator" + "first-party": FINRA notices, SEC,
     * Bank of England PRA, FCA ...). Such a notice IS the event, but its title rarely says so
     * ("Regulatory Notice 26-24: FINRA has adopted amendments to Rule 2210" matches no event word),
     * and nobody else covers it, so on tier + recency alone it sat below every same-day opinion piece
     * (POLICY #30 of 30 at 38 h). Not a title signal: it is read from the source's tags.
     */
    regulatorNotice: 10,
    /** Cap on the sum. */
    max: 12,
  },
  hn: {
    /** Hacker News points worth one score point. */
    pointsPerPoint: 20,
    max: 10,
  },
  /**
   * Emphasis weight thresholds (ArticleV2.w): publishers for w = 3 and for w = 2, and the publisher
   * count from which a tier-4 lead is no longer muted (w = 0 only below it).
   */
  weight: { critical: 8, high: 3, corroborated: 2 },
} as const;
