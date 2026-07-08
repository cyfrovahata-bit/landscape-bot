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

export function groupByBrigade(employees: Employee[]) {
  const NO_BRIGADE = "__NO_BRIGADE__";
  const map = new Map<string, Employee[]>();
  for (const e of employees) {
    const id = e.brigadeId?.trim() || NO_BRIGADE;
    const list = map.get(id) ?? [];
    list.push(e);
    map.set(id, list);
  }
  return [...map.entries()]
    .map(([id, members]) => {
      const leader = members.find((e) => employeeRole(e) === "бригадир");
      const title = id === NO_BRIGADE ? "Без бригади" : leader ? leader.position!.replace(/^бригадир\s*/i, "").trim() || leader.position! : id;
      return { id, title, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) };
    })
    .sort((a, b) => (a.id === NO_BRIGADE ? 1 : b.id === NO_BRIGADE ? -1 : a.title.localeCompare(b.title)));
}
