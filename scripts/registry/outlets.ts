// Outlet quality control for link-host feeds (Google News queries, Hacker News searches, Techmeme).
//
// A search feed returns whatever outlet ranks for the query. On 2026-11-20 that put a law-firm
// marketing site on the AI SECURITY homepage and a stock-quote app, a guest-post site and an
// Australian press-release rewrite in "view all". Three rules, all data in the registry:
//
//   1. KNOWN outlets keep their standing. An outlet is known when a registry publisher claims its
//      host (publishers.ts) - the publisher list is the allow list. Add a publisher to vouch for one.
//   2. UNVETTED outlets (no publisher claims the host, or the host is only a hosting platform /
//      press-release wire: UNVETTED_PUBLISHER_IDS) carry no standing on a source whose
//      `outlets` policy is "vetted" (the default for link-host sources): normalize emits the item at
//      tier 4, not lead-eligible, not counting for coverage and tagged UNVETTED_OUTLET_TAG. The
//      per-source cap ranks by tier first, so a query's slots go to its known outlets before any
//      unvetted one. Sources that have their own quality signal (an HN points threshold, Techmeme's
//      editors) set `outlets: "open"`.
//   3. DENIED outlets (OUTLET_DENY) are dropped on every link-host source, open or not.
//
// The deny list is deliberately SMALL: a host is listed only after its pages were read and showed a
// content farm or a press-release / filing mill, with the evidence in `reason`. Everything merely
// unknown is left to rule 2. Off-mission but honest outlets (crypto trade press, regional papers)
// do not belong here - use the source's own excludeUrl.

import { bareHost, registrableHost } from "../../shared/url";
import type { PublisherId } from "./types";

/** Tag normalize adds to an item of an unvetted outlet on a "vetted" source (route / score may read it). */
export const UNVETTED_OUTLET_TAG = "unvetted-outlet";

export interface DeniedOutlet {
  /** Host in shared/url.ts registrableHost form; every sub-domain is covered. */
  host: string;
  /** Outlet names as feeds print them (Google News <source>, " - Outlet" title tail); matched whole, case-insensitive. */
  names: string[];
  /** What the pages showed when they were read. */
  reason: string;
  /** ISO date the pages were read (YYYY-MM-DD). */
  checked: string;
}

export const OUTLET_DENY: readonly DeniedOutlet[] = [
  {
    host: "biggo.com", names: ["BigGo Finance"], checked: "2026-11-20",
    reason: "Stock-quote app (finance.biggo.com): unbylined machine summaries of other outlets' reporting with an 'Ask AI' box and 'Key Elements' ticker tags; held an AI SECURITY row via gn-prompt-injection.",
  },
  {
    host: "wisevoter.com", names: ["Wisevoter"], checked: "2026-11-20",
    reason: "Unbylined templated rewrites of vendor press releases ('Why it matters' boilerplate) on a former voter-information domain.",
  },
  {
    host: "hokanews.com", names: ["Hokanews"], checked: "2026-11-20",
    reason: "Blogger-hosted crypto site: author meta is the template placeholder 'Your Name', navigation sells 'Sponsor Content' and 'Press Releases'.",
  },
  {
    host: "shattered.io", names: ["Shattered", "shattered.io"], checked: "2026-11-20",
    reason: "Casino / crypto-gambling affiliate site ('Provably Fair', 'Casino', 'Esports' sections) publishing a rewritten tech story every few minutes in nine languages.",
  },
  {
    host: "startupfortune.com", names: ["Startup Fortune"], checked: "2026-11-20",
    reason: "Front for a free press-release distribution network ('Publish your press release ... at no cost') mixed with unbylined AI / crypto / gold rewrites.",
  },
  {
    host: "stocktitan.net", names: ["Stock Titan"], checked: "2026-11-20",
    reason: "Machine-generated pages for every SEC filing and press release ('AI-generated analysis', Rhea-AI); 7 of 20 gn-ai-sec-finra items on 2026-11-20 were its Form 6-K / NT 10-Q rewrites.",
  },
  {
    host: "quantisnow.com", names: ["Quantisnow"], checked: "2026-11-20",
    reason: "Automated feed of SEC filings and wire press releases, each scored 'bullish or bearish' by a model; no reporting.",
  },
  {
    host: "financialcontent.com", names: ["FinancialContent"], checked: "2026-11-20",
    reason: "Syndication platform that republishes Business Wire / GlobeNewswire releases and Motley Fool copy under its own host.",
  },
  {
    host: "lawcommentary.com", names: ["Law Commentary"], checked: "2026-11-20",
    reason: "Law-firm marketing site ('Showcase Your Law Firm', 'Be a Legal Commentator', 'Advertise'): rewrites of wire reporting with inline glossary link-outs; was AI SECURITY homepage row #8. Judgement call - remove the entry if the owner finds its legal framing useful.",
  },
  {
    host: "londondaily.news", names: ["London Daily News"], checked: "2026-11-20",
    reason: "Guest-post / press-release site: the front page is 'By LDN Collaborator' partner announcements and advertorial ('Lifting gear explained'); its AI-agents item was a vendor chief executive's contributed column. Judgement call.",
  },
];

