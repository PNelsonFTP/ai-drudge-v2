import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BriefFile, EditionFront, EditionRest, RiverFile, StocksFile } from "../../shared/contract";
import { isEditionFront } from "../../shared/guards";
import { sectionRows } from "../../shared/select";
import v1Preview from "../../test/fixtures/v1/2026-11-19/headlines-preview.json";
import { makeArticle, makeEdition, makeRiver, resetFactories } from "../../test/helpers/factories";
import { fixtureBrief, fixtureEdition, fixtureFront, fixtureRest, fixtureRiver, fixtureStocks } from "../../test/helpers/fixtureData";
import { CACHE_KEYS, REFRESH_INTERVAL_MS, STALE_BANNER_HOURS, type EditionState, type EditionStore } from "../app/services";
import { createMemoryStorage, type StorageLike } from "../state/storage";
import { FAIL, HANG, createFakeEvents, createFakeFetch, createFakeTimers, createFakeVisibility, flush, httpStatus, quotaStorage, recordWrites } from "../state/testkit";
import { createEditionStore, validateStaleAfter, type EditionStoreOptions, type OnlineSource, type VisibilitySource } from "./editionStore";
import { TIMEOUT_MS } from "./fetchJson";

const T0 = Date.parse("2026-11-19T21:00:00.000Z");
const MIN = 60_000;

interface Build {
  id: string;
  front: EditionFront;
  rest: EditionRest;
  river: RiverFile;
  brief: BriefFile;
  stocks: StocksFile;
  /** An article that is only in rest.json (beyond the homepage rows). */
  tailId: string;
  leadTitle: string;
}

/** A small valid build: 14 industry stories (12 homepage rows + 2 only in rest), a cluster, TOP STORIES. */
function makeBuild(label: string, generatedAt: string): Build {
  resetFactories();
  const meta = { buildId: generatedAt, generatedAt };
  const articles = Array.from({ length: 14 }, (_, i) => makeArticle({ url: `https://example.com/${label}/story-${i}`, title: `${label} story ${i}` }));
  const member = makeArticle({ url: `https://other.example/${label}/also`, title: `${label} also`, src: "other-source" });
  const { front, rest } = makeEdition({ articles: [...articles, member], clusters: { [articles[0].id]: [member.id] }, top: [articles[0].id], meta });
  return {
    id: generatedAt,
    front,
    rest,
    river: makeRiver([...articles, member], { meta }),
    brief: { ...fixtureBrief, ...meta, source: "claude", headline: `${label} brief` },
    stocks: { ...fixtureStocks, ...meta },
    tailId: articles[13].id,
    leadTitle: `${label} story 0`,
  };
}

const A = makeBuild("A", "2026-11-19T20:00:00.000Z");
const B = makeBuild("B", "2026-11-19T21:05:00.000Z");
const C = makeBuild("C", "2026-11-19T22:05:00.000Z");

const routesOf = (b: Build): Record<string, unknown> => ({
  "front.json": b.front,
  "rest.json": b.rest,
  "river.json": b.river,
  "brief.json": b.brief,
  "stocks.json": b.stocks,
});

function serve(net: ReturnType<typeof createFakeFetch>, b: Build): void {
  for (const [file, body] of Object.entries(routesOf(b))) net.set(file, body);
}

function cacheOf(b: Build, opts: { rest?: boolean } = {}): Record<string, string> {
  return {
    [CACHE_KEYS.front]: JSON.stringify(b.front),
    ...(opts.rest === false ? {} : { [CACHE_KEYS.rest]: JSON.stringify(b.rest) }),
    [CACHE_KEYS.brief]: JSON.stringify(b.brief),
    [CACHE_KEYS.stocks]: JSON.stringify(b.stocks),
  };
}

interface HarnessOptions {
  routes?: Record<string, unknown>;
  cache?: Record<string, string>;
  storage?: StorageLike | null;
  hidden?: boolean;
  autoStart?: boolean;
  overrides?: Partial<EditionStoreOptions>;
}

function harness(opts: HarnessOptions = {}) {
  const timers = createFakeTimers(T0);
  const net = createFakeFetch(opts.routes ?? routesOf(A));
  const session = opts.storage === undefined ? createMemoryStorage(opts.cache) : opts.storage;
  const idleQueue: (() => void)[] = [];
  const doc = createFakeVisibility(opts.hidden ? "hidden" : "visible");
  const win = createFakeEvents<unknown>();
  const store = createEditionStore({
    baseUrl: "/ai-drudge-v2/",
    fetch: net.fetch,
    storage: session,
    now: timers.now,
    timers,
    idle: (run) => void idleQueue.push(run),
    visibility: doc,
    connectivity: win,
    autoStart: opts.autoStart,
    ...opts.overrides,
  });
  const history: EditionState[] = [store.get()];
  store.subscribe(() => history.push(store.get()));
  return {
    store,
    timers,
    net,
    session,
    doc,
    win,
    history,
    statuses: () => history.map((s) => s.status).filter((s, i, all) => i === 0 || s !== all[i - 1]),
    builds: () => history.map((s) => s.edition?.meta.buildId ?? null).filter((s, i, all) => i === 0 || s !== all[i - 1]),
    idlePending: () => idleQueue.length,
    /** The browser became idle: run what was queued for it. */
    idle: async () => {
      for (const run of idleQueue.splice(0)) run();
      await flush();
    },
    files: () => net.calls.map((c) => c.url.replace("/ai-drudge-v2/data/v2/", "")),
  };
}

/** Boot to a complete edition of build `b`. */
async function complete(b: Build = A, opts: HarnessOptions = {}) {
  const h = harness({ routes: routesOf(b), ...opts });
  await h.store.start();
  await h.idle();
  assert.equal(h.store.get().status, "complete");
  return h;
}

