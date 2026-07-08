import type {
  PayrollObjectPack,
  SalaryPack,
  SalaryRow,
} from "./roadTimesheet.types.js";

export function buildSalaryPacksWithRoles(params: {
  workTotalsByObject: any[];
  payrollPacks: PayrollObjectPack[];
  brigadierEmployeeIds: string[];
  seniorEmployeeIds: string[];
}): SalaryPack[] {
  const {
    workTotalsByObject,
    payrollPacks,
    brigadierEmployeeIds,
    seniorEmployeeIds,
  } = params;

  return workTotalsByObject.map((o) => {
    const pack = payrollPacks.find(
      (p: any) => String(p.objectId) === String(o.objectId),
    );

    const rowsSrc = ((pack?.rows ?? []) as any[]).filter(
      (r) => Number(r.hours ?? 0) > 0,
    );

    const objectTotal = Number(o.total ?? 0);

    const brigadierSet = new Set(brigadierEmployeeIds.map(String));
    const seniorSet = new Set(seniorEmployeeIds.map(String));

    const brigadierRows = rowsSrc.filter((r) =>
      brigadierSet.has(String(r.employeeId)),
    );

    const seniorRows = rowsSrc.filter((r) =>
      seniorSet.has(String(r.employeeId)),
    );

    const hasBrigadier = brigadierRows.length > 0;
    const hasSenior = seniorRows.length > 0;

    const workerPercent = hasBrigadier ? 0.7 : 0.9;
    const brigadierPercent = hasBrigadier ? 0.2 : 0;
   const seniorPercent = hasSenior ? 0.1 : 0;

    const workerRows = rowsSrc.filter((r) => {
      const id = String(r.employeeId);

      if (hasBrigadier && brigadierSet.has(id)) return false;
      if (hasSenior && seniorSet.has(id)) return false;

      return true;
    });

    const brigadierOnePay =
      brigadierRows.length > 0
        ? (objectTotal * brigadierPercent) / brigadierRows.length
        : 0;

    const seniorOnePay =
      seniorRows.length > 0
        ? (objectTotal * seniorPercent) / seniorRows.length
        : 0;

    // Everyone did the same work at the object -- the worker share splits
    // EVENLY across every worker who worked there, regardless of hours or
    // discipline/productivity coefficients (still entered per person for
    // record, but no longer weight anyone's share).
    const workerOnePay =
      workerRows.length > 0 ? (objectTotal * workerPercent) / workerRows.length : 0;

    const rows: SalaryRow[] = rowsSrc.map((r) => {
      const id = String(r.employeeId ?? "");
      const points = Number(r.points ?? 0);

      let pay = 0;

      if (hasBrigadier && brigadierSet.has(id)) {
        pay = brigadierOnePay;
      } else if (hasSenior && seniorSet.has(id)) {
        pay = seniorOnePay;
      } else {
        pay = workerOnePay;
      }

      return {
        employeeId: id,
        employeeName: String(r.employeeName ?? ""),
        hours: Number(r.hours ?? 0),
        points,
        pay: Math.round(pay * 100) / 100,
      };
    });
 
    return {
      objectId: String(o.objectId),
      objectName: String(o.objectName),
      objectTotal: Math.round(objectTotal * 100) / 100,
      sumPoints:
        Math.round(
          rowsSrc.reduce((a, r) => a + Number(r.points ?? 0), 0) * 100,
        ) / 100,
      rows: rows.filter((r) => (r.hours ?? 0) > 0 || (r.pay ?? 0) > 0),
    };
  });
}
