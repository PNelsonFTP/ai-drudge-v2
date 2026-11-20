// Article ids. Byte-identical to V1's djb2 (scripts/fetch-feeds.ts:45, scrape-sources.ts:76) so that
// ids stored by V1 readers (bookmarks, read-later, seen) stay valid in V2.
//
//   id = hashId(canonicalUrl)        // canonicalUrl from shared/url.ts
//
// The hash walks UTF-16 code units (charCodeAt), exactly like V1.

export function hashId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Shape check for an article id (base36 of a uint32: 1-7 chars of [0-9a-z]). */
export function isArticleId(x: unknown): x is string {
  return typeof x === "string" && /^[0-9a-z]{1,7}$/.test(x);
}
