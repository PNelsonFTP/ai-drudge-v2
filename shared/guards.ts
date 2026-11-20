// Hand-written runtime guards for every v2 data file (no zod - the payload is produced by our own
// build). Used by the client on network AND cached data, by emit tests, and by the check-data gate.
//
// Each file has a `validateX(x): string | null` (null = valid, else the FIRST problem with a path)
// and an `isX(x): x is X` type guard built on it. Guards are STRUCTURAL (shapes, enums, ISO dates,
// http(s) URLs, record key === article id). Cross-reference integrity (every row id resolves, front
// rows are a prefix of rest rows, ...) lives in shared/invariants.ts.
//
// Forward compatibility: unknown extra fields are accepted; unknown article flags, source kinds and
// feed error classes are accepted as long as they are strings. `schemaVersion` must equal
// SCHEMA_VERSION exactly - use isNewerSchema() to show a "new version - reload" banner.

import {
  FEED_STATUSES,
  RIVER_DAYS,
  SCHEMA_VERSION,
  STATUS_SCHEMA,
  type BriefFile,
  type EditionFront,
  type EditionRest,
  type HealthFile,
  type RiverFile,
  type SourcesFile,
  type StatusFile,
  type StocksFile,
} from "./contract";
import { isSectionId } from "./sections";
import { isHttpUrl } from "./url";

type Obj = Record<string, unknown>;
type Check = string | null;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isCount = (x: unknown): x is number => isNum(x) && x >= 0 && Number.isInteger(x);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isIso = (x: unknown): x is string => isStr(x) && x.length >= 10 && !Number.isNaN(Date.parse(x));
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

function meta(x: Obj, at: string): Check {
  if (x.schemaVersion !== SCHEMA_VERSION) return `${at}.schemaVersion: expected ${SCHEMA_VERSION}, got ${String(x.schemaVersion)}`;
  if (!isStr(x.buildId) || !x.buildId) return `${at}.buildId: expected non-empty string`;
  if (!isIso(x.generatedAt)) return `${at}.generatedAt: expected ISO date`;
  return null;
}

function article(a: unknown, key: string, at: string): Check {
  if (!isObj(a)) return `${at}: expected object`;
  if (a.id !== key) return `${at}.id: expected "${key}"`;
  if (!isStr(a.url) || !isHttpUrl(a.url)) return `${at}.url: expected http(s) URL`;
  if (!isStr(a.title) || !a.title) return `${at}.title: expected non-empty string`;
  if (!isStr(a.src) || !a.src) return `${at}.src: expected source id`;
  if (a.via !== undefined && !isStrArr(a.via)) return `${at}.via: expected string[]`;
  if (a.pub !== undefined && !isStr(a.pub)) return `${at}.pub: expected string`;
  if (a.publishedAt !== null && !isIso(a.publishedAt)) return `${at}.publishedAt: expected ISO date or null`;
  if (!isIso(a.firstSeenAt)) return `${at}.firstSeenAt: expected ISO date`;
  if (a.summary !== undefined && !isStr(a.summary)) return `${at}.summary: expected string`;
  if (!isSectionId(a.home)) return `${at}.home: unknown section "${String(a.home)}"`;
  if (a.tier !== 1 && a.tier !== 2 && a.tier !== 3 && a.tier !== 4) return `${at}.tier: expected 1..4`;
  if (a.w !== undefined && a.w !== 0 && a.w !== 1 && a.w !== 2 && a.w !== 3) return `${at}.w: expected 0..3`;
  if (a.flags !== undefined && !isStrArr(a.flags)) return `${at}.flags: expected string[]`;
  return null;
}

function articles(x: unknown, at: string): Check {
  if (!isObj(x)) return `${at}: expected object`;
  for (const k of Object.keys(x)) {
    const p = article(x[k], k, `${at}.${k}`);
    if (p) return p;
  }
  return null;
}

function clusters(x: unknown, at: string): Check {
  if (!isObj(x)) return `${at}: expected object`;
  for (const k of Object.keys(x)) {
    const c = x[k];
    if (!isObj(c)) return `${at}.${k}: expected object`;
    if (!isStrArr(c.members)) return `${at}.${k}.members: expected string[]`;
    if (!isCount(c.publishers) || c.publishers < 1) return `${at}.${k}.publishers: expected integer >= 1`;
  }
  return null;
}

function sourceRefs(x: unknown, at: string): Check {
  if (!isObj(x)) return `${at}: expected object`;
  for (const k of Object.keys(x)) {
    const s = x[k];
    if (!isObj(s)) return `${at}.${k}: expected object`;
    if (!isStr(s.name) || !s.name) return `${at}.${k}.name: expected non-empty string`;
    if (!isStr(s.publisher)) return `${at}.${k}.publisher: expected string`;
    if (!isStr(s.kind)) return `${at}.${k}.kind: expected string`;
  }
  return null;
}

