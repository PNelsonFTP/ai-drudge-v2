import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NOW_MS, hoursAgo, makeNormalized, makeStory } from "../../../test/helpers/factories";
import { urlKey } from "../../../shared/url";
import type { Tier } from "../../../shared/contract";
import { PIPELINE, createTestContext } from "../context";
import type { HnIndex, IngestOutput, NormalizedItem, Story } from "../types";
import { byScore, coverageScore, fade, freshAt, hnScore, importanceScore, isFirstParty, isTierOneLaunch, recencyScore, score, scoreStory, tierScore, weightOf } from "./index";
import { SCORE } from "./weights";

const NOW = new Date(FIXTURE_NOW_MS);
const noSignals: IngestOutput["signals"] = { hn: { byUrl: new Map() } };

let n = 0;
/** A plain press item; `title` has no importance words unless the test says so. */
function item(hours: number, tier: Tier = 2, extra: Partial<NormalizedItem> = {}): NormalizedItem {
  n++;
  return makeNormalized({ title: `A plain headline about subject ${n}`, publisher: `pub-${n}`, sourceId: `src-${n}`, tier, publishedAt: hoursAgo(hours), url: `https://pub-${n}.example/a`, ...extra });
}
/**
 * A story led by `lead` with `publishers` distinct coverage publishers in total. The other
 * publishers reported it when the lead did (a story that is no longer growing) unless
 * `joinedHoursAgo` says when they joined.
 */
function story(lead: NormalizedItem, publishers = 1, joinedHoursAgo?: number): Story {
  const at = joinedHoursAgo === undefined ? { publishedAt: lead.publishedAt, firstSeenAt: lead.firstSeenAt } : {};
  return makeStory([lead, ...Array.from({ length: publishers - 1 }, () => item(joinedHoursAgo ?? 0, 3, at))]);
}
function release(hours: number, tier: Tier = 1, title = "llama.cpp b12549 released"): NormalizedItem {
  n++;
  return makeNormalized({ title, publisher: "github:ggml-org/llama.cpp", sourceId: "ggml-org-llama-cpp", kind: "github-release", flags: ["release"], tier, leadEligible: false, countsForCoverage: false, publishedAt: hoursAgo(hours), url: `https://github.com/ggml-org/llama.cpp/releases/tag/b${n}`, home: "releases" });
}
const scored = (s: Story, hn?: HnIndex) => scoreStory(s, hn, NOW);

