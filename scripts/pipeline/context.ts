// StageContext construction + pipeline-wide policy constants. The only runtime code WP0 owns in the
// pipeline; everything else in this directory is a stage owned by another package.

import { DEFAULT_MAX_KEPT } from "../registry/defaults";
import type { LogLevel, PipelineState, StageContext } from "./types";

/** Policy constants shared by more than one stage (V2_PLAN §1.3). Single source: do not re-declare. */
export const PIPELINE = {
  /** A failing feed's last-good items are carried forward for at most this long. */
  carryForwardMaxHours: 6,
  /** Consecutive failures after which a feed is quarantined. */
  quarantineAfterFails: 48,
  /** A quarantined feed gets one probe per this many hours. */
  quarantineProbeHours: 24,
  /** Default per-source cap applied AFTER relevance (keeps highest-tier / freshest); SourceDef.maxKept overrides it. */
  sourceCap: DEFAULT_MAX_KEPT,
  /** Dates further in the future than this are rejected (firstSeenAt is used instead). */
  maxFutureHours: 1,
  /** Recency half-life on effectiveAt, hours. */
  recencyHalfLifeHours: 36,
  /** TOP STORIES window, hours; relaxed window when fewer than topStoriesMin qualify. */
  topStoriesHours: 72,
  topStoriesRelaxedHours: 120,
  topStoriesMin: 4,
  /**
   * TOP STORIES rank a THINLY covered story (fewer than `topRecencyCapBelowPublishers` coverage
   * publishers) on its score with the recency part capped at `topRecencyCap` points (see
   * topStanding). 40 = the recency of a story about 12 h old (50 x 0.5^(12/36)): a pair of outlets
   * is the minimum that qualifies for TOP at all, and inside its first half day such a story is
   * ranked by what it is, not by how many minutes old it is. Live 2026-11-20: a 0.7 h-old
   * two-publisher item (recency 49.7 of 96.4 points) was TOP #3 and Daily Brief bullet 3, above a
   * three-publisher AI-assisted attack on the European Commission. A story three outlets cover keeps
   * its full recency - breaking news still rises at once, and a big story that is still growing
   * keeps the lead on its debut day (capping every story was measured: on the 2026-11-19 corpus the
   * lead went from the 16-publisher IPO to a 23 h-old launch). Section lists and the story score
   * itself are never capped: there the page still reads newest-first.
   */
  topRecencyCap: 40,
  topRecencyCapBelowPublishers: 3,
  /** Lead stability: keep the previous lead while it is in the top N and younger than this. */
  leadStickyTop: 3,
  leadStickyHours: 24,
  /** firstSeen ledger TTL in days (must exceed the longest section hard window, 21 d). */
  firstSeenTtlDays: 45,
  /** Summary / title caps. */
  summaryMaxChars: 320,
  titleMaxChars: 200,
  /** Response body cap in bytes. */
  maxBodyBytes: 5 * 1024 * 1024,
  /** status.json defaults. */
  cadenceMinutes: 30,
  /**
   * Age at which the published data counts as delayed. READER-FACING since the final round: the
   * client reads it from status.json and shows "Headlines may be delayed" past it (the client's own
   * constant STALE_BANNER_HOURS is only the fallback). 120 = four missed 30-minute builds. It was
   * 90, which one skipped scheduled run plus the CDN cache (10 min) plus the client's 10-minute
   * refresh can reach on a healthy pipeline; the banner must not flap. The gate's own freshness
   * check uses BUILD_STARTED_AT, not this number.
   */
  staleAfterMinutes: 120,
} as const;

/**
 * What a story counts for in TOP STORIES: its score, with the recency part capped at
 * PIPELINE.topRecencyCap while fewer than PIPELINE.topRecencyCapBelowPublishers publishers cover it.
 * Route ranks and holds TOP on it; the state stage remembers it (TopMemory.score).
 */
export function topStanding(story: { score: number; parts: { recency: number }; publishers: readonly unknown[] }): number {
  if (story.publishers.length >= PIPELINE.topRecencyCapBelowPublishers) return story.score;
  return story.score - Math.max(0, story.parts.recency - PIPELINE.topRecencyCap);
}

