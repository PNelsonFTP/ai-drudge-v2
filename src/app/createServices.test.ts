// The production wiring under node: real stores (src/data, src/state), real router / hover / focus /
// clock, the real HeadlineRow, the real shell and the real pages - on the committed fixture, with a
// fake fetch and in-memory storage. Catches what unit tests of one package cannot: a store that does
// not satisfy the contract another package reads, and runtime exceptions in a full-page render.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { fixtureBrief, fixtureFront, fixtureHealth, fixtureRest, fixtureRiver, fixtureSources, fixtureStocks } from "../../test/helpers/fixtureData";
import { bannerModels } from "../features/chrome/model";
import { HeadlineRow } from "../features/headline/HeadlineRow";
import { HomePage } from "../features/home/HomePage";
import { NewPage } from "../features/new/NewPage";
import { SearchPage } from "../features/search/SearchPage";
import { SectionPage } from "../features/section/SectionPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SourcesPage } from "../features/sources/SourcesPage";
import type { BrowserEnv } from "../state";
import { createMemoryStorage, safeStorage, type StorageLike } from "../state/storage";
import { createFakeFetch, flush, quotaStorage } from "../state/testkit";
import { AppShell } from "./AppShell";
import { createClock } from "./clock";
import { createServices, isFramedByAnotherSite, normalizeBaseUrl, type FrameWindow, type Services } from "./createServices";
import { createHashRouter } from "./hashRouter";
import { buildRouteRegistry } from "./routeRegistry";
import { CACHE_KEYS, STORAGE_KEYS, ServicesContext, V1_STORAGE_KEYS, type Route, type RouteModule } from "./services";

const NOW = Date.parse(fixtureFront.generatedAt) + 20 * 60_000;
const BASE = "/ai-drudge-v2/";

const FILES = {
  "data/v2/front.json": fixtureFront,
  "data/v2/rest.json": fixtureRest,
  "data/v2/river.json": fixtureRiver,
  "data/v2/brief.json": fixtureBrief,
  "data/v2/stocks.json": fixtureStocks,
  "data/v2/sources.json": fixtureSources,
  "data/v2/health.json": fixtureHealth,
};

// The edition store keeps a refresh timer: every services instance is disposed, pass or fail.
const live: Services[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.dispose();
});

function setup(local: Record<string, string> = {}, files: Record<string, unknown> = FILES, cache: Record<string, string> = {}) {
  const net = createFakeFetch(files);
  const localStorage = createMemoryStorage(local);
  const session = createMemoryStorage(cache);
  const pageHide: (() => void)[] = [];
  const env: BrowserEnv = {
    local: localStorage,
    session,
    events: null,
    root: null,
    matchMedia: null,
    fetch: net.fetch as unknown as BrowserEnv["fetch"],
    visibility: null,
    connectivity: null,
    onPageHide: (fn) => void pageHide.push(fn),
  };
  const services = createServices({
    baseUrl: BASE,
    ui: { HeadlineRow },
    env,
    now: () => NOW,
    router: createHashRouter(null),
    clock: createClock({ env: { now: () => NOW, setInterval: () => 0, clearInterval: () => undefined } }),
  });
  live.push(services);
  return { services, net, localStorage, session, pageHide };
}

/** Wait until the edition has front.json (the store starts loading at creation). */
async function loaded(services: Services): Promise<void> {
  for (let i = 0; i < 50 && services.edition.get().status === "loading"; i++) await flush();
  assert.notEqual(services.edition.get().status, "loading");
}

const PAGES: Record<string, RouteModule> = {
  home: { name: "home", Component: HomePage, title: "Top stories" },
  section: { name: "section", Component: SectionPage, title: "Section" },
  search: { name: "search", Component: SearchPage, title: "Search" },
  new: { name: "new", Component: NewPage, title: "New" },
  sources: { name: "sources", Component: SourcesPage, title: "Sources" },
  settings: { name: "settings", Component: SettingsPage, title: "Settings" },
};
const registry = buildRouteRegistry({ eager: Object.fromEntries(Object.entries(PAGES).map(([name, mod]) => [`../features/${name}/route.tsx`, { default: mod }])) });

function renderApp(services: Services, route: Route, render: typeof renderToString = renderToStaticMarkup): string {
  services.router.go(route);
  return render(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: registry })));
}

const count = (html: string, needle: string | RegExp): number => html.split(needle).length - 1;

