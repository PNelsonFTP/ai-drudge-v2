import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MUTES } from "../../../shared/select";
import { DAY_MS, HOUR_MS } from "../../../shared/time";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition, makeRiver } from "../../../test/helpers/factories";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { fixtureEdition, fixtureRiver } from "../../../test/helpers/fixtureData";
import { buildNewView, sinceMs, type NewViewInput } from "./model";
import { markAllSeen } from "./markAllSeen";

const NOW = FIXTURE_NOW_MS;
const seen = (hours: number): { publishedAt: string; firstSeenAt: string } => ({ publishedAt: hoursAgo(hours + 1), firstSeenAt: hoursAgo(hours) });

function world() {
  const lead = makeArticle({ title: "Big story lead", home: "models", ...seen(2) });
  const member = makeArticle({ title: "Big story, second outlet", home: "models", ...seen(1) });
  const fresh = makeArticle({ title: "Fresh industry story", ...seen(3) });
  const rotated = makeArticle({ title: "Came and went while you were away", ...seen(4) });
  const cyber = makeArticle({ title: "Cyber item", home: "cyber", ...seen(5) });
  const before = makeArticle({ title: "Seen before the last visit", ...seen(10) });
  // Published long ago but only picked up now: first-seen time decides, not the publish date.
  const backdated = makeArticle({ title: "Backdated but new to us", home: "policy", publishedAt: hoursAgo(90), firstSeenAt: hoursAgo(2) });
  const built = makeEdition({
    articles: [lead, member, fresh, cyber, before, backdated],
    rows: { models: [lead.id], industry: [fresh.id, before.id], cyber: [cyber.id], policy: [backdated.id] },
    clusters: { [lead.id]: [member.id] },
    top: [lead.id],
  });
  const river = makeRiver([lead, member, fresh, rotated, cyber, before, backdated], { leads: { [member.id]: lead.id } });
  return { ...built, river, lead, member, fresh, rotated, cyber, before, backdated };
}

function input(w: ReturnType<typeof world>, over: Partial<NewViewInput> = {}): NewViewInput {
  return { river: w.river, edition: w.edition, previousMs: NOW - 6 * HOUR_MS, nowMs: NOW, mutes: NO_MUTES, ...over };
}

describe("new/model", () => {
  it("lists everything first seen since the previous visit, grouped by section in homepage order", () => {
    const w = world();
    const v = buildNewView(input(w));
    assert.deepEqual(v.groups.map((g) => [g.section, g.items.map((r) => r.id)]), [
      ["models", [w.lead.id]],
      ["industry", [w.fresh.id, w.rotated.id]],
      ["policy", [w.backdated.id]],
      ["cyber", [w.cyber.id]],
    ]);
    assert.equal(v.total, 5);
    assert.equal(v.sinceMs, NOW - 6 * HOUR_MS);
    assert.equal(v.firstVisit, false);
    assert.equal(v.groups[0].label, "MODELS & LABS");
  });

  it("a story is listed once, as its lead row when the edition has it", () => {
    const w = world();
    const models = buildNewView(input(w)).groups[0].items;
    assert.deepEqual(models, [{ id: w.lead.id }], "the newer member resolves to the lead; no fallback item needed");
  });

  it("includes stories that already rotated off the home page, with a fallback item to render them", () => {
    const w = world();
    const v = buildNewView(input(w));
    const row = v.groups[1].items.find((r) => r.id === w.rotated.id);
    assert.equal(row?.item?.title, "Came and went while you were away");
    assert.equal(v.offHome, 1);
    assert.equal(buildNewView(input(w, { edition: null })).offHome, 0, "unknown without an edition");
  });

  it("uses first-seen time, not publish time", () => {
    const w = world();
    const v = buildNewView(input(w, { previousMs: NOW - 3.5 * HOUR_MS }));
    const all = v.groups.flatMap((g) => g.items.map((r) => r.id));
    assert.ok(all.includes(w.backdated.id), "published 90 h ago, first seen 2 h ago");
    assert.ok(!all.includes(w.rotated.id), "first seen 4 h ago");
  });

  it("first visit falls back to the last 24 hours", () => {
    const w = world();
    const v = buildNewView(input(w, { previousMs: null }));
    assert.equal(v.firstVisit, true);
    assert.equal(v.sinceMs, NOW - DAY_MS);
    assert.equal(v.total, 6);
  });

  it("counts from the previous visit, or from 24 hours ago on a first visit; a cut-off at now leaves nothing", () => {
    assert.equal(sinceMs(100, 1000), 100);
    assert.equal(sinceMs(null, DAY_MS + 5), 5);
    const w = world();
    const v = buildNewView(input(w, { previousMs: NOW }));
    assert.equal(v.total, 0);
    assert.deepEqual(v.groups, []);
    assert.equal(v.firstVisit, false);
  });

  it("respects muted sources and sections", () => {
    const w = world();
    const v = buildNewView(input(w, { mutes: { sources: new Set(), sections: new Set(["cyber", "policy"]) } }));
    assert.deepEqual(v.groups.map((g) => g.section), ["models", "industry"]);
  });

  it("`ids` are the river article ids behind the rows (for the read state)", () => {
    const w = world();
    const v = buildNewView(input(w));
    assert.deepEqual(new Set(v.ids), new Set([w.member.id, w.fresh.id, w.rotated.id, w.cyber.id, w.backdated.id]));
  });

  it("works on the committed fixture and finds stories that are not on the home page", () => {
    const e = fixtureEdition();
    const now = Date.parse(e.meta.generatedAt);
    const v = buildNewView({ river: fixtureRiver, edition: e, previousMs: now - 12 * HOUR_MS, nowMs: now, mutes: NO_MUTES });
    assert.ok(v.total > 20, `new stories: ${v.total}`);
    assert.ok(v.offHome > 0 && v.offHome <= v.total);
    const idsShown = v.groups.flatMap((g) => g.items.map((r) => r.id));
    assert.equal(new Set(idsShown).size, idsShown.length);
    assert.equal(idsShown.length, v.total);
  });
});

describe("new/markAllSeen", () => {
  it("moves the lastVisit cut-off (subscribers are told) and records the articles as seen", () => {
    const s = createFakeServices();
    let notified = 0;
    s.lastVisit.subscribe(() => notified++);
    markAllSeen(s, ["a1", "b2"], 12345);
    assert.equal(s.lastVisit.get().previousMs, 12345);
    assert.equal(notified, 1);
    assert.deepEqual(s.calls, ["readState.markSeen a1", "readState.markSeen b2", "lastVisit.markAllSeen"]);
  });

  it("caps the read-state writes at the LRU size", () => {
    const s = createFakeServices();
    markAllSeen(s, Array.from({ length: 700 }, (_, i) => `id${i}`), 99);
    assert.equal(s.calls.filter((c) => c.startsWith("readState.markSeen")).length, 500);
  });
});
