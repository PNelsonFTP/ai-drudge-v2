import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DAY_MS, HOUR_MS } from "../../../shared/time";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeEdition, makeItem, makeNormalized, makeRiver, makeScoredStory } from "../../../test/helpers/factories";
import { PIPELINE, createTestContext, emptyState } from "../context";
import type { EmitBundle, FeedHealth, IngestOutput, LogLevel, NextStateInput, NormalizedItem, PipelineState, Placements } from "../types";
import { RESOLVED_URLS_MAX, STORED_SUMMARY_MAX, loadState, nextState, parseState, slimLastGood, storedSummary } from "./store";

const iso = (ms: number): string => new Date(ms).toISOString();
const daysAgo = (d: number): string => iso(FIXTURE_NOW_MS - d * DAY_MS);

function ingestOf(over: Partial<IngestOutput> = {}): IngestOutput {
  return { items: [], health: [], signals: { hn: { byUrl: new Map() } }, resolvedUrls: {}, lastGood: {}, ...over };
}

/** A run with the given normalized items; the river holds the same items, the lead is `leadId`. */
function runOf(normalized: readonly NormalizedItem[], over: { ingest?: Partial<IngestOutput>; leadId?: string | null } = {}): NextStateInput {
  const articles = normalized.map((n) => makeArticle({ id: n.id, url: n.url, title: n.title, src: n.sourceId, publishedAt: n.publishedAt, firstSeenAt: n.firstSeenAt, home: n.home }));
  const leadId = over.leadId ?? null;
  const { front, rest } = makeEdition({ articles, top: leadId ? [leadId] : [], meta: { generatedAt: iso(FIXTURE_NOW_MS), buildId: iso(FIXTURE_NOW_MS) } });
  const bundle = { front, rest, river: makeRiver(articles, { meta: { generatedAt: iso(FIXTURE_NOW_MS) } }) } as unknown as EmitBundle;
  const placements: Placements = { stories: {}, sections: [], top: leadId ? [leadId] : [], leadId, primary: {} };
  return { ingest: ingestOf(over.ingest), normalized, placements, bundle };
}

const ok = (sourceId: string): FeedHealth => ({ sourceId, ok: true, status: "ok", count: 5, ms: 100, failStreak: 0, lastOkAt: iso(FIXTURE_NOW_MS), attempts: 1 });
const failing = (sourceId: string, over: Partial<FeedHealth> = {}): FeedHealth => ({ sourceId, ok: false, status: "failing", count: 0, ms: 8000, error: "http", detail: "HTTP 403", failStreak: 1, lastOkAt: null, attempts: 3, ...over });

