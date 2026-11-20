// Settings page model (#/settings): section order / hide / presets, the mutes list, the backup
// dry-run summary and the "import from V1" status. Pure.

import { SECTION_IDS, findSection, isSectionId, legacyToSections, type SectionId } from "../../../shared/sections";
import type { MuteSet } from "../../../shared/select";
import { parseMs } from "../../../shared/time";
import type { BackupService, MigrationCounts, MigrationReport, SectionPreset, Settings, SettingsStore } from "../../app/services";
import { readerSectionOrder } from "../export/kit/rows";

// ------------------------------------------------------------------------------------------------
// Section order, hide / show, presets
// ------------------------------------------------------------------------------------------------

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** What to store for an order: null when it equals the default order (so new sections slot in naturally). */
export function storedOrder(order: readonly SectionId[]): SectionId[] | null {
  const full = readerSectionOrder(order);
  return sameOrder(full, SECTION_IDS) ? null : full;
}

/**
 * Move a section one place up (-1) or down (+1) in the reader's order. Returns the new value for
 * Settings.sectionOrder; the same order (normalised) when the move is not possible.
 */
export function moveSection(stored: readonly string[] | null, id: SectionId, delta: -1 | 1): SectionId[] | null {
  const order = readerSectionOrder(stored);
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return storedOrder(order);
  [order[i], order[j]] = [order[j], order[i]];
  return storedOrder(order);
}

/** Pin: move a section to the top of the reader's order. */
export function pinSection(stored: readonly string[] | null, id: SectionId): SectionId[] | null {
  const order = readerSectionOrder(stored);
  return storedOrder([id, ...order.filter((s) => s !== id)]);
}

/** Toggle a section in Settings.hiddenSections (unknown ids are dropped, order follows the default). */
export function toggleHidden(hidden: readonly string[], id: SectionId): SectionId[] {
  const set = new Set<SectionId>(hidden.filter(isSectionId));
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return SECTION_IDS.filter((s) => set.has(s));
}

export interface SectionSetting {
  id: SectionId;
  label: string;
  short: string;
  /** 1-based position in the reader's order. */
  position: number;
  hidden: boolean;
  canUp: boolean;
  canDown: boolean;
}

/** The 15 sections in the reader's order with their flags, for the reorder list. */
export function sectionSettings(settings: Pick<Settings, "sectionOrder" | "hiddenSections">): SectionSetting[] {
  const order = readerSectionOrder(settings.sectionOrder);
  const hidden = new Set<string>(settings.hiddenSections);
  return order.map((id, i) => {
    const def = findSection(id);
    return { id, label: def?.label ?? id, short: def?.short ?? id, position: i + 1, hidden: hidden.has(id), canUp: i > 0, canDown: i < order.length - 1 };
  });
}

/** Settings values of a preset. Unknown section ids in a preset are ignored so presets survive taxonomy changes. */
export function applyPreset(preset: SectionPreset): Pick<Settings, "sectionOrder" | "hiddenSections"> {
  return {
    sectionOrder: preset.order ? storedOrder(preset.order.filter(isSectionId)) : null,
    hiddenSections: SECTION_IDS.filter((s) => preset.hidden.includes(s)),
  };
}

export type SectionLayout = Pick<Settings, "sectionOrder" | "hiddenSections">;

/** Write order and hidden sections together: one storage write, one render. */
export function applyLayout(store: Pick<SettingsStore, "patch">, layout: SectionLayout): void {
  store.patch({ sectionOrder: layout.sectionOrder, hiddenSections: layout.hiddenSections });
}

