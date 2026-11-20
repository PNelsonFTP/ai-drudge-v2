// Source registry format (architecture §4, V2_PLAN §2 WP1). TYPES ONLY.
// WP1 owns the data (scripts/registry/{publishers,index,sources/*}.ts); every pipeline stage reads it.
// Defaults for the optional policy fields are applied in ONE place: scripts/registry/defaults.ts
// (`resolveSource`). Never re-implement a default in a stage.

import type { PublisherId, SourceId, SourceKind, SourceScope, Tier } from "../../shared/contract";
import type { SectionId } from "../../shared/sections";

export type { PublisherId, SourceId, SourceKind, SourceScope, Tier };

/**
 * - "normal":    items start in the source's `home` section and may be routed by keyword rules into
 *                ONE additional topic section (subject to `routeTo`).
 * - "home-only": items never leave `home` (noisy community feeds: Reddit, Lemmy, HN front page).
 *                Replaces V1's KEYWORD_AGNOSTIC_SOURCES.
 */
export type SourceRouting = "normal" | "home-only";

/**
 * Who is the PUBLISHER of an item (diversity caps, coverage counts, "Also:" outlet names)?
 * - "source":    the source's `publisher`.
 * - "link-host": the registrable host of the item's canonical URL (query / aggregator feeds such as
 *                Google News, Hacker News searches, Techmeme). Resolved against PublisherDef.hosts; an unknown host
 *                becomes its own publisher id (the host string).
 */
export type SourceAttribution = "source" | "link-host";

/**
 * How a link-host source treats outlets no registry publisher vouches for (scripts/registry/outlets.ts):
 * - "vetted": an item of an unknown outlet (or of a mere hosting platform / press-release wire)
 *             carries no standing - tier 4, never a story lead, no coverage count, tagged
 *             "unvetted-outlet"; the per-source cap fills its slots with known outlets first.
 * - "open":   every outlet keeps the source's tier. For sources with their own quality signal
 *             (an HN points threshold, Techmeme's editors).
 * The outlet DENY list applies under both.
 */
export type OutletPolicy = "vetted" | "open";

/** Registry-driven HTML scraper config (kind: "scrape"). */
export interface ScrapeConfig {
  /** Origin used to resolve relative links ("https://www.anthropic.com"). */
  base: string;
  /**
   * RegExp SOURCE matched against the WHOLE href path of each same-site anchor (an unanchored
   * source such as "/news/[a-z0-9-]+" is wrapped as ^(?:...)/?$); it is also tried against the raw
   * href, so patterns written for relative hrefs work. Anchors that do not match are ignored.
   */
  linkPattern: string;
  /**
   * Where the card title comes from. Honoured values: "h1".."h6", "text" (link text), "aria-label",
   * "img alt"; anything else is ignored. Default order: heading inside / around the link > link
   * text > aria-label > img alt. A link whose text is a call to action ("Read post", "Read on")
   * takes its title from the enclosing card.
   */
  titleSelectorHint?: string;
  /**
   * "time" = dates may come from <time>, date-field markup, date attributes or date TEXT in the
   * card, and on a listing where at least half the cards are dated, undated links are dropped
   * (navigation / evergreen pages). "none" (default) = only explicit date markup is read and
   * nothing is dropped for lacking a date (items get firstSeenAt).
   */
  dateHint?: "time" | "none";
  /** Max items taken from the page (default: SourceDef.maxItems, else 15). */
  maxItems?: number;
}

/**
 * Fetch policy of one source, where it must differ from the build's HTTP defaults (8 s to headers,
 * one 16 s retry after a timeout, 3 attempts). Ingest clamps every number (fetchPolicyFor), so a
 * typo cannot make one source hold a pool slot for minutes; validateRegistry rejects values outside
 * the same bounds. The build and `npm run validate:feeds` share it.
 */