describe("state: nextState first-seen ledger", () => {
  it("records new ids with their firstSeenAt and keeps the original time of known ids", () => {
    const ctx = createTestContext();
    const known = makeNormalized({ url: "https://a.test/known", firstSeenAt: hoursAgo(50) });
    const fresh = makeNormalized({ url: "https://a.test/fresh", publishedAt: null, firstSeenAt: ctx.now.toISOString() });
    const prev: PipelineState = { ...emptyState(), firstSeen: { [known.id]: hoursAgo(50) } };
    const next = nextState(prev, runOf([known, fresh]), ctx);
    assert.deepEqual(next.firstSeen, { [known.id]: hoursAgo(50), [fresh.id]: ctx.now.toISOString() });
    assert.deepEqual(prev.firstSeen, { [known.id]: hoursAgo(50) }, "prev is not mutated");
  });

  it("prunes ids no feed has listed for the TTL, measured from the last sighting", () => {
    const ttl = PIPELINE.firstSeenTtlDays;
    const ctx = createTestContext();
    const prev: PipelineState = {
      ...emptyState(),
      firstSeen: { gone: daysAgo(ttl + 2), recentlySeen: daysAgo(ttl + 30), young: daysAgo(3), legacyOld: daysAgo(ttl + 1), legacyYoung: daysAgo(ttl - 1) },
      lastSeenDay: { gone: Math.floor(FIXTURE_NOW_MS / DAY_MS) - ttl - 1, recentlySeen: Math.floor(FIXTURE_NOW_MS / DAY_MS) - 2, young: Math.floor(FIXTURE_NOW_MS / DAY_MS) - 3 },
    };
    const next = nextState(prev, runOf([]), ctx);
    assert.deepEqual(Object.keys(next.firstSeen).sort(), ["legacyYoung", "recentlySeen", "young"]);
    assert.equal(next.firstSeen.recentlySeen, daysAgo(ttl + 30), "an old id a feed listed two days ago keeps its first-seen time");
  });

  it("never forgets an id a feed still lists, however old (undated evergreen posts must not turn 'new')", () => {
    const ctx = createTestContext();
    const evergreen = makeNormalized({ url: "https://slow.blog/2024-post", publishedAt: null, firstSeenAt: daysAgo(400) });
    const prev: PipelineState = { ...emptyState(), firstSeen: { [evergreen.id]: daysAgo(400) } };
    const day1 = nextState(prev, runOf([evergreen]), ctx);
    assert.equal(day1.firstSeen[evergreen.id], daysAgo(400));

    // The feed is down for 10 days: the id survives because it was LAST seen 10 days ago, not 400.
    const later = createTestContext({ now: new Date(FIXTURE_NOW_MS + 10 * DAY_MS) });
    const day10 = nextState(day1, runOf([]), later);
    assert.equal(day10.firstSeen[evergreen.id], daysAgo(400));

    // Unseen for longer than the TTL: forgotten.
    const muchLater = createTestContext({ now: new Date(FIXTURE_NOW_MS + (PIPELINE.firstSeenTtlDays + 2) * DAY_MS) });
    assert.equal(nextState(day10, runOf([]), muchLater).firstSeen[evergreen.id], undefined);
  });

  it("keeps the ledger TTL above the longest section window", () => {
    assert.ok(PIPELINE.firstSeenTtlDays > 21);
  });
});

