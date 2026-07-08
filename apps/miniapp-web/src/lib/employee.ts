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
