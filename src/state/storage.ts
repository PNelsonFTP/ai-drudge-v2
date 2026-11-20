// The ONE storage wrapper of the client. Every persisted value goes through it:
//
//   - namespaced: a KeySpec key must start with STORAGE_PREFIX ("aid2:"). defineKey() throws on
//     anything else, so V2 code cannot write a V1 "ai-drudge:*" key by construction (V1 and V2 may
//     share the github.io origin).
//   - versioned: values are stored as an envelope {"v": <version>, "data": ...}; older versions are
//     upgraded through `migrations`, newer versions are left untouched (read-only).
//   - tolerant: storage access errors (private mode, disabled storage), corrupt JSON, wrong shapes
//     and quota errors never throw. Reads are tri-state - "unreadable" is never treated as "empty".
//
// Framework-free; stores built on it are unit-testable with createMemoryStorage().

import { STORAGE_PREFIX, createStore, type Store } from "../app/services";

/** The part of the DOM Storage interface the client uses (localStorage / sessionStorage satisfy it). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** The part of a `storage` event the client uses. */
export interface StorageEventLike {
  key: string | null;
}

/** Something that dispatches `storage` events (the browser `window`). */
export interface StorageEventSource {
  addEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
}

export interface KeySpec<T> {
  /** Full storage key; must start with STORAGE_PREFIX. */
  readonly key: string;
  /** Current schema version of the value (integer >= 1). */
  readonly version: number;
  /**
   * Validate and normalise decoded data of the CURRENT version. Be lenient with members (drop bad
   * entries) and strict with the container: return null only when nothing usable is there.
   */
  parse(data: unknown): T | null;
  /** JSON-serialisable form of the value (Sets -> arrays). Default: the value itself. */
  encode?(value: T): unknown;
  /** migrations[n] upgrades data written at version n to version n + 1. */
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
}

export type UnreadableReason =
  | "storage" // getItem threw (storage disabled)
  | "json" // not JSON
  | "shape" // not a {v, data} envelope, or no migration path from its version
  | "newer" // written by a newer client: must not be overwritten
  | "invalid"; // envelope fine, data rejected by parse()

export type ReadResult<T> =
  | { status: "ok"; value: T; migrated: boolean }
  | { status: "empty" }
  | { status: "unreadable"; reason: UnreadableReason };