describe("state: nextState caches", () => {
  it("merges resolved URLs, most recently confirmed last, and caps the cache", () => {
    const ctx = createTestContext();
    const prev: PipelineState = { ...emptyState(), resolvedUrls: { "https://news.google.com/a": "https://a.test/1", "https://news.google.com/b": "https://b.test/1" } };
    const next = nextState(prev, runOf([], { ingest: { resolvedUrls: { "https://news.google.com/a": "https://a.test/2", "https://news.google.com/c": "https://c.test/1", "javascript:alert(1)": "https://x.test/" } } }), ctx);
    assert.deepEqual(Object.entries(next.resolvedUrls), [
      ["https://news.google.com/b", "https://b.test/1"],
      ["https://news.google.com/a", "https://a.test/2"],
      ["https://news.google.com/c", "https://c.test/1"],
    ]);

    const big: Record<string, string> = {};
    for (let i = 0; i < RESOLVED_URLS_MAX + 10; i++) big[`https://news.google.com/w${i}`] = `https://t.test/${i}`;
    const capped = nextState({ ...emptyState(), resolvedUrls: big }, runOf([], { ingest: { resolvedUrls: { "https://news.google.com/new": "https://n.test/" } } }), ctx);
    const keys = Object.keys(capped.resolvedUrls);
    assert.equal(keys.length, RESOLVED_URLS_MAX);
    assert.equal(keys.at(-1), "https://news.google.com/new");
    assert.ok(!keys.includes("https://news.google.com/w0"), "the stalest entries go first");
  });

  it("keeps last-good snapshots only while they can still be carried forward (6 h)", () => {
    const ctx = createTestContext();
    const snap = (hours: number) => ({ fetchedAt: hoursAgo(hours), items: [makeItem({ sourceId: "x" })] });
    const prev: PipelineState = { ...emptyState(), lastGood: { stale: snap(7), usable: snap(5), replaced: snap(2) } };
    const next = nextState(prev, runOf([], { ingest: { lastGood: { replaced: snap(0), fresh: snap(0), empty: { fetchedAt: hoursAgo(0), items: [] } } } }), ctx);
    assert.deepEqual(Object.keys(next.lastGood).sort(), ["fresh", "replaced", "usable"]);
    assert.equal(next.lastGood.replaced.fetchedAt, hoursAgo(0));
    assert.equal(PIPELINE.carryForwardMaxHours, 6);
  });

  it("tracks feed health streaks, last error and attempt times", () => {
    const ctx = createTestContext();
    const nowIso = ctx.now.toISOString();
    const prev: PipelineState = {
      ...emptyState(),
      health: {
        recovered: { failStreak: 4, lastOkAt: hoursAgo(30), lastAttemptAt: hoursAgo(1), lastError: "HTTP 500", lastErrorClass: "http" },
        down: { failStreak: 9, lastOkAt: hoursAgo(100), lastAttemptAt: hoursAgo(1), lastError: "HTTP 403", lastErrorClass: "http" },
        quarantined: { failStreak: 60, lastOkAt: null, lastAttemptAt: hoursAgo(10), lastError: "HTTP 404", lastErrorClass: "http" },
        paused: { failStreak: 0, lastOkAt: hoursAgo(48), lastAttemptAt: hoursAgo(48) },
        removed: { failStreak: 3, lastOkAt: null, lastAttemptAt: daysAgo(PIPELINE.firstSeenTtlDays + 1) },
      },
    };
    const health: FeedHealth[] = [
      ok("recovered"),
      failing("down", { failStreak: 10, detail: undefined, error: "timeout", lastOkAt: hoursAgo(100) }),
      failing("quarantined", { status: "quarantined", error: "skipped", detail: undefined, failStreak: 60, attempts: 0 }),
      failing("brand-new", { failStreak: 0 }),
    ];
    const next = nextState(prev, runOf([], { ingest: { health } }), ctx);
    assert.deepEqual(next.health.recovered, { failStreak: 0, lastOkAt: nowIso, lastAttemptAt: nowIso });
    assert.deepEqual(next.health.down, { failStreak: 10, lastOkAt: hoursAgo(100), lastAttemptAt: nowIso, lastError: "HTTP 403", lastErrorClass: "timeout" });
    assert.deepEqual(next.health.quarantined, prev.health.quarantined, "a skipped (unprobed) quarantined source keeps its entry: probe clock and last real failure");
    assert.deepEqual(next.health["brand-new"], { failStreak: 1, lastOkAt: null, lastAttemptAt: nowIso, lastError: "HTTP 403", lastErrorClass: "http" });
    assert.deepEqual(next.health.paused, prev.health.paused, "a source not fetched this run keeps its entry");
    assert.equal(next.health.removed, undefined, "entries of sources gone for the TTL are dropped");
  });

  it("takes the river as the next river memory", () => {
    const ctx = createTestContext();
    const a = makeNormalized({ url: "https://a.test/1", title: "Lead", sourceId: "src-a", home: "models", publishedAt: hoursAgo(2) });
    const b = makeNormalized({ url: "https://a.test/2", title: "Undated", sourceId: "src-b", publishedAt: null, firstSeenAt: hoursAgo(1) });
    const next = nextState(emptyState(), runOf([a, b]), ctx);
    assert.deepEqual(next.recent, [
      { id: b.id, title: "Undated", url: b.url, sourceId: "src-b", section: "industry", publishedAtMs: null, firstSeenAtMs: FIXTURE_NOW_MS - HOUR_MS, leadId: null },
      { id: a.id, title: "Lead", url: a.url, sourceId: "src-a", section: "models", publishedAtMs: FIXTURE_NOW_MS - 2 * HOUR_MS, firstSeenAtMs: FIXTURE_NOW_MS - 2 * HOUR_MS, leadId: null },
    ]);
  });

  it("remembers since when the lead has led: unchanged keeps the time, a new lead starts now, none is null", () => {
    const ctx = createTestContext();
    const a = makeNormalized({ url: "https://a.test/lead" });
    const b = makeNormalized({ url: "https://a.test/other" });
    const prev: PipelineState = { ...emptyState(), lead: { id: a.id, since: hoursAgo(5) } };
    assert.deepEqual(nextState(prev, runOf([a, b], { leadId: a.id }), ctx).lead, { id: a.id, since: hoursAgo(5) });
    assert.deepEqual(nextState(prev, runOf([a, b], { leadId: b.id }), ctx).lead, { id: b.id, since: ctx.now.toISOString() });
    assert.equal(nextState(prev, runOf([a, b]), ctx).lead, null);
  });

  it("keeps the lead's tenure when the story's lead ARTICLE changes but the previous lead is still in the story", () => {
    const ctx = createTestContext();
    const wire = makeNormalized({ url: "https://wire.test/ipo" });
    const firstParty = makeNormalized({ url: "https://lab.test/ipo" });
    const prev: PipelineState = { ...emptyState(), lead: { id: wire.id, since: hoursAgo(5) } };
    const run = runOf([wire, firstParty], { leadId: firstParty.id });
    // The first-party post took over as lead of the same story; the wire article is now a member.
    run.placements.stories[firstParty.id] = makeScoredStory([firstParty, wire]);
    assert.deepEqual(nextState(prev, run, ctx).lead, { id: firstParty.id, since: hoursAgo(5) });
    // A different story: tenure restarts.
    run.placements.stories[firstParty.id] = makeScoredStory([firstParty]);
    assert.deepEqual(nextState(prev, run, ctx).lead, { id: firstParty.id, since: ctx.now.toISOString() });
  });
});

