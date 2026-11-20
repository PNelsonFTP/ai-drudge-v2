import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SECTIONS } from "../../shared/sections";
import { makeSource } from "../../test/helpers/factories";
import { PUBLISHERS, REMOVED, SOURCES } from "../registry/index";
import type { PublisherDef, SourceDef } from "../registry/types";
import { extractUrls } from "./check-links";
import { DEFAULT_HEALTH, DEFAULT_OUT, NO_STATUS, cell, link, loadStatus, parseArgs, parseStatusData, renderSourcesDoc, shortTime, sortSources, type RemovedEntry, type StatusData } from "./gen-sources-doc";

const PUBS: PublisherDef[] = [
  { id: "acme", name: "Acme Labs", hosts: ["acme.gsd-fixture.dev"] },
  { id: "wire", name: "The Wire", hosts: ["wire.gsd-fixture.dev"] },
];
const SRC: SourceDef[] = [
  makeSource({ id: "wire-policy", name: "Wire Policy", publisher: "wire", url: "https://wire.gsd-fixture.dev/policy.xml", home: "policy", tier: 3, scope: "general", note: "Kept: AI | rules <only>.\nSecond line.", tags: ["press", "finreg"] }),
  makeSource({ id: "acme-news", name: "Acme News", publisher: "acme", url: "https://acme.gsd-fixture.dev/feed.xml", homepage: "https://acme.gsd-fixture.dev/", home: "models", tier: 1, tags: ["lab"] }),
  makeSource({ id: "acme-blog", name: "acme blog", publisher: "acme", url: "https://acme.gsd-fixture.dev/blog", kind: "scrape", home: "models", tier: 3 }),
  makeSource({ id: "zeta", name: "Zeta", publisher: "acme", url: "https://acme.gsd-fixture.dev/zeta.xml", home: "models", tier: 3 }),
  makeSource({ id: "acme-old", name: "Acme Old", publisher: "acme", url: "https://acme.gsd-fixture.dev/old.xml", home: "models", tier: 2, status: "paused", note: "Paused: feed gone." }),
  makeSource({ id: "wire-query", name: "Wire query", publisher: "wire", url: "https://wire.gsd-fixture.dev/rss?q=(a|b)+c d", kind: "query", home: "policy", tier: 4 }),
];
const GONE: RemovedEntry[] = [
  { name: "Zed Feed", url: "https://dead.gsd-fixture.dev/z.rss", reason: "dead", detail: "404 since March.", coveredBy: "acme-news" },
  { name: "Alpha Feed", url: "http://dead.gsd-fixture.dev/a.rss", reason: "duplicate", detail: "Same body as Acme News." },
];
const HEALTH = {
  schemaVersion: 2,
  buildId: "2026-11-20T02:24:40.961Z",
  generatedAt: "2026-11-20T02:24:40.961Z",
  feeds: [
    { id: "acme-news", ok: true, status: "ok", count: 15, failStreak: 0, lastOkAt: "2026-11-20T02:24:40.961Z" },
    { id: "acme-blog", ok: true, status: "ok", count: 7, failStreak: 0, lastOkAt: "2026-11-20T02:24:40.961Z" },
    { id: "zeta", ok: false, status: "carried", count: 3, failStreak: 2, lastOkAt: "2026-11-20T01:10:37.994Z", error: "http", lastError: "HTTP 502", carried: true },
    { id: "wire-policy", ok: false, status: "failing", count: 0, failStreak: 9, lastOkAt: null, error: "timeout", lastError: "timeout after 16000 ms" },
    { id: "wire-query", ok: true, status: "ok", count: 20, failStreak: 0, lastOkAt: "2026-11-20T02:24:40.961Z" },
    "junk",
    { status: "ok" },
  ],
};
const status = (): StatusData => parseStatusData(HEALTH, "public/data/v2/health.json") as StatusData;
const doc = (over: Partial<Parameters<typeof renderSourcesDoc>[0]> = {}): string => renderSourcesDoc({ sources: SRC, publishers: PUBS, removed: GONE, status: status(), ...over });
const rowOf = (text: string, id: string): string => text.split("\n").find((l) => l.startsWith("| ") && l.includes(`\`${id}\``) && l.includes("<br>")) ?? "";

