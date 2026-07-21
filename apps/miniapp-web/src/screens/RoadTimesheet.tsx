import { useEffect, useRef, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject, type SalaryPack } from "../lib/api";
import { todayISO } from "../lib/date";
import { confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, initials, roleAccent, groupByBrigade } from "../lib/employee";
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
  | "ARRIVE_PICK"
  | "AT_OBJECT"
  | "RETURN_PICKUP"
  | "RETURN"
  | "REVIEW"
  | "DONE";

// workStartedAt/workAccumulatedMs let each work item at an object be
// started/stopped independently of every other work there (e.g. mowing
// finishes while watering keeps going) -- same accumulated+segment pattern
// as the driving timer (drivingAccumulatedMs/drivingSegmentStartedAt).
type PlannedWork = {
  workId: string;
  workName: string;
  unit: string;
  volume: string;
  workStartedAt?: string | null;
  workAccumulatedMs?: number;
};
// Per-employee work session at an object: started when work begins for that
// person, ended either individually (picked up early / stopped alone) or all
// together via "Завершити". Lets people finish and leave an object at
// different times instead of a single all-or-nothing shift.
type EmployeeSession = { employeeId: string; startedAt: string; endedAt?: string };
type ObjPlan = {
  objectId: string;
  objectName: string;
  works: PlannedWork[];
  assignedEmployeeIds: string[]; // planned before departure
  here: string[]; // physically dropped off at this object right now
  sessions: EmployeeSession[];
  visited: boolean; // reached (formally, or via a quick drop-off during the drive)
  notes: string;
  photoUrls: string[];
};

// Where an employee currently is: exactly one of onboard, one specific
// object's `here`, or nowhere (taken off the day's active roster entirely).
type Location = { kind: "onboard" } | { kind: "object"; objectId: string } | { kind: "nowhere" };

type CoefPair = { disciplineCoef: number; productivityCoef: number };

type PayrollPreview = {
  km?: number;
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
  brigadierEmployeeId: string;
  seniorEmployeeIds: string[];
};
// The day-combined totals -- what actually gets paid out -- once more than
// one trip has been submitted for the same day (see SubmittedTrip below).
type DayCombined = { km: number; tripClass: string; roadAllowance: { total: number; perPerson: number }; salaryPacks: SalaryPack[] };
type SaveResponse = PayrollPreview & { eventId: string; tripSeq: number; combined: DayCombined };

type DayStatus = { hasSubmission: boolean; approved: boolean; eventId: string | null; editRequested: boolean };
type SubmittedObject = {
  objectId: string;
  objectName: string;
  works: { workId: string; workName: string; volume?: string | number }[];
  sessions: { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string }[];
  notes?: string;
  photoUrls?: string[];
};
// One leg ("trip") already submitted today: most days have exactly one, but
// a foreman who returns to base and heads out again with a different
// car/crew/objects ends up with several, each independently editable.
type SubmittedTrip = {
  tripSeq: number;
  eventId: string;
  status: string;
  carId: string | null;
  employeeIds: string[];
  selfTransportIds?: string[];
  odoStart: number | null;
  odoStartPhoto: string | null;
  odoEnd: number | null;
  odoEndPhoto: string | null;
  objects: SubmittedObject[];
  km?: number;
  tripClass?: string;
};
type SubmittedTodayResponse = { found: false; trips: []; combined: null } | { found: true; trips: SubmittedTrip[]; combined: DayCombined };
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
  selfTransportIds: string[];
  plans: ObjPlan[];
  onboard: string[];
  tripStartedAt: string | null;
  drivingAccumulatedMs: number;
  drivingSegmentStartedAt: string | null;
  atObjectId: string | null;
  // Where AT_OBJECT's "✅ Готово" button should return to (DRIVE, RETURN,
  // etc). Without this an app-kill mid-AT_OBJECT restores to the default
  // "DRIVE", which can wrongly resume the driving-segment timer for a leg
  // that had actually already finished (reached AT_OBJECT from RETURN).
  atObjectReturnStep: Step;
  // Which object PLAN_WORKS/PLAN_VOLUMES is currently editing -- those
  // screens render nothing without it, so an app-kill mid-edit would
  // otherwise restore to a blank screen with no way back except resetting.
  planObjectId: string | null;
  coefs: Record<string, CoefPair>;
  // Which already-submitted trip this draft is mid-edit of, if any -- lost
  // without this, an interrupted edit (app killed before resubmitting) would
  // resume as if it were a brand-new trip and create a duplicate on save.
  editingTripSeq: number | null;
};

// Autosaved drafts can predate a schema change (e.g. the old singular
// `shift` field replaced by per-employee `sessions`) and sit in localStorage
// for up to MAX_AGE_MS, so restoring one has to tolerate whatever shape an
// older build of this screen last wrote instead of crashing on load.
function normalizeDraftPlan(raw: unknown): ObjPlan {
  const p = raw as Partial<ObjPlan> & { shift?: { startedAt: string; endedAt?: string; employeeIds: string[] } | null };
  const sessions: EmployeeSession[] = Array.isArray(p.sessions)
    ? p.sessions
    : p.shift
      ? p.shift.employeeIds.map((employeeId) => ({ employeeId, startedAt: p.shift!.startedAt, endedAt: p.shift!.endedAt }))
      : [];
  return {
    objectId: p.objectId ?? "",
    objectName: p.objectName ?? "",
    works: p.works ?? [],
    assignedEmployeeIds: p.assignedEmployeeIds ?? [],
    here: p.here ?? [],
    sessions,
    visited: p.visited ?? false,
    notes: p.notes ?? "",
    photoUrls: p.photoUrls ?? [],
  };
}

const COEF_PRESETS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2];

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

