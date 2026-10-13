export const EMPTY_CAR_MESSAGE = "У машині нікого немає. Спочатку посадіть у машину тих, хто їде, включно з водієм, і потім починайте рух.";

export function carMovementError(onboard: readonly string[]): string | null {
  return onboard.length ? null : EMPTY_CAR_MESSAGE;
}

export function initialCarRiders(employeeIds: readonly string[], selfTransportIds: readonly string[]): string[] {
  const own = new Set(selfTransportIds);
  return employeeIds.filter(id => !own.has(id));
}

/** Explicit destinations include visited/no-work objects and never fall back. */
export function selectedDestination<T extends { objectId: string }>(plans: readonly T[], objectId: string): T | null {
  return plans.find(plan => plan.objectId === objectId) ?? null;
}
