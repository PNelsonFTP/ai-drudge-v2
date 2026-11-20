import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTerms } from "../../../shared/text";
import type { SectionId } from "../../../shared/sections";
import { aiTitleTerm, cleanForMatch, describeMatch, isAiRelevant, matchItem, summaryIsReadable, type MatchInput } from "./matcher";

function item(title: string, over: Partial<MatchInput> = {}): MatchInput {
  return { title, summary: null, kind: "rss", flags: [], home: "industry", scope: "ai", ...over };
}
const sections = (i: MatchInput): SectionId[] => matchItem(i).map((m) => m.section);

describe("word-boundary terms (the V1 substring false positives)", () => {
  // [term, text that must NOT match, text that must match]
  const table: [string, string, string][] = [
    ["edr", "Optimize AI economics on Amazon Bedrock with Accenture", "Uber's Agent-EDR catches rogue agents"],
    ["tpu", "A benchmark of structured outputs for RF layout", "Optimizing Muse Spark on TPU v7"],
    ["valuation", "Faithful and fair evaluation of agents", "LangChain raises $300M at $3B valuation"],
    ["series a", "Forecasting with time-series and tabular models", "Boltz raised a $110M Series A"],
    ["patch", "langgraph: fix send-dispatched tool calls", "Drupal ships emergency patch for RCE"],
    ["patch", "Requests are dispatched to the nearest region", "Patch Tuesday fixes 80 flaws"],
    ["exploit", "Exploiting sparsity in attention for faster inference", "Public exploit released for LangChain flaw"],
    ["asic", "A basic guide to prompting", "Etched ships transformer ASIC"],
    ["llama", "Ollama adds a new MLX runner", "Meta releases Llama 5"],
    ["ga", "The Jensen Huang saga has a new chapter", "Copilot Workspaces hits GA today"],
    ["rag", "Storage costs leverage tiering", "Faster retrieval for better RAG"],
  ];
  for (const [term, no, yes] of table) {
    it(`"${term}" does not match "${no}"`, () => {
      const m = compileTerms([term]);
      assert.equal(m(no), null);
      assert.ok(m(yes), `"${term}" should match "${yes}"`);
    });
  }

  it("matches across hyphens and inside compounds where the boundary is punctuation", () => {
    assert.ok(compileTerms(["ipo"])("Anthropic launches-the-IPO of the decade"));
    assert.ok(compileTerms(["agent"])("Meet Shepherd, the Meta-Agent"));
    assert.ok(compileTerms(["multi-agent"])("A multi agent system"));
    assert.ok(compileTerms(["qwen*"])("New LoRA adapter lifts Qwen3.8 coding success"));
    assert.ok(compileTerms(["gpus"])("Nvidia funded startups to buy its GPUs"));
    assert.ok(compileTerms(["open weight"])("Clairic is now open-weight"));
  });
});

describe("cleanForMatch", () => {
  it("drops @handles, URLs and ticker parentheticals", () => {
    const robot = compileTerms(["robot"]);
    assert.equal(robot(cleanForMatch("What's changed: fix by @gemini-cli-robot in https://github.com/x/robot/pull/1")), null);
    assert.ok(robot(cleanForMatch("A robot @ work")));
    assert.equal(compileTerms(["nasdaq"])(cleanForMatch("Pasqal (NASDAQ: PSQL) integrates quantum processors with Slurm")), null);
    assert.equal(cleanForMatch(null), "");
  });

  it("drops a trailing aggregator byline and outlet names that contain routing terms", () => {
    const m = compileTerms(["wall street"]);
    assert.equal(m(cleanForMatch("Ubisoft reports Q2 net bookings down 21% (Jane Doe/Wall Street Journal)")), null);
    assert.equal(m(cleanForMatch("The Wall Street Journal says Ubisoft is fine")), null);
    assert.ok(m(cleanForMatch("Anthropic makes history on Wall Street")));
  });
});

