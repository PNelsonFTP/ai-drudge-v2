import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeArticle, makeEdition } from "../../test/helpers/factories";
import { STORAGE_KEYS, type SavedStore } from "../app/services";
import { SAVED_KEY, createSavedStore, parseSnapshot } from "./saved";
import { createMemoryStorage, readKey, type StorageLike } from "./storage";
import { createTabs, quotaStorage, recordWrites } from "./testkit";

const T0 = Date.parse("2026-11-19T21:00:00.000Z");

function setup(storage: StorageLike = createMemoryStorage(), nowMs = T0) {
  let now = nowMs;
  const store = createSavedStore({ storage, now: () => now });
  return { storage, store, setNow: (ms: number) => void (now = ms) };
}

const stored = (storage: StorageLike) => {
  const res = readKey(storage, SAVED_KEY);
  assert.equal(res.status, "ok");
  return res.status === "ok" ? res.value : null;
};

describe("saved store: toggles", () => {
  it("writes the snapshot at toggle time", () => {
    const { store, storage } = setup();
    const a = makeArticle({ title: "Anthropic valued at $2tn", publishedAt: "2026-11-19T18:00:00.000Z" });
    store.toggleBookmark(a, "The Guardian AI");
    const s = store.get();
    assert.ok(s.bookmarks.has(a.id));
    assert.deepEqual(s.snapshots[a.id], {
      id: a.id,
      title: "Anthropic valued at $2tn",
      url: a.url,
      sourceName: "The Guardian AI",
      publishedAt: "2026-11-19T18:00:00.000Z",
      savedAt: "2026-11-19T21:00:00.000Z",
    });
    // Persisted in ONE key, as a versioned envelope with arrays.
    const raw = JSON.parse(storage.getItem(STORAGE_KEYS.saved) ?? "") as { v: number; data: { bookmarks: string[]; later: string[] } };
    assert.equal(raw.v, 1);
    assert.deepEqual(raw.data.bookmarks, [a.id]);
    assert.deepEqual(raw.data.later, []);
  });

  it("toggling again removes the id and garbage-collects its snapshot", () => {
    const { store, storage } = setup();
    const a = makeArticle();
    store.toggleBookmark(a, "S");
    store.toggleBookmark(a, "S");
    assert.equal(store.get().bookmarks.size, 0);
    assert.deepEqual(store.get().snapshots, {});
    assert.deepEqual(stored(storage)?.snapshots, {});
  });

  it("a snapshot is kept while EITHER list holds the id", () => {
    const { store } = setup();
    const a = makeArticle();
    store.toggleBookmark(a, "S");
    store.toggleLater(a, "S");
    store.toggleBookmark(a, "S");
    assert.ok(store.get().later.has(a.id));
    assert.ok(store.get().snapshots[a.id], "still referenced by read-later");
    store.consume(a.id);
    assert.equal(store.get().snapshots[a.id], undefined);
  });

  it("read-later is consumed on open; consume of an absent id changes nothing", () => {
    const { store } = setup();
    const a = makeArticle();
    store.toggleLater(a, "S");
    const before = store.get();
    store.consume("zzzzzz");
    assert.equal(store.get(), before, "no new state object for a no-op");
    store.consume(a.id);
    assert.equal(store.get().later.size, 0);
  });

  it("remove works for entries whose article left the edition; clear keeps the other list's snapshots", () => {
    const { store } = setup();
    const [a, b, c] = [makeArticle(), makeArticle(), makeArticle()];
    store.toggleBookmark(a, "S");
    store.toggleBookmark(b, "S");
    store.toggleLater(b, "S");
    store.toggleLater(c, "S");
    store.remove("bookmarks", a.id);
    assert.deepEqual([...store.get().bookmarks], [b.id]);
    store.clear("later");
    assert.equal(store.get().later.size, 0);
    assert.deepEqual(Object.keys(store.get().snapshots), [b.id], "b is still bookmarked, c is gone");
    store.clear("bookmarks");
    assert.deepEqual(store.get().snapshots, {});
  });

  it("refuses to save a non-http(s) URL", () => {
    const { store } = setup();
    store.toggleBookmark(makeArticle({ url: "javascript:alert(1)", id: "abc123" }), "S");
    assert.equal(store.get().bookmarks.size, 0);
  });

  it("get() keeps its identity until something changes (useSyncExternalStore contract)", () => {
    const { store } = setup();
    const a = store.get();
    assert.equal(store.get(), a);
    let calls = 0;
    store.subscribe(() => calls++);
    store.toggleBookmark(makeArticle(), "S");
    assert.notEqual(store.get(), a);
    assert.equal(calls, 1);
  });
});

