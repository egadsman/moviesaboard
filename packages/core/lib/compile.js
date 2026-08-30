// Schedule compiler — the pure heart of the station. Takes the parsed
// programming object, the library manifest, the station config, and the
// vote-winner placements, and produces the schedule.json object of
// docs/contracts.md section 3. Deterministic: `nowMs` is a parameter, the
// packer PRNG is seeded from gap starts, and there are no clock,
// environment, or I/O reads anywhere.
//
// The compiler REFUSES invalid schedules: every problem found is collected
// and thrown together as a CompileError (`.problems` is a string array), so
// callers can keep serving the last-good schedule and show the operator
// the full list at once. It never returns a partially valid schedule.

import { CONTRACT_VERSION } from "./contract.js";
import { wallToEpoch, parseHM, parseWallDate } from "./time.js";
import { packGap } from "./pack.js";

/** Longest off-air gap the packer fills. Longer gaps stay empty: off-air
 * is legal and the viewer handles it. */
export const MAX_PACK_GAP_MS = 30 * 60 * 1000;

const ROLES = new Set(["movies", "series-grid", "marathon", "vote"]);
const PACKABLE_KINDS = new Set(["interstitial", "clip"]);

/** Refusal of an invalid schedule. `.problems` lists every defect found. */
export class CompileError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(
      `refusing to compile: ${problems.length} problem(s)\n- ` +
        problems.join("\n- "),
    );
    this.name = "CompileError";
    this.problems = problems;
  }
}

// Deterministic 32-bit seed for a gap's packing: the gap-start epoch ms
// folded to 32 bits. Depends only on the gap start, never on iteration
// order, so the same gap always packs identically.
function gapSeed(gapStartMs) {
  const lo = gapStartMs >>> 0;
  const hi = Math.floor(gapStartMs / 4294967296) >>> 0;
  return (lo ^ hi) >>> 0;
}

// One schedule airing from a library entry at an absolute start.
function makeAiring(entry, startMs) {
  return {
    slug: entry.slug,
    title: entry.title,
    start: startMs,
    end: startMs + entry.runtime_s * 1000,
    live: false,
    src: entry.hls,
  };
}

// Refuse defective library entries before compiling anything from them.
// library.json is a stable boundary (docs/contracts.md section 1) that
// other components write and self-hosters hand-edit, so every entry is
// checked up front — a broken entry is invalid input even when nothing
// currently airs it, and any interstitial/clip may be packed into a gap.
function validateLibrary(library, problems) {
  library.forEach((entry, i) => {
    const named = typeof entry?.slug === "string" && entry.slug.length > 0;
    const where = named
      ? `library entry ${JSON.stringify(entry.slug)}`
      : `library entry ${i}`;
    if (!named) {
      problems.push(`${where}: slug must be a non-empty string`);
    }
    if (typeof entry?.title !== "string" || entry.title.length === 0) {
      problems.push(`${where}: title must be a non-empty string`);
    }
    if (typeof entry?.hls !== "string" || entry.hls.length === 0) {
      problems.push(`${where}: hls must be a non-empty string`);
    }
    if (!Number.isFinite(entry?.runtime_s) || entry.runtime_s <= 0) {
      const got =
        typeof entry?.runtime_s === "string"
          ? JSON.stringify(entry.runtime_s)
          : String(entry?.runtime_s);
      problems.push(
        `${where}: runtime_s must be a finite number > 0, not ${got}`,
      );
    }
  });
}

// Resolve one programming channel's days/slots to airings. Malformed
// dates/times and unknown slugs become problems; their slots are skipped.
function resolveProgrammingChannel(zone, num, progCh, bySlug, problems) {
  const airings = [];
  for (const day of progCh.days ?? []) {
    let wallDate;
    try {
      wallDate = parseWallDate(day.date);
    } catch (err) {
      problems.push(
        `channel ${num}: malformed date ${JSON.stringify(day.date)} (${err.message})`,
      );
      continue;
    }
    let prevMinutes = -1;
    let prevAt = null;
    for (const slot of day.slots ?? []) {
      let hm;
      try {
        hm = parseHM(slot.at);
      } catch (err) {
        problems.push(
          `channel ${num} ${day.date}: malformed at ` +
            `${JSON.stringify(slot.at)} (${err.message})`,
        );
        continue;
      }
      const minutes = hm.hour * 60 + hm.minute;
      if (minutes <= prevMinutes) {
        problems.push(
          `channel ${num} ${day.date}: slots out of order ` +
            `(${JSON.stringify(slot.at)} after ${JSON.stringify(prevAt)})`,
        );
      }
      prevMinutes = minutes;
      prevAt = slot.at;

      const entry = bySlug.get(slot.slug);
      if (!entry) {
        problems.push(
          `channel ${num} ${day.date} ${slot.at}: slug ` +
            `${JSON.stringify(slot.slug)} not in library`,
        );
        continue;
      }
      const start = wallToEpoch(zone, {
        year: wallDate.year,
        month: wallDate.month,
        day: wallDate.day,
        hour: hm.hour,
        minute: hm.minute,
      });
      airings.push(makeAiring(entry, start));
    }
  }
  return airings;
}

