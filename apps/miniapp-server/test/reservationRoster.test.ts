import { test } from "node:test";
import assert from "node:assert/strict";
import { removedHeldEmployees } from "../src/lib/reservationRoster.js";

test("roster shrinking releases omitted workers and retains selected ones", () => {
  assert.deepEqual(removedHeldEmployees(["foreman", "roman", "maksym", "ruslan"], ["foreman"]), ["roman", "maksym", "ruslan"]);
});
test("empty roster releases all held workers; adding workers releases none", () => {
  assert.deepEqual(removedHeldEmployees(["a", "b"], []), ["a", "b"]);
  assert.deepEqual(removedHeldEmployees(["a"], ["a", "b"]), []);
});
test("only currently held reservations are considered, without duplicates", () => {
  assert.deepEqual(removedHeldEmployees(["a", "a"], ["other"]), ["a"]);
});
