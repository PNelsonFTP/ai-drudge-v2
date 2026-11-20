// river.json: every item that passed relevance in the last 7 days, newest first, as compact tuples.
//
// Feeds only list their newest N items, so one run never holds a week of news. The river is this
// run's kept items PLUS the previous builds' memory (ctx.state.recent); nextState folds the emitted
// rows back into state.recent, which is how the memory rolls forward. A remembered row leaves when
// it ages out, when its source leaves the registry, or when this run saw the item again and rejected
// it on content (rejectedThisRun).

import { RIVER_DAYS, type ArticleId, type RiverFile, type RiverRow, type SourceId } from "../../../shared/contract";
import { isSectionId, type SectionId } from "../../../shared/sections";
import { DAY_MS, parseMs } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import type { DropReason, DroppedItem, Placements, Registry, StageContext } from "../types";
import { clipTitle, editionMeta, isEmittable } from "./common";

/** Hard cap on river rows (newest kept). A week is ~1,000-4,000 rows; beyond this something is wrong upstream. */
export const RIVER_MAX_ROWS = 6000;

type Pending = [id: ArticleId, title: string, url: string, source: SourceId, section: SectionId, publishedAtMs: number | null, firstSeenAtMs: number, leadId: ArticleId | null];

const newestFirst = (a: Pending, b: Pending): number => (b[5] ?? b[6]) - (a[5] ?? a[6]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Drop reasons that say "this is not something to show": the item's own content failed the rules as
 * they stand today. (too_old / source_cap / duplicate / release_collapsed are not: such an item was
 * fine when an earlier build listed it.)
 */
const REJECTED_REASONS: ReadonlySet<DropReason> = new Set<DropReason>(["invalid", "excluded", "noise", "off_topic"]);

const rejectKey = (sourceId: SourceId, id: ArticleId): string => `${sourceId}\u0000${id}`;

/** The items this run saw and rejected on content, as buildRiver wants them. */
export function rejectedThisRun(dropped: readonly DroppedItem[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const d of dropped ?? []) if (d.id !== null && REJECTED_REASONS.has(d.reason)) out.add(rejectKey(d.sourceId, d.id));
  return out;
}

/**
 * `rejected` (rejectedThisRun): items this run fetched again and rejected on content. Their rows
 * leave the memory, so a source rule tightened today removes yesterday's junk from search and the
 * river at once instead of leaving it for 7 days (22 such rows on 2026-11-20, among them a
 * subscribe-coupon page and "PostgreSQL 19 Released").
 */
export function buildRiver(placements: Placements, registry: Registry, ctx: Pick<StageContext, "now" | "buildId" | "state">, rejected: ReadonlySet<string> = new Set()): RiverFile {
  const nowMs = ctx.now.getTime();
  const oldest = nowMs - RIVER_DAYS * DAY_MS;
  const names = new Map(registry.sources.map((s) => [s.id, s.name]));
  const known: ReadonlySet<SourceId> = new Set(names.keys());

  const sourceIds: SourceId[] = [];
  const sourceIndex = new Map<SourceId, number>();
  const idx = (id: SourceId): number => {
    let i = sourceIndex.get(id);
    if (i === undefined) {
      i = sourceIds.length;
      sourceIds.push(id);
      sourceIndex.set(id, i);
    }
    return i;
  };

  const current = new Map<ArticleId, Pending>();
  const add = (into: Map<ArticleId, Pending>, row: Pending): void => {
    if (current.has(row[0]) || into.has(row[0])) return;
    if ((row[5] ?? row[6]) < oldest) return;
    into.set(row[0], row);
  };

  // Leads first, so an id that is both a lead and (by an upstream bug) a member is recorded as a lead.
  const stories = Object.values(placements.stories);
  for (const pass of ["lead", "member"] as const) {
    for (const story of stories) {
      const lead = story.items[0];
      if (!lead) continue;
      const leadOk = isEmittable(lead, known);
      const primary = placements.primary[story.lead];
      const items = pass === "lead" ? [lead] : story.items.slice(1);
      for (const item of items) {
        if (!isEmittable(item, known)) continue;
        const firstSeen = parseMs(item.firstSeenAt) ?? nowMs;
        const isLead = item.id === story.lead;
        add(current, [item.id, clipTitle(item.title), item.url, item.sourceId, isSectionId(primary) ? primary : item.home, parseMs(item.publishedAt), firstSeen, isLead || !leadOk ? null : story.lead]);
      }
    }
  }

  // An item whose wrapper link was resolved since an earlier build has a new id: its old row must
  // not stay in the river next to the new one, and rows that pointed at it follow it.
  const renamed = new Map<ArticleId, ArticleId>();
  for (const story of stories) for (const item of story.items) for (const former of item.formerIds ?? []) if (current.has(item.id)) renamed.set(former, item.id);

  // Memory of earlier builds: items no feed lists any more. Sources removed from the registry are dropped.
  const memory = new Map<ArticleId, Pending>();
  for (const r of ctx.state.recent) {
    if (!known.has(r.sourceId) || !isHttpUrl(r.url) || !isSectionId(r.section) || renamed.has(r.id)) continue;
    if (rejected.has(rejectKey(r.sourceId, r.id))) continue;
    const leadId = r.leadId === null ? null : (renamed.get(r.leadId) ?? r.leadId);
    add(memory, [r.id, r.title, r.url, r.sourceId, r.section, r.publishedAtMs, r.firstSeenAtMs, leadId === r.id ? null : leadId]);
  }
  // The cap only ever trims memory: every item of this run stays (the edition's articles must be in the river).
  const room = Math.max(0, RIVER_MAX_ROWS - current.size);
  const kept = [...memory.values()].sort(newestFirst).slice(0, room);
  const ordered = [...current.values(), ...kept].sort(newestFirst);
  const rows: RiverRow[] = ordered.map((r) => [r[0], r[1], r[2], idx(r[3]), r[4], r[5], r[6], r[7]]);
  return {
    ...editionMeta(ctx),
    days: RIVER_DAYS,
    sources: sourceIds.map((id) => names.get(id) ?? id),
    sourceIds,
    rows,
  };
}
