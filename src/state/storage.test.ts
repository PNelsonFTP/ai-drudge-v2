import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STORAGE_PREFIX } from "../app/services";
import {
  createMemoryStorage,
  createPersistedStore,
  decodeValue,
  defineKey,
  encodeValue,
  isFallbackStorage,
  listKeys,
  readKey,
  removeKey,
  safeStorage,
  stringList,
  writeKey,
  writeRaw,
  type KeySpec,
  type StorageEventSource,
} from "./storage";
import { brokenStorage, createTabs, quotaStorage } from "./testkit";

interface Prefs {
  color: string;
  size: number;
}

// v1 stored { colour }, v2 renamed it to { color }, v3 added size.
const PREFS: KeySpec<Prefs> = defineKey({
  key: "aid2:test-prefs",
  version: 3,
  parse: (d) => {
    if (typeof d !== "object" || d === null) return null;
    const o = d as Record<string, unknown>;
    return typeof o.color === "string" && typeof o.size === "number" ? { color: o.color, size: o.size } : null;
  },
  migrations: {
    1: (d) => ({ color: (d as { colour: string }).colour }),
    2: (d) => ({ ...(d as object), size: 9 }),
  },
});

const LIST: KeySpec<string[]> = defineKey({ key: "aid2:test-list", version: 1, parse: (d) => (Array.isArray(d) ? stringList(d) : null) });

describe("storage: key namespace", () => {
  it("defineKey refuses keys outside the aid2: namespace and bad versions", () => {
    assert.throws(() => defineKey({ key: "ai-drudge:bookmarks", version: 1, parse: () => null }), /outside/);
    assert.throws(() => defineKey({ key: "other", version: 1, parse: () => null }), /outside/);
    assert.throws(() => defineKey({ key: "aid2:x", version: 0, parse: () => null }), /version/);
    assert.equal(defineKey({ key: `${STORAGE_PREFIX}ok`, version: 1, parse: () => null }).key, "aid2:ok");
  });

  it("writeRaw / removeKey throw on a V1 key instead of touching it", () => {
    const s = createMemoryStorage({ "ai-drudge:bookmarks": '["a"]' });
    assert.throws(() => writeRaw(s, "ai-drudge:bookmarks", "[]"), /refusing to write/);
    assert.throws(() => removeKey(s, "ai-drudge:bookmarks"), /refusing to remove/);
    assert.equal(s.getItem("ai-drudge:bookmarks"), '["a"]');
  });

  it("listKeys returns only namespaced keys, sorted", () => {
    const s = createMemoryStorage({ "aid2:b": "1", "ai-drudge:theme-ft": "dark", "aid2:a": "2", unrelated: "3" });
    assert.deepEqual(listKeys(s), ["aid2:a", "aid2:b"]);
    assert.deepEqual(listKeys(brokenStorage()), []);
  });
});

describe("storage: versioned envelope", () => {
  it("round-trips a value as {v, data}", () => {
    const s = createMemoryStorage();
    assert.equal(writeKey(s, PREFS, { color: "navy", size: 2 }), true);
    assert.deepEqual(JSON.parse(s.getItem(PREFS.key) ?? ""), { v: 3, data: { color: "navy", size: 2 } });
    assert.deepEqual(readKey(s, PREFS), { status: "ok", value: { color: "navy", size: 2 }, migrated: false });
  });

  it("reads are tri-state: empty, ok, unreadable (with the reason)", () => {
    const s = createMemoryStorage();
    assert.deepEqual(readKey(s, PREFS), { status: "empty" });
    s.setItem(PREFS.key, "{not json");
    assert.deepEqual(readKey(s, PREFS), { status: "unreadable", reason: "json" });
    s.setItem(PREFS.key, '["bare", "array"]');
    assert.deepEqual(readKey(s, PREFS), { status: "unreadable", reason: "shape" });
    s.setItem(PREFS.key, '{"v":3,"data":{"color":7}}');
    assert.deepEqual(readKey(s, PREFS), { status: "unreadable", reason: "invalid" });
    s.setItem(PREFS.key, '{"v":4,"data":{"color":"x","size":1,"extra":true}}');
    assert.deepEqual(readKey(s, PREFS), { status: "unreadable", reason: "newer" });
    assert.deepEqual(readKey(brokenStorage(), PREFS), { status: "unreadable", reason: "storage" });
  });

  it("migrates old versions step by step", () => {
    assert.deepEqual(decodeValue('{"v":1,"data":{"colour":"gold"}}', PREFS), { status: "ok", value: { color: "gold", size: 9 }, migrated: true });
    assert.deepEqual(decodeValue('{"v":2,"data":{"color":"gold"}}', PREFS), { status: "ok", value: { color: "gold", size: 9 }, migrated: true });
  });

  it("a version without a migration path, or a throwing migration, is unreadable - not a crash", () => {
    assert.deepEqual(decodeValue('{"v":0,"data":{}}', PREFS), { status: "unreadable", reason: "shape" });
    assert.deepEqual(decodeValue('{"v":1,"data":null}', PREFS), { status: "unreadable", reason: "invalid" });
  });

  it("encodeValue uses the key's encoder", () => {
    const SET: KeySpec<Set<string>> = defineKey({ key: "aid2:test-set", version: 1, parse: (d) => new Set(stringList(d)), encode: (v) => [...v] });
    assert.equal(encodeValue(SET, new Set(["a", "b"])), '{"v":1,"data":["a","b"]}');
  });
});

