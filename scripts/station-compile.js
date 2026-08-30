// Station compile: import the content library, plan the current week,
// compile schedule.json, and atomically publish it. The stationd-less
// interim for a real deployment (nginx keeps serving everything static);
// run from a timer — with --check-stale it exits quickly while the
// published schedule still covers the near future, and replans when the
// week runs out.
//
//   node scripts/station-compile.js --config <station.config.json>
//        [--check-stale] [--dry-run]
//
// station.config.json is the operator config (host-specific, lives
// OUTSIDE the repo; station.yaml parsing arrives in Phase 2):
//   { "station": { "name", "timezone" },
//     "channels": [{ "num", "name", "role" }],
//     "planner": { "movie_break_minutes", "grid_minutes" },
//     "paths": { "content", "public", "root", "state" } }
//
// Writes: <public>/schedule.json, <root>/library.json,
// <state>/cursors.json + <state>/programming.json — all tmp+rename. The
// compiler refuses invalid schedules, so the last-good schedule.json is
// never replaced by a broken one.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CompileError,
  PlanError,
  compileSchedule,
  planWeek,
  weekStart,
} from "@moviesaboard/core";
import { buildLibraryFromContent } from "./import.js";

const FRESH_MARGIN_MS = 60 * 60 * 1000; // covered this far ahead = fresh

const log = (msg) => console.log(`[station-compile] ${msg}`);

async function writeJsonAtomic(file, data, { compact = false } = {}) {
  const json = compact
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${json}\n`);
  await fs.rename(`${file}.tmp`, file);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function lastEndMs(schedule) {
  let last = 0;
  for (const ch of schedule?.channels ?? []) {
    for (const a of ch.airings ?? []) last = Math.max(last, a.end);
  }
  return last;
}

export async function stationCompile({ config, checkStale, dryRun, nowMs }) {
  const zone = config.station.timezone;
  const publicDir = config.paths.public;
  const schedulePath = path.join(publicDir, "schedule.json");

  if (checkStale) {
    const current = await readJsonOrNull(schedulePath);
    const covered = lastEndMs(current);
    if (covered > nowMs + FRESH_MARGIN_MS) {
      log(
        `schedule fresh (covers through ${new Date(covered).toISOString()})` +
          " — nothing to do",
      );
      return { action: "fresh" };
    }
  }

  const { library, skipped } = await buildLibraryFromContent(
    config.paths.content,
  );
  log(`library: ${library.length} titles (${skipped.length} skipped)`);

  const cursorsPath = path.join(config.paths.state, "cursors.json");
  const cursors = (await readJsonOrNull(cursorsPath)) ?? {};
  const weekStartMs = weekStart(zone, nowMs);

  let programming;
  let nextCursors;
  try {
    ({ programming, cursors: nextCursors } = planWeek({
      library,
      config,
      cursors,
      weekStartMs,
    }));
  } catch (err) {
    if (err instanceof PlanError) {
      console.error("[station-compile] week refused to plan:");
      for (const p of err.problems) console.error(`  - ${p}`);
      process.exitCode = 1;
      return { action: "plan-refused", problems: err.problems };
    }
    throw err;
  }

  let schedule;
  try {
    schedule = compileSchedule({
      programming,
      library,
      config,
      votePlacements: [],
      nowMs,
    });
  } catch (err) {
    if (err instanceof CompileError) {
      console.error("[station-compile] schedule refused to compile:");
      for (const p of err.problems) console.error(`  - ${p}`);
      process.exitCode = 1;
      return { action: "compile-refused", problems: err.problems };
    }
    throw err;
  }

  const airings = schedule.channels.reduce(
    (n, ch) => n + ch.airings.length,
    0,
  );
  const covered = lastEndMs(schedule);
  log(
    `${schedule.channels.length} channels, ${airings} airings, ` +
      `covers through ${new Date(covered).toISOString()}`,
  );
  if (dryRun) {
    log("dry run — nothing written");
    return { action: "dry-run", airings };
  }

  await writeJsonAtomic(
    path.join(config.paths.root, "library.json"),
    library,
  );
  await writeJsonAtomic(
    path.join(config.paths.state, "programming.json"),
    programming,
  );
  await writeJsonAtomic(schedulePath, schedule, { compact: true });
  await writeJsonAtomic(cursorsPath, nextCursors);
  log(`published ${schedulePath}`);
  return { action: "published", airings };
}

async function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf("--config");
  if (cfgIdx < 0 || !args[cfgIdx + 1]) {
    console.error(
      "usage: node scripts/station-compile.js --config <file> " +
        "[--check-stale] [--dry-run]",
    );
    process.exit(2);
  }
  const config = JSON.parse(await fs.readFile(args[cfgIdx + 1], "utf8"));
  await stationCompile({
    config,
    checkStale: args.includes("--check-stale"),
    dryRun: args.includes("--dry-run"),
    nowMs: Date.now(),
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[station-compile] ${err.stack || err.message}`);
    process.exit(1);
  });
}
