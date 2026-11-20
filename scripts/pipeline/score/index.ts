// WP4 score stage: stories -> scored stories, highest first.
//
//   score = recency + fade x (tier + coverage + importance + hn)     (weights.ts has every number)
//
// Stories are scored, not articles: the story's time is its lead's effectiveAt, its significance
// is how many PUBLISHERS cover it, and the Hacker News signal is the best exact-URL match among
// its members (no domain fallback - V1 gave every github.com URL the points of one unrelated repo).
// ScoreParts holds the parts AFTER the fade, so they always sum to the score.
//
// One part reads a second clock: RECENCY counts from the moment the story last GREW (the latest
// time a coverage publisher first reported it - freshAt), because the lead is the EARLIEST good
// headline and a story the press is still picking up is not stale. Live 2026-11-20: a 27-publisher
// IPO led by the 37 h-old pricing release was scored as 37 h old on debut day, and a Q3 earnings
// story led by a 48 h-old item was cut from its section while outlets were still joining it.
// effectiveAt, ageHours and the fade stay on the lead, so windows, lead stickiness and age-out are
// unchanged and one straggler can add at most the recency points - never undo the fade.

import type { Weight } from "../../../shared/contract";
import { ageHours as ageOf, parseMs } from "../../../shared/time";
import { urlKey } from "../../../shared/url";
import type { HnIndex, NormalizedItem, Score, ScoreParts, ScoredStory, Story } from "../types";
import { importanceOf, isModelLaunchTitle } from "./importance";
import { SCORE } from "./weights";

const isRelease = (item: NormalizedItem): boolean => item.flags.includes("release");

/** Tier points of the story's lead; a release line is capped whatever its repo's tier. */
export function tierScore(lead: NormalizedItem): number {
  const base = SCORE.tierBase[lead.tier];
  return isRelease(lead) ? Math.min(base, SCORE.releaseTierCap) : base;
}

/** recencyMax at age 0, halving every half-life. */
export function recencyScore(ageHours: number): number {
  return SCORE.recencyMax * Math.pow(0.5, Math.max(0, ageHours) / SCORE.halfLifeHours);
}

/** 1 at age 0, halving every fadeHalfLifeHours: how much of its standing a story keeps as it ages. */
export function fade(ageHours: number): number {
  return Math.pow(0.5, Math.max(0, ageHours) / SCORE.fadeHalfLifeHours);
}

/** 0 for one publisher (or none), then coveragePerDoubling per doubling of the publisher count. */
export function coverageScore(publishers: number): number {
  if (publishers <= 1) return 0;
  return SCORE.coveragePerDoubling * Math.log2(Math.min(publishers, SCORE.coverageMaxPublishers));
}

/** The lead comes from a regulator's own feed (registry tags "regulator" + "first-party"). */
export function isRegulatorNotice(lead: NormalizedItem): boolean {
  return lead.tags.includes("regulator") && lead.tags.includes("first-party");
}

/**
 * Importance of the lead: the title-only event signals, plus SCORE.importance.regulatorNotice for a
 * regulator's own publication; capped at SCORE.importance.max together. Nothing for release lines.
 */
export function importanceScore(lead: NormalizedItem): number {
  if (isRelease(lead)) return 0;
  const title = importanceOf(lead.title).total;
  return isRegulatorNotice(lead) ? Math.min(SCORE.importance.max, title + SCORE.importance.regulatorNotice) : title;
}

/** Best exact-URL Hacker News match among the story's items. */
export function hnScore(items: readonly NormalizedItem[], hn: HnIndex | undefined): number {
  if (!hn || hn.byUrl.size === 0) return 0;
  let points = 0;
  for (const item of items) {
    const key = urlKey(item.url);
    const hit = key === null ? undefined : hn.byUrl.get(key);
    if (hit && hit.points > points) points = hit.points;
  }
  return Math.min(SCORE.hn.max, points / SCORE.hn.pointsPerPoint);
}

/** The source publishes its own work under its own name (a lab or vendor blog, not press or a digest). */
export function isFirstParty(item: NormalizedItem): boolean {
  if (item.tags.includes("first-party") || item.tags.includes("lab")) return true;
  if (item.tags.includes("press") || item.attribution !== "source") return false;
  return item.kind === "rss" || item.kind === "scrape" || item.kind === "json";
}

