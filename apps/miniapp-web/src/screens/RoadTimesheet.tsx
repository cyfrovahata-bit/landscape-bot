import { useEffect, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";
import { NumericKeypad } from "../components/NumericKeypad";

// Hub-based flow: after opening the road timesheet, the foreman lands on a HUB
// screen with three editable cards -- Авто, Люди, Обʼєкти та роботи. Each card
// opens its own sub-flow and returns back to HUB when done, so any parameter can
// be revisited/changed at any point before (or even after) departure. Once
// everything is filled in, "Виїхати" opens a final READY check, then DRIVE ->
// AT_OBJECT (per-object work tracking) -> RETURN -> REVIEW -> submit.
type Step =
  | "HUB"
  | "PICK_CAR"
  | "ODO_START"
  | "PICK_PEOPLE"
  | "PICK_OBJECTS"
  | "PLAN"
  | "PLAN_WORKS"
  | "PLAN_VOLUMES"
  | "READY"
  | "DRIVE"
  | "AT_OBJECT"
  | "RETURN"
  | "REVIEW"
  | "DONE";

type PlannedWork = { workId: string; workName: string; unit: string; volume: string };
type WorkSession = { workId: string; workName: string; employeeIds: string[]; startedAt: string; endedAt?: string };
type ObjPlan = {
  objectId: string;
  objectName: string;
  works: PlannedWork[];
  assignedEmployeeIds: string[]; // planned before departure
  here: string[]; // physically dropped off at this object right now
  sessions: WorkSession[];
  visited: boolean; // reached (formally, or via a quick drop-off during the drive)
};

type SalaryRow = { employeeId: string; employeeName: string; hours: number; coefTotal: number; points: number; pay: number };
type SalaryPack = { objectId: string; objectName: string; objectTotal: number; sumPoints: number; rows: SalaryRow[] };
type PayrollPreview = {
  km?: number;
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
  brigadierEmployeeId: string;
  seniorEmployeeIds: string[];
};

const UNITS = ["м²", "м", "пог.м", "шт"];

function employeeRole(emp: Employee): "бригадир" | "старший" | "робітник" {
  const pos = (emp.position ?? "").toLowerCase();
  if (pos.includes("бригадир")) return "бригадир";
  if (pos.includes("старш")) return "старший";
  return "робітник";
}

function groupByBrigade(employees: Employee[]) {
  const NO_BRIGADE = "__NO_BRIGADE__";
  const map = new Map<string, Employee[]>();
  for (const e of employees) {
    const id = e.brigadeId?.trim() || NO_BRIGADE;
    const list = map.get(id) ?? [];
    list.push(e);
    map.set(id, list);
  }
  return [...map.entries()]
    .map(([id, members]) => {
      const leader = members.find((e) => employeeRole(e) === "бригадир");
      const title = id === NO_BRIGADE ? "Без бригади" : leader ? leader.position!.replace(/^бригадир\s*/i, "").trim() || leader.position! : id;
      return { id, title, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) };
    })
    .sort((a, b) => (a.id === NO_BRIGADE ? 1 : b.id === NO_BRIGADE ? -1 : a.title.localeCompare(b.title)));
}

