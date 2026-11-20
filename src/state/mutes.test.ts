import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeArticle, makeEdition, makeRiver } from "../../test/helpers/factories";
import { riverRows, sectionRows } from "../../shared/select";
import { STORAGE_KEYS } from "../app/services";
import { createMutesStore, nameIndex, resolveNames } from "./mutes";
import { createMemoryStorage } from "./storage";
import { createTabs } from "./testkit";

describe("mutes store", () => {
  it("mutes by SourceId and SectionId and persists both", () => {
    const storage = createMemoryStorage();
    const store = createMutesStore({ storage });
    store.toggleSource("the-guardian-ai");
    store.toggleSection("quantum");
    assert.deepEqual([...store.get().sources], ["the-guardian-ai"]);
    assert.deepEqual([...store.get().sections], ["quantum"]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.mutes) ?? ""), {
      v: 1,
      data: { sources: ["the-guardian-ai"], sections: ["quantum"], pendingNames: [] },
    });
    const reloaded = createMutesStore({ storage });
    assert.ok(reloaded.get().sources.has("the-guardian-ai"));
    assert.ok(reloaded.get().sections.has("quantum"));
  });

  it("toggle is symmetric; unknown section ids are ignored", () => {
    const store = createMutesStore({ storage: createMemoryStorage() });
    store.toggleSource("a");
    store.toggleSource("a");
    assert.equal(store.get().sources.size, 0);
    const before = store.get();
    store.toggleSection("model_releases" as never); // a V1 id is not a V2 section
    store.toggleSource("");
    assert.equal(store.get(), before);
  });

  it("the state is a MuteSet the shared selectors understand", () => {
    const a = makeArticle({ src: "muted-source" });
    const b = makeArticle({ src: "other-source" });
    const { edition } = makeEdition({ articles: [a, b] });
    const store = createMutesStore({ storage: createMemoryStorage() });
    store.toggleSource("muted-source");
    assert.deepEqual(sectionRows(edition, "industry", { mutes: store.get() }), [b.id]);
    assert.deepEqual(
      riverRows(makeRiver([a, b]), store.get()).map((r) => r.id),
      [b.id],
    );
    store.toggleSection("industry");
    assert.deepEqual(sectionRows(edition, "industry", { mutes: store.get() }), []);
  });

  it("clear empties sources, sections and pending names; clearing an empty store is a no-op", () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.mutes, JSON.stringify({ v: 1, data: { sources: ["a"], sections: ["cyber"], pendingNames: ["Old Name"] } }));
    const store = createMutesStore({ storage });
    store.clear();
    assert.equal(store.get().sources.size + store.get().sections.size + store.get().pendingNames.length, 0);
    const before = store.get();
    store.clear();
    assert.equal(store.get(), before);
  });

  it("drops unknown sections and non-strings found in storage", () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.mutes, JSON.stringify({ v: 1, data: { sources: ["ok", { evil: true }, 3], sections: ["cyber", "github_repos", null] } }));
    const store = createMutesStore({ storage });
    assert.deepEqual([...store.get().sources], ["ok"]);
    assert.deepEqual([...store.get().sections], ["cyber"]);
    assert.deepEqual(store.get().pendingNames, []);
  });

  it("syncs across tabs", () => {
    const { tabs } = createTabs(2);
    const a = createMutesStore({ storage: tabs[0].storage, events: tabs[0].events });
    const b = createMutesStore({ storage: tabs[1].storage, events: tabs[1].events });
    a.toggleSource("techcrunch-ai");
    assert.ok(b.get().sources.has("techcrunch-ai"));
    b.toggleSource("techcrunch-ai");
    assert.equal(a.get().sources.size, 0);
  });
});

describe("mutes: V1 display names -> SourceId", () => {
  const sources = [
    { id: "the-guardian-ai", name: "The Guardian AI" },
    { id: "zvi", name: "Don't Worry About the Vase", aliases: ["Don't Worry About the Vase (Zvi)", "Zvi"] },
    { id: "impostor", name: "zvi" }, // a NAME beats another source's alias
  ];

  it("nameIndex matches names first, then aliases, case- and whitespace-insensitively", () => {
    const index = nameIndex(sources);
    assert.equal(index.get("the guardian ai"), "the-guardian-ai");
    assert.equal(index.get("don't worry about the vase (zvi)"), "zvi");
    assert.equal(index.get("zvi"), "impostor");
  });

  it("resolveNames splits resolved ids from unknown names", () => {
    assert.deepEqual(resolveNames(["  the  GUARDIAN ai ", "Don't Worry About the Vase (Zvi)", "Defunct Blog"], sources), {
      ids: ["the-guardian-ai", "zvi"],
      unresolved: ["Defunct Blog"],
    });
  });

  it("pending names are resolved when a name list arrives; the rest stays pending", () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.mutes, JSON.stringify({ v: 1, data: { sources: ["kept"], sections: [], pendingNames: ["The Guardian AI", "Defunct Blog"] } }));
    const store = createMutesStore({ storage });
    assert.equal(store.get().sources.has("the-guardian-ai"), false, "not muted until the id is known");
    assert.equal(store.resolvePending(sources), 1);
    assert.deepEqual([...store.get().sources], ["kept", "the-guardian-ai"]);
    assert.deepEqual(store.get().pendingNames, ["Defunct Blog"]);
    // A list that resolves nothing leaves the state object alone.
    const before = store.get();
    assert.equal(store.resolvePending([{ id: "x", name: "X" }]), 1);
    assert.equal(store.get(), before);
    // The full registry is final: names nobody claims are dropped.
    assert.equal(store.resolvePending(sources, { final: true }), 0);
    assert.deepEqual(store.get().pendingNames, []);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.mutes) ?? "").data.pendingNames, []);
  });

  it("dropPendingName forgets one V1 name (case and spacing insensitive) and leaves the rest", () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.mutes, JSON.stringify({ v: 1, data: { sources: ["kept"], sections: ["quantum"], pendingNames: ["The Guardian AI", "Defunct Blog"] } }));
    const store = createMutesStore({ storage });
    let notified = 0;
    store.subscribe(() => notified++);
    store.dropPendingName("  defunct   blog ");
    assert.deepEqual(store.get().pendingNames, ["The Guardian AI"]);
    assert.deepEqual([...store.get().sources], ["kept"]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.mutes) ?? "").data.pendingNames, ["The Guardian AI"]);
    const before = store.get();
    store.dropPendingName("never there");
    assert.equal(store.get(), before);
    assert.equal(notified, 1);
  });

  it("resolvePending without pending names does not write", () => {
    const storage = createMemoryStorage();
    const store = createMutesStore({ storage });
    assert.equal(store.resolvePending(sources), 0);
    assert.equal(storage.getItem(STORAGE_KEYS.mutes), null);
  });
});
