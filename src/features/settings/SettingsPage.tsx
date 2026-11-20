// #/settings - appearance, home page sections, watchlist, mutes, backup / restore, V1 import status,
// reset. Everything is stored in this browser.

import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { SECTION_PRESETS } from "../../app/presets";
import { useEditionState, useNow, useServices, useStore, type BackupResult, type Density, type Route, type Theme } from "../../app/services";
import { downloadText, localDateStamp } from "../export/kit/browser";
import { Dialog } from "../export/kit/Dialog";
import { useMutes, useSettings } from "../export/kit/hooks";
import { Group, Page, RouteLink } from "../export/kit/Page";
import { plural } from "../export/kit/rows";
import { MatchingRules, WatchTermEditor } from "../watch/WatchTermEditor";
import {
  BACKUP_MAX_BYTES,
  activePreset,
  applyLayout,
  applyPreset,
  backupDryRun,
  moveSection,
  muteRows,
  pinSection,
  sectionSettings,
  toggleHidden,
  v1ImportLine,
  type BackupSummary,
  type SectionSetting,
} from "./model";

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match the system" },
];

const DENSITIES: readonly { value: Density; label: string }[] = [
  { value: "compact", label: "Compact (more headlines per screen)" },
  { value: "comfortable", label: "Comfortable (larger rows)" },
];

