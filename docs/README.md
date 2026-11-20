# AI DRUDGE V2 — Documentation index

Written 2026-11-20 (UTC) and checked against the tree after the closing round of the same day.
Every document in `docs/` and `docs/archive/`: what it is for, who it is
for, when to read it, whether a tool writes it, and the order to read them in.

**Answer first**

- **Taking over cold:** read [HANDOFF.md](./HANDOFF.md), then [CONTRACTS.md](./CONTRACTS.md). Those
  two tell you what state the project is in and where every type, stage and command lives.
- **The owner:** read [V1_VS_V2.md](./V1_VS_V2.md), then sections 1 and 2 of
  [HANDOFF.md](./HANDOFF.md) (state, and the decisions that block go-live).
- **Going live:** [DEPLOYMENT.md](./DEPLOYMENT.md), with [SECURITY.md](./SECURITY.md) section 9 as
  the hardening checklist.
- **Two files are written by tools and must never be edited by hand:** [SOURCES.md](./SOURCES.md)
  and [SBOM.json](./SBOM.json). [SBOM.md](./SBOM.md) is hand-written except for three marked tables.
- **Nothing under [archive/](./archive/README.md) describes this code.** It is the V1 audit trail.
- **Three files are large.** Search them; do not read them end to end: `SOURCE_RESEARCH.md`
  (537 KB), `SOURCES.md` (195 KB), `SBOM.json` (176 KB).
- **The documentation has known limits of its own.** They are listed in section 7.

## 1. State of the project on 2026-11-20

Enough to orient; the documents below carry the detail. "Checked" says how the row was verified
for this index.

| Item | State | Checked |
|---|---|---|
| V2 | Uncommitted working tree on branch `v2` (a git worktree). Not pushed, not deployed. No workflow has run on GitHub | `git status` for the working tree; the rest as recorded in [DEPLOYMENT.md](./DEPLOYMENT.md) section 1 |
| V1 | Live at https://pnelsonftp.github.io/ai-drudge/ from branch `main`. Not touched by the V2 work | reported by the final integration run; not re-checked for this index. History in [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) |
| Stack | Vite 8, React 19, TypeScript 6, Tailwind 4, `fast-xml-parser` 5 (build only). Node 24 in CI (`.node-version`); `engines` allows 22.15.0 and later | `package.json` |
| Architecture | Build pipeline (`scripts/pipeline/`: ingest, normalize, relevance, cluster, score, route, emit) writes JSON to `public/data/v2/`; a static single-page app in `src/` renders it. No server | [CONTRACTS.md](./CONTRACTS.md) sections 4 and 5 |
| Type check | `npx tsc -b` exit 0 | re-run after the closing round |
| Tests | 2,782 tests in 449 suites and 132 test files, 0 failing | `npm test`, re-run after the closing round |
| Registry | 414 sources (413 active, 1 paused), 405 publisher entries (317 own a source), 15 sections, 11 removed V1 sources, 10 denied outlets | read from `scripts/registry/` for this index |
| Last local data build | `2026-11-20T05:16:55.936Z` (the closing build): 412 of 413 sources OK and 1 carried forward, 322 stories in 367 rows, 12 top stories, gate passed with 0 warnings, keyless (no AI-written brief) | `public/data/v2/status.json`, `npm run build:check` |
| Committed test fixture | The same build, with three synthetic health rows | `test/fixtures/v2.manifest.json` |
| Dependencies | `docs/SBOM.json` is current (125 npm packages, 6 GitHub Actions, 7 services) | `npm run sbom -- --check`, re-run after the closing round |
| Site bundle | Entry JS 338.58 kB raw / 108.20 kB gzip; `front.json` 143.2 KB raw / 43.9 KB gzip | closing round's `npm run build` log; `npm run build:check` |
| Known defects | 58 rows, the same list in two places | [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md) ("Known defects"), [HANDOFF.md](./HANDOFF.md) section 7 |

## 2. Documents in `docs/`

