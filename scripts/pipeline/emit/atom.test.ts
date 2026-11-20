import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { hoursAgo, makeScoredStory } from "../../../test/helpers/factories";
import { createTestContext } from "../context";
import type { EmitInput } from "../types";
import { ATOM_MAX_ENTRIES, buildAtom, selectAtomEntries } from "./atom";
import { emit } from "./edition";
import { buildOpml } from "./opml";
import { itemOf, makePlacements, sample, sampleInput, sampleRegistry } from "./testkit.test";
import { hasXmlIllegal, xmlEscape } from "./xml";

interface ParsedEntry {
  title: string;
  id: string;
  updated: string;
  published: string;
  link: { "@_href": string; "@_rel": string }[];
  author: { name: string };
  category: { "@_term": string };
  summary?: string;
}

function parseFeed(xml: string): { feed: { id: string; updated: string; title: string; link: { "@_href": string; "@_rel": string }[]; entry: ParsedEntry[] } } {
  assert.equal(XMLValidator.validate(xml), true, "feed.xml must be well-formed");
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "entry" || name === "link", parseTagValue: false });
  const doc = parser.parse(xml) as ReturnType<typeof parseFeed>;
  doc.feed.entry ??= [];
  return doc;
}

const SITE = "https://pnelsonftp.github.io/ai-drudge-v2/";

