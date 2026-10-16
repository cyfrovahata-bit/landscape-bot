import { test } from "node:test";
import assert from "node:assert/strict";
import { canFinishRecordedTrip } from "../src/lib/lateTripSubmission.js";
const date = "2026-10-15";
const reserve = { type: "RTS_RESERVE_CAR", carId: "CAR_3", ts: new Date("2026-10-15T03:36:00Z") };
const progress = [{ state: "DRIVING", updatedAt: new Date("2026-10-15T03:41:00Z") }];
test("yesterday's real trip may be completed today", () => {
  assert.equal(canFinishRecordedTrip(date, "CAR_3", [reserve], progress), true);
});
test("manual backdating, wrong car and reservation without departure stay blocked", () => {
  assert.equal(canFinishRecordedTrip(date, "CAR_3", [], progress), false);
  assert.equal(canFinishRecordedTrip(date, "CAR_2", [reserve], progress), false);
  assert.equal(canFinishRecordedTrip(date, "CAR_3", [reserve], []), false);
  assert.equal(canFinishRecordedTrip(date, "CAR_3", [{...reserve, ts:new Date("2026-10-16T03:00:00Z")}], progress), false);
});
test("submitted or cancelled trips cannot be duplicated", () => {
  for (const type of ["RTS_SAVE", "RTS_RESERVE_CANCEL"]) {
    assert.equal(canFinishRecordedTrip(date, "CAR_3", [reserve, {...reserve,type,ts:new Date("2026-10-16T03:00:00Z")}], progress), false);
  }
});
test("old progress and progress created on a later day are insufficient", () => {
  for (const t of ["2026-10-15T03:00:00Z", "2026-10-16T03:00:00Z"]) {
    assert.equal(canFinishRecordedTrip(date,"CAR_3",[reserve],[{state:"DRIVING",updatedAt:new Date(t)}]),false);
  }
});
