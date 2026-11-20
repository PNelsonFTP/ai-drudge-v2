// Pure route <-> hash mapping (no window, no React). The grammar is the one documented on
// `Route` in services.ts:
//
//   #/            home             #/s/<sectionId>   section
//   #/q/<query>   search           #/new   #/watch   #/saved   #/later
//   #/sources     #/settings       #/about
//
// Unknown hashes resolve to home. The hash is untrusted input: nothing here throws.

import { findSection } from "../../shared/sections";
import { ROUTE_NAMES, type Route, type RouteName } from "./services";

export const HOME: Route = { name: "home" };

const SIMPLE: Readonly<Record<string, Route>> = {
  new: { name: "new" },
  watch: { name: "watch" },
  saved: { name: "saved", tab: "bookmarks" },
  later: { name: "saved", tab: "later" },
  sources: { name: "sources" },
  settings: { name: "settings" },
  about: { name: "about" },
  // Tolerated aliases (the review's proposed grammar / V1 vocabulary); never produced by formatRoute.
  bookmarks: { name: "saved", tab: "bookmarks" },
  home: HOME,
};

/** Longest query kept from a hash (a pasted essay must not become a 100 KB route). */
export const MAX_QUERY_LENGTH = 200;

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A lone "%" typed by hand: keep the raw text rather than losing the query.
    return part;
  }
}

/** Collapse whitespace, trim, cap: the canonical form of a search query inside a route. */
export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * True when the hash addresses a route ("" | "#" | "#/..."). Anything else ("#main", "#sec-models")
 * is an in-page anchor: the router keeps the current route for those.
 */
export function isRouteHash(hash: string): boolean {
  return hash === "" || hash === "#" || hash.startsWith("#/");
}

/** Parse a location hash ("#/s/models", "/s/models" and "s/models" are all accepted). */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  if (path === "") return HOME;
  const slash = path.indexOf("/");
  const head = (slash === -1 ? path : path.slice(0, slash)).toLowerCase();
  const tail = slash === -1 ? "" : path.slice(slash + 1);

  if (head === "s") {
    const section = findSection(decode(tail.replace(/\/+$/, "")));
    return section ? { name: "section", id: section.id } : HOME;
  }
  // The query keeps its slashes ("#/q/a/b" searches "a/b"); formatRoute always encodes them.
  if (head === "q") return { name: "search", q: normalizeQuery(decode(tail)) };
  if (tail.replace(/\/+$/, "") !== "") return HOME;
  // hasOwn: the hash is untrusted ("#/constructor" must not find Object.prototype members).
  return Object.hasOwn(SIMPLE, head) ? SIMPLE[head] : HOME;
}

/** Canonical hash of a route (always starts with "#/"). */
export function formatRoute(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "section":
      return `#/s/${route.id}`;
    case "search":
      return `#/q/${encodeURIComponent(normalizeQuery(route.q))}`;
    case "saved":
      return route.tab === "later" ? "#/later" : "#/saved";
    case "new":
    case "watch":
    case "sources":
    case "settings":
    case "about":
      return `#/${route.name}`;
  }
}

/** Stable identity of a route (React keys, error-boundary reset, "did the page change"). */
export function routeKey(route: Route): string {
  return formatRoute(route);
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b);
}

/**
 * Identity of the PAGE a route shows. Search-as-you-type changes the route on every keystroke but
 * stays on one page, so scroll position and the mounted component must survive it.
 */
export function pageKey(route: Route): string {
  return route.name === "search" ? "search" : routeKey(route);
}

export const SITE_TITLE = "AI DRUDGE";

/** Titles used until (or instead of) the page's own RouteModule.title. */
export const DEFAULT_TITLES: Readonly<Record<RouteName, string>> = {
  home: "",
  section: "Section",
  search: "Search",
  new: "New since your last visit",
  watch: "Watchlist",
  saved: "Saved",
  sources: "Sources & feed health",
  settings: "Settings",
  about: "About",
};

export function defaultTitle(route: Route): string {
  switch (route.name) {
    case "section":
      return findSection(route.id)?.label ?? DEFAULT_TITLES.section;
    case "search":
      return route.q ? `Search: ${route.q}` : DEFAULT_TITLES.search;
    case "saved":
      return route.tab === "later" ? "Read later" : "Bookmarks";
    default:
      return DEFAULT_TITLES[route.name];
  }
}

/**
 * What the shell's status region says after a page change (a hash change reads nothing by itself):
 * "Watchlist page", "AI Security page" - and "Front page" for home, not "Front page page".
 */
export function pageAnnouncement(route: Route): string {
  const title = defaultTitle(route);
  return title ? `${title} page` : "Front page";
}

/** Resolve a RouteModule.title (string or function); "" / undefined fall back to defaultTitle. */
export function resolveTitle(title: string | ((route: Route) => string) | undefined, route: Route): string {
  let text = "";
  try {
    text = typeof title === "function" ? title(route) : (title ?? "");
  } catch {
    text = "";
  }
  return text.trim() || defaultTitle(route);
}

/** document.title for a page title: "Watchlist - AI DRUDGE"; just the site name for home. */
export function documentTitle(pageTitle: string): string {
  const t = pageTitle.trim();
  return t && t.toUpperCase() !== SITE_TITLE ? `${t} - ${SITE_TITLE}` : SITE_TITLE;
}

export function isRouteName(x: unknown): x is RouteName {
  return typeof x === "string" && (ROUTE_NAMES as readonly string[]).includes(x);
}

/** One example of every route shape (tests). */
export const EXAMPLE_ROUTES: readonly Route[] = [
  { name: "home" },
  { name: "section", id: "ai_security" },
  { name: "search", q: "prompt injection" },
  { name: "new" },
  { name: "watch" },
  { name: "saved", tab: "bookmarks" },
  { name: "saved", tab: "later" },
  { name: "sources" },
  { name: "settings" },
  { name: "about" },
];
