import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { highlightParts } from "../../shared/text";
import { WATCH_PRESETS } from "../app/presets";
import { STORAGE_KEYS } from "../app/services";
import { createMemoryStorage } from "./storage";
import { createTabs } from "./testkit";
import { MAX_TERMS, MAX_TERM_LENGTH, cleanTerm, createWatchlistStore, mergeTerms } from "./watchlist";

const make = (storage = createMemoryStorage()) => ({ storage, store: createWatchlistStore({ storage }) });

describe("watchlist store: terms", () => {
  it("ships empty, with the three suggested presets", () => {
    const { store } = make();
    assert.deepEqual(store.get().terms, []);
    assert.deepEqual(store.presets.map((p) => p.label), ["CISO", "Local LLM", "Finance regulation"]);
    assert.equal(store.presets, WATCH_PRESETS);
  });

  it("add trims, collapses whitespace and de-duplicates case-insensitively, keeping insertion order", () => {
    const { store, storage } = make();
    store.add("  prompt   injection ");
    store.add("FINRA");
    store.add("Prompt Injection");
    store.add("finra");
    store.add("   ");
    assert.deepEqual(store.get().terms, ["prompt injection", "FINRA"]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.watchlist) ?? ""), { v: 1, data: { terms: ["prompt injection", "FINRA"] } });
  });

  it("rejects terms that can never match or are absurdly long", () => {
    assert.equal(cleanTerm("*"), "");
    assert.equal(cleanTerm("**"), "");
    assert.equal(cleanTerm(42), "");
    assert.equal(cleanTerm("x".repeat(MAX_TERM_LENGTH + 1)), "");
    assert.equal(cleanTerm("c++"), "c++");
    assert.equal(cleanTerm("quantiz*"), "quantiz*");
    assert.equal(mergeTerms([], Array.from({ length: MAX_TERMS + 50 }, (_, i) => `term${i}`)).length, MAX_TERMS);
  });

  it("remove is case-insensitive; removing an unknown term changes nothing", () => {
    const { store } = make();
    store.add("Ollama");
    store.add("GGUF");
    const before = store.get();
    store.remove("llama.cpp");
    assert.equal(store.get(), before);
    store.remove("  ollama ");
    assert.deepEqual(store.get().terms, ["GGUF"]);
  });

  it("addPreset adds every term of the preset once; unknown presets are ignored", () => {
    const { store } = make();
    store.add("Ollama");
    store.addPreset("local-llm");
    const local = WATCH_PRESETS.find((p) => p.id === "local-llm");
    assert.ok(local);
    assert.equal(store.get().terms.length, local.terms.length, "Ollama was already there");
    assert.equal(store.get().terms[0], "Ollama");
    const before = store.get();
    store.addPreset("local-llm");
    store.addPreset("nope");
    assert.equal(store.get(), before);
  });

  it("clear, persistence and cross-tab sync", () => {
    const { tabs } = createTabs(2);
    const a = createWatchlistStore({ storage: tabs[0].storage, events: tabs[0].events });
    const b = createWatchlistStore({ storage: tabs[1].storage, events: tabs[1].events });
    a.addPreset("ciso");
    assert.deepEqual(b.get().terms, a.get().terms);
    assert.ok(b.matcher()("New jailbreak technique"));
    b.clear();
    assert.deepEqual(a.get().terms, []);
    assert.equal(a.matcher()("New jailbreak technique"), null);
  });

  it("cleans what it finds in storage", () => {
    const storage = createMemoryStorage({ [STORAGE_KEYS.watchlist]: JSON.stringify({ v: 1, data: { terms: ["ok", 5, "OK", "", "*", { a: 1 }, "two  words"] } }) });
    assert.deepEqual(createWatchlistStore({ storage }).get().terms, ["ok", "two words"]);
    const bad = createMemoryStorage({ [STORAGE_KEYS.watchlist]: JSON.stringify(["bare", "v1-style", "array"]) });
    assert.deepEqual(createWatchlistStore({ storage: bad }).get().terms, []);
  });
});

