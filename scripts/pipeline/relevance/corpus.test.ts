// The gate on the real 2026-11-19 corpus (2,297 items of a full live fetch).
//
// A stage directory may not import a sibling stage (test/boundaries.test.ts), so this test cannot
// run normalize. The corpus was captured from V1's fetcher AFTER its text cleanup (titles decoded,
// summaries plain text, dates parsed), so each record is turned into a NormalizedItem directly.
// The numbers of the true normalize -> relevance composition differ by one item (see MEASURED).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSection } from "../../../shared/sections";
import { isHttpUrl } from "../../../shared/url";
import { FIXTURE_NOW_ISO, makeNormalized } from "../../../test/helpers/factories";
import { loadCorpus, loadFixtureRegistry, type CorpusRecord } from "../../../test/helpers/fixtures";
import { resolveSource } from "../../registry/defaults";
import type { ResolvedSource } from "../../registry/types";
import { createTestContext, PIPELINE } from "../context";
import type { DropReason, NormalizedItem, Registry, RelevanceOutput } from "../types";
import { filterRelevance } from "./index";

function toItem(rec: CorpusRecord, src: ResolvedSource): NormalizedItem {
  return makeNormalized({
    url: rec.link,
    title: rec.title,
    summary: rec.summaryHtml || null,
    sourceId: src.id,
    sourceName: src.name,
    publisher: src.publisher,
    kind: src.kind,
    scope: src.scope,
    home: src.home,
    tier: src.tier,
    tags: src.tags,
    routing: src.routing,
    routeTo: src.routeTo,
    leadEligible: src.leadEligible,
    countsForCoverage: src.countsForCoverage,
    attribution: src.attribution,
    publishedAt: rec.v1.publishedAt,
    firstSeenAt: FIXTURE_NOW_ISO,
  });
}

interface Run {
  items: NormalizedItem[];
  out: RelevanceOutput;
  /** item -> "kept" or its drop reason (items are distinct objects; twin feeds share ids). */
  fate: Map<NormalizedItem, DropReason | "kept">;
}

/** Run the gate over the corpus; `general` lists extra source ids to treat as scope "general". */
function runCorpus(general: readonly string[] = []): Run {
  const base = loadFixtureRegistry();
  const registry: Registry = { ...base, sources: base.sources.map((s) => (general.includes(s.id) ? { ...s, scope: "general" as const } : s)) };
  const byId = new Map(registry.sources.map((s) => [s.id, resolveSource(s)]));
  const items = loadCorpus()
    .filter((r) => isHttpUrl(r.link))
    .map((r) => toItem(r, byId.get(r.sourceId)!));
  const out = filterRelevance(items, registry, createTestContext());
  const kept = new Set(out.kept);
  const fate = new Map<NormalizedItem, DropReason | "kept">();
  // Dropped records come out in two passes (judged, then capped), each in input order.
  const queues = new Map<string, DropReason[]>();
  for (const d of out.dropped) {
    const k = `${d.sourceId}\u0000${d.url}`;
    queues.set(k, [...(queues.get(k) ?? []), d.reason]);
  }
  for (const i of items) fate.set(i, kept.has(i) ? "kept" : (queues.get(`${i.sourceId}\u0000${i.url}`)?.shift() ?? "kept"));
  return { items, out, fate };
}

const tally = (run: Run, pred: (i: NormalizedItem) => boolean): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const i of run.items) if (pred(i)) t[run.fate.get(i)!] = (t[run.fate.get(i)!] ?? 0) + 1;
  return t;
};
const isOwnerDesk = (i: NormalizedItem): boolean => findSection(i.home)?.desk === "owner";
const fateOf = (run: Run, sourceId: string, title: string): string => {
  const item = run.items.find((i) => i.sourceId === sourceId && i.title === title);
  assert.ok(item, `corpus item not found: ${sourceId} | ${title}`);
  return run.fate.get(item)!;
};

