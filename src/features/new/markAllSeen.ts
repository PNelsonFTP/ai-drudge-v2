// "Mark all seen" for #/new.

import type { ArticleId } from "../../../shared/contract";
import { SEEN_LIMIT, type AppServices } from "../../app/services";

/**
 * Treat everything up to `nowMs` as seen: moves the "new since" cut-off (persisted by the lastVisit
 * store, so a reload and the home page banner agree) and records the listed articles in the read
 * state (seen-dimming; capped at the LRU size so older entries are not all evicted).
 */
export function markAllSeen(services: Pick<AppServices, "lastVisit" | "readState">, ids: readonly ArticleId[], nowMs: number): void {
  for (const id of ids.slice(0, SEEN_LIMIT)) services.readState.markSeen(id);
  services.lastVisit.markAllSeen(nowMs);
}
