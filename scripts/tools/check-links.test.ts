import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSource } from "../../test/helpers/factories";
import { fixtureRiver } from "../../test/helpers/fixtureData";
import { loadFixtureRegistry } from "../../test/helpers/fixtures";
import type { HttpDeps } from "../pipeline/ingest/http";
import { respond, scriptedFetch, type Handler } from "../pipeline/ingest/testing/fakeNet";
import { createVirtualClock } from "../pipeline/ingest/testing/virtualClock";
import { ARCHIVE_GROUP, buildReport, checkAll, checkLink, classify, docTargets, exitCode, extractUrls, isArchiveOnly, isCheckable, mergeTargets, registryTargets, reportMarkdown, riverTargets, summaryTable, type LinkResult, type LinkTarget } from "./check-links";

function harness(handler: Handler): { deps: HttpDeps; clock: ReturnType<typeof createVirtualClock>; net: ReturnType<typeof scriptedFetch> } {
  const clock = createVirtualClock();
  const net = scriptedFetch(handler);
  return { clock, net, deps: { fetch: net.fetch, timers: clock, userAgent: "links-test" } };
}
const target = (url: string, ref = "docs:README.md"): LinkTarget => ({ url, refs: [ref] });

describe("check-links: collecting URLs", () => {
  it("extracts every http(s) URL from Markdown: links, autolinks, bare URLs, tables, code", () => {
    const md = [
      "# Title",
      "See [the docs](https://docs.lc-fixture.dev/guide/intro) and <https://auto.lc-fixture.dev/x>.",
      "Bare: https://bare.lc-fixture.dev/path?a=1&b=2, then text. Also (https://paren.lc-fixture.dev/a).",
      "Wikipedia style: https://en.wikipedia.org/wiki/Atom_(web_standard).",
      "| col | https://table.lc-fixture.dev/cell |",
      "`curl https://code.lc-fixture.dev/api`",
      'Image: ![alt](https://img.lc-fixture.dev/a.png "title")',
      "Twice: https://docs.lc-fixture.dev/guide/intro",
      "Not checked: http://localhost:5180/ http://127.0.0.1:3000/x https://example.com/placeholder https://docs.example.org/also-reserved https://<owner>.github.io/site/ https://api.lc-fixture.dev/{id} ${SITE_URL} https://your-site.lc-fixture.dev/",
      "ftp://files.lc-fixture.dev/x mailto:a@b.lc-fixture.dev",
    ].join("\n");
    assert.deepEqual(extractUrls(md), [
      "https://docs.lc-fixture.dev/guide/intro",
      "https://auto.lc-fixture.dev/x",
      "https://bare.lc-fixture.dev/path?a=1&b=2",
      "https://paren.lc-fixture.dev/a",
      "https://en.wikipedia.org/wiki/Atom_(web_standard)",
      "https://table.lc-fixture.dev/cell",
      "https://code.lc-fixture.dev/api",
      "https://img.lc-fixture.dev/a.png",
    ]);
  });

  it("a URL template is not a link: a prefix cut at a <placeholder>, or a placeholder written as an entity", () => {
    const md = [
      "Use `https://rss.lc-fixture.dev/feeds/<id>.xml` or https://video.lc-fixture.dev/feeds/videos.xml?channel_id=<id>; never the page.",
      'Markup: &lt;a href="https://blog.lc-fixture.dev/&lt;slug>"> and https://api.lc-fixture.dev/abs/&lt;id>, first.',
      "| Name<br>`id` | https://cell.lc-fixture.dev/feed<br>second line | <a href=\"https://anchor.lc-fixture.dev/x\">https://text.lc-fixture.dev/y</a> |",
    ].join("\n");
    assert.deepEqual(extractUrls(md), ["https://cell.lc-fixture.dev/feed", "https://anchor.lc-fixture.dev/x", "https://text.lc-fixture.dev/y"]);
  });

  it("isCheckable rejects local, placeholder and non-http URLs", () => {
    for (const url of ["http://localhost/", "http://127.0.0.1:8080/x", "https://intranet/", "https://example.com/", "https://sub.example.org/x", "https://host.internal/x", "javascript:alert(1)", "/relative", "https://api.x.org/{id}"]) assert.equal(isCheckable(url), false, url);
    assert.equal(isCheckable("https://www.anthropic.com/news"), true);
  });

  it("(a) registry: feed URL and homepage of every source", () => {
    const { sources } = loadFixtureRegistry();
    const targets = registryTargets(sources);
    assert.ok(targets.length >= sources.length);
    assert.ok(sources.every((s) => targets.some((t) => t.url === s.url)));
    assert.deepEqual(
      registryTargets([makeSource({ id: "s1", url: "https://s1.lc-fixture.dev/feed.xml", homepage: "https://s1.lc-fixture.dev/" }), makeSource({ id: "s2", url: "https://s2.lc-fixture.dev/blog", kind: "scrape" })]),
      [
        { url: "https://s1.lc-fixture.dev/feed.xml", refs: ["registry:s1:feed"] },
        { url: "https://s1.lc-fixture.dev/", refs: ["registry:s1:homepage"] },
        { url: "https://s2.lc-fixture.dev/blog", refs: ["registry:s2:page"] },
      ],
    );
  });

  it("(c) --data: article URLs of river.json, newest first, capped; any other JSON yields nothing", () => {
    const river = fixtureRiver;
    const targets = riverTargets(river, 25);
    assert.equal(targets.length, 25);
    assert.deepEqual(targets.map((t) => t.url), river.rows.slice(0, 25).map((r) => r[2]));
    assert.ok(targets.every((t) => t.refs[0] === "data:river"));
    assert.deepEqual(riverTargets({ rows: "x" }, 10), []);
    assert.deepEqual(riverTargets(null, 10), []);
  });

  it("mergeTargets: one entry per URL with all references", () => {
    const merged = mergeTargets([target("https://a.lc-fixture.dev/", "registry:a:homepage"), target("http://localhost/x")], [target("https://a.lc-fixture.dev/", "docs:README.md"), target("https://b.lc-fixture.dev/", "docs:docs/DESIGN.md")]);
    assert.deepEqual(merged, [
      { url: "https://a.lc-fixture.dev/", refs: ["registry:a:homepage", "docs:README.md"] },
      { url: "https://b.lc-fixture.dev/", refs: ["docs:docs/DESIGN.md"] },
    ]);
  });
});

