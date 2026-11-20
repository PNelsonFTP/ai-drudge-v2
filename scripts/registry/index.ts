// The source registry: every feed, query, scraper and JSON API the pipeline reads.
//
// Data lives in ./sources/<topic>.ts (one file per home section, plus queries / releases / scrapers)
// and ./publishers.ts. This module concatenates them, VALIDATES the result at import (a bad entry
// fails the build and every test, not one run in CI) and exports the lookups other packages use.
//
// Tier criteria (V1 critical/high/medium/low, then deflated - see the sources-taxonomy review):
//   1  first-party frontier-lab announcement feeds and the US securities regulators' own feeds (target <= 8)
//   2  original reporting and primary research; primary documents of the other finance regulators
//      on the finance beat (SEC speeches, OCC bulletins, Fed speeches, Bank of England PRA)
//   3  trade press, vendor blogs, analyst newsletters; first-party changelogs and release feeds of
//      tracked tools; query feeds that proxy ONE first-party lab blog, one trade publication or the
//      compliance / local-stack watches (3 is the ceiling for kind "query")
//   4  digests, community, most query feeds, long-tail changelogs, vendor firehoses (rendered
//      de-emphasised: w = 0)
// Techmeme is the one tier-3 aggregator (leadEligible and countsForCoverage are both false).
// No release feed is tier 1. Story size (publisher count), not tier, drives emphasis. A note that
// says "tier N" must agree with the entry's tier (registry.test.ts checks it).
//
// Scope: "ai" = on-mission for its home desk by construction, never gated (this includes dedicated
// security outlets homed in the CYBER WIRE owner desk); "general" = broad feed, every item must pass
// the relevance gate or the source's own `include` list. Every "general" source carries a note.

import { isSectionId } from "../../shared/sections";
import { compileTerms } from "../../shared/text";
import { isHttpUrl, registrableHost, urlKey } from "../../shared/url";
import { MAX_SOURCE_AGE_DAYS, resolveSource } from "./defaults";
import { outletProblems } from "./outlets";
import { PUBLISHERS } from "./publishers";
import { COMPUTE } from "./sources/compute";
import { CYBER } from "./sources/cyber";
import { FINANCE } from "./sources/finance";
import { LABS } from "./sources/labs";
import { LOCAL } from "./sources/local";
import { NEWSLETTERS } from "./sources/newsletters";
import { POLICY } from "./sources/policy";
import { PRESS } from "./sources/press";
import { QUERIES } from "./sources/queries";
import { RELEASES } from "./sources/releases";
import { REMOVED } from "./sources/removed";
import { RESEARCH } from "./sources/research";
import { ROBOTICS_QUANTUM } from "./sources/robotics-quantum";
import { SCRAPERS } from "./sources/scrapers";
import { SECURITY } from "./sources/security";
import { TOOLS } from "./sources/tools";
import type { PublisherDef, PublisherId, SourceDef, SourceId, SourceKind } from "./types";

export { PUBLISHERS } from "./publishers";
export { OUTLET_DENY, UNVETTED_OUTLET_TAG, UNVETTED_PUBLISHER_IDS, deniedOutlet, isVettedPublisher, type DeniedOutlet } from "./outlets";
export { REMOVED, type RemovedSource } from "./sources/removed";

/** Structurally identical to the pipeline's `Registry` (the registry must not import the pipeline). */
export interface RegistryData {
  /** ALL sources, paused ones included. */
  sources: readonly SourceDef[];
  publishers: readonly PublisherDef[];
}

const SOURCE_FILES: readonly (readonly SourceDef[])[] = [
  LABS, PRESS, NEWSLETTERS, TOOLS, SECURITY, CYBER, POLICY, FINANCE, RESEARCH, COMPUTE, ROBOTICS_QUANTUM, LOCAL, RELEASES, QUERIES, SCRAPERS,
];

const ALL: readonly SourceDef[] = SOURCE_FILES.flat();

// ------------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------------

const KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "rss", "newsletter", "papers", "github-release", "query", "community", "aggregator", "scrape", "json",
]);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_RELEASES_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\.atom$/;

