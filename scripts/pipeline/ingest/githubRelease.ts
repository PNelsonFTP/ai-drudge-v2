// GitHub release feeds (<repo>/releases.atom).
//
// Ingest passes release entries through RAW - it does not synthesize "<repo> vX released" titles,
// pick the stable release or collapse a repo to one line. Normalize owns all of that and needs to see
// the whole feed to do it (the stable release of a monorepo is often the 9th entry), so:
//   - SourceDef.maxItems is NOT applied to release feeds; every entry (up to RELEASE_ENTRY_CAP) is kept;
//   - each item's `link` is the release page  https://github.com/<owner>/<repo>/releases/tag/<tag>
//     (the tag is recoverable with releaseTagFromLink even when the title omits it: GitHub titles a
//     release "v0.40.17" while the tag is "v0.40.17-rc1", or "0.172.0-alpha.2" for "rust-v0.172.0-alpha.2");
//   - `guid` is the Atom id ("tag:github.com,2008:Repository/<n>/<tag>"), `publishedRaw` is <updated>
//     and `summaryHtml` is the changelog from <content> (preferred over <summary>).

import { parseHttpUrl } from "../../../shared/url";
import type { FeedEntry } from "./feedParser";

/** GitHub serves 10 entries per releases.atom page; the cap only bounds a misbehaving feed. */
export const RELEASE_ENTRY_CAP = 30;

export function isGithubReleaseSource(source: { kind: string; url: string }): boolean {
  if (source.kind === "github-release") return true;
  const u = parseHttpUrl(source.url);
  return u !== null && u.host.replace(/^www\./, "") === "github.com" && /\/releases\.atom$/.test(u.path);
}

/** "owner/repo" of a github.com URL (feed or release page), or null. */
export function repoOfGithubUrl(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u || u.host.replace(/^www\./, "") !== "github.com") return null;
  const [owner, repo] = u.path.split("/").filter(Boolean);
  return owner && repo ? `${owner}/${repo}` : null;
}

/** The (decoded) tag of a release page URL: ".../releases/tag/langchain-openrouter%3D%3D0.3.0" -> "langchain-openrouter==0.3.0". */
export function releaseTagFromLink(link: string): string | null {
  const u = parseHttpUrl(link);
  if (!u) return null;
  const m = /\/releases\/tag\/(.+)$/.exec(u.path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Release entries of a feed, document order (GitHub lists newest first), bounded. */
export function releaseEntries(entries: readonly FeedEntry[]): FeedEntry[] {
  const releases = entries.filter((e) => releaseTagFromLink(e.link) !== null);
  // A feed that is not shaped like GitHub's (a mirror, a renamed host) still passes through untouched.
  return (releases.length > 0 ? releases : [...entries]).slice(0, RELEASE_ENTRY_CAP);
}
