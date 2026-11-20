// Delivery of a keyboard row action to a headline row: step 3 of the ROW CONTRACT documented in
// useKeyboardNav.ts. Written against structural types (not DOM classes) so the three-step protocol
// - the part two packages must agree on - is unit-tested under node.

import type { ArticleId } from "../../shared/contract";
import { sourceName } from "../../shared/select";
import { ROW_ACTION_EVENT, type AppServices, type RowAction, type RowActionDetail } from "../app/services";
import { muteMessage, unmuteMessage } from "../features/chrome/muteModel";

export { ROW_ACTION_EVENT, type RowActionDetail } from "../app/services";
/** Attribute of the row's root element holding the article id. */
export const ROW_ID_ATTR = "data-aid";
/** A control inside a row that performs an action when clicked: data-row-action="summary". */
export const ROW_ACTION_ATTR = "data-row-action";
/** Marks the row's primary link (default: the first a[href] in the row). */
export const ROW_LINK_ATTR = "data-row-link";

interface Clickable {
  click(): void;
}

/** The slice of an HTMLElement the delivery needs. */
export interface RowElement {
  getAttribute(name: string): string | null;
  dispatchEvent(event: Event): boolean;
  querySelector(selector: string): Clickable | null;
}

export type RowActionOutcome =
  /** A listener performed it and called preventDefault(). */
  | { by: "row" }
  /** A [data-row-action] control inside the row was clicked. */
  | { by: "control" }
  /** The shell's default ran; `message` is the screen-reader announcement, if any. */
  | { by: "default"; message: string | null }
  /** Nothing applied (no id, or an action with no default on a row that did not take it). */
  | { by: "none" };

export function primaryLink<T extends Clickable>(row: { querySelector(selector: string): T | null }): T | null {
  return row.querySelector(`a[${ROW_LINK_ATTR}]`) ?? row.querySelector("a[href]");
}

type ActionServices = Pick<AppServices, "edition" | "saved" | "mutes">;

/** Step c: the shell's own behaviour. Null when it has none for this action / article. */
function runDefault(services: ActionServices, row: RowElement, id: ArticleId, action: RowAction): { message: string | null } | null {
  if (action === "open") {
    const link = primaryLink(row);
    if (!link) return null;
    link.click();
    return { message: null };
  }
  if (action !== "bookmark" && action !== "later" && action !== "mute") return null;
  // Rows whose article is not in the edition (river rows, saved snapshots) must claim the action
  // themselves: the stores need the article, and only the row has it.
  const edition = services.edition.get().edition;
  const article = edition?.articles[id];
  if (!edition || !article) return null;
  const name = sourceName(edition, article.src);
  if (action === "bookmark") {
    const was = services.saved.get().bookmarks.has(id);
    services.saved.toggleBookmark(article, name);
    return { message: `${was ? "Bookmark removed" : "Bookmarked"}: ${article.title}` };
  }
  if (action === "later") {
    const was = services.saved.get().later.has(id);
    services.saved.toggleLater(article, name);
    return { message: `${was ? "Removed from read later" : "Saved for later"}: ${article.title}` };
  }
  const was = services.mutes.get().sources.has(article.src);
  services.mutes.toggleSource(article.src);
  // The same words the shell's mute notice announces (it watches the store), so nothing is read twice.
  return { message: was ? unmuteMessage(name) : muteMessage(name) };
}

/**
 * Deliver `action` to `row`: (a) cancelable bubbling event, (b) the row's marked control,
 * (c) the shell default. Exactly one of them acts.
 */
export function deliverRowAction(row: RowElement, action: RowAction, services: ActionServices): RowActionOutcome {
  const id = row.getAttribute(ROW_ID_ATTR);
  if (!id) return { by: "none" };
  const event = new CustomEvent<RowActionDetail<RowElement>>(ROW_ACTION_EVENT, { bubbles: true, cancelable: true, detail: { id, action, el: row } });
  // dispatchEvent returns false when a listener called preventDefault(): the row did it itself.
  if (!row.dispatchEvent(event)) return { by: "row" };
  const control = row.querySelector(`[${ROW_ACTION_ATTR}="${action}"]`);
  if (control) {
    control.click();
    return { by: "control" };
  }
  const done = runDefault(services, row, id, action);
  return done ? { by: "default", message: done.message } : { by: "none" };
}
