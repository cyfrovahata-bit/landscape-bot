export const EMPTY_CAR_MESSAGE = "У машині нікого немає. Спочатку посадіть у машину тих, хто їде, включно з водієм, і потім починайте рух.";

export function carMovementError(onboard: readonly string[]): string | null {
  return onboard.length ? null : EMPTY_CAR_MESSAGE;
}

export const LAST_CAR_RIDER_MESSAGE = "Це неможливо: машина буде порожня. Поки поїздка в дорозі, у машині має залишатися хоча б одна людина, включно з водієм.";

/** Screen changes do not park the car; only its recorded location does. */
export function carRiderRemovalError(
  onboard: readonly string[], removing: readonly string[],
  trip: { tripStartedAt: string | null; carAtObjectId: string; odoEnd: string },
): string | null {
  if (!trip.tripStartedAt || trip.carAtObjectId || trip.odoEnd) return null;
  const removed = new Set(removing);
  if (!onboard.some(id => removed.has(id))) return null;
  return onboard.some(id => !removed.has(id)) ? null : LAST_CAR_RIDER_MESSAGE;
}

export function initialCarRiders(employeeIds: readonly string[], selfTransportIds: readonly string[]): string[] {
  const own = new Set(selfTransportIds);
  return employeeIds.filter(id => !own.has(id));
}

/** Explicit destinations include visited/no-work objects and never fall back. */
export function selectedDestination<T extends { objectId: string }>(plans: readonly T[], objectId: string): T | null {
  return plans.find(plan => plan.objectId === objectId) ?? null;
}
