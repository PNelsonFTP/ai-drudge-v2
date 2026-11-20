import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, type FeedHealthRow, type HealthFile, type SourceInfo, type SourcesFile } from "../../../shared/contract";
import { sectionOrder } from "../../../shared/sections";
import { NO_MUTES, type MuteSet } from "../../../shared/select";
import { fixtureHealth, fixtureHealthRow, fixtureSource, fixtureSources } from "../../../test/helpers/fixtureData";
import { NO_FILTER, SOURCE_STATUSES, STATUS_HELP, STATUS_LABEL, buildSourceRows, filterSources, sectionsWithSources, summarize, summaryLine, tierLabel } from "./model";

const META = { schemaVersion: SCHEMA_VERSION, buildId: "b1", generatedAt: "2026-11-19T20:00:00.000Z" } as const;

const info = (over: Partial<SourceInfo> & { id: string }): SourceInfo => ({
  name: over.id,
  publisher: "Example",
  publisherId: "example.com",
  kind: "rss",
  home: "industry",
  tier: 3,
  scope: "ai",
  feedUrl: `https://${over.id}.example.com/feed.xml`,
  homepage: `https://${over.id}.example.com/`,
  ...over,
});

const health = (id: string, status: FeedHealthRow["status"], over: Partial<FeedHealthRow> = {}): FeedHealthRow => ({
  id,
  ok: status === "ok",
  status,
  count: status === "ok" ? 5 : 0,
  failStreak: status === "ok" ? 0 : 3,
  lastOkAt: status === "ok" ? META.generatedAt : null,
  ...over,
});

function world(): { sources: SourcesFile; health: HealthFile } {
  const sources: SourcesFile = {
    ...META,
    sources: [
      info({ id: "krebs", name: "Krebs on Security", publisher: "KrebsOnSecurity", home: "cyber", scope: "general", tags: ["security", "fraud"] }),
      info({ id: "openai-news", name: "OpenAI News", publisher: "OpenAI", home: "models", tier: 1 }),
      info({ id: "anthropic-news", name: "Anthropic News", publisher: "Anthropic", home: "models", tier: 1, kind: "scrape", feedUrl: undefined, homepage: "https://www.anthropic.com/news" }),
      info({ id: "verge", name: "The Verge AI", publisher: "The Verge", aliases: ["Verge AI"] }),
      info({ id: "dead-blog", name: "Dead Blog", tier: 4 }),
      info({ id: "old-feed", name: "Old Feed", paused: true }),
      info({ id: "new-feed", name: "New Feed", homepage: "javascript:alert(1)", feedUrl: "ftp://example.com/feed" }),
      info({ id: "nist", name: "NIST AI", publisher: "NIST", home: "policy" }),
    ],
  };
  const h: HealthFile = {
    ...META,
    feeds: [
      health("openai-news", "ok", { count: 7 }),
      health("anthropic-news", "carried", { error: "timeout", lastError: "timeout after 8000 ms", failStreak: 2, lastOkAt: "2026-11-19T18:00:00.000Z", count: 4 }),
      health("verge", "ok"),
      health("krebs", "failing", { error: "http", lastError: "HTTP 403", httpStatus: 403, failStreak: 5 }),
      health("dead-blog", "quarantined", { error: "skipped", failStreak: 61 }),
      health("old-feed", "failing", { error: "http", lastError: "HTTP 404" }),
      health("nist", "failing", { error: "empty" }),
      health("not-in-registry", "ok"),
    ],
  };
  return { sources, health: h };
}