describe("relevance on the 2026-11-19 corpus (fixture registry as shipped)", () => {
  const run = runCorpus();

  // MEASURED 2026-11-19 corpus, fixture registry (35 general sources, 13 of them cyber):
  //   general-source items            436   kept 211 · off_topic 91 · too_old 90 · source_cap 41 · noise 3
  //     gated (AI-desk home)          291   kept 133 · off_topic 91 · too_old 51 · source_cap 13 · noise 3
  //     owner desk (cyber), no gate   145   kept  78 ·                too_old 39 · source_cap 28
  //   of the 237 in-window, non-noise gated items the gate passes 146 (62%) and drops 91 (38%)
  // Final fix round: two Newcomer items left the kept side - the organiser's "... Join Cerebral Valley
  // Speaker Lineup Ahead of Our Summit" (noise: event) and "Big Tech Defied Tradition With a Risky Bet
  // on Trump", whose only AI mention was the teaser line "Plus, Anthropic S-1 reactions" (off_topic) -
  // and two Newcomer items the cap had cut took their slots (90/43/2 -> 91/41/3).
  // (92 drops before the review's PF-1 beat terms: Stratechery's "Apple Permissions Update ..." and
  // GitHub's "Inside GitHub's new Git storage architecture" now pass on "agent".)
  // The true normalize -> relevance pipeline gives the same numbers minus one off_topic item
  // (435 / 89): TechCrunch Startups' copy of the Everful story is folded into TechCrunch AI's.
  it("measures kept vs dropped for general sources", () => {
    const general = tally(run, (i) => i.scope === "general");
    const gated = tally(run, (i) => i.scope === "general" && !isOwnerDesk(i));
    const owner = tally(run, (i) => i.scope === "general" && isOwnerDesk(i));
    assert.deepEqual(general, { kept: 211, off_topic: 91, too_old: 90, source_cap: 41, noise: 3 });
    assert.deepEqual(gated, { kept: 133, off_topic: 91, too_old: 51, source_cap: 13, noise: 3 });
    assert.deepEqual(owner, { kept: 78, too_old: 39, source_cap: 28 });
  });

  it("never applies the gate to scope 'ai' sources or to the owner desk", () => {
    for (const [item, f] of run.fate) {
      if (f === "off_topic") assert.ok(item.scope === "general" && !isOwnerDesk(item), `${item.sourceId} | ${item.title}`);
    }
    assert.equal(tally(run, (i) => i.scope === "ai").off_topic, undefined);
  });

  it("drops the off-mission stories the review named", () => {
    const named: [string, string][] = [
      ["bloomberg-markets", "Bloomberg Green New York 2026 Highlights"],
      ["bloomberg-markets", "Fed's Barr Says Inflation Calls for Further Policy Adjustment"],
      ["bloomberg-markets", "Australia’s Leader to Navigate Trade, Security in Talks With Xi"],
      ["bloomberg-markets", "War-Driven Cost Squeeze Alarms Companies, Bank of America Says"],
      ["bloomberg-markets", "Copper Rebounds After Rout as Physical Tightness Persists"],
      ["bloomberg-markets", "Crunch Fitness Sells $800 Million of ABS Tied to Franchise Deals"],
      ["bloomberg-tech", "Sofia Franklyn’s ‘Call Her Daddy’ Tell-All Is Riveting Podcasters and Their Fans"],
      ["crunchbase-news-ai", "The Blue Economy: The World’s Quietest Economic Engine And Its Smartest Cities"],
      ["toms-hardware", "Pakistan undersea cable fault causes internet failure near Strait of Hormuz"],
      ["hpc-wire", "NSF ACCESS Earns 2 HPCwire Awards at SC26"],
      ["ee-times", "Gartner Warns of Risks Behind Sovereign Tech Claims"],
      ["404-media", "High-End Furniture Marketplace AptDeco Is Taking People’s Furniture and Not Paying Them"],
      ["wsj-tech", "What the Blue Wave in Texas Means for Elon Musk’s Tesla and SpaceX"],
      ["cnbc-tech", "U.S. crude oil declines to $85 a barrel on recovering Middle East exports"],
      ["marketwatch", "Social Security should be shut down, this Republican senator says"],
    ];
    for (const [source, title] of named) assert.equal(fateOf(run, source, title), "off_topic", title);
    const everful = run.items.find((i) => i.sourceId === "techmeme" && i.title.startsWith("Everful, which connects smaller retailers"));
    assert.equal(everful && run.fate.get(everful), "off_topic");
  });

  it("keeps the AI stories of the same general feeds", () => {
    const named: [string, string][] = [
      ["bloomberg-markets", "Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book"],
      ["bloomberg-markets", "Stocks Fall as Anthropic Debut Not an AI All-Clear: Markets Wrap"],
      ["bloomberg-markets", "Big Checks and Big Blobs of Compute"],
      ["bloomberg-tech", "Anthropic Shares Soar Above IPO Price, Then Fall"],
      ["bloomberg-tech", "Nscale’s ByteDance Deal Faces Scrutiny Under US Chip Curbs"],
      ["bloomberg-tech", "Google’s Gemini Can Now Control Mac Devices on Users’ Behalf"],
      ["cnbc-tech", "JPMorgan is working on AI agent transactions that don’t involve humans"],
      ["wsj-tech", "Deutsche Telekom’s Tech Fund Invests $110 Million in Mistral AI"],
      ["marketwatch", "Why Micron, Broadcom and other AI stocks have given up their gains"],
      ["hpc-wire", "MinIO Announces General Availability of AIStor Memory at SC26"],
      ["servethehome", "November 2026 Top500 New Systems Are Few and Far Between"],
      ["toms-hardware", "Intel 18A yields hit 70% as company signs Microsoft as EMIB customer"],
      ["techcrunch-startups", "India’s Humyn Labs raises $47M to feed US robotics companies the data they need"],
      ["crunchbase-news-ai", "Genesis AI Raises $500M At $3.5B Valuation To Bring Its Robots To Factories And Warehouses"],
      ["404-media", "The Department of Justice Is Using AI Detector Pangram Against Defense Attorneys"],
      ["platformer", "The AI backlash needs a plan"],
      ["github-blog", "Beyond code generation: A developer’s guide to agentic engineering"],
    ];
    for (const [source, title] of named) assert.equal(fateOf(run, source, title), "kept", title);
    const amd = run.items.find((i) => i.sourceId === "techmeme" && i.title.startsWith("AMD's shares fall 6%+ after Hunterbrook"));
    assert.equal(amd && run.fate.get(amd), "kept", "a story the editorial review listed as missed");
  });

  it("keeps the owner desk's general cyber wire untouched by the gate", () => {
    const cyber = run.items.filter((i) => i.home === "cyber" && i.scope === "general");
    assert.ok(cyber.length > 100);
    const php = cyber.find((i) => /PHP/.test(i.title));
    assert.ok(php && run.fate.get(php) !== "off_topic");
    assert.ok((tally(run, (i) => i.sourceId === "bleepingcomputer").kept ?? 0) === PIPELINE.sourceCap);
  });

  it("filters noise in first-party feeds", () => {
    assert.equal(fateOf(run, "nvidia-blog", "Season’s Streamings and Savings: Black Friday Deals Come to GeForce NOW"), "noise");
    assert.equal(fateOf(run, "pytorch-blog", "Call for Proposals: PyTorch Day China 2026"), "noise");
    assert.equal(fateOf(run, "toms-hardware", "Save 36% on this 4TB Samsung 990 Pro SSD upgrade for your gaming PC, now just 17.5 cents per GB"), "noise");
    assert.equal(fateOf(run, "dark-reading", "Why Holiday Security Can't Wait for Black Friday") === "noise", false, "a story about Black Friday fraud is a story");
  });

  it("no source exceeds the cap and every item is accounted for", () => {
    const perSource = new Map<string, number>();
    for (const i of run.out.kept) perSource.set(i.sourceId, (perSource.get(i.sourceId) ?? 0) + 1);
    assert.ok(Math.max(...perSource.values()) <= PIPELINE.sourceCap);
    assert.equal(run.out.kept.length + run.out.dropped.length, run.items.length);
    assert.ok(run.out.dropped.every((d) => d.stage === "relevance" && !!d.detail));
    // The cap keeps the freshest: nothing dropped by the cap is newer than something kept from that source.
    const oldestKept = new Map<string, number>();
    for (const i of run.out.kept) oldestKept.set(i.sourceId, Math.min(oldestKept.get(i.sourceId) ?? Infinity, Date.parse(i.effectiveAt)));
    for (const [item, f] of run.fate) if (f === "source_cap") assert.ok(Date.parse(item.effectiveAt) <= oldestKept.get(item.sourceId)!, item.title);
  });

  it("general feeds keep their AI items instead of their newest items (cap after relevance)", () => {
    const bm = run.items.filter((i) => i.sourceId === "bloomberg-markets");
    const kept = bm.filter((i) => run.fate.get(i) === "kept");
    assert.equal(bm.length, 15);
    assert.deepEqual(kept.map((i) => i.title).sort(), ["Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book", "Big Checks and Big Blobs of Compute", "Stocks Fall as Anthropic Debut Not an AI All-Clear: Markets Wrap"]);
  });
});

