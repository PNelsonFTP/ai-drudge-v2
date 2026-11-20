// Text cleaning for titles and summaries (replaces V1 fetch-feeds.ts stripHtml / decodeEntities /
// cleanText and the scraper's diverged copy). Pure; never throws on any input.
//
//   decodeEntities   named (HTML4 set) + numeric + double-encoded entities, clamped code points
//   stripHtml        tags, comments, CDATA and the CONTENT of <style>/<script>/... blocks
//   sanitizeText     invisible / bidi / control characters, NFC, whitespace
//   cleanTitle       markup, site suffix, duplicated source prefix, <= 200 chars
//   cleanSummary     markup, feed boilerplate, title echoes, <= 320 chars at a word boundary

import { PIPELINE } from "../context";

// ------------------------------------------------------------------------------------------------
// Entities
// ------------------------------------------------------------------------------------------------

// U+00A0..U+00FF in code point order (HTML 4 Latin-1 entity names).
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

// U+0391..U+03A9 and U+03B1..U+03C9 in code point order ("-" marks the unassigned U+03A2).
const GREEK_UPPER = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega";
const GREEK_LOWER = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega";

const OTHER: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  hyphen: 8208, dash: 8208, ndash: 8211, mdash: 8212, horbar: 8213,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472,
  real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
  lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715,
  prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773,
  asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836,
  sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
  lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
  spades: 9824, clubs: 9827, hearts: 9829, diams: 9830, check: 10003, starf: 9733, star: 9734,
  // HTML5 punctuation names that leak through WordPress / Ghost exports.
  excl: 33, num: 35, dollar: 36, percnt: 37, lpar: 40, rpar: 41, ast: 42, plus: 43, comma: 44,
  period: 46, sol: 47, colon: 58, semi: 59, equals: 61, quest: 63, commat: 64, lbrack: 91, lsqb: 91,
  bsol: 92, rbrack: 93, rsqb: 93, Hat: 94, lowbar: 95, grave: 96, lbrace: 123, lcub: 123, vert: 124,
  verbar: 124, rbrace: 125, rcub: 125, NewLine: 10, Tab: 9,
};

function buildEntityTable(): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  const add = (name: string, cp: number): void => void table.set(name, String.fromCodePoint(cp));
  LATIN1.split(" ").forEach((name, i) => add(name, 0xa0 + i));
  GREEK_UPPER.split(" ").forEach((name, i) => name !== "-" && add(name, 0x391 + i));
  GREEK_LOWER.split(" ").forEach((name, i) => add(name, 0x3b1 + i));
  for (const [name, cp] of Object.entries(OTHER)) add(name, cp);
  return table;
}

const NAMED: ReadonlyMap<string, string> = buildEntityTable();

// Browsers map numeric references in the C1 range through Windows-1252 (&#146; is a curly apostrophe).
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

/** Character for a numeric reference. Out-of-range, surrogate and control code points give "" (never throws). */
function fromCodePointSafe(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return "";
  if (cp === 9 || cp === 10 || cp === 13) return " ";
  if (cp < 0x20 || cp === 0x7f) return "";
  if (cp >= 0x80 && cp <= 0x9f) {
    const mapped = CP1252[cp - 0x80];
    return mapped.charCodeAt(0) <= 0x9f ? "" : mapped;
  }
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  if ((cp & 0xfffe) === 0xfffe) return "";
  return String.fromCodePoint(cp);
}

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,12}|#[0-9]{1,12}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function decodeOnce(s: string): string {
  return s.replace(ENTITY_RE, (full, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return fromCodePointSafe(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED.get(body) ?? NAMED.get(body.toLowerCase()) ?? full;
  });
}

/**
 * Decode HTML entities: the HTML 4 named set (&eacute; &euro; &middot; ...), decimal and hex numeric
 * references, and double-encoded input (&amp;amp; / &amp;#8217;), up to three passes. Unknown names
 * are left as written. Numeric references outside Unicode, surrogates and control characters are
 * removed instead of throwing (V1 rejected the whole build on &#99999999;).
 */
