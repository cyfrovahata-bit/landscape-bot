/** Publish status and report cards together, only after a complete successful read. */
export async function fetchDayReports<S extends { hasSubmission: boolean }, T, C>(
  get: <R>(path: string) => Promise<R>, date: string,
): Promise<{ status: S; trips: T[]; combined: C | null }> {
  const status = await get<S>(`/api/road-timesheet/day-status?date=${date}`);
  if (!status.hasSubmission) return { status, trips: [], combined: null };
  const reports = await get<{ found: boolean; trips: T[]; combined: C | null }>(
    `/api/road-timesheet/submitted-today?date=${date}`,
  );
  // Historical RTS_SAVE events can remain after all trips were cancelled;
  // submitted-today then legitimately returns found:false and an empty list.
  if (!Array.isArray(reports.trips) || (reports.found && !reports.trips.length)) {
    throw new Error("Статус звіту отримано, але список звітів не завантажився. Повторіть завантаження.");
  }
  return { status, trips: reports.trips, combined: reports.combined };
}

export type ReportListLoad = { date: string; phase: "loading" | "ready" | "error"; error: string };

export async function fetchReturnedReports<T>(get: <R>(path: string) => Promise<R>): Promise<T[]> {
  const response = await get<{ days: T[] }>("/api/road-timesheet/returned-days");
  if (!Array.isArray(response.days)) throw new Error("Не вдалося отримати список повернених звітів.");
  return response.days;
}

/** An empty list is a fact only after the server confirmed it for this date. */
export function confirmedNoTrips(load: ReportListLoad, date: string, hasAnyTrips: boolean): boolean {
  return load.date === date && load.phase === "ready" && !hasAnyTrips;
}
