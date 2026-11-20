// "New since your last visit" page model (#/new): every story first seen since the previous visit,
// taken from the 7-day river so stories that already rotated off the home page are included.
// Grouped by section. Pure.

import type { ArticleId, RiverFile } from "../../../shared/contract";
import { collapseStories, riverSince, visibleLeads, type Edition, type MuteSet } from "../../../shared/select";
import { DAY_MS } from "../../../shared/time";
import { groupBySection, storyRef, type RowRef, type SectionGroup } from "../export/kit/rows";

/** On a first visit there is no "previous visit": show the last 24 hours instead. */
export const FIRST_VISIT_WINDOW_MS = DAY_MS;

export interface NewViewInput {
  river: RiverFile;
  /** For story leads and "is it still on the home page"; null while the edition is loading. */
  edition: Edition | null;
  /** lastVisit.previousMs ("mark all seen" moves it forward). */
  previousMs: number | null;
  nowMs: number;
  mutes: MuteSet;
}

export interface NewView {
  /** Stories first seen after this instant are listed. */
  sinceMs: number;
  firstVisit: boolean;
  groups: SectionGroup<RowRef>[];
  /** Distinct stories. */
  total: number;
  /** Of `total`: stories that are no longer among the home page rows. */
  offHome: number;
  /** Article ids of the listed river items (for "mark all seen"). */
  ids: ArticleId[];
}

/** The instant the page counts from: the previous visit, or the last 24 hours on a first visit. */
export function sinceMs(previousMs: number | null, nowMs: number): number {
  return previousMs ?? nowMs - FIRST_VISIT_WINDOW_MS;
}

export function buildNewView(input: NewViewInput): NewView {
  const { river, edition, previousMs, nowMs, mutes } = input;
  const since = sinceMs(previousMs, nowMs);
  const stories = collapseStories(riverSince(river, since, mutes));

  const onHome = new Set<ArticleId>();
  if (edition) {
    for (const id of edition.top) onHome.add(id);
    for (const id of visibleLeads(edition, mutes, { all: false })) onHome.add(id);
  }
  let offHome = 0;
  for (const r of stories) if (edition && !onHome.has(r.leadId ?? r.id)) offHome++;

  // Two river items can resolve to the same lead row once the edition is consulted; keep the first.
  const used = new Set<ArticleId>();
  const rows: { section: (typeof stories)[number]["section"]; ref: RowRef }[] = [];
  for (const r of stories) {
    const ref = storyRef(edition, r);
    if (used.has(ref.id)) continue;
    used.add(ref.id);
    rows.push({ section: r.section, ref });
  }
  const groups = groupBySection(rows, (x) => x.section).map((g) => ({ section: g.section, label: g.label, items: g.items.map((x) => x.ref) }));

  return {
    sinceMs: since,
    firstVisit: previousMs === null,
    groups,
    total: rows.length,
    offHome: Math.min(offHome, rows.length),
    ids: stories.map((r) => r.id),
  };
}
