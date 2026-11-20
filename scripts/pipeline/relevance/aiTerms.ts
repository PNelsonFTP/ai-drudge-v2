// The AI-relevance gate for scope "general" sources (whole-publication feeds: Bloomberg Markets,
// Techmeme, Tom's Hardware, ...). V1 had no gate, so "Bloomberg Green New York 2026 Highlights" and
// "Fed's Barr Says Inflation Calls for Further Policy Adjustment" sat in AI FINANCE and a general
// markets wire supplied the site lead in 26 of 308 builds.
//
// The rule is deliberately TITLE-weighted. A general feed's summary mentions "AI" in passing all the
// time (the Barr speech was given "at FinRegLab's AI Symposium"); the headline says what the story
// is about.
//
//   pass when   a STRONG term is in the title
//          or   two different STRONG terms are in the summary
//          or   a STRONG term opens the summary (its first LEAD_CHARS characters): a one-line dek such
//               as "Our first public frontier AI company is here." states the subject, while a
//               passing mention sits deep in a body excerpt. Not when the summary is an "also in
//               this issue" teaser ("Plus! Diff Jobs; ...; The Micropolitics of AI"): those list
//               the OTHER items of a newsletter, never the subject of this one
//          or   a CONTEXT term is in the title and a STRONG term is anywhere in the summary
//               ("compute", "chips", "accelerator" are AI stories only in AI context)
//          or   a term of the source's HOME BEAT is in the title: compute vocabulary for a
//               CHIPS & COMPUTE source, "agent" for an AGENTS & TOOLS source (HOME_BEAT_TERMS)
//          or   "agent" opens the SUMMARY of an item from a desk where an agent is an AI agent
//               (HOME_BEAT_LEAD_TERMS): advisories and engineering posts name only the product in
//               the title ("Nanobot - bwrap Sandbox Bypass": "... an agent-selected shell override")
//
// STRONG includes the chip industry's unambiguous names (GPU, TSMC, AMD, data center ...): the site
// has a CHIPS & COMPUTE desk and the review listed "AMD falls on short-seller report" and "Intel's
// first external 18A customer" among the stories V1 missed.
//
// Terms use shared/text.ts compileTerms: case-insensitive, word-boundary ("ai" never matches "air"
// or "said"), hyphen/space interchangeable, optional plural "s".

import type { SectionId } from "../../../shared/sections";
import { compileTerms, type TermMatcher } from "../../../shared/text";

/**
 * Model / product family names that are unambiguous in a headline. route/rules.ts ("models/launch")
 * and score/importance.ts (ENTITIES) keep their own family lists; a family they know must also
 * pass here, or a launch they would rank is dropped before they see it (aiTerms.test.ts holds the
 * list of sample headlines). Names that are also plain words are spelled with their context:
 * "kimi k*" (not the driver Kimi Antonelli), "ernie bot" / "ernie 5*" (not Bert and Ernie),
 * "meta muse" / "muse spark" (not "Musk muses"); bare "inkling" and "moonshot" are left out.
 */
export const MODEL_FAMILY_TERMS: readonly string[] = [
  "mythos", "glm-*", "minimax", "hunyuan", "nemotron", "kimi k*", "meta muse", "muse spark", "ernie bot", "ernie 4*", "ernie 5*",
];

