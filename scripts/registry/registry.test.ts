// Registry acceptance (WP1): integrity of the real registry, V1 name coverage, the review's hard
// rules (publishers, tiers, queries, scrapers) and the validator itself on broken data.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, sectionById, type SectionId } from "../../shared/sections";
import { compileTerms } from "../../shared/text";
import { registrableHost, urlKey } from "../../shared/url";
import { loadV1Sources } from "../../test/helpers/fixtures";
import { activeSources, indexSources, resolveSource } from "./defaults";
import {
  deniedOutlet,
  idForLegacyName,
  isRemovedLegacyName,
  isVettedPublisher,
  OUTLET_DENY,
  publisherById,
  publisherForHost,
  PUBLISHERS,
  REGISTRY,
  registryStats,
  REMOVED,
  sourceById,
  SOURCES,
  UNVETTED_OUTLET_TAG,
  UNVETTED_PUBLISHER_IDS,
  validateRegistry,
} from "./index";
import { outletProblems, type DeniedOutlet } from "./outlets";
import { loadV1Rows, migrationReport, renderMarkdown } from "../tools/import-sources";
import { FINREG_OWNER_TERMS, GOV_AI_TERMS, GOV_OWNER_TERMS, LOCAL_STACK_TERMS } from "./sources/shared";
import type { PublisherDef, SourceDef } from "./types";

const byId = (id: string): SourceDef => {
  const s = sourceById(id);
  assert.ok(s, `source ${id} is missing`);
  return s;
};
const ACTIVE = activeSources(SOURCES);

