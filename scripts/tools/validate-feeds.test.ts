import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NOW_MS, makeRegistry, makeSource } from "../../test/helpers/factories";
import { feedFixtures, loadFixtureRegistry, readFeedFixture, readFixtureJson, readFixtureText } from "../../test/helpers/fixtures";
import { createTestContext } from "../pipeline/context";
import type { HttpDeps } from "../pipeline/ingest/http";
import { runIngest } from "../pipeline/ingest/index";
import { respond, routedFetch, scriptedFetch, type Handler, type Reply } from "../pipeline/ingest/testing/fakeNet";
import { createVirtualClock } from "../pipeline/ingest/testing/virtualClock";
import { sleep } from "../pipeline/ingest/timers";
import { LOW_CADENCE_STALE_DAYS, isTransient, sortVerdicts, staleDaysFor, summarize, verdictForAge, verdictForError, type Verdict } from "./feedVerdict";
import { findAuditIssue, formatIssueBody, ISSUE_BODY_BUDGET, lookupArgs, lookupFailureIsFatal, mdSafe, planIssue, TITLE_PREFIX } from "./report-feed-audit";
import { checkTarget, formatVerdictLine, reportVerdicts, targetsFromCandidates, targetsFromRegistry, validateTargets, type Target } from "./validate-feeds";

const NOW = FIXTURE_NOW_MS;
const v = (verdict: string, url = "https://feeds.example.com/x.xml", extra: Partial<Verdict> = {}): Verdict => ({ name: `src ${verdict}`, url, verdict, ...extra });

function harness(handler: Handler | Record<string, Reply | Handler>): { deps: HttpDeps; clock: ReturnType<typeof createVirtualClock>; net: ReturnType<typeof scriptedFetch> } {
  const clock = createVirtualClock();
  const net = typeof handler === "function" ? scriptedFetch(handler) : routedFetch(handler);
  return { clock, net, deps: { fetch: net.fetch, timers: clock, userAgent: "validate-test" } };
}

describe("feedVerdict", () => {
  it("one isTransient: rate limits and gateway errors everywhere; blocks on Reddit / Substack; anything on hnrss", () => {
    for (const verdict of ["TIMEOUT", "HTTP_429", "HTTP_502", "HTTP_503", "HTTP_504"]) assert.equal(isTransient(v(verdict)), true, verdict);
    for (const verdict of ["HTTP_404", "HTTP_403", "HTTP_410", "HTTP_500", "NOT_FEED", "PARSE_FAIL", "EMPTY", "STALE", "NO_CARDS", "NETWORK", "TOO_LARGE"]) assert.equal(isTransient(v(verdict)), false, verdict);
    assert.equal(isTransient(v("HTTP_403", "https://www.reddit.com/r/LocalLLaMA/.rss")), true);
    assert.equal(isTransient(v("HTTP_403", "https://thezvi.substack.com/feed")), true);
    assert.equal(isTransient(v("HTTP_404", "https://thezvi.substack.com/feed")), false);
    assert.equal(isTransient(v("EMPTY", "https://hnrss.org/newest?q=AI")), true);
    assert.equal(isTransient(v("HTTP_403", "https://notreddit.com.example.org/feed")), false, "host is matched by suffix, not substring");
    assert.equal(isTransient(v("OK", "https://hnrss.org/newest")), false);
  });

  it("maps failure classes to V1 verdict strings", () => {
    assert.equal(verdictForError("http", 404), "HTTP_404");
    assert.equal(verdictForError("timeout"), "TIMEOUT");
    assert.equal(verdictForError("not_feed"), "NOT_FEED");
    assert.equal(verdictForError("parse"), "PARSE_FAIL");
    assert.equal(verdictForError("empty"), "EMPTY");
    assert.equal(verdictForError("no_cards"), "NO_CARDS");
    assert.equal(verdictForAge(59.9), "OK");
    assert.equal(verdictForAge(60.1), "STALE");
    assert.equal(verdictForAge(null), "OK");
    // A source tagged "low-cadence" (a researcher's own blog) is not stale after two silent months.
    assert.equal(staleDaysFor(["research", "low-cadence"]), LOW_CADENCE_STALE_DAYS);
    assert.equal(staleDaysFor(["research"]), 60);
    assert.equal(staleDaysFor(undefined), 60);
    assert.equal(verdictForAge(200, staleDaysFor(["low-cadence"])), "OK");
    assert.equal(verdictForAge(400, staleDaysFor(["low-cadence"])), "STALE");
  });

  it("summarize splits ok / actionable / transient / moved; sortVerdicts is by verdict then name", () => {
    const verdicts = [v("OK"), v("HTTP_404"), v("HTTP_429"), v("OK", "https://old.example.com/feed", { name: "moved", redirected: true, finalUrl: "https://new.example.com/feed" })];
    const s = summarize(verdicts);
    assert.deepEqual([s.ok.length, s.actionable.length, s.transient.length, s.moved.length], [2, 1, 1, 1]);
    assert.deepEqual(sortVerdicts(verdicts).map((x) => x.verdict), ["HTTP_404", "HTTP_429", "OK", "OK"]);
  });
});

