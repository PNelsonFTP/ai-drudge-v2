import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MUTES } from "../../../shared/select";
import { FIXTURE_NOW_MS, hoursAgo, makeArticle, makeRiver } from "../../../test/helpers/factories";
import { fixtureRiver } from "../../../test/helpers/fixtureData";
import { WATCH_PRESETS } from "../../app/presets";
import { TERMS_MAX, buildWatchView, checkTerm, presetMissing, type WatchView } from "./model";

const NOW = FIXTURE_NOW_MS;

function world() {
  const q1 = makeArticle({ title: "Qwen 4 lands with quantized GGUF builds", home: "open_local", src: "a", publishedAt: hoursAgo(2) });
  const q1twin = makeArticle({ title: "Alibaba's Qwen 4 is out", home: "open_local", src: "b", publishedAt: hoursAgo(3) });
  const q2 = makeArticle({ title: "Benchmarks: Qwen vs Gemma", home: "open_local", src: "a", publishedAt: hoursAgo(50) });
  const quant = makeArticle({ title: "A quantization primer", home: "research", src: "c", publishedAt: hoursAgo(30) });
  const sec = makeArticle({ title: "SEC opens AI-washing sweep", home: "policy", src: "d", publishedAt: hoursAgo(5) });
  const security = makeArticle({ title: "Security teams adopt agent sandboxes", home: "ai_security", src: "d", publishedAt: hoursAgo(6) });
  const bedrock = makeArticle({ title: "Bedrock adds guardrails", home: "tools", src: "e", publishedAt: hoursAgo(7) });
  const edr = makeArticle({ title: "EDR vendors race to cover MCP servers", home: "cyber", src: "e", publishedAt: hoursAgo(8) });
  const open = makeArticle({ title: "An open-source model beats the open source baseline", home: "open_local", src: "f", publishedAt: hoursAgo(9) });
  const cve = makeArticle({ title: "Patch now: CVE-2026-1234 in a vector database", home: "cyber", src: "e", publishedAt: hoursAgo(10) });
  const stale = makeArticle({ title: "Qwen from eight days ago", home: "open_local", src: "a", publishedAt: hoursAgo(8 * 24) });
  const river = makeRiver([q1, q1twin, q2, quant, sec, security, bedrock, edr, open, cve, stale], { leads: { [q1twin.id]: q1.id } });
  return { river, q1, q1twin, q2, quant, sec, security, bedrock, edr, open, cve, stale };
}

const view = (w: ReturnType<typeof world>, terms: string[]): WatchView => buildWatchView({ river: w.river, terms, mutes: NO_MUTES, nowMs: NOW });
const group = (v: WatchView, term: string): string[] => v.groups.find((g) => g.term === term)?.rows.map((r) => r.id) ?? [];

