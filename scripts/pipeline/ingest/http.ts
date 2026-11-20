// The ONE fetch wrapper of the ingest stage (feeds, scrape pages, JSON APIs, HN, Google News resolver)
// and of the feed tools. Everything network goes through httpFetch:
//
//   - timeouts are armed inside the attempt, i.e. after the caller's pool slot is held
//     (split: time-to-headers and total incl. body, so a large feed is not cut mid-download)
//   - up to 3 attempts with jittered backoff; no retry for 404 / 410 / oversized bodies
//   - a TIMEOUT is retried once only, and that retry waits twice as long for the headers (8 s, then
//     16 s): a slow-but-alive host (9-10 s to first byte) gets through, a hung one costs ~25 s
//   - redirects are followed here, hop by hop (at most MAX_REDIRECTS): a hop to a non-public host
//     (IP literal, single-label name, .local / .internal ...) is refused BEFORE it is requested, so a
//     registry host cannot make the build - or a workstation running the feed tools inside a
//     corporate network - send requests to internal services, let alone publish their answers
//   - honest identifying User-Agent first; hosts that reject it (401 / 403 / 406 / 429) are retried
//     once with a browser User-Agent
//   - conditional GET (If-None-Match / If-Modified-Since) -> { kind: "not_modified" }
//   - body size cap (PIPELINE.maxBodyBytes) enforced while streaming
//   - charset from the Content-Type header, BOM, XML declaration or <meta charset>
//
// It never throws: every failure is an HttpError with a FeedErrorClass.

import type { FeedErrorClass } from "../../../shared/contract";
import { bareHost } from "../../../shared/url";
import { ENV, PIPELINE, siteUrl } from "../context";
import type { StageContext } from "../types";
import { hostKey, type TimeoutBreaker } from "./pool";
import { sleep, type Deadline, type Timers } from "./timers";

export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.8";
export const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
export const JSON_ACCEPT = "application/json, */*;q=0.8";

/**
 * THE timeout / retry policy of a source fetch. The build (ingest fetchSource) and the validator
 * (scripts/tools/validate-feeds.ts) both go through sourceRequest() in ingest/index.ts and pass no
 * overrides, so a source the validator calls OK is one the build can fetch - they cannot drift.
 */
export const HTTP_DEFAULTS = {
  attempts: 3,
  /** Time to response headers on a first attempt. */
  headerTimeoutMs: 8_000,
  /**
   * Time to response headers on the retry that follows a timeout, and on the single attempt of a
   * quarantine probe. Hosts answering in 8-16 s (Washington Post: 9-10 s) succeed on the retry.
   */
  retryHeaderTimeoutMs: 16_000,
  /** A request that timed out is retried at most this many times (network / 5xx keep `attempts`). */
  timeoutRetries: 1,
  /** Headers + body. Must stay above retryHeaderTimeoutMs so a slow-header feed still has time for its body. */
  totalTimeoutMs: 30_000,
  /** A Retry-After longer than this is not worth waiting for inside one run. */
  maxRetryAfterMs: 5_000,
} as const;

// ------------------------------------------------------------------------------------------------
// Public hosts
// ------------------------------------------------------------------------------------------------

const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|corp|home|home\.arpa)$/;

/**
 * False for hosts that cannot be a public web site: IP literals (v4 in any notation, v6), single-label
 * names and the private-use suffixes (.local, .internal, ...). A name-based check only - it does not
 * resolve DNS, so a public name pointing at a private address is not caught here.
 */
export function isPublicHost(host: string | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.includes(":") || h.startsWith("[")) return false; // IPv6 literal
  const labels = h.split(".");
  if (labels.length < 2) return false; // "intranet", "localhost", "2130706433"
  // A numeric (or 0x) last label makes the whole host an IPv4 address for every URL parser.
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return false;
  return !PRIVATE_SUFFIX.test(h);
}

/** Redirect hops followed per attempt (browsers and undici allow 20; a feed needs 1-3). */
export const MAX_REDIRECTS = 8;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Absolute http(s) URL of a Location header resolved against the URL that sent it, or null. */
function redirectTarget(location: string, from: string): string | null {
  try {
    const next = new URL(location, from);
    return next.protocol === "http:" || next.protocol === "https:" ? next.href : null;
  } catch {
    return null;
  }
}

