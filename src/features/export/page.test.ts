import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { publisherName, visibleStory } from "../../../shared/select";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_AT, fixtureEdition, fixtureStory } from "../../../test/helpers/fixtureData";
import { BRIEFING_TOP_LIMIT } from "./briefing";
import { BriefingExportButton, BriefingPanel } from "./BriefingExportButton";
import { escapeMarkdown, markdownLink } from "./kit/markdown";
import { countOf, renderWith, tagTexts, textOf } from "./kit/ssr.testkit";

const panel = (s: ReturnType<typeof createFakeServices>): string => renderWith(s, createElement(BriefingPanel));

// The fixture is a frozen live build (replaced by `npm run fixture:refresh`): what the briefing
// must say is read from it, never pinned.
const edition = fixtureEdition();
const lead = edition.articles[fixtureStory("multiPublisherLead")];
/** Top stories a briefing lists. */
const TOP = Math.min(BRIEFING_TOP_LIMIT, edition.top.length);
/** "2026-11-20 03:34 UTC" for the fixture's generatedAt. */
const STAMP = `${FIXTURE_GENERATED_AT.slice(0, 10)} ${FIXTURE_GENERATED_AT.slice(11, 16)} UTC`;

describe("briefing export (SSR)", () => {
  it("the button is a real button that announces its dialog; the dialog is closed and empty", () => {
    const html = renderWith(createFakeServices(), createElement(BriefingExportButton));
    assert.match(html, /^<button type="button" class="tool-btn sp-trigger" aria-haspopup="dialog" title="[^"]+">Briefing<\/button><dialog class="sp-dialog sp-dialog-wide"><\/dialog>$/);
  });

  it("class and label can be set by the host page", () => {
    const html = renderWith(createFakeServices(), createElement(BriefingExportButton, { className: "sp-btn", label: "Export briefing" }));
    assert.match(html, /<button type="button" class="sp-btn sp-trigger"[^>]*>Export briefing<\/button>/);
  });

  it("panel: labelled Markdown preview, the three sections as checkboxes and the three actions", () => {
    const html = panel(createFakeServices());
    assert.match(html, /<label class="sp-label" for="sp-briefing-preview">Preview \(Markdown\)<\/label><textarea id="sp-briefing-preview"[^>]*readOnly=""/i);
    assert.match(html, /<fieldset class="sp-checks"><legend class="sp-label">Include<\/legend>/);
    assert.equal(countOf(html, 'type="checkbox" checked=""'), 3);
    const text = textOf(html);
    assert.ok(text.includes(`Top stories (${TOP})`));
    assert.match(text, /Watchlist hits, last 24 h \(0\)/);
    assert.match(text, /Bookmarked today \(0\)/);
    assert.deepEqual(tagTexts(html, "button"), ["Copy Markdown", "Copy plain text", "Download .md"]);
    assert.equal(countOf(html, '<button type="button"'), 3);
    assert.ok(html.includes(`role="status" aria-live="polite">${TOP} top stories, 0 watchlist hits, 0 bookmarks.<`));
  });

  it("the preview holds the briefing in the documented Markdown shape", () => {
    const html = panel(createFakeServices());
    const preview = textOf(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "");
    const first = `1. **${markdownLink(lead.title, lead.url)}** — ${escapeMarkdown(publisherName(edition, lead))} (${edition.clusters[lead.id].publishers} outlets) Also: [`;
    assert.ok(preview.startsWith(`# AI DRUDGE briefing — ${STAMP} ## Top stories ${first}`), preview.slice(0, 300));
    assert.match(preview, /this briefing contains no AI-generated text\.$/);
  });

  it("says why there are no watchlist hits when the watchlist is empty", () => {
    assert.match(textOf(panel(createFakeServices())), /Your watchlist is empty, so there are no watchlist hits\./);
  });

  it("with watch terms: waits for the river, then counts the hits", async () => {
    // "AI" is in the headlines of any day of an AI news site.
    const s = createFakeServices({ watchTerms: ["AI"] });
    assert.match(textOf(panel(s)), /Loading the 7-day archive for watchlist hits…/);
    await s.edition.loadRiver();
    const text = textOf(panel(s));
    const hits = Number(/Watchlist hits, last 24 h \((\d+)\)/.exec(text)?.[1]);
    assert.ok(hits > 0, text.slice(0, 300));
    assert.match(text, /## Watchlist hits \(last 24 h\)/);
    assert.ok(!text.includes("Loading the 7-day archive"));
  });

  it("includes stories bookmarked today", () => {
    const s = createFakeServices();
    const e = s.edition.get().edition!;
    const a = e.articles[e.sections[2].rows[0]];
    s.saved.toggleBookmark(a, "Some Source");
    const text = textOf(panel(s));
    assert.match(text, /Bookmarked today \(1\)/);
    assert.ok(text.includes("## Bookmarked today"));
  });

  it("respects muted sources", () => {
    // Muting the source of the lead: the story stays (other outlets cover it) and another outlet's article is exported.
    const before = textOf(panel(createFakeServices()));
    assert.ok(before.includes(markdownLink(lead.title, lead.url)));
    const s = createFakeServices({ mutedSources: [lead.src] });
    const after = textOf(panel(s));
    const fromMuted = Object.values(edition.articles).filter((a) => a.src === lead.src);
    assert.ok(fromMuted.length > 0);
    for (const a of fromMuted) assert.ok(!after.includes(`](${a.url})`), `${a.url} is still exported`);
    const relead = visibleStory(edition, lead.id, { sources: new Set([lead.src]), sections: new Set() });
    assert.ok(relead && relead.lead.id !== lead.id, "fixture: another outlet can lead the story");
    assert.ok(after.includes(`1. **${markdownLink(relead.lead.title, relead.lead.url)}**`), after.slice(0, 300));
  });

  it("without an edition it explains instead of exporting nothing", () => {
    const html = panel(createFakeServices({ loaded: "loading" }));
    assert.match(html, /role="status"[^>]*>Headlines are still loading\./);
    assert.equal(countOf(html, "<textarea"), 0);
  });
});