/** Declare a persisted key. Throws when the key is outside the V2 namespace (a programming error). */
export function defineKey<T>(spec: KeySpec<T>): KeySpec<T> {
  if (!spec.key.startsWith(STORAGE_PREFIX)) throw new Error(`storage key "${spec.key}" is outside the "${STORAGE_PREFIX}" namespace`);
  if (!Number.isInteger(spec.version) || spec.version < 1) throw new Error(`storage key "${spec.key}": version must be an integer >= 1`);
  return spec;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Decode a raw stored string through the envelope, the migrations and the key's parser. */
export function decodeValue<T>(raw: string | null, spec: KeySpec<T>): ReadResult<T> {
  if (raw === null || raw === "") return { status: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable", reason: "json" };
  }
  if (!isObj(parsed) || typeof parsed.v !== "number" || !Number.isInteger(parsed.v) || parsed.v < 0 || !("data" in parsed)) {
    return { status: "unreadable", reason: "shape" };
  }
  if (parsed.v > spec.version) return { status: "unreadable", reason: "newer" };
  let data: unknown = parsed.data;
  const migrated = parsed.v < spec.version;
  for (let v = parsed.v; v < spec.version; v++) {
    const step = spec.migrations?.[v];
    if (!step) return { status: "unreadable", reason: "shape" };
    try {
      data = step(data);
    } catch {
      return { status: "unreadable", reason: "invalid" };
    }
  }
  let value: T | null;
  try {
    value = spec.parse(data);
  } catch {
    value = null;
  }
  return value === null ? { status: "unreadable", reason: "invalid" } : { status: "ok", value, migrated };
}

/** The envelope string that writeKey stores. */
export function encodeValue<T>(spec: KeySpec<T>, value: T): string {
  return JSON.stringify({ v: spec.version, data: spec.encode ? spec.encode(value) : value });
}

/** getItem that never throws (undefined = storage unavailable). */
export function readRaw(storage: StorageLike, key: string): string | null | undefined {
  try {
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

export function readKey<T>(storage: StorageLike, spec: KeySpec<T>): ReadResult<T> {
  const raw = readRaw(storage, spec.key);
  if (raw === undefined) return { status: "unreadable", reason: "storage" };
  return decodeValue(raw, spec);
}

/** Write a value. False when storage refused it (quota, disabled) - the caller keeps its in-memory state. */
export function writeKey<T>(storage: StorageLike, spec: KeySpec<T>, value: T): boolean {
  return writeRaw(storage, spec.key, encodeValue(spec, value));
}

/** setItem for a namespaced key that never throws on storage errors (but throws on a foreign key). */
export function writeRaw(storage: StorageLike, key: string, raw: string): boolean {
  if (!key.startsWith(STORAGE_PREFIX)) throw new Error(`refusing to write storage key "${key}" outside the "${STORAGE_PREFIX}" namespace`);
  try {
    storage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

/** removeItem for a namespaced key; never throws on storage errors. */
export function removeKey(storage: StorageLike, key: string): boolean {
  if (!key.startsWith(STORAGE_PREFIX)) throw new Error(`refusing to remove storage key "${key}" outside the "${STORAGE_PREFIX}" namespace`);
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Every key of the storage that starts with `prefix` (default: the V2 namespace). */
export function listKeys(storage: StorageLike, prefix: string = STORAGE_PREFIX): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    // storage unavailable: nothing to list
  }
  return out.sort();
}

export interface MemoryStorage extends StorageLike {
  clear(): void;
}

/** In-memory Storage: the fallback when the browser refuses storage access, and the test double. */
export function createMemoryStorage(initial?: Readonly<Record<string, string>>): MemoryStorage {
  const map = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    clear: () => map.clear(),
  };
}

/**
 * The storage returned by `get`, or an in-memory one when access throws or the storage cannot even
 * be read (blocked third-party storage, sandboxed frames).
 *
 * A storage that can be READ but refuses the probe write (quota exhausted - the github.io origin is
 * shared with other projects) is kept: swapping it for an empty memory storage would make the
 * reader's bookmarks, mutes and theme look lost. Every writer already tolerates a refused write
 * (the change stays in memory and `onWriteError` is called).
 */
export function safeStorage(get: () => StorageLike | null | undefined): StorageLike {
  let s: StorageLike | null | undefined;
  try {
    s = get();
  } catch {
    return fallbackStorage();
  }
  if (!s) return fallbackStorage();
  const probe = `${STORAGE_PREFIX}probe`;
  try {
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    try {
      s.getItem(probe);
      return s;
    } catch {
      return fallbackStorage();
    }
  }
}

const fallbacks = new WeakSet<object>();

function fallbackStorage(): StorageLike {
  const memory = createMemoryStorage();
  fallbacks.add(memory);
  return memory;
}

/**
 * True for the in-memory stand-in safeStorage() hands out when the browser gives no storage at all
 * (blocked site data, sandboxed frame): writes to it succeed, so `onWriteError` never fires, yet
 * nothing survives the tab. A memory storage a test builds itself is not one.
 */
export function isFallbackStorage(storage: StorageLike): boolean {
  return fallbacks.has(storage);
}

// ------------------------------------------------------------------------------------------------
// Persisted store
// ------------------------------------------------------------------------------------------------

export interface PersistedStore<T> extends Store<T> {
  /**
   * Read-merge-write: re-read storage (another tab may have written), apply `fn` to the fresh value,
   * write, notify. Return the same reference from `fn` for "no change". Returns false when the new
   * state could not be persisted (it is still applied in memory).
   */
  update(fn: (prev: T) => T): boolean;
  /** Re-read storage now (the `storage` event handler; also called after a backup restore). */
  reload(): void;
  /** How the last read of the key went. "newer" means the store is read-only on disk. */
  status(): ReadResult<unknown>["status"] | UnreadableReason;
  /** Stop listening to storage events. */
  dispose(): void;
}

export interface PersistedStoreOptions<T> {
  storage: StorageLike;
  spec: KeySpec<T>;
  /** State when the key is absent or unreadable. */
  fallback: T;
  /** `window` in the browser: keeps tabs in sync. Omit in tests that do not need it. */
  events?: StorageEventSource | null;
  /** Called when a write is refused (quota / disabled storage), so the UI can say so. */
  onWriteError?: (key: string) => void;
}

/**
 * A Store<T> backed by one storage key.
 * - Identity is stable: the state object only changes when the stored string changes.
 * - A value written by a NEWER client is never overwritten (changes stay in memory).
 * - A failed write keeps the in-memory state until the next successful one.
 */
export function createPersistedStore<T>(opts: PersistedStoreOptions<T>): PersistedStore<T> {
  const { storage, spec, fallback } = opts;
  const store = createStore<T>(fallback);
  // The raw string the in-memory state corresponds to (undefined = never synced / storage error).
  let syncedRaw: string | null | undefined;
  let lastStatus: ReadResult<unknown>["status"] | UnreadableReason = "empty";
  let readOnly = false;

  /** Bring `current` in line with storage. Returns the fresh value without notifying. */
  const fresh = (current: T): T => {
    const raw = readRaw(storage, spec.key);
    if (raw === undefined) {
      lastStatus = "storage";
      return current;
    }
    if (raw === syncedRaw) return current;
    syncedRaw = raw;
    const res = decodeValue(raw, spec);
    readOnly = res.status === "unreadable" && res.reason === "newer";
    lastStatus = res.status === "unreadable" ? res.reason : res.status;
    return res.status === "ok" ? res.value : fallback;
  };

  store.set(fresh(fallback));

  const reload = (): void => store.set(fresh(store.get()));

  const update = (fn: (prev: T) => T): boolean => {
    const base = fresh(store.get());
    const next = fn(base);
    if (Object.is(next, base)) {
      store.set(base);
      return true;
    }
    let ok = false;
    if (!readOnly) {
      const raw = encodeValue(spec, next);
      ok = writeRaw(storage, spec.key, raw);
      if (ok) {
        syncedRaw = raw;
        lastStatus = "ok";
      }
    }
    if (!ok) opts.onWriteError?.(spec.key);
    store.set(next);
    return ok;
  };

  const onStorage = (event: StorageEventLike): void => {
    // key === null: the other tab called clear().
    if (event.key === null || event.key === spec.key) reload();
  };
  opts.events?.addEventListener("storage", onStorage);

  return {
    get: store.get,
    subscribe: store.subscribe,
    update,
    reload,
    status: () => lastStatus,
    dispose: () => opts.events?.removeEventListener("storage", onStorage),
  };
}

// ------------------------------------------------------------------------------------------------
// Small parsing helpers shared by the key specs
// ------------------------------------------------------------------------------------------------

export function isRecord(x: unknown): x is Record<string, unknown> {
  return isObj(x);
}

/** Distinct strings of an unknown value that pass `ok`, in first-appearance order ([] for a non-array). */
export function stringList(x: unknown, ok: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  for (const v of x) if (typeof v === "string" && ok(v)) seen.add(v);
  return [...seen];
}