describe("relevance on the corpus with the review's scope corrections", () => {
  // The fixture registry (derived mechanically from V1) marks the Meta newsroom, the NVIDIA blog
  // and Simon Willison's everything-feed as scope "ai". The review asked for them to be gated
  // (routing finding 4, sources-taxonomy finding 3); WP1's registry decides. With them gated:
  const run = runCorpus(["meta-ai-blog", "nvidia-blog", "simon-willison"]);

  it("drops the non-AI Meta newsroom and link-blog items the review named", () => {
    for (const [source, title] of [
      ["meta-ai-blog", "Meta premieres India’s First Government-Led Microdrama Series on Scams Awareness"],
      ["meta-ai-blog", "Forum, a Dedicated App for Facebook Groups, Is Now Available in Indonesia"],
      ["meta-ai-blog", "Introducing Direct: An App Just for Messaging"],
      ["simon-willison", "The PSF end-of-year fundraiser"],
    ] as const) {
      assert.equal(fateOf(run, source, title), "off_topic", title);
    }
  });

  it("keeps their AI items", () => {
    for (const [source, title] of [
      ["meta-ai-blog", "Muse Is Now Available in Australia: The World’s First Personal AI Agent Built for Everyone"],
      ["meta-ai-blog", "94% of Singapore Small Business Owners Surveyed Say More AI Guidance Is Needed"],
      ["nvidia-blog", "NVIDIA Announces Rubin HPC — A New GPU to Accelerate Agents for Science, Engineering and Analytics"],
      ["simon-willison", "GPT‑6.2 Astra and GPT‑6.2 Sol"],
    ] as const) {
      assert.notEqual(fateOf(run, source, title), "off_topic", title);
    }
  });
});

