import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_MESSAGES_URL, BRIEF_MODEL } from "./pipeline/enrich/brief";
import { yahooChartUrl } from "./pipeline/enrich/stocks";
import { BATCH_URL } from "./pipeline/ingest/googleNews";
import { hnEndpoints } from "./pipeline/ingest/signals/hn";
import {
  PIPELINE_PACKAGES,
  SPEC_VERSION,
  buildBom,
  declaredLicense,
  integrityHashes,
  licenseEntry,
  loadInputs,
  main,
  markdownTables,
  packageName,
  parseArgs,
  purlNpm,
  refreshMarkdown,
  resolveDependency,
  resolveTimestamp,
  serialNumberFor,
  serializeBom,
  workflowActions,
  type Bom,
  type BomComponent,
  type SbomInputs,
} from "./generate-sbom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA2 = "949feb2413d6458794dcd2491c4babbbce0c15c1";
// sha512 of the empty input, base64 - a real, checkable integrity value.
const EMPTY_SHA512_B64 = "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";
const EMPTY_SHA512_HEX = "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";

function inputs(over: Partial<SbomInputs> = {}): SbomInputs {
  return {
    pkg: { name: "demo-app", version: "1.2.3", dependencies: { react: "^19.0.0" }, devDependencies: { "fast-xml-parser": "^5.0.0", "@scope/tool": "^1.0.0", vite: "^8.0.0" }, engines: { node: ">=22.15.0" } },
    lock: {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { react: "^19.0.0" }, devDependencies: { "fast-xml-parser": "^5.0.0", "@scope/tool": "^1.0.0", vite: "^8.0.0" } },
        "node_modules/react": { version: "19.3.1", resolved: "https://registry.npmjs.org/react/-/react-19.3.1.tgz", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT", dependencies: { scheduler: "^0.27.0" } },
        "node_modules/scheduler": { version: "0.27.0", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT" },
        "node_modules/fast-xml-parser": { version: "5.12.1", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT", dev: true, dependencies: { strnum: "^2.0.0" } },
        "node_modules/strnum": { version: "2.5.1", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT", dev: true },
        "node_modules/@scope/tool": { version: "1.0.0", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "(MIT OR Apache-2.0)", dev: true, dependencies: { strnum: "^1.0.0", shared: "^3.0.0" }, optionalDependencies: { "@scope/tool-linux-x64": "1.0.0", "@scope/tool-not-in-lock": "1.0.0" }, hasInstallScript: true },
        "node_modules/@scope/tool/node_modules/strnum": { version: "1.9.0", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT", dev: true },
        "node_modules/@scope/tool/node_modules/shared": { version: "3.0.0", license: "Custom Licence v1", dev: true, inBundle: true },
        "node_modules/@scope/tool-linux-x64": { version: "1.0.0", integrity: `sha512-${EMPTY_SHA512_B64}`, license: "MIT", dev: true, optional: true },
        "node_modules/vite": { version: "8.3.8", integrity: `sha512-${EMPTY_SHA512_B64}`, dev: true, dependencies: { shared: "^3.0.0" }, peerDependencies: { react: "*" } },
        "node_modules/shared": { version: "3.0.0", license: "ISC", dev: true },
      },
    },
    installedLicenses: { "node_modules/vite": "MIT", "node_modules/react": "MIT" },
    workflows: {
      "refresh.yml": [
        "jobs:",
        "  build:",
        "    steps:",
        `      - uses: actions/checkout@${SHA} # v7.0.1`,
        `      #  - uses: actions/commented-out@${SHA}`,
        "      - name: Node",
        `        uses: actions/setup-node@${SHA2} # v7.1.0`,
        "      - uses: ./local-action",
        "      - uses: docker://alpine:3.20",
      ].join("\n"),
      "ci.yml": [`      - uses: actions/checkout@${SHA} # v7.0.1`, "      - uses: owner/repo/sub/dir@v3"].join("\n"),
    },
    nodeVersion: "24\n",
    timestamp: null,
    siteUrl: "https://site.sbom-fixture.dev/app/",
    ...over,
  };
}
const byRef = (bom: Bom, ref: string): BomComponent => {
  const c = bom.components.find((x) => x["bom-ref"] === ref);
  assert.ok(c, `component ${ref}`);
  return c;
};
const prop = (c: BomComponent, name: string): string | undefined => c.properties?.find((p) => p.name === name)?.value;
const deps = (bom: Bom, ref: string): string[] | undefined => bom.dependencies.find((d) => d.ref === ref)?.dependsOn;

describe("generate-sbom: pieces", () => {
  it("purl: the scope's @ is percent-encoded", () => {
    assert.equal(purlNpm("react", "19.3.1"), "pkg:npm/react@19.3.1");
    assert.equal(purlNpm("@types/node", "24.19.2"), "pkg:npm/%40types/node@24.19.2");
    assert.equal(purlNpm("@emnapi/core", "2.0.0-beta.2"), "pkg:npm/%40emnapi/core@2.0.0-beta.2");
    assert.equal(packageName("node_modules/a/node_modules/@s/b"), "@s/b");
  });

  it("licences: a known SPDX id, an SPDX expression, anything else as a name - never an unknown id", () => {
    assert.deepEqual(licenseEntry("MIT"), [{ license: { id: "MIT", acknowledgement: "declared" } }]);
    assert.deepEqual(licenseEntry("(MIT OR Apache-2.0)"), [{ expression: "(MIT OR Apache-2.0)", acknowledgement: "declared" }]);
    assert.deepEqual(licenseEntry("Apache-2.0 WITH LLVM-exception"), [{ expression: "Apache-2.0 WITH LLVM-exception", acknowledgement: "declared" }]);
    assert.deepEqual(licenseEntry("SEE LICENSE IN LICENSE.md"), [{ license: { name: "SEE LICENSE IN LICENSE.md", acknowledgement: "declared" } }]);
    assert.deepEqual(licenseEntry("Not-A-Real-Id"), [{ license: { name: "Not-A-Real-Id", acknowledgement: "declared" } }]);
    assert.equal(licenseEntry(null), undefined);
    assert.equal(declaredLicense({ type: "ISC", url: "x" }), "ISC");
    assert.equal(declaredLicense(" MIT "), "MIT");
    assert.equal(declaredLicense(undefined), null);
    assert.equal(declaredLicense(""), null);
  });

  it("hashes: npm integrity (base64) becomes hex with the right algorithm; junk is dropped", () => {
    assert.deepEqual(integrityHashes(`sha512-${EMPTY_SHA512_B64}`), [{ alg: "SHA-512", content: EMPTY_SHA512_HEX }]);
    assert.deepEqual(integrityHashes(`sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk= sha512-${EMPTY_SHA512_B64}`)?.map((h) => h.alg), ["SHA-1", "SHA-512"]);
    assert.equal(integrityHashes(undefined), undefined);
    assert.equal(integrityHashes("md5-abc"), undefined);
  });

  it("dependency resolution follows node's lookup: nested first, then up to the root", () => {
    const pk = inputs().lock.packages;
    assert.equal(resolveDependency("node_modules/@scope/tool", "strnum", pk), "node_modules/@scope/tool/node_modules/strnum");
    assert.equal(resolveDependency("node_modules/fast-xml-parser", "strnum", pk), "node_modules/strnum");
    assert.equal(resolveDependency("node_modules/@scope/tool/node_modules/strnum", "react", pk), "node_modules/react");
    assert.equal(resolveDependency("node_modules/react", "nope", pk), null);
  });

  it("workflow actions: every remote `uses:`, with its pin, its declared tag and the workflows that use it", () => {
    assert.deepEqual(workflowActions(inputs().workflows), [
      { action: "actions/checkout", ref: SHA, pinned: true, tag: "v7.0.1", workflows: ["ci.yml", "refresh.yml"] },
      { action: "actions/setup-node", ref: SHA2, pinned: true, tag: "v7.1.0", workflows: ["refresh.yml"] },
      { action: "owner/repo/sub/dir", ref: "v3", pinned: false, tag: null, workflows: ["ci.yml"] },
    ]);
  });

  it("serial number: a schema-valid UUID derived from the content", () => {
    const a = serialNumberFor("a");
    assert.match(a, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "the pattern of the CycloneDX schema");
    assert.equal(a, serialNumberFor("a"));
    assert.notEqual(a, serialNumberFor("b"));
  });
});

describe("generate-sbom: the document", () => {
  const bom = buildBom(inputs({ timestamp: "2026-11-20T00:00:00Z" }));

  it("has the CycloneDX 1.6 required fields and metadata", () => {
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.specVersion, "1.6");
    assert.equal(SPEC_VERSION, "1.6");
    assert.equal(bom.version, 1);
    assert.equal(bom.$schema, "http://cyclonedx.org/schema/bom-1.6.schema.json");
    assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(bom.metadata.timestamp, "2026-11-20T00:00:00Z");
    assert.deepEqual(bom.metadata.component, {
      type: "application",
      "bom-ref": "pkg:npm/demo-app@1.2.3",
      name: "demo-app",
      version: "1.2.3",
      description: "AI DRUDGE V2: static AI news aggregator (build pipeline + single-page site on GitHub Pages)",
      externalReferences: [{ type: "website", url: "https://site.sbom-fixture.dev/app/" }],
    });
    assert.deepEqual(bom.metadata.tools.components.map((t) => t.name), ["scripts/generate-sbom.ts"]);
    assert.deepEqual(bom.metadata.lifecycles, [{ phase: "pre-build" }]);
  });

  it("npm components: purl, group, licence, hash, distribution, and runtime / build / optional scope", () => {
    assert.deepEqual(byRef(bom, "pkg:npm/react@19.3.1"), {
      type: "library",
      "bom-ref": "pkg:npm/react@19.3.1",
      name: "react",
      version: "19.3.1",
      scope: "required",
      licenses: [{ license: { id: "MIT", acknowledgement: "declared" } }],
      purl: "pkg:npm/react@19.3.1",
      hashes: [{ alg: "SHA-512", content: EMPTY_SHA512_HEX }],
      externalReferences: [{ type: "distribution", url: "https://registry.npmjs.org/react/-/react-19.3.1.tgz" }],
      properties: [
        { name: "ai-drudge:usage", value: "browser-runtime" },
        { name: "cdx:npm:package:development", value: "false" },
        { name: "cdx:npm:package:path", value: "node_modules/react" },
      ],
    });
    assert.equal(byRef(bom, "pkg:npm/scheduler@0.27.0").scope, "required", "a transitive runtime dependency is runtime");
    const tool = byRef(bom, "pkg:npm/%40scope/tool@1.0.0");
    assert.deepEqual([tool.group, tool.name, tool.scope, tool.purl], ["@scope", "tool", "excluded", "pkg:npm/%40scope/tool@1.0.0"]);
    assert.deepEqual(tool.licenses, [{ expression: "(MIT OR Apache-2.0)", acknowledgement: "declared" }]);
    assert.equal(prop(tool, "ai-drudge:npm:has-install-script"), "true");
    assert.equal(prop(tool, "cdx:npm:package:development"), "true");
    assert.equal(byRef(bom, "pkg:npm/%40scope/tool-linux-x64@1.0.0").scope, "optional", "a platform binary may not be installed");
  });

  it("the licence comes from the installed package.json when there is one, else from the lockfile", () => {
    assert.deepEqual(byRef(bom, "pkg:npm/vite@8.3.8").licenses, [{ license: { id: "MIT", acknowledgement: "declared" } }], "the lockfile entry has no licence; the installed package declares MIT");
    assert.deepEqual(byRef(bom, "pkg:npm/strnum@2.5.1").licenses, [{ license: { id: "MIT", acknowledgement: "declared" } }], "not installed: the lockfile's copy");
    const noLicence = buildBom(inputs({ installedLicenses: { "node_modules/react": null } }));
    assert.deepEqual(byRef(noLicence, "pkg:npm/react@19.3.1").licenses, [{ license: { id: "MIT", acknowledgement: "declared" } }], "an installed package without the field falls back to the lockfile");
    assert.equal(byRef(buildBom(inputs({ installedLicenses: {} })), "pkg:npm/vite@8.3.8").licenses, undefined, "no licence anywhere: no licences entry, not a guess");
  });

  it("one name@version installed at two paths is one component; a bundled copy without a hash says so", () => {
    const shared = bom.components.filter((c) => c.name === "shared");
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0].properties?.filter((p) => p.name === "cdx:npm:package:path").map((p) => p.value), ["node_modules/@scope/tool/node_modules/shared", "node_modules/shared"]);
    assert.equal(prop(shared[0], "cdx:npm:package:bundled"), "true");
    assert.equal(shared[0].hashes, undefined);
    assert.deepEqual(shared[0].licenses, [{ license: { name: "Custom Licence v1", acknowledgement: "declared" } }]);
    const refs = [...bom.components.map((c) => c["bom-ref"]), ...bom.services.map((s) => s["bom-ref"]), bom.metadata.component["bom-ref"]];
    assert.equal(new Set(refs).size, refs.length, "bom-refs are unique");
  });

  it("usage: what the feed-parsing process loads is labelled data-pipeline, the rest build-tooling", () => {
    assert.equal(prop(byRef(bom, "pkg:npm/fast-xml-parser@5.12.1"), "ai-drudge:usage"), "data-pipeline");
    assert.equal(prop(byRef(bom, "pkg:npm/strnum@2.5.1"), "ai-drudge:usage"), "data-pipeline", "inherited through the dependency graph");
    assert.equal(prop(byRef(bom, "pkg:npm/strnum@1.9.0"), "ai-drudge:usage"), "build-tooling", "the other copy belongs to a build tool");
    assert.equal(prop(byRef(bom, "pkg:npm/vite@8.3.8"), "ai-drudge:usage"), "build-tooling");
  });

  it("GitHub Actions are components pinned by commit; an unpinned one is flagged, a sub-directory action keeps its path", () => {
    assert.deepEqual(byRef(bom, `pkg:github/actions/checkout@${SHA}`), {
      type: "application",
      "bom-ref": `pkg:github/actions/checkout@${SHA}`,
      group: "actions",
      name: "checkout",
      version: SHA,
      description: "GitHub Action run by ci.yml, refresh.yml",
      scope: "excluded",
      purl: `pkg:github/actions/checkout@${SHA}`,
      externalReferences: [{ type: "vcs", url: "https://github.com/actions/checkout" }],
      properties: [
        { name: "ai-drudge:usage", value: "ci-action" },
        { name: "ai-drudge:action:pinned-to-commit", value: "true" },
        { name: "ai-drudge:action:declared-tag", value: "v7.0.1" },
        { name: "ai-drudge:action:workflows", value: "ci.yml, refresh.yml" },
      ],
    });
    const sub = byRef(bom, "pkg:github/owner/repo@v3#sub/dir");
    assert.deepEqual([sub.group, sub.name, sub.version, prop(sub, "ai-drudge:action:pinned-to-commit")], ["owner", "repo/sub/dir", "v3", "false"]);
    assert.equal(bom.components.filter((c) => prop(c, "ai-drudge:usage") === "ci-action").length, 3, "commented-out, local and docker uses are not components");
  });

  it("Node.js is a platform component taken from .node-version; without the file there is none", () => {
    const node = byRef(bom, "platform:nodejs@24");
    assert.deepEqual([node.type, node.name, node.version, node.scope], ["platform", "Node.js", "24", "excluded"]);
    assert.match(node.description ?? "", /engines\.node is ">=22\.15\.0"/);
    assert.equal(buildBom(inputs({ nodeVersion: null })).components.some((c) => c.type === "platform"), false);
  });

  it("services: the five external run-time services plus CI and the registry feeds, with the endpoints the code uses", () => {
    const names = bom.services.map((s) => s["bom-ref"]);
    assert.deepEqual(names, ["service:github-pages", "service:github-actions", "service:anthropic-api", "service:yahoo-finance", "service:google-news", "service:hacker-news-api", "service:source-feeds"]);
    const svc = (ref: string): Bom["services"][number] => bom.services.find((s) => s["bom-ref"] === ref) as Bom["services"][number];
    assert.deepEqual(svc("service:github-pages").endpoints, ["https://site.sbom-fixture.dev/app/"]);
    assert.deepEqual(svc("service:anthropic-api").endpoints, [ANTHROPIC_MESSAGES_URL]);
    assert.equal(svc("service:anthropic-api").authenticated, true);
    assert.match(svc("service:anthropic-api").description, /^OPTIONAL\./);
    assert.deepEqual(svc("service:anthropic-api").properties, [{ name: "ai-drudge:service:optional", value: "true" }, { name: "ai-drudge:service:model", value: BRIEF_MODEL }]);
    // The endpoints are derived from the code's own constants: a request URL the code builds must fall under one of them.
    assert.ok(svc("service:yahoo-finance").endpoints?.some((e) => yahooChartUrl("NVDA").startsWith(e)));
    assert.ok(hnEndpoints(0).every((u) => u.startsWith(svc("service:hacker-news-api").endpoints?.[0] ?? "x")));
    assert.ok(svc("service:google-news").endpoints?.includes(BATCH_URL));
    assert.ok(svc("service:google-news").endpoints?.includes("https://news.google.com/rss/search"));
    assert.equal(svc("service:source-feeds").endpoints, undefined);
    for (const s of bom.services) {
      assert.equal(s["x-trust-boundary"], true);
      assert.ok(s.data.length >= 1 && s.data.every((d) => ["inbound", "outbound", "bi-directional"].includes(d.flow) && d.classification === "public"));
      assert.ok(s.provider.name && s.description);
    }
    assert.deepEqual(bom.services.filter((s) => s.authenticated).map((s) => s.name), ["GitHub Actions", "Anthropic Messages API"]);
  });

  it("dependency graph: the root depends on its direct packages, the actions, Node.js and the services; packages on what the lockfile resolves", () => {
    const root = deps(bom, "pkg:npm/demo-app@1.2.3") ?? [];
    for (const ref of ["pkg:npm/react@19.3.1", "pkg:npm/fast-xml-parser@5.12.1", "pkg:npm/%40scope/tool@1.0.0", "pkg:npm/vite@8.3.8", `pkg:github/actions/checkout@${SHA}`, "platform:nodejs@24", "service:anthropic-api", "service:github-pages"]) {
      assert.ok(root.includes(ref), ref);
    }
    assert.ok(!root.includes("pkg:npm/scheduler@0.27.0"), "transitive packages are not direct");
    assert.deepEqual(deps(bom, "pkg:npm/react@19.3.1"), ["pkg:npm/scheduler@0.27.0"]);
    assert.deepEqual(deps(bom, "pkg:npm/%40scope/tool@1.0.0"), ["pkg:npm/%40scope/tool-linux-x64@1.0.0", "pkg:npm/shared@3.0.0", "pkg:npm/strnum@1.9.0"], "nested copies win; an optional dependency that is not in the lockfile is skipped");
    assert.deepEqual(deps(bom, "pkg:npm/fast-xml-parser@5.12.1"), ["pkg:npm/strnum@2.5.1"]);
    assert.deepEqual(deps(bom, "pkg:npm/vite@8.3.8"), ["pkg:npm/react@19.3.1", "pkg:npm/shared@3.0.0"], "an installed peer is a dependency");
    assert.deepEqual(deps(bom, "pkg:npm/scheduler@0.27.0"), [], "every npm package has an entry, even an empty one");
    const all = new Set([...bom.components.map((c) => c["bom-ref"]), ...bom.services.map((s) => s["bom-ref"]), bom.metadata.component["bom-ref"]]);
    for (const d of bom.dependencies) {
      assert.ok(all.has(d.ref), d.ref);
      for (const x of d.dependsOn) assert.ok(all.has(x), `${d.ref} -> ${x}`);
    }
  });

  it("is deterministic: key order of the inputs does not matter, components are sorted, and the timestamp is not part of the serial", () => {
    const base = inputs();
    const reversed = inputs({ lock: { ...base.lock, packages: Object.fromEntries(Object.entries(base.lock.packages).reverse()) }, workflows: Object.fromEntries(Object.entries(base.workflows).reverse()) });
    const a = buildBom(base);
    assert.equal(serializeBom(a), serializeBom(buildBom(reversed)));
    assert.equal("timestamp" in a.metadata, false, "no timestamp unless one is given: the content has no clock");
    assert.equal(a.serialNumber, bom.serialNumber, "the same content at another time is the same document");
    const libs = a.components.filter((c) => c.type === "library").map((c) => c["bom-ref"]);
    assert.deepEqual(libs, [...libs].sort());
    const changed = inputs();
    changed.lock.packages["node_modules/react"].version = "19.3.2";
    assert.notEqual(buildBom(changed).serialNumber, a.serialNumber);
    assert.ok(serializeBom(a).endsWith("}\n"));
  });
});

