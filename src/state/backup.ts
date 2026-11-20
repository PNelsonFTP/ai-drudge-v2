// Backup / restore of the reader's state as one JSON document.
//
// Export: every "aid2:*" localStorage key that holds a valid value, with its schema version.
// Import: the document and every entry are validated with the SAME key specs the stores read with
// (old versions run through the key's migrations); previewJson() is the dry run - it reports what
// importJson() would do without touching storage. A restore REPLACES the keys it carries and leaves
// the others alone. Nothing outside the "aid2:" namespace can be written.

import type { BackupPreviewItem, BackupResult, BackupService } from "../app/services";
import { LAST_VISIT_KEY } from "./lastVisit";
import { MIGRATED_KEY } from "./migrateV1";
import { MUTES_KEY } from "./mutes";
import { SEEN_KEY } from "./readState";
import { SAVED_KEY } from "./saved";
import { SETTINGS_KEY } from "./settings";
import { decodeValue, encodeValue, isRecord, readKey, writeRaw, type KeySpec, type StorageLike } from "./storage";
import { WATCHLIST_KEY } from "./watchlist";

export const BACKUP_APP = "ai-drudge";
export const BACKUP_KIND = "reader-state";
/** Version of the backup DOCUMENT (each key carries its own value version). */
export const BACKUP_FORMAT = 1;
/** Refuse absurd inputs before parsing (a full reader state is a few hundred KB at most). */
export const MAX_BACKUP_CHARS = 5_000_000;

interface Entry<T> {
  spec: KeySpec<T>;
  label: string;
  /** Restored on import. Device-local bookkeeping is exported for completeness but not restored. */
  restore: boolean;
  describe(value: T): string;
}

const entry = <T>(e: Entry<T>): Entry<unknown> => e as unknown as Entry<unknown>;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const ENTRIES: readonly Entry<unknown>[] = [
  entry({
    spec: SAVED_KEY,
    label: "Bookmarks and read later",
    restore: true,
    describe: (s) => `${plural(s.bookmarks.size, "bookmark")}, ${s.later.size} read later`,
  }),
  entry({
    spec: MUTES_KEY,
    label: "Mutes",
    restore: true,
    describe: (m) => `${plural(m.sources.size + m.pendingNames.length, "muted source")}, ${plural(m.sections.size, "muted section")}`,
  }),
  entry({ spec: WATCHLIST_KEY, label: "Watchlist", restore: true, describe: (w) => plural(w.terms.length, "term") }),
  entry({
    spec: SETTINGS_KEY,
    label: "Settings",
    restore: true,
    describe: (s) => `theme ${s.theme}, ${s.density}, ${plural(s.hiddenSections.length, "hidden section")}${s.sectionOrder ? ", custom section order" : ""}`,
  }),
  entry({ spec: SEEN_KEY, label: "Read state", restore: true, describe: (ids) => plural(ids.length, "seen story", "seen stories") }),
  entry({ spec: LAST_VISIT_KEY, label: "Last visit", restore: false, describe: () => "this device only" }),
  entry({ spec: MIGRATED_KEY, label: "V1 import marker", restore: false, describe: () => "this device only" }),
];

export interface BackupDocument {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  format: number;
  exportedAt: string;
  /** storage key -> the stored envelope { v, data }. */
  keys: Record<string, { v: number; data: unknown }>;
}

export type { BackupPreview, BackupPreviewItem } from "../app/services";

/** The service as created here (kept as a name for callers that predate previewJson in the contract). */
export type BackupServiceImpl = BackupService;

export interface BackupServiceOptions {
  storage: StorageLike;
  now: () => number;
  /** Called after a successful restore so live stores re-read storage (pass each store's reload). */
  onRestore?: () => void;
}

type Plan = { ok: true; exportedAt: string | null; items: BackupPreviewItem[]; writes: { key: string; raw: string }[] } | { ok: false; error: string };

