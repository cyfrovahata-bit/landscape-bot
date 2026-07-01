import { useEffect, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

// Mirrors the real day-in-the-life sequence a brigadier uses (refined after
// watching the actual bot flow): pick car (reserved for the day) -> record
// start odometer (+optional photo) -> pick people by brigade -> pick route
// objects by city -> plan which works are expected per object -> drive out ->
// at each stop: drop people off, assign them to specific planned works, then
// finish (enter volumes done + per-person coefficients) -> return to base ->
// record end odometer -> brigadier reviews everything once more -> submit for
// admin approval.
type Step =
  | "PICK_CAR"
  | "ODO_START"
  | "PICK_PEOPLE"
  | "PICK_OBJECTS"
  | "PLAN"
  | "READY"
  | "DRIVE"
  | "ARRIVE"
  | "ODO_END"
  | "REVIEW"
  | "DONE";

type Coef = { employeeId: string; disciplineCoef: number; productivityCoef: number };
// A work actually done at an object: who did it and how much of it got done.
type WorkAssignment = { workId: string; workName: string; employeeIds: string[]; volume: string };
type ObjPlan = {
  objectId: string;
  objectName: string;
  plannedWorkIds: string[]; // chosen before departure -- what's expected here
  droppedEmployeeIds: string[]; // everyone who was dropped off here over the trip (kept for the record even after finishing)
  droppedAt?: string;
  finished: boolean;
  finishedAt?: string;
  assignments: WorkAssignment[]; // filled in when finishing work here
  coefs: Coef[];
};

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

const NO_BRIGADE = "__NO_BRIGADE__";
const NO_CITY = "__NO_CITY__";

// Mirrors the bot's brigade grouping (roadTimesheet.domain.ts getPeopleBrigadeGroups):
// group by brigadeId, title after the brigade's own "бригадир", "Без бригади" last.
function groupByBrigade(employees: Employee[]) {
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

// Mirrors the bot's category grouping for the works picker.
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

// Mirrors the bot's address grouping (roadTimesheet.domain.ts getObjectAddressGroups).
function groupByCity(objects: WorkObject[]) {
  const map = new Map<string, WorkObject[]>();
  for (const o of objects) {
    const city = o.address?.trim() || NO_CITY;
    const list = map.get(city) ?? [];
    list.push(o);
    map.set(city, list);
  }
  return [...map.entries()]
    .map(([city, items]) => ({ city, title: city === NO_CITY ? "Без адреси" : city, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => {
      if (a.city === NO_CITY) return 1;
      if (b.city === NO_CITY) return -1;
      return a.title.localeCompare(b.title);
    });
}

function fmtElapsed(fromISO: string, toISO?: string) {
  const ms = new Date(toISO ?? new Date().toISOString()).getTime() - new Date(fromISO).getTime();
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
  const [takenCarIds, setTakenCarIds] = useState<Set<string>>(new Set());

  const [carId, setCarId] = useState("");

  const [odoStart, setOdoStart] = useState("");
  const [odoStartPhoto, setOdoStartPhoto] = useState<string | null>(null);
  const [odoEnd, setOdoEnd] = useState("");
  const [odoEndPhoto, setOdoEndPhoto] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [expandedBrigadeId, setExpandedBrigadeId] = useState<string | null>(null);
  const [expandedCityId, setExpandedCityId] = useState<string | null>(null);

  const [plans, setPlans] = useState<ObjPlan[]>([]);
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Who is currently physically in the car during the drive.
  const [onboard, setOnboard] = useState<string[]>([]);
  // The stop currently being handled (Зупинитися -> pick object+people -> assign works -> finish).
  const [arriveObjectId, setArriveObjectId] = useState<string | null>(null);
  const [arriveDropSelected, setArriveDropSelected] = useState<string[]>([]);
  const [arriveWorkOpenId, setArriveWorkOpenId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
    api
      .get<{ taken: { carId: string; foremanTgId: string }[] }>(`/api/road-timesheet/car-status?date=${todayISO()}`)
      .then((res) => setTakenCarIds(new Set(res.taken.map((t) => t.carId))))
      .catch(() => {});
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
      return [
        ...prev,
        { objectId: obj.id, objectName: obj.name, plannedWorkIds: [], droppedEmployeeIds: [], finished: false, assignments: [], coefs: [] },
      ];
    });
  }

  // --- PLAN helpers ---
  function toggleWork(objectId: string, work: Work) {
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const has = p.plannedWorkIds.includes(work.id);
        return { ...p, plannedWorkIds: has ? p.plannedWorkIds.filter((id) => id !== work.id) : [...p.plannedWorkIds, work.id] };
      }),
    );
  }

  function selectWholeCategory(objectId: string, categoryWorks: Work[]) {
    setPlans((prev) =>
      prev.map((p) => (p.objectId !== objectId ? p : { ...p, plannedWorkIds: [...new Set([...p.plannedWorkIds, ...categoryWorks.map((w) => w.id)])] })),
    );
  }

  const missingPlanCount = plans.filter((p) => !p.plannedWorkIds.length).length;

  // --- DRIVE / ARRIVE helpers ---
  const unfinishedPlans = plans.filter((p) => !p.finished);
  const everyoneBack = onboard.length === employeeIds.length;

  function startDrive() {
    setOnboard(employeeIds);
    setStep("DRIVE");
  }

  function startArrive() {
    setArriveObjectId(null);
    setArriveDropSelected([]);
    setArriveWorkOpenId(null);
    setStep("ARRIVE");
  }

  function confirmDrop() {
    if (!arriveObjectId || !arriveDropSelected.length) return;
    const now = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) => (p.objectId !== arriveObjectId ? p : { ...p, droppedEmployeeIds: arriveDropSelected, droppedAt: now })),
    );
    setOnboard((prev) => prev.filter((id) => !arriveDropSelected.includes(id)));
  }

  function currentArrivePlan() {
    return plans.find((p) => p.objectId === arriveObjectId) ?? null;
  }

  function toggleWorkAssignee(workId: string, workName: string, employeeId: string) {
    if (!arriveObjectId) return;
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== arriveObjectId) return p;
        const existing = p.assignments.find((a) => a.workId === workId);
        if (!existing) {
          return { ...p, assignments: [...p.assignments, { workId, workName, employeeIds: [employeeId], volume: "" }] };
        }
        const has = existing.employeeIds.includes(employeeId);
        const nextEmployeeIds = has ? existing.employeeIds.filter((id) => id !== employeeId) : [...existing.employeeIds, employeeId];
        return {
          ...p,
          assignments: nextEmployeeIds.length
            ? p.assignments.map((a) => (a.workId === workId ? { ...a, employeeIds: nextEmployeeIds } : a))
            : p.assignments.filter((a) => a.workId !== workId),
        };
      }),
    );
  }

  function setAssignmentVolume(workId: string, volume: string) {
    if (!arriveObjectId) return;
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== arriveObjectId ? p : { ...p, assignments: p.assignments.map((a) => (a.workId === workId ? { ...a, volume } : a)) },
      ),
    );
  }

  function setArriveCoef(employeeId: string, patch: Partial<Coef>) {
    if (!arriveObjectId) return;
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== arriveObjectId) return p;
        const existing = p.coefs.find((c) => c.employeeId === employeeId);
        const next = { ...(existing ?? { employeeId, disciplineCoef: 1, productivityCoef: 1 }), ...patch };
        return { ...p, coefs: existing ? p.coefs.map((c) => (c.employeeId === employeeId ? next : c)) : [...p.coefs, next] };
      }),
    );
  }

  function coefFor(plan: ObjPlan, employeeId: string): Coef {
    return plan.coefs.find((c) => c.employeeId === employeeId) ?? { employeeId, disciplineCoef: 1, productivityCoef: 1 };
  }

  function finishArriveObject() {
    if (!arriveObjectId) return;
    const now = new Date().toISOString();
    const plan = currentArrivePlan();
    if (plan) setOnboard((prev) => [...new Set([...prev, ...plan.droppedEmployeeIds])]);
    setPlans((prev) => prev.map((p) => (p.objectId !== arriveObjectId ? p : { ...p, finished: true, finishedAt: now })));
    setArriveObjectId(null);
    setArriveDropSelected([]);
    setArriveWorkOpenId(null);
    setStep("DRIVE");
  }

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
          works: p.assignments.map((a) => ({ workId: a.workId, workName: a.workName, volume: a.volume || "?", employeeIds: a.employeeIds })),
          sessions: p.droppedEmployeeIds.map((employeeId) => ({
            employeeId,
            employeeName: employeeName(employeeId),
            droppedAt: p.droppedAt!,
            pickedUpAt: p.finishedAt,
          })),
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
          <h1>✅ Відправлено на підтвердження</h1>
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
            {cars.map((c) => {
              const taken = takenCarIds.has(c.id);
              return (
                <button
                  key={c.id}
                  className={`cell ${carId === c.id ? "selected" : ""}`}
                  onClick={() => !taken && setCarId(c.id)}
                  disabled={taken}
                  style={taken ? { opacity: 0.4 } : undefined}
                >
                  <span className="cell-title">{c.name}</span>
                  {taken ? <span className="badge warn">зайняте</span> : <span className="cell-sub">{c.plate}</span>}
                </button>
              );
            })}
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
          {groupByBrigade(employees).map((group) => {
            const expanded = expandedBrigadeId === group.id;
            const pickedCount = group.members.filter((m) => employeeIds.includes(m.id)).length;
            return (
              <div key={group.id} className="list" style={{ marginTop: 8 }}>
                <button className="cell" onClick={() => setExpandedBrigadeId(expanded ? null : group.id)}>
                  <span className="cell-title">👥 {group.title}</span>
                  <span className={`badge ${pickedCount ? "ok" : ""}`}>
                    {pickedCount}/{group.members.length}
                  </span>
                </button>
                {expanded && (
                  <div style={{ padding: "0 16px 16px" }}>
                    <div className="chip-row" style={{ padding: "8px 0" }}>
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
                    <button
                      className="chip"
                      onClick={() => setEmployeeIds((prev) => [...new Set([...prev, ...group.members.map((m) => m.id)])])}
                    >
                      ✅ Обрати всіх
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <MainButton text="Далі" onClick={() => setStep("PICK_OBJECTS")} disabled={!employeeIds.length} />
        </>
      )}

      {step === "PICK_OBJECTS" && (
        <>
          {groupByCity(objects).map((group) => {
            const expanded = expandedCityId === group.city;
            const pickedCount = group.items.filter((o) => plans.some((p) => p.objectId === o.id)).length;
            return (
              <div key={group.city} className="list" style={{ marginTop: 8 }}>
                <button className="cell" onClick={() => setExpandedCityId(expanded ? null : group.city)}>
                  <span className="cell-title">🏙 {group.title}</span>
                  <span className={`badge ${pickedCount ? "ok" : ""}`}>
                    {pickedCount}/{group.items.length}
                  </span>
                </button>
                {expanded && (
                  <div className="chip-row" style={{ padding: "8px 16px 16px" }}>
                    {group.items.map((obj) => (
                      <div key={obj.id} className={`chip ${plans.some((p) => p.objectId === obj.id) ? "selected" : ""}`} onClick={() => toggleRouteObject(obj)}>
                        {obj.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <MainButton text="Далі — призначити роботи" onClick={() => setStep("PLAN")} disabled={!plans.length} />
        </>
      )}

      {step === "PLAN" && (
        <>
          <div className="section-title">Роботи на кожному обʼєкті{missingPlanCount > 0 ? " (🟡 є обʼєкти без робіт)" : ""}</div>
          {plans.map((plan) => (
            <div key={plan.objectId} className="list" style={{ marginTop: 8 }}>
              <button className="cell" onClick={() => setOpenObjectId(openObjectId === plan.objectId ? null : plan.objectId)}>
                <span className="cell-title">📍 {plan.objectName}</span>
                <span className={`badge ${plan.plannedWorkIds.length ? "ok" : "warn"}`}>{plan.plannedWorkIds.length} робіт</span>
              </button>

              {openObjectId === plan.objectId && (
                <div style={{ padding: "0 16px 16px" }}>
                  {groupByCategory(works).map((group) => {
                    const selectedInGroup = group.items.filter((w) => plan.plannedWorkIds.includes(w.id)).length;
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
                          <div style={{ padding: "8px 16px 16px" }}>
                            <div className="chip-row" style={{ padding: 0 }}>
                              {group.items.map((w) => (
                                <div
                                  key={w.id}
                                  className={`chip ${plan.plannedWorkIds.includes(w.id) ? "selected" : ""}`}
                                  onClick={() => toggleWork(plan.objectId, w)}
                                >
                                  {w.name}
                                </div>
                              ))}
                            </div>
                            <button className="chip" style={{ marginTop: 8 }} onClick={() => selectWholeCategory(plan.objectId, group.items)}>
                              ✅ Обрати всю категорію
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          <MainButton text="Готово — до виїзду" onClick={() => setStep("READY")} disabled={plans.some((p) => !p.plannedWorkIds.length)} />
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

          <div className="section-title">Маршрут</div>
          <div className="list">
            {plans.map((p) => (
              <div key={p.objectId} className="cell" style={{ cursor: "default" }}>
                <span className="cell-title">📍 {p.objectName}</span>
                <span className={`badge ${p.finished ? "ok" : ""}`}>{p.finished ? "завершено" : "заплановано"}</span>
              </div>
            ))}
          </div>

          <MainButton text="🛑 Зупинитися" onClick={startArrive} disabled={!unfinishedPlans.length || !onboard.length} />
          <div style={{ height: 8 }} />
          <MainButton text="🏁 Повернутися на базу" onClick={() => setStep("ODO_END")} disabled={!everyoneBack} />
        </>
      )}

      {step === "ARRIVE" && !arriveObjectId && (
        <>
          <div className="section-title">На якому обʼєкті зупинились?</div>
          <div className="list">
            {unfinishedPlans.map((p) => (
              <button key={p.objectId} className="cell" onClick={() => setArriveObjectId(p.objectId)}>
                <span className="cell-title">📍 {p.objectName}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === "ARRIVE" && arriveObjectId && currentArrivePlan() && !currentArrivePlan()!.droppedAt && (
        <>
          <div className="section-title">Кого залишити на обʼєкті «{currentArrivePlan()!.objectName}»</div>
          <div className="chip-row">
            {onboard.map((id) => (
              <div
                key={id}
                className={`chip ${arriveDropSelected.includes(id) ? "selected" : ""}`}
                onClick={() => setArriveDropSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
              >
                {employeeName(id)}
              </div>
            ))}
          </div>
          <MainButton text="Підтвердити" onClick={confirmDrop} disabled={!arriveDropSelected.length} />
        </>
      )}

      {step === "ARRIVE" && arriveObjectId && currentArrivePlan()?.droppedAt && (
        <>
          {(() => {
            const plan = currentArrivePlan()!;
            return (
              <>
                <div className="section-title">Роботи на «{plan.objectName}»</div>
                <div className="hint" style={{ padding: "0 16px 8px" }}>
                  Натисни на роботу, щоб призначити людей, які нею займаються
                </div>
                <div className="list">
                  {plan.plannedWorkIds.map((workId) => {
                    const work = works.find((w) => w.id === workId);
                    if (!work) return null;
                    const assignment = plan.assignments.find((a) => a.workId === workId);
                    const open = arriveWorkOpenId === workId;
                    return (
                      <div key={workId}>
                        <button className="cell" onClick={() => setArriveWorkOpenId(open ? null : workId)}>
                          <span className="cell-title">{work.name}</span>
                          <span className={`badge ${assignment?.employeeIds.length ? "ok" : ""}`}>
                            {assignment?.employeeIds.length ?? 0} люд.
                          </span>
                        </button>
                        {open && (
                          <div className="chip-row" style={{ padding: "8px 16px" }}>
                            {plan.droppedEmployeeIds.map((empId) => (
                              <div
                                key={empId}
                                className={`chip ${assignment?.employeeIds.includes(empId) ? "selected" : ""}`}
                                onClick={() => toggleWorkAssignee(workId, work.name, empId)}
                              >
                                {employeeName(empId)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <MainButton text="Далі — завершити роботи" onClick={() => setArriveWorkOpenId("__FINISH__")} disabled={!plan.assignments.length} />
              </>
            );
          })()}
        </>
      )}

      {step === "ARRIVE" && arriveObjectId && arriveWorkOpenId === "__FINISH__" && currentArrivePlan() && (
        <>
          {(() => {
            const plan = currentArrivePlan()!;
            return (
              <>
                <div className="section-title">Обсяги виконаних робіт</div>
                {plan.assignments.map((a) => (
                  <div className="field" key={a.workId}>
                    <label>
                      {a.workName} <span className="hint">({a.employeeIds.map(employeeName).join(", ")})</span>
                    </label>
                    <input
                      placeholder='Обсяг, наприклад "50 пнів" або "30 м²"'
                      value={a.volume}
                      onChange={(e) => setAssignmentVolume(a.workId, e.target.value)}
                    />
                  </div>
                ))}

                <div className="section-title">Коефіцієнти (дисципліна × продуктивність)</div>
                {plan.droppedEmployeeIds.map((empId) => {
                  const coef = coefFor(plan, empId);
                  return (
                    <div key={empId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 16px" }}>
                      <span style={{ flex: 1, fontSize: 14 }}>
                        {employeeName(empId)} <span className="hint">({fmtElapsed(plan.droppedAt!)})</span>
                      </span>
                      <input
                        type="number"
                        step="0.1"
                        style={{ width: 56 }}
                        value={coef.disciplineCoef}
                        title="Коефіцієнт дисципліни"
                        onChange={(e) => setArriveCoef(empId, { disciplineCoef: Number(e.target.value) || 1 })}
                      />
                      <input
                        type="number"
                        step="0.1"
                        style={{ width: 56 }}
                        value={coef.productivityCoef}
                        title="Коефіцієнт продуктивності"
                        onChange={(e) => setArriveCoef(empId, { productivityCoef: Number(e.target.value) || 1 })}
                      />
                    </div>
                  );
                })}

                <MainButton text="✅ Завершити роботи на обʼєкті" onClick={finishArriveObject} />
              </>
            );
          })()}
        </>
      )}

      {step === "ODO_END" && (
        <>
          <div className="section-title">Одометр на фініші (приїхали на базу)</div>
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
            text={uploadingPhoto ? "Завантаження фото…" : "Далі — перевірити день"}
            onClick={() => setStep("REVIEW")}
            disabled={!odoEnd || uploadingPhoto}
          />
        </>
      )}

      {step === "REVIEW" && (
        <>
          <div className="section-title">Перевір день перед відправкою</div>
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
                {plan.assignments.map((a) => (
                  <div key={a.workId}>
                    {a.workName}: {a.volume || "?"} — {a.employeeIds.map(employeeName).join(", ")}
                  </div>
                ))}
                {plan.droppedEmployeeIds.map((empId) => {
                  const coef = coefFor(plan, empId);
                  return (
                    <div key={empId}>
                      {employeeName(empId)}: {fmtElapsed(plan.droppedAt!, plan.finishedAt)} · коеф {coef.disciplineCoef}×{coef.productivityCoef}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <MainButton text={saving ? "Відправлення…" : "📤 Відправити на підтвердження"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
