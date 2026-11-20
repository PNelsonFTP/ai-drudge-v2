// Contract test of the emit stage (WP6): the bundle `emit` produces must pass every structural guard
// (shared/guards.ts) and every cross-file invariant (shared/invariants.ts) - for a hand-built story
// set, for a synthetic edition that overflows every cap, and for the fixture (a frozen live build,
// test/fixtures/v2) pushed back through emit. Reports the wire sizes of the result.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleId, ArticleV2 } from "../shared/contract";
import { isArticleId } from "../shared/ids";
import { SECTIONS, isAiDesk, type SectionId } from "../shared/sections";
import { riverRows } from "../shared/select";
import { slugify } from "../shared/text";
import { HOUR_MS } from "../shared/time";
import { createTestContext, emptyState, type TestContext } from "../scripts/pipeline/context";
import { emit } from "../scripts/pipeline/emit/edition";
import { healthFor, itemOf, makePlacements, sample, sampleBrief, sampleInput, sampleStocks } from "../scripts/pipeline/emit/testkit.test";
import { bundleSizes } from "../scripts/pipeline/emit/write";
import { fallbackBrief } from "../scripts/pipeline/enrich/briefFallback";
import { nextState } from "../scripts/pipeline/state/store";
import type { EmitBundle, EmitInput, FeedHealth, IngestOutput, NormalizedItem, Placements, Registry, ScoredStory } from "../scripts/pipeline/types";
import { indexSources } from "../scripts/registry/defaults";
import { hoursAgo, makeRegistry, makeScoredStory, makeSource } from "./helpers/factories";
import { FRONT_GZIP_WARN_BYTES } from "../scripts/tools/check-data";
import { FIXTURE_GENERATED_AT, fixtureBrief, fixtureEdition, fixtureFront, fixtureHealth, fixtureRest, fixtureRiver, fixtureSources, fixtureStatus, fixtureStocks } from "./helpers/fixtureData";
import { registryOfSourcesFile } from "./helpers/fixtures";
import { assertValidBundle } from "./helpers/invariants";

const ingestOf = (health: readonly FeedHealth[]): IngestOutput => ({ items: [], health: [...health], signals: { hn: { byUrl: new Map() } }, resolvedUrls: {}, lastGood: {} });
const allItems = (p: Placements): NormalizedItem[] => Object.values(p.stories).flatMap((s) => s.items);
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

function sizeTable(bundle: EmitBundle): string {
  return bundleSizes(bundle)
    .map((s) => `${s.name.padEnd(13)} raw ${kb(s.raw).padStart(9)}  gzip ${kb(s.gzip).padStart(9)}`)
    .join("\n");
}

// ------------------------------------------------------------------------------------------------
// A synthetic edition that overflows every cap
// ------------------------------------------------------------------------------------------------

interface Big {
  registry: Registry;
  placements: Placements;
}

/** Two sources per section; allRows + 6 stories per section (every third one a 3-publisher cluster); topic sections also get routed stories. */
function bigEdition(): Big {
  const sources = SECTIONS.flatMap((def) => [
    makeSource({ id: `${def.id}-wire`, name: `${def.short} Wire`, publisher: `${def.id}-wire`, home: def.id, tier: 2 }),
    makeSource({ id: `${def.id}-daily`, name: `${def.short} Daily`, publisher: `${def.id}-daily`, home: def.id, tier: 3 }),
    makeSource({ id: `${def.id}-forum`, name: `${def.short} Forum`, publisher: `${def.id}-forum`, home: def.id, tier: 4, kind: "community" }),
  ]);
  const registry = makeRegistry(sources);
  const stories: ScoredStory[] = [];
  const rows: Partial<Record<SectionId, ArticleId[]>> = {};
  let n = 0;
  for (const def of SECTIONS) {
    const own: ScoredStory[] = [];
    for (let i = 0; i < def.allRows + 6; i++) {
      n++;
      const mk = (source: string, slug: string): NormalizedItem =>
        itemOf(registry, source, { url: `https://${source}.example.com/${slug}-${n}`, title: `${def.short} story ${i} (${slug})`, summary: `Summary of ${def.label} story ${i}: what happened, who did it, and why it matters to the field.`, publishedAt: hoursAgo(1 + i * 1.5) });
      const items = i % 3 === 0 ? [mk(`${def.id}-wire`, "lead"), mk(`${def.id}-daily`, "second"), mk(`${def.id}-forum`, "thread")] : [mk(i % 2 ? `${def.id}-daily` : `${def.id}-wire`, "single")];
      own.push(makeScoredStory(items, { score: 100 - i, w: items.length > 1 ? 2 : 1 }));
    }
    stories.push(...own);
    rows[def.id] = own.map((s) => s.lead);
  }
  // Route the first three "models" stories into every other TOPIC section would break "home + one";
  // instead each topic section borrows three stories from the section before it (one routed section each).
  SECTIONS.forEach((def, i) => {
    if (def.mode !== "topic" || i === 0) return;
    const donor = SECTIONS[i - 1];
    rows[def.id] = [...(rows[donor.id] ?? []).slice(3, 6), ...(rows[def.id] ?? [])];
  });
  const top = stories.filter((s) => s.publishers.length >= 2 && isAiDesk(s.items[0].home)).slice(0, 20).map((s) => s.lead);
  return { registry, placements: makePlacements({ stories, rows, top }) };
}

