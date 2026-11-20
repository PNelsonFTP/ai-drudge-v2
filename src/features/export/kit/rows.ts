// Pure helpers shared by the secondary pages (WP10): river rows as HeadlineRow items, section
// grouping, the reader's section order and match highlighting. No DOM, no React.

import type { ArticleId } from "../../../../shared/contract";
import { SECTION_IDS, findSection, isSectionId, type SectionId } from "../../../../shared/sections";
import { bySectionOrder, type Edition, type RiverItem } from "../../../../shared/select";
import { queryWordPattern, type TermMatcher } from "../../../../shared/text";
import type { RowItem } from "../../../app/services";

/** What a page hands to ui.HeadlineRow: an id, plus fallback data when the id is not in the edition. */
export interface RowRef {
  id: ArticleId;
  item?: RowItem;
}

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

export function riverToRowItem(r: RiverItem): RowItem {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    sourceName: r.sourceName,
    sourceId: r.sourceId,
    publishedAt: iso(r.publishedAtMs),
    firstSeenAt: iso(r.firstSeenAtMs),
    section: r.section,
  };
}

/** A river item as a row. The fallback `item` is always attached: HeadlineRow prefers the edition's copy. */
export function riverRef(r: RiverItem): RowRef {
  return { id: r.id, item: riverToRowItem(r) };
}

/**
 * The row that represents a river item's STORY: the story lead when the edition has it (so the row
 * carries the coverage badge and summary), otherwise the item itself.
 */
export function storyRef(edition: Edition | null, r: RiverItem): RowRef {
  if (r.leadId && edition?.articles[r.leadId]) return { id: r.leadId };
  return riverRef(r);
}

export interface SectionGroup<T> {
  section: SectionId;
  label: string;
  items: T[];
}

/** Group items by section in homepage order; item order inside a group is preserved. */
export function groupBySection<T>(items: readonly T[], sectionOf: (item: T) => SectionId): SectionGroup<T>[] {
  const map = new Map<SectionId, T[]>();
  for (const item of items) {
    const s = sectionOf(item);
    const list = map.get(s);
    if (list) list.push(item);
    else map.set(s, [item]);
  }
  return [...map.keys()].sort(bySectionOrder).map((section) => ({
    section,
    label: findSection(section)?.label ?? section.toUpperCase(),
    items: map.get(section) ?? [],
  }));
}

/**
 * Rows a multi-section page (search, #/new) renders before "Show all". Broad queries and a return
 * after a long weekend list 400-800 stories; the home page renders about 170.
 */
export const PAGE_ROW_BUDGET = 150;

export interface CappedGroup<G, R> {
  group: G;
  /** The rows of `group` to render (all of them, or the head that still fits the budget). */
  rows: R[];
}

/**
 * Spend one page-level row budget over groups in order: each group keeps the rows that still fit,
 * groups left with none are dropped. `shown` + `hidden` is the true total.
 */
export function capGroups<G, R>(groups: readonly G[], rowsOf: (group: G) => readonly R[], budget: number): { groups: CappedGroup<G, R>[]; shown: number; hidden: number } {
  const out: CappedGroup<G, R>[] = [];
  let left = Math.max(0, Math.floor(budget));
  let shown = 0;
  let total = 0;
  for (const group of groups) {
    const all = rowsOf(group);
    total += all.length;
    if (left <= 0 || all.length === 0) continue;
    const rows = all.slice(0, left);
    left -= rows.length;
    shown += rows.length;
    out.push({ group, rows });
  }
  return { groups: out, shown, hidden: total - shown };
}

/**
 * The reader's full section order: the stored order (unknown and duplicate ids ignored) followed by
 * every unlisted section in default order. Always all 15 sections exactly once.
 */
export function readerSectionOrder(stored: readonly string[] | null | undefined): SectionId[] {
  const out: SectionId[] = [];
  const seen = new Set<SectionId>();
  for (const id of stored ?? []) {
    if (isSectionId(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of SECTION_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Highlighting
// ------------------------------------------------------------------------------------------------

export interface TextRange {
  start: number;
  /** Exclusive. */
  end: number;
}

interface NormalizedText {
  norm: string;
  /** For every character of `norm`: [start, end) of the source character in the original text. */
  spans: TextRange[];
}

function foldChar(ch: string): string {
  return ch
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-");
}

/**
 * The search normal form of shared/text.ts normalizeForSearch, built character by character so a
 * match in the normalised text can be mapped back to offsets in the original text.
 */
function normalizeWithSpans(text: string): NormalizedText {
  let norm = "";
  const spans: TextRange[] = [];
  let at = 0;
  for (const ch of text) {
    const start = at;
    at += ch.length;
    const folded = /\s/.test(ch) ? " " : foldChar(ch);
    for (const c of folded) {
      if (c === " " && (norm === "" || norm.endsWith(" "))) continue;
      norm += c;
      spans.push({ start, end: at });
    }
  }
  return { norm, spans };
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Ranges of `text` (original offsets) where any of the search words occurs. `words` are the
 * normalised words of parseQuery; matching follows matchesQuery (queryWordPattern: never mid-word,
 * short words whole), so what is highlighted is exactly what made the row match.
 */
export function queryRanges(text: string, words: readonly string[]): TextRange[] {
  if (!text || words.length === 0) return [];
  const { norm, spans } = normalizeWithSpans(text);
  const out: TextRange[] = [];
  for (const w of words) {
    if (!w) continue;
    for (const m of norm.matchAll(new RegExp(queryWordPattern(w).source, "gu"))) {
      if (m[0].length === 0) continue;
      const first = spans[m.index];
      const last = spans[m.index + m[0].length - 1];
      if (first && last) out.push({ start: first.start, end: last.end });
    }
  }
  return mergeRanges(out);
}

/** Ranges of `text` matched by a compiled term matcher (watchlist). */
export function termRanges(text: string, matcher: TermMatcher): TextRange[] {
  return matcher.all(text).map((h) => ({ start: h.index, end: h.index + h.length }));
}

/** `text` cut into plain and matched pieces (concatenating the pieces gives `text`). */
export function splitByRanges(text: string, ranges: readonly TextRange[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const r of mergeRanges([...ranges])) {
    const start = Math.max(at, Math.min(text.length, r.start));
    const end = Math.max(start, Math.min(text.length, r.end));
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    if (end > start) out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/**
 * A short excerpt of `text` around the first occurrence of any word, cut at word boundaries with
 * ellipses. null when no word occurs.
 */
export function snippetAround(text: string, words: readonly string[], radius = 90): string | null {
  const ranges = queryRanges(text, words);
  const first = ranges[0];
  if (!first) return null;
  let start = Math.max(0, first.start - radius);
  let end = Math.min(text.length, first.end + radius);
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp >= 0 && sp < first.start) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > first.end) end = sp;
  }
  return `${start > 0 ? "… " : ""}${text.slice(start, end).trim()}${end < text.length ? " …" : ""}`;
}

/**
 * How often the scheduled build publishes an edition, as the reader is told it (status.json
 * cadenceMinutes is 30; the client does not load that file). One wording for every page.
 */
export const BUILD_CADENCE = "about every 30 minutes";

/** "1 story" / "3 stories". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
