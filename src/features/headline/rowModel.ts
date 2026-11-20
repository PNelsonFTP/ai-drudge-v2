// Pure view-model of one headline row. No React, no DOM: everything the row shows is derived here
// so it is unit-tested without rendering.

import type { ArticleFlag, ArticleId, ArticleV2, ClusterV2, SourceId, SourceRef } from "../../../shared/contract";
import type { SectionId } from "../../../shared/sections";
import { WEIGHT_CLASSES, weightOf } from "../../../shared/select";
import { NEW_WITHIN_HOURS, TIME_FILTER_HOURS, ageHours } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import type { HeadlineRowProps, RowItem } from "../../app/services";

/** "lead" is WP9-internal (the large TOP STORIES lead); the public slot accepts the other four. */
export type RowVariant = NonNullable<HeadlineRowProps["variant"]> | "lead";

export type WeightClass = (typeof WEIGHT_CLASSES)[number];

export interface RowData {
  id: ArticleId;
  title: string;
  /** null unless the URL is absolute http(s): saved snapshots and backups are untrusted input. */
  url: string | null;
  /** What the badge shows: the outlet for link-host items, else the source name. */
  label: string;
  /** Source display name (saved snapshots, "mute source" label). */
  sourceName: string;
  sourceId: SourceId | null;
  publishedAt: string | null;
  firstSeenAt: string | null;
  /** The time the row displays: publishedAt, else firstSeenAt. */
  displayAt: string | null;
  summary: string | null;
  section: SectionId | null;
  weightClass: WeightClass;
  flags: readonly ArticleFlag[];
  /** The edition article when the id is in the edition; null for river rows and saved snapshots. */
  article: ArticleV2 | null;
}

const NO_FLAGS: readonly ArticleFlag[] = [];
const DEFAULT_WEIGHT_CLASS: WeightClass = WEIGHT_CLASSES[1];

function safeUrl(url: string | null | undefined): string | null {
  return isHttpUrl(url) ? (url as string).trim() : null;
}

/**
 * Row data for `id`: the edition article when present (the `item` fallback still supplies the
 * section the row is listed under), else the fallback item, else null.
 */
export function resolveRow(id: ArticleId, article: ArticleV2 | undefined, source: SourceRef | undefined, item: RowItem | undefined): RowData | null {
  if (article) {
    const sourceName = source?.name ?? item?.sourceName ?? article.src;
    return {
      id,
      title: article.title,
      url: safeUrl(article.url),
      label: article.pub ?? sourceName,
      sourceName,
      sourceId: article.src,
      publishedAt: article.publishedAt,
      firstSeenAt: article.firstSeenAt,
      displayAt: article.publishedAt ?? article.firstSeenAt,
      summary: article.summary?.trim() || null,
      section: item?.section ?? article.home,
      weightClass: WEIGHT_CLASSES[weightOf(article)],
      flags: article.flags ?? NO_FLAGS,
      article,
    };
  }
  if (!item) return null;
  const firstSeenAt = item.firstSeenAt ?? null;
  return {
    id,
    title: item.title,
    url: safeUrl(item.url),
    label: item.sourceName,
    sourceName: item.sourceName,
    sourceId: item.sourceId ?? null,
    publishedAt: item.publishedAt,
    firstSeenAt,
    displayAt: item.publishedAt ?? firstSeenAt,
    summary: null,
    section: item.section ?? null,
    weightClass: DEFAULT_WEIGHT_CLASS,
    flags: NO_FLAGS,
    article: null,
  };
}

/**
 * NEW badge: first seen by the pipeline at most 6 h ago AND not seen by this reader in a previous
 * session. (V1 used publishedAt alone and badged 63% of the page.)
 */
export function isNewForReader(row: Pick<RowData, "firstSeenAt" | "publishedAt">, nowMs: number, seenBefore: boolean): boolean {
  if (seenBefore) return false;
  return ageHours(row.firstSeenAt ?? row.publishedAt, nowMs) <= NEW_WITHIN_HOURS;
}

/** A later outlet is worth a second time on the row only when it is at least this much newer. */
export const LATEST_COVERAGE_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * ISO time of the story's newest coverage when it is clearly later than the article the row
 * displays (at least LATEST_COVERAGE_MIN_GAP_MS), else null. `newestMs` is shared/select
 * storyNewestMs (0 = unknown / singleton). The time chips keep a story by its newest article, so a
 * row that reads "38h ago" under the 24H chip also says "latest 54m ago".
 */
