import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTitleTemplate, cleanSummary, cleanText, cleanTitle, decodeEntities, nameTokens, sameOutlet, sanitizeText, splitDashOutlet, splitOutletTail, stripHtml, truncateAtWord } from "./text";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("decodeEntities", () => {
  const cases: [string, string, string][] = [
    ["basic XML", "Tom &amp; Jerry &lt;3 &quot;cats&quot; &apos;n&apos; dogs &gt; mice", "Tom & Jerry <3 \"cats\" 'n' dogs > mice"],
    ["named Latin-1 (V1 left these raw)", "Caf&eacute; &middot; &euro;388.9M &pound;5 &copy; &times; &divide; &yuml;", "Café · €388.9M £5 © × ÷ ÿ"],
    ["case-sensitive names", "&Eacute;cole &eacute;cole &Uuml;ber &szlig;", "École école Über ß"],
    ["typography", "&ldquo;Hi&rdquo; &lsquo;x&rsquo; a&ndash;b c&mdash;d &hellip; &bull; &trade; &rarr;", "“Hi” ‘x’ a–b c—d … • ™ →"],
    ["Greek", "&alpha;&beta;&Sigma;&omega;&Omega;", "αβΣωΩ"],
    ["decimal + hex", "It&#8217;s &#x2019;quoted&#X2019; &#128512;", "It’s ’quoted’ 😀"],
    ["nbsp becomes a real no-break space", "Claude&nbsp;Opus&nbsp;5", "Claude Opus 5"],
    ["double-encoded", "AT&amp;amp;T and it&amp;#8217;s &amp;eacute;", "AT&T and it’s é"],
    ["triple-encoded stops after three passes", "&amp;amp;amp;amp;", "&amp;"],
    ["Windows-1252 C1 references", "it&#146;s &#147;x&#148; &#150; &#133;", "it’s “x” – …"],
    ["upper-case legacy names", "A &AMP; B &LT; C", "A & B < C"],
    ["unknown names stay as written", "&notanentity; R&D; AT&T", "&notanentity; R&D; AT&T"],
    ["no semicolon is not an entity", "fish &amp chips", "fish &amp chips"],
  ];
  for (const [name, input, expected] of cases) it(name, () => assert.equal(decodeEntities(input), expected));

  it("out-of-range, surrogate and control references are removed, never thrown (V1: RangeError failed the whole build)", () => {
    for (const bad of ["&#99999999;", "&#99999999999;", "&#x110000;", "&#1114112;", "&#xD800;", "&#xDFFF;", "&#0;", "&#8;", "&#x1F;", "&#xFFFE;", "&#xFFFF;", "&#129;"]) {
      assert.doesNotThrow(() => decodeEntities(`Emoji gone wrong ${bad} in title`), bad);
      assert.equal(decodeEntities(`a${bad}b`), "ab", bad);
    }
    assert.equal(decodeEntities("a&#9;b&#10;c&#13;d"), "a b c d");
  });

  it("empty input", () => {
    assert.equal(decodeEntities(null), "");
    assert.equal(decodeEntities(undefined), "");
    assert.equal(decodeEntities(""), "");
  });
});

describe("stripHtml / cleanText", () => {
  it("removes <style> and <script> CONTENT (BAIR summaries were raw CSS in V1)", () => {
    const html = '<style>.abbel-fig { display: block; text-align: center; }</style><p>Hello</p><script type="text/javascript">var x = 1;</script> world';
    assert.equal(cleanText(html), "Hello world");
  });

  it("removes svg, noscript, template, iframe, pre and figcaption blocks", () => {
    const html = "A<svg><path d='M0 0'/><text>icon</text></svg> B<noscript>enable js</noscript> C<pre>cosign verify \\ --certificate-identity x</pre> D<figcaption>Figure 1: caption</figcaption> E";
    assert.equal(cleanText(html), "A B C D E");
  });

  it("a block cut off mid-feed takes everything after it", () => {
    assert.equal(cleanText("Intro text <style>.a { color: red; } .b {"), "Intro text");
  });

  it("unwraps CDATA and drops comments", () => {
    assert.equal(cleanText("<![CDATA[<p>Hello <b>there</b></p>]]><!-- tracking -->"), "Hello there");
  });

  it("escaped markup is stripped after decoding", () => {
    assert.equal(cleanText("&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;"), "Fish & chips");
  });

  it("comparisons survive: only tag-SHAPED runs are markup", () => {
    assert.equal(cleanText("Latency < 100ms and accuracy > 95% on new benchmark"), "Latency < 100ms and accuracy > 95% on new benchmark");
    assert.equal(cleanText("I <3 this & that"), "I <3 this & that");
  });

  it("collapses whitespace incl. no-break spaces and newlines", () => {
    assert.equal(cleanText("  a\n\n\tb&nbsp;&nbsp;c d  "), "a b c d");
  });

  it("stripHtml turns tags into spaces so words do not fuse", () => {
    assert.equal(stripHtml("one<br>two<p>three</p>").replace(/\s+/g, " ").trim(), "one two three");
  });
});

