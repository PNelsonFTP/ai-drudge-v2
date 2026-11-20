// Contract of the build pipeline: the stage I/O types (the stages are composed by run.ts). TYPES ONLY.
//
//   ingest -> normalize -> relevance -> cluster -> score -> route -> (brief, stocks) -> emit -> write
//
//   const ing   = await ingest(registry, ctx);                       // WP2  network
//   const norm  = normalize(ing.items, registry, ctx);               // WP3  pure
//   const rel   = filterRelevance(norm.items, registry, ctx);        // WP3  pure
//   const st    = cluster(rel.kept, ctx);                            // WP4  pure
//   const sc    = score(st, ing.signals, ctx);                       // WP4  pure
//   const pl    = route(sc, ctx);                                    // WP5  pure
//   const brief = await makeBrief(pl, ctx);                          // WP6  network (Claude) + fallback
//   const stocks= await fetchStocks(ctx);                            // WP6  network
//   const bundle= emit({ placements: pl, health: ing.health, registry, brief, stocks,
//                        dropped: [...norm.dropped, ...rel.dropped], run }, ctx);   // WP6 pure
//   const next  = nextState(ctx.state, { ingest: ing, normalized: norm.items, placements: pl, bundle }, ctx);
//   await writeBundle(bundle, next, targets);                        // WP6  filesystem
//
// Rules for every stage:
// - The clock is ctx.now. No stage calls `new Date()` / `Date.now()` for "now".
// - Only ingest / makeBrief / fetchStocks use ctx.fetch. Only writeBundle / loadState touch the disk.
// - ctx.state is READ-ONLY. State changes travel in stage outputs and are folded by nextState.
// - Stages never mutate their inputs.
// - A stage directory never imports a sibling stage directory (test/boundaries.test.ts). Shared code
//   lives in shared/**, scripts/registry/{types,defaults}.ts and this directory's types/context.

import type {
  ArticleFlag,
  ArticleId,
  BriefFile,
  EditionFront,
  EditionRest,
  FeedErrorClass,
  FeedStatus,
  HealthFile,
  PublisherId,
  RiverFile,
  SourceId,
  SourceKind,
  SourceScope,
  SourcesFile,
  StatusFile,
  StocksFile,
  Tier,
  Weight,
} from "../../shared/contract";
import type { SectionId } from "../../shared/sections";
import type { PublisherDef, SourceAttribution, SourceDef, SourceRouting } from "../registry/types";

// ------------------------------------------------------------------------------------------------
// Context and state
// ------------------------------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

/** What WP1 exports, bundled so stage signatures stay short. */
export interface Registry {
  /** ALL sources incl. paused ones (ingest skips paused; emit lists them in sources.json). */
  sources: readonly SourceDef[];
  publishers: readonly PublisherDef[];
}

/**
 * Injected into every stage. Build one with createContext() (scripts/pipeline/context.ts) in run.ts
 * and createTestContext() in tests.
 */
export interface StageContext {
  /** The build clock, frozen for the whole run. generatedAt = now.toISOString(). */
  now: Date;
  /** Identical in every emitted file (EditionMeta.buildId). */
  buildId: string;
  /** Environment (process.env in production, {} in tests). Keys used are listed in context.ts ENV. */
  env: Readonly<Record<string, string | undefined>>;
  /** Network. Tests inject a fake; the default test context throws on any call. */
  fetch: typeof fetch;
  log(level: LogLevel, msg: string): void;
  /** State restored from the previous build (empty on first run). Read-only. */
  state: Readonly<PipelineState>;
}

export interface SourceHealthState {
  /** Consecutive failed runs (0 after a success). */
  failStreak: number;
  /** ISO time of the last successful fetch; null if never. */
  lastOkAt: string | null;
  /** ISO time of the last attempt of any outcome (quarantine probe scheduling: one probe per day). */
  lastAttemptAt: string | null;
  /** Detail of the most recent failure; cleared on success. */
  lastError?: string;
  lastErrorClass?: FeedErrorClass;
}

/** Last successful fetch of a source, kept so a failing feed can be carried forward for up to 6 h. */
export interface LastGood {
  /** ISO time of the successful fetch that produced `items` (also advances on a 304). */
  fetchedAt: string;
  items: RawItem[];
  /** ETag of the response that produced `items` (conditional GET: If-None-Match). */
  etag?: string;
  /** Last-Modified of that response (If-Modified-Since). */
  lastModified?: string;
  /** ISO time of the last FULL (200) fetch. A 304 is trusted for at most 24 h after `bodyAt`. */
  bodyAt?: string;
}

