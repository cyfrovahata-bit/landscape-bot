import { splitMoneyByShares } from './accountingRows.js';

export type PayrollVersion = 1 | 2;
export const CREW_SENIOR_SHARE_FROM = '2026-11-12';
/** Missing versions belong to the original formula. Keep one formula for
 * the whole day, including later legs, edits, approval and accounting. */
export function payrollVersionForDay(date: string, savedVersions: Array<number | undefined> = []): PayrollVersion {
  if (savedVersions.length) return savedVersions.every(v => v === 2) ? 2 : 1;
  return date >= CREW_SENIOR_SHARE_FROM ? 2 : 1;
}

// Mirrors apps/bot/src/bot/flows/roadTimesheet.payroll.ts + the role/points
// logic in roadTimesheet.flow.ts / roadTimesheet.utils.ts, exactly.

export function isBrigadierPosition(position: string | null | undefined, active: boolean) {
  return active && String(position ?? "").toLowerCase().includes("бригадир");
}

export function isSeniorPosition(position: string | null | undefined) {
  return String(position ?? "").toLowerCase().includes("старш");
}

/**
 * Every active brigadier riding on the trip. Two brigadiers on one trip split
 * the 20% between them, the same way seniors split their 10% -- the cut pays
 * for running the day, and a day run by two people is not worth 40%.
 */
