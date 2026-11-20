// The three-step delivery of a keyboard row action (ROW CONTRACT in useKeyboardNav.ts). The
// receiving side lives in another package (src/features/headline), so the protocol is pinned here:
// exactly ONE of {row listener, marked control, shell default} may act.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeServices } from "../../test/helpers/fakeServices";
import { fixtureFront } from "../../test/helpers/fixtureData";
import { ROW_ACTIONS, type RowAction } from "./keymap";
import { ROW_ACTION_ATTR, ROW_ACTION_EVENT, ROW_ID_ATTR, ROW_LINK_ATTR, deliverRowAction, primaryLink, type RowActionDetail, type RowElement } from "./rowActions";

const ARTICLE_ID = fixtureFront.top[0];
const ARTICLE = fixtureFront.articles[ARTICLE_ID];
const SOURCE_NAME = fixtureFront.sources[ARTICLE.src].name;

/** A row element stand-in: a real EventTarget plus the two lookups the delivery uses. */
class FakeRow extends EventTarget implements RowElement {
  clicks: string[] = [];
  constructor(
    private readonly id: string | null,
    private readonly selectors: readonly string[] = [],
  ) {
    super();
  }
  getAttribute(name: string): string | null {
    return name === ROW_ID_ATTR ? this.id : null;
  }
  querySelector(selector: string): { click(): void } | null {
    return this.selectors.includes(selector) ? { click: () => void this.clicks.push(selector) } : null;
  }
}

const control = (action: RowAction): string => `[${ROW_ACTION_ATTR}="${action}"]`;
const TITLE_LINK = `a[${ROW_LINK_ATTR}]`;
const storeCalls = (calls: string[]): string[] => calls.filter((c) => /^(saved|mutes)\./.test(c));

describe("deliverRowAction: the event", () => {
  it("dispatches a cancelable, bubbling aid:row-action on the row with { id, action, el }", () => {
    const row = new FakeRow(ARTICLE_ID);
    const seen: CustomEvent<RowActionDetail>[] = [];
    row.addEventListener(ROW_ACTION_EVENT, (e) => seen.push(e as CustomEvent<RowActionDetail>));
    deliverRowAction(row, "summary", createFakeServices());
    assert.equal(seen.length, 1);
    assert.equal(ROW_ACTION_EVENT, "aid:row-action");
    assert.equal(seen[0].type, "aid:row-action");
    assert.equal(seen[0].bubbles, true);
    assert.equal(seen[0].cancelable, true);
    assert.deepEqual(Object.keys(seen[0].detail).sort(), ["action", "el", "id"]);
    assert.equal(seen[0].detail.id, ARTICLE_ID);
    assert.equal(seen[0].detail.action, "summary");
    assert.equal(seen[0].detail.el, row);
  });

  it("sends every action of the key map under its own name", () => {
    const row = new FakeRow(ARTICLE_ID);
    const actions: string[] = [];
    row.addEventListener(ROW_ACTION_EVENT, (e) => {
      actions.push((e as CustomEvent<RowActionDetail>).detail.action);
      e.preventDefault();
    });
    const services = createFakeServices();
    for (const action of ROW_ACTIONS) deliverRowAction(row, action, services);
    assert.deepEqual(actions, ["open", "bookmark", "later", "summary", "also", "mute"]);
    assert.deepEqual(storeCalls(services.calls), []);
  });

  it("does nothing for an element without data-aid", () => {
    const row = new FakeRow(null, [TITLE_LINK]);
    let events = 0;
    row.addEventListener(ROW_ACTION_EVENT, () => events++);
    assert.deepEqual(deliverRowAction(row, "open", createFakeServices()), { by: "none" });
    assert.equal(events, 0);
    assert.deepEqual(row.clicks, []);
  });
});

