// Contract invariants: cross-reference integrity of a v2 data bundle. Structural shape checks are
// in shared/guards.ts - run the guards FIRST, these functions assume well-shaped input.
//
// Every function returns a list of human-readable problems ([] = valid). Used by emit tests
// (test/helpers/invariants.ts wraps them in asserts), test/contract.test.ts and the check-data gate.

import {
  RIVER_DAYS,
  TOP_STORIES_MAX,
  type ArticleId,
  type ArticleV2,
  type BriefFile,
  type ClusterV2,
  type EditionFront,
  type EditionRest,
  type HealthFile,
  type RiverFile,
  type SourceRef,
  type SourcesFile,
  type StatusFile,
  type StocksFile,
} from "./contract";
import { SECTIONS, findSection, type SectionId } from "./sections";
import { DAY_MS, parseMs } from "./time";

export interface DataBundle {
  front: EditionFront;
  rest?: EditionRest | null;
  river?: RiverFile | null;
  health?: HealthFile | null;
  sources?: SourcesFile | null;
  brief?: BriefFile | null;
  stocks?: StocksFile | null;
  status?: StatusFile | null;
}

function dupes(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) out.add(id);
    seen.add(id);
  }
  return [...out];
}

function checkSectionList(file: string, ids: readonly SectionId[], problems: string[]): void {
  const want = SECTIONS.map((s) => s.id);
  if (ids.length !== want.length || ids.some((id, i) => id !== want[i])) {
    problems.push(`${file}.sections: must list every section exactly once in SECTIONS order (got ${ids.join(",")})`);
  }
}

function checkRecords(
  file: string,
  articles: Record<ArticleId, ArticleV2>,
  clusters: Record<ArticleId, ClusterV2>,
  resolveArticle: (id: ArticleId) => ArticleV2 | undefined,
  resolveSource: (id: string) => SourceRef | undefined,
  problems: string[],
): void {
  for (const [id, a] of Object.entries(articles)) {
    if (!resolveSource(a.src)) problems.push(`${file}.articles.${id}: src "${a.src}" not in sources`);
    for (const v of a.via ?? []) {
      if (v === a.src) problems.push(`${file}.articles.${id}: via contains its own src`);
      if (!resolveSource(v)) problems.push(`${file}.articles.${id}: via "${v}" not in sources`);
    }
  }
  for (const [lead, c] of Object.entries(clusters)) {
    if (!articles[lead]) problems.push(`${file}.clusters.${lead}: lead not in ${file}.articles`);
    if (c.members.length === 0) problems.push(`${file}.clusters.${lead}: singleton cluster must be omitted`);
    if (c.members.includes(lead)) problems.push(`${file}.clusters.${lead}: members must not include the lead`);
    for (const d of dupes(c.members)) problems.push(`${file}.clusters.${lead}: duplicate member ${d}`);
    for (const m of c.members) if (!resolveArticle(m)) problems.push(`${file}.clusters.${lead}: member ${m} not in articles`);
    if (c.publishers < 1 || c.publishers > c.members.length + 1) {
      problems.push(`${file}.clusters.${lead}: publishers ${c.publishers} out of range 1..${c.members.length + 1}`);
    }
  }
}

