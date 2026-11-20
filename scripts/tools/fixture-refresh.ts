// `npm run fixture:refresh` - turn the data set of the last build (public/data/v2/) into the
// committed fixture (test/fixtures/v2/), the data tests run on and `npm run data:fixture` installs.
//
//   npm run fixture:refresh                       public/data/v2 + public/{feed.xml,feeds.opml} -> test/fixtures/v2
//   npm run fixture:refresh -- --dry-run          report only, write nothing
//   npm run fixture:refresh -- --from <data dir> [--public <dir>] [--to <fixture dir>]
//   npm run fixture:refresh -- --river-rows 800   another river cap (default 1500)
//   npm run fixture:refresh -- --no-health-cases  keep health.json exactly as the build wrote it
//
// The procedure (every step is deterministic: the same build always gives the same fixture bytes):
//   1. READ the eight public JSON files of the build. state.json is never copied: it is 3 MB of
//      pipeline memory no client reads.
//   2. GATE the build as it is (scripts/tools/check-data.ts evaluateGate, clock = the build's own
//      generatedAt). A build the gate would hold is not frozen into a fixture. Nor is a build with
//      an AI-written brief: freeze one made WITHOUT a key
//      (`env -u ANTHROPIC_API_KEY npm run build:data`). Tests exercise the deterministic brief on
//      the fixture and build Claude briefs themselves, and model output is not committed.
//   3. TRIM river.json to --river-rows rows: the rows of the edition's own articles always stay, the
//      rest is cut from the old end. A no-op while the river is under the cap.
//   4. HEALTH CASES: page tests need a carried source, a source skipped by host backoff, a failing
//      one and a quarantined one. A healthy build has none. Each state the build's health.json lacks
//      is written onto one `probation` source (failure of those is the expected state in CI), in
//      registry order; front.counts.feedsOk and status.feeds are recomputed from the result. The
//      rows have the shape ingest writes (scripts/pipeline/ingest/feedState.ts). They are SYNTHETIC
//      and listed in the manifest under `healthCases`.
//   5. MARK status.json: run.trigger "fixture", and the gate verdict of the FIXTURE in `gate`.
//   6. CHECK the result: guards + invariants + the gate again, and the cases tests select by
//      property (test/helpers/fixtureCases.ts: a paywalled row, a w=3 story, a newsletter row, a
//      regulator's notice, a multi-publisher lead ...). A build without them is refused, so the
//      tests never lose a case silently - refresh from another build instead.
//   7. WRITE the eight files and test/fixtures/v2.manifest.json (build id, sha256 and size of every
//      file, whether it differs from the build's file, the steps applied). A file no step touched is
//      copied byte for byte. test/fixtures.test.ts verifies the manifest against the files.
//
// After a refresh run `npx tsc -b && npm test`: tests select fixture rows by property, but a new
// day's data can still surprise one. `buildFixture` is pure and is what the tests exercise.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { DATA_FILES, RIVER, type ArticleId, type FeedHealthRow, type RiverFile, type SourceInfo } from "../../shared/contract";
import type { DataBundle } from "../../shared/invariants";
import { HOUR_MS, MINUTE_MS, parseMs } from "../../shared/time";
import { missingFixtureCases } from "../../test/helpers/fixtureCases";
import { PIPELINE } from "../pipeline/context";
import { ATOM_FILE } from "../pipeline/emit/atom";
import { OPML_FILE } from "../pipeline/emit/opml";
import { statusFeeds } from "../pipeline/emit/status";
import { evaluateGate, loadGateFiles, withGateVerdict, type GateFile, type GateFiles } from "./check-data";

/** A bundle with all eight public files. */
export type FullBundle = Required<{ [K in keyof DataBundle]: NonNullable<DataBundle[K]> }>;
export type FixtureKey = keyof FullBundle;

/** The files of the fixture, in the order they are written. state.json is not one of them. */
export const FIXTURE_KEYS: readonly FixtureKey[] = ["front", "rest", "river", "health", "sources", "status", "brief", "stocks"];
export const FIXTURE_FILES: readonly string[] = FIXTURE_KEYS.map((k) => DATA_FILES[k]);

/** Fixture directory and manifest, relative to the repository root. */
export const FIXTURE_DIR = "test/fixtures/v2";
export const FIXTURE_MANIFEST = "test/fixtures/v2.manifest.json";

