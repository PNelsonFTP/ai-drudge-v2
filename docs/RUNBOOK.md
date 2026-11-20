# AI DRUDGE V2 — Runbook

Written 2026-11-20 and corrected after the closing round of the same day. Audience: whoever
operates V2 after go-live, or debugs it locally before.

**Answer first.** V2 has one status file, one gate, and four rolling issues. When something looks
wrong: read `status.json`, read the open issues, then use the table for the symptom. A build that
fails never replaces the live site: the previous deploy keeps serving and goes stale. Nothing in
V2 commits to `main`, so no failure needs a history rewrite.

**Scope warning.** V2 is not deployed and has never run on GitHub (2026-11-20). Every procedure
below that touches GitHub, launchd or git is reasoned from the workflow files, the scripts and
their tests. Go-live itself is in [DEPLOYMENT.md](./DEPLOYMENT.md); this document starts after it.

| Tag | Meaning |
|---|---|
| `[LOCAL]` | Executed in this working tree on 2026-11-20 (macOS, Node 26.7.0); result recorded in [section 5](#5-commands-verified-for-this-document) |
| `[UNTESTED]` | Never executed. Reasoned from code, workflow files or the tool's documented behaviour |

Related: [DEPLOYMENT.md](./DEPLOYMENT.md) (go-live, configuration, launch agent plist),
[CONTRACTS.md](./CONTRACTS.md) (data contract, commands), [SECURITY.md](./SECURITY.md),
[SOURCES.md](./SOURCES.md) (every source, how to add one), [V1_VS_V2.md](./V1_VS_V2.md).

---

## 1. Orientation

### 1.1 Shell variables used below

```bash
R=PNelsonFTP/ai-drudge-v2                        # the V2 repository (does not exist yet)
SITE="https://pnelsonftp.github.io/ai-drudge-v2/" # the V2 site (404 until go-live)
```

All `npm` commands run in the repository root. `public/data/v2/`, `public/feed.xml` and
`public/feeds.opml` are generated and gitignored.

### 1.2 Where the evidence is

| Evidence | Where | What it tells you |
|---|---|---|
| Reader banner | The site itself | "Headlines may be delayed": the edition is older than `staleAfterMinutes` (120). "You are offline", "Could not refresh", "Still trying to load the headlines", "This browser is not saving your changes": client-side conditions, not build failures (`src/features/chrome/model.ts`) |
| `status.json` | `${SITE}data/v2/status.json`, or `public/data/v2/status.json` | Build time, run id and trigger, feed counts and failed names, story counts, gate verdict with failures and warnings, brief source and reason, priced stocks |
| `health.json` | same directory; rendered at `#/sources` | One row per active source: `ok`, `status`, `count`, `error`, `lastError`, `httpStatus`, `failStreak`, `lastOkAt` |
| Gate report | Step "Freshness and quality gate" of the `build` job; locally `npm run build:check` | Every check with its numbers; `PASS` or `HOLD` on the last line |
| Run summary | Actions run page of `refresh.yml` | "State restored from: ...", annotations (`::warning`, `::error`) |
| Rolling issues | Issues tab, opened by `github-actions[bot]` | "V2 refresh failing", "V2 Daily Brief failing", "Feed audit: ...", "Dependency audit failing" |
| Build log | Step "Build data"; locally the output of `npm run build:data` | One `OK` / `FAIL` line per source, the drop counts per stage, the stage timing table |
| Explain record | `node_modules/.tmp/explain.json` (written by a local `npm run build:data`; not uploaded by CI) | Score parts, placements and drop reasons per item (`npm run explain`) |

### 1.3 First five minutes

1. Read the status file `[UNTESTED against a live site; shape verified locally]`:
   ```bash
   curl -fsS "${SITE}data/v2/status.json?t=$(date +%s)" \
     | jq '{generatedAt, staleAfterMinutes, run, gate, brief, feeds, stocks}'
   ```
   Locally: `jq '{generatedAt, staleAfterMinutes, run, gate, brief, feeds, stocks}' public/data/v2/status.json` `[LOCAL]`.
2. List the last runs: `gh run list --repo $R --workflow refresh.yml --limit 10` `[UNTESTED]`.
3. List the open rolling issues: `gh issue list --repo $R --state open` `[UNTESTED]`.
4. A failed run names its failed step in the "V2 refresh failing" issue ("Build stopped at: ...").
   Read that step's log: `gh run view <run-id> --repo $R --log-failed` `[UNTESTED]`.
5. Reproduce locally when the cause is in the data, not in GitHub:
   `env -u ANTHROPIC_API_KEY npm run build:data && npm run build:check` (network; 19-36 s measured
   on 2026-11-20).

---

## 2. Symptoms

### 2.1 The site shows "Headlines may be delayed"

The client shows the banner when the edition's `generatedAt` is older than `status.json`
`staleAfterMinutes` (120, from `PIPELINE.staleAfterMinutes` in `scripts/pipeline/context.ts`). Until
`status.json` has loaded, or when the number is outside 30 minutes to 24 hours, the fallback is
2 hours (`STALE_BANNER_HOURS`, `src/app/services.ts`). The banner means "no successful deploy for
two hours". It never means the data is wrong.

| Diagnosis | How to confirm | Fix |
|---|---|---|
| No run started | `gh run list` shows no run in the last 2 h | Section [2.8](#28-github-cron-is-not-firing-the-mac-kick). Immediate: `gh workflow run refresh.yml --repo $R --ref main` |
| Every job is skipped | Runs exist, all jobs "skipped" | Repository variable `V2_DEPLOY` is not the exact string `true`: `gh variable list --repo $R`, then `gh variable set V2_DEPLOY --body true --repo $R` |
| Scheduled workflow disabled | GitHub notice "scheduled workflow disabled" (60 days without repository activity on a public repository) | `gh workflow enable refresh.yml --repo $R`. Dispatch kicks are not affected |
| Build job fails | Open issue "V2 refresh failing"; "Build stopped at:" names one of: preflight, `npm ci`, typecheck, unit tests, state restore, data build, data gate (hold), site build, dist check, artifact upload | By step: preflight -> [2.9](#29-the-pages-deploy-fails); typecheck / tests -> a code push broke `main`, revert it ([2.13](#213-rolling-back-a-bad-edition)); data build -> pipeline error or the 12-minute limit, read the log; data gate -> [2.2](#22-a-build-fails-the-gate) |
| Deploy job fails | Issue says "all deploy attempts failed" | [2.9](#29-the-pages-deploy-fails) |
| Build is fine, one reader sees the banner | `status.json` on the site is fresh | GitHub Pages caches about 10 minutes and the client re-fetches every 10 minutes while the tab is visible (`REFRESH_INTERVAL_MS`). The banner's "Check again" button forces a fetch |
| Local dev server on the fixture | `status.json` `run.trigger` is `fixture` | Expected: the fixture is a frozen build of 2026-11-20. Run a live build for current data |
| Local dev server on old live data | `npm run build:check` warns `data is N min old (> 120)` | `env -u ANTHROPIC_API_KEY npm run build:data` |

To move the threshold, change `PIPELINE.staleAfterMinutes` (one number; the client follows the next
build's `status.json`). Server-side there is no alert for "no run started": only the reader's banner
shows it.

### 2.2 A build fails the gate

The gate is `scripts/tools/check-data.ts` (`npm run build:check`; CI adds `--write-status`). Exit 0
publishes, exit 1 holds: nothing is uploaded and the previous deploy keeps serving. It prints
`FAIL`, `WARN` and `ALERT` lines and ends with `PASS  data gate passed` or
`HOLD  data gate failed: N problem(s) - do not publish`. Thresholds are `GATE` in
`scripts/pipeline/emit/quality.ts`; file ceilings are `SIZE_LIMITS` in
`scripts/pipeline/emit/write.ts`. Only `FAIL` blocks.

**File checks** (the 8 JSON files in `public/data/v2/`, plus `public/feed.xml` and `public/feeds.opml`):

| Message starts with | Level | Trigger | Usual cause and fix |
|---|---|---|---|
| `<file>: missing` | FAIL | File absent | The data build did not run or crashed before writing. Locally after `npm run data:fixture`: `feed.xml` and `feeds.opml` are not part of the fixture, so both report missing (expected; run a live build) |
| `<file>: cannot read (...)` / `not valid JSON` | FAIL | Unreadable or truncated file | Re-run the build. Writes are atomic, so a repeat means a disk or code problem |
| `<file>: contract guard failed - ...` | FAIL | Shape does not match `shared/guards.ts` | A code change altered the output without updating the contract. `npm test` reproduces it; fix the emitter or the guard in the same commit |
| `<file>: N bytes exceeds the L byte ceiling` | FAIL | Over `SIZE_LIMITS`: `front.json` 1.5 MB, `rest.json` 4 MB, `river.json` 8 MB, `health.json` and `sources.json` 1 MB, `brief` / `stocks` / `status` 64 KB, `feed.xml` and `feeds.opml` 1 MB | One feed delivered an oversized field or a cap regressed. Find the source in the build log; add `maxItems` / `maxKept` or pause it |
| `front.json: X KB gzip is above the 48.0 KB first-paint budget` | WARN | `front.json` gzip > 48 KB (43.9 KB on 2026-11-20) | An unusually large lead cluster. Published anyway; investigate if it persists |
| `invariant: ...` | FAIL | A cross-file rule of `shared/invariants.ts` (lead is `top[0]`, front rows are a prefix of rest rows, no duplicate rows, no dangling ids, counts agree, one `buildId`) | Code defect in route or emit. Reproduce with `npm run build:data` and fix; never loosen the invariant to pass |
| `stale: generatedAt ... is older than this build` | FAIL | `generatedAt` < `BUILD_STARTED_AT` | The pipeline wrote nothing new (it crashed, or the zero-article guard kept the old files) |
| `freshness: BUILD_STARTED_AT is not set in CI` | FAIL | Running in GitHub Actions without the variable | The "Record build start" step was removed or reordered in `refresh.yml`; restore it |
| `freshness: BUILD_STARTED_AT "..." is not a date` | FAIL | Malformed variable | Same step |
| `data is N min old (> 120); set BUILD_STARTED_AT ...` | WARN | Local run on old data | Rebuild, or ignore |
| `generatedAt ... is in the future` | FAIL | More than 10 minutes ahead of the clock | Runner clock or a bad `now` injection |
| `zero articles ...` | FAIL | The pipeline's own marker in `status.gate.failures`: nothing survived relevance, previous files kept | Total fetch outage or a relevance regression. The failure issue says "zero articles". Check the network from the runner, then `npm run build:data` locally |
| `feed.xml: ...` / `feeds.opml: ...` (`missing`, `empty`, `contains a character XML 1.0 does not allow`, `not well-formed XML`, `no <feed> element`, `N entries (max 30)`, `no entries although TOP STORIES has N`) | FAIL | Atom or OPML defect | Emit code (`scripts/pipeline/emit/atom.ts`, `opml.ts`) |
| `feeds.opml: lists N sources but M are active` | FAIL | OPML outline count differs from active sources in `sources.json` | Emit code |
| `feed.xml: self link <url> is not under the configured site URL <url> (check SITE_URL)` | WARN | The Atom feed's self link does not start with the `SITE_URL` the gate was run with (default: the V2 project URL) | The build and the gate disagree about `SITE_URL`: set the same value for both. Never raised when the feed points at the configured site, whichever address that is (closing round) |

**Content checks** (`evaluateQuality`; ages are measured at build time, so a verdict never changes with the wall clock):

| Message starts with | Level | Trigger | Usual cause and fix |
|---|---|---|---|
| `blank: front.json has no rows in any section` | FAIL | 0 homepage rows | Route or relevance regression |
| `hollow: N stories < 60` | FAIL | Fewer than 60 placed stories (322 on 2026-11-20) | Mass fetch failure or an over-tight gate. Read the `feeds` row and the drop counts in the log |
| `thin: N stories < 120` | WARN | Fewer than 120 | Watch the next build |
| `hollow: only N of 15 sections have rows (< 10)` | FAIL | Fewer than 10 sections with a homepage row | Same as hollow |
| `empty sections: ...` | WARN | 1-5 sections empty | A section's sources are down or its window is too short (`shared/sections.ts`) |
| `hollow homepage: N section(s) show fewer rows than they hold` | FAIL | A section's homepage list is shorter than `min(homeRows, total)` | Defect in `scripts/pipeline/route/homepage.ts` |
| `hollow: TOP STORIES is empty although multi-publisher ai-desk stories exist` | FAIL | `top` empty while a 2+ publisher AI-desk story sits inside the 72 h window | Defect in `route/top.ts` |
| `TOP STORIES is empty (...)` / `TOP STORIES thin: N < 4` | WARN | Quiet day | None |
| `N placed stories have no usable date` | FAIL | A placed article has neither `publishedAt` nor `firstSeenAt` | Normalize defect |
| `stale content: oldest row is X d old (> 60 d)` | FAIL | A row older than 60 days | A source's `maxAgeDays` outgrew the ceiling (the registry rejects values above 45) or a date parse failed |
| `frozen content: newest placed story is N h older than the build (> 24 h)` | FAIL | Fresh files, old news | A date, dedupe or relevance regression downstream of ingest |
| `newest placed story is N h older than the build (> 12 h)` | WARN | Same, 12-24 h | Watch |
| `payload: N titles longer than 300 chars` (also summaries > 400, URLs > 2048) | FAIL | Field caps exceeded | Normalize caps regressed |
| `feeds: health.json lists no feeds` | FAIL | Empty health file | Emit defect |
| `feeds: mass failure - 0 of N feeds fetched this run` | FAIL | No source OK | Network outage on the runner |
| `feeds: mass failure - ... below 60%` | FAIL | OK share of **live** feeds < 60%. Live = total minus chronic minus empty | Runner network, a blocked User-Agent, or a parser regression. Compare with a local build |
| `feeds: ... below 85%` | WARN | OK share 60-85% | Read `status.json` `feeds.failedNames` |
| `feeds: N of T feeds answered with no usable items this run (P%)` | FAIL at >= 25%, WARN at >= 10% | Valid responses with zero usable items | Parser or date regression. About 8.5% is normal (arXiv weekends, queries without hits) |
| `feeds: N of T feeds are chronic (...)` | FAIL | >= 40% of the registry is chronic (fail streak >= 12, quarantined, or a failing `probation` source) | Slow collapse: prune or fix sources |
| `feeds: N chronic (...): names` | WARN | Any chronic source | Registry chore: [2.3](#23-a-source-is-failing-carried-forward-or-quarantined) |
| `feeds: tier-1 source "X" has failed N runs in a row` | WARN | A tier-1 source with fail streak >= 6 | Fix that source first |
| `brief: claude brief has N bullets (< 3)` | FAIL | A Claude brief passed validation with fewer than 3 bullets | Defect in `enrich/brief.ts` validation |
| `brief: fallback brief is empty` | WARN | Deterministic brief has no bullets | Hollow edition |
| `brief: Claude brief unavailable (<code>) - fallback published` | WARN | A key is configured and the call failed | [2.6](#26-the-daily-brief-is-missing-or-not-ai-written) |
| `brief: the Claude brief has failed N builds in a row (...)` | ALERT | Six consecutive keyed builds failed (`GATE.briefAlertStreak`) | Same; opens "V2 Daily Brief failing" |
| `brief: headline looks like a release tag` | WARN | Brief headline ends in "released" | None; report if it repeats |
| `stocks: N of 8 symbols priced` | WARN | Fewer than 4 priced symbols | [2.7](#27-the-stock-ticker-is-missing) |

After a hold: fix the cause and start a run (`gh workflow run refresh.yml --repo $R --ref main`).
The next scheduled build also retries without help; a transient outage clears itself.

### 2.3 A source is failing, carried forward or quarantined

Health is per source and survives between builds in `state.json`.

| `status` | `ok` | Meaning | Reader effect |
|---|---|---|---|
| `ok` | true | Fetched and parsed with at least 1 item, or answered 304 and its last-good items were reused | Normal |
| `carried` | false | Failed this run and its last-good items (at most 6 h old, `PIPELINE.carryForwardMaxHours`) were reused. With `error: "skipped"` and `lastError` starting `host backoff:`, the source was not asked because its host answered 5xx / 429 to two requests in a row | None for up to 6 h |
| `failing` | false | Failed this run, nothing carried | Its items leave the edition; river rows stay up to 7 days |
| `quarantined` | false | 48 consecutive failures (`quarantineAfterFails`; an `empty` result never quarantines). Skipped except one probe per 24 h | None beyond `failing` |

| Field | Notes |
|---|---|
| `error` | Class of this run: `timeout`, `network`, `http`, `too_large` (over 5 MiB), `not_feed`, `parse`, `empty`, `no_cards` (scraper), `skipped` |
| `lastError` | One line, e.g. `HTTP 403`, `timeout after 8000 ms`. Kept while `failStreak` > 0 |
| `failStreak` | Consecutive failed runs. 6 = tier-1 warning; 12 = chronic for the gate; 48 = quarantine. Host backoff does not raise it |
| `lastOkAt` | Last successful fetch, or `null` |

List every source that is not OK `[LOCAL]`:

```bash
jq -r '.feeds[] | select(.ok | not) | [.id, .status, .error, .failStreak, .lastOkAt, .lastError] | @tsv' \
  public/data/v2/health.json
```

On the closing build of 2026-11-20 it prints one row (builds 1 and 2 of that day printed none):

```text
arxiv-cs-cr-llm-agent-security	carried	http	1	2026-11-20T04:16:25.732Z	HTTP 429
```

That is the normal shape of a transient failure: one failed run, the last-good items of the
previous build carried forward, no action needed. The same data is at `#/sources`, in
`status.json` `feeds.failedNames` and as `FAIL` lines in the build log.

| Diagnosis | Fix |
|---|---|
| `http` 403 / 429 from CI but OK from a workstation (bot wall on runner addresses) | Add the tag `probation` (failure is expected; the source leaves the gate's live denominator), or replace it with a Google News query tagged `fallback`, or pause it. 12 sources carry `probation` today, none of them yet observed from a CI runner |
| `http` 404 / 410, `not_feed` | The feed moved or became an HTML page. Find the new URL, validate it (step below), update `url` |
| `no_cards` (kind `scrape`) | The listing page changed. Fix `scrape.linkPattern` / `titleSelectorHint` / `dateHint` in `scripts/registry/sources/scrapers.ts` |
| `timeout` on a slow origin | `fetch: { headerTimeoutMs, timeoutRetries, attempts }` on the source (bounds 1000-25000 ms, 0-1, 1-3). One use today: `washington-post-technology`, a single 16 s attempt |
| `empty` | Often legitimate (a query with no hits, arXiv at a weekend). Act only when the gate's empty share warns |
| `parse`, `too_large` | Publisher-side defect. Wait one day; pause if it persists |
| Many sources of one host `carried` with `host backoff:` | The host is down (for example `github.com`, 45 sources). Nothing to do; it is retried next run |
| Quarantined source was fixed | Nothing to reset: the next probe (within 24 h of the last attempt) clears it. There is no manual reset command |
| The source is gone for good | Pause it (below). Delete only when it will never return |

Validate a URL before editing the registry (network):

```bash
printf '[{ "name": "Candidate", "url": "https://example.org/feed.xml" }]' > candidate.json
npm run validate:feeds -- candidate.json
```

Pause a source: in its entry under `scripts/registry/sources/`, set `status: "paused"` and a `note`
saying why (the registry rejects a paused source without a note); the convention is to add the tag
`disabled` as well (see `venturebeat-ai` in `press.ts`). Then:

```bash
npx tsc -b
npx tsx --tsconfig tsconfig.app.json --test scripts/registry/registry.test.ts
npm run docs:sources        # after the next data build, so the status columns are current
```

A paused source stays in `sources.json` and on the Sources page and is not fetched. Adding a
source: [SOURCES.md](./SOURCES.md#how-to-add-a-source).

### 2.4 A story is missing or in the wrong place

```bash
npm run explain -- "<title words>"          # also accepts an article id or a URL
npm run explain -- "<title words>" --mute <source-id,...>
```

`[LOCAL]` It reads `node_modules/.tmp/explain.json`, which only a local `npm run build:data`
writes. For a live edition, run a local build first (results differ slightly: another clock, another
network). Without the record it falls back to the published files: placements and coverage, no
score parts and no drop reasons.

| The tool prints | Meaning | Where to change it |
|---|---|---|
| `No story or dropped item matches ...` | The item was never fetched: its source is not in the registry, the source failed, or the item had already left the feed's window | `#/sources` / `health.json`; `maxItems` of the source; add the source |
| `DROPPED at normalize: invalid` / `duplicate` | Unusable URL or empty title after cleaning; same id twice in one source | `scripts/pipeline/normalize/` |
| `DROPPED at normalize: release_collapsed` | Older, pre-release or sub-package GitHub release folded into the repository's one line | By design (`normalize/githubRelease.ts`); `releaseLine` on the source |
| `DROPPED at relevance: too_old (age N d > M d)` | Older than the source's `maxAgeDays` | Registry (maximum 45) |
| `DROPPED at relevance: off_topic` | A `scope: "general"` source's item failed the AI gate | `scripts/pipeline/relevance/aiTerms.ts`, or an `include` list on the source |
| `DROPPED at relevance: excluded (...)` | The source's `include` / `exclude` / `includeUrl` / `excludeUrl`, or a denied outlet | The source entry; `OUTLET_DENY` in `scripts/registry/outlets.ts` |
| `DROPPED at relevance: noise` | Promo, event, webinar or job posting | `scripts/pipeline/relevance/noise.ts` |
| `DROPPED at relevance: source_cap` | Over the per-source cap (default 8) and not corroborated by another publisher | `maxKept` on the source |
| `not placed in any section (... river only)` + `cut from <section>: <reason>` | Kept, searchable for 7 days, not listed. Reasons: `window` (section age window), `diversity` (one publisher over 30% of a section), `cap` (section full), `mode` (source-mode section), `limit` (already has its one routed section), `policy` (home-only source or not in `routeTo`), `moved` | `shared/sections.ts` (windows, row counts); `scripts/pipeline/route/rules.ts` |
| `placed: <section> #N (view-all only)` | Listed below the homepage cut | Score parts on the `score` line: tier, recency (36 h half-life), importance, coverage, hn |
| `route: routed to <section> by rule "..."` | The keyword rule that moved it | `scripts/pipeline/route/rules.ts` |
| `section focus in <section>: <rule> +N ...` | An ordering bonus inside that section's list (LOCAL, POLICY, AI SECURITY); the score is unchanged | `SECTION_FOCUS` in `scripts/pipeline/route/rules.ts` |
| `not in TOP STORIES: a follow-up of the running story ...` | Folded under a story already in TOP | [2.5](#25-duplicates-in-top-stories) |
| Publisher count lower than the outlets you can see | Items of outlets no registry publisher vouches for are tier 4, never lead and do not count (`unvetted-outlet`) | Add a publisher entry in `scripts/registry/publishers.ts` to vouch for the outlet |

Known limits on 2026-11-20 (not operator errors): the explain tool does not say why a story *left*
TOP STORIES; a two-publisher story one or two hours old can still enter TOP (its recency is capped
at 40 points for TOP ranking while it has fewer than 3 publishers, `PIPELINE.topRecencyCap`); a
regulator's own notice is guaranteed a POLICY homepage row for 72 h only for the publishers in
`ROUTE_POLICY.regulatorFloor`, and `nist` / `cisa` are inert there until their feeds carry the tag
`regulator`. See [V1_VS_V2.md](./V1_VS_V2.md#4-what-is-not-better-yet) and the full list in
[HANDOFF.md](./HANDOFF.md) section 7.

### 2.5 Duplicates in TOP STORIES

`front.top` can never repeat an id (invariant). What a reader calls a duplicate is one event split
into several stories.

| Diagnosis | How to confirm | Fix |
|---|---|---|
| Follow-ups of one running story | `npm run explain -- "<headline>"` on each row. A folded follow-up says so; an unfolded one shows no shared core token with the anchor, or the anchor is outside the TOP window (72 h) | Rule: `scripts/pipeline/route/running.ts`, constants `ROUTE_POLICY.runningStory` (`independentPublishers` 5, `maxSlots` 2). The fold applies to TOP only: in the closing build of 2026-11-20 ten homepage stories named Nvidia or its former chief executive |
| The cluster stage split one event | The rows have near-identical subjects and different leads; `also (N)` lists differ | `scripts/pipeline/cluster/similarity.ts` (`CLUSTER`, `corroborated`). Token rules cannot recover every pair (FT vs Reuters on China chip sales, cosine 0.24). Do not loosen thresholds on one example: `scripts/pipeline/cluster/index.test.ts` pins the labelled pairs |
| The cluster stage merged two events | One row, mixed "Also:" outlets | Same file. Existing vetoes: `distinctProducts` (same version, different product), `distinctSubjects` (rival companies from the closed list `RIVAL_SUBJECTS`: add the company if it is missing), regions as context, `sharesOnlyUbiquitous` (a pair sharing only names the whole run uses). Add the pair as a test on its real titles before changing a rule |
| A story stays in TOP with one publisher | By design: the hold keeps a previous TOP story for up to 2 h unless a newcomer scores 5 points more (`ROUTE_POLICY.topHold`) | Wait, or change the constants. Not yet observed on live data |
| The same URL in two sections | By design a story is listed in its home section plus at most one routed section; only one of them gets a homepage row, except up to 2 release lines that LOCAL & OPEN MODELS shows although RELEASE RADAR lists them | `ROUTE_POLICY.releaseRows.maxRows` 0 reverts the exception |

Any change to these rules needs `npm test` and one live build read by a person.

### 2.6 The Daily Brief is missing or not AI-written

The homepage renders a brief only when `brief.json` has `source: "claude"`. Every build so far was
keyless, so the Claude path has **never run** `[UNTESTED]`.

```bash
jq '{source, model, fallbackReason, generatedAt}' public/data/v2/brief.json
jq '.brief' public/data/v2/status.json
```

| `fallbackReason` / `status.brief.reason` | Meaning | Fix |
|---|---|---|
| `no-key` | No `ANTHROPIC_API_KEY` reached the build. Never warned, never alerted | Set the secret (DEPLOYMENT.md section 11). The key is passed only to the "Build data" step and only on `refs/heads/main` |
| `thin` | Too few stories to brief from | None |
| `http-4xx` | The API rejected the request: expired or revoked key, retired model id, rejected parameter | Rotate the key ([2.11](#211-rotating-the-anthropic-key)); check `BRIEF_MODEL` and the comment above it in `scripts/pipeline/enrich/brief.ts` before changing the id |
| `http-5xx`, `timeout`, `network` | The API could not be reached | Wait; one failed build is covered by the fallback |
| `refusal`, `truncated`, `invalid-reply`, `error` | The reply failed validation (every cited URL must be one that was sent) | Read the "Build data" log lines starting `brief:`; the API's error text is only there |

Signals: the gate warning `brief: Claude brief unavailable (<code>)` on each failed keyed build;
after six in a row the ALERT and the rolling issue "V2 Daily Brief failing" (at most one comment a
day; closed by the first build without the alert). `status.json` `brief.failStreak` carries the
count. To stop the alerts without fixing the brief: `gh secret delete ANTHROPIC_API_KEY --repo $R`.

### 2.7 The stock ticker is missing

The ticker band renders nothing when `stocks.json` has not loaded or no symbol has a price
(`tickerModel`, `src/features/chrome/model.ts`). A symbol without a price shows a dash.

```bash
jq '{asOf, marketState, priced: [.order[] as $s | select(.quotes[$s].price != null) | $s]}' public/data/v2/stocks.json
```

| Diagnosis | Fix |
|---|---|
| `status.json` `stocks.ok` is 0, or the gate warns `stocks: N of 8 symbols priced` | The quote provider rejected the build (`scripts/pipeline/enrich/stocks.ts`: one request per symbol to `query1.finance.yahoo.com`, retry on `query2`, 6 s timeout). A failed symbol is a null quote; the stage never fails the build. Usually clears next run. If it persists from CI, the provider is rejecting runner addresses: there is no second provider (V1's, Stooq, answers 404 and was removed). The ticker stays hidden and nothing else is affected |
| Quotes present, labelled "Closed · as of ..." | Market closed at build time. Expected |
| File present on the site, ticker absent in one browser | `stocks.json` failed to load there (8 s timeout); it never blocks the headlines. Reload |
| Symbol list is wrong | `STOCK_SYMBOLS` in `stocks.ts` (NVDA, MSFT, GOOG, META, AMZN, AMD, TSM, AVGO) |

### 2.8 GitHub cron is not firing: the Mac kick

GitHub's `schedule` is a backstop. On V1 it delivered about 20% of its slots in October-November
2026 (ops review of 2,186 runs). `refresh.yml` requests four slots an hour (`7,22,37,52`); the
`guard` job drops a scheduled slot when the live data is younger than 20 minutes. Schedules run from
the default branch only. The dependable clock is a launchd user agent on the owner's Mac that calls
`scripts/kick-refresh.sh`.

`scripts/kick-refresh.sh` `[LOCAL]` (dry runs only; no dispatch was made):

| Variable | Default | Rule |
|---|---|---|
| `AID_REPO` | `PNelsonFTP/ai-drudge-v2` | `owner/name`; a full https URL, `github.com/...` or an ssh remote is reduced to that. Anything else exits 1 |
| `AID_REF` | `main` | Plain branch name |
| `AID_WORKFLOW` | `refresh.yml` | Workflow file name |
| `AID_RETRIES` | `3` | Positive integer; attempts are 15 s apart |
| `AID_DRY_RUN` | unset | `1` prints the target and exits 0 without calling GitHub |
| `AID_ALLOW_V1` | unset | `1` is required to dispatch to the V1 repository |

**It refuses V1.** After normalising `AID_REPO` (scheme, host, every trailing `/` and `.git`, case)
it compares the result with `pnelsonftp/ai-drudge` and exits 1 with
`refusing to kick the V1 repository` unless `AID_ALLOW_V1=1`. The check runs before the dry-run
exit and before `gh` is looked up. Covered by `scripts/kick-refresh.test.ts`.

```bash
AID_DRY_RUN=1 bash scripts/kick-refresh.sh
# kick-refresh: workflow 'refresh.yml' in PNelsonFTP/ai-drudge-v2 on ref 'main'
# kick-refresh: dry run - nothing dispatched
```

The script needs `gh` on `PATH` (it prepends `/opt/homebrew/bin` and `/usr/local/bin`) with a token
that may dispatch workflows. launchd cannot read `~/Documents`, so the agent must run a copy of the
script outside that folder; re-copy it after every change to the script.

| Task | Command `[UNTESTED]` |
|---|---|
| Install the V2 agent | The plist and the six commands are in [DEPLOYMENT.md section 10.1](./DEPLOYMENT.md#101-option-a-a-second-agent-for-v2) (label `local.ai-drudge-v2-refresh`, minutes 5 and 35) |
| Is it loaded? | `launchctl list \| grep ai-drudge` |
| State, last exit code | `launchctl print gui/$(id -u)/local.ai-drudge-v2-refresh` |
| Log | `tail -n 20 ~/Library/Logs/ai-drudge-v2-refresh.log` (expect `kick-refresh: dispatched at ...`) and the `.err` file beside it |
| Kick now | `launchctl kickstart gui/$(id -u)/local.ai-drudge-v2-refresh` |
| Remove | `launchctl bootout gui/$(id -u)/local.ai-drudge-v2-refresh`, then delete `~/Library/LaunchAgents/local.ai-drudge-v2-refresh.plist` and `~/.local/bin/ai-drudge-v2-kick.sh` |

| Symptom | Diagnosis | Fix |
|---|---|---|
| No runs, Mac asleep or off | launchd does not replay each missed slot | Wake the Mac, or accept the cron backstop. `gh workflow run refresh.yml --repo $R --ref main` from any machine |
| Log says `gh (GitHub CLI) not found on PATH` | `gh` is installed somewhere else | Add its directory to the plist's `EnvironmentVariables` `PATH` |
| Log says `dispatch failed after 3 attempt(s)` | `gh` token expired or lacks the `workflow` scope, or GitHub is down | `gh auth status`; `gh auth refresh -s workflow` |
| Log says `refusing to kick the V1 repository` | The agent's `AID_REPO` points at V1 | Correct `AID_REPO`. Do not set `AID_ALLOW_V1` to silence it |
| Dispatches succeed, runs are skipped | `V2_DEPLOY` is not `true` | [2.1](#21-the-site-shows-headlines-may-be-delayed) |
| Two builds in a row every hour | The kick and a cron slot both built | Use minutes 5 and 35 (DEPLOYMENT.md section 10.1) |

The agent that exists on the Mac today belongs to **V1** (it dispatches "Refresh and deploy" in the
V1 repository; recorded in DEPLOYMENT.md section 1, not re-inspected for this document). Leave it
alone unless V2 replaces V1 on `main` (DEPLOYMENT.md section 10.2).

### 2.9 The Pages deploy fails

`[UNTESTED]` The `deploy` job runs only on `refs/heads/main` after a successful `build`. It calls
`actions/deploy-pages` up to three times (timeouts 120 s, 120 s, 300 s; waits of 30 s and 90 s),
then polls `status.json` for its own run id for 2 minutes (a miss is a warning, not a failure).

| Symptom | Diagnosis | Fix |
|---|---|---|
| Build fails at "Preflight": `wrong branch` | A scheduled run started on a default branch that is not `main` | Make `main` the default branch |
| Build fails at "Preflight": `site base` | `SITE_BASE` is not `/<repository>/` on a `*.github.io` host | Set the repository variables `SITE_BASE` and `SITE_URL` to the values the error prints |
| Build fails at "Check dist" | `dist/index.html`, `dist/data/v2/front.json` or `status.json` missing, or `public/data/v2/state.json` missing | A site build or data build defect; read the two preceding steps |
| All three deploy attempts fail | Pages not enabled with source "GitHub Actions"; the `github-pages` environment does not admit `main`; or a GitHub Pages incident ("in progress deployment" conflicts lasted over a minute in V1's history) | Check Settings > Pages and Settings > Environments, then `gh run rerun <run-id> --failed --repo $R`. The next scheduled build also deploys |
| Deploy green, "deploy verify" warning | The CDN had not picked up the new `status.json` within 2 minutes | None. Check again with a `?t=` query |
| Deploy green, blank page, assets 404 | `SITE_BASE` does not match the path the site is served from (only possible on a custom domain, which the preflight does not check) | Fix `SITE_BASE`; push or dispatch |
| Deploy failed but state moved on | `persist` runs whenever the build passed, also after a failed deploy, so the `data` branch can be one build ahead of the site | Harmless: the next deploy catches up |

The failure issue distinguishes the cases: "nothing was deployed" (build), "the data passed the gate
but all deploy attempts failed" (deploy), "this build's state was not saved" (persist).

### 2.10 Dependabot pull requests

`[UNTESTED]` `.github/dependabot.yml` takes effect only on the default branch.

| Fact | Value |
|---|---|
| Schedule | Mondays 07:00 America/Chicago, npm and GitHub Actions |
| Grouping | One PR for all npm minor and patch updates; npm majors one PR each; one PR for all Actions bumps |
| Limits | 3 open npm PRs, 2 open Actions PRs |
| Cooldown | A release must be 7 days old; security updates are not delayed |
| Held back | `typescript` majors and `@types/node` majors (remove the `ignore` entry to lift) |
| Check on the PR | `ci.yml` "Typecheck, test, build": read-only token, no secrets, no data gate |

Procedure for a PR:

1. Wait for the `ci.yml` check. Red: read the log; do not merge.
2. Read the release notes of anything in the data pipeline first (`fast-xml-parser` parses untrusted
   feeds on every build; `tsx` runs the pipeline). [SBOM.md](./SBOM.md) marks those packages
   `data-pipeline`.
3. For a pipeline package or any major: check the branch out and run
   `npm ci --ignore-scripts && npx tsc -b && npm test && npm run build`, then one live build and the
   gate: `env -u ANTHROPIC_API_KEY npm run build:data && npm run build:check`.
4. Regenerate the SBOM on the branch and commit it: `npm run sbom`. The lockfile or the pinned
   action SHAs changed, so `npm run sbom -- --check` fails until this is done (the weekly audit
   reports it as a warning, never as a failure).
5. Merge. The push to `main` starts `refresh.yml`, which runs typecheck and tests again before it
   builds and deploys. A failure there holds the deploy and opens "V2 refresh failing"; revert the
   merge commit.

Actions bumps change the commit SHA and the trailing `# vX.Y.Z` comment together;
`scripts/tools/workflows.test.ts` fails if an action is not pinned by SHA.

### 2.11 Rotating the Anthropic key

`[UNTESTED]` The key exists in one place: the repository secret `ANTHROPIC_API_KEY`. No file, no
variable and no other workflow step holds it.

1. Create a new key in the Anthropic Console (same workspace, with a monthly spend limit).
2. `gh secret set ANTHROPIC_API_KEY --repo $R` and paste the value at the prompt. Never pass it as
   a command argument or write it to a file.
3. Start a build: `gh workflow run refresh.yml --repo $R --ref main`.
4. Verify: `status.json` `.brief` is `{"source":"claude"}`; `brief.json` `.model` names the model;
   the "Build data" log has a line `brief: written by <model> from N stories`.
5. Revoke the old key in the Console. If a leak is suspected, revoke first and accept fallback
   briefs until step 4 passes.
6. Close the loop: "V2 Daily Brief failing" closes itself on the first build without the alert.

Local builds: a key exported in the shell is used and billed by `npm run build:data`. Use
`env -u ANTHROPIC_API_KEY npm run build:data` unless a keyed local build is the point.

### 2.12 Restoring state after loss

`state.json` is the pipeline's memory: first-seen ledger, per-source health and fail streaks,
last-good items with conditional-GET validators, the 7-day river memory, resolved Google News links,
the lead, the previous TOP list, the brief failure streak. It is 3.31 MB on 2026-11-20; the pipeline
refuses to write one above 24 MB. A missing, corrupt or foreign-schema file is read as empty state
(`scripts/pipeline/state/store.ts`); the build still succeeds.

What an empty-state build does (baseline run):

| Aspect | Effect |
|---|---|
| First-seen times | Dated items are stamped at their `publishedAt`, undated ones `maxAgeDays + 1` days ago, so the edition is not flooded with "new" |
| Fetches | No conditional GETs for one build (first local build 34.0 s; later builds 19-36 s with 184 to 202 of 413 answered 304) |
| River and search | Start from what the feeds list today; the 7-day memory refills over a week |
| Health | Fail streaks, quarantine and carry-forward copies are gone; a quarantined source is asked again every run until it re-earns quarantine |
| TOP and lead | No hold and no lead stickiness for one build |

In CI the restore order is: branch `data`, then a copy on the live site (present only with
`V2_PUBLISH_STATE=true`; it also wins when strictly newer), then empty.

| Symptom | Diagnosis | Fix |
|---|---|---|
| Run summary says "State restored from: **none (starting empty)**" on the first ever run | Expected | None |
| Same line on a later run, plus "V2 refresh failing" with "state restore (no saved state found - built from empty)" | The `data` branch is missing or its `state.json` is invalid | One such build after a failed persist is harmless: the build's own persist job rewrites the branch. If it repeats, check the `persist` job log and that `github-actions[bot]` may force-push `data` (no branch protection on it) |
| Persist keeps failing | `git push` to `data` rejected | Fix branch rules. Interim second copy: `gh variable set V2_PUBLISH_STATE --body true --repo $R` (the state is then published with the site and restored from there) |
| The lost history matters (river memory, fail streaks) | A good snapshot exists in an earlier run's `v2-state` artifact (7-day retention) | Manual restore below |
| Local: `public/data/v2/state.json` deleted | Next local build is a baseline run | None needed. With a live site that publishes its state: `STATE_URL="${SITE}data/v2/state.json" npm run build:data` downloads it when the local file is missing |

Manual restore from an artifact `[UNTESTED]` (mirrors the `persist` job; writes only to branch
`data`). Pause builds first with `gh variable set V2_DEPLOY --body false --repo $R`, so a running
persist job does not overwrite the restore, and set it back to `true` afterwards:

```bash
gh run list --repo $R --workflow refresh.yml --status success --limit 10
tmp="$(mktemp -d)"
gh run download <run-id> --repo $R --name v2-state --dir "$tmp/artifact"
jq -e 'type == "object" and .schemaVersion == 2' "$tmp/artifact/state.json"   # must print true
jq -r '.savedAt' "$tmp/artifact/state.json"

mkdir "$tmp/data" && cd "$tmp/data"
git init --quiet --initial-branch=data
cp "$tmp/artifact/state.json" state.json
git add -- state.json
git commit --quiet -m "data: state restored by hand from run <run-id>"
git push --force "https://github.com/$R.git" HEAD:refs/heads/data
```

Restoring a snapshot older than a few hours buys little: carry-forward copies expire after 6 h and items first seen since then
are re-stamped either way.

### 2.13 Rolling back a bad edition

There are three different "bad", with different answers.

| Case | What happened | Action |
|---|---|---|
| Structurally bad data | The gate held it. Nothing was published | None. Fix the cause ([2.2](#22-a-build-fails-the-gate)) |
| Editorially bad edition that passed the gate (a junk outlet on a homepage list, a wrong lead, a split story) | It is live until the next build replaces it (30 minutes at the designed cadence) | Fix the cause and push: pause or bound the source, add a deny-list entry, or adjust a rule. A push to `main` (outside `docs/**` and `*.md`) builds and deploys immediately |
| Bad code on `main` (blank page, broken layout, a failing test) | Typecheck or tests fail: the build stops and the last good deploy keeps serving. They pass but the page is broken: the broken site is live | `git revert <sha>` and push; the push rebuilds and redeploys. No history rewrite |

Stopping the line while you work: `gh variable set V2_DEPLOY --body false --repo $R` skips every job
from the next run on. The site keeps serving the **current** deploy, so this freezes a bad edition
too; it does not roll anything back. The stale banner appears after 2 hours.

Re-publishing an earlier edition as it was `[UNTESTED]`: nothing in V2 archives editions. Data is
not committed, and the `data` branch holds only the newest state. The one route is to re-run the
`deploy` job of an earlier successful run while its Pages artifact still exists
(`gh run rerun <run-id> --job <deploy-job-id> --repo $R`; the job id is in
`gh run view <run-id> --repo $R --json jobs`). The retention of that artifact is whatever
`actions/upload-pages-artifact` defaults to (the workflow sets none; believed to be 1 day, not
verified). The dependent `persist` job re-runs with it and puts that run's state back on `data`, so
site and state stay consistent; the next build then continues from there. Treat this as a last
resort and test it once before it is needed.

Locally there is nothing to roll back: `npm run data:fixture` reinstalls the committed fixture (it
overwrites the 8 public JSON files and leaves `state.json`, `feed.xml` and `feeds.opml` alone), and
`npm run build:data` writes a new edition.

Rolling V2 itself back to V1 is a deployment decision: DEPLOYMENT.md sections 9.3 and 9.4.

---

## 3. Routine tasks

| Task | When | Command | Network | Expected on 2026-11-20 |
|---|---|---|---|---|
| Health glance | Any time | `npm run build:check` | no | `PASS  data gate passed` `[LOCAL]` |
| Weekly feed audit | Mondays; CI does it at 12:23 UTC once `V2_DEPLOY` is `true` | [3.1](#31-weekly-feed-audit) | yes | 413 of 413 OK, exit 0, 21 s (04:20Z, integration step) |
| Monthly link check | First week of the month | [3.2](#32-monthly-link-check) | yes | 0 broken in the registry |
| Dependency updates | When Dependabot opens a PR; otherwise monthly | [3.3](#33-dependency-updates) | yes | `npm audit`: 0 vulnerabilities |
| SBOM regeneration | After any change to `package-lock.json` or a workflow `uses:` line | [3.4](#34-sbom-regeneration) | no | `SBOM is current` `[LOCAL]` |
| Fixture refresh | When tests should run on newer data, or the frozen day looks too old in demos | [3.5](#35-fixture-refresh) | yes (the build) | Dry run: `gate PASS` `[LOCAL]` |
| Source list | After a registry change and the next data build | `npm run docs:sources` | no | 414 sources, 597 lines |

### 3.1 Weekly feed audit

In CI: `feed-audit.yml` (cron `23 12 * * 1`, or `gh workflow run feed-audit.yml --repo $R --ref main`)
runs `npm audit --audit-level=high`, `npm audit signatures`, `npm run validate:feeds`, the link
check and `npm run sbom -- --check`, then files two rolling issues: "Feed audit: ..." (opened,
edited, closed by `scripts/tools/report-feed-audit.ts`) and "Dependency audit failing". The run goes
red only for high or critical advisories, a signature failure, or the audit itself breaking. Dead
feeds do not turn it red; the issue is their signal. The "Feed audit:" issue is looked up by title
prefix and bot author, and a failed lookup fails the report step in GitHub Actions, so a token or
API problem cannot silently lose that signal (closing round). `[UNTESTED]` on GitHub.

Locally (not run for this document; last run 2026-11-20 04:18Z by the integration step). Both
network tools refuse an unknown argument and answer `-- --help` without a request:

```bash
npm run validate:feeds -- --out node_modules/.tmp/feed-audit.json   # exit 1 = actionable problems
npm run validate:feeds -- --include-paused                           # also re-tests paused sources
npm audit --audit-level=high
npm audit signatures
```

| Verdict | Meaning | Action |
|---|---|---|
| `OK` | Parses, has items, newest item under 60 days old (365 for sources tagged `low-cadence`) | None |
| `STALE` | Newest item older than the limit | Check the site; pause the source, or tag it `low-cadence` if months of silence are normal |
| `EMPTY` | Valid response, 0 usable items | Check once by hand |
| `NOT_FEED`, `PARSE_FAIL`, `NO_CARDS`, `HTTP_404`, `HTTP_410` | The endpoint changed | [2.3](#23-a-source-is-failing-carried-forward-or-quarantined) |
| `HTTP_403`, `HTTP_429`, `HTTP_502`-`504`, `TIMEOUT` | Blocked or transient; reported, never fails the run | Act only when it repeats across audits |
| `redirected` | The final URL is on another host | Update `url`, with one exception: `hf-daily-papers` redirects to a dated URL that changes daily. Leave it |

Then re-test paused sources (`venturebeat-ai` is the only one) and review the 12 `probation` tags:
remove the tag from a source that has been OK from CI for a month.

### 3.2 Monthly link check

```bash
npm run check:links -- --data          # registry + docs + up to 300 article URLs of the river
npm run check:links -- --data --strict # exit 1 on any broken or flaky link (not used in CI)
```

The full check was not run for this document (network; last run 2026-11-20 04:25Z); the docs
group alone was re-run at 05:47Z with `-- --no-registry`: 1,908 URLs, 1,866 ok, 4 broken, 7 flaky,
31 blocked ([HANDOFF.md](./HANDOFF.md) section 5.8). Reports: `node_modules/.tmp/link-report.json` and `.md`
(`--out <path>` moves them). Budget 600 s; at most 2 requests per host at a time. Exit code is 0
without `--strict`.

| Group | Counted | Result of the 2026-11-20 04:25Z run (2,227 unique URLs) |
|---|---|---|
| registry | yes | 787: 760 ok, 0 broken, 2 flaky, 25 blocked |
| docs | yes | 1,906: 1,869 ok, 4 broken, 6 flaky, 27 blocked |
| archive (`docs/archive/**`) | no | 74: 67 ok, 7 broken |
| data | yes | 292: 218 ok, 0 broken, 2 flaky, 72 blocked |

Reading the result:

- **Blocked** (401 / 403 / 406 / 429) is a bot wall, not a dead link.
- The 4 broken docs URLs of 2026-11-20 are known: the model API endpoint (POST-only, answers 405),
  the V2 repository and the V2 site (404 until go-live), and one feed cited as dead on purpose in
  SOURCE_RESEARCH.md. The first and the last were rewritten without their scheme after the 05:47Z
  run, so the next run should report 2.
- The tool does not check relative Markdown links between docs. Check those by hand after moving a
  file.
- A broken registry `homepage` is cosmetic; a broken registry feed URL is a source failure
  ([2.3](#23-a-source-is-failing-carried-forward-or-quarantined)).

### 3.3 Dependency updates

Dependabot is the normal path ([2.10](#210-dependabot-pull-requests)). By hand, on a branch
(`[UNTESTED]` in this round: no dependency was changed):

```bash
npm outdated                                  # what is behind
npm install <package>@<version>               # one package at a time; updates package-lock.json
npm ci --ignore-scripts                       # the install CI performs
npx tsc -b && npm test && npm run build
npm audit --audit-level=high && npm audit signatures
env -u ANTHROPIC_API_KEY npm run build:data && npm run build:check   # for pipeline packages
npm run sbom                                  # then commit docs/SBOM.json and docs/SBOM.md
```

Constraints: Node is pinned for CI in `.node-version` (24) and `engines` requires >= 22.15.0;
`typescript` 7 and `@types/node` majors are deliberately held (see `.github/dependabot.yml`). The
browser bundle has two runtime dependencies, `react` and `react-dom`.

State on 2026-11-20 (integration round): `npm audit` 0 vulnerabilities; `npm audit signatures` 59
verified signatures and 35 attestations for the packages installed on macOS. The lockfile lists 125;
the other 66 are platform binaries for other systems and were not checked there.

### 3.4 SBOM regeneration

```bash
npm run sbom -- --check   # exit 1 when docs/SBOM.json is not what the tool would write
npm run sbom              # rewrite docs/SBOM.json and the generated tables of docs/SBOM.md
```

`[LOCAL]` `--check` printed `SBOM is current: docs/SBOM.json (125 npm packages, 6 GitHub Actions, 7 services).`
The generator (`scripts/generate-sbom.ts`) needs no network. It is deterministic: the timestamp is
kept while the content is unchanged, so a regeneration without a change rewrites the same bytes.
Commit both files with the change that caused them. Not validated against the official CycloneDX
1.6 JSON schema.

### 3.5 Fixture refresh

`test/fixtures/v2/` is a frozen live build (today: 2026-11-20T05:16Z) that tests run on and
`npm run data:fixture` installs. Full rules: [CONTRACTS.md section 12](./CONTRACTS.md).

```bash
env -u ANTHROPIC_API_KEY npm run build:data   # 1. a keyless build (network)
npm run fixture:refresh -- --dry-run          # 2. report only
npm run fixture:refresh                       # 3. rewrite test/fixtures/v2/*.json and v2.manifest.json
npx tsc -b && npm test                        # 4. must stay green
```

`[LOCAL]` Step 2 on the current data: `gate PASS (guards, invariants, content rules, fixture cases)`,
`dry run: nothing written`.

| It refuses when | Fix |
|---|---|
| The gate would hold the build | Freeze another build |
| The brief is not the keyless fallback | Rebuild with `env -u ANTHROPIC_API_KEY`; model output is never committed |
| A case tests select is missing (paywalled row, `w` 3 / 2 / 0, newsletter row, regulator notice, re-leadable multi-publisher lead, release, thread, link-host outlet, cross-listed story, every health state, a paused source) | Freeze another build; never hand-edit the fixture (`data:fixture` rejects files that do not match the manifest) |

Know before you run it: the refresh writes synthetic `health.json` rows onto `probation` sources
for every health state the build itself lacks (three in the committed fixture: host backoff,
failing, quarantined; its carried row is real; all listed in the manifest), which makes the
fixture's gate report `feeds: 3 chronic`. Four search and watch page tests pick their queries from the fixture
and are not guarded by the refresh tool; a new day's data can pass step 3 and fail step 4 with a
`fixture: ...` message that says what is missing.

---

## 4. Reference

### 4.1 Rolling issues

| Title | Opened by | Opens when | Comment rate | Closes when |
|---|---|---|---|---|
| V2 refresh failing | `refresh.yml` `alert` | A job failed or timed out, or a build found no saved state while the site is up | At most every 180 minutes | The next run that restores its state, builds, deploys and persists |
| V2 Daily Brief failing | `refresh.yml` `alert` | The gate's brief alert (6 failed keyed builds in a row) | At most daily | The first build whose gate raises no brief alert |
| Feed audit: ... | `feed-audit.yml` `report` | Actionable source problems in the weekly audit | Edited in place | An audit without problems |
| Dependency audit failing | `feed-audit.yml` `report` | `npm audit` (high or critical) or `npm audit signatures` failed | Every failing weekly audit | The first audit in which both pass |

A run the owner cancels by hand touches no issue. Alerts are filed only from `refs/heads/main`.

### 4.2 Numbers that drive behaviour

| Constant | Value | File |
|---|---|---|
| Designed cadence / stale threshold | 30 min / 120 min | `scripts/pipeline/context.ts` `PIPELINE` |
| Guard freshness window | 20 min | `.github/workflows/refresh.yml` |
| Data build hard limit | 12 min | `refresh.yml` "Build data" |
| Carry-forward / quarantine / probe | 6 h / 48 fails / 24 h | `PIPELINE` |
| Host backoff | 2 consecutive 5xx or 429 per host | `scripts/pipeline/ingest/pool.ts` |
| HTTP defaults | 8 s to headers, one 16 s retry after a timeout, 3 attempts, 5 MiB body | `scripts/pipeline/ingest/http.ts`, `PIPELINE.maxBodyBytes` |
| Per-source cap | 8 kept items after relevance (`maxKept` overrides) | `PIPELINE.sourceCap` |
| TOP STORIES | at most 12; window 72 h (120 h relaxed) | `shared/contract.ts`, `PIPELINE` |
| Gate thresholds | [2.2](#22-a-build-fails-the-gate) | `scripts/pipeline/emit/quality.ts` `GATE` |
| River | 7 days | `shared/contract.ts` `RIVER_DAYS` |
| Client refresh | every 10 min while visible | `src/app/services.ts` |

---

## 5. Commands verified for this document

Run in this working tree on 2026-11-20, about 04:30 UTC, Node 26.7.0, and re-run at 05:25 to
05:40 UTC against the closing build of 2026-11-20T05:16:55Z in `public/data/v2/` (the first six
rows and the first kick-script row; the other rows were not repeated).

| Command | Result |
|---|---|
| `npx tsc -b` | exit 0 |
| `npm test` | 2,782 tests, 449 suites, 0 fail, about 19 s |
| `npm run build:check` | `PASS  data gate passed`; 412/413 feeds ok and 1 carried, 322 stories, 367 rows, 143 homepage rows, 12 top |
| `npm run sbom -- --check` | `SBOM is current` |
| `npm run fixture:refresh -- --dry-run` | `gate PASS`, nothing written |
| `npm run explain -- "FINRA Regulatory Notice"` | 2 stories and 5 dropped items explained (RN 26-24: POLICY #6, homepage, with its section-focus line) |
| `npm run explain -- "Anthropic shares jump"` | "not in TOP STORIES: a follow-up of the running story ..." |
| `AID_DRY_RUN=1 bash scripts/kick-refresh.sh` | Target `PNelsonFTP/ai-drudge-v2`, `refresh.yml`, `main`; nothing dispatched |
| The same with `AID_REPO=https://github.com/PNelsonFTP/ai-drudge.git` | exit 1, `refusing to kick the V1 repository` |
| The same with `AID_ALLOW_V1=1 AID_REPO=PNelsonFTP/ai-drudge` | Dry run accepted (nothing dispatched) |
| The `jq` filters in sections 1.3, 2.3, 2.6 and 2.7 | Ran on local files |

## 6. Not verified

- Every `gh`, `git push`, `launchctl` and GitHub Settings step: the V2 repository, its Pages site
  and a V2 launch agent do not exist.
- The three workflows on GitHub, including the issue steps, the state hand-over through the `data`
  branch and the removal of `state.json` from the Pages artifact.
- The Claude brief, its failure codes against the real API, and key rotation.
- Re-running a `deploy` job to republish an earlier edition, and the retention of the Pages artifact.
- Quarantine and host backoff on live data: no source reached either state in the builds of
  2026-11-20, so these paths are covered by tests and by the fixture's synthetic rows only.
  Carry-forward ran once on live data (one source, HTTP 429, in the closing build).
- `npm run build:data`, `npm run validate:feeds`, `npm run check:links`, `npm audit` and
  `npm outdated` were not run for this document; their results are quoted from the final round
  of 2026-11-20.
- Banner texts were read from `src/features/chrome/model.ts`, not seen in a browser.
