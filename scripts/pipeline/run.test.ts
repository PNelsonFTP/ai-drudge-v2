// The composition root: the whole pipeline on the 2026-11-19 corpus (no network), then two
// consecutive runs against a temp directory to prove the state hand-over and the zero-article guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, type BriefFile, type StatusFile, type StocksFile } from "../../shared/contract";
import { loadFixtureRegistry, loadRawItems } from "../../test/helpers/fixtures";
import { assertValidBundle } from "../../test/helpers/invariants";
import { PIPELINE, TEST_NOW_ISO, createTestContext } from "./context";
import { activeSources, resolveSource } from "../registry/defaults";
import { emit } from "./emit/edition";
import { fallbackBrief } from "./enrich/briefFallback";
import { cleanSummary, cleanText } from "./normalize/text";
import { formatStageTable, processItems, reportOutcome, runPipeline, type RunOptions } from "./run";
import { briefFailStreakOf } from "./emit/quality";
import { STORED_SUMMARY_MAX, parseState } from "./state/store";
import type { FetchStocks, Ingest, IngestOutput, LogLevel, MakeBrief, RawItem, Registry, StateFile } from "./types";

const registry: Registry = loadFixtureRegistry();
const corpus: RawItem[] = loadRawItems();
const NOW = new Date(TEST_NOW_ISO);

const stocks: FetchStocks = async (ctx): Promise<StocksFile> => ({ schemaVersion: SCHEMA_VERSION, buildId: ctx.buildId, generatedAt: ctx.now.toISOString(), asOf: null, order: [], quotes: {} });
const brief: MakeBrief = async (placements, ctx): Promise<BriefFile> => fallbackBrief(placements, ctx);

/** An ingest stage that serves the corpus: every active source of the fixture registry is OK. */
function corpusIngest(items: readonly RawItem[]): Ingest {
  return async (reg, ctx): Promise<IngestOutput> => {
    const bySource = new Map<string, RawItem[]>();
    for (const item of items) bySource.set(item.sourceId, [...(bySource.get(item.sourceId) ?? []), item]);
    const at = ctx.now.toISOString();
    const health = activeSources(reg.sources).map((s) => {
      const count = bySource.get(s.id)?.length ?? 0;
      return count > 0
        ? { sourceId: s.id, ok: true, status: "ok" as const, count, ms: 1, failStreak: 0, lastOkAt: at }
        : { sourceId: s.id, ok: false, status: "failing" as const, count: 0, ms: 1, error: "empty" as const, detail: "no items", failStreak: (ctx.state.health[s.id]?.failStreak ?? 0) + 1, lastOkAt: null };
    });
    const lastGood = Object.fromEntries([...bySource].map(([id, list]) => [id, { fetchedAt: at, bodyAt: at, items: list }]));
    return { items: [...items], health, signals: { hn: { byUrl: new Map() } }, resolvedUrls: {}, lastGood };
  };
}

