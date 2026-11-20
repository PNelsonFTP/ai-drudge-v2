import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRoute } from "../app/routes";
import {
  GO_KEYS,
  INITIAL_KEY_STATE,
  KEY_BINDING_GROUPS,
  PREFIX_TIMEOUT_MS,
  ROW_ACTIONS,
  nextIndex,
  reduceKey,
  sectionJumpIndex,
  type KeyCommand,
  type KeyInput,
  type KeyState,
} from "./keymap";

const press = (key: string, extra: Partial<KeyInput> = {}, state: KeyState = INITIAL_KEY_STATE) => reduceKey(state, { key, timeMs: 0, ...extra });
const command = (key: string, extra: Partial<KeyInput> = {}): KeyCommand | null => press(key, extra).command;

/** Feed a sequence of keys (1 ms apart) and collect the commands. */
function type(keys: string[], extra: Partial<KeyInput> = {}): (KeyCommand | null)[] {
  let state = INITIAL_KEY_STATE;
  return keys.map((key, i) => {
    const result = reduceKey(state, { key, timeMs: i, ...extra });
    state = result.state;
    return result.command;
  });
}

describe("reduceKey: single keys", () => {
  it("j / k move the cursor", () => {
    assert.deepEqual(command("j"), { type: "move", delta: 1 });
    assert.deepEqual(command("k"), { type: "move", delta: -1 });
  });

  it("o and Enter open; b l s a m act on the row", () => {
    assert.deepEqual(command("o"), { type: "row", action: "open" });
    assert.deepEqual(command("Enter"), { type: "row", action: "open" });
    assert.deepEqual(command("b"), { type: "row", action: "bookmark" });
    assert.deepEqual(command("l"), { type: "row", action: "later" });
    assert.deepEqual(command("s"), { type: "row", action: "summary" });
    assert.deepEqual(command("a"), { type: "row", action: "also" });
    assert.deepEqual(command("m"), { type: "row", action: "mute" });
  });

  it("every row action has a key", () => {
    const reachable = new Set("objklsam".split("").map((k) => command(k)).flatMap((c) => (c?.type === "row" ? [c.action] : [])));
    assert.deepEqual([...reachable].sort(), [...ROW_ACTIONS].sort());
  });

  it("/ focuses search, [ ] change section, ? opens help, Escape closes", () => {
    assert.deepEqual(command("/"), { type: "search" });
    assert.deepEqual(command("["), { type: "section", delta: -1 });
    assert.deepEqual(command("]"), { type: "section", delta: 1 });
    assert.deepEqual(command("?", { shiftKey: true }), { type: "help" });
    assert.deepEqual(command("Escape"), { type: "close" });
  });

  it("u undoes the last mute (the shell decides whether there is one to undo)", () => {
    assert.deepEqual(command("u"), { type: "undo" });
    assert.equal(command("u", { typing: true }), null);
    assert.equal(command("u", { modal: true }), null);
    assert.equal(command("u", { repeat: true }), null, "a held u must not fire repeatedly");
    assert.equal(command("u", { ctrlKey: true }), null, "Ctrl+U is the browser's view-source");
  });

  it("prevents the default of the keys it handles, but never of Escape or g", () => {
    assert.equal(press("/").preventDefault, true, "'/' must not open the browser's quick find");
    assert.equal(press("j").preventDefault, true);
    assert.equal(press("Escape").preventDefault, false);
    assert.equal(press("g").preventDefault, false);
    assert.equal(press("x").preventDefault, false);
  });

  it("ignores unknown keys and keys that only look like object members", () => {
    for (const key of ["x", "q", "Tab", " ", "ArrowDown", "F5", "constructor", "toString", "__proto__", "Shift", "Dead"]) {
      assert.equal(command(key), null, key);
    }
  });
});

