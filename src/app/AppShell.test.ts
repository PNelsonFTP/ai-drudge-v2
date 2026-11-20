// SSR smoke test of the shell: renders AppShell to static markup with the fake services and
// asserts the document structure the accessibility review asked for (one h1, skip link, labelled
// landmarks, labelled search, text-labelled controls). No DOM library: plain string checks.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SECTIONS } from "../../shared/sections";
import { createFakeServices, type FakeServicesOptions } from "../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_MS, fixtureFront, fixtureStocks } from "../../test/helpers/fixtureData";
import { tickerModel } from "../features/chrome/model";
import { MuteToast } from "../features/chrome/MuteToast";
import { ShortcutsHelp } from "../keyboard/ShortcutsHelp";
import { AppShell, INTERACTION_RETRY_EVENTS, INTERACTION_RETRY_GAP_MS, loadInteractionsLayer, preloadPagesWhenIdle, type AppShellProps, type IdleHost, type InteractionEventTarget } from "./AppShell";
import type { PersistenceState } from "./createServices";
import ShellInteractions from "./ShellInteractions";
import { buildRouteRegistry, type RouteRegistry } from "./routeRegistry";
import { ROUTE_NAMES, ServicesContext, createStore, useServices, useStore, type Route, type RouteModule, type RouteName, type Settings } from "./services";

/** A stand-in page per route: proves the outlet renders the module of the current route inside the context. */
function stubRoutes(): RouteRegistry {
  const eager: Record<string, { default: RouteModule }> = {};
  for (const name of ROUTE_NAMES) {
    const Component = ({ route }: { route: Route }): ReactElement => {
      const services = useServices();
      const top = useStore(services.edition, (s) => s.edition?.top ?? []);
      const Row = services.ui.HeadlineRow;
      return createElement(
        "section",
        { "data-page": name, "data-route": JSON.stringify(route) },
        createElement("h2", null, `${name} page`),
        ...top.slice(0, 3).map((id) => createElement(Row, { key: id, id })),
      );
    };
    eager[`../features/${name}/route.tsx`] = { default: { name, Component, title: `${name} title` } };
  }
  return buildRouteRegistry({ eager });
}

function render(opts: FakeServicesOptions = {}, props: AppShellProps = {}): string {
  const services = createFakeServices(opts);
  return renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: stubRoutes(), ...props })));
}

