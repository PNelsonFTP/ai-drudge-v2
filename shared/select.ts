// Pure selectors over an edition and the river. Used by the client (every page), emit/atom, the
// brief, the export feature and the check-data gate - so the same rule gives the same answer
// everywhere. No node:, no DOM; the clock is never read here (callers pass times in).

import type {
  ArticleId,
  ArticleV2,
  ClusterV2,
  EditionCounts,
  EditionFront,
  EditionMeta,
  EditionRest,
  RiverFile,
  SectionV2,
  SourceId,
  SourceRef,
  Weight,
} from "./contract";
import { SECTIONS, findSection, sectionOrder, type Desk, type SectionDef, type SectionId } from "./sections";
import { matchesQuery, normalizeForSearch, parseQuery } from "./text";
import { effectiveMs, passesTimeFilter, type Clock, type TimeFilter } from "./time";

/** A section inside a merged Edition. */
export interface EditionSection extends SectionV2 {
  /**
   * Rows available right now: the homepage rows while only front.json is loaded, the FULL ranked list
   * once rest.json is merged (`edition.complete`).
   */
  rows: ArticleId[];
  /** Number of homepage rows (front.json row count). `rows.slice(0, homeCount)` = the homepage list. */
  homeCount: number;
}

/** front.json (+ rest.json when loaded) merged into one lookup structure. */
export interface Edition {
  meta: EditionMeta;
  /** True once rest.json is merged. */
  complete: boolean;
  leadId: ArticleId | null;
  /** TOP STORIES lead ids, ranked. */
  top: ArticleId[];
  counts: EditionCounts;
  sections: EditionSection[];
  articles: Record<ArticleId, ArticleV2>;
  clusters: Record<ArticleId, ClusterV2>;
  sources: Record<SourceId, SourceRef>;
}

export interface MuteSet {
  sources: ReadonlySet<SourceId>;
  sections: ReadonlySet<SectionId>;
}

export const NO_MUTES: MuteSet = { sources: new Set<SourceId>(), sections: new Set<SectionId>() };

/** Thrown by mergeEdition when rest.json belongs to another build: refetch front.json once. */
export class BuildMismatchError extends Error {
  readonly frontBuildId: string;
  readonly otherBuildId: string;
  constructor(frontBuildId: string, otherBuildId: string) {
    super(`buildId mismatch: front ${frontBuildId} vs ${otherBuildId}`);
    this.name = "BuildMismatchError";
    this.frontBuildId = frontBuildId;
    this.otherBuildId = otherBuildId;
  }
}

/**
 * Merge front.json with rest.json (or null while it is loading).
 * Throws BuildMismatchError when rest.buildId !== front.buildId.
 * The inputs are not mutated; article/cluster/source records are shallow-merged (front wins on a
 * duplicate key, which a valid build never produces).
 */
export function mergeEdition(front: EditionFront, rest: EditionRest | null): Edition {
  if (rest && rest.buildId !== front.buildId) throw new BuildMismatchError(front.buildId, rest.buildId);
  const restRows = new Map<SectionId, ArticleId[]>();
  if (rest) for (const s of rest.sections) restRows.set(s.id, s.rows);
  const sections: EditionSection[] = front.sections.map((s) => {
    const full = restRows.get(s.id);
    return { ...s, rows: full && full.length >= s.rows.length ? full : s.rows, homeCount: s.rows.length };
  });
  return {
    meta: { schemaVersion: front.schemaVersion, buildId: front.buildId, generatedAt: front.generatedAt },
    complete: rest !== null,
    leadId: front.leadId,
    top: front.top,
    counts: front.counts,
    sections,
    articles: rest ? { ...rest.articles, ...front.articles } : front.articles,
    clusters: rest ? { ...rest.clusters, ...front.clusters } : front.clusters,
    sources: rest ? { ...rest.sources, ...front.sources } : front.sources,
  };
}

// ------------------------------------------------------------------------------------------------
// Articles, sources, weights
// ------------------------------------------------------------------------------------------------

/** Source display name; falls back to the id for an unknown source. */
export function sourceName(e: Edition, id: SourceId): string {
  return e.sources[id]?.name ?? id;
}

