import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureSources } from "../../test/helpers/fixtureData";
import { CACHE_KEYS, STORAGE_KEYS, STORAGE_PREFIX, V1_STORAGE_KEYS } from "../app/services";
import { LAST_VISIT_KEY, readLastVisit } from "./lastVisit";
import { MIGRATED_KEY, migrateV1, mutedSectionsOf, parseCounts, readV1State, skippedCategoriesOf } from "./migrateV1";
import { v1ImportLine, v1SkippedLine } from "../features/settings/model";
import { MUTES_KEY, createMutesStore } from "./mutes";
import { SEEN_KEY, createReadStateStore } from "./readState";
import { SAVED_KEY, createSavedStore } from "./saved";
import { SETTINGS_KEY, createSettingsStore } from "./settings";
import { createMemoryStorage, listKeys, readKey, writeKey, type StorageLike } from "./storage";
import { quotaStorage, recordWrites } from "./testkit";
import { namedSourcesOfFile } from "./wire";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const V1_VISIT = "2026-11-19T20:15:00.000Z";

// A V1 Article as V1 snapshotted it.
const v1Article = (id: string, title: string, source: string, url = `https://example.com/${id}`) => ({
  id,
  title,
  url,
  source,
  category: "industry_news",
  priority: "high",
  publishedAt: "2026-11-19T18:00:00.000Z",
  publishedRaw: "Thu, 19 Nov 2026 18:00:00 GMT",
  summary: "Summary text",
  collectedAt: "2026-11-19T20:08:38.159Z",
});