export function validateEditionFront(x: unknown): Check {
  if (!isObj(x)) return "front: expected object";
  const m = meta(x, "front");
  if (m) return m;
  if (x.leadId !== null && !isStr(x.leadId)) return "front.leadId: expected string or null";
  if (!isStrArr(x.top)) return "front.top: expected string[]";
  const c = x.counts;
  if (!isObj(c)) return "front.counts: expected object";
  for (const k of ["stories", "placements", "feedsOk", "feedsTotal"]) {
    if (!isCount(c[k])) return `front.counts.${k}: expected non-negative integer`;
  }
  if (!Array.isArray(x.sections)) return "front.sections: expected array";
  for (let i = 0; i < x.sections.length; i++) {
    const s: unknown = x.sections[i];
    const at = `front.sections[${i}]`;
    if (!isObj(s)) return `${at}: expected object`;
    if (!isSectionId(s.id)) return `${at}.id: unknown section "${String(s.id)}"`;
    if (!isStr(s.label)) return `${at}.label: expected string`;
    if (!isStrArr(s.rows)) return `${at}.rows: expected string[]`;
    if (!isCount(s.total)) return `${at}.total: expected non-negative integer`;
    if (!isCount(s.sourceCount)) return `${at}.sourceCount: expected non-negative integer`;
  }
  return articles(x.articles, "front.articles") ?? clusters(x.clusters, "front.clusters") ?? sourceRefs(x.sources, "front.sources");
}

export function validateEditionRest(x: unknown): Check {
  if (!isObj(x)) return "rest: expected object";
  const m = meta(x, "rest");
  if (m) return m;
  if (!Array.isArray(x.sections)) return "rest.sections: expected array";
  for (let i = 0; i < x.sections.length; i++) {
    const s: unknown = x.sections[i];
    const at = `rest.sections[${i}]`;
    if (!isObj(s)) return `${at}: expected object`;
    if (!isSectionId(s.id)) return `${at}.id: unknown section "${String(s.id)}"`;
    if (!isStrArr(s.rows)) return `${at}.rows: expected string[]`;
  }
  return articles(x.articles, "rest.articles") ?? clusters(x.clusters, "rest.clusters") ?? sourceRefs(x.sources, "rest.sources");
}

export function validateRiverFile(x: unknown): Check {
  if (!isObj(x)) return "river: expected object";
  const m = meta(x, "river");
  if (m) return m;
  if (x.days !== RIVER_DAYS) return `river.days: expected ${RIVER_DAYS}`;
  if (!isStrArr(x.sources)) return "river.sources: expected string[]";
  if (!isStrArr(x.sourceIds)) return "river.sourceIds: expected string[]";
  if (x.sourceIds.length !== x.sources.length) return "river.sourceIds: must be parallel to river.sources";
  if (!Array.isArray(x.rows)) return "river.rows: expected array";
  const nSources = x.sources.length;
  for (let i = 0; i < x.rows.length; i++) {
    const r: unknown = x.rows[i];
    const at = `river.rows[${i}]`;
    if (!Array.isArray(r) || r.length < 8) return `${at}: expected 8-tuple`;
    if (!isStr(r[0]) || !r[0]) return `${at}[0]: expected article id`;
    if (!isStr(r[1])) return `${at}[1]: expected title`;
    if (!isStr(r[2]) || !isHttpUrl(r[2])) return `${at}[2]: expected http(s) URL`;
    if (!isCount(r[3]) || r[3] >= nSources) return `${at}[3]: source index out of range`;
    if (!isSectionId(r[4])) return `${at}[4]: unknown section "${String(r[4])}"`;
    if (r[5] !== null && !isNum(r[5])) return `${at}[5]: expected publishedAt ms or null`;
    if (!isNum(r[6])) return `${at}[6]: expected firstSeenAt ms`;
    if (r[7] !== null && !isStr(r[7])) return `${at}[7]: expected lead id or null`;
  }
  return null;
}

