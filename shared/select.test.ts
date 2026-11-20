import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleV2 } from "./contract";
import {
  BuildMismatchError,
  NO_MUTES,
  WEIGHT_CLASSES,
  alsoOutlets,
  bySectionOrder,
  collapseStories,
  countNewSince,
  coverageOf,
  hasFlag,
  isMuted,
  latest,
  mergeEdition,
  publisherName,
  riverMatching,
  riverRows,
  riverSection,
  riverSince,
  parseSearch,
  searchEdition,
  searchMatchOf,
  searchRiver,
  sectionNamed,
  sectionOf,
  sectionRows,
  sectionsNamed,
  sourceName,
  storyNewestMs,
  storyOf,
  storyPassesTimeFilter,
  topStories,
  visibleLeads,
  visibleStory,
  weightClass,
  weightOf,
  type MuteSet,
  type SearchGroup,
  SOURCE_WHOLE_WORD_MAX,
  sourceValueMatches,
} from "./select";
import { compileTerms, normalizeForSearch } from "./text";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition, makeRiver, makeSourceRef, resetFactories } from "../test/helpers/factories";
import { commonTitleWord } from "../test/helpers/fixtureCases";
import { SECTIONS } from "./sections";
import { fixtureEdition, fixtureFront, fixtureRest, fixtureRiver } from "../test/helpers/fixtureData";

const mute = (sources: string[] = [], sections: string[] = []): MuteSet => ({ sources: new Set(sources), sections: new Set(sections) as MuteSet["sections"] });
/** The content matches of a search, without the name-only list and the per-row match kinds. */
const found = (groups: readonly SearchGroup[]): { section: string; rows: string[] }[] => groups.filter((g) => g.rows.length > 0).map((g) => ({ section: g.section, rows: g.rows }));
/** The name-only matches of a search. */
const byName = (groups: readonly SearchGroup[]): { section: string; rows: string[] }[] => groups.filter((g) => g.nameOnly.length > 0).map((g) => ({ section: g.section, rows: g.nameOnly }));

interface World {
  lead: ArticleV2;
  m1: ArticleV2;
  m2: ArticleV2;
  m3: ArticleV2;
  industry: ArticleV2[];
  cyber: ArticleV2;
  release: ArticleV2;
  built: ReturnType<typeof makeEdition>;
}

function world(): World {
  resetFactories();
  const lead = makeArticle({ title: "Anthropic prices IPO at $83 a share", src: "techcrunch-ai", publishedAt: hoursAgo(2), summary: "Above the projected range.", w: 2 });
  const m1 = makeArticle({ title: "Anthropic raises $81bn in record IPO", src: "ft-ai", publishedAt: hoursAgo(3) });
  const m2 = makeArticle({ title: "Anthropic IPO: what startups get", src: "techcrunch-startups", publishedAt: hoursAgo(4) });
  const m3 = makeArticle({ title: "Anthropic makes its Nasdaq début", src: "gn-reuters", pub: "Reuters", publishedAt: hoursAgo(5) });
  const industry = Array.from({ length: 14 }, (_, i) => makeArticle({ title: `Industry story ${i}`, src: i % 2 ? "the-verge-ai" : "wired-ai", publishedAt: hoursAgo(6 + i) }));
  const cyber = makeArticle({ title: "Prompt-injection worm hits MCP servers", home: "cyber", src: "bleepingcomputer", publishedAt: hoursAgo(1), firstSeenAt: hoursAgo(0.5) });
  const release = makeArticle({ title: "llama.cpp b12549 released", home: "releases", src: "gh-llama-cpp", flags: ["release"], publishedAt: hoursAgo(0.2), tier: 4, w: 0 });
  const built = makeEdition({
    articles: [lead, m1, m2, m3, ...industry, cyber, release],
    rows: { industry: [lead.id, ...industry.map((a) => a.id)], ai_security: [cyber.id], cyber: [cyber.id], releases: [release.id] },
    clusters: { [lead.id]: { members: [m1.id, m2.id, m3.id], publishers: 3 } },
    top: [lead.id],
    sources: {
      "techcrunch-ai": makeSourceRef({ name: "TechCrunch AI", publisher: "TechCrunch" }),
      "techcrunch-startups": makeSourceRef({ name: "TechCrunch Startups", publisher: "TechCrunch" }),
      "ft-ai": makeSourceRef({ name: "FT Artificial Intelligence", publisher: "Financial Times" }),
      "gn-reuters": makeSourceRef({ name: "Reuters AI (Google News)", publisher: "Google News", kind: "query" }),
      bleepingcomputer: makeSourceRef({ name: "BleepingComputer", publisher: "BleepingComputer" }),
    },
  });
  return { lead, m1, m2, m3, industry, cyber, release, built };
}

