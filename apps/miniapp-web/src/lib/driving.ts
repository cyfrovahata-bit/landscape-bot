export const EMPTY_CAR_MESSAGE = "У машині нікого немає. Спочатку посадіть у машину тих, хто їде, включно з водієм, і потім починайте рух.";

export function carMovementError(onboard: readonly string[]): string | null {
  return onboard.length ? null : EMPTY_CAR_MESSAGE;
}

export function initialCarRiders(employeeIds: readonly string[], selfTransportIds: readonly string[]): string[] {
  const own = new Set(selfTransportIds);
  return employeeIds.filter(id => !own.has(id));
}
