import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFeedFixture } from "../../../test/helpers/fixtures";
import { parseFeed } from "./feedParser";
import { GN_DEFAULTS, parseBatchExecute, resolveGoogleNewsBatch, resolveGoogleNewsUrl } from "./googleNews";
import type { HttpDeps } from "./http";
import { respond, scriptedFetch, type Handler } from "./testing/fakeNet";
import { createVirtualClock } from "./testing/virtualClock";
import { createDeadline } from "./timers";
import type { RawItem } from "../types";
import { googleNewsArticleId, isGoogleNewsUrl, isHnDiscussionUrl, stripGoogleNewsTitle, stripTechmemeTitle, unwrapSync, unwrapTechmeme, urlFromHnDescription, urlFromQueryParam, wrapperKey } from "./unwrap";

describe("unwrap (ported from V1 scripts/lib/unwrapUrl.test.ts)", () => {
  it("detects Google News and HN discussion URLs", () => {
    assert.equal(isGoogleNewsUrl("https://news.google.com/rss/articles/CBMiabc"), true);
    assert.equal(isGoogleNewsUrl("https://www.reuters.com/world/x"), false);
    assert.equal(isHnDiscussionUrl("https://news.ycombinator.com/item?id=123"), true);
    assert.equal(isHnDiscussionUrl("https://example.com/item?id=123"), false);
    assert.equal(isGoogleNewsUrl("not a url"), false);
  });

  it("takes a url query param off a Google wrapper - and only off Google hosts", () => {
    const wrapped = "https://news.google.com/rss/search?q=AI&url=https://www.reuters.com/world/ai-story";
    assert.equal(urlFromQueryParam(wrapped), "https://www.reuters.com/world/ai-story");
    assert.equal(unwrapSync(wrapped), "https://www.reuters.com/world/ai-story");
    assert.equal(urlFromQueryParam("https://www.google.com/url?sa=t&url=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1"), "https://example.org/a?b=1");
    // V1 rewrote ANY link that carried ?url= (an open redirect into the headline list).
    const login = "https://shop.example.com/login?url=https://evil.example.net/phish";
    assert.equal(urlFromQueryParam(login), null);
    assert.equal(unwrapSync(login), login);
    assert.equal(urlFromQueryParam("https://news.google.com/x?url=javascript:alert(1)"), null);
    assert.equal(urlFromQueryParam("https://news.google.com/x?url=https://news.google.com/rss/articles/CBMi1"), null);
  });

  it("extracts Article URL from an hnrss description, any attribute order or quote style", () => {
    const desc = '<p>Article URL: <a href="https://openai.com/blog/gpt">https://openai.com/blog/gpt</a></p><p>Comments URL: <a href="https://news.ycombinator.com/item?id=1">1</a></p>';
    assert.equal(urlFromHnDescription(desc), "https://openai.com/blog/gpt");
    assert.equal(unwrapSync("https://news.ycombinator.com/item?id=1", { description: desc }), "https://openai.com/blog/gpt");
    assert.equal(urlFromHnDescription("Article URL: <a rel=\"nofollow\" href='https://a.example.com/x'>x</a>"), "https://a.example.com/x");
    assert.equal(urlFromHnDescription("Article URL: https://a.example.com/plain. Comments URL: ..."), "https://a.example.com/plain");
    assert.equal(urlFromHnDescription('Article URL: <a href="javascript:alert(1)">x</a>'), null);
    assert.equal(urlFromHnDescription(null), null);
  });

  it("a text post (Article URL is the HN thread itself) keeps its HN link", () => {
    const thread = "https://news.ycombinator.com/item?id=42";
    assert.equal(unwrapSync(thread, { description: `<p>Article URL: <a href="${thread}">${thread}</a></p>` }), thread);
    assert.equal(unwrapSync("https://example.com/post", { description: "Article URL: https://other.example.com/" }), "https://example.com/post");
  });

  it("strips Google News publisher suffixes only", () => {
    assert.equal(stripGoogleNewsTitle("OpenAI unveils ChatGPT for teens - Reuters", "Reuters"), "OpenAI unveils ChatGPT for teens");
    assert.equal(stripGoogleNewsTitle("GPT-5 - what we know", "Reuters"), "GPT-5 - what we know");
    assert.equal(stripGoogleNewsTitle("Short - Reuters", "Reuters"), "Short - Reuters");
    assert.equal(stripGoogleNewsTitle("No publisher known - Reuters", null), "No publisher known - Reuters");
  });

  it("unwrapSync does not canonicalise (normalize owns that)", () => {
    const raw = "https://www.reuters.com/world/x/?utm_source=gn&oc=5#frag";
    assert.equal(unwrapSync(raw), raw);
  });

  it("wrapper cache keys ignore the tracking query", () => {
    assert.equal(googleNewsArticleId("https://news.google.com/rss/articles/CBMiAbC_123?oc=5"), "CBMiAbC_123");
    assert.equal(googleNewsArticleId("https://news.google.com/rss/search?q=x"), null);
    assert.equal(wrapperKey("https://news.google.com/rss/articles/CBMiAbC_123?oc=5&hl=en-US"), "https://news.google.com/rss/articles/CBMiAbC_123");
    assert.equal(wrapperKey("https://example.com/a?b=1"), "https://example.com/a?b=1");
  });
});

