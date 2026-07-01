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

export const NO_BRIGADE_ID = "__NO_BRIGADE__";

export type PeopleBrigadeGroup = {
  id: string;
  title: string;
  employees: NonNullable<State["employees"]>;
};

function employeeBrigadeId(e: NonNullable<State["employees"]>[number]) {
  const brigadeId = String((e as any).brigadeId ?? "").trim();
  return brigadeId || NO_BRIGADE_ID;
}

function brigadeTitleFromPosition(position?: string) {
  const raw = String(position ?? "").trim();
  if (!raw.toLowerCase().startsWith("бригадир")) return "";

  const title = raw.replace(/^бригадир\s*/i, "").trim();
  return title || raw;
}

export function getPeopleBrigadeTitle(st: State, brigadeId: string) {
  if (brigadeId === NO_BRIGADE_ID) return "Без бригади";

  const leader = (st.employees ?? []).find((e: any) => {
    if (employeeBrigadeId(e) !== brigadeId) return false;
    return String(e.position ?? "").trim().toLowerCase().startsWith("бригадир");
  });

  return brigadeTitleFromPosition((leader as any)?.position) || brigadeId;
}

export function getPeopleBrigadeGroups(st: State): PeopleBrigadeGroup[] {
  const map = new Map<string, NonNullable<State["employees"]>>();

  for (const e of st.employees ?? []) {
    const id = employeeBrigadeId(e);
    const rows = map.get(id) ?? [];
    rows.push(e);
    map.set(id, rows);
  }

  return [...map.entries()]
    .map(([id, employees]) => ({
      id,
      title: getPeopleBrigadeTitle(st, id),
      employees: employees.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => {
      if (a.id === NO_BRIGADE_ID) return 1;
      if (b.id === NO_BRIGADE_ID) return -1;
      return a.title.localeCompare(b.title);
    });
}

export const NO_OBJECT_ADDRESS = "__NO_ADDRESS__";

export type ObjectAddressGroup = {
  id: string;
  title: string;
  objects: NonNullable<State["objectsMeta"]>;
};

function objectAddressId(o: NonNullable<State["objectsMeta"]>[number]) {
  const address = String((o as any).address ?? "").trim();
  return address || NO_OBJECT_ADDRESS;
}

export function getObjectAddressGroups(st: State): ObjectAddressGroup[] {
  const map = new Map<string, NonNullable<State["objectsMeta"]>>();

  for (const o of st.objectsMeta ?? []) {
    const id = objectAddressId(o);
    const rows = map.get(id) ?? [];
    rows.push(o);
    map.set(id, rows);
  }

  return [...map.entries()]
    .map(([id, objects]) => ({
      id,
      title: id === NO_OBJECT_ADDRESS ? "Без адреси" : id,
      objects: objects.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => {
      if (a.id === NO_OBJECT_ADDRESS) return 1;
      if (b.id === NO_OBJECT_ADDRESS) return -1;
      return a.title.localeCompare(b.title);
    });
}
