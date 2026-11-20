import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOUR_MS, timeAgo } from "../../../shared/time";
import { createFakeServices, type FakeServices } from "../../../test/helpers/fakeServices";
import { a11yProblems, countOf, hrefsOf, renderRoute, tagTexts, textOf } from "../export/kit/ssr.testkit";
import { PAGE_ROW_BUDGET } from "../export/kit/rows";
import { NewPage } from "./NewPage";
import { markAllSeen } from "./markAllSeen";

describe("new-since-last-visit page (SSR)", () => {
  it("waits for the river", () => {
    const html = renderRoute(createFakeServices(), NewPage, { name: "new" });
    assert.deepEqual(tagTexts(html, "h2"), ["New since your last visit"]);
    assert.match(html, /role="status"[^>]*>Loading the 7-day archive…/);
    assert.deepEqual(a11yProblems(html), []);
  });

  /** The page for a reader whose previous visit was `hours` ago (river loaded), and its story total. */
  async function visited(hours: number): Promise<{ s: FakeServices; html: string; total: number; sinceMs: number }> {
    const now = createFakeServices().clock.get();
    const s = createFakeServices({ previousVisitMs: now - hours * HOUR_MS });
    await s.edition.loadRiver();
    const html = renderRoute(s, NewPage, { name: "new" });
    return { s, html, total: Number(/^New since your last visit (\d+) stor(y|ies)$/.exec(tagTexts(html, "h2")[0])?.[1]), sinceMs: now - hours * HOUR_MS };
  }

  it("lists new stories by section with counts, a since-time and 'mark all seen'", async () => {
    // How long the reader was away is chosen from the fixture: long enough for more new stories
    // than one page renders (a busy day needs 12 hours, a quiet one two days).
    let page = await visited(6);
    for (const hours of [12, 24, 48, 96]) if (page.total <= PAGE_ROW_BUDGET) page = await visited(hours);
    const { s, html, total, sinceMs } = page;
    assert.ok(total > PAGE_ROW_BUDGET, "the fixture has more new stories in four days than one page renders");
    // One page-level row budget; the heading and the group badges keep the true counts.
    assert.equal(countOf(html, "data-aid="), PAGE_ROW_BUDGET);
    const h3 = tagTexts(html, "h3");
    assert.ok(h3.length >= 5);
    // Groups past the budget are not rendered, so the badges on screen add up to something between the two.
    const badgeSum = h3.reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1]), 0);
    assert.ok(badgeSum >= PAGE_ROW_BUDGET && badgeSum <= total, `${badgeSum}`);
    assert.ok(tagTexts(html, "button").includes(`Show all ${total} stories`));
    assert.match(textOf(html), new RegExp(`Showing the first ${PAGE_ROW_BUDGET} of ${total} stories, in section order\\. “Mark all seen” applies to all ${total}\\.`));
    assert.ok(tagTexts(html, "button").includes("Mark all seen"));
    assert.ok(html.toLowerCase().includes(`<time datetime="${new Date(sinceMs).toISOString().toLowerCase()}">`));
    const ago = timeAgo(new Date(sinceMs).toISOString(), s.clock.get());
    assert.match(ago, /^\d+[hd] ago$/);
    assert.ok(new RegExp(`stories first seen since .+ \\(${ago}\\) \\. \\d+ of them are no longer on the home page\\.`).test(textOf(html)), textOf(html).slice(0, 400));
    assert.ok(hrefsOf(html).includes("#/s/industry"));
    assert.match(html, /role="status" aria-live="polite">\d+ new stories</);
    assert.deepEqual(a11yProblems(html), []);
  });

  it("first visit: says so and shows the last 24 hours", async () => {
    const s = createFakeServices({ previousVisitMs: null });
    await s.edition.loadRiver();
    const text = textOf(renderRoute(s, NewPage, { name: "new" }));
    assert.match(text, /This looks like your first visit, so this page shows the last 24 hours\./);
    assert.match(text, /\(1d ago\)/);
  });

  it("after 'mark all seen' the page is caught up and links home", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    markAllSeen(s, ["x"], s.clock.get());
    const html = renderRoute(s, NewPage, { name: "new" });
    assert.deepEqual(tagTexts(html, "h2"), ["New since your last visit 0 stories"]);
    assert.match(textOf(html), /You are all caught up\./);
    assert.match(textOf(html), /A new edition is built about every 30 minutes\./, "same cadence as the About page");
    assert.equal(countOf(html, "data-aid="), 0);
    assert.match(html, /aria-disabled="true"[^>]*>Mark all seen/);
    assert.ok(hrefsOf(html).includes("#/"));
  });

  it("a list within the row budget is rendered whole, with no 'show all'", async () => {
    const s = createFakeServices();
    await s.edition.loadRiver();
    const recent = createFakeServices({ previousVisitMs: s.clock.get() - HOUR_MS });
    await recent.edition.loadRiver();
    const html = renderRoute(recent, NewPage, { name: "new" });
    const total = Number(/^New since your last visit (\d+) stor(y|ies)$/.exec(tagTexts(html, "h2")[0])?.[1]);
    assert.ok(total > 0 && total <= PAGE_ROW_BUDGET);
    assert.equal(countOf(html, "data-aid="), total);
    assert.equal(tagTexts(html, "h3").reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1]), 0), total);
    assert.ok(!tagTexts(html, "button").some((b) => b.startsWith("Show all")));
  });

  it("a recent previous visit narrows the list", async () => {
    const all = createFakeServices();
    await all.edition.loadRiver();
    const recent = createFakeServices({ previousVisitMs: all.clock.get() - HOUR_MS });
    await recent.edition.loadRiver();
    assert.ok(countOf(renderRoute(recent, NewPage, { name: "new" }), "data-aid=") < countOf(renderRoute(all, NewPage, { name: "new" }), "data-aid="));
  });
});
