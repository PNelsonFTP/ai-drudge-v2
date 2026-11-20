// Per-source memory between builds - pure decisions over ctx.state (read-only) and this run's outcome.
//
//   quarantine     >= PIPELINE.quarantineAfterFails consecutive failures -> skipped, one probe per day
//   carry-forward  a failing source reuses its last-good items for up to PIPELINE.carryForwardMaxHours
//   conditional    a healthy source is re-fetched with If-None-Match / If-Modified-Since; a 304 reuses
//                  the last-good items and counts as OK
//
// State changes are not written here: they travel in IngestOutput (health, lastGood) and are folded
// by nextState. nextHealthState() below is the fold of one FeedHealth into a SourceHealthState.

import type { FeedErrorClass, SourceId } from "../../../shared/contract";
import { PIPELINE } from "../context";
import type { FeedHealth, LastGood, RawItem, SourceHealthState } from "../types";
import { oneLine } from "./newest";

const HOUR = 3_600_000;

/** A 304 is trusted for at most this long before the body is fetched unconditionally again. */
export const FULL_REFETCH_HOURS = 24;

function hoursSince(iso: string | null | undefined, now: Date): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : (now.getTime() - t) / HOUR;
}

/**
 * Quarantine = a long run of real failures. An empty-but-valid feed (arXiv on a weekend, a dormant
 * blog) is healthy on the wire and cheap to ask, so "empty" never quarantines - otherwise Monday's
 * papers would wait for the next daily probe.
 */
export function isQuarantined(health: Pick<SourceHealthState, "failStreak" | "lastErrorClass"> | undefined): boolean {
  return health !== undefined && health.failStreak >= PIPELINE.quarantineAfterFails && health.lastErrorClass !== "empty";
}

export type SourcePlan =
  | { action: "skip" }
  | { action: "fetch"; probe: boolean; conditional: { etag?: string; lastModified?: string } | null };

/** What to do with a source this run. */
export function planSource(health: SourceHealthState | undefined, lastGood: LastGood | undefined, now: Date): SourcePlan {
  if (isQuarantined(health)) {
    // One probe per quarantineProbeHours; every other run skips the source without a request.
    if (hoursSince(health?.lastAttemptAt, now) < PIPELINE.quarantineProbeHours) return { action: "skip" };
    return { action: "fetch", probe: true, conditional: null };
  }
  const healthy = (health?.failStreak ?? 0) === 0;
  const hasCopy = lastGood !== undefined && Array.isArray(lastGood.items) && lastGood.items.length > 0;
  const fresh = hasCopy && hoursSince(lastGood.bodyAt ?? lastGood.fetchedAt, now) < FULL_REFETCH_HOURS;
  if (healthy && fresh && (lastGood.etag || lastGood.lastModified)) {
    return { action: "fetch", probe: false, conditional: { etag: lastGood.etag, lastModified: lastGood.lastModified } };
  }
  return { action: "fetch", probe: false, conditional: null };
}

const withoutCarried = ({ carried: _carried, ...item }: RawItem): RawItem => item;

/** The cached items of a source as fresh items (304 path): the `carried` flag never sticks. */
export function cachedItems(lastGood: LastGood | undefined): RawItem[] {
  return (lastGood?.items ?? []).map(withoutCarried);
}

/** Last-good items to carry forward for a FAILED source, flagged `carried`; [] when too old or absent. */
export function carryForward(lastGood: LastGood | undefined, now: Date): RawItem[] {
  if (!lastGood || !Array.isArray(lastGood.items) || lastGood.items.length === 0) return [];
  const age = hoursSince(lastGood.fetchedAt, now);
  if (!(age >= 0 && age <= PIPELINE.carryForwardMaxHours)) return [];
  return lastGood.items.map((item) => ({ ...withoutCarried(item), carried: true }));
}

export interface RunStats {
  ms: number;
  attempts: number;
  skippedItems?: number;
}

