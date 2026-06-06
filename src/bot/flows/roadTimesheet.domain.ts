import type { State } from "./roadTimesheet.types.js";
import { ensureObjectState, uniq } from "./roadTimesheet.utils.js";

export function isLocked(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}

export function workCategoryOf(w: any) {
  return String(
    w.category ??
      w.CATEGORY ??
      w["Категорія"] ??
      w["КАТЕГОРІЯ"] ??
      w["Категория"] ??
      w["КАТЕГОРИЯ"] ??
      "Без категорії",
  ).trim();
}

export function getActiveWorks(st: State) {
  return (st.worksMeta ?? []).filter(
    (w: any) => String(w.active ?? "TRUE").toUpperCase() !== "FALSE",
  );
}
 
export function getWorkCategories(st: State) {
  return uniq(getActiveWorks(st).map(workCategoryOf).filter(Boolean)).sort(
    (a, b) => a.localeCompare(b),
  );
}

export function buildSelectedCategoriesText(st: State, oid: string) {
  const obj = ensureObjectState(st, oid);
  const picked = new Set(obj.works.map((w) => String(w.workId)));

  const lines = getWorkCategories(st)
    .map((cat) => {
      const works = getActiveWorks(st).filter((w) => workCategoryOf(w) === cat);
      const selected = works.filter((w) => picked.has(String(w.id))).length;
      return selected > 0 ? `✅ ${cat}: ${selected}/${works.length}` : "";
    })
    .filter(Boolean);

  return lines.length ? lines.join("\n") : "—";
}
