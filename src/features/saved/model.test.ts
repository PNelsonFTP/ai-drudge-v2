import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleV2 } from "../../../shared/contract";
import { hoursAgo, makeArticle, makeEdition, makeSourceRef } from "../../../test/helpers/factories";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import type { SavedSnapshot, SavedState } from "../../app/services";
import { articleForRestore, buildSavedList, removedEntries, savedMarkdown, savedTitle } from "./model";

const snap = (a: ArticleV2, savedAt: string, over: Partial<SavedSnapshot> = {}): SavedSnapshot => ({
  id: a.id,
  title: a.title,
  url: a.url,
  sourceName: "Snapshot Source",
  publishedAt: a.publishedAt,
  savedAt,
  ...over,
});

function world() {
  const live = makeArticle({ title: "Live title (current)", src: "verge", publishedAt: hoursAgo(5) });
  const liveNoSnap = makeArticle({ title: "Live, saved before snapshots existed", src: "verge", publishedAt: hoursAgo(9) });
  const gone = makeArticle({ title: "Left the edition", url: "https://example.com/gone", publishedAt: hoursAgo(200) });
  const goneOlder = makeArticle({ title: "Left the edition earlier", url: "https://example.com/gone-older", publishedAt: hoursAgo(300) });
  const badUrl = makeArticle({ title: "Tampered snapshot", url: "https://example.com/tampered" });
  const later = makeArticle({ title: "Queued for later", src: "verge", publishedAt: hoursAgo(2) });
  const { edition } = makeEdition({
    articles: [live, liveNoSnap, later],
    rows: { industry: [live.id, liveNoSnap.id, later.id] },
    sources: { verge: makeSourceRef({ name: "The Verge AI", publisher: "The Verge" }) },
  });
  const state: SavedState = {
    bookmarks: new Set([goneOlder.id, live.id, "phantom", gone.id, liveNoSnap.id, badUrl.id]),
    later: new Set([later.id, gone.id]),
    snapshots: {
      [live.id]: snap(live, hoursAgo(3), { title: "Stale snapshot title" }),
      [gone.id]: snap(gone, hoursAgo(1)),
      [goneOlder.id]: snap(goneOlder, hoursAgo(48)),
      [badUrl.id]: snap(badUrl, hoursAgo(2), { url: "javascript:alert(1)" }),
      [later.id]: snap(later, hoursAgo(4)),
    },
  };
  return { edition, state, live, liveNoSnap, gone, goneOlder, badUrl, later };
}

describe("saved/model - buildSavedList", () => {
  it("merges live articles and snapshots, newest saved first; entries without a saved time go last", () => {
    const w = world();
    const list = buildSavedList(w.state, "bookmarks", w.edition);
    assert.deepEqual(list.map((e) => [e.id, e.origin]), [
      [w.gone.id, "snapshot"],
      [w.badUrl.id, "missing"],
      [w.live.id, "live"],
      [w.goneOlder.id, "snapshot"],
      [w.liveNoSnap.id, "live"],
      ["phantom", "missing"],
    ]);
  });

  it("a live article wins over its snapshot (fresh title and source), the snapshot supplies the saved time", () => {
    const w = world();
    const e = buildSavedList(w.state, "bookmarks", w.edition).find((x) => x.id === w.live.id)!;
    assert.equal(e.title, "Live title (current)");
    assert.equal(e.sourceName, "The Verge AI");
    assert.equal(e.savedAt, w.state.snapshots[w.live.id].savedAt);
    assert.equal(e.item?.sourceId, "verge");
  });

  it("items survive after leaving the payload: rendered from the snapshot with fallback row data", () => {
    const w = world();
    const e = buildSavedList(w.state, "bookmarks", w.edition).find((x) => x.id === w.gone.id)!;
    assert.deepEqual(e.item, { id: w.gone.id, title: "Left the edition", url: "https://example.com/gone", sourceName: "Snapshot Source", publishedAt: w.gone.publishedAt, firstSeenAt: null });
    const offline = buildSavedList(w.state, "bookmarks", null);
    assert.deepEqual(offline.filter((x) => x.origin === "snapshot").map((x) => x.id), [w.gone.id, w.live.id, w.goneOlder.id], "without an edition every snapshot still renders");
    assert.equal(offline.find((x) => x.id === w.live.id)?.title, "Stale snapshot title");
  });

  it("ids with no usable data become removable placeholders (never a link built from a non-http URL)", () => {
    const w = world();
    const list = buildSavedList(w.state, "bookmarks", w.edition);
    const tampered = list.find((x) => x.id === w.badUrl.id)!;
    assert.equal(tampered.origin, "missing");
    assert.equal(tampered.url, "");
    assert.equal(tampered.item, undefined);
    assert.equal(list.find((x) => x.id === "phantom")?.origin, "missing");
    assert.equal(list.length, w.state.bookmarks.size, "every stored id has an entry, so every one can be removed");
  });

  it("the read-later tab has its own list", () => {
    const w = world();
    assert.deepEqual(buildSavedList(w.state, "later", w.edition).map((e) => [e.id, e.origin]), [
      [w.gone.id, "snapshot"],
      [w.later.id, "live"],
    ]);
    assert.deepEqual(buildSavedList({ bookmarks: new Set(), later: new Set(), snapshots: {} }, "later", w.edition), []);
  });

  it("follows the saved store: toggle, consume, remove", () => {
    const s = createFakeServices();
    const e = s.edition.get().edition!;
    const [a, b] = e.top.map((id) => e.articles[id]);
    s.saved.toggleBookmark(a, "Source A");
    s.saved.toggleLater(a, "Source A");
    s.setNow(s.clock.get() + 60_000);
    s.saved.toggleBookmark(b, "Source B");
    assert.deepEqual(buildSavedList(s.saved.get(), "bookmarks", e).map((x) => x.id), [b.id, a.id]);
    s.saved.consume(a.id);
    assert.deepEqual(buildSavedList(s.saved.get(), "later", e), []);
    s.saved.remove("bookmarks", b.id);
    assert.deepEqual(buildSavedList(s.saved.get(), "bookmarks", e).map((x) => x.id), [a.id]);
  });
});

