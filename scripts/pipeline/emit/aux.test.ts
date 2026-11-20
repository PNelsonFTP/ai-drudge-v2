// health.json, sources.json and status.json.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateHealthFile, validateSourcesFile, validateStatusFile } from "../../../shared/guards";
import { hoursAgo } from "../../../test/helpers/factories";
import { assertValidBundle } from "../../../test/helpers/invariants";
import { createTestContext, emptyState } from "../context";
import { emit } from "./edition";
import { buildHealth } from "./health";
import { buildSourcesFile } from "./sourcesFile";
import { runInfoFromEnv } from "./status";
import { healthFor, sample, sampleInput, sampleRegistry } from "./testkit.test";

describe("emit: health.json", () => {
  it("has one row per active source in registry order with the four statuses", () => {
    const registry = sampleRegistry();
    const health = healthFor(registry, {
      krebs: 3,
      "hn-front": { status: "carried", count: 4, failStreak: 2, error: "timeout", detail: "timeout after 8000 ms", httpStatus: undefined, lastOkAt: hoursAgo(2) },
      "arxiv-cs-ai": { status: "quarantined", error: "skipped", detail: undefined, httpStatus: undefined, failStreak: 60 },
    });
    const file = buildHealth(health, registry, createTestContext());
    assert.equal(validateHealthFile(file), null);
    assert.deepEqual(file.feeds.map((f) => f.id), registry.sources.filter((s) => s.status !== "paused").map((s) => s.id));
    const row = (id: string) => file.feeds.find((f) => f.id === id);
    assert.deepEqual(row("openai-news"), { id: "openai-news", ok: true, status: "ok", count: 10, failStreak: 0, lastOkAt: "2026-11-19T21:00:00.000Z" });
    assert.deepEqual(row("krebs"), { id: "krebs", ok: false, status: "failing", count: 0, failStreak: 3, lastOkAt: null, error: "http", lastError: "HTTP 403", httpStatus: 403 });
    assert.deepEqual(row("hn-front"), { id: "hn-front", ok: false, status: "carried", count: 4, failStreak: 2, lastOkAt: hoursAgo(2), error: "timeout", lastError: "timeout after 8000 ms", carried: true });
    assert.equal(row("arxiv-cs-ai")?.status, "quarantined");
    assert.equal(row("arxiv-cs-ai")?.count, 0);
    assert.equal(row("paused-blog"), undefined);
  });

  it("never emits an inconsistent row: ok implies streak 0, not-ok implies streak >= 1", () => {
    const registry = sampleRegistry();
    const health = healthFor(registry, { krebs: { failStreak: 0 }, "openai-news": { ok: false, status: "ok" } });
    const ok = health.find((h) => h.sourceId === "reuters-ai");
    if (ok) ok.failStreak = 7;
    const file = buildHealth(health, registry, createTestContext());
    assert.equal(file.feeds.find((f) => f.id === "krebs")?.failStreak, 1);
    assert.equal(file.feeds.find((f) => f.id === "reuters-ai")?.failStreak, 0);
    const odd = file.feeds.find((f) => f.id === "openai-news");
    assert.equal(odd?.status, "failing");
    assert.equal(odd?.ok, false);
  });

  it("lists an active source ingest did not report on as failing, continuing its streak, and keeps the last error", () => {
    const registry = sampleRegistry();
    const state = { ...emptyState(), health: { krebs: { failStreak: 4, lastOkAt: hoursAgo(50), lastAttemptAt: hoursAgo(1), lastError: "HTTP 500" } } };
    const partial = healthFor(registry).filter((h) => h.sourceId !== "krebs");
    partial.push({ sourceId: "not-in-registry", ok: true, status: "ok", count: 1, ms: 1, failStreak: 0, lastOkAt: null });
    const file = buildHealth(partial, registry, createTestContext({ state }));
    assert.deepEqual(file.feeds.find((f) => f.id === "krebs"), {
      id: "krebs",
      ok: false,
      status: "failing",
      count: 0,
      error: "skipped",
      lastError: "no ingest result for this source",
      failStreak: 5,
      lastOkAt: hoursAgo(50),
    });
    assert.ok(!file.feeds.some((f) => f.id === "not-in-registry"));

    const noDetail = healthFor(registry, { krebs: { detail: undefined, failStreak: 5 } });
    assert.equal(buildHealth(noDetail, registry, createTestContext({ state })).feeds.find((f) => f.id === "krebs")?.lastError, "HTTP 500");
  });
});