function groupByWorkCategory(worksList: Work[]) {
  const NO_CATEGORY = "__NO_CATEGORY__";
  const map = new Map<string, Work[]>();
  for (const w of worksList) {
    const cat = (w.category ?? "").trim() || NO_CATEGORY;
    const list = map.get(cat) ?? [];
    list.push(w);
    map.set(cat, list);
  }
  return [...map.entries()]
    .map(([id, members]) => ({ id, title: id === NO_CATEGORY ? "Без категорії" : id, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.id === NO_CATEGORY ? 1 : b.id === NO_CATEGORY ? -1 : a.title.localeCompare(b.title)));
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
  // Subset of employeeIds who showed up under their own transport (see
  // confirmDropAndArrived) -- excluded from the road/travel allowance split,
  // but still counted like everyone else for the object work-pay split.
  const [selfTransportIds, setSelfTransportIds] = useState<string[]>([]);
  const [expandedBrigadeId, setExpandedBrigadeId] = useState<string | null>(null);
  const [selectedPeopleExpanded, setSelectedPeopleExpanded] = useState(false);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [objectSearch, setObjectSearch] = useState("");
  const [expandedCityId, setExpandedCityId] = useState<string | null>(null);
  const [selectedObjectsExpanded, setSelectedObjectsExpanded] = useState(false);
  const [plans, setPlans] = useState<ObjPlan[]>([]);

  // --- planning (works / people per object / volumes) ---
  const [planObjectId, setPlanObjectId] = useState<string | null>(null);
  const [planWorksSearch, setPlanWorksSearch] = useState("");
  const [expandedWorkCategoryId, setExpandedWorkCategoryId] = useState<string | null>(null);
  const [selectedWorksExpanded, setSelectedWorksExpanded] = useState(false);
  const [planVolumeWorkId, setPlanVolumeWorkId] = useState<string | null>(null);
  const [volumeBuffer, setVolumeBuffer] = useState("");
  const [bulkVolumeInput, setBulkVolumeInput] = useState<string | null>(null);

  // --- pre-departure review (READY) ---
  const [editReturnStep, setEditReturnStep] = useState<Step>("HUB");
  const [worksReturnStep, setWorksReturnStep] = useState<Step>("PLAN");
  const [readyPeopleExpanded, setReadyPeopleExpanded] = useState(false);
  const [readyExpandedObjectId, setReadyExpandedObjectId] = useState<string | null>(null);

  // --- payroll coefficients (day-wide, applied to every object) ---
  const [coefs, setCoefs] = useState<Record<string, CoefPair>>({});
  const [expandedCoefEmployeeId, setExpandedCoefEmployeeId] = useState<string | null>(null);
  const [expandedReviewObjectId, setExpandedReviewObjectId] = useState<string | null>(null);
  const [reviewPeopleExpanded, setReviewPeopleExpanded] = useState(false);
  const [reviewWorkersExpanded, setReviewWorkersExpanded] = useState(false);
  const [reviewReturnStep, setReviewReturnStep] = useState<Step>("RETURN");

  // --- drive ---
  const [onboard, setOnboard] = useState<string[]>([]);
  const [tripStartedAt, setTripStartedAt] = useState<string | null>(null);
  // Net time actually spent driving (not counting time stopped at an
  // object) -- drivingAccumulatedMs is every FINISHED driving segment
  // summed up, drivingSegmentStartedAt is when the CURRENT segment began
  // (null while stopped at an object). The "🚗 ПОЇЗДКА" timer shows
  // accumulated + time-since-drivingSegmentStartedAt, so it pauses the
  // moment the foreman arrives somewhere and resumes the moment they head
  // out again, instead of just counting up from the whole trip's start.
  const [drivingAccumulatedMs, setDrivingAccumulatedMs] = useState(0);
  const [drivingSegmentStartedAt, setDrivingSegmentStartedAt] = useState<string | null>(null);
  const [showRoadsideActions, setShowRoadsideActions] = useState(false);
  const [expandedDriveObjectId, setExpandedDriveObjectId] = useState<string | null>(null);

  // --- at object ---
  const [atObjectId, setAtObjectId] = useState<string | null>(null);
  const [atObjectReturnStep, setAtObjectReturnStep] = useState<Step>("DRIVE");
  const [atObjectDetailsExpanded, setAtObjectDetailsExpanded] = useState(false);
  const [volumesReturnStep, setVolumesReturnStep] = useState<Step>("AT_OBJECT");
  const [expandedReturnObjectId, setExpandedReturnObjectId] = useState<string | null>(null);
  const [expandedReturnPickupObjectId, setExpandedReturnPickupObjectId] = useState<string | null>(null);
  const [dropSelected, setDropSelected] = useState<string[]>([]);
  const [showDropPicker, setShowDropPicker] = useState(false);
  const [moveSelected, setMoveSelected] = useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);
  // Manual hours fallback: if the foreman forgot to start the timer for
  // someone, they can type the worked hours in directly here. showManualHours
  // opens the per-person list; manualHoursEmployeeId + manualHoursBuffer drive
  // the keypad for the one person being edited.
  const [showManualHours, setShowManualHours] = useState(false);
  const [manualHoursEmployeeId, setManualHoursEmployeeId] = useState<string | null>(null);
  const [manualHoursBuffer, setManualHoursBuffer] = useState("");
  // Never carry an open manual-hours editor from one object to the next,
  // whichever way the object changes (arrive, switch, or an ✏️ edit entry).
  useEffect(() => {
    setShowManualHours(false);
    setManualHoursEmployeeId(null);
  }, [atObjectId]);
  // People who show up at an object on their own (their own car, etc.) --
  // never picked in PICK_PEOPLE, so not in employeeIds/onboard/here at all
  // until added here. Picked from the same "drop off" screen (showDropPicker)
  // as the vehicle's own passengers, with its own search/expanded-brigade
  // state so it doesn't interfere with PICK_PEOPLE's.
  const [addArrivedSelected, setAddArrivedSelected] = useState<string[]>([]);
  const [arrivedSearch, setArrivedSearch] = useState("");
  const [expandedArrivedBrigadeId, setExpandedArrivedBrigadeId] = useState<string | null>(null);

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
  const [lastTripExpanded, setLastTripExpanded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [submittedTrips, setSubmittedTrips] = useState<SubmittedTrip[]>([]);
  const [dayCombined, setDayCombined] = useState<DayCombined | null>(null);
  const [editingTripSeq, setEditingTripSeq] = useState<number | null>(null);
  const [inProgressResumeStep, setInProgressResumeStep] = useState<Step | null>(null);
  const [expandedTripSeq, setExpandedTripSeq] = useState<number | null>(null);
  const [doneTripPeopleExpanded, setDoneTripPeopleExpanded] = useState(false);

  function fetchCarStatus() {
    api
      .get<{ taken: { carId: string; foremanName: string }[] }>(`/api/road-timesheet/car-status?date=${date}`)
      .then((res) => setTakenCars(new Map(res.taken.map((t) => [t.carId, t.foremanName]))))
      .catch(() => {});
  }

  function fetchPeopleStatus() {
    api
      .get<{ taken: { employeeId: string; foremanName: string }[] }>(`/api/road-timesheet/people-status?date=${date}`)
      .then((res) => setBusyEmployees(new Map(res.taken.map((t) => [t.employeeId, t.foremanName]))))
      .catch(() => {});
  }

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
    api
      .get<{ lastOdometer: Record<string, number> }>("/api/road-timesheet/cars-last-odometer")
      .then((res) => setLastOdometer(res.lastOdometer))
      .catch(() => {});
    fetchCarStatus();
    fetchPeopleStatus();
    api
      .get<LastTripResponse>(`/api/road-timesheet/last-trip?before=${date}`)
      .then((res) => {
        if (res.found) setLastTrip({ date: res.date, carId: res.carId ?? "", employeeIds: res.employeeIds, objects: res.objects });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // The fetch above only reflects the moment this screen first mounted --
  // another foreman reserving or returning a car/person while this session
  // stays open wouldn't show up otherwise. Re-sync every time the foreman
  // actually lands on a picker, so switching back to PICK_CAR/PICK_PEOPLE
  // (even without leaving the app) always reflects the current server state.
  useEffect(() => {
    if (step === "PICK_CAR" || step === "PICK_PEOPLE") {
      fetchCarStatus();
      fetchPeopleStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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
    // A draft only counts as "in-progress work to resume" if something was
    // actually entered -- "Розпочати нову поїздку" itself autosaves a blank
    // HUB draft the moment it's tapped, and that blank leftover must not
    // masquerade as real work and block the submitted-trips list below.
    const hasContent = !!draft && (!!draft.carId || draft.employeeIds.length > 0 || draft.plans.length > 0 || !!draft.tripStartedAt);
    if (draft && hasContent && draft.step !== "DONE") {
      if (draft.date !== date) setDate(draft.date);
      setCarId(draft.carId);
      setOdoStart(draft.odoStart);
      setOdoStartPhoto(draft.odoStartPhoto);
      setOdoEnd(draft.odoEnd);
      setOdoEndPhoto(draft.odoEndPhoto);
      setEmployeeIds(draft.employeeIds);
      setSelfTransportIds(draft.selfTransportIds ?? []);
      setPlans((draft.plans ?? []).map(normalizeDraftPlan));
      setOnboard(draft.onboard);
      setTripStartedAt(draft.tripStartedAt);
      setDrivingAccumulatedMs(draft.drivingAccumulatedMs ?? 0);
      setDrivingSegmentStartedAt(draft.drivingSegmentStartedAt ?? null);
      setAtObjectId(draft.atObjectId);
      setAtObjectReturnStep(draft.atObjectReturnStep ?? "DRIVE");
      setPlanObjectId(draft.planObjectId ?? null);
      setCoefs(draft.coefs ?? {});
      setEditingTripSeq(draft.editingTripSeq ?? null);
      setInProgressResumeStep(draft.step);
      setStep(draft.step);
      setRestoredBanner(true);
      draftRestoredRef.current = true;
    } else if (draft) {
      clearDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps "resume where I left off" pointed at wherever the user ACTUALLY is,
  // not frozen at whatever step a draft happened to restore to on mount --
  // the day-status effect below can force step to "DONE" asynchronously
  // (e.g. once it learns today already has a submission), and without this
  // the "▶️ Продовжити" card on DONE would send the user back to a stale step
  // instead of the one they'd actually progressed to since mount.
  useEffect(() => {
    if (step !== "HUB" && step !== "DONE") setInProgressResumeStep(step);
  }, [step]);

  // Not-yet-approved submissions aren't locked -- the foreman can keep
  // viewing/editing them. Always shows every trip submitted today as
  // collapsed cards (never just dumps into an editable screen), regardless
  // of whether a local in-progress draft was also restored above -- that
  // draft's own working state (carId/plans/etc) is untouched by this effect,
  // so the two don't conflict; the in-progress trip just shows as its own
  // card in the list (see the DONE screen render) instead of taking over.
  useEffect(() => {
    api
      .get<DayStatus>(`/api/road-timesheet/day-status?date=${date}`)
      .then(async (status) => {
        setDayStatus(status);
        if (!status.hasSubmission) return;
        const res = await api.get<SubmittedTodayResponse>(`/api/road-timesheet/submitted-today?date=${date}`);
        if (!res.found) return;
        setSubmittedTrips(res.trips);
        setDayCombined(res.combined);
        // Land on DONE regardless of approval -- an approved trip earlier
        // today must not block starting another one (see the DONE screen's
        // pending/approved split below).
        setStep("DONE");
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
      selfTransportIds,
      plans,
      onboard,
      tripStartedAt,
      drivingAccumulatedMs,
      drivingSegmentStartedAt,
      atObjectId,
      atObjectReturnStep,
      planObjectId,
      coefs,
      editingTripSeq,
    });
  }, [
    date,
    step,
    carId,
    odoStart,
    odoStartPhoto,
    odoEnd,
    odoEndPhoto,
    employeeIds,
    selfTransportIds,
    plans,
    onboard,
    tripStartedAt,
    drivingAccumulatedMs,
    drivingSegmentStartedAt,
    atObjectId,
    atObjectReturnStep,
    planObjectId,
    coefs,
    editingTripSeq,
  ]);

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

  // Called after ODO_START (car picked, people maybe not yet) and again
  // after PICK_PEOPLE (now both are known) -- the car and people halves are
  // independent server-side, so this must fire as soon as EITHER is ready,
  // not only once both are. Requiring both meant picking a car and stopping
  // right there (before choosing people) never actually reserved the car at
  // all -- it just sat in local state, invisible to every other foreman.
  // Returns false on a 409 conflict (car/person taken by another foreman in
  // the meantime) so callers can stop the wizard from advancing instead of
  // just showing the error text underneath a screen the user already left.
  async function reserveIfPossible(): Promise<boolean> {
    if (!carId && !employeeIds.length) return true;
    try {
      await api.post("/api/road-timesheet/reserve", { date, carId, employeeIds });
      return true;
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
      return false;
    }
  }

  // Frees the car for other foremen the moment it's actually back at base --
  // otherwise it stayed "reserved" until the whole day gets submitted, even
  // though nobody's driving it anymore right after this point.
  async function markCarReturned() {
    if (!carId || !odoEnd) return;
    try {
      await api.post("/api/road-timesheet/car-return", {
        date,
        carId,
        odoStart: odoStart ? Number(odoStart) : undefined,
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
      });
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

  async function resetDay() {
    const confirmed = await confirmDialog(
      "Точно почати день заново? Усі дані поточної поїздки буде видалено з цього екрана (уже відправлений звіт на сервері це не видаляє, лише перезапише його наступною відправкою).",
    );
    if (!confirmed) return;
    if (carId || employeeIds.length) {
      try {
        await api.post("/api/road-timesheet/reserve/release", {
          date,
          carId: carId || undefined,
          employeeIds: employeeIds.length ? employeeIds : undefined,
        });
      } catch {
        // best-effort -- resetting the local draft must not be blocked by a network hiccup
      }
    }
    clearDraft();
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setSelfTransportIds([]);
    setPlans([]);
    setCoefs({});
    setOnboard([]);
    setTripStartedAt(null);
    setDrivingAccumulatedMs(0);
    setDrivingSegmentStartedAt(null);
    setAtObjectId(null);
    setChangeLog([]);
    setRestoredBanner(false);
    setSubmittedEditBanner(false);
    setPreview(null);
    setEditingTripSeq(null);
    setInProgressResumeStep(null);
    haptic("success");
    setStep("HUB");
  }

  function objectsToPlans(objects: SubmittedObject[]): ObjPlan[] {
    return objects.map((o) => ({
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
      sessions: o.sessions.map((s) => ({ employeeId: s.employeeId, startedAt: s.droppedAt, endedAt: s.pickedUpAt })),
      visited: true,
      notes: o.notes ?? "",
      photoUrls: o.photoUrls ?? [],
    }));
  }

  // Brigadiers shouldn't see who-earned-what until an admin approves the
  // day -- masked=true swaps every money figure for "•••" (shape/roles/names
  // still visible so they can double-check the report itself). Shared by the
  // not-yet-approved DONE screen (always masked) and the approved screen
  // (always unmasked, once it's out of their hands to change anything).
  function renderFundBreakdown(masked: boolean) {
    if (!dayCombined) return null;
    const isMultiTrip = submittedTrips.length > 1;

    const payByEmployee = new Map<string, number>();
    dayCombined.salaryPacks.forEach((pack) =>
      pack.rows.forEach((r) => payByEmployee.set(r.employeeId, (payByEmployee.get(r.employeeId) ?? 0) + r.pay)),
    );
    const dayEmployeeIds = [...new Set(submittedTrips.flatMap((t) => t.employeeIds))];
    const daySelfTransportIds = new Set(submittedTrips.flatMap((t) => t.selfTransportIds ?? []));
    const grandTotal = dayCombined.salaryPacks.reduce((a, pack) => a + pack.objectTotal, 0) + dayCombined.roadAllowance.total;

    return (
      <>
        <div className="list" style={{ marginTop: 8 }}>
          <div className="cell" style={{ cursor: "default" }}>
            <span className="cell-title">💸 Доплата за виїзд{isMultiTrip ? " (загальна)" : ""}</span>
            <span className="cell-sub">{masked ? "🔒 •••" : `${dayCombined.roadAllowance.perPerson} грн/особу`}</span>
          </div>
        </div>

        <div className="section-title">Виплати</div>
        <div className="list">
          {dayEmployeeIds.map((id) => {
            const gotAllowance = !daySelfTransportIds.has(id);
            const total = Math.round(((payByEmployee.get(id) ?? 0) + (gotAllowance ? dayCombined.roadAllowance.perPerson : 0)) * 100) / 100;
            return (
              <div key={id} className="cell" style={{ cursor: "default" }}>
                <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                  {employeeName(id)}
                  {!gotAllowance && <span className="badge">🚶 без доплати за дорогу</span>}
                </span>
                <span className="cell-sub">{masked ? "🔒 •••" : `${total} ₴`}</span>
              </div>
            );
          })}
        </div>

        <div className="list" style={{ marginTop: 8 }}>
          <div className="cell" style={{ cursor: "default" }}>
            <span className="cell-title">💰 Загальна сума</span>
            <span className="cell-sub">{masked ? "🔒 •••" : `${Math.round(grandTotal * 100) / 100} ₴`}</span>
          </div>
        </div>
      </>
    );
  }

  // One trip card on the DONE screen. editable=false for an already-approved
  // trip -- no edit button (an approved trip is locked; "Запросити
  // редагування" is the escape hatch for the whole day, not per-trip).
  function renderTripCard(trip: SubmittedTrip, editable: boolean) {
    const expanded = expandedTripSeq === trip.tripSeq;
    return (
      <div key={trip.tripSeq} className="list" style={{ marginTop: 8 }}>
        <button
          className="cell"
          onClick={() => {
            setExpandedTripSeq(expanded ? null : trip.tripSeq);
            setDoneTripPeopleExpanded(false);
          }}
        >
          <span className="cell-title">
            {expanded ? "▾" : "▸"} 🚙 {cars.find((c) => c.id === trip.carId)?.name ?? "Поїздка"}
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className={`badge ${editable ? "warn" : "ok"}`}>{editable ? "здано" : "✅ затверджено"}</span>
            <span className="cell-sub">
              {trip.km ?? "—"} км · клас {trip.tripClass ?? "—"}
            </span>
          </span>
        </button>
        {expanded && (
          <div style={{ padding: "0 16px 12px" }} className="hint">
            <button className="back-btn" onClick={() => setDoneTripPeopleExpanded((v) => !v)}>
              {doneTripPeopleExpanded ? "▾ Сховати людей" : `▸ Показати людей (${trip.employeeIds.length})`}
            </button>
            {doneTripPeopleExpanded && (
              <div className="list" style={{ margin: "8px 0" }}>
                {trip.employeeIds.length ? (
                  trip.employeeIds.map((id) => (
                    <div key={id} className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {employeeName(id)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">Нікого не обрано</div>
                )}
              </div>
            )}
            {trip.objects.map((o) => (
              <div key={o.objectId} style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 600 }}>📍 {o.objectName}</div>
                {o.works.length
                  ? o.works.map((w) => (
                      <div key={w.workId}>
                        {w.workName}
                        {w.volume && w.volume !== "?" ? `: ${w.volume} ${works.find((x) => x.id === w.workId)?.unit ?? ""}` : ""}
                      </div>
                    ))
                  : "без робіт"}
              </div>
            ))}
          </div>
        )}
        <div style={{ padding: "8px 16px 12px" }}>
          {editable ? (
            <button className="chip" onClick={() => editTrip(trip)}>
              ✏️ Редагувати цей виїзд
            </button>
          ) : (
            <span className="hint">🔒 Затверджено адміністратором</span>
          )}
        </div>
      </div>
    );
  }

  // Loads one already-submitted leg's own data into the shared working state
  // (carId/plans/etc) so the existing REVIEW screen -- built for editing a
  // single trip -- can edit it, without touching any other leg of the day.
  function editTrip(trip: SubmittedTrip) {
    setEditingTripSeq(trip.tripSeq);
    setCarId(trip.carId ?? "");
    setOdoStart(trip.odoStart !== null ? String(trip.odoStart) : "");
    setOdoStartPhoto(trip.odoStartPhoto);
    setOdoEnd(trip.odoEnd !== null ? String(trip.odoEnd) : "");
    setOdoEndPhoto(trip.odoEndPhoto);
    setEmployeeIds(trip.employeeIds);
    setSelfTransportIds(trip.selfTransportIds ?? []);
    setOnboard(trip.employeeIds);
    const restoredPlans = objectsToPlans(trip.objects);
    setPlans(restoredPlans);
    setSubmittedEditBanner(true);
    setReviewReturnStep("DONE");
    setStep("REVIEW");
    api
      .post<PayrollPreview>("/api/road-timesheet/preview", {
        odoStart: trip.odoStart ?? 0,
        odoEnd: trip.odoEnd ?? 0,
        employeeIds: trip.employeeIds,
        selfTransportIds: trip.selfTransportIds ?? [],
        objects: restoredPlans.map((p) => ({
          objectId: p.objectId,
          objectName: p.objectName,
          works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: p.sessions.map((s) => s.employeeId) })),
          sessions: p.sessions.map((s) => ({
            employeeId: s.employeeId,
            employeeName: employeeName(s.employeeId),
            droppedAt: s.startedAt,
            pickedUpAt: s.endedAt,
          })),
        })),
      })
      .then(setPreview)
      .catch(() => {});
  }

  // Blanks the working state for a brand-new leg while leaving today's
  // already-submitted trips exactly as they are -- e.g. came back to base at
  // lunch, swapped crew, and is heading out to a different object.
  function startNewTrip() {
    setEditingTripSeq(null);
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setSelfTransportIds([]);
    setPlans([]);
    setCoefs({});
    setOnboard([]);
    setTripStartedAt(null);
    setDrivingAccumulatedMs(0);
    setDrivingSegmentStartedAt(null);
    setAtObjectId(null);
    setChangeLog([]);
    setSubmittedEditBanner(false);
    setPreview(null);
    setInProgressResumeStep(null);
    haptic("selection");
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
        works: o.works.map((w) => ({
          workId: w.workId,
          workName: w.workName,
          unit: works.find((x) => x.id === w.workId)?.unit || "шт",
          volume: "",
        })),
        assignedEmployeeIds: [],
        here: [],
        sessions: [],
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

  // Removes every recorded session for these employees, everywhere. Used
  // when someone is taken off the trip roster entirely (as opposed to being
  // dropped off/picked up mid-shift, which correctly keeps the segment they
  // already worked) -- "remove from trip" means "they were never really
  // part of today", so no partial hours of theirs should survive into payroll.
  function stripSessionsFor(ids: string[]) {
    const idSet = new Set(ids);
    setPlans((prev) =>
      prev.map((p) => (p.sessions.some((s) => idSet.has(s.employeeId)) ? { ...p, sessions: p.sessions.filter((s) => !idSet.has(s.employeeId)) } : p)),
    );
  }

  // Retroactive add-a-person-to-a-submitted-day flow: which object they were
  // at needs picking before the hours field makes sense (works themselves
  // come along automatically from that object's plan, no need to re-pick).
  const [retroAssignEmployeeId, setRetroAssignEmployeeId] = useState<string | null>(null);
  const [retroAssignObjectId, setRetroAssignObjectId] = useState<string | null>(null);
  const [retroAssignHours, setRetroAssignHours] = useState("");

  function cancelRetroAssign() {
    setRetroAssignEmployeeId(null);
    setRetroAssignObjectId(null);
    setRetroAssignHours("");
  }

  function confirmRetroAssign() {
    const hours = Number(retroAssignHours);
    if (!retroAssignEmployeeId || !retroAssignObjectId || !Number.isFinite(hours) || hours <= 0) return;
    const empId = retroAssignEmployeeId;
    const objId = retroAssignObjectId;
    const now = Date.now();
    const startedAt = new Date(now - hours * 3_600_000).toISOString();
    const endedAt = new Date(now).toISOString();
    setEmployeeIds((prev) => (prev.includes(empId) ? prev : [...prev, empId]));
    setPlans((prev) => prev.map((p) => (p.objectId !== objId ? p : { ...p, sessions: [...p.sessions, { employeeId: empId, startedAt, endedAt }] })));
    logChange(`${employeeName(empId)} додано заднім числом на "${planFor(objId).objectName}" (${hours} год)`);
    haptic("success");
    cancelRetroAssign();
  }

  // Removes one or more employees from the trip roster entirely -- strips
  // their sessions and clears their location, same as toggling each off one
  // by one. The undo restores exactly what was removed (each person's prior
  // location -- onboard / a specific object / nowhere -- plus their session
  // records per object) via targeted functional updates, instead of
  // snapshotting and replacing the whole `plans`/`onboard` state, which would
  // otherwise both fail to restore `onboard` (never captured) and clobber any
  // unrelated route edits made in the few seconds before the undo is tapped.
  function removeEmployeesFromTrip(ids: string[], undoLabel: string) {
    if (!ids.length) return;
    const removedSelfTransportIds = ids.filter((id) => selfTransportIds.includes(id));
    if (tripStartedAt) {
      const priorLocationById = new Map<string, Location>(
        ids.map((id) => {
          if (onboard.includes(id)) return [id, { kind: "onboard" } as Location];
          const atPlan = plans.find((p) => p.here.includes(id));
          return [id, atPlan ? ({ kind: "object", objectId: atPlan.objectId } as Location) : ({ kind: "nowhere" } as Location)];
        }),
      );
      const removedSessionsByObject = plans
        .filter((p) => p.sessions.some((s) => ids.includes(s.employeeId)))
        .map((p) => ({ objectId: p.objectId, sessions: p.sessions.filter((s) => ids.includes(s.employeeId)) }));
      pushUndo(undoLabel, () => {
        setEmployeeIds((prev) => [...new Set([...prev, ...ids])]);
        if (removedSelfTransportIds.length) setSelfTransportIds((prev) => [...new Set([...prev, ...removedSelfTransportIds])]);
        for (const [id, loc] of priorLocationById) moveEmployeesTo([id], loc);
        if (removedSessionsByObject.length) {
          setPlans((prev) =>
            prev.map((p) => {
              const restore = removedSessionsByObject.find((r) => r.objectId === p.objectId);
              return restore ? { ...p, sessions: [...p.sessions, ...restore.sessions] } : p;
            }),
          );
        }
      });
      logChange(undoLabel);
    }
    setEmployeeIds((prev) => prev.filter((x) => !ids.includes(x)));
    setSelfTransportIds((prev) => prev.filter((x) => !ids.includes(x)));
    stripSessionsFor(ids);
    moveEmployeesTo(ids, { kind: "nowhere" });
  }

  function toggleEmployee(id: string) {
    if (busyEmployees.has(id)) return;
    if (employeeIds.includes(id)) {
      removeEmployeesFromTrip([id], `${employeeName(id)} видалено з поїздки`);
    } else if (editReturnStep === "REVIEW" && plans.length) {
      // Fixing an already-submitted report: adding someone needs an object
      // (for the works+hours to mean anything), so hold off on actually
      // adding them until that's picked -- see the assign-object sub-flow.
      setRetroAssignEmployeeId(id);
      setRetroAssignObjectId(null);
      setRetroAssignHours("");
      return;
    } else {
      setEmployeeIds((prev) => [...prev, id]);
    }
    haptic("selection");
  }

  // Retroactive object correction: the wrong object was picked, but its
  // works/hours/notes were legitimately recorded -- transplant them onto the
  // right object instead of deleting and re-entering everything from scratch.
  const [retroReplaceObjectId, setRetroReplaceObjectId] = useState<string | null>(null);

  function replaceObjectInPlan(oldObjectId: string, newObj: WorkObject) {
    const oldName = plans.find((p) => p.objectId === oldObjectId)?.objectName ?? oldObjectId;
    setPlans((prev) => prev.map((p) => (p.objectId !== oldObjectId ? p : { ...p, objectId: newObj.id, objectName: newObj.name })));
    logChange(`Обʼєкт замінено: ${oldName} → ${newObj.name}`);
    haptic("success");
    setRetroReplaceObjectId(null);
  }

  // ---------- objects helpers ----------
  function removeObjectFromRoute(objectId: string) {
    const plan = plans.find((p) => p.objectId === objectId);
    if (!plan) return;
    if (plan.works.length || plan.sessions.length || plan.here.length) {
      pushUndo(`Обʼєкт "${plan.objectName}" видалено`, () => {
        // Replace, don't just append -- if the same object was re-added
        // (fresh and blank) via PICK_OBJECTS before this undo was tapped,
        // appending the old snapshot on top would leave two plans sharing
        // one objectId (duplicate React key, and the object's works/sessions
        // would get double-counted at submit).
        setPlans((prev) => [...prev.filter((p) => p.objectId !== plan.objectId), plan]);
        // Reverse the onboard-transfer below too -- otherwise anyone moved
        // into the car when the object was removed would end up duplicated
        // (both "in the car" and back at the restored object's `here`).
        if (plan.here.length) moveEmployeesTo(plan.here, { kind: "object", objectId: plan.objectId });
      });
      logChange(`Обʼєкт видалено: ${plan.objectName}`);
    }
    // Anyone still standing on the removed object goes back into the car --
    // otherwise they'd be stranded in limbo (not onboard, not on any object)
    // and block the end-of-day "everyone accounted for" check forever.
    if (plan.here.length) moveEmployeesTo(plan.here, { kind: "onboard" });
    setPlans((prev) => prev.filter((p) => p.objectId !== objectId));
    haptic("selection");
  }

  // Same "send anyone standing there back to the car first, offer an undo
  // that reverses it too" treatment as removeObjectFromRoute, just for every
  // object in the route at once (the "Очистити вибір" bulk action) instead
  // of one at a time -- a plain `setPlans([])` would strand everyone
  // currently `here` at any object with no way back.
  function clearAllObjects() {
    if (!plans.length) return;
    const removedPlans = plans;
    if (removedPlans.some((p) => p.works.length || p.sessions.length || p.here.length)) {
      pushUndo("Маршрут очищено", () => {
        const removedIds = new Set(removedPlans.map((p) => p.objectId));
        setPlans((prev) => [...prev.filter((p) => !removedIds.has(p.objectId)), ...removedPlans]);
        for (const p of removedPlans) {
          if (p.here.length) moveEmployeesTo(p.here, { kind: "object", objectId: p.objectId });
        }
      });
      logChange("Маршрут очищено");
    }
    for (const p of removedPlans) {
      if (p.here.length) moveEmployeesTo(p.here, { kind: "onboard" });
    }
    setPlans([]);
    haptic("selection");
  }

  function toggleRouteObject(obj: WorkObject) {
    if (plans.some((p) => p.objectId === obj.id)) {
      removeObjectFromRoute(obj.id);
      return;
    }
    setPlans((prev) => [
      ...prev,
      { objectId: obj.id, objectName: obj.name, works: [], assignedEmployeeIds: [], here: [], sessions: [], visited: false, notes: "", photoUrls: [] },
    ]);
    haptic("selection");
  }

  function toggleAllInCity(cityObjects: WorkObject[]) {
    const allSelected = cityObjects.length > 0 && cityObjects.every((o) => plans.some((p) => p.objectId === o.id));
    if (allSelected) {
      cityObjects.forEach((o) => {
        if (plans.some((p) => p.objectId === o.id)) removeObjectFromRoute(o.id);
      });
    } else {
      setPlans((prev) => {
        const existingIds = new Set(prev.map((p) => p.objectId));
        const toAdd = cityObjects
          .filter((o) => !existingIds.has(o.id))
          .map((o) => ({ objectId: o.id, objectName: o.name, works: [], assignedEmployeeIds: [], here: [], sessions: [], visited: false, notes: "", photoUrls: [] }));
        return [...prev, ...toAdd];
      });
    }
    haptic("selection");
  }

  // ---------- plan helpers ----------
  function planFor(objectId: string) {
    return plans.find((p) => p.objectId === objectId)!;
  }

  function updateNotes(objectId: string, notes: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, notes })));
  }

  function removeObjectPhoto(objectId: string, url: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, photoUrls: p.photoUrls.filter((u) => u !== url) })));
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

  function clearWorks(objectId: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: [] })));
    haptic("selection");
  }

  function toggleAllWorksInCategory(objectId: string, categoryWorks: Work[]) {
    const plan = planFor(objectId);
    const allSelected = categoryWorks.length > 0 && categoryWorks.every((w) => plan.works.some((pw) => pw.workId === w.id));
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        if (allSelected) {
          const removeIds = new Set(categoryWorks.map((w) => w.id));
          return { ...p, works: p.works.filter((pw) => !removeIds.has(pw.workId)) };
        }
        const existingIds = new Set(p.works.map((pw) => pw.workId));
        const toAdd = categoryWorks
          .filter((w) => !existingIds.has(w.id))
          .map((w) => ({ workId: w.id, workName: w.name, unit: w.unit || "шт", volume: "" }));
        return { ...p, works: [...p.works, ...toAdd] };
      }),
    );
    haptic("selection");
  }

  // ---------- volume helpers ----------
  function openVolumeDetail(objectId: string, work: PlannedWork) {
    setPlanObjectId(objectId);
    setPlanVolumeWorkId(work.workId);
    setVolumeBuffer(work.volume && work.volume !== "?" ? work.volume : "");
  }

  function saveVolumeDetail(deferred: boolean) {
    if (!planObjectId || !planVolumeWorkId) return;
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== planObjectId
          ? p
          : {
              ...p,
              // Unit comes fixed from the works dictionary (set on toggleWork/
              // toggleAllWorksInCategory when the work is added to the plan) --
              // never editable here.
              works: p.works.map((w) => (w.workId !== planVolumeWorkId ? w : { ...w, volume: deferred ? "?" : volumeBuffer })),
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
    setDrivingAccumulatedMs(0);
    setDrivingSegmentStartedAt(new Date().toISOString());
    setStep("DRIVE");
    haptic("success");
    logChange("Виїхали");
  }

  // Folds the currently-running driving segment into the accumulated total
  // and stops the clock -- called the moment the foreman arrives anywhere
  // (an object, or back at base) so the segment about to start next (if any)
  // begins from zero, not from wherever the "in transit" clock left off.
  function pauseDrivingSegment() {
    setDrivingSegmentStartedAt((segStart) => {
      if (!segStart) return segStart;
      setDrivingAccumulatedMs((ms) => ms + (Date.now() - new Date(segStart).getTime()));
      return null;
    });
  }

  function resumeDrivingSegment() {
    setDrivingSegmentStartedAt((segStart) => segStart ?? new Date().toISOString());
  }

  const nextUnvisited = plans.find((p) => !p.visited) ?? null;

  // Where "↩️ Повернутися до поїздки" on HUB should actually land. Follows
  // the LIVE trip's state first (objects still to visit -> people to pick up
  // -> final odometer): an earlier trip submitted for this date must not
  // hijack resume into REVIEW while a new/edited trip is actively underway
  // (e.g. after "Скинути день", or after "Розпочати нову поїздку" for a
  // second leg the same day). Only THIS trip having its own odoEnd already
  // set (either entered live, or restored by editTrip()) resumes at REVIEW;
  // otherwise it's still mid-route and belongs at RETURN.
  const tripResumeStep: Step = nextUnvisited
    ? "DRIVE"
    : plans.some((p) => p.here.length > 0)
      ? "RETURN_PICKUP"
      : odoEnd
        ? "REVIEW"
        : "RETURN";

  function arriveAt(objectId: string) {
    const target = plans.find((p) => p.objectId === objectId);
    if (!target) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, visited: true })));
    setAtObjectId(objectId);
    setAtObjectReturnStep("DRIVE");
    setStep("AT_OBJECT");
    setShowManualHours(false);
    setManualHoursEmployeeId(null);
    pauseDrivingSegment();
    haptic("medium");
    logChange(`Прибули: ${target.objectName}`);
  }

  // Jumps straight to another object's control panel without touching
  // where "done editing" should return to -- lets the foreman hop between
  // objects (e.g. while stuck at the last one) without ever auto-starting
  // work there.
  function switchAtObject(objectId: string) {
    const target = plans.find((p) => p.objectId === objectId);
    if (!target) return;
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, visited: true })));
    setAtObjectId(objectId);
    // Never carry an open manual-hours editor across to another object.
    setShowManualHours(false);
    setManualHoursEmployeeId(null);
    haptic("selection");
  }

  // Opens an object's control panel while the car is STILL EN ROUTE, so the
  // foreman can register people who reached it first under their own
  // transport and start their work early. Deliberately does NOT pause the
  // driving segment (the car keeps moving toward it) and does NOT mark the
  // object visited (the car hasn't arrived) -- so the object still shows up
  // as a stop to actually drive to, where the crew still onboard gets
  // dropped off later. The drop-picker opens straight on the self-transport
  // half; the "who to leave here from the car" half is hidden while the car
  // isn't physically here (see carPresent on the AT_OBJECT screen).
  function openEarlySelfTransport(objectId: string) {
    const target = plans.find((p) => p.objectId === objectId);
    if (!target) return;
    setAtObjectId(objectId);
    setAtObjectReturnStep("DRIVE");
    setDropSelected([]);
    setAddArrivedSelected([]);
    setShowDropPicker(true);
    setStep("AT_OBJECT");
    haptic("selection");
  }

  // ---------- roadside pickup / drop-off during the drive ----------
  // Not tied to any object -- just adjusts who's physically in the car
  // right now (e.g. picking someone up along the way, or sending someone
  // home early). Dropping someone at a specific object is a separate
  // action, done from that object's own screen.
  function roadsidePickup(employeeId: string) {
    if (!employeeIds.includes(employeeId)) {
      setEmployeeIds((prev) => [...prev, employeeId]);
    }
    moveEmployeesTo([employeeId], { kind: "onboard" });
    haptic("light");
    logChange(`Підібрано по дорозі: ${employeeName(employeeId)}`);
  }

  function roadsideDropoff(employeeId: string) {
    moveEmployeesTo([employeeId], { kind: "nowhere" });
    haptic("light");
    logChange(`Висаджено по дорозі: ${employeeName(employeeId)}`);
  }

  // Of the given people at an object, who was NEVER clocked in to work there
  // (no session at all). Since pay is by hours, picking them up without ever
  // starting their work means they earn nothing for this object and its
  // money can't be split -- so callers warn before doing it.
  function neverStartedHere(objectId: string, ids: string[]) {
    const plan = planFor(objectId);
    const startedIds = new Set(plan.sessions.map((s) => s.employeeId));
    return ids.filter((id) => !startedIds.has(id));
  }

  // Returns true if it's OK to proceed. Warns (Скасувати / Так) when some of
  // the people being picked up never had work started here.
  async function confirmUnstartedPickup(objectId: string, ids: string[]): Promise<boolean> {
    const unstarted = neverStartedHere(objectId, ids);
    if (!unstarted.length) return true;
    const objectName = planFor(objectId).objectName;
    return confirmDialog(
      `На об'єкті «${objectName}» не розпочато роботи: ${unstarted.map(employeeName).join(", ")}.\n\n` +
        `Якщо забрати без нарахування — за цей об'єкт вони нічого не отримають. Ви бажаєте продовжити?`,
    );
  }

  // Actual pickup, no prompting -- callers gate it with confirmUnstartedPickup.
  function doPickUpHere(objectId: string) {
    const plan = planFor(objectId);
    if (!plan.here.length) return;
    const ids = plan.here;
    const now = new Date().toISOString();
    moveEmployeesTo(ids, { kind: "onboard" });
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId ? p : { ...p, sessions: p.sessions.map((s) => (ids.includes(s.employeeId) && !s.endedAt ? { ...s, endedAt: now } : s)) },
      ),
    );
    haptic("light");
    logChange(`Забрано з ${plan.objectName}`);
  }

  async function pickUpHere(objectId: string) {
    const plan = planFor(objectId);
    if (!plan.here.length) return;
    if (!(await confirmUnstartedPickup(objectId, plan.here))) return;
    doPickUpHere(objectId);
  }

  // Picks up (and clocks out, if still working) one specific person without
  // disturbing anyone else still at the object.
  async function pickUpOne(objectId: string, employeeId: string) {
    const plan = planFor(objectId);
    if (!plan.here.includes(employeeId)) return;
    if (!(await confirmUnstartedPickup(objectId, [employeeId]))) return;
    const now = new Date().toISOString();
    moveEmployeesTo([employeeId], { kind: "onboard" });
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId
          ? p
          : { ...p, sessions: p.sessions.map((s) => (s.employeeId === employeeId && !s.endedAt ? { ...s, endedAt: now } : s)) },
      ),
    );
    haptic("light");
    logChange(`Забрано ${employeeName(employeeId)} з ${plan.objectName}`);
  }

  function openVolumesForObject(objectId: string, returnTo: Step) {
    setPlanObjectId(objectId);
    setVolumesReturnStep(returnTo);
    setStep("PLAN_VOLUMES");
  }

  // Guided end-of-day pickup: picks everyone up from one object (which also
  // clocks out anyone still working there), then drops into volumes +
  // coefficients for that object so the foreman can fill them in on the way
  // to the next pickup, with an explicit "later" escape hatch either way.
  // Pressing this means the car has actually arrived at that object, so the
  // driving segment pauses same as arriveAt() does on the way out -- "▶️
  // Продовжити рух" on the RETURN_PICKUP screen resumes it once the foreman
  // heads to the next pickup (or straight to base).
  async function returnPickupObject(objectId: string) {
    const plan = planFor(objectId);
    if (plan.here.length && !(await confirmUnstartedPickup(objectId, plan.here))) return;
    pauseDrivingSegment();
    doPickUpHere(objectId);
    if (plan.works.length) {
      openVolumesForObject(objectId, "RETURN_PICKUP");
    }
  }

  // ---------- at object ----------
  function currentAtPlan() {
    return plans.find((p) => p.objectId === atObjectId) ?? null;
  }

  // Clocks in everyone currently dropped at the object who isn't already
  // clocked in -- can be pressed again later to pick up newcomers without
  // disturbing sessions already in progress.
  function startShift() {
    if (!atObjectId) return;
    const plan = currentAtPlan();
    if (!plan || !plan.here.length) return;
    const nowIso = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== atObjectId) return p;
        const openIds = new Set(p.sessions.filter((s) => !s.endedAt).map((s) => s.employeeId));
        const newSessions = p.here.filter((id) => !openIds.has(id)).map((employeeId) => ({ employeeId, startedAt: nowIso }));
        // "Почати роботи" is the bulk shortcut -- it should also start every
        // work item's own timer, not just people's, since the per-work
        // Старт/Стоп buttons only cover starting one at a time otherwise.
        const works = p.works.map((w) => (w.workStartedAt ? w : { ...w, workStartedAt: nowIso }));
        return { ...p, sessions: [...p.sessions, ...newSessions], works };
      }),
    );
    haptic("light");
    logChange(`Почато роботи на ${plan.objectName} (${plan.here.length} людей)`);
  }

  // Stops every still-open session AND every still-running work timer at the
  // object at once -- the bulk "Завершити все" shortcut, on top of the
  // per-person/per-work individual Стоп buttons below.
  function finishShift() {
    if (!atObjectId) return;
    const plan = currentAtPlan();
    if (!plan || (!plan.sessions.some((s) => !s.endedAt) && !plan.works.some((w) => w.workStartedAt))) return;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== atObjectId
          ? p
          : {
              ...p,
              sessions: p.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: nowIso })),
              works: p.works.map((w) =>
                w.workStartedAt
                  ? { ...w, workStartedAt: null, workAccumulatedMs: (w.workAccumulatedMs ?? 0) + (nowMs - new Date(w.workStartedAt).getTime()) }
                  : w,
              ),
            },
      ),
    );
    haptic("success");
    logChange(`Завершено роботи на ${plan.objectName}`);
    openVolumesForObject(atObjectId, "AT_OBJECT");
  }

  // Per-work timer, independent of every other work at the same object --
  // lets the foreman stop e.g. "покіс" while "полив" keeps running.
  function startWorkTimer(objectId: string, workId: string) {
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId
          ? p
          : { ...p, works: p.works.map((w) => (w.workId !== workId || w.workStartedAt ? w : { ...w, workStartedAt: new Date().toISOString() })) },
      ),
    );
    haptic("light");
  }

  function stopWorkTimer(objectId: string, workId: string) {
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId
          ? p
          : {
              ...p,
              works: p.works.map((w) => {
                if (w.workId !== workId || !w.workStartedAt) return w;
                const elapsed = Date.now() - new Date(w.workStartedAt).getTime();
                return { ...w, workStartedAt: null, workAccumulatedMs: (w.workAccumulatedMs ?? 0) + elapsed };
              }),
            },
      ),
    );
    haptic("light");
  }

  // Per-person timer, independent of "Забрати" (which also physically moves
  // the person off the object) -- lets the foreman pause one person's clock
  // (e.g. a break) while they stay `here`, then resume it later.
  function startPersonTimer(objectId: string, employeeId: string) {
    const startedAt = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        if (p.sessions.some((s) => s.employeeId === employeeId && !s.endedAt)) return p;
        return { ...p, sessions: [...p.sessions, { employeeId, startedAt }] };
      }),
    );
    haptic("light");
  }

  function stopPersonTimer(objectId: string, employeeId: string) {
    const now = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId
          ? p
          : { ...p, sessions: p.sessions.map((s) => (s.employeeId === employeeId && !s.endedAt ? { ...s, endedAt: now } : s)) },
      ),
    );
    haptic("light");
  }

  // Total worked hours a person has recorded at an object (sum of every
  // session, counting an open one up to now) -- what the payroll splits pay
  // by. Shown next to each person on the manual-hours screen.
  function hoursAtObject(plan: ObjPlan, employeeId: string) {
    const now = Date.now();
    const ms = plan.sessions
      .filter((s) => s.employeeId === employeeId)
      .reduce((a, s) => a + Math.max(0, (s.endedAt ? new Date(s.endedAt).getTime() : now) - new Date(s.startedAt).getTime()), 0);
    return Math.round((ms / 3_600_000) * 100) / 100;
  }

  // Manual override: replace a person's sessions at an object with ONE closed
  // session of exactly `hours` long. The safety net for "forgot to press
  // Почати роботи" (or the timer ran wrong) -- works even for someone no
  // longer physically here, since payroll only cares about the recorded time,
  // not the current location. hours=0 removes their time here entirely.
  function setManualHours(objectId: string, employeeId: string, hours: number) {
    const end = new Date();
    const start = new Date(end.getTime() - Math.max(0, hours) * 3_600_000);
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const others = p.sessions.filter((s) => s.employeeId !== employeeId);
        const manual = hours > 0 ? [{ employeeId, startedAt: start.toISOString(), endedAt: end.toISOString() }] : [];
        return { ...p, sessions: [...others, ...manual] };
      }),
    );
    haptic("success");
    logChange(`Години вручну: ${employeeName(employeeId)} — ${hours} год на ${planFor(objectId).objectName}`);
  }

  // Handles both halves of "who's here now": people stepping out of the car
  // (dropSelected, from onboard) and people who showed up under their own
  // transport (addArrivedSelected, never on the trip roster until now) --
  // one combined action/picker since both answer the same real-world
  // question at the same moment. The self-transport half is reserved
  // server-side with the merged list directly (not via reserveIfPossible/its
  // employeeIds closure, which would still see pre-add state) so another
  // foreman can't also claim them, same as picking someone up front; if that
  // reservation fails, neither half applies, so a rejected add doesn't leave
  // the drop-off half silently mismatched with the server.
  async function confirmDropAndArrived() {
    if (!atObjectId || (!dropSelected.length && !addArrivedSelected.length)) return;
    const objectName = currentAtPlan()?.objectName ?? "";

    if (addArrivedSelected.length) {
      const mergedEmployeeIds = [...new Set([...employeeIds, ...addArrivedSelected])];
      try {
        await api.post("/api/road-timesheet/reserve", { date, carId, employeeIds: mergedEmployeeIds });
      } catch (e) {
        setError((e as Error).message);
        haptic("error");
        return;
      }
      setEmployeeIds(mergedEmployeeIds);
      setSelfTransportIds((prev) => [...new Set([...prev, ...addArrivedSelected])]);
    }

    const allHere = [...dropSelected, ...addArrivedSelected];
    if (allHere.length) moveEmployeesTo(allHere, { kind: "object", objectId: atObjectId });

    const parts: string[] = [];
    if (dropSelected.length) parts.push(`висаджено ${dropSelected.length}`);
    if (addArrivedSelected.length) parts.push(`приїхали самі (без доплати за дорогу): ${addArrivedSelected.map(employeeName).join(", ")}`);
    logChange(`${objectName}: ${parts.join("; ")}`);
    haptic("success");

    setDropSelected([]);
    setAddArrivedSelected([]);
    setShowDropPicker(false);
  }

  function confirmMove() {
    if (!atObjectId || !moveTargetId || !moveSelected.length) return;
    const fromName = currentAtPlan()?.objectName ?? "";
    const toName = plans.find((p) => p.objectId === moveTargetId)?.objectName ?? "";
    const count = moveSelected.length;
    const now = new Date().toISOString();
    moveEmployeesTo(moveSelected, { kind: "object", objectId: moveTargetId });
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== atObjectId
          ? p
          : { ...p, sessions: p.sessions.map((s) => (moveSelected.includes(s.employeeId) && !s.endedAt ? { ...s, endedAt: now } : s)) },
      ),
    );
    haptic("light");
    logChange(`Перенесено ${count} з ${fromName} на ${toName}`);
    setMoveSelected([]);
    setMoveTargetId(null);
    setShowMovePicker(false);
  }

  // "Everyone accounted for" = nobody is still standing on an object. Do NOT
  // compare onboard vs employeeIds counts: someone dropped off along the way
  // home (roadsideDropoff) stays in the trip roster for the road allowance
  // but is legitimately not in the car, and must not block the day report.
  const allBack = plans.every((p) => p.here.length === 0);

  // ---------- payload / save ----------
  function buildObjectsPayload() {
    const coefList = employeeIds.map((id) => ({ employeeId: id, disciplineCoef: coefFor(id).disciplineCoef, productivityCoef: coefFor(id).productivityCoef }));
    return plans.map((p) => ({
      objectId: p.objectId,
      objectName: p.objectName,
      works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: p.sessions.map((s) => s.employeeId) })),
      sessions: p.sessions.map((s) => ({
        employeeId: s.employeeId,
        employeeName: employeeName(s.employeeId),
        droppedAt: s.startedAt,
        pickedUpAt: s.endedAt,
      })),
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
        selfTransportIds,
        objects: buildObjectsPayload(),
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    // Catch-all safety net: an object with real volume but nobody ever
    // clocked in earns money that can't be split (pay is by hours), so 90%
    // of it would silently vanish. Warn before sending so the foreman can go
    // back and start work first.
    const noWorkObjects = plans.filter(
      (p) => p.sessions.length === 0 && p.works.some((w) => w.volume && w.volume !== "?" && Number(w.volume) > 0),
    );
    if (noWorkObjects.length) {
      const many = noWorkObjects.length > 1;
      const ok = await confirmDialog(
        `На об'єкт${many ? "ах" : "і"} ${noWorkObjects.map((p) => `«${p.objectName}»`).join(", ")} ` +
          `не розпочато роботи нікому — за ${many ? "них" : "нього"} гроші не розподіляться між людьми.\n\n` +
          `Ви бажаєте продовжити?`,
      );
      if (!ok) return;
    }

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
      const res = await api.post<SaveResponse>("/api/road-timesheet", {
        date,
        carId,
        odoStart: Number(odoStart),
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
        employeeIds,
        selfTransportIds,
        objects: buildObjectsPayload(),
        idempotencyKey,
        tripSeq: editingTripSeq ?? undefined,
      });
      setDayCombined(res.combined);
      setEditingTripSeq(res.tripSeq);
      const savedTrip: SubmittedTrip = {
        tripSeq: res.tripSeq,
        eventId: res.eventId,
        status: "АКТИВНА",
        carId,
        employeeIds,
        selfTransportIds,
        odoStart: Number(odoStart),
        odoStartPhoto,
        odoEnd: Number(odoEnd),
        odoEndPhoto,
        objects: buildObjectsPayload(),
        km: res.km,
        tripClass: res.tripClass,
      };
      setSubmittedTrips((prev) => [...prev.filter((t) => t.tripSeq !== res.tripSeq), savedTrip].sort((a, b) => a.tripSeq - b.tripSeq));
      setStep("DONE");
      clearDraft();
      setDayStatus((prev) => (prev ? { ...prev, hasSubmission: true, eventId: res.eventId } : prev));
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
    READY: "HUB",
    ARRIVE_PICK: "DRIVE",
    RETURN_PICKUP: "DRIVE",
    RETURN: "RETURN_PICKUP",
    // DONE has no entry here on purpose: it's now the day's landing screen
    // (shown on every re-entry once something's submitted, not just right
    // after a fresh save), so back should exit to the main menu like HUB
    // does -- not detour through REVIEW, which is only reachable via each
    // trip card's own "✏️ Редагувати" button.
  };
  // PLAN_VOLUMES can be reached from more than one place (finishing a shift
  // at the object, or catching up on unfilled volumes from RETURN), so its
  // back target is wherever it was actually opened from, not a fixed step.
  const goBack = () => {
    if (step === "PLAN_VOLUMES") {
      // Mid-entry for one specific work's number -- back should return to
      // that object's works list, not skip past it to wherever the whole
      // volumes screen was opened from.
      if (planVolumeWorkId) {
        setPlanVolumeWorkId(null);
        return;
      }
      setStep(volumesReturnStep);
      return;
    }
    if (step === "PICK_PEOPLE" && retroAssignEmployeeId) {
      cancelRetroAssign();
      return;
    }
    if ((step === "PICK_CAR" || step === "PICK_PEOPLE") && editReturnStep !== "HUB") {
      setStep(editReturnStep);
      setEditReturnStep("HUB");
      return;
    }
    if (step === "PLAN_WORKS") {
      setStep(worksReturnStep);
      return;
    }
    if (step === "REVIEW") {
      // Reached either the normal way (finishing RETURN) or as the "fix
      // data" entry point from an already-submitted report -- back should
      // return to whichever of those actually opened it.
      setStep(reviewReturnStep);
      setReviewReturnStep("RETURN");
      return;
    }
    if (step === "AT_OBJECT") {
      // Close whichever sub-picker is open instead of leaving the object
      // entirely -- otherwise back mid-pick silently discards the pending
      // selection and dumps you back a whole screen further than expected.
      if (showDropPicker) {
        setDropSelected([]);
        setAddArrivedSelected([]);
        setShowDropPicker(false);
        return;
      }
      if (showMovePicker) {
        setMoveSelected([]);
        setMoveTargetId(null);
        setShowMovePicker(false);
        return;
      }
      if (showManualHours) {
        // Step out of the per-person keypad first, then out of the list.
        if (manualHoursEmployeeId) setManualHoursEmployeeId(null);
        else setShowManualHours(false);
        return;
      }
      // Same resume rule as the in-screen "✅ Готово" button below -- leaving
      // via the hardware/Telegram back button must not skip it, or the
      // driving segment stays paused with no way to resume it once back on
      // DRIVE (that screen has no manual "resume" control of its own).
      if (atObjectReturnStep === "DRIVE") resumeDrivingSegment();
      setStep(atObjectReturnStep);
      return;
    }
    if (step === "DRIVE") {
      // Same idea as AT_OBJECT above: a picker open on top of DRIVE should
      // just close, not exit the whole road timesheet.
      if (showRoadsideActions) {
        setShowRoadsideActions(false);
        return;
      }
    }
    if (step === "RETURN_PICKUP") {
      // Mirrors "▶️ Продовжити рух" on this screen -- leaving via the
      // hardware/Telegram back button after a pickup stop paused the segment
      // must resume it too, same reasoning as the AT_OBJECT case above.
      resumeDrivingSegment();
    }
    if (backTargets[step]) {
      setStep(backTargets[step]!);
      return;
    }
    onBack();
  };
  useTelegramBackButton(goBack);

  if (step === "DONE" && submittedTrips.length) {
    const pendingTrips = submittedTrips.filter((t) => t.status !== "ЗАТВЕРДЖЕНО");
    const approvedTrips = submittedTrips.filter((t) => t.status === "ЗАТВЕРДЖЕНО");
    const dayFullyApproved = approvedTrips.length > 0 && pendingTrips.length === 0;
    const isMulti = submittedTrips.length > 1;
    return (
      <div>
        <BackRow onBack={goBack} />
        <div className="header">
          <h1>{isMulti ? `✅ Поїздки за ${date}` : pendingTrips.length ? "✅ Відправлено на підтвердження" : "✅ День затверджено"}</h1>
          <div className="hint">
            {pendingTrips.length
              ? "Можна й далі редагувати та надсилати повторно, поки адміністратор не затвердить."
              : "Можна розпочати ще одну поїздку за цей день."}
          </div>
        </div>

        {pendingTrips.map((trip) => renderTripCard(trip, true))}

        {editingTripSeq === null && (!!carId || employeeIds.length > 0 || plans.length > 0) && (
          <div className="list" style={{ marginTop: 8 }}>
            <button className="cell" onClick={() => setStep(inProgressResumeStep ?? "HUB")}>
              <span className="cell-title">🚧 {cars.find((c) => c.id === carId)?.name ?? "Нова поїздка"}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="badge warn">в процесі</span>
                <span className="cell-sub">▶️ Продовжити</span>
              </span>
            </button>
          </div>
        )}

        <div style={{ padding: "8px 16px" }}>
          <button className="bulk-select-btn" onClick={startNewTrip}>
            ➕ Розпочати нову поїздку
          </button>
        </div>

        {renderFundBreakdown(!dayFullyApproved)}
        <div className="hint" style={{ padding: "0 16px 8px" }}>
          {dayFullyApproved
            ? "Якщо потрібно щось виправити — надішліть запит адміністратору на редагування."
            : "🔒 Нарахування стануть видимі після затвердження адміністратором."}
        </div>

        {approvedTrips.length > 0 && (
          <>
            <div className="section-title">Затверджені поїздки</div>
            {approvedTrips.map((trip) => renderTripCard(trip, false))}
            {dayStatus?.editRequested ? (
              <div className="empty-state">🔓 Запит на редагування вже надіслано, очікуйте.</div>
            ) : (
              <div style={{ padding: "8px 16px" }}>
                <button className="chip" onClick={requestEdit}>
                  🔓 Запросити редагування затверджених
                </button>
              </div>
            )}
          </>
        )}

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

      {(carId || employeeIds.length > 0 || plans.length > 0) && (
        <div style={{ padding: "0 16px 8px", textAlign: "right" }}>
          <button className="back-btn danger-btn" onClick={resetDay}>🗑 Скинути день</button>
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
          <div className="section-title row">
            <span>Поточна поїздка · {date}</span>
            {!tripStartedAt && <span className="hint">{readinessScore}/4 готово</span>}
          </div>
          {!tripStartedAt && (
            <div className="progress-track">
              <div className={`progress-fill ${readinessScore === 4 ? "done" : ""}`} style={{ width: `${(readinessScore / 4) * 100}%` }} />
            </div>
          )}

          {restoredBanner && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              🔄 Відновлено чернетку дня, яку не встигли відправити.
            </div>
          )}

          {showCopySuggestion && lastTrip && (
            <div className="suggestion-card">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="setup-icon accent-blue" style={{ width: 34, height: 34, fontSize: 16 }}>
                  🔁
                </span>
                <div className="cell-title">Повторити маршрут з {lastTrip.date}?</div>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {cars.find((c) => c.id === lastTrip.carId)?.name ?? lastTrip.carId} · {lastTrip.employeeIds.length} людей · {lastTrip.objects.length} обʼєктів
              </div>
              <div style={{ marginTop: 6 }}>
                <button className="chip" onClick={() => setLastTripExpanded((v) => !v)}>
                  {lastTripExpanded ? "▾ Сховати деталі" : "▸ Показати деталі"}
                </button>
              </div>
              {lastTripExpanded && (
                <div style={{ marginTop: 10 }}>
                  <div className="hint" style={{ fontWeight: 600 }}>👥 Люди</div>
                  <div className="hint" style={{ marginBottom: 8 }}>{lastTrip.employeeIds.map(employeeName).join(", ") || "—"}</div>
                  <div className="hint" style={{ fontWeight: 600 }}>📍 Обʼєкти та роботи</div>
                  {lastTrip.objects.map((o) => (
                    <div key={o.objectId} className="hint" style={{ marginBottom: 4 }}>
                      <b>{o.objectName}</b>: {o.works.map((w) => w.workName).join(", ") || "без робіт"}
                    </div>
                  ))}
                </div>
              )}
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
            <button className="cell" onClick={() => { setEditReturnStep("HUB"); setStep("PICK_CAR"); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-blue">🚙</span>
                <span className="cell-title">Авто{carId ? `: ${cars.find((c) => c.id === carId)?.name ?? ""}` : ""}</span>
              </span>
              {carId && odoStart ? <span className="badge ok">{odoStart} км</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => { setEditReturnStep("HUB"); setStep("PICK_PEOPLE"); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-purple">👥</span>
                <span className="cell-title">Люди</span>
              </span>
              {employeeIds.length ? <span className="badge ok">{employeeIds.length} обрано</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => setStep("PICK_OBJECTS")}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-orange">📍</span>
                <span className="cell-title">Обʼєкти</span>
              </span>
              {plans.length ? <span className="badge ok">{plans.length} обрано</span> : <span className="badge warn">не обрано</span>}
            </button>
            <button className="cell" onClick={() => plans.length && setStep("PLAN")} disabled={!plans.length}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-teal">🧱</span>
                <span className="cell-title">Роботи</span>
              </span>
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
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {employeeName(id)}
                      </span>
                      <span className="cell-sub">{label}</span>
                    </div>
                  );
                })}
              </div>

              <div className="section-title">Маршрут</div>
              <div className="list">
                {plans.map((p) => {
                  const shiftActive = p.sessions.some((s) => !s.endedAt);
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

          {tripStartedAt ? (
            <MainButton text="↩️ Повернутися до поїздки" onClick={() => setStep(tripResumeStep)} />
          ) : (
            <MainButton text="Далі → Перевірка перед виїздом" onClick={() => setStep("READY")} disabled={!readyToDepart} />
          )}
        </>
      )}

      {step === "PICK_CAR" && (
        <>
          <div className="step-badge">🚙 АВТО</div>
          <div className="section-title">Вибір авто</div>
          {carId && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              Обрано: {cars.find((c) => c.id === carId)?.name ?? carId}
            </div>
          )}
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
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="setup-icon accent-blue">🚙</span>
                    <span className="cell-title">
                      {c.name} {c.plate ? <span className="hint">{c.plate}</span> : null}
                    </span>
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
          {lastOdometer[carId] !== undefined && (
            <div
              className="hint"
              style={{ padding: "0 16px", textDecoration: "underline", cursor: "pointer" }}
              onClick={() => setOdoStart(String(lastOdometer[carId]))}
            >
              Попереднє значення: {lastOdometer[carId]} км (натисніть, щоб підставити)
            </div>
          )}
          <div className="big-number">{odoStart || "0"} км</div>
          {odoStart && lastOdometer[carId] !== undefined && Number(odoStart) >= lastOdometer[carId] && (
            <div className="hint" style={{ textAlign: "center" }}>
              +{Math.round((Number(odoStart) - lastOdometer[carId]) * 10) / 10} км з попереднього виїзду
            </div>
          )}
          {odoStart && lastOdometer[carId] !== undefined && Number(odoStart) < lastOdometer[carId] && (
            <div className="hint" style={{ textAlign: "center", color: "var(--tg-destructive-text, #e53935)" }}>
              ⚠️ Не може бути менше за попередній приїзд ({lastOdometer[carId]} км)
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
              if (!(await reserveIfPossible())) return;
              logChange(`Авто: ${cars.find((c) => c.id === carId)?.name ?? carId}, одометр ${odoStart} км`);
              setStep(editReturnStep);
              setEditReturnStep("HUB");
            }}
            disabled={!odoStart || uploadingPhoto || (lastOdometer[carId] !== undefined && Number(odoStart) < lastOdometer[carId])}
          />
        </>
      )}

      {step === "PICK_PEOPLE" && (
        <>
          <div className="step-badge">👥 ЛЮДИ</div>
          <div className="section-title row">
            <span>Люди в поїздці — Обрано {employeeIds.length}</span>
            {employeeIds.length > 0 && (
              <button className="chip" onClick={() => removeEmployeesFromTrip(employeeIds, "Вибір людей очищено")}>
                🗑 Очистити вибір
              </button>
            )}
          </div>
          {employeeIds.length > 0 && (
            <div style={{ padding: "0 16px 8px" }}>
              <button className="back-btn" onClick={() => setSelectedPeopleExpanded((v) => !v)}>
                {selectedPeopleExpanded ? "▾ Сховати обраних" : "▸ Показати обраних"}
              </button>
              {selectedPeopleExpanded && <div className="hint">{employeeIds.map(employeeName).join(", ")}</div>}
            </div>
          )}
          {retroAssignEmployeeId ? (
            <>
              <div className="section-title">На якому обʼєкті була {employeeName(retroAssignEmployeeId)}?</div>
              <div className="list">
                {plans.map((p) => (
                  <button
                    key={p.objectId}
                    className={`cell ${retroAssignObjectId === p.objectId ? "selected" : ""}`}
                    onClick={() => setRetroAssignObjectId(p.objectId)}
                  >
                    <span className="cell-title">📍 {p.objectName}</span>
                    <span className="hint">{p.works.map((w) => w.workName).join(", ") || "без робіт"}</span>
                  </button>
                ))}
              </div>
              {retroAssignObjectId && (
                <div className="field">
                  <label>Скільки годин відпрацювала (роботи підтягнуться з обʼєкта автоматично)</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={retroAssignHours}
                    onChange={(e) => setRetroAssignHours(e.target.value)}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                <button className="chip" onClick={cancelRetroAssign}>
                  Скасувати
                </button>
                <button
                  className="chip selected"
                  onClick={confirmRetroAssign}
                  disabled={!retroAssignObjectId || !(Number.isFinite(Number(retroAssignHours)) && Number(retroAssignHours) > 0)}
                >
                  Додати
                </button>
              </div>
            </>
          ) : (
            <>
              <input className="search-box" placeholder="Пошук людини…" value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} />
              <div className="list">
                {groupByBrigade(employees.filter((e) => e.name.toLowerCase().includes(peopleSearch.toLowerCase())), employees).map((g) => {
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
                            className={`bulk-select-btn ${allSelected ? "active" : ""}`}
                            onClick={() => {
                              if (allSelected) {
                                removeEmployeesFromTrip(
                                  selectable.map((e) => e.id),
                                  `Бригаду "${g.title}" знято з поїздки`,
                                );
                              } else if (!(editReturnStep === "REVIEW" && plans.length)) {
                                setEmployeeIds((prev) => [...new Set([...prev, ...selectable.map((e) => e.id)])]);
                                haptic("selection");
                              }
                            }}
                            // Bulk-adding is disabled while fixing an already-submitted
                            // report -- each new person there needs their own object+hours
                            // picked (see the retro-assign flow on the per-person toggle),
                            // which doesn't make sense to do for a whole brigade at once.
                            disabled={!selectable.length || (!allSelected && editReturnStep === "REVIEW" && plans.length > 0)}
                          >
                            {allSelected ? "✕ Зняти всю бригаду" : "✓ Обрати всю бригаду"}
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
                                <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                  <span className={`avatar-circle ${roleAccent(employeeRole(emp))}`}>{initials(emp.name)}</span>
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
                  if (!(await reserveIfPossible())) return;
                  logChange(`Люди оновлено: ${employeeIds.length}`);
                  setStep(editReturnStep);
                  setEditReturnStep("HUB");
                }}
                disabled={!employeeIds.length}
              />
            </>
          )}
        </>
      )}

      {step === "PICK_OBJECTS" && (
        <>
          <div className="step-badge">📍 ОБʼЄКТИ</div>
          <div className="section-title row">
            <span>Обʼєкти маршруту — Обрано {plans.length}</span>
            {plans.length > 0 && (
              <button className="chip" onClick={clearAllObjects}>
                🗑 Очистити вибір
              </button>
            )}
          </div>
          {plans.length > 0 && (
            <div style={{ padding: "0 16px 8px" }}>
              <button className="back-btn" onClick={() => setSelectedObjectsExpanded((v) => !v)}>
                {selectedObjectsExpanded ? "▾ Сховати обрані" : "▸ Показати обрані"}
              </button>
              {selectedObjectsExpanded && <div className="hint">{plans.map((p) => p.objectName).join(", ")}</div>}
            </div>
          )}
          <input className="search-box" placeholder="Пошук обʼєкта…" value={objectSearch} onChange={(e) => setObjectSearch(e.target.value)} />
          <div className="list">
            {groupByCity(objects.filter((o) => `${o.name} ${o.address ?? ""}`.toLowerCase().includes(objectSearch.toLowerCase()))).map((g) => {
              const expanded = expandedCityId === g.id || !!objectSearch;
              const selectedCount = g.members.filter((o) => plans.some((p) => p.objectId === o.id)).length;
              const allSelected = g.members.length > 0 && selectedCount === g.members.length;
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
                      <button className={`bulk-select-btn ${allSelected ? "active" : ""}`} onClick={() => toggleAllInCity(g.members)}>
                        {allSelected ? "✕ Зняти всі в місті" : "✓ Обрати всі в місті"}
                      </button>
                      {g.members.map((obj) => {
                        const checked = plans.some((p) => p.objectId === obj.id);
                        return (
                          <button key={obj.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleRouteObject(obj)}>
                            <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                              <span className="setup-icon accent-orange" style={{ width: 28, height: 28, fontSize: 13, borderRadius: 9 }}>
                                📍
                              </span>
                              {obj.name}
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
                      setWorksReturnStep("PLAN");
                      setStep("PLAN_WORKS");
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span className="setup-icon accent-teal">📍</span>
                      <span className="cell-title">{plan.objectName}</span>
                    </span>
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
          <div className="section-title row">
            <span>Вибір робіт — Обрано {planFor(planObjectId).works.length}</span>
            {planFor(planObjectId).works.length > 0 && (
              <button className="chip" onClick={() => clearWorks(planObjectId)}>
                🗑 Очистити вибір
              </button>
            )}
          </div>
          {planFor(planObjectId).works.length > 0 && (
            <div style={{ padding: "0 16px 8px" }}>
              <button className="back-btn" onClick={() => setSelectedWorksExpanded((v) => !v)}>
                {selectedWorksExpanded ? "▾ Сховати обрані" : "▸ Показати обрані"}
              </button>
              {selectedWorksExpanded && <div className="hint">{planFor(planObjectId).works.map((w) => w.workName).join(", ")}</div>}
            </div>
          )}
          <div className="hint" style={{ padding: "0 16px 8px" }}>Обери роботи. Обсяги вкажете пізніше, під час виконання на обʼєкті</div>
          <input className="search-box" placeholder="Пошук роботи…" value={planWorksSearch} onChange={(e) => setPlanWorksSearch(e.target.value)} />
          <div className="list">
            {groupByWorkCategory(works.filter((w) => w.name.toLowerCase().includes(planWorksSearch.toLowerCase()))).map((g) => {
              const expanded = expandedWorkCategoryId === g.id || !!planWorksSearch;
              const selectedCount = g.members.filter((w) => planFor(planObjectId).works.some((pw) => pw.workId === w.id)).length;
              const allSelected = g.members.length > 0 && selectedCount === g.members.length;
              return (
                <div key={g.id}>
                  <button className="cell" onClick={() => setExpandedWorkCategoryId(expandedWorkCategoryId === g.id ? null : g.id)}>
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
                        className={`bulk-select-btn ${allSelected ? "active" : ""}`}
                        onClick={() => toggleAllWorksInCategory(planObjectId, g.members)}
                      >
                        {allSelected ? "✕ Зняти всі в категорії" : "✓ Обрати всі в категорії"}
                      </button>
                      {g.members.map((w) => {
                        const checked = planFor(planObjectId).works.some((pw) => pw.workId === w.id);
                        return (
                          <button key={w.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleWork(planObjectId, w)}>
                            <span className="cell-title" style={{ display: "flex", alignItems: "center" }}>
                              <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                              {w.name}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="hint" style={{ padding: "0 16px" }}>Робіт у пакеті: {planFor(planObjectId).works.length}</div>

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
            {planFor(planObjectId).photoUrls.length > 0 && (
              <div className="chip-row" style={{ marginTop: 8 }}>
                {planFor(planObjectId).photoUrls.map((url, i) => (
                  <span key={url} className="chip">
                    📷 Фото {i + 1}
                    <button
                      style={{ marginLeft: 6, border: "none", background: "none", cursor: "pointer" }}
                      onClick={() => removeObjectPhoto(planObjectId, url)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <MainButton
            text="Готово"
            onClick={() => {
              logChange(`Роботи на "${planFor(planObjectId).objectName}": ${planFor(planObjectId).works.length}`);
              setStep(worksReturnStep);
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
                <div className="section-title row">
                  <span>Обсяги</span>
                  <button className="chip" onClick={() => setBulkVolumeInput(bulkVolumeInput === null ? "" : null)}>
                    Масовий ввід
                  </button>
                </div>
                {bulkVolumeInput !== null && (
                  <div className="field" style={{ padding: "0 16px 8px" }}>
                    <label className="hint">Значення для незаповнених обсягів</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={bulkVolumeInput}
                        onChange={(e) => setBulkVolumeInput(e.target.value)}
                        autoFocus
                      />
                      <button
                        className="chip selected"
                        onClick={() => {
                          applyBulkVolume(planObjectId, bulkVolumeInput || "");
                          setBulkVolumeInput(null);
                        }}
                      >
                        Застосувати
                      </button>
                    </div>
                  </div>
                )}
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

                {volumesReturnStep === "RETURN_PICKUP" &&
                  (() => {
                    const workerIds = [...new Set(plan.sessions.map((s) => s.employeeId))].filter((id) => roleFor(id) === "робітник");
                    if (!workerIds.length) return null;
                    return (
                      <>
                        <div className="section-title">Коефіцієнти для тих, кого забрали</div>
                        <div className="hint" style={{ padding: "0 16px 8px" }}>
                          ⚠️ Коефіцієнт єдиний на весь день — зміна тут вплине на розподіл по всіх обʼєктах, де людина працювала. За
                          замовчуванням 1.0.
                        </div>
                        <div className="list">
                          {workerIds.map((id) => (
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
                    );
                  })()}

                <MainButton text="Зберегти (можна пізніше)" onClick={() => setStep(volumesReturnStep)} />
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
                <div className="section-title">🛠 {work.workName}</div>
                <div className="big-number">
                  {volumeBuffer || "0"} {work.unit}
                </div>
                <div style={{ textAlign: "center", padding: "0 16px 8px" }}>
                  <button className="back-btn" onClick={() => saveVolumeDetail(true)}>
                    ❓ Обсяг ще невідомий — заповнити пізніше
                  </button>
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
            <div className="cell-row">
              <div className="cell" style={{ cursor: "default" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-blue">🚙</span>
                  <span className="cell-title">Авто</span>
                </span>
                <span className="cell-sub">
                  {cars.find((c) => c.id === carId)?.name} · {odoStart} км
                </span>
              </div>
              <button className="cell-action" onClick={() => { setEditReturnStep("READY"); setStep("PICK_CAR"); }} title="Редагувати">
                ✏️
              </button>
            </div>
            <div className="cell-row">
              <button className="cell" onClick={() => setReadyPeopleExpanded((v) => !v)}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-purple">👥</span>
                  <span className="cell-title">{readyPeopleExpanded ? "▾" : "▸"} Люди</span>
                </span>
                <span className="badge">{employeeIds.length}</span>
              </button>
              <button className="cell-action" onClick={() => { setEditReturnStep("READY"); setStep("PICK_PEOPLE"); }} title="Редагувати">
                ✏️
              </button>
            </div>
            {readyPeopleExpanded && (
              <div style={{ padding: "4px 16px 12px" }}>
                {employeeIds.length ? (
                  employeeIds.map((id) => (
                    <div key={id} className="hint">
                      • {employeeName(id)}
                    </div>
                  ))
                ) : (
                  <div className="hint">Нікого не обрано</div>
                )}
              </div>
            )}
          </div>
          <div className="section-title">Обʼєкти · роботи</div>
          <div className="list">
            {plans.map((p) => {
              const expanded = readyExpandedObjectId === p.objectId;
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button className="cell" onClick={() => setReadyExpandedObjectId(expanded ? null : p.objectId)}>
                      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className="setup-icon accent-orange">📍</span>
                        <span className="cell-title">{expanded ? "▾" : "▸"} {p.objectName}</span>
                      </span>
                      <span className="badge">{p.works.length ? `${p.works.length} робіт` : "не обрано"}</span>
                    </button>
                    <button
                      className="cell-action"
                      onClick={() => {
                        setPlanObjectId(p.objectId);
                        setWorksReturnStep("READY");
                        setStep("PLAN_WORKS");
                      }}
                      title="Редагувати"
                    >
                      ✏️
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      {p.works.length ? (
                        p.works.map((w) => (
                          <div key={w.workId} className="hint">
                            • {w.workName}
                          </div>
                        ))
                      ) : (
                        <div className="hint">Робіт не обрано</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
          <div style={{ textAlign: "center" }}>
            <div className="step-badge">🚗 ПОЇЗДКА</div>
          </div>
          <div className="pulse-icon">🚗</div>
          <div className="section-title" style={{ textAlign: "center" }}>{nextUnvisited ? "В ДОРОЗІ" : "ПОВЕРТАЄМОСЬ"}</div>
          <div className="timer-big">
            {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
          </div>
          <div className="hint" style={{ textAlign: "center" }}>лише час у дорозі — на об'єктах не рахується</div>
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

          <div className="section-title row">
            <span>По дорозі</span>
            <button className="chip" onClick={() => setShowRoadsideActions((v) => !v)}>
              🚏 {showRoadsideActions ? "Сховати" : "Висадити/забрати по дорозі"}
            </button>
          </div>

          {showRoadsideActions &&
            (() => {
              const availableToPickUp = employees.filter(
                (e) => !onboard.includes(e.id) && !plans.some((p) => p.here.includes(e.id)) && !busyEmployees.has(e.id),
              );
              return (
                <>
                  <div className="section-title">🔼 Забрати по дорозі</div>
                  <div className="chip-row">
                    {availableToPickUp.map((e) => (
                      <button key={e.id} className="chip" onClick={() => roadsidePickup(e.id)}>
                        + {e.name}
                      </button>
                    ))}
                    {!availableToPickUp.length && <div className="hint">Немає кого забирати</div>}
                  </div>

                  <div className="section-title">🔽 Висадити по дорозі — в машині {onboard.length}</div>
                  <div className="chip-row">
                    {onboard.map((id) => (
                      <button key={id} className="chip" onClick={() => roadsideDropoff(id)}>
                        − {employeeName(id)}
                      </button>
                    ))}
                    {!onboard.length && <div className="hint">Нікого немає в машині</div>}
                  </div>
                </>
              );
            })()}

          <div className="section-title">Маршрут</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            🚶 біля обʼєкта — додати тих, хто вже приїхав туди своїм ходом, і почати їм роботи, поки ви ще в дорозі.
          </div>
          <div className="list">
            {plans.map((p) => {
              const expanded = expandedDriveObjectId === p.objectId;
              const peopleEverHere = new Set(p.sessions.map((s) => s.employeeId)).size;
              const peopleTotal = peopleEverHere || p.here.length;
              const peopleHere = p.here.length;
              const peopleBadge = peopleTotal === 0 ? "" : peopleHere === 0 ? "danger" : peopleHere === peopleTotal ? "ok" : "warn";
              const worksTotal = p.works.length;
              const worksFilled = p.works.filter((w) => w.volume && w.volume !== "?").length;
              const worksBadge = worksTotal === 0 ? "" : worksFilled === 0 ? "danger" : worksFilled === worksTotal ? "ok" : "warn";
              const openSessions = p.sessions.filter((s) => !s.endedAt);
              const earliestOpenStart = openSessions.length ? Math.min(...openSessions.map((s) => new Date(s.startedAt).getTime())) : null;
              // 🚶 = the car hasn't arrived yet, but people who came under
              // their own transport are already here (and maybe working).
              const icon = p.visited ? "✅" : peopleHere > 0 ? "🚶" : "📍";
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button className="cell" onClick={() => setExpandedDriveObjectId(expanded ? null : p.objectId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {icon} {p.objectName}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {peopleTotal > 0 && (
                          <span className={`badge ${peopleBadge}`}>
                            👤 {peopleHere}/{peopleTotal}
                          </span>
                        )}
                        {worksTotal > 0 && (
                          <span className={`badge ${worksBadge}`}>
                            🛠 {worksFilled}/{worksTotal}
                          </span>
                        )}
                      </span>
                    </button>
                    {p.visited ? (
                      <button
                        className="cell-action"
                        onClick={() => {
                          setAtObjectId(p.objectId);
                          setAtObjectReturnStep("DRIVE");
                          setStep("AT_OBJECT");
                        }}
                        title="Редагувати"
                      >
                        ✏️
                      </button>
                    ) : (
                      <button className="cell-action" onClick={() => openEarlySelfTransport(p.objectId)} title="Прибули свої (свій транспорт)">
                        🚶
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      <div className="hint" style={{ fontWeight: 600 }}>👥 Зараз тут</div>
                      <div className="hint" style={{ marginBottom: 8 }}>{peopleHere ? p.here.map(employeeName).join(", ") : "нікого"}</div>
                      {openSessions.length > 0 && (
                        <div className="hint" style={{ marginBottom: 8 }}>
                          ⏱ Роботи тривають {earliestOpenStart ? fmtHMS(now - earliestOpenStart) : ""}: {openSessions.map((s) => employeeName(s.employeeId)).join(", ")}
                        </div>
                      )}
                      <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи</div>
                      <div className="hint">
                        {p.works.length
                          ? p.works.map((w) => `${w.workName}${w.volume && w.volume !== "?" ? ` (${w.volume} ${w.unit})` : ""}`).join(", ")
                          : "не заплановано"}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {nextUnvisited ? (
            <MainButton text="📍 Прибув на обʼєкт" onClick={() => setStep("ARRIVE_PICK")} />
          ) : (
            <MainButton
              // Distinct label from the last-object "🏁 Повертатись на базу"
              // button so the two never read as the same "did nothing" tap:
              // here you're already heading back, so it's either "stop to
              // pick people up" or (nobody left) "arrived at base".
              text={plans.some((p) => p.here.length > 0) ? "🛑 Зупинитись, забрати людей" : "🏁 Приїхали на базу"}
              onClick={() => {
                const hasPending = plans.some((p) => p.here.length > 0);
                // Still people left at objects to pick up on the way -- the
                // car keeps driving through RETURN_PICKUP, so the segment
                // stays open; it only pauses for real once "Приїхали на
                // базу" fires there. Nobody left means this click IS the
                // arrival at base, so pause right away.
                if (!hasPending) pauseDrivingSegment();
                setStep(hasPending ? "RETURN_PICKUP" : "RETURN");
              }}
            />
          )}
        </>
      )}

      {step === "ARRIVE_PICK" && (
        <>
          <div style={{ textAlign: "center" }}>
            <div className="step-badge">📍 ПРИБУТТЯ</div>
          </div>
          <div className="section-title">На який обʼєкт ви прибули?</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            Вже відвідані обʼєкти можна розгорнути — видно, хто там і які роботи тривають.
          </div>
          <div className="list">
            {plans.map((p) => {
              const expanded = expandedDriveObjectId === p.objectId;
              const peopleEverHere = new Set(p.sessions.map((s) => s.employeeId)).size;
              const peopleTotal = peopleEverHere || p.here.length;
              const peopleHere = p.here.length;
              const peopleBadge = peopleTotal === 0 ? "" : peopleHere === 0 ? "danger" : peopleHere === peopleTotal ? "ok" : "warn";
              const worksTotal = p.works.length;
              const worksFilled = p.works.filter((w) => w.volume && w.volume !== "?").length;
              const worksBadge = worksTotal === 0 ? "" : worksFilled === 0 ? "danger" : worksFilled === worksTotal ? "ok" : "warn";
              const openSessions = p.sessions.filter((s) => !s.endedAt);
              const earliestOpenStart = openSessions.length ? Math.min(...openSessions.map((s) => new Date(s.startedAt).getTime())) : null;
              // Gate arrive-vs-review on whether the CAR has actually been
              // here (p.visited), not on whether anyone's here -- an object
              // where people arrived early under their own transport is not
              // yet visited by the car, so tapping it must still register the
              // car's arrival (to drop the rest of the crew), not just expand.
              const icon = p.visited ? "✅" : peopleHere > 0 ? "🚶" : "📍";
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button
                      className="cell"
                      onClick={() => (p.visited ? setExpandedDriveObjectId(expanded ? null : p.objectId) : arriveAt(p.objectId))}
                    >
                      <span className="cell-title">
                        {p.visited ? (expanded ? "▾" : "▸") : "▸"} {icon} {p.objectName}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {peopleTotal > 0 && (
                          <span className={`badge ${peopleBadge}`}>
                            👤 {peopleHere}/{peopleTotal}
                          </span>
                        )}
                        {worksTotal > 0 && (
                          <span className={`badge ${worksBadge}`}>
                            🛠 {worksFilled}/{worksTotal}
                          </span>
                        )}
                      </span>
                    </button>
                    {p.visited && (
                      <button
                        className="cell-action"
                        onClick={() => {
                          setAtObjectId(p.objectId);
                          setAtObjectReturnStep("DRIVE");
                          setStep("AT_OBJECT");
                        }}
                        title="Редагувати"
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                  {p.visited && expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      <div className="hint" style={{ fontWeight: 600 }}>👥 Зараз тут</div>
                      <div className="hint" style={{ marginBottom: 8 }}>{peopleHere ? p.here.map(employeeName).join(", ") : "нікого"}</div>
                      {openSessions.length > 0 && (
                        <div className="hint" style={{ marginBottom: 8 }}>
                          ⏱ Роботи тривають {earliestOpenStart ? fmtHMS(now - earliestOpenStart) : ""}: {openSessions.map((s) => employeeName(s.employeeId)).join(", ")}
                        </div>
                      )}
                      <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи</div>
                      <div className="hint">
                        {p.works.length
                          ? p.works.map((w) => `${w.workName}${w.volume && w.volume !== "?" ? ` (${w.volume} ${w.unit})` : ""}`).join(", ")
                          : "не заплановано"}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
            <button className="back-btn" onClick={() => setStep("DRIVE")}>← Скасувати</button>
          </div>
        </>
      )}

      {step === "AT_OBJECT" && atObjectId && (
        <>
          {(() => {
            const plan = currentAtPlan();
            if (!plan) {
              // The object this screen was open on got removed/moved elsewhere
              // (e.g. a bulk "move brigade" action) while it was up -- bail to
              // the route list instead of crashing on a missing plan.
              return (
                <>
                  <div className="empty-state">Обʼєкт більше не в маршруті.</div>
                  <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
                    <button className="back-btn" onClick={() => setStep("DRIVE")}>← До маршруту</button>
                  </div>
                </>
              );
            }
            const openSessions = plan.sessions.filter((s) => !s.endedAt);
            const openSessionIds = new Set(openSessions.map((s) => s.employeeId));
            const everSessionIds = new Set(plan.sessions.map((s) => s.employeeId));
            const peopleTotal = everSessionIds.size || plan.here.length;
            const peopleActive = openSessions.length;
            const worksTotal = plan.works.length;
            const shiftOpen = openSessions.length > 0;
            const notStarted = plan.here.filter((id) => !openSessionIds.has(id));
            const earliestOpenStart = openSessions.length
              ? Math.min(...openSessions.map((s) => new Date(s.startedAt).getTime()))
              : null;
            // The car is physically here only when the driving clock is
            // paused (arriveAt pauses it). If it's still running, this screen
            // was opened mid-drive to register early self-transport arrivals,
            // so dropping people OUT of the moving car makes no sense -- hide
            // that half and keep only "who came on their own".
            const carPresent = !drivingSegmentStartedAt;
            return (
              <>
                <div className="step-badge">{carPresent ? "НА ОБʼЄКТІ" : "🚗 МАШИНА ЩЕ В ДОРОЗІ"}</div>
                {!carPresent && (
                  <div className="hint" style={{ padding: "0 16px 8px" }}>
                    Машина зараз не тут. Додайте тих, хто приїхав своїм ходом, і почніть їм роботи — тих, хто в машині, висадять, коли вона приїде.
                  </div>
                )}
                <div className="section-title row">
                  <span>📍 {plan.objectName}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    {peopleTotal > 0 && (
                      <span className={`badge ${peopleActive === 0 ? "danger" : peopleActive === peopleTotal ? "ok" : "warn"}`}>
                        👤 {peopleActive}/{peopleTotal}
                      </span>
                    )}
                    {worksTotal > 0 && <span className="badge ok">🛠 {worksTotal}</span>}
                  </span>
                </div>

                {shiftOpen ? (
                  <div className="active-work-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ fontWeight: 700 }}>Роботи тривають</div>
                      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {/* Shown only while someone here still hasn't started
                            (e.g. work began for early self-transport arrivals,
                            then the car came and dropped more) -- one tap
                            starts everyone still idle, each getting their own
                            timer, then it disappears, leaving just the shared
                            "finish everyone" control. */}
                        {notStarted.length > 0 && (
                          <button className="chip selected" onClick={startShift} disabled={!plan.works.length}>
                            ▶️ Долучити решту ({notStarted.length})
                          </button>
                        )}
                        <button className="chip danger-btn" onClick={finishShift}>
                          ⏹ Завершити все
                        </button>
                      </span>
                    </div>
                    <div className="timer-big" style={{ padding: "4px 0" }}>
                      {earliestOpenStart ? fmtHMS(now - earliestOpenStart) : "00:00:00"}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">Роботи ще не розпочато</div>
                )}

                {(worksTotal > 0 || plan.here.length > 0) && (
                  <button className="back-btn" onClick={() => setAtObjectDetailsExpanded((v) => !v)}>
                    {atObjectDetailsExpanded ? "▾ Сховати деталі" : "▸ Показати деталі (роботи, люди)"}
                  </button>
                )}

                {atObjectDetailsExpanded && worksTotal > 0 && (
                  <div className="list" style={{ marginBottom: 8 }}>
                    <div className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title">🛠 Роботи на обʼєкті — кожна зі своїм таймером</span>
                      <span className="badge ok">{worksTotal}</span>
                    </div>
                    {plan.works.map((w) => {
                      const running = !!w.workStartedAt;
                      const elapsed = (w.workAccumulatedMs ?? 0) + (running ? now - new Date(w.workStartedAt as string).getTime() : 0);
                      return (
                        <div key={w.workId} className="cell" style={{ cursor: "default" }}>
                          <span className="cell-title">{w.workName}</span>
                          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            {elapsed > 0 && <span className="hint">{fmtHMS(elapsed)}</span>}
                            {running ? (
                              <button className="chip danger-btn" onClick={() => stopWorkTimer(atObjectId, w.workId)}>
                                ⏹ Стоп
                              </button>
                            ) : (
                              <button className="chip" onClick={() => startWorkTimer(atObjectId, w.workId)}>
                                ▶️ Старт
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {atObjectDetailsExpanded && plan.here.length > 0 && (
                  <>
                    <div className="section-title">Люди тут — кожен зі своїм таймером</div>
                    <div className="list">
                      {plan.here.map((id) => {
                        const session = plan.sessions.find((s) => s.employeeId === id && !s.endedAt);
                        const running = !!session;
                        const closedMs = plan.sessions
                          .filter((s) => s.employeeId === id && s.endedAt)
                          .reduce((a, s) => a + (new Date(s.endedAt as string).getTime() - new Date(s.startedAt).getTime()), 0);
                        const elapsed = closedMs + (running ? now - new Date(session!.startedAt).getTime() : 0);
                        return (
                          <div key={id} className="cell" style={{ cursor: "default" }}>
                            <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                              {employeeName(id)}
                            </span>
                            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              {elapsed > 0 && <span className="hint">{fmtHMS(elapsed)}</span>}
                              {running ? (
                                <button className="chip danger-btn" onClick={() => stopPersonTimer(atObjectId, id)}>
                                  ⏹ Стоп
                                </button>
                              ) : (
                                <button className="chip" onClick={() => startPersonTimer(atObjectId, id)}>
                                  ▶️ Старт
                                </button>
                              )}
                              <button className="chip" onClick={() => pickUpOne(atObjectId, id)}>
                                🔼 Забрати
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {!showDropPicker && !showMovePicker && !showManualHours && (
                  <div className="list" style={{ marginTop: 8 }}>
                    <button
                      className="cell"
                      onClick={() => {
                        setDropSelected([]);
                        setAddArrivedSelected([]);
                        setShowDropPicker(true);
                      }}
                    >
                      <span className="cell-title">
                        {carPresent ? "👥 Хто тут — висадити / додати приїхавших самих" : "🚶 Додати тих, хто приїхав сам"}
                      </span>
                      <span className="cell-sub">{carPresent ? `🚐 ${onboard.length} в машині` : "машина ще в дорозі"}</span>
                    </button>
                    {/* Once work is underway, "start the rest" lives next to
                        "finish everyone" in the active-work card above -- keep
                        this only as the very first "start work" entry point. */}
                    {!shiftOpen && notStarted.length > 0 && (
                      <button className="cell" onClick={startShift} disabled={!plan.works.length}>
                        <span className="cell-title">▶️ Почати роботи</span>
                        <span className="cell-sub">{notStarted.length} людей</span>
                      </button>
                    )}
                    <button
                      className="cell"
                      onClick={() => {
                        setPlanObjectId(atObjectId);
                        setWorksReturnStep("AT_OBJECT");
                        setStep("PLAN_WORKS");
                      }}
                    >
                      <span className="cell-title">✏️ Додати/змінити роботи</span>
                      <span className="cell-sub">{plan.works.length} робіт</span>
                    </button>
                    <button
                      className="cell"
                      onClick={() => {
                        setMoveSelected([]);
                        setMoveTargetId(null);
                        setShowMovePicker(true);
                      }}
                      disabled={!plan.here.length}
                    >
                      <span className="cell-title">🔄 Перенести людей на інший обʼєкт</span>
                    </button>
                    <button
                      className="cell"
                      onClick={() => {
                        setManualHoursEmployeeId(null);
                        setManualHoursBuffer("");
                        setShowManualHours(true);
                      }}
                    >
                      <span className="cell-title">🕒 Ввести години вручну</span>
                      <span className="cell-sub">якщо забули таймер</span>
                    </button>
                  </div>
                )}

                {plans.length > 1 && !showDropPicker && !showMovePicker && !showManualHours && (
                  <>
                    <div className="section-title">Інші обʼєкти — переключитись</div>
                    <div className="list">
                      {plans
                        .filter((p) => p.objectId !== atObjectId)
                        .map((p) => (
                          <button key={p.objectId} className="cell" onClick={() => switchAtObject(p.objectId)}>
                            <span className="cell-title">📍 {p.objectName}</span>
                            <span className="badge">{p.here.length ? `${p.here.length} тут` : p.visited ? "відвідано" : "заплановано"}</span>
                          </button>
                        ))}
                    </div>
                  </>
                )}

                {showDropPicker && (
                  <>
                    {carPresent && onboard.length > 0 && (
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
                      </>
                    )}

                    <div className="section-title">🚶 Хто приїхав сам (свій транспорт)</div>
                    <input
                      className="search-box"
                      placeholder="Пошук людини…"
                      value={arrivedSearch}
                      onChange={(e) => setArrivedSearch(e.target.value)}
                    />
                    <div className="list">
                      {groupByBrigade(
                        employees.filter(
                          (e) => !employeeIds.includes(e.id) && !busyEmployees.has(e.id) && e.name.toLowerCase().includes(arrivedSearch.toLowerCase()),
                        ),
                        employees,
                      ).map((g) => {
                        const expanded = expandedArrivedBrigadeId === g.id || !!arrivedSearch;
                        const selectedCount = g.members.filter((e) => addArrivedSelected.includes(e.id)).length;
                        const allSelected = g.members.length > 0 && g.members.every((e) => addArrivedSelected.includes(e.id));
                        return (
                          <div key={g.id}>
                            <button className="cell" onClick={() => setExpandedArrivedBrigadeId(expanded ? null : g.id)}>
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
                                  className={`bulk-select-btn ${allSelected ? "active" : ""}`}
                                  onClick={() =>
                                    setAddArrivedSelected((prev) =>
                                      allSelected
                                        ? prev.filter((id) => !g.members.some((e) => e.id === id))
                                        : [...new Set([...prev, ...g.members.map((e) => e.id)])],
                                    )
                                  }
                                >
                                  {allSelected ? "✕ Зняти всю бригаду" : "✓ Обрати всю бригаду"}
                                </button>
                                {g.members.map((emp) => {
                                  const checked = addArrivedSelected.includes(emp.id);
                                  return (
                                    <button
                                      key={emp.id}
                                      className={`cell ${checked ? "selected" : ""}`}
                                      onClick={() =>
                                        setAddArrivedSelected((prev) =>
                                          prev.includes(emp.id) ? prev.filter((x) => x !== emp.id) : [...prev, emp.id],
                                        )
                                      }
                                    >
                                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                        <span className={`avatar-circle ${roleAccent(employeeRole(emp))}`}>{initials(emp.name)}</span>
                                        {emp.name}
                                      </span>
                                      <span className="role-tag">{employeeRole(emp)}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                      <button
                        className="chip"
                        onClick={() => {
                          setDropSelected([]);
                          setAddArrivedSelected([]);
                          setShowDropPicker(false);
                        }}
                      >
                        Скасувати
                      </button>
                      <button
                        className="chip selected"
                        onClick={confirmDropAndArrived}
                        disabled={!dropSelected.length && !addArrivedSelected.length}
                      >
                        Підтвердити
                      </button>
                    </div>
                  </>
                )}

                {showMovePicker && (
                  <>
                    <div className="section-title">Кого перенести</div>
                    <div className="chip-row">
                      <button className="chip" onClick={() => setMoveSelected(plan.here)}>
                        Обрати всіх
                      </button>
                      {plan.here.map((id) => (
                        <button
                          key={id}
                          className={`chip ${moveSelected.includes(id) ? "selected" : ""}`}
                          onClick={() => setMoveSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                        >
                          {employeeName(id)}
                        </button>
                      ))}
                    </div>
                    <div className="section-title">На який обʼєкт</div>
                    <div className="chip-row">
                      {plans
                        .filter((p) => p.objectId !== atObjectId)
                        .map((p) => (
                          <button key={p.objectId} className={`chip ${moveTargetId === p.objectId ? "selected" : ""}`} onClick={() => setMoveTargetId(p.objectId)}>
                            {p.objectName}
                          </button>
                        ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                      <button
                        className="chip"
                        onClick={() => {
                          setMoveSelected([]);
                          setMoveTargetId(null);
                          setShowMovePicker(false);
                        }}
                      >
                        Скасувати
                      </button>
                      <button className="chip selected" onClick={confirmMove} disabled={!moveSelected.length || !moveTargetId}>
                        Підтвердити
                      </button>
                    </div>
                  </>
                )}

                {showManualHours &&
                  (manualHoursEmployeeId ? (
                    <>
                      <div className="section-title">🕒 {employeeName(manualHoursEmployeeId)} — години на «{plan.objectName}»</div>
                      <div className="big-number">{manualHoursBuffer || "0"} год</div>
                      <NumericKeypad value={manualHoursBuffer} onChange={setManualHoursBuffer} />
                      <div style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
                        <button className="chip" onClick={() => setManualHoursEmployeeId(null)}>
                          ← Назад
                        </button>
                        <button
                          className="chip selected"
                          onClick={() => {
                            setManualHours(atObjectId, manualHoursEmployeeId, Number(manualHoursBuffer) || 0);
                            setManualHoursEmployeeId(null);
                          }}
                        >
                          Зберегти
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="section-title">🕒 Години вручну — {plan.objectName}</div>
                      <div className="hint" style={{ padding: "0 16px 8px" }}>
                        Якщо забули ввімкнути таймер — впишіть відпрацьовані години. Це перезапише таймер для цієї людини на цьому обʼєкті.
                      </div>
                      <div className="list">
                        {employeeIds.map((id) => {
                          const hrs = hoursAtObject(plan, id);
                          return (
                            <button
                              key={id}
                              className="cell"
                              onClick={() => {
                                setManualHoursEmployeeId(id);
                                setManualHoursBuffer(hrs > 0 ? String(hrs) : "");
                              }}
                            >
                              <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                                {employeeName(id)}
                              </span>
                              <span className="cell-sub">{hrs > 0 ? `${hrs} год · ✏️` : "— · ✏️"}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ padding: "8px 16px" }}>
                        <button className="chip" onClick={() => setShowManualHours(false)}>
                          ✅ Готово
                        </button>
                      </div>
                    </>
                  ))}

                <div className="hint" style={{ padding: "0 16px 8px", textAlign: "center" }}>
                  Можна їхати далі з тими, хто залишився в машині — робота тут триватиме без вас.
                </div>
                <MainButton
                  text={
                    atObjectReturnStep !== "DRIVE"
                      ? "✅ Готово"
                      : nextUnvisited
                        ? "➡️ Продовжити маршрут"
                        : "🏁 Повертатись на базу"
                  }
                  onClick={() => {
                    // Last object done: go STRAIGHT to the return-to-base
                    // pickup list instead of dropping back onto the DRIVE
                    // screen, which showed a second, identically-labelled
                    // "return to base" button and made the foreman think
                    // their tap did nothing. Stay parked -- the segment is
                    // already paused from arriveAt(); RETURN_PICKUP's
                    // "▶️ Продовжити рух" resumes the clock once they drive
                    // off. If nobody's left to pick up anywhere, skip
                    // straight to the final odometer.
                    if (atObjectReturnStep === "DRIVE" && !nextUnvisited) {
                      setStep(plans.some((p) => p.here.length > 0) ? "RETURN_PICKUP" : "RETURN");
                      return;
                    }
                    if (atObjectReturnStep === "DRIVE") resumeDrivingSegment();
                    setStep(atObjectReturnStep);
                  }}
                />
              </>
            );
          })()}
        </>
      )}

      {step === "RETURN_PICKUP" && (
        <>
          {(() => {
            const visited = plans.filter((p) => p.visited);
            const anyPending = visited.some((p) => p.here.length > 0);
            return (
              <>
                <div className="step-badge">ПОВЕРНЕННЯ НА БАЗУ</div>
                <div className="timer-big">
                  {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
                </div>
                <div className="hint" style={{ textAlign: "center" }}>лише час у дорозі — на об'єктах не рахується</div>
                <div className="section-title">Обʼєкти</div>
                <div className="list">
                  {visited.map((p) => {
                    const expanded = expandedReturnPickupObjectId === p.objectId;
                    const peopleHere = p.here.length;
                    const peopleActive = p.sessions.filter((s) => !s.endedAt).length;
                    const worksTotal = p.works.length;
                    const worksFilled = p.works.filter((w) => w.volume && w.volume !== "?").length;
                    return (
                      <div key={p.objectId}>
                        <button className="cell" onClick={() => setExpandedReturnPickupObjectId(expanded ? null : p.objectId)}>
                          <span className="cell-title">
                            {expanded ? "▾" : "▸"} 📍 {p.objectName}
                          </span>
                          <span style={{ display: "flex", gap: 6 }}>
                            {peopleHere === 0 ? (
                              <span className="badge ok">✅ забрано</span>
                            ) : (
                              <span className={`badge ${peopleActive === 0 ? "danger" : "warn"}`}>👤 {peopleHere} тут</span>
                            )}
                            {worksTotal > 0 && (
                              <span className={`badge ${worksFilled === worksTotal ? "ok" : "warn"}`}>
                                🛠 {worksFilled}/{worksTotal}
                              </span>
                            )}
                          </span>
                        </button>
                        {expanded && (
                          <div style={{ padding: "4px 16px 8px" }}>
                            <div className="hint" style={{ fontWeight: 600 }}>👥 Люди</div>
                            <div className="hint" style={{ marginBottom: 8 }}>{peopleHere ? p.here.map(employeeName).join(", ") : "усіх забрано"}</div>
                            <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи</div>
                            <div className="hint">
                              {p.works.length
                                ? p.works.map((w) => `${w.workName}${w.volume && w.volume !== "?" ? ` (${w.volume} ${w.unit})` : ""}`).join(", ")
                                : "без робіт"}
                            </div>
                          </div>
                        )}
                        {(peopleHere > 0 || worksTotal > 0) && (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 16px 10px" }}>
                            {peopleHere > 0 && (
                              <button className="chip selected" onClick={() => returnPickupObject(p.objectId)}>
                                🔼 Забрати усіх ({peopleHere})
                              </button>
                            )}
                            {worksTotal > 0 && (
                              <button className="chip" onClick={() => openVolumesForObject(p.objectId, "RETURN_PICKUP")}>
                                📏 Ввести обсяги{worksFilled < worksTotal ? ` (${worksTotal - worksFilled})` : ""}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {!drivingSegmentStartedAt && (
                  <div style={{ padding: "0 16px 10px" }}>
                    <button className="chip selected" style={{ width: "100%" }} onClick={resumeDrivingSegment}>
                      ▶️ Продовжити рух
                    </button>
                  </div>
                )}
                <MainButton
                  text="🏁 Приїхали на базу"
                  onClick={() => {
                    pauseDrivingSegment();
                    setStep("RETURN");
                  }}
                  disabled={anyPending}
                />
              </>
            );
          })()}
        </>
      )}

      {step === "RETURN" && (
        <>
          <div className="step-badge">ПОВЕРНЕННЯ</div>
          <div className="section-title">Обʼєкти</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>Завершіть роботу і заберіть людей з обʼєктів</div>
          <div className="list">
            {plans
              .filter((p) => p.visited)
              .map((p) => {
                const unfilled = p.works.filter((w) => !w.volume || w.volume === "?").length;
                const expanded = expandedReturnObjectId === p.objectId;
                return (
                  <div key={p.objectId}>
                    <div className="cell-row">
                      <button className="cell" onClick={() => setExpandedReturnObjectId(expanded ? null : p.objectId)}>
                        <span className="cell-title">
                          {expanded ? "▾" : "▸"} 📍 {p.objectName}
                        </span>
                        <span style={{ display: "flex", gap: 6 }}>
                          <span className={`badge ${p.here.length ? "warn" : "ok"}`}>{p.here.length ? `${p.here.length} тут` : "забрано"}</span>
                          {p.works.length > 0 && (
                            <span className={`badge ${unfilled === 0 ? "ok" : "warn"}`}>
                              🛠 {p.works.length - unfilled}/{p.works.length}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        className="cell-action"
                        onClick={() => {
                          setAtObjectId(p.objectId);
                          setAtObjectReturnStep("RETURN");
                          setStep("AT_OBJECT");
                        }}
                        title="Редагувати обʼєкт"
                      >
                        ✏️
                      </button>
                    </div>
                    {expanded && (
                      <div style={{ padding: "4px 16px 8px" }}>
                        <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи та обсяги</div>
                        <div className="hint" style={{ marginBottom: 8 }}>
                          {p.works.length
                            ? p.works.map((w) => `${w.workName}: ${w.volume && w.volume !== "?" ? `${w.volume} ${w.unit}` : "не введено"}`).join(", ")
                            : "без робіт"}
                        </div>
                        {p.here.length > 0 && <div className="hint">👥 Ще тут: {p.here.map(employeeName).join(", ")}</div>}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", flexWrap: "wrap" }}>
                      {p.here.length > 0 && (
                        <button className="chip" onClick={() => pickUpHere(p.objectId)}>
                          Забрати ({p.here.map(employeeName).join(", ")})
                        </button>
                      )}
                      {unfilled > 0 && (
                        <button className="chip" onClick={() => openVolumesForObject(p.objectId, "RETURN")}>
                          🟡 Ввести обсяги ({unfilled})
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="section-title">Одометр на фініші</div>
          <div className="hint" style={{ padding: "0 16px" }}>Старт: {odoStart} км</div>
          <div className="big-number">{odoEnd || "0"} км</div>
          {odoEnd && Number(odoEnd) >= Number(odoStart) && (
            <div className="hint" style={{ textAlign: "center" }}>
              Пройдено {Math.round((Number(odoEnd) - Number(odoStart)) * 10) / 10} км · загальний час у дорозі{" "}
              {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
            </div>
          )}
          {odoEnd && Number(odoEnd) < Number(odoStart) && (
            <div className="hint" style={{ textAlign: "center", color: "var(--tg-destructive-text, #e53935)" }}>
              ⚠️ Не може бути менше за старт ({odoStart} км)
            </div>
          )}
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
              await markCarReturned();
              logChange(`Повернення: одометр ${odoEnd} км`);
              setReviewReturnStep("RETURN");
              setStep("REVIEW");
              await loadPreview();
            }}
            disabled={!odoEnd || !allBack || uploadingPhoto || Number(odoEnd) < Number(odoStart)}
          />
        </>
      )}

      {step === "REVIEW" && retroReplaceObjectId && (
        <>
          <div className="step-badge">ПІДСУМОК ДНЯ</div>
          <div className="section-title">
            Замінити "{plans.find((p) => p.objectId === retroReplaceObjectId)?.objectName ?? retroReplaceObjectId}" на
          </div>
          <div className="list">
            {objects
              .filter((o) => !plans.some((p) => p.objectId === o.id))
              .map((o) => (
                <button key={o.id} className="cell" onClick={() => replaceObjectInPlan(retroReplaceObjectId, o)}>
                  <span className="cell-title">📍 {o.name}</span>
                  <span className="cell-sub">{o.address ?? ""}</span>
                </button>
              ))}
          </div>
          <div style={{ padding: "8px 16px" }}>
            <button className="chip" onClick={() => setRetroReplaceObjectId(null)}>
              Скасувати
            </button>
          </div>
        </>
      )}

      {step === "REVIEW" && !retroReplaceObjectId && (
        <>
          <div className="step-badge">ПІДСУМОК ДНЯ</div>
          <div className="section-title">Поїздка</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">Проїхано</span>
              <span className="cell-sub">
                {preview ? `${preview.km} км · клас ${preview.tripClass}` : "рахую…"}
              </span>
            </div>
          </div>

          <div className="section-title row">
            <span>🚙 Авто{carId ? `: ${cars.find((c) => c.id === carId)?.name ?? ""}` : ""}</span>
            <button
              className="chip"
              onClick={() => {
                setEditReturnStep("REVIEW");
                setStep("PICK_CAR");
              }}
            >
              ✏️ Редагувати
            </button>
          </div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>{odoStart} км</div>

          <div className="section-title row">
            <span>🏁 Одометр на фініші</span>
            <button
              className="chip"
              onClick={() => {
                setReviewReturnStep("REVIEW");
                setStep("RETURN");
              }}
            >
              ✏️ Редагувати
            </button>
          </div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>{odoEnd || "—"} км</div>

          <div className="section-title row">
            <span>Люди — {employeeIds.length}</span>
            <button
              className="chip"
              onClick={() => {
                setEditReturnStep("REVIEW");
                setStep("PICK_PEOPLE");
              }}
            >
              ✏️ Редагувати
            </button>
          </div>
          <div style={{ padding: "0 16px 8px" }}>
            <button className="back-btn" onClick={() => setReviewPeopleExpanded((v) => !v)}>
              {reviewPeopleExpanded ? "▾ Сховати список" : "▸ Показати список"}
            </button>
          </div>
          {reviewPeopleExpanded && (
            <div className="list" style={{ marginBottom: 8 }}>
              {employeeIds.length ? (
                employeeIds.map((id) => (
                  <div key={id} className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                      {employeeName(id)}
                    </span>
                    {selfTransportIds.includes(id) && <span className="badge">🚶 без доплати за дорогу</span>}
                  </div>
                ))
              ) : (
                <div className="empty-state">Нікого не обрано</div>
              )}
            </div>
          )}

          <div className="section-title">Обʼєкти · роботи · обсяги</div>
          <div className="list">
            {plans.map((p) => {
              const expanded = expandedReviewObjectId === p.objectId;
              const unfilled = p.works.filter((w) => !w.volume || w.volume === "?").length;
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button className="cell" onClick={() => setExpandedReviewObjectId(expanded ? null : p.objectId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} 📍 {p.objectName}
                      </span>
                      {p.works.length > 0 && (
                        <span className={`badge ${unfilled === 0 ? "ok" : "warn"}`}>
                          {unfilled === 0 ? "✅ обсяги є" : `🟡 ${unfilled} без обсягу`}
                        </span>
                      )}
                    </button>
                    <button
                      className="cell-action"
                      onClick={() => openVolumesForObject(p.objectId, "REVIEW")}
                      disabled={!p.works.length}
                      title="Редагувати обсяги"
                    >
                      📏
                    </button>
                    <button
                      className="cell-action"
                      onClick={() => {
                        setPlanObjectId(p.objectId);
                        setWorksReturnStep("REVIEW");
                        setStep("PLAN_WORKS");
                      }}
                      title="Редагувати роботи"
                    >
                      ✏️
                    </button>
                    <button className="cell-action" onClick={() => setRetroReplaceObjectId(p.objectId)} title="Замінити обʼєкт">
                      🔁
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 10px" }}>
                      {p.works.length ? (
                        p.works.map((w) => (
                          <div key={w.workId} className="hint">
                            • {w.workName}: {w.volume && w.volume !== "?" ? `${w.volume} ${w.unit}` : "не введено"}
                          </div>
                        ))
                      ) : (
                        <div className="hint">без робіт</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-title">Працівники</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>
            Коефіцієнти впливають лише на розподіл частки робітників у фонді обʼєкта, за замовчуванням 1.0. Тапни на робітника, щоб змінити.
          </div>
          <div style={{ padding: "0 16px 8px" }}>
            <button className="back-btn" onClick={() => setReviewWorkersExpanded((v) => !v)}>
              {reviewWorkersExpanded ? "▾ Сховати список" : `▸ Показати список (${employeeIds.length})`}
            </button>
          </div>
          {reviewWorkersExpanded && (
          <div className="list">
            {employeeIds.map((id) => {
              const totalMs = plans.reduce((acc, p) => {
                const ms = p.sessions
                  .filter((s) => s.employeeId === id)
                  .reduce((sum, s) => {
                    const start = new Date(s.startedAt).getTime();
                    const end = new Date(s.endedAt ?? new Date().toISOString()).getTime();
                    return sum + Math.max(0, end - start);
                  }, 0);
                return acc + ms;
              }, 0);
              const isWorker = roleFor(id) === "робітник";
              const expanded = isWorker && expandedCoefEmployeeId === id;
              const c = coefFor(id);
              return (
                <div key={id}>
                  {isWorker ? (
                    <button className="cell" onClick={() => setExpandedCoefEmployeeId(expanded ? null : id)}>
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {expanded ? "▾" : "▸"} {employeeName(id)}
                      </span>
                      <span className="cell-sub">
                        {fmtHours(totalMs)} год · Дисц. {c.disciplineCoef} · Прод. {c.productivityCoef}
                      </span>
                    </button>
                  ) : (
                    <div className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {employeeName(id)}
                      </span>
                      <span className="cell-sub">{fmtHours(totalMs)} год</span>
                    </div>
                  )}
                  {expanded && (
                    <div style={{ padding: "4px 16px 10px" }}>
                      <div className="hint">Дисципліна</div>
                      <div className="chip-row">
                        {COEF_PRESETS.map((v) => (
                          <div
                            key={v}
                            className={`chip ${c.disciplineCoef === v ? "selected" : ""}`}
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
                            className={`chip ${c.productivityCoef === v ? "selected" : ""}`}
                            onClick={() => setCoef(id, "productivityCoef", v)}
                          >
                            {v}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}

          {preview && (
            <>
              <div className="section-title">Хто скільки заробив</div>
              <div className="hint" style={{ padding: "0 16px 8px" }}>
                🔒 Суми стануть видимі після затвердження звіту адміністратором.
              </div>
              <div className="list">
                {employeeIds.map((id) => (
                  <div key={id} className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                      {employeeName(id)}
                      {id === preview.brigadierEmployeeId && <span className="badge">бригадир</span>}
                      {preview.seniorEmployeeIds.includes(id) && <span className="badge">старший</span>}
                    </span>
                    <span className="cell-sub">🔒 •••</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(() => {
            const unfilled = plans.flatMap((p) =>
              p.works.filter((w) => !w.volume || w.volume === "?").map((w) => `${p.objectName}: ${w.workName}`),
            );
            if (!unfilled.length) return null;
            return (
              <div className="hint" style={{ padding: "0 16px 8px", color: "#d70015" }}>
                ⚠️ Не введено обсяг: {unfilled.join(", ")}. Заповніть перед відправкою.
              </div>
            );
          })()}

          {(() => {
            const noWork = plans.filter(
              (p) => p.sessions.length === 0 && p.works.some((w) => w.volume && w.volume !== "?" && Number(w.volume) > 0),
            );
            if (!noWork.length) return null;
            return (
              <div className="hint" style={{ padding: "0 16px 8px", color: "#d70015" }}>
                ⚠️ Не розпочато роботи на: {noWork.map((p) => p.objectName).join(", ")}. За ці обʼєкти гроші не розподіляться між людьми.
              </div>
            );
          })()}

          <MainButton
            text={saving ? "Відправлення…" : editingTripSeq !== null ? "📤 Оновити звіт" : "📤 Відправити на підтвердження"}
            onClick={save}
            disabled={saving || !employeeIds.length || plans.some((p) => p.works.some((w) => !w.volume || w.volume === "?"))}
          />
        </>
      )}
    </div>
  );
}
