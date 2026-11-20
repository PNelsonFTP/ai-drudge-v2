// #/sources - every source of the registry with its health; the public proof that every source link
// is tracked.

import { useEffect, useId, useMemo, useState } from "react";
import { isSectionId } from "../../../shared/sections";
import { timeAgo } from "../../../shared/time";
import { useNow, useServices, useStore, type Route } from "../../app/services";
import { useMutes } from "../export/kit/hooks";
import { ExternalLink, Note, Page, RouteLink } from "../export/kit/Page";
import { plural } from "../export/kit/rows";
import {
  NO_FILTER,
  SOURCE_STATUSES,
  STATUS_HELP,
  STATUS_LABEL,
  buildSourceRows,
  filterSources,
  sectionsWithSources,
  summarize,
  summaryLine,
  tierLabel,
  type SourceFilter,
  type SourceRow,
  type SourceStatus,
} from "./model";

const STATUS_CLASS: Readonly<Record<SourceStatus, string>> = {
  ok: "sp-ok",
  carried: "sp-strong",
  failing: "sp-warn",
  quarantined: "sp-warn",
  paused: "",
  unknown: "",
};

function isStatusFilter(v: string): v is SourceFilter["status"] {
  return v === "all" || v === "problems" || v === "muted" || (SOURCE_STATUSES as readonly string[]).includes(v);
}

function Row({ row, now, onToggleMute }: { row: SourceRow; now: number; onToggleMute: () => void }) {
  const { info } = row;
  return (
    <tr>
      <th scope="row">
        <ExternalLink href={row.homepage}>{info.name}</ExternalLink>
        {row.muted ? <span className="sp-sub">muted by you</span> : null}
      </th>
      <td>{info.publisher}</td>
      <td>
        <RouteLink to={{ name: "section", id: info.home }}>{row.sectionLabel}</RouteLink>
      </td>
      <td>{tierLabel(info.tier)}</td>
      <td>{info.scope === "ai" ? "AI" : "General"}</td>
      <td>{info.kind}</td>
      <td>
        <span className={STATUS_CLASS[row.status]} title={STATUS_HELP[row.status]}>
          {STATUS_LABEL[row.status]}
        </span>
        {row.detail ? <span className="sp-sub">{row.detail}</span> : null}
      </td>
      <td className="sp-num">{row.failStreak}</td>
      <td>{row.lastOkAt ? <time dateTime={row.lastOkAt}>{timeAgo(row.lastOkAt, now)}</time> : row.status === "ok" ? "this build" : "never"}</td>
      <td className="sp-num">{row.count}</td>
      <td>{row.feedUrl ? <ExternalLink href={row.feedUrl}>feed</ExternalLink> : info.kind === "scrape" ? "page scrape" : "—"}</td>
      <td>
        <button type="button" className="sp-btn" aria-pressed={row.muted} aria-label={`${row.muted ? "Unmute" : "Mute"} ${info.name}`} onClick={onToggleMute}>
          {row.muted ? "Muted" : "Mute"}
        </button>
      </td>
    </tr>
  );
}

