// Story similarity: IDF-weighted token cosine on title + the first 200 chars of the summary, plus
// the guards that decide whether two items - or two growing clusters - may be one story.
//
// V1 compared title token SETS (Jaccard >= 0.4) against a cluster's lead only. That cannot see
// that "Anthropic starts trading on Wall Street" and "Anthropic raises $81bn in record IPO" are
// one story, and it does merge "llama.cpp b12549 released" with "llama_index v0.14.26 released".
// Here every item is a sparse unit vector weighted by the run's own corpus, a cluster is the sum
// of its members' vectors (its centroid), and a merge has to pass these independent tests:
//
//   1. compatible  - 72 h window; release lines only with releases of the same repo
//   2. in common   - two shared title "units", at least one more specific than an event-type word
//   3. products    - two sides about different versioned products never merge (distinctProducts),
//                    nor two sides about different listed companies (distinctSubjects), nor two
//                    sides that share only a name the whole run is full of (sharesOnlyUbiquitous)
//   4. cosine      - centroid cosine >= a threshold that is stricter for one publisher and eases
//                    as a story becomes established (two publishers found by ONE search feed need
//                    more in common instead - see mergeScore); a pair just under the bar may still
//                    merge on a word nobody else in the run uses (corroborated)
//   5. (URL identity short-circuits all of the above)
//
// Everything here is a pure function of its arguments. Every tunable lives in CLUSTER.

import type { PublisherId, SourceId } from "../../../shared/contract";
import { STOPWORDS, tokenize } from "../../../shared/text";
import { HOUR_MS, parseMs } from "../../../shared/time";
import { urlKey } from "../../../shared/url";
import type { NormalizedItem } from "../types";

export interface ClusterParams {
  /** A cluster never spans more than this (so items further apart never merge). */
  windowHours: number;
  /** Characters of the summary that contribute tokens. */
  summaryChars: number;
  /** Weight of a token that appears in the summary prefix but not in the title (title tokens weigh 1). */
  summaryWeight: number;
  /** Weight of a money token ("usd500m") relative to a word: amounts corroborate a story but do not identify it. */
  moneyWeight: number;
  /**
   * Tokens seen in fewer documents than this are dropped from the vectors: a token nobody else
   * uses cannot match anything, it only inflates the norm of long headlines. (Keeping one-off
   * title tokens at half weight was measured: one fewer false merge in 54, but the big-story
   * snowball then fails on 3 of 10 thinned corpora instead of 1.)
   */
  minDf: number;
  /** Centroid cosine two single-publisher clusters need to merge. */
  threshold: number;
  /**
   * Threshold when both sides are one and the same publisher (a site's own series / changelog posts
   * look alike by construction).
   */
  samePublisherThreshold: number;
  /**
   * Shared title units two DIFFERENT publishers need when both sides come from one and the same
   * feed (the hits of one search feed share the query's words by construction), unless one
   * headline is contained in the other.
   */
  sameFeedSharedUnits: number;
  /**
   * A story with this many coverage publishers is ESTABLISHED: its centroid is a sharp signature,
   * and the rest of its coverage arrives under headlines whose pairwise overlap is small. The
   * required cosine eases linearly from `threshold` (one publisher) to `attachThreshold` here.
   */
  establishedPublishers: number;
  /** Centroid cosine an established story needs to take in another item or cluster. */
  attachThreshold: number;
  /** Shared title "units" a merge needs - see sharedUnits (one shared name is an entity, not an event). */
  minSharedUnits: number;
  /** Share of a cluster's members that must carry a token for it to describe the cluster. */
  coreTokenShare: number;
  /**
   * Share of a sub-cluster's members that must carry a token (title or summary) for an ESTABLISHED
   * story to recognise it there - see inCommon. Measured identical at 0.01, 0.25 and 0.4.
   */
  attachTextShare: number;
  /** Centroid features kept (strongest first). */
  centroidFeatures: number;
  /** A lead must be at least this close to the story's centroid, relative to the member closest to it. */
  leadCentrality: number;
  /** Safety bound on merge rounds. */
  maxRounds: number;
  /**
   * A versioned product name ("Gemini 4 Neon", "Genie 4") is one a cluster is KNOWN to be about when
   * two of its headlines carry it; one headline is enough while the cluster has at most
   * 1 / productShare items. A value above 1 turns the distinct-product veto off.
   */
  productShare: number;
  /**
   * Corroborated merge (the second pass under `threshold`): the centroid cosine a pair needs when
   * its headlines share a word NO other document of the run uses - see corroborated().
   */
  corroboratedThreshold: number;
  /** ... and the whole pair must lie inside this many hours. */
  corroboratedWindowHours: number;
  /** ... and share this many title units, unless the pair-exclusive word sits inside a shared two-word name. */
  corroboratedSharedUnits: number;
  /** Distinct-subject veto (distinctSubjects): two sides about different listed companies never merge. */
  subjectVeto: boolean;
  /**
   * A shared name carried by more than this share of the run's documents ("nvidia": 127 of 1,463)
   * identifies a company, not a story - see sharesOnlyUbiquitous. 1 = off.
   */
  ubiquitousShare: number;
  /** ... and by at least this many documents (a small run has no ubiquitous names: 3 of 60 is a story, not a subject). */
  ubiquitousMinDocs: number;
  /** ... unless the headlines share this many units. */
  ubiquitousSharedUnits: number;
}