Ordered by role: orientation, reference, operations, records. "Origin" says whether a person or a
tool writes the file, and how to regenerate it.

| File | Purpose | Audience | Read it when | Origin |
|---|---|---|---|---|
| [README.md](./README.md) | This index | Everyone | First, and whenever a document is added, moved or renamed | Hand-written |
| [HANDOFF.md](./HANDOFF.md) | Takeover brief: state in one screen, what to do first (open owner decisions), map of the codebase, daily operations, how-to recipes, invariants and traps, known defects, verification commands with expected results, glossary | New engineer, AI session; the owner for sections 1 and 2 | Before any other document when you inherit the project | Hand-written |
| [V1_VS_V2.md](./V1_VS_V2.md) | Comparison of the live V1 with the V2 rebuild: measured comparison, what a reader will notice, what was removed or changed on purpose, what is not better yet, how to compare for yourself | Owner, reviewers | Deciding whether and when to replace V1 | Hand-written; the overlap figures come from `npm run compare` |
| [DESIGN.md](./DESIGN.md) | How V2 is built and why: goals and non-goals, architecture, stack and layout, the pipeline stage by stage, data contract summary, client, CI/CD, performance budgets with measured values, testing strategy, failure modes, decisions and trade-offs, where to change what (section 13) | Engineers, AI sessions | Before changing pipeline or client behaviour; when a ranking result needs explaining | Hand-written |
| [CONTRACTS.md](./CONTRACTS.md) | Map of the shared types, stage functions, service interfaces, fixtures and commands: which file, which names, who provides, who consumes. The TypeScript files are the source of truth | Engineers, AI sessions | Before editing any file under `shared/`, `scripts/` or `src/`; to find a command (section 8); before refreshing the fixture (section 12) | Hand-written. Change it in the same commit as the contract it describes |
| [SOURCES.md](./SOURCES.md) | Every registry source by home section: id, publisher, kind, tier, scope, status in the last build, links, tags, note; the removed list; how to add a source | Editors, operators | Checking whether an outlet is covered, or what a source did in the last build | **Generated.** `npm run docs:sources` (reads `scripts/registry/` and `public/data/v2/health.json`; no network). Never edit by hand |
| [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) | Research record behind the registry: V1 triage, acceptance criteria, 274 validated feeds held in reserve, rejected feeds, no-feed sites, dead ends, coverage gaps, how to validate and add a source | Whoever maintains the registry | Before researching or adding any source: search the file for the host name first | Mixed, frozen. Tables were generated once on 2026-11-20 from research records that are not in the repository; it cannot be regenerated. Edit by hand |
| [SBOM.md](./SBOM.md) | Human-readable bill of materials: format and regeneration, summary counts, direct and notable transitive packages, licences, GitHub Actions, build and runtime tools, external services and data flows, fonts and static assets, vulnerability status, supply-chain controls, upgrade history from V1, what is not covered | Security, compliance | Dependency, licence or vendor review; after a dependency or workflow change | Mixed. Prose is hand-written; the tables between the three `<!-- SBOM-...:START -->` / `<!-- SBOM-...:END -->` marker pairs are rewritten by `npm run sbom` |
| [SBOM.json](./SBOM.json) | CycloneDX 1.6 bill of materials: npm packages with purl, licence and hash, pinned GitHub Actions, Node.js, external services, dependency graph | Automation, auditors | Feeding a scanner or an audit request | **Generated.** `npm run sbom` (lockfile, installed packages, `.node-version`, workflows; no network). Check with `npm run sbom -- --check`. Never edit by hand |
| [RUNBOOK.md](./RUNBOOK.md) | Operating procedures for after go-live: orientation and the first five minutes, 13 symptom procedures (stale banner, gate failure, failing source, misplaced story, duplicate top stories, missing brief or ticker, cron not firing, deploy failure, Dependabot, key rotation, state loss, rollback), routine tasks (weekly feed audit, monthly link check, dependency updates, SBOM regeneration, fixture refresh), rolling issues, the numbers that drive behaviour | Operator | Something failed, an alert issue opened, or a routine task is due | Hand-written |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Go-live guide: configuration reference, local preview, how the workflows deploy, pre-flight checklist, the three go-live options, post-deploy verification, cost, the register of untested steps | Whoever ships V2 | Before the first commit and push; before changing a workflow or a deployment variable | Hand-written |
| [SECURITY.md](./SECURITY.md) | Security posture: trust boundaries, data inventory, threat model, findings SEC-1 to SEC-9, CI privileges, supply chain, auditability, hardening checklist, what is not verified | Owner, security reviewers | Before go-live; before changing workflows, the content security policy, storage or the brief | Hand-written |
| [CHANGELOG.md](./CHANGELOG.md) | What changed between versions, in Keep a Changelog form: 2.0.0 (unreleased) against 1.x | Everyone | To learn what V2 added, changed, removed or fixed | Hand-written |
| [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) | Chronology and reasons: the origin, the V1 timeline, why V2, how it was built, decisions and rejected alternatives | Everyone | Before reversing a decision; to learn why something is the way it is | Hand-written |
| [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) | Review record: the 17-dimension review of V1, the review-fix round on V2, the final round (fixers, integrators, the 25-finding audit, the closer); what was found, fixed and left open | Engineers, auditors | Tracing a finding id (for example `SEC-8` or `RE-10`); checking whether a defect was already examined | Hand-written, dated record. Do not rewrite after the fact; a newer review gets its own file |
| [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md) | Roadmap for the next working session: 31 improvements in five groups (A do next, B product, C pipeline quality, D operations and security, E sources), the register of 58 known defects (same ids as [HANDOFF.md](./HANDOFF.md) section 7), and the ideas considered and not recommended | Owner, engineers | Planning the next piece of work; checking whether a defect is already known | Hand-written |

