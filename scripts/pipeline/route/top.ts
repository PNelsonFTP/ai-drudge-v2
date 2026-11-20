// TOP STORIES and the lead (replaces V1 "trending" + a per-article argmax lead).
//
// V1 evidence: 100 distinct leads in 308 builds (49 of 106 tenures lasted one build), leads such as
// "Inside Singapore Airlines' New Business Class Cabins", Reddit posts, arXiv listings and a live
// blog; 42% of Trending rows were twin feeds of ONE publisher and 6% were release-tag merges.
//
//   TOP STORIES  ai-desk stories covered by >= 2 PUBLISHERS within 72 h (120 h when fewer than 4
//                qualify), ranked by SCORE - for a story only two publishers cover, with the
//                recency part capped (topStanding: such a story counts as no fresher than about
//                12 h) - publisher count breaking ties, at most 2 per lead publisher, max 12, never
//                led by a release / community item.
//                Coverage is already the largest part of the score (22 points per doubling, capped
//                at 16 publishers, fading with a 96 h half-life). Ranking on the raw count first
//                was measured on the live build of 2026-11-20: four 3-6 publisher stories of
//                48-55 h (scores 51-70; two of them listed in NO section) sat above three
//                2-publisher stories of 0.5-2.5 h (scores 89-94), one extra publisher outweighed a
//                40-point score gap, and a count never fades.
//   RUNNING STORY  a follow-up of a story already chosen gets a slot only with independent weight
//                (5+ publishers of its own), and one running story holds at most 2 slots
//                (running.ts); the rest are reported as `related` of the story they follow.
//   HOLD         membership hysteresis: a story of the previous build's TOP (ctx.state.top) that
//                would drop out keeps its slot for up to 2 h unless the newcomer replacing it
//                scores clearly more (ROUTE_POLICY.topHold) - also when the incumbent is down to ONE
//                publisher. The list is still ordered by today's scores, so a held story sits low.
//   LEAD         top[0], except that the previous lead (ctx.state.lead) keeps the slot while its
//                story is still in the first 3 and is < 24 h old (story age AND tenure).
//   QUIET DAY    no multi-publisher story at all: the lead is the best-scoring lead-eligible
//                ai-desk story (not a paper, live blog, video or digest) and top = [lead].

import { TOP_STORIES_MAX, type ArticleId } from "../../../shared/contract";
import { ageHours, parseMs, HOUR_MS } from "../../../shared/time";
import { PIPELINE, topStanding } from "../context";
import type { PipelineState, ScoredStory, TopMemory } from "../types";
import { ROUTE_POLICY } from "./rules";
import { foldRunningStories } from "./running";

export interface TopInput {
  /** All stories, any order. */
  stories: readonly ScoredStory[];
  /** Is the story on the ai desk (home on an ai-desk section, or moved into one)? */
  isAiDesk: (story: ScoredStory) => boolean;
  now: Date;
  /** ctx.state.lead */
  previousLead: PipelineState["lead"];
  /** ctx.state.top (absent on a first run: no hold). */
  previousTop?: readonly TopMemory[];
}

export interface TopResult {
  top: ArticleId[];
  leadId: ArticleId | null;
  /** "coverage": multi-publisher stories exist; "quiet": single best story; "empty": nothing eligible. */
  mode: "coverage" | "quiet" | "empty";
  /** The 72 h window was relaxed to 120 h. */
  relaxed: boolean;
  /** The previous lead was kept over a higher-ranked story. */
  held: boolean;
  /** Follow-ups folded under a TOP story (same running story): TOP lead id -> their lead ids. */
  related: Record<ArticleId, ArticleId[]>;
  /** TOP stories that are in the list by the hold rule: lead id -> when the hold began, and the score held. */
  holds: Record<ArticleId, { since: string; score: number }>;
}

/** Titles / URLs that must not become the lead on a quiet day (V1 led with all of these). */
const NOT_A_HEADLINE: readonly RegExp[] = [
  /[–—-]\s*(?:[\p{L}]+\s+)?live\s*$/iu, // "... – business live"
  /[–—-]\s*(?:video|podcast|audio)\s*$/iu,
  /^\s*(?:live|watch|listen|video|podcast)\s*:/i,
  /^\s*bookmarked\s*:/i,
  /^\s*\[[^\]]{1,24}\]/, // "[tl;dr sec] #355 ...", "[AINews] ..."
];
const NOT_A_HEADLINE_URL = /\/(?:live|video|videos|podcast|podcasts)\//i;