/**
 * Tuned on test/fixtures/items-2026-11-19.json (1,318 items) against 56 hand-labelled same-story
 * pairs and 54 different-story pairs; index.test.ts pins them. Measured around the chosen values,
 * one parameter varied at a time:
 *
 *                        same-story kept   different merged   Anthropic IPO story
 *   threshold 0.34            52/56             11/54           16 publishers
 *   threshold 0.36-0.38       52/56              5/54           16
 *   threshold 0.40  <-        52/56              2/54           16 publishers, 32 items
 *   threshold 0.42            47/56              1/54           16
 *   threshold 0.44            43/56              0/54           16
 *   summaryWeight 0           49/56             10/54           13
 *   summaryWeight 0.6         43/56              1/54            4  (the story falls apart)
 *   minDf 1                   40/56              1/54            6
 *   minDf 3                   46/56              6/54           14
 *   moneyWeight 1             52/56              3/54           16
 *   establishedPublishers 8   51/56              1/54            7
 *   attachThreshold 0.30      51/56              1/54            6
 *
 * So 0.40 is where precision stops improving cheaply: every 0.02 above it costs 4-5 real pairs
 * for one false merge, and below it false merges triple. Robustness, same values: with the
 * per-source cap of 8 the IPO story keeps 12 publishers; on ten random 70 % samples of the corpus
 * it has a median of 13 publishers (minimum 4), against a median of 6 at threshold 0.44.
 *
 * Tried and dropped because they did not measurably help: title bigrams as vector features, a
 * "one name = one token" collocation discount, keeping one-off title tokens at half weight.
 *
 * Fix round 2026-11-20 (replay of the live build, 1,370 items, plus the fixture): the thresholds
 * above are unchanged - at 0.39 one more real pair merges and three false ones do. Four narrow
 * rules were added instead, each measured on both corpora (fixture after all four: 58/62 recall,
 * 1/54 false merges, IPO story 16 publishers / 32 items):
 *   - calendar tokens and advisory template words are not shared evidence (five Splunk / Cisco
 *     advisories were one row; two METR reports were one story);
 *   - an aggregator's "(Author/Outlet)" tail is not part of its headline (clusterTitle);
 *   - two publishers found by one search feed are two origins, held to `sameFeedSharedUnits`;
 *   - an established story finds its event word in `attachTextShare` of a sub-cluster's members
 *     (the IPO story and five "Wall Street" headlines were TOP #1 and #4).
 *
 * Final fix round 2026-11-20 (replay of the 02:24Z build, 1,468 items, plus the fixture), thresholds
 * again unchanged. Two more narrow rules, each with zero collateral on both corpora:
 *   - distinct-product veto (distinctProducts): the "Gemini 4 Neon" story lost its three "Genie 4"
 *     items and the "Gemini 4 Hydrogen" robotics item (16 items / 8 publishers -> 12 / 7, plus a
 *     Genie 4 story of 3 / 2); no other cluster changed, live or fixture. A veto on ANY differing
 *     versioned name was measured first and rejected: it split "NVL72 ... MLPerf Endpoints v1.0"
 *     from the MLPerf story and, before one-off names were dropped, "Patch 11 Java Flaws" from
 *     Java4Shell;
 *   - corroborated second pass (corroborated): +2 merges live (AI Safety Caucus Record / Techmeme
 *     0.325, GAO terrorist-attack tests Nextgov / Washington Post 0.295), +1 on the fixture (the
 *     Nasdaq debut, Bloomberg / Techmeme 0.359), 0 false merges among the 54 labelled different
 *     pairs and in the full diff of both corpora.
 * Still open, with no safe rule found: China chip sales (FT / Reuters 0.244: they share "sale" and
 * "chip" only, while "US signed off on sales of ... chips ..., House committee says" / "Alibaba
 * accelerates pivot to in-house chips after reporting jump in sales" share three units at 0.245),
 * the OpenAI e-mail agent pair (0.26) and the pairs in KNOWN_MISSES.
 *
 * Closing round 2026-11-20 (replay of the 04:16Z build, 1,463 items, plus the fixture), thresholds
 * unchanged again. Three false merges sat on homepage lists, each just over the 0.40 bar; three
 * narrow rules, measured one at a time on both corpora (fixture after all three: 58/62 recall, 1/54
 * false merges, IPO story 16 publishers / 32 items - identical partitions before and after):
 *   - distinct-subject veto (distinctSubjects): SCMP's Nvidia short-seller story no longer leads The
 *     Information's and CNBC's AMD short-seller reports (0.455); nothing else changes;
 *   - regions are context (isRegionToken): the two Schneider Electric / "Europe" items split (0.404);
 *     nothing else changes. With countries on the list the two AMD reports lose "China" as a unit;
 *   - entity-only veto (sharesOnlyUbiquitous) + inquiry words as event-type words: "NVIDIA
 *     investigating ... ransomware breach claims" / "The SEC Is Investigating Nvidia" split (0.418),
 *     AND the 12-publisher "Nvidia board not weighing Huang's return" story - a week's saga held
 *     together by "nvidia", "jensen", "huang" - becomes its events: the board / return story (5
 *     publishers, 9 items), the SEC inquiry (5 / 8, which the lone WSJ item now joins), the pay
 *     raises (2 / 2) and four single items. Identical at ubiquitousShare 0.02, 0.03 and 0.04; at
 *     0.05 "huang" (4.7 % of the run) is no longer ubiquitous and only the first pair splits.
 *     A 24 h / 30 h time-gap rule was measured first and rejected: it also split the Fable 5.2
 *     story (6 publishers), GlobalFoundries / Atlas and ORNL / IBM / AMD on the fixture.
 */
export const CLUSTER: ClusterParams = {
  windowHours: 72,
  summaryChars: 200,
  summaryWeight: 0.4,
  moneyWeight: 0.5,
  minDf: 2,
  threshold: 0.4,
  samePublisherThreshold: 0.7,
  establishedPublishers: 6,
  attachThreshold: 0.25,
  minSharedUnits: 2,
  sameFeedSharedUnits: 3,
  coreTokenShare: 0.5,
  attachTextShare: 0.25,
  centroidFeatures: 40,
  leadCentrality: 0.8,
  maxRounds: 12,
  productShare: 0.25,
  corroboratedThreshold: 0.29,
  corroboratedWindowHours: 24,
  corroboratedSharedUnits: 3,
  subjectVeto: true,
  ubiquitousShare: 0.03,
  ubiquitousMinDocs: 40,
  ubiquitousSharedUnits: 3,
};

// ------------------------------------------------------------------------------------------------
// Tokens
// ------------------------------------------------------------------------------------------------

/**
 * Words (as stemmed by `stem`) that say WHAT KIND of event a headline reports, not which one:
 * "X raises $300M Series C at $3B valuation" / "Y raises $500M Series A at $3.5B valuation" and
 * "Drupal patches critical RCE flaw" / "PHP fixes 7 critical flaws" share several of them and no
 * name. They stay in the vectors (two reports of ONE funding round do share them), but a merge
 * must also share at least one token that is not on this list.
 */