describe("score parts", () => {
  it("tier: 30 / 20 / 10 / 0 before the fade, and a release line is capped at the tier-3 base", () => {
    assert.deepEqual([1, 2, 3, 4].map((t) => tierScore(item(1, t as Tier))), [30, 20, 10, 0]);
    assert.equal(tierScore(release(1, 1)), SCORE.releaseTierCap);
    assert.equal(tierScore(release(1, 4)), 0);
  });

  it("recency: half-life of 36 h on effectiveAt (the shared pipeline constant)", () => {
    assert.equal(SCORE.halfLifeHours, PIPELINE.recencyHalfLifeHours);
    assert.equal(SCORE.halfLifeHours, 36);
    assert.equal(recencyScore(0), SCORE.recencyMax);
    assert.ok(Math.abs(recencyScore(36) - SCORE.recencyMax / 2) < 1e-9);
    assert.ok(Math.abs(recencyScore(72) - SCORE.recencyMax / 4) < 1e-9);
    assert.equal(recencyScore(-5), SCORE.recencyMax, "future dates clamp to now");
    const undated = makeNormalized({ publishedAt: null, firstSeenAt: hoursAgo(36) });
    assert.equal(undated.effectiveAt, undated.firstSeenAt);
    assert.ok(Math.abs(scored(makeStory([undated])).parts.recency - SCORE.recencyMax / 2) < 1e-6, "undated items age from firstSeenAt");
  });

  it("coverage: 0 for one publisher, log-scaled after that, capped", () => {
    assert.equal(coverageScore(0), 0);
    assert.equal(coverageScore(1), 0);
    assert.equal(coverageScore(2), SCORE.coveragePerDoubling);
    assert.equal(coverageScore(4), 2 * SCORE.coveragePerDoubling);
    assert.equal(coverageScore(8), 3 * SCORE.coveragePerDoubling);
    assert.equal(coverageScore(500), coverageScore(SCORE.coverageMaxPublishers));
    for (let p = 1; p < 20; p++) assert.ok(coverageScore(p + 1) >= coverageScore(p));
  });

  it("coverage is the dominant significance signal: 8 publishers outweigh the whole recency range", () => {
    assert.ok(coverageScore(8) > SCORE.recencyMax);
    assert.ok(coverageScore(3) > SCORE.importance.max + SCORE.hn.max);
    assert.ok(coverageScore(SCORE.coverageMaxPublishers) > SCORE.tierBase[1] + SCORE.importance.max + SCORE.hn.max);
  });

  it("importance: title only, nothing for release lines", () => {
    const launch = item(1, 1, { title: "Introducing Gemini 4 Neon", summary: null });
    assert.equal(importanceScore(launch), SCORE.importance.launch + SCORE.importance.versionedModel);
    assert.equal(importanceScore(release(1, 1, "llama.cpp b12549 released: Gemini 4 launches")), 0);
    const summaryOnly = item(1, 2, { title: "Notes from a quiet week", summary: "OpenAI launches GPT-7 after a $40bn round; regulators probe a data breach." });
    assert.equal(importanceScore(summaryOnly), 0);
  });

  it("importance: a regulator's own notice is an event whatever its title says (source tags, capped with the title signals)", () => {
    const notice = item(38, 1, { title: "Regulatory Notice 26-24: FINRA has adopted amendments to FINRA Rule 2210", tags: ["regulator", "finreg", "first-party"] });
    assert.equal(importanceScore(notice), SCORE.importance.regulatorNotice);
    // The same headline carried by press, or by a regulator-watching outlet, gets the title signals only.
    assert.equal(importanceScore({ ...notice, tags: ["press"] }), 0);
    assert.equal(importanceScore({ ...notice, tags: ["regulator"] }), 0);
    assert.equal(importanceScore({ ...notice, tags: ["first-party", "lab"] }), 0);
    const action = { ...notice, title: "SEC charges adviser in AI washing enforcement action" };
    assert.equal(importanceScore(action), SCORE.importance.max, "notice + regulatory word: capped");
    assert.ok(SCORE.importance.regulatorNotice <= SCORE.importance.max);
    // What it is for: a tier-1 notice from yesterday morning outranks a tier-3 opinion piece from this morning.
    const opinion = item(12, 3, { title: "The dangerous politics of AI consciousness", tags: ["analysis"] });
    assert.ok(scored(story(notice)).score > scored(story(opinion)).score);
    assert.ok(scored(story({ ...notice, tags: ["press"] })).score < scored(story(opinion)).score, "without the term it lost (POLICY #30 of 30 on 2026-11-20)");
    // It never outranks coverage: a two-publisher story of the same age stays ahead.
    assert.ok(scored(story({ ...notice, tags: ["press"] }, 2)).score > scored(story(notice)).score);
  });

  it("fade: 1 when new, halving every 96 h, applied to every part except recency", () => {
    assert.equal(fade(0), 1);
    assert.equal(fade(-3), 1);
    assert.ok(Math.abs(fade(SCORE.fadeHalfLifeHours) - 0.5) < 1e-12);
    assert.ok(SCORE.fadeHalfLifeHours > SCORE.halfLifeHours, "standing outlives freshness");
    const lead = item(96, 1, { title: "Introducing Gemini 4 Neon" });
    const key = urlKey(lead.url);
    assert.ok(key);
    const s = scored(story(lead, 4), { byUrl: new Map([[key, { points: 100, comments: 1 }]]) });
    assert.ok(Math.abs(s.parts.tier - 15) < 1e-9);
    assert.ok(Math.abs(s.parts.coverage - 22) < 1e-9);
    assert.ok(Math.abs(s.parts.importance - 4.5) < 1e-9);
    assert.ok(Math.abs(s.parts.hn - 2.5) < 1e-9);
    assert.ok(Math.abs(s.parts.recency - recencyScore(96)) < 1e-9);
  });

  it("an old big story sinks below today's news instead of topping its section for weeks", () => {
    const old = scored(story(item(240, 2), 6));
    const today = scored(story(item(3, 3)));
    const sameAgeSingle = scored(story(item(240, 2)));
    assert.ok(today.score > old.score);
    assert.ok(old.score > sameAgeSingle.score, "but it still outranks single-source items of its own age");
  });

  it("recency counts from the time the story last gained a coverage publisher; everything else stays on the lead", () => {
    // Live 2026-11-20: the IPO story's lead was the 37 h-old pricing release; outlets were still joining 4 h ago.
    const lead = item(37, 1);
    const settled = scored(story(lead, 5));
    const growing = scored(story(lead, 5, 4));
    assert.ok(Math.abs(settled.parts.recency - recencyScore(37)) < 1e-9);
    assert.ok(Math.abs(growing.parts.recency - recencyScore(4)) < 1e-9);
    assert.equal(growing.effectiveAt, lead.effectiveAt, "the story's time (windows, stickiness, display) is still the lead's");
    assert.ok(Math.abs(growing.ageHours - 37) < 1e-9);
    for (const part of ["tier", "coverage", "importance", "hn"] as const) assert.equal(growing.parts[part], settled.parts[part], `${part} fades with the lead's age`);
    assert.ok(growing.score - settled.score <= SCORE.recencyMax, "a late joiner adds recency points at most");

    // The clock is each publisher's FIRST item: follow-ups by a publisher already in the story do not refresh it.
    const first = item(30, 2);
    const followUp = item(1, 2, { publisher: first.publisher, sourceId: first.sourceId });
    assert.equal(freshAt(makeStory([first, followUp])), first.effectiveAt);
    assert.ok(Math.abs(scored(makeStory([first, followUp])).parts.recency - recencyScore(30)) < 1e-9);
    // ... nor do items that are not coverage (community threads, release lines).
    const thread = item(1, 3, { kind: "community", flags: ["discussion"], countsForCoverage: false, leadEligible: false });
    assert.equal(freshAt(makeStory([first, thread])), first.effectiveAt);
    // A member OLDER than the lead never makes the story older than its lead.
    const earlier = item(60, 3);
    assert.equal(freshAt(makeStory([first, earlier])), first.effectiveAt);
    const late = item(2, 3);
    assert.equal(freshAt(makeStory([first, earlier, late])), late.effectiveAt);
  });

  it("hn: exact URL only, best match among the story's items, capped", () => {
    const a = item(3, 2, { url: "https://www.reuters.com/technology/anthropic-debut" });
    const b = item(2, 3, { url: "https://www.reuters.com/technology/other-story" });
    const key = urlKey(a.url);
    assert.ok(key);
    const hn: HnIndex = { byUrl: new Map([[key, { points: 120, comments: 80 }]]) };
    assert.equal(hnScore([a], hn), 120 / SCORE.hn.pointsPerPoint);
    assert.equal(hnScore([b], hn), 0, "same host, different URL: no domain fallback");
    assert.equal(hnScore([b, a], hn), 6, "a member's match lifts the story");
    assert.equal(hnScore([a], { byUrl: new Map([[key, { points: 5000, comments: 0 }]]) }), SCORE.hn.max);
    assert.equal(hnScore([a], undefined), 0);
    assert.equal(hnScore([a], { byUrl: new Map() }), 0);
    const github: HnIndex = { byUrl: new Map([["github.com/openjdk/jdk/pull/32781", { points: 300, comments: 10 }]]) };
    assert.equal(scored(makeStory([release(2)]), github).parts.hn, 0, "an unrelated github.com hit boosts no release");
    assert.ok(Math.abs(scored(makeStory([a]), hn).parts.hn - 6 * fade(3)) < 1e-9);
  });
});

