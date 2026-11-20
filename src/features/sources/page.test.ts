import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { sectionById } from "../../../shared/sections";
import { fixtureHealth, fixtureHealthRow, fixtureSource, fixtureSourceInfo, fixtureSources } from "../../../test/helpers/fixtureData";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { SourcesPage } from "./SourcesPage";

// The fixture is a frozen live build (replaced by `npm run fixture:refresh`): its numbers are read
// from its own health.json / sources.json, never pinned.
const TOTAL = fixtureSources.sources.length;
const ACTIVE = fixtureHealth.feeds.length;
const count = (status: string): number => fixtureHealth.feeds.filter((f) => f.status === status).length;
const PAUSED = fixtureSources.sources.filter((x) => x.paused).length;
/** The "N/M OK · ..." line of the fixture (it has every state: fixtures.test.ts). */
const SUMMARY = `${count("ok")}/${ACTIVE} OK · ${count("carried")} carried forward · ${count("failing")} failing · ${count("quarantined")} quarantined · ${PAUSED} paused`;
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("sources page (SSR)", () => {
  it("before the data arrives: loading note and the OPML link", () => {
    const html = renderRoute(createFakeServices(), SourcesPage, { name: "sources" });
    assert.deepEqual(tagTexts(html, "h2"), ["Sources"]);
    assert.match(html, /role="status"[^>]*>Loading the source list…/);
    assert.ok(hrefsOf(html).includes("/ai-drudge-v2/feeds.opml"));
    assert.deepEqual(a11yProblems(html), []);
  });

  it("lists every source with its health in a real table, with the N/M OK summary", async () => {
    const s = createFakeServices();
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.deepEqual(tagTexts(html, "h2"), [`Sources ${SUMMARY}`]);
    assert.equal(countOf(html, "<tr>"), fixtureSources.sources.length + 1, "one row per source plus the header");
    assert.deepEqual(tagTexts(html, "thead").map((t) => t), ["Source Publisher Section Tier Scope Kind Status Fail streak Last OK Items Feed Mute"]);
    assert.equal(countOf(html, '<th scope="col">'), 12);
    assert.equal(countOf(html, '<th scope="row">'), fixtureSources.sources.length);
    assert.ok(html.includes(`<caption>${SUMMARY}. Muting a source hides its stories everywhere on this site, in this browser only.</caption>`));
    assert.ok(textOf(html).includes(`Showing ${TOTAL} of ${TOTAL} sources.`));
    assert.match(html, /role="region" aria-label="Source table" tabindex="0"/i);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("links: homepage or feed for every source, section pages, OPML and the Atom feed", async () => {
    const s = createFakeServices();
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    const hrefs = new Set(hrefsOf(html));
    assert.ok(hrefs.has("/ai-drudge-v2/feeds.opml") && hrefs.has("/ai-drudge-v2/feed.xml"));
    assert.ok(hrefs.has("#/s/models") && hrefs.has("#/s/releases"));
    for (const src of fixtureSources.sources) {
      assert.ok((src.feedUrl && hrefs.has(src.feedUrl)) || (src.homepage && hrefs.has(src.homepage)), `${src.id} has a tracked link on the page`);
    }
    const withFeed = fixtureSources.sources.find((x) => x.feedUrl && x.homepage);
    assert.ok(withFeed?.feedUrl && withFeed.homepage && hrefs.has(withFeed.feedUrl) && hrefs.has(withFeed.homepage), "a source with both links shows both");
    assert.equal(countOf(html, 'target="_blank" rel="noopener noreferrer"'), [...html.matchAll(/<a href="https?:/g)].length, "every outbound link is noopener noreferrer");
  });

  it("filters are labelled controls: section, status, text", async () => {
    const s = createFakeServices();
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.match(html, /<form class="sp-bar" role="search" aria-label="Filter sources">/);
    for (const label of ["Section", "Status", "Find"]) assert.match(html, new RegExp(`<label for="([^"]+)">${label}</label><(select|input) id="\\1"`));
    const options = tagTexts(html, "option");
    const inModels = fixtureSources.sources.filter((x) => x.home === "models").length;
    const expected = [
      `All sections (${TOTAL})`,
      `${sectionById("models").label} (${inModels})`,
      `Not OK (${ACTIVE - count("ok")})`,
      `OK (${count("ok")})`,
      `Carried (${count("carried")})`,
      `Failing (${count("failing")})`,
      `Quarantined (${count("quarantined")})`,
      `Paused (${PAUSED})`,
      "No data (0)",
      "Muted by you (0)",
    ];
    for (const option of expected) assert.ok(options.includes(option), `${option} is not among: ${options.join(" | ")}`);
    assert.ok(count("carried") > 0 && count("failing") > 0 && count("quarantined") > 0 && PAUSED > 0, "fixture: every state has a source");
    assert.ok(tagTexts(html, "button").includes("Reset"));
  });

  it("status is text, not colour alone; failing sources show the reason; every source has a mute toggle", async () => {
    const mutedSource = fixtureSourceInfo(fixtureSource("ok"));
    const s = createFakeServices({ mutedSources: [mutedSource.id] });
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.equal(countOf(html, '<span class="sp-ok" title="Fetched and parsed with at least one item in the last build.">OK</span>'), count("ok"));
    assert.equal(countOf(html, ">Failing</span>"), count("failing"));
    assert.equal(countOf(html, '<span class="sp-strong" title="The last fetch failed, or its host was failing and was not asked again; items from the last good fetch (up to 6 hours old) are shown.">Carried</span>'), count("carried"));
    assert.equal(countOf(html, ">Quarantined</span>"), count("quarantined"));
    // Every source that is not ok shows why, in words (the reason the build recorded).
    const notOk = fixtureHealth.feeds.filter((f) => !f.ok);
    assert.ok(notOk.length >= 4);
    for (const f of notOk) assert.ok(f.lastError && html.includes(`<span class="sp-sub">${escapeHtml(f.lastError)}</span>`), `${f.id}: ${f.lastError}`);
    assert.match(fixtureHealthRow(fixtureSource("hostBackoff")).lastError ?? "", /^host backoff: /);
    assert.equal(countOf(html, 'aria-pressed="false" aria-label="Mute '), TOTAL - 1);
    assert.ok(html.includes(`<button type="button" class="sp-btn" aria-pressed="true" aria-label="Unmute ${escapeHtml(mutedSource.name)}">Muted</button>`));
    assert.match(html, /<span class="sp-sub">muted by you<\/span>/);
    assert.ok(tagTexts(html, "option").includes("Muted by you (1)"));
  });

  it("a carried source keeps its item count and last-OK time; a failing one shows 0 items; a paused one has no health", async () => {
    const s = createFakeServices();
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    /** The <tr> of a source, by the accessible name of its mute button. */
    const rowOf = (id: string): string => {
      const name = escapeHtml(fixtureSourceInfo(id).name);
      const tr = html.split("<tr>").find((r) => r.includes(`aria-label="Mute ${name}"`));
      assert.ok(tr, `no row for ${id}`);
      return tr;
    };
    const cells = (tr: string): string[] => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => textOf(m[1]));
    // Columns: Source Publisher Section Tier Scope Kind Status Fail streak Last OK Items Feed Mute.
    const carried = fixtureHealthRow(fixtureSource("carried"));
    const carriedCells = cells(rowOf(carried.id));
    assert.ok(carriedCells[6].startsWith("Carried"));
    assert.deepEqual([carriedCells[7], carriedCells[9]], [String(carried.failStreak), String(carried.count)]);
    assert.match(carriedCells[8], /ago$/);

    const failing = fixtureHealthRow(fixtureSource("failing"));
    const failingCells = cells(rowOf(failing.id));
    assert.ok(failingCells[6].startsWith("Failing"));
    assert.deepEqual([failingCells[7], failingCells[9]], [String(failing.failStreak), "0"]);

    const quarantined = fixtureHealthRow(fixtureSource("quarantined"));
    assert.deepEqual([cells(rowOf(quarantined.id))[7], cells(rowOf(quarantined.id))[9]], [String(quarantined.failStreak), "0"]);

    const pausedCells = cells(rowOf(fixtureSource("paused")));
    assert.deepEqual([pausedCells[6], pausedCells[7], pausedCells[8], pausedCells[9]], ["Paused", "0", "never", "0"]);

    const okCells = cells(rowOf(fixtureSource("ok")));
    assert.deepEqual([okCells[6], okCells[7]], ["OK", "0"]);
  });

  it("explains every status, scope and tier under the table", async () => {
    const s = createFakeServices();
    await s.sourcesData.load();
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.deepEqual(tagTexts(html, "dt"), ["OK", "Carried", "Failing", "Quarantined", "Paused", "No data", "Scope", "Tier"]);
    assert.match(textOf(html), /quarantined after 48 failed builds/);
  });

  it("error state offers a retry", () => {
    const s = createFakeServices();
    s.stores.sourcesData.set({ status: "error", sources: null, health: null, error: "HTTP 503" });
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.match(html, /role="alert"/);
    assert.match(textOf(html), /The source list could not be loaded: HTTP 503/);
    assert.ok(tagTexts(html, "button").includes("Try again"));
  });

  it("without health data every source is still listed", () => {
    const s = createFakeServices();
    s.stores.sourcesData.set({ status: "ready", sources: fixtureSources, health: null });
    const html = renderRoute(s, SourcesPage, { name: "sources" });
    assert.equal(countOf(html, '<th scope="row">'), fixtureSources.sources.length);
    assert.match(textOf(html), /Health data is not available for this build/);
  });
});
