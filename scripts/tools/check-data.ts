// The data gate: decides whether a freshly built data set may replace the live one.
//
//   npx tsx scripts/tools/check-data.ts [--dir public/data/v2] [--public public] [--write-status]
//
// Exit 0 = publish, exit 1 = hold (the previous deploy keeps serving); every failure is printed with
// a precise reason. Checks, in order:
//   1. every file exists, parses, and passes its guard (shared/guards.ts)
//   2. cross-file invariants (shared/invariants.ts checkBundle)
//   3. freshness - when BUILD_STARTED_AT is set (CI), generatedAt must not be older than it. V1 went
//      green 33 times while redeploying old data because nothing checked this. In GitHub Actions a
//      missing BUILD_STARTED_AT is itself a failure, and a "zero articles" marker left in status.json
//      by the pipeline (previous edition kept) is carried into the verdict.
//   4. content rules shared with emit (pipeline/emit/quality.ts): blank / hollow payloads, a hollow
//      homepage, an empty TOP STORIES that should not be empty, stale rows, frozen content, oversized
//      fields, tiered feed health, an unavailable Claude brief (warning)
//   5. file-level backstops: size ceilings, feed.xml / feeds.opml well-formedness
// Warnings never block; they are printed (as GitHub annotations in CI) and, with --write-status,
// recorded in status.json together with the verdict.
// Alerts never block either, but they are error-level: something needs the owner although the
// edition is good (the Claude brief has failed six builds in a row with a key configured). In CI
// each is an ::error annotation, and the first one is written to the step output `brief_alert`,
// which refresh.yml's alert job turns into a rolling issue. No key configured = no alert, ever.
//
// `evaluateGate` is pure (files in, verdict out) and is what the tests exercise.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { XMLValidator } from "fast-xml-parser";
import { DATA_DIR, DATA_FILES, type StatusFile } from "../../shared/contract";
import {
  validateBriefFile,
  validateEditionFront,
  validateEditionRest,
  validateHealthFile,
  validateRiverFile,
  validateSourcesFile,
  validateStatusFile,
  validateStocksFile,
} from "../../shared/guards";
import { checkBundle, type DataBundle } from "../../shared/invariants";
import { MINUTE_MS, parseMs } from "../../shared/time";
import { ENV, PIPELINE, siteUrl as configuredSiteUrl } from "../pipeline/context";
import { ATOM_FILE, ATOM_MAX_ENTRIES } from "../pipeline/emit/atom";
import { OPML_FILE } from "../pipeline/emit/opml";
import { ZERO_ARTICLES_PREFIX, briefFallbackReason, checkFreshness, evaluateQuality, type GateThresholds, type QualityStats } from "../pipeline/emit/quality";
import { SIZE_LIMITS, writeFileAtomic } from "../pipeline/emit/write";
import { hasXmlIllegal } from "../pipeline/emit/xml";

/** One file as read from disk: its text, or why it could not be read. */
export type GateFile = { text: string } | { error: string };

/** name ("front.json", "feed.xml") -> file. A name that is absent counts as missing. */
export type GateFiles = Readonly<Record<string, GateFile | undefined>>;

export interface GateOptions {
  /** The real clock (freshness without BUILD_STARTED_AT, clock-skew check). */
  now: Date;
  /** env BUILD_STARTED_AT; null / empty when not running in CI. */
  buildStartedAt?: string | null;
  /** True in CI (GITHUB_ACTIONS): a missing BUILD_STARTED_AT is a failure instead of "not enforced". */
  requireBuildStart?: boolean;
  thresholds?: Partial<GateThresholds>;
  /**
   * The site URL this build was configured with (SITE_URL, else the default). The Atom feed's self
   * link must sit under it; omitted = not checked.
   */
  siteUrl?: string;
}

export interface GateSize {
  name: string;
  raw: number;
  gzip: number;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  /** Error-level, non-blocking signals (quality.ts QualityReport.alerts). */
  alerts: string[];
  sizes: GateSize[];
  stats: QualityStats | null;
  /** The parsed files that passed their guard. */
  bundle: Partial<DataBundle>;
  /** Human-readable report table. */
  report: string[];
}

