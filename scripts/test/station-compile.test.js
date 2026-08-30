// Regression test for the stale-check firing moment: a published week
// must never be replanned while it is on the air (the stored cursors are
// already advanced past it — a replan would publish a shifted lineup),
// and the next week must publish exactly once, on the first tick after
// Monday 00:00. Exercises the real stationCompile against a temp-dir
// station built from invented fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stationCompile } from "../station-compile.js";

const ZONE = "America/Chicago";

// Monday 2026-08-24 00:00 CDT (hand derivation in
// packages/core/test/plan.test.js); no DST transition until November, so
// the next Monday is exactly 7 * 86400000 ms later.
const WEEK1_MS = 1787547600000;
const WEEK2_MS = WEEK1_MS + 7 * 86400000;
const MINUTE_MS = 60000;

// slug -> meta.json (current shape; kind derives from slug conventions:
// "name-NN" episodes, anything else a movie). These runtimes make week
// 1's last airing end Monday 00:10 — inside the old coverage-margin
// guard's stale window at Sunday 23:50, the churn this test pins down.
const TITLES = {
  "harbor-lights": { title: "Harbor Lights", runtime_s: 5400 },
  "voyage-of-the-kestrel": { title: "Voyage of the Kestrel", runtime_s: 6000 },
  "galley-tales-01": { title: "Galley Tales 1", runtime_s: 1500 },
  "galley-tales-02": { title: "Galley Tales 2", runtime_s: 1500 },
  "galley-tales-03": { title: "Galley Tales 3", runtime_s: 1500 },
};

async function makeStation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moviesaboard-test-"));
  const contentDir = path.join(dir, "content");
  for (const [slug, meta] of Object.entries(TITLES)) {
    const titleDir = path.join(contentDir, slug);
    await fs.mkdir(titleDir, { recursive: true });
    // Only meta.json is read; index.m3u8 just has to exist.
    await fs.writeFile(path.join(titleDir, "index.m3u8"), "");
    await fs.writeFile(
      path.join(titleDir, "meta.json"),
      `${JSON.stringify({ slug, ...meta })}\n`,
    );
  }
  const config = {
    station: { name: "Testboard", timezone: ZONE },
    channels: [
      { num: 1, name: "Films", role: "movies" },
      { num: 2, name: "Shows", role: "series-grid" },
    ],
    planner: { movie_break_minutes: 5, grid_minutes: 30 },
    paths: {
      content: contentDir,
      public: path.join(dir, "public"),
      root: dir,
      state: path.join(dir, "state"),
    },
  };
  return { dir, config };
}

async function snapshot(file) {
  const [content, stat] = await Promise.all([
    fs.readFile(file, "utf8"),
    fs.stat(file),
  ]);
  return { content, mtimeMs: stat.mtimeMs };
}

function firstAiring(schedule, num) {
  const ch = schedule.channels.find((c) => c.num === num);
  return ch.airings.reduce((a, b) => (b.start < a.start ? b : a));
}

test("stale check republishes only after the new week begins", async () => {
  const { dir, config } = await makeStation();
  try {
    const schedulePath = path.join(config.paths.public, "schedule.json");
    const cursorsPath = path.join(config.paths.state, "cursors.json");
    const programmingPath = path.join(config.paths.state, "programming.json");

    // No schedule published yet -> a stale-check tick publishes week 1.
    const boot = await stationCompile({
      config,
      checkStale: true,
      dryRun: false,
      nowMs: WEEK1_MS + 60 * MINUTE_MS,
    });
    assert.equal(boot.action, "published");
    const published = {
      schedule: await snapshot(schedulePath),
      cursors: await snapshot(cursorsPath),
      programming: await snapshot(programmingPath),
    };

    // Sunday 23:50 of the published week: the schedule's coverage ends
    // within the hour, but the week on the air must NOT be replanned —
    // no churn in any of the three written files.
    const sunday = await stationCompile({
      config,
      checkStale: true,
      dryRun: false,
      nowMs: WEEK2_MS - 10 * MINUTE_MS,
    });
    assert.equal(sunday.action, "fresh");
    assert.deepEqual(await snapshot(schedulePath), published.schedule);
    assert.deepEqual(await snapshot(cursorsPath), published.cursors);
    assert.deepEqual(await snapshot(programmingPath), published.programming);

    // First tick after Monday 00:00: week 2 publishes, planned with the
    // stored cursors — the movie rotation continues where week 1 ended
    // instead of rewinding or skipping.
    const monday = await stationCompile({
      config,
      checkStale: true,
      dryRun: false,
      nowMs: WEEK2_MS + 5 * MINUTE_MS,
    });
    assert.equal(monday.action, "published");
    const week2 = JSON.parse((await snapshot(schedulePath)).content);
    const opener = firstAiring(week2, 1);
    assert.equal(opener.start, WEEK2_MS);
    const cursors = JSON.parse(published.cursors.content);
    const features = ["harbor-lights", "voyage-of-the-kestrel"];
    assert.equal(opener.slug, features[cursors.movies_index % 2]);

    // A second tick in the new week is a no-op.
    const replayed = await snapshot(schedulePath);
    const again = await stationCompile({
      config,
      checkStale: true,
      dryRun: false,
      nowMs: WEEK2_MS + 10 * MINUTE_MS,
    });
    assert.equal(again.action, "fresh");
    assert.deepEqual(await snapshot(schedulePath), replayed);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