/** Outlet display name of an article: its link-host outlet (`pub`) or its source's publisher. */
export function publisherName(e: Edition, a: ArticleV2): string {
  return a.pub ?? e.sources[a.src]?.publisher ?? sourceName(e, a.src);
}

/** Emphasis weight with the wire default applied (absent = 1). */
export function weightOf(a: ArticleV2): Weight {
  return a.w ?? 1;
}

/** CSS class per weight, index = weight (0..3). Same class names as V1's priority styling. */
export const WEIGHT_CLASSES = ["headline-low", "headline-medium", "headline-high", "headline-critical"] as const;

export function weightClass(a: ArticleV2): (typeof WEIGHT_CLASSES)[number] {
  return WEIGHT_CLASSES[weightOf(a)];
}

export function hasFlag(a: ArticleV2, flag: NonNullable<ArticleV2["flags"]>[number]): boolean {
  return a.flags?.includes(flag) ?? false;
}

function sourceMuted(a: ArticleV2, mutes: MuteSet): boolean {
  return mutes.sources.has(a.src);
}

/** True when the article must be hidden under the given mutes (its source is muted). */
export function isMuted(a: ArticleV2, mutes: MuteSet): boolean {
  return sourceMuted(a, mutes);
}

// ------------------------------------------------------------------------------------------------
// Stories
// ------------------------------------------------------------------------------------------------

export interface StoryView {
  /**
   * The story's key: the id of the lead the PIPELINE chose. Rows, clusters, TOP STORIES and river
   * `leadId`s are keyed by it. Equal to `lead.id` unless that article's source is muted and another
   * outlet's article stands in for it (visibleStory).
   */
  key: ArticleId;
  /** The article to display. */
  lead: ArticleV2;
  /** Other articles of the story in display order (only those present in the edition). */
  members: ArticleV2[];
  /** Distinct publishers covering the story, including the lead's (1 for a singleton). */
  publishers: number;
}

/** The story led by `lead`; null when that article is not in the edition (e.g. rest.json not loaded). */
export function storyOf(e: Edition, lead: ArticleId): StoryView | null {
  const a = e.articles[lead];
  if (!a) return null;
  const c = e.clusters[lead];
  if (!c) return { key: lead, lead: a, members: [], publishers: 1 };
  const members: ArticleV2[] = [];
  for (const id of c.members) {
    const m = e.articles[id];
    if (m) members.push(m);
  }
  return { key: lead, lead: a, members, publishers: Math.max(1, c.publishers) };
}

/**
 * The story keyed by `lead` as the reader sees it under `mutes`: articles of muted sources are left
 * out, and when the pipeline's lead is one of them the first remaining article leads instead (the
 * key stays the same). `publishers` then drops by the COUNTED publishers that are muted entirely
 * (see below). null when the story is not in the edition or every article of it comes from a muted
 * source - muting one outlet never hides a story other outlets cover.
 */
export function visibleStory(e: Edition, lead: ArticleId, mutes: MuteSet = NO_MUTES): StoryView | null {
  const s = storyOf(e, lead);
  if (!s) return null;
  if (mutes.sources.size === 0) return s;
  const leadMuted = sourceMuted(s.lead, mutes);
  if (!leadMuted && !s.members.some((m) => sourceMuted(m, mutes))) return s;
  const rest = s.members.filter((m) => !sourceMuted(m, mutes));
  const shown = leadMuted ? rest.shift() : s.lead;
  if (!shown) return null;
  // `publishers` is the pipeline's COVERAGE count: release lines, community threads and pointer-only
  // aggregators do not count, and the client cannot see that policy. So the number is not recounted
  // from names. Two estimates, the larger wins (never more than the outlets still visible):
  //  - floor: every publisher that is muted entirely counted (exact when every name counts);
  //  - still: the pipeline lists one article per counted publisher FIRST (cluster orderMembers), so
  //    the lead and the first publishers-1 members name the publishers behind the number; count
  //    those that still have a visible article. Muting a thread or a release line that never
  //    counted then leaves the number alone (it used to drop by one).
  const nameOf = (a: ArticleV2): string => publisherName(e, a).toLowerCase();
  const all = new Set<string>([nameOf(s.lead)]);
  for (const m of s.members) all.add(nameOf(m));
  const left = new Set<string>([nameOf(shown)]);
  for (const m of rest) left.add(nameOf(m));
  const floor = s.publishers - (all.size - left.size);
  const counted = new Set<string>([nameOf(s.lead)]);
  for (const m of s.members.slice(0, Math.max(0, s.publishers - 1))) counted.add(nameOf(m));
  let still = 0;
  for (const name of counted) if (left.has(name)) still++;
  const publishers = Math.max(1, Math.min(left.size, Math.max(floor, still)));
  return { key: lead, lead: shown, members: rest, publishers };
}