export const EVENT_TYPE_WORDS: ReadonlySet<string> = new Set([
  // funding
  "raise", "raised", "funding", "round", "sery", "valuation", "investment", "investor",
  // security
  "critical", "flaw", "vulnerability", "bug", "patch", "fix", "rce", "exploit", "exploited", "attack", "attacker", "hacker", "security",
  // launches
  "launch", "launched", "unveil", "debut", "ship", "open", "source",
  // vendor advisory templates ("<X> Vulnerabilities Affecting Cisco Products: November 2026")
  "affecting", "product", "advisory",
  // inquiries ("NVIDIA investigating ... breach claims" / "The SEC Is Investigating Nvidia")
  "investigating", "investigate", "investigation", "probe", "probing",
]);

// Calendar tokens: a year or a month name ("may" is a stopword already). Two vendor advisories
// titled "... November 2026" or two reports "(October 2026)" share a date, not an event, so a
// calendar token is never a shared unit, never part of a shared name and never the specific token.
// Version numbers ("4", "6.2") and long ids ("114938") are NOT calendar tokens. Vectors keep them all.
const CALENDAR_RE = /^(?:(?:19|20)\d{2}|january|february|march|april|june|july|august|september|october|november|december)$/;
export const isCalendarToken = (token: string): boolean => CALENDAR_RE.test(token);

// Continents and regions: where a story is set, not which story it is. "Schneider Electric's VC fund
// brings accelerator scheme to Europe" / "Schneider Electric warns high power costs could push AI
// investment out of Europe" share one company and one continent - an entity, not an event - and were
// one MARKETS row (live 2026-11-20, cosine 0.404). Like a calendar token, a region is never a shared
// unit and never the specific token; the vectors keep it. Countries are NOT here: "China", "Taiwan"
// or "UK" is the actor of a headline as often as its setting, and without them as a unit the two
// AMD short-seller reports and the chip-export stories no longer find each other (measured).
export const REGION_TOKENS: ReadonlySet<string> = new Set(["europe", "asia", "africa", "america", "americas", "apac", "emea", "worldwide", "global", "globally"]);
export const isRegionToken = (token: string): boolean => REGION_TOKENS.has(token);

/** A token that says when or where, never what: no shared unit, no shared name, not the specific token. */
export const isContextToken = (token: string): boolean => isCalendarToken(token) || isRegionToken(token);

// Words that carry no story identity at all. IDF already discounts them; removing them also keeps
// them out of the shared-title rule ("X released" / "Y released" have nothing in common).
const NEWS_FILLER: ReadonlySet<string> = new Set([
  "release", "released", "releases", "update", "updates", "updated", "version", "announces", "announce", "announced",
  "introducing", "introduces", "available", "now", "report", "reports", "reportedly", "says", "today", "week", "year",
  "latest", "amid", "model", "models", "using", "use", "used", "make", "makes", "made", "get", "gets", "one", "two",
  "first", "show", "hn", "ask",
]);
const CLUSTER_STOPWORDS: ReadonlySet<string> = new Set([...STOPWORDS, ...NEWS_FILLER]);

const MONEY_RE = /\$\s?(\d+(?:[.,]\d+)?)\s?(tn|trillion|bn|billion|mn|million|[tbmk])\b/gi;
const MONEY_UNIT: Readonly<Record<string, string>> = { tn: "t", trillion: "t", t: "t", bn: "b", billion: "b", b: "b", mn: "m", million: "m", m: "m", k: "k" };

/** "$2 trillion" / "$2tn" / "$2T" -> "usd2t"; "$3.5 billion" -> "usd3.5b". One token per amount, whatever the outlet's style. */
export function normalizeMoney(text: string): string {
  return text.replace(MONEY_RE, (_m, num: string, unit: string) => ` usd${Number(num.replace(",", "."))}${MONEY_UNIT[unit.toLowerCase()]} `);
}

const isMoney = (token: string): boolean => /^usd\d/.test(token);

// Spelled-out forms of an acronym that headlines use interchangeably. Deliberately tiny: only exact
// equivalents belong here (never "shares" or "trading" for "ipo").
const ALIASES: readonly [RegExp, string][] = [
  [/\binitial public offerings?\b/gi, "ipo"],
  [/\bi\.p\.o\.?(?=\W|$)/gi, "ipo"],
];

export function applyAliases(text: string): string {
  let out = text;
  for (const [re, to] of ALIASES) out = out.replace(re, to);
  return out;
}

