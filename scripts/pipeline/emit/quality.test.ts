import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeedHealthRow, HealthFile } from "../../../shared/contract";
import { SECTIONS } from "../../../shared/sections";
import { hoursAgo, makeRegistry, makeScoredStory, makeSource } from "../../../test/helpers/factories";
import { FIXTURE_GENERATED_MS, fixtureBundle } from "../../../test/helpers/fixtureData";
import { REGISTRY } from "../../registry/index";
import { createTestContext } from "../context";
import { emit } from "./edition";
import { BRIEF_QUIET_REASONS, GATE, briefFallbackReason, checkFreshness, evaluateQuality, feedTiers, briefAlert, briefFailStreakOf, nextBriefFailStreak, statusBriefFailStreak } from "./quality";
import { itemOf, makePlacements, sample, sampleInput } from "./testkit.test";

const now = FIXTURE_GENERATED_MS;
const clone = <T>(x: T): T => structuredClone(x);

// The fixture is a frozen live build that `npm run fixture:refresh` replaces: every number below is
// DERIVED from its own health file and the gate thresholds, never pinned.
const PROBATION = new Set(fixtureBundle.sources.sources.filter((s) => s.tags?.includes("probation")).map((s) => s.id));
/** The fixture's own feed tiers (a few probation sources are not ok: test/fixtures/v2.manifest.json healthCases). */
const BASE = feedTiers(fixtureBundle.health, GATE.chronicFailStreak, PROBATION);
const TOTAL = BASE.total;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
/** Fewest extra one-run failures that push the ok share of the live feeds under the fail line. */
const MASS = Math.floor(BASE.ok - GATE.feedsFailBelow * BASE.live) + 1;
/** Fewest extra one-run failures that push it under the warning line (still above the fail line). */
const WARN = Math.floor(BASE.ok - GATE.feedsWarnBelow * BASE.live) + 1;

/**
 * The fixture with `n` more feeds marked failing at the given streak: the first n ok feeds that are
 * not on probation (a probation source is chronic from its first failure, which is its own test).
 */
function withFailing(n: number, streak: number, status: FeedHealthRow["status"] = "failing"): typeof fixtureBundle {
  const b = clone(fixtureBundle);
  let left = n;
  for (const f of b.health.feeds) {
    if (left === 0) break;
    if (!f.ok || PROBATION.has(f.id)) continue;
    f.ok = false;
    f.status = status;
    f.failStreak = streak;
    f.count = 0;
    left--;
  }
  assert.equal(left, 0, `the fixture has fewer than ${n} healthy feeds to fail`);
  return b;
}