describe("state: TOP STORIES memory (route's membership hold)", () => {
  const topRun = (stories: { item: NormalizedItem; score: number }[], held: Placements["topHeld"] = undefined): NextStateInput => {
    const run = runOf(stories.map((s) => s.item), { leadId: stories[0]?.item.id ?? null });
    run.bundle.front.top = stories.map((s) => s.item.id);
    run.placements.top = [...run.bundle.front.top];
    for (const s of stories) run.placements.stories[s.item.id] = makeScoredStory([s.item], { score: s.score });
    if (held) run.placements.topHeld = held;
    return run;
  };
  const a = makeNormalized({ url: "https://a.test/top-1" });
  const b = makeNormalized({ url: "https://a.test/top-2" });

  it("remembers the published TOP STORIES in order with their scores (one decimal)", () => {
    const next = nextState(emptyState(), topRun([{ item: a, score: 138.4449 }, { item: b, score: 97.96 }]), createTestContext());
    assert.deepEqual(next.top, [{ id: a.id, score: 138.4 }, { id: b.id, score: 98 }]);
  });

  it("keeps a held story's hold score and start time, so a hold cannot renew itself", () => {
    const since = hoursAgo(1);
    const next = nextState(emptyState(), topRun([{ item: a, score: 120 }, { item: b, score: 61.2 }], { [b.id]: { since, score: 93.5 } }), createTestContext());
    assert.deepEqual(next.top, [{ id: a.id, score: 120 }, { id: b.id, score: 93.5, heldSince: since }]);
  });

  it("follows what was PUBLISHED (emit may cut the list) and is absent when there is no TOP story", () => {
    const run = topRun([{ item: a, score: 120 }, { item: b, score: 90 }]);
    run.bundle.front.top = [a.id];
    assert.deepEqual(nextState(emptyState(), run, createTestContext()).top, [{ id: a.id, score: 120 }]);
    const none = nextState({ ...emptyState(), top: [{ id: a.id, score: 1 }] }, runOf([a]), createTestContext());
    assert.equal("top" in none, false);
  });

  it("is parsed field by field: malformed entries are dropped, the list is capped at 12", () => {
    const parsed = parseState({
      top: [{ id: "ok", score: 90.1 }, { id: "held", score: 80, heldSince: "2026-11-19T20:00:00.000Z" }, { id: "bad-since", score: 70, heldSince: "yesterday" }, { id: "", score: 5 }, { id: "no-score" }, { id: "nan", score: Number.NaN }, "junk", null],
    });
    assert.deepEqual(parsed.top, [{ id: "ok", score: 90.1 }, { id: "held", score: 80, heldSince: "2026-11-19T20:00:00.000Z" }, { id: "bad-since", score: 70 }]);
    assert.equal(parseState({ top: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, score: i })) }).top?.length, 12);
    assert.equal("top" in parseState({ top: "nope" }), false);
    assert.equal("top" in parseState({ top: [] }), false);
  });

  it("round-trips through the state file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-state-top-"));
    const file = path.join(dir, "state.json");
    const ctx = createTestContext();
    const good = nextState(emptyState(), topRun([{ item: a, score: 120 }, { item: b, score: 61.2 }], { [b.id]: { since: hoursAgo(1), score: 93.5 } }), ctx);
    await fs.writeFile(file, JSON.stringify({ ...good, schemaVersion: 2, buildId: "b", savedAt: ctx.now.toISOString() }));
    assert.deepEqual((await loadState(file)).top, good.top);
    await fs.rm(dir, { recursive: true });
  });
});

