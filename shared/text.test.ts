import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NO_TERMS,
  STOPWORDS,
  compileTerms,
  escapeRegExp,
  highlightParts,
  jaccard,
  matchesQuery,
  normalizeForSearch,
  parseQuery,
  queryWordPattern,
  slugify,
  tokenSet,
  tokenize,
} from "./text";

describe("shared/text tokenize", () => {
  it("lower-cases, drops stopwords and short tokens, keeps digits", () => {
    assert.deepEqual(tokenize("The New AI Model Is Here"), ["model"]);
    assert.deepEqual(tokenize("OpenAI releases GPT-5.1 for everyone"), ["openai", "releases", "gpt", "5.1", "everyone"]);
    assert.deepEqual(tokenize("Claude 5 vs Claude 4"), ["claude", "5", "vs", "claude", "4"]);
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
  });

  it("keeps dotted / underscored identifiers whole so llama.cpp and llama_index stay distinct", () => {
    assert.deepEqual(tokenize("llama.cpp b12549 released"), ["llama.cpp", "b12549", "released"]);
    assert.deepEqual(tokenize("run-llama/llama_index v0.14.2"), ["run", "llama", "llama_index", "v0.14.2"]);
    assert.equal(jaccard(tokenSet("llama.cpp b12549 released"), tokenSet("llama_index v0.14.2 released")) < 0.4, true);
  });

  it("splits hyphens, folds curly apostrophes and possessives", () => {
    assert.deepEqual(tokenize("Open-source record-breaking IPO"), ["open", "source", "record", "breaking", "ipo"]);
    assert.deepEqual(tokenize("Anthropic’s IPO"), ["anthropic", "ipo"]);
    assert.deepEqual(tokenize("Anthropic's IPO"), ["anthropic", "ipo"]);
  });

  it("honours custom stopwords and minLength", () => {
    assert.deepEqual(tokenize("AI is new", { stopwords: new Set() }), ["ai", "is", "new"]);
    assert.deepEqual(tokenize("an LLM app", { minLength: 4 }), []);
    assert.ok(STOPWORDS.has("ai") && STOPWORDS.has("the"));
  });

  it("jaccard", () => {
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
    assert.equal(jaccard(new Set(["a"]), new Set(["a"])), 1);
    assert.equal(jaccard(new Set(), new Set(["a"])), 0);
    assert.equal(jaccard(new Set(["a"]), new Set()), 0);
  });

  it("slugify", () => {
    assert.equal(slugify("Don't Worry About the Vase (Zvi)"), "dont-worry-about-the-vase-zvi");
    assert.equal(slugify("ggml-org/llama.cpp"), "ggml-org-llama-cpp");
    assert.equal(slugify("HN: AI (150+ points)"), "hn-ai-150-points");
    assert.equal(slugify("  Café  Résumé "), "cafe-resume");
  });
});

