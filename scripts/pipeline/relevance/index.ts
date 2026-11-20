// WP3 relevance stage: which normalized items are worth clustering and routing (pure).
//
// Checks, in order - the first that fails records the DropReason:
//   too_old      effectiveAt older than the source's maxAgeDays
//   excluded     a link-host item whose outlet is on the registry deny list (registry/outlets.ts:
//                content farms, press-release and filing mills), then the source's own include /
//                exclude / includeUrl / excludeUrl (rules.ts)
//   noise        webinars, events, job posts, sponsored posts, index pages, promos (noise.ts)
//   off_topic    scope "general" item that fails the AI-relevance gate (aiTerms.ts)
//   source_cap   more survivors from one source than its cap (SourceDef.maxKept, default
//                PIPELINE.sourceCap): the highest-tier, then freshest, are kept
//
// The gate does NOT apply to sources whose home section belongs to the "owner" desk (CYBER WIRE,
// QUANTUM WATCH): the owner wants the general cyber / quantum wire there. It also does not apply
// when the source has its own `include` list, which replaces it (registry/types.ts).
//
// The cap runs AFTER relevance. V1 kept each feed's six newest items before looking at them, so a
// general wire's slots went to its newest stories instead of its AI stories.
//
// The cap must not remove CORROBORATION. It runs before clustering, so on a busy day it cut the
// items stories are built from: OpenAI's own "Introducing GPT-6.2 Astra and Sol" (8 newer OpenAI
// posts) left the GPT-6.2 story led by a third-party changelog, and the Reuters copy of the EU
// Commission attack left that story as two single-publisher rows. filterRelevance therefore also
// returns `passed` (everything that survived the checks, before the cap), and rescueCorroboration
// gives back the over-cap items that share a story with another publisher. The caller supplies the
// clustering (a stage may not import a sibling stage); run.ts composes the two.

import { findSection } from "../../../shared/sections";
import { DAY_MS, parseMs } from "../../../shared/time";
import { registrableHost } from "../../../shared/url";
import { DEFAULT_MAX_AGE_DAYS, resolveSource } from "../../registry/defaults";
import { deniedOutlet, UNVETTED_OUTLET_TAG } from "../../registry/outlets";
import { PIPELINE } from "../context";
import type { DropReason, DroppedItem, FilterRelevance, LogLevel, NormalizedItem, Registry, RelevanceOutput, StageContext } from "../types";
import { aiRelevance } from "./aiTerms";
import { noiseKind } from "./noise";
import { applySourceRules, compileSourceRules, type SourceRules } from "./rules";

interface SourcePolicy {
  maxAgeDays: number;
  rules: SourceRules;
  /** Cap after relevance (SourceDef.maxKept with the default applied). */
  maxKept: number;
  /** Registrable host of the feed itself: an item whose link is still on it is an unresolved wrapper. */
  feedHost: string | null;
  /** The registry sets this source's cap itself (SourceDef.maxKept): big-story relief never widens it. */
  ownCap: boolean;
}

const NO_RULES: SourceRules = { include: null, exclude: null, includeUrl: [], excludeUrl: [] };

function policies(registry: Registry): Map<string, SourcePolicy> {
  const out = new Map<string, SourcePolicy>();
  for (const def of registry.sources) {
    if (out.has(def.id)) continue;
    const source = resolveSource(def);
    out.set(def.id, { maxAgeDays: source.maxAgeDays, rules: compileSourceRules(source), maxKept: source.maxKept, feedHost: registrableHost(source.url), ownCap: def.maxKept !== undefined });
  }
  return out;
}

/** True when the item must pass the AI-relevance gate. */
export function isGated(item: Pick<NormalizedItem, "scope" | "home">, hasIncludeList: boolean): boolean {
  if (item.scope !== "general" || hasIncludeList) return false;
  return findSection(item.home)?.desk !== "owner";
}

interface Verdict {
  reason: DropReason;
  detail: string;
}

