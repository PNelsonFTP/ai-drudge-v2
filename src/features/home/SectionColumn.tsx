// One section of the homepage grid.

import { memo, useState } from "react";
import type { SectionId } from "../../../shared/sections";
import { useServices } from "../../app/services";
import { HeadlineRow } from "../headline/HeadlineRow";
import { ChevronIcon, CloseIcon } from "../headline/icons";
import { PHONE_ROWS, sameSection, type HomeSectionVM } from "./homeModel";

function without(list: readonly SectionId[], id: SectionId): SectionId[] {
  return list.filter((x) => x !== id);
}

interface SectionColumnProps {
  section: HomeSectionVM;
  /** Single-column (phone) layout: only the first PHONE_ROWS rows are mounted until "N more". */
  phone?: boolean;
}

function SectionColumnImpl({ section, phone = false }: SectionColumnProps) {
  const { router, settings } = useServices();
  // Phones show the top rows and an "N more" disclosure. In the phone layout the other rows are
  // not mounted at all (they were half of the homepage DOM); the CSS rule that hides
  // .home-row-extra below 720 px stays as the fallback should the layout and the media query disagree.
  const [expanded, setExpanded] = useState(false);
  const { id, label, rows, total, collapsed } = section;
  // The <section> is the jump target of the chip nav and of the [ ] keys: the keyboard layer looks
  // for [id^="sec-"] elements that CONTAIN their rows, so no other id here may start with "sec-".
  const sectionDomId = `sec-${id}`;
  const headingId = `${id}-heading`;
  const bodyId = `${id}-rows`;
  const href = router.href({ name: "section", id });
  const phoneExtra = Math.max(0, rows.length - PHONE_ROWS);
  const shownRows = phone && !expanded ? rows.slice(0, PHONE_ROWS) : rows;

  const toggleCollapsed = (): void => {
    const current = settings.get().collapsed;
    settings.set("collapsed", current.includes(id) ? without(current, id) : [...current, id]);
  };
  const hide = (): void => {
    const current = settings.get().hiddenSections;
    if (!current.includes(id)) settings.set("hiddenSections", [...current, id]);
  };

  return (
    <section className="home-section" id={sectionDomId} aria-labelledby={headingId} data-section={id} data-expanded={expanded ? "true" : undefined}>
      <div className="home-section-head">
        <h2 className="section-heading" id={headingId}>
          <a href={href}>{label}</a>
        </h2>
        <div className="home-section-tools">
          <span className="home-src-count" title="Distinct sources in this section">
            {section.sourceCount} src
          </span>
          <button type="button" className="home-icon-btn icon-btn" aria-expanded={!collapsed} aria-controls={collapsed ? undefined : bodyId} aria-label={`${label} headlines`} title={collapsed ? "Expand this section" : "Collapse this section"} onClick={toggleCollapsed}>
            <ChevronIcon open={!collapsed} />
          </button>
          <button type="button" className="home-icon-btn icon-btn" aria-label={`Hide the ${label} section`} title="Hide this section (show it again from the bottom of the page or Settings)" onClick={hide}>
            <CloseIcon />
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div id={bodyId}>
          <ul className="home-rows" role="list">
            {shownRows.map((rid, i) => (
              <li key={rid} className={i >= PHONE_ROWS ? "home-row-extra" : undefined}>
                <HeadlineRow id={rid} />
              </li>
            ))}
          </ul>
          <p className="home-section-foot">
            {phoneExtra > 0 ? (
              <button type="button" className={phone ? "home-more-btn home-always" : "home-more-btn"} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? "show fewer" : `${phoneExtra} more`}
              </button>
            ) : null}
            {total > rows.length ? (
              <a className="home-view-all" href={href} aria-label={`View all ${total} ${label} stories`}>
                view all {total}
              </a>
            ) : null}
          </p>
        </div>
      )}
    </section>
  );
}

export const SectionColumn = memo(SectionColumnImpl, (a, b) => a.phone === b.phone && sameSection(a.section, b.section));
SectionColumn.displayName = "SectionColumn";
