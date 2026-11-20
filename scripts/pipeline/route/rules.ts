// Routing rules AS DATA (V2_PLAN §1.3 Route). Replaces V1's KEYWORDS substring table
// (scripts/sources.ts), where 31% of routed items were false positives ("edr" in "Bedrock", "tpu" in
// "outputs", "patch" in "dispatched").
//
// Every term uses shared/text.ts compileTerms syntax: word boundaries on letter/digit edges, space and
// hyphen interchangeable, trailing "*" = prefix match ("quantiz*"), no stemming otherwise - so
// "exploit" does NOT match "exploiting" (an everyday verb in ML abstracts).
//
// How a rule scores a story's LEAD item (matcher.ts):
//   strong / exact term in the title   2 points each (max 2 mentions; a `versioned` term counts as
//                                      strong when a version number goes with it)
//   weak term in the title             1 point each  (max 2)
//   strong / exact term in the summary 1 point each  (max 2 mentions; summaries of releases, papers,
//                                      newsletters, aggregators and community posts are never read)
//   A rule matches when the title has a strong term, OR the summary has two distinct strong terms,
//   OR the summary has one and the title a weak one. Weak terms alone never route ("launches",
//   "agent", "app": V1's worst offenders). Terms that sit side by side ("humanoid robot",
//   "vLLM, SGLang") are ONE mention - two words of one phrase are not two pieces of evidence.
// Between sections the best `points x weight` wins; a story is placed in its home section plus AT
// MOST ONE routed section.
//
// Only topic-mode sections have rules. Source-mode sections (industry, research, safety, cyber,
// analysis, quantum, releases) are reachable through a source's `home` only.

import type { SectionId } from "../../../shared/sections";

export interface RouteRule {
  /** "<section>/<name>" - shown in RouteTrace.rule and by the explain tool. */
  id: string;
  /** Target section. Must be mode "topic" (rules.test.ts checks). */
  section: SectionId;
  /** A title hit routes on its own. */
  strong: readonly string[];
  /** Like `strong` but CASE-SENSITIVE (acronyms that are also words: "SEC" vs "tl;dr sec"). No wildcards. */
  exact?: readonly string[];
  /**
   * Like `strong`, but a hit counts only when a VERSION goes with it: a digit inside the match
   * ("GPT-6.2", "Qwen3.8") or right after it, with at most one capitalised codename in between
   * ("Gemini 4", "Claude Fable 5.2", "Kimi K3"). A bare family name is a brand, not a model:
   * "Claude Docs launch", "Gemini-powered data classification", "Claude for Manufacturing".
   */
  versioned?: readonly string[];
  /** Counts in the title only and never routes alone. */
  weak?: readonly string[];
  /** Co-occurrence gate: the title must ALSO contain one of these (models: family + launch verb). */
  withAny?: readonly string[];
  /** Like `withAny` but case-sensitive. A hit in either list opens the gate. */
  withExact?: readonly string[];
  /** Never read the summary for this rule (the broadest lanes: a passing mention is not a topic). */
  titleOnly?: boolean;
  /** A hit in the TITLE vetoes the rule. */
  not?: readonly string[];
  /** The story must be AI-relevant (see matcher.ts isAiRelevant). */
  requireAi?: boolean;
  /** Section priority when several rules match (default 1). */
  weight?: number;
  /** Release-led stories match this rule (title only). Default false: changelog text never routes. */
  acceptsReleases?: boolean;
  /** Paper-led stories match this rule (title only). Default false: papers stay in research. */
  acceptsPapers?: boolean;
}

/**
 * AI lexicon. Used for (a) `requireAi` on stories from non-AI desks and (b) the flagship move of
 * AI-titled cyber stories to AI SECURITY. Deliberately excludes bare "agent" ("Agent Tesla",
 * "user-agent") and "model".
 */
export const AI_TERMS: readonly string[] = [
  "ai", "ais", "a.i.", "artificial intelligence", "genai", "gen ai", "generative ai", "agentic",
  "llm", "llms", "large language model*", "language model*", "foundation model*", "frontier model*",
  "machine learning", "deep learning", "neural network*", "chatbot*", "deepfake*", "superintelligence",
  "prompt injection*", "model context protocol", "mcp server*",
  "chatgpt", "gpt-*", "openai", "anthropic", "claude", "gemini", "copilot", "deepmind", "deepseek",
  "mistral", "hugging face", "huggingface", "ollama", "llama", "qwen*", "grok", "xai", "perplexity",
];

/** Case-sensitive part of the AI lexicon. */
export const AI_TERMS_EXACT: readonly string[] = ["MCP", "AGI", "ML", "GPT", "LLM", "LLMs"];