describe("validate-feeds: targets", () => {
  it("covers EVERY registry source including scrape (and json) sources", () => {
    const { sources } = loadFixtureRegistry();
    const targets = targetsFromRegistry(sources);
    assert.equal(targets.length, 207);
    const scrape = targets.filter((t) => t.kind === "scrape");
    assert.deepEqual(scrape.map((t) => t.id), ["anthropic-news", "anthropic-research", "uk-aisi-blog", "gray-swan"]);
    assert.ok(scrape.every((t) => t.scrape?.linkPattern));
    assert.deepEqual(Object.keys(targets[0]).sort(), ["category", "id", "jsonApi", "kind", "name", "scrape", "url"]);
  });

  it("paused sources are skipped unless asked for", () => {
    const { sources } = loadFixtureRegistry();
    const withPaused = [{ ...sources[0], status: "paused" as const }, ...sources.slice(1)];
    assert.equal(targetsFromRegistry(withPaused).length, 206);
    assert.equal(targetsFromRegistry(withPaused, true).length, 207);
  });

  it("accepts a V1 candidate list, SourceDef-like objects and the curation file shape", () => {
    assert.deepEqual(targetsFromCandidates([{ name: "A", url: "https://a.example.com/feed", category: "research" }, { name: "dup", url: "https://a.example.com/feed" }, { name: "no url" }, "junk", null]), [{ name: "A", url: "https://a.example.com/feed", category: "research" }]);

    const curated = targetsFromCandidates({
      accepted: [{ id: "x-feed", name: "X Feed", url: "https://x.example.com/rss", kind: "rss", home: "cyber" }],
      scrapePicks: [
        { id: "lab-news", name: "Lab", listingUrl: "https://lab.example.com/news/", mode: "html-links", base: "https://lab.example.com", linkPattern: "^/news/[a-z0-9-]+/$", dateHint: "<time datetime> inside the link" },
        { id: "hub-models", name: "Hub", listingUrl: "https://hub.example.com/api/models", mode: "json-api", itemsPath: "", titleField: "id", urlField: "", urlTemplate: "https://hub.example.com/{id}", dateField: "createdAt" },
      ],
    });
    assert.deepEqual(curated.map((t) => [t.id, t.kind, t.category]), [["x-feed", "rss", "cyber"], ["lab-news", "scrape", undefined], ["hub-models", "json", undefined]]);
    assert.deepEqual(curated[1].scrape, { base: "https://lab.example.com", linkPattern: "^/news/[a-z0-9-]+/$", dateHint: "time" });
    assert.deepEqual(curated[2].jsonApi, { itemsPath: "", titleField: "id", urlField: undefined, urlTemplate: "https://hub.example.com/{id}", dateField: "createdAt", summaryField: undefined });
    assert.deepEqual(targetsFromCandidates("nope"), []);
  });
});

