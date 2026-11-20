// Production entry: the real services (src/app/createServices.ts) under the shell.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { AppShell } from "./app/AppShell";
import { createServices, isFramedByAnotherSite } from "./app/createServices";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { routeRegistry } from "./app/routeRegistry";
import { ServicesContext } from "./app/services";
// The row and its stylesheet directly, not through features/headline/index.ts: that file also
// re-exports HoverCard, which belongs to the lazy interactions chunk (src/app/ShellInteractions.tsx).
import "./features/headline/headline.css";
import { HeadlineRow } from "./features/headline/HeadlineRow";
// The kit stylesheet (features/export/kit/kit.css: briefing dialog + secondary pages) is NOT
// imported here: it stays off the first-paint path. src/features/chrome/BriefingDialog.tsx and every
// secondary route.tsx import it themselves. Where it lands in the cascade does not matter: it is
// unlayered, so its rules beat every @layer rule either way - which is why kit.css must never style
// anything outside .sp-page / .sp-dialog (kit/styles.test.ts guards the masthead trigger).

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

if (import.meta.env.PROD && isFramedByAnotherSite(window)) {
  // Clickjacking defence (GitHub Pages cannot send frame-ancestors): inside another site's frame the
  // app does not start - no services, no storage access, no fetch - and offers only a way out.
  const link = document.createElement("a");
  link.href = window.location.href;
  link.target = "_top";
  link.rel = "noopener";
  link.textContent = "Open AI DRUDGE";
  root.replaceChildren(link);
} else {
  let warnedAboutStorage = false;
  // Built ONCE, before the first render: it runs the one-time V1 import, reads the last visit and the
  // session payload cache, and starts fetching - so a return visit paints with data immediately.
  const services = createServices({
    baseUrl: import.meta.env.BASE_URL,
    ui: { HeadlineRow },
    onWriteError: (key) => {
      // Quota exceeded / storage disabled: the change lives in this tab only. Said once, not per write.
      if (warnedAboutStorage) return;
      warnedAboutStorage = true;
      console.warn(`[ai-drudge] this browser refused to save "${key}": changes are kept until the tab is closed but are not being saved.`);
    },
  });

  for (const problem of routeRegistry.problems()) console.warn("[ai-drudge] route registry:", problem);

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="app">
        <ServicesContext.Provider value={services}>
          <AppShell />
        </ServicesContext.Provider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
