// Cluster stage tests. Two parts:
//   1. behaviour on small hand-made inputs (factories);
//   2. ACCEPTANCE on the real 2026-11-19 corpus (1,318 items after the adapter), frozen clock.
//
// The corpus assertions are the regression net for every number in similarity.ts CLUSTER: change a
// threshold and these say which real stories fell apart or which unrelated ones merged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hoursAgo, makeNormalized } from "../../../test/helpers/factories";
import { loadCorpus, loadFixtureRegistry } from "../../../test/helpers/fixtures";
import { PIPELINE, TEST_NOW_ISO, createTestContext } from "../context";
import type { NormalizedItem, Story } from "../types";
import { adaptCorpus } from "./corpusAdapter.testkit";
import { cluster, clusterItems, coveragePublishers, isArticleHeadline, isJoiner, isSecondaryFormat, leadClass } from "./index";
import { CLUSTER } from "./similarity";

const HOUR = 3_600_000;
const NOW = new Date(TEST_NOW_ISO);

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

let n = 0;
function press(title: string, publisher: string, hours: number, extra: Partial<NormalizedItem> = {}): NormalizedItem {
  return makeNormalized({ title, publisher, sourceId: `${publisher}-feed`, publishedAt: hoursAgo(hours), url: `https://${publisher}.example/story-${++n}`, tier: 2, ...extra });
}
function release(title: string, repo: string, hours: number): NormalizedItem {
  return makeNormalized({
    title,
    publisher: `github:${repo}`,
    sourceId: repo.replace("/", "-"),
    kind: "github-release",
    flags: ["release"],
    leadEligible: false,
    countsForCoverage: false,
    tier: 1,
    publishedAt: hoursAgo(hours),
    url: `https://github.com/${repo}/releases/tag/r${++n}`,
  });
}
function community(title: string, hours: number, extra: Partial<NormalizedItem> = {}): NormalizedItem {
  return makeNormalized({ title, publisher: "reddit.com", sourceId: "localllama-subreddit", kind: "community", flags: ["discussion"], leadEligible: false, countsForCoverage: false, tier: 3, publishedAt: hoursAgo(hours), url: `https://reddit.example/t-${++n}`, ...extra });
}
/** Unrelated items (no two share a title token) so the items under test are not the whole corpus - IDF needs one. */
function background(count = 60): NormalizedItem[] {
  return Array.from({ length: count }, (_, i) => press(`Zqa${i} zqb${i} zqc${i} zqd${i}`, `bg-${i}`, 150 + i));
}
const storyOf = (stories: readonly Story[], id: string): Story => {
  const s = stories.find((st) => st.items.some((i) => i.id === id));
  assert.ok(s, `no story holds item ${id}`);
  return s;
};
const together = (stories: readonly Story[], a: NormalizedItem, b: NormalizedItem): boolean => storyOf(stories, a.id) === storyOf(stories, b.id);

// ------------------------------------------------------------------------------------------------
// Behaviour on hand-made inputs
// ------------------------------------------------------------------------------------------------

