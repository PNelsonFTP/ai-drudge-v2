// Newest-N selection and size caps for raw items.
//
// Ingest does not PARSE dates for output (normalize owns that) - it only needs an ordering key so the
// per-feed cap keeps the newest N items instead of the first N in document order (V1 lost the newest
// posts of oldest-first feeds, and showed month-old hits of relevance-ordered query feeds).

const HOUR = 3_600_000;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR, year: 365 * 24 * HOUR };
/** Dates outside [1995, now + 10 years] are treated as unparseable. */
const MIN_PLAUSIBLE_MS = Date.UTC(1995, 0, 1);
const MAX_FUTURE_MS = 10 * 365 * 24 * HOUR;

/** Milliseconds for ordering, or null when the string is not a usable date. Never throws. */
export function dateKey(raw: string | null | undefined, nowMs: number): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 100) return null;
  let ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    const rel = /^(?:about\s+|published\s+|updated\s+)?(\d{1,5})\s*(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(s);
    if (!rel) return null;
    ms = nowMs - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  }
  if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS || ms > nowMs + MAX_FUTURE_MS) return null;
  return ms;
}

/** Ordering key: undated items rank as ~36 h old, future-dated items as a week old (same as scoring). */
function rankKey(raw: string | null, nowMs: number): number {
  const ms = dateKey(raw, nowMs);
  if (ms === null) return nowMs - 36 * HOUR;
  if (ms > nowMs + HOUR) return nowMs - 168 * HOUR;
  return ms;
}

/**
 * Stable newest-first order. When no item has a usable date the document order is kept (most feeds
 * without dates are newest-first already).
 */
export function newestFirst<T extends { publishedRaw: string | null }>(items: readonly T[], nowMs: number): T[] {
  if (!items.some((it) => dateKey(it.publishedRaw, nowMs) !== null)) return [...items];
  return items
    .map((item, index) => ({ item, index, key: rankKey(item.publishedRaw, nowMs) }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .map((x) => x.item);
}

/** The newest `max` items by date (NOT document order). */
export function takeNewest<T extends { publishedRaw: string | null }>(items: readonly T[], max: number, nowMs: number): T[] {
  return newestFirst(items, nowMs).slice(0, Math.max(0, max));
}

/** Age in days of the newest dated item, or null when nothing is dated. */
export function newestAgeDays(items: readonly { publishedRaw: string | null }[], nowMs: number): number | null {
  let newest: number | null = null;
  for (const it of items) {
    const ms = dateKey(it.publishedRaw, nowMs);
    if (ms !== null && ms <= nowMs + HOUR && (newest === null || ms > newest)) newest = ms;
  }
  return newest === null ? null : Math.max(0, (nowMs - newest) / (24 * HOUR));
}

// ------------------------------------------------------------------------------------------------
// Size caps (a 6 MB feed must not become a 96 MB payload or a 30 MB state file)
// ------------------------------------------------------------------------------------------------

/** Raw title cap. Normalize cuts the CLEANED title to PIPELINE.titleMaxChars; this only bounds hostile input. */
export const RAW_TITLE_MAX = 500;
/** Raw summary cap (HTML). Enough markup to yield a 320-char plain summary; bounds state.lastGood. */
export const RAW_SUMMARY_MAX = 4000;
export const RAW_FIELD_MAX = 200;
export const MAX_CATEGORIES = 12;

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * One line of at most `max` characters: every run of whitespace / control characters becomes one
 * space. Failure details quote third-party text (V8's JSON.parse message repeats the body, a server
 * names itself in an error) and end up in the build log, state.json and health.json - a newline in
 * one would let a feed write its own log lines (GitHub Actions reads "::command::" at column 0).
 */
export function oneLine(s: string | null | undefined, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return capText((s ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim(), max);
}

const NON_TEXT_OPEN = /<(style|script|svg|noscript|template)\b/gi;

/**
 * Remove <style> / <script> / <svg> / <noscript> / <template> blocks (each becomes one space).
 * Same result as html.replace(/<(style|...)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ") but in linear time:
 * that regex rescans to the end of the input for every unclosed opener, so a hostile 5 MB summary of
 * "<script>" repeated blocked the event loop for minutes (and with it every timeout of the run).
 * Here a failed search for a closer happens at most once per tag name.
 */
export function stripNonTextBlocks(html: string): string {
  const dead = new Set<string>();
  let out = "";
  let pos = 0;
  const open = new RegExp(NON_TEXT_OPEN.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = open.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    if (dead.has(name)) continue;
    const gt = html.indexOf(">", open.lastIndex);
    if (gt < 0) break; // no opener after this point can be complete either
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = gt + 1;
    if (close.exec(html) === null) {
      dead.add(name); // no closer from here on: every later opener of this name is unclosed too
      continue;
    }
    out += `${html.slice(pos, m.index)} `;
    pos = close.lastIndex;
    open.lastIndex = pos;
  }
  return pos === 0 ? html : out + html.slice(pos);
}

/** Remove <!-- comments --> (each becomes one space); linear, stops at the first unclosed opener. */
export function stripHtmlComments(html: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const a = html.indexOf("<!--", pos);
    if (a < 0) break;
    const b = html.indexOf("-->", a + 4);
    if (b < 0) break;
    out += `${html.slice(pos, a)} `;
    pos = b + 3;
  }
  return pos === 0 ? html : out + html.slice(pos);
}

/**
 * Bound a raw HTML summary. Blocks that carry no prose (style / script / svg) are removed BEFORE the
 * cut so a truncated <style> can never leak CSS into the summary, and a trailing half tag is dropped.
 */
export function capSummary(html: string, max: number = RAW_SUMMARY_MAX): string {
  let s = html.length > max ? stripHtmlComments(stripNonTextBlocks(html)) : html;
  if (s.length <= max) return s.trim();
  s = capText(s, max);
  // Unterminated block opened inside the kept part: everything after its start is CSS / JS, not prose.
  const open = /<(style|script|svg|noscript|template)\b[^>]*>(?![\s\S]*<\/\1\s*>)[\s\S]*$/i.exec(s);
  if (open) s = s.slice(0, open.index);
  return s.replace(/<[^<>]*$/, "").replace(/&[#\w]{0,10}$/, "").trim();
}