describe("edition store: stale-while-revalidate order", () => {
  it("first visit: loading -> front.json -> (idle) -> rest.json; brief and stocks alongside", async () => {
    const h = harness();
    assert.equal(h.store.get().status, "loading");
    assert.equal(h.store.get().edition, null);
    await h.store.start();

    const s = h.store.get();
    assert.equal(s.status, "front");
    assert.equal(s.edition?.complete, false);
    assert.equal(s.edition?.leadId, A.front.leadId);
    assert.equal(s.brief?.headline, "A brief");
    assert.deepEqual(s.stocks?.order, fixtureStocks.order);
    assert.equal(s.fetchedAtMs, T0);
    assert.equal(s.restStatus, "idle");
    assert.equal(s.edition?.articles[A.tailId], undefined, "tail articles are not on the homepage payload");
    assert.equal(h.net.count("rest.json"), 0, "rest.json waits for idle time");
    assert.equal(h.net.count("river.json"), 0, "river.json is on demand only");
    assert.equal(h.files()[0], "front.json");
    assert.equal(h.idlePending(), 1);

    await h.idle();
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.store.get().restStatus, "ready");
    assert.ok(h.store.get().edition?.articles[A.tailId]);
    // The lead and TOP STORIES are identical on the homepage payload and the complete edition
    // (V1 painted a different lead first and swapped it when the full payload landed).
    assert.equal(h.store.get().edition?.leadId, s.edition?.leadId);
    assert.deepEqual(h.store.get().edition?.top, s.edition?.top);
    assert.deepEqual(sectionRows(h.store.get().edition!, "industry"), sectionRows(s.edition!, "industry"), "homepage rows do not shift on hydration");
    assert.deepEqual(h.statuses(), ["loading", "front", "complete"]);
    assert.deepEqual(h.files().sort(), ["brief.json", "front.json", "rest.json", "status.json", "stocks.json"]);
  });

  it("the first-paint requests use the default cache mode so index.html's preload is consumed", async () => {
    const h = harness();
    await h.store.start();
    assert.deepEqual(
      h.net.calls.map((c) => c.cache),
      // front, brief, stocks (preloaded by index.html) and status.json (small, not preloaded).
      ["default", "default", "default", "default"],
    );
    assert.deepEqual(h.files().slice(0, 3), ["front.json", "brief.json", "stocks.json"], "status.json goes on the wire after the three preloaded files");
  });

  it("return visit: the guarded session cache paints synchronously, then front.json revalidates", async () => {
    const h = harness({ cache: cacheOf(A), autoStart: false });
    // Before any network activity at all:
    const cached = h.store.get();
    assert.equal(cached.status, "complete");
    assert.equal(cached.edition?.leadId, A.front.leadId);
    assert.equal(cached.brief?.headline, "A brief");
    assert.equal(cached.fetchedAtMs, null, "null while showing cache only");
    assert.equal(h.net.calls.length, 0);

    await h.store.start();
    assert.equal(h.net.count("front.json"), 1, "front.json is fetched even with a full cache");
    assert.equal(h.net.count("rest.json"), 0, "same build: the cached rest is kept");
    assert.equal(h.store.get().edition, cached.edition, "same build -> same edition object (no re-render churn)");
    assert.equal(h.store.get().fetchedAtMs, T0);
  });

  it("stale cache + newer network build: the cached edition stays up until the new one is ready", async () => {
    const h = harness({ cache: cacheOf(A), routes: routesOf(B) });
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
    await h.store.start();
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    assert.equal(h.store.get().status, "complete");
    assert.deepEqual(h.builds(), [A.id, B.id]);
    assert.deepEqual(h.statuses(), ["complete"], "complete -> complete in one step");
    assert.equal(h.store.get().brief?.headline, "B brief");
  });

  it("a front-only cache is completed on idle", async () => {
    const h = harness({ cache: cacheOf(A, { rest: false }) });
    assert.equal(h.store.get().status, "front");
    await h.store.start();
    await h.idle();
    assert.equal(h.store.get().status, "complete");
  });

  it("offline with a cache: the cached edition stays (status unchanged) and the failed refresh is reported", async () => {
    const h = harness({ cache: cacheOf(A), routes: {}, overrides: { retryDelaysMs: [] } });
    const cached = h.store.get();
    await h.store.start();
    const s = h.store.get();
    assert.equal(s.status, "complete", "never the error STATUS while there is something to show");
    assert.equal(s.edition, cached.edition, "the same edition object stays on screen");
    assert.match(s.error ?? "", /^Failed to refresh headlines: the network is unreachable\.$/);
    assert.equal(s.fetchedAtMs, null, "the UI can tell this is cache only");
  });

  it("a cached edition reloaded while the server answers 503 or a captive-portal page: reported, and still reported after a manual retry", async () => {
    for (const [route, why] of [
      [httpStatus(503), /the server answered 503/],
      [() => ({ __status: 200, body: "<html>Sign in to Wi-Fi</html>" }), /not in the expected format/],
    ] as const) {
      const h = harness({ cache: cacheOf(A), routes: { ...routesOf(A), "front.json": route }, overrides: { retryDelaysMs: [] } });
      await h.store.start();
      assert.equal(h.store.get().status, "complete");
      assert.match(h.store.get().error ?? "", why);
      await h.store.refresh();
      assert.match(h.store.get().error ?? "", why);
      assert.equal(h.store.get().fetchedAtMs, null);
      // The server recovers: the next refresh clears the report.
      h.net.set("front.json", A.front);
      await h.store.refresh();
      assert.equal(h.store.get().error, undefined);
      assert.equal(h.store.get().fetchedAtMs, T0);
    }
  });

  it("reproduces the real fixture edition exactly", async () => {
    const h = harness({ routes: { "front.json": fixtureFront, "rest.json": fixtureRest, "river.json": fixtureRiver, "brief.json": fixtureBrief, "stocks.json": fixtureStocks } });
    await h.store.start();
    await h.idle();
    assert.deepEqual(h.store.get().edition, fixtureEdition());
    await h.store.loadRiver();
    assert.equal(h.store.get().river?.rows.length, fixtureRiver.rows.length);
    // And the cache it wrote is accepted by the next page load.
    const next = harness({ storage: h.session, autoStart: false });
    assert.deepEqual(next.store.get().edition, fixtureEdition());
  });
});

