import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SourcesFile } from "../../shared/contract";
import { makeArticle, makeEdition, makeRiver, makeSourceRef } from "../../test/helpers/factories";
import { fixtureSources } from "../../test/helpers/fixtureData";
import { STORAGE_KEYS, V1_STORAGE_KEYS, createStore, type AppServices, type EditionState, type SourcesState } from "../app/services";
import { createEditionStore, createSourcesStore } from "../data/index";
import { browserEnv, createReaderState, resetV2Storage } from "./index";
import { LAST_VISIT_KEY } from "./lastVisit";
import { createMemoryStorage, readKey } from "./storage";
import { createFakeVisibility, createTabs } from "./testkit";
import { namedSourcesOfEdition, namedSourcesOfFile, namedSourcesOfRiver, wireStores } from "./wire";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");

const EMPTY: EditionState = { status: "loading", edition: null, brief: null, stocks: null, river: null, riverStatus: "idle", restStatus: "idle", fetchedAtMs: null, outdatedClient: false };

function fakeData() {
  const edition = createStore<EditionState>(EMPTY);
  const sources = createStore<SourcesState>({ status: "idle", sources: null, health: null });
  let loads = 0;
  let file: SourcesFile | null = fixtureSources;
  const sourcesData = {
    get: sources.get,
    subscribe: sources.subscribe,
    load: async () => {
      loads += 1;
      if (file) sources.set({ status: "ready", sources: file, health: null });
    },
  };
  return { edition, sourcesData, loads: () => loads, setFile: (f: SourcesFile | null) => void (file = f) };
}

describe("createReaderState", () => {
  it("builds every WP7 reader-state service of AppServices", () => {
    const state = createReaderState({ storage: createMemoryStorage(), now: () => NOW, createObserver: null });
    // Compile-time proof that the implementations satisfy the contract.
    const services: Pick<AppServices, "saved" | "mutes" | "readState" | "settings" | "watchlist" | "backup" | "lastVisit"> = state;
    assert.equal(services.lastVisit.get().previousMs, null);
    assert.equal(state.migration.status, "nothing");
    assert.deepEqual(services.watchlist.get().terms, []);
    state.dispose();
  });

  it("runs the V1 import BEFORE the stores and the last-visit read, so the first render sees it", () => {
    const storage = createMemoryStorage({
      [V1_STORAGE_KEYS.theme]: "dark",
      [V1_STORAGE_KEYS.lastVisit]: "2026-11-19T20:15:00.000Z",
      [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(["quantum"]),
    });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    assert.equal(state.migration.status, "migrated");
    assert.equal(state.settings.get().theme, "dark");
    assert.ok(state.mutes.get().sections.has("quantum"));
    assert.equal(state.lastVisit.get().previousMs, Date.parse("2026-11-19T20:15:00.000Z"));
    // Second page load: nothing is imported again.
    assert.equal(createReaderState({ storage, now: () => NOW + 1_000, createObserver: null }).migration.status, "already");
  });

  it("all stores of two tabs stay in sync through one storage event source each", () => {
    const { tabs } = createTabs(2);
    const a = createReaderState({ storage: tabs[0].storage, events: tabs[0].events, now: () => NOW, createObserver: null });
    const b = createReaderState({ storage: tabs[1].storage, events: tabs[1].events, now: () => NOW, createObserver: null });
    const art = makeArticle();
    a.saved.toggleBookmark(art, "S");
    a.mutes.toggleSection("quantum");
    a.settings.set("density", "comfortable");
    a.watchlist.add("MCP");
    assert.ok(b.saved.get().bookmarks.has(art.id));
    assert.ok(b.mutes.get().sections.has("quantum"));
    assert.equal(b.settings.get().density, "comfortable");
    assert.deepEqual(b.watchlist.get().terms, ["MCP"]);
    b.dispose();
    a.watchlist.add("FINRA");
    assert.deepEqual(b.watchlist.get().terms, ["MCP"], "disposed stores stop listening");
  });

  it("reimportV1 merges V1 state again and refreshes the live stores", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(["quantum"]) });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    state.mutes.clear();
    assert.equal(state.mutes.get().sections.size, 0);
    assert.equal(state.reimportV1().status, "migrated");
    assert.ok(state.mutes.get().sections.has("quantum"));
  });

  it("resetV2Storage removes every aid2:* key and nothing else", () => {
    const v1 = { [V1_STORAGE_KEYS.bookmarks]: '["a1"]', [V1_STORAGE_KEYS.theme]: "dark", unrelated: "x" };
    const storage = createMemoryStorage(v1);
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    state.watchlist.add("MCP");
    storage.setItem("aid2:cache:front", "{}");
    const removed = resetV2Storage(storage);
    assert.ok(removed.includes(STORAGE_KEYS.watchlist) && removed.includes(STORAGE_KEYS.migratedFromV1) && removed.includes("aid2:cache:front"));
    assert.deepEqual(Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i) ?? "", storage.getItem(storage.key(i) ?? "")])), v1);
  });

  it("browserEnv is inert outside a browser (memory storage, no globals touched)", () => {
    const env = browserEnv();
    env.local.setItem("aid2:x", "1");
    assert.equal(env.local.getItem("aid2:x"), "1");
    assert.equal(env.events, null);
    assert.equal(env.root, null);
    assert.equal(env.matchMedia, null);
    assert.doesNotThrow(() => env.onPageHide(() => undefined));
    const state = createReaderState({ storage: env.local, events: env.events, now: () => NOW, root: env.root, matchMedia: env.matchMedia });
    assert.deepEqual(state.saved.get().bookmarks.size, 0);
  });
});

