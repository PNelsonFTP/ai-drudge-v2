// Search page model (#/q/<query>): the WHOLE corpus - the edition (ranked rows incl. the view-all
// tails, via searchEdition) plus the 7-day river (searchRiver) once it is loaded. Multi-word AND,
// grouped by section with counts, each story listed once. Pure.
//
// What counts as a result is what a story SAYS: its headline first, then its summary, then the
// headlines of the other outlets covering it. Stories that match only through the NAME of their
// source or publisher are listed apart, after the results ("From sources named ..."), and are not
// counted as matches; section names are not searched at all (the query "local" used to return 39 of
// 45 rows through the label LOCAL & OPEN MODELS) - a query that IS a section name gets a link to
// the section instead, and `section:<id>` / `source:<name>` narrow a search on purpose.
//
// V1 searched only the visible homepage rows, so 43-88 % of matching stories were missing and
// multi-word queries failed; the regression tests in model.test.ts pin both.

import type { ArticleId, RiverFile } from "../../../shared/contract";
import { findSection, type SectionId } from "../../../shared/sections";
import {
  NO_MUTES,
  bySectionOrder,
  collapseStories,
  isBlankSearch,
  parseSearch,
  publisherName,
  searchEdition,
  searchRiver,
  sectionNamed,
  sourceName,
  visibleStory,
  type Edition,
  type MuteSet,
  type RiverItem,
  sourceValueMatches,
} from "../../../shared/select";
import { matchesQuery, normalizeForSearch, queryWordPattern } from "../../../shared/text";
import type { Route } from "../../app/services";
import { riverRef, snippetAround, type RowRef } from "../export/kit/rows";

export type MatchPlace = "summary" | "coverage" | "source";

/** Where a row matched when the match is not (fully) visible in its title. */
export interface MatchContext {
  place: MatchPlace;
  /** Excerpt to show under the row (the summary snippet, the other outlet's headline, the source name). */
  text: string;
  /** place "source": the query words nothing in the story holds - only the name does. */
  words?: string[];
}

export interface SearchRow extends RowRef {
  origin: "edition" | "river";
  context?: MatchContext;
}

export interface SearchGroupView {
  section: SectionId;
  label: string;
  /**
   * Headline matches, then summary matches, then matches in another outlet's headline (the
   * section's ranked order inside each), then river-only stories newest first.
   */
  rows: SearchRow[];
}

export interface SearchView {
  query: string;
  /** Normalised free words (every one must be found; they are what gets highlighted). */
  words: string[];
  /** True when the query asks for nothing: no word and no operator. */
  blank: boolean;
  /** Stories whose own text matches, by section in homepage order. */
  groups: SearchGroupView[];
  /** Distinct stories in `groups` - the number of MATCHES. */
  total: number;
  /** Of `total`: stories found only in the 7-day river (off the current edition). */
  fromRiver: number;
  /**
   * Stories that do not say the words themselves: only the name of their source or publisher holds
   * them. Homepage section order, ranked; never counted in `total`.
   */
  bySource: SearchRow[];
  /** The words those names matched, as the reader typed them when it is the whole query ("FINRA"). */
  sourceWords: string;
  /** The section the query names ("local", "ai security"): offered as a link, not searched. */
  section: { id: SectionId; label: string } | null;
  /** Sections a `section:` operator narrowed the search to (homepage order); [] without one. */
  inSections: { id: SectionId; label: string }[];
  /** Values of the `source:` operators. */
  fromSources: string[];
  /** `section:` values that name no section. */
  unknownSections: string[];
}

export interface SearchInput {
  edition: Edition | null;
  river: RiverFile | null;
  query: string;
  mutes: MuteSet;
}

const holds = (normalized: string, word: string): boolean => queryWordPattern(word).test(normalized);

/**
 * Explain a match that the title alone does not show. When some word is found nowhere in what the
 * story says, the name that holds it (place "source"); otherwise the first place - the summary, then
 * another outlet's headline - that holds a word missing from the title. undefined for a full title
 * match, for an unknown id and for a blank word list.
 */
