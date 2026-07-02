import { useEffect, useRef, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject } from "../lib/api";
import { todayISO } from "../lib/date";
import { haptic, useTelegramBackButton } from "../lib/telegram";
import { saveDraft, loadDraft, clearDraft } from "../lib/draft";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";
import { NumericKeypad } from "../components/NumericKeypad";

// Hub-based flow: after opening the road timesheet, the foreman lands on a HUB
// screen with editable cards -- Авто, Люди, Обʼєкти, Роботи. Each card opens
// its own sub-flow and returns back to HUB when done, so any parameter can be
// revisited/changed at any point before (or even after) departure. Once
// everything is filled in, "Виїхати" opens a final READY check, then DRIVE ->
// AT_OBJECT (one shift covering everyone dropped there, all planned works) -> RETURN
// -> REVIEW -> submit. The whole day is autosaved to localStorage (the
// mini-app is state-in-memory only otherwise, and Telegram can evict it). A
// submitted-but-not-yet-approved day is NOT locked: reopening it restores the
// last submission straight from the server (so the foreman always sees the
// report), and resubmitting just overwrites it. Only an admin-approved day
// locks, with a "request edit" escape hatch.
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
// One shared "shift" per object visit: started by a single button covering
// everyone currently dropped there, working on all of that object's planned
// works together (not tracked per-work -- payroll only cares about total
// object-level presence time, not which specific work someone did).
type Shift = { startedAt: string; endedAt?: string; employeeIds: string[] };
type ObjPlan = {
  objectId: string;
  objectName: string;
  works: PlannedWork[];
  assignedEmployeeIds: string[]; // planned before departure
  here: string[]; // physically dropped off at this object right now
  shift: Shift | null;
  visited: boolean; // reached (formally, or via a quick drop-off during the drive)
  notes: string;
  photoUrls: string[];
};

// Where an employee currently is: exactly one of onboard, one specific
// object's `here`, or nowhere (taken off the day's active roster entirely).
type Location = { kind: "onboard" } | { kind: "object"; objectId: string } | { kind: "nowhere" };

type CoefPair = { disciplineCoef: number; productivityCoef: number };

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

type DayStatus = { hasSubmission: boolean; approved: boolean; eventId: string | null; editRequested: boolean };
type SubmittedTodayResponse =
  | { found: false }
  | {
      found: true;
      eventId: string;
      carId: string | null;
      employeeIds: string[];
      odoStart: number | null;
      odoStartPhoto: string | null;
      odoEnd: number | null;
      odoEndPhoto: string | null;
      objects: {
        objectId: string;
        objectName: string;
        works: { workId: string; workName: string; volume?: string | number }[];
        sessions: { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string }[];
        notes?: string;
        photoUrls?: string[];
      }[];
    };
type LastTripResponse =
  | { found: false }
  | {
      found: true;
      date: string;
      carId: string | null;
      employeeIds: string[];
      objects: { objectId: string; objectName: string; works: { workId: string; workName: string }[] }[];
    };
type LastTripSuggestion = {
  date: string;
  carId: string;
  employeeIds: string[];
  objects: { objectId: string; objectName: string; works: { workId: string; workName: string }[] }[];
};

type DraftShape = {
  date: string;
  step: Step;
  carId: string;
  odoStart: string;
  odoStartPhoto: string | null;
  odoEnd: string;
  odoEndPhoto: string | null;
  employeeIds: string[];
  plans: ObjPlan[];
  onboard: string[];
  tripStartedAt: string | null;
  atObjectId: string | null;
  coefs: Record<string, CoefPair>;
};

