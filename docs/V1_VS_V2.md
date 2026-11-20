# AI DRUDGE — V1 vs V2

Written 2026-11-20 for the owner and brought up to the closing build of the same day
(05:16Z). Read this first; the detail is in the linked documents.

**Answer first.** V2 reads twice as many sources, groups coverage by publisher instead of by feed,
and puts the day's story on top as one story with every outlet attached (31 publishers on
2026-11-20, where V1 listed it as "2 sources"). No headline is repeated across sections, 412 or
413 of 413 sources answered in each measured build, the dead scrapers are back, the code has 2,782
tests instead of 8, and the CI design is least-privilege. Against that: V2 is **not deployed and has never
run on GitHub**, it was not checked in a browser in the last two rounds, its first load is heavier
than V1's, its homepage skews older, and its ranking rules were tuned on a single news day and
still let off-beat stories into TOP STORIES. V1 stays live and untouched until you decide.

## 0. What was compared

| | V1 | V2 |
|---|---|---|
| State | Live at https://pnelsonftp.github.io/ai-drudge/ from branch `main` | Uncommitted working tree on branch `v2`; local only |
| Edition measured | Production payload of 2026-11-19T20:08:38Z, frozen in `test/fixtures/v1/2026-11-19/` | Local build of 2026-11-20T05:16:55Z in `public/data/v2/` (the "closing build", made after the last code change; "build 1" is 03:34:11Z and "build 2" 04:16:25Z) |
| Longer-run evidence | The 17-dimension review of 2026-11-19: up to 2,186 workflow runs and 1,150 production snapshots | None. 12 completed local builds between 00:52Z and 05:16Z on 2026-11-20, all from one workstation |

