// Conformance of everything under test/fixtures (the shared ground truth of all V2 packages).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hashId } from "../shared/ids";
import { SECTIONS, isSectionId, legacyToSections } from "../shared/sections";
import { slugify } from "../shared/text";
import { isHttpUrl } from "../shared/url";
import { resolveSource } from "../scripts/registry/defaults";
import { PIPELINE } from "../scripts/pipeline/context";
import { FIXTURE_FILES, FIXTURE_TRIGGER, NO_KEY_REASON, sha256, type FixtureManifest } from "../scripts/tools/fixture-refresh";
import { missingFixtureCases } from "./helpers/fixtureCases";
import { fixtureBundle, fixtureCases, fixtureEdition, fixtureHealthRow, fixtureSource, fixtureSourceInfo, fixtureStory, FIXTURE_GENERATED_AT, FIXTURE_GENERATED_MS } from "./helpers/fixtureData";
import { BRIDGED_DIR, BRIDGED_GENERATED_AT, fakeFetch, feedFixtureResponse, feedFixtures, fixturePath, loadBridgedEdition, loadBridgedFiles, loadCorpus, loadFixtureRegistry, loadRawItems, loadV1Sources, readFeedFixture, readFixtureJson, readFixtureText } from "./helpers/fixtures";
import { assertValidBundle } from "./helpers/invariants";

