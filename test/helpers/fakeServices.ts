// In-memory AppServices for UI packages (WP8..WP10) and their tests. Backed by the committed v2
// fixture by default; no network, no localStorage, no window. PURE: imports only shared/, src/app
// and JSON - so it also runs in a browser bundle.
//
//   const services = createFakeServices();                       // complete fixture edition
//   const services = createFakeServices({ loaded: "front" });    // homepage rows only; loadRest() completes it
//   services.calls                                               // ["router.go #/s/models", "saved.toggleBookmark 1abc", ...]
//   services.setNow(ms)                                          // move the clock
//
// Behaviour is real where it is cheap (saved / mutes / settings / watchlist / router / focus are
// working in-memory stores); persistence, migration, timers and observers are NOT simulated.

import { createElement, type ComponentType } from "react";
import type { ArticleId, ArticleV2, BriefFile, EditionFront, EditionRest, HealthFile, RiverFile, SourcesFile, StocksFile } from "../../shared/contract";
import { isSectionId, type SectionId } from "../../shared/sections";
import { mergeEdition } from "../../shared/select";
import { NO_TERMS, compileTerms, type TermMatcher } from "../../shared/text";
import { staleHours } from "../../shared/time";
import { SECTION_PRESETS, WATCH_PRESETS } from "../../src/app/presets";
import {
  DEFAULT_SETTINGS,
  createStore,
  useServices,
  useStore,
  type AppServices,
  type BackupPreview,
  type BackupResult,
  type EditionState,
  type HeadlineRowProps,
  type HoverState,
  type LastVisitState,
  type MigrationReport,
  type MutesState,
  type PersistenceState,
  type Route,
  type SavedState,
  type SavedTab,
  type Settings,
  type SourcesState,
  type UiSlots,
  type WatchlistState,
  type WritableStore,
} from "../../src/app/services";
import { fixtureBrief, fixtureFront, fixtureHealth, fixtureRest, fixtureRiver, fixtureSources, fixtureStocks } from "./fixtureData";

export interface FakeServicesOptions {
  front?: EditionFront;
  rest?: EditionRest;
  river?: RiverFile;
  brief?: BriefFile | null;
  stocks?: StocksFile | null;
  sources?: SourcesFile;
  health?: HealthFile;
  /**
   * Initial edition state: "complete" (default; front + rest merged), "front" (rest arrives on
   * loadRest()), "loading" (nothing until refresh()), "error".
   */
  loaded?: "complete" | "front" | "loading" | "error";
  /** Clock. Default: 20 minutes after the edition's generatedAt. */
  nowMs?: number;
  route?: Route;
  /** Reader's previous visit. Default: 6 hours before `nowMs`. Pass null for a first visit. */
  previousVisitMs?: number | null;
  settings?: Partial<Settings>;
  watchTerms?: readonly string[];
  mutedSources?: readonly string[];
  mutedSections?: readonly SectionId[];
  /** V1 muted source names not matched to a source yet. */
  pendingMuteNames?: readonly string[];
  /** Outcome of the V1 import to report. Default: status "nothing". */
  migration?: MigrationReport;
  bookmarks?: readonly ArticleId[];
  later?: readonly ArticleId[];
  /** Ids reported as seen in a previous session. */
  seen?: readonly ArticleId[];
  ui?: Partial<UiSlots>;
  baseUrl?: string;
  /** status.json staleAfterMinutes as the edition store would publish it. Default: absent (not loaded). */
  staleAfterMinutes?: number;
  /** The browser refused to keep a change (the shell's "not saving" notice). Default false. */
  writeRefused?: boolean;
}

