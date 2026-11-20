// "Muted <source> · Undo": the visible notice for a mute. Muting is one key (m) or one click, it
// removes every story of that source from every page, and the row that was acted on disappears -
// so the confirmation and the way back have to live in the shell, not in the row.
//
// The notice is raised from the MUTES STORE (muteModel.ts watchSourceMutes), not from a caller, so
// every entry point is covered alike: the m key, a row's mute button, river / saved rows that
// claim the key themselves, and the Sources page.
//
// It is NOT a live region (an interactive control does not belong in one): the text is spoken
// through the shell's polite status region, which the hook feeds via `announce`.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceId } from "../../../shared/contract";
import type { AppServices } from "../../app/services";
import { undoMute, watchSourceMutes } from "./muteModel";

/** How long the notice stays (it waits while it is hovered or holds focus). */
export const MUTE_NOTICE_MS = 10_000;

export interface MuteNotice {
  id: SourceId;
  name: string;
}

export interface MuteNoticeControls {
  notice: MuteNotice | null;
  /** Unmute the source of the notice (no-op without one, or when it is no longer muted). */
  undo: () => void;
  dismiss: () => void;
  /** Pause / resume the auto-dismiss timer (pointer over the notice, focus inside it). */
  hold: (held: boolean) => void;
}

export function useMuteNotice(services: Pick<AppServices, "mutes" | "edition" | "sourcesData" | "settings" | "router">, announce: (message: string) => void): MuteNoticeControls {
  const { mutes, router } = services;
  const [notice, setNotice] = useState<MuteNotice | null>(null);
  const [held, setHeld] = useState(false);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  useEffect(
    () =>
      watchSourceMutes(services, (event) => {
        if (!event) {
          // Restore, "unmute everything", import: keep a notice only while its source is still muted.
          setNotice((n) => (n && !mutes.get().sources.has(n.id) ? null : n));
          return;
        }
        announceRef.current(event.message);
        if (event.kind === "muted") {
          setHeld(false);
          setNotice({ id: event.id, name: event.name });
        } else setNotice((n) => (n?.id === event.id ? null : n));
      }),
    // `services` is a stable object for the life of the app; its stores are what is subscribed to.
    [services, mutes],
  );

  // The notice belongs to the page it was raised on.
  useEffect(() => router.subscribe(() => setNotice(null)), [router]);

  useEffect(() => {
    if (!notice || held) return;
    const timer = setTimeout(() => setNotice(null), MUTE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, held]);

  const undo = useCallback(() => {
    const current = noticeRef.current;
    if (!current) return;
    // The store change comes back through watchSourceMutes: it clears the notice and announces.
    if (!undoMute(mutes, current.id)) setNotice(null);
  }, [mutes]);
  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, undo, dismiss, hold: setHeld };
}

export interface MuteToastProps extends MuteNoticeControls {
  /**
   * Move focus to Undo when the notice appears and focus was lost (the muted row unmounted under
   * it). On for readers who turned single-key shortcuts off - they have no "u" key.
   */
  focusUndo?: boolean;
  /** Mention the "u" key (single-key shortcuts are on). */
  showKey?: boolean;
}

export function MuteToast({ notice, undo, dismiss, hold, focusUndo = false, showKey = true }: MuteToastProps) {
  const undoRef = useRef<HTMLButtonElement>(null);
  const id = notice?.id ?? null;

  useEffect(() => {
    if (id === null || !focusUndo) return;
    const active = document.activeElement;
    if (active === null || active === document.body) undoRef.current?.focus({ preventScroll: true });
  }, [id, focusUndo]);

  if (!notice) return null;
  return (
    <div
      className="toast"
      role="group"
      aria-label="Source muted"
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
    >
      <span className="toast-text">
        Muted <strong>{notice.name}</strong>
      </span>
      <button ref={undoRef} type="button" className="btn btn-primary" onClick={undo} aria-keyshortcuts={showKey ? "u" : undefined}>
        Undo{showKey && <span aria-hidden="true"> (u)</span>}
      </button>
      <button type="button" className="btn" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