export function validateHealthFile(x: unknown): Check {
  if (!isObj(x)) return "health: expected object";
  const m = meta(x, "health");
  if (m) return m;
  if (!Array.isArray(x.feeds)) return "health.feeds: expected array";
  for (let i = 0; i < x.feeds.length; i++) {
    const f: unknown = x.feeds[i];
    const at = `health.feeds[${i}]`;
    if (!isObj(f)) return `${at}: expected object`;
    if (!isStr(f.id) || !f.id) return `${at}.id: expected source id`;
    if (!isBool(f.ok)) return `${at}.ok: expected boolean`;
    if (!isStr(f.status) || !(FEED_STATUSES as readonly string[]).includes(f.status)) return `${at}.status: expected ${FEED_STATUSES.join("|")}`;
    if (f.ok !== (f.status === "ok")) return `${at}.ok: must equal (status === "ok")`;
    if (!isCount(f.count)) return `${at}.count: expected non-negative integer`;
    if (f.error !== undefined && !isStr(f.error)) return `${at}.error: expected string`;
    if (f.lastError !== undefined && !isStr(f.lastError)) return `${at}.lastError: expected string`;
    if (f.httpStatus !== undefined && !isNum(f.httpStatus)) return `${at}.httpStatus: expected number`;
    if (!isCount(f.failStreak)) return `${at}.failStreak: expected non-negative integer`;
    if (f.lastOkAt !== null && !isIso(f.lastOkAt)) return `${at}.lastOkAt: expected ISO date or null`;
    if (f.carried !== undefined && !isBool(f.carried)) return `${at}.carried: expected boolean`;
  }
  return null;
}

export function validateSourcesFile(x: unknown): Check {
  if (!isObj(x)) return "sources: expected object";
  const m = meta(x, "sources");
  if (m) return m;
  if (!Array.isArray(x.sources)) return "sources.sources: expected array";
  for (let i = 0; i < x.sources.length; i++) {
    const s: unknown = x.sources[i];
    const at = `sources.sources[${i}]`;
    if (!isObj(s)) return `${at}: expected object`;
    if (!isStr(s.id) || !s.id) return `${at}.id: expected source id`;
    if (!isStr(s.name) || !s.name) return `${at}.name: expected non-empty string`;
    if (!isStr(s.publisher)) return `${at}.publisher: expected string`;
    if (!isStr(s.publisherId)) return `${at}.publisherId: expected string`;
    if (!isStr(s.kind)) return `${at}.kind: expected string`;
    if (!isSectionId(s.home)) return `${at}.home: unknown section "${String(s.home)}"`;
    if (s.tier !== 1 && s.tier !== 2 && s.tier !== 3 && s.tier !== 4) return `${at}.tier: expected 1..4`;
    if (s.scope !== "ai" && s.scope !== "general") return `${at}.scope: expected "ai"|"general"`;
    if (s.homepage !== undefined && !isHttpUrl(s.homepage as string)) return `${at}.homepage: expected http(s) URL`;
    if (s.feedUrl !== undefined && !isHttpUrl(s.feedUrl as string)) return `${at}.feedUrl: expected http(s) URL`;
    if (s.tags !== undefined && !isStrArr(s.tags)) return `${at}.tags: expected string[]`;
    if (s.aliases !== undefined && !isStrArr(s.aliases)) return `${at}.aliases: expected string[]`;
    if (s.paused !== undefined && !isBool(s.paused)) return `${at}.paused: expected boolean`;
  }
  return null;
}

export function validateBriefFile(x: unknown): Check {
  if (!isObj(x)) return "brief: expected object";
  const m = meta(x, "brief");
  if (m) return m;
  if (x.source !== "claude" && x.source !== "fallback") return 'brief.source: expected "claude"|"fallback"';
  if (!isStr(x.headline)) return "brief.headline: expected string";
  if (!isStrArr(x.bullets)) return "brief.bullets: expected string[]";
  if (!Array.isArray(x.cited)) return "brief.cited: expected array";
  for (let i = 0; i < x.cited.length; i++) {
    const c: unknown = x.cited[i];
    const at = `brief.cited[${i}]`;
    if (!isObj(c)) return `${at}: expected object`;
    if (!isStr(c.title)) return `${at}.title: expected string`;
    if (!isStr(c.url) || !isHttpUrl(c.url)) return `${at}.url: expected http(s) URL`;
    if (!isStr(c.source)) return `${at}.source: expected string`;
  }
  if (x.model !== undefined && !isStr(x.model)) return "brief.model: expected string";
  if (x.fallbackReason !== undefined && !isStr(x.fallbackReason)) return "brief.fallbackReason: expected string";
  return null;
}

export function validateStocksFile(x: unknown): Check {
  if (!isObj(x)) return "stocks: expected object";
  const m = meta(x, "stocks");
  if (m) return m;
  if (x.asOf !== null && !isIso(x.asOf)) return "stocks.asOf: expected ISO date or null";
  if (x.marketState !== undefined && x.marketState !== "open" && x.marketState !== "closed") return 'stocks.marketState: expected "open"|"closed"';
  if (!isStrArr(x.order)) return "stocks.order: expected string[]";
  if (!isObj(x.quotes)) return "stocks.quotes: expected object";
  for (const sym of Object.keys(x.quotes)) {
    const q = x.quotes[sym];
    const at = `stocks.quotes.${sym}`;
    if (!isObj(q)) return `${at}: expected object`;
    if (q.price !== null && !isNum(q.price)) return `${at}.price: expected number or null`;
    if (q.changePct !== null && !isNum(q.changePct)) return `${at}.changePct: expected number or null`;
    if (!isIso(q.fetchedAt)) return `${at}.fetchedAt: expected ISO date`;
    if (q.asOf !== undefined && !isIso(q.asOf)) return `${at}.asOf: expected ISO date`;
  }
  for (const sym of x.order) {
    if (!Object.prototype.hasOwnProperty.call(x.quotes, sym)) return `stocks.order: "${sym}" has no quote`;
  }
  return null;
}

