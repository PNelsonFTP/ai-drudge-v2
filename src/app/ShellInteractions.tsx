// The parts of the shell nobody can see or use before the first paint, as ONE chunk of their own:
//
//   keyboard layer (j/k, row actions, [ ], g-chords, /, ?, u, Esc)   src/keyboard
//   "?" help dialog                                                    src/keyboard/ShortcutsHelp
//   hover card                                                         src/features/headline/HoverCard
//   mute notice ("Muted <source> · Undo")                              src/features/chrome/MuteToast
//
// AppShell fetches this module right after its first commit (useShellInteractions) and mounts the
// default export where these four used to be rendered, so the markup order is unchanged. Nothing
// here paints until the reader acts: a key, a pointer over a headline, a mute, the footer's
// "Keyboard shortcuts" button.
//
// Imported statically only by tests; the app reaches it through import().

import type { Dispatch, SetStateAction } from "react";
import { MuteToast, useMuteNotice } from "../features/chrome/MuteToast";
import { HoverCard } from "../features/headline/HoverCard";
import { ShortcutsHelp } from "../keyboard/ShortcutsHelp";
import { useKeyboardNav } from "../keyboard/useKeyboardNav";
import { useServices } from "./services";

export interface ShellInteractionsProps {
  /** AppShellProps.keyboard: false removes the key listeners altogether (Escape included). */
  keyboard: boolean;
  /** The reader's `shortcuts` setting: false leaves only Escape (WCAG 2.1.4). */
  shortcuts: boolean;
  /** Help dialog state, owned by the shell: the footer button opens it before this chunk exists. */
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  /** Feeds the shell's polite status region. */
  announce: (message: string) => void;
}

export default function ShellInteractions({ keyboard, shortcuts, helpOpen, setHelpOpen, announce }: ShellInteractionsProps) {
  const services = useServices();
  // Visible confirmation + undo for a muted source, whatever muted it (m key, row button, Sources page).
  const muteNotice = useMuteNotice(services, announce);

  useKeyboardNav({
    enabled: keyboard,
    characterKeys: shortcuts,
    onHelp: () => setHelpOpen((open) => !open),
    onClose: () => {
      setHelpOpen(false);
      muteNotice.dismiss();
    },
    onUndo: muteNotice.undo,
    announce,
  });

  return (
    <>
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} enabled={shortcuts} settingsHref={services.router.href({ name: "settings" })} />
      {/* One hover preview for every page (desktop nicety; summaries are always reachable inline). */}
      <HoverCard />
      {/* Sighted confirmation of a mute, with Undo. Its words are spoken by the shell's status region. */}
      <MuteToast {...muteNotice} showKey={shortcuts} focusUndo={!shortcuts} />
    </>
  );
}
