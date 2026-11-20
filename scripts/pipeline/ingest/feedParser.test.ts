import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { feedFixtures, readFeedFixture, readFixtureText } from "../../../test/helpers/fixtures";
import { isHttpUrl } from "../../../shared/url";
import { parseFeed, resolveHttpUrl, sniffBody, type FeedEntry, type FeedParseResult } from "./feedParser";
import { RAW_SUMMARY_MAX, RAW_TITLE_MAX } from "./newest";

const FEED = "https://blog.example.com/feeds/main.xml";

function ok(r: FeedParseResult): FeedEntry[] {
  assert.equal(r.ok, true, r.ok ? "" : `${r.error}: ${r.detail}`);
  return r.ok ? r.entries : [];
}

function fail(r: FeedParseResult): { error: string; detail: string } {
  assert.equal(r.ok, false);
  return r.ok ? { error: "", detail: "" } : { error: r.error, detail: r.detail };
}

const rss = (items: string, channelExtra = ""): string => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>T</title>${channelExtra}${items}</channel></rss>`;
const atom = (entries: string): string => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>${entries}</feed>`;

describe("parseFeed over test/fixtures/feeds", () => {
  for (const fx of feedFixtures()) {
    it(`${fx.file}: ${fx.notes}`, () => {
      const r = parseFeed(readFeedFixture(fx.file), { feedUrl: fx.url });
      if (fx.format === "html") {
        assert.equal(fail(r).error, "not_feed");
        return;
      }
      if (fx.itemCount === 0) {
        const f = fail(r);
        assert.equal(f.error, "empty");
        assert.equal(r.total, 0);
        return;
      }
      const entries = ok(r);
      assert.equal(r.ok && r.format, fx.format);
      assert.equal(r.total, fx.itemCount);
      assert.equal(entries.length + r.skipped, fx.itemCount);
      assert.equal(r.skipped, 0);
      for (const e of entries) {
        assert.ok(e.title.length > 0 && e.title.length <= RAW_TITLE_MAX);
        assert.ok(isHttpUrl(e.link), e.link);
        assert.ok(e.publishedRaw, `${fx.file}: every fixture item is dated`);
        assert.ok((e.summaryHtml ?? "").length <= RAW_SUMMARY_MAX);
      }
    });
  }

  it("The Verge (Atom): picks the rel=alternate article link, not another link element", () => {
    const entries = ok(parseFeed(readFeedFixture("atom-theverge-ai.xml"), { feedUrl: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" }));
    for (const e of entries) assert.match(e.link, /^https:\/\/www\.theverge\.com\/.+/);
    assert.ok(entries.every((e) => !/\/rss\//.test(e.link)));
  });

  it("Google News: carries the item's real outlet (name + url) and keeps the wrapper link for the resolver", () => {
    const entries = ok(parseFeed(readFeedFixture("google-news-sec-finra.xml"), { feedUrl: "https://news.google.com/rss/search?q=x" }));
    assert.ok(entries.every((e) => e.link.startsWith("https://news.google.com/rss/articles/")));
    assert.ok(entries.every((e) => e.itemPublisher && isHttpUrl(e.itemPublisherUrl)));
    assert.ok(new Set(entries.map((e) => e.itemPublisher)).size > 5);
  });

  it("hnrss: article link plus the HN thread as comments", () => {
    const entries = ok(parseFeed(readFeedFixture("hnrss-ai-150.xml"), { feedUrl: "https://hnrss.org/newest?q=AI&points=150" }));
    assert.ok(entries.every((e) => e.comments?.startsWith("https://news.ycombinator.com/item?id=")));
    assert.ok(entries.some((e) => !e.link.includes("ycombinator.com")));
  });

  it("RDF: items are siblings of the channel and dated by dc:date", () => {
    const entries = ok(parseFeed(readFeedFixture("rdf-nature-machine-intelligence.xml"), { feedUrl: "https://www.nature.com/natmachintell.rss" }));
    assert.equal(entries.length, 8);
    assert.match(entries[0].publishedRaw ?? "", /^\d{4}-\d{2}-\d{2}/);
  });

  it("entity-heavy GitHub release feed (5,400+ entities) parses with the library's default limits", () => {
    const r = parseFeed(readFeedFixture("github-releases-llama-cpp-entity-heavy.atom"), { feedUrl: "https://github.com/ggml-org/llama.cpp/releases.atom", preferContent: true });
    const entries = ok(r);
    assert.equal(entries.length, 10);
    assert.ok(entries.every((e) => /\/releases\/tag\//.test(e.link)));
    assert.ok(entries.every((e) => e.guid?.startsWith("tag:github.com,2008:Repository/")));
    assert.ok(entries.some((e) => (e.summaryHtml ?? "").includes("<")), "changelog HTML comes from <content>");
  });
});

describe("parseFeed over test/fixtures/feeds-extra (real bodies, trimmed)", () => {
  it("Sakana AI: relative Atom links are resolved against the feed URL (V1 published /jfinbench/ as-is)", () => {
    const entries = ok(parseFeed(readFixtureText("feeds-extra", "atom-sakana-relative-links.xml"), { feedUrl: "https://sakana.ai/feed.xml" }));
    assert.equal(entries.length, 4);
    assert.equal(entries[0].link, "https://sakana.ai/jfinbench/");
    assert.ok(entries.every((e) => e.link.startsWith("https://sakana.ai/")));
  });

  it("Scott Aaronson: ?p= permalinks survive untouched", () => {
    const entries = ok(parseFeed(readFixtureText("feeds-extra", "rss2-scottaaronson-query-permalinks.xml"), { feedUrl: "https://scottaaronson.blog/?feed=rss2" }));
    assert.equal(entries.length, 4);
    assert.ok(entries.every((e) => /^https:\/\/scottaaronson\.blog\/\?p=\d+$/.test(e.link)));
    assert.equal(new Set(entries.map((e) => e.link)).size, 4);
  });

  it("vLLM releases: raw titles pass through unchanged (rc tags, commit subjects) - nothing is synthesized", () => {
    const entries = ok(parseFeed(readFixtureText("feeds-extra", "github-releases-vllm-rc-tags.atom"), { feedUrl: "https://github.com/vllm-project/vllm/releases.atom", preferContent: true }));
    assert.deepEqual(entries.slice(0, 3).map((e) => e.title), ["v0.34.0", "v0.34.0rc4", "v0.34.0rc3"]);
    assert.ok(entries.some((e) => e.title.startsWith("v0.34.0rc0: [Transformers backend]")));
    assert.ok(entries.every((e) => !/released$/.test(e.title)));
  });

  it("BAIR: a <style> block at the start of a long description never survives the summary cap", () => {
    const entries = ok(parseFeed(readFixtureText("feeds-extra", "rss2-bair-style-block.xml"), { feedUrl: "https://bair.berkeley.edu/blog/feed.xml" }));
    const first = entries[0].summaryHtml ?? "";
    assert.ok(first.length > 200 && first.length <= RAW_SUMMARY_MAX);
    assert.doesNotMatch(first, /<style/i);
    assert.doesNotMatch(first, /\{[^}]*(?:margin|padding|font-size)\s*:/);
    assert.match(entries[0].link, /^http:\/\/bair\.berkeley\.edu\//, "http links are legitimate and kept");
  });
});

describe("parseFeed: crafted cases from the review", () => {
  it("1. JSON Feed 1.1", () => {
    const body = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JF",
      home_page_url: "https://jf.example.com/",
      items: [
        { id: "1", url: "https://jf.example.com/a", title: "First", content_html: "<p>Hello</p>", date_published: "2026-11-19T10:00:00Z", tags: ["ai", "ml"] },
        { id: "https://jf.example.com/b", title: "Id is the URL", content_text: "plain" },
        { id: "3", url: "/relative", title: "Relative", summary: "short", content_html: "<p>long</p>" },
        { id: "4", title: "No URL at all" },
        { id: "5", url: "https://jf.example.com/untitled" },
      ],
    });
    const r = parseFeed(body, { feedUrl: "https://jf.example.com/feed.json" });
    const entries = ok(r);
    assert.equal(r.ok && r.format, "json");
    assert.deepEqual(entries.map((e) => e.link), ["https://jf.example.com/a", "https://jf.example.com/b", "https://jf.example.com/relative"]);
    assert.equal(entries[0].publishedRaw, "2026-11-19T10:00:00Z");
    assert.deepEqual(entries[0].categories, ["ai", "ml"]);
    assert.equal(entries[0].guid, "1");
    assert.equal(entries[2].summaryHtml, "short");
    assert.equal(r.skipped, 2);
  });

  it("1b. JSON that is not a JSON Feed is not_feed; broken JSON is parse", () => {
    assert.equal(fail(parseFeed('{"data":[1,2,3]}', { feedUrl: FEED })).error, "not_feed");
    assert.equal(fail(parseFeed('{"version":"https://jsonfeed.org/version/1.1","items":[', { feedUrl: FEED })).error, "parse");
  });

  it("2. Atom: rel=replies / enclosure / self listed first are never chosen", () => {
    const body = atom(`<entry><title>Post</title><id>urn:uuid:1</id>
      <link rel="replies" type="application/atom+xml" href="https://blog.example.com/post/comments/feed"/>
      <link rel="enclosure" type="audio/mpeg" href="https://cdn.example.com/ep1.mp3"/>
      <link rel="self" href="https://blog.example.com/feeds/main.xml"/>
      <link rel="replies" type="text/html" href="https://blog.example.com/post#comments"/>
      <link rel="alternate" type="application/json" href="https://blog.example.com/post.json"/>
      <link rel="alternate" type="text/html" href="https://blog.example.com/post"/>
      <updated>2026-11-19T10:00:00Z</updated></entry>
      <entry><title>No rel means alternate</title><link href="/plain"/><updated>2026-11-19T09:00:00Z</updated></entry>
      <entry><title>Only non-article links, id is a URL</title><id>https://blog.example.com/from-id</id><link rel="enclosure" href="https://cdn.example.com/x.mp3"/></entry>
      <entry><title>Only non-article links, id is not a URL</title><id>urn:uuid:2</id><link rel="self" href="https://blog.example.com/self"/></entry>`);
    const r = parseFeed(body, { feedUrl: FEED });
    const entries = ok(r);
    assert.deepEqual(entries.map((e) => e.link), ["https://blog.example.com/post", "https://blog.example.com/plain", "https://blog.example.com/from-id"]);
    assert.equal(entries[0].comments, "https://blog.example.com/post#comments");
    assert.equal(r.skipped, 1);
  });

  it("3. guid-only items, relative links and numeric-looking titles are kept", () => {
    const body = rss(`
      <item><title>Guid only</title><guid>https://blog.example.com/guid-post</guid></item>
      <item><title>Explicit permalink</title><guid isPermaLink="true">https://blog.example.com/perma</guid></item>
      <item><title>Not a permalink</title><guid isPermaLink="false">https://blog.example.com/not-a-link</guid></item>
      <item><title>Opaque guid</title><guid>abc-123</guid></item>
      <item><title>Relative</title><link>/blog/relative-post</link></item>
      <item><title>Protocol relative</title><link>//cdn.example.com/post</link></item>
      <item><title>2027</title><link>https://blog.example.com/y</link></item>
      <item><title>1.0</title><link>https://blog.example.com/v</link></item>
      <item><title>0x41414141</title><link>https://blog.example.com/h</link></item>
      <item><title>007</title><link>https://blog.example.com/b</link></item>`);
    const r = parseFeed(body, { feedUrl: FEED });
    const entries = ok(r);
    assert.deepEqual(
      entries.map((e) => [e.title, e.link]),
      [
        ["Guid only", "https://blog.example.com/guid-post"],
        ["Explicit permalink", "https://blog.example.com/perma"],
        ["Relative", "https://blog.example.com/blog/relative-post"],
        ["Protocol relative", "https://cdn.example.com/post"],
        ["2027", "https://blog.example.com/y"],
        ["1.0", "https://blog.example.com/v"],
        ["0x41414141", "https://blog.example.com/h"],
        ["007", "https://blog.example.com/b"],
      ],
    );
    assert.equal(r.skipped, 2);
  });

  it("3b. xml:base and feedburner:origLink", () => {
    const body = `<rss version="2.0" xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0"><channel xml:base="https://origin.example.org/news/">
      <item><title>Based</title><link>story-1</link></item>
      <item><title>Origlink</title><feedburner:origLink>https://origin.example.org/real</feedburner:origLink></item></channel></rss>`;
    assert.deepEqual(ok(parseFeed(body, { feedUrl: "https://feeds.example.net/x" })).map((e) => e.link), ["https://origin.example.org/news/story-1", "https://origin.example.org/real"]);
  });

  it("10. hostile entities and absurd dates pass through as raw text - nothing throws", () => {
    const body = rss(`
      <item><title>Bad &amp;#x110000; entity &#x110000; &#99999999; ok</title><link>https://blog.example.com/1</link><pubDate>99999999999999999 days ago</pubDate><description><![CDATA[&#99999999; <b>x</b>]]></description></item>
      <item><title>Years</title><link>https://blog.example.com/2</link><pubDate>300000 years ago</pubDate></item>
      <item><title>Fine</title><link>https://blog.example.com/3</link><pubDate>Thu, 19 Nov 2026 10:00:00 GMT</pubDate></item>`);
    const entries = ok(parseFeed(body, { feedUrl: FEED }));
    assert.equal(entries.length, 3);
    assert.ok(entries[0].title.includes("&#x110000;"), "numeric references stay raw for normalize's guarded decoder");
    assert.equal(entries[0].publishedRaw, "99999999999999999 days ago");
    assert.equal(entries[1].publishedRaw, "300000 years ago");
  });

  it("11a. prefixed Atom root (<atom:feed>) is recognised", () => {
    const body = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>T</atom:title>
      <atom:entry><atom:title>Prefixed</atom:title><atom:link rel="alternate" href="https://blog.example.com/p"/><atom:updated>2026-11-19T00:00:00Z</atom:updated><atom:summary>S</atom:summary></atom:entry></atom:feed>`;
    const r = parseFeed(body, { feedUrl: FEED });
    const entries = ok(r);
    assert.equal(r.ok && r.format, "atom");
    assert.deepEqual(entries[0], { title: "Prefixed", link: "https://blog.example.com/p", publishedRaw: "2026-11-19T00:00:00Z", summaryHtml: "S" });
  });

  it("11b. Atom type=xhtml title keeps its words in order", () => {
    const body = atom(`<entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Less: <em>more</em> text &amp; things</div></title><link href="https://blog.example.com/x"/></entry>
      <entry><title type="html">Plain &amp;amp; simple</title><link href="https://blog.example.com/y"/></entry>`);
    const entries = ok(parseFeed(body, { feedUrl: FEED }));
    assert.equal(entries[0].title, "Less: more text & things");
    assert.equal(entries[1].title, "Plain &amp; simple");
  });

  it("11c. RSS served as text/html is still a feed; 11d. HTML served as application/xml is not", () => {
    // parseFeed judges the BODY; the Content-Type header is deliberately not an input.
    assert.equal(sniffBody(rss("")), "xml");
    assert.equal(ok(parseFeed(rss("<item><title>A</title><link>https://blog.example.com/a</link></item>"), { feedUrl: FEED })).length, 1);
    for (const html of ["<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf</body></html>", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>hi</p></body></html>', "<html><body>x</body></html>"]) {
      assert.equal(sniffBody(html), "html");
      assert.equal(fail(parseFeed(html, { feedUrl: FEED })).error, "not_feed");
    }
    assert.equal(fail(parseFeed('<?xml version="1.0"?><opml version="2.0"><body/></opml>', { feedUrl: FEED })).error, "not_feed");
    assert.equal(fail(parseFeed("", { feedUrl: FEED })).error, "not_feed");
    assert.equal(fail(parseFeed("Service temporarily unavailable", { feedUrl: FEED })).error, "not_feed");
  });

  it("non-http links are dropped: javascript:, data:, mailto:, ftp:, credentials-only junk", () => {
    const body = rss(`
      <item><title>js</title><link>javascript:alert(1)</link></item>
      <item><title>data</title><link>data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;</link></item>
      <item><title>mail</title><link>mailto:a@example.com</link></item>
      <item><title>ftp</title><link>ftp://files.example.com/x</link></item>
      <item><title>JS caps</title><link> JaVaScRiPt:alert(1)</link></item>
      <item><title>guid js</title><guid>javascript:alert(2)</guid></item>
      <item><title>good</title><link>https://blog.example.com/good</link></item>`);
    const r = parseFeed(body, { feedUrl: FEED });
    assert.deepEqual(ok(r).map((e) => e.title), ["good"]);
    assert.equal(r.skipped, 6);
    assert.equal(resolveHttpUrl("javascript:alert(1)", FEED), null);
    assert.equal(resolveHttpUrl("vbscript:x", FEED), null);
    assert.equal(resolveHttpUrl("/ok", FEED), "https://blog.example.com/ok");
  });

  it("a feed whose every item is unusable is 'empty', never ok", () => {
    const r = parseFeed(rss("<item><title></title><link>https://blog.example.com/a</link></item><item><title>x</title></item>"), { feedUrl: FEED });
    const f = fail(r);
    assert.equal(f.error, "empty");
    assert.equal(r.total, 2);
    assert.equal(r.skipped, 2);
  });

  it("title and summary are length-capped; a single item works without an array", () => {
    const long = "A".repeat(5000);
    const entries = ok(parseFeed(rss(`<item><title>${long}</title><link>https://blog.example.com/a</link><description>${"word ".repeat(5000)}</description><category>one</category></item>`), { feedUrl: FEED }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title.length, RAW_TITLE_MAX);
    assert.ok((entries[0].summaryHtml ?? "").length <= RAW_SUMMARY_MAX);
    assert.deepEqual(entries[0].categories, ["one"]);
  });

  it("more than 100,000 entity references parse (V1's lowered cap made big release feeds fail)", () => {
    const content = "&lt;p&gt;&quot;x&quot; &amp; y&lt;/p&gt;".repeat(21_000); // 126,000 references
    const r = parseFeed(atom(`<entry><title>big</title><link href="https://blog.example.com/big"/><content type="html">${content}</content></entry>`), { feedUrl: FEED });
    assert.equal(ok(r).length, 1);
  });

  it("a DTD entity bomb does not expand", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]><rss><channel><item><title>x &f;</title><link>https://blog.example.com/b</link><description>&f;&f;&f;</description></item></channel></rss>`;
    const r = parseFeed(bomb, { feedUrl: FEED });
    if (r.ok) {
      assert.ok(r.entries[0].title.length <= RAW_TITLE_MAX);
      assert.ok((r.entries[0].summaryHtml ?? "").length <= RAW_SUMMARY_MAX);
    } else {
      assert.ok(["parse", "empty"].includes(r.error));
    }
  });

  it("fuzz: random and mutated bodies never throw", () => {
    const seeds = [readFeedFixture("rss2-wired-ai.xml"), readFeedFixture("atom-theverge-ai.xml"), '{"version":"https://jsonfeed.org/version/1","items":[{"id":1,"url":"x"}]}'];
    let x = 12345;
    const rand = (n: number): number => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x % n;
    };
    const junk = ["<", ">", "&", "&#x110000;", "]]>", "<![CDATA[", "\u0000", "\uD800", '"', "<!--", "<?", "{", "}", "<item>", "</entry>", "&lol;"];
    for (let i = 0; i < 300; i++) {
      let body = seeds[i % seeds.length];
      for (let k = 0; k < 1 + rand(6); k++) {
        const at = rand(body.length);
        body = rand(2) ? body.slice(0, at) + junk[rand(junk.length)] + body.slice(at) : body.slice(0, at) + body.slice(at + rand(200));
      }
      if (i % 7 === 0) body = body.slice(0, rand(body.length));
      const r = parseFeed(body, { feedUrl: FEED });
      assert.equal(typeof r.ok, "boolean");
      if (r.ok) for (const e of r.entries) assert.ok(isHttpUrl(e.link) && e.title.length > 0);
    }
  });
});
