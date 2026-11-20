// Hover-card state in its own store, so a mouse move re-renders the card and nothing else
// (V1 kept it in App state: one hover re-rendered all 185 rows).
//
// The card is a desktop nicety: show() is ignored on devices without a real hover pointer, opens
// after a short intent delay (scanning down a column must not pop a card per row), and hide()
// waits 200 ms so the pointer can travel into the card (which then calls hold()).

import { createStore, type HoverState, type HoverStore } from "./services";

export const HOVER_HIDE_DELAY_MS = 200;
export const HOVER_OPEN_DELAY_MS = 300;

export interface HoverStoreOptions {
  hideDelayMs?: number;
  openDelayMs?: number;
  /** Is there a hover-capable fine pointer? Default: matchMedia("(hover: hover) and (pointer: fine)"). */
  canHover?: () => boolean;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

function defaultCanHover(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export function createHoverStore(opts: HoverStoreOptions = {}): HoverStore {
  const hideDelay = opts.hideDelayMs ?? HOVER_HIDE_DELAY_MS;
  const openDelay = opts.openDelayMs ?? HOVER_OPEN_DELAY_MS;
  const canHover = opts.canHover ?? defaultCanHover;
  const startTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const stopTimer = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const store = createStore<HoverState | null>(null);
  let hideTimer: unknown = null;
  let openTimer: unknown = null;

  const cancel = (which: "hide" | "open"): void => {
    if (which === "hide" && hideTimer !== null) {
      stopTimer(hideTimer);
      hideTimer = null;
    }
    if (which === "open" && openTimer !== null) {
      stopTimer(openTimer);
      openTimer = null;
    }
  };

  const set = (next: HoverState): void => {
    const cur = store.get();
    if (cur && cur.id === next.id && cur.x === next.x && cur.y === next.y) return;
    store.set(next);
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    show(id, x, y) {
      if (!canHover()) return;
      cancel("hide");
      cancel("open");
      const next: HoverState = { id, x, y };
      // A card is already up: moving to the next row swaps it at once (no flicker, no second wait).
      if (store.get() !== null || openDelay <= 0) {
        set(next);
        return;
      }
      openTimer = startTimer(() => {
        openTimer = null;
        set(next);
      }, openDelay);
    },
    hide() {
      cancel("open");
      if (store.get() === null || hideTimer !== null) return;
      hideTimer = startTimer(() => {
        hideTimer = null;
        store.set(null);
      }, hideDelay);
    },
    hold() {
      cancel("hide");
    },
  };
}
