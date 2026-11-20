// The application shell: everything around the page.
//
//   skip link -> sticky masthead (h1, count + "updated Xm ago", toolbar) -> search -> section chips
//   -> time chips (front page and #/new only) -> stock ticker -> banners -> <main id="main"> (route
//   outlet) -> footer -> shortcuts dialog, hover card, mute notice ("Muted <source> · Undo") -> polite
//   status region
//
// The keyboard layer, the shortcuts dialog, the hover card and the mute notice are ONE lazy chunk
// (./ShellInteractions) fetched right after the first commit: none of them paints before the reader
// acts, so they are not part of the entry bundle.
//
// Requires a <ServicesContext.Provider> above it. Renders the RouteModule of the current route;
// pages are discovered by routeRegistry (src/features/<route name>/route.tsx).

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { routeRegistry, type RouteRegistry } from "./routeRegistry";
import { HOME, pageAnnouncement, pageKey } from "./routes";
import { useServices, useStore } from "./services";
import type { ShellInteractionsProps } from "./ShellInteractions";
import { Banners } from "../features/chrome/Banners";
import { Footer } from "../features/chrome/Footer";
import { useAutoRefresh, useDocumentAppearance, usePageScroll, useResolvedTheme, useStickyOffsets } from "../features/chrome/hooks";
import { MAIN_ID } from "../features/chrome/ids";
import { Masthead } from "../features/chrome/Masthead";
import { retryableLoader, shortcutsEnabled, showsTimeChips } from "../features/chrome/model";
import { RouteOutlet } from "../features/chrome/RouteOutlet";
import { SearchBox } from "../features/chrome/SearchBox";
import { SectionNav, TimeChips } from "../features/chrome/SectionNav";
import { SkipLink } from "../features/chrome/SkipLink";
import { StockTicker } from "../features/chrome/StockTicker";

export type ShellInteractionsComponent = ComponentType<ShellInteractionsProps>;

export interface AppShellProps {
  /** Pages to render. Default: the registry discovered from src/features/<name>/route.tsx. */
  routes?: RouteRegistry;
  /** Footer version. Default: APP_VERSION. */
  version?: string;
  /**
   * Let the SHELL call edition.refresh() every REFRESH_INTERVAL_MS while the tab is visible.
   * Default false: the real EditionStore (src/data) schedules its own refresh, and two schedulers
   * would fetch twice. Turn it on only for a store that does not.
   */
  autoRefresh?: boolean;
  /** Keyboard layer (default true). The reader's own switch is the `shortcuts` setting. */
  keyboard?: boolean;
  /**
   * The interactions layer (keyboard, shortcuts dialog, hover card, mute notice). Default: the
   * ./ShellInteractions chunk, fetched after the first commit. Pass the component to have it in the
   * first render (server-render tests), or null for a shell without it.
   */
  interactions?: ShellInteractionsComponent | null;
}

const HOME_PAGE = pageKey(HOME);

/** How long after mount the remaining page chunks are fetched, when the browser has no idle callback. */
const PRELOAD_DELAY_MS = 2500;

/**
 * Fetch every lazy page chunk once the first paint is out of the way, so the first visit to a
 * section, the search results or NEW does not swap the page for "Loading…" (only the five masthead
 * links preload on hover). Skipped for readers who asked for reduced data use.
 * Returns the cancel function.
 */
export function preloadPagesWhenIdle(routes: Pick<RouteRegistry, "names" | "preload">, host: IdleHost | null = typeof window === "undefined" ? null : window): () => void {
  const connection = (host?.navigator as { connection?: { saveData?: boolean } } | undefined)?.connection;
  if (!host || connection?.saveData === true) return () => undefined;
  const run = (): void => {
    for (const name of routes.names()) routes.preload(name);
  };
  if (typeof host.requestIdleCallback === "function" && typeof host.cancelIdleCallback === "function") {
    const handle = host.requestIdleCallback(run, { timeout: 2 * PRELOAD_DELAY_MS });
    return () => host.cancelIdleCallback?.(handle);
  }
  const timer = host.setTimeout(run, PRELOAD_DELAY_MS);
  return () => host.clearTimeout(timer);
}

