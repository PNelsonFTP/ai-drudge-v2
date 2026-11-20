import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_SECTION_IDS,
  LEGACY_TO_SECTIONS,
  SECTIONS,
  SECTION_IDS,
  findSection,
  isAiDesk,
  isSectionId,
  legacyToSection,
  legacyToSections,
  sectionById,
  sectionOrder,
  sectionsOfDesk,
} from "./sections";

describe("shared/sections", () => {
  it("declares the 15 sections of V2_PLAN §1.1 in homepage order", () => {
    assert.deepEqual(
      SECTIONS.map((s) => s.id),
      ["models", "industry", "ai_security", "open_local", "tools", "policy", "money", "research", "compute", "safety", "cyber", "analysis", "robotics", "quantum", "releases"],
    );
    assert.deepEqual([...SECTION_IDS], SECTIONS.map((s) => s.id));
    assert.equal(new Set(SECTIONS.map((s) => s.label)).size, 15);
    assert.equal(new Set(SECTIONS.map((s) => s.short)).size, 15);
  });

  it("matches the plan table (label, short, desk, mode, window, rows)", () => {
    const row = (id: string) => {
      const s = findSection(id);
      assert.ok(s);
      return [s.label, s.short, s.desk, s.mode, s.window.softDays, s.window.hardDays, s.window.minItems, s.homeRows, s.allRows];
    };
    // MODELS: 5 / 10 days since 2026-11-20 (the plan's 3 / 6 left a 4-day-old flagship release unlisted).
    assert.deepEqual(row("models"), ["MODELS & LABS", "MODELS", "ai", "topic", 5, 10, 4, 10, 25]);
    assert.deepEqual(row("industry"), ["INDUSTRY", "INDUSTRY", "ai", "source", 2, 4, 6, 12, 40]);
    assert.deepEqual(row("ai_security"), ["AI SECURITY", "AI SEC", "ai", "topic", 7, 14, 5, 10, 30]);
    assert.deepEqual(row("open_local"), ["LOCAL & OPEN MODELS", "LOCAL", "ai", "topic", 4, 8, 4, 10, 25]);
    assert.deepEqual(row("tools"), ["AGENTS & TOOLS", "TOOLS", "ai", "topic", 3, 6, 4, 10, 25]);
    assert.deepEqual(row("policy"), ["POLICY & REGULATION", "POLICY", "ai", "topic", 7, 21, 4, 10, 30]);
    assert.deepEqual(row("money"), ["MARKETS & DEALS", "MONEY", "ai", "topic", 3, 6, 4, 10, 25]);
    assert.deepEqual(row("research"), ["RESEARCH", "RESEARCH", "ai", "source", 7, 10, 4, 10, 25]);
    assert.deepEqual(row("compute"), ["CHIPS & COMPUTE", "COMPUTE", "ai", "topic", 5, 10, 4, 10, 25]);
    assert.deepEqual(row("safety"), ["SAFETY & ALIGNMENT", "SAFETY", "ai", "source", 14, 21, 3, 8, 20]);
    assert.deepEqual(row("cyber"), ["CYBER WIRE", "CYBER", "owner", "source", 3, 7, 5, 10, 25]);
    assert.deepEqual(row("analysis"), ["ANALYSIS", "ANALYSIS", "ai", "source", 10, 21, 4, 10, 25]);
    assert.deepEqual(row("robotics"), ["ROBOTICS", "ROBOTICS", "ai", "topic", 7, 14, 3, 8, 20]);
    assert.deepEqual(row("quantum"), ["QUANTUM WATCH", "QUANTUM", "owner", "source", 14, 21, 3, 5, 15]);
    assert.deepEqual(row("releases"), ["RELEASE RADAR", "RELEASES", "utility", "source", 5, 10, 4, 10, 25]);
  });

  it("keeps every section internally consistent", () => {
    for (const s of SECTIONS) {
      assert.ok(s.window.softDays <= s.window.hardDays, s.id);
      assert.ok(s.homeRows <= s.allRows, s.id);
      assert.ok(s.window.minItems <= s.homeRows, s.id);
      assert.equal(s.maxPublisherShare, 0.3, s.id);
      assert.ok(s.legacyIds.length >= 1, s.id);
    }
  });

  it("only ai-desk sections feed TOP STORIES", () => {
    assert.deepEqual(sectionsOfDesk("owner").map((s) => s.id), ["cyber", "quantum"]);
    assert.deepEqual(sectionsOfDesk("utility").map((s) => s.id), ["releases"]);
    assert.equal(sectionsOfDesk("ai").length, 12);
    assert.equal(isAiDesk("ai_security"), true);
    assert.equal(isAiDesk("cyber"), false);
    assert.equal(isAiDesk("releases"), false);
  });

  it("looks sections up and rejects unknown ids", () => {
    assert.equal(sectionById("money").label, "MARKETS & DEALS");
    assert.throws(() => sectionById("funding" as never), /unknown section/);
    assert.equal(findSection("nope"), undefined);
    assert.equal(isSectionId("tools"), true);
    assert.equal(isSectionId("model_releases"), false);
    assert.equal(isSectionId(3), false);
    assert.equal(sectionOrder("models"), 0);
    assert.equal(sectionOrder("releases"), 14);
    assert.equal(sectionOrder("nope"), -1);
  });

  it("maps all 18 V1 category ids onto V2 sections", () => {
    assert.equal(LEGACY_SECTION_IDS.length, 18);
    for (const legacy of LEGACY_SECTION_IDS) {
      const targets = legacyToSections(legacy);
      assert.ok(targets.length >= 1, legacy);
      for (const t of targets) {
        assert.ok(isSectionId(t));
        assert.ok(sectionById(t).legacyIds.includes(legacy), `${t} must list ${legacy} in legacyIds`);
      }
      assert.equal(legacyToSection(legacy), targets[0]);
    }
    // and the reverse: every legacyIds entry is reflected in the map
    for (const s of SECTIONS) for (const l of s.legacyIds) assert.ok(LEGACY_TO_SECTIONS[l].includes(s.id));
    assert.equal(legacyToSection("local_models"), "open_local");
    assert.equal(legacyToSection("open_source"), "open_local");
    assert.equal(legacyToSection("products"), "tools");
    assert.equal(legacyToSection("funding"), "money");
    assert.equal(legacyToSection("ai_finance"), "money");
    assert.equal(legacyToSection("hardware"), "compute");
    assert.equal(legacyToSection("cyber_threats"), "cyber");
    assert.equal(legacyToSection("cyber_defense"), "cyber");
    assert.equal(legacyToSection("github_repos"), "releases");
  });

  it("splits safety_policy into policy (default) and safety", () => {
    assert.deepEqual(legacyToSections("safety_policy"), ["policy", "safety"]);
    assert.equal(legacyToSection("safety_policy"), "policy");
    assert.equal(legacyToSection("safety_policy", { safetyHalf: true }), "safety");
    assert.equal(legacyToSection("research", { safetyHalf: true }), "research");
    assert.equal(legacyToSection("unknown"), undefined);
    assert.deepEqual(legacyToSections("unknown"), []);
  });
});
