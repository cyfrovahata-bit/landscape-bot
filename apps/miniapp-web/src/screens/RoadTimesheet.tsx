import { useEffect, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

// Mirrors the bot's road timesheet flow step-by-step (apps/bot/src/bot/flows/roadTimesheet.flow.ts):
// PICK_CAR -> ODO_START(+photo) -> PICK_PEOPLE -> PICK_OBJECTS -> plan works per object ->
// READY_TO_START -> RUN_DRIVE (drop off / pick up people per object) -> ODO_END(+photo) -> SAVE.
type Step =
  | "PICK_CAR"
  | "ODO_START"
  | "PICK_PEOPLE"
  | "PICK_OBJECTS"
  | "PLAN"
  | "READY"
  | "DRIVE"
  | "ODO_END"
  | "REVIEW"
  | "DONE";

type ObjWork = { workId: string; workName: string; volume: string };
// A work session: an employee dropped at this object, and (once picked back up) how long they were there.
type Session = { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string };
type ObjPlan = { objectId: string; objectName: string; works: ObjWork[]; sessions: Session[] };

function fmtElapsed(fromISO: string) {
  const ms = Date.now() - new Date(fromISO).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} хв`;
  return `${Math.floor(mins / 60)} год ${mins % 60} хв`;
}

export function RoadTimesheet({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<Step>("PICK_CAR");

  const [cars, setCars] = useState<Car[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [objects, setObjects] = useState<WorkObject[]>([]);

  const [carId, setCarId] = useState("");

  const [odoStart, setOdoStart] = useState("");
  const [odoStartPhoto, setOdoStartPhoto] = useState<string | null>(null);
  const [odoEnd, setOdoEnd] = useState("");
  const [odoEndPhoto, setOdoEndPhoto] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [plans, setPlans] = useState<ObjPlan[]>([]);
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);

  // Who is currently physically in the car during the drive.
  const [onboard, setOnboard] = useState<string[]>([]);
  const [pickerFor, setPickerFor] = useState<{ objectId: string; mode: "drop" | "pickup" } | null>(null);
  const [pickerSelected, setPickerSelected] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ km: number; tripClass: string } | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
  }, []);

  function employeeName(id: string) {
    return employees.find((e) => e.id === id)?.name ?? id;
  }

  async function uploadPhoto(file: File, which: "start" | "end") {
    setUploadingPhoto(true);
    setError(null);
    try {
      const res = await api.upload<{ url: string }>("/api/road-timesheet/photo", file);
      if (which === "start") setOdoStartPhoto(res.url);
      else setOdoEndPhoto(res.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingPhoto(false);
    }
  }

  // --- PICK_OBJECTS helpers ---
  function toggleRouteObject(obj: WorkObject) {
    setPlans((prev) => {
      const exists = prev.find((p) => p.objectId === obj.id);
      if (exists) return prev.filter((p) => p.objectId !== obj.id);
      return [...prev, { objectId: obj.id, objectName: obj.name, works: [], sessions: [] }];
    });
  }

  // --- PLAN helpers ---
  function toggleWork(objectId: string, work: Work) {
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const has = p.works.some((w) => w.workId === work.id);
        return {
          ...p,
          works: has ? p.works.filter((w) => w.workId !== work.id) : [...p.works, { workId: work.id, workName: work.name, volume: "" }],
        };
      }),
    );
  }

  function setVolume(objectId: string, workId: string, volume: string) {
    setPlans((prev) =>
      prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: p.works.map((w) => (w.workId === workId ? { ...w, volume } : w)) })),
    );
  }

  const missingVolumeCount = plans.reduce((acc, p) => acc + p.works.filter((w) => !w.volume || w.volume === "?").length, 0);

  // --- DRIVE helpers ---
  function droppedAt(objectId: string) {
    const plan = plans.find((p) => p.objectId === objectId);
    return (plan?.sessions ?? []).filter((s) => !s.pickedUpAt);
  }

  function openPicker(objectId: string, mode: "drop" | "pickup") {
    setPickerFor({ objectId, mode });
    setPickerSelected([]);
  }

  function confirmPicker() {
    if (!pickerFor || !pickerSelected.length) {
      setPickerFor(null);
      return;
    }
    const now = new Date().toISOString();

    if (pickerFor.mode === "drop") {
      setPlans((prev) =>
        prev.map((p) =>
          p.objectId !== pickerFor.objectId
            ? p
            : {
                ...p,
                sessions: [
                  ...p.sessions,
                  ...pickerSelected.map((employeeId) => ({ employeeId, employeeName: employeeName(employeeId), droppedAt: now })),
                ],
              },
        ),
      );
      setOnboard((prev) => prev.filter((id) => !pickerSelected.includes(id)));
    } else {
      setPlans((prev) =>
        prev.map((p) =>
          p.objectId !== pickerFor.objectId
            ? p
            : {
                ...p,
                sessions: p.sessions.map((s) =>
                  pickerSelected.includes(s.employeeId) && !s.pickedUpAt ? { ...s, pickedUpAt: now } : s,
                ),
              },
        ),
      );
      setOnboard((prev) => [...new Set([...prev, ...pickerSelected])]);
    }

    setPickerFor(null);
    setPickerSelected([]);
  }

  function startDrive() {
    setOnboard(employeeIds);
    setStep("DRIVE");
  }

  const everyoneBack = onboard.length === employeeIds.length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ km: number; tripClass: string }>("/api/road-timesheet", {
        date: todayISO(),
        carId,
        odoStart: Number(odoStart),
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
        employeeIds,
        objects: plans.map((p) => ({
          objectId: p.objectId,
          objectName: p.objectName,
          works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?" })),
          sessions: p.sessions,
        })),
      });
      setResult(res);
      setStep("DONE");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (step === "DONE" && result) {
    return (
      <div>
        <div className="header">
          <h1>✅ День збережено</h1>
        </div>
        <div className="empty-state">
          Поїздка: {result.km} км · клас {result.tripClass}
        </div>
        <MainButton text="До меню" onClick={onBack} />
      </div>
    );
  }

  const backTargets: Partial<Record<Step, Step>> = {
    ODO_START: "PICK_CAR",
    PICK_PEOPLE: "ODO_START",
    PICK_OBJECTS: "PICK_PEOPLE",
    PLAN: "PICK_OBJECTS",
    READY: "PLAN",
    ODO_END: "DRIVE",
    REVIEW: "ODO_END",
  };

  return (
    <div>
      <BackRow onBack={() => (backTargets[step] ? setStep(backTargets[step]!) : onBack())} />
      <div className="header">
        <h1>🚗 Дорожній табель</h1>
        <div className="hint">{todayISO()}</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {step === "PICK_CAR" && (
        <>
          <div className="section-title">Обери авто</div>
          <div className="list">
            {cars.map((c) => (
              <button key={c.id} className={`cell ${carId === c.id ? "selected" : ""}`} onClick={() => setCarId(c.id)}>
                <span className="cell-title">{c.name}</span>
                <span className="cell-sub">{c.plate}</span>
              </button>
            ))}
          </div>
          <MainButton text="Далі" onClick={() => setStep("ODO_START")} disabled={!carId} />
        </>
      )}

      {step === "ODO_START" && (
        <>
          <div className="section-title">Одометр на старті</div>
          <div className="field">
            <label>Показник (км)</label>
            <input type="number" value={odoStart} onChange={(e) => setOdoStart(e.target.value)} />
          </div>
          <div className="field">
            <label>Фото спідометра (необовʼязково)</label>
            {odoStartPhoto ? (
              <div className="badge ok">📷 Фото додано</div>
            ) : (
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0], "start")}
              />
            )}
          </div>
          <MainButton
            text={uploadingPhoto ? "Завантаження фото…" : "Далі"}
            onClick={() => setStep("PICK_PEOPLE")}
            disabled={!odoStart || uploadingPhoto}
          />
        </>
      )}

      {step === "PICK_PEOPLE" && (
        <>
          <div className="section-title">Люди в поїздці</div>
          <div className="chip-row">
            {employees.map((emp) => (
              <div
                key={emp.id}
                className={`chip ${employeeIds.includes(emp.id) ? "selected" : ""}`}
                onClick={() => setEmployeeIds((prev) => (prev.includes(emp.id) ? prev.filter((x) => x !== emp.id) : [...prev, emp.id]))}
              >
                {emp.name}
              </div>
            ))}
          </div>
          <MainButton text="Далі" onClick={() => setStep("PICK_OBJECTS")} disabled={!employeeIds.length} />
        </>
      )}

      {step === "PICK_OBJECTS" && (
        <>
          <div className="section-title">Обʼєкти маршруту</div>
          <div className="chip-row">
            {objects.map((obj) => (
              <div key={obj.id} className={`chip ${plans.some((p) => p.objectId === obj.id) ? "selected" : ""}`} onClick={() => toggleRouteObject(obj)}>
                {obj.name}
              </div>
            ))}
          </div>
          <MainButton text="Далі — взяти роботи" onClick={() => setStep("PLAN")} disabled={!plans.length} />
        </>
      )}

      {step === "PLAN" && (
        <>
          <div className="section-title">Роботи на кожному обʼєкті{missingVolumeCount > 0 ? " (🟡 є незаповнені обсяги)" : ""}</div>
          {plans.map((plan) => (
            <div key={plan.objectId} className="list" style={{ marginTop: 8 }}>
              <button className="cell" onClick={() => setOpenObjectId(openObjectId === plan.objectId ? null : plan.objectId)}>
                <span className="cell-title">📍 {plan.objectName}</span>
                <span className={`badge ${plan.works.length && plan.works.every((w) => w.volume && w.volume !== "?") ? "ok" : "warn"}`}>
                  {plan.works.length} робіт
                </span>
              </button>

              {openObjectId === plan.objectId && (
                <div style={{ padding: "0 16px 16px" }}>
                  <div className="section-title" style={{ padding: "8px 0" }}>
                    Обери роботи
                  </div>
                  <div className="chip-row" style={{ padding: 0 }}>
                    {works.map((w) => (
                      <div
                        key={w.id}
                        className={`chip ${plan.works.some((pw) => pw.workId === w.id) ? "selected" : ""}`}
                        onClick={() => toggleWork(plan.objectId, w)}
                      >
                        {w.name}
                      </div>
                    ))}
                  </div>

                  {plan.works.length > 0 && (
                    <>
                      <div className="section-title" style={{ padding: "8px 0" }}>
                        Обсяги
                      </div>
                      {plan.works.map((w) => (
                        <div className="field" key={w.workId} style={{ margin: "8px 0" }}>
                          <label>{w.workName}</label>
                          <input
                            placeholder='Обсяг або "?", якщо ще невідомо'
                            value={w.volume}
                            onChange={(e) => setVolume(plan.objectId, w.workId, e.target.value)}
                          />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <MainButton text="Готово — до виїзду" onClick={() => setStep("READY")} />
        </>
      )}

      {step === "READY" && (
        <>
          <div className="section-title">Готовність до виїзду</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">🚙 Авто</span>
              <span className="cell-sub">{cars.find((c) => c.id === carId)?.name}</span>
            </div>
            <div className="cell">
              <span className="cell-title">👥 Людей</span>
              <span className="cell-sub">{employeeIds.length}</span>
            </div>
            <div className="cell">
              <span className="cell-title">📍 Обʼєктів</span>
              <span className="cell-sub">{plans.length}</span>
            </div>
          </div>
          <MainButton text="🚗 Виїхати" onClick={startDrive} />
        </>
      )}

      {step === "DRIVE" && (
        <>
          <div className="section-title">🚗 В дорозі</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">У машині</span>
              <span className="cell-sub">{onboard.length ? onboard.map(employeeName).join(", ") : "— нікого —"}</span>
            </div>
          </div>

          <div className="section-title">Обʼєкти</div>
          {plans.map((plan) => {
            const dropped = droppedAt(plan.objectId);
            return (
              <div key={plan.objectId} className="list" style={{ marginTop: 8 }}>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">📍 {plan.objectName}</span>
                  {dropped.length > 0 && <span className="badge ok">{dropped.length} на обʼєкті</span>}
                </div>
                {dropped.length > 0 && (
                  <div style={{ padding: "0 16px 12px" }} className="hint">
                    {dropped.map((s) => (
                      <div key={s.employeeId}>
                        {s.employeeName} — {fmtElapsed(s.droppedAt)}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, padding: "0 16px 16px" }}>
                  <button className="chip" onClick={() => openPicker(plan.objectId, "drop")} disabled={!onboard.length}>
                    👥 Висадити тут
                  </button>
                  <button className="chip" onClick={() => openPicker(plan.objectId, "pickup")} disabled={!dropped.length}>
                    🔼 Забрати
                  </button>
                </div>
              </div>
            );
          })}

          {pickerFor && (
            <div className="list" style={{ marginTop: 8 }}>
              <div className="section-title" style={{ padding: "8px 0 0" }}>
                {pickerFor.mode === "drop" ? "Кого висадити тут" : "Кого забрати"}
              </div>
              <div className="chip-row">
                {(pickerFor.mode === "drop" ? onboard : droppedAt(pickerFor.objectId).map((s) => s.employeeId)).map((id) => (
                  <div
                    key={id}
                    className={`chip ${pickerSelected.includes(id) ? "selected" : ""}`}
                    onClick={() => setPickerSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                  >
                    {employeeName(id)}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, padding: "8px 16px 16px" }}>
                <button className="chip" onClick={() => setPickerFor(null)}>
                  Скасувати
                </button>
                <button className="chip selected" onClick={confirmPicker}>
                  Підтвердити
                </button>
              </div>
            </div>
          )}

          <MainButton text="🏁 Всі зібрані — їхати назад" onClick={() => setStep("ODO_END")} disabled={!everyoneBack} />
        </>
      )}

      {step === "ODO_END" && (
        <>
          <div className="section-title">Одометр на фініші</div>
          <div className="field">
            <label>Показник (км)</label>
            <input type="number" value={odoEnd} onChange={(e) => setOdoEnd(e.target.value)} />
          </div>
          <div className="field">
            <label>Фото спідометра (необовʼязково)</label>
            {odoEndPhoto ? (
              <div className="badge ok">📷 Фото додано</div>
            ) : (
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0], "end")}
              />
            )}
          </div>
          <MainButton
            text={uploadingPhoto ? "Завантаження фото…" : "Далі — підсумок"}
            onClick={() => setStep("REVIEW")}
            disabled={!odoEnd || uploadingPhoto}
          />
        </>
      )}

      {step === "REVIEW" && (
        <>
          <div className="section-title">Підсумок дня</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">🚙 {cars.find((c) => c.id === carId)?.name}</span>
              <span className="cell-sub">
                {odoStart} → {odoEnd} км
              </span>
            </div>
          </div>

          {plans.map((plan) => (
            <div key={plan.objectId} className="list" style={{ marginTop: 8 }}>
              <div className="cell" style={{ cursor: "default" }}>
                <span className="cell-title">📍 {plan.objectName}</span>
              </div>
              <div style={{ padding: "0 16px 12px" }} className="hint">
                {plan.works.map((w) => (
                  <div key={w.workId}>
                    {w.workName}: {w.volume || "?"}
                  </div>
                ))}
                {[...new Set(plan.sessions.map((s) => s.employeeId))].map((empId) => {
                  const totalMs = plan.sessions
                    .filter((s) => s.employeeId === empId)
                    .reduce((acc, s) => acc + (new Date(s.pickedUpAt ?? new Date().toISOString()).getTime() - new Date(s.droppedAt).getTime()), 0);
                  return (
                    <div key={empId}>
                      {employeeName(empId)}: {Math.round((totalMs / 3_600_000) * 100) / 100} год
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <MainButton text={saving ? "Збереження…" : "💾 Зберегти день"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