function effectiveMs(story: ScoredStory): number {
  return parseMs(story.effectiveAt) ?? 0;
}

/** TOP standing first (the score - it already carries coverage, with the fade - recency capped for a two-publisher story), then the wider coverage, then score, freshest, id. */
export function compareTop(a: ScoredStory, b: ScoredStory): number {
  return topStanding(b) - topStanding(a) || b.publishers.length - a.publishers.length || compareScore(a, b);
}

export function compareScore(a: ScoredStory, b: ScoredStory): number {
  return b.score - a.score || effectiveMs(b) - effectiveMs(a) || (a.lead < b.lead ? -1 : a.lead > b.lead ? 1 : 0);
}

/** May this story appear in TOP STORIES at all (desk aside)? Never a release / community lead. */
export function isTopEligible(story: ScoredStory): boolean {
  const lead = story.items[0];
  if (!lead.leadEligible) return false;
  if (lead.kind === "github-release" || lead.kind === "community") return false;
  return !lead.flags.includes("release") && !lead.flags.includes("discussion");
}

function isQuietDayHeadline(story: ScoredStory): boolean {
  const lead = story.items[0];
  if (lead.kind === "papers" || lead.flags.includes("paper")) return false;
  if (NOT_A_HEADLINE_URL.test(lead.url)) return false;
  return !NOT_A_HEADLINE.some((re) => re.test(lead.title));
}

/** At most `max` stories per lead publisher, order preserved. */
function capPerLeadPublisher(ranked: readonly ScoredStory[], max: number): ScoredStory[] {
  const counts = new Map<string, number>();
  return ranked.filter((s) => {
    const p = s.items[0].publisher;
    const n = counts.get(p) ?? 0;
    if (n >= max) return false;
    counts.set(p, n + 1);
    return true;
  });
}

/**
 * Stability rule. Returns the index (within the first PIPELINE.leadStickyTop) of the story that
 * contains the previous lead ARTICLE - as lead or as member, because a growing cluster may change
 * its lead article between builds - when that story may keep the slot; else -1.
 */
function stickyIndex(ranked: readonly ScoredStory[], prev: PipelineState["lead"], now: Date): number {
  if (!prev) return -1;
  const since = parseMs(prev.since);
  // Tenure guards against a re-stamped publishedAt (live blogs are "0 h old" forever).
  if (since === null || (now.getTime() - since) / HOUR_MS >= PIPELINE.leadStickyHours) return -1;
  const idx = ranked.slice(0, PIPELINE.leadStickyTop).findIndex((s) => s.items.some((i) => i.id === prev.id));
  if (idx < 0) return -1;
  return ageHours(ranked[idx].effectiveAt, now) < PIPELINE.leadStickyHours ? idx : -1;
}

function withSticky(ranked: readonly ScoredStory[], prev: PipelineState["lead"], now: Date): { ranked: ScoredStory[]; held: boolean } {
  const idx = stickyIndex(ranked, prev, now);
  if (idx <= 0) return { ranked: [...ranked], held: false };
  return { ranked: [ranked[idx], ...ranked.slice(0, idx), ...ranked.slice(idx + 1)], held: true };
}

/** The remembered TOP entry a story continues: one of its articles carries the entry's id (now or under a former URL). */
function memoryOf(story: ScoredStory, previousTop: readonly TopMemory[]): TopMemory | undefined {
  if (previousTop.length === 0) return undefined;
  return previousTop.find((m) => story.items.some((i) => i.id === m.id || (i.formerIds?.includes(m.id) ?? false)));
}

interface HoldResult {
  top: ScoredStory[];
  holds: TopResult["holds"];
}

/**
 * Membership hysteresis. `fresh` = today's list on merit; `bench` = the stories ranked below it,
 * plus incumbents that lost their second publisher. An incumbent on the bench takes back a slot
 * while its hold is younger than topHold.hours and the weakest NEWCOMER in the list does not beat
 * the incumbent's standing (the better of today's TOP standing and the one it last qualified with) by
 * topHold.margin. Incumbents never displace each other, and the result is re-ranked on today's
 * scores, so a hold changes who is in the list - never who leads it on merit.
 */