export function pickBrigadiersFromRiders(
  riderIds: string[],
  employeeById: Map<string, { position: string | null; active: boolean }>,
): string[] {
  return riderIds.filter((id) => {
    const e = employeeById.get(id);
    return !!e && isBrigadierPosition(e.position, e.active);
  });
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

/**
 * Below this many hours at an object a session is not paid work.
 *
 * Hours decide the amounts now, so a mis-tap that opens and closes a timer a
 * second later used to draw a slice of the crew pot. 0.1 h = 6 minutes: long
 * enough that nobody reaches it by accident, short enough for a real "drove
 * up, tied a tree, left" call. The person still appears in the report with
 * their real time and 0 pay -- silently dropping them would hide the mistake
 * that needs fixing (🕒 Ввести години вручну).
 *
 * The role cuts are untouched: a brigadier is owed 20% for running the day
 * whether or not they touched a spade, which is what a zero-hour row is for.
 */
export const MIN_PAID_HOURS = 0.1;

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
 * Per-object payroll split. The trip's brigadiers split 20% of every object's
 * fund between them and the seniors split 10% of it, whether or not they
 * worked at that particular object -- those cuts pay for running the day. The remainder
 * (always 70%) is the crew share,
 * shared out between everyone with hours there, the brigadier and seniors
 * included: if they worked, they worked. In version 1, an absent senior's
 * 10% stays with the company. Version 2 distributes that additional pot
 * by hours to non-brigadier workers; without eligible workers it stays
 * with the company. The original 70% and role cuts are unchanged.
 *
 * The worker remainder is split IN PROPORTION TO HOURS: two hours on an
 * object pay twice what one hour there does, and anything under MIN_PAID_HOURS
 * counts as no work at all. Works that name specific people
 * form their own pool each (also split by hours between them), so a job one
 * person did alone pays only that person -- and that person is then OUT of
 * the shared pool, which belongs to the crew that did the rest. Everything
 * unassigned stays one pool for whoever is left. The discipline/productivity
 * coefficients are recorded per person but move no money.
 */
export function buildSalaryPacksWithRoles(params: {
  objects: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    // Each work's own money value (volume * tariff) and who it was assigned
    // to. A work with nobody assigned is shared by the whole crew at the
    // object, which is the normal case. Omit the array entirely and the
    // object behaves as one shared pool, exactly as before this existed.
    works?: Array<{ workId: string; value: number; employeeIds?: string[] }>;
    rows: Array<{ employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number }>;
  }>;
  /** Every brigadier on the trip -- they split the 20% between them. */
  brigadierEmployeeIds: string[];
  seniorEmployeeIds: string[];
  /** Version 1 is retained for saved reports. Version 2 gives an absent
   * senior's 10% to paid workers, or to a sole working brigadier. */
  payrollVersion?: PayrollVersion;
}): ObjectSalaryPack[] {
  const { objects, brigadierEmployeeIds, seniorEmployeeIds, payrollVersion = 1 } = params;
  const brigadierSet = new Set(brigadierEmployeeIds.filter(Boolean).map(String));
  const seniorSet = new Set(seniorEmployeeIds.map(String));

  return objects.map((o) => {
    const all = o.rows.map((r) => {
      const hoursRounded = roundToQuarterHours(r.hours);
      const coefTotal = Number(r.disciplineCoef) * Number(r.productivityCoef);
      return { ...r, hoursRounded, coefTotal, points: Math.round(hoursRounded * coefTotal * 100) / 100 };
    });
    // Hours decide both who draws on the crew share and how much of it they
    // draw; the role cuts do not depend on them. A brigadier runs the day whether or not they picked up a spade at
    // this particular object, so their 20% is owed either way -- the caller
    // therefore passes a zero-hour row for them (and for the seniors) on every
    // object, and that row is what makes hasBrigadier/hasSenior true here.
    //
    // MIN_PAID_HOURS, not "> 0": a timer opened and closed by accident is not
    // work, and since the crew share is proportional it would otherwise take a
    // (small) cut off everyone who actually worked.
    const worked = all.filter((r) => r.hours >= MIN_PAID_HOURS);

    const isBrigadier = (id: string) => brigadierSet.has(id);
    const isSenior = (id: string) => seniorSet.has(id);

    const brigadierRows = all.filter((r) => isBrigadier(r.employeeId));
    const seniorRows = all.filter((r) => isSenior(r.employeeId));
    const hasBrigadier = brigadierRows.length > 0;
    const hasSenior = seniorRows.length > 0;

    // The crew share, and on top of it the role cuts. A brigadier or senior
    // who DID work also draws on the crew pot for the hours they put in --
    // they worked alongside everyone else, and the 20%/10% pays for running
    // the day, not for the work itself.
    // Always 70%. The 20% belongs to whoever ran the day, and the caller is
    // expected to name them -- the brigadier who rode along, or failing that
    // the foreman who filled the day in. It falls to the company only when
    // there is nobody to attribute it to at all; it never quietly enlarges the
    // crew's share, which is what "90% when no brigadier" used to do.
    const workerPercent = 0.7;
    // 20% for the day, not 20% each: two brigadiers on one trip halve it, the
    // same rule the seniors have always had for their 10%.
    const brigadierBonusEach = hasBrigadier ? (o.objectTotal * 0.2) / brigadierRows.length : 0;
    const seniorBonusEach = hasSenior ? (o.objectTotal * 0.1) / seniorRows.length : 0;
    const workersWithoutBrigadiers = worked.filter(r => !isBrigadier(r.employeeId));
    const extraWorkers = workersWithoutBrigadiers.length > 0
      ? workersWithoutBrigadiers
      : worked.length === 1 && isBrigadier(worked[0].employeeId) ? worked : [];
    const redistributeSeniorShare = payrollVersion === 2 && !hasSenior && extraWorkers.length > 0;
    const companyPercent = (hasBrigadier ? 0 : 0.2) + (hasSenior || redistributeSeniorShare ? 0 : 0.1);
    const extraPayByEmployee = new Map<string, number>();
    if (redistributeSeniorShare) {
      const amounts = splitMoneyByShares(o.objectTotal * 0.1, extraWorkers.map(r => r.hours));
      extraWorkers.forEach((r,i) => extraPayByEmployee.set(r.employeeId, amounts[i]));
    }

    // Works assigned to specific people get their own pool each, split only
    // between those of them who were actually at the object; everything else
    // stays in one shared pool for the crew that did it. "One person drove
    // out, watered the lawn and left" is the case this exists for -- and that
    // person is paid for the watering, not for the crew's day as well.
    //
    // An assignment naming nobody who was there is treated as unassigned
    // rather than dropped -- otherwise that work's money would silently
    // vanish from the object.
    const dedicated: Array<{ value: number; workers: typeof worked }> = [];
    for (const w of o.works ?? []) {
      const assigned = new Set(w.employeeIds ?? []);
      if (!assigned.size) continue;
      const workers = worked.filter((r) => assigned.has(r.employeeId));
      if (!workers.length) continue;
      dedicated.push({ value: Number(w.value) || 0, workers });
    }
    // Derived by subtraction, not by summing the unassigned works, so the
    // buckets always add back up to objectTotal even if a caller's work
    // values don't quite sum to the total it passed.
    const sharedValue = Math.max(0, o.objectTotal - dedicated.reduce((a, d) => a + d.value, 0));

    // Someone named on a work is paid for that work and nothing else out of
    // the crew pot: the shared share is for the crew that did the rest.
    const dedicatedIds = new Set<string>();
    for (const d of dedicated) for (const w of d.workers) dedicatedIds.add(w.employeeId);

    // ...unless that would leave nobody holding the unassigned works. Money
    // must never vanish from an object, so when every worker present has a
    // named work, the remainder falls back to all of them.
    const sharedWorkers = worked.filter((r) => !dedicatedIds.has(r.employeeId));
    const sharedPool = sharedWorkers.length ? sharedWorkers : worked;

    // Every pot below is divided by hours, not per head. Everyone in a pot is
    // there because they have hours at the object, so the denominator is
    // always > 0; the per-head fallback only guards against a caller that
    // somehow passes an hours-less row into a pot.
    const splitByHours = (pot: number, pool: typeof worked, into: Map<string, number>) => {
      const totalHours = pool.reduce((a, r) => a + Number(r.hours || 0), 0);
      for (const r of pool) {
        const share = totalHours > 0 ? Number(r.hours || 0) / totalHours : 1 / pool.length;
        into.set(r.employeeId, (into.get(r.employeeId) ?? 0) + pot * share);
      }
    };

    const crewPayByEmployee = new Map<string, number>();
    if (sharedPool.length) splitByHours(sharedValue * workerPercent, sharedPool, crewPayByEmployee);
    for (const d of dedicated) splitByHours(d.value * workerPercent, d.workers, crewPayByEmployee);

    const rows: SalaryRow[] = all.map((r) => {
      const crewShare = crewPayByEmployee.get(r.employeeId) ?? 0;
      const roleBonus = (isBrigadier(r.employeeId) ? brigadierBonusEach : 0) + (isSenior(r.employeeId) ? seniorBonusEach : 0);
      return {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        // Four decimals, not two: a session of a few seconds is still work
        // that draws on the crew pot, and rounding it to 0.00 made the report
        // say "0 год" next to a payout the crew split had actually earned.
        hours: Math.round(Number(r.hours || 0) * 10000) / 10000,
        coefTotal: r.coefTotal,
        points: r.points,
        pay: (Math.round((crewShare + roleBonus) * 100) + Math.round((extraPayByEmployee.get(r.employeeId) ?? 0) * 100)) / 100,
      };
    });

    return {
      objectId: o.objectId,
      objectName: o.objectName,
      objectTotal: Math.round(o.objectTotal * 100) / 100,
      sumPoints: Math.round(worked.reduce((a, r) => a + r.points, 0) * 100) / 100,
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