/**
 * Compact memory of an item that passed relevance in an earlier build. Feeds only list their newest
 * N items, so the 7-day river is built from the current run PLUS these.
 */
export interface RecentItem {
  id: ArticleId;
  title: string;
  url: string;
  sourceId: SourceId;
  section: SectionId;
  publishedAtMs: number | null;
  firstSeenAtMs: number;
  leadId: ArticleId | null;
}

/** Everything one build hands to the next. Persisted as public/data/v2/state.json (StateFile). */
export interface PipelineState {
  /** article id -> ISO time first seen. Pruned by TTL in nextState (must outlive the longest window). */
  firstSeen: Record<ArticleId, string>;
  /** Wrapper URL (Google News etc.) -> resolved article URL. Cache for ingest. */
  resolvedUrls: Record<string, string>;
  health: Record<SourceId, SourceHealthState>;
  lastGood: Record<SourceId, LastGood>;
  /** Items that passed relevance in the last 7 days (river memory). */
  recent: RecentItem[];
  /** Current lead story and since when (lead stability rule in route). */
  lead: { id: ArticleId; since: string } | null;
  /**
   * article id -> epoch DAY (floor(ms / 86_400_000)) a source last listed it. firstSeen is pruned by
   * LAST sighting, so a slow blog's back catalogue never comes back as "new".
   */
  lastSeenDay?: Record<ArticleId, number>;
  /**
   * TOP STORIES of the previous build, in order (route's membership hysteresis - TopMemory). Absent
   * on a first run and when the previous build published no TOP story.
   */
  top?: TopMemory[];
  /**
   * Consecutive builds whose Claude brief failed although a key was configured (>= 1; absent = 0).
   * Written by run.ts after nextState (emit/status.ts briefFailStreakFor); the state stage only
   * keeps it across the save / load round trip - nextState itself never sets or copies it.
   */
  briefFailStreak?: number;
}

/**
 * One TOP story as the next build remembers it. A story is recognised by ANY of its articles
 * carrying `id` (the lead may change as a story grows, and an id may live on in formerIds).
 */
export interface TopMemory {
  /** Lead article id of the story when it was published in TOP STORIES. */
  id: ArticleId;
  /** Its score when it last qualified for TOP STORIES outright (one decimal). */
  score: number;
  /** Set while the story is in TOP only by the hold rule: ISO time the hold began. */
  heldSince?: string;
}

export interface StateFile extends PipelineState {
  schemaVersion: 2;
  buildId: string;
  /** ISO time the state was written (= generatedAt of that build). */
  savedAt: string;
}

// ------------------------------------------------------------------------------------------------
// Ingest (WP2)
// ------------------------------------------------------------------------------------------------

/**
 * One item exactly as the feed / page / API gave it. Ingest does NOT clean text, parse dates or
 * canonicalise URLs - it only guarantees `link` is an absolute http(s) URL (relative links resolved
 * against the feed URL, guid-as-link fallback applied, wrappers such as Google News / Techmeme
 * unwrapped, every other scheme dropped) and that `title` is a non-empty string capped in length.
 */
export interface RawItem {
  sourceId: SourceId;
  /** Raw title (may contain entities / markup). */
  title: string;
  /** Absolute http(s) URL of the article. */
  link: string;
  /** Date string as found (RFC 822, ISO, "3 days ago", ...) or null. Parsed by normalize. */
  publishedRaw: string | null;
  /** Raw description / summary / content snippet (HTML allowed) or null. */
  summaryHtml: string | null;
  /** Discussion URL (HN item, Reddit thread) when the feed has one. */
  comments?: string;
  /** Outlet NAME given by the feed for this item (Google News <source>, Techmeme byline). */
  itemPublisher?: string;
  /** Outlet URL given by the feed for this item (Google News <source url="...">). */
  itemPublisherUrl?: string;
  /** Feed-provided guid / id, when different from the link. */
  guid?: string;
  /** Feed category tags of the item (arXiv categories, WordPress categories). */
  categories?: string[];
  /**
   * The wrapper URL (Google News) or aggregator permalink (Techmeme) that `link` was resolved from. Normalize treats it as an earlier
   * identity of the same article, so an item keeps its first-seen time when its wrapper is resolved
   * in a later build than the one that first listed it.
   */
  resolvedFrom?: string;
  /** True when the item comes from last-good state because this run's fetch failed (carry-forward). */
  carried?: boolean;
}