describe("reduceKey: when keys must NOT act", () => {
  it("does nothing while typing in a field (except Escape)", () => {
    for (const key of ["j", "k", "o", "b", "l", "s", "a", "m", "/", "[", "]", "?", "g", "Enter"]) {
      assert.equal(command(key, { typing: true }), null, key);
    }
    assert.deepEqual(command("Escape", { typing: true }), { type: "close" });
    assert.deepEqual(type(["g", "h"], { typing: true }), [null, null]);
  });

  it("with single-key shortcuts turned off only Escape acts (WCAG 2.1.4)", () => {
    for (const key of ["j", "k", "o", "b", "l", "s", "a", "m", "u", "/", "[", "]", "?", "g", "Enter"]) {
      const result = press(key, { shortcutsOff: true, shiftKey: key === "?" });
      assert.equal(result.command, null, key);
      assert.equal(result.preventDefault, false, `${key} must keep its browser default`);
    }
    // Focus on a link or button changes nothing: the keys stay off there too.
    assert.equal(command("m", { shortcutsOff: true, onControl: true }), null);
    assert.deepEqual(type(["g", "s"], { shortcutsOff: true }), [null, null], "no chord either");
    // Escape still leaves a field / closes overlays, and is still not swallowed.
    assert.deepEqual(command("Escape", { shortcutsOff: true }), { type: "close" });
    assert.deepEqual(command("Escape", { shortcutsOff: true, typing: true }), { type: "close" });
    assert.equal(press("Escape", { shortcutsOff: true }).preventDefault, false);
    // Default is on.
    assert.deepEqual(command("m", { shortcutsOff: false }), { type: "row", action: "mute" });
  });

  it("does nothing with Ctrl, Cmd or Alt held (browser and screen-reader shortcuts)", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["j", "b", "l", "s", "/", "Enter", "Escape", "g"]) {
        const result = press(key, { [mod]: true });
        assert.equal(result.command, null, `${mod}+${key}`);
        assert.equal(result.preventDefault, false);
      }
    }
  });

  it("a modifier cancels a pending g prefix", () => {
    let s = press("g").state;
    s = reduceKey(s, { key: "c", metaKey: true, timeMs: 5 }).state;
    assert.deepEqual(reduceKey(s, { key: "h", timeMs: 10 }).command, null);
  });

  it("Shift+letter is not the letter; Caps Lock without Shift is", () => {
    assert.equal(command("J", { shiftKey: true }), null);
    assert.equal(command("B", { shiftKey: true }), null);
    assert.deepEqual(command("J"), { type: "move", delta: 1 });
  });

  it("leaves Enter to the focused link or button", () => {
    assert.equal(command("Enter", { onControl: true }), null);
    assert.equal(press("Enter", { onControl: true }).preventDefault, false);
    // Letters still act on the cursor row when a link has focus (the row's link is focused by j/k).
    assert.deepEqual(command("b", { onControl: true }), { type: "row", action: "bookmark" });
    assert.deepEqual(command("o", { onControl: true }), { type: "row", action: "open" });
  });

  it("with a modal dialog open only ? and Escape act", () => {
    for (const key of ["j", "k", "o", "b", "m", "/", "]", "Enter", "g"]) assert.equal(command(key, { modal: true }), null, key);
    assert.deepEqual(command("?", { modal: true, shiftKey: true }), { type: "help" });
    assert.deepEqual(command("Escape", { modal: true }), { type: "close" });
    assert.deepEqual(type(["g", "h"], { modal: true }), [null, null]);
  });

  it("only cursor movement auto-repeats", () => {
    assert.deepEqual(command("j", { repeat: true }), { type: "move", delta: 1 });
    assert.deepEqual(command("k", { repeat: true }), { type: "move", delta: -1 });
    for (const key of ["b", "l", "m", "s", "a", "o", "Enter", "/", "?", "[", "]"]) assert.equal(command(key, { repeat: true }), null, key);
  });
});

