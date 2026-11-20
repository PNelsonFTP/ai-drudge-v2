// The fixture tools: `npm run fixture:refresh` (a build -> test/fixtures/v2) and `npm run data:fixture`
// (test/fixtures/v2 -> public/data/v2). The committed fixture itself is checked in test/fixtures.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_FILES, RIVER, type FeedHealthRow } from "../../shared/contract";
import { checkRiver } from "../../shared/invariants";
import { fixtureBundle } from "../../test/helpers/fixtureData";
import { fixturePath, readFixtureText, registryOfSourcesFile } from "../../test/helpers/fixtures";
import { assertValidBundle } from "../../test/helpers/invariants";
import { PIPELINE } from "../pipeline/context";
import { buildAtom } from "../pipeline/emit/atom";
import { buildOpml } from "../pipeline/emit/opml";
import type { GateFile } from "./check-data";
import { installFixture } from "./data-fixture";
import {
  FIXTURE_DIR,
  FIXTURE_FILES,
  FIXTURE_KEYS,
  FIXTURE_MANIFEST,
  FIXTURE_TRIGGER,
  HEALTH_CASE_TESTS,
  RIVER_MAX_ROWS,
  applyHealthCases,
  buildFixture,
  parseArgs,
  refreshFixture,
  runRefresh,
  sha256,
  trimRiver,
  type FixtureManifest,
  type FullBundle,
} from "./fixture-refresh";

const SITE = "https://pnelsonftp.github.io/ai-drudge-v2/";
const clone = <T>(x: T): T => structuredClone(x);

/**
 * The fixture as the BUILD it was frozen from looked: every source healthy, the trigger of a local
 * run, the counts that go with it. (The refresh tool's own changes, undone.)
 */
function healthyBuild(): FullBundle {
  const b = clone(fixtureBundle) as FullBundle;
  b.health.feeds = b.health.feeds.map((f): FeedHealthRow => ({ id: f.id, ok: true, status: "ok", count: Math.max(1, f.count), failStreak: 0, lastOkAt: b.health.generatedAt }));
  b.front.counts.feedsOk = b.health.feeds.length;
  b.status.run.trigger = "local";
  b.status.feeds = { total: b.health.feeds.length, ok: b.health.feeds.length, failed: 0, carriedForward: 0, quarantined: 0, failedNames: [] };
  b.status.gate = { passed: true, failures: [], warnings: [] };
  return b;
}

/** A bundle as the tool reads it from disk: the eight JSON files plus feed.xml / feeds.opml built from it. */
function filesOf(b: FullBundle): Record<string, GateFile | undefined> {
  const files: Record<string, GateFile | undefined> = {};
  for (const key of FIXTURE_KEYS) files[DATA_FILES[key]] = { text: JSON.stringify(b[key]) };
  files["feed.xml"] = { text: buildAtom(b.front, { siteUrl: SITE }) };
  files["feeds.opml"] = { text: buildOpml(registryOfSourcesFile(b.sources), { siteUrl: SITE }) };
  return files;
}

describe("fixture:refresh - river trim", () => {
  const { river, front, rest } = fixtureBundle;
  const required = new Set([...Object.keys(front.articles), ...Object.keys(rest.articles)]);
  /** Edition articles that are river rows (an article older than the river's 7 days is not). */
  const requiredRows = river.rows.filter((r) => required.has(r[RIVER.id])).length;

  it("leaves a river under the cap alone (same object)", () => {
    assert.equal(trimRiver(river, fixtureBundle, river.rows.length), river);
    assert.equal(trimRiver(river, fixtureBundle, RIVER_MAX_ROWS + river.rows.length), river);
  });

  it("cuts from the old end, keeps every row of an edition article, the order and the source tables", () => {
    const cap = requiredRows + 50;
    assert.ok(requiredRows > 100 && cap < river.rows.length, "fixture: the river holds more than the edition's articles");
    const trimmed = trimRiver(river, fixtureBundle, cap);
    assert.equal(trimmed.rows.length, cap);
    assert.deepEqual(checkRiver(trimmed, front, rest), []);
    for (const id of required) if (river.rows.some((r) => r[RIVER.id] === id)) assert.ok(trimmed.rows.some((r) => r[RIVER.id] === id), id);
    // Order kept: the trimmed rows are a subsequence of the original.
    const kept = new Set(trimmed.rows.map((r) => r[RIVER.id]));
    assert.deepEqual(trimmed.rows, river.rows.filter((r) => kept.has(r[RIVER.id])));
    // The rows that were cut are older than (or as old as) every row kept that is not an edition article.
    const at = (r: (typeof river.rows)[number]): number => r[RIVER.publishedAt] ?? r[RIVER.firstSeenAt];
    const cut = river.rows.filter((r) => !kept.has(r[RIVER.id]));
    const optional = trimmed.rows.filter((r) => !required.has(r[RIVER.id]));
    assert.ok(cut.length > 0 && optional.length === 50);
    assert.ok(Math.max(...cut.map(at)) <= Math.min(...optional.map(at)));
    assert.equal(trimmed.sources, river.sources);
    assert.equal(trimmed.sourceIds, river.sourceIds);
    assert.notEqual(trimmed, river);
  });

  it("never cuts an edition article, even under a cap smaller than the edition", () => {
    const trimmed = trimRiver(river, fixtureBundle, 10);
    assert.ok(trimmed.rows.every((r) => required.has(r[RIVER.id])));
    assert.equal(trimmed.rows.length, requiredRows);
    assert.deepEqual(checkRiver(trimmed, front, rest), []);
    // Deterministic.
    assert.deepEqual(trimRiver(river, fixtureBundle, 10), trimmed);
  });
});