describe("pipeline: normalize -> relevance -> cluster -> score -> route -> emit on the 2026-11-19 corpus", () => {
  const ctx = createTestContext();
  const p = processItems({ items: corpus, signals: { hn: { byUrl: new Map() } } }, registry, ctx);

  it("every stage hands the next one something sensible", () => {
    assert.equal(p.normalized.items.length + p.normalized.dropped.length >= corpus.length - 60, true, "normalize accounts for (almost) every raw item; same-URL twins fold");
    assert.ok(p.relevance.kept.length > 600 && p.relevance.kept.length < p.normalized.items.length);
    assert.equal(p.stories.reduce((n, s) => n + s.items.length, 0), p.relevance.kept.length, "every kept item is in exactly one story");
    assert.equal(p.scored.length, p.stories.length);
    assert.equal(Object.keys(p.placements.stories).length, p.scored.length);
    assert.equal(p.dropped.length, p.normalized.dropped.length + p.relevance.dropped.length);
  });

  it("the story of the day assembles and leads: Anthropic's IPO with five or more publishers", () => {
    const lead = p.placements.leadId;
    assert.ok(lead);
    const story = p.placements.stories[lead];
    assert.match(story.items.map((i) => i.title).join(" | "), /Anthropic/);
    assert.match(story.items.map((i) => i.title).join(" | "), /IPO|initial public offering|debut/i);
    assert.ok(story.publishers.length >= 5, `lead has ${story.publishers.length} publishers`);
    assert.equal(p.placements.top[0], lead);
    assert.ok(p.placements.top.length >= 4);
    for (const id of p.placements.top) assert.ok(!p.placements.stories[id].items[0].flags.includes("release"), "no release line in TOP STORIES");
  });

  it("the per-source cap does not cut corroboration: over-cap items that share a story with another publisher come back (RE-01)", () => {
    const storyWith = (re: RegExp) => p.stories.filter((s) => s.items.some((i) => re.test(i.title)));
    // OpenAI's own post sat behind 8 newer OpenAI posts; without it the story was led by a third-party changelog.
    const gpt = storyWith(/^Introducing GPT-6\.2 Astra and Sol/);
    assert.equal(gpt.length, 1);
    assert.equal(gpt[0].items[0].sourceId, "openai-news", `GPT-6.2 story led by ${gpt[0].items[0].sourceId}`);
    assert.ok(gpt[0].items.some((i) => i.sourceId === "github-copilot-changelog"), "the changelog item is a member, not the lead");
    assert.ok(gpt[0].publishers.length >= 4);
    // The Reuters copy of the EU Commission attack was over its feed's cap: the story was two single rows.
    const ec = storyWith(/(?:European|EU) Commission confirms/);
    assert.equal(ec.length, 1, "The Record and Reuters share one story");
    assert.ok(ec[0].publishers.length >= 2);
    // What the cap is for still holds: a source's single-publisher rows never exceed its cap.
    const capOf = new Map(registry.sources.map((s) => [s.id, resolveSource(s).maxKept]));
    const alone = new Map<string, number>();
    for (const s of p.stories) if (s.publishers.length < 2) for (const i of s.items) alone.set(i.sourceId, (alone.get(i.sourceId) ?? 0) + 1);
    for (const [id, n] of alone) assert.ok(n <= (capOf.get(id) ?? PIPELINE.sourceCap), `${id}: ${n} single-publisher items over its cap`);
    // The rescue is visible in the records: kept grew, and no rescued item is still listed as a drop.
    const keptIds = new Set(p.relevance.kept.map((i) => `${i.sourceId} ${i.id}`));
    const capDrops = p.relevance.dropped.filter((d) => d.reason === "source_cap");
    assert.ok(capDrops.length > 0);
    for (const d of capDrops) assert.ok(!keptIds.has(`${d.sourceId} ${d.id}`), `${d.title} is both kept and dropped`);
    assert.equal(p.relevance.passed, undefined, "processItems hands on a plain RelevanceOutput");
  });

  it("llama.cpp and llama_index stay separate stories", () => {
    const of = (re: RegExp): string | undefined => p.stories.find((s) => s.items.some((i) => re.test(i.title)))?.lead;
    const cpp = of(/^llama\.cpp\b/i);
    const index = of(/^llama[_-]?index\b/i);
    if (cpp && index) assert.notEqual(cpp, index);
  });

  it("emit turns the placements into a bundle that passes every guard and invariant", () => {
    const health = activeSources(registry.sources).map((s) => ({ sourceId: s.id, ok: true, status: "ok" as const, count: 1, ms: 1, failStreak: 0, lastOkAt: ctx.now.toISOString() }));
    const bundle = emit(
      { placements: p.placements, health, registry, brief: fallbackBrief(p.placements, ctx), stocks: { schemaVersion: SCHEMA_VERSION, buildId: ctx.buildId, generatedAt: ctx.now.toISOString(), asOf: null, order: [], quotes: {} }, dropped: p.dropped },
      ctx,
    );
    assertValidBundle(bundle, "corpus bundle");
    assert.equal(bundle.front.leadId, p.placements.leadId);
    // Members are outlet links: they carry no summary (first-paint budget); leads keep theirs.
    let members = 0;
    for (const file of [bundle.front, bundle.rest]) {
      for (const [lead, c] of Object.entries(file.clusters)) {
        assert.ok(file.articles[lead], lead);
        for (const m of c.members) {
          members++;
          assert.equal(file.articles[m].summary, undefined, `member ${m} of ${lead} carries a summary`);
        }
      }
    }
    assert.ok(members > 50, `${members} members checked`);
    assert.ok(Object.keys(bundle.front.clusters).some((lead) => bundle.front.articles[lead].summary), "leads keep their summaries");
    assert.equal(bundle.front.sections.filter((s) => s.rows.length > 0).length >= 12, true);
  });
});

