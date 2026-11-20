import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PIPELINE } from "../context";
import { BROWSER_UA, decodeBody, defaultUserAgent, HTTP_DEFAULTS, httpFetch, isPublicHost, isPublicHttpUrl, MAX_REDIRECTS, retryPlan, sniffCharset, type HttpDeps, type HttpResult } from "./http";
import { TimeoutBreaker } from "./pool";
import { respond, scriptedFetch, type Handler } from "./testing/fakeNet";
import { createVirtualClock, type VirtualClock } from "./testing/virtualClock";
import { createDeadline, sleep } from "./timers";

const URL_A = "https://feeds.example.com/a.xml";
const UA = "ai-drudge-test/2.0 (+https://example.org/)";

function setup(handler: Handler, extra: Partial<HttpDeps> = {}): { clock: VirtualClock; deps: HttpDeps; net: ReturnType<typeof scriptedFetch> } {
  const clock = createVirtualClock();
  const net = scriptedFetch(handler);
  return { clock, net, deps: { fetch: net.fetch, timers: clock, userAgent: UA, ...extra } };
}

const bytes = (...codes: number[]): Uint8Array => new Uint8Array(codes);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe("charset", () => {
  it("9. ISO-8859-1 bytes decode correctly from the Content-Type header", () => {
    const body = bytes(...ascii("<rss><channel><item><title>Caf"), 0xe9, ...ascii(" d"), 0xe9, ...ascii("j"), 0xe0, ...ascii("</title></item></channel></rss>"));
    const { text, charset } = decodeBody(body, "application/rss+xml; charset=ISO-8859-1");
    assert.equal(charset, "iso-8859-1");
    assert.ok(text.includes("Café déjà"));
    assert.ok(!text.includes("�"));
  });

  it("ISO-8859-1 from the XML declaration when the header is silent", () => {
    const body = bytes(...ascii('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>M'), 0xfc, ...ascii("nchen</title></channel></rss>"));
    assert.equal(sniffCharset(body, "text/xml"), "iso-8859-1");
    assert.ok(decodeBody(body, "text/xml").text.includes("München"));
  });

  it("windows-1252 punctuation (smart quotes, euro, dash) decodes", () => {
    const body = bytes(...ascii('<?xml version="1.0" encoding="windows-1252"?><t>'), 0x93, ...ascii("AI"), 0x94, 0x20, 0x96, 0x20, 0x80, ...ascii("5</t>"));
    assert.ok(decodeBody(body, "").text.includes("“AI” – €5"));
  });

  it("UTF-8 by default, BOM wins over everything, unknown labels fall back to UTF-8", () => {
    const utf8 = new TextEncoder().encode("<t>naïve — 日本語</t>");
    assert.equal(decodeBody(utf8, "application/xml").text, "<t>naïve — 日本語</t>");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    assert.deepEqual(decodeBody(withBom, "text/xml; charset=iso-8859-1"), { text: "<t>naïve — 日本語</t>", charset: "utf-8" });
    assert.deepEqual(decodeBody(utf8, "text/xml; charset=x-klingon-9"), { text: "<t>naïve — 日本語</t>", charset: "utf-8" });
  });

  it("HTML <meta charset> is honoured for scrape pages", () => {
    const body = bytes(...ascii('<html><head><meta charset="windows-1252"></head><body>'), 0x92, ...ascii("</body></html>"));
    assert.ok(decodeBody(body, "text/html").text.includes("’"));
  });

  it("end to end: an ISO-8859-1 response through httpFetch", async () => {
    const body = bytes(...ascii("<rss><channel><title>Fa"), 0xe7, ...ascii("ade</title></channel></rss>"));
    const { clock, deps } = setup(() => respond(body, 200, { "content-type": "text/xml; charset=iso-8859-1" }));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.equal(res.kind, "ok");
    assert.ok(res.kind === "ok" && res.text.includes("Façade") && res.bytes === body.length);
  });
});