describe("scoreStory", () => {
  it("exposes parts that sum to the score, the lead's effectiveAt and a non-negative age", () => {
    const lead = item(10, 1, { title: "Introducing Gemini 4 Neon" });
    const s = scored(story(lead, 5));
    const { tier, recency, importance, coverage, hn } = s.parts;
    assert.ok(Math.abs(s.score - (tier + recency + importance + coverage + hn)) < 1e-9);
    assert.equal(s.effectiveAt, lead.effectiveAt);
    assert.ok(Math.abs(s.ageHours - 10) < 1e-9);
    assert.equal(s.lead, lead.id);
    assert.equal(s.items.length, 5);
    assert.deepEqual(Object.keys(s.parts).sort(), ["coverage", "hn", "importance", "recency", "tier"]);
    const future = scored(makeStory([item(-0.5)]));
    assert.equal(future.ageHours, 0);
  });

  it("treats an unparseable effectiveAt as old instead of producing NaN", () => {
    const broken = { ...item(1), effectiveAt: "not a date" };
    const s = scored(makeStory([broken]));
    assert.equal(s.ageHours, SCORE.unknownAgeHours);
    assert.ok(Number.isFinite(s.score));
  });

  it("does not mutate the story", () => {
    const st = story(item(3), 3);
    const snapshot = JSON.stringify(st);
    scored(st);
    assert.equal(JSON.stringify(st), snapshot);
  });
});