const count = (html: string, needle: string | RegExp): number => html.split(needle).length - 1;
const indexOfOrFail = (html: string, needle: string): number => {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `markup is missing ${needle}`);
  return i;
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("AppShell (server render)", () => {
  const html = render();

  it("has exactly one <h1>: the masthead, linking home", () => {
    assert.equal(count(html, /<h1[\s>]/), 1);
    const h1 = /<h1[^>]*>(.*?)<\/h1>/.exec(html)?.[1] ?? "";
    assert.match(h1, /<a href="#\/"/);
    assert.equal(text(h1).trim(), "AI DRUDGE");
    // The ticking tagline is outside the heading, so the heading's name is stable.
    assert.doesNotMatch(h1, /stories|updated/);
  });

  it("starts with a skip link to <main>", () => {
    const firstLink = /<a\s[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(firstLink, /class="skip-link"/);
    assert.match(firstLink, /href="#main"/);
    assert.match(html, /<main id="main" tabindex="-1">/);
    assert.equal(count(html, /<main[\s>]/), 1);
  });

  it("has labelled landmarks: banner, two navs, search, main, contentinfo", () => {
    assert.equal(count(html, /<header[\s>]/), 1);
    assert.equal(count(html, /<footer[\s>]/), 1);
    assert.match(html, /<nav[^>]*aria-label="Sections"/);
    assert.match(html, /<nav[^>]*aria-label="Pages"/);
    assert.equal(count(html, /<nav[\s>]/), 2);
    for (const nav of html.match(/<nav[^>]*>/g) ?? []) assert.match(nav, /aria-label="/, "every <nav> needs a name");
    assert.match(html, /<form[^>]*role="search"/);
    assert.match(html, /<section[^>]*aria-label="AI-related stocks"/);
  });

  it("lays the chrome out in the specified order, with the footer outside <main>", () => {
    const order = ['class="skip-link"', "<header", "<h1", 'id="site-toolbar"', 'role="search"', 'aria-label="Sections"', 'aria-label="Show stories from"', 'class="ticker-bar"', 'class="banners"', "<main", "</main>", "<footer"];
    const positions = order.map((needle) => indexOfOrFail(html, needle));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `order was ${order.map((n, i) => `${n}@${positions[i]}`).join(", ")}`);
  });

  it("only the masthead is inside the always-sticky header; search, chips and ticker are not", () => {
    const header = /<header[^>]*>(.*?)<\/header>/.exec(html)?.[1] ?? "";
    assert.match(/<header[^>]*>/.exec(html)?.[0] ?? "", /sticky-top/);
    assert.match(header, /class="header-row"/);
    for (const cls of ["search-input", "chip-nav", "time-chips", "ticker-bar"]) assert.ok(!header.includes(cls), `${cls} must not be in the sticky header`);
    assert.match(html, /<button[^>]*class="tool-btn menu-btn"[^>]*aria-expanded="false"[^>]*aria-controls="site-toolbar"[^>]*>Menu<\/button>/);
  });

  it("gives the search box a real label", () => {
    assert.match(html, /<label[^>]*for="site-search"[^>]*>Search headlines<\/label>/);
    const input = /<input[^>]*id="site-search"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(input, /type="search"/);
    assert.match(input, /class="search-input"/);
  });

  it("shows the story count and a relative 'updated' time", () => {
    const tagline = text(/<p class="tagline">(.*?)<\/p>/.exec(html)?.[1] ?? "");
    assert.match(tagline, new RegExp(`${fixtureFront.counts.stories} stories`));
    assert.match(tagline, /updated 20m ago/);
    assert.doesNotMatch(html, /class="stale"/);
  });

  it("toolbar: text-labelled links with counts, and a theme toggle with aria-pressed", () => {
    const toolbar = /<nav id="site-toolbar"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    const labels = [...toolbar.matchAll(/<(a|button)[^>]*>(.*?)<\/\1>/g)].map((m) => text(m[2]).trim());
    assert.deepEqual(labels, ["Saved", "Later", "Watch", "Sources", "Settings", "Briefing", "Dark"]);
    // The briefing export is a real button that announces its dialog. The dialog itself (panel,
    // briefing builder, kit stylesheet) is a separate chunk fetched on first use: not in the first render.
    assert.match(toolbar, /<button type="button" class="tool-btn" aria-haspopup="dialog" title="[^"]+">Briefing<\/button>/);
    assert.doesNotMatch(toolbar, /<dialog|sp-dialog|role="alert"/);
    assert.doesNotMatch(/<header[^>]*>(.*?)<\/header>/.exec(html)?.[1] ?? "", /<dialog/);
    assert.deepEqual([...toolbar.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["#/saved", "#/later", "#/watch", "#/sources", "#/settings"]);
    assert.match(toolbar, /<button[^>]*aria-pressed="false"[^>]*>Dark<\/button>/);
    assert.doesNotMatch(toolbar, /aria-current/);
  });

  it("section chips: all 15 short labels in default order, each a real link", () => {
    const nav = /<nav class="chip-nav"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    const chips = [...nav.matchAll(/<a class="chip" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2]).trim()]);
    assert.deepEqual(chips, SECTIONS.map((s) => [`#/s/${s.id}`, s.short.replace("&", "&")]));
    assert.match(nav, /^<ul/);
  });

  it("time chips: NEW links to #/new, the others are buttons bound to settings.timeFilter", () => {
    const group = /<div class="time-chips"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? "";
    assert.match(group, /<a class="chip" href="#\/new"[^>]*>NEW<\/a>/);
    const buttons = [...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => `${m[2]}:${m[1]}`);
    assert.deepEqual(buttons, ["6H:false", "24H:false", "3D:false", "ALL:true"]);
  });

  it("shell time chips only where they act: front page and #/new; a section page keeps its own single group", () => {
    const shell = (route: Route): number => count(render({ route }), 'class="time-chips"');
    assert.equal(shell({ name: "home" }), 1);
    assert.equal(shell({ name: "new" }), 1);
    for (const route of [{ name: "section", id: "ai_security" }, { name: "search", q: "finra" }, { name: "watch" }, { name: "saved", tab: "bookmarks" }, { name: "saved", tab: "later" }, { name: "sources" }, { name: "settings" }, { name: "about" }] as Route[]) {
      const page = render({ route });
      assert.equal(count(page, 'class="time-chips"'), 0, route.name);
      assert.doesNotMatch(page, /aria-label="Show stories from"/, route.name);
      // The section chips stay on every page.
      assert.match(page, /<nav class="chip-nav" aria-label="Sections">/, route.name);
    }
  });

  it("ticker list: not a tab stop in the first render (it becomes one only while it overflows)", () => {
    const list = /<ul class="ticker-list"[^>]*>/.exec(html)?.[0] ?? "";
    assert.equal(list, '<ul class="ticker-list">');
  });

  it("ticker: symbols in stocks.json order with a spoken sentence each", () => {
    const ticker = /<section class="ticker-bar"[^>]*>(.*?)<\/section>/.exec(html)?.[1] ?? "";
    const symbols = [...ticker.matchAll(/class="ticker-sym">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(symbols, fixtureStocks.order);
    assert.equal(count(ticker, 'class="visually-hidden"'), fixtureStocks.order.length);
    const model = tickerModel(fixtureStocks);
    assert.ok(model && model.quotes.length === fixtureStocks.order.length);
    for (const q of model.quotes) assert.ok(ticker.includes(`<span class="visually-hidden">${q.spoken}</span>`), q.spoken);
    // The as-of note is shown for a closed market only - both states, whichever the frozen build caught.
    const tickerOf = (marketState: "open" | "closed"): string => /<section class="ticker-bar"[^>]*>(.*?)<\/section>/.exec(render({ stocks: { ...fixtureStocks, marketState } }))?.[1] ?? "";
    assert.doesNotMatch(tickerOf("open"), /ticker-note/);
    assert.ok(tickerOf("closed").includes(`<li class="ticker-note">${tickerModel({ ...fixtureStocks, marketState: "closed" })?.note}</li>`));
    assert.equal(/ticker-note/.test(ticker), fixtureStocks.marketState === "closed");
  });

  it("footer: Atom, OPML, sources + feed health, about, shortcuts, version + build id, disclaimer", () => {
    const footer = /<footer[^>]*>(.*?)<\/footer>/.exec(html)?.[1] ?? "";
    assert.match(footer, /href="\/ai-drudge-v2\/feed\.xml"/);
    assert.match(footer, /href="\/ai-drudge-v2\/feeds\.opml"/);
    assert.match(footer, new RegExp(`href="#/sources"[^>]*>Sources &amp; feed health — ${fixtureFront.counts.feedsOk}/${fixtureFront.counts.feedsTotal} feeds OK<`));
    assert.match(footer, /href="#\/about"/);
    assert.match(footer, />Keyboard shortcuts<\/button>/);
    assert.match(text(footer), new RegExp(`AI DRUDGE v2\\.0\\.0 · build ${fixtureFront.buildId.replace(/[.]/g, "\\.")}`));
    assert.match(text(footer), /not affiliated with the Drudge Report/);
  });

  it("renders the page of the current route in <main>, with the UI slot working", () => {
    const main = /<main[^>]*>(.*?)<\/main>/.exec(html)?.[1] ?? "";
    assert.match(main, /data-page="home"/);
    assert.equal(count(main, "data-aid="), 3);
    for (const route of [{ name: "section", id: "cyber" }, { name: "search", q: "qwen" }, { name: "new" }, { name: "watch" }, { name: "saved", tab: "later" }, { name: "sources" }, { name: "settings" }, { name: "about" }] as Route[]) {
      const page = render({ route });
      assert.match(page, new RegExp(`<main[^>]*>.*data-page="${route.name}"`), route.name);
      assert.ok(page.includes(`data-route="${JSON.stringify(route).replace(/"/g, "&quot;")}"`), route.name);
      assert.equal(count(page, /<h1[\s>]/), 1, `${route.name}: one h1`);
    }
  });

  it("every button and link has a text name (no bare glyph buttons)", () => {
    const controls = [...html.matchAll(/<(button|a)\b([^>]*)>(.*?)<\/\1>/g)];
    assert.ok(controls.length > 30);
    for (const [, tag, attrs, inner] of controls) {
      const name = /aria-label="([^"]+)"/.exec(attrs)?.[1] ?? text(inner).trim();
      assert.match(name, /[A-Za-z0-9]{2}/, `<${tag}${attrs}> has no readable name: "${name}"`);
    }
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) assert.match(button, /type="button"/, button);
  });

  it("uses no opacity utilities and no inline colours (contrast comes from tokens)", () => {
    assert.doesNotMatch(html, /\bopacity-\d/);
    assert.doesNotMatch(html, /style="[^"]*(?:color|background)/);
    assert.doesNotMatch(html, /#[0-9a-f]{6}\b/i);
  });

  it("has a polite live region; the interactions layer (shortcuts dialog, hover card, mute notice) is not in the first render", () => {
    assert.match(html, /role="status" aria-live="polite"/);
    // Keyboard layer + dialog + hover card + toast are a chunk of their own, fetched after the first commit.
    assert.doesNotMatch(html, /<dialog|class="toast"|hl-card/);
    assert.match(html, /<\/footer><\/div><div class="visually-hidden" role="status"/, "nothing between the desk and the status region yet");
  });

  it("with the interactions layer mounted: the shortcuts dialog (closed) sits between the footer and the status region", () => {
    const full = render({}, { interactions: ShellInteractions });
    assert.match(full, /<dialog class="modal" aria-labelledby="[^"]+">/);
    assert.doesNotMatch(full, /<dialog[^>]*\sopen/);
    const order = ["<footer", "<dialog", 'role="status" aria-live="polite"'].map((needle) => indexOfOrFail(full, needle));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    // Everything else of the page is the same markup: the layer only adds, it moves nothing.
    assert.equal(full.replace(/<dialog.*?<\/dialog>/, ""), html);
    assert.equal(render({}, { interactions: null }), html, "null: a shell without the layer");
  });

  it("shows no mute notice until a source is muted", () => {
    assert.doesNotMatch(html, /class="toast"/);
  });

  it("advertises the single-key shortcuts while they are on", () => {
    assert.match(/<input[^>]*id="site-search"[^>]*>/.exec(html)?.[0] ?? "", /aria-keyshortcuts="\/"/);
    assert.match(html, /<button[^>]*aria-keyshortcuts="\?"[^>]*>Keyboard shortcuts<\/button>/);
  });
});

