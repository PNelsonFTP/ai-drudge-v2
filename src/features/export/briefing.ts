// Briefing export: TOP STORIES + watchlist hits of the last 24 h + today's bookmarks as Markdown or
// plain text. Pure - the clock, the reader's "today" and every store value are parameters.
//
// Nothing here is AI-generated text: titles and outlet names are the publishers' own, and the
// provenance line at the end says which edition and build the briefing was cut from.

import type { ArticleId, RiverFile } from "../../../shared/contract";
import { alsoOutlets, collapseStories, publisherName, riverMatching, sourceName, topStories, type Edition, type MuteSet } from "../../../shared/select";
import type { TermMatcher } from "../../../shared/text";
import { DAY_MS, parseMs } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import type { SavedState } from "../../app/services";
import { escapeMarkdown, markdownLink, markdownUrl, plainLine } from "./kit/markdown";

export const BRIEFING_TOP_LIMIT = 8;
export const BRIEFING_ALSO_LIMIT = 5;
export const BRIEFING_WATCH_LIMIT = 20;

export interface BriefingOutlet {
  name: string;
  url: string;
}

export interface BriefingStory {
  id: ArticleId;
  title: string;
  url: string;
  /** Outlet of the lead article. */
  source: string;
  /** Distinct publishers covering the story (1 = only the lead). */
  publishers: number;
  also: BriefingOutlet[];
}

export interface BriefingHit {
  id: ArticleId;
  title: string;
  url: string;
  source: string;
  /** Watch terms matched in the title. */
  terms: string[];
}

export interface BriefingItem {
  id: ArticleId;
  title: string;
  url: string;
  source: string;
}

export interface Briefing {
  generatedAt: string;
  buildId: string;
  top: BriefingStory[];
  watch: BriefingHit[];
  /** Watch hits found before the limit was applied. */
  watchTotal: number;
  bookmarks: BriefingItem[];
}

export interface BriefingInput {
  edition: Edition;
  /** null while river.json is not loaded: the briefing then has no watchlist hits. */
  river: RiverFile | null;
  saved: SavedState;
  /** watchlist.matcher() */
  matcher: TermMatcher;
  mutes: MuteSet;
  nowMs: number;
  /** Start of the reader's "today" (local midnight) for "bookmarked today". */
  todayStartMs: number;
  topLimit?: number;
  alsoLimit?: number;
  watchLimit?: number;
}

function buildTop(input: BriefingInput): BriefingStory[] {
  const { edition, mutes } = input;
  return topStories(edition, mutes)
    .slice(0, input.topLimit ?? BRIEFING_TOP_LIMIT)
    .map((s) => ({
      // The story key: with a muted lead source another outlet's article is the one exported.
      id: s.key,
      title: s.lead.title,
      url: s.lead.url,
      source: publisherName(edition, s.lead),
      publishers: s.publishers,
      also: alsoOutlets(edition, s.key, mutes)
        .filter((o) => isHttpUrl(o.article.url))
        .slice(0, input.alsoLimit ?? BRIEFING_ALSO_LIMIT)
        .map((o) => ({ name: o.name, url: o.article.url })),
    }));
}

function buildWatch(input: BriefingInput, top: readonly BriefingStory[]): { hits: BriefingHit[]; total: number } {
  const { river, matcher, mutes, nowMs, edition } = input;
  if (!river || matcher.size === 0) return { hits: [], total: 0 };
  // A hit that is already a TOP STORY (or one of its other outlets) would be listed twice.
  const inTop = new Set<ArticleId>();
  for (const s of top) {
    inTop.add(s.id);
    for (const m of edition.clusters[s.id]?.members ?? []) inTop.add(m);
  }
  const recent = riverMatching(river, matcher, mutes).filter((r) => r.effectiveMs > nowMs - DAY_MS && isHttpUrl(r.url));
  const stories = collapseStories(recent).filter((r) => !inTop.has(r.id) && !(r.leadId !== null && inTop.has(r.leadId)));
  const hits = stories.slice(0, input.watchLimit ?? BRIEFING_WATCH_LIMIT).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    source: r.sourceName,
    terms: matcher.terms(r.title),
  }));
  return { hits, total: stories.length };
}

function buildBookmarks(input: BriefingInput): BriefingItem[] {
  const { saved, edition, todayStartMs } = input;
  const rows: { item: BriefingItem; savedMs: number }[] = [];
  for (const id of saved.bookmarks) {
    const snap = saved.snapshots[id];
    const savedMs = parseMs(snap?.savedAt);
    if (savedMs === null || savedMs < todayStartMs) continue;
    const live = edition.articles[id];
    const item: BriefingItem = live
      ? { id, title: live.title, url: live.url, source: sourceName(edition, live.src) }
      : { id, title: snap?.title ?? "", url: snap?.url ?? "", source: snap?.sourceName ?? "" };
    if (!item.title || !isHttpUrl(item.url)) continue;
    rows.push({ item, savedMs });
  }
  rows.sort((a, b) => b.savedMs - a.savedMs || (a.item.id < b.item.id ? -1 : 1));
  return rows.map((r) => r.item);
}

/** Collect the briefing's content. */
export function buildBriefing(input: BriefingInput): Briefing {
  const top = buildTop(input);
  const watch = buildWatch(input, top);
  return {
    generatedAt: input.edition.meta.generatedAt,
    buildId: input.edition.meta.buildId,
    top,
    watch: watch.hits,
    watchTotal: watch.total,
    bookmarks: buildBookmarks(input),
  };
}

export interface BriefingParts {
  top: boolean;
  watch: boolean;
  bookmarks: boolean;
}

export const ALL_PARTS: BriefingParts = { top: true, watch: true, bookmarks: true };

