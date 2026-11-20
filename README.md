# AI DRUDGE V2

A Drudge-style AI news front page: a build pipeline reads a registry of 414 sources, clusters and ranks what they published, and writes static JSON; a React single-page app renders it with no server, no accounts and no tracking (reader state lives in `localStorage`). Coverage is weighted toward AI security, local and open models, AI regulation in finance (SEC, FINRA and peers) and model releases.

**Status (2026-11-20):** V2 is live at https://pnelsonftp.github.io/ai-drudge-v2/ from this repository (`PNelsonFTP/ai-drudge-v2`, branch `main`); a custom domain is planned ([docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) §16). V1 stays live and unchanged at https://pnelsonftp.github.io/ai-drudge/. See [Status](#status).

## V2 at a glance

Measured in this tree on 2026-11-20 unless a row says otherwise.

| Item | Value |
|---|---|
| Sources | 414 in the registry (413 active, 1 paused); 405 publisher entries, 317 of which own a source; 12 sources tagged `probation`; 10 denied outlets |
| Source tiers (1 / 2 / 3 / 4) | 6 / 66 / 255 / 87 |
| Source kinds | rss 249, newsletter 57, github-release 37, query 23, scrape 19, json 15, papers 9, community 4, aggregator 1 |
| Sections | 15 (12 AI desk, 2 owner desk, 1 utility), replacing V1's 18 categories |
| Stack | Vite 8.3, React 19.3, TypeScript 6.0, Tailwind CSS 4.3; `fast-xml-parser` 5 and `tsx` at build time only. Browser runtime dependencies: `react`, `react-dom` |
| Node | CI pins 24 (`.node-version`); `engines` requires >= 22.15.0; local runs used 26.7.0 |
| Tests | 2,782 tests, 449 suites, 132 test files, 0 failing (`npm test`, about 20 s, no network) |
| Typecheck | `npx tsc -b` over 4 projects (shared, app, node, test): exit 0 |
| Last live data build | 2026-11-20T05:16:55Z, keyless: 412/413 sources OK, 1 carried forward (`arxiv-cs-cr-llm-agent-security`, HTTP 429); 4,461 raw items, 1,497 kept, 1,280 stories, 322 placed in 367 rows; 143 homepage rows; TOP STORIES 12; gate PASS, 0 warnings; 23.4 s (build log). The two earlier builds of the final round (03:34Z, 04:16Z) had 413/413 OK |
| First-paint payload | `front.json` 143.2 KB raw / 43.9 KB gzip (gate figures; the gate warns above 48 KB gzip) |
| Site bundle | Entry JS 338.58 kB raw / 108.20 kB gzip (Vite's figures; the 85 kB target is not met); entry CSS 37.62 / 8.63 kB; home is eager, the other 8 pages are lazy chunks |
| Supply chain | `npm audit` 0 vulnerabilities (reported 2026-11-20, not re-run here); CycloneDX 1.6 SBOM with 132 components and 7 services in [docs/SBOM.json](./docs/SBOM.json) |
| Not verified | Nothing has run on GitHub, on Node 24 or on Linux; the last two rounds were not checked in a browser beyond a 13-route smoke check after the closing build; the model-written brief has never run (every build was keyless) |

## Quick start

Prerequisites: Node >= 22.15.0 (24 recommended, to match CI) and npm. Run everything from the repository root.

1. `npm ci` (CI uses `npm ci --ignore-scripts`).
2. `npm run data:fixture` installs the committed fixture (8 JSON files, verified against `test/fixtures/v2.manifest.json`) into `public/data/v2/`. No network. It overwrites those 8 files if a live build is already there.
3. `npm run dev -- --port 5180 --strictPort`
4. Open `http://localhost:5180/ai-drudge-v2/`.

The fixture is the live build of 2026-11-20T05:16Z, so the page shows the "Headlines may be delayed" banner; that is expected. Three health rows in it are synthetic (listed in the manifest). For current headlines replace step 2 with `env -u ANTHROPIC_API_KEY npm run build:data` (network; 19 to 36 s measured on 2026-11-20; unsetting the key avoids a billed API call) followed by `npm run build:check`.

## npm scripts

All 15 scripts in `package.json`. "Net" = needs the network.

| Script | Runs | Purpose | Net |
|---|---|---|---|
| `dev` | `vite` | Dev server with hot reload; no CSP in dev | no |
| `build` | `tsc -b && vite build` | Typecheck, then production site in `dist/` (base path from `SITE_BASE`, CSP `<meta>` injected) | no |
| `preview` | `vite preview` | Serve `dist/` locally (Vite default port 4173; not verified) | no |
| `typecheck` | `tsc -b` | All four TypeScript projects | no |
| `test` | `tsx --test` over `shared/ scripts/ src/ test/` | Every `*.test.ts` (node test runner) | no |
| `build:data` | `scripts/pipeline/run.ts` | The pipeline: fetch every active source, write `public/data/v2/*.json`, `public/feed.xml`, `public/feeds.opml` | yes |
| `build:check` | `scripts/tools/check-data.ts` | The publish gate on the generated data (guards, invariants, freshness, sizes, XML). Exit 1 = hold. `-- --write-status` records the verdict | no |
| `data:fixture` | `scripts/tools/data-fixture.ts` | Install the committed fixture as site data; `-- --to <dir>` for another target | no |
| `fixture:refresh` | `scripts/tools/fixture-refresh.ts` | Freeze the last keyless build as the test fixture; `-- --dry-run` reports only. Refuses a build the gate holds or one with a model-written brief | no |
| `validate:feeds` | `scripts/tools/validate-feeds.ts` | Check every registry source, or a candidate list (`-- candidates.json`), with the build's own HTTP client and parsers | yes |
| `check:links` | `scripts/tools/check-links.ts` | Check registry and docs URLs; `-- --data` adds article URLs from the river; `-- --strict` fails on broken or flaky links | yes |
| `explain` | `scripts/tools/explain.ts` | `-- <id \| url \| title words> [--mute <source-id,...>]`: why a story is where it is, or why an item was dropped, in the last build | no |
| `compare` | `scripts/tools/compare-v1-v2.ts` | V1 payload against the V2 data set: overlap, lead, drops by reason. Default V1 input is the frozen payload of 2026-11-19; `-- --v1 <file \| URL>` | no (yes with a URL) |
| `sbom` | `scripts/generate-sbom.ts` | Regenerate `docs/SBOM.json` and the generated tables of `docs/SBOM.md`; `-- --check` exits 1 when stale | no |
| `docs:sources` | `scripts/tools/gen-sources-doc.ts` | Regenerate `docs/SOURCES.md` from the registry and the last build's `health.json` | no |

A single test file: `npx tsx --tsconfig tsconfig.app.json --test path/to/file.test.ts`.

## How it works

```
scripts/registry (414 sources)        state.json (previous build's memory)
          |                                   |
          v                                   v
 ingest -> normalize -> relevance -> cluster -> score -> route -> enrich -> emit -> gate
 fetch     ids, titles  drop, cap    stories    rank     15 sections  brief,   JSON,   build:check
 + parse   + times      + rescue                         + TOP        stocks   Atom,   exit 1 = hold
                                                                               OPML
          |
          v
 public/data/v2/{front,rest,river,health,sources,brief,stocks,status}.json   + state.json (next build only)
          |
          v
 Vite + React SPA (src/): front.json at first paint, rest / river / sources on demand
```

`scripts/pipeline/run.ts` only composes the stages; a stage directory never imports a sibling stage (`test/boundaries.test.ts`). The clock, environment and `fetch` reach every stage through one context object, so each stage is testable offline.

| Stage | Directory | What it does |
|---|---|---|
| Registry | `scripts/registry/` | The source and publisher lists as typed data, 17 files under `sources/` grouped by beat and kind. Validates itself at import. `outlets.ts` holds the outlet deny list and the rule for outlets no publisher vouches for. |
| Ingest | `scripts/pipeline/ingest/` | Fetches every active source through a per-host pool with conditional GET, parses RSS / Atom / RDF, scrapes listed HTML pages and JSON APIs, resolves Google News wrapper links, and reads the Hacker News signal. A failed source carries its last-good items forward for up to 6 h; a host that answers 5xx / 429 twice in a row is left alone for the rest of the run. Never throws; bounded by a 90 s deadline. |
| Normalize | `scripts/pipeline/normalize/` | Canonical URL and stable id, title and summary clean-up, one line per repository for release feeds, duplicate folding, `publishedAt` / `firstSeenAt` from the first-seen ledger, and the source's policy copied onto each item. |
| Relevance | `scripts/pipeline/relevance/` | Drops, with a recorded reason: `too_old`, `excluded` (deny list, source rules), `noise` (events, jobs, promos), `off_topic` (the AI gate for `scope: "general"` sources), `source_cap` (default 8 per source). Over-cap items that corroborate another publisher's story are rescued, and items of a story with 6 or more publishers do not use up a source's default cap. |
| Cluster | `scripts/pipeline/cluster/` | One corpus-wide agglomerative clustering on centroids: items become stories with a lead. Aggregator and community items join finished stories and never shape them. |
| Score | `scripts/pipeline/score/` | `score = recency + fade x (tier + coverage + importance + hn)`. Coverage counts publishers, not feeds. All weights are in `weights.ts`. |
| Route | `scripts/pipeline/route/` | Places each story in its home section plus at most one routed section, applies windows, publisher-diversity caps and the regulator floor in POLICY, then picks TOP STORIES (at most 12) and the lead, with running-story folding and a hold rule against churn. |
| Enrich | `scripts/pipeline/enrich/` | Daily Brief: `claude-sonnet-5` when `ANTHROPIC_API_KEY` is set and the reply passes field-by-field validation, otherwise a deterministic brief with a coarse reason code. Stock quotes for 8 symbols from Yahoo Finance. |
| Emit | `scripts/pipeline/emit/` | Builds the JSON files, `feed.xml` (Atom) and `feeds.opml`, the gate verdict in `status.json`, and the explain record for `npm run explain`. Pure: same input gives the same bytes. |
| State | `scripts/pipeline/state/` | Loads and writes `state.json`: first-seen ledger, feed health streaks, last-good items, 7-day river memory, the lead and TOP list. Treated as untrusted input. |
| Gate | `scripts/tools/check-data.ts` | Decides whether the build may replace the live data. Shares its content rules with emit (`emit/quality.ts`). |
| Client | `src/` | Hash-routed SPA. `src/app/createServices.ts` wires stores for the edition, saved items, mutes, read state, settings and watchlist; pages are discovered from `src/features/<route>/route.tsx`. Auto-refreshes every 10 minutes while the tab is visible. |

Types and file formats are in [docs/CONTRACTS.md](./docs/CONTRACTS.md); `shared/` holds the code both sides import and is pure (no `node:`, no DOM).

## Project layout

```
.
├── .github/
│   ├── dependabot.yml           weekly grouped updates, 7-day cooldown
│   └── workflows/               refresh.yml (build + deploy), feed-audit.yml (weekly), ci.yml (pull requests)
├── .node-version                24 (CI)
├── docs/                        documentation (see the index below); archive/ holds dated V1 records
├── index.html                   page shell; theme script and CSP are injected by vite.config.ts
├── public/                      favicon.svg; data/v2/, feed.xml, feeds.opml are generated and gitignored
├── scripts/
│   ├── registry/                sources/ (17 files), publishers.ts, outlets.ts, types.ts, defaults.ts
│   ├── pipeline/                ingest/ normalize/ relevance/ cluster/ score/ route/ enrich/ emit/ state/
│   │                            + run.ts (entry), context.ts (constants, env keys), types.ts
│   ├── tools/                   check-data, data-fixture, fixture-refresh, validate-feeds, check-links,
│   │                            explain, compare-v1-v2, gen-sources-doc, import-sources, report-feed-audit
│   ├── generate-sbom.ts
│   └── kick-refresh.sh          workflow_dispatch helper for a Mac launch agent
├── shared/                      sections, contract, guards, invariants, select, text, time, url, ids
├── src/
│   ├── main.tsx                 entry
│   ├── app/                     shell, hash router, route registry, services, presets
│   ├── data/                    edition and sources stores, fetchJson
│   ├── state/                   localStorage stores, backup, V1 migration, theme bootstrap
│   ├── features/                about chrome export headline home new saved search section settings sources watch
│   ├── keyboard/                keymap (pure reducer), useKeyboardNav, shortcuts help
│   └── styles/                  tokens, base, chrome, components (navy / gold, Arial)
├── test/                        boundaries, contract and fixture tests; helpers/; fixtures/ (v2 = frozen live build)
├── tsconfig*.json               4 projects: shared, app, node, test
└── vite.config.ts               base path, CSP, stylesheet order
```

## Configuration

Everything is optional for local work. Defaults are in `scripts/pipeline/context.ts` and `vite.config.ts`; the full reference, including what each workflow job reads, is [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) section 2.

| Name | Kind | Default when unset | Effect |
|---|---|---|---|
| `V2_DEPLOY` | repository variable | unset: every job of `refresh.yml` and `feed-audit.yml` is skipped | Master switch; must be the exact string `true` |
| `SITE_URL` | repository variable / env | the `/ai-drudge-v2/` site under `pnelsonftp.github.io` | Links in `feed.xml` and `feeds.opml`, default User-Agent, deploy checks |
| `SITE_BASE` | repository variable / env | `/ai-drudge-v2/` | Vite `base` path; the workflow preflight fails when it does not match the repository name |
| `FEED_USER_AGENT` | repository variable / env | `ai-drudge/2.0 (+<SITE_URL>; feed reader)` | Identifying User-Agent for feed fetches |
| `V2_PUBLISH_STATE` | repository variable | unset: `state.json` is removed from the Pages artifact | `true` publishes the state with the site (escape hatch if the `data` branch hand-over fails) |
| `ANTHROPIC_API_KEY` | secret / env | unset: deterministic brief, reason `no-key` | Enables the model-written Daily Brief. Handed to the brief stage only and removed from `process.env` before feeds are parsed |
| `BUILD_STARTED_AT` | env (set by the workflow) | freshness not enforced locally | The gate fails when the data is older than this; in GitHub Actions a missing value is a failure |
| `STATE_FILE` | env | `public/data/v2/state.json` | Path of the pipeline state |
| `STATE_URL` | env | none | Download the previous state from here when `STATE_FILE` is missing (builds outside CI) |
| `VALIDATE_OUT` | env | none | Where `validate:feeds` writes its verdict JSON; read by `docs:sources` and the audit report |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`, `GITHUB_SHA` | env (Actions) | `trigger: "local"` | Recorded in `status.json` |
| `AID_REPO`, `AID_REF`, `AID_WORKFLOW`, `AID_RETRIES`, `AID_DRY_RUN`, `AID_ALLOW_V1` | env | see `scripts/kick-refresh.sh` | The kick script; it refuses the V1 repository unless `AID_ALLOW_V1=1` |

Tuning constants are code, not configuration: `PIPELINE` (`scripts/pipeline/context.ts`), `SCORE` (`score/weights.ts`), `CLUSTER` (`cluster/similarity.ts`), `ROUTE_POLICY` (`route/rules.ts`), `GATE` (`emit/quality.ts`).

## The 15 sections

Declared once, in `shared/sections.ts`; homepage order is the order below. Mode `topic` accepts routed stories from any source; `source` shows only stories from sources homed there. Only AI-desk stories can reach TOP STORIES, the lead, the brief and the Atom feed. "Sources" = registry sources whose home is the section.

| # | Id | Heading | Desk | Mode | Window soft / hard (days) | Rows home / all | Sources |
|---|---|---|---|---|---|---|---|
| 1 | `models` | MODELS & LABS | ai | topic | 5 / 10 | 10 / 25 | 19 |
| 2 | `industry` | INDUSTRY | ai | source | 2 / 4 | 12 / 40 | 41 |
| 3 | `ai_security` | AI SECURITY | ai | topic | 7 / 14 | 10 / 30 | 46 |
| 4 | `open_local` | LOCAL & OPEN MODELS | ai | topic | 4 / 8 | 10 / 25 | 26 |
| 5 | `tools` | AGENTS & TOOLS | ai | topic | 3 / 6 | 10 / 25 | 35 |
| 6 | `policy` | POLICY & REGULATION | ai | topic | 7 / 21 | 10 / 30 | 40 |
| 7 | `money` | MARKETS & DEALS | ai | topic | 3 / 6 | 10 / 25 | 21 |
| 8 | `research` | RESEARCH | ai | source | 7 / 10 | 10 / 25 | 29 |
| 9 | `compute` | CHIPS & COMPUTE | ai | topic | 5 / 10 | 10 / 25 | 22 |
| 10 | `safety` | SAFETY & ALIGNMENT | ai | source | 14 / 21 | 8 / 20 | 13 |
| 11 | `cyber` | CYBER WIRE | owner | source | 3 / 7 | 10 / 25 | 31 |
| 12 | `analysis` | ANALYSIS | ai | source | 10 / 21 | 10 / 25 | 32 |
| 13 | `robotics` | ROBOTICS | ai | topic | 7 / 14 | 8 / 20 | 11 |
| 14 | `quantum` | QUANTUM WATCH | owner | source | 14 / 21 | 5 / 15 | 6 |
| 15 | `releases` | RELEASE RADAR | utility | source | 5 / 10 | 10 / 25 | 42 |

## Adding a source

1. Validate first: put the candidate in a JSON file (`[{ "name": "...", "url": "..." }]`) and run `npm run validate:feeds -- candidates.json`. Add only a source whose verdict is `OK`.
2. Check [docs/SOURCES.md](./docs/SOURCES.md) (current registry and the removed list) and [docs/SOURCE_RESEARCH.md](./docs/SOURCE_RESEARCH.md) (reserve backlog, rejected feeds, dead ends) so a known-bad feed is not researched twice.
3. Add the entry to the file that covers its beat or kind in `scripts/registry/sources/` (`queries.ts` for Google News and Hacker News searches, `releases.ts` for GitHub release feeds, `scrapers.ts` for scraped pages), and the publisher to `scripts/registry/publishers.ts` if it is new. Required fields: `id`, `name`, `publisher`, `url`, `kind`, `scope`, `home`, `tier`. `scope: "general"` needs a `note`.
4. Run `npx tsc -b` and `npx tsx --tsconfig tsconfig.app.json --test scripts/registry/registry.test.ts`.
5. After the next data build, run `npm run docs:sources` and commit the regenerated file with the registry change.

Field meanings, tier rules and how to retire a source are at the end of [docs/SOURCES.md](./docs/SOURCES.md).

## Routes and keyboard shortcuts

Hash routes (`src/app/routes.ts`); unknown hashes resolve to the front page. One directory per route under `src/features/`.

| Hash | Page |
|---|---|
| `#/` | Front page: lead and TOP STORIES, Daily Brief, latest strip, watchlist hits, the 15 sections |
| `#/s/<section id>` | One section, full list (for example `#/s/ai_security`) |
| `#/q/<query>` | Search across the edition and the 7-day river; operators `source:<name\|id>` and `section:<id\|label>` |
| `#/new` | New since the last visit |
| `#/watch` | Watchlist (presets: CISO, Local LLM, Finance regulation) |
| `#/saved`, `#/later` | Bookmarks, read-later list |
| `#/sources` | Sources and feed health |
| `#/settings` | Appearance (theme, density, shortcuts switch), section layout, watchlist, mutes, backup and restore, V1 import, reset |
| `#/about` | What the site is, how ranking works, legend, shortcuts, data freshness, privacy |

Shortcuts (`src/keyboard/keymap.ts`). They are ignored while typing and with Ctrl / Cmd / Alt held, and Settings can switch all single-key shortcuts off, after which only Esc acts.

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` | Next / previous headline | `[` / `]` | Previous / next section |
| `o` or `Enter` | Open the story | `/` | Search |
| `b` | Bookmark | `l` | Save for later |
| `s` | Show or hide the summary | `a` | Show or hide other coverage |
| `m` | Mute the headline's source | `u` | Undo the last mute while its notice shows |
| `g` then `h` / `s` / `l` / `w` / `n` | Front page / bookmarks / read later / watchlist / new | `?` | Shortcut help |
| `Esc` | Close a dialog or menu, leave the search box | | |

## Status

- **V2 is its own repository**, `PNelsonFTP/ai-drudge-v2`, started on 2026-11-20 with one commit (no V1 history). Nothing in the V1 repository changed.
- **V1 remains live** at https://pnelsonftp.github.io/ai-drudge/ (repository https://github.com/PNelsonFTP/ai-drudge, branch `main`).
- **Deployed 2026-11-20** (Option A of [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), record in its §0): Pages source = GitHub Actions, repository variable `V2_DEPLOY=true`. The first run passed every job on Node 24 / Ubuntu, gate PASS, 402 of 413 feeds OK: the 10 feeds hosted on `*.substack.com` answer HTTP 403 to GitHub's runners. No `ANTHROPIC_API_KEY` is set, so no Daily Brief is shown (owner decision: later).
- **Known open items** (the full list of 58 is [docs/HANDOFF.md](./docs/HANDOFF.md) section 7; how they were found is [docs/REVIEW_2026-11-20.md](./docs/REVIEW_2026-11-20.md)): a production smoke check only, no full visual QA; ranking rules calibrated on one news day; entry bundle above its 85 kB gzip target; until the custom domain is live, V2 shares the `pnelsonftp.github.io` origin, and so `localStorage`, with V1, which ships no CSP ([docs/SECURITY.md](./docs/SECURITY.md)).

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](./docs/README.md) | Index of the docs directory |
| [docs/CONTRACTS.md](./docs/CONTRACTS.md) | Shared types, data files, stage interfaces, client services, fixtures, commands, and what each review round changed |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Current state, configuration reference, local preview, how the workflows deploy, go-live options, rollback, cost, untested register |
| [docs/SECURITY.md](./docs/SECURITY.md) | Trust boundaries, data inventory, threat model, CI privileges, supply chain, auditability, go-live hardening checklist |
| [docs/SOURCES.md](./docs/SOURCES.md) | Generated: every registry source by section with tier, kind and last build status; removed sources; how to add one |
| [docs/SOURCE_RESEARCH.md](./docs/SOURCE_RESEARCH.md) | How the registry was researched: acceptance criteria, reserve backlog, rejected feeds, dead ends, coverage gaps |
| [docs/REVIEW_2026-11-20.md](./docs/REVIEW_2026-11-20.md) | The 17-dimension review of V1 and the review-fix rounds on V2 |
| [docs/PROJECT_HISTORY.md](./docs/PROJECT_HISTORY.md) | Origin, V1 timeline, why V2, how V2 was built, decisions |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 2.0.0 (unreleased) against 1.x: added, changed, removed, security, known issues |
| [docs/SBOM.md](./docs/SBOM.md) / [docs/SBOM.json](./docs/SBOM.json) | Bill of materials: readable summary and CycloneDX 1.6 file (`npm run sbom`) |
| [docs/HANDOFF.md](./docs/HANDOFF.md) | Start here when taking the project over: state of the tree, first hour, daily commands, known defects, what was never verified |
| [docs/V1_VS_V2.md](./docs/V1_VS_V2.md) | For the owner: what changed against V1, with measurements, and what is not better yet |
| [docs/DESIGN.md](./docs/DESIGN.md) | V2 architecture: each pipeline stage and its algorithms, the client, measured sizes, decisions and trade-offs |
| [docs/RUNBOOK.md](./docs/RUNBOOK.md) | Operations: routine checks and what to do for each failure (gate hold, failing source, lost state, brief alert, rollback) |
| [docs/FUTURE_IMPROVEMENTS.md](./docs/FUTURE_IMPROVEMENTS.md) | Roadmap: numbered improvements with sketches, the known-defect register (same list as HANDOFF.md), rejected ideas |
| [docs/archive/](./docs/archive/README.md) | Dated V1 records (2026-09-21 feed audit, candidates, reviews; the June 2026 upgrade plan). Kept unedited |

## Licence and attribution

The repository has no licence file and `package.json` is marked `private`; V1 had none either. Headlines, summaries and links belong to their publishers: the site shows a title, a short summary and a link to the original, and names the outlet on every row. Stock quotes come from Yahoo Finance; the optional Daily Brief is written by an Anthropic model and labelled with the model id in `brief.json`. Third-party packages and their licences are listed in [docs/SBOM.md](./docs/SBOM.md).