export function validateStatusFile(x: unknown): Check {
  if (!isObj(x)) return "status: expected object";
  if (x.schema !== STATUS_SCHEMA) return `status.schema: expected ${STATUS_SCHEMA}`;
  if (!isStr(x.buildId) || !x.buildId) return "status.buildId: expected non-empty string";
  if (!isIso(x.generatedAt)) return "status.generatedAt: expected ISO date";
  if (!isNum(x.cadenceMinutes)) return "status.cadenceMinutes: expected number";
  if (!isNum(x.staleAfterMinutes)) return "status.staleAfterMinutes: expected number";
  const run = x.run;
  if (!isObj(run)) return "status.run: expected object";
  if (run.id !== null && !isNum(run.id)) return "status.run.id: expected number or null";
  if (run.attempt !== null && !isNum(run.attempt)) return "status.run.attempt: expected number or null";
  if (!isStr(run.trigger)) return "status.run.trigger: expected string";
  if (run.codeSha !== null && !isStr(run.codeSha)) return "status.run.codeSha: expected string or null";
  if (run.durationS !== null && !isNum(run.durationS)) return "status.run.durationS: expected number or null";
  const feeds = x.feeds;
  if (!isObj(feeds)) return "status.feeds: expected object";
  for (const k of ["total", "ok", "failed", "carriedForward", "quarantined"]) {
    if (!isCount(feeds[k])) return `status.feeds.${k}: expected non-negative integer`;
  }
  if (!isStrArr(feeds.failedNames)) return "status.feeds.failedNames: expected string[]";
  const content = x.content;
  if (!isObj(content)) return "status.content: expected object";
  if (!isCount(content.stories)) return "status.content.stories: expected non-negative integer";
  if (!isCount(content.top)) return "status.content.top: expected non-negative integer";
  if (!Array.isArray(content.emptySections) || !content.emptySections.every(isSectionId)) return "status.content.emptySections: expected section ids";
  if (content.newestItemAt !== null && !isIso(content.newestItemAt)) return "status.content.newestItemAt: expected ISO date or null";
  if (content.medianAgeH !== null && !isNum(content.medianAgeH)) return "status.content.medianAgeH: expected number or null";
  const gate = x.gate;
  if (!isObj(gate)) return "status.gate: expected object";
  if (!isBool(gate.passed)) return "status.gate.passed: expected boolean";
  if (!isStrArr(gate.warnings)) return "status.gate.warnings: expected string[]";
  if (gate.failures !== undefined && !isStrArr(gate.failures)) return "status.gate.failures: expected string[]";
  const brief = x.brief;
  if (!isObj(brief) || (brief.source !== "claude" && brief.source !== "fallback")) return 'status.brief.source: expected "claude"|"fallback"';
  if (brief.reason !== undefined && !isStr(brief.reason)) return "status.brief.reason: expected string";
  const stocks = x.stocks;
  if (!isObj(stocks) || !isCount(stocks.ok) || !isCount(stocks.total)) return "status.stocks: expected { ok, total }";
  return null;
}

export const isEditionFront = (x: unknown): x is EditionFront => validateEditionFront(x) === null;
export const isEditionRest = (x: unknown): x is EditionRest => validateEditionRest(x) === null;
export const isRiverFile = (x: unknown): x is RiverFile => validateRiverFile(x) === null;
export const isHealthFile = (x: unknown): x is HealthFile => validateHealthFile(x) === null;
export const isSourcesFile = (x: unknown): x is SourcesFile => validateSourcesFile(x) === null;
export const isBriefFile = (x: unknown): x is BriefFile => validateBriefFile(x) === null;
export const isStocksFile = (x: unknown): x is StocksFile => validateStocksFile(x) === null;
export const isStatusFile = (x: unknown): x is StatusFile => validateStatusFile(x) === null;

/** `schemaVersion` of any payload (status.json: `schema`), or null when absent / not a number. */
export function schemaVersionOf(x: unknown): number | null {
  if (!isObj(x)) return null;
  const v = x.schemaVersion ?? x.schema;
  return isNum(v) ? v : null;
}

/** True when the payload was written by a NEWER contract than this bundle understands ("reload" banner). */
export function isNewerSchema(x: unknown): boolean {
  const v = schemaVersionOf(x);
  return v !== null && isObj(x) && x.schemaVersion !== undefined && v > SCHEMA_VERSION;
}