describe("gen-sources-doc: status data", () => {
  it("reads a health.json: status, last OK, items, the failure detail, and generatedAt", () => {
    const s = status();
    assert.equal(s.kind, "health");
    assert.equal(s.generatedAt, "2026-11-20T02:24:40.961Z");
    assert.equal(s.byId.size, 5, "malformed rows are skipped");
    assert.deepEqual(s.byId.get("zeta"), { status: "carried", ok: false, lastOkAt: "2026-11-20T01:10:37.994Z", items: 3, detail: "HTTP 502" });
    assert.deepEqual(s.byId.get("acme-news"), { status: "ok", ok: true, lastOkAt: "2026-11-20T02:24:40.961Z", items: 15 });
  });

  it("reads a validate-feeds verdict file: the verdict is the status, there is no last OK and no timestamp", () => {
    const s = parseStatusData(
      [
        { id: "acme-news", name: "Acme News", url: "u", verdict: "OK", itemCount: 40, newestAgeDays: 0.2 },
        { id: "zeta", name: "Zeta", url: "u", verdict: "HTTP_502", httpStatus: 502 },
        { id: "wire-policy", name: "Wire", url: "u", verdict: "NOT_FEED", note: "text/html" },
        { name: "no id", verdict: "OK" },
      ],
      "audit.json",
    );
    assert.equal(s?.kind, "validation");
    assert.equal(s?.generatedAt, null);
    assert.deepEqual(s?.byId.get("acme-news"), { status: "OK", ok: true, lastOkAt: null, items: 40 });
    assert.deepEqual(s?.byId.get("zeta"), { status: "HTTP_502", ok: false, lastOkAt: null, items: null });
    assert.equal(s?.byId.get("wire-policy")?.detail, "text/html");
    assert.equal(s?.byId.size, 3);
  });

  it("anything else is not status data", () => {
    for (const x of [null, 3, "x", {}, { feeds: "x" }, [], [{ name: "x" }]]) assert.equal(parseStatusData(x, "f"), null);
  });

  it("loadStatus: the report wins, an unreadable report falls back to the health file, nothing readable means no status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-"));
    try {
      fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(HEALTH));
      fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify([{ id: "zeta", verdict: "OK", itemCount: 2 }]));
      fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
      const warnings: string[] = [];
      const warn = (m: string): void => void warnings.push(m);
      assert.equal((await loadStatus({ report: "audit.json", health: "health.json" }, dir, warn)).kind, "validation");
      assert.equal((await loadStatus({ report: null, health: "health.json" }, dir, warn)).origin, "health.json");
      assert.equal(warnings.length, 0);
      assert.equal((await loadStatus({ report: "broken.json", health: "health.json" }, dir, warn)).kind, "health");
      assert.equal((await loadStatus({ report: "missing.json", health: "missing-too.json" }, dir, warn)).kind, "none");
      assert.equal(warnings.length, 3);
      // A file outside the root is named by its file name only: no temp or home path in a committed document.
      const outside = await loadStatus({ report: null, health: path.join(dir, "health.json") }, path.join(dir, "sub"), warn);
      assert.equal(outside.origin, "health.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gen-sources-doc: the document", () => {
  it("groups by home section in homepage order; within a section by tier, then name", () => {
    const text = doc();
    const models = text.indexOf("### MODELS & LABS (4)");
    const policy = text.indexOf("### POLICY & REGULATION (2)");
    assert.ok(models > 0 && policy > models, "sections follow the SECTIONS order");
    const ids = [...text.slice(models, policy).matchAll(/^\| [^|]*<br>`([a-z0-9-]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(ids, ["acme-news", "acme-old", "acme-blog", "zeta"], "tier 1, tier 2, then tier 3 by name (case-insensitive)");
    assert.doesNotMatch(text, /### INDUSTRY/, "a section without sources has no heading");
    assert.deepEqual(sortSources(SRC).map((s) => s.id), ["acme-news", "acme-old", "acme-blog", "wire-policy", "zeta", "wire-query"]);
  });

  it("a row carries name, id, publisher, kind, tier, scope, status, last OK, items, links, tags and the note", () => {
    const text = doc();
    assert.equal(
      rowOf(text, "acme-news"),
      "| Acme News<br>`acme-news`<br>Acme Labs | `rss` | 1 | ai | ok | 2026-11-20 02:24Z | 15 | [feed](<https://acme.gsd-fixture.dev/feed.xml>) [home](<https://acme.gsd-fixture.dev/>) | `lab` |  |",
    );
    assert.match(rowOf(text, "acme-blog"), /\| `scrape` \| 3 \| ai \| ok \| 2026-11-20 02:24Z \| 7 \| \[page\]\(<https:\/\/acme\.gsd-fixture\.dev\/blog>\) \|/);
    assert.match(rowOf(text, "zeta"), /\| carried \(HTTP 502\) \| 2026-11-20 01:10Z \| 3 \|/);
    assert.match(rowOf(text, "wire-policy"), /\| general \| failing \(timeout after 16000 ms\) \| - \| 0 \|/);
    assert.match(rowOf(text, "wire-policy"), /\| `finreg` `press` \| Kept: AI \\\| rules &lt;only&gt;\. Second line\. \|$/, "tags sorted; the note is one escaped line");
    assert.match(rowOf(text, "acme-old"), /\| paused \| - \| - \|.*\| Paused: feed gone\. \|$/, "a paused source says so instead of a health status");
  });

  it("every table row has the column count of its header (a pipe or newline in the data cannot break a table)", () => {
    const lines = doc().split("\n");
    const cols = (l: string): number => l.replace(/\\\|/g, "").split("|").length;
    let header = 0;
    let rows = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("|")) continue;
      if (/^\|(?:-+:?\|)+$/.test(lines[i + 1] ?? "")) header = cols(lines[i]);
      assert.equal(cols(lines[i]), header, `line ${i + 1}: ${lines[i].slice(0, 80)}`);
      rows++;
    }
    assert.ok(rows > 15);
  });

  it("link destinations survive parentheses, pipes and spaces, and check-links reads them back as the registry URL", () => {
    assert.equal(link("feed", "https://wire.gsd-fixture.dev/rss?q=(a|b)+c d"), "[feed](<https://wire.gsd-fixture.dev/rss?q=(a%7Cb)+c%20d>)");
    assert.equal(link("home", undefined), "");
    const urls = extractUrls(doc());
    for (const s of SRC.filter((x) => x.id !== "wire-query")) assert.ok(urls.includes(s.url), s.url);
    assert.ok(urls.includes("https://wire.gsd-fixture.dev/rss?q=(a%7Cb)+c%20d"));
  });

  it("removed sources are listed by name with reason, detail and replacement - and their dead feeds are not link-checkable URLs", () => {
    const text = doc();
    const section = text.slice(text.indexOf("## Removed sources (2)"), text.indexOf("## How to add a source"));
    const rows = section.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| V1 name"));
    assert.deepEqual(rows, [
      "| Alpha Feed | `dead.gsd-fixture.dev/a.rss` | duplicate | Same body as Acme News. | - |",
      "| Zed Feed | `dead.gsd-fixture.dev/z.rss` | dead | 404 since March. | `acme-news` |",
    ]);
    assert.ok(!extractUrls(text).some((u) => u.includes("dead.gsd-fixture.dev")));
  });

  it("the summary counts sources, active ones, tiers and status per section, and lists what is not OK", () => {
    const text = doc();
    assert.match(text, /^6 sources \(5 active, 1 paused\) from 2 publishers/m);
    assert.match(text, /^\| \[MODELS & LABS\]\(#models\) \| 4 \| 3 \| 1 \| 1 \| 2 \| 0 \| 2 \| 1 \|$/m);
    assert.match(text, /^\| \[POLICY & REGULATION\]\(#policy\) \| 2 \| 2 \| 0 \| 0 \| 1 \| 1 \| 1 \| 1 \|$/m);
    assert.match(text, /^\| \*\*All\*\* \| 6 \| 5 \| 1 \| 1 \| 3 \| 1 \| 3 \| 2 \|$/m);
    assert.match(text, /^\| `scrape` \| 1 \|$/m);
    const notOk = text.slice(text.indexOf("### Not OK in the status data (2)"), text.indexOf("## Sources by home section"));
    assert.deepEqual([...notOk.matchAll(/`([a-z-]+)` \|/g)].map((m) => m[1]), ["wire-policy", "zeta"]);
    assert.match(text, /<a id="models"><\/a>/);
  });

  it("is deterministic: input order does not matter, and the only date is the generated-at line taken from the data", () => {
    const a = doc();
    const b = renderSourcesDoc({ sources: [...SRC].reverse(), publishers: [...PUBS].reverse(), removed: [...GONE].reverse(), status: status() });
    assert.equal(a, b);
    assert.match(a, /^Status columns: build health \(`public\/data\/v2\/health\.json`\), generated at 2026-11-20T02:24:40\.961Z\./m);
    // No clock: the current year-month-day never appears unless the data carries it.
    const today = new Date().toISOString().slice(0, 10);
    if (today !== "2026-11-20") assert.ok(!a.includes(today));
    const dated = a.split("\n").filter((l) => /\d{4}-\d{2}-\d{2}T/.test(l));
    assert.equal(dated.length, 1, "one full timestamp line");
  });

  it("without status data the columns say '-' and the header says so; with a validation report the header names it", () => {
    const none = doc({ status: NO_STATUS });
    assert.match(none, /^Status columns: no build health or validation report was available/m);
    assert.match(rowOf(none, "acme-news"), /\| ai \| - \| - \| - \|/);
    assert.doesNotMatch(none, /### Not OK in the status data/);
    assert.match(none, /^\| \*\*All\*\* \| 6 \| 5 \| 1 \| 1 \| 3 \| 1 \| - \| - \|$/m);
    const report = doc({ status: parseStatusData([{ id: "acme-news", verdict: "OK", itemCount: 40 }, { id: "zeta", verdict: "HTTP_502" }], "audit.json") as StatusData });
    assert.match(report, /^Status columns: feed validation report \(`audit\.json`; the report carries no timestamp\)/m);
    assert.match(rowOf(report, "acme-news"), /\| ai \| OK \| - \| 40 \|/);
    assert.match(rowOf(report, "zeta"), /\| ai \| HTTP_502 \| - \| - \|/);
  });

  it("ends with the how-to-add section, and a source homed in an unknown section is still listed", () => {
    const text = doc({ sources: [...SRC, { ...makeSource({ id: "stray", name: "Stray" }), home: "nowhere" as SourceDef["home"] }] });
    assert.match(text, /^## How to add a source$/m);
    assert.match(text, /npm run validate:feeds -- candidates\.json/);
    assert.match(text, /npm run docs:sources/);
    assert.match(text, /### UNKNOWN SECTION \(1\)/);
    assert.ok(rowOf(text, "stray"));
    assert.ok(text.endsWith("\n"));
  });

  it("helpers: cell() and shortTime()", () => {
    assert.equal(cell(" a | b \n <c> \\ "), "a \\| b &lt;c&gt; \\\\");
    assert.equal(cell(undefined), "");
    assert.equal(shortTime("2026-11-20T02:24:40.961Z"), "2026-11-20 02:24Z");
    assert.equal(shortTime("2026-11-19T20:24:40-06:00"), "2026-11-20 02:24Z");
    assert.equal(shortTime(null), "-");
    assert.equal(shortTime("not a date"), "-");
  });
});

describe("gen-sources-doc: the real registry", () => {
  const text = renderSourcesDoc({ sources: SOURCES, publishers: PUBLISHERS, removed: REMOVED, status: NO_STATUS });

  it("lists every source exactly once, under its home section, and every removed source", () => {
    const ids = [...text.matchAll(/^\| [^|]*<br>`([a-z0-9-]+)`/gm)].map((m) => m[1]);
    assert.equal(ids.length, SOURCES.length);
    assert.deepEqual([...ids].sort(), SOURCES.map((s) => s.id).sort());
    for (const sec of SECTIONS) {
      const n = SOURCES.filter((s) => s.home === sec.id).length;
      if (n > 0) assert.ok(text.includes(`### ${sec.label} (${n})`), sec.label);
    }
    for (const r of REMOVED) assert.ok(text.includes(`| ${cell(r.name)} |`), r.name);
    assert.doesNotMatch(text, /undefined|\[object |NaN/);
  });

  it("names nobody: no e-mail address in the generated document", () => {
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});

describe("gen-sources-doc: arguments", () => {
  it("defaults, flags and the VALIDATE_OUT environment variable", () => {
    assert.deepEqual(parseArgs([], {}), { out: DEFAULT_OUT, report: null, health: DEFAULT_HEALTH });
    assert.deepEqual(parseArgs([], { VALIDATE_OUT: " audit.json " }), { out: DEFAULT_OUT, report: "audit.json", health: DEFAULT_HEALTH });
    assert.deepEqual(parseArgs(["--out", "-", "--report", "r.json", "--health", "h.json"], { VALIDATE_OUT: "env.json" }), { out: "-", report: "r.json", health: "h.json" });
    assert.throws(() => parseArgs(["--nope"], {}), /unknown or incomplete argument: --nope/);
    assert.throws(() => parseArgs(["--out"], {}), /unknown or incomplete argument: --out/);
    assert.throws(() => parseArgs(["--out", "--report"], {}), /--out/);
  });
});
