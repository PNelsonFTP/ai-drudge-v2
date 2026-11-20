// XML text helpers for feed.xml and feeds.opml. Pure.

// Everything outside the XML 1.0 Char production (C0 controls except TAB/LF/CR, lone surrogates,
// U+FFFE/U+FFFF). One such character in a feed title made V1's feed.xml non-well-formed.
const XML_ILLEGAL = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export function stripXmlIllegal(s: string): string {
  return s.replace(XML_ILLEGAL, "");
}

/** True when the string contains a character an XML 1.0 document may not contain. */
export function hasXmlIllegal(s: string): boolean {
  XML_ILLEGAL.lastIndex = 0;
  return XML_ILLEGAL.test(s);
}

/** Escape for element content AND attribute values (both quote styles), after dropping illegal characters. */
export function xmlEscape(s: string): string {
  return stripXmlIllegal(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
