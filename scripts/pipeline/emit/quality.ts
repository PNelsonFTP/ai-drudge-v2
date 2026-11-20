// Content-quality rules of a data bundle: the part of the gate that needs no file system.
//
// Used twice so the two can never drift: emit records the verdict in status.json (`gate`), and
// scripts/tools/check-data.ts (the CI gate) runs the same function on the files it read back from
// disk and adds the file-level checks (guards, invariants, freshness, sizes, XML).
//
// Two tiers, from the review of 320 production runs: a FAILURE means the payload is structurally
// broken or hollow and must not replace the live site; a WARNING is published and surfaced.
// Feed health is tiered by failStreak: a feed that has been dead for many runs is a registry chore,
// not an outage, so it is taken out of the denominator instead of eating the margin that is meant
// to catch a real mass failure.

import type { ArticleId, ArticleV2 } from "../../../shared/contract";
import type { DataBundle } from "../../../shared/invariants";
import { findSection } from "../../../shared/sections";
import { DAY_MS, HOUR_MS, effectiveMs, parseMs } from "../../../shared/time";
import { PIPELINE } from "../context";
import { median } from "./common";

export const GATE = {
  /** Fewer distinct placed stories than this = hollow edition. */
  minStories: 60,
  warnStories: 120,
  /** Sections (of 15) that must have at least one homepage row. */
  minSectionsWithRows: 10,
  /** TOP STORIES below this is thin (warning only). */
  warnTopStories: 4,
  /**
   * A row older than this leaked through the age windows. The longest window route may legitimately
   * fill from is NOT a section's hardDays (21 d at most) but a source's own explicit registry
   * `maxAgeDays` (45 d today: Cloudflare PQ, Rodney Brooks, OWASP GenAI, ...), which extends the hard
   * window for the starvation fill. The ceiling sits above that with a margin, so one deliberately
   * placed old row in a starved section can never hold the whole site; quality.test.ts fails when a
   * registry edit outgrows it.
   */
  maxItemAgeDays: 60,
  /**
   * Content freeze: the pipeline wrote files (generatedAt is fresh) but the newest placed story is
   * this much older than the build. With ~400 feeds the largest real gap is about 6 h (weekend).
   */
  warnNewestAgeHours: 12,
  failNewestAgeHours: 24,
  /** OK share of LIVE feeds (chronic ones excluded) below which the run is a mass failure. */
  feedsFailBelow: 0.6,
  feedsWarnBelow: 0.85,
  /** Consecutive failed runs after which a feed counts as chronic (about 6 h at the 30 min cadence). */
  chronicFailStreak: 12,
  /** The chronic exemption must not hide a slow collapse: fail when this share of the registry is chronic. */
  chronicFailShare: 0.4,
  /**
   * "empty" feeds leave the live denominator, so they need their own cap: a parser or date-handling
   * regression also reads as "N items, none usable". Share of the whole registry answering empty
   * THIS run. Sources that are legitimately empty at times (arXiv, queries, hnrss) are about 8.5%.
   */
  emptyWarnShare: 0.1,
  emptyFailShare: 0.25,
  /** A tier-1 source failing this many runs in a row is called out by name. */
  tier1WarnStreak: 6,
  /** Field caps (payload backstop; normalize caps titles at 200 and summaries at 320). */
  maxTitleChars: 300,
  maxSummaryChars: 400,
  maxUrlChars: 2048,
  /** Stock ticker: fewer priced symbols than this is worth a warning. */
  warnStocksBelow: 4,
  /**
   * Consecutive builds whose Claude brief failed WITH a key configured after which the gate raises
   * an alert (about 3 h at the 30 min cadence). One failed call is a blip the fallback covers; six
   * in a row is an expired key, a retired model id or a rejected parameter, and nothing else would
   * tell the owner: the client simply stops showing the Daily Brief.
   */
  briefAlertStreak: 6,
} as const;

export type GateThresholds = { -readonly [K in keyof typeof GATE]: number };

export interface FeedTiers {
  total: number;
  ok: number;
  carried: number;
  /** Failing this run, not chronic, nothing carried. */
  failing: number;
  quarantined: number;
  /** Failing for >= chronicFailStreak runs, quarantined, or a failing probation source. Excluded from the live denominator. */
  chronic: number;
  /** Answered with a valid feed that had no usable items (a query with no hits, arXiv on a weekend). Excluded too - but capped by emptyWarnShare / emptyFailShare. */
  empty: number;
  /** total - chronic - empty. */
  live: number;
  /** ok / live (0 when there are no live feeds). */
  okShare: number;
  chronicIds: string[];
}

