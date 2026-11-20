// "Validate every link": one bounded, polite pass over every URL the project points at.
//
//   (a) registry    every source's feed / page / API URL and its homepage
//   (b) docs        every http(s) URL in README.md and docs/*.md
//   (b') archive    every http(s) URL in docs/archive/**/*.md - checked and reported in their own
//                   group, but NOT counted: dated records legitimately cite feeds that were already
//                   dead when they were written, and editing history to please a link checker is wrong
//   (c) --data      every article URL in public/data/v2/river.json (newest first, capped)
//
//   tsx scripts/tools/check-links.ts [--data [river.json]] [--out <path>] [--strict]
//        [--no-registry] [--no-docs] [--max-data 300] [--delay 300] [--timeout 10000] [--budget 600]
//
// Each URL gets a HEAD; anything but a 2xx answer is retried once as a GET (many servers refuse HEAD).
// At most 2 requests per host at a time, with a pause between requests to the same host, and an
// overall time budget (URLs not reached are reported as "skipped").
//
// Output: <out>.json and <out>.md (default node_modules/.tmp/link-report) plus a summary table.
// Exit code: 0 - a third-party site having a bad minute must not fail a build. With --strict: 1 when
// any link is BROKEN (404 / 410 / other 4xx / DNS failure) or FLAKY (timeout / 5xx / connection error).
// Bot walls (401 / 403 / 406 / 429) are reported as BLOCKED and never fail the run. A URL referenced
// ONLY from docs/archive/ never fails the run either, whatever it answers.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RIVER } from "../../shared/contract";
import { bareHost, isHttpUrl } from "../../shared/url";
import type { SourceDef } from "../registry/types";
import { HTML_ACCEPT, httpFetch, type HttpDeps, type HttpResult } from "../pipeline/ingest/http";
import { HostPool, hostKey } from "../pipeline/ingest/pool";
import { createDeadline, sleep } from "../pipeline/ingest/timers";
import { cliDeps, loadRegistry } from "./validate-feeds";

export type LinkStatus = "ok" | "broken" | "blocked" | "flaky" | "skipped";

export interface LinkTarget {
  url: string;
  /** Where the URL is referenced ("registry:openai-news:feed", "docs:README.md", "archive:docs/archive/X.md", "data:river"). */
  refs: string[];
}

export interface LinkResult extends LinkTarget {
  status: LinkStatus;
  httpStatus?: number;
  /** Request that produced the result. */
  method?: "HEAD" | "GET";
  detail?: string;
  /** Set when the URL answered from another host. */
  movedTo?: string;
}

// ------------------------------------------------------------------------------------------------
// Collecting URLs
// ------------------------------------------------------------------------------------------------

const PLACEHOLDER = /[<>{}$*]|\.\.\.|…|%7B|\byour-|\bUSER\b|\bOWNER\b/i;
// Local hosts and the reserved documentation domains (RFC 2606 / 6761) are never requested.
const UNREACHABLE_HOST = /^(?:localhost|127\.|0\.0\.0\.0|\[::1\]|(?:.*\.)?example\.(?:com|org|net)$|.*\.(?:local|localhost|test|example|internal|invalid)$)/i;

/** A URL worth requesting: absolute http(s), public host, no template placeholders. */
export function isCheckable(url: string): boolean {
  if (!isHttpUrl(url) || PLACEHOLDER.test(url)) return false;
  const host = bareHost(url) ?? "";
  return host.includes(".") && !UNREACHABLE_HOST.test(host);
}

