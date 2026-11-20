// useKeyboardNav against a DOM: the walking the reducer tests (keymap.test.ts) and the delivery
// tests (rowActions.test.ts) cannot show - which row j / k land on, what [ and ] focus, what o and
// s click, and how the cursor follows DOM focus, hidden rows, removed rows and page changes.
//
// The hook is mounted for real (React root of the repo's fake DOM); the page it walks is built by
// hand with navDom.testkit.ts, which supplies selectors, focus, client rects and key events.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createFakeServices, type FakeServices } from "../../test/helpers/fakeServices";
import { ROW_ACTION_EVENT, ServicesContext, type RowActionDetail } from "../app/services";
import { mountNavDom, type NavDom, type NavNode } from "./navDom.testkit";
import { KBD_CURRENT_ATTR, useKeyboardNav, type KeyboardNavOptions } from "./useKeyboardNav";

interface Harness {
  nav: NavDom;
  services: FakeServices;
  /** What the hook announced / asked the shell to do, in order. */
  log: string[];
  rerender(options?: Partial<KeyboardNavOptions>): Promise<void>;
}

let mounted: NavDom | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function Probe({ options }: { options: KeyboardNavOptions }): null {
  useKeyboardNav(options);
  return null;
}

async function mount(options: Partial<KeyboardNavOptions> = {}, build?: (nav: NavDom) => void): Promise<Harness> {
  const nav = await mountNavDom();
  mounted = nav;
  const services = createFakeServices();
  const log: string[] = [];
  const base: KeyboardNavOptions = {
    onHelp: () => void log.push("help"),
    onClose: () => void log.push("close"),
    onUndo: () => void log.push("undo"),
    announce: (message) => void log.push(`say:${message}`),
  };
  build?.(nav);
  const rerender = (next: Partial<KeyboardNavOptions> = {}): Promise<void> =>
    nav.render(createElement(ServicesContext.Provider, { value: services }, createElement(Probe, { options: { ...base, ...options, ...next } })));
  await rerender();
  return { nav, services, log, rerender };
}

/** <li data-aid> with a headline link (optionally marked as the primary link) and a box at `top`. */
function row(nav: NavDom, id: string, top: number, opts: { primary?: boolean; extraLinkFirst?: boolean; controls?: string[] } = {}): NavNode {
  const children: NavNode[] = [];
  if (opts.extraLinkFirst) children.push(nav.el("a", { href: `#source-${id}`, class: "source" }));
  children.push(nav.el("a", { href: `https://example.com/${id}`, class: "headline", ...(opts.primary === false ? {} : { "data-row-link": "" }) }));
  for (const action of opts.controls ?? []) children.push(nav.el("button", { "data-row-action": action }));
  const node = nav.el("li", { "data-aid": id }, children);
  node.rect = { left: 0, top, right: 600, bottom: top + 20, width: 600, height: 20 };
  return node;
}

function section(nav: NavDom, id: string, top: number, rows: NavNode[], bottom = top + 30 + rows.length * 20): NavNode {
  const heading = nav.el("h2", {}, [nav.el("a", { href: `#/s/${id}` })]);
  const node = nav.el("section", { id: `sec-${id}` }, [heading, nav.el("ul", {}, rows)]);
  node.rect = { left: 0, top, right: 600, bottom, width: 600, height: bottom - top };
  return node;
}

const current = (nav: NavDom): string[] => nav.page.querySelectorAll(`[${KBD_CURRENT_ATTR}]`).map((n) => n.getAttribute("data-aid") ?? "?");
const link = (node: NavNode): NavNode => node.querySelector("a[data-row-link]") ?? node.querySelector("a[href]")!;

/** Five rows at y = 100, 120, ... inside one list. */
function flatPage(nav: NavDom, ids = ["a", "b", "c", "d", "e"]): NavNode[] {
  const rows = ids.map((id, i) => row(nav, id, 100 + i * 20));
  nav.page.appendChild(nav.el("ul", {}, rows));
  return rows;
}

