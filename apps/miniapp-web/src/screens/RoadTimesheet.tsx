import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject, type SalaryPack, type TripPlan, type PlanObject, type Foreman, type PlannedResources } from "../lib/api";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { todayISO } from "../lib/date";
import { setTrackContext, track } from "../lib/track";
import { tapProps } from "../lib/tap";
import { mirrorDraft, clearMirroredDraft, fetchMirroredDraft } from "../lib/draftMirror";
import { alertDialog, ask3Dialog, askDialog, confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, initials, roleAccent, groupByBrigade, shortName, surnameInitial, roleTagClass, roleRank, findMyEmployeeId, type EmployeeRole } from "../lib/employee";
import { groupWorks } from "../lib/works";
import { works as nWorks, people as nPeople, objects as nObjects, plural } from "../lib/plural";
import { saveDraft, loadDraft, clearDraft } from "../lib/draft";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";
import { NumericKeypad } from "../components/NumericKeypad";
import { PhotoButton } from "../components/PhotoButton";
import { fmtHours, MIN_PAID_HOURS } from "../lib/hours";

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
  | "INDEX"
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
  // Хто отримує гроші саме за цю роботу. Порожньо/відсутнє = робота спільна
  // для всієї бригади на обʼєкті (звичайний випадок). Заповнено — її вартість
  // ділиться лише між цими людьми (див. buildSalaryPacksWithRoles).
  employeeIds?: string[];
};
// Per-employee work session at an object: started when work begins for that
// person, ended either individually (picked up early / stopped alone) or all
// together via "Завершити". Lets people finish and leave an object at
// different times instead of a single all-or-nothing shift.
type EmployeeSession = { employeeId: string; startedAt: string; endedAt?: string };

/** Псевдо-обʼєкт «база» у виборі, куди подіти людину при виправленні. */
const BASE_TARGET = "__BASE__";
type ObjPlan = {
  objectId: string;
  objectName: string;
  works: PlannedWork[];
  assignedEmployeeIds: string[]; // planned before departure
  here: string[]; // physically dropped off at this object right now
  sessions: EmployeeSession[];
  visited: boolean; // reached (formally, or via a quick drop-off during the drive)
  // Reached, and deliberately left without anybody working there. Arriving and
  // driving on with the crew still in the bus is almost always a mis-tap, so
  // by default such an object stays unfinished and the route keeps offering
  // it; this flag is how a foreman says "we really did just look and leave".
  noWork?: boolean;
  notes: string;
  photoUrls: string[];
};

// Where an employee currently is: exactly one of onboard, one specific
// object's `here`, or nowhere (taken off the day's active roster entirely).
type Location = { kind: "onboard" } | { kind: "object"; objectId: string } | { kind: "nowhere" };

type CoefPair = { disciplineCoef: number; productivityCoef: number };

// "Car left on errands while the crew worked": one of the people at the
// object drives off and comes back. odoBack === null means it's still out.
// The mileage (odoBack - odoOut) is excluded from the trip-class / travel
// allowance server-side (see the errands payload) but not from the real
// odometer total.
type Errand = { id: string; objectId: string; objectName: string; driverId: string; odoOut: number; odoBack: number | null };

type PayrollPreview = {
  km?: number;
  excludedKm?: number; // errand km excluded from the trip class / allowance
  billableKm?: number; // km actually used for the class (gross - excluded)
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
  brigadierEmployeeIds: string[];
  seniorEmployeeIds: string[];
};
// The day-combined totals -- what actually gets paid out -- once more than
// one trip has been submitted for the same day (see SubmittedTrip below).
type DayCombined = {
  km: number;
  excludedKm?: number;
  billableKm?: number;
  tripClass: string;
  roadAllowance: { total: number; perPerson: number };
  salaryPacks: SalaryPack[];
};
type SaveResponse = PayrollPreview & { eventId: string; tripSeq: number; combined: DayCombined };

