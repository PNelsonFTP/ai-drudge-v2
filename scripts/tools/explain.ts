// "Why is this story where it is?"
//
//   npx tsx scripts/tools/explain.ts <article-id | url | title words> [--file <explain.json>] [--dir <data dir>] [--mute <source-id,...>]
//
// Prints the score parts, placements and route trace of the matching stories from the last run, or
// the reason an item was dropped. The record is written by the pipeline (emit/explain.ts buildExplain
// + emit/write.ts writeExplain) to node_modules/.tmp/explain.json. Without that file the tool falls
// back to the published data (front/rest/river.json): placements and coverage, but no score parts.
//
// It also says, where it applies:
//   - the age fade       tier, importance, coverage and hn are printed AFTER the fade the score applies
//   - regulator notice   the importance part includes SCORE.importance.regulatorNotice because the
//                        lead's source is tagged regulator + first-party (inside the importance cap,
//                        before the fade - which is why it stops helping after about a day)
//   - corroboration      an item was over its source's cap and was kept anyway because another
//                        publisher covers the same story; a "source_cap" drop was NOT kept for the
//                        opposite reason
//   - mutes              what a reader who muted the lead's source (or the sources given with
//                        --mute a,b) sees in the row: the story keeps its place and its key, and is
//                        re-led by the first remaining outlet (shared/select.ts visibleStory - the
//                        same function the client uses, run on the published files of the same build)
//   - river memory       a drop on content also removes the item's row from the 7-day river

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, DATA_FILES, type EditionFront, type EditionRest, type RiverFile } from "../../shared/contract";
import { isEditionFront, isEditionRest, isRiverFile } from "../../shared/guards";
import { isArticleId } from "../../shared/ids";
import { mergeEdition, publisherName, riverRows, sourceName, storyOf, visibleStory, type Edition, type MuteSet } from "../../shared/select";
import { normalizeForSearch, parseQuery } from "../../shared/text";
import { isHttpUrl, sameUrl } from "../../shared/url";
import { EXPLAIN_FILE, type ExplainFile, type ExplainItem, type ExplainStory } from "../pipeline/emit/explain";
import { fade } from "../pipeline/score/index";
import { SCORE } from "../pipeline/score/weights";
import type { DroppedItem } from "../pipeline/types";

export interface ExplainMatch {
  story: ExplainStory;
  /** The member that matched, when the query hit a member rather than the lead. */
  via?: ExplainItem;
}

export interface ExplainHits {
  stories: ExplainMatch[];
  dropped: DroppedItem[];
}

export const MAX_MATCHES = 5;

type Matcher = (item: { id: string | null; url: string; title: string }) => boolean;

/** id -> exact id; URL -> same canonical URL; anything else -> every word appears in the title. */
export function matcherFor(query: string): Matcher {
  const q = query.trim();
  if (isHttpUrl(q)) return (item) => sameUrl(item.url, q);
  const words = parseQuery(q);
  const byTitle: Matcher = (item) => words.length > 0 && words.every((w) => normalizeForSearch(item.title).includes(w));
  if (isArticleId(q)) return (item) => item.id === q || byTitle(item);
  return byTitle;
}

