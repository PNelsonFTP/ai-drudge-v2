import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeItem } from "../../../test/helpers/factories";
import { readFeedFixture, readFixtureText } from "../../../test/helpers/fixtures";
import { urlKey } from "../../../shared/url";
import { PIPELINE, TEST_NOW_ISO } from "../context";
import type { LastGood, SourceHealthState } from "../types";
import { parseFeed } from "./feedParser";
import { carryForward, cachedItems, healthFailed, healthHostBackoff, healthOk, healthSkipped, isQuarantined, nextHealthState, planSource } from "./feedState";
import { isGithubReleaseSource, releaseEntries, releaseTagFromLink, repoOfGithubUrl } from "./githubRelease";
import { addHnHits, emptyHnIndex, fetchHnIndex, hnEndpoints } from "./signals/hn";
import { respond, scriptedFetch } from "./testing/fakeNet";
import { createVirtualClock } from "./testing/virtualClock";

const NOW = new Date(TEST_NOW_ISO);
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const health = (over: Partial<SourceHealthState> = {}): SourceHealthState => ({ failStreak: 0, lastOkAt: hoursAgo(0.5), lastAttemptAt: hoursAgo(0.5), ...over });
const good = (over: Partial<LastGood> = {}): LastGood => ({ fetchedAt: hoursAgo(0.5), items: [makeItem({ sourceId: "s" }), makeItem({ sourceId: "s" })], ...over });

describe("planSource", () => {
  it("first run / no state: plain fetch", () => {
    assert.deepEqual(planSource(undefined, undefined, NOW), { action: "fetch", probe: false, conditional: null });
  });

  it("healthy source with validators: conditional GET", () => {
    const plan = planSource(health(), good({ etag: 'W/"abc"', lastModified: "Thu, 19 Nov 2026 18:02:11 GMT" }), NOW);
    assert.deepEqual(plan, { action: "fetch", probe: false, conditional: { etag: 'W/"abc"', lastModified: "Thu, 19 Nov 2026 18:02:11 GMT" } });
  });

  it("no conditional GET without validators, without cached items, after a failure, or when the body is over 24 h old", () => {
    assert.equal(planOf(health(), good()), null);
    assert.equal(planOf(health(), good({ etag: "x", items: [] })), null);
    assert.equal(planOf(health({ failStreak: 1 }), good({ etag: "x" })), null);
    // 304s keep fetchedAt fresh; bodyAt remembers the last full download.
    assert.equal(planOf(health(), good({ etag: "x", fetchedAt: hoursAgo(0.5), bodyAt: hoursAgo(25) })), null);
    assert.notEqual(planOf(health(), good({ etag: "x", fetchedAt: hoursAgo(0.5), bodyAt: hoursAgo(23) })), null);
  });

  it(`quarantine after ${PIPELINE.quarantineAfterFails} consecutive failures: skipped, one probe per day`, () => {
    const dead = (lastAttemptHours: number): SourceHealthState => health({ failStreak: 48, lastOkAt: hoursAgo(72), lastAttemptAt: hoursAgo(lastAttemptHours), lastError: "HTTP 404", lastErrorClass: "http" });
    assert.equal(isQuarantined(dead(1)), true);
    assert.deepEqual(planSource(dead(0.5), undefined, NOW), { action: "skip" });
    assert.deepEqual(planSource(dead(23.9), undefined, NOW), { action: "skip" });
    assert.deepEqual(planSource(dead(24), undefined, NOW), { action: "fetch", probe: true, conditional: null });
    assert.deepEqual(planSource(health({ failStreak: 47, lastErrorClass: "http" }), undefined, NOW), { action: "fetch", probe: false, conditional: null });
    assert.deepEqual(planSource({ ...dead(1), lastAttemptAt: null }, undefined, NOW), { action: "fetch", probe: true, conditional: null });
  });

  it("an empty-but-valid feed is never quarantined (arXiv is empty every weekend)", () => {
    const empty = health({ failStreak: 120, lastErrorClass: "empty", lastError: "feed has no items" });
    assert.equal(isQuarantined(empty), false);
    assert.equal(planSource(empty, undefined, NOW).action, "fetch");
  });

  function planOf(h: SourceHealthState, lg: LastGood): unknown {
    const p = planSource(h, lg, NOW);
    return p.action === "fetch" ? p.conditional : "skip";
  }
});

