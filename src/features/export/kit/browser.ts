// The few browser side effects the secondary pages need (clipboard, file download, file read,
// CSS highlights). Every function is a no-op / false outside a browser so components stay
// renderable under node (SSR smoke tests).

import type { TextRange } from "./rows";

/** Copy text to the clipboard. Falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or insecure context: try the legacy path below.
    }
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Offer `text` as a file download. Returns false outside a browser. */
export function downloadText(filename: string, text: string, mime = "text/plain"): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return false;
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later task: Safari cancels the download when the URL is revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Epoch ms of local midnight of the day `nowMs` falls on (the reader's "today"). */
export function localDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2026-11-19" in the reader's time zone (file names). */
export function localDateStamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface HighlightApi {
  registry: { set(name: string, value: unknown): void; delete(name: string): void };
  create: (ranges: Range[]) => unknown;
}

function highlightApi(): HighlightApi | null {
  const g = globalThis as { CSS?: { highlights?: HighlightApi["registry"] }; Highlight?: new (...ranges: Range[]) => unknown };
  const registry = g.CSS?.highlights;
  const Ctor = g.Highlight;
  if (!registry || !Ctor || typeof document === "undefined") return null;
  return { registry, create: (ranges) => new Ctor(...ranges) };
}

/** The parts of a MutationRecord that mutationsTouchText reads (so tests need no DOM). */
export interface MutationLike {
  type: string;
  addedNodes: ArrayLike<{ textContent: string | null }>;
  removedNodes: ArrayLike<{ textContent: string | null }>;
}

/**
 * Can these mutations have changed the text under a highlighted subtree? False only when every
 * record adds or removes nodes without any text - e.g. the icon-only action buttons a row mounts
 * while the pointer is over it, which would otherwise repaint every highlight on each hover.
 * Ranges into untouched text nodes stay valid across such mutations.
 */
export function mutationsTouchText(records: readonly MutationLike[]): boolean {
  for (const r of records) {
    if (r.type !== "childList") return true;
    for (const list of [r.addedNodes, r.removedNodes]) {
      for (let i = 0; i < list.length; i++) if ((list[i]?.textContent ?? "").trim() !== "") return true;
    }
  }
  return false;
}

/**
 * Paint match highlights inside `root` with the CSS Custom Highlight API (style: ::highlight(name)).
 * No DOM is changed, so it is safe over rows rendered by another package's component. Returns a
 * function that removes the highlight; a no-op where the API is missing.
 */
export function paintHighlights(root: Element, name: string, find: (text: string) => TextRange[]): () => void {
  const api = highlightApi();
  if (!api) return () => undefined;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!text.trim()) continue;
    for (const r of find(text)) {
      const range = document.createRange();
      range.setStart(node, r.start);
      range.setEnd(node, r.end);
      ranges.push(range);
    }
  }
  if (ranges.length === 0) {
    api.registry.delete(name);
    return () => undefined;
  }
  api.registry.set(name, api.create(ranges));
  return () => api.registry.delete(name);
}
