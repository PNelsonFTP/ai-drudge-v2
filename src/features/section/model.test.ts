import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MUTES, type MuteSet } from "../../../shared/select";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition, makeRiver, makeSourceRef } from "../../../test/helpers/factories";
import { fixtureEdition, fixtureRiver } from "../../../test/helpers/fixtureData";
import { buildSectionView, mixLine, publisherMix, sectionNeighbors, sectionTitle, type SectionViewInput } from "./model";

const NOW = FIXTURE_NOW_MS;

const sources = {
  tc: makeSourceRef({ name: "TechCrunch AI", publisher: "TechCrunch" }),
  "tc-2": makeSourceRef({ name: "TechCrunch Venture", publisher: "TechCrunch" }),
  reuters: makeSourceRef({ name: "Reuters Tech", publisher: "Reuters" }),
  verge: makeSourceRef({ name: "The Verge AI", publisher: "The Verge" }),
};

function world() {
  const a = makeArticle({ title: "Ranked one", src: "tc", publishedAt: hoursAgo(2) });
  const b = makeArticle({ title: "Ranked two", src: "reuters", publishedAt: hoursAgo(30) });
  const c = makeArticle({ title: "Ranked three (view-all tail)", src: "tc-2", publishedAt: hoursAgo(50) });
  const member = makeArticle({ title: "Other outlet on ranked one", src: "verge", publishedAt: hoursAgo(3) });
  const capped = makeArticle({ title: "Dropped by the per-source cap", src: "tc", publishedAt: hoursAgo(5) });
  const cappedTwin = makeArticle({ title: "Second outlet on the dropped story", src: "verge", publishedAt: hoursAgo(6) });
  const old = makeArticle({ title: "Six days old", src: "reuters", publishedAt: hoursAgo(144) });
  const elsewhere = makeArticle({ title: "Another section", src: "verge", home: "models", publishedAt: hoursAgo(1) });
  const articles = [a, b, c, member, capped, cappedTwin, old, elsewhere];
  const built = makeEdition({
    articles: [a, b, c, member, elsewhere],
    rows: { industry: [a.id, b.id, c.id], models: [elsewhere.id] },
    homeRows: { industry: 2 },
    clusters: { [a.id]: [member.id] },
    sources,
  });
  const river = makeRiver(articles, { sources, leads: { [member.id]: a.id, [cappedTwin.id]: capped.id } });
  return { ...built, river, a, b, c, member, capped, cappedTwin, old, elsewhere };
}

function input(w: ReturnType<typeof world>, over: Partial<SectionViewInput> = {}): SectionViewInput {
  return { edition: w.edition, river: w.river, id: "industry", mutes: NO_MUTES, filter: "all", nowMs: NOW, previousVisitMs: null, ...over };
}