export function findInExplain(explain: ExplainFile, query: string): ExplainHits {
  const match = matcherFor(query);
  const exactId = isArticleId(query.trim()) ? query.trim() : null;
  const stories: ExplainMatch[] = [];
  for (const story of explain.stories) {
    if (match(story)) stories.push({ story });
    else {
      const via = story.members.find(match);
      if (via) stories.push({ story, via });
    }
  }
  // An exact id beats title matches that merely contain the same letters.
  const exact = exactId ? stories.filter((m) => m.story.id === exactId || m.via?.id === exactId) : [];
  const dropped = explain.dropped.filter(match);
  const exactDropped = exactId ? dropped.filter((d) => d.id === exactId) : [];
  return { stories: (exact.length ? exact : stories).slice(0, MAX_MATCHES), dropped: (exactDropped.length ? exactDropped : dropped).slice(0, MAX_MATCHES) };
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** The published edition of the same build (for the mute lines) and the mutes to evaluate. */
export interface ExplainView {
  edition?: Edition | null;
  /** Source ids from --mute; empty = "what if the lead's own source is muted". */
  mute?: readonly string[];
}

const mutes = (ids: Iterable<string>): MuteSet => ({ sources: new Set(ids), sections: new Set() });

/**
 * What a reader sees in the row of the story keyed by `lead` under mutes, in words. Uses the client's
 * own function on the published files, so it cannot disagree with the page. [] when the edition is
 * not available or does not hold the story.
 */
export function muteLines(edition: Edition | null | undefined, lead: string, requested: readonly string[] = []): string[] {
  if (!edition) return [];
  const story = storyOf(edition, lead);
  if (!story) return [];
  const own = story.lead.src;
  const ids = requested.length ? [...requested] : [own];
  const label = requested.length ? `with ${ids.join(", ")} muted` : `if a reader mutes the lead's source (${own})`;
  const seen = visibleStory(edition, lead, mutes(ids));
  if (seen === null) return [`  ${label}: the row disappears - every outlet covering the story is muted`];
  if (seen.lead.id === story.lead.id) {
    const fewer = story.members.length - seen.members.length;
    return requested.length ? [`  ${label}: the row is unchanged${fewer > 0 ? ` (${fewer} muted outlet(s) leave the "Also:" line, ${seen.publishers} publisher(s) shown)` : ""}`] : [];
  }
  return [
    `  ${label}: the row keeps its place and is re-led by "${seen.lead.title}" - ${sourceName(edition, seen.lead.src)} [${seen.lead.id}], ${seen.publishers} publisher(s) shown`,
    `    (the story key stays ${lead}, so its rank does not change; title, link, source, time and bookmark are the shown outlet's)`,
  ];
}

export function formatStory({ story, via }: ExplainMatch, view: ExplainView = {}): string[] {
  const p = story.parts;
  const lines = [
    `${story.title}`,
    `  id ${story.id}  ${story.url}`,
    `  source ${story.source} (${story.publisher})${story.flags.length ? `  flags: ${story.flags.join(", ")}` : ""}`,
  ];
  if (via) lines.push(`  matched member: ${via.title} [${via.id}] - ${via.source}`);
  lines.push(
    `  score ${fmt(story.score)} = tier ${fmt(p.tier)} + recency ${fmt(p.recency)} + importance ${fmt(p.importance)} + coverage ${fmt(p.coverage)} + hn ${fmt(p.hn)}`,
    `  age ${story.ageHours} h (effective ${story.effectiveAt}), weight ${story.w}, ${story.publishers.length} publisher(s)${story.publishers.length ? `: ${story.publishers.join(", ")}` : ""}`,
  );
  // Every part but recency is multiplied by the age fade, so the numbers above are already faded.
  const kept = fade(story.ageHours);
  lines.push(`  fade x${fmt(kept)} at ${story.ageHours} h (half-life ${SCORE.fadeHalfLifeHours} h) is already applied to tier, importance, coverage and hn; recency has its own half-life (${SCORE.halfLifeHours} h)`);
  if (story.regulatorNotice) {
    // importance = min(cap, title signals + regulator notice) x fade. Undo the fade to say which case it is.
    const { regulatorNotice: points, max: cap } = SCORE.importance;
    const before = kept > 0 ? p.importance / kept : 0;
    const capped = before >= cap - 0.05;
    lines.push(
      `  importance includes the regulator-notice term: the lead's source is tagged regulator + first-party, which adds ${fmt(points)} before the fade` +
        (capped ? ` (capped at ${fmt(cap)} together with the title signals)` : ` (title signals ${fmt(Math.max(0, before - points))})`) +
        `; after the fade it is worth ${fmt(Math.min(points, before) * kept)} of the ${fmt(p.importance)}`,
    );
  }
  const rescued = [story, ...story.members].filter((i) => i.rescued);
  for (const i of rescued) {
    lines.push(
      `  kept over the source cap: "${i.title}" [${i.id}] - ${i.source} had more items than its cap, and this one stays because another publisher covers the same story` +
        ", or because items of a story with 6 or more publishers had taken that source's slots",
    );
  }
  if (story.isLead) lines.push("  LEAD STORY");
  if (story.topRank !== null) lines.push(`  TOP STORIES #${story.topRank}`);
  if (story.topHeld) {
    lines.push(`  held in TOP STORIES since ${story.topHeld.since} at score ${fmt(story.topHeld.score)}: it no longer qualifies on its own and keeps the slot until a newcomer clearly outscores it or the hold runs out`);
  }
  for (const r of story.topRelated ?? []) lines.push(`  follow-up folded under this TOP story (no slot of its own): "${r.title}" [${r.id}] - ${r.source}`);
  if (story.foldedUnder) {
    lines.push(`  not in TOP STORIES: a follow-up of the running story "${story.foldedUnder.title}" [${story.foldedUnder.id}], without enough publishers of its own for a second slot`);
  }
  if (story.sections.length) {
    for (const s of story.sections) lines.push(`  placed: ${s.id} #${s.rank}${s.home ? " (homepage)" : " (view-all only)"}`);
  } else {
    lines.push(`  not placed in any section (would be listed under ${story.primary ?? "?"}; river only)`);
  }
  if (story.trace) {
    const t = story.trace;
    lines.push(`  route: ${t.routedTo ? `routed to ${t.routedTo}` : "not routed"}${t.rule ? ` by rule "${t.rule}"` : ""}`);
    for (const [section, why] of Object.entries(t.cut ?? {})) lines.push(`  cut from ${section}: ${why}`);
    for (const [section, why] of Object.entries(t.focus ?? {})) lines.push(`  section focus in ${section}: ${why} (orders that section's list only; the score is unchanged)`);
  }
  if (story.members.length) {
    lines.push(`  also (${story.members.length}):`);
    for (const m of story.members.slice(0, 12)) lines.push(`    - ${m.title} [${m.id}] - ${m.source} (${m.publisher})`);
    if (story.members.length > 12) lines.push(`    ... ${story.members.length - 12} more`);
  }
  // A row only exists for a placed story; the edition must be the one this record describes.
  if (story.sections.length || story.topRank !== null) lines.push(...muteLines(view.edition, story.id, view.mute));
  return lines;
}

/** Drop reasons that also take the item's row out of the 7-day river (emit/river.ts rejectedThisRun). */
const RIVER_REJECTED: ReadonlySet<string> = new Set(["invalid", "excluded", "noise", "off_topic"]);

export function formatDropped(d: DroppedItem): string[] {
  const lines = [`${d.title}`, `  id ${d.id ?? "-"}  ${d.url}`, `  DROPPED at ${d.stage}: ${d.reason}${d.detail ? ` (${d.detail})` : ""}  [source ${d.sourceId}]`];
  if (d.reason === "source_cap") {
    lines.push("  not kept as corroboration: an over-cap item comes back only when a surviving item of ANOTHER publisher is in the same story, and none was");
  }
  if (d.id !== null && RIVER_REJECTED.has(d.reason)) lines.push("  a row an earlier build remembered for this item also leaves the 7-day river and search");
  return lines;
}

export function formatHits(hits: ExplainHits, query: string, explain: Pick<ExplainFile, "generatedAt">, view: ExplainView = {}): string[] {
  if (hits.stories.length === 0 && hits.dropped.length === 0) return [`No story or dropped item matches "${query}" in the run of ${explain.generatedAt}.`];
  const lines = [`Run of ${explain.generatedAt} - ${hits.stories.length} stor${hits.stories.length === 1 ? "y" : "ies"}, ${hits.dropped.length} dropped item(s) match "${query}":`, ""];
  for (const m of hits.stories) lines.push(...formatStory(m, view), "");
  for (const d of hits.dropped) lines.push(...formatDropped(d), "");
  return lines;
}

/** What the published files alone can say about a query (no score parts, no drops). */
export function explainFromPublished(front: EditionFront, rest: EditionRest | null, river: RiverFile | null, query: string, mute: readonly string[] = []): string[] {
  const match = matcherFor(query);
  const e = mergeEdition(front, rest);
  const lines = [`No explain record found; using the published data of ${front.generatedAt} (placements only, no score parts).`, ""];
  let hits = 0;
  const memberOf = new Map<string, string>();
  for (const [lead, c] of Object.entries(e.clusters)) for (const m of c.members) memberOf.set(m, lead);
  for (const a of Object.values(e.articles)) {
    if (hits >= MAX_MATCHES || !match(a)) continue;
    hits++;
    const lead = memberOf.get(a.id) ?? a.id;
    const story = storyOf(e, lead);
    lines.push(`${a.title}`, `  id ${a.id}  ${a.url}`, `  source ${sourceName(e, a.src)} (${publisherName(e, a)}), home ${a.home}, tier ${a.tier}, weight ${a.w ?? 1}`);
    if (lead !== a.id) lines.push(`  member of the story led by ${lead}: ${e.articles[lead]?.title ?? "?"}`);
    if (story) lines.push(`  coverage: ${story.publishers} publisher(s), ${story.members.length} other article(s)`);
    const top = e.top.indexOf(lead);
    if (top >= 0) lines.push(`  TOP STORIES #${top + 1}${e.leadId === lead ? " (lead)" : ""}`);
    let placed = top >= 0;
    for (const s of e.sections) {
      const rank = s.rows.indexOf(lead);
      if (rank >= 0) {
        placed = true;
        lines.push(`  placed: ${s.id} #${rank + 1}${rank < s.homeCount ? " (homepage)" : " (view-all only)"}`);
      }
    }
    if (placed) lines.push(...muteLines(e, lead, mute));
    lines.push("");
  }
  if (hits === 0 && river) {
    for (const r of riverRows(river)) {
      if (hits >= MAX_MATCHES) break;
      if (!match(r)) continue;
      hits++;
      lines.push(`${r.title}`, `  id ${r.id}  ${r.url}`, `  river only: ${r.sourceName}, section ${r.section}${r.leadId ? `, clustered under ${r.leadId}` : ""} - passed relevance but is not in any section list`, "");
    }
  }
  if (hits === 0) lines.push(`Nothing published matches "${query}". It was dropped before routing, or never fetched.`);
  return lines;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isExplainFile(x: unknown): x is ExplainFile {
  const o = x as Partial<ExplainFile> | null;
  return typeof o === "object" && o !== null && Array.isArray(o.stories) && Array.isArray(o.dropped) && typeof o.generatedAt === "string";
}

export async function runExplain(argv: readonly string[], cwd: string): Promise<{ code: number; lines: string[] }> {
  let file = path.resolve(cwd, EXPLAIN_FILE);
  let dataDir = path.resolve(cwd, "public", DATA_DIR);
  let mute: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file" && argv[i + 1]) file = path.resolve(cwd, argv[++i]);
    else if (argv[i] === "--dir" && argv[i + 1]) dataDir = path.resolve(cwd, argv[++i]);
    else if (argv[i] === "--mute" && argv[i + 1]) mute = argv[++i].split(",").map((id) => id.trim()).filter(Boolean);
    else words.push(argv[i]);
  }
  const query = words.join(" ").trim();
  if (!query) return { code: 2, lines: ["usage: npx tsx scripts/tools/explain.ts <article-id | url | title words> [--file <explain.json>] [--dir <data dir>] [--mute <source-id,...>]"] };

  const explain = await readJson(file);
  const front = await readJson(path.join(dataDir, DATA_FILES.front));
  const rest = await readJson(path.join(dataDir, DATA_FILES.rest));
  const restOfBuild = isEditionFront(front) && isEditionRest(rest) && rest.buildId === front.buildId ? rest : null;
  if (isExplainFile(explain)) {
    const hits = findInExplain(explain, query);
    // The mute lines need the files the client would load, and only those of the SAME build say anything about this record.
    const sameBuild = isEditionFront(front) && front.buildId === explain.buildId;
    const edition = sameBuild ? mergeEdition(front, restOfBuild) : null;
    const lines = formatHits(hits, query, explain, { edition, mute });
    if (!sameBuild && hits.stories.length > 0) lines.push(`(mute preview not shown: ${isEditionFront(front) ? `the published files in ${dataDir} are from another build (${front.buildId})` : `no published files in ${dataDir}`})`);
    return { code: hits.stories.length + hits.dropped.length > 0 ? 0 : 1, lines };
  }
  if (!isEditionFront(front)) return { code: 1, lines: [`No explain record at ${file} and no valid front.json in ${dataDir}. Run the pipeline first.`] };
  const river = await readJson(path.join(dataDir, DATA_FILES.river));
  return { code: 0, lines: explainFromPublished(front, restOfBuild, isRiverFile(river) ? river : null, query, mute) };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { code, lines } = await runExplain(process.argv.slice(2), process.cwd());
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
