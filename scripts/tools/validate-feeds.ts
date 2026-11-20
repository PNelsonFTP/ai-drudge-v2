// Feed validator: checks EVERY registry source - feeds, scrape pages and JSON APIs - or a candidate
// list, with the same HTTP client, parser and extractors the build uses (V1 had a second, diverging
// parser here and never looked at the scrapers, which were dead for 30 days unnoticed).
//
//   tsx scripts/tools/validate-feeds.ts                      validate the registry (active sources)
//   tsx scripts/tools/validate-feeds.ts --include-paused     ... including paused sources
//   tsx scripts/tools/validate-feeds.ts candidates.json      validate a candidate list
//   VALIDATE_OUT=verdicts.json (or --out verdicts.json)      write the verdict JSON for report-feed-audit
//
// Candidate list formats: [{ name, url, category? }] (V1), SourceDef-like objects (kind / scrape /
// jsonApi honoured), or { accepted: [...], scrapePicks: [...] } as produced by the curation step.
//
// Exit code: 1 when at least one ACTIONABLE problem exists; transient failures (rate limits, gateway
// errors, Reddit / Substack / hnrss blocks - see feedVerdict.ts) are reported but never fail the run.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SourceKind } from "../../shared/contract";
import { bareHost } from "../../shared/url";
import { resolveSource } from "../registry/defaults";
import type { JsonApiConfig, PublisherDef, ScrapeConfig, SourceDef } from "../registry/types";
import { defaultUserAgent, httpFetch, type HttpDeps } from "../pipeline/ingest/http";
import { extractItems, sourceRequest } from "../pipeline/ingest/index";
import { newestAgeDays, oneLine } from "../pipeline/ingest/newest";
import { HostPool, hostKey } from "../pipeline/ingest/pool";
import { realTimers } from "../pipeline/ingest/timers";
import { isTransient, sortVerdicts, staleDaysFor, summarize, verdictForAge, verdictForError, type Verdict } from "./feedVerdict";

export interface Target {
  name: string;
  url: string;
  category?: string;
  id?: string;
  kind?: SourceKind;
  scrape?: ScrapeConfig;
  jsonApi?: JsonApiConfig;
  /** Registry tags; "low-cadence" raises the stale limit (feedVerdict.ts staleDaysFor). */
  tags?: readonly string[];
}

const KINDS: readonly SourceKind[] = ["rss", "newsletter", "papers", "github-release", "query", "community", "aggregator", "scrape", "json"];
/** Count every item of the feed, not only the newest N the build would take. */
const COUNT_ALL = 1000;

// ------------------------------------------------------------------------------------------------
// Targets
// ------------------------------------------------------------------------------------------------

