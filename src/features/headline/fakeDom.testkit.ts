// TEST KIT (not part of the app bundle; imported only by *.test.ts files of this package).
//
// The repo has no jsdom, and the rules forbid new dependencies - but re-render and interaction
// behaviour (memoisation, disclosures, the keyboard-action event) cannot be shown with
// renderToStaticMarkup. This is the smallest DOM that react-dom/client needs to mount, update and
// dispatch a click: a node tree, attributes, and listener bookkeeping. It is NOT a browser: no
// layout (a test may set node.rect), no CSS, no focus, no real event propagation.
//
//   const dom = await mountFakeDom();
//   await dom.render(element);          // inside act()
//   dom.text(); dom.byClass("hl-summary"); await dom.click(node);
//   await dom.fire(node, "auxclick", { button: 1 });   // any other event React delegates
//   await dom.unmount();                // also removes the fake globals

import { act, type ReactNode } from "react";

type Listener = (event: unknown) => void;

export class FakeNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string | undefined;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly ownerDocument: unknown;
  readonly style: Record<string, unknown> = {};
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;
  /** Layout stand-in: there is no layout, so a test sets the box it wants measured. */
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: unknown) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeType === 1 ? nodeName : undefined;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  /** Call every listener registered for the event's type on THIS node (no propagation). */
  fire(event: { type: string }): void {
    for (const l of [...(this.listeners.get(event.type) ?? [])]) l(event);
  }
  /** HTMLElement.click(): a primary-button click delivered to the root's listeners (React's). */
  click(): void {
    this.dispatch("click");
  }
  /** An event of `type` targeted at this node, delivered to the root's listeners (React's). */
  dispatch(type: string, init: Record<string, unknown> = {}): void {
    let root: FakeNode = this;
    while (root.parentNode) root = root.parentNode;
    root.fire({ ...nativeEvent(type, this, root), ...init });
  }
  getBoundingClientRect(): FakeNode["rect"] {
    return this.rect;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    if (this.nodeType === 3) {
      this.nodeValue = value;
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) {
      const text = new FakeNode(3, "#text", this.ownerDocument);
      text.nodeValue = value;
      this.appendChild(text);
    }
  }

  /** Space-separated class list as React wrote it. */
  get classNames(): string[] {
    return (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
}

function nativeEvent(type: string, target: FakeNode, currentTarget: FakeNode): { type: string } {
  const event = {
    type,
    target,
    currentTarget,
    button: 0,
    relatedTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    timeStamp: 0,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
  return event;
}

function fakeDocument(): Record<string, unknown> {
  // `document` IS a real EventTarget, so a CustomEvent dispatched on it reaches real listeners with
  // event.target === document.
  const doc = Object.assign(new EventTarget(), { nodeType: 9, nodeName: "#document", activeElement: null }) as unknown as Record<string, unknown>;
  doc.createElement = (tag: string) => new FakeNode(1, tag.toUpperCase(), doc);
  doc.createElementNS = (_ns: string, tag: string) => new FakeNode(1, tag, doc);
  doc.createTextNode = (text: string) => {
    const n = new FakeNode(3, "#text", doc);
    n.nodeValue = text;
    return n;
  };
  doc.defaultView = { document: doc, HTMLIFrameElement: class {}, innerWidth: 1280, innerHeight: 800, addEventListener: () => undefined, removeEventListener: () => undefined };
  doc.documentElement = new FakeNode(1, "HTML", doc);
  doc.body = new FakeNode(1, "BODY", doc);
  return doc;
}

export interface FakeDom {
  container: FakeNode;
  render(element: ReactNode): Promise<void>;
  /** Run a state change and flush React. */
  run(change: () => void | Promise<void>): Promise<void>;
  text(): string;
  all(match: (node: FakeNode) => boolean): FakeNode[];
  byClass(name: string): FakeNode[];
  /** Dispatch a primary-button click through React's root listeners. */
  click(node: FakeNode): Promise<void>;
  /** Dispatch any other delegated event ("auxclick", "mouseover", ...) the same way. */
  fire(node: FakeNode, type: string, init?: Record<string, unknown>): Promise<void>;
  unmount(): Promise<void>;
}

const GLOBAL_KEYS = ["document", "window", "IS_REACT_ACT_ENVIRONMENT"] as const;

/** Install the fake DOM as globals, create a React root in it. Call unmount() to restore. */
export async function mountFakeDom(): Promise<FakeDom> {
  const g = globalThis as Record<string, unknown>;
  const saved = GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const doc = fakeDocument();
  for (const [key, value] of [["document", doc], ["window", doc.defaultView], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
  // Imported after the globals exist: react-dom reads `window` when it is first evaluated.
  const { createRoot } = await import("react-dom/client");
  const container = new FakeNode(1, "DIV", doc);
  const root = createRoot(container as unknown as Element);

  const all = (match: (node: FakeNode) => boolean): FakeNode[] => {
    const out: FakeNode[] = [];
    const visit = (n: FakeNode): void => {
      if (n !== container && n.nodeType === 1 && match(n)) out.push(n);
      for (const c of n.childNodes) visit(c);
    };
    visit(container);
    return out;
  };

  return {
    container,
    render: (element) => act(async () => root.render(element)),
    run: (change) => act(async () => change()),
    text: () => container.textContent,
    all,
    byClass: (name) => all((n) => n.classNames.includes(name)),
    click: (node) => act(async () => node.click()),
    fire: (node, type, init) => act(async () => node.dispatch(type, init)),
    unmount: async () => {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(g, key, descriptor);
        else delete g[key];
      }
    },
  };
}