// Resolve vote-winner placements ({ slug, startMs }) to airings.
function resolveVoteChannel(num, votePlacements, bySlug, problems) {
  const airings = [];
  for (const p of votePlacements) {
    const entry = bySlug.get(p.slug);
    if (!entry) {
      problems.push(
        `channel ${num}: vote placement slug ` +
          `${JSON.stringify(p.slug)} not in library`,
      );
      continue;
    }
    if (!Number.isFinite(p.startMs)) {
      problems.push(
        `channel ${num}: vote placement ${JSON.stringify(p.slug)} has ` +
          `non-finite startMs ${String(p.startMs)}`,
      );
      continue;
    }
    airings.push(makeAiring(entry, p.startMs));
  }
  return airings;
}

// Fill the gaps between consecutive airings (never before the first or
// after the last) that are at most MAX_PACK_GAP_MS long. Longer gaps stay
// empty. Returns a new airings array; input must be sorted, overlap-free.
function packChannelGaps(airings, pool, bySlug) {
  const out = [];
  for (let i = 0; i < airings.length; i++) {
    out.push(airings[i]);
    const next = airings[i + 1];
    if (!next) continue;
    const gapStartMs = airings[i].end;
    const gap = next.start - gapStartMs;
    if (gap <= 0 || gap > MAX_PACK_GAP_MS) continue;
    const placements = packGap({
      gapStartMs,
      gapEndMs: next.start,
      pool,
      seed: gapSeed(gapStartMs),
    });
    for (const p of placements) {
      out.push(makeAiring(bySlug.get(p.slug), p.start));
    }
  }
  return out;
}

/**
 * Compile a schedule (docs/contracts.md section 3) from the programming
 * object, library manifest, station config, and vote-winner placements.
 *
 * @param {object} args
 * @param {object} args.programming parsed programming.json object
 * @param {Array<object>} args.library library.json entries
 * @param {object} args.config parsed station.config.json object
 * @param {Array<{slug: string, startMs: number}>} [args.votePlacements]
 *   vote-channel placements, merged in place of programming
 * @param {number} args.nowMs generation timestamp (caller's clock)
 * @returns {{ generated: number, station: { name: string, timezone:
 *   string }, channels: Array<{ num: number, name: string, airings:
 *   Array<{ slug, title, start, end, live, src }> }> }}
 * @throws {CompileError} with `.problems` listing every defect found
 */
export function compileSchedule({
  programming,
  library,
  config,
  votePlacements = [],
  nowMs,
}) {
  const problems = [];
  const zone = config.station.timezone;

  if (programming?.version !== CONTRACT_VERSION) {
    problems.push(
      `programming version ${JSON.stringify(programming?.version)} does ` +
        `not match CONTRACT_VERSION ${CONTRACT_VERSION}`,
    );
  }

  validateLibrary(library, problems);

  const bySlug = new Map();
  for (const entry of library) bySlug.set(entry.slug, entry);
  const pool = library.filter((e) => PACKABLE_KINDS.has(e.kind));

  // Config channels are the authoritative list; duplicate nums are a
  // defect, and unknown roles refuse rather than guess.
  const configNums = new Set();
  for (const ch of config.channels) {
    if (configNums.has(ch.num)) {
      problems.push(`duplicate channel num ${ch.num} in config`);
    }
    configNums.add(ch.num);
    if (!ROLES.has(ch.role)) {
      problems.push(
        `channel ${ch.num}: unknown role ${JSON.stringify(ch.role)}`,
      );
    }
  }

  const progByNum = new Map();
  for (const pch of programming?.channels ?? []) {
    if (progByNum.has(pch.num)) {
      problems.push(`duplicate channel num ${pch.num} in programming`);
    } else {
      progByNum.set(pch.num, pch);
    }
    if (!configNums.has(pch.num)) {
      problems.push(`programming channel ${pch.num} not in config channels`);
    }
  }

  // Resolve every channel to airings, collecting problems as we go.
  const channels = [...config.channels]
    .sort((a, b) => a.num - b.num)
    .map((ch) => {
      let airings = [];
      if (ch.role === "vote") {
        // Vote channels are compiled from placements only; the contract
        // forbids them in programming.
        if (progByNum.has(ch.num)) {
          problems.push(
            `channel ${ch.num} (role vote): must not appear in programming`,
          );
        }
        airings = resolveVoteChannel(ch.num, votePlacements, bySlug, problems);
      } else if (ROLES.has(ch.role)) {
        const progCh = progByNum.get(ch.num);
        if (!progCh) {
          problems.push(
            `channel ${ch.num} (role ${ch.role}): missing programming channel`,
          );
        } else {
          airings = resolveProgrammingChannel(
            zone,
            ch.num,
            progCh,
            bySlug,
            problems,
          );
        }
      }
      airings.sort((a, b) => a.start - b.start);
      for (let i = 1; i < airings.length; i++) {
        const prev = airings[i - 1];
        const cur = airings[i];
        if (cur.start < prev.end) {
          problems.push(
            `channel ${ch.num}: overlapping airings ` +
              `${JSON.stringify(prev.slug)} (${prev.start}..${prev.end}) and ` +
              `${JSON.stringify(cur.slug)} (starts ${cur.start})`,
          );
        }
      }
      return { num: ch.num, name: ch.name, airings };
    });

  if (problems.length > 0) throw new CompileError(problems);

  return {
    generated: nowMs,
    station: { name: config.station.name, timezone: zone },
    channels: channels.map((ch) => ({
      num: ch.num,
      name: ch.name,
      airings: packChannelGaps(ch.airings, pool, bySlug),
    })),
  };
}