export interface SourceFetchPolicy {
  /** Time to response headers on EVERY attempt, in ms. Integer 1000 - 25000. */
  headerTimeoutMs?: number;
  /** Retries after a timeout (default 1). 0 or 1. */
  timeoutRetries?: number;
  /** Attempts in all (default 3). 1 - 3. */
  attempts?: number;
}

/** JSON API config (kind: "json"). Paths are dot paths into the response ("data.items", "" = root array). */
export interface JsonApiConfig {
  /** Dot path to the array of items. "" when the response itself is the array. */
  itemsPath: string;
  /** Dot path (inside an item) to the title. */
  titleField: string;
  /** Dot path to the item URL. At least one of urlField / urlTemplate is required. */
  urlField?: string;
  /**
   * URL template with {field} placeholders resolved against the item ("https://huggingface.co/{id}").
   * With `urlField` set too it is the FALLBACK for items whose field is empty (an HN text post has no
   * `url` and is linked to its thread); a placeholder without a value never yields a URL.
   */
  urlTemplate?: string;
  /** Dot path to the item date (ISO string or epoch seconds/ms). Absent -> firstSeenAt. */
  dateField?: string;
  /** Dot path to a summary/description. */
  summaryField?: string;
}

export interface SourceDef {
  /** Stable kebab slug, unique, never reused ("openai-news", "gh-ggml-llama-cpp"). */
  id: SourceId;
  /** Display name. V1 names are preserved so V1 mutes migrate by name. */
  name: string;
  /** Earlier display names (mute migration, V1 feedStats coverage). */
  aliases?: string[];
  /** Publisher identity for diversity caps and coverage counts (key of PUBLISHERS). */
  publisher: PublisherId;
  /** Feed URL, JSON API URL, or (kind "scrape") the listing page. Unique across the registry. */
  url: string;
  /** Human homepage for the Sources page. */
  homepage?: string;
  kind: SourceKind;
  /** "general" sources must pass the AI-relevance gate; "ai" sources are relevant by construction. */
  scope: SourceScope;
  /** Home section: every item starts here. For mode:"source" sections this is the only way in. */
  home: SectionId;
  /** 1 critical .. 4 low. Feeds the tier part of the score; a tier-4 lead with fewer than 2 publishers renders de-emphasised (w = 0). */
  tier: Tier;
  /** Free tags: "lab", "first-party", "press", "paywalled", "weekly", "regulatory", "china", "owner-pick", ... */
  tags?: string[];
  /** Fetch policy for a host the default timeouts do not suit (a slow origin). Absent = the build's HTTP defaults. */
  fetch?: SourceFetchPolicy;
  /** Default "normal"; default "home-only" for kind "community". */
  routing?: SourceRouting;
  /** Allowlist of topic sections keyword routing may send this source's items to. Absent = any topic section. [] = none. */
  routeTo?: SectionId[];
  /** May an item of this source lead a story / be a TOP STORY? Default true; default false for kinds "github-release" and "community". */
  leadEligible?: boolean;
  /** Does this source raise a story's publisher count? Default true; default false for kinds "github-release" and "community". */
  countsForCoverage?: boolean;
  /** Default "source"; default "link-host" for kinds "query" and "aggregator" (a kind "json" search feed - the HN searches - sets it explicitly). */
  attribution?: SourceAttribution;
  /**
   * Link-host sources only. Default "vetted": outlets no registry publisher claims are capped to
   * tier 4 (see OutletPolicy). Set "open" - with a note saying what the quality signal is - on
   * sources whose results are already filtered by people (HN points, an editor).
   */
  outlets?: OutletPolicy;
  /**
   * Newest-N items taken from the feed at ingest, by date (default 15). This is the ingest WINDOW,
   * taken BEFORE relevance; not applied to kind "github-release" (normalize needs the whole feed to
   * pick the newest stable tag). The per-build cap is `maxKept`.
   */
  maxItems?: number;
  /** Max items of this source per build AFTER relevance: highest tier, then freshest (default 8 = PIPELINE.sourceCap). */
  maxKept?: number;
  /**
   * Items older than this (effective time) are dropped by relevance (default 21 = longest section
   * hard window). When set EXPLICITLY to more than the section's hard window it also extends that
   * window for this source's stories (slow, high-signal sources); such stories only surface through
   * the starvation fill, never by padding a healthy section.
   */
  maxAgeDays?: number;
  /**
   * Headline template for sources whose feed titles are not headlines. Placeholders: {title} (the
   * cleaned feed title), {summary} (first sentence of the cleaned summary), {source} (display name).
   * An item whose template needs {summary} but has none keeps its feed title.
   * e.g. "FINRA {title}: {summary}", "New on Hugging Face: {title}".
   */
  titleTemplate?: string;
  /**
   * kind "github-release": tag prefixes that are the repo's OWN release line although they are not
   * the repo name ("rust" for openai/codex tags `rust-v0.170.0`). Other prefixed tags are
   * sub-packages and are ignored.
   */
  releaseLine?: string[];
  /**
   * Keep ONLY items whose title or summary matches at least one term (shared/text.ts compileTerms
   * syntax). Absent/empty = keep all. Applied by the relevance stage; for scope "general" sources it
   * REPLACES the global AI-relevance gate.
   */
  include?: string[];
  /**
   * Where `include` terms are looked for. Default "title+summary". "title": the TITLE must match -
   * for feeds whose summaries mention the topic in passing (Phoronix: 'AI/LLM-led bug reports' in a
   * PostgreSQL release story). Needs `include`. `exclude` always reads title and summary.
   */
  includeIn?: "title" | "title+summary";
  /** Drop items whose title or summary matches any term (compileTerms syntax). */
  exclude?: string[];
  /**
   * Keep ONLY items whose canonical URL contains one of these substrings (case-insensitive), e.g.
   * ["/technology/"]. Also matched against the outlet host of an unresolved wrapper link.
   */
  includeUrl?: string[];
  /**
   * Drop items whose canonical URL contains one of these substrings (case-insensitive). Also matched
   * against the outlet host of an unresolved wrapper link (a Google News item whose feed names
   * "stocktitan.net" is dropped by excludeUrl ["stocktitan.net"] before its link is resolved).
   */
  excludeUrl?: string[];
  /** "paused" sources stay in the registry (and sources.json) but are not fetched. Default "active". */
  status?: "active" | "paused";
  /** Why the source exists / why it is paused / what a general-scope source is expected to yield. */
  note?: string;
  /** ISO date the source was added (YYYY-MM-DD). */
  addedAt?: string;
  /** Required when kind is "scrape". */
  scrape?: ScrapeConfig;
  /** Required when kind is "json". */
  jsonApi?: JsonApiConfig;
}

export interface PublisherDef {
  /** Slug ("openai", "techcrunch", "github:ggml-org/llama.cpp"). */
  id: PublisherId;
  /** Display name ("OpenAI", "TechCrunch"). */
  name: string;
  /** Registrable hosts that belong to this publisher (shared/url.ts registrableHost form), for link-host attribution. */
  hosts: string[];
}

/** A SourceDef with every optional policy field resolved to its default (scripts/registry/defaults.ts). */
export interface ResolvedSource extends Omit<SourceDef, "routeTo"> {
  routing: SourceRouting;
  /** null = any topic section. */
  routeTo: SectionId[] | null;
  leadEligible: boolean;
  countsForCoverage: boolean;
  attribution: SourceAttribution;
  /** "open" for every source that is not link-host attributed (the policy has no meaning there). */
  outlets: OutletPolicy;
  maxItems: number;
  maxKept: number;
  maxAgeDays: number;
  /** True when the SourceDef set maxAgeDays itself (only then may it extend a section's hard window). */
  maxAgeExplicit: boolean;
  status: "active" | "paused";
  tags: string[];
}
