// Per-source filters from the registry (SourceDef include / exclude / includeUrl / excludeUrl).
// Terms use shared/text.ts compileTerms syntax; matchers are compiled once per source per run.

import { compileTerms, type TermMatcher } from "../../../shared/text";
import type { ResolvedSource } from "../../registry/types";

export interface SourceRules {
  include: TermMatcher | null;
  exclude: TermMatcher | null;
  includeUrl: string[];
  excludeUrl: string[];
  /** SourceDef.includeIn "title": an include term in the summary alone does not keep the item. Absent = title or summary. */
  includeTitleOnly?: boolean;
}

const lowerAll = (list: readonly string[] | undefined): string[] => (list ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);

export function compileSourceRules(source: Pick<ResolvedSource, "include" | "exclude" | "includeUrl" | "excludeUrl" | "includeIn">): SourceRules {
  const include = compileTerms(source.include ?? []);
  const exclude = compileTerms(source.exclude ?? []);
  const rules: SourceRules = {
    include: include.size ? include : null,
    exclude: exclude.size ? exclude : null,
    includeUrl: lowerAll(source.includeUrl),
    excludeUrl: lowerAll(source.excludeUrl),
  };
  if (source.includeIn === "title" && rules.include) rules.includeTitleOnly = true;
  return rules;
}

export interface RuleVerdict {
  keep: boolean;
  /** Why the item is excluded ("matched exclude term: webinar"); absent when kept. */
  detail?: string;
}

export interface RuleItem {
  title: string;
  summary: string | null;
  url: string;
  /**
   * Host of the outlet the feed names for an item whose link is still an unresolved wrapper
   * (normalize sets it for news.google.com/rss/articles/... links). URL rules look at it too:
   * the wrapper URL says nothing about the outlet, so excludeUrl ["stocktitan.net"] did nothing
   * until a later build resolved the link.
   */
  outletHost?: string | null;
}

/**
 * Apply a source's own filters to one item. Order: URL rules, exclude terms, include terms.
 * Exclude terms read title and summary; include terms read both unless the source sets includeIn "title".
 */
export function applySourceRules(rules: SourceRules, item: RuleItem): RuleVerdict {
  const outlet = item.outletHost ? item.outletHost.toLowerCase() : "";
  // A space cannot occur in a URL or a host, so no rule can match across the two.
  const url = outlet ? `${item.url.toLowerCase()} ${outlet}` : item.url.toLowerCase();
  const badUrl = rules.excludeUrl.find((part) => url.includes(part));
  if (badUrl) return { keep: false, detail: outlet && !item.url.toLowerCase().includes(badUrl) ? `outlet ${outlet} matches excluded "${badUrl}" (link not resolved yet)` : `URL contains excluded "${badUrl}"` };
  if (rules.includeUrl.length && !rules.includeUrl.some((part) => url.includes(part))) return { keep: false, detail: `URL matches none of includeUrl (${rules.includeUrl.join(", ")})` };
  if (rules.exclude) {
    const hit = rules.exclude(item.title) ?? rules.exclude(item.summary);
    if (hit) return { keep: false, detail: `matched exclude term: ${hit.term}` };
  }
  if (rules.include && !rules.include(item.title)) {
    const inSummary = rules.include(item.summary);
    // includeIn "title": a passing mention in the summary ("AI/LLM-led bug reports" under a PostgreSQL release) is not the topic.
    if (inSummary && rules.includeTitleOnly) return { keep: false, detail: `include term "${inSummary.term}" matched the summary only (this source needs it in the title)` };
    if (!inSummary) return { keep: false, detail: "matched none of the source's include terms" };
  }
  return { keep: true };
}
