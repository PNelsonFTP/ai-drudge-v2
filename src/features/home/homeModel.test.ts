import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleV2, BriefFile } from "../../../shared/contract";
import { SECTION_IDS, sectionById, type SectionId } from "../../../shared/sections";
import { NO_MUTES, visibleStory, type Edition, type MuteSet } from "../../../shared/select";
import { compileTerms } from "../../../shared/text";
import { HOUR_MS, effectiveMs } from "../../../shared/time";
import { FIXTURE_META, FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition } from "../../../test/helpers/factories";
import { commonTitleWord, homepageTitles } from "../../../test/helpers/fixtureCases";
import { FIXTURE_GENERATED_MS, fixtureBrief, fixtureEdition } from "../../../test/helpers/fixtureData";
import { SECTION_PRESETS } from "../../app/presets";
import { DEFAULT_SETTINGS } from "../../app/services";
import {
  LATEST_LIMIT,
  assignColumns,
  buildHomeModel,
  columnsForWidth,
  countNewOnHome,
  homeSectionRows,
  layoutColumns,
  renderableBrief,
  resolveSectionOrder,
  sameSection,
  type HomeInput,
  type HomeSettings,
} from "./homeModel";

const NOW = FIXTURE_GENERATED_MS + 20 * 60_000;
const settings = (over: Partial<HomeSettings> = {}): HomeSettings => ({ ...DEFAULT_SETTINGS, ...over });
const mutes = (sources: string[] = [], sections: SectionId[] = []): MuteSet => ({ sources: new Set(sources), sections: new Set(sections) });

function input(over: Partial<HomeInput> = {}): HomeInput {
  return { edition: fixtureEdition(), brief: fixtureBrief, mutes: NO_MUTES, settings: settings(), nowMs: NOW, previousVisitMs: NOW - 6 * HOUR_MS, ...over };
}

const claudeBrief: BriefFile = {
  ...FIXTURE_META,
  source: "claude",
  model: "claude-test-model",
  headline: "A headline",
  bullets: ["One.", "Two."],
  cited: [{ title: "T", url: "https://example.com/t", source: "Example" }],
};

describe("home/homeModel section order", () => {
  it("default order is the taxonomy order", () => {
    assert.deepEqual(resolveSectionOrder(null), [...SECTION_IDS]);
    assert.deepEqual(buildHomeModel(input()).order, [...SECTION_IDS]);
  });

  it("reader order first, unknown and repeated ids ignored, the rest in default order", () => {
    const order = resolveSectionOrder(["cyber", "bogus", "models", "cyber", "ai_security"]);
    assert.deepEqual(order.slice(0, 3), ["cyber", "models", "ai_security"]);
    assert.equal(order.length, SECTION_IDS.length);
    assert.equal(new Set(order).size, SECTION_IDS.length);
    assert.deepEqual(order.slice(3), SECTION_IDS.filter((id) => !["cyber", "models", "ai_security"].includes(id)));
  });

  it("sections render in the reader's order (CISO preset)", () => {
    const ciso = SECTION_PRESETS.find((p) => p.id === "ciso")!;
    const model = buildHomeModel(input({ settings: settings({ sectionOrder: ciso.order }) }));
    assert.deepEqual(model.sections.map((s) => s.id), ciso.order);
  });

  it("every fixture section has rows, labels and counts", () => {
    const model = buildHomeModel(input());
    assert.deepEqual(model.sections.map((s) => s.id), [...SECTION_IDS]);
    for (const s of model.sections) {
      const def = sectionById(s.id);
      assert.equal(s.label, def.label);
      assert.equal(s.short, def.short);
      assert.ok(s.rows.length > 0 && s.rows.length <= def.homeRows, s.id);
      assert.ok(s.total >= s.rows.length, s.id);
      assert.equal(new Set(s.rows).size, s.rows.length);
      assert.equal(s.collapsed, false);
    }
  });
});