export function matchContext(e: Edition, lead: ArticleId, words: readonly string[], mutes: MuteSet = NO_MUTES): MatchContext | undefined {
  // The story as displayed: with a muted lead source another outlet's headline is the row's title.
  const s = visibleStory(e, lead, mutes);
  if (!s) return undefined;
  const title = normalizeForSearch(s.lead.title);
  const missing = words.filter((w) => !holds(title, w));
  if (missing.length === 0) return undefined;
  const summary = normalizeForSearch(s.lead.summary);
  const members = s.members.map((m) => normalizeForSearch(m.title));
  const unsaid = missing.filter((w) => !holds(summary, w) && !members.some((t) => holds(t, w)));
  if (unsaid.length > 0) {
    const names = [sourceName(e, s.lead.src), publisherName(e, s.lead), ...s.members.flatMap((m) => [sourceName(e, m.src), publisherName(e, m)])];
    const name = names.find((n) => unsaid.some((w) => holds(normalizeForSearch(n), w)));
    return { place: "source", text: name ?? "", words: unsaid };
  }
  if (s.lead.summary && missing.some((w) => holds(summary, w))) {
    return { place: "summary", text: snippetAround(s.lead.summary, missing) ?? s.lead.summary };
  }
  const i = members.findIndex((t) => missing.some((w) => holds(t, w)));
  if (i >= 0) return { place: "coverage", text: `${publisherName(e, s.members[i])}: ${s.members[i].title}` };
  return undefined;
}

/**
 * For a `source:` search: when the outlet on display is not the one asked for, the other outlet of
 * the story that is ("Also covered by Reuters: ..."), so the row explains why it is listed.
 */
export function sourceContext(e: Edition, lead: ArticleId, sources: readonly string[], mutes: MuteSet = NO_MUTES): MatchContext | undefined {
  if (sources.length === 0) return undefined;
  const s = visibleStory(e, lead, mutes);
  if (!s) return undefined;
  const named = (a: (typeof s.members)[number], value: string): boolean =>
    sourceValueMatches(`${normalizeForSearch(sourceName(e, a.src))} \n ${normalizeForSearch(publisherName(e, a))} \n ${normalizeForSearch(a.src)}`, value);
  const missing = sources.filter((v) => !named(s.lead, v));
  if (missing.length === 0) return undefined;
  const other = s.members.find((m) => missing.some((v) => named(m, v)));
  return other ? { place: "coverage", text: `${publisherName(e, other)}: ${other.title}` } : undefined;
}

/**
 * True when nothing the story SAYS matched - only the name of its source or publisher. Query feeds
 * ("GN: AI x SEC/FINRA") match their own name on every item; such rows are listed apart
 * (SearchView.bySource) and never counted as matches.
 */
export function isNameOnlyMatch(row: Pick<SearchRow, "context">): boolean {
  return row.context?.place === "source";
}

const sectionRef = (id: SectionId): { id: SectionId; label: string } => ({ id, label: findSection(id)?.label ?? id.toUpperCase() });

