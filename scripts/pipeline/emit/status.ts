// status.json: the small ops file the reconciler, the freshness guard and the About page read
// instead of downloading the edition (ops review §E).

import { STATUS_SCHEMA, type BriefFile, type EditionFront, type HealthFile, type SourcesFile, type StatusFile, type StocksFile } from "../../../shared/contract";
import { ENV, PIPELINE } from "../context";
import type { RunInfo, StageContext } from "../types";
import { briefFailStreakOf, briefFallbackReason, nextBriefFailStreak, type QualityReport } from "./quality";

const FAILED_NAMES_MAX = 50;

function intOrNull(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** CI run metadata from the GitHub Actions environment; a "local" run when the variables are absent. */
export function runInfoFromEnv(env: StageContext["env"], durationS: number | null = null): RunInfo {
  const sha = (env[ENV.sha] ?? "").trim();
  return {
    id: intOrNull(env[ENV.runId]),
    attempt: intOrNull(env[ENV.runAttempt]),
    trigger: (env[ENV.eventName] ?? "").trim() || "local",
    codeSha: /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null,
    durationS,
  };
}

export interface StatusInput {
  front: EditionFront;
  health: HealthFile;
  sources: SourcesFile;
  brief: BriefFile;
  stocks: StocksFile;
  run?: RunInfo;
  quality: QualityReport;
}

/**
 * status.json `brief` block (shared/contract.ts StatusFile.brief). `failStreak`: consecutive builds
 * whose Claude brief failed with a key configured, this build included; absent when 0. The gate
 * reads it back to raise the brief alert (quality.ts briefAlert).
 */
export type StatusBrief = StatusFile["brief"];

/** The brief failure streak including this build, from the previous state and this build's brief. */
export function briefFailStreakFor(state: unknown, brief: BriefFile): number {
  return nextBriefFailStreak(briefFailStreakOf(state), brief);
}

/**
 * status.json `feeds` block from a health file: the four status counts (they add up to `total`) and
 * the display names of the feeds that are not ok, capped. Exported for the fixture refresh tool,
 * which rewrites the block after it adds its documented health cases.
 */
export function statusFeeds(health: HealthFile, sources: SourcesFile): StatusFile["feeds"] {
  const names = new Map(sources.sources.map((s) => [s.id, s.name]));
  const notOk = health.feeds.filter((f) => !f.ok);
  const count = (status: string): number => health.feeds.filter((f) => f.status === status).length;
  return {
    total: health.feeds.length,
    ok: count("ok"),
    failed: count("failing"),
    carriedForward: count("carried"),
    quarantined: count("quarantined"),
    failedNames: notOk.slice(0, FAILED_NAMES_MAX).map((f) => names.get(f.id) ?? f.id),
  };
}

export function buildStatus(input: StatusInput, ctx: Pick<StageContext, "now" | "buildId" | "env"> & { state?: unknown }): StatusFile {
  const { front, health, quality } = input;
  const { stats } = quality;
  const reason = input.brief.source === "fallback" ? briefFallbackReason(input.brief) : null;
  const failStreak = briefFailStreakFor(ctx.state, input.brief);
  // `reason`: the coarse fallback code ("no-key", "http-4xx", ...) - optional, absent for a Claude brief.
  const brief: StatusBrief = { source: input.brief.source, ...(reason === null ? {} : { reason }), ...(failStreak > 0 ? { failStreak } : {}) };
  return {
    schema: STATUS_SCHEMA,
    buildId: ctx.buildId,
    generatedAt: ctx.now.toISOString(),
    cadenceMinutes: PIPELINE.cadenceMinutes,
    staleAfterMinutes: PIPELINE.staleAfterMinutes,
    run: input.run ?? runInfoFromEnv(ctx.env),
    feeds: statusFeeds(health, input.sources),
    content: {
      stories: front.counts.stories,
      top: front.top.length,
      emptySections: front.sections.filter((s) => s.rows.length === 0).map((s) => s.id),
      newestItemAt: stats.newestMs === null ? null : new Date(stats.newestMs).toISOString(),
      medianAgeH: stats.medianAgeH,
    },
    // The emit-time verdict of the content rules. The CI gate (tools/check-data.ts) re-evaluates on
    // the written files and may rewrite this block with --write-status.
    // Alerts do not hold the build; in status.json they lead the warnings so the About page shows them.
    gate: { passed: quality.failures.length === 0, failures: [...quality.failures], warnings: [...quality.alerts, ...quality.warnings] },
    brief,
    stocks: {
      ok: input.stocks.order.filter((sym) => input.stocks.quotes[sym]?.price != null).length,
      total: input.stocks.order.length,
    },
  };
}
