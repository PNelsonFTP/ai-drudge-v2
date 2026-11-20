// Home page view model: edition + mutes + settings + watchlist + clock -> what the page renders.
// Pure (no React, no DOM, the clock is a parameter) so every rule is unit-tested without rendering.

import type { ArticleId, BriefFile } from "../../../shared/contract";
import { SECTION_IDS, findSection, isSectionId, sectionById, type SectionId } from "../../../shared/sections";
import { sectionOf, sectionRows, storyPassesTimeFilter, topStories, type Edition, type MuteSet } from "../../../shared/select";
import { NO_TERMS, type TermMatcher } from "../../../shared/text";
import { effectiveMs, type TimeFilter } from "../../../shared/time";

/** Rows of the LATEST strip. */
export const LATEST_LIMIT = 12;
/** Rows a section shows on a phone before the "N more" disclosure. */
export const PHONE_ROWS = 3;
/** Column weight of a section heading, in rows. */
const HEADING_WEIGHT = 2;

/** The part of Settings the home page depends on. */
export interface HomeSettings {
  sectionOrder: readonly string[] | null;
  hiddenSections: readonly string[];
  collapsed: readonly string[];
  timeFilter: TimeFilter;
}

export interface HomeInput {
  edition: Edition | null;
  brief: BriefFile | null;
  mutes: MuteSet;
  settings: HomeSettings;
  nowMs: number;
  /** The reader's previous visit; null on a first visit. */
  previousVisitMs: number | null;
  /** Watchlist matcher (never matches when the watchlist is empty). */
  watch?: TermMatcher;
}

export interface TopStoryVM {
  id: ArticleId;
  /** Distinct publishers covering the story, the lead's included. */
  publishers: number;
}

export interface HomeSectionVM {
  id: SectionId;
  label: string;
  short: string;
  /** Homepage rows after mutes and the time filter (at most the section's homepage row count). */
  rows: ArticleId[];
  /** Rows the section page will list ("view all N"); >= rows.length. */
  total: number;
  sourceCount: number;
  /** Collapsed to its heading by the reader. */
  collapsed: boolean;
}

export interface HomeModel {
  /** The large lead story (first visible TOP STORY), or null. */
  lead: TopStoryVM | null;
  /** The remaining TOP STORIES, ranked. */
  top: TopStoryVM[];
  /** The brief to render: only an AI-written one (a fallback brief duplicates TOP STORIES). */
  brief: BriefFile | null;
  /** Stories on this page first seen after the previous visit (0 on a first visit). */
  newSince: number;
  /** LATEST strip: newest ai-desk stories, excluding the TOP STORIES leads. */
  latest: ArticleId[];
  /** Every section in the reader's order. Column slots derive from this, never from visibility. */
  order: SectionId[];
  /** Sections to render (not hidden, not muted, at least one row), in reader order. */
  sections: HomeSectionVM[];
  /** Sections the reader removed from the homepage, in reader order. */
  hidden: SectionId[];
  /** Visible stories whose title matches the watchlist, in page order. */
  watchHits: ArticleId[];
  timeFilter: TimeFilter;
}

