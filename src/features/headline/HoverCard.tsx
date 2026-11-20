// Desktop hover preview, fed by the HoverStore. A nicety for mouse users ONLY: the summary and the
// coverage links it shows are always available inline in the row (keyboard + touch), so the card is
// hidden from assistive technology and its links are out of the tab order.
//
// The pointer can travel into the card (hover.hold() cancels the store's pending hide), and Escape
// dismisses it.
//
// Placement: under the hovered ROW (below its meta line, so the row's own buttons stay usable), or
// above the row when the window has no room below. It is never drawn over the row itself: the card
// title is not a link, so a card over the headline would make the headline unclickable.

import { useEffect, useRef } from "react";
import { alsoOutlets, publisherName, sourceName, visibleStory } from "../../../shared/select";
import { timeAgo } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import { createStore, useServices, useStore } from "../../app/services";
import { hoverAnchorShown, hoverAnchorTop } from "./hoverAnchor";

const CARD_WIDTH = 340;
/** Upper bound of the card's height; headline.css caps .hl-card at the same value. */
const CARD_HEIGHT = 270;
const EDGE = 10;
/** Distance between the row and the card. */
const GAP = 6;
/** Below this much room on both sides of the row the card is not shown at all. */
const MIN_ROOM = 90;
const MAX_OUTLETS = 6;

// The shell mounts the card once (AppShell). Should a page ever embed its own, only one instance renders.
const cardOwner = createStore<object | null>(null);

/** Inline style of the card: `top` when it opens below the row, `bottom` when it is flipped above it. */
export interface HoverCardPlacement {
  left: number;
  top?: number;
  bottom?: number;
  /** Set only when neither side holds a full-height card. */
  maxHeight?: number;
}

/**
 * Where the card goes for a row spanning rowTop..rowBottom (viewport px) whose left edge is x.
 * Below the row when a full-height card fits there, else above it (anchored by `bottom`, so the
 * real card height never has to be measured), else on the roomier side with a capped height.
 * Null when there is no usable room on either side - the card never covers the row.
 */
export function hoverCardPlacement(x: number, rowTop: number, rowBottom: number, viewportWidth: number, viewportHeight: number): HoverCardPlacement | null {
  const left = Math.max(EDGE, Math.min(x, viewportWidth - CARD_WIDTH - EDGE));
  const below: HoverCardPlacement = { left, top: rowBottom + GAP };
  const above: HoverCardPlacement = { left, bottom: viewportHeight - rowTop + GAP };
  const roomBelow = viewportHeight - EDGE - (rowBottom + GAP);
  const roomAbove = rowTop - GAP - EDGE;
  if (roomBelow >= CARD_HEIGHT) return below;
  if (roomAbove >= CARD_HEIGHT) return above;
  const room = Math.max(roomBelow, roomAbove);
  if (room < MIN_ROOM) return null;
  return { ...(roomBelow >= roomAbove ? below : above), maxHeight: Math.floor(room) };
}

export function HoverCard() {
  const services = useServices();
  const { hover } = services;
  const state = useStore(hover);
  const edition = useStore(services.edition, (s) => s.edition);
  const mutes = useStore(services.mutes);
  const now = useStore(services.clock);

  const me = useRef<object>({});
  const owner = useStore(cardOwner);
  // Claim the slot whenever it is free (first mount, or the previous owner unmounted) ...
  useEffect(() => {
    if (cardOwner.get() === null) cardOwner.set(me.current);
  }, [owner]);
  // ... and release it only on unmount.
  useEffect(() => {
    const self = me.current;
    return () => {
      if (cardOwner.get() === self) cardOwner.set(null);
    };
  }, []);

  const visible = state !== null;
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") hover.hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, hover]);

  if (owner !== me.current || !state || !edition) return null;
  // state.id is the STORY key. The card shows what the row shows: the article the row recorded, else
  // the story's displayed lead under the reader's mutes (another outlet's article when the lead
  // source is muted), else the keyed article itself (a saved row of a fully muted story).
  const article = edition.articles[hoverAnchorShown(state) ?? ""] ?? visibleStory(edition, state.id, mutes)?.lead ?? edition.articles[state.id];
  if (!article) return null;

  const placement = hoverCardPlacement(state.x, hoverAnchorTop(state), state.y, window.innerWidth, window.innerHeight);
  if (!placement) return null;
  // Looked up by the story key - with the displayed article's id a re-led story has no cluster and
  // the card lost its "Also covered by" line - and without the outlet the card is already showing.
  const shownBy = publisherName(edition, article).toLowerCase();
  const outlets = alsoOutlets(edition, state.id, mutes).filter((o) => o.article.id !== article.id && o.name.toLowerCase() !== shownBy);
  const at = article.publishedAt ?? article.firstSeenAt;

  return (
    <div className="hover-card hl-card" style={placement} aria-hidden="true" onMouseEnter={() => hover.hold()} onMouseLeave={() => hover.hide()}>
      <div className="hl-card-title">{article.title}</div>
      <div className="hl-card-meta">
        <span className="source-badge">{article.pub ?? sourceName(edition, article.src)}</span>
        <span>{timeAgo(at, now)}</span>
      </div>
      {article.summary ? <p className="hl-card-summary">{article.summary}</p> : null}
      {outlets.length > 0 ? (
        <p className="hl-card-also">
          <span className="hl-also-label">Also covered by:</span>{" "}
          {outlets.slice(0, MAX_OUTLETS).map((o, i) => (
            <span key={o.article.id}>
              {i > 0 ? " · " : ""}
              {isHttpUrl(o.article.url) ? (
                <a href={o.article.url} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
                  {publisherName(edition, o.article)}
                </a>
              ) : (
                publisherName(edition, o.article)
              )}
            </span>
          ))}
          {outlets.length > MAX_OUTLETS ? ` · +${outlets.length - MAX_OUTLETS}` : ""}
        </p>
      ) : null}
    </div>
  );
}
