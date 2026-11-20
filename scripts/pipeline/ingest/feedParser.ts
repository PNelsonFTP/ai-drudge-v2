// Body -> entries for RSS 2.0, Atom 1.0, RDF (RSS 1.0) and JSON Feed 1.x. Pure, never throws.
// Shared by the ingest stage and scripts/tools/validate-feeds.ts so validation and production agree.
//
// What it guarantees per entry: a non-empty title (length-capped, raw) and an ABSOLUTE http(s) link
// (relative links resolved against xml:base / the feed URL; guid / <id> fallback; every other scheme
// dropped). Text is NOT cleaned and dates are NOT parsed - that is normalize's job.
//
// Outcomes: a recognised feed with >= 1 usable entry is ok; a recognised feed without entries is
// "empty" (never ok); an HTML page or unknown document is "not_feed"; broken XML / JSON is "parse".

import { XMLParser } from "fast-xml-parser";
import { isHttpUrl } from "../../../shared/url";
import { capSummary, capText, MAX_CATEGORIES, RAW_FIELD_MAX, RAW_TITLE_MAX } from "./newest";

export type FeedFormat = "rss" | "atom" | "rdf" | "json";

/** One feed entry, raw. Structurally a RawItem without sourceId / carried. */
export interface FeedEntry {
  title: string;
  link: string;
  publishedRaw: string | null;
  summaryHtml: string | null;
  comments?: string;
  itemPublisher?: string;
  itemPublisherUrl?: string;
  guid?: string;
  categories?: string[];
}

export interface ParsedFeed {
  ok: true;
  format: FeedFormat;
  /** Usable entries in document order. */
  entries: FeedEntry[];
  /** Items / entries found in the document. */
  total: number;
  /** Items dropped as malformed (no title, no http link, per-item error). */
  skipped: number;
}

export interface FeedFailure {
  ok: false;
  error: "not_feed" | "parse" | "empty";
  detail: string;
  format?: FeedFormat;
  total: number;
  skipped: number;
}

export type FeedParseResult = ParsedFeed | FeedFailure;

export interface ParseFeedOptions {
  /** URL the body came from (after redirects) - the base for relative links. */
  feedUrl: string;
  /** Prefer <content> over <summary> / <description> (GitHub release feeds keep the changelog there). */
  preferContent?: boolean;
}

// processEntities: true with the library's own limits (no lowered caps - V1's maxTotalExpansions made
// large release feeds fail for a month). The limits that remain are the entity-bomb guard.
// parseTagValue: false keeps titles such as "2027", "1.0" and "007" as strings.
const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

// Second parser, used only for Atom type="xhtml" text constructs where element order matters.
const ORDERED_PARSER = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: true,
  preserveOrder: true,
  trimValues: false,
});

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const localName = (key: string): string => key.slice(key.indexOf(":") + 1);

/** Text of a parsed node: a string, a { "#text" } object (element with attributes), or the first of an array. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = text(x);
      if (t) return t;
    }
    return null;
  }
  if (isObj(v)) {
    const t = v["#text"];
    if (typeof t === "string" || typeof t === "number") return String(t).trim() || null;
  }
  return null;
}

/** All text below a node, in key order (fallback for nested markup when the ordered parse is unavailable). */
function deepText(v: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((x) => deepText(x, depth + 1)).join(" ");
  if (!isObj(v)) return "";
  const parts: string[] = [];
  for (const [k, child] of Object.entries(v)) {
    if (k.startsWith("@_")) continue;
    parts.push(deepText(child, depth + 1));
  }
  return parts.join(" ");
}

function firstText(...vals: unknown[]): string | null {
  for (const v of vals) {
    const t = text(v);
    if (t) return t;
  }
  return null;
}

function attr(v: unknown, name: string): string | null {
  if (!isObj(v)) return null;
  const a = v[`@_${name}`];
  return typeof a === "string" && a.trim() ? a.trim() : null;
}

/** Resolve a link against the base and keep it only when the result is an absolute http(s) URL. */
export function resolveHttpUrl(raw: string | null | undefined, base: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 4096) return null;
  if (isHttpUrl(s)) return s;
  // Anything with another scheme (javascript:, data:, mailto:, ftp:, urn:) is dropped, never resolved.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return null;
  try {
    const abs = new URL(s, base).href;
    return isHttpUrl(abs) ? abs : null;
  } catch {
    return null;
  }
}

function resolveBase(xmlBase: string | null, parent: string): string {
  if (!xmlBase) return parent;
  return resolveHttpUrl(xmlBase, parent) ?? parent;
}

function categoriesOf(...vals: unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const v of vals) {
    for (const c of asArray(v)) {
      const label = attr(c, "term") ?? attr(c, "label") ?? text(c);
      if (label && !out.includes(label)) out.push(capText(label, 80));
      if (out.length >= MAX_CATEGORIES) return out;
    }
  }
  return out.length ? out : undefined;
}

