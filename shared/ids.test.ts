import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hashId, isArticleId } from "./ids";

const FIX = new URL("../test/fixtures/", import.meta.url);
const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(new URL(rel, FIX), "utf8"));

interface V1Article {
  id: string;
  url: string;
  related?: V1Article[];
}
interface V1Payload {
  trending: { lead: V1Article }[];
  categories: { articles: V1Article[]; articlesAll: V1Article[] }[];
}

describe("shared/ids hashId", () => {
  it("is the V1 djb2 (known vectors from today's production payload)", () => {
    assert.equal(hashId("https://github.com/ggml-org/llama.cpp/releases/tag/b12549"), "18hfkqe");
    assert.equal(hashId("https://www.therobotreport.com/humyn-labs-raises-47m-to-collect-real-world-data-for-robotics"), "1ewdcvl");
    assert.equal(hashId(""), "45h");
    assert.equal(hashId("a"), (((5381 << 5) + 5381 + 97) >>> 0).toString(36));
  });

  it("reproduces EVERY article id in the V1 fixture (headlines.json 2026-11-19)", () => {
    const payload = readJson("v1/2026-11-19/headlines.json") as V1Payload;
    const seen = new Map<string, string>();
    const visit = (a: V1Article): void => {
      seen.set(a.id, a.url);
      for (const r of a.related ?? []) seen.set(r.id, r.url);
    };
    for (const c of payload.categories) {
      c.articles.forEach(visit);
      c.articlesAll.forEach(visit);
    }
    for (const t of payload.trending) visit(t.lead);
    assert.ok(seen.size >= 281, `expected >= 281 unique ids, got ${seen.size}`);
    for (const [id, url] of seen) assert.equal(hashId(url), id, url);
  });

  it("reproduces every id of the 2,297-item live corpus", () => {
    const corpus = readJson("items-2026-11-19.json") as { link: string; v1: { id: string } }[];
    assert.ok(corpus.length > 2000);
    for (const item of corpus) assert.equal(hashId(item.link), item.v1.id, item.link);
  });

  it("walks UTF-16 code units like V1 (non-ASCII stays stable)", () => {
    assert.equal(hashId("https://example.com/é"), hashId("https://example.com/é"));
    assert.notEqual(hashId("https://example.com/é"), hashId("https://example.com/e"));
    assert.match(hashId("https://example.com/😀"), /^[0-9a-z]{1,7}$/);
  });

  it("isArticleId accepts base36 uint32 strings only", () => {
    assert.equal(isArticleId("18hfkqe"), true);
    assert.equal(isArticleId("0"), true);
    assert.equal(isArticleId(""), false);
    assert.equal(isArticleId("ABC"), false);
    assert.equal(isArticleId("12345678"), false);
    assert.equal(isArticleId(12), false);
  });
});