function termProblems(label: string, terms: readonly string[] | undefined): string[] {
  if (terms === undefined) return [];
  if (!Array.isArray(terms) || terms.length === 0) return [`${label}: must be a non-empty list when present`];
  const bad = terms.filter((t) => typeof t !== "string" || !t.trim());
  if (bad.length) return [`${label}: blank term`];
  // compileTerms collapses case-insensitive duplicates and drops terms it cannot compile.
  return compileTerms(terms).size === terms.length ? [] : [`${label}: duplicate or uncompilable term`];
}

function substringProblems(label: string, parts: readonly string[] | undefined): string[] {
  if (parts === undefined) return [];
  return parts.length > 0 && parts.every((p) => typeof p === "string" && p.trim()) ? [] : [`${label}: must be non-empty strings`];
}

function sourceProblems(s: SourceDef, publisherIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const bad = (msg: string): void => void out.push(`${s.id || s.name || "?"}: ${msg}`);

  if (!ID_RE.test(s.id)) bad(`id is not a kebab slug: "${s.id}"`);
  if (!s.name?.trim()) bad("empty name");
  if (!isHttpUrl(s.url)) bad(`url is not http(s): ${s.url}`);
  if (s.homepage !== undefined && !isHttpUrl(s.homepage)) bad(`homepage is not http(s): ${s.homepage}`);
  if (!publisherIds.has(s.publisher)) bad(`unknown publisher "${s.publisher}"`);
  if (!KINDS.has(s.kind)) bad(`unknown kind "${String(s.kind)}"`);
  if (s.scope !== "ai" && s.scope !== "general") bad(`unknown scope "${String(s.scope)}"`);
  if (!isSectionId(s.home)) bad(`unknown home section "${String(s.home)}"`);
  if (![1, 2, 3, 4].includes(s.tier)) bad(`tier must be 1-4, got ${String(s.tier)}`);
  for (const r of s.routeTo ?? []) if (!isSectionId(r)) bad(`unknown routeTo section "${String(r)}"`);
  if (s.routing === "home-only" && s.routeTo?.length) bad("routeTo is meaningless with routing home-only");
  if (s.scope === "general" && !s.note?.trim()) bad('scope "general" needs a note saying what the gate is expected to keep');
  if (s.status === "paused" && !s.note?.trim()) bad("a paused source needs a note saying why");
  if (s.addedAt !== undefined && !DATE_RE.test(s.addedAt)) bad(`addedAt is not YYYY-MM-DD: ${s.addedAt}`);
  for (const [k, v] of [["maxItems", s.maxItems], ["maxAgeDays", s.maxAgeDays], ["maxKept", s.maxKept]] as const) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 1)) bad(`${k} must be a positive integer`);
  }
  if (s.fetch !== undefined) {
    const f: unknown = s.fetch;
    if (typeof f !== "object" || f === null || Array.isArray(f)) bad("fetch must be an object");
    else {
      const { headerTimeoutMs, timeoutRetries, attempts, ...unknown } = f as Record<string, unknown>;
      const whole = (v: unknown, min: number, max: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
      if (headerTimeoutMs !== undefined && !whole(headerTimeoutMs, 1_000, 25_000)) bad("fetch.headerTimeoutMs must be an integer from 1000 to 25000");
      if (timeoutRetries !== undefined && !whole(timeoutRetries, 0, 1)) bad("fetch.timeoutRetries must be 0 or 1");
      if (attempts !== undefined && !whole(attempts, 1, 3)) bad("fetch.attempts must be 1, 2 or 3");
      for (const key of Object.keys(unknown)) bad(`fetch.${key} is not a fetch policy field`);
      if (headerTimeoutMs === undefined && timeoutRetries === undefined && attempts === undefined) bad("fetch is empty");
    }
  }
  if (s.maxAgeDays !== undefined && s.maxAgeDays > MAX_SOURCE_AGE_DAYS) bad(`maxAgeDays ${s.maxAgeDays} exceeds the limit of ${MAX_SOURCE_AGE_DAYS} (the data gate rejects items older than 60 days)`);
  out.push(...termProblems(`${s.id}: include`, s.include), ...termProblems(`${s.id}: exclude`, s.exclude));
  out.push(...substringProblems(`${s.id}: includeUrl`, s.includeUrl), ...substringProblems(`${s.id}: excludeUrl`, s.excludeUrl));
  if (s.includeIn !== undefined) {
    if (s.includeIn !== "title" && s.includeIn !== "title+summary") bad(`includeIn must be "title" or "title+summary", got "${String(s.includeIn)}"`);
    if (!s.include?.length) bad("includeIn without an include list");
  }
  if (s.outlets !== undefined) {
    if (s.outlets !== "vetted" && s.outlets !== "open") bad(`outlets must be "vetted" or "open", got "${String(s.outlets)}"`);
    if (resolveSource(s).attribution !== "link-host") bad("outlets is meaningless without link-host attribution");
    if (s.outlets === "open" && !s.note?.trim()) bad('outlets "open" needs a note saying what vouches for the outlets');
  }

  if (s.kind === "scrape") {
    if (!s.scrape) bad('kind "scrape" needs a scrape config');
    else {
      if (!isHttpUrl(s.scrape.base)) bad(`scrape.base is not http(s): ${s.scrape.base}`);
      try {
        new RegExp(s.scrape.linkPattern);
      } catch {
        bad(`scrape.linkPattern does not compile: ${s.scrape.linkPattern}`);
      }
      if (!s.scrape.linkPattern) bad("scrape.linkPattern is empty");
    }
  } else if (s.scrape) bad("scrape config on a non-scrape source");

  if (s.kind === "json") {
    const j = s.jsonApi;
    if (!j) bad('kind "json" needs a jsonApi config');
    else {
      if (typeof j.itemsPath !== "string") bad("jsonApi.itemsPath missing");
      if (!j.titleField) bad("jsonApi.titleField missing");
      if (!j.urlField && !j.urlTemplate) bad("jsonApi needs urlField, urlTemplate or both (the template is then the fallback)");
      if (j.urlTemplate !== undefined && !/\{[^{}]+\}/.test(j.urlTemplate)) bad("jsonApi.urlTemplate has no {field} placeholder");
    }
  } else if (s.jsonApi) bad("jsonApi config on a non-json source");

  if (s.kind === "github-release") {
    if (s.tier === 1) bad("a release feed can never be tier 1");
    const repo = GITHUB_RELEASES_RE.exec(s.url)?.[1];
    if (!repo) bad("github-release url must be https://github.com/<owner>/<repo>/releases.atom");
    else {
      if (s.name !== repo) bad(`github-release name must be the repo "${repo}"`);
      if (s.publisher !== `github:${repo}`) bad(`github-release publisher must be "github:${repo}"`);
    }
  }
  return out;
}

