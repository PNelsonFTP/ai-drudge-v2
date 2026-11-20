import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashId } from "../../../shared/ids";
import { makeItem, makePublisher, makeRegistry, makeSource } from "../../../test/helpers/factories";
import { loadFixtureRegistry, loadRawItems, readFeedFixture } from "../../../test/helpers/fixtures";
import { createTestContext, emptyState, PIPELINE } from "../context";
import type { NormalizedItem, NormalizeOutput, PipelineState, RawItem } from "../types";
import { normalize } from "./index";

const NOW = new Date("2026-11-19T21:00:00.000Z");
const DAY = 86_400_000;
const OK_HEALTH = { failStreak: 0, lastOkAt: "2026-11-19T20:30:00.000Z", lastAttemptAt: "2026-11-19T20:30:00.000Z" };

const stateWith = (patch: Partial<PipelineState>): PipelineState => ({ ...emptyState(), ...patch });
const one = (out: NormalizeOutput): NormalizedItem => {
  assert.equal(out.items.length, 1, JSON.stringify(out.dropped));
  return out.items[0];
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("normalize - a single item", () => {
  const source = makeSource({ id: "example-source", name: "Example Source", publisher: "example", home: "industry", tier: 2, tags: ["press"] });
  const registry = makeRegistry([source], [makePublisher({ id: "example", name: "Example Media", hosts: ["example.com"] })]);

  it("cleans, identifies and dates the item and copies the source policy onto it", () => {
    const raw = makeItem({
      title: "OpenAI&#8217;s <em>new</em> model &amp; what it means | Example Source",
      link: "https://Example.com/story/?utm_source=rss#top",
      publishedRaw: "Thu, 19 Nov 2026 15:30:00 +0100",
      summaryHtml: "<style>.x{color:red}</style><p>The lab shipped a model. The post OpenAI's new model appeared first on Example.</p>",
    });
    const item = one(normalize([raw], registry, createTestContext()));
    assert.deepEqual(item, {
      id: hashId("https://example.com/story"),
      url: "https://example.com/story",
      title: "OpenAI’s new model & what it means",
      summary: null,
      sourceId: "example-source",
      sourceName: "Example Source",
      via: [],
      publisher: "example",
      publisherName: "Example Media",
      kind: "rss",
      scope: "ai",
      home: "industry",
      tier: 2,
      publishedAt: "2026-11-19T14:30:00.000Z",
      firstSeenAt: "2026-11-19T14:30:00.000Z",
      effectiveAt: "2026-11-19T14:30:00.000Z",
      flags: [],
      tags: ["press"],
      routing: "normal",
      routeTo: null,
      leadEligible: true,
      countsForCoverage: true,
      attribution: "source",
    } satisfies NormalizedItem);
  });

  it("keeps a real summary, cleaned", () => {
    const raw = makeItem({ summaryHtml: "<p>Researchers at the lab describe a new training method that halves compute.&nbsp;<a href='x'>Read more</a></p>" });
    assert.equal(one(normalize([raw], registry, createTestContext())).summary, "Researchers at the lab describe a new training method that halves compute.");
  });

  it("flags follow kind and tags", () => {
    const sources = [
      makeSource({ id: "papers", kind: "papers" }),
      makeSource({ id: "forum", kind: "community" }),
      makeSource({ id: "wall", tags: ["paywalled", "press"] }),
      makeSource({ id: "plain" }),
    ];
    const out = normalize(sources.map((s, i) => makeItem({ sourceId: s.id, link: `https://example.com/${i}` })), makeRegistry(sources), createTestContext());
    assert.deepEqual(out.items.map((i) => i.flags), [["paper"], ["discussion"], ["paywall"], []]);
    const forum = out.items[1];
    assert.equal(forum.routing, "home-only");
    assert.equal(forum.leadEligible, false);
    assert.equal(forum.countsForCoverage, false);
  });

  it("an item that links to a Hacker News thread is a discussion, whatever kind of source listed it", () => {
    // What an HN search (kind "json", link-host) lists for a text post: the thread itself.
    const hn = makeSource({ id: "hn-search", kind: "json", attribution: "link-host", tier: 4 });
    const links = ["https://news.ycombinator.com/item?id=45678901", "https://example.com/an-article", "https://news.ycombinator.com/newest", "https://example.com/item?id=5"];
    const out = normalize(links.map((link, i) => makeItem({ sourceId: hn.id, link, title: `Ask HN: local LLM hardware ${i}` })), makeRegistry([hn]), createTestContext());
    assert.deepEqual(out.items.map((i) => i.flags), [["discussion"], [], [], []]);
  });

  it("carried items stay marked", () => {
    assert.equal(one(normalize([makeItem({ carried: true })], registry, createTestContext())).carried, true);
    assert.equal("carried" in one(normalize([makeItem()], registry, createTestContext())), false);
  });

  it("does not mutate its input and is deterministic", () => {
    const raw = [makeItem({ title: "A &amp; B", summaryHtml: "<p>Some text that is long enough to be kept as a summary.</p>" }), makeItem()];
    const snapshot = structuredClone(raw);
    const a = normalize(raw, registry, createTestContext());
    const b = normalize(raw, registry, createTestContext());
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(a, b);
  });

  it("logs one summary line", () => {
    const ctx = createTestContext();
    normalize([makeItem(), makeItem({ link: "/relative" })], registry, ctx);
    assert.deepEqual(ctx.logs, [{ level: "info", msg: "normalize: 2 raw -> 1 items (0 same-URL twins folded; dropped: invalid 1)" }]);
  });
});

describe("normalize - invalid items", () => {
  const registry = makeRegistry([makeSource({ id: "example-source" })]);
  const cases: [string, Partial<RawItem>, string][] = [
    ["relative link (Sakana AI)", { link: "/jfinbench/" }, "link is not an absolute http(s) URL"],
    ["other scheme", { link: "javascript:alert(1)" }, "link is not an absolute http(s) URL"],
    ["empty link", { link: "" }, "link is not an absolute http(s) URL"],
    ["title is only markup", { title: "<br/> &nbsp; " }, "empty title after cleaning"],
    ["title is only a separator and a site name (Google News comment / subscribe pages)", { title: "- The Kaitchup" }, "empty title after cleaning"],
    ["... also behind a platform suffix", { title: "- Marcus on AI | Substack", itemPublisher: "Marcus on AI | Substack" }, "empty title after cleaning"],
    ["unknown source", { sourceId: "nobody" }, "unknown source id: nobody"],
  ];
  for (const [name, patch, detail] of cases) {
    it(name, () => {
      const out = normalize([makeItem(patch)], registry, createTestContext());
      assert.equal(out.items.length, 0);
      assert.equal(out.dropped.length, 1);
      assert.equal(out.dropped[0].reason, "invalid");
      assert.equal(out.dropped[0].stage, "normalize");
      assert.equal(out.dropped[0].detail, detail);
    });
  }

  it("an item without a usable URL has a null id in its drop record", () => {
    const out = normalize([makeItem({ link: "/x", title: "Kept for the record" })], registry, createTestContext());
    assert.equal(out.dropped[0].id, null);
    assert.equal(out.dropped[0].title, "Kept for the record");
  });

  it("malformed raw items never throw", () => {
    const junk = [
      { sourceId: "example-source" },
      { sourceId: "example-source", title: null, link: null },
      { sourceId: "example-source", title: 2026, link: 7 },
      { sourceId: "example-source", title: {}, link: "https://example.com/object-title", summaryHtml: 5, publishedRaw: 1795100000, itemPublisher: [] },
      { sourceId: "example-source", title: 2027, link: "https://example.com/numeric-title", summaryHtml: { a: 1 }, publishedRaw: {}, itemPublisher: [], itemPublisherUrl: 9 },
    ] as unknown as RawItem[];
    const out = normalize(junk, registry, createTestContext());
    assert.deepEqual(out.items.map((i) => [i.title, i.summary, i.publishedAt]), [["2027", null, null]], "a numeric title is still a title");
    assert.equal(out.dropped.length, 4);
    assert.ok(out.dropped.every((d) => d.reason === "invalid"));
  });

  it("a hostile entity in one item does not take the run down (V1: RangeError rejected fetchAllFeeds)", () => {
    const out = normalize(
      [makeItem({ title: "Emoji gone wrong &#99999999; in title", summaryHtml: "<![CDATA[broken &#1114112; reference in a description that is long enough]]>" }), makeItem({ publishedRaw: "99999 years ago" })],
      registry,
      createTestContext(),
    );
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0].title, "Emoji gone wrong in title");
    assert.equal(out.items[1].publishedAt, null);
  });
});