describe("sanitizeText", () => {
  it("removes zero-width and bidi control characters", () => {
    assert.equal(sanitizeText("The E.U.’s AI Drive Undermines Its ​Own Chip Strategy"), "The E.U.’s AI Drive Undermines Its Own Chip Strategy");
    assert.equal(sanitizeText("a⁠b﻿c­d‎e‮f⁦g"), "abcdefg");
  });

  it("keeps the joiners inside emoji sequences, drops stray ones", () => {
    assert.equal(sanitizeText("dev \u{1F468}‍\u{1F4BB} tools"), "dev \u{1F468}‍\u{1F4BB} tools");
    assert.equal(sanitizeText("plain‍ text‌"), "plain text");
  });

  it("removes control characters and lone surrogates, normalises to NFC", () => {
    assert.equal(sanitizeText("a\u0000b\u0008c\u007Fd"), "a b c d");
    assert.equal(sanitizeText("bad \uD83D end"), "bad end");
    assert.equal(sanitizeText("Café"), "Café");
  });
});

describe("truncateAtWord", () => {
  it("leaves text within the limit untouched", () => {
    assert.equal(truncateAtWord("short text", 320), "short text");
    assert.equal(truncateAtWord("x".repeat(320), 320), "x".repeat(320));
  });

  it("cuts at a word boundary and appends an ellipsis", () => {
    const text = "word ".repeat(100).trim();
    const out = truncateAtWord(text, 52);
    assert.ok(out.length <= 52, String(out.length));
    assert.match(out, /^(?:word )+word…$/);
  });

  it("drops dangling punctuation before the ellipsis", () => {
    assert.equal(truncateAtWord("alpha beta, gamma delta epsilon", 14), "alpha beta…");
  });

  it("never ends in a lone surrogate (V1 crafted case 13: emoji at character 320)", () => {
    const text = `${"x".repeat(319)}\u{1F600} tail`;
    const out = truncateAtWord(text, 320);
    assert.ok(out.length <= 320);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.ok(out.endsWith("…"));
  });

  it("a single over-long token gets a hard cut", () => {
    const out = truncateAtWord(`start ${"y".repeat(400)}`, 50);
    assert.equal(out.length, 50);
    assert.ok(out.endsWith("…"));
  });
});