/** Plural / third-person "s" only ("shares" -> "share", "launches" -> "launch"); versions and identifiers are left alone. */
export function stem(token: string): string {
  if (token.length <= 3 || /[\d._]/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Tokens used for clustering, in text order: shared tokenizer + aliases + money normalisation + filler removal + light stemming. */
export function clusterTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return tokenize(normalizeMoney(applyAliases(text)), { stopwords: CLUSTER_STOPWORDS }).map(stem);
}

export interface Features {
  /** Distinct title tokens. */
  title: Set<string>;
  /** Distinct tokens of the summary prefix that are not in the title. */
  summary: Set<string>;
  /** Adjacent title token pairs, "a b" (used by the shared-units rule, not by the vectors). */
  bigrams: Set<string>;
  /** Versioned product names the headline carries (productsOf). */
  products: Product[];
  /** Title tokens the headline writes in lower case: ordinary words, not names (lowerCaseTokens). */
  common: Set<string>;
}

// Trailing byline of an aggregator headline: "... (Mark Gurman/Bloomberg)". The names would sit in
// the vector as title tokens and pull the item away from the story it links to.
const AGGREGATOR_BYLINE_RE = /\s*\([^()]{1,80}\/[^()]{1,80}\)\s*$/;

/**
 * The headline as clustering reads it. Only AGGREGATOR items lose a trailing "(Author/Outlet)":
 * a press title may end in "(CVE-2026-116606 / CVE-2026-111560)", and those ids identify the story.
 * The displayed title is never changed.
 */
export function clusterTitle(item: Pick<NormalizedItem, "title"> & Partial<Pick<NormalizedItem, "kind">>): string {
  return item.kind === "aggregator" ? item.title.replace(AGGREGATOR_BYLINE_RE, "") : item.title;
}

// ------------------------------------------------------------------------------------------------
// Versioned product names
// ------------------------------------------------------------------------------------------------

/**
 * A versioned product a headline names: the word right before a version number, the version, and
 * the capitalised codename right after it, if any.
 *   "Introducing Gemini 4 Neon"   -> gemini 4 neon        "Claude Fable 5.2 is ..." -> fable 5.2
 *   "Genie 4 is now available"    -> genie 4              "GPT-6.2 Astra and Sol"   -> gpt 6.2 astra, gpt 6.2 sol
 */
export interface Product {
  family: string;
  version: string;
  codename: string | null;
}

// The family word is capitalised (or one lower-case letter glued to the number: "o5"); the version
// has one or two digits before an optional decimal and ends there, so years, CVE ids, build numbers
// ("b12557"), semver triples ("0.33.0"), ranges ("26-24", "17/26"), sizes ("27B"), names with a
// digit inside ("Java4Shell"), money and percentages are never versions. "Fable and Mythos 5.2"
// names two families of one version.
const PRODUCT_RE = /(?<![\p{L}\p{N}$€£#.'’/-])(?:(\p{Lu}\p{L}+)\s+(?:and|&)\s+)?(\p{Lu}\p{L}*|[a-z](?=\d))[ -]?v?(\d{1,2}(?:\.\d{1,2})?)(?![\p{L}\p{N}%]|[.,/-]\d)/gu;
const CODENAME_RE = /^[ -](\p{Lu}[\p{L}\p{N}]+)/u;
const NEXT_CODENAME_RE = /^\s*(?:,|and|&)\s*(\p{Lu}\p{L}+)(?![ -]?\d)/u;
// "Fixes 7 Critical Flaws", "Top 10", "With 12 Partners", "November 19", "Series 7": a count or a
// label, not a product. Third-person verbs ("Fixes", "Warns") are tested by rule; what is left of
// the kind ("Patch 11 Java Flaws") is a one-off, and buildDocs drops names only one document has.
const NOT_A_FAMILY: ReadonlySet<string> = new Set([
  "top", "series", "phase", "part", "day", "week", "level", "tier", "section", "chapter", "rule", "article", "number", "step",
  "stage", "round", "group", "type", "class", "season", "episode", "volume", "vol", "issue", "page", "age", "grade",
  "version", "item", "table", "title", "under", "around", "nearly", "almost", "least", "only", "another", "fy", "cop",
]);
// What follows a count, not a version: a unit or a quantifier ("4 new models", "2 years", "12 GB").
const COUNT_AFTER_RE = /^\s?(?:percent|x|k|m|b|bn|mn|tn|gb|tb|mb|gw|mw|kw|nm|hrs?|hours?|days?|weeks?|months?|years?|yrs?|million|billion|trillion|times|new|more|other|of|per|people|things|ways|reasons|critical|major|key)(?![\p{L}\p{N}])/iu;
// Words that follow a product name in a Title Case headline without being part of it.
const NOT_A_CODENAME: ReadonlySet<string> = new Set([
  "model", "api", "preview", "beta", "review", "launch", "release", "update", "vs", "world", "leak", "pricing", "weights",
  "benchmark", "benchmarks", "rumors", "open", "live", "day", "era", "and", "or", "with", "for", "in", "on", "at", "to", "by",
  "is", "are", "was", "has", "will", "can", "now", "the", "a", "an", "as", "from", "over", "after", "amid", "but",
]);

const isVerbLike = (word: string): boolean => word.length > 3 && word.endsWith("s") && !/(?:ss|us|is|as|os)$/.test(word);
const versionKey = (v: string): string => v.replace(/\.0$/, "");

/** Versioned product names in a headline, in text order (see Product). Reads the headline as written: case matters. */
export function productsOf(title: string | null | undefined): Product[] {
  if (!title) return [];
  const text = title.normalize("NFKC");
  const out: Product[] = [];
  const isFamily = (word: string): boolean => !(STOPWORDS.has(word) || NEWS_FILLER.has(word) || NOT_A_FAMILY.has(word) || isCalendarToken(word) || isVerbLike(word));
  for (const m of text.matchAll(PRODUCT_RE)) {
    const family = m[2].toLowerCase();
    if (!isFamily(family)) continue;
    let rest = text.slice(m.index + m[0].length);
    if (COUNT_AFTER_RE.test(rest)) continue;
    const version = versionKey(m[3]);
    const sibling = m[1]?.toLowerCase();
    if (sibling && isFamily(sibling)) out.push({ family: sibling, version, codename: null });
    const codenames: string[] = [];
    const first = CODENAME_RE.exec(rest);
    const name = first?.[1].toLowerCase();
    if (first && name && !NOT_A_CODENAME.has(name) && !isVerbLike(name)) {
      codenames.push(name);
      rest = rest.slice(first[0].length);
      // "GPT-6.2 Astra and Sol", "Astra, Sol and Luna": one launch, several codenames.
      for (let next = NEXT_CODENAME_RE.exec(rest); next; next = NEXT_CODENAME_RE.exec(rest)) {
        const more = next[1].toLowerCase();
        if (NOT_A_CODENAME.has(more) || isVerbLike(more)) break;
        codenames.push(more);
        rest = rest.slice(next[0].length);
      }
    }
    if (codenames.length === 0) out.push({ family, version, codename: null });
    else for (const codename of codenames) out.push({ family, version, codename });
  }
  return out;
}

export const productKey = (p: Product): string => `${p.family} ${p.version}${p.codename ? ` ${p.codename}` : ""}`;
const productLine = (p: Product): string => `${p.family} ${p.version}`;

/** Two names of one product: same family and version, and the codenames agree or one headline gives none. */
export function sameProduct(a: Product, b: Product): boolean {
  return a.family === b.family && a.version === b.version && (a.codename === null || b.codename === null || a.codename === b.codename);
}

// A headline word written in lower case is an ordinary word; a capitalised one may be a name. Used
// by the corroborated merge: a rare shared NAME ("Quandela") recurs across a company's unrelated
// stories, a rare shared ordinary word ("caucus", "terrorist") names the event.
const CAPITALISED_WORD_RE = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}.'’_-]*/gu;

/** Cluster tokens of the words a headline writes in lower case. */
export function lowerCaseTokens(title: string | null | undefined): Set<string> {
  if (!title) return new Set();
  return new Set(clusterTokens(title.normalize("NFKC").replace(CAPITALISED_WORD_RE, " ")));
}

export function featuresOf(item: Pick<NormalizedItem, "title" | "summary"> & Partial<Pick<NormalizedItem, "kind">>, params: ClusterParams = CLUSTER): Features {
  const titleTokens = clusterTokens(clusterTitle(item));
  const title = new Set(titleTokens);
  const summary = new Set<string>();
  for (const t of clusterTokens((item.summary ?? "").slice(0, params.summaryChars))) if (!title.has(t)) summary.add(t);
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < titleTokens.length; i++) bigrams.add(`${titleTokens[i]} ${titleTokens[i + 1]}`);
  const headline = clusterTitle(item);
  return { title, summary, bigrams, products: productsOf(headline), common: lowerCaseTokens(headline) };
}

// ------------------------------------------------------------------------------------------------
// Vectors
// ------------------------------------------------------------------------------------------------

export type SparseVec = Map<string, number>;

/** Number of documents each token occurs in. */
export function documentFrequency(docs: readonly Iterable<string>[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}

export type Idf = (token: string) => number;

/** Smoothed IDF over the run's own documents, ln(1 + N / df); 0 for tokens seen in fewer than `minDf` documents. */
export function buildIdf(docs: readonly Iterable<string>[], minDf: number = CLUSTER.minDf): Idf {
  const df = documentFrequency(docs);
  const n = docs.length;
  return (token) => {
    const d = df.get(token) ?? 0;
    return d < minDf ? 0 : Math.log(1 + n / d);
  };
}

export function norm(v: SparseVec): number {
  let s = 0;
  for (const w of v.values()) s += w * w;
  return Math.sqrt(s);
}

/** Cosine of two sparse vectors (0 when either is empty). */
export function cosine(a: SparseVec, b: SparseVec): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [f, w] of small) {
    const o = large.get(f);
    if (o !== undefined) dot += w * o;
  }
  if (dot === 0) return 0;
  return dot / (norm(a) * norm(b));
}

