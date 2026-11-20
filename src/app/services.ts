// Client service contract (architecture §5 as amended by V2_PLAN §1.4).
// The inter-package contract for WP7 (data + state), WP8 (shell), WP9 (home + headline) and
// WP10 (secondary pages). UI packages talk to each other ONLY through these interfaces:
//
//   WP7 implements  EditionStore, SourcesStore, SavedStore, MutesStore, ReadStateStore,
//                   SettingsStore, WatchlistStore, BackupService, lastVisit
//   WP8 implements  Router, HoverStore, FocusStore, clock; renders the RouteModule of the current route
//   WP9 provides    UiSlots.HeadlineRow and the "home" RouteModule
//   WP10 provides   the other RouteModules and CONSUMES ui.HeadlineRow (never imports WP9 files)
//   src/app/createServices.ts wires the real implementations; test/helpers/fakeServices.ts the fakes
//
// Runtime code here is deliberately tiny: createStore, useStore, the context + hooks, constants.

import { createContext, useContext, useRef, useSyncExternalStore, type ComponentType } from "react";
import type { ArticleId, ArticleV2, BriefFile, HealthFile, RiverFile, SourceId, SourcesFile, StocksFile } from "../../shared/contract";
import type { SectionId } from "../../shared/sections";
import type { Edition, MuteSet } from "../../shared/select";
import type { TermMatcher } from "../../shared/text";
import type { TimeFilter } from "../../shared/time";

// ------------------------------------------------------------------------------------------------
// Store primitive
// ------------------------------------------------------------------------------------------------

/**
 * useSyncExternalStore-compatible store. `get` must return the SAME reference until the state
 * changes (never build a new object in get). `get` and `subscribe` must not depend on `this`.
 */
export interface Store<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface WritableStore<T> extends Store<T> {
  /** Replace the state; listeners are notified only when the value is not Object.is-equal. */
  set(next: T): void;
  update(fn: (prev: T) => T): void;
}

/** Minimal in-memory store. The one store primitive of the client (persisted stores wrap it). */
export function createStore<T>(initial: T): WritableStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: T): void => {
    if (Object.is(next, state)) return;
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set,
    update: (fn) => set(fn(state)),
  };
}

/**
 * Subscribe a component to a store. With `select`, the component re-renders only when the selected
 * value changes (Object.is) - select primitives or stable references:
 *   const isSaved = useStore(saved, (s) => s.bookmarks.has(id));
 */
