import { useEffect, useState } from "react";
import { api, type Material, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { haptic } from "../lib/telegram";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

type MoveType = "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
const MOVE_TYPES: { value: MoveType; label: string; icon: string }[] = [
  { value: "ISSUE", label: "Видача", icon: "📤" },
  { value: "RETURN", label: "Повернення", icon: "📥" },
  { value: "WRITEOFF", label: "Списання", icon: "🗑" },
  { value: "ADJUST", label: "Коригування", icon: "🛠" },
];

type Item = { materialId: string; materialName: string; unit: string; qty: number };
type Stage = "type" | "object" | "materials" | "review";

export function Materials({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [objects, setObjects] = useState<WorkObject[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [objectId, setObjectId] = useState("");
  const [moveType, setMoveType] = useState<MoveType | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedExpanded, setSelectedExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>("type");
  const [history, setHistory] = useState<Stage[]>([]);

  useEffect(() => {
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
    api.get<Material[]>("/api/dictionaries/materials").then(setMaterials).catch((e) => setError(e.message));
  }, []);

  function goTo(next: Stage) {
    setHistory((h) => [...h, stage]);
    setStage(next);
  }

  function goBack() {
    if (!history.length) {
      onBack();
      return;
    }
    setStage(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
  }

  function pickMoveType(mt: MoveType) {
    setMoveType(mt);
    setError(null);
    haptic("selection");
    goTo("object");
  }

  function pickObject(o: WorkObject) {
    setObjectId(o.id);
    setError(null);
    haptic("selection");
    goTo("materials");
  }

  function toggleMaterial(m: Material) {
    const exists = items.some((it) => it.materialId === m.id);
    if (exists) {
      setItems((prev) => prev.filter((it) => it.materialId !== m.id));
    } else {
      setItems((prev) => [...prev, { materialId: m.id, materialName: m.name, unit: m.unit, qty: 1 }]);
    }
    haptic("selection");
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

  const objectName = objects.find((o) => o.id === objectId)?.name ?? "";
  const moveTypeInfo = MOVE_TYPES.find((mt) => mt.value === moveType);

  return (
    <div>
      <BackRow onBack={goBack} />
      <div className="header">
        <h1>🧱 Матеріали</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {stage === "type" && (
        <>
          <div className="step-badge">📦 ТИП ОПЕРАЦІЇ</div>
          <div className="section-title">Що робимо?</div>
          <div className="list">
            {MOVE_TYPES.map((mt) => (
              <button key={mt.value} className="cell" onClick={() => pickMoveType(mt.value)}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-orange">{mt.icon}</span>
                  <span className="cell-title">{mt.label}</span>
                </span>
                <span className="cell-sub">›</span>
              </button>
            ))}
          </div>
        </>
      )}

      {stage === "object" && (
        <>
          <div className="step-badge">🏗 ОБ'ЄКТ</div>
          <div className="section-title">{moveTypeInfo?.label} — куди/звідки?</div>
          <div className="list">
            {objects.map((o) => (
              <button key={o.id} className="cell" onClick={() => pickObject(o)}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-orange">🏗</span>
                  <span className="cell-title">{o.name}</span>
                </span>
                <span className="cell-sub">{o.address ?? "›"}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {stage === "materials" && (
        <>
          <div className="step-badge">🧱 МАТЕРІАЛИ</div>
          <div className="section-title row">
            <span>Матеріали — Обрано {items.length}</span>
            {items.length > 0 && (
              <button className="chip" onClick={() => setItems([])}>
                🗑 Очистити вибір
              </button>
            )}
          </div>
          {items.length > 0 && (
            <div style={{ padding: "0 16px 8px" }}>
              <button className="back-btn" onClick={() => setSelectedExpanded((v) => !v)}>
                {selectedExpanded ? "▾ Сховати обрані" : "▸ Показати обрані"}
              </button>
              {selectedExpanded && <div className="hint">{items.map((it) => it.materialName).join(", ")}</div>}
            </div>
          )}
          <div className="list">
            {materials.map((m) => {
              const item = items.find((it) => it.materialId === m.id);
              return (
                <div
                  key={m.id}
                  className={`cell ${item ? "selected" : ""}`}
                  style={{ display: "block", cursor: "pointer" }}
                  onClick={() => !item && toggleMaterial(m)}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <span className="setup-icon accent-orange">🧱</span>
                      <span className="cell-title">{m.name}</span>
                    </span>
                    {!item && <span className="cell-sub">{m.unit}</span>}
                  </div>
                  {item && (
                    <div
                      className="stepper"
                      style={{ marginTop: 8 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button onClick={() => setQty(m.id, item.qty - 1)}>−</button>
                      <input value={item.qty} onChange={(e) => setQty(m.id, Number(e.target.value) || 0)} />
                      <button onClick={() => setQty(m.id, item.qty + 1)}>+</button>
                      <span className="hint" style={{ marginLeft: 4 }}>{m.unit}</span>
                      <button onClick={() => removeItem(m.id)}>🗑</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <MainButton
            text={`Далі → Перевірка (${items.length})`}
            onClick={() => {
              setHistory((h) => [...h, "materials"]);
              setStage("review");
            }}
            disabled={!items.length}
          />
        </>
      )}

      {stage === "review" && (
        <>
          <div className="step-badge">✅ ПЕРЕВІРКА</div>
          <div className="section-title">Перевірка запису</div>
          <div className="list">
            <button className="cell" onClick={() => goTo("type")}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-orange">{moveTypeInfo?.icon}</span>
                <span className="cell-title">{moveTypeInfo?.label}</span>
              </span>
              <span className="cell-sub">✏️</span>
            </button>
            <button className="cell" onClick={() => goTo("object")}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-orange">🏗</span>
                <span className="cell-title">{objectName}</span>
              </span>
              <span className="cell-sub">✏️</span>
            </button>
          </div>

          <div className="section-title row">
            <span>Матеріали ({items.length})</span>
            <button className="chip" onClick={() => goTo("materials")}>
              ✏️ Змінити
            </button>
          </div>
          <div className="list">
            {items.map((it) => (
              <div key={it.materialId} className="cell">
                <span className="cell-title">{it.materialName}</span>
                <span className="cell-sub">
                  {it.qty} {it.unit}
                </span>
              </div>
            ))}
          </div>

          <MainButton
            text={saving ? "Збереження…" : "💾 Зберегти"}
            onClick={save}
            disabled={!objectId || !moveType || !items.length || saving}
          />
        </>
      )}
    </div>
  );
}
