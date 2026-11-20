// Feed-audit verdicts: the JSON record written by validate-feeds and read by report-feed-audit, and
// the ONE definition of "transient" (V1 had two copies of isTransient, one per script).
//
// Verdict strings (V1-compatible; NO_CARDS / TOO_LARGE / NETWORK are new in V2):
//   OK          parses, has items, newest item < STALE_DAYS old (or undated)
//   STALE       parses but the newest item is older than STALE_DAYS (LOW_CADENCE_STALE_DAYS for a
//               source tagged "low-cadence")
//   EMPTY       valid feed / API response with 0 usable items
//   NOT_FEED    endpoint returns HTML or an unknown document (SPA shell, interstitial)
//   NO_CARDS    scrape source: the listing page has no link matching the configured pattern
//   PARSE_FAIL  looked like a feed / JSON but did not parse
//   HTTP_xxx    non-2xx response
//   TIMEOUT     no response in time after retries
//   NETWORK     DNS / TLS / connection failure
//   TOO_LARGE   body over the size cap

import type { FeedErrorClass } from "../../shared/contract";
import { bareHost } from "../../shared/url";

export const STALE_DAYS = 60;
/** Registry tag of a source that is expected to be silent for months (a researcher's own blog). */
export const LOW_CADENCE_TAG = "low-cadence";
/** Stale limit for sources tagged low-cadence: reporting them STALE on every audit is noise. */
export const LOW_CADENCE_STALE_DAYS = 365;

/** The stale limit that applies to a source with these registry tags. */
export function staleDaysFor(tags: readonly string[] | undefined): number {
  return tags?.includes(LOW_CADENCE_TAG) ? LOW_CADENCE_STALE_DAYS : STALE_DAYS;
}

export interface Verdict {
  name: string;
  url: string;
  /** V1 field: the source's category. V2 writes the home section here. */
  category?: string;
  verdict: string;
  httpStatus?: number;
  finalUrl?: string;
  /** True when the final URL is on another host (the registry URL should be updated). */
  redirected?: boolean;
  itemCount?: number;
  newestAgeDays?: number | null;
  note?: string;
  /** V2 additions (ignored by V1 readers). */
  id?: string;
  kind?: string;
}

/** Verdict string for a failed fetch / parse. */
export function verdictForError(error: FeedErrorClass, httpStatus?: number): string {
  switch (error) {
    case "http":
      return `HTTP_${httpStatus ?? 0}`;
    case "timeout":
      return "TIMEOUT";
    case "network":
      return "NETWORK";
    case "too_large":
      return "TOO_LARGE";
    case "not_feed":
      return "NOT_FEED";
    case "parse":
      return "PARSE_FAIL";
    case "empty":
      return "EMPTY";
    case "no_cards":
      return "NO_CARDS";
    case "skipped":
      return "SKIPPED";
  }
}

/** OK or STALE from the age of the newest item (null = undated, which is not stale). */
export function verdictForAge(newestAgeDays: number | null, staleDays: number = STALE_DAYS): "OK" | "STALE" {
  return newestAgeDays !== null && newestAgeDays > staleDays ? "STALE" : "OK";
}

const TRANSIENT_VERDICTS = new Set(["TIMEOUT", "HTTP_429", "HTTP_502", "HTTP_503", "HTTP_504"]);
const BLOCKED = new Set(["HTTP_403", "HTTP_429", "TIMEOUT"]);

function onHost(url: string, domain: string): boolean {
  const host = bareHost(url) ?? "";
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Failures that say nothing about the feed itself: rate limits, gateway errors, and the hosts that
 * block datacenter IPs on and off (Reddit, Substack) or are flaky by nature (hnrss).
 * Transient verdicts never fail validate-feeds and are listed separately in the audit issue.
 */
export function isTransient(v: Pick<Verdict, "verdict" | "url">): boolean {
  if (v.verdict === "OK") return false;
  if (TRANSIENT_VERDICTS.has(v.verdict)) return true;
  if (onHost(v.url, "hnrss.org")) return true;
  if ((onHost(v.url, "reddit.com") || onHost(v.url, "substack.com")) && BLOCKED.has(v.verdict)) return true;
  return false;
}

export interface VerdictSummary {
  ok: Verdict[];
  actionable: Verdict[];
  transient: Verdict[];
  /** OK feeds answered from another host: the registry URL should be updated. */
  moved: Verdict[];
}

export function summarize(verdicts: readonly Verdict[]): VerdictSummary {
  const bad = verdicts.filter((v) => v.verdict !== "OK");
  return {
    ok: verdicts.filter((v) => v.verdict === "OK"),
    actionable: bad.filter((v) => !isTransient(v)),
    transient: bad.filter((v) => isTransient(v)),
    moved: verdicts.filter((v) => v.redirected && v.verdict === "OK"),
  };
}

/** Order used in the JSON file and the console report: by verdict, then by name. */
export function sortVerdicts(verdicts: readonly Verdict[]): Verdict[] {
  return [...verdicts].sort((a, b) => a.verdict.localeCompare(b.verdict) || a.name.localeCompare(b.name));
}
