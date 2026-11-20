import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SEEN_LIMIT, STORAGE_KEYS } from "../app/services";
import { DWELL_MS, SEEN_FLUSH_MS, SEEN_KEY, VISIBILITY_THRESHOLD, createReadStateStore, lruTouch, type ObserverEntryLike, type ObserverFactory } from "./readState";
import { createMemoryStorage, readKey, writeKey, type StorageLike } from "./storage";
import { createFakeTimers, quotaStorage } from "./testkit";

interface FakeEl {
  name: string;
  isConnected: boolean;
}
const el = (name: string): Element => ({ name, isConnected: true }) as unknown as Element;
const detach = (e: Element): void => void ((e as unknown as FakeEl).isConnected = false);

function setup(storage: StorageLike = createMemoryStorage(), limit?: number) {
  const timers = createFakeTimers();
  const observed = new Set<Element>();
  const log: string[] = [];
  let created = 0;
  let emit: (entries: readonly ObserverEntryLike[]) => void = () => undefined;
  let threshold = 0;
  const createObserver: ObserverFactory = (callback, options) => {
    created += 1;
    emit = callback;
    threshold = options.threshold;
    return {
      observe: (e) => {
        observed.add(e);
        log.push(`observe ${(e as unknown as FakeEl).name}`);
      },
      unobserve: (e) => {
        observed.delete(e);
        log.push(`unobserve ${(e as unknown as FakeEl).name}`);
      },
      disconnect: () => observed.clear(),
    };
  };
  // Deferred work runs when the test says so (stands in for the microtask after React's commit).
  const deferred: (() => void)[] = [];
  const store = createReadStateStore({ storage, createObserver, timers, defer: (fn) => void deferred.push(fn), limit });
  return {
    store,
    storage,
    timers,
    observed,
    log,
    created: () => created,
    threshold: () => threshold,
    show: (e: Element, ratio = 1) => emit([{ target: e, isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    hide: (e: Element) => emit([{ target: e, isIntersecting: false, intersectionRatio: 0 }]),
    microtask: () => {
      for (const fn of deferred.splice(0)) fn();
    },
    stored: (): string[] => {
      const res = readKey(storage, SEEN_KEY);
      return res.status === "ok" ? res.value : [];
    },
  };
}

describe("read state: dwell", () => {
  it("marks a row seen after 1.5 s at >= 60 % visibility", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    assert.equal(t.threshold(), VISIBILITY_THRESHOLD);
    t.show(row, 0.8);
    await t.timers.advance(DWELL_MS - 1);
    assert.equal(t.store.seenNow().has("aaa111"), false);
    await t.timers.advance(1);
    assert.ok(t.store.seenNow().has("aaa111"));
    await t.timers.advance(SEEN_FLUSH_MS);
    assert.deepEqual(t.stored(), ["aaa111"]);
  });

  it("does not count a row below 60 %, and a row that leaves early restarts from zero", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row, 0.59);
    await t.timers.advance(5_000);
    assert.equal(t.store.seenNow().size, 0);
    t.show(row, 0.9);
    await t.timers.advance(1_000);
    t.hide(row);
    await t.timers.advance(5_000);
    assert.equal(t.store.seenNow().size, 0);
    t.show(row, 0.9);
    await t.timers.advance(DWELL_MS);
    assert.equal(t.store.seenNow().size, 1);
  });

  it("repeated intersection callbacks do not restart the dwell timer", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row, 0.7);
    await t.timers.advance(1_000);
    t.show(row, 1);
    await t.timers.advance(500);
    assert.ok(t.store.seenNow().has("aaa111"));
  });

  it("markSeen records immediately (opened by click or keyboard)", async () => {
    const t = setup();
    t.store.markSeen("bbb222");
    assert.ok(t.store.seenNow().has("bbb222"));
    t.store.flush();
    assert.deepEqual(t.stored(), ["bbb222"]);
  });

  it("creates the observer lazily, on the first observe (no mount-order dependency)", () => {
    const t = setup();
    assert.equal(t.created(), 0);
    t.store.observe(el("a"), "aaa111");
    t.store.observe(el("b"), "bbb222");
    assert.equal(t.created(), 1);
  });
});

