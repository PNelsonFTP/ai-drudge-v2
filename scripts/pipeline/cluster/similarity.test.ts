import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hoursAgo, makeNormalized } from "../../../test/helpers/factories";
import type { NormalizedItem } from "../types";
import {
  CLUSTER,
  EVENT_TYPE_WORDS,
  buildDocs,
  buildIdf,
  clusterTokens,
  compatible,
  corroborated,
  cosine,
  distinctProducts,
  enoughInCommon,
  featuresOf,
  inCommon as profilesInCommon,
  isCalendarToken,
  knownProducts,
  lowerCaseTokens,
  mergeProfiles,
  mergeScore,
  nearlyContained,
  normalizeMoney,
  productKey,
  productsOf,
  profileOf,
  requiredCosine,
  sameFeedOnly,
  sameOrigin,
  sameProduct,
  sharedUnits,
  similarity,
  stem,
  vectorize,
  type Doc,
} from "./similarity";

const feat = (title: string) => featuresOf({ title, summary: null });
const inCommon = (a: string, b: string): boolean => {
  const fa = feat(a);
  const fb = feat(b);
  return enoughInCommon(fa.title, fa.bigrams, fb.title, fb.bigrams);
};
const units = (a: string, b: string): number => {
  const fa = feat(a);
  const fb = feat(b);
  return sharedUnits(fa.title, fa.bigrams, fb.title, fb.bigrams);
};

/** Docs for the given items plus filler, so the pair under test is not the whole corpus (IDF needs one). */
function docsFor(items: NormalizedItem[]): Doc[] {
  const filler = Array.from({ length: 40 }, (_, i) =>
    makeNormalized({ title: `Background item number${i} about topic${i % 7} and subject${i % 5}`, publisher: `filler-${i}`, sourceId: `filler-${i}`, publishedAt: hoursAgo(200 + i) }),
  );
  return buildDocs([...items, ...filler]).slice(0, items.length);
}

describe("clusterTokens", () => {
  it("normalises money to one token per amount, whatever the outlet's style", () => {
    assert.equal(normalizeMoney("valued at $2tn").trim(), "valued at  usd2t");
    assert.deepEqual(clusterTokens("$2 trillion"), ["usd2t"]);
    assert.deepEqual(clusterTokens("$2T"), ["usd2t"]);
    assert.deepEqual(clusterTokens("$47M"), ["usd47m"]);
    assert.deepEqual(clusterTokens("$47 million"), ["usd47m"]);
    assert.deepEqual(clusterTokens("$81.3 billion"), ["usd81.3b"]);
  });

  it("keeps different amounts apart ($3B is not $3.5B)", () => {
    assert.notDeepEqual(clusterTokens("$3B"), clusterTokens("$3.5B"));
  });

  it("maps the spelled-out acronym forms to one token, and nothing looser", () => {
    assert.deepEqual(clusterTokens("initial public offering"), ["ipo"]);
    assert.deepEqual(clusterTokens("Biggest I.P.O. Winners"), ["biggest", "ipo", "winner"]);
    assert.ok(!clusterTokens("shares begin trading").includes("ipo"));
  });

  it("stems plurals only and leaves versions and identifiers alone", () => {
    assert.equal(stem("shares"), "share");
    assert.equal(stem("launches"), "launch");
    assert.equal(stem("vulnerabilities"), "vulnerability");
    assert.equal(stem("nvidia"), "nvidia");
    assert.equal(stem("business"), "business");
    assert.equal(stem("llama.cpp"), "llama.cpp");
    assert.equal(stem("b12549"), "b12549");
    assert.equal(stem("v0.14.26"), "v0.14.26");
  });

  it("drops news filler so two release lines share nothing but what they name", () => {
    assert.deepEqual(clusterTokens("llama.cpp b12549 released"), ["llama.cpp", "b12549"]);
    assert.deepEqual(clusterTokens("llama_index v0.14.26 released"), ["llama_index", "v0.14.26"]);
    assert.deepEqual(clusterTokens("Introducing Gemini 4 Neon"), ["gemini", "4", "neon"]);
    assert.deepEqual(clusterTokens("Gemini 4 Neon is now available"), ["gemini", "4", "neon"]);
  });

  it("uses only the first 200 characters of the summary, and only tokens the title lacks", () => {
    const f = featuresOf({ title: "Anthropic starts trading", summary: `Anthropic went public on Nasdaq. ${"x ".repeat(120)} zebra` });
    assert.ok(f.summary.has("nasdaq"));
    assert.ok(!f.summary.has("anthropic"));
    assert.ok(!f.summary.has("zebra"));
  });

  it("drops an aggregator's trailing (Author/Outlet) byline from the clustering tokens - and only an aggregator's", () => {
    const title = "A job listing shows Apple is developing an AI agent that can write code (Mark Gurman/Bloomberg)";
    const agg = featuresOf({ title, summary: null, kind: "aggregator" });
    for (const t of ["mark", "gurman", "bloomberg"]) assert.ok(!agg.title.has(t), t);
    assert.ok(agg.title.has("apple") && agg.title.has("agent"));
    // The same text from a press feed is left alone: the regex cannot tell a byline from an id list.
    assert.ok(featuresOf({ title, summary: null, kind: "rss" }).title.has("gurman"));
    const cves = featuresOf({ title: "Is It CitrixBleed4? (Barracuda Email Security Gateway Pre-Auth RCE CVE-2026-116606 / CVE-2026-111560)", summary: null, kind: "rss" });
    for (const t of ["barracuda", "116606", "111560"]) assert.ok(cves.title.has(t), t);
    // No kind given (callers that only have a title): nothing is stripped.
    assert.ok(feat(title).title.has("bloomberg"));
  });
});