describe("edition store: guards", () => {
  it("a V1-shaped session cache is rejected, removed, and never painted", async () => {
    assert.equal(isEditionFront(v1Preview), false);
    const session = createMemoryStorage({
      [CACHE_KEYS.front]: JSON.stringify(v1Preview),
      [CACHE_KEYS.rest]: JSON.stringify(v1Preview),
      [CACHE_KEYS.brief]: JSON.stringify({ generatedAt: "2026-11-19T20:08:38Z", source: "fallback", headline: "v1", bullets: [], citedArticles: [] }),
      [CACHE_KEYS.stocks]: JSON.stringify({ NVDA: { symbol: "NVDA", price: 1, changePct: 0, fetchedAt: "2026-11-19T20:00:00Z" } }),
    });
    const h = harness({ storage: session, autoStart: false });
    const s = h.store.get();
    assert.equal(s.status, "loading");
    assert.equal(s.edition, null);
    assert.equal(s.brief, null);
    assert.equal(s.stocks, null);
    assert.equal(session.getItem(CACHE_KEYS.front), null, "poisoned cache is deleted so a reload cannot hit it again");
    assert.equal(session.getItem(CACHE_KEYS.brief), null);
    assert.equal(session.getItem(CACHE_KEYS.stocks), null);
    await h.store.start();
    assert.equal(h.store.get().status, "front");
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
  });

  it("other poisoned caches: non-JSON, {}, [], a truncated payload, a wrong-typed field", () => {
    const truncated = { ...A.front, sections: undefined };
    const wrongType = { ...A.front, articles: { ...A.front.articles, [A.front.top[0]]: { ...A.front.articles[A.front.top[0]], url: "javascript:alert(1)" } } };
    for (const raw of ["<html>", "{}", "[]", '{"message":"blocked by policy"}', JSON.stringify(truncated), JSON.stringify(wrongType)]) {
      const session = createMemoryStorage({ [CACHE_KEYS.front]: raw });
      const h = harness({ storage: session, autoStart: false });
      assert.equal(h.store.get().status, "loading", raw.slice(0, 30));
      assert.equal(session.getItem(CACHE_KEYS.front), null);
    }
  });

  it("a cached rest from another build is dropped", () => {
    const session = createMemoryStorage({ ...cacheOf(A), [CACHE_KEYS.rest]: JSON.stringify(B.rest) });
    const h = harness({ storage: session, autoStart: false });
    assert.equal(h.store.get().status, "front");
    assert.equal(session.getItem(CACHE_KEYS.rest), null);
  });

  it("wrong-shaped NETWORK data is a failed fetch: never state, never cached", async () => {
    const h = harness({ routes: { ...routesOf(A), "front.json": { message: "blocked by policy" } } });
    await h.store.start();
    const s = h.store.get();
    assert.equal(s.status, "error");
    assert.equal(s.edition, null);
    assert.match(s.error ?? "", /Failed to load headlines: the data was not in the expected format/);
    assert.equal(h.session?.getItem(CACHE_KEYS.front), null);
    assert.equal(h.net.count("front.json"), 1, "a wrong shape is not retried within the cycle");
  });

  it("wrong-shaped network data never replaces a good cached edition", async () => {
    const h = harness({ cache: cacheOf(A), routes: { ...routesOf(A), "front.json": v1Preview } });
    await h.store.start();
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
    assert.equal(h.store.get().outdatedClient, false);
  });

  it("outdatedClient: a newer schemaVersion keeps the current edition and raises the flag", async () => {
    const future = { ...B.front, schemaVersion: 3, somethingNew: true };
    const h = harness({ cache: cacheOf(A), routes: { ...routesOf(B), "front.json": future } });
    await h.store.start();
    assert.equal(h.store.get().outdatedClient, true);
    assert.equal(h.store.get().edition?.meta.buildId, A.id, "still showing what this bundle understands");
    assert.equal(h.store.get().status, "complete");
  });

  it("outdatedClient without a cache: error state that tells the reader to reload", async () => {
    const h = harness({ routes: { ...routesOf(A), "front.json": { ...A.front, schemaVersion: 3 } } });
    await h.store.start();
    assert.equal(h.store.get().status, "error");
    assert.equal(h.store.get().outdatedClient, true);
    assert.match(h.store.get().error ?? "", /newer version.*reload/);
  });

  it("a newer rest.json or river.json also raises outdatedClient", async () => {
    const h = harness({ routes: { ...routesOf(A), "rest.json": { ...A.rest, schemaVersion: 4 }, "river.json": { ...A.river, schemaVersion: 4 } } });
    await h.store.start();
    await h.idle();
    assert.equal(h.store.get().status, "front");
    assert.equal(h.store.get().restStatus, "error");
    assert.equal(h.store.get().outdatedClient, true);
    assert.equal(h.net.count("rest.json"), 1, "not retried: it will not get better in 3 seconds");
  });
});

