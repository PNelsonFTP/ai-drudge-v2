// Item identity. ONE canonical form (shared/url.ts canonicalUrl) feeds the stored url, the id and
// the dedup key - V1 stored one normalisation and deduplicated on another
// (`url.replace(/[#?].*$/, "")`), which collapsed every "?p=123" permalink of a feed into one item
// and silently discarded 9 of 10 Shtetl-Optimized posts on every build.

import type { ArticleId } from "../../../shared/contract";
import { hashId } from "../../../shared/ids";
import { canonicalUrl, urlKey } from "../../../shared/url";

export interface ItemIdentity {
  /** Canonical article URL (tracking params and fragment dropped; identity params such as ?p= / ?id= / ?v= kept). */
  url: string;
  /** hashId(url) - byte-identical to V1 ids for URLs V1 had already normalised. */
  id: ArticleId;
  /**
   * Comparison key for "the same article": the canonical URL without scheme and "www.". Used to
   * fold twins; never stored or hashed, so http/https and www/non-www variants of one page meet
   * while ids stay stable.
   */
  key: string;
}

/** Identity of an item link, or null when the link is not an absolute http(s) URL. */
export function itemIdentity(link: string | null | undefined): ItemIdentity | null {
  const url = canonicalUrl(link);
  const key = urlKey(url);
  if (url === null || key === null) return null;
  return { url, id: hashId(url), key };
}