/** isPublicHost for the host of an absolute http(s) URL (false when the URL does not parse). */
export function isPublicHttpUrl(url: string | null | undefined): boolean {
  return isPublicHost(bareHost(url));
}

/** FEED_USER_AGENT from the environment, else an honest identifier that names the site. */
export function defaultUserAgent(env: StageContext["env"]): string {
  const fromEnv = (env[ENV.userAgent] ?? "").trim();
  return fromEnv || `ai-drudge/2.0 (+${siteUrl(env)}; feed reader)`;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  accept?: string;
  /** Extra request headers (User-Agent / Accept / validators are set by httpFetch). */
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** Validators of the cached copy; when either is set the request is conditional. */
  etag?: string;
  lastModified?: string;
  /** Overrides (defaults: HTTP_DEFAULTS, PIPELINE.maxBodyBytes). */
  attempts?: number;
  headerTimeoutMs?: number;
  /** Retries after a TIMEOUT (default HTTP_DEFAULTS.timeoutRetries). 0 = a timed-out request is not asked again. */
  timeoutRetries?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  /** Force this User-Agent on the first attempt (default: deps.userAgent). */
  userAgent?: string;
  /** false = status + headers only, the body is discarded (link checks). Default true. */
  readBody?: boolean;
}

export interface HttpDeps {
  fetch: typeof fetch;
  timers: Timers;
  userAgent: string;
  /** No attempt starts after the deadline; in-flight attempts are aborted at it. */
  deadline?: Deadline;
  breaker?: TimeoutBreaker;
}

export interface HttpOk {
  kind: "ok";
  status: number;
  /** Decoded body ("" when readBody is false). */
  text: string;
  bytes: number;
  /** Lower-cased Content-Type header ("" when absent). */
  contentType: string;
  /** Encoding label the body was decoded with. */
  charset: string;
  /** URL after redirects (the request URL when the runtime does not report one). */
  finalUrl: string;
  etag?: string;
  lastModified?: string;
  attempts: number;
}

export interface HttpNotModified {
  kind: "not_modified";
  status: 304;
  finalUrl: string;
  attempts: number;
}

export interface HttpError {
  kind: "error";
  error: Extract<FeedErrorClass, "timeout" | "network" | "http" | "too_large">;
  /** Human-readable ("HTTP 403", "timeout after 8000 ms"). */
  detail: string;
  httpStatus?: number;
  contentType?: string;
  finalUrl?: string;
  attempts: number;
}

export type HttpResult = HttpOk | HttpNotModified | HttpError;

// ------------------------------------------------------------------------------------------------
// Charset
// ------------------------------------------------------------------------------------------------

