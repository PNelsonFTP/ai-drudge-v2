// WP2 - the ingest stage: every active registry source -> RawItem[] + per-source health.
//
//   plan (quarantine / conditional GET)  ->  fetch through the host pool  ->  parse / scrape
//   -> newest-N per source by date  ->  Google News wrappers resolved (cached)  ->  carry-forward
//   for failed sources  ->  Techmeme items pointed at their articles  ->  IngestOutput
//
// Host backoff: when two requests in a row to one host end in 5xx / 429, the host is left alone
// for the rest of the run and its remaining sources are carried forward (pool.ts HostBackoff); a
// source with nothing to carry is still asked, once. Per-source fetch policy: SOURCE_FETCH_OVERRIDES.
//
// Guarantees: never throws and never lets one item or one source fail the run; health has one row per
// ACTIVE source in registry order; every item link is an absolute http(s) URL; the whole network phase
// is bounded by a deadline. The clock for health / state is ctx.now; `timers` only measures durations.

import type { FeedErrorClass } from "../../../shared/contract";
import { compileTerms, type TermMatcher } from "../../../shared/text";
import { isHttpUrl } from "../../../shared/url";
import { activeSources, resolveSource } from "../../registry/defaults";
import type { ResolvedSource, SourceFetchPolicy } from "../../registry/types";
import type { FeedHealth, HnIndex, Ingest, IngestOutput, LastGood, RawItem, Registry, StageContext } from "../types";
import { parseFeed, type FeedEntry } from "./feedParser";
import { cachedItems, carryForward, healthFailed, healthHostBackoff, healthOk, healthSkipped, planSource, type Failure, type SourcePlan } from "./feedState";
import { isGithubReleaseSource, releaseEntries } from "./githubRelease";
import { resolveGoogleNewsBatch } from "./googleNews";
import { defaultUserAgent, FEED_ACCEPT, HTML_ACCEPT, HTTP_DEFAULTS, httpFetch, isPublicHttpUrl, JSON_ACCEPT, type HttpDeps, type HttpRequest, type HttpResult } from "./http";
import { dateKey, oneLine, takeNewest } from "./newest";
import { HostBackoff, HostPool, hostKey, isHostTrouble, TimeoutBreaker, type HostPoolOptions } from "./pool";
import { extractHtmlLinks, extractJsonApi } from "./scrape";
import { emptyHnIndex, fetchHnIndex } from "./signals/hn";
import { createDeadline, realTimers, sleep, type Timers } from "./timers";
import { isGoogleNewsUrl, stripGoogleNewsTitle, unwrapSync, unwrapTechmeme, wrapperKey } from "./unwrap";

export const INGEST_DEFAULTS = {
  /** Budget of the fetch phase. A healthy run takes 15-40 s; past this, stragglers fall back to carry-forward. */
  deadlineMs: 90_000,
  /** Extra budget for resolving new Google News wrappers after the feeds are in. */
  resolveBudgetMs: 25_000,
} as const;

export interface IngestOptions {
  /** Duration clock (tests inject a virtual one). */
  timers?: Timers;
  deadlineMs?: number;
  resolveBudgetMs?: number;
  pool?: HostPoolOptions;
  /** Requests in a row ending in 5xx / 429 that put a host in backoff (default 2; Infinity = never). */
  hostBackoffAfter?: number;
  /** Skip the Hacker News signal (tools, tests). */
  skipHn?: boolean;
  /** Skip network resolution of Google News wrappers (the cache is still applied). */
  skipResolve?: boolean;
}

type Outcome =
  | { kind: "items"; items: RawItem[]; skippedItems: number; etag?: string; lastModified?: string }
  | { kind: "not_modified" }
  | ({ kind: "failed" } & Failure);

interface SourceRun {
  source: ResolvedSource;
  plan: SourcePlan;
  outcome: Outcome | null; // null = skipped (quarantined)
  attempts: number;
  ms: number;
  /** Set when the source was not requested because its host is in backoff: the reason, for the health note. */
  hostBackoff?: string;
}

/**
 * Fetch policy of one source, where it must differ from HTTP_DEFAULTS: the registry field
 * `SourceDef.fetch` (scripts/registry/types.ts). Every field is optional and is clamped by
 * fetchPolicyFor: a typo cannot make one source hold a pool slot for minutes.
 */
