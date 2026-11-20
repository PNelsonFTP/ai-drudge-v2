// Browser-facing hooks of the shell. Each one is inert during server rendering (no window).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { REFRESH_INTERVAL_MS, type AppServices, type Density, type Theme } from "../../app/services";
import { refreshDue, resolveTheme, scrollsSideways } from "./model";

const noopUnsubscribe = (): void => undefined;

/** Live result of a media query; `serverValue` during SSR and where matchMedia is missing. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  // Stable identity: useSyncExternalStore re-subscribes whenever `subscribe` changes.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!supported) return noopUnsubscribe;
      const mq = window.matchMedia(query);
      mq.addEventListener("change", listener);
      return () => mq.removeEventListener("change", listener);
    },
    [query, supported],
  );
  return useSyncExternalStore(
    subscribe,
    () => (supported ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

function subscribeOnline(listener: () => void): () => void {
  if (typeof window === "undefined") return noopUnsubscribe;
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

const readOnline = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

/** navigator.onLine as state (true during SSR). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, readOnline, () => true);
}

/** The theme actually shown ("system" follows the OS). */
export function useResolvedTheme(theme: Theme): "light" | "dark" {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  return resolveTheme(theme, prefersDark);
}

/**
 * Reflect theme and density on <html>: class "dark" | "light" (tokens.css) and data-density
 * (base.css). The HTML entry sets the same class before first paint, so there is no flash.
 */
export function useDocumentAppearance(resolved: "light" | "dark", density: Density): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("light", resolved === "light");
    root.dataset.density = density;
  }, [resolved, density]);
}

/**
 * Publish the height of the pinned chrome as CSS variables on <html>:
 *   --masthead-h  height of the sticky masthead (the silver rows stick right under it)
 *   --sticky-h    total height that stays pinned (scroll-padding-top, keyboard cursor, section jumps)
 * Measured, not guessed: the masthead wraps on narrow screens and grows with text zoom.
 */
export function useStickyOffsets(mastheadRef: RefObject<HTMLElement | null>, subchromeRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const masthead = mastheadRef.current;
    const sub = subchromeRef.current;
    if (!masthead) return;
    const root = document.documentElement;
    const pinned = (el: HTMLElement | null): number => (el && getComputedStyle(el).position === "sticky" ? el.offsetHeight : 0);
    const measure = (): void => {
      root.style.setProperty("--masthead-h", `${masthead.offsetHeight}px`);
      root.style.setProperty("--sticky-h", `${pinned(masthead) + pinned(sub)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(masthead);
    if (sub) observer?.observe(sub);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      root.style.removeProperty("--masthead-h");
      root.style.removeProperty("--sticky-h");
    };
  }, [mastheadRef, subchromeRef]);
}

/**
 * True while the element's content is wider than its box, i.e. while it scrolls sideways. Measured
 * on mount, on resize and whenever `content` changes (new quotes can be wider). False during SSR.
 */
export function useScrollsSideways(ref: RefObject<HTMLElement | null>, content?: unknown): boolean {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      setScrolls(false);
      return;
    }
    const measure = (): void => setScrolls(scrollsSideways(el.scrollWidth, el.clientWidth));
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [ref, content]);
  return scrolls;
}

/**
 * Scroll position per page. A new page starts at the top; pages for which `remember` is true (the
 * long front page) come back where the reader left them - Back from a section page must not dump
 * you at the masthead. Positions live in memory for the session of this tab.
 */
export function usePageScroll(page: string, remember: (page: string) => boolean): void {
  const positions = useRef(new Map<string, number>());
  const current = useRef(page);
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

  useEffect(() => {
    const onScroll = (): void => {
      positions.current.set(current.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Layout effect: `current` must flip before the browser dispatches the scroll event caused by the
  // new (shorter) page, or that clamped offset would overwrite the old page's position.
  useLayoutEffect(() => {
    if (current.current === page) return;
    current.current = page;
    const top = rememberRef.current(page) ? (positions.current.get(page) ?? 0) : 0;
    // "instant": html has scroll-behavior: smooth, and a page change must not animate.
    window.scrollTo({ top, left: 0, behavior: "instant" });
  }, [page]);
}

/**
 * Background refresh: every REFRESH_INTERVAL_MS while the tab is visible, and right away when the
 * tab becomes visible or the connection returns after that long. Driven by the app clock (which
 * ticks on visibilitychange and pauses while hidden), so there is no second timer - and a frozen
 * test clock never refreshes.
 */
export function useAutoRefresh(services: Pick<AppServices, "edition" | "clock">, enabled: boolean): void {
  const { edition, clock } = services;
  useEffect(() => {
    if (!enabled) return;
    let lastAttemptMs = clock.get();
    const check = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = clock.get();
      if (!refreshDue(now, edition.get().fetchedAtMs, lastAttemptMs, REFRESH_INTERVAL_MS)) return;
      lastAttemptMs = now;
      // The store records failures in its state (banner); nothing to do with the rejection here.
      edition.refresh().catch(() => undefined);
    };
    const unsubscribe = clock.subscribe(check);
    window.addEventListener("online", check);
    return () => {
      unsubscribe();
      window.removeEventListener("online", check);
    };
  }, [edition, clock, enabled]);
}
