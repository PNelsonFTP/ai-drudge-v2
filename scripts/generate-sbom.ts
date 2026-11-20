// docs/SBOM.json generator: a CycloneDX 1.6 bill of materials, built from files in this repository.
//
//   npm run sbom                         write docs/SBOM.json and refresh the tables in docs/SBOM.md
//   npm run sbom -- --check              exit 1 when docs/SBOM.json is not what this tool would write
//   npm run sbom -- --out <file> --no-md write elsewhere / leave docs/SBOM.md alone
//   npm run sbom -- --timestamp <iso>    fix metadata.timestamp (also: SOURCE_DATE_EPOCH)
//
// What goes in, and where it comes from (no network, no dependency, no clock in the content):
//   npm packages      package-lock.json: name, version, integrity hash, dev / optional flags, the
//                     dependency graph. Licence: the package's own node_modules/<pkg>/package.json
//                     when it is installed, else the lockfile's copy of that field (they agree; a
//                     platform binary for another OS is never installed).
//   GitHub Actions    every `uses:` in .github/workflows/*.yml with the commit it is pinned to.
//   Node.js           the CI runtime line from .node-version.
//   services          what the pipeline and the site talk to at run time; the endpoints are the
//                     constants the code itself uses (brief.ts, stocks.ts, googleNews.ts, hn.ts).
//
// Scope of an npm component: "required" = shipped to the browser; "excluded" = build / pipeline
// only (CycloneDX: documented, not reachable at run time of the product); "optional" = a
// platform-specific binary that is installed only on a matching OS / CPU. The property
// `ai-drudge:usage` says which build-only packages are loaded by the process that fetches and
// parses untrusted feeds ("data-pipeline") - the ones to read advisories for first.
//
// Deterministic: components are sorted, the serial number is a hash of the content, and the
// timestamp is KEPT from the existing file while the content is unchanged - so regenerating
// without a change rewrites the same bytes, and the timestamp reads "when this bill of materials
// last changed". `buildBom` is pure and is what the tests exercise.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SITE_URL } from "./pipeline/context";
import { ANTHROPIC_MESSAGES_URL, BRIEF_MODEL } from "./pipeline/enrich/brief";
import { YAHOO_HOSTS } from "./pipeline/enrich/stocks";
import { BATCH_URL } from "./pipeline/ingest/googleNews";
import { HN_API } from "./pipeline/ingest/signals/hn";

export const SPEC_VERSION = "1.6";
export const TOOL_NAME = "scripts/generate-sbom.ts";
export const TOOL_VERSION = "2.0";

/** Packages the data pipeline loads in-process (everything they depend on inherits the label). */
export const PIPELINE_PACKAGES: readonly string[] = ["fast-xml-parser", "tsx"];

// ------------------------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------------------------

export interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: unknown;
  dev?: boolean;
  optional?: boolean;
  inBundle?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface SbomInputs {
  pkg: { name: string; version: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };
  lock: { lockfileVersion?: number; packages: Record<string, LockPackage> };
  /** lock path ("node_modules/react") -> the `license` value of the INSTALLED package.json; absent when not installed. */
  installedLicenses?: Readonly<Record<string, unknown>>;
  /** workflow file name -> text. */
  workflows: Readonly<Record<string, string>>;
  /** Contents of .node-version, or null. */
  nodeVersion: string | null;
  /** ISO time for metadata.timestamp; null = no timestamp in the document. */
  timestamp: string | null;
  siteUrl?: string;
}

// ------------------------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------------------------

/** Package name of a lockfile path: the part after the LAST "node_modules/". */
export function packageName(lockPath: string): string {
  return lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
}

