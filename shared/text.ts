// Text helpers shared by the pipeline and the client. ONE copy (V1 had two tokenizers and three
// ad-hoc keyword matchers). Pure: no node:, no DOM.
//
//   tokenize / tokenSet / STOPWORDS / jaccard   - title similarity primitives (cluster stage)
//   compileTerms                                - THE word-boundary term matcher: routing rules,
//                                                 AI-relevance gate, importance terms, watchlist
//   normalizeForSearch / parseQuery / matchesQuery - search (multi-word AND, normalised, word-start)

/** Common English + news filler. "ai" is a stopword on purpose: every story here is about AI. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "nor", "of", "to", "in", "on", "for", "with", "by", "at", "from",
  "is", "are", "was", "were", "be", "been", "being", "as", "it", "its", "this", "that", "these", "those",
  "says", "said", "say", "will", "would", "can", "could", "may", "might", "should", "has", "have", "had",
  "do", "does", "did", "not", "no", "new", "ai", "via", "after", "before", "over", "into", "about", "than",
  "then", "so", "if", "up", "out", "off", "how", "what", "why", "when", "where", "who", "which",
  "you", "your", "we", "our", "us", "they", "their", "them", "he", "she", "his", "her", "my", "me",
  "more", "most", "just", "now", "also", "here", "there", "all", "any", "some",
]);

const APOSTROPHES = /[‘’ʼ`´]/g;
// A token is a run of letters/digits, optionally joined by INTERNAL "." or "_" (so "llama.cpp",
// "llama_index", "5.1", "v0.3.2" stay whole). Hyphens and every other character split tokens
// ("gpt-5.1" -> "gpt", "5.1"; "open-source" -> "open", "source").
const TOKEN_RE = /[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)*/gu;

export interface TokenizeOptions {
  /** Defaults to STOPWORDS. Pass an empty set to keep everything. */
  stopwords?: ReadonlySet<string>;
  /** Minimum token length (default 2). Tokens made only of digits are always kept ("5"). */
  minLength?: number;
}

/**
 * Lower-cased tokens in text order (duplicates preserved). NFKC-normalised; possessive "'s" dropped;
 * stopwords and tokens shorter than `minLength` removed (pure-digit tokens are kept).
 */
export function tokenize(text: string | null | undefined, opts?: TokenizeOptions): string[] {
  if (!text) return [];
  const stop = opts?.stopwords ?? STOPWORDS;
  const min = opts?.minLength ?? 2;
  const s = text.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "'").replace(/'s\b/g, "");
  const out: string[] = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (stop.has(t)) continue;
    if (t.length < min && !/^\p{N}+$/u.test(t)) continue;
    out.push(t);
  }
  return out;
}

export function tokenSet(text: string | null | undefined, opts?: TokenizeOptions): Set<string> {
  return new Set(tokenize(text, opts));
}

/** |A ∩ B| / |A ∪ B|; 0 when either set is empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Kebab slug: NFKD without diacritics, lower case, apostrophes removed, every other run of
 * non-alphanumerics -> "-". "Don't Worry About the Vase (Zvi)" -> "dont-worry-about-the-vase-zvi";
 * "ggml-org/llama.cpp" -> "ggml-org-llama-cpp".
 */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ------------------------------------------------------------------------------------------------
// compileTerms - word-boundary term matcher
// ------------------------------------------------------------------------------------------------

export interface TermHit {
  /** The term as written in the list given to compileTerms (trimmed). */
  term: string;
  /** Start offset of the match in the ORIGINAL text (UTF-16 code units). */
  index: number;
  /** Length of the matched text. */
  length: number;
}

/**
 * Compiled matcher. Call it for the first hit (or null); use the methods for more.
 *
 * Term syntax (case-insensitive, Unicode-aware):
 * - Plain word or phrase: "valuation", "series a", "prompt injection".
 * - WORD BOUNDARIES: a term edge that is a letter/digit must not touch another letter/digit in the
 *   text. "edr" does not match "bedrock"; "valuation" does not match "evaluation"; "series a" does
 *   not match "time-series and"; "ipo" matches "launches-the-IPO". A term edge that is punctuation
 *   ("c++", "gpt-", "$nvda") carries no boundary on that side.
 * - Whitespace and hyphens inside a term are interchangeable and match any run of either:
 *   "open source" matches "open-source" and "open  source"; "post-quantum" matches "post quantum".
 * - Trailing "*" = prefix match to the end of the word: "quantiz*" matches "quantized",
 *   "quantization". Leading "*" = suffix match: "*bench" matches "bench" and "swebench". The
 *   wildcard extends over letters/digits only, and the hit covers the whole extended word.
 * - Straight and curly apostrophes are equivalent.
 * - `plural: true` additionally accepts a trailing "s"/"es" on terms that end in a letter/digit
 *   ("llm" matches "LLMs"). Off by default (routing/relevance rules stay exact); the watchlist turns
 *   it on.
 * Blank terms are ignored; duplicates (case-insensitive) are collapsed. When two terms match at the
 * same position the longer term wins.
 */