/**
 * Soft target for first paint (performance review): warn when front.json gzips above this.
 * The live build is about 44 KB (the 30 KB test fixture under-represents live cluster sizes: one
 * 38-member lead cluster costs several KB), so this is the regression tripwire, not the 35 KB goal.
 */
export const FRONT_GZIP_WARN_BYTES = 48 * 1024;
const MAX_FUTURE_MS = 10 * MINUTE_MS;

const JSON_FILES: readonly { key: keyof DataBundle; name: string; validate: (x: unknown) => string | null }[] = [
  { key: "front", name: DATA_FILES.front, validate: validateEditionFront },
  { key: "rest", name: DATA_FILES.rest, validate: validateEditionRest },
  { key: "river", name: DATA_FILES.river, validate: validateRiverFile },
  { key: "health", name: DATA_FILES.health, validate: validateHealthFile },
  { key: "sources", name: DATA_FILES.sources, validate: validateSourcesFile },
  { key: "brief", name: DATA_FILES.brief, validate: validateBriefFile },
  { key: "stocks", name: DATA_FILES.stocks, validate: validateStocksFile },
  { key: "status", name: DATA_FILES.status, validate: validateStatusFile },
];

function parseFiles(files: GateFiles, failures: string[]): Partial<DataBundle> {
  const bundle: Record<string, unknown> = {};
  for (const f of JSON_FILES) {
    const file = files[f.name];
    if (!file) {
      failures.push(`${f.name}: missing`);
      continue;
    }
    if ("error" in file) {
      failures.push(`${f.name}: ${file.error}`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch {
      failures.push(`${f.name}: not valid JSON`);
      continue;
    }
    const problem = f.validate(value);
    if (problem) failures.push(`${f.name}: contract guard failed - ${problem}`);
    else bundle[f.key] = value;
  }
  return bundle as Partial<DataBundle>;
}

const SELF_LINK_RE = /<link\b[^>]*\brel="self"[^>]*\bhref="([^"]*)"/;

