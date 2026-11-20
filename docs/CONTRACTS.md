# AI DRUDGE V2 — Contracts

The map of the types and functions the packages of this repository share. The TypeScript files are
the source of truth (they are heavily commented); this page tells you **which file, which names,
who provides, who consumes**. The contracts were frozen while the packages were built in parallel
and were unfrozen at cutover (2026-11-19); §9 lists what changed then, §10 and §11 what the two
review rounds of 2026-11-20 changed, §12 how the committed fixture is made, §13 what the closing round changed. Change a contract and its
consumers in the same commit - `npx tsc -b` and `npm test` are the gate.

## 1. Contract files

| File | What it is | Consumers |
|---|---|---|
| `shared/sections.ts` | The 15 sections (only declaration of `SectionId`), V1→V2 mapping | all |
| `shared/contract.ts` | Schema v2 types of every file in `public/data/v2/` | all |
| `shared/ids.ts` | `hashId` (V1 djb2), `isArticleId` | WP3, WP6, WP7 |
| `shared/url.ts` | `isHttpUrl`, `canonicalUrl`, `urlKey`, `registrableHost` (pure string code) | WP1–WP3, WP4 (HN key), client |
| `shared/time.ts` | `ageHours`, `timeAgo`, `isNew`, `isStale`, `effectiveAt`, `passesTimeFilter` — clock is always a parameter | all |
| `shared/text.ts` | `tokenize`, `STOPWORDS`, `jaccard`, **`compileTerms`**, search helpers, `slugify` | WP3, WP4, WP5, WP7, WP9, WP10 |
| `shared/guards.ts` | `isEditionFront` … `isStatusFile` + `validateX(x): string \| null` | WP6, WP7 |
| `shared/invariants.ts` | Cross-file integrity: `checkFront/checkRest/checkRiver/checkAux/checkBundle` → `string[]` | WP6 (emit tests, gate) |
| `shared/select.ts` | `Edition`, `mergeEdition`, `storyOf`, `visibleStory` (the story under the reader's mutes), `sectionRows`, `latest`, `storyPassesTimeFilter`, `storyNewestMs`, `searchEdition`, `searchRiver`, `parseSearch`, `sectionNamed`, river helpers | WP6 (atom, brief), WP7–WP10 |
| `scripts/registry/types.ts` | `SourceDef`, `PublisherDef`, `ResolvedSource`, scrape / JSON-API config | WP1–WP6 |
| `scripts/registry/defaults.ts` | `resolveSource(def)` — the ONE place optional `SourceDef` fields get defaults | WP1–WP3, WP6 |
| `scripts/pipeline/types.ts` | Stage I/O types and the stage function types | WP2–WP6, WP11 |
| `scripts/pipeline/context.ts` | `createContext`, `createTestContext`, `emptyState`, `PIPELINE` constants, `ENV` keys | WP2–WP6, WP11 |
| `scripts/pipeline/run.ts` | `runPipeline(options)`, `processItems(ingest, registry, ctx)`, `formatStageTable` - the composition root (`npm run build:data`) | CI, tests, tools |
| `src/app/services.ts` | Client service interfaces + `createStore`, `useStore`, `ServicesContext`, `useServices` | WP7–WP11 |
| `src/app/presets.ts` | `WATCH_PRESETS`, `SECTION_PRESETS` | WP7, WP9, WP10 |

`shared/` is pure: no `node:`, no DOM, imports only `shared/`. `tsconfig.shared.json` (lib ES2022,
`types: []`) proves it — the global `URL` class is not available there, use `shared/url.ts`.

## 2. Sections (V2_PLAN §1.1)

`models, industry, ai_security, open_local, tools, policy, money, research, compute, safety, cyber,
analysis, robotics, quantum, releases` — homepage order = `SECTIONS` order.

- `desk`: `ai` (feeds TOP STORIES / lead / brief / Atom), `owner` (cyber, quantum), `utility` (releases).
- `mode`: `topic` (routing may add stories) or `source` (only stories whose source `home` is the section).
- `window {softDays, hardDays, minItems}`, `homeRows`, `allRows`, `maxPublisherShare` (0.3), `legacyIds`.
- V1 ids: `legacyToSection(id, { safetyHalf })` (primary) and `legacyToSections(id)` (all; `safety_policy` → `["policy","safety"]`).

## 3. Data contract (V2_PLAN §1.2)

Files in `public/data/v2/` (gitignored; fixture in `test/fixtures/v2/`, a frozen live build - §12; `npm run data:fixture` installs it).
`public/feed.xml` (Atom) and `public/feeds.opml` are generated next to them and are gitignored too.

| File | Type | Guard | Notes |
|---|---|---|---|
| `front.json` | `EditionFront` | `isEditionFront` | `leadId`, `top` (≤ 12, `leadId === top[0] ?? null`), `counts`, all 15 `sections` (homepage rows), `articles`, `clusters`, `sources` |
| `rest.json` | `EditionRest` | `isEditionRest` | full rows per section (front rows are a prefix); article/cluster/source keys disjoint from front |
| `river.json` | `RiverFile` | `isRiverFile` | 7 days, newest first; rows are tuples — use `riverRows(river)` or the `RIVER` index constants |
| `health.json` | `HealthFile` | `isHealthFile` | per source: `ok`, `status` (ok/failing/quarantined/carried), `error`, `lastError`, `failStreak`, `lastOkAt`. `carried` + `error: "skipped"` + `lastError` starting `host backoff:` = the source was not asked this run because its host was failing (§11) |
| `sources.json` | `SourcesFile` | `isSourcesFile` | registry export (`SourceInfo`) |
| `brief.json` | `BriefFile` | `isBriefFile` | render only when `source === "claude"`; `model` is the audit trail; optional `fallbackReason` = coarse code of why the deterministic brief was published (`no-key`, `thin`, `http-4xx`, `timeout`, `invalid-reply` ...), never free text |
| `stocks.json` | `StocksFile` | `isStocksFile` | `asOf`, `marketState`, `order`, `quotes` |
| `status.json` | `StatusFile` | `isStatusFile` | ops (`schema: 1`), run / feeds / content / gate `{ passed, failures?, warnings }` / `brief { source, reason?, failStreak? }` (reason = `BriefFile.fallbackReason`; failStreak = consecutive keyed builds whose Claude brief failed) / stocks. `staleAfterMinutes` (120) is reader-facing: the client's stale banner follows it (§5) |
| `state.json` | `StateFile` (`scripts/pipeline/types.ts`) | — | read by the next build only. **Not part of the Pages artifact** by default (repository variable `V2_PUBLISH_STATE=true` publishes it again); CI hands it from build to build through the `data` branch, which belongs to a public repository - so it is still written as a public file. Last-good summaries are stored as plain text ≤ 600 chars (`slimLastGood`), never the publishers' HTML |

Key rules (enforced by `shared/invariants.ts`):

- Rows are **story lead ids**. A cluster is keyed by its lead; `members` excludes the lead; singletons
  are omitted; `publishers` counts publishers (incl. the lead's), never feed names.
- A **member** article carries no `summary` (only a lead's summary is shown or searched; this keeps
  `front.json` inside the 48 KB gzip first-paint budget on a day with a 30-publisher story).
- **Mutes never change a story's key.** `visibleStory(edition, leadId, mutes)` drops the articles of
  muted sources and, when the pipeline's lead is one of them, promotes the first remaining article
  (`StoryView.key` stays the lead id, `StoryView.lead` is the article to display, `publishers` is
  recounted). `topStories`, `sectionRows`, `alsoOutlets`, `searchEdition` all go through it: a story
  disappears only when every outlet covering it is muted. `publishers` under mutes = the COUNTED
  publishers (the lead + the first `publishers - 1` members) that still have a visible article,
  never below the old floor (`publishers` minus the publishers muted entirely).
- **Member order is contract** (`ClusterV2`): when the lead counts for coverage, the first
  `publishers - 1` members are the first article of each other counted publisher (cluster
  `orderMembers`); repeats and non-counting items follow. A cluster test pins it.
- Search matches what a story **says** (displayed headline, the lead's summary, the other outlets'
  headlines), strongest first. A story that needs a source or publisher NAME to hold every word is
  reported apart (`SearchGroup.nameOnly`, `searchRiver(...).nameOnly`) and is not counted as a match.
  Section names are not search text: `sectionNamed(query)` offers the section, and the operators
  `source:<name|id>` / `section:<id|code|label>` (`parseSearch`) narrow a search.
- A story is as new as its **newest visible article**: time chips, the NEW chip and the new-since
  counts use `storyPassesTimeFilter(edition, key, filter, now, previousVisitMs, mutes)` (articles
  flagged `discussion` never make an old story new), not the lead's time.
- A story appears in its home section plus **at most one** routed section. `source`-mode sections
  only hold their home articles. TOP STORIES are ai-desk stories, never a release / community item.
- `ArticleV2.w`: 3 = publishers ≥ 8; 2 = publishers ≥ 3 or tier-1 first-party launch; 0 = tier-4
  lead with fewer than 2 publishers (`SCORE.weight.corroborated`); 1 = default and **omitted**
  (evaluate in that order). A story MEMBER of a tier-4 source is always 0. Use `weightOf(a)` / `weightClass(a)`.
- `ArticleV2.firstSeenAt` is always present; effective time = `publishedAt ?? firstSeenAt`.
- `ArticleV2.pub` is set only for link-host attributed items; always read names through
  `publisherName(edition, article)` and `sourceName(edition, id)`.
- Every file of one build carries the same `buildId`; `mergeEdition` throws `BuildMismatchError`.

## 4. Pipeline (`scripts/pipeline/run.ts` composes the stages)

```
loadState(file)                            -> PipelineState (missing / corrupt file -> empty)
ingest(registry, ctx)                      -> IngestOutput { items: RawItem[], health, signals.hn, resolvedUrls, lastGood }
normalize(raw, registry, ctx)              -> NormalizeOutput { items: NormalizedItem[], dropped }
filterRelevance(items, registry, ctx)      -> RelevanceOutput { kept, dropped, passed }   (passed = before the per-source cap)
rescueCorroboration(out, clusterFn, ctx)   -> RelevanceOutput { kept, dropped }           (over-cap items that share a story with another publisher come back)
cluster(items, ctx)                        -> Story[]
score(stories, signals, ctx)               -> ScoredStory[]   (sorted, with parts and w)
route(scored, ctx)                         -> Placements { stories (ALL), sections, top, leadId, primary, trace }
makeBrief(placements, ctx) ∥ fetchStocks(ctx)
emit({ placements, health, registry, brief, stocks, dropped?, run? }, ctx) -> EmitBundle
nextState(ctx.state, { ingest, normalized, placements, bundle }, ctx)       -> PipelineState
writeBundle(bundle, state, { dataDir, publicDir })      (+ writeExplain(buildExplain(...)) for `npm run explain`)
```

- `StageContext { now, buildId, env, fetch, log, state }` — `ctx.now` is the only clock; `ctx.state`
  is read-only; state changes travel in outputs and are folded by `nextState`. The object returned
  by `loadState` is passed through whole.
- `runPipeline` adds: state restore from `STATE_URL` when `STATE_FILE` (default
  `public/data/v2/state.json`) is missing (CI does not use `STATE_URL`: `refresh.yml` restores the
  file from the `data` branch before the pipeline starts); a per-stage timing / count table; the **zero-article
  guard** (nothing survives relevance -> previous files untouched, `status.gate` marked failed,
  exit 0 - the CI freshness gate then holds the deploy). `processItems` is the pure middle
  (normalize -> route), used by tests. `RunResult.keptReason` says why the previous edition was
  kept; `reportOutcome` writes the step output `outcome` and an error annotation in GitHub Actions.
  `ANTHROPIC_API_KEY` is handed to `makeBrief` only (every other stage's `ctx.env` has no key, and
  the CLI entry deletes it from `process.env`). `slimLastGood` runs after `nextState`.
- `processItems` calls `rescueCorroboration(filterRelevance(...), (items) => cluster(items, quiet), ctx)`:
  the per-source cap must not cut the items a multi-publisher story is built from (OpenAI's own
  GPT-6.2 post behind 8 newer OpenAI posts). A source's single-publisher rows still never exceed
  its cap.
- `RawItem.resolvedFrom` — the Google News wrapper URL or aggregator permalink (Techmeme) a link was resolved from. Normalize keeps the
  first-seen time recorded under the wrapper's id (`NormalizedItem.formerIds`) and emit drops the
  wrapper's old river row, so an article does not become "new" again when its link is resolved in a
  later build.
- `FeedHealth.notModified` — the source answered 304 and its last-good items were reused (ok).
  `LastGood { fetchedAt, items, etag?, lastModified?, bodyAt? }` carries the conditional-GET validators.
- `NormalizedItem` carries the source policy denormalised with defaults applied (`routing`,
  `routeTo`, `leadEligible`, `countsForCoverage`, `attribution`, `tags`, `publisher`,
  `publisherName`, `sourceName`, and `maxAgeDays` **only when the registry sets it**) so cluster /
  score / route never need the registry. `NormalizedItem.outletHost` is the host of the outlet a feed
  names for an item whose link is still an unresolved wrapper; `SourceDef.excludeUrl` / `includeUrl`
  are matched against it as well as the URL. An aggregator item that credits its outlet in the title
  (Techmeme's "(Author/Outlet)" tail) is emitted with attribution `link-host` and that outlet as
  publisher. Among same-URL twins a pointer-only copy (link-host attribution, not lead-eligible, not
  counting for coverage) never becomes the primary.
- `NormalizedItem.firstSeenAt` = ledger entry, else the build clock — except on a **baseline run**
  (empty state, or a source the state has never read successfully): a dated item is first seen at
  its `publishedAt`, an undated one `maxAgeDays + 1` days ago. `nextState` persists the item's own
  value for a new id.
- `RouteTrace.cut` values (`RouteCut`): `window`, `diversity`, `cap`, `mode`, `limit` (already has
  its one routed section), `policy` (home-only source / not in `routeTo`), `moved` (cyber -> ai_security,
  or -> policy when the title is a policy match: `ROUTE_POLICY.moveYieldsTo`).
- TOP STORIES are ranked by **score** (publisher count breaks ties), not by publisher count alone; since the closing round a story fewer than 3 publishers cover is ranked with its recency capped (`topStanding`, §13).
- Score: `SCORE.importance.regulatorNotice` (10, inside the importance cap of 12) for a lead whose
  source is tagged `regulator` + `first-party` - a regulator's own notice is the event even when its
  title carries no event word.
- River memory: a remembered row leaves when it ages out, when its source leaves the registry, or
  when this run saw the item again and rejected it on content (`rejectedThisRun(dropped)`: reasons
  `invalid` / `excluded` / `noise` / `off_topic`).
- `Placements.top` may be `[leadId]` with ONE publisher on a quiet day.
- `HnIndex.byUrl` keys are `urlKey(url)` from `shared/url.ts` (exact-URL only).
- `PipelineState { firstSeen, resolvedUrls, health, lastGood, recent, lead, lastSeenDay?, top?,
  briefFailStreak? }`. `recent` is the river's memory (feeds only list their newest N items);
  `lastSeenDay` drives ledger pruning by LAST sighting; `top: TopMemory[] { id, score, heldSince? }`
  is the published TOP STORIES list (the hold rule, §11); `briefFailStreak` counts consecutive keyed
  builds whose Claude brief failed. All parsed defensively (`parseState`).
- Shared policy numbers live in `PIPELINE` (carry-forward 6 h, quarantine 48 fails, source cap 8,
  half-life 36 h, TOP STORIES 72 h / 120 h, lead stickiness, caps). Do not re-declare them.
- `ENV` keys: `SITE_URL`, `SITE_BASE`, `ANTHROPIC_API_KEY`, `FEED_USER_AGENT`, `BUILD_STARTED_AT`,
  `STATE_FILE`, `STATE_URL`, `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT` / `GITHUB_EVENT_NAME` / `GITHUB_SHA`.

### 4.1 Registry fields added at cutover (`scripts/registry/types.ts`)

| Field | Meaning | Read by |
|---|---|---|
| `SourceDef.maxKept?` | per-source cap AFTER relevance (default `PIPELINE.sourceCap` = 8); `maxItems` stays the ingest window | relevance |
| `SourceDef.maxAgeDays?` (explicit) | also extends the section hard window for this source's stories (surfaces through the starvation fill only) | normalize -> route |
| `SourceDef.titleTemplate?` | headline for sources whose feed titles are not headlines; placeholders `{title}`, `{summary}` (first sentence), `{source}` | normalize |
| `SourceDef.releaseLine?` | tag prefixes that are a repo's own release line (`rust` for openai/codex) | normalize |
| `ResolvedSource.maxKept`, `.maxAgeExplicit` | defaults applied by `resolveSource` | stages |
| `MAX_SOURCE_AGE_DAYS` (45, `defaults.ts`) | `validateRegistry` rejects a larger `maxAgeDays` (the data gate fails on items older than 60 days) | registry |

| `SourceDef.outlets?` | link-host sources only: `"vetted"` (default) = an item whose outlet no registry publisher vouches for carries no standing (§11); `"open"` = the source has its own quality signal (HN points, Techmeme's editors) and needs a `note` saying so | normalize, relevance |
| `ResolvedSource.outlets` | default applied (`"open"` for every source that is its own publisher) | stages |
| `SourceDef.includeIn?` | `"title"` \| `"title+summary"` (default): where the `include` terms are looked for; `exclude` always reads both | relevance |
| `SourceDef.fetch?` | `SourceFetchPolicy { headerTimeoutMs?, timeoutRetries?, attempts? }` for a slow origin; validated (1000-25000 ms, 0-1, 1-3) and clamped again by ingest `fetchPolicyFor` | ingest, validate-feeds |
| `JsonApiConfig.urlField` + `urlTemplate` | at least one; with both, the field is used and the template is the fallback for an empty field (HN text posts link to their thread) | ingest |

The registry holds 414 sources (413 active), 405 publishers, 10 denied outlets and 12 `probation`
tags as of 2026-11-20 (final round). `docs/SOURCES.md` (`npm run docs:sources`) lists every source.

Tag conventions (data, not types): `probation` (failure expected from CI; excluded from the gate's
live-feed denominator), `disabled` (paused on purpose), `fallback` (Google News mirror of blocked
feeds), `declared-ua`, `digest`, `paywalled`, `press` / `first-party` / `lab`, `low-cadence` (months of
silence are expected: the feed audit uses a 365-day stale limit instead of 60), `regulator` (with
`first-party`: the score's regulator-notice term AND, for the publishers listed in
`ROUTE_POLICY.regulatorFloor`, the POLICY homepage floor). `unvetted-outlet` is not a registry tag:
normalize writes it on an ITEM (`UNVETTED_OUTLET_TAG`, `scripts/registry/outlets.ts`).

## 5. Client (`src/app/createServices.ts` wires it; `src/main.tsx` is the entry)

`AppServices { edition, sourcesData, saved, mutes, readState, settings, watchlist, backup, hover,
focus, router, clock, lastVisit, migration, reimportV1(), baseUrl, ui, persistence? }`.

- `Store<T> { get, subscribe }`; `createStore(initial)` is the one store primitive;
  `useStore(store, select?)`.
- `Route`: `home | section{id} | search{q} | new | watch | saved{tab} | sources | settings | about`.
  Hashes: `#/` `#/s/<id>` `#/q/<query>` `#/new` `#/watch` `#/saved` `#/later` `#/sources`
  `#/settings` `#/about`. Always build links with `router.href(route)`.
- `RouteModule`: one directory per route name — `src/features/<name>/route.tsx` with
  `export default route`, discovered by `src/app/routeRegistry.ts`.
- `UiSlots.HeadlineRow` (`HeadlineRowProps { id, item?, variant?, showSection?, onOpen? }`) is the
  one row component (`src/features/headline`), read through `useServices().ui.HeadlineRow`.
- The row displays `visibleStory(...)`'s article: when the keyed lead's source is muted and another
  outlet covers the story, title / link / source / time / bookmark are that outlet's (`data-aid` is
  the displayed article's id) while the `id` prop stays the key for the cluster and the "Also:" line.
  Saved rows always show what was saved.
- `EditionState.restStatus: LoadStatus` — `error` means "rest.json failed, offer Retry (`loadRest()`)".
  `EditionState.error` is also set (status and edition unchanged) when the last refresh failed while
  an edition is on screen.
- `Settings.shortcuts: boolean` (default true) - the reader's off switch for single-key shortcuts
  (WCAG 2.1.4; Settings > Appearance > Keyboard). `KeyInput.shortcutsOff`; `KeyCommand` has
  `{ type: "undo" }` (key `u`, undoes the last mute while its notice shows). A section without
  rendered rows receives `[` / `]` focus on its `h2 a[href]`.
- Stale threshold ("Headlines may be delayed", the tagline's "delayed", About): `status.json`
  `staleAfterMinutes` (120), published by the edition store as `EditionState.staleAfterMinutes` and
  read through `staleThresholdHours(state)` (`src/features/chrome/model.ts`; believed only inside
  30 min .. 24 h). `STALE_BANNER_HOURS` (2) is the FALLBACK until status.json has loaded. The store
  fetches status.json for that one field (own one-field guard, never blocks the headlines).
- `EditionState.retrying` - the first load failed and another attempt is running ("still trying").
- `AppServices.persistence?: Store<PersistenceState { writeRefused }>` - true from the first reader
  change the browser did not keep; the real wiring always provides it, fakes may omit it.
- `Settings.dimSeen: boolean` (default true; absent in old settings and backups = true) - the
  "Dim headlines I have seen" switch. Low-tier titles are grey *italic*, seen titles grey upright.
- `HoverState.id` is the STORY key (the row records the displayed article);
  `MigrationCounts.skippedCategories?` names the V1 category mutes that were not carried over.
- The keyboard layer, the shortcuts dialog, the hover card and the mute notice are ONE lazy chunk
  (`src/app/ShellInteractions.tsx`), loaded after the first commit; `AppShellProps.interactions`
  overrides it (tests). Shell time chips render on home and `#/new` only (`showsTimeChips`).
- `wireStores` takes `visibility`; `ReaderState.reimportV1` accepts an optional sources list.
- `src/main.tsx` does not import `features/export/kit/kit.css`: the briefing dialog chunk and every
  secondary `route.tsx` bring it (it is unlayered, so it must only style `.sp-page` / `.sp-dialog`).
- `MutesStore extends Store<MutesState>`; `MutesState extends MuteSet { pendingNames }` (V1 muted
  display names not yet mapped to a source id); `dropPendingName(name)`.
- `ReadStateStore.observe(el, id): void | (() => void)` (a ref callback may return the cleanup).
  `ReadStateStore.clear()` and `LastVisitStore.clear()` erase the read history and the last-visit
  record (Settings > "Erase all reader data").
- `SettingsStore.patch(partial)` — several settings in one write (section presets).
- `BackupService.previewJson(text): BackupPreview` — dry run of a restore
  (`{ ok: true; exportedAt; items: BackupPreviewItem[] } | { ok: false; error }`).
- `lastVisit: LastVisitStore` = `Store<{ previousMs: number | null }>` + `markAllSeen(nowMs)`
  (persisted; moves the cut-off forward only).
- `migration: MigrationReport { status: "migrated" | "already" | "nothing" | "failed"; imported:
  MigrationCounts; at? }` and `reimportV1(): MigrationReport` (Settings page).
- Keyboard row actions: `ROW_ACTION_EVENT = "aid:row-action"`, `ROW_ACTIONS = ["open", "bookmark",
  "later", "summary", "also", "mute"]`, `RowAction`, `RowActionDetail { id, action, el }` — dispatched
  by `src/keyboard` on the cursor row (`[data-aid]`), handled by the row; three-step delivery
  (event -> `[data-row-action]` click -> shell default) is documented in `src/keyboard/useKeyboardNav.ts`.
- `clock: Store<number>` ticks once a minute; read it with `useNow()`.
- Storage keys: `STORAGE_KEYS` / `CACHE_KEYS` (`aid2:`); `V1_STORAGE_KEYS` are read once, never written.
- Search (`shared/text.ts`): `matchesQuery(haystack, words, opts?)` never matches mid-word; words of
  `QUERY_WHOLE_WORD_MAX` (5) characters or fewer must be a whole word (plural / possessive allowed),
  longer words may be a prefix; `{ prefix: true }` allows prefixes for every word (type-ahead
  filters). `queryWordPattern(word, opts?)` is the one definition highlighters share.
- `index.html`: `vite.config.ts` injects the no-flash theme script (`src/state/themeBootstrap.ts`)
  and, in production builds, the CSP `<meta>` carrying its sha256. `base` comes from `SITE_BASE`.

## 6. Who exports what (integration contract for WP11)

| Provider | Consumer | Export names |
|---|---|---|
| WP1 `scripts/registry/index.ts` | WP2, WP11 | `SOURCES: readonly SourceDef[]`, `PUBLISHERS: readonly PublisherDef[]`, `REGISTRY: Registry`, `sourceById(id)`, `idForLegacyName(name)`, `validateRegistry`, `registryStats` (`publisherById` / `publisherForHost` are still exported but used by tests only) |
| WP2 `scripts/pipeline/ingest/index.ts` | WP11 | `ingest: Ingest` |
| WP3 `scripts/pipeline/normalize/index.ts`, `relevance/index.ts` | WP11 | `normalize: Normalize`, `filterRelevance: FilterRelevance`, `rescueCorroboration` |
| WP4 `scripts/pipeline/cluster/index.ts`, `score/index.ts` | WP11 | `cluster: Cluster`, `score: Score` |
| WP5 `scripts/pipeline/route/index.ts` | WP11 | `route: Route` |
| WP6 `scripts/pipeline/emit/*`, `enrich/*`, `state/store.ts` | WP11 | `emit: Emit`, `writeBundle: WriteBundle`, `makeBrief: MakeBrief`, `fetchStocks: FetchStocks`, `loadState: LoadState`, `nextState: NextState` |
| WP7 `src/data/*`, `src/state/*` | WP11 | `createEditionStore`, `createSourcesStore`, `createReaderState` (saved, mutes, readState, settings, watchlist, backup, lastVisit, migration), `browserEnv`, `wireStores`, `migrateV1`, `THEME_BOOTSTRAP_SCRIPT` |
| WP8 `src/app/*`, `src/keyboard/*` | WP11 | `AppShell`, `createHashRouter(): Router`, `createHoverStore()`, `createFocusStore()`, `createClock()`, `parseRoute`, `formatRoute` |
| WP9 `src/features/headline`, `src/features/home` | WP11 | `HeadlineRow` (for `UiSlots`), `home` `RouteModule` (default export of `route.tsx`) |
| WP10 `src/features/{section,search,new,watch,saved,sources,settings,about}` | — | one `RouteModule` each (default export of `route.tsx`) |

`test/boundaries.test.ts` enforces: `src` never imports `scripts/` or node built-ins; `shared`
imports only `shared`; a pipeline stage directory never imports a sibling stage; the registry never
imports the pipeline; build code never imports client code. (The package boundaries inside `src/`
ended at cutover: features may import each other. Node tests cannot import `.css`, so anything a
node test evaluates imports component files, not `route.tsx`.)

## 7. Fixtures and test helpers

| Path | Contents |
|---|---|
| `test/fixtures/v1/2026-11-19/` | V1 production payload of 20:08Z: `headlines.json`, `headlines-preview.json`, `brief.json`, `stocks.json`, `feed.xml` |
| `test/fixtures/v1/sources-v1.json` | V1's 203 feeds + 4 scrapers (name, url, category, priority, type) |
| `test/fixtures/v2/*.json` | **A frozen live build** (today: 2026-11-20T05:16Z, 322 stories, 413 sources; 662 KB in 8 files, no `state.json`), written by `npm run fixture:refresh` and never edited by hand (§12) |
| `test/fixtures/v2.manifest.json` | Provenance of the fixture: build id, sha256 / size of every file, which files differ from the build's and why, the synthetic health rows |
| `test/fixtures/bridged-2026-11-19/` | `front.json` + `rest.json` of the edition bridged from the 2026-11-19 V1 payload (the fixture until the final round). Frozen: it belongs to the corpus and registry of the same day, and the route regression tests pin its headlines on purpose |
| `test/fixtures/items-2026-11-19.json` | 2,297 items of a full live fetch (RawItem + `sourceName` + `v1{id,category,priority,publishedAt}`) |
| `test/fixtures/registry-2026-11-19.json` | `SourceDef[]` + `PublisherDef[]` matching the corpus (ids = `slugify(V1 name)`; NOT WP1's registry) |
| `test/fixtures/feeds/` | 10 raw feed bodies + `index.json` |

| Helper | Use |
|---|---|
| `test/helpers/factories.ts` | `makeArticle`, `makeEdition`, `makeRiver`, `makeSource`, `makeRegistry`, `makeItem`, `makeNormalized`, `makeStory`, `makeScoredStory`, `FIXTURE_NOW_MS` (pure) |
| `test/helpers/fixtureData.ts` | `fixtureFront` … `fixtureStatus`, `fixtureBundle`, `fixtureEdition()`, and the selectors `fixtureStory(case)`, `fixtureSource(case)`, `fixtureSourceInfo(id)`, `fixtureHealthRow(id)`, `fixtureCases` (pure, JSON imports) |
| `test/helpers/fixtureCases.ts` | What the fixture must contain and how tests find it: `fixtureCasesOf`, `missingFixtureCases`, `storyWhere` / `storiesWhere`, `titleWords`, `commonTitleWord`, `homepageTitles`, `ABSENT_WORD` (pure) |
| `test/helpers/fakeServices.ts` | `createFakeServices(opts)` — in-memory `AppServices` on the fixture (pure) |
| `test/helpers/fixtures.ts` | node-only loaders: `loadRawItems`, `loadCorpus`, `loadFixtureRegistry`, `loadV1Sources`, `loadBridgedEdition`, `loadBridgedFiles`, `registryOfSourcesFile` (the registry a fixture was built from, read back from its `sources.json`), `feedFixtures`, `readFeedFixture`, `feedFixtureResponse`, `fakeFetch` |
| `test/helpers/invariants.ts` | `assertValidBundle(bundle)`, `bundleProblems(bundle)` (guards + invariants) |

## 8. Commands

| Command | What |
|---|---|
| `npx tsc -b` (= `npm run typecheck`) | all four projects: shared (purity), app, node, test |
| `npm test` | every `*.test.ts` under `shared/ scripts/ src/ test/` (`tsx --tsconfig tsconfig.app.json --test`: the flag gives `.tsx` files the automatic JSX runtime under node) |
| `npx tsx --tsconfig tsconfig.app.json --test path/to/file.test.ts` | a single test file |
| `npm run build:data` | `scripts/pipeline/run.ts`: fetch every source, write `public/data/v2/*`, `public/feed.xml`, `public/feeds.opml` |
| `npm run build:check` | `scripts/tools/check-data.ts`: the publish gate (guards, invariants, freshness with `BUILD_STARTED_AT`, sizes, XML); `--write-status` records the verdict in status.json |
| `npm run data:fixture [-- --to <dir>]` | install the fixture: the 8 files of `test/fixtures/v2/` → `public/data/v2/`, after checking each against the manifest (run the site without the network) |
| `npm run fixture:refresh [-- --dry-run \| --from <dir> \| --river-rows <n> \| --no-health-cases]` | freeze the last build (`public/data/v2/` + `public/feed.xml` + `public/feeds.opml`) as the fixture; refuses a build the gate holds, one with an AI-written brief, or one without a case tests select (§12) |
| `npm run explain -- <id \| url \| words> [--mute <source-id,...>]` | why a story is where it is / why an item was dropped (last build): score parts with the age fade, regulator term, cap rescue, section focus, TOP hold / folded follow-ups, and what a reader sees when the lead's source is muted |
| `npm run compare [-- --v1 <headlines.json>]` | V1 payload vs the V2 data set: overlap, lead, top stories, drops by reason |
| `npm run validate:feeds` | every registry source with the build's own client and parsers |
| `npm run check:links [-- --data]` | registry + docs URLs (and article URLs of the river). `docs/archive/**` is its own group: requested and reported, never counted as broken |
| `npm run sbom [-- --check]` | regenerate `docs/SBOM.json` (CycloneDX 1.6) and the marked tables of `docs/SBOM.md` from the lockfile, the installed packages and the workflows; `--check` exits 1 when the file is not current |
| `npm run docs:sources [-- --report <verdicts.json> \| --health <file> \| --out <file>]` | regenerate `docs/SOURCES.md` from the registry and the last build's `health.json` |
| `.github/workflows/ci.yml` | pull-request checks (typecheck, tests, site build; read-only token, no secrets) - `refresh.yml` builds and deploys, `feed-audit.yml` audits the registry |
| `npm run dev -- --port 5180 --strictPort` | dev server at `http://localhost:5180/ai-drudge-v2/` |
| `npm run build` | `tsc -b && vite build` → `dist/` (base from `SITE_BASE`, default `/ai-drudge-v2/`) |

tsconfig projects: `tsconfig.shared.json` (shared, no tests), `tsconfig.app.json` (src + shared, no
tests, DOM, `vite/client`), `tsconfig.node.json` (scripts + shared + test + `vite.config.ts`, node
types, **no DOM**), `tsconfig.test.json` (`src/**/*.test.ts(x)` + `test/helpers/fakeServices*`, DOM + node).

## 9. Contract changes made at cutover (2026-11-19)

Adopted (the requesting package's local adapter was removed):

| Request | Change |
|---|---|
| WP1-1 | `SourceDef.maxKept` (registry `keep` / `KEEP_CAPS` / `keepCapFor` removed; relevance reads the resolved source) |
| WP1-2, WP5-4 | explicit `maxAgeDays` travels on `NormalizedItem` and extends the section hard window |
| WP1-4, WP3-4 | `SourceDef.titleTemplate` (FINRA Notices, Hugging Face JSON sources, Ollama library) |
| WP1-5 | scraper reads card titles for call-to-action links (already in ingest); Noma Security + Noma Labs un-paused |
| WP2-1 | `LastGood.etag / lastModified / bodyAt` (`LastGoodEntry` removed) |
| WP2-2, WP3-1, WP5-2, WP5-3 | documented on `NextState`, `NormalizedItem.firstSeenAt`, `Placements.top` (behaviour was already in place) |
| WP2-3 | `ScrapeConfig` comments say what ingest honours; unused `ScrapeConfig.parser` removed |
| WP3-2 | `SourceDef.releaseLine` (`MAIN_LINE_COMPONENTS` removed) |
| WP5-1 | `RouteCut` adds `limit`, `policy`, `moved` |
| WP6-1 | `PipelineState.lastSeenDay` (`StoredState` removed) |
| WP6-2 | `StatusFile.gate.failures` (the `"FAIL: "` prefix convention removed) |
| WP7-1..6, WP10-1..4 | `EditionState.restStatus`, `BackupService.previewJson`, `ReadStateStore.observe` return type, `SettingsStore.patch`, `MutesState.pendingNames` + `dropPendingName`, `AppServices.migration` + `reimportV1`, `LastVisitStore.markAllSeen` (all feature-detection removed) |
| WP8-1 / WP9 | JSX runtime for node tests: `npm test` passes `--tsconfig tsconfig.app.json` (a `jsx` option on the solution-style root config is not applied by tsx); every per-file pragma / `import * as React` workaround removed |
| WP8-2 | `ROW_ACTION_EVENT`, `ROW_ACTIONS`, `RowAction`, `RowActionDetail` live in `src/app/services.ts` |
| WP10-6 | `BriefingExportButton` mounted in the masthead; `HoverCard` mounted once in the shell |
| WP10-7 | `matchesQuery` no longer matches mid-word (see §5) |

Rejected:

| Request | Reason |
|---|---|
| WP1-3 `status: "probation"`, `fallbackUrls` | the `probation` / `fallback` tag convention already reaches the gate and the Sources page; a third status and URL fallbacks would touch ingest, emit and the client for no new behaviour |
| WP3-5 wider `TRACKING_PARAM` | changes `canonicalUrl` for URLs V1 already emitted, so ids (bookmarks, read state) would no longer match - two tests pin that identity |
| WP8-3 app version via `define` | the constant in `src/features/chrome/version.ts` is pinned to package.json by a test and works under node |
| WP8-4 `*.test.tsx` glob | convention stays `*.test.ts` with `createElement` |
| WP10-5 search-term prop on `HeadlineRow` | the CSS Custom Highlight API painter covers it without a contract change |

Decided at cutover and recorded here:

- V1's stale dim (> 72 h) is not carried into V2. `HeadlineRow` emits no `is-stale` class; the age
  label carries the information, and sections with a 14-21 day window would otherwise be mostly
  grey. `shared/time.ts isStale` stays exported but the row no longer uses it. Seen-dimming applies
  to default and compact rows only - never to the lead, TOP STORIES or the saved lists.

## 10. Changes of the fix round (2026-11-20)

| Area | Change |
|---|---|
| `shared/select.ts` | `visibleStory`, `StoryView.key`; mutes re-lead a story instead of removing it; search no longer matches section short codes; muted articles are not searched |
| `shared/contract.ts` | `BriefFile.fallbackReason?`, `StatusFile.brief.reason?`; members carry no `summary`; TOP STORIES comment (ranked by score) |
| `scripts/pipeline/types.ts` | `NormalizedItem.outletHost?`, `RelevanceOutput.passed?` |
| `scripts/pipeline/run.ts` | `rescueCorroboration` composed into `processItems`; `STATE_FILE` in a directory that does not exist yet no longer fails the build after the edition was written |
| `scripts/pipeline/emit/river.ts` | `rejectedThisRun` - rows the current rules reject leave the river memory |
| `scripts/pipeline/score` | `SCORE.importance.regulatorNotice` |
| `scripts/pipeline/normalize` | pointer-only twins never primary; `stripSlugEcho` ("Google: Gemini 4 Neon (google/gemini-4-neon)") |
| `scripts/pipeline/context.ts` | `neutraliseWorkflowCommands`: a log line cannot start a GitHub Actions `::command` |
| `scripts/registry` | `MAX_SOURCE_AGE_DAYS`; Techmeme attributed by link host; `low-cadence` honoured by the feed audit |
| `src/app/services.ts` | `Settings.shortcuts`, `STALE_BANNER_HOURS` 6 -> 2, `ReadStateStore.clear()`, `LastVisitStore.clear()`, doc comments of `EditionState.error` and `LastVisitStore` |
| renamed | `src/features/export/kit/ssr.ts` -> `ssr.testkit.ts`, `scripts/pipeline/cluster/corpusAdapter.ts` -> `corpusAdapter.testkit.ts` (test support only); `sameSet` deleted |
| `package.json` | `engines.node >= 22.15.0` (the route-loading tests need `module.registerHooks`) |

## 11. Final round (2026-11-20, third pass)

Contract changes. Everything new is optional or defaulted; a consumer written against §10 still works.

| Area | Change |
|---|---|
| `shared/contract.ts` | `StatusFile.brief.failStreak?`; `ClusterV2` member order documented (see §3); `ArticleV2.w` 0 = tier-4 lead with fewer than 2 publishers; `FeedErrorClass "skipped"` and `FeedStatus "carried"` also cover host backoff |
| `shared/select.ts` | `storyPassesTimeFilter`, `storyNewestMs`; `parseSearch`, `sectionNamed`, `sectionsNamed`, `searchMatchOf`; `SearchGroup { rows, nameOnly, matches }`; `searchRiver` returns `{ rows, nameOnly }`; `visibleStory` recounts publishers from the member order |
| `shared/sections.ts` | MODELS window 3 / 6 -> **5 / 10 days** (departs from the V2_PLAN table; a 4-day-old frontier release was unlisted) |
| `scripts/registry/types.ts` | `SourceDef.outlets?`, `.includeIn?`, `.fetch?` (`SourceFetchPolicy`); `JsonApiConfig` allows `urlField` + `urlTemplate` together (§4.1) |
| `scripts/registry/outlets.ts` | `OUTLET_DENY` (10 hosts, evidence recorded), `UNVETTED_PUBLISHER_IDS`, `UNVETTED_OUTLET_TAG`, `deniedOutlet`, `isVettedPublisher` |
| `scripts/registry/sources` | the eleven `hn-*` searches (+ `hn-local-stack`) are kind `json` on the official HN Algolia API (hnrss.org answered 502 to 4-7 of them per build); 7 local-runtime release feeds carry `routeTo ["open_local"]` |
| `scripts/pipeline/types.ts` | `PipelineState.top?: TopMemory[]`, `.briefFailStreak?`; `Placements.topRelated?`, `.topHeld?`; `RouteTrace.focus?`; `NormalizedItem.tags` may carry the item tag `unvetted-outlet` |
| `scripts/pipeline/ingest` | `HostBackoff` / `IngestOptions.hostBackoffAfter`, `fetchPolicyFor`, `sourceRequest(source, plan, { single })`, `HttpRequest.timeoutRetries`; `extractJsonApi` template fallback |
| `scripts/pipeline/run.ts` | `Processed.rescued`; `buildExplain(placements, dropped, ctx, notes)`; `state.briefFailStreak` written |
| `scripts/pipeline/emit` | `QualityReport.alerts`, `GATE.briefAlertStreak` (6), `nextBriefFailStreak`; `ExplainStory.topHeld? / topRelated? / foldedUnder? / regulatorNotice?`, `ExplainItem.sourceId? / rescued?` |
| `scripts/tools` | `GateResult.alerts` (`check-data`), `gen-sources-doc.ts`, link report `totals.archiveOnly`, `generate-sbom.ts` (`buildBom`, `--check`) |
| `scripts/pipeline/context.ts` | `PIPELINE.staleAfterMinutes` 90 -> **120** (reader-facing now, see §5) |
| `src/app/services.ts` | `EditionState.staleAfterMinutes? / retrying?`, `PersistenceState`, `AppServices.persistence?`, `Settings.dimSeen` (required, default true), `MigrationCounts.skippedCategories?`; `STALE_BANNER_HOURS` is the fallback only |
| `test/helpers/fakeServices.ts` | options `staleAfterMinutes`, `writeRefused`; `services.persistence`, `stores.persistence` |

Behaviour the types do not show:

- **Outlet quality control** (link-host sources with `outlets: "vetted"`, the default). An item
  whose outlet no registry publisher vouches for is emitted at tier 4, `leadEligible: false`,
  `countsForCoverage: false` and tagged `unvetted-outlet`, whatever its source says; a same-URL copy
  from an `open` source or from the publisher's own feed lifts it. Denied outlets are dropped by
  relevance as `excluded` (by article host, by the outlet host of an unresolved wrapper, by outlet
  name). The per-source cap fills with known outlets first and `rescueCorroboration` never rescues
  an unvetted item. Route: a story LED by an unvetted item never takes a homepage row while any
  other row of the section could (`isUnvettedLed`; it is the last resort of the starvation fill and
  stays in the full list). Adding a publisher entry is how an outlet is vouched for.
- **Hacker News threads.** An HN text post has no article URL; it is linked to its thread
  (`urlTemplate` fallback) and normalize flags any item whose URL is an HN thread `discussion`,
  whatever kind of source listed it (it never leads a story another outlet covers).
- **Cluster.** Distinct-product veto (`similarity.ts distinctProducts`: two sides about different
  versioned products with the same version under different names never merge - "Genie 4" out of
  "Gemini 4 Neon"); corroborated second pass (`corroborated`: a pair under the cosine bar merges
  at ≥ 0.29 within 24 h across origins when the headlines share an ordinary word no other document
  of the run uses). Both fail safe; each was calibrated on a handful of live examples.
- **TOP STORIES.** *Running story* (`route/running.ts`, `ROUTE_POLICY.runningStory`): a follow-up of
  a story already chosen takes a slot only with 5+ publishers of its own and one running story
  holds at most 2 slots; folded follow-ups keep their section rows and are listed in
  `Placements.topRelated` (not published in front.json). *Hold* (`ROUTE_POLICY.topHold`,
  `PipelineState.top`): a story of the previous build's TOP that no longer qualifies keeps its slot
  for up to 2 h unless the newcomer scores ≥ 5 points above the score it last qualified with - so
  TOP may list a ONE-publisher story for up to 2 h (`Placements.topHeld`).
- **Homepage rows** (`route/homepage.ts`). *Regulator floor* (`ROUTE_POLICY.regulatorFloor`): in
  POLICY, a first-party notice (source tags `regulator` + `first-party`) of finra, sec, occ, fca,
  bank-of-england, iosco, fsb or cftc is guaranteed a homepage row for 72 h (+12 h for a date-only
  stamp), one regulator at a time before anyone's second, at most 4 guaranteed rows; ANY regulator
  feed holds at most 2 POLICY homepage rows. `nist` and `cisa` are in the list but inert: their
  feeds are not tagged `regulator` (a route test pins both facts - tagging one switches the floor
  and the score term on). *Cross-listings* (`crossListOnlyHomes`): a story homed in AI SECURITY
  never takes a homepage row of another section. *Release rows* (`releaseRows`): LOCAL & OPEN MODELS
  keeps up to 2 routed-in release lines on its homepage although RELEASE RADAR shows them, never in
  its first 3 rows. *Section focus* (`SECTION_FOCUS`, `route/focus.ts`): LOCAL orders its own list
  by score + up to 20 (runtime / quantization / open-weight release; +14 local hardware) - a
  section's rows are therefore NOT guaranteed to be in score order; the story score and TOP are
  unchanged and `RouteTrace.focus` says why.
- **Score.** `weightOf`: w = 0 only for a tier-4 lead with fewer than 2 publishers.
- **Ingest.** Per-source fetch policy comes from `SourceDef.fetch` (one use: Washington Post, one
  16 s attempt); `SOURCE_FETCH_OVERRIDES` (by id) is empty and kept for policies that must not live
  in the registry. Host backoff: after two requests in a row to one host end in 5xx / 429, the
  host's remaining sources are not asked this run and are carried forward (health `carried`, error
  `skipped`, fail streak untouched); a source with nothing to carry is still asked once; sources
  that failed last run are queued after healthy ones. Output stays in registry order.
- **Brief failure alert.** Six consecutive keyed builds with a failed Claude brief put an alert
  first in `gate.warnings` (never a failure) and `refresh.yml` keeps the rolling issue "V2 Daily
  Brief failing". Without a key nothing is raised.
- **State hand-over.** `refresh.yml` restores `state.json` from the `data` branch first (a copy on
  the live site is the fallback and wins when strictly newer), removes it from `dist/` before the
  Pages upload unless `V2_PUBLISH_STATE=true`, and reports a build that found no state while the
  site is up (`state_lost`). The `data` branch must stay force-pushable by `github-actions[bot]`.

Requests not adopted in this round:

| Request | Reason |
|---|---|
| `EditionFront.topRelated` ("Related:" under a TOP row) | no consumer exists and none could be verified in a browser this round; the field would add bytes to the first-paint file and three guard / invariant changes for data nothing renders. `Placements.topRelated` and the explain tool carry it |
| `routeTo ["open_local"]` on `hf-unsloth-gguf` | the source is kind `json` without the `release` flag, so route's two-row release cap and the hold-back would not apply to its four items per build |
| Asynchronous `AppServices.backup` (bundle) | saves about 0.9 kB gzip of a 107.8 kB entry; the 85 kB target is not reachable while the React runtime alone is 67.5 kB |
| Search-box placeholder naming the operators | visual change that could not be checked on a phone-width header this round; the search page's own tips name them |
| `mlq.ai`, `marketbeat.com`, `fourweekmba.com`, `tradersunion.com` on the global deny list | their pages refuse automated readers, so the evidence the deny list requires could not be recorded; they stay on the per-source `excludeUrl` lists |

## 12. The committed fixture (final round, fixture migration)

`test/fixtures/v2/` is the data set tests run on and `npm run data:fixture` installs. Until the
final round it was the V1 payload of 2026-11-19 bridged to the V2 schema; it is now a **frozen live
build**, and replacing it is one command.

Refresh procedure:

| # | Command | Result |
|---|---|---|
| 1 | `env -u ANTHROPIC_API_KEY npm run build:data` | a build without a key (network; skip when `public/data/v2/` already holds the build to freeze) |
| 2 | `npm run fixture:refresh` | `test/fixtures/v2/*.json` + `test/fixtures/v2.manifest.json` rewritten; exit 1 and nothing written when the build is refused (`-- --dry-run` reports only) |
| 3 | `npx tsc -b && npm test` | tests select fixture rows by property, so this is green unless the new day's data has a shape no test met before |

What `fixture:refresh` does (`scripts/tools/fixture-refresh.ts`; deterministic - the same build gives the same bytes, and a test proves the committed fixture is a fixed point of the tool):

1. Reads the eight public JSON files. `state.json` is never copied.
2. Runs the data gate on the build (clock = the build's `generatedAt`). Refused: a build the gate
   holds; a build whose brief is not the keyless fallback (model output is not committed, and tests
   build Claude briefs themselves).
3. Trims `river.json` to 1,500 rows (`--river-rows`): rows of edition articles always stay, the rest
   is cut from the old end. A no-op for the builds of 2026-11-20 (1,086 rows in the committed fixture).
4. **Health cases.** A healthy build has no carried / failing / quarantined source, and page tests
   need all of them. Each state the build lacks is written onto one `probation` source (registry
   order; a failing / quarantined case only on a source without an article in the edition), in the
   shape ingest writes: carried after `HTTP 403`, carried by host backoff, failing by timeout,
   quarantined. `front.counts.feedsOk` and `status.feeds` are recomputed (`statusFeeds`,
   `emit/status.ts`). **These rows are synthetic**; the manifest lists them (`healthCases`: `chinai`,
   `concordia-ai-safety-china`, `clouded-judgement` today - the carried case is a real row of that build, an arXiv listing that answered 429) and `--no-health-cases`
   turns the step off (the refresh then fails on the missing cases).
5. Sets `status.run.trigger` to `fixture` and records the gate verdict of the fixture in `status.gate`.
6. Checks the result: guards, invariants, the gate again, and the cases of
   `test/helpers/fixtureCases.ts` (a paywalled homepage row, `w` 3 / 2 / 0, a newsletter row, a
   regulator's notice in POLICY, a multi-publisher lead another outlet can re-lead, a release line, a
   thread, a link-host outlet, a cross-listed story, every health state, a paused source).
7. Writes the files and the manifest. A file no step touched is the build's file byte for byte
   (today: `rest`, `river`, `sources`, `brief`, `stocks`); `front`, `health` and `status` differ only
   by the health cases and the trigger.

Rules for tests:

- **Never pin an id, a headline, a source or a count of the fixture.** Select by property
  (`fixtureStory("paywalledRow")`, `fixtureSource("carried")`, `storyWhere(...)`,
  `commonTitleWord(...)`) and derive the expected value from the same files. Thresholds are derived
  the same way (`quality.test.ts`, `check-data.test.ts`: `MASS`, `WARN` from the fixture's own feed tiers).
- A case a test needs belongs in `fixtureCases.ts`: `test/fixtures.test.ts` asserts the committed
  fixture has it and the refresh tool refuses a build without it, so a refresh cannot remove a
  case silently.
- Tests that need the registry a fixture was built from use `registryOfSourcesFile(fixtureSources)`,
  not the live registry (which moves on after the freeze).
- Pinned on purpose, and frozen: `test/fixtures/bridged-2026-11-19/` (route regression tests on that
  day's editorial defects), `items-2026-11-19.json`, `registry-2026-11-19.json`, `test/fixtures/v1/`.
- `feed.xml` and `feeds.opml` are not part of the fixture: `npm run build:check` after
  `npm run data:fixture` on a fresh clone reports both missing (CI does not run the gate on the fixture).

## 13. Closing round (2026-11-20, after the final audit)

Contract changes. Everything new is optional or defaulted.

| Area | Change |
|---|---|
| `scripts/pipeline/context.ts` | `PIPELINE.topRecencyCap` (40), `PIPELINE.topRecencyCapBelowPublishers` (3), `topStanding(story)` - what a story counts for in TOP STORIES |
| `scripts/pipeline/types.ts` | `TopMemory.score` now holds `topStanding`, not the raw score (state written before this round holds raw scores: a one-time bias of at most 10 points towards an incumbent, for the 2 h a hold lasts) |
| `scripts/pipeline/cluster/similarity.ts` | `ClusterParams.subjectVeto`, `.ubiquitousShare`, `.ubiquitousMinDocs`, `.ubiquitousSharedUnits`; `Doc.docs` / `Profile.docs`; `distinctSubjects`, `sharesOnlyUbiquitous`, `isRegionToken`, `isContextToken`, `RIVAL_SUBJECTS`, `REGION_TOKENS`; inquiry words are `EVENT_TYPE_WORDS` |
| `scripts/pipeline/relevance/index.ts` | `BIG_STORY_PUBLISHERS` (6); `CappedRelevanceOutput.ownCap`; `rescueCorroboration` reads `out.ownCap` |
| `scripts/pipeline/route/rules.ts` | `FocusRule.not`; `SECTION_FOCUS.policy`, `.ai_security`; rule `ai_security/outages`; `ROUTE_POLICY.subjectCap` 6 publishers / 3 rows -> **5 / 2** |
| `scripts/pipeline/route/homepage.ts` | `isLowSignal`, `releaseProject` |
| `scripts/pipeline/run.ts` | `cliExit`, `USAGE`: the build refuses any command-line argument |
| `scripts/tools` | `validate-feeds.ts` / `check-links.ts` `checkArgs`, `USAGE`; `report-feed-audit.ts` `lookupArgs`, `findAuditIssue`, `lookupFailureIsFatal`; `GateOptions.siteUrl` (`check-data.ts`) |
| `shared/select.ts` | `sourceValueMatches`, `SOURCE_WHOLE_WORD_MAX` (3) |
| `shared/text.ts` | `queryWordPattern`: a short word ending in a letter may be followed by a version ("qwen" finds "Qwen4-Max") |
| `src/app/ErrorBoundary.tsx` | `ErrorBoundaryProps.onRetry?` |
| `src/app/presets.ts` | Local LLM watch preset: `Qwen*`, `Gemma*` |
| `src/features/headline` | `AlsoLineProps.counted?`, `alsoSplit`, `alsoButtonLabel`; `briefing.ts` `splitAlso` |
| `src/state/migrateV1.ts` | `parseCounts` (the stored marker is validated field by field) |
| registry | tag `owner-stack` removed (docs/SECURITY.md §2.5) |

Behaviour the types do not show:

- **Cluster.** Three more merge vetoes, each fail-safe (they only ever keep two stories apart):
  *distinct subjects* - each side's headlines name a company of `RIVAL_SUBJECTS` that the other side
  never mentions; *regions are context* - a continent ("Europe") is no more a shared unit than a
  date; *entity-only* - every shared title token is an event-type word, an amount, a date, a region
  or a name carried by more than 3 % of the run's documents (and at least 40), and the headlines
  share fewer than 3 units. The last one is what turns a week-long saga held together by a
  company's and a person's name into its separate events; an established story (6 publishers) is
  exempt.
- **TOP STORIES** rank on `topStanding`: the score, with recency capped at 40 points while fewer
  than 3 publishers cover the story. Section lists and the score itself are unchanged. The client
  heading reads "ranked by coverage and freshness".
- **Per-source cap.** A kept item that belongs to a story of 6+ publishers does not count against
  its source's default cap; the source's next-best over-cap items take those slots (never for a
  source with its own `maxKept`, never an unvetted item). `Processed.rescued` lists them too.
- **Homepage rows.** In TOPIC-mode sections a *low-signal* row (weight 0, or led by a forum
  thread) is a last resort like an unvetted-led row, ahead of it in the fill order; a routed-in
  release line waits below the cut when a news row in the section's upper ranks names its project
  within 24 h. POLICY and AI SECURITY now order their lists by score + focus (`RouteTrace.focus`
  says why), as LOCAL already did.
- **"Also:" line and outlet count.** `ClusterV2.publishers` stays the badge. The line lists the
  counted outlets first and the outlets that only link the story after the label "also linked:"; a
  row whose story has members but one counted publisher shows an "also" button instead of "+N".
- **Search.** `source:` values of up to 3 characters are whole words ("source:sec" no longer finds
  every "Security" source); longer values are prefixes as before.
- **Feed audit.** The rolling "Feed audit:" issue is looked up by bot author, and a failed lookup
  fails the step in GitHub Actions.