describe("carry-forward", () => {
  it(`reuses last-good items for up to ${PIPELINE.carryForwardMaxHours} h and flags them`, () => {
    const lg = good({ fetchedAt: hoursAgo(5.9) });
    const carried = carryForward(lg, NOW);
    assert.equal(carried.length, 2);
    assert.ok(carried.every((i) => i.carried === true));
    assert.equal(lg.items[0].carried, undefined, "state is not mutated");
    assert.deepEqual(carryForward(good({ fetchedAt: hoursAgo(6.1) }), NOW), []);
    assert.deepEqual(carryForward(undefined, NOW), []);
    assert.deepEqual(carryForward(good({ items: [] }), NOW), []);
    assert.deepEqual(carryForward(good({ fetchedAt: "garbage" }), NOW), []);
    assert.deepEqual(carryForward(good({ fetchedAt: hoursAgo(-2) }), NOW), [], "a timestamp from the future is not trusted");
  });

  it("cached items served for a 304 are not flagged carried", () => {
    const lg = good({ items: [makeItem({ carried: true })] });
    assert.equal(cachedItems(lg)[0].carried, undefined);
    assert.deepEqual(cachedItems(undefined), []);
  });
});

describe("health rows", () => {
  it("ok resets the streak", () => {
    assert.deepEqual(healthOk("s", 12, { ms: 123.6, attempts: 1, skippedItems: 2 }, NOW), { sourceId: "s", ok: true, status: "ok", count: 12, ms: 124, failStreak: 0, lastOkAt: TEST_NOW_ISO, attempts: 1, skippedItems: 2 });
  });

  it("failing vs carried vs quarantined", () => {
    const prev = health({ failStreak: 2, lastOkAt: hoursAgo(1.5) });
    const failing = healthFailed("s", prev, { error: "http", detail: "HTTP 503", httpStatus: 503 }, 0, { ms: 900, attempts: 3 });
    assert.deepEqual(failing, { sourceId: "s", ok: false, status: "failing", count: 0, ms: 900, error: "http", detail: "HTTP 503", failStreak: 3, lastOkAt: hoursAgo(1.5), attempts: 3, httpStatus: 503 });
    assert.equal(healthFailed("s", prev, { error: "timeout", detail: "timeout after 8000 ms" }, 7, { ms: 1, attempts: 3 }).status, "carried");
    assert.equal(healthFailed("s", undefined, { error: "empty", detail: "feed has no items" }, 0, { ms: 1, attempts: 1 }).failStreak, 1);

    const entering = healthFailed("s", health({ failStreak: 47 }), { error: "http", detail: "HTTP 404", httpStatus: 404 }, 3, { ms: 1, attempts: 1 });
    assert.deepEqual([entering.status, entering.failStreak, entering.count], ["quarantined", 48, 0]);
    const emptyForever = healthFailed("s", health({ failStreak: 200 }), { error: "empty", detail: "feed has no items" }, 0, { ms: 1, attempts: 1 });
    assert.equal(emptyForever.status, "failing");
  });

  it("a skipped (quarantined, not probed) source keeps its streak and last real error", () => {
    const prev = health({ failStreak: 60, lastOkAt: null, lastAttemptAt: hoursAgo(3), lastError: "HTTP 404", lastErrorClass: "http" });
    assert.deepEqual(healthSkipped("s", prev), { sourceId: "s", ok: false, status: "quarantined", count: 0, ms: 0, error: "skipped", detail: "HTTP 404", failStreak: 60, lastOkAt: null, attempts: 0 });
  });

  it("host backoff: the source was not asked - carried, class 'skipped', a health note, and its own state untouched", () => {
    const prev = health({ failStreak: 0, lastOkAt: hoursAgo(0.5), lastAttemptAt: hoursAgo(0.5) });
    const row = healthHostBackoff("s", prev, "hnrss.org answered HTTP 502 to 2 requests in a row", 3);
    assert.deepEqual(row, {
      sourceId: "s",
      ok: false,
      status: "carried",
      count: 3,
      ms: 0,
      error: "skipped",
      detail: "host backoff: hnrss.org answered HTTP 502 to 2 requests in a row; not requested this run, 3 last-good items carried",
      failStreak: 0,
      lastOkAt: hoursAgo(0.5),
      attempts: 0,
    });
    assert.deepEqual(nextHealthState(prev, row, NOW), prev, "no attempt was made: streak, last attempt and last error stay as they were");
    assert.equal(planSource(nextHealthState(prev, row, NOW), good({ etag: 'W/"1"' }), NOW).action, "fetch", "the next build asks again");
    const failing = health({ failStreak: 4, lastError: "HTTP 502", lastErrorClass: "http" });
    assert.deepEqual(nextHealthState(failing, healthHostBackoff("s", failing, "h answered HTTP 429 to 2 requests in a row", 1), NOW), failing, "a streak neither grows nor resets while the host is left alone");
    assert.match(healthHostBackoff("s", undefined, "x\ny", 1).detail ?? "", /^host backoff: x y; not requested this run, 1 last-good item carried$/);
  });

  it("nextHealthState: skip leaves lastAttemptAt alone (it schedules the daily probe); everything else stamps it", () => {
    const prev = health({ failStreak: 60, lastOkAt: null, lastAttemptAt: hoursAgo(3), lastError: "HTTP 404", lastErrorClass: "http" });
    assert.deepEqual(nextHealthState(prev, healthSkipped("s", prev), NOW), prev);

    const probeFailed = healthFailed("s", prev, { error: "http", detail: "HTTP 404", httpStatus: 404 }, 0, { ms: 5, attempts: 1 });
    assert.deepEqual(nextHealthState(prev, probeFailed, NOW), { failStreak: 61, lastOkAt: null, lastAttemptAt: TEST_NOW_ISO, lastError: "HTTP 404", lastErrorClass: "http" });

    const recovered = healthOk("s", 5, { ms: 5, attempts: 1 }, NOW);
    assert.deepEqual(nextHealthState(prev, recovered, NOW), { failStreak: 0, lastOkAt: TEST_NOW_ISO, lastAttemptAt: TEST_NOW_ISO });
  });

  it("48 failing runs in a row walk a source into quarantine, then one probe per day", () => {
    let state: SourceHealthState | undefined;
    let now = new Date(NOW);
    let requests = 0;
    const step = (): string => {
      const plan = planSource(state, undefined, now);
      let row;
      if (plan.action === "skip") row = healthSkipped("dead", state as SourceHealthState);
      else {
        requests++;
        row = healthFailed("dead", state, { error: "http", detail: "HTTP 404", httpStatus: 404 }, 0, { ms: 1, attempts: 1 });
      }
      state = nextHealthState(state, row, now);
      now = new Date(now.getTime() + 30 * 60_000);
      return row.status;
    };
    const statuses = Array.from({ length: 48 }, step);
    assert.ok(statuses.slice(0, 47).every((s) => s === "failing"));
    assert.equal(statuses[47], "quarantined");
    assert.equal(requests, 48);
    // The next 3 days at a 30-minute cadence: 144 runs, 3 probes.
    for (let i = 0; i < 144; i++) assert.equal(step(), "quarantined");
    assert.equal(requests, 48 + 3);
    assert.equal(state?.failStreak, 51);
  });
});