/** Per-source outcome of this run. Becomes a HealthFile row (emit) and the next SourceHealthState. */
export interface FeedHealth {
  sourceId: SourceId;
  /** True only when this run fetched and parsed >= 1 usable item. */
  ok: boolean;
  status: FeedStatus;
  /** Items contributed to IngestOutput.items by this source (carried items included). */
  count: number;
  /** Wall time spent on the source in ms (0 when skipped). */
  ms: number;
  /** Failure class of this run; absent when ok. An empty-but-valid feed is "empty", NOT ok. */
  error?: FeedErrorClass;
  /** Human-readable failure detail ("HTTP 403", "timeout after 8000 ms"). */
  detail?: string;
  httpStatus?: number;
  /** Consecutive failures INCLUDING this run (0 when ok). */
  failStreak: number;
  /** Last successful fetch INCLUDING this run. */
  lastOkAt: string | null;
  /** Items of this source skipped as malformed (bad URL scheme, empty title, per-item parse error). */
  skippedItems?: number;
  /** Fetch attempts made this run. */
  attempts?: number;
  /** True when the source answered 304 Not Modified and the last-good items were reused (counts as ok). */
  notModified?: boolean;
}

/** Hacker News signal. Keys are shared/url.ts urlKey(articleUrl) - exact-URL match only, no domain fallback. */
export interface HnIndex {
  byUrl: Map<string, { points: number; comments: number }>;
}

export interface IngestOutput {
  /** All items of all sources (fresh + carried), untouched. One malformed item never fails the run. */
  items: RawItem[];
  /** One entry per ACTIVE source, registry order. */
  health: FeedHealth[];
  signals: { hn: HnIndex };
  /** Wrapper -> article URL mappings resolved or confirmed this run (merged into state.resolvedUrls). */
  resolvedUrls: Record<string, string>;
  /** Fresh last-good snapshot for every source that succeeded this run (merged into state.lastGood). */
  lastGood: Record<SourceId, LastGood>;
}

// ------------------------------------------------------------------------------------------------
// Normalize + relevance (WP3)
// ------------------------------------------------------------------------------------------------

/**
 * A cleaned item. Source policy is DENORMALISED onto the item with defaults applied
 * (scripts/registry/defaults.ts resolveSource), so cluster / score / route never need the registry.
 */
export interface NormalizedItem {
  /** hashId(canonicalUrl) - shared/ids.ts + shared/url.ts. */
  id: ArticleId;
  /** Canonical URL. */
  url: string;
  /** Cleaned title (<= 200 chars). */
  title: string;
  /** Cleaned plain-text summary (<= 320 chars, word boundary, "…") or null. */
  summary: string | null;
  sourceId: SourceId;
  /** Source display name (logs, brief citations). */
  sourceName: string;
  /** Other sources that carried the same canonical URL (same-URL twins folded here; never contains sourceId). */
  via: SourceId[];
  /** Ids this article had under an earlier URL (an unresolved wrapper link); absent when none. Never contains `id`. */
  formerIds?: ArticleId[];
  /**
   * Publisher identity: the source's publisher, or for attribution "link-host" the publisher owning
   * the URL's registrable host (unknown hosts: the host itself). An aggregator item that credits
   * its outlet in the title (Techmeme's "(Author/Outlet)" tail) is emitted with attribution
   * "link-host" and that outlet as publisher, whatever the source's own attribution says.
   */
  publisher: PublisherId;
  /** Publisher display name (PublisherDef.name, feed-provided outlet name, or the host). */
  publisherName: string;
  kind: SourceKind;
  scope: SourceScope;
  /** The source's home section. */
  home: SectionId;
  tier: Tier;
  /** Parsed date, ISO UTC, or null. Dates more than 1 h in the future are rejected (null). Date-only stamps = that day 12:00 UTC. */
  publishedAt: string | null;
  /**
   * state.firstSeen[id] ?? ctx.now - except on a BASELINE run (the first build that sees the item's
   * source: empty state, or a source added later), where what the listing already holds is not news:
   * a dated item is first seen at its publishedAt, an item with NO parseable date is recorded as
   * first seen `maxAgeDays + 1` days ago (back catalogue). nextState persists THIS value for a new
   * id (never ctx.now).
   */
  firstSeenAt: string;
  /** publishedAt ?? firstSeenAt. THE time used by windows, recency and ordering. */
  effectiveAt: string;
  /** "release" for synthesized GitHub release lines, "paper" for kind "papers", "discussion" for kind "community" and for an item that links to a Hacker News thread, "paywall" for sources tagged "paywalled". */
  flags: ArticleFlag[];
  /** True when the title was synthesized ("llama.cpp b12549 released"). */
  synthesizedTitle?: boolean;
  /**
   * Source tags (never undefined), plus the ITEM tag "unvetted-outlet" (registry/outlets.ts
   * UNVETTED_OUTLET_TAG) on a link-host item whose outlet no registry publisher vouches for - such an
   * item also carries tier 4, leadEligible false and countsForCoverage false whatever its source says.
   */
  tags: string[];
  routing: SourceRouting;
  /** Allowlist for keyword routing; null = any topic section. */
  routeTo: SectionId[] | null;
  leadEligible: boolean;
  countsForCoverage: boolean;
  attribution: SourceAttribution;
  /**
   * The source's maxAgeDays, present ONLY when the registry sets it explicitly. Route uses
   * max(section hard window, maxAgeDays) as this story's hard window (slow, high-signal sources).
   */
  maxAgeDays?: number;
  /** True when the item was carried forward from last-good state. */
  carried?: boolean;
  /**
   * Host of the outlet a feed names for an item whose link is still an unresolved wrapper
   * ("stocktitan.net" for a news.google.com/rss/articles/... link); relevance URL rules read it.
   * Absent for resolved / direct links.
   */
  outletHost?: string;
}