export interface QualityStats {
  stories: number;
  placements: number;
  top: number;
  frontRows: number;
  sectionsWithRows: number;
  emptySections: string[];
  medianAgeH: number | null;
  maxAgeDays: number | null;
  /** Share (0..1) of placed stories younger than 24 h; null without stories. */
  shareUnder24h: number | null;
  /** Newest placed story (effective time), epoch ms; null without stories. */
  newestMs: number | null;
  feeds: FeedTiers | null;
}

export interface QualityReport {
  failures: string[];
  warnings: string[];
  /**
   * Error-level signals that do NOT hold the build: the edition is good, but something needs the
   * owner (today: the Claude brief failing build after build). The CI alert job files an issue.
   */
  alerts: string[];
  stats: QualityStats;
}

export interface QualityOptions {
  /** The clock ages are measured against (ctx.now in emit, the real clock in the gate). */
  now: Date | number;
  thresholds?: Partial<GateThresholds>;
  /**
   * Consecutive failed Claude briefs INCLUDING this build (nextBriefFailStreak). Emit passes it;
   * the gate leaves it out and the count recorded in status.json (`brief.failStreak`) is used.
   */
  briefFailStreak?: number;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** First words of the failure run.ts records when nothing survived relevance and the previous edition was kept. */
export const ZERO_ARTICLES_PREFIX = "zero articles";

/** Fallback reasons that are a configuration choice or a quiet day, not a failure (no warning). */
export const BRIEF_QUIET_REASONS: ReadonlySet<string> = new Set(["no-key", "thin"]);

/**
 * Why a fallback brief was published: the coarse code enrich/brief.ts attaches as `fallbackReason`
 * ("no-key", "thin", "http-4xx", "timeout", ...). Read defensively - brief.json comes back from disk
 * in the gate, and the field is an optional addition older files do not carry. Never free text.
 */
export function briefFallbackReason(brief: unknown): string | null {
  const reason = typeof brief === "object" && brief !== null ? (brief as { fallbackReason?: unknown }).fallbackReason : undefined;
  return typeof reason === "string" && /^[a-z0-9][a-z0-9-]{0,23}$/.test(reason) ? reason : null;
}

const streakOf = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0);

/**
 * The brief failure streak a state object carries (`PipelineState.briefFailStreak`), 0 when absent.
 * Read defensively: the field is optional, and a state written before it existed has none.
 */
export function briefFailStreakOf(state: unknown): number {
  return typeof state === "object" && state !== null ? streakOf((state as { briefFailStreak?: unknown }).briefFailStreak) : 0;
}

/** The streak status.json recorded for its build (`brief.failStreak`), 0 when absent. */
export function statusBriefFailStreak(status: unknown): number {
  const brief = typeof status === "object" && status !== null ? (status as { brief?: unknown }).brief : undefined;
  return typeof brief === "object" && brief !== null ? streakOf((brief as { failStreak?: unknown }).failStreak) : 0;
}

/**
 * Fold this build's brief into the failure streak:
 *   Claude wrote it                         -> 0
 *   no key configured ("no-key")            -> 0   (the owner's choice; never an alert)
 *   too few stories to brief from ("thin")  -> unchanged (no call was made)
 *   a fallback that records no reason       -> unchanged (cannot tell whether a key was configured)
 *   any other fallback                      -> previous + 1 (a key is configured and the call failed)
 */
export function nextBriefFailStreak(previous: number, brief: unknown): number {
  const prev = streakOf(previous);
  const source = typeof brief === "object" && brief !== null ? (brief as { source?: unknown }).source : undefined;
  if (source !== "fallback") return 0;
  const reason = briefFallbackReason(brief);
  if (reason === "no-key") return 0;
  if (reason === null || reason === "thin") return prev;
  return prev + 1;
}

/** The alert line for a failure streak at or over the limit, or null. Built from the coarse reason code only. */
export function briefAlert(streak: number, brief: unknown, limit: number = GATE.briefAlertStreak): string | null {
  const source = typeof brief === "object" && brief !== null ? (brief as { source?: unknown }).source : undefined;
  const reason = briefFallbackReason(brief);
  // Silent without a key, on a thin day, without a recorded reason, and as soon as Claude writes the brief again.
  if (source !== "fallback" || reason === null || BRIEF_QUIET_REASONS.has(reason)) return null;
  if (streakOf(streak) < limit) return null;
  return `brief: the Claude brief has failed ${streakOf(streak)} builds in a row (${reason}) although an API key is configured - the Daily Brief is not shown; check the key, the model id and the API status`;
}