describe("cleanTitle", () => {
  const govai = { names: ["GovAI"], host: "governance.ai" };
  const cases: [string, string, Parameters<typeof cleanTitle>[1], string][] = [
    ["site suffix with pipe (GovAI Blog ~ GovAI)", "GovAI in Washington, DC | GovAI Blog", govai, "GovAI in Washington, DC"],
    ["site suffix matched by host label", "Why Healthcare AI Inventory Precedes Governance | Straiker", { names: ["Straiker STAR"], host: "straiker.ai" }, "Why Healthcare AI Inventory Precedes Governance"],
    ["dash + publisher (Google News form)", "Anthropic's blockbuster debut tests Wall Street's faith in AI boom - Reuters", { names: ["Reuters AI (Google News)", "Reuters"] }, "Anthropic's blockbuster debut tests Wall Street's faith in AI boom"],
    ["en dash and em dash", "OpenAI unveils X – Reuters", { names: ["Reuters"] }, "OpenAI unveils X"],
    ["em dash", "OpenAI unveils X — The Verge", { names: ["The Verge AI"] }, "OpenAI unveils X"],
    ["publisher's longer self-name", "Accelerating inference | NVIDIA Technical Blog", { names: ["NVIDIA Developer", "NVIDIA"] }, "Accelerating inference"],
    ["two trailing segments", "Headline of the day | Technology | The Guardian", { names: ["The Guardian"] }, "Headline of the day | Technology"],
    ["a dash that is part of the headline survives", "GPT-5 - what we know", { names: ["OpenAI News"] }, "GPT-5 - what we know"],
    ["someone else's name survives", "Mid-title pipe: TrueFoundry & Straiker | AI Gateway Security for Agents", { names: ["Straiker STAR"], host: "straiker.ai" }, "Mid-title pipe: TrueFoundry & Straiker | AI Gateway Security for Agents"],
    ["never strips down to nothing", "Short - Reuters", { names: ["Reuters"] }, "Short - Reuters"],
    ["bracketed source prefix", "[tl;dr sec] #355 - Cyber Chaos Monkey, Offsec Harness Index", { names: ["tl;dr sec"] }, "#355 - Cyber Chaos Monkey, Offsec Harness Index"],
    ["bracket that is not the source stays", "[AINews] Gemini 4 Neon: GDM's Opus/Sol Contender", { names: ["Latent Space"] }, "[AINews] Gemini 4 Neon: GDM's Opus/Sol Contender"],
    ["alias counts as the source", "[AINews] Gemini 4 Neon: GDM's Opus/Sol Contender", { names: ["Latent Space", "AINews"] }, "Gemini 4 Neon: GDM's Opus/Sol Contender"],
    ["duplicated source prefix", "Modular: Qualcomm Completes Acquisition of Modular", { names: ["Modular"] }, "Qualcomm Completes Acquisition of Modular"],
    ["prefix kept when the rest is not a headline", "Deep Learning Weekly: Issue 481", { names: ["Deep Learning Weekly"] }, "Deep Learning Weekly: Issue 481"],
    ["prefix kept before a lower-case continuation", "Ollama: all aboard open models", { names: ["Ollama Blog", "Ollama"] }, "Ollama: all aboard open models"],
    ["ALL-CAPS left alone", "BREAKING: EVERYTHING IS ON FIRE", { names: ["404 Media"] }, "BREAKING: EVERYTHING IS ON FIRE"],
    ["formatting tags and entities", "Why <em>Nature</em>&rsquo;s paper on H<sub>2</sub>O matters<br/>", {}, "Why Nature ’s paper on H 2 O matters"],
    ["unknown angle-bracket text survives (V1 ate it)", "Why the &lt;think&gt; token matters", {}, "Why the <think> token matters"],
    ["comparisons survive", "Latency &lt; 100ms and accuracy &gt; 95% on new benchmark", {}, "Latency < 100ms and accuracy > 95% on new benchmark"],
    ["double-escaped formatting tag", "A &amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt; claim", {}, "A bold claim"],
    ["zero-width space", "The E.U.’s AI Drive Undermines Its ​Own Chip Strategy", {}, "The E.U.’s AI Drive Undermines Its Own Chip Strategy"],
    // Review PF-8: Google News entries for comment / subscribe pages have no headline, only " - <site>".
    ["only a separator and the site name", "- The Kaitchup", { names: ["The Kaitchup"] }, ""],
    ["... also behind a platform suffix", "- Marcus on AI | Substack", { names: ["Marcus on AI | Substack", "Substack"] }, ""],
    ["... with any dash, and without a known name", "– The Kaitchup", {}, ""],
    ["a leading minus sign is not an orphan separator", "-5% in a day: what broke the AI trade", {}, "-5% in a day: what broke the AI trade"],
    // Review PF-11: text that merely STARTS with the outlet's name is a clause, not the site suffix.
    ["a headline after the pipe that starts with the outlet's name", "WSJ Op-Ed | CFTC’s New Rules for Crypto", { names: ["CFTC Speeches & Statements", "CFTC"], host: "cftc.gov" }, "WSJ Op-Ed | CFTC’s New Rules for Crypto"],
    ["a clause about the publisher after a dash", "Why it matters - Anthropic raises $81bn in IPO", { names: ["Anthropic News", "Anthropic"] }, "Why it matters - Anthropic raises $81bn in IPO"],
    ["a kicker before the headline", "Explained | Nvidia after Jensen Huang", { names: ["NVIDIA Blog", "NVIDIA"] }, "Explained | Nvidia after Jensen Huang"],
    ["the outlet plus ONE more word is still the outlet", "Securing agents | Microsoft Security Blog", { names: ["Microsoft"] }, "Securing agents"],
    // ... and on a link-host feed the article's host is a product, not a "Source: " label.
    ["link-host feed: the article host is not a source prefix", "LayerFS: A filesystem for AI coding agents", { names: ["HN: coding agent", "Hacker News"], host: "layerfs.dev", prefixNames: ["HN: coding agent", "Hacker News"] }, "LayerFS: A filesystem for AI coding agents"],
    ["link-host feed: the feed's own name still is", "Hacker News: A filesystem for AI coding agents", { names: ["Hacker News"], host: "layerfs.dev", prefixNames: ["Hacker News"] }, "A filesystem for AI coding agents"],
    ["link-host feed: the outlet suffix still leaves", "A filesystem for AI coding agents - LayerFS", { names: ["Hacker News"], host: "layerfs.dev", prefixNames: ["Hacker News"] }, "A filesystem for AI coding agents"],
    ["numeric titles are titles", "2027", {}, "2027"],
    ["a model listing's slug echo leaves (OpenRouter)", "Google: Gemini 4 Neon (google/gemini-4-neon)", {}, "Google: Gemini 4 Neon"],
    ["slug echo with a version", "Qwen: Qwen4 Max (qwen/qwen4-max)", {}, "Qwen: Qwen4 Max"],
    ["a repository the headline does not name stays", "Vision support lands in the server (ggml-org/llama.cpp)", {}, "Vision support lands in the server (ggml-org/llama.cpp)"],
    ["an ordinary closing parenthesis stays", "Anthropic prices its IPO (and why it matters)", {}, "Anthropic prices its IPO (and why it matters)"],
    ["whitespace only", "  \n\t ", {}, ""],
    ["markup only", "<br/><p></p>", {}, ""],
    // Final fix round: feed bookkeeping seen on the live river of 2026-11-20.
    ["SANS ISC day stamp", "Treat Your Honeypot Analysis Like Code: Git, Pull Requests and a Human Gate for AI &#x5b;Guest Diary&#x5d;, (Wed, Nov 18th)", {}, "Treat Your Honeypot Analysis Like Code: Git, Pull Requests and a Human Gate for AI [Guest Diary]"],
    ["day stamp without the comma, long month", "Java4Shell, NGINX2Shell and more (Thursday, November 5th)", {}, "Java4Shell, NGINX2Shell and more"],
    ["a parenthesis that is not a day stamp stays", "The internet needs a nap (and you do, too)", {}, "The internet needs a nap (and you do, too)"],
    ["a date inside the headline stays", "What changed (Wed, Nov 18th) and why it matters", {}, "What changed (Wed, Nov 18th) and why it matters"],
    ["commit feed pull-request number", "[Model] Add HY4 Flash and multimodal support (#68296)", {}, "[Model] Add HY4 Flash and multimodal support"],
    ["pull-request number after another parenthesis", "model:add Zaya1 8B (Zyphra) (#32071)", {}, "model:add Zaya1 8B (Zyphra)"],
    ["pull-request number the feed cut short", "[Model] Add NemotronLabsDiffusion support with tri-mode inference (#5…", {}, "[Model] Add NemotronLabsDiffusion support with tri-mode inference"],
    ["an issue number of a column stays", "The AI Paper Trail (#8)", {}, "The AI Paper Trail (#8)"],
    ["... and a three-digit one", "Import AI (#431)", {}, "Import AI (#431)"],
    ["Tenable revision marker", "[R1] Security Center Version 6.10.0 Fixes Multiple Vulnerabilities", {}, "Security Center Version 6.10.0 Fixes Multiple Vulnerabilities"],
    ["other leading brackets stay", "[ROCm] Add AITER CK DASH attention for Unlimited-OCR-2", {}, "[ROCm] Add AITER CK DASH attention for Unlimited-OCR-2"],
    ["a marker is never the whole title", "[R1] Fixes", {}, "[R1] Fixes"],
    ["section label after a pipe", "d1.2: State-of-the-Art Omnimodal Decision Models | Blog", {}, "d1.2: State-of-the-Art Omnimodal Decision Models"],
    ["section label: only after a pipe", "Why I stopped reading the news - News", {}, "Why I stopped reading the news - News"],
    ["a subtitle after a pipe stays", "Advancing open-model safety and agent security | Our partnership with Gray Swan", {}, "Advancing open-model safety and agent security | Our partnership with Gray Swan"],
    ["a kicker before the pipe stays", "Opinion | No AI Company Is Too Big to Fail", {}, "Opinion | No AI Company Is Too Big to Fail"],
    ["a title cut short just after a sentence end stops at the sentence", "llama.cpp GGUF File Parsing Integer Overflow Remote Code Execution Vulnerability. This...", {}, "llama.cpp GGUF File Parsing Integer Overflow Remote Code Execution Vulnerability"],
    ["... a longer remainder is kept, with one ellipsis character", "vLLM before 0.33.0 contains a path traversal vulnerability that allows malicious model publishers...", {}, "vLLM before 0.33.0 contains a path traversal vulnerability that allows malicious model publishers…"],
    ["... an abbreviation is not a sentence end", "U.S. CISA adds Apache Axis and BerriAI LiteLLM flaws to its catalog of Known Exploited Vulns vs. Last...", {}, "U.S. CISA adds Apache Axis and BerriAI LiteLLM flaws to its catalog of Known Exploited Vulns vs. Last…"],
    ["... an existing ellipsis character is left alone", "Regulatory Notice 26-24: FINRA has adopted amendments to present a targeted return…", {}, "Regulatory Notice 26-24: FINRA has adopted amendments to present a targeted return…"],
    ["a complete sentence that merely ends in a short one is not cut", "Anthropic prices its IPO at the top of the range. Now what?", {}, "Anthropic prices its IPO at the top of the range. Now what?"],
  ];
  for (const [name, input, ctx, expected] of cases) it(name, () => assert.equal(cleanTitle(input, ctx), expected));

  it("caps at 200 chars on a word boundary", () => {
    const long = `Techmeme style ${"very long clause ".repeat(20)}(Sarah Perez/TechCrunch)`;
    const out = cleanTitle(long);
    assert.ok(out.length <= 200, String(out.length));
    assert.ok(out.endsWith("…"));
    assert.doesNotMatch(out, /\s…$/);
    assert.equal(cleanTitle("x".repeat(200)), "x".repeat(200));
  });

  it("null / undefined", () => {
    assert.equal(cleanTitle(null), "");
    assert.equal(cleanTitle(undefined), "");
  });

  it("out-of-range entity in a title does not throw", () => {
    assert.equal(cleanTitle("Emoji gone wrong &#99999999; in title"), "Emoji gone wrong in title");
  });
});

