import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeItem, makeSource } from "../../../test/helpers/factories";
import { resolveSource } from "../../registry/defaults";
import type { SourceDef } from "../../registry/types";
import { emptyState } from "../context";
import type { PipelineState } from "../types";
import { parseDate } from "./dates";
import { dedupeWithinSource, foldTwins, isBaselineRun, ledgerFirstSeen, resolveTimes, TITLE_DUPLICATE_WINDOW_DAYS, type Draft } from "./dedupe";
import { itemIdentity } from "./url";

const NOW = new Date("2026-11-19T21:00:00.000Z");
const DAY = 86_400_000;

let order = 0;
function draft(source: SourceDef, link: string, title: string, publishedRaw: string | null = "2026-11-19T10:00:00Z", sourceOrder = 0): Draft {
  const identity = itemIdentity(link);
  assert.ok(identity, link);
  return { raw: makeItem({ sourceId: source.id, link, title, publishedRaw }), source: resolveSource(source), sourceOrder, identity, title, date: parseDate(publishedRaw, NOW), order: order++ };
}

const stateWith = (patch: Partial<PipelineState>): PipelineState => ({ ...emptyState(), ...patch });

describe("dedupeWithinSource", () => {
  const blog = makeSource({ id: "shtetl-optimized", name: "Shtetl-Optimized" });

  it("keeps all ten ?p= permalinks of one feed (V1 kept 1 of 10)", () => {
    const posts = [10321, 10318, 10295, 10283, 10270, 10232, 10239, 10235, 10222, 10204];
    const drafts = posts.map((p, i) => draft(blog, `https://scottaaronson.blog/?p=${p}`, `Post number ${p}`, `2026-11-${String(19 - i).padStart(2, "0")}T10:00:00Z`));
    const { kept, dropped } = dedupeWithinSource(drafts);
    assert.equal(kept.length, 10);
    assert.equal(dropped.length, 0);
  });

  it("drops the same URL listed twice (tracking / fragment / scheme variants included); the first wins", () => {
    const drafts = [
      draft(blog, "https://example.com/story", "The story"),
      draft(blog, "https://example.com/story?utm_source=rss", "The story (updated)"),
      draft(blog, "http://www.example.com/story#comments", "The story again"),
      draft(blog, "https://example.com/other", "Another story"),
    ];
    const { kept, dropped } = dedupeWithinSource(drafts);
    assert.deepEqual(kept.map((d) => d.title), ["The story", "Another story"]);
    assert.deepEqual(dropped.map((d) => d.detail), ["same URL listed twice by the source", "same URL listed twice by the source"]);
  });

  it("drops an exact-title repeat from the same source (case and spacing ignored)", () => {
    const drafts = [draft(blog, "https://example.com/a", "Weekly  Roundup"), draft(blog, "https://example.com/b", "weekly roundup")];
    const { kept, dropped } = dedupeWithinSource(drafts);
    assert.equal(kept.length, 1);
    assert.equal(dropped[0].detail, "same title listed twice by the source");
  });

  it("the same title weeks apart is a recurring column, not a duplicate", () => {
    const drafts = [
      draft(blog, "https://example.com/open-thread-2", "Open Thread", "2026-11-19T10:00:00Z"),
      draft(blog, "https://example.com/open-thread-1", "Open Thread", "2026-11-12T10:00:00Z"),
      draft(blog, "https://example.com/open-thread-1b", "Open Thread", new Date(Date.parse("2026-11-19T10:00:00Z") - (TITLE_DUPLICATE_WINDOW_DAYS - 1) * DAY).toISOString()),
    ];
    const { kept, dropped } = dedupeWithinSource(drafts);
    assert.deepEqual(kept.map((d) => d.identity.url), ["https://example.com/open-thread-2", "https://example.com/open-thread-1"]);
    assert.equal(dropped.length, 1);
  });

  it("without a date on one side, an identical title is a duplicate", () => {
    const { kept } = dedupeWithinSource([draft(blog, "https://example.com/a", "Same title", null), draft(blog, "https://example.com/b", "Same title", "2026-10-01T00:00:00Z")]);
    assert.equal(kept.length, 1);
  });

  it("never dedupes across sources", () => {
    const other = makeSource({ id: "other-blog" });
    const { kept, dropped } = dedupeWithinSource([draft(blog, "https://example.com/a", "Same title"), draft(other, "https://example.com/a", "Same title")]);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });
});

