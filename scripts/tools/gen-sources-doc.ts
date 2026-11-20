// docs/SOURCES.md generator: the source registry as one readable, reviewable document.
//
//   npm run docs:sources                          registry + public/data/v2/health.json -> docs/SOURCES.md
//   npm run docs:sources -- --report audit.json   status columns from a validate-feeds verdict file
//   npm run docs:sources -- --out /tmp/SOURCES.md  write somewhere else ("-" = stdout)
//
// Status data, first match wins:
//   1. --report <file> or env VALIDATE_OUT   the verdict JSON of `npm run validate:feeds` (status = the
//                                            audit verdict, items = items in the feed; no "last OK")
//   2. --health <file>                       a health.json (default public/data/v2/health.json: status,
//                                            last OK and item count of the latest build)
//   3. neither readable                      the status columns say "-"
//
// The output is DETERMINISTIC: sections in homepage order, sources by tier then name, no clock. The
// one date in the document is the generated-at line, copied from the status data (health.json
// `generatedAt`); running the tool twice on the same inputs writes the same bytes.
//
// The feeds of REMOVED sources are printed without "https://" on purpose: they are dead, and
// check-links reads every URL in docs/*.md.
//
// `renderSourcesDoc` is pure (registry + status in, Markdown out) and is what the tests exercise.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECTIONS } from "../../shared/sections";
import type { PublisherDef, SourceDef } from "../registry/types";

/** Structural copy of the registry's RemovedSource (the tool takes any list of this shape). */
export interface RemovedEntry {
  name: string;
  url: string;
  reason: string;
  detail: string;
  coveredBy?: string;
}

/** Status of one source as the document shows it. */
export interface SourceStatus {
  /** "ok", "carried", "failing", "quarantined" (health.json) or a validate-feeds verdict ("OK", "HTTP_502", ...). */
  status: string;
  /** True when the status means the source delivered. */
  ok: boolean;
  /** ISO time of the last successful fetch; null = never / not recorded by this kind of report. */
  lastOkAt: string | null;
  /** Items the source contributed (health.json) or listed (verdict file); null = unknown. */
  items: number | null;
  /** Short failure detail ("HTTP 502"). */
  detail?: string;
}

export interface StatusData {
  /** "health" = a build's health.json; "validation" = a validate-feeds verdict file; "none" = no status data. */
  kind: "health" | "validation" | "none";
  /** ISO time the status data was generated (health.json generatedAt); null when the data carries none. */
  generatedAt: string | null;
  /** Repo-relative path (or file name) the data was read from, for the header line. */
  origin: string;
  byId: ReadonlyMap<string, SourceStatus>;
}

export interface SourcesDocInput {
  sources: readonly SourceDef[];
  publishers: readonly PublisherDef[];
  removed: readonly RemovedEntry[];
  status: StatusData;
}

export const NO_STATUS: StatusData = { kind: "none", generatedAt: null, origin: "", byId: new Map() };

// ------------------------------------------------------------------------------------------------
// Status data
// ------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Status data from a parsed JSON document of either supported shape: a HealthFile
 * (`{ generatedAt, feeds: [{ id, status, count, lastOkAt, lastError }] }`) or a validate-feeds
 * verdict array (`[{ id, verdict, itemCount }]`). Anything else yields null. Tolerant by design:
 * the file comes from disk and a malformed row is skipped, never fatal.
 */