describe("shared/select mergeEdition", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("front only: homepage rows, not complete", () => {
    const e = mergeEdition(w.built.front, null);
    assert.equal(e.complete, false);
    assert.equal(sectionOf(e, "industry")?.rows.length, 12);
    assert.equal(sectionOf(e, "industry")?.homeCount, 12);
    assert.equal(sectionOf(e, "industry")?.total, 15);
    assert.equal(e.leadId, w.lead.id);
    assert.deepEqual(e.top, [w.lead.id]);
    assert.deepEqual(e.meta, { schemaVersion: 2, buildId: w.built.front.buildId, generatedAt: w.built.front.generatedAt });
  });

  it("front + rest: full rows, homeCount preserved, records merged, inputs untouched", () => {
    const before = JSON.stringify(w.built.front);
    const e = mergeEdition(w.built.front, w.built.rest);
    assert.equal(e.complete, true);
    assert.equal(sectionOf(e, "industry")?.rows.length, 15);
    assert.equal(sectionOf(e, "industry")?.homeCount, 12);
    assert.equal(Object.keys(e.articles).length, Object.keys(w.built.front.articles).length + Object.keys(w.built.rest.articles).length);
    assert.equal(JSON.stringify(w.built.front), before);
  });

  it("throws BuildMismatchError for a rest file of another build", () => {
    assert.throws(
      () => mergeEdition(w.built.front, { ...w.built.rest, buildId: "other" }),
      (err: unknown) => err instanceof BuildMismatchError && err.frontBuildId === w.built.front.buildId && err.otherBuildId === "other",
    );
  });

  it("merges the real fixture", () => {
    const e = mergeEdition(fixtureFront, fixtureRest);
    assert.equal(e.sections.length, SECTIONS.length);
    assert.equal(e.sections.reduce((n, s) => n + s.rows.length, 0), fixtureFront.counts.placements);
    assert.equal(new Set(e.sections.flatMap((s) => s.rows)).size, fixtureFront.counts.stories);
    // front.json rows are a prefix of the full list, and the two files share no article.
    for (const s of e.sections) assert.deepEqual(s.rows.slice(0, s.homeCount), fixtureFront.sections.find((x) => x.id === s.id)?.rows, s.id);
    assert.equal(Object.keys(e.articles).length, Object.keys(fixtureFront.articles).length + Object.keys(fixtureRest.articles).length);
    for (const s of e.sections) for (const id of s.rows) assert.ok(e.articles[id], `${s.id} row ${id}`);
  });
});

