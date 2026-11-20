import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NOW_MS } from "../../../test/helpers/factories";
import { readFixtureJson, readFixtureText } from "../../../test/helpers/fixtures";
import { isHttpUrl } from "../../../shared/url";
import type { JsonApiConfig, ScrapeConfig } from "../../registry/types";
import { findAll, parseHtml, textOf } from "./html";
import { dateKey } from "./newest";
import { compileLinkPattern, extractHtmlLinks, extractJsonApi, findDateInText } from "./scrape";

const NOW = FIXTURE_NOW_MS;
const ALL = 1000;

interface ScrapeFixture {
  id: string;
  file: string;
  url: string;
  mode: "html-links" | "json-api";
  config: ScrapeConfig & JsonApiConfig;
  expect: { cards: number; dated: number; firstTitle: string; firstLink: string; firstDate: string };
  v1Scraper: boolean;
}

const FIXTURES = readFixtureJson<ScrapeFixture[]>("scrape", "index.json");
const fixture = (id: string): ScrapeFixture => {
  const fx = FIXTURES.find((f) => f.id === id);
  if (!fx) throw new Error(`no scrape fixture ${id}`);
  return fx;
};
const scrape = (id: string, maxItems = ALL, overrides: Partial<ScrapeConfig> = {}) => {
  const fx = fixture(id);
  return extractHtmlLinks(readFixtureText("scrape", fx.file), { ...fx.config, ...overrides }, fx.url, { nowMs: NOW, maxItems });
};

describe("scrape fixtures (today's real markup)", () => {
  it("covers the 4 V1 scrapers and the curated scrape picks", () => {
    assert.deepEqual(FIXTURES.filter((f) => f.v1Scraper).map((f) => f.id), ["anthropic-news", "anthropic-research", "uk-aisi-blog", "gray-swan"]);
    assert.ok(FIXTURES.length >= 18);
  });

  for (const fx of FIXTURES) {
    it(`${fx.id}: ${fx.expect.cards} cards, ${fx.expect.dated} dated`, () => {
      const text = readFixtureText("scrape", fx.file);
      const cards =
        fx.mode === "html-links"
          ? extractHtmlLinks(text, fx.config, fx.url, { nowMs: NOW, maxItems: ALL }).cards
          : (() => {
              const r = extractJsonApi(text, fx.config, fx.url, { nowMs: NOW, maxItems: ALL });
              assert.ok(r.ok);
              return r.ok ? r.cards : [];
            })();
      assert.equal(cards.length, fx.expect.cards);
      assert.equal(cards.filter((c) => c.publishedRaw !== null).length, fx.expect.dated);
      assert.deepEqual([cards[0].title, cards[0].link, cards[0].publishedRaw], [fx.expect.firstTitle, fx.expect.firstLink, fx.expect.firstDate]);
      assert.equal(new Set(cards.map((c) => c.link)).size, cards.length, "one card per URL");
      for (const c of cards) {
        assert.ok(isHttpUrl(c.link), c.link);
        assert.ok(c.title.length >= 2 && c.title.length <= 300, `title: ${c.title}`);
        assert.doesNotMatch(c.title, /<[a-z]/i);
        if (c.publishedRaw !== null) assert.notEqual(dateKey(c.publishedRaw, NOW), null, `usable date: ${c.publishedRaw}`);
      }
      // newest first
      const keys = cards.map((c) => dateKey(c.publishedRaw, NOW)).filter((k): k is number => k !== null);
      assert.deepEqual(keys, [...keys].sort((a, b) => b - a));
    });
  }

  it("Anthropic News (dead in V1 for 30 days): >= 10 items with titles AND dates, no category chips", () => {
    const { cards, matched, dropped } = scrape("anthropic-news", 15);
    assert.equal(cards.length, 15, "capped at maxItems");
    assert.ok(cards.every((c) => c.title.length > 10 && /^\d{4}-\d{2}-\d{2}$/.test(c.publishedRaw ?? "")));
    assert.ok(cards.every((c) => c.link.startsWith("https://www.anthropic.com/news/")));
    const slugs = cards.map((c) => c.link.split("/").pop());
    for (const chip of ["announcements", "features", "partnerships", "product", "policy", "safeguards", "security"]) assert.ok(!slugs.includes(chip), `category chip /news/${chip} must not be an item`);
    assert.equal(matched, 26);
    assert.equal(dropped, 7);
    assert.ok(cards.some((c) => (c.summaryHtml ?? "").length > 40), "cards carry the teaser paragraph");
    // The cap keeps the NEWEST 15 of the 19 posts.
    assert.deepEqual(cards.slice(0, 2).map((c) => c.publishedRaw), ["2026-11-18", "2026-11-10"]);
  });

  it("Anthropic Research: the 10 newest, each dated from the card header <time>", () => {
    const { cards } = scrape("anthropic-research", 10);
    assert.equal(cards.length, 10);
    assert.ok(cards.every((c) => c.publishedRaw !== null && c.link.startsWith("https://www.anthropic.com/research/")));
  });

  it("UK AISI and Gray Swan: every card gets its date from the page text (V1: all undated)", () => {
    for (const id of ["uk-aisi-blog", "gray-swan"]) {
      const { cards } = scrape(id);
      assert.ok(cards.length >= 10);
      assert.ok(cards.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.publishedRaw ?? "")), id);
    }
  });

  it("dateHint 'none': explicit date markup is still read, date TEXT is not, and nothing is dropped for lacking a date", () => {
    const graySwan = scrape("gray-swan", ALL, { dateHint: "none" });
    assert.equal(graySwan.cards.length, 12, "the one undated link is kept (it gets firstSeenAt downstream)");
    assert.equal(graySwan.cards.filter((c) => c.publishedRaw !== null).length, 11, "<p fs-cmsfilter-field=date> is explicit markup");
    // Artificial Analysis only has a plain <p>November 18, 2026</p>: that is prose unless the registry says dateHint "time".
    const aa = scrape("artificial-analysis-articles", ALL, { dateHint: "none" });
    assert.equal(aa.cards.length, 12);
    assert.ok(aa.cards.every((c) => c.publishedRaw === null));
  });

  it("FINRA: evergreen guidance pages excluded by the pattern or dropped as undated; date formats vary", () => {
    const { cards } = scrape("finra-cyber-alerts");
    assert.ok(cards.every((c) => !/\/(faqs|common-cybersecurity-threats|cybersecurity-effective-practices)$/.test(c.link)));
    assert.ok(cards.every((c) => c.publishedRaw !== null));
  });

  it("Ollama: short model slugs are titles, the description is the summary", () => {
    const { cards } = scrape("ollama-library-newest");
    assert.ok(cards.some((c) => c.title.length < 5), "no minimum title length");
    assert.ok(cards.filter((c) => (c.summaryHtml ?? "").length > 20).length >= 15);
  });
});