const SECURITY_EVENT_TERMS: readonly string[] = [
  "vulnerability", "vulnerabilities", "vulnerable", "cve-*", "exploit", "exploits", "exploited", "exploitation",
  "zero-day*", "0-day", "remote code execution", "security flaw*", "critical flaw*", "security bug*", "security hole*",
  "backdoor*", "malware", "ransomware", "phishing", "infostealer*", "data leak*", "leaks data", "leaking data",
  "exposes data", "exposed data", "exposing private data", "data breach*", "security breach*", "breached", "hijack*",
  "hacked", "hackers", "hacker", "hacking", "cyberattack*", "cyber attack*", "attackers", "attacker", "threat actor*", "exfiltrat*", "account takeover", "supply chain attack*", "typosquat*",
  "malicious", "spyware", "botnet*", "credential theft", "stolen credentials", "sandbox escape", "privilege escalation",
  "authentication bypass", "compromised", "scam", "scams", "fraud", "fraudsters", "espionage",
  // Agent misbehaviour. A generic adverb, so it lives here only: this list is used behind the
  // AI-term gate of ai_security/ai-vuln ("An OpenAI agent secretly built ...").
  "secretly",
];

export const ROUTE_RULES: readonly RouteRule[] = [
  // ---- AI SECURITY: the flagship section. Highest priority. -----------------
  {
    id: "ai_security/attacks",
    section: "ai_security",
    weight: 2,
    acceptsPapers: true,
    strong: [
      "prompt injection*", "prompt-injected", "jailbreak*", "jailbroken",
      "model theft", "model stealing", "model extraction", "model exfiltration", "weight theft", "stolen weights",
      "data poisoning", "model poisoning", "poisoned model*", "backdoored model*", "sleeper agent*",
      "adversarial attack*", "adversarial example*", "adversarial prompt*", "adversarial robustness",
      "agent hijack*", "hijack ai agents", "hijacks ai agents", "hijacking ai agents", "rogue agent*", "rogue ai agent*",
      "mcp poisoning", "tool poisoning", "malicious mcp", "rogue mcp", "mcp security", "mcp vulnerabilit*",
      "ai red team*", "llm red team*", "red teaming", "red teamers", "red teamed",
      "ai security", "llm security", "genai security", "agentic security", "agent security", "ai agent security",
      "securing ai", "securing agents", "securing ai agents", "shadow ai", "ai supply chain", "model supply chain",
      "ai-enabled attack*", "ai-powered attack*", "ai-driven attack*", "ai-assisted attack*", "ai-orchestrated",
      "ai-enabled cyberattack*", "ai-powered cyberattack*", "ai cyberattack*", "ai-generated malware", "ai malware",
      "ai-powered malware", "ai-powered phishing", "ai phishing", "ai-generated phishing", "ai hacking tool*",
      "ai-assisted hacking", "ai-powered hacking", "vibe hacking", "offensive ai", "autonomous attack*",
      "deepfake fraud", "deepfake scam*", "deepfake attack*", "voice cloning scam*", "voice clone fraud", "ai fraud",
      "ai-enabled fraud", "ai-powered fraud", "ai scam*", "ai-powered scam*",
      "llm vulnerabilit*", "ai vulnerabilit*", "agent vulnerabilit*", "malicious model*", "slopsquatting", "llmjacking",
      "ai worm", "system prompt leak*", "prompt leak*", "guardrail bypass", "safety bypass", "ai guardrail*",
      "owasp llm", "owasp genai", "owasp top 10 for llm*", "mitre atlas", "ai bug bounty", "ai pentest*",
      "ai penetration test*", "agentic soc", "ai soc", "ai detection and response", "ai firewall", "llm firewall",
      "ai threat*", "ai-powered threat*", "ai risk management", "ai incident*",
      // Agents acting against their operator. NOT "covertly" (safety-desk sandbagging papers:
      // "GPT-6 Astra Covertly Underperforms on Safety Research Tasks") and not "sabotag*" (no hits).
      "rogue ai", "surveillance tool", "unsanctioned agent*",
      // Vulnerabilities found BY AI, and the patch wave they set off (see ai_security/outages).
      "ai-discovered vulnerabilit*", "ai-discovered bug*", "ai-discovered flaw*", "ai-found vulnerabilit*", "ai-found bug*", "ai-found flaw*", "patchmageddon",
    ],
    weak: ["deepfake*", "data exfiltration", "model weights", "guardrail*", "misuse"],
    not: ["iphone", "ios", "playstation", "ps5", "nintendo", "firestick", "fire tv"],
  },
  {
    // The outage wave of November 2026: service outages blamed on emergency patching of
    // AI-discovered vulnerabilities. Ten headlines in 76 h with almost no words in common, so the
    // cluster stage cannot join them - and they were listed under five sections (AGENTS & TOOLS by
    // "AI agent", INDUSTRY, ANALYSIS, POLICY, river only). A headline that ties an outage to AI is
    // routed where a security reader looks; the names of the wave itself ("patchmageddon",
    // "AI-discovered vulnerabilities") are terms of ai_security/attacks. A bare "outage" headline
    // ("What's With All These Outages?", "Microsoft patch causes Outlook outage") is not routed.
    id: "ai_security/outages",
    section: "ai_security",
    weight: 2,
    titleOnly: true,
    strong: ["outage", "outages"],
    withAny: AI_TERMS,
    withExact: AI_TERMS_EXACT,
  },
  {
    // "LLM + vulnerability / CVE": a security event term AND an AI term, both in the title.
    id: "ai_security/ai-vuln",
    section: "ai_security",
    weight: 2,
    acceptsPapers: true,
    strong: SECURITY_EVENT_TERMS,
    withAny: AI_TERMS,
    withExact: AI_TERMS_EXACT,
  },

  // ---- POLICY & REGULATION ---------------------------------------------------------------------
  {
    // Finance-regulator items route to policy WITHOUT an AI gate (V2_PLAN §1.1).
    id: "policy/finreg",
    section: "policy",
    weight: 1.5,
    exact: ["SEC", "FINRA", "CFTC", "OCC", "FCA", "ESMA", "FDIC", "FSOC", "NYDFS", "CFPB", "FINMA", "BaFin", "MiFID"],
    strong: [
      "securities and exchange commission", "financial industry regulatory authority", "commodity futures trading commission",
      "comptroller of the currency", "financial conduct authority", "prudential regulation authority",
      "european securities and markets authority", "bank regulator*", "banking regulator*", "financial regulator*",
      "securities regulator*", "markets regulator*", "financial watchdog", "markets watchdog", "basel committee",
      "financial stability board", "financial stability oversight council", "reg s-p", "regulation s-p", "rule 17a-4",
      "regulation best interest", "reg bi", "bank supervisor*", "bank supervision",
    ],
    weak: ["fed", "federal reserve", "bank of england", "ecb", "treasury", "broker-dealer*", "banks", "bank"],
  },
  {
    id: "policy/ai-regulation",
    section: "policy",
    weight: 1.5,
    requireAi: true,
    exact: ["FTC", "DOJ", "NIST", "GDPR", "CCPA", "DSA", "DMA", "CAISI"],
    strong: [
      "eu ai act", "ai act", "executive order*", "rulemaking", "proposed rule*", "final rule*", "regulation", "regulations",
      "regulator", "regulators", "regulatory", "regulate", "regulates", "regulating", "deregulation", "preemption",
      "pre-emption", "preempt", "moratorium", "legislation", "legislators", "legislature", "lawmakers", "lawmaker",
      "congress", "congressional", "senate", "senator*", "house committee", "caucus", "parliament", "white house",
      "justice department", "attorney general", "attorneys general", "european commission", "eu commission",
      "federal trade commission", "enforcement action*", "antitrust", "lawsuit*", "sues", "sued", "suing", "class action",
      "copyright*", "court", "courts", "ruling", "subpoena*", "export control*", "export curb*", "chip curbs",
      "export ban", "export rules", "sanction*", "blacklist*", "entity list", "tariff*", "privacy law*", "data protection",
      "disclosure rule*", "ai governance", "ai policy", "tech policy", "ai law*", "ai bill", "ai safety bill", "state law*",
      "treaty", "section 230", "digital services act", "digital markets act", "online safety act", "ofcom", "testifies",
      "testified", "testimony", "is investigating", "investigation into", "investigates", "under investigation",
      "opens investigation", "launches investigation", "opens probe", "launches probe", "antitrust probe", "ai diffusion rule",
      "national security", "pentagon", "department of defense", "department of commerce", "commerce department",
      "state department", "ban on", "bans ai", "ai ban", "liability", "us rules",
    ],
    weak: ["judge", "enforcement", "fine", "fined", "fines", "settlement", "probe", "probes", "ban", "bans", "banned", "compliance", "governance", "hearing", "policy", "law", "rules", "legal", "government", "federal"],
  },

  // ---- MARKETS & DEALS ---------------------------------------------------------------------------
  {
    id: "money/deals",
    section: "money",
    weight: 1.3,
    requireAi: true,
    exact: ["VC", "VCs", "SPAC", "M&A", "ARR"],
    strong: [
      "raises $", "raised $", "raise $", "raising $", "raises €", "raised €", "raises £", "raised £", "lands $", "secures $",
      "closes $", "bags $", "nabs $", "funding round", "seed round", "pre-seed", "seed funding", "series a", "series b",
      "series c", "series d", "series e", "series f", "valuation*", "valued at", "ipo", "ipos", "initial public offering",
      "public debut", "trading debut", "market debut", "nasdaq debut", "nyse debut", "goes public", "going public",
      "go public", "direct listing", "public listing", "acquisition*", "acquires", "acquired", "acquire", "acquiring",
      // An acquisition under a headline with no deal word: "Palo Alto Networks opens wallet for
      // open-weight training biz" (a $4.5B purchase, listed under LOCAL & OPEN MODELS only).
      "to buy", "agrees to buy", "opens wallet", "snaps up", "buying spree",
      "buyout", "merger", "takeover bid", "hostile takeover", "earnings", "revenue run rate", "run rate", "annualized revenue",
      "quarterly results", "quarterly revenue", "capex", "capital expenditure*", "capital spending", "market cap",
      "market value", "share price", "stock price", "short seller*", "short-selling", "invests $", "investing $",
      "to invest $", "investment round", "venture capital", "venture funding", "financing", "convertible bond*",
      "bond sale", "bond deal*", "debt financing", "debt deal", "tender offer", "secondary sale", "wall street", "wall st",
      "nasdaq", "nyse", "s&p 500", "ai bubble", "ai trade", "ai stocks", "tech stocks", "chip stocks", "sell-off", "selloff",
      "unicorn*", "decacorn*", "shareholders", "shareholder", "stake in", "billion deal", "million deal",
      "shares jump*", "shares surge*", "shares soar*", "shares rise*", "shares fall*", "shares slide*", "shares drop*",
      "shares plunge*", "shares tumble*", "shares sink*", "stock jumps", "stock surges", "stock soars", "stock falls",
      "stock slides", "stock drops", "stock plunges", "stock tumbles", "stock sinks",
    ],
    weak: ["funding", "investors", "investor", "investment", "invests", "buys", "takeover", "shares", "stock", "stocks", "revenue", "profit", "profits", "deal", "stake", "bubble", "rally", "listing", "debt", "bonds", "trading", "billion", "trillion", "backers", "backed"],
    not: ["data acquisition", "language acquisition", "knowledge acquisition", "skill acquisition", "customer acquisition", "talent acquisition"],
  },

  // ---- MODELS & LABS: versioned model family + launch verb, both in the title -----------------
  {
    id: "models/launch",
    section: "models",
    weight: 1.2,
    requireAi: true,
    // Family names route only with a version (see RouteRule.versioned). Live 2026-11-20: 4 of the 8
    // stories this rule routed were not launches - "... harden the Claude Docs launch" (MODELS #8),
    // "Gemini-powered data classification in Google Drive is now generally available" (#9),
    // "Introducing Claude for Manufacturing", "Anthropic upgrades Claude Code Projects ...".
    versioned: [
      "gpt-*", "claude", "claude opus", "claude sonnet", "claude haiku", "gemini", "gemma*", "llama", "mistral", "mixtral",
      "codestral", "qwen*", "deepseek*", "phi-*", "grok", "grok-*", "kimi", "glm-*", "ernie", "hunyuan", "doubao", "minimax",
      "sora", "veo", "imagen", "stable diffusion", "nano banana",
    ],
    strong: [
      "new model", "new ai model", "latest model",
      "latest ai model", "reasoning model", "foundation model", "frontier model", "flagship model", "open-weight model",
      "video model", "image model", "coding model", "embedding model",
    ],
    withAny: [
      "launch", "launches", "launched", "launching", "release", "releases", "released", "releasing", "unveil*",
      "announce*", "introduces", "introducing", "introduced", "debut*", "rolls out", "rolling out", "rollout", "ships",
      "shipped", "drops", "is here", "arrives", "arrive", "now available", "generally available", "general availability",
      "open-sources", "open-sourced", "upgrade*", "updates", "updated", "beats", "tops", "outperform*", "rivals",
      "benchmark*", "leaderboard", "context window", "preview",
    ],
    // "<model> is now available in <product>" is an integration note, not a model launch.
    not: ["llama.cpp", "llama_index", "llamaindex", "llama index", "ipo", "valuation", "lawsuit*", "sues", "sued", "copyright*", "now available in", "now available on"],
  },

  // ---- LOCAL & OPEN MODELS ---------------------------------------------------------------------
  {
    id: "open_local/runtime",
    section: "open_local",
    weight: 1.2,
    requireAi: true,
    acceptsReleases: true,
    exact: ["LoRA", "QLoRA", "MLX", "SLM", "SLMs", "NPU", "NPUs"],
    strong: [
      "gguf", "ggml", "llama.cpp", "llamacpp", "ollama", "mlx-lm", "vllm", "sglang", "lm studio", "lmstudio", "exllama*",
      "koboldcpp", "oobabooga", "open webui", "localai", "llamafile", "unsloth", "comfyui", "webllm", "transformers.js", "localllama",
      "quantiz*", "quantis*", "awq", "gptq", "exl2", "exl3", "open weights", "open weight", "open-weights",
      "open source model*", "open source llm*", "open model", "open models", "open source ai", "open-sources",
      "open-sourced", "open sourcing", "apache 2.0", "mit license*", "mit-licensed", "apache-licensed", "permissive license",
      "openly licensed", "on-device", "local llm*", "local model*", "local ai", "local inference", "run locally",
      "runs locally", "running locally", "self-hosted", "self-hosting", "self-host", "apple silicon", "vram",
      "consumer gpu*", "model weights", "small language model*", "edge inference", "offline ai", "private ai",
      // Local-inference hardware and throughput. Live 2026-11-20: "Three 'e-waste' Nvidia V100s hit
      // 100 tokens per second on Qwen 3.6 35B in a $1,042 homelab rig" and "NVIDIA DGX Spark
      // Developer Kit Turns a Desk Into a Supercomputing Lab" were listed under CHIPS only.
      "mac studio", "dgx spark", "homelab", "home lab", "tokens per second", "tokens/sec", "tok/s",
    ],
    weak: ["open source", "hugging face", "huggingface", "edge ai", "webgpu", "laptop", "fine-tune", "fine-tuning", "fine-tuned", "weights"],
  },

  {
    // "<Lab> Releases Downloadable <Model> Weights": the open-weight release itself, under a
    // headline that names no runtime and no licence. Title only, and only next to a release verb -
    // bare "weights" stays a weak term above ("OpenAI weighs ..." is another word altogether).
    id: "open_local/weights-release",
    section: "open_local",
    weight: 1.2,
    requireAi: true,
    titleOnly: true,
    strong: ["weights", "checkpoint", "checkpoints"],
    withAny: ["release", "releases", "released", "releasing", "downloadable", "download", "open-sources", "open-sourced", "publishes", "ships", "drops"],
    not: ["check point"],
  },

  // ---- CHIPS & COMPUTE -------------------------------------------------------------------------
  {
    id: "compute/hardware",
    section: "compute",
    weight: 1.1,
    requireAi: true,
    exact: ["HBM4", "CUDA", "DRAM", "HPC"],
    strong: [
      "gpu", "gpus", "tpu", "tpus", "ai accelerator*", "gpu accelerator*", "asic", "asics", "chip", "chips", "chipmaker*",
      "chipmaking", "semiconductor*", "foundries", "fab", "fabs", "wafer*", "hbm", "memory chip*", "data center*",
      "datacenter*", "data centre*", "hyperscaler*", "supercomputer*", "supercomputing", "ai factory", "ai factories",
      "gigawatt*", "megawatt*", "power grid", "liquid cooling", "blackwell", "vera rubin", "h100", "h200", "h20", "b200",
      "gb200", "gb300", "infiniband", "ai chip*",
      "inference chip*", "compute capacity", "compute cluster*", "gpu cluster*", "stargate", "top500", "exascale",
      "ai infrastructure", "ai server*", "rack-scale", "co-packaged optics", "silicon photonics", "18a",
    ],
    // Company names only corroborate: "AMD shares fall" is a markets story, not a chips story.
    weak: ["nvidia", "amd", "intel", "broadcom", "tsmc", "asml", "micron", "sk hynix", "cerebras", "groq", "nscale", "coreweave", "foundry", "accelerator*", "compute", "power", "energy", "nuclear", "cooling", "server", "servers", "silicon", "cluster", "inference", "cloud"],
  },

  // ---- ROBOTICS --------------------------------------------------------------------------------
  {
    id: "robotics/embodied",
    section: "robotics",
    weight: 1.1,
    requireAi: true,
    exact: ["VLA", "FSD"],
    strong: [
      "robot", "robots", "robotic", "robotics", "humanoid*", "robotaxi*", "self-driving", "autonomous vehicle*",
      "autonomous driving", "driverless", "waymo", "zoox", "tesla optimus", "boston dynamics", "figure ai", "unitree",
      "embodied ai", "embodied intelligence", "physical ai", "quadruped*", "exoskeleton*", "vision-language-action",
      "agility robotics", "apptronik", "physical intelligence", "skild", "robot foundation model*", "cobot*",
    ],
    weak: ["optimus", "drone", "drones", "autonomy", "autonomous", "world model*", "actuator*", "teleoperat*", "warehouse"],
  },

  // ---- AGENTS & TOOLS (V1 agents_tools + products). Lowest priority: it is the broadest lane. ---
  {
    id: "tools/agents",
    section: "tools",
    weight: 1,
    requireAi: true,
    acceptsReleases: true,
    titleOnly: true,
    exact: ["MCP", "A2A", "SDK", "SDKs", "IDE", "RAG", "Cursor", "Devin", "Cline"],
    strong: [
      "ai agent*", "coding agent*", "agentic ai", "agentic coding", "agentic workflow*", "agent framework*", "agent sdk", "agents sdk", "multi-agent", "sub-agent*",
      "subagent*", "agent harness", "agentcore", "agent gateway*", "agent builder", "computer use", "tool use",
      "tool calling", "tool retrieval", "tool gateway", "function calling", "model context protocol", "mcp server*",
      "langchain", "langgraph", "langsmith", "llamaindex", "llama_index", "crewai", "autogen", "autogpt", "openhands",
      "litellm", "codex",
      "claude code", "qwen code", "gemini cli", "github copilot", "copilot", "windsurf", "aider", "replit agent",
      "coding assistant*", "ai coding", "vibe coding", "ai assistant*", "developer tool*", "dev tool*", "ai browser",
      "ai mode", "ai search", "ai overviews", "notebooklm", "voice mode", "retrieval-augmented", "vector database*",
      "context engineering", "agent skills", "agent mode", "orchestrator api", "responses api", "batch api", "assistants api",
    ],
    weak: [
      "agent", "agents", "agentic", "launches", "launching", "now available", "rolls out", "beta", "feature", "features", "app",
      "plugin*", "extension", "workflow*", "orchestrat*", "prompt engineering", "chatgpt", "api", "apis", "assistant",
      "open source", "cli", "toolkit", "framework", "playground", "integration*",
    ],
  },
];