describe("shared/select stories and names", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("storyOf: lead, members, publishers; singleton; unknown id", () => {
    const e = w.built.edition;
    const s = storyOf(e, w.lead.id);
    assert.ok(s);
    assert.equal(s.lead.id, w.lead.id);
    assert.deepEqual(s.members.map((m) => m.id), [w.m1.id, w.m2.id, w.m3.id]);
    assert.equal(s.publishers, 3);
    assert.equal(s.key, w.lead.id);
    assert.deepEqual(storyOf(e, w.cyber.id), { key: w.cyber.id, lead: e.articles[w.cyber.id], members: [], publishers: 1 });
    assert.equal(storyOf(e, "ghost"), null);
    assert.equal(coverageOf(e, w.lead.id), 3);
    assert.equal(coverageOf(e, w.cyber.id), 1);
    assert.equal(coverageOf(e, "ghost"), 1);
  });

  it("sourceName / publisherName (link-host `pub` wins)", () => {
    const e = w.built.edition;
    assert.equal(sourceName(e, "techcrunch-ai"), "TechCrunch AI");
    assert.equal(sourceName(e, "unknown-id"), "unknown-id");
    assert.equal(publisherName(e, w.lead), "TechCrunch");
    assert.equal(publisherName(e, w.m3), "Reuters", "link-host outlet, not 'Google News'");
    assert.equal(publisherName(e, { ...w.lead, src: "unknown-id" }), "unknown-id");
  });

  it("alsoOutlets: one entry per other publisher, lead's publisher and mutes excluded", () => {
    const e = w.built.edition;
    assert.deepEqual(alsoOutlets(e, w.lead.id).map((o) => o.name), ["Financial Times", "Reuters"], "TechCrunch Startups is the lead's own publisher");
    assert.deepEqual(alsoOutlets(e, w.lead.id, mute(["ft-ai"])).map((o) => o.name), ["Reuters"]);
    assert.equal(alsoOutlets(e, w.lead.id)[0].article.id, w.m1.id);
    assert.deepEqual(alsoOutlets(e, w.cyber.id), []);
    assert.deepEqual(alsoOutlets(e, "ghost"), []);
  });

  it("topStories respects mutes: a muted lead source hands the story to the next outlet", () => {
    const e = w.built.edition;
    assert.deepEqual(topStories(e).map((s) => s.lead.id), [w.lead.id]);
    // Muting the outlet that leads a multi-publisher story must not remove the story (TP-02).
    const reled = topStories(e, mute(["techcrunch-ai"]));
    assert.deepEqual(reled.map((s) => [s.key, s.lead.id]), [[w.lead.id, w.m1.id]], "same key, led by the Financial Times article");
    assert.deepEqual(reled[0].members.map((m) => m.id), [w.m2.id, w.m3.id]);
    assert.equal(reled[0].publishers, 3, "Financial Times, TechCrunch (Startups feed), Reuters");
    // Every outlet muted: the story is gone.
    assert.deepEqual(topStories(e, mute(["techcrunch-ai", "ft-ai", "techcrunch-startups", "gn-reuters"])), []);
  });

  it("visibleStory: muted articles leave the story, the key never changes", () => {
    const e = w.built.edition;
    assert.deepEqual(visibleStory(e, w.lead.id), storyOf(e, w.lead.id), "no mutes: the pipeline's story");
    const memberMuted = visibleStory(e, w.lead.id, mute(["ft-ai"]));
    assert.equal(memberMuted?.lead.id, w.lead.id);
    assert.deepEqual(memberMuted?.members.map((m) => m.id), [w.m2.id, w.m3.id]);
    assert.equal(memberMuted?.publishers, 2, "TechCrunch + Reuters");
    const two = visibleStory(e, w.lead.id, mute(["techcrunch-ai", "ft-ai"]));
    assert.deepEqual([two?.key, two?.lead.id, two?.publishers], [w.lead.id, w.m2.id, 2]);
    assert.equal(visibleStory(e, w.cyber.id, mute(["bleepingcomputer"])), null, "a muted singleton is hidden");
    // The coverage count follows the publishers that COUNT: the pipeline lists one article per counted
    // publisher first, so of 4 names with publishers 2 the lead and the first member are the coverage.
    resetFactories();
    const lead = makeArticle({ src: "lab", title: "Lab ships a model" });
    const press = makeArticle({ src: "press", title: "Press on the model" });
    const changelog = makeArticle({ src: "changelog", title: "Model now available" });
    const thread = makeArticle({ src: "forum", title: "Discussion: the model" });
    const built = makeEdition({
      articles: [lead, press, changelog, thread],
      rows: { models: [lead.id] },
      clusters: { [lead.id]: { members: [press.id, changelog.id, thread.id], publishers: 2 } },
      sources: { lab: makeSourceRef({ publisher: "Lab" }), press: makeSourceRef({ publisher: "Press" }), changelog: makeSourceRef({ publisher: "Vendor" }), forum: makeSourceRef({ publisher: "Forum" }) },
    });
    assert.equal(visibleStory(built.edition, lead.id)?.publishers, 2);
    assert.equal(visibleStory(built.edition, lead.id, mute(["lab"]))?.publishers, 1, "2 coverage publishers minus the muted one");
    assert.equal(visibleStory(built.edition, lead.id, mute(["press"]))?.publishers, 1);
    // Muting an outlet that never counted (a thread, a changelog) leaves the number alone - it used
    // to drop to 1 ("+0") although both coverage publishers were still on the "Also:" line.
    assert.equal(visibleStory(built.edition, lead.id, mute(["forum"]))?.publishers, 2);
    assert.equal(visibleStory(built.edition, lead.id, mute(["changelog", "forum"]))?.publishers, 2);
    // Never more than the pipeline's count or the outlets still visible.
    assert.equal(visibleStory(built.edition, lead.id, mute(["lab", "press"]))?.publishers, 1, "Vendor leads; nothing that counted is left");
    assert.equal(visibleStory(built.edition, lead.id, mute(["press", "changelog", "forum"]))?.publishers, 1);
    assert.equal(visibleStory(e, "ghost", mute(["ft-ai"])), null);
    // The "Also:" line follows the article on display: its publisher is never repeated.
    assert.deepEqual(alsoOutlets(e, w.lead.id, mute(["techcrunch-ai"])).map((o) => o.name), ["TechCrunch", "Reuters"]);
    assert.deepEqual(alsoOutlets(e, w.lead.id, mute(["techcrunch-ai", "ft-ai"])).map((o) => o.name), ["Reuters"]);
    assert.deepEqual(alsoOutlets(e, w.lead.id, mute(["techcrunch-ai", "ft-ai", "techcrunch-startups", "gn-reuters"])), []);
  });

  it("weights and flags", () => {
    assert.equal(weightOf(w.lead), 2);
    assert.equal(weightOf(w.m1), 1, "absent w means 1");
    assert.equal(weightOf(w.release), 0);
    assert.equal(weightClass(w.lead), "headline-high");
    assert.equal(weightClass(w.m1), "headline-medium");
    assert.equal(weightClass(w.release), "headline-low");
    assert.equal(weightClass({ ...w.lead, w: 3 }), "headline-critical");
    assert.deepEqual([...WEIGHT_CLASSES], ["headline-low", "headline-medium", "headline-high", "headline-critical"]);
    assert.equal(hasFlag(w.release, "release"), true);
    assert.equal(hasFlag(w.lead, "release"), false);
    assert.equal(isMuted(w.lead, mute(["techcrunch-ai"])), true);
    assert.equal(isMuted(w.lead, NO_MUTES), false);
  });
});