describe("check-links: checking", () => {
  it("HEAD first; a 2xx HEAD is enough", async () => {
    const { deps, clock, net } = harness(() => respond(null, 200));
    const r = await clock.settle(checkLink(target("https://ok.lc-fixture.dev/a"), deps));
    assert.deepEqual([r.status, r.httpStatus, r.method], ["ok", 200, "HEAD"]);
    assert.deepEqual(net.requests.map((q) => q.method), ["HEAD"]);
  });

  it("falls back to GET when the server refuses HEAD", async () => {
    const { deps, clock, net } = harness((req) => (req.method === "HEAD" ? respond(null, 405) : respond("<html>fine</html>", 200)));
    const r = await clock.settle(checkLink(target("https://nohead.lc-fixture.dev/a"), deps));
    assert.deepEqual([r.status, r.httpStatus, r.method], ["ok", 200, "GET"]);
    assert.deepEqual(net.requests.map((q) => q.method), ["HEAD", "GET"]);
  });

  it("classifies: 404 broken, 403 blocked, 5xx and timeouts flaky, DNS failure broken", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const cases: [Handler, string, number | undefined][] = [
      [() => respond(null, 404), "broken", 404],
      [() => respond(null, 410), "broken", 410],
      [() => respond(null, 403), "blocked", 403],
      [() => respond(null, 429, { "retry-after": "1" }), "blocked", 429],
      [() => respond(null, 503), "flaky", 503],
      [() => "hang", "flaky", undefined],
      [() => new TypeError("fetch failed"), "flaky", undefined],
      [() => dns, "broken", undefined],
    ];
    for (const [handler, status, code] of cases) {
      const { deps, clock, net } = harness(handler);
      const r = await clock.settle(checkLink(target("https://x.lc-fixture.dev/a"), deps, { timeoutMs: 2_000 }));
      assert.deepEqual([r.status, r.httpStatus], [status, code]);
      assert.ok(net.requests.length <= 3, "bounded: HEAD + at most 2 GETs");
    }
    assert.deepEqual(classify({ kind: "ok", status: 204, text: "", bytes: 0, contentType: "", charset: "", finalUrl: "x", attempts: 1 }), { status: "ok", httpStatus: 204 });
  });

  it("reports a link that answers from another host", async () => {
    const clock = createVirtualClock();
    const moved: typeof fetch = async () => {
      const res = respond(null, 200);
      Object.defineProperty(res, "url", { value: "https://new-home.lc-fixture.dev/a" });
      return res;
    };
    const r = await clock.settle(checkLink(target("https://old.lc-fixture.dev/a"), { fetch: moved, timers: clock, userAgent: "t" }));
    assert.deepEqual([r.status, r.movedTo], ["ok", "https://new-home.lc-fixture.dev/a"]);
  });

  it("checkAll: 2 per host, a polite pause between requests to one host, hosts in parallel", async () => {
    let active = 0;
    let peak = 0;
    const clock = createVirtualClock();
    const net = scriptedFetch(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => clock.setTimeout(r, 100));
      active--;
      return respond(null, 200);
    });
    const sameHost = Array.from({ length: 6 }, (_, i) => target(`https://one.lc-fixture.dev/p${i}`));
    const others = Array.from({ length: 5 }, (_, i) => target(`https://h${i}.lc-fixture.dev/`));
    const doneAt = new Map<string, number>();
    const results = await clock.settle(checkAll([...sameHost, ...others], { fetch: net.fetch, timers: clock, userAgent: "t" }, { delayMs: 300, onResult: (r) => doneAt.set(r.url, clock.now()) }));
    assert.equal(results.length, 11);
    assert.ok(results.every((r) => r.status === "ok"));
    assert.ok(peak >= 5 && peak <= 7, `hosts run in parallel (peak ${peak})`);
    // 6 URLs on one host, 2 at a time, (100 ms request + 300 ms pause) per slot turn = 3 turns.
    assert.equal(clock.now(), 3 * 400);
    for (const o of others) assert.equal(doneAt.get(o.url), 400, "other hosts are not queued behind the busy one");
  });

  it("checkAll is bounded: past the time budget the rest is 'skipped', and it never throws", async () => {
    const { deps, clock, net } = harness(() => "hang");
    const targets = Array.from({ length: 8 }, (_, i) => target(`https://slow.lc-fixture.dev/p${i}`));
    const results = await clock.settle(checkAll(targets, deps, { budgetMs: 5_000, timeoutMs: 10_000, delayMs: 0 }));
    assert.equal(clock.now(), 5_000);
    assert.deepEqual(results.map((r) => r.status), ["flaky", "flaky", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    assert.equal(net.requests.length, 2);
  });
});

