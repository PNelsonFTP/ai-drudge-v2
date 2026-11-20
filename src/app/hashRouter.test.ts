import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHashRouter, formatRoute, parseRoute, type HashRouterEnv } from "./hashRouter";
import type { Route } from "./services";

/** A window stand-in: assigning location.hash pushes an entry and fires hashchange, like a browser. */
function fakeWindow(initialHash = "") {
  const listeners = new Set<() => void>();
  const entries: string[] = [initialHash];
  let index = 0;
  const fire = (): void => {
    for (const l of [...listeners]) l();
  };
  const env: HashRouterEnv = {
    location: {
      get hash() {
        return entries[index];
      },
      set hash(value: string) {
        const next = value === "" || value.startsWith("#") ? value : `#${value}`;
        if (next === entries[index]) return;
        entries.splice(index + 1);
        entries.push(next);
        index++;
        fire();
      },
    },
    history: {
      replaceState(_data, _unused, url) {
        entries[index] = String(url);
      },
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  return {
    env,
    entries,
    listenerCount: () => listeners.size,
    back() {
      if (index === 0) return;
      index--;
      fire();
    },
    /** The user edits the address bar / clicks an <a href="#...">. */
    userNavigate(hash: string) {
      env.location.hash = hash;
    },
  };
}

describe("createHashRouter", () => {
  it("re-exports the pure helpers", () => {
    assert.equal(formatRoute({ name: "watch" }), "#/watch");
    assert.deepEqual(parseRoute("#/watch"), { name: "watch" });
  });

  it("starts on the route of the current hash", () => {
    assert.deepEqual(createHashRouter(fakeWindow("#/s/cyber").env).get(), { name: "section", id: "cyber" });
    assert.deepEqual(createHashRouter(fakeWindow("").env).get(), { name: "home" });
    assert.deepEqual(createHashRouter(fakeWindow("#/garbage").env).get(), { name: "home" });
  });

  it("go() pushes a history entry, updates the store and notifies once", () => {
    const w = fakeWindow("#/");
    const router = createHashRouter(w.env);
    let notified = 0;
    router.subscribe(() => notified++);
    router.go({ name: "section", id: "models" });
    assert.equal(w.env.location.hash, "#/s/models");
    assert.deepEqual(w.entries, ["#/", "#/s/models"]);
    assert.deepEqual(router.get(), { name: "section", id: "models" });
    assert.equal(notified, 1, "the hashchange echo of our own navigation must not notify again");
  });

  it("go(…, { replace }) swaps the current entry (search-as-you-type)", () => {
    const w = fakeWindow("#/");
    const router = createHashRouter(w.env);
    router.go({ name: "search", q: "o" });
    router.go({ name: "search", q: "op" }, { replace: true });
    router.go({ name: "search", q: "open ai" }, { replace: true });
    assert.deepEqual(w.entries, ["#/", "#/q/open%20ai"]);
    assert.deepEqual(router.get(), { name: "search", q: "open ai" });
    w.back();
    assert.deepEqual(router.get(), { name: "home" });
  });

  it("follows Back / address-bar changes and link clicks", () => {
    const w = fakeWindow("#/");
    const router = createHashRouter(w.env);
    const seen: Route[] = [];
    router.subscribe(() => seen.push(router.get()));
    w.userNavigate("#/saved");
    w.userNavigate("#/later");
    w.back();
    assert.deepEqual(seen, [
      { name: "saved", tab: "bookmarks" },
      { name: "saved", tab: "later" },
      { name: "saved", tab: "bookmarks" },
    ]);
  });

  it("keeps the same Route object while the route is unchanged", () => {
    const w = fakeWindow("#/watch");
    const router = createHashRouter(w.env);
    const before = router.get();
    let notified = 0;
    router.subscribe(() => notified++);
    router.go({ name: "watch" });
    w.userNavigate("#/watch/");
    assert.equal(router.get(), before);
    assert.equal(notified, 0);
  });

  it("does not push a second entry for a route it is already on ('' and '#/' are both home)", () => {
    const w = fakeWindow("");
    const router = createHashRouter(w.env);
    router.go({ name: "home" });
    assert.deepEqual(w.entries, [""]);
  });

  it("ignores in-page anchors (#main, #sec-…): the current route stays", () => {
    const w = fakeWindow("#/s/models");
    const router = createHashRouter(w.env);
    let notified = 0;
    router.subscribe(() => notified++);
    w.userNavigate("#main");
    w.userNavigate("#sec-cyber");
    assert.deepEqual(router.get(), { name: "section", id: "models" });
    assert.equal(notified, 0);
    // Navigating from an anchor hash still works and rewrites the hash.
    router.go({ name: "section", id: "models" });
    assert.equal(w.env.location.hash, "#/s/models");
  });

  it("stores the canonical form of what it is asked to go to", () => {
    const router = createHashRouter(fakeWindow("#/").env);
    router.go({ name: "search", q: "  two   words " });
    assert.deepEqual(router.get(), { name: "search", q: "two words" });
    // A section id that is not in the taxonomy (stale settings, bad caller) lands on home.
    router.go({ name: "section", id: "nope" as never });
    assert.deepEqual(router.get(), { name: "home" });
  });

  it("href() is formatRoute", () => {
    const router = createHashRouter(null);
    assert.equal(router.href({ name: "section", id: "money" }), "#/s/money");
    assert.equal(router.href({ name: "saved", tab: "later" }), "#/later");
  });

  it("works without a window (SSR, tests) as an in-memory router", () => {
    const router = createHashRouter(null);
    assert.deepEqual(router.get(), { name: "home" });
    router.go({ name: "about" });
    assert.deepEqual(router.get(), { name: "about" });
    router.dispose();
  });

  it("dispose() stops listening", () => {
    const w = fakeWindow("#/");
    const router = createHashRouter(w.env);
    assert.equal(w.listenerCount(), 1);
    router.dispose();
    assert.equal(w.listenerCount(), 0);
    w.userNavigate("#/about");
    assert.deepEqual(router.get(), { name: "home" });
  });
});