describe("httpFetch: retries and User-Agent", () => {
  it("sends the honest identifying User-Agent and feed Accept header first", async () => {
    const { clock, deps, net } = setup(() => "<rss/>");
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.equal(res.kind === "ok" && res.attempts, 1);
    assert.equal(net.requests[0].headers["user-agent"], UA);
    assert.match(net.requests[0].headers.accept, /application\/rss\+xml/);
    assert.match(defaultUserAgent({}), /^ai-drudge\/2\.0 \(\+https:\/\/.+; feed reader\)$/);
    assert.equal(defaultUserAgent({ FEED_USER_AGENT: " custom/1.0 " }), "custom/1.0");
  });

  it("a host that rejects the honest UA (403) is retried once with a browser UA", async () => {
    const { clock, deps, net } = setup((req) => (req.headers["user-agent"] === BROWSER_UA ? "<rss/>" : respond("denied", 403)));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.equal(res.kind === "ok" && res.attempts, 2);
    assert.deepEqual(net.requests.map((r) => r.headers["user-agent"]), [UA, BROWSER_UA]);
  });

  it("403 for the browser UA too: two attempts, then HTTP 403", async () => {
    const { clock, deps, net } = setup(() => respond("no", 403, { "content-type": "text/html" }));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "http", detail: "HTTP 403", httpStatus: 403, attempts: 2 });
    assert.equal(net.requests.length, 2);
  });

  it("404 and 410 are answers: one attempt, no retry", async () => {
    for (const status of [404, 410]) {
      const { clock, deps, net } = setup(() => respond("gone", status));
      const res = await clock.settle(httpFetch({ url: URL_A }, deps));
      assert.deepEqual(pick(res), { kind: "error", error: "http", detail: `HTTP ${status}`, httpStatus: status, attempts: 1 });
      assert.equal(net.requests.length, 1);
    }
  });

  it("5xx and network errors are retried up to 3 attempts with jittered backoff", async () => {
    const a = setup((_req, nth) => (nth < 3 ? respond("bad gateway", 502) : "<rss/>"));
    const ok = await a.clock.settle(httpFetch({ url: URL_A }, a.deps));
    assert.equal(ok.kind === "ok" && ok.attempts, 3);
    assert.ok(a.clock.now() >= 400 + 800 && a.clock.now() <= 1000 + 1400, `backoff ${a.clock.now()} ms`);

    const b = setup(() => new TypeError("fetch failed"));
    const failed = await b.clock.settle(httpFetch({ url: URL_A }, b.deps));
    assert.deepEqual(pick(failed), { kind: "error", error: "network", detail: "fetch failed", httpStatus: undefined, attempts: 3 });
    assert.equal(b.net.requests.length, 3);
  });

  it("429 honours a short Retry-After and gives up on a long one", async () => {
    const short = setup((_req, nth) => (nth === 1 ? respond("", 429, { "retry-after": "2" }) : "<rss/>"));
    const ok = await short.clock.settle(httpFetch({ url: URL_A }, short.deps));
    assert.equal(ok.kind === "ok" && ok.attempts, 2);
    assert.equal(short.clock.now(), 2_000);

    const long = setup(() => respond("", 429, { "retry-after": "3600" }));
    const res = await long.clock.settle(httpFetch({ url: URL_A }, long.deps));
    assert.equal(res.kind === "error" && res.attempts, 1);
    assert.equal(long.clock.now(), 0);
  });

  it("retryPlan table", () => {
    assert.deepEqual(retryPlan({ error: "too_large" }, false), { retry: false });
    assert.deepEqual(retryPlan({ error: "timeout" }, false), { retry: true });
    assert.deepEqual(retryPlan({ error: "http", httpStatus: 404 }, false), { retry: false });
    assert.deepEqual(retryPlan({ error: "http", httpStatus: 403 }, false), { retry: true, browserUa: true, delayMs: undefined });
    assert.deepEqual(retryPlan({ error: "http", httpStatus: 403 }, true), { retry: false });
    assert.deepEqual(retryPlan({ error: "http", httpStatus: 429 }, true), { retry: true, delayMs: undefined });
    assert.deepEqual(retryPlan({ error: "http", httpStatus: 503 }, true), { retry: true, delayMs: undefined });
  });
});

function pick(res: HttpResult): Record<string, unknown> {
  if (res.kind !== "error") return { kind: res.kind };
  return { kind: res.kind, error: res.error, detail: res.detail, httpStatus: res.httpStatus, attempts: res.attempts };
}

