import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS } from "../../../shared/sections";
import { capAt, diversify, type DiversityOptions } from "./diversity";

interface Row {
  id: string;
  publisher: string;
  source: string;
}
const row = (id: string, publisher: string, source: string = publisher): Row => ({ id, publisher, source });
const opts = (over: Partial<DiversityOptions<Row>> = {}): DiversityOptions<Row> => ({
  share: 0.3,
  homeRows: 10,
  limit: 25,
  keysOf: (r) => ({ publisher: r.publisher, source: r.source }),
  ...over,
});
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id);
const maxPer = (rows: readonly Row[], key: "publisher" | "source"): number => {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r[key], (n.get(r[key]) ?? 0) + 1);
  return Math.max(0, ...n.values());
};

describe("capAt", () => {
  it("is ceil(share x homeRows) on the homepage and grows with the list", () => {
    assert.equal(capAt(1, 0.3, 10), 3);
    assert.equal(capAt(10, 0.3, 10), 3);
    assert.equal(capAt(13, 0.3, 10), 3);
    assert.equal(capAt(14, 0.3, 10), 4);
    assert.equal(capAt(25, 0.3, 10), 7);
    assert.equal(capAt(40, 0.3, 12), 12);
  });

  it("gives the published per-section homepage caps", () => {
    const got = Object.fromEntries(SECTIONS.map((s) => [s.id, capAt(1, s.maxPublisherShare, s.homeRows)]));
    assert.equal(got.industry, 4); // 12 rows
    assert.equal(got.models, 3); // 10 rows
    assert.equal(got.safety, 3); // 8 rows
    assert.equal(got.quantum, 2); // 5 rows: "2 per publisher"
  });

  it("never returns less than 1 and is immune to float noise", () => {
    assert.equal(capAt(1, 0.01, 1), 1);
    assert.equal(capAt(1, 0.1, 30), 3);
    assert.equal(capAt(1, 0.3, 20), 6);
  });
});

describe("diversify", () => {
  it("caps a publisher on the homepage and moves the surplus down, not out", () => {
    const ranked = [...Array.from({ length: 6 }, (_, i) => row(`a${i}`, "arxiv")), ...Array.from({ length: 12 }, (_, i) => row(`o${i}`, `other${i}`))];
    const got = diversify(ranked, opts());
    assert.deepEqual(ids(got.kept.slice(0, 3)), ["a0", "a1", "a2"]);
    assert.equal(got.kept.slice(0, 10).filter((r) => r.publisher === "arxiv").length, 3);
    // The 4th arXiv row waits for row 14 (floor(0.3 x 14) = 4), the 5th for row 17.
    assert.equal(got.kept[13].id, "a3");
    assert.equal(got.kept[16].id, "a4");
    assert.equal(got.kept.length, 17);
    assert.deepEqual(ids(got.deferred), ["a5"]);
    assert.deepEqual(got.overflow, []);
  });

  it("counts twin feeds of one publisher together (V1 capped per feed name)", () => {
    const ranked = [
      row("t1", "techcrunch", "techcrunch-ai"),
      row("t2", "techcrunch", "techcrunch-startups"),
      row("t3", "techcrunch", "techcrunch-robotics"),
      row("t4", "techcrunch", "techcrunch-ai"),
      ...Array.from({ length: 8 }, (_, i) => row(`o${i}`, `other${i}`)),
    ];
    const got = diversify(ranked, opts());
    assert.equal(got.kept.slice(0, 10).filter((r) => r.publisher === "techcrunch").length, 3);
    assert.ok(!got.kept.includes(ranked[3]) || got.kept.indexOf(ranked[3]) >= 10);
  });

  it("caps a link-host feed per SOURCE even though every item has its own publisher", () => {
    const ranked = [...Array.from({ length: 8 }, (_, i) => row(`m${i}`, `outlet${i}.com`, "techmeme")), ...Array.from({ length: 7 }, (_, i) => row(`o${i}`, `other${i}`))];
    const got = diversify(ranked, opts());
    assert.equal(got.kept.slice(0, 10).filter((r) => r.source === "techmeme").length, 3);
    assert.equal(maxPer(got.kept.slice(0, 10), "publisher"), 1);
  });

  it("holds the share for every prefix of the full list", () => {
    const ranked = Array.from({ length: 60 }, (_, i) => row(`r${i}`, i % 3 === 0 ? "big" : i % 3 === 1 ? "mid" : `small${i}`));
    const got = diversify(ranked, opts());
    assert.equal(got.kept.length, 25);
    for (let k = 1; k <= got.kept.length; k++) {
      assert.ok(maxPer(got.kept.slice(0, k), "publisher") <= capAt(k, 0.3, 10), `prefix ${k}`);
    }
  });

  it("stops at the limit: capped items stay deferred, the rest overflow", () => {
    const ranked = [...Array.from({ length: 5 }, (_, i) => row(`a${i}`, "a")), ...Array.from({ length: 5 }, (_, i) => row(`o${i}`, `o${i}`))];
    const got = diversify(ranked, opts({ limit: 6, homeRows: 5 }));
    assert.deepEqual(ids(got.kept), ["a0", "a1", "o0", "o1", "o2", "o3"]);
    assert.deepEqual(ids(got.deferred), ["a2", "a3", "a4"]);
    assert.deepEqual(ids(got.overflow), ["o4"]);
  });

  it("keeps rank order when nothing is over a cap, and does not mutate the input", () => {
    const ranked = Array.from({ length: 8 }, (_, i) => row(`r${i}`, `p${i}`));
    const copy = [...ranked];
    const got = diversify(ranked, opts());
    assert.deepEqual(ids(got.kept), ids(ranked));
    assert.deepEqual(ranked, copy);
  });
});