function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"`]+$/, "");
  // A trailing ")" belongs to the URL only when it closes a "(" inside it (Wikipedia-style links).
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1).replace(/[.,;:!?'"`]+$/, "");
  return url;
}

// A URL TEMPLATE is not a link. Two shapes survive the placeholder test of `isCheckable`, because
// the match stops at "<": the prefix of `https://host/feeds/<id>.xml` (the text goes on with a
// placeholder; "<br>" and closing tags are ordinary markup) and a placeholder written as an HTML
// entity (`https://host/&lt;slug>`). Both were reported as broken links of docs/SOURCE_RESEARCH.md.
const TEMPLATE_TAIL = /^<(?!br\b|\/)[a-z]/i;
const ESCAPED_PLACEHOLDER = /&(?:lt|gt);/i;

/** Every http(s) URL in a Markdown / text document, in order, de-duplicated. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\\^|\]]+/gi)) {
    if (ESCAPED_PLACEHOLDER.test(m[0]) || TEMPLATE_TAIL.test(text.slice(m.index + m[0].length, m.index + m[0].length + 4))) continue;
    const url = trimUrl(m[0]);
    if (!seen.has(url) && isCheckable(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export function registryTargets(sources: readonly SourceDef[]): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const s of sources) {
    out.push({ url: s.url, refs: [`registry:${s.id}:${s.kind === "scrape" ? "page" : s.kind === "json" ? "api" : "feed"}`] });
    if (s.homepage) out.push({ url: s.homepage, refs: [`registry:${s.id}:homepage`] });
  }
  return out;
}

/** Article URLs of a river.json document (tolerant of any JSON shape), newest first, capped. */
export function riverTargets(river: unknown, max: number): LinkTarget[] {
  const rows = river && typeof river === "object" && Array.isArray((river as { rows?: unknown }).rows) ? (river as { rows: unknown[] }).rows : [];
  const out: LinkTarget[] = [];
  for (const row of rows) {
    if (out.length >= max) break;
    const url = Array.isArray(row) ? row[RIVER.url] : null;
    if (typeof url === "string") out.push({ url, refs: ["data:river"] });
  }
  return out;
}

/** Merge target lists: one entry per URL with all its references; uncheckable URLs are dropped. */
export function mergeTargets(...lists: readonly LinkTarget[][]): LinkTarget[] {
  const byUrl = new Map<string, LinkTarget>();
  for (const t of lists.flat()) {
    if (!isCheckable(t.url)) continue;
    const have = byUrl.get(t.url);
    if (have) have.refs.push(...t.refs.filter((r) => !have.refs.includes(r)));
    else byUrl.set(t.url, { url: t.url, refs: [...t.refs] });
  }
  return [...byUrl.values()];
}

// ------------------------------------------------------------------------------------------------
// Checking
// ------------------------------------------------------------------------------------------------

const BLOCKED_STATUS = new Set([401, 403, 406, 429, 451, 999]);

/** Classify the final response of a link check. */
export function classify(res: HttpResult): { status: LinkStatus; httpStatus?: number; detail?: string } {
  if (res.kind !== "error") return { status: "ok", httpStatus: res.status };
  if (res.error === "http") {
    const code = res.httpStatus ?? 0;
    if (BLOCKED_STATUS.has(code)) return { status: "blocked", httpStatus: code, detail: res.detail };
    return { status: code >= 500 ? "flaky" : "broken", httpStatus: code, detail: res.detail };
  }
  if (res.error === "network" && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(res.detail)) return { status: "broken", detail: `DNS: ${res.detail}` };
  return { status: "flaky", detail: res.detail };
}

export interface CheckOptions {
  timeoutMs?: number;
}

/** HEAD, then GET when HEAD did not get a 2xx. At most three requests; never throws. */
export async function checkLink(target: LinkTarget, deps: HttpDeps, opts: CheckOptions = {}): Promise<LinkResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const req = { url: target.url, accept: HTML_ACCEPT, readBody: false, headerTimeoutMs: timeoutMs, totalTimeoutMs: timeoutMs };
  let method: "HEAD" | "GET" = "HEAD";
  let res = await httpFetch({ ...req, method: "HEAD", attempts: 1 }, deps);
  if (res.kind === "error" && !deps.deadline?.expired()) {
    method = "GET";
    // Two attempts: the second one uses a browser User-Agent when the honest one was refused.
    res = await httpFetch({ ...req, method: "GET", attempts: 2 }, deps);
  }
  const result: LinkResult = { ...target, ...classify(res), method };
  if (res.finalUrl && bareHost(res.finalUrl) !== bareHost(target.url)) result.movedTo = res.finalUrl;
  return result;
}

export interface CheckAllOptions extends CheckOptions {
  /** Pause after each request before the host slot is released (default 300 ms). */
  delayMs?: number;
  /** Overall budget in ms (default 10 minutes). URLs not started in time are "skipped". */
  budgetMs?: number;
  onResult?: (r: LinkResult) => void;
}