describe("storage: failure tolerance", () => {
  it("a quota error returns false and never throws", () => {
    assert.equal(writeKey(quotaStorage(), LIST, ["a"]), false);
    assert.equal(writeKey(brokenStorage(), LIST, ["a"]), false);
    assert.equal(removeKey(brokenStorage(), LIST.key), false);
  });

  it("safeStorage falls back to memory when storage is missing or throws on access", () => {
    const real = createMemoryStorage();
    assert.equal(safeStorage(() => real), real);
    assert.equal(real.length, 0, "the probe key is removed");
    for (const bad of [() => undefined, () => null, () => brokenStorage(), () => { throw new Error("SecurityError"); }]) {
      const s = safeStorage(bad);
      s.setItem("aid2:x", "1");
      assert.equal(s.getItem("aid2:x"), "1");
    }
  });

  it("isFallbackStorage: true only for the in-memory stand-in safeStorage hands out, never for a real or test storage", () => {
    const real = createMemoryStorage();
    assert.equal(isFallbackStorage(safeStorage(() => real)), false);
    assert.equal(isFallbackStorage(real), false, "a memory storage a test builds is not a fallback");
    assert.equal(isFallbackStorage(safeStorage(() => quotaStorage())), false, "full but readable: kept, and its writes report onWriteError");
    for (const bad of [() => undefined, () => null, () => brokenStorage(), () => { throw new Error("SecurityError"); }]) {
      assert.equal(isFallbackStorage(safeStorage(bad)), true);
    }
  });

  it("safeStorage keeps a storage that is readable but full: existing reader state must not look lost", () => {
    const inner = createMemoryStorage();
    writeKey(inner, LIST, ["bookmark-1"]);
    const full = quotaStorage(inner);
    const s = safeStorage(() => full);
    assert.equal(s, full, "not swapped for an empty memory storage");
    const reported: string[] = [];
    const store = createPersistedStore({ storage: s, spec: LIST, fallback: [] as string[], onWriteError: (key) => reported.push(key) });
    assert.deepEqual(store.get(), ["bookmark-1"], "what was saved before the storage filled up is still there");
    // Changes are refused by the storage, reported, and kept in memory across further changes.
    assert.equal(store.update((l) => [...l, "bookmark-2"]), false);
    assert.equal(store.update((l) => [...l, "bookmark-3"]), false);
    assert.deepEqual(store.get(), ["bookmark-1", "bookmark-2", "bookmark-3"]);
    assert.deepEqual(reported, [LIST.key, LIST.key]);
    assert.deepEqual(readKey(inner, LIST), { status: "ok", migrated: false, value: ["bookmark-1"] });
  });

  it("stringList keeps distinct strings that pass the predicate", () => {
    assert.deepEqual(stringList(["a", 1, "b", "a", null, "cc"], (s) => s.length === 1), ["a", "b"]);
    assert.deepEqual(stringList("nope"), []);
  });
});