describe("home/homeModel hidden and collapsed sections", () => {
  it("hidden sections leave the page and are listed for restoring", () => {
    const model = buildHomeModel(input({ settings: settings({ hiddenSections: ["robotics", "models"] }) }));
    assert.deepEqual(model.hidden, ["models", "robotics"], "in reader order");
    assert.ok(!model.sections.some((s) => s.id === "robotics" || s.id === "models"));
    assert.equal(model.sections.length, SECTION_IDS.length - 2);
    assert.equal(model.order.length, SECTION_IDS.length, "the order (column slots) still knows every section");
  });

  it("a muted section leaves the page too", () => {
    const model = buildHomeModel(input({ mutes: mutes([], ["cyber"]) }));
    assert.ok(!model.sections.some((s) => s.id === "cyber"));
    assert.deepEqual(model.hidden, [], "muting is not hiding: it is managed with the mutes");
  });

  it("collapsed sections stay, flagged", () => {
    const model = buildHomeModel(input({ settings: settings({ collapsed: ["industry"] }) }));
    assert.deepEqual(model.sections.filter((s) => s.collapsed).map((s) => s.id), ["industry"]);
  });
});

describe("home/homeModel columns", () => {
  const order = [...SECTION_IDS];

  it("deals sections to the shortest column, in order, every section once", () => {
    const cols = assignColumns(order, 3);
    assert.deepEqual(cols, [
      ["models", "open_local", "money", "safety", "robotics"],
      ["industry", "policy", "compute", "analysis", "releases"],
      ["ai_security", "tools", "research", "cyber", "quantum"],
    ]);
    assert.deepEqual(cols.flat().sort(), [...order].sort());
    assert.deepEqual(cols.map((c) => c[0]), order.slice(0, 3), "the first row reads left to right");
  });

  it("is balanced by the sections' fixed row counts", () => {
    const weight = (col: SectionId[]) => col.reduce((n, id) => n + sectionById(id).homeRows + 2, 0);
    for (const n of [2, 3]) {
      const heights = assignColumns(order, n).map(weight);
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 14, `${n} columns: ${heights.join("/")}`);
    }
  });

  it("one column is the reader order; the column count is clamped", () => {
    assert.deepEqual(assignColumns(order, 1), [order]);
    assert.deepEqual(assignColumns(order, 0), [order]);
    assert.equal(assignColumns(order, 2).length, 2);
  });

  it("hiding a section never moves another section to a different column", () => {
    const full = assignColumns(order, 3);
    const columnOf = (cols: SectionId[][], id: SectionId) => cols.findIndex((c) => c.includes(id));
    for (const gone of order) {
      const visible = new Set(order.filter((id) => id !== gone));
      const cols = layoutColumns(order, visible, 3);
      assert.ok(!cols.flat().includes(gone));
      for (const id of visible) assert.equal(columnOf(cols, id), columnOf(full, id), `${id} moved when ${gone} was hidden`);
      for (const [i, col] of cols.entries()) assert.deepEqual(col, full[i].filter((id) => id !== gone), "order inside the column is kept");
    }
  });

  it("the model keeps slots when sections are hidden, muted or emptied by a filter", () => {
    const base = buildHomeModel(input());
    const hidden = buildHomeModel(input({ settings: settings({ hiddenSections: ["industry"] }), mutes: mutes([], ["tools"]) }));
    assert.deepEqual(hidden.order, base.order);
    const cols = layoutColumns(hidden.order, new Set(hidden.sections.map((s) => s.id)), 3);
    assert.deepEqual(cols, assignColumns(base.order, 3).map((c) => c.filter((id) => id !== "industry" && id !== "tools")));
  });

  it("column count by viewport width matches the shared grid breakpoints", () => {
    assert.deepEqual([320, 719, 720, 1099, 1100, 1920].map(columnsForWidth), [1, 1, 2, 2, 3, 3]);
  });
});

