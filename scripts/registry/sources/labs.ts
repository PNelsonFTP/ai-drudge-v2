// MODELS & LABS: first-party lab feeds and model-release trackers (home "models").
//
// Field meanings: scripts/registry/types.ts. `maxKept` is the per-build cap after relevance;
// `maxItems` is the ingest window (newest-N before the gate).

import type { SourceDef } from "../types";

export const LABS: readonly SourceDef[] = [
  {
    id: "openai-news", name: "OpenAI News", publisher: "openai",
    url: "https://openai.com/news/rss.xml",
    homepage: "https://openai.com",
    kind: "rss", scope: "ai", home: "models", tier: 1, tags: ["lab", "first-party"],
    maxItems: 40, maxKept: 15,
    excludeUrl: ["/business/", "/academy/", "/ads/", "/form/"],
    note: "The feed posts 5-7 items a day, 4-5 of them demo, customer-story, academy and marketing pages. With the default 15-item window (about 2.5 days) and cap of 8, 'Introducing GPT-6.2 Astra and Sol' was dropped two days after launch while four /business/learn/ demo pages held MODELS homepage rows, and a GitHub changelog led the GPT-6.2 story. excludeUrl runs AFTER the ingest window, so the window must be wide as well: 40 items is about 9 days (longer than the MODELS 6-day window) at no extra fetch cost, since the feed returns its whole archive in one response. The publisher diversity cap still limits OpenAI to 3 of the 10 MODELS homepage rows.",
  },
  {
    id: "google-deepmind-blog", name: "Google DeepMind Blog", publisher: "google",
    url: "https://deepmind.google/blog/rss.xml",
    homepage: "https://deepmind.google",
    kind: "rss", scope: "ai", home: "models", tier: 1, tags: ["lab", "first-party"],
  },
  {
    id: "mistral-ai", name: "Mistral AI", publisher: "mistral",
    url: "https://mistral.ai/news/rss",
    homepage: "https://mistral.ai",
    kind: "rss", scope: "ai", home: "models", tier: 1, tags: ["lab", "first-party", "europe"],
  },
  {
    id: "stability-ai-news", name: "Stability AI News", publisher: "stability-ai",
    url: "https://stability.ai/news-updates?format=rss",
    homepage: "https://stability.ai/news-updates",
    kind: "rss", scope: "ai", home: "models", tier: 4, tags: ["lab", "first-party", "low-cadence"],
    note: "Posts every 6-12 weeks (open-weight launches land here); a long silence is normal, not a broken feed (triage 2026-11-19: keep).",
  },
  {
    id: "every-vibe-check", name: "Every: Vibe Check", publisher: "every",
    url: "https://every.to/vibe-check/feed",
    homepage: "https://every.to/vibe-check",
    kind: "rss", scope: "ai", home: "models", tier: 3, tags: ["analysis"],
    maxAgeDays: 10,
    note: "Hands-on review of each frontier model within days of release (GPT-6.2 Astra, Gemini 4 Carbon, Fable 5.2); corrects the V1 no-feed note for Every.to since per-column feeds work.",
    addedAt: "2026-11-19",
  },
  {
    id: "moonshot-kimi-announcements", name: "Kimi Announcements", publisher: "moonshot-ai",
    url: "https://forum.moonshot.ai/c/announcement/5.rss",
    homepage: "https://forum.moonshot.ai/c/announcement/5",
    kind: "rss", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party", "china"],
    maxItems: 3, maxAgeDays: 14,
    exclude: ["关于*", "About the Announcement category"],
    note: "The only native RSS from a Chinese frontier lab: staff-authored Kimi launches and API changes (K3.1 Pro, K3, context-caching TTLs); about 0.5 a week, all signal.",
    addedAt: "2026-11-19",
  },
  {
    id: "testingcatalog", name: "TestingCatalog", publisher: "testingcatalog",
    url: "https://www.testingcatalog.com/rss/",
    homepage: "https://www.testingcatalog.com",
    kind: "rss", scope: "ai", home: "models", tier: 3, tags: ["press"],
    maxItems: 3,
    exclude: ["ICYMI"],
    note: "Pre-release signal the registry lacks: unreleased models and features spotted in app builds and pull requests ('Meta Muse Spark 1.4 surfaces in RocksDB pull request') plus same-day launch posts with plain news titles; about 18 a week, so capped at 4, and leak items are unconfirmed by nature.",
    addedAt: "2026-11-19",
  },
  {
    id: "cohere-changelog", name: "Cohere Changelog", publisher: "cohere",
    url: "https://docs.cohere.com/changelog.rss",
    homepage: "https://docs.cohere.com/changelog",
    kind: "rss", scope: "ai", home: "models", tier: 3, tags: ["lab", "first-party", "changelog"],
    maxItems: 3, maxAgeDays: 14,
    note: "Working first-party RSS for a lab on the V1 no-feed list, with real titles for model releases and retirements (Rerank 5, Embed 5, Command A+); fills the embeddings and reranker release gap at under one item a week.",
    addedAt: "2026-11-19",
  },
  {
    id: "openrouter-new-models", name: "OpenRouter New Models", publisher: "openrouter",
    url: "https://openrouter.ai/api/v1/models?use_rss=true",
    homepage: "https://openrouter.ai/models",
    kind: "rss", scope: "ai", home: "models", tier: 4, tags: ["changelog"],
    routing: "home-only", leadEligible: false, countsForCoverage: false, maxItems: 8, maxKept: 3,
    exclude: ["(batch)", "(free)", "2024 version", "2025 version"],
    note: "BACK CATALOGUE: the feed also re-lists old models ('Mistral: Pixtral Large 2502', whose summary says 'the February 2025 version', was MODELS #6 on 2026-11-20), so summaries that date a model to 2024 / 2025 are excluded - extend the two terms each January. Cross-vendor same-day API-availability ticker with readable titles ('Google: Gemini 4 Neon', 'Qwen: Qwen4 Max', 'Tencent: Hy4 flash'), a different beat from the OpenRouter blog already in V1. The payload is 245 KB / 478 items and lists each model up to three times under one link (standard, batch, free): the exclude drops the batch and free rows and ingest's exclude-aware dedupe keeps the standard row of a same-link group. maxItems 8 so free-only singles do not use up the window; maxKept 3 keeps the ticker to three rows.",
    addedAt: "2026-11-19",
  },
  {
    id: "yt-sam-witteveen", name: "Sam Witteveen (YouTube)", publisher: "sam-witteveen",
    url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULF55ODQSvARtgSyc8ThfiepQ",
    homepage: "https://www.youtube.com/@samwitteveenai",
    kind: "rss", scope: "ai", home: "models", tier: 4, tags: ["video", "local-llm"],
    leadEligible: false, countsForCoverage: false, maxItems: 2,
    note: "Hands-on walkthroughs of new, mostly open-weight models within a day or two of release, with plain titles ('NVIDIA's Nemotron Bolt 74B-A9B 2 Bit', 'Ripple 65B: A Chip Design Lab Just Beat Every US Open Model'); long-form-only playlist feed, the one high-cadence model channel checked without clickbait titles.",
    addedAt: "2026-11-19",
  },
];