/**
 * Why a link-host item is dropped for its outlet, or null. The article host decides; for a link
 * that is still the feed's wrapper (its URL says nothing) the outlet host and outlet NAME the feed
 * gives are used instead. Items a publisher's own feed carries are never checked.
 */
export function deniedOutletOf(item: Pick<NormalizedItem, "url" | "attribution" | "publisherName" | "outletHost">, feedHost: string | null): string | null {
  if (item.attribution !== "link-host") return null;
  const wrapped = feedHost !== null && registrableHost(item.url) === feedHost;
  const hit = deniedOutlet({ url: item.url, outletHost: item.outletHost, outletName: wrapped ? item.publisherName : null });
  return hit ? `outlet ${hit.host} is on the registry deny list${wrapped ? " (link not resolved yet)" : ""}` : null;
}

function judge(item: NormalizedItem, policy: SourcePolicy, nowMs: number): Verdict | null {
  const at = parseMs(item.effectiveAt);
  const ageDays = at === null ? Infinity : (nowMs - at) / DAY_MS;
  if (ageDays > policy.maxAgeDays) {
    return { reason: "too_old", detail: `age ${Number.isFinite(ageDays) ? Math.floor(ageDays) : "unknown"} d > ${policy.maxAgeDays} d` };
  }
  const banned = deniedOutletOf(item, policy.feedHost);
  if (banned) return { reason: "excluded", detail: banned };
  const own = applySourceRules(policy.rules, item);
  if (!own.keep) return { reason: "excluded", detail: own.detail ?? "source rule" };

  const noise = noiseKind(item.title, item.summary);
  if (noise) return { reason: "noise", detail: `${noise.kind}: "${noise.match}"` };

  if (isGated(item, policy.rules.include !== null)) {
    const gate = aiRelevance(item.title, item.summary, { home: item.home });
    if (!gate.pass) {
      const seen = gate.hits.length ? `; summary mentions only ${gate.hits.join(", ")}` : "";
      return { reason: "off_topic", detail: `general source, no AI term in the title${seen}` };
    }
  }
  return null;
}

/**
 * Per-source cap: keep the highest-tier, then freshest, N items of each source. `cap` is one number
 * for every source or a function of the source id. Returns the items to cut.
 */
export function overCap(items: readonly NormalizedItem[], cap: number | ((sourceId: string) => number)): Set<NormalizedItem> {
  const capOf = typeof cap === "number" ? () => cap : cap;
  const bySource = new Map<string, { item: NormalizedItem; index: number }[]>();
  items.forEach((item, index) => {
    const list = bySource.get(item.sourceId);
    if (list) list.push({ item, index });
    else bySource.set(item.sourceId, [{ item, index }]);
  });
  const cut = new Set<NormalizedItem>();
  for (const [sourceId, list] of bySource) {
    const limit = capOf(sourceId);
    if (list.length <= limit) continue;
    const ranked = [...list].sort((a, b) => a.item.tier - b.item.tier || (parseMs(b.item.effectiveAt) ?? 0) - (parseMs(a.item.effectiveAt) ?? 0) || a.index - b.index);
    for (const { item } of ranked.slice(limit)) cut.add(item);
  }
  return cut;
}

/** RelevanceOutput plus what rescueCorroboration needs. `kept` / `dropped` are complete on their own. */
export interface CappedRelevanceOutput extends RelevanceOutput {
  /** Every item that passed age / source rules / noise / gate, in input order, BEFORE the per-source cap (kept + the source_cap drops). */
  passed: NormalizedItem[];
  /** Sources whose cap the registry sets itself (SourceDef.maxKept): rescueCorroboration's big-story relief skips them. */
  ownCap: Set<string>;
}

/** The part of a clustered story the rescue reads (pipeline Story satisfies it). */
export interface StoryItems {
  items: readonly NormalizedItem[];
}