// ------------------------------------------------------------------------------------------------
// The fixture, turned back into placements
// ------------------------------------------------------------------------------------------------

interface FromFixture {
  registry: Registry;
  input: EmitInput;
  ctx: TestContext;
}

function fromFixture(): FromFixture {
  // The registry the fixture was built from, read back from its sources.json: the live registry moves on.
  const registry = registryOfSourcesFile(fixtureSources);
  const sources = indexSources(registry.sources);
  const publisherNames = new Map(registry.publishers.map((p) => [p.id, p.name]));
  const edition = fixtureEdition();

  const toItem = (a: Pick<ArticleV2, "id" | "url" | "title" | "src" | "publishedAt" | "firstSeenAt" | "home"> & Partial<ArticleV2>): NormalizedItem => {
    const src = sources.get(a.src);
    if (!src) throw new Error(`fixture article ${a.id} has unknown source ${a.src}`);
    return {
      id: a.id,
      url: a.url,
      title: a.title,
      summary: a.summary ?? null,
      sourceId: a.src,
      sourceName: src.name,
      via: a.via ?? [],
      publisher: a.pub ? slugify(a.pub) : src.publisher,
      publisherName: a.pub ?? publisherNames.get(src.publisher) ?? src.name,
      kind: src.kind,
      scope: src.scope,
      home: a.home,
      tier: a.tier ?? src.tier,
      publishedAt: a.publishedAt,
      firstSeenAt: a.firstSeenAt,
      effectiveAt: a.publishedAt ?? a.firstSeenAt,
      flags: a.flags ?? [],
      tags: src.tags,
      routing: src.routing,
      routeTo: src.routeTo,
      leadEligible: src.leadEligible,
      countsForCoverage: src.countsForCoverage,
      // `pub` is on the wire only for link-host items (the outlet differs from the feed's publisher).
      attribution: a.pub ? "link-host" : "source",
    };
  };

  const stories: Placements["stories"] = {};
  const primary: Placements["primary"] = {};
  const leads = new Set<ArticleId>(edition.top);
  for (const s of edition.sections) for (const id of s.rows) leads.add(id);
  const nowMs = Date.parse(FIXTURE_GENERATED_AT);
  for (const lead of leads) {
    const cluster = edition.clusters[lead];
    const items = [lead, ...(cluster?.members ?? [])].map((id) => toItem(edition.articles[id]));
    const publishers = Array.from({ length: cluster?.publishers ?? 1 }, (_, i) => `publisher-${i}`);
    stories[lead] = makeScoredStory(items, { publishers, w: edition.articles[lead].w ?? 1 }, nowMs);
    primary[lead] = edition.sections.find((s) => s.rows.includes(lead))?.id ?? edition.articles[lead].home;
  }
  // Everything else in the fixture river is a kept item that was not placed: a river-only singleton story.
  for (const r of riverRows(fixtureRiver)) {
    if (edition.articles[r.id]) continue;
    const item = toItem({
      id: r.id,
      url: r.url,
      title: r.title,
      src: r.sourceId,
      publishedAt: r.publishedAtMs === null ? null : new Date(r.publishedAtMs).toISOString(),
      firstSeenAt: new Date(r.firstSeenAtMs).toISOString(),
      home: r.section,
    });
    stories[r.id] = makeScoredStory([item], {}, nowMs);
    primary[r.id] = r.section;
  }
  const placements: Placements = {
    stories,
    sections: edition.sections.map((s) => ({ id: s.id, rows: [...s.rows], homeCount: s.homeCount })),
    top: [...edition.top],
    leadId: edition.leadId,
    primary,
  };
  const health: FeedHealth[] = fixtureHealth.feeds.map((f) => ({ sourceId: f.id, ok: f.ok, status: f.status, count: f.count, ms: 0, failStreak: f.failStreak, lastOkAt: f.lastOkAt, ...(f.lastError ? { detail: f.lastError } : {}) }));
  const ctx = createTestContext({ now: new Date(FIXTURE_GENERATED_AT) });
  return { registry, ctx, input: { placements, health, registry, brief: fixtureBrief, stocks: fixtureStocks } };
}

