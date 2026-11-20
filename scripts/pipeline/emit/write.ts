// The only place the build writes its outputs. Every file is written to a temp name in its target
// directory and then renamed, so a reader (the next build step, a dev server, a crashed run) never
// sees a half-written file; all temps are written before the first rename, so a failure while
// serialising or writing leaves the previous build fully in place.

import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_FILES } from "../../../shared/contract";
import type { EmitBundle, PipelineState, StateFile, WriteBundle, WriteTargets } from "../types";
import { ATOM_FILE } from "./atom";
import type { ExplainFile } from "./explain";
import { OPML_FILE } from "./opml";

const KB = 1024;
const MB = 1024 * KB;

/**
 * Refuse-to-write ceilings in bytes, 10-20x the normal size of each file (front ~100 KB, rest ~70 KB,
 * river ~200 KB). state.json is about 3 MB on a young state and an estimated 8-9 MB once the ledger
 * (45 days), the river memory (6,000 rows) and the resolved-URL cache (5,000) are full; its ceiling
 * is about 3x that, so real growth trips it long before the old 48 MB would have.
 * Field caps upstream keep real builds far below; these stop a runaway payload (a 6 MB feed once
 * became a 96 MB headlines.json in a V1 experiment) from being published or handed to the next build.
 */
export const SIZE_LIMITS: Readonly<Record<string, number>> = {
  [DATA_FILES.front]: 1.5 * MB,
  [DATA_FILES.rest]: 4 * MB,
  [DATA_FILES.river]: 8 * MB,
  [DATA_FILES.health]: 1 * MB,
  [DATA_FILES.sources]: 1 * MB,
  [DATA_FILES.brief]: 64 * KB,
  [DATA_FILES.stocks]: 64 * KB,
  [DATA_FILES.status]: 64 * KB,
  [DATA_FILES.state]: 24 * MB,
  [ATOM_FILE]: 1 * MB,
  [OPML_FILE]: 1 * MB,
};

export interface OutputFile {
  /** File name ("front.json", "feed.xml"). */
  name: string;
  /** "data" -> WriteTargets.dataDir, "public" -> WriteTargets.publicDir. */
  dir: "data" | "public";
  content: string;
}

/** The public files of a bundle, minified, in the order they are renamed into place. */
export function serializeBundle(bundle: EmitBundle): OutputFile[] {
  const json = (name: string, value: unknown): OutputFile => ({ name, dir: "data", content: JSON.stringify(value) });
  return [
    json(DATA_FILES.rest, bundle.rest),
    json(DATA_FILES.river, bundle.river),
    json(DATA_FILES.health, bundle.health),
    json(DATA_FILES.sources, bundle.sources),
    json(DATA_FILES.brief, bundle.brief),
    json(DATA_FILES.stocks, bundle.stocks),
    { name: ATOM_FILE, dir: "public", content: bundle.atom },
    { name: OPML_FILE, dir: "public", content: bundle.opml },
    // front.json and status.json go last: they are what the client and the reconciler read first,
    // so they only change once everything they point at is already in place.
    json(DATA_FILES.front, bundle.front),
    json(DATA_FILES.status, bundle.status),
  ];
}

export function stateFile(bundle: EmitBundle, state: PipelineState): StateFile {
  return { ...state, schemaVersion: 2, buildId: bundle.front.buildId, savedAt: bundle.front.generatedAt };
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Files over their ceiling, as human-readable problems ([] = fine). */
export function sizeProblems(files: readonly OutputFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const limit = SIZE_LIMITS[f.name];
    const size = bytes(f.content);
    if (limit !== undefined && size > limit) out.push(`${f.name} is ${size} bytes (limit ${limit})`);
    if (size === 0) out.push(`${f.name} is empty`);
  }
  return out;
}

export interface FileSize {
  name: string;
  raw: number;
  gzip: number;
}

/** Raw and gzip-6 sizes of the public files (reports; Pages serves gzip). */
export function bundleSizes(bundle: EmitBundle): FileSize[] {
  return serializeBundle(bundle).map((f) => ({ name: f.name, raw: bytes(f.content), gzip: gzipSync(f.content, { level: 6 }).length }));
}

async function writeAll(files: readonly { file: string; content: string }[]): Promise<void> {
  const tag = `.tmp-${process.pid}`;
  const temps: string[] = [];
  try {
    for (const f of files) {
      await fs.mkdir(path.dirname(f.file), { recursive: true });
      const tmp = `${f.file}${tag}`;
      temps.push(tmp);
      await fs.writeFile(tmp, f.content, "utf8");
    }
    for (const f of files) await fs.rename(`${f.file}${tag}`, f.file);
  } finally {
    // Renamed temps are gone already; this only removes leftovers of a failed write.
    await Promise.all(temps.map((t) => fs.rm(t, { force: true })));
  }
}

/** Write one text file atomically (temp + rename). */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await writeAll([{ file, content }]);
}

/**
 * WP6 stage: publish a bundle. JSON goes to targets.dataDir (state.json included), feed.xml and
 * feeds.opml to targets.publicDir. Throws - before touching the disk - when a file is over its size
 * ceiling.
 */
export const writeBundle: WriteBundle = async (bundle: EmitBundle, state: PipelineState, targets: WriteTargets): Promise<void> => {
  const files = serializeBundle(bundle);
  files.push({ name: DATA_FILES.state, dir: "data", content: JSON.stringify(stateFile(bundle, state)) });
  const problems = sizeProblems(files);
  if (problems.length) throw new Error(`writeBundle: refusing to write an absurd payload: ${problems.join("; ")}`);
  await writeAll(files.map((f) => ({ file: path.join(f.dir === "data" ? targets.dataDir : targets.publicDir, f.name), content: f.content })));
};

/** Write the explain record (emit/explain.ts) for scripts/tools/explain.ts. Not part of the published site. */
export async function writeExplain(explain: ExplainFile, file: string): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(explain));
}