/** Everything a V1 reader can have in localStorage (all 8 keys), plus V1's sessionStorage-style cache keys. */
function v1Storage(): Record<string, string> {
  return {
    [V1_STORAGE_KEYS.bookmarks]: JSON.stringify(["18hfkqe", "nosnap1"]),
    [V1_STORAGE_KEYS.readLater]: JSON.stringify(["later01", "18hfkqe"]),
    [V1_STORAGE_KEYS.snapshots]: JSON.stringify({
      "18hfkqe": v1Article("18hfkqe", "llama.cpp b12549 released", "ggml-org/llama.cpp"),
      later01: v1Article("later01", "Anthropic valued at $2tn", "The Guardian AI"),
      evil001: v1Article("evil001", "Planted", "X", "javascript:alert(1)"),
    }),
    [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["OpenAI News", "A Blog That No Longer Exists"]),
    [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(["quantum", "safety_policy", "cyber_threats", "cyber_defense", "not_a_category"]),
    [V1_STORAGE_KEYS.seen]: JSON.stringify(["seen001", "seen002", "seen003"]),
    [V1_STORAGE_KEYS.theme]: "dark",
    [V1_STORAGE_KEYS.lastVisit]: V1_VISIT,
    "ai-drudge:cache:headlines": JSON.stringify({ generatedAt: "2026-11-19T20:08:38Z", categories: [] }),
  };
}

const v1Only = (storage: StorageLike): Record<string, string | null> =>
  Object.fromEntries(Object.keys(v1Storage()).map((k) => [k, storage.getItem(k)]));

describe("migrateV1: imports every V1 key", () => {
  it("bookmarks, read-later, snapshots, muted sources + categories, seen ids, theme, last visit", () => {
    const storage = createMemoryStorage(v1Storage());
    const report = migrateV1(storage, { now: () => NOW, sources: namedSourcesOfFile(fixtureSources) });
    assert.equal(report.status, "migrated");
    assert.deepEqual(report.imported, {
      bookmarks: 2,
      later: 2,
      snapshots: 2,
      mutedSources: 1,
      pendingSourceNames: 1,
      mutedSections: 4,
      // The one V1 id no V2 section knows; the four real ones all became section mutes.
      skippedCategories: ["not_a_category"],
      seen: 3,
      theme: true,
      lastVisit: true,
    });

    // The V2 stores see the imported state on their first read.
    const saved = createSavedStore({ storage, now: () => NOW }).get();
    assert.deepEqual([...saved.bookmarks], ["18hfkqe", "nosnap1"]);
    assert.deepEqual([...saved.later], ["later01", "18hfkqe"]);
    assert.deepEqual(saved.snapshots["18hfkqe"], {
      id: "18hfkqe",
      title: "llama.cpp b12549 released",
      url: "https://example.com/18hfkqe",
      sourceName: "ggml-org/llama.cpp",
      publishedAt: "2026-11-19T18:00:00.000Z",
      savedAt: "2026-11-20T09:00:00.000Z",
    });
    assert.equal(saved.snapshots.later01.sourceName, "The Guardian AI");
    assert.equal(saved.snapshots.evil001, undefined, "unreferenced and javascript: - never imported");
    assert.equal(saved.snapshots.nosnap1, undefined, "id kept; reconcile() completes or drops it once an edition is loaded");

    const mutes = createMutesStore({ storage }).get();
    assert.deepEqual([...mutes.sources], ["openai-news"], "display name -> SourceId through sources.json");
    assert.deepEqual(mutes.pendingNames, ["A Blog That No Longer Exists"]);
    assert.deepEqual([...mutes.sections].sort(), ["cyber", "policy", "quantum", "safety"], "safety_policy maps to BOTH halves; two cyber ids fold into one");

    const read = createReadStateStore({ storage, createObserver: null });
    for (const id of ["seen001", "seen002", "seen003"]) assert.equal(read.wasSeen(id), true);

    assert.equal(createSettingsStore({ storage }).get().theme, "dark");

    // V1's last visit becomes the cut-off of the first V2 session.
    assert.equal(readLastVisit(storage, NOW).get().previousMs, Date.parse(V1_VISIT));

    const marker = readKey(storage, MIGRATED_KEY);
    assert.equal(marker.status, "ok");
    assert.equal(marker.status === "ok" && marker.value.at, "2026-11-20T09:00:00.000Z");
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.migratedFromV1) ?? "").v, 1);
  });

  it("a malformed stored marker is read field by field: it can neither break the Settings page nor claim counts (review: skippedCategories 5)", () => {
    const stored = (imported: unknown): ReturnType<typeof migrateV1> => {
      const storage = createMemoryStorage({ [STORAGE_KEYS.migratedFromV1]: JSON.stringify({ v: 1, data: { at: "2026-11-20T09:00:00.000Z", imported } }) });
      return migrateV1(storage, { now: () => NOW });
    };
    for (const bad of [5, { a: 1 }, "open_local", null, true]) {
      const report = stored({ bookmarks: 2, skippedCategories: bad });
      assert.equal(report.status, "already");
      assert.equal(report.imported.bookmarks, 2);
      assert.equal(report.imported.skippedCategories, undefined, JSON.stringify(bad));
      assert.doesNotThrow(() => v1ImportLine(report));
    }
    const mixed = stored({ bookmarks: "7", later: -3, snapshots: 1.9, seen: Number.NaN, theme: "yes", lastVisit: true, skippedCategories: ["funding", 7, null, "products", "funding"], extra: "ignored" });
    assert.deepEqual(mixed.imported, { bookmarks: 0, later: 0, snapshots: 1, mutedSources: 0, pendingSourceNames: 0, mutedSections: 0, seen: 0, theme: false, lastVisit: true, skippedCategories: ["funding", "products"] });
    assert.deepEqual(parseCounts(undefined), parseCounts({}));
    assert.equal(parseCounts({ skippedCategories: Array.from({ length: 500 }, (_, i) => `c${i}`) }).skippedCategories?.length, 32, "capped");
    // The model guards on its own too (a report built by other code, a restored backup).
    assert.equal(v1SkippedLine({ skippedCategories: 5 as unknown as string[] }), "");
    assert.equal(v1SkippedLine({ skippedCategories: "open" as unknown as string[] }), "");
  });

  it("without sources.json every muted source name is parked as pending", () => {
    const storage = createMemoryStorage(v1Storage());
    const report = migrateV1(storage, { now: () => NOW });
    assert.equal(report.imported.mutedSources, 0);
    assert.equal(report.imported.pendingSourceNames, 2);
    const mutes = createMutesStore({ storage });
    assert.equal(mutes.get().sources.size, 0);
    assert.deepEqual(mutes.get().pendingNames, ["OpenAI News", "A Blog That No Longer Exists"]);
    // ... and resolved as soon as the registry is available.
    mutes.resolvePending(namedSourcesOfFile(fixtureSources), { final: true });
    assert.deepEqual([...mutes.get().sources], ["openai-news"]);
    assert.deepEqual(mutes.get().pendingNames, []);
  });

  it("a V2 section that folds two V1 categories is muted only when BOTH were muted in V1", () => {
    const sectionsFor = (categories: string[]): string[] => {
      const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(categories) });
      const report = migrateV1(storage, { now: () => NOW });
      const sections = [...createMutesStore({ storage }).get().sections].sort();
      assert.equal(report.imported.mutedSections, sections.length);
      return sections;
    };
    // Half of a merged section: the other half (a different V1 column) must stay visible.
    assert.deepEqual(sectionsFor(["open_source"]), [], "LOCAL & OPEN MODELS also carries V1 local_models");
    assert.deepEqual(sectionsFor(["funding"]), [], "MARKETS & DEALS also carries V1 ai_finance");
    assert.deepEqual(sectionsFor(["cyber_defense"]), [], "CYBER WIRE also carries V1 cyber_threats");
    assert.deepEqual(sectionsFor(["products"]), [], "AGENTS & TOOLS also carries V1 agents_tools");
    // Both halves muted: the merged section is muted.
    assert.deepEqual(sectionsFor(["open_source", "local_models"]), ["open_local"]);
    assert.deepEqual(sectionsFor(["ai_finance", "funding"]), ["money"]);
    assert.deepEqual(sectionsFor(["agents_tools", "products"]), ["tools"]);
    // V1 had ONE safety_policy column: both V2 halves follow it. 1:1 categories are unchanged.
    assert.deepEqual(sectionsFor(["safety_policy"]), ["policy", "safety"]);
    assert.deepEqual(sectionsFor(["quantum"]), ["quantum"]);
    assert.deepEqual(sectionsFor(["open_source", "safety_policy", "products", "funding", "cyber_defense"]), ["policy", "safety"]);
    assert.deepEqual(mutedSectionsOf(["not_a_category"]), []);
    assert.deepEqual(mutedSectionsOf([]), []);
  });

  it("reports the V1 muted categories it did not carry over (half of a merged section, unknown ids) - and only those", () => {
    const skippedFor = (categories: string[]): readonly string[] | undefined => {
      const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(categories) });
      const report = migrateV1(storage, { now: () => NOW });
      // The marker keeps it, so a later page load ("already") can still name them in Settings.
      const again = migrateV1(storage, { now: () => NOW + 1 });
      assert.equal(again.status, "already");
      assert.deepEqual(again.imported.skippedCategories, report.imported.skippedCategories);
      return report.imported.skippedCategories;
    };
    assert.deepEqual(skippedFor(["open_source"]), ["open_source"], "LOCAL & OPEN MODELS stays visible: say so");
    assert.deepEqual(skippedFor(["open_source", "quantum", "funding"]), ["open_source", "funding"]);
    assert.deepEqual(skippedFor(["not_a_category", "quantum"]), ["not_a_category"]);
    // Everything carried over: the field is absent, not an empty list.
    assert.equal(skippedFor(["quantum"]), undefined);
    assert.equal(skippedFor(["open_source", "local_models", "safety_policy"]), undefined);
    assert.deepEqual(skippedCategoriesOf(["funding", "funding", "ai_finance", "products", "funding"]), ["products"], "both halves of MONEY muted; distinct, V1 order");
    assert.deepEqual(skippedCategoriesOf([]), []);
    // No muted categories in V1 at all: nothing to report.
    const none = migrateV1(createMemoryStorage({ [V1_STORAGE_KEYS.theme]: JSON.stringify("dark") }), { now: () => NOW });
    assert.equal("skippedCategories" in none.imported, false);
  });

  it("a forced re-import does not mute a merged section the reader half-muted in V1", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedCategories]: JSON.stringify(["open_source", "quantum"]) });
    migrateV1(storage, { now: () => NOW });
    migrateV1(storage, { now: () => NOW + 1, force: true });
    assert.deepEqual([...createMutesStore({ storage }).get().sections], ["quantum"]);
  });

  it("aliases map renamed sources", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.mutedSources]: JSON.stringify(["Don't Worry About the Vase (Zvi)"]) });
    migrateV1(storage, { now: () => NOW, sources: [{ id: "zvi", name: "Zvi Mowshowitz", aliases: ["Don't Worry About the Vase (Zvi)"] }] });
    assert.deepEqual([...createMutesStore({ storage }).get().sources], ["zvi"]);
  });
});

