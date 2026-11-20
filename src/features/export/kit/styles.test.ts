// Guards for the WP10 stylesheets and markup, from the review's a11y findings: the V1 dialogs used
// an undefined custom property with a dark literal fallback (black on #161616 in the light theme),
// and 43 colour pairs failed AA because of stacked opacity utilities.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, readThemes, tokenColor, type TokenMap } from "../../../styles/contrast";

const FEATURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.resolve(FEATURES, "..");
const OWNED = ["section", "search", "new", "watch", "saved", "sources", "settings", "about", "export"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const files = OWNED.flatMap((d) => walk(path.join(FEATURES, d)));
const cssFiles = files.filter((f) => f.endsWith(".css"));
const tsxFiles = files.filter((f) => f.endsWith(".tsx"));
const rel = (f: string): string => path.relative(FEATURES, f);
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties of the shell (src/styles/tokens.css). */
function declaredTokens(): Set<string> {
  const out = new Set<string>();
  for (const m of fs.readFileSync(path.join(SRC, "styles", "tokens.css"), "utf8").matchAll(/(?:^|[\s;{])(--[a-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

describe("WP10 styles", () => {
  it("there is a shared stylesheet and it is plain CSS", () => {
    assert.ok(cssFiles.some((f) => f.endsWith(path.join("export", "kit", "kit.css"))));
    for (const f of cssFiles) assert.ok(!/@apply|@import|@tailwind/.test(stripComments(fs.readFileSync(f, "utf8"))), `${rel(f)} needs no CSS preprocessing`);
  });

  it("every custom property used is a declared theme token (V1 used an undefined --bg)", () => {
    const tokens = declaredTokens();
    for (const f of [...cssFiles, ...tsxFiles]) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(tokens.has(m[1]), `${rel(f)} uses undeclared ${m[1]}`);
    }
  });

  it("var() never carries a literal fallback, and no selector is left unprefixed", () => {
    for (const f of cssFiles) {
      const css = stripComments(fs.readFileSync(f, "utf8"));
      assert.ok(!/var\(--[a-z0-9-]+\s*,/.test(css), `${rel(f)}: var() with a fallback hides a missing token`);
      for (const m of css.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
        const selector = m[2].trim();
        if (/^(from|to|\d+%)/.test(selector)) continue;
        assert.ok(/\.sp-|::highlight\(sp-/.test(selector), `${rel(f)}: selector "${selector}" must be scoped to an sp- class`);
      }
    }
  });

  it("colours come from tokens: the only literals are white-on-navy, the gold highlight and shadows", () => {
    const allowed = new Set(["#fff", "rgb(237 195 57 / 0.45)", "rgb(0 0 0 / 0.25)", "rgb(0 0 0 / 0.6)"]);
    for (const f of cssFiles) {
      const css = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) assert.ok(allowed.has(m[0]), `${rel(f)}: colour literal ${m[0]}`);
    }
  });

  it("no opacity on text or controls (muted text uses the muted token)", () => {
    for (const f of cssFiles) assert.ok(!/(^|[\s;{])opacity\s*:/.test(stripComments(fs.readFileSync(f, "utf8"))), `${rel(f)} sets opacity`);
    for (const f of tsxFiles) {
      const src = fs.readFileSync(f, "utf8");
      assert.ok(!/\bopacity-\d+\b/.test(src), `${rel(f)} uses an opacity utility`);
      assert.ok(!/style=\{\{/.test(src), `${rel(f)} uses an inline style`);
    }
  });

  it("interactive controls meet the 24 px target size and keep a visible focus ring", () => {
    const kit = stripComments(fs.readFileSync(path.join(FEATURES, "export", "kit", "kit.css"), "utf8"));
    const rule = /\.sp-chip,\s*\.sp-btn\s*\{([^}]*)\}/.exec(kit)?.[1] ?? "";
    assert.match(rule, /min-height:\s*28px/);
    assert.match(rule, /min-width:\s*28px/);
    assert.match(kit, /:focus-visible[^{]*\{\s*outline:\s*2px solid var\(--color-link\)/);
    assert.ok(!/outline:\s*(none|0)\b/.test(kit), "focus outlines are never removed");
  });

  // ---- fix round: A11Y-04, A11Y-07 ----------------------------------------------------------

  const kitCss = (): string => stripComments(fs.readFileSync(path.join(FEATURES, "export", "kit", "kit.css"), "utf8"));
  /** Declarations of every rule whose selector list contains `needle` (kit.css has no nested at-rules). */
  const rulesWith = (css: string, needle: string): { selector: string; body: string }[] =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] })).filter((r) => r.selector.includes(needle));
  const themes = readThemes(fs.readFileSync(path.join(SRC, "styles", "tokens.css"), "utf8"));
  const ratio = (tokens: TokenMap, a: string, b: string): number => {
    const ca = tokenColor(tokens, a);
    const cb = tokenColor(tokens, b);
    assert.ok(ca && cb, `${a} / ${b} must resolve to colours`);
    return contrastRatio(ca, cb);
  };

  it("the briefing trigger in the masthead keeps the shell's focus ring: kit.css sets no outline on .sp-trigger", () => {
    // kit.css is unlayered, so an outline here beats the layered `.header-row :focus-visible` gold
    // ring whatever the specificity; the link blue it used is 1.2:1 on the navy masthead.
    const rules = rulesWith(kitCss(), ".sp-trigger");
    assert.ok(rules.length > 0, "the class still exists (cursor)");
    for (const r of rules) {
      assert.ok(!/outline/.test(r.body), `"${r.selector}" must not set an outline`);
      assert.ok(!/\.sp-trigger[^,{]*:focus/.test(r.selector), `"${r.selector}" must not style the trigger's focus`);
    }
    assert.ok(ratio(themes.light, "--color-link", "--ft-navy") < 3, "the reason: the page ring colour fails on the masthead");
    assert.ok(ratio(themes.light, "--focus-chrome", "--ft-navy") >= 3 && ratio(themes.dark, "--focus-chrome", "--ft-navy") >= 3);
    // Controls inside pages and dialogs keep the kit ring.
    assert.match(kitCss(), /\.sp-page :is\([^)]*button[^)]*\):focus-visible,\s*\.sp-dialog :is\([^)]*button[^)]*\):focus-visible\s*\{\s*outline:\s*2px solid var\(--color-link\)/);
  });

  it("form fields are drawn with the field tokens, whose edge reaches 3:1 on the page and on the bar they sit in", () => {
    const rule = /\.sp-input,\s*\.sp-select,\s*\.sp-textarea\s*\{([^}]*)\}/.exec(kitCss())?.[1] ?? "";
    assert.match(rule, /border:\s*1px solid var\(--field-border\)/);
    assert.match(rule, /background:\s*var\(--field-bg\)/);
    assert.match(rule, /(^|[\s;])color:\s*var\(--field-fg\)/);
    for (const [name, tokens] of Object.entries(themes)) {
      for (const surface of ["--color-bg", "--color-surface", "--field-bg"]) assert.ok(ratio(tokens, "--field-border", surface) >= 3, `${name}: --field-border on ${surface}`);
      assert.ok(ratio(tokens, "--field-fg", "--field-bg") >= 4.5, `${name}: field text`);
      // The token the fields used before: under 2:1 everywhere.
      assert.ok(ratio(tokens, "--color-line", "--color-surface") < 3, `${name}: --color-line is not a control boundary`);
    }
  });

  it("a pressed chip or button is told apart from its neighbours in BOTH themes", () => {
    const kit = kitCss();
    const pressed = '.sp-chip[aria-pressed="true"]';
    const light = rulesWith(kit, pressed).find((r) => !r.selector.includes("html.dark"));
    const dark = rulesWith(kit, pressed).find((r) => r.selector.includes("html.dark"));
    assert.ok(light && dark, "a light rule and a dark override");
    assert.match(light.body, /background:\s*var\(--ft-navy\)/);
    for (const sel of ['html.dark .sp-chip[aria-pressed="true"]', 'html.dark .sp-chip[aria-current="page"]', 'html.dark .sp-btn[aria-pressed="true"]']) {
      assert.ok(dark.selector.includes(sel), `dark override covers ${sel}`);
    }
    assert.match(dark.body, /(^|[\s;])color:\s*var\(--chip-active-fg\)/);
    assert.match(dark.body, /background:\s*var\(--chip-active-bg\)/);
    assert.match(dark.body, /border-color:\s*var\(--chip-active-border\)/);
    assert.ok(kit.indexOf(dark.selector) > kit.indexOf(light.selector), "the override comes after the rule it overrides (same specificity + html.dark)");
    // Pressed fill against the unpressed gradient, the page and the bar surface.
    const neighbours = ["--menu-top", "--menu-bot", "--color-bg", "--color-surface"];
    for (const n of neighbours) {
      assert.ok(ratio(themes.light, "--ft-navy", n) >= 3, `light: navy fill on ${n}`);
      assert.ok(ratio(themes.dark, "--chip-active-bg", n) >= 3, `dark: gold fill on ${n}`);
      assert.ok(ratio(themes.dark, "--ft-navy", n) < 3, `dark: the navy fill alone fails on ${n} (why the override exists)`);
    }
    assert.ok(ratio(themes.dark, "--chip-active-fg", "--chip-active-bg") >= 4.5, "dark: pressed text");
  });

  it("dialogs are native <dialog> elements; nothing fakes one with role=dialog", () => {
    const sources = tsxFiles.map((f) => fs.readFileSync(f, "utf8"));
    assert.ok(sources.some((s) => /<dialog\b/.test(s)));
    for (const [i, s] of sources.entries()) assert.ok(!/role="dialog"|aria-modal/.test(s), rel(tsxFiles[i]));
    const kit = fs.readFileSync(path.join(FEATURES, "export", "kit", "kit.css"), "utf8");
    assert.match(kit, /\.sp-dialog\s*\{[^}]*margin:\s*auto/, "re-centre after the preflight margin reset");
    assert.match(kit, /\.sp-dialog::backdrop/);
  });
});
