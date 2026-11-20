// The "why is this story where it is?" record of one run: score parts, placements and route trace of
// every story plus every dropped item. Built by run.ts after route, written with writeExplain
// (emit/write.ts) to a NON-public path, read by scripts/tools/explain.ts. Pure.

import type { ArticleId } from "../../../shared/contract";
import type { SectionId } from "../../../shared/sections";
import type { DroppedItem, NormalizedItem, Placements, RouteTrace, ScoreParts, StageContext } from "../types";

/** Default location (gitignored, never deployed), relative to the repo root. */
export const EXPLAIN_FILE = "node_modules/.tmp/explain.json";

export interface ExplainItem {
  id: ArticleId;
  title: string;
  url: string;
  source: string;
  publisher: string;
  /** Registry id of the item's source (mutes are by source id). */
  sourceId?: string;
  /**
   * True when the per-source cap had cut this item and it came back because another publisher
   * covers the same story (relevance rescueCorroboration). Absent otherwise.
   */
  rescued?: true;
}

/** What run.ts knows about the build that the placements alone do not say. */
export interface ExplainNotes {
  /** Items rescued from the per-source cap (kept after rescueCorroboration, not before it). */
  rescued?: readonly Pick<NormalizedItem, "id" | "sourceId">[];
}

/** Source tags that give a lead the score's regulator-notice term (CONTRACTS.md, tag conventions). */
export const REGULATOR_NOTICE_TAGS: readonly string[] = ["regulator", "first-party"];

export interface ExplainStory extends ExplainItem {
  score: number;
  parts: ScoreParts;
  w: number;
  ageHours: number;
  effectiveAt: string;
  flags: string[];
  /**
   * True when the lead's source carries both REGULATOR_NOTICE_TAGS and the lead is not a release
   * line: `parts.importance` then includes the regulator-notice term on top of the title signals.
   */
  regulatorNotice?: true;
  /** Publisher ids counted as coverage. */
  publishers: string[];
  members: ExplainItem[];
  /** Sections the story is listed in, with its 1-based rank and whether that rank is on the homepage. */
  sections: { id: SectionId; rank: number; home: boolean }[];
  /** 1-based TOP STORIES rank, or null. */
  topRank: number | null;
  /** The story kept its TOP slot by the hold rule this build (Placements.topHeld): since when, at which score. */
  topHeld?: { since: string; score: number };
  /** Follow-ups of this TOP story that were not given a TOP slot of their own (Placements.topRelated), best first. */
  topRelated?: ExplainItem[];
  /** This story is such a follow-up: the TOP story it was folded under. */
  foldedUnder?: ExplainItem;
  isLead: boolean;
  /** Section the story is (or would be) listed under. */
  primary: SectionId | null;
  trace?: RouteTrace;
}

export interface ExplainFile {
  buildId: string;
  generatedAt: string;
  stories: ExplainStory[];
  dropped: DroppedItem[];
}

export function buildExplain(placements: Placements, dropped: readonly DroppedItem[], ctx: Pick<StageContext, "now" | "buildId">, notes: ExplainNotes = {}): ExplainFile {
  const rescueKey = (i: Pick<NormalizedItem, "id" | "sourceId">): string => `${i.sourceId}\u0000${i.id}`;
  const rescued = new Set((notes.rescued ?? []).map(rescueKey));
  const brief = (i: NormalizedItem): ExplainItem => ({ id: i.id, title: i.title, url: i.url, source: i.sourceName, publisher: i.publisherName, sourceId: i.sourceId, ...(rescued.has(rescueKey(i)) ? { rescued: true as const } : {}) });
  const placed = new Map<ArticleId, ExplainStory["sections"]>();
  for (const s of placements.sections) {
    s.rows.forEach((id, i) => {
      const list = placed.get(id) ?? [];
      list.push({ id: s.id, rank: i + 1, home: i < s.homeCount });
      placed.set(id, list);
    });
  }
  // Follow-up lead id -> the TOP story it was folded under (route/running.ts).
  const foldedUnder = new Map<ArticleId, ArticleId>();
  for (const [topId, followUps] of Object.entries(placements.topRelated ?? {})) for (const id of followUps) if (!foldedUnder.has(id)) foldedUnder.set(id, topId);
  const leadOf = (id: ArticleId): NormalizedItem | undefined => placements.stories[id]?.items[0];
  const stories: ExplainStory[] = [];
  for (const story of Object.values(placements.stories)) {
    const lead = story.items[0];
    if (!lead) continue;
    const top = placements.top.indexOf(story.lead);
    const out: ExplainStory = {
      ...brief(lead),
      score: story.score,
      parts: story.parts,
      w: story.w,
      ageHours: Math.round(story.ageHours * 10) / 10,
      effectiveAt: story.effectiveAt,
      flags: [...lead.flags],
      ...(REGULATOR_NOTICE_TAGS.every((t) => lead.tags.includes(t)) && !lead.flags.includes("release") ? { regulatorNotice: true as const } : {}),
      publishers: [...story.publishers],
      members: story.items.slice(1).map(brief),
      sections: placed.get(story.lead) ?? [],
      topRank: top < 0 ? null : top + 1,
      isLead: placements.leadId === story.lead,
      primary: placements.primary[story.lead] ?? null,
    };
    const held = placements.topHeld?.[story.lead];
    if (held && top >= 0) out.topHeld = { since: held.since, score: held.score };
    const related = (placements.topRelated?.[story.lead] ?? []).map(leadOf).filter((i): i is NormalizedItem => i !== undefined);
    if (related.length) out.topRelated = related.map(brief);
    const parent = leadOf(foldedUnder.get(story.lead) ?? "");
    if (parent) out.foldedUnder = brief(parent);
    const trace = placements.trace?.[story.lead];
    if (trace) out.trace = trace;
    stories.push(out);
  }
  stories.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { buildId: ctx.buildId, generatedAt: ctx.now.toISOString(), stories, dropped: [...dropped] };
}
