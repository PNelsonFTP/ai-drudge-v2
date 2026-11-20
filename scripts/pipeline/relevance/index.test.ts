import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS } from "../../../shared/sections";
import { hoursAgo, makeNormalized, makeRegistry, makeSource } from "../../../test/helpers/factories";
import type { SourceDef } from "../../registry/types";
import { createTestContext, PIPELINE } from "../context";
import type { NormalizedItem, RelevanceOutput } from "../types";
import { BIG_STORY_PUBLISHERS, deniedOutletOf, filterRelevance, isGated, overCap, rescueCorroboration, type StoryItems } from "./index";

const DAY_H = 24;

/** An item of `source` with the source's policy fields, as normalize would emit it. */
function itemOf(source: SourceDef, overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return makeNormalized({ sourceId: source.id, sourceName: source.name, publisher: source.publisher, kind: source.kind, scope: source.scope, home: source.home, tier: source.tier, publishedAt: hoursAgo(2), ...overrides });
}
const run = (items: NormalizedItem[], sources: SourceDef[]): RelevanceOutput => filterRelevance(items, makeRegistry(sources), createTestContext());
const reasons = (out: RelevanceOutput): string[] => out.dropped.map((d) => d.reason);

describe("filterRelevance - AI gate for scope 'general'", () => {
  const markets = makeSource({ id: "bloomberg-markets", name: "Bloomberg Markets", scope: "general", home: "money", tier: 2 });
  const lab = makeSource({ id: "openai-news", name: "OpenAI News", scope: "ai", home: "models", tier: 1 });

  it("drops a general-source item without AI relevance and keeps one with it", () => {
    const off = itemOf(markets, { title: "Bloomberg Green New York 2026 Highlights", summary: "Bloomberg Green convened industry leaders during Climate Week NYC." });
    const on = itemOf(markets, { title: "Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book" });
    const out = run([off, on], [markets]);
    assert.deepEqual(out.kept.map((i) => i.id), [on.id]);
    assert.deepEqual(out.dropped, [{ id: off.id, sourceId: "bloomberg-markets", title: off.title, url: off.url, reason: "off_topic", stage: "relevance", detail: "general source, no AI term in the title" }]);
  });

  it("says what the summary did mention", () => {
    const item = itemOf(markets, { title: "Fed's Barr Says Inflation Calls for Further Policy Adjustment", summary: "Federal Reserve Governor Michael Barr says inflation is too high and monetary policy needs to be adjusted further to balance risks at FinRegLab's AI Symposium." });
    assert.equal(run([item], [markets]).dropped[0].detail, "general source, no AI term in the title; summary mentions only ai");
  });

  it("never gates scope 'ai' sources (a lab's post needs no keyword)", () => {
    const item = itemOf(lab, { title: "The Silent Consensus", summary: null });
    assert.equal(run([item], [lab]).kept.length, 1);
  });

  it("owner-desk sections keep their home items WITHOUT the gate (general cyber / quantum wire)", () => {
    const cyber = makeSource({ id: "bleepingcomputer", scope: "general", home: "cyber", tier: 2 });
    const quantum = makeSource({ id: "quantum-wire", scope: "general", home: "quantum", tier: 3 });
    const items = [itemOf(cyber, { title: "PHP flaw exploited to deploy ransomware on unpatched servers" }), itemOf(quantum, { title: "Trapped-ion startup demonstrates 99.99% two-qubit fidelity" })];
    assert.equal(run(items, [cyber, quantum]).kept.length, 2);
  });

  it("isGated follows scope and the home section's desk for every section", () => {
    for (const s of SECTIONS) {
      assert.equal(isGated({ scope: "general", home: s.id }, false), s.desk !== "owner", s.id);
      assert.equal(isGated({ scope: "ai", home: s.id }, false), false, s.id);
      assert.equal(isGated({ scope: "general", home: s.id }, true), false, `${s.id} with include list`);
    }
    assert.deepEqual(SECTIONS.filter((s) => s.desk === "owner").map((s) => s.id), ["cyber", "quantum"]);
  });

  it("the home desk's beat vocabulary applies (compute source: hardware headline passes)", () => {
    const hw = makeSource({ id: "the-next-platform", scope: "general", home: "compute" });
    const title = "Why Liquid Cooling Is Eating The Rack";
    assert.equal(run([itemOf(hw, { title })], [hw]).kept.length, 1);
    assert.equal(run([itemOf(markets, { title })], [markets]).kept.length, 0);
  });

  it("a source's own include list REPLACES the gate", () => {
    const fed = makeSource({ id: "fed-press", scope: "general", home: "policy", include: ["supervision", "model risk"] });
    const kept = itemOf(fed, { title: "Agencies issue guidance on model risk management" });
    const cut = itemOf(fed, { title: "New AI chatbot for consumers announced" });
    const out = run([kept, cut], [fed]);
    assert.deepEqual(out.kept.map((i) => i.id), [kept.id]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [["excluded", "matched none of the source's include terms"]]);
  });
});

