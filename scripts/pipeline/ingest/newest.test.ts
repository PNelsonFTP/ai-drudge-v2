import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NOW_MS } from "../../../test/helpers/factories";
import { parseFeed } from "./feedParser";
import { capSummary, capText, dateKey, newestAgeDays, newestFirst, oneLine, stripHtmlComments, stripNonTextBlocks, takeNewest } from "./newest";

const NOW = FIXTURE_NOW_MS;
const HOUR = 3_600_000;
const iso = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();
const item = (title: string, publishedRaw: string | null): { title: string; publishedRaw: string | null } => ({ title, publishedRaw });

describe("dateKey", () => {
  it("reads ISO, RFC 822 and relative dates", () => {
    assert.equal(dateKey("2026-11-19T20:00:00Z", NOW), NOW - HOUR);
    assert.equal(dateKey("Thu, 19 Nov 2026 20:00:00 GMT", NOW), NOW - HOUR);
    assert.equal(dateKey("3 hours ago", NOW), NOW - 3 * HOUR);
    assert.equal(dateKey("Published 2 days ago", NOW), NOW - 48 * HOUR);
  });

  it("returns null for junk and absurd dates instead of throwing", () => {
    for (const raw of [null, undefined, "", "   ", "not a date", "99999999999999999 days ago", "300000 years ago", "0001-01-01T00:00:00Z", "9999-12-31T00:00:00Z", "x".repeat(500)]) {
      assert.equal(dateKey(raw, NOW), null, String(raw));
    }
  });
});

describe("newest-N by date", () => {
  it("11e. an oldest-first feed keeps its NEWEST items (V1 kept the first 15 in document order)", () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`post ${i + 1}`, iso(20 - i))); // post 20 is the newest
    const top = takeNewest(items, 15, NOW);
    assert.equal(top.length, 15);
    assert.deepEqual(top.slice(0, 3).map((x) => x.title), ["post 20", "post 19", "post 18"]);
    assert.ok(!top.some((x) => ["post 1", "post 2", "post 3", "post 4", "post 5"].includes(x.title)));
  });

  it("the same through the parser: oldest-first RSS, cap 5", () => {
    const body = `<rss><channel>${Array.from({ length: 20 }, (_, i) => `<item><title>post ${i + 1}</title><link>https://e.example.com/${i + 1}</link><pubDate>${new Date(NOW - (20 - i) * HOUR).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`;
    const r = parseFeed(body, { feedUrl: "https://e.example.com/feed" });
    assert.ok(r.ok);
    assert.deepEqual(takeNewest(r.entries, 5, NOW).map((e) => e.title), ["post 20", "post 19", "post 18", "post 17", "post 16"]);
  });

  it("relevance-ordered query feeds are sorted by date before the cap", () => {
    const items = [item("old but relevant", iso(700)), item("fresh", iso(2)), item("older", iso(300)), item("freshest", iso(1))];
    assert.deepEqual(takeNewest(items, 2, NOW).map((x) => x.title), ["freshest", "fresh"]);
  });

  it("is stable, keeps document order for undated feeds, and never promotes undated or future items to the top", () => {
    const undated = [item("a", null), item("b", null), item("c", "garbage")];
    assert.deepEqual(newestFirst(undated, NOW).map((x) => x.title), ["a", "b", "c"]);

    const mixed = [item("undated", null), item("yesterday", iso(24)), item("future", iso(-72)), item("two days", iso(48)), item("now", iso(0)), item("same time", iso(0))];
    assert.deepEqual(newestFirst(mixed, NOW).map((x) => x.title), ["now", "same time", "yesterday", "undated", "two days", "future"]);
  });

  it("does not mutate its input", () => {
    const items = [item("old", iso(10)), item("new", iso(1))];
    newestFirst(items, NOW);
    assert.equal(items[0].title, "old");
  });

  it("newestAgeDays ignores undated and future items", () => {
    assert.equal(newestAgeDays([item("a", null)], NOW), null);
    assert.equal(newestAgeDays([item("a", iso(48)), item("b", iso(24)), item("c", iso(-500))], NOW), 1);
  });
});