describe("saved/model - Markdown, restore, title", () => {
  it("copy all as Markdown: heading with the count, one escaped link per usable entry, saved date", () => {
    const w = world();
    const md = savedMarkdown(buildSavedList(w.state, "bookmarks", w.edition), "bookmarks");
    const lines = md.trimEnd().split("\n");
    assert.equal(lines[0], "# AI DRUDGE — Bookmarks (4)");
    assert.equal(lines[2], `- [Left the edition](https://example.com/gone) — Snapshot Source · saved ${hoursAgo(1).slice(0, 10)}`);
    assert.equal(lines[3], `- [Live title (current)](${w.live.url}) — The Verge AI · saved ${hoursAgo(3).slice(0, 10)}`);
    assert.equal(lines[5], `- [Live, saved before snapshots existed](${w.liveNoSnap.url}) — The Verge AI`);
    assert.equal(lines.length, 6, "placeholders are skipped");
    assert.ok(!md.includes("javascript:"));
  });

  it("escapes Markdown in titles and source names", () => {
    const a = makeArticle({ title: "Why [RAG] *still* matters_", url: "https://example.com/a_(b)" });
    const state: SavedState = { bookmarks: new Set(), later: new Set([a.id]), snapshots: { [a.id]: snap(a, hoursAgo(1), { sourceName: "Some_Blog" }) } };
    const md = savedMarkdown(buildSavedList(state, "later", null), "later");
    assert.ok(md.startsWith("# AI DRUDGE — Read later (1)\n"));
    assert.ok(md.includes("- [Why \\[RAG\\] \\*still\\* matters\\_](https://example.com/a_%28b%29) — Some\\_Blog · saved "));
  });

  it("articleForRestore rebuilds a minimal article from an entry (undo after the article left the edition)", () => {
    const w = world();
    const entry = buildSavedList(w.state, "bookmarks", w.edition).find((x) => x.id === w.gone.id)!;
    const a = articleForRestore(entry, "2026-11-19T21:00:00.000Z");
    assert.equal(a.id, w.gone.id);
    assert.equal(a.title, "Left the edition");
    assert.equal(a.url, "https://example.com/gone");
    assert.equal(a.publishedAt, w.gone.publishedAt);
    assert.equal(a.firstSeenAt, entry.savedAt);
    const s = createFakeServices();
    s.saved.toggleBookmark(a, entry.sourceName);
    assert.equal(buildSavedList(s.saved.get(), "bookmarks", null)[0].title, "Left the edition");
  });

  it("removedEntries reports what left the list (drives the 'removed - undo' notice)", () => {
    const s = createFakeServices();
    const e = s.edition.get().edition!;
    const [a, b, c] = e.top.map((id) => e.articles[id]);
    for (const x of [a, b, c]) s.saved.toggleBookmark(x, "Source");
    const before = buildSavedList(s.saved.get(), "bookmarks", e);
    assert.deepEqual(removedEntries(before, before), []);
    s.saved.remove("bookmarks", b.id);
    const after = buildSavedList(s.saved.get(), "bookmarks", e);
    assert.deepEqual(removedEntries(before, after).map((x) => [x.id, x.title]), [[b.id, b.title]]);
    assert.deepEqual(removedEntries(after, before), [], "an addition is not a removal");
    s.saved.clear("bookmarks");
    assert.equal(removedEntries(before, buildSavedList(s.saved.get(), "bookmarks", e)).length, 3);
    // Undo: the removed entry can be put back through the store.
    const [gone] = removedEntries(before, after);
    s.saved.toggleBookmark(e.articles[gone.id] ?? articleForRestore(gone, "2026-11-19T21:00:00.000Z"), gone.sourceName);
    assert.deepEqual(buildSavedList(s.saved.get(), "bookmarks", e).map((x) => x.id), [b.id]);
  });

  it("savedTitle", () => {
    assert.equal(savedTitle({ name: "saved", tab: "bookmarks" }), "Bookmarks");
    assert.equal(savedTitle({ name: "saved", tab: "later" }), "Read later");
  });
});
