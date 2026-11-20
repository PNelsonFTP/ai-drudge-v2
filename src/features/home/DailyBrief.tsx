// Daily Brief box. Rendered ONLY for an AI-written brief: the fallback brief is a list of the top
// stories, which TOP STORIES already shows. The label names the model (AI use must be auditable).

import type { BriefFile } from "../../../shared/contract";
import { timeAgo } from "../../../shared/time";
import { isHttpUrl } from "../../../shared/url";
import { useServices, useStore } from "../../app/services";

const MAX_CITED = 8;

export function DailyBrief({ brief }: { brief: BriefFile }) {
  const { clock } = useServices();
  const age = useStore(clock, (now) => timeAgo(brief.generatedAt, now));
  if (brief.source !== "claude") return null;
  const cited = brief.cited.filter((c) => isHttpUrl(c.url)).slice(0, MAX_CITED);
  return (
    <section className="brief-box home-brief" aria-labelledby="daily-brief">
      <h2 className="section-heading" id="daily-brief">
        DAILY BRIEF
      </h2>
      <p className="home-brief-label">
        AI-written · {brief.model ?? "model not recorded"}
        {age ? ` · ${age}` : ""}
      </p>
      {brief.headline ? <p className="home-brief-headline">{brief.headline}</p> : null}
      {brief.bullets.length > 0 ? (
        <ul className="home-brief-bullets">
          {brief.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      ) : null}
      {cited.length > 0 ? (
        <p className="home-brief-cited">
          <span className="home-brief-cited-label">Cited:</span>{" "}
          {cited.map((c, i) => (
            <span key={c.url}>
              {i > 0 ? <span aria-hidden="true"> · </span> : null}
              <a href={c.url} target="_blank" rel="noopener noreferrer" title={c.title}>
                {c.source}
              </a>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
