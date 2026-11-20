import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOP_STORIES_MAX } from "../../../shared/contract";
import { findSection } from "../../../shared/sections";
import { FIXTURE_NOW_ISO, hoursAgo, makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import { PIPELINE, topStanding } from "../context";
import type { NormalizedItem, PipelineState, ScoredStory, TopMemory } from "../types";
import { ROUTE_POLICY } from "./rules";
import { foldRunningStories, isFollowUp, sameRunningStory, signatureOf } from "./running";
import { compareTop, isTopEligible, pickTop, type TopInput } from "./top";

const now = new Date(FIXTURE_NOW_ISO);
let seq = 0;

interface Spec {
  /** Distinct publishers covering the story (default 1). */
  pubs?: number;
  hours?: number;
  score?: number;
  title?: string;
  lead?: Partial<NormalizedItem>;
}

/** A story with `pubs` items from distinct publishers; the first one leads. */
function story(o: Spec = {}): ScoredStory {
  seq += 1;
  const n = o.pubs ?? 1;
  const items = Array.from({ length: n }, (_, i) =>
    makeNormalized({
      title: i === 0 ? (o.title ?? `Story ${seq}`) : `Story ${seq} (outlet ${i})`,
      publisher: `pub-${seq}-${i}`,
      sourceId: `src-${seq}-${i}`,
      publishedAt: hoursAgo((o.hours ?? 2) + i),
      ...(i === 0 ? o.lead : {}),
    }),
  );
  return makeScoredStory(items, { score: o.score ?? 100 });
}
const aiHome = (s: ScoredStory): boolean => findSection(s.items[0].home)?.desk === "ai";
const input = (stories: ScoredStory[], over: Partial<TopInput> = {}): TopInput => ({ stories, isAiDesk: aiHome, now, previousLead: null, ...over });
const lead = (s: ScoredStory, since: number): PipelineState["lead"] => ({ id: s.lead, since: hoursAgo(since) });

describe("TOP STORIES", () => {
  it("needs two PUBLISHERS; ranks by score, publisher count only breaking ties", () => {
    const single = story({ pubs: 1, score: 999 });
    const two = story({ pubs: 2, score: 300 });
    const three = story({ pubs: 3, score: 100 });
    const twoLow = story({ pubs: 2, score: 200 });
    const twinFeeds = makeScoredStory([makeNormalized({ publisher: "openai", sourceId: "openai-news" }), makeNormalized({ publisher: "openai", sourceId: "openai-blog" })], { score: 500 });
    const got = pickTop(input([single, two, three, twoLow, twinFeeds]));
    // Coverage is already in the score (and fades there): a 3-publisher story with a third of the
    // score does not outrank two fresher 2-publisher stories.
    assert.deepEqual(got.top, [two.lead, twoLow.lead, three.lead]);
    assert.equal(got.leadId, two.lead);
    assert.equal(got.mode, "coverage");
    assert.equal(twinFeeds.publishers.length, 1, "twin feeds of one publisher are one publisher");
    // Equal scores: the wider coverage first.
    const wide = story({ pubs: 4, score: 150 });
    const narrow = story({ pubs: 2, score: 150 });
    assert.deepEqual(pickTop(input([narrow, wide])).top, [wide.lead, narrow.lead]);
    assert.ok(compareTop(wide, narrow) < 0 && compareTop(two, three) < 0);
  });

  it("does not let stale mid-size stories sit above fresh ones (live build 2026-11-20)", () => {
    // [publishers, score, age h] as built: GPT-6.2, Wiz, Nvidia wrap, Ignite above the AG probe, chip sales, Apple agent.
    const stale = [[6, 69.9, 52.8], [3, 60.1, 51.1], [3, 51.6, 47.9], [3, 51.5, 55.1]].map(([pubs, score, hours]) => story({ pubs, score, hours }));
    const fresh = [[2, 93.9, 2.5], [2, 91.4, 0.5], [2, 89.1, 2.3]].map(([pubs, score, hours]) => story({ pubs, score, hours }));
    const got = pickTop(input([...stale, ...fresh])).top;
    assert.deepEqual(got, [...fresh, ...stale].map((s) => s.lead));
  });

  it("is never led by a release or a community item, and only by lead-eligible sources", () => {
    const release = story({ pubs: 2, lead: { kind: "github-release", flags: ["release"], home: "releases" } });
    const releaseOnAiDesk = story({ pubs: 2, lead: { flags: ["release"] } });
    const thread = story({ pubs: 2, lead: { kind: "community", flags: ["discussion"] } });
    const notEligible = story({ pubs: 2, lead: { leadEligible: false } });
    const ok = story({ pubs: 2 });
    for (const s of [release, releaseOnAiDesk, thread, notEligible]) assert.equal(isTopEligible(s), false);
    assert.deepEqual(pickTop(input([release, releaseOnAiDesk, thread, notEligible, ok])).top, [ok.lead]);
  });

  it("owner and utility desks never feed it", () => {
    const cyber = story({ pubs: 5, lead: { home: "cyber" } });
    const quantum = story({ pubs: 4, lead: { home: "quantum" } });
    const ai = story({ pubs: 2 });
    assert.deepEqual(pickTop(input([cyber, quantum, ai])).top, [ai.lead]);
    assert.deepEqual(pickTop(input([cyber, quantum])).top, []);
  });

  it(`uses a ${PIPELINE.topStoriesHours} h window and relaxes to ${PIPELINE.topStoriesRelaxedHours} h when fewer than ${PIPELINE.topStoriesMin} qualify`, () => {
    const fresh = [story({ pubs: 2, hours: 10 }), story({ pubs: 2, hours: 70 })];
    const older = [story({ pubs: 3, hours: 100 }), story({ pubs: 2, hours: 119 })];
    const tooOld = story({ pubs: 9, hours: 121 });
    const relaxed = pickTop(input([...fresh, ...older, tooOld]));
    assert.equal(relaxed.relaxed, true);
    assert.equal(relaxed.top.length, 4);
    assert.ok(!relaxed.top.includes(tooOld.lead));

    const enough = [...fresh, story({ pubs: 2, hours: 5 }), story({ pubs: 2, hours: 6 })];
    const strict = pickTop(input([...enough, ...older]));
    assert.equal(strict.relaxed, false);
    assert.deepEqual([...strict.top].sort(), enough.map((s) => s.lead).sort());
  });

  it(`caps the list at ${TOP_STORIES_MAX} and at 2 stories per lead publisher`, () => {
    const many = Array.from({ length: 20 }, (_, i) => story({ pubs: 2, score: 500 - i }));
    assert.equal(pickTop(input(many)).top.length, TOP_STORIES_MAX);

    const guardian = (score: number): ScoredStory => story({ pubs: 3, score, lead: { publisher: "guardian", sourceId: "the-guardian-ai" } });
    const g = [guardian(90), guardian(80), guardian(70)];
    const other = story({ pubs: 2, score: 10 });
    assert.deepEqual(pickTop(input([...g, other])).top, [g[0].lead, g[1].lead, other.lead]);
  });

  it("ranks a two-publisher story with its recency capped; three publishers keep theirs (live: a 0.7 h-old pair at TOP #3)", () => {
    assert.equal(PIPELINE.topRecencyCap, 40);
    assert.equal(PIPELINE.topRecencyCapBelowPublishers, 3);
    const withParts = (s: ScoredStory, recency: number): ScoredStory => ({ ...s, parts: { ...s.parts, recency } });
    // The live scores: a brand-new pair (recency 49.7 of 96.4) and a three-publisher story of 13 h (38.9 of 95.7).
    const pair = withParts(story({ pubs: 2, hours: 0.7, score: 96.4, title: "Senate Passes Major Permitting Bill" }), 49.7);
    const attack = withParts(story({ pubs: 3, hours: 13, score: 95.7, title: "European Commission scrambles to contain AI-assisted cyberattack" }), 38.9);
    const launch = withParts(story({ pubs: 6, hours: 58, score: 85.9, title: "Introducing GPT-6.2 Astra and Sol" }), 16.3);
    assert.ok(Math.abs(topStanding(pair) - 86.7) < 1e-9, "96.4 minus the 9.7 recency points over the cap");
    assert.equal(topStanding(attack), 95.7);
    assert.deepEqual(pickTop(input([pair, attack, launch])).top, [attack.lead, pair.lead, launch.lead]);
    // The story's own score is untouched, and an older pair (recency under the cap) ranks on it as before.
    assert.equal(pair.score, 96.4);
    const olderPair = withParts(story({ pubs: 2, hours: 20, score: 90 }), 34);
    assert.equal(topStanding(olderPair), 90);
    // Three outlets on a breaking story: full recency, so it still rises at once.
    const breaking = withParts(story({ pubs: 3, hours: 0.5, score: 105 }), 49.5);
    assert.equal(pickTop(input([pair, attack, breaking])).top[0], breaking.lead);
  });

  it("orders ties deterministically (freshest, then id)", () => {
    const a = story({ pubs: 2, score: 50, hours: 5 });
    const b = story({ pubs: 2, score: 50, hours: 3 });
    assert.deepEqual(pickTop(input([a, b])).top, [b.lead, a.lead]);
    assert.deepEqual(pickTop(input([b, a])).top, [b.lead, a.lead]);
    assert.ok(compareTop(b, a) < 0);
  });
});

describe("lead stability", () => {
  const board = (): ScoredStory[] => [story({ pubs: 6, hours: 2 }), story({ pubs: 5, hours: 3 }), story({ pubs: 4, hours: 4 }), story({ pubs: 3, hours: 5 })];

  it("without state the lead is top[0]", () => {
    const s = board();
    assert.equal(pickTop(input(s)).leadId, s[0].lead);
  });

  it("keeps the previous lead while it is still in the top 3 and under 24 h", () => {
    const s = board();
    for (const idx of [1, 2]) {
      const got = pickTop(input(s, { previousLead: lead(s[idx], 6) }));
      assert.equal(got.leadId, s[idx].lead);
      assert.equal(got.held, true);
      assert.equal(got.top[0], s[idx].lead);
      // The rest keep their order.
      assert.deepEqual(got.top.slice(1), s.filter((_, i) => i !== idx).map((x) => x.lead));
    }
  });

  it("lets go when the previous lead fell out of the top 3", () => {
    const s = board();
    const got = pickTop(input(s, { previousLead: lead(s[3], 6) }));
    assert.equal(got.leadId, s[0].lead);
    assert.equal(got.held, false);
  });

  it("lets go when the story is 24 h old", () => {
    const s = [story({ pubs: 6, hours: 2 }), story({ pubs: 5, hours: 24 })];
    assert.equal(pickTop(input(s, { previousLead: lead(s[1], 3) })).leadId, s[0].lead);
    const young = [story({ pubs: 6, hours: 2 }), story({ pubs: 5, hours: 23 })];
    assert.equal(pickTop(input(young, { previousLead: lead(young[1], 3) })).leadId, young[1].lead);
  });

  it("lets go after 24 h as lead even if the story still looks fresh (re-stamped live blog)", () => {
    const s = [story({ pubs: 6, hours: 2 }), story({ pubs: 5, hours: 0 })];
    assert.equal(pickTop(input(s, { previousLead: lead(s[1], 24) })).leadId, s[0].lead);
    assert.equal(pickTop(input(s, { previousLead: lead(s[1], 23) })).leadId, s[1].lead);
    assert.equal(pickTop(input(s, { previousLead: { id: s[1].lead, since: "garbage" } })).leadId, s[0].lead);
  });

  it("follows the story when the cluster's lead ARTICLE changed between builds", () => {
    const s = board();
    const memberOfSecond = s[1].items[2].id;
    const got = pickTop(input(s, { previousLead: { id: memberOfSecond, since: hoursAgo(4) } }));
    assert.equal(got.leadId, s[1].lead);
    assert.equal(got.held, true);
  });

  it("ignores a previous lead that no longer exists", () => {
    const s = board();
    assert.equal(pickTop(input(s, { previousLead: { id: "gone", since: hoursAgo(1) } })).leadId, s[0].lead);
  });

  it("does not flip between two close stories on consecutive builds", () => {
    // Build 1: A leads. Build 2: B edges ahead on coverage. A keeps the lead.
    const a = story({ pubs: 4, hours: 3 });
    const b = story({ pubs: 4, hours: 2, score: 90 });
    const first = pickTop(input([a, b]));
    assert.equal(first.leadId, a.lead);
    const b2 = { ...b, publishers: [...b.publishers, "one-more"] };
    const second = pickTop(input([a, b2], { previousLead: { id: first.leadId ?? "", since: hoursAgo(0.5) } }));
    assert.equal(second.leadId, a.lead);
    assert.deepEqual(second.top, [a.lead, b.lead]);
  });
});

describe("quiet day (no multi-publisher story)", () => {
  it("leads with the best-scoring lead-eligible ai-desk story and top = [lead]", () => {
    const best = story({ score: 90 });
    const cyber = story({ score: 999, lead: { home: "cyber" } });
    const release = story({ score: 998, lead: { kind: "github-release", flags: ["release"], home: "releases" } });
    const reddit = story({ score: 997, lead: { kind: "community", flags: ["discussion"], leadEligible: false } });
    const got = pickTop(input([story({ score: 50 }), best, cyber, release, reddit]));
    assert.equal(got.mode, "quiet");
    assert.equal(got.leadId, best.lead);
    assert.deepEqual(got.top, [best.lead]);
  });

  it("never leads with a paper, a live blog, a video or a digest (V1 led with all of them)", () => {
    const ok = story({ score: 10, title: "Anthropic begins public trading at $2tn valuation" });
    const noise = [
      story({ score: 900, title: "GridForge: An Open Physics-Informed Digital Twin for UK 11 kV Cables", lead: { kind: "papers", flags: ["paper"], home: "research" } }),
      story({ score: 800, title: "Anthropic valued at $2tn as shares begin trading after record-breaking IPO – business live" }),
      story({ score: 700, title: "Anthropic CEO acknowledges AI has 'very real risks' shortly before IPO – video" }),
      story({ score: 600, title: "Bookmarked: News Stories On Our Reading List" }),
      story({ score: 500, title: "[tl;dr sec] #355 - Cyber Chaos Monkey" }),
      story({ score: 400, title: "Markets wrap", lead: { url: "https://www.theguardian.com/business/live/2026/nov/19/markets" } }),
    ];
    assert.equal(pickTop(input([...noise, ok])).leadId, ok.lead);
  });

  it("is under 72 h, relaxes to 120 h, else there is no lead", () => {
    const old = story({ score: 500, hours: 100 });
    const fresh = story({ score: 1, hours: 71 });
    assert.equal(pickTop(input([old, fresh])).leadId, fresh.lead);
    const relaxed = pickTop(input([old]));
    assert.equal(relaxed.leadId, old.lead);
    assert.equal(relaxed.relaxed, true);
    const none = pickTop(input([story({ hours: 121 })]));
    assert.deepEqual([none.top, none.leadId, none.mode], [[], null, "empty"]);
    assert.deepEqual(pickTop(input([])).top, []);
  });

  it("applies the stability rule to the quiet-day lead too", () => {
    const s = [story({ score: 90 }), story({ score: 80 }), story({ score: 70 }), story({ score: 60 })];
    assert.equal(pickTop(input(s, { previousLead: lead(s[2], 5) })).leadId, s[2].lead);
    assert.equal(pickTop(input(s, { previousLead: lead(s[3], 5) })).leadId, s[0].lead);
  });

  it("a multi-publisher story always beats the quiet-day rule", () => {
    const big = story({ pubs: 2, score: 1 });
    const loud = story({ pubs: 1, score: 999 });
    assert.deepEqual(pickTop(input([loud, big])).top, [big.lead]);
  });
});

// ------------------------------------------------------------------------------------------------
// Same running story (running.ts)
// ------------------------------------------------------------------------------------------------

/** A story from explicit headlines (one publisher each); the first leads. */
function told(titles: string[], o: { score?: number; hours?: number } = {}): ScoredStory {
  seq += 1;
  const items = titles.map((title, i) => makeNormalized({ title, publisher: `told-${seq}-${i}`, sourceId: `told-src-${seq}-${i}`, publishedAt: hoursAgo((o.hours ?? 2) + i * 0.1) }));
  return makeScoredStory(items, { score: o.score ?? 100 });
}

// The live board of 2026-11-20: the IPO (30 publishers) and its two 3-publisher follow-ups at #6 and #8.
const ipoDay = (): { ipo: ScoredStory; shares: ScoredStory; stack: ScoredStory; code: ScoredStory; others: ScoredStory[] } => {
  const ipo = told(
    [
      "Anthropic prices initial public offering",
      "Anthropic raises $81bn in record IPO",
      "Anthropic's $81.3 billion IPO shatters SpaceX's record",
      "Anthropic IPO takeaways: ANT debuts with $1.8 trillion market cap",
      "Anthropic Closes First Trading Day at $97 a Share, 17% Above IPO Price",
      "Anthropic shares end first day of trading at $97",
      "Anthropic hits Nasdaq exchanges at $111, 33% above IPO price",
      "Anthropic Has Gone Public. What Now?",
      "Anthropic closes first day of public trading at $1.3tn valuation after largest-ever IPO",
      "Anthropic prices its IPO at $83 per share, valuing the AI giant at $1.5 trillion",
      "Anthropic Opens Trading at $111.5, Passes $2 Trillion in Market Cap",
      "Anthropic's stock closes up 17% on its first trading day",
    ],
    { score: 138, hours: 38 },
  );
  const shares = told(["Anthropic shares jump 17% after record Wall Street listing", "Anthropic starts trading on Wall Street", "Wall Street Is Wrong About Anthropic"], { score: 98, hours: 5 });
  const stack = told(["Anthropic goes public: $1.5 trillion beast targets other verticals", "Anthropic goes public", "As Anthropic Goes Public, Who Has the Power to Stop an AI Company?"], { score: 94, hours: 14 });
  // Same company, another event: not a follow-up.
  const code = told(["Anthropic Adds Code Mode to Claude Code", "Anthropic ships Code Mode for Claude Code"], { score: 92, hours: 6 });
  const others = [
    told(["Introducing Gemini 4 Neon", "Google ships Gemini 4 Neon", "Google DeepMind Releases Gemini 4 Neon"], { score: 117, hours: 29 }),
    told(["California attorney general opens probe into Nvidia over Jensen Huang scandal", "California AG probes Nvidia after Huang scandal"], { score: 93, hours: 4 }),
    told(["Nvidia faces questions over former No 3’s China ties after short seller report", "Short seller targets Nvidia over ex-executive’s China ties", "Nvidia shares slip on short seller report about China ties"], { score: 90, hours: 37 }),
  ];
  return { ipo, shares, stack, code, others };
};

describe("TOP STORIES: one running story", () => {
  it("reads a story's subject and vocabulary from its headlines", () => {
    const { ipo, shares } = ipoDay();
    const sig = signatureOf(ipo);
    assert.deepEqual([...sig.core], ["anthropic"]);
    for (const t of ["ipo", "trading", "share", "record", "trillion", "public"]) assert.ok(sig.vocabulary.has(t), t);
    assert.ok(!sig.vocabulary.has("nasdaq"), "one headline's word is not the story's vocabulary");
    assert.deepEqual([...signatureOf(shares).core].sort(), ["anthropic", "street", "wall"]);
  });

  it("a follow-up shares the subject AND the event vocabulary; a different event of the same company does not", () => {
    const { ipo, shares, stack, code, others } = ipoDay();
    const [neon, probe, short] = others.map(signatureOf);
    const s = signatureOf(ipo);
    assert.ok(isFollowUp(signatureOf(shares), s));
    assert.ok(isFollowUp(signatureOf(stack), s));
    assert.ok(!isFollowUp(s, signatureOf(shares)), "the big story is not the follow-up of its own follow-up");
    assert.ok(sameRunningStory(s, signatureOf(shares)) && sameRunningStory(signatureOf(shares), s), "the relation is symmetric");
    assert.ok(!sameRunningStory(signatureOf(code), s), "Anthropic Adds Code Mode: same subject, none of the IPO's words");
    assert.ok(!sameRunningStory(probe, short), "two Nvidia stories of one week are two stories");
    assert.ok(!sameRunningStory(neon, s));
  });

  it("gives one running story ONE slot when its follow-ups have no weight of their own (live: #1, #6, #8)", () => {
    const { ipo, shares, stack, code, others } = ipoDay();
    const got = pickTop(input([ipo, shares, stack, code, ...others]));
    assert.deepEqual(got.top, [ipo.lead, others[0].lead, others[1].lead, code.lead, others[2].lead]);
    assert.deepEqual(got.related, { [ipo.lead]: [shares.lead, stack.lead] });
    assert.equal(got.leadId, ipo.lead);
    // Before the rule: the IPO held three slots.
    const all = [ipo, shares, stack, code, ...others].sort(compareTop).map((s) => s.lead);
    assert.deepEqual([all.indexOf(ipo.lead), all.indexOf(shares.lead), all.indexOf(stack.lead)], [0, 2, 3]);
  });

  it("a follow-up with independent weight takes a second slot - and nothing takes a third", () => {
    const { ipo, shares, stack } = ipoDay();
    const { independentPublishers, maxSlots } = ROUTE_POLICY.runningStory;
    assert.equal(maxSlots, 2);
    const crash = told(
      Array.from({ length: independentPublishers }, (_, i) => `Anthropic shares plunge 30% in second day of trading as IPO euphoria fades (report ${i})`),
      { score: 120, hours: 1 },
    );
    const lockup = told(
      Array.from({ length: independentPublishers + 1 }, (_, i) => `Anthropic insiders may sell shares early after record IPO, filing shows (desk ${i})`),
      { score: 110, hours: 2 },
    );
    const got = pickTop(input([ipo, crash, lockup, shares, stack]));
    assert.deepEqual(got.top, [ipo.lead, crash.lead]);
    assert.deepEqual(got.related[ipo.lead], [lockup.lead, shares.lead, stack.lead]);
    // One publisher short: no slot.
    const thin = told(Array.from({ length: independentPublishers - 1 }, (_, i) => `Anthropic shares plunge 30% in second day of trading as IPO euphoria fades (report ${i})`), { score: 120, hours: 1 });
    assert.deepEqual(pickTop(input([ipo, thin])).top, [ipo.lead]);
  });

  it("keeps the higher-ranked story when the follow-up outranks the story it follows", () => {
    const { ipo, shares } = ipoDay();
    const late = { ...ipo, score: 80 };
    // The fresh follow-up leads; the 12-publisher story has weight of its own and takes the second slot.
    assert.deepEqual(pickTop(input([late, shares])).top, [shares.lead, late.lead]);
  });

  it("foldRunningStories keeps the input order and never drops a story", () => {
    const { ipo, shares, stack, code, others } = ipoDay();
    const ranked = [ipo, shares, stack, code, ...others].sort(compareTop);
    const got = foldRunningStories(ranked);
    assert.deepEqual(got.kept.map((s) => s.lead), ranked.filter((s) => s !== shares && s !== stack).map((s) => s.lead));
    assert.equal(got.kept.length + Object.values(got.related).flat().length, ranked.length);
  });
});

// ------------------------------------------------------------------------------------------------
// Membership hold (ctx.state.top)
// ------------------------------------------------------------------------------------------------

describe("TOP STORIES: membership hold", () => {
  const { margin, hours } = ROUTE_POLICY.topHold;
  const memory = (stories: ScoredStory[], over: Partial<TopMemory> = {}): TopMemory[] => stories.map((s) => ({ id: s.lead, score: s.score, ...over }));
  /** Twelve stories that fill the list; scores 200, 199, ... */
  const board = (): ScoredStory[] => Array.from({ length: TOP_STORIES_MAX }, (_, i) => story({ pubs: 2, score: 200 - i }));

  it("without memory the list is today's ranking, and nothing is held", () => {
    const b = board();
    const newcomer = story({ pubs: 2, score: 189.5 });
    const got = pickTop(input([...b, newcomer]));
    assert.deepEqual(got.top, [...b.slice(0, 11), newcomer].map((s) => s.lead));
    assert.deepEqual(got.holds, {});
  });

  it("an incumbent keeps its slot against a newcomer that does not clearly outscore it", () => {
    const b = board();
    const last = b[11];
    const close = story({ pubs: 2, score: last.score + margin - 0.5 });
    const got = pickTop(input([...b, close], { previousTop: memory(b) }));
    assert.ok(got.top.includes(last.lead) && !got.top.includes(close.lead));
    assert.deepEqual(got.top, b.map((s) => s.lead), "order is still today's ranking");
    assert.deepEqual(Object.keys(got.holds), [last.lead]);
    assert.equal(got.holds[last.lead].since, now.toISOString());
    assert.equal(got.holds[last.lead].score, last.score);
  });

  it("a newcomer with a clear margin gets in at once", () => {
    const b = board();
    const clear = story({ pubs: 2, score: b[11].score + margin });
    const got = pickTop(input([...b, clear], { previousTop: memory(b) }));
    assert.ok(got.top.includes(clear.lead) && !got.top.includes(b[11].lead));
    assert.deepEqual(got.holds, {});
  });

  it("holds a story that lost a publisher between two builds - also down to ONE publisher", () => {
    const b = board();
    const prev = memory(b);
    // Build 2: #6 fell from 3 publishers to 2 and lost 13 points; #9 fell from 2 publishers to 1 and lost 22.
    const three = { ...b[5], score: b[5].score - 13 };
    const one = { ...b[8], score: b[8].score - 22, publishers: b[8].publishers.slice(0, 1), items: b[8].items.slice(0, 1), members: [] };
    const next = b.map((s, i) => (i === 5 ? three : i === 8 ? one : s));
    const newcomers = [story({ pubs: 2, score: 186 }), story({ pubs: 2, score: 185 })];
    const without = pickTop(input([...next, ...newcomers]));
    assert.ok(!without.top.includes(three.lead) && !without.top.includes(one.lead), "as shipped: both left TOP");
    const got = pickTop(input([...next, ...newcomers], { previousTop: prev }));
    assert.ok(got.top.includes(three.lead) && got.top.includes(one.lead));
    assert.ok(!got.top.includes(newcomers[0].lead) && !got.top.includes(newcomers[1].lead));
    assert.equal(got.top.length, TOP_STORIES_MAX);
    assert.deepEqual(got.top.slice(-2), [three.lead, one.lead], "held stories sit where today's score puts them");
    assert.equal(got.holds[one.lead].score, b[8].score, "held at the score it last qualified with");
    assert.equal(got.leadId, got.top[0]);
  });

  it("a hold ends after topHold.hours, and cannot renew itself", () => {
    const b = board();
    const close = story({ pubs: 2, score: b[11].score + 1 });
    const since = (h: number): TopMemory[] => b.map((s, i) => (i === 11 ? { id: s.lead, score: s.score, heldSince: hoursAgo(h) } : { id: s.lead, score: s.score }));
    const running = pickTop(input([...b, close], { previousTop: since(hours - 0.5) }));
    assert.ok(running.top.includes(b[11].lead));
    assert.equal(running.holds[b[11].lead].since, hoursAgo(hours - 0.5), "the hold keeps its start time");
    const over = pickTop(input([...b, close], { previousTop: since(hours) }));
    assert.ok(!over.top.includes(b[11].lead) && over.top.includes(close.lead));
    assert.ok(!pickTop(input([...b, close], { previousTop: [{ id: b[11].lead, score: b[11].score, heldSince: "garbage" }] })).top.includes(b[11].lead));
  });

  it("recognises the story by any of its articles, also under a former id", () => {
    const b = board();
    const close = story({ pubs: 2, score: b[11].score + 1 });
    const byMember: TopMemory[] = [{ id: b[11].items[1].id, score: b[11].score }];
    assert.ok(pickTop(input([...b, close], { previousTop: byMember })).top.includes(b[11].lead));
    const resolved = { ...b[11], items: b[11].items.map((item, i) => (i === 0 ? { ...item, formerIds: ["wrapper-id"] } : item)) };
    const next = [...b.slice(0, 11), resolved, close];
    assert.ok(pickTop(input(next, { previousTop: [{ id: "wrapper-id", score: b[11].score }] })).top.includes(resolved.lead));
    assert.ok(!pickTop(input(next, { previousTop: [{ id: "someone-else", score: 999 }] })).top.includes(resolved.lead));
  });

  it("never holds a story the other rules exclude: a folded follow-up, a third story of one publisher, a story out of the window", () => {
    const { ipo, shares, stack, others } = ipoDay();
    // Yesterday's build listed the follow-ups; today's running-story rule folds them, memory or not.
    const got = pickTop(input([ipo, shares, stack, ...others], { previousTop: memory([ipo, shares, stack]) }));
    assert.ok(!got.top.includes(shares.lead) && !got.top.includes(stack.lead));
    assert.deepEqual(got.holds, {});
    const old = story({ pubs: 1, hours: PIPELINE.topStoriesHours + 1, score: 300 });
    const fresh = Array.from({ length: 4 }, (_, i) => story({ pubs: 2, score: 100 - i }));
    assert.ok(!pickTop(input([...fresh, old], { previousTop: memory([old]) })).top.includes(old.lead));
  });

  it("fills free slots with held stories and holds nothing on a quiet day", () => {
    const a = story({ pubs: 2, score: 90 });
    const lapsed = story({ pubs: 1, score: 40 });
    const got = pickTop(input([a, lapsed], { previousTop: [{ id: lapsed.lead, score: 70 }] }));
    assert.deepEqual(got.top, [a.lead, lapsed.lead]);
    assert.equal(got.holds[lapsed.lead].score, 70);
    // No multi-publisher story at all: the quiet-day rule, not the hold.
    const quiet = pickTop(input([lapsed], { previousTop: [{ id: lapsed.lead, score: 70 }] }));
    assert.equal(quiet.mode, "quiet");
    assert.deepEqual(quiet.holds, {});
  });
});