describe("nameTokens / sameOutlet", () => {
  it("drops filler words but never to nothing", () => {
    assert.deepEqual(nameTokens("The GovAI Blog"), ["govai"]);
    assert.deepEqual(nameTokens("Reuters.com"), ["reuters"]);
    assert.deepEqual(nameTokens("The Blog"), ["the", "blog"]);
  });

  it("matches equal names and distinctive leading prefixes only", () => {
    const names = [nameTokens("Straiker STAR")];
    assert.equal(sameOutlet("Straiker", names), true);
    assert.equal(sameOutlet("STAR", names), false);
    assert.equal(sameOutlet("what we know", names), false);
    assert.equal(sameOutlet("AI", [nameTokens("AI")]), true);
  });

  it("a candidate may add one word to the outlet's name, not a clause (review PF-11)", () => {
    const nvidia = [nameTokens("NVIDIA")];
    assert.equal(sameOutlet("NVIDIA Technical Blog", nvidia), true);
    assert.equal(sameOutlet("Nvidia after Jensen Huang", nvidia), false);
    assert.equal(sameOutlet("CFTC’s New Rules for Crypto", [nameTokens("CFTC")]), false);
    // The other direction is unchanged: a short candidate that opens a longer name.
    assert.equal(sameOutlet("Reuters", [nameTokens("Reuters AI (Google News)")]), true);
  });
});

