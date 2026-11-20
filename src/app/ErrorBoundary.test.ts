import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary, ErrorPanel, clearPayloadCache } from "./ErrorBoundary";
import { CACHE_KEYS, STORAGE_KEYS } from "./services";

describe("ErrorBoundary", () => {
  it("renders its children when nothing is wrong", () => {
    const html = renderToStaticMarkup(createElement(ErrorBoundary, { scope: "page", resetKey: "a", children: createElement("p", null, "fine") }));
    assert.equal(html, "<p>fine</p>");
  });

  it("turns any thrown value into an Error in state", () => {
    const boom = new Error("boom");
    assert.equal(ErrorBoundary.getDerivedStateFromError(boom).error, boom);
    const fromString = ErrorBoundary.getDerivedStateFromError("plain string").error;
    assert.ok(fromString instanceof Error);
    assert.equal(fromString.message, "plain string");
  });

  it("clears the error when the reset key changes (navigating away from a broken page)", () => {
    const state = { error: new Error("x"), resetKey: "#/s/models" };
    assert.equal(ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: "#/s/models" }, state), null);
    assert.deepEqual(ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: "#/" }, state), { error: null, resetKey: "#/" });
  });
});

describe("ErrorPanel", () => {
  const page = renderToStaticMarkup(createElement(ErrorPanel, { error: new Error("Cannot read properties of undefined"), scope: "page", onRetry: () => undefined }));
  const app = renderToStaticMarkup(createElement(ErrorPanel, { error: new Error("no services"), scope: "app" }));

  it("is an alert with a reload button - never a blank tab", () => {
    for (const html of [page, app]) {
      assert.match(html, /^<div class="error-panel" role="alert">/);
      assert.match(html, /<button type="button" class="btn btn-primary">Reload<\/button>/);
      assert.match(html, /bookmarks, read-later list and settings are\s+untouched/);
    }
  });

  it("page scope keeps the shell's h1 unique and offers a way out", () => {
    assert.doesNotMatch(page, /<h1/);
    assert.match(page, /<h2 class="section-heading">This page could not be shown<\/h2>/);
    assert.match(page, />Try again<\/button>/);
    assert.match(page, /<a class="btn" href="#\/">Front page<\/a>/);
    assert.match(page, /<pre>Cannot read properties of undefined<\/pre>/);
  });

  it("app scope replaces the whole page, so it carries the h1", () => {
    assert.match(app, /<h1 class="section-heading">AI DRUDGE could not start<\/h1>/);
    assert.doesNotMatch(app, /Try again|Front page/);
  });

  it("escapes the error text", () => {
    const html = renderToStaticMarkup(createElement(ErrorPanel, { error: new Error("<img src=x onerror=alert(1)>"), scope: "page" }));
    assert.doesNotMatch(html, /<img/);
  });
});

describe("clearPayloadCache", () => {
  it("removes exactly the sessionStorage payload cache keys - never reader state", () => {
    const removed: string[] = [];
    clearPayloadCache({ removeItem: (key) => void removed.push(key) });
    assert.deepEqual(removed.sort(), Object.values(CACHE_KEYS).sort());
    for (const key of Object.values(STORAGE_KEYS)) assert.ok(!removed.includes(key), key);
  });

  it("survives blocked storage and a missing sessionStorage", () => {
    assert.doesNotThrow(() =>
      clearPayloadCache({
        removeItem: () => {
          throw new Error("SecurityError");
        },
      }),
    );
    assert.doesNotThrow(() => clearPayloadCache());
  });
});
