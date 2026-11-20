import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTerms } from "../../../shared/text";
import { isSectionId } from "../../../shared/sections";
import { aiRelevance, COMPUTE_TERMS, CONTEXT_TERMS, HOME_BEAT_LEAD_TERMS, HOME_BEAT_TERMS, isTeaserSummary, LEAD_CHARS, MODEL_FAMILY_TERMS, STRONG_TERMS, SUMMARY_HITS_REQUIRED, type GateRule } from "./aiTerms";

const verdict = (title: string, summary: string | null = null, home?: Parameters<typeof aiRelevance>[2]) => aiRelevance(title, summary, home);

describe("aiRelevance - the rule", () => {
  it("a strong term in the title passes", () => {
    const v = verdict("Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book");
    assert.deepEqual([v.pass, v.rule, v.hits], [true, "title", ["anthropic"]]);
  });

  it("summary-only needs two DIFFERENT strong signals", () => {
    assert.equal(SUMMARY_HITS_REQUIRED, 2);
    const long = "x".repeat(LEAD_CHARS);
    assert.equal(verdict("The Silent Consensus", `${long} a strategist at OpenAI examines how more capable AI could reshape society`).rule, "summary");
    assert.equal(verdict("Quarterly results", `${long} AI is everywhere and AI is here and artificial intelligence is A.I.`).pass, false, "four spellings of one signal are one signal");
    assert.equal(verdict("Quarterly results", `${long} the company mentioned LLMs and large language models`).pass, false);
    assert.equal(verdict("Quarterly results", `${long} the company uses ChatGPT from OpenAI`).pass, true, "a product and its maker are two signals");
  });

  it("one strong term passes only when it OPENS the summary (a dek), not as an aside deep in an excerpt", () => {
    const lead = verdict("What Google and Reddit's bad days have in common", "AI search is underperforming for Google, and it's killing Reddit's traffic. What now?");
    assert.deepEqual([lead.pass, lead.rule], [true, "summary-lead"]);
    const aside = verdict(
      "Fed's Barr Says Inflation Calls for Further Policy Adjustment",
      "Federal Reserve Governor Michael Barr says inflation is too high and monetary policy needs to be adjusted further to balance risks at FinRegLab's AI Symposium. (Source: Bloomberg)",
    );
    assert.deepEqual([aside.pass, aside.rule, aside.hits], [false, "none", ["ai"]]);
  });

  // Gate re-measurement of 2026-11-20 (60 sampled passes): 5 of the 44 "summary-lead" passes were
  // newsletter teasers - a list of the issue's OTHER items, never the subject of this one.
  it("an 'also in this issue' teaser is not a dek: its one AI mention does not pass the item", () => {
    const teasers: [string, string][] = [
      ["IRR, Dollars of Alpha, or Dollars of Fees", "Plus! Diff Jobs; Intelligence; Nearly-Public; Insiders; The Micropolitics of AI; Factors of Production"],
      ["The Elasticity Business", "Plus! Jensen!?; Elasticity, Illustrated; Hiring; Strategy; Opsec and Romance"],
      ["Financial Predictionization", "Also black swan funds, data center delays and billable hour valuation."],
      ["The Pulse: What can we learn from the Railway hack?", "Also: native mobile and frontend jobs are disappearing, how trust helps an “AI-native” engineering team to succeed"],
      ["Big Tech Defied Tradition With a Risky Bet on Trump. It’s Not Looking Like a Winner.", "Plus, Anthropic S-1 reactions & a requiem for ‘Rest of World’"],
    ];
    for (const [title, summary] of teasers) {
      assert.ok(isTeaserSummary(summary), summary);
      assert.deepEqual([verdict(title, summary, { home: "money" }).pass, verdict(title, summary, { home: "money" }).rule], [false, "none"], title);
    }
    // The same issue passes when its TITLE is the AI story, or when the home desk's beat word is in it.
    assert.equal(verdict("Understanding Anthropic", "Plus! Pulled IPOs; Non-Fungibility; The News Business; Opt-Outs; Writing", { home: "money" }).rule, "title");
    assert.equal(verdict("The Economics of Ads for Agents", "Plus! Currency; Moving Up the Funnel; Circular Financing; L'Affairs Jensen; Assistants", { home: "money" }).rule, "context");
    assert.equal(verdict("The Agents Will Trade the Bonds", "Also sandwich spoofers, SBF and Martha Stewart.", { home: "analysis" }).rule, "home-beat");
    // Two different AI signals in a teaser still say the issue is about AI.
    assert.equal(verdict("Madness and mayhem", "Also a note on Jensen, AI spending, data centers & Anthropic", { home: "analysis" }).rule, "summary");
    // An ordinary dek that happens to contain the word is untouched.
    assert.ok(!isTeaserSummary("AI search is underperforming for Google, plus it's killing Reddit's traffic."));
    assert.ok(!isTeaserSummary("Plush toys with chatbots inside are this year's surprise hit."));
    assert.ok(!isTeaserSummary("Alsop Louie Partners backs an AI lab."));
    assert.ok(!isTeaserSummary("also known as In-Context Prompting, refers to methods for how to communicate with LLM"));
    assert.ok(!isTeaserSummary("Also known as the agentic web, the idea is older than it looks."));
    assert.ok(!isTeaserSummary(null));
    assert.equal(verdict("What Google and Reddit's bad days have in common", "AI search is underperforming for Google, and it's killing Reddit's traffic. What now?").rule, "summary-lead");
  });

  it("a context term in the title counts when the summary supplies the AI context", () => {
    const filler = "y".repeat(LEAD_CHARS);
    const v = verdict("Startup accelerator opens applications for its winter batch", `${filler} with a track for teams building on Claude`);
    assert.deepEqual([v.pass, v.rule], [true, "context"]);
    assert.equal(verdict("Startup accelerator opens applications for its winter batch", "Founders can apply until January.").pass, false);
    assert.equal(verdict("ICE agents raid warehouse", "Immigration officers detained workers on Tuesday.").pass, false, "'agent' alone is not AI");
  });

  it("a source's home beat widens the title vocabulary for that desk only", () => {
    const hw = "Everything About The New Liquid Cooling Loop";
    assert.deepEqual([verdict(hw, null, { home: "compute" }).pass, verdict(hw, null, { home: "compute" }).rule], [true, "home-beat"]);
    assert.equal(verdict(hw, null, { home: "money" }).pass, false);
    const agents = "Build once, run on any agent: A practical guide to agent skills";
    assert.equal(verdict(agents, null, { home: "tools" }).pass, true);
    assert.equal(verdict(agents, null, { home: "industry" }).pass, false);
  });

  it("word boundaries: 'ai' is not found inside other words", () => {
    for (const title of ["Chairman said the airline will maintain its Dubai route", "Email campaign details remain unclear", "Captain praises training regime", "Haiti aid waits at Port-au-Prince", "Rain delays Spain's main train"]) {
      assert.equal(verdict(title).pass, false, title);
    }
    for (const title of ["AI-powered search arrives", "The A.I. boom", "Is this AI?", "‘AI’ in quotes", "Voice AI, explained", "GenAI at work", "New AIs emerge"]) {
      assert.equal(verdict(title).pass, true, title);
    }
  });

  it("'AI' as a capitalised product prefix counts (AIStor, AIOps) but AIDS / AIM do not", () => {
    assert.equal(verdict("MinIO Announces General Availability of AIStor Memory at SC26").pass, true);
    assert.equal(verdict("AIOps Platform Raises Series B").pass, true);
    assert.equal(verdict("New AIDS vaccine trial begins").pass, false);
    assert.equal(verdict("AIM-listed miner raises funds").pass, false);
  });

  it("plurals, hyphens and wildcards", () => {
    for (const title of ["LLMs in production", "Chatbots for banks", "Open-source GPUs?", "Fine-tuning on a laptop", "Finetuned adapters", "GPT5 rumours", "ChatGPT's memory", "Open weight release", "Robotics startup raises $50M", "Robotaxis reach Austin", "Hallucinations in court filings", "Vibe-coded apps", "Qwen3 on a phone"]) {
      assert.equal(verdict(title).pass, true, title);
    }
  });

  it("empty input", () => {
    assert.deepEqual(verdict("", null), { pass: false, rule: "none", hits: [] });
    assert.equal(aiRelevance("", undefined).pass, false);
  });
});