Documentation that lives outside `docs/`:

| Where | What |
|---|---|
| [../README.md](../README.md) | Project front page: at-a-glance numbers, quick start, npm scripts, how it works, project layout, configuration, the 15 sections, adding a source, routes and keyboard shortcuts, status |
| `.github/workflows/refresh.yml`, `feed-audit.yml`, `ci.yml` | Each file's header comment states what the workflow does and what guards it |
| `scripts/registry/sources/*.ts`, `scripts/registry/sources/removed.ts` | Per-source notes, and the reason each removed V1 source was removed |
| `shared/contract.ts`, `scripts/pipeline/types.ts`, `src/app/services.ts` | The commented type definitions that [CONTRACTS.md](./CONTRACTS.md) maps |
| `test/fixtures/v2.manifest.json` | Provenance of the committed fixture: build id, hash and size per file, synthetic rows. Written by `npm run fixture:refresh` |

## 3. Historical records in `docs/archive/`

V1 only. Moved here on 2026-11-20 and kept unchanged as an audit trail. All are hand-written;
none can or should be regenerated. Paths, counts and feed URLs inside them describe V1 on the date
in the file name, and some URLs are dead on purpose.

| File | Purpose | Audience | Read it when | Origin |
|---|---|---|---|---|
| [archive/README.md](./archive/README.md) | Index of the archive, what replaced each file, and the rules for the directory | Everyone | Before opening or adding anything in `archive/` | Hand-written |
| [archive/UPGRADE_PLAN.md](./archive/UPGRADE_PLAN.md) | Plan of 2026-06-22 for the V1 freshness, importance and sources cycle (executed by 2026-07-06) | Auditors | Tracing the origin of a V1 behaviour | Hand-written record |
| [archive/REVIEW_SUMMARY_2026-09-21.md](./archive/REVIEW_SUMMARY_2026-09-21.md) | Index of the three September 2026 review files and what was applied from them | Auditors | Entry point to the September 2026 review | Hand-written record |
| [archive/REVIEW_2026-09-21.md](./archive/REVIEW_2026-09-21.md) | Editorial review of one V1 payload: homepage quality and ranking bugs | Engineers, auditors | Comparing a V2 ranking defect with its V1 ancestor | Hand-written record |
| [archive/FEED_AUDIT_2026-09-21.md](./archive/FEED_AUDIT_2026-09-21.md) | Probe of every V1 feed and scraper (187 sources) with keep or remove suggestions | Registry maintainers, auditors | Checking what was known about a feed in September 2026 | Hand-written record |
| [archive/FEED_CANDIDATES_2026-09-21.md](./archive/FEED_CANDIDATES_2026-09-21.md) | About 220 candidate feeds probed for V1; the best 20 were added | Registry maintainers, auditors | Only after [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md), which is newer and wider | Hand-written record |

