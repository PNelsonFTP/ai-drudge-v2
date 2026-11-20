import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashId } from "../../../shared/ids";
import { loadCorpus } from "../../../test/helpers/fixtures";
import { itemIdentity } from "./url";

describe("itemIdentity", () => {
  it("is the shared canonical URL, its hash, and a scheme/www-less key", () => {
    const got = itemIdentity("HTTPS://WWW.Example.com/Story/?utm_source=x&id=5#section");
    assert.deepEqual(got, { url: "https://www.example.com/Story?id=5", id: hashId("https://www.example.com/Story?id=5"), key: "example.com/Story?id=5" });
  });

  it("keeps identity-bearing query parameters (V1 dedup stripped the whole query string)", () => {
    const distinct = [
      ["https://scottaaronson.blog/?p=10321", "https://scottaaronson.blog/?p=10318"],
      ["https://news.ycombinator.com/item?id=50562262", "https://news.ycombinator.com/item?id=50561508"],
      ["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb"],
      ["https://example.com/story?page=1", "https://example.com/story?page=2"],
    ];
    for (const [a, b] of distinct) {
      const ia = itemIdentity(a);
      const ib = itemIdentity(b);
      assert.ok(ia && ib);
      assert.notEqual(ia.id, ib.id, `${a} vs ${b}`);
      assert.notEqual(ia.key, ib.key, `${a} vs ${b}`);
      assert.ok(ia.url.includes("?"), ia.url);
    }
  });

  it("the ten Shtetl-Optimized permalinks are ten identities (V1 kept 1 of 10 on every build)", () => {
    const posts = [10321, 10318, 10295, 10283, 10270, 10232, 10239, 10235, 10222, 10204];
    const ids = new Set(posts.map((p) => itemIdentity(`https://scottaaronson.blog/?p=${p}`)?.id));
    const keys = new Set(posts.map((p) => itemIdentity(`https://scottaaronson.blog/?p=${p}`)?.key));
    assert.equal(ids.size, 10);
    assert.equal(keys.size, 10);
  });

  it("tracking parameters and fragments do not make a new article", () => {
    const base = itemIdentity("https://example.com/story");
    assert.ok(base);
    for (const variant of [
      "https://example.com/story?utm_source=rss&utm_medium=feed",
      "https://example.com/story#comments",
      "https://example.com/story/?fbclid=abc&gclid=def",
      "https://example.com/story?mc_cid=1&mc_eid=2",
      "https://example.com/story/index.html",
      "https://EXAMPLE.com:443/story/",
    ]) {
      assert.equal(itemIdentity(variant)?.id, base.id, variant);
    }
  });

  it("http/https and www variants keep their own url and id but share the key", () => {
    const a = itemIdentity("http://example.com/story");
    const b = itemIdentity("https://www.example.com/story");
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.equal(a.key, b.key);
    assert.equal(a.url, "http://example.com/story");
  });

  it("rejects everything that is not an absolute http(s) URL", () => {
    for (const bad of ["/jfinbench/", "//example.com/x", "example.com/story", "javascript:alert(1)", "mailto:a@b.c", "ftp://example.com/x", "data:text/html,x", "", "   ", null, undefined, "https://", "http://exa mple.com/"]) {
      assert.equal(itemIdentity(bad), null, String(bad));
    }
  });

  it("ids equal the ids V1 emitted for the corpus (bookmarks and read state survive)", () => {
    let checked = 0;
    for (const rec of loadCorpus()) {
      const got = itemIdentity(rec.link);
      if (!got) continue;
      // 15 corpus links end in /index.html, which the canonical form strips (documented in fixtures.ts).
      if (/\/index\.html?$/i.test(rec.link)) continue;
      assert.equal(got.id, rec.v1.id, rec.link);
      checked++;
    }
    assert.ok(checked > 2200, String(checked));
  });
});