/** Package URL of an npm package. The scope's "@" is percent-encoded, as the purl specification requires. */
export function purlNpm(name: string, version: string): string {
  const [scope, bare] = name.startsWith("@") && name.includes("/") ? [name.slice(1, name.indexOf("/")), name.slice(name.indexOf("/") + 1)] : [null, name];
  const enc = (s: string): string => encodeURIComponent(s);
  return `pkg:npm/${scope === null ? "" : `%40${enc(scope)}/`}${enc(bare)}@${enc(version)}`;
}

/**
 * SPDX identifiers this tool states as `license.id` (the schema validates ids against the SPDX list,
 * so an unknown string must never be emitted as one). Anything else becomes an expression or a name.
 */
const SPDX_IDS: ReadonlySet<string> = new Set([
  "0BSD", "AFL-2.1", "Apache-2.0", "Artistic-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "BSL-1.0",
  "CC-BY-3.0", "CC-BY-4.0", "CC0-1.0", "EPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "ISC",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MIT-0", "MPL-2.0", "Python-2.0", "Unicode-3.0",
  "Unicode-DFS-2016", "Unlicense", "WTFPL", "Zlib",
]);

export type LicenseChoice =
  | { license: { id: string; acknowledgement: "declared" } }
  | { license: { name: string; acknowledgement: "declared" } }
  | { expression: string; acknowledgement: "declared" };

/** package.json `license` (string, or the legacy `{ type }` object) as the string it declares; null when there is none. */
export function declaredLicense(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string") return (raw as { type: string }).type.trim() || null;
  return null;
}

/** A declared licence string as a CycloneDX licence entry: SPDX id, SPDX expression, or a plain name. */
export function licenseEntry(declared: string | null): LicenseChoice[] | undefined {
  if (!declared) return undefined;
  if (SPDX_IDS.has(declared)) return [{ license: { id: declared, acknowledgement: "declared" } }];
  const tokens = declared.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  const operators = new Set(["AND", "OR", "WITH"]);
  const isExpression = tokens.length > 1 && tokens.some((t) => operators.has(t)) && tokens.every((t) => operators.has(t) || /^[A-Za-z0-9.+-]+$/.test(t));
  if (isExpression) return [{ expression: declared, acknowledgement: "declared" }];
  return [{ license: { name: declared.slice(0, 200), acknowledgement: "declared" } }];
}

const HASH_ALGS: Readonly<Record<string, string>> = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" };

/** npm `integrity` ("sha512-<base64>", possibly several, space-separated) as CycloneDX hashes (hex). */
export function integrityHashes(integrity: string | undefined): { alg: string; content: string }[] | undefined {
  const out: { alg: string; content: string }[] = [];
  for (const part of (integrity ?? "").split(/\s+/)) {
    const m = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(part);
    if (m) out.push({ alg: HASH_ALGS[m[1]], content: Buffer.from(m[2], "base64").toString("hex") });
  }
  return out.length ? out : undefined;
}

/** Where a dependency named `dep` of the package at `fromPath` is installed: node resolution over lockfile paths. */
export function resolveDependency(fromPath: string, dep: string, packages: Readonly<Record<string, unknown>>): string | null {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut >= 0 ? base.slice(0, cut) : "";
  }
}

export interface ActionUse {
  /** "actions/checkout" or "owner/repo/path". */
  action: string;
  /** What follows "@": the commit SHA when pinned. */
  ref: string;
  /** True when `ref` is a full 40-character commit SHA. */
  pinned: boolean;
  /** The release the trailing "# vX.Y.Z" comment claims (not verified by this tool). */
  tag: string | null;
  /** Workflow files that use it, sorted. */
  workflows: string[];
}

