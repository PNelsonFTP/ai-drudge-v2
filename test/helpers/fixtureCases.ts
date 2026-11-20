// The CASES of the v2 fixture: rows and sources tests select BY PROPERTY ("a paywalled homepage
// row", "the first story with 8+ publishers", "a carried source") instead of pinning ids, titles or
// counts of one day's data - the fixture is replaced by `npm run fixture:refresh` whenever a newer
// build is frozen, and a test that pins a headline breaks on every refresh.
//
// PURE (shared/ imports only): used by client tests through test/helpers/fixtureData.ts, by
// test/fixtures.test.ts (the committed fixture must hold every case) and by the refresh tool
// (scripts/tools/fixture-refresh.ts refuses a build that lacks one).

import type { ArticleId, ArticleV2, ClusterV2, FeedHealthRow, SourceId, SourceInfo, SourceKind } from "../../shared/contract";
import type { DataBundle } from "../../shared/invariants";
import type { SectionId } from "../../shared/sections";
import { mergeEdition, type Edition } from "../../shared/select";

/** One story of an edition, as a selector sees it. */
export interface FixtureStory {
  /** Story key = id of the pipeline's lead article. */
  key: ArticleId;
  lead: ArticleV2;
  cluster: ClusterV2 | undefined;
  /** Publishers covering the story (1 for a singleton). */
  publishers: number;
  /** Kind of the lead's source. */
  kind: SourceKind | undefined;
  /** Sections that list the story, homepage order. */
  sections: SectionId[];
  /** Sections whose HOMEPAGE rows list it. */
  homeSections: SectionId[];
  /** Position in TOP STORIES, -1 when not there. */
  top: number;
}

/** Every story of the edition, each once: TOP STORIES first, then the sections' rows in page order. */
export function fixtureStories(e: Edition): FixtureStory[] {
  const order: ArticleId[] = [];
  const seen = new Set<ArticleId>();
  const add = (id: ArticleId): void => {
    if (!seen.has(id) && e.articles[id]) {
      seen.add(id);
      order.push(id);
    }
  };
  for (const id of e.top) add(id);
  for (const s of e.sections) for (const id of s.rows) add(id);
  return order.map((key) => {
    const cluster = e.clusters[key];
    const lead = e.articles[key];
    const listed = e.sections.filter((s) => s.rows.includes(key));
    return {
      key,
      lead,
      cluster,
      publishers: cluster?.publishers ?? 1,
      kind: e.sources[lead.src]?.kind,
      sections: listed.map((s) => s.id),
      homeSections: listed.filter((s) => s.rows.slice(0, s.homeCount).includes(key)).map((s) => s.id),
      top: e.top.indexOf(key),
    };
  });
}

/** The stories that pass `test`, page order. */
export function storiesWhere(e: Edition, test: (s: FixtureStory) => boolean): FixtureStory[] {
  return fixtureStories(e).filter(test);
}

/** The first story that passes `test`; throws naming `what` when the edition has none. */
export function storyWhere(e: Edition, what: string, test: (s: FixtureStory) => boolean): FixtureStory {
  const s = fixtureStories(e).find(test);
  if (!s) throw new Error(`fixture: no ${what} in this edition - select another property or refresh the fixture from a build that has one`);
  return s;
}

/**
 * Capitalised words (5+ letters) of a set of headlines with the number of headlines that carry
 * each, most common first (ties: alphabetical). Terms for watchlist / search tests come from here,
 * so they follow whatever the news of the frozen day is.
 */
export function titleWords(titles: readonly string[]): { word: string; titles: number }[] {
  const counts = new Map<string, number>();
  for (const title of titles) for (const w of new Set(title.match(/\b[A-Z][a-z]{4,}\b/g) ?? [])) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([word, n]) => ({ word, titles: n }));
}