const UNITS = ["м²", "м", "пог.м", "шт"];
const COEF_PRESETS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2];

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

  const [date, setDate] = useState(() => todayISO());

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
  const [peopleSearch, setPeopleSearch] = useState("");
  const [objectSearch, setObjectSearch] = useState("");
  const [expandedCityId, setExpandedCityId] = useState<string | null>(null);
  const [plans, setPlans] = useState<ObjPlan[]>([]);

  // --- planning (works / people per object / volumes) ---
  const [planObjectId, setPlanObjectId] = useState<string | null>(null);
  const [planWorksSearch, setPlanWorksSearch] = useState("");
  const [planVolumeWorkId, setPlanVolumeWorkId] = useState<string | null>(null);
  const [volumeBuffer, setVolumeBuffer] = useState("");
  const [volumeUnit, setVolumeUnit] = useState("");

  // --- payroll coefficients (day-wide, applied to every object) ---
  const [coefs, setCoefs] = useState<Record<string, CoefPair>>({});
  const [showCoefs, setShowCoefs] = useState(false);

  // --- drive ---
  const [onboard, setOnboard] = useState<string[]>([]);
  const [tripStartedAt, setTripStartedAt] = useState<string | null>(null);
  const [driveDropTargetId, setDriveDropTargetId] = useState<string | null>(null);
  const [driveDropSelected, setDriveDropSelected] = useState<string[]>([]);

  // --- at object ---
  const [atObjectId, setAtObjectId] = useState<string | null>(null);
  const [volumesReturnStep, setVolumesReturnStep] = useState<Step>("AT_OBJECT");
  const [dropSelected, setDropSelected] = useState<string[]>([]);
  const [showDropPicker, setShowDropPicker] = useState(false);
  const [moveSelected, setMoveSelected] = useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);

  // --- undo / change log / draft / submitted-lock / copy-yesterday ---
  const undoTimeoutRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);
  const [undo, setUndo] = useState<{ label: string; restore: () => void } | null>(null);
  const [changeLog, setChangeLog] = useState<{ ts: number; label: string }[]>([]);
  const [showChangeLog, setShowChangeLog] = useState(false);
  const [restoredBanner, setRestoredBanner] = useState(false);
  const [submittedEditBanner, setSubmittedEditBanner] = useState(false);
  const [dayStatus, setDayStatus] = useState<DayStatus | null>(null);
  const [lastTrip, setLastTrip] = useState<LastTripSuggestion | null>(null);

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
    api
      .get<LastTripResponse>(`/api/road-timesheet/last-trip?before=${date}`)
      .then((res) => {
        if (res.found) setLastTrip({ date: res.date, carId: res.carId ?? "", employeeIds: res.employeeIds, objects: res.objects });
      })
      .catch(() => {});
  }, [date]);

  // Restore an autosaved draft once on mount (survives the mini-app being
  // killed/reopened on the same device). Deliberately does NOT require
  // draft.date === today: a night shift started at 23:00 and reopened after
  // an app crash at 01:30 is a different calendar date by then, but it's
  // still the same unfinished day and must not silently vanish. Instead the
  // draft's own date is adopted (`setDate` below), and every date-scoped
  // fetch (car/people status, day-status, submitted-today) naturally re-runs
  // against the corrected date once it changes.
  useEffect(() => {
    const draft = loadDraft<DraftShape>();
    if (draft && draft.step !== "DONE") {
      if (draft.date !== date) setDate(draft.date);
      setCarId(draft.carId);
      setOdoStart(draft.odoStart);
      setOdoStartPhoto(draft.odoStartPhoto);
      setOdoEnd(draft.odoEnd);
      setOdoEndPhoto(draft.odoEndPhoto);
      setEmployeeIds(draft.employeeIds);
      setPlans(draft.plans);
      setOnboard(draft.onboard);
      setTripStartedAt(draft.tripStartedAt);
      setAtObjectId(draft.atObjectId);
      setCoefs(draft.coefs ?? {});
      setStep(draft.step);
      setRestoredBanner(true);
      draftRestoredRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Not-yet-approved submissions aren't locked -- the foreman can keep
  // viewing/editing them. If there's no more-recent local draft already in
  // play, pull the last submission straight from the server so a re-opened
  // (or freshly-installed) app still shows exactly what was sent.
  useEffect(() => {
    api
      .get<DayStatus>(`/api/road-timesheet/day-status?date=${date}`)
      .then(async (status) => {
        setDayStatus(status);
        if (draftRestoredRef.current || !status.hasSubmission || status.approved) return;
        const res = await api.get<SubmittedTodayResponse>(`/api/road-timesheet/submitted-today?date=${date}`);
        if (!res.found) return;
        setCarId(res.carId ?? "");
        setOdoStart(res.odoStart !== null ? String(res.odoStart) : "");
        setOdoStartPhoto(res.odoStartPhoto);
        setOdoEnd(res.odoEnd !== null ? String(res.odoEnd) : "");
        setOdoEndPhoto(res.odoEndPhoto);
        setEmployeeIds(res.employeeIds);
        setOnboard(res.employeeIds);
        const restoredPlans: ObjPlan[] = res.objects.map((o) => ({
          objectId: o.objectId,
          objectName: o.objectName,
          works: o.works.map((w) => ({
            workId: w.workId,
            workName: w.workName,
            unit: works.find((x) => x.id === w.workId)?.unit || "шт",
            volume: w.volume !== undefined && w.volume !== null ? String(w.volume) : "",
          })),
          assignedEmployeeIds: [],
          here: [],
          shift: o.sessions.length
            ? { startedAt: o.sessions[0].droppedAt, endedAt: o.sessions[0].pickedUpAt, employeeIds: o.sessions.map((s) => s.employeeId) }
            : null,
          visited: true,
          notes: o.notes ?? "",
          photoUrls: o.photoUrls ?? [],
        }));
        setPlans(restoredPlans);
        setStep("REVIEW");
        setSubmittedEditBanner(true);
        api
          .post<PayrollPreview>("/api/road-timesheet/preview", {
            odoStart: res.odoStart ?? 0,
            odoEnd: res.odoEnd ?? 0,
            employeeIds: res.employeeIds,
            objects: restoredPlans.map((p) => ({
              objectId: p.objectId,
              objectName: p.objectName,
              works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: p.shift?.employeeIds ?? [] })),
              sessions: p.shift
                ? p.shift.employeeIds.map((employeeId) => ({
                    employeeId,
                    employeeName: employeeName(employeeId),
                    droppedAt: p.shift!.startedAt,
                    pickedUpAt: p.shift!.endedAt,
                  }))
                : [],
            })),
          })
          .then(setPreview)
          .catch(() => {});
      })
      .catch(() => setDayStatus({ hasSubmission: false, approved: false, eventId: null, editRequested: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    if (step === "DONE") return;
    saveDraft<DraftShape>({
      date,
      step,
      carId,
      odoStart,
      odoStartPhoto,
      odoEnd,
      odoEndPhoto,
      employeeIds,
      plans,
      onboard,
      tripStartedAt,
      atObjectId,
      coefs,
    });
  }, [date, step, carId, odoStart, odoStartPhoto, odoEnd, odoEndPhoto, employeeIds, plans, onboard, tripStartedAt, atObjectId, coefs]);

  function employeeName(id: string) {
    return employees.find((e) => e.id === id)?.name ?? id;
  }

  function roleFor(id: string): "бригадир" | "старший" | "робітник" {
    const emp = employees.find((e) => e.id === id);
    return emp ? employeeRole(emp) : "робітник";
  }

  function logChange(label: string) {
    setChangeLog((prev) => [{ ts: Date.now(), label }, ...prev].slice(0, 100));
  }

  function pushUndo(label: string, restore: () => void) {
    if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
    setUndo({ label, restore });
    undoTimeoutRef.current = window.setTimeout(() => setUndo(null), 6000);
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

  async function requestEdit() {
    try {
      await api.post("/api/road-timesheet/request-edit", { date, eventId: dayStatus?.eventId, reason: "" });
      setDayStatus((prev) => (prev ? { ...prev, editRequested: true } : prev));
      haptic("success");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resetDay() {
    if (!window.confirm("Точно почати день заново? Усі незбережені дані буде видалено.")) return;
    clearDraft();
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setPlans([]);
    setCoefs({});
    setOnboard([]);
    setTripStartedAt(null);
    setAtObjectId(null);
    setChangeLog([]);
    setStep("HUB");
  }

  function applyLastTrip() {
    if (!lastTrip) return;
    setCarId(lastTrip.carId);
    setEmployeeIds(lastTrip.employeeIds);
    setPlans(
      lastTrip.objects.map((o) => ({
        objectId: o.objectId,
        objectName: o.objectName,
        works: o.works.map((w) => ({ workId: w.workId, workName: w.workName, unit: works.find((x) => x.id === w.workId)?.unit || "шт", volume: "" })),
        assignedEmployeeIds: [],
        here: [],
        shift: null,
        visited: false,
        notes: "",
        photoUrls: [],
      })),
    );
    logChange(`Застосовано маршрут з ${lastTrip.date}`);
    setLastTrip(null);
  }

  // ---------- people helpers ----------
  // The single place an employee's physical location ever changes. Every
  // drop-off/pick-up/transfer/removal funnels through this so "an employee
  // is never in two places at once" is guaranteed by construction, not by
  // every call site remembering to clean up both `onboard` and every
  // object's `here` array by hand.
  function moveEmployeesTo(ids: string[], location: Location) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setOnboard((prev) => {
      const rest = prev.filter((id) => !idSet.has(id));
      return location.kind === "onboard" ? [...new Set([...rest, ...ids])] : rest;
    });
    setPlans((prev) =>
      prev.map((p) => {
        const isTarget = location.kind === "object" && p.objectId === location.objectId;
        const hadAny = p.here.some((id) => idSet.has(id));
        if (!isTarget && !hadAny) return p;
        const rest = p.here.filter((id) => !idSet.has(id));
        return { ...p, here: isTarget ? [...new Set([...rest, ...ids])] : rest };
      }),
    );
  }

  function toggleEmployee(id: string) {
    if (busyEmployees.has(id)) return;
    if (employeeIds.includes(id)) {
      if (tripStartedAt) {
        const name = employeeName(id);
        pushUndo(`${name} видалено з поїздки`, () => setEmployeeIds((prev) => [...prev, id]));
        logChange(`${name} видалено з поїздки`);
      }
      setEmployeeIds((prev) => prev.filter((x) => x !== id));
      moveEmployeesTo([id], { kind: "nowhere" });
    } else {
      setEmployeeIds((prev) => [...prev, id]);
    }
    haptic("selection");
  }

  // ---------- objects helpers ----------
  function removeObjectFromRoute(objectId: string) {
    const plan = plans.find((p) => p.objectId === objectId);
    if (!plan) return;
    if (plan.works.length || plan.shift) {
      pushUndo(`Обʼєкт "${plan.objectName}" видалено`, () => setPlans((prev) => [...prev, plan]));
      logChange(`Обʼєкт видалено: ${plan.objectName}`);
    }
    setPlans((prev) => prev.filter((p) => p.objectId !== objectId));
    haptic("selection");
  }

  function toggleRouteObject(obj: WorkObject) {
    if (plans.some((p) => p.objectId === obj.id)) {
      removeObjectFromRoute(obj.id);
      return;
    }
    setPlans((prev) => [
      ...prev,
      { objectId: obj.id, objectName: obj.name, works: [], assignedEmployeeIds: [], here: [], shift: null, visited: false, notes: "", photoUrls: [] },
    ]);
    haptic("selection");
  }

  // ---------- plan helpers ----------
  function planFor(objectId: string) {
    return plans.find((p) => p.objectId === objectId)!;
  }

  function updateNotes(objectId: string, notes: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, notes })));
  }

  async function uploadObjectPhoto(objectId: string, file: File) {
    setUploadingPhoto(true);
    setError(null);
    try {
      const res = await api.upload<{ url: string }>("/api/road-timesheet/photo", file);
      setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, photoUrls: [...p.photoUrls, res.url] })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingPhoto(false);
    }
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
    haptic("selection");
  }

  function applyWorksToAllObjects(sourceObjectId: string) {
    const source = planFor(sourceObjectId);
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId === sourceObjectId) return p;
        const existingIds = new Set(p.works.map((w) => w.workId));
        const toAdd = source.works.filter((w) => !existingIds.has(w.workId)).map((w) => ({ ...w, volume: "" }));
        return toAdd.length ? { ...p, works: [...p.works, ...toAdd] } : p;
      }),
    );
    logChange(`Роботи з "${source.objectName}" застосовано до інших обʼєктів`);
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

  // ---------- coefficients ----------
  function coefFor(id: string): CoefPair {
    return coefs[id] ?? { disciplineCoef: 1, productivityCoef: 1 };
  }

  function setCoef(id: string, field: keyof CoefPair, value: number) {
    setCoefs((prev) => ({ ...prev, [id]: { ...coefFor(id), [field]: value } }));
  }

  // ---------- depart ----------
  function startDrive() {
    setOnboard(employeeIds);
    setTripStartedAt(new Date().toISOString());
    setStep("DRIVE");
    haptic("success");
    logChange("Виїхали");
  }

  const nextUnvisited = plans.find((p) => !p.visited) ?? null;

  function arriveAtObject() {
    if (!nextUnvisited) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== nextUnvisited.objectId ? p : { ...p, visited: true })));
    setAtObjectId(nextUnvisited.objectId);
    setStep("AT_OBJECT");
    haptic("medium");
    logChange(`Прибули: ${nextUnvisited.objectName}`);
  }

  // ---------- quick pickup / drop-off during the drive ----------
  function dropAtObject(objectId: string, ids: string[]) {
    if (!ids.length) return;
    const objectName = planFor(objectId).objectName;
    moveEmployeesTo(ids, { kind: "object", objectId });
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, visited: true })));
    haptic("light");
    logChange(`Висаджено ${ids.length} на ${objectName}`);
  }

  function pickUpHere(objectId: string) {
    const plan = planFor(objectId);
    if (!plan.here.length) return;
    moveEmployeesTo(plan.here, { kind: "onboard" });
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId ? p : { ...p, shift: p.shift && !p.shift.endedAt ? { ...p.shift, endedAt: new Date().toISOString() } : p.shift },
      ),
    );
    haptic("light");
    logChange(`Забрано з ${plan.objectName}`);
  }

  function openVolumesForObject(objectId: string, returnTo: Step) {
    setPlanObjectId(objectId);
    setVolumesReturnStep(returnTo);
    setStep("PLAN_VOLUMES");
  }

  // ---------- at object ----------
  function currentAtPlan() {
    return plans.find((p) => p.objectId === atObjectId) ?? null;
  }

  // A single shift covers everyone dropped at the object working on all of
  // that object's planned works together -- one button starts it, one button
  // ends it (then walks straight into entering volumes for each work).
  function startShift() {
    if (!atObjectId) return;
    const plan = currentAtPlan();
    if (!plan || !plan.here.length) return;
    setPlans((prev) =>
      prev.map((p) => (p.objectId !== atObjectId ? p : { ...p, shift: { startedAt: new Date().toISOString(), employeeIds: p.here } })),
    );
    haptic("light");
    logChange(`Почато роботи на ${plan.objectName} (${plan.here.length} людей)`);
  }

  function finishShift() {
    if (!atObjectId) return;
    const plan = currentAtPlan();
    if (!plan?.shift) return;
    const endedAt = new Date().toISOString();
    setPlans((prev) => prev.map((p) => (p.objectId !== atObjectId ? p : { ...p, shift: p.shift ? { ...p.shift, endedAt } : null })));
    haptic("success");
    logChange(`Завершено роботи на ${plan.objectName}`);
    openVolumesForObject(atObjectId, "AT_OBJECT");
  }

  function confirmDrop() {
    if (!atObjectId || !dropSelected.length) return;
    const objectName = currentAtPlan()?.objectName ?? "";
    moveEmployeesTo(dropSelected, { kind: "object", objectId: atObjectId });
    haptic("light");
    logChange(`Висаджено ${dropSelected.length} на ${objectName}`);
    setDropSelected([]);
    setShowDropPicker(false);
  }

  function confirmMove() {
    if (!atObjectId || !moveTargetId || !moveSelected.length) return;
    const fromName = currentAtPlan()?.objectName ?? "";
    const toName = plans.find((p) => p.objectId === moveTargetId)?.objectName ?? "";
    const count = moveSelected.length;
    moveEmployeesTo(moveSelected, { kind: "object", objectId: moveTargetId });
    haptic("light");
    logChange(`Перенесено ${count} з ${fromName} на ${toName}`);
    setMoveSelected([]);
    setMoveTargetId(null);
    setShowMovePicker(false);
  }

  const allBack = onboard.length === employeeIds.length;

  // ---------- payload / save ----------
  function buildObjectsPayload() {
    const coefList = employeeIds.map((id) => ({ employeeId: id, disciplineCoef: coefFor(id).disciplineCoef, productivityCoef: coefFor(id).productivityCoef }));
    return plans.map((p) => ({
      objectId: p.objectId,
      objectName: p.objectName,
      works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: p.shift?.employeeIds ?? [] })),
      sessions: p.shift
        ? p.shift.employeeIds.map((employeeId) => ({
            employeeId,
            employeeName: employeeName(employeeId),
            droppedAt: p.shift!.startedAt,
            pickedUpAt: p.shift!.endedAt,
          }))
        : [],
      coefs: coefList,
      notes: p.notes,
      photoUrls: p.photoUrls,
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
      // Generated once per tap and reused across this call's own automatic
      // network retries (see lib/api.ts): if a retry happens because the
      // response was lost but the write actually succeeded, the server
      // treats it as the same submission attempt instead of logging a
      // second, phantom one. A later tap (a genuinely new edit/resubmit)
      // gets a fresh key from a fresh call to save().
      const idempotencyKey = crypto.randomUUID();
      const res = await api.post<PayrollPreview & { eventId: string }>("/api/road-timesheet", {
        date,
        carId,
        odoStart: Number(odoStart),
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
        employeeIds,
        objects: buildObjectsPayload(),
        idempotencyKey,
      });
      setResult(res);
      setStep("DONE");
      clearDraft();
      logChange("Звіт відправлено");
      haptic("success");
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setSaving(false);
    }
  }

  const backTargets: Partial<Record<Step, Step>> = {
    PICK_CAR: "HUB",
    ODO_START: "PICK_CAR",
    PICK_PEOPLE: "HUB",
    PICK_OBJECTS: "HUB",
    PLAN: "HUB",
    PLAN_WORKS: "PLAN",
    READY: "HUB",
    RETURN: "DRIVE",
    REVIEW: "RETURN",
  };
  // PLAN_VOLUMES can be reached from more than one place (finishing a shift
  // at the object, or catching up on unfilled volumes from RETURN), so its
  // back target is wherever it was actually opened from, not a fixed step.
  const goBack = () => {
    if (step === "PLAN_VOLUMES") {
      setStep(volumesReturnStep);
      return;
    }
    if (backTargets[step]) {
      setStep(backTargets[step]!);
      return;
    }
    onBack();
  };
  useTelegramBackButton(goBack);

  if (step === "DONE" && result) {
    return (
      <div>
        <div className="header">
          <h1>✅ Відправлено на підтвердження</h1>
          <div className="hint">Можна й далі редагувати та надсилати повторно, поки адміністратор не затвердить день.</div>
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
        <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
          <button className="back-btn" onClick={() => setStep("HUB")}>✏️ Редагувати ще</button>
        </div>
        <MainButton text="До меню" onClick={onSaved} />
      </div>
    );
  }

  if (dayStatus === null) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <div className="header">
          <h1>🚗 Дорожній табель</h1>
        </div>
        <div className="empty-state">Завантаження…</div>
      </div>
    );
  }

  if (dayStatus.approved) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <div className="header">
          <h1>🚗 Дорожній табель</h1>
        </div>
        <div className="list">
          <div className="cell" style={{ cursor: "default" }}>
            <span className="cell-title">✅ День затверджено адміністратором</span>
            <span className="cell-sub">{date}</span>
          </div>
        </div>
        <div className="hint" style={{ padding: "0 16px 8px" }}>
          Якщо потрібно щось виправити — надішліть запит адміністратору на редагування.
        </div>
        {dayStatus.editRequested ? (
          <div className="empty-state">🔓 Запит на редагування вже надіслано, очікуйте.</div>
        ) : (
          <MainButton text="🔓 Запросити редагування" onClick={requestEdit} />
        )}
      </div>
    );
  }

  const allObjectsPlanned = plans.length > 0 && plans.every((p) => p.works.length > 0);
  const readyToDepart = !!carId && !!odoStart && employeeIds.length > 0 && allObjectsPlanned;
  const readinessScore = [!!carId && !!odoStart, employeeIds.length > 0, plans.length > 0, allObjectsPlanned].filter(Boolean).length;
  const showCopySuggestion = !!lastTrip && !carId && !employeeIds.length && !plans.length;

  return (
    <div>
      <BackRow onBack={goBack} />
      <div className="header">
        <h1>🚗 Дорожній табель</h1>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {submittedEditBanner && (
        <div className="hint" style={{ padding: "0 16px 8px" }}>
          📤 Це вже відправлений звіт. Можна редагувати — після збереження буде надіслано нову версію, поки адміністратор не затвердить.
        </div>
      )}

      {undo && (
        <div className="undo-toast">
          <span>{undo.label}</span>
          <button
            onClick={() => {
              undo.restore();
              setUndo(null);
              if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
            }}
          >
            Відмінити
          </button>
        </div>
      )}

      {step === "HUB" && (
        <>
          <div className="section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Поточна поїздка · {date}</span>
            {!tripStartedAt && <span className="badge">{readinessScore}/4 готово</span>}
          </div>

          {restoredBanner && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              🔄 Відновлено чернетку дня, яку не встигли відправити.
            </div>
          )}

          {showCopySuggestion && lastTrip && (
            <div className="suggestion-card">
              <div className="cell-title">🔁 Повторити маршрут з {lastTrip.date}?</div>
              <div className="hint">
                {cars.find((c) => c.id === lastTrip.carId)?.name ?? lastTrip.carId} · {lastTrip.employeeIds.length} людей · {lastTrip.objects.length} обʼєктів
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="chip" onClick={() => setLastTrip(null)}>
                  Приховати
                </button>
                <button className="chip selected" onClick={applyLastTrip}>
                  Застосувати
                </button>
              </div>
            </div>
          )}

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

          {tripStartedAt && (
            <>
              <div className="section-title">Хто де зараз</div>
              <div className="list">
                {employeeIds.map((id) => {
                  const atPlan = plans.find((p) => p.here.includes(id));
                  const label = onboard.includes(id) ? "🚗 в дорозі" : atPlan ? `📍 ${atPlan.objectName}` : "❓";
                  return (
                    <div key={id} className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title">{employeeName(id)}</span>
                      <span className="cell-sub">{label}</span>
                    </div>
                  );
                })}
              </div>

              <div className="section-title">Маршрут</div>
              <div className="list">
                {plans.map((p) => {
                  const shiftActive = !!(p.shift && !p.shift.endedAt);
                  const label = !p.visited ? "заплановано" : shiftActive ? "🔧 роботи тривають" : p.here.length ? "тут є люди" : "завершено";
                  return (
                    <div key={p.objectId} className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title">📍 {p.objectName}</span>
                      <span className={`badge ${p.visited ? (shiftActive ? "warn" : "ok") : ""}`}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
            <button className="back-btn" onClick={() => setShowChangeLog((v) => !v)}>
              🕓 Історія дня ({changeLog.length})
            </button>
          </div>
          {showChangeLog && (
            <div className="list" style={{ margin: "0 12px 12px" }}>
              {!changeLog.length && <div className="empty-state">Ще немає записів</div>}
              {changeLog.map((entry, i) => (
                <div key={i} className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">{entry.label}</span>
                  <span className="cell-sub">{new Date(entry.ts).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ))}
            </div>
          )}

          {!tripStartedAt && (carId || employeeIds.length > 0 || plans.length > 0) && (
            <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
              <button className="back-btn" onClick={resetDay}>
                🗑 Почати день заново
              </button>
            </div>
          )}

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
                    haptic("selection");
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
              logChange(`Авто: ${cars.find((c) => c.id === carId)?.name ?? carId}, одометр ${odoStart} км`);
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
          <input className="search-box" placeholder="Пошук людини…" value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} />
          <div className="list">
            {groupByBrigade(employees.filter((e) => e.name.toLowerCase().includes(peopleSearch.toLowerCase()))).map((g) => {
              const expanded = expandedBrigadeId === g.id || !!peopleSearch;
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
              logChange(`Люди оновлено: ${employeeIds.length}`);
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
                <div key={plan.objectId} className="cell-row">
                  <button
                    className="cell"
                    onClick={() => {
                      setPlanObjectId(plan.objectId);
                      setStep("PLAN_WORKS");
                    }}
                  >
                    <span className="cell-title">📍 {plan.objectName}</span>
                    <span className={`badge ${ready ? "ok" : "warn"}`}>{plan.works.length ? `${plan.works.length} робіт` : "не обрано"}</span>
                  </button>
                  <button className="cell-action" onClick={() => removeObjectFromRoute(plan.objectId)} title="Прибрати з маршруту">
                    🗑
                  </button>
                </div>
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
          {plans.length > 1 && (
            <div style={{ padding: "0 16px 8px" }}>
              <button className="chip" onClick={() => applyWorksToAllObjects(planObjectId)} disabled={!planFor(planObjectId).works.length}>
                📋 Застосувати ці роботи до всіх обʼєктів
              </button>
            </div>
          )}

          <div className="section-title">Нотатки (необовʼязково)</div>
          <textarea
            className="notes-textarea"
            value={planFor(planObjectId).notes}
            onChange={(e) => updateNotes(planObjectId, e.target.value)}
            placeholder="Коментар до обʼєкта…"
          />
          <div className="field">
            <label className="hint">📷 Фото обʼєкта (можна кілька)</label>
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadObjectPhoto(planObjectId, e.target.files[0])} />
            {planFor(planObjectId).photoUrls.length > 0 && <div className="badge ok">{planFor(planObjectId).photoUrls.length} фото додано</div>}
          </div>

          <MainButton
            text="Готово"
            onClick={() => {
              logChange(`Роботи на "${planFor(planObjectId).objectName}": ${planFor(planObjectId).works.length}`);
              setStep("PLAN");
            }}
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
                <MainButton text="Зберегти пакет (можна пізніше)" onClick={() => setStep(volumesReturnStep)} />
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
          <div className="section-title">Обʼєкти · роботи</div>
          <div className="list">
            {plans.map((p) => (
              <div key={p.objectId} className="cell" style={{ cursor: "default", display: "block" }}>
                <div className="cell-title">📍 {p.objectName}</div>
                <div className="hint">{p.works.map((w) => w.workName).join(" · ")}</div>
              </div>
            ))}
          </div>
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
            const shiftOpen = !!(plan.shift && !plan.shift.endedAt);
            return (
              <>
                <div className="step-badge">НА ОБʼЄКТІ</div>
                <div className="section-title">📍 {plan.objectName}</div>

                {shiftOpen ? (
                  <div className="active-work-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>Роботи тривають</div>
                        <div className="hint">{plan.works.map((w) => w.workName).join(", ") || "—"}</div>
                        <div className="hint">{plan.shift!.employeeIds.map(employeeName).join(", ")}</div>
                      </div>
                      <button className="chip danger-btn" onClick={finishShift}>
                        ⏹ Завершити
                      </button>
                    </div>
                    <div className="timer-big" style={{ padding: "4px 0" }}>{fmtHMS(now - new Date(plan.shift!.startedAt).getTime())}</div>
                  </div>
                ) : (
                  <div className="empty-state">Роботи ще не розпочато</div>
                )}

                {!showDropPicker && !showMovePicker && (
                  <div className="list" style={{ marginTop: 8 }}>
                    {!shiftOpen && (
                      <button className="cell" onClick={startShift} disabled={!plan.here.length || !plan.works.length}>
                        <span className="cell-title">▶️ Почати роботи</span>
                        <span className="cell-sub">{plan.here.length ? `${plan.here.length} людей` : "нікого не висаджено"}</span>
                      </button>
                    )}
                    <button className="cell" onClick={() => setShowMovePicker(true)} disabled={!plan.here.length}>
                      <span className="cell-title">🔄 Перенести людей на інший обʼєкт</span>
                    </button>
                    <button className="cell" onClick={() => setShowDropPicker(true)} disabled={!onboard.length}>
                      <span className="cell-title">👥 Висадити людей тут</span>
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
                      <div className="chip" onClick={() => setMoveSelected(plan.here)}>
                        Обрати всіх
                      </div>
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

                <div className="hint" style={{ padding: "0 16px 8px", textAlign: "center" }}>
                  Можна їхати далі з тими, хто залишився в машині — робота тут триватиме без вас.
                </div>
                <MainButton text="➡️ Продовжити маршрут" onClick={() => setStep("DRIVE")} />
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
              .map((p) => {
                const unfilled = p.works.filter((w) => !w.volume || w.volume === "?").length;
                return (
                  <div key={p.objectId} className="cell" style={{ cursor: "default", display: "block" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="cell-title">📍 {p.objectName}</span>
                      {p.here.length ? (
                        <button className="chip" onClick={() => pickUpHere(p.objectId)}>
                          Забрати ({p.here.map(employeeName).join(", ")})
                        </button>
                      ) : (
                        <span className="badge ok">забрано</span>
                      )}
                    </div>
                    {unfilled > 0 && (
                      <button className="chip" style={{ marginTop: 6 }} onClick={() => openVolumesForObject(p.objectId, "RETURN")}>
                        🟡 Ввести обсяги ({unfilled})
                      </button>
                    )}
                  </div>
                );
              })}
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
              logChange(`Повернення: одометр ${odoEnd} км`);
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
              const totalMs = plans.reduce((acc, p) => {
                if (!p.shift || !p.shift.employeeIds.includes(id)) return acc;
                const start = new Date(p.shift.startedAt).getTime();
                const end = new Date(p.shift.endedAt ?? new Date().toISOString()).getTime();
                return acc + Math.max(0, end - start);
              }, 0);
              return (
                <div key={id} className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">{employeeName(id)}</span>
                  <span className="cell-sub">{fmtHours(totalMs)} год</span>
                </div>
              );
            })}
          </div>

          {employeeIds.length > 0 && (
            <>
              <div className="section-title" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Коефіцієнти</span>
                <button className="chip" onClick={() => setShowCoefs((v) => !v)}>
                  {showCoefs ? "Сховати" : "Детальніше"}
                </button>
              </div>
              {showCoefs && (
                <>
                  <div className="hint" style={{ padding: "0 16px 8px" }}>
                    Впливає лише на розподіл частки робітників у фонді обʼєкта. За замовчуванням 1.0 для всіх.
                  </div>
                  <div className="list">
                    {employeeIds
                      .filter((id) => roleFor(id) === "робітник")
                      .map((id) => (
                        <div key={id} className="cell" style={{ cursor: "default", display: "block" }}>
                          <div className="cell-title">{employeeName(id)}</div>
                          <div className="hint">Дисципліна</div>
                          <div className="chip-row">
                            {COEF_PRESETS.map((v) => (
                              <div
                                key={v}
                                className={`chip ${coefFor(id).disciplineCoef === v ? "selected" : ""}`}
                                onClick={() => setCoef(id, "disciplineCoef", v)}
                              >
                                {v}
                              </div>
                            ))}
                          </div>
                          <div className="hint">Продуктивність</div>
                          <div className="chip-row">
                            {COEF_PRESETS.map((v) => (
                              <div
                                key={v}
                                className={`chip ${coefFor(id).productivityCoef === v ? "selected" : ""}`}
                                onClick={() => setCoef(id, "productivityCoef", v)}
                              >
                                {v}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </>
          )}

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

          <MainButton
            text={saving ? "Відправлення…" : dayStatus.hasSubmission ? "📤 Оновити звіт" : "📤 Відправити на підтвердження"}
            onClick={save}
            disabled={saving}
          />
        </>
      )}
    </div>
  );
}