describe("the registry's scrape sources against the fixtures", () => {
  interface RegistrySource {
    id: string;
    url: string;
    kind: string;
    status?: string;
    maxItems?: number;
    scrape?: ScrapeConfig;
    jsonApi?: JsonApiConfig;
  }

  it("every scrape / json source with a fixture yields titled cards with the registry's own config", async (t) => {
    // The registry is another package's module: load it at run time and skip when it is not there.
    const spec = new URL("../../registry/index.ts", import.meta.url).href;
    const mod = (await import(spec).catch(() => null)) as { SOURCES?: RegistrySource[] } | null;
    if (!mod?.SOURCES) return t.skip("scripts/registry/index.ts not available");
    const sources = mod.SOURCES.filter((s) => s.kind === "scrape" || s.kind === "json");
    let checked = 0;
    for (const s of sources) {
      const fx = FIXTURES.find((f) => f.id === s.id);
      if (!fx) continue;
      checked++;
      const text = readFixtureText("scrape", fx.file);
      const max = s.scrape?.maxItems ?? s.maxItems ?? 15;
      const cards = s.scrape
        ? extractHtmlLinks(text, s.scrape, s.url, { nowMs: NOW, maxItems: max }).cards
        : s.jsonApi
          ? ((r) => (r.ok ? r.cards : []))(extractJsonApi(text, s.jsonApi, s.url, { nowMs: NOW, maxItems: max }))
          : [];
      assert.ok(cards.length >= Math.min(3, max), `${s.id}: ${cards.length} cards`);
      for (const c of cards) {
        assert.ok(isHttpUrl(c.link), `${s.id}: ${c.link}`);
        assert.doesNotMatch(c.title, /^(read|learn|view|see)\b.{0,12}$/i, `${s.id}: call-to-action as title`);
        if (s.scrape?.dateHint === "time") assert.ok(c.publishedRaw !== null, `${s.id}: "${c.title}" has no date`);
      }
    }
    assert.ok(checked >= 4, `only ${checked} registry scrape sources have a fixture`);
  });
});