describe("state: the brief failure streak (written by run.ts) survives the round trip", () => {
  it("parseState keeps a positive whole count and nothing else; nextState never carries it over", () => {
    assert.equal(parseState({ briefFailStreak: 3 }).briefFailStreak, 3);
    assert.equal(parseState({ briefFailStreak: 4.9 }).briefFailStreak, 4);
    for (const bad of [0, -2, "3", null, Number.NaN, Number.POSITIVE_INFINITY, {}]) assert.equal("briefFailStreak" in parseState({ briefFailStreak: bad }), false, String(bad));
    const next = nextState({ ...emptyState(), briefFailStreak: 5 }, runOf([]), createTestContext());
    assert.equal("briefFailStreak" in next, false, "run.ts decides the new value from this build's brief");
  });
});

describe("state: loadState", () => {
  const logsOf = () => {
    const logs: { level: LogLevel; msg: string }[] = [];
    return { logs, log: (level: LogLevel, msg: string) => void logs.push({ level, msg }) };
  };

  it("returns an empty state for a missing file (first run)", async () => {
    const { logs, log } = logsOf();
    const state = await loadState(path.join(os.tmpdir(), "aid2-does-not-exist", "state.json"), log);
    assert.deepEqual(state, emptyState());
    assert.deepEqual(logs.map((l) => l.level), ["info"]);
  });

  it("returns an empty state for corrupt JSON, a wrong schema or a non-object, with a warning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-state-"));
    for (const [name, body] of [["corrupt.json", '{"firstSeen": {"a": '], ["v1.json", '{"schemaVersion":1,"firstSeen":{"a":"2026-11-19T00:00:00Z"}}'], ["html.json", "<!DOCTYPE html><html>404</html>"], ["array.json", "[]"]] as const) {
      const { logs, log } = logsOf();
      const file = path.join(dir, name);
      await fs.writeFile(file, body);
      assert.deepEqual(await loadState(file, log), emptyState(), name);
      assert.deepEqual(logs.map((l) => l.level), ["warn"], name);
    }
    assert.deepEqual(await loadState(dir), emptyState(), "a directory is unreadable, not a crash (and log is optional)");
    await fs.rm(dir, { recursive: true });
  });

  it("round-trips a state written by a build and drops malformed parts field by field", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-state-"));
    const file = path.join(dir, "state.json");
    const ctx = createTestContext();
    const item = makeNormalized({ url: "https://a.test/1", sourceId: "src-a" });
    const good = nextState(
      { ...emptyState(), lead: { id: item.id, since: hoursAgo(3) } },
      runOf([item], { leadId: item.id, ingest: { health: [failing("src-a")], resolvedUrls: { "https://news.google.com/a": "https://a.test/1" }, lastGood: { "src-a": { fetchedAt: hoursAgo(0), items: [makeItem({ sourceId: "src-a", comments: "https://news.ycombinator.com/item?id=1", categories: ["cs.AI"] })], ...{ etag: 'W/"abc"', lastModified: "Thu, 19 Nov 2026 20:00:00 GMT", bodyAt: hoursAgo(0) } } } } }),
      ctx,
    );
    await fs.writeFile(file, JSON.stringify({ ...good, schemaVersion: 2, buildId: "b", savedAt: ctx.now.toISOString() }));
    const { logs, log } = logsOf();
    const restored = await loadState(file, log);
    assert.deepEqual(restored, good);
    assert.equal((restored.lastGood["src-a"] as { etag?: string }).etag, 'W/"abc"', "ingest's HTTP validators survive the round trip");
    assert.match(logs[0].msg, /restored 1 first-seen ids, 1 recent items, 1 feed states \(saved 2026-11-19T21:00:00.000Z\)/);

    await fs.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        firstSeen: { ok: "2026-11-19T00:00:00Z", bad: "not a date", worse: 5 },
        resolvedUrls: { "https://news.google.com/a": "https://a.test/1", "https://news.google.com/b": "javascript:alert(1)" },
        health: { a: { failStreak: 2, lastOkAt: "nope", lastAttemptAt: null }, b: "x", c: { failStreak: "many" } },
        lastGood: { a: { fetchedAt: "2026-11-19T00:00:00Z", items: [{ sourceId: "a", title: "t", link: "https://a.test/x", publishedRaw: 5 }, { title: "no source" }, { sourceId: "a", title: "t", link: "file:///etc/passwd" }] }, b: { fetchedAt: "x", items: [] } },
        recent: [{ id: "r1", title: "t", url: "https://a.test/r", sourceId: "a", section: "models", publishedAtMs: null, firstSeenAtMs: 1, leadId: "" }, { id: "r2", title: "t", url: "https://a.test/r", sourceId: "a", section: "model_releases", firstSeenAtMs: 1 }, "junk"],
        lead: { id: "x" },
        lastSeenDay: { ok: 20000, orphan: 20000, bad: "x" },
      }),
    );
    assert.deepEqual(await loadState(file), {
      firstSeen: { ok: "2026-11-19T00:00:00Z" },
      resolvedUrls: { "https://news.google.com/a": "https://a.test/1" },
      health: { a: { failStreak: 2, lastOkAt: null, lastAttemptAt: null } },
      lastGood: { a: { fetchedAt: "2026-11-19T00:00:00Z", items: [{ sourceId: "a", title: "t", link: "https://a.test/x", publishedRaw: null, summaryHtml: null }] } },
      recent: [{ id: "r1", title: "t", url: "https://a.test/r", sourceId: "a", section: "models", publishedAtMs: null, firstSeenAtMs: 1, leadId: null }],
      lead: null,
      lastSeenDay: { ok: 20000 },
    });
    assert.deepEqual(parseState(null), emptyState());
    await fs.rm(dir, { recursive: true });
  });
});