/** Terms that by themselves mark a story as AI-related. */
export const STRONG_TERMS: readonly string[] = [
  // The field
  "ai", "a.i.", "artificial intelligence", "machine learning", "deep learning", "neural", "neural network", "neural net",
  "llm", "llm*", "large language model", "language model", "foundation model", "frontier model", "generative", "genai",
  "agentic", "chatbot", "gpt*", "chatgpt*", "transformer model", "diffusion model", "multimodal", "model weights",
  "open weights", "open-weight", "fine-tun*", "finetun*", "prompt injection", "prompt engineering", "deepfake",
  "superintelligence", "agi", "machine intelligence", "computer vision",
  "reinforcement learning", "hallucinat*", "text-to-image", "text-to-video", "text-to-speech", "voice cloning",
  "voice clone", "speech recognition", "vibe cod*", "vibe-cod*", "world model", "retrieval-augmented",
  "model context protocol", "mcp", "mlops", "tokenizer", "embedding model", "vector database", "synthetic media",
  "synthetic data", "natural language", "interpretability",
  "neuromorphic", "copilot", "ai-generated", "ai-powered", "frontier lab", "recursive self-improvement",
  // Embodied AI
  "robot", "robotic*", "robotaxi", "humanoid", "self-driving", "autonomous vehicle", "autonomous driving",
  // Labs, products and frameworks
  "openai", "anthropic", "claude", "gemini", "gemma", "deepmind", "mistral", "xai", "grok", "perplexity", "hugging face",
  "huggingface", "cohere", "stability ai", "midjourney", "stable diffusion", "dall-e", "sora", "llama", "llama.cpp",
  "ollama", "qwen*", "deepseek", "doubao", "zhipu", "moonshot ai", "nvidia", "coreweave", "nscale", "cerebras", "groq",
  "sambanova", "runwayml", "elevenlabs", "codex", "notebooklm", "alphafold", "alphago", "alphaproof", "alphaevolve",
  "waymo", "boston dynamics", "unitree", "safe superintelligence", "thinking machines lab", "apple intelligence",
  "langchain", "llamaindex", "pytorch", "tensorflow", "cuda",
  ...MODEL_FAMILY_TERMS,
  // People who are the story when they are in a headline ("Jensen Out, MATCH Act In?", "A post-Jensen world")
  "sam altman", "altman", "amodei", "hassabis", "jensen huang", "jensen", "murati", "sutskever", "lecun", "karpathy",
  // Chips and AI infrastructure: names that are unambiguous in a headline
  "gpu", "hbm", "tsmc", "semiconductor", "chipmaker", "amd", "intel", "micron", "sk hynix", "broadcom", "qualcomm",
  "asml", "smic", "supercomputer", "supercomputing", "top500", "exascale", "data center", "datacenter", "data centre",
  "cowos",
];

/** Compute vocabulary that is ambiguous outside AI context ("accelerator" is also a startup program), but the beat of CHIPS & COMPUTE. */
export const COMPUTE_TERMS: readonly string[] = [
  "accelerator", "high-bandwidth memory", "hpc", "foundry", "chip", "wafer", "advanced packaging", "lithography", "euv",
  "tpu", "npu", "asic", "inference", "compute", "qubit", "quantum comput*", "quantum processor", "arm holdings",
  "export control", "chip export*", "liquid cooling", "infiniband", "risc-v", "dgx", "xeon", "epyc",
];

/** Other AI-adjacent words: never enough alone, but with a STRONG term in the summary the story is about AI. */
export const CONTEXT_TERMS: readonly string[] = ["agent", "jailbreak*", "autonomous", "algorithm", "automation", "training data", "data labeling"];

/**
 * Words that mean AI on a given desk: a title hit passes for a source whose HOME is that section
 * ("agent" in a developer-tools feed is an AI agent; in a markets wire it may be an estate agent).
 */
export const HOME_BEAT_TERMS: Readonly<Partial<Record<SectionId, readonly string[]>>> = {
  compute: COMPUTE_TERMS,
  tools: ["agent"],
  ai_security: ["agent", "jailbreak*", "guardrail*", "prompt"],
  safety: ["model", "alignment", "misalign*", "sandbox*"],
  research: ["model", "benchmark", "dataset"],
  // "industry" is deliberately absent: its general wires write about estate agents and ICE agents.
  analysis: ["agent"],
  money: ["agent"],
  policy: ["compute", "export control", "chip export*"],
  open_local: ["weights", "quantiz*", "gguf"],
};

/**
 * Beat terms that also count when they open the SUMMARY (its first LEAD_CHARS characters). Only
 * "agent", only on these desks: "model", "prompt", "weights" and "sandbox" in a summary are noise on
 * security feeds ("threat model", "browser sandbox").
 */
export const HOME_BEAT_LEAD_TERMS: Readonly<Partial<Record<SectionId, readonly string[]>>> = {
  tools: ["agent"],
  ai_security: ["agent"],
  analysis: ["agent"],
};

const compileBeats = (beats: Readonly<Partial<Record<SectionId, readonly string[]>>>): Map<string, TermMatcher> =>
  new Map(Object.entries(beats).map(([id, terms]) => [id, compileTerms(terms ?? [], { plural: true })]));

const strong: TermMatcher = compileTerms(STRONG_TERMS, { plural: true });
const homeBeat = compileBeats(HOME_BEAT_TERMS);
const homeBeatLead = compileBeats(HOME_BEAT_LEAD_TERMS);
const context: TermMatcher = compileTerms([...COMPUTE_TERMS, ...CONTEXT_TERMS], { plural: true });

