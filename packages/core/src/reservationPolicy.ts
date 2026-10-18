/** Reservations describe live trips, never editing an already submitted report. */
export function usesLiveReservations(context: {
  date:string; today:string; editingTripSeq?:number|null; planEditing?:boolean; recordId?:string;
}):boolean {
  return context.date === context.today && context.editingTripSeq == null &&
    !context.planEditing && !context.recordId?.startsWith('report:');
}

/** Historical saves keep their existing release semantics; new edits opt out. */
export function affectsReservations(event:{type:string;payload?:string|null}):boolean {
  if(event.type !== 'RTS_SAVE')return true;
  try {return JSON.parse(event.payload || '{}').reservationEffect !== 'none';}
  catch {return true;}
}

export function submissionReservationEffect(isReportEdit:boolean, previousAttempt?:{reservationEffect?:string}):string|undefined {
  // An automatic retry must retain the first submission's release event.
  return previousAttempt ? previousAttempt.reservationEffect : isReportEdit ? 'none' : undefined;
}
