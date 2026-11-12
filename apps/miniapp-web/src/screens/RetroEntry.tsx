import { useEffect, useMemo, useState } from "react";
import { api, type Car, type Employee, type Work, type WorkObject, type SalaryPack } from "../lib/api";
import { todayISO } from "../lib/date";
import { confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, initials, roleAccent, groupByBrigade, shortName, type EmployeeRole, roleTagClass } from "../lib/employee";
import { groupWorks } from "../lib/works";
import { plural, works as nWorks } from "../lib/plural";
import { BackRow } from "../components/BackRow";
import { MainButton } from "../components/MainButton";

/**
 * "Внести заднім числом" -- a flat form for entering a day that already
 * happened, as opposed to the live road timesheet (RoadTimesheet.tsx), which
 * walks the foreman through the day step by step and derives hours from
 * start/stop timers that only exist while the day is actually being worked.
 *
 * The shape follows how a finished day is actually remembered: one car for
 * the whole trip, then each object in turn with the people who were there,
 * their hours, the works done and how much of each. People are picked PER
 * OBJECT rather than once for the day -- on a finished day there's no "crew
 * on board" left to model, only who ended up working where.
 *
 * Nothing here is a new data path: it posts the same payload to the same
 * POST /api/road-timesheet as the live flow, so payroll, the trip class, the
 * travel allowance and the admin approval all behave identically. The only
 * difference is where the numbers come from -- hours are typed in instead of
 * measured, and the sessions sent to the server are synthesised from them.
 */

// employeeIds: кому зарахувати саме цю роботу. Порожньо = спільна для всіх,
// кого обрали на цей обʼєкт (звичайний випадок).
type RetroWork = { workId: string; workName: string; unit: string; volume: string; employeeIds?: string[] };
type RetroObject = {
  objectId: string;
  objectName: string;
  works: RetroWork[];
  // Who worked at THIS object. The day's overall roster (what the travel
  // allowance gets split between) is the union of these across every object.
  employeeIds: string[];
  // Typed hours per employee, kept as raw strings so a half-typed "1." or an
  // intentionally blank field survives re-renders. Anything that isn't a
  // positive number is treated as "no hours recorded" at submit time.
  hoursByEmployeeId: Record<string, string>;
};

type Stage = "form" | "review";

type PreviewResponse = {
  km: number;
  billableKm: number;
  tripClass: string;
  salaryPacks: SalaryPack[];
  roadAllowance: { total: number; perPerson: number };
};

type DayStatusResponse = { hasSubmission: boolean; approved: boolean };