/** Invariants of front.json on its own. */
export function checkFront(front: EditionFront): string[] {
  const p: string[] = [];
  checkSectionList("front", front.sections.map((s) => s.id), p);

  if (front.top.length > TOP_STORIES_MAX) p.push(`front.top: ${front.top.length} > ${TOP_STORIES_MAX}`);
  for (const d of dupes(front.top)) p.push(`front.top: duplicate ${d}`);
  if (front.leadId !== (front.top[0] ?? null)) p.push(`front.leadId: must equal top[0] ?? null (lead ${String(front.leadId)}, top[0] ${String(front.top[0])})`);

  const referenced = new Set<ArticleId>();
  const rowIds = new Set<ArticleId>();
  for (const s of front.sections) {
    const def = findSection(s.id);
    if (!def) continue;
    if (s.rows.length > def.homeRows) p.push(`front.sections.${s.id}: ${s.rows.length} rows > homeRows ${def.homeRows}`);
    if (s.total < s.rows.length) p.push(`front.sections.${s.id}: total ${s.total} < rows ${s.rows.length}`);
    if (s.total > def.allRows) p.push(`front.sections.${s.id}: total ${s.total} > allRows ${def.allRows}`);
    for (const d of dupes(s.rows)) p.push(`front.sections.${s.id}: duplicate row ${d}`);
    for (const id of s.rows) {
      referenced.add(id);
      rowIds.add(id);
      const a = front.articles[id];
      if (!a) {
        p.push(`front.sections.${s.id}: row ${id} not in front.articles`);
        continue;
      }
      if (def.mode === "source" && a.home !== s.id) p.push(`front.sections.${s.id}: source-mode section holds ${id} whose home is ${a.home}`);
    }
  }

  for (const id of front.top) {
    referenced.add(id);
    const a = front.articles[id];
    if (!a) {
      p.push(`front.top: ${id} not in front.articles`);
      continue;
    }
    if (a.flags?.includes("release")) p.push(`front.top: ${id} is a release`);
    if (a.flags?.includes("discussion")) p.push(`front.top: ${id} is a community item`);
  }

  checkRecords("front", front.articles, front.clusters, (id) => front.articles[id], (id) => front.sources[id], p);

  const memberOf = new Map<ArticleId, ArticleId>();
  for (const [lead, c] of Object.entries(front.clusters)) {
    if (!referenced.has(lead)) p.push(`front.clusters.${lead}: cluster of an article that is not a row / top story`);
    for (const m of c.members) {
      const other = memberOf.get(m);
      if (other && other !== lead) p.push(`front.clusters: ${m} is a member of both ${other} and ${lead}`);
      memberOf.set(m, lead);
      if (rowIds.has(m) || front.top.includes(m)) p.push(`front.clusters.${lead}: member ${m} is also a row / top story`);
      if (front.clusters[m]) p.push(`front.clusters.${lead}: member ${m} leads its own cluster`);
    }
  }
  for (const id of Object.keys(front.articles)) {
    if (!referenced.has(id) && !memberOf.has(id)) p.push(`front.articles.${id}: not referenced by any row, top story or cluster`);
  }
  const usedSources = new Set<string>();
  for (const a of Object.values(front.articles)) {
    usedSources.add(a.src);
    for (const v of a.via ?? []) usedSources.add(v);
  }
  for (const id of Object.keys(front.sources)) if (!usedSources.has(id)) p.push(`front.sources.${id}: not referenced by any article`);

  if (front.counts.feedsOk > front.counts.feedsTotal) p.push("front.counts: feedsOk > feedsTotal");
  return p;
}

