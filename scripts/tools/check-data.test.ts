import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StatusFile } from "../../shared/contract";
import { validateBriefFile, validateStatusFile } from "../../shared/guards";
import { hoursAgo, makeRegistry, makeScoredStory, makeSource } from "../../test/helpers/factories";
import { fixtureBundle } from "../../test/helpers/fixtureData";
import { registryOfSourcesFile } from "../../test/helpers/fixtures";
import { createTestContext, emptyState } from "../pipeline/context";
import { buildAtom } from "../pipeline/emit/atom";
import { emit } from "../pipeline/emit/edition";
import { buildOpml } from "../pipeline/emit/opml";
import { SAMPLE_SOURCES, healthFor, itemOf, makePlacements, sample, sampleInput } from "../pipeline/emit/testkit.test";
import { GATE, feedTiers } from "../pipeline/emit/quality";
import { SIZE_LIMITS, serializeBundle, writeBundle } from "../pipeline/emit/write";
import { createMakeBrief } from "../pipeline/enrich/brief";
import { route } from "../pipeline/route/index";
import type { EmitBundle } from "../pipeline/types";
import { FRONT_GZIP_WARN_BYTES, evaluateGate, loadGateFiles, parseArgs, runGate, withGateVerdict, type GateFile, type GateFiles } from "./check-data";

const SITE = "https://pnelsonftp.github.io/ai-drudge-v2/";
type Fixture = typeof fixtureBundle;
const clone = <T>(x: T): T => structuredClone(x);

/** The fixture (a frozen live build) as the gate would read it from disk (+ feed.xml / feeds.opml built from it). */
function fixtureFiles(mutate?: (b: Fixture) => void): Record<string, GateFile | undefined> {
  const b = clone(fixtureBundle);
  mutate?.(b);
  const files: Record<string, GateFile> = {};
  for (const [key, value] of Object.entries(b)) files[`${key}.json`] = { text: JSON.stringify(value) };
  files["feed.xml"] = { text: buildAtom(b.front, { siteUrl: SITE }) };
  // The registry the fixture was built from, read back from its own sources.json (the live registry moves on).
  files["feeds.opml"] = { text: buildOpml(registryOfSourcesFile(b.sources), { siteUrl: SITE }) };
  return files;
}

function filesOf(bundle: EmitBundle): Record<string, GateFile | undefined> {
  return Object.fromEntries(serializeBundle(bundle).map((f) => [f.name, { text: f.content }]));
}

// Every number below is DERIVED from the fixture's own files and the gate thresholds: the fixture
// is replaced by `npm run fixture:refresh`, so nothing of one day's build is pinned.
const PROBATION = new Set(fixtureBundle.sources.sources.filter((s) => s.tags?.includes("probation")).map((s) => s.id));
/** The fixture's own feed tiers. */
const BASE = feedTiers(fixtureBundle.health, GATE.chronicFailStreak, PROBATION);
const TOTAL = BASE.total;
const ACTIVE = fixtureBundle.sources.sources.filter((s) => !s.paused).length;
const TOP = fixtureBundle.front.top.length;
const GENERATED_AT = fixtureBundle.front.generatedAt;
const GENERATED_MS = Date.parse(GENERATED_AT);
/** BUILD_STARTED_AT of the build that wrote the fixture (half a minute before generatedAt), and of a later build. */
const BUILD_STARTED = new Date(GENERATED_MS - 28_000).toISOString();
const NEXT_BUILD_STARTED = new Date(GENERATED_MS + 30 * 60_000).toISOString();
const pct = (x: number): string => `${Math.round(x * 100)}%`;
/** Fewest extra one-run failures that put the ok share of the live feeds under the fail line / the warning line. */
const MASS = Math.floor(BASE.ok - GATE.feedsFailBelow * BASE.live) + 1;
const WARN = Math.floor(BASE.ok - GATE.feedsWarnBelow * BASE.live) + 1;

/**
 * Mark `n` more feeds as failing (the first n healthy ones that are not on probation - a probation
 * source is chronic from its first failure), keeping the cross-file counts consistent.
 */
function failFeeds(b: Fixture, n: number, streak: number, status: "failing" | "carried" = "failing", everyFeed = false): void {
  let left = n;
  for (const f of b.health.feeds) {
    if (left === 0) break;
    if (!f.ok || (!everyFeed && PROBATION.has(f.id))) continue;
    Object.assign(f, { ok: false, status, failStreak: streak, count: status === "carried" ? f.count : 0, error: "timeout", lastError: "timeout after 8000 ms" });
    left--;
  }
  assert.equal(left, 0, `the fixture has fewer than ${n} healthy feeds to fail`);
  const count = (s: string): number => b.health.feeds.filter((f) => f.status === s).length;
  b.front.counts.feedsOk = count("ok");
  b.status.feeds = { ...b.status.feeds, ok: count("ok"), failed: count("failing"), carriedForward: count("carried"), quarantined: count("quarantined") };
}

