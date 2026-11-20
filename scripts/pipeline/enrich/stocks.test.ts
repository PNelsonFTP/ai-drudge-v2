import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateStocksFile } from "../../../shared/guards";
import { fakeFetch } from "../../../test/helpers/fixtures";
import { createTestContext } from "../context";
import { STOCK_SYMBOLS, fetchStocks, marketStateOf, parseYahooChart, yahooChartUrl } from "./stocks";

// Trimmed from real chart responses captured 2026-11-19 after the close: the regular session ran
// 14:30-21:00 UTC and regularMarketTime is one second past the close.
const SESSION = { start: 1795098600, end: 1795122000 };
const CLOSE_TIME = 1795122001;

function chart(symbol: string, price: number, previousClose: number | null, over: Record<string, unknown> = {}): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            currency: "USD",
            symbol,
            regularMarketTime: CLOSE_TIME,
            regularMarketPrice: price,
            chartPreviousClose: previousClose,
            previousClose: null,
            currentTradingPeriod: { pre: { start: 1795078800, end: 1795098600 }, regular: { timezone: "EST", ...SESSION, gmtoffset: -18000 }, post: { start: 1795122000, end: 1795136400 } },
            ...over,
          },
          timestamp: [1795098600],
          indicators: { quote: [{}] },
        },
      ],
      error: null,
    },
  };
}

const PRICES: Record<string, [number, number]> = { NVDA: [145.98, 150.96], MSFT: [499.9, 507.31], GOOG: [272.82, 279.2], META: [598.645, 616.38], AMZN: [257.54, 267.74], AMD: [489.19, 530.14], TSM: [354.35, 362.62], AVGO: [346.67, 354.05] };

function routes(symbols: readonly string[] = STOCK_SYMBOLS): Record<string, Response> {
  return Object.fromEntries(symbols.map((s) => [yahooChartUrl(s), Response.json(chart(s, ...PRICES[s]))]));
}

const AFTER_CLOSE = new Date("2026-11-19T21:00:10.000Z");