/** The most common word of titleWords; throws when it is in fewer than `minTitles` headlines. */
export function commonTitleWord(titles: readonly string[], minTitles = 5): { word: string; titles: number } {
  const best = titleWords(titles)[0];
  if (!best || best.titles < minTitles) throw new Error(`fixture: no word is in ${minTitles} of the ${titles.length} headlines`);
  return best;
}

/** A word that is in no headline of any day (a "quiet" watch term, a search without results). */
export const ABSENT_WORD = "Zzyzxqq";

/** Titles of the story leads on the HOMEPAGE (TOP STORIES + every section's homepage rows), each story once. */
export function homepageTitles(e: Edition): string[] {
  return fixtureStories(e)
    .filter((s) => s.top >= 0 || s.homeSections.length > 0)
    .map((s) => s.lead.title);
}

const hasFlag = (a: ArticleV2, flag: NonNullable<ArticleV2["flags"]>[number]): boolean => a.flags?.includes(flag) ?? false;
const hasTags = (s: SourceInfo | undefined, ...tags: string[]): boolean => tags.every((t) => s?.tags?.includes(t));

/** The files the case selectors read. */
export type CaseBundle = Required<Pick<DataBundle, "front">> & { rest: NonNullable<DataBundle["rest"]>; health: NonNullable<DataBundle["health"]>; sources: NonNullable<DataBundle["sources"]> };

/** Story cases: name -> story keys (page order). */
export interface StoryCases {
  /** A homepage row whose lead is behind a paywall (flag "paywall"). */
  paywalledRow: ArticleId[];
  /** A story with 8+ publishers (w = 3, .headline-critical). */
  weight3: ArticleId[];
  /** A story with w = 2 (.headline-high). */
  weight2: ArticleId[];
  /** A homepage row of ordinary weight (w omitted on the wire). */
  weight1: ArticleId[];
  /** A homepage row led by a tier-4 source alone (w = 0, grey italic). */
  weight0: ArticleId[];
  /** A homepage row led by a newsletter. */
  newsletterRow: ArticleId[];
  /** A POLICY row that is a regulator's own notice (source tags `regulator` + `first-party`). */
  regulatorRow: ArticleId[];
  /** The lead story, when 5+ publishers cover it. */
  multiPublisherLead: ArticleId[];
  /** A TOP STORY another outlet can lead when the lead's source is muted (a "re-led" row). */
  reLeadable: ArticleId[];
  /** A homepage row that is a release line (flag "release"). */
  releaseRow: ArticleId[];
  /** A row that is a discussion thread (flag "discussion"). */
  discussionRow: ArticleId[];
  /** A story whose lead is attributed by link host (`pub` set: aggregator / search sources). */
  linkHostRow: ArticleId[];
  /** A story listed in two sections (home + one routed). */
  crossListed: ArticleId[];
  /** A singleton homepage row with a summary (the summary disclosure). */
  singletonWithSummary: ArticleId[];
}

/** Health cases: name -> source ids (health.json order). */
export interface HealthCases {
  ok: SourceId[];
  /** Fetch failed this run, last-good items carried. */
  carried: SourceId[];
  /** Not asked this run because its host was failing; last-good items carried (error "skipped"). */
  hostBackoff: SourceId[];
  failing: SourceId[];
  quarantined: SourceId[];
  /** Paused in the registry: listed in sources.json, no health row. */
  paused: SourceId[];
}

export interface FixtureCases {
  stories: StoryCases;
  health: HealthCases;
}

export const HEALTH_TESTS: Readonly<Record<Exclude<keyof HealthCases, "paused">, (f: FeedHealthRow) => boolean>> = {
  ok: (f) => f.status === "ok",
  carried: (f) => f.status === "carried" && f.error !== "skipped",
  hostBackoff: (f) => f.status === "carried" && f.error === "skipped",
  failing: (f) => f.status === "failing",
  quarantined: (f) => f.status === "quarantined",
};

