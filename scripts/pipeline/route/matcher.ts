// Compiled routing matcher: ROUTE_RULES -> shared/text.ts compileTerms matchers, compiled once.
// Pure. Looks only at a story's LEAD item (title + summary): the lead is what the row displays, so
// the explain tool can always point at the words that routed it.

import { findSection, sectionOrder, type SectionId } from "../../../shared/sections";
import { compileTerms, type TermMatcher } from "../../../shared/text";
import type { NormalizedItem } from "../types";
import { AI_TERMS, AI_TERMS_EXACT, ROUTE_POLICY, ROUTE_RULES, type RouteRule } from "./rules";

/** The fields of a lead item the matcher reads. */
export type MatchInput = Pick<NormalizedItem, "title" | "summary" | "kind" | "flags" | "home" | "scope">;

export interface RuleMatch {
  /** RouteRule.id */
  rule: string;
  section: SectionId;
  points: number;
  /** points x rule weight: the number sections compete on. */
  score: number;
  /** The part of `score` that comes from the TITLE (0 for a summary-only match). */
  titleScore: number;
  /** Strong / exact terms found in the title. */
  title: string[];
  /** Weak terms found in the title. */
  weak: string[];
  /** Strong / exact terms found only in the summary. */
  summary: string[];
}

interface CompiledRule {
  rule: RouteRule;
  index: number;
  weight: number;
  strong: TermMatcher;
  versioned: TermMatcher;
  exact: TermMatcher;
  weak: TermMatcher;
  withAny: TermMatcher;
  withExact: TermMatcher;
  gated: boolean;
  not: TermMatcher;
}

export function compileRules(rules: readonly RouteRule[]): CompiledRule[] {
  return rules.map((rule, index) => ({
    rule,
    index,
    weight: rule.weight ?? 1,
    strong: compileTerms(rule.strong),
    versioned: compileTerms(rule.versioned ?? []),
    exact: compileTerms(rule.exact ?? []),
    weak: compileTerms(rule.weak ?? []),
    withAny: compileTerms(rule.withAny ?? []),
    withExact: compileTerms(rule.withExact ?? []),
    gated: (rule.withAny?.length ?? 0) + (rule.withExact?.length ?? 0) > 0,
    not: compileTerms(rule.not ?? []),
  }));
}

const COMPILED: readonly CompiledRule[] = compileRules(ROUTE_RULES);
const AI_LEXICON = { strong: compileTerms(AI_TERMS), versioned: compileTerms([]), exact: compileTerms(AI_TERMS_EXACT) };

const URL_RE = /https?:\/\/\S+/gi;
const HANDLE_RE = /(^|[^\p{L}\p{N}])@[\p{L}\p{N}_-]+/gu;
const TICKER_RE = /\((?:nasdaq|nyse|nyse american|otc|otcqb|otcqx|tsx|tsxv|lse|asx|hkex|euronext)\s*:\s*[a-z0-9.\s-]{1,12}\)/gi;
// Trailing aggregator byline: "... (Author Name/Wall Street Journal)".
const BYLINE_RE = /\s*\([^()]{1,80}\/[^()]{1,80}\)\s*$/;
// Outlet names that contain routing terms.
const OUTLET_RE = /\bwall street journal\b/gi;

/**
 * Remove text that names things without being about them: URLs, @handles ("@gemini-cli-robot"
 * routed a CLI release to ROBOTICS in V1), ticker parentheticals ("(NASDAQ: PSQL)"), a trailing
 * aggregator byline and outlet names.
 */
export function cleanForMatch(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(URL_RE, " ").replace(TICKER_RE, " ").replace(BYLINE_RE, " ").replace(OUTLET_RE, " ").replace(HANDLE_RE, "$1 ");
}