describe("runPipeline: files, state hand-over, zero-article guard", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aid2-run-"));
  const dataDir = path.join(tmp, "public/data/v2");
  const publicDir = path.join(tmp, "public");
  const logs: { level: LogLevel; msg: string }[] = [];
  const options = (over: Partial<RunOptions>): RunOptions => ({
    env: {},
    registry,
    dataDir,
    publicDir,
    explainFile: path.join(tmp, "explain.json"),
    log: (level, msg) => void logs.push({ level, msg }),
    fetch: () => Promise.reject(new Error("network disabled in tests")),
    stages: { ingest: corpusIngest(corpus), makeBrief: brief, fetchStocks: stocks },
    ...over,
  });
  const read = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8")) as T;

  it("first run (empty state): writes every file; dated items are first seen when published, not 'now'", async () => {
    const r = await runPipeline(options({ now: NOW }));
    assert.equal(r.outcome, "written");
    for (const f of ["front.json", "rest.json", "river.json", "health.json", "sources.json", "status.json", "brief.json", "stocks.json", "state.json"]) assert.ok(fs.existsSync(path.join(dataDir, f)), f);
    for (const f of ["feed.xml", "feeds.opml"]) assert.ok(fs.existsSync(path.join(publicDir, f)), f);
    assert.ok(fs.existsSync(path.join(tmp, "explain.json")));
    assert.ok(r.bundle && r.state && r.processed);
    assertValidBundle(r.bundle, "first run");

    const state = read<StateFile>("state.json");
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.buildId, r.buildId);
    assert.equal(Object.keys(state.firstSeen).length, r.processed.normalized.items.length);
    const dated = r.processed.normalized.items.filter((i) => i.publishedAt !== null && Date.parse(i.publishedAt) < NOW.getTime());
    assert.ok(dated.length > 1000);
    for (const i of dated) assert.equal(state.firstSeen[i.id], i.publishedAt, "bootstrap: first seen = published");
    const newNow = r.bundle.river.rows.filter((row) => row[6] === NOW.getTime()).length;
    assert.ok(newNow < r.bundle.river.rows.length * 0.05, `${newNow} of ${r.bundle.river.rows.length} river rows are stamped first-seen-now on the first build`);

    // state.json is public: the last-good snapshots hold plain text, not the publishers' HTML ...
    const rawBySource = new Map<string, RawItem[]>();
    for (const item of corpus) rawBySource.set(item.sourceId, [...(rawBySource.get(item.sourceId) ?? []), item]);
    let saved = 0;
    let changed = 0;
    for (const [id, snap] of Object.entries(state.lastGood)) {
      const raw = rawBySource.get(id) ?? [];
      assert.equal(snap.items.length, raw.length, `${id}: no snapshot item is dropped`);
      snap.items.forEach((item, k) => {
        saved++;
        const stored = item.summaryHtml ?? "";
        assert.ok(!stored.includes("<"), `${id}: a tag survived in the saved summary`);
        assert.ok(cleanText(stored).length <= STORED_SUMMARY_MAX, `${id}: saved summary longer than ${STORED_SUMMARY_MAX}`);
        // ... and the next build (304 / carry-forward reuse) derives the same summary from it.
        if (cleanSummary(stored, { title: item.title }) !== cleanSummary(raw[k].summaryHtml, { title: raw[k].title })) changed++;
      });
    }
    assert.equal(saved, corpus.length);
    assert.ok(changed <= saved * 0.005, `${changed} of ${saved} derived summaries change when read back from the slimmed state`);
    assert.equal(r.keptReason, null);

    assert.deepEqual(r.stages.map((s) => s.stage), ["loadState", "ingest", "normalize", "relevance", "cluster", "score", "route", "brief+stocks", "emit", "write"]);
    assert.match(formatStageTable(r.stages), /^stage +ms +counts\n-+ +-+ +-+\nloadState/);
    assert.match(r.stages[0].counts, /first run/);
  });

  it("second run: the ledger is restored, known items keep their first-seen time, new items are stamped now, the lead holds", async () => {
    const before = read<StateFile>("state.json");
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const rssSource = registry.sources.find((src) => src.kind === "rss" && src.scope === "ai" && corpus.some((i) => i.sourceId === src.id));
    assert.ok(rssSource);
    const fresh: RawItem = { sourceId: rssSource.id, title: "A brand new AI model release nobody has seen", link: "https://example.com/brand-new-ai-story", publishedRaw: null, summaryHtml: null };
    const r = await runPipeline(options({ now: later, stages: { ingest: corpusIngest([...corpus, fresh]), makeBrief: brief, fetchStocks: stocks } }));
    assert.equal(r.outcome, "written");
    assert.ok(r.bundle && r.state && r.processed);
    assertValidBundle(r.bundle, "second run");
    assert.doesNotMatch(r.stages[0].counts, /first run/);

    const after = read<StateFile>("state.json");
    for (const [id, at] of Object.entries(before.firstSeen)) assert.equal(after.firstSeen[id], at, `first-seen of ${id} changed`);
    const added = Object.keys(after.firstSeen).filter((id) => !(id in before.firstSeen));
    assert.equal(added.length, 1);
    assert.equal(after.firstSeen[added[0]], later.toISOString(), "an item first met on a later build is new NOW (no baseline back-dating)");
    assert.equal(after.lead?.id, before.lead?.id, "lead stability");
    assert.equal(after.lead?.since, before.lead?.since, "the lead's tenure carries over");
    assert.ok(after.recent.length >= before.recent.length);
    assert.equal(read<StatusFile>("status.json").buildId, r.buildId);
  });

  it("zero-article guard: nothing is replaced, status.json is marked, the run does not throw", async () => {
    const frontBefore = fs.readFileSync(path.join(dataDir, "front.json"), "utf8");
    const stateBefore = fs.readFileSync(path.join(dataDir, "state.json"), "utf8");
    const r = await runPipeline(options({ now: new Date(NOW.getTime() + 60 * 60_000), stages: { ingest: corpusIngest([]), makeBrief: brief, fetchStocks: stocks } }));
    assert.equal(r.outcome, "kept-previous");
    assert.equal(r.bundle, null);
    assert.equal(fs.readFileSync(path.join(dataDir, "front.json"), "utf8"), frontBefore);
    assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"), stateBefore);
    const status = read<StatusFile>("status.json");
    assert.equal(status.gate.passed, false);
    assert.match(status.gate.failures?.at(-1) ?? "", /^zero articles/);
    assert.ok(logs.some((l) => l.level === "error" && /zero articles/.test(l.msg)));
    assert.match(r.keptReason ?? "", /^zero articles at .*: 0\/\d+ sources ok - previous edition kept$/);
    assert.equal(r.keptReason, status.gate.failures?.at(-1));

    // In GitHub Actions the reason is annotated and the step output says why the gate will hold.
    const outputFile = path.join(tmp, "github-output.txt");
    fs.writeFileSync(outputFile, "");
    const lines: string[] = [];
    await reportOutcome(r, { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: outputFile }, (l) => lines.push(l));
    assert.deepEqual(lines, [`::error title=data build::${r.keptReason}`]);
    assert.equal(fs.readFileSync(outputFile, "utf8"), "outcome=kept-previous\n");
    await reportOutcome({ outcome: "written", keptReason: null }, { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: outputFile }, (l) => lines.push(l));
    assert.equal(lines.length, 1, "a written edition is not annotated");
    assert.equal(fs.readFileSync(outputFile, "utf8"), "outcome=kept-previous\noutcome=written\n");
    const local: string[] = [];
    await reportOutcome(r, { GITHUB_OUTPUT: outputFile }, (l) => local.push(l));
    assert.deepEqual(local, [], "outside Actions nothing is printed or written");
    assert.equal(fs.readFileSync(outputFile, "utf8").split("\n").length, 3);
    const unwritable: string[] = [];
    await reportOutcome(r, { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: path.join(tmp, "no-such-dir/out") }, (l) => unwritable.push(l));
    assert.deepEqual(unwritable, [`::error title=data build::${r.keptReason}`, "::warning title=data build::could not write the step output file"]);
  });

  it("the API key reaches makeBrief only, and raw feed HTML never reaches state.json", async () => {
    const seen: Record<string, string | undefined> = {};
    const rssSource = registry.sources.find((src) => src.kind === "rss" && src.scope === "ai" && corpus.some((i) => i.sourceId === src.id));
    assert.ok(rssSource);
    const html = `<p>OpenAI &amp; Anthropic <b>both</b> shipped new AI models today.</p><img src="https://tracker.example/p.gif"><script>track()</script>${"<p>Subscriber-only paragraph about the AI model release. </p>".repeat(60)}`;
    const rich: RawItem = { sourceId: rssSource.id, title: "Two labs ship new AI models on the same day", link: "https://example.com/two-labs-ship-ai-models", publishedRaw: NOW.toISOString(), summaryHtml: html };
    const serve = corpusIngest([...corpus, rich]);
    const r = await runPipeline(
      options({
        now: new Date(NOW.getTime() + 75 * 60_000),
        env: { ANTHROPIC_API_KEY: "test-key-not-real", SITE_URL: "https://example.test/site/" },
        dataDir: path.join(tmp, "keyed/data"),
        publicDir: path.join(tmp, "keyed"),
        explainFile: null,
        stages: {
          ingest: (reg, ctx) => {
            seen.ingest = ctx.env.ANTHROPIC_API_KEY;
            seen.ingestSite = ctx.env.SITE_URL;
            assert.ok(!("ANTHROPIC_API_KEY" in ctx.env));
            return serve(reg, ctx);
          },
          makeBrief: (placements, ctx) => {
            seen.brief = ctx.env.ANTHROPIC_API_KEY;
            return brief(placements, ctx);
          },
          fetchStocks: (ctx) => {
            seen.stocks = ctx.env.ANTHROPIC_API_KEY;
            return stocks(ctx);
          },
        },
      }),
    );
    assert.equal(r.outcome, "written");
    assert.deepEqual(seen, { ingest: undefined, ingestSite: "https://example.test/site/", brief: "test-key-not-real", stocks: undefined });
    for (const f of fs.readdirSync(path.join(tmp, "keyed/data"))) assert.ok(!fs.readFileSync(path.join(tmp, "keyed/data", f), "utf8").includes("test-key-not-real"), `${f} holds the key`);

    const state = JSON.parse(fs.readFileSync(path.join(tmp, "keyed/data/state.json"), "utf8")) as StateFile;
    const stored = state.lastGood[rssSource.id].items.find((i) => i.link === rich.link)?.summaryHtml ?? "";
    assert.ok(stored.startsWith("OpenAI &amp; Anthropic both shipped new AI models today."), stored.slice(0, 80));
    assert.ok(!/<|tracker\.example/.test(stored), "tags, image URLs and scripts are gone");
    assert.ok(stored.length < html.length / 5 && cleanText(stored).length <= STORED_SUMMARY_MAX);
    assert.equal(cleanSummary(stored, { title: rich.title }), cleanSummary(html, { title: rich.title }), "the next build derives the same summary from the saved text");
    assert.ok(!fs.readFileSync(path.join(tmp, "keyed/data/state.json"), "utf8").includes("<script"));
  });

  // TP-11: every way the remote state can be unusable ends in a first-run build, never in a throw.
  const badRemotes: [string, string, (() => Promise<Response>) | null, RegExp][] = [
    ["HTTP 404", "https://example.test/state.json", () => Promise.resolve(new Response("not found", { status: 404 })), /answered HTTP 404 - no remote state/],
    ["HTTP 500", "https://example.test/state.json", () => Promise.resolve(new Response("oops", { status: 500 })), /answered HTTP 500 - no remote state/],
    ["not JSON (an HTML error page)", "https://example.test/state.json", () => Promise.resolve(new Response("<!doctype html><title>404</title>", { status: 200 })), /could not restore from/],
    ["JSON of another schema", "https://example.test/state.json", () => Promise.resolve(new Response(JSON.stringify({ schemaVersion: 1, firstSeen: {} }), { status: 200 })), /is not a schemaVersion 2 state file - ignored/],
    ["a JSON array", "https://example.test/state.json", () => Promise.resolve(new Response("[]", { status: 200 })), /is not a schemaVersion 2 state file - ignored/],
    ["JSON null", "https://example.test/state.json", () => Promise.resolve(new Response("null", { status: 200 })), /is not a schemaVersion 2 state file - ignored/],
    ["the fetch rejects", "https://example.test/state.json", () => Promise.reject(new Error("getaddrinfo ENOTFOUND example.test")), /could not restore from .*ENOTFOUND/],
    ["not an http(s) URL", "file:///etc/passwd", null, /STATE_URL is not an http\(s\) URL - ignored/],
    ["a bare word", "state.json", null, /STATE_URL is not an http\(s\) URL - ignored/],
  ];
  for (const [name, url, respond, logged] of badRemotes) {
    it(`STATE_URL failure (${name}): logged, treated as a first run, the build still writes`, async () => {
      const dir = fs.mkdtempSync(path.join(tmp, "bad-remote-"));
      const stateFile = path.join(dir, "state/state.json");
      let asked = 0;
      const fetchState = (() => {
        asked++;
        return respond ? respond() : Promise.reject(new Error("must not be fetched"));
      }) as typeof fetch;
      logs.length = 0;
      const r = await runPipeline(options({ now: NOW, env: { STATE_FILE: stateFile, STATE_URL: url }, fetch: fetchState, dataDir: path.join(dir, "data"), publicDir: dir, explainFile: null }));
      assert.equal(asked, respond ? 1 : 0, "a non-http(s) URL is never fetched");
      assert.ok(logs.some((l) => logged.test(l.msg)), logs.map((l) => l.msg).slice(0, 4).join(" | "));
      assert.equal(r.outcome, "written");
      assert.match(r.stages[0].counts, /first run/);
      assert.equal((JSON.parse(fs.readFileSync(stateFile, "utf8")) as StateFile).buildId, r.buildId, "the run leaves a valid state behind");
    });
  }

  it("STATE_URL is not consulted while the state file exists", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "has-state-"));
    const stateFile = path.join(dir, "state.json");
    fs.copyFileSync(path.join(dataDir, "state.json"), stateFile);
    let asked = 0;
    const fetchState = (() => {
      asked++;
      return Promise.reject(new Error("must not be fetched"));
    }) as typeof fetch;
    const r = await runPipeline(options({ now: new Date(NOW.getTime() + 60 * 60_000), env: { STATE_FILE: stateFile, STATE_URL: "https://example.test/state.json" }, fetch: fetchState, dataDir: path.join(dir, "data"), publicDir: dir, explainFile: null }));
    assert.equal(asked, 0);
    assert.doesNotMatch(r.stages[0].counts, /first run/);
  });

  it("zero-article guard without a previous status.json: nothing to mark, nothing written, no throw", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "no-status-"));
    logs.length = 0;
    const r = await runPipeline(options({ now: NOW, dataDir: path.join(dir, "data"), publicDir: dir, explainFile: null, stages: { ingest: corpusIngest([]), makeBrief: brief, fetchStocks: stocks } }));
    assert.equal(r.outcome, "kept-previous");
    assert.match(r.keptReason ?? "", /^zero articles at /);
    assert.ok(logs.some((l) => /status\.json: nothing to mark/.test(l.msg)));
    assert.equal(fs.existsSync(path.join(dir, "data")), false, "no data directory is created for a build that writes nothing");
  });

  it("a stage that throws rejects the run and leaves the previous edition byte-for-byte in place", async () => {
    const before = Object.fromEntries(["front.json", "status.json", "state.json"].map((f) => [f, fs.readFileSync(path.join(dataDir, f), "utf8")]));
    const later = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const failingIngest: Ingest = () => Promise.reject(new Error("ingest blew up"));
    await assert.rejects(() => runPipeline(options({ now: later, stages: { ingest: failingIngest, makeBrief: brief, fetchStocks: stocks } })), /ingest blew up/);
    const failingBrief: MakeBrief = () => Promise.reject(new Error("brief blew up"));
    await assert.rejects(() => runPipeline(options({ now: later, stages: { ingest: corpusIngest(corpus), makeBrief: failingBrief, fetchStocks: stocks } })), /brief blew up/);
    for (const [f, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dataDir, f), "utf8"), text, `${f} changed`);
  });

  // What CI hands the pipeline when neither copy of the state could be restored (first deploy, a
  // deleted data branch, a truncated download): no file, or a file that is not a state. The build
  // must come up clean, publish, and leave a state the NEXT build can continue from.
  for (const [name, seed] of [
    ["no state file at all", null],
    ["an empty state file", ""],
    ["a truncated download", '{"schemaVersion":2,"firstSeen":{"abc":"2026-11-19T'],
    ["a state of another schema", JSON.stringify({ schemaVersion: 1, firstSeen: { x: "2026-01-01T00:00:00Z" } })],
  ] as const) {
    it(`no usable state (${name}): a clean bootstrap that publishes, and the next build continues from it`, async () => {
      const dir = fs.mkdtempSync(path.join(tmp, "bootstrap-"));
      const data = path.join(dir, "public/data/v2");
      const run = (now: Date): ReturnType<typeof runPipeline> => runPipeline(options({ now, dataDir: data, publicDir: path.join(dir, "public"), explainFile: null }));
      if (seed !== null) {
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, "state.json"), seed);
      }
      logs.length = 0;
      const first = await run(NOW);
      assert.equal(first.outcome, "written");
      assert.match(first.stages[0].counts, /^0 first-seen ids, 0 recent, 0 last-good \(first run\)$/);
      assert.ok(logs.some((l) => /^state: .*(?:no previous state|starting empty)/.test(l.msg)), "the log says the build started without memory");
      assert.ok(first.bundle);
      assertValidBundle(first.bundle, `bootstrap (${name})`);
      assert.deepEqual(first.bundle.status.gate.failures, [], "a bootstrap build passes the content gate");
      // Baseline semantics: old items are not all "new now".
      const stampedNow = first.bundle.river.rows.filter((row) => row[6] === NOW.getTime()).length;
      assert.ok(stampedNow < first.bundle.river.rows.length * 0.05, `${stampedNow} of ${first.bundle.river.rows.length} rows first-seen now`);

      const saved = JSON.parse(fs.readFileSync(path.join(data, "state.json"), "utf8")) as StateFile;
      assert.deepEqual([saved.schemaVersion, saved.buildId, saved.savedAt], [2, first.buildId, NOW.toISOString()]);
      assert.ok(Object.keys(saved.firstSeen).length > 1000 && saved.recent.length > 100 && Object.keys(saved.lastGood).length > 50 && saved.lead !== null);

      const second = await run(new Date(NOW.getTime() + 30 * 60_000));
      assert.equal(second.outcome, "written");
      assert.doesNotMatch(second.stages[0].counts, /first run/);
      const after = JSON.parse(fs.readFileSync(path.join(data, "state.json"), "utf8")) as StateFile;
      assert.deepEqual(after.firstSeen, saved.firstSeen, "nothing is re-stamped on the build after a bootstrap");
      assert.equal(after.lead?.since, saved.lead?.since);
    });
  }

  it("brief failure streak: written to state.json while a keyed brief keeps failing, gone when Claude answers or the key is removed", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "brief-streak-"));
    const data = path.join(dir, "data");
    const failing: MakeBrief = async (placements, ctx) => ({ ...fallbackBrief(placements, ctx), fallbackReason: "http-4xx" });
    const noKey: MakeBrief = async (placements, ctx) => ({ ...fallbackBrief(placements, ctx), fallbackReason: "no-key" });
    const claude: MakeBrief = async (placements, ctx) => ({ ...fallbackBrief(placements, ctx), source: "claude", model: "claude-test", bullets: ["a", "b", "c"] });
    let n = 0;
    const run = async (makeBrief: MakeBrief): Promise<{ state: number; status: unknown; warnings: string[]; logged: boolean }> => {
      logs.length = 0;
      const r = await runPipeline(options({ now: new Date(NOW.getTime() + n++ * 30 * 60_000), env: { ANTHROPIC_API_KEY: "test-key-not-real" }, dataDir: data, publicDir: dir, explainFile: null, stages: { ingest: corpusIngest(corpus), makeBrief, fetchStocks: stocks } }));
      assert.equal(r.outcome, "written");
      const text = fs.readFileSync(path.join(data, "state.json"), "utf8");
      const status = JSON.parse(fs.readFileSync(path.join(data, "status.json"), "utf8")) as StatusFile;
      return { state: briefFailStreakOf(JSON.parse(text)), status: (status.brief as { failStreak?: number }).failStreak, warnings: status.gate.warnings, logged: logs.some((l) => /brief: \d+ builds? in a row without a Claude brief/.test(l.msg)) };
    };
    // The streak survives a build because the state reader keeps the optional field
    // (PipelineState.briefFailStreak, state/store.ts parseState). If a reader ever drops it, every
    // build starts from 0 and the alert can never fire - this line says so before the counts below do.
    assert.equal(briefFailStreakOf(parseState({ schemaVersion: 2, briefFailStreak: 3 })), 3, "parseState must keep briefFailStreak");

    const first = await run(failing);
    assert.deepEqual([first.state, first.status, first.logged], [1, 1, true]);
    assert.ok(!first.warnings.some((w) => /builds in a row/.test(w)));
    let last = first;
    for (let i = 2; i <= 6; i++) {
      last = await run(failing);
      assert.deepEqual([last.state, last.status], [i, i], `build ${i}`);
      assert.equal(last.warnings.some((w) => /^brief: the Claude brief has failed \d+ builds in a row/.test(w)), i >= 6, `build ${i}: alert`);
    }
    assert.match(last.warnings[0], /^brief: the Claude brief has failed 6 builds in a row \(http-4xx\) although an API key is configured/, "the sixth failed build raises the alert, ahead of the ordinary warnings");

    const answered = await run(claude);
    assert.deepEqual([answered.state, answered.status, answered.logged], [0, undefined, false]);
    assert.ok(!fs.readFileSync(path.join(data, "state.json"), "utf8").includes("briefFailStreak"), "a zero streak is not written");
    assert.deepEqual([(await run(failing)).state, (await run(noKey)).state], [1, 0], "a removed key starts the count over, silently");
  });

  it("STATE_FILE and STATE_URL: a missing state file is restored from the URL before the run", async () => {
    const stateFile = path.join(tmp, "elsewhere/state.json");
    const remote = fs.readFileSync(path.join(dataDir, "state.json"), "utf8");
    const asked: string[] = [];
    const fetchState = ((input: string | URL | Request) => {
      asked.push(String(input));
      return Promise.resolve(new Response(remote, { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    const r = await runPipeline(
      options({ now: new Date(NOW.getTime() + 90 * 60_000), env: { STATE_FILE: stateFile, STATE_URL: "https://example.test/data/v2/state.json" }, fetch: fetchState, dataDir: path.join(tmp, "other/data"), publicDir: path.join(tmp, "other") }),
    );
    assert.deepEqual(asked, ["https://example.test/data/v2/state.json"]);
    assert.equal(r.outcome, "written");
    assert.doesNotMatch(r.stages[0].counts, /first run/);
    assert.ok(fs.existsSync(stateFile), "the next state is written back to STATE_FILE");
    assert.equal((JSON.parse(fs.readFileSync(stateFile, "utf8")) as StateFile).buildId, r.buildId);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
