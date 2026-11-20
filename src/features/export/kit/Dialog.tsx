import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Wider layout for content with a preview (briefing export). */
  wide?: boolean;
}

/**
 * Modal on the native <dialog> element: showModal() gives the focus trap, Escape, an inert page
 * behind it and focus return to the invoking control. Themed with the V1 tokens (the V1 modals
 * were black on #161616 in the light theme). Content - including the title that labels the
 * dialog - is rendered only while open, so a closed dialog carries no dangling aria reference.
 */
export function Dialog({ open, onClose, title, children, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      // showModal is missing in very old browsers and throws on a detached element; neither is fatal.
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // The dialog has no padding, so a click whose target is the dialog itself landed on the backdrop.
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog ref={ref} className={wide ? "sp-dialog sp-dialog-wide" : "sp-dialog"} aria-labelledby={open ? titleId : undefined} onClose={onClose} onClick={onBackdrop}>
      {open && (
        <div className="sp-dialog-body">
          <div className="sp-dialog-head section-heading">
            <h2 id={titleId} className="sp-dialog-title">
              {title}
            </h2>
            <button type="button" className="sp-btn sp-btn-quiet" aria-label="Close" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="sp-dialog-content">{children}</div>
        </div>
      )}
    </dialog>
  );
}
