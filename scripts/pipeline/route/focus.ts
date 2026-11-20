// Section focus: the per-section ordering bonus of rules.ts SECTION_FOCUS, compiled once. Pure.
// A focus bonus changes the ORDER of one section's list; it is never added to a story's score.

import type { SectionId } from "../../../shared/sections";
import { compileTerms, type TermMatcher } from "../../../shared/text";
import type { ScoredStory } from "../types";
import { cleanForMatch } from "./matcher";
import { SECTION_FOCUS, type FocusRule } from "./rules";

interface CompiledFocus {
  rule: FocusRule;
  strong: TermMatcher;
  exact: TermMatcher;
  withAny: TermMatcher;
  not: TermMatcher;
}

function compile(rules: readonly FocusRule[]): CompiledFocus[] {
  return rules.map((rule) => ({
    rule,
    strong: compileTerms(rule.strong),
    exact: compileTerms(rule.exact ?? []),
    withAny: compileTerms(rule.withAny ?? []),
    not: compileTerms(rule.not ?? []),
  }));
}

const COMPILED = new Map<SectionId, CompiledFocus[]>((Object.entries(SECTION_FOCUS) as [SectionId, readonly FocusRule[]][]).map(([id, rules]) => [id, compile(rules)]));

export interface Focus {
  points: number;
  /** "<rule id> +<points> title[<term>]" (or source[<term>]) for RouteTrace.focus. */
  why: string;
}

/** First hit of a case-SENSITIVE list (the matched text equals the term exactly). */
function exactTerm(matcher: TermMatcher, text: string): string | null {
  for (const h of matcher.all(text)) if (text.slice(h.index, h.index + h.length) === h.term) return h.term;
  return null;
}

/** The best focus rule of `section` the story's LEAD matches (title; source name where the rule says so), or null. */
export function focusOf(story: ScoredStory, section: SectionId): Focus | null {
  const rules = COMPILED.get(section);
  if (!rules) return null;
  // A forum thread that names a runtime ("... tester wanted (Local vLLM / NIM)") is not news about it.
  const lead = story.items[0];
  if (lead.kind === "community" || lead.flags.includes("discussion")) return null;
  const title = cleanForMatch(story.items[0].title);
  let best: Focus | null = null;
  for (const c of rules) {
    if (best && c.rule.points <= best.points) continue;
    if (c.withAny.size > 0 && !c.withAny(title)) continue;
    if (c.not.size > 0 && c.not(title)) continue;
    const inTitle = c.strong(title)?.term ?? exactTerm(c.exact, title);
    const inSource = inTitle || !c.rule.matchSource ? null : (c.strong(lead.sourceName)?.term ?? exactTerm(c.exact, lead.sourceName));
    if (inTitle) best = { points: c.rule.points, why: `${c.rule.id} +${c.rule.points} title[${inTitle}]` };
    else if (inSource) best = { points: c.rule.points, why: `${c.rule.id} +${c.rule.points} source[${inSource}]` };
  }
  return best;
}

/** Does any section order its list by focus? (Sections without rules keep the plain score order.) */
export function hasFocus(section: SectionId): boolean {
  return COMPILED.has(section);
}