describe("aiRelevance - named stories from the review (fixture corpus titles + summaries)", () => {
  // [title, summary, home, expected pass]
  const DROP: [string, string, string][] = [
    ["Bloomberg Green New York 2026 Highlights", "Bloomberg Green convened industry leaders, policymakers, and climate innovators during Climate Week NYC to explore what's next in the transition to a more resilient and future-ready world. (Source: Bloomberg)", "money"],
    ["Fed's Barr Says Inflation Calls for Further Policy Adjustment", "Federal Reserve Governor Michael Barr says inflation is too high and monetary policy needs to be adjusted further to balance risks at FinRegLab's AI Symposium. (Source: Bloomberg)", "money"],
    ["Australia’s Leader to Navigate Trade, Security in Talks With Xi", "Australian Prime Minister Anthony Albanese will aim to navigate delicate security and trade issues when he meets Chinese President Xi Jinping on Friday, seeking to ease access for commodities.", "money"],
    ["War-Driven Cost Squeeze Alarms Companies, Bank of America Says", "What began as an oil-market shock from the Iran war has broadened into a cost squeeze across the US, with business owners growing significantly more concerned about commodity prices.", "money"],
    ["Copper Rebounds After Rout as Physical Tightness Persists", "Copper clawed back some of its losses after plunging almost 6% on Wednesday — the biggest drop since April 2025 — as traders unwound bullish bets linked to artificial intelligence and US tariffs.", "money"],
    ["Crunch Fitness Sells $800 Million of ABS Tied to Franchise Deals", "Crunch Fitness sold $800 million of asset backed securities on Thursday, the latest in a recent streak of whole-business bond deals.", "money"],
    ["Latin America Currencies Sink on Rate Worries; Brazil Intervenes", "A sell-off in Latin American currencies deepened Thursday, sending the Mexican peso to its lowest since June 2025.", "money"],
    ["U.S. crude oil declines to $85 a barrel on recovering Middle East exports", "Oil prices are falling as forecasts project a surplus in oil in the fourth quarter", "industry"],
    ["Meta premieres India’s First Government-Led Microdrama Series on Scams Awareness", "Meta has partnered with The Ministry of Information & Broadcasting (MIB), Prasar Bharati, Securities and Exchange Board of India (SEBI), and Indian Cyber Crime Coordination Centre (I4C) to launch India's first microdrama series.", "models"],
    ["Forum, a Dedicated App for Facebook Groups, Is Now Available in Indonesia", "Forum is now available in Indonesia, bringing Facebook Groups into one dedicated app to make joining conversations, finding answers and exploring interests easier.", "models"],
    ["The Blue Economy: The World’s Quietest Economic Engine And Its Smartest Cities", "The $2.6 trillion blue economy is creating startup opportunities in maritime automation, clean energy and logistics, with blue tech hubs emerging.", "money"],
    ["The PSF end-of-year fundraiser", "With my Python Software Foundation board director hat on: we just launched our end-of-year fundraiser.", "analysis"],
    ["Sofia Franklyn’s ‘Call Her Daddy’ Tell-All Is Riveting Podcasters and Their Fans", "Podcasts are helping turn Sofia Franklyn’s memoir, Daddy Issues, into a monster hit", "industry"],
    ["Everful, which connects smaller retailers and brands with Chinese factories and manages the process from order to delivery, raised a $48.5M Series B", "Everful, a San Francisco- and Singapore-based startup that connects smaller retailers and brands with factories in China, raised new funding.", "industry"],
    ["Pakistan undersea cable fault causes internet failure near Strait of Hormuz", "Pakistan's telecommunications authority has confirmed that an undersea network cable fault is degrading connectivity.", "compute"],
    ["NSF ACCESS Earns 2 HPCwire Awards at SC26", "Nov. 19, 2026 — The U.S. National Science Foundation ACCESS program was recognized for its outstanding achievements in the annual awards.", "compute"],
    ["Gartner Warns of Risks Behind Sovereign Tech Claims", "Gartner research predicts that digital sovereignty will become a core component of national strategy.", "compute"],
    ["High-End Furniture Marketplace AptDeco Is Taking People’s Furniture and Not Paying Them", "“It genuinely feels like I’ve had something stolen from me.”", "industry"],
    ["What the Blue Wave in Texas Means for Elon Musk’s Tesla and SpaceX", "Watch WSJ’s Becky Peterson explain what’s next for Musk’s projects in the Lone Star State.", "industry"],
    // The task's own examples (not in the 2026-11-19 corpus; representative wording):
    ["Diesel Prices Jump as Refinery Outages Squeeze Supply", "Diesel futures climbed for a fourth day as unplanned refinery outages tightened supplies across the US Gulf Coast.", "money"],
    ["US, India Near Trade Deal That Would Cut Tariffs on Farm Goods", "Negotiators are closing in on a trade agreement that would lower tariffs on agricultural products, people familiar said.", "money"],
    ["Meta Completes 2Africa Subsea Cable, Connecting 33 Countries", "The subsea cable system is now the longest in the world, linking Africa, Europe and Asia with new landing stations.", "models"],
    ["RPCS3 PS3 emulator now boots every game in the console's library", "The open-source PlayStation 3 emulator has reached a long-awaited compatibility milestone after 14 years of development.", "compute"],
    ["Virgin Media O2 switches on 1,000 small cells to boost 5G capacity in UK cities", "The operator says the small cells, mounted on street furniture, will relieve congestion in busy urban areas.", "compute"],
  ];
  const KEEP: [string, string, string, GateRule][] = [
    ["Big Checks and Big Blobs of Compute", "Our first public frontier AI company is here.", "money", "summary-lead"],
    ["Stocks Fall as Anthropic Debut Not an AI All-Clear: Markets Wrap", "A rally in stocks fizzled out as Anthropic PBC’s solid market debut failed to sustain enthusiasm for the artificial-intelligence trade.", "money", "title"],
    ["Anthropic IPO Said to Draw Over $9.4 Billion in Japan Order Book", "Anthropic PBC drew orders for more than three times the shares available in the Japan tranche of its US initial public offering.", "money", "title"],
    ["Anthropic Shares Soar Above IPO Price, Then Fall", "Anthropic PBC shares traded 17% above their IPO price after the company's debut.", "industry", "title"],
    ["MinIO Announces General Availability of AIStor Memory at SC26", "REDWOOD CITY, Calif. and CHICAGO, Nov. 19, 2026 – MinIO has announced general availability.", "compute", "title"],
    ["November 2026 Top500 New Systems Are Few and Far Between", "We check out the new systems in the November 2026 Top500 list and see what is new.", "compute", "title"],
    ["AMD's shares fall 6%+ after Hunterbrook disclosed a short position, warning AMD is engaging in \"circular deals\"", "Advanced Micro Devices Inc. shares slid after Hunterbrook warned about its accounting.", "industry", "title"],
    ["Intel 18A yields hit 70% as company signs Microsoft as EMIB customer", "Intel's 18A yields achieve an important milestone as the company signs a new packaging customer.", "compute", "title"],
    ["Nscale’s ByteDance Deal Faces Scrutiny Under US Chip Curbs", "Nscale Plc’s agreement to sell artificial intelligence computing capacity to ByteDance is drawing scrutiny.", "industry", "title"],
    ["Google’s Gemini Can Now Control Mac Devices on Users’ Behalf", "Google’s Gemini can now take control of Mac computers to complete tasks.", "industry", "title"],
    ["JPMorgan is working on AI agent transactions that don’t involve humans", "JPMorgan and Hyundai Card are looking to expand the use of AI agents in payments.", "industry", "title"],
    ["Deutsche Telekom’s Tech Fund Invests $110 Million in Mistral AI", "The company said the investment in the startup’s Series D funding round paved the way for a partnership.", "industry", "title"],
    ["London-based Boltz, which is developing AI models to speed up drug discovery, raised a $110M Series A led by Bessemer", "Boltz was spun out of MIT but is now located in London.", "industry", "title"],
    ["India’s Humyn Labs raises $47M to feed US robotics companies the data they need", "Founded in February, Humyn Labs competes with startups such as Mecka AI.", "money", "title"],
    ["Muse Is Now Available in Australia: The World’s First Personal AI Agent Built for Everyone", "Muse is available in Australia from today, with local connector experiences rolling out progressively.", "models", "title"],
    ["Perplexity Launches Orchestrator API", "The new API lets developers chain search and reasoning steps.", "research", "title"],
    ["The frontier labs launch election war rooms", "An old playbook is back for the deepfake era. Is it working?", "industry", "title"],
    ["Jensen wants to come back", "The former Nvidia CEO is getting a frosty reception from his fellow CEOs and his own board. Good.", "industry", "title"],
    ["See How Data Centers Became the Growth Engine of America’s Power Grid", "Electricity use by commercial customers—a broad category that includes data centers—is poised to surpass residential demand.", "industry", "title"],
    ["Building the Agent Host Protocol for sessions that continue across devices", "Discover how we built the open Agent Host Protocol to keep your agent sessions accessible everywhere.", "tools", "home-beat"],
  ];

  for (const [title, summary, home] of DROP) {
    it(`drops: ${title.slice(0, 80)}`, () => {
      assert.ok(isSectionId(home));
      const v = aiRelevance(title, summary, { home });
      assert.equal(v.pass, false, JSON.stringify(v));
    });
  }
  for (const [title, summary, home, rule] of KEEP) {
    it(`keeps: ${title.slice(0, 80)}`, () => {
      assert.ok(isSectionId(home));
      const v = aiRelevance(title, summary, { home });
      assert.deepEqual([v.pass, v.rule], [true, rule], JSON.stringify(v));
    });
  }
});