describe("filterRelevance - source rules, noise, age", () => {
  const src = makeSource({ id: "example-source", exclude: ["podcast"], excludeUrl: ["/video/"], maxAgeDays: 10 });

  it("excluded: the source's exclude terms and URL rules", () => {
    const a = itemOf(src, { title: "Podcast: this week in models" });
    const b = itemOf(src, { title: "A fine story about models", url: "https://example.com/video/clip-1" });
    const c = itemOf(src, { title: "A fine story about models, in text" });
    const out = run([a, b, c], [src]);
    assert.deepEqual(out.kept.map((i) => i.id), [c.id]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [
      ["excluded", "matched exclude term: podcast"],
      ["excluded", 'URL contains excluded "/video/"'],
    ]);
  });

  it("noise applies to every source, including scope 'ai' first-party feeds", () => {
    const govai = makeSource({ id: "govai", scope: "ai", home: "policy" });
    const nvidia = makeSource({ id: "nvidia-blog", scope: "ai", home: "compute" });
    const items = [
      itemOf(govai, { title: "Head of Hiring" }),
      itemOf(govai, { title: "UK Summer Fellowship 2027, Applied Track" }),
      itemOf(nvidia, { title: "Season’s Streamings and Savings: Black Friday Deals Come to GeForce NOW" }),
      itemOf(govai, { title: "GovAI in Washington, DC" }),
    ];
    const out = run(items, [govai, nvidia]);
    assert.deepEqual(out.kept.map((i) => i.title), ["GovAI in Washington, DC"]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [
      ["noise", 'job: "Head of Hiring"'],
      ["noise", 'job: "Summer Fellowship"'],
      ["noise", 'promo: "Savings: Black Friday"'],
    ]);
  });

  it("too_old: effectiveAt beyond the source's maxAgeDays (default 21)", () => {
    const plain = makeSource({ id: "plain" });
    const items = [
      itemOf(src, { title: "Nine days old", publishedAt: hoursAgo(9 * DAY_H) }),
      itemOf(src, { title: "Eleven days old", publishedAt: hoursAgo(11 * DAY_H) }),
      itemOf(plain, { title: "Twenty days old", publishedAt: hoursAgo(20 * DAY_H) }),
      itemOf(plain, { title: "Twenty-two days old", publishedAt: hoursAgo(22 * DAY_H) }),
    ];
    const out = run(items, [src, plain]);
    assert.deepEqual(out.kept.map((i) => i.title), ["Nine days old", "Twenty days old"]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [
      ["too_old", "age 11 d > 10 d"],
      ["too_old", "age 22 d > 21 d"],
    ]);
  });

  it("an undated item is judged by its first sighting, so a 2025 post seen 30 days ago is gone (Gray Swan)", () => {
    const graySwan = makeSource({ id: "gray-swan", kind: "scrape", home: "ai_security" });
    const stale = itemOf(graySwan, { title: "7 Deadly Signs of AI Security Snake Oil", publishedAt: null, firstSeenAt: hoursAgo(30 * DAY_H) });
    const fresh = itemOf(graySwan, { title: "Your AI agent can be compromised", publishedAt: null, firstSeenAt: hoursAgo(3) });
    assert.equal(stale.effectiveAt, stale.firstSeenAt);
    const out = run([stale, fresh], [graySwan]);
    assert.deepEqual(out.kept.map((i) => i.id), [fresh.id]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [["too_old", "age 30 d > 21 d"]]);
  });

  it("an unparseable effective time is too old, not kept forever", () => {
    const plain = makeSource({ id: "plain" });
    const out = run([itemOf(plain, { effectiveAt: "not a date" })], [plain]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [["too_old", "age unknown d > 21 d"]]);
  });

  it("a source missing from the registry gets the defaults", () => {
    const ghost = makeSource({ id: "ghost" });
    const out = run([itemOf(ghost, { title: "Recent" }), itemOf(ghost, { title: "Ancient", publishedAt: hoursAgo(40 * DAY_H) })], []);
    assert.deepEqual(out.kept.map((i) => i.title), ["Recent"]);
    assert.deepEqual(reasons(out), ["too_old"]);
  });
});