function plan(text: string): Plan {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "The file is empty." };
  if (text.length > MAX_BACKUP_CHARS) return { ok: false, error: "The file is too large to be an AI DRUDGE backup." };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  if (!isRecord(doc) || doc.app !== BACKUP_APP || doc.kind !== BACKUP_KIND || !isRecord(doc.keys)) {
    return { ok: false, error: "This is not an AI DRUDGE backup file." };
  }
  if (typeof doc.format !== "number" || !Number.isInteger(doc.format) || doc.format < 1) return { ok: false, error: "This is not an AI DRUDGE backup file." };
  if (doc.format > BACKUP_FORMAT) return { ok: false, error: "This backup was made by a newer version of AI DRUDGE. Reload the page and try again." };

  const items: BackupPreviewItem[] = [];
  const writes: { key: string; raw: string }[] = [];
  const known = new Set<string>();
  for (const e of ENTRIES) {
    known.add(e.spec.key);
    if (!Object.prototype.hasOwnProperty.call(doc.keys, e.spec.key)) continue;
    if (!e.restore) {
      items.push({ key: e.spec.key, label: e.label, action: "skip", detail: e.describe(undefined) });
      continue;
    }
    const res = decodeValue(JSON.stringify(doc.keys[e.spec.key]), e.spec);
    if (res.status !== "ok") {
      const why = res.status === "unreadable" && res.reason === "newer" ? "written by a newer version" : "not readable";
      items.push({ key: e.spec.key, label: e.label, action: "skip", detail: why });
      continue;
    }
    // Re-encode the VALIDATED value: nothing from the file reaches storage unparsed.
    writes.push({ key: e.spec.key, raw: encodeValue(e.spec, res.value) });
    items.push({ key: e.spec.key, label: e.label, action: "replace", detail: e.describe(res.value) });
  }
  for (const key of Object.keys(doc.keys)) {
    if (!known.has(key)) items.push({ key, label: key, action: "skip", detail: "unknown key" });
  }
  if (writes.length === 0) return { ok: false, error: "The backup contains nothing that can be restored." };
  return { ok: true, exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt : null, items, writes };
}

export function createBackupService(opts: BackupServiceOptions): BackupServiceImpl {
  const { storage } = opts;
  return {
    exportJson: () => {
      const keys: BackupDocument["keys"] = {};
      for (const e of ENTRIES) {
        const res = readKey(storage, e.spec);
        // Export the validated, current-version form - never a raw string of unknown shape.
        if (res.status === "ok") keys[e.spec.key] = JSON.parse(encodeValue(e.spec, res.value)) as { v: number; data: unknown };
      }
      const doc: BackupDocument = { app: BACKUP_APP, kind: BACKUP_KIND, format: BACKUP_FORMAT, exportedAt: new Date(opts.now()).toISOString(), keys };
      return JSON.stringify(doc, null, 2);
    },
    previewJson: (text) => {
      const p = plan(text);
      return p.ok ? { ok: true, exportedAt: p.exportedAt, items: p.items } : p;
    },
    importJson: (text): BackupResult => {
      const p = plan(text);
      if (!p.ok) return p;
      const restored: string[] = [];
      const failed: string[] = [];
      for (const w of p.writes) (writeRaw(storage, w.key, w.raw) ? restored : failed).push(w.key);
      if (restored.length > 0) opts.onRestore?.();
      if (failed.length > 0) {
        return { ok: false, error: `The browser refused to store ${failed.length} of ${p.writes.length} items (storage full or disabled).` };
      }
      return { ok: true, restored };
    },
  };
}

/** The storage keys a backup can carry (for docs and tests). */
export const BACKUP_KEYS: readonly string[] = ENTRIES.map((e) => e.spec.key);
/** The subset importJson() restores. */
export const RESTORABLE_KEYS: readonly string[] = ENTRIES.filter((e) => e.restore).map((e) => e.spec.key);