export type { SourceFetchPolicy };

/**
 * Per-source fetch policy by source id, for a policy that must not live in the registry (none
 * today). The registry field wins: fetchPolicyFor reads `source.fetch` first.
 *
 * The one policy in use is on the registry source washington-post-technology: 9.1 - 10.2 s to
 * first byte for a 6 KB body, every time. With the default policy each build timed out at 8 s and
 * succeeded on the 16 s retry: 18.8 s and 19.1 s in the two builds of 2026-11-20 - the slowest
 * source by 15 s, and what the whole ingest stage waited for. One 16 s attempt gets the same body in
 * about 10 s with one request instead of two; if the host really hangs it costs 16 s once (it was
 * 8 s + 16 s) and the items are carried forward.
 */
export const SOURCE_FETCH_OVERRIDES: Readonly<Record<string, SourceFetchPolicy>> = {};

const clampInt = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);

/** The fetch policy of a source: its own registry `fetch` field when it has one, else the override table; clamped. */
export function fetchPolicyFor(source: { id?: string; fetch?: SourceFetchPolicy }): SourceFetchPolicy {
  const raw: SourceFetchPolicy | undefined = source.fetch ?? (source.id !== undefined && Object.prototype.hasOwnProperty.call(SOURCE_FETCH_OVERRIDES, source.id) ? SOURCE_FETCH_OVERRIDES[source.id] : undefined);
  if (typeof raw !== "object" || raw === null) return {};
  const out: SourceFetchPolicy = {};
  // The header timeout stays under HTTP_DEFAULTS.totalTimeoutMs so a slow-header feed still has time for its body.
  const header = clampInt(raw.headerTimeoutMs, 1_000, HTTP_DEFAULTS.totalTimeoutMs - 5_000);
  const retries = clampInt(raw.timeoutRetries, 0, HTTP_DEFAULTS.timeoutRetries);
  const attempts = clampInt(raw.attempts, 1, HTTP_DEFAULTS.attempts);
  if (header !== undefined) out.headerTimeoutMs = header;
  if (retries !== undefined) out.timeoutRetries = retries;
  if (attempts !== undefined) out.attempts = attempts;
  return out;
}

// Details quote third-party text (parser messages repeat the body): always one bounded line.
const failed = (error: FeedErrorClass, detail: string, httpStatus?: number): Outcome => ({ kind: "failed", error, detail: oneLine(detail), httpStatus });

function httpFailure(res: Extract<HttpResult, { kind: "error" }>): Outcome {
  return failed(res.error, res.detail, res.httpStatus);
}

function toRawItem(sourceId: string, e: FeedEntry): RawItem {
  return { sourceId, ...e };
}

/**
 * Same link twice in one source wastes a cap slot: one row per link. Among the rows that share a
 * link, the first one the source's OWN exclude terms do not match is kept (the first row when all
 * match). OpenRouter lists every model twice under one link - "Google: Gemini 4 Neon (batch)" and
 * then "Google: Gemini 4 Neon" - and keeping the first row blindly handed the "(batch)" row to an
 * exclude list written to drop it, so the source never showed a new frontier model. Sources
 * without exclude terms or without duplicate links behave as before.
 */
export function uniqueByLink<T extends { link: string; title: string }>(items: readonly T[], excluded?: TermMatcher): T[] {
  const isExcluded = (it: T): boolean => excluded !== undefined && excluded.size > 0 && excluded(it.title) !== null;
  const pick = new Map<string, T>();
  for (const it of items) {
    const cur = pick.get(it.link);
    if (cur === undefined || (isExcluded(cur) && !isExcluded(it))) pick.set(it.link, it);
  }
  const chosen = new Set(pick.values());
  return items.filter((it) => chosen.has(it));
}

/**
 * A link that may become a headline: absolute http(s) on a public host. A feed must not be able to
 * publish links into the reader's own network (http://intranet/..., http://10.0.0.5/...).
 */
const publishable = (link: string): boolean => isHttpUrl(link) && isPublicHttpUrl(link);