export function healthOk(sourceId: SourceId, count: number, stats: RunStats, now: Date): FeedHealth {
  const h: FeedHealth = { sourceId, ok: true, status: "ok", count, ms: Math.round(stats.ms), failStreak: 0, lastOkAt: now.toISOString(), attempts: stats.attempts };
  if (stats.skippedItems) h.skippedItems = stats.skippedItems;
  return h;
}

export interface Failure {
  error: FeedErrorClass;
  detail: string;
  httpStatus?: number;
}

/** Health of a source whose fetch failed this run; `carriedCount` items were reused from last-good. */
export function healthFailed(sourceId: SourceId, prev: SourceHealthState | undefined, failure: Failure, carriedCount: number, stats: RunStats): FeedHealth {
  const failStreak = (prev?.failStreak ?? 0) + 1;
  const quarantined = isQuarantined({ failStreak, lastErrorClass: failure.error });
  const h: FeedHealth = {
    sourceId,
    ok: false,
    status: quarantined ? "quarantined" : carriedCount > 0 ? "carried" : "failing",
    count: quarantined ? 0 : carriedCount,
    ms: Math.round(stats.ms),
    error: failure.error,
    // One bounded line, whatever the caller passed: this string is logged, stored in state.json and published in health.json.
    detail: oneLine(failure.detail, 240),
    failStreak,
    lastOkAt: prev?.lastOkAt ?? null,
    attempts: stats.attempts,
  };
  if (failure.httpStatus !== undefined) h.httpStatus = failure.httpStatus;
  if (stats.skippedItems) h.skippedItems = stats.skippedItems;
  return h;
}

/** Health of a quarantined source that was not probed this run (no request made). */
export function healthSkipped(sourceId: SourceId, prev: SourceHealthState): FeedHealth {
  return {
    sourceId,
    ok: false,
    status: "quarantined",
    count: 0,
    ms: 0,
    error: "skipped",
    // The last REAL failure stays visible; "skipped" is the class of this run.
    detail: prev.lastError ?? "quarantined",
    failStreak: prev.failStreak,
    lastOkAt: prev.lastOkAt,
    attempts: 0,
  };
}

/**
 * Health of a source that was NOT requested this run because its host is in backoff (HostBackoff)
 * and whose last-good items were carried instead. The class is "skipped" - no attempt was made - so
 * the persisted state (fail streak, probe clock, last real error) is left exactly as it was: the
 * source did not fail, its host did. Only called with carriedCount > 0; a source with nothing to
 * carry is still asked once.
 */
export function healthHostBackoff(sourceId: SourceId, prev: SourceHealthState | undefined, reason: string, carriedCount: number): FeedHealth {
  return {
    sourceId,
    ok: false,
    status: "carried",
    count: carriedCount,
    ms: 0,
    error: "skipped",
    detail: oneLine(`host backoff: ${reason}; not requested this run, ${carriedCount} last-good item${carriedCount === 1 ? "" : "s"} carried`, 240),
    failStreak: prev?.failStreak ?? 0,
    lastOkAt: prev?.lastOkAt ?? null,
    attempts: 0,
  };
}

/**
 * Fold one run's FeedHealth into the persisted SourceHealthState. A skipped (quarantined, not probed)
 * run must NOT advance lastAttemptAt - that timestamp schedules the daily probe - and keeps the
 * class of the last real failure.
 */
export function nextHealthState(prev: SourceHealthState | undefined, health: FeedHealth, now: Date): SourceHealthState {
  if (health.error === "skipped" && prev) return { ...prev };
  const next: SourceHealthState = { failStreak: health.failStreak, lastOkAt: health.lastOkAt, lastAttemptAt: now.toISOString() };
  if (!health.ok) {
    if (health.detail) next.lastError = health.detail;
    if (health.error) next.lastErrorClass = health.error;
  }
  return next;
}
