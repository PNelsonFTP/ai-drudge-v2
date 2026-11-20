// WP3 normalize stage: RawItem[] -> NormalizedItem[] (pure; clock and state come from ctx).
//
//   1. identity     canonical URL + id (shared/url, shared/ids); unusable links are dropped "invalid"
//   2. title        markup / entities / site suffix / source prefix (text.ts)
//   3. releases     GitHub release feeds collapse to one line per repo (githubRelease.ts)
//   4. duplicates   repeats inside one source are dropped; same-URL copies across sources fold into via[]
//   5. times        publishedAt (dates.ts), firstSeenAt from the ledger, effectiveAt
//   6. policy       source defaults (registry/defaults resolveSource) denormalised onto the item
//
// Every item that does not come out is recorded in `dropped` with a DropReason.

import type { ArticleFlag, PublisherId } from "../../../shared/contract";
import { slugify } from "../../../shared/text";
import { bareHost, registrableHost } from "../../../shared/url";
import { resolveSource } from "../../registry/defaults";
import { isVettedPublisher, UNVETTED_OUTLET_TAG } from "../../registry/outlets";
import type { PublisherDef, ResolvedSource } from "../../registry/types";
import type { DropReason, DroppedItem, Normalize, NormalizedItem, RawItem, Registry } from "../types";
import { parseDate } from "./dates";
import { dedupeWithinSource, foldTwins, resolveTimes, type Draft, type TwinGroup } from "./dedupe";
import { parseReleaseUrl, selectRelease } from "./githubRelease";
import { applyTitleTemplate, cleanSummary, cleanTitle, decodeEntities, sanitizeText, splitDashOutlet, splitOutletTail } from "./text";
import { itemIdentity } from "./url";

interface SourceEntry {
  source: ResolvedSource;
  order: number;
}

interface PublisherIndex {
  byId: Map<string, PublisherDef>;
  byHost: Map<string, PublisherDef>;
  byName: Map<string, PublisherDef>;
}

function indexRegistry(registry: Registry): { sources: Map<string, SourceEntry>; publishers: PublisherIndex } {
  const sources = new Map<string, SourceEntry>();
  registry.sources.forEach((def, order) => {
    // First definition wins; the registry test owns duplicate detection, the build must not throw here.
    if (!sources.has(def.id)) sources.set(def.id, { source: resolveSource(def), order });
  });
  const publishers: PublisherIndex = { byId: new Map(), byHost: new Map(), byName: new Map() };
  for (const p of registry.publishers) {
    if (!publishers.byId.has(p.id)) publishers.byId.set(p.id, p);
    const nameKey = p.name.trim().toLowerCase();
    if (nameKey && !publishers.byName.has(nameKey)) publishers.byName.set(nameKey, p);
    for (const host of p.hosts) {
      const key = host.trim().toLowerCase().replace(/^www\./, "");
      if (key && !publishers.byHost.has(key)) publishers.byHost.set(key, p);
    }
  }
  return { sources, publishers };
}

interface Attribution {
  publisher: PublisherId;
  publisherName: string;
  /**
   * A registry publisher that vouches for its items claims the outlet (registry/outlets.ts). False
   * for an unknown host or name and for hosting platforms / press-release wires; always true for
   * "source" attribution (the feed is its own publisher).
   */
  vetted: boolean;
}

const known = (def: PublisherDef): Attribution => ({ publisher: def.id, publisherName: def.name, vetted: isVettedPublisher(def.id) });

/** Publisher owning a URL's host: the exact host first ("news.google.com"), then its registrable form. */
function publisherForUrl(url: string | null | undefined, index: PublisherIndex): PublisherDef | undefined {
  const exact = bareHost(url);
  if (!exact) return undefined;
  return index.byHost.get(exact) ?? index.byHost.get(registrableHost(exact) ?? exact);
}

/** Publisher with this display name; "Wall Street Journal" and "The Wall Street Journal" are one name. */
function publisherByName(name: string, index: PublisherIndex): PublisherDef | undefined {
  const key = name.trim().toLowerCase();
  return index.byName.get(key) ?? index.byName.get(key.startsWith("the ") ? key.slice(4) : `the ${key}`);
}

/** True when the item's link is still on its feed's own host (an unresolved wrapper / an aggregator permalink). */
function onFeedHost(url: string, source: ResolvedSource): boolean {
  const linkHost = registrableHost(url);
  return linkHost === null || linkHost === registrableHost(source.url);
}