/**
 * Does the STORY pass a time chip? A story is as new as its newest visible article: the lead may be
 * a day and a half old while outlets are still joining (the 30-publisher IPO story: lead 38 h old,
 * newest member minutes old - the 24H chip used to hide it). True when the displayed lead or any
 * other visible article of the story passes shared/time.ts passesTimeFilter; community threads
 * (flag "discussion") are not coverage and never make an old story new. False for a story that is
 * not in the edition or is muted entirely.
 */
export function storyPassesTimeFilter(e: Edition, key: ArticleId, filter: TimeFilter, now: Clock, previousVisitMs: number | null, mutes: MuteSet = NO_MUTES): boolean {
  const s = visibleStory(e, key, mutes);
  if (!s) return false;
  if (filter === "all" || passesTimeFilter(s.lead, filter, now, previousVisitMs)) return true;
  return s.members.some((m) => !hasFlag(m, "discussion") && passesTimeFilter(m, filter, now, previousVisitMs));
}

/** Effective time (ms) of the newest visible article of a story (threads excluded, as above); 0 when not visible. */
export function storyNewestMs(e: Edition, key: ArticleId, mutes: MuteSet = NO_MUTES): number {
  const s = visibleStory(e, key, mutes);
  if (!s) return 0;
  let t = effectiveMs(s.lead);
  for (const m of s.members) if (!hasFlag(m, "discussion")) t = Math.max(t, effectiveMs(m));
  return t;
}

/** Coverage number of a story: distinct publishers (1 for a singleton or unknown id). */
export function coverageOf(e: Edition, lead: ArticleId): number {
  return Math.max(1, e.clusters[lead]?.publishers ?? 1);
}

export interface Outlet {
  /** Outlet display name. */
  name: string;
  article: ArticleV2;
}

/**
 * The "Also:" line of a story: one entry per OTHER outlet (first article of each publisher, in
 * member order), excluding muted sources and the publisher of the article displayed as the lead
 * (visibleStory: another outlet's article when the pipeline's lead is muted).
 */
export function alsoOutlets(e: Edition, lead: ArticleId, mutes: MuteSet = NO_MUTES): Outlet[] {
  const s = visibleStory(e, lead, mutes);
  if (!s) return [];
  const seen = new Set<string>([publisherName(e, s.lead).toLowerCase()]);
  const out: Outlet[] = [];
  for (const m of s.members) {
    const name = publisherName(e, m);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, article: m });
  }
  return out;
}

/**
 * TOP STORIES as the reader sees them, ranked (visibleStory per entry). A story disappears only when
 * every outlet covering it is muted; `key` is the id to render and look the cluster up by.
 */