/** Environment variables the pipeline reads (through ctx.env - never process.env directly). */
export const ENV = {
  /** Public site URL for feed.xml / OPML links. Default https://pnelsonftp.github.io/ai-drudge-v2/ */
  siteUrl: "SITE_URL",
  /** Vite base path. Default /ai-drudge-v2/ */
  siteBase: "SITE_BASE",
  /** Claude API key for the brief; absent -> fallback brief. */
  anthropicKey: "ANTHROPIC_API_KEY",
  /** Optional honest identifying User-Agent for feed fetches. */
  userAgent: "FEED_USER_AGENT",
  /** GitHub Actions run metadata for status.json. */
  runId: "GITHUB_RUN_ID",
  runAttempt: "GITHUB_RUN_ATTEMPT",
  eventName: "GITHUB_EVENT_NAME",
  sha: "GITHUB_SHA",
  /** ISO time the CI job started the build (freshness gate: generatedAt >= BUILD_STARTED_AT). */
  buildStartedAt: "BUILD_STARTED_AT",
  /** Path of the state file run.ts reads and writes (default <dataDir>/state.json). */
  stateFile: "STATE_FILE",
  /** URL run.ts downloads the previous state from when the state file is missing (builds outside CI; the workflow restores the file itself). */
  stateUrl: "STATE_URL",
} as const;

export const DEFAULT_SITE_URL = "https://pnelsonftp.github.io/ai-drudge-v2/";
export const DEFAULT_SITE_BASE = "/ai-drudge-v2/";

/** Site URL from ctx.env with the default applied; always ends with "/". */
export function siteUrl(env: StageContext["env"]): string {
  const raw = (env[ENV.siteUrl] ?? "").trim() || DEFAULT_SITE_URL;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function emptyState(): PipelineState {
  return { firstSeen: {}, resolvedUrls: {}, health: {}, lastGood: {}, recent: [], lead: null };
}

export interface ContextInit {
  now?: Date;
  buildId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  log?: (level: LogLevel, msg: string) => void;
  state?: Readonly<PipelineState>;
}

/**
 * A line that starts with "::" is a GitHub Actions workflow command ("::error ...", "::add-mask::").
 * Log messages carry feed-controlled text (titles, error details), so a leading "::" on any line is
 * broken up before it reaches stdout; only reportOutcome (run.ts) writes real commands.
 */
export function neutraliseWorkflowCommands(msg: string): string {
  return msg.replace(/^::/gm, ": :");
}

function consoleLog(level: LogLevel, msg: string): void {
  const safe = neutraliseWorkflowCommands(msg);
  if (level === "error") console.error(`[error] ${safe}`);
  else if (level === "warn") console.warn(`[warn] ${safe}`);
  else console.log(safe);
}

/**
 * Production context. The ONLY place the real clock, process.env and global fetch are read.
 * buildId defaults to now.toISOString().
 */
export function createContext(init: ContextInit = {}): StageContext {
  const now = init.now ?? new Date();
  return {
    now,
    buildId: init.buildId ?? now.toISOString(),
    env: init.env ?? process.env,
    fetch: init.fetch ?? ((input, opts) => globalThis.fetch(input, opts)),
    log: init.log ?? consoleLog,
    state: init.state ?? emptyState(),
  };
}

/** Frozen clock of the 2026-11-19 fixtures (just after the live corpus was fetched at 20:59:34Z). */
export const TEST_NOW_ISO = "2026-11-19T21:00:00.000Z";

export interface TestContext extends StageContext {
  /** Everything logged through ctx.log, in order. */
  logs: { level: LogLevel; msg: string }[];
}

const networkDisabled: typeof fetch = (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(new Error(`network disabled in tests: ${url} (inject ctx.fetch)`));
};

/**
 * Deterministic context for tests: clock frozen at TEST_NOW_ISO, empty env, empty state, a fetch
 * that rejects (inject a fake to test network code), and a log that records into `ctx.logs`.
 */
export function createTestContext(init: ContextInit = {}): TestContext {
  const logs: TestContext["logs"] = [];
  const now = init.now ?? new Date(TEST_NOW_ISO);
  return {
    now,
    buildId: init.buildId ?? now.toISOString(),
    env: init.env ?? {},
    fetch: init.fetch ?? networkDisabled,
    log: init.log ?? ((level, msg) => void logs.push({ level, msg })),
    state: init.state ?? emptyState(),
    logs,
  };
}