/**
 * Registry publishers that name a HOSTING PLATFORM or a press-release wire, not an editorial outlet.
 * They exist so a link resolves to a display name ("Medium", "PR Newswire"); they vouch for nothing,
 * so their items are unvetted. A newsletter with its own publisher entry is matched by its exact
 * host first ("kaitchup.substack.com") and is not affected.
 */
export const UNVETTED_PUBLISHER_IDS: ReadonlySet<PublisherId> = new Set<PublisherId>([
  "medium", "substack", "reddit", "youtube", "x-twitter", "wikipedia", "msn", "business-wire", "pr-newswire", "globenewswire",
]);

const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

const DENY_BY_HOST: ReadonlyMap<string, DeniedOutlet> = new Map(OUTLET_DENY.map((d) => [d.host, d]));
const DENY_BY_NAME: ReadonlyMap<string, DeniedOutlet> = new Map(OUTLET_DENY.flatMap((d) => d.names.map((n) => [nameKey(n), d] as const)));

function deniedHost(urlOrHost: string | null | undefined): DeniedOutlet | undefined {
  if (!urlOrHost) return undefined;
  const host = (bareHost(urlOrHost) ?? urlOrHost).trim().toLowerCase().replace(/^www\./, "");
  if (!host || /[\s/]/.test(host)) return undefined;
  // Walk up the labels: "finance.biggo.com" -> "biggo.com". Never matches a different registrable host.
  for (let h = host; h.includes("."); h = h.slice(h.indexOf(".") + 1)) {
    const hit = DENY_BY_HOST.get(h);
    if (hit) return hit;
  }
  return undefined;
}

export interface OutletRef {
  /** The item's URL (resolved article link, or the wrapper). */
  url?: string | null;
  /** Host the feed names for an unresolved wrapper (NormalizedItem.outletHost). */
  outletHost?: string | null;
  /** Outlet name the feed gives (Google News <source>, the " - Outlet" title tail). */
  outletName?: string | null;
}

/**
 * The deny-list entry for an item, or undefined. Looks at the article URL, then at the outlet host
 * and outlet NAME a feed gives for a link that is still an unresolved wrapper - a
 * news.google.com/rss/articles/... URL says nothing about the outlet.
 */
export function deniedOutlet(ref: OutletRef): DeniedOutlet | undefined {
  return deniedHost(ref.url) ?? deniedHost(ref.outletHost) ?? (ref.outletName ? DENY_BY_NAME.get(nameKey(ref.outletName)) : undefined);
}

/** Does this publisher vouch for its items (rule 1)? False for platforms and wires; unknown hosts never reach here with a PublisherDef. */
export function isVettedPublisher(id: PublisherId): boolean {
  return !UNVETTED_PUBLISHER_IDS.has(id);
}

/**
 * Integrity problems of the outlet lists ([] = valid): hosts in registrable form, no duplicates, a
 * reason and a date on every entry, no deny entry for a host a registry publisher claims (that
 * would vouch for and ban the same outlet), and every unvetted id a real publisher.
 */
export function outletProblems(publishers: readonly { id: PublisherId; hosts: readonly string[] }[], deny: readonly DeniedOutlet[] = OUTLET_DENY, unvetted: ReadonlySet<PublisherId> = UNVETTED_PUBLISHER_IDS): string[] {
  const out: string[] = [];
  const claimed = new Map<string, string>();
  for (const p of publishers) for (const h of p.hosts) claimed.set(h, p.id);
  const hosts = new Set<string>();
  const names = new Set<string>();
  for (const d of deny) {
    if (registrableHost(d.host) !== d.host) out.push(`outlet deny list: host "${d.host}" is not in registrableHost form`);
    if (hosts.has(d.host)) out.push(`outlet deny list: duplicate host "${d.host}"`);
    hosts.add(d.host);
    const owner = claimed.get(d.host);
    if (owner !== undefined) out.push(`outlet deny list: "${d.host}" is claimed by publisher ${owner}`);
    if (!d.reason?.trim()) out.push(`outlet deny list: "${d.host}" has no reason`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.checked)) out.push(`outlet deny list: "${d.host}" has no checked date (YYYY-MM-DD)`);
    if (d.names.length === 0) out.push(`outlet deny list: "${d.host}" has no outlet name (needed for unresolved wrappers)`);
    for (const n of d.names) {
      const k = nameKey(n);
      if (!k) out.push(`outlet deny list: "${d.host}" has a blank name`);
      else if (names.has(k)) out.push(`outlet deny list: name "${n}" is listed twice`);
      names.add(k);
    }
  }
  const ids = new Set(publishers.map((p) => p.id));
  for (const id of unvetted) if (!ids.has(id)) out.push(`unvetted publishers: unknown publisher "${id}"`);
  return out;
}