function latin1(bytes: Uint8Array, max: number): string {
  let s = "";
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Encoding label for a response body: BOM, then the header, then the XML declaration / <meta charset>. */
export function sniffCharset(bytes: Uint8Array, contentType: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = latin1(bytes, 1024);
  const fromXml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  if (fromXml) return fromXml.toLowerCase();
  const fromMeta = /<meta[^>]*\bcharset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  if (fromMeta) return fromMeta.toLowerCase();
  return "utf-8";
}

/** Decode a body with the sniffed charset; an unknown label falls back to UTF-8 instead of throwing. */
export function decodeBody(bytes: Uint8Array, contentType: string): { text: string; charset: string } {
  const label = sniffCharset(bytes, contentType);
  try {
    return { text: new TextDecoder(label).decode(bytes), charset: label };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
  }
}

// ------------------------------------------------------------------------------------------------
// One attempt
// ------------------------------------------------------------------------------------------------

type Attempt = Omit<HttpOk, "attempts"> | Omit<HttpNotModified, "attempts"> | (Omit<HttpError, "attempts"> & { retryAfterMs?: number; noRetry?: boolean });

class AbortedError extends Error {}

/** Reject as soon as `signal` aborts, even when the underlying promise ignores the signal. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new AbortedError("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortedError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(res);
    return null;
  }
  if (!res.body) {
    const buf = new Uint8Array(await raceAbort(res.arrayBuffer(), signal));
    return buf.length > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      total += value.length;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
  return code ? `${e.message} (${code})` : e.message;
}

async function attemptOnce(req: HttpRequest, ua: string, deps: HttpDeps): Promise<Attempt> {
  const { timers, deadline } = deps;
  const headerMs = req.headerTimeoutMs ?? HTTP_DEFAULTS.headerTimeoutMs;
  const totalMs = Math.max(headerMs, req.totalTimeoutMs ?? HTTP_DEFAULTS.totalTimeoutMs);
  const ctl = new AbortController();
  let timedOut: string | null = null;
  const abortWith = (why: string) => (): void => {
    timedOut ??= why;
    ctl.abort();
  };
  const headerTimer = timers.setTimeout(abortWith(`timeout after ${headerMs} ms`), headerMs);
  const totalTimer = timers.setTimeout(abortWith(`timeout after ${totalMs} ms (body)`), totalMs);
  const onDeadline = abortWith("stage deadline reached");
  deadline?.signal.addEventListener("abort", onDeadline, { once: true });
  if (deadline?.signal.aborted) onDeadline();

  const headers: Record<string, string> = { "User-Agent": ua, Accept: req.accept ?? FEED_ACCEPT, ...req.headers };
  if (req.etag) headers["If-None-Match"] = req.etag;
  if (req.lastModified) headers["If-Modified-Since"] = req.lastModified;

  const requestHost = bareHost(req.url);
  // The caller chose req.url (a local dev server is its business); every OTHER host must be public.
  const refused = (url: string): Attempt | null => {
    const host = bareHost(url);
    if (host === requestHost || isPublicHost(host)) return null;
    return { kind: "error", error: "network", detail: `redirected to a non-public host (${(host ?? "?").slice(0, 80)})`, finalUrl: url, noRetry: true };
  };

  try {
    let url = req.url;
    let method = req.method ?? "GET";
    let body = req.body;
    let res: Response;
    // The header timeout covers the whole chain: it is cleared when the final response's headers are in.
    for (let hop = 0; ; hop++) {
      res = await raceAbort(deps.fetch(url, { method, headers, body, signal: ctl.signal, redirect: "manual" }), ctl.signal);
      const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
      if (!location) break; // includes a 3xx without Location, which is reported as "HTTP 3xx" below
      const status = res.status;
      discard(res);
      const next = redirectTarget(location, url);
      if (!next) return { kind: "error", error: "network", detail: `HTTP ${status} redirect to an unusable location`, httpStatus: status, finalUrl: url, noRetry: true };
      if (hop >= MAX_REDIRECTS) return { kind: "error", error: "network", detail: `more than ${MAX_REDIRECTS} redirects`, finalUrl: url, noRetry: true };
      const blocked = refused(next);
      if (blocked) return blocked;
      // As browsers do: 303 always, and 301 / 302 after a POST, continue as a body-less GET.
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        for (const name of Object.keys(headers)) if (/^content-(?:type|length|encoding)$/i.test(name)) delete headers[name];
      }
      url = next;
    }
    timers.clearTimeout(headerTimer);
    const finalUrl = res.url || url;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    // Second line of defence for a runtime that followed a redirect by itself: never READ what a non-public host answered.
    const blocked = refused(finalUrl);
    if (blocked) {
      discard(res);
      return blocked;
    }
    if (res.status === 304) {
      discard(res);
      return { kind: "not_modified", status: 304, finalUrl };
    }
    if (!res.ok) {
      discard(res);
      return { kind: "error", error: "http", detail: `HTTP ${res.status}`, httpStatus: res.status, contentType, finalUrl, retryAfterMs: retryAfterMs(res) };
    }
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (req.readBody === false) {
      discard(res);
      return { kind: "ok", status: res.status, text: "", bytes: 0, contentType, charset: "", finalUrl, etag, lastModified };
    }
    const maxBytes = req.maxBytes ?? PIPELINE.maxBodyBytes;
    const bytes = await readCapped(res, maxBytes, ctl.signal);
    if (bytes === null) {
      return { kind: "error", error: "too_large", detail: `body over ${maxBytes} bytes`, httpStatus: res.status, contentType, finalUrl };
    }
    const { text, charset } = decodeBody(bytes, contentType);
    return { kind: "ok", status: res.status, text, bytes: bytes.length, contentType, charset, finalUrl, etag, lastModified };
  } catch (e) {
    if (timedOut !== null) return { kind: "error", error: "timeout", detail: timedOut };
    return { kind: "error", error: "network", detail: errorMessage(e).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200) };
  } finally {
    timers.clearTimeout(headerTimer);
    timers.clearTimeout(totalTimer);
    deadline?.signal.removeEventListener("abort", onDeadline);
  }
}

// ------------------------------------------------------------------------------------------------
// Retry policy
// ------------------------------------------------------------------------------------------------

interface RetryPlan {
  retry: boolean;
  /** Switch to the browser User-Agent for the next attempt. */
  browserUa?: boolean;
  delayMs?: number;
}