/**
 * FOCUS: what a topic section is ABOUT, as opposed to what merely mentions its words. ROUTE_RULES
 * decide membership ("open-weight" in any headline lists a story under LOCAL & OPEN MODELS); a focus
 * rule adds points to a story's score FOR THE ORDER OF THAT SECTION'S LIST ONLY - never to the
 * story's score, TOP STORIES, or any other section. Title only; the best matching rule counts (no
 * stacking); `withAny` is a co-occurrence gate as in RouteRule.
 *
 * Live 2026-11-20, LOCAL & OPEN MODELS as built: #1 an acquisition ("Palo Alto Networks opens wallet
 * for open-weight training biz"), #3 a policy essay ("Open-weight AI models need a 5G-style test on
 * provenance"), #6 a podcast, #9 a kernel-driver post; the llama.cpp release was #11 and the day's
 * open-weight release ("... Clairic-flash are now open-weight") #10.
 */
export interface FocusRule {
  /** "<section>/<name>" - shown in RouteTrace.focus. */
  id: string;
  points: number;
  strong: readonly string[];
  /** Case-sensitive terms. */
  exact?: readonly string[];
  /** The title must also contain one of these. */
  withAny?: readonly string[];
  /** Also match `strong` / `exact` against the lead's SOURCE NAME (a first-party blog names its subject). */
  matchSource?: boolean;
  /** A hit in the title vetoes the rule. */
  not?: readonly string[];
}

