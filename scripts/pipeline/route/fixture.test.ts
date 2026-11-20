// Integration tests of the route stage on two real editions, re-routed by this stage (WP3/WP4 are
// not needed: testing/fromEdition.ts rebuilds ScoredStory inputs from an edition).
//
//  1. The BRIDGED 2026-11-19 edition (test/fixtures/bridged-2026-11-19, with the registry of the
//     same day): the 237 stories of that front page. The per-section defects asserted here are the
//     ones the editorial review found on that very page (review/output-editorial.extras.md §A), so
//     these tests pin its headlines ON PURPOSE - the data set is frozen and never refreshed.
//  2. The LIVE fixture (test/fixtures/v2, replaced by `npm run fixture:refresh`) with the current
//     registry: only properties that hold for any edition are asserted, nothing is pinned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleId, ArticleV2, ClusterV2 } from "../../../shared/contract";
import { SECTIONS, findSection, sectionById, type SectionId } from "../../../shared/sections";
import { hoursAgo, makeEdition } from "../../../test/helpers/factories";
import { FIXTURE_GENERATED_MS, fixtureEdition, fixtureStory } from "../../../test/helpers/fixtureData";
import { loadBridgedEdition, loadFixtureRegistry } from "../../../test/helpers/fixtures";
import { assertValidBundle } from "../../../test/helpers/invariants";
import { REGISTRY } from "../../registry/index";
import { createTestContext, topStanding } from "../context";
import type { NormalizedItem, Placements, ScoredStory } from "../types";
import { isRegulatorNotice, regulatorFloorRows } from "./homepage";
import { ROUTE_POLICY, route } from "./index";
import { storiesFromEdition } from "./testing/fromEdition";

const ctx = createTestContext();
const stories = storiesFromEdition(loadBridgedEdition(), loadFixtureRegistry(), { nowMs: ctx.now.getTime() });
const pl = route(stories, ctx);

const rows = (id: SectionId, p: Placements = pl): ArticleId[] => p.sections.find((s) => s.id === id)?.rows ?? [];
const homeRows = (id: SectionId): ArticleId[] => {
  const s = pl.sections.find((x) => x.id === id);
  return s ? s.rows.slice(0, s.homeCount) : [];
};
function find(titleStart: string): ScoredStory {
  const s = stories.find((x) => x.items[0].title.startsWith(titleStart));
  assert.ok(s, `fixture story not found: ${titleStart}`);
  return s;
}
const sectionsOf = (titleStart: string): SectionId[] => {
  const id = find(titleStart).lead;
  return pl.sections.filter((s) => s.rows.includes(id)).map((s) => s.id);
};

function toArticle(i: NormalizedItem, w: ArticleV2["w"]): ArticleV2 {
  return {
    id: i.id,
    url: i.url,
    title: i.title,
    src: i.sourceId,
    publishedAt: i.publishedAt,
    firstSeenAt: i.firstSeenAt,
    home: i.home,
    tier: i.tier,
    ...(w !== undefined && w !== 1 ? { w } : {}),
    ...(i.flags.length ? { flags: i.flags } : {}),
  };
}