export function targetsFromRegistry(sources: readonly SourceDef[], includePaused = false): Target[] {
  return sources
    .filter((s) => includePaused || (s.status ?? "active") === "active")
    .map((s) => ({ id: s.id, name: s.name, url: s.url, category: s.home, kind: s.kind, scrape: s.scrape, jsonApi: s.jsonApi, ...(s.tags?.length ? { tags: s.tags } : {}) }));
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function candidateTarget(raw: unknown): Target | null {
  if (!isRec(raw)) return null;
  // Curated scrape picks name the page "listingUrl" and the extractor "mode".
  const url = str(raw.url) ?? str(raw.listingUrl);
  const name = str(raw.name) ?? str(raw.id) ?? url;
  if (!url || !name) return null;
  const t: Target = { name, url };
  const id = str(raw.id);
  const category = str(raw.category) ?? str(raw.home);
  if (id) t.id = id;
  if (category) t.category = category;
  const kind = str(raw.kind);
  if (kind && (KINDS as readonly string[]).includes(kind)) t.kind = kind as SourceKind;
  if (isRec(raw.scrape) && str(raw.scrape.base) && str(raw.scrape.linkPattern)) t.scrape = raw.scrape as unknown as ScrapeConfig;
  if (isRec(raw.jsonApi) && typeof raw.jsonApi.titleField === "string") t.jsonApi = raw.jsonApi as unknown as JsonApiConfig;

  const mode = str(raw.mode);
  if (mode === "html-links" && str(raw.base) && str(raw.linkPattern)) {
    t.kind = "scrape";
    t.scrape = { base: String(raw.base), linkPattern: String(raw.linkPattern), dateHint: raw.dateHint ? "time" : "none" };
  } else if (mode === "json-api" && typeof raw.titleField === "string") {
    t.kind = "json";
    t.jsonApi = {
      itemsPath: str(raw.itemsPath) ?? "",
      titleField: raw.titleField,
      urlField: str(raw.urlField),
      urlTemplate: str(raw.urlTemplate),
      dateField: str(raw.dateField),
      summaryField: str(raw.summaryField),
    };
  }
  if (t.scrape && !t.kind) t.kind = "scrape";
  if (t.jsonApi && !t.kind) t.kind = "json";
  return t;
}

/** Targets from a candidate JSON document (see the header for the accepted shapes). Unusable entries are dropped. */
export function targetsFromCandidates(doc: unknown): Target[] {
  const lists: unknown[] = Array.isArray(doc) ? [doc] : isRec(doc) ? [doc.sources, doc.accepted, doc.candidates, doc.scrapePicks] : [];
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const t = candidateTarget(raw);
      if (!t || seen.has(t.url)) continue;
      seen.add(t.url);
      out.push(t);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Checking
// ------------------------------------------------------------------------------------------------

function sourceOf(t: Target): SourceDef {
  const kind: SourceKind = t.kind ?? "rss";
  return { id: t.id ?? t.name, name: t.name, publisher: "validate", url: t.url, kind, scope: "ai", home: "industry", tier: 3, scrape: t.scrape, jsonApi: t.jsonApi, maxItems: COUNT_ALL };
}

/** Fetch and parse one target exactly as the build would, and classify the result. Never throws. */
export async function checkTarget(t: Target, deps: HttpDeps, nowMs: number): Promise<Verdict> {
  const base: Verdict = { name: t.name, url: t.url, verdict: "OK" };
  if (t.category) base.category = t.category;
  if (t.id) base.id = t.id;
  if (t.kind) base.kind = t.kind;
  try {
    const source = resolveSource(sourceOf(t));
    if (source.scrape) source.scrape = { ...source.scrape, maxItems: COUNT_ALL };
    // The build's own request (ingest sourceRequest: same Accept, timeouts and retries). The validator
    // used to have its own numbers (15 s x 2 against the build's 8 s x 3) and called a feed OK that
    // failed every build.
    const res = await httpFetch(sourceRequest(source), deps);
    if (res.kind === "error") {
      const v: Verdict = { ...base, verdict: verdictForError(res.error, res.httpStatus) };
      if (res.httpStatus !== undefined) v.httpStatus = res.httpStatus;
      if (res.finalUrl) v.finalUrl = res.finalUrl;
      if (res.error !== "http") v.note = oneLine(res.detail);
      return v;
    }
    if (res.kind === "not_modified") return { ...base, verdict: "OK", httpStatus: 304, note: "not modified" };

    const located: Verdict = { ...base, httpStatus: res.status, finalUrl: res.finalUrl, redirected: bareHost(res.finalUrl) !== bareHost(t.url) };
    const outcome = extractItems(source, res.text, res.finalUrl, nowMs);
    if (outcome.kind === "failed") {
      const v: Verdict = { ...located, verdict: verdictForError(outcome.error) };
      if (outcome.error === "empty") v.itemCount = 0;
      v.note = oneLine(outcome.error === "not_feed" ? res.contentType.split(";")[0] || "unknown content-type" : outcome.detail);
      return v;
    }
    if (outcome.kind !== "items") return { ...located, verdict: "OK" };
    const age = newestAgeDays(outcome.items, nowMs);
    return { ...located, verdict: verdictForAge(age, staleDaysFor(t.tags)), itemCount: outcome.items.length, newestAgeDays: age === null ? null : Math.round(age * 10) / 10 };
  } catch (e) {
    return { ...base, verdict: "PARSE_FAIL", note: oneLine(`validator error: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

export function formatVerdictLine(v: Verdict): string {
  const age = v.newestAgeDays != null ? `${v.newestAgeDays}d` : "-";
  const redirect = v.redirected ? ` → ${v.finalUrl}` : "";
  return `  ${v.verdict.padEnd(10)} ${String(v.itemCount ?? "-").padStart(4)} items  newest ${age.padStart(7)}  ${v.name}${redirect}`;
}

export interface ValidateOptions {
  nowMs: number;
  /** Requests in flight overall (default 8) - per host it is always 2. */
  concurrency?: number;
  onVerdict?: (v: Verdict) => void;
}

/** Check all targets (per-host concurrency 2). Result is in sortVerdicts order. */
export async function validateTargets(targets: readonly Target[], deps: HttpDeps, opts: ValidateOptions): Promise<Verdict[]> {
  const pool = new HostPool({ maxTotal: opts.concurrency ?? 8 });
  const verdicts = await Promise.all(
    targets.map((t) =>
      pool.run(hostKey(t.url), async () => {
        const v = await checkTarget(t, deps, opts.nowMs);
        opts.onVerdict?.(v);
        return v;
      }),
    ),
  );
  return sortVerdicts(verdicts);
}

/** Console report; returns the process exit code (1 = actionable problems). */
export function reportVerdicts(verdicts: readonly Verdict[], log: (line: string) => void = console.log): number {
  const { ok, actionable, transient, moved } = summarize(verdicts);
  log(`\n=== FEED VALIDATION: ${ok.length}/${verdicts.length} OK ===`);
  for (const v of verdicts) {
    if (v.verdict === "OK") continue;
    log(`  ${v.verdict.padEnd(10)} ${v.name.padEnd(30)} ${v.url}${v.note ? `  (${v.note})` : ""}${isTransient(v) ? " (transient)" : ""}`);
  }
  if (moved.length) {
    log("\n=== REDIRECTED (update URLs) ===");
    for (const v of moved) log(`  ${v.name}: ${v.url} → ${v.finalUrl}`);
  }
  if (actionable.length > 0) {
    log(`\n${actionable.length} actionable source problem${actionable.length === 1 ? "" : "s"} (transient Reddit / hnrss / Substack / rate-limit failures excluded)`);
    return 1;
  }
  if (transient.length > 0) log(`\n${transient.length} transient failure${transient.length === 1 ? "" : "s"} ignored for the exit code`);
  return 0;
}

// ------------------------------------------------------------------------------------------------
// Registry access + CLI
// ------------------------------------------------------------------------------------------------

/**
 * The WP1 registry (scripts/registry/index.ts: SOURCES, PUBLISHERS). Loaded at run time so the feed
 * tools type-check and their tests run whether or not the registry module is present.
 */
export async function loadRegistry(): Promise<{ sources: SourceDef[]; publishers: PublisherDef[] }> {
  const spec = new URL("../registry/index.ts", import.meta.url).href;
  const mod: unknown = await import(spec);
  const sources = isRec(mod) && Array.isArray(mod.SOURCES) ? (mod.SOURCES as SourceDef[]) : null;
  if (!sources) throw new Error("scripts/registry/index.ts does not export SOURCES");
  const publishers = isRec(mod) && Array.isArray(mod.PUBLISHERS) ? (mod.PUBLISHERS as PublisherDef[]) : [];
  return { sources, publishers };
}

export function cliDeps(env: NodeJS.ProcessEnv = process.env): HttpDeps {
  return { fetch: (input, init) => globalThis.fetch(input, init), timers: realTimers, userAgent: defaultUserAgent(env) };
}

export const USAGE = "usage: validate-feeds.ts [<candidates.json>] [--include-paused] [--out <verdicts.json>]   (no file: every registry source - NETWORK)";

/**
 * The flags this tool knows. Anything else starting with "-" is refused BEFORE a single request:
 * `npm run validate:feeds -- --help` (or a typo such as `--dry-run`) used to fall through to
 * validating every registry source - several hundred requests from the caller's machine.
 * Returns "help", an error line, or null when the arguments are fine.
 */
export function checkArgs(argv: readonly string[]): "help" | string | null {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("-")) return "--out needs a file path";
      i++;
    } else if (a.startsWith("-") && a !== "--include-paused") return `unknown argument: ${a}`;
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
    console.error(`validate-feeds: ${bad}\n${USAGE}`);
    return 2;
  }
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const outFlag = argv.indexOf("--out");
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : process.env.VALIDATE_OUT;
  const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");

  let targets: Target[];
  if (file) {
    targets = targetsFromCandidates(JSON.parse(await readFile(file, "utf8")));
    console.log(`Validating ${targets.length} candidate sources from ${file}…`);
  } else {
    const { sources } = await loadRegistry();
    targets = targetsFromRegistry(sources, flags.has("--include-paused"));
    console.log(`Validating ${targets.length} registry sources (${sources.length - targets.length} paused skipped)…`);
  }

  const verdicts = await validateTargets(targets, cliDeps(), { nowMs: Date.now(), onVerdict: (v) => console.log(formatVerdictLine(v)) });
  const code = reportVerdicts(verdicts);
  if (outPath) {
    await writeFile(outPath, JSON.stringify(verdicts, null, 2));
    console.log(`\nWrote ${outPath}`);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error("validate-feeds failed:", e);
      process.exit(1);
    },
  );
}
