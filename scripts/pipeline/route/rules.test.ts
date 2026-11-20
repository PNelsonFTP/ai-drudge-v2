import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PUBLISHERS, SOURCES } from "../../registry/index";
import { SECTIONS, findSection } from "../../../shared/sections";
import { compileTerms } from "../../../shared/text";
import { AI_TERMS, AI_TERMS_EXACT, ROUTE_POLICY, ROUTE_RULES, sectionPriority } from "./rules";

const lists = (r: (typeof ROUTE_RULES)[number]): [string, readonly string[]][] => [
  ["strong", r.strong],
  ["versioned", r.versioned ?? []],
  ["exact", r.exact ?? []],
  ["weak", r.weak ?? []],
  ["withAny", r.withAny ?? []],
  ["withExact", r.withExact ?? []],
  ["not", r.not ?? []],
];

describe("route rules (data)", () => {
  it("every topic-mode section has a rule and no rule targets a source-mode section", () => {
    const targets = new Set(ROUTE_RULES.map((r) => r.section));
    for (const def of SECTIONS) {
      if (def.mode === "topic") assert.ok(targets.has(def.id), `topic section ${def.id} has no routing rule`);
      else assert.ok(!targets.has(def.id), `source-mode section ${def.id} must not have a routing rule`);
    }
  });

  it("rule ids are unique and prefixed with their section", () => {
    const ids = ROUTE_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of ROUTE_RULES) assert.ok(r.id.startsWith(`${r.section}/`), r.id);
  });

  it("every term compiles, is trimmed and appears once per list", () => {
    for (const r of ROUTE_RULES) {
      for (const [name, terms] of lists(r)) {
        const m = compileTerms(terms);
        assert.equal(m.size, terms.length, `${r.id}.${name}: blank or duplicate term (${terms.length} listed, ${m.size} compiled)`);
        for (const t of terms) assert.equal(t, t.trim(), `${r.id}.${name}: "${t}" is not trimmed`);
      }
    }
    assert.equal(compileTerms(AI_TERMS).size, AI_TERMS.length);
  });

  it("strong terms are written lower case; case-sensitive lists have no wildcards", () => {
    for (const r of ROUTE_RULES) {
      for (const t of [...r.strong, ...(r.versioned ?? []), ...(r.weak ?? []), ...(r.not ?? []), ...(r.withAny ?? [])]) assert.equal(t, t.toLowerCase(), `${r.id}: "${t}" belongs in a case-sensitive list`);
      for (const t of [...(r.exact ?? []), ...(r.withExact ?? [])]) assert.ok(!t.includes("*"), `${r.id}: exact term "${t}" has a wildcard`);
    }
    for (const t of AI_TERMS_EXACT) assert.ok(!t.includes("*"));
  });

  it("a term is never both strong and weak in one rule", () => {
    for (const r of ROUTE_RULES) {
      const strong = new Set([...r.strong, ...(r.versioned ?? [])]);
      for (const w of r.weak ?? []) assert.ok(!strong.has(w), `${r.id}: "${w}" is strong and weak`);
      for (const v of r.versioned ?? []) assert.ok(!r.strong.includes(v), `${r.id}: "${v}" is strong and versioned`);
    }
  });

  it("models/launch routes family names only with a version; generic agent-misbehaviour adverbs stay behind the AI gate", () => {
    const launch = ROUTE_RULES.find((r) => r.id === "models/launch");
    assert.ok(launch);
    for (const family of ["claude", "gemini", "imagen"]) assert.ok(launch.versioned?.includes(family), family);
    for (const family of ["claude", "gemini", "llama", "gpt-*", "sora"]) assert.ok(!launch.strong.includes(family), `"${family}" routes without a version again`);
    const attacks = ROUTE_RULES.find((r) => r.id === "ai_security/attacks");
    const vuln = ROUTE_RULES.find((r) => r.id === "ai_security/ai-vuln");
    assert.ok(attacks && vuln);
    for (const t of ["secretly", "covertly"]) assert.ok(!attacks.strong.includes(t), `"${t}" must not route ungated`);
    assert.ok(vuln.strong.includes("secretly") && (vuln.withAny?.length ?? 0) > 0);
    assert.ok(![...attacks.strong, ...vuln.strong].includes("covertly"));
  });

  it("V1's substring offenders are gone or exact", () => {
    const all = new Set(ROUTE_RULES.flatMap((r) => [...r.strong, ...(r.weak ?? [])]));
    for (const bad of ["edr", "ga", "ga ", "figure", "why ai", "what is", "patch", "llama ", "claude ", "rag "]) assert.ok(!all.has(bad), `"${bad}" is back`);
  });

  it("AI SECURITY outranks every other section; tools is the broadest lane", () => {
    const topic = SECTIONS.filter((s) => s.mode === "topic").map((s) => s.id);
    for (const id of topic) if (id !== "ai_security") assert.ok(sectionPriority("ai_security") > sectionPriority(id), id);
    for (const id of topic) if (id !== "tools") assert.ok(sectionPriority(id) > sectionPriority("tools"), id);
    assert.equal(sectionPriority("industry"), 0);
  });

  it("policy constants point at real sections", () => {
    assert.equal(findSection(ROUTE_POLICY.moveFrom)?.desk, "owner");
    assert.equal(findSection(ROUTE_POLICY.moveTo)?.mode, "topic");
    for (const id of ROUTE_POLICY.generalDesks) assert.equal(findSection(id)?.mode, "source");
    for (const id of ROUTE_POLICY.moveYieldsTo) {
      assert.equal(findSection(id)?.mode, "topic");
      assert.equal(findSection(id)?.desk, "ai", "isAiDesk (route/index.ts) relies on the move target being an ai desk");
      assert.notEqual(id, ROUTE_POLICY.moveTo);
    }
    assert.ok(ROUTE_POLICY.subjectCap.maxHomeRows >= 1 && ROUTE_POLICY.subjectCap.titleShare > 0.5 && ROUTE_POLICY.subjectCap.titleShare <= 1);
  });
});

describe("regulator floor: the registry facts it relies on", () => {
  const { publishers, section } = ROUTE_POLICY.regulatorFloor;
  const active = SOURCES.filter((s) => s.status !== "paused");
  const noticeFeeds = (publisher: string) => active.filter((s) => s.publisher === publisher && s.home === section && (s.tags ?? []).includes("regulator") && (s.tags ?? []).includes("first-party"));

  it("every listed publisher id exists in the registry", () => {
    for (const id of publishers) assert.ok(PUBLISHERS.some((p) => p.id === id), `${id}: unknown publisher id in ROUTE_POLICY.regulatorFloor.publishers`);
  });

  it("the financial regulators each have an active POLICY feed tagged regulator + first-party", () => {
    for (const id of ["finra", "sec", "occ", "fca", "bank-of-england", "iosco", "fsb", "cftc"]) {
      assert.ok(publishers.includes(id), id);
      assert.ok(noticeFeeds(id).length >= 1, `${id}: no active POLICY source with both tags - the floor would never apply`);
    }
  });

  it("NIST and CISA are listed but inert today: their feeds are not tagged regulator (tagging one switches the floor AND the score term on)", () => {
    for (const id of ["nist", "cisa"]) {
      assert.ok(publishers.includes(id), id);
      assert.deepEqual(noticeFeeds(id).map((s) => s.id), [], `${id}: now floored - update this test and docs/CONTRACTS.md section 11`);
    }
  });
});
