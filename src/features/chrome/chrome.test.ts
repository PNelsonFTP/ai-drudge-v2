// Pure view-models of the chrome (model.ts): section order, tagline, banners, ticker, footer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTION_IDS, type SectionId } from "../../../shared/sections";
import { TIME_FILTERS } from "../../../shared/time";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_MS, fixtureFront, fixtureStocks } from "../../../test/helpers/fixtureData";
import { SECTION_PRESETS } from "../../app/presets";
import { EXAMPLE_ROUTES } from "../../app/routes";
import { DEFAULT_SETTINGS, REFRESH_INTERVAL_MS, STALE_BANNER_HOURS, type EditionState, type Settings } from "../../app/services";
import { MAIN_ID, SEARCH_INPUT_ID, sectionAnchorId } from "./ids";
import {
  STALE_AFTER_MINUTES_RANGE,
  TIME_CHIP_LABELS,
  TIME_FILTER_BUTTONS,
  bannerModels,
  centeredScrollLeft,
  feedsLabel,
  formatMarketTime,
  handleSearchKeyDown,
  orderedSections,
  refreshDue,
  resolveTheme,
  retryableLoader,
  scrollsSideways,
  shortcutsEnabled,
  showsTimeChips,
  siteUrl,
  staleThresholdHours,
  taglineModel,
  tickerModel,
} from "./model";
import { muteMessage, muteSourceName, sourceMuteChange, undoMute, watchSourceMutes, type MuteEvent } from "./muteModel";
import { APP_VERSION } from "./version";

const ids = (sections: { id: SectionId }[]): SectionId[] => sections.map((s) => s.id);
const HOUR = 3_600_000;

describe("orderedSections", () => {
  it("defaults to shared/sections order", () => {
    assert.deepEqual(ids(orderedSections({ sectionOrder: null, hiddenSections: [] })), [...SECTION_IDS]);
  });

  it("puts the reader's order first and appends unlisted sections in default order", () => {
    const got = ids(orderedSections({ sectionOrder: ["cyber", "ai_security"], hiddenSections: [] }));
    assert.deepEqual(got.slice(0, 2), ["cyber", "ai_security"]);
    assert.deepEqual(got.slice(2), SECTION_IDS.filter((id) => id !== "cyber" && id !== "ai_security"));
    assert.equal(got.length, SECTION_IDS.length);
  });

  it("drops hidden and muted sections", () => {
    const got = ids(orderedSections({ sectionOrder: null, hiddenSections: ["robotics", "quantum"] }, new Set<SectionId>(["releases"])));
    assert.equal(got.length, SECTION_IDS.length - 3);
    for (const id of ["robotics", "quantum", "releases"]) assert.ok(!got.includes(id as SectionId));
  });

  it("ignores unknown and duplicate ids from stored settings", () => {
    const got = ids(orderedSections({ sectionOrder: ["cyber", "not_a_section", "cyber", "model_releases"] as unknown as SectionId[], hiddenSections: ["gone"] as unknown as SectionId[] }));
    assert.equal(got[0], "cyber");
    assert.equal(got.length, SECTION_IDS.length);
    assert.equal(new Set(got).size, got.length);
  });

  it("every section preset yields all 15 sections exactly once", () => {
    for (const preset of SECTION_PRESETS) {
      const got = ids(orderedSections({ sectionOrder: preset.order, hiddenSections: preset.hidden }));
      assert.equal(new Set(got).size, SECTION_IDS.length - preset.hidden.length, preset.id);
      if (preset.order) assert.equal(got[0], preset.order[0], preset.id);
    }
  });
});

describe("time chips", () => {
  it("labels every filter and binds all but NEW to a button", () => {
    assert.deepEqual(TIME_FILTERS.map((f) => TIME_CHIP_LABELS[f]), ["NEW", "6H", "24H", "3D", "ALL"]);
    assert.deepEqual([...TIME_FILTER_BUTTONS], ["6h", "24h", "3d", "all"]);
  });
});

describe("resolveTheme", () => {
  it("follows the OS only for 'system'", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
  });
});

function editionState(overrides: Partial<EditionState> = {}): EditionState {
  return { ...createFakeServices().edition.get(), ...overrides };
}