/**
 * A tier-1 source launching its own versioned model or product ("Introducing Gemini 4 Neon" on the
 * DeepMind blog). "Introducing OpenAI for Chile" is an announcement, not a launch.
 */
export function isTierOneLaunch(lead: NormalizedItem): boolean {
  return lead.tier === 1 && !isRelease(lead) && isFirstParty(lead) && isModelLaunchTitle(lead.title);
}

/**
 * Emphasis weight from STORY SIZE, evaluated in the contract's order: 3 = publishers >= 8;
 * 2 = publishers >= 3 or a tier-1 first-party launch; 0 = a tier-4 lead nobody else covers; else 1.
 * The grey (0) says "low-tier source, uncorroborated": a tier-4 lead that a second publisher also
 * reports is a corroborated story and reads as an ordinary row (live 2026-11-20: "AMD and Unsloth
 * Bring NPU Support ...", 2 publishers, was greyed out as the #2 row of LOCAL & OPEN MODELS).
 */
export function weightOf(story: Story): Weight {
  const lead = story.items[0];
  if (story.publishers.length >= SCORE.weight.critical) return 3;
  if (story.publishers.length >= SCORE.weight.high || isTierOneLaunch(lead)) return 2;
  if (lead.tier === 4 && story.publishers.length < SCORE.weight.corroborated) return 0;
  return 1;
}

/**
 * When the story last grew: the latest time a COVERAGE publisher first reported it, never earlier
 * than the lead's own time. One publisher's follow-ups do not count (only its first item does), nor
 * do community threads or release lines - so a single-publisher story is exactly as old as its lead.
 */
export function freshAt(story: Story): string {
  const lead = story.items[0];
  const first = new Map<string, { ms: number; at: string }>();
  for (const item of story.items) {
    if (!item.countsForCoverage) continue;
    const ms = parseMs(item.effectiveAt);
    if (ms === null) continue;
    const prev = first.get(item.publisher);
    if (!prev || ms < prev.ms) first.set(item.publisher, { ms, at: item.effectiveAt });
  }
  let best = { ms: parseMs(lead.effectiveAt) ?? Number.NEGATIVE_INFINITY, at: lead.effectiveAt };
  for (const f of first.values()) if (f.ms > best.ms) best = f;
  return best.at;
}

/** Score one story against a clock. */
export function scoreStory(story: Story, hn: HnIndex | undefined, now: Date): ScoredStory {
  const lead = story.items[0];
  const age = ageOf(lead.effectiveAt, now);
  const ageHours = Number.isFinite(age) ? age : SCORE.unknownAgeHours;
  const grew = ageOf(freshAt(story), now);
  const kept = fade(ageHours);
  const parts: ScoreParts = {
    tier: tierScore(lead) * kept,
    recency: recencyScore(Number.isFinite(grew) ? Math.min(grew, ageHours) : ageHours),
    importance: importanceScore(lead) * kept,
    coverage: coverageScore(story.publishers.length) * kept,
    hn: hnScore(story.items, hn) * kept,
  };
  return {
    ...story,
    score: parts.tier + parts.recency + parts.importance + parts.coverage + parts.hn,
    effectiveAt: lead.effectiveAt,
    ageHours,
    parts,
    w: weightOf(story),
  };
}

/** Highest score first; ties go to the newer story, then to the lead id (stable across builds). */
export function byScore(a: ScoredStory, b: ScoredStory): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt > b.effectiveAt ? -1 : 1;
  return a.lead < b.lead ? -1 : a.lead > b.lead ? 1 : 0;
}

export const score: Score = (stories, signals, ctx) => {
  const scored = stories.map((story) => scoreStory(story, signals.hn, ctx.now)).sort(byScore);
  const hits = scored.filter((s) => s.parts.hn > 0).length;
  ctx.log("info", `score: ${scored.length} stories, ${hits} with an exact-URL Hacker News match, top ${scored[0] ? scored[0].score.toFixed(1) : "-"}`);
  return scored;
};
