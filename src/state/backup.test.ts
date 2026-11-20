import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeArticle } from "../../test/helpers/factories";
import { STORAGE_KEYS, STORAGE_PREFIX } from "../app/services";
import { BACKUP_FORMAT, BACKUP_KEYS, MAX_BACKUP_CHARS, RESTORABLE_KEYS, type BackupDocument } from "./backup";
import { createReaderState, type ReaderState } from "./index";
import { createMemoryStorage, listKeys, type StorageLike } from "./storage";
import { quotaStorage, recordWrites } from "./testkit";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");

// The storage behind each ReaderState, so a test can simulate the next page load on the same browser.
const storages = new WeakMap<ReaderState, StorageLike>();
function reader(storage: StorageLike = createMemoryStorage()): ReaderState {
  const state = createReaderState({ storage, now: () => NOW, createObserver: null });
  storages.set(state, storage);
  return state;
}
function storageOf(state: ReaderState): StorageLike {
  const s = storages.get(state);
  assert.ok(s);
  return s;
}

/** A reader with something in every store. */
function populated(storage: StorageLike = createMemoryStorage()) {
  const state = reader(storage);
  const a = makeArticle({ title: "Bookmarked story" });
  const b = makeArticle({ title: "Queued story" });
  state.saved.toggleBookmark(a, "Outlet A");
  state.saved.toggleLater(b, "Outlet B");
  state.mutes.toggleSource("techcrunch-ai");
  state.mutes.toggleSection("quantum");
  state.watchlist.addPreset("ciso");
  state.watchlist.add("Rubrik");
  state.settings.set("theme", "dark");
  state.settings.set("density", "comfortable");
  state.settings.set("sectionOrder", ["ai_security", "cyber", "policy"]);
  state.settings.set("hiddenSections", ["robotics"]);
  state.settings.set("timeFilter", "24h");
  state.readState.markSeen("seen001");
  state.readState.markSeen("seen002");
  state.readState.flush();
  return { state, storage, a, b };
}

const snapshot = (s: ReaderState) => ({
  bookmarks: [...s.saved.get().bookmarks],
  later: [...s.saved.get().later],
  snapshots: s.saved.get().snapshots,
  mutedSources: [...s.mutes.get().sources],
  mutedSections: [...s.mutes.get().sections],
  terms: s.watchlist.get().terms,
  settings: s.settings.get(),
});

describe("backup: export", () => {
  it("is one versioned JSON document holding every aid2:* reader-state key", () => {
    const { state, storage } = populated();
    const doc = JSON.parse(state.backup.exportJson()) as BackupDocument;
    assert.equal(doc.app, "ai-drudge");
    assert.equal(doc.kind, "reader-state");
    assert.equal(doc.format, BACKUP_FORMAT);
    assert.equal(doc.exportedAt, "2026-11-20T09:00:00.000Z");
    assert.deepEqual(Object.keys(doc.keys).sort(), listKeys(storage), "everything in the namespace is exported");
    for (const [key, envelope] of Object.entries(doc.keys)) {
      assert.ok(key.startsWith(STORAGE_PREFIX));
      assert.equal(typeof envelope.v, "number");
      assert.deepEqual(envelope, JSON.parse(storage.getItem(key) ?? ""));
    }
  });

  it("covers every key the contract declares", () => {
    assert.deepEqual([...BACKUP_KEYS].sort(), Object.values(STORAGE_KEYS).sort());
    assert.deepEqual([...RESTORABLE_KEYS].sort(), [STORAGE_KEYS.mutes, STORAGE_KEYS.saved, STORAGE_KEYS.seen, STORAGE_KEYS.settings, STORAGE_KEYS.watchlist].sort());
  });

  it("an empty reader exports a valid document that restores nothing", () => {
    const state = reader();
    const text = state.backup.exportJson();
    const doc = JSON.parse(text) as BackupDocument;
    assert.deepEqual(Object.keys(doc.keys), [STORAGE_KEYS.lastVisit]);
    assert.deepEqual(state.backup.importJson(text), { ok: false, error: "The backup contains nothing that can be restored." });
  });

  it("does not export corrupt values", () => {
    const storage = createMemoryStorage({ [STORAGE_KEYS.mutes]: "{{{", [STORAGE_KEYS.watchlist]: JSON.stringify({ v: 1, data: { terms: ["MCP"] } }) });
    const doc = JSON.parse(reader(storage).backup.exportJson()) as BackupDocument;
    assert.equal(doc.keys[STORAGE_KEYS.mutes], undefined);
    assert.deepEqual(doc.keys[STORAGE_KEYS.watchlist], { v: 1, data: { terms: ["MCP"] } });
  });
});