describe("aiRelevance - stories the 2026-11-20 build dropped (review PF-1)", () => {
  // [title, summary, the source's home, the rule that must pass it] - real items of the live build, all dropped "off_topic".
  const RECOVERED: [string, string | null, string, GateRule][] = [
    // Current model / product names
    ["FIS rolls out monthly security patches as Mythos exposes hidden flaws", null, "money", "title"],
    ["RLVR on Inkling 2 Small: Beating GLM-5.3-Flash in 60 Steps for $22", "RLVR field notes · Security work · November 2026 0.708 pass@1 · 12-task exploit suite vs best GLM arm +27 pp", "open_local", "title"],
    ["Meta Muse booked an Airbnb without permission – and that’s not the worst of it", null, "industry", "title"],
    ["Confronting the Limits of Recursive Self-Improvement", null, "policy", "title"],
    ["Jensen Out, MATCH Act In?", null, "policy", "title"],
    ["A post-Jensen world and the internal combustion horse", null, "industry", "title"],
    ["Jensen's Bizarre Adventure", null, "analysis", "title"],
    // The desk's beat word in the title
    ["Long-horizon agents and durable execution", "Long-horizon agents can automate complex tasks that take days or weeks to complete.", "analysis", "home-beat"],
    ["The Economics of Ads for Agents", "Plus! Currency; Moving Up the Funnel; Circular Financing; Assistants", "money", "home-beat"],
    ["BIS Takes on Compute Leakage", "Is the era of compute leakage over?", "policy", "home-beat"],
    ["Making HTTP header injection critical with one prompt", "You can now escalate HTTP header injection to a CRLF-Powered Desync and exploit it to serve random users a redirect.", "ai_security", "home-beat"],
    ["Run 70B weights on a 24 GB card", "A walk through the trade-offs.", "open_local", "home-beat"],
    ["Which GGUF quantization should you pick?", null, "open_local", "home-beat"],
    // "agent" opening the summary, on a desk where an agent is an AI agent
    [
      "Nanobot - bwrap Sandbox Bypass",
      "In nanobot >= 0.2.1 < 0.4.1, the `exec` tool accepts an agent-selected shell override but validates it only by file name and executable bit, then launches that file on the host.",
      "ai_security",
      "home-beat",
    ],
    ["Inside GitHub’s new Git storage architecture", "GitHub's new Git storage architecture is built so thousands of agents can push to a single repository at once. Here's how it works.", "tools", "home-beat"],
    ["Where should your code live in a Docker Sandbox?", "Coding agents need a workspace: bind-mount the repo or clone it inside the sandbox?", "tools", "home-beat"],
  ];
  for (const [title, summary, home, rule] of RECOVERED) {
    it(`keeps: ${title.slice(0, 80)}`, () => {
      assert.ok(isSectionId(home));
      const v = aiRelevance(title, summary, { home });
      assert.deepEqual([v.pass, v.rule], [true, rule], JSON.stringify(v));
    });
  }

  // The new names are spelled so that their everyday meanings stay out.
  const STILL_DROPPED: [string, string | null, string][] = [
    ["Elon Musk muses about a Mars colony", null, "industry"],
    ["Regulators had no inkling of the outage", null, "money"],
    ["Kimi Antonelli wins the Brazilian Grand Prix", null, "industry"],
    ["Bert and Ernie return for a 57th season", null, "industry"],
    ["Biden-era cancer moonshot loses its funding", null, "policy"],
    ["A threat model for the browser sandbox", "How we model the attacker, and what the sandbox does and does not contain.", "ai_security"],
    ["Tesla Model Y recall widens", "The recall covers model years 2024 to 2026.", "ai_security"],
    ["ICE agents raid warehouse", "Immigration agents detained workers on Tuesday.", "industry"],
    ["Estate agents brace for a slow winter", "Agents report the weakest listings since 2012.", "industry"],
    ["Patch Tuesday fixes 61 flaws", "Microsoft's November release closes 61 vulnerabilities across Windows, Office and Exchange, four of them rated critical; one was reported by an agent of the vendor's partner programme.", "ai_security"],
    ["Cache poisoning via the User-Agent header", "A crafted User-Agent reaches the cache key on some CDNs.", "ai_security"],
    // "agent" in a summary counts only on the tools / ai_security / analysis desks
    ["Quarterly results beat estimates", "Agents at the call centre handled record volumes.", "money"],
    ["Prompt payment rules for suppliers take effect", null, "policy"],
  ];
  for (const [title, summary, home] of STILL_DROPPED) {
    it(`drops: ${title.slice(0, 80)}`, () => {
      assert.ok(isSectionId(home));
      const v = aiRelevance(title, summary, { home });
      assert.equal(v.pass, false, JSON.stringify(v));
    });
  }

  it("every model family the routing rules and the importance score know passes the gate from a general source", () => {
    // route/rules.ts "models/launch" and score/importance.ts ENTITIES list these families (a stage
    // may not import a sibling, so the headlines are spelled out). importance.test.ts calls
    // "Kimi K3.1 Pro is now available" a model launch; the gate used to drop it.
    const headlines = [
      "Kimi K3.1 Pro is now available",
      "Kimi K3.1 Pro tops the open leaderboard",
      "Zhipu's GLM-5 lands on Hugging Face", // also "zhipu", "hugging face"
      "GLM-5.3-Flash beats its teacher",
      "Baidu ships ERNIE 5.0 Turbo",
      "ERNIE Bot passes 400 million users",
      "Tencent open-sources Hunyuan 3D 4.0",
      "MiniMax H3 weights are out",
      "ByteDance's Doubao 2.0 undercuts rivals",
      "Nemotron 4 runs on a single workstation",
      "Mythos Preview finds 27-year-old OpenBSD bug",
      "Muse Spark comes to WhatsApp",
      "Moonshot AI raises at $12B",
    ];
    for (const title of headlines) assert.deepEqual([aiRelevance(title, null).pass, aiRelevance(title, null).rule], [true, "title"], title);
    assert.ok(MODEL_FAMILY_TERMS.every((t) => STRONG_TERMS.includes(t)));
  });

  it("'agent' counts in the summary only inside its first LEAD_CHARS characters", () => {
    const deep = `${"x".repeat(LEAD_CHARS)} an agent-selected shell override`;
    assert.equal(aiRelevance("Nanobot - bwrap Sandbox Bypass", deep, { home: "ai_security" }).pass, false);
    assert.deepEqual(Object.keys(HOME_BEAT_LEAD_TERMS).sort(), ["ai_security", "analysis", "tools"]);
    for (const terms of Object.values(HOME_BEAT_LEAD_TERMS)) assert.deepEqual(terms, ["agent"]);
  });
});

