import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SECTION_IDS, isSectionId } from "../../shared/sections";
import { TIME_FILTERS } from "../../shared/time";
import { compileTerms } from "../../shared/text";
import { DEFAULT_SECTION_ORDER, SECTION_PRESETS, WATCH_PRESETS, sectionPresetById, watchPresetById } from "./presets";
import {
  CACHE_KEYS,
  DEFAULT_SETTINGS,
  ROUTE_NAMES,
  STORAGE_KEYS,
  STORAGE_PREFIX,
  ServicesContext,
  V1_STORAGE_KEYS,
  createStore,
  useServices,
  useStore,
  type AppServices,
  type Route,
} from "./services";

describe("src/app/services createStore", () => {
  it("get / set / update / subscribe", () => {
    const s = createStore({ n: 1 });
    const seen: number[] = [];
    const off = s.subscribe(() => seen.push(s.get().n));
    s.set({ n: 2 });
    s.update((p) => ({ n: p.n + 1 }));
    assert.deepEqual(seen, [2, 3]);
    off();
    s.set({ n: 9 });
    assert.deepEqual(seen, [2, 3], "unsubscribed listeners are not called");
    assert.equal(s.get().n, 9);
  });

  it("does not notify when the value is Object.is-equal", () => {
    const same = { n: 1 };
    const s = createStore(same);
    let calls = 0;
    s.subscribe(() => calls++);
    s.set(same);
    s.update((p) => p);
    assert.equal(calls, 0);
    assert.equal(s.get(), same, "get returns a stable reference");
  });

  it("methods do not depend on `this`", () => {
    const { get, set, subscribe } = createStore(1);
    let calls = 0;
    subscribe(() => calls++);
    set(2);
    assert.equal(get(), 2);
    assert.equal(calls, 1);
  });

  it("a listener that unsubscribes during notification does not break the others", () => {
    const s = createStore(0);
    const log: string[] = [];
    const offA = s.subscribe(() => {
      log.push("a");
      offA();
    });
    s.subscribe(() => log.push("b"));
    s.set(1);
    s.set(2);
    assert.deepEqual(log, ["a", "b", "b"]);
  });
});

describe("src/app/services useStore + context", () => {
  it("useStore reads the whole state or a selection", () => {
    const store = createStore({ count: 3, label: "x" });
    const Whole = () => createElement("i", null, JSON.stringify(useStore(store)));
    const Picked = () => createElement("b", null, String(useStore(store, (s) => s.count * 2)));
    assert.equal(renderToStaticMarkup(createElement(Whole)), "<i>{&quot;count&quot;:3,&quot;label&quot;:&quot;x&quot;}</i>");
    assert.equal(renderToStaticMarkup(createElement(Picked)), "<b>6</b>");
  });

  it("useServices throws without a provider and returns the provided services", () => {
    const Probe = () => createElement("span", null, useServices().baseUrl);
    assert.throws(() => renderToStaticMarkup(createElement(Probe)), /no <ServicesContext\.Provider>/);
    const services = { baseUrl: "/ai-drudge-v2/" } as AppServices;
    assert.equal(renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(Probe))), "<span>/ai-drudge-v2/</span>");
  });
});

describe("src/app/services constants", () => {
  it("routes: nine names; the Route union covers each", () => {
    assert.deepEqual([...ROUTE_NAMES], ["home", "section", "search", "new", "watch", "saved", "sources", "settings", "about"]);
    const routes: Route[] = [
      { name: "home" },
      { name: "section", id: "models" },
      { name: "search", q: "x" },
      { name: "new" },
      { name: "watch" },
      { name: "saved", tab: "bookmarks" },
      { name: "saved", tab: "later" },
      { name: "sources" },
      { name: "settings" },
      { name: "about" },
    ];
    assert.deepEqual([...new Set(routes.map((r) => r.name))].sort(), [...ROUTE_NAMES].sort());
  });

  it("default settings", () => {
    assert.deepEqual(DEFAULT_SETTINGS, { theme: "light", density: "compact", sectionOrder: null, hiddenSections: [], collapsed: [], timeFilter: "all", shortcuts: true, dimSeen: true });
    assert.ok((TIME_FILTERS as readonly string[]).includes(DEFAULT_SETTINGS.timeFilter));
  });

  it("storage lives in the aid2: namespace and never collides with V1 keys", () => {
    assert.equal(STORAGE_PREFIX, "aid2:");
    const v2 = [...Object.values(STORAGE_KEYS), ...Object.values(CACHE_KEYS)];
    for (const k of v2) assert.ok(k.startsWith("aid2:"), k);
    assert.equal(new Set(v2).size, v2.length);
    const v1 = Object.values(V1_STORAGE_KEYS);
    assert.equal(v1.length, 8);
    for (const k of v1) assert.ok(k.startsWith("ai-drudge:") && !v2.includes(k as never), k);
  });
});

describe("src/app/presets", () => {
  it("section presets: Default / CISO / Local lab / Markets, each a permutation of the 15 sections", () => {
    assert.deepEqual(SECTION_PRESETS.map((p) => p.label), ["Default", "CISO", "Local lab", "Markets"]);
    assert.equal(new Set(SECTION_PRESETS.map((p) => p.id)).size, 4);
    assert.equal(sectionPresetById("default")?.order, null);
    for (const p of SECTION_PRESETS) {
      if (p.order) assert.deepEqual([...p.order].sort(), [...SECTION_IDS].sort(), p.id);
      assert.ok(p.hidden.every(isSectionId), p.id);
    }
    assert.equal(sectionPresetById("ciso")?.order?.[0], "ai_security");
    assert.equal(sectionPresetById("local-lab")?.order?.[0], "open_local");
    assert.equal(sectionPresetById("markets")?.order?.[0], "money");
    assert.deepEqual([...DEFAULT_SECTION_ORDER], [...SECTION_IDS]);
    assert.equal(sectionPresetById("nope"), undefined);
  });

  it("watch presets: CISO / Local LLM / Finance regulation, all compilable", () => {
    assert.deepEqual(WATCH_PRESETS.map((p) => p.label), ["CISO", "Local LLM", "Finance regulation"]);
    for (const p of WATCH_PRESETS) {
      assert.ok(p.terms.length >= 8, p.id);
      assert.equal(compileTerms(p.terms, { plural: true }).size, p.terms.length, `${p.id}: no blank / duplicate terms`);
    }
    const ciso = compileTerms(watchPresetById("ciso")?.terms ?? [], { plural: true });
    assert.ok(ciso("New prompt-injection attack on MCP servers"));
    assert.ok(ciso("CVE-2026-114938: critical OpenJDK flaw"));
    const fin = compileTerms(watchPresetById("finance-regulation")?.terms ?? [], { plural: true });
    assert.ok(fin("FINRA and SEC issue joint AI guidance"));
    assert.equal(fin("A second look at sector rotation"), null, "'SEC' respects word boundaries");
    const local = compileTerms(watchPresetById("local-llm")?.terms ?? [], { plural: true });
    assert.ok(local("llama.cpp adds new GGUF quantization"));
    // Model families carry their version in the name: the preset matches them (live: plain "Qwen" found 5 of 12).
    for (const title of ["Qwen4-Max: Your New Teammate Has Arrived", "New LoRA Adapter Lifts Qwen3.8 Coding Success From 39% to 65%", "Gemma3 runs on a phone", "Qwen 4 ships"]) {
      assert.ok(compileTerms(["Qwen*", "Gemma*"], { plural: true })(title), title);
      assert.ok(local(title), title);
    }
    assert.equal(watchPresetById("nope"), undefined);
  });
});
