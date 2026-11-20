import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleId } from "../../../shared/contract";
import { SECTIONS, SECTION_IDS, findSection, sectionById, type SectionId } from "../../../shared/sections";
import { FIXTURE_NOW_ISO, hoursAgo, makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import { createTestContext } from "../context";
import type { NormalizedItem, Placements, ScoredStory } from "../types";
import { capAt } from "./diversity";
import { isLowSignal } from "./homepage";
import { route } from "./index";

let seq = 0;
function story(title: string, o: { hours?: number; score?: number; pubs?: number; lead?: Partial<NormalizedItem> } = {}): ScoredStory {
  seq += 1;
  const n = o.pubs ?? 1;
  const items = Array.from({ length: n }, (_, i) =>
    makeNormalized({
      title: i === 0 ? title : `${title} (outlet ${i})`,
      publisher: `pub-${seq}-${i}`,
      sourceId: `src-${seq}-${i}`,
      publishedAt: hoursAgo((o.hours ?? 2) + i * 0.1),
      ...(i === 0 ? o.lead : {}),
    }),
  );
  return makeScoredStory(items, { score: o.score ?? 100 - seq * 0.001 });
}

const TITLES = [
  "LangChain Raises $300M Series C at $3B Valuation",
  "Prompt injection flaw lets attackers hijack Copilot agents",
  "OpenAI launches GPT-6.2 with a longer context window",
  "Nvidia H200 exports to China cleared as data center demand grows",
  "House lawmakers form AI caucus; SEC weighs disclosure rule",
  "Humanoid robots head to the factory floor",
  "Ollama adds GGUF quantization presets for local models",
  "Who are Anthropic's seven co-founders?",
  "European Commission confirms cyberattack, says hackers used AI tool",
  "Drupal patches critical RCE flaw",
  "A game you cannot win unless you have a quantum computer",
  "ollama v0.40.17 released",
  "Introducing Tool Retrieval in the Gemini API",
  "Notes on a quiet week",
];
const KINDS: Partial<NormalizedItem>[] = [
  {},
  { kind: "newsletter" },
  { kind: "papers", flags: ["paper"] },
  { kind: "github-release", flags: ["release"], leadEligible: false, countsForCoverage: false },
  { kind: "community", flags: ["discussion"], routing: "home-only", leadEligible: false, countsForCoverage: false },
  { kind: "aggregator", attribution: "link-host" },
  { routeTo: ["money", "policy"] },
  { scope: "general" },
];

/** A deterministic mixed corpus: every home x title, cycling kinds, ages, coverage and publishers. */
function corpus(): ScoredStory[] {
  const out: ScoredStory[] = [];
  let i = 0;
  for (const home of SECTION_IDS) {
    for (const title of TITLES) {
      i += 1;
      const kind = KINDS[i % KINDS.length];
      const pubs = kind.countsForCoverage === false ? 1 : 1 + (i % 4);
      const s = story(`${title} #${i}`, { hours: (i * 7) % 400, score: 200 - ((i * 37) % 150), pubs, lead: { home, ...kind, publisher: `p${i % 4}`, sourceId: `s${i % 13}` } });
      // Stories led by a non-coverage item have no publishers.
      out.push(kind.countsForCoverage === false ? { ...s, publishers: [] } : s);
    }
  }
  return out;
}

function placementsOf(pl: Placements): Map<ArticleId, SectionId[]> {
  const m = new Map<ArticleId, SectionId[]>();
  for (const s of pl.sections) for (const id of s.rows) m.set(id, [...(m.get(id) ?? []), s.id]);
  return m;
}

describe("route - contract invariants", () => {
  const stories = corpus();
  const ctx = createTestContext();
  const pl = route(stories, ctx);
  const placed = placementsOf(pl);

  it("returns every section once, in SECTIONS order, within its row limits", () => {
    assert.deepEqual(pl.sections.map((s) => s.id), SECTIONS.map((s) => s.id));
    for (const s of pl.sections) {
      const def = sectionById(s.id);
      assert.ok(s.rows.length <= def.allRows, s.id);
      assert.equal(s.homeCount, Math.min(def.homeRows, s.rows.length), s.id);
      assert.equal(new Set(s.rows).size, s.rows.length, `${s.id}: duplicate rows`);
    }
    assert.ok(placed.size > 50);
  });

  it("a story appears in its home section plus AT MOST ONE routed section", () => {
    for (const [id, secs] of placed) {
      const home = pl.stories[id].items[0].home;
      const routed = secs.filter((s) => s !== home);
      assert.ok(secs.length <= 2 && routed.length <= 1, `${id} in ${secs.join(",")} (home ${home})`);
    }
    assert.ok([...placed.values()].some((s) => s.length === 2), "the corpus must exercise dual placement");
  });

  it("source-mode sections only hold stories whose home they are", () => {
    for (const s of pl.sections) {
      if (sectionById(s.id).mode !== "source") continue;
      for (const id of s.rows) assert.equal(pl.stories[id].items[0].home, s.id);
    }
  });

  it("home-only sources never leave home; routeTo allowlists hold", () => {
    for (const [id, secs] of placed) {
      const lead = pl.stories[id].items[0];
      const routed = secs.filter((s) => s !== lead.home);
      if (lead.routing === "home-only") assert.deepEqual(routed, [], id);
      if (lead.routeTo) for (const r of routed) assert.ok(lead.routeTo.includes(r), `${id} routed to ${r}`);
    }
  });

  it("rows are story leads inside the section's hard window", () => {
    for (const s of pl.sections) {
      const hardHours = sectionById(s.id).window.hardDays * 24;
      for (const id of s.rows) {
        const st = pl.stories[id];
        assert.equal(st.lead, id);
        assert.ok(st.ageHours <= hardHours, `${s.id}: ${id} is ${st.ageHours} h old`);
      }
    }
  });

  it("stories, primary and trace cover EVERY input story", () => {
    assert.equal(Object.keys(pl.stories).length, stories.length);
    for (const s of stories) {
      assert.equal(pl.stories[s.lead], s);
      const primary = pl.primary[s.lead];
      assert.ok(findSection(primary), `${s.lead}: primary ${primary}`);
      const secs = placed.get(s.lead);
      if (secs) assert.ok(secs.includes(primary), `${s.lead}: primary ${primary} is not one of its placements ${secs.join(",")}`);
      assert.ok(pl.trace?.[s.lead], `${s.lead}: no trace`);
    }
  });

  it("the trace explains every placement and every cut", () => {
    for (const s of stories) {
      const t = pl.trace?.[s.lead];
      const secs = placed.get(s.lead) ?? [];
      const home = s.items[0].home;
      const routed = secs.find((x) => x !== home) ?? null;
      if (routed) {
        assert.equal(t?.routedTo, routed);
        assert.ok(t?.rule, `${s.lead}: routed without a rule`);
      }
      for (const cutSection of Object.keys(t?.cut ?? {})) assert.ok(!secs.includes(cutSection as SectionId), `${s.lead}: cut from ${cutSection} but listed there`);
      // A candidate section the story is missing from must carry a reason.
      for (const want of [home, t?.routedTo].filter((x): x is SectionId => !!x)) {
        if (!secs.includes(want)) assert.ok(t?.cut?.[want], `${s.lead}: not in ${want} and no reason given`);
      }
    }
    const reasons = new Set(Object.values(pl.trace ?? {}).flatMap((t) => Object.values(t.cut ?? {})));
    for (const r of ["window", "diversity", "limit"] as const) assert.ok(reasons.has(r), `corpus never produced a "${r}" cut`);
  });

  it("TOP STORIES: ai desk, >= 2 publishers, never a release / community lead, within 120 h, max 12", () => {
    assert.ok(pl.top.length > 0 && pl.top.length <= 12);
    assert.equal(new Set(pl.top).size, pl.top.length);
    assert.equal(pl.leadId, pl.top[0]);
    for (const id of pl.top) {
      const s = pl.stories[id];
      const lead = s.items[0];
      assert.ok(s.publishers.length >= 2, id);
      assert.ok(!lead.flags.includes("release") && !lead.flags.includes("discussion"), id);
      assert.ok(lead.kind !== "github-release" && lead.kind !== "community", id);
      assert.ok(s.ageHours <= 120, id);
      const desks = [lead.home, ...(placed.get(id) ?? [])].map((x) => findSection(x)?.desk);
      assert.ok(desks.includes("ai"), `${id} is not an ai-desk story`);
    }
  });

  it("a story sits on two homepages only where the second section had nothing else to show", () => {
    const onHome = new Map<SectionId, Set<ArticleId>>(pl.sections.map((s) => [s.id, new Set(s.rows.slice(0, s.homeCount))]));
    let repeats = 0;
    for (const s of pl.sections) {
      const def = sectionById(s.id);
      const isRepeat = (id: ArticleId): boolean => pl.primary[id] !== s.id && (onHome.get(pl.primary[id])?.has(id) ?? false);
      const home = s.rows.slice(0, s.homeCount);
      const shown = home.filter(isRepeat);
      if (shown.length === 0) continue;
      repeats += shown.length;
      // Every row below the cut is itself a repeat, or would break the publisher / source cap.
      const cap = capAt(def.homeRows, def.maxPublisherShare, def.homeRows);
      const count = (key: "publisher" | "sourceId", v: string): number => home.filter((id) => !isRepeat(id) && pl.stories[id].items[0][key] === v).length;
      for (const id of s.rows.slice(s.homeCount)) {
        const lead = pl.stories[id].items[0];
        // ... or is a low-signal row of a topic section (weight 0 / forum thread: last resort, after repeats).
        const lowSignal = def.mode === "topic" && isLowSignal(pl.stories[id]);
        assert.ok(isRepeat(id) || lowSignal || count("publisher", lead.publisher) >= cap || count("sourceId", lead.sourceId) >= cap, `${s.id}: ${id} could have replaced a repeat`);
      }
    }
    const slots = pl.sections.reduce((n, s) => n + s.homeCount, 0);
    assert.ok(repeats / slots < 0.24, `${repeats} of ${slots} homepage slots repeat a story (V1: 24%)`);
  });

  it("logs one summary line and nothing else", () => {
    assert.equal(ctx.logs.length, 1);
    assert.match(ctx.logs[0].msg, /^route: \d+ stories -> \d+ placed in \d+ rows; top \d+/);
  });
});

describe("route - determinism", () => {
  it("same input, same frozen clock -> identical output", () => {
    const stories = corpus();
    const a = route(stories, createTestContext());
    const b = route(stories, createTestContext());
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a.sections), JSON.stringify(b.sections));
  });

  it("does not depend on the order of the input", () => {
    const stories = corpus();
    const shuffled = [...stories].sort((x, y) => (x.lead < y.lead ? -1 : 1));
    const reversed = [...stories].reverse();
    const base = route(stories, createTestContext());
    for (const other of [shuffled, reversed]) {
      const got = route(other, createTestContext());
      assert.deepEqual(got.sections, base.sections);
      assert.deepEqual(got.top, base.top);
      assert.deepEqual(got.primary, base.primary);
    }
  });

  it("does not mutate its input or the state", () => {
    const stories = corpus();
    const before = JSON.stringify(stories);
    const state = { ...createTestContext().state, lead: { id: stories[0].lead, since: hoursAgo(2) } };
    const stateBefore = JSON.stringify(state);
    route(Object.freeze(stories) as ScoredStory[], createTestContext({ state: Object.freeze(state) }));
    assert.equal(JSON.stringify(stories), before);
    assert.equal(JSON.stringify(state), stateBefore);
  });

  it("the only clock is ctx.now", () => {
    const stories = [story("Fresh industry story", { hours: 1 }), story("Second industry story", { hours: 2 })];
    const now = route(stories, createTestContext());
    assert.equal(now.sections.find((s) => s.id === "industry")?.rows.length, 2);
    const later = route(stories, createTestContext({ now: new Date(Date.parse(FIXTURE_NOW_ISO) + 5 * 86_400_000) }));
    assert.equal(later.sections.find((s) => s.id === "industry")?.rows.length, 0);
    assert.equal(later.trace?.[stories[0].lead].cut?.industry, "window");
  });
});