/**
 * Every integrity problem of a registry, as human-readable lines ([] = valid). Pure, so tests can
 * feed it broken data; the module calls it on the real registry at import and throws on any problem.
 */
export function validateRegistry(sources: readonly SourceDef[], publishers: readonly PublisherDef[]): string[] {
  const out: string[] = [];

  const publisherIds = new Set<string>();
  const hostOwner = new Map<string, string>();
  for (const p of publishers) {
    if (publisherIds.has(p.id)) out.push(`publisher ${p.id}: duplicate id`);
    publisherIds.add(p.id);
    if (!p.name?.trim()) out.push(`publisher ${p.id}: empty name`);
    for (const h of p.hosts) {
      if (registrableHost(h) !== h) out.push(`publisher ${p.id}: host "${h}" is not in registrableHost form`);
      const owner = hostOwner.get(h);
      if (owner !== undefined && owner !== p.id) out.push(`host "${h}" is claimed by both ${owner} and ${p.id}`);
      hostOwner.set(h, p.id);
    }
  }

  const ids = new Set<string>();
  const urls = new Map<string, string>();
  const names = new Map<string, string>();
  for (const s of sources) {
    out.push(...sourceProblems(s, publisherIds));
    if (ids.has(s.id)) out.push(`${s.id}: duplicate id`);
    ids.add(s.id);
    const key = urlKey(s.url);
    if (key !== null) {
      const other = urls.get(key);
      if (other !== undefined) out.push(`${s.id}: same canonical url as ${other} (${s.url})`);
      urls.set(key, s.id);
    }
    for (const n of [s.name, ...(s.aliases ?? [])]) {
      const k = legacyKey(n);
      const other = names.get(k);
      if (other !== undefined && other !== s.id) out.push(`${s.id}: name or alias "${n}" also belongs to ${other}`);
      names.set(k, s.id);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Exports
// ------------------------------------------------------------------------------------------------

function legacyKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const PROBLEMS = [...validateRegistry(ALL, PUBLISHERS), ...outletProblems(PUBLISHERS)];
if (PROBLEMS.length > 0) {
  throw new Error(`source registry is invalid (${PROBLEMS.length} problem${PROBLEMS.length === 1 ? "" : "s"}):\n  ${PROBLEMS.join("\n  ")}`);
}

/** Every source, paused ones included, in file order. */
export const SOURCES: readonly SourceDef[] = ALL;

export const REGISTRY: RegistryData = { sources: SOURCES, publishers: PUBLISHERS };

const BY_ID: ReadonlyMap<SourceId, SourceDef> = new Map(SOURCES.map((s) => [s.id, s]));
const PUBLISHER_BY_ID: ReadonlyMap<PublisherId, PublisherDef> = new Map(PUBLISHERS.map((p) => [p.id, p]));
const PUBLISHER_BY_HOST: ReadonlyMap<string, PublisherDef> = new Map(PUBLISHERS.flatMap((p) => p.hosts.map((h) => [h, p] as const)));
const ID_BY_NAME: ReadonlyMap<string, SourceId> = new Map(
  SOURCES.flatMap((s) => [s.name, ...(s.aliases ?? [])].map((n) => [legacyKey(n), s.id] as const)),
);

export function sourceById(id: SourceId): SourceDef | undefined {
  return BY_ID.get(id);
}

/**
 * Source id for a V1 display name, a current display name or an alias (case and spacing
 * insensitive). undefined for names that were removed (see REMOVED) or never existed.
 * A removed source's mute does not migrate to the source that now covers its beat.
 */
export function idForLegacyName(name: string): SourceId | undefined {
  return typeof name === "string" ? ID_BY_NAME.get(legacyKey(name)) : undefined;
}

export function publisherById(id: PublisherId): PublisherDef | undefined {
  return PUBLISHER_BY_ID.get(id);
}

/** Publisher owning a URL's or host's registrable host (link-host attribution); undefined when no publisher claims it. */
export function publisherForHost(urlOrHost: string): PublisherDef | undefined {
  const host = registrableHost(urlOrHost);
  return host === null ? undefined : PUBLISHER_BY_HOST.get(host);
}

export interface RegistryStats {
  total: number;
  active: number;
  paused: number;
  publishers: number;
  byHome: Record<string, number>;
  byKind: Record<string, number>;
  byScope: Record<string, number>;
  byTier: Record<string, number>;
}

function countBy(sources: readonly SourceDef[], key: (s: SourceDef) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) out[key(s)] = (out[key(s)] ?? 0) + 1;
  return out;
}

/** Counts per home section / kind / scope / tier (docs, the Sources page header, the audit tool). */
export function registryStats(sources: readonly SourceDef[] = SOURCES): RegistryStats {
  const paused = sources.filter((s) => s.status === "paused").length;
  return {
    total: sources.length,
    active: sources.length - paused,
    paused,
    publishers: new Set(sources.map((s) => s.publisher)).size,
    byHome: countBy(sources, (s) => s.home),
    byKind: countBy(sources, (s) => s.kind),
    byScope: countBy(sources, (s) => s.scope),
    byTier: countBy(sources, (s) => String(s.tier)),
  };
}

/** Names of V1 sources that were removed on purpose (lower-cased keys of REMOVED). */
export function isRemovedLegacyName(name: string): boolean {
  const k = legacyKey(name);
  return REMOVED.some((r) => legacyKey(r.name) === k);
}