// Sessions are only ever read as a duration (pickedUpAt - droppedAt) by the
// server's payroll code, but they're stored in the event log too, so anchor
// them at a plausible 08:00 start on the day being entered rather than at
// "now" -- an audit trail showing a July shift logged at today's clock time
// would be actively misleading.
const DAY_START_HOUR = 8;

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function RetroEntry({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<Stage>("form");

  const [cars, setCars] = useState<Car[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [objects, setObjects] = useState<WorkObject[]>([]);

  const [date, setDate] = useState(() => yesterdayISO());
  const [carId, setCarId] = useState("");
  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [plans, setPlans] = useState<RetroObject[]>([]);

  const [dayApproved, setDayApproved] = useState(false);
  const [daySubmitted, setDaySubmitted] = useState(false);

  const [showObjectPicker, setShowObjectPicker] = useState(false);
  const [objectSearch, setObjectSearch] = useState("");
  // Which object's sub-picker is open, if any. Only one is ever open at a
  // time so the screen stays a short, readable list of object cards.
  const [peoplePickerObjectId, setPeoplePickerObjectId] = useState<string | null>(null);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [expandedBrigadeId, setExpandedBrigadeId] = useState<string | null>(null);
  const [worksPickerObjectId, setWorksPickerObjectId] = useState<string | null>(null);
  // Яка робота відкрита для призначення людей (ключ `${objectId}::${workId}`).
  const [assigningWorkKey, setAssigningWorkKey] = useState<string | null>(null);
  const [worksSearch, setWorksSearch] = useState("");
  const [expandedWorkCategoryId, setExpandedWorkCategoryId] = useState<string | null>(null);
  const [expandedWorkSubcategoryId, setExpandedWorkSubcategoryId] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Car[]>("/api/dictionaries/cars").then(setCars).catch((e) => setError(e.message));
    api.get<Employee[]>("/api/dictionaries/employees").then(setEmployees).catch((e) => setError(e.message));
    api.get<Work[]>("/api/dictionaries/works").then(setWorks).catch((e) => setError(e.message));
    api.get<WorkObject[]>("/api/dictionaries/objects").then(setObjects).catch((e) => setError(e.message));
  }, []);

  // Deliberately does NOT check who else had this car or these people that
  // day: on a finished day there's no double-booking race left to lose, and
  // a stale reservation (another foreman who reserved and never submitted)
  // would block recording what actually happened. The server skips the same
  // checks for a past date -- see `backdated` in the save payload. An
  // already-approved day is still off limits.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    api
      .get<DayStatusResponse>(`/api/road-timesheet/day-status?date=${date}`)
      .then((r) => {
        if (cancelled) return;
        setDayApproved(r.approved);
        setDaySubmitted(r.hasSubmission);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [date]);

  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const employeeName = (id: string) => employeeById.get(id)?.name ?? id;
  const roleFor = (id: string): EmployeeRole => {
    const emp = employeeById.get(id);
    return emp ? employeeRole(emp) : "робітник";
  };

  const km = useMemo(() => {
    const a = Number(odoStart);
    const b = Number(odoEnd);
    if (!odoStart || !odoEnd || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return b - a;
  }, [odoStart, odoEnd]);

  const today = todayISO();
  const dateInFuture = !!date && date > today;

  // The day's roster: everyone who was at at least one object. This is what
  // the server splits the travel allowance between, so the review screen
  // spells it out instead of leaving it implicit.
  const allEmployeeIds = [...new Set(plans.flatMap((p) => p.employeeIds))];

  function updatePlan(objectId: string, patch: (p: RetroObject) => RetroObject) {
    setPlans((prev) => prev.map((p) => (p.objectId === objectId ? patch(p) : p)));
  }

  function toggleObject(obj: WorkObject) {
    setPlans((prev) =>
      prev.some((p) => p.objectId === obj.id)
        ? prev.filter((p) => p.objectId !== obj.id)
        : [...prev, { objectId: obj.id, objectName: obj.name, works: [], employeeIds: [], hoursByEmployeeId: {} }],
    );
    haptic("selection");
  }

  function removeObject(objectId: string) {
    setPlans((prev) => prev.filter((p) => p.objectId !== objectId));
    if (worksPickerObjectId === objectId) setWorksPickerObjectId(null);
    if (peoplePickerObjectId === objectId) setPeoplePickerObjectId(null);
    haptic("selection");
  }

  function toggleEmployeeAtObject(objectId: string, employeeId: string) {
    updatePlan(objectId, (p) => {
      if (!p.employeeIds.includes(employeeId)) return { ...p, employeeIds: [...p.employeeIds, employeeId] };
      // Taking someone off an object clears their hours there too, so
      // re-adding them later starts blank instead of silently restoring a
      // number the foreman thought they had removed.
      const hours = { ...p.hoursByEmployeeId };
      delete hours[employeeId];
      return { ...p, employeeIds: p.employeeIds.filter((x) => x !== employeeId), hoursByEmployeeId: hours };
    });
    haptic("selection");
  }

  function toggleBrigadeAtObject(objectId: string, members: Employee[], allSelected: boolean) {
    updatePlan(objectId, (p) => {
      if (!allSelected) return { ...p, employeeIds: [...new Set([...p.employeeIds, ...members.map((e) => e.id)])] };
      const hours = { ...p.hoursByEmployeeId };
      for (const e of members) delete hours[e.id];
      return {
        ...p,
        employeeIds: p.employeeIds.filter((id) => !members.some((e) => e.id === id)),
        hoursByEmployeeId: hours,
      };
    });
    haptic("selection");
  }

  function toggleWork(objectId: string, work: Work) {
    updatePlan(objectId, (p) =>
      p.works.some((w) => w.workId === work.id)
        ? { ...p, works: p.works.filter((w) => w.workId !== work.id) }
        : { ...p, works: [...p.works, { workId: work.id, workName: work.name, unit: work.unit ?? "", volume: "", employeeIds: [] }] },
    );
    haptic("selection");
  }

  /** One selectable work row -- rendered both directly under a category and
   * inside a subcategory group. */
  function workCell(plan: RetroObject, w: Work) {
    const checked = plan.works.some((pw) => pw.workId === w.id);
    return (
      <button key={w.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleWork(plan.objectId, w)}>
        <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
          {w.name}
        </span>
        <span className="cell-sub">{w.unit ?? "од."}</span>
      </button>
    );
  }

  function setHours(objectId: string, employeeId: string, raw: string) {
    updatePlan(objectId, (p) => ({ ...p, hoursByEmployeeId: { ...p.hoursByEmployeeId, [employeeId]: raw } }));
  }

  /** Порожній список = робота спільна, тож зняття останньої людини повертає
   * її всій бригаді на цьому обʼєкті. */
  function toggleWorkAssignee(objectId: string, workId: string, employeeId: string) {
    updatePlan(objectId, (p) => ({
      ...p,
      works: p.works.map((w) => {
        if (w.workId !== workId) return w;
        const current = w.employeeIds ?? [];
        return { ...w, employeeIds: current.includes(employeeId) ? current.filter((x) => x !== employeeId) : [...current, employeeId] };
      }),
    }));
    haptic("selection");
  }

  function setVolume(objectId: string, workId: string, raw: string) {
    updatePlan(objectId, (p) => ({ ...p, works: p.works.map((w) => (w.workId === workId ? { ...w, volume: raw } : w)) }));
  }

  /** Typed hours -> the (droppedAt, pickedUpAt) pair the server measures. */
  function buildSessions(plan: RetroObject) {
    const base = new Date(`${date}T${String(DAY_START_HOUR).padStart(2, "0")}:00:00`).getTime();
    if (!Number.isFinite(base)) return [];
    return plan.employeeIds
      .map((employeeId) => ({ employeeId, hours: Number(plan.hoursByEmployeeId[employeeId]) }))
      .filter((x) => Number.isFinite(x.hours) && x.hours > 0)
      .map((x) => ({
        employeeId: x.employeeId,
        employeeName: employeeName(x.employeeId),
        droppedAt: new Date(base).toISOString(),
        pickedUpAt: new Date(base + x.hours * 3_600_000).toISOString(),
      }));
  }

  function buildObjects() {
    return plans.map((p) => {
      const sessions = buildSessions(p);
      return {
        objectId: p.objectId,
        objectName: p.objectName,
        // "?" is the server's marker for "volume not filled in yet"
        // (volumeStatus НЕ_ЗАПОВНЕНО), same as the live flow sends.
        works: p.works.map((w) => ({
          workId: w.workId,
          workName: w.workName,
          volume: w.volume || "?",
          employeeIds: w.employeeIds ?? [],
        })),
        sessions,
        notes: "",
        photoUrls: [],
      };
    });
  }

  function objectHours(p: RetroObject) {
    return p.employeeIds.reduce((acc, id) => {
      const h = Number(p.hoursByEmployeeId[id]);
      return acc + (Number.isFinite(h) && h > 0 ? h : 0);
    }, 0);
  }

  const totalHours = plans.reduce((acc, p) => acc + objectHours(p), 0);
  const emptyVolumeCount = plans.reduce((acc, p) => acc + p.works.filter((w) => !w.volume).length, 0);
  const peopleWithoutHours = allEmployeeIds.filter(
    (id) => !plans.some((p) => p.employeeIds.includes(id) && Number(p.hoursByEmployeeId[id]) > 0),
  );

  const formComplete =
    !!date && !dateInFuture && !dayApproved && !!carId && km !== null && km >= 0 && plans.length > 0 && allEmployeeIds.length > 0;

  async function goToReview() {
    if (!formComplete) return;
    setError(null);
    setPreview(null);
    setStage("review");
    try {
      const res = await api.post<PreviewResponse>("/api/road-timesheet/preview", {
        date,
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds: allEmployeeIds,
        objects: buildObjects(),
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    // Same guard as the live flow's save(): an object with real volume but
    // nobody with hours earns money that can't be split (pay is by hours), so
    // most of it silently goes to the company instead of the crew.
    const noHoursObjects = plans.filter(
      (p) => !buildSessions(p).length && p.works.some((w) => w.volume && w.volume !== "?" && Number(w.volume) > 0),
    );
    if (noHoursObjects.length) {
      const many = noHoursObjects.length > 1;
      const ok = await confirmDialog(
        `На об'єкт${many ? "ах" : "і"} ${noHoursObjects.map((p) => `«${p.objectName}»`).join(", ")} ` +
          `не введено години нікому — за ${many ? "них" : "нього"} гроші не розподіляться між людьми.\n\n` +
          `Відправити все одно?`,
      );
      if (!ok) return;
    }

    // This form always submits as a NEW trip for the day (it never sends a
    // tripSeq), so on a date that already has a report it ADDS to it rather
    // than replacing it -- and this screen doesn't show what's already there.
    // Sending the same day twice would double its volumes and hours.
    if (daySubmitted) {
      const ok = await confirmDialog(
        `На ${date} вже є зданий звіт. Ці дані додадуться до нього окремою поїздкою, а не замінять його.\n\n` +
          `Якщо треба виправити наявний звіт — робіть це у «Дорожньому табелі», а не тут. Продовжити?`,
      );
      if (!ok) return;
    }

    if (emptyVolumeCount) {
      const ok = await confirmDialog(
        `Не заповнено обсяг у ${emptyVolumeCount} ${plural(emptyVolumeCount, "роботі", "роботах", "роботах")} — вони підуть як «не заповнено» ` +
          `і за них не нарахується оплата.\n\nВідправити все одно?`,
      );
      if (!ok) return;
    }

    setSaving(true);
    setError(null);
    try {
      // Same role as in the live flow: one key per tap, reused across this
      // call's own network retries, so a lost response can't turn into a
      // second, duplicate leg for the day.
      const idempotencyKey = crypto.randomUUID();
      await api.post("/api/road-timesheet", {
        date,
        carId,
        odoStart: Number(odoStart),
        odoEnd: Number(odoEnd),
        employeeIds: allEmployeeIds,
        objects: buildObjects(),
        idempotencyKey,
        // Tells the server this is a finished day being recorded, so it skips
        // the car/people reservation checks that only mean anything while a
        // day is being worked live. Honoured only for a genuinely past date.
        backdated: true,
      });
      haptic("success");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setSaving(false);
    }
  }

  const goBack = () => {
    if (stage === "review") {
      setStage("form");
      return;
    }
    if (peoplePickerObjectId) {
      setPeoplePickerObjectId(null);
      return;
    }
    if (worksPickerObjectId) {
      setWorksPickerObjectId(null);
      return;
    }
    if (showObjectPicker) {
      setShowObjectPicker(false);
      return;
    }
    onBack();
  };
  useTelegramBackButton(goBack);

  return (
    <div>
      <BackRow onBack={goBack} />
      <div className="header">
        <h1>🗓 Заднім числом</h1>
        <div className="hint">Внесення дня, який уже відпрацювали</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      {stage === "form" && (
        <>
          <div className="step-badge">1 · 📅 ДЕНЬ І АВТО</div>
          <div className="field">
            <label>Дата, яку вносимо</label>
            <input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {dateInFuture && <div className="empty-state">⚠️ Дата в майбутньому — оберіть сьогодні або раніше.</div>}
          {dayApproved && (
            <div className="empty-state">🔒 Цей день уже затверджено — редагування недоступне без запиту на редагування.</div>
          )}
          {daySubmitted && !dayApproved && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ℹ️ На цю дату вже є зданий звіт — те, що внесете тут, додасться до нього окремою поїздкою.
            </div>
          )}

          <div className="section-title">🚙 Яким авто їздили</div>
          <div className="list">
            {cars.map((c) => (
              <button
                key={c.id}
                className={`cell ${carId === c.id ? "selected" : ""}`}
                onClick={() => {
                  setCarId(c.id);
                  haptic("selection");
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="setup-icon accent-blue">🚙</span>
                  <span className="cell-title">{c.name}</span>
                </span>
                <span className="cell-sub">{c.plate ?? ""}</span>
              </button>
            ))}
          </div>

          <div className="grid-2">
            <div className="field">
              <label>Одометр на старті</label>
              <input inputMode="decimal" placeholder="0" value={odoStart} onChange={(e) => setOdoStart(e.target.value)} />
            </div>
            <div className="field">
              <label>Одометр на фініші</label>
              <input inputMode="decimal" placeholder="0" value={odoEnd} onChange={(e) => setOdoEnd(e.target.value)} />
            </div>
          </div>
          {km !== null && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              {km < 0 ? "⚠️ Фініш менший за старт" : `Проїхано: ${Math.round(km * 100) / 100} км`}
            </div>
          )}

          <div className="step-badge">2 · 📍 ОБʼЄКТИ</div>
          <div className="section-title row">
            <span>Куди їздили — обрано {plans.length}</span>
            <button className="chip" onClick={() => setShowObjectPicker((v) => !v)}>
              {showObjectPicker ? "▾ Згорнути" : "➕ Додати обʼєкт"}
            </button>
          </div>
          {!plans.length && !showObjectPicker && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              Додайте обʼєкти — у кожному оберете своїх людей, години, роботи та обсяги.
            </div>
          )}
          {showObjectPicker && (
            <>
              <input className="search-box" placeholder="Пошук обʼєкта…" value={objectSearch} onChange={(e) => setObjectSearch(e.target.value)} />
              <div className="list">
                {objects
                  .filter((o) => o.name.toLowerCase().includes(objectSearch.toLowerCase()))
                  .map((o) => {
                    const checked = plans.some((p) => p.objectId === o.id);
                    return (
                      <button key={o.id} className={`cell ${checked ? "selected" : ""}`} onClick={() => toggleObject(o)}>
                        <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                          📍 {o.name}
                        </span>
                        <span className="cell-sub">{o.address ?? ""}</span>
                      </button>
                    );
                  })}
              </div>
            </>
          )}

          {plans.map((p, idx) => {
            const peopleOpen = peoplePickerObjectId === p.objectId;
            const worksOpen = worksPickerObjectId === p.objectId;
            return (
              <div key={p.objectId}>
                <div className="step-badge">
                  ОБʼЄКТ {idx + 1} · {p.objectName}
                </div>

                <div className="section-title row">
                  <span>👥 Хто тут працював — {p.employeeIds.length}</span>
                  <button
                    className="chip"
                    onClick={() => {
                      setPeopleSearch("");
                      setWorksPickerObjectId(null);
                      setPeoplePickerObjectId(peopleOpen ? null : p.objectId);
                    }}
                  >
                    {peopleOpen ? "▾ Готово" : "➕ Обрати людей"}
                  </button>
                </div>

                {peopleOpen && (
                  <>
                    <input className="search-box" placeholder="Пошук людини…" value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} />
                    <div className="list">
                      {groupByBrigade(employees.filter((e) => e.name.toLowerCase().includes(peopleSearch.toLowerCase())), employees).map((g) => {
                        const expanded = expandedBrigadeId === g.id || !!peopleSearch;
                        const selectedCount = g.members.filter((e) => p.employeeIds.includes(e.id)).length;
                        const allSelected = g.members.length > 0 && g.members.every((e) => p.employeeIds.includes(e.id));
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
                                  onClick={() => toggleBrigadeAtObject(p.objectId, g.members, allSelected)}
                                >
                                  {allSelected ? "✕ Зняти всю бригаду" : "✓ Обрати всю бригаду"}
                                </button>
                                {g.members.map((emp) => {
                                  const checked = p.employeeIds.includes(emp.id);
                                  return (
                                    <button
                                      key={emp.id}
                                      className={`cell ${checked ? "selected" : ""}`}
                                      onClick={() => toggleEmployeeAtObject(p.objectId, emp.id)}
                                    >
                                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <span className={`checkbox ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span>
                                        <span className={`avatar-circle ${roleAccent(employeeRole(emp))}`}>{initials(emp.name)}</span>
                                        {emp.name}
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
                  </>
                )}

                {!p.employeeIds.length ? (
                  <div className="hint" style={{ padding: "0 16px 8px" }}>Ще нікого не обрано на цей обʼєкт.</div>
                ) : (
                  <>
                    <div className="hint" style={{ padding: "0 16px 4px" }}>Скільки годин кожен відпрацював тут</div>
                    <div className="list">
                      {p.employeeIds.map((id) => (
                        <div key={id} className="cell" style={{ cursor: "default" }}>
                          <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                            {employeeName(id)}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              className="hours-input"
                              inputMode="decimal"
                              placeholder="0"
                              value={p.hoursByEmployeeId[id] ?? ""}
                              onChange={(e) => setHours(p.objectId, id, e.target.value)}
                            />
                            <span className="cell-sub">год</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                <div className="section-title row">
                  <span>🧱 Що робили — {p.works.length}</span>
                  <button
                    className="chip"
                    onClick={() => {
                      setWorksSearch("");
                      setPeoplePickerObjectId(null);
                      setWorksPickerObjectId(worksOpen ? null : p.objectId);
                    }}
                  >
                    {worksOpen ? "▾ Готово" : "➕ Обрати роботи"}
                  </button>
                </div>

                {worksOpen && (
                  <>
                    <input className="search-box" placeholder="Пошук роботи…" value={worksSearch} onChange={(e) => setWorksSearch(e.target.value)} />
                    <div className="list">
                      {groupWorks(works.filter((w) => w.name.toLowerCase().includes(worksSearch.toLowerCase()))).map((g) => {
                        const catOpen = expandedWorkCategoryId === g.id || !!worksSearch;
                        const catSelected = g.members.filter((w) => p.works.some((pw) => pw.workId === w.id)).length;
                        return (
                          <div key={g.id}>
                            <button className="cell" onClick={() => setExpandedWorkCategoryId(catOpen ? null : g.id)}>
                              <span className="cell-title">
                                {catOpen ? "▾" : "▸"} {g.title}
                              </span>
                              <span className="badge">
                                {catSelected}/{g.members.length}
                              </span>
                            </button>
                            {catOpen && (
                              <div style={{ paddingLeft: 12 }}>
                                {/* Works with no subcategory sit straight under
                                    the category; named groups follow below. */}
                                {g.direct.map((w) => workCell(p, w))}
                                {g.subgroups.map((sg) => {
                                  const subOpen = expandedWorkSubcategoryId === sg.id || !!worksSearch;
                                  const subSelected = sg.members.filter((w) => p.works.some((pw) => pw.workId === w.id)).length;
                                  return (
                                    <div key={sg.id}>
                                      <button className="cell" onClick={() => setExpandedWorkSubcategoryId(subOpen ? null : sg.id)}>
                                        <span className="cell-title">
                                          {subOpen ? "▾" : "▸"} {sg.title}
                                        </span>
                                        <span className="badge">
                                          {subSelected}/{sg.members.length}
                                        </span>
                                      </button>
                                      {subOpen && <div style={{ paddingLeft: 12 }}>{sg.members.map((w) => workCell(p, w))}</div>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {!p.works.length ? (
                  <div className="hint" style={{ padding: "0 16px 8px" }}>Ще не обрано робіт на цьому обʼєкті.</div>
                ) : (
                  <>
                    <div className="hint" style={{ padding: "0 16px 4px" }}>Обсяг виконаного</div>
                    <div className="list">
                      {p.works.map((w) => {
                        const assigned = w.employeeIds ?? [];
                        const key = `${p.objectId}::${w.workId}`;
                        const picking = assigningWorkKey === key;
                        return (
                          <div key={w.workId} className="cell" style={{ cursor: "default", display: "block" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                              <span className="cell-title">{w.workName}</span>
                              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <input
                                  className="hours-input"
                                  inputMode="decimal"
                                  placeholder="0"
                                  value={w.volume}
                                  onChange={(e) => setVolume(p.objectId, w.workId, e.target.value)}
                                />
                                <span className="cell-sub">{w.unit || "од."}</span>
                              </span>
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <button className={`chip ${assigned.length ? "selected" : ""}`} onClick={() => setAssigningWorkKey(picking ? null : key)}>
                                {assigned.length ? `👤 ${assigned.map(employeeName).join(", ")}` : "👥 вся бригада"}
                              </button>
                            </div>
                            {picking && (
                              <div style={{ marginTop: 6 }}>
                                <div className="hint">Кому зарахувати цю роботу? Нікого не обрано — гроші ділять усі з цього обʼєкта.</div>
                                <div className="list" style={{ margin: "6px 0 0" }}>
                                  {p.employeeIds.map((id) => {
                                    const mine = assigned.includes(id);
                                    return (
                                      <button
                                        key={id}
                                        className={`cell ${mine ? "selected" : ""}`}
                                        onClick={() => toggleWorkAssignee(p.objectId, w.workId, id)}
                                      >
                                        <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                          <span className={`checkbox ${mine ? "checked" : ""}`}>{mine ? "✓" : ""}</span>
                                          {shortName(employeeName(id))}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                <div style={{ padding: "0 16px 12px", textAlign: "center" }}>
                  <button className="back-btn danger-btn" onClick={() => removeObject(p.objectId)}>
                    🗑 Прибрати «{p.objectName}»
                  </button>
                </div>
              </div>
            );
          })}

          <MainButton text="Далі → Перевірка" onClick={goToReview} disabled={!formComplete} />
        </>
      )}

      {stage === "review" && (
        <>
          <div className="step-badge">3 · ✅ ПЕРЕВІРКА</div>

          {plans.map((p) => (
            <div key={p.objectId}>
              <div className="section-title row">
                <span>📍 {p.objectName}</span>
                <span className="badge">{Math.round(objectHours(p) * 100) / 100} год</span>
              </div>
              <div className="list">
                {p.employeeIds.map((id) => {
                  const h = Number(p.hoursByEmployeeId[id]);
                  const ok = Number.isFinite(h) && h > 0;
                  return (
                    <div key={id} className="cell" style={{ cursor: "default" }}>
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`avatar-circle ${roleAccent(roleFor(id))}`}>{initials(employeeName(id))}</span>
                        {employeeName(id)}
                      </span>
                      <span className={`badge ${ok ? "ok" : "warn"}`}>{ok ? `${h} год` : "без годин"}</span>
                    </div>
                  );
                })}
                {p.works.map((w) => (
                  <div key={w.workId} className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title">🧱 {w.workName}</span>
                    <span className={`badge ${w.volume ? "ok" : "warn"}`}>{w.volume ? `${w.volume} ${w.unit || "од."}` : "без обсягу"}</span>
                  </div>
                ))}
                {!p.works.length && (
                  <div className="cell" style={{ cursor: "default" }}>
                    <span className="cell-title">🧱 Роботи</span>
                    <span className="badge warn">не додані</span>
                  </div>
                )}
              </div>
            </div>
          ))}

          <div className="section-title">Підсумок</div>
          <div className="list">
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Дата</span>
              <span className="cell-sub">{date}</span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Авто · пробіг</span>
              <span className="cell-sub">
                {cars.find((c) => c.id === carId)?.name ?? carId} · {km ?? 0} км
              </span>
            </div>
            <div className="cell" style={{ cursor: "default" }}>
              <span className="cell-title">Людей · годин</span>
              <span className="cell-sub">
                {allEmployeeIds.length} · {Math.round(totalHours * 100) / 100} год
              </span>
            </div>
            {/* Суми закриті до затвердження -- те саме правило, що й у
                живому табелі (renderFundBreakdown). Тут воно було відсутнє:
                екран заднім числом показував і доплату, і фонд, і тариф
                кожної роботи. Клас виїзду лишаємо -- це кілометри, не гроші,
                і бригадиру корисно бачити, що він порахувався. */}
            {preview && (
              <>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">Клас виїзду</span>
                  <span className="cell-sub">{preview.tripClass}</span>
                </div>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">💸 Нарахування</span>
                  <span className="cell-sub">🔒 ••• після затвердження</span>
                </div>
              </>
            )}
          </div>

          <div className="hint" style={{ padding: "0 16px 8px" }}>
            Доплату за виїзд поділять між усіма {allEmployeeIds.length} людьми з цих обʼєктів.
            Суми буде видно після затвердження адміністратором.
          </div>
          {peopleWithoutHours.length > 0 && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ⚠️ Без годин: {peopleWithoutHours.map(employeeName).join(", ")} — вони отримають лише доплату за виїзд.
            </div>
          )}
          {emptyVolumeCount > 0 && (
            <div className="hint" style={{ padding: "0 16px 8px" }}>
              ⚠️ Без обсягу: {nWorks(emptyVolumeCount)} — за них не нарахується оплата. Поверніться назад, щоб заповнити.
            </div>
          )}

          <MainButton text={saving ? "Відправлення…" : "💾 Відправити на підтвердження"} onClick={save} disabled={saving} />
        </>
      )}
    </div>
  );
}