describe("shared/text compileTerms (word-boundary matcher)", () => {
  it("respects word boundaries (the V1 false positives)", () => {
    const m = compileTerms(["edr", "valuation", "series a", "ipo"]);
    assert.equal(m("Amazon Bedrock adds new models"), null, "edr must not match bedrock");
    assert.equal(m("A new evaluation suite for agents"), null, "valuation must not match evaluation");
    assert.equal(m("Forecasting time-series and tabular data"), null, "series a must not match 'time-series and'");
    assert.equal(m("CrowdStrike EDR update")?.term, "edr");
    assert.equal(m("Startup hits $3B valuation")?.term, "valuation");
    assert.equal(m("Acme raises Series A round")?.term, "series a");
    assert.equal(m("Anthropic launches-the-IPO roadshow")?.term, "ipo");
    assert.equal(m("the iPod era"), null);
  });

  it("is case-insensitive and reports the position in the original text", () => {
    const m = compileTerms(["Prompt Injection"]);
    const text = "New PROMPT injection attack found";
    const hit = m(text);
    assert.ok(hit);
    assert.equal(text.slice(hit.index, hit.index + hit.length), "PROMPT injection");
    assert.equal(hit.term, "Prompt Injection");
  });

  it("treats whitespace and hyphens in a term as interchangeable", () => {
    const m = compileTerms(["open source", "post-quantum"]);
    assert.ok(m("An open-source release"));
    assert.ok(m("An open  source release"));
    assert.ok(m("NIST post quantum standards"));
    assert.ok(m("NIST post-quantum standards"));
    assert.equal(m("opensource"), null);
  });

  it("supports * prefix / suffix wildcards", () => {
    const m = compileTerms(["quantiz*", "*bench", "gpt-*"]);
    const t = "Quantization of SWEbench models with GPT-5";
    assert.deepEqual(m.all(t).map((h) => t.slice(h.index, h.index + h.length)), ["Quantization", "SWEbench", "GPT-5"]);
    assert.equal(compileTerms(["launch*"])("They relaunched it"), null, "prefix wildcard still needs a left boundary");
    assert.ok(compileTerms(["launch*"])("OpenAI launches a model"));
  });

  it("puts no boundary on a punctuation edge", () => {
    assert.ok(compileTerms(["c++"])("Rewriting C++ in Rust"));
    assert.ok(compileTerms(["$nvda"])("Buy $NVDA now"));
    assert.ok(compileTerms(["gpt-"])("the gpt-4o family"));
    assert.equal(compileTerms(["gpt-4"])("the gpt-4o family"), null, "letter edge keeps its boundary");
  });

  it("plural option accepts a trailing s / es", () => {
    assert.equal(compileTerms(["llm"])("Local LLMs are fast"), null);
    assert.ok(compileTerms(["llm"], { plural: true })("Local LLMs are fast"));
    assert.ok(compileTerms(["patch"], { plural: true })("Tuesday patches"));
    assert.equal(compileTerms(["llm"], { plural: true })("LLMstudio"), null);
  });

  it("matches possessives and curly apostrophes", () => {
    assert.ok(compileTerms(["openai"])("OpenAI’s new plan"));
    assert.ok(compileTerms(["don't"])("Don’t panic"));
  });

  it("all / terms / count: distinct terms, longest wins at one position", () => {
    const m = compileTerms(["open source", "open source model", "agent"]);
    const text = "An open source model for agent builders; another agent";
    assert.deepEqual(m.terms(text), ["open source model", "agent"]);
    assert.equal(m.count(text), 2);
    assert.equal(m.all(text).length, 3);
    assert.equal(m.count("nothing here"), 0);
  });

  it("ignores blanks and duplicates; an empty list never matches", () => {
    const m = compileTerms(["  ", "", "AI", "ai", " ai "]);
    assert.equal(m.size, 1);
    assert.deepEqual([...m.source], ["AI"]);
    assert.equal(NO_TERMS("anything"), null);
    assert.equal(NO_TERMS.size, 0);
    assert.deepEqual(NO_TERMS.all("anything"), []);
    assert.equal(compileTerms(["x"])(null), null);
    assert.equal(compileTerms(["x"])(undefined), null);
  });

  it("is reusable across calls (no lastIndex leakage)", () => {
    const m = compileTerms(["nvidia"]);
    for (let i = 0; i < 3; i++) assert.ok(m("Nvidia earnings"));
    assert.equal(m("AMD earnings"), null);
    assert.ok(m("Nvidia earnings"));
  });

  it("escapes regex metacharacters in terms", () => {
    assert.ok(compileTerms(["a.b"])("see a.b here"));
    assert.equal(compileTerms(["a.b"])("see axb here"), null);
    assert.ok(compileTerms(["(beta)"])("now (beta) only"));
    assert.equal(escapeRegExp("a.b*c"), "a\\.b\\*c");
  });

  it("highlightParts splits text and round-trips", () => {
    const m = compileTerms(["sec", "finra"]);
    const text = "SEC and FINRA issue AI guidance";
    const parts = highlightParts(text, m);
    assert.deepEqual(parts, [{ text: "SEC", term: "sec" }, { text: " and " }, { text: "FINRA", term: "finra" }, { text: " issue AI guidance" }]);
    assert.equal(parts.map((p) => p.text).join(""), text);
    assert.deepEqual(highlightParts("plain", m), [{ text: "plain" }]);
    assert.deepEqual(highlightParts("", m), []);
  });
});