describe("fixture:refresh - health cases", () => {
  it("writes the four missing states onto probation sources, in the shape ingest writes", () => {
    const build = healthyBuild();
    const { health, cases } = applyHealthCases(build);
    assert.deepEqual(cases.map((c) => c.kind), ["carried", "host-backoff", "failing", "quarantined"]);
    assert.equal(new Set(cases.map((c) => c.id)).size, 4);
    const probation = build.sources.sources.filter((s) => s.tags?.includes("probation")).map((s) => s.id);
    // Registry order: the first two probation sources carry, the next ones without an edition article fail.
    assert.deepEqual(cases.slice(0, 2).map((c) => c.id), probation.slice(0, 2));
    const inEdition = new Set([...Object.values(build.front.articles), ...Object.values(build.rest.articles)].map((a) => a.src));
    for (const c of cases) {
      assert.ok(probation.includes(c.id), c.id);
      const row = health.feeds.find((f) => f.id === c.id);
      assert.ok(row && HEALTH_CASE_TESTS[c.kind](row), `${c.id} is not a ${c.kind} row`);
      assert.equal(row.ok, false);
      assert.ok(row.failStreak >= 1 && row.lastError && row.lastOkAt && Date.parse(row.lastOkAt) < Date.parse(health.generatedAt));
      if (c.kind === "failing" || c.kind === "quarantined") {
        assert.equal(row.count, 0);
        assert.ok(!inEdition.has(c.id), `${c.id} has articles in the edition`);
      } else {
        assert.ok(row.count >= 1 && row.carried === true);
      }
    }
    const byKind = Object.fromEntries(cases.map((c) => [c.kind, health.feeds.find((f) => f.id === c.id)])) as Record<string, FeedHealthRow>;
    assert.equal(byKind.quarantined.failStreak >= PIPELINE.quarantineAfterFails, true);
    assert.equal(byKind.quarantined.error, "skipped");
    assert.equal(byKind["host-backoff"].error, "skipped");
    assert.match(byKind["host-backoff"].lastError ?? "", /^host backoff: [a-z0-9.-]+ answered HTTP 502 to 2 requests in a row; not requested this run, \d+ last-good items? carried$/);
    assert.deepEqual([byKind.carried.error, byKind.carried.httpStatus, byKind.carried.lastError], ["http", 403, "HTTP 403"]);
    // Nothing else changed, and the input was not touched.
    const changed = new Set(cases.map((c) => c.id));
    assert.deepEqual(health.feeds.filter((f) => !changed.has(f.id)), build.health.feeds.filter((f) => !changed.has(f.id)));
    assert.ok(build.health.feeds.every((f) => f.ok));
  });

  it("only tops up what the build lacks, and changes nothing when every state is there", () => {
    // The committed fixture has all four: nothing to do, the same object comes back.
    const again = applyHealthCases(fixtureBundle);
    assert.deepEqual(again.cases, []);
    assert.equal(again.health, fixtureBundle.health);

    // A build with a real failing source of its own keeps it and gets the other three.
    const build = healthyBuild();
    const real = build.health.feeds.find((f) => !build.sources.sources.find((s) => s.id === f.id)?.tags?.includes("probation"));
    assert.ok(real);
    Object.assign(real, { ok: false, status: "failing", count: 0, failStreak: 2, error: "http", lastError: "HTTP 500", httpStatus: 500 });
    const { health, cases } = applyHealthCases(build);
    assert.deepEqual(cases.map((c) => c.kind), ["carried", "host-backoff", "quarantined"]);
    assert.deepEqual(health.feeds.find((f) => f.id === real.id), real);
  });

  it("refuses rather than invent a failure on an ordinary source", () => {
    const build = healthyBuild();
    for (const s of build.sources.sources) s.tags = (s.tags ?? []).filter((t) => t !== "probation");
    assert.throws(() => applyHealthCases(build), /health case "carried": no healthy probation source/);
  });
});