describe("matchItem - routing false positives of V1 stay out", () => {
  it("Bedrock is not EDR, and no rule targets a source-mode section", () => {
    const got = sections(item("Amazon Bedrock AgentCore harness adds Strands harness defaults, built-in tools, and lifecycle hooks", { home: "tools" }));
    assert.deepEqual(got, ["tools"]);
    assert.deepEqual(sections(item("Optimize AI economics on Amazon Bedrock with Accenture's sequenced approach")), []);
  });

  it("an arXiv benchmark whose abstract says 'outputs' is not hardware", () => {
    const paper = item("RFBench: A Simulator-Grounded Multimodal Benchmark for Passive RF Layout Design and Understanding", {
      kind: "papers",
      flags: ["paper"],
      home: "research",
      summary: "We compare model outputs against GPU simulators and TPU baselines on data center workloads.",
    });
    assert.deepEqual(sections(paper), []);
  });

  it("evaluation is not valuation; time-series is not Series A", () => {
    assert.ok(!sections(item("Cline-Bench: Faithful and Fair Evaluation of Agents on Real User Requests")).includes("money"));
    assert.ok(!sections(item("Forecasting with time-series and tabular foundation models")).includes("money"));
    assert.equal(sections(item("Genesis AI Raises $500M Series A at $3.5B Valuation"))[0], "money");
  });

  it("dispatched is not a patch; exploiting is not an exploit", () => {
    const release = item("langgraph v1.2.23 released", { kind: "github-release", flags: ["release"], home: "releases", summary: "fix: send-dispatched vulnerability exploit ransomware LLM" });
    assert.deepEqual(sections(release), ["tools"]);
    assert.deepEqual(sections(item("Exploiting sparsity in LLM attention for faster inference")), []);
    assert.equal(sections(item("Attackers exploit LangChain flaw to steal LLM API keys"))[0], "ai_security");
  });

  it("a changelog handle does not make a CLI release a robotics story", () => {
    const release = item("gemini-cli v0.70.0-preview.0 released", { kind: "github-release", flags: ["release"], home: "releases", summary: "chore: bump by @gemini-cli-robot. humanoid robot robotics" });
    assert.deepEqual(sections(release), ["tools"]);
  });

  it("a release tag is never a model launch", () => {
    const release = item("llama.cpp b12549 released", { kind: "github-release", flags: ["release"], home: "releases", summary: "llama : give Inkling2 its own relative-position attention input" });
    assert.deepEqual(sections(release), ["open_local"]);
    assert.ok(!sections(item("llama.cpp v1.0.0 released: a stronger foundation for local AI")).includes("models"));
  });

  it("'launches the largest IPO' is money, not a product or a model launch", () => {
    const got = matchItem(item("Anthropic launches the largest IPO in history, dethroning SpaceX", { summary: "Claude maker Anthropic began trading on Nasdaq." }));
    assert.deepEqual(got.map((m) => m.section), ["money"]);
  });

  it("a ticker parenthetical is not a markets story", () => {
    assert.ok(!sections(item("Pasqal (NASDAQ: PSQL) Integrates Quantum Processors with Slurm HRES", { home: "quantum", scope: "general" })).includes("money"));
  });

  it("one phrase in a summary is one mention: 'humanoid robot' does not route The AI Hype Index", () => {
    const hype = item("The AI Hype Index: AI is everywhere", {
      summary: "Leave your apartment, and you might pass two people heaving an AI-powered humanoid robot up the stairs to clean someone's rooms.",
    });
    assert.deepEqual(sections(hype), []);
  });

  it("'tl;dr sec' is not the SEC", () => {
    assert.ok(!sections(item("[tl;dr sec] #355 - Cyber Chaos Monkey, Offsec Harness Index", { home: "ai_security", kind: "newsletter" })).includes("policy"));
    const sec = matchItem(item("SEC Investigating Whether Nvidia Misled Investors", { home: "policy" }));
    assert.equal(sec[0].rule, "policy/finreg");
  });

  it("a jailbroken phone is not an AI jailbreak", () => {
    assert.ok(!sections(item("New iOS jailbreak released for iPhone 17", { home: "cyber", scope: "general" })).includes("ai_security"));
    assert.equal(sections(item("Researchers jailbreak GPT-6.2 within hours of launch"))[0], "ai_security");
  });
});