describe("stocks", () => {
  it("fetches every symbol from Yahoo with previous-close change, market time and the contract's order", async () => {
    const fetch = fakeFetch(routes());
    const ctx = createTestContext({ fetch, now: AFTER_CLOSE });
    const file = await fetchStocks(ctx);
    assert.equal(validateStocksFile(file), null);
    assert.deepEqual(file.order, ["NVDA", "MSFT", "GOOG", "META", "AMZN", "AMD", "TSM", "AVGO"]);
    assert.deepEqual(Object.keys(file.quotes), file.order);
    assert.deepEqual(file.quotes.NVDA, { price: 145.98, changePct: -3.299, fetchedAt: "2026-11-19T21:00:10.000Z", asOf: "2026-11-19T21:00:01.000Z" });
    assert.equal(file.quotes.AMD.changePct, -7.724, "change is versus the previous close, as Yahoo itself reports it");
    assert.equal(file.asOf, "2026-11-19T21:00:01.000Z");
    assert.equal(file.marketState, "closed");
    assert.equal(file.buildId, ctx.buildId);
    assert.equal(file.generatedAt, ctx.now.toISOString());
    assert.equal(fetch.calls.length, 8);
    assert.ok(fetch.calls.every((u) => u.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")));
    assert.ok(!fetch.calls.some((u) => u.includes("stooq")), "Stooq is gone");
  });

  it("labels the market open during the session and closed on a weekend, keeping the quote's own time", async () => {
    const open = await fetchStocks(createTestContext({ fetch: fakeFetch(routes()), now: new Date("2026-11-19T18:00:00.000Z") }));
    assert.equal(open.marketState, "open");

    const saturday = new Date("2026-11-21T15:00:00.000Z");
    const weekend = await fetchStocks(createTestContext({ fetch: fakeFetch(routes()), now: saturday }));
    assert.equal(weekend.marketState, "closed");
    assert.equal(weekend.asOf, "2026-11-19T21:00:01.000Z", "asOf is the market time, not the build time");
    assert.equal(weekend.quotes.NVDA.asOf, "2026-11-19T21:00:01.000Z");
    assert.equal(weekend.quotes.NVDA.fetchedAt, saturday.toISOString());
  });

  it("fails silently per symbol: a missing quote is null and the rest still ship", async () => {
    const partial = routes(["NVDA", "MSFT", "GOOG"]);
    partial[yahooChartUrl("META")] = new Response("Too Many Requests", { status: 429 });
    partial[yahooChartUrl("AMZN")] = new Response("<html>not json</html>", { status: 200 });
    partial[yahooChartUrl("AMD")] = Response.json({ chart: { result: null, error: { code: "Not Found" } } });
    // TSM and AVGO have no route at all: fakeFetch rejects like a network error.
    const ctx = createTestContext({ fetch: fakeFetch(partial), now: AFTER_CLOSE });
    const file = await fetchStocks(ctx);
    assert.equal(validateStocksFile(file), null);
    assert.equal(file.order.length, 8);
    for (const sym of ["META", "AMZN", "AMD", "TSM", "AVGO"]) assert.deepEqual(file.quotes[sym], { price: null, changePct: null, fetchedAt: AFTER_CLOSE.toISOString() }, sym);
    assert.equal(file.quotes.GOOG.price, 272.82);
    assert.match(ctx.logs.at(-1)?.msg ?? "", /stocks: 3\/8 quotes, market closed \(unavailable: META: HTTP 429 .*; AMZN: .*; AMD: no price in the response .*; TSM: .*; AVGO: .*\)/);
    assert.equal(ctx.logs.at(-1)?.level, "warn");
  });

  it("retries a failed symbol on the second Yahoo host", async () => {
    const r = routes(STOCK_SYMBOLS.filter((s) => s !== "NVDA"));
    r[yahooChartUrl("NVDA")] = new Response("", { status: 503 });
    r[yahooChartUrl("NVDA", "query2.finance.yahoo.com")] = Response.json(chart("NVDA", 145.98, 150.96));
    const fetch = fakeFetch(r);
    const file = await fetchStocks(createTestContext({ fetch, now: AFTER_CLOSE }));
    assert.equal(file.quotes.NVDA.price, 145.98);
    assert.ok(fetch.calls.includes("https://query2.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=1d"));
  });

  it("returns an all-null file when the provider is down, without throwing", async () => {
    const ctx = createTestContext({ now: AFTER_CLOSE });
    const file = await fetchStocks(ctx);
    assert.equal(validateStocksFile(file), null);
    assert.equal(file.asOf, null);
    assert.equal(file.marketState, undefined);
    assert.ok(file.order.every((s) => file.quotes[s].price === null));
  });

  it("parses defensively", () => {
    assert.equal(parseYahooChart(null), null);
    assert.equal(parseYahooChart({ chart: { result: [] } }), null);
    assert.equal(parseYahooChart(chart("X", Number.NaN, 10)), null);
    assert.equal(parseYahooChart(chart("X", 0, 10)), null);
    assert.equal(parseYahooChart(chart("X", 10, null, { regularMarketChangePercent: 1.23456 }))?.changePct, 1.235, "falls back to the provider's own percent");
    assert.equal(parseYahooChart(chart("X", 10, null))?.changePct, null);
    assert.equal(parseYahooChart(chart("X", 10, 0))?.changePct, null, "never divides by zero");
    const noTimes = parseYahooChart(chart("X", 10, 8, { regularMarketTime: undefined, currentTradingPeriod: undefined }));
    assert.deepEqual(noTimes, { price: 10, changePct: 25, asOfMs: null, session: null });
  });

  it("derives the market state from the quote time when the provider gives no session", () => {
    const now = Date.parse("2026-11-19T18:00:00Z");
    assert.equal(marketStateOf([], now), undefined);
    assert.equal(marketStateOf([{ price: 1, changePct: 0, asOfMs: now - 5 * 60_000, session: null }], now), "open");
    assert.equal(marketStateOf([{ price: 1, changePct: 0, asOfMs: now - 3 * 3_600_000, session: null }], now), "closed");
    assert.equal(marketStateOf([{ price: 1, changePct: 0, asOfMs: null, session: null }], now), "closed");
  });
});
