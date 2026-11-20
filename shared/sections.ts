// The ONLY declaration of the V2 section taxonomy (V2_PLAN §1.1).
// 15 sections replace V1's 18. Homepage order = SECTIONS array order.
// Pure data + lookups: no node:, no DOM.

export const SECTION_IDS = [
  "models",
  "industry",
  "ai_security",
  "open_local",
  "tools",
  "policy",
  "money",
  "research",
  "compute",
  "safety",
  "cyber",
  "analysis",
  "robotics",
  "quantum",
  "releases",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/**
 * Editorial desk.
 * - "ai":      feeds TOP STORIES, the lead, the brief and the Atom feed.
 * - "owner":   owner-interest wire (cyber, quantum). Never in TOP STORIES / lead / brief / Atom.
 * - "utility": reference lists (release radar). Never in TOP STORIES / lead / brief / Atom.
 */
export type Desk = "ai" | "owner" | "utility";

/**
 * - "topic":  accepts gated items from ANY source via routing rules (plus its home sources).
 * - "source": only shows items whose source's `home` is this section. Nothing is routed in.
 */
export type SectionMode = "topic" | "source";

export interface SectionWindow {
  /** Preferred freshness: items at most this old (by effectiveAt) fill the section first. */
  softDays: number;
  /** Hard cut-off: nothing older than this (by effectiveAt) is ever shown. */
  hardDays: number;
  /** Starvation fill: backfill from soft..hard window until at least this many rows exist. */
  minItems: number;
}

/** The 18 V1 category ids (kept only for migration: V1 mutes, the registry import, the V1/V2 compare tool). */
export const LEGACY_SECTION_IDS = [
  "model_releases",
  "industry_news",
  "local_models",
  "agents_tools",
  "ai_finance",
  "research",
  "products",
  "hardware",
  "open_source",
  "safety_policy",
  "ai_security",
  "cyber_threats",
  "cyber_defense",
  "funding",
  "analysis",
  "robotics",
  "quantum",
  "github_repos",
] as const;

export type LegacySectionId = (typeof LEGACY_SECTION_IDS)[number];

export interface SectionDef {
  id: SectionId;
  /** Full heading, upper case ("MODELS & LABS"). */
  label: string;
  /** Chip / nav label ("MODELS"). */
  short: string;
  desk: Desk;
  mode: SectionMode;
  window: SectionWindow;
  /** Rows shown on the homepage (front.json rows per section never exceed this). */
  homeRows: number;
  /** Rows kept for "view all" (rest.json rows per section never exceed this). */
  allRows: number;
  /** Max share of a section's rows one publisher may hold (diversity cap). Default 0.3. */
  maxPublisherShare: number;
  /** V1 category ids folded into this section. "safety_policy" appears under BOTH policy and safety. */
  legacyIds: readonly LegacySectionId[];
}

export const DEFAULT_MAX_PUBLISHER_SHARE = 0.3;

function def(
  id: SectionId,
  label: string,
  short: string,
  desk: Desk,
  mode: SectionMode,
  softDays: number,
  hardDays: number,
  minItems: number,
  homeRows: number,
  allRows: number,
  legacyIds: readonly LegacySectionId[],
): SectionDef {
  return {
    id,
    label,
    short,
    desk,
    mode,
    window: { softDays, hardDays, minItems },
    homeRows,
    allRows,
    maxPublisherShare: DEFAULT_MAX_PUBLISHER_SHARE,
    legacyIds,
  };
}

// id, label, short, desk, mode, soft/hard days, minItems, home rows, view-all rows, V1 ids
export const SECTIONS: readonly SectionDef[] = [
  // models: 5 / 10 days (was 3 / 6). A flagship release is news for a working week: at 3 days
  // "Qwen4-Max: Your New Teammate Has Arrived" (96 h old on 2026-11-20) was listed nowhere.
  def("models", "MODELS & LABS", "MODELS", "ai", "topic", 5, 10, 4, 10, 25, ["model_releases"]),
  def("industry", "INDUSTRY", "INDUSTRY", "ai", "source", 2, 4, 6, 12, 40, ["industry_news"]),
  def("ai_security", "AI SECURITY", "AI SEC", "ai", "topic", 7, 14, 5, 10, 30, ["ai_security"]),
  def("open_local", "LOCAL & OPEN MODELS", "LOCAL", "ai", "topic", 4, 8, 4, 10, 25, ["local_models", "open_source"]),
  def("tools", "AGENTS & TOOLS", "TOOLS", "ai", "topic", 3, 6, 4, 10, 25, ["agents_tools", "products"]),
  def("policy", "POLICY & REGULATION", "POLICY", "ai", "topic", 7, 21, 4, 10, 30, ["safety_policy"]),
  def("money", "MARKETS & DEALS", "MONEY", "ai", "topic", 3, 6, 4, 10, 25, ["ai_finance", "funding"]),
  def("research", "RESEARCH", "RESEARCH", "ai", "source", 7, 10, 4, 10, 25, ["research"]),
  def("compute", "CHIPS & COMPUTE", "COMPUTE", "ai", "topic", 5, 10, 4, 10, 25, ["hardware"]),
  def("safety", "SAFETY & ALIGNMENT", "SAFETY", "ai", "source", 14, 21, 3, 8, 20, ["safety_policy"]),
  def("cyber", "CYBER WIRE", "CYBER", "owner", "source", 3, 7, 5, 10, 25, ["cyber_threats", "cyber_defense"]),
  def("analysis", "ANALYSIS", "ANALYSIS", "ai", "source", 10, 21, 4, 10, 25, ["analysis"]),
  def("robotics", "ROBOTICS", "ROBOTICS", "ai", "topic", 7, 14, 3, 8, 20, ["robotics"]),
  def("quantum", "QUANTUM WATCH", "QUANTUM", "owner", "source", 14, 21, 3, 5, 15, ["quantum"]),
  def("releases", "RELEASE RADAR", "RELEASES", "utility", "source", 5, 10, 4, 10, 25, ["github_repos"]),
];

const BY_ID: ReadonlyMap<string, SectionDef> = new Map(SECTIONS.map((s) => [s.id as string, s]));
const ORDER: ReadonlyMap<string, number> = new Map(SECTIONS.map((s, i) => [s.id as string, i]));

export function isSectionId(x: unknown): x is SectionId {
  return typeof x === "string" && BY_ID.has(x);
}

/** Section definition by id. Throws on an unknown id (ids are a closed union; unknown = a bug or bad data). */
export function sectionById(id: SectionId): SectionDef {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown section id: ${String(id)}`);
  return s;
}

/** Non-throwing lookup for untrusted input (URL hash, storage, payloads). */
export function findSection(id: string): SectionDef | undefined {
  return BY_ID.get(id);
}

/** Position in homepage order (0-based); -1 for unknown ids. Use as a sort key. */
export function sectionOrder(id: string): number {
  return ORDER.get(id) ?? -1;
}

export function sectionLabel(id: SectionId): string {
  return sectionById(id).label;
}

/** Sections of a desk, in homepage order. */
export function sectionsOfDesk(desk: Desk): SectionDef[] {
  return SECTIONS.filter((s) => s.desk === desk);
}

/** True when stories of this section may feed TOP STORIES, the lead, the brief and the Atom feed. */
export function isAiDesk(id: SectionId): boolean {
  return sectionById(id).desk === "ai";
}

/**
 * V1 category id -> the V2 sections it was folded into.
 * Every V1 id maps to exactly one section except "safety_policy", which was split into
 * ["policy", "safety"] (policy first: it is the default when nothing else is known).
 */
export const LEGACY_TO_SECTIONS: Readonly<Record<LegacySectionId, readonly SectionId[]>> = {
  model_releases: ["models"],
  industry_news: ["industry"],
  local_models: ["open_local"],
  open_source: ["open_local"],
  agents_tools: ["tools"],
  products: ["tools"],
  ai_finance: ["money"],
  funding: ["money"],
  research: ["research"],
  hardware: ["compute"],
  safety_policy: ["policy", "safety"],
  ai_security: ["ai_security"],
  cyber_threats: ["cyber"],
  cyber_defense: ["cyber"],
  analysis: ["analysis"],
  robotics: ["robotics"],
  quantum: ["quantum"],
  github_repos: ["releases"],
};

export function isLegacySectionId(x: unknown): x is LegacySectionId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(LEGACY_TO_SECTIONS, x);
}

/**
 * Primary V2 section for a V1 category id (undefined for unknown ids).
 * "safety_policy" -> "policy" by default; pass `safetyHalf: true` for a source that belongs to the
 * safety/alignment half (the registry decides per source).
 */
export function legacyToSection(legacyId: string, opts?: { safetyHalf?: boolean }): SectionId | undefined {
  if (!isLegacySectionId(legacyId)) return undefined;
  if (legacyId === "safety_policy") return opts?.safetyHalf ? "safety" : "policy";
  return LEGACY_TO_SECTIONS[legacyId][0];
}

/** All V2 sections a V1 category id maps to ([] for unknown ids). Use for migrating V1 muted categories. */
export function legacyToSections(legacyId: string): readonly SectionId[] {
  return isLegacySectionId(legacyId) ? LEGACY_TO_SECTIONS[legacyId] : [];
}
