// Shared builders for the emit tests, the gate tests (scripts/tools) and test/contract.test.ts:
// a small but realistic registry + placements + health, built with the WP0 factories.
// It is a *.test.ts file because only test files may import test/helpers (test/boundaries.test.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleId, BriefFile, StocksFile } from "../../../shared/contract";
import { SECTIONS, sectionById, type SectionId } from "../../../shared/sections";
import { FIXTURE_NOW_MS, hoursAgo, makeNormalized, makeRegistry, makeScoredStory, makeSource } from "../../../test/helpers/factories";
import { activeSources, resolveSource } from "../../registry/defaults";
import type { SourceDef } from "../../registry/types";
import { createTestContext, type TestContext } from "../context";
import type { EmitInput, FeedHealth, NormalizedItem, Placements, Registry, ScoredStory } from "../types";
import { editionMeta } from "./common";

export const SAMPLE_SOURCES: readonly SourceDef[] = [
  makeSource({ id: "openai-news", name: "OpenAI News", publisher: "openai", home: "models", tier: 1, tags: ["lab", "first-party"], homepage: "https://openai.com/news/" }),
  makeSource({ id: "anthropic-news", name: "Anthropic News", publisher: "anthropic", home: "models", tier: 1, kind: "scrape", url: "https://www.anthropic.com/news", scrape: { base: "https://www.anthropic.com", linkPattern: "/news/[a-z0-9-]+" } }),
  makeSource({ id: "techcrunch-ai", name: "TechCrunch AI", publisher: "techcrunch", home: "industry", tier: 2, aliases: ["TechCrunch"] }),
  makeSource({ id: "the-verge-ai", name: "The Verge AI", publisher: "the-verge", home: "industry", tier: 2 }),
  makeSource({ id: "reuters-ai", name: "Reuters AI", publisher: "reuters", home: "industry", tier: 2 }),
  makeSource({ id: "google-news-ai", name: "Google News: AI", publisher: "google-news", home: "industry", tier: 3, kind: "query" }),
  makeSource({ id: "hn-front", name: "Hacker News", publisher: "hacker-news", home: "industry", tier: 4, kind: "community" }),
  makeSource({ id: "arxiv-cs-ai", name: "arXiv cs.AI", publisher: "arxiv", home: "research", tier: 3, kind: "papers" }),
  makeSource({ id: "krebs", name: "Krebs on Security", publisher: "krebs", home: "cyber", tier: 2, scope: "general" }),
  makeSource({ id: "simon-willison", name: "Simon Willison", publisher: "simon-willison", home: "analysis", tier: 2, kind: "newsletter" }),
  makeSource({ id: "gh-llama-cpp", name: "ggml-org/llama.cpp", publisher: "github:ggml-org/llama.cpp", home: "releases", tier: 1, kind: "github-release", url: "https://github.com/ggml-org/llama.cpp/releases.atom" }),
  makeSource({ id: "paused-blog", name: "Paused Blog", publisher: "paused", home: "analysis", tier: 3, status: "paused", note: "dead since 2026-09" }),
];

export function sampleRegistry(): Registry {
  return makeRegistry(SAMPLE_SOURCES, [
    { id: "openai", name: "OpenAI", hosts: ["openai.com"] },
    { id: "techcrunch", name: "TechCrunch", hosts: ["techcrunch.com"] },
    { id: "the-verge", name: "The Verge", hosts: ["theverge.com"] },
    { id: "reuters", name: "Reuters", hosts: ["reuters.com"] },
    { id: "google-news", name: "Google News", hosts: ["news.google.com"] },
  ]);
}

/** A NormalizedItem of a registry source, with the source policy denormalised like normalize does. */
export function itemOf(registry: Registry, sourceId: string, overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  const def = registry.sources.find((s) => s.id === sourceId);
  if (!def) throw new Error(`testkit: unknown source ${sourceId}`);
  const src = resolveSource(def);
  const publisherName = registry.publishers.find((p) => p.id === src.publisher)?.name ?? src.name;
  const flags: NormalizedItem["flags"] = src.kind === "github-release" ? ["release"] : src.kind === "papers" ? ["paper"] : src.kind === "community" ? ["discussion"] : [];
  return makeNormalized({
    sourceId,
    sourceName: src.name,
    publisher: src.publisher,
    publisherName,
    kind: src.kind,
    scope: src.scope,
    home: src.home,
    tier: src.tier,
    tags: src.tags,
    routing: src.routing,
    routeTo: src.routeTo,
    leadEligible: src.leadEligible,
    countsForCoverage: src.countsForCoverage,
    attribution: src.attribution,
    flags,
    ...overrides,
  });
}