export function SourcesPage(_props: { route: Route }) {
  const services = useServices();
  const data = useStore(services.sourcesData);
  const mutes = useMutes();
  const now = useNow();
  const [filter, setFilter] = useState<SourceFilter>(NO_FILTER);
  const sectionId = useId();
  const statusId = useId();
  const textId = useId();

  const idle = data.status === "idle";
  useEffect(() => {
    if (idle) void services.sourcesData.load().catch(() => undefined);
  }, [services.sourcesData, idle]);

  const rows = useMemo(() => (data.sources ? buildSourceRows(data.sources, data.health, mutes) : []), [data.sources, data.health, mutes]);
  const visible = useMemo(() => filterSources(rows, filter), [rows, filter]);
  const summary = useMemo(() => summarize(rows), [rows]);
  const sections = useMemo(() => sectionsWithSources(rows), [rows]);
  const opml = `${services.baseUrl}feeds.opml`;
  const atom = `${services.baseUrl}feed.xml`;

  if (!data.sources) {
    return (
      <Page title="Sources">
        {data.status === "error" ? (
          <div className="sp-empty" role="alert">
            <p>The source list could not be loaded{data.error ? `: ${data.error}` : "."}</p>
            <button type="button" className="sp-btn" onClick={() => void services.sourcesData.load().catch(() => undefined)}>
              Try again
            </button>
          </div>
        ) : (
          <Note live>Loading the source list…</Note>
        )}
        <p className="sp-note">
          <a href={opml}>Download all feeds as OPML</a>
        </p>
      </Page>
    );
  }

  return (
    <Page title="Sources" meta={summaryLine(summary)}>
      <p className="sp-intro">
        Every source this site reads, with the result of the last build ({timeAgo(data.sources.generatedAt, now) || "time unknown"}). Each feed and homepage link below is
        tracked: a source that stops answering shows up here as failing, is carried forward for up to 6 hours, and is quarantined after 48 failed builds.{" "}
        <a href={opml}>Download all feeds as OPML</a> · <a href={atom}>Site Atom feed</a>
      </p>
      {!data.health ? <Note>Health data is not available for this build; statuses show “No data”.</Note> : null}

      <form className="sp-bar" role="search" aria-label="Filter sources" onSubmit={(e) => e.preventDefault()}>
        <span className="sp-field">
          <label htmlFor={sectionId}>Section</label>
          <select
            id={sectionId}
            className="sp-select"
            value={filter.section}
            onChange={(e) => setFilter({ ...filter, section: isSectionId(e.target.value) ? e.target.value : "all" })}
          >
            <option value="all">All sections ({rows.length})</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.count})
              </option>
            ))}
          </select>
        </span>
        <span className="sp-field">
          <label htmlFor={statusId}>Status</label>
          <select id={statusId} className="sp-select" value={filter.status} onChange={(e) => setFilter({ ...filter, status: isStatusFilter(e.target.value) ? e.target.value : "all" })}>
            <option value="all">Any status</option>
            <option value="problems">Not OK ({summary.active - summary.ok})</option>
            {SOURCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} ({summary[s]})
              </option>
            ))}
            <option value="muted">Muted by you ({summary.muted})</option>
          </select>
        </span>
        <span className="sp-field sp-bar-grow">
          <label htmlFor={textId}>Find</label>
          <input
            id={textId}
            type="search"
            className="sp-input sp-bar-grow"
            value={filter.text}
            autoComplete="off"
            spellCheck={false}
            placeholder="name, publisher, host, tag…"
            onChange={(e) => setFilter({ ...filter, text: e.target.value })}
          />
        </span>
        <button type="button" className="sp-btn" onClick={() => setFilter(NO_FILTER)}>
          Reset
        </button>
      </form>

      <p className="sp-note" role="status" aria-live="polite">
        Showing {visible.length} of {plural(rows.length, "source")}.
      </p>

      {visible.length === 0 ? (
        <div className="sp-empty">
          <p>No source matches these filters.</p>
        </div>
      ) : (
        <div className="sp-scroll" role="region" aria-label="Source table" tabIndex={0}>
          <table className="sp-table">
            <caption>
              {summaryLine(summary)}. Muting a source hides its stories everywhere on this site, in this browser only.
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Publisher</th>
                <th scope="col">Section</th>
                <th scope="col">Tier</th>
                <th scope="col">Scope</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Fail streak</th>
                <th scope="col">Last OK</th>
                <th scope="col">Items</th>
                <th scope="col">Feed</th>
                <th scope="col">Mute</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <Row key={r.info.id} row={r} now={now} onToggleMute={() => services.mutes.toggleSource(r.info.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="sp-prose sp-legend">
        {SOURCE_STATUSES.map((s) => (
          <div key={s}>
            <dt className={STATUS_CLASS[s] || "sp-strong"}>{STATUS_LABEL[s]}</dt>
            <dd>{STATUS_HELP[s]}</dd>
          </div>
        ))}
        <div>
          <dt className="sp-strong">Scope</dt>
          <dd>“AI” sources are AI-only outlets; items of “General” sources must pass the AI-relevance filter before they are shown.</dd>
        </div>
        <div>
          <dt className="sp-strong">Tier</dt>
          <dd>The registry’s trust and priority tier of a source, 1 (labs and regulators themselves, top outlets) to 4 (low).</dd>
        </div>
      </dl>
    </Page>
  );
}