export type DropReason =
  | "invalid" // unusable URL / empty title after cleaning
  | "duplicate" // exact duplicate within one source (same id twice); cross-source twins fold into via[]
  | "release_collapsed" // older / pre-release / sub-package GitHub release folded into the repo's one line
  | "too_old" // effectiveAt older than the source's maxAgeDays
  | "off_topic" // scope "general" item without AI relevance
  | "excluded" // per-source include / exclude / includeUrl / excludeUrl
  | "noise" // promo / event / webinar / job posting
  | "source_cap"; // over the per-source cap (applied AFTER relevance, keeps highest-tier / freshest)

/** Every dropped item is recorded with a reason (explain tool, compare tool). */
export interface DroppedItem {
  /** null when the item never got an id (invalid URL). */
  id: ArticleId | null;
  sourceId: SourceId;
  title: string;
  url: string;
  reason: DropReason;
  stage: "normalize" | "relevance";
  /** Optional specifics ("matched exclude term: webinar", "age 34 d > 21 d"). */
  detail?: string;
}

export interface NormalizeOutput {
  /** Unique by id. */
  items: NormalizedItem[];
  dropped: DroppedItem[];
}

export interface RelevanceOutput {
  kept: NormalizedItem[];
  dropped: DroppedItem[];
  /**
   * filterRelevance only: every item that passed age / source rules / noise / gate, in input order,
   * BEFORE the per-source cap (kept + the source_cap drops). rescueCorroboration reads it and
   * returns an output without it.
   */
  passed?: NormalizedItem[];
}

// ------------------------------------------------------------------------------------------------
// Cluster + score (WP4)
// ------------------------------------------------------------------------------------------------

/**
 * One story = one or more items about the same event (corpus-wide clustering BEFORE routing).
 * Invariants: items[0].id === lead; members === items.slice(1).map(i => i.id); every kept item is in
 * exactly one story.
 */
export interface Story {
  /** Lead article id. The lead prefers first-party / press over aggregator / community items. */
  lead: ArticleId;
  /** Ids of the other items, display order ("Also:" line). */
  members: ArticleId[];
  /**
   * Distinct publishers covering the story, counting ONLY items with countsForCoverage (releases and
   * community never raise coverage). Same-publisher twins count once. May be empty (release-only story).
   */
  publishers: PublisherId[];
  /** All items, lead first. */
  items: NormalizedItem[];
}

export interface ScoreParts {
  tier: number;
  /** Half-life 36 h on the time the story last gained a coverage publisher (never earlier than effectiveAt). */
  recency: number;
  /** Word-boundary, title-only, modest. */
  importance: number;
  /** Log-scaled publisher count - the dominant significance signal. */
  coverage: number;
  /** Exact-URL Hacker News boost (0 without a match). */
  hn: number;
}