describe("generate-sbom: timestamp, Markdown, arguments", () => {
  const now = (): Date => new Date("2026-12-01T10:11:12.345Z");

  it("the timestamp is kept while the content is unchanged and renewed when it changes", () => {
    const existing = { serialNumber: "urn:uuid:same", metadata: { timestamp: "2026-11-20T00:00:00Z" } };
    assert.equal(resolveTimestamp("urn:uuid:same", existing, null, now), "2026-11-20T00:00:00Z");
    assert.equal(resolveTimestamp("urn:uuid:other", existing, null, now), "2026-12-01T10:11:12Z");
    assert.equal(resolveTimestamp("urn:uuid:same", undefined, null, now), "2026-12-01T10:11:12Z");
    assert.equal(resolveTimestamp("urn:uuid:same", { serialNumber: "urn:uuid:same", metadata: { timestamp: "garbage" } }, null, now), "2026-12-01T10:11:12Z");
    assert.equal(resolveTimestamp("urn:uuid:same", existing, "2026-01-01T00:00:00Z", now), "2026-01-01T00:00:00Z", "an explicit timestamp wins");
  });

  it("Markdown tables: direct dependencies, actions, services; only marker pairs that exist are rewritten", () => {
    const i = inputs();
    const tables = markdownTables(buildBom(i), i.pkg);
    assert.match(tables.TABLE, /\| `react` \| 19\.3\.1 \| MIT \| runtime \| browser-runtime \|/);
    assert.match(tables.TABLE, /\| `fast-xml-parser` \| 5\.12\.1 \| MIT \| dev\/build \| data-pipeline \|/);
    assert.match(tables.TABLE, /\| `@scope\/tool` \| 1\.0\.0 \| \(MIT OR Apache-2\.0\) \| dev\/build \| build-tooling \|/);
    assert.ok(tables.ACTIONS.includes(`| \`actions/checkout\` | \`${SHA}\` | v7.0.1 | ci.yml, refresh.yml |`));
    assert.match(tables.SERVICES, /\| Anthropic Messages API \| Anthropic \| yes \|/);
    assert.match(tables.SERVICES, /see docs\/SOURCES\.md \|$/m);
    const md = ["# SBOM", "_Last regenerated: 2026-07-06_", "<!-- SBOM-TABLE:START -->", "old | table", "<!-- SBOM-TABLE:END -->", "hand-written text", "<!-- SBOM-SERVICES:START -->", "<!-- SBOM-SERVICES:END -->"].join("\n");
    const out = refreshMarkdown(md, tables, "2026-11-20");
    assert.deepEqual([out.refreshed, out.missing], [["TABLE", "SERVICES"], ["ACTIONS"]]);
    assert.ok(out.text.includes("_Last regenerated: 2026-11-20_"));
    assert.ok(!out.text.includes("old | table") && out.text.includes("hand-written text"));
    assert.ok(out.text.includes(`<!-- SBOM-TABLE:START -->\n${tables.TABLE}\n<!-- SBOM-TABLE:END -->`));
    assert.equal(refreshMarkdown(out.text, tables, "2026-11-20").text, out.text, "idempotent");
  });

  it("arguments", () => {
    assert.deepEqual(parseArgs([], {}), { out: "docs/SBOM.json", md: "docs/SBOM.md", check: false, timestamp: null });
    assert.deepEqual(parseArgs(["--check", "--out", "x.json", "--no-md"], {}), { out: "x.json", md: null, check: true, timestamp: null });
    assert.equal(parseArgs([], { SOURCE_DATE_EPOCH: "1795132800" }).timestamp, "2026-11-20T00:00:00Z");
    assert.equal(parseArgs(["--timestamp", "2026-01-02T03:04:05Z"], { SOURCE_DATE_EPOCH: "1795132800" }).timestamp, "2026-01-02T03:04:05Z");
    assert.throws(() => parseArgs(["--timestamp", "soon"], {}), /not a date/);
    assert.throws(() => parseArgs(["--out"], {}), /--out needs a value/);
    assert.throws(() => parseArgs(["--wat"], {}), /unknown argument: --wat/);
  });

  it("main: writes the file, then --check passes; a changed lockfile makes --check fail; rewriting keeps bytes identical", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-"));
    try {
      const i = inputs();
      fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      fs.mkdirSync(path.join(dir, "docs"));
      fs.mkdirSync(path.join(dir, "node_modules/vite"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules/vite/package.json"), JSON.stringify({ name: "vite", licenses: [{ type: "MIT" }] }));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(i.pkg));
      fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(i.lock));
      fs.writeFileSync(path.join(dir, ".node-version"), "24\n");
      for (const [f, text] of Object.entries(i.workflows)) fs.writeFileSync(path.join(dir, ".github/workflows", f), text);
      fs.writeFileSync(path.join(dir, "docs/SBOM.md"), "_Last regenerated: 2026-07-06_\n<!-- SBOM-ACTIONS:START -->\n<!-- SBOM-ACTIONS:END -->\n");
      const lines: string[] = [];
      const log = (l: string): void => void lines.push(l);

      assert.equal(await main(["--check"], {}, dir, log), 1, "no file yet");
      assert.equal(await main([], {}, dir, log), 0);
      const first = fs.readFileSync(path.join(dir, "docs/SBOM.json"), "utf8");
      const bom = JSON.parse(first) as Bom;
      assert.equal(bom.specVersion, "1.6");
      assert.deepEqual(byRef(bom, "pkg:npm/vite@8.3.8").licenses, [{ license: { id: "MIT", acknowledgement: "declared" } }], "read from the installed package.json (legacy `licenses` array)");
      assert.ok(typeof bom.metadata.timestamp === "string" && !Number.isNaN(Date.parse(bom.metadata.timestamp)));
      assert.match(fs.readFileSync(path.join(dir, "docs/SBOM.md"), "utf8"), /`actions\/checkout`/);
      assert.ok(lines.some((l) => /refreshed SBOM-ACTIONS; no markers for SBOM-TABLE, SBOM-SERVICES/.test(l)));

      assert.equal(await main(["--check"], {}, dir, log), 0);
      assert.equal(await main([], {}, dir, log), 0);
      assert.equal(fs.readFileSync(path.join(dir, "docs/SBOM.json"), "utf8"), first, "regenerating without a change rewrites the same bytes (the timestamp is kept)");

      const lock = JSON.parse(JSON.stringify(i.lock)) as SbomInputs["lock"];
      lock.packages["node_modules/react"].version = "19.3.2";
      fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock));
      assert.equal(await main(["--check"], {}, dir, log), 1);
      assert.ok(lines.some((l) => /SBOM is out of date/.test(l)));
      assert.equal(fs.readFileSync(path.join(dir, "docs/SBOM.json"), "utf8"), first, "--check never writes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generate-sbom: this repository", async () => {
  const real = await loadInputs(ROOT);
  const bom = buildBom({ ...real, timestamp: null });
  const libs = bom.components.filter((c) => c.type === "library");

  it("every lockfile package is a component with a purl, a declared SPDX licence and (unless bundled) a SHA-512", () => {
    const lockRefs = new Set(Object.entries(real.lock.packages).filter(([p]) => p.startsWith("node_modules/")).map(([p, m]) => purlNpm(packageName(p), m.version as string)));
    assert.deepEqual(new Set(libs.map((c) => c["bom-ref"])), lockRefs);
    for (const c of libs) {
      assert.equal(c.purl, c["bom-ref"]);
      assert.match(c.purl ?? "", /^pkg:npm\/(?:%40[^/@]+\/)?[^/@]+@[^@]+$/);
      const l = c.licenses?.[0];
      assert.ok(l && ("expression" in l || "id" in l.license), `${c["bom-ref"]}: licence is missing or not a known SPDX id (add it to SPDX_IDS after checking it)`);
      if (prop(c, "cdx:npm:package:bundled") !== "true") assert.ok(c.hashes?.some((h) => h.alg === "SHA-512" && /^[0-9a-f]{128}$/.test(h.content)), `${c["bom-ref"]}: no SHA-512`);
    }
  });

  it("scope follows package.json: what ships to the browser is required, everything else is not", () => {
    const required = libs.filter((c) => c.scope === "required").map((c) => c.name).sort();
    for (const name of Object.keys(real.pkg.dependencies ?? {})) assert.ok(required.includes(name), name);
    for (const name of Object.keys(real.pkg.devDependencies ?? {})) assert.ok(!required.includes(name), `${name} is a devDependency`);
    assert.ok(required.length <= 6, `unexpectedly many runtime packages: ${required.join(", ")}`);
  });

  it("the data-pipeline label covers every third-party package scripts/ imports", () => {
    const imported = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          for (const m of fs.readFileSync(full, "utf8").matchAll(/^\s*(?:import|export)\s[^"']*?from\s+["']([^"'.][^"']*)["']/gm)) {
            if (!m[1].startsWith("node:")) imported.add(m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0]);
          }
        }
      }
    };
    walk(path.join(ROOT, "scripts"));
    assert.ok(imported.size >= 1, "the scan found the XML parser import");
    for (const name of imported) assert.ok(PIPELINE_PACKAGES.includes(name), `scripts/ imports "${name}": add it to PIPELINE_PACKAGES`);
    for (const name of PIPELINE_PACKAGES) assert.equal(prop(libs.find((c) => (c.group ? `${c.group}/${c.name}` : c.name) === name) as BomComponent, "ai-drudge:usage"), "data-pipeline");
  });

  it("every action the workflows use is a component pinned to a commit, with the tag its comment declares", () => {
    const actions = bom.components.filter((c) => prop(c, "ai-drudge:usage") === "ci-action");
    const used = new Set(Object.values(real.workflows).flatMap((text) => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@/gm)].map((m) => m[1])));
    assert.deepEqual(new Set(actions.map((c) => `${c.group}/${c.name}`)), used);
    assert.ok(actions.length >= 5);
    for (const a of actions) {
      assert.match(a.version, /^[0-9a-f]{40}$/, `${a.name} is not pinned to a commit`);
      assert.match(prop(a, "ai-drudge:action:declared-tag") ?? "", /^v\d+\.\d+\.\d+$/, `${a.name}: no "# vX.Y.Z" comment`);
    }
  });

  it("names nobody and is stable across two builds", () => {
    const text = serializeBom(bom);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.(?:com|org|net|io)\b(?!\/)/i, "no e-mail address");
    assert.equal(text, serializeBom(buildBom({ ...real, timestamp: null })));
    assert.equal(bom.services.length, 7);
  });
});
