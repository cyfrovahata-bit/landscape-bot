/** Persistence identity only. Does not calculate hours, volumes, allowances or pay. */
export function submissionDraftConflict(row:{state:string;revision:number;payload:string}, date:string, seq:number|undefined,
  base:number|undefined, previousEventId:string|undefined, eventId:string):string|null {
  const source=JSON.parse(row.payload);
  if(source.date!==date||(source.editingTripSeq!=null&&source.editingTripSeq!==seq))return 'identity';
  if(previousEventId!==eventId&&(row.state!=='open'||row.revision!==base))return 'revision';
  return null;
}
export function submissionSequence(explicit:number|undefined, byDraft:number|undefined, byRequest:number|undefined, existing:number[]):number {
  return explicit??byDraft??byRequest??(existing.length?Math.max(...existing)+1:0);
}
