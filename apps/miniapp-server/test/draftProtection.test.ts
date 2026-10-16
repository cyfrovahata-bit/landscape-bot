import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftWriteConflict, draftClearConflict, hasDraftContent, parkedDraft } from '../src/lib/draftProtection.js';
const running = { date: '2026-10-15', carId: 'CAR_2', tripStartedAt: '2026-10-15T03:00:00Z', plans: [{ sessions: [{ employeeId: 'EMP_7' }] }], editingTripSeq: null };
test('blank mount cannot erase a running day, including legacy clients', () => {
  assert.equal(draftWriteConflict(running, { date: running.date, plans: [] }, 2, undefined), 'empty');
  assert.equal(draftWriteConflict({ dayStash: running }, {}, 2, 2), 'empty');
});
test('stale revisions cannot overwrite or resurrect a cleared draft', () => {
  assert.equal(draftWriteConflict(running, running, 3, 2), 'revision');
  assert.equal(draftWriteConflict(null, running, 3, 2), 'revision');
  assert.equal(draftWriteConflict(null, running, 3, 3), null);
});
test('returned report must preserve running trip and can return to it', () => {
  const returned = { date: '2026-10-13', carId: 'CAR_2', dayStash: running };
  assert.equal(draftWriteConflict(running, { ...returned, dayStash: null }, 2, 2), 'unparked_day');
  assert.equal(draftWriteConflict(running, returned, 2, 2), null);
  assert.equal(draftWriteConflict(returned, running, 3, 3), null);
  assert.equal(draftWriteConflict(returned, { date: '2026-10-13', carId: 'CAR_2' }, 3, 3), 'lost_stash');
  assert.deepEqual(parkedDraft(returned), running);
});
test('normal updates and first setup remain allowed; parked content counts', () => {
  assert.equal(draftWriteConflict(null, {}, 0, 0), null);
  assert.equal(draftWriteConflict(running, { ...running, step: 'RETURN' }, 4, 4), null);
  assert.equal(hasDraftContent({ dayStash: running }), true);
  assert.equal(hasDraftContent({ plans: [], employeeIds: [] }), false);
});

test('legacy tabs cannot replace a slot managed by the new client', () => {
  assert.equal(draftWriteConflict(running, { ...running, step: 'DRIVE' }, 5, undefined, true), 'legacy_writer');
  assert.equal(draftWriteConflict(running, { ...running, step: 'DRIVE' }, 5, 5, true), null);
});
test('stale and legacy clears are rejected, explicit admin clear is retained', () => {
  assert.equal(draftClearConflict(5, 4, true, false), true);
  assert.equal(draftClearConflict(5, undefined, true, false), true);
  assert.equal(draftClearConflict(5, 5, true, false), false);
  assert.equal(draftClearConflict(5, undefined, true, true), false);
  assert.equal(draftClearConflict(0, undefined, false, false), false);
});

test('prepared trip is protected before departure, including a same-date report', () => {
  const prepared = { ...running, tripStartedAt: null };
  const old = { date: '2026-10-14', carId: 'CAR_2', editingTripSeq: 0 };
  assert.equal(draftWriteConflict(prepared, old, 3, 3), 'unparked_day');
  assert.equal(draftWriteConflict(prepared, { ...old, date: prepared.date }, 3, 3), 'unparked_day');
  assert.equal(draftWriteConflict(prepared, { ...old, dayStash: prepared }, 3, 3), null);
});
test('same-date edit cannot drop the parked trip; returning to the real trip is allowed', () => {
  const borrowed = { ...running, editingTripSeq: 0, dayStash: running };
  assert.equal(draftWriteConflict(borrowed, { ...borrowed, dayStash: null }, 4, 4), 'lost_stash');
  assert.equal(draftWriteConflict(borrowed, running, 4, 4), null);
  assert.equal(draftWriteConflict(borrowed, { ...running, carId: 'OTHER' }, 4, 4), 'lost_stash');
});