describe("fixture:refresh - the fixture of a build", () => {
  it("buildFixture: counts follow the health file, the trigger says fixture, untouched files are the same objects", () => {
    const build = healthyBuild();
    const built = buildFixture(build);
    const b = built.bundle;
    assert.equal(built.healthCases.length, 4);
    assert.deepEqual(built.river, { rowsIn: build.river.rows.length, rowsOut: build.river.rows.length, maxRows: RIVER_MAX_ROWS });
    const count = (status: string): number => b.health.feeds.filter((f) => f.status === status).length;
    assert.deepEqual([count("carried"), count("failing"), count("quarantined")], [2, 1, 1]);
    assert.equal(b.front.counts.feedsOk, count("ok"));
    assert.equal(b.front.counts.feedsTotal, b.health.feeds.length);
    assert.deepEqual(b.status.feeds, { total: b.health.feeds.length, ok: count("ok"), failed: 1, carriedForward: 2, quarantined: 1, failedNames: built.healthCases.map((c) => c.name) });
    assert.equal(b.status.run.trigger, FIXTURE_TRIGGER);
    assertValidBundle(b, "buildFixture");
    for (const key of ["rest", "river", "sources", "brief", "stocks"] as const) assert.equal(b[key], build[key], key);
    assert.deepEqual({ ...b.front, counts: null }, { ...build.front, counts: null }, "only the feed count of front.json changes");
    assert.equal(build.status.run.trigger, "local", "the input is not mutated");

    // --no-health-cases: the build's own health, whatever it is.
    const plain = buildFixture(build, { healthCases: false });
    assert.deepEqual(plain.healthCases, []);
    assert.equal(plain.bundle.health, build.health);
    assert.equal(plain.bundle.front, build.front);
    // --river-rows.
    assert.equal(buildFixture(build, { riverRows: 700 }).bundle.river.rows.length, 700);
  });

  it("refreshFixture: gates the build, writes eight files and a manifest, and is deterministic", () => {
    const build = healthyBuild();
    const files = filesOf(build);
    const r = refreshFixture(files);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.files), [...FIXTURE_FILES]);
    const manifest = r.manifest as FixtureManifest;
    assert.equal(manifest.buildId, build.front.buildId);
    assert.deepEqual(manifest.healthCases.map((c) => c.kind), ["carried", "host-backoff", "failing", "quarantined"]);
    assert.deepEqual(manifest.options, { riverRows: RIVER_MAX_ROWS, healthCases: true });
    // Files no step touched are the build's bytes; the three that carry the health cases are not.
    const modified = FIXTURE_FILES.filter((name) => manifest.files[name].modified);
    assert.deepEqual(modified, ["front.json", "health.json", "status.json"]);
    for (const name of FIXTURE_FILES) {
      const source = (files[name] as { text: string }).text;
      assert.equal(manifest.files[name].sourceSha256, sha256(source), name);
      assert.equal(manifest.files[name].sha256, sha256(r.files[name]), name);
      assert.equal(r.files[name] === source, !manifest.files[name].modified, name);
    }
    assert.equal(manifest.totalBytes, FIXTURE_FILES.reduce((n, name) => n + Buffer.byteLength(r.files[name], "utf8"), 0));
    // The verdict of the FIXTURE is recorded: its four probation sources are named in a warning.
    const status = JSON.parse(r.files["status.json"]) as FullBundle["status"];
    assert.equal(status.gate.passed, true);
    assert.ok(status.gate.warnings.some((w) => w.startsWith("feeds: 4 chronic")), status.gate.warnings.join("\n"));
    assert.ok(r.report.some((l) => l.startsWith("health cases carried -> ")) && r.report.at(-1)?.startsWith("gate         PASS"));
    assert.deepEqual(refreshFixture(filesOf(healthyBuild())), r, "same build, same fixture");
  });

  it("the committed fixture is what the tool writes: refreshing it from itself changes nothing", () => {
    const files = filesOf(fixtureBundle);
    for (const name of FIXTURE_FILES) files[name] = { text: readFixtureText("v2", name) };
    const r = refreshFixture(files);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.manifest?.healthCases, []);
    for (const name of FIXTURE_FILES) {
      assert.equal(r.manifest?.files[name].modified, false, name);
      assert.equal(r.files[name], readFixtureText("v2", name), name);
    }
    const committed = JSON.parse(readFixtureText("v2.manifest.json")) as FixtureManifest;
    for (const name of FIXTURE_FILES) assert.equal(r.manifest?.files[name].sha256, committed.files[name].sha256, name);
    assert.equal(r.manifest?.totalBytes, committed.totalBytes);
  });

  it("refuses a build the gate holds, an AI-written brief, a build without a case tests need, and unreadable files", () => {
    const blank = healthyBuild();
    for (const s of blank.front.sections) s.rows = [];
    const held = refreshFixture(filesOf(blank));
    assert.equal(held.ok, false);
    assert.deepEqual(held.files, {});
    assert.ok(held.problems.some((p) => p.startsWith("the build does not pass the gate: blank:")), held.problems.join("\n"));

    const written = healthyBuild();
    written.brief = { ...written.brief, source: "claude", model: "claude-test-model", fallbackReason: undefined };
    written.status.brief = { source: "claude" };
    const ai = refreshFixture(filesOf(written));
    assert.equal(ai.ok, false);
    assert.match(ai.problems.join("\n"), /^brief\.json is claude: freeze a build made without an API key/);

    const noPaywall = healthyBuild();
    for (const a of [...Object.values(noPaywall.front.articles), ...Object.values(noPaywall.rest.articles)]) {
      if (a.flags) a.flags = a.flags.filter((f) => f !== "paywall");
      if (a.flags?.length === 0) delete a.flags;
    }
    const missing = refreshFixture(filesOf(noPaywall));
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.problems, ["the fixture has no paywalled homepage row - tests select it by property; refresh from a build that has one"]);

    const noProbation = healthyBuild();
    for (const s of noProbation.sources.sources) s.tags = (s.tags ?? []).filter((t) => t !== "probation");
    assert.match(refreshFixture(filesOf(noProbation)).problems.join("\n"), /no healthy probation source/);
    // ... which --no-health-cases does not need - but then the health cases are missing.
    assert.ok(refreshFixture(filesOf(noProbation), { healthCases: false }).problems.some((p) => p.includes("the fixture has no carried source")));

    const none = filesOf(healthyBuild());
    delete none["front.json"];
    assert.match(refreshFixture(none).problems.join("\n"), /front\.json: missing or unreadable - run `npm run build:data` first/);
    const noXml = filesOf(healthyBuild());
    delete noXml["feeds.opml"];
    assert.ok(refreshFixture(noXml).problems.includes("the build does not pass the gate: feeds.opml: missing"));
  });
});

