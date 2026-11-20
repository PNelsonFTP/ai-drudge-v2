import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTION_IDS } from "../../shared/sections";
import { SECTION_PRESETS } from "../app/presets";
import { DEFAULT_SETTINGS, STORAGE_KEYS, V1_STORAGE_KEYS, type Settings } from "../app/services";
import {
  DARK_MEDIA_QUERY,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  THEME_BOOTSTRAP_SCRIPT,
  applyAppearance,
  createSettingsStore,
  effectiveSectionOrder,
  parseSettings,
  resolveTheme,
  type AppearanceRoot,
  type MediaQueryLike,
} from "./settings";
import { createMemoryStorage, decodeValue, defineKey, type KeySpec } from "./storage";
import { createTabs } from "./testkit";
import { SETTINGS_STORAGE_KEY, V1_THEME_STORAGE_KEY } from "./themeBootstrap";

function fakeRoot() {
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (token: string, force?: boolean) => {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
        return on;
      },
      add: (token: string) => void classes.add(token),
      remove: (token: string) => void classes.delete(token),
    },
    dataset: {} as Record<string, string | undefined>,
    setAttribute: (name: string, value: string) => {
      root.dataset[name.replace(/^data-/, "")] = value;
    },
  };
  return { root, classes };
}

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: (_type: "change", l: () => void) => void listeners.add(l),
    removeEventListener: (_type: "change", l: () => void) => void listeners.delete(l),
  };
  return {
    matchMedia: (query: string): MediaQueryLike => {
      assert.equal(query, DARK_MEDIA_QUERY);
      return media;
    },
    set: (dark: boolean) => {
      media.matches = dark;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

describe("settings store", () => {
  it("starts with DEFAULT_SETTINGS and persists changes as a versioned envelope", () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    assert.equal(storage.getItem(STORAGE_KEYS.settings), null, "nothing is written until the reader changes something");
    store.set("theme", "dark");
    store.set("density", "comfortable");
    store.set("timeFilter", "24h");
    store.set("hiddenSections", ["quantum", "robotics"]);
    store.set("collapsed", ["releases"]);
    store.set("sectionOrder", ["ai_security", "cyber"]);
    const raw = JSON.parse(storage.getItem(STORAGE_KEYS.settings) ?? "") as { v: number; data: Settings };
    assert.equal(raw.v, SETTINGS_VERSION);
    assert.deepEqual(raw.data, {
      theme: "dark",
      density: "comfortable",
      sectionOrder: ["ai_security", "cyber"],
      hiddenSections: ["quantum", "robotics"],
      collapsed: ["releases"],
      timeFilter: "24h",
      shortcuts: true,
      dimSeen: true,
    });
    // The reader's off switch for single-key shortcuts survives a reload.
    store.set("shortcuts", false);
    assert.equal(createSettingsStore({ storage }).get().shortcuts, false);
    store.set("shortcuts", true);
    raw.data.shortcuts = true;
    assert.deepEqual(createSettingsStore({ storage }).get(), raw.data);
    // So does "Dim headlines I have seen" (the store used to drop the key on every write).
    store.set("dimSeen", false);
    assert.equal(createSettingsStore({ storage }).get().dimSeen, false);
    store.reset();
    assert.equal(createSettingsStore({ storage }).get().dimSeen, true, "reset restores the default");
  });

  it("setting the same value again is a no-op (same state object, no notification)", () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.set("hiddenSections", ["quantum"]);
    const before = store.get();
    let calls = 0;
    store.subscribe(() => calls++);
    store.set("hiddenSections", ["quantum"]);
    store.set("theme", before.theme);
    assert.equal(store.get(), before);
    assert.equal(calls, 0);
  });

  it("invalid values cannot be persisted through set()", () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.set("theme", "neon" as never);
    store.set("timeFilter", "1y" as never);
    store.set("hiddenSections", ["quantum", "github_repos", 7] as never);
    assert.equal(store.get().theme, DEFAULT_SETTINGS.theme);
    assert.equal(store.get().timeFilter, DEFAULT_SETTINGS.timeFilter);
    assert.deepEqual(store.get().hiddenSections, ["quantum"]);
  });

  it("patch applies a section preset in one write; reset returns to the defaults", () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    let calls = 0;
    store.subscribe(() => calls++);
    const ciso = SECTION_PRESETS.find((p) => p.id === "ciso");
    assert.ok(ciso);
    store.patch({ sectionOrder: ciso.order, hiddenSections: ciso.hidden });
    assert.equal(calls, 1);
    assert.deepEqual(store.get().sectionOrder, ciso.order);
    store.reset();
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    const before = store.get();
    store.reset();
    assert.equal(store.get(), before);
  });

  it("effectiveSectionOrder appends unlisted sections in default order", () => {
    assert.deepEqual(effectiveSectionOrder({ sectionOrder: null }), [...SECTION_IDS]);
    const order = effectiveSectionOrder({ sectionOrder: ["cyber", "ai_security"] });
    assert.deepEqual(order.slice(0, 3), ["cyber", "ai_security", "models"]);
    assert.equal(order.length, SECTION_IDS.length);
    assert.equal(new Set(order).size, SECTION_IDS.length);
  });

  it("syncs across tabs", () => {
    const { tabs } = createTabs(2);
    const a = createSettingsStore({ storage: tabs[0].storage, events: tabs[0].events });
    const b = createSettingsStore({ storage: tabs[1].storage, events: tabs[1].events });
    a.set("theme", "dark");
    assert.equal(b.get().theme, "dark");
  });
});

