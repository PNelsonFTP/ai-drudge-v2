// #/watch - watchlist hits of the last 7 days, grouped by term.

import { useMemo, useState } from "react";
import { useNow, useServices, useStore, type Route } from "../../app/services";
import { useMutes, useRiver } from "../export/kit/hooks";
import { Group, Note, Page, Rows } from "../export/kit/Page";
import { plural } from "../export/kit/rows";
import { buildWatchView, WATCH_WINDOW_DAYS } from "./model";
import { MatchingRules, WatchTermEditor } from "./WatchTermEditor";

/** Rows shown per term before "Show all". */
const GROUP_PREVIEW = 8;

export function WatchPage(_props: { route: Route }) {
  const services = useServices();
  const now = useNow();
  const mutes = useMutes();
  const terms = useStore(services.watchlist, (w) => w.terms);
  const { river, status } = useRiver(terms.length > 0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const view = useMemo(() => (river && terms.length > 0 ? buildWatchView({ river, terms, mutes, nowMs: now }) : null), [river, terms, mutes, now]);

  return (
    // No briefing button here: the masthead's "Briefing" button is on every page, and a second
    // trigger put two identical dialogs on this one.
    <Page title="Watchlist" meta={view ? `${plural(view.stories, "story", "stories")} · last ${WATCH_WINDOW_DAYS} days` : undefined}>
      <p className="sp-intro">
        Headlines from the last {WATCH_WINDOW_DAYS} days that mention your watch terms, grouped by term. The same terms are highlighted in headlines across the site, and
        the last 24 hours of hits go into the briefing (the Briefing button at the top of every page).
      </p>

      <section className="sp-panel" aria-label="Watch terms">
        <WatchTermEditor />
      </section>

      {terms.length === 0 ? (
        <div className="sp-empty">
          <p className="sp-strong">Your watchlist is empty.</p>
          <p>Add a product, vendor, regulator or technique above, or pick a suggested set (CISO, Local LLM, Finance regulation). Matching headlines are collected here as they arrive.</p>
        </div>
      ) : null}

      {terms.length > 0 && !view ? (
        status === "error" ? (
          <div className="sp-empty" role="alert">
            <p>The 7-day archive could not be loaded, so hits cannot be listed.</p>
            <button type="button" className="sp-btn" onClick={() => void services.edition.loadRiver().catch(() => undefined)}>
              Try again
            </button>
          </div>
        ) : (
          <Note live>Loading the 7-day archive…</Note>
        )
      ) : null}

      {view ? (
        <p className="sp-note" role="status" aria-live="polite">
          {view.stories === 0
            ? `No headline matched your ${plural(terms.length, "term")} in the last ${WATCH_WINDOW_DAYS} days.`
            : `${plural(view.stories, "story", "stories")} matched ${view.groups.length} of ${plural(terms.length, "term")}.`}
        </p>
      ) : null}

      {/* The shared HeadlineRow marks watch terms in every headline itself, so nothing is highlighted here. */}
      <div>
        {view?.groups.map((g) => {
          const open = expanded.has(g.term);
          const rows = open ? g.rows : g.rows.slice(0, GROUP_PREVIEW);
          return (
            <Group key={g.term} title={g.term} count={g.count} extra={g.last24h > 0 ? `${g.last24h} in the last 24 h` : "none in the last 24 h"}>
              <Rows rows={rows} variant="compact" showSection />
              {g.rows.length > rows.length ? (
                <p className="sp-note">
                  <button type="button" className="sp-btn" onClick={() => setExpanded(new Set([...expanded, g.term]))}>
                    Show all {g.count} for {g.term}
                  </button>
                </p>
              ) : null}
            </Group>
          );
        })}
      </div>

      {view && view.quiet.length > 0 ? (
        <p className="sp-note">
          <span className="sp-label">No hits in the last {WATCH_WINDOW_DAYS} days</span> {view.quiet.join(" · ")}
        </p>
      ) : null}

      <Group title="How matching works">
        <MatchingRules />
      </Group>
    </Page>
  );
}
