// DST-correct timezone math on top of Intl.DateTimeFormat. Pure: no I/O,
// no clock reads — every function takes the zone (IANA string) and instant
// (ms since epoch) explicitly.
//
// Conventions: month is 1-12; weekday is ISO, 1=Mon .. 7=Sun.
//
// DST resolution rules (wallToEpoch, and everything built on it):
// - A wall time inside a spring-forward gap maps to the requested naive
//   time plus the gap length (02:30 on a US spring-forward day yields the
//   epoch of 03:30 local).
// - An ambiguous fall-back wall time maps to the EARLIER instant (first
//   pass, pre-shift offset).

const DAY_MS = 86400000;

const WEEKDAY_NUM = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

// One formatter per zone. Intl.DateTimeFormat construction is expensive;
// formatting is cheap. Deterministic: explicit locale, zone, hour cycle.
const formatterCache = new Map();

function getFormatter(zone) {
  let fmt = formatterCache.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(zone, fmt);
  }
  return fmt;
}

// Date.UTC treats years 0-99 as 1900-1999; going through setUTCFullYear
// avoids that, and out-of-range fields (day 0 or 32, hour 24) roll over
// arithmetically, which addDays and "24:00" rely on.
function utcFromFields(year, month, day, hour, minute, second) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/**
 * Wall-clock fields of `epochMs` in `zone`:
 * { year, month, day, hour, minute, second, weekday } (weekday 1=Mon..7=Sun).
 */
export function epochToWall(zone, epochMs) {
  const out = {};
  for (const { type, value } of getFormatter(zone).formatToParts(epochMs)) {
    if (type === "weekday") out.weekday = WEEKDAY_NUM[value];
    else if (type !== "literal") out[type] = Number(value);
  }
  if (out.hour === 24) out.hour = 0; // defensive: h23 should never emit 24
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
    weekday: out.weekday,
  };
}

/**
 * Offset of `zone` vs UTC in ms at the instant `epochMs` (east positive:
 * America/Chicago in summer, CDT, is -18000000; Australia/Adelaide in
 * southern winter, ACST, is +34200000).
 */
export function zoneOffsetMs(zone, epochMs) {
  const w = epochToWall(zone, epochMs);
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  return (
    utcFromFields(w.year, w.month, w.day, w.hour, w.minute, w.second) -
    wholeSecond
  );
}

/**
 * Epoch ms of the wall time { year, month, day, hour=0, minute=0,
 * second=0 } in `zone`, resolving DST per the rules at the top of this
 * file. Out-of-range fields roll over (day 32 = next month), which is how
 * calendar arithmetic like addDays flows through.
 */
export function wallToEpoch(zone, wall) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wall;
  const naive = utcFromFields(year, month, day, hour, minute, second);

  // Candidate offsets: sample a day either side of the naive instant so
  // both the pre- and post-transition offsets of any nearby DST shift are
  // present (real offsets are within +-14h; shifts are months apart).
  const offsets = [
    ...new Set([
      zoneOffsetMs(zone, naive - DAY_MS),
      zoneOffsetMs(zone, naive),
      zoneOffsetMs(zone, naive + DAY_MS),
    ]),
  ];

  // An offset is valid if the zone really uses it at the instant it
  // implies. Ambiguous (fall-back) wall times yield two valid instants;
  // the earlier one (= pre-shift, larger offset) is Math.min of them.
  const valid = [];
  for (const off of offsets) {
    const t = naive - off;
    if (zoneOffsetMs(zone, t) === off) valid.push(t);
  }
  if (valid.length > 0) return Math.min(...valid);

  // No valid offset: the wall time sits in a spring-forward gap. Using the
  // pre-transition (smaller) offset lands at naive + gapLength expressed
  // in the post-transition offset — exactly the "02:30 -> 03:30" rule.
  return naive - Math.min(...offsets);
}

/**
 * Same wall-clock time `n` calendar days later (or earlier, n < 0) in
 * `zone`. DST-correct: crossing a transition keeps the wall time, so the
 * UTC delta may be 23h or 25h; a wall time that lands in a gap or an
 * ambiguity resolves per the wallToEpoch rules. Sub-second ms preserved.
 */
export function addDays(zone, epochMs, n) {
  const w = epochToWall(zone, epochMs);
  const subSecond = epochMs - Math.floor(epochMs / 1000) * 1000;
  return (
    wallToEpoch(zone, {
      year: w.year,
      month: w.month,
      day: w.day + n,
      hour: w.hour,
      minute: w.minute,
      second: w.second,
    }) + subSecond
  );
}

/** Epoch ms of 00:00:00 in `zone` on the wall date containing `epochMs`. */
export function startOfDay(zone, epochMs) {
  const w = epochToWall(zone, epochMs);
  return wallToEpoch(zone, { year: w.year, month: w.month, day: w.day });
}

/**
 * Epoch ms of 00:00:00 of the most recent Monday (ISO week) in `zone`.
 * A Monday maps to its own midnight.
 */
export function weekStart(zone, epochMs) {
  const w = epochToWall(zone, epochMs);
  return wallToEpoch(zone, {
    year: w.year,
    month: w.month,
    day: w.day - (w.weekday - 1),
  });
}

const HM_RE = /^(\d{2}):(\d{2})$/;

/**
 * Parse "HH:MM" (two digits each) to { hour, minute }. "24:00" is allowed
 * and returns { hour: 24, minute: 0 } (end-of-day marker). Throws
 * TypeError on anything malformed or out of range.
 */
export function parseHM(s) {
  if (typeof s !== "string") {
    throw new TypeError(`parseHM: expected "HH:MM" string, got ${typeof s}`);
  }
  const m = HM_RE.exec(s);
  if (!m) throw new TypeError(`parseHM: malformed time ${JSON.stringify(s)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) {
    throw new TypeError(`parseHM: out-of-range time ${JSON.stringify(s)}`);
  }
  return { hour, minute };
}

const WALL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Parse "YYYY-MM-DD" to { year, month, day }, validating the calendar
 * date (leap years included). Throws TypeError on malformed input.
 */
export function parseWallDate(s) {
  if (typeof s !== "string") {
    throw new TypeError(
      `parseWallDate: expected "YYYY-MM-DD" string, got ${typeof s}`,
    );
  }
  const m = WALL_DATE_RE.exec(s);
  if (!m) {
    throw new TypeError(`parseWallDate: malformed date ${JSON.stringify(s)}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new TypeError(`parseWallDate: invalid date ${JSON.stringify(s)}`);
  }
  return { year, month, day };
}

/** Format { year, month, day } as "YYYY-MM-DD" (zero-padded). */
export function formatWallDate({ year, month, day }) {
  const y = String(year).padStart(4, "0");
  const mo = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}
