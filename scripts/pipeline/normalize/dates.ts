// Date parsing for feed / scraper date strings (replaces V1 scripts/lib/timeAgo.ts extractDate).
//
// V1 handed every string to `new Date(raw)` first, so results depended on the machine's timezone
// ("2026-11-19T15:30:00" was 21:30Z in Chicago), V8's legacy parser invented dates ("Nov 19" ->
// 2001, "19/11/2026" -> July 2027) and an absurd relative date threw and failed the build.
// Here every format is matched explicitly, every component is range-checked, a missing zone means
// UTC, and nothing ever throws. The clock is always a parameter.

import { PIPELINE } from "../context";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../shared/time";

export interface ParsedDate {
  /** Epoch ms. For a date-only stamp: 12:00 UTC of the calendar day as written. */
  ms: number;
  /**
   * True when the source only gave a day: "2026-11-19", "Nov 19, 2026", or a stamp whose time is
   * exactly 00:00:00 (a third of first-party feeds stamp posts with midnight).
   */
  dateOnly: boolean;
}

/** Nothing on this site predates this; older stamps are CMS defaults (1970-01-01, 0001-01-01). */
const MIN_YEAR = 1995;
const MAX_YEAR = 2100;
const MAX_RAW_LENGTH = 120;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

// Offsets in minutes. Ambiguous abbreviations take their most common news-feed meaning (IST = India).
const ZONES: Readonly<Record<string, number>> = {
  z: 0, ut: 0, utc: 0, gmt: 0, wet: 0, west: 60, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180, msk: 180,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
  akst: -540, akdt: -480, hst: -600, brt: -180, art: -180,
  ist: 330, pkt: 300, sgt: 480, hkt: 480, awst: 480, jst: 540, kst: 540, acst: 570, aest: 600, aedt: 660,
  nzst: 720, nzdt: 780,
};

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000, sec: 1000, second: 1000,
  m: MINUTE_MS, min: MINUTE_MS, minute: MINUTE_MS,
  h: HOUR_MS, hr: HOUR_MS, hour: HOUR_MS,
  d: DAY_MS, day: DAY_MS,
  w: 7 * DAY_MS, wk: 7 * DAY_MS, week: 7 * DAY_MS,
  mo: 30 * DAY_MS, month: 30 * DAY_MS,
  y: 365 * DAY_MS, yr: 365 * DAY_MS, year: 365 * DAY_MS,
};

const int = (s: string | undefined): number => (s === undefined ? NaN : parseInt(s, 10));

function fullYear(raw: string): number {
  const y = int(raw);
  // RFC 2822: two-digit years 00-49 are 20xx, 50-99 are 19xx.
  if (raw.length <= 2) return y < 50 ? 2000 + y : 1900 + y;
  return y;
}

/** Zone offset in minutes: "Z", "+0530", "-08:00", "+01", an abbreviation; unknown or missing = UTC. */
function zoneMinutes(zone: string | undefined): number {
  if (!zone) return 0;
  const z = zone.trim();
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(z);
  if (m) {
    const minutes = int(m[2]) * 60 + (m[3] ? int(m[3]) : 0);
    return minutes > 14 * 60 ? 0 : m[1] === "-" ? -minutes : minutes;
  }
  return ZONES[z.toLowerCase()] ?? 0;
}

interface Clock12 {
  hour: number;
  minute: number;
  second: number;
}

function clock(h: string | undefined, mi: string | undefined, s: string | undefined, ampm?: string): Clock12 | null {
  if (h === undefined || mi === undefined) return null;
  let hour = int(h);
  const minute = int(mi);
  // A leap second is folded into :59.
  const second = Math.min(s === undefined ? 0 : int(s), 59);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm.toLowerCase().startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0)) return null;
  return { hour, minute, second };
}

/**
 * Assemble a date from range-checked parts. `time` undefined = date-only. Returns null for
 * impossible dates (30 Feb, month 13), a bad time, or a year outside MIN_YEAR..MAX_YEAR.
 */