describe("migrateV1: read-only towards V1", () => {
  it("never writes, removes or changes any ai-drudge:* key - and only writes aid2:* keys", () => {
    const rec = recordWrites(createMemoryStorage(v1Storage()));
    const before = v1Only(rec.storage);
    migrateV1(rec.storage, { now: () => NOW, sources: namedSourcesOfFile(fixtureSources) });
    assert.ok(rec.writes.length >= 6);
    for (const w of rec.writes) {
      assert.equal(w.op, "set");
      assert.ok(w.key.startsWith(STORAGE_PREFIX), `wrote ${w.key}`);
    }
    assert.deepEqual(v1Only(rec.storage), before, "V1 values are byte-identical");
    assert.deepEqual(
      [...new Set(rec.writes.map((w) => w.key))].sort(),
      [STORAGE_KEYS.lastVisit, STORAGE_KEYS.migratedFromV1, STORAGE_KEYS.mutes, STORAGE_KEYS.saved, STORAGE_KEYS.seen, STORAGE_KEYS.settings].sort(),
    );
  });

  it("the whole V2 life cycle (stores, mutations, backup) leaves V1 keys untouched", async () => {
    const { createReaderState } = await import("./index");
    const rec = recordWrites(createMemoryStorage(v1Storage()));
    const before = v1Only(rec.storage);
    const state = createReaderState({ storage: rec.storage, now: () => NOW, createObserver: null });
    state.settings.set("theme", "light");
    state.mutes.clear();
    state.saved.clear("bookmarks");
    state.saved.clear("later");
    state.watchlist.addPreset("ciso");
    state.readState.markSeen("abc123");
    state.readState.flush();
    state.backup.importJson(state.backup.exportJson());
    state.reimportV1();
    assert.deepEqual(v1Only(rec.storage), before);
    assert.ok(rec.writes.every((w) => w.key.startsWith(STORAGE_PREFIX)));
  });

  it("does not import V1's payload cache, and V2 cache keys are in the V2 namespace", () => {
    const storage = createMemoryStorage(v1Storage());
    migrateV1(storage, { now: () => NOW });
    for (const key of listKeys(storage)) assert.ok(!key.includes(":cache:"), key);
    for (const key of Object.values(CACHE_KEYS)) assert.ok(key.startsWith(STORAGE_PREFIX));
  });
});