/** Feed entries -> raw items: wrappers unwrapped (sync part), Google News titles de-suffixed. */
function feedItems(source: ResolvedSource, entries: readonly FeedEntry[], nowMs: number): { items: RawItem[]; dropped: number } {
  let dropped = 0;
  const mapped: RawItem[] = [];
  for (const e of entries) {
    const link = unwrapSync(e.link, { description: e.summaryHtml });
    if (!publishable(link)) {
      dropped++;
      continue;
    }
    const title = isGoogleNewsUrl(e.link) ? stripGoogleNewsTitle(e.title, e.itemPublisher) : e.title;
    mapped.push(toRawItem(source.id, { ...e, link, title }));
  }
  const unique = uniqueByLink(mapped, compileTerms(source.exclude ?? []));
  return { items: isGithubReleaseSource(source) ? unique : takeNewest(unique, source.maxItems, nowMs), dropped };
}

/** Body -> items for one source, by kind. Pure; never throws (callers still guard). */
export function extractItems(source: ResolvedSource, body: string, finalUrl: string, nowMs: number): Outcome {
  if (source.kind === "scrape") {
    if (!source.scrape) return failed("parse", "scrape source without a scrape config");
    const r = extractHtmlLinks(body, source.scrape, finalUrl, { nowMs, maxItems: source.scrape.maxItems ?? source.maxItems });
    const cards = r.cards.filter((c) => publishable(c.link));
    if (cards.length === 0) return failed("no_cards", r.matched === 0 ? "no link on the page matches linkPattern" : `${r.matched} links matched, none usable as a card`);
    return { kind: "items", items: cards.map((c) => toRawItem(source.id, c)), skippedItems: r.dropped + (r.cards.length - cards.length) };
  }
  if (source.kind === "json" && source.jsonApi) {
    const r = extractJsonApi(body, source.jsonApi, finalUrl, { nowMs, maxItems: source.maxItems });
    if (!r.ok) return failed(r.error, r.detail);
    const cards = r.cards.filter((c) => publishable(c.link));
    if (cards.length === 0) return failed("empty", `${r.cards.length} items, none with a public http(s) link`);
    return { kind: "items", items: cards.map((c) => toRawItem(source.id, c)), skippedItems: r.skipped + (r.cards.length - cards.length) };
  }
  const release = isGithubReleaseSource(source);
  const parsed = parseFeed(body, { feedUrl: finalUrl, preferContent: release });
  if (!parsed.ok) return failed(parsed.error, parsed.detail);
  const { items, dropped } = feedItems(source, release ? releaseEntries(parsed.entries) : parsed.entries, nowMs);
  if (items.length === 0) return failed("empty", "feed has no usable items");
  return { kind: "items", items, skippedItems: parsed.skipped + dropped };
}

function acceptFor(source: Pick<ResolvedSource, "kind">): string {
  return source.kind === "scrape" ? HTML_ACCEPT : source.kind === "json" ? JSON_ACCEPT : FEED_ACCEPT;
}

type FetchPlan = Extract<SourcePlan, { action: "fetch" }>;

/**
 * THE request for a source: URL, Accept, validators and the timeout / retry policy - HTTP_DEFAULTS
 * unless the source has its own (fetchPolicyFor). validate-feeds builds its requests with this same
 * function, so "the validator says OK" and "the build can fetch it" are one statement - with
 * separate numbers (validator 15 s x 2, build 8 s x 3) the Washington Post feed (9-10 s to first
 * byte) validated OK and failed every build.
 *
 * A quarantine probe is ONE attempt, so it gets the long header timeout up front: with the short one
 * a slow-but-alive source could never leave quarantine. `single` (the host is in backoff and the
 * source has nothing to carry) is one attempt with the source's normal timeout.
 */
export function sourceRequest(source: Pick<ResolvedSource, "url" | "kind"> & { id?: string; fetch?: SourceFetchPolicy }, plan?: Pick<FetchPlan, "probe" | "conditional">, opts: { single?: boolean } = {}): HttpRequest {
  const req: HttpRequest = { url: source.url, accept: acceptFor(source), ...(plan?.conditional ?? {}), ...fetchPolicyFor(source) };
  if (plan?.probe) {
    req.attempts = 1;
    req.headerTimeoutMs = Math.max(req.headerTimeoutMs ?? 0, HTTP_DEFAULTS.retryHeaderTimeoutMs);
  }
  if (opts.single) req.attempts = 1;
  return req;
}

