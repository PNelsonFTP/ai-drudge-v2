// Compare a V1 payload (headlines.json) with a V2 data set: what both editions carry, what only one
// does, how the lead and the top stories differ, and why V1 articles are missing from V2.
//
//   npx tsx scripts/tools/compare-v1-v2.ts [--v1 <headlines.json | URL>] [--dir <v2 data dir>]
//                                          [--explain <explain.json>] [--json]
//
// Defaults: --v1 test/fixtures/v1/2026-11-19/headlines.json (the last V1 production payload taken
// before the cutover), --dir public/data/v2, --explain node_modules/.tmp/explain.json (written by
// `npm run build:data`; without it "why missing" is limited to what the river shows).
// Matching is by canonical URL key first, then by normalised title (V1 kept Google News wrapper
// links that V2 resolves to the publisher).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_FILES, type EditionFront, type EditionRest, type RiverFile } from "../../shared/contract";
import { isEditionFront, isEditionRest, isRiverFile } from "../../shared/guards";
import { legacyToSections, type SectionId } from "../../shared/sections";
import { mergeEdition, riverRows, storyOf, type Edition } from "../../shared/select";
import { normalizeForSearch } from "../../shared/text";
import { urlKey } from "../../shared/url";
import { EXPLAIN_FILE, type ExplainFile } from "../pipeline/emit/explain";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface V1Article {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string;
  related?: { source: string }[];
}

export interface V1Payload {
  generatedAt: string;
  leadUrl?: string;
  trending?: { lead: V1Article; related?: unknown[] }[];
  categories: { id: string; label: string; articles: V1Article[] }[];
}

export interface Comparison {
  v1: { generatedAt: string; articles: number; lead: string | null; trending: string[] };
  v2: { generatedAt: string; stories: number; lead: string | null; top: { title: string; publishers: number }[] };
  /** V1 articles (unique URLs) found on a V2 section page / only in the V2 river / nowhere. */
  overlap: { placed: number; riverOnly: number; missing: number };
  /** V2 placed stories that V1 did not show at all. */
  newInV2: number;
  /** Why V1 articles are not placed in V2 (drop reason, "river only", or "not fetched"). */
  missingByReason: Record<string, number>;
  leadSame: boolean;
  /** V1 trending leads and where they are in V2. */
  trending: { title: string; inV2: "top" | "placed" | "river" | "dropped" | "absent"; detail?: string }[];
  sections: { v1: string; v2: SectionId[]; v1Rows: number; v2Rows: number; shared: number }[];
  missingSample: { title: string; source: string; why: string }[];
}

const titleKey = (t: string): string => normalizeForSearch(t).replace(/\s+/g, " ").trim();

function isV1Payload(x: unknown): x is V1Payload {
  const o = x as Partial<V1Payload> | null;
  return typeof o === "object" && o !== null && typeof o.generatedAt === "string" && Array.isArray(o.categories);
}

