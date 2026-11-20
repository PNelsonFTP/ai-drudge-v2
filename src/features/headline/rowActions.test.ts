import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROW_ACTION_EVENT, createRowActionHub, parseRowAction, type RowAction, type RowHandle } from "./rowActions";

function handle(log: string[], name: string, element: unknown = {}): RowHandle {
  return { element: () => element, run: (action: RowAction) => void log.push(`${name}:${action}`) };
}

describe("headline/rowActions parseRowAction", () => {
  it("accepts canonical names, key letters and spellings", () => {
    assert.deepEqual(parseRowAction({ id: "a1", action: "bookmark" }), { id: "a1", action: "bookmark", element: null });
    const map: Record<string, RowAction> = { b: "bookmark", l: "later", "read-later": "later", readLater: "later", s: "summary", a: "also", coverage: "also", m: "mute", o: "open", Enter: "open", c: "copy", menu: "menu" };
    for (const [given, expected] of Object.entries(map)) assert.equal(parseRowAction({ id: "a1", action: given })?.action, expected, given);
  });

  it("carries the element hint", () => {
    const el = {};
    assert.equal(parseRowAction({ id: "a1", action: "s", el })?.element, el);
    assert.equal(parseRowAction({ id: "a1", action: "s", element: el })?.element, el);
  });

  it("rejects anything else", () => {
    for (const bad of [null, undefined, "bookmark", 3, {}, { id: "a1" }, { action: "b" }, { id: "", action: "b" }, { id: 7, action: "b" }, { id: "a1", action: "explode" }, { id: "a1", action: 1 }]) {
      assert.equal(parseRowAction(bad), null, JSON.stringify(bad));
    }
  });
});

describe("headline/rowActions hub", () => {
  it("routes a document event to the row with that id", () => {
    const target = new EventTarget();
    const hub = createRowActionHub(target);
    const log: string[] = [];
    hub.register("a1", handle(log, "row-a1"));
    hub.register("b2", handle(log, "row-b2"));
    target.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail: { id: "b2", action: "summary" } }));
    target.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail: { id: "a1", action: "l" } }));
    target.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail: { id: "zz", action: "l" } }));
    assert.deepEqual(log, ["row-b2:summary", "row-a1:later"]);
  });

  it("runs exactly one instance when a story is rendered twice", () => {
    const target = new EventTarget();
    const hub = createRowActionHub(target);
    const log: string[] = [];
    hub.register("a1", handle(log, "first"));
    hub.register("a1", handle(log, "second"));
    target.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail: { id: "a1", action: "bookmark" } }));
    assert.deepEqual(log, ["first:bookmark"]);
  });

  it("prefers the instance the sender points at (same element, or one inside it)", () => {
    const hub = createRowActionHub(null);
    const log: string[] = [];
    const inner = {};
    const elA = { contains: (n: unknown) => n === inner };
    const elB = { contains: () => false };
    hub.register("a1", handle(log, "first", elB));
    hub.register("a1", handle(log, "second", elA));
    assert.equal(hub.dispatch({ id: "a1", action: "summary", element: elA }), true);
    assert.equal(hub.dispatch({ id: "a1", action: "also", element: inner }), true);
    assert.equal(hub.dispatch({ id: "a1", action: "menu", element: {} }), true, "unknown element falls back to the first instance");
    assert.deepEqual(log, ["second:summary", "second:also", "first:menu"]);
  });

  it("ignores malformed events and survives a throwing contains()", () => {
    const target = new EventTarget();
    const hub = createRowActionHub(target);
    const log: string[] = [];
    hub.register("a1", handle(log, "row", { contains: () => { throw new Error("boom"); } }));
    target.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail: "nonsense" }));
    target.dispatchEvent(new Event(ROW_ACTION_EVENT));
    assert.deepEqual(log, []);
    assert.equal(hub.dispatch({ id: "a1", action: "copy", element: {} }), true);
    assert.deepEqual(log, ["row:copy"]);
  });

  it("leaves events dispatched ON a row to the shell's keyboard contract; cancels the ones it handles", () => {
    let listener: ((event: Event) => void) | undefined;
    const target = { addEventListener: (_type: string, l: (event: Event) => void) => void (listener = l), removeEventListener: () => undefined };
    const hub = createRowActionHub(target);
    const log: string[] = [];
    const rowElement = {};
    const snapshotElement = {};
    hub.register("a1", handle(log, "row", rowElement));
    // A row the shell's default cannot serve (not an edition article) claims save / mute.
    hub.register("s9", { ...handle(log, "snapshot", snapshotElement), claims: (action) => action === "bookmark" || action === "mute" });
    assert.ok(listener);
    const fake = (eventTarget: unknown, detail: unknown) => {
      const event = { target: eventTarget, detail, prevented: false, preventDefault: () => void (event.prevented = true) };
      listener?.(event as unknown as Event);
      return event.prevented;
    };
    // Bubbled up from the row element: the shell will click the row's data-row-action control
    // (or run its default) - handling it here too would toggle twice.
    assert.equal(fake(rowElement, { id: "a1", action: "bookmark" }), false);
    assert.deepEqual(log, []);
    assert.equal(fake(snapshotElement, { id: "s9", action: "bookmark" }), true, "claimed: handled and cancelled");
    assert.equal(fake(snapshotElement, { id: "s9", action: "summary" }), false, "not claimed: left to the shell");
    assert.deepEqual(log.splice(0), ["snapshot:bookmark"]);
    // Addressed by id on the document: handled here, and cancelled so nobody repeats it.
    assert.equal(fake(target, { id: "a1", action: "bookmark" }), true);
    assert.deepEqual(log, ["row:bookmark"]);
    assert.equal(fake(target, { id: "zz", action: "bookmark" }), false, "no such row: not cancelled");
    assert.equal(fake(target, { id: "a1", action: "nope" }), false);
    assert.deepEqual(log, ["row:bookmark"]);
  });

  it("listens only while rows are registered and unregisters cleanly", () => {
    const added: string[] = [];
    const target = {
      addEventListener: (type: string) => void added.push(`+${type}`),
      removeEventListener: (type: string) => void added.push(`-${type}`),
    };
    const hub = createRowActionHub(target);
    assert.equal(hub.size(), 0);
    const off1 = hub.register("a1", handle([], "x"));
    const off2 = hub.register("b2", handle([], "y"));
    assert.deepEqual(added, [`+${ROW_ACTION_EVENT}`], "one listener for the whole page");
    off1();
    off1();
    assert.equal(hub.size(), 1, "unregistering twice counts once");
    assert.equal(hub.dispatch({ id: "a1", action: "open", element: null }), false);
    off2();
    assert.deepEqual(added, [`+${ROW_ACTION_EVENT}`, `-${ROW_ACTION_EVENT}`]);
  });
});
