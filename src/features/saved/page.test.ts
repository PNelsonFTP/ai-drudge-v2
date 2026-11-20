import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeServices, type FakeServices } from "../../../test/helpers/fakeServices";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { SavedPage } from "./SavedPage";

/** One live bookmark, one that left the edition (snapshot only), one id with no data, one read-later item. */
function arrange(s: FakeServices): { liveTitle: string; laterTitle: string } {
  const e = s.edition.get().edition!;
  const [a, b] = e.top.map((id) => e.articles[id]);
  s.saved.toggleBookmark(a, "The Guardian AI");
  s.saved.toggleLater(b, "Some Source");
  s.stores.saved.update((st) => ({
    ...st,
    bookmarks: new Set([...st.bookmarks, "gone01", "phantom"]),
    snapshots: {
      ...st.snapshots,
      gone01: { id: "gone01", title: "A story that left the edition", url: "https://example.com/gone", sourceName: "Old Outlet", publishedAt: "2026-11-01T10:00:00.000Z", savedAt: "2026-11-02T10:00:00.000Z" },
    },
  }));
  return { liveTitle: a.title, laterTitle: b.title };
}

describe("saved pages (SSR)", () => {
  it("bookmarks: heading, tab links, actions and rows from the edition and from snapshots", () => {
    const s = createFakeServices({ route: { name: "saved", tab: "bookmarks" } });
    const { liveTitle } = arrange(s);
    const html = renderRoute(s, SavedPage, { name: "saved", tab: "bookmarks" });
    assert.deepEqual(tagTexts(html, "h2"), ["Bookmarks 3 items"]);
    assert.match(html, /<nav class="sp-chips" aria-label="Saved lists"><a href="#\/saved" class="sp-chip" aria-current="page">Bookmarks \(3\)<\/a><a href="#\/later" class="sp-chip">Read later \(1\)<\/a><\/nav>/);
    const buttons = tagTexts(html, "button");
    assert.ok(buttons.includes("Copy all as Markdown") && buttons.includes("Remove all"));
    assert.equal(countOf(html, "data-aid="), 2, "the id without data has no headline row");
    const text = textOf(html);
    assert.ok(text.includes(liveTitle));
    assert.match(text, /A story that left the edition saved \w+ \d+ · no longer in the current edition/);
    assert.ok(hrefsOf(html).includes("https://example.com/gone"), "the snapshot still links to the article");
    assert.match(text, /Saved in this browser only — download a backup in Settings/);
    assert.ok(hrefsOf(html).includes("#/settings"));
    assert.deepEqual(a11yProblems(html), []);
  });

  it("ids without any data are shown as removable placeholders", () => {
    const s = createFakeServices();
    arrange(s);
    const html = renderRoute(s, SavedPage, { name: "saved", tab: "bookmarks" });
    assert.match(textOf(html), /A saved item is no longer available \(id phantom \)\. Remove/);
    assert.match(html, /aria-label="Remove unavailable item phantom"/);
  });

  it("read later: its own heading, list and explanation", () => {
    const s = createFakeServices();
    const { laterTitle } = arrange(s);
    const html = renderRoute(s, SavedPage, { name: "saved", tab: "later" });
    assert.deepEqual(tagTexts(html, "h2"), ["Read later 1 item"]);
    assert.match(html, /<a href="#\/later" class="sp-chip" aria-current="page">Read later \(1\)<\/a>/);
    assert.equal(countOf(html, "data-aid="), 1);
    assert.ok(textOf(html).includes(laterTitle));
    assert.match(textOf(html), /opening a story removes it from this list/);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("empty lists say how to fill them; the actions are disabled, not hidden", () => {
    const html = renderRoute(createFakeServices(), SavedPage, { name: "saved", tab: "bookmarks" });
    assert.deepEqual(tagTexts(html, "h2"), ["Bookmarks 0 items"]);
    assert.match(textOf(html), /No bookmarks yet\. Use the bookmark action on any headline \(keyboard: b\)/);
    assert.equal(countOf(html, 'aria-disabled="true"'), 2);
    const later = renderRoute(createFakeServices(), SavedPage, { name: "saved", tab: "later" });
    assert.match(textOf(later), /Nothing queued\./);
  });

  it("works without an edition: snapshots are enough", () => {
    const s = createFakeServices();
    arrange(s);
    s.stores.edition.set({ ...s.edition.get(), status: "error", edition: null, error: "offline" });
    const html = renderRoute(s, SavedPage, { name: "saved", tab: "bookmarks" });
    assert.equal(countOf(html, "data-aid="), 2, "both snapshots render; the phantom stays a placeholder");
    assert.ok(hrefsOf(html).includes("https://example.com/gone"));
  });

  it("has a real dialog for 'remove all'", () => {
    const html = renderRoute(createFakeServices(), SavedPage, { name: "saved", tab: "bookmarks" });
    assert.equal(countOf(html, "<dialog"), 1);
    assert.match(html, /<dialog class="sp-dialog"><\/dialog>/, "closed: no content and no dangling aria reference");
  });
});
