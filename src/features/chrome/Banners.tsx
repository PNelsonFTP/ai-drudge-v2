// Shell banners: new version, offline, load / refresh failure, still trying, stale data, changes not
// being saved. Each carries the action that resolves it, if there is one. (The "N new since your
// last visit" banner belongs to the home page.)

import { useState } from "react";
import { useNow, useServices, useStore, type AppServices, type PersistenceState, type Store } from "../../app/services";
import { useOnline } from "./hooks";
import { bannerModels, type BannerModel } from "./model";

function Banner({ banner, busy, onAction }: { banner: BannerModel; busy: boolean; onAction: () => void }) {
  return (
    <div className={banner.tone === "info" ? "banner banner-info" : "banner"}>
      <span>{banner.text}</span>
      {banner.action !== null && (
        <button type="button" className="btn" onClick={onAction} disabled={busy}>
          {busy ? "Checking…" : banner.actionLabel}
        </button>
      )}
    </div>
  );
}

/** Stands in for services.persistence where the services do not provide it (fakes, older wiring). */
const ALWAYS_SAVED: Store<PersistenceState> = (() => {
  const state: PersistenceState = { writeRefused: false };
  return { get: () => state, subscribe: () => () => undefined };
})();

/**
 * services.persistence, read defensively: it is optional in the AppServices contract (the real
 * wiring always provides it), so a services object without it means "saving works".
 */
export function persistenceOf(services: AppServices): Store<PersistenceState> {
  const store: Partial<Store<PersistenceState>> | null | undefined = services.persistence;
  return store && typeof store.get === "function" && typeof store.subscribe === "function" ? (store as Store<PersistenceState>) : ALWAYS_SAVED;
}

export function Banners() {
  const services = useServices();
  const { edition } = services;
  const state = useStore(edition);
  const now = useNow();
  const online = useOnline();
  const storageRefused = useStore(persistenceOf(services), (p) => p.writeRefused === true);
  const [retrying, setRetrying] = useState(false);
  // "Changes are not being saved" is said once per page load; the reader can put it away.
  const [storageDismissed, setStorageDismissed] = useState(false);
  const banners = bannerModels({ state, staleHours: edition.staleHours(now), online, storageRefused: storageRefused && !storageDismissed });

  const retry = (): void => {
    setRetrying(true);
    // The store reports failure through its state; the banner stays or changes accordingly.
    edition
      .refresh()
      .catch(() => undefined)
      .finally(() => setRetrying(false));
  };
  const actions: Record<NonNullable<BannerModel["action"]>, () => void> = {
    reload: () => window.location.reload(),
    retry,
    dismiss: () => setStorageDismissed(true),
  };

  return (
    // role="status": announced politely when a banner appears, never interrupting.
    <div className="banners" role="status">
      {banners.map((banner) => (
        <Banner key={banner.id} banner={banner} busy={banner.action === "retry" && retrying} onAction={banner.action === null ? () => undefined : actions[banner.action]} />
      ))}
    </div>
  );
}