describe("extractHtmlLinks: structure", () => {
  const cfg: ScrapeConfig = { base: "https://lab.example.com", linkPattern: "/news/[a-z0-9-]+", dateHint: "time" };
  const page = "https://lab.example.com/news";
  const run = (html: string, c: Partial<ScrapeConfig> = {}) => extractHtmlLinks(html, { ...cfg, ...c }, page, { nowMs: NOW, maxItems: ALL }).cards;

  it("is attribute-order and quote tolerant, and resolves absolute / relative / root-relative hrefs", () => {
    const html = `<ul>
      <li><a class="x" data-a='1' href="/news/first-post"><h3>First post</h3></a><time datetime="2026-11-18">Nov 18</time></li>
      <li><a href='/news/second-post' class="x"><h3>Second post</h3></a><time datetime="2026-11-17">Nov 17</time></li>
      <li><a id=third href=/news/third-post><h3>Third post</h3></a><time datetime="2026-11-16">Nov 16</time></li>
      <li><a HREF="https://lab.example.com/news/fourth-post?utm=1#top" target="_blank"><h3>Fourth post</h3></a><time datetime="2026-11-15">x</time></li>
      <li><a href="https://elsewhere.example.org/news/not-ours"><h3>Other site</h3></a><time datetime="2026-11-14">x</time></li>
      <li><a href="/about/team"><h3>About</h3></a></li></ul>`;
    assert.deepEqual(
      run(html).map((c) => [c.title, c.link, c.publishedRaw]),
      [
        ["First post", "https://lab.example.com/news/first-post", "2026-11-18"],
        ["Second post", "https://lab.example.com/news/second-post", "2026-11-17"],
        ["Third post", "https://lab.example.com/news/third-post", "2026-11-16"],
        ["Fourth post", "https://lab.example.com/news/fourth-post?utm=1", "2026-11-15"],
      ],
    );
  });

  it("title: inner heading > heading around the link > link text > aria-label > img alt; CTA text is ignored", () => {
    const html = `<main>
      <article><a href="/news/a" aria-label="read Label A"><img alt="Alt A"><div><h2>Heading A</h2><p>Teaser that is long enough to be a summary paragraph.</p></div></a><time datetime="2026-11-10"></time></article>
      <article><h3><a href="/news/b">Wrapped B</a></h3><time datetime="2026-11-09"></time></article>
      <article><a href="/news/c"><img alt="Alt C"></a><a href="/news/c">Text C is the link text</a><a href="/news/c">Read more</a><time datetime="2026-11-08"></time></article>
      <article><a href="/news/d" aria-label="Read more about Label D"><img src="x.png"></a><time datetime="2026-11-07"></time></article>
      <article><a href="/news/e"><img alt="Alt E" src="e.png"></a><time datetime="2026-11-06"></time></article>
      <article><a href="/news/f">Read more</a><time datetime="2026-11-05"></time></article></main>`;
    const cards = run(html);
    assert.deepEqual(cards.map((c) => c.title), ["Heading A", "Wrapped B", "Text C is the link text", "Label D", "Alt E"]);
    assert.equal(cards[0].summaryHtml, "Teaser that is long enough to be a summary paragraph.");
  });

  it("a link that only says 'Read post' / 'Read On' takes the nearest heading or name field of its card", () => {
    const html = `<main><section class="hero"><h1>Lab Blog</h1>
        <div class="hero-card"><h2>Hero headline of the newest post</h2><p>Nov 2, 2026</p><a href="/news/hero-post" class="button"><div>Read On</div></a></div></section>
      <div class="grid">
        <article class="card"><h3>Heading before the button</h3><p class="item-meta">Oct 25, 2026 - 4 min</p><a href="/news/heading-card">Read post</a></article>
        <div class="card"><p fs-list-field="name">Title in a name field</p><p>Oct 20, 2026</p><a href="/news/field-card"><span>Read on</span></a></div>
        <div class="card"><p fs-list-field="name">Hero headline, grid twin</p><p>Nov 2, 2026</p><a href="/news/hero-post">Read On</a></div>
        <a href="/news/feature-card" class="feature"><div class="feature-title">Codename</div><div class="feature-desc">A longer description of the feature that is not the title.</div><div>Read the Research</div></a>
        <div class="card"><h3>Codename: the full headline</h3><p>Oct 1, 2026</p><a href="/news/feature-card">Read on</a></div>
        <div class="card"><p>Sep 1, 2026</p><a href="/news/no-title-anywhere">Read more</a></div>
      </div></main>`;
    const r = extractHtmlLinks(html, cfg, page, { nowMs: NOW, maxItems: ALL });
    assert.deepEqual(
      r.cards.map((c) => [c.title, c.link.split("/").pop(), c.publishedRaw]),
      [
        ["Hero headline of the newest post", "hero-post", "2026-11-02"],
        ["Heading before the button", "heading-card", "2026-10-25"],
        ["Title in a name field", "field-card", "2026-10-20"],
        ["Codename: the full headline", "feature-card", "2026-10-01"],
      ],
    );
    assert.equal(r.dropped, 1, "a link with no title anywhere is dropped, never published as 'Read more'");
  });

  it("titleSelectorHint can prefer the aria-label or the image alt", () => {
    const html = `<article><a href="/news/a" aria-label="The full accessible title"><img alt="Cover art"><h3>Short</h3></a><time datetime="2026-11-10"></time></article>`;
    assert.equal(run(html)[0].title, "Short");
    assert.equal(run(html, { titleSelectorHint: "aria-label" })[0].title, "The full accessible title");
    assert.equal(run(html, { titleSelectorHint: "img alt" })[0].title, "Cover art");
  });

  it("the date is found wherever it sits in the card: before, after, inside, as text or as an attribute", () => {
    const html = `<div class="grid">
      <div class="card"><header><time>Nov 16, 2026</time></header><h3><a href="/news/before">Date before the link</a></h3></div>
      <div class="card"><a href="/news/after">Date after the link</a><div><relative-time datetime="2026-11-15T09:57:27Z">yesterday</relative-time></div></div>
      <div class="card"><a href="/news/inside"><h3>Date inside the link</h3><p class="meta">November 14, 2026</p></a></div>
      <div class="card"><a href="/news/field">Date in a field</a><p fs-list-field="date">Oct 26, 2026</p><p>Some unrelated paragraph mentioning nothing.</p></div>
      <div class="card"><a href="/news/attr"><h3>Date in an attribute</h3><span title="Updated November 12, 2026">1w</span></a></div>
      <div class="card"><a href="/news/dotted">Abbreviated month with a dot</a><em>Dec. 3, 2025</em></div></div>`;
    assert.deepEqual(
      run(html).map((c) => [c.link.split("/").pop(), c.publishedRaw]),
      [["before", "2026-11-16"], ["after", "2026-11-15T09:57:27Z"], ["inside", "2026-11-14"], ["attr", "2026-11-12"], ["field", "2026-10-26"], ["dotted", "2025-12-03"]],
    );
  });

  it("a date belongs to its own card: the next card's <time> is never borrowed", () => {
    const html = `<section>
      <article><h3><a href="/news/undated-one">No date on this card</a></h3></article>
      <article><time>Nov 2, 2026</time><h3><a href="/news/dated-two">Dated card</a></h3></article>
      <article><time>Nov 1, 2026</time><h3><a href="/news/dated-three">Another dated card</a></h3></article></section>`;
    const all = extractHtmlLinks(html, { ...cfg, dateHint: "time" }, page, { nowMs: NOW, maxItems: ALL });
    // 2 of 3 are dated -> a dated listing -> the undated link is dropped rather than given a neighbour's date.
    assert.deepEqual(all.cards.map((c) => [c.title, c.publishedRaw]), [["Dated card", "2026-11-02"], ["Another dated card", "2026-11-01"]]);
    assert.equal(all.dropped, 1);
  });

  it("duplicate anchors of one post (image link, title link, responsive variants) make ONE card", () => {
    const card = (slug: string, title: string, date: string): string => `<div class="variant"><time datetime="${date}"></time><a href="./news/${slug}"><img alt=""></a><a href="./news/${slug}"><h4>${title}</h4></a></div>`;
    const html = `<div>${["desktop", "tablet", "phone"].map(() => `<div>${card("a-1.5", "Model A 1.5", "2026-11-03")}${card("b", "Model B", "2026-11-02")}</div>`).join("")}</div>`;
    const cards = extractHtmlLinks(html, { base: "https://lab.example.com/", linkPattern: "^(?:\\./|/)news/[a-z0-9._-]+$", dateHint: "time" }, "https://lab.example.com/", { nowMs: NOW }).cards;
    assert.deepEqual(cards.map((c) => [c.title, c.link, c.publishedRaw]), [["Model A 1.5", "https://lab.example.com/news/a-1.5", "2026-11-03"], ["Model B", "https://lab.example.com/news/b", "2026-11-02"]]);
  });

  it("sorts newest first BEFORE applying the cap", () => {
    const html = `<ul>${[1, 2, 3, 4, 5, 6].map((d) => `<li><a href="/news/post-${d}"><h3>Post ${d}</h3></a><time datetime="2026-11-0${d}"></time></li>`).join("")}</ul>`;
    const cards = extractHtmlLinks(html, cfg, page, { nowMs: NOW, maxItems: 2 }).cards;
    assert.deepEqual(cards.map((c) => c.title), ["Post 6", "Post 5"]);
  });

  it("hostile markup: scripts are not parsed, javascript: links never match, nothing throws", () => {
    const html = `<script>document.write('<a href="/news/from-script"><h3>Injected</h3></a>')</script>
      <a href="javascript:alert(1)//news/x"><h3>JS</h3></a><a href="/news/ok"><h3>Fine &amp; <b>bold</b> &#x110000;</h3></a><a href="/news/unclosed"><h3>Unclosed`;
    const cards = run(html, { dateHint: "none" });
    assert.deepEqual(cards.map((c) => c.link), ["https://lab.example.com/news/ok", "https://lab.example.com/news/unclosed"]);
    assert.equal(cards[0].title, "Fine &amp; bold &#x110000;", "entities stay raw for normalize");
    for (const junk of ["", "<", "<a href=", "<a href='/news/x'", "\u0000<<<>>>", "<li><li><li><p><p>".repeat(2000)]) assert.equal(run(junk).length, 0);
  });

  it("an unanchored linkPattern is matched against the whole path", () => {
    assert.ok(compileLinkPattern("/news/[a-z0-9-]+").test("/news/a-post"));
    assert.ok(compileLinkPattern("/news/[a-z0-9-]+").test("/news/a-post/"));
    assert.ok(!compileLinkPattern("/news/[a-z0-9-]+").test("/news/a-post/comments"));
    assert.ok(!compileLinkPattern("/news/[a-z0-9-]+").test("/de/news/a-post"));
    assert.ok(compileLinkPattern("^/post/[a-z]+$").test("/post/abc"));
  });
});