describe("settings versioning", () => {
  it("parseSettings validates field by field: one bad field does not discard the others", () => {
    assert.deepEqual(parseSettings({ theme: "dark", density: 12, sectionOrder: "nope", hiddenSections: ["quantum", "bogus"], timeFilter: "6h" }), {
      theme: "dark",
      density: "compact",
      sectionOrder: null,
      hiddenSections: ["quantum"],
      collapsed: [],
      timeFilter: "6h",
      shortcuts: true,
      dimSeen: true,
    });
    // "Dim headlines I have seen": absent (settings and backups from before the field) means on.
    assert.equal(parseSettings({ dimSeen: false })?.dimSeen, false);
    assert.equal(parseSettings({ dimSeen: "off" })?.dimSeen, true, "only a real boolean is taken");
    assert.equal(parseSettings({ theme: "dark" })?.dimSeen, true);
    assert.equal(parseSettings({ shortcuts: false })?.shortcuts, false);
    assert.equal(parseSettings({ shortcuts: "no" })?.shortcuts, true, "only a real boolean is taken");
    assert.equal(parseSettings("dark"), null);
    assert.equal(parseSettings([]), null);
  });

  it("a stored object missing newer fields is completed from the defaults (additive fields need no version bump)", () => {
    const storage = createMemoryStorage({ [STORAGE_KEYS.settings]: JSON.stringify({ v: 1, data: { theme: "system" } }) });
    assert.deepEqual(createSettingsStore({ storage }).get(), { ...DEFAULT_SETTINGS, theme: "system" });
  });

  it("an unversioned or V1-shaped value is rejected, not half-read", () => {
    for (const raw of ['"dark"', "dark", '{"theme":"dark"}', "[1,2]"]) {
      const storage = createMemoryStorage({ [STORAGE_KEYS.settings]: raw });
      assert.deepEqual(createSettingsStore({ storage }).get(), DEFAULT_SETTINGS, raw);
    }
  });

  it("settings written by a NEWER client are not overwritten by this one", () => {
    const newer = JSON.stringify({ v: SETTINGS_VERSION + 1, data: { appearance: { theme: "dark" } } });
    const storage = createMemoryStorage({ [STORAGE_KEYS.settings]: newer });
    const store = createSettingsStore({ storage });
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    store.set("theme", "dark");
    assert.equal(store.get().theme, "dark", "applies for this page load");
    assert.equal(storage.getItem(STORAGE_KEYS.settings), newer, "but the newer data stays intact");
  });

  it("an older version is upgraded through the key's migrations", () => {
    // The mechanism the next SETTINGS_VERSION bump will use: v1 { dark: boolean } -> v2 { theme }.
    const NEXT: KeySpec<Settings> = defineKey({
      key: STORAGE_KEYS.settings,
      version: 2,
      parse: parseSettings,
      migrations: { 1: (d) => ({ ...(d as object), theme: (d as { dark?: boolean }).dark ? "dark" : "light" }) },
    });
    const res = decodeValue(JSON.stringify({ v: 1, data: { dark: true, density: "comfortable" } }), NEXT);
    assert.deepEqual(res, { status: "ok", migrated: true, value: { ...DEFAULT_SETTINGS, theme: "dark", density: "comfortable" } });
    assert.equal(SETTINGS_KEY.version, SETTINGS_VERSION);
  });
});