describe("shared-title rule", () => {
  it("counts a shared two-word name as ONE unit", () => {
    assert.equal(units("Decision Models in Hugging Face", "Pay for Hugging Face Hub with your Google Cloud Account"), 1);
    assert.equal(units("Introducing Gemini 4 Hydrogen", "Gemini 4 Carbon is now available"), 1);
    assert.equal(units("Jensen Huang's Downfall", "The Jensen Huang Honeypot Fallout"), 1);
  });

  it("counts a shared run of three tokens as two units", () => {
    assert.equal(units("Introducing Gemini 4 Neon", "Gemini 4 Neon in GitHub Copilot"), 2);
  });

  it("counts separate shared tokens separately", () => {
    assert.equal(units("Google gives Gemini the ability to use your Mac for you", "Gemini on Mac can now use your computer"), 2);
    assert.equal(units("Anthropic raises $81bn in record IPO", "Anthropic Sets Record With $107.3 Billion IPO"), 3);
  });

  it("lets a headline that is contained in another one through (there is nothing else to share)", () => {
    assert.ok(nearlyContained(feat("Vercel Board is now available").title, feat("Introducing Vercel Board").title));
    assert.ok(inCommon("Vercel Board is now available", "Introducing Vercel Board"));
    assert.ok(inCommon("llama.cpp v1.0.0", "llama.cpp v1.0.0 : A stronger foundation for the local AI ecosystem"));
    assert.ok(!inCommon("Introducing Gemini 4 Hydrogen", "Gemini 4 Carbon is now available"));
  });

  it("rejects pairs that share one name only", () => {
    assert.ok(!inCommon("Decision Models in Hugging Face", "Pay for Hugging Face Hub with your Google Cloud Account"));
    assert.ok(!inCommon("Anthropic raises $81bn in record IPO", "Anthropic Adds Code Mode to Claude Code"));
  });

  it("rejects pairs that share only event-type words (same kind of news, different news)", () => {
    assert.ok(!inCommon("LangChain Raises $300M Series C at $3B Valuation", "Genesis AI Raises $500M Series A at $3.5B Valuation as Eno Heads Into Production"));
    assert.ok(!inCommon("Drupal patches critical RCE flaw, warns exploits may surface quickly", "PHP Fixes 7 Critical Flaws, Including Bugs That Could Allow Remote Code Execution"));
    for (const w of ["raise", "sery", "valuation", "critical", "flaw", "patch"]) assert.ok(EVENT_TYPE_WORDS.has(w), w);
  });

  it("does not take a shared amount for a shared subject", () => {
    assert.ok(!inCommon("Payhawk closes a $50M round", "Lovable lands $50M in new round"));
    assert.ok(inCommon("Humyn Labs raises $47M to collect real-world data for robotics", "India's Humyn Labs raises $47M to feed US robotics companies the data they need"));
  });

  it("never counts a shared year or month as something two headlines have in common", () => {
    for (const t of ["2026", "1999", "november", "october", "august"]) assert.ok(isCalendarToken(t), t);
    // Versions, long ids and "may" (a stopword anyway) are not calendar tokens.
    for (const t of ["4", "6.2", "5.2", "114938", "1110", "3026", "may", "nvidia"]) assert.ok(!isCalendarToken(t), t);
    const splunk = "SVD-2026-1110: Security Vulnerabilities in Splunk App for Stream - November 2026";
    const cisco = "ClamAV Vulnerabilities Affecting Cisco Products: November 2026";
    assert.equal(units(splunk, cisco), 1, "only 'vulnerability' - not 'november', not '2026', not 'november 2026'");
    assert.ok(!inCommon(splunk, cisco));
    // Two reports that share a company and a year share one unit, not two.
    assert.ok(!inCommon("Independent Assessment of AI R&D Acceleration at Anthropic in October 2026", 'Review of the "Risks from automated R&D" section in Anthropic\'s Risk Report (August 2026)'));
    // A date is never the specific token either: these two share "patch" + a date and nothing else.
    assert.ok(!inCommon("Oracle Critical Patch Update - October 2026", "SAP Security Patch Day: October 2026"));
    // ... while a monthly event named by its date still merges through containment and its own name.
    assert.ok(inCommon("Microsoft Patch Tuesday for November 2026", "November 2026 Patch Tuesday"));
  });

  it("treats vendor advisory template words as event-type words", () => {
    for (const w of ["affecting", "product", "advisory"]) assert.ok(EVENT_TYPE_WORDS.has(w), w);
    // "<X> Vulnerabilities Affecting <Vendor> Products: <month>" from two vendors: template only.
    assert.ok(!inCommon("Vulnerabilities in NGINX affecting Splunk Products - November 2026", "ClamAV Vulnerabilities Affecting Cisco Products: November 2026"));
    // One vendor's two advisories do share a name (cisco): the same-publisher rule keeps those apart.
    assert.ok(inCommon("Vulnerabilities in Node.js and Brotli Affecting Cisco Products: October 2026", "ClamAV Vulnerabilities Affecting Cisco Products: November 2026"));
  });

  it("accepts event-type words as the second unit next to a shared name", () => {
    assert.ok(inCommon("Genesis AI Raises $500M At $3.5B Valuation To Bring Its Robots To Factories", "Genesis AI raises $500M to deploy glove-wearing robots"));
    assert.ok(inCommon("Drupal patches critical RCE flaw, warns exploits may surface quickly", "Drupal Patches Critical Installer Flaw That Could Give Unauthenticated Attackers Control of Sites"));
  });
});

