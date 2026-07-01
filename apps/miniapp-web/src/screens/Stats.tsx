import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";

type StatsResponse = {
  date: string;
  checklist: {
    hasLogistics: boolean;
    hasMaterials: boolean;
    hasRoad: boolean;
    hasOdoStart: boolean;
    hasOdoEnd: boolean;
    hasTimesheet: boolean;
  };
  logistics: { count: number };
  materials: { count: number; moves: { materialName: string; qty: number; unit: string; moveType: string }[] };
  road: { odometerDays: { carId: string; kmDay: number | null; tripClass: string | null }[] };
  hoursByEmployee: { employeeName: string; hours: number }[];
};

const CHECKS: { key: keyof StatsResponse["checklist"]; label: string }[] = [
  { key: "hasLogistics", label: "Логістика" },
  { key: "hasMaterials", label: "Матеріали" },
  { key: "hasRoad", label: "Дорожній табель" },
  { key: "hasOdoStart", label: "Одометр (старт)" },
  { key: "hasOdoEnd", label: "Одометр (кінець)" },
  { key: "hasTimesheet", label: "Табель годин" },
];

export function Stats({ onBack }: { onBack: () => void }) {
  const [date] = useState(todayISO());
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<StatsResponse>(`/api/stats?date=${date}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [date]);

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>📊 Статистика</h1>
        <div className="hint">{date}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}
      {!data && !error && <div className="empty-state">Завантаження…</div>}

      {data && (
        <>
          <div className="section-title">Чекліст дня</div>
          <div className="list">
            {CHECKS.map((c) => (
              <div key={c.key} className="cell">
                <span className="cell-title">{c.label}</span>
                <span className={`badge ${data.checklist[c.key] ? "ok" : "warn"}`}>
                  {data.checklist[c.key] ? "✅ Є" : "— Немає"}
                </span>
              </div>
            ))}
          </div>

          <div className="section-title">Години по працівниках</div>
          <div className="list">
            {data.hoursByEmployee.length === 0 && (
              <div className="cell">
                <span className="cell-sub">Немає даних</span>
              </div>
            )}
            {data.hoursByEmployee.map((h) => (
              <div key={h.employeeName} className="cell">
                <span className="cell-title">{h.employeeName}</span>
                <span className="cell-sub">{h.hours} год</span>
              </div>
            ))}
          </div>

          <div className="section-title">Матеріали сьогодні ({data.materials.count})</div>
          <div className="list">
            {data.materials.moves.length === 0 && (
              <div className="cell">
                <span className="cell-sub">Немає даних</span>
              </div>
            )}
            {data.materials.moves.map((m, i) => (
              <div key={i} className="cell">
                <span className="cell-title">{m.materialName}</span>
                <span className="cell-sub">
                  {m.moveType} {m.qty} {m.unit}
                </span>
              </div>
            ))}
          </div>

          <div className="section-title">Одометр</div>
          <div className="list">
            {data.road.odometerDays.length === 0 && (
              <div className="cell">
                <span className="cell-sub">Немає даних</span>
              </div>
            )}
            {data.road.odometerDays.map((o, i) => (
              <div key={i} className="cell">
                <span className="cell-title">{o.carId}</span>
                <span className="cell-sub">
                  {o.kmDay ?? "—"} км · {o.tripClass ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
