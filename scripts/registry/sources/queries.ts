// Search-style feeds: Google News queries (kind "query") and Hacker News story searches (kind "json",
// the official HN Algolia API). Publisher comes from the article link host. Google News results are
// relevance-ordered, so ingest takes the newest by date; every Google News query carries when:Nd.
//
// Field meanings: scripts/registry/types.ts. `maxKept` is the per-build cap after relevance;
// `maxItems` is the ingest window (newest-N before the gate).
//
// Outlets (scripts/registry/outlets.ts): a Google News query returns whatever outlet ranks for it, so
// these sources keep the default `outlets: "vetted"` - an outlet no registry publisher claims is
// emitted at tier 4, never leads and takes a cap slot only after the known outlets. HN searches are
// `outlets: "open"`: the points threshold is the quality signal and personal blogs are the point.
//
// Hacker News: the eleven hn-* sources read https://hn.algolia.com/api/v1/search_by_date directly.
// They used hnrss.org (a volunteer-run RSS proxy of the same API), which answered HTTP 502 for 4-7 of
// the eleven in every build and audit of 2026-11-20, and again when re-tested one request per 1.2 s
// (7 of 11 failed; the API answered 11 of 11 in under 0.5 s each). Ids, names, words and points
// thresholds are unchanged; item ids are unchanged because both routes give the same article URL.
// A text post (Ask HN / Show HN without a link, 3 of 93 items on 2026-11-20) has no `url`; it is
// linked to its HN thread through the urlTemplate fallback, as hnrss did.

import type { JsonApiConfig, SourceDef } from "../types";
import { GOV_AI_TERMS } from "./shared";

/** Shape of an HN Algolia story hit: title, article URL (the HN thread for a text post), ISO creation time. */
const HN_STORIES: JsonApiConfig = { itemsPath: "hits", titleField: "title", urlField: "url", urlTemplate: "https://news.ycombinator.com/item?id={objectID}", dateField: "created_at" };

/**
 * HN story search, newest first: every word of `words` in the TITLE (or any one of them with
 * `anyWord`), at least `minPoints` points. The fixed parameters reproduce what hnrss.org returned
 * (checked against the last hnrss answers of all eleven sources on 2026-11-20: identical lists for
 * ten; "LLM" additionally matches the plural "LLMs"): title only, no typo tolerance (the API default
 * matched "almost" for "LLM"), no prefix matching, 20 hits.
 *
 * `prefixLast` lets the LAST word match as a prefix. It exists for Qwen, which writes the version
 * into the name: the exact form (and hnrss) never matched "Qwen4-Max" (882 points on 2026-11-16) or
 * "Unsloth Qwen3.8-27B Quantizations".
 */
function hnStories(words: string, minPoints: number, opts: { anyWord?: boolean; prefixLast?: boolean } = {}): string {
  const q = words.trim().split(/\s+/).map(encodeURIComponent).join("+");
  const any = opts.anyWord ? `&optionalWords=${q}` : "";
  const prefix = opts.prefixLast ? "prefixLast" : "prefixNone";
  return `https://hn.algolia.com/api/v1/search_by_date?query=${q}${any}&tags=story&numericFilters=points%3E%3D${minPoints}&restrictSearchableAttributes=title&typoTolerance=false&queryType=${prefix}&hitsPerPage=20`;
}

/** What every HN search shares: JSON API, article-host attribution, no outlet vetting (see the header). */
const HN = { kind: "json", jsonApi: HN_STORIES, attribution: "link-host", outlets: "open", homepage: "https://news.ycombinator.com/" } as const;

