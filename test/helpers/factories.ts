// Test data builders. PURE (no node:, no DOM) so both pipeline tests and client code/tests can use
// them. Everything is deterministic: ids derive from a counter you can reset with resetFactories().
//
//   makeArticle / makeSourceRef / makeEdition / makeRiver      contract-level (client + emit tests)
//   makeSource / makePublisher / makeRegistry                  registry-level
//   makeItem / makeNormalized / makeStory / makeScoredStory    pipeline-level
//
// Type-only imports from scripts/ are erased at build time, so importing this file from src/ does
// not pull pipeline code into the bundle.

import {
  RIVER_DAYS,
  SCHEMA_VERSION,
  type ArticleId,
  type ArticleV2,
  type ClusterV2,
  type EditionFront,
  type EditionMeta,
  type EditionRest,
  type RiverFile,
  type RiverRow,
  type SourceId,
  type SourceRef,
} from "../../shared/contract";
import { hashId } from "../../shared/ids";
import { SECTIONS, sectionById, type SectionId } from "../../shared/sections";
import { mergeEdition, type Edition } from "../../shared/select";
import { HOUR_MS, parseMs } from "../../shared/time";
import { canonicalUrl } from "../../shared/url";
import type { NormalizedItem, RawItem, Registry, ScoredStory, Story } from "../../scripts/pipeline/types";
import type { PublisherDef, SourceDef } from "../../scripts/registry/types";

/** Frozen clock of the 2026-11-19 fixtures (same instant as scripts/pipeline/context.ts TEST_NOW_ISO). */
export const FIXTURE_NOW_ISO = "2026-11-19T21:00:00.000Z";
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

let counter = 0;

/** Reset the id counter (call in beforeEach when a test depends on exact generated ids). */
export function resetFactories(): void {
  counter = 0;
}

function next(): number {
  counter += 1;
  return counter;
}

/** ISO time `hours` before FIXTURE_NOW. */
export function hoursAgo(hours: number, nowMs: number = FIXTURE_NOW_MS): string {
  return new Date(nowMs - hours * HOUR_MS).toISOString();
}

export const FIXTURE_META: EditionMeta = {
  schemaVersion: SCHEMA_VERSION,
  buildId: "2026-11-19T20:30:00.000Z",
  generatedAt: "2026-11-19T20:30:00.000Z",
};

// ------------------------------------------------------------------------------------------------
// Contract level
// ------------------------------------------------------------------------------------------------

/**
 * An ArticleV2. Without overrides: unique url/id, source "example-source", home "industry", tier 3,
 * published n hours before FIXTURE_NOW (n = running counter), first seen at the same time.
 * When you override `url`, the id follows it (hashId(url)) unless you also override `id`.
 */
export function makeArticle(overrides: Partial<ArticleV2> = {}): ArticleV2 {
  const n = next();
  const url = overrides.url ?? `https://example.com/story-${n}`;
  const publishedAt = overrides.publishedAt === undefined ? hoursAgo(n) : overrides.publishedAt;
  return {
    id: hashId(url),
    url,
    title: `Example story ${n}`,
    src: "example-source",
    publishedAt,
    firstSeenAt: publishedAt ?? hoursAgo(n),
    home: "industry",
    tier: 3,
    ...overrides,
  };
}

export function makeSourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return { name: "Example Source", publisher: "Example", kind: "rss", ...overrides };
}

export interface EditionSpec {
  /** Articles to include. Anything referenced by rows/top/clusters must be here. */
  articles: readonly ArticleV2[];
  /**
   * Full ranked rows per section (lead ids). Sections not listed are empty. The first
   * SectionDef.homeRows ids (or `homeRows[section]` when given) form the homepage list.
   * Omit entirely to place every non-member article in its home section, newest first.
   */
  rows?: Partial<Record<SectionId, readonly ArticleId[]>>;
  /** Override the homepage row count of a section. */
  homeRows?: Partial<Record<SectionId, number>>;
  /** lead id -> member ids (publishers defaults to members + 1). */
  clusters?: Record<ArticleId, readonly ArticleId[] | ClusterV2>;
  /** TOP STORIES lead ids (leadId = top[0]). */
  top?: readonly ArticleId[];
  /** Source refs by id; missing ones are generated from the id. */
  sources?: Record<SourceId, SourceRef>;
  meta?: Partial<EditionMeta>;
  feedsOk?: number;
  feedsTotal?: number;
}