describe("mute notice (MuteToast)", () => {
  const controls = { undo: () => undefined, dismiss: () => undefined, hold: () => undefined };
  const toast = (props: Partial<Parameters<typeof MuteToast>[0]> = {}): string =>
    renderToStaticMarkup(createElement(MuteToast, { notice: { id: "the-information", name: "The Information" }, ...controls, ...props }));

  it("renders nothing without a notice", () => {
    assert.equal(renderToStaticMarkup(createElement(MuteToast, { notice: null, ...controls })), "");
  });

  it("names the source and offers Undo and Dismiss as real buttons", () => {
    const html = toast();
    assert.match(html, /^<div class="toast" role="group" aria-label="Source muted">/);
    assert.match(text(html), /Muted The Information/);
    assert.match(html, /<button type="button" class="btn btn-primary" aria-keyshortcuts="u">Undo<span aria-hidden="true"> \(u\)<\/span><\/button>/);
    assert.match(html, /<button type="button" class="btn">Dismiss<\/button>/);
  });

  it("is not a live region itself (a control does not belong in one): the shell's status region speaks", () => {
    assert.doesNotMatch(toast(), /role="status"|role="alert"|aria-live/);
  });

  it("does not advertise the u key when single-key shortcuts are off", () => {
    const html = toast({ showKey: false });
    assert.doesNotMatch(html, /aria-keyshortcuts|\(u\)/);
    assert.match(html, />Undo<\/button>/);
  });

  it("escapes the source name", () => {
    assert.match(toast({ notice: { id: "x", name: "A <b> & C" } }), /Muted <strong>A &lt;b&gt; &amp; C<\/strong>/);
  });
});

