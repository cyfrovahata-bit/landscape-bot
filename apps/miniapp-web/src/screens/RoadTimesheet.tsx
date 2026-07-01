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
// disciplineCoef/productivityCoef: per-employee-per-object multipliers (default 1.0), same
// as the bot -- they only affect how a worker's *share* of the object's fund is split against
// the other workers there, not brigadier/senior shares or the fund total.
type Coef = { employeeId: string; disciplineCoef: number; productivityCoef: number };
type ObjPlan = { objectId: string; objectName: string; works: ObjWork[]; sessions: Session[]; coefs: Coef[] };

type SalaryRow = { employeeId: string; employeeName: string; hours: number; coefTotal: number; points: number; pay: number };
type SalaryPack = { objectId: string; objectName: string; objectTotal: number; sumPoints: number; rows: SalaryRow[] };
type SaveResult = {
  km: number;
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
  brigadierEmployeeId: string;
  seniorEmployeeIds: string[];
};

function fmtElapsed(fromISO: string) {
  const ms = Date.now() - new Date(fromISO).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} хв`;
  return `${Math.floor(mins / 60)} год ${mins % 60} хв`;
}

// Mirrors the bot's brigade grouping for the people picker (roadTimesheet.domain.ts
// getPeopleBrigadeGroups): group by brigadeId, title the group after its brigadier's
// position text, "Без бригади" (no brigade) last.
function groupByBrigade(employees: Employee[]) {
  const NO_BRIGADE = "__NO_BRIGADE__";
  const byBrigade = new Map<string, Employee[]>();
  for (const e of employees) {
    const id = e.brigadeId?.trim() || NO_BRIGADE;
    const list = byBrigade.get(id) ?? [];
    list.push(e);
    byBrigade.set(id, list);
  }

  const groups = [...byBrigade.entries()].map(([id, members]) => {
    const leader = members.find((e) => e.position?.trim().toLowerCase().startsWith("бригадир"));
    const title =
      id === NO_BRIGADE
        ? "Без бригади"
        : leader
          ? leader.position!.replace(/^бригадир\s*/i, "").trim() || leader.position!
          : id;
    return { id, title, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) };
  });

  return groups.sort((a, b) => {
    if (a.id === NO_BRIGADE) return 1;
    if (b.id === NO_BRIGADE) return -1;
    return a.title.localeCompare(b.title);
  });
}

// Mirrors the bot's category grouping for the works picker (roadTimesheet.domain.ts
// workCategoryOf/getWorkCategories) -- with 600+ works, a flat list is unusable.
function groupByCategory(works: Work[]) {
  const map = new Map<string, Work[]>();
  for (const w of works) {
    const cat = w.category?.trim() || "Без категорії";
    const list = map.get(cat) ?? [];
    list.push(w);
    map.set(cat, list);
  }
  return [...map.entries()]
    .map(([category, items]) => ({ category, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.category.localeCompare(b.category));
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
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Who is currently physically in the car during the drive.
  const [onboard, setOnboard] = useState<string[]>([]);
  const [pickerFor, setPickerFor] = useState<{ objectId: string; mode: "drop" | "pickup" } | null>(null);
  const [pickerSelected, setPickerSelected] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

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
      return [...prev, { objectId: obj.id, objectName: obj.name, works: [], sessions: [], coefs: [] }];
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

  function coefFor(plan: ObjPlan, employeeId: string): Coef {
    return plan.coefs.find((c) => c.employeeId === employeeId) ?? { employeeId, disciplineCoef: 1, productivityCoef: 1 };
  }

  function setCoef(objectId: string, employeeId: string, patch: Partial<Coef>) {
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const existing = p.coefs.find((c) => c.employeeId === employeeId);
        const next = { ...(existing ?? { employeeId, disciplineCoef: 1, productivityCoef: 1 }), ...patch };
        return { ...p, coefs: existing ? p.coefs.map((c) => (c.employeeId === employeeId ? next : c)) : [...p.coefs, next] };
      }),
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
      const res = await api.post<SaveResult>("/api/road-timesheet", {
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
          coefs: p.coefs,
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
        <div className="list">
          <div className="cell">
            <span className="cell-title">🚙 Поїздка</span>
            <span className="cell-sub">
              {result.km} км · клас {result.tripClass}
            </span>
          </div>
          <div className="cell">
            <span className="cell-title">💸 Доплата за виїзд</span>
            <span className="cell-sub">{result.roadAllowance.perPerson} грн/особу</span>
          </div>
        </div>

        {result.brigadierEmployeeId && (
          <div className="hint" style={{ padding: "8px 16px" }}>
            Бригадир поїздки: {employeeName(result.brigadierEmployeeId)}
            {result.seniorEmployeeIds.length > 0 && ` · Старші: ${result.seniorEmployeeIds.map(employeeName).join(", ")}`}
          </div>
        )}

        <div className="section-title">Фонд по обʼєктах</div>
        {result.salaryPacks.map((pack) => (
          <div key={pack.objectId} className="list" style={{ marginTop: 8 }}>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">📍 {pack.objectName}</span>
              <span className="badge ok">{pack.objectTotal} грн</span>
            </div>
            <div style={{ padding: "0 16px 12px" }} className="hint">
              {pack.rows.map((r) => (
                <div key={r.employeeId}>
                  {r.employeeName}: {r.pay} грн
                </div>
              ))}
              {!pack.rows.length && "— без нарахувань —"}
            </div>
          </div>
        ))}

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
          {groupByBrigade(employees).map((group) => (
            <div key={group.id}>
              <div className="section-title">{group.title}</div>
              <div className="chip-row">
                {group.members.map((emp) => (
                  <div
                    key={emp.id}
                    className={`chip ${employeeIds.includes(emp.id) ? "selected" : ""}`}
                    onClick={() => setEmployeeIds((prev) => (prev.includes(emp.id) ? prev.filter((x) => x !== emp.id) : [...prev, emp.id]))}
                  >
                    {emp.name}
                  </div>
                ))}
              </div>
            </div>
          ))}
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
                    Обери роботи (по категоріях)
                  </div>
                  {groupByCategory(works).map((group) => {
                    const selectedInGroup = group.items.filter((w) => plan.works.some((pw) => pw.workId === w.id)).length;
                    const catKey = `${plan.objectId}::${group.category}`;
                    return (
                      <div key={group.category} className="list" style={{ margin: "6px 0" }}>
                        <button className="cell" onClick={() => setOpenCategory(openCategory === catKey ? null : catKey)}>
                          <span className="cell-title">📁 {group.category}</span>
                          <span className={`badge ${selectedInGroup ? "ok" : ""}`}>
                            {selectedInGroup}/{group.items.length}
                          </span>
                        </button>
                        {openCategory === catKey && (
                          <div className="chip-row">
                            {group.items.map((w) => (
                              <div
                                key={w.id}
                                className={`chip ${plan.works.some((pw) => pw.workId === w.id) ? "selected" : ""}`}
                                onClick={() => toggleWork(plan.objectId, w)}
                              >
                                {w.name}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

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

          {plans.map((plan) => {
            const workedEmployeeIds = [...new Set(plan.sessions.map((s) => s.employeeId))];
            return (
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
                </div>

                {workedEmployeeIds.length > 0 && (
                  <div style={{ padding: "0 16px 12px" }}>
                    <div className="section-title" style={{ padding: "0 0 6px" }}>
                      Коефіцієнти (дисципліна × продуктивність)
                    </div>
                    {workedEmployeeIds.map((empId) => {
                      const totalMs = plan.sessions
                        .filter((s) => s.employeeId === empId)
                        .reduce(
                          (acc, s) => acc + (new Date(s.pickedUpAt ?? new Date().toISOString()).getTime() - new Date(s.droppedAt).getTime()),
                          0,
                        );
                      const coef = coefFor(plan, empId);
                      return (
                        <div key={empId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                          <span style={{ flex: 1, fontSize: 14 }}>
                            {employeeName(empId)} <span className="hint">({Math.round((totalMs / 3_600_000) * 100) / 100} год)</span>
                          </span>
                          <input
                            type="number"
                            step="0.1"
                            style={{ width: 56 }}
                            value={coef.disciplineCoef}
                            onChange={(e) => setCoef(plan.objectId, empId, { disciplineCoef: Number(e.target.value) || 1 })}
                            title="Коефіцієнт дисципліни"
                          />
                          <input
                            type="number"
                            step="0.1"
                            style={{ width: 56 }}
                            value={coef.productivityCoef}
                            onChange={(e) => setCoef(plan.objectId, empId, { productivityCoef: Number(e.target.value) || 1 })}
                            title="Коефіцієнт продуктивності"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <MainButton text={saving ? "Збереження…" : "💾 Зберегти день"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
