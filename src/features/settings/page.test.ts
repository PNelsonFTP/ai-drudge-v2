import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS } from "../../../shared/sections";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { sectionPresetById } from "../../app/presets";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { applyPreset } from "./model";
import { SettingsPage } from "./SettingsPage";

describe("settings page (SSR)", () => {
  it("has one heading per area, in a sensible order", () => {
    const html = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.deepEqual(tagTexts(html, "h2"), ["Settings stored in this browser only"]);
    assert.deepEqual(
      tagTexts(html, "h3").map((t) => t.replace(/ (Layout: .*|\d+)$/, "")),
      ["Appearance", "Home page sections", "Watchlist", "Muted sources and sections", "Backup and restore", "Import from V1", "Reset"],
    );
    assert.deepEqual(a11yProblems(html), []);
  });

  it("theme and density are labelled radio groups reflecting the current settings", () => {
    const html = renderRoute(createFakeServices({ settings: { theme: "system", density: "comfortable" } }), SettingsPage, { name: "settings" });
    assert.match(html, /<fieldset class="sp-checks"><legend class="sp-label">Theme<\/legend>/);
    assert.match(html, /<fieldset class="sp-checks"><legend class="sp-label">Density<\/legend>/);
    assert.equal(countOf(html, 'type="radio" name="sp-theme"'), 3);
    assert.equal(countOf(html, 'type="radio" name="sp-density"'), 2);
    assert.match(html, /<input type="radio" name="sp-theme" checked="" value="system"\/><span>Match the system<\/span>/);
    assert.match(html, /<input type="radio" name="sp-density" checked="" value="comfortable"\/>/);
    assert.equal(countOf(html, 'checked="" value='), 2, "exactly one checked radio per group");
  });

  it("single-key keyboard shortcuts have an off switch (WCAG 2.1.4), on by default", () => {
    const on = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.match(on, /<legend class="sp-label">Keyboard<\/legend><label class="sp-check"><input type="checkbox" checked=""\/><span>Single-key keyboard shortcuts \(j, k, b, m, \/, \? \.\.\.\)<\/span><\/label>/);
    const off = renderRoute(createFakeServices({ settings: { shortcuts: false } }), SettingsPage, { name: "settings" });
    assert.match(off, /<legend class="sp-label">Keyboard<\/legend><label class="sp-check"><input type="checkbox"\/><span>Single-key keyboard shortcuts/);
  });

  it("'Dim headlines I have seen' is a switch, on by default", () => {
    const label = /<legend class="sp-label">Headlines<\/legend><label class="sp-check"><input type="checkbox"( checked="")?\/><span>Dim headlines I have seen<\/span><\/label>/;
    const on = renderRoute(createFakeServices({ settings: { dimSeen: true } }), SettingsPage, { name: "settings" });
    assert.equal(label.exec(on)?.[1], ' checked=""');
    assert.match(textOf(on), /The lead story, TOP STORIES and your saved lists are never dimmed\. When off, grey \(in italic\) only marks a low-tier source\./);
    const off = renderRoute(createFakeServices({ settings: { dimSeen: false } }), SettingsPage, { name: "settings" });
    assert.ok(label.test(off));
    assert.equal(label.exec(off)?.[1], undefined);
    // The default (a reader who never touched the switch): on.
    const byDefault = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.equal(label.exec(byDefault)?.[1], ' checked=""');
    assert.deepEqual(a11yProblems(on), []);
  });

  it("section order: all sections with keyboard-operable up / down / pin buttons and a show checkbox", () => {
    const html = renderRoute(createFakeServices({ settings: { hiddenSections: ["quantum"] } }), SettingsPage, { name: "settings" });
    assert.match(html, /<ol class="sp-order" aria-label="Sections in home page order">/);
    assert.equal(countOf(html, '<li class="sp-order-row'), SECTIONS.length);
    for (const def of SECTIONS) {
      const label = def.label.replace(/&/g, "&amp;");
      for (const action of [`Move ${label} up`, `Move ${label} down`, `Pin ${label} to the top`, `Show ${label} on the home page`]) {
        assert.ok(html.includes(`aria-label="${action}"`), action);
      }
    }
    // The first row cannot move up, the last cannot move down - disabled for assistive tech but still focusable.
    assert.match(html, /aria-label="Move MODELS &amp; LABS up" aria-disabled="true"/);
    assert.match(html, /aria-label="Move MODELS &amp; LABS down" aria-disabled="false"/);
    assert.match(html, /aria-label="Move RELEASE RADAR down" aria-disabled="true"/);
    assert.equal(countOf(html, "<button disabled"), 0);
    const shows = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]).filter((tag) => /aria-label="Show [^"]+ on the home page"/.test(tag));
    assert.equal(shows.length, SECTIONS.length);
    assert.equal(shows.filter((tag) => tag.includes('checked=""')).length, SECTIONS.length - 1, "the hidden section is unchecked");
    assert.match(html, /<input type="checkbox" aria-label="Show QUANTUM WATCH on the home page"\/>/);
    assert.match(html, /<li class="sp-order-row sp-order-hidden">.*?QUANTUM WATCH<\/a><span class="sp-sub"> hidden<\/span>/);
    assert.ok(hrefsOf(html).includes("#/s/quantum"));
  });

  it("presets: Default / CISO / Local lab / Markets, with the active one pressed", () => {
    const def = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.match(def, /role="group" aria-label="Section layout presets"/);
    for (const [label, pressed] of [["Default", true], ["CISO", false], ["Local lab", false], ["Markets", false]] as const) {
      assert.ok(def.includes(`<button type="button" class="sp-btn" aria-pressed="${pressed}">${label}</button>`), label);
    }
    assert.ok(tagTexts(def, "h3").includes("Home page sections Layout: Default"));

    const ciso = renderRoute(createFakeServices({ settings: applyPreset(sectionPresetById("ciso")!) }), SettingsPage, { name: "settings" });
    assert.ok(ciso.includes('<button type="button" class="sp-btn" aria-pressed="true">CISO</button>'));
    assert.ok(tagTexts(ciso, "h3").includes("Home page sections Layout: CISO"));
    assert.match(ciso, /<ol class="sp-order"[^>]*><li class="sp-order-row"><span class="sp-order-pos" aria-hidden="true">1<\/span><span class="sp-order-name"><a href="#\/s\/ai_security">AI SECURITY<\/a>/);

    const custom = renderRoute(createFakeServices({ settings: { sectionOrder: ["cyber"] } }), SettingsPage, { name: "settings" });
    assert.ok(tagTexts(custom, "h3").includes("Home page sections Layout: custom"));
    assert.equal(countOf(custom, 'aria-pressed="true">'), 0);
  });

  it("watchlist editor with presets and the matching rules", () => {
    const html = renderRoute(createFakeServices({ watchTerms: ["Qwen"] }), SettingsPage, { name: "settings" });
    assert.match(html, /<label for="([^"]+)">Add a watch term<\/label><input id="\1"/);
    assert.match(html, /aria-label="Remove watch term Qwen"/);
    assert.ok(tagTexts(html, "button").includes("Add CISO (12)"));
    assert.ok(tagTexts(html, "summary").includes("How watch terms match"));
    assert.match(textOf(html), /Whole words only\./);
  });

  it("mutes manager lists muted sections and sources by name, each with a restore button", () => {
    // A source of the fixture edition (shown by its name) and an id no file knows (shown as the id).
    const edition = createFakeServices().edition.get().edition!;
    const [id, ref] = Object.entries(edition.sources).find(([sid, r]) => r.name !== sid && !/[&<>"']/.test(r.name))!;
    const s = createFakeServices({ mutedSources: [id, "left-the-registry"], mutedSections: ["quantum"] });
    const html = renderRoute(s, SettingsPage, { name: "settings" });
    assert.ok(tagTexts(html, "h3").includes("Muted sources and sections 3"));
    for (const label of ["Unmute section QUANTUM WATCH", `Unmute source ${ref.name}`, "Unmute source left-the-registry"]) {
      assert.ok(html.includes(`aria-label="${label}"`), label);
    }
    assert.ok(tagTexts(html, "button").includes("Unmute everything"));
    assert.ok(hrefsOf(html).includes("#/sources"));
    const none = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.match(textOf(none), /Nothing is muted\./);

    const pending = createFakeServices({ pendingMuteNames: ["Old Feed Name"] });
    const pendingHtml = renderRoute(pending, SettingsPage, { name: "settings" });
    assert.match(textOf(pendingHtml), /1 source name muted in the previous version could not be matched to a current source yet and will apply once matched: V1 name Old Feed Name Forget/);
    assert.ok(pendingHtml.includes('aria-label="Forget the muted V1 source name Old Feed Name"'));
    pending.mutes.dropPendingName("Old Feed Name");
    assert.deepEqual(pending.mutes.get().pendingNames, []);
  });

  it("backup and restore: download button and a labelled file input for the dry-run import", () => {
    const html = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.ok(tagTexts(html, "button").includes("Download backup (JSON)"));
    assert.match(html, /<label for="([^"]+)">Restore from a backup file<\/label><input id="\1" class="sp-input" type="file" accept="application\/json,\.json"\/>/);
    assert.match(textOf(html), /live only in this browser/);
  });

  it("V1 import status and reset actions (confirmed in real dialogs)", () => {
    const html = renderRoute(createFakeServices(), SettingsPage, { name: "settings" });
    assert.match(textOf(html), /Import from V1 No reader state from the previous version \(V1\) was found in this browser, so there was nothing to import\. The import is read-only/);
    const imported = createFakeServices({
      migration: { status: "already", at: "2026-11-19T20:30:00.000Z", imported: { bookmarks: 2, later: 0, snapshots: 2, mutedSources: 1, pendingSourceNames: 0, mutedSections: 0, seen: 40, theme: false, lastVisit: true } },
    });
    assert.match(textOf(renderRoute(imported, SettingsPage, { name: "settings" })), /was imported on 2026-11-19: 2 bookmarks, 1 muted source, 40 seen stories, the last-visit time\./);
    const buttons = tagTexts(html, "button");
    assert.ok(buttons.includes("Import from V1 again"));
    // "Erase all reader data" is true to its name: the read history and the last-visit time go too
    // (ReadStateStore.clear / LastVisitStore.clear).
    assert.ok(buttons.includes("Reset settings") && buttons.includes("Erase all reader data"));
    // remove-all-terms, unmute-everything, reset-settings, erase-everything
    assert.equal(countOf(html, "<dialog"), 4);
    assert.equal(countOf(html, "<dialog open"), 0);
  });
});
