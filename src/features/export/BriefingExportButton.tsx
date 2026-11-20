// Briefing export: the dialog body (BriefingPanel) with a preview and Copy Markdown / Copy plain
// text / Download .md, and a self-contained trigger + dialog (BriefingExportButton). The ONE entry
// point in the app is the masthead's "Briefing" button, which loads BriefingPanel through
// src/features/chrome/BriefingDialog.tsx (a lazy chunk); no page mounts BriefingExportButton (the
// Watch page's own button exported the same briefing and was removed - watch/page.test.ts pins it).
// Its styles (kit/kit.css) are loaded by that dialog and by every secondary route.

import { useMemo, useState } from "react";
import { useEditionState, useNow, useServices, useStore } from "../../app/services";
import { ALL_PARTS, briefingFilename, briefingMarkdown, briefingText, buildBriefing, type Briefing, type BriefingParts } from "./briefing";
import { copyText, downloadText, localDayStartMs } from "./kit/browser";
import { Dialog } from "./kit/Dialog";
import { useRiver } from "./kit/hooks";
import { Note } from "./kit/Page";
import { plural } from "./kit/rows";

const PART_LABELS: readonly { key: keyof BriefingParts; label: string; count: (b: Briefing) => number }[] = [
  { key: "top", label: "Top stories", count: (b) => b.top.length },
  { key: "watch", label: "Watchlist hits, last 24 h", count: (b) => b.watch.length },
  { key: "bookmarks", label: "Bookmarked today", count: (b) => b.bookmarks.length },
];

/** Dialog body. Exported for tests. */
export function BriefingPanel() {
  const services = useServices();
  const state = useEditionState();
  const now = useNow();
  const mutes = useStore(services.mutes);
  const saved = useStore(services.saved);
  const terms = useStore(services.watchlist, (w) => w.terms);
  const { river, status: riverStatus } = useRiver(terms.length > 0);
  const [parts, setParts] = useState<BriefingParts>(ALL_PARTS);
  const [message, setMessage] = useState("");
  const edition = state.edition;

  const briefing = useMemo(() => {
    if (!edition) return null;
    // `terms` is listed so the briefing is rebuilt when the watchlist changes (matcher() is memoised on it).
    void terms;
    return buildBriefing({ edition, river, saved, matcher: services.watchlist.matcher(), mutes, nowMs: now, todayStartMs: localDayStartMs(now) });
  }, [edition, river, saved, terms, mutes, now, services.watchlist]);

  if (!briefing) return <Note live>Headlines are still loading. The briefing is built from the current edition.</Note>;

  const markdown = briefingMarkdown(briefing, parts);
  const copy = async (text: string, what: string): Promise<void> => {
    const ok = await copyText(text);
    setMessage(ok ? `${what} copied to the clipboard.` : "Copy was blocked by the browser. Select the preview text and copy it manually.");
  };

  return (
    <div>
      <p>
        Built from this edition&rsquo;s top stories, your watchlist hits from the last 24 hours and the stories you bookmarked today. Nothing leaves this browser until you
        paste or save it.
      </p>
      <fieldset className="sp-checks">
        <legend className="sp-label">Include</legend>
        {PART_LABELS.map((p) => (
          <label key={p.key} className="sp-check">
            <input type="checkbox" checked={parts[p.key]} onChange={(e) => setParts({ ...parts, [p.key]: e.target.checked })} />
            <span>
              {p.label} ({p.count(briefing)})
            </span>
          </label>
        ))}
      </fieldset>
      {terms.length === 0 ? <Note>Your watchlist is empty, so there are no watchlist hits. Add terms on the Watch page.</Note> : null}
      {terms.length > 0 && riverStatus !== "ready" ? (
        <Note live>{riverStatus === "error" ? "The 7-day archive could not be loaded; watchlist hits are missing." : "Loading the 7-day archive for watchlist hits…"}</Note>
      ) : null}
      <label className="sp-label" htmlFor="sp-briefing-preview">
        Preview (Markdown)
      </label>
      <textarea id="sp-briefing-preview" className="sp-textarea" readOnly value={markdown} rows={14} spellCheck={false} />
      <div className="sp-dialog-actions">
        <button type="button" className="sp-btn sp-btn-primary" onClick={() => void copy(markdown, "Markdown")}>
          Copy Markdown
        </button>
        <button type="button" className="sp-btn" onClick={() => void copy(briefingText(briefing, parts), "Plain text")}>
          Copy plain text
        </button>
        <button
          type="button"
          className="sp-btn"
          onClick={() => setMessage(downloadText(briefingFilename(briefing), markdown, "text/markdown") ? "Download started." : "Download is not available here.")}
        >
          Download .md
        </button>
      </div>
      <p className="sp-note" role="status" aria-live="polite">
        {message || `${plural(briefing.top.length, "top story", "top stories")}, ${plural(briefing.watch.length, "watchlist hit")}, ${plural(briefing.bookmarks.length, "bookmark")}.`}
      </p>
    </div>
  );
}

export interface BriefingExportButtonProps {
  /** Class of the trigger button. Default "tool-btn" (the header toolbar style). */
  className?: string;
  label?: string;
}

/** Trigger + dialog. Mount it anywhere below the ServicesContext provider. */
export function BriefingExportButton({ className = "tool-btn", label = "Briefing" }: BriefingExportButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`${className} sp-trigger`} aria-haspopup="dialog" title="Copy or download a briefing of this edition" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Briefing export" wide>
        <BriefingPanel />
      </Dialog>
    </>
  );
}
