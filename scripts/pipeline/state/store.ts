// What one build hands to the next (public/data/v2/state.json): the first-seen ledger, the resolved
// URL cache, feed health streaks, last-good items for carry-forward, the river's memory, the
// current lead and the TOP STORIES list. loadState is the only reader, nextState the only place state changes; slimLastGood
// then reduces what is SAVED of the last-good snapshots. The file is not part of the published site
// unless the repository variable V2_PUBLISH_STATE is "true", but the `data` branch that hands it from
// one build to the next belongs to a public repository - so it is still written as a public file.
//
// The file is restored over the network at the start of a build (the data branch first, then a copy
// on the live site when there is one), so it is treated as untrusted input: anything missing, corrupt or of the wrong shape degrades to
// "no memory" for that field instead of failing the build.

import fs from "node:fs/promises";
import type { ArticleId, FeedErrorClass, SourceId } from "../../../shared/contract";
import { isSectionId } from "../../../shared/sections";
import { DAY_MS, HOUR_MS, parseMs } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import { PIPELINE, emptyState, topStanding } from "../context";
import { TOP_STORIES_MAX } from "../../../shared/contract";
import type { LastGood, LoadState, NextState, PipelineState, RawItem, RecentItem, SourceHealthState, TopMemory } from "../types";

/** Most resolved wrapper URLs kept (least recently confirmed dropped first). */
export const RESOLVED_URLS_MAX = 5000;

/**
 * Longest summary (plain text) kept per last-good item. Normalize cuts summaries to 320 chars after
 * removing boilerplate, so 600 leaves room for the boilerplate it strips: measured on a live state,
 * 1 of 4,365 derived summaries changes (400 would change 75 and flap between a fresh fetch and a
 * 304 / carried-forward reuse of the same item).
 */
export const STORED_SUMMARY_MAX = 600;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isIso = (x: unknown): x is string => isStr(x) && parseMs(x) !== null;
const isoOrNull = (x: unknown): string | null => (isIso(x) ? x : null);

function record<T>(x: unknown, pick: (value: unknown, key: string) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    const picked = pick(v, k);
    if (picked !== undefined) out[k] = picked;
  }
  return out;
}

function rawItem(x: unknown): RawItem | undefined {
  if (!isObj(x) || !isStr(x.sourceId) || !isStr(x.title) || !isStr(x.link) || !isHttpUrl(x.link)) return undefined;
  const item: RawItem = {
    sourceId: x.sourceId,
    title: x.title,
    link: x.link,
    publishedRaw: isStr(x.publishedRaw) ? x.publishedRaw : null,
    summaryHtml: isStr(x.summaryHtml) ? x.summaryHtml : null,
  };
  if (isStr(x.comments)) item.comments = x.comments;
  if (isStr(x.itemPublisher)) item.itemPublisher = x.itemPublisher;
  if (isStr(x.itemPublisherUrl)) item.itemPublisherUrl = x.itemPublisherUrl;
  if (isStr(x.guid)) item.guid = x.guid;
  if (isStr(x.resolvedFrom) && isHttpUrl(x.resolvedFrom)) item.resolvedFrom = x.resolvedFrom;
  if (Array.isArray(x.categories)) item.categories = x.categories.filter(isStr);
  return item;
}

function healthState(x: unknown): SourceHealthState | undefined {
  if (!isObj(x) || !isNum(x.failStreak)) return undefined;
  const h: SourceHealthState = { failStreak: Math.max(0, Math.trunc(x.failStreak)), lastOkAt: isoOrNull(x.lastOkAt), lastAttemptAt: isoOrNull(x.lastAttemptAt) };
  if (isStr(x.lastError)) h.lastError = x.lastError;
  if (isStr(x.lastErrorClass)) h.lastErrorClass = x.lastErrorClass as FeedErrorClass;
  return h;
}