describe("filterRelevance - per-source cap AFTER relevance", () => {
  const markets = makeSource({ id: "bloomberg-markets", scope: "general", home: "money", tier: 2 });

  it("keeps the freshest PIPELINE.sourceCap items of a source", () => {
    const src = makeSource({ id: "busy-feed" });
    const items = Array.from({ length: 12 }, (_, i) => itemOf(src, { title: `Story number ${i}`, publishedAt: hoursAgo(12 - i) }));
    const out = run(items, [src]);
    assert.equal(PIPELINE.sourceCap, 8);
    assert.deepEqual(out.kept.map((i) => i.title), [4, 5, 6, 7, 8, 9, 10, 11].map((n) => `Story number ${n}`), "freshest eight, input order preserved");
    assert.deepEqual(reasons(out), Array(4).fill("source_cap"));
    assert.equal(out.dropped[0].detail, "over the per-source cap of 8 (kept the freshest)");
  });

  it("off-topic items do not consume cap slots (V1 capped before looking: fresh junk displaced AI stories)", () => {
    const junk = Array.from({ length: 10 }, (_, i) => itemOf(markets, { title: `Commodities wrap number ${i}`, publishedAt: hoursAgo(1 + i / 10) }));
    const ai = Array.from({ length: 8 }, (_, i) => itemOf(markets, { title: `Anthropic IPO update ${i}`, publishedAt: hoursAgo(10 + i) }));
    const out = run([...junk, ...ai], [markets]);
    assert.deepEqual(out.kept.map((i) => i.title), ai.map((i) => i.title));
    assert.deepEqual(new Set(reasons(out)), new Set(["off_topic"]));
  });

  it("the cap is per source, not per publisher or section", () => {
    const a = makeSource({ id: "feed-a", publisher: "same" });
    const b = makeSource({ id: "feed-b", publisher: "same" });
    const items = [...Array.from({ length: 9 }, () => itemOf(a)), ...Array.from({ length: 9 }, () => itemOf(b))];
    assert.equal(run(items, [a, b]).kept.length, 16);
  });

  it("a per-source cap declared on the source (maxKept) replaces the default", () => {
    const papers = makeSource({ id: "arxiv-cs-ai", kind: "papers", maxKept: 2 });
    const busy = makeSource({ id: "busy-feed" });
    const wide = makeSource({ id: "wide-feed", maxKept: 10 });
    const items = [papers, busy, wide].flatMap((s) => Array.from({ length: 10 }, (_, i) => itemOf(s, { title: `${s.id} story ${i}`, publishedAt: hoursAgo(1 + i) })));
    const out = filterRelevance(items, makeRegistry([papers, busy, wide]), createTestContext());
    const count = (id: string): number => out.kept.filter((i) => i.sourceId === id).length;
    assert.deepEqual([count("arxiv-cs-ai"), count("busy-feed"), count("wide-feed")], [2, 8, 10]);
    assert.deepEqual(out.kept.filter((i) => i.sourceId === "arxiv-cs-ai").map((i) => i.title), ["arxiv-cs-ai story 0", "arxiv-cs-ai story 1"]);
    assert.equal(out.dropped.find((d) => d.sourceId === "arxiv-cs-ai")?.detail, "over the per-source cap of 2 (kept the freshest)");
  });

  it("overCap: higher tier first, then fresher, then input order", () => {
    const mk = (id: string, tier: 1 | 2 | 3 | 4, hours: number): NormalizedItem => makeNormalized({ url: `https://example.com/${id}`, sourceId: "s", tier, publishedAt: hoursAgo(hours) });
    const items = [mk("old-t1", 1, 50), mk("new-t3", 3, 1), mk("mid-t3", 3, 5), mk("tie-a", 3, 9), mk("tie-b", 3, 9)];
    const cut = overCap(items, 3);
    assert.deepEqual(items.filter((i) => !cut.has(i)).map((i) => i.url.split("/").pop()), ["old-t1", "new-t3", "mid-t3"]);
    assert.equal(overCap(items, 5).size, 0);
    assert.deepEqual([...overCap(items, 4)], [items[4]]);
  });
});

