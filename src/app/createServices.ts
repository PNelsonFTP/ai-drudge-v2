// The one place the real services are put together (src/main.tsx calls it once, before createRoot).
//
//   reader state (V1 import -> last visit -> stores)   src/state
//   edition + sources data                             src/data
//   router, hover, keyboard focus, clock               src/app
//   UI slots                                           caller (main.tsx passes the real HeadlineRow)
//
// The order inside is the only correct one: createReaderState() runs the V1 import and reads the
// last visit BEFORE any store exists, so the first render already sees imported state. Nothing here
// imports CSS or a component, so the wiring is exercised under node (createServices.test.ts).

import { createEditionStore } from "../data/editionStore";
import { createSourcesStore } from "../data/sourcesStore";
import { browserEnv, createReaderState, isFallbackStorage, namedSourcesOfEdition, namedSourcesOfFile, namedSourcesOfRiver, wireStores, type BrowserEnv, type NamedSource } from "../state";
import { createClock, type ClockStore } from "./clock";
import { createFocusStore } from "./focusStore";
import { createHashRouter, type HashRouter } from "./hashRouter";
import { createHoverStore } from "./hoverStore";
import { createStore, type AppServices, type PersistenceState, type Store, type UiSlots } from "./services";

export interface CreateServicesOptions {
  /** Site base ending in "/" (import.meta.env.BASE_URL). */
  baseUrl: string;
  ui: UiSlots;
  /** The browser, with every access guarded (default browserEnv()). Tests pass fakes. */
  env?: BrowserEnv;
  /** Clock, epoch ms (default Date.now). */
  now?: () => number;
  router?: HashRouter;
  clock?: ClockStore;
  /** A storage write was refused (quota / private mode): the change lives in memory only. */
  onWriteError?: (key: string) => void;
}

export type { PersistenceState };

export interface Services extends AppServices {
  /** Always provided by the real wiring (AppServices leaves it optional for test fakes). */
  persistence: Store<PersistenceState>;
  /** Stop every timer and listener (tests, hot reload). The page itself never calls it. */
  dispose(): void;
}

/** The slice of `window` the frame check reads. */
export interface FrameWindow {
  readonly self: unknown;
  /** Reading `top.location.origin` throws when the top document is another origin. */
  readonly top: { readonly location: { readonly origin: string } } | null;
  readonly location: { readonly origin: string };
}

/**
 * True when the page runs inside a frame of ANOTHER origin. GitHub Pages cannot send
 * X-Frame-Options / frame-ancestors (and a <meta> CSP ignores frame-ancestors), so main.tsx refuses
 * to start the app there: one-click actions (bookmark, mute, clear) must not be drivable by an overlay.
 */
export function isFramedByAnotherSite(win: FrameWindow): boolean {
  try {
    if (win.top === win.self || win.top === null) return false;
    return win.top.location.origin !== win.location.origin;
  } catch {
    return true;
  }
}

/** "/ai-drudge-v2" -> "/ai-drudge-v2/"; "" -> "/". Data, feed.xml and feeds.opml links assume the slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim() || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export function createServices(opts: CreateServicesOptions): Services {
  const env = opts.env ?? browserEnv();
  const now = opts.now ?? Date.now;
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const persistence = createStore<PersistenceState>({ writeRefused: false });
  // One object: repeating the report is not a change, so subscribers hear of it once.
  const refused: PersistenceState = { writeRefused: true };
  const state = createReaderState({
    storage: env.local,
    events: env.events,
    now,
    root: env.root,
    matchMedia: env.matchMedia,
    onWriteError: (key) => {
      persistence.set(refused);
      opts.onWriteError?.(key);
    },
  });
  // No localStorage at all (blocked site data): every write "succeeds" into memory, so nothing is
  // ever reported as refused. The first change the reader makes is the moment to say so - not the
  // page load, which would nag readers who block storage on purpose and only read.
  const unwatchVolatile = isFallbackStorage(env.local)
    ? [state.saved, state.mutes, state.settings, state.watchlist].map((store) => store.subscribe(() => persistence.set(refused)))
    : [];
  // Starts fetching at creation and reads the session cache synchronously: on a return visit
  // edition.get() is already populated for the first render.
  const edition = createEditionStore({
    baseUrl,
    fetch: env.fetch,
    storage: env.session,
    now,
    visibility: env.visibility,
    connectivity: env.connectivity,
  });
  const sourcesData = createSourcesStore({ baseUrl, fetch: env.fetch });
  // Saved snapshots follow the edition, V1 mute names are resolved, the next visit's cut-off is recorded
  // (only for editions shown in a visible tab), the Sources page follows the edition to a new build.
  const unwire = wireStores({ edition, sourcesData, saved: state.saved, mutes: state.mutes, lastVisit: state.lastVisit, visibility: env.visibility, now });
  /** Every source name known right now: the registry (with aliases) when loaded, else edition + river. */
  const knownSources = (): NamedSource[] => {
    const file = sourcesData.get().sources;
    if (file) return namedSourcesOfFile(file);
    const s = edition.get();
    return [...(s.edition ? namedSourcesOfEdition(s.edition) : []), ...(s.river ? namedSourcesOfRiver(s.river) : [])];
  };
  env.onPageHide(() => state.readState.flush());

  const router = opts.router ?? createHashRouter();
  const clock = opts.clock ?? createClock();

  return {
    edition,
    sourcesData,
    saved: state.saved,
    mutes: state.mutes,
    readState: state.readState,
    settings: state.settings,
    watchlist: state.watchlist,
    backup: state.backup,
    lastVisit: state.lastVisit,
    migration: state.migration,
    // With the sources known by now, so re-imported mutes apply at once (names nobody knows yet are
    // parked as pending and resolved by wireStores).
    reimportV1: () => state.reimportV1(knownSources()),
    hover: createHoverStore(),
    focus: createFocusStore(),
    router,
    clock,
    baseUrl,
    ui: opts.ui,
    persistence: { get: persistence.get, subscribe: persistence.subscribe },
    dispose: () => {
      for (const stop of unwatchVolatile) stop();
      unwire();
      edition.dispose();
      state.dispose();
      router.dispose();
    },
  };
}