function applyHold(fresh: readonly ScoredStory[], bench: readonly ScoredStory[], previousTop: readonly TopMemory[], now: Date): HoldResult {
  const holds: TopResult["holds"] = {};
  if (previousTop.length === 0) return { top: [...fresh], holds };
  const { margin, hours } = ROUTE_POLICY.topHold;
  const nowIso = now.toISOString();
  const candidates = bench
    .map((story) => ({ story, memory: memoryOf(story, previousTop) }))
    .filter((c): c is { story: ScoredStory; memory: TopMemory } => {
      if (!c.memory) return false;
      const since = c.memory.heldSince === undefined ? now.getTime() : parseMs(c.memory.heldSince);
      return since !== null && (now.getTime() - since) / HOUR_MS < hours;
    })
    .map((c) => ({ ...c, standing: Math.max(topStanding(c.story), c.memory.score) }))
    .sort((a, b) => b.standing - a.standing || compareTop(a.story, b.story));

  const top = [...fresh];
  const taken = new Set<TopMemory>();
  for (const s of top) {
    const m = memoryOf(s, previousTop);
    if (m) taken.add(m);
  }
  for (const c of candidates) {
    if (taken.has(c.memory)) continue; // the remembered story split in two: its other half is already listed
    if (top.length < TOP_STORIES_MAX) {
      top.push(c.story);
    } else {
      // The weakest newcomer: lowest-ranked story of the list that was not in the previous TOP.
      let weakest = -1;
      for (let i = top.length - 1; i >= 0; i--) {
        if (!memoryOf(top[i], previousTop) && !(top[i].lead in holds)) {
          weakest = i;
          break;
        }
      }
      if (weakest < 0 || topStanding(top[weakest]) - c.standing >= margin) break; // candidates are sorted: nobody weaker holds either
      top.splice(weakest, 1);
      top.push(c.story);
    }
    taken.add(c.memory);
    holds[c.story.lead] = { since: c.memory.heldSince ?? nowIso, score: c.standing };
  }
  return { top: top.sort(compareTop), holds };
}

export function pickTop(input: TopInput): TopResult {
  const { now } = input;
  const previousTop = input.previousTop ?? [];
  const eligible = input.stories.filter((s) => isTopEligible(s) && input.isAiDesk(s));
  const within = (hours: number) => (s: ScoredStory): boolean => ageHours(s.effectiveAt, now) <= hours;

  const covered = eligible.filter((s) => s.publishers.length >= 2);
  let windowHours: number = PIPELINE.topStoriesHours;
  let pool = covered.filter(within(windowHours));
  let relaxed = false;
  if (pool.length < PIPELINE.topStoriesMin) {
    const wider = covered.filter(within(PIPELINE.topStoriesRelaxedHours));
    relaxed = wider.length > pool.length;
    if (relaxed) windowHours = PIPELINE.topStoriesRelaxedHours;
    pool = wider;
  }
  if (pool.length > 0) {
    // Incumbents that are down to one publisher stay candidates for the hold (never for a slot on merit).
    const lapsed = eligible.filter((s) => s.publishers.length < 2 && within(windowHours)(s) && memoryOf(s, previousTop) !== undefined);
    const isCovered = new Set<ScoredStory>(pool);
    const ranked = capPerLeadPublisher([...pool, ...lapsed].sort(compareTop), ROUTE_POLICY.topPerLeadPublisher);
    const running = foldRunningStories(ranked);
    const onMerit = running.kept.filter((s) => isCovered.has(s));
    const fresh = onMerit.slice(0, TOP_STORIES_MAX);
    const inFresh = new Set<ScoredStory>(fresh);
    const hold = applyHold(fresh, running.kept.filter((s) => !inFresh.has(s)), previousTop, now);
    const sticky = withSticky(hold.top, input.previousLead, now);
    const top = sticky.ranked.slice(0, TOP_STORIES_MAX).map((s) => s.lead);
    const listed = new Set(top);
    const related: TopResult["related"] = {};
    for (const [lead, followUps] of Object.entries(running.related)) if (listed.has(lead)) related[lead] = followUps;
    return { top, leadId: top[0], mode: "coverage", relaxed, held: sticky.held, related, holds: hold.holds };
  }

  const headlines = eligible.filter(isQuietDayHeadline);
  let quiet = headlines.filter(within(PIPELINE.topStoriesHours));
  if (quiet.length === 0) {
    quiet = headlines.filter(within(PIPELINE.topStoriesRelaxedHours));
    relaxed = quiet.length > 0;
  }
  if (quiet.length === 0) return { top: [], leadId: null, mode: "empty", relaxed: false, held: false, related: {}, holds: {} };
  const sticky = withSticky([...quiet].sort(compareScore), input.previousLead, now);
  const leadId = sticky.ranked[0].lead;
  return { top: [leadId], leadId, mode: "quiet", relaxed, held: sticky.held, related: {}, holds: {} };
}
