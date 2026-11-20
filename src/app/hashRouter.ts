// Hash router: the Route store of the app. GitHub Pages has no SPA fallback, so the route lives in
// location.hash; every navigation is a real <a href="#/..."> (middle-click, copy link and Back work).
//
// The environment is injected so the router is testable under node:test and inert during SSR.

import { createStore, type Route, type Router } from "./services";
import { formatRoute, isRouteHash, parseRoute, sameRoute } from "./routes";

export { formatRoute, parseRoute } from "./routes";

/** The slice of `window` the router uses. */
export interface HashRouterEnv {
  location: { hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

export interface HashRouter extends Router {
  /** Stop listening to the environment (tests, hot reload). */
  dispose(): void;
}

function browserEnv(): HashRouterEnv | null {
  return typeof window === "undefined" ? null : window;
}

/**
 * Create the router. Without an environment (SSR, tests that pass `null`) it is an in-memory
 * router with the same behaviour.
 */
export function createHashRouter(env: HashRouterEnv | null = browserEnv()): HashRouter {
  const store = createStore<Route>(parseRoute(env?.location.hash ?? ""));

  // Keep the SAME object while the route is unchanged, so subscribers do not re-render.
  const commit = (next: Route): void => {
    if (!sameRoute(store.get(), next)) store.set(next);
  };

  const onHashChange = (): void => {
    if (!env) return;
    // "#main" / "#sec-models" are in-page anchors, not navigation: stay on the current route.
    if (!isRouteHash(env.location.hash)) return;
    commit(parseRoute(env.location.hash));
  };
  env?.addEventListener("hashchange", onHashChange);

  return {
    get: store.get,
    subscribe: store.subscribe,
    href: formatRoute,
    go(route, opts) {
      const href = formatRoute(route);
      const target = parseRoute(href);
      if (env) {
        const current = env.location.hash;
        // "" and "#/" are both home: do not push a history entry for a route we are already on.
        const alreadyThere = current === href || (isRouteHash(current) && sameRoute(parseRoute(current), target));
        // replaceState does not fire hashchange and adds no history entry (search-as-you-type);
        // assigning the hash adds one, and its hashchange event is a no-op after commit().
        if (!alreadyThere) {
          if (opts?.replace) env.history.replaceState(null, "", href);
          else env.location.hash = href;
        }
      }
      commit(target);
    },
    dispose() {
      env?.removeEventListener("hashchange", onHashChange);
    },
  };
}