describe("section/model - buildSectionView", () => {
  it("lists the full ranked rows once rest.json is merged, homepage rows only before that", () => {
    const w = world();
    const full = buildSectionView(input(w));
    assert.deepEqual(full.rows, [w.a.id, w.b.id, w.c.id]);
    assert.equal(full.ranked, 3);
    assert.equal(full.complete, true);
    assert.equal(full.label, "INDUSTRY");
    const front = buildSectionView(input(w, { edition: w.frontOnly }));
    assert.deepEqual(front.rows, [w.a.id, w.b.id]);
    assert.equal(front.complete, false);
    assert.deepEqual(front.tail, [], "no river tail until the ranked list is complete (it would repeat the rest rows)");
  });

  it("river tail: section items beyond the ranked list, one per story, newest first, never a shown story", () => {
    const w = world();
    const v = buildSectionView(input(w));
    assert.deepEqual(v.tail.map((r) => r.id), [w.capped.id, w.old.id]);
    assert.equal(v.tail[0].item?.title, "Dropped by the per-source cap");
    assert.equal(v.tail[0].item?.section, "industry");
    assert.ok(!v.tail.some((r) => r.id === w.member.id), "a member of a ranked story is not repeated");
    assert.ok(!v.tail.some((r) => r.id === w.cappedTwin.id), "two outlets on one unranked story collapse to one row");
    assert.ok(!v.tail.some((r) => r.id === w.elsewhere.id));
    assert.deepEqual(buildSectionView(input(w, { river: null })).tail, []);
  });

  it("time filter applies to ranked rows and to the tail; `ranked` keeps the unfiltered count", () => {
    const w = world();
    const day = buildSectionView(input(w, { filter: "24h" }));
    assert.deepEqual(day.rows, [w.a.id]);
    assert.equal(day.ranked, 3);
    assert.deepEqual(day.windows, { new: 1, "6h": 1, "24h": 1, "3d": 3, all: 3 }, "chip counts do not depend on the active filter");
    assert.deepEqual(day.tail.map((r) => r.id), [w.capped.id]);
    const sinceVisit = buildSectionView(input(w, { filter: "new", previousVisitMs: NOW - 4 * 3_600_000 }));
    assert.deepEqual(sinceVisit.rows, [w.a.id]);
    assert.deepEqual(sinceVisit.tail, []);
  });

  it("a ranked story is as new as its newest outlet: the 24H chip keeps a day-old lead that is still being joined", () => {
    // Live: the 30-publisher IPO story (lead 38 h old, newest member minutes old) vanished under 24H.
    const lead = makeArticle({ title: "IPO priced", src: "tc", publishedAt: hoursAgo(38), firstSeenAt: hoursAgo(38) });
    const joined = makeArticle({ title: "Shares jump on debut", src: "reuters", publishedAt: hoursAgo(0.3), firstSeenAt: hoursAgo(0.2) });
    const quiet = makeArticle({ title: "Nobody followed this up", src: "verge", publishedAt: hoursAgo(38), firstSeenAt: hoursAgo(38) });
    const built = makeEdition({ articles: [lead, joined, quiet], rows: { industry: [lead.id, quiet.id] }, clusters: { [lead.id]: [joined.id] }, sources });
    const at = (over: Partial<SectionViewInput>) => buildSectionView({ edition: built.edition, river: null, id: "industry", mutes: NO_MUTES, filter: "24h", nowMs: NOW, previousVisitMs: NOW - 3_600_000, ...over });
    assert.deepEqual(at({}).rows, [lead.id]);
    assert.deepEqual(at({}).windows, { new: 1, "6h": 1, "24h": 1, "3d": 2, all: 2 }, "the chip counts follow the same rule");
    assert.deepEqual(at({ filter: "new" }).rows, [lead.id], "an outlet first seen since the last visit makes the story new");
    const muted: MuteSet = { sources: new Set(["reuters"]), sections: new Set() };
    assert.deepEqual(at({ mutes: muted }).rows, [], "without the outlet that joined, the story is 38 h old");
    assert.deepEqual(at({ mutes: muted }).windows, { new: 0, "6h": 0, "24h": 0, "3d": 2, all: 2 });
  });

  it("source mutes remove rows and tail items; a section mute is reported but the page still lists it", () => {
    const w = world();
    const muteTc: MuteSet = { sources: new Set(["tc"]), sections: new Set() };
    const v = buildSectionView(input(w, { mutes: muteTc }));
    assert.deepEqual(v.rows, [w.a.id, w.b.id, w.c.id], "story a is led by the muted outlet but another outlet covers it: the row stays (the other outlet's article is displayed)");
    const both: MuteSet = { sources: new Set(["tc", w.member.src]), sections: new Set() };
    assert.equal(buildSectionView(input(w, { mutes: both })).rows.includes(w.a.id), false, "every outlet of story a muted");
    assert.deepEqual(v.tail.map((r) => r.id), [w.cappedTwin.id, w.old.id], "the muted outlet's copy is gone, the other outlet's copy represents the story");
    const muted = buildSectionView(input(w, { mutes: { sources: new Set(), sections: new Set(["industry"]) } }));
    assert.equal(muted.muted, true);
    assert.deepEqual(muted.rows, [w.a.id, w.b.id, w.c.id]);
    assert.equal(muted.tail.length, 2);
  });

  it("works on the committed fixture: every section's full list plus a tail that repeats nothing", () => {
    const e = fixtureEdition();
    let longest = 0;
    for (const section of e.sections) {
      const v = buildSectionView({ edition: e, river: fixtureRiver, id: section.id, mutes: NO_MUTES, filter: "all", nowMs: Date.parse(e.meta.generatedAt), previousVisitMs: null });
      assert.deepEqual(v.rows, section.rows, section.id);
      assert.equal(v.ranked, section.rows.length);
      assert.equal(v.windows.all, section.rows.length);
      assert.ok(v.windows["6h"] <= v.windows["24h"] && v.windows["24h"] <= v.windows["3d"] && v.windows["3d"] <= v.windows.all, section.id);
      const shown = new Set(v.rows);
      for (const id of v.rows) for (const m of e.clusters[id]?.members ?? []) shown.add(m);
      assert.ok(v.tail.every((r) => !shown.has(r.id)), section.id);
      assert.equal(new Set(v.tail.map((r) => r.id)).size, v.tail.length, section.id);
      assert.ok(v.tail.every((r) => r.item?.section === section.id), section.id);
      assert.equal(v.mix.stories, section.rows.length);
      longest = Math.max(longest, v.tail.length);
    }
    assert.ok(longest > 30, `fixture: a section has a river tail longer than the page previews (longest: ${longest})`);
  });
});