export interface ScoredStory extends Story {
  /** Sum of parts. Higher ranks first. */
  score: number;
  /** The lead item's effectiveAt (the story's time for windows and ordering). */
  effectiveAt: string;
  /** Hours from effectiveAt to ctx.now (>= 0). */
  ageHours: number;
  parts: ScoreParts;
  /**
   * Emphasis weight (becomes ArticleV2.w of the lead), evaluated in this order: 3 = publishers >= 8;
   * 2 = publishers >= 3 or a tier-1 first-party launch; 0 = tier-4 source with fewer than 2 publishers; else 1.
   * (Non-lead members get 0 for tier-4 sources, else 1 - emit applies that.)
   */
  w: Weight;
}

// ------------------------------------------------------------------------------------------------
// Route (WP5)
// ------------------------------------------------------------------------------------------------

export interface PlacedSection {
  id: SectionId;
  /** FULL ranked list of story lead ids (<= SectionDef.allRows). */
  rows: ArticleId[];
  /** How many leading rows form the homepage list (<= SectionDef.homeRows, <= rows.length). */
  homeCount: number;
}

/**
 * Why a story is not in a section whose rule it matched: outside the hard "window"; publisher
 * "diversity"; over the row "cap"; a source-"mode" section (routing never adds stories); "limit" =
 * it already has its ONE routed section; "policy" = source is home-only or the section is not in
 * its routeTo allowlist; "moved" = AI-titled cyber story left cyber for ai_security, or for
 * policy when the title is a policy match (ROUTE_POLICY.moveYieldsTo).
 */
export type RouteCut = "window" | "diversity" | "cap" | "mode" | "limit" | "policy" | "moved";

export interface RouteTrace {
  /** Section the story was keyword-routed to (in addition to home), if any. */
  routedTo: SectionId | null;
  /** Rule / term that fired. */
  rule?: string;
  /** Why the story is not in a section it qualified for. */
  cut?: Partial<Record<SectionId, RouteCut>>;
  /**
   * Sections whose list ranks the story above its score, and why ("open_local/runtime +12
   * title[llama.cpp]"): the section-focus bonus of route/rules.ts SECTION_FOCUS. It orders that
   * section's list only; the story's score is unchanged.
   */
  focus?: Partial<Record<SectionId, string>>;
}

export interface Placements {
  /** EVERY scored story by lead id - placed or not (emit builds the river from all of them). */
  stories: Record<ArticleId, ScoredStory>;
  /** Every section of shared/sections.ts exactly once, in SECTIONS order (rows may be empty). */
  sections: PlacedSection[];
  /**
   * TOP STORIES: ai-desk stories with publishers >= 2 within 72 h, ranked by score (publisher count breaks ties)
   * (relaxed to 120 h when fewer than 4), max 12, never a release or community item. A follow-up of
   * a story already chosen takes a slot only with 5+ publishers of its own, and one running story
   * holds at most 2 slots (`topRelated` lists the rest). A story of the previous build's TOP keeps
   * its slot for up to 2 h against a newcomer that does not clearly outscore it - also when its
   * publisher count fell to 1 (`topHeld`). When NO multi-publisher story exists (quiet day) top is
   * [leadId]: the best-scoring lead-eligible ai-desk story. Either way a TOP story's publisher
   * count may be 1 - consumers must not assume publishers >= 2.
   */
  top: ArticleId[];
  /** top[0] ?? null, after the stability rule (keep ctx.state.lead while it is still in the top 3 and < 24 h old). */
  leadId: ArticleId | null;
  /**
   * Optional. Follow-ups of a TOP story that were NOT given a TOP slot of their own (same running
   * story: route/running.ts): lead id of the TOP story -> lead ids of its follow-ups, best first.
   * Every id is a key of `stories`; the follow-ups keep their section rows. Nothing consumes it yet
   * except the explain tool's trace - an edition may show them as "Related:" under the TOP row.
   */
  topRelated?: Record<ArticleId, ArticleId[]>;
  /**
   * Optional. TOP stories that kept their slot by the hold rule this build (lead id -> when the hold
   * began and the score the story is held at). nextState copies it into PipelineState.top.
   */
  topHeld?: Record<ArticleId, { since: string; score: number }>;
  /**
   * For EVERY story: the section it is listed under - its first placement, or for an unplaced story
   * the section it would belong to (routed topic section, else home). Used as the river row's section.
   */
  primary: Record<ArticleId, SectionId>;
  /** Optional per-story routing explanation for the explain tool. */
  trace?: Record<ArticleId, RouteTrace>;
}

// ------------------------------------------------------------------------------------------------
// Emit + enrich + state (WP6)
// ------------------------------------------------------------------------------------------------

