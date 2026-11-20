import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_ITEMS, activeSources, indexSources, resolveSource } from "./defaults";
import type { SourceDef } from "./types";
import { SECTIONS } from "../../shared/sections";

const base: SourceDef = { id: "openai-news", name: "OpenAI News", publisher: "openai", url: "https://openai.com/news/rss.xml", kind: "rss", scope: "ai", home: "models", tier: 1 };

describe("scripts/registry/defaults resolveSource", () => {
  it("applies the defaults of an ordinary feed", () => {
    const r = resolveSource(base);
    assert.equal(r.routing, "normal");
    assert.equal(r.routeTo, null);
    assert.equal(r.leadEligible, true);
    assert.equal(r.countsForCoverage, true);
    assert.equal(r.attribution, "source");
    assert.equal(r.maxItems, DEFAULT_MAX_ITEMS);
    assert.equal(r.maxAgeDays, DEFAULT_MAX_AGE_DAYS);
    assert.equal(r.status, "active");
    assert.deepEqual(r.tags, []);
    assert.equal(r.id, "openai-news");
  });

  it("releases and community never lead and never raise coverage by default", () => {
    for (const kind of ["github-release", "community"] as const) {
      const r = resolveSource({ ...base, kind });
      assert.equal(r.leadEligible, false, kind);
      assert.equal(r.countsForCoverage, false, kind);
    }
    assert.equal(resolveSource({ ...base, kind: "community" }).routing, "home-only");
    assert.equal(resolveSource({ ...base, kind: "github-release" }).routing, "normal");
  });

  it("query and aggregator feeds attribute by link host by default", () => {
    assert.equal(resolveSource({ ...base, kind: "query" }).attribution, "link-host");
    assert.equal(resolveSource({ ...base, kind: "aggregator" }).attribution, "link-host");
    assert.equal(resolveSource({ ...base, kind: "newsletter" }).attribution, "source");
  });

  it("link-host sources vet their outlets unless they opt out; a feed that is its own publisher has none to vet", () => {
    assert.equal(resolveSource({ ...base, kind: "query" }).outlets, "vetted");
    assert.equal(resolveSource({ ...base, kind: "aggregator" }).outlets, "vetted");
    assert.equal(resolveSource({ ...base, kind: "json", attribution: "link-host" }).outlets, "vetted", "an HN search read as JSON is still a search feed");
    assert.equal(resolveSource({ ...base, kind: "query", outlets: "open" }).outlets, "open");
    assert.equal(resolveSource(base).outlets, "open");
    assert.equal(resolveSource({ ...base, kind: "query", attribution: "source" }).outlets, "open", "Federal Register: kind query, its own publisher");
  });

  it("explicit values always win", () => {
    const r = resolveSource({ ...base, kind: "community", routing: "normal", leadEligible: true, countsForCoverage: true, attribution: "link-host", routeTo: ["open_local"], maxItems: 5, maxAgeDays: 3, status: "paused", tags: ["lab"] });
    assert.deepEqual([r.routing, r.leadEligible, r.countsForCoverage, r.attribution, r.maxItems, r.maxAgeDays, r.status], ["normal", true, true, "link-host", 5, 3, "paused"]);
    assert.deepEqual(r.routeTo, ["open_local"]);
    assert.deepEqual(r.tags, ["lab"]);
    assert.deepEqual(resolveSource({ ...base, routeTo: [] }).routeTo, [], "an empty allowlist is kept (routes nowhere)");
  });

  it("the default max age covers the longest section hard window", () => {
    assert.equal(DEFAULT_MAX_AGE_DAYS, Math.max(...SECTIONS.map((s) => s.window.hardDays)));
  });

  it("activeSources / indexSources", () => {
    const paused: SourceDef = { ...base, id: "paused-one", url: "https://example.com/p.xml", status: "paused" };
    assert.deepEqual(activeSources([base, paused]).map((s) => s.id), ["openai-news"]);
    const idx = indexSources([base, paused]);
    assert.equal(idx.size, 2);
    assert.equal(idx.get("paused-one")?.status, "paused");
    assert.throws(() => indexSources([base, base]), /duplicate source id/);
  });
});
