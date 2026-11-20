import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { alsoOutlets } from "../../../shared/select";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { ServicesContext } from "../../app/services";
import { mountFakeDom } from "./fakeDom.testkit";
import { setHoverAnchor } from "./hoverAnchor";
import { HoverCard, hoverCardPlacement } from "./HoverCard";

describe("HoverCard", () => {
  it("opens below the row and is kept inside the viewport sideways", () => {
    // row 170..200 at x = 100, viewport 1280 x 800
    assert.deepEqual(hoverCardPlacement(100, 170, 200, 1280, 800), { left: 100, top: 206 });
    assert.deepEqual(hoverCardPlacement(1200, 170, 200, 1280, 800), { left: 930, top: 206 }, "clamped at the right edge");
    assert.deepEqual(hoverCardPlacement(-50, 170, 200, 1280, 800), { left: 10, top: 206 }, "clamped at the left edge");
    assert.deepEqual(hoverCardPlacement(100, 484, 514, 1280, 800), { left: 100, top: 520 }, "the last position a full-height card fits below");
  });

  it("flips above the row when there is no room below; it never covers the row", () => {
    // One pixel lower than the last "below" position: anchored by its bottom edge, 6 px over the row.
    assert.deepEqual(hoverCardPlacement(100, 485, 515, 1280, 800), { left: 100, bottom: 321 });
    assert.deepEqual(hoverCardPlacement(100, 760, 790, 1280, 800), { left: 100, bottom: 46 });
    // No placement overlaps the row, wherever the row is (viewport 1366 x 768, 30 px rows).
    for (let top = 0; top <= 768 - 30; top += 7) {
      const p = hoverCardPlacement(100, top, top + 30, 1366, 768);
      assert.ok(p, `a 768 px window always has room on one side (row at ${top})`);
      if (p.top !== undefined) assert.ok(p.top >= top + 30, `below the row at ${top}`);
      else assert.ok(768 - (p.bottom as number) <= top, `above the row at ${top}`);
    }
  });

  it("in a short window it takes the roomier side with a capped height, or stays away", () => {
    // 400 px high: neither side holds 270 px. Row 100..130 -> 254 px below; row 250..280 -> 234 px above.
    assert.deepEqual(hoverCardPlacement(100, 100, 130, 1280, 400), { left: 100, top: 136, maxHeight: 254 });
    assert.deepEqual(hoverCardPlacement(100, 250, 280, 1280, 400), { left: 100, bottom: 156, maxHeight: 234 });
    // A row taller than the window leaves no usable room: no card (the summary is inline anyway).
    assert.equal(hoverCardPlacement(100, 20, 380, 1280, 400), null);
  });

  it("renders nothing while nothing is hovered (and nothing on the server)", () => {
    const services = createFakeServices();
    assert.equal(renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(HoverCard))), "");
  });

  it("shows the hovered story once, however many cards are mounted; hidden from assistive tech", async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition!;
    const id = edition.leadId!;
    const a = edition.articles[id];
    const dom = await mountFakeDom();
    // The home page mounts one; the shell may mount another.
    await dom.render(createElement(ServicesContext.Provider, { value: services }, createElement(HoverCard), createElement(HoverCard)));
    assert.equal(dom.byClass("hover-card").length, 0);

    await dom.run(() => services.hover.show(id, 100, 200));
    const cards = dom.byClass("hover-card");
    assert.equal(cards.length, 1, "only one instance renders");
    const card = cards[0];
    assert.equal(card.getAttribute("aria-hidden"), "true");
    assert.ok(card.textContent.includes(a.title));
    assert.ok(card.textContent.includes(a.summary ?? ""));
    assert.ok(card.textContent.includes("Also covered by:"));
    const links = dom.all((n) => n.nodeName === "A" && card.contains(n));
    assert.deepEqual(links.map((n) => n.getAttribute("href")), alsoOutlets(edition, id).slice(0, 6).map((o) => o.article.url));
    assert.ok(links.every((n) => n.getAttribute("tabindex") === "-1" && n.getAttribute("rel") === "noopener noreferrer"));

    assert.deepEqual({ ...card.style }, { left: "100px", top: "206px" }, "below the anchor point");

    await dom.run(() => services.hover.show("not-in-the-edition", 1, 1));
    assert.equal(dom.byClass("hover-card").length, 0);

    // Without a row anchor the point itself is the anchor: near the bottom the card sits above it.
    await dom.run(() => services.hover.show(id, 100, 700));
    assert.deepEqual({ ...dom.byClass("hover-card")[0].style }, { left: "100px", bottom: "106px" });
    // With the row's top recorded, the card clears the whole row.
    await dom.run(() => {
      setHoverAnchor({ id, x: 100, y: 701, top: 650 });
      services.hover.show(id, 100, 701);
    });
    assert.deepEqual({ ...dom.byClass("hover-card")[0].style }, { left: "100px", bottom: "156px" });
    setHoverAnchor(null);
    // Moving to a row higher up re-uses the card: the stale `bottom` is cleared.
    await dom.run(() => services.hover.show(id, 100, 200));
    assert.deepEqual({ ...dom.byClass("hover-card")[0].style }, { left: "100px", top: "206px", bottom: "" });
    await dom.run(() => services.hover.show(id, 100, 200));
    await dom.run(() => services.hover.hide());
    assert.equal(dom.byClass("hover-card").length, 0);
    await dom.unmount();
  });

  it("the remaining card takes over when the owner unmounts", async () => {
    const services = createFakeServices();
    const id = services.edition.get().edition!.leadId!;
    const dom = await mountFakeDom();
    const tree = (both: boolean) =>
      createElement(ServicesContext.Provider, { value: services }, both ? createElement(HoverCard, { key: "home" }) : null, createElement(HoverCard, { key: "shell" }));
    await dom.render(tree(true));
    await dom.run(() => services.hover.show(id, 100, 200));
    assert.equal(dom.byClass("hover-card").length, 1);
    await dom.render(tree(false));
    assert.equal(dom.byClass("hover-card").length, 1, "the shell's card now renders");
    await dom.unmount();
  });
});