describe("saved store: snapshots survive payload rotation", () => {
  it("a bookmark made in one page load is fully readable in the next, without any edition", () => {
    const storage = createMemoryStorage();
    const a = makeArticle({ title: "Aged-out story" });
    setup(storage).store.toggleBookmark(a, "Outlet");
    // New page load, days later; the article is in no payload any more.
    const next = setup(storage, T0 + 9 * 86_400_000).store;
    assert.ok(next.get().bookmarks.has(a.id));
    assert.equal(next.get().snapshots[a.id]?.title, "Aged-out story");
    assert.equal(next.get().snapshots[a.id]?.sourceName, "Outlet");
  });

  it("reconcile with an edition that no longer carries the story keeps the snapshot", () => {
    const { store } = setup();
    const gone = makeArticle({ title: "Gone from the payload" });
    store.toggleBookmark(gone, "Outlet");
    const other = makeArticle();
    store.reconcile(makeEdition({ articles: [other] }).edition);
    assert.equal(store.get().snapshots[gone.id]?.title, "Gone from the payload");
    assert.ok(store.get().bookmarks.has(gone.id));
  });

  it("reconcile refreshes a changed title but keeps savedAt", () => {
    const { store, setNow } = setup();
    const a = makeArticle({ title: "Draft headline" });
    store.toggleBookmark(a, "example-source");
    setNow(T0 + 3_600_000);
    const built = makeEdition({ articles: [{ ...a, title: "Final headline" }] });
    store.reconcile(built.edition);
    const snap = store.get().snapshots[a.id];
    assert.equal(snap.title, "Final headline");
    assert.equal(snap.sourceName, "Example Source", "source display name comes from the edition");
    assert.equal(snap.savedAt, "2026-11-19T21:00:00.000Z");
    // Nothing changed -> no write, same state object.
    const before = store.get();
    store.reconcile(built.edition);
    assert.equal(store.get(), before);
  });

  it("reconcile creates missing snapshots and drops ids that can never be shown (complete edition only)", () => {
    const storage = createMemoryStorage();
    const known = makeArticle({ title: "Known" });
    // Ids imported from V1 without snapshots.
    storage.setItem(STORAGE_KEYS.saved, JSON.stringify({ v: 1, data: { bookmarks: [known.id, "phantom"], later: [], snapshots: {} } }));
    const { store } = setup(storage);
    assert.equal(store.get().bookmarks.size, 2);
    const built = makeEdition({ articles: [known] });
    store.reconcile(built.frontOnly);
    assert.ok(store.get().bookmarks.has("phantom"), "front-only edition: the article may still be in rest.json");
    assert.equal(store.get().snapshots[known.id]?.title, "Known");
    store.reconcile(built.edition);
    assert.deepEqual([...store.get().bookmarks], [known.id]);
  });
});

