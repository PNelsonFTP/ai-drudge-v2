# AI DRUDGE - Project History

What was built, in what order, why, and what was rejected. Two products share this history:

| | V1 | V2 |
|---|---|---|
| Status on 2026-11-20 | Live, refreshed about hourly | Built and tested locally; **not committed, not deployed** |
| Code | branch `main` (parent checkout) | branch `v2`, git worktree in `v2/`, forked from `main` at `8d5cbc26` |
| Site | https://pnelsonftp.github.io/ai-drudge/ | none yet; default target path is `/ai-drudge-v2/` (`SITE_BASE`) |
| Repository | https://github.com/PNelsonFTP/ai-drudge | Same repository, as an unpushed branch. The workflow defaults assume a separate repository served at `/ai-drudge-v2/` with `main` as its default branch; none exists yet ([8.3](#83-decisions-and-their-reasons), row 8) |
| Sources | 203 feeds + 4 HTML scrapers | 414 registry entries (413 active, 1 paused), 405 publisher entries |
| Sections | 18 | 15 |
| Automated tests | 8 | 2,782 at the end of the final round (2,415 at the end of the fix round) |

Conventions in this file:

- V1 dates are git author dates (US Central). V2 timestamps are UTC; the V2 work ran from
  2026-11-19 20:47Z to 2026-11-20, which is the evening of 2026-11-19 in US Central.
- Every V2 number is a measurement taken on the date stated, from a build log, a test run or a
  review report. Numbers move with the news; re-measure before quoting them as current.
- "Not verified" means exactly that: nobody checked it, or it could not be checked under the rules
  of that step.

Related documents: [CHANGELOG.md](./CHANGELOG.md) (what changed between V1 and V2),
[CONTRACTS.md](./CONTRACTS.md) (types, ownership, commands),
[REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) (the review findings in detail),
[SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) (the source research in detail),
[DEPLOYMENT.md](./DEPLOYMENT.md), [SECURITY.md](./SECURITY.md), the
[documentation index](./README.md), and the dated V1 records in [archive/](./archive/README.md).

## 1. Origin

