// WP4 cluster stage: ONE corpus-wide story clustering, before routing.
//
//   items (unique by id) -> Story[]   every item in exactly one story, lead first
//
// Method: agglomerative clustering on cluster CENTROIDS (similarity.ts explains the vectors and the
// merge tests). A centroid sharpens as a real story grows - the tokens its coverage has in common
// dominate, each outlet's own angle averages out - so there is no single-link chaining: an item
// that resembles ONE member but not the story as a whole stays out, and the more publishers a
// story has, the more confidently it takes in the rest of its coverage.
//
// Two phases:
//   1. press / first-party / paper items form the stories;
//   2. aggregator and community items JOIN the finished stories. They never shape a centroid, so a
//      digest headline ("Gemini 4 Neon, Genie 4 worlds, ...") cannot bridge two stories, and they
//      lead a story only when nothing else is in it.

import type { ArticleId, PublisherId } from "../../../shared/contract";
import type { Cluster, NormalizedItem, Story } from "../types";
import { CLUSTER, buildDocs, cosine, mergeProfiles, mergeScore, profileOf, type ClusterParams, type Doc, type Profile, type SparseVec } from "./similarity";

interface Group {
  /** Doc indices. */
  members: number[];
  profile: Profile;
}

interface Candidate {
  a: number;
  b: number;
  sim: number;
}

/** Cluster pairs whose centroid cosine reaches `floor`, found through an inverted index (no n^2 scan). */
function candidatePairs(groups: ReadonlyMap<number, Group>, floor: number): Candidate[] {
  const postings = new Map<string, [number, number][]>();
  for (const [id, g] of groups) {
    for (const [f, w] of g.profile.centroid) {
      const list = postings.get(f);
      if (list) list.push([id, w]);
      else postings.set(f, [[id, w]]);
    }
  }
  const dots = new Map<number, Map<number, number>>();
  for (const list of postings.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      const [a, wa] = list[i];
      let row = dots.get(a);
      if (!row) dots.set(a, (row = new Map()));
      for (let j = i + 1; j < list.length; j++) {
        const [b, wb] = list[j];
        row.set(b, (row.get(b) ?? 0) + wa * wb);
      }
    }
  }
  const out: Candidate[] = [];
  for (const [a, row] of dots) for (const [b, sim] of row) if (sim >= floor) out.push({ a, b, sim });
  return out.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
}

/** Aggregator digests and community threads join stories; they never form or shape one. */
export function isJoiner(item: NormalizedItem): boolean {
  if (item.flags.includes("release")) return false;
  return item.kind === "aggregator" || item.kind === "community" || item.flags.includes("discussion");
}

/** Doc indices grouped into clusters. Deterministic: depends only on the docs and their order. */
export function clusterDocs(docs: readonly Doc[], params: ClusterParams = CLUSTER): number[][] {
  // URL identity short-circuit: the same article under two ids (www / scheme variants) is one item.
  // Shaping items claim their URLs first, so a press copy is never filed under its aggregator twin.
  const shaping = new Map<number, Group>();
  const joining = new Map<number, Group>();
  const byUrl = new Map<string, Group>();
  const place = (i: number, into: Map<number, Group>): void => {
    const doc = docs[i];
    const twin = doc.urlKey === null ? undefined : byUrl.get(doc.urlKey);
    if (twin) {
      twin.members.push(i);
      twin.profile.publishers.add(doc.item.publisher);
      if (doc.item.countsForCoverage) twin.profile.coverage.add(doc.item.publisher);
      return;
    }
    const group: Group = { members: [i], profile: profileOf(doc) };
    if (doc.urlKey !== null) byUrl.set(doc.urlKey, group);
    into.set(i, group);
  };
  docs.forEach((doc, i) => {
    if (!isJoiner(doc.item)) place(i, shaping);
  });
  docs.forEach((doc, i) => {
    if (isJoiner(doc.item)) place(i, joining);
  });

  // Phase 1. Candidates are scored on the centroids as they were when the round began; earlier
  // merges of the same round change them, so both sides are re-read and re-scored before merging.
  const owner = new Map<number, number>();
  for (const id of shaping.keys()) owner.set(id, id);
  const find = (id: number): number => {
    let root = id;
    for (let next = owner.get(root); next !== undefined && next !== root; next = owner.get(root)) root = next;
    return root;
  };
  for (let round = 0; round < params.maxRounds; round++) {
    let merged = 0;
    for (const c of candidatePairs(shaping, params.attachThreshold)) {
      const ka = find(c.a);
      const kb = find(c.b);
      if (ka === kb) continue;
      const a = shaping.get(ka);
      const b = shaping.get(kb);
      if (!a || !b || mergeScore(a.profile, b.profile, params) === 0) continue;
      const [keep, drop] = ka < kb ? [ka, kb] : [kb, ka];
      shaping.set(keep, { members: [...a.members, ...b.members], profile: mergeProfiles(a.profile, b.profile, params) });
      shaping.delete(drop);
      owner.set(drop, keep);
      merged++;
    }
    if (merged === 0) break;
  }

  // Phase 2. Each joiner goes to the story it matches best; the story's profile is left as it was,
  // so the order joiners are processed in does not matter.
  const extra = new Map<number, number[]>();
  const alone: number[][] = [];
  for (const joiner of joining.values()) {
    let best = -1;
    let bestSim = 0;
    for (const [id, story] of shaping) {
      const sim = mergeScore(story.profile, joiner.profile, params);
      if (sim > bestSim) {
        bestSim = sim;
        best = id;
      }
    }
    if (best < 0) alone.push(joiner.members);
    else extra.set(best, [...(extra.get(best) ?? []), ...joiner.members]);
  }
  return [...[...shaping.entries()].map(([id, g]) => [...g.members, ...(extra.get(id) ?? [])]), ...alone];
}