export interface BuiltEdition {
  front: EditionFront;
  rest: EditionRest;
  /** mergeEdition(front, rest) - complete. */
  edition: Edition;
  /** mergeEdition(front, null) - homepage rows only. */
  frontOnly: Edition;
}

/**
 * Build a VALID front.json + rest.json pair (it satisfies shared/guards.ts and shared/invariants.ts
 * as long as the spec itself is consistent: rows are story leads, source-mode sections only hold
 * their home articles, a story sits in home + at most one other section).
 */
export function makeEdition(spec: EditionSpec): BuiltEdition {
  const meta: EditionMeta = { ...FIXTURE_META, ...spec.meta };
  const byId = new Map(spec.articles.map((a) => [a.id, a]));
  const clusters: Record<ArticleId, ClusterV2> = {};
  const memberIds = new Set<ArticleId>();
  for (const [lead, c] of Object.entries(spec.clusters ?? {})) {
    const cluster: ClusterV2 = isClusterArray(c) ? { members: [...c], publishers: c.length + 1 } : { members: [...c.members], publishers: c.publishers };
    if (cluster.members.length === 0) continue;
    clusters[lead] = cluster;
    for (const m of cluster.members) memberIds.add(m);
  }

  const full = new Map<SectionId, ArticleId[]>();
  if (spec.rows) {
    for (const def of SECTIONS) full.set(def.id, [...(spec.rows[def.id] ?? [])]);
  } else {
    for (const def of SECTIONS) full.set(def.id, []);
    const leads = spec.articles.filter((a) => !memberIds.has(a.id));
    const sorted = [...leads].sort((a, b) => (parseMs(b.publishedAt ?? b.firstSeenAt) ?? 0) - (parseMs(a.publishedAt ?? a.firstSeenAt) ?? 0));
    for (const a of sorted) {
      const rows = full.get(a.home);
      if (rows && rows.length < sectionById(a.home).allRows) rows.push(a.id);
    }
  }
  const top = [...(spec.top ?? [])];

  const frontIds = new Set<ArticleId>();
  const frontClusters: Record<ArticleId, ClusterV2> = {};
  const need = (lead: ArticleId, ids: Set<ArticleId>, cl: Record<ArticleId, ClusterV2>): void => {
    ids.add(lead);
    const c = clusters[lead];
    if (c) {
      cl[lead] = c;
      for (const m of c.members) ids.add(m);
    }
  };
  const homeCount = (id: SectionId): number => spec.homeRows?.[id] ?? sectionById(id).homeRows;
  for (const def of SECTIONS) for (const id of (full.get(def.id) ?? []).slice(0, homeCount(def.id))) need(id, frontIds, frontClusters);
  for (const id of top) need(id, frontIds, frontClusters);
  const restIds = new Set<ArticleId>();
  const allClusters: Record<ArticleId, ClusterV2> = {};
  for (const def of SECTIONS) for (const id of full.get(def.id) ?? []) need(id, restIds, allClusters);
  const restClusters: Record<ArticleId, ClusterV2> = {};
  for (const [k, c] of Object.entries(allClusters)) if (!frontClusters[k]) restClusters[k] = c;

  const pick = (ids: Iterable<ArticleId>): Record<ArticleId, ArticleV2> => {
    const out: Record<ArticleId, ArticleV2> = {};
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) throw new Error(`makeEdition: article ${id} is referenced but not in spec.articles`);
      out[id] = a;
    }
    return out;
  };
  const frontArticles = pick(frontIds);
  const restArticles = pick([...restIds].filter((id) => !frontIds.has(id)));
  const refs = (articles: Record<ArticleId, ArticleV2>, exclude: Record<SourceId, SourceRef>): Record<SourceId, SourceRef> => {
    const out: Record<SourceId, SourceRef> = {};
    for (const a of Object.values(articles)) {
      for (const sid of [a.src, ...(a.via ?? [])]) {
        if (out[sid] || exclude[sid]) continue;
        out[sid] = spec.sources?.[sid] ?? makeSourceRef({ name: titleCase(sid), publisher: titleCase(sid) });
      }
    }
    return out;
  };
  const frontSources = refs(frontArticles, {});
  const restSources = refs(restArticles, frontSources);

  const placed = new Set<ArticleId>();
  let placements = 0;
  for (const rows of full.values()) {
    placements += rows.length;
    for (const id of rows) placed.add(id);
  }
  const feedsTotal = spec.feedsTotal ?? Math.max(1, Object.keys(frontSources).length + Object.keys(restSources).length);
  const front: EditionFront = {
    ...meta,
    leadId: top[0] ?? null,
    top,
    counts: { stories: placed.size, placements, feedsOk: spec.feedsOk ?? feedsTotal, feedsTotal },
    sections: SECTIONS.map((def) => {
      const rows = full.get(def.id) ?? [];
      return {
        id: def.id,
        label: def.label,
        rows: rows.slice(0, homeCount(def.id)),
        total: rows.length,
        sourceCount: new Set(rows.map((id) => byId.get(id)?.src)).size,
      };
    }),
    articles: frontArticles,
    clusters: frontClusters,
    sources: frontSources,
  };
  const rest: EditionRest = {
    ...meta,
    sections: SECTIONS.map((def) => ({ id: def.id, rows: full.get(def.id) ?? [] })),
    articles: restArticles,
    clusters: restClusters,
    sources: restSources,
  };
  return { front, rest, edition: mergeEdition(front, rest), frontOnly: mergeEdition(front, null) };
}