describe("normalize - URL identity (V1 dedup key bug)", () => {
  it("emits all ten Shtetl-Optimized posts; V1 emitted one", () => {
    const source = makeSource({ id: "shtetl-optimized-aaronson", name: "Shtetl-Optimized (Aaronson)", home: "quantum", url: "https://scottaaronson.blog/?feed=rss2" });
    const posts = [10321, 10318, 10295, 10283, 10270, 10232, 10239, 10235, 10222, 10204];
    const raw = posts.map((p, i) => makeItem({ sourceId: source.id, link: `https://scottaaronson.blog/?p=${p}`, title: `Shtetl post ${p}`, publishedRaw: new Date(NOW.getTime() - i * 2 * DAY).toISOString() }));
    const out = normalize(raw, makeRegistry([source]), createTestContext());
    assert.equal(out.items.length, 10);
    assert.equal(out.dropped.length, 0);
    assert.deepEqual(out.items.map((i) => i.url), posts.map((p) => `https://scottaaronson.blog/?p=${p}`));
    assert.equal(new Set(out.items.map((i) => i.id)).size, 10);
  });

  it("HN item?id= and YouTube watch?v= links stay distinct; utm-only variants collapse", () => {
    const source = makeSource({ id: "example-source" });
    const links = [
      "https://news.ycombinator.com/item?id=1",
      "https://news.ycombinator.com/item?id=2",
      "https://www.youtube.com/watch?v=aaa",
      "https://www.youtube.com/watch?v=bbb",
      "https://example.com/post?utm_source=a",
      "https://example.com/post?utm_source=b",
    ];
    const out = normalize(links.map((link, i) => makeItem({ link, title: `Title ${i}` })), makeRegistry([source]), createTestContext());
    assert.equal(out.items.length, 5);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.url]), [["duplicate", "https://example.com/post"]]);
  });
});

describe("normalize - same-URL twins fold into via[]", () => {
  const news = makeSource({ id: "openai-news", name: "OpenAI News", publisher: "openai", home: "models", tier: 1 });
  const blog = makeSource({ id: "openai-blog", name: "OpenAI Blog", publisher: "openai", home: "tools", tier: 2 });
  const registry = makeRegistry([news, blog], [makePublisher({ id: "openai", name: "OpenAI", hosts: ["openai.com"] })]);

  it("OpenAI News + OpenAI Blog -> one item led by the tier-1 feed", () => {
    const link = "https://openai.com/index/introducing-gpt-6-2";
    const raw = [
      makeItem({ sourceId: "openai-blog", link, title: "Introducing GPT-6.2 Astra and Sol", publishedRaw: "2026-11-17T00:00:00Z", summaryHtml: "Our new frontier models are rolling out to everyone today." }),
      makeItem({ sourceId: "openai-news", link: `${link}/?utm_source=rss`, title: "Introducing GPT-6.2 Astra and Sol", publishedRaw: "Tue, 17 Nov 2026 18:00:00 GMT", summaryHtml: null }),
    ];
    const out = normalize(raw, registry, createTestContext());
    const item = one(out);
    assert.equal(item.sourceId, "openai-news");
    assert.deepEqual(item.via, ["openai-blog"]);
    assert.equal(item.home, "models");
    assert.equal(item.tier, 1);
    assert.equal(item.publishedAt, "2026-11-17T18:00:00.000Z", "the precise stamp wins over the date-only twin");
    assert.equal(item.summary, "Our new frontier models are rolling out to everyone today.", "a twin's summary fills in");
    assert.equal(out.dropped.length, 0, "folded twins are not drops");
  });

  it("via never contains the item's own source and has no repeats", () => {
    const third = makeSource({ id: "techmeme", kind: "aggregator", tier: 2 });
    const link = "https://openai.com/index/x";
    const raw = [makeItem({ sourceId: "techmeme", link }), makeItem({ sourceId: "openai-blog", link }), makeItem({ sourceId: "openai-news", link }), makeItem({ sourceId: "openai-news", link: `${link}#again`, title: "Listed twice" })];
    const out = normalize(raw, makeRegistry([news, blog, third]), createTestContext());
    const item = one(out);
    assert.equal(item.sourceId, "openai-news");
    assert.deepEqual(item.via, ["openai-blog", "techmeme"]);
    assert.deepEqual(out.dropped.map((d) => d.reason), ["duplicate"]);
  });

  it("a direct feed stays primary over an aggregator that can neither lead nor count, whatever the tiers (PF-7)", () => {
    // Techmeme (tier 3, leadEligible false, countsForCoverage false) now links to the article itself,
    // so it twins with the outlet's own feed. Ranked by tier alone it would take over a tier-4 feed's
    // item and that article could no longer lead a story or count as coverage.
    const agg = makeSource({ id: "techmeme", name: "Techmeme", publisher: "techmeme", kind: "aggregator", scope: "general", tier: 3, leadEligible: false, countsForCoverage: false });
    const outlet = makeSource({ id: "small-outlet", name: "Small Outlet", publisher: "small-outlet", tier: 4 });
    const link = "https://small-outlet.example/2026/11/agent-flaw";
    const raw = [makeItem({ sourceId: "techmeme", link, title: "Agent flaw exposes host files" }), makeItem({ sourceId: "small-outlet", link, title: "Agent flaw exposes host files" })];
    const item = one(normalize(raw, makeRegistry([agg, outlet]), createTestContext()));
    assert.equal(item.sourceId, "small-outlet");
    assert.deepEqual(item.via, ["techmeme"]);
    assert.deepEqual([item.leadEligible, item.countsForCoverage, item.attribution, item.tier], [true, true, "source", 4]);
  });

  it("the ledger entry of either twin id is honoured", () => {
    const state = stateWith({ firstSeen: { [hashId("http://www.example.com/story")]: "2026-11-18T09:00:00.000Z" }, health: { a: OK_HEALTH, b: OK_HEALTH } });
    const a = makeSource({ id: "a", tier: 1 });
    const b = makeSource({ id: "b", tier: 2 });
    const raw = [makeItem({ sourceId: "a", link: "https://example.com/story", publishedRaw: null }), makeItem({ sourceId: "b", link: "http://www.example.com/story", publishedRaw: null })];
    const item = one(normalize(raw, makeRegistry([a, b]), createTestContext({ state })));
    assert.equal(item.url, "https://example.com/story");
    assert.equal(item.firstSeenAt, "2026-11-18T09:00:00.000Z");
  });
});

