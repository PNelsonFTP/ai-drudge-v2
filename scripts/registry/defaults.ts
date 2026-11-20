// The ONE place where optional SourceDef policy fields get their defaults.
// Stages call resolveSource(def) (normalize does, and copies the result onto every NormalizedItem)
// instead of re-deriving "leadEligible defaults to false for releases" in five packages.
// Owned by WP0; pure (no node:, no I/O).

import type { ResolvedSource, SourceDef } from "./types";

export const DEFAULT_MAX_ITEMS = 15;
/** Longest section hard window (policy / safety / analysis / quantum: 21 days). */
export const DEFAULT_MAX_AGE_DAYS = 21;
/**
 * Largest maxAgeDays a source may set. The data gate fails a build that publishes an item older than
 * GATE.maxItemAgeDays (60, scripts/pipeline/emit/quality.ts); a source window must stay well under it.
 */
export const MAX_SOURCE_AGE_DAYS = 45;
/** Per-source cap after relevance (PIPELINE.sourceCap is this number). */
export const DEFAULT_MAX_KEPT = 8;

export function resolveSource(def: SourceDef): ResolvedSource {
  const secondary = def.kind === "github-release" || def.kind === "community";
  const linkHost = def.kind === "query" || def.kind === "aggregator";
  const attribution = def.attribution ?? (linkHost ? "link-host" : "source");
  return {
    ...def,
    routing: def.routing ?? (def.kind === "community" ? "home-only" : "normal"),
    routeTo: def.routeTo ?? null,
    leadEligible: def.leadEligible ?? !secondary,
    countsForCoverage: def.countsForCoverage ?? !secondary,
    attribution,
    // A feed that is its own publisher has no outlets to vet (registry/outlets.ts).
    outlets: attribution === "link-host" ? (def.outlets ?? "vetted") : "open",
    maxItems: def.maxItems ?? DEFAULT_MAX_ITEMS,
    maxKept: def.maxKept ?? DEFAULT_MAX_KEPT,
    maxAgeDays: def.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    maxAgeExplicit: def.maxAgeDays !== undefined,
    status: def.status ?? "active",
    tags: def.tags ?? [],
  };
}

/** Sources that are fetched (status !== "paused"). */
export function activeSources(sources: readonly SourceDef[]): SourceDef[] {
  return sources.filter((s) => (s.status ?? "active") === "active");
}

/** id -> resolved source. Throws on a duplicate id (the registry test catches this earlier). */
export function indexSources(sources: readonly SourceDef[]): Map<string, ResolvedSource> {
  const map = new Map<string, ResolvedSource>();
  for (const s of sources) {
    if (map.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    map.set(s.id, resolveSource(s));
  }
  return map;
}