describe("edition store: buildId mismatch", () => {
  it("rest.json from a newer build -> front.json is refetched ONCE and both are merged", async () => {
    // The page painted build A; build B was deployed before rest.json was requested.
    const h = harness({ routes: { ...routesOf(A), "rest.json": B.rest } });
    await h.store.start();
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
    h.net.set("front.json", B.front);
    await h.idle();
    const s = h.store.get();
    assert.equal(s.status, "complete");
    assert.equal(s.edition?.meta.buildId, B.id);
    assert.ok(s.edition?.articles[B.tailId]);
    assert.equal(h.net.count("front.json"), 2);
    assert.equal(h.net.count("rest.json"), 1, "the rest already fetched is reused");
    assert.equal(h.net.calls.filter((c) => c.url.endsWith("front.json"))[1].cache, "no-cache", "the refetch bypasses the HTTP cache");
    // No state ever mixed build A rows with build B articles.
    for (const st of h.history) if (st.edition?.complete) assert.equal(st.edition.meta.buildId, B.id);
  });

  it("front newer than rest (stale CDN copy of rest): rest is asked again and merged once it matches", async () => {
    const h = harness({ routes: { ...routesOf(B), "rest.json": A.rest } });
    await h.store.start();
    let restCalls = 0;
    h.net.set("rest.json", () => (++restCalls === 1 ? A.rest : B.rest));
    await h.idle();
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    assert.equal(h.net.count("front.json"), 2, "refetched exactly once");
    assert.equal(h.net.count("rest.json"), 2);
  });

  it("a mismatch that persists never merges and ends as restStatus error after the retries", async () => {
    const h = harness({ routes: { ...routesOf(B), "rest.json": A.rest } });
    await h.store.start();
    await h.idle();
    await h.timers.advance(10_000);
    const s = h.store.get();
    assert.equal(s.status, "front");
    assert.equal(s.restStatus, "error");
    assert.equal(s.edition?.complete, false);
    assert.equal(s.edition?.meta.buildId, B.id);
    assert.equal(h.net.count("front.json"), 2, "front is refetched once per cycle, not per attempt");
    assert.equal(h.net.count("rest.json"), 4, "first try + immediate re-ask + two backoff retries");
  });

  it("river.json from another build -> front is refetched once; the river is shown either way", async () => {
    const h = await complete(A);
    serve(h.net, B);
    await h.store.loadRiver();
    assert.equal(h.store.get().river?.buildId, B.id);
    assert.equal(h.store.get().riverStatus, "ready");
    assert.equal(h.net.count("front.json"), 2);
    assert.equal(h.store.get().edition?.meta.buildId, B.id, "and the edition moved to the river's build");
  });
});

describe("edition store: loadRest retry (V1 never retried)", () => {
  it("retries with backoff after a failed fetch and then completes", async () => {
    let n = 0;
    const h = harness({ routes: { ...routesOf(A), "rest.json": () => (++n === 1 ? FAIL : A.rest) } });
    await h.store.start();
    const done = h.store.loadRest();
    await flush();
    assert.equal(h.store.get().restStatus, "loading");
    assert.equal(h.net.count("rest.json"), 1);
    await h.timers.advance(999);
    assert.equal(h.net.count("rest.json"), 1, "waits for the 1 s backoff");
    await h.timers.advance(1);
    await done;
    assert.equal(h.net.count("rest.json"), 2);
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.net.calls.filter((c) => c.url.endsWith("rest.json"))[1].cache, "no-cache");
  });

  it("gives up after 3 attempts (1 s, 3 s) - status stays 'front', rows stay on screen - and a later call starts a NEW cycle", async () => {
    const h = harness({ routes: { ...routesOf(A), "rest.json": httpStatus(503) } });
    await h.store.start();
    const before = h.store.get().edition;
    const first = h.store.loadRest();
    await h.timers.advance(1_000);
    await h.timers.advance(3_000);
    await first; // resolves, never rejects
    assert.equal(h.net.count("rest.json"), 3);
    const failed = h.store.get();
    assert.equal(failed.status, "front");
    assert.equal(failed.restStatus, "error");
    assert.equal(failed.error, undefined, "`error` is reserved for 'no data at all'");
    assert.equal(failed.edition, before, "the homepage rows are untouched");
    assert.ok(sectionRows(before!, "industry").length > 0);

    // The server recovers; the reader clicks "view all" (or Retry) again.
    h.net.set("rest.json", A.rest);
    await h.store.loadRest();
    assert.equal(h.net.count("rest.json"), 4, "the failed promise was not cached");
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.store.get().restStatus, "ready");
  });

  it("is single-flight and idempotent: many callers, one request; nothing more once complete", async () => {
    const h = harness();
    await h.store.start();
    await Promise.all([h.store.loadRest(), h.store.loadRest(), h.store.loadRest(), h.idle()]);
    assert.equal(h.net.count("rest.json"), 1);
    await h.store.loadRest();
    await h.store.loadRest();
    assert.equal(h.net.count("rest.json"), 1);
    assert.equal(h.store.get().status, "complete");
  });

  it("loadRest() before the first paint waits for front.json instead of failing", async () => {
    const h = harness({ autoStart: false });
    const done = h.store.loadRest();
    await done;
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.files()[0], "front.json");
  });

  it("loadRest() before the first paint waits for front.json only, never for a hung brief or stocks", async () => {
    const h = harness({ autoStart: false, routes: { ...routesOf(A), "stocks.json": HANG, "brief.json": HANG } });
    const done = h.store.loadRest();
    await done; // no timer advanced: the 8 s aux timeout is not part of this wait
    assert.equal(h.store.get().status, "complete");
    assert.equal(h.net.count("rest.json"), 1);
    assert.equal(h.store.get().stocks, null);
  });

  it("loadRest() after a failed first load does not start another front.json cycle", async () => {
    const h = harness({ routes: {}, overrides: { retryDelaysMs: [] } });
    await h.store.start();
    assert.equal(h.store.get().status, "error");
    const calls = h.net.calls.length;
    await h.store.loadRest();
    assert.equal(h.net.calls.length, calls);
    assert.equal(h.store.get().status, "error");
  });

  it("a hung rest.json times out and is retried", async () => {
    let n = 0;
    const h = harness({ routes: { ...routesOf(A), "rest.json": () => (++n === 1 ? HANG : A.rest) } });
    await h.store.start();
    const done = h.store.loadRest();
    await h.timers.advance(TIMEOUT_MS.edition);
    await h.timers.advance(1_000);
    await done;
    assert.equal(h.store.get().status, "complete");
  });

  it("writes the session cache once per build, not once per call (V1: 380 KB per keystroke)", async () => {
    const rec = recordWrites(createMemoryStorage());
    const h = harness({ storage: rec.storage });
    await h.store.start();
    await h.idle();
    for (let i = 0; i < 9; i++) await h.store.loadRest();
    await h.store.refresh();
    await h.store.refresh();
    const sets = rec.writes.filter((w) => w.op === "set").map((w) => w.key);
    assert.deepEqual(sets.sort(), [CACHE_KEYS.brief, CACHE_KEYS.front, CACHE_KEYS.rest, CACHE_KEYS.stocks].sort());
  });
});

