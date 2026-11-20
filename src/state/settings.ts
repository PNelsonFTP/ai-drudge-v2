// Reader settings: versioned, validated field by field (one bad field falls back to its default
// instead of discarding the rest), synced across tabs, and applied to <html>:
//
//   <html class="dark|light" data-theme="dark|light" data-density="compact|comfortable">
//
// "system" follows prefers-color-scheme and tracks OS changes while it is selected. The no-flash
// inline script for index.html lives in themeBootstrap.ts (re-exported here).

import { SECTION_IDS, isSectionId, type SectionId } from "../../shared/sections";
import { TIME_FILTERS, type TimeFilter } from "../../shared/time";
import { DEFAULT_SETTINGS, STORAGE_KEYS, type Density, type Settings, type SettingsStore, type Theme } from "../app/services";
import { createPersistedStore, defineKey, isRecord, stringList, type KeySpec, type StorageEventSource, type StorageLike } from "./storage";
import { DARK_MEDIA_QUERY, resolveTheme, type ResolvedTheme } from "./themeBootstrap";

export { DARK_MEDIA_QUERY, THEME_BOOTSTRAP_SCRIPT, resolveTheme, type ResolvedTheme } from "./themeBootstrap";

/**
 * Bump when the stored shape changes incompatibly and add `SETTINGS_MIGRATIONS[oldVersion]`.
 * Adding an optional field needs no bump: parseSettings fills it from DEFAULT_SETTINGS.
 */
export const SETTINGS_VERSION = 1;
export const SETTINGS_MIGRATIONS: Readonly<Record<number, (data: unknown) => unknown>> = {};

const THEMES: readonly Theme[] = ["light", "dark", "system"];
const DENSITIES: readonly Density[] = ["compact", "comfortable"];

const sectionList = (x: unknown): SectionId[] => stringList(x, isSectionId) as SectionId[];

/** Settings from untrusted data: every field validated on its own, unknown section ids dropped. */
export function parseSettings(data: unknown): Settings | null {
  if (!isRecord(data)) return null;
  const order = Array.isArray(data.sectionOrder) ? sectionList(data.sectionOrder) : null;
  return {
    theme: THEMES.includes(data.theme as Theme) ? (data.theme as Theme) : DEFAULT_SETTINGS.theme,
    density: DENSITIES.includes(data.density as Density) ? (data.density as Density) : DEFAULT_SETTINGS.density,
    sectionOrder: order && order.length > 0 ? order : null,
    hiddenSections: sectionList(data.hiddenSections),
    collapsed: sectionList(data.collapsed),
    timeFilter: (TIME_FILTERS as readonly string[]).includes(data.timeFilter as string) ? (data.timeFilter as TimeFilter) : DEFAULT_SETTINGS.timeFilter,
    // Absent in settings and backups written before the field existed: that means "on".
    shortcuts: typeof data.shortcuts === "boolean" ? data.shortcuts : DEFAULT_SETTINGS.shortcuts,
    // Absent in settings and backups written before the field existed: that means "on".
    dimSeen: typeof data.dimSeen === "boolean" ? data.dimSeen : DEFAULT_SETTINGS.dimSeen,
  };
}

export const SETTINGS_KEY: KeySpec<Settings> = defineKey({
  key: STORAGE_KEYS.settings,
  version: SETTINGS_VERSION,
  parse: parseSettings,
  migrations: SETTINGS_MIGRATIONS,
});

/** The reader's section order with unlisted sections appended in default order (see Settings.sectionOrder). */
export function effectiveSectionOrder(settings: Pick<Settings, "sectionOrder">): SectionId[] {
  const listed = settings.sectionOrder ?? [];
  return [...listed, ...SECTION_IDS.filter((id) => !listed.includes(id))];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** The slice of document.documentElement the store touches. */
export interface AppearanceRoot {
  classList: { toggle(token: string, force?: boolean): boolean };
  dataset: Record<string, string | undefined>;
}

export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

/** Apply theme + density to <html>. Returns the theme actually shown. */
export function applyAppearance(root: AppearanceRoot, settings: Pick<Settings, "theme" | "density">, prefersDark: boolean): ResolvedTheme {
  const theme = resolveTheme(settings.theme, prefersDark);
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  return theme;
}

export interface SettingsStoreOptions {
  storage: StorageLike;
  events?: StorageEventSource | null;
  /** document.documentElement. Omit (tests, SSR) to skip applying the appearance. */
  root?: AppearanceRoot | null;
  /** window.matchMedia (bound). Without it "system" resolves to light. */
  matchMedia?: ((query: string) => MediaQueryLike) | null;
  onWriteError?: (key: string) => void;
}

export interface SettingsStoreImpl extends SettingsStore {
  /** The theme currently shown ("system" resolved). */
  resolvedTheme(): ResolvedTheme;
  reload(): void;
  dispose(): void;
}

export function createSettingsStore(opts: SettingsStoreOptions): SettingsStoreImpl {
  const store = createPersistedStore<Settings>({
    storage: opts.storage,
    spec: SETTINGS_KEY,
    fallback: DEFAULT_SETTINGS,
    events: opts.events,
    onWriteError: opts.onWriteError,
  });

  let media: MediaQueryLike | null = null;
  try {
    media = opts.matchMedia ? opts.matchMedia(DARK_MEDIA_QUERY) : null;
  } catch {
    media = null;
  }
  const prefersDark = (): boolean => media?.matches ?? false;
  const apply = (): void => {
    if (opts.root) applyAppearance(opts.root, store.get(), prefersDark());
  };
  apply();
  const offStore = store.subscribe(apply);
  // The OS theme only matters while "system" is selected; apply() resolves it either way.
  media?.addEventListener?.("change", apply);

  const patch = (partial: Partial<Settings>): void => {
    store.update((prev) => {
      // Run the candidate through the parser so no caller can persist an invalid value.
      const next = parseSettings({ ...prev, ...partial }) ?? prev;
      const changed = (Object.keys(next) as (keyof Settings)[]).some((k) => !sameValue(prev[k], next[k]));
      return changed ? next : prev;
    });
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    set: (key, value) => patch({ [key]: value } as Partial<Settings>),
    patch,
    reset: () => void store.update((prev) => ((Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every((k) => sameValue(prev[k], DEFAULT_SETTINGS[k])) ? prev : DEFAULT_SETTINGS)),
    resolvedTheme: () => resolveTheme(store.get().theme, prefersDark()),
    reload: store.reload,
    dispose: () => {
      offStore();
      media?.removeEventListener?.("change", apply);
      store.dispose();
    },
  };
}