describe("taglineModel", () => {
  const state = editionState();
  const at = (minutes: number) => taglineModel(state, FIXTURE_GENERATED_MS + minutes * 60_000, minutes / 60);

  it("counts stories and ticks with the clock", () => {
    assert.ok(fixtureFront.counts.stories > 100);
    assert.deepEqual(at(0), { stories: `${fixtureFront.counts.stories} stories`, updated: "updated just now", stale: false });
    assert.equal(at(12).updated, "updated 12m ago");
    assert.equal(at(13).updated, "updated 13m ago");
    assert.equal(at(185).updated, "updated 3h ago");
    assert.equal(at(60 * 50).updated, "updated 2d ago");
  });

  it("is stale only past the banner threshold", () => {
    assert.equal(at(STALE_BANNER_HOURS * 60).stale, false);
    assert.equal(at(STALE_BANNER_HOURS * 60 + 1).stale, true);
    assert.equal(taglineModel(state, FIXTURE_GENERATED_MS, null).stale, false);
  });

  it("says so when there is nothing to show yet or the load failed", () => {
    assert.deepEqual(taglineModel({ status: "loading", edition: null }, 0, null), { stories: null, updated: "loading…", stale: false });
    assert.deepEqual(taglineModel({ status: "error", edition: null }, 0, null), { stories: null, updated: "could not load", stale: false });
  });

  it("says 'still trying' between the attempts of the first load", () => {
    const retrying = { status: "loading" as const, edition: null, retrying: true };
    assert.deepEqual(taglineModel(retrying, 0, null), { stories: null, updated: "still trying…", stale: false });
    // Giving up wins; and with an edition on screen the flag changes nothing.
    assert.equal(taglineModel({ ...retrying, status: "error" }, 0, null).updated, "could not load");
    assert.equal(taglineModel({ ...state, retrying: true }, FIXTURE_GENERATED_MS + 12 * 60_000, 0.2).updated, "updated 12m ago");
    assert.equal(taglineModel({ status: "loading", edition: null, retrying: false }, 0, null).updated, "loading…");
  });

  it("is stale past status.json's staleAfterMinutes when the store publishes it", () => {
    const with90 = { ...state, staleAfterMinutes: 90 };
    const at90 = (minutes: number) => taglineModel(with90, FIXTURE_GENERATED_MS + minutes * 60_000, minutes / 60);
    assert.equal(at90(90).stale, false);
    assert.equal(at90(91).stale, true);
    assert.equal(at(91).stale, false, "without the field the constant (2 h) still applies");
  });

  it("uses the singular for one story", () => {
    const one = editionState();
    const edition = { ...one.edition!, counts: { ...one.edition!.counts, stories: 1 } };
    assert.equal(taglineModel({ status: "complete", edition }, FIXTURE_GENERATED_MS, 0).stories, "1 story");
  });
});

describe("staleThresholdHours", () => {
  it("is status.json's staleAfterMinutes in hours when the edition state carries it", () => {
    assert.equal(staleThresholdHours({ staleAfterMinutes: 90 }), 1.5);
    assert.equal(staleThresholdHours({ staleAfterMinutes: 180 }), 3);
    assert.equal(staleThresholdHours({ ...editionState(), staleAfterMinutes: 45 }), 0.75);
  });

  it("falls back to STALE_BANNER_HOURS when the field is absent, not a number or not believable", () => {
    assert.equal(STALE_BANNER_HOURS, 2);
    for (const state of [null, undefined, {}, editionState(), { staleAfterMinutes: "90" }, { staleAfterMinutes: null }, { staleAfterMinutes: Number.NaN }, { staleAfterMinutes: Number.POSITIVE_INFINITY }]) {
      assert.equal(staleThresholdHours(state), STALE_BANNER_HOURS, JSON.stringify(state)?.slice(0, 40));
    }
    // Shorter than one build cadence would flap on every refresh; longer than a day is no warning at all.
    assert.deepEqual(STALE_AFTER_MINUTES_RANGE, { min: 30, max: 1440 });
    for (const minutes of [0, -90, 1, 29, 1441, 100_000]) assert.equal(staleThresholdHours({ staleAfterMinutes: minutes }), STALE_BANNER_HOURS, String(minutes));
    assert.equal(staleThresholdHours({ staleAfterMinutes: 30 }), 0.5);
    assert.equal(staleThresholdHours({ staleAfterMinutes: 1440 }), 24);
  });
});

