# AI DRUDGE V2 — Security

Security posture, trust boundaries, threat model and go-live hardening for AI DRUDGE V2.
State of the repository on **2026-11-20 (UTC)**, branch `v2`, nothing committed yet; re-checked
after the closing round of that day.

**Answer first**

- V2 is a static site. There is no server, no account, no cookie, no analytics, and the browser
  client talks only to its own origin (`connect-src 'self'`). The attack surface is the **build**
  (it fetches and parses 413 third-party sources every 30 minutes) and the **shared `github.io`
  origin**.
- Of the nine findings of the security review (SEC-1 to SEC-9): **5 fixed, 2 fixed in part, 2 open
  by decision** (§4).
- Ranked open risks:
  1. **Shared origin with V1 (SEC-8).** Any script running on `pnelsonftp.github.io` (V1 ships no
     CSP) can read and rewrite V2 reader state, including watchlist terms. Needs a deployment
     decision before go-live (§3.9).
  2. **Nothing in `.github/workflows/` has run on GitHub yet.** Every CI control below is verified by
     reading the YAML and by text-level tests, not by a real run (§10).
  3. **The production CSP and the frame guard have not been checked in a browser** (§10).
  4. **API key and feed parsers share one process (SEC-7, partial).** The key is scoped to one step,
     one branch and one stage, but a code-execution bug in a parser or a compromised build
     dependency in that step could still read it.
  5. **The Daily Brief check is syntactic (SEC-2).** A reply that is well-formed but false passes.
     The brief path has never run against the live API in V2 (every recorded build was keyless).

How this was verified: every control cited here was read in the source on 2026-11-20; the 21 test
files that back these controls were run and passed (375 tests after the closing round; command in
§11). Anything not
checked is marked **not verified**. Contract and file ownership: [CONTRACTS.md](./CONTRACTS.md).
Dependencies: [SBOM.md](./SBOM.md), [SBOM.json](./SBOM.json).

GitHub treats this file (`docs/SECURITY.md`) as the repository's security policy; §8 is the
reporting section.

---

## 1. System and trust boundaries

```
 UNTRUSTED                      BUILD (GitHub Actions runner, or a local shell)            PUBLIC
 413 sources / 297 hosts  --->  ingest -> normalize -> relevance -> cluster -> score  ---> dist/ on GitHub Pages
 hn.algolia.com                 -> route -> (brief ∥ stocks) -> emit -> gate -> vite        (static files only)
 news.google.com resolver            |              |                                          |
 query1/2.finance.yahoo.com          |              +--> api.anthropic.com (optional,          v
                                     |                   key on `main` only)               BROWSER
 state.json (`data` branch, then     +<-- restore --+                                      same-origin fetch,
 own site if published): validated                                                         localStorage `aid2:*`
```

| Zone | What runs there | Trusts | Holds |
|---|---|---|---|
| Source hosts (413 active sources, 297 distinct hosts, all `https`) | Third-party feeds, scraped pages, JSON APIs | — | Nothing of ours |
| Build: `build` job of `refresh.yml` | `npm ci --ignore-scripts`, typecheck, tests, `scripts/pipeline/run.ts`, the gate, `vite build` | The lockfile; the pinned actions; its own code | `contents: read` token; `ANTHROPIC_API_KEY` on the "Build data" step, `main` only |
| Deploy: `deploy` job | `actions/deploy-pages` only, no repository code | The Pages artifact of the `build` job | `pages: write`, `id-token: write` |
| Persist: `persist` job | `actions/download-artifact`, `jq`, `git`; no checkout, no npm | The `v2-state` artifact (`jq` schema check) | `contents: write` |
| Alert / report jobs | `gh` CLI and shell; `report` also runs `tsx scripts/tools/report-feed-audit.ts` | Job results; the verdict JSON, escaped before use | `issues: write` |
| Anthropic API (optional) | Summarises headlines for the Daily Brief | — | Receives third-party headline text only |
| GitHub Pages | Serves `dist/` | — | Sees visitor IP and User-Agent as any host does |
| Browser | React SPA from `dist/` | Only data that passes `shared/guards.ts` | Reader state in `localStorage` |
| Owner's Mac | `scripts/kick-refresh.sh` → `gh workflow run` | The local `gh` login | A GitHub credential able to dispatch workflows |

Source mix (computed from `scripts/registry/` on 2026-11-20, final round): 414 definitions, 413
active; kinds rss 249, newsletter 57, github-release 37, query 23, scrape 19, json 15, papers 9,
community 4, aggregator 1. Busiest hosts: `github.com` 45, `news.google.com` 22, `hn.algolia.com` 12
(the Hacker News searches read the official API; `hnrss.org` is no longer requested). The full
list is [SOURCES.md](./SOURCES.md).

Boundary rules enforced by test (`test/boundaries.test.ts`): `src/` never imports `scripts/` or a
node built-in; `shared/` imports only `shared/`; build code never imports client code.

### 1.1 The V1 boundary

V1 (repository `PNelsonFTP/ai-drudge`, live at `https://pnelsonftp.github.io/ai-drudge/`) must keep
running untouched.

| Risk | Control | Where |
|---|---|---|
| A V2 workflow builds or deploys from the wrong repository | Every job requires the repository variable `V2_DEPLOY == 'true'`; without it all jobs are skipped | `refresh.yml`, `feed-audit.yml` |
| V2 queues behind or cancels a V1 run | Concurrency groups `v2-refresh-deploy`, `v2-feed-audit`, `v2-ci-<pr>` never match V1's `refresh-deploy` | all three workflows |
| V2 deploys under the wrong path | Preflight fails the run when `SITE_BASE` does not match the repository name on `*.github.io`, or when a scheduled run is not on `main` | `refresh.yml` step "Preflight" |
| The kick script dispatches V1 | Refuses every spelling of `pnelsonftp/ai-drudge` unless `AID_ALLOW_V1=1`; rejects malformed repo, ref, workflow and retry values | `scripts/kick-refresh.sh`, `scripts/kick-refresh.test.ts` |
| V2 writes V1 browser state | Storage layer throws on any key outside `aid2:`; V1 keys are read once, never written | `src/state/storage.ts`, `src/state/migrateV1.ts` |

**Residual, high impact on V1 availability:** this worktree's `origin` is the V1 repository, and
`refresh.yml` / `feed-audit.yml` carry the same file names as V1's workflows. Merging or pushing
branch `v2` onto V1's `main` replaces V1's production workflow; the guards above then stop V2 from
deploying, and V1 stops updating. Publish V2 to its own repository (§9 item 1).

