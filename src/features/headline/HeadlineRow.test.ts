import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Profiler, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArticleV2 } from "../../../shared/contract";
import { alsoOutlets, publisherName, sourceName, visibleStory, weightClass, type Edition } from "../../../shared/select";
import { hoursAgo, makeArticle, makeEdition, makeSourceRef } from "../../../test/helpers/factories";
import { createFakeServices, type FakeServices } from "../../../test/helpers/fakeServices";
import { storyWhere } from "../../../test/helpers/fixtureCases";
import { fixtureStory } from "../../../test/helpers/fixtureData";
import { ServicesContext, type HeadlineRowProps, type RowItem } from "../../app/services";
import { mountFakeDom, type FakeNode } from "./fakeDom.testkit";
import { HeadlineRow, StoryRow } from "./HeadlineRow";
import { HoverCard } from "./HoverCard";
import { ROW_ACTION_EVENT } from "./rowActions";

const within = (services: FakeServices, element: ReactElement): ReactElement => createElement(ServicesContext.Provider, { value: services }, element);
const html = (services: FakeServices, props: HeadlineRowProps): string => renderToStaticMarkup(within(services, createElement(HeadlineRow, props)));

const strip = (s: string): string => s.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();

/** Every <button>: its accessible name (aria-label, else its text). */
export function buttonNames(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[1])?.[1] ?? strip(m[2]));
}

/** Every <a>: its href ("" when missing). */
export function linkHrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b([^>]*)>/g)].map((m) => /href="([^"]*)"/.exec(m[1])?.[1] ?? "");
}

