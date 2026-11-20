// Markdown helpers shared by the briefing export and the "copy all as Markdown" action on the
// saved pages. Titles and names come from third-party feeds, so they are escaped before they are
// placed inside Markdown syntax. Pure.

import { isHttpUrl } from "../../../../shared/url";

// Characters that start or end inline Markdown constructs. Deliberately NOT the full CommonMark
// punctuation set: escaping "." or "-" would turn "GPT-5.1" into "GPT\-5\.1" for readers who paste
// the briefing into a plain-text email.
const MD_SPECIAL = /[\\`*_[\]<>#|~]/g;
// "&amp;" or "&#39;" in a title would be rendered as an entity; a bare "&" is harmless.
const ENTITY_LIKE = /&(?=#?[a-z0-9]+;)/gi;

/** Text safe to place inside a Markdown link label, list item or emphasis. Collapses whitespace. */
export function escapeMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().replace(MD_SPECIAL, "\\$&").replace(ENTITY_LIKE, "\\&");
}

const URL_UNSAFE: Readonly<Record<string, string>> = { " ": "%20", "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", '"': "%22", "\\": "%5C" };

/** URL safe inside "(...)" of a Markdown link; "" for anything that is not an absolute http(s) URL. */
export function markdownUrl(url: string | null | undefined): string {
  if (!url || !isHttpUrl(url)) return "";
  return url.trim().replace(/[ ()<>"\\]/g, (c) => URL_UNSAFE[c] ?? c);
}

/** "[label](url)"; just the escaped label when the URL is not http(s). */
export function markdownLink(label: string, url: string | null | undefined): string {
  const safe = markdownUrl(url);
  const text = escapeMarkdown(label);
  return safe ? `[${text}](${safe})` : text;
}

/** One line of plain text: whitespace collapsed, control characters removed. */
export function plainLine(text: string | null | undefined): string {
  if (!text) return "";
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
}