describe("check-links: report and exit code", () => {
  const results: LinkResult[] = [
    { url: "https://ok.lc-fixture.dev/", refs: ["registry:a:feed", "docs:README.md"], status: "ok", httpStatus: 200, method: "HEAD" },
    { url: "https://moved.lc-fixture.dev/", refs: ["registry:b:homepage"], status: "ok", httpStatus: 200, method: "GET", movedTo: "https://elsewhere.lc-fixture.dev/" },
    { url: "https://gone.lc-fixture.dev/page", refs: ["docs:docs/DESIGN.md"], status: "broken", httpStatus: 404, method: "GET", detail: "HTTP 404" },
    { url: "https://wall.lc-fixture.dev/", refs: ["registry:c:feed"], status: "blocked", httpStatus: 403, method: "GET", detail: "HTTP 403" },
    { url: "https://slow.lc-fixture.dev/", refs: ["data:river"], status: "flaky", detail: "timeout after 10000 ms" },
    { url: "https://late.lc-fixture.dev/|x", refs: ["data:river"], status: "skipped", detail: "time budget exhausted" },
  ];
  const report = buildReport(results, "2026-11-19T21:00:00.000Z");

  it("totals per group and overall; problems sorted first", () => {
    assert.deepEqual(report.totals, { ok: 2, broken: 1, flaky: 1, blocked: 1, skipped: 1, all: 6, moved: 1, archiveOnly: 0 });
    assert.deepEqual(report.groups.registry, { ok: 2, broken: 0, flaky: 0, blocked: 1, skipped: 0 });
    assert.deepEqual(report.groups.docs, { ok: 1, broken: 1, flaky: 0, blocked: 0, skipped: 0 });
    assert.deepEqual(report.groups.data, { ok: 0, broken: 0, flaky: 1, blocked: 0, skipped: 1 });
    assert.deepEqual(report.results.map((r) => r.status), ["broken", "flaky", "blocked", "skipped", "ok", "ok"]);
    assert.equal(JSON.parse(JSON.stringify(report)).results.length, 6);
  });

  it("summary table and Markdown report", () => {
    const table = summaryTable(report);
    assert.match(table, /^group\s+total\s+ok\s+broken\s+flaky\s+blocked\s+skipped\n/);
    assert.match(table, /registry\s+3\s+2\s+0\s+0\s+1\s+0/);
    assert.match(table, /ALL \(unique\)\s+6\s+2\s+1\s+1\s+1\s+1$/);
    const md = reportMarkdown(report);
    assert.match(md, /## Broken \(1\)/);
    assert.match(md, /\| `https:\/\/gone\.lc-fixture\.dev\/page` \| 404 \| `HTTP 404` \| docs:docs\/DESIGN\.md \|/);
    assert.match(md, /## Moved \(1\)/);
    assert.match(md, /now at `https:\/\/elsewhere\.lc-fixture\.dev\/`/);
    assert.ok(md.includes("`https://late.lc-fixture.dev/ x`"), "pipes cannot break the table");
  });

  it("SEC-5: a redirect target or error text chosen by a remote host cannot inject Markdown into the job summary", () => {
    const evil = "https://evil.example/x/[Action-required:-re-authorize-GitHub-Pages](https://evil.example/login)";
    const hostile: LinkResult[] = [
      { url: "https://moved.lc-fixture.dev/", refs: ["registry:b:homepage"], status: "ok", httpStatus: 200, method: "GET", movedTo: evil },
      { url: "https://moved2.lc-fixture.dev/", refs: ["registry:c:feed"], status: "ok", httpStatus: 200, method: "GET", movedTo: "https://evil.example/`](https://evil.example/a) <img src=x> | @org/team #1" },
      { url: "https://flaky.lc-fixture.dev/", refs: ["docs:[click](javascript:alert(1))<img src=x>"], status: "flaky", detail: "fetch failed: see [the fix](https://evil.example/fix) and #1 @maintainer\n| injected | row |" },
    ];
    const md = reportMarkdown(buildReport(hostile, "t"));
    // The URL is shown, whole and inert, inside a code span ...
    assert.ok(md.includes(`now at \`${evil}\``));
    // ... and nowhere does link syntax, HTML or a table break survive outside one.
    const outside = md.replace(/```[\s\S]*?```/g, "TABLE").replace(/`[^`\n]*`/g, "CODE");
    assert.doesNotMatch(outside, /\]\(|<img|evil\.example|@maintainer|@org|#1\b/);
    for (const line of md.split("\n").filter((l) => l.startsWith("| `"))) assert.equal(line.split("|").length, 6, line);
    assert.ok(!md.includes("injected | row"));
  });

  it("never fails on third-party flakiness unless --strict", () => {
    assert.equal(exitCode(report, false), 0);
    assert.equal(exitCode(report, true), 1);
    const clean = buildReport(results.filter((r) => r.status === "ok" || r.status === "blocked" || r.status === "skipped"), "t");
    assert.equal(exitCode(clean, true), 0, "bot walls and skipped URLs are not failures even in strict mode");
  });
});

describe("check-links: docs/archive (historical records)", () => {
  it("docTargets: README and docs/*.md are 'docs'; docs/archive/** (recursive) is 'archive'; other sub-directories are not read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-archive-"));
    try {
      const write = (rel: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      };
      write("README.md", "Site: https://live.lc-fixture.dev/ and https://both.lc-fixture.dev/x");
      write("docs/DESIGN.md", "See https://design.lc-fixture.dev/spec");
      write("docs/notes.txt", "https://not-markdown.lc-fixture.dev/");
      write("docs/other/DEEP.md", "https://unread.lc-fixture.dev/");
      write("docs/archive/FEED_AUDIT_2026-09-21.md", "Dead then, dead now: https://dead-feed.lc-fixture.dev/rss and https://both.lc-fixture.dev/x");
      write("docs/archive/2026/REVIEW.md", "https://old-review.lc-fixture.dev/a");
      const targets = await docTargets(root);
      assert.deepEqual(targets, [
        { url: "https://live.lc-fixture.dev/", refs: ["docs:README.md"] },
        { url: "https://both.lc-fixture.dev/x", refs: ["docs:README.md"] },
        { url: "https://design.lc-fixture.dev/spec", refs: ["docs:docs/DESIGN.md"] },
        { url: "https://old-review.lc-fixture.dev/a", refs: ["archive:docs/archive/2026/REVIEW.md"] },
        { url: "https://dead-feed.lc-fixture.dev/rss", refs: ["archive:docs/archive/FEED_AUDIT_2026-09-21.md"] },
        { url: "https://both.lc-fixture.dev/x", refs: ["archive:docs/archive/FEED_AUDIT_2026-09-21.md"] },
      ]);
      const merged = mergeTargets(targets);
      assert.deepEqual(merged.filter(isArchiveOnly).map((t) => t.url), ["https://old-review.lc-fixture.dev/a", "https://dead-feed.lc-fixture.dev/rss"]);
      assert.equal(isArchiveOnly(merged.find((t) => t.url === "https://both.lc-fixture.dev/x") as LinkTarget), false, "a URL a live document also cites is a live URL");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a repository without docs/archive (or without docs) yields no archive targets and does not throw", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-noarchive-"));
    try {
      assert.deepEqual(await docTargets(root), []);
      fs.mkdirSync(path.join(root, "docs"));
      fs.writeFileSync(path.join(root, "docs", "A.md"), "https://a.lc-fixture.dev/");
      assert.deepEqual(await docTargets(root), [{ url: "https://a.lc-fixture.dev/", refs: ["docs:docs/A.md"] }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const results: LinkResult[] = [
    { url: "https://ok.lc-fixture.dev/", refs: ["registry:a:feed"], status: "ok", httpStatus: 200, method: "HEAD" },
    { url: "https://gone.lc-fixture.dev/page", refs: ["docs:docs/DESIGN.md"], status: "broken", httpStatus: 404, method: "GET", detail: "HTTP 404" },
    { url: "https://dead-feed.lc-fixture.dev/rss", refs: ["archive:docs/archive/FEED_AUDIT_2026-09-21.md", "archive:docs/archive/UPGRADE_PLAN.md"], status: "broken", httpStatus: 404, method: "GET", detail: "HTTP 404" },
    { url: "https://slow-then.lc-fixture.dev/", refs: ["archive:docs/archive/FEED_AUDIT_2026-09-21.md"], status: "flaky", detail: "timeout after 10000 ms" },
    { url: "https://fine-then.lc-fixture.dev/", refs: ["archive:docs/archive/FEED_AUDIT_2026-09-21.md"], status: "ok", httpStatus: 200, method: "HEAD", movedTo: "https://elsewhere.lc-fixture.dev/" },
    { url: "https://cited-twice.lc-fixture.dev/", refs: ["archive:docs/archive/UPGRADE_PLAN.md", "registry:b:homepage"], status: "broken", httpStatus: 410, method: "GET", detail: "HTTP 410" },
  ];
  const report = buildReport(results, "2026-11-20T00:00:00.000Z");

  it("archive-only failures are checked and grouped, but are not 'broken' in the totals", () => {
    assert.deepEqual(report.totals, { ok: 1, broken: 2, flaky: 0, blocked: 0, skipped: 0, all: 6, moved: 0, archiveOnly: 3 });
    assert.deepEqual(report.groups[ARCHIVE_GROUP], { ok: 1, broken: 2, flaky: 1, blocked: 0, skipped: 0 }, "the archive group shows what was actually measured");
    assert.deepEqual(report.groups.registry, { ok: 1, broken: 1, flaky: 0, blocked: 0, skipped: 0 }, "a URL the registry also cites still counts there");
    assert.equal(report.results.length, 6, "every archive URL is in the JSON report with its real status");
    assert.equal(report.results.find((r) => r.url === "https://dead-feed.lc-fixture.dev/rss")?.status, "broken");
  });

  it("the summary and the Markdown report list them separately", () => {
    const table = summaryTable(report);
    assert.match(table, /archive \(not counted\)\s+4\s+1\s+2\s+1\s+0\s+0/);
    assert.match(table, /ALL \(unique, archive-only excluded\)\s+3\s+1\s+2\s+0\s+0\s+0$/);
    const md = reportMarkdown(report);
    assert.match(md, /6 unique URLs \(3 referenced only from docs\/archive\/, not counted\)/);
    assert.match(md, /## Broken \(2\)/);
    const broken = md.slice(md.indexOf("## Broken"), md.indexOf("## Archive: not reachable"));
    assert.ok(broken.includes("gone.lc-fixture.dev") && broken.includes("cited-twice.lc-fixture.dev"));
    assert.ok(!broken.includes("dead-feed.lc-fixture.dev"));
    assert.doesNotMatch(md, /## Flaky|## Moved/, "an archive-only timeout or move is not a finding");
    const archive = md.slice(md.indexOf("## Archive: not reachable (2)"));
    assert.ok(archive.includes("`https://dead-feed.lc-fixture.dev/rss`") && archive.includes("`https://slow-then.lc-fixture.dev/`"));
    assert.ok(!archive.includes("fine-then.lc-fixture.dev"), "reachable archive links are not listed");
    assert.match(archive, /not counted as broken and never fails the run/);
  });

  it("--strict ignores archive-only failures and still fails on a live broken link", () => {
    const archiveOnly = buildReport(results.filter((r) => isArchiveOnly(r) || r.status === "ok"), "t");
    assert.equal(archiveOnly.totals.broken + archiveOnly.totals.flaky, 0);
    assert.equal(exitCode(archiveOnly, true), 0);
    assert.equal(exitCode(report, true), 1);
    assert.equal(isArchiveOnly({ refs: [] }), false);
  });
});
