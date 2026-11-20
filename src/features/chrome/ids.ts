// DOM ids shared by the chrome components and the keyboard hook.

import type { SectionId } from "../../../shared/sections";

/** <main>: target of the skip link. */
export const MAIN_ID = "main";
/** The search input: target of the "/" key. */
export const SEARCH_INPUT_ID = "site-search";
/** The toolbar <nav>: controlled by the phone "Menu" button. */
export const TOOLBAR_ID = "site-toolbar";
/** Prefix of home-page section ids ("sec-models"): chip nav and the [ ] keys jump to them. */
export const SECTION_ID_PREFIX = "sec-";

export function sectionAnchorId(id: SectionId): string {
  return `${SECTION_ID_PREFIX}${id}`;
}