/** Every remote `uses:` of the given workflow texts (local "./" actions and docker:// images are not components). */
export function workflowActions(workflows: Readonly<Record<string, string>>): ActionUse[] {
  const byKey = new Map<string, ActionUse>();
  for (const file of Object.keys(workflows).sort()) {
    for (const line of workflows[file].split("\n")) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*(?:-\s+)?uses:\s*["']?([\w.-]+\/[\w./-]+)@([\w./-]+)["']?(?:\s+#\s*(\S+))?/.exec(line);
      if (!m) continue;
      const key = `${m[1]}@${m[2]}`;
      const have = byKey.get(key);
      if (have) {
        if (!have.workflows.includes(file)) have.workflows.push(file);
        have.tag ??= m[3] ?? null;
      } else byKey.set(key, { action: m[1], ref: m[2], pinned: /^[0-9a-f]{40}$/.test(m[2]), tag: m[3] ?? null, workflows: [file] });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.action + a.ref < b.action + b.ref ? -1 : 1));
}

/**
 * Deterministic "urn:uuid:" from content: SHA-256, laid out as a name-based UUID (version nibble 5,
 * RFC 4122 variant). The CycloneDX schema only accepts versions 1-5 in serialNumber, so the custom
 * version 8 of RFC 9562 is not an option.
 */
