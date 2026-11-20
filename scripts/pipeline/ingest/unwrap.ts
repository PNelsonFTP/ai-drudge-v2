// Aggregator wrapper URLs -> the article they point at (pure half; the Google News network resolver
// is googleNews.ts). Unwrapping lets same-URL twins fold together and link-host attribution name the
// real outlet.
//
//   hnrss.org    <link> is usually the article; for text posts it is the HN thread and the real URL
//                (if any) is in the description ("Article URL: ...").
//   Google News  post-2024 feeds use news.google.com/rss/articles/CBMi... redirect ids; old-style
//                links carry the target in ?url=.
//   Techmeme     <link> is the techmeme.com permalink and the title ends in "(Author/Outlet)"; the
//                article URL and the outlet are in the description HTML (unwrapTechmeme).
//
// Unlike V1 nothing here canonicalises the result - that is normalize's job (shared/url canonicalUrl).

import { bareHost, isHttpUrl, parseHttpUrl } from "../../../shared/url";
import type { RawItem } from "../types";
import { capText, RAW_FIELD_MAX } from "./newest";

const HN_HOSTS = new Set(["news.ycombinator.com", "hnrss.org"]);
// The ?url= rewrite is honoured only on these hosts (V1 applied it to every URL with a `url` parameter).
const GOOGLE_REDIRECT_HOSTS = new Set(["news.google.com", "google.com"]);

export function isGoogleNewsUrl(url: string): boolean {
  return bareHost(url) === "news.google.com";
}

export function isHnDiscussionUrl(url: string): boolean {
  const u = parseHttpUrl(url);
  return u !== null && HN_HOSTS.has(u.host.replace(/^www\./, "")) && u.path.includes("/item");
}

function queryParam(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      return null;
    }
  }
  return null;
}

/** Target of a Google redirect link (?url=https://...), or null. */
export function urlFromQueryParam(raw: string): string | null {
  const u = parseHttpUrl(raw);
  if (!u || !GOOGLE_REDIRECT_HOSTS.has(u.host.replace(/^www\./, ""))) return null;
  const target = queryParam(u.query, "url");
  return target && isHttpUrl(target) && !isGoogleNewsUrl(target) ? target : null;
}

/** "Article URL: <a href=...>" from an hnrss description (attribute order and quote style agnostic). */
export function urlFromHnDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const html = /Article URL:\s*<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(description);
  const fromHtml = html?.[1] ?? html?.[2];
  if (fromHtml && isHttpUrl(fromHtml)) return fromHtml;
  const plain = /Article URL:\s*(https?:\/\/[^\s<>"']+)/i.exec(description)?.[1]?.replace(/[.)>,]+$/, "");
  return plain && isHttpUrl(plain) ? plain : null;
}

/**
 * Google News titles are "Headline - Publisher". Strip the suffix only when the feed names the
 * publisher (<source>), so legitimate dashes survive.
 */
export function stripGoogleNewsTitle(title: string, publisher: string | null | undefined): string {
  const src = (publisher ?? "").trim();
  if (!src) return title;
  const suffix = ` - ${src}`;
  return title.endsWith(suffix) && title.length > suffix.length + 8 ? title.slice(0, -suffix.length).trim() : title;
}

/** Synchronous unwrap: ?url= targets and hnrss "Article URL:". Returns the input when nothing applies. */
export function unwrapSync(rawUrl: string, extras?: { description?: string | null }): string {
  const fromQuery = urlFromQueryParam(rawUrl);
  if (fromQuery) return fromQuery;
  const host = bareHost(rawUrl) ?? "";
  if (isHnDiscussionUrl(rawUrl) || (extras?.description && HN_HOSTS.has(host))) {
    const fromDesc = urlFromHnDescription(extras?.description);
    if (fromDesc && !isHnDiscussionUrl(fromDesc)) return fromDesc;
  }
  return rawUrl;
}

/** Article id of a news.google.com/rss/articles/<id> wrapper (ids start with "CB"), or null. */
export function googleNewsArticleId(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u || u.host.replace(/^www\./, "") !== "news.google.com") return null;
  const parts = u.path.split("/").filter(Boolean);
  const id = parts[parts.length - 1] ?? "";
  return parts.includes("articles") && id.startsWith("CB") ? id : null;
}

/** Cache key of a wrapper URL in state.resolvedUrls: the wrapper without its tracking query. */
export function wrapperKey(url: string): string {
  const id = googleNewsArticleId(url);
  return id ? `https://news.google.com/rss/articles/${id}` : url;
}

