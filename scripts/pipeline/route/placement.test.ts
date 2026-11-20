import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, findSection, type SectionId } from "../../../shared/sections";
import { makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import type { NormalizedItem, ScoredStory } from "../types";
import { placeStory, primarySection, type StoryPlacement } from "./placement";

function story(title: string, item: Partial<NormalizedItem> = {}): ScoredStory {
  return makeScoredStory([makeNormalized({ title, ...item })]);
}
const cyber: Partial<NormalizedItem> = { home: "cyber", scope: "general", publisher: "the-record", sourceId: "the-record" };

describe("placeStory - home plus at most one routed section", () => {
  it("a story without a rule match stays in its home section", () => {
    const p = placeStory(story("Who are Anthropic's seven co-founders?"));
    assert.deepEqual(p.sections, ["industry"]);
    assert.equal(p.routedTo, null);
    assert.equal(p.rule, undefined);
  });

  it("routes to the ONE best-scoring section and reports the runners-up as blocked", () => {
    const p = placeStory(story("Prompt injection flaw lets attackers hijack Copilot agents after $2B funding round"));
    assert.deepEqual(p.sections, ["industry", "ai_security"]);
    assert.equal(p.routedTo, "ai_security");
    assert.ok(p.rule?.startsWith("ai_security/"));
    assert.ok(p.blocked.includes("tools") && p.blocked.includes("money"));
    assert.equal(p.moved, false);
    assert.equal(p.byTitle, true);
  });

  it("never routes into a source-mode section and never lists home twice", () => {
    const titles = [
      "LangChain Raises $300M Series C at $3B Valuation",
      "Quantum computing breakthrough: IBM links two chips for a 1,040-qubit system",
      "New research paper benchmarks reasoning; an analysis and deep dive",
      "ollama v0.40.17 released on GitHub",
      "Ransomware breach: zero-day exploit hits AI startup",
    ];
    for (const home of SECTIONS.map((s) => s.id)) {
      for (const t of titles) {
        const p = placeStory(story(t, { home }));
        assert.ok(p.sections.length <= 2, `${home}: ${t}`);
        assert.equal(new Set(p.sections).size, p.sections.length);
        if (p.routedTo) {
          assert.equal(findSection(p.routedTo)?.mode, "topic");
          assert.notEqual(p.routedTo, p.home);
        }
        for (const s of p.sections) if (findSection(s)?.mode === "source") assert.equal(s, home);
      }
    }
  });

  it("a home-only source never routes out", () => {
    const p = placeStory(story("Prompt injection in Copilot agents", { routing: "home-only", kind: "community", home: "open_local" }));
    assert.deepEqual(p.sections, ["open_local"]);
    assert.equal(p.routedTo, null);
    assert.ok(p.blocked.includes("ai_security"));
  });

  it("respects the routeTo allowlist (next best allowed section; [] = none)", () => {
    const title = "Prompt injection flaw found in agent startup days after its Series B";
    assert.equal(placeStory(story(title)).routedTo, "ai_security");
    assert.equal(placeStory(story(title, { routeTo: ["money"] })).routedTo, "money");
    assert.equal(placeStory(story(title, { routeTo: [] })).routedTo, null);
    assert.equal(placeStory(story(title, { routeTo: ["robotics"] })).routedTo, null);
  });

  it("a second section must beat the home section's own title evidence", () => {
    const p = placeStory(story("When 'Auto-Signing' Sends Your Wallet: A Malicious MCP Server on npm", { home: "ai_security" }));
    assert.deepEqual(p.sections, ["ai_security"]);
    assert.ok(p.blocked.includes("tools"));
    // A deal announced on a tools / robotics feed is also a money story...
    assert.equal(placeStory(story("LangChain Raises $300M Series C at $3B Valuation", { home: "tools" })).routedTo, "money");
    const humyn = story("Humyn Labs raises $47M to collect real-world data for robotics", { home: "robotics", summary: "Humanoid robots need data. The robotics startup builds robot teleoperation rigs." });
    assert.equal(placeStory(humyn).routedTo, "money");
    // ...and a story the home rule does not match at all is routed on any evidence.
    assert.equal(placeStory(story("Inside the Codex sandbox", { home: "models" })).routedTo, "tools");
    // Equal evidence is not enough.
    assert.equal(placeStory(story("GlobalFoundries Becomes First Chipmaker to Test Boston Dynamics' Atlas", { home: "robotics" })).routedTo, null);
  });

  it("a release is routed by its title only, and only into sections that accept releases", () => {
    const rel: Partial<NormalizedItem> = { home: "releases", kind: "github-release", flags: ["release"], leadEligible: false, countsForCoverage: false };
    assert.deepEqual(placeStory(story("ollama v0.40.17 released", { ...rel, summary: "humanoid robot GPU data center funding round valuation" })).sections, ["releases", "open_local"]);
    assert.deepEqual(placeStory(story("transformers v5.23.0 released", rel)).sections, ["releases"]);
    assert.deepEqual(placeStory(story("ollama v0.40.17 released", { ...rel, routeTo: [] })).sections, ["releases"]);
  });
});

describe("placeStory - AI-titled cyber stories move to AI SECURITY", () => {
  it("moves (does not copy) an AI-titled cyber story", () => {
    const p = placeStory(story("European Commission confirms cyberattack, says hackers used AI tool", cyber));
    assert.deepEqual(p.sections, ["ai_security"]);
    assert.equal(p.routedTo, "ai_security");
    assert.equal(p.moved, true);
    assert.match(p.rule ?? "", /^moved from cyber: /);
  });

  it("moves on an AI term alone, even without a security term", () => {
    const p = placeStory(story("Microsoft Copilot gets a new admin dashboard", cyber));
    assert.equal(p.moved, true);
    assert.equal(p.rule, "moved from cyber: AI term in title[copilot]");
  });

  it("a bare AI term yields to a POLICY title match: the story moves there instead (and only there)", () => {
    // Live 2026-11-20: AI SECURITY #1, while POLICY carried only the Techmeme copy at #8.
    const caucus = placeStory(story("Lawmakers launch new AI safety caucus amid rising security concerns", { ...cyber, routeTo: ["ai_security", "policy"] }));
    assert.deepEqual(caucus.sections, ["policy"]);
    assert.equal(caucus.routedTo, "policy");
    assert.equal(caucus.moved, true);
    assert.equal(caucus.byTitle, true);
    assert.match(caucus.rule ?? "", /^moved from cyber: policy\/ai-regulation: title\[lawmakers, caucus\]/);
    assert.ok(!caucus.blocked.includes("policy"));
    assert.deepEqual(placeStory(story("Srsly Risky Biz: Phew! Some Regulatory Relief for AI Hacks", cyber)).sections, ["policy"]);
    // An AI-security title hit always wins the move, whatever else matches.
    const attack = placeStory(story("Senate hearing told prompt injection attacks on AI agents are rising", cyber));
    assert.deepEqual(attack.sections, ["ai_security"]);
    assert.ok(attack.blocked.includes("policy"));
    // Not "any other section": a tools or open_local title hit does not pull an AI-titled cyber story away.
    assert.deepEqual(placeStory(story("The risks of device code authentication for AI coding agents", cyber)).sections, ["ai_security"]);
    assert.deepEqual(placeStory(story("Qwen Incidents Show Self-Hosted AI Models Need Stronger Steering", cyber)).sections, ["ai_security"]);
    assert.deepEqual(placeStory(story("Microsoft Copilot gets a new admin dashboard", cyber)).sections, ["ai_security"]);
    // A policy term in the SUMMARY only is not a title match: the move to AI SECURITY stands.
    const summaryOnly = placeStory(story("AI tools are reshaping incident response", { ...cyber, summary: "Lawmakers and regulators are watching closely." }));
    assert.deepEqual(summaryOnly.sections, ["ai_security"]);
    // The source's allowlist still applies to the alternative.
    assert.deepEqual(placeStory(story("Lawmakers launch new AI safety caucus amid rising security concerns", { ...cyber, routeTo: ["ai_security"] })).sections, ["ai_security"]);
  });

  it("leaves ordinary cyber stories in the cyber wire", () => {
    for (const t of ["Drupal patches critical RCE flaw, warns exploits may surface quickly", "Transport for London breach exposes 265,000 Oyster card users' data", "Agent Tesla malware returns with new loader"]) {
      const p = placeStory(story(t, cyber));
      assert.deepEqual(p.sections, ["cyber"], t);
      assert.equal(p.moved, false);
    }
  });

  it("an AI-security summary on a non-AI title is a second section, not a move", () => {
    const p = placeStory(story("Trained to betray: how post-training supply chain attacks hijack coding agents", { ...cyber, summary: "Our AI red team shows how poisoned models survive fine-tuning." }));
    assert.deepEqual(p.sections, ["cyber", "ai_security"]);
    assert.equal(p.moved, false);
  });

  it("source policy still applies: home-only and allowlists keep the story in cyber", () => {
    const title = "Attackers Use Autonomous AI to Target Semiconductor Sector";
    assert.deepEqual(placeStory(story(title, { ...cyber, routing: "home-only" })).sections, ["cyber"]);
    assert.deepEqual(placeStory(story(title, { ...cyber, routeTo: ["policy"] })).sections, ["cyber"]);
    assert.deepEqual(placeStory(story(title, { ...cyber, routeTo: ["ai_security"] })).sections, ["ai_security"]);
  });

  it("finance-regulator news from the cyber wire is also listed under policy", () => {
    const p = placeStory(story("SEC charges four firms over misleading breach disclosures", cyber));
    assert.deepEqual(p.sections, ["cyber", "policy"]);
  });
});

describe("primarySection", () => {
  const p = (over: Partial<StoryPlacement>): StoryPlacement => ({ home: "industry", routedTo: null, moved: false, byTitle: false, sections: ["industry"], matches: [], blocked: [], ...over });
  const set = (...ids: SectionId[]): Set<SectionId> => new Set(ids);

  it("general desk: the routed section is primary", () => {
    assert.equal(primarySection(p({ routedTo: "money" }), set("industry", "money")), "money");
  });
  it("specialist source desks keep their stories", () => {
    for (const home of ["research", "safety", "analysis", "releases", "cyber", "quantum"] as const) {
      assert.equal(primarySection(p({ home, routedTo: "tools", byTitle: true }), set(home, "tools")), home);
    }
  });
  it("topic home: only a MORE specific section with a title hit takes the story", () => {
    assert.equal(primarySection(p({ home: "tools", routedTo: "money", byTitle: true }), set("tools", "money")), "money");
    assert.equal(primarySection(p({ home: "tools", routedTo: "money", byTitle: false }), set("tools", "money")), "tools");
    assert.equal(primarySection(p({ home: "ai_security", routedTo: "tools", byTitle: true }), set("ai_security", "tools")), "ai_security");
    assert.equal(primarySection(p({ home: "models", routedTo: "open_local", byTitle: true }), set("models", "open_local")), "models");
  });
  it("placed in one section only: that section; placed nowhere: routed, else home", () => {
    assert.equal(primarySection(p({ routedTo: "money" }), set("industry")), "industry");
    assert.equal(primarySection(p({ home: "research", routedTo: "compute" }), set("compute")), "compute");
    assert.equal(primarySection(p({ routedTo: "money" }), set()), "money");
    assert.equal(primarySection(p({}), set()), "industry");
    assert.equal(primarySection(p({ home: "cyber", routedTo: "ai_security", moved: true }), set("ai_security")), "ai_security");
  });
});