describe("useKeyboardNav: j / k walk the rendered rows in DOM order", () => {
  it("first j lands on the first row below the pinned chrome, marks it, focuses its primary link and scrolls it into view", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
      nav.setStickyHeight(110); // rows a (top 100) is under the sticky chrome
    });
    const event = h.nav.key("j");
    assert.equal(event.defaultPrevented, true, "j is ours: the browser must not also act on it");
    assert.deepEqual(current(h.nav), ["b"]);
    assert.equal(h.nav.active(), link(rows[1]));
    assert.equal(h.services.focus.get(), "b");
    assert.deepEqual(rows[1].scrolls, [{ block: "nearest" }]);
    assert.deepEqual(rows[0].scrolls, []);
  });

  it("first k lands on the row just above the reading line; with nothing above it, on the first row", async () => {
    const h = await mount({}, (nav) => {
      flatPage(nav);
      nav.setStickyHeight(130); // first row at or below the line: c (top 140)
    });
    h.nav.key("k");
    assert.deepEqual(current(h.nav), ["b"]);

    await h.nav.unmount();
    const top = await mount({}, (nav) => void flatPage(nav));
    top.nav.key("k");
    assert.deepEqual(current(top.nav), ["a"]);
  });

  it("j and k move one row at a time and stop at the ends (no wrap-around); only one row is ever marked", async () => {
    const h = await mount({}, (nav) => void flatPage(nav, ["a", "b", "c"]));
    const seen: string[] = [];
    for (const key of ["j", "j", "j", "j", "k", "k", "k", "k"]) {
      h.nav.key(key);
      seen.push(current(h.nav).join("+"));
    }
    assert.deepEqual(seen, ["a", "b", "c", "c", "b", "a", "a", "a"]);
    assert.equal(h.services.focus.get(), "a");
  });

  it("rows that are not rendered (display:none, a collapsed parent) are skipped", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
      rows[1].hidden = true;
      const folded = nav.el("div", {}, [row(nav, "x", 300), row(nav, "y", 320)]);
      folded.hidden = true;
      nav.page.appendChild(folded);
    });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      h.nav.key("j");
      seen.push(current(h.nav)[0]);
    }
    assert.deepEqual(seen, ["a", "c", "d", "e", "e", "e"]);
  });

  it("the primary link is a[data-row-link]; without one it is the row's first link", async () => {
    let marked: NavNode | null = null;
    let plain: NavNode | null = null;
    const h = await mount({}, (nav) => {
      marked = row(nav, "a", 100, { extraLinkFirst: true });
      plain = row(nav, "b", 120, { extraLinkFirst: true, primary: false });
      nav.page.appendChild(nav.el("ul", {}, [marked, plain]));
    });
    h.nav.key("j");
    assert.equal(h.nav.active()?.getAttribute("class"), "headline");
    h.nav.key("j");
    assert.equal(h.nav.active()?.getAttribute("class"), "source", "no marked link: the first a[href]");
    assert.ok(marked && plain);
  });

  it("follows DOM focus: after Tab or a click moved focus into another row, j continues from THAT row", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
    });
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["a"]);
    link(rows[3]).focus(); // focusin: the cursor mark moves without a key
    assert.deepEqual(current(h.nav), ["d"]);
    assert.equal(h.services.focus.get(), "d");
    assert.deepEqual(rows[3].scrolls, [], "following focus never scrolls");
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["e"]);
  });

  it("when the cursor row disappears (muted, filtered) j continues from where it was, k from the row before", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
    });
    for (let i = 0; i < 3; i++) h.nav.key("j"); // on c (index 2)
    rows[2].parentNode?.removeChild(rows[2]);
    link(rows[2]).blur();
    h.services.stores.focus.set(null);
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["d"], "d took c's place");

    rows[3].parentNode?.removeChild(rows[3]);
    link(rows[3]).blur();
    h.services.stores.focus.set(null);
    h.nav.key("k");
    assert.deepEqual(current(h.nav), ["b"], "the row before the gap");
  });

  it("a page change forgets the cursor: the mark is removed, FocusStore is cleared and j starts over", async () => {
    const h = await mount({}, (nav) => void flatPage(nav));
    h.nav.key("j");
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["b"]);
    h.nav.active()?.blur();
    h.services.router.go({ name: "watch" });
    assert.deepEqual(current(h.nav), []);
    assert.equal(h.services.focus.get(), null);
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["a"]);
  });

  it("does nothing on a page without rows, in a text field, with a modifier, during composition, or with shortcuts turned off", async () => {
    const empty = await mount();
    empty.nav.key("j");
    empty.nav.key("k");
    empty.nav.key("o");
    assert.equal(empty.services.focus.get(), null, "no rows: nothing to mark, nothing thrown");
    await empty.nav.unmount();

    let field: NavNode | null = null;
    let checkbox: NavNode | null = null;
    const h = await mount({}, (nav) => {
      flatPage(nav);
      field = nav.el("input", { id: "site-search", type: "search" });
      checkbox = nav.el("input", { type: "checkbox" });
      nav.page.appendChild(field);
      nav.page.appendChild(checkbox);
    });
    assert.equal(h.nav.key("j", { target: field }).defaultPrevented, false);
    assert.equal(h.nav.key("j", { ctrlKey: true }).defaultPrevented, false);
    assert.equal(h.nav.key("j", { metaKey: true }).defaultPrevented, false);
    assert.equal(h.nav.key("j", { isComposing: true }).defaultPrevented, false);
    assert.deepEqual(current(h.nav), []);
    // A checkbox takes no text: single keys stay live on it.
    h.nav.key("j", { target: checkbox });
    assert.deepEqual(current(h.nav), ["a"]);

    await h.rerender({ characterKeys: false });
    assert.equal(h.nav.key("j").defaultPrevented, false);
    assert.deepEqual(current(h.nav), ["a"], "off switch: the cursor stays where it was");
    h.nav.key("Escape");
    assert.deepEqual(h.log, ["close"], "Escape still acts with shortcuts off");
  });

  it("enabled: false removes the listeners altogether, and unmounting cleans the mark up", async () => {
    const h = await mount({ enabled: false }, (nav) => void flatPage(nav));
    h.nav.key("j");
    h.nav.key("Escape");
    assert.deepEqual(current(h.nav), []);
    assert.deepEqual(h.log, []);
    await h.rerender({ enabled: true });
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["a"]);
    await h.rerender({ enabled: false });
    assert.deepEqual(current(h.nav), [], "the effect's cleanup removes data-kbd-current");
  });
});