describe("emit: sources.json", () => {
  it("exports every registry source, paused included, with publisher names and links", () => {
    const registry = sampleRegistry();
    const file = buildSourcesFile(registry, createTestContext());
    assert.equal(validateSourcesFile(file), null);
    assert.equal(file.sources.length, registry.sources.length);
    const by = (id: string) => file.sources.find((s) => s.id === id);
    assert.deepEqual(by("openai-news"), {
      id: "openai-news",
      name: "OpenAI News",
      publisher: "OpenAI",
      publisherId: "openai",
      kind: "rss",
      home: "models",
      tier: 1,
      scope: "ai",
      homepage: "https://openai.com/news/",
      feedUrl: "https://openai-news.example.com/feed.xml",
      tags: ["lab", "first-party"],
    });
    assert.equal(by("anthropic-news")?.feedUrl, undefined, "a scraper has no feed URL");
    assert.equal(by("anthropic-news")?.homepage, "https://www.anthropic.com/news");
    assert.deepEqual(by("techcrunch-ai")?.aliases, ["TechCrunch"]);
    assert.equal(by("paused-blog")?.paused, true);
    assert.equal(by("krebs")?.scope, "general");
    assert.equal(by("krebs")?.paused, undefined);
  });
});

describe("emit: status.json", () => {
  it("summarises the run, feeds and content consistently with the other files", () => {
    const ctx = createTestContext({ env: { GITHUB_RUN_ID: "44605508673", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: "8D5CBC26aa11bb22cc33dd44ee55ff6677889900" } });
    const s = sample();
    const health = healthFor(s.registry, { krebs: 3, "hn-front": { status: "carried", count: 4 }, "arxiv-cs-ai": { status: "quarantined", failStreak: 60 } });
    const bundle = emit({ ...sampleInput(ctx, s), health }, ctx);
    assertValidBundle(bundle);
    const { status } = bundle;
    assert.equal(validateStatusFile(status), null);
    assert.deepEqual(status.run, { id: 44605508673, attempt: 2, trigger: "workflow_dispatch", codeSha: "8d5cbc2", durationS: null });
    assert.deepEqual(status.feeds, { total: 11, ok: 8, failed: 1, carriedForward: 1, quarantined: 1, failedNames: ["Hacker News", "arXiv cs.AI", "Krebs on Security"] });
    assert.equal(status.content.stories, 8);
    assert.equal(status.content.top, 2);
    assert.deepEqual(status.content.emptySections, bundle.front.sections.filter((x) => x.rows.length === 0).map((x) => x.id));
    assert.equal(status.content.newestItemAt, hoursAgo(2), "the release, 2 h old, is the newest placed story");
    assert.equal(status.content.medianAgeH, 9);
    assert.deepEqual(status.brief, { source: "fallback" });
    assert.deepEqual(status.stocks, { ok: 1, total: 2 });
    assert.equal(status.cadenceMinutes, 30);
    assert.equal(status.staleAfterMinutes, 120, "reader-facing: the client's stale banner follows it (four missed 30-minute builds)");
    assert.equal(status.gate.passed, false, "a 9-story sample is hollow by production thresholds");
    assert.ok(status.gate.failures?.some((f) => f.startsWith("hollow")));
  });

  it("uses the run info it is given, and a local default otherwise", () => {
    const ctx = createTestContext();
    const local = emit(sampleInput(ctx), ctx).status.run;
    assert.deepEqual(local, { id: null, attempt: null, trigger: "local", codeSha: null, durationS: null });
    const given = { id: 7, attempt: 1, trigger: "schedule", codeSha: "abc1234", durationS: 49 };
    assert.deepEqual(emit({ ...sampleInput(ctx), run: given }, ctx).status.run, given);
    assert.deepEqual(runInfoFromEnv({ GITHUB_RUN_ID: "not-a-number", GITHUB_SHA: "zzz" }, 12), { id: null, attempt: null, trigger: "local", codeSha: null, durationS: 12 });
  });
});