/** Invariants that tie rest.json to front.json. */
export function checkRest(front: EditionFront, rest: EditionRest): string[] {
  const p: string[] = [];
  if (rest.buildId !== front.buildId) p.push(`rest.buildId ${rest.buildId} !== front.buildId ${front.buildId}`);
  checkSectionList("rest", rest.sections.map((s) => s.id), p);

  for (const id of Object.keys(rest.articles)) if (front.articles[id]) p.push(`rest.articles.${id}: also in front.articles (keys must be disjoint)`);
  for (const id of Object.keys(rest.clusters)) if (front.clusters[id]) p.push(`rest.clusters.${id}: also in front.clusters (keys must be disjoint)`);
  for (const id of Object.keys(rest.sources)) if (front.sources[id]) p.push(`rest.sources.${id}: also in front.sources (keys must be disjoint)`);

  const article = (id: ArticleId): ArticleV2 | undefined => front.articles[id] ?? rest.articles[id];
  const source = (id: string): SourceRef | undefined => front.sources[id] ?? rest.sources[id];
  checkRecords("rest", rest.articles, rest.clusters, article, source, p);

  const frontById = new Map(front.sections.map((s) => [s.id, s]));
  const placements = new Map<ArticleId, SectionId[]>();
  const referenced = new Set<ArticleId>();
  let placementCount = 0;
  for (const s of rest.sections) {
    const def = findSection(s.id);
    const f = frontById.get(s.id);
    if (!def || !f) continue;
    if (s.rows.length > def.allRows) p.push(`rest.sections.${s.id}: ${s.rows.length} rows > allRows ${def.allRows}`);
    if (f.total !== s.rows.length) p.push(`front.sections.${s.id}.total ${f.total} !== rest rows ${s.rows.length}`);
    if (f.rows.some((id, i) => s.rows[i] !== id)) p.push(`rest.sections.${s.id}: front rows are not a prefix of rest rows`);
    for (const d of dupes(s.rows)) p.push(`rest.sections.${s.id}: duplicate row ${d}`);
    const srcs = new Set<string>();
    for (const id of s.rows) {
      placementCount++;
      referenced.add(id);
      const a = article(id);
      if (!a) {
        p.push(`rest.sections.${s.id}: row ${id} not in front.articles or rest.articles`);
        continue;
      }
      srcs.add(a.src);
      if (def.mode === "source" && a.home !== s.id) p.push(`rest.sections.${s.id}: source-mode section holds ${id} whose home is ${a.home}`);
      const list = placements.get(id) ?? [];
      list.push(s.id);
      placements.set(id, list);
    }
    if (f.sourceCount !== srcs.size) p.push(`front.sections.${s.id}.sourceCount ${f.sourceCount} !== distinct lead sources ${srcs.size}`);
  }

  // TOP STORIES are ai-desk stories: home on the ai desk, or placed in an ai-desk section.
  for (const id of front.top) {
    const a = article(id);
    if (!a) continue;
    const desks = [a.home, ...(placements.get(id) ?? [])].map((s) => findSection(s)?.desk);
    if (!desks.includes("ai")) p.push(`front.top: ${id} is not an ai-desk story (home ${a.home})`);
  }

  // A story appears in its home section plus AT MOST ONE routed section.
  for (const [id, secs] of placements) {
    const a = article(id);
    if (!a) continue;
    const routed = secs.filter((s) => s !== a.home);
    if (secs.length > 2 || routed.length > 1) p.push(`story ${id}: placed in ${secs.join(",")} (home ${a.home}); allowed: home + at most one routed section`);
  }

  const memberOf = new Map<ArticleId, ArticleId>();
  const allClusters: Record<ArticleId, ClusterV2> = { ...rest.clusters, ...front.clusters };
  for (const [lead, c] of Object.entries(allClusters)) {
    for (const m of c.members) {
      const other = memberOf.get(m);
      if (other && other !== lead) p.push(`clusters: ${m} is a member of both ${other} and ${lead}`);
      memberOf.set(m, lead);
      if (placements.has(m)) p.push(`clusters.${lead}: member ${m} is also a section row`);
      if (allClusters[m]) p.push(`clusters.${lead}: member ${m} leads its own cluster`);
    }
  }
  for (const lead of Object.keys(rest.clusters)) if (!referenced.has(lead)) p.push(`rest.clusters.${lead}: cluster of an article that is not a row`);
  for (const id of Object.keys(rest.articles)) {
    if (!referenced.has(id) && !memberOf.has(id)) p.push(`rest.articles.${id}: not referenced by any row or cluster`);
  }
  const usedSources = new Set<string>();
  for (const a of Object.values(rest.articles)) {
    usedSources.add(a.src);
    for (const v of a.via ?? []) usedSources.add(v);
  }
  for (const id of Object.keys(rest.sources)) if (!usedSources.has(id)) p.push(`rest.sources.${id}: not referenced by any rest article`);

  if (front.counts.placements !== placementCount) p.push(`front.counts.placements ${front.counts.placements} !== total rest rows ${placementCount}`);
  if (front.counts.stories !== placements.size) p.push(`front.counts.stories ${front.counts.stories} !== distinct placed leads ${placements.size}`);
  return p;
}

/** Invariants of river.json (and its relation to the edition when front/rest are given). */
export function checkRiver(river: RiverFile, front?: EditionFront, rest?: EditionRest | null): string[] {
  const p: string[] = [];
  if (front && river.buildId !== front.buildId) p.push(`river.buildId ${river.buildId} !== front.buildId ${front.buildId}`);
  if (river.sources.length !== river.sourceIds.length) p.push("river: sources and sourceIds differ in length");
  for (const d of dupes(river.sourceIds)) p.push(`river.sourceIds: duplicate ${d}`);
  const generated = parseMs(river.generatedAt) ?? 0;
  const oldest = generated - RIVER_DAYS * DAY_MS;
  const ids = new Set<ArticleId>();
  let prev = Infinity;
  let unsorted = 0;
  let tooOld = 0;
  for (const r of river.rows) {
    if (ids.has(r[0])) p.push(`river.rows: duplicate id ${r[0]}`);
    ids.add(r[0]);
    if (r[7] === r[0]) p.push(`river.rows: ${r[0]} names itself as lead (must be null)`);
    const t = r[5] ?? r[6];
    if (t > prev) unsorted++;
    prev = t;
    if (t < oldest) tooOld++;
  }
  if (unsorted) p.push(`river.rows: ${unsorted} rows out of order (must be newest first by publishedAtMs ?? firstSeenAtMs)`);
  if (tooOld) p.push(`river.rows: ${tooOld} rows older than ${RIVER_DAYS} days`);
  if (front) {
    const all: ArticleV2[] = [...Object.values(front.articles), ...Object.values(rest?.articles ?? {})];
    let missing = 0;
    let firstMissing = "";
    for (const a of all) {
      const t = parseMs(a.publishedAt) ?? parseMs(a.firstSeenAt) ?? 0;
      if (t >= oldest && !ids.has(a.id)) {
        missing++;
        firstMissing ||= a.id;
      }
    }
    if (missing) p.push(`river.rows: ${missing} edition articles from the last ${RIVER_DAYS} days are missing (first: ${firstMissing})`);
  }
  return p;
}

