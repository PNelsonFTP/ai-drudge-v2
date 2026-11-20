import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { THEME_BOOTSTRAP_SCRIPT } from "./src/state/themeBootstrap.ts";

export const DEFAULT_SITE_BASE = "/ai-drudge-v2/";

/** "ai-drudge-v2", "/ai-drudge-v2" and "/ai-drudge-v2/" all mean "/ai-drudge-v2/"; "/" stays "/". */
export function siteBase(raw: string | undefined): string {
  const path = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if ((raw ?? "").trim() === "") return DEFAULT_SITE_BASE;
  return path === "" ? "/" : `/${path}/`;
}

const THEME_MARKER = "<!--app:theme-bootstrap-->";
const CSP_MARKER = "<!--app:csp-->";

/** `'sha256-...'` CSP source for an inline script with exactly this text. */
export function scriptHashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * Content-Security-Policy of the production page (GitHub Pages cannot send headers, so it is a
 * <meta>). Everything is same-origin; the ONLY inline script is the hashed no-flash theme bootstrap.
 * style-src carries no 'unsafe-inline': the page has no <style> element and no style attribute in its
 * HTML, and React's `style` prop (hover card position) and `style.setProperty` (sticky offsets) go
 * through the CSSOM, which CSP does not govern. Do not add `setAttribute("style", ...)` or injected
 * <style> elements to the client - they would be blocked.
 * (frame-ancestors is ignored in a <meta> policy: src/main.tsx refuses to start inside a foreign frame.)
 */
export function contentSecurityPolicy(inlineScript: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashSource(inlineScript)}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Fills the two markers of index.html: the no-flash theme script (single source:
 * src/state/themeBootstrap.ts) and, in production builds only, the CSP <meta> carrying that
 * script's hash. The dev server gets no CSP: @vitejs/plugin-react's refresh preamble is an inline
 * script and HMR uses a websocket.
 */
export function appHtml(): Plugin {
  let production = false;
  return {
    name: "ai-drudge:html",
    configResolved(config) {
      production = config.command === "build";
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(THEME_MARKER) || !html.includes(CSP_MARKER)) {
          throw new Error(`index.html must contain ${THEME_MARKER} and ${CSP_MARKER}`);
        }
        const csp = production ? `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(THEME_BOOTSTRAP_SCRIPT)}" />` : "";
        return html.replace(CSP_MARKER, csp).replace(THEME_MARKER, `<script>${THEME_BOOTSTRAP_SCRIPT}</script>`);
      },
    },
  };
}

const STYLESHEET_LINK = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;

/**
 * Put the entry chunk's stylesheet(s) BEFORE every other stylesheet <link> of the built page, keeping
 * the positions of the tags. Vite links the CSS of a shared chunk (kit.css, also imported by the lazy
 * routes) ahead of the entry's index CSS, which reverses the import order of src/main.tsx: the page
 * kit is written to come after the base styles in the cascade.
 */
export function entryStylesFirst(html: string, entryCss: readonly string[]): string {
  const links = html.match(STYLESHEET_LINK) ?? [];
  if (links.length < 2 || entryCss.length === 0) return html;
  const isEntry = (tag: string): boolean => entryCss.some((file) => tag.includes(`/${file}"`) || tag.includes(`"${file}"`));
  const ordered = [...links.filter(isEntry), ...links.filter((tag) => !isEntry(tag))];
  let i = 0;
  return html.replace(STYLESHEET_LINK, () => ordered[i++]);
}

/** Applies entryStylesFirst() to the built index.html (after Vite has injected its asset tags). */
export function stylesheetOrder(): Plugin {
  return {
    name: "ai-drudge:stylesheet-order",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        return entryStylesFirst(html, [...(ctx.chunk?.viteMetadata?.importedCss ?? [])]);
      },
    },
  };
}

export default defineConfig({
  // GitHub Pages project path. SITE_BASE=/ serves from the domain root.
  base: siteBase(process.env.SITE_BASE),
  plugins: [react(), tailwindcss(), appHtml(), stylesheetOrder()],
  build: {
    target: "es2022",
    outDir: "dist",
    // Every supported browser has native modulepreload; the polyfill is dead weight in the entry chunk.
    modulePreload: { polyfill: false },
  },
});
