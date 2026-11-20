// Where may a story go? Its lead's HOME section plus AT MOST ONE routed topic section.
// (V1 added every keyword-matched category: 24% of homepage slots repeated a URL and one story
// held 26 slots.) Pure; no windows or caps here - see section.ts.

import { findSection, type SectionId } from "../../../shared/sections";
import type { NormalizedItem, ScoredStory } from "../types";
import { aiTitleTerm, describeMatch, matchItem, type RuleMatch } from "./matcher";
import { ROUTE_POLICY, sectionPriority } from "./rules";

export interface StoryPlacement {
  home: SectionId;
  /** The one routed section (never equal to `home`), or null. */
  routedTo: SectionId | null;
  /** True when the story LEAVES its home section for `routedTo` (AI-titled cyber story -> AI SECURITY, or -> POLICY on a policy title). */
  moved: boolean;
  /** Sections the story is a candidate for: [home], [home, routedTo] or (moved) [routedTo]. */
  sections: SectionId[];
  /** True when `routedTo` rests on a strong term in the TITLE (not on summary text alone). */
  byTitle: boolean;
  /** Why it was routed (RouteTrace.rule). */
  rule?: string;
  /** Every rule match, best first (explain tool). */
  matches: RuleMatch[];
  /** Sections whose rules matched but which the story may not enter (one-routed-section limit, home-only source, routeTo allowlist). */
  blocked: SectionId[];
}

export function leadOf(story: ScoredStory): NormalizedItem {
  return story.items[0];
}

/** May this lead's source be keyword-routed into `section`? */
function mayRouteTo(lead: NormalizedItem, section: SectionId): boolean {
  if (lead.routing === "home-only") return false;
  if (section === lead.home) return false;
  if (findSection(section)?.mode !== "topic") return false;
  return lead.routeTo === null || lead.routeTo.includes(section);
}

export function placeStory(story: ScoredStory): StoryPlacement {
  const lead = leadOf(story);
  const home = lead.home;
  const matches = matchItem(lead);
  const others = matches.filter((m) => m.section !== home);

  // Flagship behaviour: an AI-titled story from the cyber wire belongs in AI SECURITY, not in both.
  if (home === ROUTE_POLICY.moveFrom && mayRouteTo(lead, ROUTE_POLICY.moveTo)) {
    const attack = matches.find((m) => m.section === ROUTE_POLICY.moveTo && m.title.length > 0);
    const aiTerm = aiTitleTerm(lead.title);
    // A bare AI term says "about AI", not "about AI security": a title match in an allowlisted
    // section (policy) is the better description, so the story moves THERE instead.
    const yieldTo = attack ? undefined : aiTerm ? others.find((m) => ROUTE_POLICY.moveYieldsTo.includes(m.section) && m.title.length > 0 && mayRouteTo(lead, m.section)) : undefined;
    if (yieldTo) {
      return {
        home,
        routedTo: yieldTo.section,
        moved: true,
        byTitle: true,
        sections: [yieldTo.section],
        rule: `moved from ${home}: ${describeMatch(yieldTo)}`,
        matches,
        blocked: others.filter((m) => m !== yieldTo).map((m) => m.section),
      };
    }
    if (attack || aiTerm) {
      const why = attack ? describeMatch(attack) : `AI term in title[${aiTerm}]`;
      return {
        home,
        routedTo: ROUTE_POLICY.moveTo,
        moved: true,
        byTitle: true,
        sections: [ROUTE_POLICY.moveTo],
        rule: `moved from ${home}: ${why}`,
        matches,
        blocked: others.filter((m) => m.section !== ROUTE_POLICY.moveTo).map((m) => m.section),
      };
    }
  }

  // The best-scoring other section the source may enter. A source that is HOMED in a topic section
  // naturally matches that section's rule, so a second section must show stronger TITLE evidence
  // than home does: "LangChain Raises $300M Series C" (tools feed) is also a money story, while
  // "Malicious MCP server on npm" (AI-security feed) is not also a tools story.
  const homeTitle = matches.find((m) => m.section === home)?.titleScore ?? 0;
  const best = others.find((m) => mayRouteTo(lead, m.section) && (homeTitle === 0 || m.titleScore > homeTitle));
  return {
    home,
    routedTo: best?.section ?? null,
    moved: false,
    byTitle: !!best && best.title.length > 0,
    sections: best ? [home, best.section] : [home],
    rule: best ? describeMatch(best) : undefined,
    matches,
    blocked: others.filter((m) => m !== best).map((m) => m.section),
  };
}

/**
 * The ONE section a story is listed under (river row section, homepage slot).
 * `placedIn` = the sections whose row lists actually contain it.
 *
 * Placed in both home and routed section: home wins, unless
 *   - home is a general-news desk (industry), or
 *   - home is itself a topic section and a MORE SPECIFIC topic section claims the story by a title
 *     hit ("LangChain Raises $300M Series C": tools -> money; never ai_security -> tools).
 * Source-mode specialist desks (research, safety, analysis, releases ...) always keep their stories.
 * Not placed anywhere: the section it would belong to (routed topic section, else home).
 */
export function primarySection(p: StoryPlacement, placedIn: ReadonlySet<SectionId>): SectionId {
  const routed = p.routedTo !== null && placedIn.has(p.routedTo) ? p.routedTo : null;
  const home = placedIn.has(p.home) ? p.home : null;
  if (routed && home) {
    if (ROUTE_POLICY.generalDesks.includes(home)) return routed;
    const moreSpecific = findSection(home)?.mode === "topic" && p.byTitle && sectionPriority(routed) > sectionPriority(home);
    return moreSpecific ? routed : home;
  }
  return routed ?? home ?? p.routedTo ?? p.home;
}