describe("vectors", () => {
  it("weights rare tokens above common ones and drops tokens only one document has", () => {
    const docs = [["anthropic", "ipo"], ["anthropic", "claude"], ["anthropic", "ipo", "nasdaq"], ["openai", "gpt"], ["openai", "sora"], ["unique"]];
    const idf = buildIdf(docs, 2);
    assert.ok(idf("ipo") > idf("anthropic"));
    assert.equal(idf("unique"), 0);
    assert.equal(idf("never-seen"), 0);
    assert.ok(buildIdf(docs, 1)("unique") > 0);
  });

  it("builds unit vectors: summary tokens weigh less than title tokens, money tokens less than words", () => {
    const idf = () => 1;
    const v = vectorize({ title: new Set(["anthropic", "usd81b"]), summary: new Set(["nasdaq"]) }, idf);
    const len = Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0));
    assert.ok(Math.abs(len - 1) < 1e-9);
    assert.ok((v.get("anthropic") ?? 0) > (v.get("nasdaq") ?? 0));
    assert.ok(Math.abs((v.get("nasdaq") ?? 0) / (v.get("anthropic") ?? 1) - CLUSTER.summaryWeight) < 1e-9);
    assert.ok(Math.abs((v.get("usd81b") ?? 0) / (v.get("anthropic") ?? 1) - CLUSTER.moneyWeight) < 1e-9);
  });

  it("cosine is 1 for identical vectors, 0 for disjoint or empty ones, symmetric otherwise", () => {
    const a = new Map([["x", 0.6], ["y", 0.8]]);
    const b = new Map([["y", 1]]);
    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
    assert.equal(cosine(a, new Map([["z", 1]])), 0);
    assert.equal(cosine(a, new Map()), 0);
    assert.ok(Math.abs(cosine(a, b) - 0.8) < 1e-9);
    assert.equal(cosine(a, b), cosine(b, a));
  });
});