/** Unit vector of an item: title tokens x idf, summary-only tokens x idf x summaryWeight; money tokens x moneyWeight. */
export function vectorize(features: Pick<Features, "title" | "summary">, idf: Idf, params: ClusterParams = CLUSTER): SparseVec {
  const v: SparseVec = new Map();
  const put = (token: string, weight: number): void => {
    const w = idf(token) * weight * (isMoney(token) ? params.moneyWeight : 1);
    if (w > 0) v.set(token, w);
  };
  for (const t of features.title) put(t, 1);
  for (const t of features.summary) put(t, params.summaryWeight);
  const n = norm(v);
  if (n > 0) for (const [f, w] of v) v.set(f, w / n);
  return v;
}

/** One item prepared for clustering. */
export interface Doc {
  item: NormalizedItem;
  /** effectiveAt in epoch ms. */
  ms: number;
  /** Exact-URL identity key (scheme-less, www-less canonical URL). */
  urlKey: string | null;
  /** Synthesized GitHub release line: clusters only with the same repo. */
  release: boolean;
  features: Features;
  /** Unit vector. */
  vec: SparseVec;
  /** Documents of the run each token occurs in (title or summary prefix). One map, shared by every Doc. */
  df: ReadonlyMap<string, number>;
  /** Number of documents in the run. */
  docs: number;
}

/** Items -> Docs. The IDF is built over exactly these items (the run's corpus). */
export function buildDocs(items: readonly NormalizedItem[], params: ClusterParams = CLUSTER): Doc[] {
  const features = items.map((item) => featuresOf(item, params));
  const texts = features.map((f) => [...f.title, ...f.summary]);
  const idf = buildIdf(texts, params.minDf);
  const df = documentFrequency(texts);
  // A versioned name only ONE document of the run carries is as likely a count ("Patch 11 Java
  // Flaws") as a product, and it cannot tell two stories apart anyway: it is dropped.
  const lines = documentFrequency(features.map((f) => f.products.map(productLine)));
  for (const f of features) f.products = f.products.filter((p) => (lines.get(productLine(p)) ?? 0) >= 2);
  return items.map((item, i) => ({
    item,
    ms: parseMs(item.effectiveAt) ?? 0,
    urlKey: urlKey(item.url),
    release: item.flags.includes("release"),
    features: features[i],
    vec: vectorize(features[i], idf, params),
    df,
    docs: items.length,
  }));
}

// ------------------------------------------------------------------------------------------------
// The shared-title rule
// ------------------------------------------------------------------------------------------------

export function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n++;
  return n;
}

/**
 * How many independent things two title-token sets have in common. A shared two-word name
 * ("hugging face", "gemini 4", "prompt injection") is ONE unit, not two, so sharing a name alone
 * never satisfies a "two units" rule; a shared run of three or more tokens ("gemini 4 neon") is
 * specific enough to count as two. Calendar tokens ("november", "2026") count for nothing.
 */
export function sharedUnits(tokensA: ReadonlySet<string>, bigramsA: ReadonlySet<string>, tokensB: ReadonlySet<string>, bigramsB: ReadonlySet<string>): number {
  let tokens = 0;
  for (const t of tokensA) if (tokensB.has(t) && !isContextToken(t)) tokens++;
  if (tokens === 0) return 0;
  let bigrams = 0;
  for (const g of bigramsA) if (bigramsB.has(g) && !g.split(" ").some(isContextToken)) bigrams++;
  return tokens - bigrams + (bigrams >= 2 ? 1 : 0);
}

/**
 * True when one headline is (almost) contained in the other: "Vercel Board is now available" /
 * "Introducing Vercel Board", "llama.cpp v1.0.0" / "llama.cpp v1.0.0: a stronger foundation ...".
 * Such pairs share one name and nothing else BECAUSE there is nothing else.
 */
export function nearlyContained(tokensA: ReadonlySet<string>, tokensB: ReadonlySet<string>, share = 0.8): boolean {
  const small = Math.min(tokensA.size, tokensB.size);
  return small >= 2 && sharedCount(tokensA, tokensB) >= share * small;
}

function sharesSpecificToken(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t) && !EVENT_TYPE_WORDS.has(t) && !isMoney(t) && !isContextToken(t)) return true;
  return false;
}

/**
 * The shared-title rule every merge must pass: two shared units (or one headline contained in the
 * other), at least one shared token being more specific than an event-type word, an amount or a
 * date ("X raises $50M" / "Y raises $50M" are two rounds).
 */
