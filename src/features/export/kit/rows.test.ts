import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTION_IDS } from "../../../../shared/sections";
import { riverRows } from "../../../../shared/select";
import { compileTerms, parseQuery } from "../../../../shared/text";
import { makeArticle, makeEdition, makeRiver } from "../../../../test/helpers/factories";
import { BUILD_CADENCE, PAGE_ROW_BUDGET, capGroups, groupBySection, plural, queryRanges, readerSectionOrder, riverRef, riverToRowItem, snippetAround, splitByRanges, storyRef, termRanges } from "./rows";

const cut = (text: string, words: readonly string[]): string[] => queryRanges(text, words).map((r) => text.slice(r.start, r.end));

describe("export/kit/rows - river rows", () => {
  it("riverToRowItem converts epoch ms to ISO and keeps the section and source id", () => {
    const a = makeArticle({ title: "Qwen ships", src: "qwen-blog", home: "open_local", publishedAt: "2026-11-19T10:00:00.000Z", firstSeenAt: "2026-11-19T10:05:00.000Z" });
    const undated = makeArticle({ publishedAt: null, firstSeenAt: "2026-11-19T09:00:00.000Z" });
    const [first, second] = riverRows(makeRiver([a, undated]));
    assert.deepEqual(riverToRowItem(first), {
      id: a.id,
      title: "Qwen ships",
      url: a.url,
      sourceName: "Qwen Blog",
      sourceId: "qwen-blog",
      publishedAt: "2026-11-19T10:00:00.000Z",
      firstSeenAt: "2026-11-19T10:05:00.000Z",
      section: "open_local",
    });
    assert.equal(riverToRowItem(second).publishedAt, null);
    assert.equal(riverToRowItem(second).firstSeenAt, "2026-11-19T09:00:00.000Z");
    assert.deepEqual(riverRef(first), { id: a.id, item: riverToRowItem(first) });
  });

  it("storyRef points at the story lead when the edition has it, else at the item itself", () => {
    const lead = makeArticle({ title: "Lead" });
    const member = makeArticle({ title: "Member" });
    const loner = makeArticle({ title: "Loner" });
    const { edition } = makeEdition({ articles: [lead, member], clusters: { [lead.id]: [member.id] }, rows: { industry: [lead.id] } });
    const items = riverRows(makeRiver([lead, member, loner], { leads: { [member.id]: lead.id, [loner.id]: "gone-lead" } }));
    const byId = new Map(items.map((r) => [r.id, r]));
    assert.deepEqual(storyRef(edition, byId.get(member.id)!), { id: lead.id });
    assert.equal(storyRef(edition, byId.get(loner.id)!).id, loner.id, "a lead that is not in the edition is not used");
    assert.equal(storyRef(null, byId.get(member.id)!).id, member.id);
    assert.ok(storyRef(null, byId.get(member.id)!).item);
  });

  it("groupBySection uses homepage order and keeps item order inside a group", () => {
    const groups = groupBySection(
      [
        { n: 1, s: "cyber" as const },
        { n: 2, s: "models" as const },
        { n: 3, s: "cyber" as const },
      ],
      (x) => x.s,
    );
    assert.deepEqual(groups.map((g) => [g.section, g.label, g.items.map((i) => i.n)]), [
      ["models", "MODELS & LABS", [2]],
      ["cyber", "CYBER WIRE", [1, 3]],
    ]);
  });

  it("readerSectionOrder always returns all sections once: stored first, the rest in default order", () => {
    assert.deepEqual(readerSectionOrder(null), [...SECTION_IDS]);
    const order = readerSectionOrder(["cyber", "bogus", "models", "cyber"]);
    assert.equal(order.length, SECTION_IDS.length);
    assert.deepEqual(order.slice(0, 3), ["cyber", "models", "industry"]);
    assert.equal(new Set(order).size, SECTION_IDS.length);
  });
});

