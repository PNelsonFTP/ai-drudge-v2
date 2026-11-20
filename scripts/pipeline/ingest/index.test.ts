import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeItem, makeRegistry, makeSource } from "../../../test/helpers/factories";
import { fakeFetch, feedFixtureResponse, feedFixtures, loadFixtureRegistry, readFeedFixture, readFixtureJson, readFixtureText } from "../../../test/helpers/fixtures";
import { isHttpUrl } from "../../../shared/url";
import { createTestContext, emptyState, PIPELINE, TEST_NOW_ISO } from "../context";
import type { IngestOutput, LastGood, PipelineState, RawItem, Registry, SourceHealthState } from "../types";
import { compileTerms } from "../../../shared/text";
import { resolveSource } from "../../registry/defaults";
import { SOURCES } from "../../registry/index";
import { extractItems, fetchPolicyFor, ingest, INGEST_DEFAULTS, runIngest, SOURCE_FETCH_OVERRIDES, sourceRequest, uniqueByLink, type IngestOptions } from "./index";
import { HTTP_DEFAULTS } from "./http";
import { respond, routedFetch, scriptedFetch, type Handler, type Reply } from "./testing/fakeNet";
import { createVirtualClock, type VirtualClock } from "./testing/virtualClock";
import { sleep } from "./timers";
import { wrapperKey } from "./unwrap";

const NOW = new Date(TEST_NOW_ISO);
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function state(over: Partial<PipelineState> = {}): PipelineState {
  return deepFreeze({ ...emptyState(), ...over });
}

/** Run ingest on a virtual clock (no HN unless asked) and return the output plus the clock. */
async function run(registry: Registry, fetchImpl: typeof fetch, st: PipelineState = state(), opts: IngestOptions = {}): Promise<{ out: IngestOutput; clock: VirtualClock; logs: string[] }> {
  const clock = createVirtualClock();
  const ctx = createTestContext({ fetch: fetchImpl, state: st });
  const out = await clock.settle(runIngest(registry, ctx, { timers: clock, skipHn: true, ...opts }));
  return { out, clock, logs: ctx.logs.map((l) => l.msg) };
}