describe("matchItem - scoring", () => {
  it("a strong title hit routes on its own", () => {
    const [m] = matchItem(item("Prompt injection in the wild"));
    assert.equal(m.section, "ai_security");
    assert.deepEqual(m.title, ["prompt injection*"]);
    assert.equal(m.points, 2);
  });

  it("summary-only needs two distinct, separate hits", () => {
    const one = item("A quiet week", { summary: "The company discussed its valuation." });
    const two = item("A quiet week", { summary: "The company discussed its valuation after the funding round closed." });
    const adjacent = item("A quiet week", { summary: "It is a pre-seed, seed round story." });
    assert.deepEqual(sections(one), []);
    assert.deepEqual(sections(two), ["money"]);
    assert.deepEqual(matchItem(two)[0].summary, ["valuation*", "funding round"]);
    assert.deepEqual(sections(adjacent), []);
  });

  it("weak terms never route alone, but corroborate one summary hit", () => {
    assert.deepEqual(sections(item("Investors pile into shares of the new deal")), []);
    const got = matchItem(item("Anthropic Shares Pare Gains After Rocketing in Debut", { summary: "The stock closed well above its IPO price." }));
    assert.equal(got[0].section, "money");
    assert.deepEqual(got[0].weak, ["shares"]);
  });

  it("weak terms are not counted inside a strong hit, and exact terms not inside a wildcard hit", () => {
    const [tools] = matchItem(item("Building AI agents with the Agents SDK", { home: "industry" })).filter((m) => m.section === "tools");
    assert.deepEqual(tools.title, ["ai agent*", "agents sdk"]);
    assert.deepEqual(tools.weak, []);
  });

  it("title evidence beats summary evidence; AI SECURITY outranks AGENTS & TOOLS", () => {
    const got = matchItem(item("Prompt injection flaw lets attackers hijack Copilot agents"));
    assert.deepEqual(got.map((m) => m.section).slice(0, 2), ["ai_security", "tools"]);
    assert.ok(got[0].score > got[1].score);
  });

  it("summaries of releases, papers, newsletters, aggregators and community posts are never read", () => {
    const summary = "A funding round at a $3B valuation.";
    for (const kind of ["github-release", "papers", "newsletter", "aggregator", "community"] as const) {
      assert.equal(summaryIsReadable(item("x", { kind })), false, kind);
      assert.deepEqual(sections(item("Weekly notes", { kind, summary })), [], kind);
    }
    assert.deepEqual(sections(item("Weekly notes", { summary })), ["money"]);
  });

  it("titleOnly rules ignore the summary (tools)", () => {
    const gpt = item("Introducing GPT-6.2 Astra and Sol", { home: "models", summary: "Better coding, computer use, and efficiency across ChatGPT Work, Codex, and the API." });
    assert.ok(!sections(gpt).includes("tools"));
  });

  it("papers route to AI SECURITY only, and only by title", () => {
    const p = (title: string, summary: string | null = null): MatchInput => item(title, { kind: "papers", flags: ["paper"], home: "research", summary });
    assert.deepEqual(sections(p("Indirect Prompt Injection Attacks on LLM Agents")), ["ai_security"]);
    assert.deepEqual(sections(p("Low-bit quantization of vision CNNs on consumer GPUs")), []);
    assert.deepEqual(sections(p("A study of things", "prompt injection and jailbreak attacks")), []);
  });

  it("models needs a model family AND a launch verb in the title", () => {
    assert.deepEqual(sections(item("Google DeepMind Releases Gemini 4 Neon: 1M Context", { home: "research" })), ["models"]);
    assert.ok(!sections(item("One unbroken Claude, or a thousand glued together?", { home: "safety" })).includes("models"));
    assert.ok(!sections(item("Gemini 4 Hydrogen is now available in Devin", { home: "tools" })).includes("models"));
  });

  it("a bare family name is a brand, not a model: models/launch needs a VERSION with it", () => {
    const models = (title: string, home: SectionId = "tools"): boolean => sections(item(title, { home })).includes("models");
    // Live 2026-11-20: half of what this rule routed. MODELS #8, #9 and two more.
    for (const t of [
      'Using a "chaos loop" to harden the Claude Docs launch: 60 server errors across billions of requests',
      "Gemini-powered data classification in Google Drive is now generally available",
      "Introducing Claude for Manufacturing",
      "Anthropic upgrades Claude Code Projects to run parallel AI workers",
      "OpenAI launches Sora app in the EU",
      "Mistral announces a Paris data center",
    ]) assert.ok(!models(t), t);
    // Versioned launches still route, whatever the family and however the version is written.
    for (const t of [
      "Google unveils Imagen 5",
      "Mistral releases Codestral 2",
      "Mistral launches Mixtral 2",
      "Stability AI releases Stable Diffusion 4",
      "Tencent debuts Hunyuan 3D 3.0",
      "ByteDance launches Doubao 2.0 Pro",
      "Anthropic launches Claude Fable 5.2",
      "Anthropic releases Claude Opus 5",
      "Moonshot releases Kimi K3",
      "OpenAI Releases GPT-6.2 Astra",
      "Alibaba releases Qwen3.8-Flash",
      "Meta releases Llama 5",
      "Zhipu unveils GLM-6",
      "DeepSeek releases DeepSeek-V4",
      "Google rolls out Gemini 4 Hydrogen",
      "OpenAI’s GPT-6.2 Astra and GPT-6.2 Sol now available",
    ]) assert.ok(models(t), t);
    // The "new model" phrases never needed a family name.
    assert.ok(models("DeepSeek releases a new reasoning model"));
    assert.ok(models("Microsoft says its new AI coding model rivals Claude Opus"));
    const [m] = matchItem(item("Google unveils Imagen 5", { home: "tools" })).filter((x) => x.section === "models");
    assert.deepEqual(m.title, ["imagen"]);
    // In a summary, too, only versioned mentions count.
    const summary = (text: string): boolean => sections(item("Google announces a busy week", { home: "tools", summary: text })).includes("models");
    assert.ok(!summary("Gemini and Claude were both mentioned on stage."));
    assert.ok(summary("Gemini 4 Neon and Veo 5 were both shown on stage."));
  });

  it("an open-weight release is LOCAL & OPEN news: 'weights' next to a release verb, in the title", () => {
    const byWeights = (title: string, over: Partial<MatchInput> = {}): boolean => matchItem(item(title, over)).some((m) => m.rule === "open_local/weights-release");
    // Live 2026-11-20: listed in no section although its source was added for exactly this story.
    const hy4 = matchItem(item("Tencent Releases Downloadable Hy4 flash Weights in Three Variants")).find((m) => m.section === "open_local");
    assert.equal(hy4?.rule, "open_local/weights-release");
    assert.deepEqual(hy4?.title, ["weights"]);
    assert.ok(byWeights("Zyphra publishes Zaya1 checkpoints under Apache terms"));
    // "weighs" is another word; "weights" without a release verb stays a weak term.
    assert.ok(!byWeights("OpenAI weighs release of GPT-6.2 to free users"));
    assert.ok(!sections(item("OpenAI weighs release of GPT-6.2 to free users")).includes("open_local"));
    assert.ok(!sections(item("How attention weights shape what a transformer remembers")).includes("open_local"));
    // Title only: a summary never opens this rule. Check Point is a vendor, not a checkpoint.
    assert.ok(!byWeights("A quiet week at the lab", { summary: "The team released the weights and several checkpoints." }));
    assert.ok(!byWeights("Check Point releases checkpoint-free firewall update"));
    // Owner desks still need an AI term in the title.
    assert.ok(!byWeights("Vendor releases firmware weights table for scales", { home: "cyber", scope: "general" }));
  });

  it("an agent acting against its operator is AI SECURITY; safety-desk sandbagging is not", () => {
    const decoder = "An OpenAI agent assigned a simple writing task decided on its own to build a secret email surveillance tool";
    const [m] = matchItem(item(decoder));
    assert.equal(m.section, "ai_security");
    assert.deepEqual(m.title, ["surveillance tool"]);
    assert.equal(sections(item("California sues OpenAI over rogue AI hack of Hugging Face"))[0], "ai_security");
    assert.ok(sections(item("Incident Report: unsanctioned agent behaviour during cyber testing", { home: "safety" })).includes("ai_security"));
    // "secretly" is generic: it counts only next to an AI term in the title (ai_security/ai-vuln).
    assert.equal(matchItem(item("OpenAI agent secretly built an email monitoring system"))[0].rule, "ai_security/ai-vuln");
    assert.ok(!sections(item("Regulator secretly met bank executives before the vote", { home: "cyber", scope: "general" })).includes("ai_security"));
    assert.ok(!sections(item("GPT-6 Astra Covertly Underperforms on Safety Research Tasks", { home: "safety" })).includes("ai_security"));
  });

  it("describeMatch names the rule and the evidence", () => {
    const [m] = matchItem(item("LangChain Raises $300M Series C at $3B Valuation", { home: "tools" }));
    assert.equal(describeMatch(m), "money/deals: title[raises $, series c, valuation*] = 4 pts");
  });
});

