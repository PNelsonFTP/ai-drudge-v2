// Test support: turn a v2 Edition (front.json + rest.json) back into the ScoredStory[] that route()
// consumes, so the route stage can be integration-tested on a real edition without running
// normalize / cluster / score.
//
// Not used by the build. It takes the edition and the registry as ARGUMENTS (route/fixture.test.ts
// passes the bridged 2026-11-19 edition with the registry of that day, and the live fixture with
// the current registry), so this file imports nothing from test/.
//
// The score is a stand-in with the SHAPE of the real one (tier + 36 h half-life recency + log
// coverage); the absolute numbers are not WP4's.

import type { ArticleId, ArticleV2, Weight } from "../../../../shared/contract";
import type { Edition } from "../../../../shared/select";
import { HOUR_MS, parseMs } from "../../../../shared/time";
import { registrableHost } from "../../../../shared/url";
import { indexSources } from "../../../registry/defaults";
import type { ResolvedSource } from "../../../registry/types";
import { PIPELINE } from "../../context";
import type { NormalizedItem, Registry, ScoredStory } from "../../types";

const TIER_POINTS: Record<number, number> = { 1: 40, 2: 30, 3: 20, 4: 8 };

export interface FromEditionOptions {
  /** The clock the stories are scored against (ms). */
  nowMs: number;
}

function publisherOf(a: ArticleV2, src: ResolvedSource | undefined, hostToPublisher: ReadonlyMap<string, string>): string {
  if (src && src.attribution === "source") return src.publisher;
  const host = registrableHost(a.url);
  if (!host) return src?.publisher ?? a.src;
  return hostToPublisher.get(host) ?? host;
}

function toItem(e: Edition, a: ArticleV2, sources: ReadonlyMap<string, ResolvedSource>, hostToPublisher: ReadonlyMap<string, string>): NormalizedItem {
  const src = sources.get(a.src);
  const ref = e.sources[a.src];
  const kind = src?.kind ?? ref?.kind ?? "rss";
  const secondary = kind === "github-release" || kind === "community";
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    summary: a.summary ?? null,
    sourceId: a.src,
    sourceName: ref?.name ?? src?.name ?? a.src,
    via: [...(a.via ?? [])],
    publisher: publisherOf(a, src, hostToPublisher),
    publisherName: a.pub ?? ref?.publisher ?? src?.name ?? a.src,
    kind,
    scope: src?.scope ?? "ai",
    home: a.home,
    tier: a.tier,
    publishedAt: a.publishedAt,
    firstSeenAt: a.firstSeenAt,
    effectiveAt: a.publishedAt ?? a.firstSeenAt,
    flags: [...(a.flags ?? [])],
    tags: [...(src?.tags ?? [])],
    routing: src?.routing ?? (kind === "community" ? "home-only" : "normal"),
    routeTo: src?.routeTo ?? null,
    leadEligible: src?.leadEligible ?? !secondary,
    countsForCoverage: src?.countsForCoverage ?? !secondary,
    attribution: src?.attribution ?? "source",
  };
}

function standInScore(lead: NormalizedItem, publishers: number, ageHours: number): ScoredStory["parts"] {
  return {
    tier: TIER_POINTS[lead.tier] ?? 20,
    recency: 100 * Math.pow(0.5, ageHours / PIPELINE.recencyHalfLifeHours),
    importance: 0,
    coverage: publishers > 1 ? 30 * Math.log2(publishers) : 0,
    hn: 0,
  };
}

/**
 * One ScoredStory per story lead of the edition (every section row and every TOP STORY, each once),
 * sorted by score descending like the real score stage. Cluster members become the story's items.
 */
export function storiesFromEdition(edition: Edition, registry: Registry, opts: FromEditionOptions): ScoredStory[] {
  const sources = indexSources(registry.sources);
  const hostToPublisher = new Map<string, string>();
  for (const p of registry.publishers) for (const h of p.hosts) hostToPublisher.set(h, p.id);

  const leads: ArticleId[] = [];
  const seen = new Set<ArticleId>();
  const add = (id: ArticleId): void => {
    if (!seen.has(id) && edition.articles[id]) {
      seen.add(id);
      leads.push(id);
    }
  };
  for (const s of edition.sections) for (const id of s.rows) add(id);
  for (const id of edition.top) add(id);

  const out: ScoredStory[] = [];
  for (const leadId of leads) {
    const memberIds = (edition.clusters[leadId]?.members ?? []).filter((m) => edition.articles[m]);
    const items = [leadId, ...memberIds].map((id) => toItem(edition, edition.articles[id], sources, hostToPublisher));
    const lead = items[0];
    const publishers: string[] = [];
    for (const i of items) if (i.countsForCoverage && !publishers.includes(i.publisher)) publishers.push(i.publisher);
    const ageHours = Math.max(0, (opts.nowMs - (parseMs(lead.effectiveAt) ?? opts.nowMs)) / HOUR_MS);
    const parts = standInScore(lead, publishers.length, ageHours);
    const w: Weight = edition.articles[leadId].w ?? 1;
    out.push({
      lead: leadId,
      members: memberIds,
      publishers,
      items,
      score: parts.tier + parts.recency + parts.importance + parts.coverage + parts.hn,
      effectiveAt: lead.effectiveAt,
      ageHours,
      parts,
      w,
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.lead < b.lead ? -1 : 1));
}