describe("splitOutletTail (aggregator rewrites: Techmeme)", () => {
  it("splits '(Author/Outlet)' and '(Outlet)' off the end", () => {
    assert.deepEqual(splitOutletTail("Source: Iconiq invested more than $6B in Anthropic; a 430%+ return on investment (Richard Nieva/Forbes)"), {
      title: "Source: Iconiq invested more than $6B in Anthropic; a 430%+ return on investment",
      outlet: "Forbes",
    });
    assert.equal(splitOutletTail("Sources: Nvidia is in advanced talks to acquire Inception for $500M+ (The Information)")?.outlet, "The Information");
    assert.equal(splitOutletTail("Apple is developing an AI agent that can write code and browse the web (Mark Gurman / Bloomberg)")?.outlet, "Bloomberg");
    assert.equal(splitOutletTail("A thread on what the new filing says about compute costs (@swyx)")?.outlet, "@swyx");
  });

  it("leaves titles without a name-shaped tail alone", () => {
    for (const title of [
      "Nvidia posts a record quarter under its interim CEO",
      "Nvidia posts a record quarter under its interim CEO (NASDAQ: NVDA)",
      "Critical flaw in a popular agent framework is being exploited (CVE-2026-41234)",
      "Apple's new chip is fast (really fast)",
      "Short (Reuters)",
      "(Reuters)",
    ]) {
      assert.equal(splitOutletTail(title), null, title);
    }
  });
});

