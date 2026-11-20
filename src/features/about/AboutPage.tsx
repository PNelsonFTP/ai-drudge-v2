// #/about - what the site is, how ranking works, the legend, shortcuts, freshness, privacy.
//

import { DEFAULT_MAX_PUBLISHER_SHARE, SECTIONS, sectionById } from "../../../shared/sections";
import { REFRESH_INTERVAL_MS, useEditionState, useNow, useServices, type Route } from "../../app/services";
import { Group, Page, RouteLink } from "../export/kit/Page";
import { BUILD_CADENCE } from "../export/kit/rows";
import { BADGE_LEGEND, SEEN_LEGEND_LABEL, SHORTCUTS, WEIGHT_LEGEND, freshness } from "./model";

// "j / k" pairs are alternatives; the g-chords ("g" then "h") are sequences.
function KeyCell({ keys }: { keys: readonly string[] }) {
  const sequence = keys.length === 2 && keys[0] === "g";
  return (
    <>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 ? (sequence ? " then " : " / ") : null}
          <kbd className="sp-kbd">{k}</kbd>
        </span>
      ))}
    </>
  );
}

export function AboutPage(_props: { route: Route }) {
  const services = useServices();
  const state = useEditionState();
  const now = useNow();
  const f = freshness(state, now);
  const atom = `${services.baseUrl}feed.xml`;
  const opml = `${services.baseUrl}feeds.opml`;
  const refreshMinutes = Math.round(REFRESH_INTERVAL_MS / 60_000);
  const models = sectionById("models");
  const policy = sectionById("policy");
  const sharePct = Math.round(DEFAULT_MAX_PUBLISHER_SHARE * 100);

  return (
    <Page title="About AI DRUDGE" meta="version 2">
      <Group title="What this is">
        <div className="sp-prose">
          <p>
            AI DRUDGE is a one-page, link-only front page for artificial-intelligence news. A build runs {BUILD_CADENCE}, reads a few hundred feeds from labs, companies,
            regulators, researchers, newsrooms and security teams, groups articles about the same event into one story, and lays the stories out in {SECTIONS.length} sections.
            Every headline links straight to the publisher.
          </p>
          <p>
            Nothing here is rewritten: headlines and summaries are the publishers&rsquo; own words. The full list of sources, with the health of each one, is on the{" "}
            <RouteLink to={{ name: "sources" }}>Sources page</RouteLink>.
          </p>
        </div>
      </Group>

      <Group title="How ranking works">
        <div className="sp-prose">
          <ul>
            <li>
              <strong>Coverage comes first.</strong> A story&rsquo;s size is the number of different <em>publishers</em> covering it &mdash; publishers, not feeds, so three feeds
              of one outlet count once. Release notes and community threads never add to coverage.
            </li>
            <li>
              <strong>Top Stories</strong> are the AI stories that at least two publishers covered in the last 72 hours, ordered by coverage. The first one is the lead.
            </li>
            <li>
              <strong>Then freshness and source.</strong> Inside a section, newer stories and stories from first-party and established outlets rank higher; a story loses about
              half its freshness every 36 hours.
            </li>
            <li>
              <strong>One story, at most two places.</strong> A story appears in the section of its source and in at most one other section it clearly belongs to. No publisher
              may fill more than about {sharePct}% of a section.
            </li>
            <li>
              <strong>Every section has a time window.</strong> Stories up to {models.window.softDays} days old fill Models &amp; Labs first and nothing older than{" "}
              {models.window.hardDays} days is shown there; Policy &amp; Regulation keeps stories for up to {policy.window.hardDays} days.
            </li>
            <li>The ranking is the same for every reader. Your watchlist, mutes and section order change what you see, not how stories are scored.</li>
          </ul>
        </div>
      </Group>

      <Group title="Legend">
        <table className="sp-table sp-legend-table">
          <caption>Headline emphasis shows the size of the story, not the importance of the feed.</caption>
          <thead>
            <tr>
              <th scope="col">Looks like</th>
              <th scope="col">Means</th>
            </tr>
          </thead>
          <tbody>
            {WEIGHT_LEGEND.map((w) => (
              <tr key={w.className}>
                <th scope="row">
                  <span className={w.className}>{w.sample}</span>
                </th>
                <td>{w.meaning}</td>
              </tr>
            ))}
            {BADGE_LEGEND.map((b) => (
              <tr key={b.label}>
                <th scope="row">{b.className ? <span className={b.className}>{b.label}</span> : b.label}</th>
                <td>
                  {b.meaning}
                  {b.label === SEEN_LEGEND_LABEL ? (
                    <>
                      {" "}
                      Turn dimming off in <RouteLink to={{ name: "settings" }}>Settings</RouteLink>.
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group title="Keyboard shortcuts">
        <table className="sp-table sp-legend-table">
          <caption>Shortcuts work everywhere except while typing in a text box. Turn them off in Settings.</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys.join(" ")}>
                <th scope="row">
                  <KeyCell keys={s.keys} />
                </th>
                <td>{s.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group title="Data freshness">
        <div className="sp-prose">
          {f.available ? (
            <p>
              This edition was generated{" "}
              {f.generatedAt ? (
                <time dateTime={f.generatedAt}>
                  {f.generatedAt.slice(0, 16).replace("T", " ")} UTC ({f.age === "now" ? "just now" : `${f.age} ago`})
                </time>
              ) : (
                "at an unknown time"
              )}
              : {f.stories} stories from {f.feedsOk} of {f.feedsTotal} sources that answered. Build id <code className="sp-code">{f.buildId}</code>.
              {f.stale ? <span className="sp-warn"> The data is more than {f.staleAfter} old; the scheduled build may be failing.</span> : null}
            </p>
          ) : (
            <p>No edition is loaded yet.</p>
          )}
          <p>
            A new edition is built {BUILD_CADENCE}. While this tab is open and visible the page checks for a newer edition every {refreshMinutes} minutes; times such as “5m ago”
            keep ticking. A warning appears when the data is more than {f.staleAfter} old.
          </p>
          <p>
            {f.brief === "claude"
              ? `The Daily Brief box of this edition was written by an AI model (${f.briefModel ?? "model not recorded"}) from the top stories; it is labelled as such. `
              : f.brief === "fallback" && f.briefReason
                ? `This edition has no AI-written brief: ${f.briefReason}. `
                : "This edition has no AI-written brief. "}
            Apart from that optional, labelled box, no text on this site is AI-generated: stories are selected and ordered by fixed rules.
          </p>
        </div>
      </Group>

      <Group title="Privacy">
        <div className="sp-prose">
          <ul>
            <li>No accounts, no cookies, no analytics, no trackers, no advertising.</li>
            <li>
              Bookmarks, the read-later list, watch terms, mutes, read history and settings are kept in this browser&rsquo;s local storage and are never sent anywhere. Watch terms
              in particular never leave the browser.
            </li>
            <li>The page downloads only its own static data files from this site. Clicking a headline takes you straight to the publisher&rsquo;s own site.</li>
            <li>
              To move your state to another device, use <RouteLink to={{ name: "settings" }}>Settings &rarr; Backup and restore</RouteLink>; the backup is a file you download
              yourself.
            </li>
          </ul>
        </div>
      </Group>

      <Group title="Feeds">
        <div className="sp-prose">
          <ul>
            <li>
              <a href={atom}>Atom feed of this site&rsquo;s AI stories</a> for a feed reader.
            </li>
            <li>
              <a href={opml}>OPML file of every source feed</a> to import the same sources into your own reader.
            </li>
          </ul>
        </div>
      </Group>

      <Group title="Version 2 compared with version 1">
        <div className="sp-prose">
          <ul>
            <li>One Top Stories block (stories grouped across outlets, with “Also:” links) replaces the separate Trending, Lead and fallback brief boxes.</li>
            <li>{SECTIONS.length} sections instead of 18, with AI Security and Policy &amp; Regulation as sections of their own.</li>
            <li>Red and bold now mean a big story, not a favoured feed.</li>
            <li>Search covers every story of the last 7 days; each section, search and saved list has its own address.</li>
            <li>New: watchlist, “new since your last visit”, keyboard navigation, briefing export, section order and presets, backup and restore.</li>
            <li>
              Bookmarks, the read-later list, mutes and the theme from version 1 are imported once, read-only, when this browser has them; version 1 keeps working with
              its own data. See <RouteLink to={{ name: "settings" }}>Settings</RouteLink> for the import status.
            </li>
          </ul>
        </div>
      </Group>
    </Page>
  );
}