describe("single-key shortcuts setting", () => {
  // `shortcuts` joins the Settings contract with the Settings page switch; the shell reads it
  // tolerantly (absent = on), so it is passed here the way a stored value arrives.
  const off = { shortcuts: false } as Partial<Settings>;

  it("off: the search box and the footer button stop advertising their keys", () => {
    const html = render({ settings: off });
    assert.doesNotMatch(html, /aria-keyshortcuts/);
    assert.match(html, />Keyboard shortcuts<\/button>/, "the help stays reachable by its button");
  });

  it("explicitly on behaves like the default", () => {
    assert.match(render({ settings: { shortcuts: true } as Partial<Settings> }), /aria-keyshortcuts="\/"/);
  });

  it("the help dialog says where the switch is, and says so plainly when the keys are off", () => {
    const help = (enabled: boolean): string => renderToStaticMarkup(createElement(ShortcutsHelp, { open: true, onClose: () => undefined, enabled, settingsHref: "#/settings" }));
    const on = help(true);
    assert.match(text(on), /You can turn single-key shortcuts off in Settings/);
    assert.match(on, /<a href="#\/settings">Settings<\/a>/);
    assert.match(on, /<kbd>u<\/kbd>/, "the undo key is documented");
    const off = help(false);
    assert.match(text(off), /Single-key shortcuts are turned off\. Only Esc works\. Turn them back on in Settings/);
    assert.doesNotMatch(text(off), /Shortcuts are off while you type/);
  });
});