describe("useKeyboardNav: [ and ] jump between sections", () => {
  function sectionsPage(nav: NavDom): { sections: NavNode[]; rows: Record<string, NavNode> } {
    const rows: Record<string, NavNode> = {};
    for (const [id, top] of [["m1", 130], ["m2", 150], ["s1", 330], ["s2", 350], ["p1", 730]] as const) rows[id] = row(nav, id, top);
    const collapsed = row(nav, "c1", 530);
    const fold = nav.el("div", {}, [collapsed]);
    fold.hidden = true; // collapsed section: heading only
    const sections = [
      section(nav, "models", 100, [rows.m1, rows.m2], 300),
      section(nav, "ai_security", 300, [rows.s1, rows.s2], 500),
      section(nav, "tools", 500, [], 700),
      section(nav, "policy", 700, [rows.p1], 900),
    ];
    sections[2].appendChild(fold);
    for (const s of sections) nav.page.appendChild(s);
    return { sections, rows };
  }

  it("] from a row goes to the first row of the next section and scrolls the section to the top; [ goes back", async () => {
    let page: ReturnType<typeof sectionsPage> | null = null;
    const h = await mount({}, (nav) => {
      page = sectionsPage(nav);
    });
    const { sections, rows } = page!;
    h.nav.key("j");
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["m2"]);
    assert.equal(h.nav.key("]").defaultPrevented, true);
    assert.deepEqual(current(h.nav), ["s1"]);
    assert.equal(h.nav.active(), link(rows.s1));
    assert.deepEqual(sections[1].scrolls, [{ block: "start" }]);
    assert.deepEqual(rows.s1.scrolls, [], "the section was scrolled, not the row");
    h.nav.key("[");
    assert.deepEqual(current(h.nav), ["m1"], "first row of the previous section, not the row we left");
    h.nav.key("[");
    assert.deepEqual(current(h.nav), ["m1"], "no wrap-around at the first section");
    // j continues from the row the jump landed on.
    h.nav.key("]");
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["s2"]);
  });

  it("a section without rendered rows is still a stop: its heading link gets focus, and the next ] continues from it", async () => {
    let page: ReturnType<typeof sectionsPage> | null = null;
    const h = await mount({}, (nav) => {
      page = sectionsPage(nav);
    });
    const { sections, rows } = page!;
    link(rows.s2).focus();
    h.nav.key("]");
    assert.equal(h.nav.active(), sections[2].querySelector("h2 a[href]"), "the collapsed section's heading");
    assert.deepEqual(current(h.nav), ["s2"], "the row mark stays on the last row: there is no row here");
    h.nav.key("]");
    assert.deepEqual(current(h.nav), ["p1"], "continued from the heading, not from the stale cursor");
    h.nav.key("]");
    assert.deepEqual(current(h.nav), ["p1"], "last section: stays");
    h.nav.key("[");
    assert.equal(h.nav.active(), sections[2].querySelector("h2 a[href]"));
  });

  it("without a cursor it judges from the reading line under the pinned chrome", async () => {
    let page: ReturnType<typeof sectionsPage> | null = null;
    const h = await mount({}, (nav) => {
      page = sectionsPage(nav);
      nav.setStickyHeight(290); // line = 314: inside ai_security (300..500)
    });
    h.nav.key("]");
    assert.equal(h.nav.active(), page!.sections[2].querySelector("h2 a[href]"), "next after the section under the line");

    await h.nav.unmount();
    const above = await mount({}, (nav) => {
      page = sectionsPage(nav);
      nav.setStickyHeight(0); // line = 24: above every section
    });
    assert.equal(above.nav.key("[").defaultPrevented, true);
    assert.deepEqual(current(above.nav), [], "[ at the top of the page moves nothing");
    above.nav.key("]");
    assert.deepEqual(current(above.nav), ["m1"], "] goes to the first section below the line");
  });

  it("with DOM focus lost (a click on blank page) the section of the marked row still counts as current", async () => {
    let page: ReturnType<typeof sectionsPage> | null = null;
    const h = await mount({}, (nav) => {
      page = sectionsPage(nav);
    });
    h.nav.key("j");
    assert.deepEqual(current(h.nav), ["m1"]);
    h.nav.active()?.blur();
    h.nav.key("]");
    assert.deepEqual(current(h.nav), ["s1"], "next after the cursor's section - not the first section below the reading line (models again)");
    assert.ok(page);
  });

  it("a page without sections ignores [ and ] without throwing", async () => {
    const h = await mount({}, (nav) => void flatPage(nav));
    h.nav.key("]");
    h.nav.key("[");
    assert.deepEqual(current(h.nav), []);
  });
});