/** Default cap on river rows (the 2026-11-20 build has 1,051; a full week of 413 sources has several thousand). */
export const RIVER_MAX_ROWS = 1500;
/** `status.run.trigger` of a fixture: the About page and the gate report say what the data is. */
export const FIXTURE_TRIGGER = "fixture";
/** `brief.fallbackReason` of a build made without an API key - the only kind of brief a fixture holds. */
export const NO_KEY_REASON = "no-key";
/** Registry tag of the sources a health case may be written on. */
const CASE_TAG = "probation";

// ------------------------------------------------------------------------------------------------
// Step 3: river trim
// ------------------------------------------------------------------------------------------------

/**
 * At most `maxRows` river rows: every row of an edition article (front + rest) stays - the river
 * invariant requires them - and the remaining budget goes to the newest other rows. Order and the
 * source tables are untouched (row[3] indexes them). Returns the same object when nothing is cut.
 */
export function trimRiver(river: RiverFile, edition: Pick<FullBundle, "front" | "rest">, maxRows: number): RiverFile {
  if (river.rows.length <= maxRows) return river;
  const required = new Set<ArticleId>([...Object.keys(edition.front.articles), ...Object.keys(edition.rest.articles)]);
  let budget = maxRows - river.rows.filter((r) => required.has(r[RIVER.id])).length;
  const rows = river.rows.filter((r) => required.has(r[RIVER.id]) || budget-- > 0);
  return { ...river, rows };
}

// ------------------------------------------------------------------------------------------------
// Step 4: health cases
// ------------------------------------------------------------------------------------------------

export type HealthCaseKind = "carried" | "host-backoff" | "failing" | "quarantined";

/** One synthetic health row, as recorded in the manifest. */
export interface HealthCase {
  kind: HealthCaseKind;
  id: string;
  name: string;
}

/** What makes a health row an example of each case (also how a build's own rows are recognised). */
export const HEALTH_CASE_TESTS: Readonly<Record<HealthCaseKind, (f: FeedHealthRow) => boolean>> = {
  carried: (f) => f.status === "carried" && f.error !== "skipped",
  "host-backoff": (f) => f.status === "carried" && f.error === "skipped",
  failing: (f) => f.status === "failing",
  quarantined: (f) => f.status === "quarantined",
};
const CASE_ORDER: readonly HealthCaseKind[] = ["carried", "host-backoff", "failing", "quarantined"];

function hostOf(url: string | undefined): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : "the feed host";
}

/** The row ingest + emit would write for the case (feedState.ts healthFailed / healthHostBackoff / healthSkipped). */
function caseRow(kind: HealthCaseKind, live: FeedHealthRow, source: SourceInfo, generatedMs: number): FeedHealthRow {
  const ago = (ms: number): string => new Date(generatedMs - ms).toISOString();
  const cadenceMs = PIPELINE.cadenceMinutes * MINUTE_MS;
  const items = Math.max(1, live.count);
  switch (kind) {
    case "carried":
      // One failed run; the last good fetch was the build before.
      return { id: live.id, ok: false, status: "carried", count: items, failStreak: 1, lastOkAt: ago(cadenceMs), error: "http", lastError: "HTTP 403", carried: true, httpStatus: 403 };
    case "host-backoff":
      return {
        id: live.id,
        ok: false,
        status: "carried",
        count: items,
        failStreak: 1,
        lastOkAt: ago(cadenceMs),
        error: "skipped",
        lastError: `host backoff: ${hostOf(source.feedUrl ?? source.homepage)} answered HTTP 502 to 2 requests in a row; not requested this run, ${items} last-good item${items === 1 ? "" : "s"} carried`,
        carried: true,
      };
    case "failing": {
      // One hour past the carry-forward limit: nothing left to carry.
      const downMs = (PIPELINE.carryForwardMaxHours + 1) * HOUR_MS;
      return { id: live.id, ok: false, status: "failing", count: 0, failStreak: Math.round(downMs / cadenceMs), lastOkAt: ago(downMs), error: "timeout", lastError: "timeout after 8000 ms" };
    }
    case "quarantined": {
      // Not probed this run: the class is "skipped", the last real failure stays visible.
      const failStreak = PIPELINE.quarantineAfterFails + 4;
      return { id: live.id, ok: false, status: "quarantined", count: 0, failStreak, lastOkAt: ago(failStreak * cadenceMs), error: "skipped", lastError: "HTTP 403" };
    }
  }
}

