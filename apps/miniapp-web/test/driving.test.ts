import { test } from "node:test";
import assert from "node:assert/strict";
import { carMovementError, initialCarRiders, EMPTY_CAR_MESSAGE, selectedDestination } from "../src/lib/driving.js";

test("empty car cannot leave an object, change destination, or return to base", () => {
  assert.equal(carMovementError([]), EMPTY_CAR_MESSAGE);
});
test("one rider is enough; normal crew trips remain allowed", () => {
  assert.equal(carMovementError(["driver"]), null);
  assert.equal(carMovementError(["driver", "worker"]), null);
});
test("people travelling independently cannot make the car nonempty", () => {
  assert.deepEqual(initialCarRiders(["a", "b"], ["a", "b"]), []);
  assert.equal(carMovementError(initialCarRiders(["a", "b"], ["a", "b"])), EMPTY_CAR_MESSAGE);
  assert.deepEqual(initialCarRiders(["driver", "worker"], ["worker"]), ["driver"]);
});

test("repeat arrival at visited Kosyno remains available even when all work is finished", () => {
  const kosyno = { objectId: "kosyno", visited: true, noWork: false, sessions: [{ employeeId: "worker" }], here: ["worker"] };
  const karas = { objectId: "karas", visited: false, noWork: false, sessions: [], here: [] };
  assert.equal(selectedDestination([kosyno, karas], "kosyno"), kosyno);
  assert.equal(selectedDestination([kosyno], "kosyno"), kosyno);
  assert.equal(carMovementError([]), EMPTY_CAR_MESSAGE);
});
test("no-work object can be deliberately revisited; cleared/deleted destination stays empty", () => {
  const plan = { objectId: "done", visited: true, noWork: true };
  assert.equal(selectedDestination([plan], "done"), plan);
  assert.equal(selectedDestination([plan], ""), null);
  assert.equal(selectedDestination([plan], "deleted"), null);
});
