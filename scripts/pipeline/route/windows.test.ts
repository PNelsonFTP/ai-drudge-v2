import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, sectionById } from "../../../shared/sections";
import { FIXTURE_NOW_MS, hoursAgo } from "../../../test/helpers/factories";
import { splitByWindow, windowBand } from "./windows";

const NOW = FIXTURE_NOW_MS;
const daysAgo = (d: number): string => hoursAgo(d * 24);

describe("section windows on effectiveAt", () => {
  it("soft up to softDays, backfill up to hardDays, expired beyond (boundaries inclusive)", () => {
    const w = sectionById("tools").window; // 3 / 6
    assert.equal(windowBand(daysAgo(0), w, NOW), "soft");
    assert.equal(windowBand(daysAgo(3), w, NOW), "soft");
    assert.equal(windowBand(hoursAgo(3 * 24 + 1), w, NOW), "backfill");
    assert.equal(windowBand(daysAgo(6), w, NOW), "backfill");
    assert.equal(windowBand(hoursAgo(6 * 24 + 1), w, NOW), "expired");
  });

  it("uses each section's own numbers from shared/sections", () => {
    for (const def of SECTIONS) {
      assert.equal(windowBand(daysAgo(def.window.softDays), def.window, NOW), "soft", def.id);
      assert.equal(windowBand(daysAgo(def.window.hardDays), def.window, NOW), "backfill", def.id);
      assert.equal(windowBand(daysAgo(def.window.hardDays + 0.1), def.window, NOW), "expired", def.id);
    }
    // 5 days old: gone from INDUSTRY (hard 4), still fresh in POLICY (soft 7).
    assert.equal(windowBand(daysAgo(5), sectionById("industry").window, NOW), "expired");
    assert.equal(windowBand(daysAgo(5), sectionById("policy").window, NOW), "soft");
  });

  it("a slightly future date is fresh; a missing or broken date is expired", () => {
    const w = sectionById("industry").window;
    assert.equal(windowBand(hoursAgo(-0.5), w, NOW), "soft");
    assert.equal(windowBand("not a date", w, NOW), "expired");
    assert.equal(windowBand(null, w, NOW), "expired");
  });

  it("an item may extend the hard window, never shorten it or become 'soft'", () => {
    const w = sectionById("cyber").window; // 3 / 7
    assert.equal(windowBand(daysAgo(20), w, NOW), "expired");
    assert.equal(windowBand(daysAgo(20), w, NOW, 30), "backfill");
    assert.equal(windowBand(daysAgo(31), w, NOW, 30), "expired");
    assert.equal(windowBand(daysAgo(6), w, NOW, 2), "backfill");
    assert.equal(windowBand(daysAgo(1), w, NOW, 30), "soft");
    const items = [{ id: "a", effectiveAt: daysAgo(20), keep: 30 }, { id: "b", effectiveAt: daysAgo(20) }];
    const got = splitByWindow(items, w, NOW, (i) => (i as { keep?: number }).keep);
    assert.deepEqual([got.backfill.map((i) => i.id), got.expired.map((i) => i.id)], [["a"], ["b"]]);
  });

  it("splitByWindow keeps input order inside each band and accepts a Date clock", () => {
    const w = sectionById("tools").window; // 3 / 6
    const items = [1, 100, 2, 200, 80].map((h) => ({ id: h, effectiveAt: hoursAgo(h) }));
    const got = splitByWindow(items, w, new Date(NOW));
    assert.deepEqual(got.soft.map((i) => i.id), [1, 2]);
    assert.deepEqual(got.backfill.map((i) => i.id), [100, 80]);
    assert.deepEqual(got.expired.map((i) => i.id), [200]);
  });
});