export interface TermMatcher {
  (text: string | null | undefined): TermHit | null;
  /** Every non-overlapping hit, in text order (for highlighting). */
  all(text: string | null | undefined): TermHit[];
  /** Distinct matched terms, in order of first appearance. */
  terms(text: string | null | undefined): string[];
  /** Number of DISTINCT terms matched (for "needs two hits" rules). */
  count(text: string | null | undefined): number;
  /** Number of compiled terms; 0 means the matcher never matches. */
  readonly size: number;
  /** The cleaned term list actually compiled. */
  readonly source: readonly string[];
}

export interface CompileTermsOptions {
  /** Accept a trailing "s"/"es" on terms ending in a letter or digit. Default false. */
  plural?: boolean;
}

const WORD = "[\\p{L}\\p{N}]";
const SEP_CLASS = "[\\s\\u00A0\\-\\u2010-\\u2015]+";
const SEP_SPLIT = /([\s \-‐-―]+)/u;
const IS_WORD_CHAR = /[\p{L}\p{N}]/u;

function termSource(raw: string, plural: boolean): string | null {
  let core = raw;
  let lead = false;
  let trail = false;
  if (core.startsWith("*")) {
    lead = true;
    core = core.slice(1);
  }
  if (core.endsWith("*")) {
    trail = true;
    core = core.slice(0, -1);
  }
  core = core.trim();
  if (!core) return null;
  const body = core
    .split(SEP_SPLIT)
    .map((part, i) => {
      if (part === "") return "";
      if (i % 2 === 1) return SEP_CLASS;
      return escapeRegExp(part).replace(/['‘’ʼ]/g, "['\\u2018\\u2019\\u02BC]");
    })
    .join("");
  const first = core[0];
  const last = core[core.length - 1];
  const firstIsWord = IS_WORD_CHAR.test(first);
  const lastIsWord = IS_WORD_CHAR.test(last);
  let pre = "";
  if (lead) pre = `(?<!${WORD})${WORD}*`;
  else if (firstIsWord) pre = `(?<!${WORD})`;
  let post = "";
  if (trail) post = `${WORD}*`;
  else if (lastIsWord) post = `${plural ? "(?:es|s)?" : ""}(?!${WORD})`;
  return `${pre}${body}${post}`;
}

export function compileTerms(terms: readonly string[], opts?: CompileTermsOptions): TermMatcher {
  const plural = opts?.plural ?? false;
  const seen = new Set<string>();
  const cleaned: { term: string; src: string }[] = [];
  for (const t of terms) {
    if (typeof t !== "string") continue;
    const term = t.trim().replace(/\s+/g, " ");
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    const src = termSource(term, plural);
    if (!src) continue;
    seen.add(key);
    cleaned.push({ term, src });
  }
  // Longest first so the longer term wins at the same position ("open source model" over "open source").
  const ordered = [...cleaned].sort((a, b) => b.term.length - a.term.length);
  const re = ordered.length ? new RegExp(ordered.map((c) => `(${c.src})`).join("|"), "giu") : null;

  const scan = (text: string | null | undefined, firstOnly: boolean): TermHit[] => {
    if (!re || !text) return [];
    const hits: TermHit[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      let g = 1;
      while (g < m.length && m[g] === undefined) g++;
      hits.push({ term: ordered[g - 1]?.term ?? m[0], index: m.index, length: m[0].length });
      if (firstOnly) break;
    }
    re.lastIndex = 0;
    return hits;
  };

  const distinct = (text: string | null | undefined): string[] => {
    const out: string[] = [];
    const got = new Set<string>();
    for (const h of scan(text, false)) {
      if (!got.has(h.term)) {
        got.add(h.term);
        out.push(h.term);
      }
    }
    return out;
  };

  const matcher = ((text: string | null | undefined) => scan(text, true)[0] ?? null) as TermMatcher;
  matcher.all = (text) => scan(text, false);
  matcher.terms = distinct;
  matcher.count = (text) => distinct(text).length;
  Object.defineProperty(matcher, "size", { value: cleaned.length, enumerable: true });
  Object.defineProperty(matcher, "source", { value: Object.freeze(cleaned.map((c) => c.term)), enumerable: true });
  return matcher;
}

/** A matcher that never matches (use instead of null checks). */
export const NO_TERMS: TermMatcher = compileTerms([]);

export interface TextPart {
  text: string;
  /** The matched term when this part is a hit; undefined for plain text. */
  term?: string;
}

/** Split `text` into plain and matched parts for highlighting. Concatenating `text` gives the input. */
export function highlightParts(text: string, matcher: TermMatcher): TextPart[] {
  const hits = matcher.all(text);
  if (hits.length === 0) return text ? [{ text }] : [];
  const parts: TextPart[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.index > at) parts.push({ text: text.slice(at, h.index) });
    parts.push({ text: text.slice(h.index, h.index + h.length), term: h.term });
    at = h.index + h.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

// ------------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------------

/**
 * Normal form for search haystacks and queries: NFKD with diacritics removed, lower case, curly
 * quotes -> straight, any dash -> "-", whitespace collapsed and trimmed.
 */
export function normalizeForSearch(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Query -> normalised search words. Whitespace separates words; "double quotes" keep a phrase
 * together. [] for a blank query. Every returned word must be found (AND) - see matchesQuery.
 */
export function parseQuery(query: string | null | undefined): string[] {
  const q = normalizeForSearch(query);
  if (!q) return [];
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const w = (m[1] ?? m[2] ?? "").replace(/"/g, "").trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** Search words of at most this many characters must match a WHOLE word (see matchesQuery). */
export const QUERY_WHOLE_WORD_MAX = 5;

export interface QueryMatchOptions {
  /**
   * true: a word of any length may be the START of a longer word ("anth" finds Anthropic) - for
   * filter-as-you-type boxes over short labels. Default false: the search rule below.
   */
  prefix?: boolean;
}

const WORD_CHAR = "[\\p{L}\\p{N}]";
const queryPatterns = new Map<string, RegExp>();

/**
 * The pattern one search word is matched with, over normalizeForSearch-ed text. A word never
 * matches MID-word ("arm" does not find "alarming" or "Charm"); a short word (<= QUERY_WHOLE_WORD_MAX
 * characters) must be a whole word, give or take a plural or possessive ending ("intel" finds
 * "Intel" and "Intel's", not "intelligence"; "llm" finds "LLMs"); a longer word may be the start of
 * one ("anthrop" finds "Anthropic"). A short word that ends in a LETTER may be followed by a
 * version: "qwen" finds "Qwen4-Max" and "Qwen3.8", "gpt" finds "GPT6" (live 2026-11-20: "qwen"
 * found 5 of the 12 Qwen headlines of the week) - the next character must only not be a letter.
 * Non-global; cached.
 */
export function queryWordPattern(word: string, opts?: QueryMatchOptions): RegExp {
  const whole = !opts?.prefix && [...word].length <= QUERY_WHOLE_WORD_MAX;
  const key = `${whole ? "w" : "p"}:${word}`;
  let re = queryPatterns.get(key);
  if (!re) {
    const versioned = /\p{L}$/u.test(word);
    const end = whole ? `(?:'s|s|es)?(?!${versioned ? "\\p{L}" : WORD_CHAR})` : "";
    re = new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(word)}${end}`, "u");
    // Search-as-you-type compiles a few patterns per keystroke; the cache only has to stay small.
    if (queryPatterns.size >= 256) queryPatterns.clear();
    queryPatterns.set(key, re);
  }
  return re;
}

/**
 * True when EVERY word (from parseQuery) is found in the haystack (already normalizeForSearch-ed),
 * each by the rule of queryWordPattern. False for an empty word list.
 */
export function matchesQuery(normalizedHaystack: string, words: readonly string[], opts?: QueryMatchOptions): boolean {
  if (words.length === 0) return false;
  for (const w of words) if (!queryWordPattern(w, opts).test(normalizedHaystack)) return false;
  return true;
}
