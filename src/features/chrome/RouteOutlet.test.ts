// The page error boundary's "Try again" must reach the route registry: a lazy page whose chunk
// failed is replaced by a FRESH lazy component there, and only a new render of the outlet asks for it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { buildRouteRegistry } from "../../app/routeRegistry";
import type { Route, RouteModule, RouteName } from "../../app/services";
import { mountFakeDom } from "../headline/fakeDom.testkit";
import { RouteOutlet } from "./RouteOutlet";

const mod = (name: RouteName): { default: RouteModule } => ({
  default: { name, title: `${name} title`, Component: ({ route }: { route: Route }) => createElement("p", { className: "page-body", "data-route": route.name }, `the ${name} page`) },
});
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("RouteOutlet", () => {
  it("'Try again' after a failed page chunk loads the page (it used to re-throw the cached failure)", async () => {
    let attempts = 0;
    const registry = buildRouteRegistry({
      lazy: {
        "../features/about/route.tsx": async () => {
          attempts++;
          if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
          return mod("about");
        },
      },
    });
    const route: Route = { name: "about" };
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]): void => void errors.push(args);
    const dom = await mountFakeDom();
    try {
      await dom.render(createElement(RouteOutlet, { route, registry }));
      await dom.run(settle);
      assert.equal(attempts, 1);
      assert.ok(dom.text().includes("This page could not be shown"), dom.text());
      assert.equal(dom.byClass("page-body").length, 0);
      const retry = dom.all((n) => n.tagName === "BUTTON" && n.textContent === "Try again");
      assert.equal(retry.length, 1, "the page boundary offers a retry");

      await dom.click(retry[0]);
      await dom.run(settle);
      assert.equal(attempts, 2, "the retry asked the registry again and the chunk was requested once more");
      assert.ok(dom.text().includes("the about page"), dom.text());
      assert.ok(!dom.text().includes("This page could not be shown"));
    } finally {
      await dom.unmount();
      console.error = realError;
    }
    assert.ok(errors.length > 0, "the failure was logged");
  });
});
