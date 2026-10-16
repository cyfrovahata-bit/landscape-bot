/** Prefer the parked running day when the app died inside a returned report. */
export function recoverParkedDraft<T extends { dayStash?: unknown; fixingReturnedDate?: string | null; planEditing?: boolean }>(draft: T): T {
  const stash = draft.dayStash;
  if ((draft.fixingReturnedDate || draft.planEditing) && stash && typeof stash === 'object') {
    return { ...draft, ...stash, dayStash: null, fixingReturnedDate: null, planEditing: false,
      editingPlanId: null, planForemanTgId: null } as T;
  }
  return draft;
}

/** An unfinished trip does not expire merely because the app stayed closed. */
export function shouldRestoreDraft(savedAt: number, data: unknown, now: number): boolean {
  const d = data as Record<string, unknown> | null;
  const meaningful = d && (d.carId || d.tripStartedAt || d.dayStash
    || (Array.isArray(d.plans) && d.plans.length) || (Array.isArray(d.employeeIds) && d.employeeIds.length));
  return !!meaningful || now - savedAt <= 20 * 60 * 60 * 1000;
}