describe("splitDashOutlet (Google News entries without a <source> element)", () => {
  it("the text after the LAST spaced hyphen is the outlet, whatever it looks like", () => {
    assert.deepEqual(splitDashOutlet("Citi puts AI-agent losses on customers - BigGo Finance"), { title: "Citi puts AI-agent losses on customers", outlet: "BigGo Finance" });
    assert.deepEqual(splitDashOutlet("Banks and AI agents - what the new terms say - TechCrunch"), { title: "Banks and AI agents - what the new terms say", outlet: "TechCrunch" });
    assert.equal(splitDashOutlet("Hong Kong pushes banks to use AI agents - digitimes")?.outlet, "digitimes");
    assert.equal(splitDashOutlet("Citi Makes Customers Liable for AI Agent Activity - www.tokenpost.com")?.outlet, "www.tokenpost.com");
    assert.equal(splitDashOutlet("AT&amp;T pauses its AI rollout after outages - Barron&#39;s")?.outlet, "Barron's");
  });

  it("returns null without a tail, for a tail too long to be a name, or when no headline would remain", () => {
    for (const title of [
      "State-of-the-art results on GPT-5 without a spaced hyphen",
      "- The Kaitchup",
      "Short - Reuters",
      "A headline of reasonable length - and then a clause that runs on for far too many words to be an outlet",
      "A headline of reasonable length - x",
      "",
    ]) {
      assert.equal(splitDashOutlet(title), null, title);
    }
  });
});

