import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noiseKind, type NoiseKind } from "./noise";

describe("noiseKind", () => {
  const noise: [string, NoiseKind][] = [
    ["[Webinar] Securing AI agents in production", "webinar"],
    ["Join our webinar on LLM evaluation", "webinar"],
    ["On-demand webcast: the state of AI security", "webinar"],
    ["[Virtual Event] Agentic AI Summit 2026", "webinar"],
    ["Event: PyTorch Day China 2026", "event"],
    ["Call for Proposals: PyTorch Day China 2026", "event"],
    ["Call for papers – Workshop on Agent Safety", "event"],
    ["Register now for DevDay 2027", "event"],
    ["Registration is now open for the 2027 summit", "event"],
    ["Save the date: Interrupt 2027", "event"],
    ["Join us at NeurIPS 2026", "event"],
    ["Early-bird tickets on sale for ModCon", "event"],
    ["CEOs of Perplexity, Applied Intuition, Flapping Airplanes, Vercel & General Catalyst Join Cerebral Valley Speaker Lineup Ahead of Our Summit Next Week", "event"],
    ["Three more founders join our main-stage lineup for Thursday", "event"],
    ["We're hiring: research engineers", "job"],
    ["We’re hiring a head of policy", "job"],
    ["Job openings on the interpretability team", "job"],
    ["Join our team in London", "job"],
    ["Applications are now open for the residency", "job"],
    ["Head of Hiring", "job"],
    ["DC Chief of Staff", "job"],
    ["Research Fellow", "job"],
    ["Research Scholar", "job"],
    ["Talent Program Manager", "job"],
    ["Research Manager (UK Fellowships)", "job"],
    ["DC Research Manager (Talent Development Team)", "job"],
    ["UK Summer Fellowship 2027, Applied Track", "job"],
    ["DC Winter Fellowship 2027", "job"],
    ["Sponsored: How Acme secures its models", "sponsored"],
    ["[Sponsored] The future of observability", "sponsored"],
    ["Five ways to cut inference cost (Sponsored)", "sponsored"],
    ["Sponsored post: meet the new platform", "sponsored"],
    ["Partner content: scaling retrieval", "sponsored"],
    ["AI Archives", "index"],
    ["Machine Learning Archive", "index"],
    ["Category: Artificial Intelligence", "index"],
    ["Tag: LLM", "index"],
    ["Blog", "index"],
    ["Latest news", "index"],
    ["Posts - Page 2 of 14", "index"],
    ["Season’s Streamings and Savings: Black Friday Deals Come to GeForce NOW", "promo"],
    ["The best Cyber Monday deals on GPUs", "promo"],
    ["Best laptop deals this week", "promo"],
    ["Save 36% on this 4TB Samsung 990 Pro SSD upgrade for your gaming PC, now just 17.5 cents per GB", "promo"],
    ["Get 32GB of DDR5 for $240 with this blistering Intel gaming PC bundle", "promo"],
    ["RTX 5090 drops 20% off at Newegg", "promo"],
    ["Use this promo code for the conference", "promo"],
    ["Holiday gift guide for developers", "promo"],
    ["Win a DGX Spark in our giveaway", "promo"],
  ];
  for (const [title, kind] of noise) it(`${kind}: ${title}`, () => assert.equal(noiseKind(title)?.kind, kind));

  const stories = [
    "State-sponsored hackers used Claude to automate intrusions",
    "Why Holiday Security Can't Wait for Black Friday",
    "OpenAI's DevDay event reveals GPT-6",
    "Nvidia's lineup of speakers at GTC tells you where the money is going",
    "Anthropic's new model lineup, explained",
    "Anthropic is hiring a head of model welfare, signalling a shift",
    "Head of OpenAI's safety team quits",
    "Microsoft's $10B deal with CoreWeave",
    "Nvidia deals blow to AMD with new GPU",
    "The archive of every model release since 2020, visualised",
    "NeurIPS conference: the five papers everyone is talking about",
    "GovAI in Washington, DC",
    "GovAI U.S. AI Policy Program",
    "Research on fellowships and AI talent pipelines",
    "Workshop paper shows jailbreaks transfer across models",
    "Amazon saves $2 billion with custom chips",
    "A coupon-collector analysis of token sampling",
    "Sponsor-backed lab releases open weights",
    "Chief of Staff at the White House weighs AI order",
    "Program Manager turned founder raises $30M for agents",
    "Introducing GPT-6.2 Astra and Sol",
    "",
  ];
  for (const title of stories) it(`story: ${title || "(empty)"}`, () => assert.equal(noiseKind(title), null));

  it("reads labels at the start of the summary", () => {
    assert.equal(noiseKind("How Acme secures its models", "Sponsored: Acme's platform protects every prompt.")?.kind, "sponsored");
    assert.equal(noiseKind("Securing agents in production", "Register now for our live session next week.")?.kind, "webinar");
    assert.equal(noiseKind("A real story", "State-sponsored actors were observed. Sponsored by nobody.")?.kind, undefined);
    assert.equal(noiseKind("A real story", null), null);
  });

  it("reports what matched", () => {
    assert.deepEqual(noiseKind("Join our webinar on LLM evaluation"), { kind: "webinar", match: "webinar" });
  });
});