describe("size caps", () => {
  it("capText never splits a surrogate pair", () => {
    const s = `${"a".repeat(9)}😀tail`;
    assert.equal(capText(s, 10), "a".repeat(9));
    assert.equal(capText(s, 11), `${"a".repeat(9)}😀`);
    assert.equal(capText("short", 10), "short");
  });

  it("capSummary drops style / script blocks before cutting, and a trailing half tag or entity", () => {
    const css = `<style>${".x{margin:0;padding:0}".repeat(400)}</style>`;
    const out = capSummary(`${css}<p>Real text here.</p>${"<p>filler</p>".repeat(1000)}`, 500);
    assert.ok(out.length <= 500);
    assert.ok(out.startsWith("<p>Real text here.</p>"));
    assert.doesNotMatch(out, /margin|<style/);
    assert.doesNotMatch(out, /<[^>]*$/);

    const cutInsideTag = capSummary(`${"x".repeat(490)}<a href="https://example.com/very/long/link">link</a>`, 500);
    assert.equal(cutInsideTag, "x".repeat(490));
    assert.equal(capSummary(`${"x".repeat(495)}&amp;more`, 498), "x".repeat(495));
  });

  it("capSummary removes an unterminated style block that the cut would leave open", () => {
    const out = capSummary(`<p>Lead.</p><style>${"a{b:c}".repeat(5000)}`, 300);
    assert.equal(out, "<p>Lead.</p>");
  });

  it("short summaries are returned untouched (ingest does not clean text)", () => {
    assert.equal(capSummary(" <style>a{}</style><p>x &amp; y</p> "), "<style>a{}</style><p>x &amp; y</p>");
  });
});

describe("capSummary on hostile input (SEC-1)", () => {
  // The two regular expressions capSummary used before; the linear scans must produce the same text.
  const NON_TEXT_BLOCKS = /<(style|script|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const reference = (html: string): string => html.replace(NON_TEXT_BLOCKS, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const linear = (html: string): string => stripHtmlComments(stripNonTextBlocks(html));

  it("the linear scans are equivalent to the old regular expressions (20,000 generated inputs)", () => {
    const toks = ["<script>", "<script src='a'>", "</script>", "</script >", "<STYLE>", "</style>", "<svg viewBox='0 0 1 1'>", "</svg>", "<noscript>", "</noscript>", "<template>", "</template>", "<!--", "-->", "<p>", "text ", ">", "<", "<scripted>", "<style", "</SCRIPT>", "\n", "a{b:c}", "<Svg\n>", "</svg\t>", "<!-->", "--", "<script", " "];
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 20_000; i++) {
      let s = "";
      for (let j = 1 + Math.floor(rnd() * 14); j > 0; j--) s += toks[Math.floor(rnd() * toks.length)];
      assert.equal(linear(s), reference(s), JSON.stringify(s));
    }
    assert.equal(linear("plain text, no markup"), "plain text, no markup");
  });

  it("1 MB of unclosed openers costs milliseconds, not the minutes that blocked every timer of the run", () => {
    const MB = 1024 * 1024;
    const shapes: Record<string, string> = {
      "unclosed <script>": "<script>".repeat(MB / 8),
      "<script without >": "<script ".repeat(MB / 8),
      "unclosed <!--": "<!--".repeat(MB / 4),
      "openers, then the wrong closer": `${"<script>".repeat(MB / 8)}</style>`,
      "mixed tag names": "<script><style><svg><noscript><template>".repeat(MB / 40),
    };
    for (const [name, html] of Object.entries(shapes)) {
      const t0 = performance.now();
      const out = capSummary(`<p>Lead.</p>${html}`);
      const ms = performance.now() - t0;
      assert.ok(ms < 1_000, `${name}: ${Math.round(ms)} ms`); // was 10-45 s at this size
      assert.ok(out.length <= 4000, name);
      assert.ok(out.startsWith("<p>Lead.</p>"), name);
    }
  });

  it("a feed whose one description is 150,000 unclosed <script> openers parses without stalling", () => {
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>Hello</title><link>https://example.com/a</link><description><![CDATA[${"<script>".repeat(150_000)}]]></description></item></channel></rss>`;
    const t0 = performance.now();
    const r = parseFeed(body, { feedUrl: "https://example.com/feed" });
    const ms = performance.now() - t0;
    assert.ok(r.ok && r.entries.length === 1 && r.entries[0].title === "Hello");
    assert.ok(ms < 2_000, `parseFeed took ${Math.round(ms)} ms`); // was 12.5 s
  });
});

describe("oneLine (SEC-4)", () => {
  it("collapses newlines and control characters, trims and caps", () => {
    assert.equal(oneLine("invalid JSON: Unexpected token ':', \"[\n::error::PWNED\n\" is not valid JSON"), "invalid JSON: Unexpected token ':', \"[ ::error::PWNED \" is not valid JSON");
    assert.equal(oneLine("a\r\nb\tc\u001b[31md\u2028e\u0085f"), "a b c [31md e f");
    assert.equal(oneLine("  x  "), "x");
    assert.equal(oneLine(null), "");
    assert.equal(oneLine("y".repeat(500)).length, 200);
    assert.equal(oneLine("y".repeat(500), 50).length, 50);
  });
});