const WRAP = (id: string): string => `https://news.google.com/rss/articles/${id}?oc=5`;
const BATCH = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const interstitial = '<html><body><c-wiz><div jscontroller="x" data-n-a-sg="SIG123" data-n-a-ts="1795000000"></div></c-wiz></body></html>';
const rpcAnswer = (target: string): string => `)]}'\n\n123\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", target, 1]), null, null, null, "generic"], ["di", 20]])}`;

function gnDeps(handler: Handler): { deps: HttpDeps; net: ReturnType<typeof scriptedFetch>; clock: ReturnType<typeof createVirtualClock> } {
  const clock = createVirtualClock();
  const net = scriptedFetch(handler);
  return { clock, net, deps: { fetch: net.fetch, timers: clock, userAgent: "ai-drudge-test" } };
}

describe("Google News resolver (batchexecute)", () => {
  it("parses a batchexecute envelope and rejects junk", () => {
    assert.equal(parseBatchExecute(rpcAnswer("https://www.reuters.com/a")), "https://www.reuters.com/a");
    assert.equal(parseBatchExecute(")]}'\n\n[[\"wrb.fr\",\"Other\",\"[]\"]]"), null);
    assert.equal(parseBatchExecute("<html>consent</html>"), null);
    assert.equal(parseBatchExecute(""), null);
  });

  it("resolves a wrapper with two requests: interstitial, then the Fbv4je RPC", async () => {
    const { deps, net, clock } = gnDeps((req) => (req.url === BATCH ? rpcAnswer("https://www.reuters.com/technology/ai-story-2026-11-19/") : interstitial));
    const target = await clock.settle(resolveGoogleNewsUrl(WRAP("CBMiOne"), deps));
    assert.equal(target, "https://www.reuters.com/technology/ai-story-2026-11-19/");
    assert.deepEqual(net.requests.map((r) => [r.method, r.url]), [["GET", WRAP("CBMiOne")], ["POST", BATCH]]);
    const body = decodeURIComponent(net.requests[1].body ?? "");
    assert.ok(body.includes("Fbv4je") && body.includes("CBMiOne") && body.includes("SIG123") && body.includes("1795000000"));
    assert.match(net.requests[0].headers["user-agent"], /Mozilla/);
  });

  it("returns null (never throws) when any step fails or the target is not an http URL", async () => {
    const cases: Handler[] = [
      () => respond("blocked", 429),
      () => "<html>no signature here</html>",
      (req) => (req.url === BATCH ? respond("err", 500) : interstitial),
      (req) => (req.url === BATCH ? rpcAnswer("javascript:alert(1)") : interstitial),
      (req) => (req.url === BATCH ? rpcAnswer(WRAP("CBMiLoop")) : interstitial),
      () => new TypeError("fetch failed"),
      () => "hang",
    ];
    for (const handler of cases) {
      const { deps, clock } = gnDeps(handler);
      assert.equal(await clock.settle(resolveGoogleNewsUrl(WRAP("CBMiX"), deps)), null);
    }
    const { deps, net, clock } = gnDeps(() => "unused");
    assert.equal(await clock.settle(resolveGoogleNewsUrl("https://example.com/not-google", deps)), null);
    assert.equal(net.requests.length, 0);
  });

  it("batch: cache hits cost no request; only unseen ids are resolved, bounded per run", async () => {
    const { deps, net, clock } = gnDeps((req) => {
      if (req.url !== BATCH) return interstitial;
      const id = /CBMi\w+/.exec(decodeURIComponent(req.body ?? ""))?.[0] ?? "";
      return rpcAnswer(`https://outlet.example.com/${id}`);
    });
    const cache = { [wrapperKey(WRAP("CBMiCached"))]: "https://cached.example.com/story" };
    const urls = [WRAP("CBMiCached"), WRAP("CBMiNew1"), WRAP("CBMiNew2"), WRAP("CBMiNew3"), WRAP("CBMiNew1"), "https://example.com/plain"];
    const r = await clock.settle(resolveGoogleNewsBatch(urls, cache, deps, { maxNew: 2 }));
    assert.deepEqual(r.resolved, {
      "https://news.google.com/rss/articles/CBMiCached": "https://cached.example.com/story",
      "https://news.google.com/rss/articles/CBMiNew1": "https://outlet.example.com/CBMiNew1",
      "https://news.google.com/rss/articles/CBMiNew2": "https://outlet.example.com/CBMiNew2",
    });
    assert.deepEqual([r.cacheHits, r.fetched, r.unresolved], [1, 2, 1]);
    assert.equal(net.requests.length, 4, "2 new ids x 2 requests; nothing for the cached id or the id over the bound");
    // The ceiling only bounds a runaway list; the deadline is the working limit (PF-9: a cold start of
    // ~210 wrappers must clear in one build, not four).
    assert.ok(GN_DEFAULTS.maxNewPerRun >= 220 && GN_DEFAULTS.maxNewPerRun <= 300);
  });

  it("batch: a cold start (213 uncached wrappers) is resolved in ONE run when the resolver answers", async () => {
    const { deps, net, clock } = gnDeps((req) => {
      if (req.url !== BATCH) return interstitial;
      const id = /CBMi\w+/.exec(decodeURIComponent(req.body ?? ""))?.[0] ?? "";
      return rpcAnswer(`https://outlet.example.com/${id}`);
    });
    const urls = Array.from({ length: 213 }, (_, i) => WRAP(`CBMiCold${i}`));
    const r = await clock.settle(resolveGoogleNewsBatch(urls, {}, deps));
    assert.deepEqual([r.cacheHits, r.fetched, r.unresolved], [0, 213, 0]);
    assert.equal(net.requests.length, 426);
  });

  it("batch: stops at the deadline", async () => {
    const { deps, net, clock } = gnDeps(() => "hang");
    const deadline = createDeadline(clock, 3_000);
    const urls = Array.from({ length: 20 }, (_, i) => WRAP(`CBMiHang${i}`));
    const r = await clock.settle(resolveGoogleNewsBatch(urls, {}, { ...deps, deadline }));
    assert.equal(r.fetched, 0);
    assert.equal(r.unresolved, 20);
    assert.equal(clock.now(), 3_000);
    assert.equal(net.requests.length, GN_DEFAULTS.concurrency, "only the first wave was in flight");
  });

  it("the real fixture: 29 wrapper links, all with a cache key", () => {
    const r = parseFeed(readFeedFixture("google-news-sec-finra.xml"), { feedUrl: "https://news.google.com/rss/search?q=x" });
    assert.ok(r.ok);
    const keys = new Set(r.entries.map((e) => wrapperKey(e.link)));
    assert.equal(keys.size, 29);
    assert.ok([...keys].every((k) => /^https:\/\/news\.google\.com\/rss\/articles\/CB[\w-]+$/.test(k)));
  });
});