// ------------------------------------------------------------------------------------------------
// Lead selection and story assembly
// ------------------------------------------------------------------------------------------------

// Formats that are not "the headline of the story": live blogs, video / podcast items, columns,
// newsletter issues, market wraps, transcripts, question headlines.
const NOT_A_HEADLINE: readonly RegExp[] = [
  /[–—|-]\s*(?:[\p{L}]+\s+)?live\s*$/iu,
  /\blive (?:updates?|blog)\b/i,
  /[–—|-]\s*(?:video|podcast|audio)\s*$/i,
  /^\s*(?:view|opinion|letters?|watch|listen|podcast|video|breaking)\b\s*[:\s]/i,
  /\|\s*[\p{L}][\p{L} .'’-]*$/u,
  // An issue number: "AI #195: Opening Bell", "#353 - ...", "Edition #98". Not a rank ("the #2 model",
  // "#1 on the Coding Agent Index") and not a commit reference "(#12345)".
  /(?:^|[\s(])#\d{2,}\s*(?:[-:–]|$)/,
  /\bmarkets wrap\b/i,
  // "Microsoft Ignite 2026: MAI keynote transcript", "Transcript: ..."
  /^\s*transcript\s*:|\btranscript\s*$/i,
  /\?\s*$/,
];
const NOT_AN_ARTICLE_URL = /\/(?:videos?|live|podcasts?|audio)\//i;
// "Anthropic's magnificent IPO" names a story without telling it.
const MIN_HEADLINE_WORDS = 4;

/** An article with a news headline, as opposed to a live blog, video, column, issue number or question? */
export function isArticleHeadline(item: Pick<NormalizedItem, "title" | "url">): boolean {
  return !NOT_AN_ARTICLE_URL.test(item.url) && !NOT_A_HEADLINE.some((re) => re.test(item.title));
}

/**
 * 0 = press / first-party item that may lead; 1 = aggregator (may join, leads only when nothing
 * better exists); 2 = not lead-eligible (community threads, release lines).
 */
export function leadClass(item: NormalizedItem): 0 | 1 | 2 {
  if (!item.leadEligible || item.kind === "community" || item.flags.includes("release") || item.flags.includes("discussion")) return 2;
  if (item.kind === "aggregator") return 1;
  return 0;
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * A newsletter issue or a changelog entry: somebody's commentary on, or a product note about, the
 * story ("Q3 Earnings Wrap", "GPT-6.2 now available in Copilot") rather than the report of it.
 * Such an item leads only when the story holds no press / first-party headline. pickLead applies
 * it per PUBLISHER, so a newsletter still leads over a search feed's copy of its own post.
 */
export function isSecondaryFormat(item: Pick<NormalizedItem, "kind" | "tags">): boolean {
  return item.kind === "newsletter" || item.tags.includes("changelog");
}

/** Cosine of every doc to the centroid of the whole set (how well its wording represents the story). */
function centrality(docs: readonly Doc[]): Map<Doc, number> {
  const sum: SparseVec = new Map();
  for (const d of docs) for (const [f, w] of d.vec) sum.set(f, (sum.get(f) ?? 0) + w);
  return new Map(docs.map((d) => [d, cosine(d.vec, sum)]));
}

/**
 * The lead, in this order of preference:
 * 1. a press / first-party item before an aggregator before a community or release item;
 * 2. an article headline before a live blog / video / column / question;
 * 3. a press / first-party article before a newsletter issue or a changelog entry;
 * 4. a headline that tells the STORY (close to the centroid) before one outlet's side angle;
 * 5. tier 1-2 before tier 3 before tier 4;
 * 6. a headline of four words or more before a label;
 * 7. the EARLIEST (stable across builds while the story grows), then the better tier.
 */
export function pickLead(docs: readonly Doc[], params: ClusterParams = CLUSTER): Doc {
  const central = centrality(docs);
  const best = Math.max(...central.values());
  const secondary = new Set<PublisherId>();
  for (const d of docs) if (isSecondaryFormat(d.item)) secondary.add(d.item.publisher);
  const key = (doc: Doc): (number | string)[] => {
    const item = doc.item;
    return [
      leadClass(item),
      isArticleHeadline(item) ? 0 : 1,
      secondary.has(item.publisher) ? 1 : 0,
      (central.get(doc) ?? 0) >= params.leadCentrality * best ? 0 : 1,
      item.tier <= 2 ? 0 : item.tier === 3 ? 1 : 2,
      item.title.trim().split(/\s+/).length >= MIN_HEADLINE_WORDS ? 0 : 1,
      doc.ms,
      item.tier,
      item.id,
    ];
  };
  return [...docs].sort((a, b) => compareKeys(key(a), key(b)))[0];
}

/** "Also:" order: one line per coverage publisher before repeats; within each, press first, better tier first, newest first. */
function orderMembers(docs: readonly Doc[], lead: Doc): Doc[] {
  const key = (d: Doc): (number | string)[] => [leadClass(d.item), d.item.tier, -d.ms, d.item.id];
  const sorted = docs.filter((d) => d !== lead).sort((a, b) => compareKeys(key(a), key(b)));
  const seen = new Set<PublisherId>([lead.item.publisher]);
  const firsts: Doc[] = [];
  const repeats: Doc[] = [];
  for (const d of sorted) {
    if (d.item.countsForCoverage && !seen.has(d.item.publisher)) {
      seen.add(d.item.publisher);
      firsts.push(d);
    } else repeats.push(d);
  }
  return [...firsts, ...repeats];
}

/** Distinct publishers of the items that count as coverage, in story order. Never feed names. */
export function coveragePublishers(items: readonly NormalizedItem[]): PublisherId[] {
  const out: PublisherId[] = [];
  for (const item of items) if (item.countsForCoverage && !out.includes(item.publisher)) out.push(item.publisher);
  return out;
}

function toStory(docs: readonly Doc[], params: ClusterParams): Story {
  const lead = pickLead(docs, params);
  const items = [lead, ...orderMembers(docs, lead)].map((d) => d.item);
  return { lead: lead.item.id, members: items.slice(1).map((i) => i.id), publishers: coveragePublishers(items), items };
}

/** Stories for a set of items, newest lead first. Pure, and independent of the order the items arrive in. */
export function clusterItems(items: readonly NormalizedItem[], params: ClusterParams = CLUSTER): Story[] {
  const seen = new Set<ArticleId>();
  const unique = items.filter((item) => !seen.has(item.id) && seen.add(item.id));
  const ordered = [...unique].sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : a.id < b.id ? -1 : 1));
  const docs = buildDocs(ordered, params);
  const stories = clusterDocs(docs, params).map((members) => toStory(members.map((i) => docs[i]), params));
  const at = (s: Story): string => s.items[0].effectiveAt;
  return stories.sort((a, b) => (at(a) > at(b) ? -1 : at(a) < at(b) ? 1 : a.lead < b.lead ? -1 : 1));
}

export const cluster: Cluster = (items, ctx) => {
  const stories = clusterItems(items);
  const multi = stories.filter((s) => s.items.length > 1).length;
  const covered = stories.filter((s) => s.publishers.length >= 2).length;
  const biggest = stories.reduce((max, s) => Math.max(max, s.publishers.length), 0);
  ctx.log("info", `cluster: ${items.length} items -> ${stories.length} stories (${multi} multi-item, ${covered} with 2+ publishers, largest ${biggest} publishers)`);
  return stories;
};
