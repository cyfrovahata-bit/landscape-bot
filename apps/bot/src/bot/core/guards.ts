import type { Session } from "./flowTypes.js";

export function requireAdmin(s: Session) {
  if (s.userRole !== "ADMIN") throw new Error("FORBIDDEN_ADMIN_ONLY");
}

// адмін може все, тому пропускаємо
export function requireBrigadier(s: Session) {
  if (s.userRole !== "BRIGADIER" && s.userRole !== "ADMIN") {
    throw new Error("FORBIDDEN_BRIGADIER_ONLY");
  }
}

export function isAdmin(s: Session) {
  return s.userRole === "ADMIN";
}

/**
 * Забороняє редагування для BRIGADIER після SUBMITTED.
 * ADMIN — завжди може.
 *
 * dayStatus може приходити як:
 * - "SUBMITTED" (канонічно)
 * - "🟡 ЗДАНО" (якщо десь так зберігається/показується)
 */
export function requireEditAllowed(s: Session, dayStatus?: string | null) {
  if (isAdmin(s)) return;

  const st = (dayStatus ?? "").trim().toUpperCase();

  const isSubmitted =
    st === "SUBMITTED" ||
    st.includes("SUBMITTED") ||
    st.includes("ЗДАНО") ||
    st.includes("🟡");

  if (s.userRole === "BRIGADIER" && isSubmitted) {
    throw new Error("FORBIDDEN_EDIT_AFTER_SUBMITTED");
  }
}

export function canEdit(s: Session, dayStatus?: string | null) {
  try {
    requireEditAllowed(s, dayStatus);
    return true;
  } catch {
    return false;
  }
}