export async function checkAll(targets: readonly LinkTarget[], deps: HttpDeps, opts: CheckAllOptions = {}): Promise<LinkResult[]> {
  const pool = new HostPool({ perHost: 2, perHostOverrides: {}, maxTotal: 16 });
  const deadline = createDeadline(deps.timers, opts.budgetMs ?? 600_000);
  const scoped: HttpDeps = { ...deps, deadline };
  try {
    return await Promise.all(
      targets.map((t) =>
        pool.run(hostKey(t.url), async () => {
          let r: LinkResult;
          if (deadline.expired()) r = { ...t, status: "skipped", detail: "time budget exhausted" };
          else {
            r = await checkLink(t, scoped, opts).catch((e): LinkResult => ({ ...t, status: "flaky", detail: e instanceof Error ? e.message : String(e) }));
            await sleep(deps.timers, opts.delayMs ?? 300, deadline.signal);
          }
          opts.onResult?.(r);
          return r;
        }),
      ),
    );
  } finally {
    deadline.cancel();
  }
}

// ------------------------------------------------------------------------------------------------
// Report
// ------------------------------------------------------------------------------------------------

/** Reference group of historical records (docs/archive/**): checked and listed, never counted. */
export const ARCHIVE_GROUP = "archive";

const GROUP_ORDER: readonly string[] = ["registry", "docs", ARCHIVE_GROUP, "data"];

const groupOf = (ref: string): string => ref.split(":")[0];

/** True when every reference to the URL is a historical record: its failure is history, not a defect. */
export function isArchiveOnly(r: Pick<LinkTarget, "refs">): boolean {
  return r.refs.length > 0 && r.refs.every((ref) => groupOf(ref) === ARCHIVE_GROUP);
}

export interface LinkReport {
  generatedAt: string;
  /**
   * Per status: unique URLs with at least one LIVE reference (registry, current docs, data). URLs
   * referenced only from docs/archive/ are counted in `archiveOnly` instead, so a dead feed cited by
   * a dated record is never "broken". all = ok + broken + flaky + blocked + skipped + archiveOnly.
   */
  totals: Record<LinkStatus, number> & { all: number; moved: number; archiveOnly: number };
  /** Totals per reference group (registry / docs / archive / data), by the status actually measured. A URL referenced from two groups counts in both. */
  groups: Record<string, Record<LinkStatus, number>>;
  results: LinkResult[];
}

const STATUSES: readonly LinkStatus[] = ["ok", "broken", "flaky", "blocked", "skipped"];
const zero = (): Record<LinkStatus, number> => ({ ok: 0, broken: 0, flaky: 0, blocked: 0, skipped: 0 });

export function buildReport(results: readonly LinkResult[], generatedAt: string): LinkReport {
  const live = results.filter((r) => !isArchiveOnly(r));
  const totals = { ...zero(), all: results.length, moved: live.filter((r) => r.movedTo).length, archiveOnly: results.length - live.length };
  const groups: LinkReport["groups"] = {};
  for (const r of results) {
    if (!isArchiveOnly(r)) totals[r.status]++;
    for (const group of new Set(r.refs.map(groupOf))) {
      groups[group] ??= zero();
      groups[group][r.status]++;
    }
  }
  // Problems first; the long tail of healthy links last.
  const rank = (r: LinkResult): number => (r.status === "ok" ? STATUSES.length : STATUSES.indexOf(r.status));
  return { generatedAt, totals, groups, results: [...results].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url)) };
}