describe("showsTimeChips", () => {
  it("the shell's time chips are shown only where they act: the front page and #/new", () => {
    const shown = EXAMPLE_ROUTES.filter(showsTimeChips).map((r) => r.name);
    assert.deepEqual(shown, ["home", "new"]);
    // Section pages keep their own group (with counts); the other six pages have no time window.
    assert.deepEqual([...new Set(EXAMPLE_ROUTES.filter((r) => !showsTimeChips(r)).map((r) => r.name))], ["section", "search", "watch", "saved", "sources", "settings", "about"]);
  });
});

describe("scrollsSideways", () => {
  it("is true only when the content is wider than the box (one pixel of tolerance)", () => {
    assert.equal(scrollsSideways(1100, 375), true);
    assert.equal(scrollsSideways(1100, 1100), false);
    assert.equal(scrollsSideways(1101, 1100), false, "fractional layout widths round up by a pixel");
    assert.equal(scrollsSideways(1102, 1100), true);
    assert.equal(scrollsSideways(0, 0), false);
  });
});

describe("bannerModels", () => {
  const fresh = editionState();
  const idsOf = (input: Parameters<typeof bannerModels>[0]) => bannerModels(input).map((b) => b.id);

  it("shows nothing when the data is fresh", () => {
    assert.deepEqual(bannerModels({ state: fresh, staleHours: 0.3, online: true }), []);
    assert.deepEqual(bannerModels({ state: fresh, staleHours: STALE_BANNER_HOURS, online: true }), []);
    assert.deepEqual(bannerModels({ state: editionState({ status: "loading", edition: null, fetchedAtMs: null }), staleHours: null, online: true }), []);
  });

  it("warns about stale data past the threshold, with a retry", () => {
    const [banner, ...rest] = bannerModels({ state: fresh, staleHours: 7.4, online: true });
    assert.deepEqual(rest, []);
    assert.deepEqual(banner, { id: "stale", tone: "alert", text: "Headlines may be delayed — the last edition is 7 h old.", action: "retry", actionLabel: "Check again" });
    assert.match(bannerModels({ state: fresh, staleHours: 80, online: true })[0].text, /3 days old/);
  });

  it("does not flash the stale warning while only the cache is on screen (first revalidation pending)", () => {
    assert.deepEqual(idsOf({ state: editionState({ fetchedAtMs: null }), staleHours: 30, online: true }), []);
  });

  it("reports a failed first load", () => {
    const state = editionState({ status: "error", edition: null, error: "Failed to load headlines.", fetchedAtMs: null });
    assert.deepEqual(bannerModels({ state, staleHours: null, online: true }), [{ id: "error", tone: "alert", text: "Failed to load headlines.", action: "retry", actionLabel: "Retry" }]);
    assert.equal(bannerModels({ state: { ...state, error: "  " }, staleHours: null, online: true })[0].text, "Headlines could not be loaded.");
  });

  it("reports a failed refresh while older headlines are still shown (instead of the stale warning)", () => {
    const banners = bannerModels({ state: editionState({ error: "HTTP 503" }), staleHours: 9.2, online: true });
    assert.deepEqual(banners.map((b) => b.id), ["refresh-failed"]);
    assert.equal(banners[0].text, "Could not refresh — showing headlines from 9 h ago.");
    assert.equal(bannerModels({ state: editionState({ error: "x" }), staleHours: 0.4, online: true })[0].text, "Could not refresh — showing headlines from 24 min ago.");
  });

  it("offline wins over every other data banner", () => {
    assert.deepEqual(idsOf({ state: editionState({ error: "x" }), staleHours: 30, online: false }), ["offline"]);
    assert.match(bannerModels({ state: fresh, staleHours: 2.5, online: false })[0].text, /offline — showing the headlines loaded 2 h ago/);
    assert.match(bannerModels({ state: editionState({ status: "error", edition: null }), staleHours: null, online: false })[0].text, /cannot be loaded/);
  });

  it("past status.json's staleAfterMinutes (90) the stale banner shows at 1 h 31, not at 2 h", () => {
    const with90 = { ...fresh, staleAfterMinutes: 90 };
    assert.deepEqual(idsOf({ state: with90, staleHours: 1.5, online: true }), []);
    const [banner] = bannerModels({ state: with90, staleHours: 91 / 60, online: true });
    assert.equal(banner.id, "stale");
    assert.equal(banner.text, "Headlines may be delayed — the last edition is 1 h old.");
    assert.deepEqual(idsOf({ state: fresh, staleHours: 91 / 60, online: true }), [], "no status.json yet: the 2 h constant");
    // A longer threshold from the server is honoured too.
    assert.deepEqual(idsOf({ state: { ...fresh, staleAfterMinutes: 240 }, staleHours: 3.5, online: true }), []);
  });

  it("still trying: an info banner without a button between the attempts of the first load", () => {
    const state = { ...editionState({ status: "loading", edition: null, fetchedAtMs: null }), retrying: true };
    assert.deepEqual(bannerModels({ state, staleHours: null, online: true }), [
      { id: "retrying", tone: "info", text: "Still trying to load the headlines — the first attempt failed.", action: null, actionLabel: "" },
    ]);
    // Offline says more; a final error replaces it; an edition on screen never shows it.
    assert.deepEqual(idsOf({ state, staleHours: null, online: false }), ["offline"]);
    assert.deepEqual(idsOf({ state: { ...state, status: "error", error: "x", retrying: false }, staleHours: null, online: true }), ["error"]);
    assert.deepEqual(idsOf({ state: { ...fresh, retrying: true }, staleHours: 0.2, online: true }), []);
    assert.deepEqual(idsOf({ state: { ...state, retrying: false }, staleHours: null, online: true }), []);
  });

  it("changes not being saved: its own banner, after the data banner, dismissable", () => {
    const text = /not saving your changes \(its storage is full or blocked\)\. Bookmarks, mutes and settings you change now last until this tab is closed\./;
    const [only, ...none] = bannerModels({ state: fresh, staleHours: 0.3, online: true, storageRefused: true });
    assert.deepEqual(none, []);
    assert.deepEqual({ ...only, text: "" }, { id: "storage", tone: "alert", text: "", action: "dismiss", actionLabel: "Dismiss" });
    assert.match(only.text, text);
    assert.deepEqual(idsOf({ state: fresh, staleHours: 9, online: true, storageRefused: true }), ["stale", "storage"]);
    assert.deepEqual(idsOf({ state: editionState({ outdatedClient: true }), staleHours: 0.1, online: false, storageRefused: true }), ["outdated", "offline", "storage"]);
    assert.deepEqual(idsOf({ state: fresh, staleHours: 0.3, online: true, storageRefused: false }), []);
    assert.deepEqual(idsOf({ state: fresh, staleHours: 0.3, online: true }), [], "absent = saving works");
  });

  it("'new version' is independent and comes first, with a reload action", () => {
    const banners = bannerModels({ state: editionState({ outdatedClient: true }), staleHours: 8, online: true });
    assert.deepEqual(banners.map((b) => [b.id, b.action, b.tone]), [["outdated", "reload", "info"], ["stale", "retry", "alert"]]);
  });
});

