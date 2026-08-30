import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zoneOffsetMs,
  epochToWall,
  wallToEpoch,
  addDays,
  startOfDay,
  weekStart,
  parseHM,
  parseWallDate,
  formatWallDate,
} from "../lib/time.js";

const H = 3600000;
const MIN = 60000;

// Zone facts used to hand-derive every expected epoch below (derivations in
// comments next to each constant; Date.UTC is pure proleptic-Gregorian UTC
// arithmetic, independent of the implementation's Intl path):
//
// America/Chicago: CST = UTC-6, CDT = UTC-5.
//   US DST 2026 starts Sun 2026-03-08 (02:00 CST -> 03:00 CDT; second
//   Sunday of March — 2026-03-01 is a Sunday) and ends Sun 2026-11-01
//   (02:00 CDT -> 01:00 CST; first Sunday of November).
// Australia/Adelaide: ACST = UTC+9:30, ACDT = UTC+10:30 (southern summer,
//   first Sunday of October -> first Sunday of April).
//
// Weekday cross-check: 2026-01-01 is a Thursday, so day-of-year N falls on
// weekday Thu + ((N - 1) mod 7).

const CHI = "America/Chicago";
const ADL = "Australia/Adelaide";
const UTC = "UTC";

test("zoneOffsetMs: fixed anchors in three zones", () => {
  // 2026-07-04 17:00 UTC = 12:00 CDT (UTC-5).
  assert.equal(zoneOffsetMs(CHI, Date.UTC(2026, 6, 4, 17, 0, 0)), -5 * H);
  assert.equal(zoneOffsetMs(CHI, Date.UTC(2026, 6, 4, 17, 0, 0)), -18000000);
  // 2026-01-15 12:00 UTC = 06:00 CST (UTC-6).
  assert.equal(zoneOffsetMs(CHI, Date.UTC(2026, 0, 15, 12, 0, 0)), -6 * H);
  // UTC is always 0.
  assert.equal(zoneOffsetMs(UTC, Date.UTC(2026, 6, 4)), 0);
  assert.equal(zoneOffsetMs(UTC, Date.UTC(2026, 0, 1)), 0);
  // Adelaide southern winter: ACST, UTC+9:30 = 34200000 ms.
  assert.equal(zoneOffsetMs(ADL, Date.UTC(2026, 7, 27, 23, 30, 0)), 34200000);
  // Adelaide southern summer: ACDT, UTC+10:30.
  assert.equal(zoneOffsetMs(ADL, Date.UTC(2026, 0, 15, 1, 30, 0)), 37800000);
});

test("epochToWall: hand-verified anchors", () => {
  // 12:00 CDT = 17:00 UTC. 2026-07-04 is day-of-year 185; Thu+((185-1)%7)
  // = Thu+2 = Saturday, ISO weekday 6.
  assert.deepEqual(epochToWall(CHI, Date.UTC(2026, 6, 4, 17, 0, 0)), {
    year: 2026,
    month: 7,
    day: 4,
    hour: 12,
    minute: 0,
    second: 0,
    weekday: 6,
  });
  // 2026-08-28 09:00 ACST = 2026-08-27 23:30 UTC. Day-of-year 240 ->
  // Thu+1 = Friday, ISO weekday 5.
  assert.deepEqual(epochToWall(ADL, Date.UTC(2026, 7, 27, 23, 30, 0)), {
    year: 2026,
    month: 8,
    day: 28,
    hour: 9,
    minute: 0,
    second: 0,
    weekday: 5,
  });
  // 2026-01-01 00:00 UTC, a Thursday (ISO weekday 4).
  assert.deepEqual(epochToWall(UTC, Date.UTC(2026, 0, 1, 0, 0, 0)), {
    year: 2026,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    weekday: 4,
  });
});

