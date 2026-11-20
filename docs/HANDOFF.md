# AI DRUDGE V2 - Handoff

Written 2026-11-20 (04:35 UTC); brought up to the closing round and re-verified at 05:30 UTC. Read
this file first. It is for the engineer or AI session that takes over cold.

**Answer first.** V2 is complete, tested and gated as a local working tree, and **nothing of it is
committed or deployed**. V1 is the only live site. The next step is not code: it is four owner
decisions (§2), a browser pass that the last two rounds were not allowed to do, one local commit
and the first run on GitHub (which is also the first run on Node 24 and Linux).

How this document was verified: every command in §8 marked "re-run" was executed in this tree for
this document; paths, constants and counts were read from the code. Figures that need the network
(`build:data`, `validate:feeds`, `npm audit`, `compare`) are quoted from the integration and
closing steps of the final round of the same day and marked so. "Not verified" means exactly that.

Sections: [1 State](#1-state-in-one-screen) · [2 What to do first](#2-what-to-do-first) ·
[3 Map](#3-map-of-the-codebase) · [4 Operations](#4-daily-operations) · [5 How to](#5-how-to) ·
[6 Traps](#6-invariants-and-traps) · [7 Defects](#7-known-defects-and-unfinished-work) ·
[8 Verification](#8-verification-commands-and-expected-results) · [9 Glossary](#9-glossary) ·
[10 Other documents](#10-other-documents)

---

## 1. State in one screen

| Fact | Value on 2026-11-20 |
|---|---|
| What V2 is | A static AI news front page. Pipeline (`scripts/pipeline`: ingest -> normalize -> relevance -> cluster -> score -> route -> emit) reads the registry and writes JSON to `public/data/v2/`; a Vite 8 + React 19 + TypeScript 6 single-page app renders it (hash routes, `localStorage`, no server) |
| Where | Git worktree `~/Documents/Development/ai-drudge/v2`, local branch `v2`, no upstream. The only remote is `origin` = the V1 repository |
| Committed | **Nothing.** `HEAD` is still the V1 data commit `8d5cbc26` the branch was cut from. `git status --short` lists 99 entries: 21 modified, 48 deleted (V1 files), 30 untracked paths (all of V2) |
| Live | **V1 only**: https://pnelsonftp.github.io/ai-drudge/ from branch `main`, whose checkout is the parent directory. No V2 repository and no V2 Pages site exist (both answered 404 in the link check of 04:25Z) |
| GitHub | The three V2 workflows have never run. They are inert until the repository variable `V2_DEPLOY=true` is set |
| Registry | 414 sources (413 active, 1 paused: `venturebeat-ai`), 405 publisher entries (317 own a source), 10 denied outlets, 12 `probation` tags. Tiers 1/2/3/4: 6 / 66 / 255 / 87 |
| Local data | `public/data/v2/` holds the closing build of 2026-11-20T05:16:55.936Z (keyless): 412/413 sources OK, 1 carried forward (`arxiv-cs-cr-llm-agent-security`, HTTP 429), 322 stories in 367 rows, 143 homepage rows, TOP 12, gate PASS with 0 warnings |
| Fixture | `test/fixtures/v2/` is the same build (refreshed in the closing round) plus three synthetic health rows (§5.7) |
| Checks (re-run at 05:25Z) | `npx tsc -b` exit 0; `npm test` 2,782 pass / 0 fail (449 suites, 132 test files, about 19 s); `npm run build:check` PASS; `npm run sbom -- --check` "SBOM is current" |
| Checks (integration step, 04:20-04:25Z, not re-run) | `npm audit` 0 vulnerabilities; `validate:feeds` 413/413 OK; `check:links -- --data` 0 broken registry links, 0 broken article links. The docs group of the link check was re-run at 05:47Z: 4 "broken" of 1,908, none a dead reader link (§5.8) |
| Never verified | Anything in a browser (last two rounds); anything on GitHub; Node 24 on Linux (all results are Node 26.7.0 on macOS); the model-written brief (every build was keyless); ranking behaviour at the real 30-minute cadence |
| Dev server | The session that wrote this had one on port 5180 serving the closing build. A new session starts its own (command 3 below) |

See V2 in three commands (fresh clone; Node >= 22.15.0, CI pins 24 in `.node-version`):

```bash
npm ci --ignore-scripts
npm run data:fixture                       # frozen 05:16Z edition, no network
npm run dev -- --port 5180 --strictPort    # http://localhost:5180/ai-drudge-v2/
```

- In this worktree `node_modules/` and the live build the fixture was frozen from are already
  present: run only the third command. `data:fixture` would replace the eight public JSON files
  with the frozen ones (three of them differ from the build: `front.json` in one count,
  `health.json` and `status.json` for the synthetic health rows).
- Live data instead of the fixture: `env -u ANTHROPIC_API_KEY npm run build:data` (network, 19-36 s
  measured), then `npm run build:check`.
- The fixture edition shows the "Headlines may be delayed" banner. That is expected: it is one
  frozen day.

---

## 2. What to do first

### 2.1 Owner decisions that are open

Facts are in the middle column; the last column is a recommendation, labelled as such. Decisions
1-4 block go-live. The rest can wait for the first week of real data.

| # | Decision | Facts | Recommendation |
|---|---|---|---|
| 1 | **Go-live option** | A: new public repository `ai-drudge-v2`, both sites side by side, zero effect on V1. B: push branch `v2` to the V1 repository, nothing deploys. C: replace V1 on `main`, manual rollback. Table and steps: [DEPLOYMENT.md](./DEPLOYMENT.md) §6-§9. Every GitHub step is untested | A, then C later if the V1 URL must be kept |
| 2 | **`ANTHROPIC_API_KEY` for the AI-written brief** | Without the secret every build publishes the deterministic brief (`reason: "no-key"`) and the homepage shows **no Daily Brief** (the client renders it only when `brief.json` has `source: "claude"`). With it: one API call per build, model output on a public page, audit trail = `brief.json` `.model` + `.generatedAt` and the Actions log. Cost about $0.01 per build, $15-20 a month at 48 builds a day: an estimate, never measured. The path has never run against the real API. [DEPLOYMENT.md](./DEPLOYMENT.md) §11, [SECURITY.md](./SECURITY.md) §3.4 and §7 | Go live keyless; enable after the first clean day, in a dedicated workspace with a spend limit |
| 3 | **`state.json` publication** | Default: removed from the Pages artifact; the single copy lives on branch `data` of a public repository (feed-derived text only, no reader data; 3.31 MB). `V2_PUBLISH_STATE=true` publishes it with the site again as a second copy. The branch path was executed locally against a bare repository only | Keep the default; set the variable only if the second run does not report "State restored from: data branch" |
| 4 | **Shared `github.io` origin** (SEC-8) | Options A and C serve V2 from the same origin as V1, so both share one `localStorage`; any script on any page of that origin can read V2's reader state. V1 ships no CSP (review finding, V1 not inspected). A custom domain removes it and is supported by `SITE_URL` / `SITE_BASE`, untested. [SECURITY.md](./SECURITY.md) §3.9 | Accept for the trial, or decide the domain before readers build up state |
| 5 | Synthetic health rows in the fixture | Three rows of the fixture's `health.json` are written by the refresh tool, not by the build (§5.7). A byte-pure fixture is a small change in `test/helpers/fixtureCases.ts` plus the Sources page tests | Keep; they are listed in the manifest |
| 6 | Tag `nist-ai-news` and `cisa-alerts` as `regulator` | Both publishers are in `ROUTE_POLICY.regulatorFloor` but inert: their sources lack the tag. Tagging adds the POLICY homepage floor and the +10 score term. A route test pins the current state | Owner's call; CISA alerts would then compete with FINRA / SEC notices for 4 guaranteed rows |
| 7 | Stale banner threshold | `PIPELINE.staleAfterMinutes` = 120 (`scripts/pipeline/context.ts`); reader-facing through `status.json` | Keep until the real cadence is known |
| 8 | NEW chip only on home and `#/new` | Shell time chips were removed from the other routes in the final round (`showsTimeChips`) | Keep |
| 9 | LOCAL release rows | 9 runtime release feeds carry `routeTo ["open_local"]`; LOCAL shows at most 2, never in its first 3 rows. `ROUTE_POLICY.releaseRows.maxRows = 0` reverts | Keep |
| 10 | Disclosure check before the repository is public | The closing round removed the `owner-stack` tag (57 sources) and reworded the registry notes, so the published source list no longer describes the reader. The last three registry notes that named the reader's role or firm type were reworded on 2026-11-20 and SOURCES.md regenerated. Left: [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) still explains choices by the reader's local-model lab; the tag `owner-pick` remains on 7 sources; three frozen feed fixtures contain third-party commit-author addresses (§7, KD-54). No name, employer or e-mail address of the owner is in the tree | Read [SECURITY.md](./SECURITY.md) §2.5 and decide: reword the research file or keep it out of the public repository |
| 11 | Ticker band on phones | Hiding `.ticker-bar` below 720 px saves about 25 px of non-sticky chrome | Decide during the browser pass |
| 12 | Which unknown outlets to vouch for | An outlet no publisher entry claims does not count as coverage. Two security stories rank lower for it (§7, KD-10) | Add publisher entries case by case |
| 13 | Unit tests in scheduled refreshes | `refresh.yml` runs `tsc` and `npm test` before every data build, so a test flake stops that slot's deploy (§7, KD-30) | Keep until the suite has run on GitHub for a week; then decide |

### 2.2 Ordered checklist for the next session

1. Read this file, then [CONTRACTS.md](./CONTRACTS.md) §1-§5, §11 and §13.
2. Run the baseline in §8. If `tsc`, the tests or the gate differ from the expected results, stop
   and find out why before changing anything.
3. Get decisions 1-4 from the owner.
4. **Browser pass** (never done in the last two rounds). Use the production build, because only it
   carries the CSP: `npm run build && npm run preview`. Check: no CSP violation in the console
   (`style-src 'self'` with the hover card and sticky offsets); the lazy keyboard / hover chunk
   arriving after first paint; the stale, storage-refused and "still trying" banners; italic
   low-tier titles against upright grey seen titles; the "latest ..." label; 24 px compact rows; the
   source-name group on the search page; the "Dim headlines I have seen" switch; a re-led row under
   a mute and its hover card; the "also linked:" label and the "also" button on a row; the briefing
   dialog; the phone layout at 375 px.
5. Cutover commit, with the owner's approval, exactly as in [DEPLOYMENT.md](./DEPLOYMENT.md) §7. It
   includes `git rm --cached public/feed.xml`; afterwards `git ls-files public` must print only
   `public/favicon.svg`. No agent has run a git write command in this tree.
6. First run on Node 24 and Linux, before `V2_DEPLOY=true` is set (§7, KD-3): `ci.yml` runs
   typecheck, tests and the site build on every pull request. In Option A, open a pull request in
   the new repository after the first push; in Option B, open a draft pull request from `v2` in the
   V1 repository and do not merge it ([DEPLOYMENT.md](./DEPLOYMENT.md) §9.1).
7. Go live by the chosen option ([DEPLOYMENT.md](./DEPLOYMENT.md) §8 or §9), then the post-deploy
   checks of its §12 and the hardening checklist of [SECURITY.md](./SECURITY.md) §9. First runs to
   watch: "State restored from: **data branch**" in the second run's summary; the Washington Post
   row at about 10 s with 1 attempt; the feed count from a GitHub runner IP.
8. After 24 hours at the real cadence, measure what one news day could not show: TOP churn,
   `topHeld` (the hold has not been exercised on live data), state size, and the cluster rules that
   rest on 2-4 examples.
9. Only then the editorial defects of §7 (KD-7 to KD-25), one at a time, each measured on a replay
   before and after.

---

## 3. Map of the codebase

Test counts are `*.test.ts` files per directory (132 in total). The single-file test command is in §6.1.

| Directory | Responsibility | Entry file | Tests |
|---|---|---|---|
| `shared/` | Pure code both sides use: data contract (schema v2), the 15 sections, guards, cross-file invariants, selectors (`visibleStory`, search, time filters), text, time, URL, ids. No `node:`, no DOM (`tsconfig.shared.json` proves it) | `contract.ts`, `sections.ts`, `select.ts` | 9 |
| `scripts/registry/` | The source registry: sources by section file, publishers, outlet deny list, defaults, validation at import | `index.ts` (`REGISTRY`), `sources/*.ts`, `publishers.ts`, `outlets.ts`, `defaults.ts` | 2 |
| `scripts/pipeline/` (root) | Composition root, stage types, context and policy constants | `run.ts` (`npm run build:data`), `context.ts` (`PIPELINE`, `ENV`), `types.ts` | 2 |
| `scripts/pipeline/ingest/` | HTTP client, per-host pool and backoff, feed parser, scraper, JSON API, Google News resolver, HN signal, carry-forward | `index.ts` | 9 |
| `scripts/pipeline/normalize/` | Title cleaning, canonical URL and ids, dates, duplicates and twins, release collapse, outlet vetting | `index.ts` | 6 |
| `scripts/pipeline/relevance/` | Per-source rules, AI gate, noise rules, per-source cap, corroboration rescue | `index.ts`, `aiTerms.ts`, `noise.ts` | 5 (incl. `corpus.test.ts`) |
| `scripts/pipeline/cluster/` | Stories from items: similarity, product veto, corroborated pass, lead and member order | `index.ts`, `similarity.ts` (`CLUSTER`) | 2 (labelled-pair corpus) |
| `scripts/pipeline/score/` | Score parts (tier, recency, importance, coverage, hn) and weight `w` | `index.ts`, `weights.ts` (`SCORE`) | 2 |
| `scripts/pipeline/route/` | Section placement: keyword rules, windows, diversity, starvation fill, homepage rows, regulator floor, TOP, running story, hold, section focus | `index.ts`, `rules.ts` (`ROUTE_RULES`, `ROUTE_POLICY`, `SECTION_FOCUS`) | 12 |
| `scripts/pipeline/emit/` | The published files, river memory, health, status, Atom, OPML, explain record, gate thresholds (`quality.ts` `GATE`), write ceilings | `edition.ts` (`emit`), `write.ts` (`writeBundle`) | 7 |
| `scripts/pipeline/enrich/` | Daily Brief (Claude call, validation, fallback) and stock quotes | `brief.ts`, `stocks.ts` | 2 |
| `scripts/pipeline/state/` | `state.json`: load, defensive parse, fold a run into the next state | `store.ts` | 1 |
| `scripts/tools/` | Gate CLI, explain, fixture install and refresh, feed validator, link checker, V1 comparison, sources doc, feed-audit report | one file per npm script (`check-data.ts`, `explain.ts`, ...) | 7 (incl. `workflows.test.ts`) |
| `scripts/` (root) | SBOM generator, Mac kick script | `generate-sbom.ts`, `kick-refresh.sh` | 2 |
| `src/app/` | Shell, service interfaces and wiring, hash router, route registry, lazy interaction chunk | `services.ts` (contract), `createServices.ts`, `AppShell.tsx` | 8 |
| `src/data/` | Edition and sources stores, guarded fetch with retry and session cache | `editionStore.ts` | 3 |
| `src/state/` | Reader state in `localStorage`: saved, mutes, read state, settings, watchlist, last visit, backup, V1 migration | `index.ts`, `storage.ts` | 11 |
| `src/keyboard/` | Single-key shortcuts and the row cursor | `useKeyboardNav.ts`, `keymap.ts` | 3 |
| `src/styles/` | Tokens, base, chrome and component CSS; contrast checks | `index.css`, `tokens.css` | 2 |
| `src/features/chrome/` | Masthead, section nav, banners, footer, ticker, mute notice, briefing dialog, route outlet | `model.ts` | 2 |
| `src/features/headline/` | The one row component and the hover card | `HeadlineRow.tsx` | 5 |
| `src/features/home/` | Front page: lead, TOP STORIES, sections grid, LATEST, Daily Brief | `route.tsx`, `homeModel.ts` | 2 |
| `src/features/{section,search,new,watch,saved,sources,settings,about}/` | One lazy route each | `route.tsx` + `model.ts` in each | 2 each |
| `src/features/export/` | Briefing export and the shared page / dialog kit | `briefing.ts`, `kit/` | 7 |
| `src/main.tsx` | Client entry: frame guard, services, render | - | - |
| `test/` | Cross-package tests (boundaries, contract round trip, fixture cases), helpers, fixtures | `helpers/`, `fixtures/` | 5 |
| `.github/workflows/` | `refresh.yml` (build, gate, deploy, persist, alert), `feed-audit.yml` (weekly), `ci.yml` (pull requests) | - | pinned by `scripts/tools/workflows.test.ts` |
| `docs/` | This file and the documents in §10 | - | - |

Import rules, enforced by `test/boundaries.test.ts`: `src` never imports `scripts/` or node
built-ins; `shared` imports only `shared`; a pipeline stage never imports a sibling stage; the
registry never imports the pipeline; build code never imports client code.

---

## 4. Daily operations

**Today there are none for V2.** Nothing is deployed; data is built by hand with
`npm run build:data`. Everything below describes the design in the workflow files and is untested
on GitHub ([DEPLOYMENT.md](./DEPLOYMENT.md) §14 is the full register).

### 4.1 Refresh cadence

| Source of runs | Cadence | Notes |
|---|---|---|
| `refresh.yml` cron | `7,22,37,52 * * * *` UTC | The `guard` job skips a scheduled slot when the live `status.json` is younger than 20 minutes: at most 2 builds an hour. Scheduled runs come from the default branch only |
| Mac launch agent | at minute 08 of hours 06-22 and at 02:08 local time today (per [DEPLOYMENT.md](./DEPLOYMENT.md) §1; not re-checked) | It currently kicks **V1** ("Refresh and deploy" on `main`). V2 needs its own agent or an edit: [DEPLOYMENT.md](./DEPLOYMENT.md) §10. `scripts/kick-refresh.sh` defaults to the V2 repository and refuses the V1 one unless `AID_ALLOW_V1=1` |
| Push to `main` | per push | Not for `docs/**` or `*.md` |
| `feed-audit.yml` | Mondays 12:23 UTC | `npm audit`, feed validation, link check, SBOM currency (warning only) |
| Reader's browser | every 10 minutes while the tab is visible | `REFRESH_INTERVAL_MS`, `src/app/services.ts` |

`status.json` declares `cadenceMinutes: 30` and `staleAfterMinutes: 120`.

### 4.2 What the gate checks

`npm run build:check` (`scripts/tools/check-data.ts`; thresholds in `GATE`,
`scripts/pipeline/emit/quality.ts`). Exit 1 holds the deploy and the previous site keeps serving.

| Fails the build | Threshold |
|---|---|
| A file missing or failing its guard; cross-file invariants (`shared/invariants.ts`) | any |
| Freshness | `generatedAt` older than `BUILD_STARTED_AT` (CI only; a missing value is itself a failure in Actions) |
| Hollow edition | fewer than 60 placed stories; fewer than 10 of 15 sections with rows; a section showing fewer homepage rows than it could |
| Frozen content | newest placed story more than 24 h older than the build |
| Leaked old row | any row older than 60 days |
| Feed mass failure | fewer than 60% of live feeds OK; 40% of the registry chronic; 25% answering empty |
| Size | a file over its refuse-to-write ceiling (`emit/write.ts`) |
| XML | malformed `feed.xml` or `feeds.opml` |

Warnings never block: `front.json` over 48 KB gzip (`FRONT_GZIP_WARN_BYTES`), feeds below 85% OK,
fewer than 120 stories, a tier-1 source failing 6 runs, a failed Claude brief. A **brief alert**
(6 consecutive keyed builds with a failed brief) is an error-level annotation, never a failure.
Zero-article guard: when nothing survives relevance the pipeline writes nothing, marks the existing
`status.json` as failed and exits 0; the freshness check then holds the deploy.

### 4.3 Where health is shown

| Place | What |
|---|---|
| `public/data/v2/status.json` | One build: run id and trigger, feed counts and failed names, story counts, gate verdict and warnings, brief source and reason, stocks |
| `public/data/v2/health.json` | Per source: `status` (`ok` / `failing` / `quarantined` / `carried`), error class, fail streak, last OK time |
| Sources page `#/sources` | `sources.json` joined with `health.json`: every source with its state, filterable |
| About page `#/about`, "Data freshness" | Story count, sources that answered, build id, why there is no AI-written brief |
| Footer | "N/M feeds OK" |
| Build log | Per-stage timing and count table; one line per failed source |
| `docs/SOURCES.md` | Snapshot of the registry with the last build's status (`npm run docs:sources`) |

### 4.4 How failures surface

| Failure | Signal |
|---|---|
| A build or deploy step fails | Rolling issue "V2 refresh failing" (opened, commented at most every 180 minutes, closed by the next green run) |
| Gate holds the build | Same issue; `status.json` `.gate.failures`; the site stays on the previous edition |
| No fresh edition for 2 hours | Reader sees "Headlines may be delayed - the last edition is ... old." and "delayed" in the tagline |
| A build finds no state while the site is up | `state restore` annotation and the "V2 refresh failing" issue (`state_lost`) |
| Claude brief fails 6 keyed builds in a row | Rolling issue "V2 Daily Brief failing". Before that: only `status.json` `.brief.reason` and a gate warning |
| One source fails | `health.json`, Sources page; last-good items are carried for up to 6 h; quarantined after 48 consecutive failures (probed once a day) |
| A host answers 5xx / 429 twice in a row | Its remaining sources are not asked this run: status `carried`, error `skipped`, detail starting `host backoff:` |
| `npm audit` finds high / critical | Rolling issue "Dependency audit failing" (weekly workflow) |
| Dead or stale feeds | Rolling issue "Feed audit: N problems" (weekly workflow) |
| Reader's browser refuses storage writes | Banner "This browser is not saving your changes ..." |

None of these issues exists yet: the alert jobs have never run.

---

## 5. How to

### 5.1 Add, pause or remove a source

Add:

1. Validate the candidate with the build's own client: put `[{ "name": "...", "url": "..." }]` in
   a JSON file and run `npm run validate:feeds -- candidates.json` (network). Add only a verdict of `OK`.
2. Check it is not already covered or deliberately removed: search [SOURCES.md](./SOURCES.md) for
   the host and read its "Removed sources" list. Earlier research and dead ends:
   [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md).
3. Add the entry to the file of its home section in `scripts/registry/sources/` (`queries.ts` for
   Google News and HN searches, `releases.ts` for GitHub release feeds, `scrapers.ts` for scraped
   pages). Required: `id` (kebab slug, never reused), `name`, `publisher`, `url`, `kind`, `scope`,
   `home`, `tier`. A new publisher goes in `scripts/registry/publishers.ts` (id, name, hosts).
4. Scope and tier: `scope: "ai"` is never gated; `scope: "general"` goes through the relevance gate
   (or the source's own `include` list) and needs a `note`. Tier 1 = first-party frontier labs and
   the owner's regulators, 2 = original reporting and primary documents, 3 = trade press, vendor
   blogs, newsletters (ceiling for query feeds), 4 = digests and community.
5. Bound noisy feeds: `include` / `exclude`, `includeIn: "title"`, `includeUrl` / `excludeUrl`,
   `maxItems` (ingest window), `maxKept` (rows per build, default 8), `maxAgeDays` (at most 45).
6. `npx tsc -b`, then `npx tsx --tsconfig tsconfig.app.json --test scripts/registry/registry.test.ts`.
   The registry validates itself at import, so a bad entry fails every test.
7. After the next data build: `npm run docs:sources`, and `npm run sbom -- --check` if a new
   external service was added.

Pause: set `status: "paused"` with a `note` saying why. The source stays in the registry and in
`sources.json` and is not fetched.

Remove: delete the entry (its remembered river rows leave on the next build). Record a V1-era
source in `scripts/registry/sources/removed.ts` with the reason. Never reuse the id.

Vouch for an outlet that query feeds find: add a publisher entry with its host. Deny one: add the
host to `OUTLET_DENY` in `scripts/registry/outlets.ts` with the evidence the list requires.

A source's first build is a baseline for that source: dated items are first seen at their publish
time (not "new"), undated items age out at once.

### 5.2 Tune relevance terms

| What | Where |
|---|---|
| The AI gate for `scope: "general"` sources (strong, model-family, compute, context and home-beat terms) | `scripts/pipeline/relevance/aiTerms.ts` |
| Noise (webinar, event, job, sponsored, index, promo) | `scripts/pipeline/relevance/noise.ts` |
| One source's own rules | its registry entry (`include`, `exclude`, `includeIn`, `includeUrl`, `excludeUrl`) |
| Which section a story is routed to | `ROUTE_RULES` in `scripts/pipeline/route/rules.ts` |

Term syntax (`shared/text.ts` `compileTerms`): case-insensitive, word-boundary ("ai" never matches
"said"), spaces and hyphens interchangeable, trailing `*` = prefix, leading `*` = suffix, no plural
unless written.

Procedure: change the term, then run
`npx tsx --tsconfig tsconfig.app.json --test scripts/pipeline/relevance/corpus.test.ts scripts/pipeline/relevance/aiTerms.test.ts`.
`corpus.test.ts` pins the outcome on the 2026-11-19 corpus (general-source items: kept 211,
off_topic 91, too_old 90, source_cap 41, noise 3) and a 60-decision hand-checked precision sample.
A pinned number that moves is a result to read, not a number to update blindly: list which items
changed sides first. Last measurement on live data (final round): precision 85% strict / 92%
lenient on 60 passes, 60 of 60 sampled drops correct.

### 5.3 Debug "why is this story here / missing"

`npm run explain -- <article id | URL | title words> [--mute <source-id,...>]`. It reads the record
of the last `build:data` (`node_modules/.tmp/explain.json`; 1,280 stories and 2,905 dropped items
for the closing build). Without that file it falls back to the published files and shows placements
but no score parts. At most 5 matches per kind.

Real run in this tree (2026-11-20, closing build):

```text
$ npm run explain -- "Anthropic shares jump"
Run of 2026-11-20T05:16:55.936Z - 1 story, 0 dropped item(s) match "Anthropic shares jump":

Anthropic shares jump 17% after record Wall Street listing
  id 1587519  https://www.ft.com/content/2b203097-7c61-464f-810f-962912a133dd?syn-25a6b1a6=1
  source FT Artificial Intelligence (Financial Times)  flags: paywall
  score 94.36 = tier 18.84 + recency 42.66 + importance 0.00 + coverage 32.85 + hn 0.00
  age 8.2 h (effective 2026-11-19T21:02:09.000Z), weight 2, 3 publisher(s): financial-times, the-verge, the-algorithmic-bridge
  fade x0.94 at 8.2 h (half-life 96 h) is already applied to tier, importance, coverage and hn; recency has its own half-life (36 h)
  not in TOP STORIES: a follow-up of the running story "Anthropic prices initial public offering" [5hzny], without enough publishers of its own for a second slot
  placed: industry #15 (view-all only)
  placed: money #2 (homepage)
  route: routed to money by rule "money/deals: title[shares jump*, wall street] weak[listing] summary[raises $] = 6 pts"
  also (3):
    - Anthropic starts trading on Wall Street [20q6jq] - The Verge AI (The Verge)
    - Wall Street Is Wrong About Anthropic [kxuub7] - The Algorithmic Bridge (The Algorithmic Bridge)
    - Anthropic’s Wall Street stimulus fades [2ljdot] - FT Artificial Intelligence (Financial Times)
  if a reader mutes the lead's source (ft-artificial-intelligence): the row keeps its place and is re-led by "Anthropic starts trading on Wall Street" - The Verge AI [20q6jq], 2 publisher(s) shown
    (the story key stays 1587519, so its rank does not change; title, link, source, time and bookmark are the shown outlet's)
```

A missing story prints one of these instead (from `npm run explain -- "FINRA Regulatory Notice"`,
same build; two of the seven matches, the second abridged):

```text
Regulatory Notice 26-20: FINRA has adopted new Rule 3290 (Outside Activities Requirements) ...
  not placed in any section (would be listed under policy; river only)
  route: not routed
  cut from policy: window
  section focus in policy: policy/us-finreg +14 title[FINRA] (orders that section's list only; the score is unchanged)

Regulatory Notice 26-23: FINRA has adopted amendments to exempt specified collective trust funds (CTFs) from FINRA Rule 5130 (Restrictions on the Purchase and Sale of Initial Equity Public Offerings)…
  id zre84d  https://www.finra.org/rules-guidance/notices/26-23
  DROPPED at relevance: excluded (matched none of the source's include terms)  [source finra-regulatory-notices]
  a row an earlier build remembered for this item also leaves the 7-day river and search
```

How to read it:

| Line | Meaning | Where to change it |
|---|---|---|
| `DROPPED at normalize: invalid / duplicate / release_collapsed` | Unusable URL or empty title; repeat within one source; older or pre-release tag folded into the repo's one line | `scripts/pipeline/normalize/` |
| `DROPPED at relevance: too_old / off_topic / excluded / noise / source_cap` | Past the source's `maxAgeDays`; failed the AI gate; the source's own rules or a denied outlet; promo or event; over the per-source cap and not rescued | registry entry, `relevance/aiTerms.ts`, `relevance/noise.ts` |
| `cut from <section>: window / diversity / cap / mode / limit / policy / moved` | Outside the section's age window; publisher share cap; section row limit; source-mode section; already has its one routed section; home-only source or not in `routeTo`; moved (cyber -> ai_security) | `shared/sections.ts`, `route/rules.ts` `ROUTE_POLICY` |
| `not in TOP STORIES: a follow-up of the running story ...` | Folded by the running-story rule | `route/running.ts` |
| `section focus in <section>: <rule> +N ...` | A per-section ordering bonus (LOCAL, POLICY, AI SECURITY). It orders that section's list only; the score and TOP do not change | `SECTION_FOCUS` in `route/rules.ts`, `route/focus.ts` |
| `score ... = tier + recency + importance + coverage + hn` | Parts after the age fade | `score/weights.ts`, `score/importance.ts` |
| Nothing found at all | The source did not list the item in its window (`maxItems`), or the source is not in the registry | [SOURCES.md](./SOURCES.md); `npm run compare` classes this as "not fetched" |

Drops in the closing build, for scale: too_old 1,475, source_cap 460, release_collapsed 335,
off_topic 314, excluded 301, duplicate 10, noise 7, invalid 3. The tool does not yet say why a
story **left** TOP between two builds (§7, KD-39).

### 5.4 Tune clustering safely

Constants: `CLUSTER` in `scripts/pipeline/cluster/similarity.ts` (cosine `threshold` 0.4,
`attachThreshold` 0.25, `corroboratedThreshold` 0.29, 72 h window). The long comment above it
records every rule tried, measured and rejected: read it before proposing a new one.

1. Baseline: `npx tsx --tsconfig tsconfig.app.json --test scripts/pipeline/cluster/index.test.ts scripts/pipeline/cluster/similarity.test.ts`.
   Today: 55 tests pass in `index.test.ts`, with the diagnostic
   `recall on labelled same-story pairs: 58/62; false merges on labelled different-story pairs: 1/54`.
2. The corpus tests in `cluster/index.test.ts` run on `test/fixtures/items-2026-11-19.json`:
   `SAME` (58 pairs that must stay together), `DIFFERENT` (53 pairs that must stay apart),
   `KNOWN_MISSES` (the accepted recall cost), `KNOWN_FALSE_MERGES` (the accepted precision cost:
   one pair today, a bond sale filed under a summit) and `LARGEST` (the 25 largest clusters, each
   hand-read for purity).
3. Make the change. Rules, in order of strength: a `DIFFERENT` pair that merges is a regression,
   never a new known cost. Never add to `KNOWN_FALSE_MERGES` or `KNOWN_MISSES` to make a test pass;
   an entry there is a decision recorded with its reason. If `LARGEST` changes, read the changed
   clusters before updating the list.
4. Prefer a narrow rule to a threshold move. Both fix rounds left the thresholds alone: at 0.39 one
   more real pair merges and three false ones do. The closing round's three vetoes (rival
   companies from the closed list `RIVAL_SUBJECTS`, a continent as the only shared unit, a pair
   sharing only words the whole run uses) are examples: each was measured alone on the live corpus
   and the fixture corpus, and each has a test that fails when the rule is switched off.
5. Measure on live data as well, because the corpus is one frozen day and lacks the newest cases:
   replay the `lastGood` items of `public/data/v2/state.json` through `processItems`
   (`scripts/pipeline/run.ts`) from a script outside the repository and diff the clusters before and
   after. The replay scripts of the fix rounds lived in the session scratch directory, which is not
   durable; none is in the repository.
6. Then the full suite. Route tests on the bridged edition
   (`scripts/pipeline/route/fixture.test.ts`) and the emit round trip (`test/contract.test.ts`) see
   cluster changes too.

Known splits with no safe rule found: China chip sales (FT / Reuters, cosine 0.244; a false pair
sits at 0.245), and the others listed in §7, KD-11.

### 5.5 Change sections

`shared/sections.ts` is the only declaration: `SECTIONS` order is homepage order; each row sets
label, short code, desk (`ai` / `owner` / `utility`), mode (`topic` / `source`), window
(soft / hard days, min items), homepage rows, view-all rows and the V1 ids folded into it.

| Change | Also touch |
|---|---|
| Rows, window or order of an existing section | `shared/sections.test.ts` ("matches the plan table" pins every value); `SECTION_PRESETS` in `src/app/presets.ts` when the order changes; check `front.json` stays under 48 KB gzip |
| Which stories a topic section attracts | `ROUTE_RULES` (`scripts/pipeline/route/rules.ts`); ordering inside one section: `SECTION_FOCUS` (LOCAL, POLICY, AI SECURITY) |
| Add, remove or rename a section | A contract change: `SECTION_IDS`, every `home` in the registry, route rules, `legacyIds` (V1 mute migration), presets, the gate's "10 of 15", and readers' stored section order and hidden sections. Do it in one commit with `npx tsc -b` and the whole suite |

`source`-mode sections (industry, research, safety, cyber, analysis, quantum, releases) hold only
stories whose source has that `home`; keyword rules never route into them.

### 5.6 Regenerate SBOM and SOURCES

| Command | Writes | Notes |
|---|---|---|
| `npm run sbom` | `docs/SBOM.json` (CycloneDX 1.6) and the marked tables of `docs/SBOM.md` | Deterministic: unchanged inputs rewrite identical bytes. Run after any change to `package-lock.json`, the workflows' actions, `.node-version` or an external endpoint |
| `npm run sbom -- --check` | nothing | Exit 1 when the file is not current. Today: "SBOM is current: docs/SBOM.json (125 npm packages, 6 GitHub Actions, 7 services)." |
| `npm run docs:sources` | `docs/SOURCES.md` | From the registry and `public/data/v2/health.json`; `-- --report <verdicts.json>` uses feed-audit verdicts instead. The file is generated: never edit it by hand |

### 5.7 Refresh the fixture

`test/fixtures/v2/` is a frozen live build; replacing it is one command. Full rules:
[CONTRACTS.md](./CONTRACTS.md) §12.

1. `env -u ANTHROPIC_API_KEY npm run build:data` (network). The build must be keyless: the tool
   refuses a build with an AI-written brief.
2. `npm run fixture:refresh -- --dry-run`, then without the flag. It gates the build, caps the
   river at 1,500 rows, adds the health cases, gates again and writes the 8 files plus
   `test/fixtures/v2.manifest.json`. Dry run on the closing build today: accepted, 662.2 KB (it
   reproduces the committed fixture).
3. `npx tsc -b && npm test`.

What to know:

- Three health rows are **synthetic** (a healthy build has no failing source): `chinai` carried by
  host backoff, `concordia-ai-safety-china` failing, `clouded-judgement` quarantined; the carried
  row (`arxiv-cs-cr-llm-agent-security`, HTTP 429) is real. The manifest lists the synthetic ones.
  The fixture's gate therefore carries one warning, "3 chronic".
- Tests must select fixture rows by property (`fixtureStory("paywalledRow")`,
  `fixtureSource("carried")`), never by id, headline or count.
- Not guarded by the tool: four search / watch test inputs chosen from the fixture's words, and the
  test "every preset finds hits in the committed 7-day fixture". A quiet news day can pass the
  refresh and fail those; each failure message starts with "fixture:".
- Frozen on purpose and not refreshed by this tool: `test/fixtures/bridged-2026-11-19/`,
  `items-2026-11-19.json`, `registry-2026-11-19.json`, `test/fixtures/v1/`.

### 5.8 Run the link and feed audits

Both need the network. The feed audit and the full link check were not re-run for this document; the docs group of the link check was.

| Command | What | Last result (2026-11-20, integration round) |
|---|---|---|
| `npm run validate:feeds` | Every active source with the build's client and parsers; exit 1 only on actionable problems. `--include-paused`, `--out <file>` or `VALIDATE_OUT`; an unknown argument is refused and `--help` makes no request | 413/413 OK in 21 s. One redirect reported: `hf-daily-papers`. **Do not** follow the tool's "update URLs" advice for it: the target is a dated URL that changes daily |
| `npm run check:links -- --data` | Registry URLs, URLs in `docs/`, and article URLs sampled from the river. `docs/archive/**` is requested and reported but never counted | Full run, 04:25Z: 2,227 unique URLs. Registry 787: 760 ok, 0 broken, 2 flaky, 25 blocked. Data 292: 218 ok, 0 broken, 2 flaky, 72 blocked (bot walls). Docs 1,906: 1,869 ok, 4 broken, 6 flaky, 27 blocked. Docs only, re-run at 05:47Z after the documentation pass (`-- --no-registry`): 1,908 URLs, 1,866 ok, 4 broken, 7 flaky, 31 blocked; archive 74 (67 ok, 7 broken, not counted). The 4 "broken" were the same in both runs and none is a dead reader link: a POST-only API endpoint and one feed cited as dead on purpose (both since rewritten without their scheme, so the next run should not list them), and the V2 site and repository, which do not exist yet |

The checker does not test relative Markdown links. `feed-audit.yml` runs both weekly once `V2_DEPLOY` is set.

---

## 6. Invariants and traps

1. **`tsx` needs `--tsconfig tsconfig.app.json` for tests.** `npm test` passes it; a hand-run single
   file must too: `npx tsx --tsconfig tsconfig.app.json --test path/to/file.test.ts`. Without the
   flag every test that renders a component fails with `ReferenceError: React is not defined`
   (re-run today: `src/app/AppShell.test.ts` gives 22 failures without it, 52 passes with it). The
   root `tsconfig.json` is solution-style and tsx does not apply its `jsx` setting. Tools
   (`build:data`, `explain`, ...) do not need the flag. Test files are `*.test.ts` with
   `createElement`, never `*.test.tsx`.
2. **Hash routes and the base path.** Every route lives in the hash (`#/s/<id>`, `#/q/<query>`), so
   Pages needs no rewrite rules. The path prefix is the Vite `base`, from `SITE_BASE`, default
   `/ai-drudge-v2/` (`vite.config.ts`). The dev URL includes it. On `*.github.io` it must equal
   `/<repository name>/` or the preflight fails the run; a wrong base gives a blank page with 404
   assets. Build links with `router.href(route)`, never by hand.
3. **Storage namespace.** V2 writes only `aid2:*` keys (`STORAGE_KEYS`, `CACHE_KEYS` in
   `src/app/services.ts`); `defineKey` and the write helpers throw on anything else. V1's
   `ai-drudge:*` keys are read once by `migrateV1` and never written. V1 and V2 may share an origin,
   so this is what keeps them from corrupting each other.
4. **`schemaVersion`.** `SCHEMA_VERSION = 2` in every data file; the major version is also the path
   (`data/v2/`). Additive optional fields do not bump it. `status.json` has its own `schema: 1`. The
   client runs the guards (`shared/guards.ts`) on network **and** cached data and rejects a file
   that fails; change a guard and the type it checks in the same commit.
5. **One build, one `buildId`.** All files of a build carry the same id; `mergeEdition` throws
   `BuildMismatchError` and the client refetches `front.json` once. Never copy single files between builds.
6. **`leadId === top[0]`** (or both null). Enforced by `shared/invariants.ts`. Anything that
   re-orders TOP after selection (the hold, the running-story fold) must re-rank before emit.
7. **Rows are story keys.** A cluster is keyed by its lead id; `members` excludes the lead;
   singletons are omitted from `clusters`. Mutes never change a key: `visibleStory` re-leads the
   row. **Member order is contract**: the first `publishers - 1` members are one article per other
   counted publisher; the client's recount under mutes depends on it.
8. **A section's rows are not in score order.** Diversity caps, the regulator floor, release rows,
   the last-resort rule for low-signal rows and the section-focus bonus (LOCAL, POLICY, AI
   SECURITY) reorder them. TOP is ranked on `topStanding` (the score with recency capped for
   stories under 3 publishers), not on the raw score. Do not "fix" either by sorting.
9. **First-run bootstrap.** With empty state (first build, lost state, or a source the state has
   never read) a dated item is first seen at its publish time and an undated one beyond the
   source's max age. Otherwise the first build would stamp the whole corpus "new". The first build
   also has no conditional-GET validators (0 answers of 304) and resolves every Google News wrapper
   from scratch.
10. **Google News wrapper budget.** New wrappers are resolved after the fetch phase inside
    `INGEST_DEFAULTS.resolveBudgetMs` (25 s; ceiling 240 per run, 4 concurrent, 2 requests each).
    One that misses the budget is published as a wrapper link and retried next run; when it
    resolves, its id changes and `formerIds` carries the first-seen time over. The three builds of
    the final round resolved 3, 16 and 4 new wrappers; a cold start has about 210. The log has no
    timing line for this step.
11. **`ctx.now` is the only clock** in the pipeline and `ctx.state` is read-only; state changes
    travel in stage outputs and are folded by `nextState`. Tests freeze the clock
    (`TEST_NOW_ISO`, `FIXTURE_NOW_MS`).
12. **Generated and gitignored - never commit:** `public/data/` (9 files in `v2/` incl.
    `state.json`), `public/feed.xml`, `public/feeds.opml`, `dist/`, `node_modules/`,
    `*.tsbuildinfo`. The explain record is `node_modules/.tmp/explain.json`.
13. **The one tracked generated file: `public/feed.xml`.** V1 committed it; `.gitignore` cannot
    untrack it, so it shows as modified after every build until the cutover commit runs
    `git rm --cached public/feed.xml`. V1's four `public/data/*.json` files are tracked too and
    already deleted in the working tree.
14. **Generated but committed - do not hand-edit:** `docs/SBOM.json`, the marked tables of
    `docs/SBOM.md`, `docs/SOURCES.md`, `test/fixtures/v2/*` and its manifest (`data:fixture`
    refuses a fixture whose hashes do not match).
15. **A local `dist/` contains `state.json`** (Vite copies `public/`): 4,561,454 bytes in 35 files
    today, 1,255,061 without it. Only the CI "Check dist" step removes it. Never upload a local `dist/`.
16. **`ANTHROPIC_API_KEY` in your shell makes a local build call the API and bill it.** Use
    `env -u ANTHROPIC_API_KEY npm run build:data`. `fixture:refresh` refuses such a build.
17. **CSP `style-src 'self'`** in production builds: no `<style>` element, no `style` attribute, no
    `setAttribute("style", ...)`, no `dangerouslySetInnerHTML`. `src/state/pageBuild.test.ts` scans
    `src/` for them. The dev server sends no CSP, so only `npm run preview` shows a violation.
18. **Frame guard.** A production build opened inside a cross-origin iframe shows only an "Open AI
    DRUDGE" link. A preview tool that embeds the production build will show that link, not the app.
19. **`data:fixture` overwrites the eight public JSON files** in `public/data/v2/` and leaves
    `state.json`, `feed.xml` and `feeds.opml` alone. On a fresh clone `npm run build:check` after it
    exits 1 with both XML files missing: expected.
20. **Policy numbers have one home.** `PIPELINE` (`context.ts`), `SCORE` (`score/weights.ts`),
    `ROUTE_POLICY` (`route/rules.ts`), `CLUSTER` (`cluster/similarity.ts`), `GATE`
    (`emit/quality.ts`); optional registry fields get their defaults only in
    `scripts/registry/defaults.ts`. Do not re-declare them in a stage.
21. **The `data` branch must stay force-pushable by `github-actions[bot]`.** With the state out of
    the site it is the only hand-over path between builds.
22. **Never touch V1 from this tree.** The parent directory is the V1 checkout (branch `main`,
    live). Do not edit, build or run git writes there, and do not push `v2` over `main`. The
    worktree shares one `.git` with it, including the stash stack: no bare `git stash`. Read-only
    check today: the V1 checkout shows only ` M .claude/launch.json`.
23. **Identity.** No file may carry the owner's name, employer or e-mail address. Write "the
    owner". The final round found and removed two slips (a test title and a home-directory path),
    and its closing step removed a registry tag and notes that described the reader's role and
    security vendors ([SECURITY.md](./SECURITY.md) §2.5).
24. **The network tools refuse unknown arguments.** `npm run validate:feeds -- --help`,
    `npm run check:links -- --help` and `npm run build:data -- --help` print usage and make no
    request; a typo exits 2 instead of starting a crawl of several hundred hosts.

---

## 7. Known defects and unfinished work

58 rows, as the tree stood after the closing round (build 2026-11-20T05:16:55.936Z). Ids and
wording are the same as in [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md), "Known defects",
which adds the source of each row, how it was checked and the roadmap item that fixes it; change
both together. Severity: H = wrong for the reader or blocks go-live, M = visible or risky, L =
minor or by design. Groups are in priority order. "Start in" is the file to open first. Editorial
rows describe the closing build and will read differently on another day.

### 7.1 Never verified

| # | Sev | Defect | Start in |
|---|---|---|---|
| KD-1 | H | Nothing was checked in a browser in the fix round or the final round. A smoke check was done after the closing build (dev server, all 13 routes, desktop 1440 px and phone 375 px): every route rendered with no new console errors; that is not a visual QA of the items listed. Untested visually: the lazy keyboard and hover chunk after first paint; the stale, storage-refused and "still trying" banners; italic low-tier titles against upright grey seen titles; the "latest" label; 24 px compact rows; the source-name search group; the "Dim headlines I have seen" switch; the briefing dialog; a re-led row under a mute and its hover card; the "also linked:" label and the "also" button; the TOP STORIES heading; the ticker's focus ring and arrow-key scrolling; CSP `style-src 'self'` with the hover card; the phone layout at 375 px | `npm run build && npm run preview`; `src/app/ShellInteractions.tsx`, `src/features/chrome/Banners.tsx`, `src/features/headline/headline.css`, `vite.config.ts` (CSP) |
| KD-2 | H | Nothing has run on GitHub: `refresh.yml`, `feed-audit.yml`, `ci.yml`, state hand-over through the `data` branch, removal of `state.json` from the Pages artifact, the preflight, behaviour on a cancelled run, the alert issues, Dependabot. Ingest from a GitHub runner address is untested as well (bot walls and rate limits differ) | `.github/workflows/refresh.yml`; [DEPLOYMENT.md](./DEPLOYMENT.md) section 14 |
| KD-3 | H | Nothing has run on Node 24 or on Linux. Every result is Node 26.7.0 on macOS; `.node-version` pins 24 for CI. A clean copy of the tree passes `tsc`, the tests and the site build on the development machine, also with a simulated Actions environment and `TZ=UTC` | `.github/workflows/ci.yml`; [DEPLOYMENT.md](./DEPLOYMENT.md) section 5 |
| KD-4 | H | The model-written brief has never run: the request, the reply validation and the six-failure alert are covered by tests only. `BRIEF_MODEL` carries a warning that the request's `thinking` field is model-specific | `scripts/pipeline/enrich/brief.ts` |
| KD-5 | H | Ranking and clustering rules are calibrated on one news day. The TOP hold has not been exercised on live data. The running-story fold, the corroborated merge and the product veto rest on 2 to 4 live examples; the closing round's three merge vetoes, the saga split (`CLUSTER.ubiquitousShare` 0.03, on a measured plateau of 0.02 to 0.04) and the TOP recency cap rest on the builds of 2026-11-20 and the 2026-11-19 corpus. Churn at the real 30-minute cadence over 24 h is unmeasured; the evidence is one 42-minute gap (TOP 10 of 12 the same, 134 of 143 homepage rows the same) | `scripts/pipeline/route/top.ts`, `route/running.ts`, `cluster/similarity.ts` (the comment above `CLUSTER`) |
| KD-6 | L | The feed audit and the registry part of the link check were not re-run after the closing round's registry edits (excludes, notes, a removed tag; no URL was changed). The closing build fetched all 413 active sources: 412 OK, 1 carried forward on HTTP 429 | `npm run validate:feeds`, `npm run check:links` (both need the network) |

### 7.2 Editorial

| # | Sev | Defect | Start in |
|---|---|---|---|
| KD-7 | H | An off-beat item from a topic feed is TOP #6 and POLICY #1: "Senate Passes Major Permitting Bill to Speed Up Energy Projects", from `nyt-artificial-intelligence` (`scope: "ai"`, so no term test), routed to POLICY by the one-word title rule "senate". The story is AI-related (another outlet's headline in it says so) but the row shows the headline that does not. "Top White House Cybersecurity Official Is Replaced" (TOP #8, POLICY #3) enters the same way. An AI-term test on the feed was measured and rejected: it would also drop the outage coverage | `scripts/pipeline/route/rules.ts` (policy rules), `scripts/pipeline/cluster/index.ts` (`pickLead`) |
| KD-8 | M | A young two-publisher story still reaches TOP. The closing round capped recency at 40 points for stories with fewer than 3 publishers (`PIPELINE.topRecencyCap`), which moved the permitting bill from #3 to #6; two stories 1 to 2 h old with 2 publishers are in TOP | `scripts/pipeline/route/top.ts`, `scripts/pipeline/context.ts` (`topRecencyCap`) |
| KD-9 | M | Subject concentration is reduced, not solved: 10 of 142 homepage stories name Nvidia or its former chief executive and 7 name Anthropic (11 and 9 before the closing round). The running-story fold applies to TOP only; `ROUTE_POLICY.subjectCap` (5 publishers, 2 rows) is homepage-only, so MARKETS & DEALS view-all rows 11 to 18 are all the IPO or its fallout | `scripts/pipeline/route/homepage.ts` (`subjectsOf`), `route/running.ts` |
| KD-10 | M | TOP mix for this reader: two AI-security stories, none on local models or financial regulation. Unvetted outlets do not count as coverage, so CISA KEV / LLMjacking shows 2 publishers (TOP #11) and banks / AI-agent liability 2 (AI SECURITY #8) | `scripts/registry/publishers.ts` (vouch), `scripts/registry/outlets.ts` |
| KD-11 | M | Same-event rows that do not cluster, with no safe token rule found: China chip sales (FT at TOP #9, Reuters elsewhere; cosine 0.19 to 0.24, a false pair sits at 0.245); the AI Safety Caucus (The Record at POLICY #5, Politico at #13); the Apple agent pair (0.224); a Google quantum study in RESEARCH and QUANTUM; CISA KEV and its LiteLLM entry (AI SECURITY #2 and #17); the Bank of England twin papers (POLICY #8 and #11). The Palo Alto acquisition shows 1 publisher: the CNBC report is kept but does not join it | `scripts/pipeline/cluster/similarity.ts` |
| KD-12 | M | `nist` and `cisa` are in the regulator floor's publisher list but inert: their feeds lack the `regulator` tag (a route test pins this). No first-party SEC item is in the edition or the 7-day river; the SEC story on POLICY (#4) is wire coverage found by a query feed | `scripts/pipeline/route/rules.ts` (`ROUTE_POLICY.regulatorFloor`), `scripts/registry/sources/policy.ts` |
| KD-13 | M | Outage reports without an AI term in the title are not routed to AI SECURITY (the closing round's rule needs "outage" plus an AI term); they stay in INDUSTRY, POLICY or the river. No watch preset covers the subject | `scripts/pipeline/route/rules.ts` (`ai_security/outages`), `src/app/presets.ts` |
| KD-14 | M | MODELS homepage rows 6 to 10 are thin: a leak report, a partnership post, a robotics trade outlet leading the Gemini 4 Hydrogen item instead of the lab, and one of three separate Microsoft MAI product pages (#10, #12, #13; same-origin pages of one launch do not collapse). Qwen4-Max is MODELS #19 and never reached a homepage row | `scripts/pipeline/route/rules.ts` (`models/launch`, `SECTION_FOCUS`), `scripts/registry/sources/labs.ts` |
| KD-15 | M | View-all lists still carry low-signal rows: the last-resort rule for display weight 0 and forum threads is homepage-only. AI SECURITY #13 (a tier-4 query item) and #17 (an unvetted outlet) in the closing build; the closer also lists a podcast row, a retraction notice, a non-AI Crunchbase feature and a clinical-AI item in POLICY. A profane title from an HN search is in the 7-day river, so search and the briefing export can surface it | `scripts/pipeline/route/homepage.ts`, `scripts/registry/sources/queries.ts` |
| KD-16 | L | Tier-4 leads hold 13 of 143 homepage rows, 4 of the 5 in QUANTUM. QUANTUM has 6 rows in total; its homepage row #5 is 205 h old and row #6 327 h. SAFETY view-all has rows older than 7 days (reported). Section windows were not changed because a shorter list risks the hollow-homepage gate | `shared/sections.ts`, `scripts/registry/sources/robotics-quantum.ts` |
| KD-17 | L | Old or tangential rows on priority homepages: LOCAL #6 and #9 are 89 h old and #7 is a policy essay routed by "open-weight"; POLICY #7 is led by an 82 h-old headline | `scripts/pipeline/route/focus.ts` |
| KD-18 | L | `RIVAL_SUBJECTS`, the closed list of 34 company names behind the rival-company merge veto, needs maintenance: a pair of unlisted companies is not protected | `scripts/pipeline/cluster/similarity.ts` (`RIVAL_SUBJECTS`) |
| KD-19 | L | The back-catalogue exclude on `openrouter-new-models` matches the literal phrases "2024 version" and "2025 version" and has to be extended every January | `scripts/registry/sources/labs.ts` |
| KD-20 | L | A date-only regulator stamp is placed at 12:00 UTC, so a notice published later that day scores about 4 points low; the floor has 12 h of grace, the score does not | `scripts/pipeline/normalize/dates.ts` |
| KD-21 | L | A build tag cannot be told from a release with notes by its title; all runtime release lines are treated alike in LOCAL | `scripts/pipeline/normalize/githubRelease.ts` |
| KD-22 | L | Relevance gate false positives, about 5 of 560 passes: a chip maker's name as the only signal on a quantum headline, event recaps, a market roundup, a programme page | `scripts/pipeline/relevance/aiTerms.ts` |
| KD-23 | L | The llama.cpp GGUF advisory was unplaced when measured: its source never counts coverage, so at 50 h it fell below AI SECURITY's 30 rows | `scripts/registry/sources/security.ts`, `scripts/pipeline/route/rules.ts` (`SECTION_FOCUS`) |
| KD-24 | L | By design a TOP hold can list a one-publisher story for up to 2 h | `scripts/pipeline/route/top.ts` |
| KD-25 | L | Measured by their fixers and by tests only, not re-measured on live data after integration: search results after the rewrite, the publisher recount under mutes, the hover card of a re-led row, and the closing round's outlet-count split | `shared/select.ts`, `src/features/search/model.ts`, `src/features/headline/rowModel.ts` |

### 7.3 Engineering and operations

| # | Sev | Defect | Start in |
|---|---|---|---|
| KD-26 | M | Entry bundle 338.58 kB raw / 108.20 kB gzip against an 85 kB target; the React runtime alone is about 67.5 kB gzip | `src/main.tsx`, `vite.config.ts` |
| KD-27 | M | `state.json` is 3.31 MB, written into `public/` and copied into a local `dist/` (4.56 MB in 35 files; 1.26 MB without it). Its absence from the published site depends on a CI step that has not run; the `data` branch that carries it is public. The pipeline refuses to write a state above 24 MB | `.github/workflows/refresh.yml` ("Check dist"), `scripts/pipeline/emit/write.ts` |
| KD-28 | M | Ingest and the brief share one Node process: the key is in memory while feeds are parsed (SEC-7) | `scripts/pipeline/run.ts`, `scripts/pipeline/enrich/brief.ts` |
| KD-29 | M | No grounding check on the brief's text beyond "every cited URL was sent" (SEC-2); a rejected reply is visible only as `invalid-reply` | `scripts/pipeline/enrich/brief.ts` |
| KD-30 | M | Scheduled refreshes run `npx tsc -b` and `npm test` before every data build, so a test flake stops that slot's deploy and opens the "V2 refresh failing" issue. The one known flake (a 2 s wall-clock budget) was raised to 15 s; whether scheduled runs should skip the tests is an owner decision | `.github/workflows/refresh.yml` (build job) |
| KD-31 | M | Link checker gaps: relative Markdown links and anchors are not checked; a POST-only API endpoint is reported broken; the two V2 addresses stay broken until the repository and site exist | `scripts/tools/check-links.ts` |
| KD-32 | M | Ingest time varies with no failure: 14.7 s, 30.8 s and 19.2 s in the three builds of the final round. `github.com` serves 45 sources through one host queue; the Washington Post feed takes about 10 s per build; the log has no timing line for the Google News resolver | `scripts/pipeline/ingest/pool.ts`, `ingest/googleNews.ts` |
| KD-33 | M | SBOM is not validated against the CycloneDX 1.6 schema; six optional components have no hash; `npm audit signatures` covered only the 59 packages installed locally of 125 in the lockfile | `scripts/generate-sbom.ts` |
| KD-34 | L | 12 sources still carry `probation` although all were OK in the builds and the audit of 2026-11-20, all from one workstation. The fixture's gate reports "3 chronic" for its synthetic rows | `scripts/registry/sources/` (grep `probation`) |
| KD-35 | L | `validate:feeds` prints "REDIRECTED (update URLs)" for `hf-daily-papers`, whose redirect target is a dated URL that changes daily; following the advice breaks the source | `scripts/tools/validate-feeds.ts` |
| KD-36 | L | No load status for `stocks.json` (`EditionState.stocks` is the file or null), so the ticker band cannot reserve its space | `src/app/services.ts` (`EditionState`), `src/data/editionStore.ts` |
| KD-37 | L | `canonicalUrl` keeps gift-token parameters (`accessToken`, `st`, `reflink`). Dropping them changes article ids, so bookmarks and read state would stop matching: a migration, not a tweak | `shared/url.ts` (`TRACKING_PARAM`) |
| KD-38 | L | Test-only exports are still exported: `isMuted`, `coverageOf`, `countNewSince`, `sectionsOfDesk`, `publisherById` | the files named |
| KD-39 | L | The explain tool says when a story is held or folded, but not why a story left TOP between two builds | `scripts/pipeline/emit/explain.ts`, `scripts/tools/explain.ts` |
| KD-40 | L | Row tab stops: 2 to 5 per row (443 on the 143 homepage rows when measured). Taking the summary and "+N" buttons out of the tab order would make them unreachable with single-key shortcuts off | `src/features/headline/HeadlineRow.tsx` |
| KD-41 | L | Keys pressed before the lazy keyboard chunk arrives are not replayed | `src/app/ShellInteractions.tsx` |
| KD-42 | L | Non-sticky phone chrome before content: about 172 px on home and `#/new`, about 130 px elsewhere (CSS arithmetic, not measured in a browser). Hiding the ticker on phones (about 25 px) is an owner decision | `src/styles/chrome.css` |
| KD-43 | L | The crash path of `run.ts` writes the error with `console.error` directly, not through `neutraliseWorkflowCommands` | `scripts/pipeline/run.ts` (the final `console.error`) |
| KD-44 | L | Host backoff covers source fetches only, not the Google News resolver or the HN signal | `scripts/pipeline/ingest/googleNews.ts`, `ingest/signals/hn.ts` |
| KD-45 | L | The comment throttle of the alert issue steps uses GNU `date -u -d`; that branch could not be executed on the development machine | `.github/workflows/refresh.yml` (alert job) |
| KD-46 | L | `mlq.ai`, `marketbeat.com`, `fourweekmba.com`, `tradersunion.com` are excluded per source only; they refuse automated readers, so the evidence the global deny list requires was not recorded | `scripts/registry/outlets.ts` |
| KD-47 | L | The publisher recount under mutes relies on the member order the pipeline emits (documented in [CONTRACTS.md](./CONTRACTS.md) and pinned by a cluster test) and falls back to the conservative number when a story is led by a non-counting item; the client cannot see `countsForCoverage` | `shared/select.ts` (`visibleStory`) |
| KD-48 | L | Dead hnrss handling and stale comments remain (`DEFAULT_HOST_OVERRIDES` / `DEFAULT_HOST_GAPS_MS` in `pool.ts`, a transient rule in `feedVerdict.ts`) although no source uses hnrss.org; tests use it as the example host | the files named |
| KD-49 | L | The header comment of `removed.ts` says Noma is paused; the only paused source is `venturebeat-ai` | `scripts/registry/sources/removed.ts` |
| KD-50 | L | With a stored time chip, homepage rows change after first paint when `rest.json` merges (measured: 21 rows in 8 sections at 6H). Accepted in the closing round | `src/features/home/homeModel.ts`, `src/features/home/HomePage.tsx` |
| KD-51 | L | A watch term the reader types is a whole word, so "Qwen" does not match "Qwen4-Max"; the shipped presets and the editor's placeholder use `Qwen*`. Search words do match versioned names since the closing round | `shared/text.ts` (`compileTerms`) |
| KD-52 | L | The banner region is a live region (`role="status"`) that also holds buttons (Retry, Dismiss) | `src/features/chrome/Banners.tsx` |

### 7.4 Documentation, fixture, cutover

| # | Sev | Defect | Start in |
|---|---|---|---|
| KD-53 | M | Cutover needs git writes no agent made: the commit itself; `git rm --cached public/feed.xml` (the file is tracked from V1 and modified by every build); the four V1 files under `public/data/` are tracked and deleted in the working tree; the five dated records should be staged as renames into `docs/archive/` | [DEPLOYMENT.md](./DEPLOYMENT.md) section 7 |
| KD-54 | M | Disclosure before the repository is public. The closing round removed the `owner-stack` tag and reworded about 35 registry notes; the published `sources.json` carries no notes and no longer describes the reader. Left in the repository: `docs/SOURCE_RESEARCH.md`, which still explains choices by the reader's local-model lab (runtimes and hardware; about 45 sentences reported by the closer); the tag `owner-pick` on 7 sources; third-party commit-author e-mail addresses inside three frozen feed fixtures. No name, employer or address of the owner is in the tree | [SECURITY.md](./SECURITY.md) section 2.5; `docs/SOURCE_RESEARCH.md` |
| KD-55 | L | Fixture: three health rows are synthetic (owner decision whether to keep them); a refresh needs a keyless build; four search and watch test inputs are not guarded by the refresh tool; one watch-preset test depends on the week's news; the 2026-11-19 corpus and registry fixtures were not refreshed; `feed.xml` and `feeds.opml` are not in the fixture, so the gate reports them missing on a fresh clone | `scripts/tools/fixture-refresh.ts`, `test/helpers/fixtureCases.ts` |
| KD-56 | L | `docs/SOURCE_RESEARCH.md` is 537 KB, 331 KB of it appendix A; whether GitHub renders a file of that size is not verified. No document has been viewed in a GitHub render; in-page anchors are checked by a script that approximates GitHub's rule | `docs/SOURCE_RESEARCH.md` |
| KD-57 | L | Option C only: the Mac launch agent calls the workflow by its V1 name ("Refresh and deploy"), which stops existing; the V2 workflow is "V2 refresh and deploy" | [DEPLOYMENT.md](./DEPLOYMENT.md) section 10 |
| KD-58 | L | Owner decisions still open: the go-live option; the API key for the brief; the shared `github.io` origin (SEC-8); tagging `nist` and `cisa` as regulators; the stale threshold (120 min, `PIPELINE.staleAfterMinutes`); the NEW chip on home and `#/new` only; LOCAL release rows from 9 repositories (`ROUTE_POLICY.releaseRows.maxRows` 0 reverts); unit tests in scheduled refreshes; the ticker band on phones | §2.1 |

### 7.5 Closed in the final round - do not re-open

| Claim in an earlier report | State today |
|---|---|
| "Two Export briefing entry points on the Watch page" | No export button is mounted in `src/features/watch/`; a test pins it |
| "Duplicate time-chip groups on section pages" | Shell chips render on home and `#/new` only (`showsTimeChips`); section pages keep their own single group |
| "No DOM tests for `useKeyboardNav`" | `src/keyboard/useKeyboardNav.test.ts` has 24 tests on a fake DOM |
| "Three false story merges on homepage lists" (audit) | Split by three vetoes in `cluster/similarity.ts`, each with a test on the live titles |
| "No SEC row among 30 POLICY rows" (audit) | The SEC inquiry is its own 5-publisher story at POLICY #4; FINRA Regulatory Notice 26-24 is #6 |
| "The feed-audit issue lookup has no bot-author filter" | `scripts/tools/report-feed-audit.ts` filters on `.user.type == "Bot"` and fails in GitHub Actions when the lookup fails |
| "The gate warns on the literal V1 address" | `scripts/tools/check-data.ts` compares the feed's self link with the configured `SITE_URL` |
| "Final-round placeholders unfilled in three documents; README, DESIGN, the docs index and FUTURE_IMPROVEMENTS are V1-era; documents disagree on counts" | Filled, rewritten and reconciled in the documentation pass of 2026-11-20. Dated records (the review, the history, the changelog's 1.x entry) keep the figures of their own round on purpose and say so |

Rejected on purpose: `EditionFront.topRelated`, `routeTo` on `hf-unsloth-gguf`, an asynchronous
backup service, a wider tracking-parameter list, an AI-term test on the NYT topic feed, a recency
cap on every TOP story, a time-gap rule for merges ([CONTRACTS.md](./CONTRACTS.md) §9, §11 and §13)
and renaming the workflows ([REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) §2.6). Do not re-propose
them without new evidence.

---

## 8. Verification commands and expected results

Re-run for this document on 2026-11-20 between 05:23 and 05:40 UTC, after the last code change,
Node 26.7.0, macOS. No network.

| Command | Expected today |
|---|---|
| `npx tsc -b` | exit 0, no output |
| `npm test` | `tests 2782`, `suites 449`, `pass 2782`, `fail 0`; about 19 s |
| `npm run build:check` | `PASS  data gate passed`; "322 stories, 367 rows, 143 on the homepage, 12 top"; "15 of 15 with rows"; "412/413 ok; live 412/413 (100%); 0 failing, 1 carried"; `front.json` 143.2 KB raw / 43.9 KB gzip; "freshness not enforced (BUILD_STARTED_AT not set)" |
| `npm run sbom -- --check` | "SBOM is current: docs/SBOM.json (125 npm packages, 6 GitHub Actions, 7 services)." |
| `npm run fixture:refresh -- --dry-run` | build 2026-11-20T05:16:55.936Z accepted; "1086 of 1086 rows kept"; total 662.2 KB; one gate warning "3 chronic"; "dry run: nothing written" |
| `npm run explain -- zre84e` | FINRA Regulatory Notice 26-24: "score 52.27", "placed: policy #6 (homepage)", importance 7.42 from the regulator-notice term, "section focus in policy: policy/us-finreg +14 title[FINRA]" |
| `npx tsx --tsconfig tsconfig.app.json --test scripts/pipeline/cluster/index.test.ts` | 55 pass; "recall on labelled same-story pairs: 58/62; false merges on labelled different-story pairs: 1/54" |
| `AID_DRY_RUN=1 bash scripts/kick-refresh.sh` | exit 0; names workflow `refresh.yml`, the `ai-drudge-v2` repository and ref `main`, then "dry run - nothing dispatched" |
| `git ls-files public` | 6 paths until the cutover commit (4 V1 data files, `favicon.svg`, `feed.xml`); exactly `public/favicon.svg` after it |

```bash
git status --short | wc -l          # 99
git status --short | grep -c '^ M'  # 21
git status --short | grep -c '^ D'  # 48
git status --short | grep -c '^??'  # 30
```

The `build:check` and `explain` results hold while `public/data/v2/` contains the 05:16:55Z build;
they change with the next `build:data` (and `build:check` reports the fixture's three synthetic
health rows after `data:fixture`).

Not re-run for this document (network, or a write to `dist/`). Results of the final round:

| Command | Result on 2026-11-20 |
|---|---|
| `env -u ANTHROPIC_API_KEY npm run build:data` | Build 1, 03:34:11Z: 19.3 s, 4,460 raw -> 1,465 kept -> 1,245 stories -> 322 placed, 184 answers of 304; 413/413 OK. Build 2, 04:16:25Z: 35.6 s, 4,461 -> 1,463 -> 1,244 -> 321 placed in 369 rows, 202 answers of 304; 413/413 OK. Closing build, 05:16:55Z: 23.4 s, 4,461 -> 1,497 -> 1,280 -> 322 placed in 367 rows, 185 answers of 304; 412/413 OK, 1 carried forward. All three: gate PASS, 0 warnings |
| `npm run build` | Closing round: exit 0, 128 modules; entry JS 338.58 kB / 108.20 kB gzip; entry CSS 37.62 / 8.63 kB; 8 lazy route chunks of 2.80 to 17.12 kB raw. The `dist/` on disk matches (35 files; `index-C0mTCMOf.js` is 338,588 bytes; `index.html` with the CSP meta and no `modulepreload`) |
| `npm audit` | 0 vulnerabilities (integration step) |
| `npm audit signatures` | exit 0: 59 packages, 59 verified signatures, 35 attestations (integration step) |
| `npm run validate:feeds` | 413/413 OK, exit 0, 21 s (integration step, 04:20Z; before the closing round's registry edits, which changed no URL) |
| `npm run check:links -- --data` | §5.8 |
| `npm run compare` | Against the live V1 payload of 04:08Z and the 04:16Z V2 build: 73 of 131 V1 articles placed in V2 (56%), 17 river only, 41 gone, 260 V2 stories not in V1, same lead |

Payload of the closing build (gate figures): `front.json` 143.2 KB / 43.9 KB gzip, `rest.json`
103.9 / 35.5, `river.json` 238.2 / 88.1, `health.json` 46.2 / 4.4, `sources.json` 127.2 / 20.7,
`feed.xml` 11.4 / 3.4, `feeds.opml` 72.8 / 13.4; `state.json` 3,306,393 bytes (4,361 first-seen
ids, 1,086 river rows, 413 feed states, 288 resolved URLs, 12 TOP entries).

---

## 9. Glossary

| Term | Meaning |
|---|---|
| Article | One item of one source after normalize, with a stable id from its canonical URL (`ArticleV2`) |
| Story | The unit that is ranked and placed: one lead article plus the articles of other outlets about the same event. Every row on the page is a story, addressed by its lead's id (the story key) |
| Cluster | A story with more than one article, as published: keyed by the lead, `members` (lead excluded) and `publishers`. A one-article story has no cluster entry |
| Publisher | The organisation behind an article (`PublisherDef`: id, name, hosts). Diversity caps, coverage counts and the "Also:" line use publishers, never feed names. For query and aggregator feeds it is derived from the article's host (`attribution: "link-host"`) |
| Twin | The same URL arriving from several sources (a publisher's two feeds, a publisher feed and an aggregator). Normalize folds twins into one article (`foldTwins`) and records the others in `via` |
| Tier | 1 (critical) to 4 (low) per source; feeds the tier part of the score. A tier-4 lead with fewer than 2 publishers renders de-emphasised (`w = 0`, grey italic) |
| Scope | `ai`: every item of the source is on-mission and is never gated. `general`: each item must pass the AI-relevance gate or the source's own `include` list |
| Home | The section every item of a source starts in. For `source`-mode sections it is the only way in |
| Routed section | The one additional topic section keyword rules may add to a story (`RouteTrace.routedTo`). Home plus at most one |
| Desk | `ai` (feeds the lead, TOP STORIES, the brief and the Atom feed), `owner` (cyber, quantum), `utility` (releases) |
| River | `river.json`: every kept article of the last 7 days, newest first, as tuples. Feeds search, the watchlist and `#/new`. The pipeline remembers it in `state.recent` because feeds list only their newest items |
| Edition | What the client renders for one `buildId`: `front.json` (first paint: lead, TOP, homepage rows) merged with `rest.json` (full section lists) by `mergeEdition` |
| TOP STORIES | Up to 12 ai-desk stories ranked by score inside a 72 h window (120 h relaxed); `leadId` is `top[0]` |
| Lead | Of a story: the article shown for it. Of the edition: the story at the top of the page |
| Gate | `npm run build:check`: guards, invariants, freshness, content and feed thresholds, sizes. Exit 1 holds the deploy |
| Carry-forward | A source that fails, or is skipped by host backoff, keeps its last-good items for up to 6 h; health status `carried` |
| Quarantine | After 48 consecutive failures a source is probed only once every 24 h |
| Probation | Registry tag: failure is expected from CI, so the source is kept out of the gate's live-feed share |
| Baseline run | A build that sees a source for the first time: its items are not stamped "new" (§6, 9) |
| Re-led | Under a reader's mute of the lead's source, the row keeps its key and position and shows the first remaining outlet's article (`visibleStory`). A story disappears only when every outlet covering it is muted |
| Running story / follow-up | A later story on an event already in TOP. It takes its own TOP slot only with 5 or more publishers; one running story holds at most 2 slots; folded follow-ups keep their section rows |
| Hold | A story of the previous build's TOP that no longer qualifies keeps its slot for up to 2 h unless the newcomer scores at least 5 points above it |
| Unvetted outlet | An outlet that a link-host feed found and no publisher entry claims: tier 4, never a lead, no coverage count, item tag `unvetted-outlet` |
| `w` | Display weight of a row: 3 = 8 or more publishers; 2 = 3 or more, or a tier-1 first-party launch; 0 = de-emphasised; 1 = default and omitted from the file |
| Fixture | `test/fixtures/v2/`: the frozen build that tests run on and `data:fixture` installs |
| Fix round, final round, closing round | The three passes of 2026-11-20 after cutover. Fix round: 9 reviewers, 101 findings (01:15-02:32Z). Final round: 5 fixers, 3 integrators, a 25-finding audit and a closer (02:34 to about 05:30Z). "Closing round" names the closer's step of the final round: the last code change, the 05:16Z build and the fixture refresh. Record: [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) |
| Standing (`topStanding`) | What a story counts for when TOP STORIES is ranked: its score with the recency part capped at 40 points while fewer than 3 publishers cover it |
| Section focus | A per-section ordering bonus (LOCAL, POLICY, AI SECURITY) that changes the order of that section's list only |
| Low-signal row | A row with `w = 0`, or led by a forum thread: a last resort for the homepage rows of topic sections |

---

## 10. Other documents

The full index, with reading orders by audience, is [README.md](./README.md) in this directory.

| Document | Read it for | State on 2026-11-20 |
|---|---|---|
| [../README.md](../README.md) | Overview, npm scripts, configuration, routes | Current |
| [README.md](./README.md) (docs index) | Every document, who it is for, generated files, conventions | Current |
| [V1_VS_V2.md](./V1_VS_V2.md) | For the owner: what changed against V1, with measurements | Current |
| [DESIGN.md](./DESIGN.md) | Architecture, each stage's algorithm, measured sizes, decisions | Current |
| [CONTRACTS.md](./CONTRACTS.md) | Types and functions the packages share; who provides and consumes what; every contract change by round; the fixture procedure | Current |
| [RUNBOOK.md](./RUNBOOK.md) | What to do for each failure after go-live; routine tasks | Current; every GitHub step in it is untested |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Go-live options and steps, workflows, variables and secrets, launch agent, rollback, cost, untested register | Current |
| [SECURITY.md](./SECURITY.md) | Trust boundaries, data inventory, threat model, CI privileges, auditability, go-live hardening checklist | Current |
| [SOURCES.md](./SOURCES.md) | Every source by section with tier, kind and last build status | Generated from the closing build |
| [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) | How the registry was researched; the backlog and the dead ends | Frozen research record of 2026-11-19 / 20; large; see §2.1 decision 10 |
| [SBOM.md](./SBOM.md), [SBOM.json](./SBOM.json) | Dependencies, actions, external services | SBOM.json and the marked tables of SBOM.md are generated; current |
| [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md) | 31 improvements with sketches; the defect register behind §7; rejected ideas | Current |
| [CHANGELOG.md](./CHANGELOG.md) | What 2.0.0 adds, changes and removes against 1.x, including the final round | Current |
| [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) | Why V2 exists, how it was built, decisions and their reasons | Current; sections 6.6 and 9 record the end of the fix round on purpose |
| [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) | The 17-dimension review of V1, the fix round and the final round, finding by finding | Current; Part 2 records the end of the fix round on purpose |
| [archive/README.md](./archive/README.md) | Dated V1 records (September 2026 audits and reviews, the June upgrade plan) | Historical |

Not in the repository: the review JSON, the build logs and the work-package reports of 2026-11-19
and 2026-11-20 live only in the session scratch directory, which is not durable. What matters from
them is in this file, in [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) and in
[PROJECT_HISTORY.md](./PROJECT_HISTORY.md).
