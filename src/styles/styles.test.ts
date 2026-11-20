// Static guards for the stylesheet split (no browser, no build):
//   - the V1 identity classes are all still defined
//   - colours live only in tokens.css; nothing references an undefined custom property
//     (V1's dialogs used var(--bg, #161616): undefined, so black text on near-black)
//   - no opacity de-emphasis, no removed focus outline
//   - breakpoints: 1 / 2 / 3 columns at < 720 / >= 720 / >= 1100 px
//   - Tailwind scans src/ and the HTML entries only (never public/ or test/)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./contrast";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../..");
const read = (file: string): string => fs.readFileSync(path.join(DIR, file), "utf8");
const FILES = ["index.css", "tokens.css", "base.css", "chrome.css", "components.css"] as const;
const css = Object.fromEntries(FILES.map((f) => [f, stripComments(read(f))])) as Record<(typeof FILES)[number], string>;
const all = FILES.map((f) => css[f]).join("\n");

/** Is `.name` used as a class in some selector of the given CSS? */
const definesClass = (source: string, name: string): boolean => new RegExp(`\\.${name.replace(/[-]/g, "\\-")}(?![\\w-])[^{};]*\\{`).test(source);

function walk(dir: string, exts: RegExp): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const child = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(child, exts);
    return exts.test(e.name) ? [child] : [];
  });
}

