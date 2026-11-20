// "N new since your last visit" - links to the #/new page (the full list from the river).

import { timeAgo } from "../../../shared/time";
import { createStore, useServices, useStore } from "../../app/services";
import { CloseIcon } from "../headline/icons";

// Remembered for the session (not per mount), keyed by the visit it was dismissed for.
const dismissedFor = createStore<number | null>(null);

export function NewSinceBanner({ count }: { count: number }) {
  const { router, lastVisit, clock } = useServices();
  const previousMs = useStore(lastVisit, (v) => v.previousMs);
  const dismissed = useStore(dismissedFor, (d) => d !== null && d === previousMs);
  const since = useStore(clock, (now) => (previousMs === null ? "" : timeAgo(new Date(previousMs).toISOString(), now)));
  if (count <= 0 || previousMs === null || dismissed) return null;
  return (
    <div className="home-banner" role="status">
      <a href={router.href({ name: "new" })}>
        <strong>{count}</strong> new {count === 1 ? "story" : "stories"} on this page since your last visit{since ? ` (${since})` : ""} - see everything new
      </a>
      <button type="button" className="home-icon-btn icon-btn" aria-label="Dismiss the new stories notice" onClick={() => dismissedFor.set(previousMs)}>
        <CloseIcon />
      </button>
    </div>
  );
}
