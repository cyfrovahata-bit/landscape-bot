// src/bot/flows/roadTimesheet.normalizers.ts
import type { DictWork } from "./roadTimesheet.types.js";

export function normWorksFull(raw: any[]): DictWork[] {
  return (raw ?? [])
    .map((w: any) => {
      const id = String(w.id ?? w.ID ?? w.workId ?? w["ID"] ?? "").trim();
      const name = String(w.name ?? w.NAME ?? w.title ?? w["НАЗВА"] ?? w["НАЗВАНИЕ"] ?? "").trim();
      const unit = String(w.unit ?? w.UNIT ?? w["ОДИНИЦЯ"] ?? w["ЕДИНИЦА"] ?? "").trim();

      const rateRaw =
        w.rate ??
        w.RATE ??
        w.tariff ?? // ✅ ось це
        w.TARIFF ??
        w["СТАВКА"] ??
        w["ТАРИФ"] ??
        w["TARIFF"];

      const rate = Number(String(rateRaw ?? "").replace(",", "."));

      const activeRaw = String(w.active ?? w.ACTIVE ?? w["АКТИВ"] ?? "TRUE").trim().toUpperCase();
      const active = activeRaw === "" || activeRaw === "TRUE" || activeRaw === "1" || activeRaw === "YES";

      return {
        id,
        name: name || id,
        unit: unit || "од.",
        rate: Number.isFinite(rate) ? rate : 0,
        active,
      };
    })
    .filter((x) => x.id);
}