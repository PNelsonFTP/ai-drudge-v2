// Registry-driven extractors for sources without a feed. Pure (HTML / JSON text in, cards out).
//
//   extractHtmlLinks(html, ScrapeConfig, pageUrl)   "html-links": listing page -> article cards
//   extractJsonApi(text, JsonApiConfig, apiUrl)     "json-api":   JSON response -> items
//
// The html-links extractor works on structure, not on one regex per site:
//   1. every <a> whose href PATH matches ScrapeConfig.linkPattern is a candidate (attribute order,
//      quoting and relative forms do not matter); anchors are grouped by resolved URL;
//   2. the title is the best of: heading inside / around the link, the link text, aria-label, img alt
//      (a link that only says "Read post" takes the heading / name field of its card);
//   3. the CARD of a link is the largest enclosing element that contains no other article link
//      (short weaker labels such as category chips aside) - the date and a summary paragraph are read from the card,
//      wherever they sit relative to the link. Explicit date markup (<time>, a date field) is always
//      honoured; dateHint "time" additionally accepts date attributes and date text;
//   4. not posts, so dropped: weaker links inside another article's card and short heading-less
//      labels on a listing of headed cards (category chips such as /news/announcements), and on a
//      dated listing links without any date (navigation, evergreen pages);
//   5. newest-first, then the item cap.

import { bareHost } from "../../../shared/url";
import type { JsonApiConfig, ScrapeConfig } from "../../registry/types";
import { resolveHttpUrl, type FeedEntry } from "./feedParser";
import { ancestors, findAll, findFirst, parseHtml, textOf, type El } from "./html";
import { capSummary, capText, newestFirst, RAW_TITLE_MAX } from "./newest";

export type ScrapedCard = FeedEntry;

export interface ScrapeResult {
  /** Cards after label / undated filtering, newest first, capped. */
  cards: ScrapedCard[];
  /** Distinct article links that matched linkPattern (before filtering and the cap). */
  matched: number;
  /** Matched links dropped: no title, label link, or undated on a dated listing. */
  dropped: number;
  /** Cards (before the cap) that carry a date. */
  dated: number;
}

// ------------------------------------------------------------------------------------------------
// Dates in page text
// ------------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAME = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_FIRST = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?,?\\s+(\\d{4})\\b`, "i");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/;