export function buildSearchView(input: SearchInput): SearchView {
  const { edition, river, mutes } = input;
  const query = input.query.trim();
  const q = parseSearch(query);
  const { words } = q;
  const operators = q.sources.length > 0 || q.sections !== null;
  const unquoted = query.replace(/["\u201C\u201D]/g, " ").trim().replace(/\s+/g, " ");
  const named = operators ? null : sectionNamed(unquoted);
  const base = {
    query,
    words,
    section: named ? sectionRef(named) : null,
    inSections: [...(q.sections ?? [])].sort(bySectionOrder).map(sectionRef),
    fromSources: q.sources,
    unknownSections: q.unknownSections,
  };
  if (isBlankSearch(q)) return { ...base, blank: true, groups: [], total: 0, fromRiver: 0, bySource: [], sourceWords: "" };

  const bySection = new Map<SectionId, SearchRow[]>();
  const push = (section: SectionId, row: SearchRow): void => {
    const list = bySection.get(section);
    if (list) list.push(row);
    else bySection.set(section, [row]);
  };
  const apart: { section: SectionId; row: SearchRow }[] = [];
  const nameWords = new Set<string>();
  const pushNamed = (section: SectionId, row: SearchRow, unsaid: readonly string[]): void => {
    apart.push({ section, row });
    for (const w of unsaid) nameWords.add(w);
  };

  // Stories (and every article of them) already listed from the edition.
  const shown = new Set<ArticleId>();
  let found = 0;
  if (edition) {
    const hits = searchEdition(edition, q, mutes);
    // searchEdition lists a story under every section it is placed in (home + at most one routed
    // section). A result list should name each story once: under its home section when it is
    // among the sections searched, else under the first section it was found in.
    const foundIn = new Map<ArticleId, SectionId[]>();
    for (const g of hits) {
      for (const id of [...g.rows, ...g.nameOnly]) {
        const list = foundIn.get(id);
        if (list) list.push(g.section);
        else foundIn.set(id, [g.section]);
      }
    }
    const placeOf = (id: ArticleId): SectionId | undefined => {
      const sections = foundIn.get(id) ?? [];
      const home = edition.articles[id]?.home;
      return home !== undefined && sections.includes(home) ? home : sections[0];
    };
    const list = (section: SectionId, id: ArticleId): boolean => {
      if (placeOf(id) !== section) return false;
      shown.add(id);
      for (const m of edition.clusters[id]?.members ?? []) shown.add(m);
      return true;
    };
    for (const g of hits) {
      for (const id of g.rows) {
        if (!list(g.section, id)) continue;
        found++;
        push(g.section, { id, origin: "edition", context: matchContext(edition, id, words, mutes) ?? sourceContext(edition, id, q.sources, mutes) });
      }
      for (const id of g.nameOnly) {
        if (!list(g.section, id)) continue;
        const context = matchContext(edition, id, words, mutes);
        pushNamed(g.section, { id, origin: "edition", context }, context?.words ?? words);
      }
    }
  }

  let fromRiver = 0;
  if (river) {
    const hits = searchRiver(river, q, mutes);
    const fresh = (r: RiverItem): boolean => !shown.has(r.id) && !(r.leadId !== null && shown.has(r.leadId));
    const stories = new Set<ArticleId>();
    for (const r of collapseStories(hits.rows.filter(fresh))) {
      stories.add(r.leadId ?? r.id);
      fromRiver++;
      push(r.section, { ...riverRef(r), origin: "river" });
    }
    // A story one outlet names in its headline is a result already; do not repeat it by feed name.
    for (const r of collapseStories(hits.nameOnly.filter((x) => fresh(x) && !stories.has(x.leadId ?? x.id)))) {
      const title = normalizeForSearch(r.title);
      const unsaid = words.filter((w) => !holds(title, w));
      pushNamed(r.section, { ...riverRef(r), origin: "river", context: { place: "source", text: r.sourceName, words: unsaid } }, unsaid);
    }
  }

  const groups = [...bySection.keys()].sort(bySectionOrder).map((section) => ({ ...sectionRef(section), section, rows: bySection.get(section) ?? [] }));
  // Stable: section order, and inside a section the order found (ranked edition rows, then river).
  const bySource = apart.map((x, i) => ({ ...x, i })).sort((a, b) => bySectionOrder(a.section, b.section) || a.i - b.i).map((x) => x.row);
  const unsaidWords = words.filter((w) => nameWords.has(w));
  const sourceWords = !operators && unsaidWords.length === words.length ? unquoted : unsaidWords.join(" ");
  return { ...base, blank: false, groups: groups.map(({ section, label, rows }) => ({ section, label, rows })), total: found + fromRiver, fromRiver, bySource, sourceWords };
}

/** The query as a watch term: quotes dropped (a watch term is always a phrase), whitespace collapsed. */
export function watchTermFor(query: string): string {
  return query.replace(/["\u201C\u201D]/g, " ").trim().replace(/\s+/g, " ");
}

/** Can the query be saved as a watch term? Not when blank, too long, or already on the list. */
export function watchState(query: string, terms: readonly string[]): "blank" | "watching" | "available" {
  const q = watchTermFor(query);
  if (!q || q.length > 60) return "blank";
  return terms.some((t) => t.toLowerCase() === q.toLowerCase()) ? "watching" : "available";
}

export function searchTitle(route: Route): string {
  return route.name === "search" && route.q.trim() ? `Search: ${route.q.trim()}` : "Search";
}