export function enoughInCommon(tokensA: ReadonlySet<string>, bigramsA: ReadonlySet<string>, tokensB: ReadonlySet<string>, bigramsB: ReadonlySet<string>, minUnits: number = CLUSTER.minSharedUnits): boolean {
  if (!sharesSpecificToken(tokensA, tokensB)) return false;
  return sharedUnits(tokensA, bigramsA, tokensB, bigramsB) >= minUnits || nearlyContained(tokensA, tokensB);
}

// ------------------------------------------------------------------------------------------------
// Clusters as profiles: what a merge decision needs to know about a set of items
// ------------------------------------------------------------------------------------------------

type Counts = Map<string, number>;

/** A set of items (one item or a growing cluster), summarised for merge decisions. */
export interface Profile {
  /** Number of items. */
  size: number;
  /** Sum of the members' unit vectors. */
  sum: SparseVec;
  /** Strongest features of `sum`, unit length. */
  centroid: SparseVec;
  minMs: number;
  maxMs: number;
  publishers: Set<PublisherId>;
  /** Publishers of the members that count as coverage. */
  coverage: Set<PublisherId>;
  sources: Set<SourceId>;
  /** Release lines: holds only releases of one repo. */
  release: boolean;
  /** Title token / title bigram / title-or-summary token -> number of members that have it. */
  titleCounts: Counts;
  bigramCounts: Counts;
  textCounts: Counts;
  /** Tokens a majority of the members carry in the title / as a title bigram / in title or summary. */
  coreTokens: Set<string>;
  coreBigrams: Set<string>;
  coreText: Set<string>;
  /**
   * productKey -> number of members whose headline names that product AND no other product line. A
   * digest or comparison ("Gemini 4 Neon 🚀, Genie 4 worlds 🌍", "Fable 5.2 and GPT-6.2 Astra at real
   * work") may join either story but never teaches a story that it is about the other product.
   */
  productCounts: Counts;
  /** The products behind productCounts' keys. */
  products: Map<string, Product>;
  /** A single item: every product its headline names. Null once two items have merged. */
  ownProducts: readonly Product[] | null;
  /** Title tokens at least one member writes in lower case. */
  common: Set<string>;
  /** Doc.df and Doc.docs of the run. */
  df: ReadonlyMap<string, number>;
  docs: number;
}

function countOnce(tokens: Iterable<string>): Counts {
  const counts: Counts = new Map();
  for (const t of tokens) counts.set(t, 1);
  return counts;
}

function addCounts(a: Counts, b: Counts): Counts {
  const out = new Map(a);
  for (const [t, n] of b) out.set(t, (out.get(t) ?? 0) + n);
  return out;
}

/** Tokens carried by a majority of the members (by both members of a pair). */
function majority(counts: Counts, size: number, share: number): Set<string> {
  const need = Math.max(Math.min(size, 2), Math.ceil(size * share));
  const out = new Set<string>();
  for (const [t, n] of counts) if (n >= need) out.add(t);
  return out;
}

function strongest(sum: SparseVec, keep: number): SparseVec {
  const entries = [...sum.entries()];
  if (entries.length > keep) {
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    entries.length = keep;
  }
  const v: SparseVec = new Map(entries);
  const n = norm(v);
  if (n > 0) for (const [f, w] of v) v.set(f, w / n);
  return v;
}

export function profileOf(doc: Doc): Profile {
  const { title, summary, bigrams } = doc.features;
  const text = new Set([...title, ...summary]);
  const focused = new Set(doc.features.products.map(productLine)).size === 1 ? doc.features.products : [];
  return {
    size: 1,
    sum: new Map(doc.vec),
    centroid: doc.vec,
    minMs: doc.ms,
    maxMs: doc.ms,
    publishers: new Set([doc.item.publisher]),
    coverage: new Set(doc.item.countsForCoverage ? [doc.item.publisher] : []),
    sources: new Set([doc.item.sourceId]),
    release: doc.release,
    titleCounts: countOnce(title),
    bigramCounts: countOnce(bigrams),
    textCounts: countOnce(text),
    coreTokens: title,
    coreBigrams: bigrams,
    coreText: text,
    productCounts: countOnce(focused.map(productKey)),
    products: new Map(focused.map((p) => [productKey(p), p])),
    ownProducts: doc.features.products,
    common: doc.features.common,
    df: doc.df,
    docs: doc.docs,
  };
}

/** The profile of the union of two disjoint sets of items. */
export function mergeProfiles(a: Profile, b: Profile, params: ClusterParams = CLUSTER): Profile {
  const sum: SparseVec = new Map(a.sum);
  for (const [f, w] of b.sum) sum.set(f, (sum.get(f) ?? 0) + w);
  const size = a.size + b.size;
  const titleCounts = addCounts(a.titleCounts, b.titleCounts);
  const bigramCounts = addCounts(a.bigramCounts, b.bigramCounts);
  const textCounts = addCounts(a.textCounts, b.textCounts);
  return {
    size,
    sum,
    centroid: strongest(sum, params.centroidFeatures),
    minMs: Math.min(a.minMs, b.minMs),
    maxMs: Math.max(a.maxMs, b.maxMs),
    publishers: new Set([...a.publishers, ...b.publishers]),
    coverage: new Set([...a.coverage, ...b.coverage]),
    sources: new Set([...a.sources, ...b.sources]),
    release: a.release && b.release,
    titleCounts,
    bigramCounts,
    textCounts,
    coreTokens: majority(titleCounts, size, params.coreTokenShare),
    coreBigrams: majority(bigramCounts, size, params.coreTokenShare),
    coreText: majority(textCounts, size, params.coreTokenShare),
    productCounts: addCounts(a.productCounts, b.productCounts),
    products: new Map([...a.products, ...b.products]),
    ownProducts: null,
    common: new Set([...a.common, ...b.common]),
    df: a.df,
    docs: a.docs,
  };
}

function only<T>(set: ReadonlySet<T>): T | null {
  if (set.size !== 1) return null;
  for (const v of set) return v;
  return null;
}