describe("edition store: front.json failure", () => {
  it("no cache: retries with backoff, then reports an error with the reason", async () => {
    const h = harness({ routes: { ...routesOf(A), "front.json": httpStatus(500) } });
    const boot = h.store.start();
    await h.timers.advance(1_000);
    await h.timers.advance(3_000);
    await boot;
    assert.equal(h.net.count("front.json"), 3);
    assert.deepEqual(h.statuses(), ["loading", "error"]);
    assert.equal(h.store.get().error, "Failed to load headlines: the server answered 500.");
    assert.equal(h.net.count("rest.json"), 0);
  });

  it("recovers during the backoff", async () => {
    let n = 0;
    const h = harness({ routes: { ...routesOf(A), "front.json": () => (++n < 3 ? FAIL : A.front) } });
    const boot = h.store.start();
    await h.timers.advance(4_000);
    await boot;
    assert.equal(h.store.get().status, "front");
    assert.equal(h.store.get().error, undefined);
  });

  it("refresh() after an error goes back through 'loading' and clears the error on success", async () => {
    const h = harness({ routes: {}, overrides: { retryDelaysMs: [] } });
    await h.store.start();
    assert.equal(h.store.get().status, "error");
    serve(h.net, A);
    await h.store.refresh();
    assert.deepEqual(h.statuses(), ["loading", "error", "loading", "front"]);
    assert.equal(h.store.get().error, undefined);
  });

  it("the 'online' event retries a failed first load", async () => {
    const h = harness({ routes: {}, overrides: { retryDelaysMs: [] } });
    await h.store.start();
    serve(h.net, A);
    h.win.emit("online", {});
    await flush();
    assert.equal(h.store.get().status, "front");
  });

  it("says it is still trying after the first failed attempt, and stops saying so once it gave up", async () => {
    const h = harness({ routes: { ...routesOf(A), "front.json": httpStatus(503) } });
    const boot = h.store.start();
    await flush();
    // Attempt 1 failed; the 1 s backoff is running. Status is still "loading": nothing else to show.
    assert.equal(h.net.count("front.json"), 1);
    assert.equal(h.store.get().status, "loading");
    assert.equal(h.store.get().retrying, true);
    await h.timers.advance(1_000);
    assert.equal(h.store.get().retrying, true, "still trying during attempt 2 and its backoff");
    await h.timers.advance(3_000);
    await boot;
    assert.equal(h.store.get().status, "error");
    assert.equal(h.store.get().retrying, false);
  });

  it("still trying ends with the first edition", async () => {
    let n = 0;
    const h = harness({ routes: { ...routesOf(A), "front.json": () => (++n < 2 ? FAIL : A.front) } });
    const boot = h.store.start();
    await flush();
    assert.equal(h.store.get().retrying, true);
    await h.timers.advance(1_000);
    await boot;
    assert.equal(h.store.get().status, "front");
    assert.equal(h.store.get().retrying, false);
    const flags = h.history.map((s) => (s as { retrying?: boolean }).retrying).filter((f, i, all) => i === 0 || f !== all[i - 1]);
    assert.deepEqual(flags, [undefined, true, false], "up once, down once");
    assert.equal(h.history.find((s) => s.edition !== null), h.history.find((s) => (s as { retrying?: boolean }).retrying === false), "it goes down in the same step the edition arrives");
  });

  it("a load that works first time never mentions retrying (no extra key, no extra notification)", async () => {
    const h = harness();
    await h.store.start();
    assert.ok(h.history.every((s) => !("retrying" in s)));
  });

  it("a failed REFRESH with an edition on screen is not 'still trying': the edition is there to read", async () => {
    const h = await complete(A);
    h.net.set("front.json", FAIL);
    const refresh = h.store.refresh();
    await flush();
    assert.equal(h.store.get().retrying, undefined);
    await h.timers.advance(4_000);
    await refresh;
    assert.equal(h.store.get().retrying, undefined);
    assert.match(h.store.get().error ?? "", /Failed to refresh/);
  });

  it("a hung front.json times out instead of showing 'Loading headlines…' forever", async () => {
    const h = harness({ routes: { ...routesOf(A), "front.json": HANG }, overrides: { retryDelaysMs: [] } });
    const boot = h.store.start();
    await h.timers.advance(TIMEOUT_MS.edition);
    await boot;
    assert.equal(h.store.get().status, "error");
    assert.match(h.store.get().error ?? "", /took too long/);
  });
});

describe("edition store: brief and stocks never block headlines", () => {
  it("headlines paint while stocks.json hangs and brief.json fails (V1: 'Loading headlines…' forever)", async () => {
    const h = harness({ routes: { ...routesOf(A), "stocks.json": HANG, "brief.json": httpStatus(404) } });
    const boot = h.store.start();
    await flush();
    assert.equal(h.store.get().status, "front", "front is up while stocks is still pending");
    await h.idle();
    assert.equal(h.store.get().status, "complete", "and rest.json was not held up either");
    assert.equal(h.store.get().stocks, null);
    assert.equal(h.store.get().brief, null);
    assert.equal(h.store.get().error, undefined);
    await h.timers.advance(TIMEOUT_MS.aux);
    await boot;
    assert.equal(h.store.get().status, "complete");
  });

  it("wrong-shaped brief / stocks are ignored, a previous good value is kept", async () => {
    const h = harness({ cache: cacheOf(A), routes: { ...routesOf(A), "brief.json": { headline: 7 }, "stocks.json": { NVDA: { price: 1 } } } });
    await h.store.start();
    assert.equal(h.store.get().brief?.headline, "A brief");
    assert.deepEqual(h.store.get().stocks?.order, fixtureStocks.order);
    assert.equal(h.store.get().status, "complete");
  });

  it("a later refresh picks the ticker up once it works again", async () => {
    const h = harness({ routes: { ...routesOf(A), "stocks.json": FAIL } });
    await h.store.start();
    assert.equal(h.store.get().stocks, null);
    h.net.set("stocks.json", A.stocks);
    await h.store.refresh();
    assert.deepEqual(h.store.get().stocks?.order, fixtureStocks.order);
  });
});

