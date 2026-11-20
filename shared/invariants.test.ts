import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EditionFront, EditionRest } from "./contract";
import { checkAux, checkBundle, checkFront, checkRest, checkRiver } from "./invariants";
import { fixtureBundle } from "../test/helpers/fixtureData";
import { hoursAgo, makeArticle, makeEdition, makeRiver, resetFactories } from "../test/helpers/factories";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function sample(): { front: EditionFront; rest: EditionRest } {
  resetFactories();
  const lead = makeArticle({ src: "press-a" });
  const m1 = makeArticle({ src: "press-b" });
  const m2 = makeArticle({ src: "press-c" });
  const others = Array.from({ length: 14 }, (_, i) => makeArticle({ src: `press-${i % 4}` }));
  const cyber = makeArticle({ home: "cyber", src: "sec-wire" });
  const { front, rest } = makeEdition({
    articles: [lead, m1, m2, ...others, cyber],
    rows: { industry: [lead.id, ...others.map((a) => a.id)], cyber: [cyber.id], ai_security: [cyber.id] },
    clusters: { [lead.id]: [m1.id, m2.id] },
    top: [lead.id],
  });
  return { front, rest };
}

describe("shared/invariants", () => {
  it("the committed fixture (a frozen live build) satisfies every invariant", () => {
    assert.deepEqual(checkBundle(fixtureBundle), []);
  });

  it("a factory-built edition satisfies every invariant", () => {
    const { front, rest } = sample();
    assert.deepEqual(checkFront(front), []);
    assert.deepEqual(checkRest(front, rest), []);
    assert.equal(front.sections.find((s) => s.id === "industry")?.rows.length, 12, "homeRows prefix");
    assert.equal(rest.sections.find((s) => s.id === "industry")?.rows.length, 15);
    assert.ok(Object.keys(rest.articles).length > 0, "tail articles live in rest");
  });

  const frontProblem = (fn: (f: EditionFront) => void): string => {
    const { front } = sample();
    const f = clone(front);
    fn(f);
    return checkFront(f).join("\n");
  };
  const restProblem = (fn: (f: EditionFront, r: EditionRest) => void): string => {
    const s = sample();
    const f = clone(s.front);
    const r = clone(s.rest);
    fn(f, r);
    return checkRest(f, r).join("\n");
  };

  it("front: referential integrity", () => {
    assert.match(frontProblem((f) => f.sections[1].rows.push("ghost")), /row ghost not in front\.articles/);
    assert.match(frontProblem((f) => f.top.push("ghost")), /front\.top: ghost not in front\.articles/);
    assert.match(frontProblem((f) => (f.leadId = null)), /leadId: must equal top\[0\]/);
    assert.match(frontProblem((f) => f.sections.pop()), /SECTIONS order/);
    assert.match(frontProblem((f) => f.sections.reverse()), /SECTIONS order/);
    assert.match(frontProblem((f) => f.sections[1].rows.push(f.sections[1].rows[0])), /duplicate row/);
    assert.match(frontProblem((f) => (f.sections[1].total = 1)), /total 1 < rows/);
    assert.match(frontProblem((f) => (f.top = Array.from({ length: 13 }, () => f.top[0]))), /front\.top: 13 > 12/);
    assert.match(frontProblem((f) => delete f.sources[Object.keys(f.sources)[0]]), /not in sources/);
    assert.match(frontProblem((f) => (f.articles[f.top[0]].flags = ["release"])), /is a release/);
    assert.match(frontProblem((f) => (f.articles[f.top[0]].flags = ["discussion"])), /community item/);
  });

  it("front: cluster rules", () => {
    const lead = (f: EditionFront): string => Object.keys(f.clusters)[0];
    assert.match(frontProblem((f) => f.clusters[lead(f)].members.push("ghost")), /member ghost not in articles/);
    assert.match(frontProblem((f) => f.clusters[lead(f)].members.push(lead(f))), /must not include the lead/);
    assert.match(frontProblem((f) => (f.clusters[lead(f)].members = [])), /singleton cluster must be omitted/);
    assert.match(frontProblem((f) => (f.clusters[lead(f)].publishers = 9)), /publishers 9 out of range/);
    assert.match(frontProblem((f) => f.sections[1].rows.splice(1, 0, f.clusters[lead(f)].members[0])), /also a row/);
    assert.match(frontProblem((f) => delete f.clusters[lead(f)]), /not referenced by any row, top story or cluster/);
  });

  it("front: source-mode sections only hold their home articles", () => {
    assert.match(frontProblem((f) => (f.articles[f.sections[1].rows[3]].home = "models")), /source-mode section holds/);
  });

  it("rest: prefix, disjointness, counts, totals", () => {
    assert.deepEqual(restProblem(() => undefined), "");
    assert.match(restProblem((_f, r) => (r.buildId = "other")), /rest\.buildId/);
    assert.match(restProblem((_f, r) => r.sections[1].rows.reverse()), /not a prefix/);
    assert.match(restProblem((f, r) => (r.articles[f.top[0]] = f.articles[f.top[0]])), /also in front\.articles/);
    assert.match(restProblem((f, r) => (r.sources[Object.keys(f.sources)[0]] = { name: "x", publisher: "x", kind: "rss" })), /also in front\.sources/);
    assert.match(restProblem((_f, r) => r.sections[1].rows.pop()), /total 15 !== rest rows 14/);
    assert.match(restProblem((f) => (f.counts.placements += 1)), /counts\.placements/);
    assert.match(restProblem((f) => (f.counts.stories += 1)), /counts\.stories/);
    assert.match(restProblem((_f, r) => r.sections[1].rows.push("ghost")), /row ghost not in/);
    assert.match(restProblem((f) => (f.sections[1].sourceCount = 99)), /sourceCount 99/);
  });

  it("rest: a story sits in home + at most one routed section", () => {
    // cyber story is in cyber (home) + ai_security (routed): fine. Add a second routed section.
    assert.match(
      restProblem((f, r) => {
        const id = r.sections.find((s) => s.id === "cyber")?.rows[0] ?? "";
        r.sections[0].rows.push(id);
        f.sections[0].rows.push(id);
        f.sections[0].total += 1;
        f.counts.placements += 1;
      }),
      /home \+ at most one routed section/,
    );
  });

  it("rest: TOP STORIES must be ai-desk stories", () => {
    resetFactories();
    const q = makeArticle({ home: "quantum" });
    const q2 = makeArticle({ home: "quantum" });
    const { front, rest } = makeEdition({ articles: [q, q2], clusters: { [q.id]: [q2.id] }, top: [q.id] });
    assert.match(checkRest(front, rest).join("\n"), /not an ai-desk story/);
  });

  it("river: order, uniqueness, age, coverage of the edition", () => {
    resetFactories();
    const fresh = Array.from({ length: 6 }, () => makeArticle());
    const old = makeArticle({ publishedAt: hoursAgo(24 * 9) });
    const { front, rest } = makeEdition({ articles: fresh });
    assert.deepEqual(checkRiver(makeRiver(fresh), front, rest), []);
    assert.match(checkRiver(makeRiver([...fresh, old]), front, rest).join("\n"), /older than 7 days/);
    assert.match(checkRiver(makeRiver(fresh.slice(1)), front, rest).join("\n"), /edition articles from the last 7 days are missing/);
    const shuffled = makeRiver(fresh);
    shuffled.rows.reverse();
    assert.match(checkRiver(shuffled).join("\n"), /out of order/);
    const dup = makeRiver(fresh);
    dup.rows.push(dup.rows[dup.rows.length - 1]);
    assert.match(checkRiver(dup).join("\n"), /duplicate id/);
    const selfLead = makeRiver(fresh, { leads: { [fresh[0].id]: fresh[0].id } });
    assert.match(checkRiver(selfLead).join("\n"), /names itself as lead/);
    assert.match(checkRiver(makeRiver(fresh, { meta: { buildId: "x" } }), front, rest).join("\n"), /river\.buildId/);
  });

  it("aux: buildIds, feed counts, status totals", () => {
    const b = clone(fixtureBundle);
    assert.deepEqual(checkAux(b), []);
    b.brief.buildId = "other";
    b.health.feeds[0].ok = !b.health.feeds[0].ok;
    b.status.content.top += 1;
    const problems = checkAux(b).join("\n");
    assert.match(problems, /brief\.buildId/);
    assert.match(problems, /feedsOk/);
    assert.match(problems, /status\.content\.top/);
  });
});
