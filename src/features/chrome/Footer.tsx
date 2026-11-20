// Footer (outside <main>): feeds, sources + feed health, about, shortcuts, version and build id.

import { useServices, useStore } from "../../app/services";
import { feedsLabel, shortcutsEnabled, siteUrl } from "./model";
import { APP_VERSION } from "./version";

export interface FooterProps {
  version?: string;
  onShowShortcuts: () => void;
}

export function Footer({ version = APP_VERSION, onShowShortcuts }: FooterProps) {
  const { edition, router, settings, baseUrl } = useServices();
  const shortcuts = useStore(settings, shortcutsEnabled);
  const counts = useStore(edition, (s) => s.edition?.counts ?? null);
  const buildId = useStore(edition, (s) => s.edition?.meta.buildId ?? null);
  const feeds = feedsLabel(counts);
  return (
    <footer className="site-footer">
      <ul className="footer-links">
        <li>
          <a href={siteUrl(baseUrl, "feed.xml")} type="application/atom+xml">
            Atom feed
          </a>
        </li>
        <li>
          <a href={siteUrl(baseUrl, "feeds.opml")} title="Every source as an OPML subscription list">
            OPML
          </a>
        </li>
        <li>
          <a href={router.href({ name: "sources" })}>Sources &amp; feed health{feeds ? ` — ${feeds}` : ""}</a>
        </li>
        <li>
          <a href={router.href({ name: "about" })}>About</a>
        </li>
        <li>
          <button type="button" className="link-btn" onClick={onShowShortcuts} aria-keyshortcuts={shortcuts ? "?" : undefined}>
            Keyboard shortcuts
          </button>
        </li>
      </ul>
      <p className="footer-meta">
        AI DRUDGE v{version}
        {buildId ? ` · build ${buildId}` : ""} · An independent aggregator, not affiliated with the Drudge Report.
      </p>
    </footer>
  );
}
