// health.json: one row per ACTIVE registry source, registry order.

import type { FeedHealthRow, FeedStatus, HealthFile } from "../../../shared/contract";
import { activeSources } from "../../registry/defaults";
import type { FeedHealth, Registry, StageContext } from "../types";
import { editionMeta } from "./common";

const LAST_ERROR_MAX = 200;

function statusOf(h: FeedHealth): FeedStatus {
  // `status` is authoritative; `ok` is only trusted when ingest left the status inconsistent with it.
  if (h.status === "ok" && !h.ok) return "failing";
  return h.status;
}

function row(h: FeedHealth, previousError: string | undefined): FeedHealthRow {
  const status = statusOf(h);
  const ok = status === "ok";
  const out: FeedHealthRow = {
    id: h.sourceId,
    ok,
    status,
    count: ok || status === "carried" ? Math.max(0, Math.trunc(h.count)) : 0,
    failStreak: ok ? 0 : Math.max(1, Math.trunc(h.failStreak)),
    lastOkAt: h.lastOkAt,
  };
  if (!ok) {
    if (h.error) out.error = h.error;
    const detail = h.detail ?? previousError;
    if (detail) out.lastError = detail.slice(0, LAST_ERROR_MAX);
    if (status === "carried") out.carried = true;
  }
  if (h.httpStatus !== undefined) out.httpStatus = h.httpStatus;
  return out;
}

/**
 * Health rows from this run's ingest outcome. An active source ingest did not report on is listed
 * as failing/"skipped" (never silently absent); rows for sources that are not active are dropped.
 */
export function buildHealth(health: readonly FeedHealth[], registry: Registry, ctx: Pick<StageContext, "now" | "buildId" | "state">): HealthFile {
  const byId = new Map(health.map((h) => [h.sourceId, h]));
  const feeds = activeSources(registry.sources).map((def): FeedHealthRow => {
    const prev = ctx.state.health[def.id];
    const h = byId.get(def.id);
    if (h) return row(h, prev?.lastError);
    return {
      id: def.id,
      ok: false,
      status: "failing",
      count: 0,
      error: "skipped",
      lastError: "no ingest result for this source",
      failStreak: (prev?.failStreak ?? 0) + 1,
      lastOkAt: prev?.lastOkAt ?? null,
    };
  });
  return { ...editionMeta(ctx), feeds };
}