describe("validate-feeds: verdicts (same parser and extractors as the build)", () => {
  it("classifies every feed fixture", async () => {
    const expected: Record<string, [string, number | undefined]> = {
      "rss2-wired-ai.xml": ["OK", 10],
      "rss2-quanta-ai.xml": ["OK", 5],
      "atom-theverge-ai.xml": ["OK", 10],
      "rdf-nature-machine-intelligence.xml": ["OK", 8],
      "github-releases-langchain.atom": ["OK", 10],
      "github-releases-llama-cpp-entity-heavy.atom": ["OK", 10],
      "hnrss-ai-150.xml": ["OK", 20],
      "google-news-sec-finra.xml": ["OK", 29],
      "rss2-empty-nist.xml": ["EMPTY", 0],
      "html-interstitial-403-dcd.html": ["HTTP_403", undefined],
    };
    for (const fx of feedFixtures()) {
      const { deps, clock } = harness(() => respond(readFeedFixture(fx.file), fx.httpStatus, fx.contentType ? { "content-type": fx.contentType } : {}));
      const kind = fx.url.includes("releases.atom") ? ("github-release" as const) : undefined;
      const verdict = await clock.settle(checkTarget({ name: fx.sourceName, url: fx.url, category: "x", kind }, deps, NOW));
      assert.deepEqual([verdict.verdict, verdict.itemCount], expected[fx.file], fx.file);
      assert.equal(verdict.name, fx.sourceName);
      assert.equal(verdict.category, "x");
      if (verdict.verdict === "OK") assert.ok(typeof verdict.newestAgeDays === "number" && verdict.newestAgeDays < 30, `${fx.file} newest ${verdict.newestAgeDays}`);
    }
  });

  it("writes the V1 verdict shape: name, url, category, verdict, httpStatus, finalUrl, redirected, itemCount, newestAgeDays (+ id, kind)", async () => {
    const { deps, clock } = harness(() => respond(readFeedFixture("rss2-wired-ai.xml"), 200, { "content-type": "application/xml" }));
    const verdict = await clock.settle(checkTarget({ id: "wired-ai", name: "Wired AI", url: "https://www.wired.com/feed/tag/ai/latest/rss", category: "industry", kind: "rss" }, deps, NOW));
    assert.deepEqual(Object.keys(verdict).sort(), ["category", "finalUrl", "httpStatus", "id", "itemCount", "kind", "name", "newestAgeDays", "redirected", "url", "verdict"]);
    assert.deepEqual([verdict.httpStatus, verdict.redirected, verdict.finalUrl], [200, false, "https://www.wired.com/feed/tag/ai/latest/rss"]);
    assert.match(formatVerdictLine(verdict), /^ {2}OK\s+10 items {2}newest\s+[\d.]+d {2}Wired AI$/);
  });

  it("scrape sources: OK with cards, NO_CARDS when the page layout changed (V1 never checked them)", async () => {
    interface Fx {
      id: string;
      file: string;
      url: string;
      config: Target["scrape"];
      expect: { cards: number };
      v1Scraper: boolean;
    }
    for (const fx of readFixtureJson<Fx[]>("scrape", "index.json").filter((f) => f.v1Scraper)) {
      const { deps, clock } = harness(() => respond(readFixtureText("scrape", fx.file), 200, { "content-type": "text/html" }));
      const verdict = await clock.settle(checkTarget({ id: fx.id, name: fx.id, url: fx.url, kind: "scrape", scrape: fx.config }, deps, NOW));
      assert.deepEqual([verdict.verdict === "OK" || verdict.verdict === "STALE", verdict.itemCount], [true, fx.expect.cards], fx.id);
    }
    const { deps, clock, net } = harness(() => respond("<html><body><a href='/careers'>Careers</a></body></html>", 200, { "content-type": "text/html" }));
    const dead = await clock.settle(checkTarget({ name: "Lab", url: "https://lab.example.com/news", kind: "scrape", scrape: { base: "https://lab.example.com", linkPattern: "/news/[a-z0-9-]+" } }, deps, NOW));
    assert.equal(dead.verdict, "NO_CARDS");
    assert.match(net.requests[0].headers.accept, /^text\/html/);
  });

  it("STALE, NOT_FEED, PARSE_FAIL, TIMEOUT, NETWORK, redirects and JSON APIs", async () => {
    const old = `<rss><channel><item><title>Old</title><link>https://o.example.com/1</link><pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
    const cases: [Target, Handler, Partial<Verdict>][] = [
      [{ name: "stale", url: "https://o.example.com/feed" }, () => old, { verdict: "STALE", itemCount: 1 }],
      [{ name: "spa", url: "https://spa.example.com/feed" }, () => respond("<!doctype html><html></html>", 200, { "content-type": "text/html; charset=utf-8" }), { verdict: "NOT_FEED", note: "text/html" }],
      [{ name: "undated", url: "https://u.example.com/feed" }, () => "<rss><channel><item><title>T</title><link>https://u.example.com/1</link></item></channel></rss>", { verdict: "OK", newestAgeDays: null }],
      [{ name: "badjson", url: "https://j.example.com/api", kind: "json", jsonApi: { itemsPath: "", titleField: "id", urlField: "url" } }, () => "{not json", { verdict: "PARSE_FAIL" }],
      [{ name: "api", url: "https://j.example.com/api", kind: "json", jsonApi: { itemsPath: "", titleField: "id", urlTemplate: "https://j.example.com/{id}" } }, () => '[{"id":"a"},{"id":"b"}]', { verdict: "OK", itemCount: 2 }],
      [{ name: "hang", url: "https://h.example.com/feed" }, () => "hang", { verdict: "TIMEOUT" }],
      [{ name: "dns", url: "https://gone.example.com/feed" }, () => new TypeError("fetch failed"), { verdict: "NETWORK" }],
      [{ name: "gone", url: "https://g.example.com/feed" }, () => respond("", 410), { verdict: "HTTP_410", httpStatus: 410 }],
    ];
    for (const [target, handler, want] of cases) {
      const { deps, clock } = harness(handler);
      const verdict = await clock.settle(checkTarget(target, deps, NOW));
      for (const [k, val] of Object.entries(want)) assert.deepEqual(verdict[k as keyof Verdict], val, `${target.name}.${k}`);
    }

    // A cross-host redirect is flagged so the registry URL can be updated.
    const clock = createVirtualClock();
    const moved: typeof fetch = async () => {
      const res = respond("<rss><channel><item><title>T</title><link>https://new.example.org/1</link></item></channel></rss>");
      Object.defineProperty(res, "url", { value: "https://new.example.org/feed.xml" });
      return res;
    };
    const verdict = await clock.settle(checkTarget({ name: "moved", url: "https://old.example.com/feed.xml" }, { fetch: moved, timers: clock, userAgent: "t" }, NOW));
    assert.deepEqual([verdict.verdict, verdict.redirected, verdict.finalUrl], ["OK", true, "https://new.example.org/feed.xml"]);
  });

  it("PF-6: the validator makes the build's request - a feed that needs 9.1 s for its headers is OK in both", async () => {
    const url = "https://feeds.slow.example.com/rss/technology";
    const body = `<rss><channel><item><title>Slow</title><link>https://slow.example.com/1</link></item></channel></rss>`;
    const clock = createVirtualClock();
    const net = scriptedFetch(async () => {
      await sleep(clock, 9_100);
      return body;
    });
    const verdict = await clock.settle(checkTarget({ id: "slow-post", name: "Slow Post", url }, { fetch: net.fetch, timers: clock, userAgent: "t" }, NOW));
    assert.deepEqual([verdict.verdict, verdict.itemCount], ["OK", 1]);
    assert.equal(net.requests.length, 2, "8 s attempt, then the 16 s retry - exactly what ingest does");

    // Same registry entry, same fake host, through the build's ingest stage.
    const clock2 = createVirtualClock();
    const net2 = scriptedFetch(async () => {
      await sleep(clock2, 9_100);
      return body;
    });
    const registry = makeRegistry([makeSource({ id: "slow-post", url })]);
    const out = await clock2.settle(runIngest(registry, createTestContext({ fetch: net2.fetch }), { timers: clock2, skipHn: true }));
    assert.deepEqual([out.health[0].ok, out.health[0].attempts], [true, 2]);

    // And a host that never answers is TIMEOUT for the validator after the same two attempts.
    const hung = harness(() => "hang");
    const dead = await hung.clock.settle(checkTarget({ name: "hung", url: "https://hung.example.net/feed/" }, hung.deps, NOW));
    assert.deepEqual([dead.verdict, dead.note, hung.net.requests.length], ["TIMEOUT", "timeout after 16000 ms", 2]);
    assert.ok(hung.clock.now() < 26_000);
  });

  it("SEC-4: a note quoting the response body is one line", async () => {
    const { deps, clock } = harness(() => "[\n::error::PWNED\n");
    const verdict = await clock.settle(checkTarget({ name: "api", url: "https://j.example.com/api", kind: "json", jsonApi: { itemsPath: "", titleField: "id", urlField: "url" } }, deps, NOW));
    assert.equal(verdict.verdict, "PARSE_FAIL");
    assert.ok(verdict.note && !/[\r\n]/.test(verdict.note), JSON.stringify(verdict.note));
    const lines: string[] = [];
    reportVerdicts([verdict], (l) => lines.push(...l.split("\n")));
    assert.ok(!lines.some((l) => l.startsWith("::")));
  });

  it("validateTargets checks everything, 2 per host, and returns sorted verdicts; exit code semantics preserved", async () => {
    const feed = (n: number): string => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>T${i}</title><link>https://x.example.com/${i}</link><pubDate>${new Date(NOW - 3_600_000).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`;
    let active = 0;
    let peak = 0;
    const clock = createVirtualClock();
    const net = scriptedFetch(async (req) => {
      if (req.url.startsWith("https://busy.example.com/")) {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => clock.setTimeout(r, 50));
        active--;
        return feed(3);
      }
      if (req.url === "https://dead.example.com/feed") return respond("", 404);
      if (req.url === "https://www.reddit.com/r/x/.rss") return respond("", 403);
      return feed(1);
    });
    const targets: Target[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `busy ${i}`, url: `https://busy.example.com/feed-${i}` })),
      { name: "dead", url: "https://dead.example.com/feed" },
      { name: "reddit", url: "https://www.reddit.com/r/x/.rss" },
      { name: "fine", url: "https://fine.example.com/feed" },
    ];
    const seen: string[] = [];
    const verdicts = await clock.settle(validateTargets(targets, { fetch: net.fetch, timers: clock, userAgent: "t" }, { nowMs: NOW, onVerdict: (x) => seen.push(x.name) }));
    assert.equal(verdicts.length, 9);
    assert.equal(seen.length, 9);
    assert.equal(peak, 2, "per-host concurrency");
    assert.deepEqual(verdicts.map((x) => x.verdict), ["HTTP_403", "HTTP_404", "OK", "OK", "OK", "OK", "OK", "OK", "OK"]);

    const lines: string[] = [];
    assert.equal(reportVerdicts(verdicts, (l) => lines.push(l)), 1, "an actionable problem (HTTP_404) fails the run");
    assert.ok(lines.some((l) => l.includes("=== FEED VALIDATION: 7/9 OK ===")));
    assert.ok(lines.some((l) => /HTTP_403\s+reddit.*\(transient\)/.test(l)));
    assert.equal(reportVerdicts(verdicts.filter((x) => x.verdict !== "HTTP_404"), () => undefined), 0, "transient-only failures do not");
    assert.equal(reportVerdicts(verdicts.filter((x) => x.verdict === "OK"), () => undefined), 0);
  });
});