describe("reduceKey: g chords", () => {
  it("g then h / s / l / w / n navigates", () => {
    const expected: Record<string, string> = { h: "#/", s: "#/saved", l: "#/later", w: "#/watch", n: "#/new" };
    for (const [key, hash] of Object.entries(expected)) {
      const [first, second] = type(["g", key]);
      assert.equal(first, null);
      assert.ok(second && second.type === "go", key);
      assert.equal(formatRoute(second.route), hash);
    }
    assert.deepEqual(Object.keys(GO_KEYS).sort(), Object.keys(expected).sort());
  });

  it("g arms the prefix; the next key consumes it", () => {
    const armed = press("g");
    assert.equal(armed.command, null);
    assert.equal(armed.state.prefix, "g");
    const done = reduceKey(armed.state, { key: "h", timeMs: 100 });
    assert.equal(done.state.prefix, null);
    // So "l" and "s" are row actions again right after a chord.
    assert.deepEqual(type(["g", "l", "l", "s"]).map((c) => c?.type), [undefined, "go", "row", "row"]);
  });

  it("the prefix expires", () => {
    const armed = press("g").state;
    assert.equal(reduceKey(armed, { key: "h", timeMs: PREFIX_TIMEOUT_MS }).command?.type, "go");
    assert.equal(reduceKey(armed, { key: "h", timeMs: PREFIX_TIMEOUT_MS + 1 }).command, null);
    // After the timeout "s" is the summary toggle, not "go saved".
    assert.deepEqual(reduceKey(armed, { key: "s", timeMs: PREFIX_TIMEOUT_MS + 1 }).command, { type: "row", action: "summary" });
  });

  it("a non-chord key after g cancels the prefix and acts normally", () => {
    assert.deepEqual(type(["g", "j", "h"]), [null, { type: "move", delta: 1 }, null]);
    assert.deepEqual(type(["g", "x", "h"]), [null, null, null]);
    assert.equal(type(["g", "g", "h"])[2]?.type, "go");
    assert.deepEqual(type(["g", "Escape", "h"]), [null, { type: "close" }, null]);
  });

  it("a held g does not re-arm or fire", () => {
    const armed = press("g").state;
    const held = reduceKey(armed, { key: "g", repeat: true, timeMs: 30 });
    assert.equal(held.command, null);
    assert.deepEqual(held.state, armed);
    assert.equal(reduceKey(armed, { key: "h", repeat: true, timeMs: 40 }).command, null);
  });
});

describe("key binding table (help overlay)", () => {
  const bindings = KEY_BINDING_GROUPS.flatMap((g) => g.bindings);

  it("documents every key the reducer understands", () => {
    const documented = new Set(bindings.flatMap((b) => b.keys));
    for (const key of ["j", "k", "o", "Enter", "b", "l", "s", "a", "m", "u", "/", "[", "]", "g", "h", "w", "n", "?", "Esc"]) {
      assert.ok(documented.has(key), `help is missing "${key}"`);
    }
  });

  it("documents nothing the reducer ignores", () => {
    for (const b of bindings) {
      if (b.join === "then") {
        assert.equal(type([...b.keys]).at(-1)?.type, "go", b.label);
      } else {
        for (const key of b.keys) {
          const real = key === "Esc" ? "Escape" : key;
          assert.ok(command(real, { shiftKey: real === "?" }), `"${key}" (${b.label}) does nothing`);
        }
      }
    }
  });

  it("has unique labels (they are React keys)", () => {
    assert.equal(new Set(bindings.map((b) => b.label)).size, bindings.length);
    assert.equal(new Set(KEY_BINDING_GROUPS.map((g) => g.title)).size, KEY_BINDING_GROUPS.length);
  });
});

describe("nextIndex", () => {
  it("moves without wrapping", () => {
    assert.equal(nextIndex(5, 0, 1), 1);
    assert.equal(nextIndex(5, 4, 1), 4);
    assert.equal(nextIndex(5, 0, -1), 0);
    assert.equal(nextIndex(5, 3, -1), 2);
  });

  it("starts at the first row going down and the last going up", () => {
    assert.equal(nextIndex(5, -1, 1), 0);
    assert.equal(nextIndex(5, -1, -1), 4);
    assert.equal(nextIndex(5, 99, 1), 0);
  });

  it("returns -1 when there is nothing to move over", () => {
    assert.equal(nextIndex(0, -1, 1), -1);
    assert.equal(nextIndex(0, 3, -1), -1);
  });
});

