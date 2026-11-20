// AI DRUDGE data contract, schema v2 (architecture §3 as amended by V2_PLAN §1.2).
//
// ONE source of truth for every JSON file under public/data/v2/. Pure types + a few constants:
// no node:, no DOM, imports only from shared/.
//
// Files (all generated, gitignored; committed fixture in test/fixtures/v2/):
//   front.json    EditionFront   first paint (preloaded)
//   rest.json     EditionRest    idle after paint / view-all / section page
//   river.json    RiverFile      lazy: search, watchlist, #/new, section tails beyond rest.json
//   health.json   HealthFile     Sources page
//   sources.json  SourcesFile    Sources / Settings page
//   brief.json    BriefFile      first paint
//   stocks.json   StocksFile     first paint
//   status.json   StatusFile     ops (reconciler, freshness guard), About page
//   state.json    StateFile      next build only (type lives in scripts/pipeline/types.ts)
//
// Versioning rules:
//   1. `schemaVersion` is an integer in every file. Additive OPTIONAL fields do not bump it.
//   2. The major version is in the path (data/v2/).
//   3. `buildId` is identical across all files of one build. If rest/river.buildId !== front.buildId
//      the client refetches front once (mergeEdition throws BuildMismatchError).
//   4. The client runs the guards in shared/guards.ts on network AND cached data.

import type { SectionId } from "./sections";

export const SCHEMA_VERSION = 2 as const;
/** status.json keeps its own small integer (ops tooling reads `.schema`). */
export const STATUS_SCHEMA = 1 as const;

/** hashId(canonicalUrl) - same djb2/base36 as V1, so V1 bookmark/seen ids stay valid. */
export type ArticleId = string;
/** Stable kebab slug from the registry ("openai-news"). Never reused. */
export type SourceId = string;
/** Publisher identity slug ("openai", "techcrunch", "github:ggml-org/llama.cpp", or a registrable host). */
export type PublisherId = string;

/** 1 critical .. 4 low (V1 critical/high/medium/low). A property of the SOURCE, not of story size. */
export type Tier = 1 | 2 | 3 | 4;

export type SourceKind =
  | "rss" // ordinary RSS/Atom/RDF/JSON Feed of a site
  | "newsletter" // Substack/Beehiiv/Ghost newsletter feed
  | "papers" // arXiv / paper listings
  | "github-release" // <repo>/releases.atom
  | "query" // search-style feeds (Google News query)
  | "community" // Reddit / Lemmy / HN front page
  | "aggregator" // Techmeme, link blogs/digests that point at other outlets
  | "scrape" // HTML listing page, registry-driven scraper
  | "json"; // JSON API (SourceDef.jsonApi)

export type SourceScope = "ai" | "general";

/** Emphasis weight derived from STORY SIZE (V2_PLAN §1.2). Absent on the wire means 1. */
export type Weight = 0 | 1 | 2 | 3;

export const ARTICLE_FLAGS = ["release", "paper", "discussion", "paywall"] as const;
/**
 * - "release":    synthesized GitHub release line (never a lead / TOP STORY; never clusters across repos)
 * - "paper":      paper listing item (arXiv etc.)
 * - "discussion": community thread (HN / Reddit / Lemmy) rather than an article
 * - "paywall":    source is tagged paywalled
 */
export type ArticleFlag = (typeof ARTICLE_FLAGS)[number];

export interface EditionMeta {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Identical across every file of one build. Opaque; today equal to generatedAt. */
  buildId: string;
  /** ISO 8601 UTC build time. */
  generatedAt: string;
}

