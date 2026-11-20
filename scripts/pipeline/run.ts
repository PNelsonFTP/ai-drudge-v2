// `npm run build:data` - the pipeline orchestrator. COMPOSITION ONLY: every decision lives in a stage.
//
//   loadState -> ingest -> normalize -> filterRelevance (+ rescueCorroboration) -> cluster -> score -> route
//             -> (makeBrief ∥ fetchStocks) -> emit -> writeBundle (+ state.json) -> explain record
//
// Environment (all optional): SITE_URL, SITE_BASE, ANTHROPIC_API_KEY (absent -> fallback brief),
// FEED_USER_AGENT, BUILD_STARTED_AT (CI freshness gate), GITHUB_* run metadata,
// STATE_FILE (state path, default <dataDir>/state.json) and STATE_URL (fetched when that file is
// missing - for a build outside CI; the refresh workflow restores the file in its own step, from
// the `data` branch first, before the pipeline starts, and does not set STATE_URL).
//
// Zero-article guard: when nothing survives relevance (every fetch failed, or the network is gone)
// the previous files are left untouched, status.json is marked, and the process exits 0. The CI
// freshness gate then holds the deploy because generatedAt did not advance; in GitHub Actions the
// reason is also annotated and written to the step output `outcome` (reportOutcome) so the failure
// issue can say "zero articles" instead of only "data gate (hold)".
//
// API key: ANTHROPIC_API_KEY is handed to makeBrief only. The context every other stage sees
// (ingest fetches and parses ~400 untrusted feeds) has no key, and the command-line entry removes
// it from process.env before the run starts, so a child process cannot inherit it either.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStatusFile } from "../../shared/guards";
import { REGISTRY } from "../registry/index";
import { cluster } from "./cluster/index";
import { ENV, createContext, emptyState } from "./context";
import { emit } from "./emit/edition";
import { EXPLAIN_FILE, buildExplain } from "./emit/explain";
import { ZERO_ARTICLES_PREFIX } from "./emit/quality";
import { briefFailStreakFor, runInfoFromEnv } from "./emit/status";
import { bundleSizes, writeBundle, writeExplain, writeFileAtomic } from "./emit/write";
import { makeBrief } from "./enrich/brief";
import { fetchStocks } from "./enrich/stocks";
import { ingest } from "./ingest/index";
import { normalize } from "./normalize/index";
import { cleanText } from "./normalize/text";
import { filterRelevance, rescueCorroboration } from "./relevance/index";
import { route } from "./route/index";
import { score } from "./score/index";
import { loadState, nextState, slimLastGood } from "./state/store";
import type {
  DroppedItem,
  EmitBundle,
  FetchStocks,
  Ingest,
  IngestOutput,
  LogLevel,
  MakeBrief,
  NormalizeOutput,
  NormalizedItem,
  PipelineState,
  Placements,
  Registry,
  RelevanceOutput,
  ScoredStory,
  StageContext,
  Story,
} from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_DATA_DIR = path.join(ROOT, "public/data/v2");
export const DEFAULT_PUBLIC_DIR = path.join(ROOT, "public");

const STATE_FETCH_TIMEOUT_MS = 30_000;
const STATE_MAX_BYTES = 64 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------
// The pure middle of the pipeline (shared with tests and the compare tool)
// ------------------------------------------------------------------------------------------------

export interface Processed {
  normalized: NormalizeOutput;
  /** After the corroboration rescue: `kept` includes the rescued items, `dropped` no longer lists them. */
  relevance: RelevanceOutput;
  /** Items the per-source cap had cut and the rescue gave back (the explain record marks them). */
  rescued: NormalizedItem[];
  stories: Story[];
  scored: ScoredStory[];
  placements: Placements;
  dropped: DroppedItem[];
}

/** normalize -> relevance -> cluster -> score -> route. Pure: the clock and the state come from ctx. */
export function processItems(ing: Pick<IngestOutput, "items" | "signals">, registry: Registry, ctx: StageContext, onStage?: (name: string, ms: number) => void): Processed {
  const timed = <T>(name: string, fn: () => T): T => {
    const t0 = performance.now();
    const out = fn();
    onStage?.(name, performance.now() - t0);
    return out;
  };
  const normalized = timed("normalize", () => normalize(ing.items, registry, ctx));
  // The per-source cap runs before clustering, so it could cut the very items a story is built from
  // (OpenAI's own GPT-6.2 post behind 8 newer OpenAI posts). rescueCorroboration clusters what passed
  // the checks once (quietly) and gives back the over-cap items that share a story with another
  // publisher; `relevance` is then a plain RelevanceOutput in input order.
  const quiet: StageContext = { ...ctx, log: () => {} };
  let rescued: NormalizedItem[] = [];
  const relevance = timed("relevance", () => {
    const capped = filterRelevance(normalized.items, registry, ctx);
    const out = rescueCorroboration(capped, (items) => cluster(items, quiet), ctx);
    const before = new Set(capped.kept);
    rescued = out.kept.filter((item) => !before.has(item));
    return out;
  });
  const stories = timed("cluster", () => cluster(relevance.kept, ctx));
  const scored = timed("score", () => score(stories, ing.signals, ctx));
  const placements = timed("route", () => route(scored, ctx));
  return { normalized, relevance, rescued, stories, scored, placements, dropped: [...normalized.dropped, ...relevance.dropped] };
}