/** Cross-file invariants of the auxiliary files. */
export function checkAux(b: DataBundle): string[] {
  const p: string[] = [];
  const { front, health, sources, brief, stocks, status } = b;
  const same = (name: string, id: string | undefined): void => {
    if (id !== undefined && id !== front.buildId) p.push(`${name}.buildId ${id} !== front.buildId ${front.buildId}`);
  };
  same("health", health?.buildId);
  same("sources", sources?.buildId);
  same("brief", brief?.buildId);
  same("stocks", stocks?.buildId);
  same("status", status?.buildId);

  if (health) {
    for (const d of dupes(health.feeds.map((f) => f.id))) p.push(`health.feeds: duplicate id ${d}`);
    const ok = health.feeds.filter((f) => f.ok).length;
    if (front.counts.feedsTotal !== health.feeds.length) p.push(`front.counts.feedsTotal ${front.counts.feedsTotal} !== health feeds ${health.feeds.length}`);
    if (front.counts.feedsOk !== ok) p.push(`front.counts.feedsOk ${front.counts.feedsOk} !== ok health feeds ${ok}`);
    for (const f of health.feeds) {
      if (f.ok && f.failStreak !== 0) p.push(`health.feeds.${f.id}: ok with failStreak ${f.failStreak}`);
      if (!f.ok && f.failStreak < 1) p.push(`health.feeds.${f.id}: not ok with failStreak 0`);
    }
  }
  if (sources) {
    for (const d of dupes(sources.sources.map((s) => s.id))) p.push(`sources.sources: duplicate id ${d}`);
    const byId = new Map(sources.sources.map((s) => [s.id, s]));
    const edition: Record<string, SourceRef> = { ...(b.rest?.sources ?? {}), ...front.sources };
    for (const [id, ref] of Object.entries(edition)) {
      const s = byId.get(id);
      if (!s) p.push(`sources.sources: edition source ${id} missing`);
      else if (s.name !== ref.name) p.push(`sources.sources.${id}: name "${s.name}" !== edition name "${ref.name}"`);
    }
    if (health) for (const f of health.feeds) if (!byId.has(f.id)) p.push(`health.feeds.${f.id}: not in sources.json`);
    if (b.river) for (const id of b.river.sourceIds) if (!byId.has(id)) p.push(`river.sourceIds: ${id} not in sources.json`);
  }
  if (status) {
    if (status.generatedAt !== front.generatedAt) p.push("status.generatedAt !== front.generatedAt");
    if (status.content.top !== front.top.length) p.push(`status.content.top ${status.content.top} !== front.top ${front.top.length}`);
    if (status.content.stories !== front.counts.stories) p.push(`status.content.stories ${status.content.stories} !== front.counts.stories ${front.counts.stories}`);
    if (status.feeds.total !== front.counts.feedsTotal) p.push(`status.feeds.total ${status.feeds.total} !== front.counts.feedsTotal ${front.counts.feedsTotal}`);
    if (status.feeds.ok !== front.counts.feedsOk) p.push(`status.feeds.ok ${status.feeds.ok} !== front.counts.feedsOk ${front.counts.feedsOk}`);
    if (status.feeds.ok + status.feeds.failed + status.feeds.carriedForward + status.feeds.quarantined !== status.feeds.total) {
      p.push("status.feeds: ok + failed + carriedForward + quarantined !== total");
    }
    if (brief && status.brief.source !== brief.source) p.push("status.brief.source !== brief.source");
    const empty = front.sections.filter((s) => s.rows.length === 0).map((s) => s.id);
    if (empty.join(",") !== status.content.emptySections.join(",")) p.push(`status.content.emptySections [${status.content.emptySections.join(",")}] !== empty front sections [${empty.join(",")}]`);
  }
  return p;
}

/** Every invariant that applies to the files present in the bundle. [] = valid. */
export function checkBundle(b: DataBundle): string[] {
  const p = checkFront(b.front);
  if (b.rest) p.push(...checkRest(b.front, b.rest));
  if (b.river) p.push(...checkRiver(b.river, b.front, b.rest));
  p.push(...checkAux(b));
  return p;
}
