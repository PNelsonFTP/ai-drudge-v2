// Diversity caps inside one section. V1 capped per FEED NAME, so twin feeds of one publisher
// (TechCrunch AI + Startups + Robotics, three arXiv listings) each got their own allowance, and an
// aggregator could restate half a section.
//
// Two caps, same number:
//   per PUBLISHER - the lead item's publisher may hold at most `maxPublisherShare` of the rows
//   per SOURCE    - same limit per feed; this is what bounds link-host attributed feeds (Techmeme,
//                   Google News, hnrss), whose items all have different publishers
//
// The cap is progressive so it holds for the homepage prefix AND the full list:
//   rows 1..homeRows: ceil(share x homeRows)    (10 rows x 0.3 -> 3 per publisher; 5 rows -> 2)
//   row k > homeRows: floor(share x k), never below the homepage cap  (25 rows x 0.3 -> 7)
// A story over the cap is deferred, not dropped: it takes the first later row where it fits.

export interface DiversityKeys {
  publisher: string;
  source: string;
}

export interface DiversityOptions<T> {
  /** SectionDef.maxPublisherShare (0 < share <= 1). */
  share: number;
  /** SectionDef.homeRows. */
  homeRows: number;
  /** Stop after this many rows (SectionDef.allRows). */
  limit: number;
  keysOf: (item: T) => DiversityKeys;
}

export interface DiversityResult<T> {
  kept: T[];
  /** Over a cap for every row up to `limit`, rank order. */
  deferred: T[];
  /** Fitted the caps but `limit` was reached first, rank order. */
  overflow: T[];
}

/** Max rows one publisher (or source) may hold among the first `position` rows (1-based). */
export function capAt(position: number, share: number, homeRows: number): number {
  // 1e-9: float noise must not turn 0.3 x 10 into ceil(3.0000000000000004) = 4 or floor(8.999...) = 8.
  const home = Math.max(1, Math.ceil(share * Math.max(homeRows, 1) - 1e-9));
  return Math.max(home, Math.floor(share * position + 1e-9));
}

/** Running publisher / source counts with the cap test. Shared by the section pass and the homepage pass. */
export class DiversityCounter<T> {
  private readonly publishers = new Map<string, number>();
  private readonly sources = new Map<string, number>();

  constructor(
    private readonly share: number,
    private readonly homeRows: number,
    private readonly keysOf: (item: T) => DiversityKeys,
  ) {}

  /** May `item` take row number `position` (1-based)? */
  fits(item: T, position: number): boolean {
    const cap = capAt(position, this.share, this.homeRows);
    const k = this.keysOf(item);
    return (this.publishers.get(k.publisher) ?? 0) < cap && (this.sources.get(k.source) ?? 0) < cap;
  }

  add(item: T): void {
    const k = this.keysOf(item);
    this.publishers.set(k.publisher, (this.publishers.get(k.publisher) ?? 0) + 1);
    this.sources.set(k.source, (this.sources.get(k.source) ?? 0) + 1);
  }
}

/** Apply the caps to a RANKED list. Order is preserved except that capped items move down. */
export function diversify<T>(ranked: readonly T[], opts: DiversityOptions<T>): DiversityResult<T> {
  const counter = new DiversityCounter<T>(opts.share, opts.homeRows, opts.keysOf);
  const kept: T[] = [];
  let deferred: T[] = [];
  const overflow: T[] = [];

  const take = (item: T): void => {
    kept.push(item);
    counter.add(item);
  };
  // After every placement the cap may have grown: give waiting items (rank order) the next rows.
  const drain = (): void => {
    let moved = true;
    while (moved && kept.length < opts.limit) {
      moved = false;
      for (let i = 0; i < deferred.length; i++) {
        if (counter.fits(deferred[i], kept.length + 1)) {
          take(deferred[i]);
          deferred = [...deferred.slice(0, i), ...deferred.slice(i + 1)];
          moved = true;
          break;
        }
      }
    }
  };

  for (const item of ranked) {
    if (kept.length >= opts.limit) {
      overflow.push(item);
    } else if (counter.fits(item, kept.length + 1)) {
      take(item);
      drain();
    } else {
      deferred.push(item);
    }
  }
  return { kept, deferred, overflow };
}