export type RunInfo = StatusFile["run"];

export interface EmitInput {
  placements: Placements;
  health: readonly FeedHealth[];
  registry: Registry;
  brief: BriefFile;
  stocks: StocksFile;
  /** Drops of normalize + relevance (status / explain); optional. */
  dropped?: readonly DroppedItem[];
  /** CI run metadata for status.json; emit fills a "local" default when absent. */
  run?: RunInfo;
}

/** Everything a build publishes (state.json travels separately). All JSON files share ctx.buildId. */
export interface EmitBundle {
  front: EditionFront;
  rest: EditionRest;
  river: RiverFile;
  health: HealthFile;
  sources: SourcesFile;
  status: StatusFile;
  brief: BriefFile;
  stocks: StocksFile;
  /** public/feed.xml (Atom; stable entry ids; ordered by first-seen). */
  atom: string;
  /** public/feeds.opml (every active source). */
  opml: string;
}

export interface WriteTargets {
  /** Directory for the JSON files (public/data/v2). Created if missing. */
  dataDir: string;
  /** Directory for feed.xml and feeds.opml (public). */
  publicDir: string;
}

export interface NextStateInput {
  ingest: IngestOutput;
  /** Normalize output items (firstSeen ledger is updated from these). */
  normalized: readonly NormalizedItem[];
  placements: Placements;
  bundle: EmitBundle;
}

// ------------------------------------------------------------------------------------------------
// Stage function types - each package exports a const of exactly this type
// ------------------------------------------------------------------------------------------------

/** WP2: `export const ingest: Ingest` (scripts/pipeline/ingest/index.ts) */
export type Ingest = (registry: Registry, ctx: StageContext) => Promise<IngestOutput>;
/** WP3: `export const normalize: Normalize` (scripts/pipeline/normalize/index.ts) */
export type Normalize = (raw: readonly RawItem[], registry: Registry, ctx: StageContext) => NormalizeOutput;
/** WP3: `export const filterRelevance: FilterRelevance` (scripts/pipeline/relevance/index.ts) */
export type FilterRelevance = (items: readonly NormalizedItem[], registry: Registry, ctx: StageContext) => RelevanceOutput;
/** WP4: `export const cluster: Cluster` (scripts/pipeline/cluster/index.ts) */
export type Cluster = (items: readonly NormalizedItem[], ctx: StageContext) => Story[];
/** WP4: `export const score: Score` (scripts/pipeline/score/index.ts). Output sorted by score descending. */
export type Score = (stories: readonly Story[], signals: IngestOutput["signals"], ctx: StageContext) => ScoredStory[];
/** WP5: `export const route: Route` (scripts/pipeline/route/index.ts) */
export type Route = (stories: readonly ScoredStory[], ctx: StageContext) => Placements;
/** WP6: `export const emit: Emit` (scripts/pipeline/emit/edition.ts). Pure. */
export type Emit = (input: EmitInput, ctx: StageContext) => EmitBundle;
/** WP6: `export const writeBundle: WriteBundle` (scripts/pipeline/emit/write.ts). Writes atomically; state.json goes to dataDir. */
export type WriteBundle = (bundle: EmitBundle, state: PipelineState, targets: WriteTargets) => Promise<void>;
/** WP6: `export const makeBrief: MakeBrief` (scripts/pipeline/enrich/brief.ts). Never throws: falls back to the fallback brief. */
export type MakeBrief = (placements: Placements, ctx: StageContext) => Promise<BriefFile>;
/** WP6: `export const fetchStocks: FetchStocks` (scripts/pipeline/enrich/stocks.ts). Never throws: null prices on failure. */
export type FetchStocks = (ctx: StageContext) => Promise<StocksFile>;
/** WP6: `export const loadState: LoadState` (scripts/pipeline/state/store.ts). Missing / corrupt file -> empty state. */
export type LoadState = (file: string, log?: StageContext["log"]) => Promise<PipelineState>;
/**
 * WP6: `export const nextState: NextState` (scripts/pipeline/state/store.ts). Pure: folds this run
 * into the state (TTL pruning by ctx.now). A new id's ledger entry is the item's own firstSeenAt
 * (`firstSeen[id] ??= item.firstSeenAt`), never ctx.now. A health row with error "skipped"
 * (quarantined, not probed) leaves the source's SourceHealthState untouched.
 */
export type NextState = (prev: Readonly<PipelineState>, run: NextStateInput, ctx: StageContext) => PipelineState;