export const QUERIES: readonly SourceDef[] = [
  {
    id: "hn-chinese-frontier-labs", name: "HN: Chinese Frontier Labs", publisher: "hacker-news",
    url: hnStories("DeepSeek Kimi GLM Qwen", 150, { anyWord: true, prefixLast: true }),
    ...HN, scope: "ai", home: "models", tier: 4, tags: ["china", "local-llm"],
    maxKept: 4,
    note: "HN stories naming DeepSeek, Kimi, GLM or Qwen with 150+ points (model drops, self-hosting write-ups, bans). Qwen is the last word so that it matches as a prefix ('Qwen4-Max', 'Qwen3.8-27B'). outlets open: the points threshold vouches for the link.",
  },
  {
    id: "gn-reuters-ai", name: "Reuters AI (Google News)", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:reuters.com+AI+when:7d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://www.reuters.com/technology/artificial-intelligence/",
    kind: "query", scope: "ai", home: "industry", tier: 3, tags: ["press", "wire"],
    maxKept: 6,
    note: "Reuters has no public RSS; Google News site: proxy. Results are relevance-ordered, so ingest must take the newest by date.",
  },
  {
    id: "hn-ai-150", name: "HN: AI (150+ points)", publisher: "hacker-news",
    url: hnStories("AI", 150),
    ...HN, scope: "ai", home: "industry", tier: 4, tags: ["community-signal"],
    maxKept: 5,
    note: "HN stories with 'AI' in the title and 150+ points. outlets open: the points threshold vouches for the link.",
  },
  {
    id: "hn-llm-100", name: "HN: LLM (100+ points)", publisher: "hacker-news",
    url: hnStories("LLM", 100),
    ...HN, scope: "ai", home: "industry", tier: 4, tags: ["community-signal"],
    maxKept: 5,
    note: "HN stories with 'LLM' in the title and 100+ points. Unlike the hnrss route this also matches the plural ('I'm making LLMs work on small and old devices'). outlets open: the points threshold vouches for the link.",
  },
  {
    id: "gn-ai-now-institute", name: "AI Now Institute", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:ainowinstitute.org+when:21d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://ainowinstitute.org",
    kind: "query", scope: "ai", home: "policy", tier: 4, tags: ["analysis", "fallback"],
    maxItems: 10, maxKept: 3,
    exclude: ["Archives", "Executive Summary:"],
    note: "ainowinstitute.org answers 403 site-wide (edge bot rule, since 2026-11-17), so the direct /feed is unusable; Google News site: proxy per triage. Re-test the direct feed at the next audit and revert if the block lifts.",
  },
  {
    id: "gn-prompt-injection", name: "GN: Prompt Injection", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=%22prompt+injection%22+OR+%22LLM+security%22+OR+%22AI+model+vulnerability%22+when:7d&hl=en-US&gl=US&ceid=US:en",
    kind: "query", scope: "ai", home: "ai_security", tier: 4, tags: ["security"],
    maxItems: 10, maxKept: 2,
    exclude: ["explained", "what is", "how to", "best practices", "guide", "techniques, threats", "webinar"],
    excludeUrl: ["mlq.ai"],
    note: "V1's unsorted, unbounded query served 250-day-old SEO explainers; when:7d added, evergreen titles excluded, capped at 2 per build. Outlets are vetted (registry/outlets.ts): on 2026-11-20 its two rows were IT Brief Australia (a funding press release) and BigGo Finance; BigGo and Wisevoter are on the outlet deny list, and an outlet the registry does not know now ranks behind every known one for the two slots. excludeUrl keeps MLQ.ai out (rewrites of other outlets' reporting; its pages refuse automated readers, so it could not be checked for the deny list).",
  },
  {
    id: "gn-ai-sec-finra", name: "GN: AI x SEC/FINRA", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(intitle:AI+OR+intitle:%22artificial+intelligence%22)+(intitle:FINRA+OR+intitle:SEC+OR+intitle:%22broker-dealer%22+OR+intitle:%22investment+adviser%22)+when:14d+-LSU+-football&hl=en-US&gl=US&ceid=US:en",
    kind: "query", scope: "general", home: "policy", tier: 3, tags: ["finreg", "regulatory", "owner-pick"],
    maxItems: 20, maxKept: 5,
    include: ["FINRA", "SEC", "Securities and Exchange Commission", "broker-dealer*", "investment adviser*", "Regulation S-P", "Reg S-P"],
    exclude: ["Form 6-K", "Form 8-K", "Form 10-K", "SEC Form", "SEC Filing*", "SEC Power Rankings", "quarterly report", "private placement", "Sec.", "DHS Sec", "former SEC chair", "ex-SEC chair", "former SEC chairman", "Gensler"],
    excludeUrl: ["tradingview.com", "mlq.ai", "facebook.com", "marketbeat.com", "tradersunion.com", "cryptopotato.com"],
    note: "Compliance signal: law-firm memos and trade press on SEC / FINRA treatment of AI (exam priorities, AI-washing, adviser use of AI). Both halves are required in the TITLE: the query is intitle:-restricted on an AI term AND a regulator term (the old full-text query returned '$0 revenue at Loan Artificial Intelligence' and a Singapore engineering centre), and the include list (which REPLACES the gate) re-checks the regulator word, because Google's intitle: is not strict and Google News items carry no summary. A FORMER chair's market commentary is not regulator news (live 2026-11-20: four rewrites of one Gensler 'AI bubble' quote), so those titles are excluded. 'SEC' matches case-insensitively, so the exclude list drops 'DHS Sec.' / 'Sec. Duffy' titles, EDGAR filing rewrites and the Southeastern Conference; bare negatives only in the query (quoted negatives and -site: make Google ignore when:). excludeUrl drops off-mission publishers (it reads the article host, or the outlet host of a wrapper that is not resolved yet); the filing mills Stock Titan and Quantisnow are on the outlet deny list (registry/outlets.ts). Outlets are vetted: a law firm or trade paper the registry knows (publishers.ts) keeps tier 3, anything else is listed at tier 4 behind them - add the publisher to vouch for a new one. Do not add bare 'x.com' (substring-matches bloombergtax.com) or the term \"Sec's\" (drops 'The SEC's 2027 Examination Priorities'). On the 2026-11-19 snapshot: 44 items, 18 kept before the cap. Regulator action against a named AI company without 'AI' in the headline ('SEC Investigates Nvidia') is the job of gn-sec-ai-wires.",
  },
  {
    id: "gn-sec-ai-wires", name: "GN: SEC/FINRA x AI companies (wires)", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(intitle:SEC+OR+intitle:FINRA+OR+intitle:CFTC)+(intitle:Nvidia+OR+intitle:OpenAI+OR+intitle:Anthropic+OR+intitle:AI)+(site:reuters.com+OR+site:wsj.com+OR+site:bloomberg.com+OR+site:cnbc.com+OR+site:ft.com)+when:14d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "query", scope: "general", home: "policy", tier: 3, tags: ["wire", "press", "finreg", "regulatory", "owner-pick"],
    maxItems: 12, maxKept: 4, maxAgeDays: 14,
    exclude: ["SEC Filing*", "SEC Form", "Sec.", "Watch"],
    note: "Wire reporting on securities-regulator action against AI companies and on SEC / FINRA / CFTC statements about AI (this week: 'Nvidia facing SEC probe after Huang's resignation, WSJ reports' - five copies of that story were dropped by the old gn-ai-sec-finra include list and it was absent from the site). Regulator in the title comes from the query; no include list, so the global gate supplies 'AI term in the title' (it accepts Nvidia / OpenAI / Anthropic). Restricted to five wires and capped at 4 because an unrestricted query returned 94 rewrites of one story in 7 days and the cap runs before clustering. Google ignores when:14d for this many site: terms (results back to 2003), so maxAgeDays is mandatory; ingest takes the newest 12 by date. 'Sec.' drops cabinet secretaries ('Treasury Sec. Bessent'); 'Watch' drops Bloomberg video pages. Validated by curl 2026-11-20: HTTP 200, 56 items, 13 inside 14 days of which 9 pass the rules, all wire copy.",
    addedAt: "2026-11-20",
  },
  {
    id: "gn-ai-agent-bank-liability", name: "GN: AI agents x bank liability", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(intitle:%22AI+agent%22+OR+intitle:%22AI+agents%22)+(bank+OR+banks+OR+broker)+(liability+OR+liable+OR+losses+OR+fraud)+when:7d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "query", scope: "general", home: "ai_security", tier: 3, tags: ["finreg", "security", "owner-pick"],
    maxItems: 20, maxKept: 3,
    include: ["bank", "banks", "banking", "broker*", "liab*"],
    excludeUrl: ["cryptobriefing.com", "fourweekmba.com", "tokenpost.com", "cryptopolitan.com"],
    note: "Who pays when a customer's AI agent is hacked or misbehaves inside a bank or brokerage account - squarely on the finance-security beat, and missed on 2026-11-18 (TechCrunch 'More banks say customers using AI agents are on their own - even if they get hacked' had left the 20-item techcrunch-ai window before the first build; Citi, PNC and Citizens rewrote their terms). 'AI agent' is required in the title by the query; the include list (which REPLACES the gate) requires a bank / broker / liability word in the title, which removes fraud-vendor product PR (Plaid, Feedzai, Incode). excludeUrl drops crypto trade press (article host, or the outlet host of an unresolved wrapper). Outlets are vetted (registry/outlets.ts): on 2026-11-20 two of its three rows were Law Commentary (AI SECURITY homepage #8) and London Daily News, both now on the outlet deny list with BigGo Finance, Startup Fortune, Hokanews and Shattered; the slots go to TechCrunch, Business Insider and PYMNTS first. Validated by curl 2026-11-20: HTTP 200, 28 items, none older than 7 days, 15 pass the rules before the cap.",
    addedAt: "2026-11-20",
  },
  {
    id: "hn-local-llm", name: "HN: local LLM", publisher: "hacker-news",
    url: hnStories("local LLM", 20),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["community-signal", "local-llm"],
    maxKept: 4,
    note: "HN stories with both 'local' and 'LLM' / 'LLMs' in the title and 20+ points (hardware threads, benchmarks, small runtimes). outlets open: the points threshold vouches for the link.",
  },
  {
    id: "gn-pillar-security", name: "Pillar Security", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:pillar.security/blog+when:30d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://www.pillar.security/blog",
    kind: "query", scope: "ai", home: "ai_security", tier: 4, tags: ["vendor", "research", "security", "mcp"],
    maxKept: 3, maxAgeDays: 21,
    exclude: ["named a", "named an", "joining", "to acquire", "compared", "webinar", "market report"],
    note: "Original findings in the local-AI tool stack (RCE in MCP Inspector, code execution in Unsloth's model loader, Grafana MCP session spoofing) with no native feed; SEO and company posts are mixed in and Vanta is acquiring the firm (announced 2026-11-09), so re-check in 90 days. Merge step: when:30d added (an unbounded site: query is relevance-ordered and returns 2025 items).",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-local-llm-stack-cves", name: "GN: Local-LLM Stack CVEs", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(Ollama+OR+vLLM+OR+%22llama.cpp%22+OR+%22Open+WebUI%22+OR+LiteLLM+OR+LangChain+OR+%22MCP+server%22)+(CVE+OR+vulnerability+OR+RCE+OR+exploit)+when:7d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "query", scope: "ai", home: "ai_security", tier: 3, tags: ["security", "local-llm"],
    maxKept: 3,
    include: ["Ollama", "llama.cpp", "vLLM", "Open WebUI", "OpenWebUI", "LiteLLM", "LangChain", "LangGraph", "LLMjacking"],
    note: "Press coverage of vulnerabilities in local-inference and agent software (this week: LiteLLM sandbox escape added to CISA KEV), which the existing prompt-injection query misses; chosen over the unbounded variant because when:7d keeps it to 22 items, and the include list removes the MCP-server vendor PR. Tier 3, not 4: tier 4 rendered 'LiteLLM Guardrail Sandbox Escape in CISA KEV: Patch Now' greyed out at AI SECURITY #11; the cap of 3 bounds the SEO outlets.",
    addedAt: "2026-11-19",
  },
  {
    id: "federal-register-ai", name: "Federal Register", publisher: "federal-register",
    url: "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=%22artificial+intelligence%22+%7C+%22super+intelligence%22",
    homepage: "https://www.federalregister.gov/",
    kind: "query", scope: "general", home: "policy", tier: 4, tags: ["gov", "regulator", "finreg", "first-party"],
    attribution: "source", maxKept: 4,
    include: [...GOV_AI_TERMS, "semiconductor*", "advanced computing", "data center*", "export control*"],
    exclude: ["Agency Information Collection", "Notice of Public Meeting", "Medicare", "Sunshine Act"],
    note: "Only primary source for US rules, proposed rules, RFIs and SEC/SRO filings whose text mentions AI (this week: BIS remote-access chip rule, generative-AI-in-adjudication RFC); it is a full-text match so about half are passing mentions and the gate must read title plus abstract and recognise the federal 'Super Intelligence (SI)' wording; links are federalregister.gov so no link-host attribution is needed. The include list REPLACES the global gate (it does not widen it): US federal sources now write 'Super Intelligence' where they used to write 'AI', and the chip / compute terms are listed explicitly because the BIS rule this note cites ('Addressing Remote Access to Advanced Semiconductors': 'advanced computing power', 'data centers', no AI word) was dropped by the AI-only list although the global gate would have passed it.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-anthropic-alignment-science", name: "Anthropic Alignment Science", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:alignment.anthropic.com+when:60d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://alignment.anthropic.com/",
    kind: "query", scope: "ai", home: "safety", tier: 3, tags: ["lab", "first-party", "research"],
    maxKept: 4, maxAgeDays: 30,
    exclude: ["Dataset Description"],
    note: "Site-scoped proxy for Anthropic's Alignment Science blog, which has no native feed and is not on the scraped anthropic.com listings (red-teaming coding-agent classifiers, poisoned fine-tuning data, multi-agent failures); tier 3 rather than 4 because every item is one first-party lab blog, about 1.5 posts a week, and titles carry an ' - Anthropic Alignment Science blog' suffix to strip.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-inside-ai-policy", name: "Inside AI Policy", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:insideaipolicy.com+when:14d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://insideaipolicy.com/",
    kind: "query", scope: "ai", home: "policy", tier: 3, tags: ["press", "paywalled"],
    maxKept: 5,
    exclude: ["AI Wire -", "FCC"],
    note: "Headlines from the specialist trade publication on NIST, Congress, SEC and agency AI policy (its own rss.xml is empty); 35 of 36 items fall inside 14 days and surface appropriations riders, NIST drafts and SEC stakeholder input before general press, though articles are paywalled. Merge step: kept ungated (single-publication proxy); the excludes carry the occasional off-topic item. Tier 3 (trade press): every item is one specialist publication, and tier 4 greyed out its POLICY rows.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-think-tanks-ai", name: "Think Tanks on AI", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(site:csis.org+OR+site:cnas.org+OR+site:carnegieendowment.org+OR+site:rand.org+OR+site:cfr.org+OR+site:hai.stanford.edu+OR+site:institute.global)+(intitle:AI+OR+intitle:%22artificial+intelligence%22+OR+intitle:AGI)+when:14d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://www.csis.org/programs/wadhwani-ai-center",
    kind: "query", scope: "ai", home: "policy", tier: 4, tags: ["analysis", "research"],
    leadEligible: false, maxKept: 4, maxAgeDays: 14,
    exclude: ["AI Index", "What is", "Definitions"],
    note: "One query standing in for seven institutions with no usable feed (CSIS, CNAS, Carnegie, RAND, CFR, Stanford HAI, TBI); Google ignores when:14d for most results (only 16 of 83 items are inside 14 days, about 8 a week, not the 35 the scout reported) so maxAgeDays is mandatory, with occasional off-site leakage.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-caixin-ai", name: "Caixin Global", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:caixinglobal.com+AI+when:7d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://www.caixinglobal.com/business-and-tech/",
    kind: "query", scope: "general", home: "money", tier: 4, tags: ["press", "china", "asia", "paywalled"],
    maxKept: 3,
    exclude: ["CX Daily"],
    note: "Caixin has no RSS and breaks Chinese AI finance stories first (DeepSeek funding and compute crunch, Megaspeed, Tencent AI spend); Google ignores the keyword and returns the whole site unsorted, 22 of 69 titles AI, so it depends on the gate and age window.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-nikkei-asia-ai", name: "Nikkei Asia (AI)", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:asia.nikkei.com+intitle:AI+when:14d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://asia.nikkei.com/Business/Technology",
    kind: "query", scope: "ai", home: "industry", tier: 4, tags: ["press", "asia", "paywalled"],
    maxItems: 4,
    note: "Proxy for Nikkei Asia, whose native RSS has no item dates; Japan/ASEAN/Korea AI coverage (Alibaba training on own chips, Google frontier-AI access for Japan cyber defence, AI supply-chain labour unrest); titles carry a ' - Nikkei Asia' suffix to strip.",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-claude-code", name: "HN: Claude Code", publisher: "hacker-news",
    url: hnStories("Claude Code", 100),
    ...HN, scope: "ai", home: "tools", tier: 4, tags: ["security"],
    maxItems: 3,
    note: "Surfaces coding-agent incidents vendor feeds never publish (backdoored Claude Code extensions on the Cursor marketplace, 'Don't Ask Again' credential exposure, Goldman pulling Claude Code); outlets open (100+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-coding-agent", name: "HN: Coding Agents", publisher: "hacker-news",
    url: hnStories("coding agent", 50),
    ...HN, scope: "ai", home: "tools", tier: 4, tags: ["security"],
    maxKept: 3,
    exclude: ["Show HN"],
    note: "Practitioner stories below the registry's 100/150-point HN thresholds (running coding agents without handing over credentials, Windows 11 collecting coding-agent telemetry, code-review bottleneck study); about 2/week once Show HN items are excluded. outlets open (50+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-qwen-blog", name: "Qwen Blog", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:qwen.ai/blog+when:120d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://qwen.ai/blog",
    kind: "query", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party", "china", "local-llm"],
    maxKept: 3, maxAgeDays: 14,
    exclude: ["Try Qwen", "Qwen - Qwen"],
    note: "Only plain-fetch route to first-party Qwen release posts (Qwen4-Max 11-16, Qwen3.8-Flash-Next) for a primary open-weight model family; qwen.ai is a JS shell and V1 relied on a 150-point HN query. Tier 3 (the ceiling for kind=query) because every real item is a first-party release; exclude drops Google's index-page rows.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-deepseek-news", name: "DeepSeek News", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:api-docs.deepseek.com/news+when:120d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://api-docs.deepseek.com/news/news250120",
    kind: "query", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party", "china", "local-llm"],
    maxItems: 3, maxAgeDays: 14,
    note: "DeepSeek's only first-party release channel (V4-Pro GA, V4.1-Flash, app API), 5 clean items in 120 days; drop this entry if the direct DeepSeek scrape from the scrape slice is adopted, since that removes the dependency on Google's index.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-microsoft-ai-news", name: "Microsoft AI (MAI)", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:microsoft.ai/news+when:60d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://microsoft.ai/news/",
    kind: "query", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party"],
    maxItems: 4,
    note: "Microsoft's in-house frontier lab posts (MAI Licensed Weights, MAI Cyber 2 Flash, MAI Code 2), which appear in none of the Microsoft Research or Security feeds and whose native feed is an empty channel; bursty around Ignite.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-xai-news", name: "xAI News", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:x.ai/news+when:60d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://x.ai/news",
    kind: "query", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party"],
    maxKept: 3,
    exclude: ["News: Research, Product"],
    note: "First-party xAI posts (Grok Bot 1.0, Grok Voice 3.0) for a frontier lab on the V1 no-feed list (x.ai returns 403 to direct fetch); recent items lean towards product marketing, hence tier 3 and a cap of 3.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-emerging-labs", name: "Emerging Labs (Google News)", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=site:reflection.ai/blog+OR+site:liquid.ai/blog+OR+site:bfl.ai/blog+OR+site:worldlabs.ai/blog+OR+site:reka.ai/news+OR+site:ai21.com/blog+when:60d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://reflection.ai/blog",
    kind: "query", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party"],
    maxItems: 5,
    note: "One slot for six feedless labs' own posts: Reflection (Beam open weights, open-model safety), Liquid AI (LFM3 on-device models), Black Forest Labs (FLUX open weights), World Labs, Reka, AI21; do not add more site: terms, as Google ignored the when: window with eight.",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-llama-cpp", name: "HN: llama.cpp", publisher: "hacker-news",
    url: hnStories("llama.cpp", 20),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["local-llm"],
    maxItems: 3,
    note: "Catches HN threads that name only the project and so miss the existing 'local LLM' and 'LLM' queries ('Llama.cpp hits v1.0 with a native app for macOS', Gerganov on the ggml future). outlets open (20+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-qwen", name: "HN: Qwen", publisher: "hacker-news",
    url: hnStories("Qwen", 25, { prefixLast: true }),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["china", "local-llm"],
    maxItems: 3,
    note: "Practitioner Qwen posts below the 150-point floor of the existing Chinese-labs HN query ('Run Qwen 3.8 Flash Next (125B) on consumer hardware at 100T/s', single-neuron alter egos, 16 GB fine-tunes); about 1.75 a week. Prefix match, so versioned names count ('Qwen4-Max', 'Running Qwen3.8-Flash-Next NVFP4 at 184 tok/s on a single RTX 6000 Pro'), which the exact hnrss query never returned. outlets open (25+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-open-weights", name: "HN: open weights", publisher: "hacker-news",
    url: hnStories("open weights", 20),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["local-llm"],
    maxItems: 3,
    note: "Two-word title query ('open' and 'weight' / 'weights', hyphenated or not) that fires almost only on HN-validated open-weight drops and debate (Ripple-65B Preview, Muse Spark Open, Beam 501B, 'IBM CEO says open weight models are now good and cheap on-prem'). outlets open (20+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-vllm", name: "HN: vLLM", publisher: "hacker-news",
    url: hnStories("vLLM", 20),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["local-llm"],
    maxItems: 3,
    note: "About 3 on-topic hits a month for the vLLM serving runtime ('Serving GLM-5.3 at 607.8 tok/s across two Nvidia DGX stations with vLLM', 'Fixing Tool-Call Accuracy in vLLM'). outlets open (20+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-mac-studio", name: "HN: Mac Studio", publisher: "hacker-news",
    url: hnStories("Mac Studio", 30),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["local-llm"],
    leadEligible: false, countsForCoverage: false, maxItems: 3, maxAgeDays: 30,
    note: "Local-hardware query: Mac Studio threads that cleared 30 points (512GB configs, M5 Ultra reviews, real-numbers posts on running Qwen locally, Thunderbolt networking); about one item a fortnight, so ungated with a 30-day window. outlets open (30+ points).",
    addedAt: "2026-11-19",
  },
  {
    id: "hn-local-stack", name: "HN: local model stack", publisher: "hacker-news",
    url: hnStories("Ollama GGUF MLX Gemma quantiz", 50, { anyWord: true, prefixLast: true }),
    ...HN, scope: "ai", home: "open_local", tier: 4, tags: ["community-signal", "local-llm"],
    maxItems: 4, maxKept: 3,
    note: "The local-inference threads the other HN searches cannot see because the title names a format or a runtime, not 'local LLM': any of Ollama, GGUF, MLX, Gemma or quantiz* (prefix: quantization, quantizer, quantized) with 50+ points, about 2-3 a month ('Huawei releases MACaQ, its internal quantizer for local inference', 'Apple ML Research: Muse Spark Open with MLX on Mac Studio', 'Gemma-4-26B-A4B with 39-69% less thinking at same accuracy'). Validated by curl 2026-11-20: HTTP 200 in 0.4 s, 20 hits, newest 2026-11-14, all 20 titles on local inference; run through the build's JSON extractor. Same-URL copies of the Qwen and llama.cpp searches fold into one item. outlets open (50+ points).",
    addedAt: "2026-11-20",
  },
  {
    id: "gn-robotics-wires", name: "GN: Robotics wires", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(intitle:humanoid+OR+intitle:robotaxi+OR+intitle:%22self-driving%22+OR+intitle:robotics)+(site:reuters.com+OR+site:bloomberg.com+OR+site:wsj.com+OR+site:nytimes.com)+when:14d&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "query", scope: "ai", home: "robotics", tier: 4, tags: ["wire", "press"],
    maxKept: 6, maxAgeDays: 14,
    exclude: ["ETF", "stock quote", "stock price", "price target", "shares jump", "shares fall", "shares slide", "shares surge", "shares soar", "BI Replay", "Watch"],
    excludeUrl: ["/video/", "/videos/", "/professional/", "/market-data/"],
    note: "Title-restricted query that pulls Reuters, Bloomberg, WSJ and NYT robotics and robotaxi scoops (funding exclusives, Waymo freeway pause) no robotics feed in the registry carries; occasional quote pages, hence the exclude. Merge step: the quoted negative (-\"stock price\") was removed from the query (quoted negatives can make Google ignore when:); the exclude list carries it, and maxAgeDays drops the few decade-old results Google still returns. Fix round 2026-11-20: a Reuters video page and a Bloomberg webinar replay held ROBOTICS rows while the cap of 4 dropped the Waymo freeway pause and two funding exclusives, so the cap is 6 and video / webinar / quote pages are excluded by URL (resolved links only) and by title. 'Watch' is a whole-word match that also drops '... to watch' headlines; accepted here because Bloomberg video titles start with 'Watch' and arrive as unresolved wrappers excludeUrl cannot see. Do not add negative inurl: operators to the query (they make Google ignore when:14d).",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-substack-analysis", name: "Substack mirror: analysis", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(site:thesequence.substack.com+OR+site:chinai.substack.com+OR+site:garymarcus.substack.com+OR+site:morethanmoore.substack.com)+when:21d&hl=en-US&gl=US&ceid=US:en",
    kind: "query", scope: "ai", home: "analysis", tier: 4, tags: ["fallback", "substack"],
    maxItems: 12, maxKept: 6, maxAgeDays: 14,
    exclude: ["Comments -", "Marcus on AI"],
    excludeUrl: ["/comment/", "substack.com/subscribe", "substack.com/perks", "substack.com/about", "substack.com/archive"],
    note: "Fallback for TheSequence, ChinAI, Gary Marcus and More Than Moore, whose *.substack.com feeds answer 403 to GitHub Actions runners. Items attribute to the newsletter by link host; when the direct feed works too, same-URL twins fold. Drop this query once the direct feeds are confirmed reachable from CI. Google also indexes reader comments, subscribe-coupon and perks pages, often with an empty headline ('- Marcus on AI', which normalize rejects as a title that is only a separator and a site name): excludeUrl drops them once the wrapper is resolved (patterns are host-anchored so a post slug such as /p/subscribe-to-x cannot match) and the 'Marcus on AI' title term is the backstop for the newsletter's own index page.",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-substack-money", name: "Substack mirror: markets", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(site:cloudedjudgement.substack.com+OR+site:econlab.substack.com+OR+site:taekim.substack.com)+when:21d&hl=en-US&gl=US&ceid=US:en",
    kind: "query", scope: "ai", home: "money", tier: 4, tags: ["fallback", "substack"],
    maxItems: 12, maxKept: 6, maxAgeDays: 14,
    exclude: ["Comments -"],
    excludeUrl: ["/comment/", "substack.com/subscribe", "substack.com/perks", "substack.com/about", "substack.com/archive"],
    note: "Fallback for Clouded Judgement, Ramp Economics Lab and Key Context (Tae Kim): *.substack.com hosts with no custom domain, blocked from CI runners. excludeUrl drops comment, subscribe-coupon and perks pages (resolved links only: the pattern is a path).",
    addedAt: "2026-11-19",
  },
  {
    id: "gn-substack-local-policy", name: "Substack mirror: local, policy, security", publisher: "google-news",
    url: "https://news.google.com/rss/search?q=(site:kaitchup.substack.com+OR+site:aisafetychina.substack.com+OR+site:softwareanalyst.substack.com)+when:21d&hl=en-US&gl=US&ceid=US:en",
    kind: "query", scope: "ai", home: "analysis", tier: 4, tags: ["fallback", "substack"],
    maxItems: 12, maxKept: 6, maxAgeDays: 21,
    exclude: ["Comments -", "Black Friday", "Pro Perks", "Subscriber perks"],
    excludeUrl: ["/comment/", "substack.com/subscribe", "substack.com/perks", "substack.com/about", "substack.com/archive"],
    note: "Fallback for The Kaitchup, AI Safety in China and Software Analyst (SACR): *.substack.com hosts with no custom domain, blocked from CI runners. Homed in ANALYSIS; keyword routing sends items to LOCAL, POLICY or AI SECURITY. A subscribe-coupon page ('- The Kaitchup') and the perks page were ANALYSIS rows on 2026-11-20: excludeUrl drops them once resolved, the title terms when not. The headline-less '- The Kaitchup' entry needs no term here: normalize rejects a title that is only a separator and a site name ('empty title after cleaning'), and a '- The Kaitchup' term would also drop any real post whose title kept the newsletter as a suffix.",
    addedAt: "2026-11-19",
  },
];