export interface PlacementSpec {
  stories: readonly ScoredStory[];
  /** Full ranked rows per section; sections not listed are empty. */
  rows: Partial<Record<SectionId, readonly ArticleId[]>>;
  top?: readonly ArticleId[];
  leadId?: ArticleId | null;
  homeCount?: Partial<Record<SectionId, number>>;
}

/** Placements as route would hand them over: every section once, primary for every story. */
export function makePlacements(spec: PlacementSpec): Placements {
  const stories: Placements["stories"] = {};
  for (const s of spec.stories) stories[s.lead] = s;
  const sections = SECTIONS.map((def) => {
    const rows = [...(spec.rows[def.id] ?? [])];
    return { id: def.id, rows, homeCount: spec.homeCount?.[def.id] ?? Math.min(rows.length, def.homeRows) };
  });
  const primary: Placements["primary"] = {};
  for (const s of spec.stories) primary[s.lead] = sections.find((sec) => sec.rows.includes(s.lead))?.id ?? s.items[0].home;
  const top = [...(spec.top ?? [])];
  return { stories, sections, top, leadId: spec.leadId === undefined ? (top[0] ?? null) : spec.leadId, primary };
}

export interface Sample {
  registry: Registry;
  placements: Placements;
  /** Named stories for assertions. */
  story: { ipo: ScoredStory; launch: ScoredStory; release: ScoredStory; paper: ScoredStory; cyber: ScoredStory; essay: ScoredStory; unplaced: ScoredStory };
  item: { bloomberg: NormalizedItem; hn: NormalizedItem };
}

/**
 * Nine stories over twelve sources: a 4-publisher IPO story (lead Reuters; members TechCrunch, The
 * Verge, a Google News item whose outlet is Bloomberg, and an HN thread that does not count), a
 * tier-1 launch covered by two publishers, section singles, a release, and one unplaced story.
 */
export function sample(): Sample {
  const registry = sampleRegistry();
  const mk = (source: string, o: Partial<NormalizedItem>): NormalizedItem => itemOf(registry, source, o);
  const bloomberg = mk("google-news-ai", {
    url: "https://www.bloomberg.com/news/anthropic-ipo",
    title: "Anthropic prices record IPO",
    publisher: "bloomberg.com",
    publisherName: "Bloomberg",
    publishedAt: hoursAgo(5),
  });
  const hn = mk("hn-front", { url: "https://www.reuters.com/anthropic-ipo-explainer", title: "Anthropic IPO megathread", publishedAt: hoursAgo(4.5) });
  const ipo = makeScoredStory(
    [
      mk("reuters-ai", { url: "https://www.reuters.com/anthropic-ipo", title: "Anthropic valued at $2tn as shares begin trading", summary: "Shares rose on the first day of trading.", publishedAt: hoursAgo(6), via: ["google-news-ai"] }),
      mk("techcrunch-ai", { url: "https://techcrunch.com/anthropic-ipo", title: "Anthropic's IPO is the largest in history", publishedAt: hoursAgo(5.5) }),
      mk("the-verge-ai", { url: "https://www.theverge.com/anthropic-ipo", title: "Anthropic goes public", publishedAt: hoursAgo(5.2) }),
      bloomberg,
      hn,
    ],
    { score: 95, w: 2 },
  );
  const launch = makeScoredStory(
    [
      mk("openai-news", { url: "https://openai.com/news/gpt-6", title: "Introducing GPT-6", summary: "Our most capable model.", publishedAt: hoursAgo(10) }),
      mk("techcrunch-ai", { url: "https://techcrunch.com/gpt-6", title: "OpenAI launches GPT-6", publishedAt: hoursAgo(9) }),
    ],
    { score: 90, w: 2 },
  );
  const single = (source: string, o: Partial<NormalizedItem>, score: number): ScoredStory => makeScoredStory([mk(source, o)], { score });
  const claude = single("anthropic-news", { url: "https://www.anthropic.com/news/claude-update", title: "Claude gets a memory upgrade", publishedAt: null, firstSeenAt: hoursAgo(3) }, 70);
  const verge = single("the-verge-ai", { url: "https://www.theverge.com/ai-pin", title: "The AI pin is back", publishedAt: hoursAgo(20) }, 55);
  const paper = single("arxiv-cs-ai", { url: "https://arxiv.org/abs/2611.01234", title: "Scaling laws for agents", publishedAt: hoursAgo(30) }, 40);
  const cyber = single("krebs", { url: "https://krebsonsecurity.com/2026/11/breach", title: "Breach exposes 265,000 riders", publishedAt: hoursAgo(12) }, 50);
  const essay = single("simon-willison", { url: "https://simonwillison.net/2026/Nov/19/agents/", title: "Notes on agents", publishedAt: hoursAgo(8) }, 45);
  const release = single("gh-llama-cpp", { url: "https://github.com/ggml-org/llama.cpp/releases/tag/b12549", title: "llama.cpp b12549 released", synthesizedTitle: true, publishedAt: hoursAgo(2) }, 30);
  const unplaced = single("techcrunch-ai", { url: "https://techcrunch.com/old-news", title: "A story that missed every cap", publishedAt: hoursAgo(60) }, 5);

  const placements = makePlacements({
    stories: [ipo, launch, claude, verge, paper, cyber, essay, release, unplaced],
    rows: {
      models: [launch.lead, claude.lead],
      industry: [ipo.lead, verge.lead],
      money: [ipo.lead],
      research: [paper.lead],
      cyber: [cyber.lead],
      analysis: [essay.lead],
      releases: [release.lead],
    },
    top: [ipo.lead, launch.lead],
  });
  return { registry, placements, story: { ipo, launch, release, paper, cyber, essay, unplaced }, item: { bloomberg, hn } };
}

