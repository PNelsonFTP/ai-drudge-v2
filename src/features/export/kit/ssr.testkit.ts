// Server-side render helper for the WP10 SSR smoke tests (renderToStaticMarkup inside a
// ServicesContext). Test support only: nothing in the app imports this file.

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServicesContext, type AppServices, type Route } from "../../../app/services";

export function renderWith(services: AppServices, node: ReactNode): string {
  return renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, node));
}

/** Render a route component the way the shell does: `<Component route={route} />`. */
export function renderRoute(services: AppServices, Component: ComponentType<{ route: Route }>, route: Route): string {
  return renderWith(services, createElement(Component, { route }));
}

/** Text content of the markup: tags removed, entities for the common characters decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every href in the markup, in document order (entity-decoded). */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

/** Number of occurrences of `needle` in `html`. */
export function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Text of every element with this tag name, in document order. */
export function tagTexts(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => textOf(m[1]));
}

const attr = (attrs: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/**
 * Static accessibility checks on rendered markup. Returns one line per problem:
 * - every form control has a name: a <label for>, a wrapping <label>, or aria-label / aria-labelledby
 * - every button has a type and a name (text or aria-label)
 * - every link has an href and a name
 * - the page has exactly one <h2> page heading, no <h1> (the shell owns it) and no heading-level jump
 * - every aria-labelledby / aria-describedby / label[for] points at an id that exists, and ids are unique
 */
export function a11yProblems(html: string): string[] {
  const problems: string[] = [];
  const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) problems.push(`duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\s(?:for|htmlFor)="([^"]*)"/g)].map((m) => m[1]));
  for (const target of labelled) if (!idSet.has(target)) problems.push(`label for="${target}" has no matching control`);
  for (const m of html.matchAll(/\saria-(?:labelledby|describedby)="([^"]*)"/g)) {
    for (const ref of m[1].split(/\s+/)) if (!idSet.has(ref)) problems.push(`aria reference to missing id "${ref}"`);
  }

  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (attr(attrs, "type") === "hidden") continue;
    const id = attr(attrs, "id");
    const before = html.slice(0, m.index);
    const wrapped = before.lastIndexOf("<label") > before.lastIndexOf("</label>");
    if (!(attr(attrs, "aria-label") || attr(attrs, "aria-labelledby") || (id && labelled.has(id)) || wrapped)) problems.push(`unlabelled <${m[1]}${attrs.slice(0, 60)}>`);
  }
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (!attr(m[1], "type")) problems.push(`<button> without type: ${textOf(m[2]).slice(0, 40)}`);
    if (!attr(m[1], "aria-label") && !textOf(m[2])) problems.push(`<button> without a name: ${m[1].slice(0, 60)}`);
  }
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!attr(m[1], "href")) problems.push(`<a> without href: ${textOf(m[2]).slice(0, 40)}`);
    if (!attr(m[1], "aria-label") && !textOf(m[2])) problems.push(`<a> without a name: ${m[1].slice(0, 60)}`);
  }

  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  if (levels.includes(1)) problems.push("page renders an <h1> (the shell owns the only one)");
  // Dialog titles are <h2> too, but dialogs render no content while closed.
  if (levels.filter((l) => l === 2).length !== 1) problems.push(`expected one <h2> page heading, found ${levels.filter((l) => l === 2).length}`);
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) problems.push(`heading level jumps from h${levels[i - 1]} to h${levels[i]}`);
  if (/\sstyle="/.test(html)) problems.push("inline style attribute (colours must come from the theme tokens)");
  return problems;
}