## 4. Reading order

### 4.1 The owner

Goal: decide whether to ship, and what to decide first.

1. [V1_VS_V2.md](./V1_VS_V2.md): written for the owner. What V2 does better, what is not better
   yet, and how to compare the two for yourself.
2. [HANDOFF.md](./HANDOFF.md) section 1 (state in one screen) and section 2 (what to do first:
   the open owner decisions, of which the first four block go-live).
3. [SECURITY.md](./SECURITY.md): the "Answer first" block (ranked open risks), then section 9
   (hardening checklist for go-live) and section 10 (not verified).
4. [DEPLOYMENT.md](./DEPLOYMENT.md): the "Answer first" block, section 6 (go-live options),
   section 13 (cost), section 14 (untested register).
5. [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md): "The answer first", then section 0.3 (all
   improvements at a glance) and group A (do next).
6. Optional: [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) section 0 for the audit summary;
   [SBOM.md](./SBOM.md) sections 5 (licences), 10 (vulnerability status) and 11 (supply-chain
   controls) for a dependency or vendor review.

### 4.2 A new engineer

Goal: run it, understand it, change it safely.

1. [../README.md](../README.md): install, run locally, npm scripts.
2. [HANDOFF.md](./HANDOFF.md): all of it. Section 6 (invariants and traps) and section 8
   (verification commands and expected results) are the parts to keep open while working.
3. [DESIGN.md](./DESIGN.md): sections 1 to 3 for the shape, section 4 for the pipeline, section 6
   for the client, section 13 for where to change what.
4. [CONTRACTS.md](./CONTRACTS.md): sections 1 to 8 for the map, section 12 before touching fixtures.
5. [RUNBOOK.md](./RUNBOOK.md): section 1 (orientation), then section 2 by symptom.
6. [DEPLOYMENT.md](./DEPLOYMENT.md) and [SECURITY.md](./SECURITY.md): before any work on
   workflows, variables, secrets or the content security policy.
7. [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md): group A and "Known defects", before
   choosing what to work on.
8. [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) section 8 (decisions) and
   [CHANGELOG.md](./CHANGELOG.md): before reversing a decision.
9. As needed: [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) to trace a finding;
   [SOURCES.md](./SOURCES.md) and [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) for registry work.

### 4.3 An AI coding session

Goal: the smallest context that makes a change correct. Most documents here are 25 to 105 KB, so
read by section (`wc -c docs/*.md` prints the sizes).

1. [HANDOFF.md](./HANDOFF.md): section 1 (state), section 3 (map of the codebase), section 6
   (invariants and traps), section 8 (verification commands). Section 7 when the task is a known
   defect.
2. [CONTRACTS.md](./CONTRACTS.md): section 1 (contract files), section 8 (commands), then the
   section for the area being changed (4 pipeline, 5 client, 7 and 12 fixtures).
3. [DESIGN.md](./DESIGN.md): section 13 (where to change what), then only the part of section 4
   or 6 that covers the stage or feature being changed.
4. The commented source files those sections name. They are the source of truth, not the documents.
5. [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md) or
   [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md): only to find the item or the finding in question.
6. [RUNBOOK.md](./RUNBOOK.md) section 2: when the task starts from a symptom (a failed gate, a
   failing source, a story in the wrong place).

Working rules for a session:

| Rule | Detail |
|---|---|
| Do not load the large files | Search `SOURCE_RESEARCH.md` and `SOURCES.md` by host name or source id. Query `SBOM.json`; do not read it |
| Skip `archive/` | It describes code that is not in this tree |
| Gate for every change | `npx tsc -b` and `npm test`, both offline |
| Network commands need a reason | `npm run build:data`, `npm run validate:feeds` and `npm run check:links` contact several hundred third-party hosts. `npm run data:fixture` gives a working data set offline |
| Never hand-edit tool output | `docs/SOURCES.md`, `docs/SBOM.json`, the marked tables of `docs/SBOM.md`, `test/fixtures/v2/*` and its manifest, `public/data/v2/*` |
| Tests never pin fixture content | Select fixture rows by property ([CONTRACTS.md](./CONTRACTS.md) section 12) |
| Explain before tuning | `npm run explain -- <id, url or words>` says why a story is where it is in the last build |

## 5. Conventions

### 5.1 Dates and times

| Rule | Detail |
|---|---|
| Absolute dates | `2026-11-20`, never "today", "yesterday" or "last week". A document's header states the date it was written or last verified |
| V2 times are UTC | ISO 8601 (`2026-11-20T04:16:25.732Z`) or `HH:MMZ`. The V2 work of 2026-11-20 UTC is the evening of 2026-11-19 in US Central |
| V1 dates | Git author dates in US Central, as [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) states |
| Dated records | Named `<TOPIC>_<YYYY-MM-DD>.md`. A record is not rewritten after its date; a newer record replaces it and the old one moves to `archive/` with a banner |

### 5.2 Generated files

| File | Written by | Inputs | Rule |
|---|---|---|---|
| `docs/SOURCES.md` | `npm run docs:sources` (`scripts/tools/gen-sources-doc.ts`) | `scripts/registry/`, plus status from `public/data/v2/health.json`, or from a `validate:feeds` verdict file with `-- --report <file>` | Change the registry and regenerate. Deterministic: the same inputs give the same bytes |
| `docs/SBOM.json` | `npm run sbom` (`scripts/generate-sbom.ts`) | `package-lock.json`, installed packages' `package.json`, `.node-version`, `.github/workflows/*.yml` | Regenerate after any dependency or workflow change. `-- --check` exits 1 when stale; `feed-audit.yml` runs that check as a warning |
| `docs/SBOM.md`, marked tables only | `npm run sbom` | Same | Edit prose freely; never edit between a `START` and `END` marker |
| `test/fixtures/v2/*.json`, `test/fixtures/v2.manifest.json` | `npm run fixture:refresh` | The last keyless build in `public/data/v2/` | Procedure and refusals in [CONTRACTS.md](./CONTRACTS.md) section 12 |
| `public/data/v2/*`, `public/feed.xml`, `public/feeds.opml` | `npm run build:data` (network; all of them) or `npm run data:fixture` (offline; the 8 fixture files only) | Registry sources, or the fixture | Listed in `.gitignore`; never committed. `public/feed.xml` is still tracked from V1 until the cutover commit removes it ([DEPLOYMENT.md](./DEPLOYMENT.md) section 7) |

Everything else in `docs/` is hand-written. `SOURCE_RESEARCH.md` carries generated tables, but its
generator and inputs were session files kept outside the repository; treat it as hand-maintained.

### 5.3 Measured numbers

A number in a document is a measurement with a date, or it is marked "not verified". Numbers move
with the news and with every change, so each has one place to re-measure it:

| Number | Source of truth | Re-measure with | Network |
|---|---|---|---|
| Tests, suites, failures | Test runner summary | `npm test` | No |
| Type check | Compiler exit code | `npx tsc -b` | No |
| Sources, active, paused, tiers, kinds, sections | `scripts/registry/` | `npx tsx scripts/tools/import-sources.ts` (writes nothing), or the first lines of [SOURCES.md](./SOURCES.md) | No |
| Sources OK, stories, top stories, median age, gate verdict of the last build | `public/data/v2/status.json` | `npm run build:check` | No |
| Data file sizes, raw and gzip | Gate output | `npm run build:check` | No |
| A fresh build's stage timings and counts | Build log on stdout | `npm run build:data` | Yes |
| Bundle sizes | Vite output | `npm run build` | No |
| Per-source feed health | Audit verdicts | `npm run validate:feeds` | Yes |
| Link status | `node_modules/.tmp/link-report.json` and `.md` | `npm run check:links` (add `-- --data` for article links) | Yes |
| Dependency counts, licences, hashes | [SBOM.json](./SBOM.json) | `npm run sbom -- --check` | No |
| Known vulnerabilities | npm registry | `npm audit` | Yes |
| V1 and V2 overlap | Comparison report on stdout | `npm run compare` (default: the frozen V1 payload of 2026-11-19 in `test/fixtures/v1/`) | No, unless `-- --v1 <URL>` is given |
| Why one story ranks where it does | Explain record of the last build | `npm run explain -- <id, url or words>` | No |
| What the committed fixture contains | `test/fixtures/v2.manifest.json` (build id, hash and size per file, synthetic rows) | Read the manifest; `npm test` fails when a fixture file does not match it | No |

Rules:

1. Quote a number with its date and, for a build, the build id (`generatedAt`).
2. The build logs, review files and work-package reports of 2026-11-19 and 2026-11-20 were kept in
   a session scratch directory outside the repository. It is not durable. The documents that quote
   them ([REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md), [PROJECT_HISTORY.md](./PROJECT_HISTORY.md),
   [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md)) are the only durable copy.
3. All measurements so far come from one workstation (Node 26.7.0, macOS). Nothing was measured on a
   GitHub runner (Node 24, Linux).
4. "Publishers" has two meanings: 405 entries in the registry's publisher list, of which 317 own
   at least one source. [SOURCES.md](./SOURCES.md) prints the second, [CONTRACTS.md](./CONTRACTS.md)
   the first.

### 5.4 Status words

| Word or tag | Meaning |
|---|---|
| "not verified" | Nobody checked it, or it could not be checked under the rules of that step. Used in every document |
| `[LOCAL]`, `[REMOTE-READ]`, `[UNTESTED]` | Tags of [DEPLOYMENT.md](./DEPLOYMENT.md): exercised on the workstation, read from GitHub read-only, never exercised |
| "Unreleased" | [CHANGELOG.md](./CHANGELOG.md): the 2.0.0 working tree, not committed or deployed |

### 5.5 Style, links and privacy

| Rule | Detail |
|---|---|
| Reader | A competent engineer or an AI agent arriving cold. Lead with the answer; tables and numbered steps; no marketing language, no emoji |
| Relative links | Between documents, always relative (`./CONTRACTS.md`, `../README.md`, `./archive/README.md`) |
| External URLs | `npm run check:links` requests every `http(s)` URL in `README.md` and `docs/*.md`, including those inside code spans. Write a dead feed or a not-yet-deployed address without its scheme (for example `/ai-drudge-v2/`) so it is not reported as broken |
| `archive/` URLs | Checked and listed as their own group, never counted as broken, never a reason to edit a record |
| Relative links are not checked by any tool | After moving or renaming a document, run the command below from the repository root. No output means no broken relative link |
| Privacy | No name, employer or e-mail address of the owner in any file; write "the owner". The public GitHub handle inside repository URLs is acceptable |

```bash
for f in README.md docs/*.md docs/archive/*.md; do
  grep -oE '\]\([^)<> ]+\)' "$f" | sed -E 's/^\]\(//; s/\)$//; s/#.*$//' |
    grep -vE '^(https?:|mailto:|$)' | sort -u |
    while read -r l; do [ -e "$(dirname "$f")/$l" ] || echo "BROKEN $f -> $l"; done
done
```

## 6. What to update when