describe("httpFetch: timeouts", () => {
  it("the timeout starts when the request starts (i.e. once the pool slot is held), not when it was queued", async () => {
    const { clock, deps, net } = setup(() => "hang");
    await clock.advance(30_000); // time spent queueing before the slot was granted
    const started = clock.now();
    const res = await clock.settle(httpFetch({ url: URL_A, attempts: 1 }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "timeout after 8000 ms", httpStatus: undefined, attempts: 1 });
    assert.equal(clock.now() - started, 8_000);
    assert.equal(net.requests.length, 1);
  });

  it("works even when fetch ignores the AbortSignal", async () => {
    const clock = createVirtualClock();
    const never: typeof fetch = () => new Promise<Response>(() => undefined);
    const res = await clock.settle(httpFetch({ url: URL_A, attempts: 1 }, { fetch: never, timers: clock, userAgent: UA }));
    assert.equal(res.kind === "error" && res.error, "timeout");
  });

  it("a slow body is bounded by the total timeout, not the header timeout", async () => {
    const { clock, deps } = setup(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<rss>"));
          // never closes
        },
      });
      return new Response(stream, { status: 200 });
    });
    const res = await clock.settle(httpFetch({ url: URL_A, attempts: 1 }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "timeout after 30000 ms (body)", httpStatus: undefined, attempts: 1 });
    assert.equal(clock.now(), 30_000);
    assert.ok(HTTP_DEFAULTS.totalTimeoutMs > HTTP_DEFAULTS.retryHeaderTimeoutMs, "a slow-header feed still has time for its body");
  });

  it("PF-6: a host that needs 9.1 s for its headers fails the 8 s attempt and succeeds on the 16 s retry", async () => {
    const clock = createVirtualClock();
    const net = scriptedFetch(async () => {
      await sleep(clock, 9_100);
      return "<rss/>";
    });
    const res = await clock.settle(httpFetch({ url: URL_A }, { fetch: net.fetch, timers: clock, userAgent: UA }));
    assert.equal(res.kind === "ok" && res.attempts, 2);
    assert.equal(net.requests.length, 2);
    assert.ok(clock.now() >= 8_000 + 400 + 9_100 && clock.now() <= 8_000 + 1_000 + 9_100, `took ${clock.now()} ms`);
  });

  it("PF-6: a host that never answers is asked twice (8 s, then 16 s) - not three times - and costs under 26 s", async () => {
    const { clock, deps, net } = setup(() => "hang");
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "timeout after 16000 ms", httpStatus: undefined, attempts: 2 });
    assert.equal(net.requests.length, 2);
    assert.ok(clock.now() >= 24_400 && clock.now() < 26_000, `took ${clock.now()} ms`);
    assert.deepEqual([HTTP_DEFAULTS.headerTimeoutMs, HTTP_DEFAULTS.retryHeaderTimeoutMs, HTTP_DEFAULTS.timeoutRetries, HTTP_DEFAULTS.attempts], [8_000, 16_000, 1, 3]);
  });

  it("timeoutRetries: 0 - a timed-out request is not asked again (per-source fetch policy); network errors still retry", async () => {
    const hung = setup(() => "hang");
    const res = await hung.clock.settle(httpFetch({ url: URL_A, headerTimeoutMs: 16_000, timeoutRetries: 0 }, hung.deps));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "timeout after 16000 ms", httpStatus: undefined, attempts: 1 });
    assert.equal(hung.net.requests.length, 1);
    assert.equal(hung.clock.now(), 16_000);

    const slow = createVirtualClock();
    const net = scriptedFetch(async () => {
      await sleep(slow, 9_500);
      return "<rss/>";
    });
    const ok = await slow.settle(httpFetch({ url: URL_A, headerTimeoutMs: 16_000, timeoutRetries: 0 }, { fetch: net.fetch, timers: slow, userAgent: UA }));
    assert.equal(ok.kind === "ok" && ok.attempts, 1, "a 9.5 s host answers the first attempt");
    assert.equal(slow.now(), 9_500);

    const flaky = setup((_req, nth) => (nth < 3 ? new TypeError("fetch failed") : "<rss/>"));
    const recovered = await flaky.clock.settle(httpFetch({ url: URL_A, timeoutRetries: 0 }, flaky.deps));
    assert.equal(recovered.kind === "ok" && recovered.attempts, 3);
  });

  it("PF-6: an explicit headerTimeoutMs is kept on the retry (link checks, resolvers choose their own budget)", async () => {
    const { clock, deps, net } = setup(() => "hang");
    const res = await clock.settle(httpFetch({ url: URL_A, headerTimeoutMs: 5_000, totalTimeoutMs: 5_000 }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "timeout after 5000 ms", httpStatus: undefined, attempts: 2 });
    assert.equal(net.requests.length, 2);
    assert.ok(clock.now() < 11_000);
  });

  it("PF-6: a timeout between other failures does not use up the three attempts of a network / 5xx retry", async () => {
    const { clock, deps, net } = setup((_req, nth) => (nth === 1 ? respond("bad gateway", 502) : nth === 2 ? "hang" : "<rss/>"));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.equal(res.kind === "ok" && res.attempts, 3);
    assert.equal(net.requests.length, 3);
  });

  it("the stage deadline aborts in-flight requests and stops retries", async () => {
    const clock = createVirtualClock();
    const net = scriptedFetch(() => "hang");
    const deadline = createDeadline(clock, 5_000);
    const res = await clock.settle(httpFetch({ url: URL_A }, { fetch: net.fetch, timers: clock, userAgent: UA, deadline }));
    assert.deepEqual(pick(res), { kind: "error", error: "timeout", detail: "stage deadline reached", httpStatus: undefined, attempts: 1 });
    assert.equal(clock.now(), 5_000);
    assert.equal(net.requests.length, 1);

    const late = await clock.settle(httpFetch({ url: URL_A }, { fetch: net.fetch, timers: clock, userAgent: UA, deadline }));
    assert.equal(late.kind === "error" && late.attempts, 0);
    assert.equal(net.requests.length, 1, "no request after the deadline");
  });

  it("the breaker stops asking a host that keeps timing out", async () => {
    const clock = createVirtualClock();
    const net = scriptedFetch(() => "hang");
    const breaker = new TimeoutBreaker(3);
    const deps: HttpDeps = { fetch: net.fetch, timers: clock, userAgent: UA, breaker };
    const first = await clock.settle(httpFetch({ url: "https://slow.example.com/1.xml" }, deps));
    assert.equal(first.kind === "error" && first.attempts, 2);
    // The third timeout on the host opens the breaker: this request gets its first attempt only.
    const second = await clock.settle(httpFetch({ url: "https://slow.example.com/2.xml" }, deps));
    assert.deepEqual(pick(second), { kind: "error", error: "timeout", detail: "timeout after 8000 ms", httpStatus: undefined, attempts: 1 });
    const third = await clock.settle(httpFetch({ url: "https://slow.example.com/3.xml" }, deps));
    assert.deepEqual(pick(third), { kind: "error", error: "timeout", detail: "slow.example.com timed out repeatedly this run; not retried", httpStatus: undefined, attempts: 0 });
    assert.equal(net.requests.length, 3);
  });
});

