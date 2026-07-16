// Mirrors apps/bot/src/bot/flows/roadTimesheet.payroll.ts + the role/points
// logic in roadTimesheet.flow.ts / roadTimesheet.utils.ts, exactly.

export function isBrigadierPosition(position: string | null | undefined, active: boolean) {
  return active && String(position ?? "").toLowerCase().includes("бригадир");
}

export function isSeniorPosition(position: string | null | undefined) {
  return String(position ?? "").toLowerCase().includes("старш");
}

/** Only one brigadier per trip: the first rider (in the given order) who is an active brigadier. */
export function pickBrigadierFromRiders(
  riderIds: string[],
  employeeById: Map<string, { position: string | null; active: boolean }>,
): string {
  for (const id of riderIds) {
    const e = employeeById.get(id);
    if (e && isBrigadierPosition(e.position, e.active)) return id;
  }
  return "";
}

export function pickSeniorsFromRiders(
  riderIds: string[],
  employeeById: Map<string, { position: string | null }>,
): string[] {
  return riderIds.filter((id) => isSeniorPosition(employeeById.get(id)?.position));
}

// The bot's roundToQuarterHours is currently hard-disabled (returns 1 for any
// input > 0) -- the real "hours * 4 rounded" formula is commented out in
// production. We mirror the ACTUAL deployed behavior, not the commented-out
// one: every employee who did any work at an object counts as exactly 1
// "hour unit" for points purposes, regardless of real time spent. This is a
// known quirk of the bot, not a bug we're introducing here.
export function roundToQuarterHours(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return 1;
}

export type SalaryRow = {
  employeeId: string;
  employeeName: string;
  hours: number;
  coefTotal: number;
  points: number;
  pay: number;
};

export type ObjectSalaryPack = {
  objectId: string;
  objectName: string;
  objectTotal: number;
  sumPoints: number;
  companyPay: number;
  rows: SalaryRow[];
};

/**
 * Per-object payroll split: 1 brigadier (if present among that object's
 * workers) gets 20% split among brigadier rows (practically always just
 * one), seniors split 10%, and the remainder (70%, or 90% if no brigadier
 * worked at this object) is split among the workers PROPORTIONALLY TO THE
 * HOURS each actually worked at this object -- someone who put in 10h earns
 * more than someone who put in 4h (share = own hours / total worker hours ×
 * worker pool). The discipline/productivity coefficients stay entered per
 * person for the record but don't weight the split. If nobody senior worked
 * there, that 10% isn't handed to workers instead -- it stays with the
 * company (companyPay), exactly like the bot's roleTotals.company.
 */
export function buildSalaryPacksWithRoles(params: {
  objects: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    rows: Array<{ employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number }>;
  }>;
  brigadierEmployeeId: string;
  seniorEmployeeIds: string[];
}): ObjectSalaryPack[] {
  const { objects, brigadierEmployeeId, seniorEmployeeIds } = params;
  const seniorSet = new Set(seniorEmployeeIds.map(String));

  return objects.map((o) => {
    const rowsSrc = o.rows
      .filter((r) => r.hours > 0)
      .map((r) => {
        const hoursRounded = roundToQuarterHours(r.hours);
        const coefTotal = Number(r.disciplineCoef) * Number(r.productivityCoef);
        return { ...r, hoursRounded, coefTotal, points: Math.round(hoursRounded * coefTotal * 100) / 100 };
      });

    const brigadierRows = rowsSrc.filter((r) => brigadierEmployeeId && r.employeeId === brigadierEmployeeId);
    const seniorRows = rowsSrc.filter((r) => seniorSet.has(r.employeeId));
    const hasBrigadier = brigadierRows.length > 0;
    const hasSenior = seniorRows.length > 0;

    const workerPercent = hasBrigadier ? 0.7 : 0.9;
    const brigadierPercent = hasBrigadier ? 0.2 : 0;
    const seniorPercent = hasSenior ? 0.1 : 0;
    const companyPercent = hasSenior ? 0 : 0.1;

    const workerRows = rowsSrc.filter((r) => {
      if (hasBrigadier && r.employeeId === brigadierEmployeeId) return false;
      if (hasSenior && seniorSet.has(r.employeeId)) return false;
      return true;
    });

    const brigadierOnePay = brigadierRows.length ? (o.objectTotal * brigadierPercent) / brigadierRows.length : 0;
    const seniorOnePay = seniorRows.length ? (o.objectTotal * seniorPercent) / seniorRows.length : 0;
    // The worker share (70%/90% of the object's total, after the brigadier/
    // senior cuts above) is split PROPORTIONALLY to the real hours each
    // worker put in at this object. Coefficients are kept per person for the
    // record but don't weight the split. Fallback to an even split only if
    // no hours were recorded at all (so nobody's pay silently vanishes).
    const workerPool = o.objectTotal * workerPercent;
    const totalWorkerHours = workerRows.reduce((a, r) => a + Number(r.hours || 0), 0);

    const rows: SalaryRow[] = rowsSrc.map((r) => {
      let pay = 0;
      if (hasBrigadier && r.employeeId === brigadierEmployeeId) pay = brigadierOnePay;
      else if (hasSenior && seniorSet.has(r.employeeId)) pay = seniorOnePay;
      else if (totalWorkerHours > 0) pay = workerPool * (Number(r.hours || 0) / totalWorkerHours);
      else if (workerRows.length) pay = workerPool / workerRows.length;

      return {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        hours: Math.round(Number(r.hours || 0) * 100) / 100,
        coefTotal: r.coefTotal,
        points: r.points,
        pay: Math.round(pay * 100) / 100,
      };
    });

    return {
      objectId: o.objectId,
      objectName: o.objectName,
      objectTotal: Math.round(o.objectTotal * 100) / 100,
      sumPoints: Math.round(rowsSrc.reduce((a, r) => a + r.points, 0) * 100) / 100,
      companyPay: Math.round(o.objectTotal * companyPercent * 100) / 100,
      rows: rows.filter((r) => r.hours > 0 || r.pay > 0),
    };
  });
}

export const DEFAULT_ROAD_ALLOWANCE_BY_CLASS: Record<"S" | "M" | "L" | "XL", number> = {
  S: 50,
  M: 100,
  L: 150,
  XL: 200,
};