/**
 * Who published the article. "source" attribution: the source's publisher. "link-host": the
 * publisher owning the article URL's host (an unknown host is its own publisher id). When the link
 * is still on the aggregator's own host (an unresolved wrapper) the feed-provided outlet is used,
 * and without one the item stays attributed to the source. An aggregator rewrite that credits its
 * outlet in the title ("... (Richard Nieva/Forbes)", Draft.titleOutlet) belongs to that outlet.
 */
function attribute(draft: Draft, index: PublisherIndex): Attribution {
  const { source, raw } = draft;
  const own = index.byId.get(source.publisher);
  const bySource: Attribution = { publisher: source.publisher, publisherName: own?.name ?? source.name, vetted: true };
  if (draft.titleOutlet) {
    const def = publisherByName(draft.titleOutlet, index);
    return def ? known(def) : { publisher: slugify(draft.titleOutlet) || source.publisher, publisherName: draft.titleOutlet, vetted: false };
  }
  if (source.attribution !== "link-host") return bySource;

  // The feed's <source> element, else the " - Outlet" tail of a Google News title (Draft.outletName).
  const outletName = sanitizeText(raw.itemPublisher) || draft.outletName || null;
  const linkHost = registrableHost(draft.identity.url);
  const wrapped = onFeedHost(draft.identity.url, source);
  if (linkHost && !wrapped) {
    const def = publisherForUrl(draft.identity.url, index);
    return def ? known(def) : { publisher: linkHost, publisherName: outletName ?? linkHost, vetted: false };
  }
  const byOutlet = publisherForUrl(raw.itemPublisherUrl, index) ?? (outletName ? publisherByName(outletName, index) : undefined);
  if (byOutlet) return known(byOutlet);
  const outletHost = registrableHost(raw.itemPublisherUrl);
  if (outletHost) return { publisher: outletHost, publisherName: outletName ?? outletHost, vetted: false };
  if (outletName) return { publisher: slugify(outletName) || source.publisher, publisherName: outletName, vetted: false };
  // A wrapper that names no outlet at all: nobody vouches for it.
  return { ...bySource, vetted: false };
}