function Appearance() {
  const { settings: store } = useServices();
  const settings = useSettings();
  return (
    <Group title="Appearance">
      <fieldset className="sp-checks">
        <legend className="sp-label">Theme</legend>
        {THEMES.map((t) => (
          <label key={t.value} className="sp-check">
            <input type="radio" name="sp-theme" value={t.value} checked={settings.theme === t.value} onChange={() => store.set("theme", t.value)} />
            <span>{t.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="sp-checks">
        <legend className="sp-label">Density</legend>
        {DENSITIES.map((d) => (
          <label key={d.value} className="sp-check">
            <input type="radio" name="sp-density" value={d.value} checked={settings.density === d.value} onChange={() => store.set("density", d.value)} />
            <span>{d.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="sp-checks">
        <legend className="sp-label">Keyboard</legend>
        <label className="sp-check">
          <input type="checkbox" checked={settings.shortcuts !== false} onChange={(e) => store.set("shortcuts", e.target.checked)} />
          <span>Single-key keyboard shortcuts (j, k, b, m, /, ? ...)</span>
        </label>
        <p className="sp-note">When off, only Esc acts. The full list is on the About page.</p>
      </fieldset>
      <fieldset className="sp-checks">
        <legend className="sp-label">Headlines</legend>
        <label className="sp-check">
          <input type="checkbox" checked={settings.dimSeen !== false} onChange={(e) => store.set("dimSeen", e.target.checked)} />
          <span>Dim headlines I have seen</span>
        </label>
        <p className="sp-note">
          When on, section and list rows you saw on an earlier visit turn grey. The lead story, TOP STORIES and your saved lists are never dimmed. When off, grey (in
          italic) only marks a low-tier source.
        </p>
      </fieldset>
    </Group>
  );
}

function SectionOrder() {
  const { settings: store } = useServices();
  const settings = useSettings();
  const [message, setMessage] = useState("");
  const rows = sectionSettings(settings);
  const active = activePreset(settings, SECTION_PRESETS);

  // Reordering moves the row's DOM node, and browsers drop focus from a control inside a moved
  // node. Put it back on the same button so a keyboard user can keep pressing Up / Down.
  const listRef = useRef<HTMLOListElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const control = listRef.current?.querySelector<HTMLElement>(`[data-order-control="${key}"]`);
    if (control && document.activeElement !== control) control.focus();
  });

  const move = (row: SectionSetting, delta: -1 | 1): void => {
    if (delta === -1 ? !row.canUp : !row.canDown) return;
    refocus.current = `${row.id}:${delta === -1 ? "up" : "down"}`;
    store.set("sectionOrder", moveSection(settings.sectionOrder, row.id, delta));
    setMessage(`${row.label} moved to position ${row.position + delta} of ${rows.length}.`);
  };
  const pin = (row: SectionSetting): void => {
    if (!row.canUp) return;
    refocus.current = `${row.id}:pin`;
    store.set("sectionOrder", pinSection(settings.sectionOrder, row.id));
    setMessage(`${row.label} moved to the top.`);
  };
  const toggle = (row: SectionSetting): void => {
    store.set("hiddenSections", toggleHidden(settings.hiddenSections, row.id));
    setMessage(row.hidden ? `${row.label} is shown on the home page again.` : `${row.label} is hidden from the home page.`);
  };

  return (
    <Group title="Home page sections" extra={active ? `Layout: ${SECTION_PRESETS.find((p) => p.id === active)?.label}` : "Layout: custom"}>
      <p className="sp-intro">
        Choose the order of the sections on the home page and which ones appear there. A hidden section keeps its own page and still shows up in search and the watchlist.
      </p>
      <div className="sp-field" role="group" aria-label="Section layout presets">
        <span className="sp-label">Presets</span>
        {SECTION_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="sp-btn"
            aria-pressed={active === p.id}
            onClick={() => {
              applyLayout(store, applyPreset(p));
              setMessage(`${p.label} layout applied.`);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="sp-note" role="status" aria-live="polite">
        {message}
      </p>
      <ol ref={listRef} className="sp-order" aria-label="Sections in home page order">
        {rows.map((row) => (
          <li key={row.id} className={row.hidden ? "sp-order-row sp-order-hidden" : "sp-order-row"}>
            <span className="sp-order-pos" aria-hidden="true">
              {row.position}
            </span>
            <span className="sp-order-name">
              <RouteLink to={{ name: "section", id: row.id }}>{row.label}</RouteLink>
              {row.hidden ? <span className="sp-sub"> hidden</span> : null}
            </span>
            {/* aria-disabled instead of disabled: a disabled button would drop keyboard focus when a row reaches the top or bottom. */}
            <button type="button" className="sp-btn" data-order-control={`${row.id}:up`} aria-label={`Move ${row.label} up`} aria-disabled={!row.canUp} onClick={() => move(row, -1)}>
              Up
            </button>
            <button type="button" className="sp-btn" data-order-control={`${row.id}:down`} aria-label={`Move ${row.label} down`} aria-disabled={!row.canDown} onClick={() => move(row, 1)}>
              Down
            </button>
            <button type="button" className="sp-btn" data-order-control={`${row.id}:pin`} aria-label={`Pin ${row.label} to the top`} aria-disabled={!row.canUp} onClick={() => pin(row)}>
              Pin to top
            </button>
            <label className="sp-check">
              <input type="checkbox" checked={!row.hidden} aria-label={`Show ${row.label} on the home page`} onChange={() => toggle(row)} />
              <span>Show</span>
            </label>
          </li>
        ))}
      </ol>
    </Group>
  );
}

function Mutes() {
  const services = useServices();
  const mutes = useMutes();
  const state = useEditionState();
  const sourcesData = useStore(services.sourcesData);
  const [confirm, setConfirm] = useState(false);

  const names = new Map<string, string>();
  for (const s of sourcesData.sources?.sources ?? []) names.set(s.id, s.name);
  const nameOf = (id: string): string | undefined => state.edition?.sources[id]?.name ?? names.get(id);
  const rows = muteRows(mutes, nameOf);
  const pending = mutes.pendingNames;

  // Source names of muted feeds that are not in the current edition come from sources.json.
  const unresolved = [...mutes.sources].some((id) => nameOf(id) === undefined);
  const idle = sourcesData.status === "idle";
  useEffect(() => {
    if (unresolved && idle) void services.sourcesData.load().catch(() => undefined);
  }, [services.sourcesData, unresolved, idle]);

  return (
    <Group title="Muted sources and sections" count={rows.length}>
      <p className="sp-intro">
        A muted source or section is left out everywhere: home page, search, watchlist and exports. Mute a source from a headline&rsquo;s menu or on the{" "}
        <RouteLink to={{ name: "sources" }}>Sources page</RouteLink>.
      </p>
      {pending.length > 0 ? (
        <>
          <p className="sp-note">
            {plural(pending.length, "source name")} muted in the previous version could not be matched to a current source yet and will apply once matched:
          </p>
          <ul className="sp-mutes">
            {pending.map((name) => (
              <li key={name}>
                <span>
                  <span className="source-badge">V1 name</span> {name}
                </span>
                <button type="button" className="sp-btn" aria-label={`Forget the muted V1 source name ${name}`} onClick={() => services.mutes.dropPendingName(name)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rows.length === 0 ? (
        <p className="sp-note">Nothing is muted.</p>
      ) : (
        <>
          <ul className="sp-mutes">
            {rows.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <span>
                  <span className="source-badge">{r.kind}</span> {r.label}
                </span>
                <button
                  type="button"
                  className="sp-btn"
                  aria-label={`Unmute ${r.kind} ${r.label}`}
                  onClick={() => (r.kind === "source" ? services.mutes.toggleSource(r.id) : services.mutes.toggleSection(r.id))}
                >
                  Unmute
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="sp-btn sp-btn-quiet" onClick={() => setConfirm(true)}>
            Unmute everything
          </button>
        </>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Unmute everything?">
        <p>
          This restores {plural(rows.length, "muted source or section", "muted sources and sections")}. Their stories appear again everywhere.
        </p>
        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-btn sp-btn-primary"
            onClick={() => {
              services.mutes.clear();
              setConfirm(false);
            }}
          >
            Unmute everything
          </button>
          <button type="button" className="sp-btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </Group>
  );
}

interface PendingImport {
  name: string;
  text: string;
  summary: BackupSummary;
}

function Backup() {
  const services = useServices();
  const now = useNow();
  const fileId = useId();
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [message, setMessage] = useState("");

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    setResult(null);
    setMessage("");
    if (!file) {
      setPending(null);
      return;
    }
    if (file.size > BACKUP_MAX_BYTES) {
      setPending({ name: file.name, text: "", summary: { ok: false, error: "The file is too large to be a backup of this site." } });
      return;
    }
    try {
      const text = await file.text();
      setPending({ name: file.name, text, summary: backupDryRun(services.backup, text) });
    } catch {
      setPending({ name: file.name, text: "", summary: { ok: false, error: "The file could not be read." } });
    }
  };

  const download = (): void => {
    const ok = downloadText(`ai-drudge-backup-${localDateStamp(now)}.json`, services.backup.exportJson(), "application/json");
    setMessage(ok ? "Backup downloaded. It contains your watch terms, so keep the file private." : "Download is not available here.");
  };

  return (
    <Group title="Backup and restore">
      <p className="sp-intro">
        Bookmarks, the read-later list, watch terms, mutes and settings live only in this browser. Download a backup to move them to another browser or device, or to keep
        a copy.
      </p>
      <div className="sp-field">
        <button type="button" className="sp-btn sp-btn-primary" onClick={download}>
          Download backup (JSON)
        </button>
      </div>
      <p className="sp-note" role="status" aria-live="polite">
        {message}
      </p>

      <div className="sp-field">
        <label htmlFor={fileId}>Restore from a backup file</label>
        <input id={fileId} className="sp-input" type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} />
      </div>

      {pending ? (
        <div className="sp-empty" aria-live="polite">
          <p className="sp-strong">Dry run: {pending.name}</p>
          {pending.summary.ok ? (
            <>
              <p>Nothing has been changed yet. This file contains:</p>
              <ul>
                {pending.summary.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {pending.summary.warnings.map((w) => (
                <p key={w} className="sp-warn">
                  {w}
                </p>
              ))}
              <p>Restoring replaces the current reader state in this browser with the content of the file.</p>
              <div className="sp-dialog-actions">
                <button
                  type="button"
                  className="sp-btn sp-btn-primary"
                  onClick={() => {
                    setResult(services.backup.importJson(pending.text));
                    setPending(null);
                  }}
                >
                  Restore this backup
                </button>
                <button type="button" className="sp-btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="sp-warn">{pending.summary.error}</p>
          )}
        </div>
      ) : null}

      {result ? (
        <p className={result.ok ? "sp-note sp-ok" : "sp-note sp-warn"} role="status" aria-live="polite">
          {result.ok
            ? `Backup restored${result.restored.length ? `: ${result.restored.join(", ")}` : ""}. Reload the page if anything still shows the old state.`
            : `The backup was not restored: ${result.error}`}
        </p>
      ) : null}
    </Group>
  );
}

function V1Import() {
  const services = useServices();
  // The report of this page load; replaced when the reader runs the import again.
  const [report, setReport] = useState(services.migration);
  const [again, setAgain] = useState(false);
  return (
    <Group title="Import from V1">
      <p className="sp-intro">
        {v1ImportLine(report)} The import is read-only: nothing the previous version stored is changed or deleted.
      </p>
      <div className="sp-field">
        <button
          type="button"
          className="sp-btn"
          onClick={() => {
            setReport(services.reimportV1());
            setAgain(true);
          }}
        >
          Import from V1 again
        </button>
      </div>
      <p className="sp-note" role="status" aria-live="polite">
        {again ? "The import ran again. Bookmarks, mutes and seen stories from V1 were merged into the current state." : ""}
      </p>
    </Group>
  );
}

function Reset() {
  const services = useServices();
  const [confirm, setConfirm] = useState<"settings" | "all" | null>(null);
  const [message, setMessage] = useState("");
  const close = (): void => setConfirm(null);

  const resetSettings = (): void => {
    services.settings.reset();
    close();
    setMessage("Settings are back to their defaults.");
  };
  // Everything the reader's state consists of: saved lists, watch terms, mutes, settings, the read
  // history (seen-dimming) and the time of the last visit.
  const eraseAll = (): void => {
    services.saved.clear("bookmarks");
    services.saved.clear("later");
    services.watchlist.clear();
    services.mutes.clear();
    services.settings.reset();
    services.readState.clear();
    services.lastVisit.clear();
    close();
    setMessage("All reader data was erased: bookmarks, the read-later list, watch terms, mutes, settings, read history and the time of your last visit.");
  };

  return (
    <Group title="Reset">
      <div className="sp-field">
        <button type="button" className="sp-btn" onClick={() => setConfirm("settings")}>
          Reset settings
        </button>
        <button type="button" className="sp-btn sp-btn-danger" onClick={() => setConfirm("all")}>
          Erase all reader data
        </button>
      </div>
      <p className="sp-note" role="status" aria-live="polite">
        {message}
      </p>
      <Dialog open={confirm === "settings"} onClose={close} title="Reset settings?">
        <p>
          Theme, density, keyboard shortcuts, seen-dimming, section order, hidden sections and the time filter go back to their defaults. Bookmarks, the
          watchlist and mutes are kept.
        </p>
        <div className="sp-dialog-actions">
          <button type="button" className="sp-btn sp-btn-primary" onClick={resetSettings}>
            Reset settings
          </button>
          <button type="button" className="sp-btn" onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Dialog open={confirm === "all"} onClose={close} title="Erase all reader data?">
        <p>
          This removes every bookmark, the read-later list, all watch terms and all mutes, resets the settings, and forgets which headlines you have seen and when you last
          visited, in this browser. It cannot be undone.
        </p>
        <p>Download a backup first if you may want any of it back.</p>
        <div className="sp-dialog-actions">
          <button type="button" className="sp-btn sp-btn-danger" onClick={eraseAll}>
            Erase
          </button>
          <button type="button" className="sp-btn" onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
    </Group>
  );
}

export function SettingsPage(_props: { route: Route }) {
  return (
    <Page title="Settings" meta="stored in this browser only">
      <Appearance />
      <SectionOrder />
      <Group title="Watchlist">
        <WatchTermEditor />
        <details className="sp-details">
          <summary>How watch terms match</summary>
          <MatchingRules />
        </details>
      </Group>
      <Mutes />
      <Backup />
      <V1Import />
      <Reset />
    </Page>
  );
}
