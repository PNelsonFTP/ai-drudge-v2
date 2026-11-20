import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sectionRows } from "../../shared/select";
import { ROUTE_NAMES, ServicesContext, useServices, useStore, type Route } from "../../src/app/services";
import { createFakeServices, fakeHref, fakeParseHash } from "./fakeServices";
import { FIXTURE_GENERATED_MS, fixtureBrief, fixtureFront, fixtureHealth, fixtureRiver, fixtureSources, fixtureStocks } from "./fixtureData";

describe("test/helpers/fakeServices", () => {
  it("starts with the complete fixture edition", () => {
    const s = createFakeServices();
    const st = s.edition.get();
    assert.equal(st.status, "complete");
    assert.equal(st.edition?.complete, true);
    assert.equal(st.edition?.leadId, fixtureFront.leadId);
    assert.equal(st.brief?.source, fixtureBrief.source);
    assert.deepEqual(st.stocks?.order, fixtureStocks.order);
    assert.equal(st.river, null);
    assert.equal(s.clock.get(), FIXTURE_GENERATED_MS + 20 * 60_000);
    assert.equal(s.lastVisit.get().previousMs, s.clock.get() - 6 * 3_600_000);
    assert.ok(Math.abs((s.edition.staleHours(s.clock.get()) ?? 0) - 1 / 3) < 1e-9);
    assert.equal(s.baseUrl, "/ai-drudge-v2/");
  });

  it("front -> loadRest -> complete; loadRiver; refresh; notifications", async () => {
    const s = createFakeServices({ loaded: "front" });
    let notified = 0;
    s.edition.subscribe(() => notified++);
    assert.equal(s.edition.get().status, "front");
    const homeRows = sectionRows(s.edition.get().edition!, "industry", { all: true }).length;
    await s.edition.loadRest();
    assert.equal(s.edition.get().status, "complete");
    assert.ok(sectionRows(s.edition.get().edition!, "industry", { all: true }).length > homeRows);
    await s.edition.loadRiver();
    assert.equal(s.edition.get().riverStatus, "ready");
    assert.equal(s.edition.get().river?.rows.length, fixtureRiver.rows.length);
    await s.edition.refresh();
    assert.equal(s.edition.get().river?.rows.length, fixtureRiver.rows.length, "refresh keeps the loaded river");
    assert.ok(notified >= 3);
    assert.deepEqual(s.calls, ["edition.loadRest", "edition.loadRiver", "edition.refresh"]);
  });

  it("loading and error states", async () => {
    const loading = createFakeServices({ loaded: "loading" });
    assert.equal(loading.edition.get().status, "loading");
    assert.equal(loading.edition.get().edition, null);
    assert.equal(loading.edition.staleHours(0), null);
    await loading.edition.refresh();
    assert.equal(loading.edition.get().status, "front");
    const err = createFakeServices({ loaded: "error" });
    assert.equal(err.edition.get().status, "error");
    assert.ok(err.edition.get().error);
  });

  it("saved: toggle, snapshot, consume, remove, clear", () => {
    const s = createFakeServices();
    const e = s.edition.get().edition!;
    const a = e.articles[e.leadId!];
    s.saved.toggleBookmark(a, "The Guardian AI");
    s.saved.toggleLater(a, "The Guardian AI");
    assert.ok(s.saved.get().bookmarks.has(a.id) && s.saved.get().later.has(a.id));
    assert.equal(s.saved.get().snapshots[a.id].title, a.title);
    assert.equal(s.saved.get().snapshots[a.id].sourceName, "The Guardian AI");
    s.saved.consume(a.id);
    assert.equal(s.saved.get().later.has(a.id), false);
    s.saved.toggleBookmark(a, "The Guardian AI");
    assert.equal(s.saved.get().bookmarks.has(a.id), false);
    s.saved.toggleBookmark(a, "x");
    s.saved.remove("bookmarks", a.id);
    assert.equal(s.saved.get().bookmarks.size, 0);
    s.saved.toggleLater(a, "x");
    s.saved.clear("later");
    assert.equal(s.saved.get().later.size, 0);
  });

  it("mutes, settings, watchlist behave like real stores", () => {
    const s = createFakeServices({ watchTerms: ["Anthropic"], mutedSections: ["quantum"], settings: { density: "comfortable" } });
    assert.ok(s.mutes.get().sections.has("quantum"));
    s.mutes.toggleSource("techcrunch-ai");
    s.mutes.toggleSection("quantum");
    assert.ok(s.mutes.get().sources.has("techcrunch-ai"));
    assert.equal(s.mutes.get().sections.has("quantum"), false);
    s.mutes.clear();
    assert.equal(s.mutes.get().sources.size, 0);

    assert.equal(s.settings.get().density, "comfortable");
    s.settings.set("theme", "dark");
    s.settings.set("hiddenSections", ["robotics"]);
    assert.deepEqual([s.settings.get().theme, s.settings.get().hiddenSections], ["dark", ["robotics"]]);
    s.settings.reset();
    assert.equal(s.settings.get().theme, "light");

    const m1 = s.watchlist.matcher();
    assert.equal(s.watchlist.matcher(), m1, "memoised until the terms change");
    assert.ok(m1("Anthropic prices IPO"));
    s.watchlist.add("  llm ");
    s.watchlist.add("LLM");
    assert.deepEqual([...s.watchlist.get().terms], ["Anthropic", "llm"]);
    assert.notEqual(s.watchlist.matcher(), m1);
    assert.ok(s.watchlist.matcher()("Local LLMs"), "plural matching is on");
    s.watchlist.remove("anthropic");
    assert.deepEqual([...s.watchlist.get().terms], ["llm"]);
    s.watchlist.addPreset("ciso");
    assert.ok(s.watchlist.get().terms.includes("prompt injection"));
    assert.equal(s.watchlist.presets.length, 3);
    s.watchlist.clear();
    assert.equal(s.watchlist.matcher()("anything"), null);
  });

  it("router, hover, focus, clock, sources page data, backup", async () => {
    const s = createFakeServices({ route: { name: "section", id: "models" }, previousVisitMs: null, seen: ["abc"] });
    assert.deepEqual(s.router.get(), { name: "section", id: "models" });
    s.router.go({ name: "search", q: "anthropic ipo" });
    assert.deepEqual(s.router.get(), { name: "search", q: "anthropic ipo" });
    assert.equal(s.calls.at(-1), "router.go #/q/anthropic%20ipo");
    assert.equal(s.lastVisit.get().previousMs, null);
    assert.equal(s.readState.wasSeen("abc"), true);
    assert.equal(s.readState.wasSeen("zzz"), false);
    s.hover.show("abc", 10, 20);
    assert.deepEqual(s.hover.get(), { id: "abc", x: 10, y: 20 });
    s.hover.hide();
    assert.equal(s.hover.get(), null);
    s.focus.set("abc");
    assert.equal(s.focus.get(), "abc");
    let ticks = 0;
    s.clock.subscribe(() => ticks++);
    s.setNow(s.clock.get() + 60_000);
    assert.equal(ticks, 1);
    assert.equal(s.sourcesData.get().status, "idle");
    await s.sourcesData.load();
    assert.equal(s.sourcesData.get().sources?.sources.length, fixtureSources.sources.length);
    assert.equal(s.sourcesData.get().health?.feeds.length, fixtureHealth.feeds.length);
    assert.ok(fixtureSources.sources.length > fixtureHealth.feeds.length, "a paused source is listed without a health row");
    const json = s.backup.exportJson();
    assert.deepEqual(s.backup.importJson(json), { ok: true, restored: ["app", "v", "saved", "mutes", "settings", "watchlist"] });
    assert.deepEqual(s.backup.importJson("{nope"), { ok: false, error: "Not valid JSON." });
  });

  it("fakeHref / fakeParseHash round-trip every route", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "section", id: "ai_security" },
      { name: "search", q: 'c++ "prompt injection" / 100%' },
      { name: "new" },
      { name: "watch" },
      { name: "saved", tab: "bookmarks" },
      { name: "saved", tab: "later" },
      { name: "sources" },
      { name: "settings" },
      { name: "about" },
    ];
    assert.deepEqual([...new Set(routes.map((r) => r.name))].sort(), [...ROUTE_NAMES].sort());
    for (const r of routes) assert.deepEqual(fakeParseHash(fakeHref(r)), r, fakeHref(r));
    assert.deepEqual(routes.map(fakeHref).slice(0, 2), ["#/", "#/s/ai_security"]);
    assert.equal(fakeHref({ name: "saved", tab: "later" }), "#/later");
    for (const bad of ["", "#", "#/nope", "#/s/not-a-section", "garbage"]) assert.deepEqual(fakeParseHash(bad), { name: "home" }, bad);
  });

  it("renders through ServicesContext with the placeholder HeadlineRow and a custom slot", () => {
    const s = createFakeServices();
    const lead = s.edition.get().edition!.leadId!;
    const Page = () => {
      const services = useServices();
      const leadId = useStore(services.edition, (st) => st.edition?.leadId ?? null);
      const Row = services.ui.HeadlineRow;
      return leadId ? createElement(Row, { id: leadId }) : null;
    };
    const html = renderToStaticMarkup(createElement(ServicesContext.Provider, { value: s }, createElement(Page)));
    const article = s.edition.get().edition!.articles[lead];
    assert.ok(html.startsWith(`<div data-aid="${lead}" class="headline-row"><a href="${article.url.replace(/&/g, "&amp;")}"`), html);
    assert.ok(html.includes(renderToStaticMarkup(createElement("i", null, article.title)).slice(3, -4)), html);

    const custom = createFakeServices({ ui: { HeadlineRow: ({ id }) => createElement("em", null, id) } });
    const html2 = renderToStaticMarkup(createElement(ServicesContext.Provider, { value: custom }, createElement(Page)));
    assert.equal(html2, `<em>${lead}</em>`);
  });
});
