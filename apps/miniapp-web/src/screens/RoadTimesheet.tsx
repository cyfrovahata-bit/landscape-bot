import { useEffect, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

type ObjectWork = { workId: string; workName: string; volume: string };
type ObjectHours = { employeeId: string; employeeName: string; hours: number };
type ObjectEntry = { objectId: string; objectName: string; works: ObjectWork[]; hours: ObjectHours[] };

export function RoadTimesheet({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [cars, setCars] = useState<Car[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [objects, setObjects] = useState<WorkObject[]>([]);

  const [carId, setCarId] = useState("");
  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [pickedEmployeeIds, setPickedEmployeeIds] = useState<string[]>([]);
  const [entries, setEntries] = useState<ObjectEntry[]>([]);
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ km: number; tripClass: string } | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
  }, []);

  function toggleEmployee(id: string) {
    setPickedEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleObject(obj: WorkObject) {
    setEntries((prev) => {
      const exists = prev.find((e) => e.objectId === obj.id);
      if (exists) return prev.filter((e) => e.objectId !== obj.id);
      return [...prev, { objectId: obj.id, objectName: obj.name, works: [], hours: [] }];
    });
    setOpenObjectId(obj.id);
  }

  function toggleWork(objectId: string, work: Work) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.objectId !== objectId) return e;
        const has = e.works.some((w) => w.workId === work.id);
        return {
          ...e,
          works: has ? e.works.filter((w) => w.workId !== work.id) : [...e.works, { workId: work.id, workName: work.name, volume: "" }],
        };
      }),
    );
  }

  function setVolume(objectId: string, workId: string, volume: string) {
    setEntries((prev) =>
      prev.map((e) => (e.objectId !== objectId ? e : { ...e, works: e.works.map((w) => (w.workId === workId ? { ...w, volume } : w)) })),
    );
  }

  function setHours(objectId: string, employeeId: string, employeeName: string, hours: number) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.objectId !== objectId) return e;
        const has = e.hours.some((h) => h.employeeId === employeeId);
        const nextHours = has
          ? e.hours.map((h) => (h.employeeId === employeeId ? { ...h, hours } : h))
          : [...e.hours, { employeeId, employeeName, hours }];
        return { ...e, hours: nextHours };
      }),
    );
  }

  const missingVolumeCount = entries.reduce((acc, e) => acc + e.works.filter((w) => !w.volume || w.volume === "?").length, 0);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ km: number; tripClass: string }>("/api/road-timesheet", {
        date: todayISO(),
        carId,
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds: pickedEmployeeIds,
        objects: entries.map((e) => ({
          objectId: e.objectId,
          works: e.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?" })),
          hours: e.hours,
        })),
      });
      setResult(res);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <div>
        <div className="header">
          <h1>✅ Збережено</h1>
        </div>
        <div className="empty-state">
          Поїздка: {result.km} км · клас {result.tripClass}
        </div>
        <MainButton text="До меню" onClick={onBack} />
      </div>
    );
  }

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>🚗 Дорожній табель</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      <div className="section-title">Авто</div>
      <div className="list">
        {cars.map((c) => (
          <button key={c.id} className={`cell ${carId === c.id ? "selected" : ""}`} onClick={() => setCarId(c.id)}>
            <span className="cell-title">{c.name}</span>
            <span className="cell-sub">{c.plate}</span>
          </button>
        ))}
      </div>

      <div className="grid-2">
        <div className="field">
          <label>Одометр (старт)</label>
          <input type="number" value={odoStart} onChange={(e) => setOdoStart(e.target.value)} />
        </div>
        <div className="field">
          <label>Одометр (кінець)</label>
          <input type="number" value={odoEnd} onChange={(e) => setOdoEnd(e.target.value)} />
        </div>
      </div>

      <div className="section-title">Люди в поїздці</div>
      <div className="chip-row">
        {employees.map((emp) => (
          <div key={emp.id} className={`chip ${pickedEmployeeIds.includes(emp.id) ? "selected" : ""}`} onClick={() => toggleEmployee(emp.id)}>
            {emp.name}
          </div>
        ))}
      </div>

      <div className="section-title">Обʼєкти маршруту</div>
      <div className="chip-row">
        {objects.map((obj) => (
          <div key={obj.id} className={`chip ${entries.some((e) => e.objectId === obj.id) ? "selected" : ""}`} onClick={() => toggleObject(obj)}>
            {obj.name}
          </div>
        ))}
      </div>

      {entries.map((entry) => (
        <div key={entry.objectId} className="list" style={{ marginTop: 8 }}>
          <button className="cell" onClick={() => setOpenObjectId(openObjectId === entry.objectId ? null : entry.objectId)}>
            <span className="cell-title">📍 {entry.objectName}</span>
            <span className={`badge ${entry.works.length && entry.works.every((w) => w.volume && w.volume !== "?") ? "ok" : "warn"}`}>
              {entry.works.length} робіт
            </span>
          </button>

          {openObjectId === entry.objectId && (
            <div style={{ padding: "0 16px 16px" }}>
              <div className="section-title" style={{ padding: "8px 0" }}>
                Роботи
              </div>
              <div className="chip-row" style={{ padding: 0 }}>
                {works.map((w) => (
                  <div
                    key={w.id}
                    className={`chip ${entry.works.some((ew) => ew.workId === w.id) ? "selected" : ""}`}
                    onClick={() => toggleWork(entry.objectId, w)}
                  >
                    {w.name}
                  </div>
                ))}
              </div>

              {entry.works.length > 0 && (
                <>
                  <div className="section-title" style={{ padding: "8px 0" }}>
                    Обсяги{missingVolumeCount > 0 ? " (🟡 є незаповнені)" : ""}
                  </div>
                  {entry.works.map((w) => (
                    <div className="field" key={w.workId} style={{ margin: "8px 0" }}>
                      <label>{w.workName}</label>
                      <input
                        placeholder="Обсяг або “?”, якщо ще невідомо"
                        value={w.volume}
                        onChange={(e) => setVolume(entry.objectId, w.workId, e.target.value)}
                      />
                    </div>
                  ))}
                </>
              )}

              <div className="section-title" style={{ padding: "8px 0" }}>
                Години людей на обʼєкті
              </div>
              {pickedEmployeeIds.map((empId) => {
                const emp = employees.find((e) => e.id === empId)!;
                const h = entry.hours.find((x) => x.employeeId === empId)?.hours ?? 0;
                return (
                  <div className="field" key={empId} style={{ margin: "8px 0" }}>
                    <label>{emp.name}</label>
                    <input type="number" value={h} onChange={(e) => setHours(entry.objectId, empId, emp.name, Number(e.target.value) || 0)} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      <MainButton
        text={saving ? "Збереження…" : "Зберегти день"}
        onClick={save}
        disabled={!carId || !odoStart || !odoEnd || !entries.length || saving}
      />
    </div>
  );
}
