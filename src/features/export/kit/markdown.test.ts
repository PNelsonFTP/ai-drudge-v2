import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeMarkdown, markdownLink, markdownUrl, plainLine } from "./markdown";

describe("export/kit/markdown", () => {
  it("escapes the characters that open or close inline Markdown", () => {
    assert.equal(escapeMarkdown("[Breaking] *Big* _news_ `code` #1 <b> a|b ~x~ \\n"), "\\[Breaking\\] \\*Big\\* \\_news\\_ \\`code\\` \\#1 \\<b\\> a\\|b \\~x\\~ \\\\n");
  });

  it("leaves ordinary punctuation alone so plain-text readers are not littered with backslashes", () => {
    assert.equal(escapeMarkdown("GPT-5.1 (preview): what's new? $2tn + more!"), "GPT-5.1 (preview): what's new? $2tn + more!");
  });

  it("neutralises entity-like sequences but not a bare ampersand", () => {
    // Named entities get "\\&"; numeric ones are already broken by the escaped "#".
    assert.equal(escapeMarkdown("AT&T &amp; Co &#39;x&#39; R&D"), "AT&T \\&amp; Co &\\#39;x&\\#39; R&D");
  });

  it("collapses whitespace and newlines (a title can never break out of its line)", () => {
    assert.equal(escapeMarkdown("  Line one\n\n# Heading\tinjected  "), "Line one \\# Heading injected");
    assert.equal(escapeMarkdown(null), "");
  });

  it("markdownUrl accepts only http(s) and encodes the characters that end a link target", () => {
    assert.equal(markdownUrl("https://example.com/a (b)/c?q=<x>&y=\"z\""), "https://example.com/a%20%28b%29/c?q=%3Cx%3E&y=%22z%22");
    assert.equal(markdownUrl("javascript:alert(1)"), "");
    assert.equal(markdownUrl("data:text/html,x"), "");
    assert.equal(markdownUrl(""), "");
    assert.equal(markdownUrl(undefined), "");
  });

  it("markdownLink builds [label](url) and degrades to text for a bad URL", () => {
    assert.equal(markdownLink("A [b] c", "https://example.com/x_(y)"), "[A \\[b\\] c](https://example.com/x_%28y%29)");
    assert.equal(markdownLink("A [b]", "javascript:void(0)"), "A \\[b\\]");
  });

  it("an escaped label cannot close the link early", () => {
    const md = markdownLink("x](https://evil.example) [y", "https://example.com/ok");
    assert.equal(md, "[x\\](https://evil.example) \\[y](https://example.com/ok)");
    // Exactly one unescaped "](" - the real link target.
    assert.equal(md.replace(/\\./g, "").split("](").length - 1, 1);
  });

  it("plainLine strips control characters and collapses whitespace", () => {
    assert.equal(plainLine("a\u0000b\n c\t d"), "a b c d");
    assert.equal(plainLine(undefined), "");
  });
});