describe("preloadPagesWhenIdle", () => {
  const registry = (log: string[]) => ({ names: (): RouteName[] => ["home", "section", "search", "new"], preload: (name: RouteName) => void log.push(name) });

  it("preloads every page of the registry once the browser is idle", () => {
    const log: string[] = [];
    let idle: (() => void) | null = null;
    const host: IdleHost = {
      requestIdleCallback: (cb) => {
        idle = cb;
        return 7;
      },
      cancelIdleCallback: () => undefined,
      setTimeout: () => assert.fail("idle callback available: no timer"),
      clearTimeout: () => undefined,
    };
    preloadPagesWhenIdle(registry(log), host);
    assert.deepEqual(log, [], "nothing before the idle callback: first paint comes first");
    (idle as (() => void) | null)?.();
    assert.deepEqual(log, ["home", "section", "search", "new"]);
  });

  it("falls back to a timer (Safari has no requestIdleCallback) and can be cancelled", () => {
    const log: string[] = [];
    const timers = new Map<number, () => void>();
    const host: IdleHost = {
      setTimeout: (cb, ms) => {
        assert.ok(ms >= 1000, "well after first paint");
        timers.set(1, cb);
        return 1;
      },
      clearTimeout: (handle) => void timers.delete(handle),
    };
    const cancel = preloadPagesWhenIdle(registry(log), host);
    assert.equal(timers.size, 1);
    cancel();
    assert.equal(timers.size, 0);
    assert.deepEqual(log, []);
    preloadPagesWhenIdle(registry(log), host);
    timers.get(1)?.();
    assert.equal(log.length, 4);
  });

  it("does nothing without a window, or when the reader asked to save data", () => {
    const log: string[] = [];
    preloadPagesWhenIdle(registry(log), null)();
    const host: IdleHost = { setTimeout: () => assert.fail("must not schedule"), clearTimeout: () => undefined, navigator: { connection: { saveData: true } } };
    preloadPagesWhenIdle(registry(log), host)();
    assert.deepEqual(log, []);
  });
});