/** "2026-11-19 20:08 UTC"; the raw string when it is not a date. */
export function formatUtc(iso: string): string {
  const ms = parseMs(iso);
  if (ms === null) return plainLine(iso);
  const s = new Date(ms).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

function outletCount(n: number): string {
  return n > 1 ? ` (${n} outlets)` : "";
}

function isEmpty(b: Briefing, parts: BriefingParts): boolean {
  return !((parts.top && b.top.length) || (parts.watch && b.watch.length) || (parts.bookmarks && b.bookmarks.length));
}

/**
 * The "Also:" outlets of a top story, split where the count ends: "(7 outlets)" is the source plus
 * six counted outlets (listed first - ClusterV2 member order); the rest link the story without
 * counting as coverage and are printed as "Also linked:".
 */
export function splitAlso<T>(story: { publishers: number; also: readonly T[] }): [T[], T[]] {
  const counted = Math.max(0, Math.min(story.also.length, story.publishers - 1));
  return [story.also.slice(0, counted), story.also.slice(counted)];
}

/**
 * Markdown. Top stories have the shape
 *   1. **[Title](url)** — Source (N outlets)
 *      Also: [Outlet](url), [Outlet](url)
 *      Also linked: [Outlet](url)          (outlets that link the story but are not counted)
 * Titles, outlet names and watch terms are escaped; URLs that are not http(s) never become links.
 */
export function briefingMarkdown(b: Briefing, parts: BriefingParts = ALL_PARTS): string {
  const out: string[] = [`# AI DRUDGE briefing — ${formatUtc(b.generatedAt)}`, ""];
  if (parts.top && b.top.length) {
    out.push("## Top stories", "");
    b.top.forEach((s, i) => {
      out.push(`${i + 1}. **${markdownLink(s.title, s.url)}** — ${escapeMarkdown(s.source)}${outletCount(s.publishers)}`);
      const [counted, linked] = splitAlso(s);
      if (counted.length) out.push(`   Also: ${counted.map((o) => markdownLink(o.name, o.url)).join(", ")}`);
      if (linked.length) out.push(`   Also linked: ${linked.map((o) => markdownLink(o.name, o.url)).join(", ")}`);
    });
    out.push("");
  }
  if (parts.watch && b.watch.length) {
    out.push("## Watchlist hits (last 24 h)", "");
    for (const h of b.watch) {
      const terms = h.terms.length ? ` · matched: ${h.terms.map(escapeMarkdown).join(", ")}` : "";
      out.push(`- ${markdownLink(h.title, h.url)} — ${escapeMarkdown(h.source)}${terms}`);
    }
    if (b.watchTotal > b.watch.length) out.push(`- …and ${b.watchTotal - b.watch.length} more`);
    out.push("");
  }
  if (parts.bookmarks && b.bookmarks.length) {
    out.push("## Bookmarked today", "");
    for (const m of b.bookmarks) out.push(`- ${markdownLink(m.title, m.url)} — ${escapeMarkdown(m.source)}`);
    out.push("");
  }
  if (isEmpty(b, parts)) out.push("_Nothing to report._", "");
  out.push("---", `Edition ${formatUtc(b.generatedAt)} · build ${escapeMarkdown(b.buildId)} · Headlines and outlet names are the publishers' own; this briefing contains no AI-generated text.`);
  return `${out.join("\n")}\n`;
}

/** Plain text for e-mail: the same content, URLs on their own lines. */
export function briefingText(b: Briefing, parts: BriefingParts = ALL_PARTS): string {
  const out: string[] = [`AI DRUDGE briefing - ${formatUtc(b.generatedAt)}`, ""];
  const url = (u: string): string => markdownUrl(u);
  if (parts.top && b.top.length) {
    out.push("TOP STORIES", "");
    b.top.forEach((s, i) => {
      out.push(`${i + 1}. ${plainLine(s.title)} - ${plainLine(s.source)}${outletCount(s.publishers)}`);
      out.push(`   ${url(s.url)}`);
      const [counted, linked] = splitAlso(s);
      if (counted.length) out.push(`   Also: ${counted.map((o) => plainLine(o.name)).join(", ")}`);
      if (linked.length) out.push(`   Also linked: ${linked.map((o) => plainLine(o.name)).join(", ")}`);
    });
    out.push("");
  }
  if (parts.watch && b.watch.length) {
    out.push("WATCHLIST HITS (LAST 24 H)", "");
    for (const h of b.watch) {
      out.push(`- ${plainLine(h.title)} - ${plainLine(h.source)}${h.terms.length ? ` [${h.terms.map(plainLine).join(", ")}]` : ""}`);
      out.push(`  ${url(h.url)}`);
    }
    if (b.watchTotal > b.watch.length) out.push(`- ...and ${b.watchTotal - b.watch.length} more`);
    out.push("");
  }
  if (parts.bookmarks && b.bookmarks.length) {
    out.push("BOOKMARKED TODAY", "");
    for (const m of b.bookmarks) {
      out.push(`- ${plainLine(m.title)} - ${plainLine(m.source)}`);
      out.push(`  ${url(m.url)}`);
    }
    out.push("");
  }
  if (isEmpty(b, parts)) out.push("Nothing to report.", "");
  out.push(`Edition ${formatUtc(b.generatedAt)} / build ${plainLine(b.buildId)} / no AI-generated text.`);
  return `${out.join("\n")}\n`;
}

/** "ai-drudge-briefing-2026-11-19-2008.md" (from the edition time, so the name is reproducible). */
export function briefingFilename(b: Briefing): string {
  const ms = parseMs(b.generatedAt);
  if (ms === null) return "ai-drudge-briefing.md";
  const s = new Date(ms).toISOString();
  return `ai-drudge-briefing-${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}.md`;
}