interface Hit {
  term: string;
  index: number;
  end: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Hits of a case-SENSITIVE list: the matched text must equal the term exactly. */
function exactHits(matcher: TermMatcher, text: string): Hit[] {
  if (matcher.size === 0 || !text) return [];
  const out: Hit[] = [];
  for (const h of matcher.all(text)) {
    if (text.slice(h.index, h.index + h.length) === h.term) out.push({ term: h.term, index: h.index, end: h.index + h.length });
  }
  return out;
}

/** `text` with the given spans blanked out (so a weak "agent" is not counted inside a strong "AI agents"). */
function mask(text: string, hits: readonly Hit[]): string {
  let out = text;
  for (const h of hits) out = out.slice(0, h.index) + " ".repeat(h.end - h.index) + out.slice(h.end);
  return out;
}

// What may stand between a family name and its version: one capitalised codename ("Claude Fable
// 5.2", "Kimi K3"), then the number ("Gemini 4", "Imagen-5", "Qwen v4").
const VERSION_AFTER = /^(?:[\s-]\p{Lu}\p{L}*)?[\s-]?v?\d/u;

/** Hits of a `versioned` list that carry a version: a digit in the match ("GPT-6", "Qwen3.8") or right after it. */
function versionedHits(matcher: TermMatcher, text: string): Hit[] {
  if (matcher.size === 0 || !text) return [];
  const out: Hit[] = [];
  for (const h of matcher.all(text)) {
    const end = h.index + h.length;
    if (/\d/.test(text.slice(h.index, end)) || VERSION_AFTER.test(text.slice(end))) out.push({ term: h.term, index: h.index, end });
  }
  return out;
}

/** Strong hits, versioned hits and case-sensitive hits that do not overlap them, in text order. */
function strongHits(c: Pick<CompiledRule, "strong" | "versioned" | "exact">, text: string): Hit[] {
  if (!text) return [];
  const hits: Hit[] = c.strong.all(text).map((h) => ({ term: h.term, index: h.index, end: h.index + h.length }));
  if (c.versioned.size) hits.push(...versionedHits(c.versioned, mask(text, hits)));
  if (c.exact.size) hits.push(...exactHits(c.exact, mask(text, hits)));
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Distinct terms, counting a run of side-by-side hits ("humanoid robot", "vLLM, SGLang") as ONE
 * mention: hits with no word between them are the same phrase or list, not independent evidence.
 */
function mentions(hits: readonly Hit[], text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let prevEnd = -1;
  for (const h of hits) {
    const adjacent = prevEnd >= 0 && !WORD_CHAR.test(text.slice(prevEnd, h.index));
    prevEnd = Math.max(prevEnd, h.end);
    if (adjacent) continue;
    const key = h.term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(h.term);
    }
  }
  return out;
}

/** First AI-lexicon term in a TITLE, or null. */
export function aiTitleTerm(title: string | null | undefined): string | null {
  const t = cleanForMatch(title);
  return strongHits(AI_LEXICON, t)[0]?.term ?? null;
}

/**
 * Is the story AI-relevant for `requireAi` rules?
 * - ai-desk homes: yes - "ai"-scope sources are relevant by construction and "general"-scope ones
 *   already passed the relevance gate.
 * - utility desk (release radar): yes for "ai"-scope repos.
 * - owner desks (cyber, quantum): only when the TITLE carries an AI term, whatever the source's
 *   scope says - these wires are mostly not about AI.
 */
export function isAiRelevant(item: MatchInput): boolean {
  const desk = findSection(item.home)?.desk;
  if (desk === "ai") return true;
  if (desk === "utility" && item.scope === "ai") return true;
  return aiTitleTerm(item.title) !== null;
}

const isRelease = (i: MatchInput): boolean => i.kind === "github-release" || i.flags.includes("release");
const isPaper = (i: MatchInput): boolean => i.kind === "papers" || i.flags.includes("paper");

/** Summaries that are changelogs, abstracts, digests or other outlets' headlines are never read. */
export function summaryIsReadable(item: MatchInput): boolean {
  return !isRelease(item) && !isPaper(item) && item.kind !== "newsletter" && item.kind !== "aggregator" && item.kind !== "community";
}

function matchRule(c: CompiledRule, item: MatchInput, title: string, summary: string, aiOk: () => boolean): RuleMatch | null {
  const { rule } = c;
  if (isRelease(item) && !rule.acceptsReleases) return null;
  if (isPaper(item) && !rule.acceptsPapers) return null;
  if (c.not(title)) return null;
  if (c.gated && !c.withAny(title) && exactHits(c.withExact, title).length === 0) return null;

  const titleHits = strongHits(c, title);
  const inTitle = mentions(titleHits, title);
  const weak = c.weak.size ? c.weak.terms(mask(title, titleHits)) : [];
  const titleKeys = new Set(titleHits.map((h) => h.term.toLowerCase()));
  const inSummary =
    summary && !rule.titleOnly ? mentions(strongHits(c, summary), summary).filter((t) => !titleKeys.has(t.toLowerCase())) : [];

  const routes = inTitle.length >= 1 || inSummary.length >= 2 || (inSummary.length >= 1 && weak.length >= 1);
  if (!routes) return null;
  if (rule.requireAi && !aiOk()) return null;

  const cap = ROUTE_POLICY.maxTermsPerClass;
  const titlePoints = ROUTE_POLICY.titleStrongPoints * Math.min(inTitle.length, cap) + ROUTE_POLICY.titleWeakPoints * Math.min(weak.length, cap);
  const points = titlePoints + ROUTE_POLICY.summaryPoints * Math.min(inSummary.length, cap);
  return { rule: rule.id, section: rule.section, points, score: points * c.weight, titleScore: titlePoints * c.weight, title: inTitle, weak, summary: inSummary };
}

/**
 * Every section whose rules match the item, best first (score, then title evidence, then homepage
 * order). At most one entry per section (its best rule).
 */
export function matchItem(item: MatchInput, rules: readonly CompiledRule[] = COMPILED): RuleMatch[] {
  const title = cleanForMatch(item.title);
  const summary = summaryIsReadable(item) ? cleanForMatch(item.summary) : "";
  let ai: boolean | null = null;
  const aiOk = (): boolean => (ai ??= isAiRelevant(item));

  const best = new Map<SectionId, RuleMatch>();
  for (const c of rules) {
    const m = matchRule(c, item, title, summary, aiOk);
    if (!m) continue;
    const prev = best.get(m.section);
    if (!prev || compareMatches(m, prev) < 0) best.set(m.section, m);
  }
  return [...best.values()].sort(compareMatches);
}

function compareMatches(a: RuleMatch, b: RuleMatch): number {
  return b.score - a.score || b.title.length - a.title.length || sectionOrder(a.section) - sectionOrder(b.section) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}

/** One-line explanation of a match for RouteTrace.rule. */
export function describeMatch(m: RuleMatch): string {
  const parts: string[] = [];
  if (m.title.length) parts.push(`title[${m.title.join(", ")}]`);
  if (m.weak.length) parts.push(`weak[${m.weak.join(", ")}]`);
  if (m.summary.length) parts.push(`summary[${m.summary.join(", ")}]`);
  return `${m.rule}: ${parts.join(" ")} = ${m.points} pts`;
}
