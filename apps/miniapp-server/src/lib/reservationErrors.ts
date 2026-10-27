import type { ErrorRequestHandler } from 'express';

export class ReservationConflictError extends Error {}

export function activeTripConflictMessage(date: unknown, today: string): string {
  const valid = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const label = valid ? ` за ${date.slice(8,10)}.${date.slice(5,7)}.${date.slice(0,4)}` : '';
  const action = valid && date < today
    ? 'Попросіть адміністратора архівувати стару поїздку, потім повторіть збереження.'
    : 'Відкрийте її у списку поїздок і завершіть або зверніться до адміністратора.';
  return `Збереження заблоковано: у вас є інша активна поїздка${label}. ${action} Вибрані люди залишаються у чернетці.`;
}

export const reservationConflictHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof ReservationConflictError)) { next(error); return; }
  res.status(409).json({error:error.message});
};