describe("read state: independent of re-renders (V1 timer-reset bug)", () => {
  it("a ref(null) -> ref(el) cycle in the same commit neither unobserves nor restarts the timer", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row);
    // 20 re-renders, one every 100 ms, each re-running an unstable ref callback.
    for (let i = 0; i < 20 && !t.store.seenNow().has("aaa111"); i++) {
      await t.timers.advance(100);
      t.store.observe(null, "aaa111");
      t.store.observe(row, "aaa111");
      t.microtask();
    }
    assert.ok(t.store.seenNow().has("aaa111"), "recorded despite constant re-renders");
    assert.deepEqual(t.log, ["observe row", "unobserve row"], "observed once; unobserved only after it was recorded");
  });

  it("the same holds for the React 19 cleanup form", async () => {
    const t = setup();
    const row = el("row");
    let cleanup = t.store.observe(row, "aaa111");
    t.show(row);
    for (let i = 0; i < 10; i++) {
      await t.timers.advance(100);
      cleanup?.();
      cleanup = t.store.observe(row, "aaa111");
      t.microtask();
    }
    await t.timers.advance(DWELL_MS);
    assert.ok(t.store.seenNow().has("aaa111"));
    assert.equal(t.log.filter((l) => l === "observe row").length, 1);
  });

  it("a real unmount stops observation and cancels the dwell", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row);
    await t.timers.advance(500);
    detach(row);
    t.store.observe(null, "aaa111");
    t.microtask();
    assert.equal(t.observed.size, 0);
    await t.timers.advance(5_000);
    assert.equal(t.store.seenNow().size, 0);
  });

  it("cleanup of an unmounted row releases exactly that element", () => {
    const t = setup();
    const a = el("a");
    const b = el("b");
    const cleanA = t.store.observe(a, "aaa111");
    t.store.observe(b, "aaa111");
    cleanA?.();
    t.microtask();
    assert.deepEqual([...t.observed], [b]);
  });

  it("a detached element never records, even if its timer fires", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row);
    detach(row); // removed without any ref callback
    await t.timers.advance(DWELL_MS);
    assert.equal(t.store.seenNow().size, 0);
  });
});

describe("read state: a story rendered in several sections (V1 duplicate bug)", () => {
  it("tracks every instance and records when ANY of them completes its dwell", async () => {
    const t = setup();
    const first = el("models");
    const second = el("open_local");
    const third = el("releases");
    for (const e of [first, second, third]) t.store.observe(e, "18hfkqe");
    assert.equal(t.observed.size, 3, "later instances do not unobserve earlier ones");
    t.show(first); // only the FIRST instance is on screen
    await t.timers.advance(DWELL_MS);
    assert.ok(t.store.seenNow().has("18hfkqe"));
    assert.equal(t.observed.size, 0, "once recorded, all instances are released");
  });

  it("observe(null) with several instances only drops the ones that left the document", () => {
    const t = setup();
    const a = el("a");
    const b = el("b");
    t.store.observe(a, "aaa111");
    t.store.observe(b, "aaa111");
    detach(a);
    t.store.observe(null, "aaa111");
    t.microtask();
    assert.deepEqual([...t.observed], [b]);
  });

  it("an element re-used for another story is re-registered", async () => {
    const t = setup();
    const row = el("row");
    t.store.observe(row, "aaa111");
    t.show(row);
    await t.timers.advance(1_000);
    t.store.observe(row, "bbb222");
    await t.timers.advance(1_000);
    assert.equal(t.store.seenNow().size, 0, "the old story's dwell was cancelled");
    t.show(row);
    await t.timers.advance(DWELL_MS);
    assert.deepEqual([...t.store.seenNow()], ["bbb222"]);
  });
});

describe("read state: previous sessions only", () => {
  it("wasSeen answers from the list as it was at creation", async () => {
    const storage = createMemoryStorage();
    writeKey(storage, SEEN_KEY, ["old111"]);
    const t = setup(storage);
    assert.equal(t.store.wasSeen("old111"), true);
    t.store.markSeen("new222");
    t.store.flush();
    assert.equal(t.store.wasSeen("new222"), false, "nothing dims while it is being read");
    // Next page load.
    assert.equal(setup(storage).store.wasSeen("new222"), true);
  });

  it("another tab's writes do not change wasSeen in this tab", () => {
    const storage = createMemoryStorage();
    const t = setup(storage);
    writeKey(storage, SEEN_KEY, ["other1"]);
    assert.equal(t.store.wasSeen("other1"), false);
  });
});

describe("read state: clear (Settings > Erase all reader data)", () => {
  it("removes the stored history, forgets previous sessions and drops what was waiting to be written", async () => {
    const storage = createMemoryStorage();
    writeKey(storage, SEEN_KEY, ["old111", "old222"]);
    const t = setup(storage);
    assert.equal(t.store.wasSeen("old111"), true);
    t.store.markSeen("new333"); // queued, not yet flushed
    t.store.clear();
    assert.equal(storage.getItem(STORAGE_KEYS.seen), null, "the key is gone, not an empty list");
    assert.equal(t.store.wasSeen("old111"), false);
    assert.equal(t.store.wasSeen("new333"), false);
    // The queued write does not bring the history back.
    await t.timers.advance(SEEN_FLUSH_MS * 2);
    t.store.flush();
    assert.equal(storage.getItem(STORAGE_KEYS.seen), null);
    // What the reader sees from now on is recorded again.
    t.store.markSeen("later44");
    t.store.flush();
    assert.deepEqual(t.stored(), ["later44"]);
    assert.deepEqual(createReadStateStore({ storage, createObserver: null }).wasSeen("old111"), false);
  });
});

