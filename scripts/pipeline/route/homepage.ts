// Homepage de-duplication. A story placed in two sections gets its homepage slot in its PRIMARY
// section; in the other one it is ranked just below the homepage cut when that section has enough
// other rows (it stays in the full "view all" list). Membership never changes - only the order.
//
// V1 repeated a URL in 24% of homepage slots (routing review, cross-section-duplication).
//
// The same pass applies the same-SUBJECT cap (ROUTE_POLICY.subjectCap): on the day of a very big
// story its angle pieces ("Anthropic's founders cashed out ...", "What Anthropic's IPO means for
// ...") are separate stories and would fill a section's homepage rows; all but a few are ranked just
// below the cut, exactly like repeats and over-cap publishers, and come back if the section is thin.
//
// And the regulator floor (ROUTE_POLICY.regulatorFloor): in POLICY a fresh first-party notice of a
// listed regulator is guaranteed a homepage row, and no regulator's feed holds more than two.
//
// Two more homepage-only rules: a story HOMED in a cross-list-only section (AI SECURITY) is never a
// homepage row elsewhere (crossListOnlyHomes), and LOCAL & OPEN MODELS keeps up to two routed-in
// release lines on its homepage although the release radar shows them too (releaseRows).
//
// And one guarantee: a story LED by an item of an unvetted outlet (item tag UNVETTED_OUTLET_TAG,
// written by normalize for a link-host item whose outlet no registry publisher vouches for) never
// takes a homepage row while any other row could. Normalize makes such items non-lead-eligible, so
// "the lead is unvetted" means "no known outlet covers this story".
//
// The same last-resort treatment applies to LOW-SIGNAL rows (isLowSignal): a story the score stage
// weighs 0 (a tier-4 lead nobody else covers) or one led by a forum thread. Such a row is on the
// page on recency alone - tier 4 is worth 0 points - and it took homepage rows from on-beat reports:
// a February 2025 model in a ticker feed was MODELS #6, a one-hour-old forum question LOCAL #10.
// TOPIC sections only: a source-mode desk (SAFETY with LessWrong, QUANTUM WATCH with its trade
// press) IS its sources, and deferring them there put 88 h-old rows above 11 h-old ones (measured).
// Release lines are exempt (releaseRows decides those).
//
// And a routed-in release line is not shown next to the news of its own release: when a news row
// of the section's upper ranks names the project ("AMD and Unsloth Bring NPU Support ..." above
// "unsloth v0.1.920-beta: AMD NPU + ..."), the release line waits below the homepage cut.

import type { ArticleId } from "../../../shared/contract";
import { findSection, type SectionDef, type SectionId } from "../../../shared/sections";
import { UNVETTED_OUTLET_TAG } from "../../registry/outlets";
import { tokenSet, tokenize } from "../../../shared/text";
import { HOUR_MS, ageHours, parseMs, type Clock } from "../../../shared/time";
import type { NormalizedItem, ScoredStory } from "../types";
import { DiversityCounter } from "./diversity";
import { ROUTE_POLICY } from "./rules";
import { diversityKeys, holdBack } from "./section";

/** What a big story is about: the title tokens (nearly) all of its members' headlines carry. */
export interface Subject {
  /** Lead id of the story that defines the subject. */
  story: ArticleId;
  /** Lower-case title tokens; a headline is about the subject when it carries ALL of them. */
  tokens: readonly string[];
}

/** May this story be deferred for the sake of a subject cap? A big story never is. */
const isBigStory = (story: ScoredStory): boolean => story.publishers.length >= ROUTE_POLICY.subjectCap.minPublishers;

/**
 * The subjects of the stories with at least `subjectCap.minPublishers` coverage publishers. A
 * subject needs a NAME: a story whose members only share a number ("4") defines none. ("ai" and
 * the other stopwords are never tokens.)
 */
