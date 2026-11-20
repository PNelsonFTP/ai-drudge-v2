// React hooks shared by the secondary pages. Effects only run in the browser; under
// renderToStaticMarkup the pages render whatever the stores already hold.

import { useEffect, type RefObject } from "react";
import type { RiverFile } from "../../../../shared/contract";
import { useEditionState, useServices, useStore, type LoadStatus, type MutesState, type Settings } from "../../../app/services";
import { mutationsTouchText, paintHighlights } from "./browser";
import type { TextRange } from "./rows";

/** Ask for rest.json once the front page data is in (section, search and export need the full lists). */
export function useLoadRest(): void {
  const { edition } = useServices();
  const status = useStore(edition, (s) => s.status);
  useEffect(() => {
    if (status === "front") void edition.loadRest().catch(() => undefined);
  }, [edition, status]);
}

/**
 * Ask for river.json (idempotent) and return it with its load status. Pass `enabled: false` to only
 * read what is already loaded (the briefing does not need the river without watch terms).
 */
export function useRiver(enabled = true): { river: RiverFile | null; status: LoadStatus } {
  const { edition } = useServices();
  const state = useEditionState();
  const wanted = enabled && state.riverStatus === "idle";
  useEffect(() => {
    if (wanted) void edition.loadRiver().catch(() => undefined);
  }, [edition, wanted]);
  return { river: state.river, status: state.riverStatus };
}

export function useMutes(): MutesState {
  return useStore(useServices().mutes);
}

export function useSettings(): Settings {
  return useStore(useServices().settings);
}

/**
 * Highlight matches inside `ref` (see paintHighlights). `find` must be stable between renders
 * (useMemo / useCallback) - it is an effect dependency. Re-paints when the rows change.
 */
export function useTextHighlights(ref: RefObject<Element | null>, name: string, find: ((text: string) => TextRange[]) | null): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || !find) return;
    let clear = paintHighlights(root, name, find);
    if (typeof MutationObserver === "undefined") return () => clear();
    let frame = 0;
    // Rows re-render on their own schedule (relative times tick, summaries expand); ranges into
    // replaced text nodes go stale, so repaint after any change of TEXT inside the list. Text-free
    // changes (icon buttons mounted on hover) are ignored.
    const observer = new MutationObserver((records) => {
      if (frame || !mutationsTouchText(records)) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        clear();
        clear = paintHighlights(root, name, find);
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clear();
    };
  }, [ref, name, find]);
}
