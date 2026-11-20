// Geometry of the row the hover card belongs to, and the article that row displays.
//
// HoverState (src/app/services.ts) carries the STORY key and one point: x = the row's left edge,
// y = its bottom edge. To flip the card ABOVE a row near the bottom of the window the card also
// needs the row's top, and to show what the row shows it needs the displayed article's id; the row
// records both here just before it calls hover.show(). Module-local on purpose: the shared
// HoverStore contract stays { id, x, y }.

import type { ArticleId } from "../../../shared/contract";

export interface HoverAnchor {
  /** The id passed to hover.show(): the STORY key (cluster and "Also:" lookups). */
  id: ArticleId;
  /**
   * The article the row displays: the story's lead, another outlet's article standing in for a
   * muted lead source, or the saved article on a saved list. Absent = the card works it out.
   */
  shown?: ArticleId;
  /** The same x / y the row passes to hover.show(). */
  x: number;
  y: number;
  /** Top edge of the row (viewport px). */
  top: number;
}

let anchor: HoverAnchor | null = null;

export function setHoverAnchor(next: HoverAnchor | null): void {
  anchor = next;
}

/**
 * Top edge of the hovered row for a hover state. When the state was not opened by a headline row
 * (or the anchor is from another row) the point itself is the anchor: the card then never covers it.
 */
export function hoverAnchorTop(state: { id: ArticleId; x: number; y: number }): number {
  return anchor !== null && anchor.id === state.id && anchor.x === state.x && anchor.y === state.y ? anchor.top : state.y;
}

/** The article the hovered row displays, when the row recorded one for exactly this hover state. */
export function hoverAnchorShown(state: { id: ArticleId; x: number; y: number }): ArticleId | undefined {
  return anchor !== null && anchor.id === state.id && anchor.x === state.x && anchor.y === state.y ? anchor.shown : undefined;
}