export function compare(v1: V1Payload, edition: Edition, river: RiverFile | null, explain: ExplainFile | null): Comparison {
  const v1Articles = new Map<string, V1Article>();
  for (const c of v1.categories) for (const a of c.articles) v1Articles.set(urlKey(a.url) ?? a.url, a);

  // Everything V2 shows on a section page or in TOP STORIES, leads and members alike.
  const placedByUrl = new Map<string, string>();
  const placedByTitle = new Map<string, string>();
  const placedLeads = new Set<string>([...edition.top, ...edition.sections.flatMap((s) => s.rows)]);
  for (const lead of placedLeads) {
    const story = storyOf(edition, lead);
    if (!story) continue;
    for (const a of [story.lead, ...story.members]) {
      const key = urlKey(a.url);
      if (key) placedByUrl.set(key, lead);
      placedByTitle.set(titleKey(a.title), lead);
    }
  }
  const riverByUrl = new Set<string>();
  const riverByTitle = new Set<string>();
  for (const r of river ? riverRows(river) : []) {
    const key = urlKey(r.url);
    if (key) riverByUrl.add(key);
    riverByTitle.add(titleKey(r.title));
  }
  const droppedByUrl = new Map<string, string>();
  const droppedByTitle = new Map<string, string>();
  for (const d of explain?.dropped ?? []) {
    const key = urlKey(d.url);
    if (key) droppedByUrl.set(key, d.reason);
    droppedByTitle.set(titleKey(d.title), d.reason);
  }

  type Where = { kind: "placed"; lead: string } | { kind: "river" } | { kind: "dropped"; reason: string } | { kind: "absent" };
  const locate = (a: V1Article): Where => {
    const key = urlKey(a.url) ?? a.url;
    const t = titleKey(a.title);
    const lead = placedByUrl.get(key) ?? placedByTitle.get(t);
    if (lead) return { kind: "placed", lead };
    if (riverByUrl.has(key) || riverByTitle.has(t)) return { kind: "river" };
    const reason = droppedByUrl.get(key) ?? droppedByTitle.get(t);
    return reason ? { kind: "dropped", reason } : { kind: "absent" };
  };

  const overlap = { placed: 0, riverOnly: 0, missing: 0 };
  const missingByReason: Record<string, number> = {};
  const missingSample: Comparison["missingSample"] = [];
  const matchedLeads = new Set<string>();
  for (const a of v1Articles.values()) {
    const where = locate(a);
    if (where.kind === "placed") {
      overlap.placed++;
      matchedLeads.add(where.lead);
      continue;
    }
    const why = where.kind === "river" ? "river only (not placed: window / diversity / cap)" : where.kind === "dropped" ? where.reason : "not fetched (source removed, or the item left the feed)";
    if (where.kind === "river") overlap.riverOnly++;
    else overlap.missing++;
    missingByReason[why] = (missingByReason[why] ?? 0) + 1;
    if (missingSample.length < 25) missingSample.push({ title: a.title, source: a.source, why });
  }

  const v1LeadArticle = v1.leadUrl ? v1Articles.get(urlKey(v1.leadUrl) ?? v1.leadUrl) : undefined;
  const v2Lead = edition.leadId ? storyOf(edition, edition.leadId) : null;
  const v1LeadWhere = v1LeadArticle ? locate(v1LeadArticle) : null;

  const topSet = new Set(edition.top);
  const trending: Comparison["trending"] = (v1.trending ?? []).map((t) => {
    const where = locate(t.lead);
    if (where.kind === "placed") return { title: t.lead.title, inV2: topSet.has(where.lead) ? "top" : "placed" };
    if (where.kind === "river") return { title: t.lead.title, inV2: "river" };
    return where.kind === "dropped" ? { title: t.lead.title, inV2: "dropped", detail: where.reason } : { title: t.lead.title, inV2: "absent" };
  });

  const v2Rows = new Map(edition.sections.map((s) => [s.id, s.rows]));
  const sections: Comparison["sections"] = v1.categories.map((c) => {
    const targets = [...legacyToSections(c.id)];
    const leads = new Set(targets.flatMap((id) => v2Rows.get(id) ?? []));
    let shared = 0;
    for (const a of c.articles) {
      const where = locate(a);
      if (where.kind === "placed" && leads.has(where.lead)) shared++;
    }
    return { v1: c.id, v2: targets, v1Rows: c.articles.length, v2Rows: leads.size, shared };
  });

  return {
    v1: { generatedAt: v1.generatedAt, articles: v1Articles.size, lead: v1LeadArticle?.title ?? null, trending: (v1.trending ?? []).map((t) => t.lead.title) },
    v2: {
      generatedAt: edition.meta.generatedAt,
      stories: placedLeads.size,
      lead: v2Lead?.lead.title ?? null,
      top: edition.top.map((id) => ({ title: storyOf(edition, id)?.lead.title ?? id, publishers: storyOf(edition, id)?.publishers ?? 1 })),
    },
    overlap,
    newInV2: [...placedLeads].filter((id) => !matchedLeads.has(id)).length,
    missingByReason,
    leadSame: v1LeadWhere?.kind === "placed" && v1LeadWhere.lead === edition.leadId,
    trending,
    sections,
    missingSample,
  };
}