test("wallToEpoch: hand-verified anchors and defaults", () => {
  // 12:00 CDT -> 17:00 UTC.
  assert.equal(
    wallToEpoch(CHI, { year: 2026, month: 7, day: 4, hour: 12 }),
    Date.UTC(2026, 6, 4, 17, 0, 0),
  );
  // 09:00 ACST -> previous day 23:30 UTC.
  assert.equal(
    wallToEpoch(ADL, { year: 2026, month: 8, day: 28, hour: 9 }),
    Date.UTC(2026, 7, 27, 23, 30, 0),
  );
  // hour/minute/second default to 0.
  assert.equal(
    wallToEpoch(UTC, { year: 2026, month: 1, day: 1 }),
    Date.UTC(2026, 0, 1, 0, 0, 0),
  );
});

test("round-trips: wall -> epoch -> wall in three zones", () => {
  const walls = [
    { year: 2026, month: 1, day: 15, hour: 0, minute: 0, second: 0 },
    { year: 2026, month: 3, day: 8, hour: 12, minute: 34, second: 56 },
    { year: 2026, month: 6, day: 30, hour: 23, minute: 59, second: 59 },
    { year: 2026, month: 10, day: 5, hour: 6, minute: 30, second: 0 },
    { year: 2026, month: 12, day: 31, hour: 18, minute: 1, second: 2 },
  ];
  for (const zone of [CHI, ADL, UTC]) {
    for (const wall of walls) {
      const epoch = wallToEpoch(zone, wall);
      const back = epochToWall(zone, epoch);
      delete back.weekday;
      assert.deepEqual(back, wall, `${zone} ${JSON.stringify(wall)}`);
    }
  }
});

test("round-trips: epoch -> wall -> epoch in three zones", () => {
  // Whole-second instants away from any transition boundary.
  const epochs = [
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2026, 3, 12, 7, 45, 30),
    Date.UTC(2026, 7, 27, 23, 30, 0),
    Date.UTC(2026, 11, 31, 12, 0, 1),
  ];
  for (const zone of [CHI, ADL, UTC]) {
    for (const epoch of epochs) {
      const w = epochToWall(zone, epoch);
      assert.equal(wallToEpoch(zone, w), epoch, `${zone} @ ${epoch}`);
    }
  }
});

test("spring-forward gap: Chicago 2026-03-08 02:30 -> 03:30 CDT", () => {
  // 02:00 CST jumps to 03:00 CDT; 02:30 does not exist and maps to 03:30
  // CDT (naive + 1h gap). 03:30 CDT = 08:30 UTC.
  const got = wallToEpoch(CHI, {
    year: 2026,
    month: 3,
    day: 8,
    hour: 2,
    minute: 30,
  });
  assert.equal(got, Date.UTC(2026, 2, 8, 8, 30, 0));
  const wall = epochToWall(CHI, got);
  assert.equal(wall.hour, 3);
  assert.equal(wall.minute, 30);
  assert.equal(zoneOffsetMs(CHI, got), -5 * H); // already CDT
});