describe("createServices (production wiring)", () => {
  it("normalises the base URL", () => {
    assert.equal(normalizeBaseUrl("/ai-drudge-v2"), "/ai-drudge-v2/");
    assert.equal(normalizeBaseUrl("/ai-drudge-v2/"), "/ai-drudge-v2/");
    assert.equal(normalizeBaseUrl(""), "/");
  });

  it("loads the edition from <base>data/v2/ with default HTTP caching (so the index.html preloads are reused)", async () => {
    const { services, net } = setup();
    assert.equal(services.edition.get().status, "loading");
    await loaded(services);
    const first = net.calls.slice(0, 3).map((c) => c.url).sort();
    assert.deepEqual(first, [`${BASE}data/v2/brief.json`, `${BASE}data/v2/front.json`, `${BASE}data/v2/stocks.json`]);
    for (const call of net.calls.slice(0, 3)) assert.notEqual(call.cache, "no-cache", call.url);
    const state = services.edition.get();
    assert.equal(state.edition?.leadId, fixtureFront.leadId);
    assert.equal(state.stocks?.order.length, fixtureStocks.order.length);
    assert.equal(services.baseUrl, BASE);
    await services.edition.loadRest();
    assert.equal(services.edition.get().status, "complete");
    assert.equal(services.edition.get().restStatus, "ready");
  });

  it("every AppServices member is the real implementation and they work together", async () => {
    const { services, localStorage, session, pageHide } = setup();
    await loaded(services);
    await services.edition.loadRest();
    const edition = services.edition.get().edition!;
    const lead = edition.articles[edition.top[0]];

    services.saved.toggleBookmark(lead, "X");
    assert.ok(services.saved.get().bookmarks.has(lead.id));
    assert.ok(localStorage.getItem(STORAGE_KEYS.saved)?.includes(lead.id));
    services.settings.patch({ theme: "dark", hiddenSections: ["quantum"] });
    assert.deepEqual([services.settings.get().theme, services.settings.get().hiddenSections], ["dark", ["quantum"]]);
    services.watchlist.add("Anthropic");
    assert.equal(services.watchlist.matcher()("Anthropic files")?.term, "Anthropic");
    services.mutes.toggleSection("robotics");
    assert.ok(services.mutes.get().sections.has("robotics"));
    assert.deepEqual(services.mutes.get().pendingNames, []);

    // First visit: no cut-off; "mark all seen" sets one and persists it. The cut-off is the edition
    // on screen (build clock), not the reader's clock 20 minutes later: a build that is stamped but
    // not deployed yet keeps its stories "new".
    assert.equal(services.lastVisit.get().previousMs, null);
    services.lastVisit.markAllSeen(NOW);
    const shown = Date.parse(fixtureFront.generatedAt);
    assert.equal(services.lastVisit.get().previousMs, shown);
    assert.ok(localStorage.getItem(STORAGE_KEYS.lastVisit)?.includes(`"previousMs":${shown}`));

    assert.equal(services.migration.status, "nothing");
    const preview = services.backup.previewJson(services.backup.exportJson());
    assert.ok(preview.ok && preview.items.some((i) => i.key === STORAGE_KEYS.saved && i.action === "replace"));

    // The payload cache is written for the next page load; the unload hook is registered.
    assert.ok(session.getItem(CACHE_KEYS.front));
    assert.equal(pageHide.length, 1);
    assert.doesNotThrow(() => pageHide[0]());

    services.router.go({ name: "section", id: "ai_security" });
    assert.equal(services.router.href(services.router.get()), "#/s/ai_security");
    assert.equal(services.clock.get(), NOW);
  });

  it("imports V1 reader state once, before the first render, and can run the import again", async () => {
    const { services, localStorage } = setup({
      [V1_STORAGE_KEYS.theme]: "dark",
      [V1_STORAGE_KEYS.bookmarks]: JSON.stringify([fixtureFront.top[0]]),
      [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["No Such Feed"]),
    });
    assert.equal(services.migration.status, "migrated");
    assert.equal(services.migration.imported.bookmarks, 1);
    assert.equal(services.settings.get().theme, "dark");
    assert.deepEqual(services.mutes.get().pendingNames, ["No Such Feed"]);
    services.mutes.dropPendingName("No Such Feed");
    assert.deepEqual(services.mutes.get().pendingNames, []);
    const again = services.reimportV1();
    assert.equal(again.status, "migrated");
    // V1 keys are only ever read.
    assert.equal(localStorage.getItem(V1_STORAGE_KEYS.theme), "dark");
    await loaded(services);
  });
});