describe("read state: LRU storage", () => {
  it("lruTouch moves re-seen ids to the recent end and evicts the oldest", () => {
    assert.deepEqual(lruTouch(["a", "b", "c"], ["a"], 3), ["b", "c", "a"]);
    assert.deepEqual(lruTouch(["a", "b", "c"], ["d"], 3), ["b", "c", "d"]);
    assert.deepEqual(lruTouch(["a", "b", "c"], ["d", "a"], 3), ["c", "d", "a"]);
    assert.deepEqual(lruTouch(["a", "b", "c", "d"], [], 2), ["c", "d"]);
  });

  it(`caps the stored list at SEEN_LIMIT (${SEEN_LIMIT}) and keeps the most recent`, () => {
    const t = setup();
    const ids = Array.from({ length: SEEN_LIMIT + 77 }, (_, i) => `i${i.toString(36)}`);
    for (const id of ids) t.store.markSeen(id);
    t.store.flush();
    const stored = t.stored();
    assert.equal(stored.length, SEEN_LIMIT);
    assert.equal(stored[stored.length - 1], ids[ids.length - 1]);
    assert.equal(stored[0], ids[77]);
  });

  it("is a true LRU, not FIFO: a story seen again survives eviction", () => {
    const storage = createMemoryStorage();
    writeKey(storage, SEEN_KEY, ["keep1", "old2", "old3"]);
    const t = setup(storage, 3);
    t.store.markSeen("keep1"); // seen again in this session
    t.store.markSeen("new4");
    t.store.flush();
    assert.deepEqual(t.stored(), ["old3", "keep1", "new4"]);
  });

  it("batches a screenful of rows into one write", async () => {
    const inner = createMemoryStorage();
    let writes = 0;
    const storage: StorageLike = { ...inner, getItem: (k) => inner.getItem(k), setItem: (k, v) => { writes++; inner.setItem(k, v); }, removeItem: (k) => inner.removeItem(k), key: (i) => inner.key(i), get length() { return inner.length; } };
    const t = setup(storage);
    const rows = Array.from({ length: 12 }, (_, i) => el(`r${i}`));
    rows.forEach((r, i) => t.store.observe(r, `row${i}`));
    rows.forEach((r) => t.show(r));
    await t.timers.advance(DWELL_MS + SEEN_FLUSH_MS);
    assert.equal(t.stored().length, 12);
    assert.equal(writes, 1);
  });

  it("flush is read-merge-write: two tabs do not clobber each other", () => {
    const storage = createMemoryStorage();
    const a = setup(storage);
    const b = setup(storage);
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) a.store.markSeen(id);
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) b.store.markSeen(id);
    a.store.flush();
    b.store.flush();
    assert.deepEqual(a.stored().sort(), ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5"]);
  });

  it("ignores invalid ids and non-arrays in storage; a failed write is retried on the next flush", () => {
    const storage = createMemoryStorage({ [STORAGE_KEYS.seen]: JSON.stringify({ v: 1, data: ["ok1", 7, "NOT AN ID", "ok2"] }) });
    const t = setup(storage);
    assert.equal(t.store.wasSeen("ok1"), true);
    assert.equal(t.store.wasSeen("NOT AN ID"), false);
    t.store.markSeen("not an id");
    assert.equal(t.store.seenNow().size, 0);

    const full = createReadStateStore({ storage: quotaStorage(), createObserver: null });
    full.markSeen("abc");
    full.flush(); // refused; must not throw
    assert.ok(full.seenNow().has("abc"));
  });

  it("leaves a list written by a newer client alone", () => {
    const newer = '{"v":9,"data":{"lru":["x"]}}';
    const storage = createMemoryStorage({ [STORAGE_KEYS.seen]: newer });
    const t = setup(storage);
    t.store.markSeen("abc");
    t.store.flush();
    assert.equal(storage.getItem(STORAGE_KEYS.seen), newer);
  });
});

describe("read state: environment", () => {
  it("without IntersectionObserver, observe is inert and markSeen still works", () => {
    const storage = createMemoryStorage();
    const store = createReadStateStore({ storage, createObserver: null });
    assert.doesNotThrow(() => store.observe(el("row"), "aaa111"));
    store.markSeen("aaa111");
    store.flush();
    assert.deepEqual(readKey(storage, SEEN_KEY), { status: "ok", value: ["aaa111"], migrated: false });
  });

  it("dispose flushes pending ids and disconnects", () => {
    const t = setup();
    t.store.observe(el("row"), "aaa111");
    t.store.markSeen("bbb222");
    t.store.dispose();
    assert.deepEqual(t.stored(), ["bbb222"]);
    assert.equal(t.observed.size, 0);
    assert.equal(t.store.observe(el("x"), "ccc333"), undefined);
  });
});
