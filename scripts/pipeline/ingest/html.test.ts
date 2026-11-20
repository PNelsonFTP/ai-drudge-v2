import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFixtureJson, readFixtureText } from "../../../test/helpers/fixtures";
import { findAll, MAX_DEPTH, parseHtml, textOf, tokenizeHtml, type El, type HtmlToken } from "./html";
import { extractHtmlLinks } from "./scrape";

// The regular expression the tokenizer used to be (SEC-1 follow-up). It is correct but quadratic on
// unterminated tags / comments; the linear scanner must accept exactly the same tokens.
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![a-zA-Z][^>]*>|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function reference(html: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  for (const m of html.matchAll(TOKEN)) {
    const t: HtmlToken = { index: m.index, end: m.index + m[0].length };
    if (m[1] !== undefined) t.close = m[1];
    if (m[2] !== undefined) {
      t.open = m[2];
      t.attrs = m[3] ?? "";
    }
    out.push(t);
  }
  return out;
}

describe("html tokenizer: same tokens as the old regular expression", () => {
  it("hand-picked shapes", () => {
    const cases = [
      "",
      "plain text",
      `<a href="/x">Title</a>`,
      `<A HREF='/x' data-x="a > b" class=card>T</A >`,
      `<p title="5" monitor">broken quote</p><a href="/next">Next</a>`,
      `a < b and c > d <b>bold</b>`,
      `<!-- c --><!DOCTYPE html><![CDATA[ x > y ]]><x:y-z_1 a='"'>`,
      `<!--> not a comment end --> <i>x</i>`,
      `<a "unterminated <b>bold</b> <i 'x>`,
      `<a 'q"q' "p'p">ok</a><a "`,
      `<br/><img src=x.png><input disabled>`,
      `<<a>><</a>></ a><1a><a1>`,
      `<a\n  href="/x"\n>multi\nline</a\n>`,
      `<!---->x<!-- a -- b -->y<!--`,
      `</><!><![CDATA[<![CDATA[]]>]]>`,
    ];
    for (const html of cases) assert.deepEqual(tokenizeHtml(html), reference(html), JSON.stringify(html));
  });

  it("30,000 generated inputs, most of them malformed", () => {
    const toks = ["<a ", "<a>", "</a>", "<b", ">", "<", '"', "'", " x=", "y", "<!--", "-->", "<![CDATA[", "]]>", "<!DOCTYPE ", "</", "/", "<script>", "</script>", " ", "\n", "<p:q-r ", "=", "<!", "-", "text"];
    let seed = 987654321;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 30_000; i++) {
      let s = "";
      for (let j = 1 + Math.floor(rnd() * 18); j > 0; j--) s += toks[Math.floor(rnd() * toks.length)];
      assert.deepEqual(tokenizeHtml(s), reference(s), JSON.stringify(s));
    }
  });

  it("every scrape fixture page tokenizes identically", () => {
    interface Fx {
      file: string;
      mode: string;
    }
    const pages = readFixtureJson<Fx[]>("scrape", "index.json").filter((f) => f.mode === "html-links");
    assert.ok(pages.length > 0);
    for (const fx of pages) {
      const html = readFixtureText("scrape", fx.file);
      assert.deepEqual(tokenizeHtml(html), reference(html), fx.file);
    }
  });
});