describe("cluster: contract invariants", () => {
  const drupalA = press("Drupal patches critical RCE flaw, warns exploits may surface quickly", "bleepingcomputer", 8);
  const drupalB = press("Drupal Patches Critical Installer Flaw That Could Give Unauthenticated Attackers Control of Sites", "thehackernews", 6);
  const items = [drupalA, drupalB, ...background()];
  const stories = clusterItems(items);

  it("puts every item in exactly one story", () => {
    const seen = new Map<string, number>();
    for (const s of stories) for (const i of s.items) seen.set(i.id, (seen.get(i.id) ?? 0) + 1);
    assert.equal(seen.size, items.length);
    assert.ok([...seen.values()].every((c) => c === 1));
  });

  it("keeps lead === items[0].id and members === items.slice(1) ids", () => {
    for (const s of stories) {
      assert.equal(s.lead, s.items[0].id);
      assert.deepEqual(s.members, s.items.slice(1).map((i) => i.id));
    }
  });

  it("merges two outlets' reports of one event and counts two publishers", () => {
    const s = storyOf(stories, drupalA.id);
    assert.equal(s.items.length, 2);
    assert.deepEqual([...s.publishers].sort(), ["bleepingcomputer", "thehackernews"]);
  });

  it("returns [] for no items and a singleton for one", () => {
    assert.deepEqual(clusterItems([]), []);
    const one = clusterItems([drupalA]);
    assert.equal(one.length, 1);
    assert.deepEqual(one[0].members, []);
    assert.deepEqual(one[0].publishers, ["bleepingcomputer"]);
  });

  it("does not mutate its input and ignores a repeated id", () => {
    const input = [drupalA, drupalB, drupalA];
    const snapshot = JSON.stringify(input);
    const out = clusterItems(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.equal(out.flatMap((s) => s.items).length, 2);
  });

  it("is independent of the order the items arrive in", () => {
    const signature = (ss: readonly Story[]): string => ss.map((s) => `${s.lead}:${s.members.join(",")}`).join("|");
    const reversed = clusterItems([...items].reverse());
    const rotated = clusterItems([...items.slice(17), ...items.slice(0, 17)]);
    assert.equal(signature(reversed), signature(stories));
    assert.equal(signature(rotated), signature(stories));
  });

  it("logs one summary line through ctx.log and returns the same stories as clusterItems", () => {
    const ctx = createTestContext();
    const out = cluster(items, ctx);
    assert.equal(out.length, stories.length);
    assert.equal(ctx.logs.length, 1);
    assert.match(ctx.logs[0].msg, /^cluster: 62 items -> \d+ stories \(1 multi-item, 1 with 2\+ publishers, largest 2 publishers\)$/);
  });
});

describe("cluster: rules", () => {
  it("never merges items more than 72 h apart, even identical headlines", () => {
    const a = press("Nvidia board names an interim chief after Huang exit", "one", 1);
    const b = press("Nvidia board names an interim chief after Huang exit", "two", 80);
    assert.ok(!together(clusterItems([a, b, ...background()]), a, b));
    assert.equal(CLUSTER.windowHours, 72);
  });

  it("never lets a chain of merges stretch a story past 72 h", () => {
    const title = "Nvidia board names an interim chief after Huang exit";
    const chain = [0, 40, 80, 120].map((h, i) => press(title, `outlet-${i}`, h + 1));
    const stories = clusterItems([...chain, ...background()]);
    for (const s of stories) {
      const times = s.items.map((i) => Date.parse(i.effectiveAt));
      assert.ok(Math.max(...times) - Math.min(...times) <= 72 * HOUR, s.items.map((i) => i.title).join(" | "));
    }
    assert.ok(together(stories, chain[0], chain[1]));
    assert.ok(!together(stories, chain[0], chain[3]));
  });

  it("keeps release lines of different repos apart and out of press stories", () => {
    const cpp = release("llama.cpp b12549 released", "ggml-org/llama.cpp", 3);
    const index = release("llama_index v0.14.26 released", "run-llama/llama_index", 5);
    const claude = release("claude-code v2.1.328 released", "anthropics/claude-code", 20);
    const qwen = release("qwen-code v0.27.1 released", "qwenlm/qwen-code", 22);
    const blog = press("llama.cpp b12549 released with a faster scheduler", "some-blog", 2);
    const echo = press("llama.cpp b12549 released: faster scheduler lands", "other-blog", 1);
    const stories = clusterItems([cpp, index, claude, qwen, blog, echo, ...background()]);
    for (const r of [cpp, index, claude, qwen]) assert.equal(storyOf(stories, r.id).items.length, 1, r.title);
    assert.ok(together(stories, blog, echo));
    assert.deepEqual(storyOf(stories, cpp.id).publishers, [], "a release-only story has no coverage");
  });

  it("merges two release lines of the SAME repo when they are the same line", () => {
    const a = release("ollama v0.40.17 released", "ollama/ollama", 3);
    const b = release("ollama v0.40.17 released", "ollama/ollama", 4);
    assert.ok(together(clusterItems([a, b, ...background()]), a, b));
  });

  it("counts twin feeds of one publisher once (OpenAI News + OpenAI Blog)", () => {
    const news = makeNormalized({ title: "How OpenAI's Performance Factory keeps ChatGPT fast", url: "https://openai.com/index/performance-factory", publisher: "openai.com", sourceId: "openai-news", tier: 1, publishedAt: hoursAgo(13) });
    const blog = makeNormalized({ title: "How OpenAI's Performance Factory keeps ChatGPT fast", url: "https://www.openai.com/index/performance-factory/", publisher: "openai.com", sourceId: "openai-blog", tier: 2, publishedAt: hoursAgo(13) });
    assert.notEqual(news.id, blog.id);
    const s = storyOf(clusterItems([news, blog, ...background()]), news.id);
    assert.equal(s.items.length, 2, "same URL is one story");
    assert.deepEqual(s.publishers, ["openai.com"]);
    assert.equal(s.lead, news.id, "the tier-1 feed leads");
  });

  it("counts publishers, not feeds: three TechCrunch feeds + The Robot Report = 2", () => {
    const title = "Humyn Labs raises $47M to collect real-world data for robotics";
    const tc = ["techcrunch-ai", "techcrunch-startups", "techcrunch-robotics"].map((sourceId, i) => press(`${title}${" ".repeat(i)}`, "techcrunch.com", 30 + i, { sourceId }));
    const rr = press("India's Humyn Labs raises $47M to feed US robotics companies the data they need", "therobotreport.com", 22);
    const s = storyOf(clusterItems([...tc, rr, ...background()]), rr.id);
    assert.equal(s.items.length, 4);
    assert.deepEqual([...s.publishers].sort(), ["techcrunch.com", "therobotreport.com"]);
  });

  it("does not let items that are not coverage raise the publisher count", () => {
    const a = press("Qwen3.8 LoRA adapters land in llama.cpp with full GPU offload", "blog-a", 5);
    const thread = community("Qwen3.8 LoRA adapters land in llama.cpp with full GPU offload", 4);
    const s = storyOf(clusterItems([a, thread, ...background()]), a.id);
    assert.equal(s.items.length, 2);
    assert.deepEqual(s.publishers, ["blog-a"]);
    assert.equal(s.lead, a.id);
    assert.deepEqual(coveragePublishers(s.items), s.publishers);
  });

  it("uses a link-host item's own publisher (Reuters via Google News + TechCrunch = 2)", () => {
    const viaQuery = press("EU Commission confirms it was targeted in cyberattack through use of AI tools", "reuters.com", 3, { sourceId: "reuters-ai-google-news", kind: "query", attribution: "link-host" });
    const direct = press("European Commission confirms cyberattack, says hackers used AI tool", "therecord.media", 6);
    const s = storyOf(clusterItems([viaQuery, direct, ...background()]), direct.id);
    assert.deepEqual([...s.publishers].sort(), ["reuters.com", "therecord.media"]);
  });

  it("lets aggregator and community items JOIN a story but never lead or bridge", () => {
    const neon = press("Introducing Gemini 4 Neon", "deepmind.google", 23, { tier: 1 });
    const neonPress = press("Google ships Gemini 4 Neon, its fourth new Gemini model in a month", "the-decoder.com", 24);
    const genie = press("Genie 4 worlds are now available to everyone", "deepmind.google", 27, { tier: 1 });
    const geniePress = press("Google Deepmind's Project Genie update brings Genie 4 worlds and a community gallery", "the-decoder.com", 26);
    const digest = press("Gemini 4 Neon ships, Genie 4 worlds, AI designs chips", "tldr.tech", 21, { kind: "aggregator", sourceId: "tldr-ai", tier: 3 });
    const thread = community("Gemini 4 Neon is out - Google ships its fourth new Gemini model", 20);
    const stories = clusterItems([neon, neonPress, genie, geniePress, digest, thread, ...background()]);
    assert.ok(together(stories, neon, neonPress));
    assert.ok(together(stories, genie, geniePress));
    assert.ok(!together(stories, neon, genie), "the digest that names both must not bridge them");
    const s = storyOf(stories, neon.id);
    assert.ok(s.items.includes(thread), "the thread joins");
    assert.equal(leadClass(s.items[0]), 0);
    assert.ok(isJoiner(digest) && isJoiner(thread) && !isJoiner(neon));
  });

  it("files an aggregator copy of a URL under the press copy, whichever is older", () => {
    const agg = press("Everful raises $48.5M (TechCrunch)", "techmeme.com", 9, { kind: "aggregator", sourceId: "techmeme", url: "https://techcrunch.com/2026/11/19/everful" });
    const art = press("Former Alibaba exec's Everful raises $48.5M to connect retailers with Chinese factories", "techcrunch.com", 4, { url: "https://www.techcrunch.com/2026/11/19/everful/" });
    assert.notEqual(agg.id, art.id);
    const s = storyOf(clusterItems([agg, art, ...background()]), art.id);
    assert.equal(s.items.length, 2);
    assert.equal(s.lead, art.id);
    assert.deepEqual([...s.publishers].sort(), ["techcrunch.com", "techmeme.com"]);
  });

  it("lets a community item lead only when the story has nothing else", () => {
    const lonely = community("Local LLM rig photos megathread", 2);
    const s = storyOf(clusterItems([lonely, ...background()]), lonely.id);
    assert.equal(s.lead, lonely.id);
    assert.deepEqual(s.publishers, []);
  });

  it("keeps same-company, different-event headlines apart", () => {
    const ipo = press("Anthropic raises $81bn in record IPO", "ft.com", 14);
    const ipo2 = press("Anthropic Sets Record With $107.3 Billion IPO", "bloomberg.com", 1);
    const product = press("Anthropic Adds Code Mode to Claude Code", "marktechpost.com", 38);
    const stories = clusterItems([ipo, ipo2, product, ...background()]);
    assert.ok(together(stories, ipo, ipo2));
    assert.ok(!together(stories, ipo, product));
  });

  it("keeps vendor advisories apart: a shared month, year and template are not a shared story", () => {
    // Live 2026-11-20: these five were ONE row in CYBER for a reader who runs Splunk and Cisco.
    const splunk = (title: string, hours: number): NormalizedItem => press(title, "splunk.com", hours, { sourceId: "splunk-security-advisories" });
    const cisco = (title: string, hours: number): NormalizedItem => press(title, "cisco.com", hours, { sourceId: "cisco-psirt-advisories" });
    const advisories = [
      splunk("SVD-2026-1110: Security Vulnerabilities in Splunk App for Stream - November 2026", 30),
      splunk("SVD-2026-1111: Security Vulnerabilities in Splunk AI Assistant - November 2026", 30),
      splunk("SVD-2026-1112: Vulnerabilities in NGINX affecting Splunk Products - November 2026", 30),
      cisco("ClamAV Vulnerabilities Affecting Cisco Products: November 2026", 28),
      cisco("Vulnerabilities in Node.js and Brotli Affecting Cisco Products: October 2026", 60),
    ];
    const stories = clusterItems([...advisories, ...background()]);
    for (const a of advisories) assert.equal(storyOf(stories, a.id).items.length, 1, a.title);
    // A monthly event that IS one story still merges across outlets.
    const pt1 = press("Microsoft Patch Tuesday for November 2026", "isc.sans.edu", 20);
    const pt2 = press("November 2026 Patch Tuesday", "krebsonsecurity.com", 19);
    assert.ok(together(clusterItems([pt1, pt2, ...advisories, ...background()]), pt1, pt2));
  });

  it("keeps two dated reports about one company apart", () => {
    const a = press("Independent Assessment of AI R&D Acceleration at Anthropic in October 2026", "metr.org", 20);
    const b = press('Review of the "Risks from automated R&D" section in Anthropic\'s Risk Report (August 2026)', "alignmentforum.org", 19);
    assert.ok(!together(clusterItems([a, b, ...background()]), a, b));
  });

  it("joins a Techmeme-style headline to its press story despite the (Author/Outlet) tail", () => {
    const art = press("Apple Developing AI Agent to Rival Meta and OpenAI", "theinformation.com", 3);
    const agg = press("A job listing shows Apple is developing an AI agent to rival Meta and OpenAI (Mark Gurman/Bloomberg)", "techmeme.com", 2, { kind: "aggregator", sourceId: "techmeme", tier: 3 });
    // The byline is a corpus token: other press headlines carry the same names.
    const bylines = ["Tim Cook to step back from daily operations", "Vision Pro successor delayed again", "New iPad lineup arrives in spring"].map((t, i) => press(`${t}, says Mark Gurman of Bloomberg`, `byline-${i}`, 30 + i));
    const s = storyOf(clusterItems([art, agg, ...bylines, ...background()]), art.id);
    assert.ok(s.items.includes(agg));
    assert.equal(s.lead, art.id);
    assert.equal(agg.title.endsWith("(Mark Gurman/Bloomberg)"), true, "the displayed title is untouched");
  });

  it("merges two outlets found by one search feed on a real shared event, not on the query's words", () => {
    const query = (title: string, publisher: string, hours: number): NormalizedItem => press(title, publisher, hours, { sourceId: "gn-llm-stack-cves", kind: "query", attribution: "link-host" });
    const kevA = query("CISA Warns Hackers Are Actively Exploiting Four Flaws in Synology, LiteLLM, Apache Axis and REDCap", "cybersecuritynews.com", 12);
    const kevB = query("U.S. CISA adds Apache Axis, Vanderbilt REDCap, BerriAI LiteLLM, and Synology DSM flaws to its Known Exploited Vulnerabilities catalog", "securityaffairs.com", 10);
    const guide = query("How to Prevent Prompt Injection in AI Agents", "guide.example", 9);
    const bench = query("CapLite Tests Whether AI Agents Resist Prompt Injection", "bench.example", 8);
    const stories = clusterItems([kevA, kevB, guide, bench, ...background()]);
    assert.ok(together(stories, kevA, kevB));
    assert.deepEqual([...storyOf(stories, kevA.id).publishers].sort(), ["cybersecuritynews.com", "securityaffairs.com"]);
    assert.ok(!together(stories, guide, bench));
  });

  it("attaches a sub-cluster to an established story when only some of its members name the event", () => {
    // Live 2026-11-20: TOP #1 (27 publishers, "IPO") and TOP #4 (5 publishers, "Wall Street") were one event.
    const ipo = ["raises $81bn in record IPO", "Sets Record With $81bn IPO", "prices IPO at $83 a share, a record", "IPO is the largest on record", "record IPO values it at $2tn", "closes record IPO, raising $81bn", "IPO breaks every record"].map((t, i) =>
      press(`Anthropic ${t}`, `ipo-${i}.example`, 30 + i),
    );
    const wall = [
      press("Anthropic shares jump 17% after record Wall Street listing", "ft.example", 4, { summary: "Shares closed at $97 on their first day." }),
      press("Anthropic’s Mega IPO Lives Up to Wall Street Hype", "wsj.example", 5),
      press("Anthropic's blockbuster debut tests Wall Street's faith", "reuters.example", 5, { summary: "Investors piled in on the first day." }),
      press("Anthropic starts trading on Wall Street", "verge.example", 6, { summary: "The company is now public." }),
      press("Wall Street Is Wrong About Anthropic", "bridge.example", 3, { summary: "The IPO says less than the market thinks." }),
    ];
    const product = press("Anthropic Adds Code Mode to Claude Code", "marktechpost.example", 8);
    const stories = clusterItems([...ipo, ...wall, product, ...background()]);
    const s = storyOf(stories, ipo[0].id);
    for (const w of wall) assert.ok(s.items.includes(w), w.title);
    assert.equal(s.publishers.length, 12);
    assert.ok(!s.items.includes(product));
  });

  // The live "Introducing Gemini 4 Neon" story of 2026-11-20 (8 publishers), with the four items
  // that sat inside it: three about Genie 4 and one about Gemini 4 Hydrogen.
  const neonDay = (): { neon: NormalizedItem[]; genie: NormalizedItem[]; hydrogen: NormalizedItem; digest: NormalizedItem } => {
    const google = "Google DeepMind";
    const neon = [
      press("Introducing Gemini 4 Neon", "deepmind.google", 29, { tier: 1, summary: `${google} releases Gemini 4 Neon, its most capable coding model.` }),
      press("Google ships Gemini 4 Neon, its fourth new Gemini model in a month", "the-decoder.com", 28, { summary: "Google has released Gemini 4 Neon." }),
      press("Google DeepMind Releases Gemini 4 Neon: 1M Context, #1 on AA Coding Agent Index", "marktechpost.com", 27),
      press("Google continues to accelerate its release cadence with Gemini 4 Neon", "artificialanalysis.ai", 27),
      press("Gemini 4 Neon now available on AI Gateway", "vercel.com", 27),
      press("Google launches Gemini 4 Neon on Gemini, Antigravity, and APIs", "testingcatalog.com", 28),
      press("Gemini 4 Neon in Google Antigravity", "antigravity.google", 28),
      press("Gemini 4 Neon in GitHub Copilot", "github.blog", 26),
    ];
    const genie = [
      press("Genie 4 is now available", "deepmind.google", 26, { tier: 1, summary: `${google} releases Genie 4, its world model, on the Gemini API.` }),
      press("Genie 4 is now available on the Gemini API.", "developers.googleblog.com", 26, { summary: "Google releases the Genie 4 world model to developers." }),
      press("Google opens Genie 4 world model to developers in Gemini API", "testingcatalog.com", 25, { summary: "Google has released Genie 4 on the Gemini API." }),
    ];
    const hydrogen = press("Gemini 4 Hydrogen Takes Over From Gemini Robotics ER 2 as Google Launches a Robotics Plugin for Antigravity", "humanoidsdaily.com", 24, { summary: "Google releases a robotics plugin built on Gemini 4." });
    // A digest names both launches; it must not teach the Neon story that it is "also about" Genie 4.
    const digest = press("Gemini 4 Neon 🚀, Genie 4 worlds 🌍, AI designs chips 🔬", "tldr.tech", 20, { kind: "newsletter", tier: 3 });
    return { neon, genie, hydrogen, digest };
  };

  it("keeps a different versioned product out of a launch story (Genie 4 / Gemini 4 Hydrogen in Gemini 4 Neon)", () => {
    const { neon, genie, hydrogen, digest } = neonDay();
    const all = [...neon, ...genie, hydrogen, digest, ...background()];
    const stories = clusterItems(all);
    const story = storyOf(stories, neon[0].id);
    for (const n of neon) assert.ok(story.items.includes(n), n.title);
    assert.ok(story.publishers.length >= 8);
    for (const g of genie) assert.ok(!story.items.includes(g), `in the Neon story: ${g.title}`);
    assert.ok(!story.items.includes(hydrogen));
    // The three Genie 4 items are their own story, and the Hydrogen item is in neither.
    const genieStory = storyOf(stories, genie[0].id);
    for (const g of genie) assert.ok(genieStory.items.includes(g), g.title);
    assert.ok(!genieStory.items.includes(hydrogen));
    assert.ok(story.items.includes(digest) || genieStory.items.includes(digest) || storyOf(stories, digest.id).items.length === 1, "the digest may sit with either launch");
    // Without the veto they are inside the launch story again (the defect as shipped).
    const before = clusterItems(all, { ...CLUSTER, productShare: 2 });
    const impure = storyOf(before, neon[0].id).items.filter((i) => genie.includes(i) || i === hydrogen);
    assert.ok(impure.length >= 2, `veto off: ${impure.length} foreign items in the Neon story`);
  });

  it("does not let the product veto break a launch of two codenames, or a story told with and without the family name", () => {
    const gpt = [
      press("Introducing GPT-6.2 Astra and Sol", "openai.com", 57, { tier: 1 }),
      press("OpenAI Releases GPT-6.2 Astra and Sol, Its New Frontier Models", "marktechpost.com", 56),
      press("OpenAI’s GPT-6.2 Astra and GPT-6.2 Sol now available", "github.blog", 55),
      press("OpenAI: GPT-6.2 Sol", "openrouter.ai", 55, { summary: "GPT-6.2 Sol is the smaller model OpenAI released with GPT-6.2 Astra." }),
      press("Vibe Check: GPT-6.2 Astra and Sol Leave Us Wanting More", "every.to", 50),
    ];
    const fable = [
      press("Claude Fable 5.2 is now available in Devin", "cognition.ai", 40),
      press("Fable and Mythos 5.2: The System Card", "thezvi.substack.com", 39, { summary: "Anthropic released Claude Fable 5.2 and Claude Mythos 5.2 with a system card." }),
      press("Fable 5.2: Too Good", "thealgorithmicbridge.com", 38, { summary: "Claude Fable 5.2 is now available and it is too good." }),
      press("Claude Fable 5.2 ✨, Meta Ember 🤖, Google’s new TPUs ⚡", "tldr.tech", 37, { kind: "newsletter" }),
    ];
    const stories = clusterItems([...gpt, ...fable, ...background()]);
    const g = storyOf(stories, gpt[0].id);
    for (const item of gpt) assert.ok(g.items.includes(item), item.title);
    const f = storyOf(stories, fable[0].id);
    for (const item of fable) assert.ok(f.items.includes(item), item.title);
    assert.notEqual(g, f);
  });

  it("merges a near-miss pair that shares a word nobody else uses - and only then", () => {
    // Live 2026-11-20: POLICY carried both rows (cosine 0.33 against a bar of 0.40).
    const record = press("Lawmakers launch new AI safety caucus amid rising security concerns", "therecord.media", 5, { summary: "House members said the group will weigh rules for frontier AI." });
    const techmeme = press(
      "A bipartisan group of 24+ House lawmakers forms the AI Safety and Innovation Caucus, seeking to balance mitigating AI risks with maintaining US leadership (Mohar Chatterjee/Politico)",
      "politico.com",
      7,
      { kind: "aggregator", sourceId: "techmeme", tier: 3, countsForCoverage: false, leadEligible: false },
    );
    const gao = press("Major AI platforms generated viable plans for terrorist attacks, GAO finds", "nextgov.com", 9);
    const wapo = press("Chatbots helped plan terrorist attacks in tests by congressional watchdog", "washingtonpost.com", 3);
    // Context: every other word of the four headlines is used elsewhere in the run (as in a real
    // corpus), so only "caucus" and "terrorist" are pair-exclusive and the cosines stay under the bar.
    const words = new Set([record, techmeme, gao, wapo].flatMap((i) => i.title.toLowerCase().match(/[a-z]{4,}/g) ?? []));
    for (const exclusive of ["caucus", "terrorist"]) words.delete(exclusive);
    const context = [...words].flatMap((word, w) => Array.from({ length: 3 }, (_, i) => press(`Ctx${w}x${i} note on ${word} in region${w}x${i}`, `context-${w}-${i}.example`, 30 + (w % 20) + i)));
    const all = [record, techmeme, gao, wapo, ...context, ...background()];
    const stories = clusterItems(all);
    assert.ok(together(stories, record, techmeme), "AI Safety Caucus: The Record + Techmeme/Politico");
    assert.equal(storyOf(stories, record.id).lead, record.id, storyOf(stories, record.id).items.map((i) => i.title).join(" | "));
    assert.ok(together(stories, gao, wapo), "GAO terrorist-attack tests: Nextgov + Washington Post");
    // The second pass is what merges them: with it off, both pairs stay split.
    const off = clusterItems(all, { ...CLUSTER, corroboratedThreshold: 2 });
    assert.ok(!together(off, record, techmeme));
    assert.ok(!together(off, gao, wapo));
    // More than 24 h apart: not corroborated.
    const late = press("Chatbots helped plan terrorist attacks in tests by congressional watchdog", "washingtonpost.com", 40);
    assert.ok(!together(clusterItems([gao, late, ...context, ...background()]), gao, late));
  });

  // The three false merges of the live build of 2026-11-20 04:16Z (each passed the plain 0.40 bar).
  it("never merges two companies' look-alike stories (Nvidia / AMD short-seller reports)", () => {
    const scmp = press("Nvidia faces questions over former No 3’s China ties after short seller report", "scmp.com", 39, {
      summary: "Nvidia is facing fresh scrutiny from short sellers over its China-related business, with Muddy Waters betting against the US chipmaker.",
    });
    const info = press("Wall Street Short-Seller Alleges AMD Has Business Ties to China", "theinformation.com", 9, {
      summary: "Shares of Advanced Micro Devices dropped 9% after Hunterbrook Capital published a report detailing AMD’s business relationships in China.",
    });
    const cnbc = press("AMD dives on short seller report of alleged China exposure", "cnbc.com", 4, { summary: "AMD closed down over 7% after a short seller alleged that its firmware showed up at a blacklisted Chinese company." });
    const all = [scmp, info, cnbc, ...background()];
    const stories = clusterItems(all);
    assert.ok(together(stories, info, cnbc), "the two AMD reports are one story");
    assert.ok(!together(stories, scmp, info), "Nvidia's short seller is another story");
    assert.deepEqual(storyOf(stories, scmp.id).publishers, ["scmp.com"]);
    // The veto is what separates them (the defect as shipped: a 3-publisher story led by the Nvidia item).
    const off = clusterItems(all, { ...CLUSTER, subjectVeto: false });
    assert.ok(together(off, scmp, info));
    // One event told from two sides names both companies somewhere: no veto.
    const a = press("OpenRouter Now Powers Inference on Hugging Face", "openrouter.ai", 5, { summary: "Hugging Face users can now route requests through OpenRouter." });
    const b = press("Hugging Face and OpenRouter join forces on inference", "huggingface.co", 4);
    const deal = press("Microsoft keeps its stake as OpenAI restructures", "one.example", 3, { summary: "OpenAI and Microsoft agreed new terms." });
    const deal2 = press("OpenAI restructures, Microsoft keeps its stake", "two.example", 2);
    const more = clusterItems([a, b, deal, deal2, ...background()]);
    assert.ok(together(more, a, b));
    assert.ok(together(more, deal, deal2));
  });

  it("does not count a continent as something two headlines have in common (Schneider Electric / Europe)", () => {
    const sifted = press("Exclusive: Schneider Electric's VC fund brings accelerator scheme to Europe", "sifted.eu", 23);
    const reuters = press("Schneider Electric warns high power costs could push AI investment out of Europe", "reuters.com", 14);
    // "europe" is used elsewhere in the run, as in a real corpus.
    const context = Array.from({ length: 4 }, (_, i) => press(`Zeu${i} startups in Europe zev${i}`, `eu-${i}.example`, 40 + i));
    const stories = clusterItems([sifted, reuters, ...context, ...background()]);
    assert.ok(!together(stories, sifted, reuters));
    // A third shared word makes it one event again.
    const one = press("Schneider Electric warns on power costs in Europe", "one.example", 14);
    const two = press("Power costs threaten AI build-out in Europe, Schneider Electric warns", "two.example", 13);
    assert.ok(together(clusterItems([one, two, ...context, ...background()]), one, two));
  });

  it("needs more than the week's most-named company and a verb (NVIDIA ransomware claims / SEC investigation)", () => {
    const bleeping = press("NVIDIA investigating Gentlemen ransomware breach claims", "bleepingcomputer.com", 19, {
      summary: "NVIDIA is investigating claims of a security breach after the Gentlemen ransomware group added the company to its leak site.",
    });
    const wsj = press("The SEC Is Investigating Nvidia", "wsj.com", 54);
    // A week in which the company is in every other headline (live: 127 of 1,463 documents).
    const week = Array.from({ length: 45 }, (_, i) => press(`Nvidia zna${i} znb${i} znc${i}`, `nv-${i}.example`, 100 + i));
    const all = [bleeping, wsj, ...week, ...background()];
    const stories = clusterItems(all);
    assert.ok(!together(stories, bleeping, wsj));
    const off = clusterItems(all, { ...CLUSTER, ubiquitousShare: 1 });
    assert.ok(together(off, bleeping, wsj), "rule off: the defect as shipped");
    // The same company and a THIRD shared word is an event: two reports of the SEC inquiry merge.
    const reuters = press("Nvidia facing SEC probe after Huang's resignation, WSJ reports", "reuters.com", 55);
    const cnbc = press("SEC is probing Nvidia amid Jensen Huang departure", "cnbc.com", 54);
    const probe = clusterItems([reuters, cnbc, bleeping, ...week, ...background()]);
    assert.ok(together(probe, reuters, cnbc));
    assert.ok(!together(probe, reuters, bleeping));
    // A name few headlines carry still identifies its story with one verb beside it.
    const drupalA = press("Drupal investigating breach claims", "one.example", 8);
    const drupalB = press("Drupal is investigating reported breach", "two.example", 7);
    assert.ok(together(clusterItems([drupalA, drupalB, ...week, ...background()]), drupalA, drupalB));
  });

  it("keeps same-template, different-company headlines apart", () => {
    const a = press("LangChain Raises $300M Series C at $3B Valuation", "langchain.com", 3);
    const b = press("Genesis AI Raises $500M Series A at $3.5B Valuation", "humanoidsdaily.com", 5);
    const c = press("Payhawk announces $280M raise at $2B valuation", "techcrunch.com", 6);
    const stories = clusterItems([a, b, c, ...background()]);
    assert.ok(!together(stories, a, b));
    assert.ok(!together(stories, a, c));
    assert.ok(!together(stories, b, c));
  });
});

describe("cluster: lead selection", () => {
  const filler = background();

  it("prefers press / first-party over an aggregator, whatever the tiers and times", () => {
    const agg = press("Everful raises $48.5M to connect retailers with Chinese factories (TechCrunch)", "techmeme.com", 9, { kind: "aggregator", sourceId: "techmeme", tier: 1 });
    const art = press("Former Alibaba exec's Everful raises $48.5M to connect retailers with Chinese factories", "techcrunch.com", 4, { tier: 3 });
    const s = storyOf(clusterItems([agg, art, ...filler]), art.id);
    assert.equal(s.items.length, 2);
    assert.equal(s.lead, art.id);
  });

  it("prefers an article headline over a live blog, a video and a column", () => {
    const live = press("Anthropic valued at $2tn as shares begin trading after record-breaking IPO – business live", "theguardian.com", 0.1);
    const video = press("Anthropic Makes Trading Debut With Record Breaking IPO", "bloomberg.com", 30, { url: "https://www.bloomberg.com/news/videos/2026-11-19/anthropic-makes-trading-debut" });
    const article = press("Anthropic begins public trading at $2tn valuation after record-breaking IPO", "theguardian.com", 3, { sourceId: "guardian-two" });
    const other = press("Anthropic Shares Rise On Nasdaq After Record IPO as trading begins", "crunchbase.com", 2);
    const s = storyOf(clusterItems([live, video, article, other, ...filler]), article.id);
    assert.ok(s.items.length >= 3);
    assert.ok(isArticleHeadline(s.items[0]));
    assert.ok(!isArticleHeadline(live) && !isArticleHeadline(video));
    assert.ok(!isArticleHeadline({ title: "Anthropic keeps the AI party swinging | Nils Pratley", url: "https://x.example/a" }));
    assert.ok(!isArticleHeadline({ title: "Will Anthropic's IPO Lead To An Exodus of Employees?", url: "https://x.example/b" }));
    assert.ok(!isArticleHeadline({ title: "AI #195: Opening Bell", url: "https://x.example/c" }));
    assert.ok(!isArticleHeadline({ title: "#353 - A Thousand Fewer Paths to Root, Kubernetes Security Logging", url: "https://x.example/c2" }));
    assert.ok(!isArticleHeadline({ title: "The Sequence Opinion - Issue #975: The Architecture of Agentic Swarms", url: "https://x.example/c3" }));
    assert.ok(!isArticleHeadline({ title: "Microsoft Research Focus – Edition #98", url: "https://x.example/c4" }));
    assert.ok(!isArticleHeadline({ title: "Microsoft Ignite 2026: MAI keynote transcript", url: "https://x.example/c5" }));
    // A rank is not an issue number.
    assert.ok(isArticleHeadline({ title: "OpenAI has the #2 model in the Intelligence Index with the release of GPT-6.2 Astra and GPT-6.2 Sol", url: "https://x.example/e" }));
    assert.ok(isArticleHeadline({ title: "Google DeepMind Releases Gemini 4 Neon: 1M Context, #1 on AA Coding Agent Index", url: "https://x.example/f" }));
    assert.ok(isArticleHeadline({ title: "model: add Zaya1 8B (#32071)", url: "https://x.example/g" }));
    assert.ok(isArticleHeadline({ title: "Anthropic raises $81bn in record IPO", url: "https://x.example/d" }));
  });

  it("prefers tier 1-2 over tier 3 over tier 4, then the earliest", () => {
    const t4 = press("Optimizely malware attacks highlight third-party vendor risks for websites", "blog.example", 50, { tier: 4 });
    const t3 = press("Optimizely Malware Attacks Highlight Third-Party Vendor Risks", "darkreading.com", 46, { tier: 3 });
    const t2late = press("Attackers Used Optimizely to A/B Test Malware on Top Websites, highlighting vendor risks", "krebsonsecurity.com", 40, { tier: 2 });
    const t2early = press("Optimizely malware attacks on top websites highlight third-party vendor risks", "therecord.media", 44, { tier: 2 });
    const s = storyOf(clusterItems([t4, t3, t2late, t2early, ...filler]), t3.id);
    assert.equal(s.items.length, 4);
    assert.equal(s.lead, t2early.id);
  });

  it("prefers a press / first-party article over a newsletter issue or a changelog entry, even an earlier one", () => {
    // Live 2026-11-20: TOP #3 and #8 were led by the GitHub Copilot changelog, TOP #7 by a Substack wrap.
    const wrap = press("Nvidia Interim CEO Colette Kress says Nvidia has got this. She’s Right. Q3 Earnings Wrap", "taekim.substack.com", 48, { kind: "newsletter" });
    const report = press("Nvidia Reports $115.8B in Quarterly Revenue Under Interim CEO Colette Kress in Q3 earnings", "eetimes.com", 15, { tier: 3 });
    const s1 = storyOf(clusterItems([wrap, report, ...filler]), report.id);
    assert.equal(s1.items.length, 2);
    assert.equal(s1.lead, report.id, "the later, lower-tier press report leads");

    const note = press("OpenAI’s GPT-6.2 Astra and GPT-6.2 Sol now available", "github.blog", 53, { tags: ["first-party", "changelog"], tier: 1 });
    const article = press("OpenAI has the #2 model in the Intelligence Index with the release of GPT-6.2 Astra and GPT-6.2 Sol", "artificialanalysis.ai", 50, { kind: "scrape" });
    const s2 = storyOf(clusterItems([note, article, ...filler]), note.id);
    assert.equal(s2.items.length, 2);
    assert.equal(s2.lead, article.id);
    assert.ok(isSecondaryFormat(wrap) && isSecondaryFormat(note) && !isSecondaryFormat(report) && !isSecondaryFormat(article));
  });

  it("still lets a newsletter or changelog lead when the story has no press headline", () => {
    const wrap = press("Nvidia Interim CEO Colette Kress says Nvidia has got this. She’s Right. Q3 Earnings Wrap", "taekim.substack.com", 48, { kind: "newsletter" });
    assert.equal(storyOf(clusterItems([wrap, ...filler]), wrap.id).lead, wrap.id);
    // A search feed's copy of the newsletter's own post (same publisher) does not outrank the original.
    const copy = press(wrap.title, "taekim.substack.com", 47, { kind: "query", sourceId: "gn-substack-money", tier: 4, attribution: "link-host" });
    const s = storyOf(clusterItems([wrap, copy, ...filler]), wrap.id);
    assert.equal(s.items.length, 2);
    assert.equal(s.lead, wrap.id);
    // ... and a question / issue-number press headline does not displace it either (rule 2 comes first).
    const question = press("Does Nvidia Got This After Colette Kress and the Q3 Earnings Wrap?", "wired.com", 20);
    assert.equal(storyOf(clusterItems([wrap, question, ...filler]), wrap.id).lead, wrap.id);
  });

  it("orders the Also: line one publisher at a time before repeats", () => {
    const a1 = press("Anthropic raises $81bn in record IPO, the largest ever", "ft.com", 14);
    const a2 = press("Anthropic record IPO raises $81bn in largest ever listing", "ft.com", 13, { sourceId: "ft-two" });
    const b = press("Anthropic Sets Record With $81bn IPO, largest ever", "bloomberg.com", 1, { tier: 3 });
    const c = press("Anthropic raises $81bn in the largest ever IPO on record", "theguardian.com", 3);
    const s = storyOf(clusterItems([a1, a2, b, c, ...filler]), a1.id);
    assert.equal(s.items.length, 4);
    const pubs = s.items.map((i) => i.publisher);
    assert.equal(new Set(pubs.slice(0, 3)).size, 3, "three publishers first");
    assert.ok(pubs.slice(0, 3).includes(pubs[3]), "the repeat publisher comes last");
    assert.deepEqual(s.publishers, [...new Set(pubs)]);
  });

  it("puts the first article of each OTHER counted publisher first: members[0 .. publishers-2] (shared/select visibleStory recounts on this)", () => {
    const lead = press("Anthropic raises $81bn in record IPO, the largest ever", "ft.com", 14);
    const repeat = press("Anthropic record IPO raises $81bn in largest ever listing", "ft.com", 13, { sourceId: "ft-two" });
    const pointer = press("Anthropic raises $81bn in a record IPO, the largest ever listing", "digest.example", 2, { countsForCoverage: false, leadEligible: false, kind: "aggregator" });
    const b = press("Anthropic Sets Record With $81bn IPO, largest ever", "bloomberg.com", 1, { tier: 3 });
    const c = press("Anthropic raises $81bn in the largest ever IPO on record", "theguardian.com", 3);
    const s = storyOf(clusterItems([lead, repeat, pointer, b, c, ...filler]), lead.id);
    assert.equal(s.items.length, 5);
    assert.equal(s.items[0], lead);
    assert.equal(s.publishers.length, 3);
    const counted = s.items.slice(1, s.publishers.length);
    assert.deepEqual(new Set(counted.map((i) => i.publisher)), new Set(["bloomberg.com", "theguardian.com"]));
    assert.ok(counted.every((i) => i.countsForCoverage && i.publisher !== lead.publisher));
    // Repeats and items that do not count follow.
    assert.deepEqual(new Set(s.items.slice(s.publishers.length)), new Set([repeat, pointer]));
  });
});

// ------------------------------------------------------------------------------------------------
// Acceptance on the real corpus
// ------------------------------------------------------------------------------------------------

const corpus = adaptCorpus(loadCorpus(), loadFixtureRegistry(), NOW);
const stories = clusterItems(corpus);
const byTitle = (re: RegExp): NormalizedItem => {
  const hit = corpus.find((i) => re.test(i.title));
  assert.ok(hit, `no corpus item matches ${re}`);
  return hit;
};
const linked = (a: RegExp, b: RegExp): boolean => together(stories, byTitle(a), byTitle(b));
const IPO = /^Anthropic raises \$81bn in record IPO/;

describe("corpus 2026-11-19: structure", () => {
  it("adapts the fixture into a plausible relevance-stage output", () => {
    assert.equal(corpus.length, 1318);
    assert.equal(new Set(corpus.map((i) => i.id)).size, corpus.length);
    assert.ok(corpus.some((i) => i.via.includes("openai-blog")), "same-URL twins are folded into via[]");
  });

  it("keeps every contract invariant", () => {
    const seen = new Set<string>();
    for (const s of stories) {
      assert.equal(s.lead, s.items[0].id);
      assert.deepEqual(s.members, s.items.slice(1).map((i) => i.id));
      assert.deepEqual(s.publishers, coveragePublishers(s.items));
      assert.equal(new Set(s.publishers).size, s.publishers.length);
      for (const i of s.items) {
        assert.ok(!seen.has(i.id), `item in two stories: ${i.title}`);
        seen.add(i.id);
      }
    }
    assert.equal(seen.size, corpus.length);
  });

  it("never spans more than 72 h, never mixes a release with anything but its own repo", () => {
    for (const s of stories) {
      const releases = s.items.filter((i) => i.flags.includes("release"));
      if (releases.length > 0) {
        assert.equal(releases.length, s.items.length, s.items.map((i) => i.title).join(" | "));
        assert.equal(new Set(s.items.map((i) => i.publisher)).size, 1);
        continue;
      }
      const times = s.items.map((i) => Date.parse(i.effectiveAt));
      assert.ok(Math.max(...times) - Math.min(...times) <= CLUSTER.windowHours * HOUR, s.items.map((i) => i.title).join(" | "));
    }
  });

  it("never lets a community / aggregator / release item lead a story that has a press item", () => {
    for (const s of stories) {
      const best = Math.min(...s.items.map(leadClass));
      assert.equal(leadClass(s.items[0]), best, s.items.map((i) => `${i.sourceId}: ${i.title}`).join(" | "));
    }
  });

  it("is deterministic and order-independent on the full corpus", () => {
    const signature = (ss: readonly Story[]): string => ss.map((s) => `${s.lead}:${s.members.join(",")}`).join("|");
    assert.equal(signature(clusterItems([...corpus].reverse())), signature(stories));
  });

  it("clusters the whole corpus well inside a build's time budget", () => {
    const t0 = performance.now();
    clusterItems(corpus);
    assert.ok(performance.now() - t0 < 5000);
  });
});

describe("corpus 2026-11-19: acceptance", () => {
  it("clusters the Anthropic IPO into ONE story with >= 5 publishers (V1: 22 articles, 21 clusters)", (t) => {
    const s = storyOf(stories, byTitle(IPO).id);
    t.diagnostic(`Anthropic IPO story: ${s.publishers.length} publishers, ${s.items.length} items; lead: "${s.items[0].title}" (${s.items[0].sourceName})`);
    for (const i of s.items) t.diagnostic(`  ${i.publisherName.padEnd(24)} ${i.title}`);
    assert.ok(s.publishers.length >= 5, `publishers: ${s.publishers.length}`);
    assert.ok(s.publishers.length >= 12, "regression: 16 publishers / 32 items at the tuned values");
    assert.ok(s.items.length >= 24);
    for (const i of s.items) assert.match(i.title, /anthropic/i, `foreign item in the IPO story: ${i.title}`);
    const outside = corpus.filter((i) => /anthropic/i.test(i.title) && /\bIPO\b|I\.P\.O/i.test(i.title) && Date.parse(i.effectiveAt) > NOW.getTime() - 48 * HOUR && !s.items.includes(i));
    assert.ok(outside.length <= 2, `IPO headlines left out: ${outside.map((i) => i.title).join(" | ")}`);
  });

  it("gives the IPO story a tier-1/2 article headline as its lead", () => {
    const lead = storyOf(stories, byTitle(IPO).id).items[0];
    assert.ok(lead.tier <= 2);
    assert.ok(isArticleHeadline(lead));
    assert.equal(lead.title, "Anthropic raises $81bn in record IPO");
  });

  it("still finds the IPO story after the per-source cap (what the relevance stage really emits)", () => {
    const capped = adaptCorpus(loadCorpus(), loadFixtureRegistry(), NOW, { sourceCap: PIPELINE.sourceCap });
    const capStories = clusterItems(capped);
    const item = capped.find((i) => IPO.test(i.title));
    assert.ok(item);
    const s = storyOf(capStories, item.id);
    assert.ok(s.publishers.length >= 5, `publishers after cap: ${s.publishers.length}`);
    for (const i of s.items) assert.match(i.title, /anthropic/i);
  });

  it("keeps llama.cpp and llama_index (and claude-code / qwen-code) as separate stories", () => {
    const cpp = byTitle(/^llama\.cpp b\d+ released/);
    const index = byTitle(/^llama_index v[\d.]+ released/);
    assert.ok(!together(stories, cpp, index));
    assert.equal(storyOf(stories, cpp.id).items.length, 1);
    assert.equal(storyOf(stories, index.id).items.length, 1);
    assert.ok(!linked(/^claude-code v/, /^qwen-code v/));
  });

  it("never reports 2 publishers for the OpenAI News + OpenAI Blog twins", () => {
    for (const re of [/Performance Factory keeps ChatGPT fast/, /^Managing frontier AI risk/]) {
      const item = byTitle(re);
      assert.equal(item.publisher, "openai.com");
      assert.deepEqual(storyOf(stories, item.id).publishers, ["openai.com"]);
    }
    for (const s of stories) {
      if (s.items.every((i) => i.publisher === "openai.com")) assert.equal(s.publishers.length, 1);
    }
  });

  it("makes the first-party post the lead of the day's model launches", () => {
    assert.equal(storyOf(stories, byTitle(/^Introducing Gemini 4 Neon/).id).items[0].title, "Introducing Gemini 4 Neon");
    assert.equal(storyOf(stories, byTitle(/^Introducing GPT-6\.2 Astra and Sol/).id).items[0].sourceId, "openai-news");
  });

  it("reports the cluster-size distribution (V1: 6 trending rows, 1 of them a real multi-publisher story)", (t) => {
    const sizes = new Map<number, number>();
    for (const s of stories) sizes.set(s.items.length, (sizes.get(s.items.length) ?? 0) + 1);
    const atLeast = (k: number): number => stories.filter((s) => s.publishers.length >= k).length;
    t.diagnostic(`items ${corpus.length} -> stories ${stories.length}`);
    t.diagnostic(`size distribution: ${[...sizes].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
    t.diagnostic(`stories with >= 2 publishers: ${atLeast(2)}; >= 3: ${atLeast(3)}; >= 5: ${atLeast(5)}; >= 8: ${atLeast(8)}`);
    assert.ok(atLeast(2) >= 35 && atLeast(2) <= 70, `>= 2 publishers: ${atLeast(2)}`);
    assert.ok(atLeast(3) >= 8, `>= 3 publishers: ${atLeast(3)}`);
    assert.ok(atLeast(5) >= 4, `>= 5 publishers: ${atLeast(5)}`);
    assert.ok((sizes.get(1) ?? 0) > 0.9 * stories.length, "most stories are single items");
    const big = stories.filter((s) => s.items.length > 8);
    assert.equal(big.length, 1, "exactly one story is big on this day, and it is the IPO");
    assert.match(big[0].items[0].title, /Anthropic/);
  });
});

// Hand-labelled pairs. SAME: one event reported by two outlets. DIFFERENT: must never share a story.
const SAME: [RegExp, RegExp][] = [
  [/^Introducing Gemini 4 Neon/, /^Google ships Gemini 4 Neon/],
  [/^Introducing Gemini 4 Neon/, /^Google DeepMind Releases Gemini 4 Neon/],
  [/^Introducing Gemini 4 Neon/, /^Gemini 4 Neon in GitHub Copilot/],
  [/^Introducing Gemini 4 Neon/, /AINews\] Gemini 4 Neon/],
  [/^Introducing Gemini 4 Neon/, /^Gemini 4 Neon now available on AI Gateway/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /^OpenAI Releases GPT-6\.2 Astra/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /^GPT.6\.2 Astra and GPT.6\.2 Sol$/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /^OpenAI’s GPT-6\.2 Astra and GPT-6\.2 Sol now available/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /AINews\] GPT-6\.2 Astra/],
  [/^Google gives Gemini the ability to use your Mac/, /^Gemini on Mac can now use your computer/],
  [/^Google gives Gemini the ability to use your Mac/, /^Google’s Gemini Can Now Control Mac/],
  [/^Meta Bets on \$300 Muse Charm/, /^Meta’s Muse Charm might cost/],
  [/^Meta Bets on \$300 Muse Charm/, /^Source: Meta plans to charge \$300/],
  [/^Genesis AI Raises \$500M At/, /^Genesis AI Raises \$500M Series A/],
  [/^Genesis AI Raises \$500M At/, /^Genesis AI raises \$500M to deploy/],
  [/^CVE-2026-114938: Critical vulnerability in OpenJDK/, /^Java4Shell vulnerability \(CVE/],
  [/^CVE-2026-114938: Critical vulnerability in OpenJDK/, /^Java4Shell \(CVE-2026-114938\): CrowdStrike/],
  [/Humyn Labs raises \$47M to feed/, /^Humyn Labs raises \$47M to collect/],
  [/Everful raises \$48\.5M/, /^Everful, which connects/],
  [/^Drupal patches critical RCE/, /^Drupal Patches Critical Installer/],
  [/^European Commission confirms cyberattack/, /^EU Commission confirms it was targeted/],
  [/^PHP Fixes 7 Critical Flaws/, /^PHP security updates fix 18/],
  [/^10-Year-Old NGINX/, /^Critical NGINX/],
  [/^Apache warns of Roller RCE/, /^Critical Apache Roller RCE/],
  [/^Attackers Used Optimizely/, /^Optimizely Malware Attacks/],
  [/^Google Selects Bezos/, /^Google picks Bezos/],
  [/^Google Built a Giant .Mirror Dimension/, /^Google built a "Mirror Dimension"/],
  [/^UK court confirms British government served Apple/, /^Apple Gets Win in User Data Court Case/],
  [/^BMO Uses IBM Quantum/, /^BMO Reports Quantum Utility/],
  [/^GlobalFoundries Becomes First Chipmaker to Test Boston/, /^Boston Dynamics’ Atlas humanoid lands/],
  [/^Bull Shows Intel Xeon Diamond Rapids/, /^Intel Diamond Rapids shows signs/],
  [/^NVIDIA Announces Rubin HPC — /, /^NVIDIA Announces Rubin HPC: /],
  [/^Microsoft Patch Tuesday for November 2026/, /^November 2026 Patch Tuesday/],
  [/^ORNL, IBM, AMD launch co-design/, /^IBM, AMD, And Oak Ridge Unveil/],
  [/^OpenRouter Now Powers Inference on Hugging Face/, /^Hugging Face and OpenRouter join forces/],
  [/^No AI Slop: A Manifesto/, /AINews\] The No AI Slop Manifesto/],
  [/^llama\.cpp v1\.0\.0 : A stronger/, /^llama\.cpp v1\.0\.0$/],
  [/^Nvidia CEO Jensen Huang Had an Affair/, /^Following: Jensen Huang’s affair/],
  [/^Nvidia CEO Jensen Huang Had an Affair/, /^The phantom life of Alice Huang/],
  [/^Introducing Gemini 4 Hydrogen/, /^Google rolls out Gemini 4 Hydrogen/],
  [/^Introducing Gemini 4 Hydrogen/, /^Google Search gets a major upgrade with Gemini 4 Hydrogen/],
  [/^Gemini 4 Carbon is now available$/, /^Gemini 4 Carbon is now available in Devin/],
  [/^Ukraine, FBI arrest ransomware/, /^Ukraine exposes ransomware network/],
  [/^The open-source movement wants Jensen Huang back/, /^Jensen wants to come back/],
  [/^Vercel Board is now available/, /^Introducing Vercel Board/],
  [IPO, /^Anthropic Sets Record With/],
  [IPO, /^Anthropic begins public trading at \$2tn/],
  [IPO, /^Anthropic Shares Rise On Nasdaq After Record IPO/],
  [IPO, /^Anthropic Makes Trading Debut With Record/],
  [IPO, /^Anthropic's \$81\.3 billion IPO shatters/],
  [IPO, /^Anthropic opens at \$111\.50 per share in record IPO/],
  [IPO, /^Anthropic valued at \$2tn/],
  [IPO, /^Anthropic hits Nasdaq exchanges/],
  [IPO, /^Anthropic starts trading on Wall Street/],
  [IPO, /^Anthropic Opens Trading at \$111\.5/],
  [IPO, /^Anthropic prices IPO at \$83/],
  [IPO, /^Anthropic's blockbuster debut tests Wall/],
  [IPO, /^Anthropic Makes History on Wall Street/],
];

// Same-story pairs the tuned values do NOT find (recall cost of the precision above). Listed so a
// future change that finds them shows up as a pleasant surprise, not as noise.
const KNOWN_MISSES: [RegExp, RegExp][] = [
  [/^Google gives Gemini the ability to use your Mac/, /^Google adds computer use to Gemini for macOS/], // "Mac" vs "macOS": one shared unit
  [/^Java4Shell vulnerability \(CVE/, /^Java4Shell Flaw Threatens Global/], // one shared name, no CVE id in the title
  [/^Java4Shell Flaw Threatens Global/, /^Critical Java vulnerability puts millions/],
  [/^Jensen Huang Resigns After Having Another/, /AINews\] Jensen Huang resigns after 33/], // cosine 0.28
];

const DIFFERENT: [RegExp, RegExp][] = [
  [/^llama\.cpp b\d+ released/, /^llama_index/],
  [/^claude-code v/, /^qwen-code v/],
  [/^Introducing Gemini 4 Neon/, /^Genie 4 is now available/],
  [/^Introducing Gemini 4 Neon/, /^Introducing Gemini 4 Hydrogen/],
  [/^Introducing Gemini 4 Hydrogen/, /^Gemini 4 Carbon is now available$/],
  [/^Gemini 4 Hydrogen is now available in Devin/, /^Gemini 4 Carbon is now available in Devin/],
  [/^Introducing Gemini 4 Neon/, /^Google gives Gemini the ability to use your Mac/],
  [/^Introducing Gemini 4 Neon/, /^Gemini 4 safety reports/],
  [/^Meta Bets on \$300 Muse Charm/, /^Meta’s AI agent Muse is mixing up/],
  [/^Meta Bets on \$300 Muse Charm/, /^Meta Welcomes Loblaw/],
  [/^Meta Bets on \$300 Muse Charm/, /^As Meta bets big on Muse AI agent/],
  [/^Meta’s AI agent Muse is mixing up/, /^Meta Welcomes Loblaw/],
  [/^Genesis AI Raises \$500M At/, /^LangChain Raises \$300M/],
  [/^Genesis AI Raises \$500M At/, /^Agile Robots raises/],
  [/^Genesis AI Raises \$500M At/, /Payhawk announces/],
  [/^LangChain Raises \$300M/, /Payhawk announces/],
  [/^Drupal patches critical RCE/, /^F5 Warns 6 Critical/],
  [/^Drupal patches critical RCE/, /^PHP Fixes 7 Critical/],
  [/^PHP Fixes 7 Critical/, /^Critical NGINX/],
  [/^PHP Fixes 7 Critical/, /^Critical Apache Roller/],
  [/^Perplexity Launches Orchestrator API/, /AINews\] Perplexity hits a \$1B/],
  [/^Perplexity Launches Orchestrator API/, /^Perplexity Computer Adds Multiagent/],
  [/^IQM Researchers Benchmark Projected Quantum Kernels/, /^Building the Agent Host Protocol/],
  [/^IQM Researchers Benchmark Projected Quantum Kernels/, /^IQM and AMD Demonstrate/],
  [/^Decision Models in Hugging Face/, /^Hugging Face appears to be hosting/],
  [/^Decision Models in Hugging Face/, /^Pay for Hugging Face Hub/],
  [/^How to Prevent Prompt Injection in AI Agents/, /^CapLite Tests/],
  [/^NSF ACCESS Earns 2 HPCwire/, /^Classiq Collaborations/],
  [/^The best things in open source are built/, /^7 Best Open-Source Platforms/],
  [/^US Stocks Drop for Sixth Day/, /^Quantum Stocks Are Headed/],
  [/^Time-Series Models in the Streamhouse/, /^Recurrent Domain Incremental/],
  [/^Nvidia allegedly engineered scarcity/, /^Engineered for Agentic AI/],
  [/^When One GPU Isn’t Enough/, /^How Many People Can One NVIDIA DGX/],
  [/^Optimizing Muse Spark Open on TPU/, /^Reinforcement Learning: Optimizing 0\.6B/],
  [/^At All Hands, Nvidia Interim CEO/, /^Nvidia Reports \$115\.8B/],
  [/^Quandela Expands International/, /^Quandela and NVIDIA Benchmark/],
  [/^Quandela Expands International/, /^Quandela and Hermes-Epitek/],
  [/^Promptfoo vs Giskard/, /^DeepTeam vs Giskard/],
  [/^Jensen Huang should resign/, /^Nvidia CEO Jensen Huang Had an Affair/],
  [/^Opus 5\.5 Forecast/, /^Microsoft says its new AI coding model rivals Claude Opus/],
  [/^Amazon warns NYC customers/, /^I Tried New York City/],
  [/^Gemini 4 Neon now available on AI Gateway/, /^Decision-1\.1 now available on AI Gateway/],
  [/^Liquid AI's d1\.2/, /^Decision-1\.1 now available on AI Gateway/],
  [IPO, /^Anthropic Adds Code Mode/],
  [IPO, /^Anthropic Pushes the Reset Button/],
  [IPO, /^NVIDIA Q3 FY27: A Record Quarter/],
  [IPO, /^PwC’s IPO Lead/],
  [/^Fed officials expect more rate hikes/, /^Fed's Barr Says/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /^ThreatsDay: GPT-6\.2 Jailbreak/],
  [/^Introducing GPT-6\.2 Astra and Sol/, /^Astra for Law leads/],
  [/^Claude Fable 5\.2 is now available in Devin/, /^Gemini 4 Carbon is now available in Devin/],
  [/^NVIDIA Sweeps MLPerf/, /^NVIDIA Announces Rubin HPC — /],
  // Two METR reports that share a company and a year: merged until calendar tokens stopped counting.
  [/^Review of the "Risks from automated R&D"/, /^Independent Assessment of AI R&D Acceleration/],
];

// Different-story pairs the tuned values DO merge (the precision cost): a bond sale filed under the
// summit it was timed for. The live false merges of 2026-11-20 - "Genie 4 is now available on the
// Gemini API." and "Gemini 4 Hydrogen Takes Over From Gemini Robotics ER 2" inside the "Introducing
// Gemini 4 Neon" story - are not in this fixture; the distinct-product veto that removes them is
// pinned by "keeps a different versioned product out of a launch story" above, on the live titles.
const KNOWN_FALSE_MERGES: [RegExp, RegExp][] = [
  [/^China Sells \$2 Billion of Dollar Bonds/, /^Three things to watch as Trump/],
];

describe("corpus 2026-11-19: hand-labelled pairs", () => {
  it(`keeps ${SAME.length} same-story pairs together`, () => {
    const broken = SAME.filter(([a, b]) => !linked(a, b)).map(([a, b]) => `${a} ~ ${b}`);
    assert.deepEqual(broken, []);
  });

  it(`keeps ${DIFFERENT.length} different-story pairs apart`, () => {
    const merged = DIFFERENT.filter(([a, b]) => linked(a, b)).map(([a, b]) => `${a} ~ ${b}`);
    assert.deepEqual(merged, []);
  });

  it("documents the known recall and precision cost of the tuned values", (t) => {
    const missed = KNOWN_MISSES.filter(([a, b]) => !linked(a, b)).length;
    const falseMerges = KNOWN_FALSE_MERGES.filter(([a, b]) => linked(a, b)).length;
    const same = SAME.length + KNOWN_MISSES.length;
    const different = DIFFERENT.length + KNOWN_FALSE_MERGES.length;
    t.diagnostic(`recall on labelled same-story pairs: ${same - missed}/${same}; false merges on labelled different-story pairs: ${falseMerges}/${different}`);
    assert.ok(missed <= KNOWN_MISSES.length && falseMerges <= KNOWN_FALSE_MERGES.length);
  });
});

// The 25 largest clusters, hand-checked on 2026-11-19 for purity (one story per cluster):
// 24 pure, 1 borderline (#6: a Bloomberg bond-sale item filed under the Trump-Xi-Putin summit, a
// non-AI story the relevance gate removes). Re-read on 2026-11-20 after the fix round: the impure
// METR cluster (two different reports + a cross-post) is now the report and its cross-post only
// and left the list; #7 is led by Platformer's article instead of a newsletter issue. Re-read after
// the final fix round: the corroborated second pass adds one pair, Bloomberg's "Anthropic Makes
// Historic Debut on Nasdaq" with Techmeme's headline of the same debut (one event, cosine 0.36) -
// pure, though it belongs to the IPO story it sits beside; "Genie 4 is now available" (2, 2) moved
// to rank 26.
// [lead title, items, publishers]. If this list changes, re-read the clusters before updating it.
const LARGEST: [string, number, number][] = [
  ["Anthropic raises $81bn in record IPO", 32, 16],
  ["Introducing Gemini 4 Neon", 8, 8],
  ["Introducing GPT-6.2 Astra and Sol", 6, 6],
  ["Claude Fable 5.2 is now available in Devin", 6, 6],
  ["Gemini 4 Hydrogen is now available in Devin", 5, 5],
  ["Three things to watch as Trump, Xi and Putin meet in China", 5, 2],
  ["Following: Jensen Huang’s affair with an alleged Chinese spy and GPU smuggler", 4, 4],
  ["NVIDIA Sweeps MLPerf Training and Endpoints as Vera Rubin Debuts With Leading Performance", 4, 2],
  ["Meta Bets on $300 Muse Charm to Boost AI Hardware Business", 3, 3],
  ["Google gives Gemini the ability to use your Mac for you", 3, 3],
  ["CVE-2026-114938: Critical vulnerability in OpenJDK Java", 3, 3],
  ["Genesis AI Raises $500M At $3.5B Valuation To Bring Its Robots To Factories And Warehouses", 3, 3],
  ["Gemini 4 Carbon is now available in Devin", 3, 3],
  ["BMO Uses IBM Quantum Computers to Identify Which Inputs Matter Most to AI Models", 2, 2],
  ["Anthropic Makes Historic Debut on Nasdaq", 2, 2],
  ["Google Selects Bezos’ Blue Origin for Data Center Satellite Test", 2, 2],
  ["Google Built a Giant ‘Mirror Dimension’ Internet to Test Its Chrome AI Agents", 2, 2],
  ["Former Alibaba exec’s Everful raises $48.5M to connect retailers with Chinese factories", 2, 2],
  ["UK court confirms British government served Apple with secret encryption notice", 2, 2],
  ["PHP Fixes 7 Critical Flaws, Including Bugs That Could Allow Remote Code Execution", 2, 2],
  ["European Commission confirms cyberattack, says hackers used AI tool", 2, 2],
  ["Drupal patches critical RCE flaw, warns exploits may surface quickly", 2, 2],
  ["Ukraine, FBI arrest ransomware gang members tied to $40M in ransoms", 2, 2],
  ["GlobalFoundries Becomes First Chipmaker to Test Boston Dynamics' Atlas", 2, 2],
  ["10-Year-Old NGINX HTTP/2 Flaw Lets Unauthenticated Attackers Execute Code on Servers", 2, 2],
];

describe("corpus 2026-11-19: the 25 largest clusters", () => {
  it("are the 25 hand-checked ones (24 pure, 1 borderline)", () => {
    const time = (s: Story): number => Date.parse(s.items[0].effectiveAt);
    const ranked = [...stories].sort((a, b) => b.items.length - a.items.length || b.publishers.length - a.publishers.length || time(b) - time(a));
    const actual = ranked.slice(0, LARGEST.length).map((s): [string, number, number] => [s.items[0].title, s.items.length, s.publishers.length]);
    assert.deepEqual(actual, LARGEST);
  });
});
