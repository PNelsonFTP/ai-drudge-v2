import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_AT, fixtureBrief, fixtureFront, fixtureHealth } from "../../../test/helpers/fixtureData";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { AboutPage } from "./AboutPage";
import { SHORTCUTS } from "./model";

describe("about page (SSR)", () => {
  const html = renderRoute(createFakeServices(), AboutPage, { name: "about" });
  const text = textOf(html);

  it("has the page heading and one section per topic", () => {
    assert.deepEqual(tagTexts(html, "h2"), ["About AI DRUDGE version 2"]);
    assert.deepEqual(tagTexts(html, "h3"), ["What this is", "How ranking works", "Legend", "Keyboard shortcuts", "Data freshness", "Privacy", "Feeds", "Version 2 compared with version 1"]);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("explains ranking in plain words: coverage is the number of publishers", () => {
    assert.match(text, /Coverage comes first\. A story’s size is the number of different publishers covering it/);
    assert.match(text, /Top Stories are the AI stories that at least two publishers covered in the last 72 hours/);
    assert.match(text, /No publisher may fill more than about 30% of a section/);
    assert.match(text, /The ranking is the same for every reader/);
  });

  it("legend: red and bold mean story size, drawn with the real headline classes, plus every badge", () => {
    assert.match(html, /<caption>Headline emphasis shows the size of the story, not the importance of the feed\.<\/caption>/);
    assert.match(html, /<th scope="row"><span class="headline-critical">Red and bold<\/span><\/th><td>A very big story: 8 or more publishers are covering it\.<\/td>/);
    for (const cls of ["headline-high", "headline-medium", "headline-low", "related-badge", "source-badge"]) assert.ok(html.includes(`class="${cls}"`), cls);
    for (const label of ["NEW", "+4", "release", "paper", "thread", "paywall"]) assert.ok(html.includes(`>${label}</span></th>`), label);
    // The four article flags are drawn as rows draw them (dotted .hl-flag chips), not as source badges.
    assert.equal(countOf(html, '<span class="hl-flag">'), 4);
    assert.equal(countOf(html, '<span class="source-badge">'), 1);
    // Seen grey and low-tier grey are told apart in words and by the real classes (upright vs italic).
    assert.match(html, /<th scope="row"><span class="headline-low">Grey italic<\/span><\/th><td>An item from a low-tier source/);
    assert.match(html, /<th scope="row"><span class="headline-seen">Grey<\/span><\/th><td>Grey, regular weight and upright: you already saw the headline/);
    assert.match(text, /never the lead story, TOP STORIES or your saved lists\./);
    // The settings store holds the switch (Settings.dimSeen), so the legend points at it.
    assert.match(text, /or your saved lists\. Turn dimming off in Settings/);
  });

  it("keyboard shortcuts table lists every shortcut with <kbd> keys", () => {
    assert.match(html, /<caption>Shortcuts work everywhere except while typing in a text box\. Turn them off in Settings\.<\/caption>/);
    assert.equal(countOf(html, "<kbd"), SHORTCUTS.reduce((n, s) => n + s.keys.length, 0));
    assert.match(html, /<kbd class="sp-kbd">j<\/kbd><\/span><span> \/ <kbd class="sp-kbd">k<\/kbd>/);
    assert.match(html, /<kbd class="sp-kbd">g<\/kbd><\/span><span> then <kbd class="sp-kbd">w<\/kbd>/);
    for (const s of SHORTCUTS) assert.ok(text.includes(s.action), s.action);
  });

  it("data freshness: edition time, age, build id, counts and the refresh cadence", () => {
    // "2026-11-20T03:34:11.846Z" is printed as "2026-11-20 03:34 UTC"; the fake clock is 20 minutes after the build.
    const stamp = `${FIXTURE_GENERATED_AT.slice(0, 10)} ${FIXTURE_GENERATED_AT.slice(11, 16)} UTC (20m ago)`;
    assert.ok(html.toLowerCase().includes(`<time datetime="${FIXTURE_GENERATED_AT.toLowerCase()}">${stamp.toLowerCase()}</time>`), stamp);
    assert.ok(html.includes(`<code class="sp-code">${FIXTURE_GENERATED_AT}</code>`));
    const [ok, all] = [fixtureHealth.feeds.filter((f) => f.ok).length, fixtureHealth.feeds.length];
    assert.ok(ok < all, "fixture: a few sources did not answer");
    assert.ok(text.includes(`${fixtureFront.counts.stories} stories from ${ok} of ${all} sources that answered`), text.slice(text.indexOf("Data freshness"), text.indexOf("Data freshness") + 400));
    assert.match(text, /built about every 30 minutes/);
    assert.match(text, /A build runs about every 30 minutes, reads/, "one cadence on the whole page");
    assert.ok(!/once an hour|hourly/.test(text));
    assert.match(text, /checks for a newer edition every 10 minutes/);
    assert.match(text, /more than 2 hours old/);
    assert.ok(!text.includes("may be failing"), "fresh data is not flagged");
  });

  it("is explicit about AI-generated text (audit trail)", () => {
    assert.equal(fixtureBrief.source, "fallback");
    // The fixture is a build without an API key, and says so; an edition without a reason code says nothing more.
    assert.equal(fixtureBrief.fallbackReason, "no-key");
    assert.match(text, /This edition has no AI-written brief: the build has no key for the AI service, so no model was asked\. Apart from that optional, labelled box, no text on this site is AI-generated/);
    const plain = textOf(renderRoute(createFakeServices({ brief: { ...fixtureBrief, fallbackReason: undefined } }), AboutPage, { name: "about" }));
    assert.match(plain, /This edition has no AI-written brief\. Apart from that optional, labelled box, no text on this site is AI-generated/);
    const why = textOf(renderRoute(createFakeServices({ brief: { ...fixtureBrief, source: "fallback", fallbackReason: "no-key" } }), AboutPage, { name: "about" }));
    assert.match(why, /This edition has no AI-written brief: the build has no key for the AI service, so no model was asked\. Apart from that optional, labelled box/);
    const withBrief = textOf(renderRoute(createFakeServices({ brief: { ...fixtureBrief, source: "claude", model: "claude-test-model" } }), AboutPage, { name: "about" }));
    assert.match(withBrief, /The Daily Brief box of this edition was written by an AI model \(claude-test-model\)/);
  });

  it("privacy: local to the browser, no analytics", () => {
    assert.match(text, /No accounts, no cookies, no analytics, no trackers, no advertising\./);
    assert.match(text, /kept in this browser’s local storage and are never sent anywhere/);
    assert.match(text, /Watch terms in particular never leave the browser/);
  });

  it("links to the Atom feed, the OPML file, Sources and Settings", () => {
    const hrefs = hrefsOf(html);
    for (const h of ["/ai-drudge-v2/feed.xml", "/ai-drudge-v2/feeds.opml", "#/sources", "#/settings"]) assert.ok(hrefs.includes(h), h);
    const other = hrefsOf(renderRoute(createFakeServices({ baseUrl: "/" }), AboutPage, { name: "about" }));
    assert.ok(other.includes("/feed.xml") && other.includes("/feeds.opml"), "links follow the site base");
  });

  it("V2 vs V1 note", () => {
    assert.match(text, /15 sections instead of 18/);
    assert.match(text, /imported once, read-only/);
  });

  it("flags stale data and survives a missing edition", () => {
    const s = createFakeServices();
    s.setNow(s.clock.get() + 8 * 3_600_000);
    assert.match(textOf(renderRoute(s, AboutPage, { name: "about" })), /The data is more than 2 hours old; the scheduled build may be failing\./);
    // With status.json loaded (90 minutes) the page says what the shell's banner does.
    const ninety = createFakeServices({ staleAfterMinutes: 90 });
    ninety.setNow(ninety.clock.get() + 80 * 60_000); // 100 minutes after the edition
    const text90 = textOf(renderRoute(ninety, AboutPage, { name: "about" }));
    assert.match(text90, /The data is more than 90 minutes old; the scheduled build may be failing\./);
    assert.match(text90, /A warning appears when the data is more than 90 minutes old\./);
    const loading = renderRoute(createFakeServices({ loaded: "loading" }), AboutPage, { name: "about" });
    assert.match(textOf(loading), /No edition is loaded yet\./);
    assert.deepEqual(a11yProblems(loading), []);
  });
});