/** Id of the preset the current layout equals, or null for a custom layout. */
export function activePreset(settings: Pick<Settings, "sectionOrder" | "hiddenSections">, presets: readonly SectionPreset[]): string | null {
  const order = readerSectionOrder(settings.sectionOrder);
  const hidden = SECTION_IDS.filter((s) => settings.hiddenSections.includes(s));
  for (const p of presets) {
    const want = applyPreset(p);
    if (sameOrder(readerSectionOrder(want.sectionOrder), order) && sameOrder(want.hiddenSections, hidden)) return p.id;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Mutes
// ------------------------------------------------------------------------------------------------

export type MuteRow = { kind: "section"; id: SectionId; label: string } | { kind: "source"; id: string; label: string };

/**
 * The reader's mutes as rows: sections first (homepage order), then sources by display name.
 * `nameOf` resolves a source id to its display name (edition / sources.json); unknown ids show the id,
 * so a mute whose source left the registry can still be removed.
 */
export function muteRows(mutes: MuteSet, nameOf: (id: string) => string | undefined): MuteRow[] {
  const sections: MuteRow[] = SECTION_IDS.filter((s) => mutes.sections.has(s)).map((s) => ({ kind: "section" as const, id: s, label: findSection(s)?.label ?? s }));
  const sources: MuteRow[] = [...mutes.sources].map((id) => ({ kind: "source" as const, id, label: nameOf(id) ?? id })).sort((a, b) => a.label.localeCompare(b.label));
  return [...sections, ...sources];
}

// ------------------------------------------------------------------------------------------------
// Backup dry run
// ------------------------------------------------------------------------------------------------

/** Largest backup file read into memory for import. */
export const BACKUP_MAX_BYTES = 5_000_000;

export type BackupSummary = { ok: true; lines: string[]; warnings: string[] } | { ok: false; error: string };

const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;

/**
 * Dry-run summary of an import for the page: what BackupService.previewJson reports (the same
 * validation importJson runs, so the summary cannot disagree with the restore). Never changes anything.
 */
export function backupDryRun(backup: Pick<BackupService, "previewJson">, text: string): BackupSummary {
  if (text.length > BACKUP_MAX_BYTES) return { ok: false, error: "The file is too large to be a backup of this site." };
  const preview = backup.previewJson(text);
  if (!preview.ok) return { ok: false, error: preview.error };
  const lines: string[] = [];
  const warnings: string[] = [];
  if (preview.exportedAt) lines.push(`exported ${preview.exportedAt.slice(0, 16).replace("T", " ")} UTC`);
  for (const item of preview.items) {
    if (item.action === "skip") warnings.push(`${item.label} will not be restored${item.detail ? ` (${item.detail})` : ""}.`);
    else lines.push(item.detail ? `${item.label}: ${item.detail}` : item.label);
  }
  return { ok: true, lines, warnings };
}

// ------------------------------------------------------------------------------------------------
// Import from V1
// ------------------------------------------------------------------------------------------------

const IMPORT_LABELS: readonly [key: "bookmarks" | "later" | "mutedSources" | "pendingSourceNames" | "mutedSections" | "seen", one: string, many: string][] = [
  ["bookmarks", "bookmark", "bookmarks"],
  ["later", "read-later item", "read-later items"],
  ["mutedSources", "muted source", "muted sources"],
  ["pendingSourceNames", "muted source awaiting a match", "muted sources awaiting a match"],
  ["mutedSections", "muted section", "muted sections"],
  ["seen", "seen story", "seen stories"],
];

/** What an import brought over, as phrases ("3 bookmarks", "the theme"). */
export function v1ImportedParts(counts: MigrationCounts): string[] {
  const parts: string[] = [];
  for (const [key, one, many] of IMPORT_LABELS) if (counts[key] > 0) parts.push(n(counts[key], one, many));
  if (counts.theme) parts.push("the theme");
  if (counts.lastVisit) parts.push("the last-visit time");
  return parts;
}

/** V1 category mutes named in the import line (the rest is summarised as "and N more"). */
const SKIPPED_SHOWN = 6;

/**
 * The V1 muted categories the import left out, as a sentence ("" when there are none). A V2 section
 * is muted only when every V1 category merged into it was muted, so half a section is not carried
 * over; the reader is told which category, which section it is now part of, and where to mute the
 * whole section. The ids come from V1's localStorage (untrusted): shown as plain text, shortened,
 * at most SKIPPED_SHOWN of them.
 */
export function v1SkippedLine(counts: Pick<MigrationCounts, "skippedCategories">): string {
  const seen = new Set<string>();
  const names: string[] = [];
  // The field comes from stored reader state: anything but a list is "nothing skipped".
  for (const raw of Array.isArray(counts.skippedCategories) ? counts.skippedCategories : []) {
    if (typeof raw !== "string") continue;
    const name = raw.replace(/[_\s]+/g, " ").trim().slice(0, 40);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const sections = legacyToSections(raw.trim()).map((id) => findSection(id)?.label ?? id);
    names.push(`“${name}” (${sections.length > 0 ? `now part of ${sections.join(" and ")}` : "not a section here"})`);
  }
  if (names.length === 0) return "";
  const shown = names.slice(0, SKIPPED_SHOWN);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  return `Not carried over: the V1 mute of ${list}. A section is muted here only when every V1 category merged into it was muted; mute the section under Mutes if you want it hidden.`;
}

/**
 * The read-only import of V1 reader state (AppServices.migration / reimportV1()) in one sentence,
 * followed by what it left out when it ran.
 */
export function v1ImportLine(report: MigrationReport): string {
  const parts = v1ImportedParts(report.imported);
  const what = parts.length ? `: ${parts.join(", ")}` : "";
  const skipped = v1SkippedLine(report.imported);
  const tail = skipped ? ` ${skipped}` : "";
  switch (report.status) {
    case "migrated":
      return `Reader state from the previous version (V1) was imported${what || " (nothing new was found)"}.${tail}`;
    case "already": {
      // Date.parse("1") is a valid date in V8; only a real ISO stamp is shown as one.
      const when = report.at && /^\d{4}-\d{2}-\d{2}T/.test(report.at) && parseMs(report.at) !== null ? ` on ${report.at.slice(0, 10)}` : "";
      return `Reader state from the previous version (V1) was imported${when}${what}.${tail}`;
    }
    case "nothing":
      return "No reader state from the previous version (V1) was found in this browser, so there was nothing to import.";
    default:
      return "Reader state from the previous version (V1) was found, but this browser refused to store the copy. The import is tried again the next time the page loads.";
  }
}
