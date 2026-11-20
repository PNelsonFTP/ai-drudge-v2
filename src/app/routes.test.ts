import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTION_IDS } from "../../shared/sections";
import { fakeHref, fakeParseHash } from "../../test/helpers/fakeServices";
import {
  DEFAULT_TITLES,
  EXAMPLE_ROUTES,
  MAX_QUERY_LENGTH,
  defaultTitle,
  documentTitle,
  formatRoute,
  isRouteHash,
  isRouteName,
  normalizeQuery,
  pageAnnouncement,
  pageKey,
  parseRoute,
  resolveTitle,
  routeKey,
  sameRoute,
} from "./routes";
import { ROUTE_NAMES, type Route } from "./services";

/** Every route the app can be on: all fixed routes, every section, a spread of queries. */
const ALL_ROUTES: Route[] = [
  { name: "home" },
  ...SECTION_IDS.map((id): Route => ({ name: "section", id })),
  ...["openai", "prompt injection", "c++ & rust", "50% off?", "a/b test", "#hash", "naïve café", "日本語", "x=1&y=2", "llama.cpp", ""].map((q): Route => ({ name: "search", q })),
  { name: "new" },
  { name: "watch" },
  { name: "saved", tab: "bookmarks" },
  { name: "saved", tab: "later" },
  { name: "sources" },
  { name: "settings" },
  { name: "about" },
];

describe("formatRoute / parseRoute", () => {
  it("round-trips every route", () => {
    for (const route of ALL_ROUTES) {
      const hash = formatRoute(route);
      assert.ok(hash.startsWith("#/"), hash);
      assert.deepEqual(parseRoute(hash), route, hash);
      // Canonical: formatting the parsed route gives the same hash again.
      assert.equal(formatRoute(parseRoute(hash)), hash);
    }
  });

  it("covers every route name of the contract", () => {
    const covered = new Set(ALL_ROUTES.map((r) => r.name));
    assert.deepEqual([...covered].sort(), [...ROUTE_NAMES].sort());
    assert.deepEqual(new Set(EXAMPLE_ROUTES.map((r) => r.name)), new Set(ROUTE_NAMES));
    for (const name of ROUTE_NAMES) assert.ok(name in DEFAULT_TITLES);
  });

  it("produces the canonical hashes documented in services.ts", () => {
    const table: [Route, string][] = [
      [{ name: "home" }, "#/"],
      [{ name: "section", id: "ai_security" }, "#/s/ai_security"],
      [{ name: "search", q: "prompt injection" }, "#/q/prompt%20injection"],
      [{ name: "new" }, "#/new"],
      [{ name: "watch" }, "#/watch"],
      [{ name: "saved", tab: "bookmarks" }, "#/saved"],
      [{ name: "saved", tab: "later" }, "#/later"],
      [{ name: "sources" }, "#/sources"],
      [{ name: "settings" }, "#/settings"],
      [{ name: "about" }, "#/about"],
    ];
    for (const [route, hash] of table) assert.equal(formatRoute(route), hash);
  });

  it("agrees with the fake router the other UI packages test against", () => {
    for (const route of ALL_ROUTES) {
      if (route.name === "search" && route.q === "") continue; // "#/q/" is shell-only (the fake has no empty search)
      assert.equal(formatRoute(route), fakeHref(route));
      assert.deepEqual(parseRoute(fakeHref(route)), fakeParseHash(fakeHref(route)));
    }
  });

  it("resolves unknown, empty and malformed hashes to home", () => {
    for (const hash of ["", "#", "#/", "/", "#/nope", "#/s", "#/s/", "#/s/not_a_section", "#/s/models/extra", "#/saved/extra", "#main", "#sec-models", "#/story/abc", "#//", "#/%E0%A4%A"]) {
      assert.deepEqual(parseRoute(hash), { name: "home" }, JSON.stringify(hash));
    }
  });

  it("is lenient about a missing '#', a missing slash, case of the keyword and a trailing slash", () => {
    assert.deepEqual(parseRoute("/s/models"), { name: "section", id: "models" });
    assert.deepEqual(parseRoute("s/models"), { name: "section", id: "models" });
    assert.deepEqual(parseRoute("#/S/models/"), { name: "section", id: "models" });
    assert.deepEqual(parseRoute("#/Watch/"), { name: "watch" });
    assert.deepEqual(parseRoute("#watch"), { name: "watch" });
    assert.deepEqual(parseRoute("#/bookmarks"), { name: "saved", tab: "bookmarks" });
    assert.deepEqual(parseRoute("#/home"), { name: "home" });
    // Section ids themselves are case-sensitive data.
    assert.deepEqual(parseRoute("#/s/MODELS"), { name: "home" });
  });

  it("decodes search queries defensively", () => {
    assert.deepEqual(parseRoute("#/q/open%20ai"), { name: "search", q: "open ai" });
    assert.deepEqual(parseRoute("#/q/a/b"), { name: "search", q: "a/b" });
    assert.deepEqual(parseRoute("#/q"), { name: "search", q: "" });
    assert.deepEqual(parseRoute("#/q/"), { name: "search", q: "" });
    // A lone "%" is not valid percent-encoding: keep the text instead of throwing.
    assert.deepEqual(parseRoute("#/q/100%"), { name: "search", q: "100%" });
    assert.deepEqual(parseRoute("#/q/%20%20two%20%20%20spaces%20"), { name: "search", q: "two spaces" });
    assert.equal(parseRoute(`#/q/${"x".repeat(5000)}`).name, "search");
    assert.equal((parseRoute(`#/q/${"x".repeat(5000)}`) as { q: string }).q.length, MAX_QUERY_LENGTH);
  });

  it("never throws on hostile input", () => {
    for (const hash of ["#/q/%", "#/s/%", "#/%%%", "#/q/\u0000", "#/s/__proto__", "#/constructor", "#/toString", "#/hasOwnProperty/x"]) {
      assert.doesNotThrow(() => parseRoute(hash), hash);
    }
    assert.deepEqual(parseRoute("#/constructor"), { name: "home" });
    assert.deepEqual(parseRoute("#/s/__proto__"), { name: "home" });
  });

  it("normalizes the query on the way out", () => {
    assert.equal(formatRoute({ name: "search", q: "  open   ai " }), "#/q/open%20ai");
    assert.equal(normalizeQuery(" a \n b\t"), "a b");
  });
});