/** Test 1: release lines only with releases of the same repo; nothing may stretch a cluster past the window. */
export function compatible(a: Profile, b: Profile, params: ClusterParams = CLUSTER): boolean {
  if (a.release || b.release) return a.release && b.release && only(a.publishers) !== null && only(a.publishers) === only(b.publishers);
  return Math.max(a.maxMs, b.maxMs) - Math.min(a.minMs, b.minMs) <= params.windowHours * HOUR_MS;
}

/** One and the same publisher on both sides. */
export function sameOrigin(a: Profile, b: Profile): boolean {
  const pa = only(a.publishers);
  return pa !== null && pa === only(b.publishers);
}

/** One and the same feed on both sides, but not one publisher: two outlets found by one search feed. */
export function sameFeedOnly(a: Profile, b: Profile): boolean {
  const sa = only(a.sources);
  return sa !== null && sa === only(b.sources) && !sameOrigin(a, b);
}

/**
 * Test 2 on the tokens a majority of each side's headlines carry. An established story is also
 * matched against the other side's summaries: its coverage keeps arriving under headlines that
 * name the subject and leave the event to the first paragraph ("Anthropic starts trading on Wall
 * Street"). When such headlines have already merged with EACH OTHER, the event word ("ipo") may be
 * carried by a minority of that sub-cluster (2 of 5), so the story's signature is finally looked
 * for among the tokens `attachTextShare` of the other side's members carry. The story's own
 * signature stays the test and the cosine bar is unchanged.
 */
export function inCommon(a: Profile, b: Profile, params: ClusterParams = CLUSTER): boolean {
  if (enoughInCommon(a.coreTokens, a.coreBigrams, b.coreTokens, b.coreBigrams, params.minSharedUnits)) return true;
  const [story, other] = a.coverage.size >= b.coverage.size ? [a, b] : [b, a];
  if (story.coverage.size < params.establishedPublishers) return false;
  if (enoughInCommon(story.coreTokens, story.coreBigrams, other.coreText, other.coreBigrams, params.minSharedUnits)) return true;
  if (other.size < 2) return false; // one item: coreText already is everything it says
  return enoughInCommon(story.coreTokens, story.coreBigrams, majority(other.textCounts, other.size, params.attachTextShare), other.coreBigrams, params.minSharedUnits);
}

/**
 * Test 3's bar: `samePublisherThreshold` for one publisher; otherwise it eases linearly from
 * `threshold` (single-publisher sides) to `attachThreshold` (an established story).
 */
export function requiredCosine(a: Profile, b: Profile, params: ClusterParams = CLUSTER): number {
  if (sameOrigin(a, b)) return params.samePublisherThreshold;
  const publishers = Math.max(a.coverage.size, b.coverage.size);
  const progress = Math.min(1, Math.max(0, (publishers - 1) / Math.max(1, params.establishedPublishers - 1)));
  return params.threshold - (params.threshold - params.attachThreshold) * progress;
}

/**
 * The products a set of items is known to be about: for one item, everything its headline names;
 * for a cluster, the products that two of its single-product headlines carry (one is enough in a
 * cluster of up to `1 / productShare` items).
 */
export function knownProducts(p: Profile, params: ClusterParams = CLUSTER): Product[] {
  if (p.ownProducts) return [...p.ownProducts];
  const need = Math.min(2, Math.max(1, Math.ceil(p.size * params.productShare)));
  const out: Product[] = [];
  for (const [key, n] of p.productCounts) {
    const product = p.products.get(key);
    if (product && n >= need) out.push(product);
  }
  return out;
}

/**
 * Distinct-product veto. Both sides are about a versioned product, no product of one side is a
 * product of the other, and two of them carry the SAME version number under different names:
 * "Genie 4 is now available" / "Gemini 4 Hydrogen takes over ..." against the "Introducing Gemini 4
 * Neon" story (live 2026-11-20: four such items sat inside it at cosine 0.33-0.42). The shared
 * version is the trap - "4" is a title token both sides have - and it is the condition: names with
 * different versions ("NVL72" / "MLPerf Training v6.1") are different KINDS of thing in one story
 * as often as not, and never veto. Headlines that name no version never veto, a bare "Gemini 4"
 * goes with any codename, and a story that launched two codenames together ("GPT-6.2 Astra and
 * Sol") knows both.
 */
export function distinctProducts(a: Profile, b: Profile, params: ClusterParams = CLUSTER): boolean {
  if (params.productShare > 1) return false;
  const ka = knownProducts(a, params);
  const kb = knownProducts(b, params);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka.some((x) => kb.some((y) => sameProduct(x, y)))) return false;
  return ka.some((x) => kb.some((y) => x.version === y.version));
}

/**
 * Companies whose names are the SUBJECT of a headline that names them (cluster tokens). A closed list
 * on purpose: only names that are never an ordinary word, a product or a place, and only the firms
 * whose news is routinely reported under look-alike headlines ("<chipmaker> ... China ties ... short
 * seller"). Regulators, people and products are not subjects in this sense.
 */
export const RIVAL_SUBJECTS: ReadonlySet<string> = new Set([
  "nvidia", "amd", "intel", "tsmc", "qualcomm", "broadcom", "micron", "samsung", "huawei", "smic", "asml",
  "openai", "anthropic", "google", "microsoft", "apple", "amazon", "xai", "mistral", "deepseek", "alibaba", "tencent", "baidu",
  "bytedance", "oracle", "ibm", "softbank", "tesla", "salesforce", "palantir", "coreweave", "perplexity", "cohere", "databricks",
]);

/**
 * Distinct-subject veto. Each side's headlines name a listed company (a majority of them, for a
 * cluster) that the other side never mentions - not in any title, not in any summary lead. Live
 * 2026-11-20: SCMP's "Nvidia faces questions over former No 3's China ties after short seller report"
 * (Muddy Waters on Nvidia, 39 h) led The Information's and CNBC's reports of the Hunterbrook report on
 * AMD (9 h and 4 h) at cosine 0.455 - "china", "tie", "short", "seller" shared - and held TOP #11 as a
 * 3-publisher story. Two reports of ONE event name the same company or mention the other's in the
 * first lines ("OpenRouter Now Powers Inference on Hugging Face" / "Hugging Face and OpenRouter join
 * forces"), so the veto needs BOTH sides to have a subject the other lacks.
 */
