import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hashId } from "./ids";
import { bareHost, canonicalUrl, hostOf, isHttpUrl, isTrackingParam, parseHttpUrl, registrableHost, sameUrl, urlKey } from "./url";

describe("shared/url isHttpUrl (scheme allowlist)", () => {
  it("accepts absolute http(s) URLs", () => {
    for (const u of ["https://example.com", "http://example.com/a?b=1#c", "HTTPS://Example.COM/Path", "https://example.com:8443/x", "https://user:pw@example.com/x", "http://127.0.0.1:5180/", "http://[::1]:5180/x"]) {
      assert.equal(isHttpUrl(u), true, u);
    }
  });

  it("rejects everything else", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,<b>x</b>", "mailto:a@b.c", "ftp://example.com/x", "//example.com/x", "/relative/path", "example.com", "", "   ", "https://", "https:///path", "https://exa mple.com/", "https://example.com/\npath", "vbscript:x", "file:///etc/passwd", "https://example.com:port/"]) {
      assert.equal(isHttpUrl(u), false, JSON.stringify(u));
    }
    assert.equal(isHttpUrl(null), false);
    assert.equal(isHttpUrl(undefined), false);
    assert.equal(isHttpUrl(`https://example.com/${"a".repeat(5000)}`), false, "absurdly long URLs are rejected");
  });

  it("parseHttpUrl splits the parts", () => {
    assert.deepEqual(parseHttpUrl("HTTPS://User@WWW.Example.com:443/a/b?x=1&y=2#frag"), { scheme: "https", host: "www.example.com", port: "", path: "/a/b", query: "x=1&y=2", hash: "frag" });
    assert.deepEqual(parseHttpUrl("http://example.com:8080"), { scheme: "http", host: "example.com", port: "8080", path: "/", query: "", hash: "" });
    assert.equal(hostOf("https://Blog.Example.com/x"), "blog.example.com");
    assert.equal(bareHost("https://www.example.com/x"), "example.com");
    assert.equal(hostOf("nope"), null);
  });
});