describe("gate precision: 60 hand-checked decisions", () => {
  // Sample: the 238 in-window, non-noise items of gated general sources, sorted by V1 id; every
  // k-th passing item (30) and every k-th failing item (30). Labels were assigned by the WP3 author
  // (an AI agent, not the site owner) reading title + summary against the site's mission (AI,
  // incl. the chips / robotics desks) - an estimate to be re-checked by a person:
  //   on  = belongs on an AI news page      off = does not
  // KEEP precision 28/30 = 93% (26/30 = 87% if the two plain server-CPU items also count as off).
  // DROP precision was 27/30 = 90%: three AI-adjacent pieces whose headline never says so. Two of
  // them now pass on the desk's beat word "agent" (review PF-1: in the title for an ANALYSIS source,
  // opening the summary for an AGENTS & TOOLS source) and moved to RECOVERED; DROP is 27/28 = 96%.
  const KEEP: [id: string, label: "on" | "off", title: string][] = [
    ["106jdfp", "on", "AMD's shares fall 6%+ after Hunterbrook disclosed a short position"],
    ["106jdgh", "on", "Google built a \"Mirror Dimension\", an isolated internet … to test AI agents"],
    ["11xw277", "on", "OpenAI: ChatGPT Search Is About 20% of Google’s"],
    ["13eyae9", "on", "Liquid AI's d1.2 and d1.2-ultra are now available on AI Gateway"],
    ["15ceeh6", "on", "Nvidia Partners Unveil New HPC Systems and Infrastructure at SC26"],
    ["18kqnvu", "on", "What Google and Reddit's bad days have in common (AI search)"],
    ["1c3k38e", "on", "Intel Diamond Rapids shows signs of life in SC26 demo (server CPU; compute desk)"],
    ["1e4upek", "on", "Bitcoin Spikes Lower as Anthropic Fails to Sustain Risk Appetite"],
    ["1fo8jsr", "on", "Robot moth grows new sensor using its own blood"],
    ["1hzinpd", "on", "Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book"],
    ["1kuex2q", "off", "Beyond One Turn: How a Single-Chip Multiturn Position Sensor … (vendor advertorial)"],
    ["1mxddpm", "on", "Parallel web search is free on AI Gateway"],
    ["1ojpx6t", "on", "Anthropic Broke All the Startup Rules & Won"],
    ["1ripkaf", "on", "Developer vibe codes Windows 11 alternative operating system"],
    ["1t5iubc", "on", "An Interview With Eric Seufert About Agentic Commerce"],
    ["1viyzzs", "on", "Dnotitia Presents … VDPU Vector Search ASIC at SC26"],
    ["2dhzyl", "on", "Why Are We All Just Waiting For The Inevitable AI-Driven Catastrophe"],
    ["6e3w5z", "on", "Koduri’s Oxmiq Offers IP, Tools for Indian Teams to Design AI Chips"],
    ["831z6m", "on", "How Nvidia turmoil and a Democratic Congress could reshape the AI trade"],
    ["99b6mq", "off", "Nvidia GeForce driver bug reportedly hammers SSDs (gaming driver)"],
    ["ab9w07", "on", "Eight Thoughts On Anthropic’s IPO"],
    ["bm8n6c", "on", "Nvidia Crises, Anthropic IPO & Off-the-Charts Demand"],
    ["drla2o", "on", "Thousands of Anthropic Employees and Investors Are Set to Reap Fortunes"],
    ["fe5a7k", "on", "The Department of Justice Is Using AI Detector Pangram"],
    ["jroy7u", "on", "Datacenter Systems Spending To Go Through The Roof In 2027"],
    ["kposhs", "on", "Deutsche Telekom’s Tech Fund Invests $110 Million in Mistral AI"],
    ["nhjkwd", "on", "Bull Shows Intel Xeon Diamond Rapids Package at SC26 (server CPU; compute desk)"],
    ["ql3v1w", "on", "See How Data Centers Became the Growth Engine of America’s Power Grid"],
    ["ufwnxw", "on", "Nvidia Breaks Revenue And Profit Records"],
    ["wld9e5", "on", "Beyond code generation: A developer’s guide to agentic engineering"],
  ];
  const DROP: [id: string, label: "on" | "off", title: string][] = [
    ["106jdfm", "off", "StepSecurity (software supply chain security) raised a $20M Series A"],
    ["106jdgg", "off", "Alphabet plans to raise at least CA$5B in a Canadian bond sale"],
    ["106jdgk", "off", "Everful, which connects smaller retailers and brands with Chinese factories"],
    ["11yz5hp", "off", "War-Driven Cost Squeeze Alarms Companies, Bank of America Says"],
    ["132kmr6", "off", "Vercel Board is now available"],
    ["15d2zdy", "off", "Quantinuum Aligns Software Development For Quantum Hardware Generations"],
    ["15zis5j", "off", "To Catch a Ransomware Scammer, FBI Posed as Both Victim and Attacker"],
    ["19fhx9", "off", "The Blue Economy: The World’s Quietest Economic Engine"],
    ["19s5uw1", "off", "Fed’s Waller says central bank may need to ‘shock people’"],
    ["1c2pa9m", "off", "Medicare beneficiaries could skip the nursing home"],
    ["1czya6j", "off", "Social Security should be shut down, this Republican senator says"],
    ["1frc8l4", "off", "We’re in our 50s and terrified of a market crash"],
    ["1i7alm8", "on", "Public Markets Are Frequently Wrong. The SaaSpocalypse Shows Us Why (AI vs SaaS; headline silent)"],
    ["1l3k9p3", "off", "Speed Insights now measures soft navigations"],
    ["1pt6irx", "off", "China’s slowdown deepens in October"],
    ["1qroh02", "off", "Copper Rebounds After Rout as Physical Tightness Persists"],
    ["1s7dit0", "off", "DDR6 RAM shrinks by 44% (PC memory standard)"],
    ["1usuych", "off", "Lakes Are Bizarrely Syncing Up Globally"],
    ["1yjzn3u", "off", "Fed's Barr Says Inflation Calls for Further Policy Adjustment"],
    ["3akxni", "off", "Critical Java vulnerability puts millions of sites at risk"],
    ["6p7phv", "off", "NSF ACCESS Earns 2 HPCwire Awards at SC26"],
    ["ayr6h7", "off", "Vercel Drives now reads files up to 6x faster"],
    ["cga34q", "off", "Spend management platform Payhawk announces $280M raise"],
    ["ggdetf", "off", "I watched Trump, Xi and Putin gather in China"],
    ["k7ccji", "off", "Standard builds move to usage-based billing for new teams"],
    ["pj8xwz", "off", "Three things to watch as Trump, Xi and Putin meet in China"],
    ["rburi2", "off", "Git security vulnerabilities announced"],
    ["viybaa", "off", "Hank Green is self-funding ClockwiseTV"],
  ];
  const RECOVERED: [id: string, label: "on" | "off", title: string][] = [
    ["hu64sa", "on", "Apple Permissions Update, The New App Paradigm (summary opens: \"... they don't fix the agent problem\")"],
    ["t772nh", "on", "Inside GitHub’s new Git storage architecture (summary opens: \"... so thousands of agents can push\")"],
  ];
  const run = runCorpus();
  const general = run.items.filter((i) => i.scope === "general" && !isOwnerDesk(i));
  const decision = (id: string): string => {
    const item = general.find((i) => i.id === id);
    assert.ok(item, `sample item ${id} not in the corpus`);
    const f = run.fate.get(item)!;
    return f === "source_cap" ? "kept" : f; // the cap is not a gate decision
  };

  it("the sample is 30 keeps + 28 drops + 2 recovered wrong drops and every decision still holds", () => {
    assert.equal(KEEP.length, 30);
    assert.equal(DROP.length, 28);
    assert.equal(RECOVERED.length, 2);
    assert.equal(new Set([...KEEP, ...DROP, ...RECOVERED].map((s) => s[0])).size, 60);
    for (const [id, , title] of KEEP) assert.equal(decision(id), "kept", title);
    for (const [id, , title] of RECOVERED) assert.equal(decision(id), "kept", title);
    for (const [id, , title] of DROP) assert.equal(decision(id), "off_topic", title);
  });

  it("precision: keeps >= 90% on-mission, drops >= 90% off-mission", () => {
    const keepPrecision = KEEP.filter((s) => s[1] === "on").length / KEEP.length;
    const dropPrecision = DROP.filter((s) => s[1] === "off").length / DROP.length;
    assert.equal(Math.round(keepPrecision * 100), 93);
    assert.equal(Math.round(dropPrecision * 100), 96);
    assert.ok(RECOVERED.every((s) => s[1] === "on"));
  });
});
