import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usesLiveReservations,affectsReservations,submissionReservationEffect} from '../src/reservationPolicy.js';

const today='2026-10-18';
test('only a live trip for today uses reservations; report zero is an edit too',()=>{
  assert.equal(usesLiveReservations({date:today,today,recordId:'trip-afternoon'}),true);
  for(const date of [today,'2026-10-17']) {
    assert.equal(usesLiveReservations({date,today,editingTripSeq:0}),false);
    assert.equal(usesLiveReservations({date,today,recordId:'report:7:2026-10-18:0'}),false);
  }
  assert.equal(usesLiveReservations({date:'2026-10-17',today}),false);
  assert.equal(usesLiveReservations({date:today,today,planEditing:true}),false);
});

test('resubmission is not a reservation release; original completion and its retries still release',()=>{
  const edit=submissionReservationEffect(true);
  assert.equal(edit,'none');
  assert.equal(affectsReservations({type:'RTS_SAVE',payload:JSON.stringify({reservationEffect:edit})}),false);
  assert.equal(submissionReservationEffect(true,{reservationEffect:undefined}),undefined);
  assert.equal(submissionReservationEffect(true,{reservationEffect:'none'}),'none');
  assert.equal(affectsReservations({type:'RTS_SAVE',payload:'{}'}),true);
  assert.equal(affectsReservations({type:'RTS_CAR_RETURN'}),true);
  assert.equal(affectsReservations({type:'RTS_RESERVE_CANCEL'}),true);
});

test('editing morning report never changes afternoon reservations for the same or another foreman',()=>{
  for(const afternoonOwner of ['7','8']) {
    const original={type:'RTS_SAVE',owner:'7',payload:'{}',carId:'CAR_2',employeeIds:['E1'],at:12};
    const afternoon={type:'RTS_RESERVE_CAR',owner:afternoonOwner,carId:'CAR_2',employeeIds:['E1'],payload:'{}',at:13};
    const edit={...original,at:14,payload:JSON.stringify({reservationEffect:submissionReservationEffect(true)})};
    const events=[original,afternoon,edit].filter(affectsReservations);
    assert.equal(events.at(-1),afternoon);
    assert.equal(events.at(-1)?.owner,afternoonOwner);
    const completed={...afternoon,type:'RTS_SAVE',at:15};
    assert.equal([...events,completed].filter(affectsReservations).at(-1)?.type,'RTS_SAVE');
  }
});

