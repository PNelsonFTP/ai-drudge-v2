// About page model (#/about): the static reference data (keyboard shortcuts, legend) and the data
// freshness line. Pure.

import { WEIGHT_CLASSES } from "../../../shared/select";
import { NEW_WITHIN_HOURS, parseMs, shortAge, staleHours } from "../../../shared/time";
import type { EditionState } from "../../app/services";
import { staleThresholdHours } from "../chrome/model";
import { FLAG_LABELS } from "../headline/rowModel";

export interface Shortcut {
  keys: readonly string[];
  action: string;
}

/** The keyboard map of V2_PLAN §1.4 (implemented by the shell; listed here for the reader). */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["j", "k"], action: "Next / previous headline" },
  { keys: ["o", "Enter"], action: "Open the headline in a new tab" },
  { keys: ["s"], action: "Show or hide the summary" },
  { keys: ["a"], action: "Show or hide the “Also:” coverage links" },
  { keys: ["b"], action: "Bookmark" },
  { keys: ["l"], action: "Read later" },
  { keys: ["m"], action: "Mute the headline’s source" },
  { keys: ["/"], action: "Search" },
  { keys: ["[", "]"], action: "Previous / next section" },
  { keys: ["g", "h"], action: "Go to the home page" },
  { keys: ["g", "s"], action: "Go to bookmarks" },
  { keys: ["g", "l"], action: "Go to read later" },
  { keys: ["g", "w"], action: "Go to the watchlist" },
  { keys: ["g", "n"], action: "Go to “new since your last visit”" },
  { keys: ["?"], action: "Show the shortcut help" },
  { keys: ["u"], action: "Undo the last mute (while its notice is showing)" },
  { keys: ["Esc"], action: "Close a dialog or menu, leave the search box" },
];

export interface WeightLegend {
  /** CSS class the headline carries (shared/select.ts WEIGHT_CLASSES). */
  className: (typeof WEIGHT_CLASSES)[number];
  sample: string;
  meaning: string;
}

/** Headline emphasis, biggest first. Emphasis is STORY SIZE, never "this feed is important". */
export const WEIGHT_LEGEND: readonly WeightLegend[] = [
  { className: WEIGHT_CLASSES[3], sample: "Red and bold", meaning: "A very big story: 8 or more publishers are covering it." },
  { className: WEIGHT_CLASSES[2], sample: "Bold", meaning: "A big story: 3 or more publishers, or a launch announced by a top-tier lab or company itself." },
  { className: WEIGHT_CLASSES[1], sample: "Regular", meaning: "Everything else." },
  {
    className: WEIGHT_CLASSES[0],
    sample: "Grey italic",
    meaning: "An item from a low-tier source (community threads, long-tail blogs) that no second publisher is covering. Italic, so it is not mistaken for a headline you have already seen.",
  },
];

/** Label of the legend row that explains seen-dimming (the About page adds the Settings hint to it). */
export const SEEN_LEGEND_LABEL = "Grey";

export interface BadgeLegend {
  label: string;
  /** Class used to draw the sample ("" = plain text). */
  className: string;
  meaning: string;
}

/** The dotted chip a row draws for an article flag (headline.css .hl-flag), with the row's own label. */
const FLAG_CLASS = "hl-flag";

export const BADGE_LEGEND: readonly BadgeLegend[] = [
  { label: "NEW", className: "sp-warn", meaning: `First seen in the last ${NEW_WITHIN_HOURS} hours and not yet seen by you.` },
  { label: "+4", className: "related-badge", meaning: "Four more publishers cover the same story. Open it to see the “Also:” links to each of them; outlets listed after “also linked:” point to the story but are not counted." },
  { label: "SOURCE", className: "source-badge", meaning: "The feed the headline came from. For search-style feeds the outlet named is the article’s own site." },
  { label: FLAG_LABELS.release, className: FLAG_CLASS, meaning: "A software release line from a project’s release feed (Release Radar)." },
  { label: FLAG_LABELS.paper, className: FLAG_CLASS, meaning: "A research paper listing." },
  { label: FLAG_LABELS.discussion, className: FLAG_CLASS, meaning: "A community thread about a story, not an article." },
  { label: FLAG_LABELS.paywall, className: FLAG_CLASS, meaning: "The source usually requires a subscription." },
  {
    label: SEEN_LEGEND_LABEL,
    className: "headline-seen",
    meaning:
      "Grey, regular weight and upright: you already saw the headline during an earlier visit (a low-tier source is grey and italic). Only section and list rows are dimmed - never the lead story, TOP STORIES or your saved lists.",
  },
  { label: "highlight", className: "sp-mark", meaning: "The headline matches one of your watch terms." },
];

