// Google News wrapper resolution (network half; pure helpers are in unwrap.ts).
//
// Post-2024 article ids no longer embed the publisher URL. The resolver fetches the interstitial for
// its signature / timestamp (data-n-a-sg / data-n-a-ts) and asks the batchexecute RPC "Fbv4je" for the
// target. V1 resolved the first 40 wrappers of every run from scratch; here results are cached in
// state.resolvedUrls, so a run only resolves ids it has never seen (newest first, bounded).

import { isHttpUrl } from "../../../shared/url";
import { BROWSER_UA, HTML_ACCEPT, httpFetch, type HttpDeps } from "./http";
import { Semaphore } from "./pool";
import { googleNewsArticleId, isGoogleNewsUrl, urlFromQueryParam, wrapperKey } from "./unwrap";

/** The resolver RPC (also listed as an external service in docs/SBOM.json by scripts/generate-sbom.ts). */
export const BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

export const GN_DEFAULTS = {
  /**
   * Ceiling on new (uncached) wrappers resolved per run; each costs two requests. The effective
   * bound is the caller's deadline (ingest resolveBudgetMs, checked before every wrapper): steady
   * state is 1-4 new wrappers a build, and a cold start (no state: cutover, state loss) has ~210,
   * which at 60 per run took four builds to clear while the published ids and links of ~150 items
   * changed under the reader. A wrapper that fails or misses the budget goes out as a wrapper link
   * and is retried next run, exactly as before.
   */
  maxNewPerRun: 240,
  concurrency: 4,
  timeoutMs: 8_000,
} as const;

/** Extract the target URL from a batchexecute response body. Exported for tests. */
export function parseBatchExecute(raw: string): string | null {
  let body = raw;
  if (body.startsWith(")]}'")) body = body.split("\n").slice(1).join("\n");
  body = body.replace(/^\s*\d+\n/, "");
  let envelopes: unknown;
  try {
    envelopes = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(envelopes)) return null;
  for (const env of envelopes) {
    if (!Array.isArray(env) || env[0] !== "wrb.fr" || env[1] !== "Fbv4je") continue;
    let payload: unknown = env[2];
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    if (Array.isArray(payload) && payload[0] === "garturlres" && typeof payload[1] === "string") return payload[1];
  }
  return null;
}

function batchRequestBody(articleId: string, ts: string, sig: string): string {
  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    articleId,
    Number(ts),
    sig,
  ]);
  return `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]))}`;
}

/** Resolve one wrapper to the publisher URL, or null. Two requests, one attempt each, never throws. */
export async function resolveGoogleNewsUrl(wrapperUrl: string, deps: HttpDeps): Promise<string | null> {
  if (!isGoogleNewsUrl(wrapperUrl)) return null;
  const fromQuery = urlFromQueryParam(wrapperUrl);
  if (fromQuery) return fromQuery;
  const articleId = googleNewsArticleId(wrapperUrl);
  if (!articleId) return null;

  // Google serves the signed interstitial to browsers only, so this is the one place a browser UA goes first.
  const opts = { attempts: 1, headerTimeoutMs: GN_DEFAULTS.timeoutMs, totalTimeoutMs: GN_DEFAULTS.timeoutMs, userAgent: BROWSER_UA, maxBytes: 2 * 1024 * 1024 };
  const page = await httpFetch({ url: wrapperUrl, accept: HTML_ACCEPT, ...opts }, deps);
  if (page.kind !== "ok") return null;
  const sig = /data-n-a-sg="([^"]+)"/.exec(page.text)?.[1];
  const ts = /data-n-a-ts="([^"]+)"/.exec(page.text)?.[1];
  if (!sig || !ts) return null;

  const rpc = await httpFetch(
    {
      url: BATCH_URL,
      method: "POST",
      accept: "*/*",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Referer: "https://news.google.com/" },
      body: batchRequestBody(articleId, ts, sig),
      ...opts,
    },
    deps,
  );
  if (rpc.kind !== "ok") return null;
  const target = parseBatchExecute(rpc.text);
  return target && isHttpUrl(target) && !isGoogleNewsUrl(target) ? target : null;
}

export interface ResolveBatchResult {
  /** wrapperKey -> article URL for every wrapper answered this run (cache hits + fresh resolutions). */
  resolved: Record<string, string>;
  cacheHits: number;
  fetched: number;
  /** Uncached wrappers left for a later run (over the per-run bound, deadline, or resolver failure). */
  unresolved: number;
}

/**
 * Resolve wrapper URLs against the cache first, then the network - at most `maxNew` new ids per run,
 * in the order given (callers pass newest first).
 */
export async function resolveGoogleNewsBatch(
  wrapperUrls: readonly string[],
  cache: Readonly<Record<string, string>>,
  deps: HttpDeps,
  opts: { maxNew?: number; concurrency?: number } = {},
): Promise<ResolveBatchResult> {
  const resolved: Record<string, string> = {};
  const todo: { key: string; url: string }[] = [];
  const seen = new Set<string>();
  let cacheHits = 0;
  for (const url of wrapperUrls) {
    if (!isGoogleNewsUrl(url)) continue;
    const key = wrapperKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cache[key];
    if (cached && isHttpUrl(cached)) {
      resolved[key] = cached;
      cacheHits++;
    } else {
      todo.push({ key, url });
    }
  }

  const batch = todo.slice(0, opts.maxNew ?? GN_DEFAULTS.maxNewPerRun);
  const gate = new Semaphore(opts.concurrency ?? GN_DEFAULTS.concurrency);
  let fetched = 0;
  await Promise.all(
    batch.map(async ({ key, url }) => {
      const release = await gate.acquire();
      try {
        if (deps.deadline?.expired()) return;
        const target = await resolveGoogleNewsUrl(url, deps);
        if (target) {
          resolved[key] = target;
          fetched++;
        }
      } catch {
        // resolveGoogleNewsUrl does not throw; this only guards the batch against a future regression.
      } finally {
        release();
      }
    }),
  );
  return { resolved, cacheHits, fetched, unresolved: todo.length - fetched };
}
