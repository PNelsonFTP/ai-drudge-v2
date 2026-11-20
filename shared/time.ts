// Time helpers shared by the pipeline and the client. ONE copy (V1 had three).
// The clock is ALWAYS a parameter - nothing here calls Date.now() or new Date() without an argument.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** A point in time: epoch milliseconds or a Date. */
export type Clock = number | Date;

export function toMs(t: Clock): number {
  return typeof t === "number" ? t : t.getTime();
}

/** Epoch ms of an ISO string; null for null/undefined/empty/unparseable input. */
export function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Age in hours. Infinity when the date is missing/unparseable; future dates clamp to 0.
 * (Scoring-specific policies such as "unknown date counts as 36 h" live in the score stage.)
 */
export function ageHours(iso: string | null | undefined, now: Clock): number {
  const t = parseMs(iso);
  if (t === null) return Infinity;
  return Math.max(0, (toMs(now) - t) / HOUR_MS);
}

export function ageDays(iso: string | null | undefined, now: Clock): number {
  return ageHours(iso, now) / 24;
}

/** The time an item is ranked/windowed/displayed by: publishedAt, else firstSeenAt. */
export function effectiveAt(a: { publishedAt: string | null; firstSeenAt: string }): string {
  return a.publishedAt ?? a.firstSeenAt;
}

/** effectiveAt as epoch ms (0 when both dates are unparseable, so such items sort last). */
export function effectiveMs(a: { publishedAt: string | null; firstSeenAt: string }): number {
  return parseMs(a.publishedAt) ?? parseMs(a.firstSeenAt) ?? 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Relative display: "just now" (< 60 s), "5m ago", "3h ago", "2d ago" (< 7 d), then "Mar 14"
 * (UTC; with the year, "Mar 14, 2025", when it is not the clock's year). "" for a missing date.
 * Future dates display as "just now".
 */
export function timeAgo(iso: string | null | undefined, now: Clock): string {
  const then = parseMs(iso);
  if (then === null) return "";
  const nowMs = toMs(now);
  const diff = Math.max(0, nowMs - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const d = new Date(then);
  const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? label : `${label}, ${d.getUTCFullYear()}`;
}

/** Compact age for "updated Xm ago" style labels: "now", "5m", "3h", "2d". "" for a missing date. */
export function shortAge(iso: string | null | undefined, now: Clock): string {
  const then = parseMs(iso);
  if (then === null) return "";
  const min = Math.floor(Math.max(0, toMs(now) - then) / MINUTE_MS);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export const NEW_WITHIN_HOURS = 6;
export const STALE_AFTER_HOURS = 72;

/** NEW badge: at most `withinHours` old (default 6). False for a missing date. */
export function isNew(iso: string | null | undefined, now: Clock, withinHours: number = NEW_WITHIN_HOURS): boolean {
  return ageHours(iso, now) <= withinHours;
}

/** Stale dimming: older than `afterHours` (default 72). False for a missing date. */
export function isStale(iso: string | null | undefined, now: Clock, afterHours: number = STALE_AFTER_HOURS): boolean {
  const h = ageHours(iso, now);
  return h !== Infinity && h > afterHours;
}

/** True when the date exists and is at most `hours` old. */
export function withinHours(iso: string | null | undefined, now: Clock, hours: number): boolean {
  return ageHours(iso, now) <= hours;
}

/** Homepage time chips: NEW · 6H · 24H · 3D · ALL. */
export const TIME_FILTERS = ["new", "6h", "24h", "3d", "all"] as const;
export type TimeFilter = (typeof TIME_FILTERS)[number];

/** Window in hours of the fixed-width chips. "new" and "all" are not fixed windows (see passesTimeFilter). */
export const TIME_FILTER_HOURS: Readonly<Record<Exclude<TimeFilter, "new" | "all">, number>> = {
  "6h": 6,
  "24h": 24,
  "3d": 72,
};

/**
 * Does an article pass a homepage time chip?
 * - "all": always.
 * - "6h" / "24h" / "3d": effective time (publishedAt ?? firstSeenAt) within the window.
 * - "new": first seen AFTER the reader's previous visit; when there is no previous visit
 *   (first visit) it falls back to the NEW-badge rule (effective time within 6 h).
 */
export function passesTimeFilter(
  a: { publishedAt: string | null; firstSeenAt: string },
  filter: TimeFilter,
  now: Clock,
  previousVisitMs: number | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "new") {
    if (previousVisitMs === null) return isNew(effectiveAt(a), now);
    const seen = parseMs(a.firstSeenAt);
    return seen !== null && seen > previousVisitMs;
  }
  return withinHours(effectiveAt(a), now, TIME_FILTER_HOURS[filter]);
}

/** Hours since an edition was generated (for the stale banner); null for a bad timestamp. */
export function staleHours(generatedAt: string | null | undefined, now: Clock): number | null {
  const h = ageHours(generatedAt, now);
  return h === Infinity ? null : h;
}