describe("filterRelevance - contract", () => {
  const src = makeSource({ id: "example-source" });
  const markets = makeSource({ id: "bloomberg-markets", scope: "general", home: "money" });

  it("every input item is either kept or dropped with a reason, exactly once", () => {
    const items = [
      itemOf(src, { title: "Kept story" }),
      itemOf(src, { title: "Old story", publishedAt: hoursAgo(40 * DAY_H) }),
      itemOf(src, { title: "Webinar: evaluating agents" }),
      itemOf(markets, { title: "Oil climbs on supply fears" }),
      itemOf(markets, { title: "Nvidia earnings beat estimates" }),
    ];
    const out = run(items, [src, markets]);
    assert.deepEqual(out.kept.map((i) => i.title), ["Kept story", "Nvidia earnings beat estimates"]);
    assert.deepEqual(reasons(out), ["too_old", "noise", "off_topic"]);
    const seen = [...out.kept.map((i) => i.id), ...out.dropped.map((d) => d.id)].sort();
    assert.deepEqual(seen, items.map((i) => i.id).sort());
    for (const d of out.dropped) {
      assert.equal(d.stage, "relevance");
      assert.ok(d.detail && d.title && d.url && d.sourceId);
    }
  });

  it("kept items are the same objects, in input order; input is not mutated", () => {
    const items = [itemOf(src, { title: "B", publishedAt: hoursAgo(5) }), itemOf(src, { title: "A", publishedAt: hoursAgo(1) })];
    const snapshot = structuredClone(items);
    const out = run(items, [src]);
    assert.equal(out.kept[0], items[0]);
    assert.equal(out.kept[1], items[1]);
    assert.deepEqual(items, snapshot);
  });

  it("logs one summary line and is deterministic", () => {
    const items = [itemOf(src), itemOf(markets, { title: "Oil climbs on supply fears" })];
    const ctx = createTestContext();
    const a = filterRelevance(items, makeRegistry([src, markets]), ctx);
    assert.deepEqual(ctx.logs, [{ level: "info", msg: "relevance: 2 items -> 1 kept (dropped: off_topic 1)" }]);
    assert.deepEqual(filterRelevance(items, makeRegistry([src, markets]), createTestContext()), a);
  });

  it("empty input", () => {
    assert.deepEqual(run([], []), { kept: [], dropped: [], passed: [], ownCap: new Set() });
  });

  it("an excluded URL also drops an unresolved wrapper whose outlet host is known (review PF-10)", () => {
    const finra = makeSource({ id: "gn-ai-sec-finra", kind: "query", attribution: "link-host", excludeUrl: ["stocktitan.net", "facebook.com"] });
    const wrapper = (n: number): string => `https://news.google.com/rss/articles/CBMi${n}?oc=5`;
    const items = [
      { ...itemOf(finra, { url: wrapper(1), title: "$0 revenue at Loan Artificial Intelligence (LAAI)", publisher: "stocktitan.net" }), outletHost: "stocktitan.net" },
      // A known outlet carries its publisher ID ("meta"), not its host: the outlet host is what the rule names.
      { ...itemOf(finra, { url: wrapper(2), title: "A post about AI and the SEC", publisher: "meta" }), outletHost: "facebook.com" },
      { ...itemOf(finra, { url: wrapper(3), title: "SEC chair on AI disclosures", publisher: "reuters" }), outletHost: "reuters.com" },
      itemOf(finra, { url: wrapper(4), title: "FINRA publishes AI guidance" }),
    ];
    const out = run(items, [finra]);
    assert.deepEqual(out.kept.map((i) => i.title), ["SEC chair on AI disclosures", "FINRA publishes AI guidance"]);
    assert.deepEqual(out.dropped.map((d) => [d.reason, d.detail]), [
      ["excluded", 'outlet stocktitan.net matches excluded "stocktitan.net" (link not resolved yet)'],
      ["excluded", 'outlet facebook.com matches excluded "facebook.com" (link not resolved yet)'],
    ]);
  });
});

