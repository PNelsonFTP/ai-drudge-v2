// The UiSlots.HeadlineRow implementation: one story line, used by every page.
//
// Re-render discipline (V1 re-rendered the whole app on every hover): the row is React.memo'd, takes
// only primitives (+ a value-compared `item`), and subscribes to stores through SELECTORS that return
// primitives or stable references - its own article, "is it bookmarked", the time label. It never
// subscribes to the hover store; it only calls hover.show()/hide().
//
// Everything is reachable without a mouse: the summary and the "Also:" coverage expand inline from
// real buttons, and the row menu opens from the "more actions" button. The hover card is extra.
//
// Keyboard contract (src/keyboard/useKeyboardNav.ts): the root carries data-aid, the title link
// data-row-link, and the summary / coverage buttons data-row-action, which the shell clicks for the
// s / a keys; o / b / l / m on an edition article are the shell's own defaults. rowActions.ts
// covers the rest: rows the shell does not know (river items, snapshots) and by-id addressing.

import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import type { ArticleId } from "../../../shared/contract";
import { findSection } from "../../../shared/sections";
import { alsoOutlets, storyNewestMs, visibleStory } from "../../../shared/select";
import { highlightParts } from "../../../shared/text";
import { timeAgo } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import { useServices, useStore, type HeadlineRowProps } from "../../app/services";
import { setHoverAnchor } from "./hoverAnchor";
import { CheckIcon, ClockIcon, CloseIcon, DotsIcon, LinkIcon, MuteIcon, StarIcon } from "./icons";
import { documentRowActions, type RowAction } from "./rowActions";
import {
  ALSO_INLINE_MAX,
  FLAG_LABELS,
  FLAG_TITLES,
  articleForSaving,
  alsoButtonLabel,
  alsoSplit,
  coverageExtra,
  isNewForReader,
  latestCoverageAt,
  resolveRow,
  rowClaims,
  rowPropsEqual,
  showsLatestCoverage,
  type RowData,
  type RowVariant,
} from "./rowModel";

const LINK_REL = "noopener noreferrer";
const COPIED_MS = 1500;