/** Every case of a data set. Pure. */
export function fixtureCasesOf(bundle: CaseBundle): FixtureCases {
  const e = mergeEdition(bundle.front, bundle.rest);
  const info = new Map(bundle.sources.sources.map((s) => [s.id, s]));
  const keys = (test: (s: FixtureStory) => boolean): ArticleId[] => storiesWhere(e, test).map((s) => s.key);
  const onHome = (s: FixtureStory): boolean => s.homeSections.length > 0;
  const stories: StoryCases = {
    paywalledRow: keys((s) => onHome(s) && hasFlag(s.lead, "paywall")),
    weight3: keys((s) => s.lead.w === 3 && s.publishers >= 8),
    weight2: keys((s) => s.lead.w === 2),
    weight1: keys((s) => onHome(s) && s.lead.w === undefined),
    weight0: keys((s) => onHome(s) && s.lead.w === 0),
    newsletterRow: keys((s) => onHome(s) && s.kind === "newsletter"),
    regulatorRow: keys((s) => s.sections.includes("policy") && hasTags(info.get(s.lead.src), "regulator", "first-party")),
    multiPublisherLead: keys((s) => s.key === e.leadId && s.publishers >= 5),
    reLeadable: keys((s) => s.top >= 0 && (s.cluster?.members ?? []).some((m) => e.articles[m] !== undefined && e.articles[m].src !== s.lead.src)),
    releaseRow: keys((s) => onHome(s) && hasFlag(s.lead, "release")),
    discussionRow: keys((s) => hasFlag(s.lead, "discussion")),
    linkHostRow: keys((s) => s.lead.pub !== undefined),
    crossListed: keys((s) => s.sections.length === 2),
    singletonWithSummary: keys((s) => onHome(s) && !s.cluster && !!s.lead.summary),
  };
  const ids = (test: (f: FeedHealthRow) => boolean): SourceId[] => bundle.health.feeds.filter(test).map((f) => f.id);
  const health: HealthCases = {
    ok: ids(HEALTH_TESTS.ok),
    carried: ids(HEALTH_TESTS.carried),
    hostBackoff: ids(HEALTH_TESTS.hostBackoff),
    failing: ids(HEALTH_TESTS.failing),
    quarantined: ids(HEALTH_TESTS.quarantined),
    paused: bundle.sources.sources.filter((s) => s.paused).map((s) => s.id),
  };
  return { stories, health };
}

/** What each case is, in the words a failure message uses. */
export const CASE_LABELS: Readonly<Record<keyof StoryCases | keyof HealthCases, string>> = {
  paywalledRow: "paywalled homepage row",
  weight3: "story with 8+ publishers (w = 3)",
  weight2: "story with w = 2",
  weight1: "homepage row of ordinary weight",
  weight0: "low-tier homepage row (w = 0)",
  newsletterRow: "homepage row led by a newsletter",
  regulatorRow: "regulator's own notice in POLICY",
  multiPublisherLead: "lead story with 5+ publishers",
  reLeadable: "TOP STORY that another outlet can lead under a mute",
  releaseRow: "release line on a homepage list",
  discussionRow: "discussion thread row",
  linkHostRow: "story attributed by link host",
  crossListed: "story listed in two sections",
  singletonWithSummary: "single-outlet homepage row with a summary",
  ok: "healthy source",
  carried: "carried source (fetch failed, last-good items shown)",
  hostBackoff: "source skipped by host backoff",
  failing: "failing source",
  quarantined: "quarantined source",
  paused: "paused source",
};

/** Labels of the cases a data set does NOT have ([] = every case is there). */
export function missingFixtureCases(bundle: CaseBundle): string[] {
  const c = fixtureCasesOf(bundle);
  const missing: string[] = [];
  for (const [name, list] of [...Object.entries(c.stories), ...Object.entries(c.health)]) {
    if ((list as string[]).length === 0) missing.push(CASE_LABELS[name as keyof typeof CASE_LABELS]);
  }
  return missing;
}