describe("home/homeModel mutes", () => {
  const e = fixtureEdition();
  const industry = e.sections.find((s) => s.id === "industry")!;
  const topSource = e.articles[industry.rows[0]].src;

  // A row stays while ANY outlet of its story is unmuted (shared/select visibleStory); what it then
  // displays is never an article of a muted source.
  const shownSrc = (ed: Edition, id: string, m: MuteSet): string | undefined => visibleStory(ed, id, m)?.lead.src;

  it("drops rows of a muted source and backfills from the full list", () => {
    const unmuted = homeSectionRows(e, "industry", NO_MUTES);
    assert.deepEqual(unmuted.rows, industry.rows.slice(0, industry.homeCount));
    const m = mutes([topSource]);
    const muted = homeSectionRows(e, "industry", m);
    assert.ok(muted.rows.every((id) => shownSrc(e, id, m) !== undefined && shownSrc(e, id, m) !== topSource));
    assert.equal(muted.rows.length, industry.homeCount, "no holes: the next ranked rows move up");
    const expected = industry.rows.filter((id) => visibleStory(e, id, m) !== null);
    assert.ok(expected.length < industry.rows.length, "single-outlet stories of the muted source are gone");
    assert.deepEqual(muted.rows, expected.slice(0, industry.homeCount));
    assert.equal(muted.total, expected.length, "view-all count excludes muted rows");
  });

  it("with only front.json there is nothing to backfill from", () => {
    const front = fixtureEdition(false);
    const m = mutes([topSource]);
    const muted = homeSectionRows(front, "industry", m);
    const homeRows = industry.rows.slice(0, industry.homeCount);
    assert.deepEqual(muted.rows, homeRows.filter((id) => visibleStory(front, id, m) !== null));
    assert.ok(muted.rows.length < industry.homeCount);
    assert.equal(muted.total, industry.total);
  });

  it("mutes apply to TOP STORIES, LATEST and every section of the model", () => {
    const lead = e.articles[e.top[0]];
    const m = mutes([lead.src, topSource]);
    const model = buildHomeModel(input({ mutes: m }));
    const shown = [model.lead?.id, ...model.top.map((s) => s.id), ...model.latest, ...model.sections.flatMap((s) => s.rows)].filter((x): x is string => Boolean(x));
    assert.ok(shown.length > 50);
    for (const id of shown) assert.ok(![lead.src, topSource, undefined].includes(shownSrc(e, id, m)), id);
    // TP-02: muting the outlet that leads the multi-publisher lead story does not remove the story.
    assert.equal(model.lead?.id, lead.id, "the lead story keeps its key");
    assert.equal(model.lead?.publishers, visibleStory(e, lead.id, m)?.publishers);
    assert.ok((model.lead?.publishers ?? 0) < e.clusters[lead.id].publishers, "outlets recounted without the muted one");
  });

  it("a story disappears only when every outlet covering it is muted", () => {
    const lead = e.articles[e.top[0]];
    const everySource = [lead.src, ...e.clusters[lead.id].members.map((id) => e.articles[id].src)];
    const model = buildHomeModel(input({ mutes: mutes(everySource) }));
    assert.notEqual(model.lead?.id, lead.id, "the next story becomes the lead");
    assert.ok(!model.top.some((s) => s.id === lead.id));
  });

  it("an unknown section yields nothing", () => {
    const tiny = makeEdition({ articles: [makeArticle()] });
    const broken: Edition = { ...tiny.edition, sections: tiny.edition.sections.filter((s) => s.id !== "models") };
    assert.deepEqual(homeSectionRows(broken, "models", NO_MUTES), { rows: [], total: 0 });
  });
});

