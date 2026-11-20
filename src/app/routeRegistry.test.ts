import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildRouteRegistry, isRouteModule, makePage, routeNameFromPath, routeRegistry, type RouteLoader } from "./routeRegistry";
import type { Route, RouteModule, RouteName } from "./services";

const mod = (name: RouteName, label: string = name): { default: RouteModule } => ({
  default: { name, title: `${label} title`, Component: ({ route }: { route: Route }) => createElement("p", { "data-route": route.name }, label) },
});

describe("routeNameFromPath", () => {
  it("reads the route name from a feature path", () => {
    assert.equal(routeNameFromPath("../features/home/route.tsx"), "home");
    assert.equal(routeNameFromPath("/src/features/settings/route.tsx"), "settings");
    assert.equal(routeNameFromPath("../features/saved/route.ts"), "saved");
  });

  it("ignores directories that are not routes (chrome, headline) and other files", () => {
    assert.equal(routeNameFromPath("../features/chrome/route.tsx"), null);
    assert.equal(routeNameFromPath("../features/headline/route.tsx"), null);
    assert.equal(routeNameFromPath("../features/home/HomePage.tsx"), null);
    assert.equal(routeNameFromPath("../features/home/sub/route.tsx"), null);
    assert.equal(routeNameFromPath("../other/home/route.tsx"), null);
  });
});

describe("isRouteModule", () => {
  it("accepts a RouteModule with a string or function title", () => {
    assert.ok(isRouteModule(mod("home").default));
    assert.ok(isRouteModule({ ...mod("section").default, title: () => "x" }));
  });

  it("rejects everything else", () => {
    for (const bad of [null, undefined, 1, "home", {}, { name: "home" }, { name: "nope", Component: () => null, title: "x" }, { name: "home", Component: "div", title: "x" }, { name: "home", Component: () => null }]) {
      assert.equal(isRouteModule(bad), false, JSON.stringify(bad));
    }
  });
});

describe("buildRouteRegistry", () => {
  it("is empty and harmless without sources (features not landed yet)", () => {
    const registry = buildRouteRegistry({});
    assert.deepEqual(registry.names(), []);
    assert.equal(registry.page("home"), null);
    assert.doesNotThrow(() => registry.preload("settings"));
    assert.deepEqual(registry.problems(), []);
  });

  it("registers eager pages; they render with the route", () => {
    const registry = buildRouteRegistry({ eager: { "../features/home/route.tsx": mod("home") } });
    assert.deepEqual(registry.names(), ["home"]);
    const Page = registry.page("home");
    assert.ok(Page);
    assert.equal(renderToStaticMarkup(createElement(Page, { route: { name: "home" } })), '<p data-route="home">home</p>');
  });

  it("registers lazy pages without loading them; names() follows ROUTE_NAMES order", () => {
    let loads = 0;
    const loader = (name: RouteName): RouteLoader => async () => {
      loads++;
      return mod(name);
    };
    const registry = buildRouteRegistry({
      eager: { "../features/home/route.tsx": mod("home") },
      lazy: { "../features/settings/route.tsx": loader("settings"), "../features/section/route.tsx": loader("section"), "../features/chrome/route.tsx": loader("about") },
    });
    assert.deepEqual(registry.names(), ["home", "section", "settings"]);
    assert.ok(registry.page("settings"));
    assert.equal(registry.page("about"), null, "a route file in a non-route directory is ignored");
    assert.equal(loads, 0);
  });

  it("preload() downloads once, however often it is called", async () => {
    let loads = 0;
    const registry = buildRouteRegistry({
      lazy: {
        "../features/watch/route.tsx": async () => {
          loads++;
          return mod("watch");
        },
      },
    });
    registry.preload("watch");
    registry.preload("watch");
    registry.preload("home");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, 1);
  });

  it("an eager page wins over a lazy one of the same name", () => {
    const registry = buildRouteRegistry({
      eager: { "../features/home/route.tsx": mod("home", "eager") },
      lazy: { "../features/home/route.tsx": async () => mod("home", "lazy") },
    });
    const Page = registry.page("home");
    assert.ok(Page);
    assert.match(renderToStaticMarkup(createElement(Page, { route: { name: "home" } })), />eager</);
  });

  it("reports broken eager modules instead of throwing at startup", () => {
    const registry = buildRouteRegistry({
      eager: {
        "../features/home/route.tsx": { default: { nope: true } },
        "../features/about/route.tsx": mod("watch"),
        "../features/sources/route.tsx": mod("sources"),
      },
    });
    assert.deepEqual(registry.names(), ["sources"]);
    assert.equal(registry.problems().length, 2);
    assert.match(registry.problems().join("\n"), /features\/home\/route\.tsx must default-export a RouteModule/);
    assert.match(registry.problems().join("\n"), /features\/about\/route\.tsx exports the "watch" route/);
  });

  it("a failed chunk can be retried: the next attempt loads again and gets a fresh lazy component", async () => {
    let attempts = 0;
    const registry = buildRouteRegistry({
      lazy: {
        "../features/about/route.tsx": async () => {
          attempts++;
          if (attempts === 1) throw new Error("chunk 404");
          return mod("about");
        },
      },
    });
    const first = registry.page("about");
    registry.preload("about");
    await new Promise((resolve) => setImmediate(resolve));
    const second = registry.page("about");
    assert.notEqual(second, first, "React.lazy caches a rejection, so a new component is handed out");
    registry.preload("about");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.equal(registry.page("about"), second);
  });
});

describe("makePage", () => {
  it("wraps the module component and names it for devtools", () => {
    const Page = makePage(mod("watch").default);
    assert.equal(Page.displayName, "Route(watch)");
    assert.equal(renderToStaticMarkup(createElement(Page, { route: { name: "watch" } })), '<p data-route="watch">watch</p>');
  });
});

describe("routeRegistry (discovered)", () => {
  it("outside Vite there is no import.meta.glob: the registry is empty, not broken", () => {
    assert.deepEqual(routeRegistry.names(), []);
    assert.equal(routeRegistry.page("home"), null);
  });
});
