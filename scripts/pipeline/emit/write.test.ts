import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_FILES } from "../../../shared/contract";
import { createTestContext, emptyState } from "../context";
import type { EmitBundle, PipelineState, StateFile } from "../types";
import { emit } from "./edition";
import { buildExplain } from "./explain";
import { sample, sampleInput } from "./testkit.test";
import { SIZE_LIMITS, bundleSizes, serializeBundle, sizeProblems, writeBundle, writeExplain, writeFileAtomic } from "./write";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aid2-write-"));
}

function sampleBundle(): EmitBundle {
  const ctx = createTestContext();
  return emit(sampleInput(ctx), ctx);
}

describe("emit: writeBundle", () => {
  it("writes every file, minified, plus state.json, creating the directories", async () => {
    const root = await tmpDir();
    const targets = { dataDir: path.join(root, "public/data/v2"), publicDir: path.join(root, "public") };
    const bundle = sampleBundle();
    const state: PipelineState = { ...emptyState(), firstSeen: { abc: "2026-11-19T20:00:00.000Z" } };
    await writeBundle(bundle, state, targets);

    const data = (await fs.readdir(targets.dataDir)).sort();
    assert.deepEqual(data, Object.values(DATA_FILES).sort());
    assert.deepEqual((await fs.readdir(targets.publicDir)).sort(), ["data", "feed.xml", "feeds.opml"]);

    const frontText = await fs.readFile(path.join(targets.dataDir, "front.json"), "utf8");
    assert.equal(frontText, JSON.stringify(bundle.front), "minified, no trailing whitespace");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(targets.dataDir, "river.json"), "utf8")), bundle.river);
    assert.equal(await fs.readFile(path.join(targets.publicDir, "feed.xml"), "utf8"), bundle.atom);
    assert.equal(await fs.readFile(path.join(targets.publicDir, "feeds.opml"), "utf8"), bundle.opml);

    const saved = JSON.parse(await fs.readFile(path.join(targets.dataDir, "state.json"), "utf8")) as StateFile;
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.buildId, bundle.front.buildId);
    assert.equal(saved.savedAt, bundle.front.generatedAt);
    assert.deepEqual(saved.firstSeen, state.firstSeen);
    await fs.rm(root, { recursive: true });
  });

  it("replaces files atomically and leaves no temp files behind", async () => {
    const root = await tmpDir();
    const targets = { dataDir: root, publicDir: root };
    await fs.writeFile(path.join(root, "front.json"), "OLD");
    await writeBundle(sampleBundle(), emptyState(), targets);
    const names = await fs.readdir(root);
    assert.ok(!names.some((n) => n.includes(".tmp-")), `temp files left: ${names.join(", ")}`);
    assert.notEqual(await fs.readFile(path.join(root, "front.json"), "utf8"), "OLD");
    await fs.rm(root, { recursive: true });
  });

  it("refuses an absurd payload before touching the disk", async () => {
    const root = await tmpDir();
    const targets = { dataDir: path.join(root, "data"), publicDir: root };
    await fs.mkdir(targets.dataDir);
    await fs.writeFile(path.join(targets.dataDir, "front.json"), "PREVIOUS BUILD");
    const bundle = sampleBundle();
    const huge: EmitBundle = { ...bundle, brief: { ...bundle.brief, bullets: ["x".repeat(SIZE_LIMITS["brief.json"] + 1)] } };
    await assert.rejects(writeBundle(huge, emptyState(), targets), /refusing to write an absurd payload: brief\.json is \d+ bytes/);
    assert.equal(await fs.readFile(path.join(targets.dataDir, "front.json"), "utf8"), "PREVIOUS BUILD");
    assert.deepEqual(await fs.readdir(targets.dataDir), ["front.json"], "nothing else was written");
    await assert.rejects(writeBundle({ ...bundle, atom: "" }, emptyState(), targets), /feed\.xml is empty/);
    await fs.rm(root, { recursive: true });
  });

  it("keeps the previous build when a write fails half-way", async () => {
    const root = await tmpDir();
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(dataDir, "front.json"), "PREVIOUS BUILD");
    // publicDir is a FILE, so creating feed.xml inside it fails after the JSON temps were written.
    const blocker = path.join(root, "not-a-dir");
    await fs.writeFile(blocker, "x");
    await assert.rejects(writeBundle(sampleBundle(), emptyState(), { dataDir, publicDir: blocker }));
    assert.equal(await fs.readFile(path.join(dataDir, "front.json"), "utf8"), "PREVIOUS BUILD");
    assert.deepEqual(await fs.readdir(dataDir), ["front.json"], "temp files were cleaned up");
    await fs.rm(root, { recursive: true });
  });

  it("serialises the public files in a fixed order with front.json and status.json last", () => {
    const names = serializeBundle(sampleBundle()).map((f) => f.name);
    assert.deepEqual(names.slice(-2), ["front.json", "status.json"]);
    assert.equal(names.length, 10);
    assert.ok(!names.includes("state.json"));
    assert.deepEqual(sizeProblems(serializeBundle(sampleBundle())), []);
  });

  it("reports raw and gzip sizes", () => {
    const sizes = bundleSizes(sampleBundle());
    const front = sizes.find((s) => s.name === "front.json");
    assert.ok(front && front.raw > 500 && front.gzip > 100 && front.gzip < front.raw);
  });

  it("writes single files and the explain record atomically", async () => {
    const root = await tmpDir();
    const file = path.join(root, "deep/dir/explain.json");
    const s = sample();
    const explain = buildExplain(s.placements, [{ id: null, sourceId: "krebs", title: "Webinar", url: "https://x.test/w", reason: "noise", stage: "relevance" }], createTestContext());
    await writeExplain(explain, file);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), JSON.parse(JSON.stringify(explain)));
    await writeFileAtomic(path.join(root, "a.txt"), "one");
    await writeFileAtomic(path.join(root, "a.txt"), "two");
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "two");
    await fs.rm(root, { recursive: true });
  });
});

describe("emit: explain record", () => {
  it("records score parts, placements, top rank and members for every story, best first", () => {
    const s = sample();
    const trace = { [s.story.ipo.lead]: { routedTo: "money" as const, rule: "ipo" } };
    const explain = buildExplain({ ...s.placements, trace }, [], createTestContext());
    assert.equal(explain.stories.length, 9);
    assert.equal(explain.stories[0].id, s.story.ipo.lead);
    const ipo = explain.stories[0];
    assert.deepEqual(ipo.sections, [
      { id: "industry", rank: 1, home: true },
      { id: "money", rank: 1, home: true },
    ]);
    assert.equal(ipo.topRank, 1);
    assert.equal(ipo.isLead, true);
    assert.equal(ipo.members.length, 4);
    assert.deepEqual(ipo.trace, { routedTo: "money", rule: "ipo" });
    assert.deepEqual(ipo.parts, { tier: 0, recency: 0, importance: 0, coverage: 0, hn: 0 });
    const unplaced = explain.stories.find((x) => x.id === s.story.unplaced.lead);
    assert.deepEqual(unplaced?.sections, []);
    assert.equal(unplaced?.primary, "industry");
    assert.equal(unplaced?.topRank, null);
  });
});
