import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MUTES, type MuteSet } from "../../../shared/select";
import { parseQuery } from "../../../shared/text";
import { hoursAgo, makeArticle, makeEdition, makeRiver, makeSourceRef } from "../../../test/helpers/factories";
import { RIVER } from "../../../shared/contract";
import { ABSENT_WORD, titleWords } from "../../../test/helpers/fixtureCases";
import { fixtureEdition, fixtureRiver } from "../../../test/helpers/fixtureData";
import { buildSearchView, isNameOnlyMatch, matchContext, searchTitle, sourceContext, watchState, watchTermFor, type SearchView } from "./model";

const sources = {
  guardian: makeSourceRef({ name: "The Guardian AI", publisher: "The Guardian" }),
  stratechery: makeSourceRef({ name: "Stratechery", publisher: "Stratechery" }),
  record: makeSourceRef({ name: "The Record", publisher: "Recorded Future News" }),
  verge: makeSourceRef({ name: "The Verge AI", publisher: "The Verge" }),
};

function world() {
  const ipo = makeArticle({ title: "Anthropic valued at $2tn after record-breaking IPO", src: "guardian", publishedAt: hoursAgo(1) });
  const ipoTwin = makeArticle({ title: "Wall Street greets the Claude maker", src: "verge", publishedAt: hoursAgo(2) });
  const anthropicOnly = makeArticle({ title: "Anthropic opens a Tokyo office", src: "verge", publishedAt: hoursAgo(3) });
  const summaryHit = makeArticle({ title: "Chip export rules tighten", src: "verge", summary: "Officials said Nvidia and AMD would both need licences for the new accelerators.", publishedAt: hoursAgo(4) });
  const tailApple = makeArticle({ title: "Apple’s on-device model leaks", src: "stratechery", home: "analysis", publishedAt: hoursAgo(5) });
  const cyberApple = makeArticle({ title: "Apple patches a zero-day", src: "record", home: "cyber", publishedAt: hoursAgo(6) });
  const filler = Array.from({ length: 3 }, (_, i) => makeArticle({ title: `Analysis filler ${i}`, src: "stratechery", home: "analysis", publishedAt: hoursAgo(7 + i) }));
  const riverOnly = makeArticle({ title: "Apple and Anthropic IPO chatter from last week", src: "guardian", publishedAt: hoursAgo(120) });
  const riverTwin = makeArticle({ title: "Anthropic IPO chatter, second outlet", src: "verge", publishedAt: hoursAgo(121) });
  const inEdition = [ipo, ipoTwin, anthropicOnly, summaryHit, tailApple, cyberApple, ...filler];
  const built = makeEdition({
    articles: inEdition,
    rows: { industry: [ipo.id, anthropicOnly.id, summaryHit.id], analysis: [...filler.map((f) => f.id), tailApple.id], cyber: [cyberApple.id] },
    // The Apple story sits behind "view all": V1 search dropped it and its whole section.
    homeRows: { analysis: 3 },
    clusters: { [ipo.id]: [ipoTwin.id] },
    sources,
  });
  const river = makeRiver([...inEdition, riverOnly, riverTwin], { sources, leads: { [ipoTwin.id]: ipo.id, [riverTwin.id]: riverOnly.id } });
  return { ...built, river, ipo, ipoTwin, anthropicOnly, summaryHit, tailApple, cyberApple, riverOnly, riverTwin };
}

const ids = (v: SearchView): Record<string, string[]> => Object.fromEntries(v.groups.map((g) => [g.section, g.rows.map((r) => r.id)]));

