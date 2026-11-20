import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DATE_ONLY_SLACK_HOURS, parseDate, resolvePublishedAt } from "./dates";

const NOW = new Date("2026-11-19T21:00:00.000Z");
const iso = (raw: string | null | undefined, now: Date = NOW): string | null => {
  const p = parseDate(raw, now);
  return p ? new Date(p.ms).toISOString() : null;
};
/** What the item gets as publishedAt when first seen at the build clock. */
const published = (raw: string | null, now: Date = NOW): string | null => resolvePublishedAt(parseDate(raw, now), now.getTime(), now.getTime());

describe("parseDate - the review's 14 crafted date strings (fetch finding 5, crafted case 7)", () => {
  // [label, raw, V1 result, V2 parse, V2 publishedAt at the fixture clock]
  const cases: [string, string | null, string, string | null, string | null][] = [
    ["A named zone CET", "Thu, 19 Nov 2026 15:30:00 CET", "00:00Z (zone ignored)", "2026-11-19T14:30:00.000Z", "2026-11-19T14:30:00.000Z"],
    ["B named zone EST", "Thu, 19 Nov 2026 09:30:00 EST", "ok", "2026-11-19T14:30:00.000Z", "2026-11-19T14:30:00.000Z"],
    ["C ISO without zone = UTC", "2026-11-19T15:30:00", "21:30Z on a Chicago machine", "2026-11-19T15:30:00.000Z", "2026-11-19T15:30:00.000Z"],
    ["D date only = that day 12:00 UTC", "2026-11-19", "00:00Z", "2026-11-19T12:00:00.000Z", "2026-11-19T12:00:00.000Z"],
    ["E far-future event", "Thu, 03 Dec 2026 16:00:00 GMT", "kept, sorted first", "2026-12-03T16:00:00.000Z", null],
    ["F US slash date", "11/19/2026", "06:00Z (local midnight)", "2026-11-19T12:00:00.000Z", "2026-11-19T12:00:00.000Z"],
    ["G EU slash date", "19/11/2026", "2027-07-11 (month overflow)", "2026-11-19T12:00:00.000Z", "2026-11-19T12:00:00.000Z"],
    ["H ambiguous slash date reads month-first", "03/12/2026", "2026-03-12T05:00Z", "2026-03-12T12:00:00.000Z", "2026-03-12T12:00:00.000Z"],
    ["I unix epoch seconds", "1795100000", "null", "2026-11-19T14:53:20.000Z", "2026-11-19T14:53:20.000Z"],
    ["J garbage text", "Posted on the 3rd day in May by staff", "null", null, null],
    ["K two-digit year", "Thu, 19 Nov 26 15:30:00 GMT", "ok", "2026-11-19T15:30:00.000Z", "2026-11-19T15:30:00.000Z"],
    ["L missing", null, "null", null, null],
    ["M 1970 CMS default", "Thu, 01 Jan 1970 00:00:00 GMT", "1970-01-01", null, null],
    ["N foreign weekday", "Do, 19 Nov 2026 15:30:00 +0100", "ok", "2026-11-19T14:30:00.000Z", "2026-11-19T14:30:00.000Z"],
  ];
  for (const [label, raw, v1, parsed, pub] of cases) {
    it(`${label} (V1: ${v1})`, () => {
      assert.equal(iso(raw), parsed);
      assert.equal(published(raw), pub);
    });
  }
});