export function summaryTable(report: LinkReport): string {
  const head = ["group", "total", ...STATUSES];
  const label = (g: string): string => (g === ARCHIVE_GROUP ? `${g} (not counted)` : g);
  // Fixed group order (not the order problems happened to be found in), unknown groups last by name.
  const order = (g: string): number => (GROUP_ORDER.indexOf(g) + 1 || GROUP_ORDER.length + 1);
  const entries = Object.entries(report.groups).sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  const rows = entries.map(([g, c]) => [label(g), String(STATUSES.reduce((n, s) => n + c[s], 0)), ...STATUSES.map((s) => String(c[s]))]);
  const counted = report.totals.all - report.totals.archiveOnly;
  rows.push([report.totals.archiveOnly > 0 ? "ALL (unique, archive-only excluded)" : "ALL (unique)", String(counted), ...STATUSES.map((s) => String(report.totals[s]))]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join("  ");
  return [line(head), width.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

// Everything in the report can be third-party text: a redirect target is chosen by the remote host,
// and URLs keep [ ] ( ) in their paths, so "now at https://evil.example/[Re-authorize](https://evil.example/login)"
// written as plain text renders as a clickable link in the job summary. URLs and details therefore
// go into code spans (inert: no links, mentions or #refs); plain cells lose the link / HTML characters.
const mdCode = (s: string | undefined, max = 160): string => {
  // eslint-disable-next-line no-control-regex
  const text = (s ?? "").replace(/[|`\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text ? `\`${text}\`` : "";
};
// eslint-disable-next-line no-control-regex
const mdCell = (s: string | undefined): string => (s ?? "").replace(/[|`<>[\]()\u0000-\u001f\u007f]/g, " ").slice(0, 160);

export function reportMarkdown(report: LinkReport): string {
  const archived = report.totals.archiveOnly > 0 ? ` (${report.totals.archiveOnly} referenced only from docs/archive/, not counted)` : "";
  const lines = [`# Link check`, "", `Generated ${report.generatedAt}. ${report.totals.all} unique URLs${archived}.`, "", "```", summaryTable(report), "```", ""];
  const section = (title: string, rows: LinkResult[], note: string): void => {
    if (rows.length === 0) return;
    lines.push(`## ${title} (${rows.length})`, "", note, "", "| URL | HTTP | Detail | Referenced by |", "|---|---|---|---|");
    for (const r of rows) {
      const detail = r.movedTo ? `now at ${mdCode(r.movedTo)}` : mdCode(r.detail);
      const http = typeof r.httpStatus === "number" ? String(r.httpStatus) : "-";
      lines.push(`| ${mdCode(r.url) || "-"} | ${http} | ${detail} | ${mdCell(r.refs.slice(0, 4).join(", "))}${r.refs.length > 4 ? ` +${r.refs.length - 4}` : ""} |`);
    }
    lines.push("");
  };
  const live = report.results.filter((r) => !isArchiveOnly(r));
  const by = (s: LinkStatus): LinkResult[] => live.filter((r) => r.status === s);
  section("Broken", by("broken"), "The server says the page does not exist (4xx) or the host does not resolve. Fix or remove these.");
  section("Flaky", by("flaky"), "Timeout, 5xx or connection error. Re-run before acting.");
  section("Blocked", by("blocked"), "The server refuses automated requests (401 / 403 / 406 / 429). Usually fine in a browser.");
  section("Moved", live.filter((r) => r.status === "ok" && r.movedTo), "Answered from another host. Verify by hand before updating the reference.");
  section("Skipped", by("skipped"), "Not reached within the time budget.");
  section(
    "Archive: not reachable",
    report.results.filter((r) => isArchiveOnly(r) && r.status !== "ok"),
    "Referenced only from historical records under docs/archive/. Those records cite feeds and pages as they were on their date; a dead link there is expected, is not counted as broken and never fails the run. Do not edit the records.",
  );
  return lines.join("\n");
}

/** Exit code: 0 unless --strict and something with a live reference is broken or flaky (archive-only URLs are not in the totals). */
export function exitCode(report: LinkReport, strict: boolean): number {
  return strict && report.totals.broken + report.totals.flaky > 0 ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Directory of dated, historical records, relative to the repository root. */
export const ARCHIVE_DIR = "docs/archive";

async function markdownFiles(dir: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...(await markdownFiles(full, true)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * URLs of README.md and the Markdown files directly in docs/ (group "docs"), and of every Markdown
 * file under docs/archive/, recursively (group "archive").
 * Other sub-directories of docs/ are not read, as before.
 */
export async function docTargets(root: string): Promise<LinkTarget[]> {
  const rel = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  const files: { file: string; group: string }[] = [
    { file: path.join(root, "README.md"), group: "docs" },
    ...(await markdownFiles(path.join(root, "docs"), false)).map((file) => ({ file, group: "docs" })),
    ...(await markdownFiles(path.join(root, ARCHIVE_DIR), true)).map((file) => ({ file, group: ARCHIVE_GROUP })),
  ];
  const out: LinkTarget[] = [];
  for (const { file, group } of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const url of extractUrls(text)) out.push({ url, refs: [`${group}:${rel(file)}`] });
  }
  return out;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

export const USAGE =
  "usage: check-links.ts [--no-registry] [--no-docs] [--data [<river.json>]] [--max-data <n>] [--timeout <ms>] [--delay <ms>] [--budget <s>] [--out <report>] [--strict]   (NETWORK: about 800 URLs by default)";

const SWITCHES: ReadonlySet<string> = new Set(["--no-registry", "--no-docs", "--strict"]);
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--max-data", "--timeout", "--delay", "--budget", "--out"]);

/**
 * Refuse what this tool does not know BEFORE a single request (an unknown flag used to be ignored
 * and the full crawl started: about 2,200 URLs with --data). Returns "help", an error line, or null.
 */
export function checkArgs(argv: readonly string[]): "help" | string | null {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (SWITCHES.has(a)) continue;
    if (a === "--data") {
      if (next !== undefined && !next.startsWith("-")) i++; // the file is optional
    } else if (VALUE_FLAGS.has(a)) {
      if (next === undefined || next.startsWith("-")) return `${a} needs a value`;
      i++;
    } else return `unknown argument: ${a}`;
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const bad = checkArgs(argv);
  if (bad === "help") {
    console.log(USAGE);
    return 0;
  }
  if (bad !== null) {
    console.error(`check-links: ${bad}\n${USAGE}`);
    return 2;
  }
  const has = (name: string): boolean => argv.includes(name);
  const num = (name: string, fallback: number): number => {
    const n = Number(flagValue(argv, name));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const lists: LinkTarget[][] = [];
  if (!has("--no-registry")) {
    try {
      lists.push(registryTargets((await loadRegistry()).sources));
    } catch (e) {
      console.warn(`check-links: registry not available (${e instanceof Error ? e.message : e}) - skipping registry URLs`);
    }
  }
  if (!has("--no-docs")) lists.push(await docTargets(ROOT));
  if (has("--data")) {
    const file = flagValue(argv, "--data") ?? path.join(ROOT, "public/data/v2/river.json");
    try {
      lists.push(riverTargets(JSON.parse(await readFile(file, "utf8")), num("--max-data", 300)));
    } catch (e) {
      console.warn(`check-links: cannot read ${file} (${e instanceof Error ? e.message : e}) - skipping article URLs`);
    }
  }
  const targets = mergeTargets(...lists);
  console.log(`Checking ${targets.length} unique URLs (2 per host, ${num("--delay", 300)} ms pause, budget ${num("--budget", 600)} s)…`);

  let done = 0;
  const results = await checkAll(targets, cliDeps(), {
    timeoutMs: num("--timeout", 10_000),
    delayMs: num("--delay", 300),
    budgetMs: num("--budget", 600) * 1000,
    onResult: (r) => {
      done++;
      if (r.status !== "ok") console.log(`  ${r.status.toUpperCase().padEnd(8)} ${String(r.httpStatus ?? "-").padStart(3)}  ${r.url}${isArchiveOnly(r) ? "  (archive record - not counted)" : ""}`);
      else if (done % 100 === 0) console.log(`  … ${done}/${targets.length}`);
    },
  });

  const report = buildReport(results, new Date().toISOString());
  const out = (flagValue(argv, "--out") ?? path.join(ROOT, "node_modules/.tmp/link-report")).replace(/\.(json|md)$/i, "");
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(`${out}.json`, JSON.stringify(report, null, 2));
  await writeFile(`${out}.md`, reportMarkdown(report));
  console.log(`\n${summaryTable(report)}\n\nWrote ${out}.json and ${out}.md`);
  return exitCode(report, has("--strict"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error("check-links failed:", e);
      // An internal error is not third-party flakiness, but it must not block a build either unless asked to.
      process.exit(process.argv.includes("--strict") ? 1 : 0);
    },
  );
}