describe("score monotonicity (acceptance)", () => {
  it("fresher beats older at equal tier and coverage", () => {
    for (const tier of [1, 2, 3, 4] as Tier[]) {
      for (const pubs of [1, 3, 8]) {
        const ages = [0, 1, 6, 12, 24, 48, 96, 200];
        const scores = ages.map((h) => scored(story(item(h, tier), pubs)).score);
        for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1], `tier ${tier}, ${pubs} publishers, ${ages[i]} h`);
      }
    }
  });

  it("coverage raises the score, one publisher at a time", () => {
    for (const tier of [1, 3] as Tier[]) {
      const lead = item(12, tier);
      let prev = scored(story(lead, 1)).score;
      for (let pubs = 2; pubs <= SCORE.coverageMaxPublishers; pubs++) {
        const next = scored(story(lead, pubs)).score;
        assert.ok(next > prev, `tier ${tier}: ${pubs} publishers`);
        prev = next;
      }
    }
  });

  it("a better tier scores higher, other things equal", () => {
    const scores = ([1, 2, 3, 4] as Tier[]).map((t) => scored(story(item(5, t))).score);
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1]);
  });

  it("a release never outranks a >= 3-publisher story of the same age", () => {
    // Structural: the most a release can have besides recency is less than the least a 3-publisher story has.
    assert.ok(SCORE.releaseTierCap + SCORE.hn.max < coverageScore(3) + SCORE.tierBase[4]);
    for (const age of [0, 2, 12, 36, 100]) {
      const rel = release(age, 1);
      const key = urlKey(rel.url);
      assert.ok(key);
      const hn: HnIndex = { byUrl: new Map([[key, { points: 9000, comments: 900 }]]) };
      const best = scored(makeStory([rel]), hn);
      const worst = scored(story(item(age, 4), 3), hn);
      assert.ok(best.score < worst.score, `age ${age} h: release ${best.score.toFixed(1)} vs story ${worst.score.toFixed(1)}`);
    }
  });

  it("the day's frontier-model launch outranks a build tag (V1: llama.cpp b12549 139.7 vs Gemini 4 Neon 127.2)", () => {
    const tag = scored(makeStory([release(3.15, 1, "llama.cpp b12549 released")]));
    const neonLead = item(22.5, 1, { title: "Introducing Gemini 4 Neon", publisher: "deepmind.google", sourceId: "google-deepmind-blog", home: "models" });
    const alone = scored(makeStory([neonLead]));
    const covered = scored(story(neonLead, 8));
    assert.ok(alone.score > tag.score, `even uncorroborated: ${alone.score.toFixed(1)} vs ${tag.score.toFixed(1)}`);
    assert.ok(covered.score > tag.score + 50);
    const freshTag = scored(makeStory([release(0, 1)]));
    assert.ok(covered.score > freshTag.score);
  });

  it("an 8-publisher story from yesterday outranks a tier-1 single-source item posted this minute", () => {
    const big = scored(story(item(24, 3), 8));
    const single = scored(story(item(0, 1)));
    assert.ok(big.score > single.score, `${big.score.toFixed(1)} vs ${single.score.toFixed(1)}`);
  });
});

