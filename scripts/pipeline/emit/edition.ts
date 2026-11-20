// Placements -> the published bundle. `emit` is pure: same input + same ctx = same bytes.
//
// front.json / rest.json follow shared/contract.ts exactly and are built so that shared/invariants.ts
// holds BY CONSTRUCTION. Where the placements break a contract rule (a row that is not a story lead,
// a source-mode section holding a foreign story, a story in three sections, a release in TOP
// STORIES) the offending row is dropped with a warning instead of publishing an invalid edition:
// one routing bug must cost one row, not the whole refresh.

import {
  TOP_STORIES_MAX,
  type ArticleId,
  type ArticleV2,
  type ClusterV2,
  type EditionFront,
  type EditionRest,
  type SectionV2,
  type SourceId,
  type SourceRef,
} from "../../../shared/contract";
import { SECTIONS, isAiDesk, type SectionDef, type SectionId } from "../../../shared/sections";
import { PIPELINE, siteUrl } from "../context";
import type { Emit, NormalizedItem, Placements, Registry, ScoredStory, StageContext } from "../types";
import { buildAtom } from "./atom";
import { clip, clipTitle, editionMeta, isEmittable } from "./common";
import { buildHealth } from "./health";
import { buildOpml } from "./opml";
import { evaluateQuality } from "./quality";
import { buildRiver, rejectedThisRun } from "./river";
import { buildSourcesFile, publisherNames, sourceRef } from "./sourcesFile";
import { briefFailStreakFor, buildStatus } from "./status";

export interface SectionRows {
  def: SectionDef;
  /** Full ranked list (<= allRows). */
  rows: ArticleId[];
  /** Leading rows shown on the homepage (<= homeRows). */
  homeCount: number;
}

export interface SanitizedPlacements {
  sections: SectionRows[];
  top: ArticleId[];
  leadId: ArticleId | null;
  /** lead id -> sections it is listed in. */
  placedIn: Map<ArticleId, SectionId[]>;
  /** One line per dropped row / top story (also logged as warnings). */
  dropped: string[];
}

const isSecondary = (item: NormalizedItem): boolean => item.flags.includes("release") || item.flags.includes("discussion");

/** The story led by `id`, or null when `id` is not a publishable story lead. */
function leadStory(placements: Placements, id: ArticleId, known: ReadonlySet<SourceId>): ScoredStory | null {
  const story = Object.prototype.hasOwnProperty.call(placements.stories, id) ? placements.stories[id] : undefined;
  const lead = story?.items[0];
  if (!story || !lead || lead.id !== id || !isEmittable(lead, known)) return null;
  return story;
}

/** Apply the contract's row rules to the placements (see the file header). Pure. */
export function sanitizePlacements(placements: Placements, known: ReadonlySet<SourceId>): SanitizedPlacements {
  const dropped: string[] = [];
  const placedIn = new Map<ArticleId, SectionId[]>();
  const placedById = new Map(placements.sections.map((s) => [s.id, s]));

  const sections = SECTIONS.map((def): SectionRows => {
    const placed = placedById.get(def.id);
    const rows: ArticleId[] = [];
    const taken = new Set<ArticleId>();
    for (const id of placed?.rows ?? []) {
      if (taken.has(id)) continue;
      if (rows.length >= def.allRows) {
        dropped.push(`${def.id}: rows beyond allRows ${def.allRows} cut`);
        break;
      }
      const story = leadStory(placements, id, known);
      if (!story) {
        dropped.push(`${def.id}: row ${id} is not a publishable story lead`);
        continue;
      }
      const home = story.items[0].home;
      if (def.mode === "source" && home !== def.id) {
        dropped.push(`${def.id}: source-mode section cannot hold ${id} (home ${home})`);
        continue;
      }
      const prior = placedIn.get(id) ?? [];
      if (prior.length >= 2 || (def.id !== home && prior.some((s) => s !== home))) {
        dropped.push(`${def.id}: story ${id} is already in ${prior.join(",")} (home + at most one routed section)`);
        continue;
      }
      taken.add(id);
      rows.push(id);
      placedIn.set(id, [...prior, def.id]);
    }
    const wanted = Math.trunc(placed?.homeCount ?? 0);
    return { def, rows, homeCount: Math.max(0, Math.min(wanted, def.homeRows, rows.length)) };
  });

  const top: ArticleId[] = [];
  for (const id of placements.top) {
    if (top.includes(id)) continue;
    if (top.length >= TOP_STORIES_MAX) {
      dropped.push(`top: stories beyond ${TOP_STORIES_MAX} cut`);
      break;
    }
    const story = leadStory(placements, id, known);
    if (!story) {
      dropped.push(`top: ${id} is not a publishable story lead`);
      continue;
    }
    const lead = story.items[0];
    if (isSecondary(lead)) {
      dropped.push(`top: ${id} is a release / community item`);
      continue;
    }
    if (![lead.home, ...(placedIn.get(id) ?? [])].some(isAiDesk)) {
      dropped.push(`top: ${id} is not an ai-desk story`);
      continue;
    }
    top.push(id);
  }
  // The contract wants leadId === top[0]; route's stability rule may name a lead further down.
  const lead = placements.leadId;
  if (lead !== null && top.includes(lead) && top[0] !== lead) {
    top.splice(top.indexOf(lead), 1);
    top.unshift(lead);
  } else if (lead !== null && !top.includes(lead)) {
    dropped.push(`lead: ${lead} is not a TOP STORY; using top[0]`);
  }
  return { sections, top, leadId: top[0] ?? null, placedIn, dropped };
}

