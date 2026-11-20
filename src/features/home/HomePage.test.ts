import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefFile } from "../../../shared/contract";
import { SECTION_IDS, sectionById } from "../../../shared/sections";
import { alsoOutlets, storyNewestMs } from "../../../shared/select";
import { HOUR_MS, effectiveMs } from "../../../shared/time";
import { FIXTURE_META, hoursAgo, makeArticle, makeEdition } from "../../../test/helpers/factories";
import { createFakeServices, type FakeServices, type FakeServicesOptions } from "../../../test/helpers/fakeServices";
import { commonTitleWord, homepageTitles } from "../../../test/helpers/fixtureCases";
import { fixtureBrief, fixtureFront, fixtureStory } from "../../../test/helpers/fixtureData";
import { ServicesContext } from "../../app/services";
import { mountFakeDom, type FakeNode } from "../headline/fakeDom.testkit";
import { DailyBrief } from "./DailyBrief";
import { assignColumns } from "./homeModel";
import { HomePage } from "./HomePage";

const within = (services: FakeServices, element: ReactElement): ReactElement => createElement(ServicesContext.Provider, { value: services }, element);
const page = (): ReactElement => createElement(HomePage, { route: { name: "home" } });
const render = (opts: FakeServicesOptions = {}): { out: string; services: FakeServices } => {
  const services = createFakeServices(opts);
  return { out: renderToStaticMarkup(within(services, page())), services };
};

const strip = (s: string): string =>
  s
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .trim();
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const buttonNames = (markup: string): string[] => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[1])?.[1] ?? strip(m[2]));
const linkHrefs = (markup: string): string[] => [...markup.matchAll(/<a\b([^>]*)>/g)].map((m) => /href="([^"]*)"/.exec(m[1])?.[1] ?? "");
const headings = (markup: string): { level: number; id: string; text: string }[] =>
  [...markup.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: Number(m[1]), id: /id="([^"]*)"/.exec(m[2])?.[1] ?? "", text: strip(m[3]) }));
const rowIds = (markup: string): string[] => [...markup.matchAll(/data-aid="([^"]+)"/g)].map((m) => m[1]);
/** The markup of one homepage section (from its <section> tag to the next one). */
const sectionMarkup = (markup: string, id: string): string => {
  const start = markup.indexOf(`data-section="${id}"`);
  assert.ok(start >= 0, `section ${id} is not rendered`);
  const end = markup.indexOf('<section class="home-section"', start);
  return markup.slice(start, end < 0 ? undefined : end);
};

const claudeBrief: BriefFile = {
  ...FIXTURE_META,
  source: "claude",
  model: "claude-test-model",
  headline: "Three labs shipped on the same day.",
  bullets: ["Anthropic began trading.", "Google released Gemini 4 Neon.", "OpenAI answered with GPT-6.2."],
  cited: [
    { title: "Anthropic valued at $2tn", url: "https://example.com/anthropic", source: "The Guardian" },
    { title: "Introducing Gemini 4 Neon", url: "https://example.com/gemini", source: "Google DeepMind" },
    { title: "bad", url: "javascript:alert(1)", source: "Evil" },
  ],
};