async function fetchSource(source: ResolvedSource, plan: FetchPlan, deps: HttpDeps, nowMs: number, opts: { single?: boolean } = {}): Promise<{ outcome: Outcome; attempts: number }> {
  const res = await httpFetch(sourceRequest(source, plan, opts), deps);
  if (res.kind === "error") return { outcome: httpFailure(res), attempts: res.attempts };
  if (res.kind === "not_modified") return { outcome: { kind: "not_modified" }, attempts: res.attempts };
  const outcome = extractItems(source, res.text, res.finalUrl, nowMs);
  if (outcome.kind === "items") {
    outcome.etag = res.etag;
    outcome.lastModified = res.lastModified;
  }
  return { outcome, attempts: res.attempts };
}

function lastGoodOf(ctx: StageContext, id: string): LastGood | undefined {
  return ctx.state.lastGood?.[id];
}

/** Replace Google News wrapper links (fresh and carried) by their resolved targets. */
function applyResolved(items: RawItem[], resolved: Readonly<Record<string, string>>): RawItem[] {
  return items.map((item) => {
    if (!isGoogleNewsUrl(item.link)) return item;
    const target = resolved[wrapperKey(item.link)];
    if (!target || !publishable(target)) return item;
    return { ...item, link: target, guid: item.guid ?? item.link, resolvedFrom: item.link };
  });
}

/**
 * Wrapper links -> article links for the items of one source, whatever their origin (this run's
 * body, the cached copy reused on a 304, last-good items carried for a failed source). Both steps
 * are idempotent, so items that were rewritten by an earlier run pass through unchanged.
 */
function unwrapItems(items: RawItem[], resolved: Readonly<Record<string, string>>): RawItem[] {
  return applyResolved(items, resolved).map((item) => {
    const out = unwrapTechmeme(item);
    return out !== item && !publishable(out.link) ? item : out;
  });
}

function formatHealth(h: FeedHealth): string {
  if (h.ok) return `  OK    ${h.sourceId.padEnd(34)} ${String(h.count).padStart(3)} items  ${h.ms} ms${h.notModified ? "  (304 not modified)" : ""}`;
  if (h.error === "skipped" && h.status === "carried") return `  SKIP  ${h.sourceId.padEnd(34)} ${h.detail ?? "host backoff"}`;
  const tail = h.status === "carried" ? ` (carried ${h.count} last-good items)` : h.status === "quarantined" ? ` (quarantined, streak ${h.failStreak})` : "";
  return `  FAIL  ${h.sourceId.padEnd(34)} ${h.error ?? "?"}: ${h.detail ?? ""}${tail}`;
}

