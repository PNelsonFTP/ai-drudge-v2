// #/saved (bookmarks) and #/later (read-later queue). Works without an edition: entries fall back
// to their stored snapshots.

import { useEffect, useMemo, useRef, useState } from "react";
import { timeAgo } from "../../../shared/time";
import { useEditionState, useNow, useServices, useStore, type Route, type SavedTab } from "../../app/services";
import { copyText } from "../export/kit/browser";
import { Dialog } from "../export/kit/Dialog";
import { Page, RouteLink, Rows } from "../export/kit/Page";
import { plural } from "../export/kit/rows";
import { articleForRestore, buildSavedList, removedEntries, savedMarkdown, TAB_LABEL, type SavedEntry } from "./model";

const EMPTY: Readonly<Record<SavedTab, string>> = {
  bookmarks: "No bookmarks yet. Use the bookmark action on any headline (keyboard: b) to keep it here.",
  later: "Nothing queued. Use the read-later action on any headline (keyboard: l); it leaves this list when you open it.",
};

const INTRO: Readonly<Record<SavedTab, string>> = {
  bookmarks: "Bookmarks stay until you remove them, even after a story leaves the site.",
  later: "A reading queue: opening a story removes it from this list.",
};

interface Notice {
  text: string;
  /** Entry that can be put back. */
  undo?: SavedEntry;
}

export function SavedPage({ route }: { route: Route }) {
  const services = useServices();
  const state = useEditionState();
  const now = useNow();
  const saved = useStore(services.saved);
  const tab: SavedTab = route.name === "saved" ? route.tab : "bookmarks";
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const entries = useMemo(() => buildSavedList(saved, tab, state.edition), [saved, tab, state.edition]);
  const shown = entries.filter((e) => e.origin !== "missing");
  const missing = entries.filter((e) => e.origin === "missing");

  // Rows are removed from several places - the row's own remove button and menu (HeadlineRow), the
  // b / l keys, opening a read-later item, another tab - so the "removed, undo" notice is derived
  // from the list itself instead of being wired to each of them.
  const previous = useRef<{ tab: SavedTab; entries: SavedEntry[] } | null>(null);
  const quiet = useRef(false);
  useEffect(() => {
    const before = previous.current;
    previous.current = { tab, entries };
    if (!before) return;
    if (before.tab !== tab) {
      // The other list: a notice about the previous one no longer applies.
      setNotice(null);
      quiet.current = false;
      return;
    }
    if (quiet.current) {
      quiet.current = false;
      return;
    }
    const gone = removedEntries(before.entries, entries);
    if (gone.length === 1) {
      const [e] = gone;
      setNotice(e.origin === "missing" ? { text: "Removed an unavailable item." } : { text: `Removed “${e.title}” from ${TAB_LABEL[tab]}.`, undo: e });
    } else if (gone.length > 1) {
      setNotice({ text: `${plural(gone.length, "item")} removed from ${TAB_LABEL[tab]}.` });
    }
  }, [entries, tab]);

  const restore = (e: SavedEntry): void => {
    const present = tab === "later" ? saved.later.has(e.id) : saved.bookmarks.has(e.id);
    if (!present) {
      const article = state.edition?.articles[e.id] ?? articleForRestore(e, new Date(now).toISOString());
      if (tab === "later") services.saved.toggleLater(article, e.sourceName);
      else services.saved.toggleBookmark(article, e.sourceName);
    }
    setNotice({ text: `Restored “${e.title}”.` });
  };
  const copyAll = async (): Promise<void> => {
    const ok = await copyText(savedMarkdown(entries, tab));
    setNotice({ text: ok ? `${plural(shown.length, "link")} copied as Markdown.` : "Copy was blocked by the browser." });
  };

  return (
    <Page
      title={TAB_LABEL[tab]}
      meta={plural(entries.length, "item")}
      actions={
        <>
          <button type="button" className="sp-btn" aria-disabled={shown.length === 0} onClick={() => (shown.length === 0 ? undefined : void copyAll())}>
            Copy all as Markdown
          </button>
          <button type="button" className="sp-btn sp-btn-danger" aria-disabled={entries.length === 0} onClick={() => (entries.length === 0 ? undefined : setConfirmClear(true))}>
            Remove all
          </button>
        </>
      }
    >
      <nav className="sp-chips" aria-label="Saved lists">
        <RouteLink to={{ name: "saved", tab: "bookmarks" }} className="sp-chip" current={tab === "bookmarks"}>
          Bookmarks ({saved.bookmarks.size})
        </RouteLink>
        <RouteLink to={{ name: "saved", tab: "later" }} className="sp-chip" current={tab === "later"}>
          Read later ({saved.later.size})
        </RouteLink>
      </nav>
      <p className="sp-intro">
        {INTRO[tab]} Saved in this browser only &mdash; <RouteLink to={{ name: "settings" }}>download a backup in Settings</RouteLink> to move it to another device.
      </p>

      <p className="sp-note" role="status" aria-live="polite">
        {notice ? (
          <>
            {notice.text}{" "}
            {notice.undo ? (
              <button type="button" className="sp-btn sp-btn-quiet" onClick={() => notice.undo && restore(notice.undo)}>
                Undo
              </button>
            ) : null}
          </>
        ) : null}
      </p>

      {entries.length === 0 ? (
        <div className="sp-empty">
          <p>{EMPTY[tab]}</p>
        </div>
      ) : null}

      <Rows
        rows={shown}
        variant="saved"
        // Read-later is consumed on open. The row's own remove control comes with the "saved" variant.
        onOpen={tab === "later" ? (e) => services.saved.consume(e.id) : undefined}
        after={(e) => (
          <p className="sp-row-context">
            {e.savedAt ? <time dateTime={e.savedAt}>saved {timeAgo(e.savedAt, now)}</time> : "saved earlier"}
            {e.origin === "snapshot" ? " · no longer in the current edition" : ""}
          </p>
        )}
      />

      {missing.length > 0 ? (
        <div className="sp-rows" role="group" aria-label="Saved items that are no longer available">
          {missing.map((e) => (
            <p key={e.id} className="sp-row-context">
              A saved item is no longer available (id <code className="sp-code">{e.id}</code>).{" "}
              <button type="button" className="sp-btn sp-btn-quiet" aria-label={`Remove unavailable item ${e.id}`} onClick={() => services.saved.remove(tab, e.id)}>
                Remove
              </button>
            </p>
          ))}
        </div>
      ) : null}

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} title={`Remove all ${TAB_LABEL[tab].toLowerCase()}?`}>
        <p>
          This removes {plural(entries.length, "item")} from {TAB_LABEL[tab]} in this browser. It cannot be undone here; a backup from Settings can restore them.
        </p>
        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-btn sp-btn-danger"
            onClick={() => {
              quiet.current = true;
              services.saved.clear(tab);
              setConfirmClear(false);
              setNotice({ text: `${TAB_LABEL[tab]} cleared.` });
            }}
          >
            Remove all
          </button>
          <button type="button" className="sp-btn" onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </Page>
  );
}
