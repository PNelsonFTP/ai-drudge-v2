// LATEST: the newest ai-desk stories as dense one-liners.

import type { ArticleId } from "../../../shared/contract";
import { HeadlineRow } from "../headline/HeadlineRow";

export function LatestStrip({ ids }: { ids: readonly ArticleId[] }) {
  if (ids.length === 0) return null;
  return (
    <section className="home-latest" aria-labelledby="latest">
      <h2 className="section-heading" id="latest">
        LATEST
      </h2>
      <ul className="home-rows" role="list">
        {ids.map((id) => (
          <li key={id}>
            <HeadlineRow id={id} variant="compact" />
          </li>
        ))}
      </ul>
    </section>
  );
}