describe("normalize - firstSeenAt / effectiveAt", () => {
  // Gray Swan's blog index has no dates. V1 scored every undated item as 36 h old forever, so posts
  // from Dec 2025, May 2025 and Aug 2026 sat at AI SECURITY ranks 3-5 on 2026-11-19.
  const graySwan = makeSource({ id: "gray-swan", name: "Gray Swan AI", kind: "scrape", home: "ai_security", tier: 2, url: "https://www.grayswan.ai/blog" });
  const registry = makeRegistry([graySwan]);
  const oldPosts = ["7-deadly-signs-of-ai-security-snake-oil", "uk-aisi-x-gray-swan-agent-red-teaming-challenge-results-snapshot", "gray-swan-introduces-the-dangerous-reasoning-arena-competition"];
  const rawPost = (slug: string): RawItem => makeItem({ sourceId: "gray-swan", link: `https://www.grayswan.ai/blog/${slug}`, title: slug.replace(/-/g, " "), publishedRaw: null });
  const idOf = (slug: string): string => hashId(`https://www.grayswan.ai/blog/${slug}`);

  it("undated posts carry their first sighting and therefore age out", () => {
    const seen = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const state = stateWith({ firstSeen: Object.fromEntries(oldPosts.map((s) => [idOf(s), seen])), health: { "gray-swan": OK_HEALTH } });
    const out = normalize([...oldPosts.map(rawPost), rawPost("a-brand-new-post")], registry, createTestContext({ state }));
    assert.equal(out.items.length, 4);
    for (const item of out.items.slice(0, 3)) {
      assert.equal(item.publishedAt, null);
      assert.equal(item.firstSeenAt, seen);
      assert.equal(item.effectiveAt, seen, "30 days old: beyond AI SECURITY's 14-day window and the 21-day max age");
    }
    const fresh = out.items[3];
    assert.equal(fresh.publishedAt, null);
    assert.equal(fresh.effectiveAt, NOW.toISOString(), "a post that appears later is new");
  });

  it("on the very first build the undated back catalogue is not presented as brand new", () => {
    const out = normalize(oldPosts.map(rawPost), registry, createTestContext());
    for (const item of out.items) {
      assert.equal(item.publishedAt, null);
      const ageDays = (NOW.getTime() - Date.parse(item.effectiveAt)) / DAY;
      assert.ok(ageDays > 21, `effective age ${ageDays} d`);
      assert.equal(item.effectiveAt, item.firstSeenAt);
    }
  });

  it("the same holds when the scraper source is added to a running site", () => {
    const state = stateWith({ firstSeen: { zzzz: "2026-11-01T00:00:00.000Z" }, health: { "some-other-source": OK_HEALTH } });
    const item = normalize([rawPost(oldPosts[0])], registry, createTestContext({ state })).items[0];
    assert.ok(NOW.getTime() - Date.parse(item.effectiveAt) > 21 * DAY);
  });

  it("a date more than 1 h in the future is rejected: publishedAt null, effectiveAt = firstSeenAt", () => {
    const src = makeSource({ id: "example-source" });
    const raw = [
      makeItem({ link: "https://example.com/event", publishedRaw: "Thu, 03 Dec 2026 16:00:00 GMT" }),
      makeItem({ link: "https://example.com/skew", publishedRaw: "2026-11-19T21:01:30Z" }),
      makeItem({ link: "https://example.com/past", publishedRaw: "2026-11-19T20:00:00Z" }),
    ];
    const [event, skew, past] = normalize(raw, makeRegistry([src]), createTestContext()).items;
    assert.equal(event.publishedAt, null);
    assert.equal(event.effectiveAt, NOW.toISOString());
    assert.equal(skew.publishedAt, "2026-11-19T21:01:30.000Z");
    assert.equal(past.effectiveAt, "2026-11-19T20:00:00.000Z");
  });

  it("date-only stamps are that day 12:00 UTC", () => {
    const src = makeSource({ id: "example-source" });
    const raw = [makeItem({ link: "https://example.com/a", publishedRaw: "2026-11-18" }), makeItem({ link: "https://example.com/b", publishedRaw: "2026-11-18T00:00:00.000Z" })];
    assert.deepEqual(normalize(raw, makeRegistry([src]), createTestContext()).items.map((i) => i.publishedAt), ["2026-11-18T12:00:00.000Z", "2026-11-18T12:00:00.000Z"]);
  });
});