describe("httpFetch: redirects to non-public hosts (SEC-3)", () => {
  const redirected = (to: string, body = "<rss><channel><item><title>INTERNAL: draft</title><link>http://intranet.corp.local/ir</link></item></channel></rss>"): Response => {
    const res = respond(body);
    Object.defineProperty(res, "url", { value: to });
    return res;
  };

  it("a redirect to a loopback / private / internal host is refused BEFORE that host is requested", async () => {
    for (const to of ["http://127.0.0.1:52881/internal/feed.xml", "http://169.254.169.254/latest/meta-data/", "http://[::1]:8080/feed", "http://intranet/feed.xml", "https://wiki.corp.internal/feed", "//printer.local/feed"]) {
      const { clock, deps, net } = setup((req) => (req.url === URL_A ? respond(null, 302, { location: to }) : "<rss><channel><item><title>INTERNAL</title><link>http://intranet/x</link></item></channel></rss>"));
      const res = await clock.settle(httpFetch({ url: URL_A }, deps));
      assert.ok(res.kind === "error" && res.error === "network" && /^redirected to a non-public host \(/.test(res.detail) && res.attempts === 1, to);
      assert.deepEqual(net.requests.map((r) => r.url), [URL_A], `${to}: the internal host never saw a request, and there was no retry`);
    }
    // ... also when the hostile hop comes second, behind a public one.
    const { clock, deps, net } = setup((req) => (req.url === URL_A ? respond(null, 301, { location: "https://cdn.example.net/hop" }) : req.url === "https://cdn.example.net/hop" ? respond(null, 307, { location: "http://10.0.0.5/admin" }) : "<rss/>"));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.ok(res.kind === "error" && res.detail === "redirected to a non-public host (10.0.0.5)");
    assert.deepEqual(net.requests.map((r) => r.url), [URL_A, "https://cdn.example.net/hop"]);
  });

  it("public redirects are followed hop by hop: relative Location, validators kept, final URL reported, loops cut", async () => {
    const { clock, deps, net } = setup((req) => {
      if (req.url === URL_A) return respond(null, 301, { location: "/moved/a.xml" });
      if (req.url === "https://feeds.example.com/moved/a.xml") return respond(null, 307, { location: "https://new.example.org/feed.xml" });
      return respond("<rss/>", 200, { etag: '"v9"' });
    });
    const res = await clock.settle(httpFetch({ url: URL_A, etag: '"v8"' }, deps));
    assert.ok(res.kind === "ok" && res.finalUrl === "https://new.example.org/feed.xml" && res.etag === '"v9"' && res.attempts === 1);
    assert.deepEqual(net.requests.map((r) => [r.url, r.method, r.headers["if-none-match"], r.headers["user-agent"]]), [
      [URL_A, "GET", '"v8"', UA],
      ["https://feeds.example.com/moved/a.xml", "GET", '"v8"', UA],
      ["https://new.example.org/feed.xml", "GET", '"v8"', UA],
    ]);

    const loop = setup(() => respond(null, 302, { location: URL_A }));
    const looped = await loop.clock.settle(httpFetch({ url: URL_A }, loop.deps));
    assert.ok(looped.kind === "error" && looped.error === "network" && looped.detail === `more than ${MAX_REDIRECTS} redirects` && looped.attempts === 1);
    assert.equal(loop.net.requests.length, MAX_REDIRECTS + 1);

    const bad = setup(() => respond(null, 302, { location: "javascript:alert(1)" }));
    const refused = await bad.clock.settle(httpFetch({ url: URL_A }, bad.deps));
    assert.ok(refused.kind === "error" && refused.detail === "HTTP 302 redirect to an unusable location" && bad.net.requests.length === 1);

    // A 303 (and a 301 / 302 after a POST) continues as a GET without the body; a 3xx without Location is an HTTP answer.
    const post = setup((req) => (req.method === "POST" ? respond(null, 303, { location: "https://feeds.example.com/done" }) : `got ${req.method} ${req.body ?? "-"} ${req.headers["content-type"] ?? "-"}`));
    const done = await post.clock.settle(httpFetch({ url: URL_A, method: "POST", body: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, post.deps));
    assert.ok(done.kind === "ok" && done.text === "got GET - -");
    const bare = setup(() => respond(null, 302));
    assert.deepEqual(pick(await bare.clock.settle(httpFetch({ url: URL_A }, bare.deps))), { kind: "error", error: "http", detail: "HTTP 302", httpStatus: 302, attempts: 1 });
  });

  it("a response that a runtime redirected by itself onto a non-public host is refused unread and not retried", async () => {
    for (const to of ["http://127.0.0.1:52881/internal/feed.xml", "http://169.254.169.254/latest/meta-data/", "http://[::1]/feed", "http://intranet/feed.xml", "https://wiki.corp.internal/feed", "http://printer.local/feed"]) {
      const { clock, deps, net } = setup(() => redirected(to));
      const res = await clock.settle(httpFetch({ url: URL_A }, deps));
      assert.equal(res.kind, "error", to);
      assert.ok(res.kind === "error" && res.error === "network" && /^redirected to a non-public host \(/.test(res.detail) && res.attempts === 1, to);
      assert.equal(net.requests.length, 1, "no retry: the answer will not change");
      assert.equal(clock.now(), 0);
    }
  });

  it("a redirect to another public host is still followed, and a request the caller aimed at a local host is not second-guessed", async () => {
    const pub = setup(() => redirected("https://new.example.org/feed.xml", "<rss/>"));
    const ok = await pub.clock.settle(httpFetch({ url: URL_A }, pub.deps));
    assert.ok(ok.kind === "ok" && ok.finalUrl === "https://new.example.org/feed.xml");
    const local = setup(() => "<rss/>");
    const dev = await local.clock.settle(httpFetch({ url: "http://localhost:8080/feed.xml" }, local.deps));
    assert.equal(dev.kind, "ok");
  });

  it("isPublicHost: names with a public suffix only; never IP literals, single labels or private suffixes", () => {
    for (const host of ["example.com", "feeds.washingtonpost.com", "xn--bcher-kva.example", "a.b.c.co.uk", "localhost.example.com", "internal.example.com"]) assert.equal(isPublicHost(host), true, host);
    for (const host of ["", null, "localhost", "intranet", "2130706433", "127.0.0.1", "10.0.0.5", "8.8.8.8", "169.254.169.254", "0x7f.0.0.1", "017.0.0.1", "[::1]", "::1", "host.local", "db.internal", "nas.lan", "x.localhost", "router.home.arpa", "wiki.corp"]) {
      assert.equal(isPublicHost(host), false, String(host));
    }
    assert.equal(isPublicHttpUrl("https://www.example.com/a"), true);
    assert.equal(isPublicHttpUrl("http://192.168.1.1/admin"), false);
    assert.equal(isPublicHttpUrl("not a url"), false);
  });
});

describe("httpFetch: conditional GET and size cap", () => {
  it("sends validators and reports 304 as not_modified", async () => {
    const { clock, deps, net } = setup((req) => (req.headers["if-none-match"] === 'W/"abc"' ? respond(null, 304) : "<rss/>"));
    const res = await clock.settle(httpFetch({ url: URL_A, etag: 'W/"abc"', lastModified: "Thu, 19 Nov 2026 18:02:11 GMT" }, deps));
    assert.deepEqual(res, { kind: "not_modified", status: 304, finalUrl: URL_A, attempts: 1 });
    assert.equal(net.requests[0].headers["if-modified-since"], "Thu, 19 Nov 2026 18:02:11 GMT");
  });

  it("returns the validators of a 200 response", async () => {
    const { clock, deps, net } = setup(() => respond("<rss/>", 200, { etag: '"v2"', "last-modified": "Thu, 19 Nov 2026 20:00:00 GMT", "content-type": "Application/RSS+XML; charset=UTF-8" }));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.ok(res.kind === "ok");
    assert.equal(res.etag, '"v2"');
    assert.equal(res.lastModified, "Thu, 19 Nov 2026 20:00:00 GMT");
    assert.equal(res.contentType, "application/rss+xml; charset=utf-8");
    assert.equal(net.requests[0].headers["if-none-match"], undefined);
  });

  it("a declared Content-Length over the cap is refused without reading", async () => {
    const { clock, deps, net } = setup(() => respond("x", 200, { "content-length": String(PIPELINE.maxBodyBytes + 1) }));
    const res = await clock.settle(httpFetch({ url: URL_A }, deps));
    assert.deepEqual(pick(res), { kind: "error", error: "too_large", detail: `body over ${PIPELINE.maxBodyBytes} bytes`, httpStatus: 200, attempts: 1 });
    assert.equal(net.requests.length, 1, "an oversized body is not retried");
  });

  it("a streamed body is cut off at the cap (5 MB by default)", async () => {
    assert.equal(PIPELINE.maxBodyBytes, 5 * 1024 * 1024);
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let sent = 0;
    const { clock, deps } = setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += chunk.length;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    const res = await clock.settle(httpFetch({ url: URL_A, maxBytes: 300_000 }, deps));
    assert.equal(res.kind === "error" && res.error, "too_large");
    assert.ok(sent < 600_000, `stopped reading after ${sent} bytes`);
  });

  it("readBody: false returns status and headers only; HEAD and POST pass through", async () => {
    const { clock, deps, net } = setup((req) => (req.method === "POST" ? respond(`echo:${req.body}`, 200) : respond(null, 200, { "content-type": "text/html" })));
    const head = await clock.settle(httpFetch({ url: URL_A, method: "HEAD", readBody: false }, deps));
    assert.ok(head.kind === "ok" && head.text === "" && head.status === 200);
    const post = await clock.settle(httpFetch({ url: URL_A, method: "POST", body: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, deps));
    assert.ok(post.kind === "ok" && post.text === "echo:a=1");
    assert.equal(net.requests[1].headers["content-type"], "application/x-www-form-urlencoded");
  });
});
