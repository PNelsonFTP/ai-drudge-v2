// mutationsTouchText decides whether the search highlights are repainted after a DOM change. It is
// pure (records in, boolean out), so it is tested with plain objects: the repo has no DOM library.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mutationsTouchText, type MutationLike } from "./browser";

const node = (textContent: string | null) => ({ textContent });
const childList = (added: (string | null)[], removed: (string | null)[] = []): MutationLike => ({ type: "childList", addedNodes: added.map(node), removedNodes: removed.map(node) });

describe("export/kit/browser - mutationsTouchText", () => {
  it("ignores text-free nodes coming and going (the icon-only action buttons a row mounts on hover)", () => {
    assert.equal(mutationsTouchText([childList(["", "", "", ""])]), false, "four icon buttons mounted");
    assert.equal(mutationsTouchText([childList([], ["", ""])]), false, "and unmounted");
    assert.equal(mutationsTouchText([childList(["  \n "], [null])]), false, "whitespace and null text are not text");
    assert.equal(mutationsTouchText([childList([""]), childList([], [""])]), false);
    assert.equal(mutationsTouchText([]), false);
  });

  it("repaints when text is added or removed (summary expanded, 'Link copied', a replaced time label)", () => {
    assert.equal(mutationsTouchText([childList(["Officials said Nvidia would need licences."])]), true);
    assert.equal(mutationsTouchText([childList([], ["5m ago"])]), true);
    assert.equal(mutationsTouchText([childList([""]), childList(["", "Link copied"])]), true, "one text-bearing node among many is enough");
  });

  it("always repaints on character data (React edits a text node in place) and on any other record type", () => {
    assert.equal(mutationsTouchText([{ type: "characterData", addedNodes: [], removedNodes: [] }]), true);
    assert.equal(mutationsTouchText([childList([""]), { type: "characterData", addedNodes: [], removedNodes: [] }]), true);
    assert.equal(mutationsTouchText([{ type: "attributes", addedNodes: [], removedNodes: [] }]), true);
  });

  it("accepts array-likes (NodeList has length and indexes, no array methods)", () => {
    const list = { length: 2, 0: node(""), 1: node("text") } as ArrayLike<{ textContent: string | null }>;
    assert.equal(mutationsTouchText([{ type: "childList", addedNodes: list, removedNodes: { length: 0 } }]), true);
    assert.equal(mutationsTouchText([{ type: "childList", addedNodes: { length: 1, 0: node("") }, removedNodes: { length: 0 } }]), false);
  });
});