describe("report-feed-audit", () => {
  const verdicts: Verdict[] = [
    v("OK"),
    v("HTTP_404", "https://dead.example.com/feed", { name: "Dead Feed", itemCount: undefined }),
    v("NOT_FEED", "https://spa.example.com/feed", { name: "SPA", note: "text/html](https://evil.example.net) @maintainer <img src=x>" }),
    v("STALE", "https://old.example.com/feed", { name: "Old", newestAgeDays: 71.3, itemCount: 12 }),
    v("HTTP_429", "https://busy.example.com/feed", { name: "Busy" }),
    v("OK", "https://a.example.com/feed", { name: "Moved", redirected: true, finalUrl: "https://b.example.org/feed" }),
  ];

  it("finds only a BOT-authored open issue with the audit title, through the repository's issue listing", () => {
    const args = lookupArgs("octo/ai-drudge");
    assert.deepEqual(args.slice(0, 3), ["api", "--paginate", "repos/octo/ai-drudge/issues?state=open&per_page=100"]);
    assert.equal(args[3], "--jq");
    assert.match(args[4], /\.pull_request == null/);
    assert.match(args[4], /\.user\.type == "Bot"/, "an issue a person opened under the same title is never adopted");
    assert.match(args[4], /startswith\("Feed audit:"\)/);
    assert.equal(lookupArgs(undefined)[2], "repos/{owner}/{repo}/issues?state=open&per_page=100", "gh fills the placeholders from GH_REPO");
    assert.equal(lookupArgs("not a repo; rm -rf")[2], "repos/{owner}/{repo}/issues?state=open&per_page=100");
    const calls: string[][] = [];
    const run = (out: string) => (a: string[]): string => (calls.push(a), out);
    assert.deepEqual(findAuditIssue(args, run("41\tFeed audit: 3 problems\n12\tFeed audit: 1 problem\n")), { number: 12, title: "Feed audit: 1 problem" });
    assert.deepEqual(calls[0], args);
    assert.equal(findAuditIssue(args, run("")), null);
    assert.equal(findAuditIssue(args, run("7\tV2 refresh failing\n")), null);
    assert.throws(() => findAuditIssue(args, run('{"message":"Bad credentials"}')), /unexpected line in the issue listing/);
  });

  it("a failed lookup is fatal in GitHub Actions (the issue is the only signal of a dead feed) and a warning elsewhere", () => {
    assert.equal(lookupFailureIsFatal({ GITHUB_ACTIONS: "true" }), true);
    assert.equal(lookupFailureIsFatal({}), false);
    assert.equal(lookupFailureIsFatal({ GITHUB_ACTIONS: "false" }), false);
    const failing = (): string => {
      throw new Error("HTTP 401: Bad credentials");
    };
    assert.throws(() => findAuditIssue(lookupArgs("octo/ai-drudge"), failing), /Bad credentials/, "the failure reaches the caller, which decides");
  });

  it("plans create / edit / close / none on the 'Feed audit:' title", () => {
    assert.deepEqual(planIssue([v("OK"), v("HTTP_429")], false, "t"), { action: "none" });
    assert.deepEqual(planIssue([v("OK")], true, "t"), { action: "close" });
    const create = planIssue(verdicts, false, "2026-11-19T21:00:00.000Z");
    assert.equal(create.action, "create");
    assert.equal(create.title, `${TITLE_PREFIX} 4 problems`);
    assert.equal(planIssue(verdicts, true, "t").action, "edit");
    assert.equal(planIssue([v("HTTP_404")], false, "t").title, "Feed audit: 1 problem");
  });

  it("formats actionable / moved / transient sections", () => {
    const body = formatIssueBody(verdicts, "2026-11-19T21:00:00.000Z");
    assert.match(body, /^_Updated 2026-11-19T21:00:00.000Z_/);
    assert.match(body, /## Actionable \(3\)/);
    assert.match(body, /- \*\*HTTP_404\*\* - Dead Feed - `https:\/\/dead\.example\.com\/feed`/);
    assert.match(formatIssueBody([v("**[x](y)**")], "t"), /- \*\*UNKNOWN\*\* - /);
    assert.match(body, /- \*\*STALE\*\* - Old - `https:\/\/old\.example\.com\/feed` \(newest 71\.3d, 12 items\)/);
    assert.match(body, /## Answered from another host \(1\)/);
    assert.match(body, /## Transient \/ known-benign \(1\)/);
    assert.match(body, /scripts\/registry\/sources\//);
  });

  it("feed-controlled text cannot inject Markdown, links or mentions into the issue", () => {
    const body = formatIssueBody(verdicts, "t");
    assert.ok(!body.includes("](https://evil.example.net)"));
    assert.ok(!body.includes("@maintainer"));
    assert.ok(!body.includes("<img"));
    assert.equal(mdSafe("a`b\n[c](d) **e** @f"), "ab c(d) e @​f");
    assert.equal(mdSafe(undefined), "");
  });

  it("SEC-5: a note is an inert code span - GitHub autolinks no URL, #ref or @mention inside it", () => {
    const body = formatIssueBody([v("PARSE_FAIL", "https://x.example.com/feed", { name: "X", note: "see https://evil.example/fix and #1, ask @maintainer `rm -rf`\n## Injected heading" })], "t");
    const line = body.split("\n").find((l) => l.startsWith("- **PARSE_FAIL**")) ?? "";
    assert.equal(line, "- **PARSE_FAIL** - X - `https://x.example.com/feed` (`see https://evil.example/fix and #1, ask @\u200bmaintainer rm -rf ## Injected heading`)");
    assert.doesNotMatch(body.replace(/`[^`\n]*`/g, "CODE"), /evil\.example|#1\b|maintainer|Injected/);
    assert.ok(!body.split("\n").some((l) => l.startsWith("## Injected")));
  });

  it("SEC-5: on a mass-failure day the body stays under GitHub's 65,536-character limit and says what was left out", () => {
    const many: Verdict[] = Array.from({ length: 411 }, (_, i) => v("NETWORK", `https://host-${i}.example.com/some/long/path/to/the/feed-${i}.xml`, { name: `Source number ${i}`, note: "x".repeat(200) }));
    const body = formatIssueBody(many, "2026-11-20T03:00:00.000Z");
    assert.ok(body.length <= 65_536 && body.length <= ISSUE_BODY_BUDGET + 600, `body is ${body.length} chars`);
    assert.match(body, /## Actionable \(411\)/);
    const shown = body.split("\n").filter((l) => l.startsWith("- **NETWORK**")).length;
    assert.ok(shown > 100 && shown < 411);
    assert.ok(body.includes(`- ...and ${411 - shown} more (see \`feed-audit.json\` in the run's \`v2-audit-reports\` artifact)`));
    assert.match(body, /Fix: edit the source in `scripts\/registry\/sources\/`/, "the closing line survives the cut");
    assert.equal(planIssue(many, false, "t").title, "Feed audit: 411 problems");
  });
});

describe("network tools refuse what they do not know before the first request", () => {
  it("validate-feeds: --help and unknown flags never start a crawl", async () => {
    const { checkArgs, USAGE } = await import("./validate-feeds");
    assert.equal(checkArgs([]), null);
    assert.equal(checkArgs(["candidates.json", "--include-paused", "--out", "v.json"]), null);
    assert.equal(checkArgs(["--help"]), "help");
    assert.equal(checkArgs(["-h"]), "help");
    assert.equal(checkArgs(["--dry-run"]), "unknown argument: --dry-run");
    assert.equal(checkArgs(["--include-pause"]), "unknown argument: --include-pause");
    assert.equal(checkArgs(["--out"]), "--out needs a file path");
    assert.equal(checkArgs(["--out", "--include-paused"]), "--out needs a file path");
    assert.match(USAGE, /NETWORK/);
  });

  it("check-links: the same, with its optional --data file", async () => {
    const { checkArgs, USAGE } = await import("./check-links");
    assert.equal(checkArgs([]), null);
    assert.equal(checkArgs(["--no-registry", "--no-docs", "--out", "report"]), null);
    assert.equal(checkArgs(["--data"]), null);
    assert.equal(checkArgs(["--data", "river.json", "--max-data", "50", "--strict"]), null);
    assert.equal(checkArgs(["--data", "--strict"]), null);
    assert.equal(checkArgs(["--help"]), "help");
    assert.equal(checkArgs(["--dry-run"]), "unknown argument: --dry-run");
    assert.equal(checkArgs(["docs/README.md"]), "unknown argument: docs/README.md");
    assert.equal(checkArgs(["--budget"]), "--budget needs a value");
    assert.match(USAGE, /NETWORK/);
  });

  it("the build takes no arguments at all", async () => {
    const { cliExit } = await import("../pipeline/run");
    assert.equal(cliExit([]), null);
    assert.equal(cliExit(["--help"]), 0);
    assert.equal(cliExit(["--dry-run"]), 2);
    assert.equal(cliExit(["--help", "--force"]), 2);
  });
});