function build(year: number, month: number, day: number, time?: Clock12 | null, zone?: string): ParsedDate | null {
  if (time === null) return null;
  if (!(year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const noon = Date.UTC(year, month - 1, day, 12);
  const check = new Date(noon);
  // Date.UTC rolls 30 Feb over into March: reject on round-trip mismatch.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (!time || (time.hour === 0 && time.minute === 0 && time.second === 0)) return { ms: noon, dateOnly: true };
  const ms = Date.UTC(year, month - 1, day, time.hour, time.minute, time.second) - zoneMinutes(zone) * MINUTE_MS;
  return { ms, dateOnly: false };
}

const TIME = "(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,]\\d{1,9})?)?";
const ZONE = "(Z|[A-Za-z]{2,5}|[+-]\\d{2}(?::?\\d{2})?)";
const WEEKDAY = "(?:[\\p{L}]{2,10}\\.?,?\\s+)?";

const ISO_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:[T\\s]\\s*${TIME}\\s*${ZONE}?)?$`, "iu");
const ISO_BASIC_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/i;
// "Thu, 19 Nov 2026 15:30:00 +0100", "19 Nov 26 15:30 GMT", "12 June 2025", "19 Nov" (weekday in any language)
const DAY_FIRST_RE = new RegExp(`^${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+([A-Za-z]{3,9})\\.?,?(?:\\s+(\\d{4}|\\d{2}))?(?:[,\\s]+(?:(?:at|[-–—@])\\s+)?${TIME}\\s*(AM|PM)?\\s*${ZONE}?)?$`, "iu");
// "Nov 19, 2026 00:00:00-0600", "November 19, 2026", "June 3", "Nov 19 at 3:15 PM EST",
// "Thursday, November 19, 2026 - 17:19" (FCA: a dash, "at" or "@" may stand between the date and the time)
const MONTH_FIRST_RE = new RegExp(`^${WEEKDAY}([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?:[,\\s]+(?:(?:at|[-–—@])\\s+)?${TIME}\\s*(AM|PM)?\\s*${ZONE}?)?$`, "iu");
const SLASH_RE = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/;
const RELATIVE_RE = /(?:^|\s)(\d{1,5}|an?|one)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)\s+ago\b/i;

function parseRelative(s: string, nowMs: number): ParsedDate | null {
  const lower = s.toLowerCase();
  if (/^(?:just\s+now|now|moments?\s+ago|today)\b/.test(lower)) return { ms: nowMs, dateOnly: false };
  if (/^yesterday\b/.test(lower)) return { ms: nowMs - DAY_MS, dateOnly: false };
  const last = /^last\s+(week|month|year)\b/.exec(lower);
  if (last) return { ms: nowMs - UNIT_MS[last[1]], dateOnly: false };
  const m = RELATIVE_RE.exec(lower);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? int(m[1]) : 1;
  const unit = UNIT_MS[m[2]] ?? UNIT_MS[m[2].replace(/s$/, "")];
  if (unit === undefined || !Number.isFinite(n)) return null;
  const ms = nowMs - n * unit;
  // "99999 years ago" is not a date (V1 threw RangeError here).
  return new Date(ms).getUTCFullYear() >= MIN_YEAR ? { ms, dateOnly: false } : null;
}

function parseEpoch(s: string): ParsedDate | null {
  if (!/^\d{10}$|^\d{13}$/.test(s)) return null;
  const ms = s.length === 10 ? int(s) * 1000 : int(s);
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? { ms, dateOnly: false } : null;
}

/** Year for a stamp without one ("Nov 19"): the clock's year, or the previous one if that would be in the future. */
function inferYear(month: number, day: number, nowMs: number): number {
  const year = new Date(nowMs).getUTCFullYear();
  return Date.UTC(year, month - 1, day) > nowMs + DAY_MS ? year - 1 : year;
}

function parseAbsolute(s: string, nowMs: number): ParsedDate | null {
  let m = ISO_RE.exec(s);
  if (m) return build(int(m[1]), int(m[2]), int(m[3]), m[4] === undefined ? undefined : clock(m[4], m[5], m[6]), m[7]);

  m = ISO_BASIC_RE.exec(s);
  if (m) return build(int(m[1]), int(m[2]), int(m[3]), m[4] === undefined ? undefined : clock(m[4], m[5], m[6]), m[7]);

  m = DAY_FIRST_RE.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    const day = int(m[1]);
    const year = m[3] ? fullYear(m[3]) : inferYear(month, day, nowMs);
    return build(year, month, day, m[4] === undefined ? undefined : clock(m[4], m[5], m[6], m[7]), m[8]);
  }

  m = MONTH_FIRST_RE.exec(s);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    const day = int(m[2]);
    const year = m[3] ? int(m[3]) : inferYear(month, day, nowMs);
    return build(year, month, day, m[4] === undefined ? undefined : clock(m[4], m[5], m[6], m[7]), m[8]);
  }

  m = SLASH_RE.exec(s);
  if (m) {
    if (m[1].length === 4) return build(int(m[1]), int(m[2]), int(m[3]));
    if (m[3].length !== 4) return null;
    const a = int(m[1]);
    const b = int(m[2]);
    // US month-first unless the first number cannot be a month.
    return a > 12 ? build(int(m[3]), b, a) : build(int(m[3]), a, b);
  }
  return null;
}

/**
 * Parse a date string as found in a feed or on a page. Understands ISO 8601 (zone-less = UTC),
 * RFC 822 / 2822 with numeric or named zones and 2- or 4-digit years, "Nov 19, 2026 [time][zone]",
 * "19 Nov [2026]", slash dates (range-checked; day-first when the first number is > 12), compact
 * "20261119", epoch seconds / milliseconds, and relative strings ("2 hours ago", "5 mins ago",
 * "a day ago", "yesterday", "last week"). Returns null for anything else. Never throws; the result
 * does not depend on the machine's timezone.
 */
export function parseDate(raw: string | null | undefined, now: Date | number): ParsedDate | null {
  if (typeof raw !== "string") return null;
  // Trailing furniture after a separator: "Nov 19 · 5 min read".
  const s = raw.replace(/\s+/g, " ").trim().split(/\s[·•|]\s/)[0];
  if (!s || s.length > MAX_RAW_LENGTH) return null;
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const parsed = parseEpoch(s) ?? parseAbsolute(s, nowMs) ?? parseRelative(s, nowMs);
  return parsed && Number.isFinite(parsed.ms) ? parsed : null;
}

/**
 * A date-only stamp is placed at 12:00 UTC of its day; up to this far ahead of first sight it is
 * still "today" somewhere (12 h to noon + 14 h for UTC+14). Further ahead is an event listing.
 */
export const DATE_ONLY_SLACK_HOURS = 26;

/**
 * publishedAt of an item (ISO UTC) or null.
 * - A full timestamp more than PIPELINE.maxFutureHours ahead of the clock is rejected (the item
 *   then uses firstSeenAt); within the tolerance it is kept as written.
 * - A date-only stamp is 12:00 UTC of its day, but never later than the moment the item was first
 *   seen: a post stamped "today" and picked up at 07:30 was not published at noon. This keeps the
 *   value stable from the first build onward instead of flipping from null to noon at 13:00.
 */
export function resolvePublishedAt(parsed: ParsedDate | null, nowMs: number, firstSeenMs: number): string | null {
  if (!parsed) return null;
  if (parsed.dateOnly) {
    if (parsed.ms <= firstSeenMs) return new Date(parsed.ms).toISOString();
    return parsed.ms - firstSeenMs <= DATE_ONLY_SLACK_HOURS * HOUR_MS ? new Date(firstSeenMs).toISOString() : null;
  }
  if (parsed.ms > nowMs + PIPELINE.maxFutureHours * HOUR_MS) return null;
  return new Date(parsed.ms).toISOString();
}