| Item | Detail |
|------|--------|
| Inspiration | [Drudge Report](https://www.drudgereport.com/) layout and density |
| Reader | One owner: a security executive at a regulated US financial firm who also runs a local-LLM lab. Priorities: AI security, local and open models, AI-in-finance regulation (SEC / FINRA), model releases |
| Prior attempt | A Next.js site (`pacoaifeed.space-z.ai`, hosted on z.ai) |
| Visual identity | Navy and gold chrome, Arial, Drudge density (since the 2026-09-21 restyle); deliberate, kept in V2 |

## 2. Why the original failed (z.ai / Next.js)

The prior site scraped RSS **inside Next.js API routes at request time**. That caused:

- 90+ second blocking responses on first load
- Container OOM kills under concurrent feed fetches
- Rate-limit errors from feed publishers
- A page that went **blank during refresh** while the client waited for new data
- A failed fix (commit `75da178` of that project) that added `refreshing` / `justUpdated` /
  `hasLoadedOnce` ref state and broke the content grid JSX

**Root fix, still the first rule of the project:** all fetching happens at **build time**. The
browser only loads static JSON. V2 keeps this rule unchanged.

## 3. V1 timeline (2026-06-14 to 2026-11-19)

V1 history has 2,154 commits, of which 2,136 are automated `chore(data): refresh ...` commits and
18 are code or documentation commits. The 18, oldest first:

| Date | Commit | Change | Feeds + scrapers (1) |
|---|---|---|---|
| 2026-06-14 | `76d16370` | Initial commit: static Vite + React aggregator | 62 + 0 |
| 2026-06-14 | `33d15559` | Ignore `tsconfig.tsbuildinfo` | - |
| 2026-06-14 | `b916713c` | Multi-category routing, 3 new sections, diversity cap | 113 + 0 |
| 2026-06-14 | `0cfc48c5` | 8 UX improvements; GitHub Repos moved to the bottom; feed URL cleanup | 101 + 0 |
| 2026-06-14 | `7d196b2d` | Quality pass: entities, release noise, source cap, scraper, brief, performance | 101 + 2 |
| 2026-06-19 | `523c402c` | First documentation package | - |
| 2026-06-22 | `4714b625`, `2f0d135d` | Freshness / importance / sources upgrade (15-item plan) | 99 + 2 |
| 2026-06-29 | `81494e42` | CI fix: quality-gate median-age check relaxed, Node 22 | 99 + 2 |
| 2026-07-07 | `9f1661ea` | Full overhaul: validated sources, feed tooling, client features, docs | 176 + 2 |
| 2026-08-18 | `fd22a7f3` | P1 improvements and a feed-rot pass | 176 + 2 |
| 2026-08-18 | `f45ad0ea`, `3c269a67` | Seven collector feeds and two more HTML scrapers | 183 + 4 |
| 2026-08-21 | `9a5c1fc0` | Favicon: black capital A on white | - |
| 2026-09-21 | `5646b77e` | Twenty more feeds; release tags stop leading the page | 203 + 4 |
| 2026-09-21 | `4fcc5aea` | Refresh cron twice an hour (`5,35 * * * *`) | - |
| 2026-09-21 | `1a1bfc00` | Navy and gold restyle; light theme becomes the default | - |
| 2026-10-05 | `6e71e360` | GitHub cron demoted to backup (`17 * * * *`, `47 11-23,0-3 * * *`); `scripts/kick-refresh.sh` | - |

(1) Counts per commit are from the documentation review of 2026-11-19, which read each commit;
they were not recounted for this file. The commit list, dates and cron lines were verified with
`git log` and `git show` on 2026-11-20.

### Phase 1 - Initial build (2026-06-14, `76d16370`)

- Vite 6 + React 19 + TypeScript 5.8 + Tailwind v4
- RSS feeds across 16 categories (AI plus partial cybersecurity)
- Build scripts `fetch-feeds.ts`, `fetch-stocks.ts`, `generate-brief.ts`, `build-data.ts`
- Client: Drudge 3-column layout, dark mode, hover cards (200 ms hide), bookmarks
- Jaccard >= 0.4 story grouping, 9-pattern date extraction
- Stock ticker: NVDA, MSFT, GOOG, META, AMZN
- GitHub Actions hourly cron + GitHub Pages deploy
- **Known issue at ship:** each section dominated by one source (a feed was pinned to one category)

### Phase 2 - Multi-category routing and new sections (2026-06-14, `b916713c`, `0cfc48c5`)

- **Problem:** articles only appeared in their feed's home category; one feed could flood a section
- **Fix:** `scripts/lib/router.ts` - keyword routing, priority / recency scoring, per-source
  diversity cap inside a category
- Added categories **LOCAL MODELS**, **GITHUB REPOS**, **AI FINANCE**
- Data shape: `articlesAll`, `sourceCount`, top-level `trending[]`
- UX: Trending section, View All expansion, read-later queue, mute sources / categories, mobile
  accordion; GITHUB REPOS moved to the bottom of the homepage

### Phase 3 - Quality pass (2026-06-14, `7d196b2d`)

| Fix | Before | After |
|-----|--------|-------|
| HTML entities in titles | 18 leaked (`&#8217;`) | 0 |
| GitHub release noise | 43 titles (`b9637`, `v0.30.4`) | 1 (a legitimate Stratechery episode) |
| Per-source global cap | Unlimited across categories | 6 unique articles per source |
| Anthropic coverage | Missing (no RSS) | 8 posts via an HTML scraper |
| Fallback daily brief | 3 random OpenAI posts | 5 diverse bullets from trending + categories |
| Client performance | Block on every load | SWR + sessionStorage + preload hints |
| `fast-xml-parser` entity limit | Default 1000 (silent feed drops) | Raised via `processEntities` config |

### Phase 4 - Freshness, importance and sources upgrade (2026-06-22, `2f0d135d`)

This phase was missing from earlier versions of this file. From the commit message:

- Shared scoring module `scripts/lib/score.ts`: 48 h half-life recency decay, rebalanced priority
  weights, recency-gated importance keywords, Hacker News velocity boost (`fetch-hn.ts`)
- Per-category hard age windows (3-21 days) with starvation-aware fill
- Freshness gate on the Lead Story (< 72 h) and Trending (< 72 h, relaxed to < 120 h)
- 14 dead or blocked feeds retired, 15 added; GitHub repos get synthesized
  `<repo> <version> released` titles
- Fetch hardening: body must be XML before parsing; 3 retries with jitter
- NEW badge (< 6 h), de-emphasis for > 72 h, "updated Xm ago", stale-data banner (> 6 h), LATEST strip
- `scripts/check-data.ts` quality gate wired into CI as `build:check`; typecheck step added
- Measured by that commit: median age 97 h -> 42 h, share under 24 h 0% -> 44%, feed health 85% -> 95%

### Phase 5 - CI stabilization (2026-06-29, `81494e42`)

- `build:check` median-age check demoted to a warning (hourly runs legitimately see 48-72 h
  medians); the hard failure moved to max item age (30 days)
- GitHub Actions Node 20 -> 22

### Phase 6 - Full overhaul (sources validated 2026-07-06, committed 2026-07-07, `9f1661ea`)

A source audit and feature cycle run with 13 parallel research agents; every candidate feed was
fetch-verified twice before inclusion.

**Sources (about 101 -> 178, all validated 2026-07-06):**

- **10 broken or moved URLs fixed:** arXiv (dead `export.arxiv.org` host -> `rss.arxiv.org`),
  LangChain (dead Medium feed -> `blog.langchain.com`), Ars Technica (dedicated AI feed), smol.ai
  (-> `news.smol.ai`), Google Project Zero, MarketWatch, PremAI, The Algorithmic Bridge, llama.cpp
  and whisper (repositories moved to `ggml-org`)
- **12 dead or stale feeds removed:** Google Research blogspot (829 days stale), EleutherAI (404),
  SemiAnalysis, Protect AI, Sebastian Ruder, LlamaIndex Medium, four dormant repositories, a
  duplicate CNBC URL
- **About 75 sources added**, most where the site was thinnest: AI security 2 -> 13, safety and
  policy 2 -> 11, plus labs, tools, research, local models, repositories and mainstream press
  (Techmeme, Guardian AI, Register AI/ML, WSJ, FT AI, 404 Media and others), and a Google News
  "AI x SEC/FINRA" query for regulatory signal
- Every checked-and-feedless site was documented at the top of `sources.ts`

**Pipeline:** `validate-feeds.ts` and a weekly `feed-audit.yml`; site Atom feed (`public/feed.xml`);
tag-only GitHub releases synthesize one headline per feed; RDF / RSS 1.0 and `dc:date` support;
`fast-xml-parser` 4.5 -> 5.9; unused `vite-plugin-pwa` removed; daily brief moved to
`claude-sonnet-5` (the `temperature` parameter removed because that model rejected it); ticker adds
AMD, TSM, AVGO; `generate-sbom.ts`.

**Client:** bookmark / queue snapshots persisted to localStorage; read-state dimming (seen >= 1.5 s,
LRU 500); "N new since your last visit" banner; Feed Health panel; search extended to summaries.

**Measured on the first build after the overhaul:** 173 of 178 feeds OK (97%), 258 visible stories
(was about 170), median age 12.7 h, 60% under 24 h, 4 trending clusters (was 1), no empty sections.

### Phase 7 - P1 items, feed rot, collector feeds (2026-08-18 to 2026-08-21)

- `fd22a7f3`: trending cluster lead prefers a press title within 10% of the top score; Google News
  and hnrss wrapper URLs unwrapped at fetch time; `headlines-preview.json` for first paint (about
  150 KB) with the full file hydrating after; weekly audit hard-fails
  `npm audit --omit=dev --audit-level=high` and maintains one `Feed audit: N problems` issue;
  per-host fetch cap of 2 for Substack / Reddit / hnrss
- `f45ad0ea`, `3c269a67`: seven collector feeds (Modal, Replicate, Cloudflare AI, NVIDIA Research,
  Platformer, NIST, AI Now) and two HTML scrapers (UK AISI, Gray Swan)
- `9a5c1fc0`: favicon

### Phase 8 - Feed pass, twice-hourly cron, restyle (2026-09-21)

- `5646b77e`: twenty feeds added (203 feeds + 4 scrapers); ranking changes so release tags, future
  dates and funding false matches no longer lead; the dated review and audit records
  (`REVIEW_2026-09-21.md`, `REVIEW_SUMMARY_2026-09-21.md`, `FEED_AUDIT_2026-09-21.md`,
  `FEED_CANDIDATES_2026-09-21.md`, now under [archive/](./archive/README.md)) were written in
  this commit
- `4fcc5aea`: cron `5,35 * * * *`, because GitHub was dropping the single hourly slot
- `1a1bfc00`: the navy and gold restyle (Arial, light stripe, gold rule under the masthead); the
  light theme became the default and the theme storage key changed to `ai-drudge:theme-ft`

### Phase 9 - External refresh clock (2026-10-05, `6e71e360`)

GitHub kept dropping scheduled runs, so the schedule moved outside Actions: a launchd agent on
the owner's Mac dispatches the workflow, and the two GitHub cron lines became a backup.
`scripts/kick-refresh.sh` was added as the manual equivalent. The agent's plist is not in the
repository.

No code commit landed on `main` between 2026-10-05 and the V2 fork on 2026-11-19.

## 4. V1 at the fork (2026-11-19)

V1 is unchanged by V2 and stays live on `main`. In the `v2` tree every V1 file listed below was
deleted at cutover; read them on `main`.

| Area | V1 files | Notes |
|---|---|---|
| Feed registry | `scripts/sources.ts` | 203 feeds, 18 categories, a keyword map |
| Fetch | `scripts/fetch-feeds.ts`, `scripts/scrape-sources.ts`, `scripts/fetch-hn.ts` | 4 scrapers lived outside the registry |
| Rank | `scripts/lib/router.ts`, `groupStories.ts`, `score.ts` | per-category Jaccard grouping, feed priority |
| Emit | `scripts/build-data.ts`, `scripts/lib/emitFeed.ts`, `scripts/check-data.ts` | `headlines.json`, `headlines-preview.json`, `brief.json`, `stocks.json`, `feed.xml` committed to `main` on every run |
| Enrich | `scripts/generate-brief.ts`, `scripts/fetch-stocks.ts` | 8 tickers |
| Client | `src/App.tsx` (479 lines), 11 components, 4 hooks | all client state in one component |
| CI | `refresh.yml`, `feed-audit.yml` | one job with write permissions; data commits to `main` |

V1 measured on 2026-11-19 by the review in section 5 (production payload of 20:08Z):

| Metric | Value |
|---|---|
| Feeds OK | 185 of 207 in that build; 185-194 over 61 sampled builds |
| Homepage | 185 slots; 281 unique articles in the payload; median homepage item age about 7 h |
| Payload | `headlines.json` 382 KB raw / 76.3 KB gzip; preview 36.5 KB gzip |
| Bundle | JS 224 KB / 69.3 KB gzip |
| Workflow | median 57 s end to end; 2,137 of 2,186 runs succeeded since 2026-06-14 (97.8%) |
| Tests | 8, not run in CI |
| Dependencies | 190 lockfile packages; `npm audit` full tree: 7 advisories (6 high, 1 moderate) on 2026-11-16 |

## 5. Why V2

On 2026-11-19 V1 was reviewed across 17 dimensions (method in [6.1](#61-review-of-v1)). The
review recorded 235 entries: **170 verified findings** (49 confirmed, 121 partially confirmed; by
severity 6 critical, 79 high, 85 medium), 24 low-severity items that were not verified, and 41
proposals. The verified findings that decided the rebuild:

| # | Finding | Evidence (V1 production data unless stated) |
|---|---|---|
| 1 | The front page did not surface the day's story | On the day of the Anthropic IPO (19-22 articles from 12-14 outlets in the payload) the story was Trending #5 labelled "2 sources"; Trending #1 was a $47M robotics round; the Daily Brief named that round the top AI story |
| 2 | Trending counted feeds, not publishers | Only 34.2% of 9,928 Trending entries (1,150 snapshots, 2026-09-24 to 2026-11-19) had two independent publishers; one byte-identical duplicate feed pair ("OpenAI News" / "OpenAI Blog") produced 31.7% of all entries |
| 3 | Clustering barely fired | Title-Jaccard 0.4 inside a category found 8 multi-publisher clusters among 740 items under 72 h; the IPO was 21 separate clusters |
| 4 | The lead was a per-article maximum with no AI test | 100 distinct leads in 308 builds; the lead changed in 40% of builds and was a non-AI story in 6.9%; first paint showed the wrong lead in 71% of builds because the preview payload could not resolve it |
| 5 | The per-source cap ran before relevance | Each feed kept its 6 newest items, so OpenAI's own GPT-6.2 launch post was fetched and never shown, while non-AI wire items kept their slots |
| 6 | Keyword routing was about half right | Of 140 hand-labelled keyword-routed items, 52% relevant and 31% clear false positives; the keyword `edr` matched inside "Bedrock" and made an AWS blog the top source of CYBER DEFENSE; 45 of 185 homepage slots repeated a URL shown in another section |
| 7 | Off-mission content | About 26% of articles reaching an AI-section top 10 were not about AI; six general feeds caused 54% of that |
| 8 | The owner's priority sections were the weakest | Cyber feeds published 194 AI-titled stories in 30 days and 8 reached AI SECURITY; three undated scraped posts (94 to 561 days old) held AI SECURITY homepage slots because an undated item never aged; FINRA had zero mentions in 30 days of fetched corpus |
| 9 | Silent source failure | Both Anthropic scrapers returned 0 items on every build from 2026-10-20T17:08Z (a page redesign broke a regular expression); a median of 17 of 207 sources failed every build; 15 sources succeeded in 5% or fewer CI runs; nothing alerted |
| 10 | The Daily Brief had never been AI-generated | Fallback in 2,139 of 2,139 data commits (the API key secret was never set); 20-24% of fallback headlines were release tags |
| 11 | One bad feed item could stop the site | A single out-of-range numeric entity (`&#x110000;`) in any title failed the whole build; a 6 MB feed inflated the payload to 96 MB; no URL scheme, size or type validation anywhere |
| 12 | CI privilege and blind gates | One job held `contents`, `pages` and `id-token` write plus the API key while running install scripts of 190 packages and parsing 203 untrusted feeds; actions pinned by tag; the audit gate used `--omit=dev` and could not see the 7 advisories; the weekly audit had been red 13 weeks without notifying anyone; the quality gate never failed in 1,000 runs; 33 runs went green while redeploying old data |
| 13 | The schedule depended on one laptop | GitHub delivered about 20% of cron slots; gaps between deploys were p50 58 min, p95 197 min, max 417 min; 99.2% of commits and 70 of 72 MB of the repository were bot data commits |
| 14 | Accessibility failures | Two dialogs rendered black on `#161616` (1.16:1) in the default theme; 43 distinct text / background pairs failed WCAG AA; 623 tab stops with no skip link, heading or landmark; summaries and related coverage existed only in a hover card that keyboard and touch users could not reach |
| 15 | No safety net | 8 tests covering about 11 of 98 build-side functions and none of the client; a 65-test scratch suite written by the reviewer failed 42 tests on V1, each a reproduced defect; 14 concepts existed in 2-6 diverging copies |
| 16 | V2 could not coexist with V1 as the code stood | The workflow, concurrency group, Vite base, feed URL, kick script and `ai-drudge:*` storage keys were all hard-wired to V1; a `v2` branch pushed as-is could cancel V1 production runs, and a V2 on the same origin would share (and could destroy) V1 reader state |

The architecture reviewer's conclusion: V1 was small (71 tracked files, about 5,800 lines) and
type-clean, but one 178-line function did capping, routing, windowing, scoring, clustering,
diversity, trending and lead selection, and one component owned all client state. The fixes were
all build-time and compatible with the static design, so the decision was a rebuild of the
pipeline and client on the same architecture, not a patch series and not a new platform.

## 6. How V2 was built

V2 was produced in one orchestrated multi-agent session. Agents never committed; the working tree
is the deliverable. Timestamps are those of the session's artefacts.

| Step | When (UTC) | Output |
|---|---|---|
| Fork: worktree `v2/` on branch `v2` | 2026-11-19 20:47 | V1 at `8d5cbc26` |
| 1. Review of V1, 17 dimensions | 20:48 - 22:00 | 170 verified findings, 41 proposals |
| 2. Source research and curation | 20:48 - 22:28 | 535 feed candidates -> 198 accepted feeds + 19 scrape picks |
| 3. Plan | 22:04 | master plan: taxonomy, contracts, 12 work packages |
| 4. WP0 foundation, then WP1-WP10 in parallel | 22:04 - 2026-11-20 00:19 | pipeline, registry, client; 1,904 package tests |
| 5. Cutover (WP11) and first live builds | 00:19 - 01:15 | V1 code deleted; 7 live builds; 17 observations |
| 6. Review-fix round | 01:15 - 02:32 | 101 findings; 2,415 tests; 2 live builds |
| 7. Final round | 02:34 - about 05:30 | 5 fixers, 3 integrators, 25 audit findings, 1 closer; 2,782 tests; 3 live builds ([6.7](#67-final-round-2026-11-20)) |

The review reports, build logs and work-package reports lived in the session's scratch directory,
which is **not part of the repository** and may no longer exist. This file,
[CHANGELOG.md](./CHANGELOG.md), [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) and
[SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) are the durable record of what they said.

### 6.1 Review of V1

- 17 dimensions, one reviewer each: fetch, routing, auxiliary pipeline (scrapers, brief, stocks,
  Atom), orchestration and CI, frontend logic, frontend UX and accessibility, security,
  performance, editorial output, quantitative output, sources and taxonomy, tests and
  maintainability, documentation drift, operations and reliability, dependency upgrade, product
  vision, V2 architecture.
- The 14 audit dimensions were each re-checked by a second, skeptical agent. Findings it refuted
  were removed; a finding it corrected carries a corrected recommendation, and that version was
  the one implemented. The three forward-looking dimensions (dependency upgrade, product vision,
  architecture) produced proposals, not findings.
- Evidence was production data, not code reading alone: 1,150 committed payload snapshots, all
  2,186 workflow runs, CI logs, a live fetch of 2,297 items with the repository's own fetchers
  (kept as `test/fixtures/items-2026-11-19.json`), and scratch prototypes.
- Limits stated by the reviewers: browser tools were not used, so pixel and timing figures are
  estimates; routing precision rests on one day and one labeller; lexicon-based AI ratios are
  approximate.

### 6.2 Source research and curation

| Stage | Result |
|---|---|
| Baseline of V1's 203 feeds | 180 OK, 11 stale, 6 HTTP 404, 2 HTTP 403, 2 HTTP 429, 1 empty, 1 HTTP 502 |
| Triage of the 20 problem feeds | 8 URL replaced, 5 kept (slow but alive), 4 removed, 3 converted to scrapers |
| Round 1 scouting, 28 angles | 317 feed candidates |
| Completeness critique | 10 gaps, led by AI-security vendor labs, primary finance regulators (FINRA was in neither the registry nor the candidates), model-release signals from JSON APIs, and advisories for the owner's own stack |
| Round 2 scouting, 10 gap angles | 218 more feed candidates (535 total) and 178 scrape candidates in both rounds |
| Validation of the 535 with the project's own fetcher | 512 OK, 11 not a feed, 5 HTTP 502, 4 stale, 2 parse failures, 1 timeout |
| Curation: 11 feed curators and 2 scrape curators by section, then a chief curator who re-fetched every pick | 229 reviewed -> **198 accepted**, 31 dropped (10 duplicates, 2 for feed size against the 5 MB body cap, 2 scope errors, content quality, Substack hosts blocked from CI); 274 held in reserve; 63 rejected |
| Scrape picks | 19 accepted (8 for AI SECURITY), 97 skipped |

Homes of the 198 accepted feeds: policy 33, AI security 26, releases 18, cyber 17, money 17,
open/local 15, tools 15, industry 12, analysis 11, models 11, safety 6, compute 6, research 4,
robotics 4, quantum 3. The largest groups match the owner's priorities by design.

WP1 merged these with V1's 207 sources into the typed registry: 411 entries at hand-off (408
active), 413 after the fix round (412 active, 1 paused; 394 publishers, of which 77 were
attribution-only outlets such as Reuters at hand-off). Split on 2026-11-20: 249 RSS, 57
newsletter, 37 GitHub release, 34 query, 19 scrape, 9 papers, 4 community, 3 JSON, 1 aggregator;
301 scope `ai`, 112 scope `general`; tier 1: 6, tier 2: 66, tier 3: 255, tier 4: 86. After the
final round: 414 entries (413 active, 1 paused), 405 publisher entries of which 317 own a source;
the 11 Hacker News searches moved from kind `query` to kind `json` and one was added (query 23,
JSON 15); 302 scope `ai`; tier 4: 87.

### 6.3 Plan

The master plan adopted the architecture reviewer's proposal and overrode it where the other
reviews disagreed. Its binding points:

1. 15 sections declared once in `shared/sections.ts` ([8.3](#83-decisions-and-their-reasons), row 1).
2. One data contract, schema v2, in `public/data/v2/`: `front.json`, `rest.json`, `river.json`,
   `health.json`, `sources.json`, `brief.json`, `stocks.json`, `status.json`, `state.json`.
   Generated files are never committed.
3. A staged pipeline: ingest -> normalize -> relevance -> cluster -> score -> route -> emit.
4. A "strangler" build: a foundation package lands the shared contracts first; ten packages then
   only **add** files in directories they own and compile against interfaces; one cutover package
   flips the entry points and deletes V1 code.
5. Zero new runtime dependencies and zero new dev dependencies.
6. CI inert by default; no data commits to `main`.

### 6.4 Work packages

WP0 (foundation) landed alone: `shared/**`, the stage types (`scripts/pipeline/types.ts`), the
registry types, the client service interfaces (`src/app/services.ts`), fixtures, test helpers,
`test/boundaries.test.ts`, the dependency upgrade and the split tsconfig. WP1-WP10 then ran at
the same time, each in its own directories:

| Package | Owns | Tests at hand-off |
|---|---|---|
| WP1 Registry | `scripts/registry/**`, `scripts/tools/import-sources.ts` | 39 |
| WP2 Ingest and feed tooling | `scripts/pipeline/ingest/**`, `scripts/tools/validate-feeds.ts`, `check-links.ts`, `report-feed-audit.ts`, `feedVerdict.ts`, feed and scrape fixtures | 206 |
| WP3 Normalize and relevance | `scripts/pipeline/normalize/**`, `relevance/**` | 501 |
| WP4 Cluster and score | `scripts/pipeline/cluster/**`, `score/**` | 101 |
| WP5 Route | `scripts/pipeline/route/**` | 162 |
| WP6 Emit, enrich, state, gate | `scripts/pipeline/emit/**`, `enrich/**`, `state/**`, `scripts/tools/check-data.ts`, `explain.ts`, `test/contract.test.ts` | 134 |
| WP7 Client data and state | `src/data/**`, `src/state/**` | 223 |
| WP8 Client shell | `src/app/` (shell, router, stores; not `services.ts`, `presets.ts`, `createServices.ts`), `src/keyboard/**`, `src/styles/**`, `src/features/chrome/**` | 185 |
| WP9 Home and headline row | `src/features/home/**`, `src/features/headline/**` | 122 |
| WP10 Secondary pages | `src/features/{section,search,new,watch,saved,sources,settings,about,export}/**` | 231 |

Rules every package worked under: touch only your own files; never edit a shared contract file,
file a written contract request instead and code against a local adapter; no git writes, no
dependency changes, no live builds, no browser; tests are co-located `*.test.ts` on `node:test`
with clock and fetch injected, so no test touches the network.

Measured by the packages on the 2026-11-19 corpus before cutover: the Anthropic IPO became one
story with 16 publishers and 32 items (V1: 22 articles in 21 clusters); llama.cpp and llama_index
stayed separate; 23 of the 25 largest clusters were pure; no story appeared in more than two
sections (V1: 9) and repeated homepage slots fell from 45 of 185 to 0 of 140 (bridged fixture).

### 6.5 Cutover (WP11)

WP11 wrote the composition roots (`scripts/pipeline/run.ts`, `src/app/createServices.ts`), flipped
`index.html`, `src/main.tsx`, `package.json` and `vite.config.ts`, deleted the V1 pipeline and
client, rewrote the workflows and `scripts/kick-refresh.sh`, and resolved the contract requests
the packages had filed: the adopted and the five rejected ones are listed in section 9 of
[CONTRACTS.md](./CONTRACTS.md).

First live builds (cold = empty state, warm = state from the build before):

| Build (UTC, 2026-11-20) | State | Sources OK | Raw -> kept -> stories -> placed | Notes |
|---|---|---|---|---|
| 00:52:21 | cold | 401 of 410 | 4,323 -> 1,361 -> 1,227 -> 320 | stocks 2 of 8; 8 hnrss queries HTTP 502 |
| 00:54:41 | warm | 401 of 410 | 4,326 -> 1,366 -> 1,233 -> 320 | stocks 0 of 8 (HTTP 429); no 304 logged |
| 00:56:19 | warm | 401 of 410 | 4,326 -> 1,355 -> 1,230 -> 321 | 264 sources answered 304 |
| 01:01:32 | cold | 401 of 410 | 4,311 -> 1,364 -> 1,224 -> 318 | stocks 8 of 8 |
| 01:02:46 | warm | 404 of 410 | 4,359 -> 1,372 -> 1,231 -> 318 | ingest 58 s (Techmeme timed out, carried forward) |
| 01:10:03 | cold | 407 of 410 | 4,365 -> 1,371 -> 1,228 -> 318 | gate PASS; 364 rows, 143 on the homepage, 12 top stories |
| 01:10:37 | warm | 407 of 410 | 4,365 -> 1,370 -> 1,228 -> 319 | gate PASS; 283 sources answered 304 |

The largest story in every build was the IPO at 27-29 publishers. V1's 20:08Z payload against the
V2 build of 01:02Z (`npm run compare`): the same lead story; 62 of V1's 140 articles placed in V2,
21 only in the river, 57 gone (21 no longer fetched, 12 over the source cap, 9 release tags
collapsed, 6 off-topic, 5 too old, 4 excluded); 270 V2 stories were not in V1. Of V1's six
Trending rows, one became a V2 top story.

The orchestrator then ran V2 in a real browser (desktop 1440 px, phone 375 px, light and dark)
on the live-built data: every route rendered with no console errors, and 17 observations were
recorded. They and the defects visible in the logs are listed in
[8.5](#85-defects-found-at-cutover).

### 6.6 Review-fix round (2026-11-20, 01:15 - 02:32Z)

Nine reviewers examined the cut-over V2 (pipeline front, ranking and editorial, registry, emit /
ops / CI, client core, client UI and accessibility, performance, security, tests and parity) and
each finding was checked by a skeptic.

| Measure | Value |
|---|---|
| Findings | 101: 1 critical, 18 high, 44 medium, 38 low. 14 confirmed, 49 partially confirmed, 38 low and unverified, 0 refuted |
| Fixers | 9 area owners (ingest, normalize-relevance, cluster-score-route, emit-ops, registry, client-core, client-shell, client-home, client-pages), then one integrator |
| Outcome | 86 findings fixed in whole or part by the area owners; 5 more applied by the integrator (TP-01, TP-02, TP-11, TP-12, CC-8); 10 not fixed, each with a recorded reason |
| Tests | 2,415 pass, 0 fail (`npm test`); `npx tsc -b` clean; `npm audit` 0 |
| Live builds | 02:19:24Z and 02:24:40Z, both exit 0, gate PASS |
| Feed audit | 408 of 412 OK; the 4 failures were hnrss.org HTTP 502 (transient); 0 stale |
| Link check | 831 URLs: 793 ok, 7 broken, 4 flaky, 27 blocked by bot walls. Registry: 0 broken. The 7 broken are dead feed URLs quoted in dated V1 documents |

The findings that mattered most:

| Id | Finding | Fix |
|---|---|---|
| RE-01 (critical) | The per-source cap ran before clustering and deleted the items stories are built from: wrong leads, split stories, missing top stories | `rescueCorroboration`: over-cap items that share a story with another publisher come back (82 of 594 in the next build). Stories with two or more publishers went from 41 in the last cutover build to 61 in the first fix-round build; other fixes contributed |
| PF-3, REG-02 | Both tier-1 regulator feeds (FINRA Notices, SEC press) kept zero items; "FINRA" appeared nowhere on the site | Owner-term include lists (cyber, third-party risk, Reg S-P and similar); a regulator-notice score term |
| PF-2 | FCA feed: an unparsed date plus the baseline rule back-dated 15 items to 22 days old | Date format parsed; affected ids removed from the first-seen ledger once |
| PF-1 | The AI gate dropped items several sources had been added for (agent advisories, current model names) | Model-family terms and agent terms on security desks |
| REG-01, RE-04 | OpenAI's own GPT-6.2 post was dropped and a third-party changelog led the story | Cap rescue plus lead selection by publisher role |
| RE-02, RE-05, RE-06 | Stories split or impure (aggregator bylines in the vector, numbers and dates counted as shared evidence) | Byline stripped from clustering tokens; calendar tokens and advisory words discounted; an established story can absorb later coverage; at most 3 homepage rows per section on one big story's subject. Partially fixed, see open items |
| RE-03 | TOP STORIES ranked by raw publisher count | Ranked by score; publisher count breaks ties |
| REG-03, REG-04, PF-4 | Query and wire feeds marked AI-only injected off-mission rows into POLICY | Title-restricted queries, a capped wire query, URL excludes |
| A11Y-01 | Seen-dimming stripped emphasis from the lead and TOP STORIES | The lead, TOP STORIES and saved lists are never dimmed |
| A11Y-02 | Muting a source was one key with no feedback and no undo | Visible notice with Undo, key `u` |
| perf-01 | The LATEST strip reshuffled when `rest.json` merged | LATEST is now a subset of rows already on the page |

Four genuine bugs were found during integration and fixed:

1. `run.ts` threw **after** writing the edition when `STATE_FILE` named a directory that did not
   exist (found by the new failure-branch tests).
2. The first fix-round build put `front.json` at 53.3 KB gzip, over the 48 KB first-paint budget,
   because the rescue grew clusters (50 members on the IPO story). Members no longer carry a
   summary: 44.0 KB.
3. River memory kept rows the current rules reject (22 that day, among them a subscribe-coupon
   page). A remembered row now leaves when it is seen again and rejected.
4. FINRA Regulatory Notice 26-24 sat at POLICY #30 of 30. The regulator-notice term moved it to #11.

Disclosures recorded by the integrator: the two builds were 5 minutes apart, so stability at the
real 30-minute cadence and over 24 hours is **not measured**; `state.json` was hand-edited twice
(15 FCA ids removed from the first-seen ledger, 2 stale rows removed from the river memory); the
committed fixture was **not** refreshed, because 62 tests pin its facts; nothing was verified in a
browser in this round.

State of the last fix-round build (02:24:40Z): 4,457 raw items -> 4,057 normalized -> 1,468 kept ->
1,249 stories (61 with two or more publishers, largest 30) -> 315 stories placed in 359 rows, 143
on the homepage, 12 top stories, all 15 sections filled. 408 of 412 sources OK, 259 answering 304.
`front.json` 44.0 KB gzip, `rest.json` 34.8, `river.json` 84.9 (1,041 rows, loaded on demand).
Site build: entry JavaScript 109.61 kB gzip, entry CSS 8.57 kB gzip.

### 6.7 Final round (2026-11-20)

From 02:34Z to about 05:30Z. Input: the ranked list of defects left by the fix round ([9](#9-open-at-the-end-of-the-fix-round)),
plus a rewrite of the README and every document under `docs/`, which until this round were still
V1 text copied into the fork. The finding-by-finding record is
[REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md), Part 3; the contract changes are
[CONTRACTS.md](./CONTRACTS.md), sections 11 to 13.

| Step | Who | Result |
|---|---|---|
| Fix | 5 fixers by area (ranking, sources, client shell, client pages, operations) | Each defect replayed on the last live state before and after its fix; requests filed for shared files |
| Integrate 1 | 1 integrator | Cross-area requests applied or rejected; live build 03:34:11Z (413 of 413 sources OK, gate PASS); 2,721 tests |
| Integrate 2 | 1 integrator | Fixture migrated from the bridged V1 payload to a frozen live build; `npm run fixture:refresh`; 2,757 tests |
| Integrate 3 | 1 integrator | Live build 04:16:25Z; feed audit 413 of 413; link check of 2,227 URLs with 0 broken registry or article links; V1 / V2 comparison; 2,758 tests |
| Audit | 3 auditors (editorial, client, operations) | 25 findings: 5 high, 10 medium, 10 low |
| Close | 1 closer | 14 findings fixed, 9 partly, 2 left; live build 05:16:55Z (412 of 413 OK, 1 carried forward, gate PASS); fixture refreshed; 2,782 tests |
| Documentation | writers per document, one editor | This file's final section, the changelog's final-round entry, and every other document checked against the tree |

No agent in this round used a browser, ran a git write or touched V1.

What changed the product most:

| Change | Why | Measured on 2026-11-20 |
|---|---|---|
| Running-story fold and a hold rule for TOP STORIES | The IPO held three of twelve slots; TOP membership had no memory | IPO: 1 slot, 3 follow-ups folded. The hold was never exercised on live data |
| Three cluster vetoes and the split of a company saga | Three false merges sat on homepage lists, one in TOP; the SEC inquiry into Nvidia was hidden inside an 81-hour-old headline | 4 live clusters changed, 0 on the 2026-11-19 corpus; the SEC inquiry is its own 5-publisher story at POLICY #4 |
| Regulator floor and section focus in POLICY | A FINRA notice sat one row below the homepage list | FINRA Regulatory Notice 26-24: POLICY #11 -> #8 -> #6 |
| Outlet quality control | Google News queries admitted low-quality outlets to AI SECURITY | 10 denied hosts; unvetted outlets never lead and never count as coverage. Side effect: two security stories lost publishers (4 -> 2, 5 -> 2) and rank lower |
| Hacker News through the Algolia API | hnrss.org answered HTTP 502 for 4 to 8 queries in every build since cutover | 12 of 12 searches answer; 413 of 413 sources OK in two builds |
| Fixture = a frozen live build | 62 tests pinned facts of one V1 day, so page tests never saw paywall flags, `w = 3` or a carried source | Tests select rows by property; the fixture was replaced twice in this round with one command |
| `state.json` out of the Pages artifact | 3.3 MB of feed-derived text was deployed with every edition | The `data` branch is the hand-over path. **Not run on GitHub** |
| Registry notes and a tag that described the reader | The published source list and the repository gave role, regulator type and security vendors | Tag `owner-stack` removed from 57 sources, about 35 notes reworded; a residual remains in three registry notes and in [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) ([SECURITY.md](./SECURITY.md) section 2.5) |

State at the end (closing build 05:16:55Z): 4,461 raw items -> 4,054 normalized -> 1,497 kept ->
1,280 stories (64 with two or more publishers, largest 31) -> 322 placed in 367 rows, 143 on the
homepage, 12 top stories. `front.json` 43.9 KB gzip, `rest.json` 35.5, `river.json` 88.1 (1,086
rows). Entry JavaScript 108.20 kB gzip. Registry 414 sources (413 active), 405 publisher entries.
2,782 tests in 132 files.

What became of the 17 items of [section 9](#9-open-at-the-end-of-the-fix-round):

| Item | After the final round |
|---|---|
| 1 Cluster quality | IPO fragments folded; impure cluster fixed; TOP hold built. China chip sales and one caucus item still split |
| 2 Regulator placement | Floor and focus built; FINRA notice on the POLICY homepage |
| 3 LOCAL homepage | 8 of 10 rows on-topic after the fixers; Qwen4-Max listed in MODELS view-all only (#19) |
| 4 Low-quality outlets | Deny list and unvetted handling |
| 5 Fixture | Frozen live build of 05:16:55Z, three synthetic health rows |
| 6 Entry bundle | 109.61 -> 108.20 kB gzip; the 85 kB target is not reachable while the React runtime is about 67.5 kB |
| 7 Search noise | Source-name matches listed apart; operators `source:` and `section:` |
| 8 `state.json` public | Not in the site by default; one copy on the public `data` branch |
| 9 Stability | One 42-minute gap measured (lead unchanged, TOP 10 of 12, 134 of 143 homepage rows); hnrss.org replaced |
| 10 Mute edge cases | Recount, hover card and time filters reworked |
| 11 Browser | Still unverified, for two rounds of client changes |
| 12 Stale banner | Reads `status.json` `staleAfterMinutes`, now 120 |
| 13 Probation | 12 tags left (the registry had 14, not two) |
| 14 `git rm --cached public/feed.xml` | Open |
| 15 Smaller requests | Per-source fetch policy, keyboard DOM tests, brief reason on the About page: done. Test-only exports: open |
| 16 Documentation | Rewritten |
| 17 By design | One time-chip group on section pages; one briefing entry point on the Watch page |

The open list after this round is the known-defect register in
[FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md); [HANDOFF.md](./HANDOFF.md) section 7 carries the
same rows. The five "not verified" points at the end of section 9 all still stand, except that a
clean copy of the tree was shown to pass `tsc`, the tests and the site build (on macOS, Node 26.7.0).

## 7. V2 against V1

| | V1 (2026-11-19) | V2 (end of the final round, 2026-11-20) |
|---|---|---|
| Sources | 203 feeds + 4 scrapers, untyped list | 413 active registry sources with publisher, kind, scope, tier, home |
| Sections | 18 | 15 |
| Story grouping | Title Jaccard inside a category; counts feed names | One corpus-wide clustering; counts publishers |
| Top of page | Brief, Trending, Lead, Latest (four blocks) | TOP STORIES with inline "Also:" outlets, then LATEST |
| Per-source cap | 6 newest, before relevance | 8 by default, after relevance, with corroboration rescue |
| Feed memory | None | Conditional GET, carry-forward for 6 h, quarantine after 48 failures |
| Data files | 4 JSON files committed to `main` on every run | 9 JSON files, gitignored; 8 are published, the state is handed over on a `data` branch |
| First-paint data | 36.5 KB gzip preview, then 76.3 KB | `front.json` 43.9 KB gzip; `rest.json` and `river.json` loaded after |
| Entry JavaScript | 69.3 KB gzip | 108.20 kB gzip (**larger**; open item) |
| Tests | 8, not in CI | 2,782; the build workflow runs them before every data build |
| Lockfile packages | 190 | 125 |
| `npm audit`, full tree | 7 advisories | 0 |
| CI | One job with write permissions; actions pinned by tag | Split least-privilege jobs; actions pinned by commit SHA; inert until `V2_DEPLOY` is set |
| Refresh cadence | About hourly, driven by one Mac | Designed for 30 minutes; **not yet run in CI** |

## 8. Decisions

### 8.1 Rules carried over from V1

| Rule | Reason |
|---|---|
| No live RSS in the browser or in an API route | It caused every failure of the original site |
| No server runtime | Out-of-memory kills and complexity; the site is static files |
| System Arial, no web fonts | A web font caused build failures on a flaky network |
| No Reddit feed workarounds | Tested 2026-07-06 and again in the V2 source research: blocked or rate-limited from datacenter addresses. Lemmy and Hacker News queries are the substitute |
| No GitHub Trending mirror | Undated items with repository-name titles are poor headlines |

### 8.2 What the owner asked for

Conservative, least-privilege, auditable, no filler. In practice: zero new dependencies, every
dropped item recorded with a reason (`npm run explain`), every source in a typed registry with a
written note, no telemetry and no third-party request from the page, CI that cannot act until the
owner opts in.

### 8.3 Decisions and their reasons

| # | Decision | Reason | Alternative not taken |
|---|---|---|---|
| 1 | **15 sections** in place of 18: four merges (local models + open source, agents + products, AI finance + funding, cyber threats + cyber defense) and one split (safety and policy into POLICY & REGULATION and SAFETY & ALIGNMENT) | Measured over 30 days: OPEN SOURCE was 12% home content, AGENTS & TOOLS 17%, CYBER DEFENSE 22%; FUNDING shared 54% of its items with INDUSTRY; SAFETY & POLICY was 64% one forum and 4% policy. Finance-regulator items now have a home (POLICY) and AI-titled cyber stories route to AI SECURITY, the owner's flagship section | Keeping 18 and fixing keywords only |
| 2 | **Desks.** `ai` sections feed TOP STORIES, the lead, the brief and the Atom feed; `owner` (CYBER WIRE, QUANTUM WATCH) and `utility` (RELEASE RADAR) never do | The lead had been a non-AI wire or a release tag; the owner still wants the general cyber and quantum wire, just not on top | Dropping the cyber wire |
| 3 | **Cluster once, corpus-wide, before routing, and count publishers** (registry `publisher`, or the link host for aggregators), never feed names | Findings 2 and 3 in section 5. Same-URL twins fold into one article; release and community sources never raise coverage | Per-section clustering as in V1 |
| 4 | **Emphasis from story size, not feed priority.** `w` = 3 at 8+ publishers, 2 at 3+ or a tier-1 first-party launch, 0 (grey italic) for a tier-4 lead with fewer than 2 publishers | In V1 red marked feed priority, so a commit message was red while the IPO lead was black | Keeping priority colours |
| 5 | **AI relevance gate** for `general`-scope sources (112 of 414), title-weighted with word boundaries; not applied to owner-desk sources or to sources with their own include list | Finding 7. Every drop is recorded with its reason | Removing general wires, which carry real AI stories |
| 6 | **Static architecture kept**: build-time pipeline, static JSON, hash routes, localStorage, no server | Section 2; every verified finding was fixable at build time | A server or edge function; accounts and sync |
| 7 | **Light theme by default**; `system` and `dark` are settings; a hashed inline script applies the stored theme before first paint | Continuity with V1 since the 2026-09-21 restyle and with the navy / gold identity, which the plan fixed as deliberate. Contrast is tested for both themes (`src/styles/contrast.test.ts`) | Following the operating system by default. No measurement was recorded for this choice |
| 8 | **CI inert by default.** Every job in `refresh.yml` and `feed-audit.yml` is guarded by the repository variable `V2_DEPLOY == 'true'`; the concurrency group is `v2-refresh-deploy`; deploy, persist and alert run from `main` only; the kick script refuses the V1 repository unless `AID_ALLOW_V1=1` | Finding 16: GitHub Pages serves one site per repository, and V1's workflow, concurrency group and cron belong to the live site. Pushing this tree must not be able to build, deploy or cancel anything | Renaming the workflow files (rejected, [8.4](#84-tried-and-rejected)) |
| 9 | **No data commits to `main`.** Generated data lives in the Pages artifact; `state.json` is restored from an orphan `data` branch holding one force-pushed commit (since the final round the branch is the primary path and the state is no longer published with the site unless `V2_PUBLISH_STATE=true`) | 99.2% of V1's history was bot commits, and a failed push had blocked good deploys | V1's commit-then-deploy |
| 10 | **Split jobs with least privilege**: build (`contents: read`), deploy (Pages + OIDC, runs no repository code), persist (`contents: write` on `data`), alert (`issues: write`); `npm ci --ignore-scripts`; actions pinned by commit SHA; the API key reaches the brief stage only | Finding 12 | One job |
| 11 | **Storage namespace `aid2:`** with a one-time, read-only import of V1 `ai-drudge:*` keys; V2 code cannot define a key outside the prefix | V1 and V2 may share the `github.io` origin; the review showed a schema change on the shared bookmarks key makes V1 delete every saved snapshot. Article ids keep V1's hash, so imported bookmarks still resolve | Sharing keys; a migration that rewrites V1 keys |
| 12 | **TypeScript ~6.0.3, Vite 8, React 19.3.1**, Tailwind 4.3.5, fast-xml-parser 5.12.1, tsx 4.23.15, `.node-version` 24, `engines.node >= 22.15.0` | The upgrade was trialled step by step in a scratch copy with no source change needed: all 7 advisories cleared, the lockfile fell from 190 to 125 packages (Vite 8 drops Babel, Rollup and browserslist), and a headless render of the homepage was byte-identical. TypeScript 6 with a split tsconfig stops Node globals type-checking in `src/` and DOM globals in `scripts/` | TypeScript 7.0.2 (deferred, [8.4](#84-tried-and-rejected)); staying on Vite 6 |
| 13 | **The per-source cap runs after relevance**, default 8, and must not cut corroboration | Finding 5 and RE-01 | A cap before the gate; no cap |
| 14 | **TOP STORIES replaces Trending and the separate Lead**: ai-desk stories with 2+ publishers inside 72 h (120 h when fewer than 4 qualify), ranked by score, never a release or community item; the lead is the first of them and is kept while it stays in the top 3 and is under 24 h old | Findings 1 and 4 | Four stacked blocks |
| 15 | **The fallback brief is not rendered.** The Daily Brief box appears only when `brief.source === "claude"` | The deterministic fallback restates TOP STORIES; V1's fallback was the product for five months and was poor | Showing the fallback |
| 16 | **Feed state**: conditional GET, last-good items carried forward up to 6 h, quarantine after 48 consecutive failures with one probe a day, an empty-but-valid feed is an error | Finding 9. V1 re-downloaded 72.8 MB on every run although, in the reviewer's test, 124 of its feeds answered 304 to a conditional GET | Stateless fetching |
| 17 | **Baseline rule.** On the first build that reads a source, a dated item is "first seen" at its publication time and an undated one just beyond the source's age limit | Otherwise the first build stamps the whole corpus NEW and undated back catalogue lands on top of a section | First seen = build time, always |
| 18 | **Package boundaries enforced by a test** (`test/boundaries.test.ts`): `shared/` is pure, `src` never imports `scripts/`, a pipeline stage never imports a sibling stage | 14 concepts had drifted into 2-6 copies in V1 | Convention only |
| 19 | **A committed fixture**, `test/fixtures/v2/`, copied by `npm run data:fixture` | A fresh clone runs and tests without the network | Fetching on first run |

### 8.4 Tried and rejected

| Item | Where it came from | Why not |
|---|---|---|
| TypeScript 7.0.2 | Dependency trial | It passed, but ships no JS API and is outside the typed-lint tooling's supported range; Dependabot is told to ignore the major |
| Biome as the one new dev dependency | Tests reviewer | The plan held to zero new dependencies; there is still no linter or formatter |
| Prerendering the home view in CI | Performance reviewer | Not built; first paint needs the entry bundle and `front.json` |
| Model-release ledger and regulatory tracker with deadlines; daily archive page; PWA / offline | Product proposals | Not built in 2.0.0 |
| Accounts or sync, in-browser LLM or semantic search, bias ratings, push or email, thumbnails, Hacker News points in the UI | Product reviewer's "do not build" list | Out of scope for a static, single-reader site; only 7 of 274 stories matched Hacker News at all |
| V1's stale dimming (> 72 h) | Carried by WP9 as a class | Sections now have 14-21 day windows and would be mostly grey; the age label carries the information |
| Registry status `probation` and fallback URLs as fields | Contract request WP1-3 | The `probation` and `fallback` tags already reach the gate and the Sources page |
| Wider tracking-parameter stripping in `canonicalUrl` | Contract request WP3-5 | It changes ids V1 already emitted, so imported bookmarks and read state would stop matching |
| App version injected by the bundler; `*.test.tsx` files; a search-term prop on the headline row | Contract requests WP8-3, WP8-4, WP10-5 | A pinned constant works under node; one test-file convention; the CSS Custom Highlight API covers highlighting |
| Lowering the cluster merge threshold from 0.40 to 0.39 | Fix round, RE-02 | Merged the remaining split stories and three false pairs |
| Must-carry or veto rules to separate the Genie 4 and Gemini 4 Hydrogen items from the Gemini 4 Neon story | Fix round, RE-05 | Every rule tried broke the IPO or another correct story |
| Lead demotion per item | Fix round, RE-04 | Google News copies then led over a newsletter's own post in 8 stories; demotion is per publisher |
| Renaming workflows to `v2-refresh.yml` / `v2-audit.yml` | Fix round, F9 | No protection gained: if this tree reaches V1's `main`, V1's workflow and scripts are gone either way; the preflight step fails loudly instead |
| A lexical grounding check on the brief (every number and capitalised token must appear in the cited stories) | Fix round, SEC-2 | Rejects legitimate paraphrase and domain-like names (llama.cpp, Node.js), making the brief disappear |
| Lowering the stored raw-summary cap | Fix round, perf-09 | At 1,500 characters 175 published summaries changed and 39 emptied |
| Bare term `moonshot` in the AI gate | Fix round, PF-1 | A common English word ("cancer moonshot"); `moonshot ai` and the model names cover it |
| Tier 4 for the SEC / FINRA query feeds | Fix round, REG-04 | Tier 4 renders grey; this is the owner's compliance signal |
| Refreshing the committed fixture from live data | Fix round | 62 tests failed (they pin facts of the 2026-11-19 payload); restored byte-identical. Done as a deliberate migration in the final round ([6.7](#67-final-round-2026-11-20)) |
| Stateless Atom feed replaced by an append-only ledger with a dwell time | Auxiliary-pipeline review | WP6 shipped a stateless feed ordered by first-seen with stable ids; entries still rotated in the fix-round measurement (F7, open) |
| A per-request "still trying" state and a storage-refused banner | Fix round, CC-5 and CC-7 | Needs a service-contract change and a UI surface; left as console warning and the existing retry. Both were built in the final round |

### 8.5 Defects found at cutover

Found by the first live builds and the first browser run on 2026-11-20. "Fixed" means fixed by the
end of the fix round unless a later round is named. The last column is the state at the end of the
fix round; the final round then closed rows 2 (hnrss.org replaced), 7, 10 (first half), 11, 12 and
14 (the state left the site), and brought row 18 to 108.20 kB
([6.7](#67-final-round-2026-11-20)). Rows 13 (two splits) and 20 are still open.

| # | Defect | Evidence | Status at the end of the fix round |
|---|---|---|---|
| 1 | Stock quotes: eight parallel requests to the quote provider got 6 of 8 rejected; a browser User-Agent alone drew HTTP 429 on every symbol | Builds 00:52Z (2 of 8) and 00:54Z (0 of 8) | Fixed at cutover: one symbol at a time, identifying User-Agent first, browser string on the retry host. 8 of 8 from 01:01Z |
| 2 | hnrss.org answered HTTP 502 for the same 7-8 of 11 queries three builds running | Build logs | Mitigated: one request at a time with a 1 s gap; carry-forward covers outages. Still 4-5 failures in the fix-round builds (carried) |
| 3 | Google News cold start: about 210 wrapper links, 60 resolved per build, so ids and links of about 150 items changed under the reader for four builds, and ingest sat at about 30 s | Build logs; observation 12 | Fixed: up to 240 per run inside a deadline; the fix-round build resolved 144 with 0 left; later ingest 19.9 s |
| 4 | No conditional-GET hits on the first warm build | 00:54Z logged no 304; the 00:56Z rerun logged 264 | Working from 00:56Z. Cause not recorded |
| 5 | `washington-post-technology` exceeded the 8 s header timeout on every cutover build; `pivot-to-ai` intermittently | Build logs; observation 8 | Fixed: 8 s, then 16 s on one retry. Both OK in the fix-round builds; both still tagged `probation` |
| 6 | TOP STORIES #3 (the GPT-6.2 launch) and #8 led by a third-party changelog | Observation 1 | Fixed (RE-01, RE-04): led by OpenAI News |
| 7 | Search for "FINRA" returned rows matching only a source name, with off-mission titles | Observation 2 | Partly fixed: the junk rows are gone; 6 of 7 results are still name-only matches, ranked below title matches |
| 8 | Techmeme rows kept the "(Author/Outlet)" tail, ran to about 180 characters and linked to techmeme.com | Observation 3 | Fixed: tail stripped, row attributed and linked to the outlet |
| 9 | Seen titles in TOP STORIES rendered grey and looked disabled in the dark theme | Observation 4 | Fixed (A11Y-01) |
| 10 | Two "Export briefing" buttons on the Watch page; about 190-207 px of non-sticky chrome on phones | Observations 5, 6 | Unchanged by design |
| 11 | A tier-1 FINRA notice was templated correctly, then dropped by its source's include terms | Observation 9 | Partly fixed: kept, at POLICY #11, one row below the homepage list |
| 12 | A PostgreSQL release landed in LOCAL & OPEN MODELS on a summary-only term match | Observation 10 | Fixed in the registry; include terms still match title and summary equally (PF-12, open) |
| 13 | Cluster misses: the European Commission attack as two rows, the AI Safety Caucus as three, China chip sales in two sections | Observation 11 | The Commission story is one 3-publisher story; the caucus and chip-sales stories are still split |
| 14 | `state.json` was 5.4 MB and is deployed publicly | Observation 13 | 3.3 MB (0.98 MB gzip); still public, because CI restores state from the live copy |
| 15 | No pull-request workflow; a failed `npm audit` filed no issue; the alert job treated cancelled runs as failures | Observation 14 | `ci.yml` added and the other two changed; **not run on GitHub** |
| 16 | The briefing-kit stylesheet was linked before the main stylesheet | Observation 15 | Fixed: the kit sheet is off the entry and loads with the lazy chunks |
| 17 | Six alive-but-slow sources reported as stale | Observation 16 | Fixed: `low-cadence` tag, 365-day stale limit; 0 stale in the audit |
| 18 | Entry bundle 102.5 kB gzip against V1's 69 kB | Observation 17 | **Worse**: 109.61 kB |
| 19 | Two scraper sources produced the title "Read On" for every card | WP1 report | Fixed at cutover (the scraper reads the card title for call-to-action links); both sources un-paused |
| 20 | `public/feed.xml` is still tracked by git although `.gitignore` lists it | Fix round, F11 | Open: needs `git rm --cached public/feed.xml` in the cutover commit |

## 9. Open at the end of the fix round

Recorded by the integrator on 2026-11-20 02:32Z, ranked, and kept as written. The final round
worked from this list; what became of each item is the last table of
[6.7](#67-final-round-2026-11-20), and the current open list is in
[FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md).

| # | Item |
|---|---|
| 1 | Cluster quality: IPO fragments hold 3 of 12 TOP slots; two stories still split; one impure cluster; no TOP-membership stickiness |
| 2 | Regulator placement: the score term helps for about a day; no placement floor for tier-1 regulator notices; one regulator can take 3 homepage rows |
| 3 | LOCAL & OPEN MODELS homepage quality; one model-release row unplaced by the 3-day MODELS window |
| 4 | Google News query feeds admit low-quality outlets |
| 5 | The committed fixture is still the bridged V1 payload of 2026-11-19 20:08Z; 62 tests pin it |
| 6 | Entry bundle 109.61 kB gzip |
| 7 | Search noise from source-name and section-label matches |
| 8 | `state.json` is public and 3.3 MB |
| 9 | Stability at the real cadence is unmeasured; hnrss.org failures recur |
| 10 | Mute edge cases: publisher count under mutes can understate by one; a re-led row's hover card shows no "Also:" list; time filters use the original lead's time |
| 11 | Not verified in a browser: briefing dialog from the home page and its offline message, the re-led row, the Keyboard checkbox, the 2 h stale banner |
| 12 | The stale banner is a constant 2 h, not derived from `status.json` (`staleAfterMinutes` 90) |
| 13 | Two sources still tagged `probation` after clean builds |
| 14 | `git rm --cached public/feed.xml` in the cutover commit |
| 15 | Smaller requests not done: a per-source fetch timeout, keyboard-navigation DOM tests, test-only exports still exported, About page showing the brief fallback reason, and others |
| 16 | README and documents other than CONTRACTS.md not yet rewritten (this round) |
| 17 | Unchanged by design: two briefing entry points on the Watch page, phone chrome height, duplicate time-chip groups on section pages |

Not verified at any point in the V2 work, and worth doing before the first deploy:

1. Nothing has run on GitHub Actions: the three workflows, the `data` branch persist, the state
   restore from the live site, Dependabot. They were checked by tests, YAML parsing and local runs
   of the shell steps with a stub.
2. Nothing has run on Linux or on Node 22 / 24; all work was on macOS arm64 with Node 26.7.0.
3. `npm test` on a clean checkout (five test files reference `public/data` paths).
4. The Claude brief has never run: no API key was set in any build, so every brief was the
   deterministic fallback (`no-key`).
5. A second day of news. Thresholds, gate terms and routing rules were tuned on the 2026-11-19
   corpus and the builds of 2026-11-20.