/** A last-good snapshot with its conditional-GET validators (etag, lastModified, bodyAt). */
function lastGood(x: unknown): LastGood | undefined {
  if (!isObj(x) || !isIso(x.fetchedAt) || !Array.isArray(x.items)) return undefined;
  const items = x.items.map(rawItem).filter((i): i is RawItem => i !== undefined);
  if (items.length === 0) return undefined;
  const out: LastGood = { fetchedAt: x.fetchedAt, items };
  const validator = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 512;
  if (validator(x.etag)) out.etag = x.etag;
  if (validator(x.lastModified)) out.lastModified = x.lastModified;
  if (isIso(x.bodyAt)) out.bodyAt = x.bodyAt;
  return out;
}

function recentItem(x: unknown): RecentItem | undefined {
  if (!isObj(x) || !isStr(x.id) || !x.id || !isStr(x.title) || !isStr(x.url) || !isHttpUrl(x.url)) return undefined;
  if (!isStr(x.sourceId) || !isSectionId(x.section) || !isNum(x.firstSeenAtMs)) return undefined;
  return {
    id: x.id,
    title: x.title,
    url: x.url,
    sourceId: x.sourceId,
    section: x.section,
    publishedAtMs: isNum(x.publishedAtMs) ? x.publishedAtMs : null,
    firstSeenAtMs: x.firstSeenAtMs,
    leadId: isStr(x.leadId) && x.leadId ? x.leadId : null,
  };
}

function topMemory(x: unknown): TopMemory | undefined {
  if (!isObj(x) || !isStr(x.id) || !x.id || !isNum(x.score)) return undefined;
  const m: TopMemory = { id: x.id, score: x.score };
  if (isIso(x.heldSince)) m.heldSince = x.heldSince;
  return m;
}

/** Parse an untrusted state object field by field. Unknown / malformed parts become empty. */
export function parseState(x: unknown): PipelineState {
  if (!isObj(x)) return emptyState();
  const lead = isObj(x.lead) && isStr(x.lead.id) && x.lead.id && isIso(x.lead.since) ? { id: x.lead.id, since: x.lead.since } : null;
  const state: PipelineState = {
    firstSeen: record(x.firstSeen, (v) => (isIso(v) ? v : undefined)),
    resolvedUrls: record(x.resolvedUrls, (v, k) => (isStr(v) && isHttpUrl(v) && isHttpUrl(k) ? v : undefined)),
    health: record(x.health, healthState),
    lastGood: record(x.lastGood, lastGood),
    recent: Array.isArray(x.recent) ? x.recent.map(recentItem).filter((r): r is RecentItem => r !== undefined) : [],
    lead,
  };
  const lastSeenDay = record(x.lastSeenDay, (v, k) => (isNum(v) && state.firstSeen[k] !== undefined ? Math.trunc(v) : undefined));
  if (Object.keys(lastSeenDay).length) state.lastSeenDay = lastSeenDay;
  const top = Array.isArray(x.top) ? x.top.map(topMemory).filter((m): m is TopMemory => m !== undefined).slice(0, TOP_STORIES_MAX) : [];
  if (top.length) state.top = top;
  // Written by run.ts (the brief alert's counter); kept here so it survives the round trip.
  if (isNum(x.briefFailStreak) && x.briefFailStreak >= 1) state.briefFailStreak = Math.trunc(x.briefFailStreak);
  return state;
}

/** WP6: read state.json. A missing, unreadable, corrupt or foreign-schema file is an empty state (first run). */
export const loadState: LoadState = async (file, log) => {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log?.(code === "ENOENT" ? "info" : "warn", `state: ${code === "ENOENT" ? "no previous state" : `cannot read ${file} (${code ?? "error"})`} - starting empty`);
    return emptyState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log?.("warn", `state: ${file} is not valid JSON - starting empty`);
    return emptyState();
  }
  if (!isObj(parsed) || parsed.schemaVersion !== 2) {
    log?.("warn", `state: ${file} has schemaVersion ${isObj(parsed) ? String(parsed.schemaVersion) : "?"} (expected 2) - starting empty`);
    return emptyState();
  }
  const state = parseState(parsed);
  log?.(
    "info",
    `state: restored ${Object.keys(state.firstSeen).length} first-seen ids, ${state.recent.length} recent items, ${Object.keys(state.health).length} feed states` +
      `${isStr(parsed.savedAt) ? ` (saved ${parsed.savedAt})` : ""}`,
  );
  return state;
};

const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