/** Reader order: listed ids first (unknown and repeated ids ignored), then the rest in default order. */
export function resolveSectionOrder(order: readonly string[] | null | undefined): SectionId[] {
  const out: SectionId[] = [];
  const seen = new Set<string>();
  for (const id of order ?? []) {
    if (isSectionId(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of SECTION_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Column slot of every section: sections are dealt in reader order to the currently shortest
 * column (ties: leftmost), weighted by their FIXED homepage row count - not by what is visible
 * right now. So the result depends only on the order and the column count: hiding, muting or
 * emptying a section never moves another section to a different column.
 */
export function assignColumns(order: readonly SectionId[], columns: number): SectionId[][] {
  const n = Math.max(1, Math.floor(columns));
  const cols: SectionId[][] = Array.from({ length: n }, () => []);
  const heights: number[] = new Array<number>(n).fill(0);
  for (const id of order) {
    let target = 0;
    for (let i = 1; i < n; i++) if (heights[i] < heights[target]) target = i;
    cols[target].push(id);
    heights[target] += sectionById(id).homeRows + HEADING_WEIGHT;
  }
  return cols;
}

/** The columns to render: fixed slots (assignColumns) with the non-visible sections left out. */
export function layoutColumns(order: readonly SectionId[], visible: ReadonlySet<SectionId>, columns: number): SectionId[][] {
  return assignColumns(order, columns).map((col) => col.filter((id) => visible.has(id)));
}

/** Does the story with this key pass the active time chip? */
export type Pass = (key: ArticleId) => boolean;

/**
 * The time chip as a test on STORIES (shared/select storyPassesTimeFilter): a story is as new as
 * its newest visible article, so one whose lead is 38 h old but that an outlet joined minutes ago
 * stays under 6H / 24H and counts as NEW.
 */
export function passFor(e: Edition, input: Pick<HomeInput, "settings" | "nowMs" | "previousVisitMs" | "mutes">): Pass {
  const { timeFilter } = input.settings;
  if (timeFilter === "all") return () => true;
  return (key) => storyPassesTimeFilter(e, key, timeFilter, input.nowMs, input.previousVisitMs, input.mutes);
}

/**
 * Homepage rows of a section. Filters the best list available (the full ranked list once rest.json
 * is merged) and THEN cuts to the homepage row count, so a muted source or a time filter does not
 * leave holes while better-ranked rows are replaced by the next ones.
 */
export function homeSectionRows(e: Edition, id: SectionId, mutes: MuteSet, pass: Pass = () => true): { rows: ArticleId[]; total: number } {
  const section = sectionOf(e, id);
  if (!section) return { rows: [], total: 0 };
  const pool = sectionRows(e, id, { all: true, mutes });
  const rows = pool.filter(pass).slice(0, section.homeCount);
  const total = e.complete ? pool.length : Math.max(section.total, pool.length);
  return { rows, total: Math.max(total, rows.length) };
}

/**
 * TOP STORIES after mutes and the time filter, ranked. `id` is the story key (the pipeline's lead
 * id) even when that outlet is muted and another one is displayed; `publishers` counts the outlets
 * still visible.
 */
export function homeTopStories(e: Edition, mutes: MuteSet, pass: Pass = () => true): TopStoryVM[] {
  return topStories(e, mutes)
    .filter((s) => pass(s.key))
    .map((s) => ({ id: s.key, publishers: s.publishers }));
}

/**
 * LATEST strip: the newest stories of the visible ai-desk sections by effective time (ties by id),
 * after mutes and the time filter, without the stories already shown as TOP STORIES.
 *
 * It pools the HOMEPAGE rows of each section only (the rows front.json already carries), like
 * countNewOnHome: the strip sits above the fold, so it must be the same list before and after
 * rest.json merges. (Pooling the full ranked lists reshuffled 8 of 12 rows on every cold load.)
 */
export function homeLatest(e: Edition, mutes: MuteSet, visibleSections: ReadonlySet<SectionId>, exclude: ReadonlySet<ArticleId>, pass: Pass = () => true, limit: number = LATEST_LIMIT): ArticleId[] {
  const seen = new Set<ArticleId>(exclude);
  const pool: { id: ArticleId; t: number }[] = [];
  for (const s of e.sections) {
    if (!visibleSections.has(s.id) || findSection(s.id)?.desk !== "ai") continue;
    for (const id of sectionRows(e, s.id, { mutes })) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (pass(id)) pool.push({ id, t: effectiveMs(e.articles[id]) });
    }
  }
  return pool
    .sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((x) => x.id);
}

/**
 * "N new since your last visit": distinct stories on THIS page (TOP STORIES + the homepage rows of
 * the visible sections, after mutes) with an article the pipeline first saw after the previous
 * visit - the same test as the NEW chip and #/new, so a story an outlet joined since then counts.
 * It reads homepage rows only, so the number is the same before and after rest.json arrives.
 */
export function countNewOnHome(e: Edition, mutes: MuteSet, visibleSections: ReadonlySet<SectionId>, previousVisitMs: number | null): number {
  if (previousVisitMs === null) return 0;
  const ids = new Set<ArticleId>();
  for (const s of topStories(e, mutes)) ids.add(s.key);
  for (const s of e.sections) {
    if (!visibleSections.has(s.id)) continue;
    for (const id of sectionRows(e, s.id, { mutes })) ids.add(id);
  }
  let n = 0;
  for (const id of ids) if (storyPassesTimeFilter(e, id, "new", previousVisitMs, previousVisitMs, mutes)) n++;
  return n;
}

/** Only an AI-written brief with content is rendered. */
export function renderableBrief(brief: BriefFile | null): BriefFile | null {
  if (!brief || brief.source !== "claude") return null;
  if (!brief.headline.trim() && brief.bullets.length === 0) return null;
  return brief;
}

const EMPTY: Omit<HomeModel, "order" | "hidden" | "timeFilter" | "brief"> = { lead: null, top: [], newSince: 0, latest: [], sections: [], watchHits: [] };

export function buildHomeModel(input: HomeInput): HomeModel {
  const { edition: e, mutes, settings } = input;
  const order = resolveSectionOrder(settings.sectionOrder);
  const hiddenSet = new Set<string>(settings.hiddenSections);
  const hidden = order.filter((id) => hiddenSet.has(id));
  const base = { order, hidden, timeFilter: settings.timeFilter, brief: renderableBrief(input.brief) };
  if (!e) return { ...EMPTY, ...base };

  const pass = passFor(e, input);
  const collapsed = new Set<string>(settings.collapsed);
  const shown = new Set<SectionId>(order.filter((id) => !hiddenSet.has(id) && !mutes.sections.has(id)));

  const sections: HomeSectionVM[] = [];
  for (const id of order) {
    if (!shown.has(id)) continue;
    const section = sectionOf(e, id);
    if (!section) continue;
    const { rows, total } = homeSectionRows(e, id, mutes, pass);
    if (rows.length === 0) continue;
    sections.push({ id, label: section.label, short: sectionById(id).short, rows, total, sourceCount: section.sourceCount, collapsed: collapsed.has(id) });
  }

  const stories = homeTopStories(e, mutes, pass);
  const latest = homeLatest(e, mutes, shown, new Set(stories.map((s) => s.id)), pass);

  const watch = input.watch ?? NO_TERMS;
  const watchHits: ArticleId[] = [];
  if (watch.size > 0) {
    const seen = new Set<ArticleId>();
    const consider = (id: ArticleId): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const a = e.articles[id];
      if (a && watch(a.title)) watchHits.push(id);
    };
    for (const s of stories) consider(s.id);
    for (const id of latest) consider(id);
    for (const s of sections) for (const id of s.rows) consider(id);
  }

  return {
    ...base,
    lead: stories[0] ?? null,
    top: stories.slice(1),
    newSince: countNewOnHome(e, mutes, shown, input.previousVisitMs),
    latest,
    sections,
    watchHits,
  };
}

/**
 * Viewport widths at which the section grid gains a column (1 below the first, then 2, then 3).
 * Same thresholds as the shared grid CSS (.news-columns) and home.css.
 */
export const COLUMN_BREAKPOINTS = [720, 1100] as const;

/**
 * Section columns for a viewport width: 1 on phones, 2 from 720 px (three columns at 768 px left
 * ~32 characters per line), 3 from 1100 px.
 */
export function columnsForWidth(width: number): number {
  let n = 1;
  for (const bp of COLUMN_BREAKPOINTS) if (width >= bp) n++;
  return n;
}

/** Value-equality of two section view models (lets a section skip re-rendering). */
export function sameSection(a: HomeSectionVM, b: HomeSectionVM): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.label !== b.label || a.total !== b.total || a.sourceCount !== b.sourceCount || a.collapsed !== b.collapsed) return false;
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) if (a.rows[i] !== b.rows[i]) return false;
  return true;
}
