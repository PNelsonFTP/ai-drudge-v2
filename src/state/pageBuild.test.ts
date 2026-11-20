// vite.config.ts under node: the Content-Security-Policy of the production page and the order of its
// stylesheets. The config is loaded through a computed specifier so this test project does not have
// to type-check the build configuration (it belongs to tsconfig.node.json).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { THEME_BOOTSTRAP_SCRIPT } from "./themeBootstrap";

interface ViteConfigModule {
  contentSecurityPolicy(inlineScript: string): string;
  entryStylesFirst(html: string, entryCss: readonly string[]): string;
  stylesheetOrder(): { name: string; apply?: unknown; transformIndexHtml?: unknown };
  default: { plugins?: unknown[] };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configUrl = pathToFileURL(path.join(ROOT, "vite.config.ts")).href;
const load = async (): Promise<ViteConfigModule> => (await import(configUrl)) as ViteConfigModule;

/** <head> of a real production build (2026-11-19): Vite links the shared kit chunk's CSS before the entry's. */
const BUILT_HEAD = `
    <script type="module" crossorigin src="/ai-drudge-v2/assets/index-BiA8ZTQn.js"></script>
    <link rel="modulepreload" crossorigin href="/ai-drudge-v2/assets/kit-Cr_59rL_.js">
    <link rel="stylesheet" crossorigin href="/ai-drudge-v2/assets/kit-DclC5b7-.css">
    <link rel="stylesheet" crossorigin href="/ai-drudge-v2/assets/index-tv_pcqNm.css">
  </head>`;

const stylesheets = (html: string): string[] => [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("production page: Content-Security-Policy", () => {
  it("style-src is 'self' only - no 'unsafe-inline' anywhere in the policy", async () => {
    const { contentSecurityPolicy } = await load();
    const csp = contentSecurityPolicy(THEME_BOOTSTRAP_SCRIPT);
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    assert.deepEqual(directives["style-src"], ["'self'"]);
    assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
    assert.deepEqual(directives["default-src"], ["'self'"]);
    assert.deepEqual(directives["object-src"], ["'none'"]);
    assert.deepEqual(directives["base-uri"], ["'none'"]);
    assert.deepEqual(directives["form-action"], ["'none'"]);
    const hash = createHash("sha256").update(THEME_BOOTSTRAP_SCRIPT, "utf8").digest("base64");
    assert.deepEqual(directives["script-src"], ["'self'", `'sha256-${hash}'`], "the one inline script is allowed by hash");
  });

  it("the client never needs an inline style: no <style> element, style attribute string or cssText in src/", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          // React's `style={{...}}` and `el.style.x = ...` use the CSSOM and are fine; these are not:
          if (/<style[\s>]|setAttribute\(\s*["']style["']|dangerouslySetInnerHTML|createElement\(\s*["']style["']\s*\)/.test(text)) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    assert.deepEqual(offenders, [], "style-src 'self' would block these");
    assert.ok(!/<style[\s>]|\sstyle="/.test(fs.readFileSync(path.join(ROOT, "index.html"), "utf8")), "index.html has no inline style");
  });
});

describe("production page: stylesheet order", () => {
  it("the entry stylesheet is linked before the shared kit stylesheet (the import order of src/main.tsx)", async () => {
    const { entryStylesFirst } = await load();
    assert.deepEqual(stylesheets(BUILT_HEAD), ["/ai-drudge-v2/assets/kit-DclC5b7-.css", "/ai-drudge-v2/assets/index-tv_pcqNm.css"]);
    const fixed = entryStylesFirst(BUILT_HEAD, ["assets/index-tv_pcqNm.css"]);
    assert.deepEqual(stylesheets(fixed), ["/ai-drudge-v2/assets/index-tv_pcqNm.css", "/ai-drudge-v2/assets/kit-DclC5b7-.css"]);
    // Nothing else moves, nothing is lost or duplicated.
    assert.equal(fixed.length, BUILT_HEAD.length);
    assert.deepEqual(fixed.split("\n").filter((l) => !l.includes('rel="stylesheet"')), BUILT_HEAD.split("\n").filter((l) => !l.includes('rel="stylesheet"')));
    assert.ok(fixed.indexOf("modulepreload") < fixed.indexOf('rel="stylesheet"'));
  });

  it("is a no-op when the order is already right, with one stylesheet, or without entry CSS", async () => {
    const { entryStylesFirst } = await load();
    const right = entryStylesFirst(BUILT_HEAD, ["assets/index-tv_pcqNm.css"]);
    assert.equal(entryStylesFirst(right, ["assets/index-tv_pcqNm.css"]), right);
    assert.equal(entryStylesFirst(BUILT_HEAD, []), BUILT_HEAD);
    assert.equal(entryStylesFirst(BUILT_HEAD, ["assets/other-123.css"]), BUILT_HEAD);
    const one = '<link rel="stylesheet" crossorigin href="/assets/index-a.css">';
    assert.equal(entryStylesFirst(one, ["assets/index-a.css"]), one);
    // Site served from the domain root (SITE_BASE=/), three stylesheets: the others keep their order.
    const three = ['<link rel="stylesheet" crossorigin href="/assets/a-1.css">', '<link rel="stylesheet" crossorigin href="/assets/b-2.css">', '<link rel="stylesheet" crossorigin href="/assets/index-3.css">'].join("\n");
    assert.deepEqual(stylesheets(entryStylesFirst(three, ["assets/index-3.css"])), ["/assets/index-3.css", "/assets/a-1.css", "/assets/b-2.css"]);
  });

  it("the build applies it after Vite has injected its tags", async () => {
    const mod = await load();
    const plugin = mod.stylesheetOrder();
    assert.equal(plugin.apply, "build");
    const hook = plugin.transformIndexHtml as { order: string; handler: (html: string, ctx: unknown) => string };
    assert.equal(hook.order, "post");
    const ctx = { chunk: { viteMetadata: { importedCss: new Set(["assets/index-tv_pcqNm.css"]) } } };
    assert.deepEqual(stylesheets(hook.handler(BUILT_HEAD, ctx)), ["/ai-drudge-v2/assets/index-tv_pcqNm.css", "/ai-drudge-v2/assets/kit-DclC5b7-.css"]);
    assert.equal(hook.handler(BUILT_HEAD, {}), BUILT_HEAD, "no entry chunk (dev server): untouched");
    const names = (mod.default.plugins ?? []).flat(5).map((p) => (p as { name?: string } | null)?.name);
    assert.ok(names.includes("ai-drudge:stylesheet-order") && names.includes("ai-drudge:html"));
  });
});
