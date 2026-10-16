/** Permit late completion only with contemporaneous server-side evidence. */
export function canFinishRecordedTrip(
  date: string, carId: string,
  lifecycle: Array<{ type: string; carId: string | null; ts: Date }>,
  progress: Array<{ state: string; updatedAt: Date }>,
): boolean {
  const day = (t: Date) => t.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const ordered = [...lifecycle].sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const reserve = ordered.find(e => e.type === "RTS_RESERVE_CAR" && e.carId === carId);
  if (!reserve || day(reserve.ts) !== date) return false;
  // A submitted/cancelled trip cannot be submitted again as a new trip.
  if (ordered.some(e => (e.type === "RTS_SAVE" || e.type === "RTS_RESERVE_CANCEL")
    && e.ts >= reserve.ts && (!e.carId || e.carId === carId))) return false;
  return progress.some(p => ["DRIVING", "AT_OBJECT", "WORKING", "RETURNING"].includes(p.state)
    && p.updatedAt >= reserve.ts && day(p.updatedAt) === date);
}
