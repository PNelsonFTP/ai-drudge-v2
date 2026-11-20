// Page furniture shared by the secondary pages (WP10). It lives under features/export because that
// is the WP10 directory for "components used from other pages"; styles are in kit.css (sp- prefix).

import { useId, type ReactNode } from "react";
import { isHttpUrl } from "../../../../shared/url";
import type { Edition } from "../../../../shared/select";
import { TIME_FILTERS, type TimeFilter } from "../../../../shared/time";
import { useEditionState, useServices, type HeadlineRowProps, type Route } from "../../../app/services";
import { splitByRanges, type RowRef, type TextRange } from "./rows";

export interface PageProps {
  title: string;
  /** Short count or status shown next to the title ("25 stories"). */
  meta?: ReactNode;
  /** Controls on the right of the heading. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * One secondary page. The shell (WP8) owns <main>, the skip link and the site <h1>, so the page
 * title is an <h2> labelling a <section>; groups inside a page use <h3>.
 */
export function Page({ title, meta, actions, children }: PageProps) {
  const id = useId();
  return (
    <section className="sp-page" aria-labelledby={id}>
      <div className="sp-head">
        <h2 id={id} className="section-heading sp-title">
          <span>{title}</span>
          {meta ? <span className="sp-title-meta">{meta}</span> : null}
        </h2>
        {actions ? <div className="sp-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Note({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <p className="sp-note" role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
      {children}
    </p>
  );
}

/** Real link to a route (middle-click and copy-link work). */
export function RouteLink({ to, children, className, current }: { to: Route; children: ReactNode; className?: string; current?: boolean }) {
  const { router } = useServices();
  return (
    <a href={router.href(to)} className={className} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}

/** Outbound link; renders plain text when the URL is not http(s) (payload and backup data are untrusted). */
export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  if (!href || !isHttpUrl(href)) return <span className={className}>{children}</span>;
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const CHIP_LABELS: Readonly<Record<TimeFilter, string>> = { new: "NEW", "6h": "6H", "24h": "24H", "3d": "3D", all: "ALL" };
const CHIP_HINTS: Readonly<Record<TimeFilter, string>> = {
  new: "First seen since your last visit",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  all: "Everything",
};

export interface TimeChipsProps {
  value: TimeFilter;
  onChange: (next: TimeFilter) => void;
  /** Stories of THIS page in each window - what the shell's global chips cannot show. */
  counts?: Readonly<Record<TimeFilter, number>>;
  label?: string;
}

/**
 * Accessible name of a time chip. It STARTS with the visible text ("6H 12 stories, Last 6 hours") so
 * voice control can target what is on screen (WCAG 2.5.3 Label in Name); the hint follows.
 */
export function timeChipName(f: TimeFilter, count?: number): string {
  const visible = count === undefined ? CHIP_LABELS[f] : `${CHIP_LABELS[f]} ${count} ${count === 1 ? "story" : "stories"}`;
  return `${visible}, ${CHIP_HINTS[f]}`;
}

/** NEW · 6H · 24H · 3D · ALL for one list, with that list's story count per window. */
export function TimeChips({ value, onChange, counts, label = "Time filter" }: TimeChipsProps) {
  return (
    <div className="sp-chips" role="group" aria-label={label}>
      {TIME_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          className="sp-chip"
          aria-pressed={value === f}
          aria-label={timeChipName(f, counts?.[f])}
          title={CHIP_HINTS[f]}
          onClick={() => onChange(f)}
        >
          {CHIP_LABELS[f]}
          {counts ? <span className="sp-chip-count">{counts[f]}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface RowsProps<R extends RowRef = RowRef> {
  rows: readonly R[];
  variant?: HeadlineRowProps["variant"];
  showSection?: boolean;
  /** Called after the reader opens a row's link. */
  onOpen?: (row: R) => void;
  /** Extra content under a row (match context, a remove button). */
  after?: (row: R) => ReactNode;
}

/** Rows rendered ONLY through the shared HeadlineRow slot (WP9). */
export function Rows<R extends RowRef = RowRef>({ rows, variant, showSection, onOpen, after }: RowsProps<R>) {
  const { ui } = useServices();
  const HeadlineRow = ui.HeadlineRow;
  return (
    <div className="sp-rows">
      {rows.map((r) => (
        <div key={r.id} className="sp-row">
          <HeadlineRow id={r.id} item={r.item} variant={variant} showSection={showSection} onOpen={onOpen ? () => onOpen(r) : undefined} />
          {after ? after(r) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * A titled group (<h3>) with an optional count badge. A plain <div>: the heading is the navigation
 * aid, and a page with a dozen labelled regions would drown the real landmarks.
 */
export function Group({ title, count, extra, children }: { title: ReactNode; count?: number; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="sp-group">
      <h3 className="sp-group-title">
        <span>{title}</span>
        {count !== undefined ? <span className="related-badge">{count}</span> : null}
        {extra ? <span className="sp-group-extra">{extra}</span> : null}
      </h3>
      {children}
    </div>
  );
}

/** Text with matched ranges wrapped in <mark> (for text this package renders itself). */
export function Marked({ text, ranges }: { text: string; ranges: readonly TextRange[] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="sp-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Renders `children(edition)` once an edition is available; otherwise the loading or error state
 * (with a retry). Pages that work without an edition (saved, settings, about) do not use it.
 */
export function EditionGate({ children }: { children: (edition: Edition) => ReactNode }) {
  const { edition: store } = useServices();
  const state = useEditionState();
  if (state.edition) return <>{children(state.edition)}</>;
  if (state.status === "error") {
    return (
      <div className="sp-empty" role="alert">
        <p>Headlines could not be loaded{state.error ? `: ${state.error}` : "."}</p>
        <button type="button" className="sp-btn" onClick={() => void store.refresh().catch(() => undefined)}>
          Try again
        </button>
      </div>
    );
  }
  return <Note live>Loading headlines…</Note>;
}
