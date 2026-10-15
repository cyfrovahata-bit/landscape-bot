import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverParkedDraft } from '../src/lib/draftRecovery';
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