describe("edition store: refresh", () => {
  it("picks up a new build: front + rest + brief + stocks, swapped in one step, cache rewritten", async () => {
    const h = await complete(A);
    serve(h.net, B);
    h.timers.set(T0 + 7 * MIN);
    const mark = h.history.length;
    const callsBefore = h.net.calls.length;
    await h.store.refresh();
    const s = h.store.get();
    assert.equal(s.edition?.meta.buildId, B.id);
    assert.equal(s.status, "complete");
    assert.equal(s.edition?.articles[s.edition.leadId ?? ""]?.title, B.leadTitle);
    assert.ok(s.edition?.articles[B.tailId]);
    assert.equal(s.edition?.articles[A.tailId], undefined, "nothing of build A is left");
    assert.equal(s.brief?.headline, "B brief");
    assert.equal(s.stocks?.buildId, B.id);
    assert.equal(s.fetchedAtMs, T0 + 7 * MIN);
    // Section pages never saw a "front only" edition in between.
    for (const st of h.history.slice(mark)) assert.equal(st.status, "complete");
    assert.equal((JSON.parse(h.session?.getItem(CACHE_KEYS.front) ?? "{}") as EditionFront).buildId, B.id);
    assert.equal((JSON.parse(h.session?.getItem(CACHE_KEYS.rest) ?? "{}") as EditionRest).buildId, B.id);
    const refreshCalls = h.net.calls.slice(callsBefore);
    assert.deepEqual(refreshCalls.map((c) => c.url.split("/").pop()).sort(), ["brief.json", "front.json", "rest.json", "status.json", "stocks.json"]);
    assert.ok(refreshCalls.every((c) => c.cache === "no-cache"), "refresh revalidates with the server");
  });

  it("same build: nothing re-renders except fetchedAtMs", async () => {
    const h = await complete(A);
    const before = h.store.get();
    h.timers.set(T0 + 3 * MIN);
    await h.store.refresh();
    const after = h.store.get();
    assert.equal(after.edition, before.edition);
    assert.equal(after.brief, before.brief);
    assert.equal(after.stocks, before.stocks);
    assert.equal(after.fetchedAtMs, T0 + 3 * MIN);
    assert.equal(h.net.count("rest.json"), 1);
  });

  it("an OLDER build answered by a stale CDN node never replaces the newer one on screen", async () => {
    const h = await complete(B);
    serve(h.net, A);
    await h.store.refresh();
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    assert.equal(h.store.get().status, "complete");
  });

  it("new front but rest.json unavailable: the new headlines win, rest is retried on idle", async () => {
    const h = await complete(A);
    serve(h.net, B);
    h.net.set("rest.json", FAIL);
    await h.store.refresh();
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    assert.equal(h.store.get().status, "front");
    assert.equal(h.session?.getItem(CACHE_KEYS.rest), null, "build A's rest is not left in the cache");
    h.net.set("rest.json", B.rest);
    await h.idle();
    assert.equal(h.store.get().status, "complete");
  });

  it("a failed refresh keeps everything on screen and reports it in `error` (status unchanged)", async () => {
    const h = await complete(A, { overrides: { retryDelaysMs: [] } });
    const before = h.store.get();
    for (const f of ["front.json", "rest.json", "brief.json", "stocks.json"]) h.net.set(f, FAIL);
    await h.store.refresh();
    const after = h.store.get();
    assert.match(after.error ?? "", /^Failed to refresh headlines: /);
    assert.deepEqual({ ...after, error: undefined }, { ...before, error: undefined });
    assert.equal(after.edition, before.edition);
    assert.equal(after.status, "complete");
    assert.equal(after.fetchedAtMs, before.fetchedAtMs, "fetchedAtMs is the last SUCCESSFUL fetch");
    // Failing again does not notify again (no re-render per attempt).
    const notifications = h.history.length;
    await h.store.refresh();
    assert.equal(h.history.length, notifications);
  });

  it("the failed-refresh report is cleared by the next success, also when the build did not change", async () => {
    const h = await complete(A, { overrides: { retryDelaysMs: [] } });
    h.net.set("front.json", httpStatus(503));
    await h.store.refresh();
    assert.match(h.store.get().error ?? "", /the server answered 503/);
    // Same build (the commonest success: nothing new was published).
    h.net.set("front.json", A.front);
    h.timers.set(T0 + 3 * MIN);
    await h.store.refresh();
    assert.equal(h.store.get().error, undefined);
    assert.equal(h.store.get().fetchedAtMs, T0 + 3 * MIN);
    // A new build.
    h.net.set("front.json", FAIL);
    await h.store.refresh();
    assert.ok(h.store.get().error);
    serve(h.net, B);
    await h.store.refresh();
    assert.equal(h.store.get().error, undefined);
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    // An OLDER build from a stale CDN node is still an answer from the server.
    h.net.set("front.json", FAIL);
    await h.store.refresh();
    assert.ok(h.store.get().error);
    h.net.set("front.json", A.front);
    await h.store.refresh();
    assert.equal(h.store.get().error, undefined);
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
  });

  it("a newer schemaVersion with an edition on screen raises outdatedClient only - no second alert", async () => {
    const h = await complete(A, { overrides: { retryDelaysMs: [] } });
    h.net.set("front.json", { ...B.front, schemaVersion: 3 });
    await h.store.refresh();
    assert.equal(h.store.get().outdatedClient, true);
    assert.equal(h.store.get().error, undefined, "the Reload banner stands alone; Retry could not succeed");
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
  });

  it("the 'online' event retries a failed refresh at once (woke up before the Wi-Fi did)", async () => {
    const h = await complete(A, { overrides: { retryDelaysMs: [] } });
    // Nothing to do while the last refresh succeeded and the next one is not due.
    h.win.emit("online", {});
    await flush();
    assert.equal(h.net.count("front.json"), 1);
    h.doc.hide();
    await h.timers.advance(40 * MIN);
    h.net.set("front.json", FAIL);
    h.doc.show();
    await flush();
    assert.equal(h.net.count("front.json"), 2);
    assert.ok(h.store.get().error, "the overdue refresh ran before the connection was back");
    h.net.set("front.json", A.front);
    await h.timers.advance(5_000);
    h.win.emit("online", {});
    await flush();
    assert.equal(h.net.count("front.json"), 3, "one request, not a wait for the 10-minute interval");
    assert.equal(h.store.get().error, undefined);
  });

  it("concurrent refresh() calls share one request", async () => {
    const h = await complete(A);
    await Promise.all([h.store.refresh(), h.store.refresh(), h.store.refresh()]);
    assert.equal(h.net.count("front.json"), 2);
  });

  it("the river follows a new build once it was loaded", async () => {
    const h = await complete(A);
    await h.store.loadRiver();
    assert.equal(h.store.get().river?.buildId, A.id);
    serve(h.net, B);
    await h.store.refresh();
    await flush();
    assert.equal(h.store.get().river?.buildId, B.id);
    assert.equal(h.store.get().riverStatus, "ready");
  });
});

