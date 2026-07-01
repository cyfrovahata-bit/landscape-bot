// src/bot/flows/roadTimesheet.sheets.ts
import { loadSheet, getCell, requireHeaders } from "../../google/sheets/core.js";
import { SHEET_NAMES } from "../../google/sheets/names.js";

export async function isBrigadier(employeeId: string): Promise<boolean> {
  const sh = await loadSheet(SHEET_NAMES.employees); // ПРАЦІВНИКИ

  requireHeaders(sh.map, ["ID", "ПОСАДА", "АКТИВ"], SHEET_NAMES.employees);

  for (const r of sh.data) {
    const id = String(getCell(r, sh.map, "ID") ?? "").trim();
    if (id !== employeeId) continue;

    const activeRaw = String(getCell(r, sh.map, "АКТИВ") ?? "").trim().toUpperCase();
    const isActive = activeRaw === "" || activeRaw === "TRUE" || activeRaw === "1" || activeRaw === "YES";

    const pos = String(getCell(r, sh.map, "ПОСАДА") ?? "").toLowerCase();
    return isActive && pos.includes("бригадир");
  }

  return false;
}