// Audit of the V1 -> V2 source migration (kept after the import so docs and reviews can re-derive it).
//
//   npx tsx scripts/tools/import-sources.ts            markdown: totals + one row per V1 source
//   npx tsx scripts/tools/import-sources.ts --json     the same as JSON
//
// It reads the frozen V1 list (test/fixtures/v1/sources-v1.json) and the live registry; it writes
// nothing. The registry files under scripts/registry/sources/ are the source of truth and are edited
// by hand - this tool only reports what happened to each V1 entry (carried / renamed / url replaced /
// re-homed / removed) so the numbers in the docs never have to be counted manually.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { legacyToSections } from "../../shared/sections";
import { idForLegacyName, registryStats, REMOVED, sourceById, SOURCES, type RegistryStats } from "../registry/index";
import type { SourceDef } from "../registry/types";

export interface V1Row {
  name: string;
  url: string;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  type: "feed" | "scrape";
}

export interface MigrationRow {
  v1Name: string;
  v1Category: string;
  v1Priority: string;
  status: "carried" | "removed";
  id?: string;
  name?: string;
  home?: string;
  tier?: number;
  kind?: string;
  scope?: string;
  /** What changed: "renamed", "url", "re-homed", "tier", "paused", "now scraped". Empty = carried as is. */
  changes: string[];
  /** REMOVED.reason + detail for removed rows. */
  reason?: string;
}

const V1_TIER: Record<V1Row["priority"], number> = { critical: 1, high: 2, medium: 3, low: 4 };

function changesOf(row: V1Row, s: SourceDef): string[] {
  const out: string[] = [];
  if (s.name !== row.name) out.push("renamed");
  if (s.url !== row.url) out.push("url");
  const expectedHomes: readonly string[] = legacyToSections(row.category as Parameters<typeof legacyToSections>[0]);
  if (!expectedHomes.includes(s.home)) out.push("re-homed");
  if (s.tier !== V1_TIER[row.priority]) out.push(s.tier > V1_TIER[row.priority] ? "tier down" : "tier up");
  if (row.type === "feed" && s.kind === "scrape") out.push("now scraped");
  if (s.status === "paused") out.push("paused");
  return out;
}

/** One row per V1 source, in V1 order. Throws when a V1 name is neither carried nor documented as removed. */
export function migrationRows(v1: readonly V1Row[]): MigrationRow[] {
  return v1.map((row): MigrationRow => {
    const base = { v1Name: row.name, v1Category: row.category, v1Priority: row.priority };
    const id = idForLegacyName(row.name);
    const s = id === undefined ? undefined : sourceById(id);
    if (s) {
      return { ...base, status: "carried", id: s.id, name: s.name, home: s.home, tier: s.tier, kind: s.kind, scope: s.scope, changes: changesOf(row, s) };
    }
    const removed = REMOVED.find((r) => r.name === row.name);
    if (!removed) throw new Error(`V1 source "${row.name}" is neither in the registry nor in REMOVED`);
    return { ...base, status: "removed", changes: [], reason: `${removed.reason}: ${removed.detail}` };
  });
}

export interface MigrationReport {
  stats: RegistryStats;
  v1Total: number;
  carried: number;
  removed: number;
  /** Sources that did not exist in V1. */
  added: number;
  rows: MigrationRow[];
}

export function migrationReport(v1: readonly V1Row[]): MigrationReport {
  const rows = migrationRows(v1);
  const carriedIds = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  return {
    stats: registryStats(),
    v1Total: v1.length,
    carried: rows.filter((r) => r.status === "carried").length,
    removed: rows.filter((r) => r.status === "removed").length,
    added: SOURCES.filter((s) => !carriedIds.has(s.id)).length,
    rows,
  };
}

function counts(rec: Record<string, number>): string {
  return Object.entries(rec)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

export function renderMarkdown(report: MigrationReport): string {
  const { stats } = report;
  const cell = (s: string | number | undefined): string => String(s ?? "").replace(/\|/g, "\\|");
  const lines = [
    "# Source registry: V1 -> V2 migration",
    "",
    `- Registry: ${stats.total} sources (${stats.active} active, ${stats.paused} paused), ${stats.publishers} publishers with a source`,
    `- V1: ${report.v1Total} sources = ${report.carried} carried + ${report.removed} removed; ${report.added} sources are new in V2`,
    `- By section: ${counts(stats.byHome)}`,
    `- By kind: ${counts(stats.byKind)}`,
    `- By scope: ${counts(stats.byScope)}`,
    `- By tier: ${counts(stats.byTier)}`,
    "",
    "| V1 name | V1 category / priority | V2 id | home | tier | kind | changes |",
    "|---|---|---|---|---|---|---|",
    ...report.rows.map((r) =>
      r.status === "carried"
        ? `| ${cell(r.v1Name)} | ${r.v1Category} / ${r.v1Priority} | ${cell(r.id)} | ${r.home} | ${r.tier} | ${r.kind} | ${r.changes.join(", ")} |`
        : `| ${cell(r.v1Name)} | ${r.v1Category} / ${r.v1Priority} | REMOVED | | | | ${cell(r.reason)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function loadV1Rows(): V1Row[] {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/v1/sources-v1.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as V1Row[];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = migrationReport(loadV1Rows());
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}