describe("wireStores", () => {
  it("refreshes saved snapshots when an edition arrives", () => {
    const state = createReaderState({ storage: createMemoryStorage(), now: () => NOW, createObserver: null });
    const a = makeArticle({ title: "Old title" });
    state.saved.toggleBookmark(a, "example-source");
    const data = fakeData();
    const off = wireStores({ edition: data.edition, saved: state.saved, now: () => NOW });
    const { edition } = makeEdition({ articles: [{ ...a, title: "Corrected title" }] });
    data.edition.set({ ...EMPTY, status: "complete", edition });
    assert.equal(state.saved.get().snapshots[a.id].title, "Corrected title");
    off();
    data.edition.set({ ...EMPTY, status: "complete", edition: makeEdition({ articles: [{ ...a, title: "After unsubscribe" }] }).edition });
    assert.equal(state.saved.get().snapshots[a.id].title, "Corrected title");
  });

  it("resolves pending V1 mute names from the edition's sources, without asking for sources.json", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["The Guardian AI"]) });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    assert.deepEqual(state.mutes.get().pendingNames, ["The Guardian AI"]);
    const data = fakeData();
    wireStores({ edition: data.edition, sourcesData: data.sourcesData, mutes: state.mutes, now: () => NOW });
    const a = makeArticle({ src: "the-guardian-ai" });
    const built = makeEdition({ articles: [a], sources: { "the-guardian-ai": makeSourceRef({ name: "The Guardian AI", publisher: "The Guardian" }) } });
    data.edition.set({ ...EMPTY, status: "complete", edition: built.edition });
    assert.deepEqual([...state.mutes.get().sources], ["the-guardian-ai"]);
    assert.deepEqual(state.mutes.get().pendingNames, []);
    assert.equal(data.loads(), 0);
  });

  it("names the edition cannot resolve trigger ONE sources.json load (aliases), which is final", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["OpenAI News", "A Blog That No Longer Exists"]) });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    const data = fakeData();
    wireStores({ edition: data.edition, sourcesData: data.sourcesData, mutes: state.mutes, now: () => NOW });
    const built = makeEdition({ articles: [makeArticle()] });
    data.edition.set({ ...EMPTY, status: "front", edition: built.frontOnly });
    assert.equal(data.loads(), 0, "waits for the complete edition before paying for sources.json");
    data.edition.set({ ...EMPTY, status: "complete", edition: built.edition });
    data.edition.set({ ...EMPTY, status: "complete", edition: makeEdition({ articles: [makeArticle()] }).edition });
    assert.equal(data.loads(), 1);
    assert.deepEqual([...state.mutes.get().sources], ["openai-news"]);
    assert.deepEqual(state.mutes.get().pendingNames, [], "the unknown name is dropped once the registry was consulted");
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.mutes) ?? "").data.pendingNames.length, 0);
  });

  it("also resolves from the river's source list", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["River Only Source"]) });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    const data = fakeData();
    wireStores({ edition: data.edition, mutes: state.mutes, now: () => NOW });
    const a = makeArticle({ src: "river-only" });
    const river = makeRiver([a], { sources: { "river-only": makeSourceRef({ name: "River Only Source" }) } });
    data.edition.set({ ...EMPTY, river, riverStatus: "ready" });
    assert.deepEqual([...state.mutes.get().sources], ["river-only"]);
  });

  it("records the edition the reader was shown, for the next visit's cut-off", () => {
    const storage = createMemoryStorage();
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    const data = fakeData();
    const built = makeEdition({ articles: [makeArticle()], meta: { buildId: "2026-11-20T08:30:00.000Z", generatedAt: "2026-11-20T08:30:00.000Z" } });
    data.edition.set({ ...EMPTY, status: "front", edition: built.frontOnly });
    wireStores({ edition: data.edition, lastVisit: state.lastVisit, now: () => NOW + 5_000 });
    const rec = readKey(storage, LAST_VISIT_KEY);
    assert.deepEqual(rec.status === "ok" && rec.value, { previousMs: null, lastSeenMs: NOW + 5_000, seenEditionMs: Date.parse("2026-11-20T08:30:00.000Z") });
  });

  it("an edition is 'shown' only in a visible tab: one fetched in the background is noted when the tab is looked at", () => {
    const storage = createMemoryStorage();
    let now = NOW;
    const state = createReaderState({ storage, now: () => now, createObserver: null });
    const data = fakeData();
    const doc = createFakeVisibility("hidden");
    const off = wireStores({ edition: data.edition, lastVisit: state.lastVisit, visibility: doc, now: () => now });
    const built = makeEdition({ articles: [makeArticle()], meta: { buildId: "b1", generatedAt: "2026-11-20T08:30:00.000Z" } });
    data.edition.set({ ...EMPTY, status: "complete", edition: built.edition, fetchedAtMs: NOW });
    const stored = () => {
      const rec = readKey(storage, LAST_VISIT_KEY);
      return rec.status === "ok" ? rec.value : null;
    };
    assert.equal(stored()?.seenEditionMs, null, "hidden: nothing was shown");
    now = NOW + 2 * 60 * 60_000;
    doc.show();
    assert.deepEqual(stored(), { previousMs: null, lastSeenMs: now, seenEditionMs: Date.parse("2026-11-20T08:30:00.000Z") });
    off();
    assert.equal(doc.listenerCount(), 0);
  });

  it("every successful refresh is a heartbeat, and coming back after a long absence rolls the cut-off", () => {
    const storage = createMemoryStorage();
    let now = NOW;
    const state = createReaderState({ storage, now: () => now, createObserver: null });
    const data = fakeData();
    const doc = createFakeVisibility("visible");
    const MIN = 60_000;
    const editionOf = (generatedAt: string) => makeEdition({ articles: [makeArticle()], meta: { buildId: generatedAt, generatedAt } }).edition;
    const e1 = editionOf("2026-11-20T08:38:00.000Z");
    data.edition.set({ ...EMPTY, status: "complete", edition: e1, fetchedAtMs: now });
    wireStores({ edition: data.edition, lastVisit: state.lastVisit, visibility: doc, now: () => now });
    // Watched for two hours: refreshes every 10 min (same edition object, new fetchedAtMs), a build every 30.
    let current = e1;
    for (let m = 10; m <= 120; m += 10) {
      now = NOW + m * MIN;
      if (m % 30 === 0) current = editionOf(new Date(now - 2 * MIN).toISOString());
      data.edition.set({ ...EMPTY, status: "complete", edition: current, fetchedAtMs: now });
    }
    assert.equal(state.lastVisit.get().previousMs, null, "continuous viewing never rolls the session");
    const lastShown = Date.parse(current.meta.generatedAt);
    // Hidden overnight; the store does not refresh in a hidden tab.
    doc.hide();
    now = NOW + 16 * 60 * MIN;
    doc.show();
    assert.equal(state.lastVisit.get().previousMs, lastShown, "the edition that was on screen before the absence");
    data.edition.set({ ...EMPTY, status: "complete", edition: editionOf(new Date(now - 5 * MIN).toISOString()), fetchedAtMs: now });
    assert.equal(state.lastVisit.get().previousMs, lastShown);
    // A reload a minute later keeps it.
    assert.equal(createReaderState({ storage, now: () => now + MIN, createObserver: null }).lastVisit.get().previousMs, lastShown);
  });

  it("a river that is a build ahead of the edition counts as shown ('mark all seen' then empties #/new)", () => {
    const storage = createMemoryStorage();
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    const data = fakeData();
    wireStores({ edition: data.edition, lastVisit: state.lastVisit, now: () => NOW });
    const a = makeArticle();
    const built = makeEdition({ articles: [a], meta: { buildId: "b1", generatedAt: "2026-11-20T08:00:00.000Z" } });
    const river = makeRiver([a], { meta: { buildId: "b2", generatedAt: "2026-11-20T08:30:00.000Z" } });
    data.edition.set({ ...EMPTY, status: "complete", edition: built.edition, river, riverStatus: "ready", fetchedAtMs: NOW });
    state.lastVisit.markAllSeen(NOW);
    assert.equal(state.lastVisit.get().previousMs, Date.parse("2026-11-20T08:30:00.000Z"));
  });

  it("V1 mute names that become pending later (Settings: import again) are resolved without a page reload", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["The Guardian AI"]) });
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    const data = fakeData();
    wireStores({ edition: data.edition, sourcesData: data.sourcesData, mutes: state.mutes, now: () => NOW });
    const a = makeArticle({ src: "the-guardian-ai" });
    const built = makeEdition({ articles: [a], sources: { "the-guardian-ai": makeSourceRef({ name: "The Guardian AI", publisher: "The Guardian" }) } });
    data.edition.set({ ...EMPTY, status: "complete", edition: built.edition });
    assert.deepEqual([...state.mutes.get().sources], ["the-guardian-ai"]);
    assert.equal(data.loads(), 0);
    // The reader mutes two more feeds in V1 and imports again: one is in the edition, one only in sources.json.
    storage.setItem(V1_STORAGE_KEYS.mutedSources, JSON.stringify(["The Guardian AI", "OpenAI News", "A Blog That No Longer Exists"]));
    const report = state.reimportV1();
    assert.equal(report.imported.pendingSourceNames, 3, "this state has no source list of its own");
    assert.equal(data.loads(), 1, "names the edition does not know: sources.json is asked");
    assert.deepEqual([...state.mutes.get().sources].sort(), ["openai-news", "the-guardian-ai"]);
    assert.deepEqual(state.mutes.get().pendingNames, [], "the registry is final: the unknown name is dropped");
    // And again, now that sources.json is loaded: resolved at once, no second load.
    state.mutes.toggleSource("openai-news");
    storage.setItem(V1_STORAGE_KEYS.mutedSources, JSON.stringify(["OpenAI News"]));
    state.reimportV1();
    assert.deepEqual([...state.mutes.get().sources].sort(), ["openai-news", "the-guardian-ai"]);
    assert.deepEqual(state.mutes.get().pendingNames, []);
    assert.equal(data.loads(), 1);
  });

  it("reimportV1(sources) maps display names to ids immediately", () => {
    const storage = createMemoryStorage();
    const state = createReaderState({ storage, now: () => NOW, createObserver: null });
    storage.setItem(V1_STORAGE_KEYS.mutedSources, JSON.stringify(["OpenAI News"]));
    const report = state.reimportV1(namedSourcesOfFile(fixtureSources));
    assert.deepEqual([report.imported.mutedSources, report.imported.pendingSourceNames], [1, 0]);
    assert.deepEqual([...state.mutes.get().sources], ["openai-news"]);
  });

  it("the Sources page data follows the edition to a new build, but only once it was loaded", () => {
    const data = fakeData();
    let reloads = 0;
    const sourcesData = { ...data.sourcesData, reload: async () => void (reloads += 1) };
    wireStores({ edition: data.edition, sourcesData, now: () => NOW });
    const editionOf = (buildId: string) => makeEdition({ articles: [makeArticle()], meta: { buildId, generatedAt: "2026-11-20T08:30:00.000Z" } });
    const b1 = editionOf("b1");
    data.edition.set({ ...EMPTY, status: "front", edition: b1.frontOnly });
    data.edition.set({ ...EMPTY, status: "complete", edition: b1.edition });
    data.edition.set({ ...EMPTY, status: "complete", edition: editionOf("b2").edition });
    assert.equal(reloads, 0, "sources.json was never opened: nothing to keep fresh");
    void sourcesData.load();
    data.edition.set({ ...EMPTY, status: "complete", edition: editionOf("b2").edition });
    assert.equal(reloads, 0, "same build");
    data.edition.set({ ...EMPTY, status: "complete", edition: editionOf("b3").edition });
    assert.equal(reloads, 1);
  });

  it("name helpers", () => {
    const a = makeArticle({ src: "src-a" });
    const built = makeEdition({ articles: [a], sources: { "src-a": makeSourceRef({ name: "Source A" }) } });
    assert.deepEqual(namedSourcesOfEdition(built.edition), [{ id: "src-a", name: "Source A" }]);
    assert.deepEqual(namedSourcesOfRiver(makeRiver([a], { sources: { "src-a": makeSourceRef({ name: "Source A" }) } })), [{ id: "src-a", name: "Source A" }]);
    assert.equal(namedSourcesOfFile(fixtureSources).length, fixtureSources.sources.length);
  });
});

// Type-level: the exact wiring documented in src/state/index.ts compiles against the browser
// environment and yields the WP7 slice of AppServices.
export function _typecheckWiring(): Pick<AppServices, "edition" | "sourcesData" | "saved" | "mutes" | "readState" | "settings" | "watchlist" | "backup" | "lastVisit"> {
  const env = browserEnv();
  const state = createReaderState({ storage: env.local, events: env.events, now: Date.now, root: env.root, matchMedia: env.matchMedia });
  const edition = createEditionStore({ baseUrl: "/", fetch: env.fetch, storage: env.session, now: Date.now, visibility: env.visibility, connectivity: env.connectivity });
  const sourcesData = createSourcesStore({ baseUrl: "/", fetch: env.fetch });
  wireStores({ edition, sourcesData, saved: state.saved, mutes: state.mutes, lastVisit: state.lastVisit, visibility: env.visibility, now: Date.now });
  env.onPageHide(() => state.readState.flush());
  return { edition, sourcesData, ...state };
}
