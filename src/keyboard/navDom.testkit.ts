// TEST KIT (not part of the app bundle; imported only by *.test.ts files of this package).
//
// useKeyboardNav walks the page through the DOM: querySelectorAll / closest / getClientRects, DOM
// focus, key and focus events on `document`. The repo's fake DOM (src/features/headline/
// fakeDom.testkit.ts) mounts React but has none of those. This file adds them ON TOP of it, for a
// page a test builds by hand next to the React root:
//
//   const nav = await mountNavDom();                 // mountFakeDom() + the additions + globals
//   const row = nav.el("li", { "data-aid": "a1" }, [nav.el("a", { href: "#", "data-row-link": "" })]);
//   nav.page.appendChild(row);
//   await nav.render(element);                       // a component that calls useKeyboardNav()
//   nav.key("j");                                    // keydown on document, target = the focused node
//   await nav.unmount();                             // restores every global
//
// It is NOT a browser. Layout is what a test says it is: `node.rect` (from the base kit) and
// `node.hidden = true` (display:none - the node and its descendants have no client rects). The
// selector engine knows what the keyboard layer asks for and throws on anything else: tag,
// [attr], [attr=value], [attr^=value], descendant combinators, comma lists.

import type { ReactNode } from "react";
import { FakeNode, mountFakeDom, type FakeDom } from "../features/headline/fakeDom.testkit";

interface Compound {
  tag: string | null;
  attrs: { name: string; op: "" | "=" | "^="; value: string }[];
}

