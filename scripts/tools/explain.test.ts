import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeEdition } from "../../shared/select";
import { makeNormalized, makeStory } from "../../test/helpers/factories";
import { fixtureFront, fixtureRest, fixtureRiver } from "../../test/helpers/fixtureData";
import { createTestContext, emptyState, PIPELINE } from "../pipeline/context";
import { emit } from "../pipeline/emit/edition";
import { REGULATOR_NOTICE_TAGS, buildExplain, type ExplainFile } from "../pipeline/emit/explain";
import { rejectedThisRun } from "../pipeline/emit/river";
import { makePlacements, sample, sampleInput } from "../pipeline/emit/testkit.test";
import { writeBundle, writeExplain } from "../pipeline/emit/write";
import { fade, score } from "../pipeline/score/index";
import { SCORE } from "../pipeline/score/weights";
import type { DroppedItem, DropReason } from "../pipeline/types";
import { explainFromPublished, findInExplain, formatDropped, formatHits, formatStory, muteLines, runExplain } from "./explain";

const DROPPED: DroppedItem[] = [
  { id: "abc123", sourceId: "krebs", title: "Join our AI security webinar", url: "https://krebsonsecurity.com/webinar", reason: "noise", stage: "relevance", detail: "matched exclude term: webinar" },
  { id: null, sourceId: "reuters-ai", title: "Broken link item", url: "not-a-url", reason: "invalid", stage: "normalize" },
];

function explainOf(): { explain: ExplainFile; s: ReturnType<typeof sample> } {
  const s = sample();
  const scored = { ...s.story.ipo, parts: { tier: 20, recency: 31.5, importance: 4, coverage: 38.25, hn: 1.25 }, score: 95 };
  const placements = { ...s.placements, stories: { ...s.placements.stories, [scored.lead]: scored }, trace: { [scored.lead]: { routedTo: "money" as const, rule: "ipo", cut: { policy: "cap" as const } } } };
  return { explain: buildExplain(placements, DROPPED, createTestContext()), s };
}

