// GitHub release feeds: ONE line per repository - its newest stable release of its own package.
//
// V1 (fetch-feeds.ts cleanGitHubReleaseTitle) looked only at the entry title and kept the first
// synthesized entry in feed order, which published false headlines every build:
//   "langchain v0.3.0 released"        raw "langchain-openrouter==0.3.0" (langchain itself was 1.5.2)
//   "sglang v0.1.0 released"           raw "router-v0.1.0"                (sglang was v0.5.23)
//   "codex v0.172.0-alpha.2 released"  an alpha                           (stable was 0.170.0)
//   "ollama v0.40.17 released"         title "v0.40.17" on TAG v0.40.17-rc1
//   "rc0: [Transformers backend] ..."  a commit subject as a headline
// Here the TAG (from the entry link) is parsed into component / version / pre-release, sub-package
// tags are ignored, pre-releases only win when the feed has nothing else, and the highest version
// wins (feed order and Atom <updated> are not release order: an LTS backport is "newest").
//
// Version numbers are only comparable inside ONE tag scheme. A repo that mixes schemes was decided
// by whichever scheme has the biggest number: modelcontextprotocol/servers moved from "2026.8.31"
// to "v2.5.0" and kept announcing the August tag (the security release v2.5.0 never appeared), and
// whisper.cpp's CI tag "b5454" beat "v1.9.5". So the pool is first narrowed to one scheme (tagScheme).

import { parseDate } from "./dates";
import { sanitizeText } from "./text";

export interface ReleaseEntry {
  /** Raw entry title (release name; often just the tag). */
  title: string;
  /** Entry link (.../releases/tag/<url-encoded tag>). */
  link: string;
  publishedRaw: string | null;
}

export interface ParsedTag {
  /** Decoded tag ("langchain-openrouter==0.3.0"). */
  tag: string;
  /** Package / directory prefix of the tag ("langchain-openrouter", "router", "cli-release"); null when the tag is just a version. */
  component: string | null;
  /** Version as written in the tag, suffix included ("v0.34.0rc0", "1.5.2", "b12549", "2026-07-28"); null for unversioned tags. */
  version: string | null;
  /** Numeric parts for ordering ([0, 34, 0], [12549], [2026, 7, 28]). */
  nums: number[];
  /** rc / alpha / beta / dev / nightly / preview / canary ... marker after the version. */
  prerelease: boolean;
}

// Tag prefixes that mean "the repo's own release line" rather than a sub-package.
const GENERIC_MAIN = new Set(["release", "releases", "version", "stable", "main", "latest", "v"]);
// A tag prefix that is a release CHANNEL, not a package ("nightly-v1.2.3").
const CHANNEL_COMPONENTS = new Set(["nightly", "preview", "canary", "dev", "alpha", "beta", "rc", "pre", "snapshot", "next", "experimental"]);

