// Shared by the registry source files: term lists used by several sources.
// Term lists use the shared/text.ts compileTerms syntax (word-boundary phrases, "*" wildcards,
// case-insensitive) - NOT regular expressions.

/**
 * AI-relevance terms for government / regulator feeds. Used as `include`, which REPLACES the global
 * gate for a scope "general" source: US federal agencies now write "Super Intelligence" where they
 * used to write "AI" (NIST topic slug, SEC / OCC / CFTC titles, Federal Register), and several feeds
 * only say what a document is about in the description.
 */
export const GOV_AI_TERMS: string[] = [
  "AI", "A.I.", "artificial intelligence", "super intelligence", "superintelligence", "machine learning",
  "generative", "large language model*", "LLM", "LLMs", "algorithm*", "chatbot*", "agentic",
  "automated decision*", "predictive analytics", "deepfake*", "robo-advis*", "CAISI", "CAISSI",
];

/**
 * The compliance beat for the US securities regulators (FINRA, SEC): the rules a broker-dealer's
 * security and compliance functions answer for, whether or not the document mentions AI. OR-ed with GOV_AI_TERMS on those feeds only.
 * Deliberately specific: no bare "supervision", "technology", "communications", "vendor" or
 * "broker-dealer" (each admitted noise on the 2026-11-20 corpus when tried on the SEC feeds).
 */
export const FINREG_OWNER_TERMS: string[] = [
  "Rule 2210", "communications with the public", "Rule 3110", "Rule 4511", "books and records", "recordkeeping",
  "Rule 4530", "Rule 4513", "Rule 17a-4", "Regulation S-P", "Reg S-P", "Regulation S-ID", "cybersecurity", "cyber",
  "vendor*", "third-party", "outsourc*", "off-channel", "digital communication*", "account takeover*", "identity theft",
  "examination priorities", "exam priorities",
];

/**
 * Owner-beat terms for the other prudential / standard-setter feeds (OCC, IOSCO, Bank of England):
 * cyber, third-party risk, operational resilience and post-quantum guidance is on-mission for this
 * reader without an AI word. OR-ed with GOV_AI_TERMS. Do not add "broker-dealer" or bare "vendor".
 */
export const GOV_OWNER_TERMS: string[] = [
  "cyber*", "third-party risk", "operational resilience", "quantum", "post-quantum", "Reg S-P", "Regulation S-P",
];

/**
 * Title vocabulary of a local-inference post: runtimes, open-weight families, quantization, the
 * hardware it runs on. Used as a TITLE include (includeIn "title") on community feeds homed in
 * LOCAL & OPEN MODELS, where half the threads are chatter ('Jensen Huang Breaks Silence', 'How it
 * actually happened'). No bare "LLM" or "AI": every thread there says it.
 */
export const LOCAL_STACK_TERMS: string[] = [
  "llama.cpp", "Ollama", "vLLM", "SGLang", "MLX*", "LM Studio", "exo", "Open WebUI", "GGUF*", "quant*", "Unsloth", "LoRA*", "fine-tun*", "finetun*",
  "Qwen*", "Gemma*", "DeepSeek*", "Mistral*", "Kimi*", "GLM*", "LFM*", "Llama*", "Hermes", "Nemotron*", "Granite*", "abliterat*",
  "model", "models", "open weight*", "open-weight*", "inference", "benchmark*", "tok/s", "tokens/s",
  "GPU*", "VRAM", "RTX*", "DGX*", "Apple Silicon", "Mac Studio", "Mac mini", "M3 Ultra", "M4 Max", "M5 Max", "M5 Ultra",
];

/** CVE classes that are noise for the local-LLM stack watches (availability-only bugs). */
export const CVE_NOISE_TERMS: string[] = [
  "denial of service", "DoS", "ReDoS", "resource exhaustion", "memory exhaustion", "null pointer",
];

/** Commit-feed titles that mean "a new model can now be loaded" (fixes and refactors are skipped). */
export const MODEL_SUPPORT_TERMS: string[] = ["add", "adds", "added", "support", "supports"];