export interface FakeServices extends AppServices {
  /** Log of every mutating / loading call, e.g. "edition.loadRest", "router.go #/s/models". */
  calls: string[];
  /** Move the clock (notifies clock subscribers). */
  setNow(ms: number): void;
  /** Direct access to the underlying writable stores for arranging test states. */
  stores: {
    edition: WritableStore<EditionState>;
    sourcesData: WritableStore<SourcesState>;
    saved: WritableStore<SavedState>;
    mutes: WritableStore<MutesState>;
    lastVisit: WritableStore<LastVisitState>;
    settings: WritableStore<Settings>;
    watchlist: WritableStore<WatchlistState>;
    hover: WritableStore<HoverState | null>;
    focus: WritableStore<ArticleId | null>;
    router: WritableStore<Route>;
    clock: WritableStore<number>;
    persistence: WritableStore<PersistenceState>;
  };
}

/** Canonical hash of a route (same format the real router must produce - see services.ts Route). */
export function fakeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "section":
      return `#/s/${route.id}`;
    case "search":
      return `#/q/${encodeURIComponent(route.q)}`;
    case "saved":
      return route.tab === "later" ? "#/later" : "#/saved";
    default:
      return `#/${route.name}`;
  }
}

/** Inverse of fakeHref; unknown hashes resolve to home. */
export function fakeParseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const [, a, ...rest] = h.split("/");
  const b = rest.join("/");
  if (a === "s" && isSectionId(b)) return { name: "section", id: b };
  if (a === "q") {
    try {
      return { name: "search", q: decodeURIComponent(b) };
    } catch {
      return { name: "search", q: b };
    }
  }
  if (a === "saved") return { name: "saved", tab: "bookmarks" };
  if (a === "later") return { name: "saved", tab: "later" };
  if (a === "new" || a === "watch" || a === "sources" || a === "settings" || a === "about") return { name: a };
  return { name: "home" };
}

/** Placeholder HeadlineRow (the real one is src/features/headline): a link with data-aid, no styling. */
const FakeHeadlineRow: ComponentType<HeadlineRowProps> = ({ id, item, onOpen }) => {
  const services = useServices();
  const state = useStore(services.edition);
  const a = state.edition?.articles[id];
  const title = a?.title ?? item?.title ?? id;
  const url = a?.url ?? item?.url ?? "#";
  return createElement("div", { "data-aid": id, className: "headline-row" }, createElement("a", { href: url, rel: "noopener noreferrer", onClick: onOpen }, title));
};

