// V1 sources that were NOT carried into V2, with the reason. registry.test.ts requires every V1 name to
// resolve to a source id OR to appear here; docs cite this list. Evidence: sources-taxonomy review
// section D and the feed triage of 2026-11-19.
//
// Where the review's action list and the later per-feed triage disagreed, triage won because it found
// the cause, so these are NOT removed:
//   AI News (smol.ai)        moved to Latent Space          -> ai-news-latent-space (new url, alias)
//   JFrog Security Research  moved to research.jfrog.com    -> jfrog-security-research (new url)
//   Stability AI News        healthy, posts every 6-12 weeks -> stability-ai-news (kept as is)
//   NIST AI News             topic renamed on nist.gov      -> nist-ai-news (new url)
//   AI Now Institute         site answers 403               -> gn-ai-now-institute (Google News proxy)
//   EleutherAI, Noma Security, Thinking Machines Lab: feed gone -> listing page scraped (Noma is paused
//                            until the scraper can read its card titles)
//   VentureBeat AI           feed answers HTML / 429        -> venturebeat-ai (paused, not removed)
// LocalLLaMA and r/LocalLLM are removed rather than disabled: Reddit ended RSS for good.
//
// Replacements that triage SUGGESTED and that were deliberately not added:
//   anomalyco/opencode, aaif-goose/goose (for continuedev/continue): RELEASE RADAR already has ~40 feeds;
//   Irrational Analysis (for Fabricated Knowledge): *.substack.com host, blocked from CI runners;
//   Arctic Shift JSON mirror of the two subreddits: routes around Reddit's shutdown - the owner's call.

export interface RemovedSource {
  /** V1 display name. */
  name: string;
  /** V1 feed URL. */
  url: string;
  reason: "duplicate" | "off-mission" | "low-quality" | "dead";
  detail: string;
  /** Source id that now covers the beat, when there is one. Informational: a V1 mute of the removed name does NOT migrate to it. */
  coveredBy?: string;
}

export const REMOVED: readonly RemovedSource[] = [
  { name: "OpenAI Blog", url: "https://openai.com/blog/rss.xml", reason: "duplicate", detail: "307 redirect to the OpenAI News feed (byte-identical body, 1,412 of 1,414 item URLs shared). The twin made 34% of V1's trending rows fake.", coveredBy: "openai-news" },
  { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss", reason: "off-mission", detail: "21% AI over 30 days yet the most-placed source on the site (611 articles) and the site lead in 43 builds; Bloomberg Tech, FT AI and the finance-regulation query cover the lane.", coveredBy: "bloomberg-tech" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", reason: "off-mission", detail: "28% AI over 30 days; 246 off-lane articles placed." },
  { name: "PremAI Blog", url: "https://www.premai.io/blog/rss/", reason: "low-quality", detail: "8 of 9 recent posts are 'N Best ...' listicles." },
  { name: "GovAI", url: "https://www.governance.ai/post/rss.xml", reason: "off-mission", detail: "The post feed is 15 of 15 job and fellowship postings." },
  { name: "Air Street Press (Benaich)", url: "https://press.airstreet.com/feed", reason: "low-quality", detail: "Meetup invitations and portfolio PR." },
  { name: "Promptfoo Blog", url: "https://www.promptfoo.dev/blog/rss.xml", reason: "dead", detail: "Blog frozen since OpenAI announced it would acquire Promptfoo (newest post 2026-03-12). The open-source project lives on as the release feed gh-promptfoo-promptfoo.", coveredBy: "gh-promptfoo-promptfoo" },
  { name: "continuedev/continue", url: "https://github.com/continuedev/continue/releases.atom", reason: "dead", detail: "Project acquired by Cursor; repository read-only after the final 2.0.0 release (2026-06-19)." },
  { name: "Fabricated Knowledge", url: "https://www.fabricatedknowledge.com/feed", reason: "dead", detail: "No post for 98 days, 80% paywalled and drifted off the hardware beat; the author's on-beat work ships at SemiAnalysis.", coveredBy: "semianalysis" },
  { name: "LocalLLaMA Subreddit", url: "https://www.reddit.com/r/LocalLLaMA.rss", reason: "dead", detail: "Reddit ended RSS for all communities on 2026-11-13 (404 site-wide) and is closing its public API; no official path remains. Lemmy c/localllama, llama.cpp Announcements, the DGX Spark forum and the hnrss local-LLM queries replace it.", coveredBy: "lemmy-localllama" },
  { name: "r/LocalLLM", url: "https://www.reddit.com/r/LocalLLM.rss", reason: "dead", detail: "Same Reddit RSS shutdown as r/LocalLLaMA.", coveredBy: "lemmy-localllama" },
];
