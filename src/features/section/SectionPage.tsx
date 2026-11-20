// #/s/<id> - one section in full.

import { useMemo, useState } from "react";
import { findSection } from "../../../shared/sections";
import type { Edition } from "../../../shared/select";
import type { TimeFilter } from "../../../shared/time";
import { useEditionState, useNow, useServices, useStore, type Route } from "../../app/services";
import { useLoadRest, useMutes, useRiver, useSettings } from "../export/kit/hooks";
import { EditionGate, Group, Note, Page, RouteLink, Rows, TimeChips } from "../export/kit/Page";
import { plural } from "../export/kit/rows";
import { buildSectionView, mixLine, sectionNeighbors } from "./model";

/** River tail rows shown before "Show all". */
const TAIL_PREVIEW = 30;

function SectionBody({ edition, route }: { edition: Edition; route: Extract<Route, { name: "section" }> }) {
  const services = useServices();
  const now = useNow();
  const mutes = useMutes();
  const settings = useSettings();
  const { river, status: riverStatus } = useRiver();
  const [allTail, setAllTail] = useState(false);
  // NEW is a view of this page only: site-wide, "new since your last visit" is the #/new page and
  // the shell's time chips never store it. The other chips are the shared, stored time window.
  const [onlyNew, setOnlyNew] = useState(false);
  const filter: TimeFilter = onlyNew ? "new" : settings.timeFilter;
  const setFilter = (next: TimeFilter): void => {
    setOnlyNew(next === "new");
    if (next !== "new") services.settings.set("timeFilter", next);
  };
  const previousVisitMs = useStore(services.lastVisit, (v) => v.previousMs);
  const fullListFailed = useEditionState().restStatus === "error";

  const view = useMemo(
    () => buildSectionView({ edition, river, id: route.id, mutes, filter, nowMs: now, previousVisitMs }),
    [edition, river, route.id, mutes, filter, now, previousVisitMs],
  );
  const { prev, next } = sectionNeighbors(route.id, settings.sectionOrder, settings.hiddenSections);
  const def = findSection(route.id);
  const mix = mixLine(view.mix);
  const tail = allTail ? view.tail : view.tail.slice(0, TAIL_PREVIEW);
  const filtered = filter !== "all";

  return (
    <Page
      title={view.label}
      meta={filtered ? `${view.rows.length} of ${plural(view.ranked, "story", "stories")}` : plural(view.ranked, "story", "stories")}
      actions={<TimeChips value={filter} counts={view.windows} label={`Time filter for ${view.label}`} onChange={setFilter} />}
    >
      {view.muted ? (
        <Note>
          You muted this section: it is left out of the home page, search and the watchlist.{" "}
          <button type="button" className="sp-btn sp-btn-quiet" onClick={() => services.mutes.toggleSection(route.id)}>
            Unmute {view.label}
          </button>
        </Note>
      ) : null}
      {settings.hiddenSections.includes(route.id) ? (
        <Note>
          This section is hidden from your home page. <RouteLink to={{ name: "settings" }}>Change it in Settings</RouteLink>.
        </Note>
      ) : null}
      {mix ? (
        <p className="sp-intro">
          <span className="sp-label">Publisher mix</span> {mix}
          {def ? `. Ranked list: up to ${def.allRows} stories from the last ${def.window.hardDays} days.` : "."}
        </p>
      ) : null}
      {!view.complete && !fullListFailed ? <Note live>Loading the full list…</Note> : null}
      {!view.complete && fullListFailed ? (
        <div className="sp-empty" role="alert">
          <p>The full list could not be loaded; these are the front-page rows of this section.</p>
          <button type="button" className="sp-btn" onClick={() => void services.edition.loadRest().catch(() => undefined)}>
            Try again
          </button>
        </div>
      ) : null}

      {view.rows.length > 0 ? (
        <Rows rows={view.rows.map((id) => ({ id }))} />
      ) : (
        <div className="sp-empty">
          <p>{view.ranked === 0 ? "No stories in this section right now." : "No stories in this section match the time filter."}</p>
          {view.ranked > 0 && filtered ? (
            <button type="button" className="sp-btn" onClick={() => setFilter("all")}>
              Show all {view.ranked}
            </button>
          ) : null}
        </div>
      )}

      {view.tail.length > 0 ? (
        <Group title="Older from the last 7 days" count={view.tail.length} extra="Not in the ranked list, newest first">
          <Rows rows={tail} variant="compact" />
          {view.tail.length > tail.length ? (
            <p className="sp-note">
              <button type="button" className="sp-btn" onClick={() => setAllTail(true)}>
                Show all {view.tail.length}
              </button>
            </p>
          ) : null}
        </Group>
      ) : null}
      {view.complete && riverStatus === "loading" ? <Note live>Loading older stories…</Note> : null}
      {riverStatus === "error" ? <Note>Older stories from the 7-day archive could not be loaded.</Note> : null}

      <nav className="sp-nav" aria-label="Previous and next section">
        <span>{prev ? <RouteLink to={{ name: "section", id: prev.id }}>← {prev.label}</RouteLink> : null}</span>
        <RouteLink to={{ name: "home" }}>All sections</RouteLink>
        <span>{next ? <RouteLink to={{ name: "section", id: next.id }}>{next.label} →</RouteLink> : null}</span>
      </nav>
    </Page>
  );
}

export function SectionPage({ route }: { route: Route }) {
  useLoadRest();
  if (route.name !== "section") return null;
  return <EditionGate>{(edition) => <SectionBody key={route.id} edition={edition} route={route} />}</EditionGate>;
}
