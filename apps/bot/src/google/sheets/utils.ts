export function normalizeHeader(s: any) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "") // BOM
    .replace(/[\u200B-\u200D\u2060]/g, "") // zero-width
    .replace(/\u00A0/g, " ") // NBSP
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

export function parseNumber(v: any) {
  const s = String(v ?? "").trim().replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function nowISO() {
  return new Date().toISOString();
}

export function sheetRef(sheetName: string) {
  const safe = sheetName.replace(/'/g, "''");
  return `'${safe}'`;
}

export function colToA1(colIndex: number) {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let n = colIndex + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function makeEventId(prefix = "POD") {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rnd}`;
}

export type TripClass = "S" | "M" | "L" | "XL";

export const TRIP_CLASS_THRESHOLDS_KM = {
  S_MAX: 20,
  M_MAX: 50,
  L_MAX: 100,
} as const;

// S: (0..S_MAX], M: (S_MAX..M_MAX], L: (M_MAX..L_MAX], XL: > L_MAX
export function classifyTripByKm(km: number): TripClass {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return "S";

  if (n <= TRIP_CLASS_THRESHOLDS_KM.S_MAX) return "S";
  if (n <= TRIP_CLASS_THRESHOLDS_KM.M_MAX) return "M";
  if (n <= TRIP_CLASS_THRESHOLDS_KM.L_MAX) return "L";
  return "XL";
}