describe("migrateV1: one-time", () => {
  it("the second run reads nothing and writes nothing", () => {
    const storage = createMemoryStorage(v1Storage());
    const first = migrateV1(storage, { now: () => NOW });
    // The reader un-bookmarks in V2; V1 state is unchanged, so a repeat import would resurrect it.
    const saved = createSavedStore({ storage, now: () => NOW });
    saved.clear("bookmarks");
    const rec = recordWrites(storage);
    const second = migrateV1(rec.storage, { now: () => NOW + 1 });
    assert.equal(second.status, "already");
    assert.deepEqual(second.imported, first.imported);
    assert.equal(first.at, new Date(NOW).toISOString());
    assert.equal(second.at, first.at, "the report carries the time of the original import");
    assert.deepEqual(rec.writes, []);
    assert.equal(createSavedStore({ storage, now: () => NOW }).get().bookmarks.size, 0);
  });

  it("with no V1 state on the origin nothing is written - not even the marker", () => {
    const rec = recordWrites(createMemoryStorage({ unrelated: "x" }));
    assert.equal(migrateV1(rec.storage, { now: () => NOW }).status, "nothing");
    assert.deepEqual(rec.writes, []);
  });

  it("force re-imports and MERGES: V2 state the reader created since is kept", () => {
    const storage = createMemoryStorage(v1Storage());
    migrateV1(storage, { now: () => NOW });
    const saved = createSavedStore({ storage, now: () => NOW });
    saved.clear("bookmarks");
    saved.toggleBookmark({ id: "v2only1", url: "https://example.com/v2", title: "Saved in V2", src: "s", publishedAt: null, firstSeenAt: "2026-11-20T08:00:00.000Z", home: "industry", tier: 3 }, "Source");
    createSettingsStore({ storage }).set("theme", "light");
    createMutesStore({ storage }).toggleSource("v2-muted");

    const report = migrateV1(storage, { now: () => NOW + 60_000, force: true });
    assert.equal(report.status, "migrated");
    assert.deepEqual({ b: report.imported.bookmarks, l: report.imported.later, theme: report.imported.theme }, { b: 2, l: 0, theme: false });
    const after = createSavedStore({ storage, now: () => NOW }).get();
    assert.deepEqual([...after.bookmarks].sort(), ["18hfkqe", "nosnap1", "v2only1"]);
    assert.equal(after.snapshots.v2only1.title, "Saved in V2");
    assert.equal(createSettingsStore({ storage }).get().theme, "light", "a theme chosen in V2 wins over V1's");
    assert.ok(createMutesStore({ storage }).get().sources.has("v2-muted"));
  });

  it("a refused write leaves no marker, so the import is retried on the next load", () => {
    const inner = createMemoryStorage(v1Storage());
    assert.equal(migrateV1(quotaStorage(inner), { now: () => NOW }).status, "failed");
    assert.equal(inner.getItem(STORAGE_KEYS.migratedFromV1), null);
    assert.equal(migrateV1(inner, { now: () => NOW }).status, "migrated");
  });
});

