// Keyboard navigation hook: one document-level keydown listener that feeds keymap.ts and turns its
// commands into effects. Mounted once by AppShell.
//
// ROW CONTRACT - STABLE. src/features/headline (HeadlineRow + rowActions.ts) implements exactly this.
// -----------------------------------------------------------------------------------------------
// 1. The row's root element carries  data-aid="<article id>".  Rows are walked in DOM order;
//    rows that are not rendered (display:none) are skipped. No refs, no registration.
// 2. The cursor row gets the attribute  data-kbd-current  (styled in components.css), its primary
//    link receives DOM focus, and FocusStore holds its article id.
//    Primary link = the first  a[data-row-link]  in the row, else its first  a[href].
// 3. Row actions (o, b, l, s, a, m - and Enter when focus is not on a control) are delivered in
//    three steps; the FIRST that applies wins, so nothing ever runs twice:
//      a. A cancelable, bubbling CustomEvent is dispatched ON THE ROW ELEMENT:
//           type:    "aid:row-action"                       (ROW_ACTION_EVENT)
//           detail:  { id: ArticleId, action: "open" | "bookmark" | "later" | "summary" | "also" | "mute",
//                      el: HTMLElement }                    (el = the row element = event.target)
//         A listener that performs the action itself MUST call event.preventDefault().
//      b. Otherwise, if the row contains an element with  data-row-action="<action>"
//         (e.g. <button data-row-action="summary" aria-expanded=...>), that element is clicked.
//      c. Otherwise the shell's default runs: "open" clicks the primary link; "bookmark" / "later" /
//         "mute" call SavedStore / MutesStore for an article that IS in the edition and announce
//         the result; "summary" and "also" have no default (they are row-internal state).
//    A row therefore needs no listener when it marks its controls with data-row-action; it only
//    has to claim (preventDefault) what the default cannot do - saving or muting a row whose
//    article is not in the edition (river rows, saved snapshots).
// 4. Sections that [ and ] should jump between carry  id="sec-<sectionId>"  and contain their rows.
//    A section without rendered rows (collapsed) is still a stop: its heading link ("h2 a[href]",
//    else its first link or button) receives focus, so the next [ / ] continues from it.
// -----------------------------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { useServices } from "../app/services";
import { SEARCH_INPUT_ID, SECTION_ID_PREFIX } from "../features/chrome/ids";
import { INITIAL_KEY_STATE, nextIndex, reduceKey, sectionJumpIndex, type KeyCommand, type KeyInput, type RowAction } from "./keymap";
import { ROW_ID_ATTR, deliverRowAction, primaryLink } from "./rowActions";

export { ROW_ACTION_ATTR, ROW_ACTION_EVENT, ROW_ID_ATTR, ROW_LINK_ATTR, type RowActionDetail } from "./rowActions";

export const ROW_SELECTOR = `[${ROW_ID_ATTR}]`;
export const KBD_CURRENT_ATTR = "data-kbd-current";
export const SECTION_SELECTOR = `[id^="${SECTION_ID_PREFIX}"]`;

export interface KeyboardNavOptions {
  /** Toggle the shortcuts help. */
  onHelp: () => void;
  /** Escape was pressed outside a field (close menus, overlays). */
  onClose?: () => void;
  /** Screen-reader announcement of what a default row action did ("Bookmarked: <title>"). */
  announce?: (message: string) => void;
  /** "u": undo the last mute, when the shell is showing its notice. */
  onUndo?: () => void;
  /** Default true. False removes the listeners altogether (Escape included). */
  enabled?: boolean;
  /**
   * Single-key shortcuts (default true). False is the reader's "off" switch (WCAG 2.1.4): the
   * listener stays, but only Escape acts - it still leaves a field and hides the hover card.
   */
  characterKeys?: boolean;
}

/** <input> types that take no text: single-key shortcuts stay active on them. */
const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"]);

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(el.type);
}

function isControl(el: Element | null): boolean {
  return el instanceof Element && el.closest("a[href], button, summary, input, select, textarea, [role='button'], [role='link'], [role='menuitem']") !== null;
}

function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

function visible<T extends Element>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)].filter(isRendered);
}

