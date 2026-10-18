type Payload = Record<string, any>;
export function validTripId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(id);
}
export function reportDraftId(owner: string, date: string, seq: number): string {
  return `report:${owner}:${date}:${seq}`;
}
/** Identity fields can never move between records, even at a matching revision. */
export function tripDraftConflict(current: Payload | null, incoming: Payload, revision: number, base: unknown): string | null {
  if (!Number.isSafeInteger(base) || base !== revision) return 'revision';
  if (!current) return null;
  if ((current.editingTripSeq != null && current.date !== incoming.date) || (current.editingTripSeq ?? null) !== (incoming.editingTripSeq ?? null)) return 'identity';
  if (current.recordId !== incoming.recordId) return 'identity';
  return null;
}
/** Split a legacy parked day WITHOUT deleting or modifying the original. */
export function splitLegacyDraft(owner: string, value: Payload): Array<{id: string; payload: Payload}> {
  const out: Array<{id: string; payload: Payload}> = [];
  const walk = (p: Payload, suffix: string) => {
    if (p.dayStash && typeof p.dayStash === 'object') walk(p.dayStash, `${suffix}:stash`);
    if (!(p.carId || p.tripStartedAt || p.employeeIds?.length || p.plans?.length)) return;
    const id = p.editingTripSeq != null ? reportDraftId(owner, p.date, p.editingTripSeq) : `legacy:${owner}:${suffix}`;
    if (out.some(x => x.id === id)) return;
    out.push({id, payload:{...p,recordId:id,dayStash:null,fixingReturnedDate:null}});
  };
  walk(value,'current');
  return out;
}

export function ownedTripId(id:string, owner:string):boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    || ['report','legacy','import'].some(prefix=>id.startsWith(`${prefix}:${owner}:`));
}