describe("edition store: auto-refresh", () => {
  it(`refreshes every REFRESH_INTERVAL_MS (${REFRESH_INTERVAL_MS / MIN} min) while the tab is visible`, async () => {
    const h = await complete(A);
    await h.timers.advance(REFRESH_INTERVAL_MS - 1);
    assert.equal(h.net.count("front.json"), 1);
    serve(h.net, B);
    await h.timers.advance(1);
    assert.equal(h.net.count("front.json"), 2);
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
    serve(h.net, C);
    await h.timers.advance(REFRESH_INTERVAL_MS);
    assert.equal(h.store.get().edition?.meta.buildId, C.id);
    assert.deepEqual(h.builds(), [null, A.id, B.id, C.id]);
  });

  it("pauses while hidden and catches up immediately when the tab becomes visible again", async () => {
    const h = await complete(A);
    h.doc.hide();
    assert.equal(h.timers.pending(), 0, "no timer runs in a background tab");
    serve(h.net, B);
    await h.timers.advance(3 * REFRESH_INTERVAL_MS);
    assert.equal(h.net.count("front.json"), 1, "no requests while hidden");
    h.doc.show();
    await flush();
    assert.equal(h.net.count("front.json"), 2);
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
  });

  it("a short trip to another tab does not trigger an early refresh", async () => {
    const h = await complete(A);
    await h.timers.advance(4 * MIN);
    h.doc.hide();
    await h.timers.advance(2 * MIN);
    h.doc.show();
    await flush();
    assert.equal(h.net.count("front.json"), 1);
    await h.timers.advance(4 * MIN - 1);
    assert.equal(h.net.count("front.json"), 1);
    await h.timers.advance(1);
    assert.equal(h.net.count("front.json"), 2, "due exactly one interval after the last check");
  });

  it("a tab opened in the background loads once and schedules nothing until shown", async () => {
    const h = harness({ hidden: true });
    await h.store.start();
    assert.equal(h.store.get().status, "front");
    assert.equal(h.timers.pending(), 0);
  });

  it("keeps trying after a failed refresh", async () => {
    const h = await complete(A, { overrides: { retryDelaysMs: [] } });
    h.net.set("front.json", FAIL);
    await h.timers.advance(REFRESH_INTERVAL_MS);
    assert.equal(h.net.count("front.json"), 2);
    serve(h.net, B);
    await h.timers.advance(REFRESH_INTERVAL_MS);
    assert.equal(h.store.get().edition?.meta.buildId, B.id);
  });

  it("dispose stops timers and listeners, and late responses are ignored", async () => {
    const h = await complete(A);
    serve(h.net, B);
    const pending = h.store.refresh();
    h.store.dispose();
    await pending;
    assert.equal(h.store.get().edition?.meta.buildId, A.id);
    assert.equal(h.timers.pending(), 0);
    assert.equal(h.doc.listenerCount(), 0);
    assert.equal(h.win.listenerCount(), 0);
    await h.timers.advance(3 * REFRESH_INTERVAL_MS);
    assert.equal(h.net.count("front.json"), 2);
  });

  it("refreshIntervalMs: 0 disables auto-refresh", async () => {
    const h = await complete(A, { overrides: { refreshIntervalMs: 0 } });
    assert.equal(h.timers.pending(), 0);
  });
});

describe("edition store: river", () => {
  it("is lazy, idempotent and cached for the session", async () => {
    const h = await complete(A);
    assert.equal(h.store.get().riverStatus, "idle");
    const p = h.store.loadRiver();
    assert.equal(h.store.get().riverStatus, "loading");
    await Promise.all([p, h.store.loadRiver(), h.store.loadRiver()]);
    assert.equal(h.store.get().riverStatus, "ready");
    assert.equal(h.store.get().river?.rows.length, A.river.rows.length);
    assert.equal(h.net.count("river.json"), 1);
    await h.store.loadRiver();
    assert.equal(h.net.count("river.json"), 1);
    // Next page load in the same tab: served from the guarded cache, no request.
    const next = harness({ storage: h.session });
    await next.store.start();
    await next.store.loadRiver();
    assert.equal(next.net.count("river.json"), 0);
    assert.equal(next.store.get().river?.buildId, A.id);
  });

  it("retries with backoff; after a failed cycle the next call tries again", async () => {
    const h = await complete(A);
    h.net.set("river.json", FAIL);
    const p = h.store.loadRiver();
    await h.timers.advance(4_000);
    await p;
    assert.equal(h.net.count("river.json"), 3);
    assert.equal(h.store.get().riverStatus, "error");
    assert.equal(h.store.get().status, "complete", "a river failure never touches the headlines");
    h.net.set("river.json", A.river);
    await h.store.loadRiver();
    assert.equal(h.store.get().riverStatus, "ready");
  });

  it("rejects a wrong-shaped river and a poisoned river cache", async () => {
    const session = createMemoryStorage({ [CACHE_KEYS.river]: JSON.stringify({ rows: "nope" }) });
    const h = await complete(A, { storage: session });
    h.net.set("river.json", { ...A.river, rows: [["id", "title", "javascript:alert(1)", 0, "industry", null, 1, null]] });
    await h.store.loadRiver();
    assert.equal(h.store.get().river, null);
    assert.equal(h.store.get().riverStatus, "error");
    assert.equal(session.getItem(CACHE_KEYS.river), null);
  });
});

