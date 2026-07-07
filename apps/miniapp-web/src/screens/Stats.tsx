import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";

type WorkStat = { workName: string; unit: string; totalVolume: number; employeeNames: string[] };
type ObjEmployeeStat = { employeeName: string; hours: number; pay: number };
type ObjectStat = { objectId: string; objectName: string; totalFund: number; works: WorkStat[]; employees: ObjEmployeeStat[] };
type EmpObjectStat = { objectId: string; objectName: string; hours: number; pay: number };
type EmployeeStat = {
  employeeId: string;
  employeeName: string;
  totalHours: number;
  totalPay: number;
  roadAllowance: number;
  objects: EmpObjectStat[];
};
type CarDayStat = { date: string; km: number; tripClass: string; riderNames: string[]; objectNames: string[] };
type CarStat = { carId: string; carName: string; totalKm: number; days: CarDayStat[] };
type StatsRangeResponse = { from: string; to: string; byObject: ObjectStat[]; byEmployee: EmployeeStat[]; byCar: CarStat[] };

type Tab = "objects" | "employees" | "cars";

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function Stats({ onBack }: { onBack: () => void }) {
  const [from, setFrom] = useState(() => daysAgoISO(6));
  const [to, setTo] = useState(() => todayISO());
  const [data, setData] = useState<StatsRangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("objects");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<StatsRangeResponse>(`/api/stats/range?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  function selectTab(t: Tab) {
    setTab(t);
    setExpandedId(null);
  }

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>📊 Статистика</h1>
        <div className="hint">
          {from} — {to}
        </div>
      </div>

      <div className="grid-2">
        <div className="field" style={{ margin: 0 }}>
          <label>Від</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>До</label>
          <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="unit-tabs" style={{ margin: "8px 0" }}>
        <button className={`unit-tab ${tab === "objects" ? "selected" : ""}`} onClick={() => selectTab("objects")}>
          📍 Обʼєкти
        </button>
        <button className={`unit-tab ${tab === "employees" ? "selected" : ""}`} onClick={() => selectTab("employees")}>
          👥 Люди
        </button>
        <button className={`unit-tab ${tab === "cars" ? "selected" : ""}`} onClick={() => selectTab("cars")}>
          🚙 Машини
        </button>
      </div>

      {loading && <div className="empty-state">Завантаження…</div>}
      {error && <div className="empty-state">⚠️ {error}</div>}

      {data && !loading && (
        <>
          {tab === "objects" && (
            <>
              {!data.byObject.length && <div className="empty-state">Немає даних за цей період</div>}
              <div className="list">
                {data.byObject.map((o) => {
                  const expanded = expandedId === o.objectId;
                  return (
                    <div key={o.objectId}>
                      <button className="cell" onClick={() => setExpandedId(expanded ? null : o.objectId)}>
                        <span className="cell-title">
                          {expanded ? "▾" : "▸"} 📍 {o.objectName}
                        </span>
                        <span className="badge ok">{o.totalFund} ₴</span>
                      </button>
                      {expanded && (
                        <div style={{ padding: "4px 16px 12px" }}>
                          <div className="hint" style={{ fontWeight: 600 }}>
                            🛠 Роботи
                          </div>
                          {o.works.length ? (
                            o.works.map((w, i) => (
                              <div key={i} className="hint" style={{ marginBottom: 4 }}>
                                {w.workName}: {w.totalVolume} {w.unit}
                                {w.employeeNames.length ? ` — ${w.employeeNames.join(", ")}` : ""}
                              </div>
                            ))
                          ) : (
                            <div className="hint">Немає робіт</div>
                          )}
                          <div className="hint" style={{ fontWeight: 600, marginTop: 8 }}>
                            👥 Люди та нарахування
                          </div>
                          {o.employees.length ? (
                            o.employees.map((e, i) => (
                              <div key={i} className="hint" style={{ marginBottom: 4 }}>
                                {e.employeeName}: {e.hours} год · {e.pay} ₴
                              </div>
                            ))
                          ) : (
                            <div className="hint">Немає даних</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === "employees" && (
            <>
              {!data.byEmployee.length && <div className="empty-state">Немає даних за цей період</div>}
              <div className="list">
                {data.byEmployee.map((e) => {
                  const expanded = expandedId === e.employeeId;
                  return (
                    <div key={e.employeeId}>
                      <button className="cell" onClick={() => setExpandedId(expanded ? null : e.employeeId)}>
                        <span className="cell-title">
                          {expanded ? "▾" : "▸"} {e.employeeName}
                        </span>
                        <span className="cell-sub">
                          {e.totalHours} год · {e.totalPay} ₴
                        </span>
                      </button>
                      {expanded && (
                        <div style={{ padding: "4px 16px 12px" }}>
                          {e.roadAllowance > 0 && (
                            <div className="hint" style={{ marginBottom: 6 }}>
                              💸 Доплата за виїзд: {e.roadAllowance} ₴
                            </div>
                          )}
                          <div className="hint" style={{ fontWeight: 600 }}>
                            📍 Обʼєкти
                          </div>
                          {e.objects.length ? (
                            e.objects.map((o) => (
                              <div key={o.objectId} className="hint" style={{ marginBottom: 4 }}>
                                {o.objectName}: {o.hours} год · {o.pay} ₴
                              </div>
                            ))
                          ) : (
                            <div className="hint">Без обʼєктів (лише доплата за виїзд)</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === "cars" && (
            <>
              {!data.byCar.length && <div className="empty-state">Немає даних за цей період</div>}
              <div className="list">
                {data.byCar.map((c) => {
                  const expanded = expandedId === c.carId;
                  return (
                    <div key={c.carId}>
                      <button className="cell" onClick={() => setExpandedId(expanded ? null : c.carId)}>
                        <span className="cell-title">
                          {expanded ? "▾" : "▸"} 🚙 {c.carName}
                        </span>
                        <span className="badge">{c.totalKm} км</span>
                      </button>
                      {expanded && (
                        <div style={{ padding: "4px 16px 12px" }}>
                          {c.days.map((d, i) => (
                            <div key={i} className="hint" style={{ marginBottom: 8 }}>
                              <b>{d.date}</b> — {d.km} км · клас {d.tripClass || "—"}
                              <br />👥 {d.riderNames.join(", ") || "—"}
                              <br />📍 {d.objectNames.join(", ") || "—"}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
