// #/q/<query> - search over the edition and the 7-day river.

import { useMemo, useRef, useState } from "react";
import { useEditionState, useServices, useStore, type Route } from "../../app/services";
import { useLoadRest, useMutes, useRiver, useTextHighlights } from "../export/kit/hooks";
import { Group, Marked, Note, Page, RouteLink, Rows } from "../export/kit/Page";
import { PAGE_ROW_BUDGET, capGroups, plural, queryRanges, type TextRange } from "../export/kit/rows";
import { buildSearchView, watchState, watchTermFor, type MatchPlace, type SearchRow } from "./model";

const PLACE_LABEL: Readonly<Record<MatchPlace, string>> = {
  summary: "In the summary",
  coverage: "Also covered by",
  source: "Source",
};

/** One pseudo-group after the section groups, so the page-level row budget covers it too. */
const BY_SOURCE = "by-source";
type Listed = { key: string; rows: readonly SearchRow[] };

function SearchTips() {
  return (
    <ul>
      <li>
        Every word must match: <code className="sp-code">anthropic ipo</code> finds stories that contain both.
      </li>
      <li>
        Words match from the start of a word, and short words (up to 5 letters) must match a whole word: <code className="sp-code">intel</code> finds Intel, not
        &ldquo;intelligence&rdquo;; <code className="sp-code">quantiz</code> finds &ldquo;quantization&rdquo;.
      </li>
      <li>
        Put an exact phrase in double quotes: <code className="sp-code">"prompt injection"</code>.
      </li>
      <li>
        Headlines, summaries and the headlines of other outlets covering the same story are searched. Stories that match only by the name of their source are listed
        separately, after the results.
      </li>
      <li>
        Narrow a search with <code className="sp-code">source:reuters</code> or <code className="sp-code">section:policy</code> (for example{" "}
        <code className="sp-code">section:policy finra</code>). Section names are not searched as words.
      </li>
      <li>The search covers the current edition and every story of the last 7 days, including stories that left the front page.</li>
      <li>Upper and lower case, accents and curly quotes do not matter. Muted sources and sections are left out.</li>
    </ul>
  );
}

function Context({ row, find }: { row: SearchRow; find: (text: string) => TextRange[] }) {
  const c = row.context;
  if (!c) return null;
  return (
    <p className="sp-row-context">
      <span className="sp-label">{PLACE_LABEL[c.place]}</span>
      {c.text ? (
        <>
          {" "}
          <Marked text={c.text} ranges={find(c.text)} />
        </>
      ) : null}
    </p>
  );
}

