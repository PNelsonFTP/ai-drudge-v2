// Duplicate handling and item times.
//
//   dedupeWithinSource  one source listing the same article twice (same URL, or the same title
//                       within a few days) -> the repeat is dropped as "duplicate"
//   foldTwins           several sources carrying the SAME URL (OpenAI News + OpenAI Blog, a publisher
//                       feed + an aggregator) -> ONE item, the others recorded in via[]
//   resolveTimes        firstSeenAt from the ledger (ctx.state.firstSeen) else the build clock;
//                       effectiveAt = publishedAt ?? firstSeenAt
//
// V1 kept same-URL twins as separate articles, so one OpenAI post counted as "2 sources" and half
// of Trending was a single publisher talking to itself.

import type { ArticleId } from "../../../shared/contract";
import { DAY_MS } from "../../../shared/time";
import type { ResolvedSource } from "../../registry/types";
import type { PipelineState, RawItem } from "../types";
import { resolvePublishedAt, type ParsedDate } from "./dates";
import type { ItemIdentity } from "./url";

/** A raw item after cleaning, before duplicates are resolved. */
export interface Draft {
  raw: RawItem;
  source: ResolvedSource;
  /** Position of the source in the registry (stable tie-break between twins). */
  sourceOrder: number;
  identity: ItemIdentity;
  /** Cleaned title. */
  title: string;
  date: ParsedDate | null;
  /** Position in the raw input. */
  order: number;
  synthesizedTitle?: boolean;
  /** Outlet credited in an aggregator title's "(Author/Outlet)" tail (Techmeme); the tail is removed from `title`. */
  titleOutlet?: string;
  /** Outlet named by the " - Outlet" tail of an unresolved Google News title whose entry has no <source>; the tail is removed from `title`. */
  outletName?: string;
}

export interface DuplicateDrop {
  draft: Draft;
  detail: string;
}

/** Identical titles from one source this close together are one post listed twice; further apart they are a recurring column. */
export const TITLE_DUPLICATE_WINDOW_DAYS = 6;

const titleKey = (title: string): string => title.toLowerCase().replace(/\s+/g, " ").trim();

function closeInTime(a: ParsedDate | null, b: ParsedDate | null): boolean {
  // Without a date on either side there is nothing to tell the two apart.
  if (!a || !b) return true;
  return Math.abs(a.ms - b.ms) <= TITLE_DUPLICATE_WINDOW_DAYS * DAY_MS;
}

/**
 * Drop repeats inside one source; the first occurrence wins. A repeat is the same canonical URL
 * (http/https and "www." ignored) or the same title within TITLE_DUPLICATE_WINDOW_DAYS.
 * URLs that differ in an identity-bearing query parameter (?p=1 vs ?p=2) are different articles.
 */
export function dedupeWithinSource(drafts: readonly Draft[]): { kept: Draft[]; dropped: DuplicateDrop[] } {
  const kept: Draft[] = [];
  const dropped: DuplicateDrop[] = [];
  const byUrl = new Set<string>();
  const byTitle = new Map<string, Draft[]>();
  for (const d of drafts) {
    const urlKey = `${d.source.id}\u0000${d.identity.key}`;
    if (byUrl.has(urlKey)) {
      dropped.push({ draft: d, detail: "same URL listed twice by the source" });
      continue;
    }
    const tKey = `${d.source.id}\u0000${titleKey(d.title)}`;
    const sameTitle = byTitle.get(tKey) ?? [];
    if (sameTitle.some((other) => closeInTime(other.date, d.date))) {
      dropped.push({ draft: d, detail: "same title listed twice by the source" });
      continue;
    }
    byUrl.add(urlKey);
    byTitle.set(tKey, [...sameTitle, d]);
    kept.push(d);
  }
  return { kept, dropped };
}

export interface TwinGroup {
  /** The draft that becomes the item. */
  primary: Draft;
  /** The other sources' copies, best first. Never from the primary's source. */
  twins: Draft[];
}

// A pointer-only copy: an aggregator / query feed that merely links to the article and is barred from
// leading a story and from counting as coverage (Techmeme). If it became the primary, the article
// would inherit both bars, so it never outranks a copy that is not one - whatever the tiers.
const pointerOnly = (d: Draft): boolean => d.source.attribution !== "source" && !d.source.leadEligible && !d.source.countsForCoverage;

// Which copy represents the article: never a pointer-only copy while another exists, then the
// highest tier, then a feed that IS the publisher over an aggregator / query feed that merely links
// to it, then registry order.
function twinRank(a: Draft, b: Draft): number {
  return (
    Number(pointerOnly(a)) - Number(pointerOnly(b)) ||
    a.source.tier - b.source.tier ||
    Number(a.source.attribution !== "source") - Number(b.source.attribution !== "source") ||
    a.sourceOrder - b.sourceOrder ||
    a.order - b.order
  );
}

