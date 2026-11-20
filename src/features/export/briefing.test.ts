import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleV2 } from "../../../shared/contract";
import { NO_MUTES, publisherName, type MuteSet } from "../../../shared/select";
import { NO_TERMS, compileTerms } from "../../../shared/text";
import { DAY_MS, HOUR_MS } from "../../../shared/time";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition, makeRiver, makeSourceRef } from "../../../test/helpers/factories";
import { fixtureEdition, fixtureRiver, fixtureStory } from "../../../test/helpers/fixtureData";
import type { SavedSnapshot, SavedState } from "../../app/services";
import { ALL_PARTS, BRIEFING_TOP_LIMIT, briefingFilename, briefingMarkdown, briefingText, buildBriefing, formatUtc, type BriefingInput, splitAlso } from "./briefing";
import { escapeMarkdown, markdownLink } from "./kit/markdown";

const NOW = FIXTURE_NOW_MS;
const TODAY = NOW - 12 * HOUR_MS;
const NO_SAVED: SavedState = { bookmarks: new Set(), later: new Set(), snapshots: {} };

const sources = {
  guardian: makeSourceRef({ name: "The Guardian AI", publisher: "The Guardian" }),
  reuters: makeSourceRef({ name: "Reuters Tech", publisher: "Reuters" }),
  "reuters-2": makeSourceRef({ name: "Reuters Markets", publisher: "Reuters" }),
  ft: makeSourceRef({ name: "FT AI", publisher: "Financial Times" }),
  verge: makeSourceRef({ name: "The Verge AI", publisher: "The Verge" }),
  blog: makeSourceRef({ name: "Qwen Blog", publisher: "Alibaba" }),
};

function world() {
  const lead = makeArticle({ title: "Anthropic valued at $2tn [live] *record* IPO #1", src: "guardian", url: "https://guardian.example/live_(ipo)", publishedAt: hoursAgo(1) });
  const m1 = makeArticle({ title: "Anthropic IPO prices", src: "reuters", publishedAt: hoursAgo(2) });
  const m2 = makeArticle({ title: "Anthropic IPO: markets", src: "reuters-2", publishedAt: hoursAgo(2) });
  const m3 = makeArticle({ title: "Anthropic lists", src: "ft", publishedAt: hoursAgo(3) });
  const second = makeArticle({ title: "OpenAI ships GPT-6.2", src: "verge", publishedAt: hoursAgo(4) });
  const s1 = makeArticle({ title: "OpenAI model out", src: "ft", publishedAt: hoursAgo(5) });
  const single = makeArticle({ title: "Solo story", src: "ft", publishedAt: hoursAgo(6) });
  const qwenNew = makeArticle({ title: "Qwen 4 quantized builds land", src: "blog", home: "open_local", publishedAt: hoursAgo(3) });
  const qwenOld = makeArticle({ title: "Qwen roadmap", src: "blog", home: "open_local", publishedAt: hoursAgo(40) });
  const articles = [lead, m1, m2, m3, second, s1, single, qwenNew, qwenOld];
  const { edition } = makeEdition({
    articles,
    rows: { industry: [lead.id, second.id, single.id], open_local: [qwenNew.id, qwenOld.id] },
    clusters: { [lead.id]: { members: [m1.id, m2.id, m3.id], publishers: 3 }, [second.id]: [s1.id] },
    top: [lead.id, second.id, single.id],
    sources,
  });
  const river = makeRiver(articles, { sources, leads: { [m1.id]: lead.id, [m2.id]: lead.id, [m3.id]: lead.id, [s1.id]: second.id } });
  return { edition, river, lead, m1, m2, m3, second, s1, single, qwenNew, qwenOld };
}

function input(w: ReturnType<typeof world>, over: Partial<BriefingInput> = {}): BriefingInput {
  return { edition: w.edition, river: w.river, saved: NO_SAVED, matcher: NO_TERMS, mutes: NO_MUTES, nowMs: NOW, todayStartMs: TODAY, ...over };
}