export function decodeEntities(s: string | null | undefined): string {
  if (typeof s !== "string" || !s) return "";
  let out = s;
  for (let pass = 0; pass < 3 && out.includes("&"); pass++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Markup
// ------------------------------------------------------------------------------------------------

// Elements whose TEXT CONTENT is never prose (V1 leaked BAIR's <style> rules into summaries).
const CONTENT_BLOCKS = "style|script|svg|noscript|template|iframe|object|math|pre|figcaption|head|select|textarea";
const BLOCK_RE = new RegExp(`<(${CONTENT_BLOCKS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi");
// An opening tag that never closes (feed cut mid-element): drop everything after it.
const OPEN_BLOCK_RE = new RegExp(`<(?:style|script|svg|noscript|template)\\b[^>]*>[\\s\\S]*$`, "i");
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
// Tag SHAPE is required, so "a < b and c > d" and "<3" survive.
const ANY_TAG_RE = /<\/?[a-zA-Z][^<>]*>|<![a-zA-Z][^<>]*>/g;
// Titles: only real formatting tags are removed, so "Why the <think> token matters" and
// "List<String>" keep their angle brackets (V1 ate them).
const FORMAT_TAGS =
  "a|abbr|b|bdi|bdo|big|br|center|cite|code|del|dfn|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|nobr|ol|p|q|s|samp|small|span|strike|strong|sub|sup|tt|u|ul|var|wbr";
const FORMAT_TAG_RE = new RegExp(`<\\/?(?:${FORMAT_TAGS})(?:\\s[^<>]*)?\\/?>`, "gi");

function stripBlocks(s: string): string {
  return s.replace(CDATA_RE, "$1").replace(COMMENT_RE, " ").replace(BLOCK_RE, " ").replace(OPEN_BLOCK_RE, " ");
}

/** HTML -> text: CDATA unwrapped, comments and non-prose blocks removed WITH their content, tags -> space. */
export function stripHtml(s: string | null | undefined): string {
  if (typeof s !== "string" || !s) return "";
  return stripBlocks(s).replace(ANY_TAG_RE, " ");
}

function stripFormatTags(s: string): string {
  return s.replace(CDATA_RE, "$1").replace(COMMENT_RE, " ").replace(FORMAT_TAG_RE, " ");
}

// ------------------------------------------------------------------------------------------------
// Invisible characters and whitespace
// ------------------------------------------------------------------------------------------------

// Zero-width space, word joiner, BOM, soft hyphen, LRM/RLM, bidi embeddings / overrides / isolates,
// line / paragraph separators handled as whitespace below.
const INVISIBLE_RE = /[​⁠﻿­‎‏‪-‮⁦-⁩￹-￻]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// ZWJ / ZWNJ are kept only where they join something (emoji sequences, Indic / Persian text).
const STRAY_JOINER_RE = /(?<![^\s\u0000-\u007F])[‌‍]+|[‌‍]+(?![^\s\u0000-\u007F])/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** NFC, invisible / bidi-control / control characters and lone surrogates removed, whitespace collapsed and trimmed. */
export function sanitizeText(s: string | null | undefined): string {
  if (typeof s !== "string" || !s) return "";
  return s
    .replace(LONE_SURROGATE_RE, "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(STRAY_JOINER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markup-free, entity-decoded, sanitized plain text (summary rules: every tag-shaped run is markup). */
export function cleanText(s: string | null | undefined): string {
  if (typeof s !== "string" || !s) return "";
  // Decode, then strip again: escaped markup ("&lt;p&gt;") only becomes a tag after decoding.
  const once = decodeEntities(stripHtml(s));
  return sanitizeText(once.includes("<") ? decodeEntities(stripHtml(once)) : once);
}

// ------------------------------------------------------------------------------------------------
// Truncation
// ------------------------------------------------------------------------------------------------

const TRAILING_PUNCT_RE = /[\s,;:\-–—([{/&"'“‘«]+$/u;

/**
 * Cut to at most `max` UTF-16 units at a word boundary and append "…". Text within the limit is
 * returned unchanged. Works on code points, so the result never ends in a lone surrogate
 * (V1 `.slice(0, 320)` split emoji).
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "";
  const budget = max - 1; // room for the ellipsis
  let cut = "";
  for (const ch of text) {
    if (cut.length + ch.length > budget) break;
    cut += ch;
  }
  // Only step back to a space when the cut landed inside a word.
  const next = text.slice(cut.length, cut.length + 1);
  if (next && !/\s/.test(next)) {
    const lastSpace = cut.lastIndexOf(" ");
    // A single very long token (URL, CJK text without spaces): keep the hard cut.
    if (lastSpace >= budget * 0.6) cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/[\uD800-\uDBFF]$/, "").replace(TRAILING_PUNCT_RE, "").replace(/[.…]+$/u, "");
  return cut ? `${cut}…` : "";
}

// ------------------------------------------------------------------------------------------------
// Titles
// ------------------------------------------------------------------------------------------------

export interface TitleContext {
  /** Names the title may carry as a site suffix / source prefix: source name, aliases, publisher name, feed-provided outlet. */
  names?: readonly (string | null | undefined)[];
  /** Host of the item or feed ("straiker.ai"): its first label also counts as a name. */
  host?: string | null;
  /**
   * Names a LEADING "Source: " / "[Source]" label may carry; default: `names` plus the host label.
   * Link-host feeds (HN searches, Google News) pass only the feed's own names: there the article's host is
   * somebody's product, and "LayerFS: A filesystem for AI coding agents" (layerfs.dev) must keep its subject.
   */
  prefixNames?: readonly (string | null | undefined)[];
  /** Default PIPELINE.titleMaxChars. */
  maxChars?: number;
}

const NAME_FILLER = new Set(["the", "blog", "news", "newsroom", "com", "org", "net", "io", "ai", "official", "inc", "www"]);

/** Comparable tokens of an outlet name: lower case, accents folded, filler ("the", "blog", ".com") dropped. */
export function nameTokens(name: string | null | undefined): string[] {
  if (typeof name !== "string" || !name) return [];
  const tokens = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept = tokens.filter((t) => !NAME_FILLER.has(t));
  // A name made only of filler words ("The Blog") still has to compare equal to itself.
  return kept.length ? kept : tokens;
}

function isTokenPrefix(short: readonly string[], long: readonly string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((t, i) => t === long[i]);
}

/** How many words a candidate may add after the outlet's name and still be that outlet ("NVIDIA Technical Blog" ~ "NVIDIA"). */
const MAX_OUTLET_EXTRA_TOKENS = 1;

/**
 * Does `candidate` (the text after " | " or before ": ") name the same outlet as one of `names`?
 * Equal token lists match; so does a leading-token prefix either way when the shared part is
 * distinctive ("GovAI Blog" ~ "GovAI", "Straiker" ~ "Straiker STAR", "NVIDIA Technical Blog" ~ "NVIDIA").
 * A candidate that merely STARTS with the name and runs on is a clause about the outlet, not its
 * name: "WSJ Op-Ed | CFTC's New Rules for Crypto" (CFTC feed) keeps its headline.
 */
export function sameOutlet(candidate: string, names: readonly string[][]): boolean {
  const cand = nameTokens(candidate);
  if (cand.length === 0 || cand.length > 6) return false;
  const joined = cand.join("");
  for (const name of names) {
    if (name.length === 0) continue;
    if (joined === name.join("")) return true;
    const [short, long] = cand.length <= name.length ? [cand, name] : [name, cand];
    if (long === cand && cand.length > name.length + MAX_OUTLET_EXTRA_TOKENS) continue;
    if (isTokenPrefix(short, long) && short.join("").length >= 4) return true;
  }
  return false;
}

function tokenLists(list: readonly (string | null | undefined)[] | undefined): string[][] {
  const out: string[][] = [];
  for (const n of list ?? []) {
    const t = nameTokens(n);
    if (t.length) out.push(t);
  }
  return out;
}

function nameLists(ctx: TitleContext): string[][] {
  const out = tokenLists(ctx.names);
  const label = ctx.host?.replace(/^www\./, "").split(".")[0];
  if (label && label.length >= 4 && !NAME_FILLER.has(label.toLowerCase())) out.push([label.toLowerCase()]);
  return out;
}

// " | X", " - X", " – X", " — X", " · X", " :: X" at the very end (the separator needs surrounding spaces,
// so "GPT-5" and "state-of-the-art" are never split).
const SUFFIX_RE = /^(.*\S)\s+(?:\||-|–|—|·|•|::|»)\s+(\S.*)$/su;
const BRACKET_PREFIX_RE = /^\[([^\]]{1,60})\]\s*[:\-–—|]?\s*(\S.*)$/su;
const PLAIN_PREFIX_RE = /^([^:|–—]{2,60}?)\s*(?::|\s\||\s–|\s—|\s-)\s+(\S.*)$/su;
// What must remain after removing a suffix / prefix for the removal to be safe.
const MIN_REST = 8;
// A leading separator with nothing before it: the headline half of "<headline> - <site>" is missing.
const ORPHAN_SEPARATOR_RE = /^[-–—|·•]\s/u;

function stripSiteSuffix(title: string, names: readonly string[][]): string {
  let out = title;
  // At most twice: "Headline | Section | Site".
  for (let i = 0; i < 2; i++) {
    const m = SUFFIX_RE.exec(out);
    if (!m || m[1].length < MIN_REST || !sameOutlet(m[2], names)) break;
    out = m[1];
  }
  return out;
}

// " | Blog" at the very end: the page's section label, whoever the outlet is ("d1.2: State-of-the-Art
// Omnimodal Decision Models | Blog", a lab post reached through Google News). Only after a pipe -
// "Why I quit the news - News" is a sentence.
const SECTION_LABEL_RE = /^(.*\S)\s+\|\s+(?:Blog|News|Newsroom|Press Releases?)$/su;

function stripSectionLabel(title: string): string {
  const m = SECTION_LABEL_RE.exec(title);
  return m && m[1].length >= MIN_REST * 2 ? m[1] : title;
}

// Feed bookkeeping that is not part of a headline (each seen on the live river of 2026-11-20):
//   ", (Wed, Nov 18th)"   SANS ISC diaries append the publication day
//   " (#68296)"           commit feeds append the pull-request number (also cut short by the feed: " (#5…").
//                         Four digits or more: "The AI Paper Trail (#8)" is an issue of a column and keeps its number.
//   " (1)" / " (Correct)" wire-service revision markers
//   "[R1] "               Tenable advisories lead with their revision number
const DAY_STAMP_RE = /,?\s*\((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\)$/;
const PR_REF_RE = /\s+\(#(?:\d{4,7}\)|\d{1,7}(?:…|\.{3}))$/u;
const WIRE_REVISION_RE = /\s+\((?:\d|Correct(?:ed|ion)?|Update(?:d|s)?\s?\d?)\)$/i;
const LEADING_REVISION_RE = /^\[R\d{1,2}\]\s+(?=\S)/;

function stripBookkeeping(title: string): string {
  const out = title.replace(DAY_STAMP_RE, "").replace(PR_REF_RE, "").replace(WIRE_REVISION_RE, "").replace(LEADING_REVISION_RE, "");
  // Never trade a headline for nothing: a title that IS the marker stays as it was.
  return out.trim().length >= MIN_REST ? out : title;
}

// A title the SOURCE cut short ends in "..." or "…". When the cut fell just after a sentence end,
// what is left of the next sentence is noise ("... Remote Code Execution Vulnerability. This..."):
// end the headline at the sentence. The word before the full stop must be an ordinary word of five
// letters or more, so abbreviations ("vs.", "Inc.", "U.S.") never count as a sentence end.
const CUT_SHORT_RE = /\s*(?:…|\.{3,})$/u;
const DANGLING_SENTENCE_RE = /^(.{30,}\b\p{L}{5,})[.!?]\s+\p{Lu}\S*(?:\s+\S+){0,2}$/su;

function tidyCutShort(title: string): string {
  if (!CUT_SHORT_RE.test(title)) return title;
  const body = title.replace(CUT_SHORT_RE, "");
  const dangling = DANGLING_SENTENCE_RE.exec(body);
  if (dangling) return dangling[1];
  // One ellipsis character, as truncateAtWord writes it.
  return body ? `${body}…` : title;
}

function stripSourcePrefix(title: string, names: readonly string[][]): string {
  const bracket = BRACKET_PREFIX_RE.exec(title);
  if (bracket && bracket[2].length >= MIN_REST && sameOutlet(bracket[1], names)) return bracket[2];
  const plain = PLAIN_PREFIX_RE.exec(title);
  if (plain && isHeadline(plain[2]) && exactOutlet(plain[1], names)) return plain[2];
  return title;
}

// What follows "Source: " must stand on its own as a headline: "Deep Learning Weekly: Issue 481"
// and "Ollama: all aboard open models" keep their label.
const isHeadline = (rest: string): boolean => /^[\p{Lu}\p{N}"“‘'(\[]/u.test(rest) && rest.split(/\s+/).length >= 3 && rest.length >= 12;

// "OpenAI: ..." is only a duplicated source label when it is EXACTLY the source name; a prefix
// match would eat real subjects ("Google: we are ..." from "Google AI Blog" stays).
function exactOutlet(candidate: string, names: readonly string[][]): boolean {
  const joined = nameTokens(candidate).join("");
  return joined.length >= 3 && names.some((n) => n.join("") === joined);
}

/**
 * Headline cleanup. Formatting tags and entities removed (unknown "<tags>" survive), invisible
 * characters removed, whitespace collapsed; a trailing " | Site" / " - Publisher" and a leading
 * "[Source]" / "Source: " are dropped when they name the item's own source or publisher; capped at
 * 200 chars on a word boundary. Case is never changed (ALL-CAPS titles are left alone).
 * Returns "" when nothing usable remains.
 */
export function cleanTitle(raw: string | null | undefined, ctx: TitleContext = {}): string {
  if (typeof raw !== "string" || !raw) return "";
  const decoded = decodeEntities(stripFormatTags(raw));
  let title = sanitizeText(decoded.includes("<") ? stripFormatTags(decoded) : decoded);
  if (!title) return "";
  const names = nameLists(ctx);
  if (names.length) title = stripSiteSuffix(title, names);
  const prefixNames = ctx.prefixNames ? tokenLists(ctx.prefixNames) : names;
  if (prefixNames.length) title = stripSourcePrefix(title, prefixNames);
  // A title that is only a separator and a site name ("- The Kaitchup", "- Marcus on AI | Substack": Google
  // News entries for comment / subscribe pages, which have no headline) is not a title.
  if (ORPHAN_SEPARATOR_RE.test(title)) return "";
  title = stripSectionLabel(title);
  title = stripBookkeeping(title);
  title = stripSlugEcho(title);
  title = tidyCutShort(title);
  return truncateAtWord(title.trim(), ctx.maxChars ?? PIPELINE.titleMaxChars);
}

// " (google/gemini-4-neon)" at the very end: a lower-case "owner/slug" id.
const SLUG_TAIL_RE = /^(.*\S)\s+\(([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._:-]*)\)$/s;

/**
 * Model listings repeat the machine id after the name ("Google: Gemini 4 Neon (google/gemini-4-neon)",
 * OpenRouter). The tail is removed only when it is an echo: every word of the slug is already in
 * the headline. A repository the headline does not otherwise name ("... (ggml-org/llama.cpp)") stays.
 */
export function stripSlugEcho(title: string): string {
  const m = SLUG_TAIL_RE.exec(title);
  if (!m) return title;
  const head = m[1].toLowerCase();
  const words = m[3].split(/[-_.:]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => head.includes(w)) ? m[1] : title;
}

export interface OutletTail {
  /** The title without its "(Author/Outlet)" tail. */
  title: string;
  /** The outlet named in the tail ("Forbes", "The Information"). */
  outlet: string;
}

// " (Richard Nieva/Forbes)", " (The Information)", " (@handle)" at the very end.
const OUTLET_TAIL_RE = /^(.*\S)\s+\(([^()]{2,80})\)$/su;

/**
 * Split the "(Author/Outlet)" credit an aggregator appends to its rewritten headline (Techmeme:
 * "... a 430%+ return on investment (Richard Nieva/Forbes)"). Returns null when the title has no
 * such tail, when the tail does not read as a name ("(Update 2)", "(CVE-2026-1234)", "(NASDAQ: NVDA)")
 * or when too little headline would remain. Call it on aggregator rewrites only: on an ordinary
 * headline a closing parenthesis is part of the headline.
 */
export function splitOutletTail(title: string): OutletTail | null {
  const m = OUTLET_TAIL_RE.exec(title.trim());
  if (!m || m[1].length < MIN_REST * 2) return null;
  const outlet = (m[2].split("/").pop() ?? "").trim();
  // An outlet is a name: it starts with a capital, a digit or "@", and carries no sentence punctuation.
  if (outlet.length < 2 || !/^[@\p{Lu}\p{N}]/u.test(outlet) || /[:;,$%]|\d{4}/.test(outlet)) return null;
  return { title: m[1], outlet };
}

/** Longest outlet name a " - Outlet" tail may be (characters / words). */
const DASH_OUTLET_MAX_CHARS = 60;
const DASH_OUTLET_MAX_WORDS = 8;

/**
 * Split the " - Outlet" tail of a Google News title ("Citi puts AI-agent losses on customers - BigGo
 * Finance"). Google News builds every title that way, so the text after the LAST " - " is the outlet
 * whatever it looks like ("digitimes", "www.tokenpost.com"). Call it ONLY on a Google News entry
 * that has no <source> element: on any other headline a spaced hyphen is punctuation. Returns null
 * when there is no tail, when it is too long to be a name or when too little headline would remain.
 */
export function splitDashOutlet(title: string): OutletTail | null {
  const flat = sanitizeText(decodeEntities(title));
  const at = flat.lastIndexOf(" - ");
  if (at < 0) return null;
  const head = flat.slice(0, at).trim();
  const outlet = flat.slice(at + 3).trim();
  if (head.length < MIN_REST * 2 || outlet.length < 2 || outlet.length > DASH_OUTLET_MAX_CHARS || outlet.split(/\s+/).length > DASH_OUTLET_MAX_WORDS) return null;
  return { title: head, outlet };
}

// ------------------------------------------------------------------------------------------------
// Summaries
// ------------------------------------------------------------------------------------------------

export interface SummaryContext {
  /** Cleaned title of the item: a summary that only repeats it is dropped. */
  title?: string;
  /** Outlet names (publisher, feed-provided outlet): removed when they trail a title echo (Google News). */
  names?: readonly (string | null | undefined)[];
  /** Default PIPELINE.summaryMaxChars. */
  maxChars?: number;
}

/** Below this a "summary" is a tag or a byline ("Quantum", "Health & Bioscience"), not a description. */
const MIN_SUMMARY_CHARS = 25;

const URLISH = "(?:https?:\\/\\/)?\\S+";
const TRAILER = "(?:Signed-off-by|Co-authored-by|Reviewed-by|Tested-by|Acked-by)";
// One word of a trailer's value: a capitalised name part or an address - but not the next trailer's key.
const TRAILER_NAME = `(?!${TRAILER}:)(?:[\\p{Lu}][\\p{L}.'-]*|\\S+@\\S+)`;
const LEADING_BOILERPLATE: readonly RegExp[] = [
  // arXiv RSS: "arXiv:2611.23322v1 Announce Type: new Abstract: ..."
  /^\s*(?:arXiv:\s*\S+\s+)?Announce Type:\s*[\w-]+(?:\s+Abstract:)?\s*/i,
  /^\s*Abstract:\s*/i,
  // GitHub's auto-generated release notes heading.
  /^\s*What[’']s Changed\s*:?\s*/i,
];
const ANYWHERE_BOILERPLATE: readonly RegExp[] = [
  // hnrss: "Article URL: ... Comments URL: ... Points: 276 # Comments: 30"
  new RegExp(`Article URL:\\s*${URLISH}\\s*(?:Comments URL:\\s*${URLISH}\\s*)?(?:Points:\\s*\\d+\\s*)?(?:#\\s*Comments:\\s*\\d+)?`, "gi"),
  new RegExp(`Comments URL:\\s*${URLISH}\\s*(?:Points:\\s*\\d+\\s*)?(?:#\\s*Comments:\\s*\\d+)?`, "gi"),
  // Reddit "submitted by /u/x to r/y", Lemmy "submitted by X to community 12 points | 0 comments".
  /\bsubmitted by\s+\/?u\/\S+(?:\s+to\s+\/?r\/\S+)?/gi,
  /\bsubmitted by\s+\S+\s+to\s+\S+\s+\d+\s+points?\s*\|\s*\d+\s+comments?/gi,
  /\[link\]|\[comments\]|\[\d+\s+comments?\]/gi,
  // GitHub release notes furniture. "Full Changelog" goes first: the trailer rule would read it as a name.
  /\bFull Changelog\s*:?\s*(?:https?:\/\/\S+|\S+\.{3}\S+)?/gi,
  // Trailers (the "<email>" is already gone: it is tag-shaped).
  new RegExp(`\\b${TRAILER}:\\s*${TRAILER_NAME}(?:\\s+${TRAILER_NAME}){0,4}`, "gu"),
  /\bby\s+@[\w-]+(?:\[bot\])?\s+in\s+(?:#\d+|https?:\/\/github\.com\/\S+)/gi,
  /\bVerify this release\b[\s\S]*$/i,
];
// "Read more" / "Continue reading" tails. Capitalised forms are link text wherever they end the
// summary; lower-case forms only count after a sentence end ("... visit us to learn more." is prose).
const TAIL_END = "\\s*[)\\]]?\\s*(?:…|\\.{2,}|»|→|›|>+|\\.)?\\s*$";
const OPEN = "\\s*[([]?\\s*";
const AFTER_SENTENCE = "(?<=[.!?…\\]])";
const THE_REST = "the\\s+(?:full|rest|entire|whole|original)\\b.{0,80}?";
const TRAILING_BOILERPLATE: readonly RegExp[] = [
  new RegExp(`${OPEN}(?:Read|View|See|Learn)\\s+(?:[Mm]ore|${THE_REST})${TAIL_END}`, "u"),
  new RegExp(`${AFTER_SENTENCE}${OPEN}(?:read|view|see|learn)\\s+(?:more|${THE_REST})${TAIL_END}`, "iu"),
  new RegExp(`${OPEN}(?:Continue|Keep)\\s+[Rr]eading\\b.{0,160}?${TAIL_END}`, "u"),
  new RegExp(`${AFTER_SENTENCE}${OPEN}(?:continue|keep)\\s+reading\\b.{0,160}?${TAIL_END}`, "iu"),
  /(?<=[.!?…])\s*(?:Click|Tap)\s+here\b[^.!?]{0,80}\.?\s*$/u,
  /\s*(?:→|»|›)\s*$/u,
];
// "[...]" / "[…]": the feed cut the text here, so the cleaned summary says so with an ellipsis.
const CUT_MARK_RE = /[\s,;:]*\[\s*(?:…|\.{2,})\s*\]\s*$/u;

/** Remove WordPress's "The post <title> appeared first on <site>." tail. */
function stripAppearedFirst(s: string): string {
  const at = s.search(/\b(?:first\s+)?appeared first on\b/i);
  if (at < 0) return s;
  // Cut from the LAST "The post" before the marker; an earlier "the post office" must survive.
  const head = s.slice(0, at);
  const from = Math.max(head.lastIndexOf("The post "), head.lastIndexOf("This post "), head.lastIndexOf("The article "));
  return from >= 0 ? s.slice(0, from) : s;
}

interface FoldedWord {
  /** Span in Folded.text. */
  from: number;
  to: number;
  /** Span in the original string. */
  start: number;
  end: number;
}

interface Folded {
  /** Lower-cased words joined by single spaces. */
  text: string;
  words: FoldedWord[];
}

/** Words only, so two strings compare equal whatever punctuation and spacing separate their words. */
function fold(s: string): Folded {
  const words: FoldedWord[] = [];
  let text = "";
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (text) text += " ";
    const from = text.length;
    text += m[0].toLowerCase();
    words.push({ from, to: text.length, start: m.index, end: m.index + m[0].length });
  }
  return { text, words };
}

/** Where `needle` occurs in `haystack` as a run of whole words: [start, end) in the ORIGINAL haystack string. */
function findWords(haystack: Folded, needle: Folded): [number, number] | null {
  if (!needle.text) return null;
  for (let from = 0; ; ) {
    const at = haystack.text.indexOf(needle.text, from);
    if (at < 0) return null;
    const end = at + needle.text.length;
    const first = haystack.words.find((w) => w.from === at);
    const last = haystack.words.find((w) => w.to === end);
    if (first && last) return [first.start, last.end];
    from = at + 1;
  }
}

/** Byline room before an echoed title ("Sarah Perez / TechCrunch : "). Longer text is real prose. */
const MAX_BYLINE_CHARS = 60;
/** Titles shorter than this (in letters) are too generic to call a repeat. */
const MIN_ECHO_CHARS = 12;

/**
 * Remove a repeated title from a summary and keep only what follows it:
 *   Google News  "<title>  <outlet>"                      -> ""
 *   Techmeme     "<author> / <outlet> : <title> — <text>" -> "<text>"
 * A summary that merely contains the title inside real prose is returned unchanged.
 */
function stripTitleEcho(summary: string, title: string, names: readonly string[][]): string {
  const hay = fold(summary);
  // Techmeme titles end in "(Author/Outlet)", which the summary does not repeat.
  const variants = [title, title.replace(/\s*\([^()]{1,80}\)\s*$/, "")];
  for (const variant of variants) {
    const needle = fold(variant);
    if (needle.text.length < MIN_ECHO_CHARS) continue;
    const span = findWords(hay, needle);
    if (!span) continue;
    if (span[0] > MAX_BYLINE_CHARS) return summary;
    // The echo is matched on words, so symbols that end the title ("... holds 2%+") are still in front.
    const after = summary.slice(span[1]).replace(/^[\s\-–—:|·.,…)\]"”’'%+]+/u, "");
    return sameOutlet(after, names) ? "" : after;
  }
  // A truncated echo: the summary is the beginning of the title.
  return hay.text.length >= 20 && fold(title).text.startsWith(hay.text) ? "" : summary;
}

/**
 * Plain-text summary or null. Markup and non-prose blocks removed, entities decoded, feed
 * boilerplate removed ("The post ... appeared first on ...", "Read more", "Continue reading",
 * "[...]", arXiv "Announce Type:" prefixes, hnrss "Article URL: ... Comments URL: ...", Reddit / Lemmy
 * "submitted by", GitHub trailers), title echoes dropped, then cut to 320 chars at a word boundary.
 */
export function cleanSummary(raw: string | null | undefined, ctx: SummaryContext = {}): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let s = cleanText(raw);
  if (!s) return null;
  for (const re of ANYWHERE_BOILERPLATE) s = s.replace(re, " ");
  s = stripAppearedFirst(s);
  for (const re of LEADING_BOILERPLATE) s = s.replace(re, "");
  let wasCut = false;
  for (let changed = true; changed; ) {
    changed = false;
    if (CUT_MARK_RE.test(s)) {
      s = s.replace(CUT_MARK_RE, "");
      wasCut = true;
      changed = true;
    }
    for (const re of TRAILING_BOILERPLATE) {
      const next = s.replace(re, "");
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  if (wasCut && s && !/[.!?…]$/u.test(s)) s = `${s.replace(TRAILING_PUNCT_RE, "")}…`;
  if (ctx.title) s = stripTitleEcho(s, ctx.title, (ctx.names ?? []).map(nameTokens).filter((n) => n.length > 0));
  if (s.length < MIN_SUMMARY_CHARS) return null;
  const out = truncateAtWord(s, ctx.maxChars ?? PIPELINE.summaryMaxChars);
  return out || null;
}

// ------------------------------------------------------------------------------------------------
// Title templates (SourceDef.titleTemplate)
// ------------------------------------------------------------------------------------------------

/** First sentence of a summary, without its closing punctuation or the truncation ellipsis. */
function firstSentence(raw: string): string {
  // A description that opens with its own heading ("Summary FINRA has adopted ...") is not part of the sentence.
  const summary = raw.replace(/^(?:Summary|Overview|Abstract)\b[:\s]*/i, "");
  const m = /^(.+?[.!?])(?:\s|$)/.exec(summary);
  return (m ? m[1] : summary).replace(/[.!?…\s]+$/u, "").trim();
}

/**
 * Headline for sources whose feed titles are not headlines ("Regulatory Notice 26-24", a bare repo
 * id). Placeholders: {title}, {summary} (first sentence), {source}. When the template needs
 * {summary} and the item has none - or the summary only repeats the title - the feed title is kept.
 */
export function applyTitleTemplate(template: string, parts: { title: string; summary: string | null; source: string }): string {
  const sentence = parts.summary ? firstSentence(parts.summary) : "";
  if (template.includes("{summary}") && (!sentence || sentence.toLowerCase() === parts.title.toLowerCase())) return parts.title;
  const out = template
    .replace(/\{(title|summary|source)\}/g, (_m, key: string) => (key === "title" ? parts.title : key === "summary" ? sentence : parts.source))
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(out, PIPELINE.titleMaxChars);
}