// ------------------------------------------------------------------------------------------------

describe("contract: bundle emitted from factory-built placements", () => {
  it("passes every guard and invariant (hand-built story set)", () => {
    const ctx = createTestContext();
    const bundle = emit(sampleInput(ctx), ctx);
    assertValidBundle(bundle, "sample");
    for (const id of [...Object.keys(bundle.front.articles), ...Object.keys(bundle.rest.articles)]) assert.ok(isArticleId(id), `${id} is not a hashId`);
  });

  it("passes every guard and invariant when every section overflows its caps", () => {
    const ctx = createTestContext();
    const big = bigEdition();
    const bundle = emit({ placements: big.placements, health: healthFor(big.registry, { "models-forum": 3 }), registry: big.registry, brief: fallbackBrief(big.placements, ctx), stocks: sampleStocks(ctx) }, ctx);
    assertValidBundle(bundle, "big edition");

    for (const def of SECTIONS) {
      const front = bundle.front.sections.find((s) => s.id === def.id);
      const rest = bundle.rest.sections.find((s) => s.id === def.id);
      assert.equal(front?.rows.length, def.homeRows, `${def.id} homepage rows`);
      assert.equal(rest?.rows.length, def.allRows, `${def.id} view-all rows`);
      assert.deepEqual(rest?.rows.slice(0, def.homeRows), front?.rows);
    }
    assert.equal(bundle.front.top.length, 12);
    assert.equal(bundle.front.leadId, bundle.front.top[0]);
    assert.ok(Object.keys(bundle.rest.articles).length > 100);
    assert.ok(Object.keys(bundle.rest.clusters).length > 10);
    assert.equal(bundle.status.gate.passed, true, bundle.status.gate.warnings.join("\n"));
    assert.equal(bundle.brief.source, "fallback");
    assert.ok(bundle.brief.bullets.every((b) => / — \d+ outlets$/.test(b)), "the fallback brief carries publisher counts");
    // Every kept item is in the river: 15 sections x (allRows + 6) stories, a third of them 3-item clusters.
    const items = allItems(big.placements).length;
    assert.equal(bundle.river.rows.length, items);
  });

  it("stays valid across builds: state from one run feeds the next, and feed.xml does not churn", () => {
    const first = createTestContext();
    const s = sample();
    const input = sampleInput(first, s);
    const one = emit(input, first);
    const state = nextState(emptyState(), { ingest: ingestOf(input.health), normalized: allItems(s.placements), placements: s.placements, bundle: one }, first);
    assert.equal(state.recent.length, one.river.rows.length);
    assert.equal(state.lead?.id, one.front.leadId);
    assert.equal(Object.keys(state.firstSeen).length, allItems(s.placements).length);

    // Half an hour later two stories have scrolled out of their feeds; the river still remembers them.
    const second = createTestContext({ now: new Date(first.now.getTime() + 0.5 * HOUR_MS), state });
    const remaining = Object.values(s.placements.stories).filter((st) => st.lead !== s.story.unplaced.lead && st.lead !== s.story.cyber.lead);
    const placements = makePlacements({
      stories: remaining,
      rows: Object.fromEntries(s.placements.sections.map((sec) => [sec.id, sec.rows.filter((id) => id !== s.story.cyber.lead)])),
      top: s.placements.top,
    });
    const two = emit({ ...input, placements, brief: sampleBrief(second), stocks: sampleStocks(second) }, second);
    assertValidBundle(two, "second build");
    assert.notEqual(two.front.buildId, one.front.buildId);
    assert.equal(two.river.rows.length, one.river.rows.length, "items no longer listed by a feed stay in the river");
    assert.ok(two.river.rows.some((r) => r[0] === s.story.unplaced.lead));
    assert.equal(two.atom, one.atom, "same TOP STORIES and section leads -> byte-identical feed.xml");
    assert.equal(two.opml, one.opml);

    const state2 = nextState(state, { ingest: ingestOf(input.health), normalized: allItems(placements), placements, bundle: two }, second);
    assert.deepEqual(state2.lead, state.lead, "the lead did not change, so its `since` is kept");
    assert.equal(state2.firstSeen[s.story.unplaced.lead], state.firstSeen[s.story.unplaced.lead]);
  });
});