describe("requireAi", () => {
  it("ai-desk homes are AI-relevant; owner desks need an AI term in the title", () => {
    assert.equal(isAiRelevant(item("Data center power demand keeps rising")), true);
    assert.equal(isAiRelevant(item("Microsoft tests new Edge Lockdown Mode that disables GPU APIs", { home: "cyber", scope: "general" })), false);
    assert.equal(isAiRelevant(item("Microsoft Copilot bug exposes GPU cluster keys", { home: "cyber", scope: "general" })), true);
    // An owner-desk source marked scope "ai" is still gated on the title.
    assert.equal(isAiRelevant(item("Chrome zero-day patched", { home: "cyber", scope: "ai" })), false);
    assert.equal(isAiRelevant(item("ollama v0.40.17 released", { home: "releases", kind: "github-release", flags: ["release"] })), true);
  });

  it("a non-AI cyber story is not routed to compute by 'GPU'", () => {
    assert.deepEqual(sections(item("Microsoft tests new Edge Lockdown Mode that disables GPU APIs", { home: "cyber", scope: "general" })), []);
  });

  it("finance-regulator items route to policy without an AI gate", () => {
    const got = matchItem(item("FINRA fines broker-dealer over recordkeeping failures", { home: "cyber", scope: "general" }));
    assert.deepEqual(got.map((m) => m.rule), ["policy/finreg"]);
    assert.deepEqual(sections(item("Securities Regulators Warn That Slow Progress on Quantum Security is a Mistake", { home: "quantum", scope: "general" })), ["policy"]);
  });

  it("aiTitleTerm finds acronyms case-sensitively", () => {
    assert.equal(aiTitleTerm("A malicious MCP package on npm"), "MCP");
    assert.equal(aiTitleTerm("A malicious MCP server on npm"), "mcp server*");
    assert.equal(aiTitleTerm("The mcp of things"), null);
    assert.equal(aiTitleTerm("User-Agent spoofing by Agent Tesla"), null);
    assert.equal(aiTitleTerm("European Commission confirms cyberattack, says hackers used AI tool"), "ai");
  });
});