const snapshot = (a: ArticleV2, savedAt: string, sourceName = "Saved Source"): SavedSnapshot => ({ id: a.id, title: a.title, url: a.url, sourceName, publishedAt: a.publishedAt, savedAt });

describe("export/briefing - buildBriefing", () => {
  it("top stories: ranked, with outlet, publisher count and one Also entry per other publisher", () => {
    const w = world();
    const b = buildBriefing(input(w));
    assert.deepEqual(b.top.map((s) => s.id), [w.lead.id, w.second.id, w.single.id]);
    assert.equal(b.top[0].source, "The Guardian");
    assert.equal(b.top[0].publishers, 3);
    assert.deepEqual(b.top[0].also.map((o) => o.name), ["Reuters", "Financial Times"], "the second Reuters feed is the same publisher");
    assert.equal(b.top[0].also[0].url, w.m1.url);
    assert.equal(b.top[2].publishers, 1);
    assert.deepEqual(b.top[2].also, []);
    assert.equal(b.generatedAt, w.edition.meta.generatedAt);
    assert.equal(b.buildId, w.edition.meta.buildId);
  });

  it("limits: 8 top stories and 5 Also outlets by default", () => {
    const e = fixtureEdition();
    const b = buildBriefing({ edition: e, river: null, saved: NO_SAVED, matcher: NO_TERMS, mutes: NO_MUTES, nowMs: NOW, todayStartMs: TODAY });
    assert.equal(b.top.length, Math.min(8, e.top.length));
    assert.equal(b.top[0].id, e.leadId);
    for (const s of b.top) assert.ok(s.also.length <= 5);
    assert.equal(b.top[0].id, fixtureStory("multiPublisherLead"));
    assert.equal(b.top[0].also.length, 5, "the fixture's lead has more outlets than the line holds");
    assert.equal(b.top[0].publishers, e.clusters[b.top[0].id].publishers);
    assert.equal(buildBriefing({ edition: e, river: null, saved: NO_SAVED, matcher: NO_TERMS, mutes: NO_MUTES, nowMs: NOW, todayStartMs: TODAY, topLimit: 2, alsoLimit: 1 }).top.length, 2);
  });

  it("muted sources drop out of top stories and Also lines; a story with another outlet is re-led, not dropped", () => {
    const w = world();
    const mutes: MuteSet = { sources: new Set(["verge", "reuters", "reuters-2"]), sections: new Set() };
    const b = buildBriefing(input(w, { mutes }));
    assert.deepEqual(b.top.map((s) => s.id), [w.lead.id, w.second.id, w.single.id], "story keys are unchanged");
    assert.deepEqual(b.top[0].also.map((o) => o.name), ["Financial Times"]);
    // The Verge leads the GPT story and is muted: the FT article is exported in its place.
    assert.deepEqual([b.top[1].title, b.top[1].url, b.top[1].source, b.top[1].publishers], [w.s1.title, w.s1.url, "Financial Times", 1]);
    assert.deepEqual(b.top[1].also, []);
    // Every outlet of a story muted: it is gone.
    const all = buildBriefing(input(w, { mutes: { sources: new Set(["verge", "ft"]), sections: new Set() } }));
    assert.deepEqual(all.top.map((s) => s.id), [w.lead.id]);
  });

  it("watch hits: last 24 h only, one per story, with the matched terms, minus stories already in the top list", () => {
    const w = world();
    const b = buildBriefing(input(w, { matcher: compileTerms(["Qwen", "quantiz*", "IPO"], { plural: true }) }));
    assert.deepEqual(b.watch.map((h) => h.id), [w.qwenNew.id], "the 40 h old hit and the IPO top story are left out");
    assert.deepEqual(b.watch[0].terms, ["Qwen", "quantiz*"]);
    assert.equal(b.watch[0].source, "Qwen Blog");
    assert.equal(b.watchTotal, 1);
  });

  it("watch hits need the river and a non-empty watchlist; the limit is reported", () => {
    const w = world();
    assert.deepEqual(buildBriefing(input(w, { river: null, matcher: compileTerms(["Qwen"]) })).watch, []);
    assert.deepEqual(buildBriefing(input(w, { matcher: NO_TERMS })).watch, []);
    const many = buildBriefing({ edition: fixtureEdition(), river: fixtureRiver, saved: NO_SAVED, matcher: compileTerms(["AI"]), mutes: NO_MUTES, nowMs: Date.parse(fixtureRiver.generatedAt), todayStartMs: 0, watchLimit: 3 });
    assert.equal(many.watch.length, 3);
    assert.ok(many.watchTotal > 3);
  });

  it("bookmarks: saved today only, newest first, live title wins, snapshot is the fallback", () => {
    const w = world();
    const gone = makeArticle({ title: "Gone from the edition", url: "https://example.com/gone" });
    const bad = makeArticle({ title: "Bad link", url: "https://example.com/bad" });
    const saved: SavedState = {
      bookmarks: new Set([w.single.id, gone.id, w.second.id, bad.id, "phantom"]),
      later: new Set([w.lead.id]),
      snapshots: {
        [w.single.id]: snapshot({ ...w.single, title: "Stale snapshot title" }, new Date(NOW - 2 * HOUR_MS).toISOString()),
        [gone.id]: snapshot(gone, new Date(NOW - 1 * HOUR_MS).toISOString(), "Old Outlet"),
        [w.second.id]: snapshot(w.second, new Date(NOW - 3 * DAY_MS).toISOString()),
        [bad.id]: { ...snapshot(bad, new Date(NOW - HOUR_MS).toISOString()), url: "javascript:alert(1)" },
        [w.lead.id]: snapshot(w.lead, new Date(NOW - HOUR_MS).toISOString()),
      },
    };
    const b = buildBriefing(input(w, { saved }));
    assert.deepEqual(b.bookmarks, [
      { id: gone.id, title: "Gone from the edition", url: "https://example.com/gone", source: "Old Outlet" },
      { id: w.single.id, title: "Solo story", url: w.single.url, source: "FT AI" },
    ]);
  });
});