describe("fixtures: v2 data (a frozen live build)", () => {
  const manifest = readFixtureJson<FixtureManifest>("v2.manifest.json");
  const edition = fixtureEdition();

  it("passes guards + invariants", () => {
    assertValidBundle(fixtureBundle, "test/fixtures/v2");
  });

  it("is exactly what `npm run fixture:refresh` wrote: every file matches the manifest", () => {
    assert.equal(manifest.buildId, fixtureBundle.front.buildId);
    assert.equal(manifest.generatedAt, FIXTURE_GENERATED_AT);
    assert.deepEqual(Object.keys(manifest.files), [...FIXTURE_FILES]);
    assert.deepEqual(fs.readdirSync(fixturePath("v2")).sort(), [...FIXTURE_FILES].sort(), "the eight public files and nothing else (no state.json)");
    let total = 0;
    for (const name of FIXTURE_FILES) {
      const text = readFixtureText("v2", name);
      const entry = manifest.files[name];
      assert.equal(sha256(text), entry.sha256, `${name} was changed after the refresh - run \`npm run fixture:refresh\` instead of editing it`);
      assert.equal(Buffer.byteLength(text, "utf8"), entry.bytes, name);
      assert.equal(entry.modified, entry.sha256 !== entry.sourceSha256, name);
      total += entry.bytes;
    }
    assert.equal(manifest.totalBytes, total);
    assert.equal(manifest.river.rowsOut, fixtureBundle.river.rows.length);
    // The edition itself is the build's: rest.json, river.json (under the cap), sources.json, brief.json and stocks.json are byte copies.
    for (const name of ["rest.json", "sources.json", "brief.json", "stocks.json"]) assert.equal(manifest.files[name].modified, false, name);
    assert.equal(manifest.files["river.json"].modified, manifest.river.rowsOut < manifest.river.rowsIn);
  });

  it("stays small: under 1 MB, river under its row cap, no pipeline state", (t) => {
    t.diagnostic(`fixture: ${(manifest.totalBytes / 1024).toFixed(1)} KB in ${FIXTURE_FILES.length} files (${FIXTURE_FILES.map((f) => `${f} ${(manifest.files[f].bytes / 1024).toFixed(1)}`).join(", ")})`);
    assert.ok(manifest.totalBytes < 1024 * 1024, `${manifest.totalBytes} bytes`);
    assert.ok(fixtureBundle.river.rows.length <= manifest.options.riverRows);
    assert.ok(!fs.existsSync(fixturePath("v2", "state.json")));
  });

  it("is a real edition: every section filled, a full TOP STORIES, a multi-publisher lead", () => {
    assert.equal(fixtureBundle.status.run.trigger, FIXTURE_TRIGGER);
    assert.equal(edition.sections.length, SECTIONS.length);
    for (const s of edition.sections) assert.ok(s.rows.length >= 3 && s.rows.length >= s.homeCount, s.id);
    assert.ok(edition.top.length >= 5);
    assert.ok(Object.keys(edition.articles).length >= 250);
    assert.equal(edition.counts.stories, new Set(edition.sections.flatMap((s) => s.rows)).size);
    assert.equal(edition.leadId, edition.top[0]);
    assert.ok(fixtureBundle.river.rows.length >= Object.keys(edition.articles).length);
    assert.ok(fixtureBundle.sources.sources.length >= 300 && fixtureBundle.health.feeds.length >= 300);
  });

  it("holds every case tests select by property (test/helpers/fixtureCases.ts)", (t) => {
    assert.deepEqual(missingFixtureCases(fixtureBundle), []);
    t.diagnostic(`story cases: ${Object.entries(fixtureCases.stories).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
    t.diagnostic(`health cases: ${Object.entries(fixtureCases.health).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
  });

  it("paywall: a homepage row is flagged, and the flag follows the source's `paywalled` tag", () => {
    const row = edition.articles[fixtureStory("paywalledRow")];
    assert.ok(row.flags?.includes("paywall"));
    assert.ok(fixtureSourceInfo(row.src).tags?.includes("paywalled"), `${row.src} is not tagged paywalled`);
    const flagged = Object.values(edition.articles).filter((a) => a.flags?.includes("paywall"));
    assert.ok(flagged.length >= 10, `${flagged.length} paywalled articles`);
  });

  it("weights: a w = 3 story with 8+ publishers, w = 2, w = 0 and unweighted rows", () => {
    const big = fixtureStory("weight3");
    assert.equal(edition.articles[big].w, 3);
    assert.ok(edition.clusters[big].publishers >= 8 && edition.clusters[big].members.length >= 7);
    assert.equal(edition.articles[fixtureStory("weight2")].w, 2);
    const low = edition.articles[fixtureStory("weight0")];
    assert.equal(low.w, 0);
    assert.equal(low.tier, 4);
    assert.equal(edition.articles[fixtureStory("weight1")].w, undefined);
  });

  it("lead: 5+ publishers, members of several sources, so a mute re-leads it", () => {
    const lead = fixtureStory("multiPublisherLead");
    assert.equal(lead, edition.leadId);
    assert.ok(edition.clusters[lead].publishers >= 5);
    assert.ok(fixtureCases.stories.reLeadable.includes(lead));
    const sources = new Set(edition.clusters[lead].members.map((m) => edition.articles[m].src));
    assert.ok(sources.size >= 4 && !sources.has(edition.articles[lead].src));
    // A member carries no summary (contract); the lead does.
    assert.ok(edition.clusters[lead].members.every((m) => edition.articles[m].summary === undefined));
  });

  it("kinds: a newsletter row, a release line, a discussion thread, a link-host outlet, a cross-listed story", () => {
    assert.equal(edition.sources[edition.articles[fixtureStory("newsletterRow")].src].kind, "newsletter");
    assert.ok(edition.articles[fixtureStory("releaseRow")].flags?.includes("release"));
    assert.ok(edition.articles[fixtureStory("discussionRow")].flags?.includes("discussion"));
    assert.ok(edition.articles[fixtureStory("linkHostRow")].pub);
    const crossed = fixtureStory("crossListed");
    assert.equal(edition.sections.filter((s) => s.rows.includes(crossed)).length, 2);
    const kinds = new Set(fixtureBundle.sources.sources.map((s) => s.kind));
    for (const k of ["rss", "newsletter", "papers", "github-release", "query", "community", "aggregator", "scrape", "json"]) assert.ok(kinds.has(k as never), k);
  });

  it("regulator: POLICY lists a regulator's own notice", () => {
    const notice = edition.articles[fixtureStory("regulatorRow")];
    const source = fixtureSourceInfo(notice.src);
    assert.ok(source.tags?.includes("regulator") && source.tags.includes("first-party"));
    assert.ok(edition.sections.find((s) => s.id === "policy")?.rows.includes(notice.id));
    assert.equal(source.kind === "community" || source.kind === "github-release", false);
  });

  it("health: carried, skipped by host backoff, failing, quarantined and paused sources - consistent with status.json", () => {
    const carried = fixtureHealthRow(fixtureSource("carried"));
    assert.deepEqual([carried.ok, carried.status, carried.carried], [false, "carried", true]);
    assert.ok(carried.count >= 1 && carried.failStreak >= 1 && carried.lastError && carried.error !== "skipped");
    const backoff = fixtureHealthRow(fixtureSource("hostBackoff"));
    assert.deepEqual([backoff.status, backoff.error, backoff.carried], ["carried", "skipped", true]);
    assert.match(backoff.lastError ?? "", /^host backoff: \S+ answered HTTP \d+ to \d+ requests in a row; not requested this run, \d+ last-good items? carried$/);
    const failing = fixtureHealthRow(fixtureSource("failing"));
    assert.deepEqual([failing.status, failing.count], ["failing", 0]);
    assert.ok(failing.lastError && failing.lastOkAt !== null && Date.parse(failing.lastOkAt) < FIXTURE_GENERATED_MS);
    const quarantined = fixtureHealthRow(fixtureSource("quarantined"));
    assert.deepEqual([quarantined.status, quarantined.count], ["quarantined", 0]);
    assert.ok(quarantined.failStreak >= PIPELINE.quarantineAfterFails);
    // A source that delivered nothing has no article in the edition.
    for (const id of [failing.id, quarantined.id]) assert.ok(!Object.values(edition.articles).some((a) => a.src === id), id);
    const paused = fixtureSourceInfo(fixtureSource("paused"));
    assert.equal(paused.paused, true);
    assert.ok(!fixtureBundle.health.feeds.some((f) => f.id === paused.id), "a paused source has no health row");

    const count = (status: string): number => fixtureBundle.health.feeds.filter((f) => f.status === status).length;
    assert.deepEqual(
      { total: fixtureBundle.status.feeds.total, ok: fixtureBundle.status.feeds.ok, failed: fixtureBundle.status.feeds.failed, carriedForward: fixtureBundle.status.feeds.carriedForward, quarantined: fixtureBundle.status.feeds.quarantined },
      { total: fixtureBundle.health.feeds.length, ok: count("ok"), failed: count("failing"), carriedForward: count("carried"), quarantined: count("quarantined") },
    );
    assert.equal(fixtureBundle.status.feeds.failedNames.length, fixtureBundle.health.feeds.filter((f) => !f.ok).length);
    assert.ok(fixtureBundle.status.feeds.ok < fixtureBundle.status.feeds.total && fixtureBundle.status.feeds.ok / fixtureBundle.status.feeds.total > 0.9, "a healthy build with a few sources down");
  });

  it("the manifest names the synthetic health rows, and they are probation sources", () => {
    // A healthy build has no carried / failing / quarantined source; the refresh tool writes the
    // missing cases onto probation sources and records them. Nothing else in health.json differs.
    const synthetic = new Set(manifest.healthCases.map((c) => c.id));
    assert.equal(manifest.files["health.json"].modified, synthetic.size > 0);
    for (const c of manifest.healthCases) {
      const info = fixtureSourceInfo(c.id);
      assert.equal(info.name, c.name);
      assert.ok(info.tags?.includes("probation"), `${c.id} is not a probation source`);
      assert.equal(fixtureHealthRow(c.id).ok, false);
    }
    if (manifest.options.healthCases && synthetic.size > 0) {
      for (const f of fixtureBundle.health.feeds) if (!synthetic.has(f.id) && !f.ok) assert.ok(f.lastError, `${f.id}: a real failure of the build carries its reason`);
    }
  });

  it("brief and stocks: the deterministic brief of a build without a key (no model output is committed), a full ticker", () => {
    const { brief, stocks, status } = fixtureBundle;
    assert.deepEqual([brief.source, brief.fallbackReason, brief.model], ["fallback", NO_KEY_REASON, undefined]);
    assert.deepEqual(status.brief, { source: "fallback", reason: NO_KEY_REASON });
    assert.ok(brief.headline.length > 0 && brief.bullets.length >= 3);
    assert.ok(stocks.order.length >= 5);
    for (const symbol of stocks.order) assert.equal(typeof stocks.quotes[symbol]?.price, "number", symbol);
    assert.ok(stocks.order.some((sym) => (stocks.quotes[sym]?.changePct ?? 0) < 0) || stocks.order.some((sym) => (stocks.quotes[sym]?.changePct ?? 0) > 0));
  });

  it("every edition article id is hashId(url)", () => {
    for (const a of Object.values(edition.articles)) assert.equal(a.id, hashId(a.url));
  });
});

describe("fixtures: the edition bridged from V1 (frozen, 2026-11-19 20:08Z)", () => {
  it("is the build route regression tests pin, and its files pass guards + invariants", () => {
    const { front, rest } = loadBridgedFiles();
    assert.equal(front.generatedAt, BRIDGED_GENERATED_AT);
    assert.equal(rest.buildId, front.buildId);
    assertValidBundle({ front, rest }, `test/fixtures/${BRIDGED_DIR}`);
    assert.deepEqual(fs.readdirSync(fixturePath(BRIDGED_DIR)).sort(), ["front.json", "rest.json"]);
    const e = loadBridgedEdition();
    assert.equal(e.counts.stories, 237);
    assert.equal(e.top.length, 9);
    // Its sources are the ids of the registry of the same day, not of the current registry.
    const known = new Set(loadFixtureRegistry().sources.map((s) => s.id));
    for (const a of Object.values(e.articles)) assert.ok(known.has(a.src), a.src);
  });
});

describe("fixtures: V1 production payload", () => {
  it("holds the four data files and the Atom feed", () => {
    for (const f of ["headlines.json", "headlines-preview.json", "brief.json", "stocks.json", "feed.xml"]) {
      assert.ok(fs.statSync(fixturePath("v1", "2026-11-19", f)).size > 500, f);
    }
    const h = readFixtureJson<{ generatedAt: string; categories: unknown[]; feedStats: unknown[]; trending: unknown[] }>("v1", "2026-11-19", "headlines.json");
    assert.equal(h.generatedAt, "2026-11-19T20:08:38.159Z");
    assert.equal(h.categories.length, 18);
    assert.equal(h.feedStats.length, 207);
    assert.match(readFixtureText("v1", "2026-11-19", "feed.xml"), /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  });

  it("sources-v1.json lists V1's 203 feeds + 4 scrapers with mappable categories", () => {
    const sources = loadV1Sources();
    assert.equal(sources.length, 207);
    assert.equal(sources.filter((s) => s.type === "feed").length, 203);
    assert.deepEqual(sources.filter((s) => s.type === "scrape").map((s) => s.name), ["Anthropic News", "Anthropic Research", "UK AISI Blog", "Gray Swan"]);
    assert.equal(new Set(sources.map((s) => s.name)).size, 207);
    assert.equal(new Set(sources.map((s) => s.url)).size, 207);
    for (const s of sources) {
      assert.ok(isHttpUrl(s.url), s.url);
      assert.ok(legacyToSections(s.category).length >= 1, `${s.name}: ${s.category}`);
      assert.ok(["critical", "high", "medium", "low"].includes(s.priority));
    }
    const stats = readFixtureJson<{ feedStats: { source: string }[] }>("v1", "2026-11-19", "headlines.json").feedStats;
    const names = new Set(sources.map((s) => s.name));
    for (const f of stats) assert.ok(names.has(f.source), f.source);
  });
});

describe("fixtures: items corpus + registry", () => {
  const corpus = loadCorpus();
  const registry = loadFixtureRegistry();

  it("has the full live fetch (2,297 items from 192 sources)", () => {
    assert.equal(corpus.length, 2297);
    assert.equal(new Set(corpus.map((c) => c.sourceId)).size, 192);
    assert.ok(fs.statSync(fixturePath("items-2026-11-19.json")).size < 3 * 1024 * 1024);
  });

  it("records are RawItem-compatible and carry provenance", () => {
    for (const c of corpus) {
      assert.equal(typeof c.title, "string");
      assert.ok(c.title.length > 0);
      assert.equal(typeof c.link, "string");
      assert.ok(c.publishedRaw === null || typeof c.publishedRaw === "string");
      assert.ok(c.summaryHtml === null || typeof c.summaryHtml === "string");
      assert.equal(c.sourceId, slugify(c.sourceName));
      assert.equal(c.v1.id, hashId(c.link));
    }
    const relative = corpus.filter((c) => !isHttpUrl(c.link));
    assert.equal(relative.length, 10, "the 10 known relative Sakana AI links (V1 bug) are kept on purpose");
    assert.ok(relative.every((c) => c.sourceName === "Sakana AI"));
  });

  it("loadRawItems returns plain, fresh RawItems", () => {
    const a = loadRawItems();
    assert.equal(a.length, 2297);
    assert.deepEqual(Object.keys(a[0]).sort(), ["link", "publishedRaw", "sourceId", "summaryHtml", "title"]);
    a[0].title = "mutated";
    assert.notEqual(loadRawItems()[0].title, "mutated");
  });

  it("the fixture registry covers every corpus source and is internally valid", () => {
    assert.equal(registry.sources.length, 207);
    const byId = new Map(registry.sources.map((s) => [s.id, s]));
    assert.equal(byId.size, 207);
    assert.equal(new Set(registry.sources.map((s) => s.url)).size, 207);
    const pubs = new Set(registry.publishers.map((p) => p.id));
    assert.equal(pubs.size, registry.publishers.length);
    for (const s of registry.sources) {
      assert.ok(isSectionId(s.home), `${s.id}: ${s.home}`);
      assert.ok([1, 2, 3, 4].includes(s.tier));
      assert.ok(isHttpUrl(s.url), s.url);
      assert.ok(pubs.has(s.publisher), `${s.id}: publisher ${s.publisher}`);
      assert.equal(s.kind === "scrape", s.scrape !== undefined, s.id);
      assert.doesNotThrow(() => resolveSource(s));
    }
    for (const c of corpus) assert.ok(byId.has(c.sourceId), c.sourceId);
    const kinds = new Set(registry.sources.map((s) => s.kind));
    for (const k of ["rss", "newsletter", "papers", "github-release", "query", "community", "aggregator", "scrape"]) assert.ok(kinds.has(k as never), k);
    assert.equal(resolveSource(byId.get("ggml-org-llama-cpp")!).countsForCoverage, false);
    assert.equal(resolveSource(byId.get("localllama-subreddit")!).routing, "home-only");
    assert.equal(resolveSource(byId.get("reuters-ai-google-news")!).attribution, "link-host");
  });
});

describe("fixtures: raw feed bodies", () => {
  const index = feedFixtures();

  it("index.json describes every file and nothing else", () => {
    assert.equal(index.length, 10);
    const onDisk = fs.readdirSync(fixturePath("feeds")).filter((f) => f !== "index.json").sort();
    assert.deepEqual(index.map((f) => f.file).sort(), onDisk);
    for (const f of index) {
      assert.equal(fs.statSync(fixturePath("feeds", f.file)).size, f.bytes, f.file);
      assert.ok(f.notes.length > 20 && isHttpUrl(f.url));
    }
  });

  it("covers RSS 2.0, Atom, RDF, GitHub releases, hnrss, Google News, entity-heavy, empty and HTML interstitial", () => {
    const body = (file: string): string => readFeedFixture(file);
    assert.match(body("rss2-wired-ai.xml"), /<rss[\s>]/);
    assert.match(body("rss2-quanta-ai.xml"), /content:encoded/);
    assert.match(body("atom-theverge-ai.xml"), /<feed[\s>][\s\S]*rel="alternate"/);
    assert.match(body("rdf-nature-machine-intelligence.xml"), /<rdf:RDF/);
    assert.match(body("github-releases-langchain.atom"), /langchain-[a-z-]+==/);
    assert.match(body("hnrss-ai-150.xml"), /Article URL:/);
    assert.match(body("google-news-sec-finra.xml"), /news\.google\.com\/rss\/articles\//);
    assert.ok((body("github-releases-llama-cpp-entity-heavy.atom").match(/&(?:lt|gt|amp|quot|#\d+);/g) ?? []).length > 1000);
    assert.equal(index.find((f) => f.file === "rss2-empty-nist.xml")?.itemCount, 0);
    const html = index.find((f) => f.format === "html");
    assert.equal(html?.httpStatus, 403);
    assert.match(body(html?.file ?? ""), /<html/i);
    assert.deepEqual([...new Set(index.map((f) => f.format))].sort(), ["atom", "html", "rdf", "rss"]);
  });

  it("feedFixtureResponse / fakeFetch serve fixtures without network", async () => {
    const res = feedFixtureResponse("html-interstitial-403-dcd.html");
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type") ?? "", /html/);
    assert.throws(() => feedFixtureResponse("nope.xml"), /unknown feed fixture/);

    const f = fakeFetch({
      "https://a.test/feed": feedFixtureResponse("rss2-wired-ai.xml"),
      "https://b.test/feed": "<rss/>",
      "https://c.test/feed": () => new Response("slow down", { status: 429 }),
    });
    assert.match(await (await f("https://a.test/feed")).text(), /<rss/);
    assert.match(await (await f("https://a.test/feed")).text(), /<rss/, "a Response route can be served repeatedly");
    assert.equal(await (await f("https://b.test/feed")).text(), "<rss/>");
    assert.equal((await f(new URL("https://c.test/feed"))).status, 429);
    await assert.rejects(() => f("https://d.test/feed"), /no route/);
    assert.deepEqual(f.calls, ["https://a.test/feed", "https://a.test/feed", "https://b.test/feed", "https://c.test/feed", "https://d.test/feed"]);
  });
});