describe("emphasis weight", () => {
  it("3 = publishers >= 8; 2 = publishers >= 3; 0 = uncorroborated tier-4 lead; else 1 - in that order", () => {
    assert.equal(weightOf(story(item(1, 2), 8)), 3);
    assert.equal(weightOf(story(item(1, 4), 9)), 3, "a tier-4 lead with 9 publishers is still a 3");
    assert.equal(weightOf(story(item(1, 2), 7)), 2);
    assert.equal(weightOf(story(item(1, 4), 3)), 2);
    assert.equal(weightOf(story(item(1, 2), 2)), 1);
    assert.equal(weightOf(story(item(1, 3), 1)), 1);
    assert.equal(weightOf(story(item(1, 4), 2)), 1, "a tier-4 lead a second publisher also reports is not muted");
    assert.equal(weightOf(story(item(1, 4), 1)), 0);
    assert.equal(weightOf(story(item(1, 4), 0)), 0, "no coverage publisher at all (a tier-4 community thread)");
    assert.equal(scored(story(item(1, 4), 1)).w, 0);
  });

  it("2 for a tier-1 first-party launch, even uncorroborated", () => {
    const launch = item(2, 1, { title: "Introducing Gemini 4 Neon", kind: "rss", attribution: "source" });
    assert.ok(isFirstParty(launch) && isTierOneLaunch(launch));
    assert.equal(weightOf(makeStory([launch])), 2);
    assert.equal(weightOf(makeStory([{ ...launch, title: "How our performance factory keeps things fast" }])), 1, "tier 1, but not a launch");
    assert.equal(weightOf(makeStory([{ ...launch, title: "Introducing OpenAI for Chile" }])), 1, "an announcement, not a model launch");
    assert.equal(weightOf(makeStory([{ ...launch, title: "Introducing ChatGPT for Sales" }])), 1);
    assert.equal(weightOf(makeStory([{ ...launch, title: "Genie 4 is now available" }])), 2, "a versioned product the entity list has never heard of");
    assert.equal(weightOf(makeStory([{ ...launch, tier: 2 }])), 1, "a launch, but not tier 1");
  });

  it("never treats a release line, an aggregator or tagged press as a first-party launch", () => {
    const rel = release(1, 1, "ollama v0.40.17 released: Gemini 4 support launches");
    assert.ok(!isTierOneLaunch(rel));
    assert.equal(weightOf(makeStory([rel])), 1);
    const viaAggregator = item(1, 1, { title: "OpenAI launches GPT-7", kind: "aggregator", attribution: "link-host" });
    assert.ok(!isFirstParty(viaAggregator));
    assert.equal(weightOf(makeStory([viaAggregator])), 1);
    const press = item(1, 1, { title: "OpenAI launches GPT-7", tags: ["press"] });
    assert.ok(!isFirstParty(press));
    const lab = item(1, 1, { title: "OpenAI launches GPT-7 Turbo", kind: "newsletter", tags: ["lab"] });
    assert.ok(isFirstParty(lab) && isTierOneLaunch(lab));
  });
});

describe("score (stage)", () => {
  it("returns every story, sorted by score descending, deterministically", () => {
    const stories = [story(item(30, 3)), story(item(1, 2), 4), makeStory([release(0.5)]), story(item(5, 1)), story(item(60, 4), 9)];
    const ctx = createTestContext();
    const out = score(stories, noSignals, ctx);
    assert.equal(out.length, stories.length);
    for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
    assert.deepEqual(new Set(out.map((s) => s.lead)), new Set(stories.map((s) => s.lead)));
    const again = score([...stories].reverse(), noSignals, createTestContext());
    assert.deepEqual(again.map((s) => s.lead), out.map((s) => s.lead));
    assert.equal(ctx.logs.length, 1);
    assert.match(ctx.logs[0].msg, /^score: 5 stories, 0 with an exact-URL Hacker News match, top \d+\.\d$/);
  });

  it("uses ctx.now as the only clock", () => {
    const st = story(item(10, 2));
    const early = score([st], noSignals, createTestContext({ now: new Date(FIXTURE_NOW_MS) }))[0];
    const late = score([st], noSignals, createTestContext({ now: new Date(FIXTURE_NOW_MS + 36 * 3_600_000) }))[0];
    assert.ok(Math.abs(early.ageHours - 10) < 1e-9);
    assert.ok(Math.abs(late.ageHours - 46) < 1e-9);
    assert.ok(Math.abs(late.parts.recency - early.parts.recency / 2) < 1e-9);
    assert.ok(late.parts.tier < early.parts.tier);
  });

  it("breaks ties by the newer story, then by lead id", () => {
    const a = scored(story(item(4, 2)));
    const b = { ...a, lead: "zzzzzz" };
    const c = { ...a, effectiveAt: hoursAgo(3) };
    assert.ok(byScore(a, b) < 0 || a.lead > b.lead);
    assert.ok(byScore(c, a) < 0, "equal score: newer first");
    assert.equal(byScore(a, a), 0);
  });

  it("handles an empty list", () => {
    const ctx = createTestContext();
    assert.deepEqual(score([], noSignals, ctx), []);
    assert.match(ctx.logs[0].msg, /top -$/);
  });
});
