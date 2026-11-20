// Hacker News signal: story URL -> points / comments, for the scorer's exact-URL boost.
//
// V1 also kept a per-DOMAIN table, which boosted every github.com / reuters.com item whenever any
// story of that domain was on HN. That fallback is gone: keys are shared/url urlKey(storyUrl) and the
// scorer looks items up by the same key - an exact-URL match or nothing.
//
// Fail-soft: any error yields an empty (or partial) index; the build never depends on HN.

import { urlKey } from "../../../../shared/url";
import type { HnIndex } from "../../types";
import { httpFetch, JSON_ACCEPT, type HttpDeps } from "../http";

/** Base of the two search endpoints (also listed as an external service in docs/SBOM.json). */
export const HN_API = "https://hn.algolia.com/api/v1";
const API = HN_API;
export const HN_DEFAULTS = {
  /** Only stories that got some traction can boost a headline. */
  minPoints: 30,
  windowHours: 72,
  timeoutMs: 9_000,
} as const;

/** The two queries: recent stories with traction, and whatever is on the front page right now. */
export function hnEndpoints(nowMs: number): string[] {
  const since = Math.floor((nowMs - HN_DEFAULTS.windowHours * 3_600_000) / 1000);
  return [
    `${API}/search_by_date?tags=story&numericFilters=points%3E${HN_DEFAULTS.minPoints},created_at_i%3E${since}&hitsPerPage=1000`,
    `${API}/search?tags=front_page&hitsPerPage=100`,
  ];
}

/** Fold Algolia hits into the index (max points / comments per URL). Tolerates any JSON shape. */
export function addHnHits(index: HnIndex, body: unknown): number {
  const hits = body && typeof body === "object" && Array.isArray((body as { hits?: unknown }).hits) ? (body as { hits: unknown[] }).hits : [];
  let added = 0;
  for (const hit of hits) {
    if (!hit || typeof hit !== "object") continue;
    const h = hit as { url?: unknown; points?: unknown; num_comments?: unknown };
    const key = typeof h.url === "string" ? urlKey(h.url) : null;
    if (!key) continue;
    const points = typeof h.points === "number" && Number.isFinite(h.points) ? h.points : 0;
    const comments = typeof h.num_comments === "number" && Number.isFinite(h.num_comments) ? h.num_comments : 0;
    const prev = index.byUrl.get(key);
    if (prev) {
      prev.points = Math.max(prev.points, points);
      prev.comments = Math.max(prev.comments, comments);
    } else {
      index.byUrl.set(key, { points, comments });
      added++;
    }
  }
  return added;
}

export function emptyHnIndex(): HnIndex {
  return { byUrl: new Map() };
}

export async function fetchHnIndex(nowMs: number, deps: HttpDeps): Promise<HnIndex> {
  const index = emptyHnIndex();
  await Promise.all(
    hnEndpoints(nowMs).map(async (url) => {
      const res = await httpFetch({ url, accept: JSON_ACCEPT, attempts: 2, headerTimeoutMs: HN_DEFAULTS.timeoutMs, totalTimeoutMs: HN_DEFAULTS.timeoutMs }, deps);
      if (res.kind !== "ok") return;
      try {
        addHnHits(index, JSON.parse(res.text));
      } catch {
        // not JSON: ignore this endpoint
      }
    }),
  );
  return index;
}
