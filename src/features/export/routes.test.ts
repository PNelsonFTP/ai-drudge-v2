// The eight WP10 route modules as the shell loads them: `export default route` of each
// src/features/<name>/route.tsx, rendered through the RouteModule's own Component.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { ROUTE_NAMES, type Route, type RouteModule, type RouteName } from "../../app/services";
import { a11yProblems, renderRoute, tagTexts } from "./kit/ssr.testkit";

// route.tsx files import their stylesheets (Vite handles those); node needs them stubbed.
// module.registerHooks exists from node 22.15; on an older 22.x the route-loading tests are skipped.
const canStubCss = typeof nodeModule.registerHooks === "function";
if (canStubCss) {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return nextLoad(url, context);
    },
  });
}
const needsStub = canStubCss ? {} : { skip: "needs node >= 22.15 (module.registerHooks) to stub CSS imports" };

const FEATURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE: Record<Exclude<RouteName, "home">, { route: Route; title: string; heading: RegExp }> = {
  section: { route: { name: "section", id: "ai_security" }, title: "AI SECURITY", heading: /^AI SECURITY \d+ stories$/ },
  search: { route: { name: "search", q: "nvidia" }, title: "Search: nvidia", heading: /^Search \d+ stories$/ },
  new: { route: { name: "new" }, title: "New since your last visit", heading: /^New since your last visit/ },
  watch: { route: { name: "watch" }, title: "Watchlist", heading: /^Watchlist/ },
  saved: { route: { name: "saved", tab: "later" }, title: "Read later", heading: /^Read later 0 items$/ },
  sources: { route: { name: "sources" }, title: "Sources", heading: /^Sources \d+\/\d+ OK/ },
  settings: { route: { name: "settings" }, title: "Settings", heading: /^Settings/ },
  about: { route: { name: "about" }, title: "About", heading: /^About AI DRUDGE/ },
};

const NAMES = Object.keys(SAMPLE) as Exclude<RouteName, "home">[];

async function load(name: string): Promise<RouteModule> {
  const mod = (await import(`../${name}/route`)) as { default: RouteModule };
  return mod.default;
}

describe("WP10 route modules", () => {
  it("cover every route except home", () => {
    assert.deepEqual([...NAMES].sort(), ROUTE_NAMES.filter((n) => n !== "home").sort());
  });

  for (const name of NAMES) {
    it(`${name}/route.tsx default-exports the "${name}" RouteModule and renders`, needsStub, async () => {
      const route = await load(name);
      assert.equal(route.name, name);
      assert.equal(typeof route.Component, "function");
      const sample = SAMPLE[name];
      assert.equal(typeof route.title === "function" ? route.title(sample.route) : route.title, sample.title);

      const s = createFakeServices({ route: sample.route });
      await s.edition.loadRiver();
      await s.sourcesData.load();
      const html = renderRoute(s, route.Component, sample.route);
      const h2 = tagTexts(html, "h2");
      assert.equal(h2.length, 1);
      assert.match(h2[0], sample.heading);
      assert.match(html, /^<section class="sp-page" aria-labelledby="[^"]+">/, "a labelled region inside the shell's <main>");
      assert.deepEqual(a11yProblems(html), []);
    });
  }

  it("section and saved titles follow the route", needsStub, async () => {
    const section = await load("section");
    const saved = await load("saved");
    const search = await load("search");
    const title = (m: RouteModule, r: Route): string => (typeof m.title === "function" ? m.title(r) : m.title);
    assert.equal(title(section, { name: "section", id: "money" }), "MARKETS & DEALS");
    assert.equal(title(saved, { name: "saved", tab: "bookmarks" }), "Bookmarks");
    assert.equal(title(search, { name: "search", q: "" }), "Search");
  });

  it("every route file loads the shared stylesheet; 'export' is a component directory, not a route", () => {
    for (const name of NAMES) {
      const src = fs.readFileSync(path.join(FEATURES, name, "route.tsx"), "utf8");
      assert.ok(src.includes('import "../export/kit/kit.css";'), `${name}/route.tsx imports kit.css`);
      assert.ok(/export default route;/.test(src), name);
    }
    assert.equal(fs.existsSync(path.join(FEATURES, "export", "route.tsx")), false);
    // The sheet stays off the first-paint path: the entry does not import it; the masthead's briefing
    // dialog (lazy chunk) brings it along instead.
    assert.ok(!/^\s*import\s+"[^"]*features\/export\/kit\/kit\.css";/m.test(fs.readFileSync(path.join(FEATURES, "..", "main.tsx"), "utf8")), "main.tsx must not import kit.css");
    assert.ok(fs.readFileSync(path.join(FEATURES, "chrome", "BriefingDialog.tsx"), "utf8").includes('import "../export/kit/kit.css";'));
  });
});