const PRERELEASE_RE = /(?:^|[-._+])(?:rc|alpha|beta|dev|nightly|preview|pre|canary|snapshot|next|insiders?|experimental|unstable)(?:[-._]?\d+)?(?:$|[-._+])|^(?:rc|a|b|alpha|beta|dev|pre)\d+/i;

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "owner/repo" and the tag of a GitHub release URL (either may be null). */
export function parseReleaseUrl(link: string): { repo: string | null; tag: string | null } {
  const m = /github\.com\/([^/?#]+\/[^/?#]+)(?:\/releases\/tag\/([^?#]+))?/i.exec(link);
  if (!m) return { repo: null, tag: null };
  return { repo: m[1], tag: m[2] ? safeDecode(m[2]).trim() || null : null };
}

function splitComponent(tag: string): { component: string | null; rest: string } {
  const patterns: readonly RegExp[] = [
    /^(.+?)==(.+)$/, // langchain-openrouter==0.3.0
    /^(.+)@(v?\d.*)$/, // @scope/pkg@1.2.3
    /^(.+)\/(v?\d.*)$/, // cli-release/v0.0.140
    /^(.+?)[-_](v\d.*)$/i, // router-v0.1.0, sdk-typescript-v0.1.35
    /^([A-Za-z][A-Za-z0-9.]*(?:[-_][A-Za-z][A-Za-z0-9.]*)*)[-_](\d+\.\d.*)$/, // pkg-1.2.3
  ];
  for (const re of patterns) {
    const m = re.exec(tag);
    // "v1.2.3-4.5" is a version with a build suffix, not package "v1.2.3".
    if (m && !/^v?\d/i.test(m[1])) return { component: m[1], rest: m[2] };
  }
  return { component: null, rest: tag };
}

/** Parse a release tag. Never throws; an unparseable tag has version null. */
export function parseTag(rawTag: string): ParsedTag {
  const tag = rawTag.trim();
  // Date-style tags (MCP spec "2026-07-28", "2026-07-28-RC") are versions, not "pkg-1.2.3".
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[-_. ]?(.*))?$/.exec(tag);
  if (date) {
    const suffix = date[4] ?? "";
    return { tag, component: null, version: tag, nums: [Number(date[1]), Number(date[2]), Number(date[3])], prerelease: PRERELEASE_RE.test(suffix) };
  }
  // Build tags ("b12549").
  const build = /^[a-z](\d{3,})$/i.exec(tag);
  if (build) return { tag, component: null, version: tag, nums: [Number(build[1])], prerelease: false };

  const split = splitComponent(tag);
  let component = split.component;
  let channel = false;
  if (component && CHANNEL_COMPONENTS.has(component.toLowerCase())) {
    channel = true;
    component = null;
  }
  const m = /^v?(\d+(?:\.\d+)*)(.*)$/i.exec(split.rest);
  if (!m) return { tag, component, version: null, nums: [], prerelease: channel };
  const nums = m[1].split(".").map(Number);
  return { tag, component, version: split.rest, nums, prerelease: channel || PRERELEASE_RE.test(m[2]) };
}

function compareNums(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface Candidate {
  index: number;
  entry: ReleaseEntry;
  parsed: ParsedTag;
  ms: number;
}

/** How a tag counts: a CI build number ("b5454"), a calendar version ("2026.8.31", "v2026.10", "2026-07-28") or a semantic version. */
export type TagScheme = "build" | "calver" | "semver";

const FIRST_CALVER_YEAR = 2000;

export function tagScheme(parsed: ParsedTag): TagScheme {
  if (/^[a-z]\d{3,}$/i.test(parsed.tag)) return "build";
  return (parsed.nums[0] ?? 0) >= FIRST_CALVER_YEAR ? "calver" : "semver";
}

/**
 * The candidates of the repo's CURRENT tag scheme.
 *   1. Build tags published next to a versioned line are CI artefacts (whisper.cpp tags "b5454" a
 *      day before "v1.9.5"): they are dropped whenever anything else exists. A repo with only build
 *      tags (llama.cpp) keeps them.
 *   2. Of what remains, the scheme of the most recently published entry is the one the project uses
 *      now (a calver -> semver migration; two parallel lines such as ATLAS "v2026.10" / "v6.1.0").
 */
function currentScheme(pool: readonly Candidate[]): Candidate[] {
  const versioned = pool.filter((c) => tagScheme(c.parsed) !== "build");
  const line = versioned.length ? versioned : [...pool];
  const newest = [...line].sort((a, b) => b.ms - a.ms || a.index - b.index)[0];
  if (!newest) return line;
  const scheme = tagScheme(newest.parsed);
  return line.filter((c) => tagScheme(c.parsed) === scheme);
}

/** Is `component` the repository's own package (as opposed to a sub-package of a monorepo)? */
function isOwnComponent(component: string | null, repo: string, releaseLine: readonly string[]): boolean {
  if (component === null) return true;
  const name = repo.split("/").pop() ?? repo;
  const c = compact(component);
  if (c === compact(name) || GENERIC_MAIN.has(component.toLowerCase())) return true;
  return releaseLine.some((x) => compact(x) === c);
}

// ------------------------------------------------------------------------------------------------
// Headline
// ------------------------------------------------------------------------------------------------

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]+/gu;
const CONVENTIONAL_COMMIT_RE = /^(?:feat|fix|chore|docs?|refactor|perf|tests?|ci|build|style|revert|bump|deps|release|merge)(?:\([^)]*\))?!?\s*:/i;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A commit subject / auto-generated line is not a headline ("ggml : add backend scheduler tests (#27258)"). */
function looksLikeCommitSubject(text: string): boolean {
  return /\(#\d+\)\s*$/.test(text) || CONVENTIONAL_COMMIT_RE.test(text) || /^\[[^\]]+\]/.test(text) || /^[\w.+/-]+\s*:\s/.test(text);
}

const realWords = (text: string, skip: ReadonlySet<string>): string[] =>
  (text.match(/[\p{L}][\p{L}\p{N}.+-]*/gu) ?? []).filter((w) => /\p{L}{3,}/u.test(w) && !skip.has(compact(w)));

export interface ReleaseTitle {
  title: string;
  /** False only when the release carries its own human headline. */
  synthesized: boolean;
}

/**
 * Title of the one release line of a repo:
 *   "<repo> <version>: <headline>"   the release has its own headline ("AMD NPU + video diffusion LoRA")
 *   "<Product name> <version> released"   the title is a product name plus the version ("AutoGPT Platform v0.12.0")
 *   "<repo> <version> released"      everything else (tag-only titles, commit subjects)
 */
export function releaseTitle(rawTitle: string, parsed: ParsedTag, repo: string): ReleaseTitle {
  const name = repo.split("/").pop() || repo;
  const core = parsed.nums.join(".");
  let version = parsed.version ?? parsed.tag;
  let text = sanitizeText(rawTitle.replace(EMOJI_RE, " ").replace(/`/g, ""));
  // codex tags are "rust-v0.170.0" but the release is named "0.170.0": show the version as the project writes it.
  if (/^v\d/i.test(version) && core && !new RegExp(`v${escapeRe(core)}`, "i").test(text) && text.includes(core)) version = version.slice(1);
  const fallback: ReleaseTitle = { title: `${name} ${version} released`, synthesized: true };

  const versionForms = [parsed.tag, parsed.version, parsed.version?.replace(/^v/i, ""), core ? `v${core}` : null, core || null]
    .filter((v): v is string => !!v)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  const versionRe = versionForms.length ? new RegExp(`(?<![\\p{L}\\p{N}.])(?:${versionForms.join("|")})(?![\\p{L}\\p{N}])`, "iu") : null;
  text = text.replace(/\s+released?\s*$/i, "").trim();
  const skip = new Set([compact(name), "release", "released", "version"]);

  const hit = versionRe?.exec(text) ?? null;
  if (!hit) {
    // No version in the title at all: the title is the headline (unsloth, transformers).
    if (!text || looksLikeCommitSubject(text) || realWords(text, skip).length < 3) return fallback;
    return { title: `${name} ${version}: ${text}`, synthesized: false };
  }
  const before = text.slice(0, hit.index).replace(/\b(?:release|version)\b\s*$/i, "").replace(/[\s:\-–—]+$/u, "").replace(/^(?:release|version)\b\s*/i, "").trim();
  const after = text.slice(hit.index + hit[0].length).replace(/^[\s:：\-–—]+/u, "").replace(/^\((?:lts|latest|stable)\)\s*/i, "").trim();
  if (after) {
    // "<version>: <headline>"
    if (!looksLikeCommitSubject(after) && realWords(after, skip).length >= 3) return { title: `${name} ${version}: ${after}`, synthesized: false };
    return fallback;
  }
  // "<Product name> <version>": keep the project's own product name.
  if (before && realWords(before, skip).length >= 1 && compact(before) !== compact(name)) return { title: `${before} ${version} released`, synthesized: true };
  return fallback;
}

// ------------------------------------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------------------------------------

export interface ReleaseSelection {
  /** Index (into the input) of the entry that becomes the repo's line; null when no entry qualifies. */
  chosen: number | null;
  title: string | null;
  synthesized: boolean;
  /** Why each other entry was folded away, by input index ("pre-release", "sub-package langchain-openai", ...). */
  collapsed: Map<number, string>;
}

/**
 * Choose the one release line of a repo from its raw feed entries.
 * Order of preference: highest stable version of the repo's own package, within the tag scheme the
 * repo uses now (currentScheme); if the feed has no stable entry, its highest pre-release (projects
 * that tag every release "-beta" stay visible). Sub-package tags and unversioned tags (rolling
 * fixtures) never produce a line.
 * `repo` is "owner/name"; when omitted it is read from the first entry link.
 */
export function selectRelease(entries: readonly ReleaseEntry[], repo?: string, now: Date | number = 0, releaseLine: readonly string[] = []): ReleaseSelection {
  const collapsed = new Map<number, string>();
  const repoPath = repo ?? entries.map((e) => parseReleaseUrl(e.link).repo).find((r): r is string => !!r) ?? "";
  const cands: Candidate[] = entries.map((entry, index) => {
    const tag = parseReleaseUrl(entry.link).tag ?? tagFromTitle(entry.title);
    return { index, entry, parsed: parseTag(tag), ms: parseDate(entry.publishedRaw, now)?.ms ?? 0 };
  });

  const own: Candidate[] = [];
  for (const c of cands) {
    if (c.parsed.version === null) collapsed.set(c.index, `unversioned tag ${c.parsed.tag}`);
    else if (isOwnComponent(c.parsed.component, repoPath, releaseLine)) own.push(c);
    else collapsed.set(c.index, `sub-package ${c.parsed.component}`);
  }
  const stable = own.filter((c) => !c.parsed.prerelease);
  const pool = stable.length ? stable : own;
  if (pool.length === 0) return { chosen: null, title: null, synthesized: false, collapsed };

  const line = currentScheme(pool);
  const best = [...line].sort((a, b) => compareNums(b.parsed.nums, a.parsed.nums) || b.ms - a.ms || a.index - b.index)[0];
  for (const c of own) {
    if (c === best) continue;
    const why = c.parsed.prerelease && !best.parsed.prerelease ? "pre-release" : pool.includes(c) && !line.includes(c) ? "other tag scheme" : "older release";
    collapsed.set(c.index, `${why} ${c.parsed.version} (kept ${best.parsed.version})`);
  }
  const { title, synthesized } = releaseTitle(best.entry.title, best.parsed, repoPath || "release");
  return { chosen: best.index, title, synthesized, collapsed };
}

/** Fallback for entries without a /releases/tag/ link: the first version-looking token of the title, else the title. */
function tagFromTitle(title: string): string {
  const t = title.trim();
  return /\S*\d+\.\d+\S*|\b[a-z]\d{3,}\b|\d{4}-\d{2}-\d{2}\S*/i.exec(t)?.[0] ?? t;
}