/**
 * health.json with every missing case written onto a `probation` source (sources.json order), and
 * the list of what was written. A failing / quarantined case only goes on a source without an
 * article in the edition (a source that delivered nothing cannot have rows on the page). Pure.
 */
export function applyHealthCases(bundle: Pick<FullBundle, "front" | "rest" | "health" | "sources">): { health: FullBundle["health"]; cases: HealthCase[] } {
  const generatedMs = parseMs(bundle.health.generatedAt) ?? 0;
  const feeds = bundle.health.feeds.map((f) => ({ ...f }));
  const rowById = new Map(feeds.map((f, i) => [f.id, i]));
  const inEdition = new Set<string>([...Object.values(bundle.front.articles), ...Object.values(bundle.rest.articles)].map((a) => a.src));
  const used = new Set<string>();
  const cases: HealthCase[] = [];
  for (const kind of CASE_ORDER) {
    if (feeds.some(HEALTH_CASE_TESTS[kind])) continue;
    const silent = kind === "failing" || kind === "quarantined";
    const source = bundle.sources.sources.find((s) => {
      const i = rowById.get(s.id);
      return i !== undefined && feeds[i].ok && !used.has(s.id) && !s.paused && (s.tags ?? []).includes(CASE_TAG) && (!silent || !inEdition.has(s.id));
    });
    if (!source) throw new Error(`health case "${kind}": no healthy ${CASE_TAG} source${silent ? " without an article in the edition" : ""} to write it on`);
    const i = rowById.get(source.id) as number;
    feeds[i] = caseRow(kind, feeds[i], source, generatedMs);
    used.add(source.id);
    cases.push({ kind, id: source.id, name: source.name });
  }
  return { health: cases.length ? { ...bundle.health, feeds } : bundle.health, cases };
}

// ------------------------------------------------------------------------------------------------
// Steps 3-5 as one pure function
// ------------------------------------------------------------------------------------------------

export interface FixtureOptions {
  riverRows?: number;
  healthCases?: boolean;
}

export interface FixtureBuild {
  bundle: FullBundle;
  river: { rowsIn: number; rowsOut: number; maxRows: number };
  healthCases: HealthCase[];
}

/**
 * The fixture bundle of a build's bundle, WITHOUT the gate verdict of step 5 (that needs the XML
 * files; `refreshFixture` adds it). Files no step changes are returned as the same objects. Pure.
 */
export function buildFixture(source: FullBundle, opts: FixtureOptions = {}): FixtureBuild {
  const maxRows = opts.riverRows ?? RIVER_MAX_ROWS;
  const river = trimRiver(source.river, source, maxRows);
  const { health, cases } = opts.healthCases === false ? { health: source.health, cases: [] } : applyHealthCases(source);
  const feeds = statusFeeds(health, source.sources);
  const front = feeds.ok === source.front.counts.feedsOk ? source.front : { ...source.front, counts: { ...source.front.counts, feedsOk: feeds.ok } };
  const status = { ...source.status, run: { ...source.status.run, trigger: FIXTURE_TRIGGER }, feeds };
  return {
    bundle: { ...source, front, river, health, status },
    river: { rowsIn: source.river.rows.length, rowsOut: river.rows.length, maxRows },
    healthCases: cases,
  };
}

// ------------------------------------------------------------------------------------------------
// Manifest
// ------------------------------------------------------------------------------------------------

export interface ManifestFile {
  bytes: number;
  gzipBytes: number;
  sha256: string;
  /** sha256 of the build's file this one was made from. */
  sourceSha256: string;
  /** False = copied byte for byte from the build. */
  modified: boolean;
}

