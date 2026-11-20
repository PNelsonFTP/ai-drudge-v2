// A small forgiving HTML tree builder for the scraper. Not a spec parser: it exists so the card
// extractor can ask "which element encloses this link, and what else is inside it?" instead of
// matching one regular expression per site (V1's `<a href="..."` regexes died the day a class
// attribute moved in front of href).
//
// Handles: attribute order / quoting, void and self-closed elements, raw-text elements (script,
// style - skipped), comments, unclosed <li> / <p> / <tr> / <td>, stray end tags. Pure, never throws.

export interface El {
  tag: string;
  /** Attribute names lower-cased; values raw (entities NOT decoded). */
  attrs: Record<string, string>;
  parent: El | null;
  children: (El | string)[];
  /** Offsets of the element in the source (end is exclusive, after the end tag). */
  start: number;
  end: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "noscript", "template"]);
// Opening one of these closes an open element of the listed tags (implied end tags).
const IMPLIED_END: Record<string, string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
};
// ... but never across these boundaries (a nested list starts a new scope).
const SCOPE: Record<string, string[]> = {
  li: ["ul", "ol", "menu"],
  dt: ["dl"],
  dd: ["dl"],
  tr: ["table", "tbody", "thead", "tfoot"],
  td: ["tr", "table"],
  th: ["tr", "table"],
  option: ["select", "datalist"],
};
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);

// ------------------------------------------------------------------------------------------------
// Tokenizer
// ------------------------------------------------------------------------------------------------
//
// Token grammar (what the tree builder sees; everything between tokens is text):
//
//   <!-- ... -->   <![CDATA[ ... ]]>   <!x ... >   </name ... >   <name (?:"..."|'...'|[^'">])* >
//
// This used to be ONE regular expression. It was correct but quadratic on hostile pages: every "<a "
// without a closing ">" (or "<!--" without "-->") made the engine scan to the end of the body before
// giving up, so 96 KB of "<a " took 2 s and a body at the 5 MB cap would have blocked the event loop
// - and every timeout of the run with it - for over an hour. The scanner below accepts exactly the
// same tokens in linear time: a search that reached the end of the input is never repeated.

/** One markup token. `open` / `close` are set for element tags (name as written), neither for comments, CDATA and declarations. */
export interface HtmlToken {
  /** Offset of "<". */
  index: number;
  /** Offset just after the closing ">". */
  end: number;
  close?: string;
  open?: string;
  /** Raw attribute source of an open tag (everything between the name and ">"). */
  attrs?: string;
}

const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// [\w:-]
const isNameChar = (c: number): boolean => isAlpha(c) || (c >= 48 && c <= 58) || c === 95 || c === 45;

class TagScanner {
  private noGt = false;
  private noCommentEnd = false;
  private noCdataEnd = false;
  /**
   * failed[p] bit s = "scanning attributes at offset p in quote state s (0 outside, 1 in "...", 2 in
   * '...') runs into the end of the input". Allocated on the first unterminated tag only.
   */
  private failed: Uint8Array | null = null;

  constructor(private readonly html: string) {}

  /** Offset of the first ">" at or after `from`, or -1 (remembered: there is none further on either). */
  private gt(from: number): number {
    if (this.noGt) return -1;
    const e = this.html.indexOf(">", from);
    if (e < 0) this.noGt = true;
    return e;
  }

  private nameEnd(from: number): number {
    let p = from;
    while (p < this.html.length && isNameChar(this.html.charCodeAt(p))) p++;
    return p;
  }

  private step(state: number, ch: number): number {
    if (state === 0) return ch === 34 ? 1 : ch === 39 ? 2 : 0;
    return (state === 1 && ch === 34) || (state === 2 && ch === 39) ? 0 : state;
  }

  /** Offset of the ">" that ends the open tag whose attributes start at `start`, or -1 when the tag never ends. */
  private tagEnd(start: number): number {
    const { html, failed } = this;
    const n = html.length;
    let p = start;
    let state = 0;
    while (p < n) {
      if (failed !== null && (failed[p] & (1 << state)) !== 0) break;
      const ch = html.charCodeAt(p);
      if (state === 0 && ch === 62) return p;
      state = this.step(state, ch);
      p++;
    }
    // Unterminated: every (offset, state) on this path is a dead end for any later tag that reaches it.
    const marks = (this.failed ??= new Uint8Array(n));
    state = 0;
    for (let q = start; q < p; q++) {
      marks[q] |= 1 << state;
      state = this.step(state, html.charCodeAt(q));
    }
    return -1;
  }

  /** The first token starting at or after `from`, or null. */
  next(from: number): HtmlToken | null {
    const { html } = this;
    for (let i = html.indexOf("<", from); i >= 0 && !this.noGt; i = html.indexOf("<", i + 1)) {
      const c = html.charCodeAt(i + 1);
      if (c === 33 /* ! */) {
        if (html.startsWith("<!--", i)) {
          if (this.noCommentEnd) continue;
          const e = html.indexOf("-->", i + 4);
          if (e >= 0) return { index: i, end: e + 3 };
          this.noCommentEnd = true;
        } else if (html.startsWith("<![CDATA[", i)) {
          if (this.noCdataEnd) continue;
          const e = html.indexOf("]]>", i + 9);
          if (e >= 0) return { index: i, end: e + 3 };
          this.noCdataEnd = true;
        } else if (isAlpha(html.charCodeAt(i + 2))) {
          const e = this.gt(i + 3);
          if (e >= 0) return { index: i, end: e + 1 };
        }
      } else if (c === 47 /* / */) {
        if (!isAlpha(html.charCodeAt(i + 2))) continue;
        const nameEnd = this.nameEnd(i + 3);
        const e = this.gt(nameEnd);
        if (e >= 0) return { index: i, end: e + 1, close: html.slice(i + 2, nameEnd) };
      } else if (isAlpha(c)) {
        const nameEnd = this.nameEnd(i + 2);
        const e = this.tagEnd(nameEnd);
        if (e >= 0) return { index: i, end: e + 1, open: html.slice(i + 1, nameEnd), attrs: html.slice(nameEnd, e) };
      }
    }
    return null;
  }
}