function summaryOf(preferContent: boolean, short: unknown[], long: unknown[]): string | null {
  const raw = preferContent ? firstText(...long, ...short) : firstText(...short, ...long);
  if (!raw) return null;
  const capped = capSummary(raw);
  return capped || null;
}

/** Build an entry or return null when the item has no usable title / link. */
function makeEntry(fields: {
  title: string | null;
  link: string | null;
  publishedRaw: string | null;
  summaryHtml: string | null;
  comments?: string | null;
  itemPublisher?: string | null;
  itemPublisherUrl?: string | null;
  guid?: string | null;
  categories?: string[];
}): FeedEntry | null {
  const title = fields.title ? capText(fields.title.replace(/\s+/g, " ").trim(), RAW_TITLE_MAX) : "";
  if (!title || !fields.link) return null;
  const entry: FeedEntry = {
    title,
    link: fields.link,
    publishedRaw: fields.publishedRaw ? capText(fields.publishedRaw, 100) : null,
    summaryHtml: fields.summaryHtml,
  };
  if (fields.comments) entry.comments = fields.comments;
  if (fields.itemPublisher) entry.itemPublisher = capText(fields.itemPublisher, RAW_FIELD_MAX);
  if (fields.itemPublisherUrl) entry.itemPublisherUrl = fields.itemPublisherUrl;
  if (fields.guid && fields.guid !== fields.link) entry.guid = capText(fields.guid, 500);
  if (fields.categories) entry.categories = fields.categories;
  return entry;
}

// ------------------------------------------------------------------------------------------------
// RSS 2.0 / RDF
// ------------------------------------------------------------------------------------------------