export interface FixtureManifest {
  note: string;
  /** buildId / generatedAt of the build the fixture was taken from. */
  buildId: string;
  generatedAt: string;
  tool: string;
  options: { riverRows: number; healthCases: boolean };
  river: { rowsIn: number; rowsOut: number };
  /** SYNTHETIC health rows (step 4); [] when the build had every case itself. */
  healthCases: HealthCase[];
  totalBytes: number;
  files: Record<string, ManifestFile>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface RefreshResult {
  ok: boolean;
  /** Why the refresh was refused (empty when ok). */
  problems: string[];
  /** File name -> content to write (fixture files only; empty when not ok). */
  files: Record<string, string>;
  manifest: FixtureManifest | null;
  report: string[];
}

function parseBundle(files: GateFiles): FullBundle | null {
  const out: Record<string, unknown> = {};
  for (const key of FIXTURE_KEYS) {
    const f = files[DATA_FILES[key]];
    if (!f || "error" in f) return null;
    out[key] = JSON.parse(f.text);
  }
  return out as unknown as FullBundle;
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/**
 * Steps 2-6 on a build's files as read from disk (the eight JSON files + feed.xml + feeds.opml).
 * Never throws for bad data: the problems are returned and nothing is to be written.
 */
export function refreshFixture(sourceFiles: GateFiles, opts: FixtureOptions = {}): RefreshResult {
  const fail = (problems: string[], report: string[] = []): RefreshResult => ({ ok: false, problems, files: {}, manifest: null, report });
  const generatedAt = ((): string | null => {
    const f = sourceFiles[DATA_FILES.front];
    if (!f || "error" in f) return null;
    try {
      const at = (JSON.parse(f.text) as { generatedAt?: unknown }).generatedAt;
      return typeof at === "string" && parseMs(at) !== null ? at : null;
    } catch {
      return null;
    }
  })();
  if (generatedAt === null) return fail([`${DATA_FILES.front}: missing or unreadable - run \`npm run build:data\` first`]);
  const now = new Date(generatedAt);

  // Step 2: the build itself must pass.
  const before = evaluateGate(sourceFiles, { now });
  if (!before.passed) return fail(before.failures.map((f) => `the build does not pass the gate: ${f}`), before.report);
  const source = parseBundle(sourceFiles);
  if (!source) return fail(["the build's files could not be parsed"]);
  if (source.brief.source !== "fallback" || source.brief.fallbackReason !== NO_KEY_REASON) {
    return fail([`brief.json is ${source.brief.source}${source.brief.fallbackReason ? ` (${source.brief.fallbackReason})` : ""}: freeze a build made without an API key (env -u ANTHROPIC_API_KEY npm run build:data)`], before.report);
  }

  // Steps 3-4.
  let built: FixtureBuild;
  try {
    built = buildFixture(source, opts);
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }

  // Step 5 + 6: serialise, gate the fixture, record its verdict, gate once more on the final bytes.
  const text = (key: FixtureKey, value: unknown): string => {
    const original = sourceFiles[DATA_FILES[key]] as { text: string };
    return value === source[key] ? original.text : JSON.stringify(value);
  };
  const gateFilesOf = (bundle: FullBundle): Record<string, GateFile | undefined> => {
    const out: Record<string, GateFile | undefined> = { [ATOM_FILE]: sourceFiles[ATOM_FILE], [OPML_FILE]: sourceFiles[OPML_FILE] };
    for (const key of FIXTURE_KEYS) out[DATA_FILES[key]] = { text: text(key, bundle[key]) };
    return out;
  };
  const verdict = evaluateGate(gateFilesOf(built.bundle), { now });
  const bundle: FullBundle = { ...built.bundle, status: withGateVerdict(built.bundle.status, verdict) };
  const finalFiles = gateFilesOf(bundle);
  const after = evaluateGate(finalFiles, { now });
  const problems = after.failures.map((f) => `the fixture does not pass the gate: ${f}`);
  for (const c of missingFixtureCases(bundle)) problems.push(`the fixture has no ${c} - tests select it by property; refresh from a build that has one`);
  if (problems.length) return fail(problems, after.report);

  const files: Record<string, string> = {};
  const manifestFiles: Record<string, ManifestFile> = {};
  let totalBytes = 0;
  for (const key of FIXTURE_KEYS) {
    const name = DATA_FILES[key];
    const content = (finalFiles[name] as { text: string }).text;
    const original = (sourceFiles[name] as { text: string }).text;
    files[name] = content;
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    manifestFiles[name] = { bytes, gzipBytes: gzipSync(content, { level: 6 }).length, sha256: sha256(content), sourceSha256: sha256(original), modified: content !== original };
  }
  const manifest: FixtureManifest = {
    note: "Written by `npm run fixture:refresh` (scripts/tools/fixture-refresh.ts) - do not edit the fixture files by hand. healthCases lists the SYNTHETIC health rows; every file with modified=false is the build's own file, byte for byte.",
    buildId: source.front.buildId,
    generatedAt: source.front.generatedAt,
    tool: "scripts/tools/fixture-refresh.ts",
    options: { riverRows: built.river.maxRows, healthCases: opts.healthCases !== false },
    river: { rowsIn: built.river.rowsIn, rowsOut: built.river.rowsOut },
    healthCases: built.healthCases,
    totalBytes,
    files: manifestFiles,
  };

  const report = [
    `build        ${manifest.buildId} (${source.front.counts.stories} stories, ${source.health.feeds.length} sources)`,
    `river        ${built.river.rowsOut} of ${built.river.rowsIn} rows kept (cap ${built.river.maxRows})`,
    `health cases ${built.healthCases.length ? built.healthCases.map((c) => `${c.kind} -> ${c.id}`).join(", ") : "none written (the build has every case, or --no-health-cases)"}`,
    ...FIXTURE_KEYS.map((key) => {
      const f = manifestFiles[DATA_FILES[key]];
      return `${DATA_FILES[key].padEnd(13)}${kb(f.bytes).padStart(9)} ${kb(f.gzipBytes).padStart(9)} gzip  ${f.modified ? "modified" : "copied"}`;
    }),
    `total        ${kb(totalBytes)}`,
    ...after.warnings.map((w) => `gate warning ${w}`),
    "gate         PASS (guards, invariants, content rules, fixture cases)",
  ];
  return { ok: true, problems: [], files, manifest, report };
}

// ------------------------------------------------------------------------------------------------
// File system + CLI
// ------------------------------------------------------------------------------------------------

export interface RefreshArgs {
  fromDir: string;
  publicDir: string;
  toDir: string;
  manifestFile: string;
  riverRows: number;
  healthCases: boolean;
  dryRun: boolean;
}

const USAGE = "usage: fixture-refresh.ts [--from <data dir>] [--public <dir>] [--to <fixture dir>] [--river-rows <n>] [--no-health-cases] [--dry-run]";

export function parseArgs(argv: readonly string[], root: string): RefreshArgs {
  const args: RefreshArgs = {
    fromDir: path.resolve(root, "public/data/v2"),
    publicDir: path.resolve(root, "public"),
    toDir: path.resolve(root, FIXTURE_DIR),
    manifestFile: path.resolve(root, FIXTURE_MANIFEST),
    riverRows: RIVER_MAX_ROWS,
    healthCases: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-health-cases") args.healthCases = false;
    else if (a === "--from" && argv[i + 1]) args.fromDir = path.resolve(root, argv[++i]);
    else if (a === "--public" && argv[i + 1]) args.publicDir = path.resolve(root, argv[++i]);
    else if (a === "--to" && argv[i + 1]) {
      args.toDir = path.resolve(root, argv[++i]);
      args.manifestFile = `${args.toDir}.manifest.json`;
    } else if (a === "--river-rows" && /^[1-9]\d*$/.test(argv[i + 1] ?? "")) args.riverRows = Number(argv[++i]);
    else throw new Error(`unknown or incomplete argument: ${a} (${USAGE})`);
  }
  return args;
}

/** Run the refresh on disk. Returns the process exit code (0 written or dry run, 1 refused). */
export async function runRefresh(args: RefreshArgs, out: (line: string) => void): Promise<number> {
  const result = refreshFixture(await loadGateFiles(args.fromDir, args.publicDir), { riverRows: args.riverRows, healthCases: args.healthCases });
  for (const line of result.report) out(line);
  if (!result.ok || !result.manifest) {
    for (const p of result.problems) out(`REFUSED  ${p}`);
    return 1;
  }
  if (args.dryRun) {
    out("dry run: nothing written");
    return 0;
  }
  await fs.mkdir(args.toDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) await fs.writeFile(path.join(args.toDir, name), content);
  await fs.writeFile(args.manifestFile, `${JSON.stringify(result.manifest, null, 2)}\n`);
  out(`wrote ${Object.keys(result.files).length} files to ${args.toDir} and ${args.manifestFile}`);
  out("next: npx tsc -b && npm test");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    process.exitCode = await runRefresh(parseArgs(process.argv.slice(2), root), (line) => console.log(line));
  } catch (err) {
    console.error(`fixture:refresh: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