describe("normalize - GitHub release feeds", () => {
  const langchain = makeSource({ id: "gh-langchain", name: "langchain-ai/langchain", publisher: "github:langchain-ai/langchain", kind: "github-release", home: "releases", tier: 2, url: "https://github.com/langchain-ai/langchain/releases.atom" });
  const fixtureEntries = (file: string, sourceId: string): RawItem[] =>
    [...readFeedFixture(file).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      sourceId,
      title: /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "",
      link: /<link[^>]*href="([^"]+)"/.exec(m[1])?.[1] ?? "",
      publishedRaw: /<updated>([^<]+)<\/updated>/.exec(m[1])?.[1] ?? null,
      summaryHtml: /<content[^>]*>([\s\S]*?)<\/content>/.exec(m[1])?.[1] ?? null,
    }));

  it("the langchain monorepo feed becomes ONE line for langchain itself (V1: 'langchain v0.3.0 released')", () => {
    const raw = fixtureEntries("github-releases-langchain.atom", "gh-langchain");
    assert.equal(raw.length, 10);
    const out = normalize(raw, makeRegistry([langchain]), createTestContext());
    const item = one(out);
    assert.equal(item.title, "langchain 1.5.2 released");
    assert.equal(item.url, "https://github.com/langchain-ai/langchain/releases/tag/langchain%3D%3D1.5.2");
    assert.deepEqual(item.flags, ["release"]);
    assert.equal(item.synthesizedTitle, true);
    assert.equal(item.leadEligible, false);
    assert.equal(item.countsForCoverage, false);
    assert.equal(item.publishedAt, "2026-11-18T22:30:45.000Z");
    assert.equal(out.dropped.length, 9);
    assert.ok(out.dropped.every((d) => d.reason === "release_collapsed" && d.stage === "normalize" && d.id !== null));
    assert.equal(out.dropped.filter((d) => /^sub-package /.test(d.detail ?? "")).length, 8);
    assert.equal(out.dropped.filter((d) => /^older release 1\.5\.1/.test(d.detail ?? "")).length, 1);
  });

  it("the entity-heavy llama.cpp feed becomes one build line with a clean summary", () => {
    const llama = makeSource({ id: "gh-llama", name: "ggml-org/llama.cpp", kind: "github-release", home: "releases", tier: 1, url: "https://github.com/ggml-org/llama.cpp/releases.atom" });
    const out = normalize(fixtureEntries("github-releases-llama-cpp-entity-heavy.atom", "gh-llama"), makeRegistry([llama]), createTestContext());
    const item = one(out);
    assert.equal(item.title, "llama.cpp b12550 released");
    assert.equal(out.dropped.length, 9);
    if (item.summary !== null) {
      assert.ok(item.summary.length <= PIPELINE.summaryMaxChars);
      assert.doesNotMatch(item.summary, /<[a-z]|&(?:lt|gt|amp|#\d+);/i);
    }
  });

  it("a release with its own headline keeps it and is not 'synthesized'", () => {
    const unsloth = makeSource({ id: "gh-unsloth", name: "unslothai/unsloth", kind: "github-release", home: "releases" });
    const raw = [
      makeItem({ sourceId: "gh-unsloth", title: "AMD NPU + video diffusion LoRA", link: "https://github.com/unslothai/unsloth/releases/tag/v0.1.920-beta", publishedRaw: "2026-11-19T15:00:48Z" }),
      makeItem({ sourceId: "gh-unsloth", title: "Large Performance Fixes", link: "https://github.com/unslothai/unsloth/releases/tag/v0.1.916-beta", publishedRaw: "2026-11-06T15:20:21Z" }),
    ];
    const item = one(normalize(raw, makeRegistry([unsloth]), createTestContext()));
    assert.equal(item.title, "unsloth v0.1.920-beta: AMD NPU + video diffusion LoRA");
    assert.equal("synthesizedTitle" in item, false);
    assert.deepEqual(item.flags, ["release"]);
  });

  it("a feed of nothing but sub-package tags yields no item, with every entry accounted for", () => {
    const lobe = makeSource({ id: "gh-lobe", name: "lobehub/lobe-chat", kind: "github-release", home: "releases" });
    const raw = [140, 139, 138].map((n) => makeItem({ sourceId: "gh-lobe", title: `cli-release/v0.0.${n}`, link: `https://github.com/lobehub/lobe-chat/releases/tag/cli-release%2Fv0.0.${n}` }));
    const out = normalize(raw, makeRegistry([lobe]), createTestContext());
    assert.equal(out.items.length, 0);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), Array(3).fill(["release_collapsed", "sub-package cli-release"]));
  });

  it("release collapsing only applies to github-release sources", () => {
    const blog = makeSource({ id: "example-source" });
    const out = normalize([makeItem({ title: "v8 is here" }), makeItem({ title: "v9.0.1" })], makeRegistry([blog]), createTestContext());
    assert.deepEqual(out.items.map((i) => i.title), ["v8 is here", "v9.0.1"]);
  });
});

describe("normalize - publisher attribution", () => {
  const gn = makeSource({ id: "gn-reuters-ai", name: "Reuters AI (Google News)", publisher: "google-news", kind: "query", url: "https://news.google.com/rss/search?q=site:reuters.com+AI" });
  const publishers = [makePublisher({ id: "reuters", name: "Reuters", hosts: ["reuters.com"] }), makePublisher({ id: "google-news", name: "Google News", hosts: ["news.google.com"] })];
  const registry = makeRegistry([gn], publishers);

  it("link-host: the publisher owning the article host; the outlet suffix leaves the title", () => {
    const item = one(normalize([makeItem({ sourceId: gn.id, link: "https://www.reuters.com/technology/anthropic-debut-2026-11-19/", title: "Anthropic's blockbuster debut tests Wall Street's faith in AI boom - Reuters", itemPublisher: "Reuters" })], registry, createTestContext()));
    assert.equal(item.publisher, "reuters");
    assert.equal(item.publisherName, "Reuters");
    assert.equal(item.attribution, "link-host");
    assert.equal(item.title, "Anthropic's blockbuster debut tests Wall Street's faith in AI boom");
  });

  it("link-host: an unknown host is its own publisher, named by the feed's outlet when given", () => {
    const [a, b] = normalize(
      [
        makeItem({ sourceId: gn.id, link: "https://www.tuscaloosanews.com/story/1", title: "Local AI story - The Tuscaloosa News", itemPublisher: "The Tuscaloosa News" }),
        makeItem({ sourceId: gn.id, link: "https://blog.example.co.uk/post", title: "Another story of some length" }),
      ],
      registry,
      createTestContext(),
    ).items;
    assert.deepEqual([a.publisher, a.publisherName, a.title], ["tuscaloosanews.com", "The Tuscaloosa News", "Local AI story"]);
    assert.deepEqual([b.publisher, b.publisherName], ["example.co.uk", "example.co.uk"]);
  });

  it("link-host: an unresolved wrapper link falls back to the feed-provided outlet", () => {
    const wrapped = "https://news.google.com/rss/articles/CBMiABC123";
    const [byUrl, byName, bare] = normalize(
      [
        makeItem({ sourceId: gn.id, link: wrapped, title: "Story one of some length - Reuters", itemPublisher: "Reuters", itemPublisherUrl: "https://www.reuters.com" }),
        makeItem({ sourceId: gn.id, link: `${wrapped}1`, title: "Story two of some length - Reuters", itemPublisher: "reuters" }),
        makeItem({ sourceId: gn.id, link: `${wrapped}2`, title: "Story three of some length" }),
      ],
      registry,
      createTestContext(),
    ).items;
    assert.equal(byUrl.publisher, "reuters");
    assert.equal(byName.publisher, "reuters");
    assert.deepEqual([bare.publisher, bare.publisherName], ["google-news", "Google News"]);
  });

  it("source attribution ignores the link host", () => {
    const src = makeSource({ id: "simon", name: "Simon Willison", publisher: "simonwillison" });
    const item = one(normalize([makeItem({ sourceId: "simon", link: "https://www.reuters.com/x" })], makeRegistry([src]), createTestContext()));
    assert.deepEqual([item.publisher, item.publisherName], ["simonwillison", "Simonwillison"]);
    assert.ok(!("outletHost" in item));
  });

  it("an unresolved wrapper carries the outlet's host for URL rules; a resolved or direct link does not (review PF-10)", () => {
    const outletHost = (i: NormalizedItem): unknown => (i as { outletHost?: string }).outletHost;
    const wrapped = "https://news.google.com/rss/articles/CBMixAFBVV95cUxNOHItelB";
    const [stockTitan, facebook, noOutlet, resolved] = normalize(
      [
        makeItem({ sourceId: gn.id, link: wrapped, title: "$0 revenue at Loan Artificial Intelligence (LAAI) - Stock Titan", itemPublisher: "Stock Titan", itemPublisherUrl: "https://www.stocktitan.net" }),
        makeItem({ sourceId: gn.id, link: `${wrapped}1`, title: "A post of some length - Facebook", itemPublisher: "Facebook", itemPublisherUrl: "https://www.facebook.com" }),
        makeItem({ sourceId: gn.id, link: `${wrapped}2`, title: "Story three of some length" }),
        makeItem({ sourceId: gn.id, link: "https://www.reuters.com/technology/a-story/", title: "A resolved story of some length - Reuters", itemPublisher: "Reuters", itemPublisherUrl: "https://www.reuters.com", resolvedFrom: `${wrapped}3` }),
      ],
      makeRegistry([gn], [...publishers, makePublisher({ id: "meta", name: "Meta", hosts: ["facebook.com", "meta.com"] })]),
      createTestContext(),
    ).items;
    assert.deepEqual([stockTitan.publisher, outletHost(stockTitan)], ["stocktitan.net", "stocktitan.net"]);
    // A known outlet is attributed to its publisher id, so the id cannot stand in for the host.
    assert.deepEqual([facebook.publisher, outletHost(facebook)], ["meta", "facebook.com"]);
    assert.equal(outletHost(noOutlet), undefined);
    assert.ok(!("outletHost" in resolved));
  });

  it("link-host: the article's host is not stripped as a 'Source:' prefix (review PF-11)", () => {
    const hn = makeSource({ id: "hn-coding-agent", name: "HN: coding agent", publisher: "hacker-news", kind: "query", url: "https://hnrss.org/newest?q=coding+agent" });
    const item = one(normalize([makeItem({ sourceId: hn.id, link: "https://layerfs.dev/", title: "LayerFS: A filesystem for AI coding agents" })], makeRegistry([hn]), createTestContext()));
    assert.equal(item.title, "LayerFS: A filesystem for AI coding agents");
  });
});