export function serialNumberFor(content: string): string {
  const h = createHash("sha256").update(content).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------------------------------------------
// The document
// ------------------------------------------------------------------------------------------------

type Property = { name: string; value: string };

export interface BomComponent {
  type: "library" | "application" | "platform";
  "bom-ref": string;
  group?: string;
  name: string;
  version: string;
  description?: string;
  scope: "required" | "optional" | "excluded";
  licenses?: LicenseChoice[];
  purl?: string;
  hashes?: { alg: string; content: string }[];
  externalReferences?: { type: string; url: string }[];
  properties?: Property[];
}

export interface BomService {
  "bom-ref": string;
  provider: { name: string; url?: string[] };
  name: string;
  description: string;
  /** Absent when the service is a set of hosts listed elsewhere. */
  endpoints?: string[];
  authenticated: boolean;
  "x-trust-boundary": boolean;
  data: { flow: "inbound" | "outbound" | "bi-directional"; classification: string; description: string }[];
  properties?: Property[];
}

export interface Bom {
  $schema: string;
  bomFormat: "CycloneDX";
  specVersion: typeof SPEC_VERSION;
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp?: string;
    lifecycles: { phase: string }[];
    tools: { components: { type: "application"; name: string; version: string }[] };
    component: { type: "application"; "bom-ref": string; name: string; version: string; description: string; externalReferences: { type: string; url: string }[] };
    properties: Property[];
  };
  components: BomComponent[];
  services: BomService[];
  dependencies: { ref: string; dependsOn: string[] }[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function npmComponents(inputs: SbomInputs): { components: BomComponent[]; refByPath: Map<string, string>; dependsOn: Map<string, Set<string>> } {
  const packages = inputs.lock.packages;
  const paths = Object.keys(packages).filter((p) => p.startsWith("node_modules/") && typeof packages[p].version === "string");
  const refByPath = new Map(paths.map((p) => [p, purlNpm(packageName(p), packages[p].version as string)]));

  // Dependency edges, and what each root reaches.
  const edges = new Map<string, string[]>();
  for (const p of paths) {
    const meta = packages[p];
    const names = new Set([...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {}), ...Object.keys(meta.peerDependencies ?? {})]);
    edges.set(p, [...names].map((n) => resolveDependency(p, n, packages)).filter((x): x is string => x !== null && refByPath.has(x)));
  }
  const reach = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const todo = roots.map((r) => `node_modules/${r}`).filter((p) => refByPath.has(p));
    while (todo.length) {
      const p = todo.pop() as string;
      if (seen.has(p)) continue;
      seen.add(p);
      todo.push(...(edges.get(p) ?? []));
    }
    return seen;
  };
  const pipeline = reach(PIPELINE_PACKAGES);

  const byRef = new Map<string, BomComponent>();
  const dependsOn = new Map<string, Set<string>>();
  for (const p of [...paths].sort(cmp)) {
    const meta = packages[p];
    const name = packageName(p);
    const version = meta.version as string;
    const ref = refByPath.get(p) as string;
    const deps = dependsOn.get(ref) ?? new Set<string>();
    for (const d of edges.get(p) ?? []) deps.add(refByPath.get(d) as string);
    dependsOn.set(ref, deps);
    const existing = byRef.get(ref);
    if (existing) {
      // The same name@version installed at two paths is ONE component (bom-refs are unique).
      existing.properties?.push({ name: "cdx:npm:package:path", value: p });
      if (!meta.dev) existing.scope = "required";
      continue;
    }
    const installed = inputs.installedLicenses?.[p];
    const declared = declaredLicense(installed === undefined ? meta.license : installed) ?? declaredLicense(meta.license);
    const runtime = !meta.dev;
    const usage = runtime ? "browser-runtime" : pipeline.has(p) ? "data-pipeline" : "build-tooling";
    const properties: Property[] = [
      { name: "ai-drudge:usage", value: usage },
      { name: "cdx:npm:package:development", value: String(!runtime) },
    ];
    if (meta.inBundle) properties.push({ name: "cdx:npm:package:bundled", value: "true" });
    if (meta.hasInstallScript) properties.push({ name: "ai-drudge:npm:has-install-script", value: "true" });
    properties.push({ name: "cdx:npm:package:path", value: p });
    const scoped = name.startsWith("@") && name.includes("/");
    const c: BomComponent = {
      type: "library",
      "bom-ref": ref,
      ...(scoped ? { group: name.slice(0, name.indexOf("/")) } : {}),
      name: scoped ? name.slice(name.indexOf("/") + 1) : name,
      version,
      scope: runtime ? "required" : meta.optional ? "optional" : "excluded",
    };
    const licenses = licenseEntry(declared);
    if (licenses) c.licenses = licenses;
    c.purl = ref;
    const hashes = integrityHashes(meta.integrity);
    if (hashes) c.hashes = hashes;
    if (meta.resolved && /^https?:\/\//.test(meta.resolved)) c.externalReferences = [{ type: "distribution", url: meta.resolved }];
    c.properties = properties;
    byRef.set(ref, c);
  }
  return { components: [...byRef.values()].sort((a, b) => cmp(a["bom-ref"], b["bom-ref"])), refByPath, dependsOn };
}

function actionComponents(workflows: Readonly<Record<string, string>>): BomComponent[] {
  return workflowActions(workflows).map((a): BomComponent => {
    const [owner, ...rest] = a.action.split("/");
    const repo = rest[0];
    // purl type "github": owner/repo@ref, with an action in a sub-directory as the #subpath.
    const sub = rest.slice(1).map(encodeURIComponent).join("/");
    const ref = `pkg:github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}@${encodeURIComponent(a.ref)}${sub ? `#${sub}` : ""}`;
    const properties: Property[] = [
      { name: "ai-drudge:usage", value: "ci-action" },
      { name: "ai-drudge:action:pinned-to-commit", value: String(a.pinned) },
    ];
    // The tag is what the workflow comment says the commit is; this tool does not verify it.
    if (a.tag) properties.push({ name: "ai-drudge:action:declared-tag", value: a.tag });
    properties.push({ name: "ai-drudge:action:workflows", value: a.workflows.join(", ") });
    return {
      type: "application",
      "bom-ref": ref,
      group: owner,
      name: rest.join("/"),
      version: a.ref,
      description: `GitHub Action run by ${a.workflows.join(", ")}`,
      scope: "excluded",
      purl: ref,
      externalReferences: [{ type: "vcs", url: `https://github.com/${owner}/${repo}` }],
      properties,
    };
  });
}

const origin = (url: string): string => new URL(url).origin;

/** External services the pipeline and the deployed site depend on at run time. */
export function services(site: string): BomService[] {
  const noAuthIn = (description: string): BomService["data"] => [{ flow: "inbound", classification: "public", description }];
  return [
    {
      "bom-ref": "service:github-pages",
      provider: { name: "GitHub", url: ["https://pages.github.com/"] },
      name: "GitHub Pages",
      description: "Hosts the static site and its generated JSON. Readers' browsers talk to this origin only; nothing is sent back (bookmarks and settings stay in localStorage).",
      endpoints: [site],
      authenticated: false,
      "x-trust-boundary": true,
      data: [{ flow: "outbound", classification: "public", description: "Site files and the generated edition (headlines, links, feed health)." }],
    },
    {
      "bom-ref": "service:github-actions",
      provider: { name: "GitHub", url: ["https://github.com/features/actions"] },
      name: "GitHub Actions",
      description: "Runs the scheduled data build, the gate, the site build and the Pages deployment (.github/workflows). Holds the optional ANTHROPIC_API_KEY secret.",
      endpoints: ["https://api.github.com/"],
      authenticated: true,
      "x-trust-boundary": true,
      data: [{ flow: "bi-directional", classification: "public", description: "Repository contents in; Pages artifact, state snapshot on the data branch and failure issues out." }],
    },
    {
      "bom-ref": "service:anthropic-api",
      provider: { name: "Anthropic", url: ["https://www.anthropic.com/"] },
      name: "Anthropic Messages API",
      description: "OPTIONAL. Writes the Daily Brief when ANTHROPIC_API_KEY is configured; without a key (or on any failure) a deterministic brief is published instead. One request per data build.",
      endpoints: [ANTHROPIC_MESSAGES_URL],
      authenticated: true,
      "x-trust-boundary": true,
      data: [{ flow: "bi-directional", classification: "public", description: "Out: titles and summaries of already-public headlines. In: the brief text. No reader data exists to send." }],
      properties: [
        { name: "ai-drudge:service:optional", value: "true" },
        { name: "ai-drudge:service:model", value: BRIEF_MODEL },
      ],
    },
    {
      "bom-ref": "service:yahoo-finance",
      provider: { name: "Yahoo", url: ["https://finance.yahoo.com/"] },
      name: "Yahoo Finance chart API",
      description: "Stock quotes for the ticker, fetched at build time. A failed symbol is published as an empty quote; the build never depends on it.",
      endpoints: YAHOO_HOSTS.map((h) => `https://${h}/v8/finance/chart/`),
      authenticated: false,
      "x-trust-boundary": true,
      data: noAuthIn("Public delayed quotes for eight symbols."),
    },
    {
      "bom-ref": "service:google-news",
      provider: { name: "Google", url: ["https://news.google.com/"] },
      name: "Google News RSS and link resolver",
      description: "Query feeds listed in the source registry, and the resolver that turns Google News wrapper links into publisher links (results are cached in the pipeline state).",
      endpoints: [`${origin(BATCH_URL)}/rss/search`, BATCH_URL],
      authenticated: false,
      "x-trust-boundary": true,
      data: noAuthIn("Public search results (headline, link, outlet)."),
    },
    {
      "bom-ref": "service:hacker-news-api",
      provider: { name: "Algolia / Y Combinator", url: ["https://hn.algolia.com/api"] },
      name: "Hacker News search API",
      description: "Points and comment counts of recent stories, used as an exact-URL ranking signal. Fail-soft: an error yields no signal.",
      endpoints: [HN_API],
      authenticated: false,
      "x-trust-boundary": true,
      data: noAuthIn("Public story metadata."),
    },
    {
      "bom-ref": "service:source-feeds",
      provider: { name: "Publishers in the source registry" },
      name: "Registry sources (feeds, listing pages, JSON APIs)",
      description: "Every active source in scripts/registry is fetched with plain GET requests on each build; the hosts are not enumerated here - docs/SOURCES.md lists each one with its URL. Responses are untrusted input, parsed by the data-pipeline packages.",
      authenticated: false,
      "x-trust-boundary": true,
      data: noAuthIn("Public feeds and pages."),
    },
  ];
}

/** The bill of materials. Pure: the same inputs always give the same document. */
export function buildBom(inputs: SbomInputs): Bom {
  const { pkg } = inputs;
  const site = inputs.siteUrl ?? DEFAULT_SITE_URL;
  const rootRef = `pkg:npm/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
  const npm = npmComponents(inputs);
  const actions = actionComponents(inputs.workflows);
  const nodeLine = (inputs.nodeVersion ?? "").trim().replace(/^v/, "");
  const platform: BomComponent[] = nodeLine
    ? [
        {
          type: "platform",
          "bom-ref": `platform:nodejs@${nodeLine}`,
          name: "Node.js",
          version: nodeLine,
          description: `CI runtime line (.node-version, read by actions/setup-node)${pkg.engines?.node ? `; package.json engines.node is "${pkg.engines.node}"` : ""}. The exact patch release is whatever the runner installs.`,
          scope: "excluded",
          externalReferences: [{ type: "website", url: "https://nodejs.org/" }],
          properties: [{ name: "ai-drudge:usage", value: "ci-runtime" }],
        },
      ]
    : [];
  const svc = services(site);

  const rootPkg = inputs.lock.packages[""] ?? {};
  const direct = [...new Set([...Object.keys(rootPkg.dependencies ?? pkg.dependencies ?? {}), ...Object.keys(rootPkg.devDependencies ?? pkg.devDependencies ?? {})])]
    .map((n) => npm.refByPath.get(`node_modules/${n}`))
    .filter((x): x is string => x !== undefined);
  const dependencies: Bom["dependencies"] = [
    { ref: rootRef, dependsOn: [...new Set([...direct, ...actions.map((a) => a["bom-ref"]), ...platform.map((p) => p["bom-ref"]), ...svc.map((s) => s["bom-ref"])])].sort(cmp) },
    ...[...npm.dependsOn.entries()].sort((a, b) => cmp(a[0], b[0])).map(([ref, deps]) => ({ ref, dependsOn: [...deps].sort(cmp) })),
  ];

  const body = {
    metadata: {
      lifecycles: [{ phase: "pre-build" }],
      tools: { components: [{ type: "application" as const, name: TOOL_NAME, version: TOOL_VERSION }] },
      component: {
        type: "application" as const,
        "bom-ref": rootRef,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description ?? "AI DRUDGE V2: static AI news aggregator (build pipeline + single-page site on GitHub Pages)",
        externalReferences: [{ type: "website", url: site }],
      },
      properties: [
        { name: "ai-drudge:sbom:sources", value: "package-lock.json, node_modules/*/package.json (licences), .github/workflows/*.yml, .node-version" },
        { name: "ai-drudge:sbom:not-covered", value: "the GitHub-hosted runner image (ubuntu-latest, unpinned) and the npm CLI bundled with Node.js" },
        { name: "ai-drudge:sbom:lockfile-version", value: String(inputs.lock.lockfileVersion ?? "") },
      ],
    },
    components: [...npm.components, ...actions, ...platform],
    services: svc,
    dependencies,
  };
  const serialNumber = serialNumberFor(JSON.stringify(body));
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    serialNumber,
    version: 1,
    metadata: { ...(inputs.timestamp ? { timestamp: inputs.timestamp } : {}), ...body.metadata },
    components: body.components,
    services: body.services,
    dependencies: body.dependencies,
  };
}

export function serializeBom(bom: Bom): string {
  return `${JSON.stringify(bom, null, 2)}\n`;
}

/**
 * metadata.timestamp for a new document: an explicit value wins; otherwise the existing file's
 * timestamp is kept while the content (serial number) is unchanged, and `now` is used when it changed.
 */
export function resolveTimestamp(serialNumber: string, existing: unknown, explicit: string | null, now: () => Date): string {
  if (explicit) return explicit;
  if (typeof existing === "object" && existing !== null) {
    const e = existing as { serialNumber?: unknown; metadata?: { timestamp?: unknown } };
    const ts = e.metadata?.timestamp;
    if (e.serialNumber === serialNumber && typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return ts;
  }
  return now().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ------------------------------------------------------------------------------------------------
// docs/SBOM.md tables (between markers; a missing marker pair is left alone)
// ------------------------------------------------------------------------------------------------

const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function markdownTables(bom: Bom, pkg: SbomInputs["pkg"]): Record<"TABLE" | "ACTIONS" | "SERVICES", string> {
  const npm = new Map(bom.components.filter((c) => c.type === "library").map((c) => [c.group ? `${c.group}/${c.name}` : c.name, c]));
  const licenseOf = (c: BomComponent | undefined): string => {
    const l = c?.licenses?.[0];
    if (!l) return "?";
    return "expression" in l ? l.expression : "id" in l.license ? l.license.id : l.license.name;
  };
  const direct = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].sort(cmp);
  const usage = (c: BomComponent | undefined): string => c?.properties?.find((p) => p.name === "ai-drudge:usage")?.value ?? "?";
  const table = ["| Package | Resolved | License | Scope | Usage |", "|---------|----------|---------|-------|-------|", ...direct.map((n) => `| \`${n}\` | ${npm.get(n)?.version ?? "?"} | ${licenseOf(npm.get(n))} | ${pkg.dependencies?.[n] ? "runtime" : "dev/build"} | ${usage(npm.get(n))} |`)].join("\n");
  const prop = (c: BomComponent, name: string): string => c.properties?.find((p) => p.name === name)?.value ?? "";
  const actions = [
    "| Action | Pinned commit | Declared tag | Workflows |",
    "|--------|---------------|--------------|-----------|",
    ...bom.components.filter((c) => prop(c, "ai-drudge:usage") === "ci-action").map((c) => `| \`${c.group}/${c.name}\` | \`${c.version}\` | ${prop(c, "ai-drudge:action:declared-tag") || "-"} | ${mdCell(prop(c, "ai-drudge:action:workflows"))} |`),
  ].join("\n");
  const svc = [
    "| Service | Provider | Auth | Data | Endpoints |",
    "|---------|----------|------|------|-----------|",
    ...bom.services.map((s) => `| ${mdCell(s.name)} | ${mdCell(s.provider.name)} | ${s.authenticated ? "yes" : "none"} | ${mdCell(s.data.map((d) => `${d.flow}: ${d.description}`).join(" "))} | ${s.endpoints?.length ? s.endpoints.map((e) => `\`${e.replace(/^https?:\/\//, "")}\``).join(" ") : "see docs/SOURCES.md"} |`),
  ].join("\n");
  return { TABLE: table, ACTIONS: actions, SERVICES: svc };
}

/** Replace the body of each `<!-- SBOM-<NAME>:START -->` ... `<!-- SBOM-<NAME>:END -->` pair that exists; report which did. */
export function refreshMarkdown(md: string, tables: Readonly<Record<string, string>>, date: string | null): { text: string; refreshed: string[]; missing: string[] } {
  let text = md;
  const refreshed: string[] = [];
  const missing: string[] = [];
  for (const [name, body] of Object.entries(tables)) {
    const start = `<!-- SBOM-${name}:START -->`;
    const end = `<!-- SBOM-${name}:END -->`;
    const a = text.indexOf(start);
    const b = text.indexOf(end);
    if (a >= 0 && b > a) {
      text = `${text.slice(0, a)}${start}\n${body}\n${text.slice(b)}`;
      refreshed.push(name);
    } else missing.push(name);
  }
  if (date) text = text.replace(/(_Last regenerated: )[^_]*(_)/, `$1${date}$2`);
  return { text, refreshed, missing };
}

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface SbomArgs {
  out: string;
  md: string | null;
  check: boolean;
  timestamp: string | null;
}

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): SbomArgs {
  const args: SbomArgs = { out: "docs/SBOM.json", md: "docs/SBOM.md", check: false, timestamp: null };
  const epoch = (env.SOURCE_DATE_EPOCH ?? "").trim();
  if (/^\d+$/.test(epoch)) args.timestamp = new Date(Number(epoch) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = argv[i + 1];
    const takes = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      i++;
      return value;
    };
    if (a === "--check") args.check = true;
    else if (a === "--no-md") args.md = null;
    else if (a === "--out") args.out = takes();
    else if (a === "--md") args.md = takes();
    else if (a === "--timestamp") {
      const ts = takes();
      if (Number.isNaN(Date.parse(ts))) throw new Error(`--timestamp is not a date: ${ts}`);
      args.timestamp = ts;
    } else throw new Error(`unknown argument: ${a} (usage: generate-sbom.ts [--check] [--out <file>] [--md <file> | --no-md] [--timestamp <iso>])`);
  }
  return args;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Read everything buildBom needs from a repository checkout. */
export async function loadInputs(root: string): Promise<Omit<SbomInputs, "timestamp">> {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as SbomInputs["lock"];
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as SbomInputs["pkg"];
  const installedLicenses: Record<string, unknown> = {};
  for (const p of Object.keys(lock.packages)) {
    if (!p.startsWith("node_modules/")) continue;
    const installed = await readJson(path.join(root, p, "package.json"));
    if (typeof installed === "object" && installed !== null) {
      const j = installed as { license?: unknown; licenses?: unknown };
      // Legacy `licenses: [{ type }]` is read as its first entry.
      installedLicenses[p] = j.license ?? (Array.isArray(j.licenses) ? j.licenses[0] : undefined) ?? null;
    }
  }
  const dir = path.join(root, ".github/workflows");
  const workflows: Record<string, string> = {};
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (/\.ya?ml$/.test(f)) workflows[f] = await readFile(path.join(dir, f), "utf8");
  }
  const nodeVersion = await readFile(path.join(root, ".node-version"), "utf8").catch(() => null);
  return { pkg, lock, installedLicenses, workflows, nodeVersion };
}

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env, root: string = ROOT, log: (line: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv, env);
  const inputs = await loadInputs(root);
  const outPath = path.resolve(root, args.out);
  const existing = await readJson(outPath);
  const draft = buildBom({ ...inputs, timestamp: null });
  const timestamp = resolveTimestamp(draft.serialNumber, existing, args.timestamp, () => new Date());
  const bom = buildBom({ ...inputs, timestamp });
  const text = serializeBom(bom);
  const summary = `${bom.components.filter((c) => c.type === "library").length} npm packages, ${bom.components.filter((c) => c.type === "application").length} GitHub Actions, ${bom.services.length} services`;

  if (args.check) {
    const current = await readFile(outPath, "utf8").catch(() => null);
    if (current === text) {
      log(`SBOM is current: ${args.out} (${summary}).`);
      return 0;
    }
    log(`SBOM is out of date: ${args.out} does not match package-lock.json / the workflows. Run: npm run sbom`);
    return 1;
  }

  await writeFile(outPath, text);
  log(`Wrote ${args.out} - CycloneDX ${SPEC_VERSION}, ${summary}, serial ${bom.serialNumber}.`);
  if (args.md) {
    const mdPath = path.resolve(root, args.md);
    const md = await readFile(mdPath, "utf8").catch(() => null);
    if (md !== null) {
      const { text: next, refreshed, missing } = refreshMarkdown(md, markdownTables(bom, inputs.pkg), timestamp.slice(0, 10));
      if (next !== md) await writeFile(mdPath, next);
      log(`${args.md}: refreshed ${refreshed.length ? refreshed.map((n) => `SBOM-${n}`).join(", ") : "nothing"}${missing.length ? `; no markers for ${missing.map((n) => `SBOM-${n}`).join(", ")}` : ""}.`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`generate-sbom failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