/** Every markup token of `html` in order (no raw-text skipping). Exported for the tokenizer tests. */
export function tokenizeHtml(html: string): HtmlToken[] {
  const scanner = new TagScanner(html);
  const out: HtmlToken[] = [];
  for (let t = scanner.next(0); t !== null; t = scanner.next(t.end)) out.push(t);
  return out;
}

/**
 * Deepest element nesting the tree keeps. Real pages stay under ~100; without a bound, 80,000 unclosed
 * "<a>" followed by as many stray end tags (each one searching the whole open-element stack) took
 * 16 s, and the recursive walkers overflowed the call stack. An element opened below this depth is
 * kept as a leaf and its content attaches to the deepest element that was opened.
 */
export const MAX_DEPTH = 256;

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of src.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Parse HTML into a tree. The returned root is a synthetic "#root" element. */
export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, parent: null, children: [], start: 0, end: html.length };
  const stack: El[] = [root];
  const top = (): El => stack[stack.length - 1];
  const closeTo = (index: number, at: number): void => {
    while (stack.length > index) {
      const el = stack.pop();
      if (el) el.end = at;
    }
  };
  let last = 0;
  const scanner = new TagScanner(html);
  for (let m = scanner.next(0); m !== null; m = scanner.next(last)) {
    if (m.index > last) top().children.push(html.slice(last, m.index));
    last = m.end;
    const closeTag = m.close?.toLowerCase();
    const openTag = m.open?.toLowerCase();
    if (closeTag) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === closeTag) {
          closeTo(i, last);
          break;
        }
      }
      continue;
    }
    if (!openTag) continue; // comment / doctype / CDATA

    const implied = IMPLIED_END[openTag];
    if (implied) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (SCOPE[openTag].includes(stack[i].tag)) break;
        if (implied.includes(stack[i].tag)) {
          closeTo(i, m.index);
          break;
        }
      }
    }
    if (CLOSES_P.has(openTag) && top().tag === "p") closeTo(stack.length - 1, m.index);

    const attrSrc = m.attrs ?? "";
    const el: El = { tag: openTag, attrs: parseAttrs(attrSrc), parent: top(), children: [], start: m.index, end: last };
    top().children.push(el);
    if (VOID.has(openTag) || attrSrc.trimEnd().endsWith("/")) continue;
    if (RAW_TEXT.has(openTag)) {
      // Raw text: skip to the matching end tag without tokenising the content.
      const close = new RegExp(`</${openTag}\\s*>`, "gi");
      close.lastIndex = last;
      const end = close.exec(html);
      last = end ? close.lastIndex : html.length;
      el.end = last;
      continue;
    }
    if (stack.length > MAX_DEPTH) continue;
    stack.push(el);
  }
  if (last < html.length) top().children.push(html.slice(last));
  closeTo(1, html.length);
  return root;
}

/** Depth-first walk (document order). Return false from `visit` to skip an element's subtree. */
export function walk(el: El, visit: (el: El) => boolean | void): void {
  for (const child of el.children) {
    if (typeof child === "string") continue;
    if (visit(child) === false) continue;
    walk(child, visit);
  }
}

export function findAll(el: El, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  walk(el, (e) => {
    if (pred(e)) out.push(e);
  });
  return out;
}

export function findFirst(el: El, pred: (el: El) => boolean): El | null {
  let found: El | null = null;
  walk(el, (e) => {
    if (found) return false;
    if (pred(e)) {
      found = e;
      return false;
    }
    return undefined;
  });
  return found;
}

// Inline elements do not separate words; every other element boundary is a word break.
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "em", "i", "kbd", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);

/**
 * Visible text of an element (raw: entities are NOT decoded), whitespace collapsed.
 * `spaced` puts a break at EVERY element boundary - right for finding a date next to a title
 * ("<a>Title</a><em>Dec 3, 2025</em>"), wrong for titles ("Claude<sup>2</sup>").
 */
export function textOf(el: El, skip?: (el: El) => boolean, spaced = false): string {
  const parts: string[] = [];
  const visit = (node: El): void => {
    for (const child of node.children) {
      if (typeof child === "string") {
        parts.push(child);
        continue;
      }
      if (RAW_TEXT.has(child.tag) || child.tag === "svg" || skip?.(child)) continue;
      const sep = !spaced && INLINE.has(child.tag) ? "" : " ";
      parts.push(sep);
      visit(child);
      parts.push(sep);
    }
  };
  visit(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function ancestors(el: El): El[] {
  const out: El[] = [];
  for (let p = el.parent; p; p = p.parent) out.push(p);
  return out;
}