function rssLink(item: Obj, base: string): string | null {
  const candidates: (string | null)[] = [];
  for (const l of asArray(item.link)) candidates.push(attr(l, "href") ?? text(l));
  const guid = item.guid;
  const guidText = text(guid);
  // A guid is a permalink unless it says otherwise - but only an http(s) guid can stand in for a link.
  if (guidText && attr(guid, "isPermaLink")?.toLowerCase() !== "false" && /^https?:\/\//i.test(guidText)) candidates.push(guidText);
  candidates.push(text(item["feedburner:origLink"]), attr(item, "rdf:about"));
  for (const l of asArray(item["atom:link"])) {
    const rel = attr(l, "rel");
    if (!rel || rel === "alternate") candidates.push(attr(l, "href"));
  }
  for (const c of candidates) {
    const url = resolveHttpUrl(c, base);
    if (url) return url;
  }
  return null;
}

function rssEntry(item: Obj, base: string, opts: ParseFeedOptions): FeedEntry | null {
  const itemBase = resolveBase(attr(item, "xml:base"), base);
  const source = item.source;
  return makeEntry({
    title: firstText(item.title, item["dc:title"]) ?? flatten(item.title),
    link: rssLink(item, itemBase),
    publishedRaw: firstText(item.pubDate, item["dc:date"], item.published, item.updated, item.date),
    summaryHtml: summaryOf(Boolean(opts.preferContent), [item.description, item.summary], [item["content:encoded"], item.content]),
    comments: resolveHttpUrl(text(item.comments), itemBase),
    itemPublisher: text(source),
    itemPublisherUrl: resolveHttpUrl(attr(source, "url"), itemBase),
    guid: text(item.guid),
    categories: categoriesOf(item.category, item["dc:subject"]),
  });
}

// ------------------------------------------------------------------------------------------------
// Atom
// ------------------------------------------------------------------------------------------------

interface AtomLink {
  href: string;
  rel: string;
  type: string;
}

function atomLinks(v: unknown): AtomLink[] {
  const out: AtomLink[] = [];
  for (const l of asArray(v)) {
    const href = attr(l, "href") ?? (typeof l === "string" ? l.trim() : null);
    if (!href) continue;
    // No rel means "alternate" (RFC 4287 4.2.7.2).
    out.push({ href, rel: (attr(l, "rel") ?? "alternate").toLowerCase(), type: (attr(l, "type") ?? "").toLowerCase() });
  }
  return out;
}

/** The article link of an entry: rel=alternate (HTML first); never replies / enclosure / self / edit. */
function atomLink(links: AtomLink[], id: string | null, base: string): string | null {
  const alternates = links.filter((l) => l.rel === "alternate");
  const ordered = [...alternates.filter((l) => !l.type || l.type.includes("html")), ...alternates];
  for (const l of ordered) {
    const url = resolveHttpUrl(l.href, base);
    if (url) return url;
  }
  return id && /^https?:\/\//i.test(id) ? resolveHttpUrl(id, base) : null;
}

function flatten(v: unknown): string | null {
  const t = deepText(v).replace(/\s+/g, " ").trim();
  return t || null;
}

function atomEntry(entry: Obj, get: (o: Obj, name: string) => unknown, base: string, opts: ParseFeedOptions, orderedTitle: string | null): FeedEntry | null {
  const entryBase = resolveBase(attr(entry, "xml:base"), base);
  const links = atomLinks(get(entry, "link"));
  const id = text(get(entry, "id"));
  const titleNode = get(entry, "title");
  const replies = links.find((l) => l.rel === "replies" && (!l.type || l.type.includes("html")));
  return makeEntry({
    title: orderedTitle ?? text(titleNode) ?? flatten(titleNode),
    link: atomLink(links, id, entryBase),
    publishedRaw: firstText(get(entry, "published"), get(entry, "updated"), entry["dc:date"]),
    summaryHtml: summaryOf(Boolean(opts.preferContent), [get(entry, "summary")], [get(entry, "content")]) ?? flatten(get(entry, "summary")),
    comments: replies ? resolveHttpUrl(replies.href, entryBase) : null,
    guid: id,
    categories: categoriesOf(get(entry, "category")),
  });
}

/** Ordered text of every entry title, for feeds that use type="xhtml" titles (element order matters there). */
function orderedAtomTitles(body: string): (string | null)[] {
  type Node = Record<string, unknown>;
  const textOf = (nodes: unknown): string => {
    let s = "";
    for (const n of asArray(nodes)) {
      if (!isObj(n)) continue;
      for (const [k, v] of Object.entries(n)) {
        if (k === ":@") continue;
        s += k === "#text" ? String(v) : textOf(v);
      }
    }
    return s;
  };
  const children = (nodes: unknown, name: string): Node[][] => {
    const out: Node[][] = [];
    for (const n of asArray(nodes)) {
      if (!isObj(n)) continue;
      for (const [k, v] of Object.entries(n)) if (k !== ":@" && localName(k) === name && Array.isArray(v)) out.push(v as Node[]);
    }
    return out;
  };
  try {
    const doc: unknown = ORDERED_PARSER.parse(body);
    const feed = children(doc, "feed")[0];
    if (!feed) return [];
    return children(feed, "entry").map((entry) => {
      const title = children(entry, "title")[0];
      const t = title ? textOf(title).replace(/\s+/g, " ").trim() : "";
      return t || null;
    });
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------------
// JSON Feed 1.x
// ------------------------------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function jsonEntry(item: Obj, base: string, opts: ParseFeedOptions): FeedEntry | null {
  const id = typeof item.id === "number" ? String(item.id) : str(item.id);
  const link = [str(item.url), str(item.external_url), id && /^https?:\/\//i.test(id) ? id : null].map((c) => resolveHttpUrl(c, base)).find((u) => u !== null) ?? null;
  return makeEntry({
    title: str(item.title),
    link,
    publishedRaw: str(item.date_published) ?? str(item.date_modified),
    summaryHtml: summaryOf(Boolean(opts.preferContent), [item.summary], [item.content_html, item.content_text]),
    guid: id,
    categories: categoriesOf(asArray(item.tags).filter((t) => typeof t === "string")),
  });
}

function parseJsonFeed(body: string, opts: ParseFeedOptions): FeedParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: "parse", detail: `invalid JSON: ${e instanceof Error ? e.message.slice(0, 120) : "?"}`, total: 0, skipped: 0 };
  }
  if (!isObj(doc) || !Array.isArray(doc.items) || !(typeof doc.version === "string" && /jsonfeed\.org\/version\/1/i.test(doc.version))) {
    return { ok: false, error: "not_feed", detail: "JSON document is not a JSON Feed (no version / items)", total: 0, skipped: 0 };
  }
  const base = resolveHttpUrl(str(doc.home_page_url), opts.feedUrl) ?? opts.feedUrl;
  return collect("json", doc.items, (item) => jsonEntry(item, base, opts));
}

// ------------------------------------------------------------------------------------------------
// Dispatch
// ------------------------------------------------------------------------------------------------

/** Run the per-item builder with isolation: one malformed item is counted, never fatal. */
function collect(format: FeedFormat, rawItems: unknown[], build: (item: Obj, index: number) => FeedEntry | null): FeedParseResult {
  const entries: FeedEntry[] = [];
  let skipped = 0;
  rawItems.forEach((raw, index) => {
    try {
      const entry = isObj(raw) ? build(raw, index) : null;
      if (entry) entries.push(entry);
      else skipped++;
    } catch {
      skipped++;
    }
  });
  const total = rawItems.length;
  if (entries.length === 0) {
    const detail = total === 0 ? "feed has no items" : `${total} item${total === 1 ? "" : "s"}, none usable (no title or no http link)`;
    return { ok: false, error: "empty", detail, format, total, skipped };
  }
  return { ok: true, format, entries, total, skipped };
}