describe("explain tool", () => {
  it("finds a story by article id and prints score parts, placements and the route trace", () => {
    const { explain, s } = explainOf();
    const hits = findInExplain(explain, s.story.ipo.lead);
    assert.equal(hits.stories.length, 1);
    const text = formatStory(hits.stories[0]).join("\n");
    assert.match(text, /^Anthropic valued at \$2tn as shares begin trading/);
    assert.match(text, /score 95\.00 = tier 20\.00 \+ recency 31\.50 \+ importance 4\.00 \+ coverage 38\.25 \+ hn 1\.25/);
    assert.match(text, /4 publisher\(s\): reuters, techcrunch, the-verge, bloomberg\.com/);
    assert.match(text, /LEAD STORY/);
    assert.match(text, /TOP STORIES #1/);
    assert.match(text, /placed: industry #1 \(homepage\)/);
    assert.match(text, /placed: money #1 \(homepage\)/);
    assert.match(text, /route: routed to money by rule "ipo"/);
    assert.match(text, /cut from policy: cap/);
    assert.match(text, /also \(4\):/);
  });

  it("finds a story through one of its members, by URL (ignoring scheme, www and tracking parameters)", () => {
    const { explain, s } = explainOf();
    const hits = findInExplain(explain, "http://bloomberg.com/news/anthropic-ipo?utm_source=x");
    assert.equal(hits.stories.length, 1);
    assert.equal(hits.stories[0].story.id, s.story.ipo.lead);
    assert.equal(hits.stories[0].via?.id, s.item.bloomberg.id);
    assert.match(formatStory(hits.stories[0]).join("\n"), /matched member: Anthropic prices record IPO/);
  });

  it("finds stories by title words (all words, any order, case-insensitive)", () => {
    const { explain, s } = explainOf();
    assert.deepEqual(findInExplain(explain, "gpt-6 introducing").stories.map((m) => m.story.id), [s.story.launch.lead]);
    const unplaced = findInExplain(explain, "missed every cap");
    assert.match(formatStory(unplaced.stories[0]).join("\n"), /not placed in any section \(would be listed under industry; river only\)/);
    assert.deepEqual(findInExplain(explain, "no such story anywhere"), { stories: [], dropped: [] });
    assert.match(formatHits(findInExplain(explain, "zzz"), "zzz", explain)[0], /^No story or dropped item matches "zzz"/);
  });

  it("TOP STORIES rules: a held slot, a folded follow-up (both sides) and the section-focus bonus are stated", () => {
    const s = sample();
    const ipo = s.story.ipo.lead;
    const other = Object.keys(s.placements.stories).find((id) => id !== ipo);
    assert.ok(other, "the sample has a second story");
    const placements = {
      ...s.placements,
      topHeld: { [ipo]: { since: "2026-11-19T19:30:00.000Z", score: 91.5 } },
      topRelated: { [ipo]: [other] },
      trace: { [other]: { routedTo: null, focus: { open_local: "open_local/runtime +20 title[llama.cpp]" } } },
    };
    const explain = buildExplain(placements, [], createTestContext());
    const top = formatStory(findInExplain(explain, ipo).stories[0]).join("\n");
    assert.match(top, /held in TOP STORIES since 2026-11-19T19:30:00\.000Z at score 91\.50/);
    assert.match(top, new RegExp(`follow-up folded under this TOP story \\(no slot of its own\\): ".+" \\[${other}\\]`));
    const followUp = formatStory(findInExplain(explain, other).stories[0]).join("\n");
    assert.match(followUp, new RegExp(`not in TOP STORIES: a follow-up of the running story "Anthropic valued at .+" \\[${ipo}\\]`));
    assert.match(followUp, /section focus in open_local: open_local\/runtime \+20 title\[llama\.cpp\] \(orders that section's list only; the score is unchanged\)/);
    // Without the optional placements fields nothing of this is printed.
    const plain = formatStory(findInExplain(buildExplain(s.placements, [], createTestContext()), ipo).stories[0]).join("\n");
    assert.ok(!/held in TOP|follow-up|section focus/.test(plain));
  });

  it("explains dropped items with their reason", () => {
    const { explain } = explainOf();
    const hits = findInExplain(explain, "abc123");
    assert.equal(hits.stories.length, 0);
    assert.deepEqual(hits.dropped.map((d) => d.reason), ["noise"]);
    const text = formatHits(hits, "abc123", explain).join("\n");
    assert.match(text, /DROPPED at relevance: noise \(matched exclude term: webinar\) {2}\[source krebs\]/);
    assert.equal(findInExplain(explain, "broken link").dropped[0].id, null);
  });

  it("runs from the command line against the explain record of the last run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-explain-"));
    const { explain, s } = explainOf();
    await writeExplain(explain, path.join(root, "node_modules/.tmp/explain.json"));
    const ok = await runExplain([s.story.ipo.lead], root);
    assert.equal(ok.code, 0);
    assert.match(ok.lines.join("\n"), /score 95\.00/);
    const words = await runExplain(["anthropic", "megathread"], root);
    assert.match(words.lines.join("\n"), /matched member: Anthropic IPO megathread/);
    assert.equal((await runExplain(["nothing-like-this"], root)).code, 1);
    assert.equal((await runExplain([], root)).code, 2);
    await fs.rm(root, { recursive: true });
  });

  it("falls back to the published data when there is no explain record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-explain-"));
    const ctx = createTestContext();
    const s = sample();
    await writeBundle(emit(sampleInput(ctx, s), ctx), emptyState(), { dataDir: path.join(root, "public/data/v2"), publicDir: path.join(root, "public") });
    const r = await runExplain([s.item.bloomberg.id], root);
    assert.equal(r.code, 0);
    const text = r.lines.join("\n");
    assert.match(text, /No explain record found; using the published data/);
    assert.match(text, /member of the story led by \w+: Anthropic valued at \$2tn/);
    assert.match(text, /coverage: 4 publisher\(s\), 4 other article\(s\)/);
    assert.match(text, /TOP STORIES #1 \(lead\)/);
    assert.match(text, /placed: industry #1 \(homepage\)/);
    const riverOnly = await runExplain(["missed", "every", "cap"], root);
    assert.match(riverOnly.lines.join("\n"), /river only: TechCrunch AI, section industry/);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-explain-"));
    const none = await runExplain(["anything"], empty);
    assert.equal(none.code, 1);
    assert.match(none.lines[0], /Run the pipeline first/);
    await fs.rm(root, { recursive: true });
    await fs.rm(empty, { recursive: true });
  });

  it("answers from the committed fixture (a frozen live build)", () => {
    const lead = fixtureFront.leadId;
    assert.ok(lead);
    const text = explainFromPublished(fixtureFront, fixtureRest, fixtureRiver, lead).join("\n");
    assert.match(text, /TOP STORIES #1 \(lead\)/);
    assert.match(explainFromPublished(fixtureFront, null, null, "https://example.invalid/none").join("\n"), /Nothing published matches/);
  });

  // ---- behaviours added in the fix round of 2026-11-20 --------------------------------------------

  it("regulator notice: says the importance part includes the term and what the fade leaves of it - matching what the score stage does", () => {
    const ctx = createTestContext();
    const { regulatorNotice: points, max: cap } = SCORE.importance;
    assert.deepEqual([...REGULATOR_NOTICE_TAGS], ["regulator", "first-party"]);
    let n = 0;
    const notice = (tags: string[], title: string, ageHours: number, flags: ("release" | "paper")[] = []) =>
      makeNormalized({ sourceId: "finra-notices", sourceName: "FINRA Notices", publisher: "finra", publisherName: "FINRA", tier: 1, home: "policy", tags, title, flags, publishedAt: new Date(ctx.now.getTime() - ageHours * 3_600_000).toISOString(), url: `https://www.finra.org/rules-guidance/notices/${n++}` });
    const explainOne = (item: ReturnType<typeof notice>): { text: string; importance: number } => {
      const [scored] = score([makeStory([item])], { hn: { byUrl: new Map() } }, ctx);
      const explain = buildExplain(makePlacements({ stories: [scored], rows: { policy: [scored.lead] } }), [], ctx);
      return { text: formatStory({ story: explain.stories[0] }).join("\n"), importance: scored.parts.importance };
    };
    const TITLE = "Regulatory Notice 26-24: FINRA Adopts Amendments";

    for (const age of [0, 38]) {
      const kept = fade(age);
      // A title with no event word: the whole importance is the term, faded.
      const plain = explainOne(notice(["regulator", "first-party"], TITLE, age));
      const untagged = explainOne(notice(["press"], TITLE, age));
      assert.equal(untagged.importance, 0, "this title has no event word of its own");
      assert.ok(Math.abs(plain.importance - points * kept) < 1e-9, `age ${age} h: the score stage adds ${points} x fade for exactly these tags`);
      assert.match(plain.text, new RegExp(`^  fade x${kept.toFixed(2)} at ${age} h \\(half-life ${SCORE.fadeHalfLifeHours} h\\) is already applied to tier, importance, coverage and hn`, "m"));
      assert.match(
        plain.text,
        new RegExp(`importance includes the regulator-notice term: the lead's source is tagged regulator \\+ first-party, which adds ${points.toFixed(2)} before the fade \\(title signals 0\\.00\\); after the fade it is worth ${(points * kept).toFixed(2)} of the ${plain.importance.toFixed(2)}$`, "m"),
      );
      assert.doesNotMatch(untagged.text, /regulator-notice/);
      assert.match(untagged.text, /^ {2}fade x/m, "the fade line is printed for every story");

      // A title that already scores: the sum is capped, and explain says so instead of inventing a split.
      const loud = explainOne(notice(["regulator", "first-party"], "SEC charges AI startup with fraud after data breach lawsuit", age));
      assert.ok(Math.abs(loud.importance - cap * kept) < 1e-9);
      assert.match(loud.text, new RegExp(`adds ${points.toFixed(2)} before the fade \\(capped at ${cap.toFixed(2)} together with the title signals\\); after the fade it is worth ${(points * kept).toFixed(2)} of the ${loud.importance.toFixed(2)}$`, "m"));
    }
    assert.ok(fade(38) < 0.8 && fade(38) > 0.7, "at 38 h (the FINRA notice of 2026-11-20) about a quarter of the term is gone");

    // One tag is not enough, and a release line gets no importance at all - explain must not claim the term for either.
    for (const tags of [["regulator"], ["first-party"], []]) assert.doesNotMatch(explainOne(notice(tags, TITLE, 2)).text, /regulator-notice/, tags.join("+"));
    const release = explainOne(notice(["regulator", "first-party"], "tool v1.2.3", 2, ["release"]));
    assert.equal(release.importance, 0);
    assert.doesNotMatch(release.text, /regulator-notice/);
  });

  it("corroboration rescue: an item kept over its source's cap is marked; an item the cap cut says why it was not kept", () => {
    const s = sample();
    const rescuedItem = s.story.ipo.items[1]; // TechCrunch's copy
    const explain = buildExplain(s.placements, DROPPED, createTestContext(), { rescued: [rescuedItem, { id: "not-in-any-story", sourceId: "x" }] });
    const story = explain.stories.find((x) => x.id === s.story.ipo.lead);
    assert.ok(story);
    assert.deepEqual(story.members.filter((m) => m.rescued).map((m) => m.id), [rescuedItem.id]);
    assert.equal(story.rescued, undefined, "the lead was not over a cap");
    assert.equal(story.members[0].sourceId, "techcrunch-ai");
    const text = formatStory({ story }).join("\n");
    assert.match(text, /kept over the source cap: "Anthropic's IPO is the largest in history" \[\w+\] - TechCrunch AI had more items than its cap, and this one stays because another publisher covers the same story/);
    assert.equal(text.match(/kept over the source cap/g)?.length, 1);
    assert.doesNotMatch(formatStory({ story: buildExplain(s.placements, [], createTestContext()).stories[0] }).join("\n"), /kept over the source cap/, "without the note nothing is claimed");
    // Same id from another source (twin feeds) is not marked.
    const twin = buildExplain(s.placements, [], createTestContext(), { rescued: [{ id: rescuedItem.id, sourceId: "some-other-feed" }] });
    assert.ok(!JSON.stringify(twin).includes('"rescued"'));

    const capped: DroppedItem = { id: "cap001", sourceId: "openai-news", title: "A ninth OpenAI post", url: "https://openai.com/ninth", reason: "source_cap", stage: "relevance", detail: "over the per-source cap of 8 (kept the freshest)" };
    const lines = formatDropped(capped);
    assert.match(lines[2], /DROPPED at relevance: source_cap \(over the per-source cap of 8 \(kept the freshest\)\)/);
    assert.match(lines[3], /not kept as corroboration: an over-cap item comes back only when a surviving item of ANOTHER publisher is in the same story, and none was/);
    assert.equal(lines.length, 4, "a cap drop does not touch the river memory");
  });

  it("river memory: explain says a content drop also removes the remembered row - for exactly the reasons emit uses", () => {
    const all: DropReason[] = ["invalid", "duplicate", "release_collapsed", "too_old", "off_topic", "excluded", "noise", "source_cap"];
    for (const reason of all) {
      const d: DroppedItem = { id: "r1", sourceId: "src", title: "T", url: "https://x.test/1", reason, stage: "relevance" };
      const says = formatDropped(d).some((l) => /also leaves the 7-day river and search/.test(l));
      assert.equal(says, rejectedThisRun([d]).size === 1, reason);
    }
    assert.ok(!formatDropped({ id: null, sourceId: "src", title: "T", url: "bad", reason: "invalid", stage: "normalize" }).some((l) => /river/.test(l)), "an item without an id never had a row");
  });

  it("mutes: shows the row a reader sees when the lead's source is muted - re-led, unchanged or gone - using the client's own function", () => {
    const ctx = createTestContext();
    const s = sample();
    const bundle = emit(sampleInput(ctx, s), ctx);
    const edition = mergeEdition(bundle.front, bundle.rest);
    const explain = buildExplain(s.placements, [], ctx);
    const ipo = explain.stories.find((x) => x.id === s.story.ipo.lead);
    const single = explain.stories.find((x) => x.id === s.story.essay.lead);
    assert.ok(ipo && single);

    // Default: "what if the lead's own source is muted".
    const text = formatStory({ story: ipo }, { edition }).join("\n");
    assert.match(text, /if a reader mutes the lead's source \(reuters-ai\): the row keeps its place and is re-led by "Anthropic's IPO is the largest in history" - TechCrunch AI \[\w+\], 3 publisher\(s\) shown/);
    assert.match(text, new RegExp(`the story key stays ${s.story.ipo.lead}, so its rank does not change; title, link, source, time and bookmark are the shown outlet's`));
    assert.match(formatStory({ story: single }, { edition }).join("\n"), /if a reader mutes the lead's source \(simon-willison\): the row disappears - every outlet covering the story is muted/);

    // --mute: named sources.
    assert.match(formatStory({ story: ipo }, { edition, mute: ["techcrunch-ai", "hn-front"] }).join("\n"), /with techcrunch-ai, hn-front muted: the row is unchanged \(2 muted outlet\(s\) leave the "Also:" line, 3 publisher\(s\) shown\)/);
    assert.match(formatStory({ story: ipo }, { edition, mute: ["krebs"] }).join("\n"), /with krebs muted: the row is unchanged$/m);
    assert.match(formatStory({ story: ipo }, { edition, mute: ["reuters-ai", "techcrunch-ai"] }).join("\n"), /with reuters-ai, techcrunch-ai muted: the row keeps its place and is re-led by "Anthropic goes public" - The Verge AI/);

    // No edition (or one that does not hold the story): nothing is claimed.
    assert.doesNotMatch(formatStory({ story: ipo }).join("\n"), /mute/);
    assert.deepEqual(muteLines(edition, "zzzzzz"), []);
    assert.deepEqual(muteLines(null, s.story.ipo.lead), []);
    // An unplaced story has no row to re-lead.
    const unplaced = explain.stories.find((x) => x.id === s.story.unplaced.lead);
    assert.ok(unplaced);
    assert.doesNotMatch(formatStory({ story: unplaced }, { edition }).join("\n"), /mute/);
  });

  it("command line: the mute preview comes from the published files of the SAME build, and says so when they are not", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aid2-explain-"));
    try {
      const ctx = createTestContext();
      const s = sample();
      await writeBundle(emit(sampleInput(ctx, s), ctx), emptyState(), { dataDir: path.join(root, "public/data/v2"), publicDir: path.join(root, "public") });
      await writeExplain(buildExplain(s.placements, [], ctx), path.join(root, "node_modules/.tmp/explain.json"));
      const same = await runExplain([s.story.ipo.lead], root);
      assert.match(same.lines.join("\n"), /re-led by "Anthropic's IPO is the largest in history"/);
      const named = await runExplain([s.story.ipo.lead, "--mute", "techcrunch-ai, the-verge-ai"], root);
      assert.match(named.lines.join("\n"), /with techcrunch-ai, the-verge-ai muted: the row is unchanged/);
      const published = await runExplain([s.story.ipo.lead, "--mute", "reuters-ai", "--file", path.join(root, "missing.json")], root);
      assert.match(published.lines.join("\n"), /No explain record found[\s\S]*with reuters-ai muted: the row keeps its place and is re-led by/);

      // An explain record of another build than the published files.
      const later = createTestContext({ now: new Date(ctx.now.getTime() + 30 * 60_000) });
      await writeExplain(buildExplain(s.placements, [], later), path.join(root, "node_modules/.tmp/explain.json"));
      const other = await runExplain([s.story.ipo.lead], root);
      assert.equal(other.code, 0);
      assert.doesNotMatch(other.lines.join("\n"), /re-led/);
      assert.match(other.lines.at(-1) ?? "", /^\(mute preview not shown: the published files in .* are from another build \(/);
      await fs.rm(path.join(root, "public"), { recursive: true });
      assert.match((await runExplain([s.story.ipo.lead], root)).lines.at(-1) ?? "", /^\(mute preview not shown: no published files in /);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a real pipeline run records the rescued items: the explain record and the relevance output agree", async () => {
    const { processItems } = await import("../pipeline/run");
    const { loadFixtureRegistry, loadRawItems } = await import("../../test/helpers/fixtures");
    const ctx = createTestContext();
    const p = processItems({ items: loadRawItems(), signals: { hn: { byUrl: new Map() } } }, loadFixtureRegistry(), ctx);
    assert.ok(p.rescued.length > 0, "the 2026-11-19 corpus has over-cap corroboration (RE-01)");
    const kept = new Set(p.relevance.kept);
    assert.ok(p.rescued.every((i) => kept.has(i)), "every rescued item is a kept item");
    const explain = buildExplain(p.placements, p.dropped, ctx, { rescued: p.rescued });
    const marked = explain.stories.flatMap((st) => [st, ...st.members]).filter((i) => i.rescued);
    assert.equal(marked.length, p.rescued.length);
    // Each marked item sits in a story another publisher covers, or took a cap slot that items of a
    // big story had used (big-story relief) - then its source holds more kept items than the default
    // cap. Those are the only two reasons an over-cap item is kept.
    const keptPerSource = new Map<string, number>();
    for (const i of p.relevance.kept) keptPerSource.set(i.sourceId, (keptPerSource.get(i.sourceId) ?? 0) + 1);
    for (const st of explain.stories) {
      const items = [st, ...st.members];
      for (const i of items.filter((x) => x.rescued)) {
        const corroborated = new Set(items.map((x) => x.publisher)).size >= 2;
        assert.ok(corroborated || (keptPerSource.get(i.sourceId ?? "") ?? 0) > PIPELINE.sourceCap, `${st.title} [${i.sourceId}]`);
      }
    }
    assert.ok(!p.dropped.some((d) => d.reason === "source_cap" && p.rescued.some((r) => r.id === d.id && r.sourceId === d.sourceId)), "a rescued item is not also listed as dropped");
  });
});
