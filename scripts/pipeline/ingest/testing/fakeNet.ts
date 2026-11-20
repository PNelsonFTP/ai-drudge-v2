// Scripted fetch for ingest tests. Unlike test/helpers/fakeFetch it records request headers / method
// (conditional GET, User-Agent fallback) and can HANG until the request's AbortSignal fires (timeouts
// on the virtual clock). Imported by *.test.ts files only.

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** What a handler may answer: a Response, a body string (200), "hang" (never answers), or an Error (network failure). */
export type Reply = Response | string | "hang" | Error;

export type Handler = (req: RecordedRequest, nth: number) => Reply | Promise<Reply>;

export interface ScriptedFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Requests whose URL equals `url`. */
  to(url: string): RecordedRequest[];
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

export function scriptedFetch(handler: Handler): ScriptedFetch {
  const requests: RecordedRequest[] = [];
  const perUrl = new Map<string, number>();
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req: RecordedRequest = { url, method: init?.method ?? "GET", headers: headerRecord(init), body: typeof init?.body === "string" ? init.body : undefined };
    requests.push(req);
    const nth = (perUrl.get(url) ?? 0) + 1;
    perUrl.set(url, nth);
    const reply = await handler(req, nth);
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? new Response(reply, { status: 200 }) : reply;
  };
  return { fetch: impl as typeof fetch, requests, to: (url) => requests.filter((r) => r.url === url) };
}

/** A Response with status and headers in one call. */
export function respond(body: string | Uint8Array | null, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers });
}

/** Route table on top of scriptedFetch: unknown URLs fail like a dead host. */
export function routedFetch(routes: Record<string, Reply | Handler>): ScriptedFetch {
  return scriptedFetch((req, nth) => {
    const route = routes[req.url];
    if (route === undefined) return new TypeError(`fetch failed: no route for ${req.url}`);
    if (typeof route === "function") return route(req, nth);
    return route instanceof Response ? route.clone() : route;
  });
}
