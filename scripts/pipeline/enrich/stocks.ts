// Stock quotes for the AI complex (ticker under the masthead).
//
// Source: Yahoo's chart endpoint, one request per symbol, query2 as the retry host. Symbols are
// fetched ONE AT A TIME: eight parallel requests from one address got 6 of 8 rejected on the first
// live build (2026-11-20), and eight sequential ones cost well under two seconds. V1 listed Stooq
// as its primary, but Stooq answers 404 (review of 2026-11-19: every quote V1 shipped matched the
// Yahoo formula), so it is gone rather than kept as dead code.
// Change is always versus the PREVIOUS CLOSE (the Stooq formula was versus the open; the two differ
// by points on a volatile day).
// Each quote carries the exchange's own timestamp (asOf) and the file says whether the market was
// open at build time, so a Saturday build shows Friday's close labelled as such instead of looking live.
// A symbol that fails is a null quote; the stage never throws.

import { SCHEMA_VERSION, type StockQuote } from "../../../shared/contract";
import { ENV, siteUrl } from "../context";
import type { FetchStocks, StageContext } from "../types";

/** Display order: labs/hyperscalers, then the silicon supply chain (V1's list and order). */
export const STOCK_SYMBOLS: readonly string[] = ["NVDA", "MSFT", "GOOG", "META", "AMZN", "AMD", "TSM", "AVGO"];

/** Primary and retry host (also listed as an external service in docs/SBOM.json). */
export const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] as const;
const TIMEOUT_MS = 6000;
// The first host is asked with the honest identifying User-Agent, the retry host with a browser one.
// (First live builds, 2026-11-20: the browser string alone drew HTTP 429 on every symbol from Node
// while an identifying agent was answered 200.)
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const honestUserAgent = (ctx: StageContext): string => (ctx.env[ENV.userAgent] ?? "").trim() || `ai-drudge/2.0 (+${siteUrl(ctx.env)}; stock ticker)`;
/** Without session bounds from the provider, a quote older than this means the market is closed. */
const OPEN_IF_QUOTED_WITHIN_MS = 30 * 60_000;

export function yahooChartUrl(symbol: string, host: string = YAHOO_HOSTS[0]): string {
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
}

export interface ParsedQuote {
  price: number;
  changePct: number | null;
  /** Exchange time of the quote, epoch ms; null when the provider gave none. */
  asOfMs: number | null;
  /** Regular session of the quote's trading day, epoch ms; null when unknown. */
  session: { startMs: number; endMs: number } | null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

/** Read one Yahoo chart response. null when it does not hold a usable price. */
export function parseYahooChart(body: unknown): ParsedQuote | null {
  const chart = isObj(body) ? body.chart : undefined;
  const result = isObj(chart) && Array.isArray(chart.result) ? chart.result[0] : undefined;
  const meta = isObj(result) ? result.meta : undefined;
  if (!isObj(meta)) return null;
  const price = num(meta.regularMarketPrice);
  if (price === null || price <= 0) return null;
  const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);
  const changePct = prev !== null && prev > 0 ? ((price - prev) / prev) * 100 : num(meta.regularMarketChangePercent);
  const time = num(meta.regularMarketTime);
  const period = isObj(meta.currentTradingPeriod) ? meta.currentTradingPeriod.regular : undefined;
  const start = isObj(period) ? num(period.start) : null;
  const end = isObj(period) ? num(period.end) : null;
  return {
    price: round(price, 4),
    changePct: changePct === null ? null : round(changePct, 3),
    asOfMs: time !== null && time > 0 ? time * 1000 : null,
    session: start !== null && end !== null && end > start ? { startMs: start * 1000, endMs: end * 1000 } : null,
  };
}

async function fetchJson(url: string, userAgent: string, ctx: StageContext): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await ctx.fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** One symbol: the first host that answers with a usable price. Failures are returned as text for the log, never thrown. */
async function quoteOf(symbol: string, ctx: StageContext): Promise<ParsedQuote | string> {
  const errors: string[] = [];
  for (const [i, host] of YAHOO_HOSTS.entries()) {
    try {
      const parsed = parseYahooChart(await fetchJson(yahooChartUrl(symbol, host), i === 0 ? honestUserAgent(ctx) : BROWSER_UA, ctx));
      if (parsed) return parsed;
      errors.push("no price in the response");
    } catch (e) {
      // Per-symbol failures are expected (rate limits from datacenter IPs); the next host or a null quote covers it.
      errors.push(e instanceof Error ? (e.name === "AbortError" ? `timeout after ${TIMEOUT_MS} ms` : e.message.slice(0, 80)) : "error");
    }
  }
  return errors.join(" / ");
}

export function marketStateOf(quotes: readonly ParsedQuote[], nowMs: number): "open" | "closed" | undefined {
  if (quotes.length === 0) return undefined;
  const withSession = quotes.filter((q) => q.session !== null);
  if (withSession.length) return withSession.some((q) => q.session !== null && nowMs >= q.session.startMs && nowMs < q.session.endMs) ? "open" : "closed";
  const newest = Math.max(...quotes.map((q) => q.asOfMs ?? 0));
  return newest > 0 && nowMs - newest <= OPEN_IF_QUOTED_WITHIN_MS ? "open" : "closed";
}

/** WP6 stage: quotes for STOCK_SYMBOLS. Never throws; a failed symbol has price/changePct null. */
export const fetchStocks: FetchStocks = async (ctx) => {
  const fetchedAt = ctx.now.toISOString();
  const nowMs = ctx.now.getTime();
  const parsed: (ParsedQuote | null)[] = [];
  const why: string[] = [];
  for (const symbol of STOCK_SYMBOLS) {
    const q = await quoteOf(symbol, ctx).catch((e: unknown) => String(e));
    if (typeof q === "string") why.push(`${symbol}: ${q}`);
    parsed.push(typeof q === "string" ? null : q);
  }

  const quotes: Record<string, StockQuote> = {};
  const good: ParsedQuote[] = [];
  STOCK_SYMBOLS.forEach((symbol, i) => {
    const q = parsed[i];
    if (!q) {
      quotes[symbol] = { price: null, changePct: null, fetchedAt };
      return;
    }
    good.push(q);
    quotes[symbol] = { price: q.price, changePct: q.changePct, fetchedAt, ...(q.asOfMs !== null ? { asOf: new Date(q.asOfMs).toISOString() } : {}) };
  });

  const newest = Math.max(0, ...good.map((q) => q.asOfMs ?? 0));
  const marketState = marketStateOf(good, nowMs);
  const missing = STOCK_SYMBOLS.filter((_, i) => !parsed[i]);
  ctx.log(missing.length ? "warn" : "info", `stocks: ${good.length}/${STOCK_SYMBOLS.length} quotes${marketState ? `, market ${marketState}` : ""}${missing.length ? ` (unavailable: ${why.join("; ")})` : ""}`);

  return {
    schemaVersion: SCHEMA_VERSION,
    buildId: ctx.buildId,
    generatedAt: fetchedAt,
    asOf: newest > 0 ? new Date(newest).toISOString() : null,
    ...(marketState ? { marketState } : {}),
    order: [...STOCK_SYMBOLS],
    quotes,
  };
};
