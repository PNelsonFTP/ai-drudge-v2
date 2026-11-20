// sources.json (SourcesFile) and the SourceRef records of the edition, both straight from the registry.

import type { PublisherId, SourceInfo, SourceRef, SourcesFile } from "../../../shared/contract";
import { isHttpUrl } from "../../../shared/url";
import type { SourceDef } from "../../registry/types";
import type { Registry, StageContext } from "../types";
import { editionMeta } from "./common";

/** publisher id -> display name. */
export function publisherNames(registry: Registry): Map<PublisherId, string> {
  return new Map(registry.publishers.map((p) => [p.id, p.name]));
}

/** Publisher DISPLAY name of a source: its PublisherDef name, else the source's own name. */
export function publisherNameOf(def: SourceDef, names: ReadonlyMap<PublisherId, string>): string {
  return names.get(def.publisher) ?? def.name;
}

export function sourceRef(def: SourceDef, names: ReadonlyMap<PublisherId, string>): SourceRef {
  return { name: def.name, publisher: publisherNameOf(def, names), kind: def.kind };
}

function sourceInfo(def: SourceDef, names: ReadonlyMap<PublisherId, string>): SourceInfo {
  const info: SourceInfo = {
    id: def.id,
    name: def.name,
    publisher: publisherNameOf(def, names),
    publisherId: def.publisher,
    kind: def.kind,
    home: def.home,
    tier: def.tier,
    scope: def.scope,
  };
  // A scraper's `url` is its listing page: that is a homepage, not a feed.
  const homepage = def.homepage ?? (def.kind === "scrape" ? def.url : undefined);
  if (homepage && isHttpUrl(homepage)) info.homepage = homepage;
  if (def.kind !== "scrape" && isHttpUrl(def.url)) info.feedUrl = def.url;
  if (def.tags?.length) info.tags = [...def.tags];
  if (def.aliases?.length) info.aliases = [...def.aliases];
  if (def.status === "paused") info.paused = true;
  return info;
}

/** Every registry source, paused ones included (flagged), in registry order. */
export function buildSourcesFile(registry: Registry, ctx: Pick<StageContext, "now" | "buildId">): SourcesFile {
  const names = publisherNames(registry);
  return { ...editionMeta(ctx), sources: registry.sources.map((def) => sourceInfo(def, names)) };
}