describe("sources/model - buildSourceRows", () => {
  it("joins every registry source with its health row, sections in homepage order, registry order inside", () => {
    const w = world();
    const rows = buildSourceRows(w.sources, w.health, NO_MUTES);
    assert.deepEqual(rows.map((r) => r.info.id), ["openai-news", "anthropic-news", "verge", "dead-blog", "old-feed", "new-feed", "nist", "krebs"]);
    assert.equal(rows.length, w.sources.sources.length, "health rows without a registry entry are ignored");
    const order = rows.map((r) => sectionOrder(r.info.home));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  it("carries status, fail streak, last OK, item count and the failure detail", () => {
    const w = world();
    const by = new Map(buildSourceRows(w.sources, w.health, NO_MUTES).map((r) => [r.info.id, r]));
    assert.deepEqual(
      [by.get("openai-news")!.status, by.get("openai-news")!.count, by.get("openai-news")!.failStreak, by.get("openai-news")!.detail],
      ["ok", 7, 0, ""],
    );
    const carried = by.get("anthropic-news")!;
    assert.deepEqual([carried.status, carried.failStreak, carried.lastOkAt, carried.detail], ["carried", 2, "2026-11-19T18:00:00.000Z", "timeout after 8000 ms"]);
    assert.deepEqual([by.get("krebs")!.status, by.get("krebs")!.detail, by.get("krebs")!.sectionLabel], ["failing", "HTTP 403", "CYBER WIRE"]);
    assert.equal(by.get("nist")!.detail, "empty", "falls back to the error class when there is no message");
    assert.equal(by.get("dead-blog")!.status, "quarantined");
    assert.equal(by.get("dead-blog")!.failStreak, 61);
  });

  it("paused sources and sources without a health row get their own statuses", () => {
    const w = world();
    const by = new Map(buildSourceRows(w.sources, w.health, NO_MUTES).map((r) => [r.info.id, r]));
    assert.equal(by.get("old-feed")!.status, "paused", "paused wins over a stale health row");
    assert.equal(by.get("old-feed")!.detail, "");
    assert.deepEqual([by.get("new-feed")!.status, by.get("new-feed")!.health, by.get("new-feed")!.lastOkAt], ["unknown", null, null]);
    assert.ok(buildSourceRows(w.sources, null, NO_MUTES).every((r) => r.status === "unknown" || r.status === "paused"));
  });

  it("only http(s) links survive; scrape sources have a homepage and no feed link", () => {
    const w = world();
    const by = new Map(buildSourceRows(w.sources, w.health, NO_MUTES).map((r) => [r.info.id, r]));
    assert.deepEqual([by.get("new-feed")!.homepage, by.get("new-feed")!.feedUrl], [null, null]);
    assert.deepEqual([by.get("anthropic-news")!.homepage, by.get("anthropic-news")!.feedUrl], ["https://www.anthropic.com/news", null]);
    assert.equal(by.get("verge")!.feedUrl, "https://verge.example.com/feed.xml");
  });

  it("marks muted sources", () => {
    const w = world();
    const mutes: MuteSet = { sources: new Set(["verge"]), sections: new Set() };
    const rows = buildSourceRows(w.sources, w.health, mutes);
    assert.deepEqual(rows.filter((r) => r.muted).map((r) => r.info.id), ["verge"]);
  });
});

describe("sources/model - filter and summary", () => {
  const rows = (() => {
    const w = world();
    return buildSourceRows(w.sources, w.health, { sources: new Set(["verge", "krebs"]), sections: new Set() });
  })();
  const ids = (f: Partial<typeof NO_FILTER>): string[] => filterSources(rows, { ...NO_FILTER, ...f }).map((r) => r.info.id);

  it("no filter returns everything", () => {
    assert.equal(filterSources(rows, NO_FILTER).length, rows.length);
  });

  it("filters by section", () => {
    assert.deepEqual(ids({ section: "models" }), ["openai-news", "anthropic-news"]);
    assert.deepEqual(ids({ section: "quantum" }), []);
  });

  it("filters by status, including the 'problems' and 'muted' shortcuts", () => {
    assert.deepEqual(ids({ status: "ok" }), ["openai-news", "verge"]);
    assert.deepEqual(ids({ status: "failing" }), ["nist", "krebs"]);
    assert.deepEqual(ids({ status: "quarantined" }), ["dead-blog"]);
    assert.deepEqual(ids({ status: "paused" }), ["old-feed"]);
    assert.deepEqual(ids({ status: "problems" }), ["anthropic-news", "dead-blog", "new-feed", "nist", "krebs"], "everything not OK, paused excluded");
    assert.deepEqual(ids({ status: "muted" }), ["verge", "krebs"]);
  });

  it("filters by text over name, publisher, id, kind, tags, aliases and hosts (multi-word AND, case-insensitive)", () => {
    assert.deepEqual(ids({ text: "KREBS" }), ["krebs"]);
    assert.deepEqual(ids({ text: "fraud" }), ["krebs"], "tag");
    assert.deepEqual(ids({ text: "verge ai" }), ["verge"]);
    assert.deepEqual(ids({ text: "scrape" }), ["anthropic-news"], "kind");
    assert.deepEqual(ids({ text: "anthropic.com" }), ["anthropic-news"], "homepage host");
    assert.deepEqual(ids({ text: "openai anthropic" }), [], "every word must match the same source");
    assert.deepEqual(ids({ text: "kre" }), ["krebs"], "a filter box matches word prefixes as you type");
    assert.deepEqual(ids({ text: "rebs" }), [], "never mid-word");
    assert.deepEqual(ids({ text: "   " }).length, rows.length);
  });

  it("filters combine", () => {
    assert.deepEqual(ids({ section: "industry", status: "problems", text: "feed" }), ["new-feed"]);
  });

  it("summary: N/M OK counts active sources only", () => {
    const s = summarize(rows);
    assert.deepEqual(s, { total: 8, active: 7, ok: 2, carried: 1, failing: 2, quarantined: 1, paused: 1, unknown: 1, muted: 2 });
    assert.equal(summaryLine(s), "2/7 OK · 1 carried forward · 2 failing · 1 quarantined · 1 without data · 1 paused");
    assert.equal(summaryLine(summarize(rows.filter((r) => r.status === "ok"))), "2/2 OK");
  });

  it("sectionsWithSources lists only sections that have sources, in homepage order, with counts", () => {
    assert.deepEqual(sectionsWithSources(rows), [
      { id: "models", label: "MODELS & LABS", count: 2 },
      { id: "industry", label: "INDUSTRY", count: 4 },
      { id: "policy", label: "POLICY & REGULATION", count: 1 },
      { id: "cyber", label: "CYBER WIRE", count: 1 },
    ]);
  });

  it("labels exist for every status; tier labels", () => {
    for (const s of SOURCE_STATUSES) {
      assert.ok(STATUS_LABEL[s]);
      assert.ok(STATUS_HELP[s].length > 10);
    }
    assert.deepEqual([1, 2, 3, 4].map(tierLabel), ["1 · top", "2", "3", "4 · low"]);
  });
});

describe("sources/model - committed fixture", () => {
  // The fixture is a frozen live build; its numbers are read from its files, never pinned.
  const count = (status: string): number => fixtureHealth.feeds.filter((f) => f.status === status).length;
  const paused = fixtureSources.sources.filter((x) => x.paused).length;

  it("every source is listed and the summary equals the health file", () => {
    const rows = buildSourceRows(fixtureSources, fixtureHealth, NO_MUTES);
    assert.equal(rows.length, fixtureSources.sources.length);
    const s = summarize(rows);
    assert.deepEqual(
      { total: s.total, active: s.active, ok: s.ok, carried: s.carried, failing: s.failing, quarantined: s.quarantined, paused: s.paused, unknown: s.unknown, muted: s.muted },
      { total: fixtureSources.sources.length, active: fixtureHealth.feeds.length, ok: count("ok"), carried: count("carried"), failing: count("failing"), quarantined: count("quarantined"), paused, unknown: 0, muted: 0 },
    );
    assert.equal(s.unknown, 0, "every active source has a health row");
    // The fixture has every state, so the line names each of them.
    assert.ok(s.carried > 0 && s.failing > 0 && s.quarantined > 0 && s.paused > 0);
    assert.equal(summaryLine(s), `${count("ok")}/${fixtureHealth.feeds.length} OK · ${count("carried")} carried forward · ${count("failing")} failing · ${count("quarantined")} quarantined · ${paused} paused`);
    assert.ok(rows.every((r) => r.feedUrl !== null || r.homepage !== null), "every source has a tracked link");
    assert.equal(filterSources(rows, { ...NO_FILTER, status: "problems" }).length, fixtureHealth.feeds.filter((f) => !f.ok).length);
    for (const status of ["carried", "failing", "quarantined", "paused"] as const) assert.equal(filterSources(rows, { ...NO_FILTER, status }).length, s[status], status);
  });

  it("rows of sources that are not ok carry the reason; a carried source keeps its items, a paused one has no health", () => {
    const rows = buildSourceRows(fixtureSources, fixtureHealth, NO_MUTES);
    const row = (id: string) => {
      const r = rows.find((x) => x.info.id === id);
      assert.ok(r, id);
      return r;
    };
    const carried = row(fixtureSource("carried"));
    assert.equal(carried.status, "carried");
    assert.equal(carried.detail, fixtureHealthRow(carried.info.id).lastError);
    assert.ok(carried.count > 0 && carried.failStreak >= 1 && carried.lastOkAt !== null);

    const backoff = row(fixtureSource("hostBackoff"));
    assert.equal(backoff.status, "carried");
    assert.match(backoff.detail, /^host backoff: /);
    assert.ok(backoff.count > 0);

    const failing = row(fixtureSource("failing"));
    assert.deepEqual([failing.status, failing.count], ["failing", 0]);
    assert.ok(failing.detail.length > 0);

    const quarantined = row(fixtureSource("quarantined"));
    assert.deepEqual([quarantined.status, quarantined.count], ["quarantined", 0]);
    assert.equal(quarantined.failStreak, fixtureHealthRow(quarantined.info.id).failStreak);

    const off = row(fixtureSource("paused"));
    assert.deepEqual([off.status, off.health, off.detail, off.count], ["paused", null, "", 0]);

    const ok = row(fixtureSource("ok"));
    assert.deepEqual([ok.status, ok.detail, ok.failStreak], ["ok", "", 0]);
  });
});
