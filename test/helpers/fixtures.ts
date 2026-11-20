// Node-side fixture loaders for pipeline tests (WP2..WP6). Uses node:fs - do NOT import from src/.
//
//   test/fixtures/items-2026-11-19.json      2,297 items of a full live fetch (2026-11-19 20:59Z)
//   test/fixtures/registry-2026-11-19.json   SourceDef[] + PublisherDef[] matching the corpus
//                                            (derived from the V1 source list; ids = slugify(V1 name))
//   test/fixtures/feeds/*                    10 raw feed bodies + index.json
//   test/fixtures/v1/2026-11-19/*            the V1 production payload of 20:08Z + feed.xml
//   test/fixtures/v1/sources-v1.json         V1 SOURCES + scrapers: name, url, category, priority
//   test/fixtures/v2/*.json                  the v2 data set of a frozen LIVE build (see
//                                            test/helpers/fixtureData.ts; `npm run fixture:refresh`)
//   test/fixtures/bridged-2026-11-19/*       front.json + rest.json of the edition bridged from the
//                                            V1 payload of 2026-11-19 20:08Z. FROZEN: it belongs to
//                                            the corpus and registry of the same day, and the route
//                                            regression tests pin its stories (loadBridgedEdition)
//
// NOTE on the corpus: it was captured from V1's fetcher, so titles are already entity-decoded,
// summaries are already plain text cut to 320 chars, and links are already unwrapped/normalised.
// `publishedRaw` is the original feed string. Use test/fixtures/feeds/* for raw-markup cases.
// Ten "Sakana AI" records carry RELATIVE links ("/jfinbench/") exactly as V1 emitted them (a V1 bug:
// V2 ingest resolves links against the feed URL). They violate the RawItem guarantee on purpose -
// normalize must drop them as "invalid". 15 records end in /index.html (canonicalUrl strips it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawItem, Registry } from "../../scripts/pipeline/types";
import type { PublisherDef, SourceDef } from "../../scripts/registry/types";
import type { EditionFront, EditionRest, SourcesFile } from "../../shared/contract";
import { mergeEdition, type Edition } from "../../shared/select";

export const FIXTURES_DIR: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

/** Absolute path inside test/fixtures. */
export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURES_DIR, ...parts);
}

export function readFixtureText(...parts: string[]): string {
  return fs.readFileSync(fixturePath(...parts), "utf8");
}

export function readFixtureJson<T>(...parts: string[]): T {
  return JSON.parse(readFixtureText(...parts)) as T;
}

/** One record of items-2026-11-19.json: a RawItem plus provenance. */
export interface CorpusRecord extends RawItem {
  /** V1 display name of the source. */
  sourceName: string;
  /** What V1 made of the item (id = hashId(link); V1 category / priority; V1-parsed ISO date). */
  v1: { id: string; category: string; priority: string; publishedAt: string | null };
}

let corpusCache: CorpusRecord[] | null = null;

/** The full corpus with provenance (cached; treat as read-only). */
export function loadCorpus(): readonly CorpusRecord[] {
  corpusCache ??= readFixtureJson<CorpusRecord[]>("items-2026-11-19.json");
  return corpusCache;
}

/** The corpus as plain RawItem[] (fresh objects; safe to mutate). */
export function loadRawItems(): RawItem[] {
  return loadCorpus().map((r) => ({
    sourceId: r.sourceId,
    title: r.title,
    link: r.link,
    publishedRaw: r.publishedRaw,
    summaryHtml: r.summaryHtml,
  }));
}

/** Registry (207 sources, incl. 15 with no items in the corpus) whose ids match the corpus sourceIds. */
export function loadFixtureRegistry(): Registry {
  const raw = readFixtureJson<{ sources: SourceDef[]; publishers: PublisherDef[] }>("registry-2026-11-19.json");
  return { sources: raw.sources, publishers: raw.publishers };
}

/** Directory (under test/fixtures) of the frozen bridged edition. */
export const BRIDGED_DIR = "bridged-2026-11-19";
/** Build time of the bridged edition - the V1 production payload it was bridged from. */
export const BRIDGED_GENERATED_AT = "2026-11-19T20:08:38.159Z";

