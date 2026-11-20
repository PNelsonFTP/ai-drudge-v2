import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_URL, ENV, PIPELINE, TEST_NOW_ISO, createContext, createTestContext, emptyState, neutraliseWorkflowCommands, siteUrl } from "./context";
import { SECTIONS } from "../../shared/sections";
import { FIXTURE_NOW_ISO } from "../../test/helpers/factories";

describe("scripts/pipeline/context", () => {
  it("createTestContext is deterministic and offline", async () => {
    const ctx = createTestContext();
    assert.equal(ctx.now.toISOString(), TEST_NOW_ISO);
    assert.equal(ctx.buildId, TEST_NOW_ISO);
    assert.deepEqual(ctx.env, {});
    assert.deepEqual(ctx.state, emptyState());
    await assert.rejects(() => ctx.fetch("https://example.com/feed.xml"), /network disabled in tests: https:\/\/example\.com\/feed\.xml/);
    await assert.rejects(() => ctx.fetch(new URL("https://example.com/u")), /example\.com\/u/);
    ctx.log("warn", "careful");
    ctx.log("info", "done");
    assert.deepEqual(ctx.logs, [{ level: "warn", msg: "careful" }, { level: "info", msg: "done" }]);
  });

  it("log lines cannot start a GitHub Actions workflow command (feed text reaches the log)", () => {
    assert.equal(neutraliseWorkflowCommands("::error title=x::owned"), ": :error title=x::owned");
    assert.equal(neutraliseWorkflowCommands("fetch failed\n::add-mask::secret\nnext"), "fetch failed\n: :add-mask::secret\nnext");
    assert.equal(neutraliseWorkflowCommands("ingest: 3 sources :: ok"), "ingest: 3 sources :: ok", "only a line START is a command");
  });

  it("the test clock is the fixture clock", () => {
    assert.equal(TEST_NOW_ISO, FIXTURE_NOW_ISO);
  });

  it("overrides are honoured", async () => {
    const state = { ...emptyState(), lead: { id: "abc", since: "2026-11-19T10:00:00.000Z" } };
    const fetchFake: typeof fetch = async () => new Response("ok");
    const ctx = createTestContext({ now: new Date("2026-01-02T03:04:05.000Z"), env: { SITE_URL: "https://x.test/y" }, fetch: fetchFake, state });
    assert.equal(ctx.buildId, "2026-01-02T03:04:05.000Z");
    assert.equal(await (await ctx.fetch("https://anything")).text(), "ok");
    assert.equal(ctx.state.lead?.id, "abc");
    assert.equal(siteUrl(ctx.env), "https://x.test/y/");
    assert.equal(createTestContext({ buildId: "b1" }).buildId, "b1");
  });

  it("createContext defaults buildId to the clock and accepts injection", () => {
    const logged: string[] = [];
    const ctx = createContext({ now: new Date("2026-11-19T20:08:38.159Z"), env: {}, log: (level, msg) => void logged.push(`${level}:${msg}`) });
    assert.equal(ctx.buildId, "2026-11-19T20:08:38.159Z");
    assert.equal(typeof ctx.fetch, "function");
    ctx.log("error", "x");
    assert.deepEqual(logged, ["error:x"]);
    assert.deepEqual(ctx.state, emptyState());
    const real = createContext();
    assert.ok(Math.abs(real.now.getTime() - Date.now()) < 5_000);
    assert.equal(real.env, process.env);
  });

  it("emptyState returns a fresh object each time", () => {
    const a = emptyState();
    a.firstSeen.x = "y";
    a.recent.push({ id: "1", title: "t", url: "https://e.com", sourceId: "s", section: "models", publishedAtMs: null, firstSeenAtMs: 1, leadId: null });
    assert.deepEqual(emptyState(), { firstSeen: {}, resolvedUrls: {}, health: {}, lastGood: {}, recent: [], lead: null });
  });

  it("siteUrl default and trailing slash", () => {
    assert.equal(siteUrl({}), DEFAULT_SITE_URL);
    assert.equal(siteUrl({ [ENV.siteUrl]: "  " }), DEFAULT_SITE_URL);
    assert.equal(siteUrl({ [ENV.siteUrl]: "https://news.example.com" }), "https://news.example.com/");
    assert.ok(!DEFAULT_SITE_URL.includes("/ai-drudge/"), "no V1 URL");
  });

  it("policy constants match V2_PLAN §1.3", () => {
    assert.equal(PIPELINE.carryForwardMaxHours, 6);
    assert.equal(PIPELINE.quarantineAfterFails, 48);
    assert.equal(PIPELINE.sourceCap, 8);
    assert.equal(PIPELINE.recencyHalfLifeHours, 36);
    assert.equal(PIPELINE.topStoriesHours, 72);
    assert.equal(PIPELINE.topStoriesRelaxedHours, 120);
    assert.equal(PIPELINE.summaryMaxChars, 320);
    assert.equal(PIPELINE.titleMaxChars, 200);
    assert.equal(PIPELINE.maxBodyBytes, 5 * 1024 * 1024);
    assert.ok(PIPELINE.firstSeenTtlDays > Math.max(...SECTIONS.map((s) => s.window.hardDays)));
  });
});