describe("route on the bridged fixture edition", () => {
  it("the helper rebuilds every fixture story", () => {
    assert.equal(stories.length, 237);
    assert.ok(stories.every((s) => s.items[0].id === s.lead && s.items.length === s.members.length + 1));
    assert.ok(stories.some((s) => s.publishers.length >= 5), "the Anthropic IPO cluster must survive the round trip");
  });

  it("produces placements that satisfy the data contract once projected to front.json / rest.json", () => {
    const articles: ArticleV2[] = [];
    const clusters: Record<ArticleId, ClusterV2> = {};
    const used = new Set<ArticleId>([...pl.top, ...pl.sections.flatMap((s) => s.rows)]);
    for (const id of used) {
      const s = pl.stories[id];
      s.items.forEach((item, idx) => articles.push(toArticle(item, idx === 0 ? s.w : undefined)));
      if (s.members.length) clusters[id] = { members: s.members, publishers: Math.max(1, s.publishers.length) };
    }
    const built = makeEdition({
      articles,
      rows: Object.fromEntries(pl.sections.map((s) => [s.id, s.rows])),
      homeRows: Object.fromEntries(pl.sections.map((s) => [s.id, s.homeCount])),
      clusters,
      top: pl.top,
    });
    assertValidBundle({ front: built.front, rest: built.rest }, "route(fixture)");
  });

  it("fills every section; reports fill counts and duplication", (t) => {
    const placed = new Map<ArticleId, number>();
    for (const s of pl.sections) for (const id of s.rows) placed.set(id, (placed.get(id) ?? 0) + 1);
    const inTwo = [...placed.values()].filter((n) => n === 2).length;
    const totalRows = pl.sections.reduce((n, s) => n + s.rows.length, 0);
    const home = new Map<ArticleId, number>();
    for (const s of pl.sections) for (const id of s.rows.slice(0, s.homeCount)) home.set(id, (home.get(id) ?? 0) + 1);
    const homeSlots = pl.sections.reduce((n, s) => n + s.homeCount, 0);
    const homeRepeats = homeSlots - home.size;

    t.diagnostic(`stories in: ${stories.length}; placed: ${placed.size}; rows: ${totalRows}`);
    t.diagnostic(`fill (rows / homepage rows / homeRows / minItems): ${pl.sections.map((s) => `${s.id} ${s.rows.length}/${s.homeCount}/${sectionById(s.id).homeRows}/${sectionById(s.id).window.minItems}`).join(", ")}`);
    t.diagnostic(`stories in two sections: ${inTwo} of ${placed.size} (${((100 * inTwo) / placed.size).toFixed(1)}%); in more than two: ${[...placed.values()].filter((n) => n > 2).length}`);
    t.diagnostic(`repeated rows, all lists: ${totalRows - placed.size} of ${totalRows} (${((100 * (totalRows - placed.size)) / totalRows).toFixed(1)}%)`);
    t.diagnostic(`repeated HOMEPAGE slots: ${homeRepeats} of ${homeSlots} (${((100 * homeRepeats) / homeSlots).toFixed(1)}%; V1: 45 of 185 = 24%)`);
    t.diagnostic(`top stories: ${pl.top.length}; lead: ${pl.leadId ? pl.stories[pl.leadId].items[0].title : "none"}`);

    for (const s of pl.sections) assert.ok(s.rows.length >= sectionById(s.id).window.minItems, `${s.id} has ${s.rows.length} rows`);
    assert.equal(Math.max(...placed.values()), 2);
    assert.ok(inTwo / placed.size < 0.35, "too many stories in two sections");
    assert.ok(homeRepeats / homeSlots < 0.05, `${homeRepeats} repeated homepage slots`);
  });

  it("a story is in its home section plus at most one routed section; source-mode sections hold home stories only", () => {
    for (const s of pl.sections) {
      for (const id of s.rows) {
        const home = pl.stories[id].items[0].home;
        if (sectionById(s.id).mode === "source") assert.equal(home, s.id);
      }
    }
    for (const st of stories) {
      const secs = pl.sections.filter((s) => s.rows.includes(st.lead)).map((s) => s.id);
      assert.ok(secs.length <= 2 && secs.filter((x) => x !== st.items[0].home).length <= 1, `${st.items[0].title}: ${secs.join(",")}`);
    }
  });

  it("respects each section's publisher share on the homepage", () => {
    for (const s of pl.sections) {
      const def = sectionById(s.id);
      const cap = Math.ceil(def.maxPublisherShare * def.homeRows - 1e-9);
      const counts = new Map<string, number>();
      for (const id of s.rows.slice(0, s.homeCount)) {
        const p = pl.stories[id].items[0].publisher;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      // A section thinner than its homepage may relax the cap to reach minItems, never beyond.
      if (worst && s.rows.length > def.window.minItems) assert.ok(worst[1] <= cap, `${s.id}: ${worst[0]} holds ${worst[1]} of ${s.homeCount} homepage rows (cap ${cap})`);
    }
  });

  it("TOP STORIES: multi-publisher ai-desk stories, the IPO leads, no release or thread", () => {
    assert.ok(pl.top.length >= 4 && pl.top.length <= 12);
    assert.equal(pl.leadId, pl.top[0]);
    assert.match(pl.stories[pl.top[0]].items[0].title, /Anthropic/);
    let prev = Infinity;
    for (const id of pl.top) {
      const s = pl.stories[id];
      assert.ok(s.publishers.length >= 2);
      assert.ok(topStanding(s) <= prev, "ranked by score (coverage is part of it; a two-publisher story's recency is capped)");
      prev = topStanding(s);
      assert.equal(findSection(s.items[0].home)?.desk === "ai" || rows("ai_security").includes(id), true);
      assert.ok(!s.items[0].flags.includes("release") && !s.items[0].flags.includes("discussion"));
    }
    // V1's Trending that hour: a llama.cpp + llama_index "cluster" at #2 and OpenAI twin feeds.
    assert.ok(!pl.top.some((id) => /released$/.test(pl.stories[id].items[0].title)));
  });

  it("the lead holds across builds (stability rule) and is released when the story is old", () => {
    const [first, second] = pl.top.map((id) => pl.stories[id]);
    const old = find("Introducing GPT-6.2 Astra and Sol");
    assert.ok(second.ageHours < 24 && old.ageHours >= 24 && pl.top.includes(old.lead), "fixture: Gemini 4 Neon is 23 h old, GPT-6.2 is 51 h old");
    const withLead = (id: ArticleId, since = 5): Placements => route(stories, createTestContext({ state: { ...ctx.state, lead: { id, since: hoursAgo(since) } } }));
    assert.equal(withLead(second.lead).leadId, second.lead);
    assert.equal(withLead(second.lead, 25).leadId, first.lead, "a tenure of a day ends the hold");
    assert.equal(withLead(old.lead).leadId, first.lead, "an old story does not keep the slot");
    assert.equal(withLead(first.lead).leadId, first.lead);
  });

  it("is deterministic on the fixture", () => {
    assert.deepEqual(route([...stories].reverse(), createTestContext()), pl);
  });
});

describe("the 2026-11-19 front page defects (editorial review §A)", () => {
  it("MODELS: no release tag, no IPO story routed in", () => {
    assert.ok(!sectionsOf("llama.cpp b12549 released").includes("models"));
    for (const id of rows("models")) {
      const lead = pl.stories[id].items[0];
      if (lead.home !== "models") assert.doesNotMatch(lead.title, /\bIPO\b|released$/);
    }
    assert.ok(homeRows("models").includes(find("Introducing Gemini 4 Neon").lead));
    assert.ok(homeRows("models").includes(find("Introducing GPT-6.2 Astra and Sol").lead));
  });

  it("CYBER: no Amazon Bedrock rows ('edr'), no langgraph ('dispatched')", () => {
    for (const id of rows("cyber")) assert.equal(pl.stories[id].items[0].home, "cyber");
    assert.deepEqual(sectionsOf("Amazon Bedrock AgentCore harness"), ["tools"]);
    assert.deepEqual(sectionsOf("Optimize AI economics on Amazon Bedrock"), ["tools"]);
  });

  it("COMPUTE: the arXiv RFBench paper ('tpu' in 'outputs') stays in research", () => {
    assert.ok(!sectionsOf("RFBench:").includes("compute"));
    assert.equal(pl.trace?.[find("RFBench:").lead].routedTo, null);
  });

  it("ROBOTICS: no gemini-cli release ('@gemini-cli-robot'), no AI Hype Index (summary mention)", () => {
    assert.ok(!sectionsOf("gemini-cli v0.70.0-preview.0 released").includes("robotics"));
    assert.deepEqual(sectionsOf("The AI Hype Index"), ["industry"]);
  });

  it("QUANTUM: CoreWeave ('Quantum-2 InfiniBand') is not there", () => {
    assert.deepEqual(sectionsOf("CoreWeave Data Center Operations"), ["compute"]);
  });

  it("TOOLS / PRODUCTS: 'launches the largest IPO' is a money story", () => {
    const s = sectionsOf("Anthropic's $81.3 billion IPO shatters SpaceX's record");
    assert.ok(s.includes("money") && !s.includes("tools"));
  });

  it("the Rust talk and the tl;dr sec digest are listed once (V1: three sections each)", () => {
    assert.ok(sectionsOf("Presentation: RIIIR").every((s) => s === "tools"));
    assert.equal(pl.trace?.[find("Presentation: RIIIR").lead].routedTo, null);
    assert.deepEqual(sectionsOf("[tl;dr sec] #355"), ["ai_security"]);
  });

  it("AI SECURITY gets the EU Commission AI-tool attack; the cyber wire does not repeat it", () => {
    assert.deepEqual(sectionsOf("European Commission confirms cyberattack, says hackers used AI tool"), ["ai_security"]);
    assert.ok(rows("ai_security").length >= 14, "V1 had 14 items from 6 sources");
    const moved = rows("ai_security").filter((id) => pl.stories[id].items[0].home === "cyber");
    assert.ok(moved.length >= 4, `only ${moved.length} AI-titled cyber stories reached AI SECURITY`);
    for (const id of moved) assert.ok(!rows("cyber").includes(id));
  });

  it("MONEY shows the deals that V1 left in other sections", () => {
    for (const t of ["Genesis AI Raises $500M Series A", "Humyn Labs raises $47M", "LangChain Raises $300M Series C"]) {
      assert.equal(pl.trace?.[find(t).lead].routedTo, "money", t);
    }
    for (const t of ["Humyn Labs raises $47M", "LangChain Raises $300M Series C"]) assert.ok(sectionsOf(t).includes("money"), t);
    assert.ok(homeRows("money").includes(find("LangChain Raises $300M Series C").lead));
  });

  it("POLICY gets the House AI caucus and the chip curbs", () => {
    assert.ok(sectionsOf("A bipartisan group of 24+ House lawmakers").includes("policy"));
    assert.ok(sectionsOf("TSMC tightens China AI chip curbs").includes("policy"));
  });

  it("OPEN & LOCAL: release tags sit below the first three rows; a runtime's release keeps a homepage row", () => {
    const open = rows("open_local");
    const releaseRows = open.map((id, i) => ({ i, rel: pl.stories[id].items[0].flags.includes("release") })).filter((r) => r.rel);
    assert.ok(releaseRows.length > 0);
    assert.ok(releaseRows.every((r) => r.i >= 3));
    const llama = find("llama.cpp b12549 released").lead;
    assert.ok(rows("releases").includes(llama));
    // Decided in the final fix round: RELEASE RADAR is a reference list, and for this reader a
    // llama.cpp release is LOCAL news - it is on both homepage lists (ROUTE_POLICY.releaseRows),
    // and that stays a small share of the page.
    assert.ok(homeRows("open_local").includes(llama), "a local runtime's release is on the LOCAL homepage");
    assert.ok(homeRows("open_local").filter((id) => pl.stories[id].items[0].flags.includes("release")).length <= ROUTE_POLICY.releaseRows.maxRows);
    assert.match(pl.trace?.[llama]?.focus?.open_local ?? "", /open_local\/runtime \+\d+ title\[llama\.cpp\]/);
    assert.ok(sectionsOf("An updated Clairic and Clairic-flash are now open-weight").includes("open_local"));
    // What the section is about ranks above what only mentions its words (rules.ts SECTION_FOCUS).
    const clairic = find("An updated Clairic and Clairic-flash are now open-weight").lead;
    assert.ok(homeRows("open_local").includes(clairic));
    // A security advisory homed in AI SECURITY is a cross-listing here, never a homepage row.
    for (const id of homeRows("open_local")) assert.notEqual(pl.stories[id].items[0].home, "ai_security", pl.stories[id].items[0].title);
  });

  it("the trace names the rule behind every routed row", () => {
    for (const s of SECTIONS) {
      for (const id of rows(s.id)) {
        const st = pl.stories[id];
        if (st.items[0].home === s.id) continue;
        assert.equal(pl.trace?.[id].routedTo, s.id);
        assert.match(pl.trace?.[id].rule ?? "", new RegExp(`^(moved from cyber: )?(${s.id}/|AI term in title)`));
      }
    }
  });
});

describe("route on the live fixture edition (properties, nothing pinned)", () => {
  const liveCtx = createTestContext({ now: new Date(FIXTURE_GENERATED_MS) });
  const edition = fixtureEdition();
  const live = storiesFromEdition(edition, REGISTRY, { nowMs: FIXTURE_GENERATED_MS });
  const lp = route(live, liveCtx);
  const lrows = (id: SectionId): ArticleId[] => lp.sections.find((s) => s.id === id)?.rows ?? [];
  const lhome = (id: SectionId): ArticleId[] => {
    const s = lp.sections.find((x) => x.id === id);
    return s ? s.rows.slice(0, s.homeCount) : [];
  };
  const leadOf = (id: ArticleId): NormalizedItem => lp.stories[id].items[0];

  it("the helper rebuilds every fixture story, with the registry's policy on every item", () => {
    const keys = new Set<ArticleId>([...edition.top, ...edition.sections.flatMap((s) => s.rows)]);
    assert.equal(live.length, keys.size);
    assert.ok(live.every((s) => s.items[0].id === s.lead && s.items.length === s.members.length + 1));
    const known = new Set(REGISTRY.sources.map((s) => s.id));
    for (const s of live) for (const i of s.items) assert.ok(known.has(i.sourceId), `${i.sourceId} is not in the registry - refresh the fixture after a registry change`);
    const lead = live.find((s) => s.lead === fixtureStory("multiPublisherLead"));
    assert.ok(lead && lead.publishers.length >= 5, "the multi-publisher lead must survive the round trip");
  });

  it("fills every section and keeps a story to its home section plus at most one routed one", (t) => {
    const placed = new Map<ArticleId, number>();
    for (const s of lp.sections) for (const id of s.rows) placed.set(id, (placed.get(id) ?? 0) + 1);
    t.diagnostic(`stories in: ${live.length}; placed: ${placed.size}; rows: ${lp.sections.reduce((n, s) => n + s.rows.length, 0)}; top: ${lp.top.length}`);
    for (const s of lp.sections) {
      assert.ok(s.rows.length >= sectionById(s.id).window.minItems, `${s.id} has ${s.rows.length} rows`);
      if (sectionById(s.id).mode === "source") for (const id of s.rows) assert.equal(leadOf(id).home, s.id);
    }
    for (const st of live) {
      const secs = lp.sections.filter((s) => s.rows.includes(st.lead)).map((s) => s.id);
      assert.ok(secs.length <= 2 && secs.filter((x) => x !== st.items[0].home).length <= 1, `${st.items[0].title}: ${secs.join(",")}`);
    }
  });

  it("TOP STORIES: ai-desk stories ranked by score, the lead first, no release line or thread", () => {
    assert.ok(lp.top.length >= 4 && lp.top.length <= 12);
    assert.equal(lp.leadId, lp.top[0]);
    let prev = Infinity;
    for (const id of lp.top) {
      const s = lp.stories[id];
      assert.ok(topStanding(s) <= prev, "ranked by score (a two-publisher story's recency is capped)");
      prev = topStanding(s);
      assert.ok(!s.items[0].flags.includes("release") && !s.items[0].flags.includes("discussion"), s.items[0].title);
      assert.equal(findSection(s.items[0].home)?.desk === "ai" || lrows("ai_security").includes(id), true, s.items[0].title);
    }
    // The published lead (30 publishers on the day this was written) leads the re-routed edition too.
    assert.equal(lp.leadId, fixtureStory("multiPublisherLead"));
  });

  it("LOCAL & OPEN MODELS: release lines stay below the first three rows and inside the homepage cap", () => {
    const isRelease = (id: ArticleId): boolean => leadOf(id).flags.includes("release");
    assert.ok(lrows("open_local").slice(0, 3).every((id) => !isRelease(id)));
    assert.ok(lhome("open_local").filter(isRelease).length <= ROUTE_POLICY.releaseRows.maxRows);
    // A story homed in AI SECURITY is a cross-listing in any other section, never a homepage row there.
    for (const s of lp.sections) if (s.id !== "ai_security") for (const id of lhome(s.id)) assert.notEqual(leadOf(id).home, "ai_security", `${s.id}: ${leadOf(id).title}`);
  });

  it("POLICY: the regulator floor holds, and no regulator takes more than its share of the homepage", (t) => {
    const def = sectionById("policy");
    const candidates = lrows("policy").map((id) => lp.stories[id]);
    const owed = regulatorFloorRows(def, candidates, liveCtx.now.getTime());
    t.diagnostic(`regulator notices in POLICY: ${candidates.filter((s) => isRegulatorNotice(s.items[0])).length}; owed a homepage row by the floor: ${owed.length}`);
    for (const s of owed) assert.ok(lhome("policy").includes(s.lead), `${s.items[0].title} is owed a POLICY homepage row`);
    const perRegulator = new Map<string, number>();
    for (const id of lhome("policy")) if (isRegulatorNotice(leadOf(id))) perRegulator.set(leadOf(id).publisher, (perRegulator.get(leadOf(id).publisher) ?? 0) + 1);
    for (const [regulator, n] of perRegulator) assert.ok(n <= ROUTE_POLICY.regulatorFloor.perRegulator, `${regulator} holds ${n} POLICY homepage rows`);
    // The fixture has a regulator's own notice in POLICY (test/fixtures.test.ts), so this is not vacuous.
    assert.ok(candidates.some((s) => isRegulatorNotice(s.items[0])));
  });

  it("the trace names the rule behind every routed row, and the result is deterministic", () => {
    for (const s of SECTIONS) {
      for (const id of lrows(s.id)) {
        if (leadOf(id).home === s.id) continue;
        assert.equal(lp.trace?.[id].routedTo, s.id);
        assert.ok((lp.trace?.[id].rule ?? "").length > 0, leadOf(id).title);
      }
    }
    assert.deepEqual(route([...live].reverse(), createTestContext({ now: new Date(FIXTURE_GENERATED_MS) })), lp);
  });
});
