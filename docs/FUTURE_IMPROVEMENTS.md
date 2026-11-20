# AI DRUDGE V2 - Future improvements

Written 2026-11-20 (UTC), at the end of the final round, and updated the same day after its closing
step. This is the roadmap for the next working session: 31 numbered improvements in five groups,
58 known defects, and the ideas that were considered and rejected. It replaces the V1 roadmap of 2026-07-06 that used to live in this file
(V1's plan and reviews are in [archive/](./archive/README.md)).

**The answer first.** Do group A in order. A1 (go-live rehearsal) and A2 (own origin) come before
any feature because nothing in V2 has been seen in a browser or run on GitHub, and because the
origin a reader first uses is where their saved state lives. A3 (evaluation harness) comes before
any ranking change because every ranking rule in the code today was calibrated on one news day.

Related documents: [CONTRACTS.md](./CONTRACTS.md) (types, ownership, commands),
[DEPLOYMENT.md](./DEPLOYMENT.md) (go-live), [SECURITY.md](./SECURITY.md) (threat model),
[REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) (findings), [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md)
(source backlog), [SOURCES.md](./SOURCES.md) (generated registry listing),
[CHANGELOG.md](./CHANGELOG.md), [PROJECT_HISTORY.md](./PROJECT_HISTORY.md).

## 0. How to read this file

### 0.1 Baseline the roadmap assumes

Checked against the working tree on 2026-11-20 unless a row says otherwise.

| Fact | Value | How it was checked |
|---|---|---|
| Tests | 2,782 pass, 0 fail, 449 suites, 132 test files | `npm test` re-run after the closing round (Node 26.7.0; CI pins Node 24 in `.node-version`) |
| Registry | 414 sources (413 active, 1 paused: `venturebeat-ai`), 405 publisher entries (317 own a source), 12 `probation` tags | Script over `scripts/registry/index.ts` |
| Registry kinds | rss 249, newsletter 57, github-release 37, query 23, scrape 19, json 15, papers 9, community 4, aggregator 1 | Same script |
| Registry tiers 1 / 2 / 3 / 4 | 6 / 66 / 255 / 87 | Same script |
| Data on disk | Build `2026-11-20T05:16:55.936Z` (the closing build): 322 stories, 367 placements, TOP 12, 412 of 413 sources OK and 1 carried forward, gate passed with 0 warnings, brief `fallback` / `no-key` | `public/data/v2/status.json`, `npm run build:check` |
| River | 1,086 rows, 7 days (`RIVER_DAYS`) | `public/data/v2/river.json` |
| Entry bundle | 338.58 kB raw / 108.20 kB gzip (target 85, not met) | Closing round's `npm run build` log; raw size confirmed in `dist/` |
| Git | Everything in the worktree is uncommitted; no V2 repository or Pages site exists | `git status`; integrator link check (both V2 URLs returned 404) |
| Browser | The fix round and the final round did not use a browser. After the closing build all 13 routes were opened once (desktop and phone): they render with no new console errors. No visual QA beyond that | Round rules; smoke check 2026-11-20 |
| GitHub | No workflow has run | No remote exists for V2 |

### 0.2 Conventions

| Term | Meaning |
|---|---|
| Effort S / M / L | S: up to half a day. M: one to three days. L: more than three days. Engineer or agent working time, including tests. |
| Risk | What can go wrong for the reader or the operator, not how hard the code is. |
| Depends on | Items of this file, or an owner decision. "None" means it can start now. |
| Verify | The check that proves the item is done. Every item also has to pass `npx tsc -b` and `npm test`; that is not repeated. |
| "Not verified" | The statement was not checked against code, data or a live service for this document. |

Rules that apply to every item (from [CONTRACTS.md](./CONTRACTS.md)):

1. Change a contract and its consumers in the same commit. `shared/` stays pure (no `node:`, no DOM).
2. A new published file needs: a type in `shared/contract.ts`, a guard in `shared/guards.ts`, an
   entry in `DATA_FILES`, a size line in the gate (`scripts/tools/check-data.ts`), and a case in
   `test/helpers/fixtureCases.ts` if tests select from it.
3. `front.json` has a 48 KB gzip first-paint budget and is at 43.9 KB. Put new data in `rest.json`
   or in a new lazy file, never in `front.json`.
4. Policy numbers live in one place per stage (`PIPELINE`, `SCORE`, `CLUSTER`, `ROUTE_POLICY`,
   `GATE`). Do not re-declare them.
5. A new route is one directory `src/features/<name>/route.tsx` plus a `Route` member in
   `src/app/services.ts` and its hash in `src/app/routes.ts` (`parseRoute`, `formatRoute`).
6. No new runtime dependency in the browser (today: `react`, `react-dom`, `scheduler`). A new
   build-time dependency changes `docs/SBOM.json`; run `npm run sbom`.

### 0.3 All improvements at a glance

| # | Improvement | Group | Effort | Risk | Depends on |
|---|---|---|---|---|---|
| A1 | Go-live rehearsal: first commit, first GitHub runs, first browser pass | Do next | M | Low | Owner (repository choice) |
| A2 | Own origin (custom domain) before the first public URL | Do next | S | Low | Owner (domain) |
| A3 | Evaluation harness: daily corpus capture, labelled pairs, replay metrics | Do next | M | Low | None |
| A4 | TOP STORIES entry rules and a beat check for topic feeds | Do next | M | Medium | A3 |
| A5 | Story threads and timelines for running stories | Do next | L | Medium | A3 |
| A6 | Regulatory tracker with deadlines on the POLICY desk | Do next | M | Medium | None |
| A7 | Model-release ledger | Do next | L | Medium | None |
| A8 | Brief as its own step: pluggable provider (local endpoint), grounding check, injection tests | Do next | L | Medium | A1 |
| A9 | Archive: "yesterday" and browse by date | Do next | S then M | Low | A1 for phase 2 |
| A10 | "Why is this here" explain panel | Do next | M | Low | None |
| B1 | Installable app and offline reading (service worker) | Product | M | High | A1, D1 |
| B2 | Daily digest: Atom digest feed, optional e-mail | Product | S then M | Low / Medium | A9 phase 2 helps |
| B3 | Mute and watch rules per section | Product | M | Low | None |
| B4 | Price context in the markets ticker | Product | S | Low | None |
| B5 | A "cyber" edition from the same engine | Product | L | Medium | A1 |
| C1 | Local relevance classifier as a second opinion | Pipeline | M | Medium | A3, A8 |
| C2 | Embeddings-based clustering computed at build time | Pipeline | L | High | A3, A8 |
| C3 | Per-source reliability score that proposes tier changes | Pipeline | M | Low | A1 (needs days of state) |
| C4 | Link-rot and paywall detection | Pipeline | M | Low | None |
| C5 | Section list rules: same-subject tail, recency-only rows | Pipeline | S | Medium | A3 |
| D1 | Browser tests: Playwright smoke and visual regression | Ops / security | M | Low | Owner (new dev dependency) |
| D2 | Pipeline state off the public site and off the public branch | Ops / security | M | Medium | A1 |
| D3 | AI-use audit trail: one record per build | Ops / security | S | Low | A1, A8 |
| D4 | Entry bundle: prerendered shell | Ops / security | L | Medium | D1 |
| D5 | Supply-chain checks in CI: SBOM schema, signatures, action pins | Ops / security | S | Low | A1 |
| D6 | Ingest timing and trend in `status.json` | Ops / security | S | Low | None |
| E1 | Monthly re-validation of the reserve backlog (source suggestions) | Sources | M | Low | A1 |
| E2 | Chinese-language lab sources through translation | Sources | L | Medium | A8 |
| E3 | Outlet vouching queue | Sources | S | Low | None |
| E4 | Finance-regulator coverage gaps | Sources | M | Low | A1 (CI egress) |
| E5 | Changelogs with fragment links; local-runtime gaps | Sources | M | Low | None |

---

## A. Do next (ordered)

### A1. Go-live rehearsal: first commit, first GitHub runs, first browser pass

**What and why.** Three whole classes of behaviour are unverified: the page in a real browser, the
three workflows on GitHub, and the pipeline at its real cadence. Every later item builds on them.
The reader's risk is a site that looks wrong or stops refreshing on day one.

**Starts in.** [DEPLOYMENT.md](./DEPLOYMENT.md) sections 5 to 8 and 12 (procedure), section 14
(untested register); `.github/workflows/refresh.yml`, `feed-audit.yml`, `ci.yml`.

**Sketch.**

1. Decide the go-live option (DEPLOYMENT.md section 6; Option A, a new repository, is the recommended one).
2. Make the one local commit of section 7, including `git rm --cached public/feed.xml`.
3. Browser pass on `npm run build && npm run preview` (production build, so the CSP `<meta>` is
   present): the list in defect KD-1, at 375 px, 720 px and 1280 px, light and dark.
4. Push with `V2_DEPLOY` unset: confirm every job of `refresh.yml` and `feed-audit.yml` is skipped.
   Open a pull request: confirm `ci.yml` (which has no such guard, on purpose) runs `npm test`
   green on a clean Linux checkout with Node 24.
5. Set `V2_DEPLOY=true`. Run 1: expect an empty-state build. Run 2: expect "State restored from:
   data branch" in the step summary and the Washington Post row at about 10 s with 1 attempt.
6. Confirm `state.json` is absent from the deployed site and present on the `data` branch.
7. Leave it running for 24 h, then read `status.json` history from the run summaries: TOP churn per
   build, `topHeld` count, carried sources, ingest seconds.
8. Record results in DEPLOYMENT.md section 14 and close the matching rows of section 15.

**Effort** M. **Risk** Low (V1 is untouched in Option A). **Depends on** owner: repository choice,
and A2 if a custom domain is wanted from day one.

**Verify.** Two consecutive scheduled runs green; second run restores state from the `data` branch;
`curl -sI <site>/data/v2/state.json` answers 404; no CSP violation in the browser console on home,
a section page, search and Settings.

### A2. Own origin (custom domain) before the first public URL

**What and why.** On `github.io`, V2 shares one origin, and therefore one `localStorage`, with V1
and with every other Pages project of the account ([SECURITY.md](./SECURITY.md) section 3.9, finding
SEC-8, open). V1 ships no CSP (review finding; not re-inspected). Reader state (watch terms,
bookmarks, mutes) is stored per origin, so moving to a new origin later strands it; a reader would
have to use Settings > backup export and import. Choosing the origin before the first public link
avoids that.

**Starts in.** Repository variables `SITE_URL` and `SITE_BASE` (`scripts/pipeline/context.ts`
`ENV`, `DEFAULT_SITE_URL`, `DEFAULT_SITE_BASE`); `vite.config.ts` (`base` from `SITE_BASE`);
preflight step of `refresh.yml`; `src/features/about/AboutPage.tsx` ("Privacy").

**Sketch.**

1. Owner registers a domain and adds the DNS record GitHub Pages asks for.
2. Set the Pages custom domain in the repository settings; enforce HTTPS. Whether an Actions-based
   Pages deploy also needs a `CNAME` file in the artifact: not verified.
3. Set repository variables `SITE_URL=https://<domain>/` and `SITE_BASE=/`.
4. Run a build; check `feed.xml` and `feeds.opml` carry the new URL and the page loads its assets
   from `/`.
5. If the owner stays on `github.io` instead: add one sentence to the About page saying that pages
   of the same account can read the reader's saved state (SECURITY.md section 3.9, option 2).

**Effort** S. **Risk** Low; a DNS mistake shows as a failed deploy verification, not as a broken V1.
**Depends on** owner (domain purchase).

**Verify.** `location.origin` of the live page is the custom domain; `localStorage` shows only
`aid2:` keys; the preflight passes (its `*.github.io` path checks do not apply to another host);
`npm run build:check` has no warning about the site URL.

### A3. Evaluation harness: daily corpus capture, labelled pairs, replay metrics

**What and why.** Cluster thresholds (`CLUSTER.threshold` 0.40, `attachThreshold` 0.25,
`corroboratedThreshold` 0.29), the product veto, the running-story fold and the TOP hold were tuned
on the corpus of 2026-11-19 and on 2 to 4 live examples of 2026-11-20. The labelled set is 62
same-story pairs and 54 different-story pairs inside one test file (58 of 62 recalled, 1 of 54
falsely merged; test output of 2026-11-20). The closing round added three merge vetoes and a
saga split on the evidence of one live day (defect KD-5). Without a multi-day corpus and
one command that prints the metrics, every ranking change is a guess. This item is the precondition
of A4, A5, C1, C2 and C5.

**Starts in.** `scripts/pipeline/cluster/index.test.ts` (hand-labelled pairs, `KNOWN_MISSES`,
`KNOWN_FALSE_MERGES`); `test/fixtures/items-2026-11-19.json` and `registry-2026-11-19.json`;
`scripts/pipeline/run.ts` (`processItems`, the pure middle); `scripts/tools/explain.ts`;
`test/helpers/fixtures.ts` (`loadCorpus`).

**Sketch.**

1. New tool `scripts/tools/corpus-capture.ts` (`npm run corpus:capture`): after a build, write the
   normalized kept set (what `processItems` receives) plus the registry snapshot to
   `test/corpus/<YYYY-MM-DD>.json`. Cap the size (titles, summaries, source ids, times; no HTML).
2. Move the labelled pairs out of the test file into `test/corpus/labels.json`:
   `{ day, a, b, same: boolean, note }`, addressed by article id with the title as a check.
3. New tool `scripts/tools/evaluate.ts` (`npm run evaluate`): replay every captured day through
   `processItems` and print one table per day: pair recall, false merges, multi-publisher stories,
   TOP list, homepage rows led by tier 4, off-beat TOP entries (labelled), TOP churn between two
   consecutive captures of the same day.
4. Add `--set CLUSTER.threshold=0.38` style overrides so a tuning run needs no code edit, and
   `--baseline <file>` to print a diff against a saved result.
5. Label 30 pairs per captured day for at least 7 days, including the open splits (China chip sales
   FT / Reuters; AI Safety Caucus The Record / Politico).
6. Keep the one-day test as it is; add a test that the harness reproduces today's pinned numbers
   (58 of 62 recall, 1 of 54 false merges).

**Effort** M (plus a few minutes of labelling per day for a week). **Risk** Low; it changes no
published behaviour. Corpus files hold third-party headlines and summaries: keep them out of the
Pages artifact (they are under `test/`, which is not published). **Depends on** none.

**Verify.** `npm run evaluate` prints the same recall and false-merge numbers as the existing
cluster test for 2026-11-19; a deliberate change of `CLUSTER.threshold` moves the numbers; seven
dated corpus files exist.

### A4. TOP STORIES entry rules and a beat check for topic feeds

**What and why.** Measured on 2026-11-20 between two builds 42 minutes apart: two stories 0.7 h
old with 2 publishers entered TOP at #3 and #9 with scores of 96.4 and 91.1, above a 6-publisher
frontier-model launch (92.4). About 49 of those points are recency (`SCORE.recencyMax` 50). Both
were off the AI beat (an energy permitting bill, a White House personnel change); they came from
the `nyt-artificial-intelligence` feed, which is `scope: "ai"` and therefore skips the relevance
gate, and were routed to POLICY by single title words ("senate", "white house",
`scripts/pipeline/route/rules.ts`). TOP then held one AI-security story and nothing on local models
or financial regulation.

Closing round, same day: `PIPELINE.topRecencyCap` now caps the recency part at 40 points for a
story with fewer than 3 publishers when TOP is ranked (`topStanding` in
`scripts/pipeline/context.ts`). In the closing build the permitting bill is TOP #6 instead of #3
and the 6-publisher launch is #5; both newcomers are still in TOP and the bill is still POLICY #1
(defects KD-7 and KD-8). A cap on every story was measured and rejected (it moved the lead of the
2026-11-19 corpus to a 23 h-old launch). Step 4 below was measured and rejected as written: 3 of
the feed's 5 items carry no AI term in title or summary, and the test would also drop the outage
coverage. What remains is steps 1, 3, 5, 6 and 7, plus a lead choice that prefers a member
headline naming the AI angle.

**Starts in.** `scripts/pipeline/route/top.ts` (`pickTop`); `scripts/pipeline/score/weights.ts`
(`SCORE`); `scripts/pipeline/score/index.ts` (`freshAt`, `scoreStory`);
`scripts/pipeline/relevance/index.ts` (`isGated`); `scripts/registry/sources/press.ts`
(`nyt-artificial-intelligence`); `scripts/pipeline/route/rules.ts` (POLICY rule terms).

**Sketch.**

1. With A3, label the TOP lists of the captured days: on-beat or off-beat, deserved or premature.
2. TOP-only rank: in `pickTop`, rank on `fade x (tier + coverage + importance + hn)` plus recency
   capped at the story's own coverage points, so a 2-publisher story cannot get more from being new
   (22 points) than from being covered. The section lists keep today's score.
3. Corroboration floor for young stories: under 3 h old, a TOP slot needs 3 publishers or a tier-1
   lead. Put both numbers in `ROUTE_POLICY`.
4. Beat check: change `nyt-artificial-intelligence` to `scope: "general"` so the AI gate applies,
   and measure the collateral drops by replay before keeping it. Review the other topic feeds of
   general publishers the same way (list them from the registry: 45 sources are `scope: "ai"` with
   tag `press`).
5. POLICY rule: for items of general-press sources, require the institution word together with an
   AI or regulator term in the title; the bare word keeps routing first-party and policy-desk
   sources.
6. Add both stories of 2026-11-20 as regression cases with their real titles.
7. Extend `npm run explain` to print the TOP rank parts and the floor that kept a story out.

**Effort** M. **Risk** Medium: TOP becomes slower to show real breaking news; the floor is the
number to watch. **Depends on** A3.

**Verify.** On the captured days, off-beat TOP entries drop to 0 without losing a labelled
"deserved" entry; the 6-publisher launch outranks both 2-publisher newcomers in the replay of
2026-11-20; TOP churn between consecutive builds does not rise.

### A5. Story threads and timelines for running stories

**What and why.** A running story reads as repetition. On 2026-11-20 (04:16Z build) the Nvidia
chief-executive story held three TOP slots plus three more homepage rows, because the running-story
rule (`scripts/pipeline/route/running.ts`) needs a shared core title token and an anchor inside the
TOP window, and the 12-publisher anchor was 80 h old. The closing round split that saga into its
events and tightened the same-subject cap, which left 10 homepage stories naming the subject and 2
TOP slots (defect KD-9); the fold itself still applies to TOP only. The data to group them exists
(`Placements.topRelated`) but is not published: `EditionFront.topRelated` was rejected for
first-paint bytes and for having no consumer. A thread gives the reader one row plus "story so
far", and gives the pipeline a memory longer than the TOP window.

**Starts in.** `scripts/pipeline/route/running.ts`, `route/top.ts`;
`scripts/pipeline/types.ts` (`PipelineState`, `Placements.topRelated`);
`scripts/pipeline/state/store.ts` (`parseState`, `nextState`); `scripts/pipeline/emit/edition.ts`;
`shared/contract.ts` (`EditionRest`); `src/features/home/TopStories.tsx`;
`src/features/headline/HeadlineRow.tsx`.

**Sketch.**

1. State: `PipelineState.threads?: ThreadMemory[]` = `{ anchorId, core: string[], vocabulary:
   string[], firstAt, lastAt, memberIds }`, kept 7 days after the last new member, parsed
   defensively like `top`.
2. Matching: a new story joins a thread when it passes today's follow-up test against the
   remembered core and vocabulary, so the anchor no longer has to be inside the 72 h window.
3. Missing core token (the Nvidia case): allow a join through shared vocabulary alone when the
   story shares 2 publishers' worth of named entities with the thread; calibrate with A3 and ship
   only at 0 false joins on the labelled days.
4. Publish in `rest.json`, not `front.json`: `threads: Record<leadId, { title, items: [id, title,
   sourceIdx, atMs][] }>`, capped at 20 entries per thread.
5. TOP and homepage: one row per thread unless a follow-up has 5 publishers of its own
   (`ROUTE_POLICY.runningStory.independentPublishers`, unchanged). The row shows "+N developments".
6. Client: route `#/t/<leadId>` with the entries newest first, grouped by day. Reuse `Rows` and
   `Page` from `src/features/export/kit/Page`.
7. `npm run explain` prints the thread a story joined and the tokens that matched.

**Effort** L. **Risk** Medium: a false join hides an unrelated story about the same company behind
another row; the thread page must list every member so nothing is lost. **Depends on** A3.

**Verify.** Replay of 2026-11-20: the Nvidia stories occupy at most 2 TOP slots; the three Anthropic
IPO follow-ups stay folded; 0 false joins on labelled pairs; `rest.json` grows by less than 3 KB
gzip; `front.json` is unchanged in size.

### A6. Regulatory tracker with deadlines on the POLICY desk

**What and why.** The reader works under SEC and FINRA rules and watches the EU AI Act. A feed
shows a notice once; what matters afterwards is the date it takes effect or the day comments close.
Today a notice gets a homepage row for 72 h (`ROUTE_POLICY.regulatorFloor`) and then leaves. A
small, hand-verified list of dates, shown at the top of POLICY, is the missing piece. Dates must
come from the primary document, never from a model or a headline.

**Starts in.** New `scripts/registry/deadlines.ts`; `scripts/registry/index.ts` (validation
pattern of `validateRegistry`); `scripts/pipeline/emit/` (new emitter beside `sourcesFile.ts`);
`shared/contract.ts`, `shared/guards.ts`; `src/features/section/SectionPage.tsx`;
`scripts/pipeline/emit/quality.ts` (`GATE`).

**Sketch.**

1. Data: `DeadlineDef { id, regulator (publisher id), title, kind: "effective" | "comments-close" |
   "compliance" | "hearing", date (YYYY-MM-DD), url (primary document), relatedSourceId?, addedAt,
   verifiedAt, note? }`. No entry without a primary-document URL.
2. Validation: date parses, URL is https, regulator is a registry publisher, `verifiedAt` not in
   the future.
3. Emit `deadlines.json` (lazy file): entries from 30 days past to 365 days ahead, sorted by date.
4. Gate warnings (never failures): an entry whose `verifiedAt` is older than 90 days; an entry
   dated more than 30 days ago that is still in the file.
5. Suggestions, not automation: a tool `npm run deadlines:suggest` scans the last build's items
   from sources tagged `regulator` for date phrases ("comments due", "effective", "compliance
   date") and prints candidate rows for a person to verify and paste. It never writes the data file.
6. Client: an "Upcoming dates" block at the top of `#/s/policy` (date, days remaining, regulator,
   title, link), and one line "Next: ..." in the POLICY column on the homepage if it fits without a
   layout shift.
7. Add the list to the briefing export (`src/features/export/briefing.ts`) under its own heading.

**Effort** M (code) plus owner time to enter and verify the first entries. **Risk** Medium: a wrong
or stale date on a compliance page is worse than no date. Mitigations are steps 1 and 4 and a
visible "verified <date>" on every row. **Depends on** none.

**Verify.** A registry test rejects an entry without a primary URL; the gate warns on a stale
`verifiedAt` in a test fixture; the POLICY page renders the block from the fixture; no date in the
shipped file lacks a `verifiedAt` within 90 days.

### A7. Model-release ledger

**What and why.** Model releases are a stated priority and the weakest structured area: Qwen4-Max,
the reader's primary local model family, never reached a homepage row on 2026-11-20 (MODELS #19 in
the closing build). A headline list cannot answer "what shipped this month, are the weights open, under which
licence, what context, what price". A ledger is a table with those columns, built from the items
the pipeline already has, with each cell traceable to a source.

**Starts in.** `scripts/pipeline/score/importance.ts` (launch and versioned-model signals);
`scripts/pipeline/cluster/similarity.ts` (`productsOf`, versioned product parsing); registry
sources `hf-qwen-models`, `hf-unsloth-gguf`, `hf-trending-models`, `ollama-library-newest`,
`openrouter-new-models`, the 37 `github-release` feeds; `scripts/pipeline/state/store.ts`;
`shared/contract.ts`.

**Sketch.**

1. Type `LedgerEntry { key, name, lab, firstSeenAt, announcedAt?, openWeights: boolean | null,
   licence?, contextTokens?, priceIn?, priceOut?, storyId?, links: { label, url }[], sources:
   SourceId[] }`. `null` and absent mean "unknown" and render as "-".
2. Candidates: stories homed or routed to MODELS whose importance carries the versioned-model
   signal; the name comes from `productsOf` on the lead headline.
3. Enrichment, each optional and each recorded in `sources`: open weights and licence from the
   Hugging Face model API for a matching repository; context and price from the OpenRouter models
   API. Which fields those two APIs return is not verified here; save one response of each and
   write the parser against it.
4. Memory: `PipelineState.ledger`, 90 days, keyed by normalized name + version; a later item may
   fill an empty cell but never overwrites a filled one without the old value being logged.
5. Manual overrides in `scripts/registry/ledger-overrides.ts` (reviewed, win over automation).
6. Emit `ledger.json` (lazy). Route `#/ledger`: sortable table, filter "open weights only", link to
   the story row. Link it from the MODELS and LOCAL section headings.
7. Gate: size line; warning when the newest entry is older than 14 days.

**Effort** L. **Risk** Medium: a wrong licence or price misleads; show the source of each cell on
hover and prefer "-" to a guess. Two more external APIs become build inputs (add them to the SBOM
services list in `scripts/generate-sbom.ts`). **Depends on** none; A3 helps to test name matching.

**Verify.** Replay of 2026-11-20 lists Gemini 4 Neon, GPT-6.2, Genie 4 and Qwen4-Max as separate
rows; no cell is filled without a source id; `npm run sbom -- --check` passes after the services
list is updated; the page renders from the fixture.

### A8. Brief as its own step: pluggable provider, grounding check, injection tests

**What and why.** Four open items meet here. (1) The model-written brief has never run: every build
was keyless, so the request, reply validation and the six-failure alert are covered by tests only.
(2) Ingest and the brief share one Node process, so the API key is in memory while third-party
feeds are parsed (SEC-7, open). (3) There is no grounding check on the brief's text (SEC-2, open);
a lexical check was measured and rejected because it rejects legitimate paraphrase. (4) The owner
runs local models and prefers that no cloud key be needed. A separate brief step with a provider
interface solves 2 and 4 and makes 1 and 3 testable.

A constraint to design around: GitHub-hosted runners cannot reach an endpoint on the owner's
network, and a self-hosted runner on a public repository is not acceptable (see "Not recommended").
The local provider therefore runs on the owner's machine and hands its result to CI, which
re-validates it.

**Starts in.** `scripts/pipeline/enrich/brief.ts` (`BRIEF_MODEL`, `buildBriefRequest`,
`checkBriefReply`, `createMakeBrief`), `briefInput.ts` (`briefStories`), `briefFallback.ts`;
`scripts/pipeline/run.ts`; `shared/contract.ts` (`BriefFile.source` is `"claude" | "fallback"`),
`shared/guards.ts`; client readers of `brief.source` (`src/features/home/DailyBrief.tsx`,
`homeModel.ts`, `src/features/about/model.ts`, `AboutPage.tsx`); `refresh.yml`;
[DEPLOYMENT.md](./DEPLOYMENT.md) section 11.

**Sketch.**

1. Split: `scripts/pipeline/brief-step.ts` reads the written `front.json` and `rest.json`, builds
   the stories with `briefStories`, calls a provider, validates, and rewrites `brief.json` and the
   brief block of `status.json`. `run.ts` always writes the deterministic brief. In `refresh.yml`
   the key is given to this step only.
2. Provider interface `BriefProvider { id, model, call(request): Promise<reply> }` with two
   implementations: the existing Anthropic request, and `openai-compatible` (`POST
   <BRIEF_ENDPOINT>/v1/chat/completions` with a JSON-schema response format; llama.cpp server,
   Ollama and vLLM all expose this path; the exact schema parameter each accepts is not verified).
3. Contract: widen `BriefFile.source` to `"claude" | "local" | "fallback"` (or a single `"model"`),
   keep `model` as the audit field, update the guard and the five client reads in one commit.
4. Local hand-over: a job on the owner's machine (same pattern as `scripts/kick-refresh.sh`) reads
   the live `front.json`, writes a candidate brief and pushes it to a branch (for example
   `enrich`). The CI brief step treats it as untrusted input: it runs `checkBriefReply` against the
   current build's stories and uses it only if every citation is still in today's input.
5. Grounding check, two parts: (a) deterministic: every number, version and quoted string in a
   bullet must occur in the titles or summaries of the stories that bullet cites (not in all
   stories), with a small allowance list measured on real output; (b) a second pass by the same
   provider that answers, per bullet, "supported / not supported" in schema-constrained JSON.
   Either failing drops the brief with `fallbackReason: "ungrounded"`.
6. Prompt-injection tests: a corpus of hostile titles and summaries
   (`test/fixtures/injection/*.json`: instruction text, fake delimiters, link planting, role
   claims). Offline tests assert the request escapes them (`promptJson`) and that a reply obeying
   any of them fails validation. An opt-in live run (`npm run brief:redteam`, needs a key or an
   endpoint, never in CI by default) records the pass rate per provider and model.
7. First keyed run: read the warning in `brief.ts` about the `thinking` field before changing
   `BRIEF_MODEL`; check `status.json` `.brief` after the first build (DEPLOYMENT.md section 11).

**Effort** L. **Risk** Medium: a local model that writes a fluent but wrong bullet is the failure
to design against; the checks in step 5 fail closed (no brief shown). The hand-over branch needs a
write credential on the owner's machine: use a fine-grained token limited to that repository's
contents and protect `main` so the token cannot change code that runs with secrets. **Depends on**
A1 (workflows must have run once).

**Verify.** `ps`-level proof is not needed: a test asserts `run.ts` never reads
`ANTHROPIC_API_KEY`; the injection corpus passes offline; one live build shows `brief.source` not
`fallback`, a model id in `brief.json`, and `status.json` `.brief.failStreak` absent or 0; a
hand-edited candidate brief citing a URL not in today's input is rejected by the CI step.

### A9. Archive: "yesterday" and browse by date

**What and why.** A reader who was away for a day cannot see what the page looked like. `#/new`
shows items since the last visit, not "the top stories of Tuesday". Phase 1 needs no pipeline
change: `river.json` already holds 7 days of every item that passed relevance, with a `leadId` per
row. Phase 2 keeps a durable daily record, which also feeds the digest (B2) and the audit trail
(D3).

**Starts in.** Phase 1: `shared/select.ts` (`riverRows`, `collapseStories`), `shared/time.ts`,
`src/features/new/` (closest existing page), `src/app/routes.ts`. Phase 2:
`scripts/pipeline/emit/write.ts`, `shared/contract.ts`, `.github/workflows/refresh.yml` (restore
and persist steps), [DEPLOYMENT.md](./DEPLOYMENT.md) section 4.4.

**Sketch.**

1. Phase 1 (S): route `#/day/<YYYY-MM-DD>`; filter river rows by effective date in the reader's
   time zone, collapse by `leadId`, group by section, newest first. Add "Yesterday" and a 7-day
   strip of day links to the `#/new` page and the footer.
2. Reuse mutes and the row component (`ui.HeadlineRow` with `item`), so no new row code.
3. Phase 2 (M): at the first build after 00:00 UTC, emit `archive/<YYYY-MM-DD>.json` for the day
   that ended: TOP list and each section's homepage rows of the last build of that day, as river
   tuples (no summaries), plus `archive/index.json` (dates and counts).
4. The Pages artifact is rebuilt from scratch on every run, so the archive has to be carried: store
   the `archive/` directory beside `state.json` on the `data` branch and restore it into
   `public/data/v2/archive/` before the build (same steps, same checks).
5. Budget and retention: decide a cap (for example 365 days) and add a gate size line. One day's
   file is not measured; measure it on the first week before choosing the cap.
6. Client: the day route reads the archive file when the date is older than the river.

**Effort** S (phase 1), M (phase 2). **Risk** Low. Phase 2 republishes third-party headlines for
longer than 7 days; keep it to titles and links, as the river does. **Depends on** none for phase
1; A1 for phase 2 (it changes the state hand-over, which has to be proven first).

**Verify.** Phase 1: a page test on the fixture shows the stories of the fixture's previous day and
none from another day; a muted source's rows are absent. Phase 2: two CI runs across midnight UTC
leave one dated file that survives the next deploy.

### A10. "Why is this here" explain panel

**What and why.** The ranking is deterministic and already explained per story by
`npm run explain`, but only at a terminal on the build machine: `run.ts` writes
`node_modules/.tmp/explain.json`, which is not published. A reader who can see "5 publishers,
tier 2 lead, 9 h old, routed to POLICY by the word caucus" trusts the page and reports ranking
defects precisely. It is also the auditability the owner asks of AI-adjacent tooling, with no model
involved.

**Starts in.** `scripts/pipeline/emit/explain.ts` (`buildExplain`, `ExplainStory`);
`scripts/tools/explain.ts` (the text renderer); `scripts/pipeline/types.ts` (`RouteTrace`,
`ScoredStory` parts); `src/features/headline/HeadlineRow.tsx` (row menu),
`src/features/chrome/Dialog.tsx`.

**Sketch.**

1. Emit `why.json` (lazy, placed stories only): per lead id a compact tuple of score parts
   (recency, tier, coverage, importance, hn, fade), publishers, `routedTo` and `rule`, `focus`,
   and the TOP flags (held, folded under).
2. Do not publish dropped items or internal notes; the file describes what is on the page.
3. Guard, invariant (every key is a placed lead id), gate size line.
4. Client: "Why is this here?" in the row's "more actions" menu, opening a dialog in its own lazy
   chunk. Render sentences from the numbers with a pure function shared with the CLI renderer where
   possible.
5. Include what the reader's own settings did: re-led under a mute, hidden by a time chip.
6. Link the dialog to the About page section that explains the score scale.

**Effort** M. **Risk** Low. The file exposes the scoring weights, which are already public in the
repository. **Depends on** none.

**Verify.** `why.json` has exactly the placed lead ids of `front.json` plus `rest.json`; the dialog
text for a fixture story matches `npm run explain -- <id>` on the same build for score parts and
route rule; the entry bundle does not grow.

---

## B. Product

### B1. Installable app and offline reading (service worker)

**What and why.** The reader opens the page many times a day, often on a phone. A service worker
gives an instant shell and the last edition without a network. Today the client keeps a guarded
`sessionStorage` cache of the payloads (`src/data/editionStore.ts`, `CACHE_KEYS`), which does not
survive a closed tab. There is no service worker and no manifest in the tree. V1 removed an unused
PWA plugin for good reason: a bad worker pins readers to a stale page.

**Starts in.** New `public/sw.js` (hand-written; no plugin) and `public/manifest.webmanifest`;
`src/main.tsx` (registration); `vite.config.ts` (CSP: `default-src 'self'` already covers a
same-origin worker and manifest); `src/data/fetchJson.ts`; `src/features/chrome/Banners.tsx`.

**Sketch.**

1. Worker scope = the site base. Precache `index.html` and the hashed entry assets listed in a
   build-generated manifest; never cache `sw.js` itself.
2. Data files: network first with a short timeout, falling back to the cached copy; cache only
   responses that parse and carry a `buildId`.
3. Navigation: serve the cached shell only when the network fails, so a deploy is never masked.
4. Kill switch: the worker fetches `status.json` on activation; a field such as `sw: "off"`
   makes it unregister and clear its caches. Document the switch in DEPLOYMENT.md.
5. The existing stale banner already tells the reader the data is old; add "offline" to its text
   when `navigator.onLine` is false.
6. Register only in production builds and only when not in a foreign frame (the frame guard in
   `src/main.tsx`).

**Effort** M. **Risk** High: a faulty worker is the one client defect that survives a redeploy.
Steps 3 and 4 are the mitigations; do not ship without D1 covering update and offline flows.
**Depends on** A1, D1. On a shared `github.io` origin a worker's scope is limited to the path, but
do A2 first anyway.

**Verify.** Playwright: load, go offline, reload, see the last edition and the banner; deploy a
new build, reload twice, see the new `buildId`; set the kill switch, reload, confirm no registered
worker. Lighthouse installability check passes (manual).

### B2. Daily digest: Atom digest feed, optional e-mail

**What and why.** `public/feed.xml` is a per-story Atom feed (TOP STORIES, then each ai-desk
section's lead, at most 30 entries, `scripts/pipeline/emit/atom.ts`). A once-a-day digest entry
suits a reader who wants one item per morning, and it is the natural input for e-mail. The site
has no server and no accounts, so e-mail must not mean a subscriber list held by this project.

**Starts in.** `scripts/pipeline/emit/atom.ts`, `emit/xml.ts`, `emit/write.ts`;
`src/features/export/briefing.ts` (the Markdown briefing is the same content shape);
`scripts/tools/check-data.ts` (XML checks).

**Sketch.**

1. Phase 1 (S): emit `digest.xml`, one entry per UTC day, written by the first build after a set
   hour: TOP STORIES with outlet counts, one line per priority section, the regulator notices of
   the day, upcoming deadlines (A6). Entry id = the date; content is escaped HTML built from our
   own fields only.
2. Keep the last 14 entries; that needs the previous entries, so store them in state or build them
   from the archive files of A9 phase 2.
3. Gate: well-formed XML, at most 14 entries, no entry dated in the future.
4. Phase 2 (M), e-mail for the owner only: a scheduled workflow sends the day's entry to one
   address held in a repository secret through an SMTP relay the owner already has. No sign-up
   form, no list.
5. Any reader can get e-mail from `digest.xml` with their own feed-to-mail tool; say so on the
   About page instead of building a list.

**Effort** S (phase 1), M (phase 2). **Risk** Low for the feed. Medium for e-mail: a new secret and
an outbound channel from CI; keep it in its own workflow with no other permission. **Depends on**
A9 phase 2 or a small state field.

**Verify.** `digest.xml` validates as Atom; two builds on the same day leave it byte-identical;
the gate fails a hand-made file with 15 entries; the e-mail workflow is skipped when the secret is
absent.

### B3. Mute and watch rules per section

**What and why.** Mutes are all-or-nothing today: `MuteSet` holds muted sources and muted sections
(`shared/select.ts`), and the watchlist is one flat list of terms (`WatchlistState`). The reader
cannot say "mute this vendor blog everywhere except AI SECURITY", "hide rows with this word in
MARKETS & DEALS", or "watch 'Rule 2210' only in POLICY".

**Starts in.** `shared/select.ts` (`MuteSet`, `isMuted`, `visibleStory`); `src/state/mutes.ts`,
`src/state/backup.ts`, `src/state/migrateV1.ts`; `src/app/services.ts` (`MutesState`,
`WatchlistState`); `src/features/settings/`, `src/features/watch/`, `src/features/sources/`.

**Sketch.**

1. Extend `MuteSet` with `rules: MuteRule[]`, `MuteRule = { source?: SourceId; term?: string;
   sections?: SectionId[]; except?: SectionId[] }`. Keep `sources` and `sections` so stored state
   and backups stay readable.
2. `isMuted(article, mutes, sectionId?)`: callers that know the section pass it; TOP STORIES and
   search apply only rules without a section.
3. Term rules use `compileTerms` from `shared/text.ts` (word-boundary, no regex from user input).
4. Watch terms gain an optional `sections` scope; `matcher()` takes the section.
5. Backup format: additive field; `previewJson` reports rule counts; old backups import unchanged.
6. UI: in the Sources page row and the row's mute menu, "Mute here only" and "Mute everywhere
   except here"; a rule list with remove buttons in Settings.

**Effort** M. **Risk** Low; the invariant "mutes never change a story's key" must hold, and a
story must still be re-led rather than removed when another outlet covers it. **Depends on** none.

**Verify.** Tests: a source muted except in `ai_security` is re-led or hidden in every other
section and unchanged there; a term rule scoped to `money` does not affect TOP; a V2 backup written
before the change imports with identical state.

### B4. Price context in the markets ticker

**What and why.** The ticker shows eight symbols with price and percent change against the previous
close (`scripts/pipeline/enrich/stocks.ts`, `STOCK_SYMBOLS`; `StockQuote { price, changePct,
fetchedAt, asOf? }`). A change of 2% means little without the range it sits in. The useful context
is relative: volume against its average and the position in the 52-week range.

**Starts in.** `scripts/pipeline/enrich/stocks.ts` (`parseYahooChart`); `shared/contract.ts`
(`StockQuote`), `shared/guards.ts`; `src/features/chrome/StockTicker.tsx`.

**Sketch.**

1. Save one chart response per symbol and read its `meta` block. Which fields it carries (volume,
   52-week high and low) is not verified; do not add a second request per symbol without measuring
   the rate limit (parallel requests were rejected on 2026-11-20).
2. Add optional fields only: `volRatio?` (today's volume over the average, one decimal) and
   `rangePos?` (0 to 1 inside the 52-week range).
3. Render as the `title` of the quote and as a small marker for a volume ratio above 2; the band
   height must not change.
4. Add `stocksStatus: LoadStatus` to `EditionState` in the same change, so the band can reserve its
   space while loading (defect KD-36).
5. Keep the "market closed" labelling (`marketState`) as it is.

**Effort** S. **Risk** Low; the source is an unofficial endpoint that can change shape, which the
parser already tolerates (a symbol that fails is a null quote). **Depends on** none.

**Verify.** Parser tests on the saved responses; the guard accepts files with and without the new
fields; `stocks.json` stays under 2 KB.

### B5. A "cyber" edition from the same engine

**What and why.** The engine is not AI-specific: sections, registry, relevance terms and route
rules are data. The registry already holds 31 sources homed in CYBER WIRE and 46 in AI SECURITY. A
second edition with cyber as the main desk and AI as a side wire would serve the reader's other
daily need from one codebase. V1's roadmap had the same idea as a clone; do it as a configuration,
not a fork.

**Starts in.** `shared/sections.ts` (the only declaration of sections and desks);
`scripts/registry/index.ts`; `scripts/pipeline/relevance/aiTerms.ts` (the gate);
`scripts/pipeline/route/rules.ts`; `scripts/pipeline/context.ts` (`ENV`); `vite.config.ts`.

**Sketch.**

1. Introduce an edition profile: `EditionProfile { id, title, sections, deskOf, gateTerms,
   routeRules, stockSymbols, siteUrl }`. The current constants become the `ai` profile; nothing
   else changes in the first commit.
2. Thread the profile through `createContext` (an `EDITION` environment key) instead of importing
   `SECTIONS` directly in stages. The boundary test already forbids stage-to-stage imports; add
   one that forbids reading `SECTIONS` outside the profile.
3. Write the `cyber` profile: sections such as threats, vulnerabilities, incidents, defence, policy,
   AI security, vendor research; a gate on security terms; its own route rules.
4. Client: the profile's section list and title come from `front.json`, which already carries all
   sections; remove the remaining hard-coded section ids in presets and tests.
5. Build and deploy as a second site (own `SITE_URL`, own state, own `data` branch or directory).
6. Storage namespace per edition (`aid2:` today), so two editions on one origin never share state.

**Effort** L. **Risk** Medium: step 2 touches every stage; do it as a pure refactor with the
fixture output byte-identical before writing the second profile. **Depends on** A1.

**Verify.** With the `ai` profile the fixture round trip (`test/contract.test.ts`) is unchanged;
the `cyber` profile builds, passes the gate with its own thresholds, and shares no storage key
with the `ai` edition.

---

## C. Pipeline quality

### C1. Local relevance classifier as a second opinion

**What and why.** The relevance gate is term-based (`scripts/pipeline/relevance/aiTerms.ts`).
Measured on 2026-11-20 on 877 gated items: precision 85% strict (92% lenient) on a 60-item sample
of passes, recall about 99%. The remaining false positives resist rules (a chip maker's name on a
quantum headline, event recaps, a market roundup). A small local model can label the borderline
band. It must not become the gate: the build has to stay deterministic and runnable without any
model.

**Starts in.** `scripts/pipeline/relevance/index.ts` (`filterRelevance`, drop reasons),
`relevance/corpus.test.ts`; the provider of A8; `scripts/pipeline/state/store.ts`.

**Sketch.**

1. Define the borderline band from existing signals: passed on a summary-lead match only, or on a
   single weak term.
2. Offline labelling job on the owner's machine: send title and summary of borderline items to the
   OpenAI-compatible endpoint with a fixed prompt and a JSON schema `{ onBeat: boolean, section?:
   SectionId, confidence }`; temperature 0; record model id and prompt hash.
3. Store verdicts keyed by article id in a file handed to CI like the brief candidate of A8; CI
   uses a verdict only for ids in today's borderline band.
4. Effect is one-directional at first: a confident "off beat" demotes the item to river-only; the
   model never promotes an item the rules dropped.
5. `npm run explain` prints the verdict, the model id and the prompt hash.
6. Measure with A3 against hand labels before enabling; keep a switch in `PIPELINE`.

**Effort** M. **Risk** Medium: a silent model change shifts the page; the recorded model id and
prompt hash, the one-directional effect and the switch bound it. **Depends on** A3, A8.

**Verify.** On labelled days precision of the pass sample rises with 0 labelled on-beat items
demoted; with the verdict file absent the build output is byte-identical to today's.

### C2. Embeddings-based clustering computed at build time

**What and why.** Token similarity cannot merge two reports that share almost no words. The China
chip sales pair (FT, Reuters) has cosine 0.24, and a false pair at the same cosine shares more
units, so no token rule separates them. Sentence embeddings can. The cost is a model in the build:
either the owner's endpoint (not reachable from CI) or a small model run inside CI (a new
dependency and a model download, both supply-chain items).

**Starts in.** `scripts/pipeline/cluster/similarity.ts` (`CLUSTER`, `corroborated`),
`cluster/index.ts`; `scripts/pipeline/state/store.ts`; the provider of A8.

**Sketch.**

1. Use embeddings only as a third pass, like `corroborated`: pairs between 0.22 and the cosine bar,
   within 24 h, across publishers. The first two passes stay as they are.
2. Vectors come from `POST <endpoint>/v1/embeddings` on the owner's machine, cached by article id
   in a file handed to CI (the pattern of A8 and C1). An item without a cached vector is simply not
   considered, so a missing file changes nothing.
3. Merge rule: embedding cosine above a bar chosen with A3 at 0 false merges on labelled pairs,
   and the existing product veto still applies.
4. Record the embedding model id in `status.json`; a change of model invalidates the cache.
5. Alternative for CI-only operation: a small ONNX sentence model run in Node. It needs a runtime
   dependency in the pipeline and a pinned, hashed model file; evaluate only if the hand-over
   pattern proves too fragile.
6. `npm run explain` shows which pass merged a pair.

**Effort** L. **Risk** High: false merges hide stories, and embeddings fail in ways token rules do
not (two launches on one day look alike). Ship only with the labelled set of A3 at 7 days or more.
**Depends on** A3, A8.

**Verify.** `npm run evaluate`: recall on labelled same-story pairs rises, false merges stay at the
known baseline, the Gemini 4 Neon and Genie 4 stories stay separate; without the vector file the
cluster output is unchanged.

### C3. Per-source reliability score that proposes tier changes

**What and why.** Tier (1 to 4) is the largest hand-set input to the score (`SCORE.tierBase`: 30 /
20 / 10 / 0) and it was assigned once, during curation, for 414 sources. 87 are tier 4 and 12 are
on `probation`. The state already records health per source, but not how useful a source is. A
rolling record would show which tier-3 sources lead multi-publisher stories first and which tier-2
sources are mostly dropped as noise. The tier itself stays a reviewed constant in the registry.

**Starts in.** `scripts/pipeline/state/store.ts` (`nextState`); `scripts/pipeline/types.ts`
(`PipelineState`); `scripts/pipeline/emit/health.ts`; `scripts/tools/gen-sources-doc.ts`;
`src/features/sources/`.

**Sketch.**

1. `PipelineState.sourceStats`: per source, 30 daily buckets of `{ fetched, kept, droppedNoise,
   droppedOffTopic, placed, ledMulti, firstInStory, failures }`.
2. Derived measures: keep rate, noise rate, "first to report" share in multi-publisher stories,
   lead share, availability.
3. Tool `npm run sources:report`: a table of sources whose measures disagree with their tier
   (thresholds in one constant), with the evidence, and of `probation` sources that were OK for N
   days. It prints proposals; a person edits the registry.
4. Show availability and keep rate on the Sources page from `health.json` (two small numbers per
   row; check the 4.4 KB gzip size line).
5. Feed-audit workflow: attach the report to the weekly run summary.

**Effort** M. **Risk** Low; nothing changes rank automatically. State grows: measure the bytes (the
file is 3.31 MB today; `scripts/pipeline/emit/write.ts` refuses to write one above 24 MB). **Depends on** A1, because the measures
need days of real state.

**Verify.** After 7 days of builds the report lists at least the 12 `probation` sources with their
availability; removing a source from the registry removes its stats; state size growth is recorded.

### C4. Link-rot and paywall detection

**What and why.** Two gaps. (1) The paywall flag is set only from the source tag `paywalled`
(`scripts/pipeline/normalize/index.ts`), so an article that reaches the page through a link-host
source (Google News query, Techmeme, an HN search) is not flagged. In the build of 2026-11-20
04:16Z, 7 of 49 articles on six well-known subscription hosts carry no flag (4 on `wsj.com`, 3 on
`bloomberg.com`). (2) Link checking exists as a manual tool (`npm run check:links -- --data`
sampled 292 article URLs: 0 broken, 72 blocked by bot walls) but nothing acts on a dead article
link.

**Starts in.** `scripts/registry/types.ts` (`PublisherDef` has `id`, `name`, `hosts` only);
`scripts/registry/publishers.ts`; `scripts/pipeline/normalize/index.ts`;
`scripts/tools/check-links.ts`; `.github/workflows/feed-audit.yml`.

**Sketch.**

1. Add `PublisherDef.paywall?: "hard" | "metered"`. Normalize sets the `paywall` flag when the
   item's resolved publisher has it, whatever source carried the item. Keep the source tag working.
2. Fill the field for the publishers whose own feeds are tagged `paywalled` today (28 sources of
   23 publishers), then for the hosts found by the measurement above.
3. Registry test: a source tagged `paywalled` whose publisher lacks the field fails.
4. Link rot: run `check:links -- --data` in the weekly audit and add its "broken" list to the run
   summary. Treat "blocked" as unknown, never as broken.
5. Optional, measured first: a river row whose URL answered 404 or 410 in two consecutive weekly
   checks is dropped from the river memory.
6. Fix the checker gaps in the same change: check relative Markdown links, and do not report a
   POST-only API endpoint as broken (defect KD-31).

**Effort** M. **Risk** Low. Do not fetch article pages during the 30-minute build; it would
multiply outbound requests and trip bot walls. **Depends on** none.

**Verify.** Replay of the 04:16Z build: 0 unflagged articles on hosts of publishers marked
`paywall`; the weekly audit summary shows a "broken article links" count; the link checker reports
a deliberately broken relative link in a test fixture.

### C5. Section list rules: same-subject tail and recency-only rows

**What and why.** Two measured defects of section lists. (1) MARKETS & DEALS read as an IPO page on
2026-11-20 (04:16Z build): homepage rows 1 to 3 and 8 of rows 11 to 18. (2) LOCAL #10 was a GitHub
discussion thread and MODELS #6 an OpenRouter catalogue row for an old model, both tier 4, both
placed by recency alone, pushing an on-topic Hugging Face post to #15.

Closing round, same day: `ROUTE_POLICY.subjectCap` went from 6 publishers / 3 homepage rows to
5 / 2, and low-signal rows (display weight 0, or a forum thread) became a last resort on
topic-section homepages, so step 2 below is shipped in that form and both rows of (2) are off the
homepages. Still open: the cap does nothing below the homepage cut (MARKETS & DEALS rows 11 to 18 are all
the IPO or its fallout in the closing build), the last-resort rule is homepage-only, and steps 1,
3, 4 and 5 (defects KD-9, KD-14, KD-15).

**Starts in.** `scripts/pipeline/route/homepage.ts` (`pickHome`), `route/rules.ts`
(`ROUTE_POLICY.subjectCap`, `SECTION_FOCUS`), `route/diversity.ts`, `route/focus.ts`.

**Sketch.**

1. Extend the subject cap to the full list: at most N rows of one subject in any window of 10
   rows; the rest keep their relative order further down.
2. Homepage floor for unsupported rows: a tier-4 single-publisher lead takes a homepage row of a
   topic section only when no row with a tier of 3 or better, or 2 publishers, is waiting inside
   the soft window. It stays in view-all.
3. Give MODELS a section focus like LOCAL's (`SECTION_FOCUS`): a bonus for a versioned model in the
   title from a first-party lab source, so a 4-day-old flagship release outranks a catalogue row.
4. Catalogue rows (`openrouter-new-models`): mark the source `home-only` with the release flag, or
   move its home to RELEASE RADAR; decide by replay.
5. Add the measured cases as route regression tests on the live fixture, selected by property.

**Effort** S. **Risk** Medium: QUANTUM and SAFETY rely on tier-4 leads (13 of 143 homepage rows in
the closing build, 4 of 5 in QUANTUM), so step 2 must apply to topic sections only and must never empty a
section (the gate fails a hollow homepage). **Depends on** A3.

**Verify.** Replay of 2026-11-20: MARKETS & DEALS rows 11 to 20 hold at most 3 IPO rows; LOCAL and MODELS
homepage lists have no recency-only tier-4 row while a better row waits; the gate's
hollow-homepage check still passes on every captured day.

---

## D. Operations and security

### D1. Browser tests: Playwright smoke and visual regression

**What and why.** The suite has 2,782 tests and none runs in a browser. Rendering is tested through
server-side rendering and a fake DOM; CSS is tested by computing geometry from the stylesheet. That
left a long list of things nobody has seen (defect KD-1), including the production CSP with
`style-src 'self'`. The navy and gold identity and the Drudge density are deliberate, so visual
drift is a product defect.

**Starts in.** New `e2e/` directory and config; `package.json` scripts; `.github/workflows/ci.yml`;
`test/fixtures/v2/` (`npm run data:fixture` installs deterministic data).

**Sketch.**

1. Owner approves one new dev dependency (`@playwright/test`) and the browser download in CI.
   Regenerate the SBOM.
2. Run against `vite preview` of a production build with the fixture installed and the clock fixed
   (the fixture is one frozen day; inject the time so the stale banner state is deterministic).
3. Smoke flows: load home; no console error and no CSP violation; open a section, search, mute and
   undo, bookmark, keyboard `j` / `k` / `o` after the lazy chunk arrives, briefing dialog, Settings
   backup export and import.
4. Screenshots at 375, 768 and 1280 px, light and dark, for home, a section page, search, Sources,
   Settings. Chromium only at first; store baselines in the repository.
5. Accessibility: tab order through one row, focus ring visible, `prefers-reduced-motion`.
6. CI: a separate job in `ci.yml`, read-only token, no secrets; upload the diff images as an
   artifact on failure.

**Effort** M. **Risk** Low. Screenshot tests are flaky when fonts differ: the page uses Arial,
which is not on Linux runners by default (not verified); pin a metric-compatible font in the test
container or compare on one platform only. **Depends on** owner (dependency approval).

**Verify.** The job fails when a CSS token is changed on purpose and passes on a clean tree three
times in a row; the first run's findings are filed against KD-1.

### D2. Pipeline state off the public site and off the public branch

**What and why.** `state.json` (3.31 MB) holds first-seen times, failure streaks, conditional-GET
validators and last-good items. The final round removed it from the Pages artifact by default
(untested on GitHub) but CI hands it from build to build through the `data` branch of what will be
a public repository, so it is still public ([SECURITY.md](./SECURITY.md) section 3.10). It contains
nothing secret; the exposure is third-party text republished in bulk and a map of what the
pipeline has seen.

**Starts in.** `.github/workflows/refresh.yml` (restore step, `persist` job, `V2_PUBLISH_STATE`);
`scripts/pipeline/state/store.ts`; `scripts/pipeline/run.ts` (`STATE_FILE`, `STATE_URL`);
[DEPLOYMENT.md](./DEPLOYMENT.md) section 4.4.

**Sketch.**

1. Prove today's path first (A1): `data` branch restore, removal from the artifact.
2. Option 1, Actions cache: save `state.json` under a key with the run id, restore the newest by
   prefix. Caches are not public, but they are evicted after 7 days without access and can be
   evicted under size pressure, so keep the `data` branch as a slower fallback written once a day.
3. Option 2, a private repository as the state store, written with a deploy key scoped to that
   repository. Stronger isolation, one more credential.
4. Option 3, slim the public copy: keep only first-seen ids, health and validators on the branch
   and the last-good items in the cache.
5. Whichever is chosen, keep the invariant that a build with no state is safe (it re-stamps
   first-seen times and is reported as `state_lost`).
6. Stop writing `state.json` under `public/`: default `STATE_FILE` to a path outside it so a local
   `dist` no longer contains it (4.56 MB today, 1.26 MB without).

**Effort** M. **Risk** Medium: a state store that silently fails makes every item "new" on every
build; the `state_lost` alert exists for that. **Depends on** A1.

**Verify.** After the change: the deployed site and the public branch hold no last-good items; two
consecutive runs report "State restored"; deleting the store produces one `state_lost` report and a
clean recovery; local `npm run build` output contains no `state.json`.

### D3. AI-use audit trail: one record per build

**What and why.** The owner's rule is that AI use must be auditable. Today `brief.json` carries the
model id and `status.json` the outcome, but each build overwrites the last, and the stories the
model was given are not kept. Once a model writes the brief (A8), a reviewer should be able to
answer "what did the model see and what did it write at 14:07 on a given day".

**Starts in.** `scripts/pipeline/enrich/brief.ts` (`buildBriefUserMessage`, `checkBriefReply`);
the brief step of A8; `.github/workflows/refresh.yml` (artifacts); [SECURITY.md](./SECURITY.md)
section 7.

**Sketch.**

1. The brief step writes `brief-audit.json`: build id, provider, model id, prompt hash, the story
   list sent (ids, titles, URLs), the raw reply, the validation result with the reason, token
   usage, and the grounding verdicts.
2. Upload it as a workflow artifact on every keyed build. Retention is the repository's artifact
   retention setting (not verified; set it deliberately).
3. For a durable record, append a one-line summary per build (hashes, model, outcome) to a file
   carried with the archive of A9 phase 2.
4. Never put the audit file in the Pages artifact: it holds the full prompt.
5. Add the same record for C1 and C2 verdict files (model id, prompt hash, counts).

**Effort** S. **Risk** Low. **Depends on** A1, A8.

**Verify.** A keyed build produces the artifact; its story list equals `briefStories` of that
build; the Pages artifact does not contain it; a fallback build records the reason code.

### D4. Entry bundle: prerendered shell

**What and why.** The entry script is 108.20 kB gzip against an 85 kB target. The React runtime is
about 67.5 kB of it and the app's first-paint code about 39 kB, so the target cannot be met by
moving more code out. The honest options are a prerendered shell, so the first paint does not wait
for the script, or a lighter renderer.

**Starts in.** `src/main.tsx`, `src/app/AppShell.tsx`; `vite.config.ts` (HTML transform, CSP
hash); `src/features/export/kit/ssr.testkit.ts` (server rendering already works under Node for
tests); `scripts/pipeline/emit/write.ts`.

**Sketch.**

1. Measure first with D1: time to first headline on a throttled phone profile, today.
2. Prerender at data-build time: render the home route to HTML from `front.json` with
   `react-dom/server` and write it into `index.html` inside the root element.
3. The page is rebuilt every 30 minutes by the same workflow, so the HTML is as fresh as the data.
   Reader settings (theme, hidden sections, mutes) apply at hydration; keep the no-flash theme
   script.
4. Hydrate instead of render; any mismatch between the build clock and the reader's clock ("3h
   ago") must be handled by rendering times after hydration.
5. CSP: prerendered markup carries no inline style or script, so the policy is unchanged; the
   `pageBuild` test must still pass.
6. Alternative, larger: replace React with a lighter compatible renderer. Evaluate only if step 2
   does not reach the goal; it changes a browser runtime dependency.

**Effort** L. **Risk** Medium: hydration mismatches are subtle, and `index.html` becomes a build
output of the data pipeline rather than of the site build. **Depends on** D1.

**Verify.** First headline visible before the entry script finishes on a throttled profile; no
hydration warning in the console; `dist/index.html` still has one module script and the CSP meta.

### D5. Supply-chain checks in CI: SBOM schema, signatures, action pins

**What and why.** Three gaps recorded by the final round. `docs/SBOM.json` (CycloneDX 1.6, 132
components) is not validated against the official schema. `npm audit signatures` passed locally
for the 59 packages installed on macOS; the lockfile lists 125, and the other 66 are platform
binaries never checked on the platform that runs the builds. Six optional components carry no
integrity hash. The mapping of action commit SHAs to the version tags in the comments is not
checked.

**Starts in.** `scripts/generate-sbom.ts`; `.github/workflows/feed-audit.yml` (the weekly audit
already runs `npm audit` and an SBOM step); `.github/dependabot.yml`.

**Sketch.**

1. Add `npm audit signatures` to the weekly audit on Linux and to `ci.yml`.
2. Vendor the CycloneDX 1.6 JSON schema file with its hash and validate `docs/SBOM.json` in a
   test. That needs a JSON-schema validator: either a dev dependency (owner approval) or a check
   of the required fields and enums in plain code, which the tests partly do already.
3. Make `npm run sbom -- --check` blocking in `ci.yml` (it is a warning in the weekly audit).
4. For the six components without a hash, record why in the SBOM property (bundled inside another
   package's tarball) so a reader does not take it for an omission.
5. Action pins: a weekly step that resolves each pinned SHA through the GitHub API and compares it
   with the tag named in the comment.

**Effort** S. **Risk** Low; a red audit on an upstream signature problem is the intended outcome.
**Depends on** A1.

**Verify.** CI fails when `package-lock.json` changes without `npm run sbom`; the weekly run prints
the signature count for the Linux install; a deliberately wrong SHA comment is reported.

### D6. Ingest timing and trend in `status.json`

**What and why.** Two builds 42 minutes apart with no failure took 14.7 s and 30.8 s to ingest; the
closing build an hour later took 19.2 s.
`github.com` serves 45 sources through one host queue, the Washington Post feed takes about 10 s
every build, and the log has no timing line for the Google News resolver, so its share is unknown.
Without a trend the first sign of a slow source is a step timeout (the "Build data" step of
`refresh.yml` has a 14-minute timeout).

**Starts in.** `scripts/pipeline/ingest/index.ts`, `ingest/pool.ts` (host queues, `HostBackoff`),
`ingest/googleNews.ts`; `scripts/pipeline/run.ts` (`formatStageTable`);
`scripts/pipeline/emit/status.ts`.

**Sketch.**

1. Log one line per ingest phase: source fetches, wrapper resolution, HN signal, each with wall
   time and request count.
2. Write `status.run.stages` (stage name to milliseconds) and the three slowest sources into
   `status.json` (ops file, small).
3. Keep a short history (last 48 builds of total and ingest seconds) in state and print the
   median and the maximum in the run summary.
4. Gate warning when ingest exceeds 3 times the stored median.
5. Review the `github.com` queue: release feeds and commit feeds could use conditional requests
   more aggressively or a second host key for `api.github.com`; measure before changing.
6. Extend host backoff to the resolver only after its timing is known.

**Effort** S. **Risk** Low. **Depends on** none.

**Verify.** A build log shows the three phase lines; `status.json` validates with the new fields;
a test with a slow fake source produces the warning.

---

## E. Sources

### E1. Monthly re-validation of the reserve backlog (source suggestions)

**What and why.** [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) section 6 lists 274 validated feeds
that were not added, by section, with the reason for each. They were checked once, on 2026-11-19,
from one workstation. Feeds die and blocked feeds open. A monthly job that re-checks the reserve
and proposes the best candidates per coverage gap turns a one-off research pass into a pipeline.
The standing rule (SOURCE_RESEARCH.md section 12) is that a feed is validated before it is added.

**Starts in.** `scripts/tools/validate-feeds.ts` (takes a candidates file as its positional
argument; see the file header for the format), `scripts/tools/feedVerdict.ts`,
`scripts/tools/import-sources.ts`, `scripts/tools/report-feed-audit.ts`;
`.github/workflows/feed-audit.yml`; SOURCE_RESEARCH.md sections 6, 11 and 12.

**Sketch.**

1. Move the reserve into a data file in the repository (`scripts/registry/reserve.json`: name, URL,
   proposed section, reason class, last verdict, last checked). SOURCE_RESEARCH.md stays the
   narrative; its section 6 could then be generated from the file.
2. Monthly scheduled job: run the validator on the reserve from CI egress and write verdicts back
   as an artifact.
3. Rank candidates: verdict OK, fresh, AI yield under the gate (replay the feed's items through
   `filterRelevance`), and whether the proposed section is under-served (rows from tier 3 or
   better in the last 30 days, from C3).
4. Output: one rolling issue "Source suggestions" with at most 10 candidates, each with the exact
   registry entry to paste and the evidence. A person adds sources; the job never edits the
   registry.
5. Dead reserve rows are marked, not deleted (SOURCE_RESEARCH.md section 9 exists so nobody
   researches them again).
6. Give the issue lookup a bot-author filter from the start, as `scripts/tools/report-feed-audit.ts`
   has since the closing round.

**Effort** M. **Risk** Low. Outbound requests to about 274 hosts once a month from CI; keep the
build's own client and per-host gaps. **Depends on** A1.

**Verify.** A run on the current reserve reproduces the 2026-11-19 verdicts within the expected
transient differences; the issue body stays under the size budget (`ISSUE_BODY_BUDGET`); no file
under `scripts/registry/sources/` changes.

### E2. Chinese-language lab sources through translation

**What and why.** Chinese labs matter to this reader (the primary local model family is Qwen), and
their first announcements are often in Chinese on pages without an English feed. The registry
covers them through English channels: `hf-qwen-models` (Hugging Face API), English-language
newsletters, and query feeds. SOURCE_RESEARCH.md appendix A.2 holds the scout's notes, including
verified English runners-up that were cut only for the slot budget. Translation at build time
needs a model, so it follows A8.

**Starts in.** SOURCE_RESEARCH.md appendix A.2 (`china-ai`) and section 8.2 (no-feed pages);
`scripts/registry/types.ts` (`SourceDef`), `scripts/pipeline/normalize/index.ts`,
`normalize/text.ts`; the provider of A8.

**Sketch.**

1. Step 0, no model: promote the English runners-up from appendix A.2 after re-validating them
   (E1), and add Hugging Face organisation queries for other Chinese labs (the per-organisation
   JSON endpoint is already used for Qwen).
2. Add `SourceDef.lang?: string` (default `en`). Normalize keeps `originalTitle` for non-English
   items.
3. Translation job on the owner's machine: title and first sentence only, through the local
   endpoint, cached by article id, handed to CI like the brief candidate. An item without a cached
   translation is held back, never shown untranslated in an English list.
4. Mark translated rows in the data (`flags` gains `translated`) and in the row ("translated"
   label; original title in the hover card).
5. Translated items never lead a story another outlet covers and do not count for coverage until a
   week of measurements says the translations are reliable.
6. Relevance and clustering run on the translated title.

**Effort** L. **Risk** Medium: a mistranslated headline is a false statement on the page; the
label, the original title and the no-lead rule bound it. Source pages in scope must be fetched
politely; several block non-local clients (not verified). **Depends on** A8; E1 for step 0.

**Verify.** Step 0: new sources pass `npm run validate:feeds`. Translation: a hand-checked sample
of 50 translated titles with the error count recorded; a build without the translation file shows
no non-English title anywhere.

### E3. Outlet vouching queue

**What and why.** Since the final round an item whose outlet no registry publisher vouches for is
emitted at tier 4, cannot lead, and does not count for coverage (`scripts/registry/outlets.ts`).
That removed junk outlets from the homepage, and it also lowered two on-beat security stories: the
CISA KEV story fell from 4 counted publishers to 2 (TOP #3 before, #11 in the closing build). The fix for a good outlet is one
publisher entry, but nothing lists which unvetted outlets keep appearing.

**Starts in.** `scripts/registry/outlets.ts` (`OUTLET_DENY`, `UNVETTED_PUBLISHER_IDS`,
`UNVETTED_OUTLET_TAG`, `isVettedPublisher`); `scripts/registry/publishers.ts`;
`scripts/pipeline/normalize/index.ts`; `scripts/tools/explain.ts`.

**Sketch.**

1. Count items tagged `unvetted-outlet` per outlet host in each build; keep 30 days in state.
2. Tool `npm run outlets:queue`: hosts by frequency, with sample headlines, the sections they
   appeared in, and whether they were members of multi-publisher stories.
3. For each host the reviewer chooses: vouch (add a `PublisherDef` with its hosts) or deny (add to
   `OUTLET_DENY` with the evidence the list requires).
4. The four hosts that refuse automated readers (`mlq.ai`, `marketbeat.com`, `fourweekmba.com`,
   `tradersunion.com`) need a person to look at them in a browser and record the evidence.
5. Print the top 10 of the queue in the weekly audit summary.

**Effort** S. **Risk** Low. **Depends on** none.

**Verify.** On the 2026-11-20 data the queue lists the outlets behind the two lowered security
stories; after vouching for them the replay restores their publisher counts; registry tests pass.

### E4. Finance-regulator coverage gaps

**What and why.** POLICY had no SEC row in 30 in the 04:16Z build of 2026-11-20: an SEC item was
river-only and the SEC probe items sat inside a 12-publisher company story. The closing round split
that story and added a POLICY focus bonus, so the SEC inquiry is POLICY #4 and the fireside-chat
item #14; both are outside coverage found by query feeds. No item of the SEC's own feeds
(`sec-press-releases`, `sec-speeches-statements`) is in the edition or the 7-day river (defect
KD-12). SOURCE_RESEARCH.md section 11 lists what is
missing: no direct feed for FDIC, ESMA, FinCEN or NYDFS; FINRA beyond Regulatory Notices; SEC
enforcement releases and risk alerts. `nist` and `cisa` are named in the regulator floor but their
feeds are not tagged `regulator`, so the floor and the +10 score term do not apply to them.

**Starts in.** `scripts/registry/sources/policy.ts`, `finance.ts`, `scrapers.ts`;
`scripts/pipeline/route/rules.ts` (`ROUTE_POLICY.regulatorFloor.publishers`);
`scripts/pipeline/route/rules.test.ts` (the test that pins the inert `nist` / `cisa` state);
SOURCE_RESEARCH.md sections 8.2, 9 and 11.

**Sketch.**

1. Owner decision: tag `nist-ai-news` and `cisa-alerts` as `regulator`, or remove both from the
   floor's publisher list. Either way the list and the tags should agree; update the pinned test.
2. NYDFS industry letters: the scraper was tested by the scouts (section 8.2: 299 titled links);
   add it with an `include` list of AI, cyber and third-party terms.
3. SEC enforcement and risk alerts: need the declared User-Agent path; test from CI egress before
   adding (they may answer differently to a datacenter address).
4. FINRA news releases: the feed parses with defects; a scraper is the realistic route.
5. Check with `npm run explain` why the SEC's own feeds contribute no kept item (include list,
   window or cap) and fix the cause rather than raising a tier.
6. Each new first-party regulator source gets tags `regulator` + `first-party` so the floor and
   the score term apply.

**Effort** M. **Risk** Low; regulator pages rate-limit (FINRA answers 403 or 429 after about 12
rapid requests, per the registry note), so one request per build per host. **Depends on** A1 for
the CI egress tests.

**Verify.** `npm run validate:feeds` passes for each new source; a replay shows an SEC first-party
item on the POLICY homepage within its 72 h floor; the floor's publisher list and the registry
tags agree in the route test.

### E5. Changelogs with fragment links; local-runtime gaps

**What and why.** Several first-party changelogs publish one page with date headings and
`#anchor` links per entry. `canonicalUrl` (`shared/url.ts`) drops fragments, so every entry
collapses into one item and the source cannot be ingested. SOURCE_RESEARCH.md names the Claude
Platform release notes as the one worth a per-source feature and the Unsloth changelog as the first
to promote after it. On the local side, exo has no usable source (releases stale since 2026-04-23,
blog without a feed) and other labs' Hugging Face organisations are not followed.

**Starts in.** `shared/url.ts` (`canonicalUrl`, `urlKey`); `scripts/registry/types.ts`;
`scripts/pipeline/ingest/scrape.ts`; `scripts/registry/sources/local.ts`, `scrapers.ts`;
SOURCE_RESEARCH.md sections 8.2 and 11 (gaps 1, 2 and 8).

**Sketch.**

1. Add `SourceDef.keepFragment?: boolean`. For such a source the item id is derived from URL plus
   fragment, while the stored URL keeps the fragment for the reader.
2. Keep `canonicalUrl` itself unchanged (it is shared with the client and with the HN key); apply
   the option in normalize, where the source is known.
3. Entries with date-only titles need `titleTemplate` (it exists) to build a headline from the
   first sentence.
4. Add the Claude Platform release notes, then the Unsloth changelog, each validated first.
5. exo: add its commit feed with a tight `include` list, or the tested blog scraper (two posts in
   two years, so `low-cadence`).
6. Hugging Face organisations of other labs through the existing `kind: "json"` adapter, capped
   with `maxKept`.

**Effort** M. **Risk** Low; an id scheme change must not re-stamp existing items (only new sources
use the option). **Depends on** none.

**Verify.** A scrape fixture with five anchored entries yields five items with distinct ids; no
existing article id changes in the fixture round trip; the new sources pass `validate:feeds`.

---

## Known defects

58 rows, ranked inside each group, as the tree stood on 2026-11-20 after the closing round (build
`2026-11-20T05:16:55.936Z`). [HANDOFF.md](./HANDOFF.md) section 7 carries the same rows under the
same ids, with the file to open first; change both together.

Severity: H = wrong for the reader or blocks go-live, M = visible or risky, L = minor or by design.
"Source" names the report the defect comes from: I1 to I3 are the three integrators of the final
round, F- the fixer of that area, A- the auditor (ed = editorial, cl = client, ops = operations),
C the closer, W a documentation writer, Ed the documentation editor. "State" says "confirmed" where
the row was re-checked against the tree or the closing build for this document, and "reported"
where it is quoted from the report. Editorial rows describe the closing build and will read
differently on another day.

### Never verified

| # | Sev | Defect | Where | Source | State | Fix or item |
|---|---|---|---|---|---|---|
| KD-1 | H | Nothing was checked in a browser in the fix round or the final round. A smoke check was done after the closing build (dev server, all 13 routes, desktop 1440 px and phone 375 px): every route rendered with no new console errors; that is not a visual QA of the items listed. Untested visually: the lazy keyboard and hover chunk after first paint; the stale, storage-refused and "still trying" banners; italic low-tier titles against upright grey seen titles; the "latest" label; 24 px compact rows; the source-name search group; the "Dim headlines I have seen" switch; the briefing dialog; a re-led row under a mute and its hover card; the "also linked:" label and the "also" button; the TOP STORIES heading; the ticker's focus ring and arrow-key scrolling; CSP `style-src 'self'` with the hover card; the phone layout at 375 px | `src/` | I1, I3, F-shell, F-pages, C | confirmed (no browser run exists) | A1 step 3, D1 |
| KD-2 | H | Nothing has run on GitHub: `refresh.yml`, `feed-audit.yml`, `ci.yml`, state hand-over through the `data` branch, removal of `state.json` from the Pages artifact, the preflight, behaviour on a cancelled run, the alert issues, Dependabot. Ingest from a GitHub runner address is untested as well (bot walls and rate limits differ) | `.github/` | I1, I3, F-ops | confirmed (no V2 repository exists) | A1 |
| KD-3 | H | Nothing has run on Node 24 or on Linux. Every result is Node 26.7.0 on macOS; `.node-version` pins 24 for CI. A clean copy of the tree passes `tsc`, the tests and the site build on the development machine, also with a simulated Actions environment and `TZ=UTC` | `.node-version`, `ci.yml` | A-ops | reported (audit); runtime confirmed | A1 step 4: a draft pull request runs `ci.yml` on GitHub before `V2_DEPLOY=true` |
| KD-4 | H | The model-written brief has never run: the request, the reply validation and the six-failure alert are covered by tests only. `BRIEF_MODEL` carries a warning that the request's `thinking` field is model-specific | `scripts/pipeline/enrich/brief.ts` | I3 | confirmed (`status.json` brief `no-key`) | A8 step 7 |
| KD-5 | H | Ranking and clustering rules are calibrated on one news day. The TOP hold has not been exercised on live data. The running-story fold, the corroborated merge and the product veto rest on 2 to 4 live examples; the closing round's three merge vetoes, the saga split (`CLUSTER.ubiquitousShare` 0.03, on a measured plateau of 0.02 to 0.04) and the TOP recency cap rest on the builds of 2026-11-20 and the 2026-11-19 corpus. Churn at the real 30-minute cadence over 24 h is unmeasured; the evidence is one 42-minute gap (TOP 10 of 12 the same, 134 of 143 homepage rows the same) | `scripts/pipeline/route/`, `cluster/` | I1, I3, F-rank, C | reported | A3, A1 step 7 |
| KD-6 | L | The feed audit and the registry part of the link check were not re-run after the closing round's registry edits (excludes, notes, a removed tag; no URL was changed). The closing build fetched all 413 active sources: 412 OK, 1 carried forward on HTTP 429 | `scripts/registry/` | Ed | confirmed | `npm run validate:feeds`; `npm run check:links` |

### Editorial

| # | Sev | Defect | Where | Source | State | Fix or item |
|---|---|---|---|---|---|---|
| KD-7 | H | An off-beat item from a topic feed is TOP #6 and POLICY #1: "Senate Passes Major Permitting Bill to Speed Up Energy Projects", from `nyt-artificial-intelligence` (`scope: "ai"`, so no term test), routed to POLICY by the one-word title rule "senate". The story is AI-related (another outlet's headline in it says so) but the row shows the headline that does not. "Top White House Cybersecurity Official Is Replaced" (TOP #8, POLICY #3) enters the same way. An AI-term test on the feed was measured and rejected: it would also drop the outage coverage | `registry/sources/press.ts`, `route/rules.ts`, `cluster/index.ts` (`pickLead`) | I3, A-ed, C | confirmed in the closing build | A4 |
| KD-8 | M | A young two-publisher story still reaches TOP. The closing round capped recency at 40 points for stories with fewer than 3 publishers (`PIPELINE.topRecencyCap`), which moved the permitting bill from #3 to #6; two stories 1 to 2 h old with 2 publishers are in TOP | `route/top.ts`, `context.ts` | I3, A-ed, C | confirmed | A4 steps 1, 3 |
| KD-9 | M | Subject concentration is reduced, not solved: 10 of 142 homepage stories name Nvidia or its former chief executive and 7 name Anthropic (11 and 9 before the closing round). The running-story fold applies to TOP only; `ROUTE_POLICY.subjectCap` (5 publishers, 2 rows) is homepage-only, so MARKETS & DEALS view-all rows 11 to 18 are all the IPO or its fallout | `route/running.ts`, `route/homepage.ts` | I3, A-ed, C | confirmed in the closing build | A5, C5 step 1 |
| KD-10 | M | TOP mix for this reader: two AI-security stories, none on local models or financial regulation. Unvetted outlets do not count as coverage, so CISA KEV / LLMjacking shows 2 publishers (TOP #11) and banks / AI-agent liability 2 (AI SECURITY #8) | `registry/outlets.ts`, `registry/publishers.ts` | I1, I3 | confirmed in the closing build | E3 |
| KD-11 | M | Same-event rows that do not cluster, with no safe token rule found: China chip sales (FT at TOP #9, Reuters elsewhere; cosine 0.19 to 0.24, a false pair sits at 0.245); the AI Safety Caucus (The Record at POLICY #5, Politico at #13); the Apple agent pair (0.224); a Google quantum study in RESEARCH and QUANTUM; CISA KEV and its LiteLLM entry (AI SECURITY #2 and #17); the Bank of England twin papers (POLICY #8 and #11). The Palo Alto acquisition shows 1 publisher: the CNBC report is kept but does not join it | `cluster/similarity.ts` | I1, I3, F-rank, A-ed, C | POLICY, TOP and AI SECURITY rows confirmed; the rest reported | C2, A3 step 5 |
| KD-12 | M | `nist` and `cisa` are in the regulator floor's publisher list but inert: their feeds lack the `regulator` tag (a route test pins this). No first-party SEC item is in the edition or the 7-day river; the SEC story on POLICY (#4) is wire coverage found by a query feed | `route/rules.ts`, `registry/sources/policy.ts`, `cyber.ts` | I1, I3 | confirmed | E4 |
| KD-13 | M | Outage reports without an AI term in the title are not routed to AI SECURITY (the closing round's rule needs "outage" plus an AI term); they stay in INDUSTRY, POLICY or the river. No watch preset covers the subject | `route/rules.ts` (`ai_security/outages`) | A-ed, C | reported | A4 step 5; a preset in `src/app/presets.ts` |
| KD-14 | M | MODELS homepage rows 6 to 10 are thin: a leak report, a partnership post, a robotics trade outlet leading the Gemini 4 Hydrogen item instead of the lab, and one of three separate Microsoft MAI product pages (#10, #12, #13; same-origin pages of one launch do not collapse). Qwen4-Max is MODELS #19 and never reached a homepage row | `route/rules.ts`, `route/focus.ts`, `registry/sources/labs.ts` | I3, A-ed, C | confirmed in the closing build | C5 step 3, A7 |
| KD-15 | M | View-all lists still carry low-signal rows: the last-resort rule for display weight 0 and forum threads is homepage-only. AI SECURITY #13 (a tier-4 query item) and #17 (an unvetted outlet) in the closing build; the closer also lists a podcast row, a retraction notice, a non-AI Crunchbase feature and a clinical-AI item in POLICY. A profane title from an HN search is in the 7-day river, so search and the briefing export can surface it | `route/homepage.ts`, `registry/sources/queries.ts`, `relevance/noise.ts` | A-ed, C | AI SECURITY rows confirmed; the rest reported | C5 step 2 extended to the full list; a title rule in `noise.ts` |
| KD-16 | L | Tier-4 leads hold 13 of 143 homepage rows, 4 of the 5 in QUANTUM. QUANTUM has 6 rows in total; its homepage row #5 is 205 h old and row #6 327 h. SAFETY view-all has rows older than 7 days (reported). Section windows were not changed because a shorter list risks the hollow-homepage gate | `shared/sections.ts`, registry tiers | I3, A-ed, C | QUANTUM and the count confirmed | E1 (quantum reserve), C5 |
| KD-17 | L | Old or tangential rows on priority homepages: LOCAL #6 and #9 are 89 h old and #7 is a policy essay routed by "open-weight"; POLICY #7 is led by an 82 h-old headline | `route/focus.ts`, `cluster/index.ts` | F-rank, C | confirmed in the closing build | C5 |
| KD-18 | L | `RIVAL_SUBJECTS`, the closed list of 34 company names behind the rival-company merge veto, needs maintenance: a pair of unlisted companies is not protected | `cluster/similarity.ts` | C | confirmed | A3 (labelled pairs), C2 |
| KD-19 | L | The back-catalogue exclude on `openrouter-new-models` matches the literal phrases "2024 version" and "2025 version" and has to be extended every January | `registry/sources/labs.ts` | C | confirmed | C5 step 4 |
| KD-20 | L | A date-only regulator stamp is placed at 12:00 UTC, so a notice published later that day scores about 4 points low; the floor has 12 h of grace, the score does not | `normalize/dates.ts`, `score/index.ts` | F-rank | reported | Leave unless A3 shows an effect |
| KD-21 | L | A build tag cannot be told from a release with notes by its title; all runtime release lines are treated alike in LOCAL | `normalize/githubRelease.ts` | F-rank | reported | Use the release body length as a signal |
| KD-22 | L | Relevance gate false positives, about 5 of 560 passes: a chip maker's name as the only signal on a quantum headline, event recaps, a market roundup, a programme page | `relevance/aiTerms.ts` | F-sources | reported | C1 |
| KD-23 | L | The llama.cpp GGUF advisory was unplaced when measured: its source never counts coverage, so at 50 h it fell below AI SECURITY's 30 rows | `registry/sources/security.ts` | F-sources | reported; not re-checked | A section-focus term for local-stack advisories |
| KD-24 | L | By design a TOP hold can list a one-publisher story for up to 2 h | `ROUTE_POLICY.topHold` | I1, F-rank | by design | Watch in A1 step 7 |
| KD-25 | L | Measured by their fixers and by tests only, not re-measured on live data after integration: search results after the rewrite, the publisher recount under mutes, the hover card of a re-led row, and the closing round's outlet-count split | `shared/select.ts`, `src/features/search/`, `src/features/headline/` | I3, C | reported | D1 smoke flows |

### Engineering and operations

| # | Sev | Defect | Where | Source | State | Fix or item |
|---|---|---|---|---|---|---|
| KD-26 | M | Entry bundle 338.58 kB raw / 108.20 kB gzip against an 85 kB target; the React runtime alone is about 67.5 kB gzip | `src/main.tsx` | I1, I3, F-shell, C | sizes confirmed in `dist/` | D4 |
| KD-27 | M | `state.json` is 3.31 MB, written into `public/` and copied into a local `dist/` (4.56 MB in 35 files; 1.26 MB without it). Its absence from the published site depends on a CI step that has not run; the `data` branch that carries it is public. The pipeline refuses to write a state above 24 MB | `refresh.yml`, `run.ts`, `emit/write.ts` | I1, I3 | confirmed on disk | D2 |
| KD-28 | M | Ingest and the brief share one Node process: the key is in memory while feeds are parsed (SEC-7) | `scripts/pipeline/run.ts` | F-emit-ops, I3 | confirmed | A8 step 1 |
| KD-29 | M | No grounding check on the brief's text beyond "every cited URL was sent" (SEC-2); a rejected reply is visible only as `invalid-reply` | `enrich/brief.ts` | F-emit-ops, I3 | confirmed | A8 step 5 |
| KD-30 | M | Scheduled refreshes run `npx tsc -b` and `npm test` before every data build, so a test flake stops that slot's deploy and opens the "V2 refresh failing" issue. The one known flake (a 2 s wall-clock budget) was raised to 15 s; whether scheduled runs should skip the tests is an owner decision | `refresh.yml`, `scripts/pipeline/ingest/html.test.ts` | A-ops, C | confirmed | Owner decision; A1 |
| KD-31 | M | Link checker gaps: relative Markdown links and anchors are not checked; a POST-only API endpoint is reported broken; the two V2 addresses stay broken until the repository and site exist | `scripts/tools/check-links.ts` | I3 | confirmed | C4 step 6 |
| KD-32 | M | Ingest time varies with no failure: 14.7 s, 30.8 s and 19.2 s in the three builds of the final round. `github.com` serves 45 sources through one host queue; the Washington Post feed takes about 10 s per build; the log has no timing line for the Google News resolver | `ingest/pool.ts`, `ingest/googleNews.ts` | I3, C | reported (build logs) | D6 |
| KD-33 | M | SBOM is not validated against the CycloneDX 1.6 schema; six optional components have no hash; `npm audit signatures` covered only the 59 packages installed locally of 125 in the lockfile | `scripts/generate-sbom.ts` | I1, I3, F-ops | reported | D5 |
| KD-34 | L | 12 sources still carry `probation` although all were OK in the builds and the audit of 2026-11-20, all from one workstation. The fixture's gate reports "3 chronic" for its synthetic rows | `scripts/registry/sources/` | I3 | 12 confirmed | Re-judge after a week of CI runs (C3) |
| KD-35 | L | `validate:feeds` prints "REDIRECTED (update URLs)" for `hf-daily-papers`, whose redirect target is a dated URL that changes daily; following the advice breaks the source | `scripts/tools/validate-feeds.ts` | I3 | reported | A per-source "redirect expected" tag |
| KD-36 | L | No load status for `stocks.json` (`EditionState.stocks` is the file or null), so the ticker band cannot reserve its space | `src/app/services.ts` | F-shell | confirmed | B4 step 4 |
| KD-37 | L | `canonicalUrl` keeps gift-token parameters (`accessToken`, `st`, `reflink`). Dropping them changes article ids, so bookmarks and read state would stop matching: a migration, not a tweak | `shared/url.ts` | I3 | confirmed (not in the tracking list) | Leave; documented |
| KD-38 | L | Test-only exports are still exported: `isMuted`, `coverageOf`, `countNewSince`, `sectionsOfDesk`, `publisherById` | `shared/select.ts`, `shared/sections.ts`, `scripts/registry/index.ts` | I3 | reported | Remove or move to testkits |
| KD-39 | L | The explain tool says when a story is held or folded, but not why a story left TOP between two builds | `scripts/tools/explain.ts` | I3 | reported | A4 step 7 |
| KD-40 | L | Row tab stops: 2 to 5 per row (443 on the 143 homepage rows when measured). Taking the summary and "+N" buttons out of the tab order would make them unreachable with single-key shortcuts off | `src/features/headline/HeadlineRow.tsx` | F-pages | reported | Move both into the action group; needs D1 |
| KD-41 | L | Keys pressed before the lazy keyboard chunk arrives are not replayed | `src/app/ShellInteractions.tsx` | F-shell | reported | Buffer keys in the shell |
| KD-42 | L | Non-sticky phone chrome before content: about 172 px on home and `#/new`, about 130 px elsewhere (CSS arithmetic, not measured in a browser). Hiding the ticker on phones (about 25 px) is an owner decision | `src/styles/`, `src/features/chrome/` | F-shell | reported | D1, owner |
| KD-43 | L | The crash path of `run.ts` writes the error with `console.error` directly, not through `neutraliseWorkflowCommands` | `scripts/pipeline/run.ts` | W | confirmed | One-line change |
| KD-44 | L | Host backoff covers source fetches only, not the Google News resolver or the HN signal | `ingest/pool.ts` | F-ops | reported | D6 step 6 |
| KD-45 | L | The comment throttle of the alert issue steps uses GNU `date -u -d`; that branch could not be executed on the development machine | `refresh.yml` | F-ops | reported | A1 |
| KD-46 | L | `mlq.ai`, `marketbeat.com`, `fourweekmba.com`, `tradersunion.com` are excluded per source only; they refuse automated readers, so the evidence the global deny list requires was not recorded | `scripts/registry/outlets.ts` | F-sources, I1 | reported | E3 step 4 |
| KD-47 | L | The publisher recount under mutes relies on the member order the pipeline emits (documented in [CONTRACTS.md](./CONTRACTS.md) and pinned by a cluster test) and falls back to the conservative number when a story is led by a non-counting item; the client cannot see `countsForCoverage` | `shared/select.ts` | F-pages | reported | Publish a per-member flag in `rest.json` |
| KD-48 | L | Dead hnrss handling and stale comments remain (`DEFAULT_HOST_OVERRIDES` / `DEFAULT_HOST_GAPS_MS` in `pool.ts`, a transient rule in `feedVerdict.ts`) although no source uses hnrss.org; tests use it as the example host | `ingest/pool.ts`, `scripts/tools/feedVerdict.ts` | I1 | confirmed | Remove with their tests |
| KD-49 | L | The header comment of `removed.ts` says Noma is paused; the only paused source is `venturebeat-ai` | `scripts/registry/sources/removed.ts` | W | confirmed | Fix the comment |
| KD-50 | L | With a stored time chip, homepage rows change after first paint when `rest.json` merges (measured: 21 rows in 8 sections at 6H). Accepted in the closing round | `src/features/home/homeModel.ts` | A-cl, C | reported | Reserve the rows or show a placeholder until `rest.json` merges |
| KD-51 | L | A watch term the reader types is a whole word, so "Qwen" does not match "Qwen4-Max"; the shipped presets and the editor's placeholder use `Qwen*`. Search words do match versioned names since the closing round | `shared/text.ts`, `src/features/watch/WatchTermEditor.tsx` | A-cl, C | reported | Apply the letter-to-digit allowance to watch terms |
| KD-52 | L | The banner region is a live region (`role="status"`) that also holds buttons (Retry, Dismiss) | `src/features/chrome/Banners.tsx` | A-cl, C | reported | Move the buttons out of the live region |

### Documentation, fixture, cutover

| # | Sev | Defect | Where | Source | State | Fix or item |
|---|---|---|---|---|---|---|
| KD-53 | M | Cutover needs git writes no agent made: the commit itself; `git rm --cached public/feed.xml` (the file is tracked from V1 and modified by every build); the four V1 files under `public/data/` are tracked and deleted in the working tree; the five dated records should be staged as renames into `docs/archive/` | repository | I1, I3, A-ops | confirmed (`git ls-files public`) | A1 step 2 |
| KD-54 | M | Disclosure before the repository is public. The closing round removed the `owner-stack` tag and reworded about 35 registry notes; the published `sources.json` carries no notes and no longer describes the reader. Left in the repository: `docs/SOURCE_RESEARCH.md`, which still explains choices by the reader's local-model lab (runtimes and hardware; about 45 sentences reported by the closer); the tag `owner-pick` on 7 sources; third-party commit-author e-mail addresses inside three frozen feed fixtures. No name, employer or address of the owner is in the tree | `docs/SOURCE_RESEARCH.md`, `scripts/registry/sources/`, `test/fixtures/` | A-ops, C, Ed | notes and tag count confirmed; the rest reported | Owner decision for the research file: reword, or keep it out of the public repository; [SECURITY.md](./SECURITY.md) section 2.5 |
| KD-55 | L | Fixture: three health rows are synthetic (owner decision whether to keep them); a refresh needs a keyless build; four search and watch test inputs are not guarded by the refresh tool; one watch-preset test depends on the week's news; the 2026-11-19 corpus and registry fixtures were not refreshed; `feed.xml` and `feeds.opml` are not in the fixture, so the gate reports them missing on a fresh clone | `test/fixtures/`, `scripts/tools/fixture-refresh.ts` | I2, C | manifest confirmed | [CONTRACTS.md](./CONTRACTS.md) section 12; A3 replaces the corpus |
| KD-56 | L | `docs/SOURCE_RESEARCH.md` is 537 KB, 331 KB of it appendix A; whether GitHub renders a file of that size is not verified. No document has been viewed in a GitHub render; in-page anchors are checked by a script that approximates GitHub's rule | `docs/` | W, Ed | size confirmed | Move appendix A to `docs/archive/` |
| KD-57 | L | Option C only: the Mac launch agent calls the workflow by its V1 name ("Refresh and deploy"), which stops existing; the V2 workflow is "V2 refresh and deploy" | launch agent (outside the repository) | W | reported | [DEPLOYMENT.md](./DEPLOYMENT.md) section 10 |
| KD-58 | L | Owner decisions still open: the go-live option; the API key for the brief; the shared `github.io` origin (SEC-8); tagging `nist` and `cisa` as regulators; the stale threshold (120 min, `PIPELINE.staleAfterMinutes`); the NEW chip on home and `#/new` only; LOCAL release rows from 9 repositories (`ROUTE_POLICY.releaseRows.maxRows` 0 reverts); unit tests in scheduled refreshes; the ticker band on phones | several | I1, I3, C | open | [HANDOFF.md](./HANDOFF.md) section 2.1; A2, E4 step 1 |

Closed since the round-2 list or the final audit; checked in the tree, do not re-open:
`useKeyboardNav` DOM tests exist (`src/keyboard/useKeyboardNav.test.ts`, 24 tests); the Watch page
has one briefing entry point; section pages show one time-chip group (`showsTimeChips`); the stale
banner follows `status.json` `staleAfterMinutes`; hnrss.org is no longer used by any source; the
three false story merges of the audit are split; the feed-audit issue lookup filters on a bot
author and fails in GitHub Actions when the lookup fails; the gate compares the feed's self link
with the configured `SITE_URL`; `validate:feeds`, `check:links` and `build:data` refuse unknown
arguments; `.gitignore` covers `.env.*`; the `owner-stack` tag is gone from the registry and the
published source list; the final-round placeholders in three documents are filled and the V1-era
documents are rewritten.

---

## Not recommended

Considered and rejected. Re-open one only with a new fact.

| Idea | Why not |
|---|---|
| A server runtime (API, database, server-side rendering on request) | The design is a static site rebuilt by a scheduled job: no host to patch, no credentials at request time, no data about readers to protect. Every item above fits the static model. A server would add an attack surface and an on-call duty for one reader's convenience. |
| User accounts and sync | Accounts mean personal data, authentication and a breach surface. Reader state is in `localStorage` with export and import (`src/state/backup.ts`). If sync is ever wanted, a file the reader keeps in their own storage is the route. |
| Advertising or analytics, including "privacy-preserving" analytics | The page makes no third-party request (`connect-src 'self'`), which is a property worth more than popularity data. Click signals would also bias ranking toward what was already shown. V1's roadmap listed analytics; it is withdrawn. |
| A comment system | Moderation duty, user-generated content on a personal site, and a third-party script or a server. Discussion already exists where the stories are linked from. |
| Scraping or bypassing paywalled content | Legal and ethical exposure, and it breaks the page's contract with publishers: headline and link, the click goes to them. The right handling is the paywall flag (C4). |
| A self-hosted Actions runner on the owner's hardware for a public repository | A workflow run triggered from a fork or a compromised dependency would execute code inside the owner's network. Local models reach the build through the hand-over pattern of A8 instead. |
| A model as the relevance gate or as the ranker | The build would stop being deterministic and explainable, and a prompt injection in a feed could move the front page. Models stay advisory, one-directional and switchable (C1, C2). |
| Letting a model extract regulatory dates into the tracker | A wrong compliance date is worse than none. Dates are entered by a person from the primary document (A6). |
| Lowering the cosine bar to merge the remaining splits | Measured in the fix round: 0.39 merges three false pairs. Looser corroboration variants merged an advisory with an unrelated commit. Use the labelled set (A3) and a different signal (C2). |
| A lexical grounding check on the brief (every capitalised token must appear in the input) | Measured: it rejects legitimate paraphrase and product names with dots, and makes the brief disappear. The per-bullet scope of A8 step 5 is the replacement. |
| Splitting React into a vendor chunk to "meet" the bundle target | Measured: the entry would read 39.3 kB, but first-paint JavaScript stays about 107 kB and one request is added. See D4. |
| Renaming the workflows to keep V1 safe in a shared repository | It does not give the protection claimed: if the V2 tree reaches V1's main branch, V1's scripts are gone either way. The `V2_DEPLOY` guard and a separate repository are the protection. |
| Publishing `topRelated` in `front.json` | First-paint bytes for data nothing renders. Threads (A5) publish it in `rest.json` with a consumer. |
| Truncating stored raw summaries to shrink the state | Measured: a 1,500-character cap empties 39 published summaries and changes 175. Move the state instead (D2). |
| An AI-term test on a general publisher's AI topic feed (`nyt-artificial-intelligence`) | Measured in the closing round: 3 of 5 items carry no AI term in title or summary, and the test would drop the outage coverage the audit asked for. Prefer a lead choice that shows the AI angle (A4). |
| A recency cap on every TOP story | Measured in the closing round on the 2026-11-19 corpus: it moved the lead from the 16-publisher IPO to a 23 h-old launch. The cap applies below 3 publishers only. |
| A time-gap rule (24 h or 30 h) against false merges | Measured in the closing round: it split three correct stories. The three narrow vetoes are the replacement. |
| Following a feed validator "moved" hint automatically | `hf-daily-papers` redirects to a dated URL; auto-updating would break it daily. Registry edits stay reviewed. |

---

## How to add an item to this file

1. Give it the next id in its group and a row in section 0.3.
2. Write the seven fields: what and why (with a measurement if one exists), where it starts
   (paths that exist today), a numbered sketch, effort, risk, dependencies, verification.
3. Check every path and number against the tree on the day you write it, and date the claim.
4. When an item ships, move its summary to [CHANGELOG.md](./CHANGELOG.md) and delete it here; when
   a defect is fixed, delete its row. This file lists open work only.