const RELEASE_VERBS: readonly string[] = [
  "release", "releases", "released", "releasing", "launches", "launched", "ships", "shipped", "drops", "publishes", "published",
  "introducing", "introduces", "announces", "announced", "unveils", "open-sources", "open-sourced", "open sourcing",
  "now", "available", "updated", "downloadable", "download", "day-0",
];

// Scale: the score's recency term loses 20 points in the first 27 hours and a source tier is worth
// 10, so a story the section is ABOUT outranks a same-tier story that only mentions its words for
// about a day - and never a multi-publisher story (coverage starts at 22 points).
const FOCUS_CORE = 20;
const FOCUS_RELATED = 14;

export const SECTION_FOCUS: Partial<Record<SectionId, readonly FocusRule[]>> = {
  open_local: [
    {
      // The runtimes a local lab runs: their releases, their engineering posts, their day-0 support.
      id: "open_local/runtime",
      points: FOCUS_CORE,
      // A post on a runtime's own blog is about the runtime ("Making open models work for
      // long-horizon agentic workloads", Ollama Blog), whatever its headline says.
      matchSource: true,
      exact: ["MLX"],
      strong: [
        "llama.cpp", "llamacpp", "ollama", "vllm", "mlx-lm", "mlx-vlm", "sglang", "lm studio", "lmstudio", "exllama*", "koboldcpp",
        "open webui", "llamafile", "localai", "unsloth", "llama-swap",
      ],
    },
    {
      // Formats and compression: what decides whether a model fits the machine.
      id: "open_local/quantization",
      points: FOCUS_CORE,
      strong: ["gguf", "ggml", "quantiz*", "quantis*", "awq", "gptq", "exl2", "exl3"],
    },
    {
      // An open-weight RELEASE, not a headline that says "open-weight" about a deal or a policy.
      id: "open_local/weights-release",
      points: FOCUS_CORE,
      strong: [
        "open-weight*", "open weights", "open model", "open models", "model weights", "weights", "checkpoint", "checkpoints",
        "apache 2.0", "mit-licensed", "apache-licensed", "openly licensed",
      ],
      withAny: RELEASE_VERBS,
    },
    {
      // Local-inference hardware and measured throughput.
      id: "open_local/hardware",
      points: FOCUS_RELATED,
      exact: ["NPU", "NPUs"],
      strong: [
        "mac studio", "dgx spark", "apple silicon", "vram", "homelab", "home lab", "tokens per second", "tokens/sec", "tok/s",
        "on-device", "run locally", "runs locally", "running locally", "local inference", "consumer gpu*", "*gb of ram", "*gb vram",
      ],
    },
  ],
  policy: [
    {
      // The regulators a US broker-dealer answers to, named in the headline. Live 2026-11-20: no SEC
      // headline in POLICY's 30 rows - "An AI-Focused Fireside Chat with SEC IM Director Brian Daly"
      // and "Private Equity, AI Spark Audit Firm Ethics Rule Questions at SEC" were cut below
      // recency-only rows ("AI-Enabled Video System Monitors ICU Patients ...", tier 4). Case-sensitive
      // acronyms ("tl;dr sec" is a newsletter); a FORMER official's opinion is not regulator news.
      id: "policy/us-finreg",
      points: FOCUS_RELATED,
      exact: ["SEC", "FINRA", "CFTC", "OCC"],
      strong: [
        "securities and exchange commission", "financial industry regulatory authority", "commodity futures trading commission",
        "comptroller of the currency", "reg s-p", "regulation s-p", "rule 17a-4", "regulation best interest", "reg bi", "broker-dealer*",
      ],
      not: ["former sec", "ex-sec", "former finra", "former cftc", "former occ"],
    },
  ],
  ai_security: [
    {
      // The outage wave (see ROUTE_RULES ai_security/outages): a report that ties the outages to
      // AI-discovered vulnerabilities outranks a same-day opinion piece or newsletter row. Live
      // 2026-11-20: CyberScoop's "Consensus mounts that tech outages were fueled by patching of
      // AI-discovered vulnerabilities" (tier 2, 31 h) was AI SECURITY #19, below the homepage cut.
      id: "ai_security/ai-found",
      points: FOCUS_CORE,
      strong: ["patchmageddon", "ai-discovered vulnerabilit*", "ai-discovered bug*", "ai-discovered flaw*", "ai-found vulnerabilit*", "ai-found bug*", "ai-found flaw*"],
    },
    {
      id: "ai_security/outages",
      points: FOCUS_RELATED,
      strong: ["outage", "outages"],
      withAny: AI_TERMS,
    },
  ],
};