describe("backup: export -> import round-trip", () => {
  it("restores bookmarks, read-later, snapshots, mutes, watchlist, settings and read state on a fresh browser", () => {
    const source = populated();
    const text = source.state.backup.exportJson();

    const target = reader(createMemoryStorage());
    assert.equal(target.saved.get().bookmarks.size, 0);
    const result = target.backup.importJson(text);
    assert.deepEqual(result, { ok: true, restored: [STORAGE_KEYS.saved, STORAGE_KEYS.mutes, STORAGE_KEYS.watchlist, STORAGE_KEYS.settings, STORAGE_KEYS.seen] });

    // The LIVE stores of the target updated without a reload ...
    assert.deepEqual(snapshot(target), snapshot(source.state));
    assert.equal(target.saved.get().snapshots[source.a.id].title, "Bookmarked story");
    assert.equal(target.saved.get().snapshots[source.b.id].sourceName, "Outlet B");
    assert.ok(target.watchlist.matcher()("Rubrik ships immutable backups"));

    // ... and a new page load on the target sees the same.
    const reloaded = reader(storageOf(target));
    assert.deepEqual(snapshot(reloaded), snapshot(source.state));
    assert.equal(reloaded.readState.wasSeen("seen001"), true);
    assert.equal(reloaded.readState.wasSeen("seen002"), true);

    // Exporting again gives the same keys (stable round-trip).
    const again = JSON.parse(reloaded.backup.exportJson()) as BackupDocument;
    const original = JSON.parse(text) as BackupDocument;
    for (const key of RESTORABLE_KEYS) assert.deepEqual(again.keys[key], original.keys[key], key);
  });

  it("a restore replaces the keys it carries and leaves the others alone", () => {
    const source = reader();
    source.watchlist.add("FINRA");
    const text = source.backup.exportJson();

    const target = populated();
    const before = snapshot(target.state);
    assert.deepEqual(target.state.backup.importJson(text), { ok: true, restored: [STORAGE_KEYS.watchlist] });
    assert.deepEqual(target.state.watchlist.get().terms, ["FINRA"], "replaced, not merged");
    assert.deepEqual({ ...snapshot(target.state), terms: before.terms }, before, "saved / mutes / settings untouched");
  });

  it("device-local keys are exported but never restored", () => {
    const source = populated();
    const text = source.state.backup.exportJson();
    assert.ok((JSON.parse(text) as BackupDocument).keys[STORAGE_KEYS.lastVisit]);
    const rec = recordWrites(createMemoryStorage());
    const target = reader(rec.storage);
    rec.writes.length = 0;
    target.backup.importJson(text);
    assert.ok(!rec.writes.some((w) => w.key === STORAGE_KEYS.lastVisit || w.key === STORAGE_KEYS.migratedFromV1));
  });
});

describe("backup: dry run", () => {
  it("previewJson summarises what importJson would do and writes nothing", () => {
    const source = populated();
    const text = source.state.backup.exportJson();
    const rec = recordWrites(createMemoryStorage());
    const target = reader(rec.storage);
    rec.writes.length = 0;
    const preview = target.backup.previewJson(text);
    assert.deepEqual(rec.writes, [], "a dry run never touches storage");
    assert.ok(preview.ok);
    assert.equal(preview.exportedAt, "2026-11-20T09:00:00.000Z");
    const byKey = Object.fromEntries(preview.items.map((i) => [i.key, i]));
    assert.deepEqual(byKey[STORAGE_KEYS.saved], { key: STORAGE_KEYS.saved, label: "Bookmarks and read later", action: "replace", detail: "1 bookmark, 1 read later" });
    assert.equal(byKey[STORAGE_KEYS.mutes].detail, "1 muted source, 1 muted section");
    assert.equal(byKey[STORAGE_KEYS.watchlist].detail, `${source.state.watchlist.get().terms.length} terms`);
    assert.equal(byKey[STORAGE_KEYS.settings].detail, "theme dark, comfortable, 1 hidden section, custom section order");
    assert.equal(byKey[STORAGE_KEYS.seen].detail, "2 seen stories");
    assert.equal(byKey[STORAGE_KEYS.lastVisit].action, "skip");
    assert.equal(target.saved.get().bookmarks.size, 0);
    // The preview and the import agree.
    const result = target.backup.importJson(text);
    assert.ok(result.ok);
    assert.deepEqual(result.restored.sort(), preview.items.filter((i) => i.action === "replace").map((i) => i.key).sort());
  });
});