The two editions are 9 hours apart, so the table compares structure, not the same headlines. One
same-moment comparison exists: the live V1 payload of 04:08Z against V2's build 2 of 04:16Z
([section 5](#5-how-to-compare-for-yourself)).

Source of each number:

| Key | Meaning |
|---|---|
| F1 | Measured for this document from the frozen V1 payload (`headlines.json`, `headlines-preview.json`) with a script, 2026-11-20 |
| R1 | The V1 review of 2026-11-19, as recorded in [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) Part 1 and [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) sections 4-5. Not re-measured |
| D2 | Measured for this document from `public/data/v2/*.json` (the closing build) |
| G2 | The gate report of the closing build (`npm run build:check`, re-run for this document) and its build log |
| S2 | `npm run build` log of the closing round, 2026-11-20 (Vite's own size report) |
| T2 | `npm test` and `npx tsc -b`, re-run after the last code change on 2026-11-20 |
| I2 | Reports of the final round's integration step, 2026-11-20 (builds 1 and 2). Not re-run |
| C | `npm run compare`, run against build 2 |
| W | Read from the workflow files; never executed on GitHub |

## 1. Measured comparison

### 1.1 Sources

| Metric | V1 | V2 | Source |
|---|---|---|---|
| Sources registered | 207 (203 feeds + 4 scrapers) | 414 (413 active, 1 paused) | F1, R1 / D2 |
| Sources healthy in the measured build | 185 of 207 (89%) | 412 of 413 in the closing build (one arXiv query answered HTTP 429 and its last-good items were carried forward); 413 of 413 in build 1, build 2 and the feed audit | F1 / G2, I2 |
| Same, over time | 185-194 OK over 61 sampled builds; a median of 17 sources failed every build; 15 sources succeeded in 5% or fewer CI runs | Not measured. V2's numbers come from one workstation; V1's from GitHub runners, where bot walls are stricter | R1 / — |
| Dead scrapers | 2 of 4: both Anthropic scrapers returned 0 items on every build from 2026-10-20, unnoticed for 30 days | 0 of 19 scrape sources; `anthropic-news` 15 items, `anthropic-research` 12 | R1 / D2 |
| Who counts as a publisher | Nobody: Trending counted feed names | 405 publisher entries (317 own a source); a story's count is distinct publishers | R1 / D2, registry |
| Memory between builds | None: failed feeds were retried every run and their items came and went | Conditional GET (185 of 413 answered 304), carry-forward 6 h, quarantine after 48 failures | R1 / G2 |
| Source kinds | RSS plus 4 hand-written scrapers | rss 249, newsletter 57, github-release 37, query 23, scrape 19, json 15, papers 9, community 4, aggregator 1 | R1 / D2 |

### 1.2 The edition

| Metric | V1 | V2 | Source |
|---|---|---|---|
| Sections | 18 | 15 | F1 / D2 |
| Homepage rows | 185 slots (10 per section, 15 in one) | 143 rows (5 to 12 per section) | F1 / D2 |
| Distinct stories on the homepage | 140 | 142 | F1 / D2 |
| Full edition | 274 distinct URLs across the "view all" lists | 322 stories in 367 rows, plus a 7-day river of 1,086 searchable rows | F1 / G2, D2 |
| Homepage rows that repeat a story shown in another section | 45 of 185 (24%) | 1 of 143, deliberate (a runtime release line shown in LOCAL and in RELEASE RADAR) | F1 / D2 |
| Multi-publisher stories | 6 Trending entries; 2 of them have two independent publishers | 64 stories with 2+ publishers (44 of them placed) | F1 / G2, D2 |
| Size of the lead story | One article. The day's story (Anthropic IPO) was Trending #5 labelled "2 sources"; Trending #1 was a $47M robotics round | One story: 31 publishers, 53 articles | F1 / D2 |
| Duplicates in the top list | 3 of 6 Trending entries are one publisher counted twice (OpenAI News + OpenAI Blog twice, TechCrunch AI + TechCrunch Startups); 1 is a false merge (llama.cpp with llama_index) | 12 distinct stories, each with 2+ publishers; 3 follow-ups of the IPO folded under it. Three false merges found by the final audit were split in the closing round. Still open: same-event pairs that do not merge (section 4, item 9) | F1 / D2, G2 |
| Top-list precision over time | 34.2% of 9,928 Trending entries had two independent publishers (2 months) | Not measured over time | R1 / — |
| Off-mission rate | About 26% of articles reaching an AI-section top 10 were not about AI (title lexicon, 30 days) | Hand-labelled sample of 60 items that passed the AI gate: 51 on-mission, 4 borderline, 5 false (85% strict, 92% lenient); 60 of 60 sampled drops correct. Different method: not directly comparable. In the closing build two items from a general publisher's AI topic feed are in TOP STORIES (#6 and #8) under headlines that do not name AI | R1 / I2, D2 |
| Median age of a homepage row | 4.2 h (180 dated slots, 5 undated; build at 20:08Z) | 12.3 h (143 rows; build at 05:16Z) | F1 / D2 |
| Daily Brief written by a model | Never: 0 of 2,139 data commits. A deterministic fallback was shown instead | Never: every build was keyless. No brief is shown unless a model wrote it | R1 / G2 |
| Stock ticker | 8 symbols | The same 8 symbols, 8 of 8 priced, with market state and "as of" time | F1 (`stocks.json`) / G2 |

### 1.3 Engineering and operations

| Metric | V1 | V2 | Source |
|---|---|---|---|
| Tests | 8, not run in CI | 2,782 in 449 suites, 0 failing, about 19 s; `npx tsc -b` exit 0. The refresh workflow runs both before every data build | R1 / T2, W |
| Lockfile packages | 190 | 125 | R1 / D2 |
| Browser runtime dependencies | `react`, `react-dom` | `react`, `react-dom` | R1 / `package.json` |
| `npm audit`, full tree | 7 advisories (6 high, 1 moderate) on 2026-11-16, including the feed parser. CI printed 0 because it ran `--omit=dev` | 0 vulnerabilities; 59 registry signatures and 35 attestations verified | R1 / I2 |
| Bill of materials | — | CycloneDX 1.6: 132 components, 7 services; `npm run sbom -- --check` says current | — / T2 |
| Entry JavaScript | 224 KB raw / 69.3 KB gzip | 338.58 kB raw / 108.20 kB gzip (**larger**; the 85 kB target is not met) | R1 / S2 |
| Bytes before anything is readable | 113.6 KB gzip | About 162 KB gzip: `index.html` 1.37 + entry JS 108.20 + entry CSS 8.63 + `front.json` 43.9 (**larger**) | R1 / S2 + G2, summed |
| First-paint data file | `headlines-preview.json` 136.3 KB raw / 35.2 KB gzip | `front.json` 143.2 KB raw / 43.9 KB gzip (budget 48) | F1 / G2 |
| Full data | `headlines.json` 373.4 KB raw / 73.2 KB gzip | `front` + `rest` + `river`: 485.3 KB raw / 167.6 KB gzip, loaded in three steps; all published files (8 JSON, `feed.xml`, `feeds.opml`) 763,903 bytes | F1 / G2, D2 |
| Data in git | 4 JSON files committed to `main` on every run: 99.2% of commits and 70 of 72 MB of the repository | None. Data lives in the Pages artifact; pipeline state is one orphan commit on a `data` branch | R1 / W |
| CI permissions | One job held `contents`, `pages` and `id-token` write plus the API key while running install scripts of 190 packages and parsing 203 untrusted feeds; actions pinned by tag | Workflow default `permissions: {}`. Five jobs: guard none; build `contents: read`; deploy `pages: write` + `id-token: write`; persist `contents: write`; alert `issues: write`. `npm ci --ignore-scripts`; actions pinned by commit SHA; the API key on one step, on `main` only | R1 / W |
| Publish gate | Never failed in 1,000 runs; 33 runs redeployed old data and stayed green | Freshness, structure and content gate ([RUNBOOK.md section 2.2](./RUNBOOK.md#22-a-build-fails-the-gate)); passes every local build; its holds are proven by tests only | R1 / G2, T2 |
| Failure signal | None. The weekly audit was red for 13 weeks unnoticed | Four rolling issues and a reader banner after 2 hours | R1 / W |
| Refresh cadence | About hourly, driven by one Mac; gaps p50 58 min, p95 197 min, max 417 min | Designed for 30 minutes. Not run | R1 / W |
| Build duration | Workflow median 57 s end to end | Data build 19.3 s, 35.6 s and 23.4 s locally; duration on GitHub unknown | R1 / I2, G2 |

Size units: V1 and V2 data files were gzipped the same way for this table (level 6, 1 KB = 1,024
bytes). The V1 review recorded 36.5 and 76.3 KB gzip for the same two files. Bundle sizes are Vite's
(1 kB = 1,000 bytes).

### 1.4 Accessibility

| Metric | V1 | V2 | Source |
|---|---|---|---|
| Colour contrast | 43 distinct text / background pairs failed WCAG AA (37 light, 30 dark); two dialogs rendered at 1.16:1 | 43 declared contrast rules in `src/styles/tokens.css`, checked in both themes by `src/styles/contrast.test.ts`: 0 failing | R1 / T2 |
| Keyboard | 623 tab stops; no skip link, no `h1`, no `nav`; a source could not be muted from the keyboard | Skip link, one `h1`, `nav` and `main` landmarks; single-key shortcuts with an off switch. 443 tab stops on the 143 homepage section rows (2 to 5 per row); the whole-page count was not measured | R1 / code, I2 |
| Summaries and related coverage | Only in a hover card that keyboard and touch users could not reach | Inline row actions (summary, "Also" coverage, bookmark, later, mute); the hover card is a mouse-only extra | R1 / code |
| Touch targets | Not recorded | 24 px minimum row and chip targets by CSS arithmetic (`src/features/headline/geometry.test.ts`) | — / I2 |
| Verified with a browser or a screen reader | By computation only | **No.** By computation and server-side rendering tests only | R1 / I2 |

## 2. What you will notice

1. **One lead, with its coverage.** On 2026-11-20 the top of the page is "Anthropic prices initial
   public offering" with 31 publishers attached. V1 showed one article as the lead and, in a
   separate Trending box, the same event as "2 sources" below a $47M robotics round.
2. **TOP STORIES replaces the Trending box and the separate Lead.** Up to 12 stories ranked by
   coverage and freshness, each with its publisher count and an inline "Also:" line naming the
   other counted outlets (the first 8, then "Show N more"); links from outlets that do not count as
   coverage follow under "also linked:". A LATEST strip follows, as in V1.
3. **No headline twice.** V1 repeated a URL in 45 of its 185 homepage slots. V2 lists a story in
   its home section and at most one other, and gives it one homepage row.
4. **15 sections instead of 18**, in a new order: MODELS & LABS, INDUSTRY, AI SECURITY, LOCAL & OPEN
   MODELS, AGENTS & TOOLS, POLICY & REGULATION, MARKETS & DEALS, then the rest. CYBER WIRE and
   QUANTUM WATCH are owner-interest sections: they keep their place on the page and never feed TOP
   STORIES, the lead or the brief.
5. **Regulators' own notices appear.** POLICY & REGULATION shows FINRA Regulatory Notice 26-24, a
   Bank of England paper, the FCA and IOSCO on its homepage list in the closing build, and the SEC
   inquiry into Nvidia as its own story at #4. V1's 30-day corpus had no FINRA mention at all.
6. **Release tags no longer pose as news.** V1 led MODEL RELEASES with "llama.cpp b12549 released".
   V2 keeps one line per repository in RELEASE RADAR, never in TOP STORIES; LOCAL & OPEN MODELS
   shows up to two runtime release lines (llama.cpp in the closing build), never in its first
   three rows, and not when a news row already names the project.
7. **Time chips and "new since last visit".** NEW · 6H · 24H · 3D · ALL filter the front page; `#/new`
   lists what arrived since your last visit. A story counts as new when any outlet's coverage is new.
8. **Search is a page and covers seven days.** `#/q/<words>` searches the edition and a 7-day
   river, never matches mid-word (a short word still finds a versioned name: "qwen" finds
   "Qwen4-Max"), and accepts `source:` and `section:`. `#/watch` keeps a watchlist
   with three presets (CISO, Local LLM, Finance regulation).
9. **It works without a mouse.** `j` / `k` move, `o` opens, `b` bookmarks, `l` saves for later, `s`
   shows the summary, `a` the other coverage, `m` mutes the source, `/` searches, `[` / `]` jump
   sections, `?` lists the keys. Muting a source re-leads a story with the next outlet instead of
   removing it.
10. **The page says what state it is in.** `#/sources` lists all 414 sources with their health;
    subscription sources carry a paywall marker; minor sources are grey italic; a banner appears
    when the edition is more than 2 hours old; `#/settings` has backup, restore, a one-time import
    of your V1 bookmarks and mutes, themes and density; "Briefing" exports the day as Markdown or
    text.

None of the ten was looked at in a browser in the last two rounds; they are verified by tests and
by reading the code.

## 3. What was removed or changed on purpose

### 3.1 Sections: 18 to 15

| V1 category | V2 section | Change |
|---|---|---|
| MODEL RELEASES | MODELS & LABS | Renamed; lab news and model releases together; 5 / 10 day window |
| INDUSTRY NEWS | INDUSTRY | Renamed; holds only its own sources (no keyword routing in) |
| LOCAL MODELS + OPEN SOURCE | LOCAL & OPEN MODELS | **Merged** |
| AGENTS & TOOLS + PRODUCTS | AGENTS & TOOLS | **Merged** |
| AI FINANCE + FUNDING & DEALS | MARKETS & DEALS | **Merged** |
| RESEARCH | RESEARCH | Kept |
| HARDWARE | CHIPS & COMPUTE | Renamed |
| SAFETY & POLICY | POLICY & REGULATION and SAFETY & ALIGNMENT | **Split** |
| AI SECURITY | AI SECURITY | Kept; moved up to third |
| CYBER THREATS + CYBER DEFENSE | CYBER WIRE | **Merged**; owner desk |
| ANALYSIS | ANALYSIS | Kept |
| ROBOTICS | ROBOTICS | Kept |
| QUANTUM | QUANTUM WATCH | Renamed; owner desk |
| GITHUB REPOS | RELEASE RADAR | Renamed; reference list, one line per repository |

The mapping is `LEGACY_TO_SECTIONS` in `shared/sections.ts`. A V1 section mute carries over only
when every V1 category folded into the V2 section was muted (muting half must not hide the other
half); Settings names the mutes that were not carried.

### 3.2 Removed or changed

| What | Reason |
|---|---|
| The Trending box and the separate Lead | Trending counted feeds, so one publisher's twin feeds made a "trend" (34% of entries were real). The lead was the single highest-scoring article and changed in 40% of builds. TOP STORIES ranks stories by score with publisher count |
| The Daily Brief fallback text | V1 always showed a deterministic line and never a model's; on IPO day it named a $47M robotics round the top AI story. V2 shows a brief only when a model wrote it and names the model |
| 11 V1 sources | Recorded with reasons in `scripts/registry/sources/removed.ts` and in [SOURCES.md](./SOURCES.md): 1 duplicate (the OpenAI Blog twin of OpenAI News), 3 off-mission (Bloomberg Markets, MarketWatch, GovAI's job feed), 2 low-quality, 5 dead (two subreddits after Reddit ended RSS, among others) |
| Outlets nobody vouches for | In query feeds (Google News), an outlet without a registry publisher entry is shown at the lowest tier, never leads and does not raise a publisher count. 10 outlets are denied outright with recorded evidence. This lowered two security stories' counts on 2026-11-20; adding a publisher entry restores an outlet |
| Per-source cap of 6 newest items, applied before relevance | It dropped OpenAI's own GPT-6.2 launch post while wire items kept their slots. V2 caps at 8 after relevance and rescues over-cap items that another publisher corroborates |
| Emphasis by feed priority (red and bold) | Replaced by story weight from publisher count: 8+ publishers, 3+ publishers or a first-party launch, default, and de-emphasised for a single low-tier source |
| GitHub release lines in topic sections and Trending | One line per repository, in RELEASE RADAR; a release can never be a top story |
| Hacker News searches through hnrss.org | It answered 502 to 4-7 of 11 searches per build. V2 reads the official HN search API |
| Stooq as stock-quote source | It answered 404; every quote V1 shipped already came from the fallback provider |
| The grey "stale" dim after 72 hours | Sections with 14-21 day windows would be mostly grey; the age label carries the information. Seen headlines dim instead (switchable) |
| Mutes and feed-health dialogs | Unreadable in V1's default theme (1.16:1). Both are on the Sources page |
| Hover card as the only way to a summary | Now a mouse extra; the row has the same actions inline |
| Data commits to `main` | Nothing is committed; a build that fails the gate publishes nothing |
| `ai-drudge:*` storage keys | V2 uses `aid2:` and reads V1's keys once, never writes them, so V1 keeps working on the same origin |
| 10 rows per section everywhere | 5 to 12 homepage rows by section, 15 to 40 in "view all"; 3 rows per section on a phone until expanded |
| Newest-first inside a section | Rows are ordered by score (source tier, recency with a 36 h half-life, importance, coverage, Hacker News). This is why the median homepage row is older than V1's |
| Stale threshold | A reader banner after 120 minutes without a new edition. V1 had no signal |

## 4. What is not better yet

Ranked by how much it should weigh on a go-live decision. Ranks and counts are those of the closing
build (05:16Z) unless a line names another build.

1. **Nothing has run on GitHub, on Linux or on Node 24.** The V2 repository and site do not exist.
   The three workflows, the state hand-over through the `data` branch, the alert issues, Dependabot
   and `npm test` on a clean Linux runner are verified by local tests and by reading only. V2's
   source health is from a home network; 12 sources are tagged `probation` because V1's history
   says CI runners get blocked.
2. **Nothing was checked in a browser in the last two rounds.** That covers the lazy keyboard and
   hover chunk, both new banners, italic low-tier titles, the compact rows, the production
   Content-Security-Policy and everything in section 2.
3. **The first load is heavier.** Entry JavaScript is 108.20 kB gzip against V1's 69.3 kB, and about
   162 KB arrive before the page is readable against 113.6 KB. The React runtime alone is about
   67.5 kB, so the 85 kB target needs a lighter renderer or a prerendered shell.
4. **TOP STORIES still admits off-beat and very young stories.** In build 2 an energy permitting
   bill entered at #3 and a White House personnel change at #9 within 42 minutes, both from a
   general publisher's "AI" topic feed, above a 6-publisher model launch. The closing round capped
   the recency a story with fewer than 3 publishers can count for TOP; in the closing build the
   bill is #6 and the personnel change #8, and the bill is still POLICY #1 under a headline that
   does not say why it is AI news.
5. **TOP under-serves your stated priorities.** Two AI security stories (#3 and #11), none on local
   or open models, none on financial regulation. Ten homepage stories name Nvidia or its former
   chief executive and seven name Anthropic.
6. **Regulator coverage is thin at the source.** The SEC inquiry on POLICY (#4) is wire coverage
   found by a query feed; no item of the SEC's own feeds is in the edition or the 7-day river.
   `nist` and `cisa` are named in the regulator floor but inert until their feeds are tagged
   `regulator` (your decision).
7. **Section weak spots.** MARKETS & DEALS "view all" rows 11 to 18 are all the IPO or its fallout.
   MODELS & LABS rows 6 to 10 are thin, and Qwen4-Max never reached a homepage row (MODELS #19).
   QUANTUM WATCH has 6 rows, the oldest 327 hours, and 4 of its 5 homepage rows come from
   lowest-tier sources. "View all" lists still carry a few low-signal rows.
8. **The homepage is older.** Median row age 12.3 h against V1's 4.2 h. Part is deliberate (score
   order, long windows for policy and analysis), part is the hour of the build; it was not measured
   at V1's hour.
9. **Story grouping still splits some events** (China chip sales: FT and Reuters; the AI Safety
   Caucus: The Record and Politico; an Apple agent pair) and its newest rules, including the three
   vetoes that split false merges in the closing round, rest on one day's examples. The TOP hold
   was never exercised. Churn at the 30-minute cadence is unmeasured: the only evidence is one
   42-minute gap (lead unchanged, 10 of 12 TOP stories and 134 of 143 homepage rows the same).
10. **The Daily Brief has still never been written by a model**, and without a key V2 shows no
    brief at all, where V1 showed its fallback line.
11. **V1 items you may miss.** At the same moment (V1 04:08Z, V2 build 2), 73 of V1's 131 articles
    were placed in V2 and 17 more were searchable; 41 were gone (16 from removed sources or outside
    the feed window, 8 excluded, 7 folded release tags, 10 capped, too old or filtered as
    off-topic). The two V1 local sections overlap least: 1 of 10 and 0 of 10 rows shared with LOCAL
    & OPEN MODELS.
12. **Operations debt.** Pipeline state has one copy by default (the `data` branch) and is 3.31 MB;
    no server-side alert fires when no run starts at all; feed parsing and the model call share one
    process; V2 on the default Pages host shares its origin, and therefore browser storage, with V1.
    See [SECURITY.md](./SECURITY.md) and [DEPLOYMENT.md](./DEPLOYMENT.md) section 15.

The full list, 58 rows with the file to open for each: [HANDOFF.md](./HANDOFF.md) section 7 and
[FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md) ("Known defects"). What each review round found:
[REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md).

## 5. How to compare for yourself

Side by side in two browser windows:

| | URL |
|---|---|
| V1, live | https://pnelsonftp.github.io/ai-drudge/ |
| V2, local | `http://localhost:5180/ai-drudge-v2/` |

1. Start V2 if it is not running (repository root):
   ```bash
   npm run dev -- --port 5180 --strictPort
   ```
   `--strictPort` fails when the port is taken, which means a server is already up.
2. Give V2 current data, so both sides show the same hour (network, 19-36 s):
   ```bash
   env -u ANTHROPIC_API_KEY npm run build:data && npm run build:check
   ```
   Without this step V2 shows whatever build is in `public/data/v2/` (2026-11-20T05:16Z when this
   was written) or, after `npm run data:fixture`, the frozen copy of that same build. Both then
   show the "Headlines may be delayed" banner, which is expected.
3. Compare the same moment in numbers:
   ```bash
   npm run compare -- --v1 https://pnelsonftp.github.io/ai-drudge/data/headlines.json
   npm run compare          # default: the frozen V1 payload of 2026-11-19T20:08Z
   ```
   It prints both leads, the overlap, why each V1 article is or is not in V2, V1's Trending against
   V2's TOP STORIES, and rows shared per section. Result on 2026-11-20 (V1 04:08Z, V2 build 2 of
   04:16Z): same
   lead story; 73 of 131 V1 articles placed in V2 (56%), 17 river only, 41 gone; 260 V2 stories not
   in V1.
4. Ask why a specific headline is where it is, or why it is missing:
   ```bash
   npm run explain -- "<title words>"
   ```
5. Things worth checking by eye, because nobody has: the lead and its "Also:" line; AI SECURITY and
   LOCAL & OPEN MODELS against V1's sections of the same name; POLICY & REGULATION for regulator
   notices; `#/sources`; `#/q/finra`; a phone-width window; keyboard navigation with `j`, `k`, `?`.

Both sites share one browser origin only when V2 is deployed next to V1; the local V2 on
`localhost` does not see your V1 bookmarks and mutes.

## 6. Not verified

- V1 was not re-measured beyond its frozen payload: every R1 value is quoted from the review record.
- V2 values marked I2 are quoted from the integration step, not re-run (`npm audit`, the feed
  audit, the hand-labelled relevance sample, tab-stop and touch-target figures, build durations).
  They describe builds 1 and 2; the closing round changed cluster, route and relevance rules after
  them, and the `npm run compare` figures were not re-run on the closing build.
- The "bytes before anything is readable" figure for V2 is a sum of four measured files, not a
  browser measurement, and mixes Vite's kB with the gate's KB (a difference of about 2%).
- The Trending classification in 1.2 (which entries have two independent publishers) is this
  document's reading of the 6 entries in the frozen payload.
- Nothing in section 2 was seen in a browser.