describe("refreshDue", () => {
  const now = 1_000_000_000;
  it("is due one interval after the last successful fetch", () => {
    assert.equal(refreshDue(now, now - REFRESH_INTERVAL_MS + 1, 0, REFRESH_INTERVAL_MS), false);
    assert.equal(refreshDue(now, now - REFRESH_INTERVAL_MS, 0, REFRESH_INTERVAL_MS), true);
  });
  it("a failing refresh is not retried every tick", () => {
    assert.equal(refreshDue(now, now - 5 * REFRESH_INTERVAL_MS, now - 60_000, REFRESH_INTERVAL_MS), false);
    assert.equal(refreshDue(now, now - 5 * REFRESH_INTERVAL_MS, now - REFRESH_INTERVAL_MS, REFRESH_INTERVAL_MS), true);
  });
  it("with only cached data it waits one interval from the last attempt", () => {
    assert.equal(refreshDue(now, null, now - 1000, REFRESH_INTERVAL_MS), false);
    assert.equal(refreshDue(now, null, now - REFRESH_INTERVAL_MS, REFRESH_INTERVAL_MS), true);
  });
});

describe("tickerModel", () => {
  it("lists quotes in stocks.json order with formatted values", () => {
    const model = tickerModel(fixtureStocks);
    assert.ok(model);
    assert.deepEqual(model.quotes.map((q) => q.symbol), fixtureStocks.order);
    // The fixture's quotes are whatever the market did on the frozen day: each row follows its own numbers.
    for (const q of model.quotes) {
      const raw = fixtureStocks.quotes[q.symbol];
      assert.ok(raw.price !== null && raw.changePct !== null, q.symbol);
      assert.equal(q.dir, raw.changePct > 0 ? "up" : raw.changePct < 0 ? "down" : "flat", q.symbol);
      assert.match(q.price, /^\$\d+\.\d{2}$/);
      assert.equal(Number(q.price.slice(1)), Math.round(raw.price * 100) / 100, q.symbol);
      assert.match(q.change, /^[+-]\d+\.\d{2}%$/);
      assert.equal(q.change.startsWith("-"), raw.changePct < 0, q.symbol);
      assert.ok(q.spoken.startsWith(`${q.symbol}: ${q.price}, `) && (raw.changePct === 0 ? q.spoken.endsWith("unchanged") : q.spoken.endsWith(`${q.dir} ${q.change.slice(1, -1)} percent`)), q.spoken);
    }
    // The as-of note follows the market state of the file, whichever it was when the build ran.
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "open" })?.note, null, "open market: no as-of note");
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "closed" })?.note, `Closed · as of ${formatMarketTime(fixtureStocks.asOf)}`);
    assert.equal(model.note === null, fixtureStocks.marketState !== "closed");
  });

  it("respects a different order and skips symbols without a quote", () => {
    const [first, second] = fixtureStocks.order;
    const model = tickerModel({ ...fixtureStocks, order: [second, "NOPE", first] });
    assert.deepEqual(model?.quotes.map((q) => q.symbol), [second, first]);
  });

  it("formats up, flat and missing values", () => {
    const base = fixtureStocks.quotes[fixtureStocks.order[0]];
    const model = tickerModel({
      ...fixtureStocks,
      order: ["UP", "FLAT", "NOPCT", "NOPRICE"],
      quotes: {
        UP: { ...base, price: 10, changePct: 0.8 },
        FLAT: { ...base, price: 20, changePct: 0 },
        NOPCT: { ...base, price: 30, changePct: null },
        NOPRICE: { ...base, price: null, changePct: 1.5 },
      },
    });
    assert.deepEqual(model?.quotes.map((q) => [q.dir, q.price, q.change]), [
      ["up", "$10.00", "+0.80%"],
      ["flat", "$20.00", "+0.00%"],
      ["flat", "$30.00", "—"],
      ["up", "—", "+1.50%"],
    ]);
    assert.deepEqual(model?.quotes.map((q) => q.spoken), ["UP: $10.00, up 0.80 percent", "FLAT: $20.00, unchanged", "NOPCT: $30.00, change unavailable", "NOPRICE: price unavailable, up 1.50 percent"]);
  });

  it("is hidden (null) without data, without symbols, or when no quote has a price", () => {
    assert.equal(tickerModel(null), null);
    assert.equal(tickerModel({ ...fixtureStocks, order: [] }), null);
    const dead = Object.fromEntries(Object.entries(fixtureStocks.quotes).map(([k, q]) => [k, { ...q, price: null }]));
    assert.equal(tickerModel({ ...fixtureStocks, quotes: dead }), null);
  });

  it("labels quotes of a closed market with their market time (New York)", () => {
    // Saturday build; last trade Friday 4 PM New York = 21:00 UTC in November (EST).
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "closed", asOf: "2026-11-20T21:00:00Z" })?.note, "Closed · as of Fri 4:00 PM ET");
    // July: daylight time, 4 PM New York = 20:00 UTC.
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "closed", asOf: "2026-07-10T20:00:00Z" })?.note, "Closed · as of Fri 4:00 PM ET");
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "closed", asOf: null })?.note, "Market closed");
    assert.equal(tickerModel({ ...fixtureStocks, marketState: "closed", asOf: "not a date" })?.note, "Market closed");
  });

  it("formatMarketTime handles missing input", () => {
    assert.equal(formatMarketTime(null), "");
    assert.equal(formatMarketTime(undefined), "");
    assert.equal(formatMarketTime("2026-11-19T20:08:39.292Z"), "Thu 3:08 PM ET");
  });
});