describe("watchlist store: matcher semantics", () => {
  it("never matches when empty", () => {
    const { store } = make();
    assert.equal(store.matcher().size, 0);
    assert.equal(store.matcher()("anything at all"), null);
  });

  it("is memoised until the terms change", () => {
    const { store } = make();
    store.add("edr");
    const m = store.matcher();
    assert.equal(store.matcher(), m);
    store.add("edr"); // duplicate: no change
    assert.equal(store.matcher(), m);
    store.add("xdr");
    assert.notEqual(store.matcher(), m);
    assert.deepEqual(store.matcher().source, ["edr", "xdr"]);
  });

  it("matches on word boundaries (the V1 search bug: 'intel' in 'Superintelligence')", () => {
    const { store } = make();
    for (const t of ["intel", "arm", "edr", "valuation"]) store.add(t);
    const m = store.matcher();
    assert.equal(m("Why a Computer Scientist Thinks Superintelligence Won't Happen"), null);
    assert.equal(m("Amazon Bedrock adds alarming new warmup evaluation"), null);
    assert.equal(m("Intel unveils new fab")?.term, "intel");
    assert.equal(m("SoftBank's venture arm leads round")?.term, "arm");
    assert.equal(m("Anthropic valuation hits $2tn")?.term, "valuation");
  });

  it("accepts plurals (plural: true), unlike the routing rules", () => {
    const { store } = make();
    store.add("LLM");
    store.add("zero-day");
    store.add("jailbreak");
    const m = store.matcher();
    assert.equal(m("Local LLMs are getting faster")?.term, "LLM");
    assert.equal(m("Two zero-days patched in Chrome")?.term, "zero-day");
    assert.equal(m("New jailbreaks bypass guardrails")?.term, "jailbreak");
    assert.equal(m("Jailbreaking as a service"), null, "plural only - not arbitrary suffixes");
  });

  it("is case-insensitive, treats space and hyphen alike, folds curly apostrophes, supports wildcards", () => {
    const { store } = make();
    for (const t of ["open source", "quantiz*", "CVE-*", "OpenAI's", "llama.cpp"]) store.add(t);
    const m = store.matcher();
    assert.equal(m("An OPEN-SOURCE model")?.term, "open source");
    assert.equal(m("4-bit quantization explained")?.term, "quantiz*");
    assert.equal(m("Patch for CVE-2026-12345 released")?.term, "CVE-*");
    assert.equal(m("How OpenAI’s Performance Factory keeps ChatGPT fast")?.term, "OpenAI's");
    assert.equal(m("llama.cpp b12549 released")?.term, "llama.cpp");
    assert.equal(m("llama_index 0.14 released"), null);
  });

  it("works with highlightParts and reports every distinct term", () => {
    const { store } = make();
    store.add("FINRA");
    store.add("model risk");
    const title = "FINRA flags model risk in AI washing sweep; FINRA fines follow";
    assert.deepEqual(store.matcher().terms(title), ["FINRA", "model risk"]);
    const parts = highlightParts(title, store.matcher());
    assert.equal(parts.map((p) => p.text).join(""), title);
    assert.deepEqual(parts.filter((p) => p.term).map((p) => p.text), ["FINRA", "model risk", "FINRA"]);
  });

  it("every preset term compiles and each preset matches a plausible headline", () => {
    const { store } = make();
    for (const p of WATCH_PRESETS) store.addPreset(p.id);
    const total = new Set(WATCH_PRESETS.flatMap((p) => p.terms.map((t) => t.toLowerCase()))).size;
    assert.equal(store.matcher().size, total);
    const m = store.matcher();
    assert.ok(m("Prompt injection found in MCP server"));
    assert.ok(m("Ollama adds GGUF import for Qwen"));
    assert.ok(m("SEC and FINRA publish AI washing guidance"));
  });
});