describe("state: what is saved of the last-good snapshots", () => {
  // Stand-in for normalize's cleanText (a stage directory may not import a sibling): tags out, the
  // named entities decoded, whitespace collapsed. run.test.ts covers the real cleaner.
  const toText = (html: string): string =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();

  it("stores plain text instead of the publisher's HTML: no tags, at most 600 chars, validators and items untouched", () => {
    const html = `<p>AT&amp;T said <b>5 &lt; 6</b>.</p><img src="https://tracker.example/pixel.gif"><script>alert(1)</script>${"<p>Paywalled paragraph. </p>".repeat(200)}`;
    const snap = { fetchedAt: hoursAgo(0), bodyAt: hoursAgo(0), etag: 'W/"abc"', lastModified: "Thu, 19 Nov 2026 20:00:00 GMT", items: [makeItem({ sourceId: "a", summaryHtml: html, guid: "g1", categories: ["cs.AI"] }), makeItem({ sourceId: "a", summaryHtml: null }), makeItem({ sourceId: "a", summaryHtml: "<p> </p>" })] };
    const state: PipelineState = { ...emptyState(), firstSeen: { x: hoursAgo(1) }, lastGood: { a: snap } };
    const slim = slimLastGood(state, toText);

    const saved = slim.lastGood.a.items.map((i) => i.summaryHtml);
    assert.ok(saved[0]?.startsWith("AT&amp;T said 5 &lt; 6 . alert(1) Paywalled paragraph."), saved[0] ?? "");
    assert.ok(!/<|&(?!amp;|lt;)/.test(saved[0] ?? ""), "no tag and no raw markup character survives");
    assert.ok(toText(saved[0] ?? "").length <= STORED_SUMMARY_MAX);
    assert.equal(saved[1], null);
    assert.equal(saved[2], null, "markup without text is no summary");

    const { items: slimItems, ...slimMeta } = slim.lastGood.a;
    const { items: rawItems, ...rawMeta } = snap;
    assert.deepEqual(slimMeta, rawMeta, "fetchedAt, bodyAt, etag and lastModified are kept (conditional GET still works)");
    assert.deepEqual(slimItems.map((i) => ({ ...i, summaryHtml: null })), rawItems.map((i) => ({ ...i, summaryHtml: null })), "every other field of every item is untouched");
    assert.deepEqual({ ...slim, lastGood: {} }, { ...state, lastGood: {} }, "nothing but lastGood changes");
    assert.equal(snap.items[0].summaryHtml, html, "the input is not mutated");
  });

  it("is idempotent, and the next build reads back exactly the text that was saved", () => {
    const emoji = "\u{1F600}";
    const state: PipelineState = {
      ...emptyState(),
      lastGood: { a: { fetchedAt: hoursAgo(0), items: [makeItem({ sourceId: "a", summaryHtml: `<p>R&amp;D &amp;amp; a &lt;tag&gt; in prose ${emoji}</p>` }), makeItem({ sourceId: "a", summaryHtml: `${"x".repeat(599)}${emoji}tail` })] } },
    };
    const once = slimLastGood(state, toText);
    assert.deepEqual(slimLastGood(once, toText), once, "a snapshot saved again unchanged (304, carry-forward) stays byte-identical");
    assert.equal(toText(once.lastGood.a.items[0].summaryHtml ?? ""), `R&D &amp; a <tag> in prose ${emoji}`);
    assert.equal(once.lastGood.a.items[1].summaryHtml, "x".repeat(599), "the cut never splits a surrogate pair");
    assert.equal(storedSummary(null, toText), null);
    assert.equal(storedSummary("plain", toText), "plain");
  });

  it("the parsed form of a slimmed state is the slimmed state (it survives the state.json round trip)", () => {
    const state: PipelineState = { ...emptyState(), lastGood: { a: { fetchedAt: hoursAgo(0), items: [makeItem({ sourceId: "a", summaryHtml: "<p>Shares rose <b>17%</b> &amp; more.</p>" })] } } };
    const slim = slimLastGood(state, toText);
    assert.deepEqual(parseState(JSON.parse(JSON.stringify({ schemaVersion: 2, ...slim }))), slim);
  });
});