function canHover(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// "Also:" line
// ------------------------------------------------------------------------------------------------

interface AlsoLineProps {
  leadId: ArticleId;
  domId?: string;
  /** Outlets shown before the "+N more" button. */
  limit: number;
  /** Shown instead of nothing when every other outlet is muted / not loaded. */
  emptyText?: string;
  /**
   * How many of the listed outlets COUNT as coverage (the row's "+N" / "N outlets" minus the outlet
   * on display). The member-order contract lists those first; whatever follows is an outlet that
   * links the story without counting - an aggregator's pointer, an outlet the registry does not
   * vouch for - and is listed apart as "also linked". Omitted: every outlet is listed under "Also:".
   */
  counted?: number;
}

/**
 * Linked outlet names of the other publishers covering a story. Subscribes to the whole edition, so
 * it is only mounted where the line is visible (TOP STORIES, an expanded "+N").
 */
export function AlsoLine({ leadId, domId, limit, emptyText, counted }: AlsoLineProps) {
  const services = useServices();
  const edition = useStore(services.edition, (s) => s.edition);
  const mutes = useStore(services.mutes);
  const outlets = useMemo(() => (edition ? alsoOutlets(edition, leadId, mutes) : []), [edition, leadId, mutes]);
  const [showAll, setShowAll] = useState(false);

  if (outlets.length === 0) {
    return emptyText ? (
      <p id={domId} className="hl-also">
        {emptyText}
      </p>
    ) : null;
  }
  const shown = showAll ? outlets : outlets.slice(0, limit);
  const rest = outlets.length - shown.length;
  // The outlets the badge counts come first; the label changes where the uncounted ones begin, so
  // "7 outlets" is never followed by a list of ten under one "Also:".
  const split = alsoSplit(outlets.length, counted);
  return (
    <p id={domId} className="hl-also">
      {shown.map((o, i) => (
        <Fragment key={o.article.id}>
          {i === 0 && split > 0 ? <span className="hl-also-label">Also:</span> : null}
          {i === split ? (
            <span className="hl-also-label" title="These outlets link the story but are not counted as coverage">
              {i === 0 ? "Also linked:" : " · also linked:"}
            </span>
          ) : null}
          {i === 0 || i === split ? " " : <span aria-hidden="true"> · </span>}
          {isHttpUrl(o.article.url) ? (
            <a className="hl-outlet" href={o.article.url} target="_blank" rel={LINK_REL} title={o.article.title}>
              {o.name}
            </a>
          ) : (
            <span className="hl-outlet">{o.name}</span>
          )}
        </Fragment>
      ))}
      {rest > 0 ? (
        <>
          {" "}
          <button type="button" className="hl-text-btn" onClick={() => setShowAll(true)} aria-label={`Show ${rest} more ${rest === 1 ? "outlet" : "outlets"}`}>
            +{rest} more
          </button>
        </>
      ) : null}
    </p>
  );
}

// ------------------------------------------------------------------------------------------------
// Row
// ------------------------------------------------------------------------------------------------

interface RowViewProps {
  row: RowData;
  /** Other outlets the "Also:" line can list - counted or not (>= extra unless mutes hide some). */
  others: number;
  /**
   * Key of the story (cluster / "Also:" lookups). Differs from row.id only when the story's lead
   * source is muted and the row displays another outlet's article.
   */
  storyId: ArticleId;
  /** Other publishers covering the story (0 for a singleton). */
  extra: number;
  /**
   * When the newest outlet covering the story published, if that is clearly later than the article
   * on display (rowModel latestCoverageAt); null otherwise. The time chips keep a story by this
   * time, so the row says it - "1d ago · latest 54m ago" - whenever the two times fall in different
   * chip windows (rowModel showsLatestCoverage).
   */
  latestAt: string | null;
  variant: RowVariant;
  showSection: boolean;
  onOpen?: () => void;
}

function RowView({ row, storyId, extra, others, latestAt, variant, showSection, onOpen }: RowViewProps) {
  const services = useServices();
  const { saved, mutes, readState, clock, watchlist, hover, router, settings } = services;
  const { id, url, title } = row;

  const bookmarked = useStore(saved, (s) => s.bookmarks.has(id));
  const later = useStore(saved, (s) => s.later.has(id));
  const sourceMuted = useStore(mutes, (m) => row.sourceId !== null && m.sources.has(row.sourceId));
  const savedTab = useStore(router, (r) => (r.name === "saved" ? r.tab : null));
  const matcher = useStore(watchlist, () => watchlist.matcher());
  // wasSeen reflects PREVIOUS sessions only, so it is constant for the life of the row.
  const seen = readState.wasSeen(id);
  // The reader's "Dim headlines I have seen" switch (absent = on). A primitive: one re-render per toggle.
  const dimSeen = useStore(settings, (s) => s.dimSeen !== false);
  // One clock subscription; the row re-renders only when one of the displayed facts changes.
  // (V1 also dimmed rows older than 72 h. V2 does not: the age label says it, and whole sections
  // with a 14-21 day window would be grey.)
  const timeKey = useStore(clock, (now) => `${isNewForReader(row, now, seen) ? 1 : 0}${timeAgo(row.displayAt, now)}|${showsLatestCoverage(row.displayAt, latestAt, now) ? timeAgo(latestAt, now) : ""}`);
  const isNew = timeKey[0] === "1";
  const [ago, latestAgo] = timeKey.slice(1).split("|");

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [alsoOpen, setAlsoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hot, setHot] = useState(false);
  const [copied, setCopied] = useState(false);
  const uid = useId();
  const summaryId = `${uid}-sum`;
  const alsoId = `${uid}-also`;
  const menuId = `${uid}-menu`;

  const titleParts = useMemo(() => highlightParts(title, matcher), [title, matcher]);
  const sectionDef = showSection && row.section ? findSection(row.section) : undefined;
  const isStory = variant === "top" || variant === "lead";
  const hasAlso = others > 0;
  // Seen-dimming is for ordinary list rows. The lead and TOP STORIES keep their size, weight and
  // colour on every visit (they are above the fold, so they are "seen" by the second page load),
  // and on the saved lists every row is seen by definition.
  const dim = seen && dimSeen && !isStory && variant !== "saved";
  // The four row actions are rendered only while they can be used or have something to show:
  // menu open, pointer over the row, focus inside it - or switched on (a bookmarked row keeps its
  // star). That keeps ~1,500 buttons and icons out of the homepage DOM.
  const showActions = menuOpen || hot;
  // They join the Tab order only once the menu button opened them. Stops of a row at rest: the
  // title and "more actions" always, plus "+N" (a clustered list row), "summary" (a row with one)
  // and the section chip (showSection) - two to five, never the four action icons (V1's review
  // counted 623 stops on the page). Keyboard path: title -> "more actions" -> the actions, or the
  // b / l / m keys. "+N" and "summary" stay in the Tab order on purpose: with single-key shortcuts
  // switched off (Settings, WCAG 2.1.4) Tab is the only way to them.
  const actionTab = menuOpen ? undefined : -1;
  const summaryInline = variant === "lead";

  const titleRef = useRef<HTMLAnchorElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Stable ref callback: re-renders never touch the seen-observer. observe() may return a cleanup
  // (React 19 ref style) that releases exactly THIS element, which matters when a story is listed
  // twice; a store that returns nothing is released with observe(null, id).
  const setRoot = useCallback(
    (el: HTMLDivElement | null): void | (() => void) => {
      rootRef.current = el;
      const release = readState.observe(el, id);
      if (el === null || !release) return undefined;
      return () => {
        rootRef.current = null;
        release();
      };
    },
    [readState, id],
  );

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const opened = (): void => {
    readState.markSeen(id);
    onOpen?.();
  };
  // auxclick fires for every non-primary button. Only the middle button opens the link (in a new
  // tab); a right-click for the context menu must not mark the story read or take it off Read later.
  const onAuxClick = (e: MouseEvent<HTMLElement>): void => {
    if (e.button === 1) opened();
  };
  const toggleBookmark = (): void => saved.toggleBookmark(articleForSaving(row, clock.get()), row.sourceName);
  const toggleLater = (): void => saved.toggleLater(articleForSaving(row, clock.get()), row.sourceName);
  const toggleMute = (): void => {
    if (row.sourceId !== null) mutes.toggleSource(row.sourceId);
  };
  const copyLink = (): void => {
    if (!url) return;
    void copyText(url).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
  };
  const removeSaved = (): void => {
    const state = saved.get();
    if (savedTab) saved.remove(savedTab, id);
    else {
      if (state.bookmarks.has(id)) saved.remove("bookmarks", id);
      if (state.later.has(id)) saved.remove("later", id);
    }
  };

  // Actions addressed to this row by id (see rowActions.ts). The handler reads the latest closures
  // through a ref so the row registers once per id, not once per render.
  const runAction = (action: RowAction): void => {
    switch (action) {
      case "open":
        // Clicking the real link keeps target/rel and runs the same onClick as a mouse click.
        titleRef.current?.click();
        break;
      case "bookmark":
        toggleBookmark();
        break;
      case "later":
        toggleLater();
        break;
      case "summary":
        if (row.summary && !summaryInline) setSummaryOpen((v) => !v);
        break;
      case "also":
        if (hasAlso && !isStory) setAlsoOpen((v) => !v);
        break;
      case "mute":
        toggleMute();
        break;
      case "copy":
        copyLink();
        break;
      case "menu":
        setMenuOpen((v) => !v);
        break;
    }
  };
  const runRef = useRef(runAction);
  runRef.current = runAction;
  const rowRef = useRef(row);
  rowRef.current = row;
  useEffect(
    () =>
      documentRowActions().register(id, {
        element: () => rootRef.current,
        run: (action) => runRef.current(action),
        claims: (action) => rowClaims(rowRef.current, action),
      }),
    [id],
  );

  const onRowBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setHot(false);
    setMenuOpen(false);
  };

  // Desktop nicety only: the card repeats what the inline disclosures already offer.
  const hoverable = row.article !== null && (row.summary !== null || hasAlso);
  // The card is anchored to the ROW, not the title: it opens under the meta line (so it never
  // covers this row's own controls) or flips above the row when there is no room below.
  const onTitleEnter = (e: MouseEvent<HTMLElement>): void => {
    if (!hoverable || !canHover()) return;
    const box = (rootRef.current ?? e.currentTarget).getBoundingClientRect();
    // The card is addressed by the STORY key (its "Also covered by" line is the cluster's); the
    // anchor says which article this row displays: another outlet's when the lead source is muted,
    // the saved one on a saved list whatever the mutes.
    setHoverAnchor({ id: storyId, shown: id, x: box.left, y: box.bottom, top: box.top });
    hover.show(storyId, box.left, box.bottom);
  };
  const onTitleLeave = (): void => {
    if (hoverable) hover.hide();
  };

  const titleText: ReactNode = titleParts.map((p, i) =>
    p.term === undefined ? (
      <Fragment key={i}>{p.text}</Fragment>
    ) : (
      <mark key={i} className="hl-watch" title={`Watchlist: ${p.term}`}>
        {p.text}
      </mark>
    ),
  );
  // .headline-seen must follow the weight class (shared component CSS: same specificity, later wins).
  const titleClass = `hl-title headline ${variant === "lead" ? "lead-title " : ""}${row.weightClass}${dim ? " headline-seen" : ""}`;

  // headline.css styles is-seen. is-new / is-muted carry no style of their own (the NEW badge and
  // the pressed mute button show those states); they are hooks for tests and user styles.
  const rootClass = ["hl-row", `hl-${variant}`, dim ? "is-seen" : "", isNew ? "is-new" : "", sourceMuted ? "is-muted" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={setRoot} className={rootClass} data-aid={id} data-variant={variant} onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)} onFocus={() => setHot(true)} onBlur={onRowBlur}>
      <div className="hl-main">
        {url ? (
          <a ref={titleRef} className={titleClass} href={url} target="_blank" rel={LINK_REL} data-row-link="" onClick={opened} onAuxClick={onAuxClick} onMouseEnter={onTitleEnter} onMouseLeave={onTitleLeave}>
            {titleText}
          </a>
        ) : (
          <span className={titleClass}>{titleText}</span>
        )}
        {isNew ? (
          <span className="hl-new new-badge" title="First seen in the last 6 hours and new to you">
            NEW
          </span>
        ) : null}
        {extra > 0 && isStory ? (
          <span className="related-badge hl-count" title={`${extra + 1} outlets are covering this story`}>
            {extra + 1} outlets
          </span>
        ) : null}
        {hasAlso && !isStory ? (
          <button
            type="button"
            className="related-badge hl-more"
            data-row-action="also"
            aria-expanded={alsoOpen}
            aria-controls={alsoOpen ? alsoId : undefined}
            aria-label={alsoButtonLabel(extra, title)}
            title={extra > 0 ? `${extra} more ${extra === 1 ? "outlet is" : "outlets are"} covering this story` : "Other outlets link this story (not counted as coverage)"}
            onClick={() => setAlsoOpen((v) => !v)}
          >
            {extra > 0 ? `+${extra}` : "also"}
          </button>
        ) : null}
      </div>

      <div className="hl-meta">
        {sectionDef ? (
          <a className="hl-section" href={router.href({ name: "section", id: sectionDef.id })}>
            {sectionDef.short}
          </a>
        ) : null}
        <span className="source-badge">{row.label}</span>
        {row.displayAt && ago ? (
          <time className="hl-time" dateTime={row.displayAt} title={row.publishedAt ? undefined : "First seen (the source gave no date)"}>
            {ago}
          </time>
        ) : null}
        {latestAt && latestAgo ? (
          <span className="hl-latest" title="When the newest outlet covering this story published. The time filters keep a story by this time.">
            latest <time dateTime={latestAt}>{latestAgo}</time>
          </span>
        ) : null}
        {row.flags.map((f) => (
          <span key={f} className={`hl-flag hl-flag-${f}`} title={FLAG_TITLES[f]}>
            {FLAG_LABELS[f]}
          </span>
        ))}
        {row.summary && !summaryInline ? (
          <button
            type="button"
            className="hl-text-btn hl-summary-btn"
            data-row-action="summary"
            aria-expanded={summaryOpen}
            aria-controls={summaryOpen ? summaryId : undefined}
            aria-label={`Summary: ${title}`}
            onClick={() => setSummaryOpen((v) => !v)}
          >
            summary
          </button>
        ) : null}
        {variant === "saved" ? (
          <button type="button" className="hl-text-btn hl-remove" aria-label={`Remove from saved: ${title}`} onClick={removeSaved}>
            <CloseIcon /> remove
          </button>
        ) : null}
        <span className="hl-actions" data-open={menuOpen ? "true" : undefined}>
          <button
            type="button"
            className="hl-act icon-btn hl-menu-btn"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={`More actions: ${title}`}
            title="More actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <DotsIcon />
          </button>
          <span id={menuId} className="hl-act-group" role="group" aria-label="Story actions">
            {showActions || bookmarked ? (
              <button type="button" className="hl-act icon-btn hl-act-bookmark" tabIndex={actionTab} aria-pressed={bookmarked} aria-label={`Bookmark: ${title}`} title="Bookmark (saved in this browser)" onClick={toggleBookmark}>
                <StarIcon filled={bookmarked} />
              </button>
            ) : null}
            {showActions || later ? (
              <button type="button" className="hl-act icon-btn later hl-act-later" tabIndex={actionTab} aria-pressed={later} aria-label={`Read later: ${title}`} title="Read later (cleared when opened from the list)" onClick={toggleLater}>
                <ClockIcon filled={later} />
              </button>
            ) : null}
            {row.sourceId !== null && (showActions || sourceMuted) ? (
              <button
                type="button"
                className="hl-act icon-btn hl-act-mute"
                tabIndex={actionTab}
                aria-pressed={sourceMuted}
                aria-label={`Mute source: ${row.sourceName}`}
                title={sourceMuted ? `${row.sourceName} is muted - show it again` : `Hide every story from ${row.sourceName}`}
                onClick={toggleMute}
              >
                <MuteIcon />
              </button>
            ) : null}
            {url && showActions ? (
              <button type="button" className="hl-act icon-btn hl-act-copy" tabIndex={actionTab} aria-label={`Copy link: ${title}`} title={copied ? "Link copied" : "Copy link"} onClick={copyLink}>
                {copied ? <CheckIcon /> : <LinkIcon />}
              </button>
            ) : null}
          </span>
          <span className="hl-sr" role="status">
            {copied ? "Link copied" : ""}
          </span>
        </span>
      </div>

      {row.summary && summaryInline ? <p className="hl-summary">{row.summary}</p> : null}
      {isStory && hasAlso ? <AlsoLine leadId={storyId} counted={extra} limit={variant === "lead" ? 12 : ALSO_INLINE_MAX} /> : null}
      {!isStory && alsoOpen ? <AlsoLine leadId={storyId} counted={extra} domId={alsoId} limit={ALSO_INLINE_MAX} emptyText="Also: no other outlets to show (muted or no longer listed)." /> : null}
      {row.summary && !summaryInline && summaryOpen ? (
        <p id={summaryId} className="hl-summary">
          {row.summary}
        </p>
      ) : null}
    </div>
  );
}