/**
 * Fold drafts that point at the same article into one group per article. Groups come out in the
 * order their first copy appeared in the input. Expects dedupeWithinSource to have run (one draft
 * per source per article).
 */
export function foldTwins(drafts: readonly Draft[]): TwinGroup[] {
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) {
    const group = groups.get(d.identity.key);
    if (group) group.push(d);
    else groups.set(d.identity.key, [d]);
  }
  const out: TwinGroup[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort(twinRank);
    const primary = ranked[0];
    const seen = new Set<string>([primary.source.id]);
    const twins: Draft[] = [];
    for (const d of ranked.slice(1)) {
      if (seen.has(d.source.id)) continue;
      seen.add(d.source.id);
      twins.push(d);
    }
    out.push({ primary, twins });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Times
// ------------------------------------------------------------------------------------------------

/** Earliest ledger entry among the ids (a folded article may be known under a twin's id); null when never seen. */
export function ledgerFirstSeen(ids: readonly ArticleId[], state: Readonly<PipelineState>, nowMs: number): number | null {
  let best: number | null = null;
  for (const id of ids) {
    // Own-property check: ids are base36 strings and "constructor" must not hit Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(state.firstSeen, id)) continue;
    const t = Date.parse(state.firstSeen[id]);
    if (Number.isNaN(t)) continue;
    // A ledger entry from the future (clock skew between runners) cannot be trusted beyond "now".
    const clamped = Math.min(t, nowMs);
    if (best === null || clamped < best) best = clamped;
  }
  return best;
}

/**
 * Is this the first build that READS the source? True on a brand-new state (empty ledger), and for a
 * source the state has never read successfully: one added later, or one whose every fetch so far
 * failed (a feed that was down on the first build must not stamp its whole listing "new" when it
 * recovers). An empty-but-valid feed has been read - whatever it lists next is news.
 */
export function isBaselineRun(sourceId: string, state: Readonly<PipelineState>): boolean {
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (Object.keys(state.firstSeen).length === 0) return true;
  const tracked = Object.keys(state.health).length > 0 || Object.keys(state.lastGood).length > 0;
  if (!tracked) return false;
  const health = has(state.health, sourceId) ? state.health[sourceId] : undefined;
  const read = health !== undefined && (health.lastOkAt !== null || health.lastErrorClass === "empty");
  return !read && !has(state.lastGood, sourceId) && !state.recent.some((r) => r.sourceId === sourceId);
}

export interface ItemTimes {
  publishedAt: string | null;
  firstSeenAt: string;
  effectiveAt: string;
}

export interface TimesInput {
  /** Ids the article may be known under in the ledger (its own first). */
  ids: readonly ArticleId[];
  /** Parsed dates of the copies, primary first. */
  dates: readonly (ParsedDate | null)[];
  sourceId: string;
  /** The source's max age in days (baseline rule below). */
  maxAgeDays: number;
}

/**
 * firstSeenAt / publishedAt / effectiveAt of one article.
 *
 * firstSeenAt is the ledger entry, else the build clock - except on a BASELINE run (the first build
 * that sees the item's source: an empty state, or a source added later). What a listing already
 * holds on that build is not news:
 *   - an item WITH a date is recorded as first seen when it was published, so the first build does
 *     not stamp the whole corpus "new" (NEW badges, "new since your last visit", Atom order);
 *   - an item with NO usable date is recorded as first seen just beyond the source's max age and
 *     ages out immediately (Gray Swan's blog index carries posts from 2025; "first seen now" would
 *     put that back catalogue on top of AI SECURITY as brand new).
 * Items that appear on later builds are new and get the build clock.
 *
 * publishedAt prefers a copy with a real time of day over a date-only stamp.
 */
export function resolveTimes(input: TimesInput, state: Readonly<PipelineState>, now: Date): ItemTimes {
  const nowMs = now.getTime();
  const ledger = ledgerFirstSeen(input.ids, state, nowMs);
  const usable = input.dates.filter((d): d is ParsedDate => d !== null);
  const date = usable.find((d) => !d.dateOnly) ?? usable[0] ?? null;

  let firstSeenMs = ledger ?? nowMs;
  let publishedAt = resolvePublishedAt(date, nowMs, firstSeenMs);
  if (ledger === null && isBaselineRun(input.sourceId, state)) {
    const publishedMs = publishedAt === null ? null : Date.parse(publishedAt);
    // Only for items with NO date at all: a stamp rejected as future-dated is evidence the item is new.
    if (date === null) {
      firstSeenMs = nowMs - (input.maxAgeDays + 1) * DAY_MS;
      publishedAt = null;
    } else if (publishedMs !== null && publishedMs < nowMs) {
      firstSeenMs = publishedMs;
    }
  }
  const firstSeenAt = new Date(firstSeenMs).toISOString();
  return { publishedAt, firstSeenAt, effectiveAt: publishedAt ?? firstSeenAt };
}