describe("backup: validation", () => {
  const good = (): BackupDocument => JSON.parse(populated().state.backup.exportJson()) as BackupDocument;

  it("rejects non-backups with a readable message and without writing", () => {
    const rec = recordWrites(createMemoryStorage());
    const target = reader(rec.storage);
    rec.writes.length = 0;
    const cases: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["not json", /not valid JSON/],
      ["[1,2,3]", /not an AI DRUDGE backup/],
      ['{"app":"something-else","kind":"reader-state","format":1,"keys":{}}', /not an AI DRUDGE backup/],
      ['{"app":"ai-drudge","kind":"reader-state","format":1}', /not an AI DRUDGE backup/],
      ['{"app":"ai-drudge","kind":"reader-state","format":"1","keys":{}}', /not an AI DRUDGE backup/],
      [JSON.stringify({ ...good(), format: BACKUP_FORMAT + 1 }), /newer version/],
      [JSON.stringify({ ...good(), keys: {} }), /nothing that can be restored/],
      ["x".repeat(MAX_BACKUP_CHARS + 1), /too large/],
    ];
    for (const [text, pattern] of cases) {
      const res = target.backup.importJson(text);
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, pattern);
      assert.deepEqual(target.backup.previewJson(text), res, "preview reports the same error");
    }
    assert.deepEqual(rec.writes, []);
  });

  it("skips entries that fail validation or come from a newer version, restoring the rest", () => {
    const doc = good();
    doc.keys[STORAGE_KEYS.mutes] = { v: 1, data: "not an object" };
    doc.keys[STORAGE_KEYS.settings] = { v: 99, data: {} };
    doc.keys["aid2:from-the-future"] = { v: 1, data: 1 };
    doc.keys["ai-drudge:bookmarks"] = { v: 1, data: ["x"] };
    const rec = recordWrites(createMemoryStorage());
    const target = reader(rec.storage);
    rec.writes.length = 0;
    const text = JSON.stringify(doc);
    const preview = target.backup.previewJson(text);
    assert.ok(preview.ok);
    const byKey = Object.fromEntries(preview.items.map((i) => [i.key, i]));
    assert.deepEqual([byKey[STORAGE_KEYS.mutes].action, byKey[STORAGE_KEYS.mutes].detail], ["skip", "not readable"]);
    assert.deepEqual([byKey[STORAGE_KEYS.settings].action, byKey[STORAGE_KEYS.settings].detail], ["skip", "written by a newer version"]);
    assert.deepEqual([byKey["aid2:from-the-future"].action, byKey["aid2:from-the-future"].detail], ["skip", "unknown key"]);
    assert.equal(byKey["ai-drudge:bookmarks"].action, "skip");
    const result = target.backup.importJson(text);
    assert.deepEqual(result, { ok: true, restored: [STORAGE_KEYS.saved, STORAGE_KEYS.watchlist, STORAGE_KEYS.seen] });
    assert.deepEqual([...new Set(rec.writes.map((w) => w.key))].sort(), [STORAGE_KEYS.saved, STORAGE_KEYS.seen, STORAGE_KEYS.watchlist].sort(), "a backup can never write outside its known aid2: keys");
  });

  it("sanitises what it restores: the validated value is stored, not the file's raw content", () => {
    const doc = good();
    const id = Object.keys((doc.keys[STORAGE_KEYS.saved].data as { snapshots: Record<string, unknown> }).snapshots)[0];
    doc.keys[STORAGE_KEYS.saved] = {
      v: 1,
      data: {
        bookmarks: [id, "evil001"],
        later: [],
        snapshots: {
          [id]: { title: "Fine", url: "https://example.com/fine", sourceName: "S", publishedAt: null, savedAt: "2026-11-01T00:00:00.000Z", extra: "<script>" },
          evil001: { title: "Planted", url: "javascript:alert(1)", sourceName: "S", publishedAt: null, savedAt: "2026-11-01T00:00:00.000Z" },
        },
      },
    };
    doc.keys[STORAGE_KEYS.watchlist] = { v: 1, data: { terms: ["ok", "*", 7] } };
    const storage = createMemoryStorage();
    const target = reader(storage);
    assert.ok(target.backup.importJson(JSON.stringify(doc)).ok);
    const raw = storage.getItem(STORAGE_KEYS.saved) ?? "";
    assert.ok(!raw.includes("javascript:"));
    assert.ok(!raw.includes("<script>"));
    assert.deepEqual(Object.keys(target.saved.get().snapshots), [id]);
    assert.deepEqual(target.watchlist.get().terms, ["ok"]);
  });

  it("reports a refused write instead of claiming success", () => {
    const text = populated().state.backup.exportJson();
    const res = reader(quotaStorage()).backup.importJson(text);
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /refused to store 5 of 5/);
  });
});
