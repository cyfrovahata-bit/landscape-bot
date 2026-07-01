export function normalizeHeader(s: any) {
  return String(s ?? "")
    .replace(/^﻿/, "") // BOM
    .replace(/[​-‍⁠]/g, "") // zero-width
    .replace(/ /g, " ") // NBSP
    .replace(/\s+/g, " ")
    .trim();
}

export function norm(h: string) {
  return normalizeHeader(h);
}

export function toBool(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "так" || s === "yes";
}

export function parseNumber(v: any): number | null {
  const s = String(v ?? "").trim().replace(",", ".");
  if (s === "" || s === "?") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function sheetRef(sheetName: string) {
  const safe = sheetName.replace(/'/g, "''");
  return `'${safe}'`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function colToA1(colIndex: number) {
  let n = colIndex + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
