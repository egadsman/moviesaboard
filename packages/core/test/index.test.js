import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "@moviesaboard/core";

test("index re-exports the full public surface", () => {
  const functions = [
    // time
    "epochToWall",
    "zoneOffsetMs",
    "wallToEpoch",
    "addDays",
    "startOfDay",
    "weekStart",
    "parseHM",
    "parseWallDate",
    "formatWallDate",
    // pack
    "mulberry32",
    "packGap",
    // vote
    "tally",
    "openBallot",
    // compile
    "compileSchedule",
    // plan
    "planWeek",
  ];
  for (const name of functions) {
    assert.equal(typeof core[name], "function", `${name} is a function`);
  }
  assert.equal(typeof core.CompileError, "function");
  assert.ok(Object.prototype.isPrototypeOf.call(
    Error.prototype, core.CompileError.prototype));
  assert.equal(Number.isInteger(core.CONTRACT_VERSION), true);
  assert.equal(Number.isInteger(core.MAX_PACK_GAP_MS), true);
  assert.ok(core.MAX_PACK_GAP_MS > 0);
});