const rss = (items: { title: string; link: string; hoursAgo?: number }[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.hoursAgo === undefined ? "" : `<pubDate>${new Date(NOW.getTime() - i.hoursAgo * 3_600_000).toUTCString()}</pubDate>`}</item>`)
    .join("")}</channel></rss>`;

const FEED_A = "https://a.example.com/feed.xml";
const srcA = makeSource({ id: "src-a", url: FEED_A });
const health = (over: Partial<SourceHealthState> = {}): SourceHealthState => ({ failStreak: 0, lastOkAt: hoursAgo(0.5), lastAttemptAt: hoursAgo(0.5), ...over });

describe("ingest end-to-end over the fixture registry (207 sources, fake network)", () => {
  interface ScrapeFx {
    id: string;
    file: string;
    url: string;
    v1Scraper: boolean;
  }
  const registry = loadFixtureRegistry();
  const routes: Parameters<typeof fakeFetch>[0] = {};
  for (const fx of feedFixtures()) routes[fx.url] = feedFixtureResponse(fx.file);
  for (const fx of readFixtureJson<ScrapeFx[]>("scrape", "index.json").filter((f) => f.v1Scraper)) routes[fx.url] = new Response(readFixtureText("scrape", fx.file), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const expectedOk = ["wired-ai", "quanta-magazine-ai", "the-verge-ai", "nature-machine-intelligence", "langchain-ai-langchain", "ggml-org-llama-cpp", "hn-ai-150-points", "gn-ai-x-sec-finra", "anthropic-news", "anthropic-research", "uk-aisi-blog", "gray-swan"];

  it("returns health for every source, in registry order, and never throws", async () => {
    const net = fakeFetch(routes);
    const { out, clock, logs } = await run(registry, net, state(), { skipHn: false });

    assert.equal(out.health.length, 207);
    assert.deepEqual(out.health.map((h) => h.sourceId), registry.sources.map((s) => s.id));
    const ok = out.health.filter((h) => h.ok);
    assert.deepEqual(ok.map((h) => h.sourceId).sort(), [...expectedOk].sort());
    assert.ok(ok.every((h) => h.status === "ok" && h.failStreak === 0 && h.lastOkAt === TEST_NOW_ISO && h.count > 0 && h.error === undefined));

    const byId = new Map(out.health.map((h) => [h.sourceId, h]));
    // An empty-but-valid feed is "empty", never OK; a 403 bot wall is "http" and is never parsed.
    assert.deepEqual(pick(byId.get("nist-ai-news")), { ok: false, status: "failing", error: "empty", count: 0, failStreak: 1, httpStatus: undefined });
    assert.deepEqual(pick(byId.get("data-center-dynamics")), { ok: false, status: "failing", error: "http", count: 0, failStreak: 1, httpStatus: 403 });
    const dead = out.health.filter((h) => !h.ok && !["nist-ai-news", "data-center-dynamics"].includes(h.sourceId));
    assert.equal(dead.length, 207 - 12 - 2);
    assert.ok(dead.every((h) => h.error === "network" && h.status === "failing" && h.count === 0 && h.lastOkAt === null && h.detail));

    // Items: all from OK sources, absolute http(s) links, non-empty capped titles, counts match health.
    const counts = new Map<string, number>();
    for (const item of out.items) {
      counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
      assert.ok(isHttpUrl(item.link), item.link);
      assert.ok(item.title.length > 0 && item.title.length <= 500);
      assert.equal(item.carried, undefined);
    }
    assert.deepEqual([...counts.keys()].sort(), [...expectedOk].sort());
    for (const h of ok) assert.equal(counts.get(h.sourceId), h.count, h.sourceId);
    assert.deepEqual(
      Object.fromEntries(expectedOk.map((id) => [id, counts.get(id)])),
      {
        "wired-ai": 10,
        "quanta-magazine-ai": 5,
        "the-verge-ai": 10,
        "nature-machine-intelligence": 8,
        "langchain-ai-langchain": 10,
        "ggml-org-llama-cpp": 10,
        "hn-ai-150-points": 15, // 20 in the feed, newest 15 by date
        "gn-ai-x-sec-finra": 15, // 29 in the feed, newest 15 by date
        "anthropic-news": 15,
        "anthropic-research": 10,
        "uk-aisi-blog": 10,
        "gray-swan": 8,
      },
    );
    assert.equal(out.items.length, 126);

    // Scraped items carry dates (V1: Anthropic dead, AISI / Gray Swan undated).
    for (const id of ["anthropic-news", "anthropic-research", "uk-aisi-blog"]) assert.ok(out.items.filter((i) => i.sourceId === id).every((i) => i.publishedRaw !== null), id);
    // Gray Swan has one card without a date field; this registry says dateHint "none", so it is kept (undated).
    assert.equal(out.items.filter((i) => i.sourceId === "gray-swan" && i.publishedRaw !== null).length, 7);

    // State for the next build: a last-good snapshot per OK source, nothing for failed ones.
    assert.deepEqual(Object.keys(out.lastGood).sort(), [...expectedOk].sort());
    assert.ok(Object.values(out.lastGood).every((lg) => lg.fetchedAt === TEST_NOW_ISO && lg.items.length > 0));
    assert.equal(out.signals.hn.byUrl.size, 0, "HN endpoints are down in this run: empty index, no failure");
    assert.deepEqual(out.resolvedUrls, {});

    assert.ok(clock.now() < INGEST_DEFAULTS.deadlineMs + INGEST_DEFAULTS.resolveBudgetMs, `virtual run time ${clock.now()} ms`);
    assert.ok(logs.some((l) => /Ingest done: 12\/207 sources OK/.test(l)));
    assert.ok(net.calls.length > 207);
  });

  it("the stage export has the contract signature and resolves with the same shape", async () => {
    const tiny = makeRegistry([srcA]);
    const out = await ingest(tiny, createTestContext({ fetch: fakeFetch({}) as typeof fetch, env: {} }));
    assert.deepEqual(Object.keys(out).sort(), ["health", "items", "lastGood", "resolvedUrls", "signals"]);
    assert.equal(out.health.length, 1);
    assert.equal(out.health[0].ok, false);
  });

  function pick(h: IngestOutput["health"][number] | undefined): Record<string, unknown> {
    return { ok: h?.ok, status: h?.status, error: h?.error, count: h?.count, failStreak: h?.failStreak, httpStatus: h?.httpStatus };
  }
});

describe("ingest: per-source behaviour", () => {
  it("paused sources are not fetched and have no health row", async () => {
    const paused = makeSource({ id: "paused", url: "https://paused.example.com/feed", status: "paused" });
    const net = routedFetch({ [FEED_A]: rss([{ title: "One", link: "https://a.example.com/1", hoursAgo: 1 }]) });
    const { out } = await run(makeRegistry([srcA, paused]), net.fetch);
    assert.deepEqual(out.health.map((h) => h.sourceId), ["src-a"]);
    assert.equal(net.to("https://paused.example.com/feed").length, 0);
  });

  it("takes the newest N by date honouring source.maxItems; release feeds are passed through whole", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Post ${i + 1}`, link: `https://a.example.com/${i + 1}`, hoursAgo: 12 - i })); // oldest first
    const capped = makeSource({ id: "capped", url: FEED_A, maxItems: 3 });
    const releases = makeSource({ id: "rel", url: "https://github.com/ggml-org/llama.cpp/releases.atom", kind: "github-release", maxItems: 3 });
    const net = routedFetch({ [FEED_A]: rss(many), [releases.url]: readFeedFixture("github-releases-llama-cpp-entity-heavy.atom") });
    const { out } = await run(makeRegistry([capped, releases]), net.fetch);
    assert.deepEqual(out.items.filter((i) => i.sourceId === "capped").map((i) => i.title), ["Post 12", "Post 11", "Post 10"]);
    const rel = out.items.filter((i) => i.sourceId === "rel");
    assert.equal(rel.length, 10, "normalize needs every release entry to pick the stable one");
    assert.ok(rel.every((i) => /\/releases\/tag\//.test(i.link) && i.guid && !/released$/.test(i.title)));
  });

  it("one hostile or broken source never takes the run down", async () => {
    const hostile = `<rss><channel>
      <item><title>&amp;#x110000; &#x110000;</title><link>https://h.example.com/1</link><pubDate>99999999999999999 days ago</pubDate></item>
      <item><title>XSS</title><link>javascript:alert(document.cookie)</link></item>
      <item><title>Good one</title><link>/relative/ok</link></item></channel></rss>`;
    const sources = [
      makeSource({ id: "hostile", url: "https://h.example.com/feed" }),
      makeSource({ id: "garbage", url: "https://g.example.com/feed" }),
      makeSource({ id: "html", url: "https://w.example.com/feed" }),
      makeSource({ id: "throws", url: "https://t.example.com/feed" }),
      makeSource({ id: "scrape-no-config", url: "https://s.example.com/blog", kind: "scrape" }),
      makeSource({ id: "huge", url: "https://big.example.com/feed" }),
      srcA,
    ];
    const net = scriptedFetch((req): Reply => {
      if (req.url === "https://h.example.com/feed") return hostile;
      if (req.url === "https://g.example.com/feed") return "\u0000\u0001<<<]]>&&&";
      if (req.url === "https://w.example.com/feed") return respond("<!doctype html><html><body>Just a moment...</body></html>", 200, { "content-type": "application/xml" });
      if (req.url === "https://s.example.com/blog") return "<html><body><a href='/blog/x'><h2>X</h2></a></body></html>";
      if (req.url === "https://big.example.com/feed") return respond("x", 200, { "content-length": String(PIPELINE.maxBodyBytes * 4) });
      if (req.url === FEED_A) return rss([{ title: "Fine", link: "https://a.example.com/fine", hoursAgo: 2 }]);
      throw new RangeError("synchronous explosion inside fetch");
    });
    const { out } = await run(makeRegistry(sources), net.fetch);
    const by = new Map(out.health.map((h) => [h.sourceId, h]));
    assert.equal(out.health.length, 7);
    assert.deepEqual([by.get("hostile")?.ok, by.get("hostile")?.count, by.get("hostile")?.skippedItems], [true, 2, 1]);
    assert.equal(by.get("garbage")?.error, "not_feed");
    assert.equal(by.get("html")?.error, "not_feed");
    assert.equal(by.get("throws")?.error, "network");
    assert.equal(by.get("scrape-no-config")?.error, "parse");
    assert.equal(by.get("huge")?.error, "too_large");
    assert.equal(by.get("src-a")?.ok, true);
    assert.deepEqual(out.items.map((i) => i.link).sort(), ["https://a.example.com/fine", "https://h.example.com/1", "https://h.example.com/relative/ok"]);
  });

  it("9 / 11c. an ISO-8859-1 feed and an RSS feed served as text/html both come through intact", async () => {
    const latin = makeSource({ id: "latin", url: "https://l.example.com/feed" });
    const mislabeled = makeSource({ id: "mislabeled", url: "https://m.example.com/feed" });
    const ascii = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
    // "Café déjà vu – “IA”" in windows-1252 / ISO-8859-1 bytes, declared only in the XML prolog.
    const body = new Uint8Array([...ascii('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Caf'), 0xe9, ...ascii(" d"), 0xe9, ...ascii("j"), 0xe0, ...ascii(" vu "), 0x96, 0x20, 0x93, ...ascii("IA"), 0x94, ...ascii("</title><link>https://l.example.com/1</link></item></channel></rss>")]);
    const net = scriptedFetch((req) => (req.url === latin.url ? respond(body, 200, { "content-type": "application/rss+xml" }) : respond(rss([{ title: "Still a feed", link: "https://m.example.com/1", hoursAgo: 1 }]), 200, { "content-type": "text/html; charset=utf-8" })));
    const { out } = await run(makeRegistry([latin, mislabeled]), net.fetch);
    assert.deepEqual(out.items.map((i) => i.title), ["Café déjà vu – “IA”", "Still a feed"]);
    assert.ok(out.health.every((h) => h.ok));
  });

  it("a scrape page without matching links is 'no_cards'; a JSON API source is extracted by config", async () => {
    const scrape = makeSource({ id: "lab", url: "https://lab.example.com/news", kind: "scrape", scrape: { base: "https://lab.example.com", linkPattern: "/news/[a-z0-9-]+", dateHint: "time" } });
    const api = makeSource({ id: "hub", url: "https://hub.example.com/api/models", kind: "json", maxItems: 2, jsonApi: { itemsPath: "", titleField: "id", urlTemplate: "https://hub.example.com/{id}", dateField: "createdAt" } });
    const net = routedFetch({
      [scrape.url]: "<html><body><a href='/about'>About</a></body></html>",
      [api.url]: JSON.stringify([{ id: "org/a", createdAt: hoursAgo(30) }, { id: "org/b", createdAt: hoursAgo(1) }, { id: "org/c", createdAt: hoursAgo(5) }]),
    });
    const { out } = await run(makeRegistry([scrape, api]), net.fetch);
    assert.deepEqual([out.health[0].ok, out.health[0].error], [false, "no_cards"]);
    assert.deepEqual(out.items.map((i) => [i.sourceId, i.title, i.link]), [["hub", "org/b", "https://hub.example.com/org/b"], ["hub", "org/c", "https://hub.example.com/org/c"]]);
    assert.match(net.to(api.url)[0].headers.accept, /^application\/json/);
    assert.match(net.to(scrape.url)[0].headers.accept, /^text\/html/);
  });

  it("does not mutate ctx.state (frozen) and is deterministic for the same inputs", async () => {
    const st = state({ health: { "src-a": health() }, lastGood: { "src-a": { fetchedAt: hoursAgo(1), items: [makeItem({ sourceId: "src-a" })] } } });
    const reply = rss([{ title: "One", link: "https://a.example.com/1", hoursAgo: 1 }]);
    const a = await run(makeRegistry([srcA]), routedFetch({ [FEED_A]: reply }).fetch, st);
    const b = await run(makeRegistry([srcA]), routedFetch({ [FEED_A]: reply }).fetch, st);
    assert.deepEqual(a.out.items, b.out.items);
    assert.deepEqual(a.out.health.map(({ ms: _ms, ...h }) => h), b.out.health.map(({ ms: _ms, ...h }) => h));
  });
});

describe("ingest: conditional GET (304)", () => {
  const cached: RawItem[] = [makeItem({ sourceId: "src-a", title: "Cached 1", link: "https://a.example.com/c1" }), makeItem({ sourceId: "src-a", title: "Cached 2", link: "https://a.example.com/c2" })];
  const lastGood: LastGood = { fetchedAt: hoursAgo(0.5), bodyAt: hoursAgo(3), items: cached, etag: 'W/"v1"', lastModified: "Thu, 19 Nov 2026 18:00:00 GMT" };

  it("a healthy source is asked with its validators; a 304 reuses the cached items and counts as OK", async () => {
    const net = scriptedFetch((req) => (req.headers["if-none-match"] === 'W/"v1"' ? respond(null, 304) : "<rss/>"));
    const { out } = await run(makeRegistry([srcA]), net.fetch, state({ health: { "src-a": health() }, lastGood: { "src-a": lastGood } }));
    assert.equal(net.requests.length, 1);
    assert.equal(net.requests[0].headers["if-modified-since"], "Thu, 19 Nov 2026 18:00:00 GMT");
    assert.deepEqual(out.health[0], { sourceId: "src-a", ok: true, status: "ok", count: 2, ms: 0, failStreak: 0, lastOkAt: TEST_NOW_ISO, attempts: 1, notModified: true });
    assert.deepEqual(out.items.map((i) => i.title), ["Cached 1", "Cached 2"]);
    assert.ok(out.items.every((i) => i.carried === undefined), "a 304 is fresh, not carried");
    // The snapshot is renewed, the validators and the time of the last full download are kept.
    assert.deepEqual(out.lastGood["src-a"], { fetchedAt: TEST_NOW_ISO, items: cached, bodyAt: hoursAgo(3), etag: 'W/"v1"', lastModified: "Thu, 19 Nov 2026 18:00:00 GMT" });
  });

  it("a 200 replaces the snapshot and stores the new validators", async () => {
    const net = scriptedFetch(() => respond(rss([{ title: "New", link: "https://a.example.com/new", hoursAgo: 1 }]), 200, { etag: 'W/"v2"', "last-modified": "Thu, 19 Nov 2026 20:30:00 GMT" }));
    const { out } = await run(makeRegistry([srcA]), net.fetch, state({ health: { "src-a": health() }, lastGood: { "src-a": lastGood } }));
    assert.equal(net.requests[0].headers["if-none-match"], 'W/"v1"');
    assert.deepEqual(out.items.map((i) => i.title), ["New"]);
    const lg = out.lastGood["src-a"];
    assert.deepEqual([lg.etag, lg.lastModified, lg.bodyAt, lg.fetchedAt, lg.items.length], ['W/"v2"', "Thu, 19 Nov 2026 20:30:00 GMT", TEST_NOW_ISO, TEST_NOW_ISO, 1]);
  });

  it("no validators are sent after a failure or when the last full fetch is over 24 h old", async () => {
    const stale: LastGood = { ...lastGood, bodyAt: hoursAgo(25) };
    for (const st of [state({ health: { "src-a": health({ failStreak: 1 }) }, lastGood: { "src-a": lastGood } }), state({ health: { "src-a": health() }, lastGood: { "src-a": stale } })]) {
      const net = scriptedFetch(() => rss([{ title: "Full", link: "https://a.example.com/full", hoursAgo: 1 }]));
      const { out } = await run(makeRegistry([srcA]), net.fetch, st);
      assert.equal(net.requests[0].headers["if-none-match"], undefined);
      assert.equal(net.requests[0].headers["if-modified-since"], undefined);
      assert.equal(out.health[0].ok, true);
    }
  });
});

describe("ingest: carry-forward", () => {
  const items: RawItem[] = [makeItem({ sourceId: "src-a", title: "Last good 1" }), makeItem({ sourceId: "src-a", title: "Last good 2" }), makeItem({ sourceId: "src-a", title: "Last good 3" })];

  it("a failing source carries its last-good items (<= 6 h old), flagged, and is NOT ok", async () => {
    const net = scriptedFetch(() => respond("down", 503));
    const st = state({ health: { "src-a": health({ lastOkAt: hoursAgo(2) }) }, lastGood: { "src-a": { fetchedAt: hoursAgo(2), items } } });
    const { out } = await run(makeRegistry([srcA]), net.fetch, st);
    assert.deepEqual(out.health[0], { sourceId: "src-a", ok: false, status: "carried", count: 3, ms: out.health[0].ms, error: "http", detail: "HTTP 503", failStreak: 1, lastOkAt: hoursAgo(2), attempts: 3, httpStatus: 503 });
    assert.deepEqual(out.items.map((i) => [i.title, i.carried]), [["Last good 1", true], ["Last good 2", true], ["Last good 3", true]]);
    assert.deepEqual(out.lastGood, {}, "a failed run never refreshes the snapshot, so the 6 h limit holds");
  });

  it("after 6 h the items are no longer carried", async () => {
    const net = scriptedFetch(() => respond("down", 503));
    const st = state({ health: { "src-a": health({ failStreak: 12, lastOkAt: hoursAgo(6.5) }) }, lastGood: { "src-a": { fetchedAt: hoursAgo(6.5), items } } });
    const { out } = await run(makeRegistry([srcA]), net.fetch, st);
    assert.deepEqual([out.health[0].status, out.health[0].count, out.health[0].failStreak, out.items.length], ["failing", 0, 13, 0]);
  });

  it("an empty-but-valid feed is carried too, and recovery resets everything", async () => {
    const st = state({ health: { "src-a": health({ lastOkAt: hoursAgo(1) }) }, lastGood: { "src-a": { fetchedAt: hoursAgo(1), items } } });
    const empty = await run(makeRegistry([srcA]), scriptedFetch(() => rss([])).fetch, st);
    assert.deepEqual([empty.out.health[0].status, empty.out.health[0].error, empty.out.health[0].count], ["carried", "empty", 3]);

    const recovered = await run(makeRegistry([srcA]), scriptedFetch(() => rss([{ title: "Back", link: "https://a.example.com/back", hoursAgo: 0.2 }])).fetch, state({ health: { "src-a": health({ failStreak: 5, lastError: "HTTP 503", lastErrorClass: "http" }) }, lastGood: st.lastGood }));
    assert.deepEqual([recovered.out.health[0].status, recovered.out.health[0].failStreak, recovered.out.health[0].error], ["ok", 0, undefined]);
    assert.deepEqual(recovered.out.items.map((i) => [i.title, i.carried]), [["Back", undefined]]);
  });
});

describe("ingest: quarantine", () => {
  const dead = (lastAttemptHours: number): SourceHealthState => ({ failStreak: 48, lastOkAt: hoursAgo(80), lastAttemptAt: hoursAgo(lastAttemptHours), lastError: "HTTP 404", lastErrorClass: "http" });

  it("a quarantined source is skipped without any request", async () => {
    const net = scriptedFetch(() => rss([{ title: "Alive", link: "https://a.example.com/alive", hoursAgo: 1 }]));
    const { out } = await run(makeRegistry([srcA]), net.fetch, state({ health: { "src-a": dead(2) } }));
    assert.equal(net.requests.length, 0);
    assert.deepEqual(out.health[0], { sourceId: "src-a", ok: false, status: "quarantined", count: 0, ms: 0, error: "skipped", detail: "HTTP 404", failStreak: 48, lastOkAt: hoursAgo(80), attempts: 0 });
    assert.deepEqual(out.items, []);
  });

  it("once a day it is probed with a single attempt: still dead stays quarantined", async () => {
    const net = scriptedFetch(() => respond("gone", 500));
    const { out } = await run(makeRegistry([srcA]), net.fetch, state({ health: { "src-a": dead(24.5) } }));
    assert.equal(net.requests.length, 1, "a probe does not retry");
    assert.deepEqual([out.health[0].status, out.health[0].error, out.health[0].failStreak, out.health[0].attempts], ["quarantined", "http", 49, 1]);
  });

  it("a successful probe brings the source back", async () => {
    const net = scriptedFetch(() => rss([{ title: "Alive", link: "https://a.example.com/alive", hoursAgo: 1 }]));
    const { out } = await run(makeRegistry([srcA]), net.fetch, state({ health: { "src-a": dead(30) } }));
    assert.deepEqual([out.health[0].status, out.health[0].ok, out.health[0].failStreak, out.items.length], ["ok", true, 0, 1]);
    assert.ok(out.lastGood["src-a"]);
  });
});

describe("ingest: wrappers and signals", () => {
  const gnFeed = "https://news.google.com/rss/search?q=ai";
  const wrap = (id: string): string => `https://news.google.com/rss/articles/${id}?oc=5`;
  const gnBody = `<rss><channel>
    <item><title>Regulator fines broker over AI claims - Reuters</title><link>${wrap("CBMiCached")}</link><guid isPermaLink="false">CBMiCached</guid><pubDate>${new Date(NOW.getTime() - 3_600_000).toUTCString()}</pubDate><source url="https://www.reuters.com">Reuters</source></item>
    <item><title>Lab ships new model - The Example Times</title><link>${wrap("CBMiFresh")}</link><pubDate>${new Date(NOW.getTime() - 7_200_000).toUTCString()}</pubDate><source url="https://times.example.com">The Example Times</source></item>
    <item><title>Unresolvable story - Outlet</title><link>${wrap("CBMiStuck")}</link><pubDate>${new Date(NOW.getTime() - 9_000_000).toUTCString()}</pubDate><source url="https://outlet.example.org">Outlet</source></item></channel></rss>`;
  const BATCH = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

  it("Google News: wrappers resolved through the cache and the bounded resolver; outlet name and URL carried", async () => {
    const handler: Handler = (req) => {
      if (req.url === gnFeed) return gnBody;
      if (req.url === wrap("CBMiFresh")) return '<div data-n-a-sg="SIG" data-n-a-ts="1795000000"></div>';
      if (req.url === wrap("CBMiStuck")) return "<html>consent wall</html>";
      if (req.url === BATCH) return `)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://times.example.com/2026/11/19/lab-ships-new-model"])]])}`;
      return new TypeError("unexpected request");
    };
    const net = scriptedFetch(handler);
    const st = state({ resolvedUrls: { [wrapperKey(wrap("CBMiCached"))]: "https://www.reuters.com/legal/regulator-fines-broker-2026-11-19/" } });
    const gn = makeSource({ id: "gn", url: gnFeed, kind: "query" });
    const { out } = await run(makeRegistry([gn]), net.fetch, st);

    assert.deepEqual(
      out.items.map((i) => [i.title, i.link, i.itemPublisher, i.itemPublisherUrl]),
      [
        ["Regulator fines broker over AI claims", "https://www.reuters.com/legal/regulator-fines-broker-2026-11-19/", "Reuters", "https://www.reuters.com"],
        ["Lab ships new model", "https://times.example.com/2026/11/19/lab-ships-new-model", "The Example Times", "https://times.example.com"],
        ["Unresolvable story", wrap("CBMiStuck"), "Outlet", "https://outlet.example.org"],
      ],
    );
    assert.equal(net.to(wrap("CBMiCached")).length, 0, "cached wrappers cost no request");
    assert.deepEqual(out.resolvedUrls, {
      "https://news.google.com/rss/articles/CBMiCached": "https://www.reuters.com/legal/regulator-fines-broker-2026-11-19/",
      "https://news.google.com/rss/articles/CBMiFresh": "https://times.example.com/2026/11/19/lab-ships-new-model",
    });
    // The snapshot stores the RESOLVED links, so a carried item needs no second resolution.
    assert.deepEqual(out.lastGood.gn.items.map((i) => i.link), out.items.map((i) => i.link));
    assert.equal(out.items[1].guid, wrap("CBMiFresh"), "the wrapper stays available as the guid");
    assert.deepEqual(out.items.map((i) => i.resolvedFrom), [wrap("CBMiCached"), wrap("CBMiFresh"), undefined], "a resolved item remembers its wrapper");
  });

  it("Google News: a wrapper left unresolved by an earlier run is resolved on a 304 too", async () => {
    const stuck = { sourceId: "gn", title: "Late resolution", link: wrap("CBMiLate"), publishedRaw: null, summaryHtml: null };
    const net = scriptedFetch((req) => {
      if (req.url === gnFeed) return respond(null, 304);
      if (req.url === wrap("CBMiLate")) return '<div data-n-a-sg="SIG" data-n-a-ts="1795000000"></div>';
      if (req.url === BATCH) return `)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://late.example.com/story"])]])}`;
      return new TypeError("unexpected request");
    });
    const gn = makeSource({ id: "gn", url: gnFeed, kind: "query" });
    const st = state({ health: { gn: health() }, lastGood: { gn: { fetchedAt: hoursAgo(0.5), bodyAt: hoursAgo(1), etag: 'W/"g"', items: [stuck] } } });
    const { out } = await run(makeRegistry([gn]), net.fetch, st);
    assert.equal(out.health[0].notModified, true);
    assert.deepEqual(out.items.map((i) => [i.link, i.resolvedFrom]), [["https://late.example.com/story", wrap("CBMiLate")]]);
    assert.equal(out.lastGood.gn.items[0].link, "https://late.example.com/story");
  });

  it("hnrss: article link kept, HN thread in comments; text posts keep the HN link", async () => {
    const hn = makeSource({ id: "hn", url: "https://hnrss.org/newest?q=AI&points=150", kind: "query" });
    const { out } = await run(makeRegistry([hn]), routedFetch({ [hn.url]: readFeedFixture("hnrss-ai-150.xml") }).fetch);
    assert.equal(out.items.length, 15);
    assert.ok(out.items.every((i) => i.comments?.startsWith("https://news.ycombinator.com/item?id=")));
    assert.ok(out.items.filter((i) => !i.link.includes("news.ycombinator.com")).length >= 10);
  });

  it("Hacker News signal is fetched alongside the feeds, keyed by urlKey, and fails soft", async () => {
    const net = scriptedFetch((req) => {
      if (req.url === FEED_A) return rss([{ title: "One", link: "https://a.example.com/1", hoursAgo: 1 }]);
      if (req.url.includes("search_by_date")) return JSON.stringify({ hits: [{ url: "https://www.a.example.com/1?utm_source=hn", points: 250, num_comments: 90 }] });
      return respond("down", 503);
    });
    const { out } = await run(makeRegistry([srcA]), net.fetch, state(), { skipHn: false });
    assert.deepEqual([...out.signals.hn.byUrl.entries()], [["a.example.com/1", { points: 250, comments: 90 }]]);
    assert.equal(out.health[0].ok, true);
  });
});

describe("ingest: a hung host and the stage deadline (virtual clock)", () => {
  const hungSources = Array.from({ length: 10 }, (_, i) => makeSource({ id: `hung-${i}`, url: `https://hung.example.com/feed-${i}.xml` }));
  const fastSources = Array.from({ length: 30 }, (_, i) => makeSource({ id: `fast-${i}`, url: `https://fast-${i}.example.com/feed.xml` }));
  const handler: Handler = (req) => (req.url.includes("hung.example.com") ? "hang" : rss([{ title: `Item of ${req.url}`, link: `${req.url}/item`, hoursAgo: 1 }]));

  it("a hung host listed FIRST starves nobody, and the breaker stops asking it", async () => {
    const net = scriptedFetch(handler);
    const { out, clock } = await run(makeRegistry([...hungSources, ...fastSources]), net.fetch);
    const fast = out.health.filter((h) => h.sourceId.startsWith("fast-"));
    const hung = out.health.filter((h) => h.sourceId.startsWith("hung-"));
    assert.ok(fast.every((h) => h.ok), "every healthy source is OK");
    assert.ok(hung.every((h) => !h.ok && h.error === "timeout" && h.status === "failing"));
    assert.equal(out.items.length, 30);
    // 10 feeds x (8 s + 16 s) would be 240 s unbounded / 120 s at 2 per host; the breaker ends it after the first pair's two attempts (8 s, backoff, 16 s).
    assert.ok(clock.now() < 26_000, `run took ${clock.now()} virtual ms`);
    assert.ok(net.requests.filter((r) => r.url.includes("hung.example.com")).length <= 4, "at most 4 requests ever reach the hung host");
  });

  it("without the breaker the stage deadline still ends the run and reports timeouts", async () => {
    // Every source on its own hung host: the breaker cannot help, only the deadline can.
    const lonely = Array.from({ length: 6 }, (_, i) => makeSource({ id: `lonely-${i}`, url: `https://hung-${i}.example.net/feed.xml` }));
    const net = scriptedFetch((req) => (req.url.includes("example.net") ? "hang" : rss([{ title: "ok", link: `${req.url}/1`, hoursAgo: 1 }])));
    const { out, clock } = await run(makeRegistry([...lonely, ...fastSources.slice(0, 5)]), net.fetch, state(), { deadlineMs: 10_000 });
    assert.equal(clock.now(), 10_000);
    assert.ok(out.health.filter((h) => h.sourceId.startsWith("lonely-")).every((h) => h.error === "timeout"));
    assert.equal(out.health.filter((h) => h.ok).length, 5);
  });
});

describe("ingest: slow-but-alive sources (PF-6, virtual clock)", () => {
  const slowUrl = "https://feeds.slow.example.com/rss/technology";
  const slow = makeSource({ id: "slow-post", url: slowUrl });
  const hung = makeSource({ id: "hung", url: "https://hung.example.net/feed/" });
  const body = rss([{ title: "Slow but alive", link: "https://slow.example.com/1", hoursAgo: 1 }]);
  /** Answers after `ms` of virtual time (the Washington Post feed: 9.1-10.2 s to first byte). */
  const after = (clock: VirtualClock, ms: number, reply: string) => async (): Promise<Reply> => {
    await sleep(clock, ms);
    return reply;
  };

  async function runWith(registry: Registry, make: (clock: VirtualClock) => Handler, st: PipelineState = state()): Promise<{ out: IngestOutput; clock: VirtualClock; requests: number }> {
    const clock = createVirtualClock();
    const net = scriptedFetch(make(clock));
    const ctx = createTestContext({ fetch: net.fetch, state: st });
    const out = await clock.settle(runIngest(registry, ctx, { timers: clock, skipHn: true }));
    return { out, clock, requests: net.requests.length };
  }

  it("a source answering after 9.1 s ends OK on its second attempt; one that never answers ends 'timeout' after two, under 26 s in all", async () => {
    const { out, clock } = await runWith(makeRegistry([slow, hung, srcA]), (c) => (req) => {
      if (req.url === slowUrl) return after(c, 9_100, body)();
      if (req.url === FEED_A) return rss([{ title: "Fast", link: "https://a.example.com/fast", hoursAgo: 1 }]);
      return "hang";
    });
    const by = new Map(out.health.map((h) => [h.sourceId, h]));
    assert.deepEqual([by.get("slow-post")?.ok, by.get("slow-post")?.attempts, by.get("slow-post")?.count], [true, 2, 1]);
    assert.deepEqual([by.get("hung")?.error, by.get("hung")?.attempts, by.get("hung")?.detail], ["timeout", 2, "timeout after 16000 ms"]);
    assert.equal(by.get("src-a")?.ok, true);
    assert.ok(clock.now() < 26_000, `virtual ingest duration ${clock.now()} ms`);
    assert.deepEqual(out.items.map((i) => i.title).sort(), ["Fast", "Slow but alive"]);
  });

  it("a quarantine probe is one attempt with the long header timeout, so a slow source can leave quarantine", async () => {
    const quarantined: SourceHealthState = { failStreak: 60, lastOkAt: null, lastAttemptAt: hoursAgo(25), lastError: "timeout after 8000 ms", lastErrorClass: "timeout" };
    const back = await runWith(makeRegistry([slow]), (c) => after(c, 10_200, body), state({ health: { "slow-post": quarantined } }));
    assert.deepEqual([back.out.health[0].status, back.out.health[0].ok, back.out.health[0].attempts, back.out.health[0].failStreak, back.requests], ["ok", true, 1, 0, 1]);

    const dead = await runWith(makeRegistry([slow]), () => () => "hang", state({ health: { "slow-post": quarantined } }));
    assert.deepEqual([dead.out.health[0].status, dead.out.health[0].attempts, dead.out.health[0].detail, dead.requests], ["quarantined", 1, "timeout after 16000 ms", 1]);
    assert.equal(dead.clock.now(), HTTP_DEFAULTS.retryHeaderTimeoutMs);
  });

  it("sourceRequest carries no timeout / attempt overrides (HTTP_DEFAULTS is the one policy), except for a probe", () => {
    const feed = resolveSource(slow);
    assert.deepEqual(Object.keys(sourceRequest(feed)).sort(), ["accept", "url"]);
    assert.deepEqual(sourceRequest(feed, { probe: false, conditional: { etag: 'W/"x"' } }), { url: slowUrl, accept: sourceRequest(feed).accept, etag: 'W/"x"' });
    const probe = sourceRequest(feed, { probe: true, conditional: null });
    assert.deepEqual([probe.attempts, probe.headerTimeoutMs], [1, 16_000]);
    assert.match(sourceRequest(resolveSource(makeSource({ kind: "json" }))).accept ?? "", /^application\/json/);
  });
});

describe("ingest: duplicate links inside one feed (REG-10)", () => {
  const row = (title: string, link: string): { title: string; link: string } => ({ title, link });
  const exclude = compileTerms(["(batch)", "(free)"]);

  it("among rows sharing a link, the first one the source's exclude terms do not match is kept", () => {
    const rows = [
      row("Google: Gemini 4 Neon (batch) (google/gemini-4-neon)", "https://or.example.com/google/gemini-4-neon"), // batch first
      row("Google: Gemini 4 Neon (google/gemini-4-neon)", "https://or.example.com/google/gemini-4-neon"),
      row("LiquidAI: LFM3-1.7B (free)", "https://or.example.com/liquid/lfm3"), // free first
      row("LiquidAI: LFM3-1.7B", "https://or.example.com/liquid/lfm3"),
      row("Qwen: Qwen4 Max", "https://or.example.com/qwen/qwen4-max"), // standard first
      row("Qwen: Qwen4 Max (batch)", "https://or.example.com/qwen/qwen4-max"),
      row("inclusionAI: Ling 3.2 Flash (free)", "https://or.example.com/inclusionai/ling"), // every row excluded: first one stays
      row("inclusionAI: Ling 3.2 Flash (free) (batch)", "https://or.example.com/inclusionai/ling"),
      row("Tencent: Hy4 flash", "https://or.example.com/tencent/hy4-flash"), // no duplicate
    ];
    assert.deepEqual(uniqueByLink(rows, exclude).map((r) => r.title), ["Google: Gemini 4 Neon (google/gemini-4-neon)", "LiquidAI: LFM3-1.7B", "Qwen: Qwen4 Max", "inclusionAI: Ling 3.2 Flash (free)", "Tencent: Hy4 flash"]);
    // Without exclude terms (every other source) the first row wins, exactly as before.
    const first = ["Google: Gemini 4 Neon (batch) (google/gemini-4-neon)", "LiquidAI: LFM3-1.7B (free)", "Qwen: Qwen4 Max", "inclusionAI: Ling 3.2 Flash (free)", "Tencent: Hy4 flash"];
    assert.deepEqual(uniqueByLink(rows).map((r) => r.title), first);
    assert.deepEqual(uniqueByLink(rows, compileTerms([])).map((r) => r.title), first);
  });

  it("an OpenRouter-shaped feed (batch row first, same link, same date) yields the standard rows within maxItems", () => {
    const models = ["Google: Gemini 4 Neon|google/gemini-4-neon", "OpenAI: GPT-6.2 Astra Pro|openai/gpt-6.2-astra-pro", "OpenAI: GPT-6.2 Astra|openai/gpt-6.2-astra", "Tencent: Hy4 flash|tencent/hy4-flash"];
    const feed = rss(
      models.flatMap((m, i) => {
        const [name, slug] = m.split("|");
        const link = `https://openrouter.example.com/${slug}`;
        return [{ title: `${name} (batch) (${slug})`, link, hoursAgo: i + 1 }, { title: `${name} (${slug})`, link, hoursAgo: i + 1 }];
      }),
    );
    const source = resolveSource(makeSource({ id: "openrouter-new-models", url: "https://openrouter.example.com/api/v1/models?use_rss=true", maxItems: 3, exclude: ["(batch)", "(free)"] }));
    const outcome = extractItems(source, feed, source.url, NOW.getTime());
    assert.ok(outcome.kind === "items");
    assert.deepEqual(outcome.items.map((i) => i.title), ["Google: Gemini 4 Neon (google/gemini-4-neon)", "OpenAI: GPT-6.2 Astra Pro (openai/gpt-6.2-astra-pro)", "OpenAI: GPT-6.2 Astra (openai/gpt-6.2-astra)"]);
    assert.ok(outcome.items.every((i) => exclude(i.title) === null), "nothing left for the exclude list to throw away");

    // The same feed for a source with no exclude terms keeps the first row per link (unchanged behaviour).
    const plain = extractItems(resolveSource(makeSource({ id: "plain", maxItems: 3 })), feed, source.url, NOW.getTime());
    assert.ok(plain.kind === "items" && plain.items.every((i) => i.title.includes("(batch)")));
  });
});

describe("ingest: Techmeme items point at the article (PF-7)", () => {
  const techmeme = makeSource({ id: "techmeme", url: "https://www.techmeme.com/feed.xml", kind: "aggregator" });
  // Two real items of 2026-11-19: author + outlet, and outlet only.
  const forbesUrl = "https://www.forbes.com/sites/richardnieva/2026/11/19/the-big-vc-winners-in-anthropics-ipo/";
  const infoUrl = "https://www.theinformation.com/articles/nvidia-nears-acquisition-diffusion-ai-developer-500-million";
  const desc = (n: number, article: string, byline: string, headline: string): string =>
    `<A HREF="${article}"><IMG VSPACE="4" HSPACE="4" BORDER="0" ALIGN="RIGHT" SRC="http://www.techmeme.com/261119/i${n}.jpg"></A>\n<P><A HREF="https://www.techmeme.com/261119/p${n}#a261119p${n}" TITLE="Techmeme permalink"><IMG WIDTH=11 HEIGHT=12 SRC="http://www.techmeme.com/img/pml.png" STYLE="border:none;padding:0;margin:0;"></A> ${byline}:<BR>\n<SPAN STYLE="font-size:1.3em;"><B><A HREF="${article}">${headline}</A></B></SPAN>&nbsp; &mdash;&nbsp; As the AI giant goes public &hellip; </P>`;
  const iconiqTitle = "Source: Iconiq invested more than $6B in Anthropic; its estimated 1.8% stake was worth ~$31.8B at Thursday's close, a 430%+ return on investment";
  const nvidiaTitle = "Sources: Nvidia is in advanced talks to acquire diffusion LLM developer Inception for $500M+ plus earnouts; talks began before Jensen Huang's resignation";
  const rawIconiq: RawItem = { sourceId: "techmeme", title: `${iconiqTitle} (Richard Nieva/Forbes)`, link: "https://www.techmeme.com/261119/p56#a261119p56", publishedRaw: "Thu, 19 Nov 2026 19:50:59 -0500", summaryHtml: desc(56, forbesUrl, 'Richard Nieva / <A HREF="http://www.forbes.com/">Forbes</A>', iconiqTitle) };
  const rawNvidia: RawItem = { sourceId: "techmeme", title: `${nvidiaTitle} (The Information)`, link: "https://www.techmeme.com/261119/p54#a261119p54", publishedRaw: "Thu, 19 Nov 2026 18:00:01 -0500", summaryHtml: desc(54, infoUrl, '<A HREF="https://www.theinformation.com/">The Information</A>', nvidiaTitle) };
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Techmeme</title>${[rawIconiq, rawNvidia]
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.publishedRaw}</pubDate><description><![CDATA[${i.summaryHtml}]]></description></item>`)
    .join("")}</channel></rss>`;
  const want = [
    [iconiqTitle, forbesUrl, "Forbes", "http://www.forbes.com/", "https://www.techmeme.com/261119/p56#a261119p56"],
    [nvidiaTitle, infoUrl, "The Information", "https://www.theinformation.com/", "https://www.techmeme.com/261119/p54#a261119p54"],
  ];
  const shape = (items: RawItem[]): unknown[] => items.map((i) => [i.title, i.link, i.itemPublisher, i.itemPublisherUrl, i.resolvedFrom]);

  it("a fresh fetch: article link, outlet as item publisher, tail gone, permalink kept as the earlier identity", async () => {
    const { out } = await run(makeRegistry([techmeme]), routedFetch({ [techmeme.url]: feed }).fetch);
    assert.deepEqual(shape(out.items), want);
    assert.ok(out.items.every((i) => i.carried === undefined && i.summaryHtml?.includes("Techmeme permalink")), "the description is left as it was");
    assert.deepEqual(shape(out.lastGood.techmeme.items), want, "the snapshot holds the rewritten items");
  });

  it("a 304 reuses a snapshot written BEFORE this fix (permalinks, tails) and still publishes article links", async () => {
    const st = state({ health: { techmeme: health() }, lastGood: { techmeme: { fetchedAt: hoursAgo(0.5), bodyAt: hoursAgo(1), etag: 'W/"tm"', items: [rawIconiq, rawNvidia] } } });
    const net = scriptedFetch((req) => (req.headers["if-none-match"] === 'W/"tm"' ? respond(null, 304) : "<rss/>"));
    const { out } = await run(makeRegistry([techmeme]), net.fetch, st);
    assert.equal(out.health[0].notModified, true);
    assert.deepEqual(shape(out.items), want);
    // ... and the upgraded snapshot passes through the next 304 unchanged (idempotent).
    const again = await run(makeRegistry([techmeme]), net.fetch, state({ health: { techmeme: health() }, lastGood: { techmeme: { ...out.lastGood.techmeme, fetchedAt: hoursAgo(0.5) } } }));
    assert.deepEqual(again.out.items, out.items);
  });

  it("carried items of a failing Techmeme fetch are rewritten too", async () => {
    const st = state({ health: { techmeme: health({ lastOkAt: hoursAgo(1) }) }, lastGood: { techmeme: { fetchedAt: hoursAgo(1), items: [rawIconiq] } } });
    const { out } = await run(makeRegistry([techmeme]), scriptedFetch(() => respond("down", 503)).fetch, st);
    assert.equal(out.health[0].status, "carried");
    assert.deepEqual(out.items.map((i) => [i.title, i.link, i.itemPublisher, i.carried]), [[iconiqTitle, forbesUrl, "Forbes", true]]);
  });
});

describe("ingest: hostile sources (SEC-3, SEC-4)", () => {
  it("links into private networks never become items (feed, scrape page, JSON API)", async () => {
    const feed = makeSource({ id: "feed", url: "https://f.example.com/feed" });
    const page = makeSource({ id: "page", url: "https://lab.example.com/news", kind: "scrape", scrape: { base: "https://lab.example.com", linkPattern: "/news/[a-z0-9-]+" } });
    const api = makeSource({ id: "api", url: "https://hub.example.com/api", kind: "json", jsonApi: { itemsPath: "", titleField: "t", urlField: "u" } });
    const internal = ["http://intranet.corp.local/ir/2026-11", "http://169.254.169.254/latest/meta-data/", "http://[::1]/x", "https://127.0.0.1/x", "http://wiki/Home", "http://10.1.2.3:8080/jenkins"];
    const net = routedFetch({
      [feed.url]: rss([...internal.map((link, i) => ({ title: `INTERNAL ${i}`, link, hoursAgo: 1 })), { title: "Public", link: "https://f.example.com/public", hoursAgo: 2 }]),
      [page.url]: `<html><body><a href="http://10.0.0.7/news/internal-draft"><h2>Internal draft of the quarter</h2></a><a href="/news/public-post"><h2>Public post of the lab</h2></a></body></html>`,
      [api.url]: JSON.stringify([{ t: "Internal", u: "http://db.internal/item/1" }, { t: "Public", u: "https://hub.example.com/item/2" }]),
    });
    const { out } = await run(makeRegistry([feed, page, api]), net.fetch);
    assert.deepEqual(out.items.map((i) => i.link).sort(), ["https://f.example.com/public", "https://hub.example.com/item/2", "https://lab.example.com/news/public-post"]);
    assert.deepEqual(out.health.map((h) => [h.ok, h.count, h.skippedItems]), [[true, 1, 6], [true, 1, out.health[1].skippedItems], [true, 1, 1]]);
  });

  it("a failure detail is one line, so a body cannot write its own log lines (GitHub Actions '::error::')", async () => {
    const api = makeSource({ id: "api", url: "https://hub.example.com/api", kind: "json", jsonApi: { itemsPath: "", titleField: "t", urlField: "u" } });
    const jsonFeed = makeSource({ id: "jsonfeed", url: "https://j.example.com/feed.json" });
    const hostile = "[\n::error::PWNED\n";
    const { out, logs } = await run(makeRegistry([api, jsonFeed]), routedFetch({ [api.url]: hostile, [jsonFeed.url]: hostile }).fetch);
    for (const h of out.health) {
      assert.equal(h.error, "parse", h.sourceId);
      assert.ok(h.detail && !/[\r\n\u0000-\u001f]/.test(h.detail) && h.detail.length <= 240, JSON.stringify(h.detail));
    }
    assert.ok(logs.every((l) => !/[\r\n]/.test(l)), "every log message is a single line");
    assert.ok(logs.some((l) => /FAIL\s+api\s+parse: invalid JSON/.test(l)));
  });
});

describe("ingest: host backoff (5xx / 429 from one host; the hnrss.org pattern of 2026-11-20)", () => {
  // Eleven queries on one fragile host (one at a time, 1 s apart), in registry order: the first six
  // are answered, the last five get 502 - exactly what both live builds of 2026-11-20 saw.
  const HOST = "https://hnrss.org/newest?q=";
  const names = ["frontier", "ai", "llm", "local", "claude", "agent", "llamacpp", "qwen", "weights", "vllm", "studio"];
  const sources = names.map((n) => makeSource({ id: `hn-${n}`, url: `${HOST}${n}`, kind: "query" }));
  const other = makeSource({ id: "elsewhere", url: "https://other.example.org/feed.xml" });
  const failing = new Set(names.slice(6));
  const body = (n: string): string => rss([{ title: `Thread ${n}`, link: `https://thread.example.com/${n}`, hoursAgo: 1 }]);
  const lastGoodFor = (ids: readonly string[], ageHours = 1): PipelineState["lastGood"] =>
    Object.fromEntries(ids.map((id) => [id, { fetchedAt: hoursAgo(ageHours), items: [makeItem({ sourceId: id, title: `Kept ${id} 1` }), makeItem({ sourceId: id, title: `Kept ${id} 2` })] } satisfies LastGood]));
  const healthFor = (ids: readonly string[]): PipelineState["health"] => Object.fromEntries(ids.map((id) => [id, health({ lastOkAt: hoursAgo(1), lastAttemptAt: hoursAgo(0.5) })]));
  const handler: Handler = (req) => {
    if (req.url === other.url) return rss([{ title: "Elsewhere", link: "https://other.example.org/1", hoursAgo: 1 }]);
    const n = req.url.slice(HOST.length);
    return failing.has(n) ? respond("Bad Gateway", 502) : body(n);
  };
  const ids = sources.map((s) => s.id);
  const st = state({ health: healthFor(ids), lastGood: lastGoodFor(ids) });
  const pick = (h: IngestOutput["health"][number] | undefined): Record<string, unknown> => ({ ok: h?.ok, status: h?.status, error: h?.error, count: h?.count, failStreak: h?.failStreak, httpStatus: h?.httpStatus });

  it("after two sources in a row end in 502 the host is left alone: the rest are carried forward with a health note", async () => {
    const net = scriptedFetch(handler);
    const { out, logs } = await run(makeRegistry([...sources, other]), net.fetch, st);
    const by = new Map(out.health.map((h) => [h.sourceId, h]));

    for (const n of names.slice(0, 6)) assert.equal(by.get(`hn-${n}`)?.status, "ok", n);
    // The two that were asked and failed: ordinary failures, three attempts each, their own streak grows.
    for (const n of ["llamacpp", "qwen"]) {
      assert.deepEqual(pick(by.get(`hn-${n}`)), { ok: false, status: "carried", error: "http", count: 2, failStreak: 1, httpStatus: 502 }, n);
      assert.equal(by.get(`hn-${n}`)?.attempts, 3);
    }
    // The three behind them were NOT asked.
    for (const n of ["weights", "vllm", "studio"]) {
      const h = by.get(`hn-${n}`);
      assert.deepEqual(pick(h), { ok: false, status: "carried", error: "skipped", count: 2, failStreak: 0, httpStatus: undefined }, n);
      assert.equal(h?.attempts, 0);
      assert.equal(h?.detail, "host backoff: hnrss.org answered HTTP 502 to 2 requests in a row; not requested this run, 2 last-good items carried");
      assert.equal(h?.lastOkAt, hoursAgo(1));
      assert.equal(net.to(`${HOST}${n}`).length, 0, `${n} must not be requested`);
    }
    assert.equal(net.requests.filter((r) => r.url.startsWith(HOST)).length, 6 + 3 + 3, "12 requests instead of 6 + 5 x 3 = 21");
    assert.equal(by.get("elsewhere")?.ok, true, "other hosts are not affected");

    // Carried items are published, flagged; nothing of the skipped sources is written as a fresh snapshot.
    for (const n of ["qwen", "weights", "studio"]) assert.deepEqual(out.items.filter((i) => i.sourceId === `hn-${n}`).map((i) => i.carried), [true, true], n);
    assert.deepEqual(Object.keys(out.lastGood).sort(), [...names.slice(0, 6).map((n) => `hn-${n}`), "elsewhere"].sort());
    assert.equal(logs.filter((l) => l.startsWith("Host backoff: hnrss.org answered HTTP 502 to 2 requests in a row")).length, 1);
    assert.ok(logs.some((l) => /^ {2}SKIP {2}hn-studio\s+host backoff: /.test(l)));
    assert.ok(logs.some((l) => /5 carried \(3 not requested: host backoff on hnrss\.org\)/.test(l)));
  });

  it("saves the requests AND the wait: skipped sources do not sit out the host's 1 s gap", async () => {
    const before = await run(makeRegistry(sources), scriptedFetch(handler).fetch, st, { hostBackoffAfter: Number.POSITIVE_INFINITY });
    const after = await run(makeRegistry(sources), scriptedFetch(handler).fetch, st);
    assert.equal(before.out.health.filter((h) => h.error === "skipped").length, 0, "disabled: everything is asked, as before");
    assert.equal(before.out.health.filter((h) => h.status === "carried").length, 5);
    assert.ok(after.clock.now() < before.clock.now() - 3_000, `virtual ingest time ${before.clock.now()} ms -> ${after.clock.now()} ms`);
    assert.deepEqual(after.out.items.map((i) => i.title).sort(), before.out.items.map((i) => i.title).sort(), "the published items are the same either way");
  });

  it("a source with nothing to carry is still asked - once - so backoff can never be why a source goes dark", async () => {
    // "studio" has no recent copy (older than the 6 h carry window); "vllm" has none at all.
    const partial = state({ health: healthFor(ids), lastGood: { ...lastGoodFor(ids.filter((id) => id !== "hn-vllm" && id !== "hn-studio")), ...lastGoodFor(["hn-studio"], 7) } });
    const recovering = new Set(["studio"]);
    const net = scriptedFetch((req, nth) => {
      const n = req.url.slice(HOST.length);
      return recovering.has(n) ? body(n) : handler(req, nth);
    });
    const { out } = await run(makeRegistry(sources), net.fetch, partial);
    const by = new Map(out.health.map((h) => [h.sourceId, h]));
    assert.deepEqual([by.get("hn-weights")?.error, net.to(`${HOST}weights`).length], ["skipped", 0], "has a copy: carried, not asked");
    assert.deepEqual([by.get("hn-vllm")?.status, by.get("hn-vllm")?.error, by.get("hn-vllm")?.attempts, net.to(`${HOST}vllm`).length], ["failing", "http", 1, 1], "no copy: one attempt, no retries");
    assert.deepEqual([by.get("hn-studio")?.status, by.get("hn-studio")?.attempts, net.to(`${HOST}studio`).length], ["ok", 1, 1], "no usable copy and the host answers this one: fresh items");
    assert.deepEqual(out.items.filter((i) => i.sourceId === "hn-studio").map((i) => [i.title, i.carried]), [["Thread studio", undefined]]);
  });

  it("failures that are not in a row never open it; 429 counts, 404 and 403 do not", async () => {
    // Alternating: 502, ok, 502, ok ... - a host that fails for single queries keeps being asked.
    const alternating = new Set(names.filter((_n, i) => i % 2 === 0));
    const net = scriptedFetch((req) => {
      const n = req.url.slice(HOST.length);
      return alternating.has(n) ? respond("Bad Gateway", 502) : body(n);
    });
    const alt = await run(makeRegistry(sources), net.fetch, st);
    assert.equal(alt.out.health.filter((h) => h.error === "skipped").length, 0);
    assert.equal(alt.out.health.filter((h) => h.ok).length, 5);
    assert.ok(names.every((n) => net.to(`${HOST}${n}`).length >= 1));

    const statusRun = async (status: number): Promise<number> => {
      const n429 = scriptedFetch(() => respond("no", status));
      const r = await run(makeRegistry(sources), n429.fetch, st);
      return r.out.health.filter((h) => h.error === "skipped").length;
    };
    assert.equal(await statusRun(429), 9, "rate limited: two sources asked, nine left alone");
    assert.equal(await statusRun(503), 9);
    assert.equal(await statusRun(404), 0, "a 404 is an answer about the URL, not about the host");
    assert.equal(await statusRun(403), 0);
  });

  it("a URL that fails build after build is asked LAST, so it cannot take its host's healthy sources down every run", async () => {
    // The two failing queries are listed FIRST in the registry this time.
    const failingFirst = [...sources.slice(6, 8), ...sources.slice(0, 6), ...sources.slice(8)];
    const bad = new Set(["llamacpp", "qwen"]);
    const serve: Handler = (req) => {
      const n = req.url.slice(HOST.length);
      return bad.has(n) ? respond("Bad Gateway", 502) : body(n);
    };
    // First run of the outage: both were healthy last run, are asked first, fail - the host is left alone once.
    const net1 = scriptedFetch(serve);
    const first = await run(makeRegistry(failingFirst), net1.fetch, st);
    assert.deepEqual(net1.requests.map((r) => r.url.slice(HOST.length)).filter((n, i, all) => all.indexOf(n) === i), ["llamacpp", "qwen"], "registry order while everything was healthy");
    assert.equal(first.out.health.filter((h) => h.error === "skipped").length, 9);

    // Next run: the state says the two failed last time, so they queue behind the nine that work.
    const failedBefore: PipelineState["health"] = { ...healthFor(ids), "hn-llamacpp": health({ failStreak: 1, lastErrorClass: "http", lastError: "HTTP 502" }), "hn-qwen": health({ failStreak: 1, lastErrorClass: "http", lastError: "HTTP 502" }) };
    const net2 = scriptedFetch(serve);
    const second = await run(makeRegistry(failingFirst), net2.fetch, state({ health: failedBefore, lastGood: lastGoodFor(ids) }));
    const asked = net2.requests.map((r) => r.url.slice(HOST.length)).filter((n, i, all) => all.indexOf(n) === i);
    assert.deepEqual(asked.slice(-2), ["llamacpp", "qwen"], "the previously failing URLs are asked last");
    assert.deepEqual(asked.slice(0, 9), names.filter((n) => !bad.has(n)), "the others keep their registry order");
    assert.equal(second.out.health.filter((h) => h.ok).length, 9, "every healthy source is fetched fresh");
    assert.equal(second.out.health.filter((h) => h.error === "skipped").length, 0);
    assert.deepEqual(second.out.health.map((h) => h.sourceId), failingFirst.map((s) => s.id), "health stays in registry order whatever the fetch order");
    assert.deepEqual([second.out.health[0].status, second.out.health[0].failStreak, second.out.health[1].failStreak], ["carried", 2, 2]);
  });

  it("an answered request between two failures resets the count even when it is a 404 or an unparseable 200", async () => {
    const seq: Record<string, Reply> = { frontier: respond("x", 502), ai: respond("gone", 404), llm: respond("x", 502), local: "<html>not a feed</html>", claude: respond("x", 502) };
    const net = scriptedFetch((req) => {
      const n = req.url.slice(HOST.length);
      const r = seq[n];
      return r === undefined ? body(n) : r instanceof Response ? r.clone() : r;
    });
    const { out } = await run(makeRegistry(sources), net.fetch, st);
    assert.equal(out.health.filter((h) => h.error === "skipped").length, 0);
    assert.equal(out.health.filter((h) => h.ok).length, 6);
  });
});

describe("ingest: per-source fetch policy (SourceDef.fetch)", () => {
  const WAPO = "washington-post-technology";
  const wapoUrl = "https://feeds.slowpost.example.com/rss/business/technology";
  // The policy the registry source carries (asserted below), on a test host.
  const WAPO_POLICY = { headerTimeoutMs: 16_000, timeoutRetries: 0 };
  const wapo = makeSource({ id: WAPO, url: wapoUrl, fetch: WAPO_POLICY });
  const body = rss([{ title: "Slow but alive", link: "https://slowpost.example.com/1", hoursAgo: 1 }]);

  async function timed(source: ReturnType<typeof makeSource>, ms: number | "hang"): Promise<{ out: IngestOutput; clock: VirtualClock; requests: number }> {
    const clock = createVirtualClock();
    const net = scriptedFetch(async () => {
      if (ms === "hang") return "hang";
      await sleep(clock, ms);
      return body;
    });
    const ctx = createTestContext({ fetch: net.fetch, state: state() });
    const out = await clock.settle(runIngest(makeRegistry([source]), ctx, { timers: clock, skipHn: true }));
    return { out, clock, requests: net.requests.length };
  }

  it("a 9.5 s host with the policy: one request, 9.5 s. The same host without it: two requests, about 18 s", async () => {
    const withPolicy = await timed(wapo, 9_500);
    assert.deepEqual([withPolicy.out.health[0].ok, withPolicy.out.health[0].attempts, withPolicy.requests, withPolicy.clock.now()], [true, 1, 1, 9_500]);
    const without = await timed(makeSource({ id: "same-host-default-policy", url: wapoUrl }), 9_500);
    assert.deepEqual([without.out.health[0].ok, without.out.health[0].attempts, without.requests], [true, 2, 2]);
    assert.ok(without.clock.now() >= 17_900 && without.clock.now() <= 18_500, `default policy took ${without.clock.now()} ms`);
  });

  it("when the host really hangs it costs one 16 s attempt (default policy: 8 s + 16 s)", async () => {
    const hung = await timed(wapo, "hang");
    assert.deepEqual([hung.out.health[0].error, hung.out.health[0].detail, hung.out.health[0].attempts, hung.requests, hung.clock.now()], ["timeout", "timeout after 16000 ms", 1, 1, 16_000]);
  });

  it("sourceRequest applies the source's policy; the validator builds its request with the same function", () => {
    assert.deepEqual(sourceRequest(resolveSource(wapo)), { url: wapoUrl, accept: sourceRequest(resolveSource(srcA)).accept, headerTimeoutMs: 16_000, timeoutRetries: 0 });
    assert.deepEqual(Object.keys(sourceRequest(resolveSource(srcA))).sort(), ["accept", "url"], "every other source: HTTP_DEFAULTS, no overrides");
    const probe = sourceRequest(resolveSource(wapo), { probe: true, conditional: null });
    assert.deepEqual([probe.attempts, probe.headerTimeoutMs, probe.timeoutRetries], [1, 16_000, 0]);
    assert.equal(sourceRequest(resolveSource(srcA), undefined, { single: true }).attempts, 1);
  });

  it("the registry's Washington Post source carries the policy, and it reaches the request", () => {
    const def = SOURCES.find((s) => s.id === WAPO);
    assert.ok(def, `${WAPO} is a registry source`);
    assert.deepEqual(def.fetch, WAPO_POLICY);
    const req = sourceRequest(resolveSource(def));
    assert.deepEqual([req.headerTimeoutMs, req.timeoutRetries, req.attempts], [16_000, 0, undefined]);
    // Every other registry source runs on HTTP_DEFAULTS.
    assert.deepEqual(SOURCES.filter((s) => s.fetch !== undefined).map((s) => s.id), [WAPO]);
  });

  it("fetchPolicyFor: a registry `fetch` field wins over the table, and every number is clamped", () => {
    assert.deepEqual(fetchPolicyFor({ id: WAPO }), {}, "no id-keyed override is left: the policy lives on the source");
    assert.deepEqual(fetchPolicyFor({ id: "src-a" }), {});
    assert.deepEqual(fetchPolicyFor({ id: "toString" }), {}, "an id is never looked up on Object.prototype");
    assert.deepEqual(fetchPolicyFor({ id: WAPO, fetch: { headerTimeoutMs: 12_000 } }), { headerTimeoutMs: 12_000 });
    assert.deepEqual(fetchPolicyFor({ id: "x", fetch: { headerTimeoutMs: 600_000, timeoutRetries: 9, attempts: 50 } }), { headerTimeoutMs: HTTP_DEFAULTS.totalTimeoutMs - 5_000, timeoutRetries: 1, attempts: 3 });
    assert.deepEqual(fetchPolicyFor({ id: "x", fetch: { headerTimeoutMs: 1, timeoutRetries: -3, attempts: 0 } }), { headerTimeoutMs: 1_000, timeoutRetries: 0, attempts: 1 });
    assert.deepEqual(fetchPolicyFor({ id: "x", fetch: { headerTimeoutMs: Number.NaN, attempts: "3" as unknown as number } }), {});
  });

  it("every id in the override table is an active registry source, and no override waits longer than 20 s for headers", () => {
    const active = new Set(SOURCES.filter((s) => (s.status ?? "active") === "active").map((s) => s.id));
    for (const [id, policy] of Object.entries(SOURCE_FETCH_OVERRIDES)) {
      assert.ok(active.has(id), `${id} is not an active registry source - remove the stale override`);
      assert.ok((policy.headerTimeoutMs ?? 0) <= 20_000, id);
      assert.deepEqual(fetchPolicyFor({ id }), policy, `${id}: the override is inside the clamps as written`);
    }
    assert.ok(Object.keys(SOURCE_FETCH_OVERRIDES).length <= 5, "a long table means the default policy is wrong, or the registry field is overdue");
  });
});
