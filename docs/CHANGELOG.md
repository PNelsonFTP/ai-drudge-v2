# Changelog

All notable changes to AI DRUDGE. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`version` in `package.json`).

- Entries are written relative to the previous version. For 2.0.0 that is V1 as it stood on branch
  `main` on 2026-11-19 (commit `8d5cbc26`).
- Numbers are measurements from the builds and test runs of 2026-11-20 unless a date is given.
- The reasons behind each change, the alternatives rejected and the evidence are in
  [PROJECT_HISTORY.md](./PROJECT_HISTORY.md). Types and commands are in
  [CONTRACTS.md](./CONTRACTS.md).

## [2.0.0] - Unreleased (working tree of 2026-11-20)

**Status:** not committed, not pushed, not deployed. V2 exists as uncommitted changes in the `v2`
git worktree. V1 remains the live site and is untouched. Nothing in this release has run on
GitHub Actions.

2.0.0 is a rebuild on the same static architecture: a build-time pipeline writes JSON, a React
single-page app renders it, and there is no server. Reader state in the browser is imported from
V1 once and read-only. The data files, the registry format, the section list, the storage keys
and the CI workflows are all incompatible with 1.x.

### Added

**Pipeline** (`scripts/pipeline/`, composed by `scripts/pipeline/run.ts`, run with `npm run build:data`)

- Seven stages with typed inputs and outputs: ingest -> normalize -> relevance -> cluster -> score
  -> route -> emit, plus the brief and stock enrichers. A stage directory may not import a sibling
  stage; the clock, `fetch`, log and state reach every stage through one context object.
- Build state in `state.json`, carried between builds: first-seen ledger, per-source health, last
  good items, resolved Google News links, the river's memory, the current lead and the TOP STORIES
  list of the previous build.
- Per-source feed memory: conditional GET (`ETag` / `Last-Modified`), last-good items carried
  forward for up to 6 hours when a source fails, quarantine after 48 consecutive failures with one
  probe every 24 hours. An empty but valid feed is reported as an error.
- Story clustering across the whole corpus before routing, with coverage counted in publishers.
  Same-URL copies fold into one article.
- An AI relevance gate for general-interest sources, a noise filter (webinars, events, job posts,
  promotions) and per-source include / exclude rules. Every dropped item is recorded with one of
  the reasons `too_old`, `excluded`, `noise`, `off_topic`, `source_cap`, `release_collapsed`,
  `duplicate`, `invalid`.
- Corroboration rescue: an item over its source's cap is kept when it shares a story with another
  publisher.
- Registry-driven HTML scrapers (19 sources) and JSON API sources (15, of which 12 are Hacker News
  searches on the official Algolia API), with saved bodies under `test/fixtures/scrape/`. JSON Feed
  parsing.
- A zero-article guard: when nothing survives relevance, the previous edition is left in place and
  the gate is marked failed.

**Registry** (`scripts/registry/`)

- A typed source registry: 414 entries (413 active, 1 paused) and 405 publisher entries (317 of
  them own a source) on 2026-11-20, up from 203 feeds and 4 scrapers. Each source has an id, publisher, kind, scope, tier, home
  section, tags and a written note; `validateRegistry` runs at import.
- New sources from the research of 2026-11-19: curation accepted 198 feeds and 19 scrape picks,
  which were merged with V1's sources (duplicates collapsed). The accepted feeds concentrate on
  policy and finance regulators (33), AI security (26), releases (18), cyber (17) and markets
  (17). First-party regulator sources new to the site include FINRA regulatory notices, SEC press
  releases and speeches, CFTC speeches, OCC bulletins, Federal Reserve speeches, Bank of England
  PRA publications, FCA news and IOSCO media releases.
- `scripts/registry/sources/removed.ts` records the 11 V1 sources removed on purpose, each with a
  reason (duplicate, off-mission, low-quality, dead).

**Data contract** (schema v2, `public/data/v2/`, types in `shared/contract.ts`)