describe("stylesheet split", () => {
  it("consists of the five files, imported in cascade order", () => {
    for (const f of FILES) assert.ok(fs.existsSync(path.join(DIR, f)), f);
    const imports = [...css["index.css"].matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["tailwindcss", "./tokens.css", "./base.css", "./chrome.css", "./components.css"]);
  });

  it("ports every V1 class (same names, so the identity is unchanged)", () => {
    const chrome = ["sticky-top", "header-row", "masthead-btn", "logo", "tagline", "toolbar", "tool-btn", "control-row", "search-input", "desk", "ticker-bar", "ticker-sym", "ticker-up", "ticker-down", "ticker-flat"];
    const components = ["section-heading", "lead-title", "headline-critical", "headline-high", "headline-medium", "headline-low", "source-badge", "panel", "brief-box", "trend-box", "hover-card", "related-badge", "news-columns", "news-col"];
    for (const name of chrome) assert.ok(definesClass(css["chrome.css"], name), `chrome.css lost .${name}`);
    for (const name of components) assert.ok(definesClass(css["components.css"], name), `components.css lost .${name}`);
    assert.match(css["chrome.css"], /\.logo \.mark\s*\{/);
    assert.match(css["chrome.css"], /\.tool-btn:hover,\s*\.tool-btn\.active/);
    assert.match(css["components.css"], /\.lead-title\.headline-critical\s*\{/);
    assert.match(css["components.css"], /\.brief-box \.section-heading,\s*\.trend-box \.section-heading\s*\{/);
  });

  it("drops only .tool-btn.stale (stale is shown on the timestamp, not on the theme button)", () => {
    assert.doesNotMatch(all, /\.tool-btn\.stale/);
    assert.match(css["chrome.css"], /\.tagline \.stale\s*\{/);
  });

  it("keeps the V1 look of the masthead and headings byte-for-byte where it matters", () => {
    assert.match(css["chrome.css"], /\.header-row\s*\{[^}]*linear-gradient\(180deg, var\(--ft-navy\) 0%, var\(--ft-navy-dark\) 100%\)[^}]*border-bottom: 4px solid var\(--ft-gold\)/);
    assert.match(css["chrome.css"], /\.logo\s*\{[^}]*font-weight: 700;[^}]*letter-spacing: 0\.04em;[^}]*font-size: 22px/);
    assert.match(css["components.css"], /\.section-heading\s*\{[^}]*border-left: 4px solid var\(--ft-navy\);[^}]*border-bottom: 2px solid var\(--ft-navy\)/);
    assert.match(css["components.css"], /\.headline-critical\s*\{\s*color: var\(--siren\); font-weight: 700;\s*\}/);
    assert.match(css["base.css"], /font-family: var\(--font-sans\)/);
  });

  it("adds the V2 pieces: skip link, focus ring, chips, dialog, density, touch targets, print, reduced motion", () => {
    for (const name of ["skip-link", "visually-hidden", "touch-target"]) assert.ok(definesClass(css["base.css"], name), `.${name}`);
    for (const name of ["chip", "chip-active", "modal", "btn", "icon-btn", "headline-seen", "new-badge", "row-meta"]) assert.ok(definesClass(css["components.css"], name), `.${name}`);
    for (const name of ["chip-nav", "chip-list", "time-chips", "banner", "site-footer", "subchrome", "menu-btn"]) assert.ok(definesClass(css["chrome.css"], name), `.${name}`);
    assert.match(css["base.css"], /:focus-visible\s*\{\s*outline: 2px solid var\(--focus\);\s*outline-offset: 2px;/);
    assert.match(css["chrome.css"], /\.header-row :focus-visible,\s*\.ticker-bar :focus-visible\s*\{\s*outline-color: var\(--focus-chrome\)/);
    assert.match(css["base.css"], /html\[data-density="compact"\]/);
    assert.match(css["base.css"], /html\[data-density="comfortable"\]/);
    assert.match(css["base.css"], /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css["base.css"], /@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--target-min: 32px/);
    assert.match(css["components.css"], /@media print\s*\{/);
    assert.match(css["components.css"], /\.modal::backdrop\s*\{\s*background: var\(--backdrop\)/);
    assert.match(css["components.css"], /\.modal\s*\{[^}]*margin: auto;[^}]*background: var\(--dialog-bg\);\s*color: var\(--dialog-fg\)/);
    assert.match(css["components.css"], /\.chip-active,[^{]*\{[^}]*background: var\(--chip-active-bg\)/);
  });

  it("interactive chrome meets the minimum target size token", () => {
    for (const [file, selector] of [["chrome.css", ".tool-btn"], ["chrome.css", ".search-input"], ["components.css", ".chip"], ["components.css", ".btn"], ["components.css", ".icon-btn"]] as const) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css[file])?.[1] ?? "";
      assert.match(rule, /min-height: var\(--target-min\)/, `${selector} needs min-height: var(--target-min)`);
    }
    assert.match(css["tokens.css"], /--target-min: 24px/);
  });
});

describe("colour discipline", () => {
  it("only tokens.css contains colour literals", () => {
    for (const f of ["index.css", "base.css", "chrome.css", "components.css"] as const) {
      const hits = css[f].match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\(/g) ?? [];
      assert.deepEqual(hits, [], `${f} must use tokens, found ${hits.join(", ")}`);
    }
    for (const f of ["base.css", "chrome.css", "components.css"] as const) {
      const named = css[f].match(/(?:color|background|background-color|border(?:-[a-z]+)?-color|outline-color|fill|stroke):\s*(?:white|black|red|gray|grey|silver|navy|gold|blue|green|orange)\b/g) ?? [];
      assert.deepEqual(named, [], f);
    }
  });

  it("never dims text or controls with opacity, and never removes a control's focus outline", () => {
    const opacity = [...all.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => m[1]).filter((v) => v !== "1");
    assert.deepEqual(opacity, [], "use --color-muted / --color-seen / --icon-idle instead of opacity");
    // outline:none is allowed only on <main>, a focus TARGET (skip link) that is not a control.
    const removed = [...all.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)\b[^}]*\}/g)].map((m) => m[1].trim().replace(/\s+/g, " "));
    assert.deepEqual(removed, ["main:focus, main:focus-visible"]);
    assert.doesNotMatch(css["chrome.css"], /\.search-input:focus\s*\{[^}]*outline/);
  });

  it("every var(--x) used by V2 styles and components is defined (the V1 dialog bug)", () => {
    const defined = new Set<string>();
    const sources = new Map<string, string>();
    for (const f of FILES) sources.set(`src/styles/${f}`, css[f]);
    for (const dir of ["src/app", "src/features", "src/keyboard", "src/data", "src/state"]) {
      for (const file of walk(dir, /\.(tsx?|css)$/)) {
        if (/\.test\.tsx?$/.test(file)) continue;
        sources.set(file, fs.readFileSync(path.join(ROOT, file), "utf8"));
      }
    }
    for (const text of sources.values()) {
      for (const m of text.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) defined.add(m[1]);
      // Inline styles and setProperty: { "--cols": 3 }  /  style.setProperty("--sticky-h", ...)
      for (const m of text.matchAll(/["'`](--[a-zA-Z][\w-]*)["'`]/g)) defined.add(m[1]);
    }
    const undefinedRefs: string[] = [];
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)) {
        if (!defined.has(m[1]) && !m[1].startsWith("--tw-")) undefinedRefs.push(`${file}: ${m[1]}`);
      }
    }
    assert.deepEqual([...new Set(undefinedRefs)], []);
  });

  it("shell components carry no hex colours, inline colour styles or opacity utilities", () => {
    const files = [...walk("src/app", /\.tsx$/), ...walk("src/features/chrome", /\.tsx?$/), ...walk("src/keyboard", /\.tsx?$/)].filter((f) => !/\.test\./.test(f));
    assert.ok(files.length >= 12, `only ${files.length} shell files found`);
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.doesNotMatch(text, /#[0-9a-fA-F]{6}\b/, `${file}: hex colour`);
      assert.doesNotMatch(text, /className="[^"]*\bopacity-\d/, `${file}: opacity utility`);
      assert.doesNotMatch(text, /style=\{\{[^}]*(?:color|background)/i, `${file}: inline colour`);
    }
  });
});