function assertAccessible(markup: string): void {
  const names = buttonNames(markup);
  assert.ok(names.every((n) => n.length > 0), `a button has no accessible name: ${JSON.stringify(names)}`);
  const hrefs = linkHrefs(markup);
  assert.ok(hrefs.every((h) => /^https?:\/\//.test(h) || h.startsWith("#/")), `a link has no usable href: ${JSON.stringify(hrefs)}`);
  for (const m of markup.matchAll(/<a\b([^>]*)>/g)) {
    if (/target="_blank"/.test(m[1])) assert.match(m[1], /rel="noopener noreferrer"/);
  }
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Outlets the Also: line lists before "Show N more outlets". */
const ALSO_LIMIT = 8;

/**
 * A fixture story for the row tests, selected by property (the fixture is a frozen live build that
 * is replaced now and then - never pin its ids or headlines): a TOP STORY whose other outlets all
 * fit the Also: line (2 to 8 of them) and whose lead has a summary.
 */
function midSizeStory(edition: Edition): string {
  return storyWhere(edition, "TOP STORY with 2-8 other outlets and a summary", (st) => {
    const others = alsoOutlets(edition, st.key).length;
    return st.top >= 0 && others >= 2 && others <= ALSO_LIMIT && st.publishers - 1 === others && !!st.lead.summary;
  }).key;
}
/** Services over a small factory-built edition. */
function servicesFor(articles: ArticleV2[], opts: Parameters<typeof makeEdition>[0] extends infer S ? Partial<S> : never = {}, extra: Parameters<typeof createFakeServices>[0] = {}): FakeServices {
  const built = makeEdition({ articles, ...opts });
  return createFakeServices({ front: built.front, rest: built.rest, brief: null, ...extra });
}

describe("HeadlineRow (static markup)", () => {
  it("default variant: title link, source, time, coverage and summary disclosures, row menu", () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = midSizeStory(edition);
    const a = edition.articles[id];
    const out = html(services, { id });

    assert.match(out, new RegExp(`^<div class="hl-row hl-default[^"]*" data-aid="${id}" data-variant="default">`));
    assert.ok(out.includes(`<a class="hl-title headline ${weightClass(a)}" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" data-row-link="">`), out);
    assert.ok(out.includes(`<span class="source-badge">${escapeHtml(a.pub ?? sourceName(edition, a.src))}</span>`), out);
    assert.match(out, /<time class="hl-time" dateTime="[^"]+"|<time class="hl-time" datetime="[^"]+"/);

    const extra = edition.clusters[id].publishers - 1;
    assert.match(out, new RegExp(`<button type="button" class="related-badge hl-more" data-row-action="also" aria-expanded="false" aria-label="\\+${extra} more outlets covering: [^"]+"[^>]*>\\+${extra}</button>`));
    assert.match(out, /<button type="button" class="hl-text-btn hl-summary-btn" data-row-action="summary" aria-expanded="false" aria-label="Summary: [^"]+">summary<\/button>/);
    assert.ok(!out.includes("hl-summary\""), "the summary is collapsed until asked for");
    assert.ok(!out.includes("hl-also"), "the Also: line is collapsed until asked for");

    // At rest the row carries three controls; the four actions render when the menu opens, on
    // hover or on focus (see the mounted tests).
    const names = buttonNames(out);
    assert.deepEqual(names.map((n) => n.split(":")[0]), [`+${extra} more outlets covering`, "Summary", "More actions"]);
    assert.match(out, /class="hl-act icon-btn hl-menu-btn" aria-expanded="false" aria-controls="([^"]+)"[\s\S]*<span id="\1" class="hl-act-group" role="group" aria-label="Story actions"><\/span>/);
    // Keyboard contract: the s / a keys click these; o / b / l / m are the shell's own defaults.
    assert.match(out, /data-aid="[^"]+"/);
    assert.deepEqual([...out.matchAll(/data-row-action="([a-z]+)"/g)].map((m) => m[1]), ["also", "summary"]);
    assert.equal([...out.matchAll(/data-row-link=""/g)].length, 1);
    assertAccessible(out);
  });

  it("maps the story-size weight to the headline classes", () => {
    const articles = [makeArticle({ w: 0 }), makeArticle(), makeArticle({ w: 2 }), makeArticle({ w: 3 })];
    const services = servicesFor(articles);
    const classes = articles.map((a) => /class="hl-title headline (headline-[a-z]+)"/.exec(html(services, { id: a.id }))?.[1]);
    assert.deepEqual(classes, ["headline-low", "headline-medium", "headline-high", "headline-critical"]);
  });

  it("shows the outlet for link-host items and the source name otherwise", () => {
    const viaAggregator = makeArticle({ src: "google-news-ai", pub: "Reuters" });
    const direct = makeArticle({ src: "techcrunch-ai" });
    const services = servicesFor([viaAggregator, direct], {
      sources: { "google-news-ai": makeSourceRef({ name: "Google News: AI", publisher: "Google News", kind: "query" }), "techcrunch-ai": makeSourceRef({ name: "TechCrunch AI", publisher: "TechCrunch" }) },
    });
    assert.ok(html(services, { id: viaAggregator.id }).includes('<span class="source-badge">Reuters</span>'));
    assert.ok(html(services, { id: direct.id }).includes('<span class="source-badge">TechCrunch AI</span>'));
  });

  it("NEW needs first-seen under 6 h AND not seen before; seen rows are dimmed instead", () => {
    const fresh = makeArticle({ publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2) });
    const redated = makeArticle({ publishedAt: hoursAgo(1), firstSeenAt: hoursAgo(9) });
    const old = makeArticle({ publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const nowMs = Date.parse(hoursAgo(0));
    const services = servicesFor([fresh, redated, old], {}, { nowMs });
    assert.ok(html(services, { id: fresh.id }).includes('<span class="hl-new new-badge"'));
    assert.ok(!html(services, { id: redated.id }).includes("hl-new"), "published 1 h ago but known for 9 h is not NEW");
    assert.ok(!html(services, { id: old.id }).includes("hl-new"));

    const seen = servicesFor([fresh], {}, { nowMs, seen: [fresh.id] });
    const out = html(seen, { id: fresh.id });
    assert.ok(!out.includes("hl-new"), "seen in a previous session is not NEW");
    assert.match(out, /class="hl-row hl-default is-seen"/);
    assert.match(out, /class="hl-title headline headline-medium headline-seen"/);
  });

  it("seen-dimming is for list rows only: the lead, TOP STORIES and the saved lists keep their weight and colour", () => {
    const big = makeArticle({ w: 3, publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2) });
    const services = servicesFor([big], {}, { nowMs: Date.parse(hoursAgo(0)), seen: [big.id] });
    const story = (variant: "top" | "lead"): string => renderToStaticMarkup(within(services, createElement(StoryRow, { id: big.id, variant })));
    for (const [variant, out] of [["top", story("top")], ["lead", story("lead")], ["saved", html(services, { id: big.id, variant: "saved" })]] as const) {
      assert.ok(!out.includes("is-seen"), `${variant}: no is-seen on the row`);
      assert.ok(!out.includes("headline-seen"), `${variant}: no headline-seen on the title`);
      assert.match(out, /class="hl-title headline (lead-title )?headline-critical"/, `${variant}: keeps its weight class`);
      assert.ok(!out.includes("hl-new"), `${variant}: a story seen before is still not NEW`);
    }
    // The ordinary and the compact row keep the dimming.
    for (const variant of ["default", "compact"] as const) {
      const out = html(services, { id: big.id, variant });
      assert.match(out, new RegExp(`class="hl-row hl-${variant} is-seen"`));
      assert.match(out, /class="hl-title headline headline-critical headline-seen"/);
    }
  });

  it("'Dim headlines I have seen' off: a seen row keeps its weight and colour; absent or true dims it", () => {
    const a = makeArticle({ publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2) });
    const low = makeArticle({ publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2), tier: 4, w: 0 });
    const nowMs = Date.parse(hoursAgo(0));
    const row = (dimSeen: boolean | undefined, id = a.id, variant: HeadlineRowProps["variant"] = "default"): string =>
      html(servicesFor([a, low], {}, { nowMs, seen: [a.id, low.id], settings: dimSeen === undefined ? {} : { dimSeen } }), { id, variant });
    for (const on of [undefined, true]) {
      assert.match(row(on), /class="hl-row hl-default is-seen"/, `dimSeen ${String(on)}`);
      assert.match(row(on), /class="hl-title headline headline-medium headline-seen"/);
    }
    for (const variant of ["default", "compact"] as const) {
      const off = row(false, a.id, variant);
      assert.ok(!off.includes("is-seen") && !off.includes("headline-seen"), `${variant}: not dimmed`);
      assert.ok(off.includes('class="hl-title headline headline-medium"'));
      assert.ok(!off.includes("hl-new"), "a story seen before is still not NEW");
    }
    // With dimming off, grey is left to mean one thing: the low-tier class (italic in headline.css).
    assert.ok(row(false, low.id).includes('class="hl-title headline headline-low"'));
    assert.ok(row(true, low.id).includes('class="hl-title headline headline-low headline-seen"'));
  });

  it("a story an outlet joined later says so next to its time: 'latest ...' (the time chips keep it by that time)", () => {
    const nowMs = Date.parse(hoursAgo(0));
    const lead = makeArticle({ title: "Lab prices its IPO", src: "lab", publishedAt: hoursAgo(38), firstSeenAt: hoursAgo(38) });
    const early = makeArticle({ title: "IPO priced", src: "press", publishedAt: hoursAgo(37.5), firstSeenAt: hoursAgo(37) });
    const late = makeArticle({ title: "Shares jump on debut", src: "wire", publishedAt: hoursAgo(0.9), firstSeenAt: hoursAgo(0.8) });
    const quiet = makeArticle({ title: "A story nobody followed up", src: "press", publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const twin = makeArticle({ title: "Same story, minutes later", src: "wire", publishedAt: hoursAgo(29.8), firstSeenAt: hoursAgo(29.8) });
    const single = makeArticle({ title: "A singleton", src: "press", publishedAt: hoursAgo(5), firstSeenAt: hoursAgo(5) });
    const sameDay = makeArticle({ title: "This morning's story", src: "press", publishedAt: hoursAgo(18), firstSeenAt: hoursAgo(18) });
    const sameDayTwin = makeArticle({ title: "This morning's story, ten hours on", src: "wire2", publishedAt: hoursAgo(8), firstSeenAt: hoursAgo(8) });
    const opts = { clusters: { [lead.id]: [early.id, late.id], [quiet.id]: [twin.id], [sameDay.id]: [sameDayTwin.id] }, rows: { industry: [lead.id, quiet.id, single.id, sameDay.id] } };
    const all = [lead, early, late, quiet, twin, single, sameDay, sameDayTwin];
    const services = servicesFor(all, opts, { nowMs });
    const latest = (out: string): string | undefined => /<span class="hl-latest" title="[^"]+">latest <time dateTime="([^"]+)">([^<]+)<\/time><\/span>/i.exec(out)?.slice(1).join(" ");
    for (const variant of ["default", "compact", "top"] as const) {
      const out = html(services, { id: lead.id, variant });
      assert.match(out, />1d ago<\/time>/, `${variant}: the lead's own time stays`);
      assert.equal(latest(out), `${hoursAgo(0.9)} 54m ago`, variant);
    }
    assert.equal(latest(html(services, { id: quiet.id })), undefined, "an outlet 12 minutes later is not news");
    assert.equal(latest(html(services, { id: single.id })), undefined);
    assert.equal(latest(html(services, { id: sameDay.id })), undefined, "18 h and 8 h are the same chip window: no second time on the row");
    // Muting the outlet that joined last: the story is as old as the rest of it again.
    const muted = servicesFor(all, opts, { nowMs, mutedSources: ["wire"] });
    assert.equal(latest(html(muted, { id: lead.id })), undefined);
    // A saved row shows exactly what was saved.
    assert.equal(latest(html(services, { id: lead.id, variant: "saved" })), undefined);
    assertAccessible(html(services, { id: lead.id }));
  });

  it("does not tag rows by age: there is no stale dimming in V2", () => {
    const old = makeArticle({ publishedAt: hoursAgo(200), firstSeenAt: hoursAgo(200) });
    const out = html(servicesFor([old], {}, { nowMs: Date.parse(hoursAgo(0)) }), { id: old.id });
    assert.match(out, /^<div class="hl-row hl-default" /);
  });

  it("shows release / paper / paywall flags as text labels", () => {
    const a = makeArticle({ flags: ["release", "paper", "paywall"] });
    const out = html(servicesFor([a]), { id: a.id });
    for (const label of ["release", "paper", "paywall"]) assert.ok(out.includes(`<span class="hl-flag hl-flag-${label}"`) && out.includes(`>${label}</span>`), label);
  });

  it("highlights watchlist terms in the title", () => {
    const a = makeArticle({ title: "Qwen 4 ships with open weights" });
    const out = html(servicesFor([a], {}, { watchTerms: ["Qwen", "open weights"] }), { id: a.id });
    assert.ok(out.includes('<mark class="hl-watch" title="Watchlist: Qwen">Qwen</mark> 4 ships with <mark class="hl-watch" title="Watchlist: open weights">open weights</mark>'), out);
    assert.ok(!html(servicesFor([a]), { id: a.id }).includes("<mark"), "no marks without watch terms");
  });

  it("showSection adds a link to the section page", () => {
    const a = makeArticle({ home: "policy" });
    const out = html(servicesFor([a]), { id: a.id, showSection: true });
    assert.ok(out.includes('<a class="hl-section" href="#/s/policy">POLICY</a>'), out);
    assert.ok(!html(servicesFor([a]), { id: a.id }).includes("hl-section"));
  });

  it("compact variant renders a river item that is not in the edition", () => {
    const services = createFakeServices();
    const item: RowItem = { id: "zz9zz9", title: "Only in the river", url: "https://example.org/river", sourceName: "Example Wire", sourceId: "example-wire", publishedAt: hoursAgo(3), firstSeenAt: hoursAgo(3), section: "tools" };
    const out = html(services, { id: item.id, item, variant: "compact", showSection: true });
    assert.match(out, /^<div class="hl-row hl-compact[^"]*" data-aid="zz9zz9" data-variant="compact">/);
    assert.ok(out.includes('<a class="hl-title headline headline-medium" href="https://example.org/river" target="_blank" rel="noopener noreferrer" data-row-link="">Only in the river</a>'));
    assert.ok(out.includes('<span class="source-badge">Example Wire</span>'));
    assert.ok(out.includes('href="#/s/tools"'));
    assert.ok(!out.includes("hl-summary-btn") && !out.includes("hl-more"), "no summary / coverage controls without data");
    assert.deepEqual(buttonNames(out), ["More actions: Only in the river"]);
    assertAccessible(out);
  });

  it("a bookmarked / read-later row keeps its star and clock visible", () => {
    const a = makeArticle();
    const out = html(servicesFor([a], {}, { bookmarks: [a.id], later: [a.id] }), { id: a.id });
    assert.match(out, /class="hl-act icon-btn hl-act-bookmark" tabindex="-1" aria-pressed="true" aria-label="Bookmark: /);
    assert.match(out, /class="hl-act icon-btn later hl-act-later" tabindex="-1" aria-pressed="true" aria-label="Read later: /);
    assert.ok(!out.includes("hl-act-mute") && !out.includes("hl-act-copy"));
    assertAccessible(out);
  });

  it("saved variant shows a remove button, for snapshots too", () => {
    const services = createFakeServices({ route: { name: "saved", tab: "later" } });
    const item: RowItem = { id: "old123", title: "Aged out of the edition", url: "https://example.org/old", sourceName: "Example Wire", publishedAt: hoursAgo(400) };
    const out = html(services, { id: item.id, item, variant: "saved" });
    assert.ok(buttonNames(out).includes("Remove from saved: Aged out of the edition"));
    assert.match(out, /data-variant="saved"/);
    assertAccessible(out);
  });

  it("top variant shows the outlet count and an inline Also: line of linked outlets", () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = midSizeStory(edition);
    const out = html(services, { id, variant: "top" });
    assert.ok(out.includes(`${edition.clusters[id].publishers} outlets</span>`));
    assert.ok(!out.includes("hl-more"), "no +N button: the line is already open");
    const also = /<p class="hl-also">([\s\S]*?)<\/p>/.exec(out)?.[1] ?? "";
    assert.ok(also.includes('<span class="hl-also-label">Also:</span>'));
    const outlets = alsoOutlets(edition, id);
    assert.ok(outlets.length > 0);
    for (const o of outlets) assert.ok(also.includes(`href="${escapeHtml(o.article.url)}"`) && also.includes(`>${escapeHtml(o.name)}</a>`), `${o.name} is not linked in: ${also}`);
    assert.equal(linkHrefs(also).length, outlets.length);
    assertAccessible(out);
  });

  it("a story with more outlets than the Also: line holds (the fixture's 8+ publisher story) lists 8 and offers the rest", () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = fixtureStory("weight3");
    const a = edition.articles[id];
    const outlets = alsoOutlets(edition, id);
    assert.ok(outlets.length > ALSO_LIMIT, "fixture: the w = 3 story has more than 8 other outlets");
    const out = html(services, { id, variant: "top" });
    assert.ok(out.includes(`class="hl-title headline ${weightClass(a)}"`) && weightClass(a) === "headline-critical", "w = 3 is the critical headline class");
    assert.ok(out.includes(`${edition.clusters[id].publishers} outlets</span>`));
    const also = /<p class="hl-also">([\s\S]*?)<\/p>/.exec(out)?.[1] ?? "";
    assert.deepEqual(linkHrefs(also), outlets.slice(0, ALSO_LIMIT).map((o) => escapeHtml(o.article.url)));
    assert.ok(buttonNames(out).includes(`Show ${outlets.length - ALSO_LIMIT} more outlets`), buttonNames(out).join(" | "));
    // Each outlet once, by publisher name, never the lead's own.
    assert.equal(new Set(outlets.map((o) => o.name)).size, outlets.length);
    assert.ok(!outlets.some((o) => o.name === publisherName(edition, a)));
    assertAccessible(out);
  });

  it("fixture rows by kind: a paywalled row says so, a low-tier row is the low class, a newsletter row is an ordinary row", () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;

    const paywalled = html(services, { id: fixtureStory("paywalledRow") });
    assert.match(paywalled, /<span class="hl-flag hl-flag-paywall" title="This source usually requires a subscription">paywall<\/span>/);
    assertAccessible(paywalled);

    const lowId = fixtureStory("weight0");
    const low = html(services, { id: lowId });
    assert.ok(low.includes('class="hl-title headline headline-low"'), low);
    assert.ok(!low.includes("hl-more"), "a single low-tier outlet: no coverage button");

    const letterId = fixtureStory("newsletterRow");
    const letter = html(services, { id: letterId });
    assert.ok(letter.includes(`<span class="source-badge">${escapeHtml(sourceName(edition, edition.articles[letterId].src))}</span>`), letter);
    assert.ok(letter.includes(`class="hl-title headline ${weightClass(edition.articles[letterId])}"`));

    const release = html(services, { id: fixtureStory("releaseRow") });
    assert.match(release, /<span class="hl-flag hl-flag-release"[^>]*>release<\/span>/);
    const thread = html(services, { id: fixtureStory("discussionRow") });
    assert.match(thread, /<span class="hl-flag hl-flag-discussion"[^>]*>thread<\/span>/);

    const plainId = fixtureStory("singletonWithSummary");
    const plain = html(services, { id: plainId });
    assert.ok(!plain.includes("hl-more") && plain.includes("hl-summary-btn"), "one outlet with a summary: the summary button only");
  });

  it("the Also: line shows 8 outlets and offers the rest", () => {
    const lead = makeArticle({ src: "lead-source" });
    const members = Array.from({ length: 11 }, (_, i) => makeArticle({ src: `outlet-${i}` }));
    const services = servicesFor([lead, ...members], { clusters: { [lead.id]: members.map((m) => m.id) }, top: [lead.id], rows: { industry: [lead.id] } });
    const out = html(services, { id: lead.id, variant: "top" });
    assert.equal(linkHrefs(/<p class="hl-also">([\s\S]*?)<\/p>/.exec(out)?.[1] ?? "").length, 8);
    assert.ok(buttonNames(out).includes("Show 3 more outlets"));
    assert.ok(out.includes("12 outlets</span>"));
  });

  it("lead variant (TOP STORIES lead) shows the summary and the Also: line without a click", () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = fixtureStory("multiPublisherLead");
    assert.equal(id, edition.leadId);
    const out = renderToStaticMarkup(within(services, createElement(StoryRow, { id, variant: "lead" })));
    assert.ok(out.includes(`class="hl-title headline lead-title ${weightClass(edition.articles[id])}"`), out);
    assert.ok(out.includes(`<p class="hl-summary">${escapeHtml(edition.articles[id].summary ?? "")}</p>`), out);
    assert.ok(out.includes('<p class="hl-summary">'));
    assert.ok(out.includes('<p class="hl-also">'));
    assert.ok(!out.includes("hl-summary-btn"));
    assertAccessible(out);
  });

  it("never links to a URL that is not http(s)", () => {
    const services = createFakeServices();
    const item: RowItem = { id: "bad001", title: "Imported from a tampered backup", url: "javascript:alert(document.cookie)", sourceName: "Unknown", publishedAt: null };
    const out = html(services, { id: item.id, item, variant: "saved" });
    assert.ok(!out.includes("javascript:"));
    assert.ok(out.includes('<span class="hl-title headline headline-medium">Imported from a tampered backup</span>'));
    assert.ok(!buttonNames(out).some((n) => n.startsWith("Copy link")));
  });

  it("renders nothing for an unknown id without a fallback item", () => {
    assert.equal(html(createFakeServices(), { id: "nope00" }), "");
  });

  it("a muted source is shown as muted where the row is still listed", () => {
    const a = makeArticle({ src: "noisy-wire" });
    const out = html(servicesFor([a], {}, { mutedSources: ["noisy-wire"] }), { id: a.id, variant: "saved" });
    assert.match(out, /class="hl-act icon-btn hl-act-mute" tabindex="-1" aria-pressed="true" aria-label="Mute source: Noisy Wire"/);
    assert.match(out, /class="hl-row hl-saved is-muted"/);
  });

  it("the outlet count and the Also: line agree: counted outlets first, the rest under 'also linked' (live: '7 outlets' then ten names)", () => {
    const lead = makeArticle({ title: "Lab introduces its new model", src: "lab-news", publishedAt: hoursAgo(3) });
    const press = makeArticle({ title: "New model lands", src: "press-wire", publishedAt: hoursAgo(2) });
    const pointer = makeArticle({ title: "Lab ships a model (aggregator)", src: "aggregator", publishedAt: hoursAgo(2) });
    const rewrite = makeArticle({ title: "Model shipped, says lab", src: "unvetted", publishedAt: hoursAgo(1) });
    const sources = {
      "lab-news": makeSourceRef({ name: "Lab News", publisher: "Lab" }),
      "press-wire": makeSourceRef({ name: "Press Wire", publisher: "Press Wire" }),
      aggregator: makeSourceRef({ name: "Aggregator", publisher: "Aggregator" }),
      unvetted: makeSourceRef({ name: "GN query", publisher: "Some Outlet" }),
    };
    // Two publishers count (the lab and the wire); the pointer and the unvetted outlet are members that do not.
    const counted = servicesFor([lead, press, pointer, rewrite], { clusters: { [lead.id]: { members: [press.id, pointer.id, rewrite.id], publishers: 2 } }, top: [lead.id], rows: { industry: [lead.id] }, sources });
    const top = html(counted, { id: lead.id, variant: "top" });
    assert.ok(top.includes("2 outlets</span>"));
    const also = /<p class="hl-also">([\s\S]*?)<\/p>/.exec(top)?.[1] ?? "";
    assert.equal(strip(also).replace(/\s+/g, " "), "Also: Press Wire · also linked: Aggregator · Some Outlet");
    assert.deepEqual(linkHrefs(also), [press.url, pointer.url, rewrite.url], "every outlet is still linked");
    assertAccessible(top);
    // A list row: "+1" is the one counted outlet, and the expanded line draws the same split.
    assert.match(html(counted, { id: lead.id }), /aria-label="\+1 more outlet covering: Lab introduces its new model"/);
  });

  it("a story with ONE counted publisher still offers its other links without a mouse (live: a Politico pointer reachable by hover only)", () => {
    const lead = makeArticle({ title: "Lawmakers launch new AI safety caucus", src: "the-record", publishedAt: hoursAgo(5) });
    const pointer = makeArticle({ title: "House lawmakers form the AI Safety Caucus", src: "aggregator", publishedAt: hoursAgo(7) });
    const sources = { "the-record": makeSourceRef({ name: "The Record", publisher: "The Record" }), aggregator: makeSourceRef({ name: "Aggregator", publisher: "Politico" }) };
    const services = servicesFor([lead, pointer], { clusters: { [lead.id]: { members: [pointer.id], publishers: 1 } }, rows: { policy: [lead.id] }, sources });
    const row = html(services, { id: lead.id });
    assert.ok(buttonNames(row).includes("Other outlets linking: Lawmakers launch new AI safety caucus"), JSON.stringify(buttonNames(row)));
    assert.match(row, /data-row-action="also"[^>]*aria-expanded="false"/);
    assert.ok(!/\+\d/.test(strip(/<button[^>]*data-row-action="also"[^>]*>([\s\S]*?)<\/button>/.exec(row)?.[1] ?? "")), "no count is claimed");
    // TOP / lead rows draw the line at once: no badge (one publisher), the link under "Also linked:".
    const top = html(services, { id: lead.id, variant: "top" });
    assert.ok(!top.includes("outlets</span>"));
    const also = /<p class="hl-also">([\s\S]*?)<\/p>/.exec(top)?.[1] ?? "";
    assert.equal(strip(also).replace(/\s+/g, " "), "Also linked: Politico");
    assert.deepEqual(linkHrefs(also), [pointer.url]);
    // A singleton has no such button.
    const solo = makeArticle({ title: "Solo story", src: "the-record" });
    assert.ok(!html(servicesFor([solo], { sources }), { id: solo.id }).includes('data-row-action="also"'));
  });

  it("muting the outlet that leads a story hands the row to the next outlet; the story key stays for Also:", () => {
    const lead = makeArticle({ title: "Changelog: new model available", src: "vendor-changelog", publishedAt: hoursAgo(1) });
    const first = makeArticle({ title: "Lab introduces its new model", src: "lab-news", publishedAt: hoursAgo(3), summary: "First-party post." });
    const press = makeArticle({ title: "New model lands", src: "press-wire", publishedAt: hoursAgo(2) });
    const opts = {
      clusters: { [lead.id]: [first.id, press.id] },
      top: [lead.id],
      rows: { industry: [lead.id] },
      sources: {
        "vendor-changelog": makeSourceRef({ name: "Vendor Changelog", publisher: "Vendor" }),
        "lab-news": makeSourceRef({ name: "Lab News", publisher: "Lab" }),
        "press-wire": makeSourceRef({ name: "Press Wire", publisher: "Press Wire" }),
      },
    };
    const plain = html(servicesFor([lead, first, press], opts), { id: lead.id, variant: "top" });
    assert.ok(plain.includes(`data-aid="${lead.id}"`) && plain.includes("3 outlets</span>"));

    const muted = servicesFor([lead, first, press], opts, { mutedSources: ["vendor-changelog"] });
    const out = renderToStaticMarkup(within(muted, createElement(StoryRow, { id: lead.id, variant: "top" })));
    assert.ok(out.includes(`data-aid="${first.id}"`), "the row acts on the article it displays");
    assert.ok(out.includes(`href="${first.url}"`) && out.includes("Lab introduces its new model"));
    assert.ok(out.includes('<span class="source-badge">Lab News</span>'));
    assert.ok(!out.includes("Changelog: new model available") && !out.includes(lead.url), "nothing of the muted outlet is rendered");
    assert.ok(!out.includes("is-muted"), "the displayed outlet is not muted");
    assert.ok(out.includes("2 outlets</span>"), "outlets are recounted without the muted one");
    const also = /<p class="hl-also">([\s\S]*?)<\/p>/.exec(out)?.[1] ?? "";
    assert.deepEqual(linkHrefs(also), [press.url], "Also: lists the remaining outlet only");
    assertAccessible(out);

    // List rows too: "+1" for the one other outlet.
    assert.match(html(muted, { id: lead.id }), /aria-label="\+1 more outlet covering: Lab introduces its new model"/);
    // A muted MEMBER leaves the lead alone and lowers the count: "+1" matches the one outlet "Also:" can list.
    const memberMuted = servicesFor([lead, first, press], opts, { mutedSources: ["press-wire"] });
    const listRow = html(memberMuted, { id: lead.id });
    assert.ok(listRow.includes(`data-aid="${lead.id}"`) && listRow.includes("Changelog: new model available"));
    assert.match(listRow, /aria-label="\+1 more outlet covering: Changelog: new model available"/, "it used to say +2 with one outlet left to show");
    assert.ok(html(memberMuted, { id: lead.id, variant: "top" }).includes("2 outlets</span>"));
    assert.match(html(servicesFor([lead, first, press], opts), { id: lead.id }), /aria-label="\+2 more outlets covering: /);
    // Every outlet muted: the lists drop the story; a row rendered anyway shows the original article.
    const all = servicesFor([lead, first, press], opts, { mutedSources: ["vendor-changelog", "lab-news", "press-wire"] });
    assert.ok(html(all, { id: lead.id }).includes("Changelog: new model available"));
  });
});

// ------------------------------------------------------------------------------------------------
// Client rendering in the fake DOM: re-renders and interactions
// ------------------------------------------------------------------------------------------------

/** React's own measurement: commits in which something under the Profiler rendered. */
function counted(element: ReactElement): { element: ReactElement; commits: () => number } {
  let n = 0;
  return { element: createElement(Profiler, { id: "row", onRender: () => void n++ }, element), commits: () => n };
}

/** Renders of the row body: it reads readState.wasSeen exactly once per render. */
function countRowRenders(services: FakeServices): () => number {
  let n = 0;
  const wasSeen = services.readState.wasSeen;
  services.readState = {
    ...services.readState,
    wasSeen: (id) => {
      n++;
      return wasSeen(id);
    },
  };
  return () => n;
}

const button = (nodes: FakeNode[], labelPrefix: string): FakeNode => {
  const found = nodes.find((n) => (n.getAttribute("aria-label") ?? n.textContent).startsWith(labelPrefix));
  assert.ok(found, `no button "${labelPrefix}…"`);
  return found;
};
const buttons = (dom: { all(match: (n: FakeNode) => boolean): FakeNode[] }): FakeNode[] => dom.all((n) => n.nodeName === "BUTTON");

describe("HeadlineRow (mounted)", () => {
  it("memoisation: a hover-store update does not re-render the row, nor does the state of other rows", async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = edition.leadId!;
    const other = edition.top[1];
    const item: RowItem = { id, title: "t", url: "https://example.org/x", sourceName: "s", publishedAt: null };
    const renders = countRowRenders(services);
    const dom = await mountFakeDom();
    const probe = counted(createElement(HeadlineRow, { id, item: { ...item } }));
    await dom.render(within(services, probe.element));
    assert.equal(probe.commits(), 1);
    assert.equal(renders(), 1);
    assert.ok(dom.text().includes(edition.articles[id].title));

    await dom.run(() => services.hover.show(id, 10, 20));
    await dom.run(() => services.hover.show(other, 30, 40));
    await dom.run(() => services.hover.hide());
    assert.equal(probe.commits(), 1, "hover-store updates must not re-render the row");
    assert.equal(renders(), 1, "hover-store updates must not re-render the row");

    await dom.run(() => services.focus.set(id));
    await dom.run(() => services.settings.set("theme", "dark"));
    await dom.run(() => services.saved.toggleBookmark(edition.articles[other], "x"));
    await dom.run(() => services.mutes.toggleSource("some-other-source"));
    assert.equal(probe.commits(), 1, "state of OTHER rows must not re-render this row");
    assert.equal(renders(), 1);
    await dom.unmount();
  });

  it("memoisation: equal props skip the render, the clock re-renders only when the label changes", async () => {
    const a = makeArticle({ publishedAt: hoursAgo(30), firstSeenAt: hoursAgo(30) });
    const services = servicesFor([a], {}, { nowMs: Date.parse(hoursAgo(0)) });
    const renders = countRowRenders(services);
    const dom = await mountFakeDom();
    // A fresh element, a fresh wrapper and a fresh (but equal) `item` object on every parent render.
    const tree = (): ReactElement => within(services, createElement("div", null, createElement(HeadlineRow, { id: a.id, item: { id: a.id, title: "x", url: a.url, sourceName: "s", publishedAt: null } })));
    await dom.render(tree());
    assert.equal(renders(), 1);
    await dom.render(tree());
    await dom.render(tree());
    assert.equal(renders(), 1, "a re-rendering parent with equal props does not re-render the row");

    const now = services.clock.get();
    await dom.run(() => services.setNow(now + 60_000));
    await dom.run(() => services.setNow(now + 120_000));
    assert.equal(renders(), 1, '"1d ago" is still "1d ago" two minutes later');
    assert.ok(dom.text().includes("1d ago"));
    await dom.run(() => services.setNow(now + 20 * 3_600_000));
    assert.equal(renders(), 2, "the label changed");
    assert.ok(dom.text().includes("2d ago"));

    await dom.run(() => services.saved.toggleBookmark(a, "Example Source"));
    assert.equal(renders(), 3, "its own bookmark state re-renders it");
    await dom.unmount();
  });

  it("the +N button and the summary button expand inline, by click", async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = midSizeStory(edition);
    const a = edition.articles[id];
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement(HeadlineRow, { id })));
    assert.equal(dom.byClass("hl-also").length, 0);
    assert.equal(dom.byClass("hl-summary").length, 0);

    const more = dom.byClass("hl-more")[0];
    await dom.click(more);
    assert.equal(more.getAttribute("aria-expanded"), "true");
    const also = dom.byClass("hl-also")[0];
    assert.equal(more.getAttribute("aria-controls"), also.getAttribute("id"));
    const outlets = alsoOutlets(edition, id);
    const links = also.childNodes.filter((n) => n.nodeName === "A");
    assert.deepEqual(links.map((n) => n.textContent), outlets.map((o) => o.name));
    assert.deepEqual(links.map((n) => n.getAttribute("href")), outlets.map((o) => o.article.url));

    const summaryBtn = dom.byClass("hl-summary-btn")[0];
    await dom.click(summaryBtn);
    assert.equal(summaryBtn.getAttribute("aria-expanded"), "true");
    const summary = dom.byClass("hl-summary")[0];
    assert.equal(summary.textContent, a.summary);
    assert.equal(summaryBtn.getAttribute("aria-controls"), summary.getAttribute("id"));

    await dom.click(more);
    await dom.click(summaryBtn);
    assert.equal(dom.byClass("hl-also").length + dom.byClass("hl-summary").length, 0, "both collapse again");
    await dom.unmount();
  });

  it("row menu: opens from its button; bookmark, read later and mute call the stores", async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = midSizeStory(edition);
    const a = edition.articles[id];
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement(HeadlineRow, { id })));

    const menu = button(buttons(dom), "More actions: ");
    const actions = dom.byClass("hl-actions")[0];
    assert.equal(actions.getAttribute("data-open"), null);
    assert.equal(dom.byClass("hl-act").length, 1, "closed: the menu button is the only action control in the DOM");
    await dom.click(menu);
    assert.equal(menu.getAttribute("aria-expanded"), "true");
    assert.equal(actions.getAttribute("data-open"), "true");
    const group = dom.byClass("hl-act-group")[0];
    assert.equal(menu.getAttribute("aria-controls"), group.getAttribute("id"));
    assert.deepEqual(
      group.childNodes.map((n) => (n.getAttribute("aria-label") ?? "").split(":")[0]),
      ["Bookmark", "Read later", "Mute source", "Copy link"],
    );
    assert.ok(buttons(dom).every((n) => (n.getAttribute("aria-label") ?? n.textContent).length > 0));
    assert.deepEqual(dom.byClass("hl-act").map((n) => n.getAttribute("tabindex")), [null, null, null, null, null], "open: the actions are Tab stops");

    const bookmark = button(buttons(dom), "Bookmark: ");
    await dom.click(bookmark);
    assert.equal(bookmark.getAttribute("aria-pressed"), "true");
    assert.ok(services.saved.get().bookmarks.has(id));
    assert.equal(services.saved.get().snapshots[id].sourceName, a.pub ?? sourceName(edition, a.src));

    const later = button(buttons(dom), "Read later: ");
    await dom.click(later);
    assert.equal(later.getAttribute("aria-pressed"), "true");
    await dom.click(later);
    assert.equal(later.getAttribute("aria-pressed"), "false");

    await dom.click(button(buttons(dom), "Mute source: "));
    assert.ok(services.mutes.get().sources.has(a.src));
    assert.deepEqual(services.calls, [`saved.toggleBookmark ${id}`, `saved.toggleLater ${id}`, `saved.toggleLater ${id}`, `mutes.toggleSource ${a.src}`]);
    await dom.unmount();
  });

  it("a river row can be saved and muted from its menu; no mute without a source id", async () => {
    const services = createFakeServices();
    const item: RowItem = { id: "zz9zz9", title: "Only in the river", url: "https://example.org/river", sourceName: "Example Wire", sourceId: "example-wire", publishedAt: hoursAgo(3), section: "tools" };
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement("div", null, createElement(HeadlineRow, { id: item.id, item, variant: "compact" }), createElement(HeadlineRow, { id: "yy8yy8", item: { ...item, id: "yy8yy8", sourceId: undefined }, variant: "compact" }))));
    const [withSource, withoutSource] = buttons(dom).filter((n) => (n.getAttribute("aria-label") ?? "").startsWith("More actions: "));
    await dom.click(withSource);
    await dom.click(withoutSource);
    const groups = dom.byClass("hl-act-group").map((g) => g.childNodes.map((n) => (n.getAttribute("aria-label") ?? "").split(":")[0]));
    assert.deepEqual(groups, [["Bookmark", "Read later", "Mute source", "Copy link"], ["Bookmark", "Read later", "Copy link"]]);

    await dom.click(button(buttons(dom), "Bookmark: "));
    assert.deepEqual(services.saved.get().snapshots[item.id], { id: item.id, title: item.title, url: item.url, sourceName: "Example Wire", publishedAt: item.publishedAt, savedAt: new Date(services.clock.get()).toISOString() });
    await dom.click(button(buttons(dom), "Mute source: Example Wire"));
    assert.ok(services.mutes.get().sources.has("example-wire"));
    await dom.unmount();
  });

  it("registers with the seen-observer once and releases it on unmount (both release styles)", async () => {
    const id = createFakeServices().edition.get().edition!.leadId!;
    for (const style of ["contract", "cleanup"] as const) {
      const services = createFakeServices();
      const log: string[] = [];
      services.readState = {
        ...services.readState,
        observe: ((el: Element | null, rid: string) => {
          log.push(`${el ? "observe" : "release-by-id"} ${rid}`);
          return style === "cleanup" && el ? () => void log.push(`cleanup ${rid}`) : undefined;
        }) as typeof services.readState.observe,
      };
      const dom = await mountFakeDom();
      await dom.render(within(services, createElement(HeadlineRow, { id })));
      await dom.run(() => services.setNow(services.clock.get() + 30 * 3_600_000));
      await dom.click(dom.byClass("hl-summary-btn")[0]);
      assert.deepEqual(log, [`observe ${id}`], "re-renders do not re-observe");
      await dom.render(within(services, null as unknown as ReactElement));
      assert.deepEqual(log, [`observe ${id}`, style === "cleanup" ? `cleanup ${id}` : `release-by-id ${id}`], style);
      await dom.unmount();
    }
  });

  it("opening the link marks the story seen and calls onOpen", async () => {
    const services = createFakeServices();
    const id = services.edition.get().edition!.leadId!;
    let opened = 0;
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement(HeadlineRow, { id, onOpen: () => void opened++ })));
    await dom.click(dom.byClass("hl-title")[0]);
    assert.equal(opened, 1);
    assert.deepEqual(services.calls, [`readState.markSeen ${id}`]);
    await dom.unmount();
  });

  it("only a middle-button auxclick counts as opening; a right-click does not", async () => {
    const services = createFakeServices();
    const id = services.edition.get().edition!.leadId!;
    let opened = 0;
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement(HeadlineRow, { id, onOpen: () => void opened++ })));
    const title = dom.byClass("hl-title")[0];
    await dom.fire(title, "auxclick", { button: 2 });
    assert.equal(opened, 0, "the context-menu button must not consume a Read later item");
    assert.deepEqual(services.calls, [], "nor mark the story seen");
    await dom.fire(title, "auxclick", { button: 1 });
    assert.equal(opened, 1);
    assert.deepEqual(services.calls, [`readState.markSeen ${id}`]);
    await dom.unmount();
  });

  it("hovering the title anchors the hover card to the ROW (left edge, bottom edge), not to the title", async () => {
    const services = createFakeServices();
    const id = services.edition.get().edition!.leadId!;
    const dom = await mountFakeDom();
    (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({ matches: true });
    await dom.render(within(services, createElement("div", null, createElement(HeadlineRow, { id }), createElement(HoverCard))));
    const row = dom.all((n) => n.getAttribute("data-aid") === id)[0];
    const title = dom.byClass("hl-title")[0];
    title.rect = { left: 40, top: 500, right: 300, bottom: 516, width: 260, height: 16 };

    // Room below: the card opens under the row's meta line, not under the title.
    row.rect = { left: 40, top: 300, right: 400, bottom: 332, width: 360, height: 32 };
    await dom.fire(title, "mouseover");
    assert.deepEqual(services.hover.get(), { id, x: 40, y: 332 });
    assert.deepEqual({ ...dom.byClass("hover-card")[0].style }, { left: "40px", top: "338px" });
    await dom.run(() => services.hover.hide());

    // Near the bottom of the 800 px window: the card flips ABOVE the row instead of covering it.
    row.rect = { left: 40, top: 700, right: 400, bottom: 732, width: 360, height: 32 };
    await dom.fire(title, "mouseover");
    assert.deepEqual(services.hover.get(), { id, x: 40, y: 732 });
    assert.deepEqual({ ...dom.byClass("hover-card")[0].style }, { left: "40px", bottom: "106px" });
    await dom.unmount();
  });

  it("the hover card of a re-led row shows the outlet on display and still lists the other outlets", async () => {
    const lead = makeArticle({ title: "Changelog: new model available", src: "vendor-changelog", publishedAt: hoursAgo(1), summary: "Changelog entry." });
    const first = makeArticle({ title: "Lab introduces its new model", src: "lab-news", publishedAt: hoursAgo(3) });
    const press = makeArticle({ title: "New model lands", src: "press-wire", publishedAt: hoursAgo(2) });
    const wire = makeArticle({ title: "Model released, says wire", src: "wire", publishedAt: hoursAgo(2.5) });
    const services = servicesFor(
      [lead, first, press, wire],
      {
        clusters: { [lead.id]: [first.id, press.id, wire.id] },
        rows: { industry: [lead.id] },
        sources: {
          "vendor-changelog": makeSourceRef({ name: "Vendor Changelog", publisher: "Vendor" }),
          "lab-news": makeSourceRef({ name: "Lab News", publisher: "Lab" }),
          "press-wire": makeSourceRef({ name: "Press Wire", publisher: "Press Wire" }),
          wire: makeSourceRef({ name: "Wire", publisher: "Wire" }),
        },
      },
      { mutedSources: ["vendor-changelog"] },
    );
    const dom = await mountFakeDom();
    (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({ matches: true });
    await dom.render(within(services, createElement("div", null, createElement(HeadlineRow, { id: lead.id }), createElement(HoverCard))));
    const row = dom.all((n) => n.getAttribute("data-aid") === first.id)[0];
    assert.ok(row, "the row displays the next outlet's article");
    row.rect = { left: 40, top: 300, right: 400, bottom: 332, width: 360, height: 32 };
    await dom.fire(dom.byClass("hl-title")[0], "mouseover");
    assert.deepEqual(services.hover.get(), { id: lead.id, x: 40, y: 332 }, "the card is addressed by the story key");
    const card = dom.byClass("hover-card")[0];
    assert.ok(card.textContent.includes("Lab introduces its new model") && card.textContent.includes("Lab News"), "the article on display");
    assert.ok(!card.textContent.includes("Changelog"), "nothing of the muted outlet");
    assert.ok(card.textContent.includes("Also covered by:"), "the re-led row's card used to have no outlet list");
    const links = dom.all((n) => n.nodeName === "A" && card.contains(n));
    assert.deepEqual(links.map((n) => n.getAttribute("href")), [press.url, wire.url]);
    await dom.run(() => services.hover.hide());

    // Addressed without a row anchor (same story key): the card works the displayed article out itself.
    await dom.run(() => services.hover.show(lead.id, 5, 6));
    assert.ok(dom.byClass("hover-card")[0].textContent.includes("Lab introduces its new model"));
    // Unmuted again: the pipeline's lead and all three other outlets.
    await dom.run(() => services.mutes.toggleSource("vendor-changelog"));
    const plain = dom.byClass("hover-card")[0];
    assert.ok(plain.textContent.includes("Changelog: new model available") && plain.textContent.includes("Changelog entry."));
    assert.equal(dom.all((n) => n.nodeName === "A" && plain.contains(n)).length, 3);
    await dom.unmount();
  });

  it("saved variant: remove takes the story off the tab of the current route", async () => {
    const services = createFakeServices({ route: { name: "saved", tab: "later" } });
    const id = services.edition.get().edition!.leadId!;
    const dom = await mountFakeDom();
    await dom.render(within(services, createElement(HeadlineRow, { id, variant: "saved" })));
    await dom.click(button(buttons(dom), "Remove from saved: "));
    assert.deepEqual(services.calls, [`saved.remove later ${id}`]);
    await dom.unmount();
  });

  it(`by-id actions: "${ROW_ACTION_EVENT}" events on document drive the row, once per story`, async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = edition.leadId!;
    const dom = await mountFakeDom();
    // The same story listed twice (it can sit in two sections).
    await dom.render(within(services, createElement("div", null, createElement(HeadlineRow, { id }), createElement(HeadlineRow, { id }))));
    const send = (detail: unknown): Promise<void> => dom.run(() => void document.dispatchEvent(new CustomEvent(ROW_ACTION_EVENT, { detail })));

    await send({ id, action: "summary" });
    assert.equal(dom.byClass("hl-summary").length, 1, "one instance expands");
    await send({ id, action: "a" });
    assert.equal(dom.byClass("hl-also").length, 1);
    await send({ id, action: "b" });
    await send({ id, action: "l" });
    await send({ id, action: "m" });
    await send({ id: "not-on-this-page", action: "b" });
    await send({ id, action: "unknown-action" });
    await send("garbage");
    assert.deepEqual(services.calls, [`saved.toggleBookmark ${id}`, `saved.toggleLater ${id}`, `mutes.toggleSource ${edition.articles[id].src}`]);

    // The source that leads the story is now muted: both instances display the next outlet's
    // article (and act on it) until it is unmuted.
    const promoted = visibleStory(edition, id, services.mutes.get())?.lead.id;
    assert.ok(promoted && promoted !== id);
    assert.equal(dom.all((n) => n.getAttribute("data-aid") === promoted).length, 2);
    assert.equal(dom.all((n) => n.getAttribute("data-aid") === id).length, 0);
    await dom.run(() => services.mutes.toggleSource(edition.articles[id].src));

    // An element hint picks the instance.
    const rows = dom.all((n) => n.getAttribute("data-aid") === id);
    assert.equal(rows.length, 2);
    await send({ id, action: "menu", el: rows[1] });
    assert.deepEqual(dom.byClass("hl-actions").map((n) => n.getAttribute("data-open")), [null, "true"]);

    // "open" clicks the real link: same path as a mouse click.
    services.calls.length = 0;
    await send({ id, action: "o" });
    assert.deepEqual(services.calls, [`readState.markSeen ${id}`]);

    // A handled event is cancelled; one for a story that is not on the page is left alone.
    const handled = new CustomEvent(ROW_ACTION_EVENT, { cancelable: true, detail: { id, action: "summary" } });
    const unhandled = new CustomEvent(ROW_ACTION_EVENT, { cancelable: true, detail: { id: "not-on-this-page", action: "summary" } });
    await dom.run(() => void document.dispatchEvent(handled));
    await dom.run(() => void document.dispatchEvent(unhandled));
    assert.deepEqual([handled.defaultPrevented, unhandled.defaultPrevented], [true, false]);
    await dom.unmount();
  });
});
