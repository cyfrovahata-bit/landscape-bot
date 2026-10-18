/** Keep independent unfinished trips accessible without exposing the recovery archive. */
export function currentTripRecords<T extends {id:string;state:string;planEditing:boolean;editingTripSeq:number|null}>(records:T[], currentId:string):T[] {
  return records.filter(r => r.state === 'open' && r.id !== currentId &&
    !r.id.startsWith('import:') && !r.id.startsWith('report:') &&
    !r.planEditing && r.editingTripSeq == null);
}
