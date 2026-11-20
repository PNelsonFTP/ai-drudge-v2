// Section chips (short labels, the reader's order, hidden and muted sections left out) and the
// time chips NEW · 6H · 24H · 3D · ALL (front page and #/new only).

import { useEffect, useRef, type MouseEvent } from "react";
import type { SectionId } from "../../../shared/sections";
import { useServices, useStore } from "../../app/services";
import { sectionAnchorId } from "./ids";
import { centeredScrollLeft, orderedSections, TIME_CHIP_LABELS, TIME_FILTER_BUTTONS } from "./model";

/** Same number as the two-column breakpoint in components.css. */
export const WIDE_QUERY = "(min-width: 720px)";

export function SectionNav() {
  const { router, settings, mutes } = useServices();
  const route = useStore(router);
  const sectionOrder = useStore(settings, (s) => s.sectionOrder);
  const hiddenSections = useStore(settings, (s) => s.hiddenSections);
  const mutedSections = useStore(mutes, (m) => m.sections);
  const sections = orderedSections({ sectionOrder, hiddenSections }, mutedSections);
  const listRef = useRef<HTMLUListElement>(null);
  const currentId = route.name === "section" ? route.id : null;

  // Phones: the chips are ONE line that scrolls sideways with a hidden scrollbar, so on a deep
  // link, reload or Back the current chip can sit off-screen. Bring it into view by moving the
  // list's own scroll only - never element.scrollIntoView, which would also scroll the window and
  // race the shell's page-scroll reset. A no-op where the list wraps (720 px and up).
  useEffect(() => {
    const list = listRef.current;
    if (!list || currentId === null || list.scrollWidth <= list.clientWidth) return;
    const chip = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!chip) return;
    const chipBox = chip.getBoundingClientRect();
    const chipLeft = chipBox.left - list.getBoundingClientRect().left + list.scrollLeft;
    list.scrollLeft = centeredScrollLeft(chipLeft, chipBox.width, list.clientWidth, list.scrollWidth);
  }, [currentId]);

  // Every chip is a real link to the section page. On the front page of a wide screen the section
  // is already on screen further down, so the click scrolls to it instead; phones (top 3 rows per
  // section) and every other page follow the link.
  const onChipClick = (event: MouseEvent<HTMLAnchorElement>, id: SectionId): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (router.get().name !== "home" || !window.matchMedia(WIDE_QUERY).matches) return;
    const target = document.getElementById(sectionAnchorId(id));
    if (!target || target.getClientRects().length === 0) return;
    event.preventDefault();
    target.scrollIntoView({ block: "start" });
    // Move keyboard / screen-reader focus with the scroll, or the next Tab jumps back to the chips.
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };

  if (sections.length === 0) return null;
  return (
    <nav className="chip-nav" aria-label="Sections">
      <ul className="chip-list" ref={listRef}>
        {sections.map((section) => {
          const current = route.name === "section" && route.id === section.id;
          return (
            <li key={section.id}>
              <a
                className={current ? "chip chip-active" : "chip"}
                href={router.href({ name: "section", id: section.id })}
                aria-current={current ? "page" : undefined}
                title={section.label}
                onClick={(event) => onChipClick(event, section.id)}
              >
                {section.short}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The shell's time chips. AppShell renders them only on the routes model.ts showsTimeChips() names
 * (front page, #/new): a section page has its own group with counts, the other pages no time window.
 */
export function TimeChips() {
  const { router, settings } = useServices();
  const route = useStore(router);
  const timeFilter = useStore(settings, (s) => s.timeFilter);
  const onNew = route.name === "new";

  return (
    <div className="time-chips" role="group" aria-label="Show stories from">
      <a className={onNew ? "chip chip-active" : "chip"} href={router.href({ name: "new" })} aria-current={onNew ? "page" : undefined} title="New since your last visit">
        {TIME_CHIP_LABELS.new}
      </a>
      {TIME_FILTER_BUTTONS.map((filter) => (
        <button
          key={filter}
          type="button"
          className="chip"
          // On #/new the NEW chip is the active one; the stored window applies again on other pages.
          aria-pressed={!onNew && timeFilter === filter}
          title={filter === "all" ? "All stories" : `Stories from the last ${TIME_CHIP_LABELS[filter].toLowerCase()}`}
          onClick={() => {
            settings.set("timeFilter", filter);
            if (router.get().name === "new") router.go({ name: "home" });
          }}
        >
          {TIME_CHIP_LABELS[filter]}
        </button>
      ))}
    </div>
  );
}