export function latestCoverageAt(displayAt: string | null, newestMs: number): string | null {
  if (!displayAt || !Number.isFinite(newestMs) || newestMs <= 0) return null;
  const shown = Date.parse(displayAt);
  if (Number.isNaN(shown) || newestMs - shown < LATEST_COVERAGE_MIN_GAP_MS) return null;
  return new Date(newestMs).toISOString();
}

/** 0 = within 6 h, 1 = within 24 h, 2 = within 3 days, 3 = older: the windows of the time chips. */
function timeWindow(iso: string, nowMs: number): number {
  const h = ageHours(iso, nowMs);
  return h <= TIME_FILTER_HOURS["6h"] ? 0 : h <= TIME_FILTER_HOURS["24h"] ? 1 : h <= TIME_FILTER_HOURS["3d"] ? 2 : 3;
}

/**
 * Does the row print "latest <time>" next to its own time? Only when the newest coverage falls in
 * a fresher time-chip window (6 h / 24 h / 3 days) than the article on display - the case in which
 * the displayed age alone would contradict the chip that keeps the row. On the 2026-11-20 edition
 * that is 15 of 143 homepage rows; "any outlet an hour later" would have been 27.
 */
export function showsLatestCoverage(displayAt: string | null, latestAt: string | null, nowMs: number): boolean {
  return displayAt !== null && latestAt !== null && timeWindow(latestAt, nowMs) < timeWindow(displayAt, nowMs);
}

/** N of the "+N" coverage button: other publishers covering the story. */
export function coverageExtra(cluster: ClusterV2 | undefined): number {
  return Math.max(0, (cluster?.publishers ?? 1) - 1);
}

/**
 * Index in the "Also:" list at which the outlets that do NOT count as coverage begin: the list
 * holds the `counted` other publishers first (ClusterV2 member-order contract), then pointer-only
 * and unvetted outlets. `total` when `counted` is not given (everything is listed under "Also:").
 */
export function alsoSplit(total: number, counted: number | undefined): number {
  return counted === undefined ? total : Math.max(0, Math.min(total, counted));
}

/** Accessible name of the row's coverage button: "+N more outlets covering: <title>", or the uncounted-links form. */
export function alsoButtonLabel(extra: number, title: string): string {
  return extra > 0 ? `+${extra} more ${extra === 1 ? "outlet" : "outlets"} covering: ${title}` : `Other outlets linking: ${title}`;
}

export const FLAG_LABELS: Readonly<Record<ArticleFlag, string>> = {
  release: "release",
  paper: "paper",
  discussion: "thread",
  paywall: "paywall",
};

export const FLAG_TITLES: Readonly<Record<ArticleFlag, string>> = {
  release: "Software release notes",
  paper: "Research paper listing",
  discussion: "Community discussion thread",
  paywall: "This source usually requires a subscription",
};

/**
 * The saved store snapshots an ArticleV2. River rows and saved snapshots are not edition articles,
 * so build the smallest valid one from the row (the store keeps id / title / url / publishedAt).
 */
export function articleForSaving(row: RowData, nowMs: number): ArticleV2 {
  if (row.article) return row.article;
  return {
    id: row.id,
    url: row.url ?? "",
    title: row.title,
    src: row.sourceId ?? "",
    publishedAt: row.publishedAt,
    firstSeenAt: row.firstSeenAt ?? row.publishedAt ?? new Date(nowMs).toISOString(),
    home: row.section ?? "industry",
    tier: 3,
  };
}

function sameItem(a: RowItem | undefined, b: RowItem | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.url === b.url &&
    a.sourceName === b.sourceName &&
    a.sourceId === b.sourceId &&
    a.publishedAt === b.publishedAt &&
    a.firstSeenAt === b.firstSeenAt &&
    a.section === b.section
  );
}

/**
 * React.memo comparator. Pages build a fresh `item` object per render (river rows are tuples), so
 * compare it by value; everything else by identity.
 */
export function rowPropsEqual(
  a: Readonly<Omit<HeadlineRowProps, "variant"> & { variant?: RowVariant }>,
  b: Readonly<Omit<HeadlineRowProps, "variant"> & { variant?: RowVariant }>,
): boolean {
  return a.id === b.id && a.variant === b.variant && a.showSection === b.showSection && a.onOpen === b.onOpen && sameItem(a.item, b.item);
}

/**
 * Keyboard contract: does the ROW take a shell key action itself? The shell saves / mutes an
 * article it finds in the edition (and announces it); a river row or saved snapshot is unknown to
 * it, so the row claims those actions.
 */
export function rowClaims(row: Pick<RowData, "article">, action: string): boolean {
  return row.article === null && (action === "bookmark" || action === "later" || action === "mute");
}

/** Outlets shown inline on an "Also:" line before the "+N more" button. */
export const ALSO_INLINE_MAX = 8;
