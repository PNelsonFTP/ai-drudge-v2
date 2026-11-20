// Route discovery. Convention (services.ts RouteModule): one directory per route name with
//   src/features/<route name>/route.tsx      ->  `export default route` (a RouteModule)
// The home page is bundled eagerly; every other page is its own lazy chunk. A route whose feature
// directory does not exist (yet) simply has no page - the shell renders a placeholder for it.
//
// This is one of the two places that use a Vite-only API (import.meta.glob).

import { createElement, lazy, useEffect, type ComponentType } from "react";
import { ROUTE_NAMES, type Route, type RouteModule, type RouteName } from "./services";
import { documentTitle, isRouteName, resolveTitle } from "./routes";

export type RoutePage = ComponentType<{ route: Route }>;
/** What a route.tsx file exports. */
export interface RouteModuleFile {
  default: RouteModule;
}
export type RouteLoader = () => Promise<unknown>;

export interface RouteSources {
  /** path -> already imported module (home). */
  eager?: Readonly<Record<string, unknown>>;
  /** path -> dynamic import (everything else). */
  lazy?: Readonly<Record<string, RouteLoader>>;
}

export interface RouteRegistry {
  /** The page component of a route name; null when no feature provides it. */
  page(name: RouteName): RoutePage | null;
  /** Route names that have a page, in ROUTE_NAMES order. */
  names(): RouteName[];
  /** Start downloading a lazy page (call on hover / focus of its link). Safe to call repeatedly. */
  preload(name: RouteName): void;
  /** Problems found while registering eager modules (wrong export, name mismatch). */
  problems(): string[];
}

/** "../features/saved/route.tsx" -> "saved"; null when the path is not a route file of a known route. */
export function routeNameFromPath(path: string): RouteName | null {
  const m = /(?:^|\/)features\/([^/]+)\/route\.tsx?$/.exec(path);
  return m && isRouteName(m[1]) ? m[1] : null;
}

export function isRouteModule(x: unknown): x is RouteModule {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Partial<RouteModule>;
  const componentOk = typeof m.Component === "function" || (typeof m.Component === "object" && m.Component !== null);
  return isRouteName(m.name) && componentOk && (typeof m.title === "string" || typeof m.title === "function");
}

function moduleOf(file: unknown, expected: RouteName): RouteModule {
  const mod = (file as Partial<RouteModuleFile> | null)?.default;
  if (!isRouteModule(mod)) throw new Error(`features/${expected}/route.tsx must default-export a RouteModule`);
  if (mod.name !== expected) throw new Error(`features/${expected}/route.tsx exports the "${mod.name}" route`);
  return mod;
}

/** Wrap a RouteModule so the page keeps document.title in step with its route. */
export function makePage(mod: RouteModule): RoutePage {
  const Page: RoutePage = ({ route }) => {
    const title = documentTitle(resolveTitle(mod.title, route));
    useEffect(() => {
      document.title = title;
    }, [title]);
    return createElement(mod.Component, { route });
  };
  Page.displayName = `Route(${mod.name})`;
  return Page;
}

export function buildRouteRegistry(sources: RouteSources): RouteRegistry {
  const pages = new Map<RouteName, RoutePage>();
  const loaders = new Map<RouteName, () => Promise<{ default: RoutePage }>>();
  const problems: string[] = [];

  for (const [path, file] of Object.entries(sources.eager ?? {})) {
    const name = routeNameFromPath(path);
    if (!name) continue;
    try {
      pages.set(name, makePage(moduleOf(file, name)));
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (const [path, load] of Object.entries(sources.lazy ?? {})) {
    const name = routeNameFromPath(path);
    if (!name || pages.has(name)) continue;
    // One promise per route: preload() and the first render share the same download.
    let pending: Promise<{ default: RoutePage }> | null = null;
    const loadPage = (): Promise<{ default: RoutePage }> => {
      pending ??= load().then(
        (file) => ({ default: makePage(moduleOf(file, name)) }),
        (err: unknown) => {
          // A failed chunk (offline, a deploy replaced the hashed file) must be retryable, and
          // React.lazy remembers a rejection for good: hand out a fresh lazy component.
          pending = null;
          pages.set(name, lazy(loadPage));
          throw err;
        },
      );
      return pending;
    };
    loaders.set(name, loadPage);
    pages.set(name, lazy(loadPage));
  }

  return {
    page: (name) => pages.get(name) ?? null,
    names: () => ROUTE_NAMES.filter((n) => pages.has(n)),
    preload: (name) => {
      loaders.get(name)?.().catch(() => undefined);
    },
    problems: () => [...problems],
  };
}

function discover(): RouteSources {
  try {
    return {
      eager: import.meta.glob("../features/home/route.tsx", { eager: true }),
      lazy: import.meta.glob(["../features/*/route.tsx", "!../features/home/route.tsx"]),
    };
  } catch {
    // Not running under Vite (node:test, SSR smoke tests): import.meta.glob does not exist.
    return {};
  }
}

/** The registry of the pages present in this build. */
export const routeRegistry: RouteRegistry = buildRouteRegistry(discover());
