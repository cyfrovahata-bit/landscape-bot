import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDayReports, fetchReturnedReports, confirmedNoTrips } from '../src/lib/reportLoading';

const date = '2026-10-20';
type Status = { hasSubmission: boolean; returned: boolean };
type Trip = { eventId: string; status: string };
type Combined = { km: number };
const previous = { status: { hasSubmission: true, returned: true }, trips: [{ eventId: 'own-trip', status: 'ПОВЕРНУТО' }], combined: { km: 30 } };
const getFrom = (read: (path: string) => unknown) => async <R>(path: string): Promise<R> => read(path) as R;

test('failed status or failed cards cannot replace the last confirmed returned report with an empty day', async () => {
  for (const failingRequest of ['day-status', 'submitted-today']) {
    let displayed = previous;
    const get = getFrom(path => {
      if (path.includes(failingRequest)) throw new TypeError('Failed to fetch');
      return previous.status;
    });
    await assert.rejects(async () => { displayed = await fetchDayReports<Status, Trip, Combined>(get, date); }, /Failed to fetch/);
    assert.equal(displayed, previous);
    assert.equal(displayed.status.returned, true);
    assert.equal(displayed.trips[0].eventId, 'own-trip');
  }
});

test('retry publishes a complete fresh report snapshot after both requests succeed', async () => {
  const paths: string[] = [];
  const updated = { ...previous, status: { hasSubmission: true, returned: false }, trips: [{ eventId: 'own-trip', status: 'ЗАТВЕРДЖЕНО' }] };
  const result = await fetchDayReports<Status, Trip, Combined>(getFrom(path => {
    paths.push(path);
    return path.includes('day-status') ? updated.status : { found: true, trips: updated.trips, combined: updated.combined };
  }), date);
  assert.deepEqual(result, updated);
  assert.deepEqual(paths, [`/api/road-timesheet/day-status?date=${date}`, `/api/road-timesheet/submitted-today?date=${date}`]);
});

test('invalid report cards are an error, while explicitly absent or cancelled trips are confirmed empty', async () => {
  for (const response of [{ found: true, combined: null }, { found: true, trips: [], combined: null }]) {
    await assert.rejects(fetchDayReports(getFrom(path => path.includes('day-status') ? previous.status : response), date), /список звітів/);
  }
  let reads = 0;
  const empty = await fetchDayReports(getFrom(() => { reads++; return { hasSubmission: false }; }), date);
  assert.deepEqual(empty, { status: { hasSubmission: false }, trips: [], combined: null });
  assert.equal(reads, 1);
  const cancelled = await fetchDayReports(getFrom(path => path.includes('day-status') ? previous.status : { found: false, trips: [], combined: null }), date);
  assert.deepEqual(cancelled.trips, []);
});

test('empty-state text requires successful loading of this date and no active or submitted trips', () => {
  for (const phase of ['loading', 'error'] as const) assert.equal(confirmedNoTrips({ date, phase, error: '' }, date, false), false);
  assert.equal(confirmedNoTrips({ date: '2026-10-19', phase: 'ready', error: '' }, date, false), false);
  assert.equal(confirmedNoTrips({ date, phase: 'ready', error: '' }, date, true), false);
  assert.equal(confirmedNoTrips({ date, phase: 'ready', error: '' }, date, false), true);
});

test('returned-day network errors and invalid responses preserve the prior list; successful empty response clears it', async () => {
  const oldDays = [{ date: '2026-10-16', reason: 'ODO', trips: 1 }];
  let displayed = oldDays;
  for (const read of [() => { throw new TypeError('Failed to fetch'); }, () => ({})]) {
    await assert.rejects(async () => { displayed = await fetchReturnedReports(getFrom(read)); });
    assert.equal(displayed, oldDays);
  }
  displayed = await fetchReturnedReports(getFrom(() => ({ days: [] })));
  assert.deepEqual(displayed, []);
});
