// Importance: a modest, TITLE-ONLY, word-boundary signal that a headline reports an event.
//
// V1 ran `haystack.includes(needle)` over title + summary: "sues" fired on "issues", "valuation" on
// "evaluation", "announc" on arXiv's "Announce Type: new" boilerplate, and "first " on anything.
// It moved 41 of 185 homepage slots and decided the lead. Here four signals are matched with the
// shared compiled matcher on the title alone, a launch verb only counts next to a model / vendor
// name, and the sum is capped at SCORE.importance.max (story SIZE carries significance, not words).

import { compileTerms } from "../../../shared/text";
import { SCORE } from "./weights";

// Family-level names, not version strings (V1's "gpt-5" and " o3" had rotted).
const ENTITIES = compileTerms([
  "openai", "chatgpt", "gpt*", "sora", "codex", "anthropic", "claude", "google", "deepmind", "gemini*", "gemma*", "veo",
  "meta", "llama*", "microsoft", "copilot", "phi-*", "xai", "grok*", "mistral", "deepseek", "qwen*", "alibaba", "moonshot",
  "kimi", "baidu", "ernie", "zhipu", "glm-*", "minimax", "cohere", "perplexity", "nvidia", "amd", "intel", "apple", "amazon",
  "aws", "bedrock", "nova", "hugging face", "ollama", "stability ai", "stable diffusion", "midjourney", "runway", "elevenlabs",
  "cursor", "windsurf", "databricks", "snowflake", "ibm", "granite", "tesla", "figure", "boston dynamics",
]);

const LAUNCH = compileTerms([
  "introducing", "introduces", "launch", "launches", "launched", "launching", "releases", "released", "unveils", "unveiled",
  "announces", "announced", "ships", "shipped", "rolls out", "rolling out", "debuts", "now available", "generally available",
  "general availability", "open-sources", "open-sourced", "open-weights", "is here",
]);

// A model family followed by a number, optionally with one capitalised codename in between:
// "Gemini 4", "GPT-6.2", "Qwen3.8", "Llama 4", "o5", "Claude Fable 5.2".
const MODEL_FAMILY = /(?<![\p{L}\p{N}])(?:gpt|gemini|gemma|claude|opus|sonnet|haiku|llama|qwen|grok|phi|glm|kimi|deepseek|mistral|nova|sora|veo|o)(?![\p{L}])/giu;
const VERSION_AFTER = /^(?:[\s-]\p{Lu}\p{L}*)?[\s-]?v?\d/u;
// A product the family list has never heard of still launches the same way: a capitalised name
// directly followed by a one- or two-digit version, as the OBJECT of the launch verb ("Introducing Genie 4") or as
// the subject of "is now available" / "released" ("Genie 4 is now available"). Matching the name
// anywhere would take "With 12 Partners" and "November 19" for versions.
const VERSIONED_NAME = /^(?:the\s+)?\p{Lu}[\p{L}\p{N}.]*[\s-]?[A-Za-z]?\d{1,2}(?:\.\d+)?(?![\p{N}%])/u;
const LAUNCH_OBJECT = /(?:^|[\s:])(?:introducing|announcing|launches|launching|releases|releasing|unveils|unveiling|ships|shipping|meet)\s+/giu;
const AVAILABLE_SUBJECT = /\s+(?:(?:is|are)\s+)?(?:now\s+)?(?:generally\s+)?(?:available|here|live|out|released)(?![\p{L}])/iu;

const MONEY_AMOUNT = /[$€£]\s?\d[\d.,]*\s?(?:k|m|mn|million|b|bn|billion|t|tn|trillion)(?![\p{L}\p{N}])/iu;
const FUNDING_WITH_AMOUNT = compileTerms([
  "raises", "raised", "raise", "funding", "round", "series a", "series b", "series c", "series d", "series e", "series f",
  "seed", "valuation", "valued", "invests", "investment", "stake", "deal", "buys", "to buy", "buyout",
]);
const DEAL = compileTerms(["ipo", "acquires", "acquired", "acquisition", "to acquire", "merger", "merges", "takeover", "goes public"]);

const REGULATORY = compileTerms([
  "sues", "sued", "suing", "lawsuit", "lawsuits", "fined", "fines", "ban", "bans", "banned", "probe", "probes",
  "investigation", "investigating", "investigates", "subpoena*", "antitrust", "indict*", "sanction*", "executive order",
  "export control*", "settlement", "settles", "ruling", "injunction", "regulator", "regulators", "legislation", "ai act",
  "enforcement action", "cease and desist", "class action", "court", "tribunal", "senate", "congress", "caucus",
]);

const SECURITY = compileTerms([
  "breach", "breached", "breaches", "hacked", "hack", "hackers", "ransomware", "zero-day", "0-day", "exploited",
  "exploit", "exploits", "rce", "remote code execution", "vulnerability", "vulnerabilities", "cve-*", "data leak",
  "leaked", "backdoor", "backdoored", "supply chain attack", "prompt injection", "jailbreak*", "malware", "cyberattack",
  "cyberattacks", "outage", "compromised",
]);

export interface ImportanceParts {
  launch: number;
  funding: number;
  regulatory: number;
  security: number;
  /** Sum, capped at SCORE.importance.max. */
  total: number;
}

/** True when the title names a versioned model ("Gemini 4 Neon", "GPT-6.2 Astra", "Claude Fable 5.2"). */
export function namesVersionedModel(title: string): boolean {
  for (const m of title.matchAll(MODEL_FAMILY)) {
    if (VERSION_AFTER.test(title.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/** True when the title pairs a launch / release verb with a model or vendor name. */
export function isLaunchTitle(title: string): boolean {
  return LAUNCH(title) !== null && (ENTITIES(title) !== null || namesVersionedModel(title));
}

/**
 * True when the title launches a VERSIONED model or product ("Introducing Gemini 4 Neon", "Genie 4
 * is now available"). Stricter than isLaunchTitle on what is launched and laxer on who launches
 * it: the score stage only asks this of tier-1 first-party sources.
 */
export function isModelLaunchTitle(title: string): boolean {
  if (LAUNCH(title) === null) return false;
  if (namesVersionedModel(title)) return true;
  for (const m of title.matchAll(LAUNCH_OBJECT)) {
    if (VERSIONED_NAME.test(title.slice(m.index + m[0].length))) return true;
  }
  return VERSIONED_NAME.test(title.trimStart()) && AVAILABLE_SUBJECT.test(title);
}

/** Importance of a headline. Pure function of the title. */
export function importanceOf(title: string): ImportanceParts {
  const w = SCORE.importance;
  const launch = isLaunchTitle(title) ? w.launch + (namesVersionedModel(title) ? w.versionedModel : 0) : 0;
  const funding = (MONEY_AMOUNT.test(title) && FUNDING_WITH_AMOUNT(title) !== null) || DEAL(title) !== null ? w.funding : 0;
  const regulatory = REGULATORY(title) !== null ? w.regulatory : 0;
  const security = SECURITY(title) !== null ? w.security : 0;
  return { launch, funding, regulatory, security, total: Math.min(w.max, launch + funding + regulatory + security) };
}
