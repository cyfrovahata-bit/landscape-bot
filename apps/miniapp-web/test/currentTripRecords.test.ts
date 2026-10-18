import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTripRecords } from '../src/lib/currentTripRecords';

test('current trips stay switchable without recovery copies or duplicate report editors', () => {
  const row = {state:'open', planEditing:false, editingTripSeq:null};
  const records = [
    {...row,id:'current'}, {...row,id:'other-trip'}, {...row,id:'yesterday-trip'},
    {...row,id:'import:old-phone'}, {...row,id:'report:owner:date:0'},
    {...row,id:'archived-trip',state:'archived'},
    {...row,id:'planner',planEditing:true}, {...row,id:'editor',editingTripSeq:0},
  ];
  const before = structuredClone(records);
  assert.deepEqual(currentTripRecords(records,'current').map(r=>r.id),['other-trip','yesterday-trip']);
  assert.deepEqual(records,before, 'hiding records must never alter stored data');
});