describe("useKeyboardNav: o and s act on the cursor row", () => {
  it("o clicks the row's primary link when the row neither claims the action nor has an open control", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
    });
    assert.equal(h.nav.key("o").defaultPrevented, true);
    assert.equal(link(rows[0]).clicks, 0, "no cursor row yet: o does nothing");
    h.nav.key("j");
    h.nav.key("j");
    h.nav.key("o");
    assert.deepEqual(rows.map((r) => link(r).clicks), [0, 1, 0, 0, 0]);
  });

  it("the row is told first (cancelable event with id, action and the row element); a row that handles it stops the default", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
    });
    const details: RowActionDetail<unknown>[] = [];
    rows[0].addEventListener(ROW_ACTION_EVENT, (event: CustomEvent<RowActionDetail<unknown>>) => {
      details.push(event.detail);
      event.preventDefault();
    });
    h.nav.key("j");
    h.nav.key("o");
    h.nav.key("s");
    assert.deepEqual(details.map((d) => [d.id, d.action, d.el === rows[0]]), [["a", "open", true], ["a", "summary", true]]);
    assert.equal(link(rows[0]).clicks, 0, "claimed by the row: the link is not clicked as well");
  });

  it("s clicks the row's [data-row-action=summary] control; a row without one has no summary default", async () => {
    let withControl: NavNode | null = null;
    let without: NavNode | null = null;
    const h = await mount({}, (nav) => {
      withControl = row(nav, "a", 100, { controls: ["summary", "also"] });
      without = row(nav, "b", 120);
      nav.page.appendChild(nav.el("ul", {}, [withControl, without]));
    });
    h.nav.key("j");
    h.nav.key("s");
    h.nav.key("s");
    assert.equal(withControl!.querySelector('[data-row-action="summary"]')?.clicks, 2, "each press toggles once");
    assert.equal(withControl!.querySelector('[data-row-action="also"]')?.clicks, 0);
    assert.equal(link(withControl!).clicks, 0);
    h.nav.key("j");
    h.nav.key("s");
    assert.equal(link(without!).clicks, 0, "nothing to click, nothing opened");
    assert.deepEqual(h.log, [], "and nothing announced");
  });

  it("acts on the row holding DOM focus even when the mark is elsewhere, and moves the mark there", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
      for (const r of rows) r.appendChild(nav.el("button", { "data-row-action": "summary" }));
    });
    h.nav.key("j");
    const button = rows[2].querySelector('[data-row-action="summary"]')!;
    // Focus a control of row c directly, bypassing focusin (as if the mark had not caught up).
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = button;
    h.nav.key("s");
    assert.equal(button.clicks, 1);
    assert.deepEqual(current(h.nav), ["c"]);
    assert.equal(link(rows[2]).scrolls.length + rows[2].scrolls.length, 0, "a row action never scrolls");
  });

  it("Enter opens the cursor row, except on a link or button, whose own Enter the browser handles", async () => {
    let rows: NavNode[] = [];
    const h = await mount({}, (nav) => {
      rows = flatPage(nav);
    });
    h.nav.key("j"); // focus is on row a's link
    assert.equal(h.nav.key("Enter").defaultPrevented, false, "on the link: left to the browser");
    assert.equal(link(rows[0]).clicks, 0);
    h.nav.active()?.blur();
    assert.equal(h.nav.key("Enter").defaultPrevented, true);
    assert.equal(link(rows[0]).clicks, 1);
  });

  it("the shell default for b on an edition article goes through the store and is announced", async () => {
    const services = createFakeServices();
    const id = services.edition.get().edition!.top[0];
    const title = services.edition.get().edition!.articles[id].title;
    const h = await mount({}, (nav) => {
      nav.page.appendChild(nav.el("ul", {}, [row(nav, id, 100)]));
    });
    h.nav.key("j");
    h.nav.key("b");
    assert.ok(h.services.saved.get().bookmarks.has(id));
    assert.deepEqual(h.log, [`say:Bookmarked: ${title}`]);
    // A held key does not flip it back 30 times a second.
    h.nav.key("b", { repeat: true });
    assert.ok(h.services.saved.get().bookmarks.has(id));
  });
});