describe("storage: persisted store", () => {
  it("starts from storage, else from the fallback; get() is referentially stable", () => {
    const s = createMemoryStorage();
    const fallback: string[] = [];
    const a = createPersistedStore({ storage: s, spec: LIST, fallback });
    assert.equal(a.get(), fallback);
    assert.equal(a.status(), "empty");
    writeKey(s, LIST, ["x"]);
    const b = createPersistedStore({ storage: s, spec: LIST, fallback });
    assert.deepEqual(b.get(), ["x"]);
    assert.equal(b.get(), b.get());
    b.reload();
    assert.equal(b.status(), "ok");
  });

  it("update writes the envelope and notifies; an unchanged value does neither", () => {
    const s = createMemoryStorage();
    const store = createPersistedStore({ storage: s, spec: LIST, fallback: [] as string[] });
    let calls = 0;
    store.subscribe(() => calls++);
    assert.equal(store.update((p) => [...p, "a"]), true);
    assert.equal(s.getItem(LIST.key), '{"v":1,"data":["a"]}');
    assert.equal(calls, 1);
    const before = store.get();
    store.update((p) => p);
    assert.equal(calls, 1);
    assert.equal(store.get(), before);
  });

  it("update is read-merge-write: a change made by another writer is not clobbered", () => {
    const s = createMemoryStorage();
    const store = createPersistedStore({ storage: s, spec: LIST, fallback: [] as string[] });
    store.update((p) => [...p, "mine"]);
    writeKey(s, LIST, ["mine", "theirs"]); // another tab, no storage event delivered yet
    store.update((p) => [...p, "mine-2"]);
    assert.deepEqual(store.get(), ["mine", "theirs", "mine-2"]);
    assert.deepEqual(readKey(s, LIST), { status: "ok", value: ["mine", "theirs", "mine-2"], migrated: false });
  });

  it("syncs across tabs through the storage event, filtered by key", () => {
    const { tabs } = createTabs(2);
    const a = createPersistedStore({ storage: tabs[0].storage, spec: LIST, fallback: [] as string[], events: tabs[0].events });
    const b = createPersistedStore({ storage: tabs[1].storage, spec: LIST, fallback: [] as string[], events: tabs[1].events });
    let bCalls = 0;
    b.subscribe(() => bCalls++);
    a.update(() => ["one"]);
    assert.deepEqual(b.get(), ["one"]);
    assert.equal(bCalls, 1);
    // A write to an unrelated key must not give tab B a new state object.
    const before = b.get();
    tabs[0].storage.setItem("aid2:something-else", "1");
    assert.equal(b.get(), before);
    assert.equal(bCalls, 1);
    // After dispose the tab stops listening.
    b.dispose();
    a.update(() => ["two"]);
    assert.deepEqual(b.get(), ["one"]);
  });

  it("a removed key (other tab cleared it) falls back", () => {
    const { tabs } = createTabs(2);
    const a = createPersistedStore({ storage: tabs[0].storage, spec: LIST, fallback: [] as string[], events: tabs[0].events });
    a.update(() => ["one"]);
    tabs[1].storage.removeItem(LIST.key);
    assert.deepEqual(a.get(), []);
  });

  it("a failed write keeps the state in memory and reports it", () => {
    const errors: string[] = [];
    const store = createPersistedStore({ storage: quotaStorage(), spec: LIST, fallback: [] as string[], onWriteError: (k) => errors.push(k) });
    assert.equal(store.update(() => ["kept"]), false);
    assert.deepEqual(store.get(), ["kept"]);
    assert.deepEqual(errors, [LIST.key]);
    // The next update builds on the in-memory value, not on the (empty) storage.
    store.update((p) => [...p, "too"]);
    assert.deepEqual(store.get(), ["kept", "too"]);
  });

  it("never overwrites a value written by a newer client", () => {
    const newer = '{"v":2,"data":{"items":["future"]}}';
    const s = createMemoryStorage({ [LIST.key]: newer });
    const errors: string[] = [];
    const store = createPersistedStore({ storage: s, spec: LIST, fallback: [] as string[], onWriteError: (k) => errors.push(k) });
    assert.equal(store.status(), "newer");
    assert.deepEqual(store.get(), []);
    assert.equal(store.update(() => ["local"]), false);
    assert.deepEqual(store.get(), ["local"], "the change still applies in memory");
    assert.equal(s.getItem(LIST.key), newer, "storage untouched");
    assert.equal(errors.length, 1);
  });

  it("corrupt storage is replaced by the next write (nothing to preserve)", () => {
    const s = createMemoryStorage({ [LIST.key]: "{{{" });
    const store = createPersistedStore({ storage: s, spec: LIST, fallback: [] as string[] });
    assert.equal(store.status(), "json");
    assert.equal(store.update(() => ["fresh"]), true);
    assert.equal(s.getItem(LIST.key), '{"v":1,"data":["fresh"]}');
  });

  it("works with storage that throws on every access", () => {
    const store = createPersistedStore({ storage: brokenStorage(), spec: LIST, fallback: [] as string[] });
    assert.equal(store.status(), "storage");
    assert.equal(store.update(() => ["a"]), false);
    assert.deepEqual(store.get(), ["a"]);
  });
});

// Type-level: the browser objects createServices passes in satisfy the injected interfaces.
export function _typecheck(win: Window): StorageEventSource {
  return win;
}
