import type { Employee } from "./api";

export type EmployeeRole = "бригадир" | "старший" | "робітник";

export function employeeRole(emp: Employee): EmployeeRole {
  const pos = (emp.position ?? "").toLowerCase();
  if (pos.includes("бригадир")) return "бригадир";
  if (pos.includes("старш")) return "старший";
  return "робітник";
}

// First letters of the first two words (e.g. "Агромаков Денис" -> "АД") for
// a quick-glance contact-list-style avatar instead of a generic person icon.
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function roleAccent(role: EmployeeRole): string {
  if (role === "бригадир") return "accent-orange";
  if (role === "старший") return "accent-purple";
  return "accent-blue";
}

// A brigade's display name is derived from a member whose position contains
// "бригадир" (there's no separate brigade-name column in the source data).
// `roster` must be the COMPLETE employee list, not the (often filtered) list
// being grouped: a picker that hides people already on the trip would
// otherwise hide that brigade's leader too, leaving the brigade labelled by
// its raw id (e.g. "BR_002") in that picker but by its real name elsewhere.
function brigadeTitleMap(roster: Employee[]): Map<string, string> {
  const titleById = new Map<string, string>();
  for (const e of roster) {
    const id = e.brigadeId?.trim();
    if (!id || titleById.has(id)) continue;
    if (employeeRole(e) === "бригадир" && e.position) {
      titleById.set(id, e.position.replace(/^бригадир\s*/i, "").trim() || e.position);
    }
  }
  return titleById;
}

export function groupByBrigade(employees: Employee[], roster: Employee[] = employees) {
  const NO_BRIGADE = "__NO_BRIGADE__";
  const titleById = brigadeTitleMap(roster);
  const map = new Map<string, Employee[]>();
  for (const e of employees) {
    const id = e.brigadeId?.trim() || NO_BRIGADE;
    const list = map.get(id) ?? [];
    list.push(e);
    map.set(id, list);
  }
  return [...map.entries()]
    .map(([id, members]) => {
      const title = id === NO_BRIGADE ? "Без бригади" : titleById.get(id) ?? id;
      return { id, title, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) };
    })
    .sort((a, b) => (a.id === NO_BRIGADE ? 1 : b.id === NO_BRIGADE ? -1 : a.title.localeCompare(b.title)));
}
