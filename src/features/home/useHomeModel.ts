// React binding of the pure home model: reads the stores, memoises buildHomeModel.

import { useMemo } from "react";
import { MINUTE_MS } from "../../../shared/time";
import { useServices, useStore } from "../../app/services";
import { buildHomeModel, type HomeModel } from "./homeModel";

/** The model's clock moves in 5-minute steps: time windows do not need per-minute rebuilds. */
const CLOCK_STEP_MS = 5 * MINUTE_MS;

export function useHomeModel(): HomeModel {
  const services = useServices();
  const edition = useStore(services.edition, (s) => s.edition);
  const brief = useStore(services.edition, (s) => s.brief);
  const mutes = useStore(services.mutes);
  // Field by field, so a theme or density change does not rebuild the page model.
  const sectionOrder = useStore(services.settings, (s) => s.sectionOrder);
  const hiddenSections = useStore(services.settings, (s) => s.hiddenSections);
  const collapsed = useStore(services.settings, (s) => s.collapsed);
  const timeFilter = useStore(services.settings, (s) => s.timeFilter);
  const watch = useStore(services.watchlist, () => services.watchlist.matcher());
  const nowMs = useStore(services.clock, (now) => Math.floor(now / CLOCK_STEP_MS) * CLOCK_STEP_MS);
  const previousVisitMs = useStore(services.lastVisit, (v) => v.previousMs);

  return useMemo(
    () => buildHomeModel({ edition, brief, mutes, settings: { sectionOrder, hiddenSections, collapsed, timeFilter }, nowMs, previousVisitMs, watch }),
    [edition, brief, mutes, sectionOrder, hiddenSections, collapsed, timeFilter, nowMs, previousVisitMs, watch],
  );
}
