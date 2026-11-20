import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFeedFixture } from "../../../test/helpers/fixtures";
import { parseReleaseUrl, parseTag, releaseTitle, selectRelease, tagScheme, type ReleaseEntry } from "./githubRelease";

const NOW = new Date("2026-11-20T01:10:00Z");

/** [raw title, tag, updated] in feed order -> entries for a repo. */
type Row = [title: string, tag: string, updated: string];
const entries = (repo: string, rows: readonly Row[]): ReleaseEntry[] =>
  rows.map(([title, tag, updated]) => ({ title, link: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`, publishedRaw: updated }));

// Raw releases.atom contents captured 2026-11-19 (review: fetch finding 1, tests-maintainability
// finding 2), in feed order. `v1` is what production emitted that day.
const FEEDS: { repo: string; releaseLine?: string[]; rows: Row[]; v1: string; expectTag: string | null; expectTitle: string | null }[] = [
  {
    repo: "langchain-ai/langchain",
    v1: "langchain v0.3.0 released",
    expectTag: "langchain==1.5.2",
    expectTitle: "langchain 1.5.2 released",
    rows: [
      ["langchain-openrouter==0.3.0", "langchain-openrouter==0.3.0", "2026-11-19T15:03:21Z"],
      ["langchain-openai==1.8.4", "langchain-openai==1.8.4", "2026-11-19T21:36:53Z"],
      ["langchain-openai==1.8.3", "langchain-openai==1.8.3", "2026-11-19T00:38:59Z"],
      ["langchain-xai==1.4.1", "langchain-xai==1.4.1", "2026-11-18T17:29:54Z"],
      ["langchain-openai==1.8.2", "langchain-openai==1.8.2", "2026-11-18T16:53:07Z"],
      ["langchain-groq==1.2.1", "langchain-groq==1.2.1", "2026-11-18T17:27:24Z"],
      ["langchain-deepseek==1.2.1", "langchain-deepseek==1.2.1", "2026-11-18T17:27:46Z"],
      ["langchain-core==1.8.3", "langchain-core==1.8.3", "2026-11-18T15:38:38Z"],
      ["langchain-anthropic==1.7.11", "langchain-anthropic==1.7.11", "2026-11-18T15:20:21Z"],
      ["langchain==1.5.2", "langchain==1.5.2", "2026-11-18T22:30:45Z"],
    ],
  },
  {
    repo: "sgl-project/sglang",
    v1: "sglang v0.1.0 released",
    expectTag: "v0.5.23",
    expectTitle: "sglang v0.5.23 released",
    rows: [
      ["router-v0.1.0", "router-v0.1.0", "2026-11-18T00:34:15Z"],
      ["v0.5.23", "v0.5.23", "2026-11-02T22:14:10Z"],
      ["v0.5.22", "v0.5.22", "2026-10-19T05:55:53Z"],
      ["v0.5.15.post1", "v0.5.15.post1", "2026-07-14T08:43:33Z"],
    ],
  },
  {
    repo: "QwenLM/qwen-code",
    v1: "qwen-code v0.28.0-nightly.20261118.d9ac287c9f released",
    expectTag: "v0.28.0",
    expectTitle: "qwen-code v0.28.0 released",
    rows: [
      ["Release v0.28.0-nightly.20261118.d9ac287c9f", "v0.28.0-nightly.20261118.d9ac287c9f", "2026-11-18T23:25:27Z"],
      ["Release v0.28.1-preview.0", "v0.28.1-preview.0", "2026-11-17T19:56:30Z"],
      ["Release v0.28.0", "v0.28.0", "2026-11-17T11:20:07Z"],
      ["SDK TypeScript Release v0.1.35", "sdk-typescript-v0.1.35", "2026-11-17T12:07:45Z"],
      ["Qwen Code Desktop v0.28.0", "desktop-v0.28.0", "2026-11-17T12:31:07Z"],
      ["Release v0.27.4-nightly.20261116.eb3a599ef3", "v0.27.4-nightly.20261116.eb3a599ef3", "2026-11-16T23:24:42Z"],
      ["Release v0.27.4", "v0.27.4", "2026-11-15T09:06:37Z"],
    ],
  },
  {
    repo: "openai/codex",
    releaseLine: ["rust"],
    v1: "codex v0.172.0-alpha.2 released",
    expectTag: "rust-v0.170.0",
    expectTitle: "codex 0.170.0 released",
    rows: [
      ["0.172.0-alpha.2", "rust-v0.172.0-alpha.2", "2026-11-19T15:49:51Z"],
      ["rust-v0.171.0-alpha.13.1", "rust-v0.171.0-alpha.13.1", "2026-11-19T20:39:52Z"],
      ["0.172.0-alpha.1", "rust-v0.172.0-alpha.1", "2026-11-18T18:01:02Z"],
      ["0.171.0-alpha.13", "rust-v0.171.0-alpha.13", "2026-11-18T05:52:48Z"],
      ["0.170.0", "rust-v0.170.0", "2026-11-18T03:45:39Z"],
      ["0.170.0-alpha.4.2", "rust-v0.170.0-alpha.4.2", "2026-11-18T02:02:46Z"],
      ["0.169.1", "rust-v0.169.1", "2026-11-17T22:22:49Z"],
    ],
  },
  {
    repo: "BerriAI/litellm",
    v1: "litellm v1.111.0-rc.2 released",
    expectTag: "v1.110.1",
    expectTitle: "litellm v1.110.1 released",
    rows: [
      ["v1.111.0-rc.2", "v1.111.0-rc.2", "2026-11-19T07:21:56Z"],
      ["v1.110.1", "v1.110.1", "2026-11-19T07:21:55Z"],
      ["v1.109.2", "v1.109.2", "2026-11-19T07:21:54Z"],
      // The LTS backport has the newest <updated> of the feed: date order would pick it.
      ["1.108.12 (LTS)", "v1.108.12", "2026-11-19T07:22:06Z"],
      ["v1.106.11", "v1.106.11", "2026-11-19T07:21:52Z"],
      ["v1.110.0", "v1.110.0", "2026-11-18T01:36:48Z"],
      ["v1.111.0-dev.4", "v1.111.0-dev.4", "2026-11-15T05:09:04Z"],
    ],
  },
  {
    repo: "vllm-project/vllm",
    v1: "vllm v0.34.0 released + 'rc0: [Transformers backend] Migrate Gemma and StableLM (#66393)'",
    expectTag: "v0.34.0",
    expectTitle: "vllm v0.34.0 released",
    rows: [
      ["v0.34.0", "v0.34.0", "2026-11-18T21:02:33Z"],
      ["v0.34.0rc4", "v0.34.0rc4", "2026-11-14T10:15:55Z"],
      ["v0.34.0rc0: [Transformers backend] Migrate Gemma and StableLM (#66393)", "v0.34.0rc0", "2026-11-08T18:38:57Z"],
      ["v0.33.0", "v0.33.0", "2026-11-01T09:21:10Z"],
      ["v0.33.0", "v0.33.0rc3", "2026-11-02T10:11:34Z"],
    ],
  },
  {
    repo: "ollama/ollama",
    v1: "ollama v0.40.17 released (the tag is v0.40.17-rc1)",
    expectTag: "v0.40.16",
    expectTitle: "ollama v0.40.16 released",
    rows: [
      ["v0.40.17", "v0.40.17-rc1", "2026-11-16T19:02:48Z"],
      ["v0.40.17-rc0", "v0.40.17-rc0", "2026-11-10T21:42:11Z"],
      ["v0.40.16", "v0.40.16", "2026-11-09T23:45:36Z"],
      ["v0.40.16-rc0: Add ripple preview support to the MLX runner (#19592)", "v0.40.16-rc0", "2026-11-08T00:36:53Z"],
      ["v0.40.15", "v0.40.15", "2026-11-06T01:47:18Z"],
      ["v0.40.15-rc1: llama.cpp: version bump b12111 (#19530)", "v0.40.15-rc1", "2026-11-05T01:31:38Z"],
    ],
  },
  {
    repo: "google-gemini/gemini-cli",
    v1: "gemini-cli v0.71.0-preview.0 released",
    expectTag: "v0.70.0",
    expectTitle: "gemini-cli v0.70.0 released",
    rows: [
      ["Release v0.71.0-preview.0", "v0.71.0-preview.0", "2026-11-19T20:48:23Z"],
      ["Release v0.70.0", "v0.70.0", "2026-11-19T21:08:05Z"],
      ["Release v0.70.0-preview.0", "v0.70.0-preview.0", "2026-11-19T00:09:03Z"],
      ["Release v0.69.0", "v0.69.0", "2026-11-19T01:45:47Z"],
      ["Release v0.67.0-nightly.20261104.g89e9d25d6", "v0.67.0-nightly.20261104.g89e9d25d6", "2026-11-04T01:20:49Z"],
    ],
  },
  {
    repo: "ggml-org/llama.cpp",
    v1: "llama.cpp b12549 released + 'b12550: ggml : add backend scheduler tests (#27258)'",
    expectTag: "b12553",
    expectTitle: "llama.cpp b12553 released",
    rows: [
      ["b12553: mtmd : fix YuE2 projector loading (#32606)", "b12553", "2026-11-19T18:11:11Z"],
      ["b12552", "b12552", "2026-11-19T21:53:02Z"],
      ["b12551", "b12551", "2026-11-19T21:40:04Z"],
      ["b12550", "b12550", "2026-11-19T21:22:23Z"],
      ["b12549", "b12549", "2026-11-19T17:51:04Z"],
    ],
  },
  {
    repo: "lobehub/lobe-chat",
    v1: "lobe-chat v0.0.140 released + 'cli-release/v0.0.134: 🗑️ chore(settings): …'",
    // Every entry is the CLI sub-package (a tag every 15 minutes): the repo has no line this run.
    expectTag: null,
    expectTitle: null,
    rows: [
      ["cli-release/v0.0.140", "cli-release/v0.0.140", "2026-11-19T20:05:23Z"],
      ["cli-release/v0.0.139", "cli-release/v0.0.139", "2026-11-19T20:01:48Z"],
      ["cli-release/v0.0.134: 🗑️ chore(settings): remove the right-click menu mode setting (#23493)", "cli-release/v0.0.134", "2026-11-19T16:51:25Z"],
    ],
  },
  {
    repo: "Significant-Gravitas/AutoGPT",
    releaseLine: ["autogpt-platform-beta"],
    v1: "AutoGPT v0.12.0 released + 'Preview seed fixture (rolling)'",
    expectTag: "autogpt-platform-beta-v0.12.0",
    expectTitle: "AutoGPT Platform v0.12.0 released",
    rows: [
      ["🚀 AutoGPT Platform v0.12.0", "autogpt-platform-beta-v0.12.0", "2026-11-19T18:03:33Z"],
      ["Preview seed fixture (rolling)", "preview-seed-fixture", "2026-11-19T14:05:53Z"],
      ["autogpt-platform-beta-v0.11.3", "autogpt-platform-beta-v0.11.3", "2026-11-15T08:59:39Z"],
      ["🚀 Release `autogpt-platform-beta-v0.9.0`", "autogpt-platform-beta-v0.9.0", "2026-10-23T01:28:07Z"],
    ],
  },
  {
    repo: "modelcontextprotocol/modelcontextprotocol",
    v1: "modelcontextprotocol spec  released (double space, no version)",
    expectTag: "2026-07-28",
    expectTitle: "modelcontextprotocol 2026-07-28 released",
    rows: [
      ["2026-07-28", "2026-07-28", "2026-07-28T16:47:49Z"],
      ["2026-07-28 RC", "2026-07-28-RC", "2026-07-28T16:48:26Z"],
      ["2025-11-25", "2025-11-25", "2025-11-25T21:17:42Z"],
      ["2024-11-05-final", "2024-11-05-final", "2025-03-26T13:53:30Z"],
    ],
  },
  {
    repo: "unslothai/unsloth",
    v1: "AMD NPU + video diffusion LoRA (every tag is -beta; all are real releases)",
    expectTag: "v0.1.920-beta",
    expectTitle: "unsloth v0.1.920-beta: AMD NPU + video diffusion LoRA",
    rows: [
      ["AMD NPU + video diffusion LoRA", "v0.1.920-beta", "2026-11-19T15:00:48Z"],
      ["Computer Use + Translate + MiniMax-H3-Image + New Model Picker", "v0.1.919-beta", "2026-11-18T10:41:07Z"],
      ["Large Performance Fixes", "v0.1.916-beta", "2026-11-06T15:20:21Z"],
    ],
  },
  {
    repo: "huggingface/transformers",
    v1: "Mistral Large 4 (Le Chonk)",
    expectTag: "v5.22.0",
    expectTitle: "transformers v5.22.0: Mistral Large 4 (Le Chonk)",
    rows: [
      ["Mistral Large 4 (Le Chonk)", "v5.22.0", "2026-10-29T14:16:58Z"],
      ["Patch release v5.21.1", "v5.21.1", "2026-10-20T10:00:00Z"],
    ],
  },
];

describe("selectRelease - one line per repo (raw feed vs emitted table)", () => {
  for (const feed of FEEDS) {
    it(`${feed.repo} -> ${feed.expectTitle ?? "no line"}   (V1: ${feed.v1})`, () => {
      const list = entries(feed.repo, feed.rows);
      const pick = selectRelease(list, feed.repo, new Date("2026-11-19T21:00:00Z"), feed.releaseLine);
      const chosenTag = pick.chosen === null ? null : feed.rows[pick.chosen][1];
      assert.equal(chosenTag, feed.expectTag);
      assert.equal(pick.title, feed.expectTitle);
      // Every other entry is accounted for with a reason.
      assert.equal(pick.collapsed.size, list.length - (pick.chosen === null ? 0 : 1));
      for (const why of pick.collapsed.values()) assert.ok(why.length > 5, why);
      if (pick.title) {
        assert.doesNotMatch(pick.title, /\s{2,}|^\s|\s$/, "no double spaces");
        assert.doesNotMatch(pick.title, /\(#\d+\)/, "no commit subjects");
      }
    });
  }

  it("the repo is read from the entry links when not given", () => {
    const feed = FEEDS[0];
    assert.equal(selectRelease(entries(feed.repo, feed.rows)).title, feed.expectTitle);
  });

  it("gives collapse reasons that say what happened", () => {
    const feed = FEEDS.find((f) => f.repo === "ollama/ollama")!;
    const pick = selectRelease(entries(feed.repo, feed.rows), feed.repo);
    assert.match(pick.collapsed.get(0) ?? "", /pre-release v0\.40\.17-rc1 \(kept v0\.40\.16\)/);
    assert.match(pick.collapsed.get(4) ?? "", /older release v0\.40\.15/);
    const lc = FEEDS[0];
    assert.match(selectRelease(entries(lc.repo, lc.rows), lc.repo).collapsed.get(0) ?? "", /sub-package langchain-openrouter/);
    const gpt = FEEDS.find((f) => f.repo.endsWith("AutoGPT"))!;
    assert.match(selectRelease(entries(gpt.repo, gpt.rows), gpt.repo, 0, gpt.releaseLine).collapsed.get(1) ?? "", /unversioned tag preview-seed-fixture/);
  });

  it("a feed with only pre-releases keeps its highest one, labelled as what it is", () => {
    const rows: Row[] = [
      ["v0.40.17", "v0.40.17-rc1", "2026-11-16T19:02:48Z"],
      ["v0.40.17-rc0", "v0.40.17-rc0", "2026-11-10T21:42:11Z"],
    ];
    const pick = selectRelease(entries("ollama/ollama", rows), "ollama/ollama");
    assert.equal(pick.chosen, 0);
    assert.equal(pick.title, "ollama v0.40.17-rc1 released");
  });

  // Real feeds of 2026-11-20 (review PF-5). Version numbers of different tag schemes are not comparable.
  const MCP_SERVERS: Row[] = [
    ["v2.5.0", "v2.5.0", "2026-11-18T09:29:05Z"],
    ["v2.4.0", "v2.4.0", "2026-11-11T07:37:43Z"],
    ["v2.3.0", "v2.3.0", "2026-11-04T21:28:41Z"],
    ["v2.2.0", "v2.2.0", "2026-10-28T20:57:13Z"],
    ["v2.1.0", "v2.1.0", "2026-10-25T00:03:20Z"],
    ["v2.0.0", "v2.0.0", "2026-10-25T06:00:36Z"],
    ["v1.0.0", "v1.0.0", "2026-10-19T04:17:24Z"],
    ["Release 2026.8.31", "2026.8.31", "2026-08-31T20:34:32Z"],
    ["Release 2026.8.18", "2026.8.18", "2026-08-18T16:16:12Z"],
    ["Release 2026.7.10", "2026.7.10", "2026-07-10T03:39:07Z"],
  ];
  const WHISPER: Row[] = [
    ["v1.9.5", "v1.9.5", "2026-10-07T12:41:42Z"],
    ["b5454", "b5454", "2026-10-06T16:52:11Z"],
    ["v1.9.4", "v1.9.4", "2026-09-11T05:31:55Z"],
    ["b5130", "b5130", "2026-09-11T05:30:01Z"],
    ["b5127", "b5127", "2026-09-10T11:56:28Z"],
    ["v1.9.3", "v1.9.3", "2026-08-20T11:42:23Z"],
  ];
  const ATLAS: Row[] = [
    ["v2026.10", "v2026.10", "2026-10-28T22:55:37Z"],
    ["v6.1.0", "v6.1.0", "2026-10-28T22:35:03Z"],
    ["v2026.09", "v2026.09", "2026-09-15T15:04:08Z"],
    ["v6.0.0", "v6.0.0", "2026-05-27T18:05:14Z"],
    ["v5.6.1", "v5.6.1", "2026-05-06T01:59:35Z"],
  ];

  it("a repo that moved from calendar tags to semver announces its semver release (MCP servers v2.5.0, not 2026.8.31)", () => {
    const repo = "modelcontextprotocol/servers";
    const pick = selectRelease(entries(repo, MCP_SERVERS), repo, NOW);
    assert.equal(pick.chosen, 0);
    assert.equal(pick.title, "servers v2.5.0 released");
    assert.match(pick.collapsed.get(1) ?? "", /older release v2\.4\.0 \(kept v2\.5\.0\)/);
    assert.match(pick.collapsed.get(7) ?? "", /other tag scheme 2026\.8\.31 \(kept v2\.5\.0\)/);
  });

  it("CI build tags never outrank the versioned line they sit next to (whisper.cpp v1.9.5, not b5454)", () => {
    const repo = "ggml-org/whisper.cpp";
    const pick = selectRelease(entries(repo, WHISPER), repo, NOW);
    assert.equal(pick.title, "whisper.cpp v1.9.5 released");
    assert.match(pick.collapsed.get(1) ?? "", /other tag scheme b5454/);
    // The build tag is published up to a day BEFORE its version tag: the line must not flip to it and back.
    const early = selectRelease(entries(repo, [["b5600", "b5600", "2026-11-19T10:00:00Z"], ...WHISPER]), repo, NOW);
    assert.equal(early.title, "whisper.cpp v1.9.5 released");
    assert.equal(early.chosen, 1);
  });

  it("a repo with ONLY build tags keeps its build line (llama.cpp)", () => {
    const rows: Row[] = [["b12549", "b12549", "2026-11-19T10:00:00Z"], ["b12548", "b12548", "2026-11-19T08:00:00Z"]];
    assert.equal(selectRelease(entries("ggml-org/llama.cpp", rows), "ggml-org/llama.cpp", NOW).title, "llama.cpp b12549 released");
  });

  it("two parallel lines: the scheme of the newest entry wins (ATLAS v2026.10 stays, not v6.1.0)", () => {
    const repo = "mitre-atlas/atlas-data";
    const pick = selectRelease(entries(repo, ATLAS), repo, NOW);
    assert.equal(pick.title, "atlas-data v2026.10 released");
    assert.match(pick.collapsed.get(1) ?? "", /other tag scheme v6\.1\.0/);
  });

  it("inside one scheme the highest version still wins over a newer backport", () => {
    const rows: Row[] = [["v1.8.7", "v1.8.7", "2026-11-19T10:00:00Z"], ["v2.1.0", "v2.1.0", "2026-11-12T10:00:00Z"]];
    assert.equal(selectRelease(entries("acme/tool", rows), "acme/tool", NOW).title, "tool v2.1.0 released");
  });

  it("tagScheme classifies build, calendar and semantic tags", () => {
    const scheme = (tag: string): string => tagScheme(parseTag(tag));
    assert.deepEqual(["b5454", "2026.8.31", "v2026.10", "2026-07-28", "v2.5.0", "0.170.0", "rust-v0.170.0"].map(scheme), ["build", "calver", "calver", "calver", "semver", "semver", "semver"]);
  });

  it("the committed langchain feed fixture selects langchain==1.5.2 (9th of 10 entries)", () => {
    const xml = readFeedFixture("github-releases-langchain.atom");
    const list: ReleaseEntry[] = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      title: /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "",
      link: /<link[^>]*href="([^"]+)"/.exec(m[1])?.[1] ?? "",
      publishedRaw: /<updated>([^<]+)<\/updated>/.exec(m[1])?.[1] ?? null,
    }));
    assert.equal(list.length, 10);
    const pick = selectRelease(list);
    assert.equal(pick.title, "langchain 1.5.2 released");
    assert.equal(pick.chosen, 8);
    assert.match(list[8].link, /langchain%3D%3D1\.5\.2$/);
  });

  it("the committed llama.cpp fixture gives one build line, never the commit subject", () => {
    const xml = readFeedFixture("github-releases-llama-cpp-entity-heavy.atom");
    const list: ReleaseEntry[] = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      title: /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "",
      link: /<link[^>]*href="([^"]+)"/.exec(m[1])?.[1] ?? "",
      publishedRaw: /<updated>([^<]+)<\/updated>/.exec(m[1])?.[1] ?? null,
    }));
    assert.equal(selectRelease(list).title, "llama.cpp b12550 released");
  });

  it("empty input and junk never throw", () => {
    assert.deepEqual(selectRelease([]).chosen, null);
    const junk: ReleaseEntry[] = [
      { title: "", link: "not a url", publishedRaw: null },
      { title: "%E0%A4%A", link: "https://github.com/o/r/releases/tag/%E0%A4%A", publishedRaw: "garbage" },
      { title: "nightly", link: "https://github.com/o/r/releases/tag/nightly", publishedRaw: null },
    ];
    assert.doesNotThrow(() => selectRelease(junk));
    assert.equal(selectRelease(junk).chosen, null);
  });
});

describe("parseTag", () => {
  const cases: [string, Partial<ReturnType<typeof parseTag>>][] = [
    ["v0.5.23", { component: null, version: "v0.5.23", nums: [0, 5, 23], prerelease: false }],
    ["1.15.44", { component: null, version: "1.15.44", prerelease: false }],
    ["langchain-openrouter==0.3.0", { component: "langchain-openrouter", version: "0.3.0", prerelease: false }],
    ["langchain==1.5.2", { component: "langchain", version: "1.5.2" }],
    ["router-v0.1.0", { component: "router", version: "v0.1.0" }],
    ["cli-release/v0.0.140", { component: "cli-release", version: "v0.0.140" }],
    ["sdk-typescript-v0.1.35", { component: "sdk-typescript", version: "v0.1.35" }],
    ["rust-v0.172.0-alpha.2", { component: "rust", version: "v0.172.0-alpha.2", prerelease: true }],
    ["autogpt-platform-beta-v0.12.0", { component: "autogpt-platform-beta", version: "v0.12.0", prerelease: false }],
    ["@scope/pkg@1.2.3", { component: "@scope/pkg", version: "1.2.3" }],
    ["pkg-1.2.3", { component: "pkg", version: "1.2.3" }],
    ["v0.34.0rc0", { component: null, nums: [0, 34, 0], prerelease: true }],
    ["3.3.0b1", { component: null, prerelease: true }],
    ["v1.0.0a2", { prerelease: true }],
    ["v1.111.0-rc.2", { prerelease: true }],
    ["v1.111.0-dev.4", { prerelease: true }],
    ["v0.28.0-nightly.20261118.d9ac287c9f", { component: null, nums: [0, 28, 0], prerelease: true }],
    ["v0.71.0-preview.0", { prerelease: true }],
    ["v0.1.920-beta", { prerelease: true }],
    ["nightly-v1.2.3", { component: null, version: "v1.2.3", prerelease: true }],
    ["v0.5.15.post1", { nums: [0, 5, 15], prerelease: false }],
    ["v2.1.0-vscode", { component: null, version: "v2.1.0-vscode", prerelease: false }],
    ["v1.2.3-4.5", { component: null, prerelease: false }],
    ["b12549", { component: null, version: "b12549", nums: [12549], prerelease: false }],
    ["2026-07-28", { component: null, version: "2026-07-28", nums: [2026, 7, 28], prerelease: false }],
    ["2026-07-28-RC", { nums: [2026, 7, 28], prerelease: true }],
    ["2024-11-05-final", { prerelease: false }],
    ["preview-seed-fixture", { version: null, nums: [] }],
    ["nightly", { version: null }],
    ["", { version: null }],
  ];
  for (const [tag, expected] of cases) {
    it(JSON.stringify(tag), () => {
      const got = parseTag(tag);
      for (const [k, v] of Object.entries(expected)) assert.deepEqual(got[k as keyof typeof got], v, k);
    });
  }
});

describe("parseReleaseUrl", () => {
  it("reads owner/repo and the decoded tag", () => {
    assert.deepEqual(parseReleaseUrl("https://github.com/langchain-ai/langchain/releases/tag/langchain-openrouter%3D%3D0.3.0"), { repo: "langchain-ai/langchain", tag: "langchain-openrouter==0.3.0" });
    assert.deepEqual(parseReleaseUrl("https://github.com/lobehub/lobe-chat/releases/tag/cli-release%2Fv0.0.139"), { repo: "lobehub/lobe-chat", tag: "cli-release/v0.0.139" });
    assert.deepEqual(parseReleaseUrl("https://github.com/ollama/ollama/releases.atom"), { repo: "ollama/ollama", tag: null });
    assert.deepEqual(parseReleaseUrl("https://example.com/x"), { repo: null, tag: null });
    assert.doesNotThrow(() => parseReleaseUrl("https://github.com/o/r/releases/tag/%E0%A4%A"));
  });
});

describe("releaseTitle - function-level cases from the review", () => {
  const t = (raw: string, tag: string, repo = "acme/widget"): string => releaseTitle(raw, parseTag(tag), repo).title;
  const cases: [string, string, string, string][] = [
    ["tag-only", "v0.30.8", "v0.30.8", "widget v0.30.8 released"],
    ["'Release ' prefix", "Release v4.2.0", "v4.2.0", "widget v4.2.0 released"],
    ["V1: 'v0.34.0rc4' announced as final", "v0.34.0rc4", "v0.34.0rc4", "widget v0.34.0rc4 released"],
    ["V1: '- The Big Rewrite Lands Today'", "v2.0.0 - The Big Rewrite Lands Today", "v2.0.0", "widget v2.0.0: The Big Rewrite Lands Today"],
    ["V1 kept example", "Release v5.10.1: Add Mistral Small 3 support", "v5.10.1", "widget v5.10.1: Add Mistral Small 3 support"],
    ["V1 kept example (calendar version)", "2026.24: Hey Siri, Tell Me a Fable", "2026.24", "widget 2026.24: Hey Siri, Tell Me a Fable"],
    ["V1: 'widget  released' for 'v1'", "v1", "v1", "widget v1 released"],
    ["V1: 'widget  released' for a date tag", "2026-11-18", "2026-11-18", "widget 2026-11-18 released"],
    ["commit subject after a pre-release tag", "v0.30.5-rc0: llama.cpp version update (#16511)", "v0.30.5-rc0", "widget v0.30.5-rc0 released"],
    ["conventional commit", "v1.2.3: fix(parser): handle empty input gracefully today", "v1.2.3", "widget v1.2.3 released"],
    ["bracket-tagged commit", "v0.33.0rc1: [CI] Fix stale NVFP4 decode test selector on DGX Spark", "v0.33.0rc1", "widget v0.33.0rc1 released"],
    ["LTS label", "1.108.12 (LTS)", "v1.108.12", "widget 1.108.12 released"],
    ["title already in V1's synthesized form", "widget v5.23.0 released", "v5.23.0", "widget v5.23.0 released"],
    ["product name + version", "Qwen Code Desktop v0.28.0", "desktop-v0.28.0", "Qwen Code Desktop v0.28.0 released"],
    ["two-word headline is not enough", "Bug fixes", "v1.0.1", "widget v1.0.1 released"],
    ["emoji and backticks", "🚀 Release `v3.1.0`", "v3.1.0", "widget v3.1.0 released"],
  ];
  for (const [name, raw, tag, expected] of cases) it(`${name}: ${JSON.stringify(raw)}`, () => assert.equal(t(raw, tag), expected));

  it("only a human headline is not 'synthesized'", () => {
    assert.equal(releaseTitle("AMD NPU + video diffusion LoRA", parseTag("v0.1.920-beta"), "unslothai/unsloth").synthesized, false);
    assert.equal(releaseTitle("b12549", parseTag("b12549"), "ggml-org/llama.cpp").synthesized, true);
    assert.equal(releaseTitle("🚀 AutoGPT Platform v0.12.0", parseTag("autogpt-platform-beta-v0.12.0"), "Significant-Gravitas/AutoGPT").synthesized, true);
  });
});
