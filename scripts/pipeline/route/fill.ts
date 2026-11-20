// Starvation fill: a section that has fewer than `minItems` rows is topped up from a reserve
// (rank order) - but only up to minItems. A quiet section shows a few older rows instead of
// nothing; a healthy one never shows stale rows just to look full.

export interface FillResult<T> {
  rows: T[];
  /** Reserve items that were added, in the order they were added. */
  used: T[];
  /** Reserve items that were not needed (or not accepted). */
  unused: T[];
}

/**
 * Top up `rows` to `minItems` from `reserve`. `accept` lets the caller keep its own constraints
 * (diversity caps) while filling; it sees the rows chosen so far.
 */
export function starvationFill<T>(
  rows: readonly T[],
  reserve: readonly T[],
  minItems: number,
  accept: (candidate: T, rows: readonly T[]) => boolean = () => true,
): FillResult<T> {
  const out = [...rows];
  const used: T[] = [];
  const unused: T[] = [];
  for (const candidate of reserve) {
    if (out.length < minItems && accept(candidate, out)) {
      out.push(candidate);
      used.push(candidate);
    } else {
      unused.push(candidate);
    }
  }
  return { rows: out, used, unused };
}