function toArticle(item: NormalizedItem, w: number, ref: SourceRef, known: ReadonlySet<SourceId>): ArticleV2 {
  const a: ArticleV2 = {
    id: item.id,
    url: item.url,
    title: clipTitle(item.title),
    src: item.sourceId,
    publishedAt: item.publishedAt,
    firstSeenAt: item.firstSeenAt,
    home: item.home,
    tier: item.tier,
  };
  const via = [...new Set(item.via)].filter((v) => v !== item.sourceId && known.has(v));
  if (via.length) a.via = via;
  // Link-host sources (Google News, hnrss, Techmeme): the outlet is the article's host, not the feed.
  if (item.attribution === "link-host" && item.publisherName && item.publisherName !== ref.publisher) a.pub = item.publisherName;
  if (item.summary) a.summary = clip(item.summary, PIPELINE.summaryMaxChars);
  if (w === 0 || w === 2 || w === 3) a.w = w;
  if (item.flags.length) a.flags = [...new Set(item.flags)];
  return a;
}

interface Collected {
  articles: Record<ArticleId, ArticleV2>;
  clusters: Record<ArticleId, ClusterV2>;
}

export interface EditionFiles {
  front: EditionFront;
  rest: EditionRest;
  sanitized: SanitizedPlacements;
}