---

## 2. Data inventory

### 2.1 Personal data

None is collected. No account, cookie, analytics, tracker, advertising, form or server-side log
owned by this project. `form-action 'none'` and `connect-src 'self'` in the CSP make that a
browser-enforced property of the production build, not only a convention.

### 2.2 Browser storage

All keys live under the `aid2:` prefix (`STORAGE_PREFIX`, `src/app/services.ts`). Values are stored
as an envelope `{"v": <version>, "data": ...}` and are validated on every read by the key's own
parser (`src/state/storage.ts decodeValue`). Nothing in this table is ever transmitted.

| Key (`localStorage`) | Holds | Limits and validation | File |
|---|---|---|---|
| `aid2:saved` | Bookmark ids, read-later ids, a snapshot per saved story (title, URL, source name, published and saved times) | Title ≤ 300 chars; URL re-validated as http(s) on every read; ids must be article ids | `src/state/saved.ts` |
| `aid2:mutes` | Muted source ids, muted section ids, V1 display names not yet mapped to an id | Ids ≤ 200 chars; sections must be known ids | `src/state/mutes.ts` |
| `aid2:watchlist` | Watch terms typed by the reader | ≤ 200 terms, ≤ 80 chars each | `src/state/watchlist.ts` |
| `aid2:settings` | Theme, density, section order, hidden and collapsed sections, time filter, shortcuts on/off | Each field validated on its own; unknown values fall back to defaults | `src/state/settings.ts` |
| `aid2:seen` | Ids of stories the reader has seen (LRU) | ≤ 500 ids (`SEEN_LIMIT`) | `src/state/readState.ts` |
| `aid2:lastVisit` | Three timestamps: session cut-off, last time the page was open, newest edition shown | Finite non-negative numbers | `src/state/lastVisit.ts` |
| `aid2:migratedFromV1` | Time of the one-time V1 import and counts of what was imported | — | `src/state/migrateV1.ts` |
| `aid2:probe` | Written and removed at start-up to test that storage works | Transient | `src/state/storage.ts safeStorage` |

| Key (`sessionStorage`) | Holds |
|---|---|
| `aid2:cache:front`, `:rest`, `:river`, `:brief`, `:stocks` | Copies of the public data files, re-validated with the same guards as network data; an invalid entry is deleted (`src/data/editionStore.ts`) |

