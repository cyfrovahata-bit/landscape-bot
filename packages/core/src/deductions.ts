import { splitMoneyByShares } from './accountingRows.js';
export type Deduction = { id: string; reason: string; amount: number };
export type DeductionGroup = { approved?: boolean; eventIds: string[]; employeeIds: string[]; items: Deduction[]; sourceRevision: string };
export type DeductionDocument = { revision: number; groups: DeductionGroup[] };
export function validateDeductions(value: unknown): Deduction[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Дозволено не більше 50 відрахувань.');
  if (value.reduce((n,v) => n + String(v?.reason ?? "").replace(/([_*[\]`])/g, "\\$1").length + 80, 0) > 2000) throw new Error("Скоротіть причини: блок відрахувань має вміститися у повідомлення Telegram.");
  const ids = new Set<string>();
  return value.map(v => {
    if (!v || typeof v.id !== 'string' || !/^[\w-]{1,80}$/.test(v.id) || ids.has(v.id)) throw new Error('Некоректний ідентифікатор відрахування.');
    ids.add(v.id);
    if (typeof v.reason !== 'string' || !v.reason.trim() || v.reason.trim().length > 300) throw new Error('Вкажіть причину відрахування (до 300 символів).');
    if (typeof v.amount !== 'number' || !Number.isFinite(v.amount) || v.amount <= 0 || v.amount > 10000000 || Math.abs(v.amount * 100 - Math.round(v.amount * 100)) > 0.000001) throw new Error('Вкажіть додатну суму з точністю до копійки.');
    return { id: v.id, reason: v.reason.trim(), amount: v.amount };
  });
}
type Pack = { objectId: string; objectTotal: number; rows: { employeeId: string; employeeName: string; pay: number }[] };
/** Pure, no mutation: equal per-person cuts, then distribute each cut over that person's objects. */
export function applyDeductions<T extends Pack>(packs: T[], participantIds: string[], items: Deduction[]) {
  const employeeIds = [...new Set(participantIds)].sort();
  const totalCents = items.reduce((s,d) => s + Math.round(d.amount * 100), 0);
  if (totalCents && !employeeIds.length) throw new Error('У звіті немає учасників для відрахування.');
  const cuts = new Map(employeeIds.map(id => [id, 0]));
  // Allocate each reason separately so its shares and the total always reconcile to the kopeck.
  const shares = items.map(item => ({ ...item, employees: employeeIds.map((employeeId,i) => ({ employeeId, amount: splitMoneyByShares(item.amount, employeeIds.map(() => 1))[i] })) }));
  shares.forEach(d => d.employees.forEach(s => cuts.set(s.employeeId, cuts.get(s.employeeId)! + Math.round(s.amount * 100))));
  const result = packs.map(p => ({ ...p, rows: p.rows.map(r => ({ ...r })) })) as T[];
  for (const id of employeeIds) {
    const cut = cuts.get(id)!;
    if (!cut) continue;
    const rows = result.flatMap((p, pi) => p.rows.filter(r => r.employeeId === id).map(r => ({ r, pi })));
    const gross = rows.reduce((s,x) => s + Math.round(x.r.pay * 100), 0);
    if (cut > gross) throw new Error(`Відрахування для ${rows[0]?.r.employeeName ?? id} перевищує нарахування за роботи. Зменште суму.`);
    const allocations = splitMoneyByShares(cut / 100, rows.map(x => Math.round(x.r.pay * 100)));
    rows.forEach((x,i) => { x.r.pay = (Math.round(x.r.pay * 100) - Math.round(allocations[i] * 100)) / 100; result[x.pi].objectTotal = (Math.round(result[x.pi].objectTotal * 100) - Math.round(allocations[i] * 100)) / 100; });
  }
  return { salaryPacks: result, deductions: { items, total: totalCents / 100, perEmployee: employeeIds.map(employeeId => ({ employeeId, amount: cuts.get(employeeId)! / 100 })), shares } };
}
export function deductionGroupsForTrips(doc: DeductionDocument, ids: string[]) {
  const set = new Set(ids);
  return doc.groups.filter(g => g.eventIds.length && g.eventIds.every(id => set.has(id)));
}
