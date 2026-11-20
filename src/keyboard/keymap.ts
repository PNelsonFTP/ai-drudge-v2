// Keyboard map as a pure reducer: (state, key) -> (state, command). No DOM, no React - the hook in
// useKeyboardNav.ts turns commands into effects.
//
//   j / k        next / previous headline        o / Enter    open it
//   b            bookmark                        l            read later
//   s            show / hide summary             a            show / hide "also" coverage
//   m            mute the headline's source      /            focus search
//   [ / ]        previous / next section         ?            this help
//   g then h/s/l/w/n   go home / saved / later / watch / new          Esc   close
//   u            undo the last mute (while its notice is showing)
//
// Ignored while typing in a field and with Ctrl / Cmd / Alt held, so browser and screen-reader
// shortcuts keep working. Settings can turn every single-key shortcut off (WCAG 2.1.4): then only
// Escape acts (`shortcutsOff`).

import type { Route, RowAction } from "../app/services";

/** Actions that apply to the headline row under the cursor (the contract lives in services.ts). */
export { ROW_ACTIONS, type RowAction } from "../app/services";

export type KeyCommand =
  | { type: "move"; delta: 1 | -1 }
  | { type: "row"; action: RowAction }
  | { type: "section"; delta: 1 | -1 }
  | { type: "search" }
  | { type: "go"; route: Route }
  | { type: "help" }
  /** Undo the last mute while its notice is showing (the shell decides whether there is one). */
  | { type: "undo" }
  | { type: "close" };

export interface KeyInput {
  /** KeyboardEvent.key */
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Auto-repeat of a held key. */
  repeat?: boolean;
  /** Focus is in a text field, select or contenteditable. */
  typing?: boolean;
  /** Focus is on a link / button / control whose own Enter must keep working. */
  onControl?: boolean;
  /** A modal dialog is open. */
  modal?: boolean;
  /** The reader turned single-key shortcuts off (Settings): only Escape acts. */
  shortcutsOff?: boolean;
  /** Event time in ms (for the g-prefix timeout). */
  timeMs: number;
}

export interface KeyState {
  /** A pending "g" prefix and when it was pressed. */
  prefix: "g" | null;
  prefixAt: number;
}

export const INITIAL_KEY_STATE: KeyState = { prefix: null, prefixAt: 0 };

/** How long "g" waits for its second key. */
export const PREFIX_TIMEOUT_MS = 1500;

export interface KeyResult {
  state: KeyState;
  command: KeyCommand | null;
  /** True when the browser default must be suppressed ("/" typing into the page's quick find, ...). */
  preventDefault: boolean;
}

/** Second key of the "g" chord -> destination. */
export const GO_KEYS: Readonly<Record<string, Route>> = {
  h: { name: "home" },
  s: { name: "saved", tab: "bookmarks" },
  l: { name: "saved", tab: "later" },
  w: { name: "watch" },
  n: { name: "new" },
};

const ROW_KEYS: Readonly<Record<string, RowAction>> = {
  o: "open",
  b: "bookmark",
  l: "later",
  s: "summary",
  a: "also",
  m: "mute",
};

const none = (state: KeyState = INITIAL_KEY_STATE): KeyResult => ({ state, command: null, preventDefault: false });
const run = (command: KeyCommand, preventDefault = true): KeyResult => ({ state: INITIAL_KEY_STATE, command, preventDefault });

function plainCommand(key: string, input: KeyInput): KeyCommand | null {
  if (key === "j") return { type: "move", delta: 1 };
  if (key === "k") return { type: "move", delta: -1 };
  if (key === "]") return { type: "section", delta: 1 };
  if (key === "[") return { type: "section", delta: -1 };
  if (key === "/") return { type: "search" };
  if (key === "?") return { type: "help" };
  if (key === "u") return { type: "undo" };
  // Enter on a focused link or button is the browser's; elsewhere it opens the row under the cursor.
  if (key === "Enter") return input.onControl ? null : { type: "row", action: "open" };
  return Object.hasOwn(ROW_KEYS, key) ? { type: "row", action: ROW_KEYS[key] } : null;
}