export function topStories(e: Edition, mutes: MuteSet = NO_MUTES): StoryView[] {
  const out: StoryView[] = [];
  for (const id of e.top) {
    const s = visibleStory(e, id, mutes);
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Sections
// ------------------------------------------------------------------------------------------------

export function sectionOf(e: Edition, id: SectionId): EditionSection | undefined {
  return e.sections.find((s) => s.id === id);
}

export interface SectionRowsOptions {
  /** false (default): homepage rows. true: every available row (the full list once `e.complete`). */
  all?: boolean;
  mutes?: MuteSet;
}

/**
 * Story keys (the pipeline's lead ids) to render for a section. [] for a muted or unknown section.
 * A row is dropped when its article is not loaded or when every article of the story comes from a
 * muted source. A story whose lead source alone is muted STAYS, under the same id: the row shows the
 * article visibleStory() promotes.
 */
export function sectionRows(e: Edition, id: SectionId, opts: SectionRowsOptions = {}): ArticleId[] {
  const mutes = opts.mutes ?? NO_MUTES;
  if (mutes.sections.has(id)) return [];
  const s = sectionOf(e, id);
  if (!s) return [];
  const rows = opts.all ? s.rows : s.rows.slice(0, s.homeCount);
  if (mutes.sources.size === 0) return rows.filter((rid) => e.articles[rid] !== undefined);
  return rows.filter((rid) => {
    const a = e.articles[rid];
    if (a === undefined) return false;
    return !sourceMuted(a, mutes) || visibleStory(e, rid, mutes) !== null;
  });
}

/** Every visible lead id (deduped across sections, first-appearance order), respecting mutes. */
export function visibleLeads(e: Edition, mutes: MuteSet = NO_MUTES, opts: { all?: boolean; desks?: readonly Desk[] } = {}): ArticleId[] {
  const seen = new Set<ArticleId>();
  const out: ArticleId[] = [];
  for (const s of e.sections) {
    if (opts.desks) {
      const def = findSection(s.id);
      if (!def || !opts.desks.includes(def.desk)) continue;
    }
    for (const id of sectionRows(e, s.id, { all: opts.all ?? true, mutes })) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export interface LatestOptions {
  /** Desks to draw from. Default ["ai", "owner"] - the release radar (utility desk) is excluded. */
  desks?: readonly Desk[];
}

const LATEST_DESKS: readonly Desk[] = ["ai", "owner"];

/**
 * LATEST strip: the `limit` newest visible leads by effective time (publishedAt ?? firstSeenAt),
 * newest first; ties broken by id for determinism. Respects mutes.
 */
export function latest(e: Edition, limit: number, mutes: MuteSet = NO_MUTES, opts: LatestOptions = {}): ArticleId[] {
  const ids = visibleLeads(e, mutes, { all: true, desks: opts.desks ?? LATEST_DESKS });
  return ids
    .map((id) => ({ id, t: effectiveMs(e.articles[id]) }))
    .sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((x) => x.id);
}

/**
 * Number of distinct visible stories with an article first seen after `sinceMs` ("N new since your
 * last visit"; a story that gained an outlet since then counts, as it does on #/new).
 * Counts over the rows currently available in the edition; river.json gives the full list.
 */
export function countNewSince(e: Edition, sinceMs: number, mutes: MuteSet = NO_MUTES): number {
  let n = 0;
  for (const id of visibleLeads(e, mutes, { all: true })) if (storyPassesTimeFilter(e, id, "new", sinceMs, sinceMs, mutes)) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------------

/**
 * A search query taken apart. Free words must all be found in what a story SAYS (or, as a weaker
 * match, in the name of its source); the operators narrow the corpus:
 *   source:<name>     stories with an article from a source / publisher of that name or id
 *                     (prefix match; quote names with a space: source:"the record")
 *   section:<id>      stories listed under that section (id, chip code or label: section:policy,
 *                     section:local, section:"ai security"; a prefix works when nothing is exact)
 */
export interface SearchQuery {
  /** Normalised free words (parseQuery of the query without its operators). */
  words: string[];
  /** One normalised value per `source:` operator; every one must match. */
  sources: string[];
  /** Sections named by `section:` operators; null when the query has none, [] when they name nothing. */
  sections: SectionId[] | null;
  /** `section:` values that name no section (as typed, normalised). */
  unknownSections: string[];
}

const OPERATOR = /(^|\s)(source|section):(?:"([^"]*)"?|(\S*))/g;

/** "AI SECURITY", "ai_security", "ai-security" and "AI SEC" all compare equal to their section. */
function sectionKey(text: string): string {
  return normalizeForSearch(text).replace(/[_&/:-]+/g, " ").replace(/\s+/g, " ").trim();
}

const SECTION_KEYS: ReadonlyMap<SectionId, readonly string[]> = new Map(SECTIONS.map((s: SectionDef) => [s.id, [sectionKey(s.id), sectionKey(s.short), sectionKey(s.label)]]));

/** The section whose id, chip code or label IS `text` ("local", "AI SEC", "policy & regulation"); null otherwise. */
export function sectionNamed(text: string | null | undefined): SectionId | null {
  const key = sectionKey(text ?? "");
  if (!key) return null;
  for (const [id, keys] of SECTION_KEYS) if (keys.includes(key)) return id;
  return null;
}

/** Sections a `section:` value names: the exact one (sectionNamed), else every section a word of whose names it starts. */
export function sectionsNamed(text: string): SectionId[] {
  const exact = sectionNamed(text);
  if (exact) return [exact];
  const words = sectionKey(text).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const out: SectionId[] = [];
  for (const [id, keys] of SECTION_KEYS) if (matchesQuery(keys.join(" \n "), words, { prefix: true })) out.push(id);
  return out;
}

export function parseSearch(query: string | null | undefined): SearchQuery {
  const sources: string[] = [];
  let sections: SectionId[] | null = null;
  const unknownSections: string[] = [];
  const free = normalizeForSearch(query).replace(OPERATOR, (_all, lead: string, op: string, quoted: string | undefined, bare: string | undefined) => {
    const value = (quoted ?? bare ?? "").replace(/"/g, "").trim();
    // "source:" with nothing after it yet (search-as-you-type): not a filter, not a word.
    if (!value) return lead;
    if (op === "source") {
      if (!sources.includes(value)) sources.push(value);
      return lead;
    }
    const ids = sectionsNamed(value);
    sections ??= [];
    if (ids.length === 0) unknownSections.push(value);
    for (const id of ids) if (!sections.includes(id)) sections.push(id);
    return lead;
  });
  return { words: parseQuery(free), sources, sections, unknownSections };
}

/** True when the query asks for nothing (no word, no operator). */
export function isBlankSearch(q: SearchQuery): boolean {
  return q.words.length === 0 && q.sources.length === 0 && q.sections === null;
}

/**
 * Where a story matched, strongest first:
 *   "title"     every word is in the displayed headline (also: a query made of operators only)
 *   "summary"   ... in the headline + the lead's summary
 *   "coverage"  ... with the headlines of the other outlets covering the story
 *   "source"    only with the NAME of a source or publisher - nothing the story says holds every word
 */
export type SearchMatch = "title" | "summary" | "coverage" | "source";

interface StoryText {
  title: string;
  withSummary: string;
  /** Everything the story says: headline, summary, the other outlets' headlines. */
  content: string;
  /** Source and publisher display names of every article. */
  names: string;
  /** `names` plus the source ids (the `source:` operator also accepts an id). */
  namesAndIds: string;
}

const storyTexts = new WeakMap<Edition, Map<ArticleId, StoryText>>();
const NO_TEXT: StoryText = { title: "", withSummary: "", content: "", names: "", namesAndIds: "" };

function textOf(e: Edition, s: StoryView): StoryText {
  const title = normalizeForSearch(s.lead.title);
  const withSummary = s.lead.summary ? `${title} \n ${normalizeForSearch(s.lead.summary)}` : title;
  const names = new Set<string>();
  const ids = new Set<string>();
  let content = withSummary;
  for (const a of [s.lead, ...s.members]) {
    if (a !== s.lead) content += ` \n ${normalizeForSearch(a.title)}`;
    names.add(normalizeForSearch(sourceName(e, a.src)));
    names.add(normalizeForSearch(publisherName(e, a)));
    ids.add(normalizeForSearch(a.src));
  }
  const nameText = [...names].join(" \n ");
  return { title, withSummary, content, names: nameText, namesAndIds: `${nameText} \n ${[...ids].join(" \n ")}` };
}

/**
 * Search text of a story. Cached per edition for the unmuted story; a story that loses articles to
 * the reader's mutes is searched over what remains (a muted outlet's headline must not produce a
 * hit on a row that no longer shows it), uncached - mutes are few.
 */
function storyText(e: Edition, lead: ArticleId, mutes: MuteSet): StoryText {
  if (mutes.sources.size > 0) {
    const full = storyOf(e, lead);
    if (full && (sourceMuted(full.lead, mutes) || full.members.some((m) => sourceMuted(m, mutes)))) {
      const visible = visibleStory(e, lead, mutes);
      return visible ? textOf(e, visible) : NO_TEXT;
    }
  }
  let cache = storyTexts.get(e);
  if (!cache) {
    cache = new Map();
    storyTexts.set(e, cache);
  }
  const hit = cache.get(lead);
  if (hit !== undefined) return hit;
  const s = storyOf(e, lead);
  const text = s ? textOf(e, s) : NO_TEXT;
  cache.set(lead, text);
  return text;
}

/** `source:` values of at most this many characters must be a whole word of a source name, publisher name or id. */
export const SOURCE_WHOLE_WORD_MAX = 3;

/**
 * Does a `source:` value name this source? `namesAndIds` = normalizeForSearch-ed source name,
 * publisher name and source id. A longer value may be the start of a word ("source:tech" finds
 * TechCrunch, "source:gn-reuters" an id); a value of up to SOURCE_WHOLE_WORD_MAX characters is an
 * acronym and must be a whole word - "source:sec" matched every "Security" source (28 sources, 47
 * stories on 2026-11-20, 36 of them in AI SECURITY and CYBER) instead of the SEC's feeds.
 */
export function sourceValueMatches(namesAndIds: string, value: string): boolean {
  return matchesQuery(namesAndIds, [value], { prefix: [...value].length > SOURCE_WHOLE_WORD_MAX });
}

function matchText(text: StoryText, q: SearchQuery): SearchMatch | null {
  for (const value of q.sources) if (!sourceValueMatches(text.namesAndIds, value)) return null;
  if (q.words.length === 0 || matchesQuery(text.title, q.words)) return text.title ? "title" : null;
  if (matchesQuery(text.withSummary, q.words)) return "summary";
  if (matchesQuery(text.content, q.words)) return "coverage";
  return matchesQuery(`${text.content} \n ${text.names}`, q.words) ? "source" : null;
}

/** How the story keyed by `lead` matches the query under the reader's mutes; null when it does not. */
export function searchMatchOf(e: Edition, lead: ArticleId, q: SearchQuery, mutes: MuteSet = NO_MUTES): SearchMatch | null {
  return isBlankSearch(q) ? null : matchText(storyText(e, lead, mutes), q);
}

export interface SearchGroup {
  section: SectionId;
  /**
   * Stories whose own text matches: headline matches first, then summary matches, then matches in
   * another outlet's headline - the section's ranked order inside each.
   */
  rows: ArticleId[];
  /** Stories found ONLY through the name of a source or publisher (ranked order). Not in `rows`. */
  nameOnly: ArticleId[];
  /** Where each id of `rows` / `nameOnly` matched. */
  matches: Record<ArticleId, SearchMatch>;
}

/**
 * Search the edition. Multi-word AND over normalised text (case, diacritics, curly quotes and dashes
 * folded; "quoted phrases" stay together), plus the `source:` / `section:` operators of parseSearch.
 *
 * A story is a result when every word is found in what it says - its displayed headline, the lead's
 * summary, the other outlets' headlines (`rows`, strongest match first). A story that needs the NAME
 * of its source or publisher to hold every word is reported apart (`nameOnly`): query feeds such as
 * "GN: AI x SEC/FINRA" match their own name on every item. Section labels are NOT search text (the
 * label matched every story of the section: "local" returned 39 of 45 rows that way); use
 * `section:` to search inside a section and sectionNamed() to offer the section itself.
 *
 * Grouped by section (homepage order); a story placed in two sections appears in both. Muted
 * sections are excluded, and so are stories whose every outlet is muted (articles of muted sources
 * are not searched). [] for a blank query.
 */
export function searchEdition(e: Edition, query: string | SearchQuery, mutes: MuteSet = NO_MUTES): SearchGroup[] {
  const q = typeof query === "string" ? parseSearch(query) : query;
  if (isBlankSearch(q)) return [];
  const out: SearchGroup[] = [];
  for (const s of e.sections) {
    if (q.sections && !q.sections.includes(s.id)) continue;
    const tiers: Record<SearchMatch, ArticleId[]> = { title: [], summary: [], coverage: [], source: [] };
    const matches: Record<ArticleId, SearchMatch> = {};
    for (const id of sectionRows(e, s.id, { all: true, mutes })) {
      const m = matchText(storyText(e, id, mutes), q);
      if (!m) continue;
      tiers[m].push(id);
      matches[id] = m;
    }
    const rows = [...tiers.title, ...tiers.summary, ...tiers.coverage];
    if (rows.length || tiers.source.length) out.push({ section: s.id, rows, nameOnly: tiers.source, matches });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// River
// ------------------------------------------------------------------------------------------------

export interface RiverItem {
  id: ArticleId;
  title: string;
  url: string;
  sourceId: SourceId;
  sourceName: string;
  section: SectionId;
  publishedAtMs: number | null;
  firstSeenAtMs: number;
  /** publishedAtMs ?? firstSeenAtMs. */
  effectiveMs: number;
  /** Lead of the story this item belongs to; null when it is the lead / a singleton. */
  leadId: ArticleId | null;
}

/** River tuples as objects, file order (newest first). Muted sources and sections are dropped. */
export function riverRows(river: RiverFile, mutes: MuteSet = NO_MUTES): RiverItem[] {
  const out: RiverItem[] = [];
  for (const r of river.rows) {
    const sourceId = river.sourceIds[r[3]] ?? "";
    if (mutes.sources.has(sourceId) || mutes.sections.has(r[4])) continue;
    out.push({
      id: r[0],
      title: r[1],
      url: r[2],
      sourceId,
      sourceName: river.sources[r[3]] ?? sourceId,
      section: r[4],
      publishedAtMs: r[5],
      firstSeenAtMs: r[6],
      effectiveMs: r[5] ?? r[6],
      leadId: r[7],
    });
  }
  return out;
}

/** River items first seen after `sinceMs` (the #/new page), newest first. */
export function riverSince(river: RiverFile, sinceMs: number, mutes: MuteSet = NO_MUTES): RiverItem[] {
  return riverRows(river, mutes).filter((r) => r.firstSeenAtMs > sinceMs);
}

export interface RiverSearch {
  /** Items whose TITLE holds every word, newest first. */
  rows: RiverItem[];
  /** Items that need the NAME of their source to hold every word, newest first. Not in `rows`. */
  nameOnly: RiverItem[];
}

/**
 * River search: the query rules of searchEdition over what a river row carries - its title and its
 * source (name, and id for the `source:` operator). Section labels are not search text; `section:`
 * filters on the section the item is listed under.
 */
export function searchRiver(river: RiverFile, query: string | SearchQuery, mutes: MuteSet = NO_MUTES): RiverSearch {
  const q = typeof query === "string" ? parseSearch(query) : query;
  const out: RiverSearch = { rows: [], nameOnly: [] };
  if (isBlankSearch(q)) return out;
  for (const r of riverRows(river, mutes)) {
    if (q.sections && !q.sections.includes(r.section)) continue;
    const name = normalizeForSearch(r.sourceName);
    const title = normalizeForSearch(r.title);
    const m = matchText({ title, withSummary: title, content: title, names: name, namesAndIds: `${name} \n ${normalizeForSearch(r.sourceId)}` }, q);
    if (m === "source") out.nameOnly.push(r);
    else if (m) out.rows.push(r);
  }
  return out;
}

/** River items whose TITLE matches (watchlist): pass a TermMatcher from compileTerms (or any predicate). */
export function riverMatching(river: RiverFile, matches: (title: string) => unknown, mutes: MuteSet = NO_MUTES): RiverItem[] {
  return riverRows(river, mutes).filter((r) => Boolean(matches(r.title)));
}

/**
 * River items of one section, newest first - the "view all" tail beyond rest.json. Pass the ids
 * already shown (rest rows and their cluster members) as `exclude`.
 */
export function riverSection(river: RiverFile, section: SectionId, mutes: MuteSet = NO_MUTES, exclude?: ReadonlySet<ArticleId>): RiverItem[] {
  return riverRows(river, mutes).filter((r) => r.section === section && !(exclude?.has(r.id) ?? false));
}

/** One item per story: keeps the first item of each `leadId ?? id` group (input order preserved). */
export function collapseStories(items: readonly RiverItem[]): RiverItem[] {
  const seen = new Set<ArticleId>();
  const out: RiverItem[] = [];
  for (const r of items) {
    const key = r.leadId ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Sort key helper: sections in homepage order, unknown ids last. */
export function bySectionOrder(a: SectionId, b: SectionId): number {
  const ia = sectionOrder(a);
  const ib = sectionOrder(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
}
