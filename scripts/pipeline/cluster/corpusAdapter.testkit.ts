// TEST SUPPORT ONLY - never imported by the pipeline.
//
// The cluster tests run on the real 2026-11-19 corpus, which is a list of RawItems. Turning them
// into NormalizedItems is the normalize stage's job (WP3), and a stage directory may not import a
// sibling stage, so this is a deliberately small stand-in: canonical URL + id, same-URL twins
// folded into via[], source policy denormalised through resolveSource, link-host publishers,
// parsed dates, one release line per repo, the source's maxAgeDays, and (optionally) the
// per-source cap. It does NOT clean titles or apply the AI-relevance gate, so the corpus it
// yields is noisier than what the real pipeline hands to cluster() - a harder test, not an easier one.
//
// It takes the records and the registry as arguments (no test/ import) so it stays inside the
// import boundaries; the *.test.ts files load the fixtures and pass them in.

import type { ArticleFlag, PublisherId, SourceId } from "../../../shared/contract";
import { hashId } from "../../../shared/ids";
import { DAY_MS, HOUR_MS } from "../../../shared/time";
import { canonicalUrl, registrableHost } from "../../../shared/url";
import { resolveSource } from "../../registry/defaults";
import type { ResolvedSource } from "../../registry/types";
import { PIPELINE } from "../context";
import type { NormalizedItem, RawItem, Registry } from "../types";

/** Structural shape of test/helpers/fixtures.ts CorpusRecord (only the fields used here). */
export interface CorpusLikeRecord extends RawItem {
  v1?: { publishedAt: string | null };
}

export interface AdaptOptions {
  /** Per-source cap applied last, newest first (the relevance stage's default is PIPELINE.sourceCap). Default: no cap. */
  sourceCap?: number;
}

function flagsFor(src: ResolvedSource): ArticleFlag[] {
  const flags: ArticleFlag[] = [];
  if (src.kind === "github-release") flags.push("release");
  if (src.kind === "papers") flags.push("paper");
  if (src.kind === "community") flags.push("discussion");
  if (src.tags.includes("paywalled")) flags.push("paywall");
  return flags;
}

function parseDate(rec: CorpusLikeRecord, nowMs: number): string | null {
  const raw = rec.v1?.publishedAt ?? rec.publishedRaw;
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t > nowMs + PIPELINE.maxFutureHours * HOUR_MS) return null;
  return new Date(t).toISOString();
}

/** RawItem[] -> NormalizedItem[] the way the pipeline would hand them to cluster(), minus title cleaning and the relevance gate. */
export function adaptCorpus(records: readonly CorpusLikeRecord[], registry: Registry, now: Date, opts: AdaptOptions = {}): NormalizedItem[] {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const sources = new Map<SourceId, ResolvedSource>(registry.sources.map((s) => [s.id, resolveSource(s)]));
  const order = new Map<SourceId, number>(registry.sources.map((s, i) => [s.id, i]));
  const publisherNames = new Map<PublisherId, string>(registry.publishers.map((p) => [p.id, p.name]));
  const hostOwner = new Map<string, PublisherId>();
  for (const p of registry.publishers) for (const h of p.hosts) hostOwner.set(h, p.id);

  const byId = new Map<string, NormalizedItem>();
  for (const rec of records) {
    const src = sources.get(rec.sourceId);
    const url = canonicalUrl(rec.link);
    const title = rec.title.trim();
    if (!src || !url || !title) continue;
    const id = hashId(url);
    const twin = byId.get(id);
    if (twin) {
      // Same canonical URL from another source: keep the better-placed source, fold the other into via[].
      const twinSrc = sources.get(twin.sourceId);
      const better = twinSrc && (src.tier < twinSrc.tier || (src.tier === twinSrc.tier && (order.get(src.id) ?? 0) < (order.get(twinSrc.id) ?? 0)));
      if (twin.sourceId === src.id) continue;
      if (!better) {
        if (!twin.via.includes(src.id)) twin.via.push(src.id);
        continue;
      }
    }
    let publisher: PublisherId = src.publisher;
    let publisherName = publisherNames.get(src.publisher) ?? src.name;
    if (src.attribution === "link-host") {
      const host = registrableHost(url) ?? src.publisher;
      publisher = hostOwner.get(host) ?? host;
      publisherName = publisherNames.get(publisher) ?? host;
    }
    const publishedAt = parseDate(rec, nowMs);
    const item: NormalizedItem = {
      id,
      url,
      title,
      summary: rec.summaryHtml?.trim() || null,
      sourceId: src.id,
      sourceName: src.name,
      via: twin ? [twin.sourceId, ...twin.via.filter((v) => v !== src.id)] : [],
      publisher,
      publisherName,
      kind: src.kind,
      scope: src.scope,
      home: src.home,
      tier: src.tier,
      publishedAt,
      firstSeenAt: nowIso,
      effectiveAt: publishedAt ?? nowIso,
      flags: flagsFor(src),
      tags: src.tags,
      routing: src.routing,
      routeTo: src.routeTo,
      leadEligible: src.leadEligible,
      countsForCoverage: src.countsForCoverage,
      attribution: src.attribution,
    };
    if (src.kind === "github-release") item.synthesizedTitle = true;
    byId.set(id, item);
  }

  const newestFirst = [...byId.values()].sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || (a.id < b.id ? -1 : 1));
  const perSource = new Map<SourceId, number>();
  const out: NormalizedItem[] = [];
  for (const item of newestFirst) {
    const src = sources.get(item.sourceId);
    if (!src) continue;
    if (nowMs - Date.parse(item.effectiveAt) > src.maxAgeDays * DAY_MS) continue;
    const n = perSource.get(item.sourceId) ?? 0;
    if (item.flags.includes("release") && n >= 1) continue; // one line per repo
    if (opts.sourceCap !== undefined && n >= opts.sourceCap) continue;
    perSource.set(item.sourceId, n + 1);
    out.push(item);
  }
  return out;
}