/** Does `story` hold coverage of the same event by a publisher other than `item`'s, among the items that `survive`? */
function corroborated(item: NormalizedItem, story: StoryItems | undefined, survives: (other: NormalizedItem) => boolean): boolean {
  return !!story && story.items.some((other) => other !== item && other.countsForCoverage && other.publisher !== item.publisher && survives(other));
}

/**
 * A story with this many coverage publishers is the day's running story: the items a wire files on
 * it do not count against that wire's per-source cap (rescueCorroboration, second step). Same number
 * as the cluster stage's `establishedPublishers` (a stage may not import a sibling stage).
 */
export const BIG_STORY_PUBLISHERS = 6;

/**
 * Give back the over-cap items that corroborate a story (see the header comment).
 *
 * `clusterItems` clusters the given items into stories (run.ts passes the cluster stage). It is
 * called once with `out.passed`; an over-cap item is rescued when its story contains a surviving
 * item of a DIFFERENT publisher that counts for coverage. Everything else the cap cut stays a "source_cap"
 * drop, so a source's single-publisher rows never exceed its cap and explicit `maxKept` values
 * (arXiv listings, query feeds) keep their meaning. An item of an UNVETTED outlet (registry/outlets.ts)
 * is never rescued: it adds no coverage, and a query feed's cap is what keeps six rewrites of one
 * TechCrunch story out of that story's "Also:" line.
 *
 * Second step, big-story relief: a kept item that belongs to a story with BIG_STORY_PUBLISHERS
 * coverage publishers does not count against its source's cap, and the best over-cap
 * items of that source (cap order: tier, then freshest) take the freed slots. Live 2026-11-20: five
 * of CNBC's eight slots were Anthropic-IPO items, and "Palo Alto stock jumps on earnings beat and
 * company's big bet on securing open-weight models" - the only corroboration of a $4.5B acquisition
 * - was cut. Never more than the source's kept count again, never an unvetted item, and never for a
 * source whose cap the registry sets itself (`ownCap`: arXiv listings, query feeds, tickers).
 *
 * Returns a plain RelevanceOutput: `kept` in input order with the rescued items in place, `dropped`
 * without their records. Pure; the input is not mutated. An output without `passed` (or with
 * nothing over the cap) is returned as it is.
 */
