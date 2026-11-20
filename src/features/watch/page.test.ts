import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RIVER } from "../../../shared/contract";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { ABSENT_WORD, titleWords } from "../../../test/helpers/fixtureCases";
import { fixtureRiver } from "../../../test/helpers/fixtureData";
import { a11yProblems, countOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { WatchPage } from "./WatchPage";

// Watch terms come from the fixture's own 7-day river (a frozen live build that is replaced now and
// then): BUSY is the word most headlines carry, RARE one that a few carry, QUIET one that none does.
const WORDS = titleWords(fixtureRiver.rows.map((r) => r[RIVER.title]));
const BUSY = WORDS[0].word;
const RARE = WORDS.find((w) => w.titles >= 2 && w.titles * 4 <= WORDS[0].titles)?.word ?? "";
const QUIET = ABSENT_WORD;
/** Rows of a term's group before "Show all". */
const GROUP_PREVIEW = 8;

describe("watchlist page (SSR)", () => {
  it("empty watchlist: explains, offers the three presets and the term editor", () => {
    const html = renderRoute(createFakeServices(), WatchPage, { name: "watch" });
    assert.deepEqual(tagTexts(html, "h2"), ["Watchlist"]);
    assert.match(textOf(html), /Your watchlist is empty\./);
    const buttons = tagTexts(html, "button");
    for (const b of ["Add CISO (12)", "Add Local LLM (12)", "Add Finance regulation (12)", "Add"]) assert.ok(buttons.includes(b), b);
    assert.match(html, /<label for="([^"]+)">Add a watch term<\/label><input id="\1"/);
    assert.match(html, /role="group" aria-label="Suggested term sets"/);
    assert.equal(countOf(html, "data-aid="), 0);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("explains the matching rules: whole words and the * wildcard", () => {
    const html = renderRoute(createFakeServices(), WatchPage, { name: "watch" });
    assert.ok(tagTexts(html, "h3").includes("How matching works"));
    const text = textOf(html);
    assert.match(text, /Whole words only\./);
    assert.match(text, /Wildcard \*/);
    assert.match(text, /quantiz\* matches “quantized” and “quantization”/);
    assert.match(text, /Only headlines are matched/);
  });

  it("groups hits by term with counts, newest first, and lists quiet terms", async () => {
    assert.ok(WORDS[0].titles > 4 * GROUP_PREVIEW && RARE, "fixture: a word in many headlines and one in a few");
    // Listed rarest first: the page orders the groups by hits, not by the reader's order.
    const s = createFakeServices({ watchTerms: [QUIET, RARE, BUSY] });
    await s.edition.loadRiver();
    const html = renderRoute(s, WatchPage, { name: "watch" });
    assert.match(tagTexts(html, "h2")[0], /^Watchlist \d+ stories · last 7 days$/);
    const h3 = tagTexts(html, "h3");
    assert.match(h3[0], new RegExp(`^${BUSY} \\d+ (\\d+|none) in the last 24 h$`));
    assert.match(h3[1], new RegExp(`^${RARE} \\d+ `));
    const hits = (heading: string): number => Number(/ (\d+) /.exec(`${heading} `)?.[1]);
    assert.ok(hits(h3[0]) > hits(h3[1]) && hits(h3[1]) > 0, `most hits first: ${h3[0]} / ${h3[1]}`);
    assert.ok(textOf(html).includes(`No hits in the last 7 days ${QUIET}`));
    assert.match(textOf(html), /\d+ stories matched 2 of 3 terms\./);
    assert.ok(countOf(html, "data-aid=") > 0);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("every term has a labelled remove button; presets show what they would add", async () => {
    // "Ollama" is a term of the Local LLM preset as written (its model names are "Qwen*" / "Gemma*").
    const s = createFakeServices({ watchTerms: ["Ollama", "MCP", "FINRA"] });
    await s.edition.loadRiver();
    const html = renderRoute(s, WatchPage, { name: "watch" });
    for (const t of ["Ollama", "MCP", "FINRA"]) assert.match(html, new RegExp(`aria-label="Remove watch term ${t}"`));
    assert.match(html, /aria-label="Watch terms \(3\)"/);
    const buttons = tagTexts(html, "button");
    assert.ok(buttons.includes("Add CISO (11)") && buttons.includes("Add Local LLM (11)") && buttons.includes("Add Finance regulation (11)"));
    assert.ok(buttons.includes("Remove all terms"));
  });

  it("caps a long group and offers the rest", async () => {
    const s = createFakeServices({ watchTerms: [BUSY] });
    await s.edition.loadRiver();
    const html = renderRoute(s, WatchPage, { name: "watch" });
    assert.equal(countOf(html, "data-aid="), GROUP_PREVIEW);
    const all = tagTexts(html, "button").find((b) => new RegExp(`^Show all \\d+ for ${BUSY}$`).test(b));
    assert.ok(all && Number(/\d+/.exec(all)?.[0]) > GROUP_PREVIEW, tagTexts(html, "button").join(" | "));
  });

  it("waits for the river when there are terms", () => {
    const html = renderRoute(createFakeServices({ watchTerms: ["Qwen"] }), WatchPage, { name: "watch" });
    assert.match(html, /role="status"[^>]*>Loading the 7-day archive…/);
  });

  it("uses a real dialog for the 'remove all' confirmation and mounts no second briefing button", () => {
    const html = renderRoute(createFakeServices({ watchTerms: ["Qwen"] }), WatchPage, { name: "watch" });
    assert.equal(countOf(html, "<dialog"), 1);
    // The masthead's Briefing button is on every page; a page-level one duplicated it (and its dialog).
    assert.ok(!html.includes("sp-trigger"));
    assert.ok(!tagTexts(html, "button").some((b) => /briefing/i.test(b)));
    assert.match(textOf(html), /the Briefing button at the top of every page/);
  });
});
