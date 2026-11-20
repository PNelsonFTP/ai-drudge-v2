// TOP STORIES (replaces V1's Trending + Lead): the highest-scoring multi-publisher ai-desk stories, Techmeme style.
// The lead is large with its summary; every story shows its outlet count and an inline "Also:" line
// of linked outlet names.

import { HeadlineRow, StoryRow } from "../headline/HeadlineRow";
import type { TopStoryVM } from "./homeModel";

interface TopStoriesProps {
  lead: TopStoryVM | null;
  top: readonly TopStoryVM[];
  /** True when a time chip other than ALL is active (changes the empty-state wording). */
  filtered: boolean;
}

export function TopStories({ lead, top, filtered }: TopStoriesProps) {
  const count = (lead ? 1 : 0) + top.length;
  // On a quiet day the pipeline may lead with a single-publisher story: nothing is "ranked" then.
  const ranked = top.length > 0 || (lead !== null && lead.publishers > 1);
  return (
    <section className="trend-box home-top" aria-labelledby="top-stories">
      <h2 className="section-heading" id="top-stories">
        TOP STORIES{" "}
        {ranked ? <span className="home-count heading-meta">ranked by coverage and freshness</span> : null}
      </h2>
      {lead ? <StoryRow id={lead.id} variant="lead" /> : null}
      {top.length > 0 ? (
        <ol className="home-top-list" role="list" start={2}>
          {top.map((s, i) => (
            <li key={s.id}>
              <span className="home-rank" aria-hidden="true">
                {i + 2}
              </span>
              <HeadlineRow id={s.id} variant="top" />
            </li>
          ))}
        </ol>
      ) : null}
      {count === 0 ? (
        <p className="home-empty">
          {filtered ? "No story in this time window is covered by more than one outlet." : "No story is covered by more than one outlet right now."}
        </p>
      ) : null}
    </section>
  );
}
