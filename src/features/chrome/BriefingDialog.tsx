// The briefing dialog of the masthead's "Briefing" button, as its own chunk: the dialog body, the
// briefing builder and the kit stylesheet are needed only once the button is used, so they stay
// out of the entry bundle. Loaded by Masthead.tsx through a retryable dynamic import.
//
// Node tests cannot load CSS: nothing a test evaluates may import this module statically.

import "../export/kit/kit.css";
import { BriefingPanel } from "../export/BriefingExportButton";
import { Dialog } from "../export/kit/Dialog";

export interface BriefingDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function BriefingDialog({ open, onClose }: BriefingDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Briefing export" wide>
      <BriefingPanel />
    </Dialog>
  );
}