// Loaded in an effect rather than through React.lazy: a failed chunk (offline, a deploy replaced the
// hashed file) must leave the page alone and be retryable, never reach the app-level error boundary.
const loadShellInteractions = retryableLoader(() => import("./ShellInteractions").then((mod) => mod.default));

/** DOM events that mean the reader is reaching for the interactions layer: a failed download is retried on them. */
export const INTERACTION_RETRY_EVENTS = ["keydown", "pointerover"] as const;

/** Least time between two event-triggered retries: an offline tab must not start a download per mouse move. */
export const INTERACTION_RETRY_GAP_MS = 5_000;

/** The slice of `document` the retry listeners need (structural, so it is tested under node). */
export interface InteractionEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface InteractionsLoadOptions<T> {
  load: () => Promise<T>;
  /** Called once, with the layer. */
  onLoaded: (layer: T) => void;
  /** Called after every failed attempt. */
  onFailed?: () => void;
  /** `document` (null: no event-triggered retries). */
  target: InteractionEventTarget | null;
  /** Clock, epoch ms (default Date.now). */
  now?: () => number;
}

/**
 * Fetch the interactions layer now and hand it to `onLoaded` once. If the download fails, try again
 * when the reader presses a key or moves the pointer over something - at most once per
 * INTERACTION_RETRY_GAP_MS, and never on a timer, so an offline tab does not poll - and whenever
 * `retry()` is called (an explicit request: no gap). Returns { retry, cancel }.
 */
export function loadInteractionsLayer<T>({ load, onLoaded, onFailed, target, now = Date.now }: InteractionsLoadOptions<T>): { retry: () => void; cancel: () => void } {
  let live = true;
  let done = false;
  let pending = false;
  let failedAt: number | null = null;
  const attempt = (): void => {
    if (!live || done || pending) return;
    pending = true;
    load().then(
      (layer) => {
        pending = false;
        if (!live || done) return;
        done = true;
        stopListening();
        onLoaded(layer);
      },
      () => {
        pending = false;
        failedAt = now();
        if (live) onFailed?.();
      },
    );
  };
  const onEvent = (): void => {
    if (failedAt !== null && now() - failedAt < INTERACTION_RETRY_GAP_MS) return;
    attempt();
  };
  const stopListening = (): void => {
    for (const type of INTERACTION_RETRY_EVENTS) target?.removeEventListener(type, onEvent);
  };
  for (const type of INTERACTION_RETRY_EVENTS) target?.addEventListener(type, onEvent);
  attempt();
  return {
    retry: attempt,
    cancel: () => {
      live = false;
      stopListening();
    },
  };
}

/**
 * The interactions layer for the shell: `preset` as given (a component, or null for none), else the
 * lazy chunk once it has arrived (null until then). `retry` asks for the chunk again after a failure;
 * `onFailed` hears of every failed download.
 */
function useShellInteractions(preset: ShellInteractionsComponent | null | undefined, onFailed: () => void): { Interactions: ShellInteractionsComponent | null; retry: () => void } {
  const [loaded, setLoaded] = useState<ShellInteractionsComponent | null>(null);
  const retryRef = useRef<() => void>(() => undefined);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  useEffect(() => {
    if (preset !== undefined) return;
    const handle = loadInteractionsLayer({
      load: loadShellInteractions,
      // Function form: a component must not be mistaken for a state updater.
      onLoaded: (layer) => setLoaded(() => layer),
      onFailed: () => onFailedRef.current(),
      target: typeof document === "undefined" ? null : document,
    });
    retryRef.current = handle.retry;
    return handle.cancel;
  }, [preset]);
  const retry = useCallback(() => retryRef.current(), []);
  return { Interactions: preset !== undefined ? preset : loaded, retry };
}

