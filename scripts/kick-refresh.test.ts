// scripts/kick-refresh.sh must never dispatch to the V1 (live) repository by accident, however the
// repository is spelled. Dry runs only: AID_DRY_RUN=1 exits before the GitHub CLI is looked up.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "kick-refresh.sh");

function kick(env: Record<string, string>): { code: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AID_DRY_RUN: "1", ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("kick-refresh.sh", () => {
  it("defaults to the V2 repository, main and refresh.yml", () => {
    const r = kick({});
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /workflow 'refresh\.yml' in PNelsonFTP\/ai-drudge-v2 on ref 'main'/);
    assert.match(r.out, /dry run - nothing dispatched/);
  });

  it("refuses every spelling of the V1 repository", () => {
    const spellings = [
      "PNelsonFTP/ai-drudge",
      "pnelsonftp/AI-Drudge",
      "https://github.com/PNelsonFTP/ai-drudge.git",
      "git@github.com:PNelsonFTP/ai-drudge.git",
      "github.com/PNelsonFTP/ai-drudge/",
      // One pass of suffix stripping used to let these through as a "different" repository.
      "PNelsonFTP/ai-drudge.git.git",
      "PNelsonFTP/ai-drudge.git/",
      "PNelsonFTP/ai-drudge/.git",
      "https://github.com/PNelsonFTP/ai-drudge.git/.git//",
    ];
    for (const repo of spellings) {
      const r = kick({ AID_REPO: repo });
      assert.equal(r.code, 1, `${repo}: ${r.out}`);
      assert.match(r.out, /refusing to kick the V1 repository \(PNelsonFTP\/ai-drudge\)/i, repo);
    }
  });

  it("kicks V1 only when asked to on purpose, and V2 under any spelling", () => {
    assert.equal(kick({ AID_REPO: "PNelsonFTP/ai-drudge.git.git", AID_ALLOW_V1: "1" }).code, 0);
    for (const repo of ["PNelsonFTP/ai-drudge-v2", "https://github.com/PNelsonFTP/ai-drudge-v2.git", "git@github.com:PNelsonFTP/ai-drudge-v2.git/"]) {
      const r = kick({ AID_REPO: repo });
      assert.equal(r.code, 0, `${repo}: ${r.out}`);
      assert.match(r.out, /in PNelsonFTP\/ai-drudge-v2 on ref/);
    }
  });

  it("rejects malformed repositories, refs, workflow names and retry counts", () => {
    const malformed: Record<string, string>[] = [
      { AID_REPO: "justname" },
      { AID_REPO: "a/b/c" },
      { AID_REPO: "PNelsonFTP/.git" },
      { AID_REPO: "owner/na me" },
      { AID_REF: "--repo=PNelsonFTP/ai-drudge" },
      { AID_REF: "main;rm" },
      { AID_WORKFLOW: "-f" },
      { AID_WORKFLOW: "../x.yml" },
      { AID_RETRIES: "0" },
      { AID_RETRIES: "many" },
    ];
    for (const env of malformed) {
      const r = kick(env);
      assert.equal(r.code, 1, `${JSON.stringify(env)}: ${r.out}`);
      assert.doesNotMatch(r.out, /nothing dispatched/);
    }
  });
});
