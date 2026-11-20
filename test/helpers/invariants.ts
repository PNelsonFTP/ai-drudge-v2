// Assert-style wrappers around shared/guards.ts + shared/invariants.ts for tests and the check-data
// gate. The checks themselves live in shared/ (pure); this file adds node:assert reporting.
//
//   assertValidBundle({ front, rest, river, ... })   guards + every invariant, throws with all problems
//   bundleProblems(bundle)                           same, but returns the list (gate / reports)

import assert from "node:assert/strict";
import {
  validateBriefFile,
  validateEditionFront,
  validateEditionRest,
  validateHealthFile,
  validateRiverFile,
  validateSourcesFile,
  validateStatusFile,
  validateStocksFile,
} from "../../shared/guards";
import { checkBundle, type DataBundle } from "../../shared/invariants";

export { checkAux, checkBundle, checkFront, checkRest, checkRiver, type DataBundle } from "../../shared/invariants";

/** Structural (guard) problems of every file present in the bundle. */
export function guardProblems(b: DataBundle): string[] {
  const checks: (string | null)[] = [
    validateEditionFront(b.front),
    b.rest ? validateEditionRest(b.rest) : null,
    b.river ? validateRiverFile(b.river) : null,
    b.health ? validateHealthFile(b.health) : null,
    b.sources ? validateSourcesFile(b.sources) : null,
    b.brief ? validateBriefFile(b.brief) : null,
    b.stocks ? validateStocksFile(b.stocks) : null,
    b.status ? validateStatusFile(b.status) : null,
  ];
  return checks.filter((c): c is string => c !== null);
}

/** Guards first; when they pass, the cross-reference invariants. [] = valid. */
export function bundleProblems(b: DataBundle): string[] {
  const g = guardProblems(b);
  return g.length ? g : checkBundle(b);
}

/** Throws an AssertionError listing every problem (first 25) when the bundle is not valid. */
export function assertValidBundle(b: DataBundle, label = "bundle"): void {
  const problems = bundleProblems(b);
  assert.equal(
    problems.length,
    0,
    `${label}: ${problems.length} contract problem(s):\n  - ${problems.slice(0, 25).join("\n  - ")}${problems.length > 25 ? "\n  ..." : ""}`,
  );
}
