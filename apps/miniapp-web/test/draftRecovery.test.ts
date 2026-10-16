import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverParkedDraft, shouldRestoreDraft } from '../src/lib/draftRecovery';
import { DraftWriteQueue } from '../src/lib/draftWriteQueue';
test('server recovery keeps the running day instead of the returned report', () => {
  const day = { date: '2026-10-15', carId: 'CAR_2', plans: [{ sessions: [{ employeeId: 'EMP_7', startedAt: '08:00' }] }] };
  const restored = recoverParkedDraft({ date: '2026-10-13', dayStash: day, fixingReturnedDate: '2026-10-13', planEditing: false });
  assert.equal(restored.date, day.date);
  assert.equal(restored.dayStash, null);
  assert.equal(restored.fixingReturnedDate, null);
  assert.deepEqual((restored as any).plans, day.plans);
});
test('ordinary drafts are unchanged', () => {
  const day = { planEditing: false, dayStash: null, date: '2026-10-15' };
  assert.equal(recoverParkedDraft(day), day);
});
test('clear waits for in-flight PUT and cancels queued old snapshots', async () => {
  const queue = new DraftWriteQueue();
  const events: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = queue.enqueue(async () => { events.push('put-start'); await pending; events.push('put-end'); });
  await Promise.resolve();
  const old = queue.enqueue(async () => { events.push('old-put'); });
  queue.invalidate();
  const clear = queue.enqueue(async () => { events.push('delete'); }, true);
  const next = queue.enqueue(async () => { events.push('new-trip'); });
  finish();
  await Promise.all([first, old, clear, next]);
  assert.deepEqual(events, ['put-start', 'put-end', 'delete', 'new-trip']);
});
test('a failed write does not deadlock later queued requests', async () => {
  const queue = new DraftWriteQueue();
  await assert.rejects(queue.enqueue(async () => { throw new Error('network'); }));
  assert.equal(await queue.enqueue(async () => 42), 42);
});

test('recovery preserves a prepared trip, its crew, works and navigation state', () => {
  const parked = { date: '2026-10-16', step: 'HUB', carId: 'CAR_2', tripStartedAt: null,
    employeeIds: ['EMP_7'], plans: [{ objectId: 'OBJ_6', works: [{ volume: '2,5' }] }],
    volumesReturnStep: 'REVIEW', goingHomeWithoutThem: true, worksBeforePicker: [{ workId: 'WT_1' }] };
  const result = recoverParkedDraft({ date: '2026-10-16', step: 'REVIEW',
    fixingReturnedDate: '2026-10-16', dayStash: parked });
  for (const [key, value] of Object.entries(parked)) assert.deepEqual((result as any)[key], value);
  assert.equal(result.dayStash, null);
});

test('a prepared or parked day survives 20 hours; empty abandoned drafts expire', () => {
  const now = 48 * 60 * 60 * 1000;
  for (const d of [{carId:'CAR_2'}, {employeeIds:['EMP_7']}, {plans:[{}]}, {dayStash:{carId:'CAR_2'}}]) {
    assert.equal(shouldRestoreDraft(0,d,now),true);
  }
  assert.equal(shouldRestoreDraft(0,{plans:[],employeeIds:[]},now),false);
  assert.equal(shouldRestoreDraft(now,{},now),true);
});