describe("similarity (pairs)", () => {
  const press = (title: string, publisher: string, hours: number, extra: Partial<NormalizedItem> = {}): NormalizedItem =>
    makeNormalized({ title, publisher, sourceId: `${publisher}-feed`, publishedAt: hoursAgo(hours), url: `https://${publisher}.example/${encodeURIComponent(title)}`, ...extra });

  it("is 1 for the same URL (scheme / www variants), whatever the titles say", () => {
    const [a, b] = docsFor([
      makeNormalized({ title: "How OpenAI's Performance Factory keeps ChatGPT fast", url: "https://openai.com/index/performance-factory", publisher: "openai.com", sourceId: "openai-news" }),
      makeNormalized({ title: "Something else entirely", url: "http://www.openai.com/index/performance-factory/", publisher: "openai.com", sourceId: "openai-blog" }),
    ]);
    assert.equal(similarity(a, b), 1);
  });

  it("merges two outlets' reports of one event", () => {
    const [a, b] = docsFor([
      press("Drupal patches critical RCE flaw, warns exploits may surface quickly", "bleepingcomputer", 8),
      press("Drupal Patches Critical Installer Flaw That Could Give Unauthenticated Attackers Control of Sites", "thehackernews", 6),
    ]);
    assert.ok(similarity(a, b) >= CLUSTER.threshold);
  });

  it("is 0 for items more than 72 h apart", () => {
    const title = "Drupal patches critical RCE flaw in installer";
    const [a, b, c] = docsFor([press(title, "one", 1), press(title, "two", 74), press(title, "three", 72.5)]);
    assert.equal(similarity(a, b), 0);
    assert.ok(similarity(a, c) > 0);
  });

  it("never lets a release line cluster with another repo's release or with an article", () => {
    const release = (title: string, repo: string): NormalizedItem =>
      makeNormalized({ title, publisher: `github:${repo}`, sourceId: repo.replace("/", "-"), kind: "github-release", flags: ["release"], leadEligible: false, countsForCoverage: false, publishedAt: hoursAgo(3), url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(title)}` });
    const [cpp, index, cppNext, article] = docsFor([
      release("llama.cpp b12549 released", "ggml-org/llama.cpp"),
      release("llama.cpp b12549 released", "run-llama/llama_index"),
      release("llama.cpp b12549 released (hotfix)", "ggml-org/llama.cpp"),
      press("llama.cpp b12549 released", "some-blog", 3),
    ]);
    assert.equal(similarity(cpp, index), 0);
    assert.equal(similarity(cpp, article), 0);
    assert.ok(similarity(cpp, cppNext) > 0);
  });

  it("demands a higher cosine from two items of one publisher", () => {
    const a = press("Gemini 4 Carbon is now available in Devin", "devin", 30);
    const b = press("Gemini 4 Hydrogen is now available in Devin", "devin", 2);
    const [da, db] = docsFor([a, b]);
    assert.equal(requiredCosine(profileOf(da), profileOf(db)), CLUSTER.samePublisherThreshold);
    assert.ok(sameOrigin(profileOf(da), profileOf(db)));
    // "carbon" / "hydrogen" occur once each in this corpus, so the vectors are identical - and the
    // pair must still not merge: one publisher's template headlines have to all but coincide.
    assert.ok(Math.abs(cosine(da.vec, db.vec) - 1) < 1e-9);
    assert.equal(similarity(da, db), 0);
    const [ta, tb] = docsFor([press("Vercel Board is now available", "vercel", 40), press("Introducing Vercel Board", "vercel", 37)]);
    assert.ok(similarity(ta, tb) >= CLUSTER.samePublisherThreshold);
    // The same two headlines from different publishers and feeds only need the ordinary threshold.
    const [oa, ob] = docsFor([a, { ...b, publisher: "other", sourceId: "other-feed" }]);
    assert.equal(requiredCosine(profileOf(oa), profileOf(ob)), CLUSTER.threshold);
    // One search feed attributing its hits to different hosts is NOT one origin (two outlets are two
    // outlets) - it is "same feed only", which has its own guard below.
    const [qa, qb] = docsFor([{ ...a, publisher: "host-a", sourceId: "gn-query" }, { ...b, publisher: "host-b", sourceId: "gn-query" }]);
    assert.ok(!sameOrigin(profileOf(qa), profileOf(qb)));
    assert.ok(sameFeedOnly(profileOf(qa), profileOf(qb)));
    assert.ok(!sameFeedOnly(profileOf(da), profileOf(db)), "one publisher is same-origin, not same-feed-only");
    assert.equal(requiredCosine(profileOf(qa), profileOf(qb)), CLUSTER.threshold);
  });

  it("merges two publishers found by ONE search feed only when they share more than the query's words", () => {
    const query = (title: string, publisher: string, hours: number): NormalizedItem => press(title, publisher, hours, { sourceId: "gn-llm-stack-cves", kind: "query", attribution: "link-host" });
    // Six shared units (cisa, flaw, synology, litellm, "apache axis", redcap): one event, two outlets.
    const [ka, kb] = docsFor([
      query("CISA Warns Hackers Are Actively Exploiting Four Flaws in Synology, LiteLLM, Apache Axis and REDCap", "cybersecuritynews.example", 12),
      query("U.S. CISA adds Apache Axis, Vanderbilt REDCap, BerriAI LiteLLM, and Synology DSM flaws to its Known Exploited Vulnerabilities catalog", "securityaffairs.example", 10),
    ]);
    assert.ok(sameFeedOnly(profileOf(ka), profileOf(kb)));
    assert.ok(similarity(ka, kb) >= CLUSTER.threshold);
    // "prompt injection" + "agent" is what the search asked for, not an event: 2 units < sameFeedSharedUnits.
    const guide = query("How to Prevent Prompt Injection in AI Agents", "host-a.example", 9);
    const bench = query("CapLite Tests Whether AI Agents Resist Prompt Injection", "host-b.example", 8);
    const [pa, pb] = docsFor([guide, bench]);
    assert.equal(sharedUnits(pa.features.title, pa.features.bigrams, pb.features.title, pb.features.bigrams), 2);
    assert.ok(CLUSTER.sameFeedSharedUnits > 2);
    assert.equal(similarity(pa, pb), 0);
    // The guard is about the shared feed: the same two headlines from two feeds are judged on the cosine alone.
    const [fa, fb] = docsFor([guide, { ...bench, sourceId: "another-feed" }]);
    assert.ok(!sameFeedOnly(profileOf(fa), profileOf(fb)));
    assert.ok(similarity(fa, fb) > 0);
    // A headline contained in the other one still merges, however few units that is.
    const [ca, cb] = docsFor([query("Astra reads and writes Qwen weights", "host-a.example", 5), query("The 'Astra reads and writes Qwen weights' post is misleading", "host-b.example", 4)]);
    assert.ok(similarity(ca, cb) > 0);
  });

  it("matches an aggregator headline to its press story once the byline is out of the vector", () => {
    const story = press("Apple Developing AI Agent to Rival Meta and OpenAI", "theinformation.example", 3);
    const title = "A job listing shows Apple is developing an AI agent to rival Meta and OpenAI (Mark Gurman/Bloomberg)";
    // Other headlines carry the same byline unstripped, so its tokens are corpus tokens (df >= 2) and weigh in.
    const others = ["Tim Cook to step back from daily operations", "Vision Pro successor delayed again", "New iPad lineup arrives in spring"].map((t, i) => press(`${t} (Mark Gurman/Bloomberg)`, `other-${i}`, 20 + i));
    const [s, withByline, stripped] = docsFor([story, press(title, "techmeme.example", 2, { kind: "rss" }), press(title, "techmeme.example", 2, { kind: "aggregator", sourceId: "techmeme" }), ...others]);
    assert.ok(withByline.vec.has("gurman") && !stripped.vec.has("gurman"));
    assert.ok(cosine(s.vec, stripped.vec) > cosine(s.vec, withByline.vec));
    assert.ok(similarity(s, stripped) >= CLUSTER.threshold);
  });
});

describe("profiles (clusters)", () => {
  const item = (title: string, publisher: string, hours: number, extra: Partial<NormalizedItem> = {}): NormalizedItem =>
    makeNormalized({ title, publisher, sourceId: `${publisher}-feed`, publishedAt: hoursAgo(hours), ...extra });

  it("eases the required cosine from threshold to attachThreshold as a story gains publishers", () => {
    const docs = docsFor(Array.from({ length: 9 }, (_, i) => item(`Anthropic raises record IPO take ${i}`, `pub-${i}`, i)));
    let story = profileOf(docs[0]);
    const other = profileOf(docs[8]);
    const bars = [requiredCosine(story, other)];
    for (let i = 1; i < 8; i++) {
      story = mergeProfiles(story, profileOf(docs[i]));
      bars.push(requiredCosine(story, other));
    }
    assert.equal(bars[0], CLUSTER.threshold);
    for (let i = 1; i < bars.length; i++) assert.ok(bars[i] <= bars[i - 1], `non-increasing at ${i}`);
    assert.ok(Math.abs(bars[CLUSTER.establishedPublishers - 1] - CLUSTER.attachThreshold) < 1e-9);
    assert.ok(Math.abs(bars[bars.length - 1] - CLUSTER.attachThreshold) < 1e-9);
    assert.ok(bars.every((b) => b >= CLUSTER.attachThreshold - 1e-9));
  });

  it("does not count items that are not coverage towards 'established'", () => {
    const docs = docsFor(Array.from({ length: 8 }, (_, i) => item(`Anthropic raises record IPO take ${i}`, `pub-${i}`, i, { countsForCoverage: false })));
    let story = profileOf(docs[0]);
    for (let i = 1; i < 7; i++) story = mergeProfiles(story, profileOf(docs[i]));
    assert.equal(story.coverage.size, 0);
    assert.equal(requiredCosine(story, profileOf(docs[7])), CLUSTER.threshold);
  });

  it("never lets a merge stretch a cluster past the window", () => {
    const [a, b, c] = docsFor([item("Story part one", "p1", 0), item("Story part two", "p2", 50), item("Story part three", "p3", 100)]);
    const ab = mergeProfiles(profileOf(a), profileOf(b));
    assert.ok(compatible(profileOf(a), profileOf(b)));
    assert.ok(compatible(profileOf(b), profileOf(c)));
    assert.ok(!compatible(ab, profileOf(c)), "50 h + 50 h = 100 h span");
  });

  it("describes a cluster by the tokens a majority of its headlines carry", () => {
    const docs = docsFor([
      item("Anthropic raises $81bn in record IPO", "ft", 14),
      item("Anthropic Sets Record With $107.3 Billion IPO", "bloomberg", 1),
      item("Anthropic begins public trading at $2tn valuation after largest-ever IPO", "guardian", 3),
    ]);
    const story = docs.map(profileOf).reduce((a, b) => mergeProfiles(a, b));
    assert.equal(story.size, 3);
    assert.deepEqual([...story.coreTokens].sort(), ["anthropic", "ipo", "record"]);
    assert.equal(story.coverage.size, 3);
  });

  it("lets an established story see its event word in a MINORITY of a sub-cluster's members", () => {
    // The story: six outlets, every headline says "Anthropic ... IPO".
    const storyDocs = docsFor(Array.from({ length: 6 }, (_, i) => item(`Anthropic raises record sum in IPO take${i}`, `pub-${i}`, 10 + i)));
    const story = storyDocs.map(profileOf).reduce((a, b) => mergeProfiles(a, b));
    assert.ok(story.coverage.size >= CLUSTER.establishedPublishers);
    assert.ok(story.coreTokens.has("anthropic") && story.coreTokens.has("ipo"));
    // Five "Wall Street" headlines that merged with each other first; `carriers` of them mention the IPO.
    const sub = (carriers: number): ReturnType<typeof profileOf> => {
      const titles = [
        "Anthropic shares jump after record Wall Street listing",
        "Anthropic starts trading on Wall Street",
        "Wall Street Is Wrong About Anthropic",
        "Anthropic debut tests Wall Street faith in the boom",
        "Anthropic Lives Up to Wall Street Hype",
      ];
      const docs = docsFor(titles.map((t, i) => item(t, `ws-${i}`, 1 + i, { summary: i < carriers ? "The IPO priced above the range." : "Shares rose in early trading." })));
      return docs.map(profileOf).reduce((a, b) => mergeProfiles(a, b));
    };
    const two = sub(2);
    assert.ok(!two.coreText.has("ipo"), "2 of 5 is not a majority");
    assert.ok(profilesInCommon(story, two), "... but the established story still recognises its coverage");
    assert.ok(profilesInCommon(two, story), "symmetric");
    assert.ok(!profilesInCommon(story, sub(1)), "one member's passing mention is not enough");
    // Not established: the ordinary majority rule applies and the sub-cluster stays out.
    const young = storyDocs.slice(0, 3).map(profileOf).reduce((a, b) => mergeProfiles(a, b));
    assert.ok(!profilesInCommon(young, two));
    assert.ok(CLUSTER.attachTextShare < CLUSTER.coreTokenShare);
  });

  it("scores 0 when the two sides share one name only, however alike the vectors are", () => {
    const [a, b] = docsFor([item("Hugging Face pricing changes", "one", 1), item("Hugging Face outage report", "two", 2)]);
    assert.ok(cosine(a.vec, b.vec) > CLUSTER.threshold);
    assert.equal(mergeScore(profileOf(a), profileOf(b)), 0);
  });
});

describe("versioned product names", () => {
  const keys = (title: string): string[] => productsOf(title).map(productKey);

  it("reads the word before a version, the version and the codename after it", () => {
    assert.deepEqual(keys("Introducing Gemini 4 Neon"), ["gemini 4 neon"]);
    assert.deepEqual(keys("Genie 4 is now available on the Gemini API."), ["genie 4"]);
    assert.deepEqual(keys("Claude Fable 5.2 is now available in Devin"), ["fable 5.2"]);
    assert.deepEqual(keys("OpenAI: GPT-6.2 Sol Pro"), ["gpt 6.2 sol"]);
    assert.deepEqual(keys("Hy4 Flash vs. Qwen3.8 Flash Next: Architecture, KV Cache"), ["hy 4 flash", "qwen 3.8 flash"]);
    assert.deepEqual(keys("Qwen4-Max is here"), ["qwen 4 max"]);
    assert.deepEqual(keys("Gemini 4.0 Neon tops the index"), ["gemini 4 neon"], "4.0 is 4");
    assert.deepEqual(keys("Gemini 4 Hydrogen Takes Over From Gemini Robotics ER 2 as Google Launches a Robotics Plugin"), ["gemini 4 hydrogen", "er 2"]);
  });

  it("reads a launch of several codenames, or of several families, as several products", () => {
    assert.deepEqual(keys("Introducing GPT-6.2 Astra and Sol"), ["gpt 6.2 astra", "gpt 6.2 sol"]);
    assert.deepEqual(keys("Vibe Check: GPT-6.2 Astra and Sol Leave Us Wanting More"), ["gpt 6.2 astra", "gpt 6.2 sol"]);
    assert.deepEqual(keys("Fable and Mythos 5.2: The System Card"), ["fable 5.2", "mythos 5.2"]);
  });

  it("does not take counts, dates, ids, sizes, money or percentages for versions", () => {
    for (const title of [
      "PHP Fixes 7 Critical Flaws, Including Bugs That Could Allow Remote Code Execution",
      "F5 Warns 6 Critical BIG-IP Flaws Can Crash Traffic",
      "Google Adds 4 New Gemini Models",
      "Anthropic’s 7 founders cashed out nearly $2B in record-breaking IPO",
      "Anthropic Closes First Trading Day at $97 a Share, 17% Above IPO Price",
      "Java4Shell Flaw (CVE-2026-114938) Enables Pre-Auth RCE in Jira",
      "llama.cpp b12557 released",
      "vLLM from 0.28.0 before 0.33.0 contains an improper input validation vulnerability",
      "Regulatory Notice 26-24: FINRA has adopted amendments to FINRA Rule 2210",
      "CP17/26 and GC26/9 – Cyber risk and resilience management",
      "Microsoft Patch Tuesday for November 2026",
      "Treat Your Honeypot Analysis Like Code [Guest Diary], (Wed, November 18th)",
      "DaisyRose-27B: Pushing the Frontier of Post-Training Efficiency",
      "OWASP Top 10 for LLM Applications",
      "With 12 Partners, the Alliance Grows",
    ]) {
      assert.deepEqual(keys(title).filter((k) => !k.startsWith("f 5")), [], title);
    }
  });

  it("calls two names one product only when family and version agree and the codenames do not differ", () => {
    const p = (title: string) => productsOf(title)[0];
    assert.ok(sameProduct(p("Gemini 4 Neon"), p("Gemini 4 Neon is here")));
    assert.ok(sameProduct(p("Gemini 4 Neon"), p("Gemini 4 safety reports")), "a bare family + version goes with any codename");
    assert.ok(sameProduct(p("Claude Fable 5.2"), p("Fable 5.2: Too Good")));
    assert.ok(!sameProduct(p("Gemini 4 Neon"), p("Gemini 4 Hydrogen")));
    assert.ok(!sameProduct(p("Gemini 4 Neon"), p("Genie 4 is now available")));
    assert.ok(!sameProduct(p("GPT-6.2 Astra"), p("GPT-6 Astra")));
  });

  it("drops a versioned name only one document of the run carries (a count is not a product)", () => {
    const docs = buildDocs([
      makeNormalized({ title: "Oracle to Patch 11 Java Flaws Today", publisher: "a.example", sourceId: "a" }),
      makeNormalized({ title: "Genie 4 is now available", publisher: "b.example", sourceId: "b" }),
      makeNormalized({ title: "Google opens Genie 4 world model to developers", publisher: "c.example", sourceId: "c" }),
    ]);
    assert.deepEqual(docs.map((d) => d.features.products.map(productKey)), [[], ["genie 4"], ["genie 4"]]);
  });
});

describe("distinct-product veto", () => {
  const item = (title: string, publisher: string, hours = 5): NormalizedItem => makeNormalized({ title, publisher, sourceId: `${publisher}-feed`, publishedAt: hoursAgo(hours) });
  const neon = [
    item("Introducing Gemini 4 Neon", "deepmind.example"),
    item("Google ships Gemini 4 Neon, its fourth new Gemini model in a month", "decoder.example"),
    item("Gemini 4 Neon in GitHub Copilot", "github.example"),
    item("Google continues model chemistry experiment with Neon", "register.example"),
    item("Gemini 4 Neon 🚀, Genie 4 worlds 🌍, AI designs chips 🔬", "tldr.example"),
  ];
  const genie = item("Genie 4 is now available", "deepmind-2.example");
  const hydrogen = item("Gemini 4 Hydrogen Takes Over From Gemini Robotics ER 2", "humanoids.example");
  const bare = item("Gemini 4 safety reports published", "safety.example");
  const other = item("NVIDIA Vera Rubin NVL72 Leads Agentic Inference Performance", "nvidia.example");
  const other2 = item("NVL72 racks ship to hyperscalers", "sth.example");
  const docs = docsFor([...neon, genie, hydrogen, bare, other, other2]);
  const story = docs.slice(0, 5).map(profileOf).reduce((a, b) => mergeProfiles(a, b));
  const [genieP, hydrogenP, bareP, otherP] = docs.slice(5, 9).map(profileOf);

  it("knows a story by the products two of its single-product headlines name - never by a digest line", () => {
    assert.deepEqual(knownProducts(story).map(productKey), ["gemini 4 neon"]);
    assert.deepEqual(knownProducts(profileOf(docs[4])).map(productKey), ["gemini 4 neon", "genie 4"], "the digest itself names both");
  });

  it("vetoes a different name under the same version, in either direction", () => {
    assert.ok(distinctProducts(story, genieP));
    assert.ok(distinctProducts(genieP, story));
    assert.ok(distinctProducts(story, hydrogenP));
    assert.equal(mergeScore(story, genieP), 0);
    assert.equal(mergeScore(story, hydrogenP), 0);
  });

  it("does not veto a bare family + version, a headline without a version, a digest, or a name with another version", () => {
    assert.ok(!distinctProducts(story, bareP));
    assert.ok(!distinctProducts(story, profileOf(docs[3])), "no version in the headline");
    assert.ok(!distinctProducts(story, profileOf(docs[4])), "the digest names Neon too");
    assert.ok(!distinctProducts(story, otherP), "NVL72 is not a rival 'version 4'");
    assert.ok(!distinctProducts(story, genieP, { ...CLUSTER, productShare: 2 }), "productShare > 1 turns the veto off");
  });
});

describe("corroborated merge (the second pass under the cosine bar)", () => {
  const item = (title: string, publisher: string, hours: number, extra: Partial<NormalizedItem> = {}): NormalizedItem =>
    makeNormalized({ title, publisher, sourceId: `${publisher}-feed`, publishedAt: hoursAgo(hours), ...extra });
  const record = item("Lawmakers launch new AI safety caucus amid rising security concerns", "therecord.example", 5);
  const politico = item("A bipartisan group of 24+ House lawmakers forms the AI Safety and Innovation Caucus", "politico.example", 7);
  const late = item("A bipartisan group of 24+ House lawmakers forms the AI Safety and Innovation Caucus", "politico-late.example", 40);
  const q1 = item("Quandela and Hermes-Epitek Join Forces to Advance Photonic Quantum Technologies", "tqi.example", 20);
  const q2 = item("Quandela and NVIDIA Benchmark Photonic Quantum Simulability Frontiers", "qcr.example", 4);
  const gao = item("Major AI platforms generated viable plans for terrorist attacks, GAO finds", "nextgov.example", 9);
  const wapo = item("Chatbots helped plan terrorist attacks in tests by congressional watchdog", "wapo.example", 3);
  const gov1 = item("Genie One Accuracy: Why Curated Agents Need governed Context", "databricks.example", 6);
  const gov2 = item("LangSmith Tool Gateway: Secure, governed tool use for agents", "langchain.example", 4);

  it("lowerCaseTokens keeps the words a headline writes in lower case", () => {
    assert.deepEqual([...lowerCaseTokens("Lawmakers launch new AI safety caucus")].sort(), ["caucus", "launch", "safety"]);
    assert.deepEqual([...lowerCaseTokens("Quandela and NVIDIA Benchmark Photonic Quantum")], []);
  });

  it("accepts a pair-exclusive ordinary word with three shared units, or inside a shared two-word name", () => {
    const [r, p, g, w] = docsFor([record, politico, gao, wapo]).map(profileOf);
    assert.ok(corroborated(r, p, 0.33), "caucus + lawmakers + safety");
    assert.ok(corroborated(g, w, 0.3), "'terrorist attacks' is a shared name holding the exclusive word");
    assert.ok(!corroborated(r, p, 0.28), "under corroboratedThreshold");
    assert.ok(!corroborated(r, g, 0.35), "nothing pair-exclusive in common");
  });

  it("rejects a rare shared NAME, a pair more than 24 h apart, one origin, and an exclusive word with too little around it", () => {
    const [r, l, a, b, g1, g2] = docsFor([record, late, q1, q2, gov1, gov2]).map(profileOf);
    assert.ok(!corroborated(a, b, 0.36), "Quandela is capitalised in both headlines");
    assert.ok(!corroborated(r, l, 0.36), "35 h apart");
    assert.ok(!corroborated(g1, g2, 0.36), "'governed' is exclusive, but only 'agent' is shared besides it");
    const twin = docsFor([record, item(politico.title, record.publisher, 7)]).map(profileOf);
    assert.ok(!corroborated(twin[0], twin[1], 0.36), "one publisher: samePublisherThreshold is the only way");
  });

  it("is not exclusive once a third document uses the word", () => {
    const others = [item("State lawmakers weigh a toy safety recall", "ctx.example", 12)];
    const [r, p] = docsFor([record, politico, ...others]).map(profileOf);
    assert.ok(corroborated(r, p, 0.36), "'caucus' is the pair's own word");
    const [r3, p3] = docsFor([record, politico, ...others, item("Statehouse caucus elects a new chair", "third.example", 10)]).map(profileOf);
    assert.ok(!corroborated(r3, p3, 0.36));
  });
});