| You changed | Update |
|---|---|
| A source or publisher in `scripts/registry/` | Run `npm run docs:sources` (after a build, so the status columns are current). Correct the registry count in [CONTRACTS.md](./CONTRACTS.md) section 4.1 |
| `package.json`, `package-lock.json`, `.node-version` or a workflow's `uses:` line | Run `npm run sbom`; review the hand-written parts of [SBOM.md](./SBOM.md) |
| A shared type, stage signature or service interface | [CONTRACTS.md](./CONTRACTS.md), in the same commit |
| A script in `package.json` | [CONTRACTS.md](./CONTRACTS.md) section 8 and the root [README.md](../README.md) |
| A workflow, repository variable, secret or deploy step | [DEPLOYMENT.md](./DEPLOYMENT.md) section 2; [SECURITY.md](./SECURITY.md) section 5; [DESIGN.md](./DESIGN.md) section 7; [RUNBOOK.md](./RUNBOOK.md) if an alert or a procedure changes |
| The committed fixture | Nothing by hand: the manifest is rewritten by the tool. Correct the build date quoted in [CONTRACTS.md](./CONTRACTS.md) sections 7 and 12 |
| Reader-visible behaviour, or a release | [CHANGELOG.md](./CHANGELOG.md) |
| A design decision, threshold or budget | [DESIGN.md](./DESIGN.md) (sections 8 and 11 for budgets and trade-offs); the reason and the rejected alternative go in [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) section 8 |
| A defect found or closed | [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md), "Known defects"; [HANDOFF.md](./HANDOFF.md) section 7 |
| A new review | New file `REVIEW_<YYYY-MM-DD>.md`; move the superseded one to `archive/` with a banner and a row in [archive/README.md](./archive/README.md) |
| Any document added, moved or renamed | This index, the documentation table of the root [README.md](../README.md), [HANDOFF.md](./HANDOFF.md) section 10, then the relative-link command in section 5.5 |

## 7. Known limits of the documentation on 2026-11-20

Checked on 2026-11-20 at the end of the documentation pass, after the last code change.

| Limit | Where | What to rely on |
|---|---|---|
| Dated records keep the figures of their own round on purpose: 413 sources (412 active), 394 publishers, 2,415 tests, entry JS 109.61 kB at the end of the fix round | [REVIEW_2026-11-20.md](./REVIEW_2026-11-20.md) Part 2 and section 0; [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) sections 6.6, 8.5 and 9; the registry counts inside the research record [SOURCE_RESEARCH.md](./SOURCE_RESEARCH.md) | Section 1 of this index for the current values: 414 sources (413 active), 405 publisher entries, 2,782 tests, build `2026-11-20T05:16:55.936Z`. Each of those documents states the final values where it describes the final round |
| Editorial examples (ranks, publisher counts, ages) describe one build | [HANDOFF.md](./HANDOFF.md) section 7, [FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md), [DESIGN.md](./DESIGN.md), [V1_VS_V2.md](./V1_VS_V2.md) | Each names the build it describes (04:16Z or the closing build of 05:16Z). `npm run explain` and `npm run build:check` give today's values |
| `SOURCE_RESEARCH.md` cannot be regenerated | Its tables came from research records and a script kept outside the repository | Maintain it by hand; re-derive registry numbers with `npx tsx scripts/tools/import-sources.ts` |
| `SOURCE_RESEARCH.md` explains some choices by the reader's local-model lab | The research record; a disclosure decision for the owner before the repository is public | [SECURITY.md](./SECURITY.md) section 2.5; [HANDOFF.md](./HANDOFF.md) section 2.1, decision 10 |
| No tool checks relative links or anchors | `npm run check:links` reads external URLs only | The command in section 5.5 (relative links: none broken on 2026-11-20). Anchors were checked on the same day by a script that approximates GitHub's slug rule (0 broken); they are **not verified** in a GitHub render |
| No document has been viewed in a GitHub render | All of `docs/` | **Not verified:** table layout, anchor ids, and whether GitHub displays the 537 KB `SOURCE_RESEARCH.md` in its file view |
| `SBOM.json` is not validated against the official CycloneDX 1.6 schema | Stated in [SBOM.md](./SBOM.md) section 13 | The generator's tests pin the serial-number pattern, unique references, and that no dependency reference dangles |
