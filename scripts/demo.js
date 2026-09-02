// MoviesAboard demo: clone -> npm install -> npm run demo -> open a
// browser -> see TV. No daemon, no internet.
//
// Orchestrates: generate synthetic fixtures (skipping ones already built),
// assemble library.json, plan a week, compile schedule.json, then serve.
// Everything lands in demo-dist/ (git-ignored); restart-safe throughout.
//
// This file is the ONLY place the environment is read (timezone, clock,
// port) — @moviesaboard/core stays pure.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  weekStart,
  planWeek,
  compileSchedule,
  CompileError,
  PlanError,
} from "@moviesaboard/core";
import { generateFixtures, buildLibrary } from "./demo-fixtures.js";
import { startServer } from "./demo-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "demo-dist");
const MINUTE_MS = 60000;

const log = (msg) => console.log(`[demo] ${msg}`);

// The demo station config — the station.config.json shape documented
// atop scripts/station-compile.js, with the machine's own timezone so
// the guide reads naturally.
function demoConfig() {
  return {
    station: {
      name: "MoviesAboard Demo",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    channels: [
      { num: 1, name: "Movies", role: "movies" },
      { num: 2, name: "Series", role: "series-grid" },
      { num: 3, name: "Marathon", role: "marathon" },
      { num: 5, name: "Requests", role: "vote" },
    ],
    planner: { movie_break_minutes: 2, grid_minutes: 15 },
  };
}

// Channel 5 placements: a few "vote winner" features near now, the first
// already a few minutes in so the Requests channel is live the moment the
// browser opens. 2-minute gaps between them get packed with interstitials
// at compile time.
function makeVotePlacements(library, nowMs) {
  const features = library
    .filter((e) => e.kind === "movie")
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 3);
  const placements = [];
  let startMs = nowMs - 3 * MINUTE_MS; // already airing
  for (const f of features) {
    placements.push({ slug: f.slug, startMs });
    startMs += f.runtime_s * 1000 + 2 * MINUTE_MS;
  }
  return placements;
}

async function writeJson(file, data, { compact = false } = {}) {
  const json = compact
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);
  await fs.writeFile(file, `${json}\n`);
}

async function main() {
  await fs.mkdir(path.join(DIST, "content"), { recursive: true });

  log(`demo output: ${DIST}`);
  const { built, skipped } = await generateFixtures({
    distDir: DIST,
    log,
  });
  log(`fixtures ready (${built.length} encoded, ${skipped.length} reused)`);

  const library = await buildLibrary({ distDir: DIST });
  log(`library.json: ${library.length} titles`);

  const config = demoConfig();
  const zone = config.station.timezone;
  const nowMs = Date.now();
  const weekStartMs = weekStart(zone, nowMs);

  let programming;
  try {
    ({ programming } = planWeek({ library, config, weekStartMs }));
  } catch (err) {
    if (err instanceof PlanError) {
      console.error("[demo] week refused to plan:");
      for (const p of err.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    throw err;
  }
  await writeJson(path.join(DIST, "programming.json"), programming);

  let schedule;
  try {
    schedule = compileSchedule({
      programming,
      library,
      config,
      votePlacements: makeVotePlacements(library, nowMs),
      nowMs,
    });
  } catch (err) {
    if (err instanceof CompileError) {
      console.error("[demo] schedule refused to compile:");
      for (const p of err.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    throw err;
  }
  // Compact: the viewer refetches this every minute, and a week of packed
  // channels is tens of thousands of airings.
  await writeJson(path.join(DIST, "schedule.json"), schedule, {
    compact: true,
  });
  const airings = schedule.channels.reduce(
    (n, ch) => n + ch.airings.length,
    0,
  );
  log(
    `schedule.json: ${schedule.channels.length} channels, ` +
      `${airings} airings, timezone ${zone}`,
  );
  const lastEnd = schedule.channels.reduce(
    (m, ch) => ch.airings.reduce((x, a) => Math.max(x, a.end), m),
    0,
  );
  log(
    `schedule covers through ${new Date(lastEnd).toLocaleString()} — ` +
      `re-run \`npm run demo\` after that`,
  );
  log(
    "note: voting tallies live on the vote page, but re-scheduling the " +
      "winner onto the Requests channel arrives with stationd (Phase 2)",
  );

  const { url } = await startServer({ distDir: DIST, log });
  console.log(`
  ============================================
    MoviesAboard is ON THE AIR

    ${url}

    Watch:    ${url}
    Guide:    ${url}schedule.html
    Vote:     ${url}vote.html

    Ctrl+C stops the station.
  ============================================
`);
}

main().catch((err) => {
  console.error(`[demo] ${err.stack || err.message || err}`);
  process.exit(1);
});