describe("shared/url canonicalUrl", () => {
  it("strips tracking params, fragments, default index pages and one trailing slash", () => {
    assert.equal(canonicalUrl("https://example.com/post/?utm_source=x&utm_medium=y#top"), "https://example.com/post");
    assert.equal(canonicalUrl("https://example.com/a?fbclid=1&gclid=2&mc_cid=3&mc_eid=4&ref=hn"), "https://example.com/a");
    assert.equal(canonicalUrl("https://example.com/blog/index.html"), "https://example.com/blog");
    assert.equal(canonicalUrl("https://example.com/index.htm"), "https://example.com/");
    assert.equal(canonicalUrl("https://example.com"), "https://example.com/");
    assert.equal(canonicalUrl("https://example.com/"), "https://example.com/");
  });

  it("KEEPS identity-bearing query params in their original order", () => {
    assert.equal(canonicalUrl("https://example.com/?p=123"), "https://example.com/?p=123");
    assert.equal(canonicalUrl("https://news.ycombinator.com/item?id=42&utm_campaign=x"), "https://news.ycombinator.com/item?id=42");
    assert.equal(canonicalUrl("https://example.com/watch?v=abc&t=10&utm_source=x&list=z"), "https://example.com/watch?v=abc&t=10&list=z");
    assert.equal(canonicalUrl("https://example.com/index.php?id=5"), "https://example.com/index.php?id=5");
    assert.notEqual(canonicalUrl("https://example.com/?p=123"), canonicalUrl("https://example.com/?p=124"));
  });

  it("normalises scheme/host case, default ports and userinfo; keeps www and path case", () => {
    assert.equal(canonicalUrl("HTTPS://WWW.Example.COM:443/Some/Path"), "https://www.example.com/Some/Path");
    assert.equal(canonicalUrl("http://example.com:80/x"), "http://example.com/x");
    assert.equal(canonicalUrl("https://example.com:8443/x"), "https://example.com:8443/x");
    assert.equal(canonicalUrl("https://user:pw@example.com/x"), "https://example.com/x");
    assert.equal(canonicalUrl("  https://example.com/x  "), "https://example.com/x");
  });

  it("percent-encodes spaces and non-ASCII once, leaving existing escapes alone", () => {
    assert.equal(canonicalUrl("https://example.com/a b/é"), "https://example.com/a%20b/%C3%A9");
    assert.equal(canonicalUrl("https://example.com/a%20b/%C3%A9"), "https://example.com/a%20b/%C3%A9");
  });

  it("returns null for non-http(s) input", () => {
    assert.equal(canonicalUrl("javascript:alert(1)"), null);
    assert.equal(canonicalUrl("/relative"), null);
    assert.equal(canonicalUrl(null), null);
  });

  it("is idempotent", () => {
    for (const u of ["https://example.com/post/?utm_source=x#top", "https://Example.com/a b?x=1&ref=2", "http://example.com:80/index.html", "https://example.com/?p=1&utm_x=2"]) {
      const once = canonicalUrl(u);
      assert.ok(once);
      assert.equal(canonicalUrl(once), once, u);
    }
  });

  it("is the identity on V1-normalised URLs, so V1 ids (bookmarks, seen) stay valid", () => {
    const corpus = JSON.parse(fs.readFileSync(new URL("../test/fixtures/items-2026-11-19.json", import.meta.url), "utf8")) as { link: string; v1: { id: string } }[];
    let same = 0;
    const relative: string[] = [];
    const changed: string[] = [];
    for (const item of corpus) {
      const c = canonicalUrl(item.link);
      if (c === null) relative.push(item.link);
      else if (c === item.link && hashId(c) === item.v1.id) same++;
      else changed.push(`${item.link} -> ${c}`);
    }
    // V1 let 10 relative links through (Sakana AI: "/jfinbench/") - not http(s), so no canonical form.
    assert.ok(relative.length <= 10 && relative.every((l) => l.startsWith("/")), `unexpected non-http links: ${relative.slice(0, 5).join(" | ")}`);
    // The only other differences are trailing index.html pages, which V2 strips on purpose.
    assert.ok(changed.every((c) => /\/index\.html -> /.test(c)), `unexpected canonical changes: ${changed.slice(0, 5).join(" | ")}`);
    const http = corpus.length - relative.length;
    assert.ok(same / http >= 0.99, `only ${same}/${http} corpus URLs keep their V1 id`);
  });

  it("isTrackingParam", () => {
    for (const p of ["utm_source", "UTM_Medium", "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "srsltid", "oc", "smid"]) assert.equal(isTrackingParam(p), true, p);
    for (const p of ["p", "id", "v", "page", "q", "reference", "refresh", "article", "s"]) assert.equal(isTrackingParam(p), false, p);
  });

  it("urlKey / sameUrl ignore scheme and www for exact-URL matching", () => {
    assert.equal(urlKey("https://www.example.com/post/?utm_source=hn"), "example.com/post");
    assert.equal(urlKey("http://example.com/post"), "example.com/post");
    assert.equal(urlKey("mailto:x@y.z"), null);
    assert.equal(sameUrl("https://www.example.com/a/", "http://example.com/a#x"), true);
    assert.equal(sameUrl("https://example.com/a", "https://example.com/b"), false);
    assert.equal(sameUrl("https://news.ycombinator.com/item?id=1", "https://news.ycombinator.com/item?id=2"), false);
    assert.equal(sameUrl(null, null), false);
  });
});

describe("shared/url registrableHost", () => {
  it("reduces hosts to eTLD+1 for publisher identity", () => {
    const cases: [string, string][] = [
      ["https://www.theguardian.com/business/live/x", "theguardian.com"],
      ["https://news.mit.edu/2026/x", "mit.edu"],
      ["https://blogs.nvidia.com/blog/x", "nvidia.com"],
      ["https://developer.nvidia.com/blog/x", "nvidia.com"],
      ["https://www.bbc.co.uk/news/x", "bbc.co.uk"],
      ["https://feeds.bbci.co.uk/x", "bbci.co.uk"],
      ["https://deepmind.google/blog/x", "deepmind.google"],
      ["https://openai.com/news/x", "openai.com"],
      ["https://export.arxiv.org/abs/1", "arxiv.org"],
      ["www.reuters.com", "reuters.com"],
      ["Reuters.com", "reuters.com"],
      ["http://127.0.0.1:5180/x", "127.0.0.1"],
      ["http://localhost:5180/x", "localhost"],
    ];
    for (const [input, want] of cases) assert.equal(registrableHost(input), want, input);
  });

  it("keeps the tenant label on multi-tenant platforms", () => {
    assert.equal(registrableHost("https://simonw.substack.com/p/x"), "simonw.substack.com");
    assert.equal(registrableHost("https://www.substack.com/x"), "substack.com");
    assert.equal(registrableHost("https://lilianweng.github.io/posts/x"), "lilianweng.github.io");
    assert.equal(registrableHost("https://medium.com/@someone/x"), "medium.com");
    assert.equal(registrableHost("https://towardsdatascience.medium.com/x"), "towardsdatascience.medium.com");
  });

  it("returns null for unusable input", () => {
    assert.equal(registrableHost(""), null);
    assert.equal(registrableHost(null), null);
    assert.equal(registrableHost("javascript:alert(1)"), null);
  });
});