describe("sectionJumpIndex ([ and ])", () => {
  // The home grid as the browser lays it out at desktop width: DOM order is column by column, so
  // sections 0-4 are column 1, 5-9 column 2, 10-14 column 3, and each column starts at the same top.
  const GRID_TOP = 600;
  const HEIGHT = 400;
  const GAP = 16;
  const grid = (scrollY: number, columns = 3, perColumn = 5) =>
    Array.from({ length: columns * perColumn }, (_, i) => {
      const top = GRID_TOP + (i % perColumn) * (HEIGHT + GAP) - scrollY;
      return { top, bottom: top + HEIGHT };
    });
  const LINE = 160; // pinned chrome + 24

  it("with a current section (focus or cursor) it steps in DOM order without wrapping", () => {
    const boxes = grid(0);
    assert.equal(sectionJumpIndex(boxes, 0, LINE, 1), 1);
    assert.equal(sectionJumpIndex(boxes, 4, LINE, 1), 5, "bottom of column 1 -> top of column 2");
    assert.equal(sectionJumpIndex(boxes, 5, LINE, -1), 4);
    assert.equal(sectionJumpIndex(boxes, 0, LINE, -1), 0);
    assert.equal(sectionJumpIndex(boxes, 14, LINE, 1), 14);
  });

  it("no cursor, first grid row at the top: the current section is the LEFT-most column's", () => {
    // Scrolled so the first row of sections straddles the reading line. All three share a top; the
    // old code kept the last match (column 3) and jumped to its second section.
    const boxes = grid(GRID_TOP - 100);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, 1), 1, "] goes to the second section of column 1");
    assert.equal(sectionJumpIndex(boxes, -1, LINE, -1), 0, "[ stays on the first section");
  });

  it("no cursor, mid column 1: steps from the section under the reading line", () => {
    const boxes = grid(GRID_TOP + (HEIGHT + GAP) + 50 - LINE); // line is 50 px into section 1
    assert.equal(sectionJumpIndex(boxes, -1, LINE, 1), 2);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, -1), 0);
    // Same in the two-column layout.
    const two = grid(GRID_TOP + (HEIGHT + GAP) + 50 - LINE, 2, 8);
    assert.equal(sectionJumpIndex(two, -1, LINE, 1), 2);
  });

  it("above the grid: ] goes to the first section, [ does nothing (it used to jump to the LAST one)", () => {
    const boxes = grid(0);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, 1), 0);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, -1), -1);
  });

  it("below the grid: [ goes to the last section, ] does nothing", () => {
    const boxes = grid(10_000);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, -1), 14);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, 1), -1);
  });

  it("in the gap between two sections of a one-column page", () => {
    const boxes = grid(GRID_TOP + HEIGHT + GAP / 2 - LINE, 1, 5); // line is between sections 0 and 1
    assert.equal(sectionJumpIndex(boxes, -1, LINE, 1), 1);
    assert.equal(sectionJumpIndex(boxes, -1, LINE, -1), 0);
  });

  it("a collapsed section is a stop like any other, in both directions", () => {
    // Section 1 is collapsed (heading only). The hook focuses its heading, so the next press
    // reports it as the current section - the cursor can no longer pin [ / ] to its neighbour.
    const boxes = [{ top: 200, bottom: 600 }, { top: 616, bottom: 646 }, { top: 662, bottom: 1062 }];
    assert.equal(sectionJumpIndex(boxes, 0, LINE, 1), 1);
    assert.equal(sectionJumpIndex(boxes, 1, LINE, 1), 2, "] passes the collapsed section");
    assert.equal(sectionJumpIndex(boxes, 2, LINE, -1), 1);
    assert.equal(sectionJumpIndex(boxes, 1, LINE, -1), 0, "[ passes it too");
  });

  it("no sections, or an index that is out of range", () => {
    assert.equal(sectionJumpIndex([], -1, LINE, 1), -1);
    assert.equal(sectionJumpIndex([], 0, LINE, -1), -1);
    assert.equal(sectionJumpIndex(grid(0), 99, LINE, 1), 0, "a stale index is treated as no current section");
  });
});
