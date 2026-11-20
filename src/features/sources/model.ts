// Sources page model (#/sources): sources.json joined with health.json, filters and the "N/M OK"
// summary. Pure.

import type { FeedHealthRow, FeedStatus, HealthFile, SourceInfo, SourcesFile } from "../../../shared/contract";
import { findSection, sectionOrder, type SectionId } from "../../../shared/sections";
import type { MuteSet } from "../../../shared/select";
import { matchesQuery, normalizeForSearch, parseQuery } from "../../../shared/text";
import { bareHost, isHttpUrl } from "../../../shared/url";

/** Feed status plus the two states health.json cannot express for a registry entry. */
export type SourceStatus = FeedStatus | "paused" | "unknown";

export const SOURCE_STATUSES: readonly SourceStatus[] = ["ok", "carried", "failing", "quarantined", "paused", "unknown"];

export const STATUS_LABEL: Readonly<Record<SourceStatus, string>> = {
  ok: "OK",
  carried: "Carried",
  failing: "Failing",
  quarantined: "Quarantined",
  paused: "Paused",
  unknown: "No data",
};

export const STATUS_HELP: Readonly<Record<SourceStatus, string>> = {
  ok: "Fetched and parsed with at least one item in the last build.",
  carried: "The last fetch failed, or its host was failing and was not asked again; items from the last good fetch (up to 6 hours old) are shown.",
  failing: "The last fetch failed and nothing could be carried forward.",
  quarantined: "Failed 48 builds in a row; skipped except for one probe a day.",
  paused: "Switched off in the registry; not fetched.",
  unknown: "No health record in the last build.",
};

export interface SourceRow {
  info: SourceInfo;
  health: FeedHealthRow | null;
  status: SourceStatus;
  failStreak: number;
  lastOkAt: string | null;
  /** Items contributed in the last build. */
  count: number;
  /** Human detail of the latest failure, when failing. */
  detail: string;
  sectionLabel: string;
  /** Homepage link target (http(s) only); for scrape sources the listing page. */
  homepage: string | null;
  feedUrl: string | null;
  muted: boolean;
}

const safeUrl = (u: string | undefined): string | null => (u && isHttpUrl(u) ? u : null);

function statusOf(info: SourceInfo, health: FeedHealthRow | undefined): SourceStatus {
  if (info.paused) return "paused";
  return health ? health.status : "unknown";
}

/**
 * One row per registry source (registry order kept inside a section; sections in homepage order).
 * Health rows without a registry entry are ignored - the registry is the list of record.
 */
export function buildSourceRows(sources: SourcesFile, health: HealthFile | null, mutes: MuteSet): SourceRow[] {
  const byId = new Map<string, FeedHealthRow>();
  for (const h of health?.feeds ?? []) byId.set(h.id, h);
  const rows = sources.sources.map((info, index) => {
    const h = byId.get(info.id);
    const status = statusOf(info, h);
    const row: SourceRow = {
      info,
      health: h ?? null,
      status,
      failStreak: h?.failStreak ?? 0,
      lastOkAt: h?.lastOkAt ?? null,
      count: h?.count ?? 0,
      detail: status === "ok" || status === "paused" ? "" : (h?.lastError ?? h?.error ?? ""),
      sectionLabel: findSection(info.home)?.label ?? String(info.home),
      homepage: safeUrl(info.homepage),
      feedUrl: safeUrl(info.feedUrl),
      muted: mutes.sources.has(info.id),
    };
    return { row, index };
  });
  rows.sort((a, b) => sectionOrder(a.row.info.home) - sectionOrder(b.row.info.home) || a.index - b.index);
  return rows.map((r) => r.row);
}

export interface SourceFilter {
  section: SectionId | "all";
  /** "problems" = everything that is not ok and not paused. */
  status: SourceStatus | "all" | "problems" | "muted";
  text: string;
}

export const NO_FILTER: SourceFilter = { section: "all", status: "all", text: "" };

function haystack(r: SourceRow): string {
  const i = r.info;
  return normalizeForSearch(
    [i.name, i.publisher, i.id, i.kind, i.scope, r.sectionLabel, ...(i.tags ?? []), ...(i.aliases ?? []), bareHost(i.homepage) ?? "", bareHost(i.feedUrl) ?? ""].join(" \n "),
  );
}

/**
 * Filter by section, status and free text (multi-word AND over name, publisher, id, kind, tags,
 * hosts). A filter box over short labels: every word may be a word PREFIX ("anth" finds Anthropic).
 */
export function filterSources(rows: readonly SourceRow[], filter: SourceFilter): SourceRow[] {
  const words = parseQuery(filter.text);
  return rows.filter((r) => {
    if (filter.section !== "all" && r.info.home !== filter.section) return false;
    if (filter.status === "problems") {
      if (r.status === "ok" || r.status === "paused") return false;
    } else if (filter.status === "muted") {
      if (!r.muted) return false;
    } else if (filter.status !== "all" && r.status !== filter.status) return false;
    return words.length === 0 || matchesQuery(haystack(r), words, { prefix: true });
  });
}

export interface SourceSummary {
  /** Registry entries. */
  total: number;
  /** Entries that are fetched (not paused): the M of "N/M OK". */
  active: number;
  ok: number;
  carried: number;
  failing: number;
  quarantined: number;
  paused: number;
  unknown: number;
  muted: number;
}

export function summarize(rows: readonly SourceRow[]): SourceSummary {
  const s: SourceSummary = { total: rows.length, active: 0, ok: 0, carried: 0, failing: 0, quarantined: 0, paused: 0, unknown: 0, muted: 0 };
  for (const r of rows) {
    s[r.status]++;
    if (r.status !== "paused") s.active++;
    if (r.muted) s.muted++;
  }
  return s;
}

/** "185/207 OK" plus the non-zero problem counts. */
export function summaryLine(s: SourceSummary): string {
  const parts = [`${s.ok}/${s.active} OK`];
  if (s.carried) parts.push(`${s.carried} carried forward`);
  if (s.failing) parts.push(`${s.failing} failing`);
  if (s.quarantined) parts.push(`${s.quarantined} quarantined`);
  if (s.unknown) parts.push(`${s.unknown} without data`);
  if (s.paused) parts.push(`${s.paused} paused`);
  return parts.join(" · ");
}

/** Sections that have at least one source, in homepage order (for the section filter). */
export function sectionsWithSources(rows: readonly SourceRow[]): { id: SectionId; label: string; count: number }[] {
  const counts = new Map<SectionId, number>();
  for (const r of rows) counts.set(r.info.home, (counts.get(r.info.home) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => sectionOrder(a[0]) - sectionOrder(b[0]))
    .map(([id, count]) => ({ id, label: findSection(id)?.label ?? id, count }));
}

/** Source tier as shown in the table: 1 is the highest trust / priority tier, 4 the lowest. */
export function tierLabel(tier: number): string {
  if (tier === 1) return "1 · top";
  if (tier === 4) return "4 · low";
  return String(tier);
}