describe("export/briefing - Markdown and text", () => {
  it("prints the outlets the count covers under Also:, and outlets that only link the story under Also linked:", () => {
    const lead = makeArticle({ title: "Lab introduces its new model", src: "guardian", publishedAt: hoursAgo(1) });
    const press = makeArticle({ title: "New model lands", src: "reuters", publishedAt: hoursAgo(2) });
    const pointer = makeArticle({ title: "Lab ships a model", src: "ft", publishedAt: hoursAgo(2) });
    const articles = [lead, press, pointer];
    const { edition } = makeEdition({ articles, rows: { industry: [lead.id] }, clusters: { [lead.id]: { members: [press.id, pointer.id], publishers: 2 } }, top: [lead.id], sources });
    const river = makeRiver(articles, { sources, leads: { [press.id]: lead.id, [pointer.id]: lead.id } });
    const b = buildBriefing({ edition, river, saved: NO_SAVED, matcher: NO_TERMS, mutes: NO_MUTES, nowMs: NOW, todayStartMs: TODAY });
    assert.deepEqual(splitAlso(b.top[0]).map((list) => list.map((o) => o.name)), [["Reuters"], ["Financial Times"]]);
    const md = briefingMarkdown(b).split("\n");
    const first = md.findIndex((l) => l.startsWith("1. "));
    assert.ok(md[first].endsWith("(2 outlets)"), md[first]);
    assert.equal(md[first + 1], `   Also: [Reuters](${press.url})`);
    assert.equal(md[first + 2], `   Also linked: [Financial Times](${pointer.url})`);
    const text = briefingText(b);
    assert.ok(text.includes("   Also: Reuters\n   Also linked: Financial Times"));
    assert.deepEqual(splitAlso({ publishers: 1, also: ["x"] }), [[], ["x"]]);
    assert.deepEqual(splitAlso({ publishers: 5, also: ["x", "y"] }), [["x", "y"], []]);
  });

  it("has the documented shape: numbered bold link, em dash, source, outlet count, indented Also line", () => {
    const w = world();
    const md = briefingMarkdown(buildBriefing(input(w)));
    const lines = md.split("\n");
    assert.equal(lines[0], `# AI DRUDGE briefing — ${formatUtc(w.edition.meta.generatedAt)}`);
    const first = lines.findIndex((l) => l.startsWith("1. "));
    assert.equal(lines[first], "1. **[Anthropic valued at $2tn \\[live\\] \\*record\\* IPO \\#1](https://guardian.example/live_%28ipo%29)** — The Guardian (3 outlets)");
    assert.equal(lines[first + 1], `   Also: [Reuters](${w.m1.url}), [Financial Times](${w.m3.url})`);
    assert.equal(lines[first + 2], `2. **[OpenAI ships GPT-6.2](${w.second.url})** — The Verge (2 outlets)`);
    assert.equal(lines[first + 4], `3. **[Solo story](${w.single.url})** — Financial Times`, "a single-outlet story has no count and no Also line");
    for (const l of lines.filter((x) => /^\d+\. /.test(x))) assert.match(l, /^\d+\. \*\*\[.+\]\(https?:\/\/[^)\s]+\)\*\* — .+$/);
  });

  it("escapes Markdown metacharacters in titles, outlet names and watch terms", () => {
    const evil = makeArticle({ title: "Ignore [this](https://evil.example) **now**\n# Heading `x` <script>", src: "evil" });
    const also = makeArticle({ title: "Other", src: "also" });
    const hit = makeArticle({ title: "A_B* term [hit]", src: "also", home: "tools", publishedAt: hoursAgo(1) });
    const srcs = { evil: makeSourceRef({ name: "Evil", publisher: "Evil [Corp]" }), also: makeSourceRef({ name: "Also_Name", publisher: "Al*so" }) };
    const { edition } = makeEdition({ articles: [evil, also, hit], rows: { industry: [evil.id], tools: [hit.id] }, clusters: { [evil.id]: [also.id] }, top: [evil.id], sources: srcs });
    const river = makeRiver([evil, also, hit], { sources: srcs, leads: { [also.id]: evil.id } });
    const b = buildBriefing({ edition, river, saved: NO_SAVED, matcher: compileTerms(["a_b*"]), mutes: NO_MUTES, nowMs: NOW, todayStartMs: TODAY });
    const md = briefingMarkdown(b);
    assert.ok(md.includes("1. **[Ignore \\[this\\](https://evil.example) \\*\\*now\\*\\* \\# Heading \\`x\\` \\<script\\>]("), md);
    assert.ok(md.includes("— Evil \\[Corp\\] (2 outlets)"));
    assert.ok(md.includes("   Also: [Al\\*so]("));
    assert.ok(md.includes("- [A\\_B\\* term \\[hit\\]]("));
    assert.ok(md.includes("— Also\\_Name · matched: a\\_b\\*"));
    assert.equal(md.split("\n").filter((l) => l.startsWith("# ")).length, 1, "a title cannot inject a heading");
    assert.ok(!/(^|[^\\])\[this\]\(https:\/\/evil\.example\)/.test(md), "a title cannot inject a link");
  });

  it("sections, the parts filter and the provenance line", () => {
    const w = world();
    const saved: SavedState = { bookmarks: new Set([w.single.id]), later: new Set(), snapshots: { [w.single.id]: snapshot(w.single, new Date(NOW - HOUR_MS).toISOString()) } };
    const b = buildBriefing(input(w, { saved, matcher: compileTerms(["Qwen"]) }));
    const md = briefingMarkdown(b);
    assert.deepEqual(md.split("\n").filter((l) => l.startsWith("## ")), ["## Top stories", "## Watchlist hits (last 24 h)", "## Bookmarked today"]);
    assert.ok(md.includes(`- [Qwen 4 quantized builds land](${w.qwenNew.url}) — Qwen Blog · matched: Qwen`));
    assert.ok(md.includes(`- [Solo story](${w.single.url}) — FT AI`));
    assert.match(md, /\n---\nEdition \d{4}-\d\d-\d\d \d\d:\d\d UTC · build .+ · Headlines and outlet names are the publishers' own; this briefing contains no AI-generated text\.\n$/);
    const onlyWatch = briefingMarkdown(b, { top: false, watch: true, bookmarks: false });
    assert.deepEqual(onlyWatch.split("\n").filter((l) => l.startsWith("## ")), ["## Watchlist hits (last 24 h)"]);
    assert.ok(briefingMarkdown(b, { top: false, watch: false, bookmarks: false }).includes("_Nothing to report._"));
    assert.deepEqual(ALL_PARTS, { top: true, watch: true, bookmarks: true });
  });

  it("plain text carries the same content without Markdown syntax", () => {
    const w = world();
    const text = briefingText(buildBriefing(input(w, { matcher: compileTerms(["Qwen"]) })));
    const lines = text.split("\n");
    const first = lines.findIndex((l) => l.startsWith("1. "));
    assert.equal(lines[first], "1. Anthropic valued at $2tn [live] *record* IPO #1 - The Guardian (3 outlets)");
    assert.equal(lines[first + 1], "   https://guardian.example/live_%28ipo%29");
    assert.equal(lines[first + 2], "   Also: Reuters, Financial Times");
    assert.ok(text.includes("WATCHLIST HITS (LAST 24 H)"));
    assert.ok(text.includes("- Qwen 4 quantized builds land - Qwen Blog [Qwen]"));
    assert.ok(!text.includes("**") && !text.includes("]("));
    assert.match(text, /no AI-generated text\.\n$/);
  });

  it("formatUtc and briefingFilename are derived from the edition time", () => {
    assert.equal(formatUtc("2026-11-19T20:08:38.159Z"), "2026-11-19 20:08 UTC");
    assert.equal(formatUtc("not a date"), "not a date");
    const w = world();
    const b = buildBriefing(input(w));
    assert.match(briefingFilename(b), /^ai-drudge-briefing-\d{4}-\d\d-\d\d-\d{4}\.md$/);
    assert.equal(briefingFilename({ ...b, generatedAt: "x" }), "ai-drudge-briefing.md");
  });

  it("builds a non-empty briefing from the committed fixture", () => {
    const e = fixtureEdition();
    // "AI" is in the headlines of any day of an AI news site; nothing of the frozen day is pinned.
    const b = buildBriefing({ edition: e, river: fixtureRiver, saved: NO_SAVED, matcher: compileTerms(["AI"], { plural: true }), mutes: NO_MUTES, nowMs: Date.parse(e.meta.generatedAt), todayStartMs: 0 });
    const md = briefingMarkdown(b);
    const at = e.meta.generatedAt;
    assert.ok(md.startsWith(`# AI DRUDGE briefing — ${at.slice(0, 10)} ${at.slice(11, 16)} UTC\n`), md.slice(0, 80));
    const lead = e.articles[fixtureStory("multiPublisherLead")];
    const first = md.split("\n").find((l) => l.startsWith("1. "));
    assert.equal(first, `1. **${markdownLink(lead.title, lead.url)}** — ${escapeMarkdown(publisherName(e, lead))} (${e.clusters[lead.id].publishers} outlets)`);
    assert.match(md, /\n {3}Also: \[/);
    assert.equal(b.top.length, Math.min(BRIEFING_TOP_LIMIT, e.top.length));
    assert.ok(b.watch.length > 0);
    // A watch hit is never a story the top list already has.
    const inTop = new Set(b.top.map((s) => s.id));
    assert.ok(b.watch.every((h) => !inTop.has(h.id)));

    // Muting the lead's source re-leads the story from another outlet: same key, another article.
    const muted = buildBriefing({ edition: e, river: null, saved: NO_SAVED, matcher: NO_TERMS, mutes: { sources: new Set([lead.src]), sections: new Set() }, nowMs: Date.parse(e.meta.generatedAt), todayStartMs: 0 });
    assert.equal(muted.top[0].id, lead.id);
    assert.notEqual(muted.top[0].url, lead.url);
    assert.ok(e.clusters[lead.id].members.some((m) => e.articles[m].url === muted.top[0].url), "the exported article is another outlet's article of the same story");
  });
});
