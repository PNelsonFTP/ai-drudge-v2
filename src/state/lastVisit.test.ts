import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeArticle, makeEdition } from "../../test/helpers/factories";
import { countNewSince } from "../../shared/select";
import { passesTimeFilter } from "../../shared/time";
import { STORAGE_KEYS } from "../app/services";
import { LAST_VISIT_KEY, SESSION_GAP_MS, nextVisitRecord, readLastVisit } from "./lastVisit";
import { createMemoryStorage, readKey } from "./storage";
import { brokenStorage, quotaStorage, recordWrites } from "./testkit";

const T0 = Date.parse("2026-11-19T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("last visit", () => {
  it("first visit: previousMs is null and the visit is recorded", () => {
    const storage = createMemoryStorage();
    assert.equal(readLastVisit(storage, T0).get().previousMs, null);
    assert.deepEqual(readKey(storage, LAST_VISIT_KEY), { status: "ok", migrated: false, value: { previousMs: null, lastSeenMs: T0, seenEditionMs: null } });
  });

  it("a reload within the session keeps previousMs (V1 zeroed the banner on every reload)", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0);
    const second = readLastVisit(storage, T0 + 5 * HOUR); // new session
    assert.equal(second.get().previousMs, T0);
    const reload = readLastVisit(storage, T0 + 5 * HOUR + 2 * MIN);
    assert.equal(reload.get().previousMs, T0, "same session: unchanged");
    const again = readLastVisit(storage, T0 + 5 * HOUR + 20 * MIN);
    assert.equal(again.get().previousMs, T0);
  });

  it("a new session starts after SESSION_GAP_MS without activity", () => {
    assert.equal(nextVisitRecord({ previousMs: 1, lastSeenMs: T0, seenEditionMs: null }, T0 + SESSION_GAP_MS).previousMs, 1);
    assert.equal(nextVisitRecord({ previousMs: 1, lastSeenMs: T0, seenEditionMs: null }, T0 + SESSION_GAP_MS + 1).previousMs, T0);
  });

  it("the cut-off of the next session is the newest EDITION shown, not the reader's clock", () => {
    const storage = createMemoryStorage();
    const visit = readLastVisit(storage, T0);
    // The reader saw the 11:08 build at 12:00, then the 12:08 build after an auto-refresh at 12:10.
    const build1 = T0 - 52 * MIN;
    const build2 = T0 + 8 * MIN;
    visit.noteEdition(build1, T0 + 1_000);
    visit.noteEdition(build2, T0 + 10 * MIN);
    visit.noteEdition(build1, T0 + 11 * MIN); // an older copy (stale CDN) never moves it back
    const next = readLastVisit(storage, T0 + 6 * HOUR);
    assert.equal(next.get().previousMs, build2);
  });

  it("previousMs works with the shared 'new' rules (firstSeenAt after the last edition shown)", () => {
    const storage = createMemoryStorage();
    const shownBuild = T0;
    readLastVisit(storage, T0 + 3 * MIN).noteEdition(shownBuild, T0 + 3 * MIN);
    const { previousMs } = readLastVisit(storage, T0 + 8 * HOUR).get();
    assert.equal(previousMs, shownBuild);
    // Published long before the visit, but only ingested by a LATER build: V1 missed these.
    const lateIngest = makeArticle({ publishedAt: new Date(T0 - 5 * HOUR).toISOString(), firstSeenAt: new Date(T0 + HOUR).toISOString() });
    const alreadyShown = makeArticle({ publishedAt: new Date(T0 - HOUR).toISOString(), firstSeenAt: new Date(shownBuild).toISOString() });
    const now = T0 + 8 * HOUR;
    assert.equal(passesTimeFilter(lateIngest, "new", now, previousMs), true);
    assert.equal(passesTimeFilter(alreadyShown, "new", now, previousMs), false);
    const { edition } = makeEdition({ articles: [lateIngest, alreadyShown] });
    assert.equal(countNewSince(edition, previousMs ?? 0), 1);
  });

  it("activity keeps the session alive: a tab open for hours does not become its own 'previous visit'", () => {
    const storage = createMemoryStorage();
    const visit = readLastVisit(storage, T0);
    for (let m = 10; m <= 180; m += 10) visit.noteEdition(T0 + m * MIN - 2 * MIN, T0 + m * MIN);
    const reload = readLastVisit(storage, T0 + 185 * MIN);
    assert.equal(reload.get().previousMs, null, "still the first session");
  });

  it("noteEdition merges with another tab of the same session and writes only on change", () => {
    const rec = recordWrites(createMemoryStorage());
    const a = readLastVisit(rec.storage, T0);
    const b = readLastVisit(rec.storage, T0 + MIN);
    a.noteEdition(T0 + 5 * MIN, T0 + 6 * MIN);
    b.noteEdition(T0 + 2 * MIN, T0 + 3 * MIN); // older on both counts
    const res = readKey(rec.storage, LAST_VISIT_KEY);
    assert.deepEqual(res.status === "ok" && res.value, { previousMs: null, lastSeenMs: T0 + 6 * MIN, seenEditionMs: T0 + 5 * MIN });
    const writes = rec.writes.length;
    a.noteEdition(T0 + 5 * MIN, T0 + 6 * MIN);
    assert.equal(rec.writes.length, writes);
    a.noteEdition(Number.NaN, T0);
    assert.equal(rec.writes.length, writes);
  });

  it("clear forgets the previous visit like a first visit; the session goes on being recorded", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0).noteEdition(T0 - 10 * MIN, T0);
    const visit = readLastVisit(storage, T0 + 6 * HOUR); // a later session: there is a cut-off
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
    let told = 0;
    visit.subscribe(() => told++);
    visit.clear();
    assert.equal(visit.get().previousMs, null);
    assert.equal(told, 1);
    assert.equal(storage.getItem(STORAGE_KEYS.lastVisit), null, "the stored record is removed");
    visit.clear();
    assert.equal(told, 1, "clearing twice tells nobody twice");
    // A reload right after the erase is a first visit...
    assert.equal(readLastVisit(createMemoryStorage(), T0 + 6 * HOUR + MIN).get().previousMs, null);
    // ...and the open tab keeps recording, so the visit after this one has a cut-off again.
    const build = T0 + 6 * HOUR + 2 * MIN;
    visit.noteEdition(build, T0 + 6 * HOUR + 3 * MIN);
    assert.equal(visit.get().previousMs, null);
    assert.equal(readLastVisit(storage, T0 + 12 * HOUR).get().previousMs, build);
  });

  it("markAllSeen moves the cut-off forward, tells subscribers and survives a reload inside the session", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0);
    const visit = readLastVisit(storage, T0 + 2 * HOUR);
    assert.equal(visit.get().previousMs, T0);
    let notified = 0;
    visit.subscribe(() => notified++);
    visit.markAllSeen(T0 + 2 * HOUR + 5 * MIN);
    assert.equal(visit.get().previousMs, T0 + 2 * HOUR + 5 * MIN);
    assert.equal(notified, 1);
    // Never backwards, and no second notification for the same instant.
    visit.markAllSeen(T0 + HOUR);
    visit.markAllSeen(T0 + 2 * HOUR + 5 * MIN);
    visit.markAllSeen(Number.NaN);
    assert.equal(visit.get().previousMs, T0 + 2 * HOUR + 5 * MIN);
    assert.equal(notified, 1);
    assert.equal(readLastVisit(storage, T0 + 2 * HOUR + 10 * MIN).get().previousMs, T0 + 2 * HOUR + 5 * MIN, "a reload keeps the marked cut-off");
    // noteEdition after the mark does not undo it.
    visit.noteEdition(T0 + 2 * HOUR + 6 * MIN, T0 + 2 * HOUR + 7 * MIN);
    const rec = readKey(storage, LAST_VISIT_KEY);
    assert.equal(rec.status === "ok" && rec.value.previousMs, T0 + 2 * HOUR + 5 * MIN);
  });

  it("markAllSeen on a first visit sets a cut-off; without usable storage it still works for the page", () => {
    const first = readLastVisit(createMemoryStorage(), T0);
    first.markAllSeen(T0 + MIN);
    assert.equal(first.get().previousMs, T0 + MIN);
    const broken = readLastVisit(brokenStorage(), T0);
    assert.doesNotThrow(() => broken.markAllSeen(T0 + MIN));
    assert.equal(broken.get().previousMs, T0 + MIN);
  });

  it("a tab left open rolls the session: back after a long gap, the cut-off is the last edition shown before it", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0 - 3 * HOUR).noteEdition(T0 - 3 * HOUR - 20 * MIN, T0 - 3 * HOUR);
    const visit = readLastVisit(storage, T0); // new session: cut-off = the edition of the earlier visit
    const cut0 = T0 - 3 * HOUR - 20 * MIN;
    assert.equal(visit.get().previousMs, cut0);
    let notified = 0;
    visit.subscribe(() => notified++);
    // Watched for 7 h: a heartbeat every 10 min, a new build every 30 min. Never rolls.
    let lastBuild = 0;
    for (let m = 0; m <= 7 * 60; m += 10) {
      lastBuild = T0 + Math.floor(m / 30) * 30 * MIN - 8 * MIN;
      visit.noteEdition(lastBuild, T0 + m * MIN);
    }
    assert.equal(visit.get().previousMs, cut0, "continuous viewing keeps the cut-off");
    assert.equal(notified, 0);
    // Hidden for 14 h (no heartbeats), then visible again: the edition still on screen is noted first.
    const back = T0 + 21 * HOUR;
    visit.noteEdition(lastBuild, back);
    assert.equal(visit.get().previousMs, lastBuild, "what was last on screen is no longer new");
    assert.equal(notified, 1);
    // The refresh that follows brings the newest build: it is noted, the cut-off stays.
    visit.noteEdition(back - 5 * MIN, back + 2_000);
    assert.equal(visit.get().previousMs, lastBuild);
    const rec = readKey(storage, LAST_VISIT_KEY);
    assert.deepEqual(rec.status === "ok" && rec.value, { previousMs: lastBuild, lastSeenMs: back + 2_000, seenEditionMs: back - 5 * MIN });
    // A reload a minute later is the same session and keeps that cut-off (it used to stay at cut0 for days).
    assert.equal(readLastVisit(storage, back + MIN).get().previousMs, lastBuild);
  });

  it("the roll also works when the first thing noted after the gap is already the new edition", () => {
    const storage = createMemoryStorage();
    const visit = readLastVisit(storage, T0);
    visit.noteEdition(T0 - 10 * MIN, T0);
    visit.noteEdition(T0 + 13 * HOUR, T0 + 14 * HOUR);
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
  });

  it("a tab loaded in the background and looked at later keeps its cut-off (nothing was shown yet)", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0).noteEdition(T0 - 10 * MIN, T0);
    // Session restore of a pinned tab 3 h later: a new session, loaded hidden, so nothing is noted.
    const visit = readLastVisit(storage, T0 + 3 * HOUR);
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
    // First look 2 h after that: the edition fetched while hidden must not become the cut-off.
    visit.noteEdition(T0 + 3 * HOUR - 9 * MIN, T0 + 5 * HOUR);
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
  });

  it("a roll in one tab reaches the other tabs of the session at their next heartbeat", () => {
    const storage = createMemoryStorage();
    const a = readLastVisit(storage, T0);
    const b = readLastVisit(storage, T0 + MIN);
    a.noteEdition(T0 - 10 * MIN, T0 + 2 * MIN);
    a.noteEdition(T0 + 5 * HOUR, T0 + 6 * HOUR);
    assert.equal(a.get().previousMs, T0 - 10 * MIN);
    assert.equal(b.get().previousMs, null);
    b.noteEdition(T0 + 5 * HOUR, T0 + 6 * HOUR + MIN);
    assert.equal(b.get().previousMs, T0 - 10 * MIN);
  });

  it("markAllSeen uses the newest edition SHOWN, not the reader's clock: a build that is not deployed yet stays new", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0 - 5 * HOUR);
    const visit = readLastVisit(storage, T0);
    const shown = T0 - 22 * MIN; // the 11:38 build is on screen
    visit.noteEdition(shown, T0);
    // The 12:08 build was stamped at 12:08:37 and is still deploying when the reader clicks at 12:10.
    const stamped = T0 + 8 * MIN + 37_000;
    visit.markAllSeen(T0 + 10 * MIN);
    assert.equal(visit.get().previousMs, shown);
    const onScreen = makeArticle({ firstSeenAt: new Date(shown).toISOString() });
    const nextBuild = makeArticle({ firstSeenAt: new Date(stamped).toISOString() });
    const { edition } = makeEdition({ articles: [onScreen, nextBuild] });
    assert.equal(countNewSince(edition, visit.get().previousMs ?? 0), 1, "only the story of the build that arrives later");
    // Once that build is shown, marking again moves the cut-off to it.
    visit.noteEdition(stamped, T0 + 15 * MIN);
    visit.markAllSeen(T0 + 16 * MIN);
    assert.equal(visit.get().previousMs, stamped);
    assert.equal(readLastVisit(storage, T0 + 20 * MIN).get().previousMs, stamped, "a reload keeps it");
  });

  it("storage that refuses writes: the page keeps its own record (a later heartbeat does not undo 'mark all seen')", () => {
    const inner = createMemoryStorage();
    readLastVisit(inner, T0 - 5 * HOUR).noteEdition(T0 - 5 * HOUR - 10 * MIN, T0 - 5 * HOUR);
    const visit = readLastVisit(quotaStorage(inner), T0);
    assert.equal(visit.get().previousMs, T0 - 5 * HOUR - 10 * MIN);
    visit.noteEdition(T0 - 10 * MIN, T0 + MIN);
    visit.markAllSeen(T0 + 2 * MIN);
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
    visit.noteEdition(T0 + 20 * MIN, T0 + 30 * MIN);
    assert.equal(visit.get().previousMs, T0 - 10 * MIN);
  });

  it("a clock that jumped backwards does not start a new session", () => {
    const storage = createMemoryStorage();
    readLastVisit(storage, T0);
    assert.equal(readLastVisit(storage, T0 - 3 * HOUR).get().previousMs, null);
  });

  it("tolerates corrupt, V1-shaped, newer and unavailable storage", () => {
    const corrupt = createMemoryStorage({ [STORAGE_KEYS.lastVisit]: "2026-11-19T10:00:00.000Z" }); // a bare ISO string, as V1 wrote
    assert.equal(readLastVisit(corrupt, T0).get().previousMs, null);
    assert.equal(readKey(corrupt, LAST_VISIT_KEY).status, "ok", "replaced by a valid record");

    const newer = JSON.stringify({ v: 5, data: { sessions: [] } });
    const kept = createMemoryStorage({ [STORAGE_KEYS.lastVisit]: newer });
    const v = readLastVisit(kept, T0);
    v.noteEdition(T0, T0);
    assert.equal(v.get().previousMs, null);
    assert.equal(kept.getItem(STORAGE_KEYS.lastVisit), newer, "a newer client's record is left alone");

    assert.doesNotThrow(() => readLastVisit(brokenStorage(), T0).noteEdition(T0, T0));
  });
});