// ------------------------------------------------------------------------------------------------
// Techmeme
// ------------------------------------------------------------------------------------------------
//
// One feed item (2026-11):
//
//   <title>Source: Iconiq invested more than $6B in Anthropic; ... (Richard Nieva/Forbes)</title>
//   <link>https://www.techmeme.com/261119/p56#a261119p56</link>
//   <description>
//     <A HREF="https://www.forbes.com/..."><IMG ...></A>
//     <P><A HREF="https://www.techmeme.com/261119/p56#a261119p56" TITLE="Techmeme permalink"><IMG ...></A>
//     Richard Nieva / <A HREF="http://www.forbes.com/">Forbes</A>:<BR>
//     <SPAN ...><B><A HREF="https://www.forbes.com/...">Source: Iconiq invested ...</A></B></SPAN> &mdash; ...
//   </description>
//
// The byline is "Author / <A>Outlet</A>:" or just "<A>Outlet</A>:", and the title tail accordingly
// "(Author/Outlet)" or "(Outlet)".

const TECHMEME_HOST = "techmeme.com";
const HREF = `\\bhref\\s*=\\s*(?:"([^"]*)"|'([^']*)')`;
/** The headline anchor: <B><A HREF="article">. */
const TECHMEME_HEADLINE = new RegExp(`<b>\\s*<a\\b[^>]*?${HREF}`, "i");
/** The outlet anchor of the byline: <A HREF="outlet home">Outlet</A>:<BR> */
const TECHMEME_BYLINE = new RegExp(`<a\\b[^>]*?${HREF}[^>]*>([^<]{1,120})</a>\\s*:\\s*<br\\b`, "i");

const attrValue = (raw: string | undefined): string => (raw ?? "").replace(/&amp;|&#0*38;|&#x0*26;/gi, "&").trim();

/** Comparison key of an outlet name: entities for & and quotes folded, case and punctuation ignored. */
function nameKey(s: string): string {
  return s
    .replace(/&amp;|&#0*38;/gi, "&")
    .replace(/&(?:#0*39|apos|rsquo|lsquo|#8217|#8216);/gi, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Title without its "(Outlet)" / "(Author/Outlet)" tail - only when the tail names THIS outlet. */
export function stripTechmemeTitle(title: string, outlet: string | null | undefined): string {
  const want = nameKey(outlet ?? "");
  if (!want) return title;
  const tail = /\s*\(([^()]{1,160})\)\s*$/.exec(title);
  if (!tail || tail.index < 8) return title;
  const inner = tail[1];
  const last = inner.slice(inner.lastIndexOf("/") + 1);
  return nameKey(last) === want || nameKey(inner) === want ? title.slice(0, tail.index).trim() : title;
}

/**
 * A Techmeme item pointed at the article it is about: `link` becomes the headline anchor's URL, the
 * "(Author/Outlet)" tail leaves the title, the outlet goes to itemPublisher / itemPublisherUrl, and
 * the permalink is kept in `resolvedFrom` (normalize treats it as an earlier identity, so first-seen
 * time and reader state of items published under the permalink carry over).
 *
 * Pure and idempotent; a no-op for every other source and for an item it has already rewritten.
 * Applied to fresh, 304-reused and carried items alike (see ingest/index.ts), so state written
 * before this existed is upgraded on the next run.
 */
export function unwrapTechmeme(item: RawItem): RawItem {
  if (!item.summaryHtml || bareHost(item.link) !== TECHMEME_HOST) return item;
  const html = item.summaryHtml;

  const by = TECHMEME_BYLINE.exec(html);
  const outlet = by ? capText(by[3].replace(/\s+/g, " ").trim(), RAW_FIELD_MAX) : "";
  const outletUrl = by ? attrValue(by[1] ?? by[2]) : "";

  const head = TECHMEME_HEADLINE.exec(html);
  const article = head ? attrValue(head[1] ?? head[2]) : "";
  const moved = isHttpUrl(article) && bareHost(article) !== TECHMEME_HOST;

  const title = outlet ? stripTechmemeTitle(item.title, outlet) : item.title;
  if (!moved && !outlet) return item;

  const out: RawItem = { ...item, title };
  if (outlet && bareHost(outletUrl) !== TECHMEME_HOST) {
    out.itemPublisher = outlet;
    if (isHttpUrl(outletUrl)) out.itemPublisherUrl = outletUrl;
  }
  if (moved) {
    out.link = article;
    out.guid = item.guid ?? item.link;
    out.resolvedFrom = item.link;
  }
  return out;
}