const UA_REJECTIONS = new Set([401, 403, 406, 429]);

/** Decide what to do after a failed attempt. Exported for tests and for the feed tools. */
export function retryPlan(err: { error: HttpError["error"]; httpStatus?: number; retryAfterMs?: number }, usedBrowserUa: boolean): RetryPlan {
  if (err.error === "too_large") return { retry: false };
  if (err.error === "timeout" || err.error === "network") return { retry: true };
  const status = err.httpStatus ?? 0;
  if (err.retryAfterMs !== undefined && err.retryAfterMs > HTTP_DEFAULTS.maxRetryAfterMs) return { retry: false };
  if (UA_REJECTIONS.has(status)) {
    if (!usedBrowserUa) return { retry: true, browserUa: true, delayMs: err.retryAfterMs };
    // The browser UA was rejected too: only a rate limit is worth one more try.
    return status === 429 ? { retry: true, delayMs: err.retryAfterMs } : { retry: false };
  }
  if (status === 408 || status === 425 || status >= 500) return { retry: true, delayMs: err.retryAfterMs };
  return { retry: false }; // 404, 410 and the other 4xx are answers, not glitches
}

export async function httpFetch(req: HttpRequest, deps: HttpDeps): Promise<HttpResult> {
  const { timers, deadline, breaker } = deps;
  const maxAttempts = Math.max(1, req.attempts ?? HTTP_DEFAULTS.attempts);
  const key = hostKey(req.url);
  let ua = req.userAgent ?? deps.userAgent;
  let last: HttpError | null = null;
  let timeouts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deadline?.expired()) return last ?? { kind: "error", error: "timeout", detail: "stage deadline reached before the request started", attempts: attempt - 1 };
    if (breaker?.isOpen(key)) return last ?? { kind: "error", error: "timeout", detail: `${key} timed out repeatedly this run; not retried`, attempts: attempt - 1 };

    // Escalating header timeout: the retry after a timeout waits longer (an explicit override is kept as is).
    const headerTimeoutMs = req.headerTimeoutMs ?? (timeouts > 0 ? HTTP_DEFAULTS.retryHeaderTimeoutMs : HTTP_DEFAULTS.headerTimeoutMs);
    const result = await attemptOnce({ ...req, headerTimeoutMs }, ua, deps);
    if (result.kind !== "error") {
      breaker?.recordResponse(key);
      return { ...result, attempts: attempt };
    }
    if (result.error === "timeout") {
      timeouts++;
      breaker?.recordTimeout(key);
    } else if (result.error === "http") breaker?.recordResponse(key);
    const { retryAfterMs: _retryAfter, noRetry, ...err } = result;
    last = { ...err, attempts: attempt };

    const plan = retryPlan(result, ua === BROWSER_UA);
    if (!plan.retry || noRetry || attempt === maxAttempts) break;
    // A hung host is not worth a third wait: one retry, with the longer header timeout.
    if (result.error === "timeout" && timeouts > (req.timeoutRetries ?? HTTP_DEFAULTS.timeoutRetries)) break;
    if (plan.browserUa) ua = BROWSER_UA;
    const backoff = plan.delayMs ?? 400 * attempt + Math.floor(timers.random() * 600);
    await sleep(timers, backoff, deadline?.signal);
  }
  return last ?? { kind: "error", error: "network", detail: "no attempt made", attempts: 0 };
}
