// Text-level invariants of .github/workflows/*.yml (there is no YAML parser in this repo, and the
// workflows cannot run locally). Each one is a mistake that would be silent on GitHub: a secret in
// the pull-request job, a status function outside `if:` (the file stops parsing), an unpinned
// action, an API key that reaches a branch dispatch.
//
// The shell of the steps that decide whether state survives and who gets told (state restore,
// persist, dist check, the two alert steps) is also EXECUTED here: the script text is cut out of the
// YAML and run by bash against a throw-away directory, with a stub `curl` / `gh` first on PATH and -
// for restore and persist - the real `git` pointed at a local bare repository through
// `url.<base>.insteadOf`. No network. Every git command runs inside a directory created by
// mkdtemp under the OS temp directory, with a from-scratch environment and
// GIT_CEILING_DIRECTORIES set, so none can reach this repository. Skipped where bash, git or jq
// is missing (the CI runner has all three).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows");
const read = (name: string): string => fs.readFileSync(path.join(DIR, name), "utf8");
/** The workflow without comment lines (comments may mention what the code must not do). */
const code = (name: string): string =>
  read(name)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const uses = (text: string): string[] => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);

/** Job names of a workflow, in file order (two-space keys under `jobs:`). */
function jobNames(text: string): string[] {
  const jobs = text.slice(text.indexOf("\njobs:\n"));
  return [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
}

/** The text of one job (from its key to the next job key or the end of the file). */
function jobText(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `job ${job}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Every `run:` script of a workflow: block scalars de-indented, one-liners as they are. */
function runScripts(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!/^[|>][+-]?$/.test(m[2])) {
      out.push(m[2]);
      continue;
    }
    const body: string[] = [];
    const base = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > base); j++) body.push(lines[j]);
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    out.push(body.map((l) => l.slice(indent)).join("\n"));
  }
  return out;
}

/** The `run:` script of the step called `name` (exact) in a workflow file. */
function stepScript(file: string, name: string): string {
  const text = read(file);
  const at = text.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `${file}: step "${name}"`);
  const rest = text.slice(at);
  const end = rest.slice(1).search(/\n\s+- name: /);
  const scripts = runScripts(end < 0 ? rest : rest.slice(0, end + 1));
  assert.equal(scripts.length, 1, `${file}: step "${name}" has one run script`);
  return scripts[0];
}

const hasTool = (tool: string): boolean => spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0;
const SHELL_OK = hasTool("bash") && hasTool("jq") && hasTool("git");

interface Sandbox {
  root: string;
  bin: string;
  /** Run a script with bash in `cwd` (default: root/work). Environment is built from scratch. */
  run(script: string, env: Record<string, string>, cwd?: string): { status: number | null; stdout: string; stderr: string; output: Record<string, string>; summary: string };
  cleanup(): void;
}

function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aid2-wf-")));
  const bin = path.join(root, "bin");
  for (const d of ["bin", "work", "runner", "home", "tmp"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  return {
    root,
    bin,
    run(script, env, cwd = path.join(root, "work")) {
      const outputFile = path.join(root, "runner", "output.txt");
      const summaryFile = path.join(root, "runner", "summary.md");
      fs.writeFileSync(outputFile, "");
      fs.writeFileSync(summaryFile, "");
      const r = spawnSync("bash", ["-c", script], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        // Nothing is inherited but PATH: no GIT_DIR, no tokens, no user git configuration.
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          RUNNER_TEMP: path.join(root, "runner"),
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_REPOSITORY_OWNER: "owner",
          GITHUB_SERVER_URL: "https://github.invalid",
          GITHUB_RUN_ID: "4242",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_REF_NAME: "main",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CEILING_DIRECTORIES: root,
          GIT_TERMINAL_PROMPT: "0",
          ...env,
        },
      });
      const output: Record<string, string> = {};
      for (const line of fs.readFileSync(outputFile, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) output[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output, summary: fs.readFileSync(summaryFile, "utf8") };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeStub(bin: string, name: string, script: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"));

describe("workflows", () => {

  it("the three V2 workflows exist", () => {
    for (const f of ["ci.yml", "feed-audit.yml", "refresh.yml"]) assert.ok(files.includes(f), f);
  });

  it("every action is pinned to a full commit SHA, and the same action uses the same SHA everywhere", () => {
    const pins = new Map<string, Set<string>>();
    for (const f of files) {
      for (const ref of uses(code(f))) {
        const m = /^([\w.-]+\/[\w./-]+)@([0-9a-f]{40})$/.exec(ref);
        assert.ok(m, `${f}: "${ref}" is not pinned to a 40-character commit SHA`);
        pins.set(m[1], (pins.get(m[1]) ?? new Set()).add(m[2]));
      }
    }
    assert.ok(pins.size >= 5);
    for (const [action, shas] of pins) assert.equal(shas.size, 1, `${action} is pinned to ${shas.size} different commits`);
  });

  it("status functions appear only in `if:` (anywhere else the workflow file is invalid)", () => {
    for (const f of files) {
      // A folded `if: >-` continues on the following lines: read it as one line.
      const text = code(f).replace(/\bif: >-\n\s+/g, "if: ");
      for (const line of text.split("\n")) {
        if (!/\b(?:cancelled|always|failure|success)\(\)/.test(line)) continue;
        assert.match(line, /^\s*(?:-\s+)?if:/, `${f}: status function outside an if: -> ${line.trim()}`);
      }
    }
  });

  it("every workflow starts from no permissions and never grants a write scope at workflow level", () => {
    for (const f of files) assert.match(code(f), /^permissions: \{\}$/m, `${f}: top-level permissions must be {}`);
  });

  it("ci.yml: pull_request only, read-only, no secrets, no deploy guard, its own concurrency group", () => {
    const ci = code("ci.yml");
    assert.match(ci, /^on:\n {2}pull_request: \{\}$/m);
    assert.doesNotMatch(ci, /pull_request_target|workflow_run|secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
    assert.doesNotMatch(ci, /V2_DEPLOY/, "a skipped job would satisfy a required check without running");
    assert.deepEqual([...ci.matchAll(/^\s+(\w[\w-]*): (read|write)$/gm)].map((m) => `${m[1]}:${m[2]}`), ["contents:read"]);
    assert.match(ci, /persist-credentials: false/);
    assert.match(ci, /group: v2-ci-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true/);
    for (const step of ["npm ci --ignore-scripts", "npm run typecheck", "npm test", "npm run build"]) assert.ok(ci.includes(`run: ${step}\n`), step);
    assert.doesNotMatch(ci, /check-data|build:data|validate:feeds/, "the fixture has no feed.xml / feeds.opml; the live gate belongs to refresh.yml");
  });

  it("refresh.yml: the API key is on one step, on main only, and the freshness clock is taken before it", () => {
    const refresh = code("refresh.yml");
    // The one place any secret is read; the name may be MENTIONED elsewhere (the brief issue tells the owner how to switch it off).
    const keyLines = refresh.split("\n").filter((l) => /\bsecrets\./.test(l) || /ANTHROPIC_API_KEY\s*:/.test(l));
    assert.deepEqual(keyLines.map((l) => l.trim()), ["ANTHROPIC_API_KEY: ${{ github.ref == 'refs/heads/main' && secrets.ANTHROPIC_API_KEY || '' }}"]);
    for (const f of ["feed-audit.yml", "ci.yml"]) assert.doesNotMatch(code(f), /\bsecrets\./, `${f} reads no secret`);
    assert.ok(refresh.indexOf("BUILD_STARTED_AT=$(date -u +%FT%TZ)") < refresh.indexOf("npm run build:data"), "BUILD_STARTED_AT must be recorded before the data build");
    assert.ok(refresh.indexOf("id: preflight") < refresh.indexOf("uses: actions/checkout@"), "the preflight runs before anything is checked out or installed");
    assert.match(refresh, /scheduled runs execute on the default branch/);
    assert.match(refresh, /check-data\.ts --write-status/);
  });

  it("refresh.yml: a run cancelled by hand does not touch the failure issue; a zero-article hold is named", () => {
    const refresh = code("refresh.yml");
    const alert = refresh.slice(refresh.indexOf("\n  alert:"));
    assert.match(alert, /- name: Open, update or close the rolling issue\n {8}if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(alert, /cancelled\) bad=.*\(cancelled or timed out\)/, "a job that hit its own timeout still alerts");
    assert.match(refresh, /DATA_OUTCOME: \$\{\{ steps\.data\.outputs\.outcome \}\}/);
    assert.match(refresh, /"\$DATA_OUTCOME" = kept-previous \]; then step="data gate \(hold\): zero articles/);
    assert.match(refresh, /::warning title=state restore::/);
  });

  it("feed-audit.yml: a failing dependency audit files its own rolling issue, with the token on steps only", () => {
    const audit = code("feed-audit.yml");
    assert.match(audit, /- name: Open, update or close the dependency-audit issue/);
    assert.equal(audit.match(/\.title == "Dependency audit failing"/g)?.length, 1);
    assert.match(audit, /NPM_AUDIT: \$\{\{ needs\.audit\.outputs\.npm_audit \}\}/);
    const auditJob = audit.slice(audit.indexOf("\n  audit:"), audit.indexOf("\n  report:"));
    assert.doesNotMatch(auditJob, /github\.token|GH_TOKEN|issues: write/, "the job that parses untrusted feeds holds no write token");
  });
});

describe("workflows: structure every job must keep", () => {
  it("every job of the refresh and audit workflows is inert until V2_DEPLOY is true", () => {
    for (const f of ["refresh.yml", "feed-audit.yml"]) {
      const text = code(f);
      const jobs = jobNames(text);
      assert.ok(jobs.length >= 2, `${f}: jobs found`);
      for (const job of jobs) {
        const head = jobText(text, job).replace(/\bif: >-\n\s+/g, "if: ").split("\n    steps:")[0];
        assert.match(head, /^ {4}if: .*vars\.V2_DEPLOY == 'true'/m, `${f}: job "${job}" has no V2_DEPLOY guard`);
      }
    }
    assert.deepEqual(jobNames(code("refresh.yml")), ["guard", "build", "deploy", "persist", "alert"]);
    assert.deepEqual(jobNames(code("feed-audit.yml")), ["audit", "report"]);
    assert.deepEqual(jobNames(code("ci.yml")), ["check"]);
  });

  it("each job holds exactly the permissions it needs, and write scopes never meet repository code they do not need", () => {
    const perms = (f: string, job: string): string[] => {
      const head = jobText(code(f), job).split("\n    steps:")[0];
      if (/^ {4}permissions: \{\}$/m.test(head)) return [];
      return [...head.matchAll(/^ {6}([a-z-]+): (read|write)$/gm)].map((m) => `${m[1]}:${m[2]}`);
    };
    assert.deepEqual(perms("refresh.yml", "guard"), []);
    assert.deepEqual(perms("refresh.yml", "build"), ["contents:read"]);
    assert.deepEqual(perms("refresh.yml", "deploy"), ["pages:write", "id-token:write"]);
    assert.deepEqual(perms("refresh.yml", "persist"), ["contents:write"]);
    assert.deepEqual(perms("refresh.yml", "alert"), ["issues:write"]);
    assert.deepEqual(perms("feed-audit.yml", "audit"), ["contents:read"]);
    assert.deepEqual(perms("feed-audit.yml", "report"), ["contents:read", "issues:write"]);
    assert.deepEqual(perms("ci.yml", "check"), ["contents:read"]);
    // The jobs that can write (pages, the data branch, issues) never check out or install the repository.
    for (const job of ["deploy", "persist", "alert"]) assert.doesNotMatch(jobText(code("refresh.yml"), job), /actions\/checkout@|npm ci|npx |npm run/, `refresh.yml: ${job} runs repository code`);
  });

  it("no expression is interpolated into a shell script: every value reaches `run:` through the environment", () => {
    for (const f of files) {
      const scripts = runScripts(code(f));
      assert.ok(scripts.length >= 4, `${f}: run scripts found`);
      for (const script of scripts) assert.ok(!script.includes("${{"), `${f}: \${{ }} inside a run script:\n${script.split("\n").find((l) => l.includes("${{"))}`);
    }
  });

  it("refresh.yml: the gate's brief alert and the restore step's verdict reach the alert job as job outputs", () => {
    const refresh = code("refresh.yml");
    const build = jobText(refresh, "build");
    assert.match(build, /^ {6}state_lost: \$\{\{ steps\.restore\.outputs\.lost \}\}$/m);
    assert.match(build, /^ {6}brief_alert: \$\{\{ steps\.gate\.outputs\.brief_alert \}\}$/m);
    const alert = jobText(refresh, "alert");
    assert.match(alert, /STATE_LOST: \$\{\{ needs\.build\.outputs\.state_lost \}\}/);
    assert.match(alert, /BRIEF_ALERT: \$\{\{ needs\.build\.outputs\.brief_alert \}\}/);
    assert.match(alert, /- name: Open, update or close the Daily Brief issue\n {8}if: \$\{\{ !cancelled\(\) \}\}/, "a run cancelled by hand does not touch the brief issue either");
    assert.equal(alert.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)?.length, 2, "the token is on the two issue steps only");
    // The gate step is the one that writes the output, and it runs on every build.
    assert.match(build, /- name: Freshness and quality gate\n {8}id: gate\n/);
  });

  it("refresh.yml: the site is uploaded AFTER the state was taken out of it, and the state artifact comes from public/", () => {
    const build = jobText(code("refresh.yml"), "build");
    const order = ["- name: Build site", "- name: Check dist", "- name: Upload Pages artifact", "- name: Upload state artifact"].map((n) => build.indexOf(n));
    assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), `step order ${order.join(", ")}`);
    assert.match(build, /PUBLISH_STATE: \$\{\{ vars\.V2_PUBLISH_STATE \}\}/);
    assert.match(build, /name: v2-state\n {10}path: \|\n {12}public\/data\/v2\/state\.json\n {12}public\/data\/v2\/status\.json\n {10}if-no-files-found: error/);
    const restore = stepScript("refresh.yml", "Restore pipeline state");
    assert.ok(restore.indexOf("git fetch") < restore.indexOf("curl -fsS --max-time 30"), "the data branch is asked first");
  });

  it("feed-audit.yml: an out-of-date SBOM is a warning in the weekly run, never a failure", () => {
    const audit = code("feed-audit.yml");
    assert.match(audit, /id: sbom\n {8}continue-on-error: true\n {8}timeout-minutes: \d+\n {8}run: npx --no-install tsx scripts\/generate-sbom\.ts --check/);
    assert.match(audit, /^ {6}sbom: \$\{\{ steps\.sbom\.outcome \}\}$/m);
    assert.match(audit, /"\$SBOM" = failure \]; then\n\s+echo "::warning title=SBOM::/);
  });
});

describe("workflows: the state hand-over, executed (real git against a local bare repository)", { skip: SHELL_OK ? false : "needs bash, git and jq" }, () => {
  const STATE = (savedAt: string, marker: string): string => JSON.stringify({ schemaVersion: 2, buildId: savedAt, savedAt, firstSeen: { [marker]: savedAt }, recent: [], health: {}, lastGood: {}, resolvedUrls: {}, lead: null });
  const T1 = "2026-11-20T02:00:00.000Z";
  const T2 = "2026-11-20T02:30:00.000Z";

  interface World {
    sb: Sandbox;
    /** Run the persist job's script with this state (and a status.json). */
    persist(state: string): ReturnType<Sandbox["run"]>;
    /** Run the build job's restore script; `live` = files the stub site serves (path under the site base -> text). */
    restore(live?: Record<string, string>): ReturnType<Sandbox["run"]> & { restored: string | null };
    branchFiles(): string[];
  }

  function world(): World {
    const sb = sandbox();
    const remoteRoot = path.join(sb.root, "remote");
    fs.mkdirSync(path.join(remoteRoot, "owner"), { recursive: true });
    const git = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remoteRoot}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://x-access-token:test-token@github.com/",
    };
    // The "GitHub" side and the "checkout" the build job runs in.
    assert.equal(sb.run(`git init --quiet --bare "${remoteRoot}/owner/repo.git" && git init --quiet --initial-branch=main .`, git).status, 0);
    // curl: serves files from $SITE_DIR by URL path (query ignored); anything else is a 404 (exit 22, as curl -f).
    writeStub(
      sb.bin,
      "curl",
      [
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --max-time|--retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
        'p="${url#*://}"; p="${p#*/}"; p="${p%%\\?*}"',
        'f="${SITE_DIR:-/nonexistent}/${p}"',
        '[ -f "$f" ] || exit 22',
        'if [ -z "$out" ]; then cat "$f"; elif [ "$out" != /dev/null ]; then cp "$f" "$out"; fi',
      ].join("\n"),
    );
    const dest = path.join(sb.root, "work/public/data/v2/state.json");
    return {
      sb,
      persist(state) {
        const src = path.join(sb.root, "runner/v2-state");
        fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, "state.json"), state);
        fs.writeFileSync(path.join(src, "status.json"), '{"schema":1}');
        return sb.run(stepScript("refresh.yml", "Force-push one orphan commit to the data branch"), { ...git, GITHUB_TOKEN: "test-token", SRC: src });
      },
      restore(live = {}) {
        const site = path.join(sb.root, "site");
        fs.rmSync(site, { recursive: true, force: true });
        for (const [rel, text] of Object.entries(live)) {
          fs.mkdirSync(path.dirname(path.join(site, "app", rel)), { recursive: true });
          fs.writeFileSync(path.join(site, "app", rel), text);
        }
        const r = sb.run(stepScript("refresh.yml", "Restore pipeline state"), { ...git, GH_TOKEN: "test-token", SITE_URL: "https://site.invalid/app/", SITE_DIR: site });
        return { ...r, restored: fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null };
      },
      branchFiles() {
        const r = sb.run(`git --git-dir "${remoteRoot}/owner/repo.git" ls-tree --name-only refs/heads/data && git --git-dir "${remoteRoot}/owner/repo.git" rev-list --count refs/heads/data`, git);
        return r.stdout.trim().split("\n");
      },
    };
  }

  it("PRIMARY path: what the persist job pushed is what the next build restores - with no copy on the site at all", () => {
    const w = world();
    try {
      const pushed = w.persist(STATE(T1, "first"));
      assert.equal(pushed.status, 0, pushed.stderr + pushed.stdout);
      assert.match(pushed.stdout, /Pushed one orphan commit to refs\/heads\/data \(attempt 1\)/);
      assert.deepEqual(w.branchFiles(), ["README.md", "state.json", "status.json", "1"], "one orphan commit holding the state");

      const r = w.restore({ "data/v2/status.json": "{}" });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.restored, STATE(T1, "first"), "byte-identical");
      assert.deepEqual(r.output, { source: "data branch", lost: "false" });
      assert.match(r.stdout, /State restored from: data branch \(saved 2026-11-20T02:00:00\.000Z, \d+ bytes\)/);
      assert.match(r.summary, /State restored from: \*\*data branch\*\*/);
      assert.doesNotMatch(r.stdout, /::warning/);

      // The next run's push REPLACES the branch (still one commit), and the next restore sees the new state.
      assert.equal(w.persist(STATE(T2, "second")).status, 0);
      assert.deepEqual(w.branchFiles().at(-1), "1");
      assert.equal(w.restore().restored, STATE(T2, "second"));
    } finally {
      w.sb.cleanup();
    }
  });

  it("FALLBACK path: without a usable data branch a copy on the live site is restored; a strictly newer live copy also wins", () => {
    const w = world();
    try {
      // No data branch yet (first deployment with V2_PUBLISH_STATE=true, or a deleted branch).
      const onlyLive = w.restore({ "data/v2/state.json": STATE(T1, "live"), "data/v2/status.json": "{}" });
      assert.equal(onlyLive.status, 0, onlyLive.stderr);
      assert.deepEqual([onlyLive.restored, onlyLive.output.source, onlyLive.output.lost], [STATE(T1, "live"), "live site", "false"]);
      assert.match(onlyLive.stdout, /Data branch: no valid schemaVersion 2 state\.json on branch 'data'/);

      // Both valid: the branch is used ... unless the live copy is strictly newer (deploy succeeded, persist failed).
      assert.equal(w.persist(STATE(T1, "branch")).status, 0);
      assert.equal(w.restore({ "data/v2/state.json": STATE(T1, "live") }).output.source, "data branch", "same age: the primary wins");
      assert.equal(w.restore({ "data/v2/state.json": STATE("2026-11-20T01:00:00.000Z", "live") }).output.source, "data branch", "older live copy");
      const newer = w.restore({ "data/v2/state.json": STATE(T2, "live") });
      assert.deepEqual([newer.output.source, newer.restored], ["live site", STATE(T2, "live")]);

      // A branch whose state.json is not a schemaVersion 2 state is not used.
      assert.equal(w.persist(STATE(T2, "good")).status, 0);
      const bad = w.persist(JSON.stringify({ schemaVersion: 1, savedAt: T2 }));
      assert.notEqual(bad.status, 0, "persist refuses to push a file that is not a state");
      assert.match(bad.stdout, /::error title=persist::state\.json is missing or not a schemaVersion 2 state file/);
      assert.equal(w.restore().restored, STATE(T2, "good"), "the refused push left the last good snapshot in place");
    } finally {
      w.sb.cleanup();
    }
  });

  it("FAILURE mode: no state anywhere - a stale file is removed, the build starts empty, and it is reported only when the site is already up", () => {
    const w = world();
    try {
      // A leftover from an earlier step must never be mistaken for restored state.
      const dest = path.join(w.sb.root, "work/public/data/v2/state.json");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, STATE(T1, "stale leftover"));

      const firstEver = w.restore();
      assert.equal(firstEver.status, 0, firstEver.stderr);
      assert.equal(firstEver.restored, null, "nothing is restored: the pipeline bootstraps (run.test.ts: 'no usable state')");
      assert.deepEqual(firstEver.output, { source: "none (starting empty)", lost: "false" });
      assert.doesNotMatch(firstEver.stdout, /::warning/, "a first deployment is not an incident");

      const siteUp = w.restore({ "data/v2/status.json": "{}" });
      assert.equal(siteUp.status, 0);
      assert.equal(siteUp.restored, null);
      assert.deepEqual(siteUp.output, { source: "none (starting empty)", lost: "true" });
      assert.match(siteUp.stdout, /^::warning title=state restore::the live site is up but no valid state\.json was found on the data branch or the live site/m);

      // Unusable copies everywhere: same verdict.
      const junk = w.restore({ "data/v2/state.json": "<!doctype html><title>404</title>", "data/v2/status.json": "{}" });
      assert.deepEqual([junk.restored, junk.output.lost], [null, "true"]);
      const truncated = w.restore({ "data/v2/state.json": STATE(T1, "x").slice(0, 40), "data/v2/status.json": "{}" });
      assert.deepEqual([truncated.restored, truncated.output.lost], [null, "true"]);
    } finally {
      w.sb.cleanup();
    }
  });

  it("nothing from the state file reaches the log except a well-formed timestamp", () => {
    const w = world();
    try {
      const hostile = JSON.stringify({ schemaVersion: 2, savedAt: "2026-11-20\n::error title=pwned::x\n**bold** [link](https://evil.example/)", firstSeen: {} });
      const r = w.restore({ "data/v2/state.json": hostile });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.output.source, "live site");
      assert.doesNotMatch(r.stdout + r.summary, /pwned|evil\.example|\*\*bold/);
      assert.match(r.stdout, /State restored from: live site \(saved at an unreadable time, \d+ bytes\)/);
      assert.deepEqual(Object.keys(r.output).sort(), ["lost", "source"], "no extra output lines were smuggled in");
    } finally {
      w.sb.cleanup();
    }
  });

  it("dist check: the state is taken out of the site by default, kept with V2_PUBLISH_STATE=true, and a build without state is not deployed", () => {
    const sb = sandbox();
    try {
      const script = stepScript("refresh.yml", "Check dist");
      const lay = (withState: boolean): void => {
        fs.rmSync(path.join(sb.root, "work"), { recursive: true, force: true });
        for (const f of ["dist/index.html", "dist/data/v2/front.json", "dist/data/v2/status.json", "dist/data/v2/state.json", "public/data/v2/state.json"]) {
          if (!withState && f === "public/data/v2/state.json") continue;
          fs.mkdirSync(path.dirname(path.join(sb.root, "work", f)), { recursive: true });
          fs.writeFileSync(path.join(sb.root, "work", f), "{}");
        }
      };
      const inDist = (): boolean => fs.existsSync(path.join(sb.root, "work/dist/data/v2/state.json"));
      const inPublic = (): boolean => fs.existsSync(path.join(sb.root, "work/public/data/v2/state.json"));

      for (const value of ["", "false", "TRUE", "1"]) {
        lay(true);
        const r = sb.run(script, { PUBLISH_STATE: value });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual([inDist(), inPublic()], [false, true], `V2_PUBLISH_STATE="${value}": not in the site, still there for the state artifact`);
        assert.match(r.stdout, /state\.json is not part of the site/);
      }
      lay(true);
      const kept = sb.run(script, { PUBLISH_STATE: "true" });
      assert.deepEqual([kept.status, inDist(), inPublic()], [0, true, true]);
      assert.match(kept.stdout, /V2_PUBLISH_STATE=true: state\.json is published with the site/);

      lay(false);
      const none = sb.run(script, { PUBLISH_STATE: "" });
      assert.equal(none.status, 1);
      assert.match(none.stdout, /::error title=dist check::public\/data\/v2\/state\.json is missing or empty/);

      lay(true);
      fs.rmSync(path.join(sb.root, "work/dist/data/v2/front.json"));
      assert.equal(sb.run(script, { PUBLISH_STATE: "" }).status, 1, "the existing dist checks still hold");
    } finally {
      sb.cleanup();
    }
  });
});

describe("workflows: the alert steps, executed (stub gh)", { skip: SHELL_OK ? false : "needs bash, git and jq" }, () => {
  interface GhRun {
    status: number | null;
    stdout: string;
    calls: string[];
    body: string;
  }
  /** Run an alert step with a stub `gh` that lists `openIssue` ("<number> <updated_at>" or "") and records every call. */
  function withGh(step: string, env: Record<string, string>, openIssue = "", apiFails = false): GhRun {
    const sb = sandbox();
    try {
      const log = path.join(sb.root, "gh.log");
      const body = path.join(sb.root, "gh.body");
      writeStub(
        sb.bin,
        "gh",
        [
          'printf "%s\\n" "$*" >> "$GH_LOG"',
          'if [ "$1" = api ]; then [ "${GH_API_FAIL:-}" = 1 ] && exit 1; [ -n "${GH_ISSUES:-}" ] && printf "%s\\n" "$GH_ISSUES"; exit 0; fi',
          'while [ $# -gt 0 ]; do if [ "$1" = --body-file ]; then cat "$2" > "$GH_BODY"; fi; shift; done',
          "exit 0",
        ].join("\n"),
      );
      const r = sb.run(stepScript("refresh.yml", step), { GH_TOKEN: "test-token", GH_REPO: "owner/repo", GH_LOG: log, GH_BODY: body, GH_ISSUES: openIssue, GH_API_FAIL: apiFails ? "1" : "", ...env });
      const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("api ")) : [];
      return { status: r.status, stdout: r.stdout + r.stderr, calls, body: fs.existsSync(body) ? fs.readFileSync(body, "utf8") : "" };
    } finally {
      sb.cleanup();
    }
  }
  const OK = { R_BUILD: "success", R_DEPLOY: "success", R_PERSIST: "success", FAILED_STEP: "", STATE_LOST: "false", COMMENT_EVERY_MINUTES: "180" };
  const REFRESH = "Open, update or close the rolling issue";
  const BRIEF = "Open, update or close the Daily Brief issue";
  // An updated_at the throttle cannot parse counts as "long ago", which keeps `date -d` (GNU only) out of these tests.
  const OLD_ISSUE = "17 2026-11-19T00:00:00.000Z";
  const ALERT = "brief: the Claude brief has failed 6 builds in a row (http-4xx) although an API key is configured - the Daily Brief is not shown; check the key, the model id and the API status";

  it("refresh issue: a green run that lost its state opens the issue and names the escape hatch; it is not closed until the state is back", () => {
    const opened = withGh(REFRESH, { ...OK, STATE_LOST: "true" });
    assert.equal(opened.status, 0, opened.stdout);
    assert.equal(opened.calls.length, 1);
    assert.match(opened.calls[0], /^issue create --title V2 refresh failing --body-file \S+ --assignee owner$/);
    assert.match(opened.body, /^The V2 refresh needs attention: state restore \(no saved state found - built from empty\)\.$/m);
    assert.match(opened.body, /- Effect: the site was refreshed\./);
    assert.match(opened.body, /- State: the site is up, but no valid state\.json was found on the data branch/);
    assert.match(opened.body, /V2_PUBLISH_STATE=true/);

    const still = withGh(REFRESH, { ...OK, STATE_LOST: "true" }, OLD_ISSUE);
    assert.deepEqual(still.calls.map((c) => c.split(" ").slice(0, 3).join(" ")), ["issue comment 17"], "commented on, not closed");

    const recovered = withGh(REFRESH, OK, OLD_ISSUE);
    assert.equal(recovered.calls.length, 1);
    assert.match(recovered.calls[0], /^issue close 17 --comment Recovered: .* restored its state, built, deployed and persisted state successfully/);
    assert.deepEqual(withGh(REFRESH, OK).calls, [], "all good and nothing open: no call");
  });

  it("refresh issue: failures are reported with their effect; a failed persist says what the next build will do", () => {
    const build = withGh(REFRESH, { ...OK, R_BUILD: "failure", R_DEPLOY: "skipped", R_PERSIST: "skipped", FAILED_STEP: "data gate (hold)" });
    assert.match(build.body, /needs attention: build \(failed\)\./);
    assert.match(build.body, /- Build stopped at: data gate \(hold\)/);
    assert.match(build.body, /nothing was deployed; the previous deploy keeps serving and goes stale/);
    const persist = withGh(REFRESH, { ...OK, R_PERSIST: "failure" });
    assert.match(persist.body, /needs attention: persist \(failed\)\./);
    assert.match(persist.body, /this build's state was not saved to the data branch\. The next build continues from the previous snapshot/);
    const timedOut = withGh(REFRESH, { ...OK, R_BUILD: "cancelled", R_DEPLOY: "skipped", R_PERSIST: "skipped" });
    assert.match(timedOut.body, /build \(cancelled or timed out\)/, "a job that hit its own timeout still alerts");
    assert.deepEqual(withGh(REFRESH, { ...OK, R_BUILD: "failure" }, "", true).calls, [], "when issues cannot be listed nothing is opened blindly");
  });

  it("brief issue: opened from the gate's alert with only its number and reason code; closed when the gate is quiet again", () => {
    const opened = withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: ALERT, COMMENT_EVERY_MINUTES: "1440" });
    assert.equal(opened.status, 0, opened.stdout);
    assert.equal(opened.calls.length, 1);
    assert.match(opened.calls[0], /^issue create --title V2 Daily Brief failing --body-file \S+ --assignee owner$/);
    assert.match(opened.body, /^Claude has not written the Daily Brief for 6 builds in a row \(reason code `http-4xx`\), although an ANTHROPIC_API_KEY is configured\./);
    assert.match(opened.body, /remove the ANTHROPIC_API_KEY secret/);
    assert.match(opened.body, /github\.invalid\/owner\/repo\/actions\/runs\/4242/);

    const again = withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: ALERT.replace("6 builds", "54 builds"), COMMENT_EVERY_MINUTES: "1440" }, OLD_ISSUE);
    assert.deepEqual(again.calls.map((c) => c.split(" ").slice(0, 3).join(" ")), ["issue comment 17"]);
    assert.match(again.body, /for 54 builds in a row/);

    // Quiet gate on a successful build (Claude answered, or the key was removed): close. No gate, no verdict.
    const closed = withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: "", COMMENT_EVERY_MINUTES: "1440" }, OLD_ISSUE);
    assert.match(closed.calls[0], /^issue close 17 --comment Recovered: the gate of .* raised no Daily Brief alert/);
    assert.deepEqual(withGh(BRIEF, { R_BUILD: "failure", BRIEF_ALERT: "", COMMENT_EVERY_MINUTES: "1440" }, OLD_ISSUE).calls, [], "a build that never reached the gate says nothing about the brief");
    assert.deepEqual(withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: "", COMMENT_EVERY_MINUTES: "1440" }).calls, [], "the normal case: no alert, no issue, no call");
  });

  it("brief issue: text that is not exactly the gate's alert is never acted on or repeated", () => {
    const hostile = withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: `${ALERT.slice(0, 66)} $(touch pwned) \`id\` @everyone [x](https://evil.example/)`, COMMENT_EVERY_MINUTES: "1440" });
    assert.equal(hostile.calls.length, 1, "the prefix has the gate's shape, so the issue is opened ...");
    assert.doesNotMatch(hostile.body, /pwned|@everyone|evil\.example/, "... but only the number and the reason code are repeated");
    for (const junk of ["::error title=x::y", "brief: something else", "brief: the Claude brief has failed many builds in a row (http-4xx) ", "brief: the Claude brief has failed 6 builds in a row (HTTP 401: sk-ant-xyz) "]) {
      const r = withGh(BRIEF, { R_BUILD: "success", BRIEF_ALERT: junk, COMMENT_EVERY_MINUTES: "1440" }, OLD_ISSUE);
      assert.deepEqual(r.calls, [], junk);
      assert.match(r.stdout, /::warning title=brief alert::the gate wrote a brief alert this job does not recognise - ignored/);
    }
  });
});

