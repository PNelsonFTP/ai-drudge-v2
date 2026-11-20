import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ARTICLE_FLAGS, DATA_DIR, DATA_FILES, FEED_STATUSES, RIVER, RIVER_DAYS, SCHEMA_VERSION, STATUS_SCHEMA, TOP_STORIES_MAX, type RiverRow } from "./contract";

describe("shared/contract constants", () => {
  it("pins the schema constants", () => {
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(STATUS_SCHEMA, 1);
    assert.equal(TOP_STORIES_MAX, 12);
    assert.equal(RIVER_DAYS, 7);
    assert.equal(DATA_DIR, "data/v2/");
    assert.deepEqual([...ARTICLE_FLAGS], ["release", "paper", "discussion", "paywall"]);
    assert.deepEqual([...FEED_STATUSES], ["ok", "failing", "quarantined", "carried"]);
  });

  it("names the nine data files; the committed fixture holds all but state.json", () => {
    assert.deepEqual(Object.values(DATA_FILES).sort(), ["brief.json", "front.json", "health.json", "rest.json", "river.json", "sources.json", "state.json", "status.json", "stocks.json"]);
    const dir = new URL("../test/fixtures/v2/", import.meta.url);
    const have = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(have, Object.values(DATA_FILES).filter((f) => f !== "state.json").sort());
  });

  it("RIVER indexes match the RiverRow tuple", () => {
    const row: RiverRow = ["abc", "Title", "https://example.com/x", 3, "models", 1000, 2000, "lead1"];
    assert.equal(row[RIVER.id], "abc");
    assert.equal(row[RIVER.title], "Title");
    assert.equal(row[RIVER.url], "https://example.com/x");
    assert.equal(row[RIVER.source], 3);
    assert.equal(row[RIVER.section], "models");
    assert.equal(row[RIVER.publishedAt], 1000);
    assert.equal(row[RIVER.firstSeenAt], 2000);
    assert.equal(row[RIVER.lead], "lead1");
  });
});