describe("foldTwins", () => {
  const news = makeSource({ id: "openai-news", name: "OpenAI News", publisher: "openai", home: "models", tier: 1 });
  const blog = makeSource({ id: "openai-blog", name: "OpenAI Blog", publisher: "openai", home: "tools", tier: 2 });
  const query = makeSource({ id: "gn-openai", name: "OpenAI (Google News)", publisher: "google-news", kind: "query", tier: 1 });

  it("folds the same URL from two feeds into one group; the higher tier leads", () => {
    const groups = foldTwins([
      draft(blog, "https://openai.com/index/gpt-6-2", "Introducing GPT-6.2 Astra and Sol", undefined, 1),
      draft(news, "https://openai.com/index/gpt-6-2", "Introducing GPT-6.2 Astra and Sol", undefined, 0),
      draft(news, "https://openai.com/index/other", "Something else", undefined, 0),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].primary.source.id, "openai-news");
    assert.deepEqual(groups[0].twins.map((d) => d.source.id), ["openai-blog"]);
    assert.deepEqual(groups[1].twins, []);
  });

  it("at equal tier a publisher's own feed leads over a query / aggregator feed", () => {
    const groups = foldTwins([draft(query, "https://openai.com/index/x", "X - OpenAI", undefined, 0), draft(news, "https://www.openai.com/index/x/", "X", undefined, 5)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primary.source.id, "openai-news");
    assert.deepEqual(groups[0].twins.map((d) => d.source.id), ["gn-openai"]);
  });

  it("then registry order decides; groups keep input order", () => {
    const a = makeSource({ id: "a-feed", tier: 2 });
    const b = makeSource({ id: "b-feed", tier: 2 });
    const groups = foldTwins([draft(b, "https://example.com/2", "Two", undefined, 7), draft(b, "https://example.com/1", "One", undefined, 7), draft(a, "https://example.com/1", "One", undefined, 3)]);
    assert.deepEqual(groups.map((g) => g.primary.identity.url), ["https://example.com/2", "https://example.com/1"]);
    assert.equal(groups[1].primary.source.id, "a-feed");
  });

  it("different query parameters are different articles", () => {
    assert.equal(foldTwins([draft(news, "https://example.com/?p=1", "One"), draft(blog, "https://example.com/?p=2", "Two")]).length, 2);
  });
});

describe("ledgerFirstSeen", () => {
  it("returns the earliest known sighting among the ids, null when none", () => {
    const state = stateWith({ firstSeen: { aaa: "2026-11-10T00:00:00.000Z", bbb: "2026-11-05T00:00:00.000Z", ccc: "not a date" } });
    assert.equal(ledgerFirstSeen(["aaa"], state, NOW.getTime()), Date.parse("2026-11-10T00:00:00.000Z"));
    assert.equal(ledgerFirstSeen(["aaa", "bbb"], state, NOW.getTime()), Date.parse("2026-11-05T00:00:00.000Z"));
    assert.equal(ledgerFirstSeen(["ccc"], state, NOW.getTime()), null);
    assert.equal(ledgerFirstSeen(["zzz"], state, NOW.getTime()), null);
  });

  it("does not read inherited object properties and clamps future entries to the clock", () => {
    const state = stateWith({ firstSeen: { soon: "2026-12-01T00:00:00.000Z" } });
    assert.equal(ledgerFirstSeen(["constructor", "toString", "__proto__"], state, NOW.getTime()), null);
    assert.equal(ledgerFirstSeen(["soon"], state, NOW.getTime()), NOW.getTime());
  });
});

describe("isBaselineRun", () => {
  it("true on a brand-new state", () => {
    assert.equal(isBaselineRun("gray-swan", emptyState()), true);
  });

  it("false for a source the state already tracks", () => {
    const health = { "gray-swan": { failStreak: 0, lastOkAt: "2026-11-19T20:00:00.000Z", lastAttemptAt: "2026-11-19T20:00:00.000Z" } };
    assert.equal(isBaselineRun("gray-swan", stateWith({ firstSeen: { x: "2026-11-01T00:00:00.000Z" }, health })), false);
  });

  it("true for a source added after the state was started", () => {
    const health = { "other-source": { failStreak: 0, lastOkAt: "2026-11-19T20:00:00.000Z", lastAttemptAt: null } };
    assert.equal(isBaselineRun("brand-new-source", stateWith({ firstSeen: { x: "2026-11-01T00:00:00.000Z" }, health })), true);
  });

  it("true for a source whose every fetch so far failed; false once it was read, even when it was empty", () => {
    const firstSeen = { x: "2026-11-01T00:00:00.000Z" };
    const down = { failStreak: 2, lastOkAt: null, lastAttemptAt: "2026-11-19T20:00:00.000Z", lastError: "HTTP 502", lastErrorClass: "http" as const };
    assert.equal(isBaselineRun("hn-qwen", stateWith({ firstSeen, health: { "hn-qwen": down } })), true);
    assert.equal(isBaselineRun("nist", stateWith({ firstSeen, health: { nist: { ...down, lastError: "no items", lastErrorClass: "empty" as const } } })), false);
    assert.equal(isBaselineRun("hn-qwen", stateWith({ firstSeen, health: { "hn-qwen": { ...down, lastOkAt: "2026-11-18T20:00:00.000Z" } } })), false);
  });

  it("false when the state tracks no sources at all (cannot tell: treat items as new)", () => {
    assert.equal(isBaselineRun("gray-swan", stateWith({ firstSeen: { x: "2026-11-01T00:00:00.000Z" } })), false);
  });
});

describe("resolveTimes", () => {
  const known = stateWith({
    firstSeen: { known: "2026-11-01T08:00:00.000Z" },
    health: { src: { failStreak: 0, lastOkAt: "2026-11-19T20:00:00.000Z", lastAttemptAt: "2026-11-19T20:00:00.000Z" } },
  });
  const input = (ids: string[], raws: (string | null)[]) => ({ ids, dates: raws.map((r) => parseDate(r, NOW)), sourceId: "src", maxAgeDays: 21 });

  it("dated item: effectiveAt = publishedAt; firstSeenAt from the ledger else the clock", () => {
    assert.deepEqual(resolveTimes(input(["new"], ["2026-11-19T10:00:00Z"]), known, NOW), {
      publishedAt: "2026-11-19T10:00:00.000Z",
      firstSeenAt: NOW.toISOString(),
      effectiveAt: "2026-11-19T10:00:00.000Z",
    });
    assert.equal(resolveTimes(input(["known"], ["2026-11-01T07:00:00Z"]), known, NOW).firstSeenAt, "2026-11-01T08:00:00.000Z");
  });

  it("undated item seen before: effectiveAt = its first sighting, so it ages like any other item", () => {
    assert.deepEqual(resolveTimes(input(["known"], [null]), known, NOW), {
      publishedAt: null,
      firstSeenAt: "2026-11-01T08:00:00.000Z",
      effectiveAt: "2026-11-01T08:00:00.000Z",
    });
  });

  it("undated NEW item of a known source: first seen now", () => {
    const t = resolveTimes(input(["fresh"], [null]), known, NOW);
    assert.equal(t.publishedAt, null);
    assert.equal(t.firstSeenAt, NOW.toISOString());
    assert.equal(t.effectiveAt, NOW.toISOString());
  });

  it("BASELINE: an undated item on the first build that sees its source is back catalogue, not news", () => {
    const t = resolveTimes(input(["fresh"], [null]), emptyState(), NOW);
    assert.equal(t.publishedAt, null);
    assert.equal(t.firstSeenAt, new Date(NOW.getTime() - 22 * DAY).toISOString());
    assert.equal(t.effectiveAt, t.firstSeenAt);
  });

  it("BASELINE: a dated item on the first build that sees its source is first seen when it was published", () => {
    const t = resolveTimes(input(["fresh"], ["2026-11-19T10:00:00Z"]), emptyState(), NOW);
    assert.deepEqual(t, { publishedAt: "2026-11-19T10:00:00.000Z", firstSeenAt: "2026-11-19T10:00:00.000Z", effectiveAt: "2026-11-19T10:00:00.000Z" });
    // Once the source is known, a new dated item is new: first seen at the build clock.
    const known = { ...emptyState(), firstSeen: { other: NOW.toISOString() }, health: { src: { failStreak: 0, lastOkAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString() } } };
    const later = resolveTimes({ ...input(["fresh"], ["2026-11-19T10:00:00Z"]), sourceId: "src" }, known, NOW);
    assert.equal(later.firstSeenAt, NOW.toISOString());
    assert.equal(later.publishedAt, "2026-11-19T10:00:00.000Z");
  });

  it("a future-dated item is rejected to null and counts as first seen now, even on a baseline run", () => {
    const t = resolveTimes(input(["fresh"], ["2026-12-03T16:00:00Z"]), emptyState(), NOW);
    assert.deepEqual(t, { publishedAt: null, firstSeenAt: NOW.toISOString(), effectiveAt: NOW.toISOString() });
  });

  it("twins: a copy with a real time of day beats a date-only stamp; the earliest ledger entry wins", () => {
    const state = stateWith({ ...known, firstSeen: { a: "2026-11-18T15:00:00.000Z", b: "2026-11-18T14:30:00.000Z" } });
    const t = resolveTimes(input(["a", "b"], ["2026-11-18T00:00:00Z", "2026-11-18T14:05:00Z"]), state, NOW);
    assert.equal(t.publishedAt, "2026-11-18T14:05:00.000Z");
    assert.equal(t.firstSeenAt, "2026-11-18T14:30:00.000Z");
  });

  it("date-only stamp first seen before noon keeps the sighting time on every later build", () => {
    const state = stateWith({ ...known, firstSeen: { a: "2026-11-19T07:30:00.000Z" } });
    assert.equal(resolveTimes(input(["a"], ["2026-11-19"]), state, NOW).publishedAt, "2026-11-19T07:30:00.000Z");
  });
});
