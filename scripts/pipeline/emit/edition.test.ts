import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS } from "../../../shared/sections";
import { mergeEdition, publisherName, storyOf, weightOf } from "../../../shared/select";
import { hoursAgo, makeScoredStory } from "../../../test/helpers/factories";
import { assertValidBundle, bundleProblems } from "../../../test/helpers/invariants";
import { createTestContext, emptyState } from "../context";
import type { EmitBundle } from "../types";
import { buildEdition, emit, sanitizePlacements } from "./edition";
import { healthFor, itemOf, makePlacements, sample, sampleInput } from "./testkit.test";

const emitSample = (): { bundle: EmitBundle; s: ReturnType<typeof sample>; ctx: ReturnType<typeof createTestContext> } => {
  const ctx = createTestContext();
  const s = sample();
  return { bundle: emit(sampleInput(ctx, s), ctx), s, ctx };
};

describe("emit: edition", () => {
  it("emits a bundle that passes every guard and invariant", () => {
    const { bundle } = emitSample();
    assertValidBundle(bundle, "sample bundle");
  });

  it("stamps one buildId and generatedAt on every file", () => {
    const { bundle, ctx } = emitSample();
    const files = [bundle.front, bundle.rest, bundle.river, bundle.health, bundle.sources, bundle.brief, bundle.stocks, bundle.status];
    for (const f of files) {
      assert.equal(f.buildId, ctx.buildId);
      assert.equal(f.generatedAt, ctx.now.toISOString());
    }
  });

  it("lists all 15 sections in order, with front rows a prefix of rest rows and derived counts", () => {
    const { bundle, s } = emitSample();
    const { front, rest } = bundle;
    assert.deepEqual(front.sections.map((x) => x.id), SECTIONS.map((x) => x.id));
    assert.deepEqual(rest.sections.map((x) => x.id), SECTIONS.map((x) => x.id));
    for (const sec of front.sections) {
      const full = rest.sections.find((x) => x.id === sec.id)?.rows ?? [];
      assert.deepEqual(full.slice(0, sec.rows.length), sec.rows);
      assert.equal(sec.total, full.length);
    }
    assert.equal(front.counts.stories, 8, "the IPO story sits in two sections but is one story; the unplaced story is not counted");
    assert.equal(front.counts.placements, 9);
    assert.equal(front.counts.feedsTotal, 11, "the paused source is not a feed");
    assert.equal(front.counts.feedsOk, 11);
    assert.equal(front.leadId, s.story.ipo.lead);
    assert.deepEqual(front.top, [s.story.ipo.lead, s.story.launch.lead]);
    const industry = front.sections.find((x) => x.id === "industry");
    assert.equal(industry?.sourceCount, 2);
    assert.ok(!front.articles[s.story.unplaced.lead] && !rest.articles[s.story.unplaced.lead], "unplaced stories are river-only");
  });

  it("splits front and rest with disjoint keys when a section overflows its homepage rows", () => {
    const ctx = createTestContext();
    const s = sample();
    const extra = Array.from({ length: 20 }, (_, i) => makeScoredStory([itemOf(s.registry, "the-verge-ai", { url: `https://www.theverge.com/extra-${i}`, title: `Extra story ${i}`, publishedAt: hoursAgo(30 + i) })]));
    const clustered = makeScoredStory([
      itemOf(s.registry, "reuters-ai", { url: "https://www.reuters.com/tail-story", title: "A tail story", publishedAt: hoursAgo(70) }),
      itemOf(s.registry, "techcrunch-ai", { url: "https://techcrunch.com/tail-story", title: "A tail story, again", publishedAt: hoursAgo(69) }),
    ]);
    const placements = makePlacements({
      stories: [...Object.values(s.placements.stories), ...extra, clustered],
      rows: { industry: [s.story.ipo.lead, ...extra.map((e) => e.lead), clustered.lead], models: [s.story.launch.lead] },
      top: [s.story.ipo.lead],
    });
    const bundle = emit({ ...sampleInput(ctx, s), placements }, ctx);
    assertValidBundle(bundle);
    const industry = bundle.front.sections.find((x) => x.id === "industry");
    assert.equal(industry?.rows.length, 12);
    assert.equal(industry?.total, 22);
    assert.ok(bundle.rest.articles[clustered.lead], "tail story lives in rest.json");
    assert.deepEqual(bundle.rest.clusters[clustered.lead], { members: [clustered.members[0]], publishers: 2 });
    assert.ok(bundle.rest.articles[clustered.members[0]]);
    for (const id of Object.keys(bundle.rest.articles)) assert.ok(!bundle.front.articles[id], `${id} is in both files`);
    for (const id of Object.keys(bundle.rest.sources)) assert.ok(!bundle.front.sources[id], `source ${id} is in both files`);
  });

  it("maps items to ArticleV2: w, flags, via, pub for link-host items, summary only when present", () => {
    const { bundle, s } = emitSample();
    const e = mergeEdition(bundle.front, bundle.rest);
    const lead = e.articles[s.story.ipo.lead];
    assert.equal(lead.w, 2);
    assert.deepEqual(lead.via, ["google-news-ai"]);
    assert.equal(lead.summary, "Shares rose on the first day of trading.");
    assert.equal(lead.pub, undefined, "source-attributed items carry no pub");

    const bloomberg = e.articles[s.item.bloomberg.id];
    assert.equal(bloomberg.pub, "Bloomberg");
    assert.equal(publisherName(e, bloomberg), "Bloomberg");
    assert.equal(bloomberg.w, undefined, "weight 1 is omitted on the wire");
    assert.ok(!("summary" in bloomberg));
    assert.ok(!("via" in bloomberg));

    const hn = e.articles[s.item.hn.id];
    assert.equal(weightOf(hn), 0, "tier-4 members are de-emphasised");
    assert.deepEqual(hn.flags, ["discussion"]);

    const release = e.articles[s.story.release.lead];
    assert.deepEqual(release.flags, ["release"]);
    assert.equal(release.home, "releases");

    const story = storyOf(e, s.story.ipo.lead);
    assert.equal(story?.publishers, 4, "publishers counts publishers, not members (the HN thread does not count)");
    assert.equal(story?.members.length, 4);
    assert.ok(!e.clusters[s.story.paper.lead], "singletons have no cluster");

    assert.deepEqual(e.sources["google-news-ai"], { name: "Google News: AI", publisher: "Google News", kind: "query" });
    assert.equal(e.articles[s.story.launch.lead].tier, 1);
  });

  it("keeps publishedAt null and firstSeenAt for undated items", () => {
    const { bundle } = emitSample();
    const claude = Object.values(bundle.front.articles).find((a) => a.src === "anthropic-news");
    assert.equal(claude?.publishedAt, null);
    assert.equal(claude?.firstSeenAt, hoursAgo(3));
  });

  it("moves the stable lead to top[0] so leadId === top[0]", () => {
    const ctx = createTestContext();
    const s = sample();
    const placements = { ...s.placements, leadId: s.story.launch.lead };
    const bundle = emit({ ...sampleInput(ctx, s), placements }, ctx);
    assert.equal(bundle.front.leadId, s.story.launch.lead);
    assert.deepEqual(bundle.front.top, [s.story.launch.lead, s.story.ipo.lead]);
    assertValidBundle(bundle);
  });

  it("drops rows that would break the contract instead of publishing an invalid edition", () => {
    const ctx = createTestContext();
    const s = sample();
    // makeNormalized canonicalises its url, so the bad scheme is set afterwards.
    const ftp = makeScoredStory([{ ...itemOf(s.registry, "reuters-ai", { title: "Not a web link" }), url: "ftp://example.com/file" }]);
    const orphan = makeScoredStory([itemOf(s.registry, "reuters-ai", { url: "https://example.org/orphan", title: "Unknown source", sourceId: "not-in-registry" })]);
    const placements = makePlacements({
      stories: [...Object.values(s.placements.stories), ftp, orphan],
      rows: {
        // research is a source-mode section: the IPO story (home industry) may not be routed in.
        research: [s.story.paper.lead, s.story.ipo.lead],
        industry: [s.story.ipo.lead, s.story.ipo.lead, "nosuchid", s.item.bloomberg.id, ftp.lead, orphan.lead],
        policy: [s.story.ipo.lead],
        // a third section for the same story (policy comes first in homepage order): home + ONE routed section only.
        money: [s.story.ipo.lead],
        releases: [s.story.release.lead],
      },
      // release and unknown ids can never be TOP STORIES; cyber is the owner desk.
      top: [s.story.release.lead, "nosuchid", s.story.cyber.lead, s.story.ipo.lead],
      leadId: s.story.release.lead,
    });
    const bundle = emit({ ...sampleInput(ctx, s), placements }, ctx);
    assert.deepEqual(bundleProblems(bundle), []);
    const rows = (id: string): string[] => bundle.rest.sections.find((x) => x.id === id)?.rows ?? [];
    assert.deepEqual(rows("research"), [s.story.paper.lead]);
    assert.deepEqual(rows("industry"), [s.story.ipo.lead]);
    assert.deepEqual(rows("policy"), [s.story.ipo.lead]);
    assert.deepEqual(rows("money"), []);
    assert.deepEqual(bundle.front.top, [s.story.ipo.lead]);
    assert.equal(bundle.front.leadId, s.story.ipo.lead);
    const warnings = ctx.logs.filter((l) => l.level === "warn").map((l) => l.msg);
    assert.ok(warnings.some((w) => /source-mode section cannot hold/.test(w)));
    assert.ok(warnings.some((w) => /nosuchid is not a publishable story lead/.test(w)));
    assert.ok(warnings.some((w) => /release \/ community/.test(w)));
    assert.ok(warnings.some((w) => /not an ai-desk story/.test(w)));
    assert.ok(warnings.some((w) => /home \+ at most one routed section/.test(w)));
    assert.ok(!bundle.river.rows.some((r) => r[0] === ftp.lead || r[0] === orphan.lead), "unpublishable items are not in the river either");
  });

  it("caps rows at allRows / homeRows and TOP STORIES at 12", () => {
    const s = sample();
    const many = Array.from({ length: 30 }, (_, i) => makeScoredStory([itemOf(s.registry, "arxiv-cs-ai", { url: `https://arxiv.org/abs/2611.${1000 + i}`, title: `Paper ${i}` })]));
    const tops = Array.from({ length: 15 }, (_, i) => makeScoredStory([itemOf(s.registry, "reuters-ai", { url: `https://www.reuters.com/top-${i}`, title: `Top ${i}` })]));
    const placements = makePlacements({
      stories: [...many, ...tops],
      rows: { research: many.map((m) => m.lead), industry: tops.map((t) => t.lead) },
      top: tops.map((t) => t.lead),
      homeCount: { research: 99 },
    });
    const clean = sanitizePlacements(placements, new Set(s.registry.sources.map((x) => x.id)));
    const research = clean.sections.find((x) => x.def.id === "research");
    assert.equal(research?.rows.length, 25);
    assert.equal(research?.homeCount, 10);
    assert.equal(clean.top.length, 12);
  });

  it("clamps a cluster's publisher count into 1..members+1 and never emits an empty edition as invalid", () => {
    const ctx = createTestContext();
    const s = sample();
    const releaseOnly = makeScoredStory([
      itemOf(s.registry, "gh-llama-cpp", { url: "https://github.com/ggml-org/llama.cpp/releases/tag/b1", title: "llama.cpp b1 released" }),
      itemOf(s.registry, "hn-front", { url: "https://news.ycombinator.com/item?id=1", title: "llama.cpp b1" }),
    ]);
    assert.equal(releaseOnly.publishers.length, 0);
    const { front } = buildEdition(makePlacements({ stories: [releaseOnly], rows: { releases: [releaseOnly.lead] } }), s.registry, { ok: 1, total: 1 }, ctx);
    assert.equal(front.clusters[releaseOnly.lead].publishers, 1);

    const empty = emit({ ...sampleInput(ctx, s), placements: makePlacements({ stories: [], rows: {} }) }, ctx);
    assert.deepEqual(bundleProblems(empty), []);
    assert.equal(empty.front.leadId, null);
    assert.equal(empty.status.gate.passed, false, "a blank edition is valid JSON but fails the content rules");
  });

  it("is pure: same input and clock give identical output, and the input is not mutated", () => {
    const ctx = createTestContext({ state: emptyState() });
    const s = sample();
    const input = sampleInput(ctx, s);
    const before = JSON.stringify(input);
    const a = emit(input, ctx);
    const b = emit(input, ctx);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(JSON.stringify(input), before);
  });

  it("reports feed totals from health, including failing feeds", () => {
    const ctx = createTestContext();
    const s = sample();
    const bundle = emit({ ...sampleInput(ctx, s), health: healthFor(s.registry, { krebs: 3, "hn-front": { status: "carried", count: 4, failStreak: 1 } }) }, ctx);
    assert.equal(bundle.front.counts.feedsOk, 9);
    assert.equal(bundle.front.counts.feedsTotal, 11);
    assertValidBundle(bundle);
  });
});