describe("print sheet", () => {
  const components = css["components.css"];
  const at = components.indexOf("@media print");
  const print = components.slice(at);

  it("is the only print block and closes the components layer", () => {
    assert.ok(at > 0);
    assert.equal(all.split("@media print").length - 1, 1);
  });

  it("resets the palette for BOTH themes, so dark-theme text never prints light on white paper", () => {
    const reset = /:root, html\.dark\s*\{([^}]*)\}/.exec(print)?.[1] ?? "";
    assert.match(reset, /color-scheme: light;/);
    // Every token a text colour is read from in the feature sheets (headline, home, the pages' kit).
    for (const token of ["--color-fg", "--color-muted", "--color-link", "--color-seen", "--color-visited", "--color-heading-meta", "--ft-navy-deep", "--siren", "--accent", "--badge-fg", "--color-up", "--color-down"]) {
      assert.match(reset, new RegExp(`${token}: var\\(--print-ink\\);`), `${token} must print in ink`);
    }
    for (const token of ["--color-bg", "--color-surface"]) assert.match(reset, new RegExp(`${token}: var\\(--print-paper\\);`), token);
    // The reset must come first, and inside @layer components (it has to outrank html.dark in @layer base).
    assert.ok(print.indexOf(":root, html.dark") < print.indexOf("html, body"));
    assert.match(css["tokens.css"], /@layer base\s*\{[\s\S]*html\.dark\s*\{/);
    assert.match(components, /^\s*@layer components\s*\{/);
  });

  it("hides every control, including those of the feature sheets", () => {
    const hidden = /([^{}]*)\{\s*display: none !important;\s*\}/.exec(print)?.[1] ?? "";
    for (const cls of [".toolbar", ".subchrome", ".ticker-bar", ".icon-btn", ".chip", ".btn", ".link-btn", ".toast", ".hl-text-btn", ".home-more-btn", ".home-view-all", ".home-chip-btn", ".home-banner", ".sp-btn", ".sp-chip", ".sp-bar", ".sp-actions", ".sp-nav", ".sp-input"]) {
      assert.match(hidden, new RegExp(`(?:^|[\\s,])\\${cls}(?=[\\s,]|$)`), `${cls} must not reach paper`);
    }
  });

  it("does not depend on the paper being wider than the phone breakpoint (A4 is 703 px)", () => {
    assert.match(print, /\.home-row-extra\s*\{\s*display: list-item !important;/);
    assert.match(print, /\.home-band\.has-side\s*\{\s*grid-template-columns: minmax\(0, 5fr\) minmax\(0, 3fr\) !important;/);
    assert.match(print, /\.news-columns\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/);
  });
});

describe("mute notice", () => {
  it("is pinned to the viewport above the hover card, drawn with dialog tokens", () => {
    const rule = /\.toast\s*\{([^}]*)\}/.exec(css["components.css"])?.[1] ?? "";
    assert.match(rule, /position: fixed;/);
    assert.match(rule, /background: var\(--dialog-bg\);\s*color: var\(--dialog-fg\);/);
    const z = (selector: string): number => Number(new RegExp(`\\${selector}\\s*\\{[^}]*z-index: (\\d+)`).exec(css["components.css"])?.[1]);
    assert.ok(z(".toast") > z(".hover-card"));
  });
});

describe("layout breakpoints", () => {
  const news = css["components.css"];

  it("one column by default, two from 720 px, three from 1100 px (V1 jumped to three at 768 px)", () => {
    assert.match(news, /\.news-columns\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(news, /@media \(min-width: 720px\) and \(max-width: 1099\.98px\)\s*\{\s*\.news-columns\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(news, /@media \(min-width: 1100px\)\s*\{\s*\.news-columns\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.doesNotMatch(all, /768px/);
  });

  it("only the masthead is sticky on phones; the silver rows stick from 720 px up", () => {
    const chrome = css["chrome.css"];
    assert.match(chrome, /\.sticky-top\s*\{\s*position: sticky;\s*top: 0;/);
    assert.match(chrome, /\.subchrome\s*\{\s*position: static;/);
    assert.match(chrome, /@media \(min-width: 720px\)\s*\{\s*\.subchrome\s*\{\s*position: sticky;\s*top: var\(--masthead-h\);/);
    assert.match(chrome, /@media \(max-height: 600px\)\s*\{\s*\.sticky-top, \.subchrome\s*\{\s*position: static;/);
    assert.match(chrome, /@media \(max-width: 719\.98px\)\s*\{[^@]*\.toolbar\s*\{\s*display: none;/);
    assert.match(css["base.css"], /scroll-padding-top: calc\(var\(--sticky-h\) \+ 8px\)/);
  });

  it("nothing else in src/ is sticky: the masthead, the silver rows from 720 px, and two rules that stick inside their own scroll box", () => {
    const found: string[] = [];
    for (const file of walk("src", /\.css$/)) {
      const text = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
      for (const m of text.matchAll(/([^{}]+)\{[^{}]*position:\s*sticky/g)) found.push(`${file}: ${m[1].trim()}`);
    }
    assert.deepEqual(found.sort(), [
      // Inside .sp-scroll (overflow-x: auto makes it the scroll box) and inside the modal dialog:
      // neither pins anything to the page viewport.
      "src/features/export/kit/kit.css: .sp-dialog-head",
      "src/features/export/kit/kit.css: .sp-table thead th",
      "src/styles/chrome.css: .sticky-top",
      "src/styles/chrome.css: .subchrome",
    ]);
    // The second one is the >= 720 px rule; below it .subchrome is static (previous test).
    assert.equal(css["chrome.css"].split("position: sticky").length - 1, 2);
    assert.match(stripComments(fs.readFileSync(path.join(ROOT, "src/features/export/kit/kit.css"), "utf8")), /\.sp-scroll\s*\{[^}]*overflow-x: auto/);
  });

  it("the ticker's focus ring (it is a tab stop while it overflows) is drawn inside the band, in the chrome focus colour", () => {
    assert.match(css["chrome.css"], /\.ticker-list:focus-visible\s*\{\s*outline-offset: -2px;/);
    assert.match(css["chrome.css"], /\.ticker-bar :focus-visible\s*\{\s*outline-color: var\(--focus-chrome\);/);
  });

  it("phones get a 16 px search field (iOS zooms the page below that)", () => {
    assert.match(css["chrome.css"], /@media \(max-width: 719\.98px\)\s*\{\s*\.search-input\s*\{\s*font-size: 16px;/);
  });
});

describe("Tailwind sources", () => {
  const index = css["index.css"];
  const sources = [...index.matchAll(/@source\s+(not\s+)?"([^"]+)"/g)].map((m) => ({ negated: Boolean(m[1]), pattern: m[2] }));

  it("turns automatic source detection off", () => {
    assert.match(index, /@import\s+"tailwindcss"\s+source\(none\);/);
  });

  it("scans only src/ and root HTML entries - never public/ (news data) or test/", () => {
    const positive = sources.filter((s) => !s.negated);
    assert.ok(positive.length >= 2);
    for (const { pattern } of positive) {
      const rel = path.relative(ROOT, path.resolve(DIR, pattern)).split(path.sep).join("/");
      assert.ok(rel === "src" || rel.startsWith("src/") || /^[\w.-]+\.html$/.test(rel), `@source "${pattern}" resolves to ${rel || "the repo root"}`);
      assert.ok(!rel.startsWith("public") && !rel.startsWith("test") && !rel.startsWith("scripts") && !rel.startsWith("docs"), rel);
    }
    assert.ok(sources.some((s) => s.negated && s.pattern.endsWith(".test.ts")), "test files are excluded");
  });

  it("the real scanner agrees (skipped when Tailwind's internals are not resolvable)", async (t) => {
    // @tailwindcss/node and @tailwindcss/oxide are dependencies of @tailwindcss/vite, not of this
    // repo: resolve them from the plugin, and treat any failure to do so as "cannot check here".
    let compile: (css: string, opts: { base: string; onDependency: (p: string) => void }) => Promise<{ root: unknown; sources: { base: string; pattern: string; negated: boolean }[] }>;
    let Scanner: new (opts: { sources: { base: string; pattern: string; negated: boolean }[] }) => { scan(): string[]; files: string[] };
    try {
      const fromPlugin = createRequire(createRequire(path.join(ROOT, "package.json")).resolve("@tailwindcss/vite"));
      ({ compile } = (await import(fromPlugin.resolve("@tailwindcss/node"))) as { compile: typeof compile });
      ({ Scanner } = (await import(fromPlugin.resolve("@tailwindcss/oxide"))) as { Scanner: typeof Scanner });
    } catch (err) {
      t.skip(`Tailwind internals not resolvable: ${String(err)}`);
      return;
    }
    const compiler = await compile(read("index.css"), { base: DIR, onDependency: () => undefined });
    assert.equal(compiler.root, "none", "source(none) must reach the compiler");
    const scanner = new Scanner({ sources: compiler.sources });
    scanner.scan();
    const files = scanner.files.map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    assert.ok(files.length > 10, `scanner saw only ${files.length} files`);
    const outside = files.filter((f) => !(f.startsWith("src/") || /^[\w.-]+\.html$/.test(f)));
    assert.deepEqual(outside, []);
    assert.deepEqual(files.filter((f) => /\.test\.tsx?$/.test(f)), []);
  });
});