const AT_BUILD = new Date(GENERATED_MS + 20_000);
const gate = (files: GateFiles, buildStartedAt: string | null = null) => evaluateGate(files, { now: AT_BUILD, buildStartedAt });
const has = (list: readonly string[], re: RegExp): boolean => list.some((x) => re.test(x));

describe("check-data gate: verdicts", () => {
  it("passes the fixture (a frozen live build) and prints the report table", () => {
    const r = gate(fixtureFiles(), BUILD_STARTED);
    assert.deepEqual(r.failures, []);
    assert.equal(r.passed, true);
    const report = r.report.join("\n");
    const { counts, sections } = fixtureBundle.front;
    const homeRows = sections.reduce((n, s) => n + s.rows.length, 0);
    assert.ok(report.includes(`generated   ${GENERATED_AT} (0 min ago), run - / fixture`), report);
    assert.match(report, /freshness\s+ok - generated by this build/);
    assert.ok(report.includes(`stories     ${counts.stories} stories, ${counts.placements} rows, ${homeRows} on the homepage, ${TOP} top`), report);
    assert.ok(report.includes(`sections    ${sections.length} of ${sections.length} with rows; empty: (none)`), report);
    assert.ok(
      report.includes(`feeds       ${BASE.ok}/${TOTAL} ok; live ${BASE.ok}/${BASE.live} (${pct(BASE.okShare)}); ${BASE.failing} failing, ${BASE.carried} carried, ${BASE.empty} empty, ${BASE.quarantined} quarantined, ${BASE.chronic} chronic`),
      report,
    );
    assert.match(report, /front\.json\s+[\d.]+ KB\s+[\d.]+ KB/);
    assert.match(report, /PASS {2}data gate passed/);
    assert.equal(r.sizes.length, 10);
    // The verdict the refresh tool recorded in the fixture's status.json is this verdict.
    assert.deepEqual(fixtureBundle.status.gate, { passed: true, failures: [], warnings: [...r.alerts, ...r.warnings] });
  });

  it("blank: an edition with no rows is held, even though it is structurally valid", () => {
    const ctx = createTestContext();
    const s = sample();
    const blank = emit({ ...sampleInput(ctx, s), placements: makePlacements({ stories: [], rows: {} }) }, ctx);
    const r = evaluateGate(filesOf(blank), { now: ctx.now });
    assert.equal(r.passed, false);
    assert.ok(has(r.failures, /^blank: front\.json has no rows in any section/), r.failures.join("\n"));
    assert.ok(!has(r.failures, /^invariant:|guard/), "a blank edition is a content failure, not a contract failure");
    assert.match(r.report.at(-1) ?? "", /^HOLD {2}data gate failed/);
  });

  it("stale: data generated before this build started is held", () => {
    const r = gate(fixtureFiles(), NEXT_BUILD_STARTED);
    assert.equal(r.passed, false);
    assert.deepEqual(r.failures, [`stale: generatedAt ${GENERATED_AT} is older than this build (started ${NEXT_BUILD_STARTED}) - the pipeline did not write new data`]);
    assert.match(r.report.join("\n"), /freshness\s+STALE/);
  });

  it("freshness is only enforced in CI; locally an old data set is a warning", () => {
    const later = new Date(GENERATED_MS + 5 * 3_600_000);
    const r = evaluateGate(fixtureFiles(), { now: later });
    assert.equal(r.passed, true);
    assert.ok(has(r.warnings, /data is 300 min old/));
    assert.match(r.report.join("\n"), /freshness\s+not enforced \(BUILD_STARTED_AT not set\)/);
  });

  it("hollow: too few stories / sections, or an empty TOP STORIES that should not be empty", () => {
    const ctx = createTestContext();
    const small = evaluateGate(filesOf(emit(sampleInput(ctx), ctx)), { now: ctx.now });
    assert.equal(small.passed, false);
    assert.ok(has(small.failures, /^hollow: 8 stories < 60/), small.failures.join("\n"));
    assert.ok(has(small.failures, /^hollow: only 7 of 15 sections have rows/));

    const noTop = gate(
      fixtureFiles((b) => {
        b.front.top = [];
        b.front.leadId = null;
        b.status.content.top = 0;
      }),
    );
    assert.ok(has(noTop.failures, /^hollow: TOP STORIES is empty although multi-publisher ai-desk stories exist/), noTop.failures.join("\n"));
  });

  it("mass failure: most feeds failing this run holds the build, carried forward or not", () => {
    const outage = gate(fixtureFiles((b) => failFeeds(b, MASS, 1)));
    assert.equal(outage.passed, false);
    const line = `feeds: mass failure - ${BASE.ok - MASS} of ${BASE.live} live feeds ok (${pct((BASE.ok - MASS) / BASE.live)}`;
    assert.ok(outage.failures.some((f) => f.startsWith(line)), outage.failures.join("\n"));
    assert.equal(outage.failures.length, 1, "only the feed rule fires - the cross-file counts were kept consistent");
    assert.equal(gate(fixtureFiles((b) => failFeeds(b, MASS - 1, 1))).passed, true, "one failure fewer is published (with a warning)");

    const carried = gate(fixtureFiles((b) => failFeeds(b, MASS, 1, "carried")));
    assert.ok(has(carried.failures, /mass failure/));

    const total = gate(fixtureFiles((b) => failFeeds(b, b.health.feeds.filter((f) => f.ok).length, 1, "failing", true)));
    assert.ok(total.failures.some((f) => f.startsWith(`feeds: mass failure - 0 of ${TOTAL} feeds fetched this run`)), total.failures.join("\n"));
  });

  it("tiered health: permanently blocked feeds do not eat the margin", () => {
    // A fifth of the registry with a 20-run streak is chronic: excluded from the denominator, warned, published.
    const n = Math.floor(TOTAL * 0.2);
    const chronic = gate(fixtureFiles((b) => failFeeds(b, n, 20)));
    assert.deepEqual(chronic.failures, []);
    assert.ok(chronic.warnings.some((w) => w.startsWith(`feeds: ${BASE.chronic + n} chronic`)), chronic.warnings.join("\n"));
    assert.ok(chronic.report.join("\n").includes(`feeds       ${BASE.ok - n}/${TOTAL} ok; live ${BASE.ok - n}/${BASE.live - n} (${pct((BASE.ok - n) / (BASE.live - n))})`), chronic.report.join("\n"));
    // As a one-run blip, MASS failures trip the mass-failure rule.
    const blip = gate(fixtureFiles((b) => failFeeds(b, MASS, 1)));
    assert.ok(has(blip.failures, /mass failure/));
    // WARN failures (under 85% of the live feeds ok, above 60%): a warning, not a hold.
    assert.ok(WARN >= 1 && WARN < MASS);
    const warn = gate(fixtureFiles((b) => failFeeds(b, WARN, 1)));
    assert.deepEqual(warn.failures, []);
    assert.ok(warn.warnings.some((w) => w.startsWith(`feeds: ${BASE.ok - WARN} of ${BASE.live} live feeds ok (${pct((BASE.ok - WARN) / BASE.live)}`)), warn.warnings.join("\n"));
  });
});

