// One-click presets (V2_PLAN §1.4). Data only. Owned by WP0 so the settings page (WP10), the
// watchlist store (WP7) and the home page (WP9) agree on ids and contents.

import { SECTION_IDS, type SectionId } from "../../shared/sections";
import type { SectionPreset, WatchPreset } from "./services";

/** Watchlist suggestions. The watchlist ships EMPTY; these are offered as one-click additions. */
export const WATCH_PRESETS: readonly WatchPreset[] = [
  {
    id: "ciso",
    label: "CISO",
    terms: [
      "prompt injection",
      "jailbreak",
      "data exfiltration",
      "model theft",
      "supply chain",
      "zero-day",
      "ransomware",
      "CrowdStrike",
      "MCP",
      "agent security",
      "deepfake",
      "CVE-*",
    ],
  },
  {
    id: "local-llm",
    label: "Local LLM",
    // "Qwen*" / "Gemma*": a watch term is a whole word, and model names carry their version
    // ("Qwen4-Max", "Qwen3.8", "Gemma3") - plain "Qwen" matched 5 of 12 Qwen headlines in a week.
    terms: ["llama.cpp", "GGUF", "Ollama", "MLX", "vLLM", "Qwen*", "Gemma*", "quantiz*", "Apple Silicon", "Mac Studio", "DGX", "open weights"],
  },
  {
    id: "finance-regulation",
    label: "Finance regulation",
    terms: ["SEC", "FINRA", "CFTC", "OCC", "Federal Reserve", "FCA", "ESMA", "Reg S-P", "broker-dealer", "AI washing", "model risk", "EU AI Act"],
  },
];

/** Section layout presets: "Default / CISO / Local lab / Markets". */
export const SECTION_PRESETS: readonly SectionPreset[] = [
  { id: "default", label: "Default", order: null, hidden: [] },
  {
    id: "ciso",
    label: "CISO",
    order: [
      "ai_security", "cyber", "policy", "models", "industry", "tools", "safety", "open_local",
      "money", "compute", "research", "analysis", "quantum", "releases", "robotics",
    ],
    hidden: [],
  },
  {
    id: "local-lab",
    label: "Local lab",
    order: [
      "open_local", "releases", "models", "tools", "compute", "research", "ai_security", "industry",
      "analysis", "policy", "money", "safety", "cyber", "robotics", "quantum",
    ],
    hidden: [],
  },
  {
    id: "markets",
    label: "Markets",
    order: [
      "money", "industry", "policy", "models", "compute", "analysis", "ai_security", "tools",
      "open_local", "research", "safety", "cyber", "robotics", "quantum", "releases",
    ],
    hidden: [],
  },
];

/** Default section order (shared/sections.ts order), spelled out for the settings UI. */
export const DEFAULT_SECTION_ORDER: readonly SectionId[] = SECTION_IDS;

export function watchPresetById(id: string): WatchPreset | undefined {
  return WATCH_PRESETS.find((p) => p.id === id);
}

export function sectionPresetById(id: string): SectionPreset | undefined {
  return SECTION_PRESETS.find((p) => p.id === id);
}
