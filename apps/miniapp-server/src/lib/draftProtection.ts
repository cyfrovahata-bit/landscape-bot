/** Safeguards only persistence; never changes payroll or the trip builder. */
type Payload = Record<string, any>;
export function hasDraftContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const d = value as Payload;
  return !!d.carId || !!d.tripStartedAt || (Array.isArray(d.employeeIds) && d.employeeIds.length > 0)
    || (Array.isArray(d.plans) && d.plans.length > 0) || hasDraftContent(d.dayStash);
}
export function draftWriteConflict(current: Payload | null, incoming: Payload, revision: number, base: unknown, managed = false): string | null {
  if (managed && base === undefined) return "legacy_writer";
  if (base !== undefined && (!Number.isSafeInteger(base) || base !== revision)) return 'revision';
  if (current && hasDraftContent(current) && !hasDraftContent(incoming)) return 'empty';
  // Opening a returned report must park the running day BEFORE borrowing its builder.
  if (current?.tripStartedAt && current.editingTripSeq == null && current.date !== incoming.date
      && !hasDraftContent(incoming.dayStash)) return 'unparked_day';
  if (hasDraftContent(current?.dayStash) && !hasDraftContent(incoming.dayStash)
      && incoming.date !== current!.dayStash.date) return 'lost_stash';
  return null;
}
export function parkedDraft(payload: Payload | null): Payload | null {
  return payload && hasDraftContent(payload.dayStash) ? payload.dayStash : null;
}

export function draftClearConflict(revision: number, base: unknown, managed: boolean, admin: boolean): boolean {
  return (base !== undefined && base !== revision) || (!admin && managed && base === undefined);
}
