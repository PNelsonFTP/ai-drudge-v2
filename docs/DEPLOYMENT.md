# AI DRUDGE V2 — Deployment and go-live

Written 2026-11-20. Audience: the engineer (or agent) who takes V2 from an uncommitted working tree
to a live GitHub Pages site.

**Answer first (pre-go-live; see §0 for what was done).** V2 is not deployed and not committed. The recommended path is **Option A: a new
public repository `PNelsonFTP/ai-drudge-v2`**, which leaves V1 and its repository untouched and runs
both sites side by side. Go-live is: one local commit, one `git push`, enable Pages
(source = GitHub Actions), set the repository variable `V2_DEPLOY=true`, dispatch `refresh.yml` once.
Every step that touches GitHub is **untested**: the three workflows have never run there.

## 0. Go-live record (2026-11-20)

Option A with the single-commit variant (§8.1) was carried out on 2026-11-20. Sections 1-15 are the
pre-go-live snapshot and are kept as written; where they say "not committed" or "never run on
GitHub", this section supersedes them. The custom-domain procedure is §16.

| Step | Result |
|---|---|
| Repository | `PNelsonFTP/ai-drudge-v2`, public, default branch `main`, one initial commit (no V1 history). Local clone `~/Documents/Development/ai-drudge-v2` |
| Clean-copy checks before the push | 463 files (tracked and untracked, not ignored, without `public/feed.xml`); `npm ci --ignore-scripts`, `npx tsc -b`, `npm test` (2,782 / 2,782), `npm run build` all passed |
| Pages | `build_type: workflow`, https://pnelsonftp.github.io/ai-drudge-v2/ |
| Variables and secrets | `V2_DEPLOY=true`. `SITE_URL` and `SITE_BASE` unset (the defaults match). No secrets: no `ANTHROPIC_API_KEY`, so the fallback brief is used and no Daily Brief is shown (owner decision: later) |
| Push run | The push started `refresh.yml`; every job was skipped (`V2_DEPLOY` was not yet set), as designed |
| First build | Dispatch, 19:44Z. Guard, build, deploy, persist and alert all succeeded on Node 24 / Ubuntu. Data build 38 s; 402 / 413 feeds OK; 324 stories, TOP 12, no empty section; gate PASS with one warning (the chronic list below); branch `data` created; `state.json` absent from the site (HTTP 404), as designed |
| Browser | Production build at the live URL: `#/`, `#/sources`, `#/s/ai_security`, `#/q/FINRA` render; 0 console errors with the CSP active |
| Dependabot | Started its first update jobs after the push |

Items the first GitHub run found:

| ID | Item | Action |
|---|---|---|
| GL-1 | The 10 registry feeds on `*.substack.com` (`chinai`, `gary-marcus`, `sacr-software-analyst`, `concordia-ai-safety-china`, `clouded-judgement`, `key-context-tae-kim`, `ramp-economics-lab`, `thesequence`, `more-than-moore`, `the-kaitchup`) answer HTTP 403 to GitHub's hosted runners; all 10 answered 200 from the owner's network the same day. Substack newsletters on their own domains (`understanding-ai`, `big-technology`) are unaffected. All 10 carry the `probation` tag, so the gate lists them as chronic and the Sources page shows them failing | Per source: use the newsletter's own domain where one exists; otherwise pause with a note, or accept. A self-hosted runner would also avoid the block. Not a blocker |
| GL-2 | `nature-ml-news` returned an HTML page instead of its feed from the runner (`not_feed`) | Watch for a week; pause if it persists |
| GL-3 | No Mac launch agent for V2 yet, so GitHub's cron (about 20% of slots fire, measured on V1) is the only clock; the stale banner shows when no build lands for 120 minutes | §10.1 when the owner wants it |

Snapshot: written at 2026-11-20 02:50 UTC, while the final round was still changing source files,
and corrected after that round's closing step (05:30 UTC): test counts, bundle sizes, the last
build, the state hand-over and the feed-audit issue lookup below describe the tree as it stands
now. The `[REMOTE-READ]` rows were read at 02:50 UTC and not re-read. Counts will move again with
the next change. Re-run the pre-flight checklist (§5) before acting.

Status tags used in this document:

| Tag | Meaning |
|---|---|
| `[LOCAL]` | Exercised on the owner's Mac on 2026-11-20 (Node 26.7.0, npm 11.19.0) |
| `[REMOTE-READ]` | Read from GitHub on 2026-11-20 with read-only `gh` calls |
| `[UNTESTED]` | Never exercised. Reasoned from the code, the workflow files or GitHub's documented behaviour |

Related: [CONTRACTS.md](./CONTRACTS.md) (data contract, commands), [`refresh.yml`](../.github/workflows/refresh.yml),
[`feed-audit.yml`](../.github/workflows/feed-audit.yml), [`ci.yml`](../.github/workflows/ci.yml),
[`kick-refresh.sh`](../scripts/kick-refresh.sh).

---

## 1. Current state