interface Ledger {
  firstSeen: Record<ArticleId, string>;
  lastSeenDay: Record<ArticleId, number>;
}

/**
 * First-seen ledger. An id is kept while a feed still lists it and for firstSeenTtlDays after it was
 * LAST listed. Pruning by first-seen alone would be wrong: a slow blog lists the same undated posts
 * for years, and forgetting them would stamp every one as brand new on the next run.
 */
function nextLedger(prev: Readonly<PipelineState>, seen: ReadonlyMap<ArticleId, string>, nowMs: number): Ledger {
  const today = dayOf(nowMs);
  const cutoff = today - PIPELINE.firstSeenTtlDays;
  const out: Ledger = { firstSeen: {}, lastSeenDay: {} };
  for (const [id, iso] of Object.entries(prev.firstSeen)) {
    if (seen.has(id)) continue;
    const firstMs = parseMs(iso);
    if (firstMs === null) continue;
    const last = prev.lastSeenDay?.[id] ?? dayOf(firstMs);
    if (last < cutoff) continue;
    out.firstSeen[id] = iso;
    out.lastSeenDay[id] = last;
  }
  for (const [id, firstSeenAt] of seen) {
    out.firstSeen[id] = prev.firstSeen[id] ?? firstSeenAt;
    out.lastSeenDay[id] = today;
  }
  return out;
}

/** Wrapper -> article URL cache, most recently confirmed last; trimmed from the stale end. */
function nextResolved(prev: Readonly<Record<string, string>>, confirmed: Readonly<Record<string, string>>): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(prev)) if (!Object.prototype.hasOwnProperty.call(confirmed, k)) entries.push([k, v]);
  for (const [k, v] of Object.entries(confirmed)) if (isHttpUrl(k) && isHttpUrl(v)) entries.push([k, v]);
  return Object.fromEntries(entries.slice(-RESOLVED_URLS_MAX));
}

/**
 * WP6: fold one run into the state. Pure; the clock is ctx.now.
 * - firstSeen: ids of this run's normalized items are added; ids unseen for firstSeenTtlDays are dropped.
 * - resolvedUrls: merged with this run's confirmations, capped (least recently confirmed first out).
 * - health: this run's streaks; sources ingest did not report keep their entry for the TTL, then go.
 * - lastGood: this run's snapshots replace older ones; snapshots too old to carry forward are dropped.
 * - recent: the river just emitted IS the next river memory (7 days, already pruned and capped).
 * - lead: the same lead STORY keeps its `since` (even when its lead article changed); a new one starts now.
 * - top: the TOP STORIES just published (lead id, score, hold start) - route's membership hysteresis.
 */