describe("GitHub release passthrough", () => {
  it("recognises release sources and extracts repo and tag", () => {
    assert.equal(isGithubReleaseSource({ kind: "github-release", url: "https://example.com/x" }), true);
    assert.equal(isGithubReleaseSource({ kind: "rss", url: "https://github.com/ollama/ollama/releases.atom" }), true);
    assert.equal(isGithubReleaseSource({ kind: "community", url: "https://www.reddit.com/r/LocalLLM/.rss" }), false);
    assert.equal(repoOfGithubUrl("https://github.com/ggml-org/llama.cpp/releases.atom"), "ggml-org/llama.cpp");
    assert.equal(releaseTagFromLink("https://github.com/langchain-ai/langchain/releases/tag/langchain-openrouter%3D%3D0.3.0"), "langchain-openrouter==0.3.0");
    assert.equal(releaseTagFromLink("https://github.com/lobehub/lobe-chat/releases/tag/cli-release/v0.0.140"), "cli-release/v0.0.140");
    assert.equal(releaseTagFromLink("https://github.com/ollama/ollama/releases"), null);
  });

  it("langchain monorepo fixture: all 10 raw entries pass through with tag links - sub-package tags included, nothing synthesized", () => {
    const parsed = parseFeed(readFeedFixture("github-releases-langchain.atom"), { feedUrl: "https://github.com/langchain-ai/langchain/releases.atom", preferContent: true });
    assert.ok(parsed.ok);
    const entries = releaseEntries(parsed.entries);
    assert.equal(entries.length, 10);
    const tags = entries.map((e) => releaseTagFromLink(e.link));
    assert.ok(tags.every((t) => t !== null));
    assert.ok(tags.some((t) => /^langchain-[a-z-]+==/.test(t ?? "")), "sub-package tags are visible to normalize");
    assert.ok(tags.some((t) => /^langchain==\d/.test(t ?? "")), "and so is the repo's own package");
    assert.ok(entries.every((e) => !/ released$/.test(e.title) && e.publishedRaw && e.guid));
  });

  it("vLLM fixture: the stable release and its release candidates are all present for normalize to choose from", () => {
    const parsed = parseFeed(readFixtureText("feeds-extra", "github-releases-vllm-rc-tags.atom"), { feedUrl: "https://github.com/vllm-project/vllm/releases.atom", preferContent: true });
    assert.ok(parsed.ok);
    const tags = releaseEntries(parsed.entries).map((e) => releaseTagFromLink(e.link));
    assert.ok(tags.includes("v0.34.0") && tags.includes("v0.34.0rc4") && tags.includes("v0.33.0"));
  });
});