describe("parseDate - formats", () => {
  const cases: [string, string | null][] = [
    // RFC 822 / 2822
    ["Thu, 19 Nov 2026 08:00:00 GMT", "2026-11-19T08:00:00.000Z"],
    ["Wed, 18 Nov 2026 21:35:43 +0000", "2026-11-18T21:35:43.000Z"],
    ["Tue, 13 Oct 2026 15:00:40 -0700", "2026-10-13T22:00:40.000Z"],
    ["Sat, 13 Jun 2026 18:53:03 +0530", "2026-06-13T13:23:03.000Z"],
    ["19 Nov 2026 15:30 UT", "2026-11-19T15:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00 BST", "2026-11-19T14:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00 PST", "2026-11-19T23:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00 JST", "2026-11-19T06:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00 CEST", "2026-11-19T13:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00 XYZ", "2026-11-19T15:30:00.000Z"],
    ["Thu, 19 Nov 2026 15:30:00", "2026-11-19T15:30:00.000Z"],
    ["Thu, 19 Nov 2026 23:59:60 GMT", "2026-11-19T23:59:59.000Z"],
    // ISO 8601
    ["2026-11-19T17:51:04Z", "2026-11-19T17:51:04.000Z"],
    ["2026-11-19T20:43:57+00:00", "2026-11-19T20:43:57.000Z"],
    ["2026-11-13T09:15:00-08:00", "2026-11-13T17:15:00.000Z"],
    ["2026-11-19T15:30:00+0000", "2026-11-19T15:30:00.000Z"],
    ["2026-11-19T15:30:00.123456Z", "2026-11-19T15:30:00.000Z"],
    ["2026-11-19 15:30:00", "2026-11-19T15:30:00.000Z"],
    ["2026-11-19T15:30", "2026-11-19T15:30:00.000Z"],
    ["2026-11-19T15:30:00+01", "2026-11-19T14:30:00.000Z"],
    ["20261119T153000Z", "2026-11-19T15:30:00.000Z"],
    // Date only -> 12:00 UTC of the day as written
    ["2026-11-18", "2026-11-18T12:00:00.000Z"],
    ["20261119", "2026-11-19T12:00:00.000Z"],
    ["2026/11/19", "2026-11-19T12:00:00.000Z"],
    ["12 Jun 2025", "2025-06-12T12:00:00.000Z"],
    ["12 June 2025", "2025-06-12T12:00:00.000Z"],
    ["Nov 19, 2026", "2026-11-19T12:00:00.000Z"],
    ["November 19, 2026", "2026-11-19T12:00:00.000Z"],
    ["Sept. 3, 2026", "2026-09-03T12:00:00.000Z"],
    ["August 17th, 2026", "2026-08-17T12:00:00.000Z"],
    ["Oct 26, 2026 · 5 min read", "2026-10-26T12:00:00.000Z"],
    // Midnight stamps are date-only stamps in disguise (403 of the 2,297 corpus items)
    ["2026-11-19T00:00:00.000Z", "2026-11-19T12:00:00.000Z"],
    ["2026-11-13T00:00:00-08:00", "2026-11-13T12:00:00.000Z"],
    ["Nov 19, 2026 00:00:00-0600", "2026-11-19T12:00:00.000Z"],
    ["Thu, 19 Nov 2026 00:00:00 GMT", "2026-11-19T12:00:00.000Z"],
    // Month-first with a time
    ["Nov 18, 2026 09:30:00-0600", "2026-11-18T15:30:00.000Z"],
    ["Nov 18, 2026 at 3:15 PM EST", "2026-11-18T20:15:00.000Z"],
    ["Nov 18, 2026 12:05 AM UTC", "2026-11-18T00:05:00.000Z"],
    // A dash or "@" between the date and the time (fca-news: all 15 items were undated and aged out as 22 days old)
    ["Thursday, November 19, 2026 - 17:19", "2026-11-19T17:19:00.000Z"],
    ["Friday, November 6, 2026 - 10:02", "2026-11-06T10:02:00.000Z"],
    ["Thursday, 19 November 2026 - 17:19", "2026-11-19T17:19:00.000Z"],
    ["19 November 2026 – 5:19 PM", "2026-11-19T17:19:00.000Z"],
    ["Nov 19, 2026 @ 09:05 EST", "2026-11-19T14:05:00.000Z"],
    // ... but a dash followed by anything other than a time is still not a date
    ["Nov 19, 2026 - 5 min read", null],
    ["Nov 19 - 2026", null],
    // No year: the clock's year, or last year when that would be in the future
    ["Nov 19", "2026-11-19T12:00:00.000Z"],
    ["Nov 18", "2026-11-18T12:00:00.000Z"],
    ["18/11/2026", "2026-11-18T12:00:00.000Z"],
    ["31/12/2025", "2025-12-31T12:00:00.000Z"],
    ["November 19", "2026-11-19T12:00:00.000Z"],
    ["19 Nov", "2026-11-19T12:00:00.000Z"],
    ["June 3", "2026-06-03T12:00:00.000Z"],
    ["Dec 25", "2025-12-25T12:00:00.000Z"],
    // Epoch
    ["1795100000000", "2026-11-19T14:53:20.000Z"],
    // Relative
    ["2 hours ago", "2026-11-19T19:00:00.000Z"],
    ["about 2 hours ago", "2026-11-19T19:00:00.000Z"],
    ["1 hr ago", "2026-11-19T20:00:00.000Z"],
    ["2 hrs ago", "2026-11-19T19:00:00.000Z"],
    ["5 mins ago", "2026-11-19T20:55:00.000Z"],
    ["30 seconds ago", "2026-11-19T20:59:30.000Z"],
    ["a day ago", "2026-11-18T21:00:00.000Z"],
    ["an hour ago", "2026-11-19T20:00:00.000Z"],
    ["Updated 3 days ago", "2026-11-16T21:00:00.000Z"],
    ["Published 2 weeks ago", "2026-11-05T21:00:00.000Z"],
    ["1 month ago", "2026-10-20T21:00:00.000Z"],
    ["Yesterday", "2026-11-18T21:00:00.000Z"],
    ["Today at 3pm", "2026-11-19T21:00:00.000Z"],
    ["just now", "2026-11-19T21:00:00.000Z"],
    ["Last week", "2026-11-12T21:00:00.000Z"],
  ];
  for (const [raw, expected] of cases) it(JSON.stringify(raw), () => assert.equal(iso(raw), expected));
});

