// Weekly programming planner: turns the content library plus station
// config into one week of per-channel programming (the in-memory form of
// programming.yaml, docs/contracts.md section 2). Pure and deterministic:
// no I/O, no clock reads — the caller supplies the library, the parsed
// station config, rotation cursors from last week, and the epoch ms of
// Monday 00:00 in the station timezone.
//
// Slot times are "HH:MM" wall-clock labels that the schedule compiler
// turns back into instants with wallToEpoch. Three consequences the
// planner honors so every plan it emits compiles without overlaps:
//
// - Starts sit on whole wall minutes (the label has no seconds field);
//   movie starts additionally sit on 5-minute boundaries.
// - A start must round-trip through its label: wallToEpoch resolves an
//   ambiguous fall-back time to the EARLIER instant, so the repeated
//   hour's second pass cannot be addressed by the programming format.
//   The planner leaves it unprogrammed (the compile-time gap packer
//   fills dead air). Spring-forward gap times are never emitted.
// - An airing that crosses midnight belongs to the day it STARTS on;
//   the next day begins placing only after it ends.

import { CONTRACT_VERSION } from "./contract.js";
import {
  addDays,
  epochToWall,
  formatWallDate,
  wallToEpoch,
  zoneOffsetMs,
} from "./time.js";

const MINUTE_MS = 60000;
const DAYS_PER_WEEK = 7;

/** Refusal of unplannable inputs. Mirrors the compiler's CompileError:
 * `.problems` lists every defect found, so operators see the full list
 * at once and callers can keep the last-good plan. */
export class PlanError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(
      `refusing to plan: ${problems.length} problem(s)\n- ` +
        problems.join("\n- "),
    );
    this.name = "PlanError";
    this.problems = problems;
  }
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function fmtHM(w) {
  const h = String(w.hour).padStart(2, "0");
  const m = String(w.minute).padStart(2, "0");
  return `${h}:${m}`;
}

function runtimeMs(entry) {
  if (!Number.isInteger(entry.runtime_s) || entry.runtime_s <= 0) {
    throw new PlanError([
      `entry ${JSON.stringify(entry.slug)} needs a positive integer ` +
        `runtime_s`,
    ]);
  }
  return entry.runtime_s * 1000;
}

function intCursor(value, name) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value)) {
    throw new TypeError(`planWeek: cursor ${name} must be an integer`);
  }
  return value;
}

// The instant an "HH:MM" label on a wall date compiles back to. A start
// is only usable if it IS its own compiled instant — otherwise the label
// would land earlier than planned and overlap the airing before it.
function labelInstant(zone, w) {
  return wallToEpoch(zone, {
    year: w.year,
    month: w.month,
    day: w.day,
    hour: w.hour,
    minute: w.minute,
  });
}

// Smallest instant t >= minMs that lies on a wall-clock minute boundary
// whose minute is divisible by stepMinutes AND that round-trips through
// its HH:MM label (see labelInstant). The march below only runs across a
// DST transition and is bounded by its span.
function nextCleanStart(zone, minMs, stepMinutes) {
  const stepMs = stepMinutes * MINUTE_MS;
  const off = zoneOffsetMs(zone, minMs);
  let t = Math.ceil((minMs + off) / stepMs) * stepMs - off;
  for (;;) {
    const w = epochToWall(zone, t);
    if (w.second !== 0) {
      t += (60 - w.second) * 1000; // zones with sub-minute offsets
      continue;
    }
    if (w.minute % stepMinutes === 0 && labelInstant(zone, w) === t) {
      return t;
    }
    t += MINUTE_MS;
  }
}

// library selectors ---------------------------------------------------