describe("cleanSummary", () => {
  it("WordPress tail: 'The post … appeared first on …'", () => {
    const raw = "<p>Humyn Labs raised $47M to feed robotics companies data.</p><p>The post <a href='x'>Humyn Labs raises $47M</a> appeared first on <a href='y'>The Robot Report</a>.</p>";
    assert.equal(cleanSummary(raw), "Humyn Labs raised $47M to feed robotics companies data.");
  });

  it("keeps an earlier 'the post office' sentence", () => {
    const raw = "The post office in Springfield now uses robots to sort parcels. The post Robots sort mail appeared first on Site.";
    assert.equal(cleanSummary(raw), "The post office in Springfield now uses robots to sort parcels.");
  });

  const tails: [string, string][] = [
    ["A long enough description of the story here. Read more", "A long enough description of the story here."],
    ["A long enough description of the story here. Read more…", "A long enough description of the story here."],
    ["A long enough description of the story here… Read More »", "A long enough description of the story here…"],
    ["A long enough description of the story here. Continue reading →", "A long enough description of the story here."],
    ["A long enough description of the story here. Continue reading The Big Story on Example", "A long enough description of the story here."],
    ["A long enough description of the story here. Read the full story at Example.com", "A long enough description of the story here."],
    ["A long enough description of the story here. (read more)", "A long enough description of the story here."],
    ["A long enough description of the story here. Keep reading", "A long enough description of the story here."],
  ];
  for (const [input, expected] of tails) it(`link-text tail: ${input.slice(46)}`, () => assert.equal(cleanSummary(input), expected));

  it("prose that merely ends in 'learn more' is not a tail", () => {
    assert.equal(cleanSummary("Visit the documentation portal whenever you want to learn more."), "Visit the documentation portal whenever you want to learn more.");
  });

  it("a feed's cut marker becomes an ellipsis", () => {
    assert.equal(cleanSummary("This version is from the Institute for Foundations of Machine Learning here at UT Austin, back […]"), "This version is from the Institute for Foundations of Machine Learning here at UT Austin, back…");
    assert.equal(cleanSummary("Researchers found a flaw in the popular framework that allows [...]"), "Researchers found a flaw in the popular framework that allows…");
  });

  it("arXiv 'Announce Type' prefix", () => {
    const raw = "arXiv:2611.23322v1 Announce Type: new Abstract: One hope for a good human future alongside advanced AI rests on enduring mutualism.";
    assert.equal(cleanSummary(raw), "One hope for a good human future alongside advanced AI rests on enduring mutualism.");
    assert.equal(cleanSummary("arXiv:2611.1v2 Announce Type: replace-cross Abstract: We study large models at scale in depth."), "We study large models at scale in depth.");
  });

  it("hnrss boilerplate is not a summary", () => {
    const raw = "<p>Article URL: <a href=\"https://ounapuu.ee/posts/x/\">https://ounapuu.ee/posts/x/</a></p><p>Comments URL: <a href=\"https://news.ycombinator.com/item?id=50562262\">https://news.ycombinator.com/item?id=50562262</a></p><p>Points: 307</p><p># Comments: 109</p>";
    assert.equal(cleanSummary(raw), null);
    assert.equal(cleanSummary("Article URL: https://x.test/a Comments URL: https://news.ycombinator.com/item?id=1 Points: 276 # Comments: 30"), null);
  });

  it("Reddit / Lemmy submission lines", () => {
    assert.equal(cleanSummary("submitted by Eyekaytee to localllama 12 points | 0 comments"), null);
    assert.equal(cleanSummary("I benchmarked three quantizations of the new model on a single consumer GPU. submitted by /u/someone [link] [comments]"), "I benchmarked three quantizations of the new model on a single consumer GPU.");
    assert.equal(cleanSummary("The paper was submitted by researchers to NeurIPS and accepted last week."), "The paper was submitted by researchers to NeurIPS and accepted last week.");
  });

  it("GitHub release trailers", () => {
    const raw = "What's Changed Fix the scheduler race in the Metal backend by @alice in #123 Signed-off-by: Bob Builder <bob@example.com> Co-authored-by: Cursor <cursoragent@cursor.com> Full Changelog: https://github.com/o/r/compare/v1...v2";
    assert.equal(cleanSummary(raw), "Fix the scheduler race in the Metal backend");
  });

  it("Google News echo (title + outlet) is not a summary", () => {
    const title = "Wall St slides as Anthropic's debut fails to revive AI trade optimism";
    assert.equal(cleanSummary(`${title}&nbsp;&nbsp;<font color="#6f6f6f">Reuters</font>`, { title, names: ["Reuters"] }), null);
    assert.equal(cleanSummary(`<a href="https://news.google.com/x">${title}</a>`, { title }), null);
  });

  it("Techmeme: byline + repeated headline removed, the excerpt kept", () => {
    const title = "Google adds computer use to Gemini for macOS, letting it work across apps, files, and the web in the background (Sarah Perez/TechCrunch)";
    const raw = "Sarah Perez / TechCrunch : Google adds computer use to Gemini for macOS, letting it work across apps, files, and the web in the background — Google on Thursday announced that it is bringing computer use to its Gemini desktop application on macOS.";
    assert.equal(cleanSummary(raw, { title }), "Google on Thursday announced that it is bringing computer use to its Gemini desktop application on macOS.");
  });

  it("Techmeme: symbols that end the echoed headline do not open the summary", () => {
    const title = "Sources: Menlo invested $1B+ for a ~1.5% Anthropic stake; Lightspeed, the top financial investor, invested $3B+ and holds 2%+";
    const raw = `Krystal Hu / Reuters : ${title} — For decades, venture capital thrived on small bets that became billion-dollar companies.`;
    assert.equal(cleanSummary(raw, { title }), "For decades, venture capital thrived on small bets that became billion-dollar companies.");
  });

  it("a summary that merely contains the title later on is kept whole", () => {
    const title = "The Silent Consensus";
    const raw = "Dean Ball examines how more capable AI could reshape society, and why he calls the result The Silent Consensus among institutions.";
    assert.equal(cleanSummary(raw, { title }), raw);
  });

  it("tag-only and empty summaries are null", () => {
    assert.equal(cleanSummary("Quantum"), null);
    assert.equal(cleanSummary("Health &amp; Bioscience"), null);
    assert.equal(cleanSummary("<p> </p>"), null);
    assert.equal(cleanSummary(""), null);
    assert.equal(cleanSummary(null), null);
  });

  it("caps at 320 chars on a word boundary with an ellipsis", () => {
    const out = cleanSummary("The quick brown fox jumps over the lazy dog. ".repeat(20));
    assert.ok(out !== null && out.length <= 320, String(out?.length));
    assert.ok(out.endsWith("…"));
    assert.match(out, /\w…$/);
    const exact = "y".repeat(310);
    assert.equal(cleanSummary(`${exact} tail`), `${exact} tail`);
  });

  it("emoji at the cut point never leaves a lone surrogate (crafted case 13)", () => {
    const out = cleanSummary(`<![CDATA[${"x".repeat(319)}\u{1F600} tail]]>`);
    assert.ok(out !== null && out.length <= 320);
    assert.doesNotMatch(out, LONE_SURROGATE);
  });

  it("entities in summaries decode (Techmeme &euro;) and out-of-range ones do not throw", () => {
    assert.equal(cleanSummary("Ubisoft reports Q2 net bookings down 21% YoY to &euro;388.9M, above &euro;350.7M est."), "Ubisoft reports Q2 net bookings down 21% YoY to €388.9M, above €350.7M est.");
    assert.doesNotThrow(() => cleanSummary("<![CDATA[A description with a broken &#1114112; reference in the middle of it]]>"));
  });
});