describe("loadInteractionsLayer (the lazy keyboard / dialog / hover card / toast chunk)", () => {
  function fakeTarget() {
    const listeners = new Map<string, Set<() => void>>();
    const target: InteractionEventTarget = {
      addEventListener: (type, listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
      removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    };
    return { target, fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((l) => l()), listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("asks for the chunk at once and hands it over exactly once", async () => {
    const dom = fakeTarget();
    const got: string[] = [];
    let calls = 0;
    loadInteractionsLayer({ load: async () => (calls++, "layer"), onLoaded: (layer) => got.push(layer), target: dom.target });
    assert.equal(calls, 1, "no idle wait: keys must work as soon as possible after first paint");
    assert.equal(dom.listening(), INTERACTION_RETRY_EVENTS.length);
    await settle();
    assert.deepEqual(got, ["layer"]);
    assert.equal(dom.listening(), 0, "the retry listeners are gone once it has loaded");
    dom.fire("keydown");
    await settle();
    assert.equal(calls, 1);
  });

  it("a failed download leaves the page alone and is retried on a key press or pointer move - not on a timer, and not more than once per gap", async () => {
    const dom = fakeTarget();
    const got: string[] = [];
    let calls = 0;
    let failures = 0;
    let clock = 1_000_000;
    const load = async (): Promise<string> => {
      if (++calls <= 2) throw new Error("chunk failed");
      return "layer";
    };
    const handle = loadInteractionsLayer({ load, onLoaded: (layer) => got.push(layer), onFailed: () => void failures++, target: dom.target, now: () => clock });
    await settle();
    assert.deepEqual([got.length, calls, failures], [0, 1, 1], "no retry by itself");
    // An offline tab with a moving mouse: no download per event.
    for (let i = 0; i < 50; i++) dom.fire("pointerover");
    dom.fire("keydown");
    assert.equal(calls, 1);
    clock += INTERACTION_RETRY_GAP_MS;
    dom.fire("keydown");
    dom.fire("keydown");
    assert.equal(calls, 2, "one download at a time, however many keys");
    await settle();
    assert.equal(failures, 2);
    clock += INTERACTION_RETRY_GAP_MS - 1;
    dom.fire("pointerover");
    assert.equal(calls, 2, "still inside the gap");
    clock += 1;
    dom.fire("pointerover");
    await settle();
    assert.deepEqual(got, ["layer"]);
    assert.equal(calls, 3);
    handle.retry();
    await settle();
    assert.equal(calls, 3, "retry() after success is a no-op");
  });

  it("retry() (the footer's Keyboard shortcuts button) asks again at once after a failure - an explicit request has no gap", async () => {
    let calls = 0;
    const got: string[] = [];
    const handle = loadInteractionsLayer({ load: async () => (++calls === 1 ? Promise.reject(new Error("offline")) : "layer"), onLoaded: (layer) => got.push(layer), target: null, now: () => 0 });
    await settle();
    handle.retry();
    await settle();
    assert.deepEqual(got, ["layer"]);
  });

  it("cancel (unmount) drops a late arrival, reports no failure and removes the listeners", async () => {
    const dom = fakeTarget();
    const got: string[] = [];
    const handle = loadInteractionsLayer({ load: async () => "layer", onLoaded: (layer) => got.push(layer), target: dom.target });
    handle.cancel();
    await settle();
    assert.deepEqual(got, []);
    assert.equal(dom.listening(), 0);
    let failures = 0;
    loadInteractionsLayer({ load: async () => Promise.reject(new Error("x")), onLoaded: () => undefined, onFailed: () => void failures++, target: null }).cancel();
    await settle();
    assert.equal(failures, 0);
  });

  it("the shell loads it through a retryable dynamic import, never React.lazy, and imports none of its parts statically", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "AppShell.tsx"), "utf8");
    assert.match(src, /retryableLoader\(\(\) => import\("\.\/ShellInteractions"\)/);
    assert.doesNotMatch(src, /\blazy\(/, "React.lazy would send a failed chunk to the app error boundary");
    const statics = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].filter((m) => !m[1]).map((m) => m[2]);
    assert.ok(statics.length >= 10, "import scan found the imports");
    assert.deepEqual(statics.filter((from) => /keyboard\/|HoverCard|MuteToast|ShortcutsHelp|ShellInteractions|muteModel|features\/headline/.test(from)), []);
    // main.tsx must not pull the hover card in through the headline feature's index either.
    const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "main.tsx"), "utf8");
    assert.doesNotMatch(main, /from "\.\/features\/headline";/);
    assert.match(main, /import "\.\/features\/headline\/headline\.css";/);
  });
});