function featurePool(library) {
  return library
    .filter((e) => e.kind === "movie")
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function episodePools(library) {
  const bySeries = new Map();
  for (const e of library) {
    if (e.kind !== "episode") continue;
    if (typeof e.series !== "string" || e.series === "") {
      throw new PlanError([
        `episode ${JSON.stringify(e.slug)} has no series`,
      ]);
    }
    let eps = bySeries.get(e.series);
    if (!eps) bySeries.set(e.series, (eps = []));
    eps.push(e);
  }
  const names = [...bySeries.keys()].sort();
  for (const eps of bySeries.values()) {
    eps.sort(
      (a, b) =>
        (a.season ?? 0) - (b.season ?? 0) ||
        (a.episode ?? 0) - (b.episode ?? 0) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    );
  }
  return { names, bySeries };
}

// role planners -------------------------------------------------------
// Each returns { days } and advances its cursor in `state`; days is
// always 7 entries of { date, slots: [{ at, slug }] } with slots in
// airing order. `dayStarts` has 8 instants (Monday 00:00 .. next Monday
// 00:00); an airing may run past its day's end, in which case the next
// day starts placing only after it ends.

function planMovies({ zone, dayStarts, dayDates, features, breakMs, state }) {
  const n = features.length;
  if (n === 0) {
    throw new PlanError(["movies channel needs at least one movie"]);
  }
  let idx = mod(state.moviesIndex, n);
  let prevEnd = -Infinity;
  const days = [];
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    const dayEnd = dayStarts[d + 1];
    const slots = [];
    // Idle at midnight -> the day opens at 00:00 sharp (a feature that
    // missed 24:00 "moves to the next day at 00:00"); otherwise the
    // previous feature is still airing and we resume after it.
    let t =
      prevEnd <= dayStarts[d]
        ? dayStarts[d]
        : nextCleanStart(zone, prevEnd + breakMs, 5);
    while (t < dayEnd) {
      const f = features[idx];
      slots.push({ at: fmtHM(epochToWall(zone, t)), slug: f.slug });
      prevEnd = t + runtimeMs(f);
      idx = (idx + 1) % n;
      t = nextCleanStart(zone, prevEnd + breakMs, 5);
    }
    days.push({ date: formatWallDate(dayDates[d]), slots });
  }
  state.moviesIndex = idx;
  return { days };
}

function planSeriesGrid({
  zone,
  dayStarts,
  dayDates,
  names,
  bySeries,
  gridMinutes,
  state,
}) {
  if (names.length === 0) {
    throw new PlanError(["series-grid channel needs episodes"]);
  }
  let rotation = 0; // series round-robin position, restarts each week
  let busyUntil = -Infinity;
  const days = [];
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    const w0 = epochToWall(zone, dayStarts[d]);
    const slots = [];
    for (let m = 0; m < 1440; m += gridMinutes) {
      const hour = Math.floor(m / 60);
      const minute = m % 60;
      const lineMs = wallToEpoch(zone, {
        year: w0.year,
        month: w0.month,
        day: w0.day,
        hour,
        minute,
      });
      const wb = epochToWall(zone, lineMs);
      if (
        wb.year !== w0.year ||
        wb.month !== w0.month ||
        wb.day !== w0.day ||
        wb.hour !== hour ||
        wb.minute !== minute
      ) {
        continue; // grid line falls in a spring-forward gap
      }
      if (lineMs < busyUntil) continue; // occupied by a longer episode
      const name = names[rotation % names.length];
      rotation += 1;
      const eps = bySeries.get(name);
      const at = mod(state.seriesCursors[name] ?? 0, eps.length);
      const ep = eps[at];
      state.seriesCursors[name] = (at + 1) % eps.length;
      slots.push({ at: fmtHM(wb), slug: ep.slug });
      busyUntil = lineMs + runtimeMs(ep);
    }
    days.push({ date: formatWallDate(dayDates[d]), slots });
  }
  return { days };
}

function planMarathon({ zone, dayStarts, dayDates, names, bySeries, state }) {
  const n = names.length;
  if (n === 0) {
    throw new PlanError(["marathon channel needs episodes"]);
  }
  const base = mod(state.marathonIndex, n);
  let prevEnd = -Infinity;
  const days = [];
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    const eps = bySeries.get(names[(base + d) % n]);
    const dayEnd = dayStarts[d + 1];
    const slots = [];
    let e = 0; // each day's marathon replays its series from the top
    let t =
      prevEnd <= dayStarts[d] ? dayStarts[d] : nextCleanStart(zone, prevEnd, 1);
    while (t < dayEnd) {
      const ep = eps[e % eps.length];
      slots.push({ at: fmtHM(epochToWall(zone, t)), slug: ep.slug });
      prevEnd = t + runtimeMs(ep);
      e += 1;
      t = nextCleanStart(zone, prevEnd, 1);
    }
    days.push({ date: formatWallDate(dayDates[d]), slots });
  }
  state.marathonIndex = mod(base + DAYS_PER_WEEK, n);
  return { days };
}