export function formatComparison(c: Comparison): string {
  const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : "-");
  const lines: string[] = [
    `V1 ${c.v1.generatedAt}: ${c.v1.articles} articles   |   V2 ${c.v2.generatedAt}: ${c.v2.stories} placed stories`,
    "",
    `Lead      V1: ${c.v1.lead ?? "(none)"}`,
    `          V2: ${c.v2.lead ?? "(none)"}${c.leadSame ? "   (same story)" : ""}`,
    "",
    `Overlap   ${c.overlap.placed} of ${c.v1.articles} V1 articles are placed in V2 (${pct(c.overlap.placed, c.v1.articles)}); ${c.overlap.riverOnly} only in the river; ${c.overlap.missing} gone`,
    `          ${c.newInV2} V2 stories were not in V1`,
    "",
    "Why V1 articles are not placed in V2:",
    ...Object.entries(c.missingByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([why, n]) => `  ${String(n).padStart(4)}  ${why}`),
    "",
    "V1 trending -> V2:",
    ...c.trending.map((t) => `  [${t.inV2}${t.detail ? `: ${t.detail}` : ""}] ${t.title}`),
    "",
    "V2 TOP STORIES:",
    ...c.v2.top.map((t, i) => `  ${String(i + 1).padStart(2)}. (${t.publishers} publisher${t.publishers === 1 ? "" : "s"}) ${t.title}`),
    "",
    "Sections (V1 category -> V2 sections: V1 rows / V2 rows / shared):",
    ...c.sections.map((s) => `  ${s.v1.padEnd(16)} -> ${(s.v2.join(", ") || "-").padEnd(20)} ${String(s.v1Rows).padStart(3)} / ${String(s.v2Rows).padStart(3)} / ${String(s.shared).padStart(3)}`),
  ];
  if (c.missingSample.length) lines.push("", "Sample of V1 articles not placed in V2:", ...c.missingSample.map((m) => `  - ${m.title}  [${m.source}] - ${m.why}`));
  return lines.join("\n");
}

async function readJson(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  }
  return JSON.parse(await fs.readFile(path.resolve(source), "utf8")) as unknown;
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const v1Source = flag("--v1") ?? path.join(ROOT, "test/fixtures/v1/2026-11-19/headlines.json");
  const dir = path.resolve(flag("--dir") ?? path.join(ROOT, "public/data/v2"));
  const explainPath = path.resolve(flag("--explain") ?? path.join(ROOT, EXPLAIN_FILE));

  const v1 = await readJson(v1Source);
  if (!isV1Payload(v1)) throw new Error(`${v1Source} is not a V1 headlines.json`);
  const front = (await readJson(path.join(dir, DATA_FILES.front))) as EditionFront;
  const rest = (await readJson(path.join(dir, DATA_FILES.rest))) as EditionRest;
  if (!isEditionFront(front) || !isEditionRest(rest)) throw new Error(`${dir} does not hold a valid V2 edition (run npm run build:data)`);
  const river = await readJson(path.join(dir, DATA_FILES.river)).catch(() => null);
  const explain = (await readJson(explainPath).catch(() => null)) as ExplainFile | null;
  const usable = explain && explain.buildId === front.buildId ? explain : null;
  if (explain && !usable) console.error(`note: ${explainPath} belongs to another build (${explain.buildId}); drop reasons are not shown`);

  const result = compare(v1, mergeEdition(front, rest), isRiverFile(river) ? river : null, usable);
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatComparison(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
