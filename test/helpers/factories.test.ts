import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashId } from "../../shared/ids";
import { SECTIONS } from "../../shared/sections";
import { resolveSource } from "../../scripts/registry/defaults";
import { TEST_NOW_ISO } from "../../scripts/pipeline/context";
import {
  FIXTURE_NOW_ISO,
  FIXTURE_NOW_MS,
  hoursAgo,
  makeArticle,
  makeEdition,
  makeItem,
  makeNormalized,
  makePublisher,
  makeRegistry,
  makeRiver,
  makeScoredStory,
  makeSource,
  makeStory,
  resetFactories,
} from "./factories";
import { assertValidBundle, bundleProblems } from "./invariants";

describe("test/helpers/factories", () => {
  beforeEach(() => resetFactories());

  it("is deterministic after resetFactories()", () => {
    const a = [makeArticle(), makeArticle()];
    resetFactories();
    assert.deepEqual([makeArticle(), makeArticle()], a);
    assert.notEqual(a[0].id, a[1].id);
    assert.equal(FIXTURE_NOW_ISO, TEST_NOW_ISO);
    assert.equal(hoursAgo(2), new Date(FIXTURE_NOW_MS - 7_200_000).toISOString());
  });

  it("makeArticle: id follows the url; overrides win", () => {
    const a = makeArticle({ url: "https://example.org/x", home: "cyber", tier: 1, publishedAt: null });
    assert.equal(a.id, hashId("https://example.org/x"));
    assert.equal(a.home, "cyber");
    assert.equal(a.publishedAt, null);
    assert.ok(a.firstSeenAt);
    assert.equal(makeArticle({ id: "fixed" }).id, "fixed");
  });

  it("makeEdition with no rows places articles in their home sections, newest first", () => {
    const arts = [makeArticle({ home: "models" }), makeArticle({ home: "models" }), makeArticle({ home: "cyber" })];
    const { front, rest, edition, frontOnly } = makeEdition({ articles: arts });
    assertValidBundle({ front, rest });
    assert.deepEqual(front.sections.map((s) => s.id), SECTIONS.map((s) => s.id));
    assert.deepEqual(front.sections.find((s) => s.id === "models")?.rows, [arts[0].id, arts[1].id]);
    assert.equal(front.counts.stories, 3);
    assert.equal(front.leadId, null);
    assert.equal(edition.complete, true);
    assert.equal(frontOnly.complete, false);
  });

  it("makeEdition splits front / rest and keeps clusters with their lead", () => {
    const lead = makeArticle();
    const member = makeArticle({ src: "other-source" });
    const tail = Array.from({ length: 20 }, () => makeArticle());
    const tailLead = tail[19];
    const tailMember = makeArticle({ src: "third-source" });
    const { front, rest } = makeEdition({
      articles: [lead, member, ...tail, tailMember],
      rows: { industry: [lead.id, ...tail.map((a) => a.id)] },
      clusters: { [lead.id]: [member.id], [tailLead.id]: [tailMember.id] },
      top: [lead.id],
    });
    assertValidBundle({ front, rest, river: makeRiver([lead, member, ...tail, tailMember]) });
    assert.equal(front.sections[1].rows.length, 12);
    assert.equal(front.sections[1].total, 21);
    assert.ok(front.clusters[lead.id] && front.articles[member.id]);
    assert.ok(rest.clusters[tailLead.id] && rest.articles[tailMember.id]);
    assert.equal(front.clusters[tailLead.id], undefined);
    assert.equal(front.leadId, lead.id);
    assert.equal(front.clusters[lead.id].publishers, 2);
  });

  it("makeEdition honours homeRows and reports inconsistent specs", () => {
    const arts = Array.from({ length: 5 }, () => makeArticle());
    const { front } = makeEdition({ articles: arts, homeRows: { industry: 2 } });
    assert.equal(front.sections[1].rows.length, 2);
    assert.throws(() => makeEdition({ articles: arts, rows: { industry: ["ghost"] } }), /ghost is referenced but not in spec\.articles/);
    // a spec that breaks a contract rule is caught by the invariants, not silently fixed
    const bad = makeEdition({ articles: arts, rows: { research: [arts[0].id] } });
    assert.match(bundleProblems({ front: bad.front, rest: bad.rest }).join("\n"), /source-mode section holds/);
  });

  it("registry builders", () => {
    const s = makeSource({ id: "openai-news", home: "models", tier: 1 });
    assert.equal(s.publisher, "openai-news");
    assert.equal(s.name, "Openai News");
    assert.equal(resolveSource(s).leadEligible, true);
    const reg = makeRegistry([s, makeSource({ publisher: "shared-pub" }), makeSource({ publisher: "shared-pub" })], [makePublisher({ id: "shared-pub" })]);
    assert.equal(reg.sources.length, 3);
    assert.deepEqual(reg.publishers.map((p) => p.id), ["shared-pub", "openai-news"]);
  });

  it("pipeline builders", () => {
    const raw = makeItem({ sourceId: "x" });
    assert.match(raw.link, /^https:\/\/example\.com\/item-/);
    assert.equal(raw.summaryHtml, null);

    const n = makeNormalized({ url: "https://Example.com/a/?utm_source=x", publisher: "techcrunch" });
    assert.equal(n.url, "https://example.com/a");
    assert.equal(n.id, hashId("https://example.com/a"));
    assert.equal(n.publisherName, "Techcrunch");
    assert.equal(n.effectiveAt, n.publishedAt);
    const undated = makeNormalized({ publishedAt: null, firstSeenAt: hoursAgo(1) });
    assert.equal(undated.effectiveAt, hoursAgo(1));

    const a = makeNormalized({ publisher: "p1" });
    const b = makeNormalized({ publisher: "p1" });
    const c = makeNormalized({ publisher: "p2" });
    const rel = makeNormalized({ publisher: "github:x/y", countsForCoverage: false, flags: ["release"] });
    const story = makeStory([a, b, c, rel]);
    assert.equal(story.lead, a.id);
    assert.deepEqual(story.members, [b.id, c.id, rel.id]);
    assert.deepEqual(story.publishers, ["p1", "p2"], "twins count once; releases never count");
    assert.throws(() => makeStory([]), /at least one item/);

    const scored = makeScoredStory([a, c], { score: 99, w: 2 });
    assert.equal(scored.score, 99);
    assert.equal(scored.w, 2);
    assert.equal(scored.effectiveAt, a.effectiveAt);
    assert.ok(scored.ageHours > 0);
  });
});