type DayStatus = {
  hasSubmission: boolean;
  approved: boolean;
  // Admin sent the day back for corrections. It behaves exactly like a
  // not-yet-submitted day again -- fully editable, resubmitted the same way.
  returned: boolean;
  returnReason: string | null;
  eventId: string | null;
  editRequested: boolean;
};
type SubmittedObject = {
  objectId: string;
  objectName: string;
  works: { workId: string; workName: string; volume?: string | number; employeeIds?: string[] }[];
  sessions: { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string }[];
  coefs?: { employeeId: string; disciplineCoef?: number; productivityCoef?: number }[];
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
  errands?: Errand[];
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

/**
 * Everything the trip builder holds for ONE trip.
 *
 * The planner borrows the same pickers, so entering it puts the day in here
 * and leaving it puts the day back. That is why planning no longer demands an
 * empty day: the two never occupy the builder at the same time.
 */
type BuilderSnapshot = {
  /** Дата дня, який відклали. Без неї відкладений день повертався на ту дату,
      яка стояла на екрані в момент повернення -- тобто на чужу. */
  date?: string;
  step: Step;
  carId: string;
  odoStart: string;
  odoStartPhoto: string | null;
  odoEnd: string;
  odoEndPhoto: string | null;
  employeeIds: string[];
  selfTransportIds: string[];
  errands: Errand[];
  plans: ObjPlan[];
  onboard: string[];
  tripStartedAt: string | null;
  drivingAccumulatedMs: number;
  drivingSegmentStartedAt: string | null;
  atObjectId: string | null;
  headingToObjectId: string;
  carAtObjectId: string;
  atObjectReturnStep: Step;
  planObjectId: string | null;
  coefs: Record<string, CoefPair>;
  editingTripSeq: number | null;
  changeLog: { ts: number; label: string }[];
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
  errands: Errand[];
  plans: ObjPlan[];
  onboard: string[];
  tripStartedAt: string | null;
  drivingAccumulatedMs: number;
  drivingSegmentStartedAt: string | null;
  atObjectId: string | null;
  headingToObjectId?: string;
  carAtObjectId?: string;
  // Where AT_OBJECT's "✅ Готово" button should return to (DRIVE, RETURN,
  // etc). Without this an app-kill mid-AT_OBJECT restores to the default
  // "DRIVE", which can wrongly resume the driving-segment timer for a leg
  // that had actually already finished (reached AT_OBJECT from RETURN).
  atObjectReturnStep: Step;
  // Which object PLAN_WORKS/PLAN_VOLUMES is currently editing -- those
  // screens render nothing without it, so an app-kill mid-edit would
  // otherwise restore to a blank screen with no way back except resetting.
  planObjectId: string | null;
  // Куди веде «Зберегти» з екрана обсягів. Раніше не зберігалось, і після
  // падіння застосунку повернення завжди йшло на обʼєкт -- поки єдиний вхід
  // сюди був саме звідти, це майже завжди збігалось. З входом «У дорозі» вже
  // ні: бригадир опинявся на обʼєкті, на який не прибував.
  volumesReturnStep?: Step;
  // Список робіт до заходу в пікер. Саме на цьому екрані застосунок і застав
  // бригадира, коли сім зайвих робіт лишились непоміченими: після перезапуску
  // знімка не було, і вихід «‹ Назад» знову нічого б не спитав.
  worksBeforePicker?: PlannedWork[] | null;
  // «Їдемо на базу, вони доробляють». Без цього перезапуск застосунку в
  // дорозі повертав день у глухий кут: на обʼєктах люди -- отже «Рушили на
  // базу» знову немає, хоч бригадир уже їде.
  goingHomeWithoutThem?: boolean;
  coefs: Record<string, CoefPair>;
  // Which already-submitted trip this draft is mid-edit of, if any -- lost
  // without this, an interrupted edit (app killed before resubmitting) would
  // resume as if it were a brand-new trip and create a duplicate on save.
  editingTripSeq: number | null;
  // Without these a plan reopened after the app was killed would come back
  // looking exactly like a half-built day -- and, worse, saving it would
  // create a second plan instead of updating the one being edited.
  planEditing?: boolean;
  editingPlanId?: string | null;
  planForemanTgId?: number | null;
  // The day that was set aside while the planner borrowed the pickers. Kept in
  // the draft so an app-kill during planning cannot lose a running trip -- on
  // restore this is what comes back, and the half-written plan is dropped.
  dayStash?: BuilderSnapshot | null;
  /** Дата поверненого дня, який правиться замість сьогоднішнього. */
  fixingReturnedDate?: string | null;
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
    noWork: p.noWork ?? false,
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

// Compact people list for mid-drive fixes. Denser than the setup pickers on
// purpose: it is opened in a moving car to touch one person, not to plan a
// day -- but still grouped by brigade, because a wrapped run of name chips
// gave no way to find anyone.
function MiniPeopleList({
  people,
  roster,
  sign,
  onPick,
}: {
  people: Employee[];
  roster: Employee[];
  sign: "+" | "−";
  onPick: (id: string) => void;
}) {
  return (
    <div className="mini-list">
      {groupByBrigade(people, roster).map((g) => (
        <div key={g.id} className="mini-group">
          <div className="mini-group-title">{g.title}</div>
          {g.members.map((e) => (
            <button key={e.id} className="mini-row" onClick={() => onPick(e.id)}>
              <span className="mini-sign">{sign}</span>
              <span>{shortName(e.name)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function fmtHMS(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Година:хвилина з ISO — для екранів, де час треба показати, а не рахувати. */
function hhmmOf(iso: string) {
  return new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

export function RoadTimesheet({
  onBack,
  onSaved,
  onOpenRetro,
  isAdmin = false,
  myPib = "",
}: {
  onBack: () => void;
  onSaved: () => void;
  onOpenRetro: () => void;
  isAdmin?: boolean;
  /** ПІБ з аркуша КОРИСТУВАЧІ — щоб підписати власний рядок у списках. */
  myPib?: string;
}) {
  // INDEX, not HUB: the hub is the builder for ONE trip, and landing straight
  // in it hid both the day's other trips and the planned ones.
  const [step, setStep] = useState<Step>("INDEX");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [date, setDate] = useState(() => todayISO());
  // Повернені на редагування дні за БУДЬ-ЯКУ дату. Усе інше на цьому екрані
  // живе однією датою (сьогодні), тож повернений день, внесений заднім
  // числом, не мав де показатись -- бригадир отримував повідомлення й не мав
  // куди натиснути.
  const [returnedDays, setReturnedDays] = useState<Array<{ date: string; reason: string | null; trips: number }>>([]);

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
  // Яка робота зараз відкрита для призначення людей (лише одна за раз).
  const [expandedWorkSubcategoryId, setExpandedWorkSubcategoryId] = useState<string | null>(null);
  const [selectedWorksExpanded, setSelectedWorksExpanded] = useState(false);
  const [planVolumeWorkId, setPlanVolumeWorkId] = useState<string | null>(null);
  const [volumeBuffer, setVolumeBuffer] = useState("");
  const [bulkVolumeInput, setBulkVolumeInput] = useState<string | null>(null);

  // --- pre-departure review (READY) ---
  const [editReturnStep, setEditReturnStep] = useState<Step>("HUB");
  const [worksReturnStep, setWorksReturnStep] = useState<Step>("PLAN");
  /**
   * Яким був список робіт, коли зайшли в пікер.
   *
   * Пікер живий: кожен тап одразу міняє день, а «Готово» лише веде назад.
   * Тож вихід через «‹ Назад» лишав зміни й нічого не питав -- бригадир
   * вийшла з семи випадково доданих робіт і побачила їх аж на здачі.
   * Тепер вихід назад зі зміненим списком питає, що з ним робити.
   */
  const [worksBeforePicker, setWorksBeforePicker] = useState<PlannedWork[] | null>(null);

  /** Єдиний вхід у пікер робіт: запамʼятовує список, щоб було що відкотити. */
  function openWorksPicker(objectId: string, returnTo: Step) {
    setPlanObjectId(objectId);
    setWorksReturnStep(returnTo);
    setWorksBeforePicker(planFor(objectId).works);
    setStep("PLAN_WORKS");
  }

  /**
   * Вихід із пікера через «‹ Назад».
   *
   * «Готово» — це «так, я обрав». А «Назад» люди тиснуть і коли передумали,
   * і коли просто виходять, і коли не розуміють, що встигли натикати. Тож
   * якщо список змінився — питаємо прямо, показуючи БУЛО і СТАЛО. Третій
   * вихід («Лишитись у списку») потрібен, щоб змах по попапу нічого не
   * вирішував: із двох кнопок закриття вікна означало б відкат.
   */
  async function leaveWorksPicker() {
    const before = worksBeforePicker;
    const objectId = planObjectId;
    if (!before || !objectId) {
      setWorksBeforePicker(null);
      setStep(worksReturnStep);
      return;
    }
    const now = planFor(objectId).works;
    const same = now.length === before.length && now.every((w) => before.some((b) => b.workId === w.workId));
    if (!same) {
      const answer = await ask3Dialog(
        `Список робіт на «${planFor(objectId).objectName}» змінився.\n\n` +
          `Було: ${before.length} · Стало: ${now.length}\n\n` +
          `Зберегти зміни чи повернути як було?`,
        "Зберегти",
        "Скасувати зміни",
        "Лишитись у списку",
        "Список робіт змінено",
      );
      if (answer === "cancel") return;
      if (answer === "b") {
        setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: before })));
        logChange(`${planFor(objectId).objectName}: зміни в списку робіт скасовано (лишилось ${before.length})`);
        haptic("warning");
      }
    }
    setWorksBeforePicker(null);
    setStep(worksReturnStep);
  }
  const [readyPeopleExpanded, setReadyPeopleExpanded] = useState(false);
  const [readyExpandedObjectId, setReadyExpandedObjectId] = useState<string | null>(null);

  // --- payroll coefficients (day-wide, applied to every object) ---
  const [coefs, setCoefs] = useState<Record<string, CoefPair>>({});
  const [expandedCoefEmployeeId, setExpandedCoefEmployeeId] = useState<string | null>(null);
  const [expandedReviewObjectId, setExpandedReviewObjectId] = useState<string | null>(null);
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
  // Which object the car is currently driving to. Chosen when leaving, and
  // again after each object, so "Прибув" knows where it arrived instead of
  // asking afterwards -- and so the screen can name a real destination
  // rather than guessing at the first unvisited object in the list.
  const [headingToObjectId, setHeadingToObjectId] = useState<string>("");
  const [arrivedPickedExpanded, setArrivedPickedExpanded] = useState(true);
  // Plans now come from the server, so a plan made by one brigadier is visible
  // to the rest (that is what the pickers' "already planned" badge reads).
  const [tripPlans, setTripPlans] = useState<TripPlan[]>([]);
  const [foremen, setForemen] = useState<Foreman[]>([]);
  // null while creating a plan, the plan's id while editing an existing one.
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  // Admin only: whose plan this is. Empty means "mine".
  const [planForemanTgId, setPlanForemanTgId] = useState<number | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  // The day set aside while the planner is using the pickers. Non-null only in
  // plan mode; putting it back is what "exit the planner" means.
  const [dayStash, setDayStash] = useState<BuilderSnapshot | null>(null);
  // Дата поверненого дня, який зараз правиться замість сьогоднішнього.
  // Сьогоднішній день при цьому лежить у dayStash -- той самий механізм, що й
  // для планувальника: правка чужої дати не має коштувати дня, який іде.
  const [fixingReturnedDate, setFixingReturnedDate] = useState<string | null>(null);
  /** Повідомлення після повторної відправки виправленого дня. */
  const [fixedDayNotice, setFixedDayNotice] = useState<string | null>(null);
  const [plannedResources, setPlannedResources] = useState<PlannedResources>({ cars: [], employees: [] });
  // A parked plan is edited by loading it back into the ordinary pickers --
  // there is no second builder. This flag is what tells the day apart from the
  // plan while that is happening: no reservations are taken, and "Запланувати"
  // saves back over the plan instead of making another one.
  const [planEditing, setPlanEditing] = useState(false);
  // Which object the car is parked at, if any. Not the same as "this screen
  // is open on an object": the foreman can switch the screen to another
  // object to fix its works while the car stays where it is.
  const [carAtObjectId, setCarAtObjectId] = useState<string>("");
  const [arrivedPickerOpen, setArrivedPickerOpen] = useState(false);
  const [coefsExpanded, setCoefsExpanded] = useState(false);
  // Which person's "assign works to just them" panel is open, if any -- the
  // same assignment the work list offers, reached from the person instead.
  const [assigningPersonId, setAssigningPersonId] = useState<string | null>(null);
  // Чия картка на обʼєкті зараз розгорнута. Згорнуто -- видно імʼя, години і
  // Старт/Стоп; решта дій ховається, бо їх торкаються раз на день, а місце
  // на екрані вони їли в кожного.
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null);
  // Які групи людей на обʼєкті розгорнуті («окремі роботи» / «роботи бригади»).
  const [openPeopleGroups, setOpenPeopleGroups] = useState<Record<string, boolean>>({});
  const [atObjectReturnStep, setAtObjectReturnStep] = useState<Step>("DRIVE");
  /**
   * Правимо день, який уже дійшов до підсумку (зокрема повернений адміном).
   *
   * Сюди потрапляють через «👥 Змінити людей» / «🕒 Змінити години» на екрані
   * підсумку — вони й ставлять `atObjectReturnStep = "REVIEW"`. Відрізняти це
   * від живого дня обовʼязково: на обʼєкті вже нікого не «стоїть», людей
   * забрали, сесії закриті, тож перевірки на кшталт «чи є хтось тут» тут
   * означають зовсім не те, для чого їх писали.
   */
  const reviewFixMode = atObjectReturnStep === "REVIEW";
  const [atObjectDetailsExpanded, setAtObjectDetailsExpanded] = useState(false);
  const [volumesReturnStep, setVolumesReturnStep] = useState<Step>("AT_OBJECT");
  /**
   * Бригада їде на базу, а хтось лишається дороблювати.
   *
   * Звичайний хід дня, якого в застосунку не було зовсім: з трьох обʼєктів
   * один робітник лишився на першому, ще один (той, що приїхав сам) -- на
   * другому, решта сіли в бус і поїхали. Забирати їх не треба: доробить і
   * піде сам. Але екран повернення показував «▶️ Рушили на базу» ЛИШЕ коли
   * на обʼєктах не лишилось нікого, тож день упирався в глухий кут -- або
   * їдь по людину, яка ще працює, або нікуди не їдь.
   *
   * Прапорець вмикає сам бригадир відповіддю «🏠 Ні, їдемо на базу». Він не
   * закриває нікому годин: люди далі числяться на обʼєктах, працюють, і
   * бригадир зупиняє їх тоді, коли вони справді закінчать. До того звіт не
   * відправляється (див. перевірку у `save()`).
   */
  const [goingHomeWithoutThem, setGoingHomeWithoutThem] = useState(false);
  const [expandedReturnObjectId, setExpandedReturnObjectId] = useState<string | null>(null);
  const [expandedReturnPickupObjectId, setExpandedReturnPickupObjectId] = useState<string | null>(null);
  const [dropSelected, setDropSelected] = useState<string[]>([]);
  /**
   * Чи натиснув бригадир «Підтвердити», нікого не обравши.
   *
   * 07.09 бригадир чотири рази відкривав висадку і писав, що «не може
   * висадити себе». У бусі він був сам, його рядок на екрані був -- але
   * рядок не читався як те, на що треба натиснути, а «Підтвердити» був
   * `disabled` і виглядав при цьому як звичайна активна синя кнопка. Тап у
   * неї не давав НІЧОГО: ні дії, ні пояснення. Мовчання кнопки і є те, що
   * людина називає «не працює».
   */
  const [dropEmptyHint, setDropEmptyHint] = useState(false);
  const [showDropPicker, setShowDropPicker] = useState(false);
  const [moveSelected, setMoveSelected] = useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);
  // "walk" -- людина справді відпрацювала тут і пішки перейшла на сусідній
  // обʼєкт: години лишаються тут, там починається нова робота. "fix" -- її
  // тут узагалі не було, це виправлення помилки.
  const [moveMode, setMoveMode] = useState<"walk" | "fix">("walk");
  // Додавання людини на обʼєкт посеред дня. `arrival` -- як вона тут
  // опинилась: бусом (іде в поділ доплати за виїзд) чи своїм ходом (не йде).
  // Досі це питання ніхто не ставив -- єдиний шлях додати людину мовчки
  // позначав її «приїхав сам» і забирав доплату.
  const [showAddPersonPicker, setShowAddPersonPicker] = useState(false);
  const [addPersonSelected, setAddPersonSelected] = useState<string[]>([]);
  const [addPersonArrival, setAddPersonArrival] = useState<"bus" | "own">("bus");
  // З якого часу рахувати години доданій людині. Свідомо БЕЗ значення за
  // замовчуванням: обидві відповіді правдоподібні, і кожна прямо міняє гроші.
  // Дефолт «як бригада» вже коштував дня 08.09 -- бригадир додав пʼятьох, які
  // щойно приїхали, і всім підтягнулись його 39 хвилин.
  /** Чи змінювали день після останньої вдалої відправки (див. logChange). */
  const [changedSinceSave, setChangedSinceSave] = useState(false);
  const [addPersonStart, setAddPersonStart] = useState<"crew" | "now" | null>(null);
  const [addPersonStartHint, setAddPersonStartHint] = useState(false);
  const [addPersonSearch, setAddPersonSearch] = useState("");
  const [expandedAddBrigadeId, setExpandedAddBrigadeId] = useState<string | null>(null);
  // Меню «Редагувати людей» на екрані обʼєкта -- згорнуте, бо всі три дії
  // всередині трапляються рідко, а місце вгорі їли постійно.
  const [peopleMenuOpen, setPeopleMenuOpen] = useState(false);
  // Manual hours fallback: if the foreman forgot to start the timer for
  // someone, they can type the worked hours in directly here. showManualHours
  // opens the per-person list; manualHoursEmployeeId + manualHoursBuffer drive
  // the keypad for the one person being edited.
  const [showManualHours, setShowManualHours] = useState(false);
  const [manualHoursEmployeeId, setManualHoursEmployeeId] = useState<string | null>(null);
  const [manualHoursBuffer, setManualHoursBuffer] = useState("");
  // "Машина вибула по справам": errands is day-level (one open at a time --
  // odoBack null). errandMode drives the start (pick driver + odoOut) and
  // return (odoBack) sub-screens on AT_OBJECT.
  const [errands, setErrands] = useState<Errand[]>([]);
  const [errandMode, setErrandMode] = useState<null | "start" | "return">(null);
  const [errandDriverId, setErrandDriverId] = useState<string | null>(null);
  const [errandOdoBuffer, setErrandOdoBuffer] = useState("");
  // Never carry an open manual-hours / errand editor from one object to the
  // next, whichever way the object changes (arrive, switch, or an ✏️ edit).
  useEffect(() => {
    setShowManualHours(false);
    setManualHoursEmployeeId(null);
    setErrandMode(null);
    setErrandDriverId(null);
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
  // Kept apart from lastTrip on purpose: the suggestion card can be dismissed
  // (or consumed by applying it), but "this is the car you drove last time"
  // stays true either way and keeps ordering the picker.
  const [lastTripCarId, setLastTripCarId] = useState<string>("");
  const [lastTripExpanded, setLastTripExpanded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearErrorOnSuccess(setError);
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [submittedTrips, setSubmittedTrips] = useState<SubmittedTrip[]>([]);
  /**
   * Чи можна показувати бригадиру гроші.
   *
   * Відсоток від робітничої частини — це теж гроші: разом із фондом обʼєкта він
   * прямо дає суму, а фонд у звіті видно. Тому «12.26 год · 50%» на підсумку
   * ховається за тим самим правилом, що й самі суми.
   */
  const dayApproved = submittedTrips.length > 0 && submittedTrips.every((t) => t.status === "ЗАТВЕРДЖЕНО");
  const [dayCombined, setDayCombined] = useState<DayCombined | null>(null);
  const [editingTripSeq, setEditingTripSeq] = useState<number | null>(null);
  const [inProgressResumeStep, setInProgressResumeStep] = useState<Step | null>(null);
  const [expandedTripSeq, setExpandedTripSeq] = useState<number | null>(null);

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
        if (res.found) {
          setLastTrip({ date: res.date, carId: res.carId ?? "", employeeIds: res.employeeIds, objects: res.objects });
          setLastTripCarId(res.carId ?? "");
        }
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
    // A stashed day counts as content on its own: the builder may be holding a
    // half-written plan (or nothing) while the real trip sits in the stash.
    const stash = draft?.dayStash ?? null;
    const hasContent =
      !!draft &&
      (!!draft.carId ||
        draft.employeeIds.length > 0 ||
        draft.plans.length > 0 ||
        !!draft.tripStartedAt ||
        !!stash?.carId ||
        (stash?.employeeIds.length ?? 0) > 0 ||
        (stash?.plans.length ?? 0) > 0 ||
        !!stash?.tripStartedAt);
    if (draft && hasContent && draft.step !== "DONE") {
      // The draft keeps its own date ONLY once the trip has actually departed.
      // That is the night-shift case this was written for: left at 23:00, app
      // reopened at 01:30, still the same unfinished day.
      //
      // A draft that never departed has no day of its own. It used to take its
      // date anyway, and that is how an evening spent picking a car and people
      // (or opening a plan an admin had just made) put the WHOLE of the next
      // day's work onto yesterday: the draft lives ~20h, so an 18:00 draft is
      // still there at 08:00, and everything from then on was stamped with
      // yesterday. Nothing on screen said so.
      if (draft.tripStartedAt && draft.date !== date) setDate(draft.date);
      setCarId(draft.carId);
      setOdoStart(draft.odoStart);
      setOdoStartPhoto(draft.odoStartPhoto);
      setOdoEnd(draft.odoEnd);
      setOdoEndPhoto(draft.odoEndPhoto);
      setEmployeeIds(draft.employeeIds);
      setSelfTransportIds(draft.selfTransportIds ?? []);
      setErrands(draft.errands ?? []);
      setPlans((draft.plans ?? []).map(normalizeDraftPlan));
      setOnboard(draft.onboard);
      setTripStartedAt(draft.tripStartedAt);
      setDrivingAccumulatedMs(draft.drivingAccumulatedMs ?? 0);
      setDrivingSegmentStartedAt(draft.drivingSegmentStartedAt ?? null);
      setAtObjectId(draft.atObjectId);
      setHeadingToObjectId(draft.headingToObjectId ?? "");
      setCarAtObjectId(draft.carAtObjectId ?? "");
      setAtObjectReturnStep(draft.atObjectReturnStep ?? "DRIVE");
      setPlanObjectId(draft.planObjectId ?? null);
      setVolumesReturnStep(draft.volumesReturnStep ?? "AT_OBJECT");
      setWorksBeforePicker(draft.worksBeforePicker ?? null);
      setGoingHomeWithoutThem(!!draft.goingHomeWithoutThem);
      setCoefs(draft.coefs ?? {});
      setEditingTripSeq(draft.editingTripSeq ?? null);
      if (draft.fixingReturnedDate && stash) {
        // Застосунок помер під час правки поверненого дня. Той день лежить на
        // сервері й нікуди не дінеться -- а день, що йшов, живе тільки тут.
        // Тож повертаємо його, а виправлення бригадир відкриє заново.
        restoreBuilder(stash);
        setDayStash(null);
        setFixingReturnedDate(null);
        setStep(stash.tripStartedAt ? stash.step : "INDEX");
        setRestoredBanner(true);
        draftRestoredRef.current = true;
        return;
      }
      setFixingReturnedDate(draft.fixingReturnedDate ?? null);
      if (draft.planEditing) {
        // The app died with the planner open. A half-written plan is five
        // minutes of re-picking; the trip underneath it is a day's work, so
        // the stash wins and plan mode is dropped.
        if (stash) restoreBuilder(stash);
        else blankBuilder();
        setPlanEditing(false);
        setEditingPlanId(null);
        setPlanForemanTgId(null);
        setDayStash(null);
        setStep(stash?.tripStartedAt ? stash.step : "INDEX");
        setRestoredBanner(true);
        draftRestoredRef.current = true;
        return;
      }
      // Only a real trip step is worth resuming to. INDEX/HUB/DONE are the
      // screens the resume button lives on, so storing one of them turns that
      // button into a no-op.
      setInProgressResumeStep(draft.step === "INDEX" || draft.step === "HUB" ? null : draft.step);
      // A trip that has DEPARTED resumes exactly where it was -- the foreman
      // reopening the app between two objects wants the object screen, not a
      // menu. A setup that never left the yard goes to the index instead, so
      // the day's other trips and the planned ones are not hidden behind it;
      // "▶️ Продовжити" there returns to this very step.
      // A draft saved mid-planning reopens INSIDE the planner. Dropping it on
      // the index instead left plan mode switched on with no planner on
      // screen: "створити нову" then refused because the builder held the
      // plan, and the card that would have led back into it hid itself for
      // exactly the same reason. Closing the app while planning is enough to
      // get there -- no handler runs, so nothing turns plan mode off.
      // Бригада працює, а екран каже «повертаємось». Так буває, бо обʼєкт
      // вважається відвіданим щойно там висадили людей, і застосунок вирішує,
      // що маршрут пройдено. Бригадир при цьому нікуди не їде: бус стоїть на
      // тому ж обʼєкті, де йдуть роботи.
      //
      // d56275d виправив це для кнопки «↩️ Повернутися до поїздки», але
      // перезавантаження відновлює збережений крок як є, тож той самий екран
      // повертався знову — і виходило, що фікс нічого не змінив.
      //
      // Умови навмисно вузькі: бус стоїть на обʼєкті, нікуди не прямує, там
      // є люди І відкрита робоча сесія. Без сесії це збирання людей по дорозі
      // на базу — туди повертати не можна.
      const parkedPlan = draft.carAtObjectId
        ? (draft.plans ?? []).map(normalizeDraftPlan).find((p) => p.objectId === draft.carAtObjectId)
        : undefined;
      const crewWorkingAtCar =
        !!parkedPlan &&
        !draft.headingToObjectId &&
        parkedPlan.here.length > 0 &&
        parkedPlan.sessions.some((s) => !s.endedAt);
      const isReturnStep = draft.step === "DRIVE" || draft.step === "RETURN_PICKUP" || draft.step === "RETURN";
      if (crewWorkingAtCar && isReturnStep) {
        setAtObjectId(parkedPlan!.objectId);
        setAtObjectReturnStep("DRIVE");
        setInProgressResumeStep("AT_OBJECT");
        setStep("AT_OBJECT");
      } else {
        setStep(draft.planEditing || draft.tripStartedAt ? draft.step : "INDEX");
      }
      setRestoredBanner(true);
      draftRestoredRef.current = true;
    } else {
      if (draft) clearDraft();
      // На телефоні порожньо. Якщо сервер тримає дзеркало -- пропонуємо
      // підняти: новий телефон, почищений кеш, перевстановлений Telegram. До
      // цього такий день не відновлювався нізвідки, бо не існував поза одним
      // пристроєм.
      fetchMirroredDraft<DraftShape>().then(async (mirrored) => {
        if (!mirrored || draftRestoredRef.current) return;
        const d = mirrored.payload;
        const hasWork = !!d.carId || d.employeeIds.length > 0 || d.plans.length > 0;
        if (!hasWork) return;
        // Другий рубіж проти задвоєної поїздки. Дзеркало може пережити здачу
        // (гонка з відкладеним знімком -- див. clearMirroredDraft), і тоді
        // воно описує день, який УЖЕ в базі. Підняти його означає отримати
        // конструктор без editingTripSeq, тобто кнопку «Відправити на
        // підтвердження» замість «Оновити звіт»: один тап -- і в дні дві
        // поїздки з тими самими сесіями, а mergeObjects складе їхні години й
        // обсяги. Саме так 08.09 у звіті вийшло по 15.91 год на людину.
        //
        // Повернений день -- виняток: його для того й повернули, щоб правити.
        try {
          const st = await api.get<DayStatus>(`/api/road-timesheet/day-status?date=${d.date}`);
          if (st.hasSubmission && !st.returned) {
            clearMirroredDraft();
            return;
          }
        } catch {
          // Статус не дістали -- нехай вирішує людина, як і до цього.
        }
        const when = new Date(mirrored.updatedAt).toLocaleString("uk-UA", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
        if (!(await confirmDialog(`На цьому телефоні незавершеного дня немає, але на сервері є — від ${when} (${d.date}).\n\nВідновити його?`))) return;
        restoreBuilder({
          carId: d.carId,
          odoStart: d.odoStart,
          odoStartPhoto: d.odoStartPhoto,
          odoEnd: d.odoEnd,
          odoEndPhoto: d.odoEndPhoto,
          employeeIds: d.employeeIds,
          selfTransportIds: d.selfTransportIds ?? [],
          errands: d.errands ?? [],
          plans: d.plans,
          onboard: d.onboard,
          tripStartedAt: d.tripStartedAt,
          drivingAccumulatedMs: d.drivingAccumulatedMs,
          drivingSegmentStartedAt: d.drivingSegmentStartedAt,
          atObjectId: d.atObjectId,
          headingToObjectId: d.headingToObjectId ?? "",
          carAtObjectId: d.carAtObjectId ?? "",
          atObjectReturnStep: d.atObjectReturnStep,
          planObjectId: d.planObjectId,
          coefs: d.coefs,
          editingTripSeq: d.editingTripSeq,
          changeLog: [],
          step: d.step,
        });
        setDate(d.date);
        setStep(d.tripStartedAt ? d.step : "INDEX");
        draftRestoredRef.current = true;
        logChange("День відновлено з сервера");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tells the server roughly where the brigade is, so an admin can watch a day
  // that has not been submitted yet -- until RTS_SAVE the server knows only
  // that a car was taken. One effect on the transitions that matter rather
  // than calls scattered through the flow, and fire-and-forget: a failed
  // report is a stale admin screen, never a broken day.
  // Що востаннє реально пішло на сервер: `${state}|${object}`.
  const lastProgressRef = useRef("");
  useEffect(() => {
    api
      .get<{ days: Array<{ date: string; reason: string | null; trips: number }> }>("/api/road-timesheet/returned-days")
      .then((r) => setReturnedDays(r.days ?? []))
      .catch(() => setReturnedDays([]));
  }, [date, dayStatus?.returned]);

  const atObjectPlan = atObjectId ? plans.find((p) => p.objectId === atObjectId) : null;
  const headingName = headingToObjectId ? (plans.find((p) => p.objectId === headingToObjectId)?.objectName ?? "") : "";
  // Standing at an object is not one screen. The foreman opens the works
  // list, the volumes, the object's plan -- all without going anywhere. Those
  // steps used to fall through to the DRIVING default, so an afternoon of
  // filling in works stamped "в дорозі" and "почали роботи" alternately every
  // few seconds and buried the real checkpoints.
  const atObjectSteps: Step[] = ["AT_OBJECT", "PLAN", "PLAN_WORKS", "PLAN_VOLUMES"];
  const standingAtObject = !!atObjectId && atObjectSteps.includes(step);
  // Work running anywhere beats whatever screen is open: it is a fact about
  // the brigade, not about the phone.
  const workingPlan = plans.find((p) => p.sessions.some((x) => !x.endedAt));
  // Порядок тут вирішує все. Коментар вище каже, що відкрита робота б'є
  // будь-який екран -- але перевірка екранів повернення стояла ПЕРШОЮ, тож
  // бригадир, який дивився на екран повернення, поки бригада працює, давав
  // то RETURNING (з екрана), то WORKING (з факту). Обидва по черзі проходили
  // серверний захист «не писати те саме двічі» -- і стрічка адміна
  // перетворювалась на «повертаються / почали роботи» по колу.
  //
  // Відкрита сесія тепер справді перемагає. Виняток один -- REVIEW: там день
  // уже зданий на перевірку, і сесій там не буває.
  const progressState = !tripStartedAt
    ? ""
    : step === "REVIEW"
      ? "AT_BASE"
      : workingPlan
        ? "WORKING"
        : step === "RETURN" || step === "RETURN_PICKUP"
          ? "RETURNING"
          : standingAtObject
            ? "AT_OBJECT"
            : "DRIVING";
  // Обʼєкт для стрічки адміна беремо від машини, а не від того, що відкрито
  // на екрані: нижній список -- навігатор, і бригадир ходить ним по обʼєктах,
  // просто щоб бачити обстановку. Поки об'єкт брався з `atObjectId`, кожен
  // такий перегляд переписував адміну «де бригада». На відкритий обʼєкт
  // падаємо лише тоді, коли машини немає на жодному (їде дорогою, а картку
  // обʼєкта попереду відкрили заради тих, хто дістався туди своїм ходом).
  const carPlanName = carAtObjectId ? plans.find((p) => p.objectId === carAtObjectId)?.objectName : "";
  const progressObject = workingPlan
    ? workingPlan.objectName
    : standingAtObject
      ? (carPlanName || atObjectPlan?.objectName || "")
      : headingName;

  // Журнал дій. Тимчасово, на час обкатки: сам крок, на якому людина
  // перебуває, пояснює натискання краще за будь-який підпис кнопки.
  useEffect(() => {
    setTrackContext({ screen: "roadTimesheet", step });
  }, [step]);

  useEffect(() => {
    if (!progressState || planEditing || editingTripSeq !== null) return;
    // Report only what held still for a few seconds. Tapping through screens
    // passes through states nobody needs a dot for, and the admin's timeline
    // is meant to read as "where the brigade is", not as a tap log.
    const t = setTimeout(() => {
      // Другий захист, поруч із серверним: застосунок перемальовується й
      // перезапускається частіше, ніж бригада кудись рухається.
      const stamp = `${progressState}|${progressObject}`;
      if (stamp === lastProgressRef.current) return;
      lastProgressRef.current = stamp;
      api
        .post("/api/road-timesheet/progress", {
          date,
          state: progressState,
          objectName: progressObject,
          peopleCount: employeeIds.length,
        })
        .catch(() => {
          // Не дійшло -- нехай наступна зміна спробує ще раз.
          lastProgressRef.current = "";
        });
    }, 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, progressState, progressObject, planEditing, editingTripSeq]);

  // Keeps "resume where I left off" pointed at wherever the user ACTUALLY is,
  // not frozen at whatever step a draft happened to restore to on mount --
  // the day-status effect below can force step to "DONE" asynchronously
  // (e.g. once it learns today already has a submission), and without this
  // the "▶️ Продовжити" card on DONE would send the user back to a stale step
  // instead of the one they'd actually progressed to since mount.
  useEffect(() => {
    // INDEX is excluded for the same reason as HUB and DONE, and it is the one
    // that actually bit: INDEX is where the "▶️ Продовжити" card lives, so
    // recording it made that button set the step it was already on -- a tap
    // that did nothing at all.
    if (step !== "HUB" && step !== "DONE" && step !== "INDEX" && !planEditing) setInProgressResumeStep(step);
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

        // A returned day is the one case where the foreman has been asked to
        // do something specific, so drop them straight back into the same
        // editable state they had before submitting instead of the "sent for
        // approval" summary -- but only when there's exactly one trip to fix
        // and nothing else is in flight. With several returned trips there's
        // no single right one to open, and clobbering a restored draft for a
        // NEW trip would throw away work they haven't submitted yet.
        const returnedTrips = res.trips.filter((t) => t.status !== "ЗАТВЕРДЖЕНО");
        // Виняток -- режим правки поверненого дня: конструктор там свідомо
        // порожній (сьогоднішній день лежить у `dayStash`), тож відновлена
        // чернетка нічого не боронить, і поїздку треба відкрити одразу.
        if (status.returned && returnedTrips.length === 1 && (!draftRestoredRef.current || !!fixingReturnedDate)) {
          editTrip(returnedTrips[0]);
          return;
        }

        // Stay on the index: it lists today's trips as cards, so forcing the
        // day summary here would skip past the planned trips and the "new
        // trip" button the foreman came for.
      })
      .catch(() => setDayStatus({ hasSubmission: false, approved: false, returned: false, returnReason: null, eventId: null, editRequested: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    if (step === "DONE") return;
    const snapshot: DraftShape = {
      date,
      step,
      carId,
      odoStart,
      odoStartPhoto,
      odoEnd,
      odoEndPhoto,
      employeeIds,
      selfTransportIds,
      errands,
      plans,
      onboard,
      tripStartedAt,
      drivingAccumulatedMs,
      drivingSegmentStartedAt,
      atObjectId,
      headingToObjectId,
      carAtObjectId,
      atObjectReturnStep,
      planObjectId,
      volumesReturnStep,
      worksBeforePicker,
      goingHomeWithoutThem,
      coefs,
      editingTripSeq,
      planEditing,
      editingPlanId,
      planForemanTgId,
      dayStash,
      fixingReturnedDate,
    };
    saveDraft<DraftShape>(snapshot);
    // Те саме -- на сервер, із затримкою і фоном. Телефон лишається робочою
    // копією; це дзеркало, щоб незданий день не існував лише на одному
    // пристрої, як було з днем, що поїхав учорашньою датою.
    mirrorDraft({
      date,
      step,
      carId,
      employeeIds,
      objectNames: plans.map((p) => p.objectName),
      tripStartedAt,
      payload: snapshot,
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
    errands,
    plans,
    onboard,
    headingToObjectId,
    carAtObjectId,
    tripStartedAt,
    drivingAccumulatedMs,
    drivingSegmentStartedAt,
    atObjectId,
    atObjectReturnStep,
    planObjectId,
    volumesReturnStep,
    worksBeforePicker,
    goingHomeWithoutThem,
    coefs,
    editingTripSeq,
    planEditing,
    editingPlanId,
    planForemanTgId,
    dayStash,
    fixingReturnedDate,
  ]);

  function employeeName(id: string) {
    return employees.find((e) => e.id === id)?.name ?? id;
  }

  /**
   * Рядок цього бригадира в довіднику ПРАЦІВНИКИ, зіставлений по ПІБ — тим
   * самим правилом, що й на сервері (`resolveForemanEmployeeId`), бо спільного
   * id між КОРИСТУВАЧІ й ПРАЦІВНИКИ немає. Порожньо, якщо ПІБ не збігся: тоді
   * підпису «(Ви)» просто не буде, і це чесніше, ніж підписати не того.
   */
  const myEmployeeId = useMemo(() => findMyEmployeeId(employees, myPib), [employees, myPib]);



  function roleFor(id: string): EmployeeRole {
    const emp = employees.find((e) => e.id === id);
    return emp ? employeeRole(emp) : "робітник";
  }

  function logChange(label: string) {
    // Кожна змістовна зміна дня проходить тут, тож це і є найточніший сигнал
    // «у конструкторі є щось, чого немає в базі» -- ним користується
    // startNewTrip, щоб питати підтвердження лише коли є що втрачати.
    setChangedSinceSave(true);
    setChangeLog((prev) => [{ ts: Date.now(), label }, ...prev].slice(0, 100));
    // Той самий запис — і в журнал дій. Це найцінніші рядки в ньому: підпис
    // кнопки каже, що натиснули, а це — що з дня від того сталося.
    track("step", label, `date=${date}`);
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
  /** Our own plans, plus the ids that any plan has already claimed. */
  async function refreshPlans() {
    try {
      const res = await api.get<{ plans: TripPlan[]; plannedResources: PlannedResources }>("/api/trip-plans");
      setTripPlans(res.plans);
      setPlannedResources(res.plannedResources ?? { cars: [], employees: [] });
    } catch {
      // A plan list that fails to load must not block the day.
    }
  }

  useEffect(() => {
    refreshPlans();
    if (isAdmin) {
      api
        .get<{ foremen: Foreman[] }>("/api/trip-plans/foremen")
        .then((r) => setForemen(r.foremen))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  /**
   * Who has already planned this car / person.
   *
   * Built from plannedResources (every active plan, ids only), NOT from the
   * plan list -- that one is private to its owner, while a conflict has to be
   * visible to everybody. The plan being edited is skipped, or its own crew
   * would lock itself out the moment you reopened it.
   */
  const plannedCarBy = new Map<string, string>();
  const plannedEmployeeBy = new Map<string, string>();
  for (const c of plannedResources.cars) {
    if (c.planId === editingPlanId || plannedCarBy.has(c.carId)) continue;
    plannedCarBy.set(c.carId, c.foremanName);
  }
  for (const e of plannedResources.employees) {
    if (e.planId === editingPlanId || plannedEmployeeBy.has(e.employeeId)) continue;
    plannedEmployeeBy.set(e.employeeId, e.foremanName);
  }

  async function reserveIfPossible(): Promise<boolean> {
    // A plan is an intention, not a claim (see lib/tripPlan.ts). Editing one
    // must not hold today's bus or crew for a trip that has not started.
    if (planEditing) return true;
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

  /** Everything the builder currently holds, as one value. */
  function snapshotBuilder(): BuilderSnapshot {
    return {
      date,
      step,
      carId,
      odoStart,
      odoStartPhoto,
      odoEnd,
      odoEndPhoto,
      employeeIds,
      selfTransportIds,
      errands,
      plans,
      onboard,
      tripStartedAt,
      drivingAccumulatedMs,
      drivingSegmentStartedAt,
      atObjectId,
      headingToObjectId,
      carAtObjectId,
      atObjectReturnStep,
      planObjectId,
      coefs,
      editingTripSeq,
      changeLog,
    };
  }

  /**
   * Blanks the builder WITHOUT releasing anything server-side.
   *
   * releaseAndClearDay hands the car and the crew back, which is right when a
   * trip is being thrown away and wrong when it is only being set aside for a
   * minute while the planner borrows the screen.
   */
  function blankBuilder() {
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setSelfTransportIds([]);
    setErrands([]);
    setErrandMode(null);
    setPlans([]);
    setCoefs({});
    setOnboard([]);
    setTripStartedAt(null);
    setDrivingAccumulatedMs(0);
    setDrivingSegmentStartedAt(null);
    setAtObjectId(null);
    setHeadingToObjectId("");
    setCarAtObjectId("");
    setAtObjectReturnStep("DRIVE");
    setPlanObjectId(null);
    setWorksBeforePicker(null);
    setGoingHomeWithoutThem(false);
    setChangeLog([]);
    setEditingTripSeq(null);
    setPreview(null);
  }

  function restoreBuilder(snap: BuilderSnapshot) {
    if (snap.date) setDate(snap.date);
    setCarId(snap.carId);
    setOdoStart(snap.odoStart);
    setOdoStartPhoto(snap.odoStartPhoto);
    setOdoEnd(snap.odoEnd);
    setOdoEndPhoto(snap.odoEndPhoto);
    setEmployeeIds(snap.employeeIds);
    setSelfTransportIds(snap.selfTransportIds);
    setErrands(snap.errands);
    setPlans(snap.plans);
    setOnboard(snap.onboard);
    setTripStartedAt(snap.tripStartedAt);
    setDrivingAccumulatedMs(snap.drivingAccumulatedMs);
    setDrivingSegmentStartedAt(snap.drivingSegmentStartedAt);
    setAtObjectId(snap.atObjectId);
    setHeadingToObjectId(snap.headingToObjectId);
    setCarAtObjectId(snap.carAtObjectId);
    setAtObjectReturnStep(snap.atObjectReturnStep);
    setPlanObjectId(snap.planObjectId);
    setCoefs(snap.coefs);
    setEditingTripSeq(snap.editingTripSeq);
    setChangeLog(snap.changeLog);
    setInProgressResumeStep(snap.step === "HUB" || snap.step === "INDEX" || snap.step === "DONE" ? null : snap.step);
  }

  async function releaseAndClearDay() {
    if (carId || employeeIds.length) {
      try {
        await api.post("/api/road-timesheet/reserve/release", {
          date,
          carId: carId || undefined,
          employeeIds: employeeIds.length ? employeeIds : undefined,
        });
      } catch {
        // best-effort -- clearing the local draft must not be blocked by a network hiccup
      }
    }
    clearDraft();
    clearMirroredDraft();
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setSelfTransportIds([]);
    setErrands([]);
    setErrandMode(null);
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
    setPlanEditing(false);
    setEditingPlanId(null);
    setPlanForemanTgId(null);
    setDayStash(null);
    // INDEX, не HUB. Скидання лишало бригадира в конструкторі порожньої
    // поїздки -- екрані, де не видно ні зданих поїздок дня, ні того, що
    // взагалі щось скинулось. 08.09 Дуб Василь натиснув «🗑 Скинути
    // незавершене» ТРИЧІ поспіль: кожен тап відкривав збирання нової
    // поїздки, і виглядало це рівно як «кнопка не працює». Та сама причина,
    // через яку початковим кроком колись зробили INDEX (див. useState вище).
    setStep("INDEX");
  }

  /**
   * Throws away the trip being built or driven and starts it over.
   *
   * Scoped to the trip, not the day: trips already sent stay exactly as they
   * are (a sent report is deleted by the admin, never from here). It used to
   * be labelled "скинути день", which read as if it wiped everything.
   */
  async function resetTrip() {
    // While a plan is open in the pickers there is no trip to reset -- the
    // same button means "drop the edits".
    if (planEditing) return cancelPlanEdit();
    const confirmed = await confirmDialog(
      tripStartedAt
        ? "Скинути поточну поїздку?\n\nПоїздка вже почалась — години з таймерів, обʼєкти й роботи буде втрачено безповоротно. Уже відправлені поїздки цього дня лишаться на місці."
        : "Скинути поточну поїздку?\n\nАвто, люди, обʼєкти й роботи з цього екрана буде очищено, резерви звільнено. Уже відправлені поїздки цього дня лишаться на місці.",
    );
    if (!confirmed) return;
    await releaseAndClearDay();
    haptic("success");
  }

  /** The builder's current contents, in the shape the plan endpoint stores. */
  function currentPlanObjects(): PlanObject[] {
    return plans.map((p) => ({
      objectId: p.objectId,
      objectName: p.objectName,
      works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, unit: w.unit })),
    }));
  }

  /**
   * Writes the setup on screen back as a plan (new one, or the one being
   * edited) and leaves plan mode.
   *
   * Planning reuses the trip builder rather than growing a second set of
   * pickers -- picking a car and a crew is the same work whether it is for now
   * or for tomorrow. What plan mode changes is that nothing is reserved and
   * that saving goes to /api/trip-plans instead of the day.
   */
  async function savePlan() {
    if (!carId && !employeeIds.length && !plans.length) {
      setError("Порожній план — оберіть авто, людей або обʼєкт.");
      return;
    }
    const body = {
      carId,
      employeeIds,
      objects: currentPlanObjects(),
      ...(isAdmin && planForemanTgId ? { foremanTgId: planForemanTgId } : {}),
    };
    try {
      if (editingPlanId) await api.put(`/api/trip-plans/${editingPlanId}`, body);
      else await api.post("/api/trip-plans", body);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    await refreshPlans();
    haptic("success");
    exitPlanner();
  }

  /**
   * Opens the planner: the ordinary pickers, with nothing reserved.
   *
   * Works at ANY time, mid-trip included. Planning is a draft for another day,
   * so it has no business demanding that today be finished first -- the whole
   * point is to fill tomorrow in while there is a spare minute. The day being
   * built or driven is set aside in `dayStash` and put back on the way out.
   */
  function openPlanner(plan: TripPlan | null) {
    if (!planEditing) setDayStash(snapshotBuilder());
    blankBuilder();
    setEditingPlanId(plan?.id ?? null);
    setPlanForemanTgId(plan && isAdmin && !plan.mine ? plan.foremanTgId : null);
    if (plan) applyPlanToBuilder(plan, { withOdometer: false });
    setPlanEditing(true);
    setStep("HUB");
    haptic("selection");
  }

  /**
   * Відкрити повернений день іншої дати, не втративши той, що йде зараз.
   *
   * Прямий `setDate` тут не годиться: конструктор дня один на весь екран, і
   * редагування поверненої поїздки затирає карту, людей і таймери
   * сьогоднішнього дня, а автозбереження одразу пише це в чернетку -- разом з
   * чужою датою. Тому той самий прийом, що й у планувальника: сьогоднішній
   * день відкладається в `dayStash` (тепер разом зі своєю датою) і чекає.
   */
  function openReturnedDay(target: string) {
    setFixedDayNotice(null);
    if (!fixingReturnedDate) setDayStash(snapshotBuilder());
    blankBuilder();
    setFixingReturnedDate(target);
    setDate(target);
    setStep("INDEX");
    haptic("selection");
  }

  /** Повернутись до свого дня: віддати конструктор назад тому, хто його ждав. */
  function exitReturnedDay() {
    if (dayStash) restoreBuilder(dayStash);
    else {
      blankBuilder();
      setDate(todayISO());
    }
    setDayStash(null);
    setFixingReturnedDate(null);
    setStep("INDEX");
    haptic("selection");
  }

  /** Puts the day back exactly as it was and leaves plan mode. */
  function exitPlanner() {
    if (dayStash) restoreBuilder(dayStash);
    else blankBuilder();
    setDayStash(null);
    setPlanEditing(false);
    setEditingPlanId(null);
    setPlanForemanTgId(null);
    setStep("INDEX");
  }

  async function cancelPlanEdit() {
    const dirty = !!carId || employeeIds.length > 0 || plans.length > 0;
    if (dirty && !(await confirmDialog("Вийти без збереження? Незбережені зміни плану буде втрачено."))) return;
    exitPlanner();
  }

  async function deletePlan(plan: TripPlan) {
    if (!(await confirmDialog(`Прибрати запланований виїзд?\n\n${plan.carName || "без авто"} · ${nObjects(plan.objects.length)}`))) return;
    try {
      await api.del(`/api/trip-plans/${plan.id}`);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    await refreshPlans();
    haptic("success");
  }

  /** Loads a plan into the builder. Shared by "use it now" and "edit it". */
  function applyPlanToBuilder(plan: TripPlan, opts: { withOdometer: boolean }) {
    setCarId(plan.carId);
    if (opts.withOdometer) {
      // The reading the car came back with last time is what this day starts
      // from -- the whole point of planning is not typing it again at 7am.
      const last = lastOdometer[plan.carId];
      setOdoStart(last !== undefined ? String(last) : "");
    }
    setEmployeeIds(plan.employeeIds);
    setPlans(
      plan.objects.map((o) => ({
        objectId: o.objectId,
        objectName: o.objectName,
        works: o.works.map((w) => ({ workId: w.workId, workName: w.workName, unit: w.unit ?? "шт", volume: "" })),
        assignedEmployeeIds: [],
        here: [],
        sessions: [],
        visited: false,
        notes: "",
        photoUrls: [],
      })),
    );
  }

  /** Turns a planned trip into today's trip and retires the plan. */
  async function usePlan(plan: TripPlan) {
    if (carId || employeeIds.length || plans.length) {
      // Planning is free at any time; STARTING a planned trip is not, because
      // it has to land in the builder and there is already a trip in it.
      setError("У конструкторі вже є поїздка. Відправте або скиньте її, і тоді підтягніть запланований виїзд.");
      return;
    }
    applyPlanToBuilder(plan, { withOdometer: true });
    try {
      await api.post(`/api/trip-plans/${plan.id}/use`, {});
    } catch {
      // The plan is already in the builder; failing to retire it server-side
      // is a stale badge, not a lost trip.
    }
    await refreshPlans();
    logChange("Застосовано заплановане на наступний виїзд");
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
        employeeIds: w.employeeIds ?? [],
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
          {!!dayCombined.excludedKm && (
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">🚗 По справам</span>
              <span className="cell-sub">{dayCombined.excludedKm} км — не в доплаті</span>
            </div>
          )}
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

  /**
   * Прибрати зайву поїздку дня.
   *
   * Питаємо двічі не з обережності заради обережності: сервер перерахує день
   * без неї, і години з обсягами цієї поїздки зникнуть із нарахувань. Для
   * дубля це саме те, що треба, для переплутаної -- ні.
   */
  async function deleteTrip(trip: SubmittedTrip) {
    const car = cars.find((c) => c.id === trip.carId)?.name ?? "Поїздка";
    const km = typeof trip.km === "number" ? `${trip.km} км` : "";
    if (
      !(await confirmDialog(
        `Видалити поїздку ${[car, km].filter(Boolean).join(" · ")}?\n\n` +
          `Її обʼєкти, роботи й години зникнуть із дня. Решта поїздок лишиться, підсумок перерахується.`,
      ))
    ) {
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/road-timesheet/trip/delete", { date, tripSeq: trip.tripSeq });
      setSubmittedTrips((prev) => prev.filter((t) => t.tripSeq !== trip.tripSeq));
      logChange(`Видалено поїздку #${trip.tripSeq + 1}`);
      haptic("success");
      // Підсумок дня рахує сервер -- перечитуємо, а не віднімаємо на око.
      try {
        const res = await api.get<SubmittedTodayResponse>(`/api/road-timesheet/submitted-today?date=${date}`);
        setSubmittedTrips(res.trips);
        setDayCombined(res.combined);
      } catch {
        // Не оновилось -- картка вже прибрана, решту покаже наступний вхід.
      }
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setSaving(false);
    }
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
          onClick={() => setExpandedTripSeq(expanded ? null : trip.tripSeq)}
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
          <div style={{ padding: "0 16px 12px" }}>
            {/* People belong to the object they worked at, with the hours and
                coefficients that decided their pay -- a flat roster of the
                whole trip said who came along and nothing else. */}
            {trip.objects.map((o) => {
              const peopleHere = [...new Set(o.sessions.map((s) => s.employeeId))];
              const coefByEmployee = new Map((o.coefs ?? []).map((c) => [c.employeeId, c]));
              return (
                <div key={o.objectId} style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600 }}>📍 {o.objectName}</div>

                  <div className="hint" style={{ fontWeight: 600, marginTop: 6 }}>🛠 Роботи</div>
                  {o.works.length ? (
                    <div className="list" style={{ margin: "4px 0 0" }}>
                      {o.works.map((w) => (
                        <div key={w.workId} className="cell" style={{ cursor: "default" }}>
                          <span className="cell-title">{w.workName}</span>
                          {w.volume && w.volume !== "?" ? (
                            <span className="badge ok">
                              {w.volume} {works.find((x) => x.id === w.workId)?.unit ?? ""}
                            </span>
                          ) : (
                            <span className="badge warn">без обсягу</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hint">без робіт</div>
                  )}

                  <div className="hint" style={{ fontWeight: 600, marginTop: 10 }}>👥 Люди</div>
                  {peopleHere.length ? (
                    <div className="list" style={{ margin: "4px 0 0" }}>
                      {peopleHere.map((id) => {
                        const ms = o.sessions
                          .filter((s) => s.employeeId === id)
                          .reduce(
                            (a, s) =>
                              a +
                              Math.max(0, (s.pickedUpAt ? new Date(s.pickedUpAt).getTime() : Date.now()) - new Date(s.droppedAt).getTime()),
                            0,
                          );
                        const hrs = Math.round((ms / 3_600_000) * 100) / 100;
                        const c = coefByEmployee.get(id);
                        const disc = c?.disciplineCoef ?? 1;
                        const prod = c?.productivityCoef ?? 1;
                        return (
                          <div key={id} className="cell" style={{ cursor: "default" }}>
                            <span className="cell-title">
                              {shortName(employeeName(id))}
                              {roleFor(id) !== "робітник" && (
                                <span className={roleTagClass(roleFor(id))} style={{ marginLeft: 6 }}>
                                  {roleFor(id)}
                                </span>
                              )}
                            </span>
                            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span className="badge">{fmtHours(hrs)}</span>
                              {(disc !== 1 || prod !== 1) && (
                                <span className="badge warn">
                                  к: {disc} / {prod}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="hint">нікого</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ padding: "8px 16px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {editable ? (
            <>
              <button className="chip" onClick={() => editTrip(trip)}>
                ✏️ Редагувати цей виїзд
              </button>
              {/* Тільки коли поїздок кілька: прибрати ЄДИНУ означало б
                  «дня не було», а це не дія бригадира -- сервер таке теж
                  не пропускає. Зайва ж поїздка не просто зайва картка:
                  дубль обʼєкта подвоює людям години й фонд. */}
              {submittedTrips.length > 1 && (
                <button className="chip" onClick={() => deleteTrip(trip)} style={{ color: "#d70015" }}>
                  🗑 Видалити цю поїздку
                </button>
              )}
            </>
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
    setErrands(trip.errands ?? []);
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
        errands: trip.errands ?? [],
        objects: restoredPlans.map((p) => ({
          objectId: p.objectId,
          objectName: p.objectName,
          works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: w.employeeIds ?? [] })),
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
  async function startNewTrip() {
    // Конструктор тримає ОДНУ поїздку, і чистити його наосліп не можна:
    // для неЗДАНОЇ поїздки це не «почати нову», а викинути стару -- рівно те,
    // що сталося з бригадиром, який тапнув сюди й пішов назад.
    //
    // Але після здачі все навпаки. Поїздка вже в базі (`editingTripSeq` ставить
    // сама save), і та сама перевірка блокувала другий виїзд за день: бригадир
    // повертався з обіду, тиснув «➕ Розпочати нову поїздку» просто на екрані
    // зданого дня -- і читав «продовжте або скиньте» про день, який щойно
    // здав. Скидати його він, звісно, не хотів.
    const submittedAlready = editingTripSeq !== null;
    if (!submittedAlready && (carId || employeeIds.length || plans.length)) {
      setError("У конструкторі вже є незавершена поїздка. Продовжте її або скиньте (🗑 угорі), і тоді створюйте нову.");
      haptic("error");
      return;
    }
    // Питаємо лише тоді, коли є що втратити: у зданій поїздці щось правили й
    // не натиснули «Оновити звіт». Без правок це звичайний хід дня, і зайвий
    // діалог тут лише привчав би тиснути «Так» не читаючи.
    if (submittedAlready && changedSinceSave) {
      const ok = await confirmDialog(
        "У поїздці, яку вже здано, є незбережені правки.\n\n" +
          "Почати нову поїздку? Ці правки зникнуть — сам зданий звіт залишиться на місці.",
      );
      if (!ok) return;
    }
    setChangedSinceSave(false);
    setEditingTripSeq(null);
    setCarId("");
    setOdoStart("");
    setOdoStartPhoto(null);
    setOdoEnd("");
    setOdoEndPhoto(null);
    setEmployeeIds([]);
    setSelfTransportIds([]);
    setErrands([]);
    setErrandMode(null);
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
    setPlanEditing(false);
    setDayStash(null);
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
      // Поїздка вже йде -- отже бус за людиною заїхав, і вона в машині.
      //
      // Раніше додавання клало людину ТІЛЬКИ у склад: ні в бусі, ні на
      // обʼєкті. «Хто де зараз» підписував її «поза поїздкою» -- підпис,
      // придуманий для того, кого висадили по дорозі з уже закритими
      // годинами, тобто рівно навпаки. Висадити її на обʼєкт було нічим:
      // список висадки показує тільки тих, хто в машині. Єдині доступні
      // двері -- «приїхав сам» -- ставили прапорець без доплати за дорогу,
      // хоча людина приїхала бусом. А якщо ніхто не помічав, вона просто
      // лишалась без годин і без грошей, і у звіті це виглядало як норма.
      if (tripStartedAt) moveEmployeesTo([id], { kind: "onboard" });
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
  async function confirmRemoveObjectFromRoute(objectId: string) {
    const plan = plans.find((p) => p.objectId === objectId);
    if (!plan) return;
    const extra = plan.works.length ? ` Разом із ним зникнуть обрані роботи (${plan.works.length}).` : "";
    if (!(await confirmDialog(`Прибрати "${plan.objectName}" з маршруту?${extra}`))) return;
    removeObjectFromRoute(objectId);
  }

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

  // Photos of the finished work. They ride to Google Drive through the same
  // endpoint the odometer shots use, and their URLs travel with the object to
  // the report. Taken AT the object, not while planning it -- a photo of work
  // that has not happened yet is worth nothing.
  async function uploadObjectPhoto(file: File, objectId: string) {
    setUploadingPhoto(true);
    setError(null);
    try {
      const res = await api.upload<{ url: string }>("/api/road-timesheet/photo", file);
      setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, photoUrls: [...p.photoUrls, res.url] })));
      haptic("success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function removeObjectPhoto(objectId: string, url: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, photoUrls: p.photoUrls.filter((u) => u !== url) })));
  }

  /**
   * One planned trip, as a card.
   *
   * Everyone's plans are listed, not just the caller's: seeing that another
   * brigade already spoke for the bus is the point. Only `mine` plans get the
   * "use it" button -- somebody else's is information, not a thing to press.
   */
  function renderPlanCard(plan: TripPlan) {
    const expanded = expandedPlanId === plan.id;
    return (
      <div key={plan.id} className="suggestion-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="setup-icon accent-teal" style={{ width: 34, height: 34, fontSize: 16 }}>
            📋
          </span>
          <div className="cell-title" style={{ flex: 1 }}>{plan.carName || "без авто"}</div>
          {!plan.mine && <span className="badge">{shortName(plan.foremanName)}</span>}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {nPeople(plan.employeeIds.length)} · {nObjects(plan.objects.length)}
        </div>
        {plan.assignedByAdmin && (
          <div className="hint" style={{ marginTop: 4, color: "#a35c00" }}>
            👤 Запланував адміністратор · {plan.createdByName}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button className="chip chip-sm" onClick={() => setExpandedPlanId(expanded ? null : plan.id)}>
            {expanded ? "▾ Сховати деталі" : "▸ Показати деталі"}
          </button>
        </div>
        {expanded && (
          <div style={{ marginTop: 10 }}>
            <div className="hint" style={{ fontWeight: 600 }}>👥 Люди</div>
            <ul className="bullets">
              {plan.employeeNames.length ? plan.employeeNames.map((n) => <li key={n}>{n}</li>) : <li>—</li>}
            </ul>
            <div className="hint" style={{ fontWeight: 600, marginTop: 14 }}>📍 Обʼєкти та роботи</div>
            {plan.objects.length ? (
              plan.objects.map((o) => (
                <div key={o.objectId} style={{ marginTop: 10 }}>
                  <div className="hint" style={{ fontWeight: 600 }}>{o.objectName}</div>
                  <ul className="bullets">
                    {o.works.length ? o.works.map((w) => <li key={w.workId}>{w.workName}</li>) : <li>без робіт</li>}
                  </ul>
                </div>
              ))
            ) : (
              <div className="hint">—</div>
            )}
          </div>
        )}
        {(() => {
          // An admin's assignment is a task, not a suggestion: the brigadier
          // runs it, the admin is the one who changes or withdraws it. Mirrors
          // loadPlan() on the server -- the buttons and the rule agree.
          const canEdit = isAdmin || (plan.mine && !plan.assignedByAdmin);
          if (!canEdit && !plan.mine) return null;
          return (
            <>
              {!canEdit && (
                <div className="hint" style={{ marginTop: 8 }}>
                  Змінити або прибрати може лише адміністратор.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {canEdit && (
                  <>
                    <button className="chip" onClick={() => deletePlan(plan)}>🗑 Прибрати</button>
                    <button className="chip" onClick={() => openPlanner(plan)}>✏️ Змінити</button>
                  </>
                )}
                {plan.mine && (
                  <button className="chip selected" onClick={() => usePlan(plan)}>▶️ Використати</button>
                )}
              </div>
            </>
          );
        })()}
      </div>
    );
  }

  /**
   * The photo strip, shared by the object screen and the day summary.
   *
   * TEMPORARILY DISABLED at the owner's request (Google Drive uploads are not
   * settled yet). The whole feature is one `return null` away from coming
   * back: nothing else was removed, and photoUrls still travels to the server,
   * just always empty.
   */
  const PHOTOS_ENABLED = false;

  function renderObjectPhotos(plan: ObjPlan) {
    if (!PHOTOS_ENABLED) return null;
    return (
      <div className="list" style={{ marginBottom: 8 }}>
        <div className="cell" style={{ cursor: "default", display: "block" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span className="cell-title">📷 Фото обʼєкта</span>
            {plan.photoUrls.length > 0 && <span className="badge ok">{plan.photoUrls.length}</span>}
          </div>
          {plan.photoUrls.length > 0 && (
            <div className="picked-panel" style={{ marginTop: 8 }}>
              {plan.photoUrls.map((url, i) => (
                <span key={url} className="picked-item">
                  <a href={url} target="_blank" rel="noreferrer">фото {i + 1}</a>
                  <button className="picked-remove" onClick={() => removeObjectPhoto(plan.objectId, url)} aria-label="Прибрати фото">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <PhotoButton
              text={uploadingPhoto ? "Завантаження…" : "📷 Додати фото"}
              disabled={uploadingPhoto}
              onPick={(file) => uploadObjectPhoto(file, plan.objectId)}
            />
            <div className="hint" style={{ marginTop: 6 }}>Не обовʼязково. Зберігається в Google Drive і йде у звіт.</div>
          </div>
        </div>
      </div>
    );
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

  function removeWork(objectId: string, workId: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: p.works.filter((w) => w.workId !== workId) })));
    haptic("selection");
  }

  function clearWorks(objectId: string) {
    setPlans((prev) => prev.map((p) => (p.objectId !== objectId ? p : { ...p, works: [] })));
    haptic("selection");
  }

  /** Кому зарахувати конкретну роботу. Порожній список означає «спільна»,
   * тож зняття останньої людини повертає роботу всій бригаді. */
  function toggleWorkAssignee(objectId: string, workId: string, employeeId: string) {
    setPlans((prev) =>
      prev.map((p) =>
        p.objectId !== objectId
          ? p
          : {
              ...p,
              works: p.works.map((w) => {
                if (w.workId !== workId) return w;
                const current = w.employeeIds ?? [];
                return { ...w, employeeIds: current.includes(employeeId) ? current.filter((x) => x !== employeeId) : [...current, employeeId] };
              }),
            },
      ),
    );
    haptic("selection");
  }


  /** One selectable work row in the PLAN_WORKS picker -- rendered both
   * directly under a category and inside a subcategory group. */
  function workPickerCell(objectId: string, w: Work) {
    const checked = planFor(objectId).works.some((pw) => pw.workId === w.id);
    return (
      <button key={w.id} className={`cell ${checked ? "selected" : ""}`} {...tapProps(() => toggleWork(objectId, w))}>
        <span className="cell-title" style={{ display: "flex", alignItems: "center" }}>
          <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
          {w.name}
        </span>
      </button>
    );
  }

  // Adding a whole category can mean 184 works in one tap. Unselecting is one
  // tap back, so only the adding direction asks -- and only when the number is
  // big enough that it wasn't obviously intended.
  const BULK_CONFIRM_FROM = 10;

  async function toggleAllWorksInCategory(objectId: string, categoryWorks: Work[]) {
    const plan = planFor(objectId);
    const allSelected = categoryWorks.length > 0 && categoryWorks.every((w) => plan.works.some((pw) => pw.workId === w.id));
    if (!allSelected) {
      const adding = categoryWorks.filter((w) => !plan.works.some((pw) => pw.workId === w.id)).length;
      if (adding >= BULK_CONFIRM_FROM && !(await confirmDialog(`Додати всі ${nWorks(adding)} на обʼєкт?`))) return;
    }
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

  function storeVolume(deferred: boolean) {
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
  }

  function saveVolumeDetail(deferred: boolean) {
    storeVolume(deferred);
    setPlanVolumeWorkId(null);
  }

  /**
   * Saves what was typed and opens the next work that still needs a volume,
   * so a foreman with nine works fills them in one run instead of bouncing
   * back to the list after every single one. Wraps around, and falls back to
   * the list once nothing is left unfilled.
   */
  function saveVolumeAndNext(deferred: boolean) {
    if (!planObjectId || !planVolumeWorkId) return;
    storeVolume(deferred);
    const works = planFor(planObjectId).works;
    const from = works.findIndex((w) => w.workId === planVolumeWorkId);
    const ordered = [...works.slice(from + 1), ...works.slice(0, from)];
    const next = ordered.find((w) => !w.volume || w.volume === "?");
    if (!next) {
      setPlanVolumeWorkId(null);
      return;
    }
    setPlanVolumeWorkId(next.workId);
    setVolumeBuffer(next.volume && next.volume !== "?" ? next.volume : "");
    haptic("selection");
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
    setHeadingToObjectId("");
    setCarAtObjectId("");
    setOnboard(employeeIds);
    setTripStartedAt(new Date().toISOString());
    setDrivingAccumulatedMs(0);
    // The clock does NOT start here. Leaving base is a tap; the wheels turn
    // once the foreman says where they are going, and that is where the road
    // time begins.
    setDrivingSegmentStartedAt(null);
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

  // Пускає годинник дороги. НЕ чіпає carAtObjectId: «бус рушив» — це окрема
  // подія, і вона трапляється рівно в трьох місцях (обрали куди їхати,
  // «Продовжити рух», «Рушили на базу»). Раніше вона була тут, і будь-який
  // резюм стирав памʼять про те, що бус стоїть на обʼєкті: бригадир виходив
  // «‹ Назад» з екрана забирання — і застосунок уже не знав, де машина.
  function resumeDrivingSegment() {
    setDrivingSegmentStartedAt((segStart) => segStart ?? new Date().toISOString());
  }

  /** Бус рушив: годинник іде, машина більше не стоїть на обʼєкті. */
  function departFromObject() {
    resumeDrivingSegment();
    setCarAtObjectId("");
  }

  // "Done with this object" is not the same as "arrived at it". Arriving and
  // driving on without dropping anybody leaves nothing recorded there, yet the
  // route counted it as finished -- the object fell out of the destination
  // chooser and there was no way back to start work on it.
  const objectUnfinished = (p: ObjPlan) => !p.visited || (!p.noWork && !p.sessions.length && !p.here.length);
  const nextUnvisited = plans.find(objectUnfinished) ?? null;
  // The chosen destination, but only while it is still ahead of us: an object
  // that got visited (or dropped from the route) must not keep steering the
  // drive screen.
  const headingTo = plans.find((p) => p.objectId === headingToObjectId) ?? null;

  /**
   * Пункт призначення для екрана ВИЇЗДУ — дійсний, лише поки на обʼєкті ще є
   * що робити.
   *
   * `headingTo` сам по собі цього не перевіряє, хоч коментар вище саме це й
   * обіцяв. Через це бригадир, який завершив роботи й поїхав далі, бачив
   * «Прямуємо до 📍 Апартель Косино» і кнопку «📍 Прибув: Апартель Косино» —
   * назад на обʼєкт, з якого щойно виїхав, поки насправді їхав до Ужгорода.
   * На екрані ПОВЕРНЕННЯ фільтр не потрібен і шкідливий: там якраз
   * повертаються по відпрацьовані обʼєкти, тож він користується `headingTo`.
   */
  const driveHeadingTo = headingTo && objectUnfinished(headingTo) ? headingTo : null;

  // Where "↩️ Повернутися до поїздки" on HUB should actually land. Follows
  // the LIVE trip's state first (objects still to visit -> people to pick up
  // -> final odometer): an earlier trip submitted for this date must not
  // hijack resume into REVIEW while a new/edited trip is actively underway
  // (e.g. after "Скинути поїздку", or after "Розпочати нову поїздку" for a
  // second leg the same day). Only THIS trip having its own odoEnd already
  // set (either entered live, or restored by editTrip()) resumes at REVIEW;
  // otherwise it's still mid-route and belongs at RETURN.
  // Стоянка на обʼєкті -- це не повернення. Правило нижче цього не розрізняло:
  // усі обʼєкти відвідані + люди ще десь стоять означало "забираємо людей", і
  // бригадир, який просто хотів повернутись до відкритої поїздки, потрапляв на
  // екран повернення на базу. Гірше -- екран адміна від того показував бригаду
  // як "повертаються", хоча вона щойно почала працювати.
  //
  // Тому спершу перевіряємо, чи машина стоїть там, де є люди: тоді
  // повертатись треба на цей обʼєкт, а не в дорогу додому.
  const carParkedWithCrew = carAtObjectId && plans.some((p) => p.objectId === carAtObjectId && p.here.length > 0);
  const tripResumeStep: Step = nextUnvisited
    ? "DRIVE"
    : carParkedWithCrew
      ? "AT_OBJECT"
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
    setCarAtObjectId(objectId);
    setHeadingToObjectId("");
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
  // Opens another object's panel without claiming the car went there. It used
  // to mark the object visited, which quietly finished the route: with nothing
  // left unvisited, the main button turned into "повертатись на базу" although
  // the crew had not driven anywhere. Switching is for fixing an object's
  // works or people from where you are standing, nothing more.
  function switchAtObject(objectId: string) {
    const target = plans.find((p) => p.objectId === objectId);
    if (!target) return;
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
  // Note: deliberately does NOT touch the driving clock. The car is still on
  // the road while this is open -- it is only being told that somebody made
  // their own way to the object ahead.
  function openObjectMenu(objectId: string) {
    const target = plans.find((p) => p.objectId === objectId);
    if (!target) return;
    setAtObjectId(objectId);
    setAtObjectReturnStep("DRIVE");
    setDropSelected([]);
    setAddArrivedSelected([]);
    setAtObjectDetailsExpanded(false);
    // Відкриваємо сам обʼєкт, а не пікер людей поверх нього. Раніше звідси
    // одразу вивалювався список прізвищ -- без обʼєкта на екрані й без
    // решти його дій, і незрозуміло було, куди ти взагалі потрапив.
    setArrivedPickerOpen(false);
    setShowDropPicker(false);
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
    // Коротко і з обмеженням: повний перелік ПІБ пʼятьох людей переступав
    // ліміт попапа в Telegram, і діалог не показувався взагалі -- кнопка
    // мовчки не спрацьовувала (див. clamp у lib/telegram.ts).
    const shown = unstarted.slice(0, 3).map((id) => shortName(employeeName(id))).join(", ");
    const rest = unstarted.length > 3 ? ` та ще ${unstarted.length - 3}` : "";
    return confirmDialog(
      `«${objectName}»: не розпочато роботи — ${shown}${rest}.\n\n` +
        `Якщо забрати без нарахування, за цей обʼєкт вони нічого не отримають. Продовжити?`,
    );
  }

  /**
   * Would sending these people off on their own leave the bus with no driver?
   *
   * True only when the trip actually has a car, nobody is aboard it, and this
   * object would be emptied -- so there is no one left anywhere to drive it
   * back. A crew that came entirely by their own transport (no car on the
   * trip) is unaffected.
   */
  function strandsTheBus(objectId: string, leavingIds: string[]): boolean {
    if (!carId) return false;
    if (onboard.length > 0) return false;
    const emptiedHere = planFor(objectId).here.filter((id) => !leavingIds.includes(id)).length === 0;
    if (!emptiedHere) return false;
    // Somebody still standing at another object could be collected and drive.
    return !plans.some((p) => p.objectId !== objectId && p.here.length > 0);
  }

  // Finishes the selected people's open sessions and removes them from the
  // object. Their physical destination is explicit: either the bus, or
  // `nowhere` when a self-transport employee leaves the object on their own.
  // `pauseForBus` is used by the return route: putting someone in the bus
  // means the vehicle has really reached that object, so road time pauses.
  /**
   * Гасить роботи, над якими вже нікому працювати.
   *
   * Закріплена робота йде, поки хоч один з її людей у зміні; бригадна -- поки
   * в зміні хоч хтось. Раніше зупинка була одна на весь обʼєкт («не лишилось
   * нікого»), тож знята з обʼєкта людина йшла, а її персональна робота далі
   * накручувала годинник, і бейдж бадьоро показував «йде».
   */
  function stopFinishedWorks(works: PlannedWork[], sessions: EmployeeSession[], atMs: number): PlannedWork[] {
    const openIds = new Set(sessions.filter((s) => !s.endedAt).map((s) => s.employeeId));
    return works.map((w) => {
      if (!w.workStartedAt) return w;
      const assigned = w.employeeIds ?? [];
      const stillWorked = assigned.length ? assigned.some((id) => openIds.has(id)) : openIds.size > 0;
      if (stillWorked) return w;
      return {
        ...w,
        workStartedAt: null,
        workAccumulatedMs: (w.workAccumulatedMs ?? 0) + (atMs - new Date(w.workStartedAt).getTime()),
      };
    });
  }

  async function departObject(
    objectId: string,
    employeeIdsToMove: string[],
    destination: "onboard" | "own_transport",
    pauseForBus = false,
  ): Promise<boolean> {
    const plan = planFor(objectId);
    const ids = employeeIdsToMove.filter((id) => plan.here.includes(id));
    if (!ids.length) return false;
    // Somebody has to drive the bus home. Sending the last person off on their
    // own leaves it parked at the object with nobody in it -- and the app then
    // jumped straight to the closing odometer, as if the day were over.
    if (destination === "own_transport" && strandsTheBus(objectId, ids)) {
      await alertDialog(
        `Хтось має сісти за кермо: у бусі не залишиться жодної людини.\n\n` +
          `Заберіть принаймні одного в бус («🚐 У бус»), а решту можна зняти.`,
      );
      haptic("error");
      return false;
    }
    if (!(await confirmUnstartedPickup(objectId, ids))) return false;
    if (destination === "onboard" && pauseForBus) pauseDrivingSegment();

    const now = new Date().toISOString();
    const nowMs = Date.now();
    moveEmployeesTo(ids, destination === "onboard" ? { kind: "onboard" } : { kind: "nowhere" });
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const sessions = p.sessions.map((s) => (ids.includes(s.employeeId) && !s.endedAt ? { ...s, endedAt: now } : s));
        return { ...p, sessions, works: stopFinishedWorks(p.works, sessions, nowMs) };
      }),
    );
    haptic("light");
    const names = ids.map(employeeName).join(", ");
    logChange(
      destination === "onboard"
        ? `Посаджено в бус з ${plan.objectName}: ${names}`
        : `Поїхали самостійно з ${plan.objectName}: ${names}`,
    );
    return true;
  }

  async function pickUpHere(objectId: string, ids?: string[], pauseForBus = false) {
    const plan = planFor(objectId);
    return departObject(objectId, ids ?? plan.here, "onboard", pauseForBus);
  }

  // Picks up (and clocks out, if still working) one specific person without
  // disturbing anyone else still at the object.
  async function pickUpOne(objectId: string, employeeId: string, pauseForBus = false) {
    return departObject(objectId, [employeeId], "onboard", pauseForBus);
  }

  // A person who arrived independently can finish at the object and leave
  // independently as well. They stay in employeeIds/selfTransportIds so all
  // worked hours remain in payroll and they remain ineligible for the trip's
  // road allowance; only their current physical location changes.
  async function leaveObjectOnOwn(objectId: string, employeeIdsLeaving: string | string[]) {
    const ids = Array.isArray(employeeIdsLeaving) ? employeeIdsLeaving : [employeeIdsLeaving];
    return departObject(objectId, ids, "own_transport");
  }

  function openVolumesForObject(objectId: string, returnTo: Step) {
    setPlanObjectId(objectId);
    setVolumesReturnStep(returnTo);
    setStep("PLAN_VOLUMES");
  }

  /** Скільки обсягів обʼєкта вже введено — для лічильника на кнопках входу. */
  function volumeStat(p: ObjPlan) {
    const total = p.works.length;
    const filled = p.works.filter((w) => w.volume && w.volume !== "?").length;
    return { total, filled, left: total - filled };
  }

  // ---------- at object ----------
  function currentAtPlan() {
    return plans.find((p) => p.objectId === atObjectId) ?? null;
  }

  // Clocks in everyone currently dropped at the object who isn't already
  // clocked in -- can be pressed again later to pick up newcomers without
  // disturbing sessions already in progress.
  async function startShift() {
    if (!atObjectId) return;
    const plan = currentAtPlan();
    if (!plan || !plan.here.length) return;
    // Works already named to someone are paid to them alone. Starting the
    // rest of the crew does not take those works away -- but the crew would
    // otherwise walk onto a job whose money is not theirs, so say so once.
    const dedicated = plan.works.filter((w) => (w.employeeIds ?? []).length > 0);
    if (dedicated.length) {
      const lines = dedicated
        .map((w) => `• ${w.workName} — ${(w.employeeIds ?? []).map((id) => shortName(employeeName(id))).join(", ")}`)
        .join("\n");
      const ok = await confirmDialog(
        `На обʼєкті вже є закріплені роботи:\n${lines}\n\nЗа них платять лише цим людям, і решту робіт обʼєкта вони вже не ділять. Почати роботи решті?`,
      );
      if (!ok) return;
    }
    // The brigadier is at the object more often than he works there -- he is
    // running the day, and his 20% is paid for exactly that, hours or no
    // hours. Since the crew share is now split BY hours, clocking him in by
    // reflex quietly takes a slice off everyone who is actually digging. So
    // ask, every time, instead of guessing.
    const openIds = new Set(plan.sessions.filter((s) => !s.endedAt).map((s) => s.employeeId));
    // Every brigadier standing here, not just the first: "так" clocks in the
    // whole group, "ні" leaves all of them out.
    const brigadiersHere = plan.here.filter((id) => !openIds.has(id) && roleFor(id) === "бригадир");
    let skipIds = new Set<string>();
    if (brigadiersHere.length) {
      // Just the question and the names. The foreman taps this several times a
      // day and already knows what it means -- an explanation of how the 20%
      // works turns a two-second tap into something to read.
      const withBrigadier = await askDialog(
        brigadiersHere.map((id) => `• ${shortName(employeeName(id))}`).join("\n"),
        "Так",
        "Ні",
        brigadiersHere.length > 1 ? "Почати роботи з бригадирами?" : "Почати роботи з бригадиром?",
      );
      if (!withBrigadier) skipIds = new Set(brigadiersHere);
    }
    const nowIso = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== atObjectId) return p;
        const open = new Set(p.sessions.filter((s) => !s.endedAt).map((s) => s.employeeId));
        const newSessions = p.here
          .filter((id) => !open.has(id) && !skipIds.has(id))
          .map((employeeId) => ({ employeeId, startedAt: nowIso }));
        // "Почати роботи" is the bulk shortcut -- it starts every work item's
        // own timer too, not just people's. A single work is started instead
        // through the person it is assigned to (startPersonTimer); there is
        // no Старт/Стоп of its own beside each work.
        const works = p.works.map((w) => (w.workStartedAt ? w : { ...w, workStartedAt: nowIso }));
        return { ...p, sessions: [...p.sessions, ...newSessions], works };
      }),
    );
    haptic("light");
    logChange(
      `Почато роботи на ${plan.objectName} (${nPeople(plan.here.length - skipIds.size)})` +
        (skipIds.size ? ` — без ${[...skipIds].map((id) => shortName(employeeName(id))).join(", ")}` : ""),
    );
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

  // Per-person timer, independent of "Забрати" (which also physically moves
  // the person off the object) -- lets the foreman pause one person's clock
  // (e.g. a break) while they stay `here`, then resume it later.
  function startPersonTimer(objectId: string, employeeId: string) {
    const startedAt = new Date().toISOString();
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const alreadyOpen = p.sessions.some((s) => s.employeeId === employeeId && !s.endedAt);
        // Разом із людиною пускаємо годинники ЇЇ закріплених робіт: саме їх
        // вона й почала. Без цього рядок «🛠 окремо: …» стояв без годинника,
        // а запустити його могла тільки загальна кнопка -- яка вмикає ще й
        // усю бригаду, чого при закріпленій роботі якраз і не хочуть.
        const works = p.works.map((w) =>
          !w.workStartedAt && (w.employeeIds ?? []).includes(employeeId) ? { ...w, workStartedAt: startedAt } : w,
        );
        return { ...p, works, sessions: alreadyOpen ? p.sessions : [...p.sessions, { employeeId, startedAt }] };
      }),
    );
    logChange(`Старт: ${employeeName(employeeId)} на ${planFor(objectId).objectName}`);
    haptic("light");
  }

  function stopPersonTimer(objectId: string, employeeId: string) {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== objectId) return p;
        const sessions = p.sessions.map((s) => (s.employeeId === employeeId && !s.endedAt ? { ...s, endedAt: now } : s));
        // Разом із людиною гасне і робота, над якою більше нікому працювати --
        // те саме правило, що й при знятті з обʼєкта.
        return { ...p, sessions, works: stopFinishedWorks(p.works, sessions, nowMs) };
      }),
    );
    logChange(`Стоп: ${employeeName(employeeId)} на ${planFor(objectId).objectName}`);
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
    return Math.round((ms / 3_600_000) * 10000) / 10000;
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

  // The one errand currently in progress (car out), if any.
  const openErrand = errands.find((e) => e.odoBack === null) ?? null;
  // Errand kilometres, computed the same way the server excludes them from
  // the trip class: only closed errands, only forward movement.
  const errandKm = errands.reduce((a, e) => a + (e.odoBack !== null ? Math.max(0, e.odoBack - e.odoOut) : 0), 0);

  function startErrand(objectId: string, driverId: string, odoOut: number) {
    const objectName = planFor(objectId).objectName;
    setErrands((prev) => [...prev, { id: crypto.randomUUID(), objectId, objectName, driverId, odoOut, odoBack: null }]);
    haptic("light");
    logChange(`🚗 Машина вибула по справам (водій ${employeeName(driverId)}, ${odoOut} км)`);
  }

  function finishErrand(odoBack: number) {
    if (!openErrand) return;
    setErrands((prev) => prev.map((e) => (e.id === openErrand.id ? { ...e, odoBack } : e)));
    haptic("success");
    logChange(`↩️ Машина повернулась (${odoBack} км, по справам ${Math.max(0, odoBack - openErrand.odoOut)} км)`);
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

  /**
   * Corrects a wrong object: the person leaves this crew and joins the one at
   * the other object, as if they had been there all along.
   *
   * Two earlier readings of this action were both wrong. Closing the session
   * here and opening a new one there is "worked here, then moved on" -- the
   * hours stay behind and the person is paid out of both objects. Carrying
   * their own session over is closer, but still dates their work from
   * whenever the foreman happened to notice the mistake.
   *
   * What actually happened is that they were on the other object from the
   * start, so they get the crew's hours there, not their own: the session
   * spans the same window as everybody else's at that object, whenever the
   * correction is made. Nothing of theirs stays behind -- not the sessions,
   * and not their name on any work here (a work left with no names is the
   * crew's again, which is right for someone who was never on this object).
   * At the new object they need no assignment either: the crew's shared works
   * are theirs by being in the crew.
   */
  /**
   * Перехід пішки на сусідній обʼєкт. Дві точки на одній території -- звична
   * річ: відпрацювали на першій, двоє перейшли на другу, бус тим часом повіз
   * решту далі.
   *
   * Це НЕ виправлення помилки: години на першому обʼєкті чесно зароблені й
   * лишаються там, закріплені роботи теж. На новому обʼєкті людина просто
   * стоїть -- час їй піде, коли бригадир натисне «Старт».
   *
   * Робити це «зняти + прибули самі» було не можна: другий крок ставить
   * прапорець self-transport і забирає доплату за виїзд у людини, яку насправді
   * привіз бус.
   */
  function walkToObject() {
    if (!atObjectId || !moveTargetId || !moveSelected.length) return;
    const fromName = currentAtPlan()?.objectName ?? "";
    const toName = plans.find((p) => p.objectId === moveTargetId)?.objectName ?? "";
    const moving = new Set(moveSelected);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    moveEmployeesTo(moveSelected, { kind: "object", objectId: moveTargetId });
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId === moveTargetId) return { ...p, visited: true };
        if (p.objectId !== atObjectId) return p;
        const sessions = p.sessions.map((x) => (moving.has(x.employeeId) && !x.endedAt ? { ...x, endedAt: now } : x));
        return { ...p, sessions, works: stopFinishedWorks(p.works, sessions, nowMs) };
      }),
    );
    haptic("light");
    logChange(`Пішки ${moveSelected.map(employeeName).join(", ")}: ${fromName} → ${toName}`);
    setMoveSelected([]);
    setMoveTargetId(null);
    setShowMovePicker(false);
  }

  /**
   * Вікно, яке отримує людина, додана в бригаду на обʼєкті вже після старту.
   *
   * Правило: беремо тих, хто працює ЗАРАЗ, і найраніший з їхніх стартів. Якщо
   * бригадир запускав людей поодинці о 08:00, 08:10 і 08:20 -- новачок
   * отримає 08:00.
   *
   * Чому саме відкриті сесії: раніше бралися всі поспіль, включно з давно
   * закритими. Людина, яка відпрацювала з 06:00 до 07:00 і поїхала, тягнула
   * початок новачка на 06:00 -- тобто на годину, коли на обʼєкті ще нікого не
   * було. Коли ж не працює вже ніхто, день тут скінчився, і новачок отримує
   * повний проміжок бригади: від найранішого старту до найпізнішого кінця.
   */
  function crewWindowAt(plan: ObjPlan, excludeIds: string[]): { startedAt: string; endedAt?: string } | null {
    const exclude = new Set(excludeIds);
    const crew = plan.sessions.filter((s) => !exclude.has(s.employeeId));
    if (!crew.length) return null;
    const open = crew.filter((s) => !s.endedAt);
    if (open.length) {
      return { startedAt: new Date(Math.min(...open.map((s) => new Date(s.startedAt).getTime()))).toISOString() };
    }
    return {
      startedAt: new Date(Math.min(...crew.map((s) => new Date(s.startedAt).getTime()))).toISOString(),
      endedAt: new Date(Math.max(...crew.map((s) => new Date(s.endedAt as string).getTime()))).toISOString(),
    };
  }

  /**
   * Додати людину на обʼєкт посеред дня.
   *
   * Випадок, заради якого це є: бригадир забув когось внести, роботи вже
   * годину йдуть, а людина працює з бригадою від самого ранку. Досі це
   * робилось через «прибули самі» -- і мовчки коштувало людині доплати за
   * виїзд, бо та кнопка ставить прапорець self-transport.
   *
   * Тому питаємо прямо, як вона тут опинилась -- і, окремо, З ЯКОГО ЧАСУ
   * рахувати їй години:
   *   - «з бригадою» -- сесія від найранішого старту на цьому обʼєкті. Це для
   *     того, кого забули внести: він працює з ранку, і час з моменту, коли
   *     його помітили, вкрав би в нього все до тієї хвилини.
   *   - «зараз» -- сесія від поточної хвилини. Це для того, хто справді
   *     щойно доїхав: своїм ходом, після поломки, з іншого обʼєкта.
   * Вибір обовʼязковий і без замовчування: раніше кнопка мовчки давала перший
   * варіант, і день 08.09 приписав пʼятьом по 39 хвилин, яких вони не
   * працювали.
   *
   * Якщо бригада ще не починала, питання не ставиться і сесії немає: людина
   * просто стоїть і піде в роботу разом з усіма.
   */
  async function confirmAddPeople() {
    if (!atObjectId || !addPersonSelected.length) return;
    const ids = [...addPersonSelected];
    const atPlan = currentAtPlan();
    const objectName = atPlan?.objectName ?? "";
    const crewWindow = atPlan ? crewWindowAt(atPlan, ids) : null;
    // Питаємо тільки тоді, коли є з чого вибирати: без відкритої роботи на
    // обʼєкті обидві відповіді означали б одне й те саме.
    if (crewWindow && !addPersonStart) {
      setAddPersonStartHint(true);
      haptic("error");
      return;
    }
    const window = crewWindow && addPersonStart === "now" ? { startedAt: new Date().toISOString() } : crewWindow;
    const mergedEmployeeIds = [...new Set([...employeeIds, ...ids])];
    try {
      await api.post("/api/road-timesheet/reserve", { date, carId, employeeIds: mergedEmployeeIds });
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
      return;
    }
    setEmployeeIds(mergedEmployeeIds);
    // Транспорт визначається ОДИН раз на день: людина приїхала бусом або своїм
    // ходом, і від того, що її додають на другий обʼєкт, це не міняється.
    // Тому прапорець чіпаємо лише для тих, кого в поїздці ще не було —
    // інакше «додати себе на Косино після Рікки» тихо переписувало б доплату
    // за виїзд за весь день.
    const newcomers = ids.filter((id) => !employeeIds.includes(id));
    if (newcomers.length) {
      setSelfTransportIds((prev) =>
        addPersonArrival === "own"
          ? [...new Set([...prev, ...newcomers])]
          : prev.filter((x) => !newcomers.includes(x)),
      );
    }
    moveEmployeesTo(ids, { kind: "object", objectId: atObjectId });
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId !== atObjectId) return p;
        const crew = p.sessions.filter((x) => !ids.includes(x.employeeId));
        if (!window) return { ...p, sessions: crew };
        const joined = ids.map((employeeId) => ({ employeeId, ...window }));
        return { ...p, sessions: [...crew, ...joined] };
      }),
    );
    logChange(
      `${objectName}: додано ${ids.map(employeeName).join(", ")} ` +
        `(${addPersonArrival === "own" ? "приїхали самі" : "привезли бусом"}, ` +
        `${window ? `години з ${hhmmOf(window.startedAt)}` : "роботи ще не починались"})`,
    );
    haptic("success");
    setAddPersonSelected([]);
    setAddPersonStart(null);
    setAddPersonStartHint(false);
    setShowAddPersonPicker(false);
  }

  function confirmMove() {
    if (!atObjectId || !moveTargetId || !moveSelected.length) return;
    if (moveMode === "walk") return walkToObject();
    if (moveTargetId === BASE_TARGET) {
      // Не переміщення, а вилучення: людини в поїздці не було взагалі.
      // removeEmployeesFromTrip стирає її сесії всюди, прибирає зі складу й
      // з self-transport, і кладе в тост «Скасувати» -- разом з тим, де вона
      // стояла до цього.
      removeEmployeesFromTrip(moveSelected, `${moveSelected.map(employeeName).join(", ")}: на базі, не в поїздці`);
      setMoveSelected([]);
      setMoveTargetId(null);
      setShowMovePicker(false);
      return;
    }
    const fromName = currentAtPlan()?.objectName ?? "";
    const toName = plans.find((p) => p.objectId === moveTargetId)?.objectName ?? "";
    const count = moveSelected.length;
    const moving = new Set(moveSelected);
    moveEmployeesTo(moveSelected, { kind: "object", objectId: moveTargetId });
    setPlans((prev) =>
      prev.map((p) => {
        if (p.objectId === atObjectId) {
          const sessions = p.sessions.filter((s) => !moving.has(s.employeeId));
          const works = p.works.map((w) =>
            (w.employeeIds ?? []).some((id) => moving.has(id))
              ? { ...w, employeeIds: (w.employeeIds ?? []).filter((id) => !moving.has(id)) }
              : w,
          );
          // Те саме правило, що й скрізь: робота йде, поки над нею є відкрита
          // сесія. Без цього робота людини, якої тут «ніколи не було»,
          // лишалась із живим годинником.
          return { ...p, sessions, works: stopFinishedWorks(works, sessions, Date.now()) };
        }
        if (p.objectId === moveTargetId) {
          // The crew already at the target defines the window. If nobody has
          // started there yet, the newcomers simply wait to be started with
          // everyone else -- no session is invented for them.
          const crew = p.sessions.filter((s) => !moving.has(s.employeeId));
          const window = crewWindowAt(p, moveSelected);
          if (!window) return { ...p, sessions: crew };
          const joined = moveSelected.map((employeeId) => ({ employeeId, ...window }));
          return { ...p, sessions: [...crew, ...joined] };
        }
        return p;
      }),
    );
    haptic("light");
    logChange(`Виправлено обʼєкт для ${count}: ${fromName} → ${toName}`);
    setMoveSelected([]);
    setMoveTargetId(null);
    setShowMovePicker(false);
  }

  // "Everyone accounted for" = nobody is still standing on an object. Do NOT
  // compare onboard vs employeeIds counts: someone dropped off along the way
  // home (roadsideDropoff) stays in the trip roster for the road allowance
  // but is legitimately not in the car, and must not block the day report.
  const allBack = plans.every((p) => p.here.length === 0);

  // Shared departure panel used both directly at an object and during the
  // return route. People are split by how they arrived, so the default action
  // is unambiguous: bus arrivals go back into the bus, while self-transport
  // arrivals can leave independently or opt into a bus seat one by one.
  function renderDepartureChoices(
    plan: ObjPlan,
    { allowBus, pauseForBus }: { allowBus: boolean; pauseForBus: boolean },
  ) {
    const busArrivalIds = plan.here.filter((id) => !selfTransportIds.includes(id));
    const selfArrivalIds = plan.here.filter((id) => selfTransportIds.includes(id));
    if (!busArrivalIds.length && !selfArrivalIds.length) return null;

    return (
      <div className="departure-groups">
        {busArrivalIds.length > 0 && (
          <div className="departure-group bus">
            <div className="departure-group-title">
              <span>🚐 Приїхали бусом</span>
              <span className="badge">{busArrivalIds.length}</span>
            </div>
            <div className="hint">{busArrivalIds.map(employeeName).join(", ")}</div>
            {allowBus ? (
              <button className="chip selected departure-main-action" onClick={() => pickUpHere(plan.objectId, busArrivalIds, pauseForBus)}>
                🚐 Посадити в бус ({busArrivalIds.length})
              </button>
            ) : (
              <div className="hint" style={{ marginTop: 8 }}>Бус ще не прибув на цей обʼєкт</div>
            )}
          </div>
        )}

        {selfArrivalIds.length > 0 && (
          <div className="departure-group self">
            <div className="departure-group-title">
              <span>🚶 Приїхали самі</span>
              <span className="badge warn">{selfArrivalIds.length}</span>
            </div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Посадіть у бус тих, кого забираєте. Решту зніміть з обʼєкта однією кнопкою
            </div>
            {selfArrivalIds.map((id) => (
              <div key={id} className="departure-person">
                <span className="departure-person-name">
                  <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                  {employeeName(id)}
                </span>
                {allowBus && (
                  <span className="departure-person-actions">
                    <button className="chip selected" onClick={() => pickUpOne(plan.objectId, id, pauseForBus)}>
                      🚐 Посадити в бус
                    </button>
                  </span>
                )}
              </div>
            ))}
            <button className="chip departure-main-action" onClick={() => leaveObjectOnOwn(plan.objectId, selfArrivalIds)}>
              🚶 Зняти з обʼєкта ({selfArrivalIds.length})
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- payload / save ----------
  function buildObjectsPayload() {
    const coefList = employeeIds.map((id) => ({ employeeId: id, disciplineCoef: coefFor(id).disciplineCoef, productivityCoef: coefFor(id).productivityCoef }));
    return plans.map((p) => ({
      objectId: p.objectId,
      objectName: p.objectName,
      works: p.works.map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume || "?", employeeIds: w.employeeIds ?? [] })),
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
        errands,
        objects: buildObjectsPayload(),
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    // Відкрита сесія на момент відправки -- це тихо з'їдені гроші.
    //
    // Сервер рахує незакриту сесію ДО МОМЕНТУ ЗАПИТУ
    // (`new Date(s.pickedUpAt ?? now)`), тож звіт, надісланий о 17:30, обріже
    // людину, яка працює до 19:00, на півтори години. У звіті це виглядає
    // абсолютно нормально, і не побачить ніхто -- ні бригадир, ні адмін, ні
    // сама людина. Тому це єдина перевірка тут, яка НЕ пропускає далі:
    // зупинити роботу завжди можна, а повернути з'їдені години -- ні.
    const stillWorking = plans.flatMap((p) =>
      p.sessions.filter((s) => !s.endedAt).map((s) => `${shortName(employeeName(s.employeeId))} — «${p.objectName}»`),
    );
    if (stillWorking.length) {
      await alertDialog(
        `Ще йде робота:\n${[...new Set(stillWorking)].map((x) => `• ${x}`).join("\n")}\n\n` +
          `Спершу зупиніть її, інакше години зарахуються до цієї хвилини, а все, що людина напрацює далі, зникне.\n\n` +
          `Відкрийте обʼєкт (список унизу або ✏️ у списку обʼєктів) → прізвище → «🚶 Зняти», ` +
          `або «🕒 Ввести години вручну», якщо знаєте точний час.`,
      );
      haptic("error");
      return;
    }

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

    // An errand still open (no return odometer) means its mileage can't be
    // computed, so it WON'T be excluded from the allowance. Warn so the
    // foreman closes it first if the car really did come back.
    if (openErrand) {
      const ok = await confirmDialog(
        `🚗 Машина ще у роз'їздах (водій ${employeeName(openErrand.driverId)}) — не введено спідометр повернення.\n\n` +
          `Без нього ці км НЕ буде виключено з доплати за виїзд. Відправити все одно?`,
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
        errands,
        objects: buildObjectsPayload(),
        idempotencyKey,
        tripSeq: editingTripSeq ?? undefined,
        // Повернений день минулої дати правиться саме тут. Резерви авто й
        // людей на той день давно неактуальні, а чужа зависла бронь блокувала
        // б повторну відправку назавжди. Сервер приймає цей прапорець лише
        // для дати СТРОГО раніше сьогоднішньої, тож живий день ним не обійти.
        backdated: date < todayISO() ? true : undefined,
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
        errands,
      };
      setSubmittedTrips((prev) => [...prev.filter((t) => t.tripSeq !== res.tripSeq), savedTrip].sort((a, b) => a.tripSeq - b.tripSeq));
      clearDraft();
      // День уже в базі як RTS_SAVE -- дзеркало більше нічого не додає.
      clearMirroredDraft();
      setDayStatus((prev) => (prev ? { ...prev, hasSubmission: true, eventId: res.eventId } : prev));
      logChange("Звіт відправлено");
      // Саме тут, ПІСЛЯ logChange: він щойно підняв прапорець, а день у базі
      // рівно такий, як на екрані.
      setChangedSinceSave(false);
      haptic("success");
      if (fixingReturnedDate) {
        // Виправлений день уже в базі. Затримувати бригадира на екрані
        // підсумку не можна: автозбереження на кроці DONE не працює, а
        // сьогоднішній день лежить лише в `dayStash` -- закритий застосунок
        // забрав би його разом з пам'яттю вкладки. Тож віддаємо конструктор
        // назад одразу, і чернетка сьогоднішнього дня пишеться знову.
        setFixedDayNotice(date);
        exitReturnedDay();
      } else {
        setStep("DONE");
      }
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setSaving(false);
    }
  }

  const backTargets: Partial<Record<Step, Step>> = {
    HUB: "INDEX",
    DONE: "INDEX",
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
    // Leaving the planner's own screen means leaving the planner -- walking
    // out to the index with a plan still loaded in the builder would show it
    // as if it were a trip in progress.
    if (planEditing && step === "HUB") {
      cancelPlanEdit();
      return;
    }
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
      leaveWorksPicker();
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
      if (showAddPersonPicker) {
        setAddPersonSelected([]);
        setAddPersonStart(null);
        setAddPersonStartHint(false);
        setShowAddPersonPicker(false);
        return;
      }
      if (showManualHours) {
        // Step out of the per-person keypad first, then out of the list.
        if (manualHoursEmployeeId) setManualHoursEmployeeId(null);
        else setShowManualHours(false);
        return;
      }
      if (errandMode) {
        setErrandMode(null);
        setErrandDriverId(null);
        return;
      }
      // Годинник дороги тут НЕ пускаємо. Вихід з екрана обʼєкта — це погляд
      // на маршрут, а не рушання: бус лишається там, де стояв. Раніше тут був
      // resume, і бригадир, який просто визирнув з обʼєкта, отримував
      // «ПОВЕРТАЄМОСЬ» з тікаючим годинником, поки бригада працювала.
      // Годинник запускає тільки справжній відʼїзд — вибір куди їхати на
      // цьому ж екрані, «Продовжити рух» або «Рушили на базу».
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
    if (backTargets[step]) {
      setStep(backTargets[step]!);
      return;
    }
    onBack();
  };
  useTelegramBackButton(goBack);

  // "До табеля" has to land on the day's front screen, and which screen that
  // is depends on the day: once anything has been sent, the summary with the
  // trip cards is the front screen -- HUB is only the builder for the leg
  // being assembled, and dropping the foreman there looked like the day had
  // been wiped.
  // "До табеля" means the index -- the day's trips, the builder and the plans
  // -- not the builder for whichever trip happens to be half-made.
  const goHub = () => setStep("INDEX");

  // "Скинути поїздку" rides in the back row so it is in the same spot on every
  // step -- the foreman asked to be able to drop a trip at any moment, not
  // only from the hub. Nothing to throw away means no button; editing an
  // already-sent trip is not a trip in progress, so it does not get one either
  // (that report is the admin's to delete).
  const hasTripInProgress = editingTripSeq === null && (!!carId || employeeIds.length > 0 || plans.length > 0);

  if (step === "DONE" && submittedTrips.length) {
    const pendingTrips = submittedTrips.filter((t) => t.status !== "ЗАТВЕРДЖЕНО");
    const approvedTrips = submittedTrips.filter((t) => t.status === "ЗАТВЕРДЖЕНО");
    const dayFullyApproved = approvedTrips.length > 0 && pendingTrips.length === 0;
    const isMulti = submittedTrips.length > 1;
    // Only meaningful while something is still un-approved: an approved trip
    // plus an older return event is just history, not a call to action.
    const returned = !!dayStatus?.returned && pendingTrips.length > 0;
    return (
      <div>
        <BackRow onBack={goBack} onHome={onBack} onReset={hasTripInProgress ? resetTrip : undefined} />
        <div className="header">
          <h1>
            {returned
              ? "🔴 Повернено на доопрацювання"
              : isMulti
                ? `✅ Поїздки за ${date}`
                : pendingTrips.length
                  ? "✅ Відправлено на підтвердження"
                  : "✅ День затверджено"}
          </h1>
          <div className="hint">
            {returned
              ? `${dayStatus?.returnReason ? `Причина: ${dayStatus.returnReason}. ` : ""}Оберіть поїздку нижче, виправте і надішліть повторно.`
              : pendingTrips.length
                ? "Можна й далі редагувати та надсилати повторно, поки адміністратор не затвердить."
                : "Можна розпочати ще одну поїздку за цей день."}
          </div>
        </div>

        {error && <div className="empty-state">⚠️ {error}</div>}

        {pendingTrips.map((trip) => renderTripCard(trip, true))}

        {editingTripSeq === null && (!!carId || employeeIds.length > 0 || plans.length > 0) && (
          <div className="list" style={{ marginTop: 8 }}>
            <button className="cell" onClick={() => setStep(inProgressResumeStep ?? (tripStartedAt ? tripResumeStep : "HUB"))}>
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
        <BackRow onBack={onBack} onHome={onBack} />
        <div className="header">
          <h1>Дорожній табель</h1>
        </div>
        <div className="empty-state">Завантаження…</div>
      </div>
    );
  }

  const hasBuilderContent = !!carId || employeeIds.length > 0 || plans.length > 0;

  /**
   * The road timesheet's front door.
   *
   * The hub used to be it, but the hub builds ONE trip -- landing there hid
   * the day's other trips behind a back button and buried the planned ones at
   * the bottom of a form. Three things belong on a front door: what is running
   * today, a way to start another, and what is planned next.
   */
  if (step === "INDEX") {
    // The server already filtered: a brigadier gets only their own, an admin
    // gets all. `mine` still separates the admin's own from what they assigned.
    const myIndexPlans = tripPlans.filter((p) => p.mine);
    const otherIndexPlans = tripPlans.filter((p) => !p.mine);
    return (
      <div>
        <BackRow onBack={onBack} onHome={onBack} onReset={hasTripInProgress ? resetTrip : undefined} />
        <div className="header">
          <h1>Дорожній табель</h1>
          <div className="hint">{date}</div>
        </div>

        {error && <div className="empty-state">⚠️ {error}</div>}

        {fixedDayNotice && !fixingReturnedDate && (
          <div className="empty-state" style={{ textAlign: "left" }}>
            ✅ <b>День {fixedDayNotice} надіслано повторно.</b> Ви знову на {date}.
          </div>
        )}

        {/* Те саме попередження, що й на решті кроків: з INDEX починається
            виправлення, і саме тут найлегше забути, що дата вже не сьогоднішня. */}
        {fixingReturnedDate && (
          <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
            ✏️ <b>Ви виправляєте день {fixingReturnedDate}</b>
            {dayStash?.tripStartedAt || dayStash?.carId || (dayStash?.plans?.length ?? 0) > 0
              ? " — сьогоднішній день відкладено і чекає, нічого з нього не втрачено."
              : ""}
            <div style={{ marginTop: 8 }}>
              <button className="back-btn" onClick={exitReturnedDay}>
                ↩️ Повернутись до {todayISO()}
              </button>
            </div>
          </div>
        )}

        {dayStatus?.returned && (
          <div className="empty-state" style={{ textAlign: "left" }}>
            🔴 <b>Звіт повернено на доопрацювання.</b>
            {dayStatus.returnReason ? ` Причина: ${dayStatus.returnReason}.` : ""} Відкрийте поїздку нижче, виправте і надішліть
            повторно.
          </div>
        )}

        {/* Повернені дні інших дат. Сьогоднішній і так видно нижче -- тут
            саме ті, до яких з цього екрана не було жодного шляху. */}
        {returnedDays.filter((d) => d.date !== date).length > 0 && (
          <>
            <div className="section-title">↩️ Повернені на редагування</div>
            <div className="list">
              {returnedDays
                .filter((d) => d.date !== date)
                .map((d) => (
                  <button key={d.date} className="cell" onClick={() => openReturnedDay(d.date)}>
                    <span className="cell-title">
                      📅 {d.date}
                      {d.reason ? <span className="cell-sub" style={{ display: "block" }}>{d.reason}</span> : null}
                    </span>
                    <span className="badge danger">{d.trips} {plural(d.trips, "поїздка", "поїздки", "поїздок")}</span>
                  </button>
                ))}
            </div>
            <div className="hint" style={{ padding: "6px 16px 0" }}>
              Натисніть дату — табель відкриється на ній, і поїздку можна буде виправити та надіслати повторно.
            </div>
          </>
        )}

        <div className="section-title">Поточні поїздки</div>
        {submittedTrips.length === 0 && !hasBuilderContent && <div className="empty-state">Сьогодні поїздок ще немає.</div>}
        {submittedTrips.map((trip) => renderTripCard(trip, trip.status !== "ЗАТВЕРДЖЕНО"))}
        {/* Whatever the builder is holding, there is ALWAYS a way back into it
            from here, and always a way to drop it.
            This card used to hide while a plan or a submitted trip was being
            edited -- but a restored draft opens on this screen with those
            flags still set, so "створити нову" refused ("вже є незавершена
            поїздка") while the trip it was talking about was nowhere on
            screen and the 🗑 it pointed at lives on another step. A dead end
            with no way out but clearing the browser data. */}
        {hasBuilderContent && (
          <div className="list" style={{ marginTop: 8 }}>
            <button
              className="cell"
              onClick={() =>
                setStep(
                  planEditing || editingTripSeq !== null
                    ? "HUB"
                    : (inProgressResumeStep ?? (tripStartedAt ? tripResumeStep : "HUB")),
                )
              }
            >
              <span className="cell-title">
                {planEditing ? "📋 Незавершений план" : editingTripSeq !== null ? "✏️ Редагування поїздки" : `🚧 ${cars.find((c) => c.id === carId)?.name ?? "Нова поїздка"}`}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="badge warn">в процесі</span>
                <span className="cell-sub">▶️ Продовжити</span>
              </span>
            </button>
            <button className="cell" onClick={resetTrip}>
              <span className="cell-title" style={{ color: "#d70015" }}>🗑 Скинути незавершене</span>
              <span className="cell-sub">звільнить авто й людей ›</span>
            </button>
          </div>
        )}
        {submittedTrips.length > 0 && (
          <div style={{ padding: "8px 16px 0" }}>
            <button className="chip" onClick={() => setStep("DONE")}>📊 Підсумок дня та нарахування</button>
          </div>
        )}

        <div style={{ padding: "12px 16px" }}>
          <button className="bulk-select-btn" onClick={startNewTrip}>
            ➕ Створити нову поїздку
          </button>
        </div>

        <div className="section-title">Заплановані виїзди</div>
        {myIndexPlans.length === 0 && otherIndexPlans.length === 0 && (
          <div className="empty-state">Нічого не заплановано.</div>
        )}
        {myIndexPlans.map(renderPlanCard)}
        {otherIndexPlans.length > 0 && (
          <>
            <div className="hint" style={{ padding: "4px 16px 0" }}>Призначено бригадирам</div>
            {otherIndexPlans.map(renderPlanCard)}
          </>
        )}
        <div style={{ padding: "8px 16px 24px" }}>
          <button className="bulk-select-btn" onClick={() => openPlanner(null)}>
            📋 Запланувати виїзд
          </button>
        </div>

        <div className="list">
          <button className="cell" onClick={onOpenRetro}>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="setup-icon accent-teal">🗓</span>
              <span className="cell-title">Внести день заднім числом</span>
            </span>
            <span className="cell-sub">без таймерів ›</span>
          </button>
        </div>

        <MainButton text="🏠 До меню" onClick={onBack} />
      </div>
    );
  }

  const allObjectsPlanned = plans.length > 0 && plans.every((p) => p.works.length > 0);
  const readyToDepart = !!carId && !!odoStart && employeeIds.length > 0 && allObjectsPlanned;
  const readinessScore = [!!carId && !!odoStart, employeeIds.length > 0, plans.length > 0, allObjectsPlanned].filter(Boolean).length;
  const dayIsEmpty = !carId && !employeeIds.length && !plans.length;
  // "Repeat the last trip" is only a guess from history, so it stands down
  // whenever a plan -- made deliberately, for this very trip -- exists, and
  // never appears while a plan is being written.
  const showCopySuggestion = !!lastTrip && dayIsEmpty && !tripPlans.some((p) => p.mine) && !planEditing;

  // The dictionary order means nothing to a foreman: on nearly every day they
  // take the same car as last time, and a car another brigade already holds is
  // the one row they can never pick. So the previous car leads, the reserved
  // ones sink to the bottom, and everything else keeps the dictionary order.
  const carsInPickOrder = cars
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const takenA = takenCars.has(a.c.id) ? 1 : 0;
      const takenB = takenCars.has(b.c.id) ? 1 : 0;
      if (takenA !== takenB) return takenA - takenB;
      const lastA = a.c.id === lastTripCarId ? 0 : 1;
      const lastB = b.c.id === lastTripCarId ? 0 : 1;
      if (lastA !== lastB) return lastA - lastB;
      return a.i - b.i;
    })
    .map((x) => x.c);

  return (
    <div>
      <BackRow
        onBack={goBack}
        onHub={step === "HUB" && !submittedTrips.length ? undefined : goHub}
        onHome={onBack}
        onReset={hasTripInProgress ? resetTrip : undefined}
      />
      {/* Заголовок і «редагувати поїздку» в один рядок: вони про одне й те
          саме, а окремим рядком кнопка з'їдала висоту екрана без потреби. */}
      <div className="header header-row">
        <h1>Дорожній табель</h1>
        {step === "DRIVE" && (
          <button className="back-btn" onClick={() => setStep("HUB")}>✏️ Редагувати поїздку</button>
        )}
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {/* Поки правиться чужа дата, це має бути видно з будь-якого кроку: інакше
          бригадир дописує сьогоднішній день у вчорашній, не помічаючи. */}
      {fixingReturnedDate && (
        <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
          ✏️ <b>Ви виправляєте день {fixingReturnedDate}</b>
          {dayStash?.tripStartedAt || dayStash?.carId || (dayStash?.plans?.length ?? 0) > 0
            ? " — сьогоднішній день відкладено і чекає, нічого з нього не втрачено."
            : ""}
          <div style={{ marginTop: 8 }}>
            <button className="back-btn" onClick={exitReturnedDay}>
              ↩️ Повернутись до {todayISO()}
            </button>
          </div>
        </div>
      )}

      {/* Stays visible on every step while the day is in the returned state,
          not just on the one screen it was opened from -- the foreman is
          walking back through the day looking for what to fix, and the
          reason has to still be in front of them when they find it. */}
      {dayStatus?.returned && (
        <div className="empty-state" style={{ textAlign: "left" }}>
          🔴 <b>Звіт повернено на доопрацювання.</b>
          {dayStatus.returnReason ? ` Причина: ${dayStatus.returnReason}.` : ""} Редагується так само, як перед першою відправкою —
          виправте і надішліть повторно.
        </div>
      )}

      {submittedEditBanner && !dayStatus?.returned && (
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
          <div className="section-title row">
            <span>{planEditing ? "Планування наступного виїзду" : `Поточна поїздка · ${date}`}</span>
            {!tripStartedAt && !planEditing && <span className="hint">{readinessScore}/4 готово</span>}
          </div>
          {!tripStartedAt && !planEditing && (
            <div className="progress-track">
              <div className={`progress-fill ${readinessScore === 4 ? "done" : ""}`} style={{ width: `${(readinessScore / 4) * 100}%` }} />
            </div>
          )}

          {restoredBanner && !planEditing && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              🔄 Відновлено чернетку дня, яку не встигли відправити.
            </div>
          )}

          {/* Without this the screen is indistinguishable from a real day being
              built -- same pickers, same car, same people. */}
          {planEditing && (
            <div className="empty-state" style={{ textAlign: "left" }}>
              📋 <b>{editingPlanId ? "Редагуєте запланований виїзд." : "Плануєте наступний виїзд."}</b> Оберіть авто, людей, обʼєкти
              й роботи кнопками нижче, потім «{editingPlanId ? "Зберегти зміни" : "Зберегти план"}». Авто й люди при цьому{" "}
              <b>не бронюються</b> — їх можна планувати, навіть якщо зараз вони в дорозі.
              {isAdmin && (
                <div style={{ marginTop: 10 }}>
                  <div className="hint" style={{ fontWeight: 600 }}>Кому плануєте</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                    <button
                      className={`chip ${planForemanTgId === null ? "selected" : ""}`}
                      onClick={() => setPlanForemanTgId(null)}
                    >
                      Собі
                    </button>
                    {foremen.map((f) => (
                      <button
                        key={f.tgId}
                        className={`chip ${planForemanTgId === f.tgId ? "selected" : ""}`}
                        onClick={() => setPlanForemanTgId(f.tgId)}
                      >
                        {shortName(f.name)}
                      </button>
                    ))}
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    Бригадиру прийде повідомлення в Telegram.
                  </div>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <button className="chip" onClick={cancelPlanEdit}>Скасувати</button>
              </div>
            </div>
          )}

          {showCopySuggestion && lastTrip && (
            <div className="suggestion-card">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="setup-icon accent-blue" style={{ width: 34, height: 34, fontSize: 16 }}>
                  🔁
                </span>
                <div className="cell-title">Повторити останній виїзд?</div>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {lastTrip.date} · {cars.find((c) => c.id === lastTrip.carId)?.name ?? lastTrip.carId} · {nPeople(lastTrip.employeeIds.length)} ·{" "}
                {nObjects(lastTrip.objects.length)}
              </div>
              <div style={{ marginTop: 6 }}>
                <button className="chip" onClick={() => setLastTripExpanded((v) => !v)}>
                  {lastTripExpanded ? "▾ Сховати деталі" : "▸ Показати деталі"}
                </button>
              </div>
              {lastTripExpanded && (
                <div style={{ marginTop: 10 }}>
                  <div className="hint" style={{ fontWeight: 600 }}>👥 Люди</div>
                  <ul className="bullets">
                    {lastTrip.employeeIds.length ? (
                      lastTrip.employeeIds.map((id) => <li key={id}>{employeeName(id)}</li>)
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                  <div className="hint" style={{ fontWeight: 600, marginTop: 14 }}>📍 Обʼєкти та роботи</div>
                  {lastTrip.objects.map((o) => (
                    <div key={o.objectId} style={{ marginTop: 10 }}>
                      <div className="hint" style={{ fontWeight: 600 }}>{o.objectName}</div>
                      <ul className="bullets">
                        {o.works.length ? o.works.map((w, i) => <li key={i}>{w.workName}</li>) : <li>без робіт</li>}
                      </ul>
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
                <span className="cell-title">Авто</span>
              </span>
              {carId && odoStart ? (
                <span className="badge ok">
                  {cars.find((c) => c.id === carId)?.name ?? ""} · старт {odoStart} км
                </span>
              ) : (
                <span className="badge">не обрано</span>
              )}
            </button>
            <button className="cell" onClick={() => { setEditReturnStep("HUB"); setStep("PICK_PEOPLE"); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-purple">👥</span>
                <span className="cell-title">Люди</span>
              </span>
              {employeeIds.length ? <span className="badge ok">{employeeIds.length} обрано</span> : <span className="badge">не обрано</span>}
            </button>
            <button className="cell" onClick={() => setStep("PICK_OBJECTS")}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-orange">📍</span>
                <span className="cell-title">Обʼєкти</span>
              </span>
              {plans.length ? <span className="badge ok">{plans.length} обрано</span> : <span className="badge">не обрано</span>}
            </button>
            <button className="cell" onClick={() => plans.length && setStep("PLAN")} disabled={!plans.length}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-teal">🧱</span>
                <span className="cell-title">Роботи</span>
              </span>
              {plans.length ? (
                <span className={`badge ${allObjectsPlanned ? "ok" : ""}`}>
                  {plans.filter((p) => p.works.length).length}/{plans.length} з роботами
                </span>
              ) : (
                <span className="badge">спочатку обʼєкти</span>
              )}
            </button>
          </div>
          {/* Escape hatch from the live, step-by-step day above: a day that's
              already been worked can't be re-lived with timers, so it gets a
              flat form where hours are typed in instead of measured. Not while
              planning -- a plan has no day to enter after the fact. */}
          {!planEditing && (
            <div className="list">
              <button className="cell" onClick={onOpenRetro}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-teal">🗓</span>
                  <span className="cell-title">Внести день заднім числом</span>
                </span>
                <span className="cell-sub">без таймерів ›</span>
              </button>
            </div>
          )}

          {tripStartedAt && (
            <>
              <div className="section-title">Хто де зараз</div>
              <div className="list">
                {employeeIds.map((id) => {
                  const atPlan = plans.find((p) => p.here.includes(id));
                  // Neither in the bus nor at an object is a real state, not a
                  // glitch: it is where "висаджено по дорозі" and "знято з
                  // обʼєкта (не в бус)" leave a person. It used to render as a
                  // bare "❓", which reads like the app lost them -- so say what
                  // it means. Their hours are already closed and counted; this
                  // only says nobody is carrying them any more.
                  const label = onboard.includes(id) ? "🚗 в дорозі" : atPlan ? `📍 ${atPlan.objectName}` : "🏁 поза поїздкою";
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

          {planEditing ? (
            <MainButton
              text={editingPlanId ? "💾 Зберегти зміни" : "💾 Зберегти план"}
              onClick={savePlan}
              disabled={!carId && !employeeIds.length && !plans.length}
            />
          ) : tripStartedAt ? (
            <MainButton
              text="↩️ Повернутися до поїздки"
              onClick={() => {
                // AT_OBJECT малює конкретний обʼєкт, тож без цього повернення
                // на нього дало б порожній екран.
                if (tripResumeStep === "AT_OBJECT" && carAtObjectId) {
                  setAtObjectId(carAtObjectId);
                  setAtObjectReturnStep("DRIVE");
                }
                setStep(tripResumeStep);
              }}
            />
          ) : (
            <MainButton text="Далі → Перевірка перед виїздом" onClick={() => setStep("READY")} disabled={!readyToDepart} />
          )}
        </>
      )}

      {step === "PICK_CAR" && (
        <>
          <div className="step-badge">🚙 АВТО</div>
          <div className="list">
            {carsInPickOrder.map((c) => {
              // In plan mode a car that is out on the road right now is still a
              // perfectly good choice for the next trip, so the lock does not
              // apply -- see openPlanner.
              const takenBy = planEditing ? undefined : takenCars.get(c.id);
              const plannedBy = plannedCarBy.get(c.id);
              // Two plans must not claim the same bus -- that is the whole
              // reason plans are shared. But a plan for the next trip never
              // blocks TODAY's real one: the day always wins over an intention.
              const lockedByPlan = planEditing && !!plannedBy;
              return (
                <button
                  key={c.id}
                  className={`cell ${carId === c.id ? "selected" : ""}`}
                  onClick={() => {
                    if (takenBy || lockedByPlan) return;
                    if (c.id !== carId) {
                      setOdoStart("");
                      setOdoStartPhoto(null);
                    }
                    setCarId(c.id);
                    haptic("selection");
                  }}
                  disabled={!!takenBy || lockedByPlan}
                  style={takenBy || lockedByPlan ? { opacity: 0.4 } : undefined}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="setup-icon accent-blue">🚙</span>
                    <span className="cell-title">
                      {c.name} {c.plate ? <span className="hint">{c.plate}</span> : null}
                    </span>
                  </span>
                  {takenBy ? (
                    <span className="badge warn">🔒 {surnameInitial(takenBy)}</span>
                  ) : plannedBy ? (
                    <span className={`badge ${lockedByPlan ? "warn" : ""}`}>📋 {surnameInitial(plannedBy)}</span>
                  ) : c.id === lastTripCarId ? (
                    <span className="badge">минулого разу</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <MainButton text="Далі → Одометр" onClick={() => setStep("ODO_START")} disabled={!carId} />
        </>
      )}

      {step === "ODO_START" && (
        <>
          <div className="step-badge">🚙 ОДОМЕТР НА СТАРТІ</div>
          {/* Which car this reading belongs to. The picker is one back-tap
              away, but the number being typed here is meaningless without
              knowing whose odometer it is -- and a wrong car is only caught
              at this screen, before the reservation is taken. */}
          <div className="list">
            <div className="cell">
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="setup-icon accent-blue">🚙</span>
                <span className="cell-title">
                  {cars.find((c) => c.id === carId)?.name ?? carId}{" "}
                  {cars.find((c) => c.id === carId)?.plate ? (
                    <span className="hint">{cars.find((c) => c.id === carId)?.plate}</span>
                  ) : null}
                </span>
              </span>
            </div>
          </div>
          {lastOdometer[carId] !== undefined && (
            <div className="chip-row">
              <button className="chip" onClick={() => setOdoStart(String(lastOdometer[carId]))}>
                ↩︎ Підставити {lastOdometer[carId]} км
              </button>
            </div>
          )}
          <div className={`big-number ${odoStart ? "" : "empty"}`}>{odoStart || "0"} км</div>
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
          <NumericKeypad value={odoStart} onChange={setOdoStart} decimal={false} />
          {PHOTOS_ENABLED && (
            <div className="field">
              {odoStartPhoto ? (
                <div className="badge ok">📷 Фото додано</div>
              ) : (
                <>
                  <PhotoButton text="📷 Зняти спідометр" disabled={uploadingPhoto} onPick={(file) => uploadPhoto(file, "start")} />
                  <div className="hint" style={{ marginTop: 6 }}>Не обовʼязково</div>
                </>
              )}
            </div>
          )}
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
          <div className="section-title">Люди в поїздці</div>
          {/* Money, not styling: the brigadier's 20% is paid per object and
              only when they have hours there. A trip without one is a real
              choice, but it used to be an invisible one. */}
          {employeeIds.length > 0 && !employeeIds.some((id) => roleFor(id) === "бригадир") && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ⚠️ У поїздці немає бригадира — 20% за ведення дня отримаєте ви як той, хто веде цей день. Бригада ділить свої 70%.
            </div>
          )}
          {employeeIds.length > 0 && (
            <div className="picked-panel">
              <div className="picked-head">
                <button className="picked-toggle" onClick={() => setSelectedPeopleExpanded((v) => !v)}>
                  {selectedPeopleExpanded ? "▾" : "▸"} Обрано {employeeIds.length}
                </button>
                <button className="back-btn danger-btn" onClick={() => removeEmployeesFromTrip(employeeIds, "Вибір людей очищено")}>
                  🗑 Очистити
                </button>
              </div>
              {selectedPeopleExpanded && (
                <div className="picked-list">
                  {employeeIds.map((id) => (
                    <div className="picked-item" key={id}>
                      <span>{shortName(employeeName(id))}</span>
                      <button
                        className="picked-remove"
                        aria-label={`Прибрати ${employeeName(id)}`}
                        onClick={() => removeEmployeesFromTrip([id], `${employeeName(id)} — знято з поїздки`)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
              <div className="confirm-row">
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
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {g.members.length > selectable.length && (
                            <span className="hint">{g.members.length - selectable.length} зайнято</span>
                          )}
                          <span className="badge">
                            {selectedCount}/{selectable.length}
                          </span>
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
                          {/* Role order comes from groupByBrigade; this only sinks
                              the people another brigade is holding, who can't be
                              picked at all, below the ones who can. */}
                          {[...g.members]
                            .sort((a, b) => (busyEmployees.has(a.id) ? 1 : 0) - (busyEmployees.has(b.id) ? 1 : 0))
                            .map((emp) => {
                            const busyBy = planEditing ? undefined : busyEmployees.get(emp.id);
                            const plannedBy = plannedEmployeeBy.get(emp.id);
                            // Same rule as the cars: a plan blocks another
                            // plan, never today's trip.
                            const lockedByPlan = planEditing && !!plannedBy;
                            const checked = employeeIds.includes(emp.id);
                            return (
                              <button
                                key={emp.id}
                                className={`cell ${checked ? "selected" : ""}`}
                                onClick={() => toggleEmployee(emp.id)}
                                disabled={!!busyBy || lockedByPlan}
                                style={busyBy || lockedByPlan ? { opacity: 0.4 } : undefined}
                              >
                                <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                  {shortName(emp.name)}
                                </span>
                                <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                                  {plannedBy && !busyBy && (
                                    <span className={`badge ${lockedByPlan ? "warn" : ""}`}>📋 {surnameInitial(plannedBy)}</span>
                                  )}
                                  {busyBy ? (
                                    <span className="badge warn">🔒 {surnameInitial(busyBy)}</span>
                                  ) : (
                                    <span className={roleTagClass(employeeRole(emp))}>{employeeRole(emp)}</span>
                                  )}
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
          <div className="section-title">Обʼєкти маршруту</div>
          {plans.length > 0 && (
            <div className="picked-panel">
              <div className="picked-head">
                <button className="picked-toggle" onClick={() => setSelectedObjectsExpanded((v) => !v)}>
                  {selectedObjectsExpanded ? "▾" : "▸"} Обрано {plans.length}
                </button>
                <button className="back-btn danger-btn" onClick={clearAllObjects}>
                  🗑 Очистити
                </button>
              </div>
              {selectedObjectsExpanded && (
                <div className="picked-list">
                  {plans.map((p) => (
                    <div className="picked-item" key={p.objectId}>
                      <span>{p.objectName}</span>
                      <button className="picked-remove" aria-label={`Прибрати ${p.objectName}`} onClick={() => removeObjectFromRoute(p.objectId)}>
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                      {expanded ? "▾" : "▸"} {g.title}
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
                            <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                              {obj.name}
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
                      openWorksPicker(plan.objectId, "PLAN");
                    }}
                  >
                    <span className="cell-title">{plan.objectName}</span>
                    <span className={`badge ${ready ? "ok" : ""}`}>{plan.works.length ? nWorks(plan.works.length) : "не обрано"}</span>
                  </button>
                  <button className="cell-action" onClick={() => confirmRemoveObjectFromRoute(plan.objectId)} title="Прибрати з маршруту">
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
          {planFor(planObjectId).works.length > 0 && (
            <div className="picked-panel">
              <div className="picked-head">
                <button className="picked-toggle" onClick={() => setSelectedWorksExpanded((v) => !v)}>
                  {selectedWorksExpanded ? "▾" : "▸"} Обрано {planFor(planObjectId).works.length}
                </button>
                <button className="back-btn danger-btn" onClick={() => clearWorks(planObjectId)}>
                  🗑 Очистити
                </button>
              </div>
              {selectedWorksExpanded && (
                <div className="picked-list">
                  {planFor(planObjectId).works.map((w) => (
                    <div className="picked-item" key={w.workId}>
                      <span>{w.workName}</span>
                      <button
                        className="picked-remove"
                        aria-label={`Прибрати ${w.workName}`}
                        onClick={() => removeWork(planObjectId, w.workId)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <input className="search-box" placeholder="Пошук роботи…" value={planWorksSearch} onChange={(e) => setPlanWorksSearch(e.target.value)} />
          <div className="list">
            {groupWorks(works.filter((w) => w.name.toLowerCase().includes(planWorksSearch.toLowerCase()))).map((g) => {
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
                        {...tapProps(() => toggleAllWorksInCategory(planObjectId, g.members))}
                      >
                        {allSelected ? "✕ Зняти всі в категорії" : "✓ Обрати всі в категорії"}
                      </button>
                      {/* Named subcategories lead: they are the structure of the
                          category, and a run of loose works before them buried
                          them somewhere down the list. Works that named no
                          subcategory follow underneath. */}
                      {g.subgroups.map((sg) => {
                        const subExpanded = expandedWorkSubcategoryId === sg.id || !!planWorksSearch;
                        const subSelected = sg.members.filter((w) => planFor(planObjectId).works.some((pw) => pw.workId === w.id)).length;
                        const subAllSelected = sg.members.length > 0 && subSelected === sg.members.length;
                        return (
                          <div key={sg.id}>
                            <button className="cell subcat-cell" onClick={() => setExpandedWorkSubcategoryId(subExpanded ? null : sg.id)}>
                              <span className="cell-title">
                                {subExpanded ? "▾" : "▸"} {sg.title}
                              </span>
                              <span className="badge">
                                {subSelected}/{sg.members.length}
                              </span>
                            </button>
                            {subExpanded && (
                              <div style={{ paddingLeft: 12 }}>
                                <button
                                  className={`bulk-select-btn ${subAllSelected ? "active" : ""}`}
                                  {...tapProps(() => toggleAllWorksInCategory(planObjectId, sg.members))}
                                >
                                  {subAllSelected ? "✕ Зняти всі в підкатегорії" : "✓ Обрати всі в підкатегорії"}
                                </button>
                                {sg.members.map((w) => workPickerCell(planObjectId, w))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {g.direct.map((w) => workPickerCell(planObjectId, w))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-title">Нотатки (необовʼязково)</div>
          <textarea
            className="notes-textarea"
            value={planFor(planObjectId).notes}
            onChange={(e) => updateNotes(planObjectId, e.target.value)}
            placeholder="Коментар до обʼєкта…"
          />
          <MainButton
            text="Готово"
            onClick={() => {
              // «Готово» -- це «так, я обрав». Тут нічого не питаємо й нічого
              // не відкочуємо, лише забуваємо знімок.
              logChange(`Роботи на "${planFor(planObjectId).objectName}": ${planFor(planObjectId).works.length}`);
              setWorksBeforePicker(null);
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
                {/* Перемикач обʼєктів поїздки.
                    «До обіду зробили сім» часто стосується обʼєкта, з якого
                    вже поїхали, а перемкнути обʼєкт на екрані обʼєкта -- це
                    `switchAtObject`, тобто реальний перехід бригади, а не
                    перегляд. Ці чіпи міняють лише те, чиї обсяги ти зараз
                    вводиш, і не чіпають ані `atObjectId`, ані таймери. */}
                {plans.length > 1 && (
                  <div className="chip-row" style={{ padding: "0 16px 8px" }}>
                    {plans.map((p) => {
                      const stat = volumeStat(p);
                      return (
                        <button
                          key={p.objectId}
                          className={`chip ${p.objectId === planObjectId ? "selected" : ""}`}
                          onClick={() => setPlanObjectId(p.objectId)}
                        >
                          {p.objectName} {stat.filled}/{stat.total}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="section-title row">
                  <span>Обсяги</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`badge ${unfilled.length ? "" : "ok"}`}>
                      заповнено {plan.works.length - unfilled.length}/{plan.works.length}
                    </span>
                    <button className="chip chip-sm" onClick={() => setBulkVolumeInput(bulkVolumeInput === null ? "" : null)}>
                      Масовий ввід
                    </button>
                  </span>
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
                {unfilled.length > 0 && (
                  <div style={{ padding: "0 16px 8px" }}>
                    <button
                      className="chip selected"
                      style={{ width: "100%" }}
                      onClick={() => openVolumeDetail(planObjectId, unfilled[0])}
                    >
                      ✍️ Заповнити підряд ({unfilled.length})
                    </button>
                  </div>
                )}
                <div className="list">
                  {plan.works.map((w) => {
                    const filled = !!w.volume && w.volume !== "?";
                    return (
                      <div key={w.workId} className="cell-row">
                        <button className="cell" onClick={() => openVolumeDetail(planObjectId, w)}>
                          <span className="cell-title">{w.workName}</span>
                          {filled ? (
                            <span className="badge ok">
                              {w.volume} {w.unit}
                            </span>
                          ) : (
                            <span className="badge warn">🟡 Введи</span>
                          )}
                        </button>
                        {/* Хрестик лише в незаповнених.
                            Роботу, яку додали й не встигли зробити, досі
                            прибирали тільки через «✏️ Додати/змінити роботи»
                            -- тобто виходом з екрана обсягів у пікер на сотні
                            рядків. Заповнена робота хрестика не має навмисно:
                            там уже є цифра, і зняти її одним тапом означало б
                            стерти зроблене. Таку прибирають у пікері, свідомо. */}
                        {!filled && (
                          <button
                            className="cell-action"
                            title="Прибрати роботу"
                            onClick={async () => {
                              const ok = await confirmDialog(
                                `Прибрати роботу «${w.workName}» з «${plan.objectName}»?\n\n` +
                                  `Її не буде у звіті й за неї не нарахується.`,
                              );
                              if (!ok) return;
                              removeWork(planObjectId, w.workId);
                              logChange(`${plan.objectName}: прибрано роботу «${w.workName}»`);
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {unfilled.length > 0 && (
                  <div className="hint" style={{ padding: "8px 16px" }}>
                    🟡 Без обсягу:
                    <ul className="bullets">
                      {unfilled.map((w) => (
                        <li key={w.workId}>{w.workName}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <MainButton text="Зберегти (можна пізніше)" onClick={() => setStep(volumesReturnStep)} />
              </>
            );
          })()}
        </>
      )}

      {step === "PLAN_VOLUMES" && planObjectId && planVolumeWorkId && (
        <>
          {(() => {
            const plan = planFor(planObjectId);
            const work = plan.works.find((w) => w.workId === planVolumeWorkId)!;
            const total = plan.works.length;
            const filled = plan.works.filter((w) => w.volume && w.volume !== "?").length;
            const index = plan.works.findIndex((w) => w.workId === planVolumeWorkId);
            // Whether anything else still needs a number, ignoring this work --
            // it decides if "далі" has anywhere to go.
            const othersLeft = plan.works.some((w) => w.workId !== planVolumeWorkId && (!w.volume || w.volume === "?"));
            return (
              <>
                <div className="step-badge">ОБСЯГ РОБОТИ</div>
                <div className="section-title row">
                  <span>
                    Робота {index + 1} з {total}
                  </span>
                  <span className={`badge ${filled === total ? "ok" : ""}`}>
                    заповнено {filled}/{total}
                  </span>
                </div>
                <div className="section-title">🛠 {work.workName}</div>
                <div className={`big-number ${volumeBuffer ? "" : "empty"}`}>
                  {volumeBuffer || "0"} {work.unit}
                </div>
                <div style={{ textAlign: "center", padding: "0 16px 8px" }}>
                  <button className="back-btn" onClick={() => (othersLeft ? saveVolumeAndNext(true) : saveVolumeDetail(true))}>
                    ❓ Обсяг ще невідомий — заповнити пізніше
                  </button>
                </div>
                <NumericKeypad value={volumeBuffer} onChange={setVolumeBuffer} />
                {othersLeft && (
                  <div style={{ textAlign: "center", padding: "0 16px 8px" }}>
                    <button className="back-btn" onClick={() => saveVolumeDetail(false)} disabled={!volumeBuffer}>
                      💾 Зберегти й до списку
                    </button>
                  </div>
                )}
                <MainButton
                  text={othersLeft ? "Зберегти й далі →" : "💾 Зберегти обсяг"}
                  onClick={() => (othersLeft ? saveVolumeAndNext(false) : saveVolumeDetail(false))}
                  disabled={!volumeBuffer}
                />
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
                  {cars.find((c) => c.id === carId)?.name} · старт {odoStart} км
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
                  <ul className="bullets">
                    {[...employeeIds]
                      .sort((a, b) => roleRank(roleFor(a)) - roleRank(roleFor(b)))
                      .map((id) => (
                        <li key={id}>
                          {employeeName(id)}
                          {roleFor(id) !== "робітник" && <span className={roleTagClass(roleFor(id))} style={{ marginLeft: 6 }}>{roleFor(id)}</span>}
                        </li>
                      ))}
                  </ul>
                ) : (
                  <div className="hint">Нікого не обрано</div>
                )}
              </div>
            )}
          </div>
          {!employeeIds.some((id) => roleFor(id) === "бригадир") && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ⚠️ У поїздці немає бригадира — 20% за ведення дня отримаєте ви як той, хто веде цей день. Бригада ділить свої 70%.
            </div>
          )}
          <div className="section-title">Обʼєкти · роботи</div>
          <div className="list">
            {plans.map((p) => {
              const expanded = readyExpandedObjectId === p.objectId;
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button className="cell" onClick={() => setReadyExpandedObjectId(expanded ? null : p.objectId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {p.objectName}
                      </span>
                      <span className="badge">{p.works.length ? nWorks(p.works.length) : "не обрано"}</span>
                    </button>
                    <button
                      className="cell-action"
                      onClick={() => {
                        openWorksPicker(p.objectId, "READY");
                      }}
                      title="Редагувати"
                    >
                      ✏️
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      {p.works.length ? (
                        <ul className="bullets">
                          {p.works.map((w) => (
                            <li key={w.workId}>{w.workName}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="hint">Робіт не обрано</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <MainButton text="🚗 Виїхати" onClick={startDrive} />
        </>
      )}

      {step === "DRIVE" && nextUnvisited && !driveHeadingTo && (
        <>
          <div style={{ textAlign: "center" }}>
            <div className="step-badge">🚗 КУДИ ЇДЕМО?</div>
          </div>
          <div className="hint" style={{ padding: "8px 16px", textAlign: "center" }}>
            Оберіть обʼєкт — з цієї миті піде час у дорозі.
          </div>
          <div className="list">
            {plans.map((p) => (
              <button
                key={p.objectId}
                className="cell"
                onClick={() => {
                  setHeadingToObjectId(p.objectId);
                  departFromObject();
                  haptic("selection");
                }}
              >
                <span className="cell-title">
                  {p.noWork ? "⏭" : p.visited ? "✅" : "📍"} {p.objectName}
                </span>
                <span className="badge">
                  {p.noWork
                    ? "без робіт"
                    : p.visited && (p.sessions.length || p.here.length)
                      ? "вже були"
                      : p.visited
                        ? "були, не працювали"
                        : p.works.length
                          ? nWorks(p.works.length)
                          : "не обрано"}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === "DRIVE" && (!nextUnvisited || driveHeadingTo) && (
        <>
          <div style={{ textAlign: "center" }}>
            <div className="step-badge">🚗 ПОЇЗДКА</div>
          </div>
          {/* Машина ліворуч, годинник праворуч. Дорога під колесами біжить,
              поки сегмент іде, і завмирає, коли бус стоїть — видно з одного
              погляду, чи час зараз рахується, без жодного підпису. */}
          <div className="drive-hero">
            <div className={`drive-road ${drivingSegmentStartedAt ? "moving" : ""}`}>
              <span className="drive-car">🚗</span>
            </div>
            <div className="drive-clock">
              <div className="drive-state">{nextUnvisited ? "В ДОРОЗІ" : "ПОВЕРТАЄМОСЬ"}</div>
              <div className="timer-big">
                {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
              </div>
            </div>
          </div>
          {!nextUnvisited && (
            <div className="hint" style={{ textAlign: "center" }}>
              Усі обʼєкти відвідано — час повертатись на базу
              {(() => {
                // On the way back the crew is usually still on site: saying so
                // here stops "повертаємось" from reading as "the day is over".
                const left = plans.reduce((a, p) => a + p.here.length, 0);
                return left > 0 ? ` · на обʼєктах ще ${nPeople(left)} — заберіть їх` : "";
              })()}
            </div>
          )}
          {nextUnvisited && driveHeadingTo && (
            <div className="hint drive-destination">Прямуємо до 📍 {driveHeadingTo.objectName}</div>
          )}
          {/* Дві дії поїздки -- обидві рідкісні, тож маленькі, приглушені й
              під пунктом призначення, а не окремою секцією над маршрутом,
              де вони важили більше за сам маршрут. */}
          <div className="drive-actions">
            {nextUnvisited && driveHeadingTo && (
              <button
                className="chip chip-sm chip-ghost"
                onClick={() => {
                  // Back to choosing: the clock pauses again until the new
                  // destination is picked, exactly as when leaving base.
                  pauseDrivingSegment();
                  setHeadingToObjectId("");
                }}
              >
                🔀 Зміна маршруту
              </button>
            )}
            <button className="chip chip-sm chip-ghost" onClick={() => setShowRoadsideActions((v) => !v)}>
              🚏 {showRoadsideActions ? "Сховати" : "Підібрати/висадити"}
            </button>
          </div>

          {showRoadsideActions &&
            (() => {
              // Only people nobody else is holding and who are not already in
              // the car or standing at an object -- the rest cannot be picked
              // up anyway, so listing them would only make the list longer.
              const availableToPickUp = employees.filter(
                (e) => !onboard.includes(e.id) && !plans.some((p) => p.here.includes(e.id)) && !busyEmployees.has(e.id),
              );
              const onboardEmployees = onboard
                .map((id) => employees.find((e) => e.id === id))
                .filter((e): e is Employee => !!e);
              return (
                <>
                  <div className="section-title">🔼 Забрати по дорозі</div>
                  {availableToPickUp.length ? (
                    <MiniPeopleList people={availableToPickUp} roster={employees} sign="+" onPick={roadsidePickup} />
                  ) : (
                    <div className="hint" style={{ padding: "0 16px 8px" }}>Немає кого забирати</div>
                  )}

                  <div className="section-title">🔽 Висадити по дорозі — в машині {onboard.length}</div>
                  {onboardEmployees.length ? (
                    <MiniPeopleList people={onboardEmployees} roster={employees} sign="−" onPick={roadsideDropoff} />
                  ) : (
                    <div className="hint" style={{ padding: "0 16px 8px" }}>Нікого немає в машині</div>
                  )}
                </>
              );
            })()}

          {/* Обід буває і в дорозі, і між обʼєктами. Без цього входу, щоб
              записати обсяг зробленої вранці роботи, треба було кудись
              «прибути» -- а це запис про те, де стоїть бригада, не перегляд.
              Веде на обʼєкт, де ще лишились незаповнені; там нагорі чіпи, тож
              з одного місця вводяться обсяги будь-якого обʼєкта поїздки. */}
          {plans.some((p) => p.works.length > 0) &&
            (() => {
              const target = plans.find((p) => volumeStat(p).left > 0) ?? plans.find((p) => p.works.length > 0)!;
              const left = plans.reduce((acc, p) => acc + volumeStat(p).left, 0);
              const total = plans.reduce((acc, p) => acc + volumeStat(p).total, 0);
              return (
                <div className="list">
                  <button className="cell" onClick={() => openVolumesForObject(target.objectId, "DRIVE")}>
                    <span className="cell-title">📏 Ввести обсяги</span>
                    <span className={`badge ${left ? "warn" : "ok"}`}>
                      {total - left}/{total}
                    </span>
                  </button>
                </div>
              );
            })()}

          <div className="section-title">Маршрут</div>
          <div className="route-stack">
            {plans.map((p) => {
              const expanded = expandedDriveObjectId === p.objectId;
              const peopleEverHere = new Set(p.sessions.map((s) => s.employeeId)).size;
              const peopleTotal = peopleEverHere || p.here.length;
              const peopleHere = p.here.length;
              const peopleBadge = peopleTotal === 0 ? "" : peopleHere === 0 ? "danger" : peopleHere === peopleTotal ? "ok" : "warn";
              // Тут рахуємо роботи, що ЙДУТЬ, а не ті, кому вписано обсяг.
              // Обсяги вводять у кінці дня, тож посеред дня бейдж завжди був
              // «0 з 3» і червоний -- поруч із «людина працює 35 хвилин» це
              // читалось як «працює, а робіт нуль».
              const worksTotal = p.works.length;
              const worksGoing = p.works.filter((w) => !!w.workStartedAt).length;
              const worksBadge = worksTotal === 0 || worksGoing === 0 ? "" : worksGoing === worksTotal ? "ok" : "warn";
              const openSessions = p.sessions.filter((s) => !s.endedAt);
              const earliestOpenStart = openSessions.length ? Math.min(...openSessions.map((s) => new Date(s.startedAt).getTime())) : null;
              // 🚗 -- саме туди зараз їдемо. Чоловічка, який позначав «люди вже
              // тут своїм ходом», прибрано: бейдж «👤 1/1» поруч каже це саме,
              // тільки точніше, а дві позначки про одне читались як різні речі.
              const icon =
                driveHeadingTo?.objectId === p.objectId ? (
                  "🚗"
                ) : p.visited ? (
                  <span className="obj-done">✓</span>
                ) : (
                  "📍"
                );
              return (
                <div className="list" key={p.objectId}>
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
                            🛠 {worksGoing}/{worksTotal}
                          </span>
                        )}
                      </span>
                    </button>
                    {/* Одна кнопка на обидва випадки: і відвіданий обʼєкт, і ще
                        ні ведуть на той самий екран обʼєкта. Раніше тут стояли
                        олівець і чоловічок -- дві різні картинки на одну дію. */}
                    <button className="cell-action dots" onClick={() => openObjectMenu(p.objectId)} title="Меню обʼєкта">
                      ⋯
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      <div className="hint" style={{ fontWeight: 600 }}>👥 Зараз тут</div>
                      {/* 🚐 привезли бусом, 🚶 приїхав своїм ходом -- ті самі
                          позначки, що й на екрані обʼєкта. Різниця не
                          косметична: хто приїхав сам, доплати за виїзд не
                          отримує, тож сплутати їх коштує грошей. */}
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {peopleHere
                          ? p.here.map((id) => (
                              <div key={id}>
                                {selfTransportIds.includes(id) ? "🚶" : "🚐"} {employeeName(id)}
                              </div>
                            ))
                          : "нікого"}
                      </div>
                      {openSessions.length > 0 && (
                        <div className="hint" style={{ marginBottom: 8 }}>
                          ⏱ Роботи тривають {earliestOpenStart ? fmtHMS(now - earliestOpenStart) : ""}: {openSessions.map((s) => employeeName(s.employeeId)).join(", ")}
                        </div>
                      )}
                      {renderObjectPhotos(p)}

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

          {/* Позначки самі себе не пояснюють, а бригадир бачить цей екран
              щодня -- один рядок дрібним шрифтом дешевший за здогадки. */}
          <div className="route-legend">
            <span><span className="obj-done">✓</span> були на обʼєкті</span>
            <span>🚗 прямуємо</span>
            <span>📍 ще не були</span>
            <span>🚐 привезли бусом</span>
            <span>🚶 приїхав сам</span>
          </div>

          {nextUnvisited && driveHeadingTo ? (
            <MainButton text={`📍 Прибув: ${driveHeadingTo.objectName}`} onClick={() => arriveAt(driveHeadingTo.objectId)} />
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
            // Обʼєкт, на якому СТОЇТЬ МАШИНА, і чи ми зараз дивимось не на
            // нього. Нижній список -- навігатор: бригадир вільно ходить по
            // обʼєктах поїздки, щоб бачити, які роботи йдуть, і керувати
            // ними. Але виїзд -- це про машину, а не про те, що відкрито на
            // екрані. Поки цієї різниці не було, бригадир, який подивився
            // наперед і натиснув «Продовжити маршрут», отримував питання про
            // обʼєкт, куди не їхав.
            const carPlan = carAtObjectId ? plans.find((p) => p.objectId === carAtObjectId) ?? null : null;
            const viewingElsewhere = plan.objectId !== carAtObjectId;
            const openSessions = plan.sessions.filter((s) => !s.endedAt);
            const openSessionIds = new Set(openSessions.map((s) => s.employeeId));
            const everSessionIds = new Set(plan.sessions.map((s) => s.employeeId));
            const peopleTotal = everSessionIds.size || plan.here.length;
            const peopleActive = openSessions.length;
            const worksTotal = plan.works.length;
            const worksGoing = plan.works.filter((w) => !!w.workStartedAt).length;
            const shiftOpen = openSessions.length > 0;
            const notStarted = plan.here.filter((id) => !openSessionIds.has(id));
            const earliestOpenStart = openSessions.length
              ? Math.min(...openSessions.map((s) => new Date(s.startedAt).getTime()))
              : null;
            // The car is here only if it actually parked HERE. Two other
            // cases both mean "not here", and the foreman needs to be told
            // which: the car is still driving (this screen was opened mid-
            // route to register early self-transport arrivals), or it is
            // parked at another object and this panel was switched to.
            const carPresent = carAtObjectId === plan.objectId;
            // Work timers are driven by the shift as a whole now, so a person
            // can only be clocked in while the object's works are running --
            // otherwise their hours would count against nothing.
            const worksRunning = plan.works.some((w) => !!w.workStartedAt);
            const carElsewhere = !!carAtObjectId && carAtObjectId !== plan.objectId;
            const carElsewhereName = carElsewhere ? plans.find((p2) => p2.objectId === carAtObjectId)?.objectName ?? "" : "";
            return (
              <>
                <div className="step-badge">
                  {carPresent ? "НА ОБʼЄКТІ" : carElsewhere ? "👀 ІНШИЙ ОБʼЄКТ — ПЕРЕГЛЯД" : "🚗 МАШИНА ЩЕ В ДОРОЗІ"}
                </div>
                {carElsewhere && (
                  <div className="hint" style={{ padding: "0 16px 8px" }}>
                    Машина стоїть на «{carElsewhereName}». Тут можна правити роботи й людей — маршрут це не рухає.
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
                    {worksTotal > 0 && (
                      <span className={`badge ${worksGoing === 0 ? "" : worksGoing === worksTotal ? "ok" : "warn"}`}>
                        🛠 {worksGoing}/{worksTotal}
                      </span>
                    )}
                  </span>
                </div>

                {/* Дивитись чужий обʼєкт можна скільки завгодно -- але видно,
                    що це саме перегляд, і де насправді машина. */}
                {viewingElsewhere && (
                  <div className="hint" style={{ padding: "0 16px 8px" }}>
                    👁 Дивитесь «{plan.objectName}» ·{" "}
                    {carPlan ? `машина на «${carPlan.objectName}»` : "машина в дорозі"}
                  </div>
                )}

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

                {/* Жовтої картки «Закріплені роботи» тут більше немає: те саме
                    видно рядком «🛠 окремо: …» у самої людини, і про це ще раз
                    питає діалог перед стартом робіт бригаді. Три повторення
                    одного факту займали пів екрана. */}

                {renderObjectPhotos(plan)}

                {(worksTotal > 0 || plan.here.length > 0) && (
                  <button className="back-btn" onClick={() => setAtObjectDetailsExpanded((v) => !v)}>
                    {atObjectDetailsExpanded ? "▾ Сховати деталі" : "▸ Показати деталі (роботи, люди)"}
                  </button>
                )}

                {atObjectDetailsExpanded && worksTotal > 0 && (
                  <div className="list" style={{ marginBottom: 8 }}>
                    <div className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title">🛠 Роботи на обʼєкті</span>
                      <span className="badge ok">{worksTotal}</span>
                    </div>
                    {/* Один рядок на роботу: назва, час, кому вона належить і
                        чи йде. Кнопка призначення звідси прибрана -- те саме
                        робиться в картці людини («🛠 Окремі роботи»), а тут
                        вона подвоювала висоту кожного рядка. */}
                    {plan.works.map((w) => {
                      const running = !!w.workStartedAt;
                      const elapsed = (w.workAccumulatedMs ?? 0) + (running ? now - new Date(w.workStartedAt as string).getTime() : 0);
                      const assigned = w.employeeIds ?? [];
                      return (
                        <div key={w.workId} className="cell work-row" style={{ cursor: "default" }}>
                          <span className="cell-title">{w.workName}</span>
                          <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                            {elapsed > 0 && <span className="hint">{fmtHMS(elapsed)}</span>}
                            <span title={assigned.length ? assigned.map(employeeName).join(", ") : "вся бригада"}>
                              {assigned.length ? "👤" : "👥"}
                            </span>
                            {running && <span className="badge ok">йде</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* One list, not two. The timers block and the "how people
                    leave" block named the same people twice, in different
                    orders, with half the actions in each -- and neither said
                    how someone got here, which is what decides whether the
                    bus is even an option for them. */}
                {plan.here.length > 0 && !showDropPicker && !showMovePicker && !showAddPersonPicker && !showManualHours && !errandMode && (
                  <>
                    <div className="section-title">Люди на обʼєкті</div>
                    {!worksRunning && plan.here.length > 0 && (
                      <div className="hint" style={{ padding: "0 16px 6px" }}>
                        «▶️ Почати роботи» вмикає всіх одразу. «▶️ Старт» біля людини — тільки її (і її закріплені роботи).
                      </div>
                    )}
                    {/* Дві групи замість одного довгого списку: у кого свої
                        закріплені роботи, і хто працює на бригадних. На пʼятьох
                        людях це різниця між екраном, який видно цілком, і
                        стрічкою, яку треба гортати. Заголовок групи каже
                        головне -- скільки людей працює і скільки робіт іде. */}
                    {(() => {
                      const renderPerson = (id: string) => {
                        const session = plan.sessions.find((s) => s.employeeId === id && !s.endedAt);
                        const running = !!session;
                        const closedMs = plan.sessions
                          .filter((s) => s.employeeId === id && s.endedAt)
                          .reduce((a, s) => a + (new Date(s.endedAt as string).getTime() - new Date(s.startedAt).getTime()), 0);
                        const elapsed = closedMs + (running ? now - new Date(session!.startedAt).getTime() : 0);
                        const cameOnOwn = selfTransportIds.includes(id);
                        const ownWorks = plan.works.filter((w) => (w.employeeIds ?? []).includes(id));
                        const picking = assigningPersonId === id;
                        const open = expandedPersonId === id;
                        return (
                          <div key={id} className="cell" style={{ cursor: "default", display: "block" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                              {/* Імʼя -- і кнопка розгортання: дії під ним потрібні
                                  раз на день, а місце займали в кожного рядка. */}
                              <button
                                className="cell-title person-toggle"
                                onClick={() => {
                                  setExpandedPersonId(open ? null : id);
                                  if (open) setAssigningPersonId(null);
                                }}
                              >
                                {open ? "▾" : "▸"} {cameOnOwn ? "🚶" : "🚐"} {shortName(employeeName(id))}
                              </button>
                              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                {elapsed > 0 && <span className="hint">{fmtHMS(elapsed)}</span>}
                                {running ? (
                                  <button className="chip chip-sm danger-btn" onClick={() => stopPersonTimer(atObjectId, id)}>
                                    ⏹ Стоп
                                  </button>
                                ) : (
                                  <button className="chip chip-sm" onClick={() => startPersonTimer(atObjectId, id)}>
                                    ▶️ Старт
                                  </button>
                                )}
                              </span>
                            </div>
                            {ownWorks.length > 0 && (
                              <div className="hint" style={{ marginTop: 4 }}>
                                🛠 окремо: {ownWorks.map((w) => w.workName).join(", ")}
                              </div>
                            )}
                            {open && (
                              <div className="row-actions">
                                <button
                                  className={`chip chip-sm ${ownWorks.length ? "selected" : ""}`}
                                  onClick={() => setAssigningPersonId(picking ? null : id)}
                                  disabled={!plan.works.length}
                                >
                                  🛠 Окремі роботи
                                </button>
                                {carPresent && (
                                  <button className="chip chip-sm" onClick={() => pickUpOne(plan.objectId, id, false)}>
                                    🚐 У бус
                                  </button>
                                )}
                                <button className="chip chip-sm" onClick={() => leaveObjectOnOwn(plan.objectId, [id])}>
                                  🚶 Зняти
                                </button>
                              </div>
                            )}
                            {open && picking && (
                              <div style={{ marginTop: 8 }}>
                                <div className="hint">
                                  Обрані роботи оплачуються лише цій людині — і тоді вона більше не бере участі в поділі
                                  решти робіт обʼєкта. Решту ділить між собою бригада.
                                </div>
                                <div className="list" style={{ margin: "6px 0 0" }}>
                                  {plan.works.map((w) => {
                                    const mine = (w.employeeIds ?? []).includes(id);
                                    const others = (w.employeeIds ?? []).filter((x) => x !== id);
                                    return (
                                      <button
                                        key={w.workId}
                                        className={`cell ${mine ? "selected" : ""}`}
                                        onClick={() => toggleWorkAssignee(atObjectId, w.workId, id)}
                                      >
                                        <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                          <span className={`checkbox ${mine ? "checked" : ""}`}>{mine ? "✓" : ""}</span>
                                          {w.workName}
                                        </span>
                                        {others.length > 0 && <span className="badge warn">також {others.map((x) => shortName(employeeName(x))).join(", ")}</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      };
                      const dedicatedWorks = plan.works.filter((w) => (w.employeeIds ?? []).length > 0);
                      const crewWorks = plan.works.filter((w) => (w.employeeIds ?? []).length === 0);
                      const dedicatedPeople = plan.here.filter((id) =>
                        plan.works.some((w) => (w.employeeIds ?? []).includes(id)),
                      );
                      const crewPeople = plan.here.filter((id) => !dedicatedPeople.includes(id));
                      const groups = [
                        { key: "dedicated", title: "🛠 Окремі роботи", people: dedicatedPeople, works: dedicatedWorks },
                        { key: "crew", title: "👥 Роботи бригади", people: crewPeople, works: crewWorks },
                      ].filter((g) => g.people.length > 0 || g.works.length > 0);
                      return groups.map((g) => {
                        // Одна група -- нема чого ховати: розгорнута одразу.
                        const open = openPeopleGroups[g.key] ?? groups.length === 1;
                        const working = g.people.filter((id) =>
                          plan.sessions.some((s) => s.employeeId === id && !s.endedAt),
                        ).length;
                        const going = g.works.filter((w) => !!w.workStartedAt).length;
                        return (
                          <div className="list" key={g.key} style={{ marginBottom: 8 }}>
                            <button
                              className="cell"
                              onClick={() => setOpenPeopleGroups((prev) => ({ ...prev, [g.key]: !open }))}
                            >
                              <span className="cell-title" style={{ fontWeight: 600 }}>
                                {open ? "▾" : "▸"} {g.title}
                              </span>
                              <span style={{ display: "flex", gap: 6 }}>
                                {g.people.length > 0 && (
                                  <span className={`badge ${working === 0 ? "" : working === g.people.length ? "ok" : "warn"}`}>
                                    👤 {working}/{g.people.length}
                                  </span>
                                )}
                                {g.works.length > 0 && (
                                  <span className={`badge ${going === 0 ? "" : going === g.works.length ? "ok" : "warn"}`}>
                                    🛠 {going}/{g.works.length}
                                  </span>
                                )}
                              </span>
                            </button>
                            {open && g.people.map(renderPerson)}
                            {open && g.people.length === 0 && (
                              <div className="cell hint" style={{ cursor: "default" }}>
                                нікого тут немає
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                    {/* Дві кнопки поруч, і кожна забирає СВОЇХ: у бус сідають
                        ті, кого бус привіз, знімаються ті, хто приїхав сам.
                        Одна кнопка «посадити всіх» саджала в бус і чужі машини
                        теж, а розгрібати це доводилось по одному.
                        Цифри рахуються з тих, хто зараз на обʼєкті, тож коли
                        людину відправили окремо кнопкою в її картці, лічильник
                        своєї групи зменшується сам. */}
                    {(() => {
                      const byBus = plan.here.filter((id) => !selfTransportIds.includes(id));
                      const onOwn = plan.here.filter((id) => selfTransportIds.includes(id));
                      const ownStrands = strandsTheBus(plan.objectId, onOwn);
                      return (
                        <div className="chip-row split">
                          {carPresent && (
                            <button
                              className="chip selected"
                              onClick={() => pickUpHere(plan.objectId, byBus, false)}
                              disabled={!byBus.length}
                            >
                              🚐 Посадити у бус ({byBus.length})
                            </button>
                          )}
                          <button
                            className="chip"
                            onClick={() => leaveObjectOnOwn(plan.objectId, onOwn)}
                            disabled={!onOwn.length || ownStrands}
                            title={ownStrands ? "Хтось має сісти за кермо — заберіть когось у бус" : ""}
                          >
                            🚶 Зняти з обʼєкта ({onOwn.length})
                          </button>
                        </div>
                      );
                    })()}
                  </>
                )}

                {/* Кожна дія -- окрема картка, але з маленьким проміжком: це
                    різні речі, не пункти одного списку, і водночас одна група,
                    а не окремі розділи.
                    На зворотному шляху (atObjectReturnStep === "RETURN_PICKUP")
                    цієї групи немає взагалі: висаджувати, додавати роботи чи
                    переводити людей уже нікуди -- лишається подивитись, що
                    зробили, завершити роботи й забрати людей. */}
                {atObjectReturnStep !== "RETURN_PICKUP" && !showDropPicker && !showMovePicker && !showAddPersonPicker && !showManualHours && !errandMode && (
                  <div className="action-stack">
                    <div className="list">
                      <button
                        className="cell"
                        onClick={() => {
                          setDropSelected([]);
                          setAddArrivedSelected([]);
                          setDropEmptyHint(false);
                          setAtObjectDetailsExpanded(false);
                          setArrivedPickerOpen(false);
                          setShowDropPicker(true);
                        }}
                      >
                        <span className="cell-title">{carPresent ? "🚐 Висадити людей" : "🚶 Прибули самі"}</span>
                        {carPresent && <span className="cell-sub">{onboard.length} в машині</span>}
                      </button>
                    </div>
                    {/* Once work is underway, "start the rest" lives next to
                        "finish everyone" in the active-work card above -- keep
                        this only as the very first "start work" entry point. */}
                    {!shiftOpen && notStarted.length > 0 && (
                      <div className="list">
                        <button className="cell" onClick={startShift} disabled={!plan.works.length}>
                          <span className="cell-title">▶️ Почати роботи</span>
                          <span className="cell-sub">{nPeople(notStarted.length)}</span>
                        </button>
                      </div>
                    )}
                    <div className="list">
                      <button
                        className="cell"
                        onClick={() => {
                          openWorksPicker(atObjectId, "AT_OBJECT");
                        }}
                      >
                        <span className="cell-title">✏️ Додати/змінити роботи</span>
                        <span className="cell-sub">{nWorks(plan.works.length)}</span>
                      </button>
                    </div>
                    {/* Обсяги посеред дня, не зупиняючи нічого.
                        Досі єдиний шлях сюди з обʼєкта відкривався ПІСЛЯ
                        «⏹ Завершити все», тобто щоб записати обсяг зробленої
                        до обіду роботи, треба було зупинити всі інші. Тому їх
                        і вводили ввечері на базі, по памʼяті. Таймери від
                        цього входу не чіпаються взагалі. */}
                    {plan.works.length > 0 && (
                      <div className="list">
                        <button className="cell" onClick={() => openVolumesForObject(plan.objectId, "AT_OBJECT")}>
                          <span className="cell-title">📏 Ввести обсяги</span>
                          <span className={`badge ${volumeStat(plan).left ? "warn" : "ok"}`}>
                            {volumeStat(plan).filled}/{volumeStat(plan).total}
                          </span>
                        </button>
                      </div>
                    )}
                    {/* Три дії про склад людей, згорнуті в одне меню: кожна
                        трапляється кілька разів на день, а місце вгорі екрана
                        вони їли постійно. Дві з них не залежать від того, де
                        бус -- перехід пішки потрібен саме тоді, коли бус
                        поїхав далі. Пасажирів буса пікер пропонує, лише коли
                        він стоїть тут: вони належать тому обʼєкту, де машина. */}
                    {/* Перехід пішки -- звичайний хід дня, а не виправлення:
                        дві точки на одній території, частина бригади лишається
                        на другій. Тому окремою кнопкою, над меню правок. */}
                    {plans.length > 1 && !reviewFixMode && (
                      <div className="list">
                        <button
                          className="cell"
                          onClick={() => {
                            setMoveSelected([]);
                            setMoveTargetId(null);
                            setMoveMode("walk");
                            setShowMovePicker(true);
                          }}
                          disabled={!plan.here.length && !(carPresent && onboard.length)}
                        >
                          <span className="cell-title">🚶 Перевести на інший обʼєкт</span>
                          <span className="cell-sub">пішки, поруч</span>
                        </button>
                      </div>
                    )}
                    {/* А тут -- те, що роблять, коли щось пішло не так або про
                        когось забули. Згорнуте: трапляється рідко, а місце
                        вгорі екрана їло постійно. */}
                    <div className="list">
                      <button className="cell" onClick={() => setPeopleMenuOpen((v) => !v)}>
                        <span className="cell-title">
                          {peopleMenuOpen ? "▾" : "▸"} 👥 Редагувати людей
                        </span>
                      </button>
                      {peopleMenuOpen && (
                        <>
                          <button
                            className="cell"
                            onClick={() => {
                              setAddPersonSelected([]);
                              setAddPersonArrival("bus");
                              setAddPersonStart(null);
                              setAddPersonStartHint(false);
                              setAddPersonSearch("");
                              setShowAddPersonPicker(true);
                            }}
                          >
                            <span className="cell-title">➕ Додати людину</span>
                            <span className="cell-sub">яку забули внести або яка щойно приїхала</span>
                          </button>
                          {plans.length > 1 && (
                            <button
                              className="cell"
                              onClick={() => {
                                setMoveSelected([]);
                                setMoveTargetId(null);
                                setMoveMode("fix");
                                setShowMovePicker(true);
                              }}
                              /* `here`/`onboard` — це ЖИВИЙ день: хто стоїть тут
                                 і хто в машині, що тут. У дні, який уже дійшов
                                 до підсумку (а тим паче в поверненому на
                                 виправлення), на обʼєкті не стоїть ніхто:
                                 людей забрали, сесії закриті. Умова гасила
                                 кнопку саме тоді, коли вона й потрібна —
                                 виправити, кого куди висадили, стало нічим.
                                 Тут рахуємо тих, чиї ГОДИНИ лежать на цьому
                                 обʼєкті: саме їх і переносять. */
                              disabled={
                                reviewFixMode
                                  ? !plan.sessions.length && !plan.here.length
                                  : !plan.here.length && !(carPresent && onboard.length)
                              }
                            >
                              <span className="cell-title">🔄 Не той обʼєкт — виправити</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {/* No manual-hours entry here on purpose: hours get
                        corrected on the way back, once the work is finished
                        and it is clear whose timer never ran. The editor
                        itself (showManualHours below) stays wired -- it is
                        per-object and this screen already knows the object;
                        the return steps open it. */}
                    {carPresent && !openErrand && (
                      <div className="list">
                        <button
                          className="cell"
                          onClick={() => {
                            setErrandDriverId(null);
                            setErrandOdoBuffer("");
                            setErrandMode("start");
                          }}
                          disabled={!plan.here.length}
                        >
                          <span className="cell-title">🚗 Машина вибула по справам</span>
                          <span className="cell-sub">ці км не йдуть у доплату за виїзд</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {openErrand && !errandMode && !showDropPicker && !showMovePicker && !showAddPersonPicker && !showManualHours && (
                  <div className="list" style={{ marginTop: 8 }}>
                    <div className="cell" style={{ cursor: "default", background: "rgba(255,159,10,0.12)" }}>
                      <span className="cell-title">🚗 Машина у роз'їздах</span>
                      <span className="cell-sub">водій {employeeName(openErrand.driverId)} · виїхав на {openErrand.odoOut}</span>
                    </div>
                    <button
                      className="cell"
                      onClick={() => {
                        setErrandOdoBuffer("");
                        setErrandMode("return");
                      }}
                    >
                      <span className="cell-title">↩️ Машина повернулась</span>
                      <span className="cell-sub">ввести спідометр</span>
                    </button>
                  </div>
                )}

                {/* Увесь маршрут, а не лише «інші»: список, з якого зник той
                    обʼєкт, на якому стоїш, змушував тримати в голові, скільки
                    їх усього. Поточний позначено зеленою стрілкою. */}
                {plans.length > 1 && !showDropPicker && !showMovePicker && !showAddPersonPicker && !showManualHours && !errandMode && (
                  <>
                    <div className="section-title">Обʼєкти поїздки</div>
                    <div className="list">
                      {plans.map((p) => {
                        const isCurrent = p.objectId === atObjectId;
                        return (
                          <button
                            key={p.objectId}
                            className={`cell ${isCurrent ? "selected" : ""}`}
                            onClick={() => switchAtObject(p.objectId)}
                          >
                            {/* Зелений кружечок -- «оцей обʼєкт зараз
                                відкритий», і більше нічого. Тут стояв напис
                                «ви тут», і він брехав: список перемикає
                                панель, а не везе бригаду, тож бригадир, який
                                дивився наперед, бачив себе на обʼєкті, де його
                                не було. 🚐 каже, де насправді машина -- саме
                                звідти й стартує виїзд. */}
                            <span className="cell-title">
                              {isCurrent ? <span className="view-dot" /> : "📍"} {p.objectName}
                              {carAtObjectId === p.objectId ? " 🚐" : ""}
                            </span>
                            {/* Колір несе те саме, що й текст, тільки швидше:
                                помаранчевий -- там ще стоять люди, синій --
                                туди ще їхати, сірий -- закрито. */}
                            <span className={`badge ${p.here.length ? "warn" : p.visited ? "" : "info"}`}>
                              {p.here.length
                                ? `👤 ${p.here.length} тут`
                                : p.visited
                                  ? "відвідано"
                                  : "заплановано"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {showDropPicker && (
                  <>
                    {carPresent && onboard.length > 0 && (
                      <>
                        <div className="section-title row">
                          <span>Кого залишити тут</span>
                          <button
                            className="chip chip-sm"
                            onClick={() => setDropSelected(dropSelected.length === onboard.length ? [] : [...onboard])}
                          >
                            {dropSelected.length === onboard.length ? "✕ Зняти всіх" : "✓ Обрати всіх"}
                          </button>
                        </div>
                        {/* Заголовок про ІНШИХ, а список -- це і ти теж. Без
                            цього рядка бригадир, який був у бусі сам, чотири
                            рази відкривав висадку і не розумів, що треба
                            натиснути на власне прізвище. */}
                        <div className="hint" style={{ padding: "0 16px 6px" }}>
                          Натисніть на прізвище — навпроти зʼявиться ✓. Себе теж треба позначити.
                        </div>
                        <div className="list">
                          {onboard.map((id) => {
                            const checked = dropSelected.includes(id);
                            const isMe = !!myEmployeeId && id === myEmployeeId;
                            return (
                              <button
                                key={id}
                                className={`cell ${checked ? "selected" : ""}`}
                                onClick={() => {
                                  setDropEmptyHint(false);
                                  setDropSelected((prev) => (checked ? prev.filter((x) => x !== id) : [...prev, id]));
                                }}
                              >
                                <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                  {shortName(employeeName(id))}
                                  {isMe && <span className="badge info">Ви</span>}
                                </span>
                                <span className={roleTagClass(roleFor(id))}>{roleFor(id)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Collapsed by default: on most stops nobody arrives on
                        their own, and this list is the whole staff roster. */}
                    <div className="section-title row">
                      <span>🚶 Хто приїхав сам (свій транспорт)</span>
                      <button className="chip chip-sm" onClick={() => setArrivedPickerOpen((v) => !v)}>
                        {arrivedPickerOpen ? "▾ Згорнути" : "▸ Показати"}
                      </button>
                    </div>
                    {arrivedPickerOpen && addArrivedSelected.length > 0 && (
                      <div className="picked-panel">
                        <div className="picked-head">
                          <button className="picked-toggle" onClick={() => setArrivedPickedExpanded((v) => !v)}>
                            {arrivedPickedExpanded ? "▾" : "▸"} Обрано {addArrivedSelected.length}
                          </button>
                          <button className="back-btn danger-btn" onClick={() => setAddArrivedSelected([])}>
                            🗑 Очистити
                          </button>
                        </div>
                        {arrivedPickedExpanded && (
                          <div className="picked-list">
                            {addArrivedSelected.map((id) => (
                              <div className="picked-item" key={id}>
                                <span>{shortName(employeeName(id))}</span>
                                <button
                                  className="picked-remove"
                                  aria-label={`Прибрати ${employeeName(id)}`}
                                  onClick={() => setAddArrivedSelected((prev) => prev.filter((x) => x !== id))}
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {arrivedPickerOpen && (
                    <input
                      className="search-box"
                      placeholder="Пошук людини…"
                      value={arrivedSearch}
                      onChange={(e) => setArrivedSearch(e.target.value)}
                    />
                    )}
                    {arrivedPickerOpen && (
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
                                        {shortName(emp.name)}
                                      </span>
                                      <span className={roleTagClass(employeeRole(emp))}>{employeeRole(emp)}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    )}

                    {dropEmptyHint && (
                      <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
                        Нікого не обрано. Натисніть на прізвище у списку «Кого залишити тут» — навпроти має зʼявитись ✓.
                      </div>
                    )}
                    <div className="confirm-row">
                      <button
                        className="chip"
                        onClick={() => {
                          setDropSelected([]);
                          setAddArrivedSelected([]);
                          setDropEmptyHint(false);
                          setShowDropPicker(false);
                        }}
                      >
                        Скасувати
                      </button>
                      {/* НЕ disabled: раніше кнопка була вимкнена, але виглядала
                          як звичайна активна, і тап у неї не давав нічого --
                          ні дії, ні пояснення. Мовчазна кнопка і є те, що
                          людина називає «не працює». Тепер вона відповідає. */}
                      <button
                        className="chip selected"
                        onClick={() => {
                          if (!dropSelected.length && !addArrivedSelected.length) {
                            setDropEmptyHint(true);
                            haptic("error");
                            return;
                          }
                          setDropEmptyHint(false);
                          confirmDropAndArrived();
                        }}
                      >
                        Підтвердити
                      </button>
                    </div>
                  </>
                )}

                {showAddPersonPicker && (
                  <>
                    {/* Обидва варіанти підписані КОНКРЕТНИМ часом, а не
                        правилом: «як бригада» звучить просто, поки всі
                        стартували разом, і перестає, коли бригадир запускав
                        кожного окремо. Хай бачить число, а не формулювання. */}
                    {(() => {
                      const w = crewWindowAt(plan, addPersonSelected);
                      if (!w) {
                        return (
                          <div className="hint" style={{ padding: "0 16px 8px" }}>
                            Роботи тут ще не починались — людина просто стане на обʼєкт і піде в роботу разом з усіма.
                          </div>
                        );
                      }
                      return (
                        <>
                          <div className="section-title">З якого часу рахувати години</div>
                          <div className="chip-row split">
                            <button
                              className={`chip ${addPersonStart === "crew" ? "selected" : ""}`}
                              onClick={() => {
                                setAddPersonStart("crew");
                                setAddPersonStartHint(false);
                              }}
                            >
                              🕓 З бригадою · {hhmmOf(w.startedAt)}
                            </button>
                            <button
                              className={`chip ${addPersonStart === "now" ? "selected" : ""}`}
                              onClick={() => {
                                setAddPersonStart("now");
                                setAddPersonStartHint(false);
                              }}
                            >
                              ▶️ Зараз · {hhmmOf(new Date().toISOString())}
                            </button>
                          </div>
                          <div className="hint" style={{ padding: "6px 16px 0" }}>
                            {addPersonStart === "crew" ? (
                              <>
                                Працювала тут з бригадою, її просто забули внести. Отримає години{" "}
                                <b>з {hhmmOf(w.startedAt)}</b>
                                {w.endedAt ? (
                                  <> до <b>{hhmmOf(w.endedAt)}</b></>
                                ) : (
                                  " і далі, поки бригада працює"
                                )}
                                . Це найраніший старт серед тих, хто працює тут зараз.
                              </>
                            ) : addPersonStart === "now" ? (
                              <>
                                Щойно приїхала — своїм ходом, після поломки, з іншого обʼєкта. Години підуть{" "}
                                <b>з цієї хвилини</b>, за те, що було раніше, їй не платять.
                              </>
                            ) : (
                              "Оберіть одне з двох — від цього прямо залежать її години, а отже й гроші."
                            )}
                          </div>
                        </>
                      );
                    })()}
                    {/* Транспорт питаємо лише про тих, кого в поїздці ще не
                        було. Для свого, якого додають на другий обʼєкт, це
                        питання вже вирішене зранку. */}
                    {addPersonSelected.some((id) => !employeeIds.includes(id)) && (
                    <>
                    <div className="section-title">Як вона тут опинилась</div>
                    <div className="chip-row split">
                      <button
                        className={`chip ${addPersonArrival === "bus" ? "selected" : ""}`}
                        onClick={() => setAddPersonArrival("bus")}
                      >
                        🚐 Привезли бусом
                      </button>
                      <button
                        className={`chip ${addPersonArrival === "own" ? "selected" : ""}`}
                        onClick={() => setAddPersonArrival("own")}
                      >
                        🚶 Приїхала сама
                      </button>
                    </div>
                    <div className="hint" style={{ padding: "6px 16px 0" }}>
                      {addPersonArrival === "bus"
                        ? "Іде в поділ доплати за виїзд нарівні з рештою бригади."
                        : "Доплату за виїзд не отримує — зарплату за роботу отримує як усі."}
                    </div>
                    </>
                    )}
                    <div className="section-title">Кого додати</div>
                    {reviewFixMode && (
                      <div className="hint" style={{ padding: "0 16px 6px" }}>
                        Тут і ті, хто вже в поїздці, але ще не на цьому обʼєкті — щоб внести переїзд бригади
                        («відпрацювали на одному, поїхали на другий»).
                      </div>
                    )}
                    <input
                      className="search-box"
                      placeholder="Пошук людини…"
                      value={addPersonSearch}
                      onChange={(e) => setAddPersonSearch(e.target.value)}
                    />
                    <div className="list">
                      {groupByBrigade(
                        employees.filter((e) => {
                          if (busyEmployees.has(e.id)) return false;
                          if (!e.name.toLowerCase().includes(addPersonSearch.toLowerCase())) return false;
                          if (!employeeIds.includes(e.id)) return true;
                          // Хто вже в поїздці, тут зайвий -- ЗАЗВИЧАЙ. У живому
                          // дні його додають «🚐 Висадити людей»: бригада
                          // переїхала, люди в бусі, список їх знає.
                          //
                          // А в дні, який дійшов до підсумку, буса немає, і
                          // єдиний шлях внести себе на ДРУГИЙ обʼєкт зникав:
                          // «Додати» не показувала тих, хто в поїздці, а
                          // «Висадити» -- порожня. Тобто «відпрацювали на Ріці,
                          // переїхали на Косино» внести було нічим.
                          //
                          // Пускаємо лише тих, кого на цьому обʼєкті ще немає:
                          // ні сесій, ні присутності.
                          if (!reviewFixMode) return false;
                          const alreadyHere =
                            plan.here.includes(e.id) || plan.sessions.some((x) => x.employeeId === e.id);
                          return !alreadyHere;
                        }),
                        employees,
                      ).map((g) => {
                        const expanded = expandedAddBrigadeId === g.id || !!addPersonSearch;
                        const selectedCount = g.members.filter((e) => addPersonSelected.includes(e.id)).length;
                        return (
                          <div key={g.id}>
                            <button className="cell" onClick={() => setExpandedAddBrigadeId(expanded ? null : g.id)}>
                              <span className="cell-title">
                                {expanded ? "▾" : "▸"} {g.title}
                              </span>
                              <span className="badge">
                                {selectedCount}/{g.members.length}
                              </span>
                            </button>
                            {expanded && (
                              <div style={{ paddingLeft: 12 }}>
                                {g.members.map((emp) => {
                                  const checked = addPersonSelected.includes(emp.id);
                                  return (
                                    <button
                                      key={emp.id}
                                      className={`cell ${checked ? "selected" : ""}`}
                                      onClick={() =>
                                        setAddPersonSelected((prev) =>
                                          prev.includes(emp.id) ? prev.filter((x) => x !== emp.id) : [...prev, emp.id],
                                        )
                                      }
                                    >
                                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                        {shortName(emp.name)}
                                      </span>
                                      <span className={roleTagClass(employeeRole(emp))}>{employeeRole(emp)}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {addPersonStartHint && (
                      <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
                        Не обрано, з якого часу рахувати години. Натисніть «🕓 З бригадою» або «▶️ Зараз» угорі — це
                        різні гроші, тому за вас цього ніхто не вирішує.
                      </div>
                    )}
                    <div className="chip-row">
                      <button
                        className="chip"
                        onClick={() => {
                          setAddPersonSelected([]);
                          setAddPersonStart(null);
                          setAddPersonStartHint(false);
                          setShowAddPersonPicker(false);
                        }}
                      >
                        Скасувати
                      </button>
                      <button className="chip selected" onClick={confirmAddPeople} disabled={!addPersonSelected.length}>
                        Додати ({addPersonSelected.length})
                      </button>
                    </div>
                  </>
                )}

                {showMovePicker && (
                  <>
                    <div className="hint" style={{ padding: "0 16px 8px" }}>
                      {moveMode === "walk"
                        ? "Відпрацьовані тут години лишаються за людиною. На новому обʼєкті вона просто стоїть — час піде, коли натиснете «Старт». Доплата за виїзд не змінюється."
                        : moveTargetId === BASE_TARGET
                          ? "Людину буде прибрано з поїздки цілком: години на всіх обʼєктах зникнуть, зі складу вона вийде, доплату за виїзд не отримає. Одразу після цього буде «Скасувати»."
                          : "Виправлення = «я помилився обʼєктом». Тут від людини не лишиться нічого, а на новому обʼєкті їй зарахуються ті самі години й роботи, що й усій тамтешній бригаді."}
                    </div>
                    {/* Не лише ті, хто стоїть на цьому обʼєкті: у бусі сидить
                        людина, яку теж треба буває відправити пішки на сусідню
                        точку, і поки її не було в списку, єдиним шляхом було
                        «прибули самі» -- а це знімає доплату за виїзд. */}
                    {(() => {
                      // У режимі правки дня беремо ще й тих, чиї сесії стоять
                      // на цьому обʼєкті: вони вже нікуди не «стоять», але саме
                      // їхні години й треба перенести на інший обʼєкт.
                      const withSessions = reviewFixMode ? [...new Set(plan.sessions.map((x) => x.employeeId))] : [];
                      const movable = [
                        ...new Set([
                          ...plan.here,
                          ...withSessions,
                          ...(carPresent ? onboard.filter((id) => !plan.here.includes(id)) : []),
                        ]),
                      ];
                      const stateOf = (id: string) => {
                        if (plan.sessions.some((x) => x.employeeId === id && !x.endedAt)) return "⏱ працює";
                        if (onboard.includes(id)) return "🚐 в бусі";
                        // Закриті сесії — це вже не «стан», а години. Саме їх і
                        // переносять, коли виправляють обʼєкт у зданому дні.
                        const ms = plan.sessions
                          .filter((x) => x.employeeId === id && x.endedAt)
                          .reduce((a, x) => a + (new Date(x.endedAt as string).getTime() - new Date(x.startedAt).getTime()), 0);
                        return ms > 0 ? `⏱ ${fmtHours(ms / 3_600_000)}` : "⏸ не працює";
                      };
                      return (
                        <>
                          <div className="section-title row">
                            <span>{moveMode === "walk" ? "Кого перевести" : "Кого виправити"}</span>
                            <button
                              className="chip chip-sm"
                              onClick={() => setMoveSelected(moveSelected.length === movable.length ? [] : [...movable])}
                            >
                              {moveSelected.length === movable.length ? "✕ Зняти всіх" : "✓ Обрати всіх"}
                            </button>
                          </div>
                          <div className="list">
                            {movable.map((id) => {
                              const checked = moveSelected.includes(id);
                              return (
                                <button
                                  key={id}
                                  className={`cell ${checked ? "selected" : ""}`}
                                  onClick={() => setMoveSelected((prev) => (checked ? prev.filter((x) => x !== id) : [...prev, id]))}
                                >
                                  <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                    {shortName(employeeName(id))}
                                  </span>
                                  <span className="cell-sub">{stateOf(id)}</span>
                                </button>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                    <div className="section-title">{moveMode === "walk" ? "На який обʼєкт" : "Куди"}</div>
                    <div className="list">
                      {/* «На базу» = людини в цій поїздці взагалі не було: її
                          помилково відправили працювати, а вона лишалась на
                          базі. Прибирає зі складу цілком -- години, місце,
                          доплату за виїзд. Є «Скасувати» в тості, бо дія
                          безслідна. */}
                      {moveMode === "fix" &&
                        (() => {
                          const checked = moveTargetId === BASE_TARGET;
                          return (
                            <button
                              className={`cell ${checked ? "selected" : ""}`}
                              onClick={() => setMoveTargetId(BASE_TARGET)}
                            >
                              <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                🏠 На базу — її тут не було
                              </span>
                              <span className="badge danger">прибрати з поїздки</span>
                            </button>
                          );
                        })()}
                      {plans
                        .filter((p) => p.objectId !== atObjectId)
                        .map((p) => {
                          const checked = moveTargetId === p.objectId;
                          return (
                            <button
                              key={p.objectId}
                              className={`cell ${checked ? "selected" : ""}`}
                              onClick={() => setMoveTargetId(p.objectId)}
                            >
                              <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                {p.objectName}
                              </span>
                              <span className="badge">{p.here.length ? `${p.here.length} тут` : p.visited ? "відвідано" : "заплановано"}</span>
                            </button>
                          );
                        })}
                    </div>
                    <div className="confirm-row">
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
                        {moveMode === "walk" ? "Перевести" : moveTargetId === BASE_TARGET ? "Прибрати з поїздки" : "Виправити"}
                      </button>
                    </div>
                  </>
                )}

                {showManualHours &&
                  (manualHoursEmployeeId ? (
                    <>
                      <div className="section-title">🕒 {employeeName(manualHoursEmployeeId)} — години на «{plan.objectName}»</div>
                      <div className={`big-number ${manualHoursBuffer ? "" : "empty"}`}>{manualHoursBuffer || "0"} год</div>
                      <NumericKeypad value={manualHoursBuffer} onChange={setManualHoursBuffer} />
                      <div className="confirm-row">
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

                {errandMode === "start" && (
                  <>
                    <div className="section-title">🚗 Машина вибула по справам — {plan.objectName}</div>
                    <div className="hint" style={{ padding: "0 16px 8px" }}>
                      Ці кілометри не враховуються в доплату за виїзд. Оберіть водія (з тих, хто на об'єкті) і введіть спідометр при виїзді.
                    </div>
                    <div className="section-title">Хто за кермом</div>
                    <div className="list">
                      {plan.here.map((id) => {
                        const checked = errandDriverId === id;
                        return (
                          <button key={id} className={`cell ${checked ? "selected" : ""}`} onClick={() => setErrandDriverId(id)}>
                            <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                              {shortName(employeeName(id))}
                            </span>
                            <span className={roleTagClass(roleFor(id))}>{roleFor(id)}</span>
                          </button>
                        );
                      })}
                    </div>
                    {errandDriverId && (
                      <>
                        <div className="section-title">Спідометр при виїзді</div>
                        <div className={`big-number ${errandOdoBuffer ? "" : "empty"}`}>{errandOdoBuffer || "0"}</div>
                        <NumericKeypad value={errandOdoBuffer} onChange={setErrandOdoBuffer} decimal={false} />
                      </>
                    )}
                    <div className="confirm-row">
                      <button
                        className="chip"
                        onClick={() => {
                          setErrandMode(null);
                          setErrandDriverId(null);
                          setErrandOdoBuffer("");
                        }}
                      >
                        Скасувати
                      </button>
                      <button
                        className="chip selected"
                        disabled={!errandDriverId || !errandOdoBuffer || !Number.isFinite(Number(errandOdoBuffer))}
                        onClick={() => {
                          startErrand(atObjectId, errandDriverId!, Number(errandOdoBuffer));
                          setErrandMode(null);
                          setErrandDriverId(null);
                          setErrandOdoBuffer("");
                        }}
                      >
                        Зберегти
                      </button>
                    </div>
                  </>
                )}

                {errandMode === "return" && openErrand && (
                  <>
                    <div className="section-title">↩️ Машина повернулась</div>
                    <div className="hint" style={{ padding: "0 16px 8px" }}>
                      Водій {employeeName(openErrand.driverId)} · виїхав на {openErrand.odoOut}. Введіть спідометр при поверненні.
                    </div>
                    <div className={`big-number ${errandOdoBuffer ? "" : "empty"}`}>{errandOdoBuffer || "0"}</div>
                    <NumericKeypad value={errandOdoBuffer} onChange={setErrandOdoBuffer} decimal={false} />
                    {errandOdoBuffer && Number(errandOdoBuffer) < openErrand.odoOut && (
                      <div className="hint" style={{ padding: "0 16px 8px", color: "#d70015" }}>
                        ⚠️ Спідометр при поверненні не може бути меншим за {openErrand.odoOut}.
                      </div>
                    )}
                    {errandOdoBuffer && Number(errandOdoBuffer) >= openErrand.odoOut && (
                      <div className="hint" style={{ padding: "0 16px 8px" }}>
                        По справам: {Math.max(0, Number(errandOdoBuffer) - openErrand.odoOut)} км — не піде в доплату.
                      </div>
                    )}
                    <div className="confirm-row">
                      <button className="chip" onClick={() => setErrandMode(null)}>
                        Пізніше
                      </button>
                      <button
                        className="chip selected"
                        disabled={!errandOdoBuffer || Number(errandOdoBuffer) < openErrand.odoOut}
                        onClick={() => {
                          finishErrand(Number(errandOdoBuffer));
                          setErrandMode(null);
                          setErrandOdoBuffer("");
                        }}
                      >
                        Зберегти
                      </button>
                    </div>
                  </>
                )}

                {/* Дивимось не на той обʼєкт, де машина: виїжджати звідси
                    нема чим і нема звідки. Замість «Продовжити маршрут» --
                    дорога назад до машини, і вже звідти звичайний порядок:
                    продовжити маршрут → обрати, куди їхати → «Прибув».
                    Так попередження «нікого не висаджено» більше не може
                    вилізти на обʼєкті, який просто відкрили подивитись. */}
                {viewingElsewhere ? (
                  <MainButton
                    text={carPlan ? `↩️ До «${carPlan.objectName}»` : "↩️ До маршруту"}
                    onClick={() => {
                      if (carPlan) switchAtObject(carPlan.objectId);
                      else setStep("DRIVE");
                    }}
                  />
                ) : (
                <MainButton
                  text={
                    atObjectReturnStep === "RETURN_PICKUP"
                      ? "↩️ До повернення"
                      : atObjectReturnStep !== "DRIVE"
                      ? "✅ Готово"
                      : nextUnvisited
                        ? "➡️ Продовжити маршрут"
                        : "🏁 Завершити роботи й повернутись"
                  }
                  onClick={async () => {
                    // Nobody dropped here and nothing started: almost always a
                    // mis-tap on the way past, and leaving now means the object
                    // can never be worked. Confirming records the day's truth
                    // -- we were there, no work was done -- and only then does
                    // the object stop asking to be returned to.
                    if (atObjectReturnStep === "DRIVE" && !plan.here.length && !plan.sessions.length && !plan.noWork) {
                      const ok = await confirmDialog(
                        `На «${plan.objectName}» нікого не висаджено і роботи не починались.\n\n` +
                          `Щоб тут працювали — спочатку висадіть людей.\n\n` +
                          `Поїхати далі попри це? У звіті буде: були на обʼєкті, роботи не виконувались.`,
                      );
                      if (!ok) return;
                      setPlans((prev) => prev.map((x) => (x.objectId === plan.objectId ? { ...x, noWork: true } : x)));
                      logChange(`${plan.objectName}: були, роботи не виконувались`);
                      setStep("DRIVE");
                      return;
                    }
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
                      // The label says "завершити роботи", but this button only
                      // switches the route to the return leg -- the crew stays
                      // on site to be collected on the way back. A foreman read
                      // that as "the day is over", saw "ПОВЕРНЕННЯ НА БАЗУ" with
                      // a running clock while five people were still digging,
                      // and asked who was supposed to be driving. So say it out
                      // loud before switching.
                      const stillOut = plans.filter((p) => p.here.length > 0);
                      if (stillOut.length) {
                        const lines = stillOut.map((p) => `• ${p.objectName} — ${nPeople(p.here.length)}`).join("\n");
                        // Три відповіді, бо їх у житті три. Раніше було дві, і
                        // жодна не вела на базу: «Так» відкривало список «кого
                        // забрати», «Ні» не робило нічого. Найчастішого випадку
                        // -- людина лишається доробляти, бус їде -- не існувало.
                        const answer = await ask3Dialog(
                          `Ще працюють:\n${lines}\n\n` +
                            `Заїхати по них дорогою на базу — «🚗 Так, заберемо».\n\n` +
                            `Якщо вони доробляють і підуть самі — «🏠 Ні, їдемо на базу». Години їм зупините тоді, ` +
                            `коли вони справді закінчать; доти звіт не відправляється.`,
                          "🚗 Так, заберемо",
                          "🏠 Ні, їдемо на базу",
                          "Скасувати",
                          "Люди ще працюють на обʼєктах",
                        );
                        if (answer === "cancel") return;
                        setGoingHomeWithoutThem(answer === "b");
                      } else {
                        setGoingHomeWithoutThem(false);
                      }
                      // Бус стоїть тут, і тут же стоять люди -- забирати їх
                      // треба з цього ж екрана, а не зі списку обʼєктів.
                      // Лишаємось на місці й лише перемикаємось у режим
                      // повернення: той самий екран, що й після «Прибув» на
                      // сусідньому обʼєкті.
                      if (carPresent && plan.here.length > 0) {
                        setAtObjectReturnStep("RETURN_PICKUP");
                        return;
                      }
                      setStep(stillOut.length ? "RETURN_PICKUP" : "RETURN");
                      return;
                    }
                    // Їдемо на наступний обʼєкт, а бригада стоїть на цьому.
                    //
                    // Гілка останнього обʼєкта (вище) про це питає, ця -- ні:
                    // бус просто виїжджав, лишаючи людей стояти. Забрати їх
                    // після цього можна було тільки абсурдним шляхом, який
                    // бригадир і знайшов сам: обрати наступною метою обʼєкт,
                    // на якому й так стоїш, «прибути» на нього вдруге і аж
                    // тоді посадити. У звіті це другий приїзд туди, де ніхто
                    // нікуди не їздив.
                    if (atObjectReturnStep === "DRIVE" && carAtObjectId === plan.objectId && plan.here.length > 0) {
                      const byBus = plan.here.filter((id) => !selfTransportIds.includes(id));
                      const names = plan.here.map((id) => shortName(employeeName(id))).join(", ");
                      // Три відповіді, а не дві. Обидві попередні виїжджали,
                      // тож бригадир, який хотів забрати одного, а другого
                      // лишити, не мав куди подітись -- це робиться на самому
                      // обʼєкті, по людині. «Скасувати» саме для цього: нічого
                      // не робить і лишає екран, як був.
                      const take = await ask3Dialog(
                        `На «${plan.objectName}» ще ${nPeople(plan.here.length)}: ${names}.\n\n` +
                          `Забрати всіх — «${byBus.length ? "🚐 Забрати всіх" : "Забрати всіх"}». Лишаються тут працювати — ` +
                          `«Лишити тут», заберете на зворотному шляху.\n\n` +
                          `Якщо когось треба забрати, а когось лишити — «Скасувати» і зробіть це по людині на обʼєкті.`,
                        byBus.length ? "🚐 Забрати всіх" : "Забрати всіх",
                        "Лишити тут",
                        "Скасувати",
                        "Забираємо людей?",
                      );
                      if (take === "cancel") return;
                      if (take === "a" && byBus.length) await pickUpHere(plan.objectId, byBus);
                    }
                    setStep(atObjectReturnStep);
                  }}
                />
                )}
              </>
            );
          })()}
        </>
      )}

      {step === "RETURN_PICKUP" && (
        <>
          {(() => {
            // Include an object that only has early self-transport arrivals,
            // even if the bus never formally visited it on the outbound leg.
            // Those people still need an explicit way to leave on their own
            // (or be collected by the bus) before the day can finish.
            const returnObjects = plans.filter((p) => p.visited || p.here.length > 0 || p.sessions.length > 0);
            const anyPending = plans.some((p) => p.here.length > 0);
            // The car's position is known, so this screen can say what to do
            // next instead of offering one unlabelled "continue driving":
            // either collect the people standing where the car is parked, or
            // set off for another object that still has some.
            const parkedAt = returnObjects.find((p) => p.objectId === carAtObjectId) ?? null;
            const stillToCollect = returnObjects.filter((p) => p.here.length > 0 && p.objectId !== carAtObjectId);
            const driving = !!drivingSegmentStartedAt;
            return (
              <>
                <div className="step-badge">ПОВЕРНЕННЯ НА БАЗУ</div>
                <div className="timer-big">
                  {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
                </div>
                <div className="hint" style={{ textAlign: "center" }}>лише час у дорозі — на об'єктах не рахується</div>

                {driving && headingTo && (
                  <div className="hint" style={{ textAlign: "center", padding: "6px 16px 0" }}>
                    Прямуємо до 📍 {headingTo.objectName}
                  </div>
                )}

                {!driving && parkedAt && parkedAt.here.length > 0 && (
                  <>
                    <div className="section-title">Машина тут — 📍 {parkedAt.objectName}</div>
                    {renderDepartureChoices(parkedAt, { allowBus: true, pauseForBus: false })}
                  </>
                )}

                {/* Highlighted, because after boarding the people at this
                    object the screen otherwise looks finished -- and the next
                    object still has a crew standing on it. */}
                {!driving && stillToCollect.length > 0 && (
                  <div className="suggestion-card">
                    <div className="cell-title" style={{ marginBottom: 6 }}>
                      {goingHomeWithoutThem ? "⏳ Ще працюють на обʼєктах" : "🚗 Ще є люди на інших обʼєктах"}
                    </div>
                    {/* Обрали їхати без них -- тоді це нагадування, чого ви
                        чекаєте, а не завдання. Кнопки лишаються: передумати
                        й заїхати можна будь-коли. */}
                    {goingHomeWithoutThem && (
                      <div className="hint" style={{ marginBottom: 6 }}>
                        Не забираємо — доробляють і йдуть самі. Години зупините, коли закінчать. Якщо передумали, можна заїхати:
                      </div>
                    )}
                    {stillToCollect.map((p) => (
                      <button
                        key={p.objectId}
                        className="chip selected"
                        style={{ width: "100%", marginTop: 6, textAlign: "left" }}
                        onClick={() => {
                          setHeadingToObjectId(p.objectId);
                          departFromObject();
                          haptic("selection");
                        }}
                      >
                        Їхати на 📍 {p.objectName} · 👤 {p.here.length}
                      </button>
                    ))}
                  </div>
                )}

                <div className="section-title">Усі обʼєкти</div>
                <div className="list">
                  {returnObjects.map((p) => {
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
                              <span className="badge ok">✅ усі виїхали</span>
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
                          <div style={{ paddingBottom: 8 }}>
                            {/* Бус можна пропонувати лише там, де він стоїть:
                                поки ми в дорозі, посадити нікого не можна. */}
                            {peopleHere > 0 && renderDepartureChoices(p, { allowBus: carAtObjectId === p.objectId, pauseForBus: true })}
                            <div style={{ padding: "4px 16px 0" }}>
                              <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи</div>
                              <div className="hint">
                                {p.works.length
                                  ? p.works.map((w) => `${w.workName}${w.volume && w.volume !== "?" ? ` (${w.volume} ${w.unit})` : ""}`).join(", ")
                                  : "без робіт"}
                              </div>
                            </div>
                          </div>
                        )}
                        {(peopleHere > 0 || worksTotal > 0) && (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 16px 10px" }}>
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
                {anyPending && !goingHomeWithoutThem && !driving && !(parkedAt && parkedAt.here.length) && (
                  <div className="hint" style={{ padding: "0 16px 10px", textAlign: "center" }}>
                    Оберіть обʼєкт вище — поїдемо забирати решту.
                  </div>
                )}

                {/* One slot, following the car: arrive where we are heading,
                    board everyone where we are parked, then set off for base
                    and arrive. The clock is paused while the bus is loaded, so
                    "рушили" and "приїхали" are two honest taps, not one. */}
                {driving && headingTo ? (
                  <MainButton
                    text={`📍 Прибув: ${headingTo.objectName}`}
                    onClick={() => {
                      // Stops the driving clock: loading people can take a
                      // while, and that is not time on the road.
                      pauseDrivingSegment();
                      setCarAtObjectId(headingTo.objectId);
                      // Заїхали -- отже тут були. Без цього обʼєкт, куди люди
                      // дійшли пішки, лишався «ще не відвіданим» назавжди.
                      setPlans((prev) => prev.map((x) => (x.objectId === headingTo.objectId ? { ...x, visited: true } : x)));
                      setHeadingToObjectId("");
                      // Відкриваємо сам обʼєкт: зупинився -- подивився, що
                      // роблять, завершив роботи, забрав людей. Той самий
                      // екран, що й дорогою туди, лише без дій, яких на
                      // зворотному шляху вже не буває.
                      setAtObjectId(headingTo.objectId);
                      setAtObjectReturnStep("RETURN_PICKUP");
                      setStep("AT_OBJECT");
                      haptic("medium");
                    }}
                  />
                ) : !driving && parkedAt && parkedAt.here.length > 0 ? (
                  <MainButton
                    text={`🚐 Посадити всіх у бус (${parkedAt.here.length})`}
                    onClick={async () => {
                      await pickUpHere(parkedAt.objectId, parkedAt.here, false);
                    }}
                  />
                ) : (!anyPending || goingHomeWithoutThem) && !driving ? (
                  <MainButton
                    text={anyPending ? "▶️ Рушили на базу — вони доробляють" : "▶️ Рушили на базу"}
                    onClick={departFromObject}
                  />
                ) : (!anyPending || goingHomeWithoutThem) && driving ? (
                  <MainButton
                    text="🏁 Приїхали на базу"
                    onClick={() => {
                      pauseDrivingSegment();
                      setStep("RETURN");
                    }}
                  />
                ) : null}
              </>
            );
          })()}
        </>
      )}

      {step === "RETURN" && (
        <>
          <div className="step-badge">ПОВЕРНЕННЯ</div>
          {/* Ви вже на базі, а хтось ще доробляє. Це не помилка й нічого не
              блокує тут -- але звіт до їх зупинки не піде (див. `save()`), і
              бригадир має бачити, чого саме чекає, а не впертись у це аж на
              кнопці «Відправити». */}
          {(() => {
            const working = plans.flatMap((p) =>
              p.sessions.filter((s) => !s.endedAt).map((s) => `${shortName(employeeName(s.employeeId))} — «${p.objectName}»`),
            );
            if (!working.length) return null;
            return (
              <div className="empty-state" style={{ textAlign: "left" }}>
                ⏳ <b>Ще працюють:</b>
                <ul className="bullets">
                  {[...new Set(working)].map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                Звіт можна буде відправити, коли зупините їм роботи: обʼєкт → прізвище → «🚶 Зняти» або «🕒 Ввести години вручну».
              </div>
            );
          })()}
          <div className="section-title">Обʼєкти</div>
          <div className="hint" style={{ padding: "0 16px 8px" }}>Перевірте обсяги й уведіть кінцевий одометр</div>
          <div className="list">
            {plans
              .filter((p) => p.visited || p.here.length > 0 || p.sessions.length > 0)
              .map((p) => {
                const unfilled = p.works.filter((w) => !w.volume || w.volume === "?").length;
                const expanded = expandedReturnObjectId === p.objectId;
                return (
                  <div key={p.objectId}>
                    <div className="cell-row">
                      <button className="cell" onClick={() => setExpandedReturnObjectId(expanded ? null : p.objectId)}>
                        <span className="cell-title">
                          {expanded ? "▾" : "▸"} {p.objectName}
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
                        {p.here.length > 0 && renderDepartureChoices(p, { allowBus: true, pauseForBus: false })}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", flexWrap: "wrap" }}>
                      {unfilled > 0 && (
                        <button className="chip" onClick={() => openVolumesForObject(p.objectId, "RETURN")}>
                          🟡 Ввести обсяги ({unfilled})
                        </button>
                      )}
                      {/* The forgotten-timer rescue, now that the work is over
                          and it is clear whose hours never got recorded. */}
                      {p.sessions.length > 0 && (
                        <button
                          className="chip"
                          onClick={() => {
                            setAtObjectId(p.objectId);
                            setAtObjectReturnStep("RETURN");
                            setManualHoursEmployeeId(null);
                            setManualHoursBuffer("");
                            setShowManualHours(true);
                            setStep("AT_OBJECT");
                          }}
                        >
                          🕒 Години вручну
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {(() => {
            // Hours decide both who is in an object's split and how big their
            // slice is, and anything under MIN_PAID_HOURS counts as no work at
            // all -- so these people would be paid nothing, silently. A
            // forgotten timer and a mis-tapped one land here alike. The rescue
            // (🕒 Години вручну) sits on each object right above.
            const unpaid = employeeIds
              .map((id) => ({ id, best: Math.max(0, ...plans.map((p) => hoursAtObject(p, id))) }))
              .filter((x) => x.best < MIN_PAID_HOURS);
            if (!unpaid.length) return null;
            return (
              <div className="hint" style={{ padding: "0 16px 10px", color: "#d70015" }}>
                ⚠️ Менше {MIN_PAID_HOURS} год — за цей день нічого не нарахується:
                <ul className="bullets">
                  {unpaid.map((x) => (
                    <li key={x.id}>
                      {shortName(employeeName(x.id))}
                      {x.best > 0 ? ` — ${fmtHours(x.best)}` : ""}
                    </li>
                  ))}
                </ul>
                Відкрийте «🕒 Години вручну» на тому обʼєкті, де людина працювала.
              </div>
            );
          })()}

          {/* Coefficients are a property of the PERSON FOR THE DAY, not of a
              person at an object -- they used to sit on each object's volume
              screen, so somebody who worked at two objects appeared twice,
              editing the same single value from two places. And the list was
              filtered to "робітник", which quietly dropped the brigadier and
              the senior gardener even though the day records a coefficient
              for them too. One block, everyone who worked anywhere today,
              however they got there and however they left. */}
          {(() => {
            const dayWorkerIds = [...new Set(plans.flatMap((p) => p.sessions.map((s) => s.employeeId)))];
            if (!dayWorkerIds.length) return null;
            const changed = dayWorkerIds.filter((id) => coefFor(id).disciplineCoef !== 1 || coefFor(id).productivityCoef !== 1);
            return (
              <>
                <div className="section-title row">
                  <span>Коефіцієнти за день</span>
                  <button className="chip chip-sm" onClick={() => setCoefsExpanded((v) => !v)}>
                    {coefsExpanded ? "▾ Згорнути" : changed.length ? `▸ Змінено: ${changed.length}` : "▸ Усі 1.0"}
                  </button>
                </div>
                {coefsExpanded && (
                  <>
                    <div className="hint" style={{ padding: "0 16px 8px" }}>
                      Один на весь день, на всі обʼєкти, де людина працювала. За замовчуванням 1.0.
                    </div>
                    <div className="list">
                      {dayWorkerIds.map((id) => (
                        <div key={id} className="cell" style={{ cursor: "default", display: "block" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="cell-title">{shortName(employeeName(id))}</span>
                            {roleFor(id) !== "робітник" && <span className={roleTagClass(roleFor(id))}>{roleFor(id)}</span>}
                            {selfTransportIds.includes(id) && <span className="badge">🚶 свій транспорт</span>}
                          </div>
                          <div className="coef-row">
                            <span className="coef-label">Дисципліна</span>
                            {COEF_PRESETS.map((v) => (
                              <button
                                key={v}
                                className={`coef-btn ${coefFor(id).disciplineCoef === v ? "selected" : ""}`}
                                onClick={() => setCoef(id, "disciplineCoef", v)}
                              >
                                {v}
                              </button>
                            ))}
                          </div>
                          <div className="coef-row">
                            <span className="coef-label">Продуктивність</span>
                            {COEF_PRESETS.map((v) => (
                              <button
                                key={v}
                                className={`coef-btn ${coefFor(id).productivityCoef === v ? "selected" : ""}`}
                                onClick={() => setCoef(id, "productivityCoef", v)}
                              >
                                {v}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            );
          })()}

          <div className="section-title">Одометр на фініші</div>
          <div className="hint" style={{ padding: "0 16px" }}>Старт: {odoStart} км</div>
          <div className={`big-number ${odoEnd ? "" : "empty"}`}>{odoEnd || "0"} км</div>
          {odoEnd && Number(odoEnd) >= Number(odoStart) && (
            <>
              <div className="hint" style={{ textAlign: "center" }}>
                Пройдено {Math.round((Number(odoEnd) - Number(odoStart)) * 10) / 10} км · загальний час у дорозі{" "}
                {fmtHMS(drivingAccumulatedMs + (drivingSegmentStartedAt ? now - new Date(drivingSegmentStartedAt).getTime() : 0))}
              </div>
              {errandKm > 0 && (
                <div className="hint" style={{ textAlign: "center" }}>
                  з них по справам {errandKm} км — не враховано в доплату за виїзд
                </div>
              )}
            </>
          )}
          {odoEnd && Number(odoEnd) < Number(odoStart) && (
            <div className="hint" style={{ textAlign: "center", color: "var(--tg-destructive-text, #e53935)" }}>
              ⚠️ Не може бути менше за старт ({odoStart} км)
            </div>
          )}
          <NumericKeypad value={odoEnd} onChange={setOdoEnd} decimal={false} />
          <div className="field">
            {odoEndPhoto ? (
              <div className="badge ok">📷 Фото додано</div>
            ) : (
              <>
                {PHOTOS_ENABLED && <PhotoButton text="📷 Зняти спідометр" disabled={uploadingPhoto} onPick={(file) => uploadPhoto(file, "end")} />}
                <div className="hint" style={{ marginTop: 6 }}>Не обовʼязково</div>
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
          {/* The date this day will be filed under, surfaced only when it is
              NOT today -- and it can differ without anyone touching it. The
              draft on the phone keeps the date it was created with, so an
              evening spent opening a trip an admin had just planned put the
              whole of the next day onto the day before.
              That is worse than a wrong label: a second day filed under an
              earlier date overwrites that date's odometer row (keyed by
              date+car), and the first day's mileage is gone for good.
              This is the last screen before it becomes a fact. */}
          {date !== todayISO() && (
            <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
              ⚠️ <b>День буде записано як {date}</b> — це не сьогодні ({todayISO()}).
              <div style={{ marginTop: 8 }}>
                <button
                  className="back-btn"
                  onClick={() => {
                    setDate(todayISO());
                    logChange(`Дату дня виправлено на ${todayISO()}`);
                    haptic("success");
                  }}
                >
                  Виправити на {todayISO()}
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Якщо ви справді вносите минулий день — лишіть як є.</div>
            </div>
          )}
          {/* One compact block: the numbers of the trip, each with its own way
              back into the step that owns it. It used to be four full-width
              sections with a "редагувати" chip each, which pushed the actual
              day -- the objects -- below the fold. */}
          {/* The 20% for running the day is always owed to somebody. The server
              falls back to the foreman when no brigadier rode along, matching
              КОРИСТУВАЧІ.ПІБ against the ПРАЦІВНИКИ dictionary -- the sheets
              share no id, so the name is the only bridge and it CAN miss. When
              it does the money goes to the company, and that must never happen
              quietly: this is the one screen where it is still fixable. */}
          {preview && preview.brigadierEmployeeIds.length === 0 && (
            <div className="empty-state" style={{ textAlign: "left", color: "#d70015" }}>
              ⚠️ <b>Не вдалось визначити, кому нарахувати 20% за ведення дня</b> — вони підуть фірмі. Причина: ваш ПІБ у аркуші
              КОРИСТУВАЧІ не збігається з жодним рядком у ПРАЦІВНИКИ. Покажіть це адміністратору — виправляється одним
              редагуванням аркуша.
            </div>
          )}

          <div className="section-title">Поїздка</div>
          <div className="list">
            <div className="cell">
              <span className="cell-title">Проїхано</span>
              <span className="cell-sub">{preview ? `${preview.km} км · клас ${preview.tripClass}` : "рахую…"}</span>
            </div>
            {preview && !!preview.excludedKm && (
              <div className="cell">
                <span className="cell-title">З них по справам</span>
                <span className="cell-sub">
                  {preview.excludedKm} км — не в доплаті{preview.billableKm != null ? ` (до класу: ${preview.billableKm} км)` : ""}
                </span>
              </div>
            )}
            <div className="cell-row">
              <div className="cell" style={{ cursor: "default" }}>
                <span className="cell-title">🚙 {cars.find((c) => c.id === carId)?.name ?? "—"}</span>
                <span className="cell-sub">
                  {odoStart} → {odoEnd || "—"} км
                </span>
              </div>
              <button
                className="cell-action"
                title="Змінити авто"
                onClick={() => {
                  setEditReturnStep("REVIEW");
                  setStep("PICK_CAR");
                }}
              >
                ✏️
              </button>
              <button
                className="cell-action"
                title="Змінити кінцевий одометр"
                onClick={() => {
                  setReviewReturnStep("REVIEW");
                  setStep("RETURN");
                }}
              >
                🏁
              </button>
            </div>
            <div className="cell">
              <span className="cell-title">Людей у дні</span>
              <span className="cell-sub">{nPeople(employeeIds.length)}</span>
            </div>
          </div>

          {/* People live inside the object they worked at, not in two separate
              rosters at the bottom of the screen: "who was where, for how
              long, on what" is one question, and the answer belongs together. */}
          <div className="section-title">Обʼєкти</div>
          <div className="list">
            {plans.map((p) => {
              const expanded = expandedReviewObjectId === p.objectId;
              const unfilled = p.works.filter((w) => !w.volume || w.volume === "?").length;
              const peopleHere = [...new Set(p.sessions.map((s) => s.employeeId))];
              // Hours set the amounts now, so they belong on the summary the
              // foreman signs off, not only in the report the admin sees after
              // approval. The share is of the object's HOURS -- deliberately
              // not of the money, which stays hidden until approval.
              // Only hours that will actually be paid: someone under the
              // minimum is not in the pot, so counting them would make
              // everyone else's percentage read lower than they will be paid.
              const objectHours = peopleHere.reduce((a, id) => {
                const h = hoursAtObject(p, id);
                return a + (h >= MIN_PAID_HOURS ? h : 0);
              }, 0);
              return (
                <div key={p.objectId}>
                  <div className="cell-row">
                    <button className="cell" onClick={() => setExpandedReviewObjectId(expanded ? null : p.objectId)}>
                      <span className="cell-title">
                        {expanded ? "▾" : "▸"} {p.objectName}
                      </span>
                      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <span className="badge">👤 {peopleHere.length}</span>
                        <span className={`badge ${objectHours > 0 ? "" : "warn"}`}>⏱ {fmtHours(objectHours)}</span>
                        {p.works.length > 0 && (
                          <span className={`badge ${unfilled === 0 ? "ok" : "warn"}`}>
                            {unfilled === 0 ? "✅ обсяги є" : `🟡 ${unfilled} без обсягу`}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ padding: "4px 16px 12px" }}>
                      {p.noWork && (
                        <div className="hint" style={{ color: "#b06a00", marginBottom: 6 }}>
                          ⚠️ Були на обʼєкті, роботи не виконувались
                        </div>
                      )}
                      <div className="hint" style={{ fontWeight: 600 }}>🛠 Роботи</div>
                      {p.works.length ? (
                        <ul className="bullets">
                          {p.works.map((w) => (
                            <li key={w.workId}>
                              {w.workName}: {w.volume && w.volume !== "?" ? `${w.volume} ${w.unit}` : "не введено"}
                              {(w.employeeIds ?? []).length > 0 && ` — окремо: ${(w.employeeIds ?? []).map((id) => shortName(employeeName(id))).join(", ")}`}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="hint">без робіт</div>
                      )}
                      <div className="row-actions">
                        <button
                          className="chip chip-sm"
                          onClick={() => openVolumesForObject(p.objectId, "REVIEW")}
                          disabled={!p.works.length}
                        >
                          🟡 Змінити обсяги{unfilled ? ` (${unfilled})` : ""}
                        </button>
                        <button
                          className="chip chip-sm"
                          onClick={() => {
                            openWorksPicker(p.objectId, "REVIEW");
                          }}
                        >
                          ✏️ Змінити роботи
                        </button>
                      </div>

                      <div className="hint" style={{ fontWeight: 600, marginTop: 14 }}>👥 Люди на цьому обʼєкті</div>
                      {peopleHere.length > 0 && (
                        <div className="hint">Робітнича частина обʼєкта ділиться пропорційно цим годинам.</div>
                      )}
                      {peopleHere.length ? (
                        <div className="list" style={{ margin: "6px 0 0" }}>
                          {peopleHere.map((id) => {
                            const c = coefFor(id);
                            const coefOpen = expandedCoefEmployeeId === `${p.objectId}::${id}`;
                            return (
                              <div key={id} className="cell" style={{ cursor: "default", display: "block" }}>
                                <button
                                  className="cell"
                                  style={{ padding: 0, border: "none" }}
                                  onClick={() => setExpandedCoefEmployeeId(coefOpen ? null : `${p.objectId}::${id}`)}
                                >
                                  <span className="cell-title">
                                    {coefOpen ? "▾" : "▸"} {shortName(employeeName(id))}
                                    {roleFor(id) !== "робітник" && <span className={roleTagClass(roleFor(id))} style={{ marginLeft: 6 }}>{roleFor(id)}</span>}
                                  </span>
                                  <span className="cell-sub">
                                    {fmtHours(hoursAtObject(p, id))}
                                    {hoursAtObject(p, id) < MIN_PAID_HOURS ? (
                                      <span style={{ color: "#d70015" }}> · не оплачується</span>
                                    ) : (
                                      objectHours > 0 &&
                                      dayApproved &&
                                      ` · ${Math.round((hoursAtObject(p, id) / objectHours) * 100)}%`
                                    )}
                                    {c.disciplineCoef !== 1 || c.productivityCoef !== 1 ? ` · ${c.disciplineCoef}/${c.productivityCoef}` : ""}
                                  </span>
                                </button>
                                {coefOpen && (
                                  <>
                                    <div className="hint" style={{ marginTop: 6 }}>
                                      Коефіцієнт єдиний на весь день — діє на всі обʼєкти, де людина працювала.
                                    </div>
                                    <div className="coef-row">
                                      <span className="coef-label">Дисципліна</span>
                                      {COEF_PRESETS.map((v) => (
                                        <button
                                          key={v}
                                          className={`coef-btn ${c.disciplineCoef === v ? "selected" : ""}`}
                                          onClick={() => setCoef(id, "disciplineCoef", v)}
                                        >
                                          {v}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="coef-row">
                                      <span className="coef-label">Продуктивність</span>
                                      {COEF_PRESETS.map((v) => (
                                        <button
                                          key={v}
                                          className={`coef-btn ${c.productivityCoef === v ? "selected" : ""}`}
                                          onClick={() => setCoef(id, "productivityCoef", v)}
                                        >
                                          {v}
                                        </button>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="hint" style={{ color: "#d70015" }}>
                          Нікого — за цей обʼєкт гроші не розподіляться
                        </div>
                      )}
                      <div className="row-actions">
                        <button
                          className="chip chip-sm"
                          onClick={() => {
                            setAtObjectId(p.objectId);
                            setAtObjectReturnStep("REVIEW");
                            setStep("AT_OBJECT");
                          }}
                        >
                          👥 Змінити людей
                        </button>
                        <button
                          className="chip chip-sm"
                          onClick={() => {
                            setAtObjectId(p.objectId);
                            setAtObjectReturnStep("REVIEW");
                            setManualHoursEmployeeId(null);
                            setManualHoursBuffer("");
                            setShowManualHours(true);
                            setStep("AT_OBJECT");
                          }}
                        >
                          🕒 Змінити години
                        </button>
                        <button className="chip chip-sm" onClick={() => setRetroReplaceObjectId(p.objectId)}>
                          🔁 Замінити обʼєкт іншим
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

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