| Fact | Value | Source |
|---|---|---|
| V2 location | git worktree `~/Documents/Development/ai-drudge/v2`, local branch `v2`, no upstream | `[LOCAL]` `git worktree list`, `git branch -vv` |
| Commit state | Nothing committed. Branch `v2` still points at the V1 commit it was cut from (`8d5cbc26`, "chore(data): refresh 2026-11-19T20:08:39Z"); all of V2 is working-tree changes | `[LOCAL]` `git status` |
| Only git remote | `origin` = `https://github.com/PNelsonFTP/ai-drudge.git` (the V1 repository) | `[LOCAL]` |
| V1 repository | Public, default branch `main`, the only remote branch; no branch protection, no rulesets, no tags; 75,883 KB | `[REMOTE-READ]` |
| V1 Pages | `build_type: workflow` (source = GitHub Actions), `https://pnelsonftp.github.io/ai-drudge/`; environment `github-pages` admits branch `main` only | `[REMOTE-READ]` |
| V1 variables and secrets | None listed (`gh variable list` and `gh secret list` printed nothing). V1's workflow references `secrets.ANTHROPIC_API_KEY`; if the listing is complete, V1 also publishes the fallback brief | `[REMOTE-READ]` |
| V1 automation | Workflow "Refresh and deploy" (`refresh.yml`) commits data to `main` on every run; "Weekly feed audit" (`feed-audit.yml`); one open bot issue "Feed audit: 26 problems" (#1) | `[REMOTE-READ]` |
| V2 repository | `PNelsonFTP/ai-drudge-v2` does not exist (HTTP 404) | `[REMOTE-READ]` |
| Mac launch agent | One user agent, `~/Library/LaunchAgents/*ai-drudge-refresh.plist`, loaded. It runs `gh workflow run "Refresh and deploy" --repo PNelsonFTP/ai-drudge --ref main` at minute 08 of hours 06-22 and at 02:08 local time | `[LOCAL]` `plutil -p`, `launchctl list` |
| Local checks | In the worktree after the closing round: `npm run typecheck` exit 0; `npm test` 2,782 pass / 0 fail; `npm run build` exit 0. On a clean copy of the to-be-committed tree: the same three commands passed at 2,415 tests (this document's first pass, also with `SITE_BASE=/ai-drudge/`) and at 2,758 tests (the final audit) | `[LOCAL]` see §5 |
| Live data builds | Every logged local `npm run build:data` run since the fix round passed the gate. The three of the final round: 03:34Z and 04:16Z with 413/413 sources OK, the closing build of 05:16:55Z with 412/413 OK and 1 carried forward; 19.3 s, 35.6 s and 23.4 s | build logs of 2026-11-20 |
| GitHub Actions | The V2 workflows have never run on GitHub | — |

V1 keeps running from `main` and its checkout (the parent directory of the worktree). Nothing in this
guide requires editing that checkout.

---

## 2. Configuration reference

### 2.1 Repository variables and secrets (GitHub: Settings > Secrets and variables > Actions)

| Name | Kind | Required | Default when unset | Read by | Notes |
|---|---|---|---|---|---|
| `V2_DEPLOY` | variable | yes, to run anything | unset = every job of `refresh.yml` and `feed-audit.yml` is skipped | job-level `if:` | Must be the exact string `true`. The master switch |
| `SITE_URL` | variable | only when the site is not `https://pnelsonftp.github.io/ai-drudge-v2/` | `https://pnelsonftp.github.io/ai-drudge-v2/` | guard, state restore, deploy verify, Atom/OPML links, default User-Agent | Trailing slash optional |
| `SITE_BASE` | variable | only when the path is not `/ai-drudge-v2/` | `/ai-drudge-v2/` | `vite.config.ts` (`base`), preflight | On `*.github.io` it must equal `/<repository name>/` or the preflight step fails the run |
| `FEED_USER_AGENT` | variable | no | `ai-drudge/2.0 (+<SITE_URL>; feed reader)` | feed fetches, `validate:feeds`, `check:links` | Set only to send a different honest identifier |
| `V2_PUBLISH_STATE` | variable | no | unset = `state.json` is removed from the Pages artifact and reaches the next build through the `data` branch only | "Check dist" step of `build` | Escape hatch: the exact string `true` publishes `state.json` with the site again, and the restore step then also finds it there (§4.4) |
| `ANTHROPIC_API_KEY` | secret | no | unset = deterministic fallback brief (`brief.reason: "no-key"`) | the "Build data" step only, and only on `refs/heads/main` | See §11 |

`GITHUB_TOKEN` is provided by Actions. No personal access token is used anywhere.

### 2.2 Environment variables of the pipeline (`scripts/pipeline/context.ts` `ENV`)

| Variable | Set by | Effect |
|---|---|---|
| `SITE_URL`, `SITE_BASE`, `FEED_USER_AGENT`, `ANTHROPIC_API_KEY` | workflow (from the table above) or the local shell | as above |
| `BUILD_STARTED_AT` | workflow step "Record build start" | The gate fails when `generatedAt` is older than this. In GitHub Actions a missing value is itself a gate failure |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`, `GITHUB_SHA` | Actions | Recorded in `status.json` `.run` (`trigger` is `local` when absent) |
| `STATE_FILE` | nobody (optional) | Path of the state file; default `public/data/v2/state.json` |
| `STATE_URL` | nobody (optional) | URL to download the state from when `STATE_FILE` is missing. **The workflow does not use it**: its "Restore pipeline state" step downloads the file with `curl` before the build |
| `VALIDATE_OUT` | `feed-audit.yml` | Where `validate:feeds` writes its verdict JSON |

### 2.3 Hard-coded defaults that name the V2 repository

Change these only if the new repository is not called `ai-drudge-v2` under the same account; in CI the
variables above override the first three.

| File | Constant |
|---|---|
| `vite.config.ts` | `DEFAULT_SITE_BASE = "/ai-drudge-v2/"` |
| `scripts/pipeline/context.ts` | `DEFAULT_SITE_URL`, `DEFAULT_SITE_BASE` |
| `.github/workflows/refresh.yml`, `feed-audit.yml` | `env.SITE_URL` / `env.SITE_BASE` fallbacks |
| `scripts/kick-refresh.sh` | `AID_REPO` default `PNelsonFTP/ai-drudge-v2`; refuses `pnelsonftp/ai-drudge` unless `AID_ALLOW_V1=1` |

---

## 3. Preview locally

Requirements: Node >= 22.15.0 (`package.json` `engines`; CI uses Node 24 from `.node-version`), npm.
All commands run in the worktree root.

| # | Command | Result | Network |
|---|---|---|---|
| 1 | `npm ci --ignore-scripts` | Installs the locked dependencies (same command as CI) | npm registry |
| 2a | `npm run data:fixture` | Installs the committed fixture (8 JSON files from `test/fixtures/v2/`, each checked against `test/fixtures/v2.manifest.json`) in `public/data/v2/` | none |
| 2b | `env -u ANTHROPIC_API_KEY npm run build:data` | Fetches every registry source and writes `public/data/v2/*.json` (9 files incl. `state.json`), `public/feed.xml`, `public/feeds.opml` | about 413 sources, a quote endpoint, Hacker News |
| 3 | `npm run dev -- --port 5180 --strictPort` | Dev server at `http://localhost:5180/ai-drudge-v2/` | none |
| 4 | `npm run build && npm run preview` | Production build in `dist/`, served by Vite's preview server (default port 4173: `http://localhost:4173/ai-drudge-v2/`) | none |

Notes:

- Use 2a **or** 2b. Both targets are gitignored.
- **2a (fixture):** the data is a frozen live build (2026-11-20T05:16Z: 322 stories, 413 sources,
  paywall flags, a 31-publisher lead, regulator notices), so the page looks like a real V2 edition
  of that day and shows the stale banner ("Headlines may be delayed") — expected. Three of its
  health rows are **synthetic** (one skipped by host backoff, one failing, one
  quarantined source, all `probation` sources; listed in the manifest; the carried row is real) so that the Sources page has
  every state to show. `npm run build:check` on a fresh clone exits 1 with `feed.xml: missing` and
  `feeds.opml: missing` — expected (`[LOCAL]`): the two XML files are not part of the fixture.
  `npm run fixture:refresh` replaces the fixture with the last build (CONTRACTS.md §12).
- **2b (live):** 19-37 s measured. `env -u ANTHROPIC_API_KEY` matters: if the key is exported in the
  shell, a local build calls the Claude API and is billed (§11). Follow with `npm run build:check`
  (expect `PASS  data gate passed`).
- **Step 3:** `--strictPort` fails instead of choosing another port when 5180 is taken (a dev server
  may already be running there). The dev server sends no Content-Security-Policy.
- **Step 4:** the production build carries the CSP `<meta>` and the frame guard; opened inside another
  site's iframe it shows only an "Open AI DRUDGE" link. The preview URL was not opened in this round
  (the port is Vite's `DEFAULT_PREVIEW_PORT`).
- Different base path: `SITE_BASE=/some-path/ npm run build` (`[LOCAL]` verified for `/ai-drudge/`).

---

## 4. How the deployment works

### 4.1 Workflows

| File | Name | Triggers | Guarded by `V2_DEPLOY` |
|---|---|---|---|
| `refresh.yml` | V2 refresh and deploy | cron `7,22,37,52 * * * *` (UTC), `workflow_dispatch`, push to `main` (except `docs/**` and `**.md`) | yes |
| `feed-audit.yml` | V2 weekly audit (dependencies, feeds, links) | cron `23 12 * * 1` (Mondays 12:23 UTC), `workflow_dispatch` | yes |
| `ci.yml` | V2 pull-request checks | `pull_request` | no (deploys nothing; read-only token, no secrets) |

`.github/dependabot.yml` (weekly npm and Actions updates, 7-day cooldown) takes effect only on a
repository's default branch.

### 4.2 Jobs of `refresh.yml`

| Job | Token permissions | What it does | Runs when |
|---|---|---|---|
| `guard` | none | Scheduled runs only: reads `<SITE_URL>data/v2/status.json`; sets `skip=true` when `generatedAt` is younger than 20 minutes | `V2_DEPLOY == 'true'` |
| `build` | `contents: read` | Preflight, `npm ci --ignore-scripts`, typecheck, tests, state restore, data build (12-minute hard limit), gate, site build, dist check (removes `state.json` from `dist/` unless `V2_PUBLISH_STATE=true`), uploads the Pages artifact and the `v2-state` artifact (7-day retention). Job outputs `state_lost` and `brief_alert` feed the `alert` job | guard did not skip |
| `deploy` | `pages: write`, `id-token: write` | `actions/deploy-pages`, up to 3 attempts (30 s and 90 s apart), then polls `status.json` for this run id (informational) | build succeeded **and** ref is `main` |
| `persist` | `contents: write` | Force-pushes ONE orphan commit (`state.json`, `status.json`, `README.md`) to branch `data` | build succeeded **and** ref is `main` (also when deploy failed) |
| `alert` | `issues: write` | Two rolling issues. "V2 refresh failing": opened, commented on (at most every 180 minutes) or closed by run result; it also reports a build that found no state while the site is up (`state_lost`). "V2 Daily Brief failing": opened, commented on (at most daily) or closed from the gate's brief alert - six consecutive builds whose Claude brief failed with a key configured | ref is `main`; not after a manual cancel |

Fixed properties: workflow-level `permissions: {}`; concurrency group `v2-refresh-deploy` with
`cancel-in-progress: false` (runs queue; V1's group is `refresh-deploy`); every action pinned to a
commit SHA; nothing is ever committed to `main`.

### 4.3 Preflight (first step of `build`)

| Condition | Result |
|---|---|
| Scheduled run on a ref other than `main` | Run fails: "wrong branch" (the default branch must be `main`) |
| Dispatch on another ref | Notice "test build"; the run builds and gates with the fallback brief and deploys nothing |
| `SITE_URL` host is `*.github.io` and `SITE_BASE` is not `/<repository>/` | Run fails: "site base", with the values to set |
| `SITE_URL` host is anything else (custom domain) | Not checked |

### 4.4 State, the `data` branch and the first run

`state.json` (first-seen ledger, feed health, last-good items, river memory, lead) is handed from
build to build. Restore order at the start of every build:

1. branch `data` (`state.json` in its single commit, written by the `persist` job of the previous
   run) — the primary path;
2. a copy on the live site, `<SITE_URL>data/v2/state.json` — present only with
   `V2_PUBLISH_STATE=true` or left by an older deployment; used when the branch has no valid file,
   and it also wins when it is strictly newer (`savedAt`), i.e. a run whose deploy succeeded and
   whose persist failed;
3. empty.

First-run bootstrap (no live site, no `data` branch):

| Aspect | Behaviour on the first build |
|---|---|
| Restore | "State restored from: none (starting empty)"; no warning, because `status.json` is not reachable either |
| First-seen times | Baseline run: a dated item is first seen at its `publishedAt`, so the edition is not flooded with "new" items |
| Feed fetches | No conditional-GET validators yet: 0 "not modified" (first local build: 34.0 s; later builds: 259 of 412 answered 304, 23.9 s) |
| River | Starts with what the feeds list today; the 7-day memory fills over later builds |
| `data` branch | Created by the first successful `persist` job |
| Second build onward | State is restored from the `data` branch ("State restored from: **data branch**" in the run summary) |

If a later build finds the site up but no usable state in either place, it runs with first-run
semantics, emits the annotation `state restore` (first-seen times re-stamped, failure streaks lost)
and the `alert` job opens or keeps "V2 refresh failing" until a run restores its state. One such
build after a failed persist is harmless; if it repeats, check the `persist` job and the `data`
branch, or set `V2_PUBLISH_STATE=true`.

`state.json` is **not in the Pages artifact** by default (3.31 MB raw after the closing build of
2026-11-20T05:16Z; the pipeline refuses to write a state file above 24 MB). It is still public in
practice: the `data` branch belongs to a public repository. It contains feed-derived text only, no
reader data. Requirement: the `data` branch must stay force-pushable by `github-actions[bot]` -
with the state out of the site it is the only hand-over path. `[UNTESTED]` on GitHub: the restore
and persist steps were executed locally against a bare repository only.

### 4.5 The gate

`npx tsx scripts/tools/check-data.ts --write-status` runs after the data build. Exit 1 holds the
deploy: nothing is uploaded and the previous deploy keeps serving. Failures include: a file missing
or failing its guard, cross-file invariants, `generatedAt` older than `BUILD_STARTED_AT`, fewer than
60 stories, fewer than 10 of 15 sections with rows, a section showing fewer homepage rows than it
holds, newest placed story more than 24 h older than the build, a row older than 60 days, fewer than
60% of live feeds OK, 25% or more of the registry answering empty, a file over its size ceiling,
malformed `feed.xml` / `feeds.opml`. Thresholds: `GATE` in `scripts/pipeline/emit/quality.ts`.
Warnings never block; they become run annotations and `status.json` `.gate.warnings`.

Zero-article guard: when nothing survives relevance the pipeline writes nothing, marks the existing
`status.json`, exits 0, and the freshness check then holds the deploy.

### 4.6 Cadence

| Source of runs | Cadence | Notes |
|---|---|---|
| GitHub cron | 4 slots an hour, at most 2 builds an hour after the guard | Backstop only. On V1, GitHub fired about 20% of scheduled slots in October-November 2026 (ops review of 2,186 runs). Schedules run from the default branch only, and GitHub disables them after 60 days without repository activity on a public repository |
| Mac launch agent | whatever the agent's calendar says | `workflow_dispatch` always builds (the guard only drops scheduled slots). See §10 |
| Push to `main` | per push | Not for `docs/**` or `*.md` |
| Reader's browser | re-fetches data every 10 minutes while the tab is visible | Client side; unrelated to builds |

`status.json` declares `cadenceMinutes: 30` and `staleAfterMinutes: 120`. The second number is
reader-facing: the client's "Headlines may be delayed" banner follows it (§12 notes). It was 90
until the final review round; 120 keeps one skipped scheduled run from raising the banner.

---

## 5. Pre-flight checklist

Run in the worktree root. None of these writes to git or to GitHub.

| # | Check | Command | Expected (2026-11-20 result) |
|---|---|---|---|
| 1 | Types | `npm run typecheck` | exit 0 (`[LOCAL]`) |
| 2 | Tests | `npm test` | 2,782 pass, 0 fail (`[LOCAL]`, after the closing round) |
| 3 | Site build | `npm run build` | exit 0; entry JS 338.58 kB raw / 108.20 kB gzip (`[LOCAL]`, closing round) |
| 4 | Dependencies | `npm audit --audit-level=high` | 0 vulnerabilities in the final round's integration step; not re-run for this document |
| 5 | Gate on live data (optional, network) | `env -u ANTHROPIC_API_KEY npm run build:data && npm run build:check` | `PASS  data gate passed` (last run 05:16Z) |
| 6 | Kick script defaults | `AID_DRY_RUN=1 bash scripts/kick-refresh.sh` | `workflow 'refresh.yml' in PNelsonFTP/ai-drudge-v2 on ref 'main'`, nothing dispatched (`[LOCAL]`) |
| 7 | No secrets in the tree | command 7 below | One hit, a fake string in `scripts/pipeline/emit/quality.test.ts` (`[LOCAL]`) |
| 8 | `gh` can push workflow files | `gh auth status` | Token scopes include `repo` and `workflow` (`[LOCAL]`) |
| 9 | What will be committed | `git status --short` | Review it. `public/data/v2/`, `public/feeds.opml`, `dist/`, `node_modules/` must not appear (ignored) |
| 10 | `main` has only data commits since the fork (Option C only) | command 10 below | No output (`[LOCAL]` against the local `origin/main` ref, without the fetch) |

```bash
# 7
grep -rIlE "sk-ant-[A-Za-z0-9]|ghp_[A-Za-z0-9]{20}|github_pat_|PRIVATE KEY" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .

# 10
git fetch origin
git diff --stat "$(git merge-base v2 origin/main)" origin/main -- . ':(exclude)public/data' ':(exclude)public/feed.xml'
```

How checks 1-3 were verified for a clean checkout: the files git would commit (tracked and untracked,
not ignored, without `public/feed.xml`; 443 files at the time) were copied to a scratch directory
with no `public/data/`, and the three commands were run there. This answers the open question from
the fix round whether `npm test` needs generated data: it does not. It was run on Node 26.7.0 on
macOS; CI uses Node 24 on Ubuntu, which is `[UNTESTED]`. The final audit repeated the clean-copy
check on the later tree (2,758 tests, also with a simulated Actions environment and `TZ=UTC`). The
cheapest way to close the Node 24 / Linux gap before go-live is a draft pull request from `v2`,
which runs `ci.yml` on GitHub (§9.1; do not merge it).

---

## 6. Go-live options

| | A. New repository (recommended) | B. Push branch `v2` to the V1 repository, no merge | C. Replace V1 on `main` |
|---|---|---|---|
| What happens | `PNelsonFTP/ai-drudge-v2` is created; V2 deploys to its own Pages site | Branch `v2` exists on GitHub next to `main` | `main` of `PNelsonFTP/ai-drudge` becomes the V2 tree |
| V2 URL | `https://pnelsonftp.github.io/ai-drudge-v2/` | none (nothing deploys) | `https://pnelsonftp.github.io/ai-drudge/` |
| Effect on V1 | None. V1 keeps its repository, workflows, URL and launch agent | None while nobody merges and nobody dispatches `feed-audit.yml` on `v2` | V1 stops: its workflows, scripts and committed data leave `main` |
| Scheduled refresh of V2 | Yes (cron on the new default branch) | No (schedules run from the default branch only) | Yes |
| Repository settings to change | New repo: Pages source, `V2_DEPLOY` | None needed | `SITE_URL`, `SITE_BASE`, `V2_DEPLOY` in the V1 repo |
| Mac launch agent | V1 agent unchanged; add a second agent for V2 | unchanged | Existing agent must be edited (its workflow name stops existing) |
| Undo | Set `V2_DEPLOY=false`, or delete the repository | Delete the remote branch | One rollback commit that restores the V1 tree (§9.4) |
| Risk to the live site | None | None | The V1 URL is stale from the push until the first V2 deploy; rollback is a manual procedure |
| Choose when | Default. Side-by-side comparison, zero-risk trial | An off-machine backup or a review copy is wanted before deciding | V2 has run cleanly under A (or the owner accepts a direct cutover) and the V1 URL must be kept |

All three start with the same local commit (§7). A and B can be done together; C can follow A later
from the same branch.

Shared-origin note for A and C: both sites are served from `pnelsonftp.github.io`, so they share one
`localStorage`. V2 uses the `aid2:` namespace, reads V1's `ai-drudge:*` keys once and never writes
them, so V1 reader state is imported in either option. The same shared origin means any script on any
page of that origin can read V2's reader state (watchlist terms, saved items). A custom domain removes
that (`SITE_BASE=/`, `SITE_URL=https://<domain>/`, domain configured in the Pages settings); it is
supported by the variables and skipped by the preflight, and is `[UNTESTED]`.

---

## 7. Step 0 for every option: the one local commit

`[UNTESTED]` — no git write command was run in any build or review round.

```bash
cd ~/Documents/Development/ai-drudge/v2
git status --short                 # review what will be committed
git add -A
git rm --cached public/feed.xml    # the one extra git step the cutover needs
git ls-files public                # must print exactly: public/favicon.svg
git commit -m "AI DRUDGE V2"
```

Why `git rm --cached public/feed.xml`: V1 committed `public/feed.xml`; V2 generates it on every build
and lists it in `.gitignore`. Git ignores only untracked files, so without this step the file stays
tracked and every local build shows it as modified. The V1 data files
(`public/data/{brief,headlines,headlines-preview,stocks}.json`) are already deleted in the working
tree; `git add -A` stages those deletions. They remain in V1's history.

The commit is local. It changes nothing on GitHub and nothing in the V1 checkout (`main` is a
different branch in a different directory).

---

## 8. Option A — new repository (recommended)

All `[UNTESTED]`. Steps are in order.

| # | Action | Command or location |
|---|---|---|
| 1 | Commit | §7 |
| 2 | Create an empty public repository | `gh repo create PNelsonFTP/ai-drudge-v2 --public --description "AI DRUDGE V2"` |
| 3 | Add it as a second remote | `git remote add v2site https://github.com/PNelsonFTP/ai-drudge-v2.git` |
| 4 | Push branch `v2` as `main` | `git push v2site v2:main` |
| 5 | Confirm the default branch is `main` | `gh repo view PNelsonFTP/ai-drudge-v2 --json defaultBranchRef --jq .defaultBranchRef.name` |
| 6 | Enable Pages with source = GitHub Actions | Repository Settings > Pages > Build and deployment > Source: **GitHub Actions**. API equivalent: `gh api -X POST repos/PNelsonFTP/ai-drudge-v2/pages -f build_type=workflow` |
| 7 | Turn the workflows on | `gh variable set V2_DEPLOY --body true --repo PNelsonFTP/ai-drudge-v2` |
| 8 | Start the first build | `gh workflow run refresh.yml --repo PNelsonFTP/ai-drudge-v2 --ref main` |
| 9 | Watch it | `gh run watch --repo PNelsonFTP/ai-drudge-v2 "$(gh run list --repo PNelsonFTP/ai-drudge-v2 --workflow refresh.yml --limit 1 --json databaseId --jq '.[0].databaseId')"` |
| 10 | Verify | §12 |
| 11 | Optional: Mac kick for V2 | §10.1 |
| 12 | Optional: AI-written brief | §11 |

What to expect:

- Step 4 pushes the whole history of branch `v2`, which includes V1's history up to the fork point
  (the V1 repository is 75,883 KB). To start the new repository with a single commit instead, see §8.1.
- Step 4 triggers `refresh.yml` once (push to `main`). `V2_DEPLOY` is not set yet, so every job is
  skipped. This is the designed inert state.
- Later pushes: always `git push v2site v2:main`. Do not set an upstream; the local branch is named
  `v2` and the remote branch `main`, and a bare `git push` would refuse or surprise.
- `SITE_URL` and `SITE_BASE` need no variables: the defaults match this repository name. With any
  other name, set both (the preflight error message prints the exact values).
- Step 6 must precede step 8. `refresh.yml` does not enable Pages itself; `deploy-pages` fails on a
  repository without Pages.
- Do not add a branch rule that blocks force pushes on `data`: the `persist` job force-pushes one
  orphan commit there on every build.
- Once `.github/dependabot.yml` is on the default branch, Dependabot opens pull requests (Mondays
  07:00 America/Chicago; at most 3 npm and 2 Actions PRs); `ci.yml` checks them.
- V1: no change of any kind. Its launch agent, cron and URL keep working.

### 8.1 Variant: start the new repository with one commit

Replaces steps 3-4. The new repository gets no V1 history, and the working copy for V2 becomes a
separate clone that has no remote pointing at V1. `[UNTESTED]`.

```bash
cd ~/Documents/Development/ai-drudge/v2
mkdir ~/Documents/Development/ai-drudge-v2
git archive v2 | tar -x -C ~/Documents/Development/ai-drudge-v2     # exactly the committed tree
cd ~/Documents/Development/ai-drudge-v2
git init -b main
git add -A
git commit -m "AI DRUDGE V2"
git remote add origin https://github.com/PNelsonFTP/ai-drudge-v2.git
git push -u origin main
npm ci --ignore-scripts
```

Trade-off: `git blame` continuity with V1 is lost, and Option C can no longer be a simple push from
this copy (the histories are unrelated). The old worktree stays as it was until removed.

### 8.2 Retiring V1 later (after A has proven itself)

Not part of go-live. Unload the V1 launch agent (§10.2) and run
`gh workflow disable refresh.yml --repo PNelsonFTP/ai-drudge`; the V1 site then stays up with its last
data. A redirect from the V1 URL needs a commit in the V1 repository and is out of scope here.

---

## 9. Options B and C — the existing repository

### 9.1 Option B — push the branch, do not merge

`[UNTESTED]`.

```bash
# after §7
git push -u origin v2
```

What works and what does not on a non-default branch of `PNelsonFTP/ai-drudge`:

| Mechanism | Result on branch `v2` | Reason |
|---|---|---|
| Cron schedules in V2's workflow files | Never fire | GitHub runs scheduled workflows from the default branch only; `main` still holds V1's workflows |
| `push` trigger of `refresh.yml` | Does not fire | `branches: [main]` |
| `ci.yml` | Runs only if a pull request is opened from `v2` | `pull_request` uses the PR's own workflow file. Opening a (draft) PR is the cheapest way to get typecheck, tests and site build on GitHub's Node 24 — **do not merge it**. It will show conflicts in `public/data/*` and `public/feed.xml`; ignore them |
| `gh workflow run refresh.yml --repo PNelsonFTP/ai-drudge --ref v2` | Dispatches V2's version of the file | Dispatch needs a workflow file with the same path on the default branch; V1 has `refresh.yml` and `feed-audit.yml`, both with `workflow_dispatch` |
| …with `V2_DEPLOY` unset (today) | Every job skipped | job-level guard |
| …with `V2_DEPLOY=true` and no `SITE_*` variables | Build fails in preflight ("site base": `/ai-drudge-v2/` vs repository `ai-drudge`) | by design |
| …with `V2_DEPLOY=true`, `SITE_BASE=/ai-drudge/`, `SITE_URL=https://pnelsonftp.github.io/ai-drudge/` | Full test build: install, typecheck, tests, data build with the fallback brief, gate, site build, artifacts uploaded | `deploy`, `persist` and `alert` require `refs/heads/main`; the API key is passed on `main` only; the `github-pages` environment admits `main` only |
| `gh workflow run feed-audit.yml --ref v2` with `V2_DEPLOY=true` | Runs, and its report job **edits or closes V1's open "Feed audit:" issue (#1)** | The report job has `issues: write` on any ref and matches an open issue whose title starts with "Feed audit:" and whose author is a bot (the author check was added in the closing round); V1's issue #1 was opened by V1's workflow, so it still matches. Avoid |
| Dependabot | Inert | default branch only |
| Mac launch agent | Unchanged, keeps kicking V1 | — |
| V1 workflows | Unaffected by `V2_DEPLOY` / `SITE_*` variables | They read no `vars.*` |

B produces no public V2 site. It is a backup and review step, and optionally a first CI run.
Undo: `git push origin --delete v2` (and delete any variables that were set).

### 9.2 Option C — cutover on `main`

`[UNTESTED]`. Do steps 3-9 in one sitting; the V1 URL serves V1's last
deploy from step 6 until step 8 completes.

| # | Action | Command |
|---|---|---|
| 1 | Commit | §7 |
| 2 | Pre-flight check 10 (§5) | must print nothing |
| 3 | Stop the Mac kicks | §10.2, "unload" |
| 4 | Set the site variables (not `V2_DEPLOY` yet) | `gh variable set SITE_BASE --body /ai-drudge/ --repo PNelsonFTP/ai-drudge` and `gh variable set SITE_URL --body https://pnelsonftp.github.io/ai-drudge/ --repo PNelsonFTP/ai-drudge` |
| 5 | Make sure no V1 run is in flight | `gh run list --repo PNelsonFTP/ai-drudge --limit 5` (all `completed`) |
| 6 | Tag V1, record it as merged, push | block below |
| 7 | Turn V2 on | `gh variable set V2_DEPLOY --body true --repo PNelsonFTP/ai-drudge` |
| 8 | First build | `gh workflow run refresh.yml --repo PNelsonFTP/ai-drudge --ref main`, then watch as in §8 step 9 |
| 9 | Verify (§12) with `SITE=https://pnelsonftp.github.io/ai-drudge/` | — |
| 10 | Repoint and reload the launch agent | §10.2, "repoint" |

Step 6:

```bash
cd ~/Documents/Development/ai-drudge/v2
git fetch origin
git tag v1-final origin/main
git merge -s ours origin/main -m "Cut over to V2: keep the V2 tree, record V1 main as merged"
git push origin v1-final v2:main
```

`git merge -s ours` creates a merge commit whose tree is exactly the V2 tree and whose second parent
is V1's `main`, so the push is a fast-forward and no conflict has to be resolved (a normal merge
would conflict on every V1 data file: modified on `main`, deleted on `v2`). It discards everything
committed to `main` since the fork point, which is why pre-flight check 10 must show that only data
files changed. If the push is rejected because a V1 run committed in between, repeat `git fetch`,
`git merge -s ours origin/main` and `git push origin v2:main`; the tag can stay where it is (V1's
code is identical in every recent commit; only the data snapshot differs).

What changes for V1 at step 6:

| V1 thing | After the push |
|---|---|
| V1 site | Keeps serving its last deploy until the first V2 deploy replaces it |
| `refresh.yml` / `feed-audit.yml` | Same paths, now V2's files, named "V2 refresh and deploy" and "V2 weekly audit (…)". Inert until step 7. The push itself starts one `refresh.yml` run in which every job is skipped |
| V1 cron (`17 * * * *`, `47 11-23,0-3 * * *`) | Gone with the file |
| Committed data (`public/data/*.json`, `public/feed.xml`) | Removed from the tree; kept in history and under tag `v1-final`. V2 never commits data to `main` |
| V1 code (`scripts/build-data.ts`, `src/App.tsx`, …) | Removed from the tree; kept in history |
| Open issue #1 "Feed audit: 26 problems" | The first V2 weekly audit rewrites or closes it (same title prefix, opened by a bot) |
| Launch agent | Every kick fails (`"Refresh and deploy"` no longer exists) until repointed |

Option C no longer has a gate side effect (closing round): `scripts/tools/check-data.ts` compares
the Atom feed's self link with the configured `SITE_URL` instead of testing for the V1 address, so
the feed of a V2 served from the V1 path raises no warning as long as the repository variable
`SITE_URL` names that address for the build and the gate alike.

The first V2 build on this repository is a first-run bootstrap (§4.4): `/ai-drudge/data/v2/state.json`
does not exist and there is no `data` branch.

### 9.3 Stopping V2 without rolling back

`gh variable set V2_DEPLOY --body false --repo <R>` skips every job from the next run on. The site
keeps serving the last deploy and shows the stale banner once the data is older than 120 minutes
(§12 notes). Works the same in A and C.

### 9.4 Rollback of Option C

`[UNTESTED]`. Restores the V1 tree with one new commit; no history is rewritten. A fresh clone keeps
the procedure away from the worktree and the V1 checkout.

```bash
gh variable set V2_DEPLOY --body false --repo PNelsonFTP/ai-drudge
git clone https://github.com/PNelsonFTP/ai-drudge.git ~/aid-rollback
cd ~/aid-rollback
git rm -r -q .
git checkout v1-final -- .
git commit -m "Roll back to V1 (tree of v1-final)"
git push origin main
```

| After the push | Detail |
|---|---|
| V1 refresh | The push triggers V1's "Refresh and deploy" (it runs on every push to `main`), which fetches fresh data, commits it and deploys V1 |
| Launch agent | Works again if it calls `refresh.yml` by file name (§10.2); the original form (`"Refresh and deploy"`) also works again |
| Leftovers to clean by hand | Branch `data` (`git push origin --delete data`), an open "V2 refresh failing" issue, the three variables (V1 ignores them) |
| Readers | V2's `aid2:` keys stay in their browsers; V1 ignores them |

Bad data never needs a rollback: the gate holds a failing build and the previous deploy keeps
serving. A bad V2 code change is reverted with a normal `git revert` and push (the push rebuilds and
redeploys).

---

## 10. The Mac launch agent (refresh kick)

GitHub's cron is a backstop (§4.6). The real clock is a launchd user agent on the owner's Mac that
dispatches the workflow. launchd cannot read `~/Documents`, so an agent must call `gh` directly or a
copy of the script outside that folder. The Mac must be awake; missed calendar slots are not replayed
individually.

`scripts/kick-refresh.sh`: dispatches `refresh.yml` in `AID_REPO` (default `PNelsonFTP/ai-drudge-v2`)
on `AID_REF` (default `main`), 3 attempts 15 s apart, `AID_DRY_RUN=1` prints and exits, refuses the V1
repository unless `AID_ALLOW_V1=1`.

### 10.1 Option A: a second agent for V2

`[UNTESTED]`. Minutes 5 and 35 are chosen so that every cron slot (:07, :22, :37, :52) falls inside
the guard's 20-minute freshness window after a successful kick; cron then builds only when a kick was
missed. That is arithmetic from the workflow constants, not observed behaviour.

```bash
install -d ~/.local/bin
install -m 755 scripts/kick-refresh.sh ~/.local/bin/ai-drudge-v2-kick.sh
cat > ~/Library/LaunchAgents/local.ai-drudge-v2-refresh.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.ai-drudge-v2-refresh</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$HOME/.local/bin/ai-drudge-v2-kick.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Minute</key><integer>5</integer></dict>
    <dict><key>Minute</key><integer>35</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ai-drudge-v2-refresh.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ai-drudge-v2-refresh.err</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.ai-drudge-v2-refresh.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.ai-drudge-v2-refresh.plist
launchctl kickstart gui/$(id -u)/local.ai-drudge-v2-refresh     # one kick now
tail -n 3 ~/Library/Logs/ai-drudge-v2-refresh.log                # expect "kick-refresh: dispatched at ..."
```

Remove: `launchctl bootout gui/$(id -u)/local.ai-drudge-v2-refresh` and delete the plist. The V1 agent
is not touched. Re-copy the script after any change to `scripts/kick-refresh.sh`.

### 10.2 Option C: the existing agent

The existing agent passes the workflow **name** `"Refresh and deploy"` as `ProgramArguments[3]`. That
name disappears at cutover. The file name `refresh.yml` is valid before and after. `[UNTESTED]`.

```bash
PLIST="$(ls ~/Library/LaunchAgents/*ai-drudge-refresh.plist)"
plutil -p "$PLIST"                                   # inspect first

# unload (cutover step 3)
launchctl bootout gui/$(id -u) "$PLIST"

# repoint (cutover step 10), then reload
plutil -replace ProgramArguments.3 -string refresh.yml "$PLIST"
launchctl bootstrap gui/$(id -u) "$PLIST"
```

The agent's calendar stays hourly at minute 08 (06:08-22:08 and 02:08). With V2's cron that minute
can produce two consecutive builds: when GitHub fires the :07 slot and the data is older than 20
minutes, that slot builds and the :08 kick queues a second build behind it. Moving the agent to
minutes 5 and 35 (§10.1) avoids that and gives the 30-minute cadence `status.json` declares.

---

## 11. The AI-written Daily Brief

Off by default. Without a key every build publishes the deterministic brief
(`brief.source: "fallback"`, `reason: "no-key"`), which the client does **not** render: the homepage
shows a Daily Brief only when `brief.json` has `source: "claude"`.

**Never exercised:** no build, local or CI, has called the API (every log says `no-key`).

Turn it on (`[UNTESTED]`):

| # | Action | Detail |
|---|---|---|
| 1 | Create an API key | Owner action in the Anthropic Console. Recommended: a workspace used only for this site, with a monthly spend limit |
| 2 | Store it as a repository secret | `gh secret set ANTHROPIC_API_KEY --repo <R>` — paste the value at the prompt. Never put it in a file, a variable or a command argument |
| 3 | Nothing else | The next build on `main` uses it |
| 4 | Verify | `status.json`: `.brief == {"source":"claude"}`. `brief.json`: `.model` names the model that answered. Build log: `brief: written by <model> from N stories (stop_reason end_turn, input_tokens X, output_tokens Y, …)` |

Turn it off: `gh secret delete ANTHROPIC_API_KEY --repo <R>`.

| Property | Value (from `scripts/pipeline/enrich/brief.ts`) |
|---|---|
| Model | `BRIEF_MODEL = "claude-sonnet-5"`; request sends `thinking: {type: "disabled"}` and `output_config.effort: "low"` with a JSON schema. The code comment warns that `claude-sonnet-5-5` rejects that `thinking` value with a 400: read it before changing the id |
| Endpoint | `POST api.anthropic.com/v1/messages` over HTTPS (written without the scheme so the link checker, which sends `HEAD` / `GET`, does not report the POST-only endpoint as broken), header `anthropic-version: 2026-10-21`, raw `fetch` (no SDK dependency) |
| Calls | One per build; 45 s timeout; one retry after HTTP 408, 429, 500, 502, 503, 504, 529 or a network error (no retry after a timeout) |
| Data sent | Up to 24 stories (TOP STORIES plus the lead of each ai-desk section): title, outlet names, section, age, URL and, for first-hand sources only, a summary of at most 280 characters. All of it is already public. No reader data |
| Key exposure | The secret is passed to the "Build data" step only, on `refs/heads/main` only; the pipeline hands it to the brief stage alone and deletes it from `process.env` before any feed is fetched. Pinned by `scripts/tools/workflows.test.ts`. Residual: ingest and the brief still share one Node process |
| Output checks | The reply is validated field by field; every cited URL must be one that was sent; anything else is discarded and the fallback is published |
| Failure signal | `brief.json` `fallbackReason` / `status.json` `.brief.reason` (`http-4xx`, `http-5xx`, `timeout`, `network`, `refusal`, `truncated`, `invalid-reply`, `error`) plus the gate warning `brief: Claude brief unavailable (<code>) - fallback published`. A failing brief never fails the build and notifies nobody; check `status.json` after enabling |
| Audit trail | `brief.json` `.model` and `.generatedAt` (public); token usage per build in the Actions log (GitHub keeps logs 90 days) |

---

## 12. Post-deploy verification

Set `R` and `SITE` first (Option A: `R=PNelsonFTP/ai-drudge-v2`,
`SITE=https://pnelsonftp.github.io/ai-drudge-v2/`). All `[UNTESTED]` against a live site; the
`status.json` shape is from a local build.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Run result | `gh run list --repo $R --workflow refresh.yml --limit 3` | `completed success`; jobs `guard`, `build`, `deploy`, `persist`, `alert` all green |
| 2 | Status file | command 2 below | `run.id` = the Actions run id, `run.trigger` = `workflow_dispatch`, `gate.passed` = `true`, `gate.failures` = `[]`, `feeds.total` = the number of active sources (413 on 2026-11-20) |
| 3 | The gate, in the log | Step "Freshness and quality gate" of the build job | `freshness   ok - generated by this build (started …)` and `PASS  data gate passed` |
| 4 | State restore | Run summary of the build job | First run: "State restored from: **none (starting empty)**". Second run: "**data branch**" |
| 5 | `data` branch | `gh api "repos/$R/commits?sha=data" --jq 'length, .[0].commit.message'` | `1` and `data: state <time> (run <id>)` |
| 6 | Page and assets | command 6 below | HTTP 200; the script path starts with the site base (`/ai-drudge-v2/assets/…`). A wrong base gives a blank page with 404s |
| 7 | Feeds for readers | command 7 below | HTTP 200 for both |
| 8 | In a browser | Open `$SITE` | Lead, TOP STORIES and 15 sections render; the tagline reads "N stories · updated …"; no banner; the console shows no CSP violation; `#/about` shows the build id and time |
| 9 | Guard | Wait for a scheduled run that starts within 20 minutes of a build | `guard` green, `build` / `deploy` / `persist` skipped |
| 10 | Stale banner | Leave `V2_DEPLOY=false` for more than 2 hours (optional) | Banner "Headlines may be delayed — the last edition is … old." with "Check again"; the About page says the data is more than 2 hours old (both read `status.json` `staleAfterMinutes`, 120) |
| 11 | Failure alert | Only when a run fails | One open issue "V2 refresh failing" naming the failed step; closed automatically by the next fully successful run |
| 12 | Weekly audit | `gh workflow run feed-audit.yml --repo $R --ref main` (optional; otherwise Monday 12:23 UTC) | Run green unless `npm audit` finds high/critical advisories; dead feeds open a "Feed audit:" issue but do not fail the run |

```bash
# 2
curl -fsS "${SITE}data/v2/status.json?t=$(date +%s)" \
  | jq '{generatedAt, run, gate, brief, feeds: (.feeds | {total, ok, failed, carriedForward, quarantined})}'

# 6
curl -fsSI "$SITE" | head -1
curl -fsS "$SITE" | grep -o 'src="[^"]*"'

# 7
curl -fsSI "${SITE}feed.xml" | head -1
curl -fsSI "${SITE}feeds.opml" | head -1
```

Notes:

- GitHub Pages serves with a cache lifetime of about 10 minutes (`max-age=600` observed on V1); use
  the `?t=` query when checking by hand. The deploy job's own verification does.
- Stale banner threshold (`staleThresholdHours` in `src/features/chrome/model.ts`): the age of the
  edition's `generatedAt` is compared with `status.json` `staleAfterMinutes` (120) once the client
  has loaded that file; when it has not loaded, or the number is outside 30 minutes to 24 hours, the
  constant `STALE_BANNER_HOURS = 2` (`src/app/services.ts`) applies. The About page uses the same
  function, so it cannot contradict the banner. The banner is suppressed until the first
  revalidation after a page load has finished. To change the threshold, change
  `PIPELINE.staleAfterMinutes` (`scripts/pipeline/context.ts`) - one number, no client deploy.
- `status.json` is otherwise an operator file: the guard and the deploy check read it.
- Rendering of the stale banner, the offline message and the production CSP has not been checked in
  a browser.
- Reference numbers from the last local build (the closing build, 2026-11-20T05:16:55Z): 322
  stories in 367 rows, 12 top, 412/413 sources OK and 1 carried forward (185 answered 304; the
  Hacker News searches read the HN Algolia API instead of hnrss.org), 23.4 s (ingest 19.2 s),
  `front.json` 43.9 KB gzip.

---

## 13. Cost

| Item | Cost | Basis |
|---|---|---|
| GitHub Actions minutes | $0 while the repository is public | Standard GitHub-hosted runners are free for public repositories (GitHub billing policy; not re-checked for this document) |
| Run volume | Up to 48 builds a day at the 30-minute cadence, plus one run per code push; scheduled slots that the guard skips cost one short job | Workflow constants |
| Build duration on GitHub | Unknown (`[UNTESTED]`). Local: typecheck a few seconds, tests about 19 s, data build 19-37 s, site build under 1 s; add checkout and `npm ci` | `[LOCAL]` |
| If the repository were private | A full run has 5 jobs and GitHub bills each job rounded up to a whole minute: roughly 5-8 billed minutes a run, 7,000-11,000 a month at 48 runs a day — far above a free-plan allowance. Pages on a private repository also needs a paid plan. Keep the repository public | Arithmetic; plan allowances not verified |
| Pages | $0. Site about 1.3 MB per deploy (the local `dist/` is 1.26 MB without `state.json`; the state, 3.3 MB, is no longer in the artifact, but a local `npm run build` still copies it into `dist/`); limits per the 2026-11-19 ops review: 1 GB site, 100 GB/month soft bandwidth | review |
| Artifacts | `v2-state` kept 7 days per run; free on a public repository | `refresh.yml` |
| Claude brief (optional) | About $0.01 per build; $15-20 a month at 48 builds a day. **Estimate, never measured** | 1 request per build; roughly 14,000 characters of input (12.1 KB of story JSON measured on the 02:24Z edition plus a 1.8 KB system prompt, about 3,500-5,000 tokens) and about 300 output tokens; list price for `claude-sonnet-5` $2 / $10 per million input / output tokens (price table cached 2026-11-03 — confirm before budgeting). Set a workspace spend limit |
| Third parties | Each build requests about 413 sources with conditional GETs (185 answered 304 in the last local build) | build log |
| Mac launch agent | $0; needs the Mac awake | — |

---

## 14. Untested register

Everything below has never been exercised. Treat the first occurrence of each as a test.

| # | Item | First evidence to look for |
|---|---|---|
| 1 | All three workflows on GitHub (YAML accepted, pinned action SHAs resolve, Node 24 on Ubuntu) | First run of each; `ci.yml` on the first pull request |
| 2 | `npm ci --ignore-scripts`, typecheck and the 2,782 tests on a GitHub runner, Node 24 on Ubuntu (the workflow tests run `git` and `jq` in a temporary directory and skip themselves where either is missing) | "Unit tests" step |
| 3 | Preflight, guard (uses GNU `date -d`), state restore from `data` (primary) and from the live site (fallback), removal of `state.json` from the artifact | Step logs and run summary |
| 4 | The ingest client against the live registry from a GitHub runner IP (bot walls and rate limits differ from a home IP; 12 of the 414 registry sources carry the `probation` tag, which keeps their failures out of the gate's live-feed share) | Feed counts in `status.json`; gate fails below 60% of live feeds |
| 5 | `deploy-pages` with three attempts; the post-deploy poll | Deploy job log |
| 6 | `persist`: first creation of the `data` branch, then force-push of one orphan commit | §12 check 5 |
| 7 | `alert`: opening, comment throttles (180 minutes; daily for the brief issue - the `date -u -d` branch could not be executed locally), auto-close, behaviour on manual cancel vs job timeout; the `state_lost` report | First failing run |
| 8 | `feed-audit.yml` end to end, including the two rolling issues ("Dependency audit failing", "Feed audit:") and the bot-author lookup of the second | First Monday or manual dispatch |
| 9 | Dependabot configuration (`cooldown`, groups) | First Monday after the file is on a default branch |
| 10 | Every git command in §7-§9 and the rollback in §9.4 | — |
| 11 | Pages enablement by API (§8 step 6) | Use the Settings page if the call is rejected |
| 12 | Dispatching V2's workflow on branch `v2` of the V1 repository (§9.1) | — |
| 13 | The launchd commands and plist in §10 | Agent log files |
| 14 | The Claude brief against the real API (model id, request fields, reply validation, cost) | §11 step 4 |
| 15 | Custom domain (`SITE_BASE=/`) | — |
| 16 | Behaviour at the real cadence over 24 hours (TOP STORIES churn, state growth: estimate 8-9 MB, ceiling 24 MB) | Watch `state.json` size and `status.json` for a week |
| 17 | The 60-day rule: V2 never commits to `main`; whether force-pushes to `data` count as repository activity is not documented. Dispatch kicks are unaffected | A "scheduled workflow disabled" notice; fix with `gh workflow enable refresh.yml --repo <R>` |

---

## 15. Open issues that affect go-live

| Issue | Effect | Action |
|---|---|---|
| `public/feed.xml` is still tracked | Shows as modified after every local build | `git rm --cached public/feed.xml` in the first commit (§7) |
| Option C only: launch agent calls the workflow by its V1 name | Kicks fail after cutover | §10.2 |
| The state has ONE copy by default (branch `data`) | If the branch path fails on GitHub in a way local git could not show, every build starts from empty state (first-seen re-stamped, river memory lost) | Watch "State restored from: **data branch**" in the second run's summary; "V2 refresh failing" reports a lost state; `V2_PUBLISH_STATE=true` restores the second copy |
| Brief failures alert only after 6 consecutive failed builds, and only with a key | About 3 hours of fallback briefs before the issue "V2 Daily Brief failing" opens | Check `status.json` `.brief` after enabling the key |
| The fixture is one frozen day (2026-11-20) | A fresh clone with `data:fixture` shows that day's edition with the stale banner; three health rows are synthetic | `npm run fixture:refresh` after a keyless build freezes a newer one (CONTRACTS.md §12) |
| Nothing has run on Node 24 or Linux | A difference would first show as a failed "Unit tests" step, which holds every deploy | Open a draft pull request from `v2` so `ci.yml` runs before `V2_DEPLOY=true` (§9.1) |
| Unit tests gate every scheduled refresh | A test flake stops that slot's deploy and opens "V2 refresh failing". The one known flake (a wall-clock budget) was raised from 2 s to 15 s in the closing round | Owner decision whether scheduled runs should skip the tests ([HANDOFF.md](./HANDOFF.md) §2.1, decision 13) |
| Disclosure before the repository is public | The registry tag and notes that described the reader were removed; `docs/SOURCE_RESEARCH.md` still explains choices by the reader's local-model lab | Read [SECURITY.md](./SECURITY.md) §2.5 before the first push |
| Shared `pnelsonftp.github.io` origin | Reader state readable by any script on that origin | Custom domain (§6), or accept |

---

## 16. Custom domain (subdomain on an owned domain)

Written 2026-11-20 for moving V2 from `https://pnelsonftp.github.io/ai-drudge-v2/` to a subdomain,
written here as `<host>` (for example `news.example.com`, apex `example.com`). `[UNTESTED]` until
done once. Pages from a GitHub Actions workflow needs no `CNAME` file in the artifact; the domain
lives in the repository's Pages settings.

### 16.1 DNS records (at the domain's DNS provider)

| # | Type | Name | Value | Notes |
|---|---|---|---|---|
| 1 | `TXT` | `_github-pages-challenge-PNelsonFTP.<apex>` | the code GitHub shows in step 16.2-1 | Domain verification. Keep it permanently: it stops any other GitHub account from claiming the domain or its subdomains |
| 2 | `CNAME` | `<host>` (the subdomain label, e.g. `news`) | `pnelsonftp.github.io.` | The account's Pages host, **without** the repository name. TTL 3600 or lower. No `A`/`AAAA` records for this name |
| 3 | `CAA` (only if the apex already has CAA records) | `<apex>` | `0 issue "letsencrypt.org"` | GitHub's certificates come from Let's Encrypt; without this entry HTTPS cannot be issued |

If the DNS is served by Cloudflare or another proxying provider, set record 2 to **DNS only** (no
proxy), at least until the certificate is issued. Do not create a wildcard record pointing at
GitHub.

Check before going on:

```bash
dig +short CNAME <host>          # expect: pnelsonftp.github.io.
dig +short TXT _github-pages-challenge-PNelsonFTP.<apex>
```

### 16.2 GitHub steps (in this order, in one sitting)

| # | Action | Command or location |
|---|---|---|
| 1 | Verify the apex for the account | github.com > profile picture > Settings > Pages > **Add a domain** > `<apex>`; GitHub shows the TXT value for 16.1 record 1; after DNS answers, press **Verify** |
| 2 | Set the site variables | `gh variable set SITE_URL --body https://<host>/ --repo PNelsonFTP/ai-drudge-v2` and `gh variable set SITE_BASE --body / --repo PNelsonFTP/ai-drudge-v2` |
| 3 | Set the Pages custom domain | `gh api -X PUT repos/PNelsonFTP/ai-drudge-v2/pages -f cname=<host>` (or Settings > Pages > Custom domain) |
| 4 | Rebuild at once | `gh workflow run refresh.yml --repo PNelsonFTP/ai-drudge-v2 --ref main` |
| 5 | Enforce HTTPS once the certificate exists (minutes; up to about an hour) | `gh api repos/PNelsonFTP/ai-drudge-v2/pages --jq .https_certificate.state` shows `approved`, then `gh api -X PUT repos/PNelsonFTP/ai-drudge-v2/pages -F https_enforced=true` |

Between steps 3 and 4 completing (about 2 minutes) the custom host serves the previous build, whose
assets are under `/ai-drudge-v2/`, so the page is blank; the old `github.io` address already
redirects to `<host>`. Doing steps 2-4 back to back keeps that window short. The preflight's
`*.github.io` check does not apply to another host (§4.3).

### 16.3 Verify

| Check | Expected |
|---|---|
| `curl -sI https://pnelsonftp.github.io/ai-drudge-v2/` | `301` to `https://<host>/` |
| `curl -s https://<host>/data/v2/status.json` | `generatedAt` of the run from step 4 |
| `curl -s https://<host>/feed.xml \| grep -m1 'rel="self"'` | the self link names `https://<host>/feed.xml` |
| Browser at `https://<host>/` | page loads, assets from `/assets/`, no console errors; `localStorage` starts empty on the new origin (Settings > backup export/import carries reader state across) |

### 16.4 Undo

Clear the domain (Settings > Pages > Custom domain > Remove, or
`echo '{"cname":null}' | gh api -X PUT repos/PNelsonFTP/ai-drudge-v2/pages --input -`), delete the
two variables (`gh variable delete SITE_URL --repo PNelsonFTP/ai-drudge-v2`, same for `SITE_BASE`)
and dispatch `refresh.yml`. The DNS records can stay.