describe("home/homeModel time filter", () => {
  const e = fixtureEdition();
  const idsOf = (m: ReturnType<typeof buildHomeModel>): string[] => [m.lead?.id, ...m.top.map((s) => s.id), ...m.latest, ...m.sections.flatMap((s) => s.rows)].filter((x): x is string => Boolean(x));
  // A story is as new as its newest article (computed here from the raw cluster, not through the selector under test).
  const articlesOf = (id: string): ArticleV2[] => [e.articles[id], ...(e.clusters[id]?.members ?? []).map((m) => e.articles[m])].filter((a) => a && (a.id === id || !a.flags?.includes("discussion")));
  const newestMs = (id: string): number => Math.max(...articlesOf(id).map(effectiveMs));

  it('"all" changes nothing', () => {
    const model = buildHomeModel(input());
    assert.equal(model.timeFilter, "all");
    assert.deepEqual(model.sections.find((s) => s.id === "models")!.rows, e.sections.find((s) => s.id === "models")!.rows.slice(0, 10));
  });

  for (const [filter, hours] of [["6h", 6], ["24h", 24], ["3d", 72]] as const) {
    it(`"${filter}" keeps only stories of the last ${hours} hours, everywhere`, () => {
      const model = buildHomeModel(input({ settings: settings({ timeFilter: filter }) }));
      const ids = idsOf(model);
      assert.ok(ids.length > 0);
      for (const id of ids) assert.ok(NOW - newestMs(id) <= hours * HOUR_MS, `${id} is older than ${hours} h`);
      const all = buildHomeModel(input());
      // ... and every story with an article inside the window is kept: none is hidden for an old lead.
      const kept = new Set(ids);
      for (const s of all.sections) {
        const want = e.sections.find((x) => x.id === s.id)!.rows.filter((id) => NOW - newestMs(id) <= hours * HOUR_MS).slice(0, s.rows.length);
        for (const id of want.slice(0, sectionById(s.id).homeRows)) assert.ok(kept.has(id), `${s.id}: ${id} has coverage inside ${hours} h`);
      }
      assert.ok(ids.length <= idsOf(all).length);
      assert.ok(model.sections.every((s) => s.rows.length > 0), "sections emptied by the filter are dropped");
    });
  }

  it("a narrower window never shows more", () => {
    const count = (f: "6h" | "24h" | "3d" | "all") => buildHomeModel(input({ settings: settings({ timeFilter: f }) })).sections.reduce((n, s) => n + s.rows.length, 0);
    assert.ok(count("6h") <= count("24h") && count("24h") <= count("3d") && count("3d") <= count("all"));
    assert.ok(count("6h") < count("all"));
  });

  it('"new" keeps stories first seen after the previous visit', () => {
    const since = NOW - 3 * HOUR_MS;
    const model = buildHomeModel(input({ settings: settings({ timeFilter: "new" }), previousVisitMs: since }));
    const ids = idsOf(model);
    assert.ok(ids.length > 0);
    for (const id of ids) assert.ok(articlesOf(id).some((a) => Date.parse(a.firstSeenAt) > since), id);
  });

  it("a story stays in the window while outlets are still joining it (lead 38 h old, newest outlet minutes old)", () => {
    const lead = makeArticle({ home: "industry", src: "lab", title: "Lab prices its IPO", publishedAt: hoursAgo(38), firstSeenAt: hoursAgo(38) });
    const joined = makeArticle({ home: "industry", src: "wire", title: "Shares jump on debut", publishedAt: hoursAgo(0.2), firstSeenAt: hoursAgo(0.1) });
    const stale = makeArticle({ home: "industry", src: "press", title: "Yesterday's other story", publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const built = makeEdition({ articles: [lead, joined, stale], rows: { industry: [lead.id, stale.id] }, clusters: { [lead.id]: [joined.id] }, top: [lead.id] });
    const at = (timeFilter: HomeSettings["timeFilter"], over: Partial<HomeInput> = {}) =>
      buildHomeModel({ edition: built.edition, brief: null, mutes: NO_MUTES, settings: settings({ timeFilter }), nowMs: FIXTURE_NOW_MS, previousVisitMs: FIXTURE_NOW_MS - 2 * HOUR_MS, ...over });
    for (const f of ["6h", "24h", "new"] as const) {
      const m = at(f);
      assert.equal(m.lead?.id, lead.id, `${f}: the lead story is still TOP`);
      assert.deepEqual(m.sections.map((s) => s.rows), [[lead.id]], `${f}: and still in its section; the story nobody joined is filtered`);
    }
    assert.equal(at("all").newSince, 1, "it counts as new since the visit: an outlet was first seen after it");
    // With the joining outlet muted the story is as old as its lead again.
    const muted = at("24h", { mutes: mutes(["wire"]) });
    assert.deepEqual([muted.lead, muted.sections], [null, []]);
    assert.equal(at("all", { mutes: mutes(["wire"]) }).newSince, 0);
  });

  it('"new" on a first visit falls back to the 6-hour rule', () => {
    const model = buildHomeModel(input({ settings: settings({ timeFilter: "new" }), previousVisitMs: null }));
    for (const id of idsOf(model)) assert.ok(NOW - newestMs(id) <= 6 * HOUR_MS, id);
  });

  it("rows hidden by the window are replaced by the next ranked rows that pass", () => {
    const old = [0, 1, 2].map(() => makeArticle({ home: "industry", publishedAt: hoursAgo(50) }));
    const fresh = [0, 1, 2, 3].map((i) => makeArticle({ home: "industry", publishedAt: hoursAgo(1 + i) }));
    const rows = [old[0], fresh[0], old[1], fresh[1], old[2], fresh[2], fresh[3]].map((a) => a.id);
    const built = makeEdition({ articles: [...old, ...fresh], rows: { industry: rows }, homeRows: { industry: 3 } });
    const model = buildHomeModel({ edition: built.edition, brief: null, mutes: NO_MUTES, settings: settings({ timeFilter: "24h" }), nowMs: FIXTURE_NOW_MS, previousVisitMs: null });
    assert.deepEqual(model.sections.map((s) => s.id), ["industry"]);
    assert.deepEqual(model.sections[0].rows, [fresh[0].id, fresh[1].id, fresh[2].id]);
    assert.equal(model.sections[0].total, 7);
  });
});

describe("home/homeModel latest", () => {
  const e = fixtureEdition();

  it("is the 12 newest ai-desk homepage rows, newest first, without the TOP STORIES leads", () => {
    const model = buildHomeModel(input());
    assert.equal(model.latest.length, LATEST_LIMIT);
    assert.equal(new Set(model.latest).size, LATEST_LIMIT);
    const times = model.latest.map((id) => effectiveMs(e.articles[id]));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    const top = new Set(e.top);
    assert.ok(model.latest.every((id) => !top.has(id)));

    // The pool is the HOMEPAGE rows of the ai-desk sections, not the full ranked lists.
    const aiRows = new Set<string>();
    for (const s of e.sections) if (sectionById(s.id).desk === "ai") for (const id of s.rows.slice(0, s.homeCount)) aiRows.add(id);
    assert.ok(model.latest.every((id) => aiRows.has(id)), "only homepage rows of ai-desk sections feed LATEST");
    const cutoff = times[times.length - 1];
    for (const id of aiRows) if (!top.has(id) && !model.latest.includes(id)) assert.ok(effectiveMs(e.articles[id]) <= cutoff, `${id} is newer than the strip's oldest row`);
  });

  it("is the same list before and after rest.json merges (no reshuffle above the fold)", () => {
    const front = fixtureEdition(false);
    const full = fixtureEdition(true);
    assert.ok(full.sections.some((s) => s.rows.length > s.homeCount), "the fixture has rows beyond the homepage rows");
    const cases: Partial<HomeInput>[] = [
      {},
      { settings: settings({ timeFilter: "6h" }) },
      { settings: settings({ timeFilter: "24h" }) },
      { settings: settings({ timeFilter: "3d" }) },
      { mutes: mutes([front.articles[buildHomeModel(input({ edition: front })).latest[0]].src]) },
      { settings: settings({ hiddenSections: ["industry"] }) },
    ];
    for (const over of cases) {
      const before = buildHomeModel(input({ ...over, edition: front }));
      const after = buildHomeModel(input({ ...over, edition: full }));
      assert.deepEqual(after.latest, before.latest, JSON.stringify(over.settings?.timeFilter ?? over.settings?.hiddenSections ?? (over.mutes ? "muted source" : "defaults")));
      assert.deepEqual(after.top, before.top);
      assert.deepEqual(after.lead, before.lead);
    }
    assert.equal(buildHomeModel(input({ edition: front })).latest.length, LATEST_LIMIT);
  });

  it("never draws from owner / utility desks, hidden or muted sections", () => {
    const cyber = makeArticle({ home: "cyber", publishedAt: hoursAgo(0.1) });
    const release = makeArticle({ home: "releases", publishedAt: hoursAgo(0.2), flags: ["release"] });
    const robot = makeArticle({ home: "robotics", publishedAt: hoursAgo(0.3) });
    const policy = makeArticle({ home: "policy", publishedAt: hoursAgo(0.4) });
    const model1 = makeArticle({ home: "models", publishedAt: hoursAgo(5) });
    const built = makeEdition({ articles: [cyber, release, robot, policy, model1] });
    const run = (s: Partial<HomeSettings>, m: MuteSet = NO_MUTES) => buildHomeModel({ edition: built.edition, brief: null, mutes: m, settings: settings(s), nowMs: FIXTURE_NOW_MS, previousVisitMs: null }).latest;
    assert.deepEqual(run({}), [robot.id, policy.id, model1.id]);
    assert.deepEqual(run({ hiddenSections: ["robotics"] }), [policy.id, model1.id]);
    assert.deepEqual(run({}, mutes([], ["policy"])), [robot.id, model1.id]);
    assert.deepEqual(run({}, mutes(["example-source"])), []);
    assert.deepEqual(run({ timeFilter: "6h" }), [robot.id, policy.id, model1.id]);
    assert.deepEqual(run({ timeFilter: "3d" }).length, 3);
  });

  it("respects the time filter and breaks ties by id", () => {
    const at = hoursAgo(2);
    const a = makeArticle({ home: "models", publishedAt: at });
    const b = makeArticle({ home: "tools", publishedAt: at });
    const c = makeArticle({ home: "tools", publishedAt: hoursAgo(30) });
    const built = makeEdition({ articles: [a, b, c] });
    const run = (timeFilter: HomeSettings["timeFilter"]) => buildHomeModel({ edition: built.edition, brief: null, mutes: NO_MUTES, settings: settings({ timeFilter }), nowMs: FIXTURE_NOW_MS, previousVisitMs: null }).latest;
    assert.deepEqual(run("all"), [...[a.id, b.id].sort(), c.id]);
    assert.deepEqual(run("24h"), [a.id, b.id].sort());
  });
});

describe("home/homeModel top stories", () => {
  const e = fixtureEdition();

  it("the lead is the first TOP STORY, the rest follow in rank order with publisher counts", () => {
    const model = buildHomeModel(input());
    assert.equal(model.lead?.id, e.leadId);
    assert.deepEqual([model.lead!.id, ...model.top.map((s) => s.id)], e.top);
    for (const s of [model.lead!, ...model.top]) {
      assert.equal(s.publishers, e.clusters[s.id].publishers);
      assert.ok(s.publishers >= 2);
    }
  });

  it("no multi-publisher story: no lead, no list", () => {
    const built = makeEdition({ articles: [makeArticle(), makeArticle()] });
    const model = buildHomeModel({ edition: built.edition, brief: null, mutes: NO_MUTES, settings: settings(), nowMs: FIXTURE_NOW_MS, previousVisitMs: null });
    assert.equal(model.lead, null);
    assert.deepEqual(model.top, []);
    assert.equal(model.sections.length, 1);
  });

  it("the time filter applies to TOP STORIES", () => {
    const model = buildHomeModel(input({ settings: settings({ timeFilter: "6h" }) }));
    const ids = [model.lead?.id, ...model.top.map((s) => s.id)].filter((x): x is string => Boolean(x));
    // A story is as new as its newest article (threads are not coverage): the lead may be older than the window.
    const newest = (id: string): number => Math.max(effectiveMs(e.articles[id]), ...(e.clusters[id]?.members ?? []).map((m) => e.articles[m]).filter((a) => !a.flags?.includes("discussion")).map(effectiveMs));
    const expected = e.top.filter((id) => NOW - newest(id) <= 6 * HOUR_MS);
    assert.deepEqual(ids, expected);
    assert.ok(expected.length > 0 && expected.length < e.top.length, "fixture: some TOP STORIES are inside the 6 h window and some are not");
    assert.ok(expected.some((id) => NOW - effectiveMs(e.articles[id]) > 6 * HOUR_MS), "fixture: a TOP STORY is kept by an outlet that joined inside the window, not by its lead");
  });

  it("without an edition the model is empty but keeps order, hidden and filter", () => {
    const model = buildHomeModel(input({ edition: null, settings: settings({ hiddenSections: ["quantum"], timeFilter: "24h" }) }));
    assert.equal(model.lead, null);
    assert.deepEqual([model.top, model.latest, model.sections, model.watchHits], [[], [], [], []]);
    assert.equal(model.newSince, 0);
    assert.deepEqual(model.hidden, ["quantum"]);
    assert.equal(model.timeFilter, "24h");
    assert.equal(model.order.length, SECTION_IDS.length);
  });
});

describe("home/homeModel new since last visit", () => {
  const e = fixtureEdition();
  const all = new Set(SECTION_IDS);

  it("counts distinct stories on the page first seen after the previous visit", () => {
    const since = NOW - 6 * HOUR_MS;
    const onPage = new Set<string>(e.top);
    for (const s of e.sections) for (const id of s.rows.slice(0, s.homeCount)) onPage.add(id);
    // A story counts when its lead, or an outlet that joined it (threads are not coverage), was first seen since then.
    const seenSince = (id: string): boolean => Date.parse(e.articles[id].firstSeenAt) > since;
    const joinedSince = (id: string): boolean => (e.clusters[id]?.members ?? []).some((m) => !e.articles[m].flags?.includes("discussion") && seenSince(m));
    const expected = [...onPage].filter((id) => seenSince(id) || joinedSince(id)).length;
    assert.ok(expected > 0 && expected < onPage.size);
    assert.equal(buildHomeModel(input({ previousVisitMs: since })).newSince, expected);
    assert.ok([...onPage].some((id) => !seenSince(id) && joinedSince(id)), "fixture: a story on the page is new only because an outlet joined it");
  });

  it("is 0 on a first visit and when nothing is newer", () => {
    assert.equal(buildHomeModel(input({ previousVisitMs: null })).newSince, 0);
    assert.equal(buildHomeModel(input({ previousVisitMs: NOW })).newSince, 0);
  });

  it("is the same before and after rest.json arrives (no jump on hydration)", () => {
    const since = NOW - 12 * HOUR_MS;
    assert.equal(countNewOnHome(fixtureEdition(false), NO_MUTES, all, since), countNewOnHome(e, NO_MUTES, all, since));
  });

  it("ignores muted sources and sections that are not on the page", () => {
    const since = NOW - 12 * HOUR_MS;
    const full = countNewOnHome(e, NO_MUTES, all, since);
    const withoutIndustry = countNewOnHome(e, NO_MUTES, new Set(SECTION_IDS.filter((id) => id !== "industry")), since);
    assert.ok(withoutIndustry < full);
    assert.equal(buildHomeModel(input({ previousVisitMs: since, settings: settings({ hiddenSections: ["industry"] }) })).newSince, withoutIndustry);
    const src = e.articles[e.sections[0].rows[0]].src;
    assert.ok(countNewOnHome(e, mutes([src]), all, since) <= full);
  });

  it("does not depend on the time chip", () => {
    const since = NOW - 6 * HOUR_MS;
    assert.equal(buildHomeModel(input({ previousVisitMs: since, settings: settings({ timeFilter: "3d" }) })).newSince, buildHomeModel(input({ previousVisitMs: since })).newSince);
  });
});

describe("home/homeModel brief and watchlist", () => {
  it("a fallback brief is never rendered; an AI-written one is", () => {
    assert.equal(fixtureBrief.source, "fallback");
    assert.equal(buildHomeModel(input()).brief, null);
    assert.equal(buildHomeModel(input({ brief: null })).brief, null);
    assert.equal(buildHomeModel(input({ brief: claudeBrief })).brief, claudeBrief);
    assert.equal(renderableBrief({ ...claudeBrief, headline: " ", bullets: [] }), null, "an empty brief is not rendered");
    assert.equal(renderableBrief({ ...claudeBrief, source: "fallback" }), null);
  });

  it("watch hits are the visible stories whose title matches, in page order, once each", () => {
    const e = fixtureEdition();
    // The word most homepage headlines carry on the frozen day - whatever that day's news is.
    const term = commonTitleWord(homepageTitles(e), 3).word;
    const mentions = new RegExp(`\\b${term}`, "i");
    const watch = compileTerms([term], { plural: true });
    const model = buildHomeModel(input({ watch }));
    assert.ok(model.watchHits.length >= 3);
    assert.equal(new Set(model.watchHits).size, model.watchHits.length);
    for (const id of model.watchHits) assert.match(e.articles[id].title, mentions);
    // Page order: the lead, TOP STORIES, LATEST, then the sections.
    const visible = [...new Set<string>([model.lead!.id, ...model.top.map((s) => s.id), ...model.latest, ...model.sections.flatMap((s) => s.rows)])];
    const expected = visible.filter((id) => mentions.test(e.articles[id].title));
    assert.equal(model.watchHits[0], expected[0], "the first hit in page order comes first");
    assert.deepEqual([...model.watchHits].sort(), [...expected].sort());
  });

  it("an empty watchlist gives no hits", () => {
    assert.deepEqual(buildHomeModel(input()).watchHits, []);
    assert.deepEqual(buildHomeModel(input({ watch: compileTerms([]) })).watchHits, []);
  });
});

describe("home/homeModel sameSection", () => {
  it("compares by value", () => {
    const model = buildHomeModel(input());
    const again = buildHomeModel(input());
    const a = model.sections[0];
    assert.notEqual(a, again.sections[0]);
    assert.equal(sameSection(a, again.sections[0]), true);
    assert.equal(sameSection(a, { ...a, rows: [...a.rows].reverse() }), false);
    assert.equal(sameSection(a, { ...a, rows: a.rows.slice(1) }), false);
    assert.equal(sameSection(a, { ...a, collapsed: true }), false);
    assert.equal(sameSection(a, { ...a, total: a.total + 1 }), false);
    assert.equal(sameSection(a, model.sections[1]), false);
  });
});
