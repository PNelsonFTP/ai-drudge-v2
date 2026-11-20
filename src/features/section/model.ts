// Section page model (#/s/<id>): the full ranked list of one section, the river tail beyond it, the
// publisher mix line and the previous / next links. Pure.

import type { ArticleId, RiverFile } from "../../../shared/contract";
import { findSection, type SectionDef, type SectionId } from "../../../shared/sections";
import { collapseStories, publisherName, riverSection, sectionOf, sectionRows, storyPassesTimeFilter, type Edition, type MuteSet } from "../../../shared/select";
import { TIME_FILTERS, passesTimeFilter, type TimeFilter } from "../../../shared/time";
import type { Route } from "../../app/services";
import { readerSectionOrder, riverRef, type RowRef } from "../export/kit/rows";

export interface PublisherShare {
  name: string;
  count: number;
}

export interface PublisherMix {
  /** Largest first (ties by name), at most `limit` entries. */
  top: PublisherShare[];
  /** Distinct publishers across all rows. */
  publishers: number;
  stories: number;
}

/** Who the section's stories come from (by lead article outlet). */
export function publisherMix(e: Edition, ids: readonly ArticleId[], limit = 6): PublisherMix {
  const counts = new Map<string, PublisherShare>();
  let stories = 0;
  for (const id of ids) {
    const a = e.articles[id];
    if (!a) continue;
    stories++;
    const name = publisherName(e, a);
    const key = name.toLowerCase();
    const hit = counts.get(key);
    if (hit) hit.count++;
    else counts.set(key, { name, count: 1 });
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { top: all.slice(0, Math.max(0, limit)), publishers: all.length, stories };
}

/** "TechCrunch 4 · Reuters 3 · … — 14 publishers across 25 stories"; "" for an empty section. */
export function mixLine(mix: PublisherMix): string {
  if (mix.stories === 0) return "";
  const parts = mix.top.map((p) => `${p.name} ${p.count}`);
  const more = mix.publishers - mix.top.length;
  if (more > 0) parts.push(`${more} more`);
  return `${parts.join(" · ")} — ${mix.publishers} ${mix.publishers === 1 ? "publisher" : "publishers"} across ${mix.stories} ${mix.stories === 1 ? "story" : "stories"}`;
}

export interface SectionNeighbors {
  prev: SectionDef | null;
  next: SectionDef | null;
}

/**
 * Previous / next section in the reader's order. Sections hidden from the home page are skipped,
 * except the current one (a hidden section is still reachable by link). No wrap-around.
 */
export function sectionNeighbors(id: SectionId, storedOrder: readonly string[] | null, hidden: readonly string[] = []): SectionNeighbors {
  const order = readerSectionOrder(storedOrder).filter((s) => s === id || !hidden.includes(s));
  const i = order.indexOf(id);
  const at = (j: number): SectionDef | null => (j >= 0 && j < order.length ? (findSection(order[j]) ?? null) : null);
  return i < 0 ? { prev: null, next: null } : { prev: at(i - 1), next: at(i + 1) };
}

export interface SectionViewInput {
  edition: Edition;
  /** null until river.json is loaded. */
  river: RiverFile | null;
  id: SectionId;
  mutes: MuteSet;
  filter: TimeFilter;
  nowMs: number;
  previousVisitMs: number | null;
}

export interface SectionView {
  id: SectionId;
  label: string;
  /** Ranked story lead ids that pass the time filter (by the story's newest visible article) and the source mutes. */
  rows: ArticleId[];
  /** Ranked rows before the time filter. */
  ranked: number;
  /** Ranked rows inside each time window (the numbers on the time chips). */
  windows: Record<TimeFilter, number>;
  /** River items of the section that are not in the ranked list ("older from the last 7 days"), newest first. */
  tail: RowRef[];
  /** False while rest.json is not merged: `rows` are the homepage rows only and there is no tail yet. */
  complete: boolean;
  /** The reader muted this section (it is still shown here, with a notice). */
  muted: boolean;
  mix: PublisherMix;
}

export function buildSectionView(input: SectionViewInput): SectionView {
  const { edition: e, river, id, mutes, filter, nowMs, previousVisitMs } = input;
  // The reader navigated here on purpose: a section mute hides the section elsewhere, not on its own page.
  const sourceMutes: MuteSet = { sources: mutes.sources, sections: new Set<SectionId>() };
  const ranked = sectionRows(e, id, { all: true, mutes: sourceMutes });
  const passes = (a: { publishedAt: string | null; firstSeenAt: string }): boolean => passesTimeFilter(a, filter, nowMs, previousVisitMs);
  // A ranked row is a STORY: it is as new as its newest visible article (a lead from yesterday that
  // outlets are still joining stays under 24H). The river tail below is single items.
  const inWindow = (f: TimeFilter): ArticleId[] => ranked.filter((rid) => storyPassesTimeFilter(e, rid, f, nowMs, previousVisitMs, sourceMutes));
  const rows = inWindow(filter);
  const windows = Object.fromEntries(TIME_FILTERS.map((f) => [f, f === filter ? rows.length : inWindow(f).length])) as Record<TimeFilter, number>;

  let tail: RowRef[] = [];
  if (river && e.complete) {
    // Everything the ranked list already shows: every row (muted or filtered ones too) and the
    // other articles of those stories.
    const shown = new Set<ArticleId>();
    for (const rid of sectionOf(e, id)?.rows ?? []) {
      shown.add(rid);
      for (const m of e.clusters[rid]?.members ?? []) shown.add(m);
    }
    const extra = riverSection(river, id, sourceMutes, shown).filter((r) => !(r.leadId !== null && shown.has(r.leadId)));
    tail = collapseStories(extra)
      .map(riverRef)
      .filter((r) => passes({ publishedAt: r.item?.publishedAt ?? null, firstSeenAt: r.item?.firstSeenAt ?? "" }));
  }

  return {
    id,
    label: findSection(id)?.label ?? id,
    rows,
    ranked: ranked.length,
    windows,
    tail,
    complete: e.complete,
    muted: mutes.sections.has(id),
    mix: publisherMix(e, ranked),
  };
}

export function sectionTitle(route: Route): string {
  return route.name === "section" ? (findSection(route.id)?.label ?? "Section") : "Section";
}
