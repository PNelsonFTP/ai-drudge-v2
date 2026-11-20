import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTION_IDS, sectionById, type SectionId } from "../../../shared/sections";
import { NO_MUTES, storyPassesTimeFilter } from "../../../shared/select";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_MS, fixtureEdition, fixtureFront, fixtureRiver } from "../../../test/helpers/fixtureData";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { buildSectionView } from "./model";
import { SectionPage } from "./SectionPage";

// The fixture is a frozen live build that is replaced now and then: every count below is read from it.
const edition = fixtureEdition();
/** Stories of a section's full ranked list. */
const total = (id: SectionId): number => edition.sections.find((s) => s.id === id)?.rows.length ?? 0;
/** Rows of a section on the homepage (front.json). */
const homeRows = (id: SectionId): number => fixtureFront.sections.find((s) => s.id === id)?.rows.length ?? 0;
/** The river tail of a section (items of the last 7 days that are not in its ranked list). */
const tailOf = (id: SectionId): number => buildSectionView({ edition, river: fixtureRiver, id, mutes: NO_MUTES, filter: "all", nowMs: FIXTURE_GENERATED_MS, previousVisitMs: null }).tail.length;
/** Tail rows the page shows before "Show all". */
const TAIL_PREVIEW = 30;
const label = (id: SectionId): string => sectionById(id).label;