- `front.json` (homepage rows, top stories, lead), `rest.json` (full section lists), `river.json`
  (every item that passed relevance in the last 7 days), `health.json`, `sources.json`,
  `brief.json`, `stocks.json`, `status.json` (run, feeds, content, gate, brief, stocks),
  `state.json`.
- Runtime guards (`shared/guards.ts`) and cross-file invariants (`shared/invariants.ts`) used by
  the build gate and by the client before it renders a payload.
- `public/feeds.opml`: every source as a subscription list.
- A committed fixture data set, `test/fixtures/v2/`, installed by `npm run data:fixture` so a
  fresh clone runs without the network. It is a frozen live build (2026-11-20T05:16Z since the
  closing round, 662 KB in 8 files) with a manifest of its provenance; `npm run fixture:refresh`
  replaces it with the last build, deterministically, and refuses a build the gate holds or one
  that lacks a case tests select. Three health rows are synthetic and listed in the manifest (a
  healthy build has no failing or quarantined source to show).

**Reader features** (`src/`)

- TOP STORIES: up to 12 ranked multi-publisher stories with the lead first, each with a publisher
  count and an inline "Also:" line of linked outlets. It replaces Trending and the separate Lead.
- Hash routes: `#/`, `#/s/<sectionId>`, `#/q/<query>`, `#/new`, `#/watch`, `#/saved`, `#/later`,
  `#/sources`, `#/settings`, `#/about`.
- Section pages, a "new since your last visit" page, and search over the edition plus the 7-day
  river, with whole-word matching for short queries.
- Keyword watchlist stored in the browser, with matches highlighted and collected at `#/watch`;
  three one-click presets (CISO, Local LLM, Finance regulation).
- Keyboard navigation (`j` `k` `[` `]` `/` `o` `Enter` `b` `l` `s` `a` `m` `u`, `g` then
  `h` / `s` / `l` / `w` / `n`, `?`, `Esc`) with a help overlay and an off switch in Settings.
- Settings: theme (light, dark, system), density, section order and hiding with four presets
  (Default, CISO, Local lab, Markets), watchlist editor, mutes manager, backup and restore as JSON
  with a preview before restoring, V1 import report and re-import, "Erase all reader data".
- Briefing export: TOP STORIES, watchlist hits and the day's bookmarks as Markdown or plain text,
  to the clipboard or a `.md` file.
- Sources page: every source with publisher, section, tier, scope, status, fail streak, last
  success, links and a per-source mute.
- Section chip navigation, time filters (NEW, 6H, 24H, 3D, ALL), a per-row menu reachable by
  keyboard and touch (bookmark, read later, mute, summary, other coverage), and a mute notice
  with Undo.
- Automatic data refresh every 10 minutes while the tab is visible, a retry for a failed
  `rest.json`, an error boundary, and a "Headlines may be delayed" banner after 2 hours.
- A print stylesheet.

**Tooling**

| Command | Purpose |
|---|---|
| `npm run build:check` | Publish gate (`scripts/tools/check-data.ts`): guards, invariants, freshness against `BUILD_STARTED_AT`, payload sizes, XML well-formedness, feed-health tiers, blank / hollow / frozen content |
| `npm run explain -- <id, url or words>` | Why a story is placed where it is, or why an item was dropped, in the last build |
| `npm run compare` | A V1 payload against the V2 data set: overlap, lead, top stories, drops by reason |
| `npm run validate:feeds` | Every registry source through the build's own HTTP client and parsers |
| `npm run check:links` | Registry and documentation URLs, optionally article URLs |
| `npm run data:fixture` | Install the committed fixture in `public/data/v2/` (checked against its manifest first) |
| `npm run fixture:refresh` | Freeze the last build as the committed fixture (`scripts/tools/fixture-refresh.ts`) |
| `npm run docs:sources` | Regenerate `docs/SOURCES.md` from the registry and the last build's `health.json` |
| `npm run sbom` | Regenerate `docs/SBOM.json` (CycloneDX 1.6; 1.x wrote 1.5) and the marked tables of `docs/SBOM.md`; `-- --check` exits 1 when stale |
| `npm run typecheck` | `tsc -b` over four projects: shared, app, node, test |

**Tests**

