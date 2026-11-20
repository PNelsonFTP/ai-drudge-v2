// Row geometry by computation from the stylesheets (no browser in the test run): the pitch of
// neighbouring headline links and the height of the small meta-line targets, against the 24 px of
// WCAG 2.2 SC 2.5.8 (Target Size, Minimum). Reads the real CSS, so a later edit that brings the
// rows closer together fails here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
const headline = read("src/features/headline/headline.css");
const base = read("src/styles/base.css");
const tokens = read("src/styles/tokens.css");

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  assert.ok(m, `no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1].split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

const px = (value: string | undefined): number => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? "");
  assert.ok(m, `not a px length: ${String(value)}`);
  return Number(m[1]);
};

const MIN = 24;
/** Title line of a row per density: body size x body leading (the title sets neither). */
const density = (name: "compact" | "comfortable"): { line: number; rowPad: number } => {
  const d = rule(base, `html[data-density="${name}"]`);
  return { line: px(d["--body-size"]) * Number(d["--body-leading"]), rowPad: px(d["--row-pad-y"]) };
};

describe("headline row geometry (WCAG 2.5.8, 24 px)", () => {
  it("the token is 24 px, 32 px on coarse pointers", () => {
    assert.match(tokens, /--target-min: 24px;/);
    assert.match(base, /@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--target-min: 32px/);
  });

  it("the title line is the body line: nothing in headline.css gives list titles their own size or leading", () => {
    assert.deepEqual(Object.keys(rule(headline, ".hl-title")), ["overflow-wrap"]);
    assert.equal(density("compact").line.toFixed(2), "17.55");
    assert.equal(density("comfortable").line.toFixed(2), "21.00");
  });

  it("one-line compact rows: headline links are at least 24 px apart, with or without a rule between rows", () => {
    const compact = rule(headline, ".hl-compact");
    const pad = px(compact["padding-block"]);
    for (const name of ["compact", "comfortable"] as const) {
      const natural = density(name).line + 2 * pad;
      // The lists draw a 1 px rule between rows (.sp-rows > * + *, .home-latest / .home-watch li + li).
      assert.ok(natural + 1 >= MIN, `${name}: ${natural + 1} px pitch inside a ruled list`);
    }
    assert.equal((density("compact").line + 2 * pad).toFixed(2), "23.55", "it was 21.55 with 2 px of padding");
    // Where no rule is drawn the row itself is at least one target high.
    assert.equal(compact["min-height"], "var(--target-min, 24px)");
    assert.equal(compact["align-content"], "center", "the title stays centred when min-height stretches the row (32 px on coarse pointers)");
    assert.match(read("src/features/export/kit/kit.css"), /\.sp-rows > \* \+ \* \{ border-top: 1px solid/);
    assert.match(read("src/features/home/home.css"), /\.home-latest \.home-rows > li \+ li,\s*\.home-watch \.home-rows > li \+ li \{\s*border-top: 1px dotted/);
  });

  it("default rows: two lines and the row padding put headline links 40 px apart", () => {
    const meta = rule(headline, ".hl-meta");
    const metaLine = Math.max(px(meta["font-size"]) * Number(meta["line-height"]), 14);
    for (const name of ["compact", "comfortable"] as const) {
      const d = density(name);
      const pitch = d.line + px(meta["margin-top"]) + metaLine + 2 * d.rowPad;
      assert.ok(pitch >= MIN + 16, `${name}: ${pitch.toFixed(2)} px`);
    }
    assert.equal(rule(headline, ".hl-row")["padding-block"], "var(--row-pad-y, 3px)");
  });

  it("meta-line targets are one target high without making the line taller: section chip, text buttons, action icons", () => {
    const chip = rule(headline, ".hl-section");
    assert.equal(chip["min-height"], "var(--target-min, 24px)");
    assert.equal(chip["margin-block"], "calc((14px - var(--target-min, 24px)) / 2)", "outer height 14 px: the meta line does not grow");
    assert.equal(chip.display, "inline-flex");
    // 9 px bold capitals with 0.04em tracking: the shortest chip codes (5 letters) are about 31 px wide.
    assert.equal(px(chip["padding-inline"]) + px(chip["margin-inline"]), 0, "the padding widens the target, not the layout");
    const act = rule(headline, ".hl-act");
    assert.equal(act["min-height"], chip["min-height"]);
    assert.equal(act["margin-block"], chip["margin-block"]);
    const text = rule(headline, ".hl-text-btn");
    const meta = rule(headline, ".hl-meta");
    const textHeight = px(meta["font-size"]) * Number(meta["line-height"]) + 2 * px(text.padding.split(" ")[0]);
    assert.ok(textHeight >= MIN, `${textHeight} px`);
  });
});
