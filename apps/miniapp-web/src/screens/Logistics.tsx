import { useEffect, useState } from "react";
import { api, type Employee, type LogisticDirection } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

type Item = { logisticId: string; logisticName: string; qty: number; employeeIds: string[] };

export function Logistics({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [directions, setDirections] = useState<LogisticDirection[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [directionId, setDirectionId] = useState("");
  const [qty, setQty] = useState(1);
  const [pickedEmployeeIds, setPickedEmployeeIds] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<LogisticDirection[]>("/api/dictionaries/logistics").then(setDirections).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
  }, []);

  function toggleEmployee(id: string) {
    setPickedEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function addItem() {
    const dir = directions.find((d) => d.id === directionId);
    if (!dir || !pickedEmployeeIds.length) return;
    setItems((prev) => [...prev, { logisticId: dir.id, logisticName: dir.name, qty, employeeIds: pickedEmployeeIds }]);
    setDirectionId("");
    setQty(1);
    setPickedEmployeeIds([]);
  }

  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/logistics", {
        date: todayISO(),
        items: items.map(({ logisticId, qty, employeeIds }) => ({ logisticId, qty, employeeIds })),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>🚚 Логістика</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      <div className="section-title">Напрямок</div>
      <div className="list">
        {directions.map((d) => (
          <button key={d.id} className={`cell ${directionId === d.id ? "selected" : ""}`} onClick={() => setDirectionId(d.id)}>
            <span className="cell-title">{d.name}</span>
            <span className="cell-sub">{d.tariff} грн</span>
          </button>
        ))}
      </div>

      <div className="field">
        <label>Кількість обʼєктів</label>
        <div className="stepper">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
          <input value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} />
          <button onClick={() => setQty((q) => q + 1)}>+</button>
        </div>
      </div>

      <div className="section-title">Працівники</div>
      <div className="chip-row">
        {employees.map((emp) => (
          <div key={emp.id} className={`chip ${pickedEmployeeIds.includes(emp.id) ? "selected" : ""}`} onClick={() => toggleEmployee(emp.id)}>
            {emp.name}
          </div>
        ))}
      </div>

      <div style={{ padding: "8px 12px" }}>
        <button className="cell" style={{ borderRadius: 10, border: "1px dashed var(--tg-border)" }} onClick={addItem} disabled={!directionId || !pickedEmployeeIds.length}>
          ➕ Додати запис
        </button>
      </div>

      {items.length > 0 && (
        <>
          <div className="section-title">Додано ({items.length})</div>
          <div className="list">
            {items.map((it, idx) => (
              <button key={idx} className="cell" onClick={() => removeItem(idx)}>
                <span className="cell-title">
                  {it.logisticName} × {it.qty}
                </span>
                <span className="cell-sub">🗑 {it.employeeIds.length} чол.</span>
              </button>
            ))}
          </div>
        </>
      )}

      <MainButton text={saving ? "Збереження…" : "Зберегти"} onClick={save} disabled={!items.length || saving} />
    </div>
  );
}