describe("edition store: stale threshold from status.json", () => {
  const status = (staleAfterMinutes: unknown): Record<string, unknown> => ({ schema: 1, buildId: A.id, generatedAt: A.id, cadenceMinutes: 30, staleAfterMinutes });

  it("publishes status.json staleAfterMinutes; absent until the file has loaded", async () => {
    const h = harness({ routes: { ...routesOf(A), "status.json": status(90) }, autoStart: false });
    assert.equal(h.store.get().staleAfterMinutes, undefined);
    await h.store.start();
    assert.equal(h.store.get().staleAfterMinutes, 90);
    assert.equal(h.net.count("status.json"), 1);
  });

  it("a missing, failing or wrong-shaped status.json leaves it absent and never touches the headlines", async () => {
    for (const route of [undefined, FAIL, httpStatus(404), { schema: 1 }, status("90"), status(0), status(-5), status(Number.NaN), [90], null]) {
      const h = harness({ routes: { ...routesOf(A), ...(route === undefined ? {} : { "status.json": route }) } });
      await h.store.start();
      assert.equal(h.store.get().status, "front", JSON.stringify(route));
      assert.equal(h.store.get().staleAfterMinutes, undefined, JSON.stringify(route));
      assert.equal(h.store.get().error, undefined);
      assert.equal(h.store.get().outdatedClient, false);
    }
  });

  it("a hung status.json delays nothing on screen and gives up with the ticker's timeout", async () => {
    const h = harness({ routes: { ...routesOf(A), "status.json": HANG } });
    const boot = h.store.start();
    await flush();
    assert.equal(h.store.get().status, "front");
    assert.equal(h.store.get().brief?.headline, "A brief");
    await h.timers.advance(TIMEOUT_MS.aux);
    await boot;
    assert.equal(h.store.get().staleAfterMinutes, undefined);
  });

  it("follows a changed value on refresh and keeps the last known one when a later status.json fails", async () => {
    const h = await complete(A, { routes: { ...routesOf(A), "status.json": status(90) } });
    h.net.set("status.json", status(120));
    h.timers.set(T0 + 3 * MIN);
    await h.store.refresh();
    assert.equal(h.store.get().staleAfterMinutes, 120);
    h.net.set("status.json", FAIL);
    h.timers.set(T0 + 6 * MIN);
    await h.store.refresh();
    assert.equal(h.store.get().staleAfterMinutes, 120);
    assert.equal(h.store.get().error, undefined, "status.json is never a headline failure");
  });

  it("the same value again changes nothing (no re-render)", async () => {
    const h = await complete(A, { routes: { ...routesOf(A), "status.json": status(90) } });
    h.timers.set(T0 + 3 * MIN);
    const before = h.history.length;
    await h.store.refresh();
    // fetchedAtMs moves; staleAfterMinutes does not cause a second notification.
    assert.equal(h.history.length, before + 1);
  });

  it("validateStaleAfter reads one field and nothing else", () => {
    assert.equal(validateStaleAfter({ staleAfterMinutes: 90 }), null);
    assert.equal(validateStaleAfter({ staleAfterMinutes: 90, gate: "whatever shape" }), null);
    for (const bad of [null, undefined, 90, "90", [], {}, { staleAfterMinutes: "90" }, { staleAfterMinutes: 0 }, { staleAfterMinutes: Number.POSITIVE_INFINITY }]) {
      assert.match(validateStaleAfter(bad) ?? "", /staleAfterMinutes/);
    }
  });
});

describe("edition store: misc", () => {
  it("staleHours: hours since generatedAt, null without an edition", async () => {
    const h = harness({ autoStart: false });
    assert.equal(h.store.staleHours(T0), null);
    await h.store.start();
    assert.equal(h.store.staleHours(Date.parse(A.id) + 90 * MIN), 1.5);
    assert.ok((h.store.staleHours(Date.parse(A.id) + 7 * 60 * MIN) ?? 0) > STALE_BANNER_HOURS);
  });

  it("works without any storage, and with storage that refuses writes", async () => {
    const none = harness({ storage: null });
    await none.store.start();
    await none.idle();
    assert.equal(none.store.get().status, "complete");
    const full = harness({ storage: quotaStorage() });
    await full.store.start();
    await full.idle();
    assert.equal(full.store.get().status, "complete");
  });

  it("get() is referentially stable between changes and methods do not depend on `this`", async () => {
    const h = harness();
    const { get, loadRest, start, staleHours } = h.store;
    await start();
    assert.equal(get(), get());
    await loadRest();
    assert.equal(get().status, "complete");
    assert.equal(typeof staleHours(T0), "number");
  });
});

// Type-level: the implementation satisfies the contract, and browser objects satisfy the injected slices.
export function _typecheck(doc: Document, win: Window): [EditionStore, VisibilitySource, OnlineSource] {
  const store: EditionStore = createEditionStore({ baseUrl: "/", fetch: (input, init) => fetch(input, init), storage: sessionStorage, now: Date.now, visibility: doc, connectivity: win });
  return [store, doc, win];
}