describe("shared/select sections", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("sectionRows: homepage rows by default, everything with all:true", () => {
    const e = w.built.edition;
    assert.equal(sectionRows(e, "industry").length, 12);
    assert.equal(sectionRows(e, "industry", { all: true }).length, 15);
    assert.equal(sectionRows(w.built.frontOnly, "industry", { all: true }).length, 12, "rest not loaded yet");
    assert.deepEqual(sectionRows(e, "quantum"), []);
    assert.deepEqual(sectionRows(e, "nope" as never), []);
  });

  it("sectionRows: muted section -> [], muted source rows dropped", () => {
    const e = w.built.edition;
    assert.deepEqual(sectionRows(e, "industry", { mutes: mute([], ["industry"]) }), []);
    const rows = sectionRows(e, "industry", { all: true, mutes: mute(["wired-ai"]) });
    assert.equal(rows.length, 8);
    assert.ok(rows.every((id) => e.articles[id].src !== "wired-ai"));
  });

  it("sectionRows: a story whose LEAD source is muted keeps its row and id while another outlet covers it", () => {
    const e = w.built.edition;
    assert.equal(sectionRows(e, "industry", { all: true, mutes: mute(["techcrunch-ai"]) })[0], w.lead.id, "the row keeps the pipeline's lead id");
    assert.ok(visibleLeads(e, mute(["techcrunch-ai"])).includes(w.lead.id));
    assert.deepEqual(found(searchEdition(e, "anthropic ipo", mute(["techcrunch-ai"]))), [{ section: "industry", rows: [w.lead.id] }]);
    const all = mute(["techcrunch-ai", "ft-ai", "techcrunch-startups", "gn-reuters"]);
    assert.equal(sectionRows(e, "industry", { all: true, mutes: all }).includes(w.lead.id), false, "every outlet muted");
  });

  it("visibleLeads dedupes a story placed in two sections", () => {
    const e = w.built.edition;
    const ids = visibleLeads(e);
    assert.equal(ids.filter((id) => id === w.cyber.id).length, 1);
    assert.equal(ids.length, 17);
    assert.deepEqual(visibleLeads(e, NO_MUTES, { desks: ["utility"] }), [w.release.id]);
  });

  it("latest: newest first by effective time, release radar excluded by default, mutes respected", () => {
    const e = w.built.edition;
    assert.deepEqual(latest(e, 3), [w.cyber.id, w.lead.id, w.industry[0].id]);
    assert.equal(latest(e, 12).includes(w.release.id), false);
    assert.equal(latest(e, 3, NO_MUTES, { desks: ["ai", "owner", "utility"] })[0], w.release.id);
    assert.deepEqual(latest(e, 2, mute(["bleepingcomputer"])), [w.lead.id, w.industry[0].id]);
    assert.deepEqual(latest(e, 0), []);
    assert.equal(latest(e, 100).length, 16);
  });

  it("latest: undated items rank by firstSeenAt", () => {
    resetFactories();
    const dated = makeArticle({ publishedAt: hoursAgo(3) });
    const undated = makeArticle({ publishedAt: null, firstSeenAt: hoursAgo(1) });
    const { edition } = makeEdition({ articles: [dated, undated] });
    assert.deepEqual(latest(edition, 2), [undated.id, dated.id]);
  });

  it("countNewSince counts distinct visible stories by firstSeenAt", () => {
    const e = w.built.edition;
    assert.equal(countNewSince(e, FIXTURE_NOW_MS - 0.75 * 3_600_000), 2, "cyber (seen 0.5 h ago) + release");
    assert.equal(countNewSince(e, FIXTURE_NOW_MS - 0.75 * 3_600_000, mute([], ["releases"])), 1);
    assert.equal(countNewSince(e, FIXTURE_NOW_MS), 0);
    assert.equal(countNewSince(e, 0), 17);
  });

  it("a story is as new as its newest visible article (time chips, NEW, the new-since count)", () => {
    // The 30-publisher IPO story: the lead is 38 h old, an outlet joined minutes ago. The 24H chip hid it.
    resetFactories();
    const lead = makeArticle({ title: "Anthropic prices IPO", src: "lab", publishedAt: hoursAgo(38), firstSeenAt: hoursAgo(38) });
    const early = makeArticle({ title: "IPO priced", src: "press", publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const late = makeArticle({ title: "Shares jump on debut", src: "wire", publishedAt: hoursAgo(0.2), firstSeenAt: hoursAgo(0.1) });
    const thread = makeArticle({ title: "Old news, new thread", src: "forum", publishedAt: hoursAgo(90), firstSeenAt: hoursAgo(90) });
    const reply = makeArticle({ title: "Discussion: old news", src: "hn", flags: ["discussion"], publishedAt: hoursAgo(1), firstSeenAt: hoursAgo(1) });
    const single = makeArticle({ title: "A singleton from yesterday", src: "press", publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const { edition: e } = makeEdition({
      articles: [lead, early, late, thread, reply, single],
      rows: { industry: [lead.id, thread.id, single.id] },
      clusters: { [lead.id]: [early.id, late.id], [thread.id]: [reply.id] },
    });
    const now = FIXTURE_NOW_MS;
    const visit = now - 2 * 3_600_000;
    const pass = (id: string, f: Parameters<typeof storyPassesTimeFilter>[2], mutes = NO_MUTES): boolean => storyPassesTimeFilter(e, id, f, now, visit, mutes);
    assert.deepEqual([pass(lead.id, "6h"), pass(lead.id, "24h"), pass(lead.id, "3d"), pass(lead.id, "all")], [true, true, true, true]);
    assert.equal(pass(lead.id, "new"), true, "an outlet was first seen after the previous visit");
    assert.equal(storyPassesTimeFilter(e, lead.id, "new", now, null), true, "first visit: the NEW-badge rule (6 h) on the newest article");
    assert.equal(storyNewestMs(e, lead.id), Date.parse(hoursAgo(0.2)));
    // Mute the outlet that joined last: the story is as old as what is left of it.
    assert.deepEqual([pass(lead.id, "6h", mute(["wire"])), pass(lead.id, "24h", mute(["wire"])), pass(lead.id, "3d", mute(["wire"]))], [false, false, true]);
    assert.equal(pass(lead.id, "new", mute(["wire"])), false);
    assert.equal(storyNewestMs(e, lead.id, mute(["wire"])), Date.parse(hoursAgo(30)));
    // A community thread is not coverage: it never makes an old story new.
    assert.deepEqual([pass(thread.id, "24h"), pass(thread.id, "3d"), pass(thread.id, "new")], [false, false, false]);
    assert.equal(storyNewestMs(e, thread.id), Date.parse(hoursAgo(90)));
    // A singleton behaves as before; an unknown or fully muted story never passes.
    assert.deepEqual([pass(single.id, "24h"), pass(single.id, "3d")], [false, true]);
    assert.equal(pass("ghost", "all"), false);
    assert.equal(pass(single.id, "all", mute(["press"])), false);
    assert.equal(storyNewestMs(e, "ghost"), 0);
    assert.equal(countNewSince(e, visit), 1, "the IPO story counts as new since the visit; the thread story does not");
    assert.equal(countNewSince(e, visit, mute(["wire"])), 0);
  });

  it("bySectionOrder sorts in homepage order", () => {
    assert.deepEqual((["releases", "cyber", "models", "policy"] as const).slice().sort(bySectionOrder), ["models", "policy", "cyber", "releases"]);
  });
});

describe("shared/select searchEdition", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("multi-word AND, any order, normalised", () => {
    const e = w.built.edition;
    assert.deepEqual(found(searchEdition(e, "ipo anthropic")), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(found(searchEdition(e, "  ANTHROPIC   Ipo ")), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(searchEdition(e, "anthropic openai"), []);
    // Word-start matching (shared/text.ts queryWordPattern): a long prefix finds the story, a
    // fragment from the middle of a word does not, and a short word must be whole.
    assert.deepEqual(found(searchEdition(e, "anthrop ipo")), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(searchEdition(e, "nthropic"), []);
    assert.deepEqual(searchEdition(e, "anth"), []);
    assert.deepEqual(searchEdition(e, ""), []);
    assert.deepEqual(searchEdition(e, "   "), []);
  });

  it("says where a story matched: headline, summary, another outlet's headline (diacritics folded)", () => {
    const e = w.built.edition;
    const kind = (q: string): unknown => searchEdition(e, q)[0]?.matches[w.lead.id];
    assert.equal(kind("anthropic ipo"), "title");
    assert.equal(kind("projected range"), "summary");
    assert.equal(kind("nasdaq debut"), "coverage");
    assert.equal(kind("ipo nasdaq range"), "coverage", "the weakest place needed decides");
    assert.equal(searchEdition(e, "projected range")[0]?.rows[0], w.lead.id);
    assert.equal(searchMatchOf(e, w.lead.id, parseSearch("nasdaq")), "coverage");
    assert.equal(searchMatchOf(e, w.lead.id, parseSearch("zzz")), null);
    assert.equal(searchMatchOf(e, w.lead.id, parseSearch("  ")), null);
  });

  it("ranks headline matches first, then summary matches, then other outlets' headlines", () => {
    resetFactories();
    const viaMember = makeArticle({ title: "Chip export rules tighten", src: "wired-ai", publishedAt: hoursAgo(1) });
    const member = makeArticle({ title: "Nvidia needs licences for new accelerators", src: "the-verge-ai", publishedAt: hoursAgo(2) });
    const viaSummary = makeArticle({ title: "Markets wobble on export news", src: "wired-ai", summary: "Shares of Nvidia fell 3%.", publishedAt: hoursAgo(3) });
    const viaTitle = makeArticle({ title: "Nvidia reports record quarter", src: "wired-ai", publishedAt: hoursAgo(4) });
    const { edition: e } = makeEdition({ articles: [viaMember, member, viaSummary, viaTitle], rows: { industry: [viaMember.id, viaSummary.id, viaTitle.id] }, clusters: { [viaMember.id]: [member.id] } });
    const [g] = searchEdition(e, "nvidia");
    assert.deepEqual(g.rows, [viaTitle.id, viaSummary.id, viaMember.id], "the section rank was member, summary, title");
    assert.deepEqual(g.matches, { [viaTitle.id]: "title", [viaSummary.id]: "summary", [viaMember.id]: "coverage" });
    assert.deepEqual(g.nameOnly, []);
  });

  it("a story found only by the NAME of its source or publisher is reported apart, never among the matches", () => {
    const e = w.built.edition;
    for (const q of ["techcrunch", "financial times", "reuters"]) {
      const groups = searchEdition(e, q);
      assert.deepEqual(found(groups), [], `"${q}" is in no headline or summary`);
      assert.deepEqual(byName(groups), [{ section: "industry", rows: [w.lead.id] }], q);
      assert.equal(groups[0].matches[w.lead.id], "source");
    }
    // One word said by the story, the other only in a name: still a name match.
    assert.deepEqual(byName(searchEdition(e, "techcrunch ipo")), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(found(searchEdition(e, "techcrunch ipo")), []);
    // Source ids are not free-text: "gn" is the id prefix of the query feed, not its name.
    assert.deepEqual(searchEdition(e, "gn"), []);
  });

  it("section names are not search text (labels returned whole sections: \"local\" 39 of 45, \"SEC\" 75)", () => {
    resetFactories();
    const worm = makeArticle({ title: "An MCP config doctor that drops an infostealer", home: "ai_security", src: "bleepingcomputer", publishedAt: hoursAgo(1) });
    const secure = makeArticle({ title: "AI security teams brace for agent worms", home: "ai_security", src: "bleepingcomputer", publishedAt: hoursAgo(1.5) });
    const rule = makeArticle({ title: "SEC adopts AI disclosure rule for broker-dealers", home: "policy", src: "wired-ai", publishedAt: hoursAgo(2) });
    const deal = makeArticle({ title: "Chip startup raises a $2bn round", home: "money", src: "wired-ai", publishedAt: hoursAgo(3) });
    const fund = makeArticle({ title: "Where the money goes in AI infrastructure", home: "money", src: "wired-ai", publishedAt: hoursAgo(4) });
    const { edition: e } = makeEdition({ articles: [worm, secure, rule, deal, fund] });
    assert.deepEqual(searchEdition(e, "SEC").map((g) => [g.section, g.rows]), [["policy", [rule.id]]], "short code AI SEC is not a match");
    assert.deepEqual(found(searchEdition(e, "sec rule")), [{ section: "policy", rows: [rule.id] }]);
    assert.deepEqual(found(searchEdition(e, "money")), [{ section: "money", rows: [fund.id] }], "short code MONEY is not a match");
    // Neither is the full label: only the story that says "AI security" matches.
    assert.deepEqual(found(searchEdition(e, "ai security")), [{ section: "ai_security", rows: [secure.id] }]);
    assert.deepEqual(searchEdition(e, "ai security infostealer"), []);
    assert.deepEqual(searchEdition(e, "policy regulation"), []);
    assert.deepEqual(searchEdition(e, "release radar"), []);
  });

  it("section: narrows the search to a section (id, chip code, label, or a prefix)", () => {
    resetFactories();
    const worm = makeArticle({ title: "An MCP config doctor that drops an infostealer", home: "ai_security", src: "bleepingcomputer", publishedAt: hoursAgo(1) });
    const rule = makeArticle({ title: "SEC adopts AI disclosure rule for broker-dealers", home: "policy", src: "wired-ai", publishedAt: hoursAgo(2) });
    const law = makeArticle({ title: "State AI law clears committee", home: "policy", src: "the-verge-ai", publishedAt: hoursAgo(3) });
    const { edition: e } = makeEdition({ articles: [worm, rule, law] });
    assert.deepEqual(found(searchEdition(e, "section:policy")), [{ section: "policy", rows: [rule.id, law.id] }], "an operator alone lists the section");
    assert.deepEqual(found(searchEdition(e, "section:policy ai")), [{ section: "policy", rows: [rule.id, law.id] }]);
    assert.deepEqual(found(searchEdition(e, "ai section:POLICY law")), [{ section: "policy", rows: [law.id] }], "anywhere in the query, any case");
    assert.deepEqual(found(searchEdition(e, "section:ai_security infostealer")), [{ section: "ai_security", rows: [worm.id] }]);
    assert.deepEqual(found(searchEdition(e, 'section:"ai sec" infostealer')), [{ section: "ai_security", rows: [worm.id] }]);
    assert.deepEqual(found(searchEdition(e, "section:secur infostealer")), [{ section: "ai_security", rows: [worm.id] }], "prefix when nothing is exact");
    assert.deepEqual(searchEdition(e, "section:policy infostealer"), []);
    assert.deepEqual(searchEdition(e, "section:nosuch ai"), [], "an operator that names nothing matches nothing");
    assert.deepEqual(found(searchEdition(e, "section: config")).map((g) => g.section), ["ai_security"], "an operator without a value is ignored");
  });

  it("source: a value of up to three characters is an acronym and must be a whole word (source:sec is not every 'Security' source)", () => {
    assert.equal(SOURCE_WHOLE_WORD_MAX, 3);
    const names = (name: string, publisher: string, id: string): string => `${normalizeForSearch(name)} \n ${normalizeForSearch(publisher)} \n ${normalizeForSearch(id)}`;
    for (const [name, publisher, id] of [
      ["Google Security Blog", "Google", "google-security-blog"],
      ["Help Net Security: AI", "Help Net Security", "helpnetsecurity-ai"],
      ["OWASP GenAI Security", "OWASP", "owasp-genai-security"],
      ["Datadog Security Labs", "Datadog", "datadog-security-labs"],
    ]) {
      assert.equal(sourceValueMatches(names(name, publisher, id), "sec"), false, name);
      assert.equal(sourceValueMatches(names(name, publisher, id), "secur"), true, `${name}: a longer value is a prefix`);
    }
    for (const [name, publisher, id] of [
      ["SEC", "SEC", "sec-press-releases"],
      ["SEC Speeches", "SEC", "sec-speeches-statements"],
      ["tl;dr sec", "tl;dr sec", "tldr-sec"],
      ["GN: AI x SEC/FINRA", "Google News", "gn-ai-sec-finra"],
    ]) {
      assert.equal(sourceValueMatches(names(name, publisher, id), "sec"), true, name);
    }
    assert.equal(sourceValueMatches(names("FT Artificial Intelligence", "Financial Times", "ft-ai"), "ft"), true);
    assert.equal(sourceValueMatches(names("Software Analyst", "SACR", "sacr-software-analyst"), "ft"), false, "not mid-word, not a prefix");
    assert.equal(sourceValueMatches(names("TechCrunch AI", "TechCrunch", "techcrunch-ai"), "tech"), true, "four characters and more: prefix, as before");
    assert.equal(sourceValueMatches(names("SEC", "SEC", "sec-press-releases"), "sec-"), true, "an id prefix");
  });

  it("source: keeps stories with an article from that source, publisher or source id", () => {
    const e = w.built.edition;
    assert.deepEqual(found(searchEdition(e, "source:techcrunch")), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(found(searchEdition(e, "source:reuters ipo")), [{ section: "industry", rows: [w.lead.id] }], "a member's link-host outlet");
    assert.deepEqual(found(searchEdition(e, 'source:"financial times"')), [{ section: "industry", rows: [w.lead.id] }]);
    assert.deepEqual(found(searchEdition(e, "source:tech")), [{ section: "industry", rows: [w.lead.id] }], "prefix");
    assert.deepEqual(found(searchEdition(e, "source:gn-reuters")), [{ section: "industry", rows: [w.lead.id] }], "source id");
    assert.deepEqual(found(searchEdition(e, "source:bleepingcomputer")).map((g) => g.section), ["ai_security", "cyber"]);
    assert.deepEqual(searchEdition(e, "source:bleepingcomputer ipo"), []);
    assert.deepEqual(searchEdition(e, "source:techcrunch source:bleepingcomputer"), [], "every operator must match");
    assert.deepEqual(searchEdition(e, "source:techcrunch", mute(["techcrunch-ai", "techcrunch-startups"])), [], "muted articles are not searched");
    assert.equal(searchEdition(e, "source:techcrunch")[0].matches[w.lead.id], "title", "an explicit filter is a full match");
  });

  it("parseSearch splits operators from words; sectionNamed / sectionsNamed resolve names", () => {
    assert.deepEqual(parseSearch('  FINRA  source:"The Record" section:policy "rule 2210" '), { words: ["finra", "rule 2210"], sources: ["the record"], sections: ["policy"], unknownSections: [] });
    assert.deepEqual(parseSearch("section:policy section:local section:policy"), { words: [], sources: [], sections: ["policy", "open_local"], unknownSections: [] });
    assert.deepEqual(parseSearch("section:nope x"), { words: ["x"], sources: [], sections: [], unknownSections: ["nope"] });
    assert.deepEqual(parseSearch("source: section: x"), { words: ["x"], sources: [], sections: null, unknownSections: [] });
    assert.deepEqual(parseSearch("resource:x a:b"), { words: ["resource:x", "a:b"], sources: [], sections: null, unknownSections: [] }, "only whole operator names");
    assert.deepEqual(parseSearch(""), { words: [], sources: [], sections: null, unknownSections: [] });
    assert.deepEqual(["local", "LOCAL & OPEN MODELS", "open_local", "ai sec", "AI Security", "ai-security", "policy & regulation", "money"].map(sectionNamed), ["open_local", "open_local", "open_local", "ai_security", "ai_security", "ai_security", "policy", "money"]);
    assert.deepEqual(["security", "finra", "", "local models"].map(sectionNamed), [null, null, null, null]);
    assert.deepEqual(sectionsNamed("models"), ["models"], "exact wins over the prefix (LOCAL & OPEN MODELS)");
    assert.deepEqual(sectionsNamed("mod"), ["models", "open_local"]);
    assert.deepEqual(sectionsNamed("zzz"), []);
  });

  it("quoted phrases stay together; hyphen/dash variants fold", () => {
    const e = w.built.edition;
    assert.equal(searchEdition(e, '"prompt-injection worm"').length, 2);
    assert.deepEqual(searchEdition(e, '"worm prompt-injection"'), []);
    assert.equal(searchEdition(e, "prompt‑injection").length, 2, "non-breaking hyphen in the query");
  });

  it("a story in two sections appears in both groups, in homepage order; mutes apply", () => {
    const e = w.built.edition;
    assert.deepEqual(found(searchEdition(e, "mcp worm")), [
      { section: "ai_security", rows: [w.cyber.id] },
      { section: "cyber", rows: [w.cyber.id] },
    ]);
    assert.deepEqual(searchEdition(e, "mcp worm", mute([], ["cyber"])).map((g) => g.section), ["ai_security"]);
    assert.deepEqual(searchEdition(e, "mcp worm", mute(["bleepingcomputer"])), []);
  });

  it("searches rest rows only once rest is merged", () => {
    const tail = w.industry[13];
    assert.deepEqual(searchEdition(w.built.frontOnly, tail.title), []);
    assert.deepEqual(found(searchEdition(w.built.edition, `"${tail.title}"`)), [{ section: "industry", rows: [tail.id] }]);
  });

  it("finds the lead story of the real fixture by two words of its headline", () => {
    const e = fixtureEdition();
    assert.ok(e.leadId);
    // Whatever the frozen day's lead is: its two longest headline words, lower-cased, in the other order.
    const words = [...new Set(e.articles[e.leadId].title.match(/[A-Za-z]{4,}/g) ?? [])].sort((a, b) => b.length - a.length).slice(0, 2);
    assert.equal(words.length, 2, e.articles[e.leadId].title);
    const groups = searchEdition(e, words.reverse().join(" ").toLowerCase());
    assert.ok(groups.length >= 1);
    assert.ok(groups.some((g) => g.rows.includes(e.leadId ?? "")), "the lead story matches");
    assert.deepEqual(searchEdition(e, "zzzzqqqq-no-such-term"), []);
  });
});

describe("shared/select river", () => {
  it("riverRows expands tuples, newest first, applying mutes", () => {
    resetFactories();
    const a = makeArticle({ src: "wired-ai", publishedAt: hoursAgo(1), title: "SEC opens AI washing probe", home: "policy" });
    const b = makeArticle({ src: "the-verge-ai", publishedAt: hoursAgo(2), title: "Local LLMs on a Mac Studio", home: "open_local" });
    const c = makeArticle({ src: "wired-ai", publishedAt: null, firstSeenAt: hoursAgo(3), title: "Another SEC filing", home: "policy" });
    const river = makeRiver([c, a, b], { leads: { [c.id]: a.id } });
    const rows = riverRows(river);
    assert.deepEqual(rows.map((r) => r.id), [a.id, b.id, c.id]);
    // TP-01: an AI SECURITY row (short code "AI SEC") without the word is not a hit for "sec".
    const d = makeArticle({ src: "the-verge-ai", publishedAt: hoursAgo(4), title: "Prompt injection found in an agent framework", home: "ai_security" });
    const withSecurity = makeRiver([c, a, b, d], { leads: { [c.id]: a.id } });
    assert.deepEqual(searchRiver(withSecurity, "sec").rows.map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(searchRiver(withSecurity, "SEC").rows.map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(searchRiver(withSecurity, "ai security"), { rows: [], nameOnly: [] }, "the section label is not search text");
    assert.deepEqual(searchRiver(withSecurity, "section:ai_security agent").rows.map((r) => r.id), [d.id], "section: filters on the listed section");
    assert.deepEqual(searchRiver(withSecurity, "section:policy").rows.map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(rows[0], {
      id: a.id,
      title: a.title,
      url: a.url,
      sourceId: "wired-ai",
      sourceName: "Wired Ai",
      section: "policy",
      publishedAtMs: Date.parse(hoursAgo(1)),
      firstSeenAtMs: Date.parse(hoursAgo(1)),
      effectiveMs: Date.parse(hoursAgo(1)),
      leadId: null,
    });
    assert.equal(rows[2].publishedAtMs, null);
    assert.equal(rows[2].effectiveMs, Date.parse(hoursAgo(3)));
    assert.equal(rows[2].leadId, a.id);
    assert.deepEqual(riverRows(river, mute(["wired-ai"])).map((r) => r.id), [b.id]);
    assert.deepEqual(riverRows(river, mute([], ["policy"])).map((r) => r.id), [b.id]);

    assert.deepEqual(riverSince(river, FIXTURE_NOW_MS - 1.5 * 3_600_000).map((r) => r.id), [a.id]);
    assert.deepEqual(searchRiver(river, "sec").rows.map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(searchRiver(river, "sec probe").rows.map((r) => r.id), [a.id]);
    // A word found only in the source NAME is a name-only hit, reported apart from the title matches.
    const verge = searchRiver(river, "verge mac");
    assert.deepEqual([verge.rows, verge.nameOnly.map((r) => r.id)], [[], [b.id]]);
    assert.deepEqual(searchRiver(river, "wired").nameOnly.map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(searchRiver(river, "source:verge").rows.map((r) => r.id), [b.id], "source: matches the name ...");
    assert.deepEqual(searchRiver(river, "source:wired-ai sec").rows.map((r) => r.id), [a.id, c.id], "... or the source id");
    assert.deepEqual(searchRiver(river, "source:wired", mute(["wired-ai"])), { rows: [], nameOnly: [] });
    assert.deepEqual(searchRiver(river, "policy regulation"), { rows: [], nameOnly: [] });
    assert.deepEqual(searchRiver(river, ""), { rows: [], nameOnly: [] });
    assert.deepEqual(riverMatching(river, compileTerms(["llm"], { plural: true })).map((r) => r.id), [b.id]);
    assert.deepEqual(riverMatching(river, compileTerms(["llm"])), []);
    assert.deepEqual(riverSection(river, "policy").map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(riverSection(river, "policy", NO_MUTES, new Set([a.id])).map((r) => r.id), [c.id]);
    assert.deepEqual(collapseStories(rows).map((r) => r.id), [a.id, b.id], "member c collapses into its lead a");
  });

  it("the real fixture river is consistent with riverRows", () => {
    const rows = riverRows(fixtureRiver);
    assert.equal(rows.length, fixtureRiver.rows.length);
    assert.ok(rows.every((r) => r.sourceName && r.sourceId));
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].effectiveMs >= rows[i].effectiveMs);
    // The word most river headlines carry (whatever the frozen week's news is) finds at least that many stories' worth of rows.
    const busiest = commonTitleWord(rows.map((r) => r.title), 10);
    const found = searchRiver(fixtureRiver, busiest.word.toLowerCase()).rows;
    assert.ok(found.length >= 5 && found.length <= rows.length, `${busiest.word}: ${found.length}`);
    assert.ok(found.every((r) => new RegExp(`\\b${busiest.word}`, "i").test(r.title)), "every hit carries the word in its headline");
    assert.deepEqual(searchRiver(fixtureRiver, "zzzzqqqq-no-such-term").rows, []);
    assert.ok(collapseStories(rows).length < rows.length);
  });
});