describe("search/model - buildSearchView", () => {
  it("multi-word queries are AND: both words must be found (V1 returned 1 of 16 for 'anthropic ipo')", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "anthropic ipo", mutes: NO_MUTES });
    assert.deepEqual(v.words, ["anthropic", "ipo"]);
    assert.deepEqual(ids(v), { industry: [w.ipo.id, w.riverOnly.id] });
    assert.equal(v.total, 2);
    assert.equal(v.fromRiver, 1);
    const one = buildSearchView({ edition: w.edition, river: w.river, query: "anthropic", mutes: NO_MUTES });
    assert.deepEqual(ids(one).industry, [w.ipo.id, w.anthropicOnly.id, w.riverOnly.id]);
  });

  it("finds matches that sit only in a section's view-all tail and keeps that section (V1: 'No headlines match')", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: null, query: "apple", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { cyber: [w.cyberApple.id], analysis: [w.tailApple.id] });
    const frontOnly = buildSearchView({ edition: w.frontOnly, river: null, query: "apple", mutes: NO_MUTES });
    assert.deepEqual(ids(frontOnly), { cyber: [w.cyberApple.id] }, "before rest.json only homepage rows are known");
  });

  it("river tail: stories off the edition are appended per section, one row per story, never a repeat", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "ipo", mutes: NO_MUTES });
    const rows = v.groups.find((g) => g.section === "industry")!.rows;
    assert.deepEqual(rows.map((r) => [r.id, r.origin]), [
      [w.ipo.id, "edition"],
      [w.riverOnly.id, "river"],
    ]);
    assert.equal(rows[1].item?.title, "Apple and Anthropic IPO chatter from last week");
    assert.equal(rows[0].item, undefined, "edition rows are rendered from the edition");
    assert.ok(!rows.some((r) => r.id === w.riverTwin.id), "the second outlet of the river story is collapsed");
    assert.ok(!rows.some((r) => r.id === w.ipoTwin.id), "members of an edition story are not repeated from the river");
  });

  it("works from the river alone while the edition is unavailable", () => {
    const w = world();
    const v = buildSearchView({ edition: null, river: w.river, query: "apple", mutes: NO_MUTES });
    assert.equal(v.total, 3);
    assert.equal(v.fromRiver, 3);
    assert.deepEqual(v.groups.map((g) => g.section), ["industry", "cyber", "analysis"]);
  });

  it("groups are in homepage order with counts; a blank query has no groups", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "  apple  ", mutes: NO_MUTES });
    const order = v.groups.map((g) => g.section);
    assert.deepEqual(order, ["industry", "cyber", "analysis"]);
    assert.equal(v.groups[0].label, "INDUSTRY");
    assert.equal(v.total, v.groups.reduce((n, g) => n + g.rows.length, 0));
    assert.deepEqual(buildSearchView({ edition: w.edition, river: w.river, query: "   ", mutes: NO_MUTES }), {
      query: "",
      words: [],
      blank: true,
      groups: [],
      total: 0,
      fromRiver: 0,
      bySource: [],
      sourceWords: "",
      section: null,
      inSections: [],
      fromSources: [],
      unknownSections: [],
    });
    assert.equal(buildSearchView({ edition: w.edition, river: w.river, query: "source: section:", mutes: NO_MUTES }).blank, true, "operators without a value ask for nothing");
  });

  it("a story placed in two sections is listed once: under its home section, or the only section that matched", () => {
    const routed = makeArticle({ title: "Agent sandbox escapes via prompt injection", src: "verge", home: "tools", publishedAt: hoursAgo(1) });
    const other = makeArticle({ title: "Prompt injection roundup", src: "record", home: "ai_security", publishedAt: hoursAgo(2) });
    const { edition } = makeEdition({ articles: [routed, other], rows: { ai_security: [routed.id, other.id], tools: [routed.id] }, sources });
    const v = buildSearchView({ edition, river: null, query: "prompt injection", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { ai_security: [other.id], tools: [routed.id] });
    assert.equal(v.total, 2);
    assert.equal(v.total, v.groups.reduce((n, g) => n + g.rows.length, 0));
    // Section names are not search words ...
    assert.deepEqual(ids(buildSearchView({ edition, river: null, query: "ai security sandbox", mutes: NO_MUTES })), {});
    // ... section: is: the story is listed under the only section searched, routed or not.
    assert.deepEqual(ids(buildSearchView({ edition, river: null, query: "section:ai_security sandbox", mutes: NO_MUTES })), { ai_security: [routed.id] });
    assert.deepEqual(ids(buildSearchView({ edition, river: null, query: "section:tools prompt", mutes: NO_MUTES })), { tools: [routed.id] });
  });

  it("normalises case, curly quotes and quoted phrases", () => {
    const w = world();
    assert.deepEqual(ids(buildSearchView({ edition: w.edition, river: null, query: "APPLE'S", mutes: NO_MUTES })), { analysis: [w.tailApple.id] });
    assert.deepEqual(ids(buildSearchView({ edition: w.edition, river: null, query: '"record-breaking ipo"', mutes: NO_MUTES })), { industry: [w.ipo.id] });
    assert.deepEqual(ids(buildSearchView({ edition: w.edition, river: null, query: '"ipo record-breaking"', mutes: NO_MUTES })), {});
  });

  it("matches summaries and other outlets' headlines, and says where", () => {
    const w = world();
    const bySummary = buildSearchView({ edition: w.edition, river: null, query: "nvidia", mutes: NO_MUTES });
    assert.deepEqual(ids(bySummary), { industry: [w.summaryHit.id] });
    assert.equal(bySummary.groups[0].rows[0].context?.place, "summary");
    assert.match(bySummary.groups[0].rows[0].context?.text ?? "", /Nvidia and AMD/);

    const byMember = buildSearchView({ edition: w.edition, river: null, query: "wall street", mutes: NO_MUTES });
    assert.deepEqual(ids(byMember), { industry: [w.ipo.id] });
    assert.deepEqual(byMember.groups[0].rows[0].context, { place: "coverage", text: "The Verge: Wall Street greets the Claude maker" });

    const titleHit = buildSearchView({ edition: w.edition, river: null, query: "tokyo", mutes: NO_MUTES });
    assert.equal(titleHit.groups[0].rows[0].context, undefined, "a title match needs no explanation");
    assert.deepEqual([titleHit.bySource, titleHit.sourceWords, titleHit.section], [[], "", null]);
  });

  it("headline matches come first in a section, then summary matches, then other outlets' headlines", () => {
    const first = makeArticle({ title: "Export rules tighten for accelerators", src: "verge", summary: "Officials said Nvidia would need licences.", publishedAt: hoursAgo(1) });
    const second = makeArticle({ title: "Chip stocks slide", src: "guardian", publishedAt: hoursAgo(2) });
    const secondTwin = makeArticle({ title: "Nvidia leads a chip sell-off", src: "verge", publishedAt: hoursAgo(2.5) });
    const third = makeArticle({ title: "Nvidia reports a record quarter", src: "guardian", publishedAt: hoursAgo(3) });
    const old = makeArticle({ title: "Nvidia last week", src: "guardian", publishedAt: hoursAgo(100) });
    const inEdition = [first, second, secondTwin, third];
    const { edition } = makeEdition({ articles: inEdition, rows: { industry: [second.id, first.id, third.id] }, clusters: { [second.id]: [secondTwin.id] }, sources });
    const v = buildSearchView({ edition, river: makeRiver([...inEdition, old], { sources, leads: { [secondTwin.id]: second.id } }), query: "nvidia", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { industry: [third.id, first.id, second.id, old.id] }, "ranked: coverage, summary, title - listed: title, summary, coverage, then the archive");
    assert.deepEqual(v.groups[0].rows.map((r) => r.context?.place), [undefined, "summary", "coverage", undefined]);
  });

  it("stories found only by a source or publisher name are listed apart and not counted (query feeds match their own name)", () => {
    // Live edition, #/q/FINRA: 7 results, 6 of them off-topic stories of the "GN: AI x SEC/FINRA" query feed.
    const feeds = {
      gn: makeSourceRef({ name: "GN: AI x SEC/FINRA", publisher: "Google News" }),
      wire: makeSourceRef({ name: "Compliance Wire", publisher: "Compliance Wire" }),
    };
    const noiseA = makeArticle({ title: "Google opens Singapore engineering center", src: "gn", home: "policy", publishedAt: hoursAgo(1) });
    const noiseB = makeArticle({ title: "Former SEC chair warns of an AI bubble", src: "gn", home: "industry", publishedAt: hoursAgo(2) });
    const inSummary = makeArticle({ title: "Broker-dealers get new AI guidance", src: "wire", home: "policy", summary: "The notice from FINRA covers Rule 2210.", publishedAt: hoursAgo(3) });
    const inTitle = makeArticle({ title: "FINRA Regulatory Notice 26-24 on AI communications", src: "wire", home: "policy", publishedAt: hoursAgo(4) });
    const riverTitle = makeArticle({ title: "FINRA fines a firm over chatbot records", src: "wire", home: "policy", publishedAt: hoursAgo(100) });
    const riverNoise = makeArticle({ title: "Loan AI reports no revenue", src: "gn", home: "policy", publishedAt: hoursAgo(90) });
    const riverNoiseTwin = makeArticle({ title: "Loan AI: no revenue, second copy", src: "gn", home: "policy", publishedAt: hoursAgo(91) });
    const inEdition = [noiseA, noiseB, inSummary, inTitle];
    const { edition } = makeEdition({ articles: inEdition, rows: { policy: [noiseA.id, inSummary.id, inTitle.id], industry: [noiseB.id] }, sources: feeds });
    const river = makeRiver([...inEdition, riverNoise, riverNoiseTwin, riverTitle], { sources: feeds, leads: { [riverNoiseTwin.id]: riverNoise.id } });

    const v = buildSearchView({ edition, river, query: "FINRA", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { policy: [inTitle.id, inSummary.id, riverTitle.id] }, "what the stories say: headline, summary, then the archive");
    assert.equal(v.total, 3, "only stories that mention FINRA are counted");
    assert.equal(v.fromRiver, 1);
    assert.deepEqual(v.bySource.map((r) => [r.id, r.origin]), [[noiseB.id, "edition"], [noiseA.id, "edition"], [riverNoise.id, "river"]], "apart, in section order, one row per story");
    assert.deepEqual(v.bySource.map(isNameOnlyMatch), [true, true, true]);
    for (const r of v.bySource) assert.deepEqual(r.context, { place: "source", text: "GN: AI x SEC/FINRA", words: ["finra"] }, "and they say why they are listed");
    assert.equal(v.sourceWords, "FINRA", "as typed");
    assert.ok(!v.groups.some((g) => g.rows.some(isNameOnlyMatch)));

    // One word in the story, one only in the feed name: still not a match of the story.
    const mixed = buildSearchView({ edition, river, query: '"sec chair" finra', mutes: NO_MUTES });
    assert.deepEqual([mixed.total, mixed.bySource.map((r) => r.id), mixed.sourceWords], [0, [noiseB.id], "finra"]);
    assert.deepEqual(mixed.bySource[0].context, { place: "source", text: "GN: AI x SEC/FINRA", words: ["finra"] });

    // source: asks for the feed on purpose: its stories are the results.
    const explicit = buildSearchView({ edition, river, query: "source:finra", mutes: NO_MUTES });
    assert.deepEqual(ids(explicit), { industry: [noiseB.id], policy: [noiseA.id, riverNoise.id] });
    assert.deepEqual([explicit.total, explicit.bySource.length, explicit.fromSources, explicit.words], [3, 0, ["finra"], []]);
    assert.deepEqual(ids(buildSearchView({ edition, river, query: "source:finra bubble", mutes: NO_MUTES })), { industry: [noiseB.id] });
  });

  it("source: explains a story that is listed for another outlet than the one on display", () => {
    const w = world();
    // The IPO story is led by The Guardian; The Verge covers it too.
    const v = buildSearchView({ edition: w.edition, river: null, query: "source:verge ipo", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { industry: [w.ipo.id] });
    assert.deepEqual(v.groups[0].rows[0].context, { place: "coverage", text: "The Verge: Wall Street greets the Claude maker" });
    const own = buildSearchView({ edition: w.edition, river: null, query: "source:guardian ipo", mutes: NO_MUTES });
    assert.equal(own.groups[0].rows[0].context, undefined, "the outlet on display is the one asked for");
    assert.equal(sourceContext(w.edition, w.ipo.id, []), undefined);
    assert.equal(sourceContext(w.edition, "nope", ["verge"]), undefined);
  });

  it("a river story one outlet names in its headline is not repeated among the source-name matches", () => {
    const feeds = { gn: makeSourceRef({ name: "GN: FINRA", publisher: "Google News" }), wire: makeSourceRef({ name: "Wire", publisher: "Wire" }) };
    const lead = makeArticle({ title: "Regulator fines a broker", src: "gn", home: "policy", publishedAt: hoursAgo(100) });
    const twin = makeArticle({ title: "FINRA fines a broker", src: "wire", home: "policy", publishedAt: hoursAgo(101) });
    const v = buildSearchView({ edition: null, river: makeRiver([lead, twin], { sources: feeds, leads: { [twin.id]: lead.id } }), query: "finra", mutes: NO_MUTES });
    assert.deepEqual([ids(v), v.bySource], [{ policy: [twin.id] }, []]);
  });

  it("a query that is a section name gets a link to the section; the label itself matches nothing", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "Cyber Wire", mutes: NO_MUTES });
    assert.deepEqual(v.section, { id: "cyber", label: "CYBER WIRE" });
    assert.deepEqual([v.total, v.groups, v.bySource, v.blank], [0, [], [], false], "the Apple zero-day story of that section does not say 'cyber wire'");
    for (const q of ["analysis", "ANALYSIS", "ai sec", '"ai security"', "local", "markets & deals"]) assert.ok(buildSearchView({ edition: w.edition, river: null, query: q, mutes: NO_MUTES }).section, q);
    assert.equal(buildSearchView({ edition: w.edition, river: null, query: "apple", mutes: NO_MUTES }).section, null);
    assert.equal(buildSearchView({ edition: w.edition, river: null, query: "section:cyber", mutes: NO_MUTES }).section, null, "an operator already asks for the section");
  });

  it("section: narrows both corpora; an unknown section is reported", () => {
    const w = world();
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "section:cyber apple", mutes: NO_MUTES });
    assert.deepEqual(ids(v), { cyber: [w.cyberApple.id] });
    assert.deepEqual([v.inSections, v.words, v.unknownSections], [[{ id: "cyber", label: "CYBER WIRE" }], ["apple"], []]);
    const whole = buildSearchView({ edition: w.edition, river: w.river, query: "section:industry", mutes: NO_MUTES });
    assert.deepEqual(ids(whole), { industry: [w.ipo.id, w.anthropicOnly.id, w.summaryHit.id, w.riverOnly.id] }, "no word: the section's ranked rows, then its archive");
    assert.equal(whole.blank, false);
    const bad = buildSearchView({ edition: w.edition, river: w.river, query: "section:nosuch apple", mutes: NO_MUTES });
    assert.deepEqual([bad.total, bad.unknownSections, bad.inSections, bad.blank], [0, ["nosuch"], [], false]);
  });

  it("matchContext returns undefined for an unknown id and for a full title match", () => {
    const w = world();
    assert.equal(matchContext(w.edition, "nope", ["x"]), undefined);
    assert.equal(matchContext(w.edition, w.ipo.id, parseQuery("anthropic ipo")), undefined);
    assert.equal(matchContext(w.edition, w.ipo.id, []), undefined);
    // A word no part of the story holds: the name that holds it, whatever else the summary says.
    assert.deepEqual(matchContext(w.edition, w.summaryHit.id, parseQuery("nvidia verge")), { place: "source", text: "The Verge AI", words: ["verge"] });
    // Words are matched as the search matches them: "intel" is not in "intelligence".
    assert.deepEqual(matchContext(w.edition, w.tailApple.id, parseQuery("stratechery apple")), { place: "source", text: "Stratechery", words: ["stratechery"] });
  });

  it("muted sources and sections are excluded from both corpora", () => {
    const w = world();
    const mutes: MuteSet = { sources: new Set(["guardian"]), sections: new Set(["cyber"]) };
    const v = buildSearchView({ edition: w.edition, river: w.river, query: "apple", mutes });
    assert.deepEqual(ids(v), { analysis: [w.tailApple.id] });
    const ipo = buildSearchView({ edition: w.edition, river: w.river, query: "ipo", mutes });
    assert.deepEqual(ids(ipo), { industry: [w.riverTwin.id] }, "the other outlet's copy of the river story remains");
  });

  it("searches the whole corpus of the committed fixture", () => {
    const e = fixtureEdition();
    // The word most headlines of the fixture's week carry, and one a few carry - whatever that week's news is.
    const words = titleWords(fixtureRiver.rows.map((r) => r[RIVER.title]));
    const busy = words[0].word.toLowerCase();
    const both = buildSearchView({ edition: e, river: fixtureRiver, query: busy, mutes: NO_MUTES });
    const editionOnly = buildSearchView({ edition: e, river: null, query: busy, mutes: NO_MUTES });
    assert.ok(editionOnly.total >= 5, `edition matches: ${editionOnly.total}`);
    assert.ok(both.total > editionOnly.total, "the river adds stories that left the edition");
    assert.equal(both.total, both.groups.reduce((n, g) => n + g.rows.length, 0), "group counts add up to the total");
    assert.equal(both.total - both.fromRiver, editionOnly.total);
    const seen = new Set<string>();
    for (const g of both.groups) for (const r of g.rows) if (r.origin === "river") {
      assert.ok(!seen.has(r.id), "a river story is listed once");
      seen.add(r.id);
      assert.ok(!e.articles[r.id] || !editionOnly.groups.some((x) => x.rows.some((y) => y.id === r.id)));
    }
    // V1 printed "No headlines match" for a word only a few headlines of the week carried.
    const rare = words.find((w) => w.titles >= 2 && w.titles <= 4);
    assert.ok(rare, "fixture: a word in two to four headlines");
    const few = buildSearchView({ edition: e, river: fixtureRiver, query: rare.word.toLowerCase(), mutes: NO_MUTES });
    assert.ok(few.total >= 1, `${rare.word}: ${few.total} stories for ${rare.titles} headlines`);
    assert.ok(few.total < both.total, "a rare word finds fewer stories than the busiest one");
    const none = buildSearchView({ edition: e, river: fixtureRiver, query: ABSENT_WORD, mutes: NO_MUTES });
    assert.deepEqual([none.total, none.groups, none.bySource], [0, [], []]);
  });
});

describe("search/model - watch term and title", () => {
  it("watchTermFor drops quotes and collapses whitespace", () => {
    assert.equal(watchTermFor('  "prompt   injection"  '), "prompt injection");
    assert.equal(watchTermFor("“model theft”"), "model theft");
  });

  it("watchState: blank, available, watching (case-insensitive), too long", () => {
    assert.equal(watchState("  ", []), "blank");
    assert.equal(watchState("Qwen", ["MCP"]), "available");
    assert.equal(watchState('"qwen"', ["MCP", "Qwen"]), "watching");
    assert.equal(watchState("x".repeat(61), []), "blank");
  });

  it("searchTitle", () => {
    assert.equal(searchTitle({ name: "search", q: " nvidia " }), "Search: nvidia");
    assert.equal(searchTitle({ name: "search", q: "" }), "Search");
    assert.equal(searchTitle({ name: "home" }), "Search");
  });
});
