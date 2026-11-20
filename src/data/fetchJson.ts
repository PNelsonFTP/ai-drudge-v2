// Fetching and validating the JSON files under data/v2/. One place for: the timeout (V1 had none, so
// a hung stocks.json blocked the headlines forever), the typed failure reason, the payload guard
// (wrong-shaped JSON is a failed fetch, never app state), and the "newer schema" signal.

import { DATA_DIR } from "../../shared/contract";
import { isNewerSchema } from "../../shared/guards";

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The slice of `fetch` the client uses (window.fetch satisfies it). */
export type FetchLike = (input: string, init?: { cache?: "default" | "no-cache"; signal?: AbortSignal }) => Promise<ResponseLike>;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

// Wrappers, not references: window.setTimeout must not be called as a method of another object.
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type LoadFailure = "network" | "timeout" | "http" | "parse" | "invalid";

export type LoadResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: LoadFailure;
      /** HTTP status for "http"; the guard's message for "invalid". */
      detail?: string;
      /** The payload declares a schemaVersion newer than this bundle understands. */
      newer?: boolean;
    };

/** Headline files are large on slow links: a generous cap. Ticker and brief must never hold anything up. */
export const TIMEOUT_MS = { edition: 25_000, aux: 8_000 } as const;

export interface LoadOptions {
  /** true: revalidate with the server (`cache: "no-cache"`). false: default HTTP caching, which lets the
   * first-paint request reuse index.html's <link rel="preload">. */
  fresh: boolean;
  timeoutMs: number;
}

export type Loader = <T>(file: string, validate: (x: unknown) => string | null, opts: LoadOptions) => Promise<LoadResult<T>>;

/** URL of a data file ("front.json") under the site base ("/ai-drudge-v2/"). */
export function dataUrl(baseUrl: string, file: string): string {
  return `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}${DATA_DIR}${file}`;
}

export function createLoader(env: { baseUrl: string; fetch: FetchLike; timers?: Timers }): Loader {
  // Detached on purpose: window.fetch throws "Illegal invocation" when called as env.fetch(...).
  const doFetch = env.fetch;
  const timers = env.timers ?? realTimers;
  return async <T>(file: string, validate: (x: unknown) => string | null, opts: LoadOptions): Promise<LoadResult<T>> => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    let timer: unknown = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = timers.setTimeout(() => {
        timedOut = true;
        controller?.abort();
        resolve("timeout");
      }, opts.timeoutMs);
    });
    const request = (async (): Promise<LoadResult<T>> => {
      let res: ResponseLike;
      try {
        res = await doFetch(dataUrl(env.baseUrl, file), { cache: opts.fresh ? "no-cache" : "default", signal: controller?.signal });
      } catch {
        return { ok: false, reason: timedOut ? "timeout" : "network" };
      }
      if (!res.ok) return { ok: false, reason: "http", detail: String(res.status) };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, reason: timedOut ? "timeout" : "parse" };
      }
      const problem = validate(body);
      if (problem !== null) return { ok: false, reason: "invalid", detail: problem, newer: isNewerSchema(body) };
      return { ok: true, data: body as T };
    })();
    try {
      // The race covers a fetch implementation that ignores the abort signal.
      const winner = await Promise.race([request, timeout]);
      return winner === "timeout" ? { ok: false, reason: "timeout" } : winner;
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
    }
  };
}

/** Backoff between attempts of one load cycle (3 attempts in total). */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

export function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise<void>((resolve) => void timers.setTimeout(resolve, ms));
}

/** Failures worth retrying. A wrong-shaped payload will not get better within seconds. */
export function isTransient(reason: LoadFailure): boolean {
  return reason === "network" || reason === "timeout" || reason === "http" || reason === "parse";
}

/** One sentence for the reader. */
export function describeFailure(reason: LoadFailure, detail?: string): string {
  switch (reason) {
    case "timeout":
      return "the server took too long to answer";
    case "http":
      return `the server answered ${detail ?? "with an error"}`;
    case "parse":
    case "invalid":
      return "the data was not in the expected format";
    default:
      return "the network is unreachable";
  }
}
