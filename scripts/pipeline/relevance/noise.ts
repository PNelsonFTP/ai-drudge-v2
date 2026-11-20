// Noise filter: items that are not stories at all - webinars, event listings, job posts, sponsored
// posts, archive / index pages and shopping promos. Applied to EVERY source (first-party blogs
// publish "we're hiring" and webinar invitations too). Title-driven: a news story that mentions an
// event in its summary is still a news story.

export type NoiseKind = "webinar" | "event" | "job" | "sponsored" | "index" | "promo";

interface NoiseRule {
  kind: NoiseKind;
  re: RegExp;
}

const TITLE_RULES: readonly NoiseRule[] = [
  { kind: "webinar", re: /\bwebinars?\b|\bvirtual (?:event|summit|workshop)\b|\blive (?:demo|workshop|training) (?:on|:)|\bon-demand (?:session|recording|webcast)\b|\bwebcast\b/i },
  { kind: "event", re: /^\s*[[(]?\s*(?:upcoming\s+)?(?:event|meetup|workshop|conference|save the date|register now|rsvp)\s*[\])]?\s*[:\-–—]/i },
  { kind: "event", re: /\bregister (?:now|today|here)\b|\bregistration (?:is )?(?:now )?open\b|\bsave the date\b|\bjoin us (?:at|for|in|on|live)\b|\bmeet us at\b|\bsee you at\b|\bcall for (?:papers|proposals|speakers|submissions|abstracts)\b|\bearly[- ]bird\b|\btickets? (?:are )?(?:now )?(?:on sale|available)\b/i },
  // "CEOs of Perplexity, Applied Intuition ... Join Cerebral Valley Speaker Lineup Ahead of Our Summit Next Week": the organiser's own promotion.
  { kind: "event", re: /\bspeaker line-?up\b|\bjoin (?:the |our )?(?:main[- ]stage )?line-?up\b/i },
  { kind: "job", re: /\bwe(?:['’]re| are) hiring\b|\bnow hiring\b|\bjob openings?\b|\bopen (?:positions?|roles?)\b|\bjoin our team\b|\bcareers? at\b|\bapply (?:now|today)\b|\bapplications? (?:are |is )?(?:now )?open\b|\bhiring:\s/i },
  // A bare role as the whole title ("Head of Hiring", "DC Chief of Staff", "Research Fellow"): a vacancy page.
  { kind: "job", re: /^(?:[\p{Lu}][\p{L}.&]*\s+){0,3}(?:Head of [\p{Lu}][\p{L}& ]+|Chief of Staff|(?:Research|Program|Operations|Talent|Policy|Product|Engineering|Communications|Recruiting|Project|Office|Community|Partnerships)\s+(?:[\p{Lu}][\p{L}]*\s+)?(?:Manager|Fellow|Scholar|Associate|Assistant|Analyst|Coordinator|Lead|Director|Officer|Intern|Engineer|Scientist|Specialist|Recruiter))(?:\s*\([^)]{1,60}\))?\s*$/u },
  { kind: "job", re: /\b(?:Summer|Winter|Spring|Fall|Autumn) (?:Fellowship|Internship)s?\b/i },
  { kind: "sponsored", re: /^\s*(?:[[(]\s*(?:sponsored|sponsor|promoted|advertorial|partner content|paid post)[^\])]{0,20}[\])]|(?:sponsored|sponsor(?:ed)? (?:post|content)|partner content|advertorial|paid (?:post|program|content)|promoted)\s*[:\-–—])|[[(]\s*sponsored\s*[\])]\s*$|\bsponsored (?:post|content)\b|\badvertorial\b|\bpartner content\b/i },
  { kind: "index", re: /\barchives?\s*$|^\s*(?:category|tag|tagged|topic|author|archive|posts? (?:tagged|by))\s*:|\bpage \d+ of \d+\b|^\s*(?:home|blog|news|all posts|latest (?:news|posts))\s*$/i },
  // Shopping-season names are promos only next to an offer ("Why Holiday Security Can't Wait for Black Friday" is a story).
  { kind: "promo", re: /\b(?:black friday|cyber monday|prime day)\b.{0,60}\b(?:deals?|sales?|savings|discounts?|offers?)\b|\b(?:deals?|sales?|savings|discounts?|offers?)\b.{0,60}\b(?:black friday|cyber monday|prime day)\b/i },
  { kind: "promo", re: /^\s*(?:get|grab|score|snag|save)\b.{0,80}(?:\$\d|\d{1,3}%)|\bsave \d{1,3}%|\bnow (?:just|only) \$?\d|\bfor (?:just|only) \$\d|\blowest[- ]ever price\b|\ball-time[- ]low price\b/i },
  { kind: "promo", re: /\b(?:best|top)\b.{0,40}\bdeals\b|\bdeals? of the (?:day|week)\b|\b\d{1,2}% off\b|\bsave (?:up to )?\$\d|\b(?:discount|coupon|promo) codes?\b|\bgiveaway\b|\bsweepstakes\b|\bgift guide\b|\blimited[- ]time offer\b|\bbuy one,? get one\b/i },
];

// Labels a feed puts at the very start of the description.
const SUMMARY_RULES: readonly NoiseRule[] = [
  { kind: "sponsored", re: /^\s*[[(]?\s*(?:sponsored|sponsored (?:post|content)|advertorial|partner content|paid post)\s*[\])]?\s*(?:[:\-–—|]|by\b)/i },
  { kind: "webinar", re: /^\s*(?:register (?:now|today)|join us (?:for|on|at) (?:a |an |our )?(?:live |free |upcoming )?webinar)\b/i },
];

export interface NoiseVerdict {
  kind: NoiseKind;
  /** The text that matched (for the drop detail). */
  match: string;
}

/** The kind of non-story an item is, or null for an ordinary item. */
export function noiseKind(title: string, summary?: string | null): NoiseVerdict | null {
  for (const rule of TITLE_RULES) {
    const m = rule.re.exec(title);
    if (m) return { kind: rule.kind, match: m[0].trim() };
  }
  if (summary) {
    for (const rule of SUMMARY_RULES) {
      const m = rule.re.exec(summary);
      if (m) return { kind: rule.kind, match: m[0].trim() };
    }
  }
  return null;
}
