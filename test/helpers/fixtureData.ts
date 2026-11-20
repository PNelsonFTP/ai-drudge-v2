// The committed v2 fixture (test/fixtures/v2/*.json - the same files `npm run data:fixture` copies
// to public/data/v2/), imported as typed values. PURE: JSON imports only, so it works under tsx
// (tests) and under Vite.
//
// The fixture is a FROZEN LIVE BUILD, replaced by `npm run fixture:refresh` whenever a newer build
// is frozen (scripts/tools/fixture-refresh.ts; provenance in test/fixtures/v2.manifest.json). So:
//   - never pin an id, a headline or a count of the fixture in a test. Select by property
//     (`fixtureStory("paywalledRow")`, `fixtureSource("carried")`, storyWhere(...)) and derive the
//     expected value from the same data;
//   - the cases those selectors need are guaranteed: test/fixtures.test.ts and the refresh tool
//     both refuse a fixture without them (test/helpers/fixtureCases.ts).
// The bridged V1 edition of 2026-11-19 that pipeline regression tests pin is a different data set:
// test/fixtures/bridged-2026-11-19/ (test/helpers/fixtures.ts loadBridgedEdition).

import frontJson from "../fixtures/v2/front.json";
import restJson from "../fixtures/v2/rest.json";
import riverJson from "../fixtures/v2/river.json";
import healthJson from "../fixtures/v2/health.json";
import sourcesJson from "../fixtures/v2/sources.json";
import briefJson from "../fixtures/v2/brief.json";
import stocksJson from "../fixtures/v2/stocks.json";
import statusJson from "../fixtures/v2/status.json";
import type { ArticleId, BriefFile, EditionFront, EditionRest, FeedHealthRow, HealthFile, RiverFile, SourceId, SourceInfo, SourcesFile, StatusFile, StocksFile } from "../../shared/contract";
import type { DataBundle } from "../../shared/invariants";
import { mergeEdition, type Edition } from "../../shared/select";
import { CASE_LABELS, fixtureCasesOf, type FixtureCases, type HealthCases, type StoryCases } from "./fixtureCases";

export const fixtureFront = frontJson as unknown as EditionFront;
export const fixtureRest = restJson as unknown as EditionRest;
export const fixtureRiver = riverJson as unknown as RiverFile;
export const fixtureHealth = healthJson as unknown as HealthFile;
export const fixtureSources = sourcesJson as unknown as SourcesFile;
export const fixtureBrief = briefJson as unknown as BriefFile;
export const fixtureStocks = stocksJson as unknown as StocksFile;
export const fixtureStatus = statusJson as unknown as StatusFile;

/** generatedAt of the fixture build (whatever build was frozen last - derive, never pin). */
export const FIXTURE_GENERATED_AT: string = fixtureFront.generatedAt;
export const FIXTURE_GENERATED_MS: number = Date.parse(FIXTURE_GENERATED_AT);

/** All fixture files as a DataBundle (for assertValidBundle and emit comparisons). */
export const fixtureBundle: Required<{ [K in keyof DataBundle]: NonNullable<DataBundle[K]> }> = {
  front: fixtureFront,
  rest: fixtureRest,
  river: fixtureRiver,
  health: fixtureHealth,
  sources: fixtureSources,
  brief: fixtureBrief,
  stocks: fixtureStocks,
  status: fixtureStatus,
};

/** The merged fixture edition: complete (front + rest) by default, homepage rows only with `false`. */
export function fixtureEdition(complete = true): Edition {
  return mergeEdition(fixtureFront, complete ? fixtureRest : null);
}

/** The cases of the committed fixture (test/helpers/fixtureCases.ts): story keys and source ids by property. */
export const fixtureCases: FixtureCases = fixtureCasesOf(fixtureBundle);

/** Key of the first fixture story that is an example of `name`; throws when the fixture has none. */
export function fixtureStory(name: keyof StoryCases): ArticleId {
  const id = fixtureCases.stories[name][0];
  if (id === undefined) throw new Error(`fixture: no ${CASE_LABELS[name]}`);
  return id;
}

/** Id of the first fixture source that is an example of `name`; throws when the fixture has none. */
export function fixtureSource(name: keyof HealthCases): SourceId {
  const id = fixtureCases.health[name][0];
  if (id === undefined) throw new Error(`fixture: no ${CASE_LABELS[name]}`);
  return id;
}

/** sources.json entry of a fixture source; throws on an unknown id. */
export function fixtureSourceInfo(id: SourceId): SourceInfo {
  const s = fixtureSources.sources.find((x) => x.id === id);
  if (!s) throw new Error(`fixture: source ${id} is not in sources.json`);
  return s;
}

/** health.json row of a fixture source; throws when the source has none (a paused source). */
export function fixtureHealthRow(id: SourceId): FeedHealthRow {
  const f = fixtureHealth.feeds.find((x) => x.id === id);
  if (!f) throw new Error(`fixture: source ${id} has no health row`);
  return f;
}