describe("useKeyboardNav: search, help, undo, close", () => {
  it("/ focuses and selects the search box; Escape in it only leaves the field", async () => {
    let field: NavNode | null = null;
    const h = await mount({}, (nav) => {
      flatPage(nav);
      field = nav.el("input", { id: "site-search", type: "search" });
      nav.page.appendChild(field);
    });
    assert.equal(h.nav.key("/").defaultPrevented, true, "the slash must not be typed into the field");
    assert.equal(h.nav.active(), field);
    assert.equal(field!.selections, 1);
    h.nav.key("Escape");
    assert.equal(h.nav.active(), null, "blurred");
    assert.deepEqual(h.log, [], "leaving a field is not 'close everything'");
    h.nav.key("Escape");
    assert.deepEqual(h.log, ["close"]);
    assert.ok(h.services.calls.includes("hover.hide") || h.services.hover.get() === null);
  });

  it("? toggles the help, u asks for an undo, g then n navigates", async () => {
    const h = await mount({}, (nav) => void flatPage(nav));
    h.nav.key("?", { shiftKey: true });
    h.nav.key("u");
    assert.deepEqual(h.log, ["help", "undo"]);
    h.nav.key("g");
    h.nav.key("n");
    assert.deepEqual(h.services.router.get(), { name: "new" });
  });

  it("while a modal dialog is open only ? and Escape act", async () => {
    const h = await mount({}, (nav) => {
      flatPage(nav);
      nav.page.appendChild(nav.el("dialog", { open: "" }));
    });
    h.nav.key("j");
    assert.deepEqual(current(h.nav), []);
    h.nav.key("?", { shiftKey: true });
    assert.deepEqual(h.log, ["help"]);
  });
});
