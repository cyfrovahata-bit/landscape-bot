import { test } from "node:test";
import assert from "node:assert/strict";
import { carMovementError, carRiderRemovalError, LAST_CAR_RIDER_MESSAGE, initialCarRiders, EMPTY_CAR_MESSAGE, selectedDestination } from "../src/lib/driving.js";

const enRoute = {tripStartedAt:'2026-10-16T05:43:38.074Z',carAtObjectId:'',odoEnd:''};

test('Albina regression: roster edits cannot remove the final rider after departure', () => {
  let onboard = ['EMP_032','EMP_036','EMP_029'];
  for (const id of onboard.slice(0,2)) {
    assert.equal(carRiderRemovalError(onboard,[id],enRoute),null);
    onboard=onboard.filter(x=>x!==id);
  }
  assert.equal(carRiderRemovalError(onboard,['EMP_029'],enRoute),LAST_CAR_RIDER_MESSAGE);
  assert.deepEqual(onboard,['EMP_029']);
});

test('bulk roster clear, roadside drop-off and independent arrival cannot empty a moving car', () => {
  for (const removed of [['driver'],['driver','worker'],['driver','driver']]) {
    assert.equal(carRiderRemovalError(['driver'],removed,enRoute),LAST_CAR_RIDER_MESSAGE);
  }
  assert.equal(carRiderRemovalError(['driver','worker'],['worker'],enRoute),null);
  assert.equal(carRiderRemovalError(['driver'],['self-transport-worker'],enRoute),null);
});

test('opening object menus and changing direction does not count as parking', () => {
  // No screen or heading dependence: active and paused route both retain a rider.
  assert.equal(carRiderRemovalError(['driver'],['driver'],enRoute),LAST_CAR_RIDER_MESSAGE);
});

test('parked car can unload for work; next empty departure remains forbidden', () => {
  assert.equal(carRiderRemovalError(['driver'],['driver'],{...enRoute,carAtObjectId:'OBJ_1'}),null);
  assert.equal(carMovementError([]),EMPTY_CAR_MESSAGE);
  assert.equal(carRiderRemovalError(['driver'],['driver'],{...enRoute,tripStartedAt:null}),null);
  assert.equal(carRiderRemovalError(['driver'],['driver'],{...enRoute,odoEnd:'220'}),null);
});

test('historical empty drafts are not rewritten and unrelated people remain editable', () => {
  assert.equal(carRiderRemovalError([],['self-transport-worker'],enRoute),null);
  assert.equal(carRiderRemovalError(['driver'],[],enRoute),null);
  assert.equal(carRiderRemovalError(['driver','worker'],['worker'],enRoute),null);
});

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