describe("findDateInText", () => {
  it("normalises textual dates to date-only stamps and passes ISO through", () => {
    assert.equal(findDateInText("Nov 16, 2026"), "2026-11-16");
    assert.equal(findDateInText("Posted on November 5th, 2026 by staff"), "2026-11-05");
    assert.equal(findDateInText("Sept. 3, 2025"), "2025-09-03");
    assert.equal(findDateInText("16 November 2026"), "2026-11-16");
    assert.equal(findDateInText("October 01, 2026"), "2026-10-01");
    assert.equal(findDateInText("2026-11-09T17:00:00.000Z"), "2026-11-09T17:00:00.000Z");
    assert.equal(findDateInText("2026-11-05"), "2026-11-05");
  });

  it("rejects non-dates", () => {
    for (const s of ["", null, "May the best model win", "Version 12, 2026 edition", "March 45, 2026", "Nov 16, 1066", "3 days ago", "1w"]) assert.equal(findDateInText(s), null, String(s));
  });
});

describe("html tree builder", () => {
  it("closes implied <li> / <p> and tolerates stray end tags", () => {
    const root = parseHtml("<ul><li>one<li>two<p>para<p>graph</li></div></ul><p>after");
    const lis = findAll(root, (el) => el.tag === "li");
    assert.deepEqual(lis.map((li) => textOf(li)), ["one", "two para graph"]);
    assert.equal(lis[0].parent?.tag, "ul");
    assert.equal(lis[1].parent?.tag, "ul");
    assert.equal(findAll(root, (el) => el.tag === "p").length, 3);
  });

  it("reads attributes in any order and quoting; skips script / style content", () => {
    const root = parseHtml(`<div CLASS="a b" data-x='1' hidden id=main><style>a{b:"</div>"}</style><script>if (a < b) { "</p>" }</script><span>text</span><img src="x.png" alt="pic"/><br>tail</div>`);
    const div = findAll(root, (el) => el.tag === "div")[0];
    assert.deepEqual(div.attrs, { class: "a b", "data-x": "1", hidden: "", id: "main" });
    assert.equal(textOf(div), "text tail");
    assert.equal(findAll(root, (el) => el.tag === "img")[0].attrs.alt, "pic");
  });
});