/** Registry tag of a source that is fetched on trial: its failures are expected and never count against a run. */
export const PROBATION_TAG = "probation";

/** `expected`: ids of sources whose failure is expected (probation); treated like chronic from the first failure. */
export function feedTiers(health: NonNullable<DataBundle["health"]>, chronicFailStreak: number, expected: ReadonlySet<string> = new Set()): FeedTiers {
  const t: FeedTiers = { total: health.feeds.length, ok: 0, carried: 0, failing: 0, quarantined: 0, chronic: 0, empty: 0, live: 0, okShare: 0, chronicIds: [] };
  for (const f of health.feeds) {
    if (f.ok) {
      t.ok++;
      continue;
    }
    if (f.status === "quarantined") t.quarantined++;
    if (f.status === "quarantined" || f.failStreak >= chronicFailStreak || expected.has(f.id)) {
      t.chronic++;
      t.chronicIds.push(f.id);
    } else if (f.error === "empty") t.empty++;
    else if (f.status === "carried") t.carried++;
    else t.failing++;
  }
  t.live = t.total - t.chronic - t.empty;
  t.okShare = t.live > 0 ? t.ok / t.live : 0;
  return t;
}

function checkFeeds(b: DataBundle, th: GateThresholds, failures: string[], warnings: string[]): FeedTiers | null {
  if (!b.health) return null;
  const name = new Map((b.sources?.sources ?? []).map((s) => [s.id, s]));
  const probation = new Set((b.sources?.sources ?? []).filter((s) => s.tags?.includes(PROBATION_TAG)).map((s) => s.id));
  const t = feedTiers(b.health, th.chronicFailStreak, probation);
  if (t.total === 0) {
    failures.push("feeds: health.json lists no feeds");
    return t;
  }
  const label = (id: string): string => name.get(id)?.name ?? id;
  const share = `${t.ok} of ${t.live} live feeds ok (${pct(t.okShare)}; ${t.chronic} chronic and ${t.empty} empty excluded, ${t.carried} carried forward)`;
  if (t.ok === 0) failures.push(`feeds: mass failure - 0 of ${t.total} feeds fetched this run`);
  else if (t.okShare < th.feedsFailBelow) failures.push(`feeds: mass failure - ${share}, below ${pct(th.feedsFailBelow)}`);
  else if (t.okShare < th.feedsWarnBelow) warnings.push(`feeds: ${share}, below ${pct(th.feedsWarnBelow)}`);
  const emptyShare = t.empty / t.total;
  const emptyLine = `feeds: ${t.empty} of ${t.total} feeds answered with no usable items this run (${pct(emptyShare)})`;
  if (emptyShare >= th.emptyFailShare) failures.push(`${emptyLine} - parser regression? (limit ${pct(th.emptyFailShare)})`);
  else if (emptyShare >= th.emptyWarnShare) warnings.push(`${emptyLine} - check the parser if this persists`);
  if (t.chronic / t.total >= th.chronicFailShare) {
    failures.push(`feeds: ${t.chronic} of ${t.total} feeds are chronic (failing >= ${th.chronicFailStreak} runs, quarantined or on probation)`);
  } else if (t.chronic > 0) {
    const shown = t.chronicIds.slice(0, 12).map(label).join(", ");
    warnings.push(`feeds: ${t.chronic} chronic (failing >= ${th.chronicFailStreak} runs, quarantined or on probation): ${shown}${t.chronic > 12 ? ", ..." : ""}`);
  }
  for (const f of b.health.feeds) {
    if (!f.ok && f.failStreak >= th.tier1WarnStreak && name.get(f.id)?.tier === 1) {
      warnings.push(`feeds: tier-1 source "${label(f.id)}" has failed ${f.failStreak} runs in a row${f.lastError ? ` (${f.lastError})` : ""}`);
    }
  }
  return t;
}

