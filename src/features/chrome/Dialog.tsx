// Modal dialog on the native <dialog> element: the browser supplies the focus trap, Escape, the
// inert background and focus return that V1's hand-rolled overlays lacked. Styled by .modal
// (components.css) with tokens, so it is readable in both themes.

import { useEffect, useId, useRef, type ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Extra class on the <dialog>. */
  className?: string;
}

export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal throws when the element is already open or detached; neither is fatal.
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : "modal"}
      aria-labelledby={titleId}
      // Fires for Escape, the close button and dialog.close(): keeps the caller's state in step.
      onClose={onClose}
      // The dialog has no padding, so a click whose target is the dialog itself is on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-head section-heading">
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="modal-body">{open ? children : null}</div>
    </dialog>
  );
}
