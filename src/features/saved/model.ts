// Saved pages model (#/saved bookmarks, #/later read-later): the reader's ids merged with the live
// edition and the stored snapshots, newest saved first. Pure.
//
// An entry is rendered from the LIVE article while it is in the edition (keeps coverage, summary),
// from its SNAPSHOT after it left, and as a removable placeholder when neither exists (V1 could
// count such "phantom" ids in the badge with no row to remove them).

import type { ArticleId, ArticleV2 } from "../../../shared/contract";
import { sourceName, type Edition } from "../../../shared/select";
import { parseMs } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import type { RowItem, Route, SavedSnapshot, SavedState, SavedTab } from "../../app/services";
import { escapeMarkdown, markdownLink } from "../export/kit/markdown";

export interface SavedEntry {
  id: ArticleId;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: string | null;
  /** ISO time it was saved; null when no snapshot records it. */
  savedAt: string | null;
  /** "live": in the current edition. "snapshot": only the stored copy. "missing": neither. */
  origin: "live" | "snapshot" | "missing";
  /** Fallback row data for HeadlineRow (absent for "missing"). */
  item?: RowItem;
}

function usableSnapshot(s: SavedSnapshot | undefined): s is SavedSnapshot {
  return !!s && typeof s.title === "string" && s.title.trim() !== "" && isHttpUrl(s.url);
}

function entryOf(id: ArticleId, live: ArticleV2 | undefined, snap: SavedSnapshot | undefined, edition: Edition | null): SavedEntry {
  const savedAt = snap && parseMs(snap.savedAt) !== null ? snap.savedAt : null;
  if (live && edition) {
    const name = sourceName(edition, live.src);
    return {
      id,
      title: live.title,
      url: live.url,
      sourceName: name,
      publishedAt: live.publishedAt,
      savedAt,
      origin: "live",
      item: { id, title: live.title, url: live.url, sourceName: name, sourceId: live.src, publishedAt: live.publishedAt, firstSeenAt: live.firstSeenAt },
    };
  }
  if (usableSnapshot(snap)) {
    return {
      id,
      title: snap.title,
      url: snap.url,
      sourceName: snap.sourceName,
      publishedAt: snap.publishedAt,
      savedAt,
      origin: "snapshot",
      item: { id, title: snap.title, url: snap.url, sourceName: snap.sourceName, publishedAt: snap.publishedAt, firstSeenAt: null },
    };
  }
  return { id, title: "", url: "", sourceName: "", publishedAt: null, savedAt, origin: "missing" };
}

/**
 * Entries of one tab, newest saved first. Entries without a saved time follow, ordered by publish
 * time (newest first), then id - so the order is stable between renders.
 */
export function buildSavedList(state: SavedState, tab: SavedTab, edition: Edition | null): SavedEntry[] {
  const ids = tab === "later" ? state.later : state.bookmarks;
  const entries = [...ids].map((id) => entryOf(id, edition?.articles[id], state.snapshots[id], edition));
  const key = (e: SavedEntry): [number, number] => [parseMs(e.savedAt) ?? -Infinity, parseMs(e.publishedAt) ?? -Infinity];
  return entries.sort((a, b) => {
    const [sa, pa] = key(a);
    const [sb, pb] = key(b);
    if (sa !== sb) return sb > sa ? 1 : -1;
    if (pa !== pb) return pb > pa ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Entries of `before` that are no longer in `after` (what a row action, a key or another tab just removed). */
export function removedEntries(before: readonly SavedEntry[], after: readonly SavedEntry[]): SavedEntry[] {
  const present = new Set(after.map((e) => e.id));
  return before.filter((e) => !present.has(e.id));
}

export const TAB_LABEL: Readonly<Record<SavedTab, string>> = { bookmarks: "Bookmarks", later: "Read later" };

/**
 * "Copy all as Markdown": a heading and one bullet per entry,
 *   - [Title](url) — Source · saved 2026-11-19
 * Placeholder entries (nothing left to link to) are skipped.
 */
export function savedMarkdown(entries: readonly SavedEntry[], tab: SavedTab): string {
  const usable = entries.filter((e) => e.origin !== "missing");
  const lines = [`# AI DRUDGE — ${TAB_LABEL[tab]} (${usable.length})`, ""];
  for (const e of usable) {
    const saved = e.savedAt ? ` · saved ${e.savedAt.slice(0, 10)}` : "";
    const source = e.sourceName ? ` — ${escapeMarkdown(e.sourceName)}` : "";
    lines.push(`- ${markdownLink(e.title, e.url)}${source}${saved}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A minimal article for SavedStore.toggleBookmark / toggleLater when a removed entry is restored
 * (undo) and the article is no longer in the edition. Only id, title, url and publishedAt carry
 * information; the remaining required fields are neutral placeholders the saved store does not keep.
 */
export function articleForRestore(e: SavedEntry, nowIso: string): ArticleV2 {
  return { id: e.id, url: e.url, title: e.title, src: e.item?.sourceId ?? "", publishedAt: e.publishedAt, firstSeenAt: e.item?.firstSeenAt ?? e.savedAt ?? nowIso, home: "industry", tier: 3 };
}

export function savedTitle(route: Route): string {
  return route.name === "saved" && route.tab === "later" ? TAB_LABEL.later : TAB_LABEL.bookmarks;
}