describe("saved store: storage robustness", () => {
  it("drops invalid snapshot entries and non-http URLs instead of rejecting everything", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      STORAGE_KEYS.saved,
      JSON.stringify({
        v: 1,
        data: {
          bookmarks: ["good", "evil", "broken", 42, "good"],
          later: "not-an-array",
          snapshots: {
            good: { title: "Good", url: "https://example.com/a", sourceName: "S", publishedAt: null, savedAt: "2026-11-01T00:00:00.000Z" },
            evil: { title: "Evil", url: "javascript:alert(document.cookie)", sourceName: "S", publishedAt: null, savedAt: "2026-11-01T00:00:00.000Z" },
            broken: ["array"],
            orphan: { title: "Orphan", url: "https://example.com/o", sourceName: "S", publishedAt: null, savedAt: "2026-11-01T00:00:00.000Z" },
          },
        },
      }),
    );
    const { store } = setup(storage);
    const s = store.get();
    assert.deepEqual([...s.bookmarks], ["good", "evil", "broken"]);
    assert.equal(s.later.size, 0);
    assert.deepEqual(Object.keys(s.snapshots), ["good"], "javascript: URL, wrong shape and unreferenced snapshot are gone");
  });

  it("parseSnapshot validates each field", () => {
    assert.equal(parseSnapshot(null, "a"), null);
    assert.equal(parseSnapshot({ title: "", url: "https://example.com" }, "a"), null);
    assert.equal(parseSnapshot({ title: "T", url: "data:text/html,x" }, "a"), null);
    assert.deepEqual(parseSnapshot({ title: "T", url: "https://example.com/x", publishedAt: "garbage", savedAt: 5 }, "a"), {
      id: "a",
      title: "T",
      url: "https://example.com/x",
      sourceName: "",
      publishedAt: null,
      savedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("unreadable storage is never treated as 'delete everything': the key is left alone until a real change", () => {
    const corrupt = '{"v":1,"data":';
    const rec = recordWrites(createMemoryStorage({ [STORAGE_KEYS.saved]: corrupt }));
    const { store } = setup(rec.storage);
    assert.equal(store.get().bookmarks.size, 0);
    store.reconcile(makeEdition({ articles: [makeArticle()] }).edition);
    store.consume("nothing");
    store.clear("bookmarks");
    assert.deepEqual(rec.writes, [], "no GC / no write happened on load or on no-op calls");
    assert.equal(rec.storage.getItem(STORAGE_KEYS.saved), corrupt);
  });

  it("a refused write (quota) still updates the UI state and reports the key", () => {
    const errors: string[] = [];
    const store = createSavedStore({ storage: quotaStorage(), now: () => T0, onWriteError: (k) => errors.push(k) });
    const a = makeArticle();
    store.toggleBookmark(a, "S");
    assert.ok(store.get().bookmarks.has(a.id));
    assert.deepEqual(errors, [STORAGE_KEYS.saved]);
  });
});

describe("saved store: cross-tab", () => {
  it("a bookmark made in tab A appears in tab B through the storage event", () => {
    const { tabs } = createTabs(2);
    const a = createSavedStore({ storage: tabs[0].storage, now: () => T0, events: tabs[0].events });
    const b = createSavedStore({ storage: tabs[1].storage, now: () => T0, events: tabs[1].events });
    let notified = 0;
    b.subscribe(() => notified++);
    const art = makeArticle({ title: "From tab A" });
    a.toggleBookmark(art, "S");
    assert.ok(b.get().bookmarks.has(art.id));
    assert.equal(b.get().snapshots[art.id]?.title, "From tab A");
    assert.equal(notified, 1);
  });

  it("two tabs saving different stories never erase each other's snapshots (V1 clobber)", () => {
    // No storage events at all: tab B is 'older' and has not heard about Z. Read-merge-write alone
    // must keep both.
    const shared = createMemoryStorage();
    const a = createSavedStore({ storage: shared, now: () => T0 });
    const b = createSavedStore({ storage: shared, now: () => T0 });
    const z = makeArticle({ title: "Z" });
    const w = makeArticle({ title: "W" });
    a.toggleBookmark(z, "S");
    b.toggleBookmark(w, "S");
    const fresh: SavedStore = createSavedStore({ storage: shared, now: () => T0 });
    assert.deepEqual([...fresh.get().bookmarks].sort(), [z.id, w.id].sort());
    assert.equal(fresh.get().snapshots[z.id]?.title, "Z");
    assert.equal(fresh.get().snapshots[w.id]?.title, "W");
  });

  it("removing in one tab removes in the other", () => {
    const { tabs } = createTabs(2);
    const a = createSavedStore({ storage: tabs[0].storage, now: () => T0, events: tabs[0].events });
    const b = createSavedStore({ storage: tabs[1].storage, now: () => T0, events: tabs[1].events });
    const art = makeArticle();
    a.toggleLater(art, "S");
    b.consume(art.id);
    assert.equal(a.get().later.size, 0);
    assert.deepEqual(a.get().snapshots, {});
  });
});
