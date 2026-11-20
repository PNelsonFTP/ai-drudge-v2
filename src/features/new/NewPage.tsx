// #/new - everything first seen since the previous visit.

import { useMemo, useState } from "react";
import { timeAgo } from "../../../shared/time";
import { useEditionState, useNow, useServices, useStore, type Route } from "../../app/services";
import { useMutes, useRiver } from "../export/kit/hooks";
import { Group, Note, Page, RouteLink, Rows } from "../export/kit/Page";
import { BUILD_CADENCE, PAGE_ROW_BUDGET, capGroups, plural } from "../export/kit/rows";
import { buildNewView } from "./model";
import { markAllSeen } from "./markAllSeen";

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function NewPage(_props: { route: Route }) {
  const services = useServices();
  const state = useEditionState();
  const now = useNow();
  const mutes = useMutes();
  const { river, status } = useRiver();
  const previousMs = useStore(services.lastVisit, (v) => v.previousMs);

  const view = useMemo(
    () => (river ? buildNewView({ river, edition: state.edition, previousMs, nowMs: now, mutes }) : null),
    [river, state.edition, previousMs, now, mutes],
  );

  // After a weekend away this page lists 600+ stories: render one page-level budget of rows and
  // offer the rest. Keyed on the cut-off, so "Mark all seen" (which moves it) collapses the list.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const cutoffKey = String(previousMs);
  const capped = useMemo(() => capGroups(view?.groups ?? [], (g) => g.items, expandedFor === cutoffKey ? Infinity : PAGE_ROW_BUDGET), [view, expandedFor, cutoffKey]);

  if (!view) {
    return (
      <Page title="New since your last visit">
        {status === "error" ? (
          <div className="sp-empty" role="alert">
            <p>The 7-day archive could not be loaded, so new stories cannot be listed.</p>
            <button type="button" className="sp-btn" onClick={() => void services.edition.loadRiver().catch(() => undefined)}>
              Try again
            </button>
          </div>
        ) : (
          <Note live>Loading the 7-day archive…</Note>
        )}
      </Page>
    );
  }

  const sinceIso = new Date(view.sinceMs).toISOString();
  return (
    <Page
      title="New since your last visit"
      meta={plural(view.total, "story", "stories")}
      actions={
        <button type="button" className="sp-btn" aria-disabled={view.total === 0} onClick={() => (view.total === 0 ? undefined : markAllSeen(services, view.ids, now))}>
          Mark all seen
        </button>
      }
    >
      <p className="sp-intro">
        {view.firstVisit ? "This looks like your first visit, so this page shows the last 24 hours. " : null}
        Grouped by section, newest first: stories first seen since{" "}
        <time dateTime={sinceIso}>
          {clockLabel(view.sinceMs)} ({timeAgo(sinceIso, now)})
        </time>
        .{view.offHome > 0 ? ` ${view.offHome} of them ${view.offHome === 1 ? "is" : "are"} no longer on the home page.` : ""}
      </p>
      <p className="sp-visually-hidden" role="status" aria-live="polite">
        {plural(view.total, "new story", "new stories")}
      </p>

      {view.total === 0 ? (
        <div className="sp-empty">
          <p className="sp-strong">You are all caught up.</p>
          <p>
            Nothing new has arrived since {clockLabel(view.sinceMs)}. A new edition is built {BUILD_CADENCE}. <RouteLink to={{ name: "home" }}>Back to the home page</RouteLink>
          </p>
        </div>
      ) : null}

      {capped.groups.map(({ group: g, rows }) => (
        <Group key={g.section} title={<RouteLink to={{ name: "section", id: g.section }}>{g.label}</RouteLink>} count={g.items.length}>
          <Rows rows={rows} variant="compact" />
        </Group>
      ))}
      {capped.hidden > 0 ? (
        <p className="sp-note">
          Showing the first {capped.shown} of {view.total} stories, in section order. &ldquo;Mark all seen&rdquo; applies to all {view.total}.{" "}
          <button type="button" className="sp-btn" onClick={() => setExpandedFor(cutoffKey)}>
            Show all {view.total} stories
          </button>
        </p>
      ) : null}
    </Page>
  );
}