describe("closing round: the outage wave and acquisitions without a deal word", () => {
  it("routes an outage headline to AI SECURITY only when the title ties it to AI", () => {
    assert.equal(sections(item("These tech outages are giving Y2K, AI agent style"))[0], "ai_security");
    assert.equal(matchItem(item("These tech outages are giving Y2K, AI agent style"))[0].rule, "ai_security/outages");
    assert.equal(sections(item("This week’s US bank outage was AI-related after all", { home: "analysis" }))[0], "ai_security");
    assert.equal(sections(item("The link between 'patchmageddon' and recent tech outages"))[0], "ai_security");
    assert.equal(sections(item("Consensus mounts that tech outages were fueled by patching of AI-discovered vulnerabilities"))[0], "ai_security");
    for (const title of ["What’s With All These Outages?", "Technology Promised Ease. Outages Are Making Many Americans Uneasy.", "Microsoft patch causes Outlook outage"]) {
      assert.ok(!sections(item(title)).includes("ai_security"), title);
      assert.ok(!sections(item(title, { home: "cyber", scope: "general" })).includes("ai_security"), `${title} (cyber wire)`);
    }
  });

  it("routes an acquisition to MARKETS under a headline with no deal word, ahead of the topic it mentions", () => {
    const m = matchItem(item("Palo Alto Networks opens wallet for open-weight training biz"));
    assert.deepEqual(m.slice(0, 2).map((x) => x.section), ["money", "open_local"]);
    assert.equal(sections(item("Cisco to buy AI observability startup"))[0], "money");
    assert.ok(!sections(item("Where to buy a GPU this winter", { scope: "general", home: "cyber" })).includes("money"), "needs an AI story");
  });
});
