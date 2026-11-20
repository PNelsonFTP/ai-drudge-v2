// WP5 - ROUTE: ScoredStory[] -> Placements. Pure and deterministic: the only clock is ctx.now, the
// only state read is ctx.state.lead and ctx.state.top, and the result does not depend on the order
// of the input.
//
//   placement.ts  home + at most one routed section per story (rules.ts / matcher.ts)
//   focus.ts      per-section ordering bonus for what a section is about (rules.ts SECTION_FOCUS)
//   section.ts    per section: hard/soft window, diversity caps, starvation fill, allRows cap
//   homepage.ts   a story shown twice gets ONE homepage slot; a big story's subject gets a few rows per section
//   top.ts        TOP STORIES and the lead (running-story rule, membership hold, lead stability)
//   running.ts    which stories are follow-ups of one running story

import type { ArticleId } from "../../../shared/contract";
import { SECTIONS, findSection, type SectionId } from "../../../shared/sections";
import type { NormalizedItem, PlacedSection, Placements, Route, RouteCut, RouteTrace, ScoredStory } from "../types";
import { focusOf, hasFocus } from "./focus";
import { dedupeHomepage, subjectsOf } from "./homepage";
import { leadOf, placeStory, primarySection, type StoryPlacement } from "./placement";
import { ROUTE_POLICY } from "./rules";
import { buildSection } from "./section";
import { compareScore, pickTop } from "./top";

export { ROUTE_RULES, ROUTE_POLICY, AI_TERMS, type RouteRule } from "./rules";
export { matchItem, describeMatch, cleanForMatch, isAiRelevant, aiTitleTerm, type RuleMatch } from "./matcher";
export { placeStory, primarySection, type StoryPlacement } from "./placement";

/** Why a story may not enter a section whose rule it matched. */
function blockReason(lead: NormalizedItem, section: SectionId): RouteCut {
  if (findSection(section)?.mode !== "topic") return "mode";
  if (lead.routing === "home-only" || (lead.routeTo !== null && !lead.routeTo.includes(section))) return "policy";
  return "limit";
}

export const route: Route = (input, ctx) => {
  // Rank once; every later step is stable, so the output is independent of the input order.
  const ranked = [...input].sort(compareScore);
  const stories: Record<ArticleId, ScoredStory> = {};
  const placements = new Map<ArticleId, StoryPlacement>();
  const candidates = new Map<SectionId, ScoredStory[]>(SECTIONS.map((s) => [s.id, []]));
  let unknownHome = 0;

  for (const story of ranked) {
    if (stories[story.lead]) {
      ctx.log("warn", `route: duplicate story lead ${story.lead} ignored`);
      continue;
    }
    stories[story.lead] = story;
    const p = placeStory(story);
    placements.set(story.lead, p);
    if (!findSection(p.home)) unknownHome++;
    for (const sec of p.sections) candidates.get(sec)?.push(story);
  }
  if (unknownHome) ctx.log("warn", `route: ${unknownHome} stories have an unknown home section and were not placed`);

  // A section with focus rules orders its candidates by score + focus bonus (rules.ts SECTION_FOCUS):
  // what the section is about goes above what only mentions its words. Stable, so equal keys keep
  // the score order; the bonus never leaves this list.
  const focus = new Map<ArticleId, Partial<Record<SectionId, string>>>();
  const ordered = (def: (typeof SECTIONS)[number]): ScoredStory[] => {
    const list = candidates.get(def.id) ?? [];
    if (!hasFocus(def.id)) return list;
    const bonus = new Map<ScoredStory, number>();
    for (const story of list) {
      const f = focusOf(story, def.id);
      if (!f) continue;
      bonus.set(story, f.points);
      focus.set(story.lead, { ...focus.get(story.lead), [def.id]: f.why });
    }
    return [...list].sort((a, b) => b.score + (bonus.get(b) ?? 0) - (a.score + (bonus.get(a) ?? 0)) || compareScore(a, b));
  };
  const built = SECTIONS.map((def) => ({ def, ...buildSection(def, ordered(def), ctx.now) }));

  const placedIn = new Map<ArticleId, Set<SectionId>>();
  for (const b of built) {
    for (const row of b.rows) {
      const set = placedIn.get(row.lead) ?? new Set<SectionId>();
      set.add(b.def.id);
      placedIn.set(row.lead, set);
    }
  }
  const NONE: ReadonlySet<SectionId> = new Set();
  const primary: Record<ArticleId, SectionId> = {};
  for (const [lead, p] of placements) primary[lead] = primarySection(p, placedIn.get(lead) ?? NONE);

  const rowsBySection = ROUTE_POLICY.homepageDedupe ? dedupeHomepage(built, (lead) => primary[lead], subjectsOf(ranked), ctx.now) : built.map((b) => [...b.rows]);
  const sections: PlacedSection[] = built.map((b, i) => ({
    id: b.def.id,
    rows: rowsBySection[i].map((s) => s.lead),
    homeCount: Math.min(b.def.homeRows, rowsBySection[i].length),
  }));

  // ai desk = home on an ai-desk section, or an owner-desk story that was MOVED into one and is
  // actually listed there. Owner / utility desks never feed TOP STORIES otherwise.
  const isAiDesk = (story: ScoredStory): boolean => {
    const p = placements.get(story.lead);
    if (findSection(leadOf(story).home)?.desk === "ai") return true;
    return !!p && p.moved && p.routedTo !== null && findSection(p.routedTo)?.desk === "ai" && (placedIn.get(story.lead)?.has(p.routedTo) ?? false);
  };
  const top = pickTop({ stories: ranked, isAiDesk, now: ctx.now, previousLead: ctx.state.lead, previousTop: ctx.state.top });

  const cuts = new Map<ArticleId, Partial<Record<SectionId, RouteCut>>>();
  const noteCut = (lead: ArticleId, section: SectionId, why: RouteCut): void => {
    const c = cuts.get(lead) ?? {};
    c[section] = why;
    cuts.set(lead, c);
  };
  for (const b of built) for (const [lead, why] of b.cut) noteCut(lead, b.def.id, why);
  const trace: Record<ArticleId, RouteTrace> = {};
  for (const [lead, p] of placements) {
    if (p.moved) noteCut(lead, p.home, "moved");
    for (const sec of p.blocked) noteCut(lead, sec, blockReason(leadOf(stories[lead]), sec));
    const cut = cuts.get(lead);
    const why = focus.get(lead);
    trace[lead] = { routedTo: p.routedTo, ...(p.rule ? { rule: p.rule } : {}), ...(cut ? { cut } : {}), ...(why ? { focus: why } : {}) };
  }

  const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
  const folded = Object.values(top.related).reduce((n, ids) => n + ids.length, 0);
  const held = Object.keys(top.holds).length;
  ctx.log(
    "info",
    `route: ${ranked.length} stories -> ${placedIn.size} placed in ${rowCount} rows; top ${top.top.length} (${top.mode}${top.relaxed ? ", relaxed" : ""}${top.held ? ", lead held" : ""}` +
      `${folded ? `, ${folded} follow-ups folded` : ""}${held ? `, ${held} held` : ""})`,
  );
  return {
    stories,
    sections,
    top: top.top,
    leadId: top.leadId,
    primary,
    trace,
    ...(folded ? { topRelated: top.related } : {}),
    ...(held ? { topHeld: top.holds } : {}),
  };
};