describe("export/kit/rows - highlighting", () => {
  it("queryRanges finds every word, case-insensitively, in original offsets", () => {
    assert.deepEqual(cut("Anthropic IPO: anthropic lists", parseQuery("anthropic ipo")), ["Anthropic", "IPO", "anthropic"]);
  });

  it("queryRanges folds diacritics, curly quotes and dashes like the search itself", () => {
    assert.deepEqual(cut("Café society", parseQuery("cafe")), ["Café"]);
    assert.deepEqual(cut("OpenAI’s plan", parseQuery("openai's")), ["OpenAI’s"]);
    assert.deepEqual(cut("A state–of–the–art model", parseQuery("state-of-the-art")), ["state–of–the–art"]);
  });

  it("queryRanges highlights what the search matches: never mid-word, short words whole (with a plural or possessive ending)", () => {
    assert.deepEqual(cut("Intel and Artificial Intelligence at Intel’s fab", parseQuery("intel")), ["Intel", "Intel’s"]);
    assert.deepEqual(cut("Charm, an alarming venture arm", parseQuery("arm")), ["arm"]);
    assert.deepEqual(cut("LLMs and one LLM", parseQuery("llm")), ["LLMs", "LLM"]);
    assert.deepEqual(cut("Anthropic and misanthropic", parseQuery("anthrop")), ["Anthrop"]);
  });

  it("queryRanges keeps a quoted phrase together and tolerates doubled spaces in the text", () => {
    assert.deepEqual(cut("New prompt  injection attack; prompt hardening", parseQuery('"prompt injection"')), ["prompt  injection"]);
  });

  it("queryRanges merges overlapping hits and returns [] without words or text", () => {
    assert.deepEqual(cut("llama.cpp", ["llama", "llama.cpp", "cpp"]), ["llama.cpp"]);
    assert.deepEqual(queryRanges("anything", []), []);
    assert.deepEqual(queryRanges("", ["x"]), []);
  });

  it("termRanges uses the watchlist matcher (word boundaries, wildcard)", () => {
    const m = compileTerms(["quantiz*", "SEC"], { plural: true });
    const text = "SEC reviews quantized models; security unaffected";
    assert.deepEqual(termRanges(text, m).map((r) => text.slice(r.start, r.end)), ["SEC", "quantized"]);
  });

  it("splitByRanges cuts text into plain and hit pieces that concatenate to the input", () => {
    const text = "Anthropic IPO today";
    const parts = splitByRanges(text, queryRanges(text, ["ipo"]));
    assert.deepEqual(parts, [
      { text: "Anthropic ", hit: false },
      { text: "IPO", hit: true },
      { text: " today", hit: false },
    ]);
    assert.equal(parts.map((p) => p.text).join(""), text);
    assert.deepEqual(splitByRanges("abc", []), [{ text: "abc", hit: false }]);
    assert.deepEqual(splitByRanges("abc", [{ start: 2, end: 99 }]), [
      { text: "ab", hit: false },
      { text: "c", hit: true },
    ]);
  });

  it("snippetAround cuts at word boundaries with ellipses; null without a hit", () => {
    const text = `${"alpha ".repeat(40)}the Nvidia earnings call ${"omega ".repeat(40)}`.trim();
    const s = snippetAround(text, ["nvidia"], 30)!;
    assert.match(s, /^… .*Nvidia earnings.* …$/);
    assert.ok(s.length < 110, `snippet is short (${s.length})`);
    assert.ok(!/^… \S*lpha\b/.test(s) || s.startsWith("… alpha"), "starts at a word boundary");
    assert.equal(snippetAround("short Nvidia note", ["nvidia"]), "short Nvidia note");
    assert.equal(snippetAround("nothing here", ["nvidia"]), null);
  });

  it("plural", () => {
    assert.equal(plural(1, "story", "stories"), "1 story");
    assert.equal(plural(0, "story", "stories"), "0 stories");
    assert.equal(plural(2, "term"), "2 terms");
  });
});

describe("export/kit/rows - page row budget", () => {
  const groups = [
    { name: "a", rows: [1, 2, 3] },
    { name: "b", rows: [] as number[] },
    { name: "c", rows: [4, 5, 6, 7] },
    { name: "d", rows: [8, 9] },
  ];
  const rowsOf = (g: (typeof groups)[number]): readonly number[] => g.rows;
  const shape = (budget: number) => {
    const r = capGroups(groups, rowsOf, budget);
    return { groups: r.groups.map((g) => [g.group.name, g.rows]), shown: r.shown, hidden: r.hidden };
  };

  it("spends ONE budget across groups in order: the group at the cut keeps its head, later groups are dropped", () => {
    assert.deepEqual(shape(5), { groups: [["a", [1, 2, 3]], ["c", [4, 5]]], shown: 5, hidden: 4 });
    assert.deepEqual(shape(3), { groups: [["a", [1, 2, 3]]], shown: 3, hidden: 6 });
    assert.deepEqual(shape(1), { groups: [["a", [1]]], shown: 1, hidden: 8 });
  });

  it("a budget that covers everything changes nothing (empty groups are never rendered)", () => {
    const all = { groups: [["a", [1, 2, 3]], ["c", [4, 5, 6, 7]], ["d", [8, 9]]], shown: 9, hidden: 0 };
    assert.deepEqual(shape(9), all);
    assert.deepEqual(shape(Infinity), all);
    assert.deepEqual(shape(PAGE_ROW_BUDGET), all);
  });

  it("a zero, negative or fractional budget is safe; the group objects are passed through untouched", () => {
    assert.deepEqual(shape(0), { groups: [], shown: 0, hidden: 9 });
    assert.deepEqual(shape(-4), { groups: [], shown: 0, hidden: 9 });
    assert.equal(shape(2.9).shown, 2);
    assert.equal(capGroups(groups, rowsOf, 5).groups[1].group, groups[2], "callers still read the group's true size from it");
    assert.deepEqual(groups[2].rows, [4, 5, 6, 7], "input rows are not mutated");
  });

  it("the budget sits above the home page's row count and the cadence wording is the build's 30 minutes", () => {
    assert.ok(PAGE_ROW_BUDGET >= 100 && PAGE_ROW_BUDGET <= 200);
    assert.equal(BUILD_CADENCE, "about every 30 minutes");
  });
});
