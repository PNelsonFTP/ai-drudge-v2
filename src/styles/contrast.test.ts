// WCAG AA guard for the token file. Parses src/styles/tokens.css (values AND the "@contrast" pair
// declarations) and checks every pair in both themes: text >= 4.5, large text / UI >= 3.
// The V1 restyle shipped a 1.68:1 gold star and 1.16:1 dialogs with nothing to catch them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  composite,
  contrastRatio,
  evaluateRule,
  parseColor,
  readContrastExempt,
  readContrastRules,
  readThemes,
  resolveToken,
  tokenColor,
  type ContrastResult,
} from "./contrast";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(DIR, "tokens.css"), "utf8");
const themes = readThemes(css);
const rules = readContrastRules(css);

const describeResult = (r: ContrastResult): string =>
  `${r.theme}: ${r.rule.fg} on ${r.bg}${r.base ? ` over ${r.base}` : ""} = ${r.ratio.toFixed(2)}:1 (${r.rule.kind} needs ${r.min})`;

describe("contrast maths", () => {
  it("parses hex and rgb() colours", () => {
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor("#2f4e75"), { r: 47, g: 78, b: 117, a: 1 });
    assert.deepEqual(parseColor("rgba(255, 255, 255, 0.06)"), { r: 255, g: 255, b: 255, a: 0.06 });
    assert.deepEqual(parseColor("rgb(0 0 0 / 60%)"), { r: 0, g: 0, b: 0, a: 0.6 });
    assert.equal(parseColor("#00000080")?.a.toFixed(2), "0.50");
    assert.equal(parseColor("1500px"), null);
    assert.equal(parseColor("Arial, Helvetica, sans-serif"), null);
  });

  it("matches the reference ratios of the review (black/white 21, link 7.25, V1 gold star 1.68)", () => {
    const c = (hex: string) => parseColor(hex)!;
    assert.equal(contrastRatio(c("#000"), c("#fff")).toFixed(2), "21.00");
    assert.equal(contrastRatio(c("#00589f"), c("#ffffff")).toFixed(2), "7.25");
    assert.equal(contrastRatio(c("#edc339"), c("#ffffff")).toFixed(2), "1.68");
    assert.equal(contrastRatio(c("#5a6470"), c("#ffffff")).toFixed(2), "6.01");
    // The V1 dialog bug: body text on the undefined-variable fallback.
    assert.equal(contrastRatio(c("#000000"), c("#161616")).toFixed(2), "1.16");
  });

  it("composites translucent colours before measuring", () => {
    const over = composite(parseColor("rgba(255,255,255,0.5)")!, parseColor("#000")!);
    assert.deepEqual({ r: Math.round(over.r), g: Math.round(over.g), b: Math.round(over.b) }, { r: 128, g: 128, b: 128 });
  });

  it("resolves var() references and fallbacks", () => {
    assert.equal(resolveToken({ "--a": "var(--b)", "--b": "#123456" }, "--a"), "#123456");
    assert.equal(resolveToken({ "--a": "var(--missing, #abcdef)" }, "--a"), "#abcdef");
    assert.equal(resolveToken({ "--a": "var(--missing)" }, "--a"), null);
  });
});

describe("tokens.css", () => {
  it("declares both themes and keeps every V1 custom property", () => {
    const v1 = [
      "--font-sans", "--ft-navy", "--ft-navy-dark", "--ft-navy-deep", "--ft-gold", "--ft-orange", "--ft-blue", "--siren", "--siren-dim",
      "--accent", "--gold", "--color-bg", "--color-surface", "--color-fg", "--color-muted", "--color-line", "--color-line-soft",
      "--color-link", "--color-up", "--color-down", "--page-bg", "--page-stripe", "--shell-max", "--silver-top", "--silver-bot",
      "--menu-top", "--menu-bot",
    ];
    for (const name of v1) assert.ok(name in themes.light, `missing V1 token ${name}`);
    // The dark overrides V1 had (plus --accent, which V1 forgot).
    for (const name of ["--color-bg", "--color-fg", "--color-muted", "--color-link", "--siren", "--page-bg", "--silver-top", "--menu-top", "--ft-navy-deep", "--accent"]) {
      assert.notEqual(themes.dark[name], themes.light[name], `${name} must differ in dark`);
    }
  });

  it("keeps the navy / gold identity colours byte-identical to V1", () => {
    const identity: Record<string, string> = {
      "--ft-navy": "#2f4e75", "--ft-navy-dark": "#243b5a", "--ft-navy-deep": "#002f5d", "--ft-gold": "#edc339", "--siren": "#cc0000",
      "--color-bg": "#ffffff", "--color-fg": "#000000", "--color-link": "#00589f", "--page-bg": "#eeeeee", "--font-sans": "Arial, Helvetica, sans-serif",
    };
    for (const [name, value] of Object.entries(identity)) assert.equal(themes.light[name], value, name);
    assert.equal(themes.dark["--color-bg"], "#0e1b2a");
    assert.equal(themes.dark["--ft-gold"], "#edc339");
  });

  it("declares a healthy number of contrast pairs", () => {
    assert.ok(rules.length >= 35, `only ${rules.length} @contrast rules parsed`);
    for (const r of rules) assert.ok(r.on.length > 0, `${r.fg}: no backgrounds`);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`every declared text/background pair meets WCAG AA in the ${theme} theme`, () => {
      const results = rules.flatMap((rule) => evaluateRule(themes[theme], rule, theme));
      assert.ok(results.length >= 80, `only ${results.length} pairs evaluated`);
      const failures = results.filter((r) => !r.pass).map(describeResult);
      assert.deepEqual(failures, []);
    });
  }

  it("every colour token is covered by a pair or explicitly exempt", () => {
    const used = new Set<string>([...rules.flatMap((r) => [r.fg, ...r.on, ...r.over]), ...readContrastExempt(css)]);
    const uncovered = Object.keys(themes.light).filter((name) => tokenColor(themes.light, name) !== null && !used.has(name));
    assert.deepEqual(uncovered, []);
    for (const name of used) assert.ok(name in themes.light, `@contrast mentions undeclared token ${name}`);
  });

  it("every dark override names a token that exists in the light theme", () => {
    for (const name of Object.keys(themes.dark)) assert.ok(name in themes.light, `${name} is only defined for dark`);
  });

  it("defines muted text that passes on every surface it is used on (the opacity-utility replacement)", () => {
    for (const theme of ["light", "dark"] as const) {
      const t = themes[theme];
      const ratio = (fg: string, bg: string): number => contrastRatio(tokenColor(t, fg)!, tokenColor(t, bg)!);
      assert.ok(ratio("--color-muted", "--color-bg") >= 4.5, `${theme} muted on bg`);
      assert.ok(ratio("--color-muted", "--color-surface") >= 4.5, `${theme} muted on surface`);
      assert.ok(ratio("--color-seen", "--color-bg") >= 4.5, `${theme} seen on bg`);
      assert.ok(ratio("--dialog-fg", "--dialog-bg") >= 7, `${theme} dialog text (V1 was 1.16:1 in light)`);
    }
  });
});
