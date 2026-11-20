import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureHealth, fixtureSources } from "../../test/helpers/fixtureData";
import type { SourcesStore } from "../app/services";
import { FAIL, createFakeFetch, createFakeTimers, flush, httpStatus } from "../state/testkit";
import { createSourcesStore } from "./sourcesStore";

function setup(routes: Record<string, unknown>) {
  const timers = createFakeTimers();
  const net = createFakeFetch(routes);
  const store = createSourcesStore({ baseUrl: "/ai-drudge-v2/", fetch: net.fetch, timers });
  return { timers, net, store };
}

describe("sources store", () => {
  it("is lazy: nothing is fetched until load()", async () => {
    const { store, net } = setup({ "sources.json": fixtureSources, "health.json": fixtureHealth });
    await flush();
    assert.deepEqual(store.get(), { status: "idle", sources: null, health: null });
    assert.equal(net.calls.length, 0);
  });

  it("loads sources.json and health.json through the guards", async () => {
    const { store, net } = setup({ "sources.json": fixtureSources, "health.json": fixtureHealth });
    const p = store.load();
    assert.equal(store.get().status, "loading");
    await p;
    const s = store.get();
    assert.equal(s.status, "ready");
    assert.equal(s.sources?.sources.length, fixtureSources.sources.length);
    assert.equal(s.health?.feeds.length, fixtureHealth.feeds.length);
    assert.deepEqual(net.calls.map((c) => c.url).sort(), ["/ai-drudge-v2/data/v2/health.json", "/ai-drudge-v2/data/v2/sources.json"]);
  });

  it("is single-flight and idempotent", async () => {
    const { store, net } = setup({ "sources.json": fixtureSources, "health.json": fixtureHealth });
    await Promise.all([store.load(), store.load(), store.load()]);
    await store.load();
    assert.equal(net.calls.length, 2);
  });

  it("the registry alone is enough: a missing health.json gives 'ready' with health null, and is asked for again later", async () => {
    const { store, net } = setup({ "sources.json": fixtureSources, "health.json": httpStatus(404) });
    await store.load();
    assert.equal(store.get().status, "ready");
    assert.equal(store.get().health, null);
    assert.equal(net.count("health.json"), 1, "no backoff for the optional file");
    net.set("health.json", fixtureHealth);
    await store.load();
    assert.equal(store.get().health?.feeds.length, fixtureHealth.feeds.length);
    assert.equal(net.count("sources.json"), 1, "the registry is not fetched twice");
  });

  it("retries sources.json with backoff; a failed cycle can be retried by the next load()", async () => {
    const { store, net, timers } = setup({ "sources.json": FAIL, "health.json": fixtureHealth });
    const p = store.load();
    await timers.advance(4_000);
    await p;
    assert.equal(net.count("sources.json"), 3);
    assert.equal(store.get().status, "error");
    assert.match(store.get().error ?? "", /Failed to load the source list: the network is unreachable/);
    assert.equal(store.get().health?.feeds.length, fixtureHealth.feeds.length);
    net.set("sources.json", fixtureSources);
    await store.load();
    assert.equal(store.get().status, "ready");
    assert.equal(store.get().error, undefined);
  });

  it("rejects wrong-shaped files", async () => {
    const { store } = setup({ "sources.json": { sources: "nope" }, "health.json": [1, 2, 3] });
    await store.load();
    assert.equal(store.get().status, "error");
    assert.equal(store.get().sources, null);
    assert.equal(store.get().health, null);
  });

  it("reload() fetches both again and keeps the current data when that fails", async () => {
    const { store, net, timers } = setup({ "sources.json": fixtureSources, "health.json": fixtureHealth });
    await store.load();
    const before = store.get();
    net.set("sources.json", httpStatus(500));
    net.set("health.json", httpStatus(500));
    const p = store.reload();
    await timers.advance(4_000);
    await p;
    assert.equal(net.count("sources.json"), 4);
    assert.equal(store.get().sources, before.sources);
    assert.equal(store.get().health, before.health);
    assert.equal(store.get().status, "ready");
  });
});

// Type-level: the implementation satisfies the contract.
export function _typecheck(): SourcesStore {
  return createSourcesStore({ baseUrl: "/", fetch: (input, init) => fetch(input, init) });
}