describe("footer helpers", () => {
  it("feedsLabel", () => {
    assert.equal(feedsLabel({ stories: 1, placements: 1, feedsOk: 185, feedsTotal: 207 }), "185/207 feeds OK");
    assert.equal(feedsLabel(null), null);
    assert.equal(feedsLabel({ stories: 0, placements: 0, feedsOk: 0, feedsTotal: 0 }), null);
  });

  it("siteUrl joins the base and a file with exactly one slash", () => {
    assert.equal(siteUrl("/ai-drudge-v2/", "feed.xml"), "/ai-drudge-v2/feed.xml");
    assert.equal(siteUrl("/ai-drudge-v2", "/feeds.opml"), "/ai-drudge-v2/feeds.opml");
    assert.equal(siteUrl("/", "feed.xml"), "/feed.xml");
    assert.equal(siteUrl("./", "feed.xml"), "./feed.xml");
    assert.equal(siteUrl("https://example.org/x/", "feed.xml"), "https://example.org/x/feed.xml");
  });

  it("APP_VERSION equals package.json version", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    assert.equal(APP_VERSION, pkg.version);
  });
});

describe("ids", () => {
  it("are the ones the stylesheet and the keyboard contract document", () => {
    assert.equal(MAIN_ID, "main");
    assert.equal(SEARCH_INPUT_ID, "site-search");
    assert.equal(sectionAnchorId("ai_security"), "sec-ai_security");
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => fs.readFileSync(path.join(HERE, file), "utf8");

describe("shortcutsEnabled (the reader's off switch for single-key shortcuts)", () => {
  it("is on by default and for settings stored before the field existed", () => {
    assert.equal(shortcutsEnabled(DEFAULT_SETTINGS), true);
    assert.equal(shortcutsEnabled({ ...DEFAULT_SETTINGS, shortcuts: undefined } as unknown as Settings), true);
    assert.equal(shortcutsEnabled({ ...DEFAULT_SETTINGS, shortcuts: "no" } as unknown as Settings), true, "only a real false turns them off");
  });

  it("is off only for shortcuts: false", () => {
    assert.equal(shortcutsEnabled({ ...DEFAULT_SETTINGS, shortcuts: false } as Settings), false);
    assert.equal(shortcutsEnabled({ ...DEFAULT_SETTINGS, shortcuts: true } as Settings), true);
  });
});

describe("sourceMuteChange", () => {
  const state = (sources: string[], pendingNames: string[] = []) => ({ sources: new Set(sources), pendingNames });

  it("reports the one source that was muted or unmuted", () => {
    assert.deepEqual(sourceMuteChange(state([]), state(["a"])), { kind: "muted", id: "a" });
    assert.deepEqual(sourceMuteChange(state(["a"]), state(["a", "b"])), { kind: "muted", id: "b" });
    assert.deepEqual(sourceMuteChange(state(["a", "b"]), state(["b"])), { kind: "unmuted", id: "a" });
  });

  it("ignores everything that is not ONE deliberate mute", () => {
    const same = state(["a"]);
    assert.equal(sourceMuteChange(same, same), null, "no change");
    assert.equal(sourceMuteChange(same, { ...same }), null, "a section mute keeps the same source set");
    assert.equal(sourceMuteChange(state([]), state(["a", "b"])), null, "restore / import: several at once");
    assert.equal(sourceMuteChange(state(["a", "b", "c"]), state([])), null, "unmute everything");
    assert.equal(sourceMuteChange(state(["a"]), state(["b"])), null, "swap");
    // A V1 muted NAME resolved against sources.json adds a source and drops the pending name.
    assert.equal(sourceMuteChange(state([], ["Techmeme"]), state(["techmeme"], [])), null);
    assert.equal(sourceMuteChange(state(["a"], ["X", "Y"]), state(["a", "b"], ["Y", "X"])), null);
  });
});

describe("watchSourceMutes / undoMute (mute notice)", () => {
  const SRC = "the-information";
  function setup(opts: Parameters<typeof createFakeServices>[0] = {}) {
    const services = createFakeServices(opts);
    const events: (MuteEvent | null)[] = [];
    const stop = watchSourceMutes(services, (e) => events.push(e));
    return { services, events, stop };
  }

  it("reports a mute from ANY caller with the source's display name and the spoken message", () => {
    const { services, events } = setup();
    const id = Object.keys(services.edition.get().edition?.sources ?? {})[0];
    const name = services.edition.get().edition?.sources[id]?.name ?? "";
    assert.ok(id && name && name !== id, "fixture has a named source");
    // Straight on the store: what a row's mute button, a river row or the Sources page does.
    services.mutes.toggleSource(id);
    assert.deepEqual(events, [{ kind: "muted", id, name, message: `Muted source: ${name}. Press u to undo.` }]);
  });

  it("undo unmutes it again, announces that, and cannot re-mute by a second undo", () => {
    const { services, events } = setup();
    services.mutes.toggleSource(SRC);
    assert.equal(undoMute(services.mutes, SRC), true);
    assert.ok(!services.mutes.get().sources.has(SRC));
    assert.equal(events.at(-1)?.kind, "unmuted");
    assert.match(events.at(-1)?.message ?? "", /^Showing .+ again$/);
    assert.equal(undoMute(services.mutes, SRC), false, "already unmuted: a late Undo must not mute it again");
    assert.ok(!services.mutes.get().sources.has(SRC));
    assert.equal(services.calls.filter((c) => c === `mutes.toggleSource ${SRC}`).length, 2);
  });

  it("reports null for bulk changes and section mutes (no notice, an open one is re-checked)", () => {
    const { services, events } = setup({ mutedSources: ["a", "b"] });
    services.mutes.toggleSection("quantum");
    services.mutes.clear();
    assert.deepEqual(events, [null, null]);
  });

  it("stops reporting after unsubscribe", () => {
    const { services, events, stop } = setup();
    stop();
    services.mutes.toggleSource(SRC);
    assert.deepEqual(events, []);
  });

  it("points at the visible notice instead of the u key when single-key shortcuts are off", () => {
    const { services, events } = setup({ settings: { shortcuts: false } as Partial<Settings> });
    services.mutes.toggleSource(SRC);
    assert.doesNotMatch(events[0]?.message ?? "", /Press u/);
    assert.match(events[0]?.message ?? "", /^Muted source: .+\. Undo is in the notice/);
    assert.match(muteMessage("X"), /Press u to undo\.$/);
  });

  it("muteSourceName: edition first, then sources.json, then the id", async () => {
    const services = createFakeServices();
    const edition = services.edition.get().edition;
    const id = Object.keys(edition?.sources ?? {})[0];
    assert.equal(muteSourceName(services, id), edition?.sources[id]?.name);
    assert.equal(muteSourceName(services, "not-a-source"), "not-a-source");
    await services.sourcesData.load();
    const all = services.sourcesData.get().sources?.sources ?? [];
    const outside = all.find((s) => !(s.id in (edition?.sources ?? {})));
    if (outside) assert.equal(muteSourceName(services, outside.id), outside.name);
    assert.ok(all.length > 0);
    assert.equal(muteSourceName(services, all[0].id), all[0].name);
  });
});

describe("centeredScrollLeft (current section chip on phones)", () => {
  it("centres the chip in the scroller", () => {
    // 15 chips, about 1,000 px of them in a 350 px row; chip 14 starts at 900 and is 60 wide.
    assert.equal(centeredScrollLeft(900, 60, 350, 1000), 650, "clamped to the end of the row");
    assert.equal(centeredScrollLeft(500, 60, 350, 1000), 355);
  });

  it("never scrolls before the start, and not at all when everything fits", () => {
    assert.equal(centeredScrollLeft(10, 60, 350, 1000), 0);
    assert.equal(centeredScrollLeft(200, 60, 800, 800), 0);
    assert.equal(centeredScrollLeft(200, 60, 800, 600), 0);
  });
});

describe("search box: Escape", () => {
  function keyEvent(key: string, isComposing = false) {
    const log: string[] = [];
    const event = { key, nativeEvent: { isComposing }, preventDefault: () => void log.push("preventDefault"), currentTarget: { blur: () => void log.push("blur") } };
    return { event, log };
  }

  it("leaves the field WITHOUT the browser's default (Chrome and Safari clear a search field on Escape)", () => {
    const { event, log } = keyEvent("Escape");
    assert.equal(handleSearchKeyDown(event), true);
    // preventDefault keeps the query (and with it the results page); the document-level handler
    // skips default-prevented events, so the field blurs itself.
    assert.deepEqual(log, ["preventDefault", "blur"]);
  });

  it("leaves Escape to an IME composition, and every other key alone", () => {
    const composing = keyEvent("Escape", true);
    assert.equal(handleSearchKeyDown(composing.event), false);
    assert.deepEqual(composing.log, []);
    for (const key of ["Enter", "a", "/", "Tab", "Esc"]) {
      const { event, log } = keyEvent(key);
      assert.equal(handleSearchKeyDown(event), false, key);
      assert.deepEqual(log, [], key);
    }
  });

  it("is wired to the input, which also reports search intent on focus", () => {
    const src = source("SearchBox.tsx");
    assert.match(src, /onKeyDown=\{handleSearchKeyDown\}/);
    assert.match(src, /onFocus=\{onIntent\}/);
  });
});

describe("retryableLoader (lazy chunks)", () => {
  it("shares one download between callers", async () => {
    let calls = 0;
    const load = retryableLoader(async () => ++calls);
    const [a, b] = await Promise.all([load(), load()]);
    assert.deepEqual([a, b, calls], [1, 1, 1]);
    assert.equal(await load(), 1);
    assert.equal(calls, 1);
  });

  it("forgets a failure, so the next call retries", async () => {
    let calls = 0;
    const load = retryableLoader(async () => {
      if (++calls === 1) throw new Error("chunk failed");
      return "ok";
    });
    await assert.rejects(load(), /chunk failed/);
    assert.equal(await load(), "ok");
    assert.equal(calls, 2);
  });
});

describe("briefing dialog is not in the entry bundle", () => {
  const masthead = source("Masthead.tsx");

  it("Masthead imports nothing of the export feature statically (types aside)", () => {
    const statics = [...masthead.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].filter((m) => !m[1]).map((m) => m[2]);
    assert.ok(statics.length >= 4, "import scan found the imports");
    assert.deepEqual(statics.filter((from) => /export|BriefingDialog|\.css$/.test(from)), []);
    assert.match(masthead, /retryableLoader\(\(\) => import\("\.\/BriefingDialog"\)\)/);
    assert.doesNotMatch(masthead, /\blazy\(/, "React.lazy would send a failed chunk to the app error boundary");
  });

  it("the lazy module brings the dialog, the panel and the kit stylesheet", () => {
    const dialog = source("BriefingDialog.tsx");
    assert.match(dialog, /^import "\.\.\/export\/kit\/kit\.css";$/m);
    assert.match(dialog, /import \{ BriefingPanel \} from "\.\.\/export\/BriefingExportButton";/);
    assert.match(dialog, /export default function BriefingDialog/);
  });
});

describe("phone menu: Escape", () => {
  it("returns focus to the Menu button before the toolbar is hidden, and leaves a dialog's Escape alone", () => {
    const src = source("Masthead.tsx");
    assert.match(src, /getElementById\(TOOLBAR_ID\)\?\.contains\(document\.activeElement\)\) menuButtonRef\.current\?\.focus\(\)/);
    assert.match(src, /<button ref=\{menuButtonRef\}[^>]*className="tool-btn menu-btn"/);
    assert.ok(src.indexOf('querySelector("dialog[open]")') < src.indexOf("menuButtonRef.current?.focus()"));
  });
});