/** One FeedHealth per active source: all ok unless listed in `failing` (id -> failStreak). */
export function healthFor(registry: Registry, failing: Record<string, number | Partial<FeedHealth>> = {}, nowMs: number = FIXTURE_NOW_MS): FeedHealth[] {
  const now = new Date(nowMs).toISOString();
  return activeSources(registry.sources).map((s): FeedHealth => {
    const f = failing[s.id];
    if (f === undefined) return { sourceId: s.id, ok: true, status: "ok", count: 10, ms: 120, failStreak: 0, lastOkAt: now };
    const base: FeedHealth = { sourceId: s.id, ok: false, status: "failing", count: 0, ms: 8000, error: "http", detail: "HTTP 403", httpStatus: 403, failStreak: 1, lastOkAt: null };
    return typeof f === "number" ? { ...base, failStreak: f } : { ...base, ...f };
  });
}

export function sampleBrief(ctx: TestContext): BriefFile {
  return { ...editionMeta(ctx), source: "fallback", headline: "Anthropic valued at $2tn as shares begin trading", bullets: ["Anthropic valued at $2tn as shares begin trading — 4 outlets"], cited: [] };
}

export function sampleStocks(ctx: TestContext): StocksFile {
  const fetchedAt = ctx.now.toISOString();
  return { ...editionMeta(ctx), asOf: hoursAgo(1), marketState: "open", order: ["NVDA", "MSFT"], quotes: { NVDA: { price: 147.25, changePct: -2.46, fetchedAt }, MSFT: { price: null, changePct: null, fetchedAt } } };
}

/** A complete EmitInput for the sample (all feeds ok). */
export function sampleInput(ctx: TestContext = createTestContext(), s: Sample = sample()): EmitInput {
  return { placements: s.placements, health: healthFor(s.registry), registry: s.registry, brief: sampleBrief(ctx), stocks: sampleStocks(ctx) };
}

describe("emit testkit", () => {
  it("builds placements that list every section once and a primary for every story", () => {
    const s = sample();
    assert.deepEqual(s.placements.sections.map((x) => x.id), SECTIONS.map((x) => x.id));
    assert.equal(Object.keys(s.placements.primary).length, Object.keys(s.placements.stories).length);
    assert.equal(s.placements.primary[s.story.unplaced.lead], "industry");
    assert.equal(sectionById("money").mode, "topic");
    assert.equal(s.story.ipo.publishers.length, 4);
  });
});