describe("section page (SSR)", () => {
  it("renders the full ranked list with heading, chips, publisher mix and neighbour links", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    const id: SectionId = "ai_security";
    const n = total(id);
    const def = sectionById(id);
    assert.ok(n > homeRows(id), "fixture: the full AI SECURITY list is longer than its homepage list");
    const html = renderRoute(s, SectionPage, { name: "section", id });
    assert.deepEqual(tagTexts(html, "h2"), [`AI SECURITY ${n} stories`]);
    assert.equal(countOf(html, "data-aid="), n + Math.min(tailOf(id), TAIL_PREVIEW));
    assert.match(html, /role="group" aria-label="Time filter for AI SECURITY"/);
    assert.deepEqual(tagTexts(html, "button").slice(0, 5).map((t) => t.replace(/\s*\d+$/, "")), ["NEW", "6H", "24H", "3D", "ALL"]);
    // The accessible name starts with the visible chip text (WCAG 2.5.3 Label in Name).
    assert.ok(html.includes(`aria-pressed="true" aria-label="ALL ${n} stories, Everything"`));
    assert.match(html, /aria-pressed="false" aria-label="6H \d+ (story|stories), Last 6 hours"/);
    assert.match(textOf(html), new RegExp(`Publisher mix .+ — \\d+ publishers across ${n} stories\\. Ranked list: up to ${def.allRows} stories from the last ${def.window.hardDays} days\\.`));
    const at = SECTION_IDS.indexOf(id);
    const [prev, next] = [SECTION_IDS[at - 1], SECTION_IDS[at + 1]];
    const hrefs = hrefsOf(html);
    assert.ok(hrefs.includes(`#/s/${prev}`) && hrefs.includes(`#/s/${next}`) && hrefs.includes("#/"));
    // Not "Sections": the shell's chip nav already has that name on the same page.
    assert.match(html, /<nav class="sp-nav" aria-label="Previous and next section">/);
    assert.ok(textOf(html).includes(`← ${label(prev)} All sections ${label(next)} →`), textOf(html).slice(-200));
    assert.deepEqual(a11yProblems(html), []);
  });

  it("appends the river tail under its own heading, capped with a 'show all' button", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    // A section whose tail is longer than the preview (the fixture has one: section/model.test.ts).
    const id = SECTION_IDS.find((x) => tailOf(x) > TAIL_PREVIEW);
    assert.ok(id, "fixture: a section with more than 30 river-tail rows");
    const [n, tail] = [total(id), tailOf(id)];
    const html = renderRoute(s, SectionPage, { name: "section", id });
    assert.deepEqual(tagTexts(html, "h2"), [`${label(id)} ${n} stories`]);
    const h3 = tagTexts(html, "h3");
    assert.equal(h3.length, 1);
    assert.equal(h3[0], `Older from the last 7 days ${tail} Not in the ranked list, newest first`);
    assert.equal(countOf(html, "data-aid="), n + TAIL_PREVIEW, "every ranked row and the first 30 of the tail");
    assert.ok(textOf(html).includes(`Show all ${tail}`));
    assert.deepEqual(a11yProblems(html), []);
  });

  it("asks for the full list and shows a note while only the front page data is loaded", () => {
    const s = createFakeServices({ loaded: "front" });
    const html = renderRoute(s, SectionPage, { name: "section", id: "industry" });
    assert.match(html, /role="status"[^>]*>Loading the full list…/);
    assert.ok(homeRows("industry") >= 5 && homeRows("industry") < total("industry"));
    assert.equal(countOf(html, "data-aid="), homeRows("industry"), "homepage rows meanwhile");
  });

  it("offers a retry when the full list failed to load (store reports restStatus: error)", () => {
    const s = createFakeServices({ loaded: "front" });
    s.stores.edition.set({ ...s.edition.get(), restStatus: "error" });
    const html = renderRoute(s, SectionPage, { name: "section", id: "industry" });
    assert.match(html, /role="alert"><p>The full list could not be loaded; these are the front-page rows of this section\.<\/p>/);
    assert.ok(tagTexts(html, "button").includes("Try again"));
    assert.ok(!html.includes("Loading the full list"));
    assert.equal(countOf(html, "data-aid="), homeRows("industry"));
  });

  it("applies the reader's time filter and says how many of the ranked stories are shown", () => {
    const s = createFakeServices({ settings: { timeFilter: "6h" } });
    const html = renderRoute(s, SectionPage, { name: "section", id: "industry" });
    const n = total("industry");
    const now = s.clock.get();
    // A story is as new as its newest article, so this is not "leads published in the last 6 hours".
    const inWindow = (edition.sections.find((x) => x.id === "industry")?.rows ?? []).filter((id) => storyPassesTimeFilter(edition, id, "6h", now, null)).length;
    assert.ok(inWindow > 1 && inWindow < n, `fixture: ${inWindow} of ${n} INDUSTRY stories are inside the 6 h window`);
    assert.equal(tagTexts(html, "h2")[0], `INDUSTRY ${inWindow} of ${n} stories`);
    assert.ok(html.includes(`aria-pressed="true" aria-label="6H ${inWindow} stories, Last 6 hours"`));
    assert.equal(countOf(html, "data-aid="), inWindow);
  });

  it("offers 'show all' when the time filter leaves nothing", () => {
    // Five days after the build nothing is inside a 6 h window.
    const s = createFakeServices({ settings: { timeFilter: "6h" }, nowMs: FIXTURE_GENERATED_MS + 5 * 24 * 3_600_000 });
    const text = textOf(renderRoute(s, SectionPage, { name: "section", id: "quantum" }));
    assert.ok(total("quantum") > 0);
    assert.ok(text.includes(`No stories in this section match the time filter. Show all ${total("quantum")}`), text.slice(-300));
  });

  it("follows the reader's section order for previous / next", () => {
    const s = createFakeServices({ settings: { sectionOrder: ["cyber", "ai_security", "policy"], hiddenSections: ["policy"] } });
    const hrefs = hrefsOf(renderRoute(s, SectionPage, { name: "section", id: "ai_security" }));
    assert.ok(hrefs.includes("#/s/cyber"));
    assert.ok(hrefs.includes("#/s/models"), "the hidden POLICY section is skipped");
    assert.ok(!hrefs.includes("#/s/policy"));
  });

  it("tells the reader when the section is muted or hidden, with a way back", () => {
    const muted = renderRoute(createFakeServices({ mutedSections: ["quantum"] }), SectionPage, { name: "section", id: "quantum" });
    assert.match(textOf(muted), /You muted this section/);
    assert.ok(tagTexts(muted, "button").includes("Unmute QUANTUM WATCH"));
    assert.equal(countOf(muted, "data-aid="), total("quantum"), "the section's own page still lists it");
    const hidden = renderRoute(createFakeServices({ settings: { hiddenSections: ["quantum"] } }), SectionPage, { name: "section", id: "quantum" });
    assert.match(textOf(hidden), /hidden from your home page\. Change it in Settings/);
    assert.ok(hrefsOf(hidden).includes("#/settings"));
  });

  it("loading and error states; renders nothing for another route", () => {
    assert.match(renderRoute(createFakeServices({ loaded: "loading" }), SectionPage, { name: "section", id: "models" }), /role="status"[^>]*>Loading headlines…/);
    const err = renderRoute(createFakeServices({ loaded: "error" }), SectionPage, { name: "section", id: "models" });
    assert.match(err, /role="alert"/);
    assert.ok(tagTexts(err, "button").includes("Try again"));
    assert.equal(renderRoute(createFakeServices(), SectionPage, { name: "home" }), "");
  });
});