describe("settings: appearance on <html>", () => {
  it("resolveTheme", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("bogus", true), "light");
    assert.equal(resolveTheme(null, true), "light");
  });

  it("applies theme classes, data-theme and data-density at creation and on every change", () => {
    const { root, classes } = fakeRoot();
    const store = createSettingsStore({ storage: createMemoryStorage(), root });
    assert.deepEqual([...classes], ["light"]);
    assert.equal(root.dataset.theme, "light");
    assert.equal(root.dataset.density, "compact");
    store.set("theme", "dark");
    assert.deepEqual([...classes], ["dark"]);
    assert.equal(root.dataset.theme, "dark");
    store.set("density", "comfortable");
    assert.equal(root.dataset.density, "comfortable");
  });

  it("'system' follows prefers-color-scheme and tracks OS changes", () => {
    const { root, classes } = fakeRoot();
    const media = fakeMedia(true);
    const store = createSettingsStore({ storage: createMemoryStorage(), root, matchMedia: media.matchMedia });
    assert.deepEqual([...classes], ["light"], "default theme is light even on a dark OS");
    store.set("theme", "system");
    assert.deepEqual([...classes], ["dark"]);
    assert.equal(store.resolvedTheme(), "dark");
    media.set(false);
    assert.deepEqual([...classes], ["light"]);
    assert.equal(root.dataset.theme, "light");
    store.dispose();
    assert.equal(media.listeners.size, 0);
  });

  it("a theme change in another tab is applied here", () => {
    const { tabs } = createTabs(2);
    const { root, classes } = fakeRoot();
    createSettingsStore({ storage: tabs[0].storage, events: tabs[0].events, root });
    createSettingsStore({ storage: tabs[1].storage, events: tabs[1].events }).set("theme", "dark");
    assert.deepEqual([...classes], ["dark"]);
  });

  it("applyAppearance returns the resolved theme", () => {
    const { root } = fakeRoot();
    assert.equal(applyAppearance(root, { theme: "system", density: "compact" }, true), "dark");
  });
});

describe("settings: no-flash bootstrap script", () => {
  function run(items: Record<string, string>, prefersDark = false) {
    const { root, classes } = fakeRoot();
    const calls: string[] = [];
    const localStorage = {
      getItem: (k: string) => {
        calls.push(k);
        return items[k] ?? null;
      },
      setItem: () => assert.fail("the bootstrap must never write"),
      removeItem: () => assert.fail("the bootstrap must never write"),
    };
    const window = { matchMedia: () => ({ matches: prefersDark }) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("window", "document", "localStorage", THEME_BOOTSTRAP_SCRIPT)(window, { documentElement: root }, localStorage);
    return { classes: [...classes], theme: root.dataset.theme, density: root.dataset.density, calls };
  }

  it("its literal keys match the contract", () => {
    assert.equal(SETTINGS_STORAGE_KEY, STORAGE_KEYS.settings);
    assert.equal(V1_THEME_STORAGE_KEY, V1_STORAGE_KEYS.theme);
    assert.ok(THEME_BOOTSTRAP_SCRIPT.includes(JSON.stringify(STORAGE_KEYS.settings)));
    assert.ok(!THEME_BOOTSTRAP_SCRIPT.includes("</script"), "safe to inline");
    assert.ok(!/setItem|removeItem/.test(THEME_BOOTSTRAP_SCRIPT), "read-only");
  });

  it("applies the stored V2 theme and density before first paint", () => {
    const out = run({ [STORAGE_KEYS.settings]: JSON.stringify({ v: 1, data: { theme: "dark", density: "comfortable" } }) });
    assert.deepEqual(out, { classes: ["dark"], theme: "dark", density: "comfortable", calls: [STORAGE_KEYS.settings] });
  });

  it("resolves 'system' with matchMedia", () => {
    const stored = { [STORAGE_KEYS.settings]: JSON.stringify({ v: 1, data: { theme: "system" } }) };
    assert.equal(run(stored, true).theme, "dark");
    assert.equal(run(stored, false).theme, "light");
  });

  it("before the migration has run it reads (never writes) V1's theme", () => {
    const out = run({ [V1_STORAGE_KEYS.theme]: "dark" });
    assert.equal(out.theme, "dark");
    assert.deepEqual(out.calls, [STORAGE_KEYS.settings, V1_STORAGE_KEYS.theme]);
  });

  it("defaults to light/compact with nothing stored, with garbage, and when storage throws", () => {
    assert.deepEqual(run({}), { classes: ["light"], theme: "light", density: "compact", calls: [STORAGE_KEYS.settings, V1_STORAGE_KEYS.theme] });
    assert.equal(run({ [STORAGE_KEYS.settings]: "{broken" }).theme, "light");
    assert.equal(run({ [STORAGE_KEYS.settings]: '{"v":1,"data":{"theme":"<img onerror=x>"}}' }).theme, "light");
    const { root, classes } = fakeRoot();
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    new Function("window", "document", "localStorage", THEME_BOOTSTRAP_SCRIPT)({}, { documentElement: root }, throwing);
    assert.deepEqual([...classes], ["light"]);
  });

  it("agrees with the store about what <html> looks like", () => {
    const stored = JSON.stringify({ v: 1, data: { theme: "dark", density: "comfortable" } });
    const boot = run({ [STORAGE_KEYS.settings]: stored });
    const { root, classes } = fakeRoot();
    createSettingsStore({ storage: createMemoryStorage({ [STORAGE_KEYS.settings]: stored }), root });
    assert.deepEqual({ classes: [...classes], theme: root.dataset.theme, density: root.dataset.density }, { classes: boot.classes, theme: boot.theme, density: boot.density });
  });
});

// Type-level: the real browser objects satisfy the injected interfaces.
export function _typecheck(doc: Document, win: Window): [AppearanceRoot, MediaQueryLike] {
  return [doc.documentElement, win.matchMedia(DARK_MEDIA_QUERY)];
}
