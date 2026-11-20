// hoverStore, focusStore and clock: the three small shell stores.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLOCK_TICK_MS, createClock, type ClockEnv } from "./clock";
import { createFocusStore } from "./focusStore";
import { HOVER_HIDE_DELAY_MS, HOVER_OPEN_DELAY_MS, createHoverStore } from "./hoverStore";

/** Manual timers: advance(ms) runs what is due. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(nextId, { at: now + ms, fn, every: null });
      return nextId++;
    },
    setInterval: (fn: () => void, ms: number) => {
      timers.set(nextId, { at: now + ms, fn, every: ms });
      return nextId++;
    },
    clear: (handle: unknown) => void timers.delete(handle as number),
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every === null) timers.delete(id);
        else t.at += t.every;
        t.fn();
      }
      now = end;
    },
  };
}

function hover(opts: { canHover?: boolean; openDelayMs?: number } = {}) {
  const t = fakeTimers();
  const store = createHoverStore({ canHover: () => opts.canHover ?? true, openDelayMs: opts.openDelayMs, setTimeout: t.setTimeout, clearTimeout: t.clear });
  return { t, store };
}

describe("createHoverStore", () => {
  it("opens after the intent delay, not at once", () => {
    const { t, store } = hover();
    store.show("a1", 10, 20);
    assert.equal(store.get(), null);
    t.advance(HOVER_OPEN_DELAY_MS - 1);
    assert.equal(store.get(), null);
    t.advance(1);
    assert.deepEqual(store.get(), { id: "a1", x: 10, y: 20 });
  });

  it("scanning past a row never opens a card", () => {
    const { t, store } = hover();
    store.show("a1", 0, 0);
    t.advance(100);
    store.hide();
    t.advance(1000);
    assert.equal(store.get(), null);
    assert.equal(t.pending(), 0);
  });

  it("hide() waits 200 ms; hold() (pointer entered the card) cancels it", () => {
    const { t, store } = hover({ openDelayMs: 0 });
    store.show("a1", 0, 0);
    store.hide();
    t.advance(HOVER_HIDE_DELAY_MS - 1);
    assert.ok(store.get());
    store.hold();
    t.advance(1000);
    assert.deepEqual(store.get(), { id: "a1", x: 0, y: 0 }, "held open");
    store.hide();
    t.advance(HOVER_HIDE_DELAY_MS);
    assert.equal(store.get(), null);
  });

  it("moving to the next row swaps the card immediately and cancels the pending hide", () => {
    const { t, store } = hover({ openDelayMs: 0 });
    store.show("a1", 0, 0);
    store.hide();
    t.advance(50);
    store.show("a2", 5, 5);
    t.advance(1000);
    assert.deepEqual(store.get(), { id: "a2", x: 5, y: 5 });
  });

  it("keeps the same state object for an identical show() and notifies only on change", () => {
    const { store } = hover({ openDelayMs: 0 });
    let notified = 0;
    store.subscribe(() => notified++);
    store.show("a1", 1, 2);
    const first = store.get();
    store.show("a1", 1, 2);
    assert.equal(store.get(), first);
    assert.equal(notified, 1);
  });

  it("does nothing on devices without a hover pointer (touch)", () => {
    const { t, store } = hover({ canHover: false });
    store.show("a1", 0, 0);
    t.advance(5000);
    assert.equal(store.get(), null);
    assert.equal(t.pending(), 0);
  });

  it("defaults to no hover outside a browser", () => {
    const store = createHoverStore();
    store.show("a1", 0, 0);
    assert.equal(store.get(), null);
    store.hide();
    store.hold();
  });

  it("repeated hide() calls schedule one timer", () => {
    const { t, store } = hover({ openDelayMs: 0 });
    store.show("a1", 0, 0);
    store.hide();
    store.hide();
    assert.equal(t.pending(), 1);
  });
});

describe("createFocusStore", () => {
  it("holds the cursor article id and notifies on change only", () => {
    const focus = createFocusStore();
    assert.equal(focus.get(), null);
    let notified = 0;
    const unsubscribe = focus.subscribe(() => notified++);
    focus.set("abc");
    focus.set("abc");
    focus.set(null);
    assert.equal(notified, 2);
    unsubscribe();
    focus.set("x");
    assert.equal(notified, 2);
    assert.equal(createFocusStore("seed").get(), "seed");
  });
});

function clockEnv(t: ReturnType<typeof fakeTimers>, start = 1_000_000) {
  let hidden = false;
  const visibility = new Set<() => void>();
  const env: ClockEnv = {
    now: () => start + t.now(),
    setInterval: t.setInterval,
    clearInterval: t.clear,
    isHidden: () => hidden,
    onVisibilityChange: (listener) => {
      visibility.add(listener);
      return () => void visibility.delete(listener);
    },
  };
  return {
    env,
    start,
    setHidden(value: boolean) {
      hidden = value;
      for (const l of [...visibility]) l();
    },
    visibilityListeners: () => visibility.size,
  };
}

describe("createClock", () => {
  it("schedules nothing until someone subscribes (SSR and tests leak no timer)", () => {
    const t = fakeTimers();
    const c = clockEnv(t);
    const clock = createClock({ env: c.env });
    assert.equal(clock.get(), c.start);
    assert.equal(t.pending(), 0);
    assert.equal(c.visibilityListeners(), 0);
  });

  it("ticks once a minute while subscribed and stops with the last subscriber", () => {
    const t = fakeTimers();
    const c = clockEnv(t);
    const clock = createClock({ env: c.env });
    const seen: number[] = [];
    const a = clock.subscribe(() => seen.push(clock.get()));
    const b = clock.subscribe(() => undefined);
    assert.equal(t.pending(), 1, "one timer for all subscribers");
    t.advance(CLOCK_TICK_MS * 3);
    assert.deepEqual(seen, [c.start + 60_000, c.start + 120_000, c.start + 180_000]);
    a();
    a(); // double unsubscribe must not unbalance the count
    assert.equal(t.pending(), 1);
    b();
    assert.equal(t.pending(), 0);
    assert.equal(c.visibilityListeners(), 0);
  });

  it("pauses while the tab is hidden and catches up the moment it is visible again", () => {
    const t = fakeTimers();
    const c = clockEnv(t);
    const clock = createClock({ env: c.env });
    let notified = 0;
    clock.subscribe(() => notified++);
    c.setHidden(true);
    assert.equal(t.pending(), 0);
    t.advance(CLOCK_TICK_MS * 30);
    assert.equal(notified, 0);
    c.setHidden(false);
    assert.equal(notified, 1);
    assert.equal(clock.get(), c.start + CLOCK_TICK_MS * 30);
    assert.equal(t.pending(), 1);
  });

  it("does not change its value just because someone subscribed (no re-render storm at mount)", () => {
    const t = fakeTimers();
    const c = clockEnv(t);
    const clock = createClock({ env: c.env });
    t.advance(250);
    let notified = 0;
    const stop = clock.subscribe(() => notified++);
    assert.equal(clock.get(), c.start);
    assert.equal(notified, 0);
    stop();
  });

  it("re-reads the time when a subscriber arrives late, and on tick()", () => {
    const t = fakeTimers();
    const c = clockEnv(t);
    const clock = createClock({ env: c.env });
    t.advance(5 * 60_000);
    assert.equal(clock.get(), c.start, "idle clock keeps its creation time");
    const stop = clock.subscribe(() => undefined);
    assert.equal(clock.get(), c.start + 5 * 60_000);
    t.advance(1234);
    clock.tick();
    assert.equal(clock.get(), c.start + 5 * 60_000 + 1234);
    stop();
  });

  it("honours a custom tick length and works without a document", () => {
    const t = fakeTimers();
    const clock = createClock({ tickMs: 1000, env: { now: () => t.now(), setInterval: t.setInterval, clearInterval: t.clear } });
    let notified = 0;
    const stop = clock.subscribe(() => notified++);
    t.advance(3000);
    assert.equal(notified, 3);
    stop();
  });

  it("default environment: creating and reading it needs no browser and starts no timer", () => {
    const before = Date.now();
    const clock = createClock();
    assert.ok(clock.get() >= before);
  });
});
