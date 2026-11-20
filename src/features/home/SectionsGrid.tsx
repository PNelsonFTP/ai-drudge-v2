// The section grid: reader order, fixed column slots (hiding a section never reshuffles the others).

import { useSyncExternalStore } from "react";
import { sectionById, type SectionId } from "../../../shared/sections";
import { useServices } from "../../app/services";
import { COLUMN_BREAKPOINTS, columnsForWidth, layoutColumns, type HomeModel } from "./homeModel";
import { SectionColumn } from "./SectionColumn";

const SERVER_COLUMNS = COLUMN_BREAKPOINTS.length + 1;

function canMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribeColumns(onChange: () => void): () => void {
  if (!canMatchMedia()) return () => undefined;
  const lists = COLUMN_BREAKPOINTS.map((bp) => window.matchMedia(`(min-width: ${bp}px)`));
  for (const l of lists) l.addEventListener("change", onChange);
  return () => {
    for (const l of lists) l.removeEventListener("change", onChange);
  };
}

function currentColumns(): number {
  return canMatchMedia() ? columnsForWidth(window.innerWidth) : SERVER_COLUMNS;
}

/** 1 / 2 / 3 columns by viewport width; three when there is no viewport (tests). */
export function useColumnCount(): number {
  return useSyncExternalStore(subscribeColumns, currentColumns, () => SERVER_COLUMNS);
}

export function SectionsGrid({ model }: { model: HomeModel }) {
  const { settings, router } = useServices();
  const columnCount = useColumnCount();
  const byId = new Map(model.sections.map((s) => [s.id, s]));
  const columns = layoutColumns(model.order, new Set(byId.keys()), columnCount);

  const show = (id: SectionId): void => {
    settings.set(
      "hiddenSections",
      settings.get().hiddenSections.filter((x) => x !== id),
    );
  };

  return (
    <>
      {model.sections.length === 0 ? (
        <div className="home-empty">
          {model.timeFilter !== "all" ? (
            <>
              <p>No headlines in this time window.</p>
              <button type="button" className="home-more-btn home-always" onClick={() => settings.set("timeFilter", "all")}>
                show all headlines
              </button>
            </>
          ) : model.hidden.length > 0 ? (
            <p>All sections are hidden. Use "Show again" below, or open Settings.</p>
          ) : (
            <p>No headlines available right now.</p>
          )}
        </div>
      ) : (
        <div className="news-columns home-grid" data-columns={columnCount}>
          {columns.map((col, i) => (
            <div key={i} className="news-col">
              {col.map((id) => {
                const section = byId.get(id);
                return section ? <SectionColumn key={id} section={section} phone={columnCount === 1} /> : null;
              })}
            </div>
          ))}
        </div>
      )}
      {model.hidden.length > 0 ? (
        <p className="home-hidden">
          <span className="home-hidden-label">Hidden sections - show again:</span>
          {model.hidden.map((id) => {
            const def = sectionById(id);
            return (
              <button key={id} type="button" className="home-chip-btn" aria-label={`Show the ${def.label} section again`} onClick={() => show(id)}>
                {def.short}
              </button>
            );
          })}
          <a href={router.href({ name: "settings" })}>Settings</a>
        </p>
      ) : null}
    </>
  );
}