- 2,782 tests in 449 suites and 132 `*.test.ts` files at the end of the closing round on
  2026-11-20 (2,415 at the end of the fix round; 1.x: 8 tests in 2 files), on `node:test` with no
  test dependency and no network access. `npm test` runs them all.
- `test/boundaries.test.ts` enforces the import rules between `shared/`, `scripts/` and `src/`.
- Fixtures: a frozen live V2 build (tests select its rows by property - "a paywalled homepage
  row", "a carried source" - and never pin a headline or a count, so the fixture can be replaced),
  the V1 production payload of 2026-11-19 and the edition bridged from it, a 2,297-item live fetch
  of the same day, raw feed bodies and scraper pages.

**CI and operations** (`.github/`)

- `ci.yml`: pull-request checks (typecheck, tests, site build) with a read-only token and no
  secrets.
- `refresh.yml` rewritten as five jobs: guard, build, deploy, persist, alert. The build job runs
  typecheck and tests, restores state, builds the data, runs the gate and builds the site. A
  failure opens or updates one rolling issue.
- `feed-audit.yml` rewritten as two jobs (audit, report): the weekly source audit plus
  `npm audit --audit-level=high` on the full dependency tree and `npm audit signatures`, with
  failures filed as issues.
- `dependabot.yml`: weekly grouped updates for npm and GitHub Actions with a 7-day cooldown.
- `.node-version` (24) and `engines.node >= 22.15.0`.

### Changed

- **Sections: 18 -> 15.** Merged: local models + open source (LOCAL & OPEN MODELS), agents +
  products (AGENTS & TOOLS), AI finance + funding (MARKETS & DEALS), cyber threats + cyber defense
  (CYBER WIRE). Split: safety and policy into POLICY & REGULATION and SAFETY & ALIGNMENT. Only
  `ai`-desk sections feed TOP STORIES, the lead, the brief and the Atom feed; CYBER WIRE, QUANTUM
  WATCH and RELEASE RADAR never do.
- **Ranking.** Coverage (publishers) is the main significance signal, with tier, recency
  (36-hour half-life), a small title-only importance term and an exact-URL Hacker News match. 1.x
  ranked by feed priority and recency per article and boosted every link on a matching domain.
- **Emphasis.** Red and bold now mark story size, not the priority of the feed: red bold at 8 or
  more publishers, bold at 3 or more (or a tier-1 first-party launch), grey italic for a tier-4
  lead with fewer than 2 publishers.
- **Per-source cap.** Applied after relevance, default 8, keeping the highest-tier and freshest
  items. 1.x kept each feed's 6 newest items before looking at them.
- **Routing.** Rules are data with compiled word-boundary matching, title-weighted; a story appears
  in its home section and at most one other. 1.x matched substrings, and 45 of its 185 homepage
  slots repeated a story shown in another section.
- **Lead story.** The first of TOP STORIES, kept while it stays in the top 3 and is under 24 hours
  old. 1.x picked the highest-scoring single article on every build.
- **Daily Brief.** Shown only when it was written by the model (`brief.source === "claude"`); the
  deterministic fallback is still published in `brief.json` with a `fallbackReason` but is not
  rendered. The brief's input is the top stories and section leads.
- **Stock ticker.** Yahoo is the only provider (Stooq, 1.x's primary, returns 404); change is
  against the previous close; each quote carries the exchange timestamp and the file says whether
  the market was open.
- **Atom feed.** Top stories and section leads of the `ai` desk, with stable entry ids, ordered by
  first-seen time.
- **Client loading.** One normalized payload (`front.json`, then `rest.json`, then `river.json` on
  demand) replaces `headlines-preview.json` + `headlines.json`. Every payload is validated before
  use.
- **Client structure.** One 479-line component became a service container
  (`src/app/services.ts`, `createServices.ts`) with one directory per route under `src/features/`.
- **Browser storage.** Keys moved to the `aid2:` namespace with versioned, validated envelopes.
  V1 keys (`ai-drudge:*`) are read once and never written.
- **Generated data is no longer committed.** `public/data/`, `public/feed.xml` and
  `public/feeds.opml` are gitignored; CI keeps `state.json` on an orphan `data` branch and removes
  it from the deployed site unless the repository variable `V2_PUBLISH_STATE=true` is set.
- **Refresh schedule.** Four cron slots an hour (`7,22,37,52 * * * *`) with a guard that skips a
  run when the live data is under 20 minutes old; designed cadence 30 minutes. 1.x: two backup
  cron lines and an external kick.
- **Deploy target.** Vite `base` and the feed URLs come from `SITE_BASE` (default
  `/ai-drudge-v2/`) and `SITE_URL`; no V1 URL is hard-coded.
- **`scripts/kick-refresh.sh`.** Repository, ref and workflow come from the environment
  (`AID_REPO`, `AID_REF`, `AID_WORKFLOW`); it refuses to dispatch to the V1 repository unless
  `AID_ALLOW_V1=1`.
- **Dependencies.** Vite 6.3 -> 8.3.8, `@vitejs/plugin-react` 4.4 -> 6.3.0, TypeScript 5.8 ->
  ~6.0.3 with four tsconfig projects, React 19.1 -> 19.3.1, Tailwind 4.1 -> 4.3.5, fast-xml-parser
  5.9.3 -> 5.12.1, tsx 4.19 -> 4.23.15, and `@types/node` 25 -> 24 to match the CI runtime. The
  lockfile went from 190 to 125 packages. No dependency was added or removed.
- **Tailwind** scans `src/` and `index.html` only. In 1.x it scanned `public/data`, so news text
  changed the CSS and renamed the hashed assets in 63 of 199 sampled deploys.
- **Package** renamed `ai-drudge-v2`, version `2.0.0`.
- **Entry bundle is larger:** 108.20 kB gzip of JavaScript (338.58 kB raw) against 69.3 kB in 1.x.
  First-paint data is `front.json` at 43.9 KB gzip (the gate warns above 48 KB). Both figures are
  from the closing round's builds.

### Fixed

Defects of 1.x, each reproduced by the review of 2026-11-19, that 2.0.0 corrects:

- The day's dominant story was not recognised: the Anthropic IPO was 21 separate clusters labelled
  "2 sources" at Trending #5. In the 2.0.0 builds of 2026-11-20 it is one story with 27 to 31
  publishers and leads the page.
- One publisher counted twice as a "trend": the duplicate OpenAI feed pair produced 31.7% of all
  Trending rows. Coverage now counts publishers.
- Both Anthropic scrapers returned no items from 2026-10-20. Rewritten against current markup,
  with fixtures.
- Undated scraped posts never aged (posts up to 561 days old held AI SECURITY homepage slots).
  Scraped items take the page's date where there is one, else first-seen time, and on a source's
  first build undated items are placed beyond its age limit.
- One malformed item (for example the entity `&#x110000;`, or an absurd relative date) failed the
  whole build. Items and sources are isolated from each other.
- The keyword `edr` matched inside "Bedrock" and routed AWS posts to CYBER DEFENSE.
- GitHub release lines took sub-package tags ("langchain v0.3.0 released" from
  `langchain-openrouter==0.3.0`). The repository's own release line is used, newest stable first,
  one line per repository.
- The first paint showed a different lead story than the hydrated page in 71% of builds.
- A failed `headlines.json` request was never retried, and a wrong-shaped cached payload blanked
  the tab on every reload.
- Dedup stripped the whole query string, discarding 9 of 10 posts of a feed that uses `?p=`
  permalinks. Identity-bearing parameters are kept.
- The per-feed item window kept the first 15 items in document order (a four-year-old item over
  one 2.6 hours old). It keeps the newest by date.
- 38% of summaries were cut at 320 characters, mostly mid-word, and feed boilerplate ("The post
  ... appeared first on ...", arXiv "Announce Type:") inflated scores. Summaries end at a word
  boundary and boilerplate is removed.
- Date handling: a date-only stamp is treated as noon UTC instead of midnight, and a date more
  than 1 hour in the future is replaced by first-seen time (1.x scored a future date as a fixed
  age).
- Relative item links shipped as broken URLs (one feed, at least six sampled builds). Links are
  resolved against the feed URL, with the item's guid as a fallback.
- Fetch concurrency had head-of-line blocking (316 s with one host hung). The per-host pool no
  longer sits behind a global gate.
- Two dialogs rendered black on near-black in the default theme (contrast 1.16:1). Dialogs are
  native `<dialog>` elements styled from tokens.
- 43 text / background pairs failed WCAG AA. A contrast test covers 100 pairs per theme.
- The page had 623 tab stops and no skip link, `<h1>`, landmarks or visible focus on search.
  Summaries and related coverage were reachable only by mouse hover; mute was mouse-only.
- Search tested unranked substrings over pre-sliced lists ("anthropic ipo" found 1 of 16 matching
  stories).
- Bookmarks and read state were unversioned and shared with any other site build on the same
  origin.
- A build could exit 0 without writing data and redeploy the old edition green (33 runs). The
  gate now requires `generatedAt` to be at or after the recorded build start.
- The quality gate never failed in 1,000 runs, and a payload with zero sections passed it. The
  gate now fails on blank, hollow and frozen content and on mass feed failure.
- The dependency audit used `--omit=dev` and could not see the build-time parsers (7 advisories,
  6 high). It audits the full tree: 0 advisories on 2026-11-20.

Defects found in 2.0.0 itself during cutover and the review-fix round (101 findings) are listed
in [PROJECT_HISTORY.md](./PROJECT_HISTORY.md), sections 6.6 and 8.5.

### Removed

- The 1.x pipeline: `scripts/build-data.ts`, `fetch-feeds.ts`, `scrape-sources.ts`, `fetch-hn.ts`,
  `fetch-stocks.ts`, `generate-brief.ts`, `check-data.ts`, `validate-feeds.ts`,
  `report-feed-audit.ts`, `sources.ts`, `types.ts`, `scripts/lib/**`,
  `scripts/discovered-2026-09-21.json`.
- The 1.x client: `src/App.tsx`, `src/components/**`, `src/hooks/**`, `src/lib/**`,
  `src/styles.css`.
- The 1.x data files: `public/data/headlines.json`, `headlines-preview.json`, and the committed
  `brief.json` and `stocks.json`.
- The Trending block, the separate Lead Story block and the rendered fallback brief.
- Feed-priority colouring and the dimming of rows older than 72 hours.
- The Stooq quote provider.
- Data commits to `main`.
- 11 sources judged duplicate, off-mission, low-quality or dead, among them the duplicate OpenAI
  feed, the general Bloomberg markets wire, MarketWatch and the two Reddit feeds. The list with
  reasons is `scripts/registry/sources/removed.ts`.

### Security

- **Untrusted input.** Only `http` and `https` URLs survive ingest; response bodies are capped at
  5 MB; titles at 200 characters and summaries at 320; the HTML tree builder has a depth cap. One
  hostile item cannot fail a build or make the Atom feed malformed.
- **Outbound requests.** Redirects are followed hop by hop (at most 8) and a hop to a non-public
  host is refused.
- **Workflow privilege.** `permissions: {}` at workflow level. The job that installs packages and
  parses feeds holds `contents: read` only; deploy holds Pages and OIDC and runs no repository
  code; `contents: write` exists only in the job that force-pushes the `data` branch;
  `issues: write` only in the alert and report jobs. In 1.x one job held all of them.
- **Supply chain.** `npm ci --ignore-scripts` wherever packages are installed; every action
  pinned by commit SHA;
  `npm audit` on the full tree plus `npm audit signatures` weekly; Dependabot with a 7-day
  cooldown; all 7 advisories of the 1.x lockfile cleared.
- **API key.** `ANTHROPIC_API_KEY` is passed to the brief stage only, is removed from
  `process.env` by the build entry point, and is supplied by the workflow on `main` only. Text
  sent to the model is delimited as untrusted and the reply is type-checked; citations are rebuilt
  from the build's own data. The key was not set in any build so far, so this path has not run.
- **Log injection.** A log line cannot start a GitHub Actions workflow command.
- **Browser.** Production builds carry a Content-Security-Policy `<meta>`: same-origin only, no
  inline style, one inline script allowed by hash. The app refuses to start inside another site's
  frame. The page makes no third-party request.
- **Reader state.** V2 cannot write a key outside `aid2:`; V1 keys are never written. A restore is
  validated field by field and previewed before it is applied.
- **Inert by default.** Every job in `refresh.yml` and `feed-audit.yml` requires the repository
  variable `V2_DEPLOY == 'true'`; the concurrency group is unique to V2.
- **Known exposure, not fixed:** `state.json` (3.3 MB, plain-text summaries, no reader data) is no
  longer deployed with the site by default, but its one copy sits on the `data` branch of a public
  repository; V2 on the default Pages host shares its origin, and therefore `localStorage`, with
  V1, which ships no CSP (a review finding; V1 was not inspected).

### Final round (2026-11-20)

Changes made after the review-fix round, on top of everything above. Four steps: five fixers,
three integrators, three auditors (25 findings), one closer. Evidence and rejected alternatives
are in [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md), Part 3; every contract change is in
[CONTRACTS.md](./CONTRACTS.md), sections 11 to 13.

**Added**

- TOP STORIES: running-story folding (a follow-up needs 5 publishers of its own for a slot; one
  running story holds at most 2), a hold against churn (`state.json` `top`; up to 2 hours unless the
  newcomer scores 5 points higher), and a recency cap of 40 points for stories with fewer than 3
  publishers.
- Clustering: a corroborated second pass for near-miss pairs, a veto for different products that
  share a version number, and three narrow vetoes against false merges (rival companies, a
  continent as the only shared unit, a pair that shares only words the whole run uses).
- POLICY: a homepage floor for first-party regulator notices (72 hours, at most 4 guaranteed rows,
  at most 2 rows per regulator) and a section-focus bonus for titles naming SEC, FINRA, CFTC or
  OCC. AI SECURITY: a rule and focus bonus for outage stories with an AI term. LOCAL & OPEN
  MODELS: a section-focus bonus, up to 2 routed-in release lines, 9 runtime release feeds routed in.
- Outlet quality control for query and aggregator feeds: a deny list of 10 hosts with recorded
  evidence, and "unvetted outlet" handling (tier 4, never a lead, no coverage count) for outlets no
  publisher entry vouches for.
- Registry fields `outlets`, `includeIn` and `fetch` (per-source fetch policy); one new source
  (`hn-local-stack`).
- Host backoff in ingest: a host that answers 5xx or 429 to two requests in a row is left alone for
  the rest of the run and its sources are carried forward.
- Brief failure alert: the sixth consecutive failed keyed build raises an error annotation and a
  rolling issue.
- Search operators `source:` and `section:`, a separate group for stories that match only by source
  name, and a link to the section when the query is a section name.
- Reader notices: "still trying" while the first load is retried, and a banner when the browser
  refuses storage writes. A "Dim headlines I have seen" setting.
- `npm run fixture:refresh` and `npm run docs:sources`; `docs/SOURCES.md` (generated); the
  CycloneDX 1.6 SBOM with GitHub Actions, Node.js and 7 external services.
- Tests: 2,415 -> 2,782.

**Changed**

- Hacker News searches moved from hnrss.org (502 errors in every build) to the official Algolia
  API. A Hacker News thread can no longer lead a story.
- The committed fixture is a frozen live build instead of the bridged V1 payload; tests select its
  rows by property. The bridged edition is kept under `test/fixtures/bridged-2026-11-19/` for the
  14 route regression tests that pin that day's headlines.
- `state.json` is removed from the Pages artifact by default; the `data` branch is the hand-over
  path between builds.
- The stale banner follows `status.json` `staleAfterMinutes`, raised from 90 to 120.
- Time filters use a story's newest visible article. Shell time chips appear on the front page and
  `#/new` only.
- The keyboard layer, the hover card, the shortcuts dialog and the mute notice load as one lazy
  chunk after first paint (entry JS 109.61 -> 108.20 kB gzip).
- MODELS & LABS window 3 / 6 -> 5 / 10 days. Same-subject cap on section homepages: stories with 5
  or more publishers, at most 2 rows (was 6 and 3).
- Low-signal rows (display weight 0, or a forum thread) take a homepage row in topic sections only
  when nothing else can.
- An item over its source's cap is also kept when the cap slots were taken by a story with 6 or more
  publishers ("big-story relief"); never for a source with its own `maxKept`.
- The outlet count on a row agrees with its "Also:" line: counted outlets first, the rest under
  "also linked:". The TOP STORIES heading reads "ranked by coverage and freshness".
- Short search words match versioned names ("qwen" finds "Qwen4-Max"); watch presets use `Qwen*`
  and `Gemma*`.
- `validate:feeds`, `check:links` and `build:data` refuse unknown arguments and answer `--help`
  without a request.
- The gate's site-URL warning compares the feed's self link with the configured `SITE_URL`.

**Fixed**

- Three false story merges on homepage lists (Nvidia / AMD short-seller reports, two unrelated
  Schneider Electric items, a ransomware claim and an SEC inquiry), and a 12-publisher company saga
  that hid the SEC inquiry inside an 81-hour-old headline.
- Title junk seen on the live river: day stamps, pull-request numbers, revision markers, section
  labels, dangling sentence fragments.
- The page-level "Try again" after a failed route chunk now reaches the route registry.
- A malformed V1 migration marker no longer makes the Settings page throw.
- The "still trying" state is announced once, not by two live regions.
- A wall-clock budget in `scripts/pipeline/ingest/html.test.ts` that failed under load (2 s -> 15 s).

**Security and privacy**

- The registry tag `owner-stack` (57 sources) and about 35 notes that described the reader's role
  and security vendors were removed or reworded; `sources.json`, the fixture and `docs/SOURCES.md`
  were regenerated without them. [SECURITY.md](./SECURITY.md) section 2.5 records the residual.
- The feed-audit issue lookup accepts only an issue opened by a bot and fails the step in GitHub
  Actions when the lookup itself fails.
- `.gitignore` covers `.env.*` and `.claude/settings.local.json`.

**Rejected in this round** (reasons in [CONTRACTS.md](./CONTRACTS.md) section 11 and
[REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) Part 3): publishing `topRelated` in `front.json`,
`routeTo` on `hf-unsloth-gguf`, an asynchronous backup service, a React vendor chunk, a wider
product veto, looser corroboration rules, an AI-term test on the NYT topic feed, a recency cap on
every TOP story, and a time-gap rule for merges.

### Known issues

The known-defect register (58 open rows on 2026-11-20) is in
[FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md), "Known defects"; the same rows, with the file to
open first, are in [HANDOFF.md](./HANDOFF.md) section 7. Never verified: anything in a browser in
the fix round or the final round, anything on GitHub Actions, Node 24 on Linux, the model-written
brief, a second day of news.

## [1.x] - 2026-06-14 to 2026-11-19

V1 carried `"version": "1.0.0"` in `package.json` from start to finish and has no release tags;
`1.x` names everything on `main` up to the fork. It began on 2026-06-14
as a static Vite + React aggregator that replaced a request-time Next.js scraper, and grew through
nine phases: multi-category keyword routing and a per-source cap (2026-06-14); scoring with
recency decay, age windows and a CI quality gate (2026-06-22); a source overhaul to 178 validated
feeds with a feed validator, an Atom feed, an SBOM generator, persistent bookmarks and read state
(2026-07-07); a preview payload, wrapper-URL unwrapping and more scrapers (2026-08-18); a further
feed pass to 203 feeds and 4 scrapers, a twice-hourly cron and the navy and gold restyle
(2026-09-21); and an external refresh clock after GitHub's cron proved unreliable (2026-10-05).
It shipped 18 sections, a Trending block, a Lead Story, a Daily Brief that was always the
deterministic fallback, and an 8-symbol stock ticker, with data committed to `main` on every run
(2,136 of 2,154 commits). The phase-by-phase record is in
[PROJECT_HISTORY.md](./PROJECT_HISTORY.md), section 3.
