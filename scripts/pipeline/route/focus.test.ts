import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hoursAgo, makeNormalized, makeScoredStory } from "../../../test/helpers/factories";
import { createTestContext } from "../context";
import type { NormalizedItem, ScoredStory } from "../types";
import { focusOf, hasFocus } from "./focus";
import { route } from "./index";
import { SECTION_FOCUS } from "./rules";

let seq = 0;
function story(title: string, o: { score?: number; hours?: number; lead?: Partial<NormalizedItem> } = {}): ScoredStory {
  seq += 1;
  return makeScoredStory([makeNormalized({ title, publisher: `pub-${seq}`, sourceId: `src-${seq}`, publishedAt: hoursAgo(o.hours ?? 3), ...o.lead })], { score: o.score ?? 50 });
}
const why = (title: string, lead: Partial<NormalizedItem> = {}): string | null => focusOf(story(title, { lead }), "open_local")?.why ?? null;
const points = (title: string, lead: Partial<NormalizedItem> = {}): number => focusOf(story(title, { lead }), "open_local")?.points ?? 0;

describe("section focus (LOCAL & OPEN MODELS)", () => {
  it("three sections have focus rules, and the bonus stays under one publisher's worth of coverage", () => {
    assert.deepEqual(Object.keys(SECTION_FOCUS), ["open_local", "policy", "ai_security"]);
    assert.ok(hasFocus("open_local") && hasFocus("policy") && hasFocus("ai_security") && !hasFocus("models") && !hasFocus("money"));
    for (const rules of Object.values(SECTION_FOCUS)) for (const rule of rules ?? []) assert.ok(rule.points > 0 && rule.points < 22, rule.id);
    assert.equal(focusOf(story("llama.cpp b12557 released"), "tools"), null);
  });

  it("POLICY: a headline naming the SEC, FINRA, the CFTC or the OCC - not a former official, not a newsletter's name", () => {
    const policy = (title: string): string | null => focusOf(story(title), "policy")?.why ?? null;
    assert.equal(policy("Nvidia facing SEC probe after Huang's resignation, WSJ reports"), "policy/us-finreg +14 title[SEC]");
    assert.equal(policy("An AI-Focused Fireside Chat with SEC IM Director Brian Daly"), "policy/us-finreg +14 title[SEC]");
    assert.equal(policy("Private Equity, AI Spark Audit Firm Ethics Rule Questions at SEC"), "policy/us-finreg +14 title[SEC]");
    assert.equal(policy("Regulatory Notice 26-24: FINRA has adopted amendments to FINRA Rule 2210"), "policy/us-finreg +14 title[FINRA]");
    assert.equal(policy("OCC bulletin on third-party model risk"), "policy/us-finreg +14 title[OCC]");
    assert.equal(policy("What the new rule means for broker-dealers using chatbots"), "policy/us-finreg +14 title[broker-dealer*]");
    for (const title of [
      "Former SEC chair warns AI bubble could burst before 2028 US election",
      "‘It's already a bubble’: Ex-SEC chair Gary Gensler warns AI burst could push economy into recession",
      "[tl;dr sec] #355 - agent sandboxes",
      "Senate Passes Major Permitting Bill to Speed Up Energy Projects",
      "Bank of England publishes effective practices on AI",
    ]) {
      assert.equal(policy(title), null, title);
    }
  });

  it("AI SECURITY: the outage wave - a report tying outages to AI-found vulnerabilities, not a bare outage headline", () => {
    const sec = (title: string): string | null => focusOf(story(title), "ai_security")?.why ?? null;
    assert.equal(sec("Consensus mounts that tech outages were fueled by patching of AI-discovered vulnerabilities"), "ai_security/ai-found +20 title[ai-discovered vulnerabilit*]");
    assert.equal(sec("The link between 'patchmageddon' and recent tech outages"), "ai_security/ai-found +20 title[patchmageddon]");
    assert.equal(sec("These tech outages are giving Y2K, AI agent style"), "ai_security/outages +14 title[outages]");
    assert.equal(sec("This week’s US bank outage was AI-related after all"), "ai_security/outages +14 title[outage]");
    assert.equal(sec("What’s With All These Outages?"), null);
    assert.equal(sec("Microsoft patch causes Outlook outage"), null);
    assert.equal(sec("Navigating Vulnerability Hysteria in the AI Era"), null);
  });

  it("recognises what the section is about: runtimes, quantization, open-weight releases, local hardware", () => {
    assert.equal(why("llama.cpp b12557 released"), "open_local/runtime +20 title[llama.cpp]");
    assert.equal(why("Keeping Agents Fast: High-Interactivity Decode with FlyDSL MonoKernels in vLLM"), "open_local/runtime +20 title[vllm]");
    assert.equal(why("AMD and Unsloth Bring NPU Support to 100+ Agentic AI Applications"), "open_local/runtime +20 title[unsloth]");
    assert.equal(why("Remote MLX GPU backend for Linux containers on Apple Silicon"), "open_local/runtime +20 title[MLX]");
    assert.equal(why("Higher-Fidelity Qwen3.8 Quantizations land on the Hub"), "open_local/quantization +20 title[quantiz*]");
    assert.equal(why("An updated Clairic and Clairic-flash are now open-weight, from the new Workers AI team"), "open_local/weights-release +20 title[open-weight*]");
    assert.equal(why("Mistral Releases Downloadable Large 4 Weights"), "open_local/weights-release +20 title[weights]");
    assert.equal(why("Three 'e-waste' Nvidia V100s hit 100 tokens per second on Qwen 3.6 35B in a $1,042 homelab rig"), "open_local/hardware +14 title[tokens per second]");
    assert.equal(why("180B Parameters, 32GB of RAM: Pushing MoE Inference to the Limit with Transformers"), "open_local/hardware +14 title[*gb of ram]");
    assert.equal(points("Mac Studio M5 Ultra 512GB Officially Released"), 14);
  });

  it("gives nothing to a headline that only mentions the section's words (the live #1, #3, #6 and #9)", () => {
    for (const title of [
      "Palo Alto Networks opens wallet for open-weight training biz",
      "Open-weight AI models need a 5G-style test on provenance",
      "Palo Alto stock jumps on earnings beat and company's big bet on securing open-weight models",
      "Pete warden on local AI, open models, voice interfaces, the future of hardware",
      'AMD AI Engine "AIE" Driver Posted For Mainline Linux Kernel Review',
      "What is the future of open-source AI in a post-Jensen world?",
      "AWS Open-Sources Emulator for Local Testing of 200+ Services by Coding Agents",
      "OpenAI weighs a new funding round",
      "mlx is lowercase here and means nothing",
    ]) {
      assert.equal(why(title), null, title);
    }
  });

  it("reads a first-party runtime blog's name, and never a forum thread", () => {
    assert.equal(why("Making open models work for long-horizon agentic workloads", { sourceName: "Ollama Blog" }), "open_local/runtime +20 source[ollama]");
    assert.equal(why("Introducing Agent Remote Control", { sourceName: "LM Studio Blog" }), "open_local/runtime +20 source[lm studio]");
    assert.equal(why("Introducing Agent Remote Control", { sourceName: "Some Other Blog" }), null);
    const thread = { kind: "community" as const, flags: ["discussion" as const] };
    assert.equal(why("Seeking 1x DGX Spark / GB10 tester: zero-Electron Python AI workstation (Local vLLM / NVIDIA Flare / NIM)", thread), null);
  });

  it("orders LOCAL by score + focus, and nothing else: scores, other sections and TOP are untouched", () => {
    const ctx = createTestContext();
    // The four tangential rows that led the live section, and the on-topic rows that sat below them.
    const acquisition = story("Palo Alto Networks opens wallet for open-weight training biz", { score: 63.3, lead: { home: "industry" } });
    const essay = story("Open-weight AI models need a 5G-style test on provenance", { score: 53.0, lead: { home: "policy" } });
    const homelab = story("Three 'e-waste' Nvidia V100s hit 100 tokens per second on Qwen 3.6 35B in a $1,042 homelab rig", { score: 46.1, lead: { home: "compute" } });
    const vllm = story("Keeping Agents Fast: High-Interactivity Decode with FlyDSL MonoKernels in vLLM", { score: 39.0, lead: { home: "open_local" } });
    const clairic = story("An updated Clairic and Clairic-flash are now open-weight, from the new Workers AI team", { score: 37.1, lead: { home: "tools" } });
    const plain = story("A newsletter issue about nothing in particular", { score: 40.7, lead: { home: "open_local" } });
    const input = [acquisition, essay, homelab, vllm, clairic, plain];
    const pl = route(input, ctx);
    const rows = (id: string): string[] => pl.sections.find((s) => s.id === id)?.rows ?? [];
    // The acquisition is a MARKETS story since the closing round ("opens wallet" is a deal term and
    // outbids "open-weight"), so it no longer sits in LOCAL at all.
    assert.deepEqual(rows("open_local"), [homelab, vllm, clairic, essay, plain].map((s) => s.lead));
    assert.ok(rows("money").includes(acquisition.lead));
    for (const s of input) assert.equal(pl.stories[s.lead].score, s.score, "the story's score is not changed");
    assert.equal(pl.trace?.[vllm.lead]?.focus?.open_local, "open_local/runtime +20 title[vllm]");
    assert.equal(pl.trace?.[acquisition.lead]?.focus, undefined);
    // CHIPS lists the homelab story by its plain score, below a better-scoring chips story.
    const chips = story("Nvidia H200 exports to China cleared as data center demand grows", { score: 50, lead: { home: "compute" } });
    const pl2 = route([...input, chips], ctx);
    const compute = pl2.sections.find((s) => s.id === "compute")?.rows ?? [];
    assert.deepEqual(compute.slice(0, 2), [chips.lead, homelab.lead]);
  });

  it("routes local-inference hardware and throughput headlines into LOCAL (they were CHIPS only)", () => {
    const ctx = createTestContext();
    const homelab = story("Three 'e-waste' Nvidia V100s hit 100 tokens per second on Qwen 3.6 35B in a $1,042 homelab rig", { lead: { home: "compute" } });
    const spark = story("NVIDIA DGX Spark Developer Kit Turns a Desk Into a Supercomputing Lab", { lead: { home: "compute" } });
    const studio = story("Apple reveals pricing for Mac Studio with 512GB of RAM", { lead: { home: "compute" } });
    const chips = story("TSMC raises capex forecast on AI chip demand", { lead: { home: "compute" } });
    const pl = route([homelab, spark, studio, chips], ctx);
    const local = pl.sections.find((s) => s.id === "open_local")?.rows ?? [];
    for (const s of [homelab, studio]) assert.ok(local.includes(s.lead), s.items[0].title);
    assert.ok(!local.includes(chips.lead));
    // Unchanged rule: a second section needs stronger TITLE evidence than the home section has, and
    // "Supercomputing" + "NVIDIA" (CHIPS) outweigh "DGX Spark" (LOCAL). It stays a CHIPS row.
    assert.ok(!local.includes(spark.lead));
    assert.equal(pl.trace?.[spark.lead]?.routedTo, null);
    assert.match(pl.trace?.[homelab.lead]?.rule ?? "", /open_local\/runtime: title\[tokens per second, homelab\]/);
  });
});