describe("route - behaviour", () => {
  const rows = (pl: Placements, id: SectionId): ArticleId[] => pl.sections.find((s) => s.id === id)?.rows ?? [];

  it("places a press story in industry and its topic section", () => {
    const s = story("LangChain Raises $300M Series C at $3B Valuation");
    const pl = route([s], createTestContext());
    assert.deepEqual(rows(pl, "industry"), [s.lead]);
    assert.deepEqual(rows(pl, "money"), [s.lead]);
    assert.equal(pl.primary[s.lead], "money");
    assert.equal(pl.trace?.[s.lead].routedTo, "money");
    assert.match(pl.trace?.[s.lead].rule ?? "", /^money\/deals: title\[/);
    // It matched tools as well ("langchain") - one routed section only.
    assert.equal(pl.trace?.[s.lead].cut?.tools, "limit");
    assert.deepEqual(rows(pl, "tools"), []);
  });

  it("moves an AI-titled cyber story to AI SECURITY and makes it eligible for TOP STORIES", () => {
    const ec = story("European Commission confirms cyberattack, says hackers used AI tool", { pubs: 2, lead: { home: "cyber", scope: "general" } });
    const drupal = story("Drupal patches critical RCE flaw", { pubs: 3, lead: { home: "cyber", scope: "general" } });
    const pl = route([ec, drupal], createTestContext());
    assert.deepEqual(rows(pl, "ai_security"), [ec.lead]);
    assert.deepEqual(rows(pl, "cyber"), [drupal.lead]);
    assert.equal(pl.trace?.[ec.lead].cut?.cyber, "moved");
    assert.deepEqual(pl.top, [ec.lead], "the cyber wire itself never feeds TOP STORIES");
    assert.equal(pl.primary[ec.lead], "ai_security");
  });

  it("moves a cyber story with a bare AI term and a policy title to POLICY; it stays TOP-eligible and is traced", () => {
    const caucus = story("Lawmakers launch new AI safety caucus amid rising security concerns", { pubs: 2, lead: { home: "cyber", scope: "general", routeTo: ["ai_security", "policy"] } });
    const pl = route([caucus], createTestContext());
    assert.deepEqual(rows(pl, "policy"), [caucus.lead]);
    assert.deepEqual(rows(pl, "ai_security"), []);
    assert.deepEqual(rows(pl, "cyber"), []);
    assert.equal(pl.primary[caucus.lead], "policy");
    assert.equal(pl.trace?.[caucus.lead].routedTo, "policy");
    assert.equal(pl.trace?.[caucus.lead].cut?.cyber, "moved");
    assert.match(pl.trace?.[caucus.lead].rule ?? "", /^moved from cyber: policy\/ai-regulation: /);
    assert.deepEqual(pl.top, [caucus.lead], "policy is an ai desk");
  });

  it("ranks TOP STORIES by score and caps one big story's subject on a section's homepage rows", () => {
    // Members share the company name and nothing else, so the subject is "anthropic".
    seq += 1;
    const ipo = makeScoredStory(
      Array.from({ length: 8 }, (_, i) => makeNormalized({ title: `Anthropic word${i}a word${i}b`, publisher: `ipo-${i}`, sourceId: `ipo-${i}`, home: "money", publishedAt: hoursAgo(30) })),
      { score: 140 },
    );
    const angles = Array.from({ length: 6 }, (_, i) => story(`Anthropic angle piece ${i}`, { score: 90 - i, lead: { home: "money" } }));
    const others = Array.from({ length: 10 }, (_, i) => story(`Another markets item ${i}`, { score: 60 - i, lead: { home: "money" } }));
    const stale = story("An older three-outlet story", { pubs: 3, hours: 50, score: 50 });
    const fresh = story("A fresh two-outlet story", { pubs: 2, hours: 1, score: 95 });
    const pl = route([ipo, ...angles, ...others, stale, fresh], createTestContext());
    assert.deepEqual(pl.top, [ipo.lead, fresh.lead, stale.lead]);
    const money = pl.sections.find((s) => s.id === "money");
    assert.ok(money);
    const home = money.rows.slice(0, money.homeCount);
    assert.equal(home.filter((id) => /anthropic/i.test(pl.stories[id].items[0].title)).length, 2, "the IPO story and one angle piece");
    assert.equal(home[0], ipo.lead);
    assert.equal(money.rows.length, 17, "nothing leaves the section: deferred rows are below the homepage cut");
    assert.ok(angles.slice(1).every((a) => money.rows.indexOf(a.lead) >= money.homeCount));
  });

  it("the lead is never a release or a community item, even when it scores highest", () => {
    const release = story("llama.cpp b12549 released", { score: 999, lead: { home: "releases", kind: "github-release", flags: ["release"], leadEligible: false, countsForCoverage: false } });
    const reddit = story("Local AI megathread", { score: 998, lead: { home: "open_local", kind: "community", flags: ["discussion"], routing: "home-only", leadEligible: false, countsForCoverage: false } });
    const press = story("Anthropic begins public trading", { score: 5 });
    const pl = route([release, reddit, press], createTestContext());
    assert.equal(pl.leadId, press.lead);
    assert.deepEqual(pl.top, [press.lead]);
  });

  it("keeps the previous lead from state (stability rule) and follows ctx.state only", () => {
    const a = story("Anthropic Makes Trading Debut With Record Breaking IPO", { pubs: 6, hours: 2 });
    const b = story("Introducing Gemini 4 Neon", { pubs: 5, hours: 3, lead: { home: "models" } });
    assert.equal(route([a, b], createTestContext()).leadId, a.lead);
    const state = { ...createTestContext().state, lead: { id: b.lead, since: hoursAgo(5) } };
    const held = route([a, b], createTestContext({ state }));
    assert.equal(held.leadId, b.lead);
    assert.deepEqual(held.top, [b.lead, a.lead]);
    const stale = { ...state, lead: { id: b.lead, since: hoursAgo(30) } };
    assert.equal(route([a, b], createTestContext({ state: stale })).leadId, a.lead);
  });

  it("folds a running story's follow-ups and holds an incumbent from ctx.state.top; both are reported and optional", () => {
    const ipoTitles = ["Anthropic raises $81bn in record IPO", "Anthropic prices IPO at $83 a share", "Anthropic shares start trading after record IPO", "Anthropic IPO: first day of trading", "Anthropic closes first trading day up 17% after IPO", "Anthropic record IPO values it at $2tn"];
    const items = (titles: string[], hours: number): NormalizedItem[] => titles.map((title, i) => makeNormalized({ title, publisher: `run-${seq}-${title.length}-${i}`, sourceId: `run-src-${seq}-${title.length}-${i}`, publishedAt: hoursAgo(hours + i * 0.1), home: "money" }));
    const ipo = makeScoredStory(items(ipoTitles, 30), { score: 140 });
    const followUp = makeScoredStory(items(["Anthropic shares jump 17% after record Wall Street listing", "Anthropic starts trading on Wall Street"], 5), { score: 98 });
    const other = story("Introducing Gemini 4 Neon", { pubs: 3, score: 110, lead: { home: "models" } });
    const plain = route([ipo, followUp, other], createTestContext());
    assert.deepEqual(plain.top, [ipo.lead, other.lead]);
    assert.deepEqual(plain.topRelated, { [ipo.lead]: [followUp.lead] });
    assert.equal(plain.topHeld, undefined);
    assert.ok(rows(plain, "money").includes(followUp.lead), "a folded follow-up keeps its section row");

    // A story that was in TOP last build and is down to one publisher today.
    const lapsed = story("California attorney general opens probe into Nvidia", { pubs: 1, score: 70, lead: { home: "policy" } });
    const state = { ...createTestContext().state, top: [{ id: lapsed.lead, score: 93.5 }] };
    const ctx = createTestContext({ state });
    const held = route([ipo, other, lapsed], ctx);
    assert.deepEqual(held.top, [ipo.lead, other.lead, lapsed.lead]);
    assert.deepEqual(held.topHeld, { [lapsed.lead]: { since: ctx.now.toISOString(), score: 93.5 } });
    assert.equal(held.topRelated, undefined);
    assert.equal(held.leadId, held.top[0]);
    assert.ok(ctx.logs[0].msg.includes("1 held"));
    assert.deepEqual(route([ipo, other, lapsed], createTestContext()).top, [ipo.lead, other.lead], "without the memory it is not a TOP story");
  });

  it("no stories -> 15 empty sections, no top, no lead", () => {
    const pl = route([], createTestContext());
    assert.equal(pl.sections.length, 15);
    assert.ok(pl.sections.every((s) => s.rows.length === 0 && s.homeCount === 0));
    assert.deepEqual([pl.top, pl.leadId, pl.stories, pl.primary], [[], null, {}, {}]);
  });

  it("an unplaced story still has a primary section (river rows need one)", () => {
    const old = story("LangChain Raises $300M Series C at $3B Valuation", { hours: 24 * 30 });
    const pl = route([old], createTestContext());
    assert.deepEqual(rows(pl, "industry"), []);
    assert.equal(pl.primary[old.lead], "money");
    assert.deepEqual(pl.trace?.[old.lead].cut, { industry: "window", money: "window", tools: "limit" });
    assert.ok(pl.stories[old.lead]);
  });

  it("ignores a duplicate lead id and warns", () => {
    const s = story("Notes on a quiet week");
    const ctx = createTestContext();
    const pl = route([s, { ...s }], ctx);
    assert.deepEqual(rows(pl, "industry"), [s.lead]);
    assert.ok(ctx.logs.some((l) => l.level === "warn" && l.msg.includes("duplicate")));
  });
});
