import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RIVER, type RiverRow } from "../../../shared/contract";
import { checkRiver } from "../../../shared/invariants";
import { validateRiverFile } from "../../../shared/guards";
import { riverRows } from "../../../shared/select";
import { DAY_MS, HOUR_MS } from "../../../shared/time";
import { FIXTURE_NOW_MS, makeScoredStory } from "../../../test/helpers/factories";
import { createTestContext, emptyState } from "../context";
import type { DroppedItem, RecentItem } from "../types";
import { RIVER_MAX_ROWS, buildRiver, rejectedThisRun } from "./river";
import { itemOf, makePlacements, sample } from "./testkit.test";

const recent = (over: Partial<RecentItem>): RecentItem => ({
  id: "old1",
  title: "Yesterday's story",
  url: "https://techcrunch.com/yesterday",
  sourceId: "techcrunch-ai",
  section: "industry",
  publishedAtMs: FIXTURE_NOW_MS - 30 * HOUR_MS,
  firstSeenAtMs: FIXTURE_NOW_MS - 29 * HOUR_MS,
  leadId: null,
  ...over,
});

describe("emit: river", () => {
  it("lists every kept item (leads, members, unplaced) as tuples, newest first", () => {
    const s = sample();
    const river = buildRiver(s.placements, s.registry, createTestContext());
    assert.equal(validateRiverFile(river), null);
    assert.deepEqual(checkRiver(river), []);
    const total = Object.values(s.placements.stories).reduce((n, st) => n + st.items.length, 0);
    assert.equal(river.rows.length, total);
    const times = river.rows.map((r) => r[RIVER.publishedAt] ?? r[RIVER.firstSeenAt]);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.equal(river.sources.length, river.sourceIds.length);
  });

  it("records the lead of clustered members, null for leads and singletons, and the story's primary section", () => {
    const s = sample();
    const rows = riverRows(buildRiver(s.placements, s.registry, createTestContext()));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(s.story.ipo.lead)?.leadId, null);
    assert.equal(byId.get(s.item.bloomberg.id)?.leadId, s.story.ipo.lead);
    assert.equal(byId.get(s.item.bloomberg.id)?.section, "industry");
    assert.equal(byId.get(s.item.bloomberg.id)?.sourceName, "Google News: AI");
    assert.equal(byId.get(s.story.paper.lead)?.leadId, null);
    assert.equal(byId.get(s.story.unplaced.lead)?.section, "industry", "an unplaced story is listed under the section it would belong to");
    assert.equal(byId.get(s.story.release.lead)?.section, "releases");
  });

  it("merges the previous builds' memory, without duplicates, dropping removed sources and anything older than 7 days", () => {
    const s = sample();
    const state = {
      ...emptyState(),
      recent: [
        recent({}),
        recent({ id: "old2", url: "https://techcrunch.com/member", leadId: "old1" }),
        recent({ id: s.story.ipo.lead, title: "stale copy of a current item" }),
        recent({ id: "gone", sourceId: "removed-from-registry" }),
        recent({ id: "ancient", publishedAtMs: FIXTURE_NOW_MS - 8 * DAY_MS, firstSeenAtMs: FIXTURE_NOW_MS - 8 * DAY_MS }),
        recent({ id: "undated", publishedAtMs: null, firstSeenAtMs: FIXTURE_NOW_MS - 2 * DAY_MS }),
        recent({ id: "selfref", url: "https://techcrunch.com/selfref", leadId: "selfref" }),
      ],
    };
    const river = buildRiver(s.placements, s.registry, createTestContext({ state }));
    assert.deepEqual(checkRiver(river), []);
    const byId = new Map(riverRows(river).map((r) => [r.id, r]));
    assert.ok(byId.has("old1"));
    assert.equal(byId.get("old2")?.leadId, "old1");
    assert.equal(byId.get(s.story.ipo.lead)?.title, "Anthropic valued at $2tn as shares begin trading", "this run's item wins over memory");
    assert.ok(!byId.has("gone"));
    assert.ok(!byId.has("ancient"));
    assert.equal(byId.get("undated")?.publishedAtMs, null);
    assert.equal(byId.get("selfref")?.leadId, null);
  });

  it("an item whose wrapper link was resolved replaces its old row; rows that pointed at the old id follow", () => {
    const s = sample();
    const lead = { ...s.placements.stories[s.story.ipo.lead].items[0], formerIds: ["wrapped1"] };
    const stories = Object.values(s.placements.stories).map((st) => (st.lead === lead.id ? { ...st, items: [lead, ...st.items.slice(1)] } : st));
    const placements = { ...s.placements, stories: Object.fromEntries(stories.map((st) => [st.lead, st])) };
    const state = {
      ...emptyState(),
      recent: [recent({ id: "wrapped1", url: "https://news.google.com/rss/articles/CBMiWrapped" }), recent({ id: "old2", url: "https://techcrunch.com/member", leadId: "wrapped1" })],
    };
    const river = buildRiver(placements, s.registry, createTestContext({ state }));
    assert.deepEqual(checkRiver(river), []);
    const byId = new Map(riverRows(river).map((r) => [r.id, r]));
    assert.ok(!byId.has("wrapped1"), "the wrapper's row is gone");
    assert.equal(byId.get("old2")?.leadId, lead.id);
  });

  it("a remembered row leaves when this run saw the item again and rejected it on content", () => {
    const s = sample();
    const state = {
      ...emptyState(),
      recent: [
        recent({ id: "junk1", url: "https://techcrunch.com/subscribe-coupon", title: "- The Kaitchup" }),
        recent({ id: "junk2", url: "https://techcrunch.com/postgres", title: "PostgreSQL 19 Released" }),
        recent({ id: "capped", url: "https://techcrunch.com/capped", title: "Fine yesterday, over the cap today" }),
        recent({ id: "aged", url: "https://techcrunch.com/aged", title: "Too old for its source, still inside the river week" }),
        recent({ id: "other", url: "https://techcrunch.com/other", title: "Rejected under another source only" }),
        recent({ id: "kept", url: "https://techcrunch.com/kept", title: "Not seen this run" }),
      ],
    };
    const src = state.recent[0].sourceId;
    const drop = (id: string, reason: DroppedItem["reason"], sourceId = src): DroppedItem => ({ id, sourceId, title: id, url: `https://techcrunch.com/${id}`, reason, stage: "relevance" });
    const dropped: DroppedItem[] = [drop("junk1", "invalid"), drop("junk2", "excluded"), drop("capped", "source_cap"), drop("aged", "too_old"), drop("other", "off_topic", "some-other-source"), { ...drop("x", "invalid"), id: null }];
    const rejected = rejectedThisRun(dropped);
    assert.equal(rejected.size, 3, "invalid / excluded / off_topic / noise only, and only with an id");
    const ids = new Set(riverRows(buildRiver(s.placements, s.registry, createTestContext({ state }), rejected)).map((r) => r.id));
    assert.deepEqual(["junk1", "junk2", "capped", "aged", "other", "kept"].map((id) => ids.has(id)), [false, false, true, true, true, true]);
    // Without the set nothing changes (memory rolls forward as before).
    const all = new Set(riverRows(buildRiver(s.placements, s.registry, createTestContext({ state }))).map((r) => r.id));
    assert.ok(all.has("junk1") && all.has("junk2"));
    assert.equal(rejectedThisRun(undefined).size, 0);
  });

  it("drops current items older than 7 days too", () => {
    const s = sample();
    const old = makeScoredStory([itemOf(s.registry, "arxiv-cs-ai", { url: "https://arxiv.org/abs/2610.00001", title: "A ten day old paper", publishedAt: new Date(FIXTURE_NOW_MS - 10 * DAY_MS).toISOString() })]);
    const river = buildRiver(makePlacements({ stories: [old, s.story.paper], rows: { research: [old.lead, s.story.paper.lead] } }), s.registry, createTestContext());
    assert.deepEqual(river.rows.map((r) => r[RIVER.id]), [s.story.paper.lead]);
  });

  it("caps the river by trimming memory only, oldest first", () => {
    const s = sample();
    const memory = Array.from({ length: RIVER_MAX_ROWS + 50 }, (_, i) => recent({ id: `m${i}`, url: `https://techcrunch.com/m/${i}`, publishedAtMs: FIXTURE_NOW_MS - DAY_MS - i * 1000, firstSeenAtMs: FIXTURE_NOW_MS - DAY_MS }));
    const river = buildRiver(s.placements, s.registry, createTestContext({ state: { ...emptyState(), recent: memory } }));
    assert.equal(river.rows.length, RIVER_MAX_ROWS);
    const ids = new Set(river.rows.map((r: RiverRow) => r[RIVER.id]));
    for (const st of Object.values(s.placements.stories)) for (const item of st.items) assert.ok(ids.has(item.id), "every item of this run survives the cap");
    assert.ok(ids.has("m0") && !ids.has(`m${RIVER_MAX_ROWS + 49}`));
  });
});