function ymd(year: number, month: number, day: number): string | null {
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Find a date in free text: ISO stamps pass through unchanged; "Nov 16, 2026", "October 01, 2026",
 * "Dec. 3, 2025" and "16 November 2026" become a date-only "YYYY-MM-DD" (normalize reads date-only
 * stamps as that day 12:00 UTC, so a scraped post is not treated as published at midnight).
 */
export function findDateInText(text: string | null | undefined): string | null {
  if (!text) return null;
  const iso = ISO_DATE.exec(text);
  if (iso && ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return iso[0];
  const mf = MONTH_FIRST.exec(text);
  if (mf) return ymd(Number(mf[3]), MONTHS[mf[1].slice(0, 3).toLowerCase()], Number(mf[2]));
  const df = DAY_FIRST.exec(text);
  if (df) return ymd(Number(df[3]), MONTHS[df[2].slice(0, 3).toLowerCase()], Number(df[1]));
  return null;
}

const TIME_TAGS = new Set(["time", "relative-time", "local-time", "time-ago"]);
const DATE_ATTRS = ["datetime", "title", "data-date", "data-datetime", "content"];

function isDateField(el: El): boolean {
  for (const [name, value] of Object.entries(el.attrs)) {
    if (name === "class" || name === "itemprop" || name.startsWith("fs-") || name.startsWith("data-")) {
      if (/(?:^|[\s_-])(?:date|datepublished|published|posted)(?:$|[\s_-])/i.test(value)) return true;
    }
  }
  return false;
}

/**
 * The date of a card. Explicit markup first: <time datetime>, then an element marked as a date field.
 * With `loose` (ScrapeConfig.dateHint "time") also date-bearing attributes and any date in the card's
 * text; without it only the explicit markup counts, so a page declared date-less cannot pick up a
 * date from prose.
 */
function findDate(card: El, loose: boolean): string | null {
  const times = [card, ...findAll(card, () => true)].filter((el) => TIME_TAGS.has(el.tag));
  for (const el of times) {
    const d = findDateInText(el.attrs.datetime) ?? findDateInText(textOf(el));
    if (d) return d;
  }
  for (const el of findAll(card, isDateField)) {
    const d = findDateInText(textOf(el));
    if (d) return d;
  }
  if (!loose) return null;
  for (const el of [card, ...findAll(card, () => true)]) {
    for (const name of DATE_ATTRS) {
      const d = findDateInText(el.attrs[name]);
      if (d) return d;
    }
  }
  return findDateInText(textOf(card, (el) => /^h[1-6]$/.test(el.tag), true));
}

// ------------------------------------------------------------------------------------------------
// Titles
// ------------------------------------------------------------------------------------------------

const HEADING = /^h[1-6]$/;
const CTA = /^(?:read(?: more| on| post| article| the (?:post|article|paper|story))?|learn more|more|continue reading|view(?: all| post| article)?|see (?:more|all)|details|open|link)\b[\s→»›>.]*$/i;

interface TitleCandidate {
  text: string;
  /** 3 heading, 2.5 title field inside the link, 2 link text, 1 label attribute / image alt. */
  quality: number;
}

function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function isTitleField(el: El): boolean {
  for (const [name, value] of Object.entries(el.attrs)) {
    if (name === "class" || name === "itemprop" || name.startsWith("fs-") || name.startsWith("data-")) {
      if (/(?:^|[\s_-])(?:name|title|headline)(?:$|[\s_-])/i.test(value)) return true;
    }
  }
  return false;
}

function titleOf(anchor: El, hint: string): TitleCandidate | null {
  const out: TitleCandidate[] = [];
  const add = (raw: string | undefined, quality: number): void => {
    const t = clean(raw);
    if (t && !CTA.test(t)) out.push({ text: t, quality });
  };
  const headingTag = HEADING.test(hint) ? hint : null;
  const inner = findFirst(anchor, (el) => (headingTag ? el.tag === headingTag : HEADING.test(el.tag))) ?? findFirst(anchor, (el) => HEADING.test(el.tag));
  if (inner) add(textOf(inner), 3);
  // A card-sized link without a heading often marks its title: <div class="feature-title">, [fs-list-field=name].
  const field = inner ? null : findFirst(anchor, (el) => isTitleField(el) && clean(textOf(el)).length <= 300);
  if (field) add(textOf(field), 2.5);
  const linkText = textOf(anchor);
  const wrappedByHeading = ancestors(anchor).slice(0, 3).some((el) => HEADING.test(el.tag));
  // A link that is a whole card (no heading inside) carries date / teaser text too: such text is too long to be a title.
  if (linkText.length <= 300) add(linkText, wrappedByHeading ? 3 : 2);
  add(anchor.attrs["aria-label"]?.replace(/^(?:read(?: more)?(?: about)?|view|open|go to)[\s:]+/i, ""), 1);
  const img = findFirst(anchor, (el) => el.tag === "img" && Boolean(clean(el.attrs.alt)));
  if (img) add(img.attrs.alt, 1);
  add(anchor.attrs.title, 1);
  if (out.length === 0) return null;

  const preferred = hint === "aria-label" ? clean(anchor.attrs["aria-label"]) : hint === "img alt" ? clean(img?.attrs.alt) : hint === "text" ? linkText : "";
  const byHint = preferred ? out.find((c) => c.text === preferred || preferred.endsWith(c.text)) : undefined;
  return byHint ?? out.reduce((best, c) => (c.quality > best.quality ? c : best));
}

/**
 * Title of a card whose link only says "Read post" / "Read on": the card's heading, else an element
 * marked as the name / title field (<p fs-list-field="name">).
 */
function cardTitle(card: El, hint: string): TitleCandidate | null {
  const headingTag = HEADING.test(hint) ? hint : null;
  const heading = (headingTag ? findFirst(card, (el) => el.tag === headingTag) : null) ?? findFirst(card, (el) => HEADING.test(el.tag));
  const fromHeading = heading ? clean(textOf(heading)) : "";
  if (fromHeading && !CTA.test(fromHeading)) return { text: fromHeading, quality: 3 };
  const field = findFirst(card, (el) => isTitleField(el) && clean(textOf(el)).length > 0 && clean(textOf(el)).length <= 300);
  const fromField = field ? clean(textOf(field)) : "";
  return fromField && !CTA.test(fromField) ? { text: fromField, quality: 2 } : null;
}

// ------------------------------------------------------------------------------------------------
// html-links
// ------------------------------------------------------------------------------------------------

/** linkPattern is matched against the WHOLE path: an unanchored source is anchored here. */
export function compileLinkPattern(source: string): RegExp {
  const anchored = source.startsWith("^") || source.endsWith("$");
  return new RegExp(anchored ? source : `^(?:${source})/?$`);
}

const CARD_STOP = new Set(["#root", "html", "body", "main"]);
/** Heading-less link labels up to this many words are chips on a listing of headed cards. */
const CHIP_MAX_WORDS = 3;
/** A "card" larger than this is a page region, not a card. */
const MAX_CARD_CHARS = 150_000;

interface Group {
  url: string;
  anchors: El[];
  title: TitleCandidate | null;
  /** The anchor the title came from (its card is searched first). */
  titleAnchor: El | null;
}

function resolveHref(href: string, cfg: ScrapeConfig, pageUrl: string): URL | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  // Root-relative links resolve against the configured origin, everything else against the page.
  const abs = resolveHttpUrl(raw, raw.startsWith("/") && !raw.startsWith("//") ? cfg.base : pageUrl);
  if (!abs) return null;
  try {
    return new URL(abs);
  } catch {
    return null;
  }
}

export interface ExtractOptions {
  /** Cap on returned cards (default ScrapeConfig.maxItems, else 15). */
  maxItems?: number;
  /** Build clock in ms, for the newest-first order. */
  nowMs: number;
}

export function extractHtmlLinks(html: string, cfg: ScrapeConfig, pageUrl: string, opts: ExtractOptions): ScrapeResult {
  const pattern = compileLinkPattern(cfg.linkPattern);
  const hint = clean(cfg.titleSelectorHint).toLowerCase();
  const root = parseHtml(html);
  const siteHosts = new Set([bareHost(cfg.base), bareHost(pageUrl)]);

  // 1. candidate anchors, grouped by resolved URL
  const groups = new Map<string, Group>();
  const groupOf = new Map<El, Group>();
  for (const a of findAll(root, (el) => el.tag === "a" && typeof el.attrs.href === "string")) {
    const href = a.attrs.href.replace(/&amp;/g, "&");
    const u = resolveHref(href, cfg, pageUrl);
    if (!u || !siteHosts.has(u.hostname.replace(/^www\./, ""))) continue;
    if (!pattern.test(u.pathname) && !pattern.test(href.trim())) continue;
    u.hash = "";
    let g = groups.get(u.href);
    if (!g) {
      g = { url: u.href, anchors: [], title: null, titleAnchor: null };
      groups.set(u.href, g);
    }
    g.anchors.push(a);
    groupOf.set(a, g);
  }

  // 2. best title per link
  const untitled = new Set<El>();
  for (const g of groups.values()) {
    for (const a of g.anchors) {
      const t = titleOf(a, hint);
      if (!t) untitled.add(a);
      if (t && (!g.title || t.quality > g.title.quality)) {
        g.title = t;
        g.titleAnchor = a;
      }
    }
  }
  const quality = (g: Group): number => g.title?.quality ?? 0;

  // 3. which article links live under each element -> the card of a link
  const under = new Map<El, Set<Group>>();
  for (const [a, g] of groupOf) {
    for (const el of [a, ...ancestors(a)]) {
      let set = under.get(el);
      if (!set) under.set(el, (set = new Set()));
      set.add(g);
    }
  }
  const shortLabel = (g: Group): boolean => g.title !== null && g.title.text.split(/\s+/).length <= CHIP_MAX_WORDS;
  // A satellite of g is a weaker link with a short label (category chip, "Blog" tag) - it may share g's
  // card. Every other article link is a rival: the card ends where the next one begins.
  const satelliteOf = (other: Group, g: Group): boolean => quality(other) < quality(g) && shortLabel(other);
  const cardOf = (a: El, g: Group): El => {
    let card = a;
    for (let p = a.parent; p && !CARD_STOP.has(p.tag) && p.end - p.start <= MAX_CARD_CHARS; p = p.parent) {
      const rivals = [...(under.get(p) ?? [])].some((other) => other !== g && !satelliteOf(other, g));
      if (rivals) break;
      card = p;
    }
    return card;
  };

  // An anchor that is only a call to action ("Read post", "Read on") has its title elsewhere in the
  // card: the NEAREST enclosing element with a heading / name field, so a hero card yields its own
  // headline and not the page's <h1>. Used when it beats what the link's other anchors offered.
  for (const g of groups.values()) {
    if (quality(g) >= 3) continue;
    for (const a of g.anchors) {
      if (!untitled.has(a)) continue;
      const card = cardOf(a, g);
      let t: TitleCandidate | null = null;
      for (let el: El | null = a.parent; el && !t; el = el === card ? null : el.parent) t = cardTitle(el, hint);
      if (t && t.quality > quality(g)) {
        g.title = t;
        g.titleAnchor = a;
      }
    }
  }

  // On a listing whose cards have heading titles, a matching link with a short heading-less label is
  // a category chip or navigation ("/news/features" -> "Features"), not a post.
  const headed = [...groups.values()].filter((g) => quality(g) >= 3).length;
  const isChip = (g: Group): boolean => quality(g) < 3 && shortLabel(g);
  const chips = new Set<Group>(headed >= groups.size / 2 ? [...groups.values()].filter(isChip) : []);

  const cards = new Map<Group, El[]>();
  for (const g of groups.values()) {
    const ordered = g.titleAnchor ? [g.titleAnchor, ...g.anchors.filter((a) => a !== g.titleAnchor)] : g.anchors;
    cards.set(g, ordered.map((a) => cardOf(a, g)));
  }

  // 4. label links: weaker links sitting inside another article's card
  const labels = new Set<Group>();
  for (const [g, els] of cards) {
    for (const card of els) {
      for (const other of under.get(card) ?? []) if (other !== g && satelliteOf(other, g)) labels.add(other);
    }
  }

  // 5. build cards
  const built: ScrapedCard[] = [];
  let dropped = 0;
  for (const g of groups.values()) {
    if (!g.title || labels.has(g) || chips.has(g)) {
      dropped++;
      continue;
    }
    const els = cards.get(g) ?? [];
    let date: string | null = null;
    for (const card of els) {
      date = findDate(card, cfg.dateHint === "time");
      if (date) break;
    }
    let summary: string | null = null;
    for (const card of els) {
      const p = findFirst(card, (el) => el.tag === "p" && textOf(el).length >= 40 && textOf(el) !== g.title?.text && findDateInText(textOf(el)) === null);
      if (p) {
        summary = capSummary(textOf(p), 600);
        break;
      }
    }
    built.push({ title: capText(g.title.text, RAW_TITLE_MAX), link: g.url, publishedRaw: date, summaryHtml: summary });
  }

  // On a dated listing an undated link is navigation or an evergreen page, not a post.
  let kept = built;
  const datedCount = built.filter((c) => c.publishedRaw !== null).length;
  if (cfg.dateHint === "time" && built.length > 0 && datedCount >= built.length / 2) {
    kept = built.filter((c) => c.publishedRaw !== null);
    dropped += built.length - kept.length;
  }
  const max = opts.maxItems ?? cfg.maxItems ?? 15;
  return { cards: newestFirst(kept, opts.nowMs).slice(0, max), matched: groups.size, dropped, dated: kept.filter((c) => c.publishedRaw !== null).length };
}

// ------------------------------------------------------------------------------------------------
// json-api
// ------------------------------------------------------------------------------------------------

function dig(value: unknown, path: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const scalar = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** ISO strings pass through; epoch seconds / milliseconds become ISO. */
function jsonDate(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v < 1e11 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `template` with every {dot.path} filled from `item`; null when a placeholder has no value (never a half-built URL). */
function fillUrlTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const url = template.replace(/\{([^{}]+)\}/g, (_m, field: string) => {
    const value = scalar(dig(item, field));
    if (!value) missing = true;
    return value ?? "";
  });
  return missing ? null : url;
}

export type JsonApiResult = { ok: true; cards: ScrapedCard[]; total: number; skipped: number } | { ok: false; error: "parse" | "empty"; detail: string };

export function extractJsonApi(text: string, cfg: JsonApiConfig, apiUrl: string, opts: ExtractOptions): JsonApiResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: "parse", detail: `invalid JSON: ${e instanceof Error ? e.message.slice(0, 120) : "?"}` };
  }
  const items = dig(doc, cfg.itemsPath);
  if (!Array.isArray(items)) return { ok: false, error: "parse", detail: `no array at "${cfg.itemsPath || "(root)"}"` };

  const cards: ScrapedCard[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of items) {
    try {
      const title = scalar(dig(item, cfg.titleField));
      // The item's own URL field first; the template is the fallback when the field is empty (an HN
      // text post has url: null and is linked to its thread) and the only route when no field is set.
      const rawUrl = (cfg.urlField ? scalar(dig(item, cfg.urlField)) : null) || (cfg.urlTemplate ? fillUrlTemplate(cfg.urlTemplate, item) : null);
      const link = resolveHttpUrl(rawUrl, apiUrl);
      if (!title || !link || seen.has(link)) {
        skipped++;
        continue;
      }
      seen.add(link);
      const summary = cfg.summaryField ? scalar(dig(item, cfg.summaryField)) : null;
      cards.push({
        title: capText(title, RAW_TITLE_MAX),
        link,
        publishedRaw: cfg.dateField ? jsonDate(dig(item, cfg.dateField)) : null,
        summaryHtml: summary ? capSummary(summary) : null,
      });
    } catch {
      skipped++;
    }
  }
  if (cards.length === 0) return { ok: false, error: "empty", detail: items.length === 0 ? "API returned no items" : `${items.length} items, none usable` };
  const max = opts.maxItems ?? 15;
  return { ok: true, cards: newestFirst(cards, opts.nowMs).slice(0, max), total: items.length, skipped };
}
