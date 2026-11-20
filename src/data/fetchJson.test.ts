import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBriefFile } from "../../shared/guards";
import { fixtureBrief } from "../../test/helpers/fixtureData";
import { FAIL, HANG, createFakeFetch, createFakeTimers, httpStatus } from "../state/testkit";
import { TIMEOUT_MS, createLoader, dataUrl, describeFailure, isTransient, type FetchLike } from "./fetchJson";

function setup(route: unknown) {
  const timers = createFakeTimers();
  const net = createFakeFetch({ "brief.json": route });
  const load = createLoader({ baseUrl: "/ai-drudge-v2/", fetch: net.fetch, timers });
  return { timers, net, load };
}

describe("fetchJson loader", () => {
  it("builds data URLs under the site base", () => {
    assert.equal(dataUrl("/ai-drudge-v2/", "front.json"), "/ai-drudge-v2/data/v2/front.json");
    assert.equal(dataUrl("/base", "rest.json"), "/base/data/v2/rest.json");
    assert.equal(dataUrl("/", "river.json"), "/data/v2/river.json");
  });

  it("returns guarded data; the cache mode follows `fresh`", async () => {
    const { load, net } = setup(fixtureBrief);
    const a = await load(`brief.json`, validateBriefFile, { fresh: false, timeoutMs: 100 });
    assert.deepEqual(a, { ok: true, data: fixtureBrief });
    await load(`brief.json`, validateBriefFile, { fresh: true, timeoutMs: 100 });
    assert.deepEqual(net.calls, [
      { url: "/ai-drudge-v2/data/v2/brief.json", cache: "default" },
      { url: "/ai-drudge-v2/data/v2/brief.json", cache: "no-cache" },
    ]);
  });

  it("classifies failures: network, http, parse, invalid, newer schema", async () => {
    assert.deepEqual(await setup(FAIL).load("brief.json", validateBriefFile, { fresh: false, timeoutMs: 100 }), { ok: false, reason: "network" });
    assert.deepEqual(await setup(httpStatus(503)).load("brief.json", validateBriefFile, { fresh: false, timeoutMs: 100 }), { ok: false, reason: "http", detail: "503" });

    const timers = createFakeTimers();
    const badJson: FetchLike = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<!doctype html>") as unknown });
    assert.deepEqual(await createLoader({ baseUrl: "/", fetch: badJson, timers })("brief.json", validateBriefFile, { fresh: false, timeoutMs: 100 }), { ok: false, reason: "parse" });

    const wrong = await setup({ message: "blocked by policy" }).load("brief.json", validateBriefFile, { fresh: false, timeoutMs: 100 });
    assert.equal(wrong.ok, false);
    assert.deepEqual(!wrong.ok && [wrong.reason, wrong.newer], ["invalid", false]);
    assert.match((!wrong.ok && wrong.detail) || "", /schemaVersion/);

    const future = await setup({ ...fixtureBrief, schemaVersion: 3 }).load("brief.json", validateBriefFile, { fresh: false, timeoutMs: 100 });
    assert.deepEqual(!future.ok && [future.reason, future.newer], ["invalid", true]);
  });

  it("times out a hung request, aborts it, and leaves no timer behind", async () => {
    const { load, timers } = setup(HANG);
    let settled: unknown = null;
    const p = load("brief.json", validateBriefFile, { fresh: false, timeoutMs: TIMEOUT_MS.aux }).then((r) => (settled = r));
    await timers.advance(TIMEOUT_MS.aux - 1);
    assert.equal(settled, null);
    await timers.advance(1);
    await p;
    assert.deepEqual(settled, { ok: false, reason: "timeout" });
    assert.equal(timers.pending(), 0);
  });

  it("times out even when fetch ignores the abort signal", async () => {
    const timers = createFakeTimers();
    const deaf: FetchLike = () => new Promise(() => undefined);
    const p = createLoader({ baseUrl: "/", fetch: deaf, timers })("brief.json", validateBriefFile, { fresh: false, timeoutMs: 50 });
    await timers.advance(50);
    assert.deepEqual(await p, { ok: false, reason: "timeout" });
  });

  it("clears the timeout after a normal response", async () => {
    const { load, timers } = setup(fixtureBrief);
    await load("brief.json", validateBriefFile, { fresh: false, timeoutMs: 1_000 });
    assert.equal(timers.pending(), 0);
  });

  it("calls fetch detached (window.fetch rejects a foreign `this`)", async () => {
    const env = {
      baseUrl: "/",
      fetch: function (this: unknown) {
        assert.equal(this, undefined);
        return Promise.resolve({ ok: true, status: 200, json: async () => fixtureBrief as unknown });
      } as FetchLike,
      timers: createFakeTimers(),
    };
    assert.equal((await createLoader(env)("brief.json", validateBriefFile, { fresh: false, timeoutMs: 10 })).ok, true);
  });

  it("isTransient / describeFailure", () => {
    assert.deepEqual(["network", "timeout", "http", "parse", "invalid"].map((r) => isTransient(r as never)), [true, true, true, true, false]);
    assert.equal(describeFailure("http", "404"), "the server answered 404");
    assert.equal(describeFailure("timeout"), "the server took too long to answer");
    assert.equal(describeFailure("invalid"), "the data was not in the expected format");
    assert.equal(describeFailure("network"), "the network is unreachable");
  });
});

// Type-level: window.fetch satisfies FetchLike.
export function _typecheck(): FetchLike {
  return fetch;
}