describe("createServices: fix-round regressions", () => {
  it("'Import from V1 again' mutes the re-imported sources at once (they used to stay pending until a reload)", async () => {
    // Any source a V1 reader could have muted by name: the one behind the fixture's lead story.
    const guardian = fixtureSources.sources.find((s) => s.id === fixtureFront.articles[fixtureFront.leadId ?? ""]?.src) ?? fixtureSources.sources[0];
    const other = fixtureSources.sources.find((s) => s.id !== guardian.id && s.name !== guardian.name)!;
    const { services, localStorage } = setup({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify([guardian.name]) });
    await loaded(services);
    await services.edition.loadRest();
    for (let i = 0; i < 20 && services.mutes.get().pendingNames.length > 0; i++) await flush();
    assert.deepEqual([...services.mutes.get().sources], [guardian.id]);
    assert.deepEqual(services.mutes.get().pendingNames, []);
    // The reader mutes one more feed in V1 (still live on the same origin) and imports again.
    localStorage.setItem(V1_STORAGE_KEYS.mutedSources, JSON.stringify([guardian.name, other.name, "No Such Feed"]));
    services.reimportV1();
    for (let i = 0; i < 20 && services.mutes.get().pendingNames.length > 0; i++) await flush();
    assert.deepEqual([...services.mutes.get().sources].sort(), [guardian.id, other.id].sort());
    assert.deepEqual(services.mutes.get().pendingNames, [], "resolved (or dropped by the registry) in this session");
  });

  it("a cached edition whose refresh fails raises the 'Could not refresh' banner with Retry", async () => {
    const cache = { [CACHE_KEYS.front]: JSON.stringify(fixtureFront), [CACHE_KEYS.rest]: JSON.stringify(fixtureRest) };
    // front.json answers with a captive-portal page: not retried, so the outcome is immediate.
    const { services } = setup({}, { ...FILES, "data/v2/front.json": "<html>Sign in</html>" }, cache);
    assert.equal(services.edition.get().status, "complete");
    for (let i = 0; i < 50 && services.edition.get().error === undefined; i++) await flush();
    const state = services.edition.get();
    assert.equal(state.status, "complete");
    assert.equal(state.fetchedAtMs, null);
    const banners = bannerModels({ state, staleHours: services.edition.staleHours(NOW + 14 * 3_600_000), online: true });
    assert.deepEqual(banners.map((b) => [b.id, b.action]), [["refresh-failed", "retry"]]);
    assert.match(banners[0].text, /Could not refresh/);
  });

  it("isFramedByAnotherSite: top-level and same-origin frames run the app, a foreign frame does not", () => {
    const location = { origin: "https://example.github.io" };
    const top: FrameWindow = { self: null, top: null, location };
    (top as { self: unknown }).self = top;
    (top as { top: unknown }).top = top;
    assert.equal(isFramedByAnotherSite(top), false);
    const sameOriginFrame: FrameWindow = { self: {}, top: { location }, location };
    assert.equal(isFramedByAnotherSite(sameOriginFrame), false);
    const otherOrigin: FrameWindow = { self: {}, top: { location: { origin: "https://evil.example" } }, location };
    assert.equal(isFramedByAnotherSite(otherOrigin), true);
    // A real cross-origin top throws a SecurityError on any property read.
    const opaqueTop = { get location(): { origin: string } { throw new Error("SecurityError"); } };
    assert.equal(isFramedByAnotherSite({ self: {}, top: opaqueTop, location }), true);
    assert.equal(isFramedByAnotherSite({ self: {}, top: null, location }), false, "a detached window is not a frame");
  });
});