describe("Techmeme (PF-7): real items of 2026-11-19", () => {
  const permalink = (n: number): string => `https://www.techmeme.com/261119/p${n}#a261119p${n}`;
  const desc = (n: number, article: string, byline: string, headline: string): string =>
    `<A HREF="${article}"><IMG VSPACE="4" HSPACE="4" BORDER="0" ALIGN="RIGHT" SRC="http://www.techmeme.com/261119/i${n}.jpg"></A>\n<P><A HREF="${permalink(n)}" TITLE="Techmeme permalink"><IMG WIDTH=11 HEIGHT=12 SRC="http://www.techmeme.com/img/pml.png" STYLE="border:none;padding:0;margin:0;"></A> ${byline}:<BR>\n<SPAN STYLE="font-size:1.3em;"><B><A HREF="${article}">${headline}</A></B></SPAN>&nbsp; &mdash;&nbsp; Summary text &hellip; </P>`;
  const item = (n: number, title: string, tail: string, article: string, byline: string): RawItem => ({ sourceId: "techmeme", title: `${title} ${tail}`, link: permalink(n), publishedRaw: "Thu, 19 Nov 2026 19:50:59 -0500", summaryHtml: desc(n, article, byline, title) });

  const iconiq = "Source: Iconiq invested more than $6B in Anthropic; its estimated 1.8% stake was worth ~$31.8B at Thursday's close, a 430%+ return on investment";
  const forbes = "https://www.forbes.com/sites/richardnieva/2026/11/19/the-big-vc-winners-in-anthropics-ipo/";
  const nvidia = "Sources: Nvidia is in advanced talks to acquire diffusion LLM developer Inception for $500M+ plus earnouts; talks began before Jensen Huang's resignation";
  const info = "https://www.theinformation.com/articles/nvidia-nears-acquisition-diffusion-ai-developer-500-million";
  const ubisoft = "Ubisoft reports Q2 net bookings down 21% YoY to €388.9M, above €350.7M est., driven by Assassin's Creed Black Flag Resynced, as it overhauls its operations";
  const wsj = "https://www.wsj.com/business/earnings/ubisoft-logs-strong-bookings-as-players-welcome-assassins-creed-remake-372081c1?st=LvUnbR&reflink=desktopwebshare_permalink";

  it("author and outlet: (Richard Nieva/Forbes)", () => {
    const raw = item(56, iconiq, "(Richard Nieva/Forbes)", forbes, 'Richard Nieva / <A HREF="http://www.forbes.com/">Forbes</A>');
    const out = unwrapTechmeme(raw);
    assert.deepEqual(out, { ...raw, title: iconiq, link: forbes, itemPublisher: "Forbes", itemPublisherUrl: "http://www.forbes.com/", guid: permalink(56), resolvedFrom: permalink(56) });
    assert.equal(raw.link, permalink(56), "the input is not mutated");
  });

  it("outlet only: (The Information) - no slash in the tail", () => {
    const out = unwrapTechmeme(item(54, nvidia, "(The Information)", info, '<A HREF="https://www.theinformation.com/">The Information</A>'));
    assert.deepEqual([out.title, out.link, out.itemPublisher, out.itemPublisherUrl, out.resolvedFrom], [nvidia, info, "The Information", "https://www.theinformation.com/", permalink(54)]);
  });

  it("a multi-word outlet and an article URL with a query string (&amp; in the attribute is decoded)", () => {
    const raw = item(44, ubisoft, "(Mauro Orru/Wall Street Journal)", wsj.replace("&", "&amp;"), 'Mauro Orru / <A HREF="https://www.wsj.com/">Wall Street Journal</A>');
    const out = unwrapTechmeme(raw);
    assert.deepEqual([out.title, out.link, out.itemPublisher], [ubisoft, wsj, "Wall Street Journal"]);
  });

  it("is idempotent, and a no-op for every other source", () => {
    const once = unwrapTechmeme(item(56, iconiq, "(Richard Nieva/Forbes)", forbes, 'Richard Nieva / <A HREF="http://www.forbes.com/">Forbes</A>'));
    assert.equal(unwrapTechmeme(once), once);
    const other: RawItem = { sourceId: "wired-ai", title: "A headline (Wired)", link: "https://www.wired.com/story/x/", publishedRaw: null, summaryHtml: desc(1, forbes, '<A HREF="https://www.wired.com/">Wired</A>', "x") };
    assert.equal(unwrapTechmeme(other), other);
    const noSummary: RawItem = { sourceId: "techmeme", title: "T (Axios)", link: permalink(53), publishedRaw: null, summaryHtml: null };
    assert.equal(unwrapTechmeme(noSummary), noSummary);
  });

  it("keeps the permalink when the headline anchor is missing, not http(s) or on techmeme.com - the outlet is still read", () => {
    const base = item(53, "Sources: National Cyber Director Sean Cairncross is leaving now", "(Axios)", "https://www.axios.com/2026/11/19/x", '<A HREF="https://www.axios.com/">Axios</A>');
    for (const bad of ["javascript:alert(1)", permalink(53), "/relative/path"]) {
      const raw = { ...base, summaryHtml: (base.summaryHtml ?? "").replace(/<B><A HREF="[^"]+">/, `<B><A HREF="${bad}">`) };
      const out = unwrapTechmeme(raw);
      assert.deepEqual([out.link, out.resolvedFrom, out.itemPublisher, out.title], [permalink(53), undefined, "Axios", "Sources: National Cyber Director Sean Cairncross is leaving now"], bad);
      assert.deepEqual(unwrapTechmeme(out), out, "still idempotent");
    }
    const noMarkup = { ...base, summaryHtml: "Plain text description without anchors." };
    assert.equal(unwrapTechmeme(noMarkup), noMarkup);
  });

  it("strips the tail only when it names the parsed outlet", () => {
    assert.equal(stripTechmemeTitle("OpenAI ships GPT-6.2 Astra (Kyle Wiggers/TechCrunch)", "TechCrunch"), "OpenAI ships GPT-6.2 Astra");
    assert.equal(stripTechmemeTitle("OpenAI ships GPT-6.2 Astra (TechCrunch)", "TechCrunch"), "OpenAI ships GPT-6.2 Astra");
    assert.equal(stripTechmemeTitle("Report on chips (Tom&#39;s Hardware)", "Tom's Hardware"), "Report on chips");
    assert.equal(stripTechmemeTitle("Nvidia buys Inception (the deal, explained)", "The Information"), "Nvidia buys Inception (the deal, explained)");
    assert.equal(stripTechmemeTitle("Apple plans an AI agent (codenamed Linwood/Glenwood)", "Bloomberg"), "Apple plans an AI agent (codenamed Linwood/Glenwood)");
    assert.equal(stripTechmemeTitle("A title with no tail", "Forbes"), "A title with no tail");
    assert.equal(stripTechmemeTitle("(Forbes)", "Forbes"), "(Forbes)", "never strips a title down to nothing");
    assert.equal(stripTechmemeTitle("Something happened (Forbes)", ""), "Something happened (Forbes)");
  });
});
