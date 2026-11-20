// `npm run data:fixture` - installs the committed v2 fixture (test/fixtures/v2/) as the site's data
// (public/data/v2/, gitignored), so a fresh clone runs without the network.
//
//   npm run data:fixture                 test/fixtures/v2 -> public/data/v2
//   npm run data:fixture -- --to <dir>   another target directory
//
// The fixture is a frozen build (see scripts/tools/fixture-refresh.ts for how it is made and what
// was changed on the way; `npm run fixture:refresh` replaces it with the last build). Before
// copying, every file is checked against test/fixtures/v2.manifest.json (sha256): a fixture edited
// by hand is not installed. Only the eight public JSON files are written - state.json, feed.xml and
// feeds.opml are not part of the fixture, and files already in the target are left alone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURE_DIR, FIXTURE_FILES, FIXTURE_MANIFEST, sha256, type FixtureManifest } from "./fixture-refresh";

export interface InstallResult {
  ok: boolean;
  lines: string[];
}

/** Copy the fixture from `fromDir` to `toDir` after checking it against the manifest. */
export function installFixture(fromDir: string, manifestFile: string, toDir: string): InstallResult {
  const lines: string[] = [];
  let manifest: FixtureManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as FixtureManifest;
  } catch {
    return { ok: false, lines: [`data:fixture: cannot read ${manifestFile} - run \`npm run fixture:refresh\` after a build`] };
  }
  const contents = new Map<string, string>();
  for (const name of FIXTURE_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(fromDir, name), "utf8");
    } catch {
      lines.push(`data:fixture: ${path.join(fromDir, name)} is missing`);
      continue;
    }
    if (sha256(text) !== manifest.files?.[name]?.sha256) lines.push(`data:fixture: ${name} does not match the manifest (edited by hand?) - restore it or run \`npm run fixture:refresh\``);
    contents.set(name, text);
  }
  if (lines.length) return { ok: false, lines };
  fs.mkdirSync(toDir, { recursive: true });
  for (const [name, text] of contents) fs.writeFileSync(path.join(toDir, name), text);
  const cases = manifest.healthCases.length ? `; ${manifest.healthCases.length} health rows are synthetic test cases (${manifest.healthCases.map((c) => c.id).join(", ")})` : "";
  return { ok: true, lines: [`data:fixture: installed the build of ${manifest.generatedAt} in ${toDir} (${contents.size} files: ${[...contents.keys()].join(", ")})${cases}`] };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const argv = process.argv.slice(2);
  let to = path.join(root, "public/data/v2");
  if (argv[0] === "--to" && argv[1] && argv.length === 2) to = path.resolve(root, argv[1]);
  else if (argv.length) {
    console.error("data:fixture: usage: data-fixture.ts [--to <dir>]");
    process.exit(1);
  }
  const result = installFixture(path.join(root, FIXTURE_DIR), path.join(root, FIXTURE_MANIFEST), to);
  for (const line of result.lines) (result.ok ? console.log : console.error)(line.replace(`${root}${path.sep}`, ""));
  process.exitCode = result.ok ? 0 : 1;
}
