import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeSourceRef } from "../../../test/helpers/factories";
import type { RowItem } from "../../app/services";
import { LATEST_COVERAGE_MIN_GAP_MS, articleForSaving, coverageExtra, isNewForReader, latestCoverageAt, resolveRow, rowClaims, rowPropsEqual, showsLatestCoverage } from "./rowModel";

const item = (over: Partial<RowItem> = {}): RowItem => ({ id: "abc", title: "River item", url: "https://example.com/r", sourceName: "Example Wire", publishedAt: hoursAgo(2), ...over });

describe("headline/rowModel resolveRow", () => {
  it("uses the edition article and its source name", () => {
    const a = makeArticle({ title: "Edition title", summary: "  A summary.  ", w: 3, flags: ["paper"], home: "research" });
    const row = resolveRow(a.id, a, makeSourceRef({ name: "Example Source", publisher: "Example" }), undefined);
    assert.ok(row);
    assert.equal(row.title, "Edition title");
    assert.equal(row.label, "Example Source");
    assert.equal(row.sourceName, "Example Source");
    assert.equal(row.sourceId, "example-source");
    assert.equal(row.summary, "A summary.");
    assert.equal(row.weightClass, "headline-critical");
    assert.deepEqual(row.flags, ["paper"]);
    assert.equal(row.section, "research");
    assert.equal(row.article, a);
  });

  it("labels a link-host item with its outlet, not with the feed that carried it", () => {
    const a = makeArticle({ src: "google-news-ai", pub: "Reuters" });
    const row = resolveRow(a.id, a, makeSourceRef({ name: "Google News: AI", publisher: "Google News" }), undefined);
    assert.equal(row?.label, "Reuters");
    assert.equal(row?.sourceName, "Google News: AI");
  });

  it("maps every weight to its class and defaults to medium", () => {
    const cls = (w: 0 | 1 | 2 | 3 | undefined) => resolveRow("x", makeArticle(w === undefined ? {} : { w }), undefined, undefined)?.weightClass;
    assert.deepEqual([cls(0), cls(undefined), cls(1), cls(2), cls(3)], ["headline-low", "headline-medium", "headline-medium", "headline-high", "headline-critical"]);
  });

  it("displays firstSeenAt when the source gave no date", () => {
    const a = makeArticle({ publishedAt: null, firstSeenAt: hoursAgo(3) });
    const row = resolveRow(a.id, a, undefined, undefined);
    assert.equal(row?.displayAt, hoursAgo(3));
    assert.equal(row?.label, "example-source", "falls back to the source id when the source is unknown");
  });

  it("falls back to the item when the id is not in the edition", () => {
    const row = resolveRow("abc", undefined, undefined, item({ sourceId: "example-wire", section: "policy", firstSeenAt: hoursAgo(1) }));
    assert.ok(row);
    assert.equal(row.title, "River item");
    assert.equal(row.label, "Example Wire");
    assert.equal(row.sourceId, "example-wire");
    assert.equal(row.section, "policy");
    assert.equal(row.weightClass, "headline-medium");
    assert.equal(row.summary, null);
    assert.equal(row.article, null);
  });

  it("an item only overrides the section of an edition article", () => {
    const a = makeArticle({ home: "industry" });
    const row = resolveRow(a.id, a, undefined, item({ id: a.id, title: "stale snapshot title", section: "money" }));
    assert.equal(row?.title, a.title);
    assert.equal(row?.section, "money");
  });

  it("is null without an article and without an item", () => {
    assert.equal(resolveRow("nope", undefined, undefined, undefined), null);
  });

  it("never passes on a URL that is not http(s)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "", "ftp://example.com/x"]) {
      assert.equal(resolveRow("abc", undefined, undefined, item({ url }))?.url, null, url);
    }
    assert.equal(resolveRow("abc", undefined, undefined, item({ url: "https://example.com/ok" }))?.url, "https://example.com/ok");
  });
});

describe("headline/rowModel isNewForReader", () => {
  const row = (firstSeenH: number | null, publishedH: number | null) => ({ firstSeenAt: firstSeenH === null ? null : hoursAgo(firstSeenH), publishedAt: publishedH === null ? null : hoursAgo(publishedH) });

  it("is new when first seen within 6 h and not seen in a previous session", () => {
    assert.equal(isNewForReader(row(2, 2), FIXTURE_NOW_MS, false), true);
    assert.equal(isNewForReader(row(6, 6), FIXTURE_NOW_MS, false), true);
    assert.equal(isNewForReader(row(6.1, 6.1), FIXTURE_NOW_MS, false), false);
  });

  it("is never new once the reader has seen it", () => {
    assert.equal(isNewForReader(row(1, 1), FIXTURE_NOW_MS, true), false);
  });

  it("goes by first-seen, not by the feed's date", () => {
    assert.equal(isNewForReader(row(9, 1), FIXTURE_NOW_MS, false), false, "re-dated old item");
    assert.equal(isNewForReader(row(1, 40), FIXTURE_NOW_MS, false), true, "old story the pipeline just found");
  });

  it("uses publishedAt only when first-seen is unknown (saved snapshots)", () => {
    assert.equal(isNewForReader(row(null, 2), FIXTURE_NOW_MS, false), true);
    assert.equal(isNewForReader(row(null, null), FIXTURE_NOW_MS, false), false);
  });
});