type RowProps = Omit<HeadlineRowProps, "variant"> & { variant?: RowVariant };

function RowImpl({ id, item, variant = "default", showSection = false, onOpen }: RowProps) {
  const { edition, mutes } = useServices();
  // Each selector returns an object that keeps its identity across edition updates that do not
  // touch this story (mergeEdition re-uses the article / source / cluster records).
  const lead = useStore(edition, (s) => s.edition?.articles[id]);
  const cluster = useStore(edition, (s) => s.edition?.clusters[id]);
  // A story keeps its row when the reader mutes the outlet that leads it, as long as another outlet
  // covers it (shared/select visibleStory): the row then displays that outlet's article - title,
  // link, source, time, bookmark - while `id` stays the key for the cluster and the "Also:" line.
  // A muted MEMBER changes only the count: "+N" is the outlets the "Also:" line can still list.
  // Selected as a primitive ("<article id> <publishers>"), and only when it differs from the
  // pipeline's story, so a mute change re-renders only the rows it affects. Saved rows always show
  // exactly what was saved.
  const promoted = useStore(mutes, (m) => {
    if (variant === "saved" || !lead || !cluster || m.sources.size === 0) return null;
    const e = edition.get().edition;
    const story = e ? visibleStory(e, id, m) : null;
    if (!story || (story.lead.id === id && story.publishers === Math.max(1, cluster.publishers))) return null;
    return `${story.lead.id} ${story.publishers}`;
  });
  const cut = promoted === null ? -1 : promoted.indexOf(" ");
  const shownId = promoted === null ? id : promoted.slice(0, cut);
  // Newest visible coverage of the story (0 = a singleton, a saved row or not in the edition). The
  // selector is a new function on every render, so it is also recomputed when a new edition changes
  // the cluster; a mute change recomputes it through the subscription.
  const newestMs = useStore(mutes, (m) => {
    const e = edition.get().edition;
    return variant === "saved" || !cluster || !e ? 0 : storyNewestMs(e, id, m);
  });
  // Other outlets the "Also:" line can list. A story's members are not only its counted publishers:
  // an aggregator's pointer or an outlet the registry does not vouch for is a member too, and a row
  // with ONE counted publisher must still offer its second link to keyboard and touch readers (the
  // hover card was the only way to it). 0 for a singleton or a saved row.
  const others = useStore(mutes, (m) => {
    const e = edition.get().edition;
    return variant === "saved" || !cluster || !e ? 0 : alsoOutlets(e, id, m).length;
  });
  const article = useStore(edition, (s) => s.edition?.articles[shownId]);
  const source = useStore(edition, (s) => (article ? s.edition?.sources[article.src] : undefined));
  const row = useMemo(() => resolveRow(shownId, article, source, item), [shownId, article, source, item]);
  if (!row) return null;
  const extra = promoted === null ? coverageExtra(cluster) : Math.max(0, Number(promoted.slice(cut + 1)) - 1);
  return <RowView row={row} storyId={id} extra={extra} others={Math.max(others, extra)} latestAt={latestCoverageAt(row.displayAt, newestMs)} variant={variant} showSection={showSection} onOpen={onOpen} />;
}

/** WP9-internal row (accepts the "lead" variant used by TOP STORIES). */
export const StoryRow = memo(RowImpl, rowPropsEqual);
StoryRow.displayName = "StoryRow";

/** The UiSlots.HeadlineRow implementation. */
export const HeadlineRow = memo(function HeadlineRow(props: HeadlineRowProps) {
  return <RowImpl {...props} />;
}, rowPropsEqual);
HeadlineRow.displayName = "HeadlineRow";
