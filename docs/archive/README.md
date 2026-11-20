# docs/archive — historical V1 records

These five files describe **V1** of AI DRUDGE (branch `main`, the 18-section site built from
`scripts/sources.ts`, `scripts/fetch-feeds.ts` and `src/App.tsx`). None of that code exists in the V2
tree. They were moved here from `docs/` on 2026-11-20 and are kept as an audit trail only.

**Do not use them as current documentation.** The current documents are in [`docs/`](../); start
with the [documentation index](../README.md), [HANDOFF.md](../HANDOFF.md) (state and first steps),
[CONTRACTS.md](../CONTRACTS.md) (what the V2 code is) and
[REVIEW_2026-11-20.md](../REVIEW_2026-11-20.md) (what was reviewed and fixed to get there).

## Files

| File | Written | What it was | Superseded by |
|---|---|---|---|
| [UPGRADE_PLAN.md](./UPGRADE_PLAN.md) | 2026-06-22 | Plan for the June-July 2026 freshness / importance / sources cycle of V1 (executed by 2026-07-06) | The V2 rebuild: [CONTRACTS.md](../CONTRACTS.md), [REVIEW_2026-11-20.md](../REVIEW_2026-11-20.md) |
| [REVIEW_SUMMARY_2026-09-21.md](./REVIEW_SUMMARY_2026-09-21.md) | 2026-09-21 | Index of the three September 2026 review files below and what was applied from them | [REVIEW_2026-11-20.md](../REVIEW_2026-11-20.md) |
| [REVIEW_2026-09-21.md](./REVIEW_2026-09-21.md) | 2026-09-21 | Editorial review of one V1 payload: homepage quality and ranking bugs | [REVIEW_2026-11-20.md](../REVIEW_2026-11-20.md), Part 1 |
| [FEED_AUDIT_2026-09-21.md](./FEED_AUDIT_2026-09-21.md) | 2026-09-21 | Probe of every V1 feed and scraper (187 sources) with keep / remove suggestions | The V2 registry in `scripts/registry/sources/` (414 sources on 2026-11-20), audited by `npm run validate:feeds` and `.github/workflows/feed-audit.yml` |
| [FEED_CANDIDATES_2026-09-21.md](./FEED_CANDIDATES_2026-09-21.md) | 2026-09-21 | About 220 candidate feeds probed; the 20 "add now" feeds were added to V1 | The V2 registry in `scripts/registry/sources/`; removed sources and the reasons are in `scripts/registry/sources/removed.ts` |

## What to expect inside

| Topic | State |
|---|---|
| Banner | Each file starts with a two-line "Historical V1 record" banner. Nothing else in the body was rewritten. |
| File paths (`scripts/sources.ts`, `scripts/lib/router.ts`, `public/data/headlines.json`, ...) | V1 paths. They do not exist in this tree. |
| Counts (187 / 203 / 207 sources, 18 sections) | V1 numbers at the date of the file. |
| Feed URLs | Recorded as probed on the file's date. Several are dead **by design**: the files document feeds that were already failing. The link check of 2026-11-20 found 7 broken URLs in these files (`blog.continue.dev/rss.xml`, `continue.dev/changelog/rss.xml`, `noma.security/feed`, `noma.security/feed/`, `www.sentinelone.com/feed/`, `blog.eleuther.ai/index.xml`, `github.blog/changelog_feed.xml`). Do not "fix" them. |
| Relative links | Links between the archived files still resolve (they moved together). The two links in `UPGRADE_PLAN.md` to `PROJECT_HISTORY.md` and `FUTURE_IMPROVEMENTS.md` were re-pointed to `../`; they break if those files are renamed or removed. |
| Link checker | `npm run check:links` (`scripts/tools/check-links.ts`) reads this directory as its own reference group, `archive`: the URLs are checked and listed, but a URL referenced only from here is not counted in the totals and never fails a `--strict` run. |

## Rules

1. Do not edit these files except to keep the banner and relative links correct.
2. Do not add new documents here unless they are dated records that a newer document replaces.
3. New review records go in `docs/` as `REVIEW_<date>.md` and are moved here when superseded.