describe("route helpers", () => {
  it("isRouteHash separates routes from in-page anchors", () => {
    for (const h of ["", "#", "#/", "#/s/models", "#/anything"]) assert.equal(isRouteHash(h), true, h);
    for (const h of ["#main", "#sec-models", "#q"]) assert.equal(isRouteHash(h), false, h);
  });

  it("sameRoute / routeKey compare by value", () => {
    assert.ok(sameRoute({ name: "section", id: "models" }, { name: "section", id: "models" }));
    assert.ok(!sameRoute({ name: "section", id: "models" }, { name: "section", id: "cyber" }));
    assert.ok(!sameRoute({ name: "saved", tab: "later" }, { name: "saved", tab: "bookmarks" }));
    assert.equal(new Set(ALL_ROUTES.map(routeKey)).size, ALL_ROUTES.length);
  });

  it("pageKey is stable while a search is refined", () => {
    assert.equal(pageKey({ name: "search", q: "a" }), pageKey({ name: "search", q: "ab" }));
    assert.notEqual(pageKey({ name: "section", id: "models" }), pageKey({ name: "section", id: "cyber" }));
    assert.notEqual(pageKey({ name: "home" }), pageKey({ name: "search", q: "" }));
  });

  it("pageAnnouncement: '<title> page' for every page, and 'Front page' - not 'Front page page' - for home", () => {
    assert.equal(pageAnnouncement({ name: "home" }), "Front page");
    assert.equal(pageAnnouncement({ name: "watch" }), "Watchlist page");
    assert.equal(pageAnnouncement({ name: "section", id: "ai_security" }), "AI SECURITY page");
    assert.equal(pageAnnouncement({ name: "search", q: "qwen" }), "Search: qwen page");
    assert.equal(pageAnnouncement({ name: "saved", tab: "later" }), "Read later page");
    for (const route of EXAMPLE_ROUTES) {
      const said = pageAnnouncement(route);
      assert.doesNotMatch(said, /page page/i, said);
      assert.match(said, /\S page$/, said);
    }
  });

  it("titles: defaults, module titles and document.title", () => {
    assert.equal(defaultTitle({ name: "home" }), "");
    assert.equal(defaultTitle({ name: "section", id: "ai_security" }), "AI SECURITY");
    assert.equal(defaultTitle({ name: "search", q: "qwen" }), "Search: qwen");
    assert.equal(defaultTitle({ name: "saved", tab: "later" }), "Read later");
    assert.equal(resolveTitle("Custom", { name: "watch" }), "Custom");
    assert.equal(resolveTitle((r) => `T:${r.name}`, { name: "watch" }), "T:watch");
    assert.equal(resolveTitle("", { name: "watch" }), "Watchlist");
    assert.equal(resolveTitle(undefined, { name: "about" }), "About");
    assert.equal(
      resolveTitle(() => {
        throw new Error("boom");
      }, { name: "about" }),
      "About",
    );
    assert.equal(documentTitle(""), "AI DRUDGE");
    assert.equal(documentTitle("AI Drudge"), "AI DRUDGE");
    assert.equal(documentTitle("Watchlist"), "Watchlist - AI DRUDGE");
  });

  it("isRouteName", () => {
    assert.ok(isRouteName("home"));
    assert.ok(!isRouteName("chrome"));
    assert.ok(!isRouteName(undefined));
  });
});