/** Height of the pinned chrome, from the --sticky-h variable AppShell maintains. */
function stickyHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sticky-h");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export function useKeyboardNav(options: KeyboardNavOptions): void {
  const services = useServices();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let keyState = INITIAL_KEY_STATE;
    let current: HTMLElement | null = null;
    let lastIndex = -1;

    const mark = (row: HTMLElement | null, opts: { focus?: boolean; scroll?: boolean } = {}): void => {
      if (current && current !== row) current.removeAttribute(KBD_CURRENT_ATTR);
      current = row;
      if (!row) {
        services.focus.set(null);
        return;
      }
      row.setAttribute(KBD_CURRENT_ATTR, "");
      services.focus.set(row.getAttribute(ROW_ID_ATTR));
      if (opts.focus) primaryLink<HTMLElement>(row)?.focus({ preventScroll: true });
      // "nearest" + the html scroll-padding keeps the row clear of the sticky chrome.
      if (opts.scroll) row.scrollIntoView({ block: "nearest" });
    };

    /** Index of the cursor row: the row holding DOM focus, else the marked row, else the stored id. */
    const locate = (rows: HTMLElement[]): number => {
      const focused = document.activeElement?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
      if (focused) {
        const i = rows.indexOf(focused);
        if (i >= 0) return i;
      }
      if (current?.isConnected) {
        const i = rows.indexOf(current);
        if (i >= 0) return i;
      }
      const id = services.focus.get();
      return id === null ? -1 : rows.findIndex((r) => r.getAttribute(ROW_ID_ATTR) === id);
    };

    const move = (delta: 1 | -1): void => {
      const rows = visible<HTMLElement>(document, ROW_SELECTOR);
      if (rows.length === 0) return;
      const at = locate(rows);
      let next: number;
      if (at >= 0) next = nextIndex(rows.length, at, delta);
      else if (lastIndex >= 0) {
        // The cursor row is gone (muted, filtered): continue from where it was.
        next = Math.min(rows.length - 1, Math.max(0, delta > 0 ? lastIndex : lastIndex - 1));
      } else {
        // First use: start at the first row below the pinned chrome, not at the top of the document.
        const top = stickyHeight();
        const first = rows.findIndex((r) => r.getBoundingClientRect().top >= top);
        next = delta > 0 ? Math.max(0, first) : first > 0 ? first - 1 : 0;
      }
      lastIndex = next;
      mark(rows[next], { focus: true, scroll: true });
    };

    const rowAction = (action: RowAction): void => {
      const rows = visible<HTMLElement>(document, ROW_SELECTOR);
      const at = locate(rows);
      if (at < 0) return;
      const row = rows[at];
      lastIndex = at;
      if (row !== current) mark(row);
      const outcome = deliverRowAction(row, action, services);
      if (outcome.by === "default" && outcome.message) optionsRef.current.announce?.(outcome.message);
    };

    const jumpSection = (delta: 1 | -1): void => {
      const sections = visible<HTMLElement>(document, SECTION_SELECTOR);
      if (sections.length === 0) return;
      // The current section: the one holding DOM focus (a row, or the heading of a collapsed
      // section), else the one holding the cursor row. Derived on every press, never remembered.
      const focusedSection = document.activeElement?.closest<HTMLElement>(SECTION_SELECTOR) ?? null;
      let at = focusedSection ? sections.indexOf(focusedSection) : -1;
      if (at < 0 && current?.isConnected) at = sections.findIndex((s) => s.contains(current));
      // Without either: judged from the reading line just under the pinned chrome.
      const line = stickyHeight() + 24;
      const target = sections[sectionJumpIndex(sections.map((s) => s.getBoundingClientRect()), at, line, delta)];
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      const firstRow = visible<HTMLElement>(target, ROW_SELECTOR)[0] ?? null;
      if (firstRow) {
        lastIndex = visible<HTMLElement>(document, ROW_SELECTOR).indexOf(firstRow);
        mark(firstRow, { focus: true });
        return;
      }
      // No rows (collapsed): focus its heading so the next press starts from HERE instead of
      // resolving the stale cursor to the same section again, and Tab reaches its expand button.
      const stop = target.querySelector<HTMLElement>("h2 a[href]") ?? target.querySelector<HTMLElement>("a[href], button");
      stop?.focus({ preventScroll: true });
    };

    const focusSearch = (): void => {
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      input.focus();
      input.select();
    };

    const close = (typing: boolean): void => {
      const active = document.activeElement;
      // Leaving a field with Escape hands the keys back to j/k without losing what was typed.
      if (typing && active instanceof HTMLElement) {
        active.blur();
        return;
      }
      services.hover.hide();
      optionsRef.current.onClose?.();
    };

    const perform = (command: KeyCommand, typing: boolean): void => {
      switch (command.type) {
        case "move":
          return move(command.delta);
        case "row":
          return rowAction(command.action);
        case "section":
          return jumpSection(command.delta);
        case "search":
          return focusSearch();
        case "go":
          return services.router.go(command.route);
        case "help":
          return optionsRef.current.onHelp();
        case "undo":
          return optionsRef.current.onUndo?.();
        case "close":
          return close(typing);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const typing = isTypingTarget(target);
      const input: KeyInput = {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        typing,
        onControl: isControl(target),
        modal: document.querySelector("dialog[open]") !== null,
        shortcutsOff: optionsRef.current.characterKeys === false,
        timeMs: event.timeStamp,
      };
      const result = reduceKey(keyState, input);
      keyState = result.state;
      if (!result.command) return;
      if (result.preventDefault) event.preventDefault();
      perform(result.command, typing);
    };

    // Tab and the mouse move DOM focus on their own: keep the cursor on the row that has focus.
    const onFocusIn = (event: FocusEvent): void => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>(ROW_SELECTOR) : null;
      if (row && row !== current) mark(row);
    };

    // A new page has new rows: forget the cursor.
    const unsubscribeRouter = services.router.subscribe(() => {
      lastIndex = -1;
      mark(null);
    });

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      unsubscribeRouter();
      current?.removeAttribute(KBD_CURRENT_ATTR);
    };
  }, [services, enabled]);
}