export function SearchPage({ route }: { route: Route }) {
  useLoadRest();
  const services = useServices();
  const state = useEditionState();
  const mutes = useMutes();
  const terms = useStore(services.watchlist, (w) => w.terms);
  const { river, status: riverStatus } = useRiver();
  const q = route.name === "search" ? route.q : "";
  const resultsRef = useRef<HTMLDivElement>(null);

  const view = useMemo(() => buildSearchView({ edition: state.edition, river, query: q, mutes }), [state.edition, river, q, mutes]);
  const wordsKey = view.words.join("\n");
  const find = useMemo(() => {
    const words = wordsKey ? wordsKey.split("\n") : [];
    return (t: string): TextRange[] => queryRanges(t, words);
  }, [wordsKey]);
  useTextHighlights(resultsRef, "sp-hit", wordsKey ? find : null);
  // Broad queries ("ai") match several hundred stories and the page re-renders 250 ms after every
  // keystroke: render one page-level budget of rows and offer the rest. Remembering the QUERY that
  // was expanded (not a flag) collapses the list again as soon as the query changes.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const listKey = view.query;
  const listed = view.total + view.bySource.length;
  const capped = useMemo(() => {
    const all: Listed[] = [...view.groups.map((g) => ({ key: g.section as string, rows: g.rows })), { key: BY_SOURCE, rows: view.bySource }];
    return capGroups(all, (g) => g.rows, expandedFor === listKey ? Infinity : PAGE_ROW_BUDGET);
  }, [view.groups, view.bySource, expandedFor, listKey]);
  const shownRows = new Map(capped.groups.map((c) => [c.group.key, c.rows]));
  const sourceRows = shownRows.get(BY_SOURCE) ?? [];

  const watching = watchState(q, terms);
  const term = watchTermFor(q);
  const fullEditionFailed = state.status === "front" && state.restStatus === "error";
  const editionPending = state.status === "loading" || (state.status === "front" && !fullEditionFailed);
  const riverPending = riverStatus === "idle" || riverStatus === "loading";
  const hasQuery = !view.blank;
  const named = view.sourceWords ? `sources named “${view.sourceWords}”` : "sources with a matching name";

  // The count is of stories that SAY the words. Stories found only by the name of their source are
  // announced separately and never added to it.
  let summary = "";
  if (hasQuery) {
    summary = view.total === 0 ? `No stories match “${view.query}”` : `${plural(view.total, "story matches", "stories match")} “${view.query}”`;
    if (view.fromRiver > 0) summary += ` · ${view.fromRiver} from the 7-day archive, not in the current edition`;
    if (view.bySource.length > 0) summary += ` · ${view.total === 0 ? "" : "plus "}${plural(view.bySource.length, "story", "stories")} from ${named}, listed ${view.total === 0 ? "below" : "after them"}`;
    if (editionPending || riverPending) summary += " · still loading…";
  }
  const nothing = hasQuery && listed === 0 && !editionPending && !riverPending;

  return (
    <Page title="Search" meta={hasQuery ? plural(view.total, "story", "stories") : undefined}>
      {/* The query is typed in the shell's search box (always on screen, "/" focuses it); a second
          input here would be two controls for one URL. */}
      {watching !== "blank" ? (
        <div className="sp-bar">
          <span className="sp-bar-grow">
            Results for <strong>“{view.query}”</strong>
          </span>
          <button
            type="button"
            className="sp-btn"
            aria-pressed={watching === "watching"}
            title="Watch terms are matched as whole words in headlines and collected on the Watch page"
            onClick={() => (watching === "watching" ? services.watchlist.remove(term) : services.watchlist.add(term))}
          >
            {watching === "watching" ? `Watching “${term}”` : `Save “${term}” as watch term`}
          </button>
          {watching === "watching" ? <RouteLink to={{ name: "watch" }}>Open the watchlist</RouteLink> : null}
        </div>
      ) : null}

      <p className="sp-note" role="status" aria-live="polite">
        {summary}
      </p>
      {state.status === "error" && !state.edition ? <Note>The current edition could not be loaded; results come from the 7-day archive only.</Note> : null}
      {riverStatus === "error" ? <Note>The 7-day archive could not be loaded; results cover the current edition only.</Note> : null}
      {fullEditionFailed ? (
        <Note>
          The full edition could not be loaded; edition results cover the front-page rows only.{" "}
          <button type="button" className="sp-btn sp-btn-quiet" onClick={() => void services.edition.loadRest().catch(() => undefined)}>
            Try again
          </button>
        </Note>
      ) : null}

      {!hasQuery ? (
        <div className="sp-empty">
          <p className="sp-strong">Type a word, a name or a phrase in the search box at the top of the page (press / to jump to it).</p>
          <SearchTips />
        </div>
      ) : null}

      {view.section ? (
        <Note>
          {view.section.label} is a section. Section names are not searched as words: <RouteLink to={{ name: "section", id: view.section.id }}>Go to the {view.section.label} section</RouteLink>
        </Note>
      ) : null}
      {view.unknownSections.length > 0 ? (
        <Note>
          No section is called {view.unknownSections.map((u) => `“${u}”`).join(", ")}. Use a section name from the navigation, for example{" "}
          <code className="sp-code">section:policy</code> or <code className="sp-code">section:local</code>.
        </Note>
      ) : null}
      {hasQuery && (view.inSections.length > 0 || view.fromSources.length > 0) ? (
        <Note>
          Searching only{view.inSections.length > 0 ? ` in ${view.inSections.map((x) => x.label).join(", ")}` : ""}
          {view.fromSources.length > 0 ? ` stories from sources named ${view.fromSources.map((x) => `“${x}”`).join(" and ")}` : ""}.
        </Note>
      ) : null}

      {nothing ? (
        <div className="sp-empty">
          <p className="sp-strong">Nothing in the last 7 days matches “{view.query}”.</p>
          <SearchTips />
          <p>
            Want to be told when it shows up? Save it as a watch term above, then check <RouteLink to={{ name: "watch" }}>Watch</RouteLink>.
          </p>
        </div>
      ) : null}

      <div ref={resultsRef}>
        {view.groups.map((g) => {
          const rows = shownRows.get(g.section);
          return rows ? (
            <Group key={g.section} title={<RouteLink to={{ name: "section", id: g.section }}>{g.label}</RouteLink>} count={g.rows.length}>
              <Rows rows={rows} after={(row) => <Context row={row} find={find} />} />
            </Group>
          ) : null;
        })}
        {sourceRows.length > 0 ? (
          <Group title={`From ${named}`} count={view.bySource.length} extra="only the source name matches - not counted above">
            <Rows rows={sourceRows} variant="compact" showSection after={(row) => <Context row={row} find={find} />} />
          </Group>
        ) : null}
      </div>
      {capped.hidden > 0 ? (
        <p className="sp-note">
          Showing the first {capped.shown} of {listed} stories, in section order{view.bySource.length > 0 ? " (source-name matches last)" : ""}.{" "}
          <button type="button" className="sp-btn" onClick={() => setExpandedFor(listKey)}>
            Show all {listed} stories
          </button>
        </p>
      ) : null}
    </Page>
  );
}