describe("section/model - publisher mix", () => {
  it("counts lead outlets by publisher (two feeds of one outlet count together), largest first", () => {
    const w = world();
    const mix = publisherMix(w.edition, [w.a.id, w.b.id, w.c.id, "missing"]);
    assert.deepEqual(mix, { top: [{ name: "TechCrunch", count: 2 }, { name: "Reuters", count: 1 }], publishers: 2, stories: 3 });
    assert.equal(mixLine(mix), "TechCrunch 2 · Reuters 1 — 2 publishers across 3 stories");
  });

  it("mixLine summarises the long tail and is empty for an empty section", () => {
    const w = world();
    assert.equal(mixLine(publisherMix(w.edition, [w.a.id, w.b.id, w.c.id], 1)), "TechCrunch 2 · 1 more — 2 publishers across 3 stories");
    assert.equal(mixLine(publisherMix(w.edition, [w.a.id])), "TechCrunch 1 — 1 publisher across 1 story");
    assert.equal(mixLine(publisherMix(w.edition, [])), "");
  });

  it("the view's mix covers the ranked rows, not the filtered ones", () => {
    const w = world();
    assert.equal(buildSectionView(input(w, { filter: "6h" })).mix.stories, 3);
  });
});

describe("section/model - neighbours and title", () => {
  it("default order, no wrap-around", () => {
    assert.deepEqual([sectionNeighbors("models", null).prev, sectionNeighbors("models", null).next?.id], [null, "industry"]);
    assert.deepEqual([sectionNeighbors("industry", null).prev?.id, sectionNeighbors("industry", null).next?.id], ["models", "ai_security"]);
    assert.deepEqual([sectionNeighbors("releases", null).prev?.id, sectionNeighbors("releases", null).next], ["quantum", null]);
  });

  it("follows the reader's order and skips sections hidden from the home page (except the current one)", () => {
    const order = ["cyber", "ai_security", "policy"];
    assert.deepEqual([sectionNeighbors("ai_security", order).prev?.id, sectionNeighbors("ai_security", order).next?.id], ["cyber", "policy"]);
    assert.equal(sectionNeighbors("policy", order).next?.id, "models", "unlisted sections follow in default order");
    assert.equal(sectionNeighbors("cyber", order, ["ai_security"]).next?.id, "policy");
    const hiddenCurrent = sectionNeighbors("ai_security", order, ["ai_security"]);
    assert.deepEqual([hiddenCurrent.prev?.id, hiddenCurrent.next?.id], ["cyber", "policy"]);
  });

  it("sectionTitle", () => {
    assert.equal(sectionTitle({ name: "section", id: "ai_security" }), "AI SECURITY");
    assert.equal(sectionTitle({ name: "home" }), "Section");
  });
});