describe("Hacker News signal", () => {
  it("indexes by shared urlKey (exact URL), keeps the max per URL, has no domain table", () => {
    const index = emptyHnIndex();
    const added = addHnHits(index, {
      hits: [
        { url: "https://www.example.com/post/?utm_source=hn", points: 120, num_comments: 40 },
        { url: "http://example.com/post", points: 300, num_comments: 10 },
        { url: "https://github.com/ggml-org/llama.cpp", points: 500, num_comments: 200 },
        { url: null, points: 900 },
        { points: 5 },
        "junk",
      ],
    });
    assert.equal(added, 2);
    assert.deepEqual(index.byUrl.get(urlKey("https://example.com/post") ?? ""), { points: 300, comments: 40 });
    assert.equal(index.byUrl.get("github.com"), undefined);
    assert.equal(index.byUrl.has(urlKey("https://github.com/ggml-org/llama.cpp/releases/tag/b1") ?? ""), false, "another URL on the same domain does not match");
    assert.deepEqual(Object.keys(index), ["byUrl"]);
    assert.equal(addHnHits(index, null), 0);
    assert.equal(addHnHits(index, { hits: "nope" }), 0);
  });

  it("asks Algolia for recent stories with traction and the front page", () => {
    const [recent, front] = hnEndpoints(NOW.getTime());
    assert.match(recent, /search_by_date\?tags=story&numericFilters=points%3E30,created_at_i%3E\d{10}&hitsPerPage=1000$/);
    assert.match(front, /tags=front_page/);
  });

  it("fetchHnIndex is fail-soft: one endpoint down, the other malformed -> empty index, no throw", async () => {
    const clock = createVirtualClock();
    const [recent] = hnEndpoints(NOW.getTime());
    const net = scriptedFetch((req) => (req.url === recent ? respond("nope", 503) : "<html>not json</html>"));
    const index = await clock.settle(fetchHnIndex(NOW.getTime(), { fetch: net.fetch, timers: clock, userAgent: "t" }));
    assert.equal(index.byUrl.size, 0);

    const ok = scriptedFetch((req) => (req.url === recent ? JSON.stringify({ hits: [{ url: "https://a.example.com/x", points: 77, num_comments: 3 }] }) : new TypeError("fetch failed")));
    const partial = await clock.settle(fetchHnIndex(NOW.getTime(), { fetch: ok.fetch, timers: clock, userAgent: "t" }));
    assert.deepEqual([...partial.byUrl.entries()], [["a.example.com/x", { points: 77, comments: 3 }]]);
  });
});