async function run(registry: Registry, ctx: StageContext, opts: IngestOptions): Promise<IngestOutput> {
  const timers = opts.timers ?? realTimers;
  const nowMs = ctx.now.getTime();
  const sources = activeSources(registry.sources).map(resolveSource);
  const pool = new HostPool({ now: () => timers.now(), sleep: (ms) => sleep(timers, ms), ...opts.pool });
  const deadline = createDeadline(timers, opts.deadlineMs ?? INGEST_DEFAULTS.deadlineMs);
  const deps: HttpDeps = { fetch: ctx.fetch, timers, userAgent: defaultUserAgent(ctx.env), deadline, breaker: new TimeoutBreaker() };
  const backoff = new HostBackoff(opts.hostBackoffAfter);
  const started = timers.now();
  ctx.log("info", `Ingest: ${sources.length} sources (${registry.sources.length - sources.length} paused)`);

  const hnPromise: Promise<HnIndex> = opts.skipHn ? Promise.resolve(emptyHnIndex()) : fetchHnIndex(nowMs, deps).catch(() => emptyHnIndex());

  const runSource = async (source: ResolvedSource): Promise<SourceRun> => {
    const plan = planSource(ctx.state.health?.[source.id], lastGoodOf(ctx, source.id), ctx.now);
    if (plan.action === "skip") return { source, plan, outcome: null, attempts: 0, ms: 0 };
    let t0 = timers.now();
    const host = hostKey(source.url);
    // True when the host is in backoff AND this source has a recent copy to publish instead.
    const leftAlone = (): boolean => backoff.isOpen(host) && carryForward(lastGoodOf(ctx, source.id), ctx.now).length > 0;
    try {
      return await pool.run(
        host,
        async () => {
          t0 = timers.now(); // the slot is held from here; queueing time is not the source's fault
          if (leftAlone()) {
            const reason = backoff.describe(host);
            return { source, plan, outcome: failed("skipped", reason), attempts: 0, ms: 0, hostBackoff: reason };
          }
          // In backoff with nothing to carry: backoff must never be why a source goes dark, so it is asked - once.
          const { outcome, attempts } = await fetchSource(source, plan, deps, nowMs, { single: backoff.isOpen(host) });
          if (outcome.kind === "failed" && outcome.error === "http" && isHostTrouble(outcome.httpStatus)) {
            if (backoff.recordFailure(host, outcome.httpStatus as number)) ctx.log("warn", `Host backoff: ${backoff.describe(host)} - its remaining sources are carried forward this run`);
          } else if (!(outcome.kind === "failed" && (outcome.error === "timeout" || outcome.error === "network"))) {
            backoff.recordAnswer(host); // the host answered (200, 304, 4xx): earlier failures were not "in a row"
          }
          return { source, plan, outcome, attempts, ms: timers.now() - t0 };
        },
        { noGap: leftAlone },
      );
    } catch (e) {
      // Per-source isolation: a bug or a hostile body costs this source only.
      return { source, plan, outcome: failed("parse", `internal error: ${e instanceof Error ? e.message : String(e)}`), attempts: 1, ms: timers.now() - t0 };
    }
  };

  // Sources that were healthy last run are asked FIRST (registry order within each group). The
  // requests of one host run in the order they are queued, and host backoff stops at two failures
  // in a row - so a URL that fails build after build must not sit at the head of its host's queue
  // and take the host's healthy sources down with it every run. With this order a persistent
  // per-URL failure is asked after everything that works; a host that is really down still fails
  // its first two requests and is left alone. The output (health, items) stays in registry order.
  const failedLastRun = (id: string): boolean => (ctx.state.health?.[id]?.failStreak ?? 0) > 0;
  const order = sources.map((_s, i) => i).sort((x, y) => Number(failedLastRun(sources[x].id)) - Number(failedLastRun(sources[y].id)) || x - y);
  const runs: SourceRun[] = new Array<SourceRun>(sources.length);
  await Promise.all(
    order.map(async (index): Promise<void> => {
      runs[index] = await runSource(sources[index]);
    }),
  );
  deadline.cancel();

  // Google News wrappers -> publisher URLs (cache first; new ids newest-first, bounded).
  const carriedBySource = new Map<string, RawItem[]>();
  for (const r of runs) {
    if (r.outcome?.kind === "failed") carriedBySource.set(r.source.id, carryForward(lastGoodOf(ctx, r.source.id), ctx.now));
  }
  const freshWrappers = runs
    .flatMap((r) => (r.outcome?.kind === "items" ? r.outcome.items : []))
    .filter((it) => isGoogleNewsUrl(it.link))
    .sort((a, b) => (dateKey(b.publishedRaw, nowMs) ?? 0) - (dateKey(a.publishedRaw, nowMs) ?? 0))
    .map((it) => it.link);
  // Items reused on a 304 or carried forward may still hold wrapper links that an earlier run had no budget to resolve.
  const reused = runs.flatMap((r) => (r.outcome?.kind === "not_modified" ? cachedItems(lastGoodOf(ctx, r.source.id)) : []));
  const carriedWrappers = [...reused, ...[...carriedBySource.values()].flat()].filter((it) => isGoogleNewsUrl(it.link)).map((it) => it.link);
  let resolvedUrls: Record<string, string> = {};
  if (freshWrappers.length + carriedWrappers.length > 0) {
    const resolveDeadline = createDeadline(timers, opts.resolveBudgetMs ?? INGEST_DEFAULTS.resolveBudgetMs);
    try {
      const batch = await resolveGoogleNewsBatch([...freshWrappers, ...carriedWrappers], ctx.state.resolvedUrls ?? {}, { ...deps, deadline: resolveDeadline, breaker: undefined }, opts.skipResolve ? { maxNew: 0 } : {});
      resolvedUrls = batch.resolved;
      ctx.log("info", `Google News: ${batch.cacheHits} cached, ${batch.fetched} resolved, ${batch.unresolved} left as wrapper links`);
    } catch (e) {
      ctx.log("warn", `Google News resolve failed: ${oneLine(e instanceof Error ? e.message : String(e))}`);
    } finally {
      resolveDeadline.cancel();
    }
  }

  const items: RawItem[] = [];
  const health: FeedHealth[] = [];
  const lastGood: IngestOutput["lastGood"] = {};
  const nowIso = ctx.now.toISOString();
  for (const r of runs) {
    const id = r.source.id;
    const prev = ctx.state.health?.[id];
    const stats = { ms: r.ms, attempts: r.attempts };
    let row: FeedHealth;
    if (r.outcome === null) {
      row = healthSkipped(id, prev ?? { failStreak: 0, lastOkAt: null, lastAttemptAt: null });
    } else if (r.outcome.kind === "failed") {
      const carried = unwrapItems(carriedBySource.get(id) ?? [], resolvedUrls);
      // Not requested because its host is in backoff: "carried", and the source's own streak is left alone.
      row = r.hostBackoff !== undefined && carried.length > 0 ? healthHostBackoff(id, prev, r.hostBackoff, carried.length) : healthFailed(id, prev, r.outcome, carried.length, stats);
      if (row.status === "carried") items.push(...carried);
    } else {
      const cached = lastGoodOf(ctx, id);
      const fresh = unwrapItems(r.outcome.kind === "items" ? r.outcome.items : cachedItems(cached), resolvedUrls);
      if (fresh.length === 0) {
        // A 304 without a cached copy cannot happen (requests are conditional only when one exists) - but never report OK with nothing.
        row = healthFailed(id, prev, { error: "empty", detail: "not modified, but no cached items" }, 0, stats);
      } else {
        items.push(...fresh);
        row = healthOk(id, fresh.length, { ...stats, skippedItems: r.outcome.kind === "items" ? r.outcome.skippedItems : 0 }, ctx.now);
        if (r.outcome.kind === "not_modified") row.notModified = true;
        const entry: LastGood =
          r.outcome.kind === "items"
            ? { fetchedAt: nowIso, items: fresh, bodyAt: nowIso }
            : { fetchedAt: nowIso, items: fresh, bodyAt: cached?.bodyAt ?? cached?.fetchedAt ?? nowIso, etag: cached?.etag, lastModified: cached?.lastModified };
        if (r.outcome.kind === "items") {
          if (r.outcome.etag) entry.etag = r.outcome.etag;
          if (r.outcome.lastModified) entry.lastModified = r.outcome.lastModified;
        }
        lastGood[id] = entry;
      }
    }
    health.push(row);
    ctx.log(row.ok ? "info" : "warn", formatHealth(row));
  }

  const hn = await hnPromise;
  const ok = health.filter((h) => h.ok).length;
  const carried = health.filter((h) => h.status === "carried").length;
  const quarantined = health.filter((h) => h.status === "quarantined").length;
  const backedOff = runs.filter((r) => r.hostBackoff !== undefined).length;
  ctx.log(
    "info",
    `Ingest done: ${ok}/${health.length} sources OK (${health.filter((h) => h.notModified).length} not modified), ${carried} carried${backedOff ? ` (${backedOff} not requested: host backoff on ${backoff.openHosts.join(", ")})` : ""}, ${quarantined} quarantined, ${items.length} items, HN index ${hn.byUrl.size} urls, ${Math.round(timers.now() - started)} ms, peak ${pool.peakInFlight} in flight`,
  );
  return { items, health, signals: { hn }, resolvedUrls, lastGood };
}

/** ingest() with test / tool options (virtual clock, deadlines, pool sizes). Never throws. */
export async function runIngest(registry: Registry, ctx: StageContext, opts: IngestOptions = {}): Promise<IngestOutput> {
  try {
    return await run(registry, ctx, opts);
  } catch (e) {
    // Last line of defence: report every source as failing rather than rejecting the build.
    const detail = oneLine(`ingest crashed: ${e instanceof Error ? e.message : String(e)}`, 220);
    ctx.log("error", detail);
    const health = activeSources(registry.sources).map((s) => healthFailed(s.id, ctx.state.health?.[s.id], { error: "parse", detail }, 0, { ms: 0, attempts: 0 }));
    return { items: [], health, signals: { hn: emptyHnIndex() }, resolvedUrls: {}, lastGood: {} };
  }
}

export const ingest: Ingest = (registry, ctx) => runIngest(registry, ctx);