describe("migrateV1: hostile or broken V1 data", () => {
  it("readV1State validates everything and never throws", () => {
    const storage = createMemoryStorage({
      [V1_STORAGE_KEYS.bookmarks]: '{"v":2,"ids":["a1"]}', // a shape V1 never wrote
      [V1_STORAGE_KEYS.readLater]: "[[[",
      [V1_STORAGE_KEYS.snapshots]: '["array"]',
      [V1_STORAGE_KEYS.mutedSources]: JSON.stringify([{ toString: "x" }, "", "Real Name", 5]),
      [V1_STORAGE_KEYS.mutedCategories]: "null",
      [V1_STORAGE_KEYS.seen]: JSON.stringify(["ok1", "<script>", 9, "ok1"]),
      [V1_STORAGE_KEYS.theme]: "solarized",
      [V1_STORAGE_KEYS.lastVisit]: "yesterday-ish",
    });
    assert.deepEqual(readV1State(storage, "2026-11-20T09:00:00.000Z"), {
      found: true,
      bookmarks: [],
      later: [],
      snapshots: {},
      mutedSourceNames: ["Real Name"],
      mutedCategories: [],
      seen: ["ok1"],
      theme: null,
      lastVisitMs: null,
    });
  });

  it("a last visit in the future is ignored; seen ids are capped to the LRU size", () => {
    const many = Array.from({ length: 700 }, (_, i) => `s${i}`);
    const storage = createMemoryStorage({
      [V1_STORAGE_KEYS.lastVisit]: "2030-01-01T00:00:00.000Z",
      [V1_STORAGE_KEYS.seen]: JSON.stringify(many),
    });
    const report = migrateV1(storage, { now: () => NOW });
    assert.equal(report.imported.lastVisit, false);
    assert.equal(readKey(storage, LAST_VISIT_KEY).status, "empty");
    const seen = readKey(storage, SEEN_KEY);
    assert.equal(seen.status === "ok" && seen.value.length, 500);
    assert.equal(seen.status === "ok" && seen.value[499], "s699", "the most recent V1 ids are the ones kept");
  });

  it("V2 keys written by a newer client are left alone", () => {
    const newer = JSON.stringify({ v: 99, data: {} });
    const storage = createMemoryStorage({ ...v1Storage(), [STORAGE_KEYS.saved]: newer, [STORAGE_KEYS.settings]: newer });
    const report = migrateV1(storage, { now: () => NOW });
    assert.equal(report.status, "migrated");
    assert.equal(report.imported.bookmarks, 0);
    assert.equal(report.imported.theme, false);
    assert.equal(storage.getItem(STORAGE_KEYS.saved), newer);
    assert.equal(storage.getItem(STORAGE_KEYS.settings), newer);
    assert.equal(readKey(storage, MUTES_KEY).status, "ok", "the other keys are still imported");
  });

  it("existing V2 seen ids stay at the recent end of the LRU", () => {
    const storage = createMemoryStorage({ [V1_STORAGE_KEYS.seen]: JSON.stringify(["v1a", "v1b", "both1"]) });
    writeKey(storage, SEEN_KEY, ["both1", "v2a"]);
    migrateV1(storage, { now: () => NOW });
    const seen = readKey(storage, SEEN_KEY);
    assert.deepEqual(seen.status === "ok" && seen.value, ["v1a", "v1b", "both1", "v2a"]);
    assert.equal(readKey(storage, SAVED_KEY).status, "empty");
    assert.equal(readKey(storage, SETTINGS_KEY).status, "empty");
  });
});