describe("fixture:refresh / data:fixture - on disk", () => {
  async function tempBuild(): Promise<{ root: string; dataDir: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-fixture-"));
    const dataDir = path.join(root, "public/data/v2");
    await fs.mkdir(dataDir, { recursive: true });
    for (const [name, f] of Object.entries(filesOf(healthyBuild()))) {
      if (f && "text" in f) await fs.writeFile(path.join(name.endsWith(".json") ? dataDir : path.join(root, "public"), name), f.text);
    }
    // A build also leaves its state behind: it must never reach the fixture.
    await fs.writeFile(path.join(dataDir, "state.json"), '{"firstSeen":{}}');
    return { root, dataDir };
  }

  it("parses its arguments", () => {
    assert.deepEqual(parseArgs([], "/repo"), {
      fromDir: "/repo/public/data/v2",
      publicDir: "/repo/public",
      toDir: `/repo/${FIXTURE_DIR}`,
      manifestFile: `/repo/${FIXTURE_MANIFEST}`,
      riverRows: RIVER_MAX_ROWS,
      healthCases: true,
      dryRun: false,
    });
    const custom = parseArgs(["--from", "out/data", "--public", "/abs/out", "--to", "tmp/fx", "--river-rows", "800", "--no-health-cases", "--dry-run"], "/repo");
    assert.deepEqual(custom, { fromDir: "/repo/out/data", publicDir: "/abs/out", toDir: "/repo/tmp/fx", manifestFile: "/repo/tmp/fx.manifest.json", riverRows: 800, healthCases: false, dryRun: true });
    for (const bad of [["--nope"], ["--river-rows", "0"], ["--river-rows", "many"], ["--from"]]) assert.throws(() => parseArgs(bad, "/repo"), /unknown or incomplete argument/);
  });

  it("one command: reads a build, writes the fixture and its manifest; --dry-run writes nothing; a held build writes nothing", async () => {
    const { root } = await tempBuild();
    try {
      const dry: string[] = [];
      assert.equal(await runRefresh(parseArgs(["--dry-run"], root), (l) => dry.push(l)), 0);
      assert.equal(dry.at(-1), "dry run: nothing written");
      await assert.rejects(fs.stat(path.join(root, FIXTURE_DIR)));

      const out: string[] = [];
      assert.equal(await runRefresh(parseArgs([], root), (l) => out.push(l)), 0);
      assert.deepEqual((await fs.readdir(path.join(root, FIXTURE_DIR))).sort(), [...FIXTURE_FILES].sort(), "eight files; state.json is not copied");
      const manifest = JSON.parse(await fs.readFile(path.join(root, FIXTURE_MANIFEST), "utf8")) as FixtureManifest;
      for (const name of FIXTURE_FILES) assert.equal(sha256(await fs.readFile(path.join(root, FIXTURE_DIR, name), "utf8")), manifest.files[name].sha256, name);
      assert.ok(out.some((l) => l.startsWith("wrote 8 files to ")) && out.at(-1) === "next: npx tsc -b && npm test");

      // data:fixture installs exactly that, into an EMPTY data directory, and checks it first.
      const target = path.join(root, "site/data/v2");
      const installed = installFixture(path.join(root, FIXTURE_DIR), path.join(root, FIXTURE_MANIFEST), target);
      assert.equal(installed.ok, true, installed.lines.join("\n"));
      assert.match(installed.lines[0], /^data:fixture: installed the build of \S+ in .+ \(8 files: .+\); 4 health rows are synthetic test cases \(.+\)$/);
      assert.deepEqual((await fs.readdir(target)).sort(), [...FIXTURE_FILES].sort());
      for (const name of FIXTURE_FILES) assert.equal(await fs.readFile(path.join(target, name), "utf8"), await fs.readFile(path.join(root, FIXTURE_DIR, name), "utf8"), name);

      // A fixture file edited by hand is not installed.
      const health = path.join(root, FIXTURE_DIR, "health.json");
      await fs.writeFile(health, (await fs.readFile(health, "utf8")).replace('"failStreak":0', '"failStreak":00'));
      const other = path.join(root, "site2");
      const refused = installFixture(path.join(root, FIXTURE_DIR), path.join(root, FIXTURE_MANIFEST), other);
      assert.equal(refused.ok, false);
      assert.match(refused.lines.join("\n"), /health\.json does not match the manifest/);
      await assert.rejects(fs.stat(other), "nothing is written when a file does not match");
      assert.equal(installFixture(path.join(root, FIXTURE_DIR), path.join(root, "nope.json"), other).ok, false);

      // A build the gate holds: exit 1, the existing fixture is left alone.
      await fs.rm(path.join(root, "public/feed.xml"));
      const before = await fs.readFile(path.join(root, FIXTURE_DIR, "front.json"), "utf8");
      const held: string[] = [];
      assert.equal(await runRefresh(parseArgs([], root), (l) => held.push(l)), 1);
      assert.ok(held.includes("REFUSED  the build does not pass the gate: feed.xml: missing"), held.join("\n"));
      assert.equal(await fs.readFile(path.join(root, FIXTURE_DIR, "front.json"), "utf8"), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("the committed fixture installs from the repository as it is", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-install-"));
    try {
      const r = installFixture(fixturePath("v2"), fixturePath("v2.manifest.json"), path.join(target, "data/v2"));
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.deepEqual((await fs.readdir(path.join(target, "data/v2"))).sort(), [...FIXTURE_FILES].sort());
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
