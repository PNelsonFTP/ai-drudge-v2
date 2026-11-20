// Import-boundary rules of the V2 layout (replaces eslint / dependency-cruiser).
//
//   1. src/** never imports scripts/** or node built-ins (tests may import node:test / node:assert)
//   2. shared/** imports only shared/** (tests may also import node:* and test/helpers)
//   3. a pipeline stage dir never imports a sibling stage dir
//   4. scripts/registry/** never imports scripts/pipeline/**
//   5. build code never imports client code; only tests import test/helpers
//   6. browser-safe test helpers (factories, fixtureData, fakeServices) import no node built-ins
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(child.split(path.sep).join("/"));
  }
  return out;
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Import specifiers of a file (static, side-effect, dynamic, require). Comments are stripped first. */
export function importsOf(file: string): string[] {
  const src = fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const BUILTINS = new Set(builtinModules);
const isNodeBuiltin = (spec: string): boolean => spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]);
const isTest = (file: string): boolean => /\.test\.(ts|tsx)$/.test(file);

/** Repo-relative target of a relative import ("" for package imports). */
function target(file: string, spec: string): string {
  if (!spec.startsWith(".")) return "";
  return rel(path.resolve(ROOT, path.dirname(file), spec));
}

interface Violation {
  file: string;
  spec: string;
  rule: string;
}

function check(files: string[], rule: string, bad: (file: string, spec: string, to: string) => boolean): Violation[] {
  const out: Violation[] = [];
  for (const file of files) for (const spec of importsOf(file)) if (bad(file, spec, target(file, spec))) out.push({ file, spec, rule });
  return out;
}

const report = (v: Violation[]): string => v.map((x) => `${x.file} imports "${x.spec}" (${x.rule})`).join("\n");
const under = (to: string, dir: string): boolean => to === dir || to.startsWith(`${dir}/`);

describe("import boundaries", () => {
  it("the import scanner sees static, type, side-effect, dynamic and require imports", () => {
    const tmp = path.join(ROOT, "node_modules/.tmp/boundaries-probe.ts");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(
      tmp,
      [
        'import a from "./a";',
        'import type { B } from "../b";',
        'import { c,\n  d } from "node:fs";',
        'import "./side-effect.css";',
        'export { e } from "./e";',
        'export * from "./f";',
        'const g = await import("./g");',
        'const h = require("h-pkg");',
        '// import x from "./commented-out";',
        '/* import y from "./block-comment"; */',
        'const s = "https://example.com/not-an-import";',
      ].join("\n"),
    );
    assert.deepEqual(importsOf(rel(tmp)), ["./a", "../b", "node:fs", "./side-effect.css", "./e", "./f", "./g", "h-pkg"]);
    fs.rmSync(tmp);
  });

  it("src/** never imports scripts/** or node built-ins", () => {
    const files = walk("src");
    assert.ok(files.length > 0);
    const v = [
      ...check(files, "src must not import scripts/", (_f, _s, to) => under(to, "scripts")),
      ...check(files.filter((f) => !isTest(f)), "src must not import node built-ins", (_f, spec) => isNodeBuiltin(spec)),
    ];
    assert.equal(v.length, 0, report(v));
  });

  it("shared/** imports only shared/**", () => {
    const files = walk("shared");
    assert.ok(files.length >= 9);
    const v = [
      ...check(files.filter((f) => !isTest(f)), "shared imports only relative shared/ modules", (_f, spec, to) => !spec.startsWith(".") || !under(to, "shared")),
      ...check(files.filter(isTest), "shared tests import only shared/, test/helpers and node:", (_f, spec, to) =>
        spec.startsWith(".") ? !under(to, "shared") && !under(to, "test/helpers") : !isNodeBuiltin(spec),
      ),
    ];
    assert.equal(v.length, 0, report(v));
  });

  it("pipeline stage directories never import sibling stage directories", () => {
    const base = path.join(ROOT, "scripts/pipeline");
    const stages = fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    const v: Violation[] = [];
    for (const stage of stages) {
      const own = `scripts/pipeline/${stage}`;
      v.push(...check(walk(own), `stage "${stage}" must not import another stage`, (_f, _s, to) => under(to, "scripts/pipeline") && !under(to, own) && stages.some((other) => under(to, `scripts/pipeline/${other}`))));
    }
    assert.equal(v.length, 0, report(v));
  });

  it("scripts/registry/** never imports scripts/pipeline/**", () => {
    const v = check(walk("scripts/registry"), "registry must not import the pipeline", (_f, _s, to) => under(to, "scripts/pipeline"));
    assert.equal(v.length, 0, report(v));
  });

  it("pipeline and registry never import src/**; scripts never import test/ outside tests and tools", () => {
    const v = [
      ...check([...walk("scripts/pipeline"), ...walk("scripts/registry")], "build code must not import client code", (_f, _s, to) => under(to, "src")),
      ...check([...walk("scripts/pipeline"), ...walk("scripts/registry")].filter((f) => !isTest(f)), "only tests may import test/helpers (the gate uses shared/invariants)", (_f, _s, to) => under(to, "test")),
    ];
    assert.equal(v.length, 0, report(v));
  });

  it("browser-safe test helpers import no node built-ins", () => {
    const files = ["test/helpers/factories.ts", "test/helpers/fixtureData.ts", "test/helpers/fakeServices.ts"];
    for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    const v = check(files, "helper is imported by client code", (_f, spec, to) => isNodeBuiltin(spec) || to === "test/helpers/fixtures" || to === "test/helpers/invariants");
    assert.equal(v.length, 0, report(v));
  });

  it("is tolerant of directories that do not exist yet", () => {
    assert.deepEqual(walk("src/does-not-exist"), []);
    assert.deepEqual(walk("scripts/pipeline/not-a-stage"), []);
  });
});
