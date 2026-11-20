import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleId } from "../../../shared/contract";
import { sectionById, type SectionId } from "../../../shared/sections";
import { ageHours } from "../../../shared/time";
import { FIXTURE_NOW_ISO, hoursAgo, makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import type { ScoredStory } from "../types";
import { UNVETTED_OUTLET_TAG } from "../../registry/outlets";
import { dedupeHomepage, inFloorWindow, isLowSignal, isUnvettedLed, regulatorFloorRows, releaseProject, subjectsOf, type SectionRows } from "./homepage";
import { ROUTE_POLICY } from "./rules";

let seq = 0;
function story(publisher?: string): ScoredStory {
  seq += 1;
  const lead = makeNormalized({ title: `Story ${seq}`, publisher: publisher ?? `pub-${seq}`, sourceId: publisher ?? `src-${seq}`, publishedAt: hoursAgo(1) });
  return makeScoredStory([lead], { score: 1000 - seq });
}
const many = (n: number): ScoredStory[] => Array.from({ length: n }, () => story());
const sec = (id: SectionId, rows: ScoredStory[]): SectionRows => ({ def: sectionById(id), rows });
const primaries = (map: Map<ScoredStory, SectionId>, fallback: Record<ArticleId, SectionId>) => (lead: ArticleId): SectionId => {
  for (const [s, id] of map) if (s.lead === lead) return id;
  return fallback[lead];
};

describe("dedupeHomepage", () => {
  it("shows a dual-placed story on the homepage of its primary section only", () => {
    const shared = story();
    const industry = [shared, ...many(15)]; // homeRows 12
    const money = [shared, ...many(14)]; // homeRows 10
    const fallback: Record<ArticleId, SectionId> = {};
    for (const s of industry) fallback[s.lead] = "industry";
    for (const s of money) fallback[s.lead] = "money";
    const [ind, mon] = dedupeHomepage([sec("industry", industry), sec("money", money)], primaries(new Map([[shared, "money"]]), fallback));

    assert.equal(mon[0], shared);
    assert.ok(!ind.slice(0, 12).includes(shared), "repeat must leave the INDUSTRY homepage");
    assert.equal(ind[12], shared, "and sit right below the cut, in rank order");
    assert.deepEqual(ind.slice(0, 12), industry.slice(1, 13));
    assert.equal(ind.length, industry.length);
  });

  it("never empties homepage rows: a thin section keeps the repeat, in rank order", () => {
    const shared = story();
    const safety = [shared, ...many(3)]; // homeRows 8, only 4 rows
    const tools = [shared, ...many(12)];
    const fallback: Record<ArticleId, SectionId> = {};
    for (const s of safety) fallback[s.lead] = "safety";
    for (const s of tools) fallback[s.lead] = "tools";
    const [saf] = dedupeHomepage([sec("safety", safety), sec("tools", tools)], primaries(new Map([[shared, "tools"]]), fallback));
    assert.deepEqual(saf, safety);
  });

  it("a repeat stays when its primary section does not show it on the homepage", () => {
    const shared = story();
    const money = [...many(12), shared]; // rank 13 of a 10-row homepage
    const industry = [shared, ...many(14)];
    const fallback: Record<ArticleId, SectionId> = {};
    for (const s of industry) fallback[s.lead] = "industry";
    for (const s of money) fallback[s.lead] = "money";
    const [ind] = dedupeHomepage([sec("industry", industry), sec("money", money)], primaries(new Map([[shared, "money"]]), fallback));
    assert.equal(ind[0], shared);
  });

  it("only reorders: same members per section, rank order kept on both sides of the cut", () => {
    const a = story();
    const b = story();
    const industry = [a, b, ...many(20)];
    const money = [a, ...many(11)];
    const compute = [b, ...many(11)];
    const fallback: Record<ArticleId, SectionId> = {};
    for (const s of industry) fallback[s.lead] = "industry";
    for (const s of money) fallback[s.lead] = "money";
    for (const s of compute) fallback[s.lead] = "compute";
    const input = [sec("industry", industry), sec("money", money), sec("compute", compute)];
    const out = dedupeHomepage(input, primaries(new Map([[a, "money"], [b, "compute"]]), fallback));
    out.forEach((rows, i) => {
      const before = input[i].rows;
      assert.deepEqual([...rows].sort((x, y) => y.score - x.score), [...before]);
      const cut = input[i].def.homeRows;
      for (const part of [rows.slice(0, cut), rows.slice(cut)]) {
        assert.deepEqual(part, [...part].sort((x, y) => y.score - x.score));
      }
    });
    const home = new Map<ArticleId, number>();
    out.forEach((rows, i) => rows.slice(0, input[i].def.homeRows).forEach((s) => home.set(s.lead, (home.get(s.lead) ?? 0) + 1)));
    assert.equal(Math.max(...home.values()), 1, "no story on two homepages");
  });

  it("a row pulled up must still respect the publisher cap", () => {
    const shared = story();
    const big = (): ScoredStory => story("big");
    // homepage of MODELS (10 rows, cap 3): 3 x big already there; the row pulled up is a 4th big one.
    const models = [shared, big(), big(), big(), ...many(6), big(), story()];
    const tools = [shared, ...many(10)];
    const fallback: Record<ArticleId, SectionId> = {};
    for (const s of models) fallback[s.lead] = "models";
    for (const s of tools) fallback[s.lead] = "tools";
    const [mod] = dedupeHomepage([sec("models", models), sec("tools", tools)], primaries(new Map([[shared, "tools"]]), fallback));
    const home = mod.slice(0, 10);
    assert.equal(home.filter((s) => s.items[0].publisher === "big").length, 3);
    assert.equal(home[9], models[11]);
  });
});

describe("same-subject cap on homepage rows", () => {
  const titled = (title: string, publisher = `pub-${seq + 1}`): ScoredStory => {
    seq += 1;
    return makeScoredStory([makeNormalized({ title, publisher, sourceId: publisher, publishedAt: hoursAgo(1) })], { score: 1000 - seq });
  };
  /** A story covered by `pubs` publishers whose headlines have `subject` in common and nothing else. */
  const big = (subject: string, pubs: number): ScoredStory => {
    seq += 1;
    const items = Array.from({ length: pubs }, (_, i) => makeNormalized({ title: `${subject} angle${seq}x${i} outlet${seq}x${i}`, publisher: `big-${seq}-${i}`, sourceId: `big-${seq}-${i}`, publishedAt: hoursAgo(2) }));
    return makeScoredStory(items, { score: 2000 - seq });
  };
  const cap = ROUTE_POLICY.subjectCap;
  const primaryIn = (id: SectionId) => (): SectionId => id;

  it("a subject is the title tokens (nearly) every member of a big story carries - and needs a name", () => {
    const ipo = big("Anthropic's record IPO", cap.minPublishers);
    assert.deepEqual(subjectsOf([ipo]), [{ story: ipo.lead, tokens: ["anthropic", "ipo", "record"] }]);
    assert.deepEqual(subjectsOf([big("Anthropic", cap.minPublishers - 1)]), [], "not a big story");
    // Members that agree on the company only: the subject is the company.
    seq += 1;
    const mixed = makeScoredStory(
      ["Anthropic prices IPO", "Anthropic starts trading on Wall Street", "Why Anthropic matters", "Anthropic's founders cash out", "Protests greet Anthropic debut", "Anthropic shares jump 17%"].map((title, i) =>
        makeNormalized({ title, publisher: `mix-${i}`, sourceId: `mix-${i}`, publishedAt: hoursAgo(3) }),
      ),
    );
    assert.deepEqual(subjectsOf([mixed])[0].tokens, ["anthropic"]);
    // Sharing only a version number, or only stopwords ("AI"), names nothing.
    seq += 1;
    const numbers = makeScoredStory(["Gemini 4 Neon is here", "Genie 4 worlds", "Version 4 of everything", "AI 4 all", "Take 4", "Round 4 begins"].map((title, i) => makeNormalized({ title, publisher: `num-${i}`, sourceId: `num-${i}` })));
    assert.deepEqual(subjectsOf([numbers]), []);
  });

  it(`keeps at most ${cap.maxHomeRows} rows about one big story's subject on a section's homepage, the rest just below the cut`, () => {
    const ipo = big("Anthropic", 8);
    const angles = Array.from({ length: 5 }, (_, i) => titled(`What Anthropic's debut means for sector ${i}`));
    const others = many(12);
    const money = [ipo, ...angles, ...others]; // homeRows 10
    const [rows] = dedupeHomepage([sec("money", money)], primaryIn("money"), subjectsOf(money));
    const home = rows.slice(0, 10);
    assert.equal(home.filter((s) => /anthropic/i.test(s.items[0].title)).length, cap.maxHomeRows, "the story itself counts");
    assert.equal(home[0], ipo);
    assert.deepEqual(home.slice(1, cap.maxHomeRows), angles.slice(0, cap.maxHomeRows - 1));
    assert.deepEqual(rows.slice(10, 10 + 6 - cap.maxHomeRows), angles.slice(cap.maxHomeRows - 1), "deferred rows sit right below the cut, in rank order");
    assert.deepEqual([...rows].sort((a, b) => b.score - a.score), money, "membership never changes");
    // Without subjects nothing is deferred (the default argument).
    assert.deepEqual(dedupeHomepage([sec("money", money)], primaryIn("money"))[0], money);
  });

  it("applies in a section the big story is not listed in, and never to another big story", () => {
    const ipo = big("Anthropic", 8);
    const second = big("Anthropic", cap.minPublishers);
    const angles = Array.from({ length: 5 }, (_, i) => titled(`Anthropic angle piece number ${i}`));
    const industry = [...angles, second, ...many(14)]; // homeRows 12; `ipo` is listed elsewhere
    const [rows] = dedupeHomepage([sec("industry", industry)], primaryIn("industry"), subjectsOf([ipo, second, ...industry]));
    const home = rows.slice(0, 12);
    assert.equal(home.filter((s) => angles.includes(s)).length, cap.maxHomeRows);
    assert.ok(home.includes(second), "a story that is big in its own right is never deferred");
  });

  it("never leaves homepage rows empty for the sake of the cap", () => {
    const ipo = big("Anthropic", 8);
    const angles = Array.from({ length: 6 }, (_, i) => titled(`Anthropic angle piece number ${i}`));
    const thin = [ipo, ...angles, ...many(2)]; // 9 rows for a 10-row homepage
    const [rows] = dedupeHomepage([sec("money", thin)], primaryIn("money"), subjectsOf(thin));
    assert.deepEqual(rows, thin);
  });

  it("a headline must carry ALL of a subject's tokens: GPT-6.2 Astra pieces are capped, other GPT rows are not", () => {
    const launch = big("GPT-6.2 Astra", cap.minPublishers);
    const astra = Array.from({ length: 4 }, (_, i) => titled(`GPT-6.2 Astra review ${i}`));
    const otherGpt = Array.from({ length: 4 }, (_, i) => titled(`GPT-5 retirement note ${i}`));
    const models = [launch, ...astra, ...otherGpt, ...many(8)];
    const subjects = subjectsOf(models);
    assert.deepEqual(subjects, [{ story: launch.lead, tokens: ["6.2", "astra", "gpt"] }]);
    const [rows] = dedupeHomepage([sec("models", models)], primaryIn("models"), subjects);
    const home = rows.slice(0, 10);
    assert.equal(home.filter((s) => astra.includes(s)).length, cap.maxHomeRows - 1);
    assert.equal(home.filter((s) => otherGpt.includes(s)).length, 4);
  });
});

// ------------------------------------------------------------------------------------------------
// Regulator floor, cross-listings and release rows
// ------------------------------------------------------------------------------------------------

const NOW = new Date(FIXTURE_NOW_ISO);
const primaryIn = (id: SectionId) => (): SectionId => id;
const floor = ROUTE_POLICY.regulatorFloor;
const ageOf = (s: ScoredStory): number => ageHours(s.effectiveAt, NOW);

/** A regulator's own notice: `publisher` is the regulator's publisher id. */
function notice(publisher: string, o: { hours?: number; score: number; publishedAt?: string; tags?: string[]; title?: string }): ScoredStory {
  seq += 1;
  const lead = makeNormalized({
    title: o.title ?? `${publisher} notice ${seq}`,
    publisher,
    sourceId: `${publisher}-feed`,
    home: "policy",
    tags: o.tags ?? ["regulator", "finreg", "first-party"],
    publishedAt: o.publishedAt ?? hoursAgo(o.hours ?? 10),
  });
  return makeScoredStory([lead], { score: o.score }, NOW.getTime());
}
/** Ordinary POLICY rows with the given scores. */
const press = (scores: number[]): ScoredStory[] =>
  scores.map((score) => {
    seq += 1;
    return makeScoredStory([makeNormalized({ title: `Policy story ${seq}`, publisher: `press-${seq}`, sourceId: `press-src-${seq}`, home: "policy", publishedAt: hoursAgo(3) })], { score }, NOW.getTime());
  });
const ranked = (rows: ScoredStory[]): ScoredStory[] => [...rows].sort((a, b) => b.score - a.score);
const policyHome = (rows: ScoredStory[], now: Date | undefined = NOW): ScoredStory[] => dedupeHomepage([sec("policy", ranked(rows))], primaryIn("policy"), [], now)[0].slice(0, 10);

describe("regulator placement floor (POLICY homepage)", () => {
  it("is the live board of 2026-11-20: FINRA at #11, three Bank of England rows, FCA and IOSCO in view-all", () => {
    const boe = [notice("bank-of-england", { score: 63.1, hours: 16 }), notice("bank-of-england", { score: 63.0, hours: 16 }), notice("bank-of-england", { score: 61.3, hours: 18 })];
    const finra = notice("finra", { score: 54.2, publishedAt: "2026-11-18T12:00:00.000Z", title: "Regulatory Notice 26-24: FINRA has adopted amendments to FINRA Rule 2210" });
    const fca = notice("fca", { score: 53.4, hours: 17 });
    const iosco = notice("iosco", { score: 51.8, hours: 19 });
    const others = press([93.5, 82.4, 69.4, 61.1, 58.2, 56.1, 56.05, 53.9, 53.7, 53.5, 53.45, 53.1, 53.0, 50.3]);
    const all = [...boe, finra, fca, iosco, ...others];

    // As shipped (no clock = no floor): FINRA is row #11, BoE holds three rows.
    const before = dedupeHomepage([sec("policy", ranked(all))], primaryIn("policy"))[0];
    assert.equal(before.indexOf(finra), 10);
    assert.equal(before.slice(0, 10).filter((s) => boe.includes(s)).length, 3);

    const home = policyHome(all);
    assert.ok(home.includes(finra) && home.includes(fca) && home.includes(iosco), "one notice per listed regulator is on the homepage");
    assert.deepEqual(home.filter((s) => boe.includes(s)), boe.slice(0, 2), "a regulator holds at most two homepage rows");
    assert.equal(home.length, 10);
    assert.deepEqual(home, ranked(home), "rank order is kept on the homepage");
    // The four guaranteed rows: one per regulator, in rank order.
    assert.deepEqual(regulatorFloorRows(sectionById("policy"), ranked(all), NOW), [boe[0], finra, fca, iosco]);
    // Nothing is dropped: the full list has the same members.
    const full = dedupeHomepage([sec("policy", ranked(all))], primaryIn("policy"), [], NOW)[0];
    assert.equal(new Set(full).size, all.length);
    assert.equal(full[10], boe[2], "the third Bank of England paper sits right below the cut");
  });

  it(`guarantees at most ${floor.maxRows} rows, one regulator at a time before anyone's second`, () => {
    const regs = ["finra", "sec", "occ", "fca", "cftc"];
    const firsts = regs.map((r, i) => notice(r, { score: 20 - i }));
    const seconds = regs.map((r, i) => notice(r, { score: 10 - i }));
    const others = press(Array.from({ length: 14 }, (_, i) => 90 - i));
    const rows = ranked([...firsts, ...seconds, ...others]);
    const got = regulatorFloorRows(sectionById("policy"), rows, NOW);
    assert.deepEqual(got, firsts.slice(0, floor.maxRows));
    const home = policyHome([...firsts, ...seconds, ...others]);
    assert.equal(home.filter((s) => firsts.includes(s) || seconds.includes(s)).length, floor.maxRows);
    assert.deepEqual(home.slice(0, 10 - floor.maxRows), others.slice(0, 10 - floor.maxRows), "the rest of the homepage is the best of the ordinary rows");
    // Two regulators only: each gets its second row before the guarantee runs out.
    const two = [notice("finra", { score: 9 }), notice("finra", { score: 8 }), notice("finra", { score: 7 }), notice("sec", { score: 6 }), notice("sec", { score: 5 })];
    assert.deepEqual(regulatorFloorRows(sectionById("policy"), ranked([...two, ...others]), NOW), [two[0], two[3], two[1], two[4]]);
  });

  it(`covers ${floor.hours} h after publication; a date-only stamp is given the rest of its day`, () => {
    const others = press(Array.from({ length: 14 }, (_, i) => 90 - i));
    const inside = notice("finra", { score: 5, hours: floor.hours - 1 });
    const outside = notice("sec", { score: 4, hours: floor.hours + 1 });
    const home = policyHome([inside, outside, ...others]);
    assert.ok(home.includes(inside) && !home.includes(outside));
    assert.equal(floor.hours, 72);
    assert.ok(inFloorWindow(notice("fca", { score: 1, hours: 60 }), NOW) && !inFloorWindow(notice("fca", { score: 1, hours: 73 }), NOW));
    // "Nov 16, 2026" is 12:00 UTC to normalize; the notice may have gone out as late as that evening.
    const dateOnly = notice("occ", { score: 3, publishedAt: hoursAgo(floor.hours + floor.dateOnlyGraceHours - 0.5).replace(/T.*$/, "T12:00:00.000Z") });
    const timed = notice("cftc", { score: 2, publishedAt: hoursAgo(floor.hours + 6) });
    assert.equal(inFloorWindow(dateOnly, NOW), ageOf(dateOnly) <= floor.hours + floor.dateOnlyGraceHours);
    assert.ok(ageOf(dateOnly) > floor.hours, "older than 72 h on the clock");
    assert.ok(inFloorWindow(dateOnly, NOW) && !inFloorWindow(timed, NOW));
  });

  it("applies to listed regulators' own notices in POLICY only; other regulator feeds are capped, not guaranteed", () => {
    const others = press(Array.from({ length: 14 }, (_, i) => 90 - i));
    const pressAboutFinra = notice("finra", { score: 5, tags: ["press"] });
    const fedRegister = [notice("federal-register", { score: 99 }), notice("federal-register", { score: 98 }), notice("federal-register", { score: 97 }), notice("federal-register", { score: 1 })];
    const home = policyHome([pressAboutFinra, ...fedRegister, ...others]);
    assert.ok(!home.includes(pressAboutFinra), "not a first-party notice");
    assert.deepEqual(home.filter((s) => fedRegister.includes(s)), fedRegister.slice(0, floor.perRegulator), "capped at two rows on merit, no guarantee for the fourth");
    assert.deepEqual(regulatorFloorRows(sectionById("policy"), ranked([pressAboutFinra, ...fedRegister, ...others]), NOW), []);
    // Another section: no floor, no regulator cap.
    const finra = notice("finra", { score: 1 });
    assert.deepEqual(regulatorFloorRows(sectionById("money"), [finra], NOW), []);
    const money = ranked([finra, ...others]);
    assert.ok(!dedupeHomepage([sec("money", money)], primaryIn("money"), [], NOW)[0].slice(0, 10).includes(finra));
  });

  it("never empties the homepage and never guarantees more rows than it has", () => {
    const thin = [notice("finra", { score: 9 }), notice("finra", { score: 8 }), notice("finra", { score: 7 }), ...press([50, 40])];
    assert.deepEqual(policyHome(thin), ranked(thin), "five rows for ten slots: the third FINRA notice comes back");
  });
});

describe("cross-listings and release rows", () => {
  const item = (title: string, o: Partial<Parameters<typeof makeNormalized>[0]> & { score: number }): ScoredStory => {
    seq += 1;
    const { score, ...rest } = o;
    return makeScoredStory([makeNormalized({ title, publisher: `x-${seq}`, sourceId: `x-src-${seq}`, publishedAt: hoursAgo(3), ...rest })], { score }, NOW.getTime());
  };

  it("a story homed in AI SECURITY is never a homepage row of another section (live: two vLLM advisories in LOCAL)", () => {
    assert.deepEqual(ROUTE_POLICY.crossListOnlyHomes, ["ai_security"]);
    const advisory = item("vLLM from 0.28.0 before 0.33.0 contains an improper input validation vulnerability", { score: 95, home: "ai_security" });
    const local = Array.from({ length: 12 }, (_, i) => item(`Local model news ${i}`, { score: 90 - i, home: "open_local" }));
    const rows = ranked([advisory, ...local]);
    // Its primary is LOCAL itself (AI SECURITY's own list was full): it is still a cross-listing.
    const [got] = dedupeHomepage([sec("open_local", rows)], primaryIn("open_local"), [], NOW);
    assert.ok(!got.slice(0, 10).includes(advisory));
    assert.equal(got[10], advisory, "right below the cut, still in the list");
    // In AI SECURITY it is an ordinary row.
    assert.equal(dedupeHomepage([sec("ai_security", [advisory])], primaryIn("ai_security"), [], NOW)[0][0], advisory);
    // A thin section keeps it rather than show a hole.
    const thin = ranked([advisory, ...local.slice(0, 4)]);
    assert.deepEqual(dedupeHomepage([sec("open_local", thin)], primaryIn("open_local"), [], NOW)[0], thin);
  });

  it(`LOCAL keeps up to ${ROUTE_POLICY.releaseRows.maxRows} routed-in release lines on its homepage although RELEASE RADAR shows them, below the first rows`, () => {
    const release = (title: string, score: number): ScoredStory => item(title, { score, home: "releases", kind: "github-release", flags: ["release"] });
    const tags = [release("llama.cpp b12557 released", 99), release("ollama v0.40.17 released", 98), release("llama.cpp b12558 released", 97)];
    const local = Array.from({ length: 12 }, (_, i) => item(`Local model news ${i}`, { score: 90 - i, home: "open_local" }));
    const radar = sec("releases", tags);
    const primary = primaries(new Map(tags.map((t) => [t, "releases" as SectionId])), Object.fromEntries(local.map((s) => [s.lead, "open_local" as SectionId])));
    const [open, rel] = dedupeHomepage([sec("open_local", ranked([...tags, ...local])), radar], primary, [], NOW);
    assert.deepEqual(rel.slice(0, 3), tags, "the release radar is unchanged");
    const home = open.slice(0, 10);
    assert.deepEqual(home.filter((s) => tags.includes(s)), tags.slice(0, ROUTE_POLICY.releaseRows.maxRows));
    assert.ok(home.indexOf(tags[0]) >= ROUTE_POLICY.releaseHoldBackRows, "never one of the first rows");
    assert.equal(open[10], tags[2], "the third tag is a repeat below the cut");
    // In a section without the exception the old rule holds: shown on the release radar, not twice.
    const [tools] = dedupeHomepage([sec("tools", ranked([...tags, ...local])), radar], primary, [], NOW);
    assert.equal(tools.slice(0, 10).filter((s) => tags.includes(s)).length, 0);
  });
});

describe("unvetted outlets", () => {
  const item = (title: string, score: number, tags: string[] = []): ScoredStory => {
    seq += 1;
    return makeScoredStory([makeNormalized({ title, publisher: `u-${seq}`, sourceId: `u-src-${seq}`, publishedAt: hoursAgo(2), home: "ai_security", tags })], { score }, NOW.getTime());
  };

  it("a story led by an unvetted outlet never takes a homepage row while another row could; the rest keeps its order", () => {
    assert.equal(UNVETTED_OUTLET_TAG, "unvetted-outlet");
    const rows = Array.from({ length: 12 }, (_, i) => item(`Agent security news ${i}`, 100 - i, i === 2 ? [UNVETTED_OUTLET_TAG] : []));
    const unvetted = rows[2];
    assert.ok(isUnvettedLed(unvetted));
    const def = sectionById("ai_security");
    assert.equal(def.homeRows, 10);
    const [got] = dedupeHomepage([sec("ai_security", rows)], primaryIn("ai_security"), [], NOW);
    assert.deepEqual(got.slice(0, 10), [...rows.slice(0, 2), ...rows.slice(3, 11)], "the homepage rows skip it");
    assert.equal(got[10], unvetted, "it stays in the full list, in rank order below the cut");
    assert.equal(got[11], rows[11]);
    assert.equal(got.length, rows.length);
  });

  it("is the LAST resort when the section would otherwise show a hole: after over-cap rows", () => {
    // 9 vetted rows + 1 unvetted: the homepage would be one short without it.
    const rows = Array.from({ length: 10 }, (_, i) => item(`Thin day ${i}`, 100 - i, i === 0 ? [UNVETTED_OUTLET_TAG] : []));
    const [got] = dedupeHomepage([sec("ai_security", rows)], primaryIn("ai_security"), [], NOW);
    assert.deepEqual(got, rows, "kept, in rank order, rather than an empty row");
    // With one spare over-cap row the spare row is preferred.
    seq += 1;
    const samePublisher = Array.from({ length: 5 }, (_, i) => makeScoredStory([makeNormalized({ title: `Vendor post ${i}`, publisher: "one-vendor", sourceId: "one-vendor-blog", publishedAt: hoursAgo(2), home: "ai_security" })], { score: 80 - i }, NOW.getTime()));
    const others = Array.from({ length: 6 }, (_, i) => item(`Other news ${i}`, 60 - i));
    const tagged = item("Rewritten wire copy", 99, [UNVETTED_OUTLET_TAG]);
    const [mixed] = dedupeHomepage([sec("ai_security", ranked([tagged, ...samePublisher, ...others]))], primaryIn("ai_security"), [], NOW);
    assert.ok(!mixed.slice(0, 10).includes(tagged), "an over-cap publisher row fills the slot first");
    assert.equal(mixed.slice(0, 10).filter((s) => samePublisher.includes(s)).length, 4);
  });
});

describe("low-signal rows and release lines next to their own news (closing round)", () => {
  const NOW = new Date(FIXTURE_NOW_ISO);
  const item = (title: string, score: number, o: Partial<ScoredStory["items"][number]> & { w?: ScoredStory["w"]; hours?: number } = {}): ScoredStory => {
    seq += 1;
    const { w, hours, ...lead } = o;
    return makeScoredStory([makeNormalized({ title, publisher: `l-${seq}`, sourceId: `l-src-${seq}`, publishedAt: hoursAgo(hours ?? 3), home: "open_local", ...lead })], { score, ...(w === undefined ? {} : { w }) }, NOW.getTime());
  };
  const only = (id: SectionId) => (): SectionId => id;
  const byScore = (rows: ScoredStory[]): ScoredStory[] => [...rows].sort((a, b) => b.score - a.score);

  it("a weight-0 row or a forum thread takes a homepage row of a topic section only when nothing else can (live: MODELS #6, LOCAL #10)", () => {
    const ticker = item("Mistral: Pixtral Large 2502", 99, { tier: 4, w: 0, home: "models" });
    const forum = item("Buying a 512GB unified-memory machine - will it age well over 2-5 years?", 98, { kind: "community", flags: ["discussion"], tier: 4, w: 0 });
    assert.ok(isLowSignal(ticker) && isLowSignal(forum));
    assert.ok(!isLowSignal(item("llama.cpp b12557 released", 50, { kind: "github-release", flags: ["release"], tier: 4, w: 0 })), "a release line is not low-signal");
    assert.ok(!isLowSignal(item("An ordinary tier-3 row", 50)));
    const local = Array.from({ length: 12 }, (_, i) => item(`Local model news ${i}`, 90 - i));
    const [got] = dedupeHomepage([sec("open_local", byScore([forum, ...local]))], only("open_local"), [], NOW);
    assert.deepEqual(got.slice(0, 10), local.slice(0, 10), "ten on-beat rows, in rank order");
    assert.equal(got[10], forum, "the thread stays in the full list, right below the cut");
    assert.equal(got.length, 13);
    const models = Array.from({ length: 12 }, (_, i) => item(`Model news ${i}`, 90 - i, { home: "models" }));
    assert.ok(!dedupeHomepage([sec("models", byScore([ticker, ...models]))], only("models"), [], NOW)[0].slice(0, 10).includes(ticker));
    // A thin section keeps it rather than show a hole - after over-cap rows, before an unvetted outlet.
    const thin = byScore([forum, ...local.slice(0, 5)]);
    assert.deepEqual(dedupeHomepage([sec("open_local", thin)], only("open_local"), [], NOW)[0], thin);
    const unvetted = item("Rewritten wire copy", 97, { tags: [UNVETTED_OUTLET_TAG] });
    const [nine] = dedupeHomepage([sec("open_local", byScore([forum, unvetted, ...local.slice(0, 9)]))], only("open_local"), [], NOW);
    assert.ok(nine.slice(0, 10).includes(forum) && !nine.slice(0, 10).includes(unvetted));
  });

  it("does not apply to a source-mode desk: SAFETY and QUANTUM WATCH are their sources", () => {
    assert.equal(sectionById("safety").mode, "source");
    const post = item("Anthropic is not living up to its ideals", 99, { kind: "community", flags: ["discussion"], tier: 4, w: 0, home: "safety" });
    const rest = Array.from({ length: 12 }, (_, i) => item(`Alignment post ${i}`, 90 - i, { home: "safety" }));
    const rows = byScore([post, ...rest]);
    assert.deepEqual(dedupeHomepage([sec("safety", rows)], only("safety"), [], NOW)[0], rows);
  });

  it("a routed-in release line waits below the cut when a news row of the section names its project (live: Unsloth at LOCAL #1 and #5)", () => {
    const release = (title: string, score: number, hours = 13): ScoredStory => item(title, score, { home: "releases", kind: "github-release", flags: ["release"], hours });
    const news = item("AMD and Unsloth Bring NPU Support to 100+ Agentic AI Applications", 99, { hours: 16 });
    const unsloth = release("unsloth v0.1.920-beta: AMD NPU + video diffusion LoRA", 95);
    const llama = release("llama.cpp b12557 released", 94);
    assert.equal(releaseProject(unsloth), "unsloth");
    assert.equal(releaseProject(llama), "llama.cpp");
    assert.equal(releaseProject(release("v2.1.0", 1)), null, "a bare version names no project");
    const local = Array.from({ length: 12 }, (_, i) => item(`Local model news ${i}`, 90 - i));
    const [got] = dedupeHomepage([sec("open_local", byScore([news, unsloth, llama, ...local]))], only("open_local"), [], NOW);
    const home = got.slice(0, 10);
    assert.ok(home.includes(news) && home.includes(llama), "the news row and an unrelated release line stay");
    assert.ok(!home.includes(unsloth), "the release line of the same announcement does not");
    assert.ok(got.includes(unsloth), "it stays in the full list");
    // Four days later the release line is its own news again.
    const old = item("AMD and Unsloth Bring NPU Support to 100+ Agentic AI Applications", 99, { hours: 110 });
    const [later] = dedupeHomepage([sec("open_local", byScore([old, unsloth, llama, ...local]))], only("open_local"), [], NOW);
    assert.ok(later.slice(0, 10).includes(unsloth));
  });
});
