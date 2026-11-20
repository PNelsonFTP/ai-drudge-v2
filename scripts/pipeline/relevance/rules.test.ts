import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySourceRules, compileSourceRules } from "./rules";

const item = (title: string, summary: string | null = null, url = "https://example.com/technology/story"): { title: string; summary: string | null; url: string } => ({ title, summary, url });

describe("per-source rules", () => {
  it("no rules: everything is kept", () => {
    const rules = compileSourceRules({});
    assert.deepEqual(rules, { include: null, exclude: null, includeUrl: [], excludeUrl: [] });
    assert.deepEqual(applySourceRules(rules, item("Anything")), { keep: true });
  });

  it("exclude: a term in the title or the summary drops the item (word boundaries)", () => {
    const rules = compileSourceRules({ exclude: ["podcast", "weekly roundup"] });
    assert.deepEqual(applySourceRules(rules, item("Podcast: the week in AI")), { keep: false, detail: "matched exclude term: podcast" });
    assert.equal(applySourceRules(rules, item("A story", "Our Weekly-Roundup of links")).detail, "matched exclude term: weekly roundup");
    assert.equal(applySourceRules(rules, item("Podcasting giant buys AI lab")).keep, true);
  });

  it("include: only items matching one of the terms are kept", () => {
    const rules = compileSourceRules({ include: ["ai", "quantiz*"] });
    assert.equal(applySourceRules(rules, item("New AI policy")).keep, true);
    assert.equal(applySourceRules(rules, item("Release notes", "Adds quantization for small models")).keep, true);
    assert.deepEqual(applySourceRules(rules, item("Fed raises rates", "Inflation remains high")), { keep: false, detail: "matched none of the source's include terms" });
  });

  it("includeIn 'title': a term that appears only in the summary does not keep the item (review PF-12)", () => {
    const terms = { include: ["local LLM*", "llama.cpp", "ROCm"] };
    const anywhere = compileSourceRules(terms);
    const titleOnly = compileSourceRules({ ...terms, includeIn: "title" });
    assert.equal(anywhere.includeTitleOnly, undefined);
    assert.equal(titleOnly.includeTitleOnly, true);
    const passing = item("PostgreSQL 19 Released With More Performance Improvements", "Extensions for local LLM inference with llama.cpp are also updated.");
    assert.equal(applySourceRules(anywhere, passing).keep, true, "the default reads title and summary");
    assert.deepEqual(applySourceRules(titleOnly, passing), { keep: false, detail: 'include term "local LLM*" matched the summary only (this source needs it in the title)' });
    assert.equal(applySourceRules(titleOnly, item("AMD ROCm 10.2 Released With Latest Optimizations", null)).keep, true);
    assert.equal(applySourceRules(titleOnly, item("Mesa 26.3.1 Ships Fixes", "Nothing relevant.")).detail, "matched none of the source's include terms");
    // "title+summary" spelled out is the default; without an include list the field does nothing.
    assert.equal(compileSourceRules({ ...terms, includeIn: "title+summary" }).includeTitleOnly, undefined);
    assert.equal(compileSourceRules({ includeIn: "title" }).includeTitleOnly, undefined);
    // Exclude terms still read the summary.
    const both = compileSourceRules({ ...terms, includeIn: "title", exclude: ["sponsored"] });
    assert.equal(applySourceRules(both, item("AMD ROCm 10.2 Released", "Sponsored by a vendor.")).detail, "matched exclude term: sponsored");
  });

  it("exclude wins over include", () => {
    const rules = compileSourceRules({ include: ["ai"], exclude: ["webinar"] });
    assert.equal(applySourceRules(rules, item("AI webinar next week")).keep, false);
  });

  it("includeUrl / excludeUrl are case-insensitive substring checks on the canonical URL", () => {
    const rules = compileSourceRules({ includeUrl: ["/Technology/"], excludeUrl: ["/video/", " "] });
    assert.deepEqual(rules.includeUrl, ["/technology/"]);
    assert.deepEqual(rules.excludeUrl, ["/video/"]);
    assert.equal(applySourceRules(rules, item("x", null, "https://example.com/Technology/a")).keep, true);
    assert.equal(applySourceRules(rules, item("x", null, "https://example.com/markets/a")).detail, "URL matches none of includeUrl (/technology/)");
    assert.equal(applySourceRules(rules, item("x", null, "https://example.com/technology/video/a")).detail, 'URL contains excluded "/video/"');
  });

  it("URL rules also see the outlet host of an unresolved wrapper link (review PF-10: Stock Titan row kept despite excludeUrl)", () => {
    const rules = compileSourceRules({ excludeUrl: ["tradingview.com", "stocktitan.net", "facebook.com"] });
    const wrapper = "https://news.google.com/rss/articles/CBMixAFBVV95cUxNOHItelB?oc=5";
    assert.equal(applySourceRules(rules, item("$0 revenue at Loan Artificial Intelligence (LAAI)", null, wrapper)).keep, true, "nothing identifies the outlet");
    assert.deepEqual(applySourceRules(rules, { ...item("$0 revenue at Loan Artificial Intelligence (LAAI)", null, wrapper), outletHost: "stocktitan.net" }), {
      keep: false,
      detail: 'outlet stocktitan.net matches excluded "stocktitan.net" (link not resolved yet)',
    });
    // A known outlet is attributed to its publisher id ("meta" for facebook.com): the HOST is what the rule names.
    assert.equal(applySourceRules(rules, { ...item("A post", null, wrapper), outletHost: "Facebook.com" }).keep, false);
    assert.equal(applySourceRules(rules, { ...item("A story", null, wrapper), outletHost: "reuters.com" }).keep, true);
    // Resolved links are judged by their URL as before.
    assert.equal(applySourceRules(rules, item("x", null, "https://www.stocktitan.net/news/LAAI/a.html")).detail, 'URL contains excluded "stocktitan.net"');
    assert.equal(applySourceRules(rules, { ...item("x", null, "https://www.reuters.com/a"), outletHost: null }).keep, true);
    // includeUrl sees the same text; a rule can never match across the URL and the host.
    const only = compileSourceRules({ includeUrl: ["reuters.com"], excludeUrl: ["5reuters"] });
    assert.equal(applySourceRules(only, { ...item("x", null, wrapper), outletHost: "reuters.com" }).keep, true);
    assert.equal(applySourceRules(only, { ...item("x", null, wrapper), outletHost: "apnews.com" }).keep, false);
  });

  it("blank lists behave like absent lists", () => {
    const rules = compileSourceRules({ include: [" ", ""], exclude: [], includeUrl: [], excludeUrl: [] });
    assert.equal(rules.include, null);
    assert.equal(applySourceRules(rules, item("Anything")).keep, true);
  });
});