describe("contract: bundle emitted from the fixture (a frozen live build)", () => {
  it("passes every guard and invariant and reproduces the fixture's edition", () => {
    const { input, ctx } = fromFixture();
    const bundle = emit(input, ctx);
    assertValidBundle(bundle, "fixture through emit");
    assert.deepEqual(ctx.logs.filter((l) => l.level === "warn"), [], "nothing had to be dropped");

    assert.deepEqual(bundle.front.sections.map((s) => [s.id, s.rows]), fixtureFront.sections.map((s) => [s.id, s.rows]));
    assert.deepEqual(bundle.rest.sections, fixtureRest.sections);
    assert.deepEqual(bundle.front.top, fixtureFront.top);
    assert.equal(bundle.front.leadId, fixtureFront.leadId);
    assert.deepEqual(bundle.front.counts, fixtureFront.counts);
    assert.deepEqual(Object.keys(bundle.front.articles).sort(), Object.keys(fixtureFront.articles).sort());
    assert.deepEqual(Object.keys(bundle.rest.articles).sort(), Object.keys(fixtureRest.articles).sort());
    // Field for field: weights, flags, paywall marks, link-host outlets, same-URL twins, summaries on leads only.
    assert.deepEqual(bundle.front.articles, fixtureFront.articles);
    assert.deepEqual(bundle.rest.articles, fixtureRest.articles);
    assert.deepEqual(bundle.front.clusters, fixtureFront.clusters);
    assert.deepEqual(bundle.rest.clusters, fixtureRest.clusters);
    assert.deepEqual(Object.keys(bundle.front.sources).sort(), Object.keys(fixtureFront.sources).sort());
    assert.equal(bundle.river.rows.length, fixtureRiver.rows.length);
    assert.deepEqual(bundle.front.sources, fixtureFront.sources);
    assert.deepEqual(bundle.health.feeds.map((f) => [f.id, f.status, f.count, f.failStreak]), fixtureHealth.feeds.map((f) => [f.id, f.status, f.count, f.failStreak]));
    assert.deepEqual(bundle.sources.sources.map((s) => s.id), fixtureSources.sources.map((s) => s.id));
    assert.equal(bundle.status.gate.passed, true, bundle.status.gate.warnings.join("\n"));
    assert.deepEqual(bundle.status.content, fixtureStatus.content);
    assert.deepEqual(bundle.status.feeds, fixtureStatus.feeds);
    assert.deepEqual(bundle.status.gate.warnings, fixtureStatus.gate.warnings);
  });

  it("reports wire sizes; front.json stays within the first-paint budget", (t) => {
    const { input, ctx } = fromFixture();
    const bundle = emit(input, ctx);
    t.diagnostic(`emitted bundle sizes (build of ${FIXTURE_GENERATED_AT}, ${bundle.front.counts.stories} stories, ${bundle.river.rows.length} river rows):\n${sizeTable(bundle)}`);
    const size = (name: string): { raw: number; gzip: number } => {
      const s = bundleSizes(bundle).find((x) => x.name === name);
      assert.ok(s, name);
      return s;
    };
    // The gate's first-paint budget (the performance review asked for ~35 KB; a real build with a
    // 30-publisher lead story is about 44 KB; V1 shipped 113 KB gzip before the first headline).
    assert.ok(size("front.json").gzip <= FRONT_GZIP_WARN_BYTES, `front.json is ${kb(size("front.json").gzip)} gzip`);
    assert.ok(size("rest.json").gzip <= 40 * 1024, `rest.json is ${kb(size("rest.json").gzip)} gzip`);
    assert.ok(size("river.json").gzip <= 120 * 1024, `river.json is ${kb(size("river.json").gzip)} gzip`);
    assert.ok(size("feed.xml").raw <= 40 * 1024);
    assert.ok(size("front.json").raw <= JSON.stringify(fixtureFront).length * 1.05, "emit reproduces the size of the build's own front.json");
  });
});