describe("watch/model - buildWatchView", () => {
  it("groups hits by term: one row per story, newest first, with week and 24 h counts", () => {
    const w = world();
    const v = view(w, ["Qwen"]);
    assert.deepEqual(group(v, "Qwen"), [w.q1.id, w.q2.id], "the twin collapses into its story; the 8-day-old item is outside the window");
    assert.equal(v.groups[0].count, 2);
    assert.equal(v.groups[0].last24h, 1);
    assert.equal(v.groups[0].rows[0].item?.title, "Qwen 4 lands with quantized GGUF builds");
    assert.equal(v.groups[0].rows[0].item?.section, "open_local");
    assert.equal(v.stories, 2);
  });

  it("matches whole words only", () => {
    const w = world();
    const v = view(w, ["SEC", "EDR"]);
    assert.deepEqual(group(v, "SEC"), [w.sec.id], "SEC does not match Security");
    assert.deepEqual(group(v, "EDR"), [w.edr.id], "EDR does not match Bedrock");
  });

  it("supports the * wildcard at the end and the start of a term", () => {
    const w = world();
    const v = view(w, ["quantiz*", "CVE-*", "*rock"]);
    assert.deepEqual(group(v, "quantiz*"), [w.q1.id, w.quant.id], "quantized and quantization");
    assert.deepEqual(group(v, "CVE-*"), [w.cve.id]);
    assert.deepEqual(group(v, "*rock"), [w.bedrock.id]);
  });

  it("treats spaces and hyphens alike, ignores case and accepts a plural", () => {
    const w = world();
    const v = view(w, ["open source", "vendor", "mcp server"]);
    assert.deepEqual(group(v, "open source"), [w.open.id]);
    assert.deepEqual(group(v, "vendor"), [w.edr.id], "vendors");
    assert.deepEqual(group(v, "mcp server"), [w.edr.id], "MCP servers");
  });

  it("orders groups by hit count (ties in the reader's order) and lists quiet terms separately", () => {
    const w = world();
    const v = view(w, ["FINRA", "SEC", "Qwen", "EDR", "broker-dealer"]);
    assert.deepEqual(v.groups.map((g) => [g.term, g.count]), [
      ["Qwen", 2],
      ["SEC", 1],
      ["EDR", 1],
    ]);
    assert.deepEqual(v.quiet, ["FINRA", "broker-dealer"]);
  });

  it("a story matching two terms appears under both but is counted once overall", () => {
    const w = world();
    const v = view(w, ["Qwen", "GGUF"]);
    assert.deepEqual(group(v, "GGUF"), [w.q1.id]);
    assert.equal(v.stories, 2);
  });

  it("overlapping terms each keep their hits (one matcher per term)", () => {
    const w = world();
    const v = view(w, ["open source", "open source model"]);
    assert.deepEqual(group(v, "open source"), [w.open.id]);
    assert.deepEqual(group(v, "open source model"), [w.open.id]);
  });

  it("respects mutes and an empty watchlist", () => {
    const w = world();
    const muted = buildWatchView({ river: w.river, terms: ["Qwen", "SEC"], mutes: { sources: new Set(["a"]), sections: new Set(["policy"]) }, nowMs: NOW });
    assert.deepEqual(group(muted, "Qwen"), [w.q1twin.id], "the other outlet of the story remains");
    assert.deepEqual(muted.quiet, ["SEC"]);
    assert.deepEqual(view(w, []), { groups: [], quiet: [], stories: 0 });
  });

  it("every preset finds hits in the committed 7-day fixture", () => {
    const now = Date.parse(fixtureRiver.generatedAt);
    for (const p of WATCH_PRESETS) {
      const v = buildWatchView({ river: fixtureRiver, terms: p.terms, mutes: NO_MUTES, nowMs: now });
      assert.ok(v.stories > 0, `${p.label}: ${v.stories} stories`);
      assert.equal(v.groups.length + v.quiet.length, p.terms.length);
      for (const g of v.groups) {
        assert.equal(g.count, g.rows.length);
        assert.ok(g.last24h <= g.count);
        assert.ok(g.rows.every((r) => r.item), "river rows carry fallback data");
      }
      const counts = v.groups.map((g) => g.count);
      assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    }
  });
});

describe("watch/model - term editing", () => {
  it("checkTerm trims, collapses whitespace and accepts wildcards", () => {
    assert.deepEqual(checkTerm("  prompt   injection ", []), { ok: true, term: "prompt injection" });
    assert.deepEqual(checkTerm("quantiz*", ["Qwen"]), { ok: true, term: "quantiz*" });
  });

  it("checkTerm rejects blank, wildcard-only, too long, duplicate and over-limit input", () => {
    assert.equal(checkTerm("   ", []).ok, false);
    assert.equal(checkTerm("*", []).ok, false);
    assert.equal(checkTerm("**", []).ok, false);
    assert.equal(checkTerm("x".repeat(61), []).ok, false);
    const dup = checkTerm("qwen", ["Qwen"]);
    assert.ok(!dup.ok && dup.error.includes("already"));
    const full = checkTerm("new", Array.from({ length: TERMS_MAX }, (_, i) => `t${i}`));
    assert.ok(!full.ok && full.error.includes(String(TERMS_MAX)));
  });

  it("presetMissing counts the terms a preset would add", () => {
    const ciso = WATCH_PRESETS[0];
    assert.equal(presetMissing(ciso.terms, []), ciso.terms.length);
    assert.equal(presetMissing(ciso.terms, ["JAILBREAK", "mcp"]), ciso.terms.length - 2);
    assert.equal(presetMissing(ciso.terms, ciso.terms), 0);
  });
});