const COMPOUND = /^([a-z][a-z0-9]*)?((?:\[[\w-]+(?:\^?=(?:"[^"]*"|'[^']*'|[^\]]*))?\])*)$/i;
const ATTR = /\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;

function parseCompound(text: string): Compound {
  const m = COMPOUND.exec(text);
  if (!m || text === "") throw new Error(`navDom: unsupported selector "${text}"`);
  const attrs: Compound["attrs"] = [];
  for (const a of m[2].matchAll(ATTR)) attrs.push({ name: a[1], op: (a[2] ?? "") as "" | "=" | "^=", value: a[3] ?? a[4] ?? a[5] ?? "" });
  return { tag: m[1] ? m[1].toUpperCase() : null, attrs };
}

/** "a[href], h2 a" -> [[a[href]], [h2, a]] (descendant chains, right-most compound last). */
function parseSelector(selector: string): Compound[][] {
  return selector.split(",").map((part) => part.trim().split(/\s+/).map(parseCompound));
}

function matchesCompound(node: FakeNode, c: Compound): boolean {
  if (node.nodeType !== 1) return false;
  if (c.tag && node.tagName !== c.tag) return false;
  return c.attrs.every(({ name, op, value }) => {
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    return op === "" ? true : op === "=" ? actual === value : actual.startsWith(value);
  });
}

function matchesChain(node: FakeNode, chain: Compound[]): boolean {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let up = node.parentNode; up && i >= 0; up = up.parentNode) if (matchesCompound(up, chain[i])) i -= 1;
  return i < 0;
}

export interface NavEventInit {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** A real Event (document is a real EventTarget) whose `target` is the node the test names. */
class NavEvent extends Event {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  private readonly node: unknown;

  constructor(type: string, node: unknown, init: NavEventInit = {}) {
    super(type, { bubbles: true, cancelable: true });
    this.node = node;
    this.key = init.key ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.repeat = init.repeat ?? false;
    this.isComposing = init.isComposing ?? false;
  }

  override get target(): EventTarget | null {
    return this.node as EventTarget | null;
  }
}

/** FakeNode + what the keyboard layer reads and does. */
export class NavNode extends FakeNode {
  /** display:none stand-in: this node and everything inside it has no client rects. */
  hidden = false;
  isContentEditable = false;
  /** <input type>. */
  type = "text";
  /** How often click() ran (links, [data-row-action] controls). */
  clicks = 0;
  /** scrollIntoView() calls, in order. */
  scrolls: unknown[] = [];
  /** select() calls (the search input). */
  selections = 0;
  private readonly handlers = new Map<string, Set<(event: Event) => void>>();

  matches(selector: string): boolean {
    return parseSelector(selector).some((chain) => matchesChain(this, chain));
  }

  closest(selector: string): NavNode | null {
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof NavNode && n.matches(selector)) return n;
    return null;
  }

  querySelectorAll(selector: string): NavNode[] {
    const out: NavNode[] = [];
    const visit = (n: FakeNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof NavNode && c.matches(selector)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): NavNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get isConnected(): boolean {
    let top: FakeNode = this;
    while (top.parentNode) top = top.parentNode;
    return top === (this.ownerDocument as { navRoot?: FakeNode }).navRoot;
  }

  getClientRects(): unknown[] {
    if (!this.isConnected) return [];
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof NavNode && n.hidden) return [];
    return [this.rect];
  }

  focus(): void {
    const doc = this.ownerDocument as { activeElement: unknown; dispatchEvent(event: Event): boolean };
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    doc.dispatchEvent(new NavEvent("focusin", this));
  }

  blur(): void {
    const doc = this.ownerDocument as { activeElement: unknown };
    if (doc.activeElement === this) doc.activeElement = null;
  }

  select(): void {
    this.selections += 1;
  }

  scrollIntoView(options?: unknown): void {
    this.scrolls.push(options ?? null);
  }

  override click(): void {
    this.clicks += 1;
  }

  // CustomEvent delivery for the row-action protocol: listeners on the node, then on its ancestors.
  override addEventListener(type: string, listener: (event: never) => void): void {
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    set.add(listener as (event: Event) => void);
  }

  override removeEventListener(type: string, listener: (event: never) => void): void {
    this.handlers.get(type)?.delete(listener as (event: Event) => void);
  }

  /** Bubbles through the hand-built tree; returns false when a listener called preventDefault(). */
  dispatchEvent(event: Event): boolean {
    for (let n: FakeNode | null = this; n; n = n.parentNode) {
      if (n instanceof NavNode) for (const l of [...(n.handlers.get(event.type) ?? [])]) l(event);
    }
    return !event.defaultPrevented;
  }
}

class NavInput extends NavNode {}
class NavTextArea extends NavNode {}
class NavSelect extends NavNode {}

export interface NavDom extends FakeDom {
  /** Root of the hand-built page (what document.querySelectorAll searches). */
  page: NavNode;
  /** Create an element with attributes and children (not attached). */
  el(tag: string, attrs?: Record<string, string>, children?: NavNode[]): NavNode;
  /** keydown on document with the focused node as target (document.body's stand-in: null). Returns the event. */
  key(key: string, init?: Omit<NavEventInit, "key"> & { target?: NavNode | null }): Event;
  /** The node holding DOM focus. */
  active(): NavNode | null;
  /** Set the value of --sticky-h (px) that getComputedStyle reports. */
  setStickyHeight(px: number): void;
}

const NAV_GLOBALS = ["Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "getComputedStyle"] as const;

/** mountFakeDom() plus a queryable, focusable page and the DOM globals useKeyboardNav touches. */
export async function mountNavDom(): Promise<NavDom> {
  const base = await mountFakeDom();
  const g = globalThis as Record<string, unknown>;
  const doc = g.document as Record<string, unknown> & EventTarget;
  const saved = NAV_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  let stickyPx = 0;

  const page = new NavNode(1, "BODY", doc);
  doc.navRoot = page;
  doc.querySelectorAll = (selector: string) => page.querySelectorAll(selector);
  doc.querySelector = (selector: string) => page.querySelector(selector);
  doc.getElementById = (id: string) => page.querySelector(`[id="${id}"]`);

  const globals: Record<(typeof NAV_GLOBALS)[number], unknown> = {
    Element: NavNode,
    HTMLElement: NavNode,
    HTMLInputElement: NavInput,
    HTMLTextAreaElement: NavTextArea,
    HTMLSelectElement: NavSelect,
    getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === "--sticky-h" ? `${stickyPx}px` : "") }),
  };
  for (const key of NAV_GLOBALS) Object.defineProperty(g, key, { value: globals[key], configurable: true, writable: true });

  const el: NavDom["el"] = (tag, attrs = {}, children = []) => {
    const Class = tag === "input" ? NavInput : tag === "textarea" ? NavTextArea : tag === "select" ? NavSelect : NavNode;
    const node = new Class(1, tag.toUpperCase(), doc);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (attrs.type) node.type = attrs.type;
    for (const child of children) node.appendChild(child);
    return node;
  };

  return {
    ...base,
    page,
    el,
    key: (key, init = {}) => {
      const { target, ...rest } = init;
      const event = new NavEvent("keydown", target === undefined ? doc.activeElement : target, { key, ...rest });
      doc.dispatchEvent(event);
      return event;
    },
    active: () => (doc.activeElement as NavNode | null) ?? null,
    setStickyHeight: (px) => {
      stickyPx = px;
    },
    render: (element: ReactNode) => base.render(element),
    unmount: async () => {
      await base.unmount();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(g, key, descriptor);
        else delete g[key];
      }
    },
  };
}