// ------------------------------------------------------------------------------------------------
// State restore
// ------------------------------------------------------------------------------------------------

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * When the state file is missing and STATE_URL is set, download it next to where loadState will
 * read it. Anything that is not a schemaVersion-2 JSON object is ignored (first-run semantics).
 */
async function restoreStateFromUrl(file: string, url: string, ctx: Pick<StageContext, "fetch" | "log">): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    ctx.log("warn", `state: ${ENV.stateUrl} is not an http(s) URL - ignored`);
    return;
  }
  try {
    const res = await ctx.fetch(url, { signal: AbortSignal.timeout(STATE_FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) {
      ctx.log("info", `state: ${url} answered HTTP ${res.status} - no remote state`);
      return;
    }
    const text = await res.text();
    if (text.length > STATE_MAX_BYTES) {
      ctx.log("warn", `state: ${url} is ${text.length} chars (cap ${STATE_MAX_BYTES}) - ignored`);
      return;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || (parsed as { schemaVersion?: unknown }).schemaVersion !== 2) {
      ctx.log("warn", `state: ${url} is not a schemaVersion 2 state file - ignored`);
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, text);
    ctx.log("info", `state: restored from ${url} (${(text.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    ctx.log("warn", `state: could not restore from ${url} (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`);
  }
}

// ------------------------------------------------------------------------------------------------
// Reporting
// ------------------------------------------------------------------------------------------------

export interface StageRow {
  stage: string;
  ms: number;
  /** "411 sources -> 2,950 items" */
  counts: string;
}

function countBy<T>(list: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

const fmtCounts = (rec: Record<string, number>): string =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";

/** The compact per-stage table printed at the end of a run. */
export function formatStageTable(rows: readonly StageRow[]): string {
  const w = Math.max(...rows.map((r) => r.stage.length), 5);
  const line = (stage: string, ms: string, counts: string): string => `${stage.padEnd(w)}  ${ms.padStart(8)}  ${counts}`;
  return [line("stage", "ms", "counts"), line("-".repeat(w), "-".repeat(8), "-".repeat(6)), ...rows.map((r) => line(r.stage, r.ms.toFixed(0), r.counts))].join("\n");
}

// ------------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------------

export interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  fetch?: typeof fetch;
  log?: (level: LogLevel, msg: string) => void;
  registry?: Registry;
  dataDir?: string;
  publicDir?: string;
  /** Where the explain record goes; null = do not write one. Default node_modules/.tmp/explain.json under the repo. */
  explainFile?: string | null;
  /** Stage overrides for tests (the network stages). */
  stages?: { ingest?: Ingest; makeBrief?: MakeBrief; fetchStocks?: FetchStocks };
}

export interface RunResult {
  /** "written": a new edition is on disk. "kept-previous": zero-article guard, nothing replaced. */
  outcome: "written" | "kept-previous";
  buildId: string;
  durationMs: number;
  stages: StageRow[];
  bundle: EmitBundle | null;
  state: PipelineState | null;
  processed: Processed | null;
  ingest: IngestOutput;
  /** Why the previous edition was kept ("zero articles at ..."); null when a new edition was written. */
  keptReason: string | null;
}

/**
 * Tell GitHub Actions how the run ended: one `outcome=...` line for the step output file and, when
 * the previous edition was kept, an error annotation carrying the reason. No-op outside Actions.
 */
export async function reportOutcome(result: Pick<RunResult, "outcome" | "keptReason">, env: Readonly<Record<string, string | undefined>>, out: (line: string) => void): Promise<void> {
  if (env.GITHUB_ACTIONS !== "true") return;
  if (result.outcome === "kept-previous") out(`::error title=data build::${(result.keptReason ?? "previous edition kept").replace(/[\r\n]+/g, " ")}`);
  const file = (env.GITHUB_OUTPUT ?? "").trim();
  if (!file) return;
  try {
    await fs.appendFile(file, `outcome=${result.outcome}\n`);
  } catch {
    out("::warning title=data build::could not write the step output file");
  }
}

/** Zero-article guard: leave the previous edition alone and record why in the existing status.json. */
async function markKeptPrevious(dataDir: string, reason: string, ctx: StageContext): Promise<void> {
  const file = path.join(dataDir, "status.json");
  try {
    const status: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isStatusFile(status)) return;
    const failures = [...(status.gate.failures ?? []).filter((f) => !f.startsWith(ZERO_ARTICLES_PREFIX)), reason];
    await writeFileAtomic(file, `${JSON.stringify({ ...status, gate: { ...status.gate, passed: false, failures } })}\n`);
  } catch {
    ctx.log("info", "status.json: nothing to mark (no previous status file)");
  }
}

export async function runPipeline(options: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  // The API key travels in `briefEnv` only; `env` (what every other stage sees) never holds it.
  const briefEnv = options.env ?? process.env;
  const env: Record<string, string | undefined> = { ...briefEnv };
  delete env[ENV.anthropicKey];
  const registry = options.registry ?? REGISTRY;
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const stateFileEnv = (env[ENV.stateFile] ?? "").trim();
  const statePath = stateFileEnv ? path.resolve(stateFileEnv) : path.join(dataDir, "state.json");
  const stages: StageRow[] = [];
  const note = (stage: string, ms: number, counts: string): void => void stages.push({ stage, ms, counts });

  // The build clock starts here, so generatedAt >= BUILD_STARTED_AT whenever CI set it before the run.
  const base = createContext({ now: options.now, env, fetch: options.fetch, log: options.log, state: emptyState() });
  const log = base.log;
  const startedAt = (env[ENV.buildStartedAt] ?? "").trim();
  log("info", `build ${base.buildId}${startedAt ? ` (${ENV.buildStartedAt}=${startedAt})` : ""}`);
  if (startedAt && Date.parse(startedAt) > base.now.getTime()) log("warn", `${ENV.buildStartedAt} is later than the build clock - the freshness gate will hold this build`);

  let t = performance.now();
  const stateUrl = (env[ENV.stateUrl] ?? "").trim();
  if (stateUrl && !(await exists(statePath))) await restoreStateFromUrl(statePath, stateUrl, base);
  // The object from loadState is passed through whole (it carries last-good validators and lastSeenDay).
  const state = await loadState(statePath, log);
  const ctx: StageContext = { ...base, state };
  const firstRun = Object.keys(state.firstSeen).length === 0;
  note("loadState", performance.now() - t, `${Object.keys(state.firstSeen).length} first-seen ids, ${state.recent.length} recent, ${Object.keys(state.lastGood).length} last-good${firstRun ? " (first run)" : ""}`);

  t = performance.now();
  const ing = await (options.stages?.ingest ?? ingest)(registry, ctx);
  const byStatus = countBy(ing.health, (h) => h.status);
  note("ingest", performance.now() - t, `${ing.health.length} sources (${fmtCounts(byStatus)}; ${ing.health.filter((h) => h.notModified).length} not modified) -> ${ing.items.length} items; hn ${ing.signals.hn.byUrl.size}`);

  const durations = new Map<string, number>();
  const processed = processItems(ing, registry, ctx, (name, ms) => void durations.set(name, ms));
  const { normalized, relevance, rescued, stories, scored, placements, dropped } = processed;
  note("normalize", durations.get("normalize") ?? 0, `${ing.items.length} -> ${normalized.items.length} (dropped: ${fmtCounts(countBy(normalized.dropped, (d) => d.reason))})`);
  note("relevance", durations.get("relevance") ?? 0, `${normalized.items.length} -> ${relevance.kept.length} (dropped: ${fmtCounts(countBy(relevance.dropped, (d) => d.reason))}${rescued.length ? `; ${rescued.length} over-cap kept as corroboration` : ""})`);
  note("cluster", durations.get("cluster") ?? 0, `${relevance.kept.length} -> ${stories.length} stories (${stories.filter((s) => s.publishers.length >= 2).length} multi-publisher)`);
  note("score", durations.get("score") ?? 0, `${scored.length} scored`);
  const rows = placements.sections.reduce((n, s) => n + s.rows.length, 0);
  note("route", durations.get("route") ?? 0, `${rows} rows in ${placements.sections.filter((s) => s.rows.length > 0).length}/${placements.sections.length} sections; top ${placements.top.length}`);

  if (relevance.kept.length === 0) {
    const reason = `${ZERO_ARTICLES_PREFIX} at ${ctx.now.toISOString()}: ${ing.health.filter((h) => h.ok).length}/${ing.health.length} sources ok - previous edition kept`;
    log("error", `${reason}. Nothing was written.`);
    await markKeptPrevious(dataDir, reason, ctx);
    log("info", `\n${formatStageTable(stages)}`);
    return { outcome: "kept-previous", buildId: ctx.buildId, durationMs: performance.now() - t0, stages, bundle: null, state: null, processed, ingest: ing, keptReason: reason };
  }

  t = performance.now();
  const briefCtx: StageContext = { ...ctx, env: briefEnv };
  const [brief, stocks] = await Promise.all([(options.stages?.makeBrief ?? makeBrief)(placements, briefCtx), (options.stages?.fetchStocks ?? fetchStocks)(ctx)]);
  const quoted = stocks.order.filter((sym) => stocks.quotes[sym]?.price != null).length;
  note("brief+stocks", performance.now() - t, `brief ${brief.source}; stocks ${quoted}/${stocks.order.length}`);

  t = performance.now();
  const durationS = Math.round((performance.now() - t0) / 1000);
  const bundle = emit({ placements, health: ing.health, registry, brief, stocks, dropped, run: runInfoFromEnv(env, durationS) }, ctx);
  const sizes = bundleSizes(bundle);
  note("emit", performance.now() - t, `${bundle.front.counts.stories} stories, river ${bundle.river.rows.length}; gate ${bundle.status.gate.passed ? "passed" : "FAILED"}`);

  t = performance.now();
  // What is saved of the last-good snapshots is plain text, not the publishers' HTML (state.json is public).
  const folded: PipelineState & { briefFailStreak?: number } = slimLastGood(nextState(state, { ingest: ing, normalized: normalized.items, placements, bundle }, ctx), cleanText);
  // Brief failure streak (consecutive failed Claude briefs with a key configured): the one number
  // the brief alert needs from build to build. It travels in state.json as the optional field
  // `briefFailStreak`; a state reader that does not know the field drops it, the streak then never
  // passes 1 and the alert stays silent - the feature degrades to "off", never to a false alarm.
  const { briefFailStreak: _previousStreak, ...withoutStreak } = folded;
  const briefFailStreak = briefFailStreakFor(state, brief);
  const next: PipelineState & { briefFailStreak?: number } = briefFailStreak > 0 ? { ...withoutStreak, briefFailStreak } : withoutStreak;
  if (briefFailStreak > 0) log("warn", `brief: ${briefFailStreak} build${briefFailStreak === 1 ? "" : "s"} in a row without a Claude brief although a key is configured`);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });
  await writeBundle(bundle, next, { dataDir, publicDir });
  if (statePath !== path.join(dataDir, "state.json")) {
    // STATE_FILE may name a directory nothing has created yet (first run, or the STATE_URL restore
    // failed): without the mkdir the build threw here, after the edition was already written.
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.copyFile(path.join(dataDir, "state.json"), statePath);
  }
  const explainFile = options.explainFile === undefined ? path.join(ROOT, EXPLAIN_FILE) : options.explainFile;
  if (explainFile) {
    await fs.mkdir(path.dirname(explainFile), { recursive: true });
    await writeExplain(buildExplain(placements, dropped, ctx, { rescued }), explainFile);
  }
  note("write", performance.now() - t, sizes.map((s) => `${s.name} ${(s.raw / 1024).toFixed(0)}K/${(s.gzip / 1024).toFixed(0)}K gz`).join(", "));

  for (const f of bundle.status.gate.failures ?? []) log("error", `gate: ${f}`);
  for (const w of bundle.status.gate.warnings) log("warn", `gate: ${w}`);
  log("info", `\n${formatStageTable(stages)}`);
  log("info", `done in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(process.cwd(), dataDir) || dataDir}`);
  return { outcome: "written", buildId: ctx.buildId, durationMs: performance.now() - t0, stages, bundle, state: next, processed, ingest: ing, keptReason: null };
}

export const USAGE = "usage: run.ts   (no arguments; configured by environment: STATE_FILE, STATE_URL, SITE_URL, SITE_BASE, ANTHROPIC_API_KEY, FEED_USER_AGENT - NETWORK: fetches every registry source)";

/** The build takes no arguments: anything on the command line stops it before the first request. 0 = `--help`, 2 = refused, null = run. */
export function cliExit(argv: readonly string[]): 0 | 2 | null {
  if (argv.length === 0) return null;
  return argv.every((a) => a === "--help" || a === "-h") ? 0 : 2;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const refused = invokedDirectly ? cliExit(process.argv.slice(2)) : null;
if (invokedDirectly && refused !== null) {
  if (refused === 2) console.error(`build: unknown argument: ${process.argv.slice(2).find((a) => a !== "--help" && a !== "-h")}`);
  console.log(USAGE);
  process.exit(refused);
} else if (invokedDirectly) {
  // Take the environment once, then drop the API key from the process: only makeBrief receives it.
  const env = { ...process.env };
  delete process.env[ENV.anthropicKey];
  runPipeline({ env }).then(
    async (result) => {
      await reportOutcome(result, env, (line) => console.log(line));
      process.exit(0);
    },
    (err: unknown) => {
      console.error(`[error] build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    },
  );
}