describe("check-data gate: content the old gate let through", () => {
  const RELAXED = { minStories: 1, warnStories: 1, minSectionsWithRows: 1 };

  it("route -> edition -> gate: a starved QUANTUM section may hold a 40-day story from a 45-day source", () => {
    const ctx = createTestContext();
    const s = sample();
    const registry = makeRegistry([
      ...SAMPLE_SOURCES,
      makeSource({ id: "cloudflare-post-quantum", name: "Cloudflare: Post-Quantum", publisher: "cloudflare", home: "quantum", tier: 2, scope: "general", maxAgeDays: 45 }),
      makeSource({ id: "quantum-computing-report", name: "Quantum Computing Report", publisher: "qcr", home: "quantum", tier: 3, scope: "general" }),
    ]);
    const quantum = (source: string, slug: string, title: string, ageH: number, over: object = {}) =>
      makeScoredStory([itemOf(registry, source, { url: `https://${source}.example.com/${slug}`, title, publishedAt: hoursAgo(ageH), ...over })], { score: 30 });
    const fresh = [quantum("quantum-computing-report", "a", "IonQ ships a 256-qubit system", 3), quantum("quantum-computing-report", "b", "Quantinuum raises a new round", 9)];
    // The registry sets maxAgeDays 45 on this source, so normalize copies it onto the item and route
    // may use the story to keep the section at its minimum of three rows.
    const old = quantum("cloudflare-post-quantum", "pq", "The post-quantum future of web privacy", 40 * 24, { maxAgeDays: 45 });
    const expired = quantum("quantum-computing-report", "c", "A 40-day-old story from an ordinary source", 40 * 24);

    const placements = route([...Object.values(s.placements.stories), ...fresh, old, expired], ctx);
    assert.deepEqual(placements.sections.find((x) => x.id === "quantum")?.rows, [fresh[0].lead, fresh[1].lead, old.lead], "the starvation fill places the 40-day story; the ordinary one is cut");

    const bundle = emit({ ...sampleInput(ctx, s), registry, placements, health: healthFor(registry) }, ctx);
    const files = filesOf(bundle);
    const r = evaluateGate(files, { now: ctx.now, buildStartedAt: ctx.now.toISOString(), thresholds: RELAXED });
    assert.deepEqual(r.failures, [], "one deliberately placed old row must not hold the site");
    assert.equal(r.stats?.maxAgeDays, 40);
    // The ceiling this replaces (30 d) held exactly this build.
    const before = evaluateGate(files, { now: ctx.now, buildStartedAt: ctx.now.toISOString(), thresholds: { ...RELAXED, maxItemAgeDays: 30 } });
    assert.deepEqual(before.failures, ["stale content: oldest row is 40.0 d old (> 30 d)"]);
  });

  it("frozen: a re-stamped edition (fresh generatedAt, old news, every feed ok) is held", () => {
    const restamped = (days: number) =>
      fixtureFiles((b) => {
        const at = new Date(GENERATED_MS + days * 86_400_000).toISOString();
        // The river is rebuilt (and pruned to 7 days) by every build; leave its stamp so that rule stays out of the way.
        for (const [key, file] of Object.entries(b)) if (key !== "river") (file as { generatedAt: string }).generatedAt = at;
      });
    const stamp = (days: number) => new Date(GENERATED_MS + days * 86_400_000);
    for (const days of [2, 3, 6]) {
      const r = evaluateGate(restamped(days), { now: new Date(stamp(days).getTime() + 20_000), buildStartedAt: new Date(stamp(days).getTime() - 5_000).toISOString() });
      assert.equal(r.passed, false, `+${days} d`);
      assert.ok(has(r.failures, /^frozen content: newest placed story is \d+ h older than the build \(> 24 h\)$/), r.failures.join("\n"));
      assert.ok(!has(r.failures, /^stale:|^invariant:|guard/), `the files themselves are fresh and consistent: ${r.failures.join(" | ")}`);
    }
  });

  it("hollow homepage: one row per section with full lists behind is held", () => {
    const r = gate(
      fixtureFiles((b) => {
        const keep = new Set<string>(b.front.top);
        for (const s of b.front.sections) {
          s.rows = s.rows.slice(0, 1);
          for (const id of s.rows) keep.add(id);
        }
        // Move the articles that left the homepage to rest.json so every cross-file invariant still holds.
        for (const id of [...keep]) for (const m of b.front.clusters[id]?.members ?? []) keep.add(m);
        for (const [id, a] of Object.entries(b.front.articles)) {
          if (keep.has(id)) continue;
          b.rest.articles[id] = a;
          delete b.front.articles[id];
          if (b.front.clusters[id]) {
            b.rest.clusters[id] = b.front.clusters[id];
            delete b.front.clusters[id];
          }
        }
        for (const [sid, ref] of Object.entries(b.front.sources)) b.rest.sources[sid] ??= ref;
      }),
    );
    const first = fixtureBundle.front.sections[0];
    const hollow = fixtureBundle.front.sections.filter((x) => x.rows.length > 1).length;
    assert.ok(hollow >= 10, "nearly every section of a real build has more than one homepage row");
    assert.ok(r.failures.some((f) => f.startsWith(`hollow homepage: ${hollow} section(s) show fewer rows than they hold (${first.id} 1 of ${first.rows.length}, `)), r.failures.join("\n"));
  });

  it("brief: a Claude brief that could not be written is a warning with its reason, in status.json too", async () => {
    const ctx = createTestContext({ env: { ANTHROPIC_API_KEY: "test-key-not-real" }, fetch: () => Promise.resolve(new Response("model: claude-x not found (request req_1)", { status: 404 })) });
    const s = sample();
    const brief = await createMakeBrief({ retryDelayMs: 0 })(s.placements, ctx);
    const bundle = emit({ ...sampleInput(ctx, s), brief }, ctx);
    assert.deepEqual(bundle.status.brief, { source: "fallback", reason: "http-4xx", failStreak: 1 }, "the first failed build of a streak is recorded");
    assert.equal((bundle.brief as { fallbackReason?: string }).fallbackReason, "http-4xx");
    assert.equal(validateStatusFile(JSON.parse(JSON.stringify(bundle.status))), null, "the reason is an additive field the guard accepts");
    assert.equal(validateBriefFile(JSON.parse(JSON.stringify(bundle.brief))), null);
    assert.ok(!JSON.stringify([bundle.brief, bundle.status]).includes("req_1"), "the API's error text is never published");

    const r = evaluateGate(filesOf(bundle), { now: ctx.now, buildStartedAt: ctx.now.toISOString(), thresholds: RELAXED });
    assert.deepEqual(r.failures, []);
    assert.ok(r.warnings.includes("brief: Claude brief unavailable (http-4xx) - fallback published"), r.warnings.join("\n"));
    assert.match(r.report.join("\n"), /^brief\s+fallback \(http-4xx\), \d bullets$/m);
    assert.ok(bundle.status.gate.warnings.includes("brief: Claude brief unavailable (http-4xx) - fallback published"), "emit records the same warning");

    // No key configured: a choice, not a failure - no warning.
    const noKeyCtx = createTestContext();
    const noKey = emit({ ...sampleInput(noKeyCtx, s), brief: await createMakeBrief()(s.placements, noKeyCtx) }, noKeyCtx);
    assert.deepEqual(noKey.status.brief, { source: "fallback", reason: "no-key" });
    assert.ok(!has(noKey.status.gate.warnings, /^brief:/));
    assert.deepEqual(r.alerts, [], "one failed build is a warning, not an alert");
  });

  it("brief alert: the sixth failed build in a row (key configured) is an error-level signal, published, and never a hold", async () => {
    const failing = (): Promise<Response> => Promise.resolve(new Response("invalid x-api-key (request req_9)", { status: 401 }));
    const s = sample();
    const build = async (previousStreak: number, env: Record<string, string> = { ANTHROPIC_API_KEY: "test-key-not-real" }, fetchImpl: typeof fetch = failing as typeof fetch): Promise<EmitBundle> => {
      // The streak travels in the state as an optional field the shared type may not declare yet.
      const state = { ...emptyState(), ...(previousStreak > 0 ? { briefFailStreak: previousStreak } : {}) };
      const ctx = createTestContext({ env, fetch: fetchImpl, state });
      return emit({ ...sampleInput(ctx, s), brief: await createMakeBrief({ retryDelayMs: 0 })(s.placements, ctx) }, ctx);
    };
    const ALERT = "brief: the Claude brief has failed 6 builds in a row (http-4xx) although an API key is configured - the Daily Brief is not shown; check the key, the model id and the API status";
    const opts = (b: EmitBundle) => ({ now: new Date(b.front.generatedAt), buildStartedAt: b.front.generatedAt, thresholds: RELAXED });

    const fifth = await build(4);
    assert.deepEqual(fifth.status.brief, { source: "fallback", reason: "http-4xx", failStreak: 5 });
    assert.deepEqual(evaluateGate(filesOf(fifth), opts(fifth)).alerts, []);

    const sixth = await build(5);
    assert.deepEqual(sixth.status.brief, { source: "fallback", reason: "http-4xx", failStreak: 6 });
    assert.equal(sixth.status.gate.warnings[0], ALERT, "published in status.json, ahead of the ordinary warnings");
    assert.ok(!has(sixth.status.gate.failures ?? [], /brief/), "an alert is never among the failures");
    assert.equal(validateStatusFile(JSON.parse(JSON.stringify(sixth.status))), null);
    assert.ok(!JSON.stringify(sixth.status).includes("req_9"));
    const r = evaluateGate(filesOf(sixth), opts(sixth));
    assert.equal(r.passed, true, "the edition is good: the alert does not hold it");
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.alerts, [ALERT], "the gate reads the count back from status.json");
    assert.match(r.report.join("\n"), /^ALERT brief: the Claude brief has failed 6 builds in a row/m);
    assert.match(r.report.join("\n"), /^PASS {2}data gate passed with \d+ warning\(s\) and 1 alert\(s\)$/m);

    // On disk, in CI (the production-sized fixture): exit 0, an ::error annotation, the step output
    // for the alert job, and the verdict written back with the count kept.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-alert-"));
    try {
      const args = { dataDir: path.join(dir, "data"), publicDir: dir, writeStatus: true };
      const outputFile = path.join(dir, "github-output.txt");
      const env = { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: outputFile, BUILD_STARTED_AT: BUILD_STARTED };
      await fs.mkdir(args.dataDir, { recursive: true });
      const run = async (reason: string, failStreak: number | undefined, runEnv: Record<string, string> = env, writeStatus = true): Promise<{ code: number; lines: string[]; output: string | null; status: StatusFile }> => {
        const files = fixtureFiles((b) => {
          Object.assign(b.brief, { source: "fallback", fallbackReason: reason });
          delete (b.brief as { model?: string }).model;
          b.status.brief = { source: "fallback", reason, ...(failStreak === undefined ? {} : { failStreak }) } as typeof b.status.brief;
        });
        for (const [name, f] of Object.entries(files)) {
          if (f && "text" in f) await fs.writeFile(path.join(name.endsWith(".json") ? args.dataDir : args.publicDir, name), f.text);
        }
        await fs.rm(outputFile, { force: true });
        const lines: string[] = [];
        const code = await runGate({ ...args, writeStatus }, runEnv, (l) => lines.push(l), AT_BUILD);
        const output = await fs.readFile(outputFile, "utf8").catch(() => null);
        return { code, lines, output, status: JSON.parse(await fs.readFile(path.join(args.dataDir, "status.json"), "utf8")) as StatusFile };
      };

      const alerted = await run("http-4xx", 6);
      assert.equal(alerted.code, 0, alerted.lines.filter((l) => l.startsWith("FAIL")).join("\n"));
      assert.ok(alerted.lines.includes(`::error title=data gate alert::${ALERT}`));
      assert.equal(alerted.output, `brief_alert=${ALERT}\n`);
      assert.equal(alerted.status.gate.passed, true);
      assert.equal(alerted.status.gate.warnings[0], ALERT);
      assert.deepEqual(alerted.status.brief, { source: "fallback", reason: "http-4xx", failStreak: 6 }, "--write-status keeps the count");

      // Not yet six: the output is written EMPTY, so the alert job can tell "no alert" from "no gate".
      const quiet = await run("http-4xx", 5);
      assert.deepEqual([quiet.code, quiet.output], [0, "brief_alert=\n"]);
      assert.ok(!quiet.lines.some((l) => l.includes("data gate alert")));

      // No key configured: silent whatever a (stale) count says.
      const noKey = await run("no-key", 40);
      assert.deepEqual([noKey.code, noKey.output], [0, "brief_alert=\n"]);
      assert.ok(!has(noKey.status.gate.warnings, /^brief:/));

      // Outside GitHub Actions nothing is written anywhere but the report.
      const local = await run("http-4xx", 6, { GITHUB_OUTPUT: outputFile }, false);
      assert.equal(local.code, 0);
      assert.ok(local.lines.some((l) => l.startsWith("ALERT brief:")) && !local.lines.some((l) => l.startsWith("::")));
      assert.equal(local.output, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    // The key is removed after a long streak: the pipeline records no count at all.
    assert.deepEqual((await build(40, {})).status.brief, { source: "fallback", reason: "no-key" });

    // Claude answers again: the count is gone and so is the alert.
    const reply = { model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [] as unknown[] };
    const recovered = await build(40, { ANTHROPIC_API_KEY: "test-key-not-real" }, (() => Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))) as typeof fetch);
    assert.equal((recovered.status.brief as { failStreak?: number }).failStreak, 41, "an unusable reply is still a failed build");
    assert.equal(withGateVerdict(fixtureBundle.status, { passed: true, failures: [], warnings: ["w"], alerts: ["a"] }).gate.warnings.join(","), "a,w");
  });

  it("first paint: front.json above the 48 KB budget is a warning (the fixture, a real build, is under it)", () => {
    assert.ok(FRONT_GZIP_WARN_BYTES <= 48 * 1024);
    const plain = gate(fixtureFiles());
    assert.ok(!has(plain.warnings, /first-paint budget/));
    const base = plain.sizes.find((z) => z.name === "front.json")?.gzip ?? 0;
    assert.ok(base > 20 * 1024 && base <= FRONT_GZIP_WARN_BYTES, `front.json gzips to ${base} bytes`);
    // Incompressible 300-character summaries cost about 225 bytes of gzip each: enough of them to
    // cross the budget by a few KB, whatever the size of the frozen build.
    const articles = Math.ceil((FRONT_GZIP_WARN_BYTES - base) / 100) + 30;
    assert.ok(articles <= Object.keys(fixtureBundle.front.articles).length);
    let seed = 7;
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const noise = (n: number): string => Array.from({ length: n }, () => ALPHABET[((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % ALPHABET.length]).join("");
    const fat = gate(fixtureFiles((b) => Object.values(b.front.articles).slice(0, articles).forEach((a) => void (a.summary = noise(300)))));
    const size = fat.sizes.find((z) => z.name === "front.json")?.gzip ?? 0;
    assert.ok(size > FRONT_GZIP_WARN_BYTES && size < base + articles * 300, `front.json gzips to ${size} bytes (was ${base}, ${articles} summaries replaced)`);
    assert.deepEqual(fat.failures, []);
    assert.ok(has(fat.warnings, /^front\.json: [\d.]+ KB gzip is above the 48\.0 KB first-paint budget$/), fat.warnings.join("\n"));
  });

  it("zero articles: the pipeline's marker in status.json holds the gate and survives --write-status", () => {
    const marker = `zero articles at ${NEXT_BUILD_STARTED}: 0/${TOTAL} sources ok - previous edition kept`;
    const files = fixtureFiles((b) => void (b.status.gate = { passed: false, warnings: [], failures: ["hollow: an emit-time failure the gate re-evaluates itself", marker] }));
    // Locally (no BUILD_STARTED_AT) the kept-previous data looks fine in every other respect.
    const r = evaluateGate(files, { now: AT_BUILD });
    assert.deepEqual(r.failures, [marker]);
    assert.equal(r.passed, false);
    assert.deepEqual(withGateVerdict(fixtureBundle.status, r).gate, { passed: false, failures: [marker], warnings: r.warnings });
  });
});

describe("check-data gate: files", () => {
  it("holds on a missing, unreadable, corrupt or foreign-schema file with a precise reason", () => {
    const missing = fixtureFiles();
    delete missing["rest.json"];
    assert.ok(has(gate(missing).failures, /^rest\.json: missing$/));

    const unreadable = fixtureFiles();
    unreadable["river.json"] = { error: "cannot read (EACCES)" };
    assert.ok(has(gate(unreadable).failures, /^river\.json: cannot read \(EACCES\)$/));

    const corrupt = fixtureFiles();
    corrupt["health.json"] = { text: '{"schemaVersion":2,"feeds":[' };
    assert.ok(has(gate(corrupt).failures, /^health\.json: not valid JSON$/));

    const schema = gate(fixtureFiles((b) => void ((b.front as { schemaVersion: number }).schemaVersion = 3)));
    assert.ok(has(schema.failures, /^front\.json: contract guard failed - front\.schemaVersion: expected 2, got 3/));
    assert.equal(schema.stats, null, "nothing else is evaluated without a valid front.json");

    const badUrl = gate(fixtureFiles((b) => void (Object.values(b.front.articles)[0].url = "javascript:alert(1)")));
    assert.ok(has(badUrl.failures, /front\.json: contract guard failed - front\.articles\.\w+\.url: expected http\(s\) URL/));
  });

  it("holds on a cross-file invariant violation", () => {
    const mixed = gate(fixtureFiles((b) => void (b.rest.buildId = "another-build")));
    assert.ok(has(mixed.failures, /^invariant: rest\.buildId another-build !== front\.buildId/));
    const dangling = gate(fixtureFiles((b) => void b.front.sections[0].rows.unshift("zzzzzzz")));
    assert.ok(has(dangling.failures, /^invariant: front\.sections\.models: row zzzzzzz not in front\.articles/));
  });

  it("checks feed.xml and feeds.opml", () => {
    const broken = fixtureFiles();
    broken["feed.xml"] = { text: '<?xml version="1.0"?><feed><entry><title>unclosed</entry></feed>' };
    assert.ok(has(gate(broken).failures, /^feed\.xml: not well-formed XML/));

    const control = fixtureFiles();
    control["feed.xml"] = { text: (control["feed.xml"] as { text: string }).text.replace("<title>AI DRUDGE</title>", "<title>AI\u0001DRUDGE</title>") };
    assert.ok(has(gate(control).failures, /^feed\.xml: contains a character XML 1\.0 does not allow/));

    const noFeed = fixtureFiles();
    delete noFeed["feed.xml"];
    assert.ok(has(gate(noFeed).failures, /^feed\.xml: missing$/));

    const emptyFeed = fixtureFiles();
    emptyFeed["feed.xml"] = { text: '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>AI DRUDGE</title></feed>\n' };
    assert.ok(gate(emptyFeed).failures.includes(`feed.xml: no entries although TOP STORIES has ${TOP}`));

    const short = fixtureFiles();
    const opml = (short["feeds.opml"] as { text: string }).text;
    short["feeds.opml"] = { text: opml.replace(/ {6}<outline type="rss"[^\n]*\n/, "") };
    assert.ok(gate(short).failures.includes(`feeds.opml: lists ${ACTIVE - 1} sources but ${ACTIVE} are active`), gate(short).failures.join("\n"));

    const v1 = fixtureFiles();
    v1["feed.xml"] = { text: buildAtom(fixtureBundle.front, { siteUrl: "https://pnelsonftp.github.io/ai-drudge/" }) };
    // The feed's self link is checked against the site URL the build was configured with - no
    // literal address: the same feed is right when SITE_URL names that site (V2 served from V1's path).
    const r = evaluateGate(v1, { now: AT_BUILD, siteUrl: SITE });
    assert.deepEqual(r.failures, []);
    assert.ok(has(r.warnings, /feed\.xml: self link https:\/\/pnelsonftp\.github\.io\/ai-drudge\/feed\.xml is not under the configured site URL https:\/\/pnelsonftp\.github\.io\/ai-drudge-v2\/ \(check SITE_URL\)/), r.warnings.join("\n"));
    assert.ok(!has(evaluateGate(v1, { now: AT_BUILD, siteUrl: "https://pnelsonftp.github.io/ai-drudge/" }).warnings, /self link/), "the configured site is never a warning");
    assert.ok(!has(gate(v1).warnings, /self link/), "not checked without a configured site URL");
    assert.ok(!has(evaluateGate(fixtureFiles(), { now: AT_BUILD, siteUrl: SITE }).warnings, /self link/), "the fixture's own feed is under the default site URL");
  });

  it("holds on an absurdly large file and on oversized fields", () => {
    const fat = fixtureFiles((b) => void (b.brief.bullets = ["x".repeat(SIZE_LIMITS["brief.json"])]));
    assert.ok(has(gate(fat).failures, /^brief\.json: \d+ bytes exceeds the \d+ byte ceiling/));
    const longTitle = gate(fixtureFiles((b) => void (Object.values(b.rest.articles)[0].title = "t".repeat(500))));
    assert.ok(has(longTitle.failures, /^payload: 1 titles longer than 300 chars/));
  });
});

describe("check-data gate: command line", () => {
  it("reads a written bundle from disk: exit 0 on a good build, 1 on a bad one, and records the verdict", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-gate-"));
    const args = { dataDir: path.join(root, "public/data/v2"), publicDir: path.join(root, "public"), writeStatus: true };
    const files = fixtureFiles();
    await fs.mkdir(args.dataDir, { recursive: true });
    for (const [name, f] of Object.entries(files)) {
      if (f && "text" in f) await fs.writeFile(path.join(name.endsWith(".json") ? args.dataDir : args.publicDir, name), f.text);
    }
    const out: string[] = [];
    const code = await runGate(args, { BUILD_STARTED_AT: BUILD_STARTED, GITHUB_ACTIONS: "true" }, (l) => out.push(l), AT_BUILD);
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.startsWith("PASS")));
    const status = JSON.parse(await fs.readFile(path.join(args.dataDir, "status.json"), "utf8")) as StatusFile;
    assert.equal(status.gate.passed, true);

    const stale: string[] = [];
    const held = await runGate(args, { BUILD_STARTED_AT: NEXT_BUILD_STARTED, GITHUB_ACTIONS: "true" }, (l) => stale.push(l), AT_BUILD);
    assert.equal(held, 1);
    assert.ok(stale.some((l) => l.startsWith("::error title=data gate::stale: generatedAt")), "failures are annotated in CI");
    const after = JSON.parse(await fs.readFile(path.join(args.dataDir, "status.json"), "utf8")) as StatusFile;
    assert.equal(after.gate.passed, false);
    assert.ok(after.gate.failures?.[0].startsWith("stale:"));

    // In GitHub Actions a missing BUILD_STARTED_AT is a failure, not "freshness not enforced".
    for (const env of [{ GITHUB_ACTIONS: "true" }, { GITHUB_ACTIONS: "true", BUILD_STARTED_AT: "  " }]) {
      const unset: string[] = [];
      assert.equal(await runGate({ ...args, writeStatus: false }, env, (l) => unset.push(l), AT_BUILD), 1);
      assert.ok(unset.includes("::error title=data gate::freshness: BUILD_STARTED_AT is not set in CI - cannot prove this build wrote the data"), unset.join("\n"));
      assert.ok(unset.some((l) => /^freshness\s+NOT CHECKED - BUILD_STARTED_AT is not set in CI/.test(l)));
    }
    // The same files outside CI: still only "not enforced".
    assert.equal(await runGate({ ...args, writeStatus: false }, {}, () => undefined, AT_BUILD), 0);

    await fs.rm(path.join(args.dataDir, "front.json"));
    const none: string[] = [];
    assert.equal(await runGate({ ...args, writeStatus: false }, {}, (l) => none.push(l), AT_BUILD), 1);
    assert.ok(none.some((l) => l === "FAIL  front.json: missing"));
    await fs.rm(root, { recursive: true });
  });

  it("gates exactly what writeBundle wrote (emit -> write -> gate round trip)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-gate-"));
    const ctx = createTestContext();
    const bundle = emit(sampleInput(ctx), ctx);
    const targets = { dataDir: path.join(root, "data/v2"), publicDir: root };
    await writeBundle(bundle, emptyState(), targets);
    const files = await loadGateFiles(targets.dataDir, targets.publicDir);
    assert.equal(Object.values(files).filter((f) => f && "text" in f).length, 10, "state.json is not part of the gate");
    // Relaxed thresholds: the 9-story sample is a valid, fresh, well-formed build in every other respect.
    const r = evaluateGate(files, { now: ctx.now, buildStartedAt: ctx.now.toISOString(), thresholds: { minStories: 1, warnStories: 1, minSectionsWithRows: 1 } });
    assert.deepEqual(r.failures, []);
    await fs.rm(root, { recursive: true });
  });

  it("parses its arguments", () => {
    assert.deepEqual(parseArgs([], "/repo"), { dataDir: "/repo/public/data/v2", publicDir: "/repo/public", writeStatus: false });
    assert.deepEqual(parseArgs(["--dir", "out/data", "--public", "/abs/out", "--write-status"], "/repo"), { dataDir: "/repo/out/data", publicDir: "/abs/out", writeStatus: true });
    assert.throws(() => parseArgs(["--nope"], "/repo"), /unknown argument: --nope/);
    const verdict = withGateVerdict(fixtureBundle.status, { passed: false, failures: ["a"], warnings: ["b"] });
    assert.deepEqual(verdict.gate, { passed: false, failures: ["a"], warnings: ["b"] });
  });
});
