// Watchlist hits among the stories on this page (nothing while the watchlist is empty).
// The full list over the 7-day river lives at #/watch.

import type { ArticleId } from "../../../shared/contract";
import { useServices } from "../../app/services";
import { HeadlineRow } from "../headline/HeadlineRow";

const MAX_ROWS = 5;

export function WatchHits({ ids }: { ids: readonly ArticleId[] }) {
  const { router } = useServices();
  if (ids.length === 0) return null;
  const href = router.href({ name: "watch" });
  return (
    <section className="home-watch" aria-labelledby="watch-hits">
      <h2 className="section-heading" id="watch-hits">
        <a href={href}>WATCHLIST</a>{" "}
        <span className="home-count heading-meta">{ids.length} on this page</span>
      </h2>
      <ul className="home-rows" role="list">
        {ids.slice(0, MAX_ROWS).map((id) => (
          <li key={id}>
            <HeadlineRow id={id} variant="compact" />
          </li>
        ))}
      </ul>
      <a className="home-view-all" href={href}>
        all watchlist hits
      </a>
    </section>
  );
}