// Final fix round: outlet quality control for link-host feeds (scripts/registry/outlets.ts).
describe("filterRelevance - outlet deny list and unvetted outlets", () => {
  const gn = makeSource({ id: "gn-ai-agent-bank-liability", kind: "query", url: "https://news.google.com/rss/search?q=x", scope: "ai", home: "ai_security", tier: 3, maxKept: 3 });
  const hn = makeSource({ id: "hn-ai-150", kind: "json", attribution: "link-host", outlets: "open", note: "outlets open: 150+ points", url: "https://hn.algolia.com/api/v1/search_by_date?query=AI", tier: 4 });
  const own = makeSource({ id: "law-commentary-feed", url: "https://www.lawcommentary.com/feed.xml", tier: 3 });
  const wrapper = (n: number): string => `https://news.google.com/rss/articles/CBMi${n}?oc=5`;
  const linkHost = (source: SourceDef, overrides: Partial<NormalizedItem>): NormalizedItem => itemOf(source, { attribution: "link-host", ...overrides });

  it("drops a denied outlet on every link-host source: by article host, sub-domain included", () => {
    const items = [
      linkHost(gn, { url: "https://www.lawcommentary.com/articles/arizona-openai", title: "Arizona Opens Criminal Investigation Into OpenAI", publisher: "lawcommentary.com", publisherName: "Law Commentary" }),
      linkHost(gn, { url: "https://finance.biggo.com/news/94a3d1e1", title: "Citi, PNC Rewrite Terms to Put AI Agent Losses on Customers", publisher: "biggo.com", publisherName: "BigGo Finance" }),
      linkHost(hn, { url: "https://www.stocktitan.net/sec-filings/SOAR/nt-10-q.html", title: "SOAR AI delays its quarterly report", publisher: "stocktitan.net", publisherName: "Stock Titan" }),
      linkHost(gn, { url: "https://techcrunch.com/2026/11/18/banks-ai-agents", title: "More banks say customers using AI agents are on their own", publisher: "techcrunch", publisherName: "TechCrunch" }),
    ];
    const out = run(items, [gn, hn]);
    assert.deepEqual(out.kept.map((i) => i.publisherName), ["TechCrunch"]);
    assert.deepEqual(out.dropped.map((d) => [d.sourceId, d.reason, d.detail]), [
      ["gn-ai-agent-bank-liability", "excluded", "outlet lawcommentary.com is on the registry deny list"],
      ["gn-ai-agent-bank-liability", "excluded", "outlet biggo.com is on the registry deny list"],
      ["hn-ai-150", "excluded", "outlet stocktitan.net is on the registry deny list"],
    ]);
  });

  it("an unresolved wrapper is judged by the outlet host, else the outlet NAME the feed gives", () => {
    const items = [
      { ...linkHost(gn, { url: wrapper(1), title: "Rezolve AI files its Form 6-K", publisher: "stocktitan.net", publisherName: "Stock Titan" }), outletHost: "stocktitan.net" },
      linkHost(gn, { url: wrapper(2), title: "The AI agent tap is running", publisher: "london-daily-news", publisherName: "London Daily News" }),
      linkHost(gn, { url: wrapper(3), title: "Banks warn customers about AI agents", publisher: "google-news", publisherName: "Google News" }),
    ];
    const out = run(items, [gn]);
    assert.deepEqual(out.kept.map((i) => i.title), ["Banks warn customers about AI agents"]);
    assert.deepEqual(out.dropped.map((d) => d.detail), ["outlet stocktitan.net is on the registry deny list (link not resolved yet)", "outlet londondaily.news is on the registry deny list (link not resolved yet)"]);
  });

  it("a name alone never condemns a RESOLVED link, and a publisher's own feed is never checked", () => {
    // An honest outlet that happens to share a denied name: its own host is the evidence.
    assert.equal(deniedOutletOf({ url: "https://shattered.example.org/post", attribution: "link-host", publisherName: "Shattered" }, "google.com"), null);
    assert.equal(deniedOutletOf({ url: wrapper(1), attribution: "link-host", publisherName: "Shattered" }, "google.com"), "outlet shattered.io is on the registry deny list (link not resolved yet)");
    // Source attribution: the registry chose this feed; the deny list is for outlets nobody chose.
    const direct = itemOf(own, { url: "https://www.lawcommentary.com/articles/x", title: "A direct feed item" });
    assert.equal(deniedOutletOf(direct, "lawcommentary.com"), null);
    assert.equal(run([direct], [own]).kept.length, 1);
  });

  it("the per-source cap fills a query's slots with known outlets before any unvetted one (tier first, then freshest)", () => {
    // What normalize emits on a vetted source: an unvetted outlet is tier 4 whatever the feed's tier.
    const unvetted = (title: string, hours: number): NormalizedItem => linkHost(gn, { title, tier: 4, leadEligible: false, countsForCoverage: false, tags: ["unvetted-outlet"], publisher: `${title}.example`, publishedAt: hoursAgo(hours) });
    const known = (title: string, hours: number): NormalizedItem => linkHost(gn, { title, publisher: title, publishedAt: hoursAgo(hours) });
    const items = [unvetted("farm-a", 1), unvetted("farm-b", 2), unvetted("farm-c", 3), known("techcrunch", 30), known("business-insider", 40), unvetted("farm-d", 4)];
    const out = run(items, [gn]);
    assert.deepEqual(out.kept.map((i) => i.title), ["farm-a", "techcrunch", "business-insider"]);
    assert.deepEqual(out.dropped.map((d) => [d.title, d.reason]), [["farm-b", "source_cap"], ["farm-c", "source_cap"], ["farm-d", "source_cap"]]);
  });

  it("an unvetted item over its feed's cap is never rescued, however well covered the story is", () => {
    const press = makeSource({ id: "techcrunch-ai", tier: 2 });
    const story = itemOf(press, { title: "Citi rewrites its AI-agent terms", publisher: "techcrunch" });
    // What normalize emits for an unknown outlet on a vetted source.
    const farm = (n: number): NormalizedItem => linkHost(gn, { title: `Citi rewrites its AI-agent terms (rewrite ${n})`, tier: 4, leadEligible: false, countsForCoverage: false, tags: ["unvetted-outlet"], publisher: `farm-${n}.example`, publishedAt: hoursAgo(n) });
    const known = linkHost(gn, { title: "Citi rewrites its AI-agent terms, says Business Insider", publisher: "business-insider", publishedAt: hoursAgo(30) });
    const farms = [1, 2, 3, 4, 5].map(farm);
    const oneStory = (list: NormalizedItem[]): StoryItems[] => [{ items: list }];
    const capped = filterRelevance([story, ...farms, known], makeRegistry([press, gn]), createTestContext());
    // Cap of 3: the known outlet first (tier), then the two freshest rewrites.
    assert.deepEqual(capped.kept.map((i) => i.publisher), ["techcrunch", "farm-1.example", "farm-2.example", "business-insider"]);
    const out = rescueCorroboration(capped, oneStory);
    assert.deepEqual(out.kept.map((i) => i.publisher), ["techcrunch", "farm-1.example", "farm-2.example", "business-insider"], "three more rewrites share the story with TechCrunch and stay cut");
    assert.equal(out.dropped.filter((d) => d.reason === "source_cap").length, 3);
    // A known outlet over the same cap IS corroboration and comes back.
    const second = linkHost(gn, { title: "Citi rewrites its AI-agent terms: PYMNTS", publisher: "pymnts", publishedAt: hoursAgo(40) });
    const third = linkHost(gn, { title: "Citi rewrites its AI-agent terms: Reuters", publisher: "reuters", publishedAt: hoursAgo(50) });
    const fourth = linkHost(gn, { title: "Citi rewrites its AI-agent terms: Axios", publisher: "axios", publishedAt: hoursAgo(60) });
    const rescued = rescueCorroboration(filterRelevance([story, known, second, third, fourth, ...farms], makeRegistry([press, gn]), createTestContext()), oneStory);
    assert.deepEqual(rescued.kept.map((i) => i.publisher), ["techcrunch", "business-insider", "pymnts", "reuters", "axios"]);
  });

  it("an unvetted item never corroborates: it cannot rescue an over-cap item of another source", () => {
    const press = makeSource({ id: "techcrunch-ai", tier: 2, maxKept: 1 });
    const fresh = itemOf(press, { title: "Banks story one", publishedAt: hoursAgo(1) });
    const over = itemOf(press, { title: "Citi rewrites its AI-agent terms", publishedAt: hoursAgo(5) });
    const farm = linkHost(gn, { title: "Citi rewrites its AI-agent terms, explained", tier: 4, leadEligible: false, countsForCoverage: false, tags: ["unvetted-outlet"], publisher: "farm.example" });
    const byFirstWord = (list: NormalizedItem[]): StoryItems[] => {
      const groups = new Map<string, NormalizedItem[]>();
      for (const i of list) groups.set(i.title.split(" ")[0], [...(groups.get(i.title.split(" ")[0]) ?? []), i]);
      return [...groups.values()].map((g) => ({ items: g }));
    };
    const out = rescueCorroboration(filterRelevance([fresh, over, farm], makeRegistry([press, gn]), createTestContext()), byFirstWord);
    assert.deepEqual(out.kept.map((i) => i.title), ["Banks story one", "Citi rewrites its AI-agent terms, explained"]);
  });
});