export function parseStatusData(doc: unknown, origin: string): StatusData | null {
  if (Array.isArray(doc)) {
    const byId = new Map<string, SourceStatus>();
    for (const row of doc) {
      if (!isRec(row)) continue;
      const id = str(row.id);
      const verdict = str(row.verdict);
      if (!id || !verdict) continue;
      const s: SourceStatus = { status: verdict, ok: verdict === "OK", lastOkAt: null, items: count(row.itemCount) };
      const note = str(row.note);
      if (!s.ok && note) s.detail = note;
      byId.set(id, s);
    }
    return byId.size > 0 ? { kind: "validation", generatedAt: null, origin, byId } : null;
  }
  if (isRec(doc) && Array.isArray(doc.feeds)) {
    const byId = new Map<string, SourceStatus>();
    for (const row of doc.feeds) {
      if (!isRec(row)) continue;
      const id = str(row.id);
      const status = str(row.status);
      if (!id || !status) continue;
      const s: SourceStatus = { status, ok: row.ok === true, lastOkAt: isIso(row.lastOkAt) ? row.lastOkAt : null, items: count(row.count) };
      const detail = str(row.lastError);
      if (!s.ok && detail) s.detail = detail;
      byId.set(id, s);
    }
    return { kind: "health", generatedAt: isIso(doc.generatedAt) ? doc.generatedAt : null, origin, byId };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Markdown helpers
// ------------------------------------------------------------------------------------------------

/** Text for a table cell: one line, no cell break, no accidental HTML. */
export function cell(text: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A code span that cannot be closed early or break the table. */
function code(text: string): string {
  const t = text.replace(/[`|\s]+/g, " ").trim();
  return t ? `\`${t}\`` : "";
}

/** A Markdown link whose destination survives parentheses, spaces and pipes in the URL. */
export function link(label: string, url: string | undefined): string {
  if (!url) return "";
  const dest = url.trim().replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s/g, "%20");
  return `[${label}](<${dest}>)`;
}

/** "2026-11-20T02:24:40.961Z" -> "2026-11-20 02:24Z" (UTC, minute precision). */
export function shortTime(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "-" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

const byText = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Tier, then display name (case-insensitive, code-unit order: no locale), then id. */
export function sortSources(sources: readonly SourceDef[]): SourceDef[] {
  return [...sources].sort((a, b) => a.tier - b.tier || byText(a.name, b.name) || byText(a.id, b.id));
}

const isPaused = (s: SourceDef): boolean => s.status === "paused";
const FEED_LABEL: Readonly<Record<string, string>> = { scrape: "page", json: "api" };

function statusCells(s: SourceDef, status: StatusData): [string, string, string] {
  if (isPaused(s)) return ["paused", "-", "-"];
  const st = status.byId.get(s.id);
  if (!st) return ["-", "-", "-"];
  const label = st.ok || !st.detail ? st.status : `${st.status} (${st.detail.slice(0, 60)})`;
  return [cell(label), shortTime(st.lastOkAt), st.items === null ? "-" : String(st.items)];
}

// ------------------------------------------------------------------------------------------------
// The document
// ------------------------------------------------------------------------------------------------

const HOW_TO_ADD: readonly string[] = [
  "## How to add a source",
  "",
  "1. **Validate the feed first.** Put the candidate in a JSON file (`[{ \"name\": \"...\", \"url\": \"...\" }]`) and run `npm run validate:feeds -- candidates.json`. It uses the build's own HTTP client and parsers; only add a source whose verdict is `OK`. A site without a feed needs `kind: \"scrape\"` with a `scrape` config (listing page + link pattern) or `kind: \"json\"` with a `jsonApi` config.",
  "2. **Check it is not already covered.** Search this file for the host. A feed that was removed on purpose is listed under *Removed sources* with the reason; do not re-add it without new evidence.",
  "3. **Add the entry** to the file of its home section in `scripts/registry/sources/` (`queries.ts` for Google News queries and Hacker News searches, `releases.ts` for GitHub release feeds, `scrapers.ts` for scraped pages). Required fields: `id` (kebab slug, never reused), `name`, `publisher`, `url`, `kind`, `scope`, `home`, `tier`. Add the publisher to `scripts/registry/publishers.ts` when it is new (id, display name, registrable hosts).",
  "4. **Choose scope and tier honestly.** `scope: \"ai\"` means every item is on-mission and is never gated; `scope: \"general\"` sends every item through the relevance gate (or the source's own `include` list) and requires a `note` saying what the source is expected to yield. Tiers: 1 = first-party frontier-lab feeds and the owner's own regulators; 2 = original reporting, primary research, primary regulator documents; 3 = trade press, vendor blogs, newsletters, tracked changelogs (the ceiling for query feeds); 4 = digests, community, long-tail feeds (rendered de-emphasised). A release feed is never tier 1.",
  "5. **Bound noisy feeds** with `include` / `exclude` terms, `includeUrl` / `excludeUrl`, `maxItems` (ingest window), `maxKept` (rows per build) and `maxAgeDays` (at most 45).",
  "6. **Run the checks:** `npx tsc -b`, then `npx tsx --tsconfig tsconfig.app.json --test scripts/registry/registry.test.ts`. The registry validates itself at import, so a bad entry fails every test rather than one CI run.",
  "7. **Regenerate this file** with `npm run docs:sources` after the next data build and commit it with the registry change.",
  "",
  "To retire a source, set `status: \"paused\"` with a `note` saying why (it stays listed and is not fetched). Delete an entry only when it is gone for good, and record a V1-era source in `scripts/registry/sources/removed.ts` with the reason.",
];

function statusLine(status: StatusData): string {
  if (status.kind === "health") {
    return `Status columns: build health (${code(status.origin)}), generated at ${status.generatedAt ?? "an unrecorded time"}. *Status* is the source's result in that build, *Last OK* its last successful fetch (UTC), *Items* the items it contributed.`;
  }
  if (status.kind === "validation") {
    return `Status columns: feed validation report (${code(status.origin)}; the report carries no timestamp). *Status* is the audit verdict, *Items* the items the feed listed; a validation report does not record *Last OK*.`;
  }
  return "Status columns: no build health or validation report was available when this file was generated.";
}

/** The whole document. Pure and deterministic: the same input always yields the same string. */
export function renderSourcesDoc(input: SourcesDocInput): string {
  const { sources, publishers, removed, status } = input;
  const publisherName = new Map(publishers.map((p) => [p.id, p.name]));
  const active = sources.filter((s) => !isPaused(s));
  const usedPublishers = new Set(sources.map((s) => s.publisher)).size;
  const lines: string[] = [];
  const push = (...l: string[]): void => void lines.push(...l);

  push(
    "# AI DRUDGE V2 - Sources",
    "",
    "<!-- GENERATED by scripts/tools/gen-sources-doc.ts (npm run docs:sources). Do not edit by hand: change scripts/registry/ and regenerate. -->",
    "",
    `${sources.length} sources (${active.length} active, ${sources.length - active.length} paused) from ${usedPublishers} publishers, grouped by home section in homepage order. Within a section: tier, then name.`,
    "",
    statusLine(status),
    "",
  );

  // ---- Summary -------------------------------------------------------------------------------
  const known = new Set<string>(SECTIONS.map((s) => s.id));
  const groups: { id: string; label: string; list: SourceDef[] }[] = SECTIONS.map((sec) => ({ id: sec.id, label: sec.label, list: sortSources(sources.filter((s) => s.home === sec.id)) }));
  // A home the section list does not know must never vanish from the document.
  const orphans = sortSources(sources.filter((s) => !known.has(s.home)));
  if (orphans.length) groups.push({ id: "unknown", label: "UNKNOWN SECTION", list: orphans });

  push("## Summary", "", "| Section | Sources | Active | Tier 1 | Tier 2 | Tier 3 | Tier 4 | OK | Not OK |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const tierCount = (list: readonly SourceDef[], tier: number): number => list.filter((s) => s.tier === tier).length;
  const okCount = (list: readonly SourceDef[]): number => list.filter((s) => !isPaused(s) && status.byId.get(s.id)?.ok === true).length;
  const badCount = (list: readonly SourceDef[]): number => list.filter((s) => !isPaused(s) && status.byId.get(s.id)?.ok === false).length;
  const summaryRow = (label: string, list: readonly SourceDef[]): string => {
    const act = list.filter((s) => !isPaused(s)).length;
    const st = status.kind === "none" ? ["-", "-"] : [String(okCount(list)), String(badCount(list))];
    return `| ${label} | ${list.length} | ${act} | ${tierCount(list, 1)} | ${tierCount(list, 2)} | ${tierCount(list, 3)} | ${tierCount(list, 4)} | ${st[0]} | ${st[1]} |`;
  };
  for (const g of groups) if (g.list.length) push(summaryRow(`[${cell(g.label)}](#${g.id})`, g.list));
  push(summaryRow("**All**", sources), "");

  const kinds = [...new Set(sources.map((s) => s.kind))].sort(byText);
  push("| Kind | Sources |", "|---|---:|", ...kinds.map((k) => `| ${code(k)} | ${sources.filter((s) => s.kind === k).length} |`), "");

  const notOk = sortSources(active.filter((s) => status.byId.get(s.id)?.ok === false));
  if (status.kind !== "none") {
    push(`### Not OK in the status data (${notOk.length})`, "");
    if (notOk.length === 0) push("None.", "");
    else {
      push("| Source | Section | Status | Last OK | Items |", "|---|---|---|---|---:|");
      for (const s of notOk) {
        const [st, last, items] = statusCells(s, status);
        push(`| ${cell(s.name)} ${code(s.id)} | ${cell(s.home)} | ${st} | ${last} | ${items} |`);
      }
      push("");
    }
  }

  // ---- Sections ------------------------------------------------------------------------------
  push("## Sources by home section", "");
  for (const g of groups) {
    if (g.list.length === 0) continue;
    push(`<a id="${g.id}"></a>`, "", `### ${g.label} (${g.list.length})`, "", "| Source | Kind | Tier | Scope | Status | Last OK | Items | Links | Tags | Notes |", "|---|---|---:|---|---|---|---:|---|---|---|");
    for (const s of g.list) {
      const [st, last, items] = statusCells(s, status);
      const pub = publisherName.get(s.publisher);
      const who = pub && pub !== s.name ? `<br>${cell(pub)}` : "";
      const links = [link(FEED_LABEL[s.kind] ?? "feed", s.url), link("home", s.homepage)].filter(Boolean).join(" ");
      const tags = [...(s.tags ?? [])].sort(byText).map(code).filter(Boolean).join(" ");
      push(`| ${cell(s.name)}<br>${code(s.id)}${who} | ${code(s.kind)} | ${s.tier} | ${cell(s.scope)} | ${st} | ${last} | ${items} | ${links} | ${tags} | ${cell(s.note)} |`);
    }
    push("");
  }

  // ---- Removed -------------------------------------------------------------------------------
  push(`## Removed sources (${removed.length})`, "", "V1 sources that were not carried into V2 (`scripts/registry/sources/removed.ts`). Feed addresses are shown without the scheme: they are dead or retired and are not link-checked.", "");
  if (removed.length === 0) push("None.", "");
  else {
    push("| V1 name | V1 feed | Reason | Detail | Covered by |", "|---|---|---|---|---|");
    for (const r of [...removed].sort((a, b) => byText(a.name, b.name) || byText(a.url, b.url))) {
      push(`| ${cell(r.name)} | ${code(r.url.replace(/^https?:\/\//i, ""))} | ${cell(r.reason)} | ${cell(r.detail)} | ${r.coveredBy ? code(r.coveredBy) : "-"} |`);
    }
    push("");
  }

  push(...HOW_TO_ADD, "");
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_OUT = "docs/SOURCES.md";
export const DEFAULT_HEALTH = "public/data/v2/health.json";
/** The variable validate-feeds writes its verdict file to; the same name selects it here. */
export const REPORT_ENV = "VALIDATE_OUT";

export interface DocArgs {
  out: string;
  report: string | null;
  health: string;
}

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): DocArgs {
  const args: DocArgs = { out: DEFAULT_OUT, report: (env[REPORT_ENV] ?? "").trim() || null, health: DEFAULT_HEALTH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = argv[i + 1];
    if ((a === "--out" || a === "--report" || a === "--health") && value !== undefined && (value === "-" || !value.startsWith("--"))) {
      if (a === "--out") args.out = value;
      else if (a === "--report") args.report = value;
      else args.health = value;
      i++;
    } else throw new Error(`unknown or incomplete argument: ${a} (usage: gen-sources-doc.ts [--out <file | ->] [--report <verdicts.json>] [--health <health.json>])`);
  }
  return args;
}

async function readStatus(file: string, root: string): Promise<StatusData | null> {
  const abs = path.resolve(root, file);
  try {
    const rel = path.relative(root, abs);
    // Inside the repository the header names the repo-relative path; outside it only the file name
    // (a temp directory or a home directory does not belong in a committed document).
    const origin = rel.startsWith("..") || path.isAbsolute(rel) ? path.basename(abs) : rel.split(path.sep).join("/");
    return parseStatusData(JSON.parse(await readFile(abs, "utf8")), origin);
  } catch {
    return null;
  }
}

/** Status data for the CLI: the report when given and readable, else the health file, else none. */
export async function loadStatus(args: Pick<DocArgs, "report" | "health">, root: string, warn: (msg: string) => void = () => {}): Promise<StatusData> {
  if (args.report) {
    const fromReport = await readStatus(args.report, root);
    if (fromReport) return fromReport;
    warn(`gen-sources-doc: ${args.report} is not a readable validation report or health file - falling back to ${args.health}`);
  }
  const fromHealth = await readStatus(args.health, root);
  if (fromHealth) return fromHealth;
  warn(`gen-sources-doc: no status data (${args.health} is missing or unreadable) - the status columns will be empty`);
  return NO_STATUS;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, process.env);
  const { SOURCES, PUBLISHERS, REMOVED } = await import("../registry/index");
  const status = await loadStatus(args, ROOT, (msg) => console.warn(msg));
  const doc = renderSourcesDoc({ sources: SOURCES, publishers: PUBLISHERS, removed: REMOVED, status });
  if (args.out === "-") {
    process.stdout.write(doc);
    return 0;
  }
  const out = path.resolve(ROOT, args.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, doc);
  console.log(`Wrote ${path.relative(process.cwd(), out) || out}: ${SOURCES.length} sources, ${REMOVED.length} removed, status from ${status.kind === "none" ? "nothing" : `${status.origin} (${status.kind})`}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code_) => process.exit(code_),
    (e) => {
      console.error(`gen-sources-doc failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