export const nextState: NextState = (prev, run, ctx) => {
  const previous = prev;
  const nowMs = ctx.now.getTime();
  const nowIso = ctx.now.toISOString();

  const seen = new Map<ArticleId, string>();
  for (const item of run.normalized) if (!seen.has(item.id)) seen.set(item.id, item.firstSeenAt);
  const ledger = nextLedger(previous, seen, nowMs);

  const ttlMs = PIPELINE.firstSeenTtlDays * DAY_MS;
  const health: Record<SourceId, SourceHealthState> = {};
  for (const [id, h] of Object.entries(previous.health)) {
    const last = parseMs(h.lastAttemptAt) ?? parseMs(h.lastOkAt);
    if (last !== null && nowMs - last <= ttlMs) health[id] = h;
  }
  for (const h of run.ingest.health) {
    const before = previous.health[h.sourceId];
    // A quarantined source that was not probed made no attempt: its entry is untouched, so the daily
    // probe clock (lastAttemptAt) keeps running and the class of the last REAL failure is kept.
    if (h.error === "skipped" && before) {
      health[h.sourceId] = { ...before };
      continue;
    }
    const ok = h.ok && h.status === "ok";
    const entry: SourceHealthState = {
      failStreak: ok ? 0 : Math.max(1, Math.trunc(h.failStreak)),
      lastOkAt: h.lastOkAt ?? before?.lastOkAt ?? null,
      lastAttemptAt: nowIso,
    };
    if (!ok) {
      const detail = h.detail ?? before?.lastError;
      if (detail) entry.lastError = detail;
      const cls = h.error ?? before?.lastErrorClass;
      if (cls) entry.lastErrorClass = cls;
    }
    health[h.sourceId] = entry;
  }

  const carryMs = PIPELINE.carryForwardMaxHours * HOUR_MS;
  const lastGoodOut: Record<SourceId, LastGood> = {};
  for (const [id, snap] of Object.entries({ ...previous.lastGood, ...run.ingest.lastGood })) {
    const fetched = parseMs(snap.fetchedAt);
    if (fetched !== null && nowMs - fetched <= carryMs && snap.items.length > 0) lastGoodOut[id] = snap;
  }

  const river = run.bundle.river;
  const recent: RecentItem[] = river.rows.map((r) => ({
    id: r[0],
    title: r[1],
    url: r[2],
    sourceId: river.sourceIds[r[3]] ?? "",
    section: r[4],
    publishedAtMs: r[5],
    firstSeenAtMs: r[6],
    leadId: r[7],
  }));

  // The lead that was actually published (emit may have corrected the placements). A growing story
  // can change its lead ARTICLE; the tenure (`since`) belongs to the story, so it carries over while
  // the previous lead article is still part of the lead story.
  const leadId = run.bundle.front.leadId;
  const leadStory = leadId === null ? undefined : run.placements.stories[leadId];
  const prevLead = previous.lead;
  const sameStory = prevLead !== null && leadId !== null && (prevLead.id === leadId || (leadStory?.items.some((i) => i.id === prevLead.id) ?? false));
  const lead = leadId === null ? null : { id: leadId, since: sameStory && prevLead ? prevLead.since : nowIso };

  // TOP STORIES as published, for the next build's membership hold. A story that is in the list on
  // merit is remembered at today's score; one that is there by the hold keeps the score it was held
  // at and the time the hold began (route reports both in placements.topHeld), so a hold cannot
  // renew itself.
  const top: TopMemory[] = [];
  for (const id of run.bundle.front.top) {
    const story = run.placements.stories[id];
    if (!story) continue;
    const held = run.placements.topHeld?.[id];
    top.push(held ? { id, score: roundScore(held.score), heldSince: held.since } : { id, score: roundScore(topStanding(story)) });
  }

  const next: PipelineState = {
    firstSeen: ledger.firstSeen,
    resolvedUrls: nextResolved(previous.resolvedUrls, run.ingest.resolvedUrls),
    health,
    lastGood: lastGoodOut,
    recent: recent.filter((r) => r.sourceId !== ""),
    lead,
    lastSeenDay: ledger.lastSeenDay,
  };
  if (top.length) next.top = top;
  return next;
};

const roundScore = (score: number): number => Math.round(score * 10) / 10;

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The summary as it is saved: plain text (via `toText`, normalize's cleanText), at most
 * STORED_SUMMARY_MAX chars, with "&" and "<" escaped again so the next build - which reads the field
 * as feed HTML - decodes it back to exactly this text. Idempotent, so a snapshot that is saved again
 * unchanged (304, carry-forward) stays byte-identical.
 */
export function storedSummary(html: string | null, toText: (html: string) => string): string | null {
  if (html === null) return null;
  const text = cut(toText(html), STORED_SUMMARY_MAX).trimEnd();
  return text ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;") : null;
}

/**
 * state.json is published with the site and on the `data` branch, and 90% of it used to be raw
 * third-party feed HTML (up to 4,000 chars per item, images and scripts included) that only the
 * next build's summary cleaner ever reads. Save the plain text instead. Snapshots, items, order and
 * conditional-GET validators are untouched: only `summaryHtml` shrinks. Pure; `toText` is injected
 * because a stage directory may not import normalize.
 */
export function slimLastGood(state: PipelineState, toText: (html: string) => string): PipelineState {
  const lastGood: Record<SourceId, LastGood> = {};
  for (const [id, snap] of Object.entries(state.lastGood)) {
    lastGood[id] = { ...snap, items: snap.items.map((item) => ({ ...item, summaryHtml: storedSummary(item.summaryHtml, toText) })) };
  }
  return { ...state, lastGood };
}
