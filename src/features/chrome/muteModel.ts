// Pure model of the mute notice ("Muted <source> - Undo"): no React, no DOM. A file of its own so it
// travels with the code that uses it (MuteToast, the keyboard layer) in the shell's interactions
// chunk instead of the entry bundle.

import type { SourceId } from "../../../shared/contract";
import type { AppServices, MutesState } from "../../app/services";
import { shortcutsEnabled } from "./model";

export type SourceMuteChange = { kind: "muted" | "unmuted"; id: SourceId };

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The ONE source a reader just muted or unmuted, or null for every other transition: several
 * sources at once (restore, "unmute everything", V1 import), a pending V1 name being resolved
 * (it adds a source AND changes pendingNames), section mutes, or no change.
 */
export function sourceMuteChange(prev: Pick<MutesState, "sources" | "pendingNames">, next: Pick<MutesState, "sources" | "pendingNames">): SourceMuteChange | null {
  if (prev.sources === next.sources || !sameList(prev.pendingNames, next.pendingNames)) return null;
  const added = [...next.sources].filter((id) => !prev.sources.has(id));
  const removed = [...prev.sources].filter((id) => !next.sources.has(id));
  if (added.length === 1 && removed.length === 0) return { kind: "muted", id: added[0] };
  if (added.length === 0 && removed.length === 1) return { kind: "unmuted", id: removed[0] };
  return null;
}

/** Display name of a source: the edition knows the sources it carries, sources.json knows all. */
export function muteSourceName(services: Pick<AppServices, "edition" | "sourcesData">, id: SourceId): string {
  const inEdition = services.edition.get().edition?.sources[id]?.name;
  if (inEdition) return inEdition;
  return services.sourcesData.get().sources?.sources.find((s) => s.id === id)?.name ?? id;
}

export interface MuteEvent extends SourceMuteChange {
  /** Source display name. */
  name: string;
  /** Text for the polite live region. */
  message: string;
}

/** `key`: single-key shortcuts are on, so "u" undoes it; otherwise point at the visible notice. */
export const muteMessage = (name: string, key = true): string => `Muted source: ${name}. ${key ? "Press u to undo." : "Undo is in the notice at the bottom of the page."}`;
export const unmuteMessage = (name: string): string => `Showing ${name} again`;

/**
 * Watch the mutes store and report every single-source mute / unmute, whatever caused it (the m
 * key, a row's mute button, the Sources page) - `null` for any other change of the store.
 * Returns the unsubscribe function.
 */
export function watchSourceMutes(services: Pick<AppServices, "mutes" | "edition" | "sourcesData" | "settings">, onChange: (event: MuteEvent | null) => void): () => void {
  let prev = services.mutes.get();
  return services.mutes.subscribe(() => {
    const next = services.mutes.get();
    const change = sourceMuteChange(prev, next);
    prev = next;
    if (!change) return onChange(null);
    const name = muteSourceName(services, change.id);
    const message = change.kind === "muted" ? muteMessage(name, shortcutsEnabled(services.settings.get())) : unmuteMessage(name);
    onChange({ ...change, name, message });
  });
}

/** Undo a mute: unmute `id` only when it is still muted (never flip it back ON by a late click). */
export function undoMute(mutes: AppServices["mutes"], id: SourceId): boolean {
  if (!mutes.get().sources.has(id)) return false;
  mutes.toggleSource(id);
  return true;
}