/** The slice of `window` preloadPagesWhenIdle needs (structural, so it is tested under node). */
export interface IdleHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** navigator.connection.saveData (where the browser has it) turns the preload off. */
  navigator?: object;
}

function Shell({ routes = routeRegistry, version, autoRefresh = false, keyboard = true, interactions }: AppShellProps) {
  const services = useServices();
  const { router, settings, edition } = services;
  const route = useStore(router);
  const theme = useStore(settings, (s) => s.theme);
  const density = useStore(settings, (s) => s.density);
  // The reader's off switch for single-key shortcuts (WCAG 2.1.4). Escape keeps working.
  const shortcuts = useStore(settings, shortcutsEnabled);
  const [helpOpen, setHelpOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // The shortcuts dialog was asked for (footer button) before its chunk arrived, and the download
  // failed: say so and forget the request, or the dialog would pop open minutes later by itself.
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const onInteractionsFailed = useCallback(() => {
    if (!helpOpenRef.current) return;
    setHelpOpen(false);
    setAnnouncement("Keyboard shortcuts could not be loaded. Try again.");
  }, []);
  const { Interactions, retry: retryInteractions } = useShellInteractions(interactions, onInteractionsFailed);
  const mastheadRef = useRef<HTMLElement>(null);
  const subchromeRef = useRef<HTMLDivElement>(null);

  useDocumentAppearance(useResolvedTheme(theme), density);
  useStickyOffsets(mastheadRef, subchromeRef);
  useAutoRefresh(services, autoRefresh);

  useEffect(() => preloadPagesWhenIdle(routes), [routes]);
  // Focus in the search box: fetch the results page and the 7-day archive while the reader types.
  const onSearchIntent = useCallback(() => {
    routes.preload("search");
    edition.loadRiver().catch(() => undefined);
  }, [routes, edition]);

  // A new page is announced and starts at the top (the front page: where you left it); refining a
  // search stays on the same page and does neither.
  const page = pageKey(route);
  usePageScroll(page, (p) => p === HOME_PAGE);
  const announcedPage = useRef(page);
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    if (announcedPage.current === page) return;
    announcedPage.current = page;
    setAnnouncement(pageAnnouncement(routeRef.current));
  }, [page]);

  // The dialog lives in the interactions chunk. The request is remembered (helpOpen), so the dialog
  // opens as soon as the chunk is there; after a failed download this click asks for it again.
  const showShortcuts = useCallback(() => {
    setHelpOpen(true);
    retryInteractions();
  }, [retryInteractions]);

  return (
    <div className="app-shell">
      <SkipLink />
      <Masthead headerRef={mastheadRef} onPreload={routes.preload} />
      <div className="subchrome" ref={subchromeRef}>
        <div className="control-row">
          <SearchBox onIntent={onSearchIntent} />
        </div>
        <div className="control-row chip-row">
          <SectionNav />
          {/* Only where they act: a section page has its own group, the other pages have no time window. */}
          {showsTimeChips(route) && <TimeChips />}
        </div>
      </div>
      <StockTicker />
      <div className="desk">
        <Banners />
        <main id={MAIN_ID} tabIndex={-1}>
          <RouteOutlet route={route} registry={routes} />
        </main>
        <Footer version={version} onShowShortcuts={showShortcuts} />
      </div>
      {/* Keyboard layer, shortcuts dialog, hover card, mute notice: their own chunk (see the header). */}
      {Interactions && <Interactions keyboard={keyboard} shortcuts={shortcuts} helpOpen={helpOpen} setHelpOpen={setHelpOpen} announce={setAnnouncement} />}
      {/* Polite announcements: page changes (a hash change reads nothing by itself), keyboard row actions, mutes. */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <ErrorBoundary scope="app">
      <Shell {...props} />
    </ErrorBoundary>
  );
}