describe("createServices: persistence (are the reader's changes being saved?)", () => {
  function withLocal(local: StorageLike, onWriteError?: (key: string) => void): Services {
    const env: BrowserEnv = {
      local,
      session: createMemoryStorage(),
      events: null,
      root: null,
      matchMedia: null,
      fetch: createFakeFetch(FILES).fetch as unknown as BrowserEnv["fetch"],
      visibility: null,
      connectivity: null,
      onPageHide: () => undefined,
    };
    const services = createServices({ baseUrl: BASE, ui: { HeadlineRow }, env, now: () => NOW, router: createHashRouter(null), clock: createClock({ env: { now: () => NOW, setInterval: () => 0, clearInterval: () => undefined } }), onWriteError });
    live.push(services);
    return services;
  }

  it("working storage: writeRefused stays false through real changes", async () => {
    const services = withLocal(createMemoryStorage());
    await loaded(services);
    assert.deepEqual(services.persistence.get(), { writeRefused: false });
    services.settings.set("theme", "dark");
    services.watchlist.add("FINRA");
    services.mutes.toggleSection("robotics");
    assert.equal(services.persistence.get().writeRefused, false);
  });

  it("a refused write (quota) raises it once, keeps the caller's onWriteError, and never lowers it", async () => {
    const keys: string[] = [];
    const services = withLocal(quotaStorage(), (key) => keys.push(key));
    assert.equal(services.persistence.get().writeRefused, false, "nothing was refused yet: no notice on page load");
    let notified = 0;
    services.persistence.subscribe(() => void notified++);
    services.settings.set("theme", "dark");
    assert.equal(services.persistence.get().writeRefused, true);
    assert.deepEqual(keys, [STORAGE_KEYS.settings]);
    assert.equal(services.settings.get().theme, "dark", "the change still applies in this tab");
    services.watchlist.add("FINRA");
    services.settings.set("theme", "light");
    assert.equal(notified, 1, "subscribers hear of it once, not per refused write");
    assert.equal(keys.length, 3);
    assert.equal(services.persistence.get().writeRefused, true);
  });

  it("no storage at all (blocked site data -> in-memory stand-in): raised by the first change, not by loading the page", async () => {
    const blocked = safeStorage(() => {
      throw new Error("SecurityError");
    });
    const services = withLocal(blocked);
    await loaded(services);
    await services.edition.loadRest();
    assert.equal(services.persistence.get().writeRefused, false, "a reader who only reads is not nagged");
    const edition = services.edition.get().edition!;
    services.saved.toggleBookmark(edition.articles[edition.top[0]], "X");
    assert.equal(services.persistence.get().writeRefused, true);
  });

  it("the shell renders the notice from it (and nothing while saving works)", async () => {
    const full = withLocal(quotaStorage());
    await loaded(full);
    assert.doesNotMatch(renderApp(full, { name: "home" }), /not saving your changes/);
    full.mutes.toggleSection("quantum");
    const html = renderApp(full, { name: "home" });
    assert.match(html, /<div class="banner"><span>This browser is not saving your changes \(its storage is full or blocked\)[^<]*<\/span><button type="button" class="btn">Dismiss<\/button><\/div>/);
    const fine = withLocal(createMemoryStorage());
    await loaded(fine);
    fine.mutes.toggleSection("quantum");
    assert.doesNotMatch(renderApp(fine, { name: "home" }), /not saving your changes/);
  });

  it("dispose() stops watching the stores", () => {
    const services = withLocal(safeStorage(() => null));
    services.dispose();
    services.settings.set("theme", "dark");
    assert.equal(services.persistence.get().writeRefused, false);
  });
});

describe("the whole app on the real services (server render, fixture data)", () => {
  it("home: one h1, TOP STORIES, every section, real headline rows, no exception", async () => {
    const { services } = setup();
    await loaded(services);
    await services.edition.loadRest();
    const html = renderApp(services, { name: "home" }, renderToString);
    assert.equal(count(html, /<h1[\s>]/), 1);
    assert.equal(count(html, /<main[\s>]/), 1);
    assert.match(html, /TOP STORIES/i);
    assert.ok(count(html, 'id="sec-') >= 10, `sections: ${count(html, 'id="sec-')}`);
    assert.ok(count(html, "data-aid=") > 100, `rows: ${count(html, "data-aid=")}`);
    assert.ok(html.includes("data-row-link"), "rows come from the real HeadlineRow");
    assert.ok(html.includes(">Briefing<"), "briefing export is in the toolbar");
  });

  it("secondary pages render through the same services: section, search, new, sources, settings", async () => {
    const { services } = setup();
    await loaded(services);
    await services.edition.loadRest();
    await services.edition.loadRiver();
    await services.sourcesData.load();

    const section = renderApp(services, { name: "section", id: "ai_security" });
    assert.match(section, /AI SECURITY/);
    assert.ok(count(section, "data-aid=") > 5);

    // A word of the lead's headline: the search page lists at least that story.
    const leadTitle = fixtureFront.articles[fixtureFront.leadId ?? ""]?.title ?? "";
    const word = [...(leadTitle.match(/[A-Za-z]{5,}/g) ?? [])].sort((a, b) => b.length - a.length)[0];
    assert.ok(word, leadTitle);
    const search = renderApp(services, { name: "search", q: word.toLowerCase() });
    assert.ok(search.includes(`data-aid="${fixtureFront.leadId}"`), `the lead story is found by "${word}"`);

    const fresh = renderApp(services, { name: "new" });
    assert.match(fresh, /New since your last visit/);
    assert.match(fresh, /first visit/);

    const sources = renderApp(services, { name: "sources" });
    assert.ok(sources.includes("feeds.opml"));
    assert.ok(count(sources, "<tr") > 50 || count(sources, "<li") > 50);

    const settings = renderApp(services, { name: "settings" });
    assert.match(settings, /Import from V1/);
    assert.match(settings, /Backup and restore/);
    for (const html of [section, search, fresh, sources, settings]) assert.equal(count(html, /<h1[\s>]/), 1);
  });

  it("with the network down and no cache the shell still renders and says so", async () => {
    const { services } = setup({}, {});
    const html = renderApp(services, { name: "home" });
    assert.equal(count(html, /<h1[\s>]/), 1);
    assert.equal(count(html, "data-aid="), 0);
  });
});