describe("shared/text search helpers", () => {
  it("normalizeForSearch folds case, diacritics, quotes, dashes, whitespace", () => {
    assert.equal(normalizeForSearch("  Café  “Résumé” — it’s  "), 'cafe "resume" - it\'s');
    assert.equal(normalizeForSearch(null), "");
  });

  it("parseQuery: words, quoted phrases, dedupe", () => {
    assert.deepEqual(parseQuery("  Anthropic   IPO "), ["anthropic", "ipo"]);
    assert.deepEqual(parseQuery('"prompt injection" MCP'), ["prompt injection", "mcp"]);
    assert.deepEqual(parseQuery("“prompt injection” mcp"), ["prompt injection", "mcp"]);
    assert.deepEqual(parseQuery("ai AI"), ["ai"]);
    assert.deepEqual(parseQuery("   "), []);
    assert.deepEqual(parseQuery(null), []);
  });

  it("matchesQuery is a multi-word AND over a normalised haystack", () => {
    const hay = normalizeForSearch("Anthropic prices IPO at $83 a share — TechCrunch");
    assert.equal(matchesQuery(hay, parseQuery("ipo anthropic")), true);
    assert.equal(matchesQuery(hay, parseQuery("ipo openai")), false);
    assert.equal(matchesQuery(hay, parseQuery('"prices ipo"')), true);
    assert.equal(matchesQuery(hay, parseQuery('"ipo prices"')), false);
    assert.equal(matchesQuery(hay, []), false);
  });

  it("matchesQuery never matches mid-word, and a short word must be a whole word", () => {
    const has = (text: string, query: string): boolean => matchesQuery(normalizeForSearch(text), parseQuery(query));
    // The review's cases: "intel" returned 18 stories, none about Intel; "arm" returned Charm, warmup, alarming.
    for (const text of ["Artificial Intelligence weekly", "Superintelligence timelines", "IntelliProve raises a seed round", "Talos Intelligence"]) assert.equal(has(text, "intel"), false, text);
    for (const text of ["Intel 18A yields improve", "What Intel's foundry needs", "TSMC, Intel and Samsung", "(Intel)"]) assert.equal(has(text, "intel"), true, text);
    for (const text of ["Meta Muse Charm", "An alarming report", "LR warmup schedules"]) assert.equal(has(text, "arm"), false, text);
    assert.equal(has("SoftBank's venture arm invests", "arm"), true);
    // A plural or possessive ending still counts as the word.
    assert.equal(has("Why LLMs hallucinate", "llm"), true);
    assert.equal(has("Coding agents compared", "agent"), true);
    assert.equal(has("OpenAI’s roadmap", "openai"), true);
    // Longer words may be the start of a word (search as you type), never the middle or the end.
    assert.equal(has("Anthropic files for an IPO", "anthrop"), true);
    assert.equal(has("Misanthropic takes", "anthropic"), false);
    assert.equal(has("Quantization-aware training", "quantiz"), true);
    // Punctuation is a boundary; symbols inside a word are literal.
    assert.equal(has("llama.cpp b6000 released", "llama.cpp"), true);
    assert.equal(has("GPT-5.5 pricing", "gpt"), true);
    assert.equal(has("C++ bindings for MLX", "c++"), true);
    assert.equal(has("A $2tn valuation", "$2tn"), true);
  });

  it("a short word that ends in a letter finds versioned names: qwen -> Qwen4-Max, Qwen3.8 (live: 5 of 12 headlines found)", () => {
    const has = (text: string, q: string): boolean => matchesQuery(normalizeForSearch(text), parseQuery(q));
    for (const title of [
      "Qwen4-Max: Your New Teammate Has Arrived",
      "Unsloth Qwen3.8-27B Quantizations - Dynamic v3.1 Update",
      "Hy4 Flash vs. Qwen3.8 Flash Next: Architecture, KV Cache, and Token Efficiency",
      "New LoRA Adapter Lifts Qwen3.8 Coding Success From 39% to 65%",
      "Add Qwen3.8-Flash-Next (qwen4_exp) model support",
      "Trending on Hugging Face: harness-hub/Qwen3.8-27B-pi-adapted",
      "A weekly digest and Qwen4's First Look",
      "Qwen 4 ships with open weights",
    ]) {
      assert.equal(has(title, "qwen"), true, title);
    }
    assert.equal(has("GPT6 rumours", "gpt"), true);
    assert.equal(has("Gemma3 on a laptop", "gemma"), true);
    // Still a whole word where letters follow, and still never mid-word.
    assert.equal(has("EmbeddingGemma 2 released", "gemma"), false);
    assert.equal(has("Artificial Intelligence weekly", "intel"), false);
    assert.equal(has("Agentic workflows", "agent"), false);
    assert.equal(has("Qwenhua opens an office", "qwen"), false);
    // A word that ends in a digit keeps the strict rule: "o1" is not "o11".
    assert.equal(has("OpenAI o11 preview", "o1"), false);
    assert.equal(has("OpenAI o1 preview", "o1"), true);
  });

  it("matchesQuery with prefix: true lets a short word start a longer one (filter boxes)", () => {
    const hay = normalizeForSearch("Anthropic News · anthropic.com · scrape");
    assert.equal(matchesQuery(hay, parseQuery("anth"), { prefix: true }), true);
    assert.equal(matchesQuery(hay, parseQuery("anth")), false);
    assert.equal(matchesQuery(hay, parseQuery("thropic"), { prefix: true }), false);
    assert.equal(queryWordPattern("anth", { prefix: true }), queryWordPattern("anth", { prefix: true }), "patterns are cached");
    assert.notEqual(queryWordPattern("anth", { prefix: true }), queryWordPattern("anth"));
  });
});