describe("headline/rowModel helpers", () => {
  it("coverageExtra is publishers minus the lead's", () => {
    assert.equal(coverageExtra(undefined), 0);
    assert.equal(coverageExtra({ members: ["a"], publishers: 1 }), 0);
    assert.equal(coverageExtra({ members: ["a", "b"], publishers: 6 }), 5);
  });

  it("articleForSaving returns the edition article, or builds one from a river row", () => {
    const a = makeArticle();
    assert.equal(articleForSaving(resolveRow(a.id, a, undefined, undefined)!, FIXTURE_NOW_MS), a);
    const built = articleForSaving(resolveRow("abc", undefined, undefined, item({ sourceId: "wire", section: "policy" }))!, FIXTURE_NOW_MS);
    assert.deepEqual(built, { id: "abc", url: "https://example.com/r", title: "River item", src: "wire", publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2), home: "policy", tier: 3 });
    const undated = articleForSaving(resolveRow("abc", undefined, undefined, item({ publishedAt: null }))!, FIXTURE_NOW_MS);
    assert.equal(undated.firstSeenAt, new Date(FIXTURE_NOW_MS).toISOString());
  });

  it("rowClaims: only rows the shell cannot serve take save / mute keys themselves", () => {
    const edition = resolveRow("x", makeArticle(), undefined, undefined)!;
    const river = resolveRow("abc", undefined, undefined, item())!;
    for (const action of ["bookmark", "later", "mute"]) {
      assert.equal(rowClaims(edition, action), false, `edition ${action}: the shell's default does it and announces it`);
      assert.equal(rowClaims(river, action), true, `river ${action}`);
    }
    for (const action of ["open", "summary", "also", "copy", "menu", "nonsense"]) assert.equal(rowClaims(river, action), false, action);
  });

  it("rowPropsEqual compares the item by value and everything else by identity", () => {
    const onOpen = () => undefined;
    assert.equal(rowPropsEqual({ id: "a" }, { id: "a" }), true);
    assert.equal(rowPropsEqual({ id: "a", item: item(), onOpen }, { id: "a", item: item(), onOpen }), true, "fresh but equal item object");
    assert.equal(rowPropsEqual({ id: "a", item: item() }, { id: "a", item: item({ title: "changed" }) }), false);
    assert.equal(rowPropsEqual({ id: "a", item: item() }, { id: "a" }), false);
    assert.equal(rowPropsEqual({ id: "a" }, { id: "b" }), false);
    assert.equal(rowPropsEqual({ id: "a", variant: "top" }, { id: "a", variant: "compact" }), false);
    assert.equal(rowPropsEqual({ id: "a", showSection: true }, { id: "a" }), false);
    assert.equal(rowPropsEqual({ id: "a", onOpen }, { id: "a", onOpen: () => undefined }), false);
  });
});

describe("headline/rowModel latestCoverageAt", () => {
  it("is the newest coverage time only when it is clearly later than the article on display", () => {
    const shown = hoursAgo(38);
    assert.equal(latestCoverageAt(shown, Date.parse(hoursAgo(0.9))), hoursAgo(0.9));
    assert.equal(latestCoverageAt(shown, Date.parse(shown) + LATEST_COVERAGE_MIN_GAP_MS), new Date(Date.parse(shown) + LATEST_COVERAGE_MIN_GAP_MS).toISOString());
    assert.equal(latestCoverageAt(shown, Date.parse(shown) + LATEST_COVERAGE_MIN_GAP_MS - 1), null, "less than an hour later says nothing new");
    assert.equal(latestCoverageAt(shown, Date.parse(shown)), null, "a singleton, or the lead is the newest");
    assert.equal(latestCoverageAt(shown, Date.parse(hoursAgo(50))), null, "older coverage");
    assert.equal(latestCoverageAt(shown, 0), null, "unknown");
    assert.equal(latestCoverageAt(null, FIXTURE_NOW_MS), null);
    assert.equal(latestCoverageAt("not a date", FIXTURE_NOW_MS), null);
    assert.equal(latestCoverageAt(shown, Number.NaN), null);
  });

  it("is printed only when it falls in a fresher time-chip window than the displayed time", () => {
    const now = FIXTURE_NOW_MS;
    const shows = (displayH: number, latestH: number): boolean => showsLatestCoverage(hoursAgo(displayH), hoursAgo(latestH), now);
    assert.equal(shows(38, 0.9), true, "3-day window vs 6 h");
    assert.equal(shows(38, 14), true, "3-day window vs 24 h");
    assert.equal(shows(9, 5), true, "24 h vs 6 h");
    assert.equal(shows(100, 50), true, "older than every chip vs 3 days");
    assert.equal(shows(18, 8), false, "both inside 24 h: the chips treat them alike");
    assert.equal(shows(4, 2), false);
    assert.equal(shows(50, 30), false);
    assert.equal(shows(200, 100), false);
    assert.equal(showsLatestCoverage(hoursAgo(38), null, now), false);
    assert.equal(showsLatestCoverage(null, hoursAgo(1), now), false);
  });
});
