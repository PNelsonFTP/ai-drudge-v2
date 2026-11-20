// Home page: banner -> TOP STORIES | (brief, latest, watchlist) -> section grid.
// All decisions live in homeModel.ts; this file is layout and the loading / error states.

import { useEffect } from "react";
import { useServices, useStore, type Route } from "../../app/services";
import { DailyBrief } from "./DailyBrief";
import { LatestStrip } from "./LatestStrip";
import { NewSinceBanner } from "./NewSinceBanner";
import { SectionsGrid } from "./SectionsGrid";
import { TopStories } from "./TopStories";
import { useHomeModel } from "./useHomeModel";
import { WatchHits } from "./WatchHits";

const REST_FALLBACK_DELAY_MS = 300;

export function HomePage(_props: { route: Route }) {
  const { edition, mutes } = useServices();
  const mutedSources = useStore(mutes, (m) => m.sources.size);
  const status = useStore(edition, (s) => s.status);
  const error = useStore(edition, (s) => s.error);
  const hasEdition = useStore(edition, (s) => s.edition !== null);
  // The first attempt failed and another one is running (EditionState.retrying): say so.
  const retrying = useStore(edition, (s) => s.retrying === true);
  const model = useHomeModel();

  // rest.json completes the lists the sections backfill from when a source is muted or a time chip
  // is active (TOP STORIES, LATEST and the default section rows do not change when it arrives).
  // loadRest is idempotent, so this is safe next to the store's own schedule. It waits for an idle
  // moment - unless the reader has a time chip or a muted source, where the sections DO grow once
  // rest is merged: then it is asked for at once to keep that window short.
  const backfills = model.timeFilter !== "all" || mutedSources > 0;
  useEffect(() => {
    if (status !== "front") return;
    const run = (): void => void edition.loadRest();
    if (backfills) {
      run();
      return;
    }
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(run, REST_FALLBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status, edition, backfills]);

  if (!hasEdition) {
    if (status === "error") {
      return (
        <div className="home-empty" role="alert">
          <p>{error ?? "The headlines could not be loaded."}</p>
          <button type="button" className="home-more-btn home-always" onClick={() => void edition.refresh()}>
            try again
          </button>
        </div>
      );
    }
    // While a retry is running the shell's banner region (role="status") already says "Still trying
    // to load the headlines": this paragraph is then plain text, so a screen reader hears it once.
    return (
      <p className="home-empty" role={retrying ? undefined : "status"}>
        {retrying ? "Still trying to load the headlines…" : "Loading headlines…"}
      </p>
    );
  }

  const hasSide = model.brief !== null || model.latest.length > 0 || model.watchHits.length > 0;
  return (
    <div className="home">
      <NewSinceBanner count={model.newSince} />
      <div className={hasSide ? "home-band has-side" : "home-band"}>
        <TopStories lead={model.lead} top={model.top} filtered={model.timeFilter !== "all"} />
        {hasSide ? (
          <div className="home-side">
            {model.brief ? <DailyBrief brief={model.brief} /> : null}
            <LatestStrip ids={model.latest} />
            <WatchHits ids={model.watchHits} />
          </div>
        ) : null}
      </div>
      <SectionsGrid model={model} />
    </div>
  );
}
