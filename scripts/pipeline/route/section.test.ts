import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sectionById, type SectionDef } from "../../../shared/sections";
import { FIXTURE_NOW_MS, hoursAgo, makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import type { NormalizedItem, ScoredStory } from "../types";
import { buildSection, holdBack } from "./section";
import { compareScore } from "./top";

const NOW = FIXTURE_NOW_MS;
let seq = 0;

/** A single-item story; publisher and source are unique unless given. */
function story(o: { hours?: number; score?: number; publisher?: string; source?: string; item?: Partial<NormalizedItem> } = {}): ScoredStory {
  seq += 1;
  const lead = makeNormalized({
    title: `Story ${seq}`,
    home: "models",
    publisher: o.publisher ?? `pub-${seq}`,
    sourceId: o.source ?? o.publisher ?? `src-${seq}`,
    publishedAt: hoursAgo(o.hours ?? 1),
    ...o.item,
  });
  return makeScoredStory([lead], { score: o.score ?? 100 - seq * 0.01 });
}
const ranked = (stories: ScoredStory[]): ScoredStory[] => [...stories].sort(compareScore);
// The window these cases were written against (MODELS & LABS until 2026-11-20; it is 5 / 10 days now).
const models: SectionDef = { ...sectionById("models"), window: { softDays: 3, hardDays: 6, minItems: 4 } }; // home 10, all 25
const days = (d: number): number => d * 24;

describe("buildSection", () => {
  it("ranks soft-window stories by score and drops everything past the hard window", () => {
    const fresh = [story({ score: 50 }), story({ score: 90 }), story({ score: 70 }), story({ score: 60 })];
    const expired = story({ score: 999, hours: days(6) + 1 });
    const got = buildSection(models, ranked([...fresh, expired]), NOW);
    assert.deepEqual(got.rows.map((s) => s.score), [90, 70, 60, 50]);
    assert.equal(got.cut.get(expired.lead), "window");
  });

  it("does not pad a healthy section with stories between the soft and the hard window", () => {
    const fresh = Array.from({ length: 5 }, () => story());
    const older = story({ score: 500, hours: days(4) });
    const got = buildSection(models, ranked([...fresh, older]), NOW);
    assert.equal(got.rows.length, 5);
    assert.ok(!got.rows.includes(older));
    assert.equal(got.cut.get(older.lead), "window");
  });

  it("starvation fill: backfills from the soft..hard band up to minItems only, fresh rows first", () => {
    const fresh = [story({ score: 10 })];
    const older = [story({ score: 80, hours: days(4) }), story({ score: 90, hours: days(5) }), story({ score: 70, hours: days(4) }), story({ score: 60, hours: days(5) })];
    const got = buildSection(models, ranked([...fresh, ...older]), NOW);
    assert.equal(got.rows.length, models.window.minItems);
    assert.deepEqual(got.rows.map((s) => s.score), [10, 90, 80, 70]);
    assert.equal(got.cut.get(older[3].lead), "window");
  });

  it("an empty or fully expired candidate list gives an empty section", () => {
    assert.deepEqual(buildSection(models, [], NOW).rows, []);
    assert.deepEqual(buildSection(models, [story({ hours: days(30) })], NOW).rows, []);
  });

  it("applies the publisher cap and records the surplus as a diversity cut", () => {
    const arxiv = Array.from({ length: 6 }, () => story({ publisher: "arxiv", score: 200 }));
    const others = Array.from({ length: 9 }, () => story({ score: 100 }));
    const got = buildSection(models, ranked([...arxiv, ...others]), NOW);
    assert.equal(got.rows.slice(0, 10).filter((s) => s.items[0].publisher === "arxiv").length, 3);
    assert.equal(got.rows.length, 12);
    assert.equal([...got.cut.values()].filter((r) => r === "diversity").length, 3);
  });

  it("relaxes the cap rather than starving a section that has only one publisher", () => {
    const quantum = sectionById("quantum"); // home 5 -> cap 2, min 3
    const wire = Array.from({ length: 6 }, () => story({ publisher: "pr-wire", item: { home: "quantum" } }));
    const got = buildSection(quantum, ranked(wire), NOW);
    assert.equal(got.rows.length, quantum.window.minItems);
    assert.equal([...got.cut.values()].filter((r) => r === "diversity").length, 3);
  });

  it("prefers an older story from another publisher over breaking the cap", () => {
    const quantum = sectionById("quantum"); // soft 14 d, hard 21 d
    const wire = Array.from({ length: 4 }, () => story({ publisher: "pr-wire", item: { home: "quantum" } }));
    const older = story({ hours: days(16), item: { home: "quantum" } });
    const got = buildSection(quantum, ranked([...wire, older]), NOW);
    assert.equal(got.rows.length, 3);
    assert.ok(got.rows.includes(older));
    assert.equal(got.rows.filter((s) => s.items[0].publisher === "pr-wire").length, 2);
  });

  it("a source's own maxAgeDays extends the hard window, as backfill only", () => {
    const cyber = sectionById("cyber"); // soft 3 d, hard 7 d, min 5
    const alert = story({ hours: days(20), item: { home: "cyber", title: "FINRA Cybersecurity Alert" } });
    const slow = { ...alert, items: [{ ...alert.items[0], maxAgeDays: 30 } as NormalizedItem] };
    const fresh = (n: number): ScoredStory[] => Array.from({ length: n }, () => story({ item: { home: "cyber" } }));
    assert.ok(!buildSection(cyber, ranked([alert, ...fresh(2)]), NOW).rows.includes(alert), "without the field: expired");
    assert.ok(buildSection(cyber, ranked([slow, ...fresh(2)]), NOW).rows.includes(slow), "thin section: kept alive");
    assert.ok(!buildSection(cyber, ranked([slow, ...fresh(6)]), NOW).rows.includes(slow), "healthy section: not padded");
  });

  it("cuts at allRows", () => {
    const many = Array.from({ length: 40 }, () => story());
    const got = buildSection(models, ranked(many), NOW);
    assert.equal(got.rows.length, models.allRows);
    assert.equal([...got.cut.values()].filter((r) => r === "cap").length, 15);
  });

  it("a release routed in from the release radar never takes one of the first 3 rows", () => {
    const openLocal = sectionById("open_local");
    const release = story({ score: 999, item: { home: "releases", kind: "github-release", flags: ["release"], title: "llama.cpp b12549 released" } });
    const news = Array.from({ length: 5 }, () => story({ item: { home: "open_local" } }));
    const got = buildSection(openLocal, ranked([release, ...news]), NOW);
    assert.equal(got.rows.indexOf(release), 3);
    // In its own section a release ranks normally.
    const radar = buildSection(sectionById("releases"), ranked([release, story({ item: { home: "releases", kind: "github-release", flags: ["release"] } })]), NOW);
    assert.equal(radar.rows[0], release);
  });

  it("uses the clock it is given", () => {
    const s = story({ hours: 1 });
    assert.equal(buildSection(models, [s], NOW).rows.length, 1);
    assert.equal(buildSection(models, [s], NOW + days(7) * 3_600_000).rows.length, 0);
  });
});

describe("holdBack", () => {
  const held = (x: string): boolean => x.startsWith("r");
  it("moves held items below the first N rows and keeps relative order", () => {
    assert.deepEqual(holdBack(["r1", "a", "r2", "b", "c", "d"], held, 3), ["a", "b", "c", "r1", "r2", "d"]);
  });
  it("lets held items through when there is nothing else", () => {
    assert.deepEqual(holdBack(["r1", "a", "r2"], held, 3), ["a", "r1", "r2"]);
    assert.deepEqual(holdBack(["r1", "r2"], held, 3), ["r1", "r2"]);
  });
  it("leaves held items alone once they rank below row N", () => {
    assert.deepEqual(holdBack(["a", "b", "c", "r1", "d"], held, 3), ["a", "b", "c", "r1", "d"]);
  });
});
