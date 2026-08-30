import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "@moviesaboard/core";

test("contract version is a positive integer", () => {
  assert.equal(Number.isInteger(CONTRACT_VERSION), true);
  assert.ok(CONTRACT_VERSION >= 1);
});