test("fall-back ambiguity: Chicago 2026-11-01 01:30 -> earlier (CDT)", () => {
  // 02:00 CDT falls back to 01:00 CST, so 01:30 happens twice. The rule
  // picks the first pass: 01:30 CDT = 06:30 UTC (the CST repeat would be
  // 07:30 UTC).
  const got = wallToEpoch(CHI, {
    year: 2026,
    month: 11,
    day: 1,
    hour: 1,
    minute: 30,
  });
  assert.equal(got, Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.equal(zoneOffsetMs(CHI, got), -5 * H); // CDT, pre-shift
  // One real hour later the wall clock reads 01:30 again, now in CST.
  const secondPass = epochToWall(CHI, got + H);
  assert.equal(secondPass.hour, 1);
  assert.equal(secondPass.minute, 30);
  assert.equal(zoneOffsetMs(CHI, got + H), -6 * H);
});

test("addDays across spring-forward: same wall time, 23h UTC delta", () => {
  // Sat 2026-03-07 09:00 CST = 15:00 UTC; Sun 2026-03-08 09:00 CDT =
  // 14:00 UTC.
  const base = Date.UTC(2026, 2, 7, 15, 0, 0);
  const next = addDays(CHI, base, 1);
  assert.equal(next, Date.UTC(2026, 2, 8, 14, 0, 0));
  assert.equal(next - base, 23 * H);
  assert.equal(epochToWall(CHI, next).hour, 9);
  // And back.
  assert.equal(addDays(CHI, next, -1), base);
});

test("addDays across fall-back: same wall time, 25h UTC delta", () => {
  // Sat 2026-10-31 09:00 CDT = 14:00 UTC; Sun 2026-11-01 09:00 CST =
  // 15:00 UTC.
  const base = Date.UTC(2026, 9, 31, 14, 0, 0);
  const next = addDays(CHI, base, 1);
  assert.equal(next, Date.UTC(2026, 10, 1, 15, 0, 0));
  assert.equal(next - base, 25 * H);
  assert.equal(epochToWall(CHI, next).hour, 9);
  assert.equal(addDays(CHI, next, -1), base);
});

test("addDays landing in the gap resolves per wallToEpoch", () => {
  // Sat 2026-03-07 02:30 CST = 08:30 UTC; +1 day the wall time 02:30 does
  // not exist and maps to 03:30 CDT = 08:30 UTC on 2026-03-08.
  const base = Date.UTC(2026, 2, 7, 8, 30, 0);
  assert.equal(addDays(CHI, base, 1), Date.UTC(2026, 2, 8, 8, 30, 0));
});

test("addDays landing on the ambiguity picks the earlier instant", () => {
  // Sat 2026-10-31 01:30 CDT = 06:30 UTC; +1 day, 01:30 is ambiguous and
  // maps to the CDT pass: 2026-11-01 06:30 UTC (exactly 24h here).
  const base = Date.UTC(2026, 9, 31, 6, 30, 0);
  assert.equal(addDays(CHI, base, 1), Date.UTC(2026, 10, 1, 6, 30, 0));
});

test("addDays in UTC is always exact 24h steps", () => {
  const base = Date.UTC(2026, 2, 7, 15, 0, 0);
  assert.equal(addDays(UTC, base, 1) - base, 24 * H);
  assert.equal(addDays(UTC, base, -3) - base, -72 * H);
});

test("startOfDay: midnight of the wall date, DST day included", () => {
  // 2026-03-08 14:00 CDT = 19:00 UTC; midnight that day was still CST, so
  // 00:00 = 06:00 UTC (and the day is only 23h long).
  assert.equal(
    startOfDay(CHI, Date.UTC(2026, 2, 8, 19, 0, 0)),
    Date.UTC(2026, 2, 8, 6, 0, 0),
  );
  // Adelaide 2026-08-28 09:00 ACST -> 00:00 ACST = 2026-08-27 14:30 UTC.
  assert.equal(
    startOfDay(ADL, Date.UTC(2026, 7, 27, 23, 30, 0)),
    Date.UTC(2026, 7, 27, 14, 30, 0),
  );
});

test("weekStart: Monday maps to its own midnight", () => {
  // 2026-08-24 is day-of-year 236 -> Thu+((236-1)%7) = Thu+4 = Monday.
  // 10:00 CDT = 15:00 UTC; Monday 00:00 CDT = 05:00 UTC.
  assert.equal(
    weekStart(CHI, Date.UTC(2026, 7, 24, 15, 0, 0)),
    Date.UTC(2026, 7, 24, 5, 0, 0),
  );
});

test("weekStart: Sunday maps back six days to Monday", () => {
  // 2026-08-30 is day-of-year 242 -> Thu+3 = Sunday. 23:59 CDT = next day
  // 04:59 UTC. Most recent Monday is 2026-08-24 00:00 CDT = 05:00 UTC.
  assert.equal(
    weekStart(CHI, Date.UTC(2026, 7, 31, 4, 59, 0)),
    Date.UTC(2026, 7, 24, 5, 0, 0),
  );
});

test("weekStart crossing a DST transition keeps Monday midnight", () => {
  // Sun 2026-11-01 12:00 CST = 18:00 UTC (after fall-back). The most
  // recent Monday is 2026-10-26 (day-of-year 299 -> Thu+4 = Monday),
  // still CDT: 00:00 CDT = 05:00 UTC.
  assert.equal(
    weekStart(CHI, Date.UTC(2026, 10, 1, 18, 0, 0)),
    Date.UTC(2026, 9, 26, 5, 0, 0),
  );
});

test("parseHM: accepts HH:MM including 24:00", () => {
  assert.deepEqual(parseHM("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseHM("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseHM("23:59"), { hour: 23, minute: 59 });
  assert.deepEqual(parseHM("24:00"), { hour: 24, minute: 0 });
});

test("parseHM: throws TypeError on malformed input", () => {
  const bad = [
    "24:01",
    "25:00",
    "12:60",
    "1:30", // one-digit hour
    "12:3", // one-digit minute
    "1230",
    "12:30:00",
    "12-30",
    "",
    "aa:bb",
    " 12:30",
  ];
  for (const s of bad) {
    assert.throws(() => parseHM(s), TypeError, JSON.stringify(s));
  }
  assert.throws(() => parseHM(1230), TypeError);
  assert.throws(() => parseHM(null), TypeError);
});

test("parseWallDate: valid dates, leap years included", () => {
  assert.deepEqual(parseWallDate("2026-08-28"), {
    year: 2026,
    month: 8,
    day: 28,
  });
  assert.deepEqual(parseWallDate("2024-02-29"), {
    year: 2024,
    month: 2,
    day: 29,
  });
  assert.deepEqual(parseWallDate("2026-12-31"), {
    year: 2026,
    month: 12,
    day: 31,
  });
});

test("parseWallDate: throws TypeError on malformed input", () => {
  const bad = [
    "2026-02-29", // not a leap year
    "2026-13-01",
    "2026-00-10",
    "2026-02-30",
    "2026-04-31",
    "2026-2-05", // one-digit month
    "20260828",
    "2026/08/28",
    "",
    "abc",
  ];
  for (const s of bad) {
    assert.throws(() => parseWallDate(s), TypeError, JSON.stringify(s));
  }
  assert.throws(() => parseWallDate(20260828), TypeError);
  assert.throws(() => parseWallDate(null), TypeError);
});

test("formatWallDate: zero-padded, round-trips with parseWallDate", () => {
  assert.equal(formatWallDate({ year: 2026, month: 8, day: 28 }), "2026-08-28");
  assert.equal(formatWallDate({ year: 987, month: 1, day: 2 }), "0987-01-02");
  for (const s of ["2026-01-01", "2024-02-29", "2026-11-01"]) {
    assert.equal(formatWallDate(parseWallDate(s)), s);
  }
});

test("wallToEpoch and epochToWall agree with minute-level offsets", () => {
  // Adelaide 2026-01-15 12:00 ACDT (UTC+10:30) = 01:30 UTC same day.
  const epoch = wallToEpoch(ADL, { year: 2026, month: 1, day: 15, hour: 12 });
  assert.equal(epoch, Date.UTC(2026, 0, 15, 1, 30, 0));
  const w = epochToWall(ADL, epoch);
  assert.equal(w.hour, 12);
  assert.equal(w.minute, 0);
  // Half-hour offsets survive arithmetic: 90 real minutes later it is
  // 13:30 local.
  assert.equal(epochToWall(ADL, epoch + 90 * MIN).hour, 13);
  assert.equal(epochToWall(ADL, epoch + 90 * MIN).minute, 30);
});