function checkFieldCaps(articles: readonly ArticleV2[], th: GateThresholds, failures: string[]): void {
  let titles = 0;
  let summaries = 0;
  let urls = 0;
  for (const a of articles) {
    if (a.title.length > th.maxTitleChars) titles++;
    if ((a.summary?.length ?? 0) > th.maxSummaryChars) summaries++;
    if (a.url.length > th.maxUrlChars) urls++;
  }
  if (titles) failures.push(`payload: ${titles} titles longer than ${th.maxTitleChars} chars`);
  if (summaries) failures.push(`payload: ${summaries} summaries longer than ${th.maxSummaryChars} chars`);
  if (urls) failures.push(`payload: ${urls} URLs longer than ${th.maxUrlChars} chars`);
}

/** True when the edition holds a story that should have made TOP STORIES (so an empty `top` is a bug, not a quiet day). */
function hasTopCandidate(b: DataBundle, nowMs: number): boolean {
  const articles: Record<ArticleId, ArticleV2> = { ...(b.rest?.articles ?? {}), ...b.front.articles };
  const clusters = { ...(b.rest?.clusters ?? {}), ...b.front.clusters };
  const placedAi = new Set<ArticleId>();
  for (const s of b.rest?.sections ?? b.front.sections) {
    if (findSection(s.id)?.desk === "ai") for (const id of s.rows) placedAi.add(id);
  }
  const windowMs = PIPELINE.topStoriesHours * HOUR_MS;
  for (const [lead, c] of Object.entries(clusters)) {
    const a = articles[lead];
    if (!a || c.publishers < 2) continue;
    if (a.flags?.includes("release") || a.flags?.includes("discussion")) continue;
    if (findSection(a.home)?.desk !== "ai" && !placedAi.has(lead)) continue;
    if (nowMs - effectiveMs(a) <= windowMs) return true;
  }
  return false;
}