export function subjectsOf(stories: Iterable<ScoredStory>): Subject[] {
  const { titleShare, minTokenLength } = ROUTE_POLICY.subjectCap;
  const out: Subject[] = [];
  for (const story of stories) {
    if (!isBigStory(story)) continue;
    const counts = new Map<string, number>();
    for (const item of story.items) for (const t of tokenSet(item.title)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const need = Math.ceil(titleShare * story.items.length);
    const tokens = [...counts].filter(([, n]) => n >= need).map(([t]) => t).sort();
    if (tokens.some((t) => t.length >= minTokenLength && !/\d/.test(t))) out.push({ story: story.lead, tokens });
  }
  return out;
}

const isRelease = (s: ScoredStory): boolean => s.items[0].kind === "github-release" || s.items[0].flags.includes("release");

/** No known outlet covers this story: its lead is an item of an outlet the registry does not vouch for. */
export const isUnvettedLed = (s: ScoredStory): boolean => s.items[0].tags.includes(UNVETTED_OUTLET_TAG);

/**
 * A row that is on the page on recency alone: weight 0 (a tier-4 lead with no second publisher) or
 * led by a forum thread. Never a release line - a repository's release is tier-capped by design.
 */
export function isLowSignal(s: ScoredStory): boolean {
  if (isRelease(s)) return false;
  const lead = s.items[0];
  return s.w === 0 || lead.kind === "community" || lead.flags.includes("discussion");
}

/** How far apart a release line and the news of it may be to count as one announcement. */
const SAME_ANNOUNCEMENT_HOURS = 24;

/** The project a release line belongs to: the first word of its title ("unsloth v0.1.920-beta: ..." -> "unsloth"), or null. */
export function releaseProject(s: ScoredStory): string | null {
  const first = tokenize(s.items[0].title)[0];
  return first !== undefined && first.length >= 4 && !/^v?\d/.test(first) ? first : null;
}

/** The lead comes from a regulator's own feed (registry tags "regulator" + "first-party"). */
export function isRegulatorNotice(lead: { tags: NormalizedItem["tags"] }): boolean {
  return lead.tags.includes("regulator") && lead.tags.includes("first-party");
}

// normalize places a date-only stamp at 12:00:00.000 UTC of its calendar day.
const DATE_ONLY_RE = /T12:00:00(?:\.000)?Z$/;

/** Is the story inside the floor window? A date-only stamp gets `dateOnlyGraceHours` more. */
export function inFloorWindow(story: ScoredStory, now: Clock): boolean {
  const { hours, dateOnlyGraceHours } = ROUTE_POLICY.regulatorFloor;
  const published = story.items[0].publishedAt;
  const grace = published !== null && DATE_ONLY_RE.test(published) ? dateOnlyGraceHours : 0;
  return ageHours(story.effectiveAt, now) <= hours + grace;
}

/**
 * The rows of a section that are guaranteed a homepage slot: fresh notices of the listed
 * regulators, in rank order, one per regulator before anyone's second, at most `perRegulator` each
 * and `maxRows` (never more than the homepage holds) in all. Empty for every other section.
 */
export function regulatorFloorRows(def: SectionDef, rows: readonly ScoredStory[], now: Clock): ScoredStory[] {
  const policy = ROUTE_POLICY.regulatorFloor;
  if (def.id !== policy.section) return [];
  const byRegulator = new Map<string, ScoredStory[]>();
  for (const row of rows) {
    const lead = row.items[0];
    if (!isRegulatorNotice(lead) || !policy.publishers.includes(lead.publisher) || !inFloorWindow(row, now)) continue;
    const list = byRegulator.get(lead.publisher) ?? [];
    if (list.length < policy.perRegulator) list.push(row);
    byRegulator.set(lead.publisher, list);
  }
  const rank = new Map(rows.map((r, i) => [r, i]));
  const byRank = (a: ScoredStory, b: ScoredStory): number => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const out: ScoredStory[] = [];
  const max = Math.min(policy.maxRows, def.homeRows);
  for (let round = 0; round < policy.perRegulator && out.length < max; round++) {
    const picks = [...byRegulator.values()].flatMap((list) => (list[round] ? [list[round]] : [])).sort(byRank);
    out.push(...picks.slice(0, max - out.length));
  }
  return out;
}

export interface SectionRows {
  def: SectionDef;
  /** Ranked rows (output of buildSection). */
  rows: readonly ScoredStory[];
}

interface Pick {
  /** The homepage rows. */
  home: ScoredStory[];
  /** Everything else, rank order. */
  rest: ScoredStory[];
}

function pickHome(sec: SectionRows, primaryOf: (lead: ArticleId) => SectionId, shownAtPrimary: ReadonlySet<ArticleId>, subjects: readonly Subject[], now?: Clock): Pick {
  const { def, rows } = sec;
  const counter = new DiversityCounter<ScoredStory>(def.maxPublisherShare, def.homeRows, diversityKeys);
  const home: ScoredStory[] = [];
  const capped: ScoredStory[] = [];
  const repeats: ScoredStory[] = [];
  const unvetted: ScoredStory[] = [];
  const lowSignal: ScoredStory[] = [];
  // Regulator floor (the floor section only, and only when the caller passes the clock).
  const floorSection = now !== undefined && def.id === ROUTE_POLICY.regulatorFloor.section;
  const floor = new Set<ScoredStory>(floorSection ? regulatorFloorRows(def, rows, now) : []);
  let floorPending = floor.size;
  const perRegulator = new Map<string, number>();
  const regulatorOf = (row: ScoredStory): string | null => (floorSection && isRegulatorNotice(row.items[0]) ? row.items[0].publisher : null);
  // Homepage rows taken per subject (index into `subjects`).
  const taken = new Map<number, number>();
  const subjectsOfRow = (row: ScoredStory): number[] => {
    if (subjects.length === 0) return [];
    const title = tokenSet(row.items[0].title);
    const out: number[] = [];
    subjects.forEach((s, i) => {
      if (s.story === row.lead || s.tokens.every((t) => title.has(t))) out.push(i);
    });
    return out;
  };
  const take = (row: ScoredStory, about: readonly number[]): void => {
    home.push(row);
    counter.add(row);
    for (const i of about) taken.set(i, (taken.get(i) ?? 0) + 1);
    const regulator = regulatorOf(row);
    if (regulator !== null) perRegulator.set(regulator, (perRegulator.get(regulator) ?? 0) + 1);
  };
  // In a releaseRows section a routed-in release line may take one of a few homepage rows even
  // though the release radar shows it too - and no more than those few, shown there or not.
  const releaseSection = ROUTE_POLICY.releaseRows.sections.includes(def.id);
  let releaseRows = 0;
  const guestRelease = (row: ScoredStory): boolean => releaseSection && isRelease(row) && row.items[0].home !== def.id;
  const onReleaseRadar = (row: ScoredStory): boolean => findSection(primaryOf(row.lead))?.desk === "utility";
  // News rows in the section's upper ranks (twice the homepage) that could carry a release's news.
  const news = rows.slice(0, def.homeRows * 2).filter((r) => !isRelease(r));
  const announced = (row: ScoredStory): boolean => {
    const project = releaseProject(row);
    const at = parseMs(row.effectiveAt);
    if (project === null || at === null) return false;
    return news.some((n) => {
      const other = parseMs(n.effectiveAt);
      return other !== null && Math.abs(other - at) <= SAME_ANNOUNCEMENT_HOURS * HOUR_MS && tokenSet(n.items[0].title).has(project);
    });
  };
  // A story homed in a cross-list-only section (AI SECURITY) is never a homepage row elsewhere.
  const crossListed = (row: ScoredStory): boolean => row.items[0].home !== def.id && ROUTE_POLICY.crossListOnlyHomes.includes(row.items[0].home);
  for (const row of rows) {
    if (home.length >= def.homeRows) break;
    const about = subjectsOfRow(row);
    if (floor.has(row)) {
      // Guaranteed: the floor picked at most `perRegulator` per regulator, and slots were kept free.
      floorPending--;
      take(row, about);
      continue;
    }
    // Rows still owed to the floor further down the ranking are not given away.
    if (home.length + floorPending >= def.homeRows) continue;
    const regulator = regulatorOf(row);
    const release = guestRelease(row);
    const repeat = primaryOf(row.lead) !== def.id && shownAtPrimary.has(row.lead);
    if (isUnvettedLed(row)) unvetted.push(row);
    else if (def.mode === "topic" && isLowSignal(row)) lowSignal.push(row);
    else if (crossListed(row) || (repeat && !(release && onReleaseRadar(row))) || (release && announced(row))) repeats.push(row);
    else if (release && releaseRows >= ROUTE_POLICY.releaseRows.maxRows) capped.push(row);
    else if (!counter.fits(row, def.homeRows)) capped.push(row);
    else if (regulator !== null && (perRegulator.get(regulator) ?? 0) + floorOwed(floor, home, regulator) >= ROUTE_POLICY.regulatorFloor.perRegulator) capped.push(row);
    else if (!isBigStory(row) && about.some((i) => (taken.get(i) ?? 0) >= ROUTE_POLICY.subjectCap.maxHomeRows)) capped.push(row);
    else {
      if (release) releaseRows++;
      take(row, about);
    }
  }
  // Never leave homepage rows empty for the sake of de-duplication: over-cap rows (publisher,
  // regulator or subject) first, then repeats, then low-signal rows; a story no known outlet covers
  // is the last resort.
  const spare = [...capped, ...repeats, ...lowSignal, ...unvetted];
  const fill = spare.splice(0, Math.max(0, def.homeRows - home.length));
  // Rank order is kept on both sides of the homepage cut.
  const above = new Set<ScoredStory>([...home, ...fill]);
  return { home: rows.filter((r) => above.has(r)), rest: rows.filter((r) => !above.has(r)) };
}

/** Floor rows of `regulator` that are not on the homepage yet (their slots count against its cap). */
function floorOwed(floor: ReadonlySet<ScoredStory>, home: readonly ScoredStory[], regulator: string): number {
  let n = 0;
  for (const row of floor) if (row.items[0].publisher === regulator && !home.includes(row)) n++;
  return n;
}

/**
 * Reorder each section's rows so the first homeRows avoid stories already shown on the homepage of
 * their primary section, hold at most `subjectCap.maxHomeRows` rows about one big story's subject
 * and - when `now` is given - honour the regulator floor. Returns rows per section, same order as
 * `sections`.
 */
export function dedupeHomepage(sections: readonly SectionRows[], primaryOf: (lead: ArticleId) => SectionId, subjects: readonly Subject[] = [], now?: Clock): ScoredStory[][] {
  // Fixpoint: "shown at primary" only ever grows (hiding a repeat pulls more native rows up), so it
  // converges; the bound is a safety net.
  let shown = new Set<ArticleId>();
  let picks: Pick[] = [];
  const bound = sections.reduce((n, s) => n + s.rows.length, 0) + 1;
  for (let i = 0; i <= bound; i++) {
    picks = sections.map((s) => pickHome(s, primaryOf, shown, subjects, now));
    const next = new Set(shown);
    sections.forEach((s, idx) => {
      for (const row of picks[idx].home) if (primaryOf(row.lead) === s.def.id) next.add(row.lead);
    });
    if (next.size === shown.size) break;
    shown = next;
  }
  // Deferring rows can pull a routed-in release line up into the first rows; section.ts held it
  // below them, and the same rule holds here (it stays on the homepage, just not at its head).
  return picks.map((p, i) => holdBack([...p.home, ...p.rest], (row) => isRelease(row) && row.items[0].home !== sections[i].def.id, ROUTE_POLICY.releaseHoldBackRows));
}