// A Hacker News thread: what an HN search links a text post (Ask HN / Show HN without a link) to.
const HN_THREAD_RE = /^https?:\/\/news\.ycombinator\.com\/item\?(?:[^#]*&)?id=\d+/;

function flagsFor(source: ResolvedSource, url: string): ArticleFlag[] {
  const flags: ArticleFlag[] = [];
  if (source.kind === "github-release") flags.push("release");
  if (source.kind === "papers") flags.push("paper");
  // The item IS a thread, whatever kind of source listed it: it never leads a story other outlets cover.
  if (source.kind === "community" || HN_THREAD_RE.test(url)) flags.push("discussion");
  if (source.tags.includes("paywalled")) flags.push("paywall");
  return flags;
}

function drop(raw: RawItem, id: string | null, url: string, title: string, reason: DropReason, detail: string): DroppedItem {
  return { id, sourceId: raw.sourceId, title, url, reason, stage: "normalize", detail };
}

// RawItem promises strings, but one sloppy parser upstream (a feed title parsed as the number 2027)
// must cost one item at most, never the run.
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Rough plain title for drop records of items that never got a cleaned one. */
const roughTitle = (raw: RawItem): string => sanitizeText(text(raw.title)).slice(0, 200);

/** Host of Google News wrapper links (news.google.com/rss/articles/...). */
const GOOGLE_NEWS_HOST = "news.google.com";

/** At most this many per-source "unreadable date" warnings per run. */
const MAX_DATE_WARNINGS = 10;

/** Steps 1-2: identity + cleaned title, or a drop record. */
function toDraft(raw: RawItem, order: number, entry: SourceEntry | undefined, publishers: PublisherIndex): Draft | DroppedItem {
  const link = text(raw.link);
  if (!entry) return drop(raw, null, link, roughTitle(raw), "invalid", `unknown source id: ${raw.sourceId}`);
  const identity = itemIdentity(link);
  if (!identity) return drop(raw, null, link, roughTitle(raw), "invalid", "link is not an absolute http(s) URL");
  const { source } = entry;
  const host = registrableHost(identity.url);
  const ownNames = [source.name, ...(source.aliases ?? []), publishers.byId.get(source.publisher)?.name];
  // A Google News entry without a <source> element still names its outlet: the title is "Headline -
  // Outlet" by construction. Read it only while the link is the unresolved wrapper (a resolved link
  // names the outlet by its host), so the outlet can be attributed, vetted and denied by NAME.
  let rawTitle = text(raw.title);
  let outletName: string | undefined;
  if (source.attribution === "link-host" && !sanitizeText(raw.itemPublisher) && bareHost(identity.url) === GOOGLE_NEWS_HOST) {
    const tail = splitDashOutlet(rawTitle);
    if (tail) {
      rawTitle = tail.title;
      outletName = tail.outlet;
    }
  }
  const names = [...ownNames, raw.itemPublisher, outletName, publisherForUrl(identity.url, publishers)?.name];
  // An aggregator's own rewrite ends in "(Author/Outlet)" (Techmeme, ~180 characters with it): the
  // credit becomes the item's publisher instead of part of the headline. Split before the length cap.
  let titleOutlet: string | undefined;
  if (source.kind === "aggregator" && onFeedHost(identity.url, source)) {
    const tail = splitOutletTail(rawTitle);
    const outlet = tail ? sanitizeText(decodeEntities(tail.outlet)) : "";
    if (tail && outlet) {
      rawTitle = tail.title;
      titleOutlet = outlet;
    }
  }
  // On a link-host feed the article's host / outlet is not a "Source: " label (text.ts TitleContext.prefixNames).
  const feedTitle = cleanTitle(rawTitle, { names, host, prefixNames: source.attribution === "link-host" ? ownNames : undefined });
  if (!feedTitle) return drop(raw, identity.id, identity.url, roughTitle(raw), "invalid", "empty title after cleaning");
  const title = source.titleTemplate
    ? applyTitleTemplate(source.titleTemplate, { title: feedTitle, summary: cleanSummary(raw.summaryHtml, { title: feedTitle, names: [source.name] }), source: source.name })
    : feedTitle;
  const draft: Draft = { raw, source, sourceOrder: entry.order, identity, title, date: null, order };
  if (titleOutlet) draft.titleOutlet = titleOutlet;
  if (outletName) draft.outletName = outletName;
  return draft;
}

/** Step 3: one line per GitHub release feed. Non-release drafts pass through untouched. */
function collapseReleases(drafts: readonly Draft[], now: Date, dropped: DroppedItem[]): Draft[] {
  const bySource = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.source.kind !== "github-release") continue;
    const list = bySource.get(d.source.id);
    if (list) list.push(d);
    else bySource.set(d.source.id, [d]);
  }
  if (bySource.size === 0) return [...drafts];
  const keep = new Map<Draft, { title: string; synthesized: boolean }>();
  for (const list of bySource.values()) {
    const source = list[0].source;
    const repo = list.map((d) => parseReleaseUrl(text(d.raw.link)).repo).find((r): r is string => !!r) ?? parseReleaseUrl(source.url).repo ?? source.name;
    // The RAW title is parsed: the generic title cleanup would strip "repo: " prefixes the parser needs.
    const entries = list.map((d) => ({ title: sanitizeText(decodeEntities(text(d.raw.title))), link: text(d.raw.link), publishedRaw: d.raw.publishedRaw }));
    const pick = selectRelease(entries, repo, now, source.releaseLine ?? []);
    list.forEach((d, i) => {
      if (i === pick.chosen && pick.title) keep.set(d, { title: cleanTitle(pick.title), synthesized: pick.synthesized });
      else dropped.push(drop(d.raw, d.identity.id, d.identity.url, d.title, "release_collapsed", pick.collapsed.get(i) ?? "folded into the repo's release line"));
    });
  }
  const out: Draft[] = [];
  for (const d of drafts) {
    if (d.source.kind !== "github-release") out.push(d);
    else {
      const k = keep.get(d);
      if (k) out.push({ ...d, title: k.title, synthesizedTitle: k.synthesized });
    }
  }
  return out;
}

