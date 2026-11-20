# AI DRUDGE V2 — Software Bill of Materials

Human-readable summary of what the project is built from, what it runs on and what it talks to.
The machine-readable document is [SBOM.json](./SBOM.json).

**In one paragraph.** Three npm packages reach the reader's browser (`react`, `react-dom`,
`scheduler`, all MIT). The other 122 are build or pipeline tooling that runs in CI only; 78 of
those are platform-specific binaries, most of which are never installed on a given machine. There
are 12 direct dependencies, the same 12 as V1. `npm audit` reports 0 vulnerabilities on
2026-11-20. One licence in the tree is not permissive: MPL-2.0, on the build-time CSS compiler
`lightningcss`. No fonts or third-party scripts are bundled, and the only image is the project's
own favicon. The deployed site makes same-origin requests only.

_Last regenerated: 2026-11-20_

## Contents

1. [Format and how to regenerate](#1-format-and-how-to-regenerate)
2. [Summary counts](#2-summary-counts)
3. [Direct dependencies](#3-direct-dependencies)
4. [Notable transitive packages](#4-notable-transitive-packages)
5. [Licences](#5-licences)
6. [GitHub Actions](#6-github-actions)
7. [Build and runtime tools](#7-build-and-runtime-tools)
8. [External services and data flows](#8-external-services-and-data-flows)
9. [Fonts and static assets](#9-fonts-and-static-assets)
10. [Vulnerability status](#10-vulnerability-status)
11. [Supply-chain controls](#11-supply-chain-controls)
12. [Upgrade history, V1 to V2](#12-upgrade-history-v1-to-v2)
13. [Not covered and not verified](#13-not-covered-and-not-verified)

Related: [SECURITY.md](./SECURITY.md) (threat model, token permissions, incident steps),
[DEPLOYMENT.md](./DEPLOYMENT.md) (workflows, variables, secrets), [SOURCES.md](./SOURCES.md)
(every registry source with its URL), [CONTRACTS.md](./CONTRACTS.md) (commands, data contract),
[CHANGELOG.md](./CHANGELOG.md).

## 1. Format and how to regenerate

| Item | Value |
|---|---|
| Format | CycloneDX JSON, `specVersion` 1.6, `$schema` `cyclonedx.org/schema/bom-1.6.schema.json` |
| File | [SBOM.json](./SBOM.json) (6,451 lines) |
| Generator | `scripts/generate-sbom.ts`, tool version 2.0. No dependency of its own, no network, no clock in the content |
| Inputs | `package-lock.json` (name, version, integrity, dev / optional flags, graph); each installed `node_modules/<pkg>/package.json` (licence; the lockfile's copy is the fallback for packages not installed on this OS); `.github/workflows/*.yml` (actions); `.node-version`; endpoint constants imported from the pipeline code (services) |
| Lifecycle phase | `pre-build` (it describes the lockfile, not a built artifact) |
| Root component | `ai-drudge-v2@2.0.0` |
| Serial number on 2026-11-20 | `urn:uuid:9b63dc0d-1240-515c-a1ef-b6b163109dd2` (a hash of the content; it changes when any input changes) |
| `metadata.timestamp` on 2026-11-20 | `2026-11-20T03:36:59Z` (kept while the content is unchanged, so it reads "when the bill of materials last changed") |

Commands (all verified on 2026-11-20):

```bash
npm run sbom                         # rewrite docs/SBOM.json and the three generated tables in this file
npm run sbom -- --check              # exit 1 when docs/SBOM.json is not what the tool would write
npm run sbom -- --out <file> --no-md # write elsewhere and leave this file alone
npm run sbom -- --timestamp <iso>    # fix metadata.timestamp (SOURCE_DATE_EPOCH is also honoured)
```

Rules for editing this file:

1. Three tables are generated, each between an `<!-- SBOM-…:START -->` and an
   `<!-- SBOM-…:END -->` comment (names `TABLE`, `ACTIONS`, `SERVICES`). `npm run sbom` replaces
   their bodies and the date in the `_Last regenerated_` line. Do not edit them by hand.
2. Everything else is hand-written and was checked against the repository on 2026-11-20. After a
   dependency change, run the verification below and correct the figures in sections 2, 4, 5
   and 12.
3. Do not write a marker comment anywhere else in this file. The generator replaces from the
   first occurrence it finds.
4. Regenerating without a content change rewrites identical bytes.

Verify after regenerating:

```bash
npm run sbom -- --check          # expect: SBOM is current: docs/SBOM.json (125 npm packages, 6 GitHub Actions, 7 services).
npx tsx --tsconfig tsconfig.app.json --test scripts/generate-sbom.test.ts   # expect: 25 pass
npm ls --depth=0                 # the 12 direct dependencies with resolved versions
node -e '
const b=require("./docs/SBOM.json");const n=f=>b.components.filter(f).length;
console.log({spec:b.specVersion,components:b.components.length,npm:n(c=>c.type==="library"),
required:n(c=>c.scope==="required"),excluded:n(c=>c.type==="library"&&c.scope==="excluded"),
optional:n(c=>c.scope==="optional"),actions:n(c=>c.type==="application"),
services:b.services.length,graph:b.dependencies.length,hashed:n(c=>c.hashes)});'
```

Expected output of the last command on 2026-11-20: `spec 1.6, components 132, npm 125,
required 3, excluded 44, optional 78, actions 6, services 7, graph 126, hashed 119`.

What the fields mean in SBOM.json:

| Field | Values | Meaning |
|---|---|---|
| `scope` | `required` | Shipped to the browser |
| | `excluded` | Build or pipeline only; documented, not reachable at run time of the site |
| | `optional` | Platform-specific binary, installed only on a matching OS / CPU |
| property `ai-drudge:usage` | `browser-runtime` | In the JavaScript bundle |
| | `data-pipeline` | Loaded by the process that fetches and parses untrusted feeds (`fast-xml-parser`, `tsx` and everything they depend on). Read advisories for these first |
| | `build-tooling` | Compiler, bundler, CSS toolchain, typings |
| | `ci-action`, `ci-runtime` | A GitHub Action; Node.js |
| property `ai-drudge:npm:has-install-script` | `true` | The package declares an install script (see section 11) |
| property `ai-drudge:action:declared-tag` | e.g. `v7.0.1` | The tag the workflow comment claims for the pinned commit. Not verified by the tool |
| licence `acknowledgement` | `declared` | Taken from the package's own `package.json`. No licence text was read |

A test (`scripts/generate-sbom.test.ts`) fails when a file under `scripts/` imports an npm package
that is not on the generator's `PIPELINE_PACKAGES` list, so the `data-pipeline` label cannot fall
behind the code.

## 2. Summary counts

Measured from `docs/SBOM.json` and `package-lock.json` (lockfile version 3) on 2026-11-20.

| Group | Count | Notes |
|---|---|---|
| Components in SBOM.json | 132 | 125 npm packages + 6 GitHub Actions + Node.js |
| npm packages (lockfile entries) | 125 | 119 distinct names; 6 names appear at two versions (WebAssembly shims, see section 4) |
| Direct, runtime (`dependencies`) | 2 | `react`, `react-dom` |
| Direct, development (`devDependencies`) | 10 | See section 3 |
| Transitive | 113 | 1 runtime (`scheduler`), 34 build / pipeline, 78 optional platform packages |
| Scope `required` (browser) | 3 | `react`, `react-dom`, `scheduler` |
| Scope `excluded` (build / pipeline) | 44 | 10 direct + 34 transitive |
| Scope `optional` (platform binaries) | 78 | 65 carry an `os` or `cpu` restriction in the lockfile |
| Usage `browser-runtime` / `data-pipeline` / `build-tooling` | 3 / 37 / 85 | |
| Installed on the verification machine | 59 of 125 | macOS arm64. The other 66 are binaries for other platforms |
| Services | 7 | Section 8 |
| Dependency-graph entries | 126 | Root + one per npm package. Edges include peer dependencies |

Not verified: the set installed on the CI runner (Ubuntu, x64). It should be the same 47
non-optional packages plus the Linux x64 binaries; no workflow has run on GitHub yet.

## 3. Direct dependencies

Resolved versions, licences and usage labels (generated):

<!-- SBOM-TABLE:START -->
| Package | Resolved | License | Scope | Usage |
|---------|----------|---------|-------|-------|
| `@tailwindcss/vite` | 4.3.5 | MIT | dev/build | build-tooling |
| `@types/node` | 24.19.2 | MIT | dev/build | build-tooling |
| `@types/react` | 19.3.0 | MIT | dev/build | build-tooling |
| `@types/react-dom` | 19.3.0 | MIT | dev/build | build-tooling |
| `@vitejs/plugin-react` | 6.3.0 | MIT | dev/build | build-tooling |
| `fast-xml-parser` | 5.12.1 | MIT | dev/build | data-pipeline |
| `react` | 19.3.1 | MIT | runtime | browser-runtime |
| `react-dom` | 19.3.1 | MIT | runtime | browser-runtime |
| `tailwindcss` | 4.3.5 | MIT | dev/build | build-tooling |
| `tsx` | 4.23.15 | MIT | dev/build | data-pipeline |
| `typescript` | 6.0.3 | Apache-2.0 | dev/build | build-tooling |
| `vite` | 8.3.8 | MIT | dev/build | build-tooling |
<!-- SBOM-TABLE:END -->

What each one does here (hand-written; ranges from `package.json`):

| Package | Declared range | Purpose in this project | Where it is used |
|---|---|---|---|
| `react` | `^19.3.1` | UI library of the single-page site | `src/**` (37 non-test files import it) |
| `react-dom` | `^19.3.1` | Browser renderer (`react-dom/client` in `src/main.tsx`). `react-dom/server` renders pages to strings in tests only | `src/main.tsx`; 9 test files and one test helper |
| `vite` | `^8.3.8` | Dev server (`npm run dev`) and production bundler (`npm run build` writes `dist/`). `vite.config.ts` also injects the theme script and the Content-Security-Policy `<meta>` | `vite.config.ts` |
| `@vitejs/plugin-react` | `^6.3.0` | JSX transform and Fast Refresh in the dev server | `vite.config.ts` |
| `tailwindcss` | `^4.3.5` | CSS framework compiled at build time. Entry: `@import "tailwindcss" source(none)` in `src/styles/index.css` | Build only |
| `@tailwindcss/vite` | `^4.3.5` | Vite plugin that runs Tailwind (its native scanner `@tailwindcss/oxide` and `lightningcss`) | `vite.config.ts` |
| `typescript` | `~6.0.3` | Type checking only: `tsc -b` over four project files (`tsconfig.shared.json`, `.app`, `.node`, `.test`), all `noEmit`. Patch-range pin; TypeScript 7 is held back in Dependabot | `npm run typecheck`, `npm run build` |
| `tsx` | `^4.23.15` | Runs every TypeScript script without a compile step (pipeline, tools, this generator) and the test suite (`tsx --test`, on Node's built-in `node:test`). Uses `esbuild` to transpile | All `npm run` scripts except `dev`, `build`, `preview`, `typecheck` |
| `fast-xml-parser` | `^5.12.1` | Parses untrusted RSS / Atom XML during ingest (`XMLParser`); validates the generated `feed.xml` in the gate and in a test (`XMLValidator`). `XMLBuilder` is not used | `scripts/pipeline/ingest/feedParser.ts`, `scripts/tools/check-data.ts`, `scripts/pipeline/emit/atom.test.ts` |
| `@types/node` | `^24.19.2` | Node typings for the scripts. Kept on major 24 to match the CI runtime; majors are held in Dependabot | Type checking |
| `@types/react` | `^19.3.0` | React typings | Type checking |
| `@types/react-dom` | `^19.3.0` | ReactDOM typings | Type checking |

There is no test framework, HTML parser, HTTP client, date library, state library, router, icon
set or model SDK in the tree. Tests run on `node:test`; the Claude request is a raw `fetch`;
listing pages are parsed by the project's own code.

## 4. Notable transitive packages

Versions from `package-lock.json`. "Parents" are real dependencies unless marked peer.

### Bundler, compilers and parsers

| Package | Version | Licence | Role | Brought in by |
|---|---|---|---|---|
| `scheduler` | 0.28.0 | MIT | React's task scheduler. The only transitive package in the browser bundle | `react-dom` |
| `rolldown` | 1.2.19 | MIT | The bundler inside Vite 8 (Rust). Replaces Rollup, which V1 used | `vite` |
| `@oxc-project/types` | 0.156.0 | MIT | Types for the Oxc parser used by Rolldown | `rolldown` |
| `@rolldown/pluginutils` | 1.1.1 | MIT | Plugin helpers | `rolldown`, `@vitejs/plugin-react` |
| `esbuild` | 0.28.1 | MIT | Transpiles TypeScript for `tsx`, so it runs in the data pipeline process. Vite 8 lists it only as an optional peer. Declares an install script | `tsx` |
| `lightningcss` | 1.33.0 | **MPL-2.0** | CSS parser, transformer and minifier (Rust) | `vite`, `@tailwindcss/node` |
| `postcss` | 8.5.33 | MIT | CSS processing inside Vite | `vite` |
| `@tailwindcss/node` | 4.3.5 | MIT | Tailwind's Node integration | `@tailwindcss/vite` |
| `@tailwindcss/oxide` | 4.3.5 | MIT | Tailwind's native class scanner (Rust) | `@tailwindcss/vite` |
| `jiti` | 2.7.0 | MIT | Runtime TypeScript / ESM loader used by Tailwind | `@tailwindcss/node` |
| `enhanced-resolve` | 5.27.0 | MIT | Module resolution for Tailwind's CSS imports | `@tailwindcss/node` |
| `graceful-fs` | 4.2.12 | BlueOak-1.0.0 | File-system wrapper | `enhanced-resolve` |
| `magic-string` | 1.4.5 | MIT | Source-map-aware string edits | `@tailwindcss/node` |
| `source-map-js` | 1.2.4 | BSD-3-Clause | Source maps | `postcss`, `@tailwindcss/node` |
| `tinyglobby`, `fdir`, `picomatch` | 0.2.17, 6.5.0, 4.0.7 | MIT | File globbing | `vite` |
| `detect-libc` | 2.1.2 | Apache-2.0 | Picks the glibc or musl binary on Linux | `lightningcss` |

### The feed parser's own dependencies

These seven load in the same process as `fast-xml-parser`, which reads untrusted XML on every
build. All MIT.

| Package | Version | Brought in by |
|---|---|---|
| `strnum` | 2.5.1 | `fast-xml-parser` |
| `anynum` | 1.0.1 | `strnum` |
| `@nodable/entities` | 3.1.0 | `fast-xml-parser` |
| `is-unsafe` | 2.0.3 | `fast-xml-parser` |
| `path-expression-matcher` | 1.6.2 | `fast-xml-parser`, `fast-xml-builder` |
| `xml-naming` | 0.3.0 | `fast-xml-parser`, `fast-xml-builder` |
| `fast-xml-builder` | 1.3.2 | `fast-xml-parser` (installed; `XMLBuilder` is never called by this project) |

### Native binaries and optional platform packages (78)

npm records one package per OS / CPU and installs only the matching one.

| Family | Packages | Version | Licence | Installed on macOS arm64 |
|---|---|---|---|---|
| `@esbuild/<platform>` | 26 | 0.28.1 | MIT | `@esbuild/darwin-arm64` |
| `@rolldown/binding-<platform>` | 16 (15 native + `wasm32-wasi`) | 1.2.19 | MIT | `@rolldown/binding-darwin-arm64` |
| `@tailwindcss/oxide-<platform>` | 12 (11 native + `wasm32-wasi`) | 4.3.5 | MIT | `@tailwindcss/oxide-darwin-arm64` and `@tailwindcss/oxide-wasm32-wasi` |
| `lightningcss-<platform>` | 11 | 1.33.0 | **MPL-2.0** | `lightningcss-darwin-arm64` |
| `fsevents` | 1 | 2.3.3 | MIT | Yes (macOS file watching for `tsx` and `vite`). Declares an install script |
| WebAssembly shims | 12 | see below | MIT, 0BSD | The six bundled copies |

The WebAssembly shims are `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`,
`@napi-rs/wasm-runtime`, `@tybys/wasm-util` and `tslib`, each at two versions:

| Copy | Versions | How it is installed | Integrity hash |
|---|---|---|---|
| Bundled inside the `@tailwindcss/oxide-wasm32-wasi` tarball | `@emnapi/core` 1.11.3, `@emnapi/runtime` 1.11.3, `@emnapi/wasi-threads` 1.2.3, `@napi-rs/wasm-runtime` 1.2.2, `@tybys/wasm-util` 0.10.3, `tslib` 2.8.1 | With the parent tarball. That package has no `os` / `cpu` restriction, so it is installed everywhere | None of their own in the lockfile; covered by the parent tarball's SHA-512 |
| Dependencies of `@rolldown/binding-wasm32-wasi` | `@emnapi/core` 2.0.0-beta.2, `@emnapi/runtime` 2.0.0-beta.2, `@emnapi/wasi-threads` 2.2.0, `@napi-rs/wasm-runtime` 1.2.6, `@tybys/wasm-util` 0.10.5, `tslib` 2.9.1 | Only where the CPU is `wasm32`; not installed on macOS or Linux | SHA-512 each |

Note the two beta versions (`2.0.0-beta.2`) in the second row. They are pinned by Rolldown's
WebAssembly fallback and are not installed on any platform this project builds on.

## 5. Licences

Declared licences of the 125 npm packages (from each `package.json`; no licence text was read).

| Licence | Packages | Which | Class |
|---|---|---|---|
| MIT | 106 | Everything not listed below, including all three browser packages | Permissive |
| MPL-2.0 | 12 | `lightningcss` 1.33.0 and its 11 platform binaries | **Weak (file-level) copyleft. Flag** |
| Apache-2.0 | 2 | `typescript` 6.0.3, `detect-libc` 2.1.2 | Permissive, with a patent grant and a NOTICE requirement on redistribution |
| 0BSD | 2 | `tslib` 2.8.1 and 2.9.1 | Permissive, no attribution required |
| BlueOak-1.0.0 | 1 | `graceful-fs` 4.2.12 | Permissive, but uncommon. Check it against any internal licence allow-list. It was ISC in V1's lockfile |
| BSD-3-Clause | 1 | `source-map-js` 1.2.4 | Permissive |
| ISC | 1 | `picocolors` 1.1.1 | Permissive |

No GPL, LGPL, AGPL, SSPL, Creative Commons, "UNLICENSED" or missing licence is present. All 125
declared values are SPDX identifiers; none is a licence expression or a free-text name.

Assessment (analysis, not legal advice):

1. **MPL-2.0 (`lightningcss`).** It is used unmodified, at build time, as a tool. Its code is
   not part of `dist/`; only the CSS it outputs is. MPL-2.0 obligations attach to distributing
   the covered files themselves, which this project does not do.
2. **What is distributed.** The JavaScript bundle contains `react`, `react-dom` and `scheduler`
   (MIT). The stylesheet contains Tailwind's generated output and keeps its banner
   (`tailwindcss v4.3.5 | MIT License`).
3. **Gap: no licence notice for React in the built JavaScript.** The 17 `.js` files in
   `dist/assets/` contain neither "license" nor "copyright" (checked with `grep -i` on the build
   of 2026-11-20), and the build emits no third-party notices file. The MIT licence asks for the
   notice to accompany copies. This is common for minified bundles and is low risk; shipping a
   notices file with the site would close it. Not done.
4. **GitHub Actions and Node.js** carry no licence field in SBOM.json. The generator does not
   read them.

## 6. GitHub Actions

Six actions, all published by GitHub (`actions/*`); no third-party action is used. Each is pinned
to a 40-character commit SHA, and the same action uses the same SHA in every workflow. A test
(`scripts/tools/workflows.test.ts`) enforces both.

<!-- SBOM-ACTIONS:START -->
| Action | Pinned commit | Declared tag | Workflows |
|--------|---------------|--------------|-----------|
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 | ci.yml, feed-audit.yml, refresh.yml |
| `actions/deploy-pages` | `368f82528645a54fb793d4d04e342629a3f51346` | v5.0.1 | refresh.yml |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | v8.0.2 | feed-audit.yml, refresh.yml |
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | v7.1.0 | ci.yml, feed-audit.yml, refresh.yml |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2 | feed-audit.yml, refresh.yml |
| `actions/upload-pages-artifact` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | v5.0.0 | refresh.yml |
<!-- SBOM-ACTIONS:END -->

| Workflow | File | Trigger | Actions it uses |
|---|---|---|---|
| V2 pull-request checks | `.github/workflows/ci.yml` | `pull_request` | checkout, setup-node |
| V2 refresh and deploy | `.github/workflows/refresh.yml` | Schedule (`7,22,37,52 * * * *`), push to `main`, manual | checkout, setup-node, upload-pages-artifact, upload-artifact, deploy-pages, download-artifact |
| V2 weekly audit (dependencies, feeds, links) | `.github/workflows/feed-audit.yml` | Mondays 12:23 UTC, manual | checkout, setup-node, upload-artifact, download-artifact |

Not verified: that each SHA is the commit of the tag in the "Declared tag" column. The tags come
from the trailing `# vX.Y.Z` comments in the workflow files and were not compared with the
upstream repositories. Dependabot updates the SHA and the comment together once it is active
(section 11). No workflow has run on GitHub, so it is also unverified that the SHAs resolve.

## 7. Build and runtime tools

| Tool | Version | Where it is set | Notes |
|---|---|---|---|
| Node.js (CI) | 24, latest patch the runner installs | `.node-version`, read by `actions/setup-node` | Recorded in SBOM.json as `platform:nodejs@24`. Exact patch release not pinned |
| Node.js (minimum) | `>=22.15.0` | `package.json` `engines.node` | Vite 8 and Rolldown themselves require `^20.19.0 \|\| >=22.12.0` |
| Node.js (local verification) | 26.7.0 | Developer machine | Every result in this document was produced here, not on Node 24 |
| npm | 11.19.0 locally; in CI, whatever ships with Node 24 (not verified) | No `packageManager` field, no `.npmrc` | Not a component in SBOM.json |
| Lockfile | `package-lock.json`, `lockfileVersion` 3 | Repository root | The only source of exact versions |
| Test runner | `node:test` (built into Node), started by `tsx --test` | `package.json` `test` | No test dependency |
| Type checker | TypeScript 6.0.3, `tsc -b` | Four `tsconfig.*.json` projects | Emits nothing |
| Browser target | ES2022 | `vite.config.ts` `build.target` | No polyfills; the module-preload polyfill is disabled |
| CI runner image | `ubuntu-latest` | Every job | Unpinned. The workflows' shell steps use `bash`, `curl`, `jq`, `git`, `gh` and GNU `timeout` / `date` from the image. Not in SBOM.json |
| Local dispatch helper | `gh` (GitHub CLI) | `scripts/kick-refresh.sh` | Optional; runs on the owner's machine, not in CI |
| Dev server | Vite, port 5180 in `.claude/launch.json` | Local only | No CSP in dev (Fast Refresh needs an inline script and a websocket) |

There is no server runtime. The deployed site is static HTML, JavaScript, CSS, JSON and two XML
files on GitHub Pages.

## 8. External services and data flows

**The reader's browser talks to the site's own origin and nothing else.** The production page
carries a Content-Security-Policy with `connect-src 'self'`, `script-src 'self'` plus one hashed
inline script, `style-src 'self'` and `img-src 'self' data:`. The client code contains no
absolute URL to another host (verified by searching `src/` and the build of 2026-11-20: the only
`http` strings in the built JavaScript are XML namespaces and the address in React's error
messages, and the only one in the built CSS is the address in Tailwind's licence banner; none is
requested). Reader state
(bookmarks, mutes, settings, watchlist) stays in `localStorage`. There is no analytics, no
cookie, no CDN and no third-party script.

Every other request is made by the build, in CI. Summary (generated from SBOM.json):

<!-- SBOM-SERVICES:START -->
| Service | Provider | Auth | Data | Endpoints |
|---------|----------|------|------|-----------|
| GitHub Pages | GitHub | none | outbound: Site files and the generated edition (headlines, links, feed health). | `pnelsonftp.github.io/ai-drudge-v2/` |
| GitHub Actions | GitHub | yes | bi-directional: Repository contents in; Pages artifact, state snapshot on the data branch and failure issues out. | `api.github.com/` |
| Anthropic Messages API | Anthropic | yes | bi-directional: Out: titles and summaries of already-public headlines. In: the brief text. No reader data exists to send. | `api.anthropic.com/v1/messages` |
| Yahoo Finance chart API | Yahoo | none | inbound: Public delayed quotes for eight symbols. | `query1.finance.yahoo.com/v8/finance/chart/` `query2.finance.yahoo.com/v8/finance/chart/` |
| Google News RSS and link resolver | Google | none | inbound: Public search results (headline, link, outlet). | `news.google.com/rss/search` `news.google.com/_/DotsSplashUi/data/batchexecute` |
| Hacker News search API | Algolia / Y Combinator | none | inbound: Public story metadata. | `hn.algolia.com/api/v1` |
| Registry sources (feeds, listing pages, JSON APIs) | Publishers in the source registry | none | inbound: Public feeds and pages. | see docs/SOURCES.md |
<!-- SBOM-SERVICES:END -->

### 8.1 What is sent to each (hand-written, read from the code)

Every outbound request also discloses the runner's IP address (a GitHub-hosted runner in CI) and
a User-Agent. No request carries reader data, because the build has none.

| # | Service | Caller | Requests | Data sent |
|---|---|---|---|---|
| 1 | GitHub Pages | Reader's browser | `GET` of the site's files and `data/v2/*.json` | Nothing beyond a normal page request. GitHub, as host, sees the IP address and User-Agent |
| 2 | GitHub Pages (own site) | `refresh.yml` shell steps | `curl` of `data/v2/status.json` and, as a fallback, `data/v2/state.json` | A cache-busting query (`?t=<epoch>`) |
| 3 | GitHub API and git | `refresh.yml`, `feed-audit.yml` | Pages deployment; a force-push of one orphan commit to the `data` branch; `gh api` / `gh issue` for the rolling issues | The job's `GITHUB_TOKEN`; the Pages artifact; `state.json`; issue text (run URL, streak number, coarse reason code) |
| 4 | Anthropic Messages API (optional) | `scripts/pipeline/enrich/brief.ts` | One `POST` per data build, only when `ANTHROPIC_API_KEY` is set and the ref is `main` | Headers: `x-api-key`, `anthropic-version: 2026-10-21`. Body: model `claude-sonnet-5`, `max_tokens` 4096, the fixed system prompt, the build date, and one JSON row per lead story (`title`, `summary`, `source`, `outlets`, `publishers`, `section`, `kind`, `ageHours`, `url`). All of it is already-public headline text |
| 5 | Yahoo Finance | `scripts/pipeline/enrich/stocks.ts` | One `GET` per symbol; `query2` is the retry host | The symbol (`NVDA`, `MSFT`, `GOOG`, `META`, `AMZN`, `AMD`, `TSM`, `AVGO`) and `interval=1d&range=1d` |
| 6 | Google News RSS | Ingest, 22 registry `query` sources | `GET news.google.com/rss/search?q=…` | The search terms written in the registry (public topic queries) |
| 7 | Google News link resolver | `scripts/pipeline/ingest/googleNews.ts` | For each new wrapper link: one `GET` of the wrapper page, then one `POST` to `batchexecute`. Results are cached in `state.json` | The article id, timestamp and signature Google itself issued; a browser User-Agent; `Referer: news.google.com` |
| 8 | Hacker News search API (signal) | `scripts/pipeline/ingest/signals/hn.ts` | Two `GET`s per build: `search_by_date` (stories over 30 points in 72 h) and `search?tags=front_page` | Fixed filters only |
| 9 | Hacker News search API (sources) | Ingest, 12 registry `json` sources | `GET hn.algolia.com/api/v1/search…` | The search words and points threshold written in the registry |
| 10 | Registry sources | Ingest (`scripts/pipeline/ingest/http.ts`) | One conditional `GET` per active source per build | `User-Agent`, `Accept`, and the `If-None-Match` / `If-Modified-Since` validators saved from the previous build. No cookies, no credentials |
| 11 | npm registry | `npm ci`, `npm audit`, `npm audit signatures` | Package downloads; advisory and signature lookups | Package names and versions from the lockfile |

Notes on rows 4 to 10:

- **User-Agent.** The default is `ai-drudge/2.0 (+<SITE_URL>; feed reader)`, or the repository
  variable `FEED_USER_AGENT` when set. A host that answers 401, 403, 406 or 429 is retried once
  with a browser User-Agent string. The Google News resolver and the Yahoo retry host use the
  browser string first.
- **Redirects** are followed hop by hop (at most 8) and a hop to a non-public host is refused.
- **Anthropic.** Without a key the build writes a deterministic brief and makes no request. Every
  build so far was keyless, so this call has never run (not verified live). Titles and summaries
  are third-party text; the reply is schema-constrained and validated field by field before
  anything is published. See [SECURITY.md](./SECURITY.md).
- **hnrss.org is no longer contacted.** The Hacker News searches moved to the official Algolia
  API in the final round. V1's `stooq.com` quote source is also gone.

### 8.2 Registry endpoint classes

The registry holds 414 sources (413 active, 1 paused) on 297 distinct hosts among the active
ones, all `https`. [SOURCES.md](./SOURCES.md) lists every source with its URL. By class
(active sources, counted from `scripts/registry` on 2026-11-20):

| Class | Sources | Hosts | Examples |
|---|---|---|---|
| Publisher RSS / Atom feeds (kind `rss`) | 248 | 219 | News sites, vendor and lab blogs, regulators, YouTube channel feeds |
| Newsletter feeds (kind `newsletter`) | 57 | 56 | 10 are on `*.substack.com`; the rest are on their own domains |
| GitHub release feeds (kind `github-release`) | 37 | `github.com` | `/<owner>/<repo>/releases.atom` |
| Google News searches (kind `query`) | 22 | `news.google.com` | Row 6 above |
| Federal Register search (kind `query`) | 1 | `www.federalregister.gov` | Public search API |
| JSON APIs (kind `json`) | 15 | `hn.algolia.com` (12), `huggingface.co` (3) | Row 9 above |
| HTML listing pages (kind `scrape`) | 19 | 12 hosts | `www.anthropic.com` (4), `github.com` (3), `www.finra.org`, `www.aisi.gov.uk`, `ollama.com` |
| Paper feeds (kind `papers`) | 9 | 7 hosts | `rss.arxiv.org` (3), `export.arxiv.org`, `www.nature.com`, `www.science.org`, `www.pnas.org` |
| Community feeds (kind `community`) | 4 | 4 hosts | `www.lesswrong.com`, `sh.itjust.works`, `forums.developer.nvidia.com`, a GitHub discussions feed |
| Aggregator (kind `aggregator`) | 1 | `www.techmeme.com` | |

The rows add up to 413. A host can appear in more than one row. The `rss` count excludes the one
paused source (`venturebeat-ai`).

`github.com` is the largest single host with 45 sources: the 37 release feeds, 3 commit-history
Atom feeds, 2 discussion feeds and 3 HTML pages (2 of them security-advisory listings). Other
hosts with several sources: `news.google.com` (22), `hn.algolia.com` (12), `www.youtube.com` (4
channel or playlist feeds), `vulnerability.circl.lu` (4), `huggingface.co` (4) and
`www.anthropic.com` (4).

Government and regulator hosts fetched directly (17): `www.sec.gov`, `www.finra.org`,
`www.occ.gov`, `www.federalreserve.gov`, `www.cftc.gov`, `www.federalregister.gov`,
`www.nist.gov`, `www.cisa.gov`, `www.nsa.gov`, `www.ncsc.gov.uk`, `www.aisi.gov.uk`,
`www.fca.org.uk`, `www.bankofengland.co.uk`, `www.bis.org`, `www.fsb.org`, `www.iosco.org`,
`digital-strategy.ec.europa.eu`.

### 8.3 Developer tools that use the network

These are run by hand or by the weekly audit, never by the site.

| Command | Contacts | Sends |
|---|---|---|
| `npm run build:data` | Rows 4 to 10 above | As above |
| `npm run validate:feeds` | Every registry source | Same request policy as the build |
| `npm run check:links` | Every `http(s)` URL in the registry and in `docs/`; with `-- --data` also up to 300 article URLs of the river (2,227 unique URLs in the full run of 2026-11-20) | `HEAD`, then `GET` on failure |
| `npm run compare` | A V1 payload, only when given a URL instead of a file | One `GET` |
| `npm run sbom`, `npm run docs:sources`, `npm test`, `npm run typecheck`, `npm run build`, `npm run build:check`, `npm run data:fixture`, `npm run fixture:refresh`, `npm run explain` | Nothing | Nothing |

## 9. Fonts and static assets

Verified on 2026-11-20 by searching `src/`, `public/` and `dist/`.

| Item | Finding |
|---|---|
| Web fonts | None. No font file, no `@font-face`, no font host. `--font-sans` is `Arial, Helvetica, sans-serif` (`src/styles/tokens.css`); three rules use a system monospace stack |
| Images | One file: `public/favicon.svg`, the project's own. The client renders no `<img>` and no `<iframe>` |
| Icon libraries, CSS frameworks from a CDN | None. Tailwind is compiled into the site's own stylesheet |
| Third-party scripts, analytics, tag managers | None |
| Bundled data | `public/data/v2/*.json`, `public/feed.xml`, `public/feeds.opml`: generated by the build, not committed, third-party headline text and links only |
| Built output | `dist/`: 35 files on 2026-11-20 (`index.html`, 17 JavaScript files, 5 stylesheets, the favicon, the data files and two XML files) |

## 10. Vulnerability status

Run on 2026-11-20 (UTC) against the lockfile in the working tree, on macOS arm64 with Node 26.7.0 and
npm 11.19.0.

| Check | Command | Result |
|---|---|---|
| Advisories, full tree | `npm audit` | **0 vulnerabilities** (info 0, low 0, moderate 0, high 0, critical 0) across 125 packages |
| Registry signatures and provenance | `npm audit signatures` | Exit 0: 59 packages audited, 59 verified registry signatures, 35 verified attestations |
| SBOM matches lockfile and workflows | `npm run sbom -- --check` | "SBOM is current" (125 npm packages, 6 GitHub Actions, 7 services) |

Limits of these results:

1. `npm audit signatures` checks only what is installed. The 66 packages that are binaries for
   other platforms, including the Linux x64 binaries CI will use, were not checked here. The
   weekly audit job runs the same command on the runner.
2. `npm audit` covers npm packages only. GitHub Actions, Node.js and the runner image are outside
   it; Dependabot covers the actions once active.
3. A clean audit is a statement about known advisories on the day it ran.

Triage order when an advisory appears: packages with usage `data-pipeline` first (they parse
untrusted input on every build, and `fast-xml-parser` is the exposed one), then
`browser-runtime`, then `build-tooling`. Steps are in [SECURITY.md](./SECURITY.md).

## 11. Supply-chain controls

| Control | Implementation | Status |
|---|---|---|
| Exact versions | `package-lock.json` (v3) is committed. `package.json` uses caret ranges, except `typescript` (`~6.0.3`) | In place |
| Integrity | 119 of 125 lockfile entries carry a SHA-512 `integrity` value and resolve to `registry.npmjs.org`. The other 6 are bundled inside one tarball that is itself hashed (section 4) | In place |
| Reproducible install | `npm ci --ignore-scripts` in every workflow (`ci.yml`, `refresh.yml`, both jobs of `feed-audit.yml`) | In place; not yet run on GitHub |
| Install scripts disabled | `--ignore-scripts`. Two packages declare one: `esbuild` 0.28.1 and `fsevents` 2.3.3. The 2026-11-19 dependency review recorded a clean `npm ci --ignore-scripts` with typecheck, tests and build passing; that install was not repeated for this document | In place |
| Actions pinned by commit | 40-character SHAs; one SHA per action; enforced by `scripts/tools/workflows.test.ts` | In place |
| Least-privilege tokens | `permissions: {}` at workflow level, per-job grants, `persist-credentials: false` on all four checkouts. In `refresh.yml` the jobs with write scopes (deploy, persist, alert) never check out or install the repository. The report job of `feed-audit.yml` (`issues: write`) does install and run one repository script | In place; see [SECURITY.md](./SECURITY.md) |
| Pull-request gate | `ci.yml`: typecheck, tests, site build, read-only token, no secrets | In place; not yet run on GitHub |
| Weekly audit | `feed-audit.yml`, Mondays 12:23 UTC: `npm audit --audit-level=high` on the full tree and `npm audit signatures`. Either failing turns the run red and opens or comments on one rolling issue, "Dependency audit failing" | In place; not yet run on GitHub |
| SBOM drift check | Same workflow: `generate-sbom.ts --check`. Warning only; it never fails the run | In place |
| Automated updates | `.github/dependabot.yml` (below) | Written; **inert until the file is on the default branch** |
| Small surface | 12 direct dependencies, 3 in the browser. No SDK for the model call | By design |
| Pipeline label kept honest | Test fails when `scripts/` imports a package outside `PIPELINE_PACKAGES` | In place |

Dependabot configuration (`.github/dependabot.yml`):

| Setting | npm | GitHub Actions |
|---|---|---|
| Schedule | Weekly, Monday 07:00 America/Chicago | Same |
| Grouping | One pull request for all minor and patch updates; each major separately | One pull request for all action updates |
| Cooldown | A release must be 7 days old before it is proposed. Security updates are not delayed | Same |
| Open pull-request limit | 3 | 2 |
| Commit prefix | `chore(deps)` | `chore(ci)` |
| Held back | Majors of `typescript` (TypeScript 7 has no JS API yet) and `@types/node` (must match `.node-version`) | None |

After merging any dependency update:

1. `npm ci --ignore-scripts`
2. `npm run typecheck && npm test && npm run build`
3. `npm audit && npm audit signatures`
4. `npm run sbom`, then commit `package-lock.json`, `docs/SBOM.json` and this file together.
5. Correct the hand-written figures in sections 2, 4, 5 and 12 if they moved.

## 12. Upgrade history, V1 to V2

V1 values are from the `main` branch (`package.json` and `package-lock.json`, identical to the
backup taken before the fork). V2 values are from the current lockfile. The set of direct
dependencies did not change: nothing was added or removed.

| Package | V1 range | V1 resolved | V2 range | V2 resolved | Note |
|---|---|---|---|---|---|
| `vite` | `^6.3.5` | 6.4.3 | `^8.3.8` | 8.3.8 | Two majors. Bundler changes from Rollup to Rolldown |
| `@vitejs/plugin-react` | `^4.4.1` | 4.7.0 | `^6.3.0` | 6.3.0 | Two majors. No longer pulls in Babel |
| `typescript` | `~5.8.3` | 5.8.3 | `~6.0.3` | 6.0.3 | One major. Four project files instead of one |
| `react` | `^19.1.0` | 19.2.7 | `^19.3.1` | 19.3.1 | Minor |
| `react-dom` | `^19.1.0` | 19.2.7 | `^19.3.1` | 19.3.1 | Minor |
| `tailwindcss` | `^4.1.8` | 4.3.2 | `^4.3.5` | 4.3.5 | Patch |
| `@tailwindcss/vite` | `^4.1.8` | 4.3.2 | `^4.3.5` | 4.3.5 | Patch |
| `fast-xml-parser` | `^5.9.3` | 5.9.3 | `^5.12.1` | 5.12.1 | Minor. Cleared the advisories below |
| `tsx` | `^4.19.2` | 4.23.0 | `^4.23.15` | 4.23.15 | Patch |
| `@types/node` | `^25.9.3` | 25.9.4 | `^24.19.2` | 24.19.2 | **Down** one major, to match the CI runtime (Node 24) |
| `@types/react` | `^19.1.2` | 19.2.17 | `^19.3.0` | 19.3.0 | Minor |
| `@types/react-dom` | `^19.1.2` | 19.2.3 | `^19.3.0` | 19.3.0 | Minor |

Transitive and tree-level changes:

| Item | V1 | V2 |
|---|---|---|
| Lockfile packages | 190 | 125 |
| Runtime / dev / optional flags | 3 / 187 / 101 | 3 / 122 / 78 |
| Bundler | `rollup` 4.62.2 + 25 `@rollup/rollup-*` binaries | `rolldown` 1.2.19 + 16 `@rolldown/binding-*` packages |
| Babel | `@babel/core` 7.29.7 and 18 more `@babel/*` packages | None |
| Browserslist chain (`browserslist`, `caniuse-lite`, `electron-to-chromium`, `node-releases`, `baseline-browser-mapping`, `update-browserslist-db`) | Present | None |
| `esbuild` | 0.28.1, plus a second copy 0.25.12 nested under `vite` | 0.28.1 only |
| `scheduler` | 0.27.0 | 0.28.0 |
| `lightningcss` | 1.32.0 | 1.33.0 |
| `postcss` | 8.5.16 | 8.5.33 |
| `strnum` | 2.4.1 | 2.5.1 |
| Packages with install scripts | 3 | 2 |
| Licences | MIT 167, MPL-2.0 12, ISC 6, Apache-2.0 3, BSD-3-Clause 1, CC-BY-4.0 1 | MIT 106, MPL-2.0 12, Apache-2.0 2, 0BSD 2, BlueOak-1.0.0 1, BSD-3-Clause 1, ISC 1 |
| `npm audit`, full tree | 7 advisories (6 high, 1 moderate) on the V1 lockfile, per the 2026-11-19 dependency review | 0 on 2026-11-20 |

Build and CI changes that affect the bill of materials:

| Item | V1 | V2 |
|---|---|---|
| Node.js in CI | 22 (`node-version: "22"` in the workflow) | 24 (`.node-version`) |
| Install command | `npm ci` | `npm ci --ignore-scripts` |
| Actions | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`, referenced by moving tag | Six actions pinned by commit SHA (section 6) |
| Dependency audit | `npm audit --omit=dev --audit-level=high` (blocking) plus a full `npm audit` as a warning. The build-time parser is a dev dependency, so the blocking check could not see it | `npm audit --audit-level=high` on the full tree, plus `npm audit signatures`, with a rolling issue |
| Pull-request checks | None | `ci.yml` |
| Dependabot | None | `.github/dependabot.yml` |
| SBOM | CycloneDX 1.5, 190 components (npm packages only), no services, no dependency graph, the `@` of scoped package URLs not percent-encoded | CycloneDX 1.6, 132 components (npm packages, actions, Node.js), 7 services, 126 graph entries, usage labels |
| Quote source | `stooq.com` and Yahoo | Yahoo only |
| Hacker News searches | `hnrss.org` | `hn.algolia.com` |

The narrative of the upgrade is in [CHANGELOG.md](./CHANGELOG.md) and
[PROJECT_HISTORY.md](./PROJECT_HISTORY.md).

## 13. Not covered and not verified

| Item | State |
|---|---|
| CycloneDX schema validation | SBOM.json has **not** been validated against the official 1.6 JSON schema. That needs the schema file and a validator, which would be a new dependency. Tests pin the serial-number pattern, unique `bom-ref`s and that no dependency reference dangles |
| Runner image | `ubuntu-latest` is unpinned and not inventoried (`bash`, `curl`, `jq`, `git`, `gh`, coreutils) |
| npm CLI | Not a component. Version in CI not verified |
| Node.js patch release | Only the major line (24) is recorded |
| Action tags | The tag beside each pinned SHA is declared, not verified against upstream |
| Licences | Declared values only. No licence text was read and no licence scanner was run |
| Signatures on other platforms | `npm audit signatures` covered the 59 packages installed on macOS arm64 |
| Anything on GitHub | No workflow has run. `npm ci` on Linux, the audit job, the Dependabot configuration and the pinned SHAs are untested there. The V2 repository and Pages site did not exist on 2026-11-20 |
| Anthropic API call | Never executed; every build so far was keyless |
| Hosts behind redirects | A source may redirect to another public host at fetch time. Only the registry URLs are listed |
| Model provider and hosting retention | Data retention by Anthropic, GitHub, Google, Yahoo and Algolia was not reviewed |