export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (state: T) => S): T | S {
  const selectRef = useRef(select);
  selectRef.current = select;
  const cache = useRef<{ state: T; select: (state: T) => S; selected: S } | null>(null);
  const getSnapshot = (): T | S => {
    const state = store.get();
    const sel = selectRef.current;
    if (!sel) return state;
    const c = cache.current;
    if (c && c.select === sel && Object.is(c.state, state)) return c.selected;
    const selected = sel(state);
    // Keep the previous reference when the selection is unchanged, so new state objects with the
    // same selected value do not re-render the component.
    const stable = c && Object.is(c.selected, selected) ? c.selected : selected;
    cache.current = { state, select: sel, selected: stable };
    return stable;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

// ------------------------------------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------------------------------------

export type SavedTab = "bookmarks" | "later";

/**
 * Hash routes (no server rewrites on Pages). Canonical hashes:
 *   #/                home            #/s/<sectionId>   section
 *   #/q/<query>       search (query URI-encoded)        #/new    new since last visit
 *   #/watch           watchlist hits  #/saved           saved, tab "bookmarks"
 *   #/later           saved, tab "later"                #/sources · #/settings · #/about
 * Unknown hashes resolve to home.
 */
export type Route =
  | { name: "home" }
  | { name: "section"; id: SectionId }
  | { name: "search"; q: string }
  | { name: "new" }
  | { name: "watch" }
  | { name: "saved"; tab: SavedTab }
  | { name: "sources" }
  | { name: "settings" }
  | { name: "about" };

export type RouteName = Route["name"];

export const ROUTE_NAMES = ["home", "section", "search", "new", "watch", "saved", "sources", "settings", "about"] as const satisfies readonly RouteName[];

export interface Router extends Store<Route> {
  /** Navigate. `replace` swaps the current history entry (search-as-you-type). */
  go(route: Route, opts?: { replace?: boolean }): void;
  /** The href for a real <a href="#/..."> link to the route. */
  href(route: Route): string;
}

/**
 * One page. Convention (auto-discovered by WP8's routeRegistry):
 *   src/features/<route name>/route.tsx   with   `export default route` of type RouteModule,
 * one directory per RouteName: home, section, search, new, watch, saved, sources, settings, about.
 */
export interface RouteModule {
  name: RouteName;
  Component: ComponentType<{ route: Route }>;
  /** Document title (without the site suffix). */
  title: string | ((route: Route) => string);
}

// ------------------------------------------------------------------------------------------------
// Data stores (WP7)
// ------------------------------------------------------------------------------------------------

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface EditionState {
  /**
   * "loading": nothing to show yet. "front": front.json merged (homepage rows). "complete": rest.json
   * merged too. "error": no data and the fetch failed (`error` set). A failed REFRESH while an edition
   * is on screen does not change the status (see `error`).
   */
  status: "loading" | "front" | "complete" | "error";
  edition: Edition | null;
  /** Render the Daily Brief box ONLY when brief.source === "claude". */
  brief: BriefFile | null;
  stocks: StocksFile | null;
  /** river.json once loadRiver() resolved (search, #/new, #/watch, section tails). */
  river: RiverFile | null;
  riverStatus: LoadStatus;
  /**
   * rest.json on its own: "idle" before loadRest(), "loading", "ready" once merged, "error" when the
   * last attempt failed (status stays "front"; keep the homepage rows and offer Retry via loadRest()).
   */
  restStatus: LoadStatus;
  /**
   * Set for status "error" (nothing to show). ALSO set, with status and edition unchanged, when the
   * last refresh of front.json failed while an edition is on screen; cleared by the next successful
   * refresh. Not set when the failure is a newer schemaVersion (outdatedClient covers it).
   */
  error?: string;
  /** Epoch ms of the last successful network fetch of front.json; null while showing cache only. */
  fetchedAtMs: number | null;
  /** True when the server serves a newer schemaVersion than this bundle understands (show "reload"). */
  outdatedClient: boolean;
  /**
   * status.json `staleAfterMinutes` of the last status file that loaded; absent until then (the
   * shell falls back to STALE_BANNER_HOURS). Kept when a later status.json fails. Read it through
   * `staleThresholdHours(state)` (src/features/chrome/model.ts), which bounds it to 30 min .. 24 h.
   */
  staleAfterMinutes?: number;
  /**
   * True while NOTHING is on screen, an attempt to load front.json has failed and another one is
   * waiting or running ("still trying"). Cleared by the first edition or by status "error".
   */
  retrying?: boolean;
}

export interface EditionStore extends Store<EditionState> {
  /** Fetch + merge rest.json (idempotent; resolves when merged or failed). Section / search pages call it. */
  loadRest(): Promise<void>;
  /** Fetch river.json (idempotent). */
  loadRiver(): Promise<void>;
  /** Re-fetch front (+ brief, stocks; rest/river if they were loaded). Called every 10 min while the tab is visible. */
  refresh(): Promise<void>;
  /** Hours since the edition was generated, for the stale banner (threshold: `staleThresholdHours(state)`); null without an edition. */
  staleHours(nowMs: number): number | null;
}

/** sources.json + health.json for the Sources page (lazy). */
export interface SourcesState {
  status: LoadStatus;
  sources: SourcesFile | null;
  health: HealthFile | null;
  error?: string;
}

export interface SourcesStore extends Store<SourcesState> {
  load(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------
// Reader state (WP7) - localStorage namespace "aid2:" (V1 "ai-drudge:*" keys are read once, never written)
// ------------------------------------------------------------------------------------------------

/** What is kept of a saved article so it can still be shown after it left the edition. */
export interface SavedSnapshot {
  id: ArticleId;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: string | null;
  /** ISO time the reader saved it. */
  savedAt: string;
}

export interface SavedState {
  bookmarks: ReadonlySet<ArticleId>;
  later: ReadonlySet<ArticleId>;
  snapshots: Readonly<Record<ArticleId, SavedSnapshot>>;
}

export interface SavedStore extends Store<SavedState> {
  toggleBookmark(a: ArticleV2, sourceName: string): void;
  toggleLater(a: ArticleV2, sourceName: string): void;
  /** Read-later is consumed on open: remove `id` from `later` (no-op when absent). */
  consume(id: ArticleId): void;
  /** Remove by id (works for snapshot-only entries). */
  remove(tab: SavedTab, id: ArticleId): void;
  clear(tab: SavedTab): void;
}

/** MuteSet plus the V1 muted display names that could not be mapped to a SourceId yet. */
export interface MutesState extends MuteSet {
  /** V1 muted source NAMES still waiting for a matching source (resolved against sources.json). */
  pendingNames: readonly string[];
}

export interface MutesStore extends Store<MutesState> {
  toggleSource(id: SourceId): void;
  toggleSection(id: SectionId): void;
  /** Forget one pending V1 name (mutes manager). No-op when absent. */
  dropPendingName(name: string): void;
  clear(): void;
}

/** Seen-dimming. Not a Store: `wasSeen` is fixed for the session (it reflects PREVIOUS sessions only). */
export interface ReadStateStore {
  /** True when the article was seen in a previous session. */
  wasSeen(id: ArticleId): boolean;
  /**
   * Start (el) / stop (null) observing a row; it counts as seen after 1.5 s at 60 % visibility.
   * May return a cleanup that releases exactly this element (React 19 ref-callback style).
   */
  observe(el: Element | null, id: ArticleId): void | (() => void);
  /** Mark seen immediately (opened by click or keyboard). */
  markSeen(id: ArticleId): void;
  /**
   * Erase the read history (Settings > "Erase all reader data"): the stored list is removed and
   * wasSeen() answers false from now on. Stories already recorded in this page load are not
   * recorded again, so the history stays empty until something new is seen.
   */
  clear(): void;
}

export type Theme = "light" | "dark" | "system";
export type Density = "compact" | "comfortable";

export interface Settings {
  theme: Theme;
  density: Density;
  /** Reader's section order; null = default (shared/sections.ts order). Unlisted sections follow in default order. */
  sectionOrder: SectionId[] | null;
  /** Sections removed from the homepage (still reachable at #/s/<id>). */
  hiddenSections: SectionId[];
  /** Sections collapsed to their heading on the homepage. */
  collapsed: SectionId[];
  /** Homepage time chip: NEW · 6H · 24H · 3D · ALL (see shared/time.ts passesTimeFilter). */
  timeFilter: TimeFilter;
  /** Single-key keyboard shortcuts (j, k, b, m, /, ? ...). False = only Esc acts (WCAG 2.1.4). */
  shortcuts: boolean;
  /**
   * "Dim headlines I have seen" (default true). False = list rows keep their weight and colour on
   * later visits (grey italic then only means a low-tier source). Settings and backups written
   * before the field existed are read as true.
   */
  dimSeen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  density: "compact",
  sectionOrder: null,
  hiddenSections: [],
  collapsed: [],
  timeFilter: "all",
  shortcuts: true,
  dimSeen: true,
};

export interface SettingsStore extends Store<Settings> {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** Several keys in ONE write and one notification (section presets). */
  patch(partial: Partial<Settings>): void;
  /** Back to DEFAULT_SETTINGS. */
  reset(): void;
}

/** One-click watchlist starter (see src/app/presets.ts WATCH_PRESETS). */
export interface WatchPreset {
  id: string;
  label: string;
  terms: readonly string[];
}

/** One-click section layout (see src/app/presets.ts SECTION_PRESETS). */
export interface SectionPreset {
  id: string;
  label: string;
  /** Becomes Settings.sectionOrder (null = default order). */
  order: SectionId[] | null;
  /** Becomes Settings.hiddenSections. */
  hidden: SectionId[];
}

export interface WatchlistState {
  /** Reader's terms in insertion order (trimmed, de-duplicated case-insensitively). Ships empty. */
  terms: readonly string[];
}

export interface WatchlistStore extends Store<WatchlistState> {
  add(term: string): void;
  remove(term: string): void;
  /** Add every term of a preset. */
  addPreset(id: string): void;
  clear(): void;
  /**
   * Word-boundary matcher over the current terms (shared/text.ts compileTerms with plural: true).
   * Memoised: the same function is returned until the terms change. Never matches when empty.
   * Use `matcher()(title)` for a hit and `highlightParts(title, matcher())` to highlight.
   */
  matcher(): TermMatcher;
  /** Suggested presets: "CISO", "Local LLM", "Finance regulation". */
  readonly presets: readonly WatchPreset[];
}

export type BackupResult = { ok: true; restored: string[] } | { ok: false; error: string };

export interface BackupPreviewItem {
  /** Storage key the row is about ("aid2:saved"). */
  key: string;
  /** Reader-facing name ("Bookmarks and read-later"). */
  label: string;
  /** "replace": importJson would overwrite this key; "skip": it would be left alone. */
  action: "replace" | "skip";
  /** What would change, or why the key is skipped. */
  detail: string;
}

/** Dry run of a restore: what importJson(text) would do, without writing anything. */
export type BackupPreview = { ok: true; exportedAt: string | null; items: BackupPreviewItem[] } | { ok: false; error: string };

/** Settings page: backup / restore of all reader state as one JSON document. */
export interface BackupService {
  exportJson(): string;
  /** Validate + summarise a backup document without touching storage. */
  previewJson(text: string): BackupPreview;
  importJson(text: string): BackupResult;
}

// ------------------------------------------------------------------------------------------------
// Last visit + V1 import (WP7)
// ------------------------------------------------------------------------------------------------

export interface LastVisitState {
  /** Time of the reader's PREVIOUS visit - the "new since" cut-off; null on a first visit. */
  previousMs: number | null;
}

/**
 * The "new since your last visit" cut-off. Fixed for the session unless the reader marks all seen
 * or returns to an open tab after more than 30 minutes away (the cut-off then rolls to the last
 * edition shown).
 */
export interface LastVisitStore extends Store<LastVisitState> {
  /**
   * "Mark all seen": move the cut-off to the newest edition shown to the reader (build clock; nowMs
   * only when no edition was shown yet) and persist it (a reload does not bring the list back).
   */
  markAllSeen(nowMs: number): void;
  /**
   * Forget the previous visit (Settings > "Erase all reader data"): the stored record is removed and
   * previousMs becomes null, as on a first visit. The current session goes on being recorded.
   */
  clear(): void;
}

export type MigrationStatus =
  | "migrated" // V1 state found and imported; marker written
  | "already" // marker present: nothing read, nothing written
  | "nothing" // no V1 key on this origin: nothing written (a later V1 visit can still be imported)
  | "failed"; // storage refused a write: no marker, retried on the next load

/** How many V1 entries the import ADDED to the V2 state. */
export interface MigrationCounts {
  bookmarks: number;
  later: number;
  snapshots: number;
  /** V1 muted source names mapped to a SourceId. */
  mutedSources: number;
  /** V1 muted source names kept as pending (no SourceId known yet). */
  pendingSourceNames: number;
  mutedSections: number;
  /**
   * V1 muted category ids the import did NOT turn into a section mute (a V2 section is muted only
   * when every V1 category folded into it was muted; unknown ids are listed too). Absent or empty =
   * nothing was skipped. The Settings page names them so the reader can mute the section by hand.
   */
  skippedCategories?: readonly string[];
  seen: number;
  theme: boolean;
  lastVisit: boolean;
}

/** Outcome of the one-time, READ-ONLY import of V1 `ai-drudge:*` reader state. */
export interface MigrationReport {
  status: MigrationStatus;
  imported: MigrationCounts;
  /** ISO time the import ran ("migrated" / "already" with a readable marker). */
  at?: string;
}

// ------------------------------------------------------------------------------------------------
// Shell stores (WP8)
// ------------------------------------------------------------------------------------------------

export interface HoverState {
  /** The STORY key of the hovered row (the pipeline's lead id; the card resolves what to display). */
  id: ArticleId;
  /** Viewport coordinates to anchor the card to. */
  x: number;
  y: number;
}

/** Desktop hover card (a nicety - summaries are always reachable by keyboard and touch too). */
export interface HoverStore extends Store<HoverState | null> {
  show(id: ArticleId, x: number, y: number): void;
  /** Hide after the grace delay (200 ms) so the pointer can travel into the card. */
  hide(): void;
  /** Cancel a pending hide (pointer entered the card). */
  hold(): void;
}

/** Keyboard focus: the article id of the row the j/k cursor is on (rows expose data-aid). */
export interface FocusStore extends Store<ArticleId | null> {
  set(id: ArticleId | null): void;
}

// ------------------------------------------------------------------------------------------------
// Keyboard row actions (keyboard layer -> headline row)
// ------------------------------------------------------------------------------------------------

/**
 * CustomEvent the keyboard layer dispatches ON THE CURSOR ROW's root element ([data-aid]); it
 * bubbles to document and is cancelable. Delivery is three steps, the first that applies wins
 * (src/keyboard/rowActions.ts deliverRowAction): (1) this event - a listener that performs the
 * action calls preventDefault(); (2) the row's `[data-row-action="<action>"]` control is clicked;
 * (3) the shell default (open = click the row's `a[data-row-link]`; bookmark / later / mute through
 * the stores for an article in the edition; summary / also have none).
 */
export const ROW_ACTION_EVENT = "aid:row-action";
/** The actions the keyboard layer sends (o/Enter, b, l, s, a, m). */
export const ROW_ACTIONS = ["open", "bookmark", "later", "summary", "also", "mute"] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface RowActionDetail<El = HTMLElement> {
  id: ArticleId;
  action: RowAction;
  /** The row element the cursor is on (the element the event is dispatched on). */
  el: El;
}

// ------------------------------------------------------------------------------------------------
// UI slots (WP9 provides, everyone consumes)
// ------------------------------------------------------------------------------------------------

/** Minimal displayable record for a row whose article is NOT in the edition (river item, saved snapshot). */
export interface RowItem {
  id: ArticleId;
  title: string;
  url: string;
  sourceName: string;
  sourceId?: SourceId;
  publishedAt: string | null;
  firstSeenAt?: string | null;
  section?: SectionId;
}

export interface HeadlineRowProps {
  /** Article id. Looked up in the edition first; `item` is the fallback. */
  id: ArticleId;
  /** Fallback data when the id is not in the edition (river rows, saved snapshots). */
  item?: RowItem;
  /**
   * "default": section row. "compact": dense one-liner (latest strip, river lists).
   * "saved": saved pages (shows remove). "top": TOP STORIES row with the inline "Also:" line.
   */
  variant?: "default" | "compact" | "saved" | "top";
  /** Show the section label chip (search / new / watch results). */
  showSection?: boolean;
  /** Called after the reader opens the link (e.g. consume read-later). */
  onOpen?: () => void;
}

export interface UiSlots {
  HeadlineRow: ComponentType<HeadlineRowProps>;
}

// ------------------------------------------------------------------------------------------------
// AppServices + context
// ------------------------------------------------------------------------------------------------

/** Whether the reader's changes reach localStorage. */
export interface PersistenceState {
  /**
   * True from the first change of this page load that the browser did not keep: a refused write
   * (quota exceeded, storage disabled mid-session), or any change while localStorage is not
   * available at all and an in-memory stand-in is used. Never goes back to false: what was not
   * saved stays unsaved.
   */
  writeRefused: boolean;
}

export interface AppServices {
  edition: EditionStore;
  sourcesData: SourcesStore;
  saved: SavedStore;
  mutes: MutesStore;
  readState: ReadStateStore;
  settings: SettingsStore;
  watchlist: WatchlistStore;
  backup: BackupService;
  hover: HoverStore;
  focus: FocusStore;
  router: Router;
  /** Epoch ms "now", ticking once a minute (relative times, "updated Xm ago"). Frozen in tests. */
  clock: Store<number>;
  /** Time of the reader's PREVIOUS visit ("new since" cut-off); `markAllSeen` moves it. */
  lastVisit: LastVisitStore;
  /** Outcome of the one-time V1 import that ran when the services were created. */
  migration: MigrationReport;
  /** Run the V1 import again on request (Settings); reads V1 keys only, replaces the imported V2 state. */
  reimportV1(): MigrationReport;
  /** Site base URL ending in "/" (import.meta.env.BASE_URL) for data, feed.xml and feeds.opml links. */
  baseUrl: string;
  ui: UiSlots;
  /**
   * The shell's "changes are not being saved" notice reads this. Optional: a services object
   * without it (test fakes) means "saving works" and the notice never shows.
   */
  persistence?: Store<PersistenceState>;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("useServices: no <ServicesContext.Provider> above this component");
  return s;
}

/** Current edition state (re-renders on every edition change). */
export function useEditionState(): EditionState {
  return useStore(useServices().edition);
}

/** Ticking "now" in epoch ms (re-renders once a minute). */
export function useNow(): number {
  return useStore(useServices().clock);
}

// ------------------------------------------------------------------------------------------------
// Storage keys (single place to spell them; WP7 owns reads/writes)
// ------------------------------------------------------------------------------------------------

export const STORAGE_PREFIX = "aid2:";

/** localStorage keys. */
export const STORAGE_KEYS = {
  saved: "aid2:saved",
  mutes: "aid2:mutes",
  seen: "aid2:seen",
  settings: "aid2:settings",
  watchlist: "aid2:watchlist",
  lastVisit: "aid2:lastVisit",
  migratedFromV1: "aid2:migratedFromV1",
} as const;

/** sessionStorage keys (guarded payload cache). */
export const CACHE_KEYS = {
  front: "aid2:cache:front",
  rest: "aid2:cache:rest",
  river: "aid2:cache:river",
  brief: "aid2:cache:brief",
  stocks: "aid2:cache:stocks",
} as const;

/** V1 localStorage keys: READ ONCE by migrateV1, NEVER written (V1 and V2 may share an origin). */
export const V1_STORAGE_KEYS = {
  bookmarks: "ai-drudge:bookmarks",
  readLater: "ai-drudge:read-later",
  snapshots: "ai-drudge:article-snapshots",
  mutedSources: "ai-drudge:muted-sources",
  mutedCategories: "ai-drudge:muted-categories",
  seen: "ai-drudge:seen-articles",
  theme: "ai-drudge:theme-ft",
  lastVisit: "ai-drudge:last-visit",
} as const;

/** Auto-refresh period while the tab is visible. */
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/**
 * FALLBACK stale banner threshold (hours since generatedAt). The threshold in use is status.json
 * `staleAfterMinutes` (EditionState.staleAfterMinutes, read through `staleThresholdHours`); this
 * constant applies until status.json has loaded and when its value is outside 30 min .. 24 h.
 * Two hours is four missed 30-minute builds.
 */
export const STALE_BANNER_HOURS = 2;
/** Seen-dimming LRU size. */
export const SEEN_LIMIT = 500;