// Final fix round: a Google News query returns whatever outlet ranks for it (Law Commentary was AI
// SECURITY homepage row #8). scripts/registry/outlets.ts has the rules.
describe("normalize - outlet quality control on link-host feeds", () => {
  const WRAPPER = "https://news.google.com/rss/articles/CBMiOUTLETQUALITY";
  const gn = makeSource({ id: "gn-ai-agent-bank-liability", name: "GN: AI agents x bank liability", publisher: "google-news", url: "https://news.google.com/rss/search?q=x", kind: "query", scope: "general", home: "ai_security", tier: 3, tags: ["finreg"] });
  const hn = makeSource({ id: "hn-coding-agent", name: "HN: Coding Agents", publisher: "hacker-news", url: "https://hn.algolia.com/api/v1/search_by_date?query=coding+agent", kind: "json", attribution: "link-host", outlets: "open", note: "outlets open: 50+ points", home: "tools", tier: 4 });
  const direct = makeSource({ id: "antonio-blog", name: "Antonio", publisher: "antonio", url: "https://blog.antonio.cx/feed.xml", tier: 3 });
  const publishers = [
    makePublisher({ id: "google-news", name: "Google News", hosts: [] }),
    makePublisher({ id: "hacker-news", name: "Hacker News", hosts: ["ycombinator.com"] }),
    makePublisher({ id: "techcrunch", name: "TechCrunch", hosts: ["techcrunch.com"] }),
    makePublisher({ id: "wsj", name: "The Wall Street Journal", hosts: ["wsj.com"] }),
    makePublisher({ id: "medium", name: "Medium", hosts: ["medium.com"] }),
    makePublisher({ id: "antonio", name: "Antonio", hosts: [] }),
  ];
  const registry = makeRegistry([gn, hn, direct], publishers);
  const run = (...raw: RawItem[]): NormalizedItem[] => normalize(raw, registry, createTestContext()).items;
  const standing = (i: NormalizedItem): unknown[] => [i.tier, i.leadEligible, i.countsForCoverage, i.tags.includes("unvetted-outlet")];

  it("a known outlet keeps the feed's standing; an unknown one is tier 4, never leads, counts for nothing and is tagged", () => {
    const [tc, farm] = run(
      makeItem({ sourceId: gn.id, link: "https://techcrunch.com/2026/11/18/banks-ai-agents/", title: "More banks say customers using AI agents are on their own" }),
      makeItem({ sourceId: gn.id, link: "https://www.thewealthadvisor.com/article/banks-warn-customers", title: "Banks Warn Customers: Let an AI Agent Into Your Account and the Risk Is Yours" }),
    );
    assert.deepEqual([tc.publisher, ...standing(tc)], ["techcrunch", 3, true, true, false]);
    assert.deepEqual(tc.tags, ["finreg"]);
    assert.deepEqual([farm.publisher, farm.publisherName, ...standing(farm)], ["thewealthadvisor.com", "thewealthadvisor.com", 4, false, false, true]);
    assert.deepEqual(farm.tags, ["finreg", "unvetted-outlet"]);
    // Everything else about the item is the feed's.
    assert.deepEqual([farm.sourceId, farm.home, farm.scope, farm.kind, farm.attribution], [gn.id, "ai_security", "general", "query", "link-host"]);
  });

  it("a hosting platform or press-release wire names the host but vouches for nothing", () => {
    const [post] = run(makeItem({ sourceId: gn.id, link: "https://medium.com/@someone/ai-agents-and-your-bank-1a2b3c", title: "AI agents and your bank account: who pays?" }));
    assert.deepEqual([post.publisher, post.publisherName, ...standing(post)], ["medium", "Medium", 4, false, false, true]);
  });

  it("an unresolved wrapper is vetted by the outlet the feed names: by host, else by name", () => {
    const [byHost, byName, unknownHost, unknownName, nobody] = run(
      makeItem({ sourceId: gn.id, link: `${WRAPPER}1`, title: "Banks put AI-agent losses on customers - TechCrunch", itemPublisher: "TechCrunch", itemPublisherUrl: "https://techcrunch.com" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}2`, title: "Citi rewrites its terms for AI agents - WSJ", itemPublisher: "Wall Street Journal" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}3`, title: "Citi Makes Customers Liable for AI Agent Activity - TokenPost", itemPublisher: "TokenPost", itemPublisherUrl: "https://www.tokenpost.com" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}4`, title: "U.S. major banks warn on external AI agents - Digital Today", itemPublisher: "Digital Today" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}5`, title: "Banks and AI agents: what changed" }),
    );
    assert.deepEqual([byHost.publisher, ...standing(byHost)], ["techcrunch", 3, true, true, false]);
    assert.deepEqual([byName.publisher, ...standing(byName)], ["wsj", 3, true, true, false]);
    assert.deepEqual([unknownHost.publisher, ...standing(unknownHost)], ["tokenpost.com", 4, false, false, true]);
    assert.deepEqual([unknownName.publisher, unknownName.publisherName, ...standing(unknownName)], ["digital-today", "Digital Today", 4, false, false, true]);
    // A wrapper that names no outlet at all: nobody vouches for it.
    assert.deepEqual([nobody.publisher, ...standing(nobody)], ["google-news", 4, false, false, true]);
  });

  it("a Google News entry without a <source> element names its outlet in the title tail", () => {
    const [known, unknown, denied] = run(
      makeItem({ sourceId: gn.id, link: `${WRAPPER}6`, title: "Citi puts AI-agent losses on customers - what the new terms say - TechCrunch" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}7`, title: "Hong Kong pushes banks to use AI agents - digitimes" }),
      makeItem({ sourceId: gn.id, link: `${WRAPPER}8`, title: "Arizona Opens Criminal Investigation Into OpenAI For Alleged Rogue AI Agents - Law Commentary" }),
    );
    assert.deepEqual([known.title, known.publisher, known.publisherName, ...standing(known)], ["Citi puts AI-agent losses on customers - what the new terms say", "techcrunch", "TechCrunch", 3, true, true, false]);
    assert.deepEqual([unknown.title, unknown.publisher, unknown.publisherName, ...standing(unknown)], ["Hong Kong pushes banks to use AI agents", "digitimes", "digitimes", 4, false, false, true]);
    // The name travels on the item, so relevance can match it against the outlet deny list.
    assert.deepEqual([denied.title, denied.publisherName], ["Arizona Opens Criminal Investigation Into OpenAI For Alleged Rogue AI Agents", "Law Commentary"]);
  });

  it("the title tail is read only on an unresolved Google News link: elsewhere a spaced hyphen is punctuation", () => {
    const [resolved, hnItem] = run(
      makeItem({ sourceId: gn.id, link: "https://techcrunch.com/2026/11/18/x/", title: "AI agents and banks - What Changed This Week" }),
      makeItem({ sourceId: hn.id, link: "https://layerfs.dev/", title: "LayerFS - A Filesystem For Coding Agents" }),
    );
    assert.equal(resolved.title, "AI agents and banks - What Changed This Week");
    assert.equal(hnItem.title, "LayerFS - A Filesystem For Coding Agents");
  });

  it("an open source (HN points, Techmeme's editors) keeps every outlet's standing", () => {
    const [blog] = run(makeItem({ sourceId: hn.id, link: "https://blog.antonio.cx/running-agents-with-lend", title: "Running coding agents without handing them my credentials" }));
    assert.deepEqual([blog.publisher, ...standing(blog)], ["antonio.cx", 4, true, true, false]);
    assert.deepEqual(blog.tags, []);
  });

  it("any copy from an open source or from the publisher's own feed lifts the cap on a same-URL twin", () => {
    const url = "https://blog.antonio.cx/running-agents-with-lend";
    const viaGn = makeItem({ sourceId: gn.id, link: url, title: "Running coding agents without handing them my credentials" });
    const alone = run(viaGn);
    assert.deepEqual(standing(alone[0]), [4, false, false, true]);
    const withHn = run(viaGn, makeItem({ sourceId: hn.id, link: url, title: "Running coding agents without handing them my credentials" }));
    assert.equal(withHn.length, 1);
    assert.ok(!withHn[0].tags.includes("unvetted-outlet"));
    assert.equal(withHn[0].leadEligible, true);
    const withOwn = run(viaGn, makeItem({ sourceId: direct.id, link: url, title: "Running coding agents without handing them my credentials" }));
    assert.equal(withOwn.length, 1);
    assert.deepEqual([withOwn[0].sourceId, ...standing(withOwn[0])], ["antonio-blog", 3, true, true, false]);
  });
});

describe("normalize - aggregator rewrites credit their outlet in the title (Techmeme)", () => {
  const techmeme = makeSource({ id: "techmeme", name: "Techmeme", publisher: "techmeme", url: "https://www.techmeme.com/feed.xml", kind: "aggregator", scope: "general", attribution: "source", leadEligible: false, countsForCoverage: false });
  const publishers = [
    makePublisher({ id: "techmeme", name: "Techmeme", hosts: ["techmeme.com"] }),
    makePublisher({ id: "forbes", name: "Forbes", hosts: ["forbes.com"] }),
    makePublisher({ id: "wsj", name: "The Wall Street Journal", hosts: ["wsj.com"] }),
  ];
  const registry = makeRegistry([techmeme], publishers);
  const permalink = (n: number): string => `https://www.techmeme.com/261119/p${n}#a261119p${n}`;
  const run = (title: string, n = 56): NormalizedItem => one(normalize([makeItem({ sourceId: "techmeme", link: permalink(n), title })], registry, createTestContext()));

  it("the '(Author/Outlet)' tail leaves the headline and becomes the publisher", () => {
    const item = run("Source: Iconiq invested more than $6B in Anthropic; its estimated 1.8% stake was worth ~$31.8B at Thursday's close, a 430%+ return on investment (Richard Nieva/Forbes)");
    assert.equal(item.title, "Source: Iconiq invested more than $6B in Anthropic; its estimated 1.8% stake was worth ~$31.8B at Thursday's close, a 430%+ return on investment");
    assert.deepEqual([item.publisher, item.publisherName, item.attribution], ["forbes", "Forbes", "link-host"]);
    // The registry's policy for the feed is untouched: it never leads and never raises a coverage count.
    assert.deepEqual([item.sourceId, item.leadEligible, item.countsForCoverage], ["techmeme", false, false]);
  });

  it("an outlet the registry knows under 'The ...' is matched; an unknown one is named as written", () => {
    const wsj = run("Ubisoft cancels its next Assassin's Creed as it overhauls its operations (Wall Street Journal)", 1);
    assert.deepEqual([wsj.publisher, wsj.publisherName], ["wsj", "The Wall Street Journal"]);
    const dive = run("CISA's acting director sets out the agency's priorities for 2027 (Eric Geller/Cybersecurity Dive)", 2);
    assert.deepEqual([dive.publisher, dive.publisherName, dive.attribution], ["cybersecurity-dive", "Cybersecurity Dive", "link-host"]);
  });

  it("the tail is split before the 200-character cap, so a long rewrite keeps its credit", () => {
    const item = run(`Sources: ${"a very long clause about the deal, ".repeat(7)}and more (Krystal Hu/Reuters)`, 3);
    assert.ok(item.title.length <= PIPELINE.titleMaxChars);
    assert.doesNotMatch(item.title, /Reuters|Krystal/);
    assert.equal(item.publisherName, "Reuters");
  });

  it("a rewrite without a credit stays the aggregator's own; other feeds keep their parentheses", () => {
    const plain = run("Nvidia posts a record quarter under its interim CEO", 4);
    assert.deepEqual([plain.title, plain.publisher, plain.attribution], ["Nvidia posts a record quarter under its interim CEO", "techmeme", "source"]);
    const blog = makeSource({ id: "example-blog", name: "Example Blog", publisher: "example" });
    const post = one(normalize([makeItem({ sourceId: "example-blog", link: "https://example.com/post", title: "What the new filing says about compute costs (Updated Edition)" })], makeRegistry([blog]), createTestContext()));
    assert.deepEqual([post.title, post.publisher, post.attribution], ["What the new filing says about compute costs (Updated Edition)", "example", "source"]);
  });
});

describe("normalize - dates the parser cannot read are reported", () => {
  it("warns once per source with a sample, and stays silent for missing or readable dates", () => {
    const fca = makeSource({ id: "fca-news" });
    const other = makeSource({ id: "other-feed" });
    const ctx = createTestContext();
    const out = normalize(
      [
        makeItem({ sourceId: "fca-news", link: "https://www.fca.org.uk/news/a", title: "FCA launches a platform for AI innovation", publishedRaw: "Thursday, November 19, 2026 - 17:19" }),
        makeItem({ sourceId: "fca-news", link: "https://www.fca.org.uk/news/b", title: "A second FCA item of some length", publishedRaw: "Donnerstag, 19. sometime in the afternoon" }),
        makeItem({ sourceId: "fca-news", link: "https://www.fca.org.uk/news/c", title: "A third FCA item of some length", publishedRaw: "the day before yesterday-ish" }),
        makeItem({ sourceId: "other-feed", link: "https://other.example.com/a", title: "An undated item of some length", publishedRaw: null }),
        makeItem({ sourceId: "other-feed", link: "https://other.example.com/b", title: "A blank-dated item of some length", publishedRaw: "  " }),
      ],
      makeRegistry([fca, other]),
      ctx,
    );
    assert.equal(out.items.length, 5);
    assert.equal(out.items[0].publishedAt, "2026-11-19T17:19:00.000Z", "the FCA format itself is read (review PF-2 / REG-11)");
    assert.deepEqual(
      ctx.logs.filter((l) => l.level === "warn"),
      [{ level: "warn", msg: 'normalize: fca-news: 2 item(s) carry a date the parser cannot read (e.g. "Donnerstag, 19. sometime in the afternoon"); dated by first sight instead' }],
    );
  });
});

describe("normalize - the 2026-11-19 corpus (2,297 raw items, fixture registry)", () => {
  const registry = loadFixtureRegistry();
  const raw = loadRawItems();
  const ctx = createTestContext();
  const out = normalize(raw, registry, ctx);
  const sourceById = new Map(registry.sources.map((s) => [s.id, s]));

  it("accounts for every raw item: emitted, folded into via[], or dropped with a reason", () => {
    const folded = out.items.reduce((n, i) => n + i.via.length, 0);
    assert.equal(out.items.length + folded + out.dropped.length, raw.length);
    const reasons = new Set(["invalid", "duplicate", "release_collapsed"]);
    for (const d of out.dropped) {
      assert.ok(reasons.has(d.reason), d.reason);
      assert.equal(d.stage, "normalize");
      assert.ok(d.detail && d.detail.length > 0);
      assert.ok(sourceById.has(d.sourceId));
    }
  });

  it("ids are unique and follow the canonical URL", () => {
    assert.equal(new Set(out.items.map((i) => i.id)).size, out.items.length);
    for (const i of out.items) assert.equal(i.id, hashId(i.url));
  });

  it("drops exactly the ten relative Sakana AI links as invalid", () => {
    const invalid = out.dropped.filter((d) => d.reason === "invalid");
    assert.equal(invalid.length, 10);
    assert.ok(invalid.every((d) => d.sourceId === "sakana-ai" && d.id === null && d.url.startsWith("/")));
  });

  it("folds the OpenAI News / OpenAI Blog twins (V1 counted them as two outlets)", () => {
    const twins = out.items.filter((i) => i.via.length > 0);
    const openai = twins.filter((i) => i.sourceId === "openai-news");
    assert.ok(openai.length >= 10, String(openai.length));
    for (const i of openai) assert.deepEqual(i.via, ["openai-blog"]);
    assert.ok(openai.some((i) => i.title === "Introducing GPT-6.2 Astra and Sol"));
    // No same-URL pair survives as two items.
    const keys = out.items.map((i) => i.url.replace(/^https?:\/\/(www\.)?/, ""));
    assert.equal(new Set(keys).size, keys.length);
    for (const i of twins) assert.ok(!i.via.includes(i.sourceId) && new Set(i.via).size === i.via.length);
  });

  it("every GitHub release source has at most one line and it never is a pre-release when the feed has a stable one", () => {
    const perSource = new Map<string, number>();
    for (const i of out.items.filter((x) => x.kind === "github-release")) {
      perSource.set(i.sourceId, (perSource.get(i.sourceId) ?? 0) + 1);
      assert.deepEqual(i.flags, ["release"]);
      assert.doesNotMatch(i.title, /\(#\d+\)|\s{2,}|^rc\d|^cli-release/);
    }
    for (const [id, n] of perSource) assert.equal(n, 1, id);
    // The corpus was captured AFTER V1's own collapsing, so sub-package survivors are simply gone:
    assert.equal(out.items.some((i) => i.sourceId === "langchain-ai-langchain"), false, "V1's 'langchain v0.3.0 released' was langchain-openrouter");
    assert.equal(out.items.some((i) => i.sourceId === "sgl-project-sglang"), false, "V1's 'sglang v0.1.0 released' was router-v0.1.0");
    assert.equal(out.items.find((i) => i.sourceId === "modelcontextprotocol-spec")?.title, "modelcontextprotocol 2026-07-28 released");
  });

  it("titles and summaries respect the contract caps and carry no markup or entities", () => {
    for (const i of out.items) {
      assert.ok(i.title.length > 0 && i.title.length <= PIPELINE.titleMaxChars, i.title);
      assert.equal(i.title, i.title.trim());
      assert.doesNotMatch(i.title, /&(?:amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-f]+);|[​﻿⁠]|\s{2,}/i, i.title);
      if (i.summary !== null) {
        assert.ok(i.summary.length >= 25 && i.summary.length <= PIPELINE.summaryMaxChars, i.summary);
        assert.doesNotMatch(i.summary, LONE_SURROGATE);
        assert.doesNotMatch(i.summary, /appeared first on|Announce Type:|Article URL:|Comments URL:|\[link\]|\[\s*(?:…|\.\.\.)\s*\]$/i, i.summary);
      }
    }
  });

  it("removes the boilerplate the review counted (105 'appeared first on', 56 hnrss, 45 arXiv prefixes)", () => {
    const rawCount = (re: RegExp): number => raw.filter((r) => re.test(r.summaryHtml ?? "")).length;
    assert.ok(rawCount(/appeared first on/) >= 100);
    assert.ok(rawCount(/Article URL:/) >= 20);
    assert.ok(rawCount(/Announce Type:/) >= 40);
    const arxiv = out.items.find((i) => i.sourceId === "arxiv-cs-ai" && i.summary);
    assert.ok(arxiv?.summary && !arxiv.summary.startsWith("arXiv:"));
    const hn = out.items.filter((i) => i.sourceId === "hn-ai-150-points");
    assert.ok(hn.length > 0 && hn.every((i) => i.summary === null));
    const gn = out.items.filter((i) => i.sourceId === "reuters-ai-google-news");
    assert.ok(gn.every((i) => i.summary === null), "Google News summaries are title echoes");
    const techmeme = out.items.find((i) => i.sourceId === "techmeme" && i.title.startsWith("Google adds computer use to Gemini"));
    assert.match(techmeme?.summary ?? "", /^Google on Thursday announced/);
  });

  it("cleans the titles the review named", () => {
    const titles = new Set(out.items.map((i) => i.title));
    assert.ok(titles.has("GovAI in Washington, DC"), "' | GovAI Blog' suffix");
    assert.ok(titles.has("#355 - Cyber Chaos Monkey, Offsec Harness Index, Top 10 AWS Security Research of 2026"), "'[tl;dr sec]' prefix");
    assert.ok(titles.has("The E.U.’s AI Drive Undermines Its Own Chip Strategy"), "zero-width space");
    assert.ok(titles.has("Why Healthcare AI Inventory Precedes Governance"), "' | Straiker' suffix");
    assert.equal([...titles].some((t) => / \| (?:GovAI Blog|Straiker|Giskard)$/.test(t)), false);
  });

  it("times: effectiveAt = publishedAt ?? firstSeenAt, nothing more than 1 h ahead of the clock", () => {
    const limit = ctx.now.getTime() + PIPELINE.maxFutureHours * 3_600_000;
    for (const i of out.items) {
      assert.equal(i.effectiveAt, i.publishedAt ?? i.firstSeenAt);
      // First build (empty state): a dated item is first seen when it was published, never "now".
      assert.equal(i.firstSeenAt, i.publishedAt && Date.parse(i.publishedAt) < ctx.now.getTime() ? i.publishedAt : ctx.now.toISOString());
      if (i.publishedAt) assert.ok(Date.parse(i.publishedAt) <= limit, i.publishedAt);
    }
    assert.equal(out.items.filter((i) => i.publishedAt === null).length, 0, "every corpus date parses");
  });

  it("gives the same output in any machine timezone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["America/Chicago", "Asia/Kolkata"]) {
        process.env.TZ = tz;
        assert.deepEqual(normalize(raw, registry, createTestContext()).items, out.items, tz);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("copies the source policy onto every item", () => {
    for (const i of out.items) {
      const s = sourceById.get(i.sourceId);
      assert.ok(s);
      // An unvetted outlet on a query feed is listed at tier 4 whatever the feed's tier (registry/outlets.ts).
      const unvetted = i.tags.includes("unvetted-outlet");
      assert.deepEqual([i.kind, i.scope, i.home, i.tier, i.sourceName], [s.kind, s.scope, s.home, unvetted ? 4 : s.tier, s.name]);
      if (unvetted) assert.deepEqual([i.attribution, i.leadEligible, i.countsForCoverage], ["link-host", false, false], i.url);
      assert.ok(Array.isArray(i.tags) && Array.isArray(i.flags) && Array.isArray(i.via));
    }
  });

  it("runs in well under a second", () => {
    const t0 = performance.now();
    normalize(raw, registry, createTestContext());
    assert.ok(performance.now() - t0 < 1500);
  });
});

describe("normalize - registry policy fields (titleTemplate, maxAgeDays, releaseLine)", () => {
  const publishers = [makePublisher({ id: "finra", name: "FINRA", hosts: ["finra.org"] }), makePublisher({ id: "github:openai/codex", name: "openai/codex", hosts: [] })];

  it("titleTemplate builds a headline from the feed title and the first summary sentence", () => {
    const notices = makeSource({ id: "finra-notices", name: "FINRA Notices", publisher: "finra", home: "policy", titleTemplate: "FINRA {title}: {summary}" });
    const registry = makeRegistry([notices], publishers);
    const raw = makeItem({ sourceId: "finra-notices", title: "Regulatory Notice 26-24", link: "https://www.finra.org/rules-guidance/notices/26-24", summaryHtml: "<p>FINRA Requests Comment on AI Supervision Guidance. Comment period ends in January.</p>" });
    assert.equal(one(normalize([raw], registry, createTestContext())).title, "FINRA Regulatory Notice 26-24: FINRA Requests Comment on AI Supervision Guidance");
    // No summary to draw on: the feed title is kept as it is.
    assert.equal(one(normalize([{ ...raw, summaryHtml: null }], registry, createTestContext())).title, "Regulatory Notice 26-24");
  });

  it("titleTemplate without {summary} always applies and respects the title cap", () => {
    const hf = makeSource({ id: "hf-models", name: "HF Models", publisher: "finra", home: "open_local", titleTemplate: "New on Hugging Face: {title}" });
    const item = one(normalize([makeItem({ sourceId: "hf-models", title: "Qwen/Qwen-Image-2.1-Turbo", link: "https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo", summaryHtml: null })], makeRegistry([hf], publishers), createTestContext()));
    assert.equal(item.title, "New on Hugging Face: Qwen/Qwen-Image-2.1-Turbo");
    const long = one(normalize([makeItem({ sourceId: "hf-models", title: "x".repeat(40) + " word".repeat(60), link: "https://huggingface.co/a/b", summaryHtml: null })], makeRegistry([hf], publishers), createTestContext()));
    assert.ok(long.title.length <= PIPELINE.titleMaxChars);
  });

  it("maxAgeDays is copied onto the item ONLY when the source sets it", () => {
    const slow = makeSource({ id: "slow", publisher: "finra", maxAgeDays: 45 });
    const plain = makeSource({ id: "plain", publisher: "finra" });
    const out = normalize(
      [makeItem({ sourceId: "slow", link: "https://example.com/slow" }), makeItem({ sourceId: "plain", link: "https://example.com/plain" })],
      makeRegistry([slow, plain], publishers),
      createTestContext(),
    );
    assert.equal(out.items.find((i) => i.sourceId === "slow")?.maxAgeDays, 45);
    assert.ok(!("maxAgeDays" in (out.items.find((i) => i.sourceId === "plain") ?? {})));
  });

  it("releaseLine names the repo's own prefixed tags; other prefixes are sub-packages", () => {
    const entry = (tag: string, when: string): RawItem => makeItem({ sourceId: "gh-openai-codex", title: tag, link: `https://github.com/openai/codex/releases/tag/${tag}`, publishedRaw: when, summaryHtml: null });
    const raw = [entry("rust-v0.170.0", "2026-11-19T10:00:00Z"), entry("sdk-v9.9.9", "2026-11-19T12:00:00Z")];
    const base = { id: "gh-openai-codex", name: "openai/codex", publisher: "github:openai/codex", url: "https://github.com/openai/codex/releases.atom", kind: "github-release" as const, home: "releases" as const };
    const withLine = normalize(raw, makeRegistry([makeSource({ ...base, releaseLine: ["rust"] })], publishers), createTestContext());
    assert.equal(one(withLine).title, "codex v0.170.0 released");
    const without = normalize(raw, makeRegistry([makeSource(base)], publishers), createTestContext());
    assert.equal(without.items.length, 0);
    assert.ok(without.dropped.every((d) => d.reason === "release_collapsed"));
  });
});

describe("normalize - identity across wrapper resolution", () => {
  it("an item resolved from a wrapper keeps the first-seen time recorded under the wrapper's id", () => {
    const gn = makeSource({ id: "gn-ai", name: "Google News: AI", publisher: "google-news", kind: "query", url: "https://news.google.com/rss/search?q=ai" });
    const registry = makeRegistry([gn], [makePublisher({ id: "google-news", name: "Google News", hosts: ["news.google.com"] })]);
    const wrapper = "https://news.google.com/rss/articles/CBMiAbc";
    const published = "Thu, 19 Nov 2026 09:00:00 GMT";
    const wrapped = one(normalize([makeItem({ sourceId: "gn-ai", link: wrapper, publishedRaw: published, itemPublisher: "Example Times", itemPublisherUrl: "https://times.example.com" })], registry, createTestContext()));
    const seenAt = "2026-11-19T09:30:00.000Z";
    const state = stateWith({ firstSeen: { [wrapped.id]: seenAt }, health: { "gn-ai": OK_HEALTH } });
    const resolved = one(
      normalize(
        [makeItem({ sourceId: "gn-ai", link: "https://times.example.com/2026/11/19/story", resolvedFrom: wrapper, publishedRaw: published, itemPublisher: "Example Times", itemPublisherUrl: "https://times.example.com" })],
        registry,
        createTestContext({ state }),
      ),
    );
    assert.notEqual(resolved.id, wrapped.id);
    assert.deepEqual(resolved.formerIds, [wrapped.id]);
    assert.equal(resolved.firstSeenAt, seenAt, "not first seen again when the link changes");
    assert.ok(!("formerIds" in wrapped));
  });
});
