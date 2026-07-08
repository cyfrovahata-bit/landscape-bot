import { useEffect, useState } from "react";
import { api, type Employee, type SalaryPack } from "../lib/api";
import { confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, initials, roleAccent } from "../lib/employee";
import { BackRow } from "../components/BackRow";

type PendingObject = { objectId: string; objectName: string; works: { workId: string; workName: string; volume?: string | number }[] };
type PendingItem = {
  date: string;
  foremanTgId: number;
  foremanName: string;
  submittedAt: string;
  km: number;
  tripClass: string;
  roadAllowance: { total: number; perPerson: number };
  salaryPacks: SalaryPack[];
  objects: PendingObject[];
  employeeIds: string[];
};
type PendingResponse = { items: PendingItem[]; reasons: Record<string, string> };

function keyOf(it: PendingItem) {
  return `${it.date}|${it.foremanTgId}`;
}

export function Approval({
  onBack,
  focusDate,
  focusForeman,
  isAdmin,
}: {
  onBack: () => void;
  focusDate?: string;
  focusForeman?: number;
  isAdmin?: boolean;
}) {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(focusDate && focusForeman ? `${focusDate}|${focusForeman}` : null);
  const [returningKey, setReturningKey] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string>("OTHER");
  const [note, setNote] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const employeeById = new Map(employees.map((e) => [e.id, e]));

  // Otherwise Telegram's native back gesture/button exits the whole mini app
  // instead of stepping back to the menu, same as the in-app "‹ Назад" row.
  useTelegramBackButton(onBack);

  function load() {
    setLoading(true);
    setError(null);
    // Returned (not fire-and-forget) so approve()/confirmReturn() can await
    // the refreshed list before clearing their busy guard -- otherwise the
    // button re-enables the instant the POST resolves, while the just-acted-on
    // row is still showing its stale (pre-approval) state for the ~100-300ms
    // the refetch takes, inviting a second tap to send a duplicate request.
    return Promise.all([api.get<PendingResponse>("/api/road-timesheet/pending"), api.get<Employee[]>("/api/dictionaries/employees")])
      .then(([pending, emps]) => {
        setData(pending);
        setEmployees(emps);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resets the return-reason sub-form -- used both by "Скасувати" and after a
  // successful return, so a leftover reason/comment typed for one foreman's
  // day never carries over and gets attached to a DIFFERENT foreman's return
  // (reasonCode/note are screen-level state shared across every row).
  function closeReturnForm() {
    setReturningKey(null);
    setReasonCode("OTHER");
    setNote("");
  }

  async function approve(it: PendingItem) {
    const ok = await confirmDialog(`Затвердити день ${it.date} для ${it.foremanName}?`);
    if (!ok) return;
    setBusyKey(keyOf(it));
    try {
      await api.post("/api/road-timesheet/pending/approve", { date: it.date, foremanTgId: it.foremanTgId });
      haptic("success");
      await load();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmReturn(it: PendingItem) {
    setBusyKey(keyOf(it));
    try {
      await api.post("/api/road-timesheet/pending/return", { date: it.date, foremanTgId: it.foremanTgId, reasonCode, note });
      haptic("success");
      closeReturnForm();
      await load();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setBusyKey(null);
    }
  }

  // Defense-in-depth only -- the server already 403s every /pending* route
  // for a non-admin regardless of this. This just keeps the UI from ever
  // rendering someone else's approval data if this screen were ever reached
  // without going through Menu's admin-only filter or the deep-link's own
  // role check (both gate it today).
  if (isAdmin === false) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <div className="empty-state">⛔️ Доступно лише адміністратору</div>
      </div>
    );
  }

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>✅ Затвердження</h1>
        <div className="hint">Звіти, що очікують рішення</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}
      {loading && !data && <div className="empty-state">Завантаження…</div>}
      {data && !data.items.length && <div className="empty-state">🎉 Немає звітів на підтвердження</div>}

      {data && !!data.items.length && (
        <div className="list">
          {data.items.map((it) => {
            const key = keyOf(it);
            const expanded = expandedKey === key;
            const fund = it.salaryPacks.reduce((a, p) => a + p.objectTotal, 0);
            const busy = busyKey === key;
            return (
              <div key={key} style={{ borderBottom: "1px solid var(--tg-border)" }}>
                <button className="cell" onClick={() => setExpandedKey(expanded ? null : key)}>
                  <span className="cell-title">
                    {expanded ? "▾" : "▸"} {it.foremanName}
                  </span>
                  <span className="cell-sub">
                    {it.date} · {it.km} км
                  </span>
                </button>

                {expanded && (
                  <div style={{ padding: "0 16px 16px" }}>
                    <div className="hint" style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginBottom: 8 }}>
                      <span>🚗 {it.km} км · клас {it.tripClass}</span>
                      <span>💰 {Math.round(fund * 100) / 100} грн</span>
                      <span>💸 {it.roadAllowance.perPerson} грн/особу</span>
                    </div>

                    <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>
                      👥 Люди ({it.employeeIds.length})
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                      {it.employeeIds.map((id) => {
                        const emp = employeeById.get(id);
                        return (
                          <span key={id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              className={`avatar-circle ${roleAccent(emp ? employeeRole(emp) : "робітник")}`}
                              style={{ width: 22, height: 22, fontSize: 9 }}
                            >
                              {initials(emp?.name ?? id)}
                            </span>
                            <span className="hint">{emp?.name ?? id}</span>
                          </span>
                        );
                      })}
                    </div>

                    <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>
                      📍 Обʼєкти та нарахування
                    </div>
                    {it.objects.map((o) => {
                      const pack = it.salaryPacks.find((p) => p.objectId === o.objectId);
                      return (
                        <div key={o.objectId} style={{ marginBottom: 10 }}>
                          <div style={{ fontWeight: 600 }}>
                            {o.objectName} {pack ? `— ${pack.objectTotal} грн` : ""}
                          </div>
                          {o.works.map((w) => (
                            <div key={w.workId} className="hint">
                              {w.workName}
                              {w.volume && w.volume !== "?" ? `: ${w.volume}` : ""}
                            </div>
                          ))}
                          {pack?.rows.map((r) => (
                            <div key={r.employeeId} className="hint">
                              {r.employeeName}: {r.pay} грн
                            </div>
                          ))}
                          {pack && pack.companyPay > 0 && <div className="hint">🏢 Фірма: {pack.companyPay} грн</div>}
                        </div>
                      );
                    })}

                    {returningKey === key ? (
                      <div style={{ marginTop: 12 }}>
                        <div className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                          Причина повернення
                        </div>
                        <div className="chip-row">
                          {Object.entries(data.reasons).map(([code, label]) => (
                            <button
                              key={code}
                              className={`chip ${reasonCode === code ? "selected" : ""}`}
                              onClick={() => setReasonCode(code)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <input
                          className="search-box"
                          placeholder="Коментар (необовʼязково)…"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button className="chip" onClick={closeReturnForm}>
                            Скасувати
                          </button>
                          <button className="chip danger-btn" onClick={() => confirmReturn(it)} disabled={busy}>
                            {busy ? "Відправлення…" : "🔴 Підтвердити повернення"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          className="chip selected"
                          onClick={() => approve(it)}
                          disabled={busy}
                        >
                          {busy ? "…" : "✅ Підтвердити"}
                        </button>
                        <button
                          className="chip danger-btn"
                          onClick={() => {
                            // Always start from a clean reason/comment -- reasonCode/note
                            // are shared screen-wide state, so opening this for a
                            // different foreman without ever tapping "Скасувати" on the
                            // previous one (e.g. collapse row A, expand row B) must not
                            // carry A's leftover reason/comment into B's return.
                            setReasonCode("OTHER");
                            setNote("");
                            setReturningKey(key);
                          }}
                          disabled={busy}
                        >
                          🔴 Повернути на редагування
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