describe("parseDate - rejects instead of guessing (V1 results in comments)", () => {
  const cases: [string, string][] = [
    ["GPT 5", "V1: 2001-05-01"],
    ["45 Jun 2026", "V1: 2026-07-15"],
    ["2026-02-31", "V1: 2026-03-03"],
    ["2026-02-30", "V1: rolled into March"],
    ["Sat, 30 Feb 2026 10:00:00 GMT", "V1: rolled into March"],
    ["31/12/2026x", "trailing junk"],
    ["2026/13/45", "month 13"],
    ["13/40/2026", "day 40"],
    ["31/04/2026", "30-day month"],
    ["Thu, 19 Nov 2026 24:30:00 GMT", "hour 24"],
    ["Thu, 19 Nov 2026 12:61:00 GMT", "minute 61"],
    ["0000-00-00T00:00:00Z", "zero date"],
    ["Mon, 01 Jan 0001 00:00:00 GMT", "year 1"],
    ["1969-07-20T20:17:00Z", "before the web"],
    ["9999-12-31T23:59:59Z", "absurd year"],
    ["2", "bare number"],
    ["12", "bare number"],
    ["123456789", "9 digits are not an epoch"],
    ["99999999999999999999", "overflow"],
    ["99999 years ago", "V1 threw RangeError: Invalid time value"],
    ["99999 months ago", "absurd"],
    ["soon", "not a date"],
    ["", "empty"],
    ["   ", "blank"],
    ["x".repeat(500), "too long"],
  ];
  for (const [raw, why] of cases) it(`${JSON.stringify(raw.slice(0, 40))} (${why})`, () => assert.equal(iso(raw), null));

  it("never throws on hostile input", () => {
    const hostile: unknown[] = [null, undefined, 0, 42, {}, [], NaN, "\u0000", "￿".repeat(50), "1e999", "-1", "Infinity ago", "NaN-NaN-NaN", "2026-11-19T99:99:99Z", "9".repeat(119)];
    for (const h of hostile) assert.doesNotThrow(() => parseDate(h as string, NOW), String(h));
    assert.doesNotThrow(() => parseDate("2 hours ago", new Date(NaN)));
    assert.equal(parseDate("2 hours ago", new Date(NaN)), null);
  });
});

describe("parseDate is timezone-independent", () => {
  it("gives the same result under any TZ (V1: '12 Jun 2025' was 05:00Z in Chicago, the previous day in Kolkata)", () => {
    const samples = ["12 Jun 2025", "2026-11-19T15:30:00", "2026-11-19", "Nov 19, 2026", "11/19/2026", "Thu, 19 Nov 2026 15:30:00", "Nov 19", "20261119"];
    const expected = samples.map((s) => iso(s));
    const original = process.env.TZ;
    try {
      for (const tz of ["America/Chicago", "Asia/Kolkata", "Pacific/Kiritimati", "UTC"]) {
        process.env.TZ = tz;
        assert.deepEqual(samples.map((s) => iso(s)), expected, tz);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("resolvePublishedAt", () => {
  const nowMs = NOW.getTime();
  const H = 3_600_000;

  it("a timestamp more than 1 h in the future is rejected; within the tolerance it is kept", () => {
    assert.equal(published("2026-11-19T21:59:00Z"), "2026-11-19T21:59:00.000Z");
    assert.equal(published("2026-11-19T22:00:00Z"), "2026-11-19T22:00:00.000Z");
    assert.equal(published("2026-11-19T22:00:01Z"), null);
    assert.equal(published("2026-11-19T21:01:30Z"), "2026-11-19T21:01:30.000Z", "a 90-second clock skew does not cost the item its date");
    assert.equal(published("2027-01-01T08:00:00Z"), null);
    assert.equal(published("Thu, 03 Dec 2026 16:00:00 GMT"), null);
  });

  it("null in, null out", () => {
    assert.equal(resolvePublishedAt(null, nowMs, nowMs), null);
  });

  it("a date-only stamp is noon UTC of its day when that is already past", () => {
    assert.equal(published("2026-11-19"), "2026-11-19T12:00:00.000Z");
    assert.equal(published("2026-11-18T00:00:00Z"), "2026-11-18T12:00:00.000Z");
  });

  it("a date-only stamp is never later than the first sighting (post stamped today, picked up at 07:30)", () => {
    const seen = Date.parse("2026-11-19T07:30:00Z");
    const parsed = parseDate("2026-11-19", NOW);
    // First build at 07:30 and every later build agree: no flip from null to noon at 13:00.
    assert.equal(resolvePublishedAt(parsed, seen, seen), "2026-11-19T07:30:00.000Z");
    assert.equal(resolvePublishedAt(parsed, seen + 8 * H, seen), "2026-11-19T07:30:00.000Z");
  });

  it("a date-only stamp for tomorrow from a publisher ahead of UTC uses the first sighting", () => {
    const seen = Date.parse("2026-11-19T11:30:00Z");
    assert.equal(resolvePublishedAt(parseDate("2026-11-20", NOW), seen, seen), "2026-11-19T11:30:00.000Z");
  });

  it("a date-only stamp further ahead than a day is an event listing: no date", () => {
    assert.equal(published("2026-12-03"), null);
    const seen = nowMs;
    const edge = parseDate("2026-11-20", NOW);
    assert.ok(edge && edge.ms - seen <= DATE_ONLY_SLACK_HOURS * H);
    assert.equal(published("2026-11-21"), null);
  });
});
