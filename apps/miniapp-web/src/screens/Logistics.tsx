import { useEffect, useState } from "react";
import { api, type Employee, type LogisticDirection } from "../lib/api";
import { todayISO } from "../lib/date";
import { haptic } from "../lib/telegram";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

type Item = { logisticId: string; qty: number; employeeIds: string[] };
type Stage = "dest" | "qty" | "people" | "review";

const QTY_QUICK = [1, 2, 3, 5, 10];

function itemTotal(it: Item, dir: LogisticDirection | undefined): number {
  if (!dir) return 0;
  const discount = dir.discountsByQty?.[String(it.qty)] ?? 0;
  return Math.max(0, dir.tariff * it.qty - discount);
}

export function Logistics({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [directions, setDirections] = useState<LogisticDirection[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [stage, setStage] = useState<Stage>("dest");
  // Back-navigation stack within the add/edit-item mini-flow. Reset to []
  // whenever we land on a "top-level" stage (fresh dest, or review) so back
  // from there exits the whole screen instead of replaying stale steps.
  const [history, setHistory] = useState<Stage[]>([]);
  // null = adding a brand-new item; otherwise the index in `items` currently being edited.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftDirectionId, setDraftDirectionId] = useState("");
  const [draftQty, setDraftQty] = useState(1);
  const [draftEmployeeIds, setDraftEmployeeIds] = useState<string[]>([]);
  const [editActionIndex, setEditActionIndex] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<LogisticDirection[]>("/api/dictionaries/logistics").then(setDirections).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
  }, []);

  const directionById = new Map(directions.map((d) => [d.id, d]));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  function resetDraft() {
    setEditingIndex(null);
    setDraftDirectionId("");
    setDraftQty(1);
    setDraftEmployeeIds([]);
  }

  function startNewItem() {
    resetDraft();
    setError(null);
    // Only reachable from review (with ≥1 item already), so back from this
    // fresh "dest" should return there instead of exiting the screen.
    setHistory(["review"]);
    setStage("dest");
  }

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

  function pickDirection(dir: LogisticDirection) {
    const dup = items.some((it, i) => it.logisticId === dir.id && i !== editingIndex);
    if (dup) {
      setError("Цей напрямок уже доданий. Обери інший.");
      haptic("error");
      return;
    }
    setDraftDirectionId(dir.id);
    setError(null);
    goTo("qty");
    haptic("selection");
  }

  function confirmQty() {
    if (!draftQty || draftQty < 1 || draftQty > 999) {
      setError("Введи число від 1 до 999");
      haptic("error");
      return;
    }
    setError(null);
    goTo("people");
  }

  function toggleDraftEmployee(id: string) {
    const usedElsewhere = items.some((it, i) => i !== editingIndex && it.employeeIds.includes(id));
    if (usedElsewhere) {
      haptic("error");
      return;
    }
    setDraftEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    haptic("selection");
  }

  function commitItem() {
    if (!draftEmployeeIds.length) {
      setError("Обери хоча б 1 працівника");
      haptic("error");
      return;
    }
    const newItem: Item = { logisticId: draftDirectionId, qty: draftQty, employeeIds: draftEmployeeIds };
    setItems((prev) => {
      if (editingIndex !== null) {
        const next = [...prev];
        next[editingIndex] = newItem;
        return next;
      }
      return [...prev, newItem];
    });
    setError(null);
    haptic("success");
    resetDraft();
    // At least one item now exists, so back from this fresh "dest" should
    // return to review instead of exiting the screen.
    setHistory(["review"]);
    setStage("dest");
  }

  function editItem(idx: number, part: "dest" | "qty" | "people") {
    const it = items[idx];
    setEditingIndex(idx);
    setDraftDirectionId(part === "dest" ? "" : it.logisticId);
    setDraftQty(it.qty);
    setDraftEmployeeIds(it.employeeIds);
    setEditActionIndex(null);
    setError(null);
    // Jumping straight into one part of an existing item -- back should
    // cancel the edit and return to the review list, not replay dest/qty
    // steps that weren't part of this particular edit.
    setHistory(["review"]);
    setStage(part);
  }

  function deleteItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setEditActionIndex(null);
    haptic("selection");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/logistics", { date: todayISO(), items });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const grandTotal = items.reduce((acc, it) => acc + itemTotal(it, directionById.get(it.logisticId)), 0);
  const uniquePeople = new Set(items.flatMap((it) => it.employeeIds));
  const evenSplitPerPerson = uniquePeople.size ? Math.round((grandTotal / uniquePeople.size) * 100) / 100 : 0;

  return (
    <div>
      <BackRow onBack={goBack} />
      <div className="header">
        <h1>🚚 Логістика</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {stage === "dest" && (
        <>
          <div className="section-title">Напрямок</div>
          <div className="list">
            {directions
              .filter((d) => !items.some((it, i) => it.logisticId === d.id && i !== editingIndex))
              .map((d) => (
                <button key={d.id} className="cell" onClick={() => pickDirection(d)}>
                  <span className="cell-title">{d.name}</span>
                  <span className="cell-sub">{d.tariff} грн</span>
                </button>
              ))}
          </div>
          {items.length > 0 && (
            <MainButton
              text={`✅ Перевірити (${items.length})`}
              onClick={() => {
                setHistory([]);
                setStage("review");
              }}
            />
          )}
        </>
      )}

      {stage === "qty" && (
        <>
          <div className="section-title">{directionById.get(draftDirectionId)?.name}</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            {directionById.get(draftDirectionId)?.tariff} грн за одиницю
          </div>
          <div className="big-number">{draftQty}</div>
          <div className="field">
            <label>Кількість обʼєктів</label>
            <div className="stepper">
              <button onClick={() => setDraftQty((q) => Math.max(1, q - 1))}>−</button>
              <input value={draftQty} onChange={(e) => setDraftQty(Number(e.target.value) || 1)} />
              <button onClick={() => setDraftQty((q) => Math.min(999, q + 1))}>+</button>
            </div>
          </div>
          <div className="chip-row">
            {QTY_QUICK.map((n) => (
              <div key={n} className={`chip ${draftQty === n ? "selected" : ""}`} onClick={() => setDraftQty(n)}>
                {n}
              </div>
            ))}
          </div>
          <MainButton text="Далі → Люди" onClick={confirmQty} />
        </>
      )}

      {stage === "people" && (
        <>
          <div className="section-title">Працівники — {directionById.get(draftDirectionId)?.name}</div>
          <div className="chip-row">
            {employees.map((emp) => {
              const lockedByOther = items.some((it, i) => i !== editingIndex && it.employeeIds.includes(emp.id));
              return (
                <div
                  key={emp.id}
                  className={`chip ${draftEmployeeIds.includes(emp.id) ? "selected" : ""}`}
                  style={lockedByOther ? { opacity: 0.4 } : undefined}
                  onClick={() => toggleDraftEmployee(emp.id)}
                >
                  {lockedByOther ? "⛔️ " : ""}
                  {emp.name}
                </div>
              );
            })}
          </div>
          <MainButton text="Готово ✅" onClick={commitItem} />
        </>
      )}

      {stage === "review" && (
        <>
          <div className="section-title">Записи ({items.length})</div>
          <div className="list">
            {items.map((it, idx) => {
              const dir = directionById.get(it.logisticId);
              const total = itemTotal(it, dir);
              return (
                <div
                  key={idx}
                  className="cell"
                  style={{ display: "block", cursor: "pointer" }}
                  onClick={() => setEditActionIndex(editActionIndex === idx ? null : idx)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="cell-title">
                      {dir?.name ?? it.logisticId} × {it.qty}
                    </span>
                    <span className="cell-sub">{total} грн</span>
                  </div>
                  <div className="hint">{it.employeeIds.map((id) => employeeById.get(id)?.name ?? id).join(", ")}</div>
                  {editActionIndex === idx && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          editItem(idx, "dest");
                        }}
                      >
                        ✏️ Напрямок
                      </button>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          editItem(idx, "qty");
                        }}
                      >
                        🔢 Кількість
                      </button>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          editItem(idx, "people");
                        }}
                      >
                        👥 Люди
                      </button>
                      <button
                        className="chip danger-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteItem(idx);
                        }}
                      >
                        🗑 Видалити
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-title">Підсумок</div>
          <div className="list">
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Записів</span>
              <span className="cell-sub">{items.length}</span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Людей (унікально)</span>
              <span className="cell-sub">{uniquePeople.size}</span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Всього сума</span>
              <span className="cell-sub">{Math.round(grandTotal * 100) / 100} грн</span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Якщо ділити порівну на всіх</span>
              <span className="cell-sub">{evenSplitPerPerson} грн/особу</span>
            </div>
          </div>

          <div style={{ padding: "8px 16px" }}>
            <button className="bulk-select-btn" onClick={startNewItem}>
              ➕ Додати ще
            </button>
          </div>

          <MainButton text={saving ? "Збереження…" : "💾 Відправити"} onClick={save} disabled={!items.length || saving} />
        </>
      )}
    </div>
  );
}
