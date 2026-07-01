// src/bot/flows/roadTimesheet.format.ts

export function escMdV2(s: any) {
  return String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function mdv2(s: any) {
  return escMdV2(s);
}

export function escHtml(s: any) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function fmtMoney(n: any) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

export function fmtHhMm(secAny: any) {
  const sec = Number(secAny ?? 0);
  if (!Number.isFinite(sec) || sec <= 0) return "0г 0хв";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}г ${m}хв`;
}

export function csvToIds(csv: string): string[] {
  return String(csv ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}