describe("HomePage (static markup, fixture edition)", () => {
  const { out, services } = render();
  const edition = services.edition.get().edition!;

  it("uses h2 for every block and nothing else: TOP STORIES, LATEST, one per section", () => {
    const hs = headings(out);
    assert.ok(hs.every((h) => h.level === 2), `only h2 on the page (the shell owns the h1): ${JSON.stringify(hs.filter((h) => h.level !== 2))}`);
    assert.deepEqual(hs.slice(0, 2).map((h) => [h.id, h.text]), [["top-stories", "TOP STORIES ranked by coverage and freshness"], ["latest", "LATEST"]]);
    const sections = hs.slice(2);
    assert.deepEqual(sections.map((h) => h.id).sort(), SECTION_IDS.map((id) => `${id}-heading`).sort());
    for (const h of sections) assert.equal(h.text, sectionById(h.id.replace(/-heading$/, "") as (typeof SECTION_IDS)[number]).label);
    assert.equal(new Set(hs.map((h) => h.id)).size, hs.length, "heading ids are unique");
  });

  it("every section is a sec-<id> jump target, labelled by a heading that links to its section page", () => {
    for (const id of SECTION_IDS) {
      const label = sectionById(id).label.replace(/&/g, "&amp;");
      assert.ok(out.includes(`<section class="home-section" id="sec-${id}" aria-labelledby="${id}-heading" data-section="${id}">`), id);
      assert.ok(out.includes(`<h2 class="section-heading" id="${id}-heading"><a href="#/s/${id}">${label}</a></h2>`), id);
    }
    // The keyboard layer treats every [id^="sec-"] element as a section that contains its rows.
    assert.deepEqual([...out.matchAll(/ id="(sec-[^"]*)"/g)].map((m) => m[1]).sort(), SECTION_IDS.map((id) => `sec-${id}`).sort());
    assert.equal(new Set([...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).size, [...out.matchAll(/ id="([^"]+)"/g)].length, "ids are unique");
  });

  it("every link has an href and every button an accessible name", () => {
    const hrefs = linkHrefs(out);
    assert.ok(hrefs.length > 200);
    assert.ok(hrefs.every((h) => /^https?:\/\//.test(h) || h.startsWith("#/")), JSON.stringify(hrefs.filter((h) => !/^https?:\/\//.test(h) && !h.startsWith("#/"))));
    const names = buttonNames(out);
    assert.ok(names.length > 300);
    assert.ok(names.every((n) => n.length > 0));
    assert.ok(!out.includes("javascript:"));
    for (const m of out.matchAll(/<a\b([^>]*)>/g)) if (/target="_blank"/.test(m[1])) assert.match(m[1], /rel="noopener noreferrer"/);
  });

  it("TOP STORIES: a large lead with summary, then the ranked stories, each with an outlet count", () => {
    const top = out.slice(out.indexOf('<section class="trend-box home-top"'), out.indexOf("</section>") + 10);
    const ids = rowIds(top);
    assert.deepEqual(ids, edition.top);
    assert.match(top, new RegExp(`data-aid="${edition.leadId}" data-variant="lead"`));
    assert.ok(top.includes('<p class="hl-summary">'), "the lead shows its summary");
    assert.equal([...top.matchAll(/data-variant="top"/g)].length, edition.top.length - 1);
    assert.match(top, /<ol class="home-top-list" role="list" start="2">/);
    assert.equal([...top.matchAll(/<span class="home-rank" aria-hidden="true">(\d+)<\/span>/g)].map((m) => m[1]).join(","), edition.top.slice(1).map((_, i) => String(i + 2)).join(","));
    for (const id of edition.top) assert.ok(top.includes(`${edition.clusters[id].publishers} outlets</span>`), id);
  });

  it("Also: lines link to the other outlets of each top story", () => {
    const top = out.slice(out.indexOf('<section class="trend-box home-top"'), out.indexOf("</section>") + 10);
    const lines = [...top.matchAll(/<p class="hl-also">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    const withOutlets = edition.top.filter((id) => alsoOutlets(edition, id).length > 0);
    assert.equal(lines.length, withOutlets.length);
    assert.ok(lines.length >= 5);
    withOutlets.forEach((id, i) => {
      const outlets = alsoOutlets(edition, id);
      assert.ok(lines[i].includes("Also:"));
      assert.deepEqual(linkHrefs(lines[i]), outlets.slice(0, i === 0 ? 12 : 8).map((o) => escapeHtml(o.article.url)));
      for (const o of outlets.slice(0, 8)) assert.ok(lines[i].includes(`>${escapeHtml(o.name)}</a>`), o.name);
    });
    // The fixture's lead has more outlets than its line holds (12 for the lead, 8 for the others): the rest is offered, not dropped.
    const lead = fixtureStory("multiPublisherLead");
    const leadOutlets = alsoOutlets(edition, lead).length;
    assert.ok(leadOutlets > 12, "fixture: the lead story has more than 12 other outlets");
    assert.ok(buttonNames(top).includes(`Show ${leadOutlets - 12} more outlets`), buttonNames(top).filter((n) => n.startsWith("Show")).join(" | "));
  });

  it("does not render the fallback brief", () => {
    assert.equal(fixtureBrief.source, "fallback");
    assert.ok(!out.includes("DAILY BRIEF"));
    assert.ok(!out.includes("brief-box"));
    // The deterministic brief repeats headlines of the page, so it is recognised by its bullets
    // ("<headline> — N outlets"), none of which may be printed.
    assert.ok(fixtureBrief.bullets.length >= 3);
    for (const bullet of fixtureBrief.bullets) assert.ok(!out.includes(escapeHtml(bullet)), bullet);
  });

  it("LATEST lists 12 compact rows", () => {
    const latest = out.slice(out.indexOf('<section class="home-latest"'), out.indexOf("</section>", out.indexOf('<section class="home-latest"')));
    assert.equal(rowIds(latest).length, 12);
    assert.equal([...latest.matchAll(/data-variant="compact"/g)].length, 12);
  });

  it("sections list their homepage rows as list items; rows past the third are phone-collapsible", () => {
    for (const s of edition.sections) {
      const html = sectionMarkup(out, s.id);
      const expected = s.rows.slice(0, s.homeCount);
      assert.deepEqual(rowIds(html), expected, s.id);
      assert.equal([...html.matchAll(/<li class="home-row-extra">/g)].length, Math.max(0, expected.length - 3), s.id);
      assert.match(html, /<ul class="home-rows" role="list">/);
      if (expected.length > 3) assert.ok(html.includes(`<button type="button" class="home-more-btn" aria-expanded="false">${expected.length - 3} more</button>`), s.id);
      assert.ok(html.includes(`${s.sourceCount} src`), s.id);
      const label = sectionById(s.id).label.replace(/&/g, "&amp;");
      if (s.rows.length > expected.length) assert.ok(html.includes(`<a class="home-view-all" href="#/s/${s.id}" aria-label="View all ${s.rows.length} ${label} stories">view all ${s.rows.length}</a>`), s.id);
      else assert.ok(!html.includes("home-view-all"), s.id);
      assert.ok(buttonNames(html).includes(`Hide the ${label} section`), s.id);
      assert.ok(buttonNames(html).includes(`${label} headlines`), s.id);
    }
  });

  it("lays the sections out in three fixed columns", () => {
    const cols = out.split('<div class="news-col">').slice(1);
    assert.equal(cols.length, 3);
    assert.deepEqual(cols.map((c) => [...c.matchAll(/data-section="([a-z_]+)"/g)].map((m) => m[1])), assignColumns([...SECTION_IDS], 3));
  });

  it("the new-since banner counts first-seen stories and links to #/new", () => {
    assert.match(out, /<div class="home-banner" role="status"><a href="#\/new"><strong>\d+<\/strong> new stories on this page since your last visit \(6h ago\) - see everything new<\/a>/);
    assert.ok(buttonNames(out).includes("Dismiss the new stories notice"));
    assert.ok(!render({ previousVisitMs: null }).out.includes("home-banner"), "no banner on a first visit");
  });
});

describe("HomePage (static markup, states)", () => {
  it("renders a brief box for an AI-written brief, labelled with the model, with cited links", () => {
    const { out } = render({ brief: claudeBrief });
    const box = out.slice(out.indexOf('<section class="brief-box home-brief"'), out.indexOf("</section>", out.indexOf('<section class="brief-box home-brief"')));
    assert.ok(box.includes('<h2 class="section-heading" id="daily-brief">DAILY BRIEF</h2>'));
    assert.match(box, /<p class="home-brief-label">AI-written · claude-test-model/);
    assert.ok(box.includes("Three labs shipped on the same day."));
    assert.equal([...box.matchAll(/<li>/g)].length, 3);
    assert.deepEqual(linkHrefs(box), ["https://example.com/anthropic", "https://example.com/gemini"], "only http(s) citations are linked");
    assert.ok(box.includes(">The Guardian</a>"));
    assert.ok(!box.includes("javascript:"));
    assert.ok(headings(out).every((h) => h.level === 2));
  });

  it("DailyBrief itself refuses a fallback brief", () => {
    const services = createFakeServices();
    assert.equal(renderToStaticMarkup(within(services, createElement(DailyBrief, { brief: { ...claudeBrief, source: "fallback" } }))), "");
    assert.match(renderToStaticMarkup(within(services, createElement(DailyBrief, { brief: { ...claudeBrief, model: undefined } }))), /AI-written · model not recorded/);
  });

  it("a brief built on a factory edition renders next to its TOP STORIES", () => {
    const lead = makeArticle({ title: "Lead story", summary: "Lead summary." });
    const other = makeArticle({ src: "other-outlet", title: "Same story elsewhere" });
    const built = makeEdition({ articles: [lead, other], clusters: { [lead.id]: [other.id] }, top: [lead.id], rows: { industry: [lead.id] } });
    const { out } = render({ front: built.front, rest: built.rest, brief: { ...claudeBrief, cited: [{ title: lead.title, url: lead.url, source: "Example Source" }] } });
    assert.ok(out.includes("DAILY BRIEF"));
    assert.ok(out.includes(`href="${lead.url}" target="_blank" rel="noopener noreferrer" title="Lead story">Example Source</a>`));
    assert.match(out, /<p class="hl-also"><span class="hl-also-label">Also:<\/span> <a class="hl-outlet" href="[^"]+" target="_blank" rel="noopener noreferrer" title="Same story elsewhere">Other Outlet<\/a><\/p>/);
    assert.ok(!out.includes("home-top-list"), "a single top story is just the lead");
  });

  it("a quiet-day lead with a single publisher renders without counts or an empty state", () => {
    const lead = makeArticle({ title: "Quiet day lead", summary: "Only one outlet has it." });
    const built = makeEdition({ articles: [lead, makeArticle()], top: [lead.id] });
    const { out } = render({ front: built.front, rest: built.rest, brief: null });
    const top = out.slice(out.indexOf('<section class="trend-box home-top"'), out.indexOf("</section>") + 10);
    assert.ok(top.includes(`data-aid="${lead.id}" data-variant="lead"`));
    assert.ok(top.includes("Only one outlet has it."));
    assert.ok(!top.includes("outlets</span>") && !top.includes("hl-also") && !top.includes("home-empty") && !top.includes("ranked by"), top);
  });

  it("shows an empty state when no story has more than one publisher", () => {
    const built = makeEdition({ articles: [makeArticle(), makeArticle(), makeArticle()] });
    const { out } = render({ front: built.front, rest: built.rest, brief: null });
    assert.ok(out.includes('<p class="home-empty">No story is covered by more than one outlet right now.</p>'));
    assert.ok(out.includes('<h2 class="section-heading" id="top-stories">TOP STORIES </h2>'));
    assert.deepEqual(headings(out).filter((h) => h.id.endsWith("-heading")).map((h) => h.id), ["industry-heading"], "empty sections are not rendered");
  });

  it("loading and error states", () => {
    const loading = render({ loaded: "loading" }).out;
    assert.equal(loading, '<p class="home-empty" role="status">Loading headlines…</p>');
    // The first attempt failed and another one is running (EditionState.retrying).
    const trying = createFakeServices({ loaded: "loading" });
    trying.stores.edition.set({ ...trying.edition.get(), retrying: true });
    assert.equal(renderToStaticMarkup(within(trying, page())), '<p class="home-empty">Still trying to load the headlines…</p>', "no second live region: the shell banner announces the retry");
    const error = render({ loaded: "error" }).out;
    assert.match(error, /^<div class="home-empty" role="alert"><p>Failed to load headlines\.<\/p>/);
    assert.deepEqual(buttonNames(error), ["try again"]);
  });

  it("front.json alone is enough to render the page", () => {
    const { out, services } = render({ loaded: "front" });
    assert.equal(services.edition.get().status, "front");
    assert.equal(headings(out).filter((h) => h.id.endsWith("-heading")).length, SECTION_IDS.length);
    // Every section whose full list is longer than its homepage list links to it with the total from front.json.
    const longer = fixtureFront.sections.filter((s) => s.total > s.rows.length);
    assert.ok(longer.length >= 10);
    for (const s of longer) assert.ok(sectionMarkup(out, s.id).includes(`view all ${s.total}`), `${s.id}: view all ${s.total}`);
  });

  it("hidden sections are gone from the grid and offered again below it", () => {
    const { out } = render({ settings: { hiddenSections: ["robotics", "quantum"] } });
    assert.ok(!out.includes('id="sec-robotics"') && !out.includes('id="sec-quantum"'));
    assert.ok(out.includes('id="sec-models"'));
    assert.ok(out.includes("Hidden sections - show again:"));
    const names = buttonNames(out);
    assert.ok(names.includes("Show the ROBOTICS section again") && names.includes("Show the QUANTUM WATCH section again"));
    assert.ok(out.includes('<a href="#/settings">Settings</a>'));
    const cols = out.split('<div class="news-col">').slice(1).map((c) => [...c.matchAll(/data-section="([a-z_]+)"/g)].map((m) => m[1]));
    assert.deepEqual(cols, assignColumns([...SECTION_IDS], 3).map((c) => c.filter((id) => id !== "robotics" && id !== "quantum")), "nothing else moved");
  });

  it("reader order drives the grid", () => {
    const { out } = render({ settings: { sectionOrder: ["cyber", "ai_security", "policy"] } });
    const first = out.split('<div class="news-col">').slice(1).map((c) => /data-section="([a-z_]+)"/.exec(c)?.[1]);
    assert.deepEqual(first, ["cyber", "ai_security", "policy"]);
  });

  it("a collapsed section keeps its heading and drops its rows", () => {
    const { out } = render({ settings: { collapsed: ["models"] } });
    const html = sectionMarkup(out, "models");
    assert.ok(out.includes('id="sec-models"') && html.includes('id="models-heading"'));
    assert.deepEqual(rowIds(html), []);
    assert.match(html, /aria-expanded="false" aria-label="MODELS &amp; LABS headlines"/);
    assert.match(sectionMarkup(out, "industry"), /aria-expanded="true" aria-controls="industry-rows" aria-label="INDUSTRY headlines"/);
  });

  it("muted sources and sections are not rendered anywhere", () => {
    const base = createFakeServices();
    const edition = base.edition.get().edition!;
    const src = edition.articles[edition.leadId!].src;
    const { out } = render({ mutedSources: [src], mutedSections: ["cyber"] });
    const ids = rowIds(out);
    assert.ok(ids.length > 100);
    for (const id of ids) assert.notEqual(edition.articles[id].src, src, id);
    assert.ok(!out.includes('id="sec-cyber"'));
    assert.ok(!out.includes(`data-aid="${edition.leadId}"`));
  });

  it("the time chip filters every list on the page", () => {
    const { out, services } = render({ settings: { timeFilter: "6h" } });
    const edition = services.edition.get().edition!;
    const now = services.clock.get();
    const ids = rowIds(out);
    assert.ok(ids.length > 10);
    // A story is as new as its newest visible article (shared/select storyNewestMs).
    for (const id of ids) assert.ok(now - storyNewestMs(edition, id) <= 6 * HOUR_MS + 5 * 60_000, id);
    assert.ok(ids.some((id) => now - effectiveMs(edition.articles[id]) > 6 * HOUR_MS + 5 * 60_000), "the fixture has a story kept by an outlet that joined inside the window");
  });

  it("explains an empty page and offers the way out", () => {
    const old = [makeArticle({ publishedAt: hoursAgo(60) }), makeArticle({ publishedAt: hoursAgo(61) })];
    const built = makeEdition({ articles: old });
    const nowMs = Date.parse(hoursAgo(0));
    const filtered = render({ front: built.front, rest: built.rest, brief: null, nowMs, settings: { timeFilter: "6h" } }).out;
    assert.ok(filtered.includes("No headlines in this time window."));
    assert.ok(buttonNames(filtered).includes("show all headlines"));
    assert.ok(filtered.includes("No story in this time window is covered by more than one outlet."));
    const hidden = render({ front: built.front, rest: built.rest, brief: null, nowMs, settings: { hiddenSections: ["industry"] } }).out;
    assert.ok(hidden.includes("All sections are hidden."));
    assert.ok(buttonNames(hidden).includes("Show the INDUSTRY section again"));
  });

  it("lists watchlist hits of the page with a link to #/watch", () => {
    // A term the fixture's homepage carries in at least five headlines (whatever the news of the frozen day is).
    const term = commonTitleWord(homepageTitles(createFakeServices().edition.get().edition!));
    const { out } = render({ watchTerms: [term.word] });
    const box = out.slice(out.indexOf('<section class="home-watch"'), out.indexOf("</section>", out.indexOf('<section class="home-watch"')));
    assert.match(box, /<h2 class="section-heading" id="watch-hits"><a href="#\/watch">WATCHLIST<\/a> <span class="home-count heading-meta">\d+ on this page<\/span><\/h2>/);
    assert.ok(Number(/(\d+) on this page/.exec(box)?.[1]) >= 5);
    assert.equal(rowIds(box).length, 5, "the box lists five hits and links to the rest");
    assert.ok(box.includes('<mark class="hl-watch"'));
    assert.ok(!render().out.includes("home-watch"), "nothing while the watchlist is empty");
  });
});

// ------------------------------------------------------------------------------------------------
// Mounted in the fake DOM: the controls work
// ------------------------------------------------------------------------------------------------

const named = (nodes: FakeNode[], label: string): FakeNode => {
  const found = nodes.find((n) => (n.getAttribute("aria-label") ?? n.textContent) === label);
  assert.ok(found, `no control "${label}"`);
  return found;
};

describe("HomePage (mounted)", () => {
  it("hide, show again, collapse, phone disclosure and banner dismissal", async () => {
    const services = createFakeServices();
    const dom = await mountFakeDom();
    await dom.render(within(services, page()));
    const buttons = (): FakeNode[] => dom.all((n) => n.nodeName === "BUTTON");
    const columns = (): string[][] => dom.byClass("news-col").map((col) => col.childNodes.map((s) => s.getAttribute("data-section") ?? "?"));
    const before = columns();
    assert.deepEqual(before, assignColumns([...SECTION_IDS], 3));

    // Hide a section: only that section leaves; nothing reshuffles.
    await dom.click(named(buttons(), "Hide the INDUSTRY section"));
    assert.deepEqual(services.settings.get().hiddenSections, ["industry"]);
    assert.deepEqual(columns(), before.map((c) => c.filter((id) => id !== "industry")));
    await dom.click(named(buttons(), "Show the INDUSTRY section again"));
    assert.deepEqual(services.settings.get().hiddenSections, []);
    assert.deepEqual(columns(), before);

    // Collapse to the heading and back.
    const models = (): FakeNode => dom.all((n) => n.getAttribute("data-section") === "models")[0];
    const rowsOf = (section: FakeNode): number => dom.all((n) => n.getAttribute("data-aid") !== null && section.contains(n)).length;
    assert.equal(rowsOf(models()), 10);
    await dom.click(named(buttons(), "MODELS & LABS headlines"));
    assert.deepEqual(services.settings.get().collapsed, ["models"]);
    assert.equal(rowsOf(models()), 0);
    await dom.click(named(buttons(), "MODELS & LABS headlines"));
    assert.equal(rowsOf(models()), 10);

    // Phone "N more" disclosure flips the attribute the stylesheet keys on.
    const more = dom.all((n) => n.classNames.includes("home-more-btn") && models().contains(n))[0];
    assert.equal(more.textContent, "7 more");
    assert.equal(models().getAttribute("data-expanded"), null);
    await dom.click(more);
    assert.equal(models().getAttribute("data-expanded"), "true");
    assert.equal(more.getAttribute("aria-expanded"), "true");
    assert.equal(more.textContent, "show fewer");

    // The banner goes away for the session.
    assert.equal(dom.byClass("home-banner").length, 1);
    await dom.click(named(buttons(), "Dismiss the new stories notice"));
    assert.equal(dom.byClass("home-banner").length, 0);
    await dom.unmount();
  });

  it("asks for rest.json when only front.json is loaded", async () => {
    const services = createFakeServices({ loaded: "front" });
    const dom = await mountFakeDom();
    await dom.render(within(services, page()));
    assert.deepEqual(services.calls, [], "at defaults nothing on the page waits for rest: it is fetched at idle");
    // No requestIdleCallback in the fake window: the page falls back to a short timer.
    await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
    assert.deepEqual(services.calls, ["edition.loadRest"]);
    assert.equal(services.edition.get().status, "complete");
    await dom.unmount();
  });

  it("asks for rest.json at once when a time chip or a muted source makes the sections backfill from it", async () => {
    const muted = createFakeServices().edition.get().edition!.sections[0].rows[0];
    for (const opts of [{ settings: { timeFilter: "24h" } }, { mutedSources: [createFakeServices().edition.get().edition!.articles[muted].src] }] as FakeServicesOptions[]) {
      const services = createFakeServices({ loaded: "front", ...opts });
      const dom = await mountFakeDom();
      await dom.render(within(services, page()));
      assert.deepEqual(services.calls, ["edition.loadRest"], JSON.stringify(opts));
      await dom.unmount();
    }
  });

  it("LATEST does not change when rest.json arrives", async () => {
    const services = createFakeServices({ loaded: "front" });
    const dom = await mountFakeDom();
    await dom.render(within(services, page()));
    const latest = (): (string | null)[] => dom.all((n) => n.getAttribute("data-aid") !== null && dom.byClass("home-latest")[0].contains(n)).map((n) => n.getAttribute("data-aid"));
    const before = latest();
    assert.equal(before.length, 12);
    await dom.run(() => services.edition.loadRest());
    assert.equal(services.edition.get().status, "complete");
    assert.deepEqual(latest(), before);
    await dom.unmount();
  });

  it("phone layout mounts only the first three rows of a section until \"N more\" is used", async () => {
    const services = createFakeServices();
    const dom = await mountFakeDom();
    // A 375 px viewport: the grid has one column.
    const win = window as unknown as { innerWidth: number; matchMedia: (q: string) => unknown };
    win.innerWidth = 375;
    win.matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });
    await dom.render(within(services, page()));
    assert.equal(dom.byClass("news-col").length, 1);
    const edition = services.edition.get().edition!;
    const rowsIn = (section: FakeNode): number => dom.all((n) => n.getAttribute("data-aid") !== null && section.contains(n)).length;
    const sections = dom.byClass("home-section");
    assert.equal(sections.length, edition.sections.length);
    for (const s of sections) assert.ok(rowsIn(s) <= 3, `${s.getAttribute("data-section")} mounts ${rowsIn(s)} rows`);
    assert.equal(dom.byClass("home-row-extra").length, 0, "no row is mounted just to be hidden by CSS");

    const models = (): FakeNode => dom.all((n) => n.getAttribute("data-section") === "models")[0];
    const more = dom.all((n) => n.classNames.includes("home-more-btn") && models().contains(n))[0];
    assert.equal(more.textContent, "7 more");
    assert.ok(more.classNames.includes("home-always"), "the disclosure does not depend on the media query when rows are not mounted");
    await dom.click(more);
    assert.equal(rowsIn(models()), 10);
    assert.equal(more.textContent, "show fewer");
    assert.equal(models().getAttribute("data-expanded"), "true");
    // Other sections are untouched.
    assert.ok(sections.filter((s) => s.getAttribute("data-section") !== "models").every((s) => rowsIn(s) <= 3));
    await dom.click(more);
    assert.equal(rowsIn(models()), 3);
    await dom.unmount();
  });

  it("one hover-store update re-renders no headline row on the page", async () => {
    const services = createFakeServices();
    let rowRenders = 0;
    const wasSeen = services.readState.wasSeen;
    services.readState = { ...services.readState, wasSeen: (id) => (rowRenders++, wasSeen(id)) };
    const dom = await mountFakeDom();
    await dom.render(within(services, page()));
    const mounted = rowRenders;
    assert.ok(mounted > 150, `the page mounts every row once (${mounted})`);
    const id = services.edition.get().edition!.leadId!;
    await dom.run(() => services.hover.show(id, 100, 100));
    await dom.run(() => services.hover.hide());
    assert.equal(rowRenders, mounted);
    await dom.unmount();
  });
});