describe("emit: feed.xml (Atom)", () => {
  it("is well-formed Atom 1.0 with TOP STORIES and the ai-desk section leads, parsed back", () => {
    const ctx = createTestContext();
    const s = sample();
    const bundle = emit(sampleInput(ctx, s), ctx);
    const { feed } = parseFeed(bundle.atom);
    assert.equal(feed.title, "AI DRUDGE");
    assert.equal(feed.id, SITE);
    assert.deepEqual(feed.link.map((l) => [l["@_rel"], l["@_href"]]), [["alternate", SITE], ["self", `${SITE}feed.xml`]]);

    const urls = feed.entry.map((e) => e.id);
    const article = (id: string) => bundle.front.articles[id];
    // top stories (IPO, launch), then leads of models (launch, already in), industry (IPO, in), money (IPO, in), research, analysis.
    assert.deepEqual(new Set(urls), new Set([s.story.ipo, s.story.launch, s.story.paper, s.story.essay].map((st) => article(st.lead).url)));
    assert.ok(!urls.includes(article(s.story.release.lead).url), "releases are never in the feed");
    assert.ok(!urls.includes(article(s.story.cyber.lead).url), "owner-desk sections are not in the feed");

    const ipo = feed.entry.find((e) => e.id === article(s.story.ipo.lead).url);
    assert.equal(ipo?.title, "Anthropic valued at $2tn as shares begin trading");
    assert.deepEqual(ipo?.link, [{ "@_rel": "alternate", "@_type": "text/html", "@_href": "https://www.reuters.com/anthropic-ipo" }]);
    assert.equal(ipo?.author.name, "Reuters");
    assert.equal(ipo?.category["@_term"], "INDUSTRY");
    assert.equal(ipo?.summary, "Shares rose on the first day of trading.");
    assert.equal(ipo?.updated, hoursAgo(6), "updated = first seen");
    assert.equal(ipo?.published, hoursAgo(6));
  });

  it("orders entries by first-seen (newest first) and dates the feed by its newest entry, not the build", () => {
    const ctx = createTestContext();
    const { feed } = parseFeed(emit(sampleInput(ctx), ctx).atom);
    const seen = feed.entry.map((e) => Date.parse(e.updated));
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
    assert.equal(feed.updated, feed.entry[0].updated);
    assert.notEqual(feed.updated, ctx.now.toISOString());
  });

  it("is byte-stable when the story set is unchanged: a later build with re-ranked rows gives the same file", () => {
    const s = sample();
    const first = createTestContext();
    const a = emit(sampleInput(first, s), first).atom;

    const later = createTestContext({ now: new Date(first.now.getTime() + 30 * 60_000) });
    const reranked: EmitInput = {
      ...sampleInput(later, s),
      placements: {
        ...s.placements,
        // same stories, different ranking: the lead flips and TOP STORIES are reordered.
        top: [s.story.launch.lead, s.story.ipo.lead],
        leadId: s.story.launch.lead,
      },
    };
    const b = emit(reranked, later).atom;
    assert.equal(b, a);
    assert.notEqual(emit(reranked, later).front.generatedAt, emit(sampleInput(first, s), first).front.generatedAt);
  });

  it("changes when a new story joins the set, and only by that entry", () => {
    const ctx = createTestContext();
    const s = sample();
    const before = parseFeed(emit(sampleInput(ctx, s), ctx).atom).feed.entry;
    const fresh = makeScoredStory([itemOf(s.registry, "techcrunch-ai", { url: "https://techcrunch.com/breaking", title: "Breaking: a new top story", publishedAt: hoursAgo(0.5) })], { score: 99 });
    const placements = makePlacements({
      stories: [...Object.values(s.placements.stories), fresh],
      rows: Object.fromEntries(s.placements.sections.map((sec) => [sec.id, sec.id === "industry" ? [fresh.lead, ...sec.rows] : sec.rows])),
      top: [fresh.lead, ...s.placements.top],
    });
    const after = parseFeed(emit({ ...sampleInput(ctx, s), placements }, ctx).atom).feed.entry;
    assert.equal(after.length, before.length + 1);
    assert.equal(after[0].id, "https://techcrunch.com/breaking");
    assert.deepEqual(after.slice(1), before, "existing entries keep their id, dates and text");
  });

  it("escapes markup and drops characters XML cannot carry", () => {
    const ctx = createTestContext();
    const s = sample();
    const nasty = makeScoredStory([
      itemOf(s.registry, "reuters-ai", {
        url: "https://www.reuters.com/a?x=1&y=<2>",
        title: `Tom & Jerry <script>alert("x")</script> ]]> \u0001\u000B bell\uFFFE`,
        summary: "5 < 6 & 'quotes' \u0000 stay data",
      }),
    ]);
    const bundle = emit({ ...sampleInput(ctx, s), placements: makePlacements({ stories: [nasty], rows: { industry: [nasty.lead] }, top: [nasty.lead] }) }, ctx);
    assert.ok(!hasXmlIllegal(bundle.atom));
    const { feed } = parseFeed(bundle.atom);
    assert.equal(feed.entry.length, 1);
    assert.equal(feed.entry[0].title, `Tom & Jerry <script>alert("x")</script> ]]>  bell`);
    assert.equal(feed.entry[0].summary, "5 < 6 & 'quotes'  stay data");
    assert.ok(!bundle.atom.includes("<script>"));
    assert.equal(xmlEscape(`a&b<c>"d"'e'\u0008`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
  });

  it("takes the site URL from the environment, never a hard-coded V1 URL", () => {
    const ctx = createTestContext({ env: { SITE_URL: "https://news.example.org/drudge" } });
    const bundle = emit(sampleInput(ctx), ctx);
    const { feed } = parseFeed(bundle.atom);
    assert.equal(feed.id, "https://news.example.org/drudge/");
    assert.equal(feed.link[1]["@_href"], "https://news.example.org/drudge/feed.xml");
    assert.ok(!bundle.atom.includes("pnelsonftp.github.io/ai-drudge/"));
    const def = createTestContext();
    assert.ok(!emit(sampleInput(def), def).atom.includes("github.io/ai-drudge/"), "the default is the V2 site");
    assert.ok(bundle.opml.includes("https://news.example.org/drudge/"));
  });

  it("caps the feed at 30 entries and is still valid with none", () => {
    const ctx = createTestContext();
    const s = sample();
    const empty = emit({ ...sampleInput(ctx, s), placements: makePlacements({ stories: [], rows: {} }) }, ctx);
    const parsed = parseFeed(empty.atom);
    assert.equal(parsed.feed.entry.length, 0);
    assert.equal(parsed.feed.updated, ctx.now.toISOString());

    assert.equal(ATOM_MAX_ENTRIES, 30);
    const front = emit(sampleInput(ctx, s), ctx).front;
    const picks = selectAtomEntries(front);
    assert.ok(picks.length <= ATOM_MAX_ENTRIES);
    assert.deepEqual(picks.slice(0, 2).map((p) => p.id), front.top, "TOP STORIES are picked first");
    assert.equal(buildAtom(front, { siteUrl: "https://x.test" }).includes('href="https://x.test/feed.xml"'), true);
  });
});

describe("emit: feeds.opml", () => {
  it("lists every active source once, grouped by section, and parses back", () => {
    const registry = sampleRegistry();
    const opml = buildOpml(registry, { siteUrl: SITE });
    assert.equal(XMLValidator.validate(opml), true);
    const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "outline" });
    const doc = parser.parse(opml) as { opml: { body: { outline: { "@_text": string; outline: Record<string, string>[] }[] } } };
    const groups = doc.opml.body.outline;
    assert.deepEqual(groups.map((g) => g["@_text"]), ["MODELS & LABS", "INDUSTRY", "RESEARCH", "CYBER WIRE", "ANALYSIS", "RELEASE RADAR"]);
    const listed = groups.flatMap((g) => g.outline);
    const active = registry.sources.filter((x) => x.status !== "paused");
    assert.deepEqual(listed.map((o) => o["@_text"]).sort(), active.map((x) => x.name).sort());
    assert.ok(!opml.includes("Paused Blog"));

    const openai = listed.find((o) => o["@_text"] === "OpenAI News");
    assert.deepEqual(openai, { "@_type": "rss", "@_text": "OpenAI News", "@_title": "OpenAI News", "@_xmlUrl": "https://openai-news.example.com/feed.xml", "@_htmlUrl": "https://openai.com/news/" });
    const scraper = listed.find((o) => o["@_text"] === "Anthropic News");
    assert.deepEqual(scraper, { "@_type": "link", "@_text": "Anthropic News", "@_title": "Anthropic News", "@_url": "https://www.anthropic.com/news" });
  });

  it("does not change between builds (no timestamps)", () => {
    const registry = sampleRegistry();
    assert.equal(buildOpml(registry, { siteUrl: SITE }), buildOpml(registry, { siteUrl: SITE }));
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(buildOpml(registry, { siteUrl: SITE })));
  });
});
