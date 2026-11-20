// Section age windows on effectiveAt (publishedAt ?? firstSeenAt). The numbers live in
// shared/sections.ts (SectionDef.window); this file only applies them.
//
//   age <= softDays              "soft"     - fills the section first
//   softDays < age <= hardDays   "backfill" - only used by the starvation fill, up to minItems
//   age > hardDays / no date     "expired"  - never shown

import type { SectionWindow } from "../../../shared/sections";
import { ageDays, type Clock } from "../../../shared/time";

export type WindowBand = "soft" | "backfill" | "expired";

/** `extendHardDays` lets one item outlive the section's hard window (never shortens it). */
export function windowBand(effectiveAt: string | null | undefined, window: SectionWindow, now: Clock, extendHardDays?: number): WindowBand {
  const days = ageDays(effectiveAt, now);
  if (days <= window.softDays) return "soft";
  if (days <= Math.max(window.hardDays, extendHardDays ?? 0)) return "backfill";
  return "expired";
}

export interface WindowSplit<T> {
  soft: T[];
  backfill: T[];
  expired: T[];
}

/** Partition by band, preserving input order inside each band. */
export function splitByWindow<T extends { effectiveAt: string }>(
  items: readonly T[],
  window: SectionWindow,
  now: Clock,
  extendHardDaysOf?: (item: T) => number | undefined,
): WindowSplit<T> {
  const out: WindowSplit<T> = { soft: [], backfill: [], expired: [] };
  for (const item of items) out[windowBand(item.effectiveAt, window, now, extendHardDaysOf?.(item))].push(item);
  return out;
}
