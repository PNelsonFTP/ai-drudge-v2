import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS,
  HOUR_MS,
  TIME_FILTERS,
  ageDays,
  ageHours,
  effectiveAt,
  effectiveMs,
  isNew,
  isStale,
  parseMs,
  passesTimeFilter,
  shortAge,
  staleHours,
  timeAgo,
  toMs,
  withinHours,
} from "./time";

const NOW = Date.parse("2026-11-19T21:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("shared/time", () => {
  it("parseMs / toMs", () => {
    assert.equal(parseMs("2026-11-19T21:00:00.000Z"), NOW);
    assert.equal(parseMs(null), null);
    assert.equal(parseMs(undefined), null);
    assert.equal(parseMs(""), null);
    assert.equal(parseMs("not a date"), null);
    assert.equal(toMs(new Date(NOW)), NOW);
    assert.equal(toMs(NOW), NOW);
  });

  it("ageHours takes the clock as a parameter (number or Date)", () => {
    assert.equal(ageHours(ago(3 * HOUR_MS), NOW), 3);
    assert.equal(ageHours(ago(3 * HOUR_MS), new Date(NOW)), 3);
    assert.equal(ageHours(null, NOW), Infinity);
    assert.equal(ageHours("garbage", NOW), Infinity);
    assert.equal(ageHours(new Date(NOW + HOUR_MS).toISOString(), NOW), 0, "future clamps to 0");
    assert.equal(ageDays(ago(2 * DAY_MS), NOW), 2);
  });

  it("timeAgo display ladder", () => {
    assert.equal(timeAgo(ago(30_000), NOW), "just now");
    assert.equal(timeAgo(ago(5 * 60_000), NOW), "5m ago");
    assert.equal(timeAgo(ago(59 * 60_000), NOW), "59m ago");
    assert.equal(timeAgo(ago(3 * HOUR_MS), NOW), "3h ago");
    assert.equal(timeAgo(ago(47 * HOUR_MS), NOW), "1d ago");
    assert.equal(timeAgo(ago(6 * DAY_MS), NOW), "6d ago");
    assert.equal(timeAgo("2026-11-05T10:00:00Z", NOW), "Nov 5");
    assert.equal(timeAgo("2025-03-14T10:00:00Z", NOW), "Mar 14, 2025");
    assert.equal(timeAgo(null, NOW), "");
    assert.equal(timeAgo("nope", NOW), "");
    assert.equal(timeAgo(new Date(NOW + HOUR_MS).toISOString(), NOW), "just now");
  });

  it("shortAge for 'updated Xm ago'", () => {
    assert.equal(shortAge(ago(20_000), NOW), "now");
    assert.equal(shortAge(ago(12 * 60_000), NOW), "12m");
    assert.equal(shortAge(ago(5 * HOUR_MS), NOW), "5h");
    assert.equal(shortAge(ago(3 * DAY_MS), NOW), "3d");
    assert.equal(shortAge(null, NOW), "");
  });

  it("isNew (< 6 h) and isStale (> 72 h) with boundaries", () => {
    assert.equal(isNew(ago(6 * HOUR_MS), NOW), true);
    assert.equal(isNew(ago(6 * HOUR_MS + 1), NOW), false);
    assert.equal(isNew(null, NOW), false);
    assert.equal(isNew(ago(10 * HOUR_MS), NOW, 12), true);
    assert.equal(isStale(ago(72 * HOUR_MS), NOW), false);
    assert.equal(isStale(ago(72 * HOUR_MS + 1), NOW), true);
    assert.equal(isStale(null, NOW), false, "a missing date is never stale");
    assert.equal(withinHours(ago(23 * HOUR_MS), NOW, 24), true);
    assert.equal(withinHours(null, NOW, 24), false);
  });

  it("effectiveAt = publishedAt ?? firstSeenAt", () => {
    const seen = ago(HOUR_MS);
    assert.equal(effectiveAt({ publishedAt: null, firstSeenAt: seen }), seen);
    assert.equal(effectiveAt({ publishedAt: ago(5 * HOUR_MS), firstSeenAt: seen }), ago(5 * HOUR_MS));
    assert.equal(effectiveMs({ publishedAt: null, firstSeenAt: seen }), NOW - HOUR_MS);
    assert.equal(effectiveMs({ publishedAt: "bad", firstSeenAt: "worse" }), 0);
  });

  it("passesTimeFilter implements the NEW · 6H · 24H · 3D · ALL chips", () => {
    assert.deepEqual([...TIME_FILTERS], ["new", "6h", "24h", "3d", "all"]);
    const a = { publishedAt: ago(10 * HOUR_MS), firstSeenAt: ago(2 * HOUR_MS) };
    assert.equal(passesTimeFilter(a, "all", NOW, null), true);
    assert.equal(passesTimeFilter(a, "6h", NOW, null), false);
    assert.equal(passesTimeFilter(a, "24h", NOW, null), true);
    assert.equal(passesTimeFilter({ publishedAt: ago(71 * HOUR_MS), firstSeenAt: ago(HOUR_MS) }, "3d", NOW, null), true);
    assert.equal(passesTimeFilter({ publishedAt: ago(73 * HOUR_MS), firstSeenAt: ago(HOUR_MS) }, "3d", NOW, null), false);
    // "new": first seen after the previous visit...
    assert.equal(passesTimeFilter(a, "new", NOW, NOW - 3 * HOUR_MS), true);
    assert.equal(passesTimeFilter(a, "new", NOW, NOW - HOUR_MS), false);
    // ...and the NEW-badge rule on a first visit
    assert.equal(passesTimeFilter(a, "new", NOW, null), false);
    assert.equal(passesTimeFilter({ publishedAt: ago(HOUR_MS), firstSeenAt: ago(HOUR_MS) }, "new", NOW, null), true);
    // an undated item uses firstSeenAt as its effective time
    assert.equal(passesTimeFilter({ publishedAt: null, firstSeenAt: ago(HOUR_MS) }, "6h", NOW, null), true);
  });

  it("staleHours of an edition", () => {
    assert.equal(staleHours(ago(7 * HOUR_MS), NOW), 7);
    assert.equal(staleHours(null, NOW), null);
    assert.equal(staleHours("bad", NOW), null);
  });
});