/** Steps 5-6: the finished item for one article and its folded copies. */
function toItem(group: TwinGroup, publishers: PublisherIndex, ctx: Parameters<Normalize>[2]): NormalizedItem {
  const { primary, twins } = group;
  const { source, identity, raw } = primary;
  const copies = [primary, ...twins];
  // An article whose wrapper link was resolved after it was first listed is known to the ledger under the wrapper's id.
  const formerIds = [...new Set(copies.map((d) => itemIdentity(d.raw.resolvedFrom)?.id).filter((id): id is string => !!id && id !== identity.id))];
  const times = resolveTimes(
    { ids: [...copies.map((d) => d.identity.id), ...formerIds], dates: copies.map((d) => d.date), sourceId: source.id, maxAgeDays: source.maxAgeDays },
    ctx.state,
    ctx.now,
  );
  const who = attribute(primary, publishers);
  // Outlet quality control (registry/outlets.ts): on a source that vets its outlets, an item no
  // registry publisher vouches for carries no standing. Any copy from a source with its own quality
  // signal ("open": HN points, Techmeme's editors) or from the publisher's own feed lifts the cap.
  const unvetted = !who.vetted && copies.every((d) => d.source.outlets === "vetted");
  let summary: string | null = null;
  for (const d of copies) {
    summary = cleanSummary(d.raw.summaryHtml, { title: d.title, names: [who.publisherName, d.raw.itemPublisher, d.source.name] });
    if (summary) break;
  }
  const item: NormalizedItem = {
    id: identity.id,
    url: identity.url,
    title: primary.title,
    summary,
    sourceId: source.id,
    sourceName: source.name,
    via: twins.map((d) => d.source.id),
    publisher: who.publisher,
    publisherName: who.publisherName,
    kind: source.kind,
    scope: source.scope,
    home: source.home,
    tier: unvetted ? 4 : source.tier,
    publishedAt: times.publishedAt,
    firstSeenAt: times.firstSeenAt,
    effectiveAt: times.effectiveAt,
    flags: flagsFor(source, identity.url),
    tags: unvetted ? [...source.tags, UNVETTED_OUTLET_TAG] : [...source.tags],
    routing: source.routing,
    routeTo: source.routeTo ? [...source.routeTo] : null,
    leadEligible: unvetted ? false : source.leadEligible,
    countsForCoverage: unvetted ? false : source.countsForCoverage,
    // A title-credited outlet is shown like a link-host outlet (emit writes ArticleV2.pub for "link-host" only).
    attribution: primary.titleOutlet ? "link-host" : source.attribution,
  };
  // The link is still the feed's wrapper: record the outlet's host (NormalizedItem.outletHost) so a
  // source's excludeUrl / includeUrl can see it (relevance/rules.ts); without it URL rules did nothing
  // until the wrapper was resolved.
  const outletHost = source.attribution === "link-host" && onFeedHost(identity.url, source) ? bareHost(raw.itemPublisherUrl) : null;
  if (outletHost) item.outletHost = outletHost;
  if (formerIds.length) item.formerIds = formerIds;
  if (source.maxAgeExplicit) item.maxAgeDays = source.maxAgeDays;
  if (primary.synthesizedTitle) item.synthesizedTitle = true;
  if (raw.carried) item.carried = true;
  return item;
}

export const normalize: Normalize = (raw, registry, ctx) => {
  const { sources, publishers } = indexRegistry(registry);
  const dropped: DroppedItem[] = [];

  const drafts: Draft[] = [];
  const unreadDates = new Map<string, { count: number; sample: string }>();
  raw.forEach((item, order) => {
    const result = toDraft(item, order, sources.get(item.sourceId), publishers);
    if ("reason" in result) {
      dropped.push(result);
      return;
    }
    const date = parseDate(item.publishedRaw, ctx.now);
    if (date === null && typeof item.publishedRaw === "string" && item.publishedRaw.trim()) {
      const seen = unreadDates.get(item.sourceId);
      if (seen) seen.count++;
      else unreadDates.set(item.sourceId, { count: 1, sample: sanitizeText(item.publishedRaw).slice(0, 60) });
    }
    drafts.push({ ...result, date });
  });
  // A date the parser cannot read is silent otherwise: the item is dated by first sight, and on a
  // source's first build its whole listing ages out as back catalogue (fca-news, "... 2026 - 17:19").
  const unread = [...unreadDates];
  for (const [sourceId, { count, sample }] of unread.slice(0, MAX_DATE_WARNINGS)) {
    ctx.log("warn", `normalize: ${sourceId}: ${count} item(s) carry a date the parser cannot read (e.g. "${sample}"); dated by first sight instead`);
  }
  if (unread.length > MAX_DATE_WARNINGS) ctx.log("warn", `normalize: ${unread.length - MAX_DATE_WARNINGS} more source(s) with unreadable dates`);

  const collapsed = collapseReleases(drafts, ctx.now, dropped);
  const unique = dedupeWithinSource(collapsed);
  for (const d of unique.dropped) dropped.push(drop(d.draft.raw, d.draft.identity.id, d.draft.identity.url, d.draft.title, "duplicate", d.detail));

  const groups = foldTwins(unique.kept);
  const items = groups.map((g) => toItem(g, publishers, ctx));

  const counts = new Map<DropReason, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const folded = groups.reduce((n, g) => n + g.twins.length, 0);
  const reasons = [...counts].map(([reason, n]) => `${reason} ${n}`).join(", ") || "none";
  ctx.log("info", `normalize: ${raw.length} raw -> ${items.length} items (${folded} same-URL twins folded; dropped: ${reasons})`);
  return { items, dropped };
};