function groupByCity(objects: WorkObject[]) {
  const NO_CITY = "__NO_CITY__";
  const map = new Map<string, WorkObject[]>();
  for (const o of objects) {
    const city = (o.address ?? "").trim() || NO_CITY;
    const list = map.get(city) ?? [];
    list.push(o);
    map.set(city, list);
  }
  return [...map.entries()]
    .map(([id, members]) => ({ id, title: id === NO_CITY ? "Без адреси" : id, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.id === NO_CITY ? 1 : b.id === NO_CITY ? -1 : a.title.localeCompare(b.title)));
}

function fmtHMS(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function fmtHours(ms: number) {
  return Math.round((ms / 3_600_000) * 100) / 100;
}

export function RoadTimesheet({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<Step>("HUB");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [date] = useState(() => todayISO());

  // --- dictionaries ---
  const [cars, setCars] = useState<Car[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [objects, setObjects] = useState<WorkObject[]>([]);
  const [lastOdometer, setLastOdometer] = useState<Record<string, number>>({});
  const [takenCars, setTakenCars] = useState<Map<string, string>>(new Map());
  const [busyEmployees, setBusyEmployees] = useState<Map<string, string>>(new Map());

  // --- car / odometer ---
  const [carId, setCarId] = useState("");
  const [odoStart, setOdoStart] = useState("");
  const [odoStartPhoto, setOdoStartPhoto] = useState<string | null>(null);
  const [odoEnd, setOdoEnd] = useState("");
  const [odoEndPhoto, setOdoEndPhoto] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // --- people / objects ---
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [expandedBrigadeId, setExpandedBrigadeId] = useState<string | null>(null);
  const [objectSearch, setObjectSearch] = useState("");
  const [expandedCityId, setExpandedCityId] = useState<string | null>(null);
  const [plans, setPlans] = useState<ObjPlan[]>([]);

  // --- planning (works / people per object / volumes) ---
  const [planObjectId, setPlanObjectId] = useState<string | null>(null);
  const [planWorksSearch, setPlanWorksSearch] = useState("");
  const [planVolumeWorkId, setPlanVolumeWorkId] = useState<string | null>(null);
  const [volumeBuffer, setVolumeBuffer] = useState("");
  const [volumeUnit, setVolumeUnit] = useState("");

  // --- drive ---
  const [onboard, setOnboard] = useState<string[]>([]);
  const [tripStartedAt, setTripStartedAt] = useState<string | null>(null);
  const [driveDropTargetId, setDriveDropTargetId] = useState<string | null>(null);
  const [driveDropSelected, setDriveDropSelected] = useState<string[]>([]);

  // --- at object ---
  const [atObjectId, setAtObjectId] = useState<string | null>(null);
  const [startingWorkId, setStartingWorkId] = useState<string | null>(null);
  const [startPeopleSelected, setStartPeopleSelected] = useState<string[]>([]);
  const [finishingSessionKey, setFinishingSessionKey] = useState<string | null>(null);
  const [dropSelected, setDropSelected] = useState<string[]>([]);
  const [showDropPicker, setShowDropPicker] = useState(false);
  const [moveSelected, setMoveSelected] = useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PayrollPreview & { eventId: string }) | null>(null);
  const [preview, setPreview] = useState<PayrollPreview | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
    api
      .get<{ lastOdometer: Record<string, number> }>("/api/road-timesheet/cars-last-odometer")
      .then((res) => setLastOdometer(res.lastOdometer))
      .catch(() => {});
    api
      .get<{ taken: { carId: string; foremanName: string }[] }>(`/api/road-timesheet/car-status?date=${date}`)
      .then((res) => setTakenCars(new Map(res.taken.map((t) => [t.carId, t.foremanName]))))
      .catch(() => {});
    api
      .get<{ taken: { employeeId: string; foremanName: string }[] }>(`/api/road-timesheet/people-status?date=${date}`)
      .then((res) => setBusyEmployees(new Map(res.taken.map((t) => [t.employeeId, t.foremanName]))))
      .catch(() => {});
  }, [date]);

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

  async function reserveIfPossible() {
    if (!carId || !employeeIds.length) return;
    try {
      await api.post("/api/road-timesheet/reserve", { date, carId, employeeIds });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---------- people helpers ----------
  function toggleEmployee(id: string) {
    if (busyEmployees.has(id)) return;
    setEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // ---------- objects helpers ----------
  function toggleRouteObject(obj: WorkObject) {
    setPlans((prev) => {
      const exists = prev.find((p) => p.objectId === obj.id);
      if (exists) return prev.filter((p) => p.objectId !== obj.id);
      return [...prev, { objectId: obj.id, objectName: obj.name, works: [], assignedEmployeeIds: [], here: [], sessions: [], visited: false }];
    });
  }

  // ---------- plan helpers ----------
  function planFor(objectId: string) {
    return plans.find((p) => p.objectId === objectId)!;
  }

  // ---------- works helpers ----------
  function toggleWork(objectId: string, work: Work) {
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const has = p.works.some((w) => w.workId === work.id);
        return {
          ...p,
          works: has
            ? p.works.filter((w) => w.workId !== work.id)
            : [...p.works, { workId: work.id, workName: work.name, unit: work.unit || "шт", volume: "" }],
        };
      }),
    );
  }

  // ---------- volume helpers ----------
  function openVolumeDetail(objectId: string, work: PlannedWork) {
    setPlanObjectId(objectId);
    setPlanVolumeWorkId(work.workId);
    setVolumeBuffer(work.volume && work.volume !== "?" ? work.volume : "");
    setVolumeUnit(work.unit);
  }

  function saveVolumeDetail(deferred: boolean) {
    if (!planObjectId || !planVolumeWorkId) return;
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== planObjectId
          ? p
          : {
              ...p,
              works: p.works.map((w) =>
                w.workId !== planVolumeWorkId ? w : { ...w, volume: deferred ? "?" : volumeBuffer, unit: volumeUnit || w.unit },
              ),
            },
      ),
    );
    setPlanVolumeWorkId(null);
  }

  function applyBulkVolume(objectId: string, value: string) {
    setPlans((prev) =>
      prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: p.works.map((w) => (w.volume ? w : { ...w, volume: value })) })),
    );
  }

  // ---------- depart ----------
  function startDrive() {
    setOnboard(employeeIds);
    setTripStartedAt(new Date().toISOString());
    setStep("DRIVE");
  }

  const nextUnvisited = plans.find((p) => !p.visited) ?? null;

  function arriveAtObject() {
    if (!nextUnvisited) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== nextUnvisited.objectId ? p : { ...p, visited: true })));
    setAtObjectId(nextUnvisited.objectId);
    setStep("AT_OBJECT");
  }

  // ---------- quick pickup / drop-off during the drive ----------
  function dropAtObject(objectId: string, ids: string[]) {
    if (!ids.length) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, here: [...new Set([...p.here, ...ids])], visited: true })));
    setOnboard((prev) => prev.filter((id) => !ids.includes(id)));
  }

  function pickUpHere(objectId: string) {
    const plan = planFor(objectId);
    setOnboard((prev) => [...new Set([...prev, ...plan.here])]);
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, here: [] })));
  }

  // ---------- at object ----------
  function currentAtPlan() {
    return plans.find((p) => p.objectId === atObjectId) ?? null;
  }

  function runningSession(plan: ObjPlan) {
    return plan.sessions.find((s) => !s.endedAt) ?? null;
  }

  function confirmStartWork() {
    if (!atObjectId || !startingWorkId || !startPeopleSelected.length) return;
    const plan = currentAtPlan()!;
    const work = plan.works.find((w) => w.workId === startingWorkId)!;
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== atObjectId
          ? p
          : {
              ...p,
              sessions: [
                ...p.sessions,
                { workId: work.workId, workName: work.workName, employeeIds: startPeopleSelected, startedAt: new Date().toISOString() },
              ],
            },
      ),
    );
    setStartingWorkId(null);
    setStartPeopleSelected([]);
  }

  function confirmFinishWork() {
    if (!atObjectId || !finishingSessionKey) return;
    const endedAt = new Date().toISOString();
    let finishedWorkId = "";
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== atObjectId) return p;
        return {
          ...p,
          sessions: p.sessions.map((s) => {
            const key = `${s.workId}#${s.startedAt}`;
            if (key !== finishingSessionKey) return s;
            finishedWorkId = s.workId;
            return { ...s, endedAt };
          }),
        };
      }),
    );
    setFinishingSessionKey(null);
    // If that work's volume isn't filled yet, prompt for it right away.
    const plan = currentAtPlan()!;
    const work = plan.works.find((w) => w.workId === finishedWorkId);
    if (work && (!work.volume || work.volume === "?")) {
      openVolumeDetail(atObjectId, work);
      setStep("PLAN_VOLUMES");
    }
  }

  function confirmDrop() {
    if (!atObjectId || !dropSelected.length) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== atObjectId ? p : { ...p, here: [...new Set([...p.here, ...dropSelected])] })));
    setOnboard((prev) => prev.filter((id) => !dropSelected.includes(id)));
    setDropSelected([]);
    setShowDropPicker(false);
  }

  function confirmMove() {
    if (!atObjectId || !moveTargetId || !moveSelected.length) return;
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId === atObjectId) return { ...p, here: p.here.filter((id) => !moveSelected.includes(id)) };
        if (p.objectId === moveTargetId) return { ...p, here: [...new Set([...p.here, ...moveSelected])] };
        return p;
      }),
    );
    setMoveSelected([]);
    setMoveTargetId(null);
    setShowMovePicker(false);
  }

  const allBack = onboard.length === employeeIds.length;

  // ---------- payload / save ----------
  function buildObjectsPayload() {
    return plans.map((p) => ({
      objectId: p.objectId,
      objectName: p.objectName,
      works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: p.assignedEmployeeIds })),
      sessions: p.sessions.flatMap((s) =>
        s.employeeIds.map((employeeId) => ({
          employeeId,
          employeeName: employeeName(employeeId),
          droppedAt: s.startedAt,
          pickedUpAt: s.endedAt,
        })),
      ),
      coefs: [] as { employeeId: string; disciplineCoef: number; productivityCoef: number }[],
    }));
  }

  async function loadPreview() {
    try {
      const res = await api.post<PayrollPreview>("/api/road-timesheet/preview", {
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds,
        objects: buildObjectsPayload(),
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<PayrollPreview & { eventId: string }>("/api/road-timesheet", {
        date,
        carId,
        odoStart: Number(odoStart),
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
        employeeIds,
        objects: buildObjectsPayload(),
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
    PICK_CAR: "HUB",
    ODO_START: "PICK_CAR",
    PICK_PEOPLE: "HUB",
    PICK_OBJECTS: "HUB",
    PLAN: "HUB",
    PLAN_WORKS: "PLAN",
    PLAN_VOLUMES: "AT_OBJECT",
    READY: "HUB",
    RETURN: "DRIVE",
    REVIEW: "RETURN",
  };

  const allObjectsPlanned = plans.length > 0 && plans.every((p) => p.works.length > 0);
  const readyToDepart = !!carId && !!odoStart && employeeIds.length > 0 && allObjectsPlanned;

  return (
    <div>
      <BackRow onBack={() => (backTargets[step] ? setStep(backTargets[step]!) : onBack())} />
      <div className="header">
        <h1>🚗 Дорожній табель</h1>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {step === "HUB" && (
        <>
          <div className="section-title">Поточна поїздка · {date}</div>
          <div className="list">
            <button className="cell" onClick={() => setStep("PICK_CAR")}>
              <span className="cell-title">🚙 Авто{carId ? `: ${cars.find((c) => c.id === carId)?.name ?? ""}` : ""}</span>
              {carId && odoStart ? <span className="badge ok">{odoStart} км</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => setStep("PICK_PEOPLE")}>
              <span className="cell-title">👥 Люди</span>
              {employeeIds.length ? <span className="badge ok">{employeeIds.length} обрано</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => setStep("PICK_OBJECTS")}>
              <span className="cell-title">📍 Обʼєкти</span>
              {plans.length ? <span className="badge ok">{plans.length} обрано</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => plans.length && setStep("PLAN")} disabled={!plans.length}>
              <span className="cell-title">🧱 Роботи</span>
              {plans.length ? (
                <span className={`badge ${allObjectsPlanned ? "ok" : "warn"}`}>
                  {plans.filter((p) => p.works.length).length}/{plans.length} з роботами
                </span>
              ) : (
                <span className="badge warn">спочатку обʼєкти</span>
              )}
            </button>
          </div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            Можна повертатись сюди у будь-який момент і змінювати авто, людей чи обʼєкти.
          </div>
          {tripStartedAt ? (
            <MainButton text="↩️ Повернутися до поїздки" onClick={() => setStep("DRIVE")} />
          ) : (
            <MainButton text="Далі → Перевірка перед виїздом" onClick={() => setStep("READY")} disabled={!readyToDepart} />
          )}
        </>
      )}

      {step === "PICK_CAR" && (
        <>
          <div className="step-badge">🚙 АВТО</div>
          <div className="section-title">Вибір авто</div>
          <div className="list">
            {cars.map((c) => {
              const takenBy = takenCars.get(c.id);
              const last = lastOdometer[c.id];
              return (
                <button
                  key={c.id}
                  className={`cell ${carId === c.id ? "selected" : ""}`}
                  onClick={() => {
                    if (takenBy) return;
                    if (c.id !== carId) {
                      setOdoStart("");
                      setOdoStartPhoto(null);
                    }
                    setCarId(c.id);
                  }}
                  disabled={!!takenBy}
                  style={takenBy ? { opacity: 0.4 } : undefined}
                >
                  <span className="cell-title">
                    {c.name} {c.plate ? <span className="hint">{c.plate}</span> : null}
                  </span>
                  {takenBy ? <span className="badge warn">🔒 {takenBy}</span> : <span className="cell-sub">{last ? `${last} км` : ""}</span>}
                </button>
              );
            })}
          </div>
          <MainButton text="Далі → Одометр" onClick={() => setStep("ODO_START")} disabled={!carId} />
        </>
      )}

      {step === "ODO_START" && (
        <>
          <div className="step-badge">🚙 АВТО · ОДОМЕТР</div>
          <div className="section-title">Одометр на старті</div>
          {lastOdometer[carId] !== undefined && <div className="hint" style={{ padding: "0 16px" }}>Попереднє значення: {lastOdometer[carId]} км</div>}
          <div className="big-number">{odoStart || "0"} км</div>
          {odoStart && lastOdometer[carId] !== undefined && Number(odoStart) >= lastOdometer[carId] && (
            <div className="hint" style={{ textAlign: "center" }}>
              +{Math.round((Number(odoStart) - lastOdometer[carId]) * 10) / 10} км з попереднього виїзду
            </div>
          )}
          <NumericKeypad value={odoStart} onChange={setOdoStart} />
          <div className="field">
            {odoStartPhoto ? (
              <div className="badge ok">📷 Фото додано</div>
            ) : (
              <>
                <label className="hint">📷 Фото спідометра (не обовʼязково)</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0], "start")}
                />
              </>
            )}
          </div>
          <MainButton
            text={uploadingPhoto ? "Завантаження…" : "Зберегти"}
            onClick={async () => {
              await reserveIfPossible();
              setStep("HUB");
            }}
            disabled={!odoStart || uploadingPhoto}
          />
        </>
      )}

      {step === "PICK_PEOPLE" && (
        <>
          <div className="step-badge">👥 ЛЮДИ</div>
          <div className="section-title">Люди в поїздці — Обрано {employeeIds.length}</div>
          <div className="list">
            {groupByBrigade(employees).map((g) => {
              const expanded = expandedBrigadeId === g.id;
              const selectedCount = g.members.filter((e) => employeeIds.includes(e.id)).length;
              const selectable = g.members.filter((e) => !busyEmployees.has(e.id));
              const allSelected = selectable.length > 0 && selectable.every((e) => employeeIds.includes(e.id));
              return (
                <div key={g.id}>
                  <button className="cell" onClick={() => setExpandedBrigadeId(expanded ? null : g.id)}>
                    <span className="cell-title">
                      {expanded ? "▾" : "▸"} {g.title}
                    </span>
                    <span className="badge">
                      {selectedCount}/{g.members.length}
                    </span>
                  </button>
                  {expanded && (
                    <div style={{ paddingLeft: 12 }}>
                      <button
                        className="cell"
                        onClick={() =>
                          setEmployeeIds((prev) =>
                            allSelected
                              ? prev.filter((id) => !selectable.some((e) => e.id === id))
                              : [...new Set([...prev, ...selectable.map((e) => e.id)])],
                          )
                        }
                        disabled={!selectable.length}
                      >
                        <span className="cell-title">{allSelected ? "❌ Зняти всю бригаду" : "✅ Обрати всю бригаду"}</span>
                      </button>
                      {g.members.map((emp) => {
                        const busyBy = busyEmployees.get(emp.id);
                        const checked = employeeIds.includes(emp.id);
                        return (
                          <button
                            key={emp.id}
                            className={`cell ${checked ? "selected" : ""}`}
                            onClick={() => toggleEmployee(emp.id)}
                            disabled={!!busyBy}
                            style={busyBy ? { opacity: 0.4 } : undefined}
                          >
                            <span className="cell-title">
                              {checked ? "✅ " : "☐ "}
                              {emp.name}
                            </span>
                            {busyBy ? <span className="badge warn">🔒 {busyBy}</span> : <span className="role-tag">{employeeRole(emp)}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <MainButton
            text="Зберегти"
            onClick={async () => {
              await reserveIfPossible();
              setStep("HUB");
            }}
          />
        </>
      )}

      {step === "PICK_OBJECTS" && (
        <>
          <div className="step-badge">📍 ОБʼЄКТИ</div>
          <div className="section-title">Обʼєкти маршруту — Обрано {plans.length}</div>
          <input className="search-box" placeholder="Пошук обʼєкта…" value={objectSearch} onChange={(e) => setObjectSearch(e.target.value)} />
          <div className="list">
            {groupByCity(objects.filter((o) => `${o.name} ${o.address ?? ""}`.toLowerCase().includes(objectSearch.toLowerCase()))).map((g) => {
              const expanded = expandedCityId === g.id || !!objectSearch;
              const selectedCount = g.members.filter((o) => plans.some((p) => p.objectId === o.id)).length;
              return (
                <div key={g.id}>
                  <button className="cell" onClick={() => setExpandedCityId(expandedCityId === g.id ? null : g.id)}>
                    <span className="cell-title">
                      {expanded ? "▾" : "▸"} 🏙 {g.title}
                    </span>
                    <span className="badge">
                      {selectedCount}/{g.members.length}
                    </span>
                  </button>
                  {expanded && (
                    <div style={{ paddingLeft: 12 }}>
                      {g.members.map((obj) => {
                        const checked = plans.some((p) => p.objectId === obj.id);
                        return (
                          <button key={obj.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleRouteObject(obj)}>
                            <span className="cell-title">
                              {checked ? "✅" : "☐"} 📍 {obj.name}
                            </span>
                            <span className="cell-sub">{obj.address}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <MainButton text="Зберегти" onClick={() => setStep("HUB")} />
        </>
      )}

      {step === "PLAN" && (
        <>
          <div className="step-badge">🧱 РОБОТИ</div>
          <div className="section-title">Роботи на обʼєктах</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            Оберіть обʼєкт і призначте роботи. Людей на роботах визначите по прибуттю на обʼєкт.
          </div>
          <div className="list">
            {plans.map((plan) => {
              const ready = plan.works.length > 0;
              return (
                <button
                  key={plan.objectId}
                  className="cell"
                  onClick={() => {
                    setPlanObjectId(plan.objectId);
                    setStep("PLAN_WORKS");
                  }}
                >
                  <span className="cell-title">📍 {plan.objectName}</span>
                  <span className={`badge ${ready ? "ok" : "warn"}`}>{plan.works.length ? `${plan.works.length} робіт` : "не обрано"}</span>
                </button>
              );
            })}
          </div>
          {!plans.length && <div className="empty-state">Спочатку оберіть обʼєкти маршруту</div>}
          <MainButton text="Зберегти" onClick={() => setStep("HUB")} />
        </>
      )}

      {step === "PLAN_WORKS" && planObjectId && (
        <>
          <div className="step-badge">{planFor(planObjectId).objectName.toUpperCase()} · РОБОТИ</div>
          <div className="section-title">Вибір робіт</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>Обери роботи. Обсяги вкажете пізніше, під час виконання на обʼєкті</div>
          <input className="search-box" placeholder="Пошук роботи…" value={planWorksSearch} onChange={(e) => setPlanWorksSearch(e.target.value)} />
          <div className="list">
            {works
              .filter((w) => w.name.toLowerCase().includes(planWorksSearch.toLowerCase()))
              .slice(0, 60)
              .map((w) => {
                const checked = planFor(planObjectId).works.some((pw) => pw.workId === w.id);
                return (
                  <button key={w.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleWork(planObjectId, w)}>
                    <span className="cell-title">
                      {checked ? "✅" : "☐"} {w.name}
                    </span>
                  </button>
                );
              })}
          </div>
          <div className="hint" style={{ padding: "0 16px" }}>Робіт у пакеті: {planFor(planObjectId).works.length}</div>
          <MainButton
            text="Готово"
            onClick={() => setStep("PLAN")}
            disabled={!planFor(planObjectId).works.length}
          />
        </>
      )}

      {step === "PLAN_VOLUMES" && planObjectId && !planVolumeWorkId && (
        <>
          {(() => {
            const plan = planFor(planObjectId);
            const unfilled = plan.works.filter((w) => !w.volume || w.volume === "?");
            return (
              <>
                <div className="step-badge">{plan.objectName.toUpperCase()} · ОБСЯГИ</div>
                <div className="section-title" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Обсяги</span>
                  <button className="chip" onClick={() => applyBulkVolume(planObjectId, prompt("Значення для незаповнених обсягів:") || "")}>
                    Масовий ввід
                  </button>
                </div>
                <div className="hint" style={{ padding: "0 16px 8px" }}>Постав число для кожної роботи</div>
                <div className="list">
                  {plan.works.map((w) => (
                    <button key={w.workId} className="cell" onClick={() => openVolumeDetail(planObjectId, w)}>
                      <span className="cell-title">{w.workName}</span>
                      {w.volume && w.volume !== "?" ? (
                        <span className="badge ok">
                          {w.volume} {w.unit}
                        </span>
                      ) : (
                        <span className="badge warn">🟡 Введи</span>
                      )}
                    </button>
                  ))}
                </div>
                {unfilled.length > 0 && (
                  <div className="empty-state">🟡 Є роботи без обсягу: {unfilled.map((w) => w.workName).join(", ")}</div>
                )}
                <MainButton text="Зберегти пакет (можна пізніше)" onClick={() => setStep("AT_OBJECT")} />
              </>
            );
          })()}
        </>
      )}

      {step === "PLAN_VOLUMES" && planObjectId && planVolumeWorkId && (
        <>
          {(() => {
            const work = planFor(planObjectId).works.find((w) => w.workId === planVolumeWorkId)!;
            return (
              <>
                <div className="step-badge">ОБСЯГ РОБОТИ</div>
                <div className="section-title">Обсяг для роботи</div>
                <div className="hint" style={{ padding: "0 16px" }}>{work.workName}</div>
                <div className="big-number">{volumeBuffer || "0"}</div>
                <div className="unit-tabs">
                  {UNITS.map((u) => (
                    <div key={u} className={`unit-tab ${volumeUnit === u ? "selected" : ""}`} onClick={() => setVolumeUnit(u)}>
                      {u}
                    </div>
                  ))}
                </div>
                <div className="hint" style={{ padding: "0 16px 8px", textAlign: "center", cursor: "pointer" }} onClick={() => saveVolumeDetail(true)}>
                  ❓ Обсяг ще невідомий — заповнити пізніше
                </div>
                <NumericKeypad value={volumeBuffer} onChange={setVolumeBuffer} />
                <MainButton text="Зберегти обсяг" onClick={() => saveVolumeDetail(false)} disabled={!volumeBuffer} />
              </>
            );
          })()}
        </>
      )}

      {step === "READY" && (
        <>
          <div className="step-badge">ПЕРЕВІРКА ПЕРЕД ВИЇЗДОМ</div>
          <div className="section-title">Готовність до виїзду</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">🚙 Авто</span>
              <span className="cell-sub">
                {cars.find((c) => c.id === carId)?.name} · {odoStart} км
              </span>
            </div>
            <div className="cell">
              <span className="cell-title">👥 Люди</span>
              <span className="cell-sub">{employeeIds.map(employeeName).join(", ")}</span>
            </div>
          </div>
          <div className="section-title">Обʼєкти · роботи · обсяги</div>
          <div className="list">
            {plans.map((p) => {
              const unfilled = p.works.filter((w) => !w.volume || w.volume === "?");
              return (
                <div key={p.objectId} className="cell" style={{ cursor: "default", display: "block" }}>
                  <div className="cell-title">📍 {p.objectName}</div>
                  <div className="hint">{p.works.map((w) => `${w.workName} ${w.volume && w.volume !== "?" ? w.volume + w.unit : ""}`).join(" · ")}</div>
                  {unfilled.length > 0 && <div className="badge warn">🟡 {unfilled.map((w) => w.workName).join(", ")}</div>}
                </div>
              );
            })}
          </div>
          {plans.some((p) => p.works.some((w) => !w.volume || w.volume === "?")) && (
            <div className="empty-state">Є незаповнені обсяги — можна заповнити зі списку планування</div>
          )}
          <div className="hint" style={{ padding: "0 16px 8px", textAlign: "center" }}>
            Щось треба змінити? <button className="back-btn" onClick={() => setStep("HUB")}>← До меню поїздки</button>
          </div>
          <MainButton text="🚗 Виїхати" onClick={startDrive} />
        </>
      )}

      {step === "DRIVE" && (
        <>
          <div style={{ padding: "8px 16px", textAlign: "right" }}>
            <button className="back-btn" onClick={() => setStep("HUB")}>✏️ Редагувати поїздку</button>
          </div>
          <div className="pulse-icon">🚗</div>
          <div className="section-title" style={{ textAlign: "center" }}>{nextUnvisited ? "В ДОРОЗІ" : "ПОВЕРТАЄМОСЬ"}</div>
          <div className="timer-big">{tripStartedAt ? fmtHMS(now - new Date(tripStartedAt).getTime()) : "00:00:00"}</div>
          <div className="hint" style={{ textAlign: "center" }}>
            {nextUnvisited ? (
              <>
                Прямуємо до
                <br />📍 {nextUnvisited.objectName}
              </>
            ) : (
              "Усі обʼєкти відвідано — час повертатись на базу"
            )}
          </div>

          <div className="section-title">Маршрут — швидкі дії</div>
          <div className="list">
            {plans.map((p) => (
              <div key={p.objectId} className="cell" style={{ cursor: "default", display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="cell-title">📍 {p.objectName}</span>
                  <span className={`badge ${p.visited ? "ok" : ""}`}>{p.here.length ? `${p.here.length} тут` : p.visited ? "відвідано" : ""}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button
                    className="chip"
                    onClick={() => {
                      setDriveDropTargetId(p.objectId);
                      setDriveDropSelected([]);
                    }}
                    disabled={!onboard.length}
                  >
                    🔽 Висадити тут
                  </button>
                  <button className="chip" onClick={() => pickUpHere(p.objectId)} disabled={!p.here.length}>
                    🔼 Забрати ({p.here.length})
                  </button>
                </div>
              </div>
            ))}
          </div>

          {driveDropTargetId && (
            <>
              <div className="section-title">Кого висадити на {plans.find((p) => p.objectId === driveDropTargetId)?.objectName}</div>
              <div className="chip-row">
                {onboard.map((id) => (
                  <div
                    key={id}
                    className={`chip ${driveDropSelected.includes(id) ? "selected" : ""}`}
                    onClick={() => setDriveDropSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                  >
                    {employeeName(id)}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                <button
                  className="chip"
                  onClick={() => {
                    setDriveDropTargetId(null);
                    setDriveDropSelected([]);
                  }}
                >
                  Скасувати
                </button>
                <button
                  className="chip selected"
                  onClick={() => {
                    dropAtObject(driveDropTargetId, driveDropSelected);
                    setDriveDropTargetId(null);
                    setDriveDropSelected([]);
                  }}
                  disabled={!driveDropSelected.length}
                >
                  Підтвердити
                </button>
              </div>
            </>
          )}

          {nextUnvisited ? (
            <MainButton text="📍 Прибув на обʼєкт" onClick={arriveAtObject} />
          ) : (
            <MainButton text="🏁 Приїхали на базу" onClick={() => setStep("RETURN")} />
          )}
        </>
      )}

      {step === "AT_OBJECT" && atObjectId && (
        <>
          {(() => {
            const plan = currentAtPlan()!;
            const running = runningSession(plan);
            const notStarted = plan.works.filter((w) => !plan.sessions.some((s) => s.workId === w.workId));
            return (
              <>
                <div className="step-badge">НА ОБʼЄКТІ</div>
                <div className="section-title">📍 {plan.objectName}</div>

                {running ? (
                  <div className="active-work-card">
                    <div style={{ fontWeight: 700 }}>{running.workName}</div>
                    <div className="timer-big" style={{ padding: "4px 0" }}>{fmtHMS(now - new Date(running.startedAt).getTime())}</div>
                    <div className="hint">{running.employeeIds.map(employeeName).join(", ")}</div>
                  </div>
                ) : (
                  <div className="empty-state">Немає активної роботи</div>
                )}

                {startingWorkId === null && !showDropPicker && !showMovePicker && (
                  <div className="list" style={{ marginTop: 8 }}>
                    <button
                      className="cell"
                      onClick={() => setStartingWorkId(notStarted[0]?.workId ?? "__PICK__")}
                      disabled={!!running || !plan.here.length || !notStarted.length}
                    >
                      <span className="cell-title">▶️ Почати роботу</span>
                    </button>
                    <button
                      className="cell danger-btn"
                      onClick={() => setFinishingSessionKey(running ? `${running.workId}#${running.startedAt}` : null)}
                      disabled={!running}
                    >
                      <span className="cell-title">⏹ Завершити роботу</span>
                    </button>
                    <button className="cell" onClick={() => setShowMovePicker(true)} disabled={!plan.here.length}>
                      <span className="cell-title">🔄 Перенести людей на інший обʼєкт</span>
                    </button>
                    <button className="cell" onClick={() => setShowDropPicker(true)} disabled={!onboard.length}>
                      <span className="cell-title">👥 Висадити людей тут</span>
                    </button>
                  </div>
                )}

                {startingWorkId !== null && (
                  <>
                    <div className="section-title">Яку роботу почати</div>
                    <div className="chip-row">
                      {notStarted.map((w) => (
                        <div key={w.workId} className={`chip ${startingWorkId === w.workId ? "selected" : ""}`} onClick={() => setStartingWorkId(w.workId)}>
                          {w.workName}
                        </div>
                      ))}
                    </div>
                    <div className="section-title">Хто виконує</div>
                    <div className="chip-row">
                      {plan.here.map((id) => (
                        <div
                          key={id}
                          className={`chip ${startPeopleSelected.includes(id) ? "selected" : ""}`}
                          onClick={() => setStartPeopleSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                        >
                          {employeeName(id)}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                      <button className="chip" onClick={() => setStartingWorkId(null)}>
                        Скасувати
                      </button>
                      <button className="chip selected" onClick={confirmStartWork} disabled={!startPeopleSelected.length || startingWorkId === "__PICK__"}>
                        Почати
                      </button>
                    </div>
                  </>
                )}

                {finishingSessionKey && (
                  <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                    <button className="chip" onClick={() => setFinishingSessionKey(null)}>
                      Скасувати
                    </button>
                    <button className="chip selected" onClick={confirmFinishWork}>
                      Підтвердити завершення
                    </button>
                  </div>
                )}

                {showDropPicker && (
                  <>
                    <div className="section-title">Кого залишити тут</div>
                    <div className="chip-row">
                      {onboard.map((id) => (
                        <div
                          key={id}
                          className={`chip ${dropSelected.includes(id) ? "selected" : ""}`}
                          onClick={() => setDropSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                        >
                          {employeeName(id)}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                      <button className="chip" onClick={() => setShowDropPicker(false)}>
                        Скасувати
                      </button>
                      <button className="chip selected" onClick={confirmDrop} disabled={!dropSelected.length}>
                        Підтвердити
                      </button>
                    </div>
                  </>
                )}

                {showMovePicker && (
                  <>
                    <div className="section-title">Кого перенести</div>
                    <div className="chip-row">
                      {plan.here.map((id) => (
                        <div
                          key={id}
                          className={`chip ${moveSelected.includes(id) ? "selected" : ""}`}
                          onClick={() => setMoveSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                        >
                          {employeeName(id)}
                        </div>
                      ))}
                    </div>
                    <div className="section-title">На який обʼєкт</div>
                    <div className="chip-row">
                      {plans
                        .filter((p) => p.objectId !== atObjectId)
                        .map((p) => (
                          <div key={p.objectId} className={`chip ${moveTargetId === p.objectId ? "selected" : ""}`} onClick={() => setMoveTargetId(p.objectId)}>
                            {p.objectName}
                          </div>
                        ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                      <button className="chip" onClick={() => setShowMovePicker(false)}>
                        Скасувати
                      </button>
                      <button className="chip selected" onClick={confirmMove} disabled={!moveSelected.length || !moveTargetId}>
                        Підтвердити
                      </button>
                    </div>
                  </>
                )}

                <MainButton text="➡️ Продовжити маршрут" onClick={() => setStep("DRIVE")} disabled={!!running} />
              </>
            );
          })()}
        </>
      )}

      {step === "RETURN" && (
        <>
          <div className="step-badge">ПОВЕРНЕННЯ</div>
          <div className="section-title">Повернення</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>Завершіть роботу і заберіть людей з обʼєктів</div>
          <div className="list">
            {plans
              .filter((p) => p.visited)
              .map((p) => (
                <div key={p.objectId} className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">📍 {p.objectName}</span>
                  {p.here.length ? (
                    <button className="chip" onClick={() => pickUpHere(p.objectId)}>
                      Забрати ({p.here.map(employeeName).join(", ")})
                    </button>
                  ) : (
                    <span className="badge ok">забрано</span>
                  )}
                </div>
              ))}
          </div>

          <div className="section-title">Одометр на фініші</div>
          <div className="hint" style={{ padding: "0 16px" }}>Старт: {odoStart} км</div>
          <div className="big-number">{odoEnd || "0"} км</div>
          {odoEnd && Number(odoEnd) >= Number(odoStart) && <div className="hint" style={{ textAlign: "center" }}>Пройдено {Math.round((Number(odoEnd) - Number(odoStart)) * 10) / 10} км</div>}
          <NumericKeypad value={odoEnd} onChange={setOdoEnd} />
          <div className="field">
            {odoEndPhoto ? (
              <div className="badge ok">📷 Фото додано</div>
            ) : (
              <>
                <label className="hint">📷 Фото спідометра (не обовʼязково)</label>
                <input type="file" accept="image/*" capture="environment" onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0], "end")} />
              </>
            )}
          </div>

          <MainButton
            text="Далі → Підсумок дня"
            onClick={async () => {
              setStep("REVIEW");
              await loadPreview();
            }}
            disabled={!odoEnd || !allBack || uploadingPhoto}
          />
        </>
      )}

      {step === "REVIEW" && (
        <>
          <div className="step-badge">ПІДСУМОК ДНЯ</div>
          <div className="section-title">Підсумок дня</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">Проїхано</span>
              <span className="cell-sub">
                {preview ? `${preview.km} км · клас ${preview.tripClass}` : "рахую…"}
              </span>
            </div>
          </div>

          <div className="section-title">Обʼєкти · роботи · обсяги</div>
          <div className="list">
            {plans.map((p) => (
              <div key={p.objectId} className="cell" style={{ cursor: "default", display: "block" }}>
                <div className="cell-title">📍 {p.objectName}</div>
                <div className="hint">{p.works.map((w) => `${w.workName} ${w.volume !== "?" ? w.volume + w.unit : "?"}`).join(" · ")}</div>
              </div>
            ))}
          </div>

          <div className="section-title">Години працівників</div>
          <div className="list">
            {employeeIds.map((id) => {
              const totalMs = plans.reduce(
                (acc, p) =>
                  acc +
                  p.sessions
                    .filter((s) => s.employeeIds.includes(id))
                    .reduce((a, s) => a + (new Date(s.endedAt ?? new Date().toISOString()).getTime() - new Date(s.startedAt).getTime()), 0),
                0,
              );
              return (
                <div key={id} className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">{employeeName(id)}</span>
                  <span className="cell-sub">{fmtHours(totalMs)} год</span>
                </div>
              );
            })}
          </div>

          {preview && (
            <>
              <div className="section-title">Розподіл фонду</div>
              <div className="list">
                {preview.brigadierEmployeeId && (
                  <div className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title">Бригадир</span>
                    <span className="cell-sub">
                      {preview.salaryPacks.reduce((a, pack) => a + (pack.rows.find((r) => r.employeeId === preview.brigadierEmployeeId)?.pay ?? 0), 0)} ₴
                    </span>
                  </div>
                )}
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">Доплата за виїзд</span>
                  <span className="cell-sub">{preview.roadAllowance.perPerson} ₴/особу</span>
                </div>
              </div>
            </>
          )}

          <MainButton text={saving ? "Відправлення…" : "📤 Відправити на підтвердження"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