export function reduceKey(state: KeyState, input: KeyInput): KeyResult {
  if (input.ctrlKey || input.metaKey || input.altKey) return none();

  // Escape always closes; it is never swallowed here (the native <dialog> closes on it too). The
  // search box stops its own Escape default - a browser would clear the field - and blurs itself.
  if (input.key === "Escape") return run({ type: "close" }, false);
  if (input.typing || input.shortcutsOff) return none();

  // Shift is only meaningful for "?" - "J" (Shift+j) is not "j". Caps Lock without Shift still works.
  const key = input.key.length === 1 && !input.shiftKey ? input.key.toLowerCase() : input.key;

  if (input.modal) return key === "?" && !input.repeat ? run({ type: "help" }) : none();

  const prefixLive = state.prefix === "g" && input.timeMs - state.prefixAt <= PREFIX_TIMEOUT_MS;
  if (prefixLive && !input.repeat) {
    if (Object.hasOwn(GO_KEYS, key)) return run({ type: "go", route: GO_KEYS[key] });
    // Any other key cancels the prefix and is handled as a plain key below.
  }

  if (key === "g") return input.repeat ? none(state) : { state: { prefix: "g", prefixAt: input.timeMs }, command: null, preventDefault: false };

  const command = plainCommand(key, input);
  if (!command) return none();
  // Only cursor movement auto-repeats: a held "b" must not flip a bookmark 30 times a second.
  if (input.repeat && command.type !== "move") return none();
  return run(command);
}

export interface KeyBinding {
  keys: readonly string[];
  /** "then" for chords (g then h), "or" for alternatives (o or Enter). */
  join?: "then" | "or";
  label: string;
}

export interface KeyBindingGroup {
  title: string;
  bindings: readonly KeyBinding[];
}

/** The help overlay's content. Kept next to the reducer so the two cannot drift (keymap.test.ts checks). */
export const KEY_BINDING_GROUPS: readonly KeyBindingGroup[] = [
  {
    title: "Move",
    bindings: [
      { keys: ["j"], label: "Next headline" },
      { keys: ["k"], label: "Previous headline" },
      { keys: ["]"], label: "Next section" },
      { keys: ["["], label: "Previous section" },
      { keys: ["/"], label: "Search" },
    ],
  },
  {
    title: "Headline under the cursor",
    bindings: [
      { keys: ["o", "Enter"], join: "or", label: "Open the story" },
      { keys: ["b"], label: "Bookmark it" },
      { keys: ["l"], label: "Save it for later" },
      { keys: ["s"], label: "Show or hide the summary" },
      { keys: ["a"], label: "Show or hide other coverage (“Also”)" },
      { keys: ["m"], label: "Mute this source" },
      { keys: ["u"], label: "Undo the last mute (while its notice is showing)" },
    ],
  },
  {
    title: "Go to",
    bindings: [
      { keys: ["g", "h"], join: "then", label: "Front page" },
      { keys: ["g", "s"], join: "then", label: "Bookmarks" },
      { keys: ["g", "l"], join: "then", label: "Read-later list" },
      { keys: ["g", "w"], join: "then", label: "Watchlist" },
      { keys: ["g", "n"], join: "then", label: "New since your last visit" },
    ],
  },
  {
    title: "General",
    bindings: [
      { keys: ["?"], label: "Show or hide this help" },
      { keys: ["Esc"], label: "Close a dialog or menu, leave the search box" },
    ],
  },
];

/** Index of the row the cursor moves to; -1 when there are no rows. No wrap-around. */
export function nextIndex(count: number, current: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/** Vertical extent of a section in viewport coordinates (from getBoundingClientRect). */
export interface SectionBox {
  top: number;
  bottom: number;
}

/**
 * Index of the section [ / ] jumps to, or -1 for "stay where you are".
 *
 * `boxes` are the rendered sections in DOM order - on the home page that is column by column, so
 * several sections share a top. `at` is the section holding DOM focus or the row cursor (-1 when
 * neither is inside a section); `line` is the reading line just under the pinned chrome.
 *
 * Without a current section the FIRST section in DOM order that straddles the line counts as
 * current (the left-most column), never the last one whose top is above it (that was a section of
 * the right-most column). When the line is in no section - above the grid, below it, in a gap -
 * "]" goes to the first section that starts below the line and "[" to the last one that ends
 * above it; with none there, nothing moves ("[" at the top of the page must not jump to the end).
 */
export function sectionJumpIndex(boxes: readonly SectionBox[], at: number, line: number, delta: 1 | -1): number {
  const count = boxes.length;
  if (count === 0) return -1;
  if (at >= 0 && at < count) return nextIndex(count, at, delta);
  const straddling = boxes.findIndex((b) => b.top <= line && b.bottom > line);
  if (straddling >= 0) return nextIndex(count, straddling, delta);
  if (delta > 0) return boxes.findIndex((b) => b.top > line);
  for (let i = count - 1; i >= 0; i--) if (boxes[i].bottom <= line) return i;
  return -1;
}