/** front.json + rest.json of the bridged 2026-11-19 edition (fresh objects). */
export function loadBridgedFiles(): { front: EditionFront; rest: EditionRest } {
  return { front: readFixtureJson<EditionFront>(BRIDGED_DIR, "front.json"), rest: readFixtureJson<EditionRest>(BRIDGED_DIR, "rest.json") };
}

/**
 * The bridged 2026-11-19 edition, merged: the 237 stories of that day's front page, whose sources
 * are the ids of loadFixtureRegistry(). For tests that pin that day's stories on purpose (the
 * editorial defects the route rules were written against) - everything else uses fixtureEdition().
 */
export function loadBridgedEdition(): Edition {
  const { front, rest } = loadBridgedFiles();
  return mergeEdition(front, rest);
}

/**
 * A registry with the sources of a sources.json (the inverse of emit's sourcesFile.ts, as far as
 * the file goes: ids, names, urls, kinds, homes, tiers, tags, paused). For tests that need the
 * registry a FIXTURE was built from - e.g. feeds.opml for the gate - without depending on the
 * current registry, which moves on after the fixture is frozen. Publishers carry their display
 * name only (no hosts); policy fields (routing, attribution ...) are the defaults.
 */
export function registryOfSourcesFile(file: SourcesFile): Registry {
  const sources: SourceDef[] = file.sources.map((s) => ({
    id: s.id,
    name: s.name,
    publisher: s.publisherId,
    url: s.feedUrl ?? s.homepage ?? "",
    ...(s.homepage ? { homepage: s.homepage } : {}),
    kind: s.kind,
    scope: s.scope,
    home: s.home,
    tier: s.tier,
    ...(s.tags?.length ? { tags: [...s.tags] } : {}),
    ...(s.aliases?.length ? { aliases: [...s.aliases] } : {}),
    ...(s.paused ? { status: "paused" as const } : {}),
  }));
  const publishers = new Map<string, PublisherDef>();
  for (const s of file.sources) if (!publishers.has(s.publisherId)) publishers.set(s.publisherId, { id: s.publisherId, name: s.publisher, hosts: [] });
  return { sources, publishers: [...publishers.values()] };
}

export interface V1SourceRecord {
  name: string;
  url: string;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  type: "feed" | "scrape";
}

/** V1's 203 feeds + 4 scrapers in V1 order (registry.test.ts: every name must resolve to a V2 id). */
export function loadV1Sources(): V1SourceRecord[] {
  return readFixtureJson<V1SourceRecord[]>("v1", "sources-v1.json");
}

export interface FeedFixture {
  file: string;
  format: "rss" | "atom" | "rdf" | "html";
  sourceName: string;
  sourceId: string;
  url: string;
  httpStatus: number;
  contentType: string | null;
  bytes: number;
  /** Number of <item>/<entry> elements in the body. */
  itemCount: number;
  capturedAt: string;
  notes: string;
}

/** test/fixtures/feeds/index.json */
export function feedFixtures(): FeedFixture[] {
  return readFixtureJson<FeedFixture[]>("feeds", "index.json");
}

/** Raw body of a feed fixture by file name (as listed in feedFixtures()). */
export function readFeedFixture(file: string): string {
  return readFixtureText("feeds", file);
}

/** A fetch-compatible Response for a feed fixture (status + content-type from the index). */
export function feedFixtureResponse(file: string): Response {
  const meta = feedFixtures().find((f) => f.file === file);
  if (!meta) throw new Error(`unknown feed fixture: ${file}`);
  return new Response(readFeedFixture(file), {
    status: meta.httpStatus,
    headers: meta.contentType ? { "content-type": meta.contentType } : {},
  });
}

/**
 * A fake `fetch` for ingest tests: serves `routes[url]` (a Response, a body string, or a function)
 * and rejects for every other URL. `calls` records requested URLs in order.
 */
export function fakeFetch(routes: Record<string, Response | string | ((url: string) => Response | Promise<Response>)>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fakeFetch: no route for ${url}`);
    if (typeof route === "function") return route(url);
    if (typeof route === "string") return new Response(route, { status: 200 });
    return route.clone();
  };
  return Object.assign(impl as typeof fetch, { calls });
}