describe("AppShell states", () => {
  it("marks the current page in the toolbar and the chip nav", () => {
    const saved = render({ route: { name: "saved", tab: "later" }, bookmarks: ["a", "b"], later: ["c"] });
    assert.match(saved, /<a class="tool-btn active" href="#\/later" aria-current="page">Later<span class="tool-count">1<span class="visually-hidden"> to read later<\/span><\/span><\/a>/);
    assert.match(saved, /<a class="tool-btn" href="#\/saved">Saved<span class="tool-count">2/);
    const section = render({ route: { name: "section", id: "ai_security" } });
    assert.match(section, /<a class="chip chip-active" href="#\/s\/ai_security" aria-current="page"[^>]*>AI SEC<\/a>/);
    assert.equal(count(section, 'aria-current="page"'), 1);
    assert.match(render({ route: { name: "new" } }), /<a class="chip chip-active" href="#\/new" aria-current="page"[^>]*>NEW<\/a>/);
    // On #/new no time-window button is pressed.
    assert.doesNotMatch(/<div class="time-chips"[^>]*>(.*?)<\/div>/.exec(render({ route: { name: "new" } }))?.[1] ?? "", /aria-pressed="true"/);
    assert.match(render(), /<a href="#\/" aria-current="page">/);
  });

  it("chip nav follows the reader's order and drops hidden and muted sections", () => {
    const html = render({ settings: { sectionOrder: ["cyber", "ai_security"], hiddenSections: ["robotics"], timeFilter: "24h" }, mutedSections: ["quantum"] });
    const hrefs = [...html.matchAll(/<a class="chip" href="#\/s\/([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs.slice(0, 3), ["cyber", "ai_security", "models"]);
    assert.ok(!hrefs.includes("robotics") && !hrefs.includes("quantum"));
    assert.equal(hrefs.length, 13);
    assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>24H<\/button>/);
  });

  it("theme toggle reflects a dark setting", () => {
    assert.match(render({ settings: { theme: "dark" } }), /<button[^>]*aria-pressed="true"[^>]*>Dark<\/button>/);
    assert.match(render({ settings: { theme: "system" } }), /<button[^>]*aria-pressed="false"[^>]*>Dark<\/button>/);
  });

  it("stale data: flagged on the tagline and in a banner with a retry", () => {
    const html = render({ nowMs: FIXTURE_GENERATED_MS + 7.5 * 3_600_000 });
    assert.match(html, /<span class="stale">updated 7h ago · delayed<\/span>/);
    assert.match(html, /<div class="banner"><span>Headlines may be delayed — the last edition is 7 h old\.<\/span><button type="button" class="btn">Check again<\/button><\/div>/);
    // The threshold is 2 h (CC-8: it was 6 h against a 30-minute build cadence).
    assert.match(render({ nowMs: FIXTURE_GENERATED_MS + 2.5 * 3_600_000 }), /Headlines may be delayed — the last edition is 2 h old\./);
    assert.doesNotMatch(render({ nowMs: FIXTURE_GENERATED_MS + 1.5 * 3_600_000 }), /class="banner[ "]/);
  });

  it("stale threshold follows status.json staleAfterMinutes once the edition store publishes it", () => {
    const at = (minutes: number, staleAfterMinutes?: number): string => {
      const services = createFakeServices({ nowMs: FIXTURE_GENERATED_MS + minutes * 60_000 });
      if (staleAfterMinutes !== undefined) services.stores.edition.update((s) => ({ ...s, staleAfterMinutes }));
      return renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: stubRoutes() })));
    };
    // 100 minutes old: under the 2 h fallback, over the pipeline's 90 minutes.
    assert.doesNotMatch(at(100), /class="banner[ "]|class="stale"/);
    const flagged = at(100, 90);
    assert.match(flagged, /Headlines may be delayed — the last edition is 1 h old\./);
    assert.match(flagged, /<span class="stale">updated 1h ago · delayed<\/span>/);
    assert.doesNotMatch(at(89, 90), /class="banner[ "]|class="stale"/);
    // A nonsense value from the server is ignored, not obeyed.
    assert.doesNotMatch(at(100, 5), /class="banner[ "]/);
  });

  it("still trying: tagline and an info banner without a button while the first load is retried", () => {
    const services = createFakeServices({ loaded: "loading" });
    services.stores.edition.update((s) => ({ ...s, retrying: true }));
    const html = renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: stubRoutes() })));
    assert.match(text(html), /still trying…/);
    assert.match(html, /<div class="banner banner-info"><span>Still trying to load the headlines — the first attempt failed\.<\/span><\/div>/);
    assert.doesNotMatch(text(html), /loading…/);
  });

  it("changes not being saved: a banner with Dismiss when services.persistence reports a refused write", () => {
    const withPersistence = (state: PersistenceState): string => {
      const services = Object.assign(createFakeServices(), { persistence: createStore(state) });
      return renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: stubRoutes() })));
    };
    assert.match(withPersistence({ writeRefused: true }), /<div class="banner"><span>This browser is not saving your changes[^<]*until this tab is closed\.<\/span><button type="button" class="btn">Dismiss<\/button><\/div>/);
    assert.doesNotMatch(withPersistence({ writeRefused: false }), /class="banner[ "]/);
    // Services without the store (the fakes, an older wiring): no banner, no exception.
    assert.doesNotMatch(render(), /not saving your changes/);
    const broken = Object.assign(createFakeServices(), { persistence: { nope: true } });
    assert.doesNotMatch(renderToStaticMarkup(createElement(ServicesContext.Provider, { value: broken }, createElement(AppShell, { routes: stubRoutes() }))), /class="banner[ "]/);
  });

  it("an outdated client is told to reload", () => {
    const services = createFakeServices();
    services.stores.edition.update((s) => ({ ...s, outdatedClient: true }));
    const html = renderToStaticMarkup(createElement(ServicesContext.Provider, { value: services }, createElement(AppShell, { routes: stubRoutes() })));
    assert.match(html, /<div class="banner banner-info"><span>A new version of AI DRUDGE is available\.<\/span><button type="button" class="btn">Reload<\/button>/);
  });

  it("load failure: error banner with retry, 'could not load' tagline, ticker hidden, still one h1", () => {
    const html = render({ loaded: "error" });
    assert.match(html, /<div class="banner"><span>Failed to load headlines\.<\/span><button type="button" class="btn">Retry<\/button>/);
    assert.match(text(html), /could not load/);
    assert.doesNotMatch(html, /ticker-bar/);
    assert.equal(count(html, /<h1[\s>]/), 1);
    assert.match(html, /<main id="main"/);
  });

  it("loading: no banner, no ticker, tagline says loading", () => {
    const html = render({ loaded: "loading" });
    assert.doesNotMatch(html, /class="banner[ "]/);
    assert.doesNotMatch(html, /ticker-bar/);
    assert.match(text(html), /loading…/);
  });

  it("hides the ticker when there are no quotes and notes a closed market", () => {
    assert.doesNotMatch(render({ stocks: null }), /ticker-bar/);
    assert.doesNotMatch(render({ stocks: { ...fixtureStocks, order: [], quotes: {} } }), /ticker-bar/);
    const closed = render({ stocks: { ...fixtureStocks, marketState: "closed", asOf: "2026-11-20T21:00:00Z" } });
    assert.match(closed, /<li class="ticker-note">Closed · as of Fri 4:00 PM ET<\/li>/);
  });

  it("a route without a page renders a placeholder, never a blank main", () => {
    const html = renderToStaticMarkup(
      createElement(ServicesContext.Provider, { value: createFakeServices({ route: { name: "watch" } }) }, createElement(AppShell, { routes: buildRouteRegistry({}) })),
    );
    assert.match(/<main[^>]*>(.*?)<\/main>/.exec(html)?.[1] ?? "", /Watchlist.*not part of this build yet.*href="#\/"/);
  });

  it("renders with the default (discovered) registry outside Vite", () => {
    const html = renderToStaticMarkup(createElement(ServicesContext.Provider, { value: createFakeServices() }, createElement(AppShell)));
    assert.equal(count(html, /<h1[\s>]/), 1);
    assert.match(html, /<main id="main"/);
  });

  it("passes the version through", () => {
    assert.match(text(render({}, { version: "9.9.9" })), /AI DRUDGE v9\.9\.9 · build/);
  });

  it("without services it fails loudly instead of rendering half a page", () => {
    assert.throws(() => renderToStaticMarkup(createElement(AppShell, { routes: stubRoutes() })), /ServicesContext/);
  });
});