V1 keys read once and never written or removed (`V1_STORAGE_KEYS`): `ai-drudge:bookmarks`,
`:read-later`, `:article-snapshots`, `:muted-sources`, `:muted-categories`, `:seen-articles`,
`:theme-ft`, `:last-visit`. Test: `src/state/migrateV1.test.ts` ("never writes, removes or changes
any ai-drudge:* key").

Sensitivity: **watchlist terms are the only reader-authored content** and the item most likely to
reveal what the owner is tracking. They sit in `aid2:watchlist` and in any backup file the reader
downloads (the Settings page says so on export). Settings → "Erase all reader data" clears saved,
watchlist, mutes, settings, read history and last visit (`src/features/settings/SettingsPage.tsx`).

### 2.3 What leaves the browser

| Channel | Data | Control |
|---|---|---|
| Fetch | GET of the site's own files under `data/v2/`, `feed.xml`, `feeds.opml`, assets | `connect-src 'self'`; `src/data/fetchJson.ts` is the only data loader |
| Clicking a headline | Navigation to the publisher. No `Referer`, no opener handle | All 5 external anchors use `target="_blank" rel="noopener noreferrer"`; `<meta name="referrer" content="strict-origin-when-cross-origin">` |
| Clipboard, download | Only on an explicit click (copy link, briefing export, backup) | `src/features/export/kit/browser.ts` |

### 2.4 What the build sends out

| Destination | Sent | Notes |
|---|---|---|
| Each source host | GET with `User-Agent: ai-drudge/2.0 (+<SITE_URL>; feed reader)` or `FEED_USER_AGENT`; `If-None-Match` / `If-Modified-Since` | A host that answers 401 / 403 / 406 / 429 is retried once with a Safari User-Agent (`scripts/pipeline/ingest/http.ts`). `robots.txt` is not read. Policy call for the owner |
| `news.google.com` | Wrapper article ids, to resolve them to publisher URLs | `scripts/pipeline/ingest/googleNews.ts` |
| `hn.algolia.com` | Two fixed queries | `scripts/pipeline/ingest/signals/hn.ts` |
| `query1/2.finance.yahoo.com` | Eight ticker symbols | `scripts/pipeline/enrich/stocks.ts` |
| `api.anthropic.com` (only with a key) | Titles, outlet names, section labels, URLs of TOP STORIES (≤ 12) and the lead of each of the 12 ai-desk sections; summaries (≤ 280 chars) only from first-hand sources | `scripts/pipeline/enrich/briefInput.ts`. No reader data exists to send. Provider-side retention: **not verified** |

### 2.5 Public files

Everything in `dist/` is world-readable, including files the client never loads.

| File | Sensitive content |
|---|---|
| `data/v2/front.json`, `rest.json`, `river.json`, `sources.json`, `stocks.json`, `feed.xml`, `feeds.opml` | Public headlines, links and the source list. The source list is itself a statement of what the operator follows - see "Operator profile" below |
| `data/v2/brief.json` | Model id when Claude wrote the brief; a coarse fallback code otherwise (`no-key`, `http-4xx`, ...), never the API's error text |
| `data/v2/status.json`, `health.json` | CI run id and attempt, trigger, 7-character commit SHA, per-source failure class and a one-line error (≤ 200 chars) |
| `data/v2/state.json` | Not in `dist/` on GitHub unless `V2_PUBLISH_STATE=true` (a local `npm run build` still copies it). See §3.10 |

**Operator profile (closing-round audit, 2026-11-20).** Until the closing round `sources.json`
carried the tag `owner-stack` on 57 sources - among them the advisory feeds of an EDR, a SIEM, a
network and a scanner vendor - and registry notes said in so many words which of those products
the owner runs and what the owner's role is. No name or employer was written anywhere, but role +
regulator type + security vendors + the public handle in the site URL is a reconnaissance summary.

| Item | State |
|---|---|
| Tag `owner-stack` in the registry, `sources.json`, the Sources page filter, `docs/SOURCES.md`, the committed fixture | **Removed** (the tag had no function; `registry.test.ts` only named it). The fixture was refreshed in the same round; a search of `scripts/`, `src/`, `shared/`, `test/`, `public/data/v2/sources.json` and `docs/SOURCES.md` finds no occurrence (re-checked 2026-11-20) |
| Registry notes and comments stating which products the owner runs and what the owner's role is | **Reworded** to describe the source, not the owner (about 35 lines in `scripts/registry/**`, `route/rules.ts`). Notes are not exported to `sources.json`; they are in the repository and in `docs/SOURCES.md` |
| Three registry notes missed by that pass: `biometric-update-deepfakes` and `multistate-ai-updates` (the reader's role and firm type), `office365itpros-copilot` (a tooling-policy status) | **Closed 2026-11-20** (found in the documentation pass; reworded afterwards and `docs/SOURCES.md` regenerated). Eight more notes say "a CISO" as the generic audience of a source |
| `docs/SOURCE_RESEARCH.md` | **Open, in part.** The lines tying the enterprise security vendors to the owner were reworded; about 45 other sentences still explain accept / reject decisions by "the owner's stack" for the LOCAL-model lab (runtimes, hardware). Owner decision: reword, or keep the file out of the public repository |
| Tag `owner-pick` (7 sources) | **Open, low.** Marks editorial picks, not products; it does include the SEC / FINRA queries |
| The source list itself | **Accepted.** Following a vendor's advisories is not a statement of running its product, and the list mixes many vendors. A custom domain (§3.9) also removes the handle from the URL |

---

## 3. Threat model

Severity is the residual risk after the control, for this deployment (static site, one reader
persona, no server).

| # | Threat | Vector | Control (file) | Residual |
|---|---|---|---|---|
| 3.1 | XSS / HTML injection from feed content | Markup in a title, summary, outlet name or author | Text is cleaned to plain text at build time (`scripts/pipeline/normalize/text.ts`: `stripHtml`, `decodeEntities` with clamped code points, `sanitizeText` removes control, bidi and zero-width characters). The client renders React text nodes only; a test fails the suite if `dangerouslySetInnerHTML`, a `<style>` element or `setAttribute("style")` appears in `src/` (`src/state/pageBuild.test.ts`). The client rejects any payload that fails `shared/guards.ts`. CSP as second line (3.3) | Low. Depends on React's escaping and on nobody adding a raw-HTML sink without the test |
| 3.2 | `javascript:` / `data:` links | Feed link, scraped href, JSON API field, stored bookmark, brief citation | One allowlist, `isHttpUrl` in `shared/url.ts` (absolute `http`/`https`, no control characters, ≤ 4096 chars). Applied at parse (`ingest/feedParser.ts`), publish (`ingest/index.ts publishable`), state load (`state/store.ts`), payload guard (`shared/guards.ts`), render (`src/features/headline/rowModel.ts`, `HeadlineRow.tsx`, `HoverCard.tsx`, `home/DailyBrief.tsx`, `export/kit/Page.tsx`), storage read (`src/state/saved.ts`), Atom and Markdown export | Low |
| 3.3 | Script injection that gets past 3.1 | Any future sink | Production CSP (§3.3 below) | Meta-CSP limits; not browser-verified |
| 3.4 | Prompt injection into the Daily Brief | Headline or summary written to steer the model | §3.4 below (`scripts/pipeline/enrich/brief.ts`, `briefInput.ts`) | Medium-low: a fluent false statement passes (SEC-2) |
| 3.5 | SSRF, redirect abuse | A source redirects the fetcher to an internal address; a feed lists internal links | `httpFetch` follows redirects itself (`redirect: "manual"`, ≤ 8 hops) and refuses a non-public host **before requesting it**: IP literals, single-label names, `.local`, `.internal`, `.localhost`, `.lan`, `.corp`, `.home` and similar (`isPublicHost`, `scripts/pipeline/ingest/http.ts`). Item links on non-public hosts are dropped for feed, scrape and JSON sources and for resolved Google News / Techmeme targets (`ingest/index.ts`) | Low on a hosted runner. Name-based only: a public name that resolves to a private address is not caught. The host of the registry URL itself is exempt. Matters when the feed tools run on a workstation inside a private network |
| 3.6 | Oversized or slow responses, parser blow-up | 5 MB body, slow-loris host, entity bomb, pathological HTML | Body cap 5 MB enforced while streaming (`PIPELINE.maxBodyBytes`); headers 8 s then 16 s on the one timeout retry, 30 s total; per-host pool (2 per host, 24 overall) and a per-host timeout breaker (`ingest/pool.ts`); ingest deadline 90 s plus 25 s for the Google News resolver (`INGEST_DEFAULTS`); raw caps title 500 / summary 4,000 / field 200 chars (`ingest/newest.ts`); linear-time block and comment stripping and an HTML depth cap of 256 (`newest.ts`, `html.ts`); per-source `try/catch` so one source cannot fail the run (`ingest/index.ts`); output size ceilings refuse to write (`emit/write.ts SIZE_LIMITS`); CI wraps the build in `timeout 12m` | Low. XML entity expansion relies on fast-xml-parser's built-in limits (`processEntities: true`, `ingest/feedParser.ts`). `normalize/text.ts` still uses backtracking regexes, but only on input already cut to 4,000 chars |
| 3.7 | CI token abuse, workflow injection | Feed text reaching a shell, a log command or an issue; a compromised step | §5 | Low; unproven on GitHub |
| 3.8 | Supply chain | Malicious or vulnerable npm package or action | §6 | Medium-low: build dependencies run in the step that holds the API key |
| 3.9 | Same-origin neighbours | Script on another `pnelsonftp.github.io` page | `aid2:` namespace, validated reads | **Open (SEC-8)** |
| 3.10 | `state.json` (on the public `data` branch; not in the site by default) | Disclosure; tampering with the next build's memory | Plain text only, validated on load, removed from the Pages artifact | Low |
| 3.11 | Backup import as an injection vector | A crafted "backup" file given to the reader | §3.11 below (`src/state/backup.ts`) | Low: content is valid but attacker-chosen |
| 3.12 | Clickjacking | The site framed by another origin | `isFramedByAnotherSite` in `src/app/createServices.ts`; `src/main.tsx` renders only an "Open AI DRUDGE" link (`target="_top"`) in production | Same-origin frames are allowed; JavaScript-only defence (SEC-9) |
| 3.13 | Hostile or low-quality source takes an editorial slot | Query feeds, community posts | Registry tiers and per-source policy (`scripts/registry/`). Since the final round: an outlet deny list of 10 hosts with recorded evidence, and "unvetted outlet" handling for outlets no publisher entry vouches for (tier 4, never a lead, no coverage count; `scripts/registry/outlets.ts`); forum threads and uncorroborated tier-4 rows are a last resort for the homepage rows of topic sections; community and release items never lead a TOP story | Editorial, outside the security review. No denied or unvetted outlet led a homepage row in the builds of 2026-11-20; "view all" lists still carry a few such rows ([HANDOFF.md](./HANDOFF.md) §7) |

### 3.3 Content-Security-Policy

GitHub Pages cannot send response headers, so the policy is a `<meta>` tag. The source
`index.html` holds only the marker `<!--app:csp-->`; `vite.config.ts` (`contentSecurityPolicy`,
`appHtml`) fills it in **production builds only**. The policy as present in `dist/index.html`
(build of 2026-11-20):

```
default-src 'self'; script-src 'self' 'sha256-zg7EzWChTzJBowQI3f3rPpxb1jakjLmb46a8cymIiBk='; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

- The hash covers the one inline script, the no-flash theme bootstrap
  (`src/state/themeBootstrap.ts`). It is recomputed at build time; editing that script changes the
  hash automatically.
- No `'unsafe-inline'`, no `'unsafe-eval'`, no remote host anywhere. Pinned by
  `src/state/pageBuild.test.ts`.
- Limits of a meta policy: `frame-ancestors`, `sandbox` and violation reporting are unavailable;
  there is no Trusted Types directive; `img-src` allows `data:`.
- The dev server (`npm run dev`) has **no CSP** (React refresh needs an inline script and a
  websocket). Do not treat dev-server behaviour as evidence about the policy.
- Other response headers (HSTS, `X-Content-Type-Options`) are whatever GitHub Pages sends:
  **not verified**.

### 3.4 Prompt injection into the Daily Brief

| Stage | Control |
|---|---|
| Input selection | Only TOP STORIES and section leads; never release tags or community threads; summaries only from sources that write their own (`attribution === "source"`, not query / aggregator / community / github-release) — `briefInput.ts` |
| Prompt | Stories travel as JSON inside one `<stories>` block with `<`, `>`, `&` escaped, so data cannot close its own delimiter (`promptJson`); the system prompt declares the block untrusted data |
| Output | Schema-constrained JSON, then checked in code (`checkBriefReply`): types, ≥ 3 bullets, length caps (headline 140, bullet 320), no HTML tag, entity, URL, Markdown or control character, every bullet cites ≥ 1 URL and **every cited URL must be one that was sent**. Any failure discards the whole reply |
| Publication | Citations are rebuilt from the pipeline's own input, never copied from the reply. Refusal, truncation, timeout (45 s), HTTP error → deterministic fallback brief, which the client does not render |
| Display | Plain text nodes; labelled "AI-written · <model>" (`src/features/home/DailyBrief.tsx`) |
| Disclosure | The API's error text goes to the build log only; public files carry a coarse code |

Residual (SEC-2, open by decision): the check is syntactic. A reply that invents a number or
attributes a claim to the wrong company passes. A lexical grounding check was rejected because it
discards legitimate paraphrases, and a bare-domain rule rejects names such as `llama.cpp` and
`Node.js`. Kill switch: delete the `ANTHROPIC_API_KEY` secret; the next build publishes the
fallback and the Daily Brief box disappears.

### 3.9 Shared `github.io` origin (SEC-8, open)

`localStorage` is scoped to the **origin** (scheme, host, port), not to the path.
`https://pnelsonftp.github.io/ai-drudge/` (V1), `https://pnelsonftp.github.io/ai-drudge-v2/` (V2)
and every other Pages project of the same account are one origin and share one `localStorage`.
A `<meta>` CSP protects only the document that carries it.

| What the `aid2:` namespace gives | What it does not give |
|---|---|
| V2 cannot write, remove or corrupt a V1 key: `defineKey`, `writeRaw` and `removeKey` throw on a key outside `aid2:` (`src/state/storage.ts`, test "writeRaw / removeKey throw on a V1 key") | Confidentiality. Any script on the origin can read `aid2:watchlist`, `aid2:saved` and the rest |
| V1 and V2 never collide on a key name | Integrity. Any script on the origin can write `aid2:*` values |
| "Erase all reader data" and `resetV2Storage` touch only V2 keys | Quota isolation: the origin's storage quota is shared (`safeStorage` tolerates refused writes) |

What limits the damage of a hostile write: every value is re-parsed on read, saved URLs must pass
`isHttpUrl`, ids and section names are checked, and nothing stored is ever interpreted as HTML or
code. An attacker on the origin can still plant plausible `https` bookmarks, mute sources or hide
sections, and can frame V2 (the frame guard allows same-origin parents).

Realistic path: V1 has no CSP (review finding; V1 was not re-inspected for this document), so an
injection in V1 or in any future project page on the account is an injection against V2 reader
state.

Options, in order of strength:

1. Serve V2 from its own origin: a custom domain (`SITE_URL` and `SITE_BASE=/` repository
   variables are supported; the preflight skips non-`github.io` hosts) or a separate GitHub
   account or organisation.
2. Stay on `github.io` and accept it: treat watch terms as readable by any page of the account,
   keep no other project with untrusted input on the account, and say so on the About page (it
   does not today: `src/features/about/AboutPage.tsx`, "Privacy").

### 3.10 `state.json`

`state.json` is the build's memory. Since the final round it is **not in the Pages artifact**: the
"Check dist" step of `refresh.yml` removes it unless the repository variable `V2_PUBLISH_STATE` is
`true`, and CI restores it from the `data` branch first (a copy on the live site is the fallback
and wins only when strictly newer). The `data` branch of a public repository is public, so the
file is still treated and written as a public one. Measured on the closing build of
2026-11-20T05:16:55Z: 3.31 MB raw, about 0.97 MB gzip. `[UNTESTED]` on GitHub: the restore and persist
steps were executed locally against a bare repository only.

| Contents | Count in that build |
|---|---|
| `firstSeen`, `lastSeenDay`: article id → timestamps | 4,361 ids |
| `resolvedUrls`: Google News wrapper → publisher URL | 288 |
| `health`: per-source fail streak, last error (one line), timestamps | 413 |
| `lastGood`: last good items per source (title, link, date, plain-text summary, categories; ETag / Last-Modified when the host sent them) | 413 sources, 4,461 items |
| `recent`: river memory | 1,086 rows |
| `lead`: current lead id and since when | 1 |
| `top`: the published TOP STORIES list (id, score, hold start) for the hold rule | 12 |
| `briefFailStreak`: consecutive keyed builds whose Claude brief failed | absent (no key) |

- Confidentiality: no secret is in it. Scan of that file (re-run 2026-11-20): no API-key pattern,
  0 of the 4,045 stored summaries (4,461 items) contain an HTML tag, longest stored summary 616
  chars. `slimLastGood` reduces publishers' HTML to
  plain text of at most 600 chars before saving (`scripts/pipeline/state/store.ts`,
  `scripts/pipeline/run.ts`); a test asserts the key appears in no output file
  (`scripts/pipeline/run.test.ts`, "the API key reaches makeBrief only, and raw feed HTML never
  reaches state.json").
- Remaining exposure: it republishes third-party titles and summaries in bulk (a content-reuse
  question, not a confidentiality one) and shows which sources are failing.
- Integrity: the file is treated as untrusted on load. `loadState` rebuilds every field and drops
  anything of the wrong shape (`state/store.ts`); the workflow accepts only a `schemaVersion: 2`
  object. Writing it requires a push to the `data` branch (or a Pages deploy when
  `V2_PUBLISH_STATE=true`).
- Gap: there is no switch to force an empty state in CI. A poisoned state has to be removed from
  the `data` branch (and from the live site if it was ever published there).
- Availability: by default the state now has ONE copy. If the `data` branch cannot be read, the
  build starts from empty state (first-seen times re-stamped, river memory and failure streaks
  lost) and the `alert` job reports it in "V2 refresh failing". The branch must stay
  force-pushable by `github-actions[bot]`.

### 3.11 Backup import

`src/state/backup.ts`. The file is parsed in the browser and never uploaded.

| Check | Detail |
|---|---|
| Size and shape | ≤ 5,000,000 chars; must be JSON with `app: "ai-drudge"`, `kind: "reader-state"`, integer `format` ≤ 1 |
| Keys | Only the five restorable keys are considered: saved, mutes, watchlist, settings, seen. `aid2:lastVisit` and `aid2:migratedFromV1` are never restored. Unknown keys are listed as skipped |
| Values | Each entry goes through the same parser the store reads with; **the validated value is re-encoded and stored, never the file's text** |
| Namespace | Writes go through `writeRaw`, which throws outside `aid2:` |
| Dry run | `previewJson` reports what would change before anything is written |

Residual: a crafted file is still a valid state. It can replace the bookmark list with
attacker-chosen `https` links under misleading titles, silently mute sources or sections (for
example a security-advisory source) and replace watch terms. The preview shows counts, not
content. Restore only files exported from this site; a restore replaces, it does not merge.

---

## 4. Security review findings (SEC-1 to SEC-9)

Source: the round-2 review, reviewer "security". Status after the fix round, re-checked in code.

| ID | Sev. | Finding | Status | Evidence |
|---|---|---|---|---|
| SEC-1 | medium | One hostile feed could block the build for minutes: quadratic regex on unclosed `<script>` / `<style>` | **Fixed** | `ingest/newest.ts` `stripNonTextBlocks`, `stripHtmlComments`; `ingest/html.ts` linear `TagScanner` and `MAX_DEPTH` 256. Tests: 20,000-input equivalence with the old regexes; 1 MB hostile input under a 1 s bound |
| SEC-2 | low | Brief output check is syntactic only | **Open (accepted)** | §3.4. A rejected reply is visible as `invalid-reply` in `brief.json` / `status.json` |
| SEC-3 | low | Build-time fetch followed redirects to loopback / private hosts; internal links accepted | **Fixed**, with a stated limit | `ingest/http.ts`, `ingest/index.ts`; tests in `http.test.ts` ("refused BEFORE that host is requested"). No DNS resolution |
| SEC-4 | low | Feed-controlled newline injected GitHub Actions workflow commands into the log | **Fixed** | `oneLine` (`ingest/newest.ts`) on every failure detail; `neutraliseWorkflowCommands` (`scripts/pipeline/context.ts`) on every log line |
| SEC-5 | low | Markdown injection into the job summary and the audit issue; issue body could exceed GitHub's limit | **Fixed** | `scripts/tools/check-links.ts` (`mdCode`, `mdCell`); `scripts/tools/report-feed-audit.ts` (`mdSafe`, `mdCode`, `ISSUE_BODY_BUDGET` 60,000). Tests in `check-links.test.ts`, `validate-feeds.test.ts` |
| SEC-6 | low | `state.json` rehosted megabytes of raw third-party HTML | **Fixed in part** | HTML removed, 5.4 MB → 3.3 MB; out of the Pages artifact since the final round. Still readable on the public `data` branch (§3.10) |
| SEC-7 | low | API key in the process that parses untrusted feeds, on any dispatched ref | **Fixed in part** | Key expression is empty off `main` (`refresh.yml`); `run.ts` hands it to `makeBrief` only and deletes it from `process.env` before the run. Not done: a separate brief step |
| SEC-8 | low | V2 shares its origin with V1 | **Open (deployment decision)** | §3.9 |
| SEC-9 | low | No clickjacking defence | **Fixed**, JavaScript-only | `isFramedByAnotherSite` + `src/main.tsx`. Unit test covers the predicate; the `main.tsx` branch has no test |

Additional observation made while writing this document (not a reviewed finding, low): the crash
path of `scripts/pipeline/run.ts` prints `err.stack` with `console.error`, bypassing
`neutraliseWorkflowCommands`. Only the first line carries the `[error]` prefix. No path was found
that puts feed text into such an error, but the invariant "no log line can start with `::`" does
not hold there.

V1 review findings and their V2 state:

| V1 finding | V2 state |
|---|---|
| One hostile item crashes the whole refresh | Closed: per-source isolation, `runIngest` never throws, code points clamped |
| One CI job holds write, deploy, OIDC and the API key | Closed: five jobs, one scope each (§5) |
| No URL scheme allowlist | Closed (3.2) |
| Parser advisory invisible to the audit | Closed: full-tree `npm audit` weekly with its own rolling issue; fast-xml-parser 5.12.1 |
| Brief output unvalidated | Closed, except SEC-2 |
| V1/V2 shared-origin storage | Collision closed; confidentiality open (SEC-8) |
| V2 branch carries V1's production deploy workflow | Guarded, not eliminated (§1.1) |
| Unbounded sizes | Closed (3.6) |
| Text not sanitised for sinks | Closed: `sanitizeText`; `emit/xml.ts` strips XML-illegal characters and escapes |
| Audit issue Markdown injection | Closed (SEC-5) |
| No CSP or referrer policy | Closed (3.3) |
| CI fetch follows redirects anywhere | Closed (SEC-3) |
| User-generated content can take top slots | Closed for TOP STORIES and story leads: community and release items never lead a TOP story and never count for coverage (`route/top.ts`, `cluster/index.ts`). Section lists: see 3.13 |
| Security documentation stale | This file; [SBOM.md](./SBOM.md) was rewritten for V2 in the final round |

---

## 5. CI/CD privileges

All three workflows declare `permissions: {}` at the top and grant scopes per job. No `${{ }}`
expression is interpolated inside any `run:` script; every value reaches the shell through `env:`.
Checkout uses `persist-credentials: false`. `scripts/tools/workflows.test.ts` pins these
properties at text level.

| Workflow / job | Trigger | Token scope | Secrets | Runs repository or npm code | Reads untrusted input |
|---|---|---|---|---|---|
| `refresh.yml` / `guard` | schedule `7,22,37,52 * * * *`, dispatch, push to `main` | none | none | no | own `status.json` |
| `refresh.yml` / `build` | same | `contents: read` | `ANTHROPIC_API_KEY` on step "Build data" only, and only when `github.ref == 'refs/heads/main'`; `github.token` on step "Restore pipeline state" only | **yes** | **yes** (all sources) |
| `refresh.yml` / `deploy` | `main` only | `pages: write`, `id-token: write` | none | no | no |
| `refresh.yml` / `persist` | `main` only | `contents: write` | `github.token` on the push step | no | `state.json`, checked with `jq` |
| `refresh.yml` / `alert` | `main` only | `issues: write` | `github.token` on one step | no | job results, fixed strings |
| `feed-audit.yml` / `audit` | Mondays 12:23 UTC, dispatch | `contents: read` | none | **yes** | **yes** |
| `feed-audit.yml` / `report` | same | `contents: read`, `issues: write` | `github.token` on two steps | yes (`npm ci`, `tsx`) | verdict JSON from an artifact, escaped |
| `ci.yml` / `check` | `pull_request` (never `pull_request_target`) | `contents: read` | none | yes (the PR's code) | no |

Design points:

- The job that parses untrusted input never holds a write token. The jobs that hold write tokens
  run no repository code, with one exception: `report` runs `report-feed-audit.ts` under
  `issues: write`.
- A `workflow_dispatch` on a branch other than `main` runs that branch's code with an empty key,
  and deploys, persists and alerts nothing.
- Inside the keyed step, `scripts/pipeline/run.ts` copies the environment, deletes the key from
  `process.env`, and gives the key to `makeBrief` alone; ingest, normalize, stocks and emit see a
  context without it.
- `persist` force-pushes one orphan commit to `refs/heads/data` and nothing else. Its
  `contents: write` token could push to `main` if `main` is unprotected (§9 item 6).
- "V2 refresh failing" and "Dependency audit failing" are found by listing open issues with an
  exact title **and a bot author**, and their bodies are passed with `--body-file`.
- The "Feed audit:" issue is found the same way since the closing round
  (`scripts/tools/report-feed-audit.ts` `lookupArgs`): the repository's open issues, **bot author**
  and the title prefix; an issue a person opens under a look-alike title is never edited or closed.
  A lookup that fails **in GitHub Actions** now fails the step (it used to print a warning and exit
  0, which left a dead feed with no signal at all - the issue is the only one); outside CI it stays
  a warning. `gh` is called with `execFileSync` and an argument array, so no shell parses the body.

Action pins (full commit SHA, the same SHA everywhere an action is used):

| Action | Pinned commit | Version comment |
|---|---|---|
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 |
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | v7.1.0 |
| `actions/upload-pages-artifact` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | v5.0.0 |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2 |
| `actions/deploy-pages` | `368f82528645a54fb793d4d04e342629a3f51346` | v5.0.1 |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | v8.0.2 |

That each SHA is the commit of the tag named in its comment is **not verified** against upstream.

### 5.1 The Mac kick script

`scripts/kick-refresh.sh` runs `gh workflow run <workflow> --repo <repo> --ref <ref>` with up to
3 attempts. Defaults: `PNelsonFTP/ai-drudge-v2`, `main`, `refresh.yml`. It holds no secret of its
own; it uses whatever `gh` is logged in as. Inputs from the environment are validated against
character allowlists before use, and `AID_DRY_RUN=1` exits before `gh` is looked up.

- The launchd job definition (plist) is **not in this repository** and was not inspected.
- The credential behind `gh` on the Mac is the real exposure: a default `gh auth login` token can
  usually do far more than dispatch one workflow (§9 item 11).

---

## 6. Supply chain

| Control | State on 2026-11-20 | Where |
|---|---|---|
| Lockfile | `package-lock.json`, lockfileVersion 3, 125 packages, every `resolved` URL on `registry.npmjs.org`, every integrity value `sha512` (6 packages bundled inside the optional `@tailwindcss/oxide-wasm32-wasi` carry none of their own) | repository root |
| Install | `npm ci --ignore-scripts` in all three workflows. Two packages declare install scripts (`esbuild`, `fsevents`); neither runs | workflows |
| Shipped to browsers | `react` 19.3.1, `react-dom` 19.3.1, `scheduler` 0.28.0. Everything else is build tooling | `package.json` |
| Highest-exposure build dependency | `fast-xml-parser` 5.12.1: parses untrusted XML on every build | `ingest/feedParser.ts` |
| No SDK for the model call | The brief uses raw `fetch`; no Anthropic package is installed | `enrich/brief.ts` |
| Vulnerability audit | Weekly `npm audit --audit-level=high` on the full tree, plus `npm audit signatures`; a failure opens the rolling issue "Dependency audit failing" and turns the run red | `feed-audit.yml` |
| Audit result | 0 vulnerabilities, as reported by the final round's third integrator on 2026-11-20. Not re-run for this document | — |
| Dependabot | Weekly, npm and github-actions, grouped minor/patch, 7-day cooldown on new releases, majors of `typescript` and `@types/node` held. **Inert until the file is on the default branch** | `.github/dependabot.yml` |
| Pull-request gate | Typecheck, tests and site build for every PR with a read-only token | `ci.yml` |
| SBOM | `docs/SBOM.json`, CycloneDX 1.6: 132 components (125 npm packages with SPDX licence and SHA-512, 6 GitHub Actions pinned by commit SHA, Node.js), 7 external services, the dependency graph. `npm run sbom -- --check` printed "SBOM is current" on 2026-11-20; `feed-audit.yml` runs the same check weekly (warning only). Not validated against the official CycloneDX JSON schema | `scripts/generate-sbom.ts` |
| Node version | `.node-version` = 24; `engines.node >= 22.15.0` | repository root |

Residual: a compromised release of `tsx`, `esbuild` or `fast-xml-parser` executes inside the
"Build data" step, where the key is in the environment at process start. The cooldown, the
lockfile and the signature audit reduce the chance; they do not remove it (SEC-7).

---

## 7. Auditability

What one build leaves behind, and where.

| Record | Content | Lifetime |
|---|---|---|
| `status.json` (public) | `buildId`, `generatedAt`, run id / attempt / trigger / 7-char commit SHA / duration, feed counts and up to 50 failing source names, story counts, newest item time, gate verdict with failures and warnings, brief source and fallback code, stocks priced | Overwritten each deploy; a copy is on the `data` branch |
| `health.json` (public) | One row per active source: status (`ok` / `failing` / `carried` / `quarantined`), item count, fail streak, last OK time, error class, one-line error, HTTP status | Overwritten each deploy |
| `brief.json` (public) | `source` (`claude` or `fallback`), `model` as returned by the API, `generatedAt`, cited stories, `fallbackReason` | Overwritten each deploy |
| `state.json` (public `data` branch; in the site only with `V2_PUBLISH_STATE=true`) | First-seen ledger, health streaks, last-good items, river memory, lead, the TOP STORIES list, the brief failure streak | Latest only; one orphan commit on `data` |
| Build log (Actions) | One OK / FAIL line per source with timing, Google News cache statistics, the brief line (model, stop reason, token usage, bullets, citations, or the reason for the fallback), the per-stage table (duration and counts), the gate report (stories, lead, ages, feed tiers, file sizes raw and gzip) | GitHub's log retention: **not verified** |
| Job summary | Where the state was restored from; audit outcomes; the link report | With the run |
| Artifacts | `v2-state` (state and status), 7 days; `v2-audit-reports`, 30 days | As stated |
| Rolling issues | "V2 refresh failing", "V2 Daily Brief failing", "Feed audit: ...", "Dependency audit failing" | Until closed by a passing run |
| Explain record | `node_modules/.tmp/explain.json`: why each story is placed or dropped. Local only; read with `npm run explain -- <id \| url \| words>` | Last local build |

Properties that make a build reproducible and checkable:

1. **One clock.** `ctx.now` is the only clock in the pipeline; `buildId` is its ISO timestamp and
   is identical in every file of a build. The client's `mergeEdition` throws
   `BuildMismatchError` on a mismatch (`shared/select.ts`) and the gate checks every file against
   `front.json` (`shared/invariants.ts`).
2. **Pure middle.** normalize → relevance → cluster → score → route take the clock and the state
   from the context and touch no network (`processItems`, `scripts/pipeline/run.ts`). The same
   items, state and clock give the same placements. `npm run explain` and `npm run compare` replay
   it.
3. **Stable feed.** `feed.xml` is byte-identical between builds until the set of stories changes
   (`scripts/pipeline/emit/atom.ts`).
4. **Atomic writes.** Every output is written to a temp file and renamed; all temps exist before
   the first rename (`emit/write.ts`).
5. **Hold, never half-publish.** Gate exit 1 uploads nothing and the previous deploy keeps
   serving; zero surviving articles leaves the previous files untouched (`run.ts`,
   `scripts/tools/check-data.ts`).
6. **Freshness is proven.** CI records `BUILD_STARTED_AT` before the build; the gate fails when
   `generatedAt` is older, and fails when the variable is missing in Actions.

Not deterministic: the network inputs, the Claude brief, retry jitter.

AI-use audit trail: the model id is in `brief.json` and shown in the UI next to the brief; the
system prompt, schema and model constant are in version control (`enrich/brief.ts`); token usage
is in the build log. **Gap:** the exact request and the raw reply are not stored, and editions are
not archived (generated data is never committed; the `data` branch keeps only the latest
snapshot). Reconstructing what the model was shown for a past build is not possible after the next
deploy. If that matters, archive `front.json` and `brief.json` per build.

Last recorded local build (the closing build, 2026-11-20T05:16:55.936Z): 412 of 413 sources OK,
1 carried forward (HTTP 429), gate passed with 0 warnings, brief `fallback` / `no-key`, 23.4 s.

---

## 8. Reporting and handling a vulnerability

This is a personal project maintained by one person, with no bounty and no service-level
commitment.

**Reporting**

1. Use GitHub's private vulnerability reporting on the repository (Security → "Report a
   vulnerability"). Whether it is enabled is **not verified**; enabling it is §9 item 9.
2. If it is not available, open an issue that says a private channel is needed, with no technical
   detail.
3. Do not test against the live site in a way that degrades it, and do not send traffic to the
   source feeds on the project's behalf.

In scope: code in this repository, the workflows, the deployed site. Out of scope: the content of
third-party feeds, publishers' sites, GitHub Pages itself.

**Handling runbook**

| Situation | Action | Why it works |
|---|---|---|
| Stop all publishing now | Set the repository variable `V2_DEPLOY` to anything but `true` | Every job is skipped; the last deploy keeps serving and the client shows "Headlines may be delayed" after 2 h |
| Take the site down | Unpublish in Settings → Pages | Platform control, not code |
| A source publishes hostile or defacing content | Set `status: "paused"` on its definition in `scripts/registry/sources/*.ts` and push to `main` | Paused sources are not fetched (`activeSources`); a push to `main` triggers a build |
| ...and its rows must leave the 7-day river too | Delete the definition instead of pausing it | River memory keeps rows of any source still in the registry, paused or not (`scripts/pipeline/emit/river.ts`) |
| API key exposed or suspected | Revoke it at the provider, then replace or delete the `ANTHROPIC_API_KEY` secret | Without a key the build publishes the fallback brief (`no-key`); nothing else depends on it |
| Dependency advisory | `npm ci --ignore-scripts && npm audit --audit-level=high && npm audit signatures`; update; `npm run sbom`; `npm run typecheck && npm test` | A high or critical advisory in `fast-xml-parser` is urgent: it parses untrusted input every 30 minutes |
| Suspected CI compromise | Disable Actions; revoke the key; review Pages deployments, the `data` branch and open issues; re-enable only from a reviewed commit | The `data` branch is the restore source (plus the live `state.json` when `V2_PUBLISH_STATE=true`): clear it to start from empty state (§3.10) |
| Reader state looks tampered with | Settings → download a backup for evidence, then "Erase all reader data" | Clears every `aid2:` reader key in this browser |

After a fix: add a regression test next to the control, and record the change in §4.

---

## 9. Hardening checklist for go-live

Items 1 to 11 are GitHub or workstation settings. None can be seen from the repository tree, so
all are **not verified**. Do them in this order; `V2_DEPLOY=true` is the last switch.

| # | Item | Why |
|---|---|---|
| 1 | Create the V2 repository under its own name (it must match `SITE_BASE`, default `/ai-drudge-v2/`), default branch `main`. Never push branch `v2` to the V1 repository's `main` | §1.1 |
| 2 | Decide SEC-8: own origin, or accept and document on the About page | §3.9 |
| 3 | Settings → Actions → General: default workflow permissions "Read repository contents"; do not allow Actions to create or approve pull requests | Defence in depth behind `permissions: {}` |
| 4 | Restrict allowed actions to those created by GitHub | All six pinned actions are `actions/*` |
| 5 | Settings → Pages: source "GitHub Actions"; enforce HTTPS. Environment `github-pages`: deployment branches limited to `main` | Only the `deploy` job on `main` should publish |
| 6 | Protect `main` (ruleset: no force push, no deletion, changes by pull request with owner bypass; optionally require the check "Typecheck, test, build"). Leave `data` force-pushable by Actions | Stops the `persist` job's `contents: write` token from being usable against `main` |
| 7 | Create a dedicated API key for this site with a spend limit; store it only as the Actions secret `ANTHROPIC_API_KEY` | Limits the blast radius of SEC-7 |
| 8 | Set repository variables `SITE_URL`, `SITE_BASE`, optionally `FEED_USER_AGENT` | Read by the workflows and the pipeline |
| 9 | Enable Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting | §6, §8 |
| 10 | GitHub account: phishing-resistant second factor; review personal access tokens and authorised apps | The account is the root of trust for everything here |
| 11 | Mac: give the kick job a fine-grained token limited to the V2 repository with Actions read/write only, instead of the general `gh` login | §5.1 |
| 12 | Open a production build (`npm run build`, then `npm run preview`) in a browser: no CSP violation in the console, hover card positions, sticky offsets apply; load it inside a cross-origin iframe and confirm only the "Open AI DRUDGE" link shows | §10 |
| 13 | Before that switch: open a draft pull request from `v2` (do not merge it) so `ci.yml` runs typecheck, tests and the site build on GitHub's Node 24 and Linux, which nothing has run on yet. Then the first run on GitHub with `V2_DEPLOY=true`: preflight passes, `npm ci --ignore-scripts` installs a working toolchain, state restore reports its source, `persist` pushes to `data`, a forced failure opens the rolling issue | The workflows have never run |
| 14 | First keyed build: `brief.json` has `source: "claude"` and a `model`, or a fallback code; search the run log for the key | The brief path has never run live |
| 15 | Run `git rm --cached public/feed.xml` in the cutover commit | It is generated and ignored, but still tracked |
| 16 | Before the repository is public: decide what to do with `docs/SOURCE_RESEARCH.md` and the `owner-pick` tag (§2.5, "Operator profile") | The registry and the published source list no longer describe the reader; the research record still does in part |
| 17 | After a day of clean builds, re-read `status.json` and `health.json` and the open issues | Baseline for §7 |

---

## 10. Not verified

| Item | Why it matters |
|---|---|
| Any workflow run on GitHub | Permissions, guards, the preflight, artifact hand-off and the rolling issues are proven by reading and by `scripts/tools/workflows.test.ts` only |
| Production CSP in a browser, in particular `style-src 'self'` | A blocked style would break the hover card and sticky offsets; a silent CSP gap would go unnoticed |
| Frame guard in a browser | The `main.tsx` branch has no test |
| A live Claude brief | Model id, API version header and request shape in `enrich/brief.ts` have not met the real API from V2 |
| Action SHA ↔ tag mapping | A wrong pin would still be a fixed commit, but not the reviewed one |
| `npm audit` and `npm audit signatures` | Reported clean by the integrator; not re-run here |
| Repository and account settings (§9 items 1 to 11) | Not visible from the tree |
| The launchd plist and the `gh` credential on the Mac | Not in the repository |
| GitHub Pages response headers, Actions log retention, the model provider's data retention | Platform behaviour |
| V1's current state (no CSP) | Taken from the review; V1 is out of bounds for this work |
| Section 3.13 (editorial abuse by low-trust sources) | Outside the scope of the security review; the controls named there were read in code, their effect was measured by the final round on one news day |
| Node 24 and Linux | Every test and build result is Node 26.7.0 on macOS; CI pins Node 24 on Ubuntu |

---

## 11. Re-verifying this document

Offline, about 20 seconds; 375 tests passed on 2026-11-20 after the closing round (316 when this
document was first written):

```bash
npx tsx --tsconfig tsconfig.app.json --test \
  scripts/tools/workflows.test.ts scripts/kick-refresh.test.ts \
  scripts/pipeline/ingest/http.test.ts scripts/pipeline/ingest/newest.test.ts \
  scripts/pipeline/ingest/html.test.ts scripts/pipeline/ingest/index.test.ts \
  scripts/pipeline/context.test.ts scripts/pipeline/enrich/brief.test.ts \
  scripts/pipeline/run.test.ts scripts/pipeline/state/store.test.ts \
  scripts/tools/check-links.test.ts scripts/tools/validate-feeds.test.ts \
  src/state/pageBuild.test.ts src/state/storage.test.ts src/state/backup.test.ts \
  src/state/migrateV1.test.ts src/state/saved.test.ts src/app/createServices.test.ts \
  shared/url.test.ts shared/guards.test.ts test/boundaries.test.ts
```

| Claim | Check |
|---|---|
| The CSP quoted in §3.3 | `npm run build`, then read the `<meta http-equiv="Content-Security-Policy">` line of `dist/index.html` |
| No raw-HTML sink in the client | `grep -rnE "dangerouslySetInnerHTML\|innerHTML\|insertAdjacentHTML\|document\.write\|eval\(" src shared` returns nothing outside tests |
| No expression inside a `run:` script | Read the three files in `.github/workflows/`; expressions appear only under `env:`, `if:`, `with:` and `outputs:` |
| Lockfile and SBOM agree | `npm run sbom -- --check` prints "SBOM is current" (regenerating without a content change rewrites identical bytes) |
| No secret in the tree | Search for `sk-ant-`, `ghp_`, `github_pat_`, `BEGIN ... PRIVATE KEY` outside `node_modules` and `dist`: nothing found on 2026-11-20; no `.env` file present |
| What `state.json` holds | `npm run build:data` (live network), then inspect `public/data/v2/state.json` |