/** Placement policy constants that are NOT shared with other stages (shared ones live in PIPELINE). */
export const ROUTE_POLICY = {
  titleStrongPoints: 2,
  titleWeakPoints: 1,
  summaryPoints: 1,
  /** Distinct terms counted per class - stops a keyword-stuffed summary from outbidding a real title hit. */
  maxTermsPerClass: 2,
  /** AI-titled stories whose home is this section are MOVED (not copied) to `moveTo`. */
  moveFrom: "cyber" as SectionId,
  moveTo: "ai_security" as SectionId,
  /**
   * When that move rests on a bare AI term (no AI-security rule hit in the title) and one of THESE
   * sections matches the title, the story moves there instead: "Lawmakers launch new AI safety
   * caucus amid rising security concerns" (The Record) is a policy story, and was AI SECURITY #1.
   * An allowlist, not "any section": an AI-titled cyber story with a tools or open_local hit ("The
   * risks of device code authentication for AI coding agents") is still an AI-security story.
   */
  moveYieldsTo: ["policy"] as readonly SectionId[],
  /** A release-led story never takes one of the first N rows of a section it was routed INTO. */
  releaseHoldBackRows: 3,
  /** At most this many TOP STORIES led by the same publisher. */
  topPerLeadPublisher: 2,
  /**
   * Stories HOMED in these sections are cross-listings everywhere else: they never take a homepage
   * row of another section (they stay in its "view all" list, and come back only if that section
   * would otherwise be short). A security advisory about a local runtime ("vLLM from 0.28.0 before
   * 0.33.0 contains an improper input validation vulnerability") is AI SECURITY news; it held two of
   * the ten LOCAL & OPEN MODELS homepage rows whenever AI SECURITY's own homepage was full.
   */
  crossListOnlyHomes: ["ai_security"] as readonly SectionId[],
  /**
   * In these sections a release line routed in from the release radar keeps a homepage row even
   * though RELEASE RADAR shows it too - at most `maxRows` of them, never in the first
   * `releaseHoldBackRows`. For a reader who runs llama.cpp and Ollama, their releases ARE the local
   * news; the reference list at the foot of the page is not where that reader looks first.
   */
  releaseRows: { sections: ["open_local"] as readonly SectionId[], maxRows: 2 },
  /**
   * Regulator placement floor on the HOMEPAGE rows of `section` (homepage.ts). A first-party notice
   * (source tags "regulator" + "first-party") of one of `publishers` - the regulators a US
   * broker-dealer answers to or watches - is guaranteed a homepage row for `hours` after
   * publication when the section lists it at all: nobody else covers a notice, so on score alone it
   * slides under every same-day opinion piece (FINRA Regulatory Notice 26-24 was POLICY #11 at
   * 38 h, one row below the homepage list). At most `maxRows` rows are guaranteed, one regulator at
   * a time before anyone's second, and ANY regulator's own feed holds at most `perRegulator`
   * homepage rows (three Bank of England papers of one consultation held rows #4-#6). A date-only
   * stamp ("Nov 18, 2026", which normalize places at 12:00 UTC) may be up to `dateOnlyGraceHours`
   * younger than it reads, so its window is that much longer.
   */
  regulatorFloor: {
    section: "policy" as SectionId,
    publishers: ["finra", "sec", "occ", "fca", "bank-of-england", "iosco", "fsb", "cftc", "nist", "cisa"] as readonly string[],
    hours: 72,
    perRegulator: 2,
    maxRows: 4,
    dateOnlyGraceHours: 12,
  },
  /**
   * TOP STORIES, "same running story" (running.ts). A story's CORE is the name-like title tokens
   * (>= `minTokenLength` letters, no digit) that `coreShare` of its headlines carry; its VOCABULARY
   * the tokens `vocabularyShare` of them carry (at least 2 headlines). B follows A when the two cores share a token and B's headlines carry
   * `minShared` more tokens of A's vocabulary. A follow-up takes a TOP slot only with `independentPublishers`
   * coverage publishers of its own, and one running story holds at most `maxSlots` slots. Live
   * 2026-11-20: the Anthropic IPO held TOP #1, #6 and #8 (30, 3 and 3 publishers).
   */
  runningStory: { coreShare: 0.9, vocabularyShare: 0.05, minShared: 2, minTokenLength: 3, independentPublishers: 5, maxSlots: 2 },
  /**
   * TOP STORIES membership hysteresis (top.ts). A story of the previous build's TOP that no longer
   * makes the list - outranked, or down to one publisher because a feed rotated an item out or a
   * wrapper link resolved to another id - keeps its slot unless the newcomer that would replace it
   * scores at least `margin` points more than the score the incumbent last qualified with; a hold
   * lasts at most `hours` (four builds at the 30-minute cadence), then the story must qualify on its
   * own. 5 points is less than one publisher is worth to a story of up to five (7 - 22 points
   * before the fade), so a newcomer that really is bigger still gets in at once.
   */
  topHold: { margin: 5, hours: 2 },
  /**
   * A story placed in two sections gets its homepage slot in its primary section only; in the other
   * section it sits just below the homepage cut (still in "view all"). V1 repeated a URL in 24% of
   * homepage slots.
   */
  homepageDedupe: true,
  /**
   * General-news desks: a story homed here that is also routed is listed under the ROUTED section
   * (the topic says more about it than "it came from a general AI feed"). Every other home keeps
   * its stories unless a more specific topic section claims them by a title hit (see primarySection).
   */
  generalDesks: ["industry"] as readonly SectionId[],
  /**
   * Same-subject cap on the HOMEPAGE rows of a section. A story with at least `minPublishers`
   * coverage publishers defines a subject: the title tokens carried by `titleShare` of its members'
   * headlines ("anthropic" on IPO day: 39 of 39). At most `maxHomeRows` homepage rows per section
   * may carry all of a subject's tokens in their lead title - the big story included, whether or not
   * it is listed in that section; the rest sit just below the homepage cut (and come back if the
   * section would otherwise be short). Live 2026-11-20: 6 of 10 MARKETS rows and 4 of 12 INDUSTRY
   * rows were Anthropic IPO angle pieces. Soft and homepage-only on purpose: the key is the subject's
   * name, so an unrelated item about the same company can be deferred too on such a day.
   */
  subjectCap: { minPublishers: 5, titleShare: 0.9, maxHomeRows: 2, minTokenLength: 3 },
} as const;

/** Priority of a topic section = the highest weight among its rules (0 for sections without rules). */
export function sectionPriority(section: SectionId, rules: readonly RouteRule[] = ROUTE_RULES): number {
  let max = 0;
  for (const r of rules) if (r.section === section) max = Math.max(max, r.weight ?? 1);
  return max;
}
