// What the Daily Brief is written from - by Claude (brief.ts) and by the deterministic fallback
// (briefFallback.ts) alike: the stories the homepage actually leads with.
//
// V1 briefed the model from "the 60 newest items of the nine critical feeds": months-old lab posts
// and GitHub build tags, never the day's lead. Here the input is TOP STORIES (multi-publisher
// clusters, with their outlets) followed by the lead of every ai-desk section. Pure.

import type { ArticleId } from "../../../shared/contract";
import { SECTIONS, isAiDesk, sectionById } from "../../../shared/sections";
import { isHttpUrl } from "../../../shared/url";
import type { NormalizedItem, Placements, ScoredStory } from "../types";

export interface BriefStory {
  /** 1-based position in the input list. */
  n: number;
  /** "top" = TOP STORY (multi-publisher); "section" = lead of an ai-desk section. */
  kind: "top" | "section";
  id: ArticleId;
  title: string;
  url: string;
  /** Source display name of the lead article (citation label). */
  source: string;
  /** Distinct publishers covering the story (>= 1). */
  publishers: number;
  /** Outlet display names, the lead's first. */
  outlets: string[];
  /** Section label the story is listed under. */
  section: string;
  /** Lead summary, only from first-hand sources (see summaryOf). */
  summary?: string;
  ageHours: number;
}

export const BRIEF_MAX_OUTLETS = 8;
const SUMMARY_MAX = 280;

const isSecondary = (item: NormalizedItem): boolean => item.flags.includes("release") || item.flags.includes("discussion") || item.synthesizedTitle === true;

/**
 * Summaries are the largest free-text field a third party controls. Only sources that write their
 * own (feeds of a site, newsletters, papers, scrapers) contribute one; query / aggregator / community
 * snippets are other people's text about other people's articles and are left out.
 */
function summaryOf(item: NormalizedItem): string | undefined {
  if (!item.summary || item.attribution !== "source") return undefined;
  if (item.kind === "query" || item.kind === "aggregator" || item.kind === "community" || item.kind === "github-release") return undefined;
  return item.summary.length > SUMMARY_MAX ? `${item.summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : item.summary;
}

function outletsOf(story: ScoredStory): string[] {
  const out: string[] = [];
  for (const item of story.items) {
    if (!item.countsForCoverage && item !== story.items[0]) continue;
    const name = item.publisherName.trim();
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, BRIEF_MAX_OUTLETS);
}

/** TOP STORIES in rank order, then the lead of each ai-desk section that is not already listed. */
export function briefStories(placements: Placements): BriefStory[] {
  const out: BriefStory[] = [];
  const taken = new Set<ArticleId>();
  const eligible = (id: ArticleId): ScoredStory | null => {
    const story = Object.prototype.hasOwnProperty.call(placements.stories, id) ? placements.stories[id] : undefined;
    const lead = story?.items[0];
    return story && lead && !isSecondary(lead) && isHttpUrl(lead.url) ? story : null;
  };
  const add = (story: ScoredStory, kind: BriefStory["kind"], sectionLabel?: string): void => {
    if (taken.has(story.lead)) return;
    taken.add(story.lead);
    const lead = story.items[0];
    const entry: BriefStory = {
      n: out.length + 1,
      kind,
      id: story.lead,
      title: lead.title,
      url: lead.url,
      source: lead.sourceName,
      publishers: Math.max(1, story.publishers.length),
      outlets: outletsOf(story),
      section: sectionLabel ?? sectionById(placements.primary[story.lead] ?? lead.home).label,
      ageHours: Math.round(story.ageHours),
    };
    const summary = summaryOf(lead);
    if (summary) entry.summary = summary;
    out.push(entry);
  };

  for (const id of placements.top) {
    const story = eligible(id);
    if (story) add(story, "top");
  }
  const rowsOf = new Map(placements.sections.map((s) => [s.id, s.rows]));
  for (const def of SECTIONS) {
    if (!isAiDesk(def.id)) continue;
    // The section's lead = its first row that is a real article (release lines and threads never lead).
    for (const id of rowsOf.get(def.id) ?? []) {
      const story = eligible(id);
      if (!story) continue;
      add(story, "section", def.label);
      break;
    }
  }
  return out;
}