describe("rescueCorroboration - the cap never removes corroboration (review RE-01)", () => {
  // The first word of a title is the story (a stand-in for the cluster stage, which this stage may not import).
  const byFirstWord = (items: NormalizedItem[]): StoryItems[] => {
    const stories = new Map<string, NormalizedItem[]>();
    for (const i of items) stories.set(i.title.split(" ")[0], [...(stories.get(i.title.split(" ")[0]) ?? []), i]);
    return [...stories.values()].map((list) => ({ items: list }));
  };
  const openai = makeSource({ id: "openai-news", publisher: "openai", tier: 1 });
  const changelog = makeSource({ id: "github-copilot-changelog", publisher: "github", tier: 3 });
  const arxiv = makeSource({ id: "arxiv-cs-ai", kind: "papers", publisher: "arxiv", maxKept: 2 });
  const hn = makeSource({ id: "hn-ai", kind: "community", publisher: "hacker-news", countsForCoverage: false });
  const of = (source: SourceDef, title: string, hours: number, overrides: Partial<NormalizedItem> = {}): NormalizedItem =>
    itemOf(source, { url: `https://example.com/${source.id}/${encodeURIComponent(title)}`, title, publishedAt: hoursAgo(hours), countsForCoverage: source.countsForCoverage ?? true, ...overrides });

  // OpenAI published 8 posts after the launch post: the launch post is over the cap of 8.
  const launch = of(openai, "GPT-6.2 Introducing GPT-6.2 Astra and Sol", 55);
  const newer = Array.from({ length: 8 }, (_, i) => of(openai, `Post${i} a newer OpenAI post`, 10 + i));
  const copilot = of(changelog, "GPT-6.2 Astra and Sol now available in Copilot", 50);
  const lonely = of(openai, "Lonely an older OpenAI post nobody else covered", 60);

  it("filterRelevance alone still applies the cap, and says what passed before it", () => {
    const out = filterRelevance([launch, ...newer, copilot, lonely], makeRegistry([openai, changelog]), createTestContext());
    assert.equal(out.kept.includes(launch), false);
    assert.deepEqual(out.passed, [launch, ...newer, copilot, lonely]);
    assert.deepEqual(reasons(out), ["source_cap", "source_cap"]);
    assert.equal(out.kept.length + out.dropped.length, out.passed.length);
  });

  it("an over-cap item that another publisher corroborates comes back; one nobody else covered stays cut", () => {
    const items = [launch, ...newer, copilot, lonely];
    const ctx = createTestContext();
    const capped = filterRelevance(items, makeRegistry([openai, changelog]), ctx);
    const snapshot = { kept: [...capped.kept], dropped: [...capped.dropped] };
    const out = rescueCorroboration(capped, byFirstWord, ctx);
    assert.deepEqual(out.kept, [launch, ...newer, copilot], "input order, the launch post back in place");
    assert.deepEqual(out.dropped.map((d) => [d.id, d.reason]), [[lonely.id, "source_cap"]]);
    assert.deepEqual(Object.keys(out).sort(), ["dropped", "kept"]);
    assert.equal(ctx.logs.at(-1)?.msg, "relevance: 1 of 2 over-cap items kept as corroboration of a multi-publisher story -> 10 kept");
    assert.deepEqual({ kept: capped.kept, dropped: capped.dropped }, snapshot, "input not mutated");
    assert.equal(out.kept.length + out.dropped.length, items.length, "every item is still kept or dropped exactly once");
  });

  it("big-story relief: the items a wire files on a 6-publisher story do not use up its cap (live: CNBC, 5 of 8 slots on the IPO)", () => {
    assert.equal(BIG_STORY_PUBLISHERS, 6);
    const wire = makeSource({ id: "cnbc-tech", publisher: "cnbc", tier: 3 });
    const others = Array.from({ length: 5 }, (_, i) => makeSource({ id: `outlet-${i}`, publisher: `outlet-${i}`, tier: 3 }));
    // Five IPO items and three other fresh items fill the wire's eight slots; three older items are over the cap.
    const ipo = Array.from({ length: 5 }, (_, i) => of(wire, `IPO angle ${i} from the wire`, 2 + i));
    const fresh = Array.from({ length: 3 }, (_, i) => of(wire, `Fresh${i} another wire story`, 8 + i));
    const waiting = ["Palo", "Second", "Third"].map((w, i) => of(wire, `${w} an older wire story nobody else has`, 20 + i));
    const coverage = others.map((o, i) => of(o, `IPO report ${i}`, 3 + i));
    const items = [...ipo, ...fresh, ...waiting, ...coverage];
    const ctx = createTestContext();
    const capped = filterRelevance(items, makeRegistry([wire, ...others]), ctx);
    assert.deepEqual(capped.kept.filter((i) => i.sourceId === "cnbc-tech"), [...ipo, ...fresh], "the cap alone: the eight freshest");
    const out = rescueCorroboration(capped, byFirstWord, ctx);
    // Five slots were IPO items of a 6-publisher story, so up to five more items come back: all three.
    assert.deepEqual(out.kept.filter((i) => i.sourceId === "cnbc-tech"), [...ipo, ...fresh, ...waiting]);
    assert.equal(ctx.logs.at(-1)?.msg, "relevance: 3 of 3 over-cap items kept as corroboration of a multi-publisher story (3 of them in cap slots that items of a 6+ publisher story had taken) -> 16 kept");
    assert.equal(out.kept.length + out.dropped.length, items.length);
    // A story of five publishers is not big: nothing comes back.
    const small = [...ipo, ...fresh, ...waiting, ...coverage.slice(0, 4)];
    const none = rescueCorroboration(filterRelevance(small, makeRegistry([wire, ...others]), createTestContext()), byFirstWord);
    assert.deepEqual(none.kept.filter((i) => i.sourceId === "cnbc-tech"), [...ipo, ...fresh]);
    // Only as many as the big story took: with two IPO items, the two best of the three waiting.
    const two = [...ipo.slice(0, 2), ...Array.from({ length: 6 }, (_, i) => of(wire, `Fill${i} another wire story`, 8 + i)), ...waiting, ...coverage];
    const partial = rescueCorroboration(filterRelevance(two, makeRegistry([wire, ...others]), createTestContext()), byFirstWord);
    assert.deepEqual(partial.kept.filter((i) => waiting.includes(i)), waiting.slice(0, 2), "freshest first");
    // A source whose cap the registry sets itself is never widened.
    const tight = makeSource({ id: "cnbc-tech", publisher: "cnbc", tier: 3, maxKept: 8 });
    const own = rescueCorroboration(filterRelevance(items, makeRegistry([tight, ...others]), createTestContext()), byFirstWord);
    assert.deepEqual(own.kept.filter((i) => i.sourceId === "cnbc-tech"), [...ipo, ...fresh]);
  });

  it("explicit caps keep their meaning: a source's uncorroborated items never exceed its cap", () => {
    const papers = Array.from({ length: 6 }, (_, i) => of(arxiv, `Paper${i} a preprint`, 1 + i));
    const covered = of(arxiv, "Agents a preprint the press picked up", 30);
    const press = of(changelog, "Agents paper shows a new attack", 20);
    const capped = filterRelevance([...papers, covered, press], makeRegistry([arxiv, changelog]), createTestContext());
    const out = rescueCorroboration(capped, byFirstWord);
    const fromArxiv = out.kept.filter((i) => i.sourceId === "arxiv-cs-ai");
    assert.deepEqual(fromArxiv.map((i) => i.title.split(" ")[0]), ["Paper0", "Paper1", "Agents"]);
    const stories = byFirstWord(out.kept);
    const alone = fromArxiv.filter((i) => stories.find((s) => s.items.includes(i))!.items.length === 1);
    assert.ok(alone.length <= 2, "single-publisher rows stay within maxKept");
  });

  it("the same publisher, or an item that does not count for coverage, is not corroboration", () => {
    const twin = makeSource({ id: "openai-blog", publisher: "openai" });
    const samePublisher = of(twin, "GPT-6.2 the same post on the other OpenAI feed", 55);
    const discussion = of(hn, "GPT-6.2 Astra and Sol | Hacker News", 54);
    const capped = filterRelevance([launch, ...newer, samePublisher, discussion], makeRegistry([openai, twin, hn]), createTestContext());
    const out = rescueCorroboration(capped, byFirstWord);
    assert.equal(out.kept.includes(launch), false);
    assert.deepEqual(reasons(out), ["source_cap"]);
  });

  it("two over-cap items of different publishers corroborate each other", () => {
    const busy = makeSource({ id: "the-register-ai-ml", publisher: "the-register", maxKept: 1 });
    const wire = makeSource({ id: "gn-reuters-ai", publisher: "reuters", maxKept: 1 });
    const items = [
      of(busy, "Fresh a newer Register story", 1),
      of(busy, "EC European Commission scrambles to contain AI-assisted cyberattack", 7),
      of(wire, "Other a newer Reuters story", 2),
      of(wire, "EC EU Commission confirms it was targeted in cyberattack through use of AI tools", 7),
    ];
    const out = rescueCorroboration(filterRelevance(items, makeRegistry([busy, wire]), createTestContext()), byFirstWord);
    assert.deepEqual(out.kept, items);
    assert.deepEqual(out.dropped, []);
  });

  it("the corroborating item must survive too: a thread is not rescued by an article that stays cut", () => {
    const forum = makeSource({ id: "lemmy-localllama", kind: "community", publisher: "lemmy", countsForCoverage: false, maxKept: 1 });
    const press = makeSource({ id: "the-register-ai-ml", publisher: "the-register", maxKept: 1 });
    const items = [
      of(forum, "Fresh a newer thread", 1),
      of(forum, "Quant thread about the new quantization paper", 9),
      of(press, "Other a newer Register story", 2),
      // Over its cap, and its only company is a thread that does not count for coverage: it stays cut ...
      of(press, "Quant new quantization paper halves memory", 8),
    ];
    const out = rescueCorroboration(filterRelevance(items, makeRegistry([forum, press]), createTestContext()), byFirstWord);
    // ... so the thread, whose only corroboration it was, stays cut as well.
    assert.deepEqual(out.kept.map((i) => i.title.split(" ")[0]), ["Fresh", "Other"]);
    assert.deepEqual(reasons(out), ["source_cap", "source_cap"]);
  });

  it("nothing over the cap, or an output without `passed`: returned unchanged and the clustering is not called", () => {
    const items = [launch, copilot];
    const capped = filterRelevance(items, makeRegistry([openai, changelog]), createTestContext());
    const never = (): StoryItems[] => {
      throw new Error("clustered without need");
    };
    assert.deepEqual(rescueCorroboration(capped, never), { kept: items, dropped: [] });
    const legacy: RelevanceOutput = { kept: [copilot], dropped: [] };
    assert.deepEqual(rescueCorroboration(legacy, never), legacy);
  });
});