function checkXml(files: GateFiles, bundle: Partial<DataBundle>, failures: string[], warnings: string[], siteUrl?: string): void {
  const text = (name: string): string | null => {
    const f = files[name];
    if (!f) failures.push(`${name}: missing`);
    else if ("error" in f) failures.push(`${name}: ${f.error}`);
    else if (!f.text.trim()) failures.push(`${name}: empty`);
    else return f.text;
    return null;
  };
  const wellFormed = (name: string, xml: string): boolean => {
    if (hasXmlIllegal(xml)) {
      failures.push(`${name}: contains a character XML 1.0 does not allow`);
      return false;
    }
    const verdict = XMLValidator.validate(xml);
    if (verdict !== true) {
      failures.push(`${name}: not well-formed XML (${verdict.err.msg}, line ${verdict.err.line})`);
      return false;
    }
    return true;
  };

  const atom = text(ATOM_FILE);
  if (atom !== null && wellFormed(ATOM_FILE, atom)) {
    if (!/<feed[\s>]/.test(atom)) failures.push(`${ATOM_FILE}: no <feed> element`);
    const entries = atom.match(/<entry>/g)?.length ?? 0;
    if (entries > ATOM_MAX_ENTRIES) failures.push(`${ATOM_FILE}: ${entries} entries (max ${ATOM_MAX_ENTRIES})`);
    if (entries === 0 && (bundle.front?.top.length ?? 0) > 0) failures.push(`${ATOM_FILE}: no entries although TOP STORIES has ${bundle.front?.top.length}`);
    // The feed must point at the site this build was configured for. (This was a literal test for
    // the V1 address, which becomes a permanent false warning the day V2 is served from it.)
    const self = SELF_LINK_RE.exec(atom)?.[1];
    if (siteUrl && self !== undefined && !self.startsWith(siteUrl)) warnings.push(`${ATOM_FILE}: self link ${self} is not under the configured site URL ${siteUrl} (check SITE_URL)`);
  }
  const opml = text(OPML_FILE);
  if (opml !== null && wellFormed(OPML_FILE, opml) && bundle.sources) {
    const listed = opml.match(/<outline [^>]*\b(?:xmlUrl|url)="/g)?.length ?? 0;
    const active = bundle.sources.sources.filter((s) => !s.paused).length;
    if (listed !== active) failures.push(`${OPML_FILE}: lists ${listed} sources but ${active} are active`);
  }
}

function checkSizes(files: GateFiles, failures: string[], warnings: string[]): GateSize[] {
  const sizes: GateSize[] = [];
  for (const [name, file] of Object.entries(files)) {
    if (!file || "error" in file) continue;
    const raw = Buffer.byteLength(file.text, "utf8");
    sizes.push({ name, raw, gzip: gzipSync(file.text, { level: 6 }).length });
    const limit = SIZE_LIMITS[name];
    if (limit !== undefined && raw > limit) failures.push(`${name}: ${raw} bytes exceeds the ${limit} byte ceiling`);
  }
  const front = sizes.find((s) => s.name === DATA_FILES.front);
  if (front && front.gzip > FRONT_GZIP_WARN_BYTES) warnings.push(`${DATA_FILES.front}: ${kb(front.gzip)} gzip is above the ${kb(FRONT_GZIP_WARN_BYTES)} first-paint budget`);
  return sizes;
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 100)}%`);

function formatReport(r: Omit<GateResult, "report">, opts: GateOptions, freshness: string): string[] {
  const { front, brief, stocks, status } = r.bundle;
  const lines: string[] = ["=== AI DRUDGE data gate ==="];
  const row = (label: string, value: string): void => void lines.push(`${label.padEnd(11)} ${value}`);
  if (front) {
    const ageMin = Math.round((opts.now.getTime() - (parseMs(front.generatedAt) ?? 0)) / MINUTE_MS);
    row("generated", `${front.generatedAt} (${ageMin} min ago)${status ? `, run ${status.run.id ?? "-"} / ${status.run.trigger}` : ""}`);
  }
  row("freshness", freshness);
  const s = r.stats;
  if (s && front) {
    const lead = front.leadId ? front.articles[front.leadId]?.title : null;
    row("stories", `${s.stories} stories, ${s.placements} rows, ${s.frontRows} on the homepage, ${s.top} top`);
    row("lead", lead ? (lead.length > 90 ? `${lead.slice(0, 89)}…` : lead) : "(none)");
    row("sections", `${s.sectionsWithRows} of ${front.sections.length} with rows; empty: ${s.emptySections.length ? s.emptySections.join(", ") : "(none)"}`);
    row("ages", `median ${s.medianAgeH ?? "-"} h, under 24 h ${pct(s.shareUnder24h)}, oldest ${s.maxAgeDays ?? "-"} d`);
    if (s.feeds) {
      const f = s.feeds;
      row("feeds", `${f.ok}/${f.total} ok; live ${f.ok}/${f.live} (${pct(f.okShare)}); ${f.failing} failing, ${f.carried} carried, ${f.empty} empty, ${f.quarantined} quarantined, ${f.chronic} chronic`);
    }
  }
  if (brief) {
    const why = brief.source === "fallback" ? briefFallbackReason(brief) : null;
    row("brief", `${brief.source}${brief.model ? ` (${brief.model})` : ""}${why ? ` (${why})` : ""}, ${brief.bullets.length} bullets`);
  }
  if (stocks) {
    const priced = stocks.order.filter((sym) => stocks.quotes[sym]?.price != null).length;
    row("stocks", `${priced}/${stocks.order.length} priced${stocks.marketState ? `, market ${stocks.marketState}` : ""}${stocks.asOf ? `, as of ${stocks.asOf}` : ""}`);
  }
  if (r.sizes.length) {
    lines.push("", `${"file".padEnd(14)} ${"raw".padStart(10)} ${"gzip".padStart(10)}`);
    for (const z of r.sizes) lines.push(`${z.name.padEnd(14)} ${kb(z.raw).padStart(10)} ${kb(z.gzip).padStart(10)}`);
  }
  lines.push("");
  for (const w of r.warnings) lines.push(`WARN  ${w}`);
  for (const a of r.alerts) lines.push(`ALERT ${a}`);
  for (const f of r.failures) lines.push(`FAIL  ${f}`);
  const notes = [r.warnings.length ? `${r.warnings.length} warning(s)` : "", r.alerts.length ? `${r.alerts.length} alert(s)` : ""].filter(Boolean).join(" and ");
  lines.push(r.passed ? `PASS  data gate passed${notes ? ` with ${notes}` : ""}` : `HOLD  data gate failed: ${r.failures.length} problem(s) - do not publish`);
  return lines;
}

/** The gate verdict for a set of files. Pure. */
export function evaluateGate(files: GateFiles, opts: GateOptions): GateResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const alerts: string[] = [];
  const bundle = parseFiles(files, failures);
  const sizes = checkSizes(files, failures, warnings);
  let stats: QualityStats | null = null;
  let freshness = "not checked (front.json unusable)";

  const front = bundle.front;
  if (front) {
    const full: DataBundle = { ...bundle, front };
    for (const p of checkBundle(full)) failures.push(`invariant: ${p}`);

    const generatedMs = parseMs(front.generatedAt) ?? 0;
    const ageMin = Math.round((opts.now.getTime() - generatedMs) / MINUTE_MS);
    const stale = checkFreshness(front.generatedAt, opts.buildStartedAt);
    if (stale) {
      failures.push(stale);
      freshness = `STALE - generated before this build started (${opts.buildStartedAt})`;
    } else if ((opts.buildStartedAt ?? "").trim()) {
      freshness = `ok - generated by this build (started ${opts.buildStartedAt})`;
    } else if (opts.requireBuildStart) {
      // A workflow edit that drops the variable must not quietly turn the freshness check off.
      failures.push(`freshness: ${ENV.buildStartedAt} is not set in CI - cannot prove this build wrote the data`);
      freshness = `NOT CHECKED - ${ENV.buildStartedAt} is not set in CI; data is ${ageMin} min old`;
    } else {
      freshness = `not enforced (${ENV.buildStartedAt} not set); data is ${ageMin} min old`;
      if (ageMin > PIPELINE.staleAfterMinutes) warnings.push(`data is ${ageMin} min old (> ${PIPELINE.staleAfterMinutes}); set ${ENV.buildStartedAt} in CI to enforce freshness`);
    }
    if (generatedMs - opts.now.getTime() > MAX_FUTURE_MS) failures.push(`generatedAt ${front.generatedAt} is in the future`);

    // Content ages are measured at build time, so the verdict on a given data set never changes with the wall clock.
    const quality = evaluateQuality(full, { now: generatedMs, thresholds: opts.thresholds });
    failures.push(...quality.failures);
    warnings.push(...quality.warnings);
    alerts.push(...quality.alerts);
    stats = quality.stats;
  }
  // The pipeline's zero-article guard keeps the previous edition and marks its status.json. Locally
  // (no BUILD_STARTED_AT) that data still looks fine, so the marker is carried into the verdict:
  // otherwise --write-status would rewrite gate.passed to true and erase why nothing was built.
  for (const f of bundle.status?.gate.failures ?? []) if (f.startsWith(ZERO_ARTICLES_PREFIX) && !failures.includes(f)) failures.push(f);
  checkXml(files, bundle, failures, warnings, opts.siteUrl);

  const base = { passed: failures.length === 0, failures, warnings, alerts, sizes, stats, bundle };
  return { ...base, report: formatReport(base, opts, freshness) };
}

// ------------------------------------------------------------------------------------------------
// File system + CLI
// ------------------------------------------------------------------------------------------------

async function readGateFile(file: string): Promise<GateFile | undefined> {
  try {
    return { text: await fs.readFile(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : { error: `cannot read (${code ?? "error"})` };
  }
}

/** Read the eight JSON files from `dataDir` and feed.xml / feeds.opml from `publicDir`. Never throws. */
export async function loadGateFiles(dataDir: string, publicDir: string): Promise<GateFiles> {
  const out: Record<string, GateFile | undefined> = {};
  for (const f of JSON_FILES) out[f.name] = await readGateFile(path.join(dataDir, f.name));
  for (const name of [ATOM_FILE, OPML_FILE]) out[name] = await readGateFile(path.join(publicDir, name));
  return out;
}

/** status.json with the gate's verdict recorded (what --write-status writes). Alerts lead the warnings, as in emit. */
export function withGateVerdict(status: StatusFile, result: Pick<GateResult, "passed" | "failures" | "warnings"> & { alerts?: readonly string[] }): StatusFile {
  return { ...status, gate: { passed: result.passed, failures: [...result.failures], warnings: [...(result.alerts ?? []), ...result.warnings] } };
}

/** Name of the step output that carries the brief alert to the workflow's alert job ("" = none). */
export const BRIEF_ALERT_OUTPUT = "brief_alert";

/** One safe line for a step output or an annotation: no line breaks, no workflow-command prefix, bounded. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/^:+/, "").trim().slice(0, 400);
}

export interface CliArgs {
  dataDir: string;
  publicDir: string;
  writeStatus: boolean;
}

export function parseArgs(argv: readonly string[], cwd: string): CliArgs {
  const args: CliArgs = { dataDir: path.resolve(cwd, "public", DATA_DIR), publicDir: path.resolve(cwd, "public"), writeStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write-status") args.writeStatus = true;
    else if (a === "--dir" && argv[i + 1]) args.dataDir = path.resolve(cwd, argv[++i]);
    else if (a === "--public" && argv[i + 1]) args.publicDir = path.resolve(cwd, argv[++i]);
    else throw new Error(`unknown argument: ${a} (usage: check-data.ts [--dir <data dir>] [--public <public dir>] [--write-status])`);
  }
  return args;
}

/** Run the gate on disk. Returns the process exit code (0 publish, 1 hold). */
export async function runGate(args: CliArgs, env: Readonly<Record<string, string | undefined>>, out: (line: string) => void, now: Date = new Date()): Promise<number> {
  const files = await loadGateFiles(args.dataDir, args.publicDir);
  const result = evaluateGate(files, { now, buildStartedAt: env[ENV.buildStartedAt] ?? null, requireBuildStart: env.GITHUB_ACTIONS === "true", siteUrl: configuredSiteUrl(env) });
  for (const line of result.report) out(line);
  if (env.GITHUB_ACTIONS === "true") {
    // Annotations show up on the run summary without opening the log.
    for (const w of result.warnings) out(`::warning title=data gate::${w}`);
    for (const a of result.alerts) out(`::error title=data gate alert::${oneLine(a)}`);
    for (const f of result.failures) out(`::error title=data gate::${f}`);
    // The alert job reads this output; it is always written (empty = no alert) so a stale value cannot linger.
    const outputFile = (env.GITHUB_OUTPUT ?? "").trim();
    if (outputFile) {
      try {
        await fs.appendFile(outputFile, `${BRIEF_ALERT_OUTPUT}=${oneLine(result.alerts.find((a) => a.startsWith("brief:")) ?? "")}\n`);
      } catch {
        out("::warning title=data gate::could not write the step output file");
      }
    }
  }
  if (args.writeStatus && result.bundle.status) {
    await writeFileAtomic(path.join(args.dataDir, DATA_FILES.status), JSON.stringify(withGateVerdict(result.bundle.status, result)));
  }
  return result.passed ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = await runGate(parseArgs(process.argv.slice(2), process.cwd()), process.env, (line) => console.log(line));
  } catch (err) {
    console.error(`check-data: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