describe("cleanTitle - wire revision markers; applyTitleTemplate", () => {
  it("drops a trailing revision marker but keeps real parentheses", () => {
    assert.equal(cleanTitle("Xi Embraces Trump as China’s Best Option to Contain Chip Row (1)"), "Xi Embraces Trump as China’s Best Option to Contain Chip Row");
    assert.equal(cleanTitle("Fed Holds Rates (Correct)"), "Fed Holds Rates");
    assert.equal(cleanTitle("Critical VMware vCenter Flaw (CVSS 9.8)"), "Critical VMware vCenter Flaw (CVSS 9.8)");
    assert.equal(cleanTitle("RufRoot (CVE-2026-59726)"), "RufRoot (CVE-2026-59726)");
  });

  it("fills {title}, {summary} (first sentence, heading label removed) and {source}", () => {
    const parts = { title: "Regulatory Notice 26-24", summary: "Summary FINRA has adopted amendments to Rule 2210. Effective in January.", source: "FINRA Notices" };
    assert.equal(applyTitleTemplate("{title}: {summary}", parts), "Regulatory Notice 26-24: FINRA has adopted amendments to Rule 2210");
    assert.equal(applyTitleTemplate("{source} - {title}", parts), "FINRA Notices - Regulatory Notice 26-24");
    assert.equal(applyTitleTemplate("{title}: {summary}", { ...parts, summary: null }), "Regulatory Notice 26-24");
    assert.equal(applyTitleTemplate("{title}: {summary}", { ...parts, summary: "Regulatory Notice 26-24." }), "Regulatory Notice 26-24");
  });
});