export interface ArticleV2 {
  id: ArticleId;
  /** Canonical http(s) URL. */
  url: string;
  /** Cleaned title, <= 200 chars. */
  title: string;
  /** Source that carried the item (key into `sources`). */
  src: SourceId;
  /** Other feeds that carried the SAME url (same-URL twins). Omitted when empty. Never contains `src`. */
  via?: SourceId[];
  /**
   * Outlet display name when it differs from `sources[src].publisher` - i.e. the source uses
   * link-host attribution (Google News / HN searches / aggregator feeds) and the real outlet is the article's
   * host. Use `publisherName(edition, article)` from shared/select.ts instead of reading this directly.
   */
  pub?: string;
  /** ISO 8601 UTC, or null when the feed gave no usable date (never in the future by more than 1 h). */
  publishedAt: string | null;
  /** ISO 8601 UTC: when the pipeline first saw this id. Always present. effectiveAt = publishedAt ?? firstSeenAt. */
  firstSeenAt: string;
  /**
   * Plain text, <= 320 chars, cut at a word boundary. Omitted when empty - and always omitted on a
   * story MEMBER (an article listed in ClusterV2.members): only a lead's summary is shown or searched.
   */
  summary?: string;
  /** The source's home section (NOT necessarily the section the row is shown in). */
  home: SectionId;
  tier: Tier;
  /**
   * Emphasis weight from STORY SIZE, evaluated in this order:
   *   3 = publishers >= 8;  2 = publishers >= 3 or a tier-1 first-party launch;
   *   0 = tier-4 source with fewer than 2 publishers;  1 = everything else (OMITTED on the wire).
   * Client maps 3/2/1/0 to .headline-critical / -high / -medium / -low.
   * Use `weightOf(article)` / `weightClass(article)` from shared/select.ts.
   */
  w?: Weight;
  /** Omitted when empty. */
  flags?: ArticleFlag[];
}

/**
 * A multi-article story, keyed by its LEAD article id in `clusters`. Singletons are omitted.
 * `members` excludes the lead and is in display order ("Also:" line).
 * `publishers` = distinct publishers covering the story INCLUDING the lead's (>= 1; this is the
 * "+N"/coverage number, N = publishers - 1). It counts publishers, never feed names.
 *
 * Member order is part of the contract: when the lead counts for coverage, the first
 * `publishers - 1` members are the first article of each OTHER publisher that counts (cluster
 * orderMembers); repeats and items that do not count (release lines, threads, pointer-only copies)
 * follow. shared/select `visibleStory` relies on this order to recount publishers under mutes.
 */
export interface ClusterV2 {
  members: ArticleId[];
  publishers: number;
}

export interface SourceRef {
  /** Source display name ("TechCrunch AI"). */
  name: string;
  /** Publisher DISPLAY name ("TechCrunch"). */
  publisher: string;
  kind: SourceKind;
}

export interface SectionV2 {
  id: SectionId;
  label: string;
  /** Story lead ids, ranked. front.json: the homepage rows (<= SectionDef.homeRows). */
  rows: ArticleId[];
  /** Number of rows this section has in rest.json (>= rows.length). */
  total: number;
  /** Distinct sources across the section's full row list (leads only). */
  sourceCount: number;
}

export interface EditionCounts {
  /** Distinct stories (lead ids) placed in at least one section (full lists). */
  stories: number;
  /** Total rows across all sections (full lists); a story in two sections counts twice. */
  placements: number;
  feedsOk: number;
  feedsTotal: number;
}

/** MAX length of EditionFront.top. */
export const TOP_STORIES_MAX = 12;

export interface EditionFront extends EditionMeta {
  /** Lead story. Invariant: leadId === top[0] ?? null. */
  leadId: ArticleId | null;
  /**
   * TOP STORIES: lead ids of the ai-desk stories covered by >= 2 publishers, ranked by score
   * (publisher count breaks ties), max 12.
   * Replaces V1 "trending" everywhere. Never a release or community item.
   */
  top: ArticleId[];
  counts: EditionCounts;
  /** Every section of shared/sections.ts exactly once, in SECTIONS order (rows may be empty). */
  sections: SectionV2[];
  /** Every article referenced by leadId/top/rows and by the clusters of those leads. */
  articles: Record<ArticleId, ArticleV2>;
  /** Clusters of the leads present in this file (all their members are in `articles`). */
  clusters: Record<ArticleId, ClusterV2>;
  /** Every source referenced by `articles` (src and via). */
  sources: Record<SourceId, SourceRef>;
}

export interface EditionRest extends EditionMeta {
  /** FULL ranked row list per section (<= SectionDef.allRows). front rows are a PREFIX of these. */
  sections: { id: SectionId; rows: ArticleId[] }[];
  /** Only articles NOT in front.json (keys are disjoint from front.articles). */
  articles: Record<ArticleId, ArticleV2>;
  /** Only clusters NOT in front.json (keys are disjoint from front.clusters). */
  clusters: Record<ArticleId, ClusterV2>;
  /** Only sources NOT in front.json (keys are disjoint from front.sources). */
  sources: Record<SourceId, SourceRef>;
}

