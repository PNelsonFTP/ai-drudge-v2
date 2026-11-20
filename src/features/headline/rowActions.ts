// Row actions requested from OUTSIDE the row (keyboard layer, a future command palette).
//
// Two ways reach a row; they never overlap:
//
// 1. The shell's keyboard layer (src/keyboard/useKeyboardNav.ts, "ROW CONTRACT") dispatches a
//    bubbling "aid:row-action" event ON THE ROW ELEMENT and, unless a listener calls
//    preventDefault(), clicks the row's  [data-row-action="<action>"]  control or runs its own
//    default (bookmark / later / mute through the stores, with a screen-reader announcement).
//    HeadlineRow answers that DECLARATIVELY - it marks its controls with data-row-action and its
//    title with data-row-link - so the hub leaves such events alone (handling them here as well
//    would toggle everything twice) UNLESS the row claims the action: what the shell's default
//    cannot do (save or mute a river row / snapshot that is not in the edition).
//
// 2. Anything else can address a row by id, without knowing its element:
//
//      document.dispatchEvent(new CustomEvent("aid:row-action", { cancelable: true, detail: { id, action } }))
//
//    `id` is the row's data-aid; `action` is one of ROW_ACTIONS (key letters and a few spellings
//    are accepted too - see ALIASES); an optional `detail.el` picks the instance when the same
//    story is rendered twice. The hub handles these, calls preventDefault() on the event, and runs
//    exactly ONE row instance: a story listed in two sections must not toggle its bookmark twice.
//
// ONE listener for the whole page, not one per row.

import { ROW_ACTION_EVENT, ROW_ACTIONS as KEYBOARD_ROW_ACTIONS } from "../../app/services";

export { ROW_ACTION_EVENT };

/** Everything a row can be asked to do: the keyboard contract's actions plus two only the row has. */
export const ROW_ACTIONS = [...KEYBOARD_ROW_ACTIONS, "copy", "menu"] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

const ALIASES: Readonly<Record<string, RowAction>> = {
  open: "open",
  o: "open",
  enter: "open",
  bookmark: "bookmark",
  b: "bookmark",
  later: "later",
  l: "later",
  readlater: "later",
  "read-later": "later",
  summary: "summary",
  s: "summary",
  also: "also",
  a: "also",
  coverage: "also",
  mute: "mute",
  m: "mute",
  "mute-source": "mute",
  mutesource: "mute",
  copy: "copy",
  c: "copy",
  "copy-link": "copy",
  menu: "menu",
};

export interface RowActionRequest {
  id: string;
  action: RowAction;
  /** The row element the request is aimed at, when the sender provided one. */
  element: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Validate an event detail. null for anything that is not `{ id: string, action: <known> }`. */
export function parseRowAction(detail: unknown): RowActionRequest | null {
  if (!isRecord(detail)) return null;
  const { id, action } = detail;
  if (typeof id !== "string" || id === "" || typeof action !== "string") return null;
  const known = ALIASES[action.toLowerCase()];
  if (!known) return null;
  return { id, action: known, element: detail.el ?? detail.element ?? null };
}

export interface RowHandle {
  /** The row's root element (null while unmounted). */
  element(): unknown;
  run(action: RowAction): void;
  /** True when the row itself must perform a shell key action (see header, point 1). */
  claims?(action: RowAction): boolean;
}

export interface RowActionHub {
  /** Register a mounted row; returns the unregister function. */
  register(id: string, handle: RowHandle): () => void;
  /** Route a request to one row. False when no row with that id is mounted. */
  dispatch(request: RowActionRequest): boolean;
  /** Number of registered row instances. */
  size(): number;
}

type Listener = (event: Event) => void;

export interface RowActionTarget {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

function containsNode(outer: unknown, inner: unknown): boolean {
  if (outer === inner) return true;
  if (!isRecord(outer) || typeof outer.contains !== "function") return false;
  try {
    return Boolean((outer.contains as (n: unknown) => unknown)(inner));
  } catch {
    return false;
  }
}

/**
 * A hub bound to an event target (`document` in the app, an EventTarget in tests; null = events
 * are never received and only `dispatch` works). The listener is attached while at least one row is
 * registered.
 */
export function createRowActionHub(target: RowActionTarget | null): RowActionHub {
  const rows = new Map<string, Set<RowHandle>>();
  let count = 0;

  /** The instance a request is aimed at: the one at its element hint, else the first registered. */
  const pick = (request: RowActionRequest): RowHandle | undefined => {
    const handles = rows.get(request.id);
    if (!handles) return undefined;
    if (request.element !== null && request.element !== undefined) {
      for (const h of handles) {
        const el = h.element();
        if (el && (containsNode(el, request.element) || containsNode(request.element, el))) return h;
      }
    }
    return handles.values().next().value;
  };

  const dispatch = (request: RowActionRequest): boolean => {
    const chosen = pick(request);
    if (!chosen) return false;
    chosen.run(request.action);
    return true;
  };

  const onEvent: Listener = (event) => {
    const request = parseRowAction((event as Event & { detail?: unknown }).detail);
    if (!request) return;
    if (event.target === target) {
      // Addressed by id.
      if (dispatch(request)) event.preventDefault();
      return;
    }
    // Bubbled up from a row element: the shell's keyboard contract. Only what the row claims.
    request.element = event.target;
    const row = pick(request);
    if (row?.claims?.(request.action)) {
      row.run(request.action);
      event.preventDefault();
    }
  };

  return {
    register(id, handle) {
      let set = rows.get(id);
      if (!set) {
        set = new Set();
        rows.set(id, set);
      }
      set.add(handle);
      if (count === 0) target?.addEventListener(ROW_ACTION_EVENT, onEvent);
      count += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = rows.get(id);
        current?.delete(handle);
        if (current && current.size === 0) rows.delete(id);
        count -= 1;
        if (count === 0) target?.removeEventListener(ROW_ACTION_EVENT, onEvent);
      };
    },
    dispatch,
    size: () => count,
  };
}

let pageHub: RowActionHub | null = null;
let pageTarget: RowActionTarget | null = null;

/**
 * The page-wide hub, listening on `document` (a detached hub where there is no document). Bound to
 * the document it was created for: a new document (tests, a re-created frame) gets a new hub.
 */
export function documentRowActions(): RowActionHub {
  const target: RowActionTarget | null = typeof document === "undefined" ? null : document;
  if (!pageHub || pageTarget !== target) {
    pageHub = createRowActionHub(target);
    pageTarget = target;
  }
  return pageHub;
}
