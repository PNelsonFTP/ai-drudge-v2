import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RIVER } from "../../../shared/contract";
import { SECTIONS } from "../../../shared/sections";
import { NO_MUTES } from "../../../shared/select";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { titleWords } from "../../../test/helpers/fixtureCases";
import { fixtureEdition, fixtureRiver } from "../../../test/helpers/fixtureData";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { PAGE_ROW_BUDGET } from "../export/kit/rows";
import { buildSearchView, type SearchView } from "./model";
import { SearchPage } from "./SearchPage";

// Queries come from the fixture's own headlines (a frozen live build that is replaced now and then),
// chosen by what the tests need - never a word of one particular day:
const edition = fixtureEdition();
const WORDS = titleWords(fixtureRiver.rows.map((r) => r[RIVER.title])).map((w) => w.word.toLowerCase());
const viewOf = (query: string): SearchView => buildSearchView({ edition, river: fixtureRiver, query, mutes: NO_MUTES });
/** BUSY: the word most headlines of the week carry. */
const BUSY = WORDS[0];
/** MODEST: a headline word with a handful of matches - a result list well inside the page's row budget. */
const MODEST = WORDS.find((w) => {
  const v = viewOf(w);
  return v.total >= 3 && v.total + v.bySource.length <= 40;
}) as string;
/** NAMED: a headline word that is also the name of a source with other stories ("nvidia" on most days). */
const NAMED = WORDS.find((w) => {
  const v = viewOf(w);
  return v.total > 0 && v.bySource.length > 0 && v.total + v.bySource.length <= PAGE_ROW_BUDGET;
}) as string;
/** SUMMARY: a word a story says in its summary only, with the story found by it. */
const SUMMARY = ((): string => {
  for (const s of edition.sections) {
    for (const id of s.rows) {
      const a = edition.articles[id];
      for (const w of new Set(a.summary?.match(/[A-Za-z]{7,}/g) ?? [])) {
        const hit = viewOf(w).groups.flatMap((g) => g.rows).find((r) => r.id === id);
        if (hit?.context?.place === "summary") return w.toLowerCase();
      }
    }
  }
  return "";
})();
const labelToId = (label: string): string | undefined => SECTIONS.find((x) => x.label === label)?.id;

