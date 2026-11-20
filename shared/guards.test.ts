import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isBriefFile,
  isEditionFront,
  isEditionRest,
  isHealthFile,
  isNewerSchema,
  isRiverFile,
  isSourcesFile,
  isStatusFile,
  isStocksFile,
  schemaVersionOf,
  validateBriefFile,
  validateEditionFront,
  validateEditionRest,
  validateHealthFile,
  validateRiverFile,
  validateSourcesFile,
  validateStatusFile,
  validateStocksFile,
} from "./guards";

const FIX = new URL("../test/fixtures/", import.meta.url);
const read = (rel: string): unknown => JSON.parse(fs.readFileSync(new URL(rel, FIX), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Any = Record<string, any>;

const front = read("v2/front.json") as Any;
const rest = read("v2/rest.json") as Any;
const river = read("v2/river.json") as Any;
const health = read("v2/health.json") as Any;
const sources = read("v2/sources.json") as Any;
const brief = read("v2/brief.json") as Any;
const stocks = read("v2/stocks.json") as Any;
const status = read("v2/status.json") as Any;

describe("shared/guards accept the v2 fixture (a frozen live build)", () => {
  it("every file passes its guard", () => {
    assert.equal(validateEditionFront(front), null);
    assert.equal(validateEditionRest(rest), null);
    assert.equal(validateRiverFile(river), null);
    assert.equal(validateHealthFile(health), null);
    assert.equal(validateSourcesFile(sources), null);
    assert.equal(validateBriefFile(brief), null);
    assert.equal(validateStocksFile(stocks), null);
    assert.equal(validateStatusFile(status), null);
    assert.ok(isEditionFront(front) && isEditionRest(rest) && isRiverFile(river) && isHealthFile(health));
    assert.ok(isSourcesFile(sources) && isBriefFile(brief) && isStocksFile(stocks) && isStatusFile(status));
  });

  it("the guards also accept the edition bridged from V1 (a second, older data set)", () => {
    // test/fixtures/bridged-2026-11-19: no `w` 3, no paywall flags, other source ids - same schema.
    const bridgedFront = read("bridged-2026-11-19/front.json") as Any;
    const bridgedRest = read("bridged-2026-11-19/rest.json") as Any;
    assert.equal(validateEditionFront(bridgedFront), null);
    assert.equal(validateEditionRest(bridgedRest), null);
    assert.notEqual(bridgedFront.buildId, front.buildId);
  });

  it("the fixture exercises the optional fields the guards check", () => {
    const articles = [...Object.values(front.articles), ...Object.values(rest.articles)] as Any[];
    for (const field of ["summary", "w", "flags", "pub", "via"]) assert.ok(articles.some((a) => a[field] !== undefined), `no article with ${field}`);
    for (const flag of ["release", "paper", "discussion", "paywall"]) assert.ok(articles.some((a) => a.flags?.includes(flag)), `no article flagged ${flag}`);
    for (const w of [0, 2, 3]) assert.ok(articles.some((a) => a.w === w), `no article with w ${w}`);
    for (const st of ["ok", "carried", "failing", "quarantined"]) assert.ok(health.feeds.some((f: Any) => f.status === st), `no ${st} health row`);
    for (const field of ["error", "lastError", "httpStatus", "carried"]) assert.ok(health.feeds.some((f: Any) => f[field] !== undefined), `no health row with ${field}`);
    for (const field of ["homepage", "feedUrl", "tags", "aliases", "paused"]) assert.ok(sources.sources.some((x: Any) => x[field] !== undefined), `no source with ${field}`);
  });
});

describe("shared/guards reject wrong shapes", () => {
  it("rejects V1 payloads and non-objects everywhere", () => {
    const v1 = read("v1/2026-11-19/headlines.json");
    const v1Preview = read("v1/2026-11-19/headlines-preview.json");
    const guards = [isEditionFront, isEditionRest, isRiverFile, isHealthFile, isSourcesFile, isBriefFile, isStocksFile, isStatusFile];
    for (const g of guards) {
      for (const bad of [v1, v1Preview, null, undefined, 42, "x", [], {}]) assert.equal(g(bad), false);
    }
    assert.equal(isBriefFile(read("v1/2026-11-19/brief.json")), false, "V1 brief has no schemaVersion");
    assert.equal(isStocksFile(read("v1/2026-11-19/stocks.json")), false, "V1 stocks is a bare record");
  });

  it("does not confuse the v2 files with each other", () => {
    assert.equal(isEditionFront(rest), false);
    assert.equal(isEditionRest(brief), false);
    assert.equal(isRiverFile(front), false);
    assert.equal(isHealthFile(sources), false);
    assert.equal(isSourcesFile(health), false);
    assert.equal(isStatusFile(front), false);
  });

  const mutate = (base: Any, fn: (x: Any) => void): Any => {
    const x = clone(base);
    fn(x);
    return x;
  };
  const anyArticle = (f: Any): Any => f.articles[Object.keys(f.articles)[0]];

  it("front: reports the first problem with a path", () => {
    const cases: [string, (x: Any) => void, RegExp][] = [
      ["schemaVersion", (x) => (x.schemaVersion = 1), /schemaVersion/],
      ["schemaVersion newer", (x) => (x.schemaVersion = 3), /schemaVersion/],
      ["buildId", (x) => (x.buildId = ""), /buildId/],
      ["generatedAt", (x) => (x.generatedAt = "yesterday"), /generatedAt/],
      ["leadId", (x) => (x.leadId = 5), /leadId/],
      ["top missing", (x) => delete x.top, /front\.top/],
      ["trending is not top", (x) => { x.trending = x.top; delete x.top; }, /front\.top/],
      ["counts", (x) => (x.counts.stories = -1), /counts\.stories/],
      ["section id", (x) => (x.sections[0].id = "model_releases"), /sections\[0\]\.id/],
      ["section rows", (x) => (x.sections[0].rows = [1, 2]), /rows/],
      ["article key/id", (x) => (anyArticle(x).id = "zzz"), /\.id/],
      ["article url scheme", (x) => (anyArticle(x).url = "javascript:alert(1)"), /\.url/],
      ["article title", (x) => (anyArticle(x).title = ""), /\.title/],
      ["article home", (x) => (anyArticle(x).home = "funding"), /\.home/],
      ["article tier", (x) => (anyArticle(x).tier = 5), /\.tier/],
      ["article w", (x) => (anyArticle(x).w = 4), /\.w/],
      ["article firstSeenAt", (x) => delete anyArticle(x).firstSeenAt, /firstSeenAt/],
      ["article publishedAt", (x) => (anyArticle(x).publishedAt = "soon"), /publishedAt/],
      ["article via", (x) => (anyArticle(x).via = "a"), /\.via/],
      ["cluster publishers", (x) => (x.clusters[Object.keys(x.clusters)[0]].publishers = 0), /publishers/],
      ["source ref", (x) => delete x.sources[Object.keys(x.sources)[0]].name, /\.name/],
    ];
    for (const [label, fn, re] of cases) {
      const problem = validateEditionFront(mutate(front, fn));
      assert.ok(problem, `${label}: expected a problem`);
      assert.match(problem, re, label);
    }
  });

  it("front: tolerates unknown extra fields, flags and kinds (forward compatible)", () => {
    const x = mutate(front, (f) => {
      f.futureField = { a: 1 };
      anyArticle(f).flags = ["release", "some-future-flag"];
      anyArticle(f).extra = true;
      f.sources[Object.keys(f.sources)[0]].kind = "podcast";
    });
    assert.equal(validateEditionFront(x), null);
  });

  it("rest / river / health / sources / brief / stocks / status mutations", () => {
    assert.match(validateEditionRest(mutate(rest, (x) => (x.sections[0].id = "nope"))) ?? "", /sections\[0\]/);
    assert.match(validateEditionRest(mutate(rest, (x) => (x.articles = [])) ) ?? "", /articles/);

    assert.match(validateRiverFile(mutate(river, (x) => (x.days = 3))) ?? "", /days/);
    assert.match(validateRiverFile(mutate(river, (x) => x.sourceIds.pop())) ?? "", /parallel/);
    assert.match(validateRiverFile(mutate(river, (x) => (x.rows[0][3] = 99999))) ?? "", /source index/);
    assert.match(validateRiverFile(mutate(river, (x) => (x.rows[0][4] = "funding"))) ?? "", /section/);
    assert.match(validateRiverFile(mutate(river, (x) => (x.rows[0][2] = "ftp://x/y"))) ?? "", /URL/);
    assert.match(validateRiverFile(mutate(river, (x) => (x.rows[0] = x.rows[0].slice(0, 7)))) ?? "", /8-tuple/);
    assert.match(validateRiverFile(mutate(river, (x) => (x.rows[0][6] = null))) ?? "", /firstSeenAt/);

    assert.match(validateHealthFile(mutate(health, (x) => (x.feeds[0].status = "dead"))) ?? "", /status/);
    assert.match(validateHealthFile(mutate(health, (x) => { x.feeds[0].ok = true; x.feeds[0].status = "failing"; })) ?? "", /ok/);
    assert.match(validateHealthFile(mutate(health, (x) => (x.feeds[0].lastOkAt = 12))) ?? "", /lastOkAt/);

    assert.match(validateSourcesFile(mutate(sources, (x) => (x.sources[0].scope = "all"))) ?? "", /scope/);
    assert.match(validateSourcesFile(mutate(sources, (x) => (x.sources[0].home = "funding"))) ?? "", /home/);
    assert.match(validateSourcesFile(mutate(sources, (x) => (x.sources[0].feedUrl = "javascript:x"))) ?? "", /feedUrl/);

    assert.match(validateBriefFile(mutate(brief, (x) => (x.source = "gpt"))) ?? "", /source/);
    assert.match(validateBriefFile(mutate(brief, (x) => (x.cited[0].url = "javascript:alert(1)"))) ?? "", /cited\[0\]\.url/);
    assert.match(validateBriefFile(mutate(brief, (x) => (x.bullets = "one"))) ?? "", /bullets/);

    assert.match(validateStocksFile(mutate(stocks, (x) => x.order.push("ZZZZ"))) ?? "", /ZZZZ/);
    assert.match(validateStocksFile(mutate(stocks, (x) => (x.quotes[x.order[0]].price = "12"))) ?? "", /price/);
    assert.match(validateStocksFile(mutate(stocks, (x) => delete x.asOf)) ?? "", /asOf/);
    assert.equal(validateStocksFile(mutate(stocks, (x) => { x.asOf = null; x.quotes[x.order[0]].price = null; })), null);

    assert.match(validateStatusFile(mutate(status, (x) => (x.schema = 2))) ?? "", /schema/);
    assert.match(validateStatusFile(mutate(status, (x) => (x.gate.passed = "yes"))) ?? "", /gate/);
    assert.match(validateStatusFile(mutate(status, (x) => (x.content.emptySections = ["funding"]))) ?? "", /emptySections/);
    assert.match(validateStatusFile(mutate(status, (x) => delete x.run)) ?? "", /run/);
  });

  it("schemaVersionOf / isNewerSchema", () => {
    assert.equal(schemaVersionOf(front), 2);
    assert.equal(schemaVersionOf(status), 1);
    assert.equal(schemaVersionOf({}), null);
    assert.equal(schemaVersionOf(null), null);
    assert.equal(isNewerSchema(front), false);
    assert.equal(isNewerSchema({ ...front, schemaVersion: 3 }), true);
    assert.equal(isNewerSchema({ schemaVersion: 1 }), false);
    assert.equal(isNewerSchema(status), false);
    assert.equal(isNewerSchema("x"), false);
  });
});
