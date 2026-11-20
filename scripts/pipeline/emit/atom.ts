// public/feed.xml - an Atom 1.0 feed of the site itself: TOP STORIES, then the lead of every
// ai-desk section. Entries link straight to the original articles.
//
// V1's feed churned: 519 distinct entries in 72 h for a 30-slot feed, and entries whose <updated>
// changed between builds. The rules that stop that:
//   - an entry's <id> is the article's canonical URL and its <updated> is the time the pipeline FIRST
//     SAW the article - both never change, so a story that leaves and re-enters is not "new" again;
//   - no runners-up filler: only the editorial picks are listed;
//   - entries are ordered by first-seen (not by rank), and the feed-level <updated> is the newest
//     entry's first-seen time, not the build time.
// So the file is byte-identical from build to build until the set of stories actually changes.

import type { ArticleId, ArticleV2, EditionFront } from "../../../shared/contract";
import { findSection } from "../../../shared/sections";
import { hasFlag, mergeEdition, publisherName } from "../../../shared/select";
import { parseMs } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import { xmlEscape } from "./xml";

export const ATOM_MAX_ENTRIES = 30;
export const ATOM_FILE = "feed.xml";

export interface AtomOptions {
  /** Public site URL, ending in "/" (siteUrl(ctx.env)). */
  siteUrl: string;
}

export interface AtomPick {
  id: ArticleId;
  /** Section label shown as the entry's category. */
  label: string;
}

const eligible = (a: ArticleV2 | undefined): a is ArticleV2 => a !== undefined && isHttpUrl(a.url) && !hasFlag(a, "release") && !hasFlag(a, "discussion");

/** The stories the feed carries, in editorial order: TOP STORIES, then each ai-desk section's lead. Max 30. */
export function selectAtomEntries(front: EditionFront): AtomPick[] {
  const picks: AtomPick[] = [];
  const seen = new Set<ArticleId>();
  // One rule for every entry, whichever way it was picked, so its category does not flip between builds.
  const labelOf = (a: ArticleV2): string => {
    const placed = front.sections.find((s) => findSection(s.id)?.desk === "ai" && s.rows.includes(a.id));
    return placed?.label ?? findSection(a.home)?.label ?? "TOP STORIES";
  };
  const add = (a: ArticleV2): void => {
    if (picks.length >= ATOM_MAX_ENTRIES || seen.has(a.id)) return;
    seen.add(a.id);
    picks.push({ id: a.id, label: labelOf(a) });
  };
  for (const id of front.top) {
    const a = front.articles[id];
    if (eligible(a)) add(a);
  }
  for (const s of front.sections) {
    if (findSection(s.id)?.desk !== "ai") continue;
    const lead = s.rows.map((id) => front.articles[id]).find(eligible);
    if (lead) add(lead);
  }
  return picks;
}

function toIso(iso: string): string {
  const ms = parseMs(iso);
  return ms === null ? iso : new Date(ms).toISOString();
}

export function buildAtom(front: EditionFront, opts: AtomOptions): string {
  const site = opts.siteUrl.endsWith("/") ? opts.siteUrl : `${opts.siteUrl}/`;
  const edition = mergeEdition(front, null);
  const entries = selectAtomEntries(front)
    .map((p) => ({ ...p, a: front.articles[p.id] }))
    .sort((x, y) => (parseMs(y.a.firstSeenAt) ?? 0) - (parseMs(x.a.firstSeenAt) ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // No entries = nothing stable to anchor on; the build time is the only honest value.
  const updated = entries.length ? toIso(entries[0].a.firstSeenAt) : toIso(front.generatedAt);

  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom">`,
    `  <title>AI DRUDGE</title>`,
    `  <subtitle>Machine-intelligence headlines: the stories several outlets are covering, and each desk's lead</subtitle>`,
    `  <link rel="alternate" type="text/html" href="${xmlEscape(site)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlEscape(`${site}${ATOM_FILE}`)}"/>`,
    `  <id>${xmlEscape(site)}</id>`,
    `  <updated>${xmlEscape(updated)}</updated>`,
    `  <author><name>AI DRUDGE</name></author>`,
  ];
  for (const { a, label } of entries) {
    lines.push(
      `  <entry>`,
      `    <title>${xmlEscape(a.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${xmlEscape(a.url)}"/>`,
      `    <id>${xmlEscape(a.url)}</id>`,
      `    <published>${xmlEscape(toIso(a.publishedAt ?? a.firstSeenAt))}</published>`,
      `    <updated>${xmlEscape(toIso(a.firstSeenAt))}</updated>`,
      `    <author><name>${xmlEscape(publisherName(edition, a))}</name></author>`,
      `    <category term="${xmlEscape(label)}"/>`,
    );
    if (a.summary) lines.push(`    <summary>${xmlEscape(a.summary)}</summary>`);
    lines.push(`  </entry>`);
  }
  lines.push(`</feed>`, ``);
  return lines.join("\n");
}
