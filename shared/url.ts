// URL helpers shared by the pipeline and the client. Pure string code on purpose: shared/ compiles
// with `lib: ES2022, types: []`, where the global `URL` class does not exist.
//
//   isHttpUrl        scheme allowlist (http/https only) - everything else is dropped / never rendered
//   canonicalUrl     THE canonical article URL; article id = hashId(canonicalUrl(link))
//   urlKey           scheme-less, www-less canonical form for exact-URL matching (HN signal)
//   hostOf / bareHost / registrableHost   publisher identity for `attribution: "link-host"` sources

export interface HttpUrlParts {
  scheme: "http" | "https";
  /** Lower-cased host, no userinfo, no port. */
  host: string;
  /** Port digits, "" when absent or the scheme default (80/443). */
  port: string;
  /** Path starting with "/" ("/" when empty). */
  path: string;
  /** Query WITHOUT the leading "?" ("" when absent). */
  query: string;
  /** Fragment WITHOUT the leading "#" ("" when absent). */
  hash: string;
}

// Spaces are tolerated in path/query (they get percent-encoded by canonicalUrl); never in the authority.
const URL_RE = /^(https?):\/\/([^/?#\s]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i;
const HOST_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?))*\.?$|^\[[0-9a-f:.]+\]$/;

/** Parse an absolute http(s) URL. null for anything else (other schemes, relative, malformed, control chars). */
export function parseHttpUrl(raw: string | null | undefined): HttpUrlParts | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(s)) return null;
  const m = URL_RE.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase() as "http" | "https";
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  let port = "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest) {
      if (!/^:\d*$/.test(rest)) return null;
      port = rest.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
      if (!/^\d*$/.test(port)) return null;
    }
  }
  host = host.toLowerCase();
  if (!host || !HOST_RE.test(host)) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return null;
  if ((scheme === "http" && port === "80") || (scheme === "https" && port === "443")) port = "";
  return { scheme, host, port, path: m[3] || "/", query: m[4] ?? "", hash: m[5] ?? "" };
}

/** Scheme allowlist: true only for absolute http:// or https:// URLs with a plausible host. */
export function isHttpUrl(raw: string | null | undefined): boolean {
  return parseHttpUrl(raw) !== null;
}

/** Lower-cased host of an http(s) URL (no port); null when not an http(s) URL. */
export function hostOf(url: string | null | undefined): string | null {
  return parseHttpUrl(url)?.host ?? null;
}

/** hostOf without a leading "www.". */
export function bareHost(url: string | null | undefined): string | null {
  const h = hostOf(url);
  return h === null ? null : h.replace(/^www\./, "");
}

// Query parameters that never identify a document. Everything else is KEPT (identity-bearing
// params such as ?p=123, ?id=, ?v= must survive).
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|mc_[a-z0-9_]*|fbclid|gclid|gclsrc|dclid|msclkid|yclid|igshid|mkt_tok|_hsenc|_hsmi|ref|ref_src|ref_url|oc|smid|sref|srsltid|cmpid|ncid|guccounter|guce_referrer|guce_referrer_sig)$/i;

/** True for query parameter names that are tracking noise (utm_*, mc_*, fbclid, gclid, ref, ...). */
export function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM.test(name);
}

function encodeNonAscii(s: string): string {
  // Percent-encode spaces and non-ASCII exactly once; existing %XX escapes are left alone.
  return s.replace(/[^!-~]+/g, (run) => {
    try {
      return encodeURIComponent(run);
    } catch {
      return ""; // lone surrogate
    }
  });
}

/**
 * Canonical article URL, or null when `raw` is not an absolute http(s) URL.
 * - scheme + host lower-cased; userinfo and default ports dropped
 * - fragment dropped
 * - tracking params dropped (utm_*, mc_*, fbclid, gclid, ref, ... - see isTrackingParam); all other
 *   query params kept, in their original order and encoding
 * - trailing "index.html" / "index.htm" dropped; ONE trailing "/" dropped (root stays "/")
 * - spaces / non-ASCII percent-encoded
 * Not changed: "www.", http vs https, path case. Idempotent. On URLs already normalised by V1
 * (scripts/lib/unwrapUrl.ts normalizeArticleUrl) it is the identity, so V1 ids stay valid.
 */
export function canonicalUrl(raw: string | null | undefined): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  let path = encodeNonAscii(u.path).replace(/\/index\.html?$/i, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path) path = "/";
  const kept: string[] = [];
  if (u.query) {
    for (const pair of u.query.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = eq >= 0 ? pair.slice(0, eq) : pair;
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        /* keep raw name */
      }
      if (isTrackingParam(decoded)) continue;
      kept.push(encodeNonAscii(pair));
    }
  }
  const port = u.port ? `:${u.port}` : "";
  return `${u.scheme}://${u.host}${port}${path}${kept.length ? `?${kept.join("&")}` : ""}`;
}

/**
 * Key for EXACT-URL matching across stages (HN signal index <-> scored items): the canonical URL
 * without scheme and without a leading "www.". null when not an http(s) URL.
 */
export function urlKey(raw: string | null | undefined): string | null {
  const c = canonicalUrl(raw);
  if (c === null) return null;
  return c.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

// Second-level public suffixes we actually meet in news feeds (NOT the full public suffix list).
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "gov.au", "edu.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "co.in", "net.in", "org.in",
  "com.cn", "net.cn", "org.cn", "com.br", "com.mx", "co.nz", "com.sg", "com.hk", "co.za", "com.tw",
  "com.tr", "co.il", "com.ar", "com.co", "co.id", "com.my", "com.ph", "com.pk", "com.ua", "com.vn",
]);

// Multi-tenant platforms: the label BEFORE these identifies the publisher (simonw.substack.com).
const TENANT_PLATFORMS = new Set([
  "substack.com", "medium.com", "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "ghost.io",
  "beehiiv.com", "bearblog.dev", "hashnode.dev", "tumblr.com", "mataroa.blog", "pages.dev",
  "vercel.app", "netlify.app", "notion.site", "wixsite.com", "typepad.com", "readthedocs.io",
  "hf.space", "herokuapp.com", "web.app", "firebaseapp.com", "neocities.org", "micro.blog",
]);

/**
 * Registrable host ("eTLD+1") of a URL or bare host, lower-cased, for publisher identity:
 *   https://www.theguardian.com/x  -> theguardian.com      news.mit.edu      -> mit.edu
 *   https://www.bbc.co.uk/news     -> bbc.co.uk            blogs.nvidia.com  -> nvidia.com
 *   https://simonw.substack.com/p  -> simonw.substack.com  deepmind.google   -> deepmind.google
 * IP addresses and single-label hosts are returned as-is. null for unusable input.
 */
export function registrableHost(urlOrHost: string | null | undefined): string | null {
  if (typeof urlOrHost !== "string") return null;
  const s = urlOrHost.trim();
  if (!s) return null;
  let host: string | null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+$/.test(s)) host = hostOf(s);
  else host = parseHttpUrl(`http://${s}`)?.host ?? null;
  if (!host) return null;
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join(".");
  let take = TWO_LEVEL_SUFFIXES.has(last2) ? 3 : 2;
  const base = labels.slice(-take).join(".");
  if (TENANT_PLATFORMS.has(base) && labels.length > take) {
    const tenant = labels[labels.length - take - 1];
    if (tenant !== "www") take += 1;
  }
  return labels.slice(-take).join(".");
}

/** True when two URLs have the same canonical form ignoring scheme and "www.". */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = urlKey(a);
  return ka !== null && ka === urlKey(b);
}
