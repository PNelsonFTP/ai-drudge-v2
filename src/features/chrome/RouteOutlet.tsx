// The route outlet: the page of the current route inside its own error boundary and Suspense
// boundary, so a broken or slow page never takes the chrome down with it.

import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import type { RouteRegistry } from "../../app/routeRegistry";
import { defaultTitle, documentTitle, pageKey, routeKey } from "../../app/routes";
import type { Route } from "../../app/services";

/** Shown for a route whose feature directory is not in this build. */
function MissingPage({ route }: { route: Route }) {
  const title = defaultTitle(route) || "Front page";
  useEffect(() => {
    document.title = documentTitle(title);
  }, [title]);
  return (
    <div className="route-status">
      <h2 className="section-heading">{title}</h2>
      <p>This page is not part of this build yet.</p>
      {route.name !== "home" && (
        <p>
          <a href="#/">Back to the front page</a>
        </p>
      )}
    </div>
  );
}

export function RouteOutlet({ route, registry }: { route: Route; registry: RouteRegistry }) {
  // "Try again" on the page's error panel must reach the registry: after a failed chunk it hands
  // out a FRESH lazy component, but only a new render of this outlet asks for it - the boundary
  // alone would re-render the old, permanently rejected one and fail again at once.
  const [attempt, setAttempt] = useState(0);
  const Page = registry.page(route.name) ?? MissingPage;
  return (
    <ErrorBoundary scope="page" resetKey={routeKey(route)} onRetry={() => setAttempt((n) => n + 1)}>
      <Suspense
        fallback={
          <p className="route-status" role="status">
            Loading…
          </p>
        }
      >
        {/* Keyed by page, not by route: search-as-you-type must not remount the results page. */}
        <Page key={`${pageKey(route)}#${attempt}`} route={route} />
      </Suspense>
    </ErrorBoundary>
  );
}