// entry point ---------------------------------------------------------

/**
 * Plan one 24h-a-day week of programming for every non-vote channel.
 *
 * @param {object} args
 * @param {Array<object>} args.library  library.json entries.
 * @param {object} args.config  Parsed station.yaml: station.timezone,
 *   channels [{ num, name, role }], planner { movie_break_minutes,
 *   grid_minutes }.
 * @param {object} [args.cursors]  Last week's rotation state:
 *   { movies_index, marathon_index, series: { name: index } }.
 * @param {number} args.weekStartMs  Epoch ms of Monday 00:00 in the
 *   station timezone (see weekStart in time.js).
 * @returns {{ programming: object, cursors: object }}  programming.yaml
 *   content (vote channels omitted) plus cursors advanced so the NEXT
 *   week continues where this one ended.
 */
export function planWeek({ library, config, cursors = {}, weekStartMs }) {
  const zone = config.station.timezone;
  const w0 = epochToWall(zone, weekStartMs);
  if (
    w0.weekday !== 1 ||
    w0.hour !== 0 ||
    w0.minute !== 0 ||
    w0.second !== 0
  ) {
    throw new PlanError([
      "weekStartMs must be Monday 00:00 in the station timezone",
    ]);
  }

  const dayStarts = [];
  for (let i = 0; i <= DAYS_PER_WEEK; i++) {
    dayStarts.push(addDays(zone, weekStartMs, i));
  }
  const dayDates = dayStarts
    .slice(0, DAYS_PER_WEEK)
    .map((ms) => epochToWall(zone, ms));

  const features = featurePool(library);
  const { names, bySeries } = episodePools(library);

  // Shared rotation state: channels of the same role continue the same
  // rotation, in config.channels order.
  const state = {
    moviesIndex: intCursor(cursors.movies_index, "movies_index"),
    marathonIndex: intCursor(cursors.marathon_index, "marathon_index"),
    seriesCursors: {},
  };
  for (const [name, value] of Object.entries(cursors.series ?? {})) {
    state.seriesCursors[name] = intCursor(value, `series.${name}`);
  }
  for (const name of names) {
    state.seriesCursors[name] = mod(
      state.seriesCursors[name] ?? 0,
      bySeries.get(name).length,
    );
  }

  const channels = [];
  const problems = [];
  for (const ch of config.channels) {
    if (ch.role === "vote") continue; // merged at compile time, never here
    let planned;
    try {
      planned = planChannel(ch);
    } catch (err) {
      if (err instanceof PlanError) {
        // Collect and keep going so one bad channel does not hide the
        // problems of the next; everything is discarded on refusal.
        for (const p of err.problems) {
          problems.push(`channel ${ch.num}: ${p}`);
        }
        continue;
      }
      throw err;
    }
    channels.push({ num: ch.num, role: ch.role, days: planned.days });
  }
  if (problems.length > 0) throw new PlanError(problems);

  function planChannel(ch) {
    if (ch.role === "movies") {
      const breakMinutes = config.planner.movie_break_minutes;
      if (!Number.isInteger(breakMinutes) || breakMinutes < 0) {
        throw new PlanError([
          "planner.movie_break_minutes must be a non-negative integer",
        ]);
      }
      return planMovies({
        zone,
        dayStarts,
        dayDates,
        features,
        breakMs: breakMinutes * MINUTE_MS,
        state,
      });
    } else if (ch.role === "series-grid") {
      const gridMinutes = config.planner.grid_minutes;
      if (!Number.isInteger(gridMinutes) || gridMinutes <= 0) {
        throw new PlanError([
          "planner.grid_minutes must be a positive integer",
        ]);
      }
      return planSeriesGrid({
        zone,
        dayStarts,
        dayDates,
        names,
        bySeries,
        gridMinutes,
        state,
      });
    } else if (ch.role === "marathon") {
      return planMarathon({ zone, dayStarts, dayDates, names, bySeries, state });
    }
    throw new PlanError([
      `unknown role ${JSON.stringify(ch.role)}`,
    ]);
  }

  return {
    programming: {
      version: CONTRACT_VERSION,
      week_start: formatWallDate(dayDates[0]),
      channels,
    },
    cursors: {
      movies_index: state.moviesIndex,
      marathon_index: state.marathonIndex,
      series: state.seriesCursors,
    },
  };
}
