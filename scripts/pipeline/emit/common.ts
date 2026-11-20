// Small helpers shared by the emit modules (edition, river, atom, status). Pure.

import { SCHEMA_VERSION, type EditionMeta, type SourceId } from "../../../shared/contract";
import { isHttpUrl } from "../../../shared/url";
import { PIPELINE } from "../context";
import type { NormalizedItem, StageContext } from "../types";

/** schemaVersion / buildId / generatedAt of this build - identical in every emitted file. */
export function editionMeta(ctx: Pick<StageContext, "now" | "buildId">): EditionMeta {
  return { schemaVersion: SCHEMA_VERSION, buildId: ctx.buildId, generatedAt: ctx.now.toISOString() };
}

/**
 * Cut `text` to at most `max` UTF-16 units without splitting a surrogate pair, ending in "…".
 * Normalize already caps titles and summaries; this is the emit-side backstop so one oversized
 * string from a future stage bug can never inflate the payload.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function clipTitle(title: string): string {
  return clip(title, PIPELINE.titleMaxChars);
}

/**
 * Can this item be published? Its URL must be http(s) and its source must be in the registry
 * (otherwise sources.json could not resolve `src`). Anything else is dropped from the edition AND
 * the river, so the two files can never disagree.
 */
export function isEmittable(item: NormalizedItem, knownSources: ReadonlySet<SourceId>): boolean {
  return item.title.trim().length > 0 && isHttpUrl(item.url) && knownSources.has(item.sourceId);
}

export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
