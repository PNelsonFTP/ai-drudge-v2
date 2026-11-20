// ROBOTICS and QUANTUM WATCH (homes "robotics" and "quantum"; quantum is an owner desk and its sources
// stay home-only).
//
// Field meanings: scripts/registry/types.ts. `maxKept` is the per-build cap after relevance;
// `maxItems` is the ingest window (newest-N before the gate).

import type { SourceDef } from "../types";

export const ROBOTICS_QUANTUM: readonly SourceDef[] = [
  {
    id: "humanoids-daily", name: "Humanoids Daily", publisher: "humanoids-daily",
    url: "https://www.humanoidsdaily.com/feed.xml",
    homepage: "https://www.humanoidsdaily.com",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["press"],
  },
  {
    id: "the-robot-report", name: "The Robot Report", publisher: "the-robot-report",
    url: "https://www.therobotreport.com/feed/",
    homepage: "https://www.therobotreport.com",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["press"],
  },
  {
    id: "ieee-spectrum-robotics", name: "IEEE Spectrum Robotics", publisher: "ieee-spectrum",
    url: "https://spectrum.ieee.org/feeds/topic/robotics.rss",
    homepage: "https://spectrum.ieee.org/topic/robotics/",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["press"],
  },
  {
    id: "new-atlas-robotics", name: "New Atlas Robotics", publisher: "new-atlas",
    url: "https://newatlas.com/robotics/index.rss",
    homepage: "https://newatlas.com/robotics/",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["press"],
  },
  {
    id: "waymo-blog", name: "Waymo Blog", publisher: "waymo",
    url: "https://waymo.com/blog/rss.xml",
    homepage: "https://waymo.com/blog/",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["first-party"],
  },
  {
    id: "techcrunch-robotics", name: "TechCrunch Robotics", publisher: "techcrunch",
    url: "https://techcrunch.com/category/robotics/feed/",
    homepage: "https://techcrunch.com/category/robotics/",
    kind: "rss", scope: "ai", home: "robotics", tier: 4, tags: ["press"],
    exclude: ["TechCrunch Disrupt", "Disrupt 2026", "Disrupt 2027", "StrictlyVC", "save up to"],
  },
  {
    id: "the-quantum-insider", name: "The Quantum Insider", publisher: "the-quantum-insider",
    url: "https://thequantuminsider.com/feed/",
    homepage: "https://thequantuminsider.com",
    kind: "rss", scope: "ai", home: "quantum", tier: 4, tags: ["press"],
    routing: "home-only", maxItems: 4,
  },
  {
    id: "quantum-computing-report", name: "Quantum Computing Report", publisher: "quantum-computing-report",
    url: "https://quantumcomputingreport.com/feed/",
    homepage: "https://quantumcomputingreport.com",
    kind: "rss", scope: "ai", home: "quantum", tier: 4, tags: ["press"],
    routing: "home-only", maxItems: 4,
  },
  {
    id: "mit-news-quantum", name: "MIT News Quantum", publisher: "mit-news",
    url: "https://news.mit.edu/rss/topic/quantum-computing",
    homepage: "https://news.mit.edu/topic/quantum-computing",
    kind: "rss", scope: "ai", home: "quantum", tier: 4, tags: ["research", "university"],
    routing: "home-only", maxItems: 4,
    exclude: ["dies at", "obituary", "in memoriam", "professor emeritus"],
    note: "MIT's quantum topic feed. Obituaries are tagged with the topic too ('Professor Emeritus Jeffrey Goldstone ... dies at 93' was a QUANTUM WATCH row on 2026-11-20): excluded by title.",
  },
  {
    id: "science-robotics", name: "Science Robotics", publisher: "science",
    url: "https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=scirobotics",
    homepage: "https://www.science.org/journal/scirobotics",
    kind: "papers", scope: "ai", home: "robotics", tier: 3, tags: ["research", "paywalled"],
    leadEligible: false,
  },
  {
    id: "postquantum-com", name: "PostQuantum", publisher: "postquantum",
    url: "https://postquantum.com/feed/",
    homepage: "https://postquantum.com/",
    kind: "rss", scope: "ai", home: "quantum", tier: 3, tags: ["security", "pqc", "analysis"],
    routing: "home-only", maxItems: 3, maxAgeDays: 30,
    exclude: ["I Rebuilt", "Budget Builder", "Readiness Assessment", "Migration Advisor"],
    note: "Only PQC-migration source in the registry: practitioner analysis of NIST IR 8547, regulator deadlines by jurisdiction and RSA-2048 resource estimates, written for security leaders; bursty (30 posts in 3 weeks, then a gap), hence the cap of 3 and 30-day age; scope ai means on-topic for the quantum lane, do not AI-gate.",
    addedAt: "2026-11-19",
  },
  {
    id: "cloudflare-post-quantum", name: "Cloudflare PQ", publisher: "cloudflare",
    url: "https://blog.cloudflare.com/tag/post-quantum/rss/",
    homepage: "https://blog.cloudflare.com/tag/post-quantum/",
    kind: "rss", scope: "ai", home: "quantum", tier: 2, tags: ["vendor", "first-party", "security", "pqc"],
    routing: "home-only", maxItems: 3, maxAgeDays: 45,
    exclude: ["Gartner", "Forrester", "Visionary", "named a Leader"],
    note: "Primary-source engineering on deployed post-quantum crypto (PQ certificates, IPsec downgrade prevention, PQ DNSSEC) from the largest PQ-traffic operator; a different beat from the V1 /tag/ai/ feed, about 2 posts a month so it needs the long age window; do not AI-gate.",
    addedAt: "2026-11-19",
  },
  {
    id: "driverless-digest", name: "Driverless Digest", publisher: "driverless-digest",
    url: "https://www.thedriverlessdigest.com/feed",
    homepage: "https://www.thedriverlessdigest.com/",
    kind: "newsletter", scope: "ai", home: "robotics", tier: 3, tags: ["newsletter", "analysis"],
    maxItems: 4,
    note: "AV-business newsletter with original reporting and operator interviews (fleet-data exclusives, city robotaxi bills, rideshare economics); the registry has no AV trade press beyond Waymo's own blog.",
    addedAt: "2026-11-19",
  },
  {
    id: "scmp-robotics", name: "SCMP Robotics", publisher: "scmp",
    url: "https://www.scmp.com/rss/324822/feed/",
    homepage: "https://www.scmp.com/topics/robotics",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["press", "china", "asia"],
    maxItems: 4,
    note: "Staff reporting on Unitree, Pudu, ByteDance and China's humanoid push, absent from the registry. The scout URL without the trailing slash returns a 301 to this one (my curl check), so the final URL is used; 200 with 50 items via plain fetch.",
    addedAt: "2026-11-19",
  },
  {
    id: "ars-quantum", name: "Ars Technica Quantum", publisher: "ars-technica",
    url: "https://arstechnica.com/tag/quantum-computing/feed/",
    homepage: "https://arstechnica.com/tag/quantum-computing/",
    kind: "rss", scope: "ai", home: "quantum", tier: 3, tags: ["press", "pqc"],
    routing: "home-only", maxItems: 3, maxAgeDays: 30,
    note: "John Timmer's technically careful quantum coverage (error-correction milestones, vendor roadmaps) plus crypto-transition news such as the shortened federal deadline for dropping quantum-vulnerable crypto; a different tag from the V1 Ars AI feed, about 2 items a month, do not AI-gate.",
    addedAt: "2026-11-19",
  },
  {
    id: "rodney-brooks", name: "Rodney Brooks", publisher: "rodney-brooks",
    url: "https://rodneybrooks.com/feed/",
    homepage: "https://rodneybrooks.com/",
    kind: "rss", scope: "ai", home: "robotics", tier: 3, tags: ["analysis"],
    maxAgeDays: 45,
    note: "iRobot and Rethink founder's long-form essays and annual predictions scorecard on robotics, self-driving and AI hype; 4-5 posts a year, each a must-read counterweight to humanoid marketing, so it needs the long age window.",
    addedAt: "2026-11-19",
  },
];