describe("term lists", () => {
  it("contain the terms the plan names", () => {
    const strong = new Set(STRONG_TERMS);
    for (const t of ["ai", "artificial intelligence", "llm", "gpt*", "claude", "gemini", "openai", "anthropic", "machine learning", "neural", "agentic", "chatbot", "generative", "model weights", "deepfake", "prompt injection", "gpu"]) {
      assert.ok(strong.has(t), t);
    }
    assert.ok(COMPUTE_TERMS.includes("accelerator"));
  });

  it("compile cleanly, without duplicates, and never match the empty string", () => {
    for (const list of [STRONG_TERMS, COMPUTE_TERMS, CONTEXT_TERMS, ...Object.values(HOME_BEAT_TERMS)]) {
      assert.equal(new Set(list.map((t) => t.toLowerCase())).size, list.length);
      const m = compileTerms(list, { plural: true });
      assert.equal(m.size, list.length);
      assert.equal(m(""), null);
      assert.equal(m("the of and to in"), null);
    }
    for (const id of Object.keys(HOME_BEAT_TERMS)) assert.ok(isSectionId(id), id);
  });

  it("no strong term is also listed as compute / context (a term has one weight)", () => {
    const strong = new Set(STRONG_TERMS);
    for (const t of [...COMPUTE_TERMS, ...CONTEXT_TERMS]) assert.ok(!strong.has(t), t);
  });
});