export type BodyKind = "xml" | "json" | "html" | "unknown";

/** What the body looks like, judged by the body itself - Content-Type lies in both directions. */
export function sniffBody(body: string): BodyKind {
  const head = body.slice(0, 2000).replace(/^﻿/, "").trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  // Skip the XML declaration, comments, processing instructions and a DOCTYPE to reach the root element.
  const afterProlog = head.replace(/^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s+)*/i, "");
  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(afterProlog)) return "html";
  if (/^<(?:[\w.-]+:)?(?:rss|feed|RDF)[\s>]/.test(afterProlog)) return "xml";
  if (/^<\?xml/i.test(head)) return "xml";
  if (/^<(?:head|body|script|meta|title|div|p)[\s>]/i.test(afterProlog)) return "html";
  return afterProlog.startsWith("<") ? "xml" : "unknown";
}

function parseXmlFeed(body: string, opts: ParseFeedOptions): FeedParseResult {
  let doc: unknown;
  try {
    doc = PARSER.parse(body);
  } catch (e) {
    return { ok: false, error: "parse", detail: `XML parse failed: ${e instanceof Error ? e.message.slice(0, 160) : "?"}`, total: 0, skipped: 0 };
  }
  if (!isObj(doc)) return { ok: false, error: "not_feed", detail: "document has no root element", total: 0, skipped: 0 };

  // Root detection by LOCAL name so a prefixed root (<atom:feed>, <rss:rss>) is recognised.
  const rootKey = Object.keys(doc).find((k) => ["rss", "feed", "RDF"].includes(localName(k)) && isObj(doc[k]));
  if (!rootKey) {
    const seen = Object.keys(doc).filter((k) => !k.startsWith("?")).slice(0, 3).join(", ") || "none";
    return { ok: false, error: "not_feed", detail: `root element is not rss / feed / rdf (${seen})`, total: 0, skipped: 0 };
  }
  const root = doc[rootKey] as Obj;
  const prefix = rootKey.includes(":") ? rootKey.slice(0, rootKey.indexOf(":") + 1) : "";
  const rootBase = resolveBase(attr(root, "xml:base"), opts.feedUrl);

  switch (localName(rootKey)) {
    case "rss": {
      const channel = isObj(root.channel) ? root.channel : isObj(root[`${prefix}channel`]) ? (root[`${prefix}channel`] as Obj) : null;
      if (!channel) return { ok: false, error: "not_feed", detail: "rss element without a channel", format: "rss", total: 0, skipped: 0 };
      const base = resolveBase(attr(channel, "xml:base"), rootBase);
      return collect("rss", asArray(channel.item), (item) => rssEntry(item, base, opts));
    }
    case "RDF": {
      // RSS 1.0: items are siblings of <channel>, not children.
      const items = asArray(root.item ?? root["rss:item"]);
      return collect("rdf", items, (item) => rssEntry(item, rootBase, opts));
    }
    default: {
      const get = (o: Obj, name: string): unknown => o[`${prefix}${name}`] ?? o[name];
      const rawEntries = asArray(get(root, "entry"));
      const isXhtmlTitle = (e: unknown): boolean => isObj(e) && attr(get(e, "title"), "type")?.toLowerCase() === "xhtml";
      const ordered = rawEntries.some(isXhtmlTitle) ? orderedAtomTitles(body) : [];
      const orderedTitle = (entry: Obj, i: number): string | null => (ordered.length === rawEntries.length && isXhtmlTitle(entry) ? ordered[i] : null);
      return collect("atom", rawEntries, (entry, i) => atomEntry(entry, get, rootBase, opts, orderedTitle(entry, i)));
    }
  }
}

/**
 * Parse a feed body. `feedUrl` should be the response URL after redirects.
 * Never throws; a body that is an HTML page (bot wall, SPA shell, error page) is "not_feed".
 */
export function parseFeed(body: string, opts: ParseFeedOptions): FeedParseResult {
  try {
    const kind = sniffBody(body);
    if (kind === "html") return { ok: false, error: "not_feed", detail: "HTML page, not a feed", total: 0, skipped: 0 };
    if (kind === "unknown") return { ok: false, error: "not_feed", detail: body.trim() ? "not XML or JSON" : "empty response body", total: 0, skipped: 0 };
    return kind === "json" ? parseJsonFeed(body, opts) : parseXmlFeed(body, opts);
  } catch (e) {
    return { ok: false, error: "parse", detail: `parser error: ${e instanceof Error ? e.message.slice(0, 160) : "?"}`, total: 0, skipped: 0 };
  }
}
