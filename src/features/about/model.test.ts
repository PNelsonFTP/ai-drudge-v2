import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WEIGHT_CLASSES } from "../../../shared/select";
import { HOUR_MS } from "../../../shared/time";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { FIXTURE_GENERATED_AT, FIXTURE_GENERATED_MS, fixtureBrief, fixtureFront, fixtureHealth } from "../../../test/helpers/fixtureData";
import { staleThresholdHours } from "../chrome/model";
import { BADGE_LEGEND, SEEN_LEGEND_LABEL, SHORTCUTS, WEIGHT_LEGEND, briefReasonText, freshness, staleAfterText } from "./model";

describe("about/model - reference data", () => {
  it("lists every shortcut of the keyboard plan exactly once", () => {
    const keys = SHORTCUTS.map((s) => s.keys.join(" "));
    assert.equal(new Set(keys).size, keys.length);
    for (const expected of ["j k", "o Enter", "s", "a", "b", "l", "m", "/", "[ ]", "g h", "g s", "g l", "g w", "g n", "?", "Esc"]) {
      assert.ok(keys.includes(expected), `missing ${expected}`);
    }
    assert.ok(SHORTCUTS.every((s) => s.action.length > 3));
  });

  it("explains all four emphasis levels with the real headline classes, biggest first", () => {
    assert.deepEqual(WEIGHT_LEGEND.map((w) => w.className), [WEIGHT_CLASSES[3], WEIGHT_CLASSES[2], WEIGHT_CLASSES[1], WEIGHT_CLASSES[0]]);
    assert.match(WEIGHT_LEGEND[0].meaning, /8 or more publishers/);
    assert.match(WEIGHT_LEGEND[1].meaning, /3 or more publishers/);
  });

  it("explains the badges a reader meets: NEW, +N, source, the four article flags, dimming, watch highlight", () => {
    const labels = BADGE_LEGEND.map((b) => b.label);
    for (const l of ["NEW", "+4", "release", "paper", "thread", "paywall", SEEN_LEGEND_LABEL, "highlight"]) assert.ok(labels.includes(l), l);
    assert.match(BADGE_LEGEND.find((b) => b.label === "NEW")!.meaning, /6 hours/);
    assert.equal(new Set(labels).size, labels.length);
  });

  it("tells seen grey from low-tier grey without relying on colour, and says what is never dimmed", () => {
    const low = WEIGHT_LEGEND.find((w) => w.className === WEIGHT_CLASSES[0])!;
    assert.equal(low.sample, "Grey italic");
    assert.match(low.meaning, /low-tier source .*Italic, so it is not mistaken for a headline you have already seen\./);
    const seen = BADGE_LEGEND.find((b) => b.label === SEEN_LEGEND_LABEL)!;
    assert.equal(seen.className, "headline-seen", "drawn with the class a seen row carries");
    assert.match(seen.meaning, /upright: you already saw the headline during an earlier visit \(a low-tier source is grey and italic\)/);
    assert.match(seen.meaning, /never the lead story, TOP STORIES or your saved lists/);
    assert.equal(SHORTCUTS.find((s) => s.keys[0] === "Esc")?.action, "Close a dialog or menu, leave the search box");
  });

  it("says why an edition has no AI-written brief, in plain words, from the coarse reason code only", () => {
    assert.equal(briefReasonText("no-key"), "the build has no key for the AI service, so no model was asked");
    for (const code of ["thin", "http-4xx", "http-5xx", "timeout", "network", "refusal", "truncated", "invalid-reply", "error"]) {
      const t = briefReasonText(code);
      assert.ok(t && !t.includes(code) && !/[.:]$/.test(t), `${code}: ${t}`);
    }
    assert.equal(briefReasonText("rate-limited"), "reason code “rate-limited”", "an unknown code is shown as a code");
    for (const bad of [undefined, null, "", "HTTP 401: invalid x-api-key sk-ant-…", "<b>x</b>", "a".repeat(40), "toString", "constructor"]) {
      const t = briefReasonText(bad);
      assert.ok(t === null || t === `reason code “${bad}”`, String(bad));
    }
    assert.equal(briefReasonText("HTTP 401: invalid x-api-key"), null, "free text is never rendered");
    const s = createFakeServices({ brief: { ...fixtureBrief, source: "fallback", fallbackReason: "timeout" } });
    assert.equal(freshness(s.edition.get(), s.clock.get()).briefReason, "the AI service did not answer in time");
    const ai = createFakeServices({ brief: { ...fixtureBrief, source: "claude", model: "m", fallbackReason: "timeout" } });
    assert.equal(freshness(ai.edition.get(), ai.clock.get()).briefReason, null, "an AI-written brief has no fallback reason");
  });
});