describe("deliverRowAction: exactly one of row / control / default acts", () => {
  it("(a) a row that calls preventDefault() handled it: no click, no store call", () => {
    for (const action of ROW_ACTIONS) {
      const row = new FakeRow(ARTICLE_ID, [control(action), TITLE_LINK, "a[href]"]);
      row.addEventListener(ROW_ACTION_EVENT, (e) => e.preventDefault());
      const services = createFakeServices();
      assert.deepEqual(deliverRowAction(row, action, services), { by: "row" }, action);
      assert.deepEqual(row.clicks, [], action);
      assert.deepEqual(storeCalls(services.calls), [], action);
    }
  });

  it("(b) otherwise the row's [data-row-action] control is clicked - once - and the default is skipped", () => {
    for (const action of ROW_ACTIONS) {
      const row = new FakeRow(ARTICLE_ID, [control(action), TITLE_LINK]);
      // A listener that only observes (no preventDefault) must not count as handling.
      row.addEventListener(ROW_ACTION_EVENT, () => undefined);
      const services = createFakeServices();
      assert.deepEqual(deliverRowAction(row, action, services), { by: "control" }, action);
      assert.deepEqual(row.clicks, [control(action)], action);
      assert.deepEqual(storeCalls(services.calls), [], action);
    }
  });

  it("(c) bookmark: the shell toggles the store for an edition article and announces it", () => {
    const services = createFakeServices();
    const row = new FakeRow(ARTICLE_ID);
    assert.deepEqual(deliverRowAction(row, "bookmark", services), { by: "default", message: `Bookmarked: ${ARTICLE.title}` });
    assert.ok(services.saved.get().bookmarks.has(ARTICLE_ID));
    assert.equal(services.saved.get().snapshots[ARTICLE_ID].sourceName, SOURCE_NAME);
    assert.deepEqual(deliverRowAction(row, "bookmark", services), { by: "default", message: `Bookmark removed: ${ARTICLE.title}` });
    assert.ok(!services.saved.get().bookmarks.has(ARTICLE_ID));
    assert.deepEqual(storeCalls(services.calls), [`saved.toggleBookmark ${ARTICLE_ID}`, `saved.toggleBookmark ${ARTICLE_ID}`]);
  });

  it("(c) later and mute", () => {
    const services = createFakeServices();
    const row = new FakeRow(ARTICLE_ID);
    assert.deepEqual(deliverRowAction(row, "later", services), { by: "default", message: `Saved for later: ${ARTICLE.title}` });
    assert.ok(services.saved.get().later.has(ARTICLE_ID));
    assert.deepEqual(deliverRowAction(row, "later", services), { by: "default", message: `Removed from read later: ${ARTICLE.title}` });
    assert.deepEqual(deliverRowAction(row, "mute", services), { by: "default", message: `Muted source: ${SOURCE_NAME}. Press u to undo.` });
    assert.ok(services.mutes.get().sources.has(ARTICLE.src));
    assert.deepEqual(deliverRowAction(row, "mute", services), { by: "default", message: `Showing ${SOURCE_NAME} again` });
    assert.ok(!services.mutes.get().sources.has(ARTICLE.src));
  });

  it("(c) open clicks the primary link: a[data-row-link] first, else the first a[href]", () => {
    const marked = new FakeRow(ARTICLE_ID, [TITLE_LINK, "a[href]"]);
    assert.deepEqual(deliverRowAction(marked, "open", createFakeServices()), { by: "default", message: null });
    assert.deepEqual(marked.clicks, [TITLE_LINK]);
    const plain = new FakeRow(ARTICLE_ID, ["a[href]"]);
    deliverRowAction(plain, "open", createFakeServices());
    assert.deepEqual(plain.clicks, ["a[href]"]);
    assert.deepEqual(deliverRowAction(new FakeRow(ARTICLE_ID), "open", createFakeServices()), { by: "none" });
    assert.equal(primaryLink(new FakeRow("x")), null);
  });

  it("(c) summary and also have no shell default (row-internal state)", () => {
    const services = createFakeServices();
    const row = new FakeRow(ARTICLE_ID, [TITLE_LINK]);
    assert.deepEqual(deliverRowAction(row, "summary", services), { by: "none" });
    assert.deepEqual(deliverRowAction(row, "also", services), { by: "none" });
    assert.deepEqual(row.clicks, []);
    assert.deepEqual(storeCalls(services.calls), []);
  });

  it("(c) an article that is not in the edition is left to the row (river rows, saved snapshots)", () => {
    const services = createFakeServices();
    const row = new FakeRow("not-in-edition");
    for (const action of ["bookmark", "later", "mute"] as const) assert.deepEqual(deliverRowAction(row, action, services), { by: "none" }, action);
    assert.deepEqual(storeCalls(services.calls), []);
    // ...and while nothing is loaded at all.
    assert.deepEqual(deliverRowAction(new FakeRow(ARTICLE_ID), "bookmark", createFakeServices({ loaded: "loading" })), { by: "none" });
  });
});
