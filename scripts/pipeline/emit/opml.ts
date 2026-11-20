// public/feeds.opml - every ACTIVE source of the registry, grouped by home section (homepage order),
// so a reader can take the whole source list into a feed reader. No timestamps: the file only
// changes when the registry does.

import { SECTIONS } from "../../../shared/sections";
import { isHttpUrl } from "../../../shared/url";
import { activeSources } from "../../registry/defaults";
import type { SourceDef } from "../../registry/types";
import type { Registry } from "../types";
import { xmlEscape } from "./xml";

export const OPML_FILE = "feeds.opml";

export interface OpmlOptions {
  siteUrl: string;
}

/** Sources with a subscribable feed are type "rss"; scrapers and JSON APIs are listed as plain links. */
function outline(def: SourceDef): string {
  const name = xmlEscape(def.name);
  const home = def.homepage && isHttpUrl(def.homepage) ? def.homepage : null;
  if (def.kind === "scrape" || def.kind === "json") {
    return `      <outline type="link" text="${name}" title="${name}" url="${xmlEscape(home ?? def.url)}"/>`;
  }
  const html = home ? ` htmlUrl="${xmlEscape(home)}"` : "";
  return `      <outline type="rss" text="${name}" title="${name}" xmlUrl="${xmlEscape(def.url)}"${html}/>`;
}

export function buildOpml(registry: Registry, opts: OpmlOptions): string {
  const active = activeSources(registry.sources).filter((s) => isHttpUrl(s.url));
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<opml version="2.0">`,
    `  <head>`,
    `    <title>AI DRUDGE sources</title>`,
    `    <ownerId>${xmlEscape(opts.siteUrl)}</ownerId>`,
    `    <docs>https://opml.org/spec2.opml</docs>`,
    `  </head>`,
    `  <body>`,
  ];
  for (const section of SECTIONS) {
    const sources = active.filter((s) => s.home === section.id);
    if (sources.length === 0) continue;
    const label = xmlEscape(section.label);
    lines.push(`    <outline text="${label}" title="${label}">`, ...sources.map(outline), `    </outline>`);
  }
  lines.push(`  </body>`, `</opml>`, ``);
  return lines.join("\n");
}