/**
 * One river item as a compact tuple:
 *   [id, title, url, sourceIdx, sectionId, publishedAtMs | null, firstSeenAtMs, leadId | null]
 * - sourceIdx indexes RiverFile.sources / RiverFile.sourceIds.
 * - sectionId: the section the item is (or would be) listed under: its story's primary placement,
 *   else its source's home.
 * - leadId: lead article id of the story this item was clustered into; null when the item is itself
 *   a lead or a singleton. Group by `leadId ?? id` to collapse a story.
 * Use `riverRows(river)` from shared/select.ts to get objects; RIVER holds the tuple indexes.
 */
export type RiverRow = [
  id: ArticleId,
  title: string,
  url: string,
  sourceIdx: number,
  sectionId: SectionId,
  publishedAtMs: number | null,
  firstSeenAtMs: number,
  leadId: ArticleId | null,
];

/** Tuple indexes of RiverRow. */
export const RIVER = {
  id: 0,
  title: 1,
  url: 2,
  source: 3,
  section: 4,
  publishedAt: 5,
  firstSeenAt: 6,
  lead: 7,
} as const;

export const RIVER_DAYS = 7 as const;

/**
 * Every item that passed the relevance stage in the last 7 days (BEFORE caps), newest first by
 * effective time (publishedAtMs ?? firstSeenAtMs). Lazy-loaded. Powers search, the watchlist,
 * #/new (since last visit) and section "view all" tails beyond rest.json.
 */
export interface RiverFile extends EditionMeta {
  days: typeof RIVER_DAYS;
  /** Source DISPLAY names, indexed by RiverRow[3]. */
  sources: string[];
  /** Source ids parallel to `sources` (same length, same index) - needed to apply source mutes. */
  sourceIds: SourceId[];
  rows: RiverRow[];
}

/** Failure class of a fetch attempt (stable, machine-readable). */
export type FeedErrorClass =
  | "timeout"
  | "network" // DNS / TLS / connection reset
  | "http" // non-2xx status
  | "too_large" // body over the 5 MB cap
  | "not_feed" // HTML interstitial / not XML or JSON feed
  | "parse" // looked like a feed but did not parse
  | "empty" // valid feed with zero usable items (NOT ok)
  | "no_cards" // scraper found no article cards
  | "skipped"; // not requested this run: quarantined and not probed, or its host was in backoff (then status is "carried")

/**
 * - "ok":          fetched and parsed with >= 1 item this run
 * - "carried":     failed this run, or its host was in backoff and it was not asked; last-good items
 *                  (<= 6 h old) were carried forward
 * - "failing":     failed this run, nothing carried
 * - "quarantined": >= 48 consecutive failures; skipped except one probe per day
 */
export type FeedStatus = "ok" | "failing" | "quarantined" | "carried";

export const FEED_STATUSES = ["ok", "failing", "quarantined", "carried"] as const;

export interface FeedHealthRow {
  id: SourceId;
  /** True only for status "ok". */
  ok: boolean;
  status: FeedStatus;
  /** Items contributed this run (carried items count; 0 when failing/quarantined). */
  count: number;
  /** Failure class of THIS run; absent when ok. */
  error?: FeedErrorClass;
  /** Short human-readable detail of the most recent failure ("HTTP 403", "timeout after 8000 ms"). Kept while failStreak > 0. */
  lastError?: string;
  /** HTTP status of this run's final attempt, when there was a response. */
  httpStatus?: number;
  /** Consecutive failed runs (0 when ok). */
  failStreak: number;
  /** ISO time of the last successful fetch, or null if never. */
  lastOkAt: string | null;
  /** Same as status === "carried" (kept for the architecture's field name). */
  carried?: boolean;
}

export interface HealthFile extends EditionMeta {
  /** One row per ACTIVE registry source, registry order. */
  feeds: FeedHealthRow[];
}