describe("about/model - freshness", () => {
  it("reports the edition time, age, build id and counts", () => {
    const s = createFakeServices();
    const f = freshness(s.edition.get(), s.clock.get());
    assert.deepEqual(f, {
      available: true,
      generatedAt: FIXTURE_GENERATED_AT,
      age: "20m",
      buildId: FIXTURE_GENERATED_AT,
      stories: fixtureFront.counts.stories,
      feedsOk: fixtureHealth.feeds.filter((x) => x.ok).length,
      feedsTotal: fixtureHealth.feeds.length,
      stale: false,
      staleAfter: "2 hours",
      brief: fixtureBrief.source,
      briefModel: null,
      // The fixture is a build without an API key: the deterministic brief, with its reason code.
      briefReason: briefReasonText(fixtureBrief.fallbackReason),
    });
    assert.equal(fixtureBrief.source, "fallback");
    assert.ok(f.feedsOk < f.feedsTotal, "fixture: a few sources are not ok, so the two numbers differ");
    // A build that recorded no reason (an edition written before the field existed) reports none.
    const old = createFakeServices({ brief: { ...fixtureBrief, fallbackReason: undefined } });
    assert.equal(freshness(old.edition.get(), old.clock.get()).briefReason, null);
  });

  it("flags stale data after the banner threshold (2 h: four missed 30-minute builds)", () => {
    const s = createFakeServices();
    assert.equal(freshness(s.edition.get(), FIXTURE_GENERATED_MS + 1.9 * HOUR_MS).stale, false);
    const late = freshness(s.edition.get(), FIXTURE_GENERATED_MS + 2.1 * HOUR_MS);
    assert.equal(late.stale, true);
    assert.equal(late.age, "2h");
  });

  it("uses the shell's threshold: status.json staleAfterMinutes once it has loaded (About never contradicts the banner)", () => {
    const s = createFakeServices({ staleAfterMinutes: 90 });
    const state = s.edition.get();
    assert.equal(staleThresholdHours(state), 1.5);
    assert.equal(freshness(state, FIXTURE_GENERATED_MS + 89 * 60_000).stale, false);
    const late = freshness(state, FIXTURE_GENERATED_MS + 91 * 60_000);
    assert.deepEqual([late.stale, late.staleAfter], [true, "90 minutes"]);
    // An unbelievable value falls back to the constant, like the banner.
    const odd = createFakeServices({ staleAfterMinutes: 5 });
    assert.deepEqual([freshness(odd.edition.get(), FIXTURE_GENERATED_MS + 91 * 60_000).stale, freshness(odd.edition.get(), 0).staleAfter], [false, "2 hours"]);
    assert.deepEqual([staleAfterText(1), staleAfterText(3), staleAfterText(0.5), staleAfterText(24)], ["1 hour", "3 hours", "30 minutes", "24 hours"]);
  });

  it("names the model when the edition carries an AI-written brief (audit trail)", () => {
    const s = createFakeServices({ brief: { ...fixtureBrief, source: "claude", model: "claude-test-model" } });
    const f = freshness(s.edition.get(), s.clock.get());
    assert.deepEqual([f.brief, f.briefModel], ["claude", "claude-test-model"]);
    const none = createFakeServices({ brief: null });
    assert.deepEqual([freshness(none.edition.get(), 0).brief, freshness(none.edition.get(), 0).briefModel], [null, null]);
  });

  it("is safe without an edition", () => {
    const s = createFakeServices({ loaded: "loading" });
    const f = freshness(s.edition.get(), 0);
    assert.equal(f.available, false);
    assert.equal(f.stale, false);
    assert.equal(f.buildId, "");
  });
});