export function createFakeServices(opts: FakeServicesOptions = {}): FakeServices {
  const calls: string[] = [];
  const front = opts.front ?? fixtureFront;
  const rest = opts.rest ?? fixtureRest;
  const river = opts.river ?? fixtureRiver;
  const brief = opts.brief === undefined ? fixtureBrief : opts.brief;
  const stocks = opts.stocks === undefined ? fixtureStocks : opts.stocks;
  const generatedMs = Date.parse(front.generatedAt);
  const nowMs = opts.nowMs ?? generatedMs + 20 * 60_000;
  const loaded = opts.loaded ?? "complete";
  const clockStore = createStore<number>(nowMs);

  // ---- edition
  const base: EditionState = {
    status: "loading",
    edition: null,
    brief: null,
    stocks: null,
    river: null,
    riverStatus: "idle",
    restStatus: "idle",
    fetchedAtMs: null,
    outdatedClient: false,
    ...(opts.staleAfterMinutes === undefined ? {} : { staleAfterMinutes: opts.staleAfterMinutes }),
  };
  const withFront = (complete: boolean): EditionState => ({
    ...base,
    status: complete ? "complete" : "front",
    restStatus: complete ? "ready" : "idle",
    edition: mergeEdition(front, complete ? rest : null),
    brief,
    stocks,
    fetchedAtMs: nowMs,
  });
  const initialEdition: EditionState =
    loaded === "complete" ? withFront(true) : loaded === "front" ? withFront(false) : loaded === "error" ? { ...base, status: "error", error: "Failed to load headlines." } : base;
  const editionStore = createStore<EditionState>(initialEdition);
  const edition: AppServices["edition"] = {
    get: editionStore.get,
    subscribe: editionStore.subscribe,
    loadRest: async () => {
      calls.push("edition.loadRest");
      const s = editionStore.get();
      if (s.status === "complete") return;
      editionStore.set({ ...withFront(true), river: s.river, riverStatus: s.riverStatus });
    },
    loadRiver: async () => {
      calls.push("edition.loadRiver");
      const s = editionStore.get();
      if (s.riverStatus === "ready") return;
      editionStore.set({ ...s, river, riverStatus: "ready" });
    },
    refresh: async () => {
      calls.push("edition.refresh");
      const s = editionStore.get();
      const complete = s.status === "complete" || loaded === "complete";
      editionStore.set({ ...withFront(complete), river: s.river, riverStatus: s.riverStatus });
    },
    staleHours: (now) => staleHours(editionStore.get().edition?.meta.generatedAt, now),
  };

  // ---- sources page data
  const sourcesStore = createStore<SourcesState>({ status: "idle", sources: null, health: null });
  const sourcesData: AppServices["sourcesData"] = {
    get: sourcesStore.get,
    subscribe: sourcesStore.subscribe,
    load: async () => {
      calls.push("sourcesData.load");
      sourcesStore.set({ status: "ready", sources: opts.sources ?? fixtureSources, health: opts.health ?? fixtureHealth });
    },
  };

  // ---- saved
  const savedStore = createStore<SavedState>({ bookmarks: new Set(opts.bookmarks ?? []), later: new Set(opts.later ?? []), snapshots: {} });
  const toggleSaved = (tab: SavedTab, a: ArticleV2, sourceName: string): void => {
    calls.push(`saved.${tab === "bookmarks" ? "toggleBookmark" : "toggleLater"} ${a.id}`);
    savedStore.update((s) => {
      const set = new Set(s[tab]);
      const snapshots = { ...s.snapshots };
      if (set.has(a.id)) set.delete(a.id);
      else {
        set.add(a.id);
        snapshots[a.id] = { id: a.id, title: a.title, url: a.url, sourceName, publishedAt: a.publishedAt, savedAt: new Date(clockStore.get()).toISOString() };
      }
      return { ...s, [tab]: set, snapshots };
    });
  };
  const removeSaved = (tab: SavedTab, id: ArticleId): void => {
    savedStore.update((s) => {
      if (!s[tab].has(id)) return s;
      const set = new Set(s[tab]);
      set.delete(id);
      return { ...s, [tab]: set };
    });
  };
  const saved: AppServices["saved"] = {
    get: savedStore.get,
    subscribe: savedStore.subscribe,
    toggleBookmark: (a, name) => toggleSaved("bookmarks", a, name),
    toggleLater: (a, name) => toggleSaved("later", a, name),
    consume: (id) => {
      calls.push(`saved.consume ${id}`);
      removeSaved("later", id);
    },
    remove: (tab, id) => {
      calls.push(`saved.remove ${tab} ${id}`);
      removeSaved(tab, id);
    },
    clear: (tab) => {
      calls.push(`saved.clear ${tab}`);
      savedStore.update((s) => ({ ...s, [tab]: new Set<ArticleId>() }));
    },
  };

  // ---- mutes
  const mutesStore = createStore<MutesState>({ sources: new Set(opts.mutedSources ?? []), sections: new Set(opts.mutedSections ?? []), pendingNames: [...(opts.pendingMuteNames ?? [])] });
  const flip = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };
  const mutes: AppServices["mutes"] = {
    get: mutesStore.get,
    subscribe: mutesStore.subscribe,
    toggleSource: (id) => {
      calls.push(`mutes.toggleSource ${id}`);
      mutesStore.update((m) => ({ ...m, sources: flip(m.sources, id) }));
    },
    toggleSection: (id) => {
      calls.push(`mutes.toggleSection ${id}`);
      mutesStore.update((m) => ({ ...m, sections: flip(m.sections, id) }));
    },
    dropPendingName: (name) => {
      calls.push(`mutes.dropPendingName ${name}`);
      mutesStore.update((m) => ({ ...m, pendingNames: m.pendingNames.filter((n) => n !== name) }));
    },
    clear: () => {
      calls.push("mutes.clear");
      mutesStore.set({ sources: new Set(), sections: new Set(), pendingNames: [] });
    },
  };

  // ---- read state
  const seenBefore = new Set(opts.seen ?? []);
  const readState: AppServices["readState"] = {
    wasSeen: (id) => seenBefore.has(id),
    observe: () => undefined,
    markSeen: (id) => void calls.push(`readState.markSeen ${id}`),
    clear: () => {
      calls.push("readState.clear");
      seenBefore.clear();
    },
  };

  // ---- settings
  const settingsStore = createStore<Settings>({ ...DEFAULT_SETTINGS, ...opts.settings });
  const settings: AppServices["settings"] = {
    get: settingsStore.get,
    subscribe: settingsStore.subscribe,
    set: (key, value) => {
      calls.push(`settings.set ${String(key)}`);
      settingsStore.update((s) => ({ ...s, [key]: value }));
    },
    patch: (partial) => {
      calls.push(`settings.patch ${Object.keys(partial).join(",")}`);
      settingsStore.update((s) => ({ ...s, ...partial }));
    },
    reset: () => {
      calls.push("settings.reset");
      settingsStore.set({ ...DEFAULT_SETTINGS });
    },
  };

  // ---- watchlist
  const watchStore = createStore<WatchlistState>({ terms: [...(opts.watchTerms ?? [])] });
  let compiledFor: readonly string[] | null = null;
  let compiled: TermMatcher = NO_TERMS;
  const addTerms = (terms: readonly string[]): void => {
    watchStore.update((s) => {
      const have = new Set(s.terms.map((t) => t.toLowerCase()));
      const next = [...s.terms];
      for (const raw of terms) {
        const t = raw.trim().replace(/\s+/g, " ");
        if (!t || have.has(t.toLowerCase())) continue;
        have.add(t.toLowerCase());
        next.push(t);
      }
      return next.length === s.terms.length ? s : { terms: next };
    });
  };
  const watchlist: AppServices["watchlist"] = {
    get: watchStore.get,
    subscribe: watchStore.subscribe,
    add: (term) => {
      calls.push(`watchlist.add ${term}`);
      addTerms([term]);
    },
    remove: (term) => {
      calls.push(`watchlist.remove ${term}`);
      watchStore.update((s) => ({ terms: s.terms.filter((t) => t.toLowerCase() !== term.trim().toLowerCase()) }));
    },
    addPreset: (id) => {
      calls.push(`watchlist.addPreset ${id}`);
      addTerms(WATCH_PRESETS.find((p) => p.id === id)?.terms ?? []);
    },
    clear: () => {
      calls.push("watchlist.clear");
      watchStore.set({ terms: [] });
    },
    matcher: () => {
      const terms = watchStore.get().terms;
      if (terms !== compiledFor) {
        compiledFor = terms;
        compiled = terms.length ? compileTerms(terms, { plural: true }) : NO_TERMS;
      }
      return compiled;
    },
    presets: WATCH_PRESETS,
  };

  // ---- backup
  const backup: AppServices["backup"] = {
    exportJson: () => {
      calls.push("backup.exportJson");
      const s = savedStore.get();
      const m = mutesStore.get();
      return JSON.stringify({
        app: "ai-drudge",
        v: 2,
        saved: { bookmarks: [...s.bookmarks], later: [...s.later], snapshots: s.snapshots },
        mutes: { sources: [...m.sources], sections: [...m.sections] },
        settings: settingsStore.get(),
        watchlist: watchStore.get().terms,
      });
    },
    previewJson: (text): BackupPreview => {
      calls.push("backup.previewJson");
      try {
        const data: unknown = JSON.parse(text);
        if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, error: "Not a backup file." };
        const items = Object.keys(data)
          .filter((key) => key !== "app" && key !== "v")
          .map((key) => ({ key, label: key, action: "replace" as const, detail: "" }));
        return { ok: true, exportedAt: null, items };
      } catch {
        return { ok: false, error: "Not valid JSON." };
      }
    },
    importJson: (text): BackupResult => {
      calls.push("backup.importJson");
      try {
        const data: unknown = JSON.parse(text);
        if (typeof data !== "object" || data === null) return { ok: false, error: "Not a backup file." };
        return { ok: true, restored: Object.keys(data) };
      } catch {
        return { ok: false, error: "Not valid JSON." };
      }
    },
  };

  // ---- shell stores
  const hoverStore = createStore<HoverState | null>(null);
  const hover: AppServices["hover"] = {
    get: hoverStore.get,
    subscribe: hoverStore.subscribe,
    show: (id, x, y) => hoverStore.set({ id, x, y }),
    hide: () => hoverStore.set(null),
    hold: () => undefined,
  };
  const focusStore = createStore<ArticleId | null>(null);
  const focus: AppServices["focus"] = { get: focusStore.get, subscribe: focusStore.subscribe, set: focusStore.set };
  const routeStore = createStore<Route>(opts.route ?? { name: "home" });
  const router: AppServices["router"] = {
    get: routeStore.get,
    subscribe: routeStore.subscribe,
    go: (route) => {
      calls.push(`router.go ${fakeHref(route)}`);
      routeStore.set(route);
    },
    href: fakeHref,
  };
  // ---- last visit + V1 import
  const lastVisitStore = createStore<LastVisitState>({ previousMs: opts.previousVisitMs === undefined ? nowMs - 6 * 3_600_000 : opts.previousVisitMs });
  const lastVisit: AppServices["lastVisit"] = {
    get: lastVisitStore.get,
    subscribe: lastVisitStore.subscribe,
    markAllSeen: (ms) => {
      calls.push("lastVisit.markAllSeen");
      lastVisitStore.set({ previousMs: ms });
    },
    clear: () => {
      calls.push("lastVisit.clear");
      lastVisitStore.set({ previousMs: null });
    },
  };
  const migration: MigrationReport = opts.migration ?? {
    status: "nothing",
    imported: { bookmarks: 0, later: 0, snapshots: 0, mutedSources: 0, pendingSourceNames: 0, mutedSections: 0, seen: 0, theme: false, lastVisit: false },
  };

  const persistenceStore = createStore<PersistenceState>({ writeRefused: opts.writeRefused === true });

  return {
    edition,
    sourcesData,
    saved,
    mutes,
    readState,
    settings,
    watchlist,
    backup,
    hover,
    focus,
    router,
    clock: { get: clockStore.get, subscribe: clockStore.subscribe },
    lastVisit,
    migration,
    reimportV1: () => {
      calls.push("reimportV1");
      return migration;
    },
    baseUrl: opts.baseUrl ?? "/ai-drudge-v2/",
    ui: { HeadlineRow: FakeHeadlineRow, ...opts.ui },
    persistence: { get: persistenceStore.get, subscribe: persistenceStore.subscribe },
    calls,
    setNow: (ms) => clockStore.set(ms),
    stores: {
      edition: editionStore,
      sourcesData: sourcesStore,
      saved: savedStore,
      mutes: mutesStore,
      lastVisit: lastVisitStore,
      settings: settingsStore,
      watchlist: watchStore,
      hover: hoverStore,
      focus: focusStore,
      router: routeStore,
      clock: clockStore,
      persistence: persistenceStore,
    },
  };
}

/** Section presets re-exported for convenience in UI tests. */
export { SECTION_PRESETS, WATCH_PRESETS };