/** front.json + rest.json. `feeds` are the health totals shown in the footer (counts.feedsOk / feedsTotal). */
export function buildEdition(placements: Placements, registry: Registry, feeds: { ok: number; total: number }, ctx: Pick<StageContext, "now" | "buildId">): EditionFiles {
  const names = publisherNames(registry);
  const defs = new Map(registry.sources.map((s) => [s.id, s]));
  const known: ReadonlySet<SourceId> = new Set(defs.keys());
  const refOf = (id: SourceId): SourceRef => {
    const def = defs.get(id);
    if (!def) throw new Error(`emit: source ${id} is not in the registry`);
    return sourceRef(def, names);
  };
  const sanitized = sanitizePlacements(placements, known);

  // Every id that is a row or a TOP STORY. Stories are disjoint by contract (cluster stage); if a
  // member id ever shows up as a lead or in two stories, the first use wins so the edition stays valid.
  const leads = new Set<ArticleId>(sanitized.top);
  for (const s of sanitized.sections) for (const id of s.rows) leads.add(id);
  const claimed = new Set<ArticleId>();

  // Lead + members of one story into `into`; a story already published in `skip` is left alone.
  const collect = (lead: ArticleId, into: Collected, skip?: Collected): void => {
    if (into.articles[lead] || skip?.articles[lead]) return;
    const story = placements.stories[lead];
    const [first, ...others] = story.items;
    into.articles[lead] = toArticle(first, story.w, refOf(first.sourceId), known);
    const members: ArticleId[] = [];
    for (const m of others) {
      if (leads.has(m.id) || claimed.has(m.id) || !isEmittable(m, known)) continue;
      claimed.add(m.id);
      members.push(m.id);
      // A member is rendered as an outlet link on the "Also:" line; nothing shows or searches its
      // summary (the lead's is the story's). Leaving it out keeps front.json inside the first-paint
      // budget on a day with a 30-publisher story (50 member articles: 9 KB gzip of summaries).
      const member = toArticle(m, m.tier === 4 ? 0 : 1, refOf(m.sourceId), known);
      delete member.summary;
      into.articles[m.id] = member;
    }
    if (members.length) {
      into.clusters[lead] = { members, publishers: Math.max(1, Math.min(story.publishers.length, members.length + 1)) };
    }
  };

  const front: Collected = { articles: {}, clusters: {} };
  for (const s of sanitized.sections) for (const id of s.rows.slice(0, s.homeCount)) collect(id, front);
  for (const id of sanitized.top) collect(id, front);
  const rest: Collected = { articles: {}, clusters: {} };
  for (const s of sanitized.sections) for (const id of s.rows) collect(id, rest, front);

  const refs = (articles: Record<ArticleId, ArticleV2>, exclude: Record<SourceId, SourceRef>): Record<SourceId, SourceRef> => {
    const out: Record<SourceId, SourceRef> = {};
    for (const a of Object.values(articles)) {
      for (const sid of [a.src, ...(a.via ?? [])]) if (!out[sid] && !exclude[sid]) out[sid] = refOf(sid);
    }
    return out;
  };
  const frontSources = refs(front.articles, {});
  const restSources = refs(rest.articles, frontSources);

  const leadSrc = (id: ArticleId): SourceId => placements.stories[id].items[0].sourceId;
  const sections: SectionV2[] = sanitized.sections.map((s) => ({
    id: s.def.id,
    label: s.def.label,
    rows: s.rows.slice(0, s.homeCount),
    total: s.rows.length,
    sourceCount: new Set(s.rows.map(leadSrc)).size,
  }));
  const meta = editionMeta(ctx);
  return {
    sanitized,
    front: {
      ...meta,
      leadId: sanitized.leadId,
      top: sanitized.top,
      counts: {
        stories: sanitized.placedIn.size,
        placements: sanitized.sections.reduce((n, s) => n + s.rows.length, 0),
        feedsOk: feeds.ok,
        feedsTotal: feeds.total,
      },
      sections,
      articles: front.articles,
      clusters: front.clusters,
      sources: frontSources,
    },
    rest: {
      ...meta,
      sections: sanitized.sections.map((s) => ({ id: s.def.id, rows: s.rows })),
      articles: rest.articles,
      clusters: rest.clusters,
      sources: restSources,
    },
  };
}

/** WP6 stage: everything a build publishes, from the routed placements. Pure. */
export const emit: Emit = (input, ctx) => {
  const meta = editionMeta(ctx);
  const health = buildHealth(input.health, input.registry, ctx);
  const feeds = { ok: health.feeds.filter((f) => f.ok).length, total: health.feeds.length };
  const { front, rest, sanitized } = buildEdition(input.placements, input.registry, feeds, ctx);
  for (const line of sanitized.dropped) ctx.log("warn", `emit: ${line}`);

  if (input.dropped?.length) {
    const byReason = new Map<string, number>();
    for (const d of input.dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
    const parts = [...byReason].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ${n}`);
    ctx.log("info", `emit: ${input.dropped.length} items dropped upstream (${parts.join(", ")})`);
  }

  const river = buildRiver(input.placements, input.registry, ctx, rejectedThisRun(input.dropped));
  const sources = buildSourcesFile(input.registry, ctx);
  // Brief and stocks were made earlier in the run; stamp them so every file carries one buildId.
  const brief = { ...input.brief, ...meta };
  const stocks = { ...input.stocks, ...meta };
  const site = siteUrl(ctx.env);
  const atom = buildAtom(front, { siteUrl: site });
  const opml = buildOpml(input.registry, { siteUrl: site });

  // The brief failure streak (previous state + this build's brief) decides whether the gate alerts.
  const quality = evaluateQuality({ front, rest, river, health, sources, brief, stocks }, { now: ctx.now, briefFailStreak: briefFailStreakFor(ctx.state, brief) });
  const status = buildStatus({ front, health, sources, brief, stocks, run: input.run, quality }, ctx);
  ctx.log(
    "info",
    `emit: ${front.counts.stories} stories / ${front.counts.placements} rows, ${front.top.length} top, ` +
      `${Object.keys(front.articles).length}+${Object.keys(rest.articles).length} articles, ${river.rows.length} river rows, ` +
      `feeds ${feeds.ok}/${feeds.total}, brief ${brief.source}`,
  );
  return { front, rest, river, health, sources, status, brief, stocks, atom, opml };
};