describe("html tokenizer: hostile pages (SEC-1 follow-up)", () => {
  it("megabytes of unterminated tags / comments / quotes cost milliseconds, not minutes", () => {
    const N = 300_000;
    const shapes: Record<string, string> = {
      "<a without >": "<a ".repeat(N),
      "unclosed <!--": "<!--".repeat(N),
      "unclosed CDATA": "<![CDATA[".repeat(N / 2),
      "unclosed declarations": "<!x ".repeat(N),
      "unclosed end tags": "</a ".repeat(N),
      "unterminated double quotes": `${'<a "'.repeat(N)}>`,
      "alternating quotes": `${`<a "' <b '" `.repeat(N / 2)}`,
      "odd quote count, then a >": `${'<a "x" '.repeat(N)}"<i>`,
      "a million <": "<".repeat(1_000_000),
    };
    for (const [name, html] of Object.entries(shapes)) {
      const t0 = performance.now();
      const root = parseHtml(html);
      const ms = performance.now() - t0;
      assert.ok(ms < 1_500, `${name}: ${Math.round(ms)} ms for ${html.length} chars`); // "<a " x 32k alone took 2.2 s
      assert.equal(root.tag, "#root");
    }
  });

  it("small hostile shapes still agree with the reference tokenizer", () => {
    for (const unit of ["<a ", "<!--", '<a "', `<a "' <b '" `, '<a "x" ', "</a ", "<!x "]) {
      for (const tail of ["", ">", '">', "-->", "'>"]) {
        const html = unit.repeat(200) + tail;
        assert.deepEqual(tokenizeHtml(html), reference(html), JSON.stringify(unit + tail));
      }
    }
  });

  it("nesting is bounded: stray end tags and implied-end searches over a deep open-element stack stay cheap", () => {
    const N = 250_000;
    const shapes: Record<string, string> = {
      "opens, then unmatched end tags": "<a>".repeat(N) + "</b>".repeat(N),
      "opens, then <td></td> pairs": "<a>".repeat(N) + "<td></td>".repeat(N),
    };
    for (const [name, html] of Object.entries(shapes)) {
      const t0 = performance.now();
      const root = parseHtml(html);
      const ms = performance.now() - t0;
      // Budget, not a benchmark: the regression this guards took 16-32 s at a THIRD of this size, so
      // 15 s still fails on it. 2 s was 2-4x the measured time on a fast laptop (470-960 ms) and
      // failed once in four full-suite runs under load (2,561 ms) - and `npm test` gates every
      // refresh and pull request on slower hosted runners.
      assert.ok(ms < 15_000, `${name}: ${Math.round(ms)} ms for ${html.length} chars`);
      let depth = 0;
      for (let el: El | undefined = root; el; el = el.children.find((c): c is El => typeof c !== "string")) depth++;
      assert.ok(depth <= MAX_DEPTH + 2, `${name}: depth ${depth}`);
    }
    // The recursive walkers used to overflow the call stack on such a page (caught per source, but an error all the same).
    const deep = `${"<div>".repeat(20_000)}<a href="/news/x-y"><h2>Title of the post</h2></a>`;
    const r = extractHtmlLinks(deep, { base: "https://lab.example.com", linkPattern: "/news/[a-z0-9-]+" }, "https://lab.example.com/news", { nowMs: Date.UTC(2026, 10, 20), maxItems: 10 });
    assert.ok(Array.isArray(r.cards));
  });

  it("a page nested 100 deep (far beyond real pages) is parsed in full", () => {
    const html = `${"<div>".repeat(100)}<a href="/x">Deep link</a>${"</div>".repeat(100)}<p>After</p>`;
    const root = parseHtml(html);
    assert.deepEqual(findAll(root, (e) => e.tag === "a").map((a) => textOf(a)), ["Deep link"]);
    assert.equal(findAll(root, (e) => e.tag === "div").length, 100);
    assert.equal(root.children.length, 2, "the chain closed properly: <p> is a sibling of the outer <div>");
  });

  it("the tree builder is unchanged: nesting, raw text, implied end tags", () => {
    const root = parseHtml(`<ul><li><a href="/a" class="c">One<li><a href='/b'>Two</a></ul><script>if (a < b) { x = "<a href='/no'>"; }</script><p>After`);
    const links = findAll(root, (e) => e.tag === "a");
    assert.deepEqual(links.map((a) => [a.attrs.href, textOf(a)]), [["/a", "One"], ["/b", "Two"]]);
    assert.equal(findAll(root, (e) => e.tag === "li").length, 2);
    assert.equal(textOf(root), "One Two After");
  });
});