/** Evaluate the content rules. Assumes the bundle passed shared/guards.ts (shapes are trusted). */
export function evaluateQuality(b: DataBundle, opts: QualityOptions): QualityReport {
  const th: GateThresholds = { ...GATE, ...opts.thresholds };
  const nowMs = typeof opts.now === "number" ? opts.now : opts.now.getTime();
  const failures: string[] = [];
  const warnings: string[] = [];
  const alerts: string[] = [];
  const { front, rest } = b;

  const frontRows = front.sections.reduce((n, s) => n + s.rows.length, 0);
  const emptySections = front.sections.filter((s) => s.rows.length === 0).map((s) => s.id);
  const sectionsWithRows = front.sections.length - emptySections.length;
  if (frontRows === 0) failures.push("blank: front.json has no rows in any section");
  else {
    if (front.counts.stories < th.minStories) failures.push(`hollow: ${front.counts.stories} stories < ${th.minStories}`);
    else if (front.counts.stories < th.warnStories) warnings.push(`thin: ${front.counts.stories} stories < ${th.warnStories}`);
    if (sectionsWithRows < th.minSectionsWithRows) {
      failures.push(`hollow: only ${sectionsWithRows} of ${front.sections.length} sections have rows (< ${th.minSectionsWithRows}); empty: ${emptySections.join(", ")}`);
    } else if (emptySections.length) warnings.push(`empty sections: ${emptySections.join(", ")}`);
    // Hollow homepage: a section shows fewer rows than it holds (the contract only bounds homepage
    // rows from above). The producers always emit min(homeRows, total), so anything less is a bug.
    const short = front.sections.flatMap((s) => {
      const want = Math.min(findSection(s.id)?.homeRows ?? 0, s.total);
      return s.rows.length < want ? [`${s.id} ${s.rows.length} of ${want}`] : [];
    });
    if (short.length) failures.push(`hollow homepage: ${short.length} section(s) show fewer rows than they hold (${short.join(", ")})`);
  }

  if (front.top.length === 0) {
    if (hasTopCandidate(b, nowMs)) failures.push("hollow: TOP STORIES is empty although multi-publisher ai-desk stories exist");
    else warnings.push("TOP STORIES is empty (no multi-publisher ai-desk story in the window)");
  } else if (front.top.length < th.warnTopStories) warnings.push(`TOP STORIES thin: ${front.top.length} < ${th.warnTopStories}`);

  // Ages of the placed stories (rows of the full lists when rest.json is present).
  const all: Record<ArticleId, ArticleV2> = { ...(rest?.articles ?? {}), ...front.articles };
  const leads = new Set<ArticleId>();
  for (const s of rest?.sections ?? front.sections) for (const id of s.rows) leads.add(id);
  const ages: number[] = [];
  let newestMs: number | null = null;
  let undated = 0;
  for (const id of leads) {
    const a = all[id];
    if (!a) continue;
    const t = parseMs(a.publishedAt) ?? parseMs(a.firstSeenAt);
    if (t === null) {
      undated++;
      continue;
    }
    ages.push(Math.max(0, nowMs - t));
    if (newestMs === null || t > newestMs) newestMs = t;
  }
  ages.sort((x, y) => x - y);
  const maxAgeDays = ages.length ? ages[ages.length - 1] / DAY_MS : null;
  const med = median(ages);
  if (undated) failures.push(`${undated} placed stories have no usable date`);
  if (maxAgeDays !== null && maxAgeDays > th.maxItemAgeDays) failures.push(`stale content: oldest row is ${maxAgeDays.toFixed(1)} d old (> ${th.maxItemAgeDays} d)`);
  // Content freeze: fresh files, old news (a date / dedupe / relevance regression downstream of ingest).
  const newestAgeH = newestMs === null ? null : (nowMs - newestMs) / HOUR_MS;
  if (newestAgeH !== null && newestAgeH > th.failNewestAgeHours) {
    failures.push(`frozen content: newest placed story is ${newestAgeH.toFixed(0)} h older than the build (> ${th.failNewestAgeHours} h)`);
  } else if (newestAgeH !== null && newestAgeH > th.warnNewestAgeHours) {
    warnings.push(`newest placed story is ${newestAgeH.toFixed(0)} h older than the build (> ${th.warnNewestAgeHours} h)`);
  }

  checkFieldCaps(Object.values(all), th, failures);
  const feeds = checkFeeds(b, th, failures, warnings);

  if (b.brief) {
    if (b.brief.source === "claude" && b.brief.bullets.length < 3) failures.push(`brief: claude brief has ${b.brief.bullets.length} bullets (< 3)`);
    if (b.brief.source === "fallback" && frontRows > 0 && b.brief.bullets.length === 0) warnings.push("brief: fallback brief is empty");
    // The client hides a fallback brief, so a permanently failing API call (expired key, retired
    // model, rejected parameter) would otherwise be invisible outside the build log.
    const reason = b.brief.source === "fallback" ? briefFallbackReason(b.brief) : null;
    if (reason !== null && !BRIEF_QUIET_REASONS.has(reason)) warnings.push(`brief: Claude brief unavailable (${reason}) - fallback published`);
    // The same failure build after build is no longer a warning to read some day: raise it.
    const alert = briefAlert(opts.briefFailStreak ?? statusBriefFailStreak(b.status), b.brief, th.briefAlertStreak);
    if (alert !== null) alerts.push(alert);
    if (/\breleased$/i.test(b.brief.headline.trim())) warnings.push(`brief: headline looks like a release tag ("${b.brief.headline}")`);
  }
  if (b.stocks) {
    const priced = b.stocks.order.filter((sym) => b.stocks?.quotes[sym]?.price != null).length;
    if (priced < th.warnStocksBelow) warnings.push(`stocks: ${priced} of ${b.stocks.order.length} symbols priced`);
  }

  return {
    failures,
    warnings,
    alerts,
    stats: {
      stories: front.counts.stories,
      placements: front.counts.placements,
      top: front.top.length,
      frontRows,
      sectionsWithRows,
      emptySections,
      medianAgeH: med === null ? null : Math.round((med / HOUR_MS) * 10) / 10,
      maxAgeDays: maxAgeDays === null ? null : Math.round(maxAgeDays * 10) / 10,
      shareUnder24h: ages.length ? ages.filter((x) => x < 24 * HOUR_MS).length / ages.length : null,
      newestMs,
      feeds,
    },
  };
}

/**
 * Freshness: the payload must have been generated by THIS build. `buildStartedAt` is the ISO time
 * the CI job wrote before running the pipeline (env BUILD_STARTED_AT); null when not in CI.
 * Returns a failure message, or null when fresh / not checkable.
 */
export function checkFreshness(generatedAt: string, buildStartedAt: string | null | undefined): string | null {
  const started = (buildStartedAt ?? "").trim();
  if (!started) return null;
  const startMs = parseMs(started);
  if (startMs === null) return `freshness: BUILD_STARTED_AT "${started}" is not a date`;
  const genMs = parseMs(generatedAt);
  if (genMs === null) return `freshness: generatedAt "${generatedAt}" is not a date`;
  if (genMs < startMs) return `stale: generatedAt ${generatedAt} is older than this build (started ${started}) - the pipeline did not write new data`;
  return null;
}