// "AIStor", "AIOps": AI as a capitalised prefix. Case-sensitive on purpose (compileTerms is not),
// and the next letters must be Xx so "AIDS" / "AIM" stay out.
const AI_PREFIX_RE = /(?<![\p{L}\p{N}])AI(?=[A-Z][a-z])/u;

function strongHits(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = strong.terms(text);
  if (AI_PREFIX_RE.test(text) && !hits.includes("ai")) hits.push("ai");
  // "ai" + "ai-powered" / "llm" + "llm*" are one signal, not two.
  return dedupeOverlaps(hits);
}

// Spellings of ONE signal. Maker / product pairs ("OpenAI" + "ChatGPT") stay two signals: a summary
// naming both is about AI.
const CANONICAL: Readonly<Record<string, string>> = {
  "a.i.": "ai", "ai-generated": "ai", "ai-powered": "ai", "artificial intelligence": "ai", "genai": "generative",
  "llm*": "llm", "large language model": "llm", "language model": "llm", "neural network": "neural", "neural net": "neural",
  "chatgpt*": "gpt*", "sam altman": "altman", "huggingface": "hugging face", "llama.cpp": "llama", "robotic*": "robot",
  "open weights": "open-weight", "model weights": "open-weight", "finetun*": "fine-tun*", "voice clone": "voice cloning",
  "autonomous driving": "self-driving", "autonomous vehicle": "self-driving", "robotaxi": "self-driving",
};

/** Collapse different spellings of one signal ("AI" + "artificial intelligence" is ONE mention, not two). */
function dedupeOverlaps(hits: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hits) {
    const c = CANONICAL[h.toLowerCase()] ?? h.toLowerCase();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// The one "agent" that is never an AI agent on a security or developer desk: the HTTP User-Agent.
const NOT_A_BEAT_RE = /\buser[-\s]agents?\b/gi;
const beatText = (text: string | null | undefined): string => (text ?? "").replace(NOT_A_BEAT_RE, " ");

export type GateRule = "title" | "summary" | "summary-lead" | "context" | "home-beat" | "none";

export interface GateVerdict {
  pass: boolean;
  /** Which clause decided (see the header comment). */
  rule: GateRule;
  /** Distinct signals found: strong terms first, then the context / beat term that counted. */
  hits: string[];
}

export interface GateOptions {
  /** The source's home section (enables that desk's beat vocabulary). */
  home?: SectionId;
}

/** Number of distinct STRONG signals a summary needs when the title has none. */
export const SUMMARY_HITS_REQUIRED = 2;
/** A single STRONG term this early in the summary is its subject, not an aside. */
export const LEAD_CHARS = 100;

// "Plus! Jensen!?; Elasticity, Illustrated; Hiring" (The Diff), "Also black swan funds, data center
// delays and billable hour valuation." (Money Stuff), "Plus, Anthropic S-1 reactions & ..." (Newcomer).
// Capitalised and at the very start; "also known as ..." (the tail of a definition) is not a teaser.
const TEASER_RE = /^\s*(?:Plus|Also)\b\s*[!:,]?\s+(?!known\b)/;

/** Is the summary a newsletter's "also in this issue" line (a list of its other items)? */
export function isTeaserSummary(summary: string | null | undefined): boolean {
  return typeof summary === "string" && TEASER_RE.test(summary);
}

/** Is a general-source item about AI? Pure; see the header comment for the rule. */
export function aiRelevance(title: string, summary: string | null | undefined, opts: GateOptions = {}): GateVerdict {
  const inTitle = strongHits(title);
  if (inTitle.length > 0) return { pass: true, rule: "title", hits: inTitle };

  const inSummary = strongHits(summary);
  if (inSummary.length >= SUMMARY_HITS_REQUIRED) return { pass: true, rule: "summary", hits: inSummary };

  if (inSummary.length === 1) {
    if (!isTeaserSummary(summary) && strongHits(summary?.slice(0, LEAD_CHARS)).length > 0) return { pass: true, rule: "summary-lead", hits: inSummary };
    const titleContext = context(title);
    if (titleContext) return { pass: true, rule: "context", hits: [...inSummary, titleContext.term] };
  }

  const beat = opts.home ? (homeBeat.get(opts.home)?.(beatText(title)) ?? homeBeatLead.get(opts.home)?.(beatText(summary?.slice(0, LEAD_CHARS)))) : null;
  if (beat) return { pass: true, rule: "home-beat", hits: [beat.term] };
  return { pass: false, rule: "none", hits: inSummary };
}