function isClusterArray(c: readonly ArticleId[] | ClusterV2): c is readonly ArticleId[] {
  return Array.isArray(c);
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A river.json from articles (newest first). `section` defaults to each article's home;
 * `leads` maps member id -> lead id.
 */
export function makeRiver(articles: readonly ArticleV2[], opts: { meta?: Partial<EditionMeta>; leads?: Record<ArticleId, ArticleId>; sources?: Record<SourceId, SourceRef> } = {}): RiverFile {
  const meta: EditionMeta = { ...FIXTURE_META, ...opts.meta };
  const sourceIds: SourceId[] = [];
  const names: string[] = [];
  const idx = (sid: SourceId): number => {
    let i = sourceIds.indexOf(sid);
    if (i < 0) {
      i = sourceIds.length;
      sourceIds.push(sid);
      names.push(opts.sources?.[sid]?.name ?? titleCase(sid));
    }
    return i;
  };
  const rows: RiverRow[] = articles.map((a) => [
    a.id,
    a.title,
    a.url,
    idx(a.src),
    a.home,
    parseMs(a.publishedAt),
    parseMs(a.firstSeenAt) ?? parseMs(meta.generatedAt) ?? 0,
    opts.leads?.[a.id] ?? null,
  ]);
  rows.sort((x, y) => (y[5] ?? y[6]) - (x[5] ?? x[6]) || (x[0] < y[0] ? -1 : 1));
  return { ...meta, days: RIVER_DAYS, sources: names, sourceIds, rows };
}

// ------------------------------------------------------------------------------------------------
// Registry level
// ------------------------------------------------------------------------------------------------

export function makeSource(overrides: Partial<SourceDef> = {}): SourceDef {
  const n = next();
  const id = overrides.id ?? `example-source-${n}`;
  return {
    id,
    name: titleCase(id),
    publisher: id,
    url: `https://${id}.example.com/feed.xml`,
    kind: "rss",
    scope: "ai",
    home: "industry",
    tier: 3,
    ...overrides,
  };
}

export function makePublisher(overrides: Partial<PublisherDef> = {}): PublisherDef {
  const n = next();
  const id = overrides.id ?? `example-${n}`;
  return { id, name: titleCase(id), hosts: [`${id}.example.com`], ...overrides };
}

/** A Registry from sources; publishers are generated for every publisher id that has no definition. */
export function makeRegistry(sources: readonly SourceDef[], publishers: readonly PublisherDef[] = []): Registry {
  const have = new Set(publishers.map((p) => p.id));
  const extra: PublisherDef[] = [];
  for (const s of sources) {
    if (!have.has(s.publisher)) {
      have.add(s.publisher);
      extra.push({ id: s.publisher, name: titleCase(s.publisher), hosts: [] });
    }
  }
  return { sources, publishers: [...publishers, ...extra] };
}

// ------------------------------------------------------------------------------------------------
// Pipeline level
// ------------------------------------------------------------------------------------------------

/** A RawItem as ingest would emit it (absolute http link, raw strings). */
export function makeItem(overrides: Partial<RawItem> = {}): RawItem {
  const n = next();
  return {
    sourceId: "example-source",
    title: `Example item ${n}`,
    link: `https://example.com/item-${n}`,
    publishedRaw: hoursAgo(n),
    summaryHtml: null,
    ...overrides,
  };
}

/**
 * A NormalizedItem with source policy defaults of an ordinary press feed. The id follows the url
 * (hashId(canonicalUrl(url))) unless you override it; effectiveAt follows publishedAt ?? firstSeenAt.
 */
export function makeNormalized(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  const n = next();
  const url = canonicalUrl(overrides.url ?? `https://example.com/item-${n}`) ?? `https://example.com/item-${n}`;
  const publishedAt = overrides.publishedAt === undefined ? hoursAgo(n) : overrides.publishedAt;
  const firstSeenAt = overrides.firstSeenAt ?? publishedAt ?? hoursAgo(n);
  const sourceId = overrides.sourceId ?? "example-source";
  return {
    id: hashId(url),
    title: `Example item ${n}`,
    summary: null,
    sourceName: titleCase(sourceId),
    via: [],
    publisher: "example",
    publisherName: titleCase(overrides.publisher ?? "example"),
    kind: "rss",
    scope: "ai",
    home: "industry",
    tier: 3,
    flags: [],
    tags: [],
    routing: "normal",
    routeTo: null,
    leadEligible: true,
    countsForCoverage: true,
    attribution: "source",
    ...overrides,
    url,
    sourceId,
    publishedAt,
    firstSeenAt,
    effectiveAt: overrides.effectiveAt ?? publishedAt ?? firstSeenAt,
  };
}

/** A Story from items (first item leads). publishers = distinct coverage-counting publishers. */
export function makeStory(items: readonly NormalizedItem[]): Story {
  if (items.length === 0) throw new Error("makeStory: needs at least one item");
  const publishers: string[] = [];
  for (const i of items) if (i.countsForCoverage && !publishers.includes(i.publisher)) publishers.push(i.publisher);
  return { lead: items[0].id, members: items.slice(1).map((i) => i.id), publishers, items: [...items] };
}

/** A ScoredStory with neutral parts; override score / w / parts as needed. */
export function makeScoredStory(items: readonly NormalizedItem[], overrides: Partial<ScoredStory> = {}, nowMs: number = FIXTURE_NOW_MS): ScoredStory {
  const story = makeStory(items);
  const effectiveAt = items[0].effectiveAt;
  const ageHours = Math.max(0, (nowMs - (parseMs(effectiveAt) ?? nowMs)) / HOUR_MS);
  return {
    ...story,
    score: 50,
    effectiveAt,
    ageHours,
    parts: { tier: 0, recency: 0, importance: 0, coverage: 0, hn: 0 },
    w: 1,
    ...overrides,
  };
}
