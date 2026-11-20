// The deterministic brief, used whenever Claude is not (no key, refusal, bad output, API error).
// It is the day's top stories with their coverage ("... — 14 outlets"), never a GitHub release tag
// or a community thread - V1's fallback regularly led with "llama.cpp b12549 released".
// The client does not render a fallback brief (it would duplicate TOP STORIES); it still has to be
// honest data for anyone reading brief.json (exports, the gate, a feed of the file).

import { SCHEMA_VERSION, type BriefCitation, type BriefFile } from "../../../shared/contract";
import type { Placements, StageContext } from "../types";
import { briefStories, type BriefStory } from "./briefInput";

export const FALLBACK_MAX_BULLETS = 5;
export const FALLBACK_MIN_BULLETS = 3;

export function fallbackBullet(story: BriefStory): string {
  return story.publishers >= 2 ? `${story.title} — ${story.publishers} outlets` : story.title;
}

export function citationOf(story: BriefStory): BriefCitation {
  return { title: story.title, url: story.url, source: story.source };
}

export function fallbackBrief(placements: Placements, ctx: Pick<StageContext, "now" | "buildId">): BriefFile {
  const stories = briefStories(placements);
  const top = stories.filter((s) => s.kind === "top").slice(0, FALLBACK_MAX_BULLETS);
  // Thin day: top stories first, then section leads until there are at least three bullets.
  const picked = top.length >= FALLBACK_MIN_BULLETS ? top : [...top, ...stories.filter((s) => s.kind === "section")].slice(0, FALLBACK_MIN_BULLETS);
  return {
    schemaVersion: SCHEMA_VERSION,
    buildId: ctx.buildId,
    generatedAt: ctx.now.toISOString(),
    source: "fallback",
    headline: picked[0]?.title ?? "No headlines available",
    bullets: picked.map(fallbackBullet),
    cited: picked.map(citationOf),
  };
}