export interface SourceInfo extends SourceRef {
  id: SourceId;
  publisherId: PublisherId;
  home: SectionId;
  tier: Tier;
  scope: SourceScope;
  homepage?: string;
  /** Feed URL (absent for scrape sources, whose listing page is `homepage`). */
  feedUrl?: string;
  tags?: string[];
  /** Earlier display names (V1 mute migration: name -> id). */
  aliases?: string[];
  /** True when the registry marks the source paused (not fetched). */
  paused?: boolean;
}

export interface SourcesFile extends EditionMeta {
  sources: SourceInfo[];
}

export interface BriefCitation {
  title: string;
  url: string;
  /** Source display name. */
  source: string;
}

export interface BriefFile extends EditionMeta {
  /** "fallback" briefs duplicate TOP STORIES and are NOT rendered by the client. */
  source: "claude" | "fallback";
  headline: string;
  bullets: string[];
  cited: BriefCitation[];
  /** Model id that wrote the brief (audit trail). Present when source === "claude". */
  model?: string;
  /**
   * Why the deterministic brief was published: a coarse code ("no-key" | "thin" | "http-4xx" |
   * "http-5xx" | "timeout" | "network" | "refusal" | "truncated" | "invalid-reply" | "error").
   * Absent on a Claude brief and on files written before this field existed. Never free text.
   */
  fallbackReason?: string;
}

export interface StockQuote {
  price: number | null;
  /** Percent change vs previous close (e.g. -2.46), or null. */
  changePct: number | null;
  /** ISO time the quote was fetched by the build. */
  fetchedAt: string;
  /** ISO market time of the quote (exchange timestamp), when the provider gives one. */
  asOf?: string;
}

export interface StocksFile extends EditionMeta {
  /** ISO market time the quotes refer to (latest quote's exchange timestamp); null when unknown. */
  asOf: string | null;
  /** "closed" on weekends/holidays/after hours so the ticker can label stale quotes. */
  marketState?: "open" | "closed";
  /** Display order of symbols. Every symbol here has an entry in `quotes`. */
  order: string[];
  quotes: Record<string, StockQuote>;
}

/** status.json (ops reviewer sketch, <SP>/review/ops-reliability.extras.md §E). */
export interface StatusFile {
  schema: typeof STATUS_SCHEMA;
  /** Same buildId as the edition files of this build. */
  buildId: string;
  generatedAt: string;
  /** Expected refresh cadence. */
  cadenceMinutes: number;
  /** Data older than this is stale (reconciler / client banner threshold). */
  staleAfterMinutes: number;
  run: {
    /** GITHUB_RUN_ID, or null for a local build. */
    id: number | null;
    attempt: number | null;
    /** GITHUB_EVENT_NAME ("schedule" | "workflow_dispatch" | "push") or "local". */
    trigger: string;
    /** Short commit sha, or null. */
    codeSha: string | null;
    /** Pipeline wall time in seconds, or null when not measured. */
    durationS: number | null;
  };
  feeds: {
    total: number;
    ok: number;
    failed: number;
    carriedForward: number;
    quarantined: number;
    /** Display names of feeds that are not ok (failing + carried + quarantined), capped at 50. */
    failedNames: string[];
  };
  content: {
    stories: number;
    /** Number of TOP STORIES. */
    top: number;
    emptySections: SectionId[];
    /** ISO time of the newest placed item (effective time), or null. */
    newestItemAt: string | null;
    medianAgeH: number | null;
  };
  /** `failures` hold the build back (passed === false); `warnings` never do. Absent failures = none recorded. */
  gate: { passed: boolean; warnings: string[]; failures?: string[] };
  brief: {
    source: "claude" | "fallback";
    /** BriefFile.fallbackReason, when present. */
    reason?: string;
    /** Consecutive builds whose Claude brief failed with a key configured, this build included. Absent when 0. */
    failStreak?: number;
  };
  stocks: { ok: number; total: number };
}

/** File names under public/data/v2/ (single place to spell them). */
export const DATA_FILES = {
  front: "front.json",
  rest: "rest.json",
  river: "river.json",
  health: "health.json",
  sources: "sources.json",
  brief: "brief.json",
  stocks: "stocks.json",
  status: "status.json",
  state: "state.json",
} as const;

/** Path of the data directory relative to the site base ("data/v2/"). */
export const DATA_DIR = "data/v2/" as const;