export interface Freshness {
  /** False while no edition is loaded. */
  available: boolean;
  generatedAt: string | null;
  /** "20m", "3h", "2d" since the edition was generated; "" when unknown. */
  age: string;
  buildId: string;
  stories: number;
  feedsOk: number;
  feedsTotal: number;
  /** Older than the stale-banner threshold (the shell's `staleThresholdHours(state)`, so About never contradicts the banner). */
  stale: boolean;
  /** That threshold in words: "2 hours" (status.json staleAfterMinutes 120), "90 minutes". */
  staleAfter: string;
  /** "claude" when this edition carries an AI-written brief, "fallback" when it does not, null when unknown. */
  brief: "claude" | "fallback" | null;
  briefModel: string | null;
  /** Why the edition has no AI-written brief, in plain words (BriefFile.fallbackReason); null when unknown or not applicable. */
  briefReason: string | null;
}

/** BriefFile.fallbackReason codes (scripts/pipeline/enrich/brief.ts) as the reader is told them. */
const BRIEF_REASONS: Readonly<Record<string, string>> = {
  "no-key": "the build has no key for the AI service, so no model was asked",
  thin: "there were too few top stories to summarise",
  "http-4xx": "the AI service rejected the request (for example an invalid or expired key)",
  "http-5xx": "the AI service reported a server error",
  timeout: "the AI service did not answer in time",
  network: "the AI service could not be reached",
  refusal: "the AI model declined to write it",
  truncated: "the AI model’s reply was cut off",
  "invalid-reply": "the AI model’s reply did not pass the build’s checks",
  error: "the brief step failed",
};

/**
 * A fallback reason in plain words. The field is a coarse code by contract, but it arrives in a
 * payload: an unknown value is shown only when it looks like a code, never as free text.
 */
export function briefReasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = Object.prototype.hasOwnProperty.call(BRIEF_REASONS, code) ? BRIEF_REASONS[code] : undefined;
  if (known) return known;
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(code) ? `reason code “${code}”` : null;
}

/** A stale threshold in words: whole hours as "2 hours", anything else in minutes ("90 minutes"). */
export function staleAfterText(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

export function freshness(state: Pick<EditionState, "edition" | "brief" | "staleAfterMinutes">, nowMs: number): Freshness {
  const e = state.edition;
  const brief = state.brief ? state.brief.source : null;
  const briefModel = state.brief?.source === "claude" ? (state.brief.model ?? null) : null;
  const briefReason = state.brief?.source === "fallback" ? briefReasonText(state.brief.fallbackReason) : null;
  const threshold = staleThresholdHours(state);
  const staleAfter = staleAfterText(threshold);
  if (!e) return { available: false, generatedAt: null, age: "", buildId: "", stories: 0, feedsOk: 0, feedsTotal: 0, stale: false, staleAfter, brief, briefModel, briefReason };
  const hours = staleHours(e.meta.generatedAt, nowMs);
  return {
    available: true,
    generatedAt: parseMs(e.meta.generatedAt) === null ? null : e.meta.generatedAt,
    age: shortAge(e.meta.generatedAt, nowMs),
    buildId: e.meta.buildId,
    stories: e.counts.stories,
    feedsOk: e.counts.feedsOk,
    feedsTotal: e.counts.feedsTotal,
    stale: hours !== null && hours > threshold,
    staleAfter,
    brief,
    briefModel,
    briefReason,
  };
}