export function rescueCorroboration(
  out: RelevanceOutput & { passed?: readonly NormalizedItem[]; ownCap?: ReadonlySet<string> },
  clusterItems: (items: NormalizedItem[]) => readonly StoryItems[],
  ctx?: { log: (level: LogLevel, msg: string) => void },
): RelevanceOutput {
  const base: RelevanceOutput = { kept: out.kept, dropped: out.dropped };
  const passed = out.passed ?? [];
  const keptSet = new Set(out.kept);
  const over = passed.filter((item) => !keptSet.has(item) && !item.tags.includes(UNVETTED_OUTLET_TAG));
  if (over.length === 0) return base;

  const storyOf = new Map<NormalizedItem, StoryItems>();
  for (const story of clusterItems([...passed])) for (const item of story.items) storyOf.set(item, story);
  // The corroborating item must itself survive (kept, or rescued in turn): repeat until stable, so an
  // over-cap discussion thread is not rescued by an over-cap article that then stays cut.
  let rescued = new Set(over);
  for (;;) {
    const current = rescued;
    const next = new Set(over.filter((item) => current.has(item) && corroborated(item, storyOf.get(item), (other) => keptSet.has(other) || current.has(other))));
    if (next.size === current.size) break;
    rescued = next;
  }
  // Big-story relief. A source's slots that went to a big story's items are given to its next items.
  const survives = (item: NormalizedItem): boolean => keptSet.has(item) || rescued.has(item);
  const freed = new Map<string, number>();
  const seenStories = new Set<StoryItems>();
  for (const story of storyOf.values()) {
    if (seenStories.has(story)) continue;
    seenStories.add(story);
    const alive = story.items.filter(survives);
    if (new Set(alive.filter((i) => i.countsForCoverage).map((i) => i.publisher)).size < BIG_STORY_PUBLISHERS) continue;
    for (const item of alive) if (keptSet.has(item)) freed.set(item.sourceId, (freed.get(item.sourceId) ?? 0) + 1);
  }
  let relieved = 0;
  if (freed.size > 0) {
    const waiting = over
      .filter((item) => !rescued.has(item) && freed.has(item.sourceId) && !(out.ownCap?.has(item.sourceId) ?? false))
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.tier - b.item.tier || (parseMs(b.item.effectiveAt) ?? 0) - (parseMs(a.item.effectiveAt) ?? 0) || a.index - b.index);
    for (const { item } of waiting) {
      const left = freed.get(item.sourceId) ?? 0;
      if (left <= 0) continue;
      freed.set(item.sourceId, left - 1);
      rescued.add(item);
      relieved++;
    }
  }
  if (rescued.size === 0) return base;

  // One source_cap record per rescued item leaves `dropped` (twin feeds can share an id, so count them).
  const key = (id: string | null, sourceId: string): string => `${sourceId}\u0000${id ?? ""}`;
  const pending = new Map<string, number>();
  for (const item of rescued) pending.set(key(item.id, item.sourceId), (pending.get(key(item.id, item.sourceId)) ?? 0) + 1);
  const dropped = out.dropped.filter((d) => {
    if (d.reason !== "source_cap") return true;
    const k = key(d.id, d.sourceId);
    const n = pending.get(k) ?? 0;
    if (n === 0) return true;
    pending.set(k, n - 1);
    return false;
  });
  const kept = passed.filter((item) => keptSet.has(item) || rescued.has(item));
  const relief = relieved > 0 ? ` (${relieved} of them in cap slots that items of a ${BIG_STORY_PUBLISHERS}+ publisher story had taken)` : "";
  ctx?.log("info", `relevance: ${rescued.size} of ${over.length} over-cap items kept as corroboration of a multi-publisher story${relief} -> ${kept.length} kept`);
  return { kept, dropped };
}

function run(items: readonly NormalizedItem[], registry: Registry, ctx: StageContext): CappedRelevanceOutput {
  const bySource = policies(registry);
  const nowMs = ctx.now.getTime();
  const dropped: DroppedItem[] = [];
  const drop = (item: NormalizedItem, reason: DropReason, detail: string): void => {
    dropped.push({ id: item.id, sourceId: item.sourceId, title: item.title, url: item.url, reason, stage: "relevance", detail });
  };

  const passed: NormalizedItem[] = [];
  for (const item of items) {
    const policy = bySource.get(item.sourceId) ?? { maxAgeDays: DEFAULT_MAX_AGE_DAYS, rules: NO_RULES, maxKept: PIPELINE.sourceCap, feedHost: null, ownCap: false };
    const verdict = judge(item, policy, nowMs);
    if (verdict) drop(item, verdict.reason, verdict.detail);
    else passed.push(item);
  }

  const capOf = (sourceId: string): number => bySource.get(sourceId)?.maxKept ?? PIPELINE.sourceCap;
  const cut = overCap(passed, capOf);
  const kept: NormalizedItem[] = [];
  for (const item of passed) {
    if (cut.has(item)) drop(item, "source_cap", `over the per-source cap of ${capOf(item.sourceId)} (kept the freshest)`);
    else kept.push(item);
  }

  const counts = new Map<DropReason, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const reasons = [...counts].map(([reason, n]) => `${reason} ${n}`).join(", ") || "none";
  ctx.log("info", `relevance: ${items.length} items -> ${kept.length} kept (dropped: ${reasons})`);
  const ownCap = new Set<string>();
  for (const [id, policy] of bySource) if (policy.ownCap) ownCap.add(id);
  return { kept, dropped, passed, ownCap };
}

export const filterRelevance = run satisfies FilterRelevance;
