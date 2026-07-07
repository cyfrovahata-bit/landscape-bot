import { useEffect, useState } from "react";
import { api, type Material, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

type MoveType = "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
const MOVE_TYPES: { value: MoveType; label: string }[] = [
  { value: "ISSUE", label: "Видача" },
  { value: "RETURN", label: "Повернення" },
  { value: "WRITEOFF", label: "Списання" },
  { value: "ADJUST", label: "Коригування" },
];

type Item = { materialId: string; materialName: string; unit: string; qty: number };

export function Materials({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [objects, setObjects] = useState<WorkObject[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [objectId, setObjectId] = useState("");
  const [moveType, setMoveType] = useState<MoveType>("ISSUE");
  const [items, setItems] = useState<Item[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
    api.get<Material[]>("/api/dictionaries/materials").then(setMaterials).catch((e) => setError(e.message));
  }, []);

  function addItem(m: Material) {
    if (items.some((it) => it.materialId === m.id)) return;
    setItems((prev) => [...prev, { materialId: m.id, materialName: m.name, unit: m.unit, qty: 1 }]);
  }

  function setQty(materialId: string, qty: number) {
    setItems((prev) => prev.map((it) => (it.materialId === materialId ? { ...it, qty: Math.max(0, qty) } : it)));
  }

  function removeItem(materialId: string) {
    setItems((prev) => prev.filter((it) => it.materialId !== materialId));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/materials", { date: todayISO(), objectId, moveType, items });
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
        <h1>🧱 Матеріали</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      <div className="section-title">Тип операції</div>
      <div className="chip-row">
        {MOVE_TYPES.map((mt) => (
          <button key={mt.value} className={`chip ${moveType === mt.value ? "selected" : ""}`} onClick={() => setMoveType(mt.value)}>
            {mt.label}
          </button>
        ))}
      </div>

      <div className="section-title">Обʼєкт</div>
      <div className="list">
        {objects.map((o) => (
          <button key={o.id} className={`cell ${objectId === o.id ? "selected" : ""}`} onClick={() => setObjectId(o.id)}>
            <span className="cell-title">{o.name}</span>
          </button>
        ))}
      </div>

      <div className="section-title">Матеріали</div>
      <div className="list">
        {materials.map((m) => {
          const item = items.find((it) => it.materialId === m.id);
          return (
            <div key={m.id} className="cell" onClick={() => !item && addItem(m)}>
              <span className="cell-title">{m.name}</span>
              {item ? (
                <div className="stepper" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => setQty(m.id, item.qty - 1)}>−</button>
                  <input value={item.qty} onChange={(e) => setQty(m.id, Number(e.target.value) || 0)} />
                  <button onClick={() => setQty(m.id, item.qty + 1)}>+</button>
                  <button onClick={() => removeItem(m.id)}>🗑</button>
                </div>
              ) : (
                <span className="cell-sub">{m.unit}</span>
              )}
            </div>
          );
        })}
      </div>

      <MainButton
        text={saving ? "Збереження…" : "Зберегти"}
        onClick={save}
        disabled={!objectId || !items.length || saving}
      />
    </div>
  );
}
