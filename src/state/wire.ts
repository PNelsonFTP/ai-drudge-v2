// Cross-store reactions that belong to no single store. createServices() calls wireStores() once;
// everything here is an optimisation or a repair, never a precondition for rendering.
//
//   edition changes  -> saved.reconcile(edition)       refresh / complete snapshots
//                    -> mutes.resolvePending(...)      V1 display names -> SourceId
//                    -> lastVisit.noteEdition(...)     what the reader has been shown (visible tab only;
//                                                      every successful refresh is the session heartbeat)
//                    -> sourcesData.reload()           a new build has new feed health (if it was loaded)
//   pending V1 mute names left after a complete edition -> load sources.json once (it has aliases)
//   pending V1 mute names that appear LATER (Settings: "Import from V1 again", another tab, a restored
//   backup) -> resolved against everything already known, without waiting for a page reload

import type { RiverFile, SourcesFile } from "../../shared/contract";
import type { Edition } from "../../shared/select";
import { parseMs } from "../../shared/time";
import type { EditionState, SourcesState, Store } from "../app/services";
import type { LastVisit } from "./lastVisit";
import type { NamedSource } from "./mutes";

export function namedSourcesOfEdition(e: Edition): NamedSource[] {
  return Object.keys(e.sources).map((id) => ({ id, name: e.sources[id].name }));
}

export function namedSourcesOfRiver(river: RiverFile): NamedSource[] {
  return river.sourceIds.map((id, i) => ({ id, name: river.sources[i] ?? id }));
}

export function namedSourcesOfFile(file: SourcesFile): NamedSource[] {
  return file.sources.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases }));
}

/** The slice of `document` used to tell a visible tab from a background one. */
export interface WireVisibility {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface WireOptions {
  edition: Store<EditionState>;
  /** `reload` (optional): called when the edition moves to another build after sources.json was loaded. */
  sourcesData?: Store<SourcesState> & { load(): Promise<void>; reload?(): Promise<void> };
  saved?: { reconcile(edition: Edition | null): void };
  /** `get` + `subscribe` (optional): lets names that become pending after start-up be resolved too. */
  mutes?: {
    resolvePending(sources: Iterable<NamedSource>, opts?: { final?: boolean }): number;
    get?(): { readonly pendingNames: readonly string[] };
    subscribe?(listener: () => void): () => void;
  };
  lastVisit?: Pick<LastVisit, "noteEdition">;
  /** `document`: an edition is "shown" only while the tab is visible. Omit to treat it as always visible. */
  visibility?: WireVisibility | null;
  now: () => number;
}

/** Subscribe the reactions. Returns the unsubscribe function. */
export function wireStores(opts: WireOptions): () => void {
  let lastEdition: Edition | null = null;
  let lastRiver: RiverFile | null = null;
  let lastSources: SourcesFile | null = null;
  let lastBuildId: string | null = null;
  let pending = 1; // unknown until the first resolvePending() call (used when mutes has no get())
  let askedForSources = false;
  let resolving = false;
  let knownPending = new Set<string>(opts.mutes?.get?.().pendingNames ?? []);
  // What lastVisit was last told about: an edition fetched while hidden is noted once the tab shows.
  let notedEdition: Edition | null = null;
  let notedRiver: RiverFile | null = null;
  let notedFetch: number | null = null;

  const visible = (): boolean => !opts.visibility || opts.visibility.visibilityState !== "hidden";
  const hasPending = (): boolean => (opts.mutes?.get ? opts.mutes.get().pendingNames.length > 0 : pending > 0);

  const resolve = (sources: Iterable<NamedSource>, final = false): void => {
    if (!opts.mutes || !hasPending()) return;
    resolving = true;
    try {
      pending = final ? opts.mutes.resolvePending(sources, { final: true }) : opts.mutes.resolvePending(sources);
    } finally {
      resolving = false;
    }
    knownPending = new Set(opts.mutes.get?.().pendingNames ?? []);
  };

  /** Names the edition could not resolve may be aliases (renamed sources): sources.json has them. */
  const askForSources = (): void => {
    if (!opts.mutes || !hasPending() || !lastEdition?.complete || !opts.sourcesData || askedForSources) return;
    askedForSources = true;
    void opts.sourcesData.load();
  };

  /** Tell lastVisit what is on screen. `force`: the tab just became visible (heartbeat even if nothing changed). */
  const note = (force = false): void => {
    if (!opts.lastVisit || !visible()) return;
    const s = opts.edition.get();
    if (!s.edition) return;
    if (!force && s.edition === notedEdition && s.river === notedRiver && s.fetchedAtMs === notedFetch) return;
    notedEdition = s.edition;
    notedRiver = s.river;
    notedFetch = s.fetchedAtMs;
    // The river is self-contained and can be one build ahead of the edition: #/new lists its rows.
    const generated = Math.max(parseMs(s.edition.meta.generatedAt) ?? -1, s.river ? (parseMs(s.river.generatedAt) ?? -1) : -1);
    if (generated >= 0) opts.lastVisit.noteEdition(generated, opts.now());
  };

  const onEdition = (): void => {
    const s = opts.edition.get();
    if (s.edition && s.edition !== lastEdition) {
      lastEdition = s.edition;
      opts.saved?.reconcile(s.edition);
      resolve(namedSourcesOfEdition(s.edition));
      askForSources();
      const buildId = s.edition.meta.buildId;
      if (lastBuildId !== null && buildId !== lastBuildId && opts.sourcesData?.reload && opts.sourcesData.get().status === "ready") {
        // Feed status, fail streaks and "last OK" belong to a build: follow the edition.
        void opts.sourcesData.reload();
      }
      lastBuildId = buildId;
    }
    if (s.river && s.river !== lastRiver) {
      lastRiver = s.river;
      resolve(namedSourcesOfRiver(s.river));
    }
    note();
  };

  const onSources = (): void => {
    const file = opts.sourcesData?.get().sources ?? null;
    if (!file || file === lastSources) return;
    lastSources = file;
    // The registry is the last word: names it does not know are dropped.
    resolve(namedSourcesOfFile(file), true);
  };

  const onMutes = (): void => {
    if (resolving || !opts.mutes?.get) return;
    const names = opts.mutes.get().pendingNames;
    const added = names.some((n) => !knownPending.has(n));
    knownPending = new Set(names);
    if (!added) return;
    if (lastEdition) resolve(namedSourcesOfEdition(lastEdition));
    if (lastRiver) resolve(namedSourcesOfRiver(lastRiver));
    if (lastSources) resolve(namedSourcesOfFile(lastSources), true);
    else {
      askedForSources = false;
      askForSources();
    }
  };

  const onVisibility = (): void => note(true);

  const offEdition = opts.edition.subscribe(onEdition);
  const offSources = opts.sourcesData?.subscribe(onSources);
  const offMutes = opts.mutes?.subscribe?.(onMutes);
  opts.visibility?.addEventListener("visibilitychange", onVisibility);
  onEdition();
  onSources();
  return () => {
    offEdition();
    offSources?.();
    offMutes?.();
    opts.visibility?.removeEventListener("visibilitychange", onVisibility);
  };
}
