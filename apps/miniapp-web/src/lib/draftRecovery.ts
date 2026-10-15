/** Prefer the parked running day when the app died inside a returned report. */
export function recoverParkedDraft<T extends { dayStash?: unknown; fixingReturnedDate?: string | null; planEditing?: boolean }>(draft: T): T {
  const stash = draft.dayStash;
  if ((draft.fixingReturnedDate || draft.planEditing) && stash && typeof stash === 'object') {
    return { ...draft, ...stash, dayStash: null, fixingReturnedDate: null, planEditing: false,
      editingPlanId: null, planForemanTgId: null } as T;
  }
  return draft;
}