export function distinctSubjects(a: Profile, b: Profile, params: ClusterParams = CLUSTER): boolean {
  if (!params.subjectVeto || a.coverage.size === 0 || b.coverage.size === 0) return false;
  const lacks = (from: Profile, other: Profile): boolean => {
    for (const t of from.coreTokens) if (RIVAL_SUBJECTS.has(t) && !other.textCounts.has(t)) return true;
    return false;
  };
  return lacks(a, b) && lacks(b, a);
}

/**
 * Entity-only veto. Every title token the two sides share is an event-type word, an amount, a date,
 * a region, or a name so common in this run that it identifies nothing (more than `ubiquitousShare` of
 * the documents carry it, and at least `ubiquitousMinDocs`), and the headlines share fewer than `ubiquitousSharedUnits` units: "NVIDIA
 * investigating Gentlemen ransomware breach claims" (BleepingComputer) and "The SEC Is Investigating
 * Nvidia" (WSJ, 35 h earlier) share the week's most-named company and a verb, and were one CYBER row
 * with two publishers at cosine 0.418 (live 2026-11-20). An established story is exempt (its late
 * coverage is what attachThreshold is for), and so is a headline contained in the other.
 */
export function sharesOnlyUbiquitous(a: Profile, b: Profile, params: ClusterParams = CLUSTER): boolean {
  if (params.ubiquitousShare >= 1) return false;
  if (Math.max(a.coverage.size, b.coverage.size) >= params.establishedPublishers) return false;
  const limit = Math.max(params.ubiquitousShare * a.docs, params.ubiquitousMinDocs - 1);
  for (const t of a.coreTokens) {
    if (!b.coreTokens.has(t) || EVENT_TYPE_WORDS.has(t) || isMoney(t) || isContextToken(t)) continue;
    if ((a.df.get(t) ?? 0) <= limit) return false;
  }
  return sharedUnits(a.coreTokens, a.coreBigrams, b.coreTokens, b.coreBigrams) < params.ubiquitousSharedUnits && !nearlyContained(a.coreTokens, b.coreTokens);
}

/**
 * The second pass under the cosine bar. Two young clusters of different origins whose headlines
 * share a word NOBODY else in the run uses, written as an ordinary lower-case word by at least one
 * of them ("caucus", "terrorist" - not a company name, which recurs across unrelated stories), and
 * around it either `corroboratedSharedUnits` shared units or a shared two-word name holding it,
 * inside `corroboratedWindowHours`, at cosine >= `corroboratedThreshold`.
 *
 * Measured 2026-11-20 on the live replay (1,468 items; 966 unmerged pairs at cosine >= 0.22) and
 * the fixture (790): it merges The Record / Techmeme on the AI Safety Caucus (0.325) and Nextgov /
 * Washington Post on the GAO terrorist-attack tests (0.295), and no other pair. Looser forms were
 * measured and rejected: any pair-exclusive word with two shared units also merges a vLLM advisory
 * with a llama.cpp commit ("template") and two unrelated "governed" posts; allowing names merges
 * "CISA nominee ..." with "CISA warns ...". China chip sales (FT / Reuters, 0.244) share only
 * "sale" and "chip", fewer signals than a false pair at the same cosine, and stays split.
 */
export function corroborated(a: Profile, b: Profile, sim: number, params: ClusterParams = CLUSTER): boolean {
  if (sim < params.corroboratedThreshold) return false;
  if (a.release || b.release || sameOrigin(a, b) || sameFeedOnly(a, b)) return false;
  if (Math.max(a.coverage.size, b.coverage.size) >= params.establishedPublishers) return false;
  if (Math.max(a.maxMs, b.maxMs) - Math.min(a.minMs, b.minMs) > params.corroboratedWindowHours * HOUR_MS) return false;
  const units = sharedUnits(a.coreTokens, a.coreBigrams, b.coreTokens, b.coreBigrams);
  for (const t of a.coreTokens) {
    if (!b.coreTokens.has(t) || isCalendarToken(t) || isMoney(t) || EVENT_TYPE_WORDS.has(t) || /^\d/.test(t)) continue;
    if (!a.common.has(t) && !b.common.has(t)) continue;
    // Pair-exclusive: every document of the run that carries the word is inside these two clusters.
    if ((a.df.get(t) ?? 0) !== (a.textCounts.get(t) ?? 0) + (b.textCounts.get(t) ?? 0)) continue;
    if (units >= params.corroboratedSharedUnits) return true;
    for (const g of a.coreBigrams) if (b.coreBigrams.has(g) && g.split(" ").includes(t)) return true;
  }
  return false;
}

/** The centroid cosine of two profiles when they may merge (tests 1-3 pass), else 0. */
export function mergeScore(a: Profile, b: Profile, params: ClusterParams = CLUSTER): number {
  if (!compatible(a, b, params) || !inCommon(a, b, params)) return 0;
  if (distinctProducts(a, b, params) || distinctSubjects(a, b, params) || sharesOnlyUbiquitous(a, b, params)) return 0;
  // One publisher's template headlines differ in exactly the word that matters ("Gemini 4 Carbon is
  // now available in Devin" / "Gemini 4 Hydrogen is ..."), so for one origin the headlines
  // themselves must all but coincide.
  if (sameOrigin(a, b) && !nearlyContained(a.coreTokens, b.coreTokens)) return 0;
  // Two outlets found by ONE search feed ("GN: prompt injection") share the query's words by
  // construction: the normal bar applies, but the headlines must share more than the query.
  if (sameFeedOnly(a, b) && sharedUnits(a.coreTokens, a.coreBigrams, b.coreTokens, b.coreBigrams) < params.sameFeedSharedUnits && !nearlyContained(a.coreTokens, b.coreTokens)) return 0;
  const sim = cosine(a.centroid, b.centroid);
  if (sim >= requiredCosine(a, b, params)) return sim;
  return corroborated(a, b, sim, params) ? sim : 0;
}

/**
 * Similarity of two items in [0, 1] with every guard applied: 1 for the same URL, 0 when they may
 * not be one story (window, release rule, too little in common, cosine under the bar for this pair
 * of publishers), otherwise the cosine.
 */
export function similarity(a: Doc, b: Doc, params: ClusterParams = CLUSTER): number {
  if (a.urlKey !== null && a.urlKey === b.urlKey) return 1;
  return mergeScore(profileOf(a), profileOf(b), params);
}