describe("search page (SSR)", () => {
  it("lists matches from the edition and the river, grouped by section with counts", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    // Two words (both must be found): the busiest headline word and the word it is most often seen with.
    const withBusy = fixtureRiver.rows.map((r) => r[RIVER.title]).filter((t) => new RegExp(`\\b${BUSY}`, "i").test(t));
    // ... among those, the first pair that also reaches into the 7-day archive (the most frequent
    // partner of a day's big story may sit in edition stories only - 2026-11-20 05:16Z: "street").
    const partners = titleWords(withBusy).map((w) => w.word.toLowerCase()).filter((w) => w !== BUSY && !w.startsWith(BUSY));
    assert.ok(partners.length > 0, "fixture: the busiest headline word has company");
    const fits = (q: string): boolean => {
      const v = viewOf(q);
      return v.total >= 3 && v.fromRiver >= 1 && v.total <= PAGE_ROW_BUDGET;
    };
    const partner = partners.find((w) => fits(`${BUSY} ${w}`)) ?? partners[0];
    const query = `${BUSY} ${partner}`;
    const view = viewOf(query);
    assert.ok(view.total >= 3 && view.fromRiver >= 1 && view.bySource.length === 0 && view.total <= PAGE_ROW_BUDGET, `"${query}": ${view.total} stories, ${view.fromRiver} from the river`);
    const html = renderRoute(s, SearchPage, { name: "search", q: query });
    const h2 = tagTexts(html, "h2");
    assert.deepEqual(h2, [`Search ${view.total} stories`]);
    const total = view.total;
    assert.equal(countOf(html, "data-aid="), total, "one row per story");
    const status = /<p class="sp-note" role="status" aria-live="polite">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
    assert.equal(status, `${total} stories match “${query}” · ${view.fromRiver} from the 7-day archive, not in the current edition`);
    const h3 = tagTexts(html, "h3");
    assert.deepEqual(h3, view.groups.map((g) => `${g.label} ${g.rows.length}`));
    assert.equal(h3.reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1]), 0), total, "group counts add up");
    for (const g of view.groups) assert.ok(hrefsOf(html).includes(`#/s/${g.section}`), "group headings link to their section");
    assert.deepEqual(a11yProblems(html), []);
  });

  it("a broad query renders one page-level budget of rows and offers the rest; counts stay true", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    const html = renderRoute(s, SearchPage, { name: "search", q: "ai" });
    const total = Number(/^Search (\d+) stories$/.exec(tagTexts(html, "h2")[0])?.[1]);
    assert.ok(total > PAGE_ROW_BUDGET, `the fixture matches ${total} stories for "ai"`);
    assert.equal(countOf(html, "data-aid="), PAGE_ROW_BUDGET);
    const text = textOf(html);
    // The matches and, apart from them, the stories found only by a source name ("AI News" ...).
    const status = new RegExp(`${total} stories match “ai” · \\d+ from the 7-day archive, not in the current edition · plus (\\d+) stories from sources named “ai”, listed after them`).exec(text);
    assert.ok(status, "the status line keeps the true total and says what is listed besides");
    const listed = total + Number(status[1]);
    assert.ok(tagTexts(html, "button").includes(`Show all ${listed} stories`));
    assert.match(text, new RegExp(`Showing the first ${PAGE_ROW_BUDGET} of ${listed} stories, in section order \\(source-name matches last\\)\\.`));
    assert.ok(!tagTexts(html, "h3").some((t) => t.startsWith("From sources named")), "the source-name group is past the budget");
    // Every rendered group shows its true size, so a cut group reads "POLICY 40" above fewer rows.
    const badgeSum = tagTexts(html, "h3").reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1]), 0);
    assert.ok(badgeSum >= PAGE_ROW_BUDGET && badgeSum <= total, `${badgeSum}`);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("stories found only by the name of their source are a separate, labelled group after the matches and are not counted", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    assert.ok(NAMED, "fixture: a headline word that also names a source");
    const html = renderRoute(s, SearchPage, { name: "search", q: NAMED });
    const total = Number(/^Search (\d+) stor(y|ies)$/.exec(tagTexts(html, "h2")[0])?.[1]);
    const h3 = tagTexts(html, "h3");
    const last = new RegExp(`^From sources named “${NAMED}” (\\d+) only the source name matches - not counted above$`).exec(h3[h3.length - 1]);
    assert.ok(last, h3[h3.length - 1]);
    const named = Number(last[1]);
    assert.ok(total > 0 && named > 0);
    assert.deepEqual([total, named], [viewOf(NAMED).total, viewOf(NAMED).bySource.length]);
    assert.equal(h3.slice(0, -1).reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1]), 0), total, "the section groups add up to the count in the heading");
    assert.equal(countOf(html, "data-aid="), total + named);
    assert.match(textOf(html), new RegExp(`${total} stor(y|ies) match(es)? “${NAMED}” · (\\d+ from the 7-day archive, not in the current edition · )?plus ${named} stor(y|ies) from sources named “${NAMED}”, listed after them`));
    // Every row of that group says which name matched, and it comes after every section group.
    const tail = html.slice(html.indexOf("From sources named"));
    assert.equal(countOf(tail, "data-aid="), named);
    assert.equal(countOf(tail, '<span class="sp-label">Source</span>'), named);
    assert.ok(!html.slice(0, html.indexOf("From sources named")).includes('<span class="sp-label">Source</span>'), "no name-only row among the matches");
    assert.deepEqual(a11yProblems(html), []);
  });

  it("a query that is a section name links to the section instead of listing it", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    const html = renderRoute(s, SearchPage, { name: "search", q: "ai security" });
    assert.match(textOf(html), /AI SECURITY is a section\. Section names are not searched as words: Go to the AI SECURITY section/);
    assert.match(html, /<a href="#\/s\/ai_security">Go to the AI SECURITY section<\/a>/);
    const total = Number(/^Search (\d+) stor(y|ies)$/.exec(tagTexts(html, "h2")[0])?.[1]);
    const section = s.edition.get().edition!.sections.find((x) => x.id === "ai_security")!;
    assert.ok(total < section.rows.length, `${total} stories say "ai security"; the section lists ${section.rows.length}`);
    assert.ok(!textOf(renderRoute(s, SearchPage, { name: "search", q: BUSY })).includes("is a section"));
  });

  it("section: and source: narrow the search and the page says so; an unknown section is named", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    // The busiest word is found in several sections; `section:` keeps one of them (the last listed).
    const groups = viewOf(BUSY).groups;
    assert.ok(groups.length >= 2, "fixture: the busiest headline word is found in more than one section");
    const only = groups[groups.length - 1];
    const scoped = renderRoute(s, SearchPage, { name: "search", q: `section:${only.section} ${BUSY}` });
    assert.ok(textOf(scoped).includes(`Searching only in ${only.label}.`), textOf(scoped).slice(0, 300));
    assert.deepEqual(tagTexts(scoped, "h3").filter((t) => !t.startsWith("From sources")).map((t) => t.replace(/ \d+$/, "")), [only.label]);
    assert.equal(labelToId(only.label), only.section);
    const from = renderRoute(s, SearchPage, { name: "search", q: `source:${NAMED}` });
    assert.ok(textOf(from).includes(`Searching only stories from sources named “${NAMED}”.`));
    assert.ok(countOf(from, "data-aid=") > 0);
    assert.ok(!tagTexts(from, "h3").some((t) => t.startsWith("From sources named")), "asked for on purpose: these are the results");
    const bad = renderRoute(s, SearchPage, { name: "search", q: `section:nosuch ${BUSY}` });
    assert.match(textOf(bad), /No section is called “nosuch”\./);
    assert.equal(countOf(bad, "data-aid="), 0);
  });

  it("a query within the budget has no 'show all' button", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    assert.ok(MODEST, "fixture: a headline word with a handful of matches");
    const html = renderRoute(s, SearchPage, { name: "search", q: MODEST });
    assert.equal(countOf(html, "data-aid="), viewOf(MODEST).total + viewOf(MODEST).bySource.length, "every result is rendered");
    assert.ok(!tagTexts(html, "button").some((b) => b.startsWith("Show all")));
    assert.ok(!textOf(html).includes("Showing the first"));
  });

  it("explains matches that are not visible in the headline, with the hit marked", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    assert.ok(SUMMARY, "fixture: a story found by a word of its summary that its headline does not carry");
    const html = renderRoute(s, SearchPage, { name: "search", q: SUMMARY });
    assert.match(html, /<p class="sp-row-context"><span class="sp-label">In the summary<\/span>/);
    assert.match(html, new RegExp(`<mark class="sp-mark">${SUMMARY}</mark>`, "i"));
  });

  it("offers to save the query as a watch term, and shows when it already is one", () => {
    const fresh = renderRoute(createFakeServices(), SearchPage, { name: "search", q: '"prompt injection"' });
    assert.ok(tagTexts(fresh, "button").includes("Save “prompt injection” as watch term"));
    assert.match(fresh, /aria-pressed="false"/);
    const watching = renderRoute(createFakeServices({ watchTerms: ["Prompt Injection"] }), SearchPage, { name: "search", q: "prompt injection" });
    assert.ok(tagTexts(watching, "button").includes("Watching “prompt injection”"));
    assert.match(watching, /aria-pressed="true"/);
    assert.ok(hrefsOf(watching).includes("#/watch"));
  });

  it("says results are incomplete while the river is still loading", () => {
    const html = renderRoute(createFakeServices(), SearchPage, { name: "search", q: BUSY });
    assert.match(textOf(html), new RegExp(`stories match “${BUSY}” · (plus \\d+ stor(y|ies) from sources named “${BUSY}”, listed after them · )?still loading…`));
  });

  it("says so, with a retry, when the full edition failed to load", async () => {
    const s = createFakeServices({ loaded: "front" });
    await s.edition.loadRiver();
    s.stores.edition.set({ ...s.edition.get(), restStatus: "error" });
    const html = renderRoute(s, SearchPage, { name: "search", q: BUSY });
    assert.match(textOf(html), /The full edition could not be loaded; edition results cover the front-page rows only\. Try again/);
    assert.ok(!textOf(html).includes("still loading"));
  });

  it("empty query: tips instead of results", () => {
    const html = renderRoute(createFakeServices(), SearchPage, { name: "search", q: "  " });
    assert.deepEqual(tagTexts(html, "h2"), ["Search"]);
    assert.equal(countOf(html, "data-aid="), 0);
    const text = textOf(html);
    assert.match(text, /Type a word, a name or a phrase in the search box/);
    assert.match(text, /Every word must match/);
    assert.match(text, /short words \(up to 5 letters\) must match a whole word/);
    assert.match(text, /double quotes/);
    assert.match(text, /last 7 days/);
    assert.match(text, /Stories that match only by the name of their source are listed separately, after the results\./);
    assert.match(text, /Narrow a search with source:reuters or section:policy \(for example section:policy finra \)\. Section names are not searched as words\./);
    assert.equal(countOf(html, "<li>"), 7);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("no results: says so, repeats the tips and points to the watchlist", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    const html = renderRoute(s, SearchPage, { name: "search", q: "zzzunobtainium" });
    const text = textOf(html);
    assert.match(text, /No stories match “zzzunobtainium”/);
    assert.match(text, /Nothing in the last 7 days matches “zzzunobtainium”\./);
    assert.ok(tagTexts(html, "button").includes("Save “zzzunobtainium” as watch term"));
    assert.ok(hrefsOf(html).includes("#/watch"));
  });

  it("still searches the river when the edition failed to load", async () => {
    const s = createFakeServices({ loaded: "error" });
    await s.edition.loadRiver();
    const html = renderRoute(s, SearchPage, { name: "search", q: "anthropic" });
    assert.match(textOf(html), /The current edition could not be loaded; results come from the 7-day archive only\./);
    assert.ok(countOf(html, "data-aid=") > 10);
  });

  it("respects mutes", async () => {
    const s = createFakeServices({ mutedSections: ["industry", "money", "models", "tools"] });
    await s.edition.loadRiver();
    const html = renderRoute(s, SearchPage, { name: "search", q: "anthropic ipo" });
    assert.ok(!tagTexts(html, "h3").some((t) => t.startsWith("INDUSTRY")));
  });
});