describe("extractJsonApi", () => {
  const cfg: JsonApiConfig = { itemsPath: "data.items", titleField: "name", urlTemplate: "https://hub.example.com/{owner.login}/{name}", dateField: "created", summaryField: "desc" };
  const api = "https://hub.example.com/api/models";

  it("reads dot paths, URL templates, epoch dates and summaries", () => {
    const body = JSON.stringify({
      data: {
        items: [
          { name: "alpha", owner: { login: "org" }, created: 1794000000, desc: "First" },
          { name: "beta", owner: { login: "org" }, created: 1795000000000 },
          { name: "gamma", owner: { login: "org" }, created: "2026-11-19T00:00:00Z" },
          { name: "", owner: { login: "org" } },
          { name: "alpha", owner: { login: "org" }, created: 1 },
          "junk",
          null,
        ],
      },
    });
    const r = extractJsonApi(body, cfg, api, { nowMs: NOW, maxItems: 10 });
    assert.ok(r.ok);
    assert.deepEqual(
      r.cards.map((c) => [c.title, c.link, c.publishedRaw, c.summaryHtml]),
      [
        ["gamma", "https://hub.example.com/org/gamma", "2026-11-19T00:00:00Z", null],
        ["beta", "https://hub.example.com/org/beta", new Date(1795000000000).toISOString(), null],
        ["alpha", "https://hub.example.com/org/alpha", new Date(1794000000000).toISOString(), "First"],
      ],
    );
    assert.equal(r.skipped, 4);
  });

  it("urlField (absolute or relative) works without a template; root arrays use itemsPath ''", () => {
    const r = extractJsonApi(JSON.stringify([{ t: "A", u: "/a" }, { t: "B", u: "https://other.example.org/b" }, { t: "C", u: "javascript:alert(1)" }]), { itemsPath: "", titleField: "t", urlField: "u" }, api, { nowMs: NOW });
    assert.ok(r.ok);
    assert.deepEqual(r.cards.map((c) => c.link), ["https://hub.example.com/a", "https://other.example.org/b"]);
    assert.ok(r.cards.every((c) => c.publishedRaw === null));
  });

  it("urlField first, urlTemplate as the fallback for an empty field (HN text posts link to their thread)", () => {
    const hn = { itemsPath: "hits", titleField: "title", urlField: "url", urlTemplate: "https://news.ycombinator.com/item?id={objectID}", dateField: "created_at" };
    const body = JSON.stringify({
      hits: [
        { title: "Qwen4-Max is now in Preview", url: "https://example.org/qwen4", objectID: "101", created_at: "2026-11-16T10:00:00Z" },
        { title: "Ask HN: What hardware are you using to run local LLMs?", url: null, objectID: "102", created_at: "2026-11-15T10:00:00Z" },
        { title: "Show HN: text post with an empty url", url: "", objectID: 103, created_at: "2026-11-14T10:00:00Z" },
        { title: "No url and no id: never a half-built link", url: null, created_at: "2026-11-13T10:00:00Z" },
      ],
    });
    const r = extractJsonApi(body, hn, "https://hn.algolia.com/api/v1/search_by_date?query=x", { nowMs: NOW, maxItems: 10 });
    assert.ok(r.ok);
    assert.deepEqual(r.cards.map((c) => c.link), ["https://example.org/qwen4", "https://news.ycombinator.com/item?id=102", "https://news.ycombinator.com/item?id=103"]);
    assert.equal(r.skipped, 1);
    // Template only (Hugging Face): a missing placeholder value skips the item.
    const hf = extractJsonApi(JSON.stringify([{ id: "org/model", name: "A" }, { name: "B" }]), { itemsPath: "", titleField: "name", urlTemplate: "https://huggingface.co/{id}" }, api, { nowMs: NOW });
    assert.ok(hf.ok);
    assert.deepEqual(hf.cards.map((c) => c.link), ["https://huggingface.co/org/model"]);
  });

  it("reports parse and empty failures instead of throwing", () => {
    assert.deepEqual(extractJsonApi("<html>", cfg, api, { nowMs: NOW }).ok, false);
    const wrongPath = extractJsonApi("{}", cfg, api, { nowMs: NOW });
    assert.ok(!wrongPath.ok && wrongPath.error === "parse");
    const empty = extractJsonApi('{"data":{"items":[]}}', cfg, api, { nowMs: NOW });
    assert.ok(!empty.ok && empty.error === "empty");
  });
});