describe("quality rules", () => {
  it("pass the fixture (a frozen live build) and report its own numbers", () => {
    const r = evaluateQuality(fixtureBundle, { now });
    assert.deepEqual(r.failures, []);
    assert.equal(r.stats.stories, fixtureBundle.front.counts.stories);
    assert.equal(r.stats.top, fixtureBundle.front.top.length);
    assert.equal(r.stats.sectionsWithRows, fixtureBundle.front.sections.filter((x) => x.rows.length > 0).length);
    assert.equal(r.stats.feeds?.total, fixtureBundle.health.feeds.length);
    assert.equal(r.stats.feeds?.ok, fixtureBundle.health.feeds.filter((f) => f.ok).length);
    assert.ok((r.stats.maxAgeDays ?? 99) < GATE.maxItemAgeDays);
    // A real build: far above the hollow line, every section filled, TOP STORIES present.
    assert.ok(r.stats.stories >= GATE.warnStories && r.stats.top >= GATE.warnTopStories && r.stats.sectionsWithRows === SECTIONS.length);
    // The emit-time verdict recorded in the fixture's status.json is this verdict.
    assert.equal(fixtureBundle.status.gate.passed, true);
    assert.deepEqual(fixtureBundle.status.gate.warnings, [...r.alerts, ...r.warnings]);
  });

  it("fail a blank edition", () => {
    const b = clone(fixtureBundle);
    for (const s of b.front.sections) s.rows = [];
    const r = evaluateQuality(b, { now });
    assert.ok(r.failures.some((f) => f.startsWith("blank:")), r.failures.join("\n"));
  });

  it("fail a hollow edition: too few stories or too few sections with rows", () => {
    const few = clone(fixtureBundle);
    few.front.counts.stories = 12;
    assert.ok(evaluateQuality(few, { now }).failures.some((f) => /hollow: 12 stories < 60/.test(f)));

    const sections = clone(fixtureBundle);
    sections.front.sections.forEach((s, i) => {
      if (i >= 8) s.rows = [];
    });
    const r = evaluateQuality(sections, { now });
    assert.ok(r.failures.some((f) => /only 8 of 15 sections have rows/.test(f)), r.failures.join("\n"));

    // A section that holds nothing is a quiet desk (warning), not a hollow homepage.
    const one = clone(fixtureBundle);
    one.front.sections[14].rows = [];
    one.front.sections[14].total = 0;
    const ok = evaluateQuality(one, { now });
    assert.deepEqual(ok.failures, []);
    assert.ok(ok.warnings.some((w) => w === "empty sections: releases"));
  });

  it("fail when TOP STORIES is empty although multi-publisher stories exist, warn when there are none", () => {
    const b = clone(fixtureBundle);
    b.front.top = [];
    b.front.leadId = null;
    assert.ok(evaluateQuality(b, { now }).failures.some((f) => /TOP STORIES is empty although/.test(f)));

    const quiet = clone(fixtureBundle);
    quiet.front.top = [];
    for (const c of [...Object.values(quiet.front.clusters), ...Object.values(quiet.rest.clusters)]) c.publishers = 1;
    const r = evaluateQuality(quiet, { now });
    assert.ok(!r.failures.some((f) => /TOP STORIES/.test(f)));
    assert.ok(r.warnings.some((w) => /TOP STORIES is empty/.test(w)));
  });

  it("fail a hollow homepage: a section showing fewer rows than it holds", () => {
    // Internally consistent (rows stay a prefix of the full list), one homepage row per section.
    const b = clone(fixtureBundle);
    for (const s of b.front.sections) s.rows = s.rows.slice(0, 1);
    const r = evaluateQuality(b, { now });
    assert.ok(r.failures.some((f) => /^hollow homepage: \d+ section\(s\) show fewer rows than they hold \(models 1 of \d+/.test(f)), r.failures.join("\n"));
    assert.equal(r.failures.filter((f) => f.startsWith("hollow homepage")).length, 1, "one line, however many sections");

    // A thin but honest edition is not hollow: every section shows min(homeRows, total).
    const thin = clone(fixtureBundle);
    for (const s of thin.front.sections) {
      s.rows = s.rows.slice(0, 2);
      s.total = s.rows.length;
    }
    assert.ok(!evaluateQuality(thin, { now }).failures.some((f) => f.startsWith("hollow homepage")));
  });

  it("fail stale content and oversized fields", () => {
    const b = clone(fixtureBundle);
    const id = b.front.sections[0].rows[0];
    b.front.articles[id].publishedAt = new Date(now - 90 * 86_400_000).toISOString();
    b.front.articles[id].title = "x".repeat(301);
    b.front.articles[id].summary = "y".repeat(401);
    const r = evaluateQuality(b, { now });
    assert.ok(r.failures.some((f) => /oldest row is 90\.0 d old \(> 60 d\)/.test(f)), r.failures.join("\n"));
    assert.ok(r.failures.some((f) => /1 titles longer than 300/.test(f)));
    assert.ok(r.failures.some((f) => /1 summaries longer than 400/.test(f)));
  });

  it("the stale-row ceiling covers every window route is designed to fill from", () => {
    // A source's explicit maxAgeDays extends its section's hard window for the starvation fill
    // (route/section.ts), so the gate must sit above the largest one - or a single deliberately
    // placed old row holds every deploy until it ages out.
    const sourceMax = Math.max(...REGISTRY.sources.map((s) => s.maxAgeDays ?? 0));
    const sectionMax = Math.max(...SECTIONS.map((s) => s.window.hardDays));
    assert.ok(sourceMax > 0, "the registry sets maxAgeDays on some sources");
    assert.ok(GATE.maxItemAgeDays > sourceMax, `GATE.maxItemAgeDays ${GATE.maxItemAgeDays} must exceed the registry's largest maxAgeDays ${sourceMax}`);
    assert.ok(GATE.maxItemAgeDays > sectionMax, `GATE.maxItemAgeDays ${GATE.maxItemAgeDays} must exceed the longest section hard window ${sectionMax}`);

    // A row at the longest allowed age (plus the day an undated baseline item is back-dated by) passes.
    const b = clone(fixtureBundle);
    const id = b.front.sections[0].rows[0];
    b.front.articles[id].publishedAt = new Date(now - (sourceMax + 1) * 86_400_000).toISOString();
    const r = evaluateQuality(b, { now });
    assert.deepEqual(r.failures, []);
    assert.equal(r.stats.maxAgeDays, sourceMax + 1);
  });

  it("a starved section holding a 40-day story from a 45-day source is published, not held", () => {
    const quantumSource = makeSource({ id: "cloudflare-post-quantum", name: "Cloudflare: Post-Quantum", publisher: "cloudflare", home: "quantum", tier: 2, scope: "general", maxAgeDays: 45 });
    const s = sample();
    const registry = makeRegistry([...s.registry.sources, quantumSource], [...s.registry.publishers, { id: "cloudflare", name: "Cloudflare", hosts: ["blog.cloudflare.com"] }]);
    const old = makeScoredStory([itemOf(registry, "cloudflare-post-quantum", { url: "https://blog.cloudflare.com/pq-2026", title: "The post-quantum future of web privacy", publishedAt: hoursAgo(40 * 24) })], { score: 20 });
    const stories = [...Object.values(s.placements.stories), old];
    const rows = Object.fromEntries(s.placements.sections.map((sec) => [sec.id, sec.rows]));
    const ctx = createTestContext();
    const bundle = emit({ ...sampleInput(ctx, s), registry, placements: makePlacements({ stories, rows: { ...rows, quantum: [old.lead] }, top: s.placements.top }) }, ctx);
    assert.deepEqual(bundle.front.sections.find((x) => x.id === "quantum")?.rows, [old.lead]);
    const r = evaluateQuality(bundle, { now: ctx.now });
    assert.equal(r.stats.maxAgeDays, 40);
    assert.ok(!r.failures.some((f) => /stale content/.test(f)), r.failures.join("\n"));
    assert.ok(!bundle.status.gate.failures?.some((f) => /stale content/.test(f)), "the emit-time verdict agrees");
  });

  it("content freeze: fresh files with old news warn after 12 h and fail after 24 h", () => {
    const newest = Math.max(...Object.values({ ...fixtureBundle.rest.articles, ...fixtureBundle.front.articles }).map((a) => Date.parse(a.publishedAt ?? a.firstSeenAt)));
    const at = (hours: number) => evaluateQuality(fixtureBundle, { now: newest + hours * 3_600_000 });
    const fresh = at(6);
    assert.ok(!fresh.failures.some((f) => /frozen/.test(f)) && !fresh.warnings.some((w) => /newest placed story/.test(w)), "a 6 h gap is a normal weekend");
    const slow = at(13);
    assert.ok(!slow.failures.some((f) => /frozen/.test(f)));
    assert.ok(slow.warnings.some((w) => w === "newest placed story is 13 h older than the build (> 12 h)"), slow.warnings.join("\n"));
    const frozen = at(25);
    assert.ok(frozen.failures.some((f) => f === "frozen content: newest placed story is 25 h older than the build (> 24 h)"), frozen.failures.join("\n"));
    // A re-stamped edition three days on (every feed still "ok") is the case the gate used to pass.
    assert.ok(at(72).failures.some((f) => /^frozen content/.test(f)));
  });

  it("warn when the Claude brief was unavailable, but not for a missing key or a thin day", () => {
    const withReason = (fallbackReason?: unknown) => evaluateQuality({ ...clone(fixtureBundle), brief: { ...fixtureBundle.brief, source: "fallback" as const, ...(fallbackReason === undefined ? {} : { fallbackReason: fallbackReason as string }) } }, { now });
    for (const code of ["http-4xx", "http-5xx", "timeout", "network", "refusal", "truncated", "invalid-reply", "error"]) {
      const r = withReason(code);
      assert.deepEqual(r.failures, [], "an unavailable brief never holds the build");
      assert.ok(r.warnings.includes(`brief: Claude brief unavailable (${code}) - fallback published`), code);
    }
    for (const quiet of [undefined, ...BRIEF_QUIET_REASONS]) assert.ok(!withReason(quiet).warnings.some((w) => /brief:/.test(w)), String(quiet));
    // Only a short code is ever echoed: brief.json is read back from disk and status.json is public.
    for (const hostile of ["HTTP 401: invalid x-api-key sk-ant-123", "<b>x</b>", 42, "", "a".repeat(40)]) {
      assert.equal(briefFallbackReason({ fallbackReason: hostile }), null);
      assert.ok(!withReason(hostile).warnings.some((w) => /brief:/.test(w)));
    }
    assert.equal(briefFallbackReason(null), null);
    // A Claude brief never carries a warning, whatever the field says.
    const claude = evaluateQuality({ ...clone(fixtureBundle), brief: { ...fixtureBundle.brief, source: "claude" as const, bullets: ["a", "b", "c"], fallbackReason: "http-4xx" } as typeof fixtureBundle.brief }, { now });
    assert.ok(!claude.warnings.some((w) => /unavailable/.test(w)));
  });

  it("brief failure streak: counts failed calls with a key, resets on success or a removed key, ignores a thin day", () => {
    const fallback = (fallbackReason?: string) => ({ source: "fallback", ...(fallbackReason ? { fallbackReason } : {}) });
    assert.equal(nextBriefFailStreak(0, fallback("http-4xx")), 1);
    assert.equal(nextBriefFailStreak(5, fallback("timeout")), 6);
    assert.equal(nextBriefFailStreak(5, { source: "claude" }), 0, "Claude wrote the brief");
    assert.equal(nextBriefFailStreak(5, fallback("no-key")), 0, "no key configured: the owner's choice, the count starts over");
    assert.equal(nextBriefFailStreak(5, fallback("thin")), 5, "no call was made");
    assert.equal(nextBriefFailStreak(5, fallback()), 5, "a fallback without a reason says nothing about the key");
    assert.equal(nextBriefFailStreak(5, fallback("HTTP 401: invalid x-api-key")), 5, "a reason that is not a coarse code is no reason");
    assert.equal(nextBriefFailStreak(Number.NaN, fallback("error")), 1);
    assert.equal(nextBriefFailStreak(-3, fallback("error")), 1);
    assert.equal(nextBriefFailStreak(2.9, fallback("error")), 3);
    assert.equal(nextBriefFailStreak(7, null), 0);
    // Tolerant readers: the state field and the status field are optional additions.
    assert.equal(briefFailStreakOf({ briefFailStreak: 4 }), 4);
    for (const x of [null, undefined, {}, { briefFailStreak: "4" }, { briefFailStreak: -1 }, { briefFailStreak: Number.POSITIVE_INFINITY }, 7]) assert.equal(briefFailStreakOf(x), 0);
    assert.equal(statusBriefFailStreak({ brief: { source: "fallback", failStreak: 6 } }), 6);
    for (const x of [null, {}, { brief: null }, { brief: { failStreak: "6" } }]) assert.equal(statusBriefFailStreak(x), 0);
  });

  it(`brief alert: ${GATE.briefAlertStreak} failed builds in a row with a key raise an alert that does not hold the build; without a key it is silent`, () => {
    const brief = (fallbackReason?: string) => ({ ...fixtureBundle.brief, source: "fallback" as const, ...(fallbackReason ? { fallbackReason } : {}) });
    const run = (streak: number | undefined, fallbackReason?: string) => evaluateQuality({ ...clone(fixtureBundle), brief: brief(fallbackReason) }, { now, ...(streak === undefined ? {} : { briefFailStreak: streak }) });
    assert.equal(GATE.briefAlertStreak, 6);

    const five = run(5, "http-4xx");
    assert.deepEqual(five.alerts, []);
    assert.ok(five.warnings.includes("brief: Claude brief unavailable (http-4xx) - fallback published"));

    const six = run(6, "http-4xx");
    assert.deepEqual(six.alerts, ["brief: the Claude brief has failed 6 builds in a row (http-4xx) although an API key is configured - the Daily Brief is not shown; check the key, the model id and the API status"]);
    assert.deepEqual(six.failures, five.failures, "an alert is not a failure: the edition is still published");
    assert.deepEqual(six.warnings, five.warnings);
    assert.match(run(40, "timeout").alerts[0], /failed 40 builds in a row \(timeout\)/);

    // Silent: no key (whatever the count says), a thin day, a fallback without a reason, a Claude brief.
    for (const quiet of ["no-key", "thin", undefined]) assert.deepEqual(run(99, quiet).alerts, [], String(quiet));
    const claude = evaluateQuality({ ...clone(fixtureBundle), brief: { ...fixtureBundle.brief, source: "claude" as const, bullets: ["a", "b", "c"] } }, { now, briefFailStreak: 99 });
    assert.deepEqual(claude.alerts, []);
    assert.equal(briefAlert(6, { source: "fallback", fallbackReason: "http-5xx" }, 7), null, "the limit is a threshold like the others");
    assert.match(run(3, "error").alerts.join("") + evaluateQuality({ ...clone(fixtureBundle), brief: brief("error") }, { now, briefFailStreak: 3, thresholds: { briefAlertStreak: 3 } }).alerts.join(""), /^brief: the Claude brief has failed 3 builds/);

    // The gate reads the files back from disk: without the option the count recorded in status.json is used.
    const fromStatus = (failStreak: unknown) => evaluateQuality({ ...clone(fixtureBundle), brief: brief("http-4xx"), status: { ...fixtureBundle.status, brief: { source: "fallback", reason: "http-4xx", failStreak } } as typeof fixtureBundle.status }, { now });
    assert.equal(fromStatus(6).alerts.length, 1);
    assert.equal(fromStatus(5).alerts.length, 0);
    assert.equal(fromStatus(undefined).alerts.length, 0, "a status.json without the field: never an alert");
    assert.equal(fromStatus("6").alerts.length, 0);
    assert.deepEqual(evaluateQuality(fixtureBundle, { now }).alerts, []);
  });

  it("flag a too-short claude brief and a release-tag headline", () => {
    const b = clone(fixtureBundle);
    b.brief = { ...b.brief, source: "claude", bullets: ["one", "two"], headline: "llama.cpp b12549 released" };
    const r = evaluateQuality(b, { now });
    assert.ok(r.failures.some((f) => /claude brief has 2 bullets/.test(f)));
    assert.ok(r.warnings.some((w) => /release tag/.test(w)));
  });

  it("warn about a thin ticker", () => {
    const b = clone(fixtureBundle);
    for (const q of Object.values(b.stocks.quotes)) q.price = null;
    assert.ok(evaluateQuality(b, { now }).warnings.some((w) => w.startsWith(`stocks: 0 of ${b.stocks.order.length} symbols priced`)));
  });
});

describe("tiered feed health", () => {
  it("classifies feeds by status and failStreak", () => {
    const feeds: FeedHealthRow[] = [
      { id: "a", ok: true, status: "ok", count: 5, failStreak: 0, lastOkAt: null },
      { id: "b", ok: false, status: "failing", count: 0, failStreak: 2, lastOkAt: null },
      { id: "c", ok: false, status: "carried", count: 3, failStreak: 1, lastOkAt: null, carried: true },
      { id: "d", ok: false, status: "failing", count: 0, failStreak: 12, lastOkAt: null },
      { id: "e", ok: false, status: "quarantined", count: 0, failStreak: 50, lastOkAt: null },
      { id: "f", ok: false, status: "failing", count: 0, failStreak: 3, lastOkAt: null, error: "empty" },
    ];
    const t = feedTiers({ feeds } as HealthFile, 12);
    assert.deepEqual({ ...t, okShare: Math.round(t.okShare * 100) }, { total: 6, ok: 1, carried: 1, failing: 1, quarantined: 1, chronic: 2, empty: 1, live: 3, okShare: 33, chronicIds: ["d", "e"] });
  });

  /** `withFailing(n, 1)` with the first `empties` of the newly failing feeds answering "empty". */
  function withEmpty(n: number, empties: number): typeof fixtureBundle {
    const b = withFailing(n, 1);
    let left = empties;
    for (const f of b.health.feeds) {
      if (left === 0) break;
      if (f.ok || f.failStreak !== 1 || f.lastError !== undefined) continue;
      f.error = "empty";
      left--;
    }
    return b;
  }

  it("does not read a few empty-but-valid feeds as an outage", () => {
    // MASS extra failures trip the mass-failure rule (see below) - unless some of them answered and simply had nothing.
    assert.ok(evaluateQuality(withFailing(MASS, 1), { now }).failures.some((f) => /mass failure/.test(f)));
    const empties = Math.ceil(TOTAL * GATE.emptyWarnShare) - 1; // the most that stays under the warning line
    assert.ok(empties >= 1 && empties < MASS);
    const r = evaluateQuality(withEmpty(MASS, empties), { now });
    assert.ok(!r.failures.some((f) => /mass failure|no usable items/.test(f)), r.failures.join("\n"));
    assert.equal(r.stats.feeds?.empty, BASE.empty + empties);
    assert.equal(r.stats.feeds?.live, BASE.live - empties);
    assert.ok(!r.warnings.some((w) => /no usable items/.test(w)), `${empties} of ${TOTAL} is under the ${pct(GATE.emptyWarnShare)} warning line`);
  });

  it("caps the empty exemption: a parser regression reads as 'empty' too", () => {
    // Between 10% and 25% of the registry: published, with a warning.
    const n = Math.ceil(TOTAL * (GATE.emptyWarnShare + GATE.emptyFailShare) / 2);
    const some = evaluateQuality(withEmpty(n, n), { now });
    assert.ok(!some.failures.some((f) => /no usable items/.test(f)), some.failures.join("\n"));
    const line = `feeds: ${BASE.empty + n} of ${TOTAL} feeds answered with no usable items this run (${pct((BASE.empty + n) / TOTAL)})`;
    assert.ok(some.warnings.some((w) => w.startsWith(line)), some.warnings.join("\n"));

    // 300 of 410 feeds empty on the FIRST run (failStreak 1, so not chronic yet): used to pass silently.
    const b = clone(fixtureBundle);
    const template = b.health.feeds.find((f) => f.ok);
    assert.ok(template);
    b.health.feeds = Array.from({ length: 410 }, (_, i) => (i < 300 ? { ...template, id: `empty-${i}`, ok: false, status: "failing" as const, count: 0, failStreak: 1, error: "empty" as const, lastError: "20 items, none usable (no title or no http link)" } : { ...template, id: `ok-${i}` }));
    const regression = evaluateQuality(b, { now });
    assert.equal(regression.stats.feeds?.okShare, 1, "the live denominator alone sees nothing wrong");
    assert.ok(regression.failures.some((f) => /^feeds: 300 of 410 feeds answered with no usable items this run \(73%\) - parser regression\?/.test(f)), regression.failures.join("\n"));

    const relaxed = evaluateQuality(b, { now, thresholds: { emptyFailShare: 0.9, emptyWarnShare: 0.9 } });
    assert.ok(!relaxed.failures.some((f) => /no usable items/.test(f)) && !relaxed.warnings.some((w) => /no usable items/.test(w)));
  });

  it("does not let permanently blocked feeds eat the margin", () => {
    // As a ONE-RUN blip, MASS more failures (under 60% of the live feeds ok) is a mass failure ...
    const blip = evaluateQuality(withFailing(MASS, 1), { now });
    assert.ok(blip.failures.some((f) => /mass failure/.test(f)), blip.failures.join("\n"));
    assert.ok(!evaluateQuality(withFailing(MASS - 1, 1), { now }).failures.some((f) => /mass failure/.test(f)), "MASS is the smallest such number");
    // ... but a fifth of the registry failing for 20 runs is chronic: a registry chore, not an outage.
    const n = Math.floor(TOTAL * 0.2);
    const chronic = evaluateQuality(withFailing(n, 20), { now });
    assert.deepEqual(chronic.failures, []);
    assert.equal(chronic.stats.feeds?.chronic, BASE.chronic + n);
    assert.equal(chronic.stats.feeds?.live, BASE.live - n);
    assert.ok(chronic.warnings.some((w) => w.startsWith(`feeds: ${BASE.chronic + n} chronic`)), chronic.warnings.join("\n"));
  });

  it("fails a mass failure this run even when the feeds were carried forward", () => {
    const r = evaluateQuality(withFailing(MASS, 1, "carried"), { now });
    assert.ok(r.failures.some((f) => /mass failure/.test(f)), r.failures.join("\n"));
    assert.equal(r.stats.feeds?.carried, BASE.carried + MASS);
  });

  it("fails a total outage, an empty health file and a slow collapse into chronic", () => {
    const down = clone(fixtureBundle);
    for (const f of down.health.feeds) if (f.ok) Object.assign(f, { ok: false, status: "failing", failStreak: 1, count: 0 });
    const outage = evaluateQuality(down, { now });
    assert.ok(outage.failures.some((f) => f.includes(`0 of ${TOTAL} feeds fetched`)), outage.failures.join("\n"));

    const none = clone(fixtureBundle);
    none.health.feeds = [];
    assert.ok(evaluateQuality(none, { now }).failures.some((f) => /lists no feeds/.test(f)));

    const n = Math.ceil(TOTAL * GATE.chronicFailShare) - BASE.chronic;
    const collapse = evaluateQuality(withFailing(n, 30), { now });
    assert.ok(collapse.failures.some((f) => f.includes(`${BASE.chronic + n} of ${TOTAL} feeds are chronic`)), collapse.failures.join("\n"));
    assert.ok(!evaluateQuality(withFailing(n - 1, 30), { now }).failures.some((f) => /feeds are chronic/.test(f)), "one fewer is still a warning");
  });

  it("warns between the thresholds and names tier-1 sources on a streak", () => {
    const b = withFailing(WARN, 1);
    const tier1 = b.sources.sources.find((s) => s.tier === 1 && b.health.feeds.some((f) => f.id === s.id && f.ok));
    assert.ok(tier1);
    const row = b.health.feeds.find((f) => f.id === tier1.id);
    assert.ok(row);
    Object.assign(row, { ok: false, status: "failing", failStreak: 7, lastError: "HTTP 403", count: 0 });
    const r = evaluateQuality(b, { now });
    assert.deepEqual(r.failures, []);
    assert.ok(r.warnings.some((w) => w.startsWith(`feeds: ${BASE.ok - WARN - 1} of ${BASE.live} live feeds ok (`) && w.endsWith(`below ${pct(GATE.feedsWarnBelow)}`)), r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => w.includes(`tier-1 source "${tier1.name}" has failed 7 runs in a row (HTTP 403)`)));
  });

  it("treats a failing probation source as expected from its first failure", () => {
    // Enough one-run failures for a mass failure AND for 40% of the registry to be down.
    const n = Math.max(MASS, Math.ceil(TOTAL * GATE.chronicFailShare) - BASE.chronic);
    const b = withFailing(n, 1);
    assert.ok(evaluateQuality(b, { now }).failures.some((f) => /mass failure/.test(f)));
    const failingIds = new Set(b.health.feeds.filter((f) => !f.ok).map((f) => f.id));
    for (const s of b.sources.sources) if (failingIds.has(s.id) && !s.tags?.includes("probation")) s.tags = [...(s.tags ?? []), "probation"];
    const r = evaluateQuality(b, { now });
    assert.ok(!r.failures.some((f) => /mass failure/.test(f)), r.failures.join("\n"));
    assert.equal(r.stats.feeds?.chronic, failingIds.size);
    assert.equal(r.stats.feeds?.live, TOTAL - failingIds.size);
    // ... but a registry that is 40% probation-and-failing is still a collapse.
    assert.ok(r.failures.some((f) => f.includes(`${failingIds.size} of ${TOTAL} feeds are chronic`)), r.failures.join("\n"));

    // The fixture's own not-ok probation sources are excluded from the live denominator and warned about.
    const own = evaluateQuality(fixtureBundle, { now });
    const chronic = fixtureBundle.health.feeds.filter((f) => !f.ok && (PROBATION.has(f.id) || f.status === "quarantined" || f.failStreak >= GATE.chronicFailStreak));
    assert.ok(chronic.some((f) => PROBATION.has(f.id) && f.failStreak < GATE.chronicFailStreak && f.status !== "quarantined"), "the fixture has a probation source on its first failures");
    assert.equal(own.stats.feeds?.chronic, chronic.length);
    assert.equal(own.stats.feeds?.live, TOTAL - chronic.length - BASE.empty);
    assert.ok(own.warnings.some((w) => w.startsWith(`feeds: ${chronic.length} chronic`)));
  });

  it("accepts threshold overrides", () => {
    const r = evaluateQuality(withFailing(MASS, 1), { now, thresholds: { feedsFailBelow: 0.5, feedsWarnBelow: 0.5 } });
    assert.ok(!r.failures.some((f) => /mass failure/.test(f)));
  });
});

describe("freshness", () => {
  it("is only checked when BUILD_STARTED_AT is set", () => {
    assert.equal(checkFreshness("2026-11-19T20:08:38.159Z", undefined), null);
    assert.equal(checkFreshness("2026-11-19T20:08:38.159Z", "  "), null);
  });

  it("passes data generated by this build and fails data from before it", () => {
    assert.equal(checkFreshness("2026-11-19T20:08:38.159Z", "2026-11-19T20:08:10Z"), null);
    assert.equal(checkFreshness("2026-11-19T20:08:10.000Z", "2026-11-19T20:08:10Z"), null);
    assert.match(checkFreshness("2026-11-19T19:38:28.000Z", "2026-11-19T20:08:10Z") ?? "", /^stale: generatedAt 2026-11-19T19:38:28.000Z is older than this build/);
    assert.match(checkFreshness("2026-11-19T20:08:38.159Z", "yesterday") ?? "", /is not a date/);
    assert.match(checkFreshness("garbage", "2026-11-19T20:08:10Z") ?? "", /generatedAt "garbage" is not a date/);
  });
});