describe("registry integrity", () => {
  it("passes its own validator and exposes one consistent REGISTRY", () => {
    assert.deepEqual(validateRegistry(SOURCES, PUBLISHERS), []);
    assert.equal(REGISTRY.sources, SOURCES);
    assert.equal(REGISTRY.publishers, PUBLISHERS);
  });

  it("has unique ids, unique names and unique canonical urls", () => {
    assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
    assert.equal(new Set(SOURCES.map((s) => s.name.toLowerCase())).size, SOURCES.length);
    const keys = SOURCES.map((s) => urlKey(s.url));
    assert.ok(keys.every((k) => k !== null));
    assert.equal(new Set(keys).size, SOURCES.length);
  });

  it("resolves every publisher, and a host belongs to one publisher", () => {
    for (const s of SOURCES) assert.ok(publisherById(s.publisher), `${s.id}: publisher ${s.publisher}`);
    const owner = new Map<string, string>();
    for (const p of PUBLISHERS) {
      for (const h of p.hosts) {
        assert.equal(registrableHost(h), h, `${p.id}: ${h}`);
        assert.ok(!owner.has(h), `${h} claimed by ${owner.get(h)} and ${p.id}`);
        owner.set(h, p.id);
      }
    }
  });

  it("indexes and resolves every source with the contract defaults", () => {
    const index = indexSources(SOURCES);
    assert.equal(index.size, SOURCES.length);
    for (const s of SOURCES) {
      const r = resolveSource(s);
      assert.ok(r.maxItems >= 1 && r.maxAgeDays >= 1);
      if (s.kind === "github-release" || s.kind === "community") {
        assert.equal(r.leadEligible, false, s.id);
        assert.equal(r.countsForCoverage, false, s.id);
      }
    }
  });

  it("gives every scope:general source a note, and every paused source a reason", () => {
    for (const s of SOURCES) {
      if (s.scope === "general") assert.ok(s.note && s.note.length > 20, `${s.id}: general without a note`);
      if (s.status === "paused") assert.ok(s.note && /PAUSED|DISABLED/.test(s.note), `${s.id}: paused without a reason`);
    }
  });

  it("has a config for every scrape / json source, and the patterns compile", () => {
    for (const s of SOURCES) {
      assert.equal(Boolean(s.scrape), s.kind === "scrape", `${s.id}: scrape config`);
      assert.equal(Boolean(s.jsonApi), s.kind === "json", `${s.id}: jsonApi config`);
      if (s.scrape) {
        assert.doesNotThrow(() => new RegExp(s.scrape!.linkPattern), s.id);
        assert.ok(s.scrape.base.startsWith("https://"), s.id);
        assert.ok(new URL(s.url).host.endsWith(new URL(s.scrape.base).host.replace(/^www\./, "")), `${s.id}: listing is not on scrape.base`);
        if (s.scrape.titleSelectorHint !== undefined) {
          assert.match(s.scrape.titleSelectorHint, /^(h[1-6]|aria-label|img alt|text)$/, `${s.id}: hint must be one extractor token`);
        }
      }
      if (s.jsonApi) assert.ok(s.jsonApi.urlField || s.jsonApi.urlTemplate, s.id);
    }
  });

  it("compiles every include / exclude list with the shared term matcher", () => {
    for (const s of SOURCES) {
      for (const list of [s.include, s.exclude]) {
        if (!list) continue;
        assert.equal(compileTerms(list).size, list.length, `${s.id}: ${list.join(" | ")}`);
        assert.ok(!list.some((t) => /[\\^$|]|\(\?/.test(t)), `${s.id}: looks like a regular expression, not a term list`);
      }
    }
  });
});

describe("V1 migration", () => {
  const v1 = loadV1Sources();

  it("accounts for all 207 V1 names: resolved to an id or documented as removed, never both", () => {
    assert.equal(v1.length, 207);
    const unresolved: string[] = [];
    for (const row of v1) {
      const id = idForLegacyName(row.name);
      const removed = isRemovedLegacyName(row.name);
      if (id === undefined && !removed) unresolved.push(row.name);
      assert.ok(!(id !== undefined && removed), `${row.name} is both carried and removed`);
      if (id !== undefined) assert.ok(sourceById(id), `${row.name} -> ${id} does not exist`);
    }
    assert.deepEqual(unresolved, []);
    assert.equal(v1.filter((r) => isRemovedLegacyName(r.name)).length, REMOVED.length);
  });

  it("documents each removal with a reason and only points at sources that exist", () => {
    assert.equal(REMOVED.length, 11);
    for (const r of REMOVED) {
      assert.ok(v1.some((row) => row.name === r.name && row.url === r.url), `${r.name} is not a V1 source`);
      assert.ok(r.detail.length > 20, r.name);
      if (r.coveredBy) assert.ok(sourceById(r.coveredBy), `${r.name}: coveredBy ${r.coveredBy}`);
      assert.ok(!SOURCES.some((s) => urlKey(s.url) === urlKey(r.url)), `${r.name}: removed url is still registered`);
    }
  });

  it("resolves renamed sources through aliases, ignoring case and spacing", () => {
    assert.equal(idForLegacyName("AI Snake Oil"), "ai-as-normal-technology");
    assert.equal(idForLegacyName("  ai   snake oil "), "ai-as-normal-technology");
    assert.equal(idForLegacyName("AI News (smol.ai)"), "ai-news-latent-space");
    assert.equal(idForLegacyName("SentinelOne"), "sentinellabs");
    assert.equal(idForLegacyName("Meta AI Blog"), "meta-newsroom-ai");
    assert.equal(idForLegacyName("ModularML"), "modular");
    assert.equal(idForLegacyName("ZDNet AI"), "zdnet");
    assert.equal(idForLegacyName("modelcontextprotocol spec"), "mcp-blog");
    assert.equal(idForLegacyName("All-Hands-AI/OpenHands"), "gh-openhands-openhands");
    assert.equal(idForLegacyName("comfyanonymous/ComfyUI"), "gh-comfy-org-comfyui");
    assert.equal(idForLegacyName("lobehub/lobe-chat"), "gh-lobehub-lobehub");
    assert.equal(idForLegacyName("AI Now Institute"), "gn-ai-now-institute");
    assert.equal(idForLegacyName("OpenAI Blog"), undefined);
    assert.equal(idForLegacyName("no such source"), undefined);
  });

  it("keeps V1 display names unless a rename is recorded as an alias", () => {
    for (const row of v1) {
      const id = idForLegacyName(row.name);
      if (id === undefined) continue;
      const s = byId(id);
      assert.ok(s.name === row.name || s.aliases?.includes(row.name), `${row.name} -> ${s.name} without alias`);
    }
  });

  it("applies the url replacements and drops every dead V1 url", () => {
    const urls = new Set(SOURCES.map((s) => s.url));
    const dead = [
      "https://openai.com/blog/rss.xml",
      "https://news.smol.ai/rss.xml",
      "https://www.sentinelone.com/feed/",
      "https://www.chipstrat.com/feed.xml",
      "https://thezvi.substack.com/feed",
      "https://epochai.substack.com/feed",
      "https://simonwillison.net/atom/everything/",
      "https://www.lesswrong.com/feed.xml",
      "https://www.datacenterdynamics.com/rss/",
      "https://www.nist.gov/news-events/artificial%20intelligence/rss.xml",
      "https://ainowinstitute.org/feed",
      "https://jfrog.com/blog/category/security/feed/",
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664",
      "https://about.fb.com/feed/",
      "https://blog.eleuther.ai/index.xml",
      "https://noma.security/feed/",
      "https://thinkingmachines.ai/blog/index.xml",
      "https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom",
    ];
    for (const u of dead) assert.ok(!urls.has(u), `dead url still registered: ${u}`);
    assert.ok(!SOURCES.some((s) => /reddit\.com/.test(s.url)), "Reddit ended RSS on 2026-11-13");
    assert.equal(byId("epoch-ai").url, "https://epoch.ai/atom.xml");
    assert.equal(byId("dont-worry-about-the-vase").url, "https://thezvi.wordpress.com/feed/");
    assert.equal(byId("chipstrat").url, "https://newsletter.chipstrat.com/feed");
    assert.equal(byId("sentinellabs").url, "https://www.sentinelone.com/labs/feed/");
    assert.equal(byId("simon-willison").url, "https://simonwillison.net/atom/entries/");
    assert.match(byId("lesswrong").url, /karmaThreshold=75/);
    assert.match(byId("cnbc-tech").url, /id=19854910/);
    assert.equal(byId("latent-space").url, "https://latent.space/feeds/no-ainews.xml");
    assert.equal(byId("ai-news-latent-space").url, "https://latent.space/feeds/news.xml");
  });

  it("canonicalises the permanently redirected feeds", () => {
    const expected: Record<string, string> = {
      "mistral-ai": "https://mistral.ai/news/rss",
      "google-ai-blog": "https://blog.google/innovation-and-ai/technology/ai/rss/",
      "langchain-blog": "https://www.langchain.com/blog/rss.xml",
      "tldr-sec": "https://rss.beehiiv.com/feeds/xgTKUmMmUm.xml",
      "trail-of-bits": "https://blog.trailofbits.com/index.xml",
      "crowdstrike-blog": "https://www.crowdstrike.com/en-us/blog/feed",
      "puget-systems": "https://www.pugetsystems.com/all-blog/feed/",
      "benedict-evans": "https://www.ben-evans.com/benedictevans?format=rss",
      "bloomberg-tech": "https://www.bloomberg.com/feeds/technology/news.rss",
      "the-record": "https://therecord.media/feed",
      "gh-openhands-openhands": "https://github.com/OpenHands/OpenHands/releases.atom",
      "gh-comfy-org-comfyui": "https://github.com/Comfy-Org/ComfyUI/releases.atom",
      "gh-lobehub-lobehub": "https://github.com/lobehub/lobehub/releases.atom",
    };
    for (const [id, url] of Object.entries(expected)) assert.equal(byId(id).url, url, id);
    // 302 / 307 targets are never pinned.
    assert.equal(byId("hf-daily-papers").url, "https://papers.takara.ai/api/feed");
  });
});

describe("publishers", () => {
  it("uses one publisher per organisation across old and new sources", () => {
    const same = (publisher: string, ids: string[]): void => {
      for (const id of ids) assert.equal(byId(id).publisher, publisher, id);
    };
    same("openai", ["openai-news", "openai-alignment-research"]);
    same("techcrunch", ["techcrunch-ai", "techcrunch-startups", "techcrunch-robotics"]);
    same("ieee-spectrum", ["ieee-spectrum-ai", "ieee-spectrum-robotics", "ieee-spectrum-semiconductors"]);
    same("mit-news", ["mit-news-ai", "mit-news-quantum"]);
    same("google", ["google-deepmind-blog", "google-ai-blog", "google-research-blog", "google-project-zero", "google-threat-intelligence", "google-security-blog", "google-developer-tools"]);
    same("anthropic", ["anthropic-news", "anthropic-research", "anthropic-frontier-red-team", "anthropic-engineering", "transformer-circuits", "claude-dev-blog", "claude-blog", "claude-status"]);
    same("microsoft", ["microsoft-research-blog", "microsoft-security", "microsoft-agent-framework", "vscode-updates"]);
    same("amazon", ["aws-ml-blog", "amazon-science", "kiro-blog"]);
    same("bloomberg", ["bloomberg-tech", "bloomberg-money-stuff", "bloomberg-law-ai"]);
    same("the-register", ["the-register-ai-ml", "theregister-security", "the-register-systems-hpc"]);
    same("lesswrong", ["lesswrong", "ai-alignment-forum"]);
    same("latent-space", ["latent-space", "ai-news-latent-space"]);
    same("cisco", ["talos-intelligence", "cisco-psirt-advisories"]);
    same("financial-times", ["ft-artificial-intelligence", "ft-alphaville"]);
    same("thinking-machines-lab", ["thinking-machines-lab", "thinking-machines-news"]);
    same("github:ggml-org/llama.cpp", ["gh-ggml-org-llama-cpp", "gh-disc-llama-cpp-announcements", "gh-commits-llama-cpp-model-support"]);
    assert.ok(!SOURCES.some((s) => s.name === "OpenAI Blog"), "the duplicate OpenAI feed must be gone");
  });

  it("never lets two publishers share a display name", () => {
    const names = new Map<string, string>();
    for (const p of PUBLISHERS) {
      const other = names.get(p.name.toLowerCase());
      assert.equal(other, undefined, `"${p.name}" is used by ${other} and ${p.id}`);
      names.set(p.name.toLowerCase(), p.id);
    }
  });

  it("attributes link hosts of query feeds to real outlets", () => {
    const expected: Record<string, string> = {
      "https://www.reuters.com/technology/x": "reuters",
      "https://apnews.com/article/x": "ap",
      "https://www.nytimes.com/2026/11/19/technology/x.html": "nyt",
      "https://www.bloomberg.com/news/articles/x": "bloomberg",
      "https://www.wsj.com/tech/ai/x": "wsj",
      "https://techcrunch.com/2026/11/19/x": "techcrunch",
      "https://deepmind.google/blog/x": "google",
      "https://www.anthropic.com/news/x": "anthropic",
      "https://openai.com/index/x": "openai",
      "https://arxiv.org/abs/2611.00001": "arxiv",
      "https://thesequence.substack.com/p/x": "thesequence",
      "https://garymarcus.substack.com/p/x": "gary-marcus",
      "https://kaitchup.substack.com/p/x": "the-kaitchup",
      "https://ainowinstitute.org/publications/x": "ai-now-institute",
      "https://www.sec.gov/newsroom/x": "sec",
      "https://www.law360.com/articles/x": "law360",
      "https://asia.nikkei.com/Business/x": "nikkei",
    };
    for (const [url, publisher] of Object.entries(expected)) assert.equal(publisherForHost(url)?.id, publisher, url);
    assert.equal(publisherForHost("https://unknown-outlet.example/x"), undefined);
    assert.equal(publisherForHost("not a url at all ::"), undefined);
  });

  it("gives release feeds a per-repo publisher that claims no host", () => {
    for (const s of SOURCES.filter((x) => x.kind === "github-release")) {
      assert.equal(s.publisher, `github:${s.name}`, s.id);
      assert.deepEqual(publisherById(s.publisher)?.hosts, [], s.id);
    }
    assert.equal(publisherForHost("https://github.com/ggml-org/llama.cpp/releases/tag/b1")?.id, "github");
  });
});

describe("editorial rules from the review", () => {
  it("has no tier-1 release feed and a short tier-1 list", () => {
    assert.deepEqual(SOURCES.filter((s) => s.kind === "github-release" && s.tier === 1), []);
    const t1 = SOURCES.filter((s) => s.tier === 1).map((s) => s.id).sort();
    assert.deepEqual(t1, ["anthropic-news", "finra-regulatory-notices", "google-deepmind-blog", "mistral-ai", "openai-news", "sec-press-releases"]);
    const top = SOURCES.filter((s) => s.tier <= 2).length;
    assert.ok(top / SOURCES.length <= 0.3, `tiers 1+2 are ${top} of ${SOURCES.length}`);
  });

  it("deflates release feeds, firehoses, queries, community and digests", () => {
    for (const s of SOURCES) {
      if (s.kind === "github-release") assert.ok(s.tier >= 2, s.id);
      if (s.kind === "query") assert.ok(s.tier >= 3, `${s.id}: query feeds are tier 3-4`);
      if (s.kind === "community") assert.ok(s.tier >= 3, s.id);
      if (s.tags?.includes("digest")) assert.ok(s.tier >= 3, s.id);
    }
    for (const id of ["arxiv-cs-ai", "arxiv-cs-lg", "arxiv-cs-cl"]) {
      const s = byId(id);
      assert.equal(s.tier, 4);
      assert.equal(s.leadEligible, false);
      assert.equal(s.maxKept, 2);
    }
    for (const id of ["gh-ollama-ollama", "gh-ggml-org-llama-cpp", "gh-huggingface-transformers"]) assert.equal(byId(id).tier, 3, id);
    assert.equal(byId("google-project-zero").tier, 3);
    assert.equal(byId("lesswrong").tier, 4);
    assert.equal(byId("lesswrong").maxKept, 3);
  });

  it("keeps release feeds on the release desk unless routeTo says otherwise", () => {
    for (const s of SOURCES.filter((x) => x.kind === "github-release")) {
      const r = resolveSource(s);
      assert.equal(s.home, "releases", s.id);
      if (r.routing === "normal") {
        assert.deepEqual(r.routeTo, ["open_local"], `${s.id}: only an explicit allowlist may leave RELEASE RADAR`);
      } else assert.equal(r.routing, "home-only", s.id);
    }
    assert.deepEqual(
      SOURCES.filter((s) => s.kind === "github-release" && resolveSource(s).routing === "normal").map((s) => s.id).sort(),
      // The tracked local-inference runtimes. Route caps what this can do to LOCAL &
      // OPEN MODELS: two release lines on its homepage, never in the first three rows.
      ["gh-ggml-org-llama-cpp", "gh-ggml-org-llama-macos", "gh-ml-explore-mlx", "gh-ml-explore-mlx-lm", "gh-mostlygeek-llama-swap", "gh-ollama-ollama", "gh-sgl-project-sglang", "gh-unslothai-unsloth", "gh-vllm-project-vllm"],
    );
  });

  it("keeps the owner desks on their desk", () => {
    for (const s of SOURCES.filter((x) => x.home === "cyber")) {
      const r = resolveSource(s);
      assert.equal(s.scope, "ai", `${s.id}: cyber-desk sources are on-desk, never AI-gated`);
      assert.ok(r.routing === "home-only" || (r.routeTo !== null && r.routeTo.every((x) => x === "ai_security" || x === "policy")), `${s.id}: may only route to AI SECURITY / POLICY`);
    }
    for (const s of SOURCES.filter((x) => x.home === "quantum")) assert.equal(resolveSource(s).routing, "home-only", s.id);
    for (const s of SOURCES) for (const r of s.routeTo ?? []) assert.equal(sectionById(r).mode, "topic", `${s.id}: routeTo ${r} is a source-mode section`);
  });

  it("bounds and localises every Google News query", () => {
    const gn = SOURCES.filter((s) => s.url.startsWith("https://news.google.com/rss/search"));
    assert.ok(gn.length >= 15);
    for (const s of gn) {
      assert.equal(s.kind, "query", s.id);
      assert.match(s.url, /when:\d+d/, `${s.id}: no when: bound`);
      assert.match(s.url, /hl=en-US&gl=US&ceid=US:en$/, `${s.id}: no locale`);
      assert.ok(!/-site:|-%22/.test(s.url), `${s.id}: -site: / quoted negatives make Google ignore when:`);
      assert.equal(resolveSource(s).attribution, "link-host", s.id);
    }
    assert.match(byId("gn-ai-sec-finra").url, /when:14d\+-LSU\+-football/);
    assert.equal(byId("gn-ai-sec-finra").home, "policy");
  });

  it("splits V1 safety_policy between POLICY and SAFETY on purpose", () => {
    const home = (id: string): SectionId => byId(id).home;
    for (const id of ["transformer-news", "nist-ai-news", "cset-georgetown", "eu-ai-act-newsletter", "ai-policy-perspectives", "gn-ai-now-institute"]) assert.equal(home(id), "policy", id);
    for (const id of ["metr", "ai-alignment-forum", "lesswrong", "redwood-research", "ai-safety-newsletter-cais", "uk-aisi-blog", "dont-worry-about-the-vase"]) assert.equal(home(id), "safety", id);
  });

  it("re-homes the sources the review called miscategorised", () => {
    assert.equal(byId("the-decoder").home, "industry");
    assert.equal(byId("marktechpost").home, "industry");
    assert.equal(byId("marktechpost").tier, 4);
    assert.equal(byId("hugging-face-blog").home, "open_local");
    assert.equal(byId("puget-systems").home, "compute");
    assert.equal(byId("modular").home, "compute");
    assert.equal(byId("shtetl-optimized").home, "analysis");
    assert.equal(byId("mcp-blog").home, "tools");
  });

  it("marks CI-blocked feeds: paused when dead, probation with a mirror when blocked", () => {
    assert.equal(byId("venturebeat-ai").status, "paused");
    const probation = SOURCES.filter((s) => s.tags?.includes("probation"));
    assert.ok(probation.length >= 10);
    for (const s of probation) {
      assert.notEqual(s.status, "paused", s.id);
      assert.match(s.note ?? "", /PROBATION/, s.id);
    }
    const mirrored = SOURCES.filter((s) => s.tags?.includes("substack") && s.tags.includes("probation"));
    const mirrors = SOURCES.filter((s) => s.tags?.includes("fallback") && s.tags.includes("substack"));
    assert.equal(mirrored.length, 10);
    assert.equal(mirrors.length, 3);
    for (const s of mirrored) {
      const host = registrableHost(s.url);
      assert.ok(host?.endsWith(".substack.com"), s.id);
      assert.ok(mirrors.some((m) => m.url.includes(`site:${host}`)), `${s.id}: no Google News mirror for ${host}`);
      assert.equal(publisherForHost(s.url)?.id, s.publisher, `${s.id}: mirror items must attribute to the newsletter`);
    }
  });
});

// Fix round 2026-11-20: every case below is a real item of the 2026-11-20 build (or of a live
// snapshot of the feed) that the registry kept or dropped wrongly.
describe("per-source rules on the 2026-11-20 corpus", () => {
  const GN = "https://news.google.com/rss/articles/CBMiUNRESOLVEDWRAPPER";
  /**
   * The relevance stage's per-source verdict (scripts/pipeline/relevance/rules.ts applySourceRules),
   * restated here because the registry may not import the pipeline: excludeUrl and includeUrl are
   * case-insensitive substrings of the item URL; exclude drops on a title or summary hit; include
   * (when present) needs a title or summary hit. Terms compile with the shared matcher, no plural.
   */
  const verdict = (id: string, title: string, opts: { summary?: string; url?: string } = {}): boolean => {
    const s = byId(id);
    const url = (opts.url ?? "https://example.org/a").toLowerCase();
    const summary = opts.summary ?? null;
    // relevance/index.ts deniedOutletOf: a link-host item of a denied outlet never reaches the source's own rules.
    if (resolveSource(s).attribution === "link-host" && deniedOutlet({ url })) return false;
    if ((s.excludeUrl ?? []).some((part) => url.includes(part.toLowerCase()))) return false;
    if (s.includeUrl?.length && !s.includeUrl.some((part) => url.includes(part.toLowerCase()))) return false;
    const exclude = compileTerms(s.exclude ?? []);
    if (exclude(title) ?? exclude(summary)) return false;
    const include = compileTerms(s.include ?? []);
    // includeIn "title": a summary-only hit does not keep the item.
    return include.size === 0 || Boolean(include(title) ?? (s.includeIn === "title" ? null : include(summary)));
  };
  const keeps = (id: string, title: string, opts?: { summary?: string; url?: string }): void => assert.equal(verdict(id, title, opts), true, `${id} must keep: ${title}`);
  const drops = (id: string, title: string, opts?: { summary?: string; url?: string }): void => assert.equal(verdict(id, title, opts), false, `${id} must drop: ${title}`);
  /**
   * Must this source's items pass the global AI-relevance gate? (relevance/index.ts isGated: scope
   * "general", no include list of its own, home section not on the owner desk.)
   */
  const gated = (id: string): boolean => {
    const s = byId(id);
    return s.scope === "general" && !s.include?.length && sectionById(s.home).desk !== "owner";
  };

  it("keeps FINRA notices on the owner's compliance beat, not only the AI ones", () => {
    const id = "finra-regulatory-notices";
    keeps(id, "Regulatory Notice 26-24: FINRA has adopted amendments to FINRA Rule 2210 (Communications with the Public) to allow a member's communications to include projections of performance");
    keeps(id, "Regulatory Notice 26-20: FINRA has adopted new Rule 3290 (Outside Activities Requirements) to replace Rules 3270 and 3280");
    keeps(id, "Regulatory Notice 27-01: FINRA reminds members of their supervisory obligations when using generative AI tools");
    keeps(id, "Regulatory Notice 27-02: FINRA requests comment on vendor management and third-party risk");
    keeps(id, "Regulatory Notice 27-03: FINRA reminds members of their obligations under SEA Rules 17a-3 and 17a-4");
    drops(id, "Information Notice 11/16/26: The national options exchanges are closing at 1:00 p.m");
    drops(id, "Regulatory Notice 26-23: FINRA has adopted amendments to exempt specified collective trust funds (CTFs) from FINRA Rule 5130");
    drops(id, "Regulatory Notice 26-22: FINRA's Renewal Program facilitates the collection and disbursement of fees for broker-dealer (BD) and investment adviser (IA) registrations");
    // Bare "communications" is deliberately not a term: it matched this notice through its summary only.
    drops(id, "Regulatory Notice 26-21: FINRA has adopted amendments to its rules and updated its interpretations to address binary options", { summary: "The amendments also update related interpretations on options communications." });
    assert.equal(byId(id).scope, "general");
    assert.equal(byId(id).tier, 1);
  });

  it("keeps cyber, third-party-risk and quantum guidance from the prudential regulators", () => {
    keeps("iosco-media-releases", "IOSCO calls on firms preparedness for quantum");
    drops("iosco-media-releases", "IOSCO publishes 2026 Monitoring Report on the Tokenization of Financial Assets");
    keeps("occ-bulletins", "Third-Party Risk Management: Proposed Guidance and Request for Comment; Extension of Comment Period");
    keeps("occ-bulletins", "Super Intelligence: Supervisory Framework");
    drops("occ-bulletins", "GENIUS Act Regulations: Final Rule");
    keeps("boe-pra-publications", "Effective practices: Cyber risk and resilience management relating to quantum computing");
    keeps("boe-pra-publications", "CP17/26 and GC26/9 – Cyber risk and resilience management");
    keeps("boe-pra-publications", "Effective practices: Cyber risk and resilience management relating to artificial intelligence (AI)");
    drops("boe-pra-publications", "CP16/26 – Clarifying the Prudential Regulation Authority's approach to the implementation of the O-SII buffer");
  });

  it("widens the SEC feeds with specific compliance terms only", () => {
    keeps("sec-press-releases", "SEC Announces Fiscal Year 2027 Examination Priorities");
    keeps("sec-press-releases", "SEC Adopts Amendments to Regulation S-P to Enhance Protection of Customer Information");
    keeps("sec-speeches-statements", "Opening Remarks at the Roundtable on Machine-Understandable Data in the Age of Super Intelligence");
    // Noise the broader proposals admitted: "broker-dealers" in a summary, bare "supervisory".
    drops("sec-press-releases", "SEC Issues Exemptive Relief from Treasury Clearing Requirements for Certain Inter-Affiliate and Non-U.S. Repo Transactions", { summary: "The relief is intended to assist broker-dealers and their affiliates." });
    drops("sec-press-releases", "SEC and AMF Announce Supervisory MOU To Enhance Cooperation for Investment Advisers and Investment Service Providers");
    drops("sec-press-releases", "SEC Proposes Executive and Director Compensation Disclosure Reforms");
    for (const term of ["supervision", "supervisory", "technology", "communications", "broker-dealer", "vendor"]) {
      assert.ok(!FINREG_OWNER_TERMS.includes(term) && !GOV_OWNER_TERMS.includes(term), `bare "${term}" must stay out of the shared lists`);
    }
  });

  it("keeps the AI terms on every source that adds owner terms, and says the list replaces the gate", () => {
    const ai = new Set(GOV_AI_TERMS);
    const owner = new Set([...FINREG_OWNER_TERMS, ...GOV_OWNER_TERMS]);
    const widened = SOURCES.filter((s) => s.include?.some((t) => owner.has(t)) && s.tags?.includes("regulator"));
    assert.deepEqual(widened.map((s) => s.id).sort(), ["boe-pra-publications", "fca-news", "finra-regulatory-notices", "iosco-media-releases", "occ-bulletins", "sec-press-releases", "sec-speeches-statements"]);
    for (const s of widened) {
      assert.ok([...ai].every((t) => s.include!.includes(t)), `${s.id}: owner terms must be added to GOV_AI_TERMS, not replace them`);
      assert.match(s.note ?? "", /REPLACES the global (AI )?gate/, s.id);
      assert.equal(s.scope, "general", s.id);
    }
  });

  it("lets the Federal Register keep the chip rule its own note cites", () => {
    keeps("federal-register-ai", "Addressing Remote Access to Advanced Semiconductors", { summary: "BIS is amending the EAR to address access to advanced computing power hosted in data centers." });
    keeps("federal-register-ai", "Policies on the Use of Generative Super Intelligence in Agency Adjudication; Request for Comments");
    drops("federal-register-ai", "Executive Compensation Disclosure Reform");
  });

  it("requires an AI word and a regulator word in the title for the owner's SEC/FINRA query", () => {
    const id = "gn-ai-sec-finra";
    const url = byId(id).url;
    assert.match(url, /\(intitle:AI\+OR\+intitle:%22artificial\+intelligence%22\)/);
    assert.match(url, /intitle:FINRA\+OR\+intitle:SEC/);
    keeps(id, "SEC scrutiny pushes advisors to vet AI tools before examiners ask", { url: GN });
    keeps(id, "Super Intelligence, Deepfakes, and Cyberattacks: The SEC's 2027 Examination Priorities Put AI in the Spotlight", { url: GN });
    keeps(id, "An AI-Focused Fireside Chat with SEC IM Director Brian Daly", { url: "https://www.mcdermottlaw.com/insights/x" });
    keeps(id, "Private Equity, AI Spark Audit Firm Ethics Rule Questions at SEC", { url: "https://news.bloombergtax.com/financial-accounting/x" });
    // The three off-mission rows of the 2026-11-20 build carry no regulator word.
    drops(id, "$0 revenue at Loan Artificial Intelligence (LAAI) accompanies doubt about its ability to continue.", { url: GN });
    drops(id, "Google opens Singapore engineering center to build and export enterprise cloud and AI to the world", { url: GN });
    // "SEC" is case-insensitive: cabinet secretaries, EDGAR rewrites, the Southeastern Conference.
    drops(id, "As Trump Pushes AI Full Blast, DHS Sec. Suggests It Could Be Behind Mass Tech Outages", { url: GN });
    drops(id, "FAA's new AI tool not connected to ATC issues, Sec. Duffy says", { url: GN });
    drops(id, "RZLV: SEC Form 6-K filed by Rezolve AI PLC", { url: GN });
    drops(id, "AI OKTO Corp. SEC Filing (Nov 16, 2026)", { url: GN });
    drops(id, "Week 11 OVERREACTIONS | SEC Power Rankings | AI In Sports Media", { url: GN });
    drops(id, "Former SEC chair warns of potential AI market crash", { url: "https://tradersunion.com/news/x" });
  });

  it("carries regulator action against AI companies through a gated, capped wire query", () => {
    const id = "gn-sec-ai-wires";
    const s = resolveSource(byId(id));
    assert.equal(s.include, undefined, "no include list: the global gate must supply the AI term");
    assert.ok(gated(id));
    assert.ok(s.maxKept <= 4, "one story must not take every slot (the cap runs before clustering)");
    assert.equal(s.maxAgeExplicit, true, "Google ignores when: for this many site: terms");
    // The gate (not this file) supplies "AI term in the title"; it accepts Nvidia / OpenAI / Anthropic.
    for (const title of ["Nvidia facing SEC probe after Huang's resignation, WSJ reports", "Exclusive | SEC Is Probing Nvidia Amid Departure of CEO Jensen Huang", "US SEC's top cop says agency is monitoring AI corporate disclosures"]) {
      keeps(id, title, { url: GN });
    }
    assert.match(byId(id).url, /intitle:SEC\+OR\+intitle:FINRA\+OR\+intitle:CFTC/);
    assert.match(byId(id).url, /intitle:Nvidia\+OR\+intitle:OpenAI\+OR\+intitle:Anthropic\+OR\+intitle:AI/);
    drops(id, "Watch CNBC's full interview with Treasury Sec. Scott Bessent on Nvidia, China trade", { url: GN });
    drops(id, "Watch Former SEC Chair Gary Gensler Warns Anthropic's Cash Flow Poses Big Risk To AI Economy", { url: GN });
    drops(id, "GPT and other AI models can't analyze an SEC filing, researchers find", { url: GN });
  });

  it("gates the bank-liability query on a bank, broker or liability word in the title", () => {
    const id = "gn-ai-agent-bank-liability";
    assert.match(byId(id).url, /intitle:%22AI\+agent%22/);
    keeps(id, "More banks say customers using AI agents are on their own — even if they get hacked", { url: "https://techcrunch.com/2026/11/18/x" });
    keeps(id, "Banks are warning customers they could be liable for an AI agent's mistakes", { url: GN });
    keeps(id, "OCC's AI Examiner Framework: How Banks' AI Use Can Trigger Legal Liability and Supervisory Exposure", { url: GN });
    drops(id, "Plaid launches Agent Detection for AI agents", { url: GN });
    drops(id, "Feedzai's New Tool Detects AI Agents Accessing Customer Accounts", { url: GN });
    drops(id, "AI agent startup files for bankruptcy", { url: GN });
    drops(id, "Citibank updates terms, holds customers liable for AI agent risks", { url: "https://cryptobriefing.com/x" });
    assert.ok(resolveSource(byId(id)).maxKept <= 3);
  });

  it("drops Substack comment, coupon and perks pages, resolved or not, without matching post slugs", () => {
    for (const id of ["gn-substack-analysis", "gn-substack-money", "gn-substack-local-policy"]) {
      drops(id, "Some headline", { url: "https://kaitchup.substack.com/subscribe?coupon=823131bf" });
      drops(id, "Some headline", { url: "https://kaitchup.substack.com/perks" });
      drops(id, "Some headline", { url: "https://garymarcus.substack.com/p/wake-up-americas-infrastructure-is/comment/389793809" });
      keeps(id, "Some headline", { url: "https://kaitchup.substack.com/p/subscribe-to-kaitchup-pro" });
      keeps(id, "Some headline", { url: "https://kaitchup.substack.com/p/perks-of-4-bit-quantization" });
      keeps(id, "Some headline", { url: "https://aisafetychina.substack.com/p/comments-on-chinas-draft-ai-law" });
    }
    // Title backstops for wrappers the resolver did not reach. The headline-less "- The Kaitchup" entry
    // never reaches these rules (normalize: "empty title after cleaning"), so no term names the newsletter:
    // a "- The Kaitchup" term also dropped real posts whose title kept the newsletter as a suffix.
    assert.ok(!byId("gn-substack-local-policy").exclude!.some((t) => /kaitchup/i.test(t)));
    keeps("gn-substack-local-policy", "Qwen4 Next Week? — LFM3 Release and Higher-Fidelity Qwen3.8 Quantizations - The Kaitchup", { url: GN });
    drops("gn-substack-local-policy", "Subscriber perks for The Kaitchup – AI on a Budget", { url: GN });
    drops("gn-substack-analysis", "- Marcus on AI", { url: GN });
    keeps("gn-substack-analysis", "Game over, man?", { url: GN });
    keeps("gn-substack-analysis", "Wake up! America's infrastructure is melting. And AI appears to be partly responsible.", { url: GN });
    keeps("gn-substack-local-policy", "Hy4 Flash vs. Qwen3.8 Flash Next: Architecture, KV Cache, and Token Efficiency", { url: GN });
  });

  it("drops video, webinar and quote pages from the robotics wire query and keeps the scoops", () => {
    const id = "gn-robotics-wires";
    drops(id, "Dancing humanoid robots perform for journalists at APEC summit", { url: "https://www.reuters.com/video/watch/idRW965019112026RP1" });
    drops(id, "Some Bloomberg clip", { url: "https://www.bloomberg.com/news/videos/2026-11-18/x" });
    drops(id, "The Humanoid Race: Turning Physical AI Into Business: BI Replay", { url: GN });
    drops(id, "Watch Genesis AI Hits $3.5B Valuation in Robotics Bet", { url: GN });
    drops(id, "Agility Robotics Inc. (AGLT) Stock Price Today", { url: "https://www.wsj.com/market-data/quotes/AGLT" });
    keeps(id, "Waymo pauses robotaxi rides on US freeways after California ban", { url: "https://www.reuters.com/business/autos-transportation/x" });
    keeps(id, "EXCLUSIVE: GM plans 20% boost in robotics as factory costs rise", { url: GN });
    keeps(id, "Exclusive | Genesis AI, a Robotics Startup, Raises $500 Million", { url: GN });
    assert.equal(byId(id).maxKept, 6);
    assert.equal(byId(id).maxItems, undefined, "a wider window only adds quote pages and wrappers to resolve");
    drops("gn-prompt-injection", "Cato Networks Unveils AgentSense AI Security", { url: "https://wisevoter.com/x" });
    drops("gn-prompt-injection", "OpenAI says a research model wrote scripts to secretly copy emails", { url: "https://mlq.ai/news/x" });
  });

  it("keeps OpenAI's launch posts ahead of its demo and marketing pages", () => {
    const s = resolveSource(byId("openai-news"));
    assert.ok(s.maxKept >= 15, "a tier-1 first-party feed must not be capped at the default 8");
    assert.ok(s.maxItems >= 40, "excludeUrl runs after the ingest window: 15 items is 2.5 days of this feed");
    keeps("openai-news", "Introducing GPT-6.2 Astra and Sol", { url: "https://openai.com/index/introducing-gpt-6-2-astra-sol" });
    keeps("openai-news", "Managing frontier AI risk: From training to deployment", { url: "https://openai.com/index/managing-frontier-ai-risk" });
    drops("openai-news", "Deploying Daybreak Red", { url: "https://openai.com/business/learn/deploying-daybreak-red" });
    drops("openai-news", "How Sumitomo Life's leaders helped teams adopt ChatGPT Enterprise", { url: "https://openai.com/business/customer-stories/sumitomo-life" });
    drops("openai-news", "Prompting basics", { url: "https://openai.com/academy/prompting-basics" });
    drops("openai-news", "ChatGPT Ads increases its market presence in 44 countries", { url: "https://openai.com/ads/market-presence" });
  });

  it("keeps LOCAL & OPEN MODELS to local-model stories", () => {
    // Summary-only "LLM" hits put these on the homepage and pushed the real hits over the cap.
    drops("phoronix", "PostgreSQL 19 Released With More Performance Improvements", { summary: "The release also changes how the project handles AI/LLM-led bug reports." });
    drops("phoronix", "Debian's APT Removing Some Features Due To Advancements In AI Security Discoveries", { summary: "Maintainers cite a flood of findings from LLMs." });
    keeps("phoronix", "AMD ROCm 10.2 Released With Latest Optimizations, Expanded Ryzen Laptop Support");
    // A kernel patch series for hardware this reader does not run held LOCAL & OPEN MODELS homepage row #9.
    drops("phoronix", 'AMD AI Engine "AIE" Driver Posted For Mainline Linux Kernel Review', { summary: "Separate from the existing AMDXDNA accelerator driver in the Linux kernel for Ryzen AI NPUs." });
    assert.equal(byId("phoronix").includeIn, "title", "a term in a Phoronix summary is a passing mention");
    drops("phoronix", "Valkey 9.2 Delivers More Performance, Zstd Compression & Lower Memory Overhead", { summary: "The release also speeds up vector search used for local AI inference workloads with llama.cpp." });
    keeps("phoronix", "Unsloth Desktop Now Supports Using The AMD Ryzen AI NPU - Including On Linux");
    keeps("phoronix", "AMD Lemonade 10.0 Released For Running Local LLMs On Ryzen AI PCs");
    keeps("phoronix", "Intel LLM-Scaler-Omni 0.3 Released With New Model Support");
    keeps("phoronix", "RamaLama 1.0 Makes It Easier To Run LLMs In Containers");
    for (const term of ["LLM", "LLMs", "inference"]) assert.ok(!byId("phoronix").include!.includes(term), `phoronix: bare "${term}"`);

    drops("puget-systems", "Photoshop On-Device Remove Tool Performance Analysis", { summary: "We test the AI-powered Remove tool across current GPUs." });
    drops("puget-systems", "Intel Xeon 600 Workstation Content Creation Review");
    keeps("puget-systems", "How Many People Can One NVIDIA DGX Station GB300 Serve?");
    assert.equal(byId("ai2").home, "research");
  });

  it("excludes HPCwire's press-release section and bounds the vendor firehoses", () => {
    drops("hpc-wire", "NVIDIA Earns 15 HPCwire Readers' and Editors' Choice Awards at SC26", { url: "https://www.hpcwire.com/off-the-wire/nvidia-earns-15-hpcwire-awards/" });
    keeps("hpc-wire", "Penguin Solutions Turns to Silicon Photonics to Overcome HPC and AI Memory Bottlenecks", { url: "https://www.hpcwire.com/2026/11/19/penguin-solutions-turns-to-silicon-photonics/" });
    assert.equal(byId("aws-ml-blog").tier, 4);
    assert.equal(byId("aws-ml-blog").maxKept, 3);
    // Techmeme stays tier 3 and normally routed: two of its three homepage rows were the only copy of a scoop.
    assert.equal(byId("techmeme").tier, 3);
    assert.notEqual(resolveSource(byId("techmeme")).routing, "home-only");
  });

  it("gates and re-homes the general wires that were marked AI-only", () => {
    const bl = resolveSource(byId("bloomberg-law-ai"));
    assert.equal(bl.scope, "general");
    assert.equal(bl.home, "industry");
    assert.ok(gated("bloomberg-law-ai"), "wire copy with no AI content must meet the gate");
    assert.equal(byId("bloomberg-law-ai").maxItems, undefined, "the gate must see the whole 10-item feed");
    assert.equal(bl.maxKept, 3);
    assert.doesNotMatch(bl.note ?? "", /Only open AI-only/);
    assert.equal(byId("ft-artificial-intelligence").home, "industry");
    // Rejected on purpose: gating Simon Willison drops three AI posts to remove one view-all row.
    assert.equal(byId("simon-willison").scope, "ai");
  });
});

describe("tiers and emphasis", () => {
  it("agrees with every note that states a tier", () => {
    const stated = SOURCES.flatMap((s) => {
      const m = /\btier[- ]?(\d)\b/i.exec(s.note ?? "");
      return m ? [{ id: s.id, tier: s.tier, note: Number(m[1]) }] : [];
    });
    assert.ok(stated.length >= 7, "the scan must find the notes that state a tier");
    assert.deepEqual(stated.filter((x) => x.note !== x.tier), []);
  });

  it("does not grey out first-party lab proxies or the stack and compliance watches", () => {
    for (const id of ["gn-qwen-blog", "gn-deepseek-news", "gn-microsoft-ai-news", "gn-anthropic-alignment-science", "gn-xai-news", "gn-emerging-labs", "gn-inside-ai-policy", "gn-local-llm-stack-cves", "gn-ai-sec-finra", "gn-sec-ai-wires"]) {
      assert.equal(byId(id).tier, 3, `${id}: tier 4 renders w = 0 (de-emphasised)`);
    }
    for (const s of SOURCES.filter((x) => x.kind === "query" && x.tags?.includes("lab") && x.tags.includes("first-party"))) {
      assert.equal(s.tier, 3, `${s.id}: a first-party lab proxy is tier 3, the ceiling for query feeds`);
    }
  });

  it("ranks primary regulator documents above trade press", () => {
    // Tier 3 left the Bank of England's AI / cyber effective-practice papers at POLICY #29 or off the list.
    for (const id of ["sec-speeches-statements", "occ-bulletins", "fed-speeches", "boe-pra-publications"]) assert.equal(byId(id).tier, 2, id);
    for (const id of ["finra-regulatory-notices", "sec-press-releases"]) assert.equal(byId(id).tier, 1, id);
  });

  it("stops the Copilot changelog leading stories or counting as coverage", () => {
    const s = resolveSource(byId("github-copilot-changelog"));
    assert.equal(s.leadEligible, false);
    assert.equal(s.countsForCoverage, false);
    assert.equal(s.tier, 3, "tracked-tool changelogs stay tier 3; only lead and coverage change");
    for (const id of ["cursor-changelog", "google-workspace-updates-gemini", "cohere-changelog"]) assert.equal(byId(id).tier, 3, id);
  });

  it("tags sources whose failure or silence is expected", () => {
    for (const id of ["checkpoint-research"]) {
      const s = byId(id);
      assert.ok(s.tags?.includes("probation"), id);
      assert.match(s.note ?? "", /PROBATION \(2026-11-20\)/, `${id}: dated reason`);
    }
    // Both answered in the last two builds and the feed audit once the fetch retried with a 16 s
    // header timeout: they count in the publish gate again, and the note says how thin that evidence is.
    for (const id of ["washington-post-technology", "pivot-to-ai"]) {
      const s = byId(id);
      assert.ok(!s.tags?.includes("probation"), id);
      assert.doesNotMatch(s.note ?? "", /PROBATION/, id);
      assert.match(s.note ?? "", /Off probation.*none yet from a CI runner/, `${id}: says what the evidence is`);
      assert.match(s.note ?? "", /Restore the 'probation' tag|restore the 'probation' tag/, `${id}: says what to do if it fails again`);
    }
    const quiet = ["ai-village", "benedict-evans", "gray-swan", "joseph-thacker-rez0", "lil-log", "stability-ai-news"];
    for (const id of quiet) {
      const s = byId(id);
      assert.ok(s.tags?.includes("low-cadence"), id);
      assert.ok(s.note && s.note.length > 20, `${id}: a low-cadence source says why it is kept`);
    }
  });
});

describe("scraper configs", () => {
  const matches = (id: string, path: string): boolean => new RegExp(byId(id).scrape!.linkPattern).test(path);

  it("registers the four V1 scrapers as kind scrape", () => {
    for (const name of ["Anthropic News", "Anthropic Research", "UK AISI Blog", "Gray Swan"]) {
      const s = byId(idForLegacyName(name)!);
      assert.equal(s.kind, "scrape", name);
      assert.equal(s.scrape?.dateHint, "time", `${name}: the listing has dates`);
    }
  });

  it("matches today's Anthropic post links and skips the category index pages", () => {
    assert.ok(matches("anthropic-news", "/news/anthropic-prices-initial-public-offering"));
    assert.ok(matches("anthropic-news", "/news/2026-us-midterms"));
    for (const chip of ["announcements", "features", "partnerships", "policy", "product", "safeguards", "security"]) {
      assert.ok(!matches("anthropic-news", `/news/${chip}`), chip);
    }
    assert.ok(matches("anthropic-news", "/news/policy-update-2026"), "a slug that merely starts with a category name is a post");
    assert.ok(!matches("anthropic-news", "/news"));
    assert.ok(!matches("anthropic-news", "/research/claude-black-hole-physics"));
    assert.ok(matches("anthropic-research", "/research/claude-black-hole-physics"));
    assert.ok(!matches("anthropic-research", "/research/team/frontier-red-team"));
    assert.ok(matches("anthropic-engineering", "/research/components-of-agent-memory"));
    assert.ok(matches("anthropic-engineering", "/engineering/some-post"));
  });

  it("matches the other listings' link shapes", () => {
    assert.ok(matches("thinking-machines-lab", "/blog/end-to-end-4-bit-training/"));
    assert.ok(!matches("thinking-machines-lab", "/blog/"));
    assert.ok(matches("thinking-machines-news", "/news/inkling-2-small/"));
    assert.ok(matches("eleutherai", "/reward_hacking/"));
    assert.ok(!matches("eleutherai", "/page/2/"));
    assert.ok(matches("irregular-research", "./research/assessing-gpt-6.2-astra-against-offensive-security-benchmarks"));
    assert.ok(matches("irregular-research", "/research/assessing-gpt-6.2-astra-against-offensive-security-benchmarks"));
    assert.ok(matches("finra-cyber-alerts", "/rules-guidance/guidance/salesloft-drift-AI-supply-chain-attack"));
    assert.ok(!matches("finra-cyber-alerts", "/rules-guidance/guidance/faqs"));
    assert.ok(matches("gh-advisories-vllm", "/vllm-project/vllm/security/advisories/GHSA-xgh8-qwjh-q853"));
    assert.ok(!matches("gh-advisories-vllm", "/vllm-project/vllm/security/advisories"));
    assert.ok(matches("ollama-library-newest", "/library/kimi-k3.1-pro"));
  });

  it("describes the Hugging Face JSON APIs with a url template", () => {
    for (const id of ["hf-qwen-models", "hf-unsloth-gguf", "hf-trending-models"]) {
      const s = byId(id);
      assert.equal(s.kind, "json");
      assert.deepEqual(s.jsonApi, { itemsPath: "", titleField: "id", urlTemplate: "https://huggingface.co/{id}", dateField: "createdAt", summaryField: "pipeline_tag" });
      assert.equal(resolveSource(s).leadEligible, false);
    }
  });
});

describe("coverage and totals", () => {
  it("gives every section active home sources, and AI-desk sections several publishers", () => {
    for (const sec of SECTIONS) {
      const home = ACTIVE.filter((s) => s.home === sec.id);
      const publishers = new Set(home.map((s) => s.publisher));
      assert.ok(home.length >= 5, `${sec.id}: only ${home.length} active home sources`);
      assert.ok(publishers.size >= (sec.desk === "ai" ? 5 : 3), `${sec.id}: only ${publishers.size} publishers`);
    }
  });

  it("reports the registry totals", (t) => {
    const stats = registryStats();
    const order = (rec: Record<string, number>, keys: readonly string[]): string => keys.map((k) => `${k} ${rec[k] ?? 0}`).join(", ");
    t.diagnostic(`sources: ${stats.total} (${stats.active} active, ${stats.paused} paused), publishers with a source: ${stats.publishers}, publishers total: ${PUBLISHERS.length}`);
    t.diagnostic(`by section: ${order(stats.byHome, SECTIONS.map((s) => s.id))}`);
    t.diagnostic(`by kind: ${order(stats.byKind, ["rss", "newsletter", "papers", "github-release", "query", "community", "aggregator", "scrape", "json"])}`);
    t.diagnostic(`by scope: ${order(stats.byScope, ["ai", "general"])}`);
    t.diagnostic(`by tier: ${order(stats.byTier, ["1", "2", "3", "4"])}`);
    t.diagnostic(`V1: ${loadV1Sources().length} names = ${loadV1Sources().length - REMOVED.length} carried + ${REMOVED.length} removed; sources with maxKept: ${SOURCES.filter((s) => s.maxKept !== undefined).length}`);

    assert.equal(stats.total, SOURCES.length);
    assert.equal(stats.active + stats.paused, stats.total);
    for (const rec of [stats.byHome, stats.byKind, stats.byScope, stats.byTier]) {
      assert.equal(Object.values(rec).reduce((a, b) => a + b, 0), stats.total);
    }
    assert.deepEqual(Object.keys(stats.byHome).sort(), SECTIONS.map((s) => s.id).sort());
    assert.ok(stats.total >= 400, "196 carried V1 sources plus the curated set");
  });
});

describe("migration audit tool", () => {
  it("accounts for every V1 row and every registry source", () => {
    const report = migrationReport(loadV1Rows());
    assert.equal(report.v1Total, 207);
    assert.equal(report.carried + report.removed, 207);
    assert.equal(report.removed, REMOVED.length);
    assert.equal(report.carried + report.added, SOURCES.length);
    assert.equal(report.rows.length, 207);
    const row = (name: string) => report.rows.find((r) => r.v1Name === name)!;
    assert.deepEqual(row("OpenAI News").changes, []);
    assert.deepEqual(row("Mistral AI").changes, ["url"]);
    assert.deepEqual(row("SentinelOne").changes, ["renamed", "url", "tier up"]);
    assert.ok(row("EleutherAI").changes.includes("now scraped"));
    assert.ok(row("VentureBeat AI").changes.includes("paused"));
    assert.equal(row("OpenAI Blog").status, "removed");
    assert.match(row("OpenAI Blog").reason ?? "", /^duplicate: /);
  });

  it("renders one markdown table row per V1 source", () => {
    const md = renderMarkdown(migrationReport(loadV1Rows()));
    assert.equal(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| V1 name")).length, 207);
    assert.match(md, /\| OpenAI Blog \| products \/ high \| REMOVED \|/);
    assert.match(md, new RegExp(`Registry: ${SOURCES.length} sources`));
  });
});

describe("validateRegistry", () => {
  const pub: PublisherDef = { id: "example", name: "Example", hosts: ["example.com"] };
  const base: SourceDef = { id: "example-feed", name: "Example Feed", publisher: "example", url: "https://example.com/feed.xml", kind: "rss", scope: "ai", home: "industry", tier: 3 };
  const problems = (sources: SourceDef[], publishers: PublisherDef[] = [pub]): string => validateRegistry(sources, publishers).join("\n");

  it("accepts a minimal valid registry", () => {
    assert.deepEqual(validateRegistry([base], [pub]), []);
  });

  it("rejects duplicate ids, urls (after canonicalisation) and names", () => {
    assert.match(problems([base, { ...base, name: "Other", url: "https://example.com/other.xml" }]), /duplicate id/);
    assert.match(problems([base, { ...base, id: "twin", name: "Twin", url: "http://www.example.com/feed.xml/" }]), /same canonical url as example-feed/);
    assert.match(problems([base, { ...base, id: "twin", url: "https://example.com/b.xml", aliases: ["example  FEED"] }]), /also belongs to example-feed/);
  });

  it("rejects unknown publishers, sections, tiers, kinds and bad ids", () => {
    assert.match(problems([{ ...base, publisher: "nobody" }]), /unknown publisher "nobody"/);
    assert.match(problems([{ ...base, home: "model_releases" as SectionId }]), /unknown home section/);
    assert.match(problems([{ ...base, routeTo: ["hardware" as SectionId] }]), /unknown routeTo section/);
    assert.match(problems([{ ...base, tier: 5 as 4 }]), /tier must be 1-4/);
    assert.match(problems([{ ...base, kind: "podcast" as "rss" }]), /unknown kind/);
    assert.match(problems([{ ...base, id: "Example_Feed" }]), /not a kebab slug/);
    assert.match(problems([{ ...base, url: "ftp://example.com/feed" }]), /url is not http/);
  });

  it("requires notes, configs and term lists where the contract says so", () => {
    assert.match(problems([{ ...base, scope: "general" }]), /needs a note/);
    assert.match(problems([{ ...base, status: "paused" }]), /paused source needs a note/);
    assert.match(problems([{ ...base, kind: "scrape" }]), /needs a scrape config/);
    assert.match(problems([{ ...base, kind: "scrape", scrape: { base: "https://example.com", linkPattern: "([a-z" } }]), /does not compile/);
    assert.match(problems([{ ...base, scrape: { base: "https://example.com", linkPattern: "^/x$" } }]), /scrape config on a non-scrape source/);
    assert.match(problems([{ ...base, kind: "json" }]), /needs a jsonApi config/);
    // SourceDef.fetch: bounded numbers only (ingest clamps too; a typo must not pass review silently).
    assert.equal(problems([{ ...base, fetch: { headerTimeoutMs: 16_000, timeoutRetries: 0 } }]), "");
    assert.equal(problems([{ ...base, fetch: { attempts: 1 } }]), "");
    assert.match(problems([{ ...base, fetch: { headerTimeoutMs: 600_000 } }]), /fetch\.headerTimeoutMs must be an integer from 1000 to 25000/);
    assert.match(problems([{ ...base, fetch: { headerTimeoutMs: 1500.5 } }]), /fetch\.headerTimeoutMs/);
    assert.match(problems([{ ...base, fetch: { timeoutRetries: 2 } }]), /fetch\.timeoutRetries must be 0 or 1/);
    assert.match(problems([{ ...base, fetch: { attempts: 0 } }]), /fetch\.attempts must be 1, 2 or 3/);
    assert.match(problems([{ ...base, fetch: {} }]), /fetch is empty/);
    assert.match(problems([{ ...base, fetch: { timeout: 5 } as never }]), /fetch\.timeout is not a fetch policy field/);
    // Both = the field first, the template as the fallback (HN text posts); neither is an error.
    assert.equal(problems([{ ...base, kind: "json", jsonApi: { itemsPath: "", titleField: "id", urlField: "url", urlTemplate: "https://x/{id}" } }]), "");
    assert.match(problems([{ ...base, kind: "json", jsonApi: { itemsPath: "", titleField: "id" } }]), /needs urlField, urlTemplate or both/);
    assert.match(problems([{ ...base, kind: "json", jsonApi: { itemsPath: "", titleField: "id", urlTemplate: "https://x/item" } }]), /no \{field\} placeholder/);
    assert.match(problems([{ ...base, include: [] }]), /non-empty list/);
    assert.match(problems([{ ...base, exclude: ["Webinar", "webinar"] }]), /duplicate or uncompilable/);
    assert.match(problems([{ ...base, maxKept: 0 }]), /maxKept must be a positive integer/);
    assert.match(problems([{ ...base, routing: "home-only", routeTo: ["tools"] }]), /meaningless with routing home-only/);
  });

  it("enforces the release-feed conventions", () => {
    const rel: SourceDef = { ...base, id: "gh-acme-tool", name: "acme/tool", publisher: "github:acme/tool", url: "https://github.com/acme/tool/releases.atom", kind: "github-release", home: "releases" };
    const relPub: PublisherDef = { id: "github:acme/tool", name: "acme/tool", hosts: [] };
    assert.deepEqual(validateRegistry([rel], [relPub]), []);
    assert.match(problems([{ ...rel, tier: 1 }], [relPub]), /never be tier 1/);
    assert.match(problems([{ ...rel, name: "Acme Tool" }], [relPub]), /name must be the repo/);
    assert.match(problems([{ ...rel, publisher: "example" }], [pub]), /publisher must be "github:acme\/tool"/);
    assert.match(problems([{ ...rel, url: "https://github.com/acme/tool/tags.atom" }], [relPub]), /releases\.atom/);
  });

  it("rejects publisher problems", () => {
    assert.match(problems([base], [pub, { ...pub }]), /duplicate id/);
    assert.match(problems([base], [pub, { id: "other", name: "Other", hosts: ["example.com"] }]), /claimed by both example and other/);
    assert.match(problems([base], [{ ...pub, hosts: ["www.example.com"] }]), /not in registrableHost form/);
  });
});

// Final fix round 2026-11-20: Google News query feeds put a law-firm marketing site on the AI
// SECURITY homepage and a stock-quote app in "view all" (scripts/registry/outlets.ts).
describe("outlet quality control for link-host feeds", () => {
  const linkHost = SOURCES.filter((s) => resolveSource(s).attribution === "link-host");

  it("vets the outlets of every Google News query; HN searches and Techmeme are open and say why", () => {
    const gn = linkHost.filter((s) => s.publisher === "google-news");
    assert.ok(gn.length >= 20);
    for (const s of gn) assert.equal(resolveSource(s).outlets, "vetted", `${s.id}: a search feed returns whatever outlet ranks`);
    const open = linkHost.filter((s) => resolveSource(s).outlets === "open");
    assert.deepEqual([...new Set(open.map((s) => s.publisher))].sort(), ["hacker-news", "techmeme"]);
    for (const s of open) assert.match(s.note ?? "", /outlets open/, `${s.id}: an open source names its quality signal`);
    // A feed that is its own publisher has no outlets to vet.
    assert.equal(resolveSource(byId("openai-news")).outlets, "open");
    assert.equal(resolveSource(byId("federal-register-ai")).outlets, "open", "kind query, but attributed to the source");
  });

  it("rejects an outlets policy that means nothing, an unexplained 'open' and a bad includeIn", () => {
    const base: SourceDef = { id: "example-feed", name: "Example Feed", publisher: "example", url: "https://example.com/feed.xml", kind: "rss", scope: "ai", home: "industry", tier: 3 };
    const pub: PublisherDef = { id: "example", name: "Example", hosts: ["example.com"] };
    const problems = (def: SourceDef): string => validateRegistry([def], [pub]).join("\n");
    assert.match(problems({ ...base, outlets: "vetted" }), /outlets is meaningless without link-host attribution/);
    assert.match(problems({ ...base, kind: "query", outlets: "open" }), /outlets "open" needs a note/);
    assert.equal(problems({ ...base, kind: "query", outlets: "open", note: "outlets open: 100+ points" }), "");
    assert.match(problems({ ...base, kind: "query", outlets: "sometimes" as never }), /outlets must be "vetted" or "open"/);
    assert.match(problems({ ...base, includeIn: "title" }), /includeIn without an include list/);
    assert.match(problems({ ...base, include: ["ai"], includeIn: "summary" as never }), /includeIn must be "title" or "title\+summary"/);
    assert.equal(problems({ ...base, include: ["ai"], includeIn: "title" }), "");
  });

  it("keeps the deny list small, evidenced and consistent with the publisher list", () => {
    assert.deepEqual(outletProblems(PUBLISHERS), []);
    assert.ok(OUTLET_DENY.length <= 15, "a deny list that grows is a sign the query is wrong; unknown outlets are already capped");
    for (const d of OUTLET_DENY) {
      assert.ok(d.reason.length >= 60, `${d.host}: says what the pages showed`);
      assert.equal(publisherForHost(`https://${d.host}/x`), undefined, `${d.host}: vouched for and denied`);
    }
    // The outlets that held rows on 2026-11-20.
    for (const host of ["lawcommentary.com", "londondaily.news", "biggo.com"]) assert.ok(OUTLET_DENY.some((d) => d.host === host), host);
    // Not verified by reading their pages (they refuse automated readers) or merely off-mission: left to the source rules.
    for (const host of ["mlq.ai", "marketbeat.com", "cryptopotato.com", "itbrief.com.au"]) assert.ok(!OUTLET_DENY.some((d) => d.host === host), host);
  });

  it("the validator of the outlet lists catches every kind of bad entry", () => {
    const pubs: PublisherDef[] = [{ id: "reuters", name: "Reuters", hosts: ["reuters.com"] }];
    const good: DeniedOutlet = { host: "farm.example", names: ["Farm"], reason: "Unbylined rewrites.", checked: "2026-11-20" };
    const probs = (deny: DeniedOutlet[], unvetted: string[] = []): string => outletProblems(pubs, deny, new Set(unvetted)).join("\n");
    assert.equal(probs([good]), "");
    assert.match(probs([{ ...good, host: "www.farm.example" }]), /not in registrableHost form/);
    assert.match(probs([good, { ...good, names: ["Other"] }]), /duplicate host/);
    assert.match(probs([{ ...good, host: "reuters.com" }]), /claimed by publisher reuters/);
    assert.match(probs([{ ...good, reason: " " }]), /has no reason/);
    assert.match(probs([{ ...good, checked: "yesterday" }]), /no checked date/);
    assert.match(probs([{ ...good, names: [] }]), /has no outlet name/);
    assert.match(probs([good, { ...good, host: "farm2.example" }]), /name "Farm" is listed twice/);
    assert.match(probs([], ["nobody"]), /unknown publisher "nobody"/);
  });

  it("finds a denied outlet by article URL, by the outlet host of a wrapper and by the outlet name", () => {
    const wrapper = "https://news.google.com/rss/articles/CBMiUNRESOLVED";
    assert.equal(deniedOutlet({ url: "https://finance.biggo.com/news/a4aac4ec" })?.host, "biggo.com", "sub-domain");
    assert.equal(deniedOutlet({ url: "https://www.lawcommentary.com/articles/x" })?.host, "lawcommentary.com");
    assert.equal(deniedOutlet({ url: wrapper, outletHost: "www.stocktitan.net" })?.host, "stocktitan.net");
    assert.equal(deniedOutlet({ url: wrapper, outletHost: "stocktitan.net" })?.host, "stocktitan.net");
    assert.equal(deniedOutlet({ url: wrapper, outletName: "  london daily   NEWS " })?.host, "londondaily.news");
    assert.equal(deniedOutlet({ url: wrapper }), undefined, "a wrapper that names nobody is not denied (it is unvetted)");
    assert.equal(deniedOutlet({ url: wrapper, outletHost: "reuters.com", outletName: "Reuters" }), undefined);
    // Never a different registrable host that merely contains the name.
    assert.equal(deniedOutlet({ url: "https://notbiggo.com/x" }), undefined);
    assert.equal(deniedOutlet({ url: "https://biggo.com.example.org/x" }), undefined);
    assert.equal(deniedOutlet({ url: "https://example.org/biggo.com/x" }), undefined);
    assert.equal(deniedOutlet({ url: "not a url", outletHost: "", outletName: "" }), undefined);
  });

  it("vouches for the outlets a compliance and security reader expects, and for no hosting platform", () => {
    const vouched: Record<string, string> = {
      "https://www.mcdermottlaw.com/insights/x": "mcdermott",
      "https://securityaffairs.com/1/x.html": "security-affairs",
      "https://www.sidley.com/en/insights/x": "sidley",
      "https://www.debevoise.com/insights/x": "debevoise",
      "https://www.jdsupra.com/legalnews/x": "jd-supra",
      "https://www.reuters.com/x": "reuters",
    };
    for (const [url, id] of Object.entries(vouched)) {
      assert.equal(publisherForHost(url)?.id, id, url);
      assert.ok(isVettedPublisher(id), id);
    }
    for (const id of UNVETTED_PUBLISHER_IDS) assert.ok(publisherById(id), `${id}: a real publisher entry`);
    for (const url of ["https://medium.com/@someone/x", "https://www.prnewswire.com/news-releases/x", "https://www.youtube.com/watch?v=1", "https://x.com/someone/status/1"]) {
      const p = publisherForHost(url);
      assert.ok(p && !isVettedPublisher(p.id), `${url}: a platform names the host, it does not vouch for the post`);
    }
    // A newsletter with its own entry is matched by its exact host and stays vetted.
    assert.equal(publisherForHost("https://kaitchup.substack.com/p/x")?.id, "the-kaitchup");
    assert.ok(isVettedPublisher("the-kaitchup"));
    assert.equal(UNVETTED_OUTLET_TAG, "unvetted-outlet");
  });

  it("no source's own excludeUrl repeats a denied host", () => {
    for (const s of SOURCES) for (const part of s.excludeUrl ?? []) assert.ok(!OUTLET_DENY.some((d) => part.toLowerCase().includes(d.host)), `${s.id}: "${part}" is on the outlet deny list already`);
  });
});

// hnrss.org answered HTTP 502 for 4-7 of the eleven HN queries in every build and audit of 2026-11-20.
describe("Hacker News searches read the official HN Algolia API", () => {
  const HN_IDS = ["hn-ai-150", "hn-chinese-frontier-labs", "hn-claude-code", "hn-coding-agent", "hn-llama-cpp", "hn-llm-100", "hn-local-llm", "hn-local-stack", "hn-mac-studio", "hn-open-weights", "hn-qwen", "hn-vllm"];
  const hn = SOURCES.filter((s) => s.id.startsWith("hn-"));
  const params = (s: SourceDef): Map<string, string> => new Map(s.url.slice(s.url.indexOf("?") + 1).split("&").map((kv) => kv.split("=") as [string, string]));

  it("keeps every source id and leaves no hnrss.org URL in the registry", () => {
    assert.deepEqual(hn.map((s) => s.id).sort(), HN_IDS);
    assert.deepEqual(SOURCES.filter((s) => s.url.includes("hnrss.org")).map((s) => s.id), []);
  });

  it("asks for stories by title, newest first, with a points floor and exact words", () => {
    for (const s of hn) {
      assert.ok(s.url.startsWith("https://hn.algolia.com/api/v1/search_by_date?query="), s.id);
      const p = params(s);
      assert.equal(p.get("tags"), "story", s.id);
      assert.equal(p.get("restrictSearchableAttributes"), "title", `${s.id}: the API default also searches comments and story text`);
      assert.equal(p.get("typoTolerance"), "false", `${s.id}: the API default matched "almost" for "LLM"`);
      assert.match(p.get("numericFilters") ?? "", /^points%3E%3D\d{2,3}$/, `${s.id}: points floor`);
      assert.equal(p.get("hitsPerPage"), "20", s.id);
      assert.ok(!s.url.includes("%22"), `${s.id}: the API treats a quoted phrase as exact ("local LLM" would miss "local LLMs")`);
    }
  });

  it("keeps the words and thresholds of the hnrss queries", () => {
    const want: Record<string, [query: string, points: number]> = {
      "hn-ai-150": ["AI", 150], "hn-llm-100": ["LLM", 100], "hn-local-llm": ["local+LLM", 20], "hn-claude-code": ["Claude+Code", 100],
      "hn-coding-agent": ["coding+agent", 50], "hn-llama-cpp": ["llama.cpp", 20], "hn-qwen": ["Qwen", 25], "hn-open-weights": ["open+weights", 20],
      "hn-vllm": ["vLLM", 20], "hn-mac-studio": ["Mac+Studio", 30], "hn-chinese-frontier-labs": ["DeepSeek+Kimi+GLM+Qwen", 150],
    };
    for (const [id, [query, points]] of Object.entries(want)) {
      const p = params(byId(id));
      assert.equal(p.get("query"), query, id);
      assert.equal(p.get("numericFilters"), `points%3E%3D${points}`, id);
    }
    // Any-of queries list the same words as optional; everything else needs every word.
    for (const s of hn) assert.equal(params(s).get("optionalWords"), ["hn-chinese-frontier-labs", "hn-local-stack"].includes(s.id) ? params(s).get("query") : undefined, s.id);
    // Qwen writes the version into the name: "Qwen4-Max" (882 points) never matched the exact word.
    for (const s of hn) assert.equal(params(s).get("queryType"), ["hn-qwen", "hn-chinese-frontier-labs", "hn-local-stack"].includes(s.id) ? "prefixLast" : "prefixNone", s.id);
    assert.ok(params(byId("hn-chinese-frontier-labs")).get("query")!.endsWith("+Qwen"), "the prefix applies to the LAST word");
  });

  it("is read as JSON, attributed to the article's host, and behaves like the query feeds it replaced", () => {
    for (const s of hn) {
      const r = resolveSource(s);
      assert.equal(s.kind, "json", s.id);
      // The article URL; a text post (url: null) falls back to its HN thread, as hnrss linked it.
      assert.deepEqual(s.jsonApi, { itemsPath: "hits", titleField: "title", urlField: "url", urlTemplate: "https://news.ycombinator.com/item?id={objectID}", dateField: "created_at" }, s.id);
      assert.equal(r.attribution, "link-host", `${s.id}: kind json defaults to source attribution`);
      assert.equal(r.outlets, "open", s.id);
      assert.equal(s.publisher, "hacker-news", s.id);
      assert.equal(s.tier, 4, s.id);
      assert.equal(r.routing, "normal", s.id);
      assert.equal(s.homepage, "https://news.ycombinator.com/", s.id);
    }
    // Defaults that kind "query" gave and kind "json" must still give.
    assert.deepEqual([resolveSource(byId("hn-ai-150")).leadEligible, resolveSource(byId("hn-ai-150")).countsForCoverage], [true, true]);
    assert.deepEqual([resolveSource(byId("hn-mac-studio")).leadEligible, resolveSource(byId("hn-mac-studio")).countsForCoverage], [false, false]);
  });
});

describe("LOCAL & OPEN MODELS sources (final fix round)", () => {
  const title = compileTerms(LOCAL_STACK_TERMS);

  it("keeps community threads that name a runtime, a model family or the hardware", () => {
    const lemmy = byId("lemmy-localllama");
    assert.equal(lemmy.includeIn, "title");
    assert.equal(lemmy.include, LOCAL_STACK_TERMS);
    for (const t of ["llama.cpp v1.0.0", "Small model showdown - LFM 3 Omni vs. Gemma E4B and derivatives", "Qwen3.8-27B Unsloth Dynamic v3.1 GGUFs out now!", "Multi-GPUs considerations", "Qwen announces Qwen4 smaller models (again, \"soon\") & benchmarks for Qwen4 Max", "Abliterated models usefulness", "Fully offline Hermes guide?", "Running DeepSeek-V4.1-Flash on a Mac Studio"]) assert.ok(title(t), t);
    for (const t of ["Jensen Huang Breaks Silence", "How it actually happened", "Qwalmost there!", "When your LLM has social anxiety", "OVH announces Olala mini 7A1B"]) assert.equal(title(t), null, t);
    for (const bare of ["LLM", "LLMs", "AI"]) assert.ok(!LOCAL_STACK_TERMS.includes(bare), `bare "${bare}" matches every thread`);
  });

  it("gives the DGX Spark forum's slots to measured runs, not to recruitment threads", () => {
    const s = byId("nvidia-forum-dgx-spark");
    const inc = compileTerms(s.include!);
    const exc = compileTerms(s.exclude!);
    const keep = (t: string): boolean => !exc(t) && Boolean(inc(t));
    assert.equal(s.includeIn, "title");
    assert.equal(s.maxKept, 5);
    for (const t of ["DeepSeek-V4.1-Flash on 4x DGX Spark GB10 (CX7 ring): full setup + cold prefill & decode numbers up to 1M context", "GLM-5.3-Flash on 2x DGX Spark: vLLM vs. TensorFold measured on the same pair (5 configs, 5 runs each, raw data)", "GB10: copying a private mmap to the GPU doubles host memory", "Hy4-Flash released!"]) assert.ok(keep(t), t);
    for (const t of ["Seeking 1x DGX Spark / GB10 tester: zero-Electron Python AI workstation (Local vLLM / NVIDIA Flare / NIM)", "Four Sparks vs Two. Looking for TP=4 vs TP=2 experiences", "DGX Spark Power Adapter Failure?", "Quiet MikroTik CRS804-4DDQ: one Noctua NF-A12x25 instead of the 2 × 40 mm Delta fans"]) assert.ok(!keep(t), t);
  });

  it("drops foundation and hosted-product news from the framework blogs", () => {
    const drops = (id: string, t: string): void => assert.ok(compileTerms(byId(id).exclude!)(t), `${id} must drop: ${t}`);
    const keeps = (id: string, t: string): void => assert.equal(compileTerms(byId(id).exclude!)(t), null, `${id} must keep: ${t}`);
    drops("pytorch-blog", "Celebrating the 2026 PyTorch Foundation Contributor Award Winners and Nominees");
    drops("pytorch-blog", "PyTorch Foundation Ambassador Community Highlights November 2026");
    drops("pytorch-blog", "KVCache Meetup Korea 2026: Event Recap");
    keeps("pytorch-blog", "ExecuTorch WebGPU: PyTorch Models on the GPU, in the Browser");
    keeps("pytorch-blog", "Integrating SGLang into Spyre in Under a Week with AI");
    drops("comfyui-blog", "Your custom ComfyUI is now in Comfy Cloud");
    drops("comfyui-blog", "Seedream 5.5 is now available via Partner Nodes");
    keeps("comfyui-blog", "Doubling LLM token rates in ComfyUI");
  });

  it("keeps the FCA's AI, cyber and quantum items and none of its consumer news", () => {
    const s = byId("fca-news");
    const inc = compileTerms(s.include!);
    const keep = (t: string, summary: string | null = null): boolean => Boolean(inc(t) ?? inc(summary));
    assert.ok(keep("FCA launches world-first platform giving firms new insight into AI innovation"));
    assert.ok(keep("UK financial watchdogs clarify cyber expectations as attacks rise"));
    assert.ok(keep("FCA to explore quantum computing to tackle financial crime"));
    assert.ok(keep("What we’re learning from firms engaging with our innovation services", "Three themes stand out: the growing use of AI, innovation crossing traditional sector boundaries."));
    for (const t of ["Geordie Shore star and illegal finfluencer sentenced for promoting high-risk investments on social media", "Insurance firms called on to improve claims handling", "FCA charges individual with money laundering", "FCA proposes greater pension investment flexibility to support long-term value for savers"]) assert.ok(!keep(t), t);
    assert.match(s.note ?? "", /REPLACES the global AI gate/);
  });
});
