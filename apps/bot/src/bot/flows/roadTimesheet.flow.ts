import { TEXTS } from "../texts.js";
import type TelegramBot from "node-telegram-bot-api";
import type { FlowModule } from "../core/flowTypes.js";
import { getFlowState, setFlowState, todayISO } from "../core/helpers.js";
import { renderFlow } from "../core/renderFlow.js";
import { handleRoadStatsCallbacks } from "./roadTimesheet.stats.js";

import {
  getSettingNumber,
  fetchUsers,
} from "../../google/sheets/dictionaries.js";

import type {  Step,  SalaryPack,  RoadMember,  State,  PayrollEmpRow,  PayrollObjectPack } from "./roadTimesheet.types.js";
import { buildSalaryPacksWithRoles } from "./roadTimesheet.payroll.js";
import {
  buildSelectedCategoriesText,
  getObjectAddressGroups,
  getPeopleBrigadeGroups,
  getActiveWorks,
  getWorkCategories,
  isLocked,
  workCategoryOf,
} from "./roadTimesheet.domain.js";
import { handleRoadApprovalCallbacks } from "./roadTimesheet.approval.js";
import {
  renderOdoStartScreen,
  renderPickCarScreen,
  renderPickObjectsScreen,
  renderPickPeopleScreen,
  renderStartScreen,
  type RenderContext,
} from "./roadTimesheet.renderers.js";

import {  canStartDay,  canPause,  canResume,  canFinishDay,  canStartReturn,  canStopReturn,  canEnterOdoEnd,  canSave } from "./roadTimesheet.guards.js";

import {  ensureEmployees,  ensureObjectState,  objectName,  carName,  empName,  joinEmpNames,  findOpen,  openKey,
  fileIdFromPhoto,  now,  uniq,  fmtNum,  parseKm,  parseQty,  mdEscapeSimple,  roundToQuarterHours,  askNextMessage,  buildBulkQtyScreen,  sendLongHtml,  sendSaveScreen,
  getAdminTgIds,  pickBrigadierFromPeople,  isSenior,  buildRoadAdminTextFromEventPayload,  computeFromRts,  computeRoadSecondsFromRts,  writeEvent,  safeEditMessageText,
  hasOpenSessionForEmployeeOnObject,  startBulkQtyForObject,  buildBulkQtyItemsFromCurrentWorks,  fetchEventsSafe,  parsePayload, ensureStateReady,
  buildRoadApprovedShortText, findCarBusyByAnotherForeman, buildBusyCarsMap, buildBusyEmployeesMap,
findEmployeeBusyByAnotherForeman } from "./roadTimesheet.utils.js";

import {  appendEvents,  refreshDayChecklist,  upsertTimesheetRow,  upsertAllowanceRows,  upsertOdometerDay,  
  getEventById,  updateEventById, fetchEvents
} from "../../google/sheets/working.js";

import { getDayStatusRow } from "../../google/sheets/checklist.js";
import {  makeEventId,  nowISO,  classifyTripByKm } from "../../google/sheets/utils.js";
import { computeWorkMoneyFromRts } from "./roadTimesheet.compute.js";
import {  cb,  PREFIX,  FLOW,  DEFAULT_ROAD_ALLOWANCE_BY_CLASS } from "./roadTimesheet.cb.js";

const uiSave = (bot: TelegramBot, chatId: number, foremanTgId: number, st: State) =>
  sendSaveScreen(bot, chatId, foremanTgId, st, cb);

async function render(
  bot: TelegramBot,
  chatId: number,
  s: any,
  foremanTgId = 0,
) {

if (!foremanTgId) {
  foremanTgId = Number((s as any)?.userId ?? (s as any)?.tgId ?? chatId ?? 0);
}

const root = getFlowState<Record<number, State>>(s, FLOW) || {};
const st = root[foremanTgId] as State | undefined;

  if (st) {
    await ensureStateReady(st);
  }


    let savePreviewText = "";


if (st && (st as any)?.submittedForApproval) {
  const reviewEventId = String((st as any).adminReviewEventId ?? "").trim();
  const reviewEv = reviewEventId ? await getEventById(reviewEventId).catch(() => null) : null;
  const reviewStatus = String((reviewEv as any)?.status ?? "").toUpperCase().trim();

if (reviewStatus === "ПОВЕРНУТО") {
  (st as any).submittedForApproval = false;
  (st as any).adminReviewEventId = "";
  st.step = "RETURN_EDIT_OBJECTS" as any;

  (st as any).editReturned = true;
  (st as any).editAddedPeopleIds ??= [];
  (st as any).editRemovedPeopleIds ??= [];
  (st as any).editOriginalPeopleIds ??= uniq([
    ...((st.members ?? []).map((m: any) => String(m.employeeId)).filter(Boolean)),
    ...((st.inCarIds ?? []).map(String).filter(Boolean)),
  ]);

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
} else if (reviewStatus === "ЗАТВЕРДЖЕНО") {
  root[foremanTgId] = {
    step: "START",
    date: todayISO(),
    phase: "SETUP",
    plannedObjectIds: [],
    objects: {},
    inCarIds: [],
    members: [],
    driveActive: false,
    returnActive: false,
    qtyUnlocked: false,
  } as State;

  setFlowState(s, FLOW, root);
} else {
  return renderFlow<State>(bot, chatId, s, FLOW, () => ({
    text:
      `⏳ День вже відправлено адміну на перевірку.\n\n` +
      `Редагування тимчасово заблоковано.\n` +
      `Якщо адмін поверне день — кнопки редагування знову відкриються.`,
    kb: {
      inline_keyboard: [
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    },
  }));
}
}

  if (st?.step === "SAVE") {
    const x = st;

    const kmDay = Math.max(
      0,
      Number(x.odoEndKm ?? 0) - Number(x.odoStartKm ?? 0),
    );
    const tripClass = classifyTripByKm(kmDay);

const aggAll = await computeFromRts({
  date: x.date,
  foremanTgId,
}).catch(() => []);

const roadAgg = await computeRoadSecondsFromRts({
  date: x.date,
  foremanTgId,
}).catch(() => []);

const sinceTs = x.driveStartedAt ?? x.members?.[0]?.joinedAt;

let workMoneyRows = await computeWorkMoneyFromRts({
  date: x.date,
  foremanTgId,
  ...(sinceTs ? { sinceTs } : {}),
}).catch(() => []);

    const workTotalsByObj = new Map<
      string,
      { amount: number; qtyByUnit: Record<string, number> }
    >();

    for (const r of workMoneyRows) {
      const cur = workTotalsByObj.get(r.objectId) ?? {
        amount: 0,
        qtyByUnit: {},
      };
      cur.amount += Number(r.amount ?? 0);
      cur.qtyByUnit[r.unit] = (cur.qtyByUnit[r.unit] ?? 0) + Number(r.qty ?? 0);
      workTotalsByObj.set(r.objectId, cur);
    }

    const workGrandTotal = [...workTotalsByObj.values()].reduce(
      (a, v) => a + Number(v.amount ?? 0),
      0,
    );

    const roadTotalSec = roadAgg.reduce((a, r) => a + Number(r.sec ?? 0), 0);
    const roadSecByEmp = new Map(
      roadAgg.map((r) => [String(r.employeeId), Number(r.sec ?? 0)]),
    );

    const roadObjects = (x.plannedObjectIds ?? []).slice(0, 4);
    const roadObjCount = roadObjects.length || 0;

    const workSecByEmpObj = new Map<string, number>();
    const discByEmpObj = new Map<string, number>();
    const prodByEmpObj = new Map<string, number>();

    for (const r of aggAll) {
      const key = `${r.employeeId}||${r.objectId}`;
      workSecByEmpObj.set(key, (workSecByEmpObj.get(key) ?? 0) + Number(r.sec ?? 0));
      discByEmpObj.set(key, Number(r.disciplineCoef ?? 1.0));
      prodByEmpObj.set(key, Number(r.productivityCoef ?? 1.0));
    }

const editAddedPeopleIds = ((x as any).editAddedPeopleIds ?? []).map(String);
const editRemovedPeopleIds = new Set(
  ((x as any).editRemovedPeopleIds ?? []).map(String),
);

for (const key of [...workSecByEmpObj.keys()]) {
  const [empId] = key.split("||");

  if (editRemovedPeopleIds.has(String(empId))) {
    workSecByEmpObj.delete(key);
    discByEmpObj.delete(key);
    prodByEmpObj.delete(key);
  }
}

for (const removedEmpId of editRemovedPeopleIds) {
  roadSecByEmp.delete(String(removedEmpId));
}

for (const newEmpId of editAddedPeopleIds) {
  for (const oid of x.plannedObjectIds ?? []) {
    const secs = [...workSecByEmpObj.entries()]
      .filter(([key]) => key.endsWith(`||${oid}`))
      .map(([, sec]) => Number(sec ?? 0))
      .filter((sec) => sec > 0);

    if (!secs.length) continue;

    const avgSec = secs.reduce((a, b) => a + b, 0) / secs.length;
    const key = `${newEmpId}||${oid}`;

    workSecByEmpObj.set(key, avgSec);
    discByEmpObj.set(key, 1.0);
    prodByEmpObj.set(key, 1.0);
  }

  const roadSecs = [...roadSecByEmp.values()]
    .map((v) => Number(v ?? 0))
    .filter((v) => v > 0);

  if (roadSecs.length) {
    roadSecByEmp.set(
      newEmpId,
      roadSecs.reduce((a, b) => a + b, 0) / roadSecs.length,
    );
  }
}

if ((x as any).editReturned) {
  workMoneyRows = workMoneyRows.filter(
    (r: any) => !editRemovedPeopleIds.has(String(r.employeeId)),
  );

  const rebuiltWorkRows: any[] = [];

  for (const oid of x.plannedObjectIds ?? []) {
    const obj = ensureObjectState(x, oid);

    for (const w of obj.works ?? []) {
      const workId = String(w.workId ?? "");

      const rows = workMoneyRows.filter(
        (r: any) =>
          String(r.objectId) === String(oid) &&
          String(r.workId) === workId,
      );

      if (!rows.length) continue;

      const totalQty = rows.reduce(
        (a: number, r: any) => a + Number(r.qty ?? 0),
        0,
      );

      const totalAmount = rows.reduce(
        (a: number, r: any) => a + Number(r.amount ?? 0),
        0,
      );

      const people = uniq([
        ...rows.map((r: any) => String(r.employeeId)),
        ...editAddedPeopleIds,
      ])
        .filter(Boolean)
        .filter((id) => !editRemovedPeopleIds.has(String(id)));

      if (!people.length) continue;

      const qtyPerPerson = totalQty / people.length;
      const amountPerPerson = totalAmount / people.length;

      const sample = rows[0];

      for (const empId of people) {
        rebuiltWorkRows.push({
          ...sample,
          employeeId: empId,
          qty: Math.round(qtyPerPerson * 100) / 100,
          amount: Math.round(amountPerPerson * 100) / 100,
          sec: Number(workSecByEmpObj.get(`${empId}||${oid}`) ?? sample.sec ?? 0),
        });
      }
    }
  }

  if (rebuiltWorkRows.length) {
    workMoneyRows = rebuiltWorkRows;
  }
}


    const payrollPacks: PayrollObjectPack[] = [];

    await ensureEmployees(x);
    const nameById = new Map(
      (x.employees ?? []).map((e) => [String(e.id), String(e.name)]),
    );

    for (const oid of x.plannedObjectIds ?? []) {
      const rowsMap = new Map<string, PayrollEmpRow>();

      for (const [k, sec] of workSecByEmpObj.entries()) {
        const [empId, objId] = k.split("||");
        if (!empId || !objId || objId !== oid) continue;

        const objState = ensureObjectState(x, oid);
        const d = Number(
          objState.coefDiscipline?.[empId] ??
            discByEmpObj.get(k) ??
            1.0,
        );
        const p = Number(
          objState.coefProductivity?.[empId] ??
            prodByEmpObj.get(k) ??
            1.0,
        );

        rowsMap.set(empId, {
          employeeId: empId,
          employeeName: nameById.get(String(empId)) ?? empId,
          hours: Number(sec ?? 0) / 3600,
          disciplineCoef: d,
          productivityCoef: p,
          coefTotal: d * p,
          points: 0,
        });
      }

      if (roadObjCount > 0 && roadObjects.includes(oid)) {
        for (const [empId, secRoad] of roadSecByEmp.entries()) {
          const addHours = Number(secRoad ?? 0) / 3600 / roadObjCount;
          const key = `${empId}||${oid}`;
          const objState = ensureObjectState(x, oid);

          const d = Number(
            objState.coefDiscipline?.[empId] ??
              discByEmpObj.get(key) ??
              1.0,
          );
          const p = Number(
            objState.coefProductivity?.[empId] ??
              prodByEmpObj.get(key) ??
              1.0,
          );

          const existing = rowsMap.get(empId);
          if (existing) {
            existing.hours += addHours;
            existing.disciplineCoef = d;
            existing.productivityCoef = p;
            existing.coefTotal = d * p;
          } else {
            rowsMap.set(empId, {
              employeeId: empId,
              employeeName: nameById.get(String(empId)) ?? empId,
              hours: addHours,
              disciplineCoef: d,
              productivityCoef: p,
              coefTotal: d * p,
              points: 0,
            });
          }
        }
      }

      const rows = [...rowsMap.values()]
        .map((r) => {
          const hoursRounded = roundToQuarterHours(Number(r.hours ?? 0));
          const coefTotal =
            Number(r.disciplineCoef ?? 1.0) * Number(r.productivityCoef ?? 1.0);
          const points = Math.round(hoursRounded * coefTotal * 100) / 100;
          return {
            ...r,
            hours: hoursRounded,
            coefTotal,
            points,
          };
        })
        .filter((r) => Number(r.hours ?? 0) > 0);

      payrollPacks.push({
        objectId: oid,
        objectName: objectName(x, oid),
        rows: rows.sort((a, b) =>
          String(a.employeeName).localeCompare(String(b.employeeName)),
        ),
      });
    }

const editRemovedPeopleIdsPreview = new Set(
  ((x as any).editRemovedPeopleIds ?? []).map(String),
);

const riders = uniq([
  ...(x.members ?? []).map((m: RoadMember) => String(m.employeeId)),
  ...((x as any).editAddedPeopleIds ?? []).map(String),
  ...(x.inCarIds ?? []).map(String),
])
  .filter(Boolean)
  .filter((id) => !editRemovedPeopleIdsPreview.has(String(id)));

    const amount =
      (await getSettingNumber(`ROAD_ALLOWANCE_${tripClass}`)) ??
      DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass];

    const perPerson = riders.length ? Number(amount ?? 0) / riders.length : 0;

const brigadierEmployeeIds: string[] = [];

const oneBrigadier = await pickBrigadierFromPeople(riders);
if (oneBrigadier) {
  brigadierEmployeeIds.push(String(oneBrigadier));
}

const seniorEmployeeIds: string[] = [];

for (const empId of riders) {
  if (await isSenior(empId)) {
    seniorEmployeeIds.push(String(empId));
  }
}

const brigadierEmployeeId = brigadierEmployeeIds[0] ?? "";
const seniorEmployeeId = seniorEmployeeIds[0] ?? "";

    const carTitle = carName(x, x.carId);
    const objectsDetailed = (x.plannedObjectIds ?? []).map((oid) => ({
      objectId: oid,
      objectName: objectName(x, oid),
    }));

    const workTotalsByObject = (x.plannedObjectIds ?? []).map((oid) => {
      const rows = workMoneyRows.filter((r) => String(r.objectId) === String(oid));
      const total = rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
      return {
        objectId: oid,
        objectName: objectName(x, oid),
        total,
      };
    });

const salaryPacks: SalaryPack[] = buildSalaryPacksWithRoles({
  workTotalsByObject,
  payrollPacks,
  brigadierEmployeeIds,
  seniorEmployeeIds,
});

const workedEmployeeIdsByObject: Record<string, string[]> = {};

for (const oid of x.plannedObjectIds ?? []) {
  workedEmployeeIdsByObject[oid] = uniq(
    workMoneyRows
      .filter((r: any) => String(r.objectId) === String(oid))
      .map((r: any) => String(r.employeeId))
      .filter(Boolean),
  );
}

    const totalToPay = Number(workGrandTotal ?? 0) + Number(amount ?? 0);

    const fullPayload = {
      kmDay,
      tripClass,
      amount,
      perPerson,
      carName: carTitle,
      objectsCount: (x.plannedObjectIds ?? []).length,
      objectsDetailed,
      workTotalsByObject,
      payrollPacks,
      salaryPacks,
      roadTotalSec,
      workGrandTotal,
      totalToPay,
      workMoneyRows,
      brigadierEmployeeId,
      seniorEmployeeId,
      brigadierEmployeeIds,
      seniorEmployeeIds,
      plannedObjectIds: x.plannedObjectIds ?? [],
      workedEmployeeIdsByObject,
      odoStartKm: x.odoStartKm,
      odoEndKm: x.odoEndKm,
      carId: x.carId,
      roadAgg: roadAgg.map((r) => ({
        employeeId: r.employeeId,
        employeeName: nameById.get(String(r.employeeId)) ?? r.employeeId,
        sec: r.sec,
      })),
      riders: riders.map((id) => ({
        id,
        name: nameById.get(String(id)) ?? id,
      })),
    };

savePreviewText = buildRoadAdminTextFromEventPayload(
  {
    date: x.date,
    carId: x.carId ?? "",
    payload: JSON.stringify(fullPayload),
  },
  {
    hideMoney: false,
    showActions: false,
    title: "💾 *Готово до збереження (перевірка)*",
  },
);
  }

  const x = st;
if (!x) {
  return renderFlow<State>(bot, chatId, s, FLOW, () => ({
    text: "⚠️ Сесію не знайдено.",
    kb: {
      inline_keyboard: [
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    },
  }));
}





let busyByCarId = new Map<string, { foremanTgId: number; foremanName: string }>();

if (x?.step === "PICK_CAR") {
  const [evsForCars, usersForCars] = await Promise.all([
    fetchEvents({
      date: x.date,
      foremanTgId: "" as any,
    }).catch(() => []),
    fetchUsers().catch(() => []),
  ]);

  busyByCarId = buildBusyCarsMap({
    evs: evsForCars,
    users: usersForCars,
    selfForemanTgId: foremanTgId,
  });
}

let busyByEmployeeId = new Map<string, { foremanTgId: number; foremanName: string }>();

if (x?.step === "PICK_PEOPLE") {
  const [evsForPeople, usersForPeople] = await Promise.all([
    fetchEvents({
      date: x.date,
      foremanTgId: "" as any,
    }).catch(() => []),
    fetchUsers().catch(() => []),
  ]);

  busyByEmployeeId = buildBusyEmployeesMap({
    evs: evsForPeople,
    users: usersForPeople,
    selfForemanTgId: foremanTgId,
  });
}

return renderFlow<State>(bot, chatId, s, FLOW, () => {





    
    const date = x.date || todayISO();

    const carLine = x.carId
      ? `${TEXTS.roadFlow.labels.carOk} ${carName(x, x.carId)}`
      : TEXTS.roadFlow.labels.carNone;

    const odoStartLine =
      x.odoStartKm !== undefined || x.odoStartPhotoFileId
        ? `${TEXTS.roadFlow.labels.odoStartOk} ${fmtNum(x.odoStartKm)} км ${x.odoStartPhotoFileId ? "📷" : ""}`
        : TEXTS.roadFlow.labels.odoStartNone;

    const odoEndLine =
      x.odoEndKm !== undefined || x.odoEndPhotoFileId
        ? `${TEXTS.roadFlow.labels.odoEndOk} ${fmtNum(x.odoEndKm)} км ${x.odoEndPhotoFileId ? "📷" : ""}`
        : TEXTS.roadFlow.labels.odoEndNone;

    const plannedLine = `🏗 Обʼєкти: ${x.plannedObjectIds.length ? x.plannedObjectIds.map((id) => objectName(x, id)).join(", ") : TEXTS.ui.symbols.emptyDash}`;

    const inCarLine = `${TEXTS.roadFlow.labels.inCar} ${joinEmpNames(x, x.inCarIds)}`;
    const phaseLine =
      x.phase === "SETUP"
        ? "⚪ Підготовка"
        : x.phase === "DRIVE_DAY"
          ? "🟢 Рух"
          : x.phase === "PAUSED_AT_OBJECT"
            ? "⏸ Зупинка"
            : x.phase === "WORKING_AT_OBJECT"
              ? "🧱 Роботи на обʼєкті"
              : x.phase === "WAIT_RETURN"
                ? "🟡 Роботи завершено — повернення"
                : x.phase === "RETURN_DRIVE"
                  ? "🌙 Повернення на базу"
                  : "✅ Завершено";

    const renderCtx: RenderContext = {
      x,
      date,
      carLine,
      odoStartLine,
      odoEndLine,
      plannedLine,
      inCarLine,
      phaseLine,
      busyByCarId,
      busyByEmployeeId,
    };

    if (x.step === "BULK_QTY") {
      if (!x.pendingBulkQty) {
        return {
          text: "⚠️ Нема екрану обсягів.",
          kb: {
            inline_keyboard: [
              [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
            ],
          },
        };
      }

      const scr = buildBulkQtyScreen(x, cb);
      return {
        text: scr.text,
        kb: scr.kb,
      };
    }

    if ((x.step as any) === "RETURN_EDIT_OBJECTS") {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (const oid of x.plannedObjectIds ?? []) {
    rows.push([
      {
        text: `🏗 ${objectName(x, oid)}`.slice(0, 60),
        callback_data: `${cb.RETURN_EDIT_OBJECT_PICK}${oid}`,
      },
    ]);
  }

  rows.push([
    { text: "🚗 Змінити машину", callback_data: cb.RETURN_EDIT_CAR },
  ]);

  rows.push([
    { text: "💾 Перейти до повторної відправки", callback_data: cb.RETURN_EDIT_SAVE },
  ]);

  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `🔴 День повернено адміністратором\n\n` +
      `Обери обʼєкт, який треба виправити.\n\n` +
      `Всередині обʼєкта можна:\n` +
      `• додати / прибрати людей\n` +
      `• змінити роботи\n` +
      `• змінити обсяги\n` +
      `• потім повторно відправити адміну`,
    kb: { inline_keyboard: rows },
  };
}

if ((x.step as any) === "RETURN_EDIT_OBJECT_MENU") {
  const oid = x.activeObjectId || x.arrivedObjectId;

  if (!oid) {
    return {
      text: "⚠️ Не обрано обʼєкт.",
      kb: {
        inline_keyboard: [
          [{ text: "⬅️ До списку обʼєктів", callback_data: cb.RETURN_EDIT_OBJECTS }],
        ],
      },
    };
  }

  const obj = ensureObjectState(x, oid);

  return {
    text:
      `✏️ Редагування обʼєкта\n\n` +
      `🏗 ${mdEscapeSimple(objectName(x, oid))}\n` +
      `👥 Люди: ${mdEscapeSimple(joinEmpNames(x, obj.leftOnObjectIds ?? []))}\n` +
      `🧱 Робіт: ${(obj.works ?? []).length}\n\n` +
      `Що треба змінити?`,
    kb: {
inline_keyboard: [
  [{ text: "👥 Додати / прибрати людей", callback_data: cb.RETURN_EDIT_PEOPLE }],
  [{ text: "🧱 Змінити роботи", callback_data: cb.RETURN_EDIT_WORKS }],
  [{ text: "🧮 Змінити обсяги", callback_data: cb.RETURN_EDIT_QTY }],
  [{ text: "⚖️ Коефіцієнти", callback_data: cb.RETURN_EDIT_QTY }],
  [{ text: "⬅️ До списку обʼєктів", callback_data: cb.RETURN_EDIT_OBJECTS }],
  [{ text: "💾 Повторно відправити", callback_data: cb.RETURN_EDIT_SAVE }],
],
    },
  };
}

if ((x.step as any) === "OBJ_MONITOR_OBJECT") {
  const oid = x.arrivedObjectId;
  if (!oid) {
    return {
      text: "⚠️ Нема обраного обʼєкта.",
      kb: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: cb.OBJ_MONITOR }]] },
    };
  }

  const obj = ensureObjectState(x, oid);
  const roster = obj.leftOnObjectIds ?? [];
  const open = obj.open ?? [];

  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  if (!roster.length) {
    rows.push([{ text: "⚠️ Нема людей на обʼєкті", callback_data: cb.AT_OBJ_DROP_PICK }]);
  } else {
    for (const empId of roster.slice(0, 40)) {
      const name = empName(x, empId);
      const hasOpen = open.some((s0) => String(s0.employeeId) === String(empId));
      const mark = hasOpen ? "🟢" : "⚪";
      rows.push([
        { text: `${mark} ${name}`.slice(0, 60), callback_data: `${cb.EMP_SESSIONS}${empId}` },
      ]);
    }
  }

  if (open.length) {
    rows.push([
      { text: `⏹ Зупинити ВСІ роботи (${open.length})`, callback_data: `${cb.STOP_OBJ_WORK}${oid}` },
    ]);
  }

  rows.push([{ text: "➕ Додати роботи", callback_data: `${cb.MONITOR_ADD_WORKS}${oid}` }]);
  rows.push([{ text: "⬅️ Назад до списку обʼєктів", callback_data: cb.OBJ_MONITOR }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `🧭 Супровід обʼєкта\n\n` +
      `🏗 ${mdEscapeSimple(objectName(x, oid))}\n` +
      `👥 Люди на обʼєкті: ${mdEscapeSimple(joinEmpNames(x, roster))}\n` +
      `🟢 Активних робіт: ${open.length}\n\n` +
      `Натисни на людину — робота старт/стоп.`,
    kb: { inline_keyboard: rows },
  };
}

    if ((x.step as any) === "OBJ_MONITOR_MENU") {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (const oid of x.plannedObjectIds) {
    rows.push([{
      text: `🏗 ${objectName(x, oid)}`.slice(0, 60),
      callback_data: `${cb.OBJ_MONITOR_PICK}${oid}`,
    }]);
  }

  rows.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}run_drive` }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text: `🧭 Супровід обʼєктів\n\nОбери обʼєкт щоб керувати роботами/людьми.`,
    kb: { inline_keyboard: rows },
  };
}


    if (x.step === "START") return renderStartScreen(renderCtx);

if (x.step === "PICK_CAR") return renderPickCarScreen(renderCtx);

    if (x.step === "ODO_START") return renderOdoStartScreen(renderCtx);

    if (x.step === "PICK_PEOPLE") return renderPickPeopleScreen(renderCtx);

    if (x.step === "PICK_OBJECTS") return renderPickObjectsScreen(renderCtx);

if (x.step === "OBJECT_PLAN_MENU") {
  const rows: TelegramBot.InlineKeyboardButton[][] = x.plannedObjectIds.map((oid) => {
    const obj = ensureObjectState(x, oid);
    const mark = (obj.works ?? []).length ? "✅ " : "▫️ ";
    return [
      {
        text: `${mark}🏗 ${objectName(x, oid)}`.slice(0, 60),
        callback_data: `${cb.PLAN_OBJ}${oid}`,
      },
    ];
  });

      rows.push([
        { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
      ]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `🧱 План робіт по обʼєктах\n\n` +
          `Обери обʼєкт → додай роботи зі списку → (опц) призначення людям.`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "PLAN_WORKS_PICK") {
      const oid = x.activeObjectId!;
      const obj = ensureObjectState(x, oid);
      const worksPicked = new Set(obj.works.map((w) => w.workId));

      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      rows.push([
        { text: "➕ Додати роботи зі списку", callback_data: cb.PLAN_WORKS },
      ]);

      if (obj.works.length) {
        for (const w of obj.works.slice(0, 20)) {
          rows.push([
            {
              text: `🧱 ${w.name}`.slice(0, 60),
              callback_data: `${cb.PLAN_WORK}${w.workId}`,
            },
          ]);
        }
      } else {
        rows.push([
          {
            text: "— Немає обраних робіт —",
            callback_data: `${cb.BACK}plan_obj`,
          },
        ]);
      }

      rows.push([
        { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}plan_obj` },
      ]);
      if (canStartDay(x)) {
        rows.push([
          {
            text: TEXTS.roadFlow.buttons.startDay,
            callback_data: cb.START_DAY,
          },
        ]);
      }
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `🧱 План робіт — ${objectName(x, oid)}\n\n` +
          `Обрано робіт: ${obj.works.length}\n` +
          `Натисни “➕ Додати…” щоб відкрити довідник.`,
        kb: { inline_keyboard: rows },
      };
    }

        if (x.step === "QTY_MENU") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      if (!x.plannedObjectIds.length) {
        rows.push([{ text: "— Оʼєкти не обрано", callback_data: `${cb.BACK}start` }]);
      } else {
        for (const oid of x.plannedObjectIds) {
          rows.push([
            {
              text: `🏗 ${objectName(x, oid)}`,
              callback_data: `${cb.QTY_OBJ}${oid}`,
            },
          ]);
        }
      }

      rows.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `🧮 Обсяги робіт\n\n` +
          `Обери обʼєкт → відкрию екран введення обсягів (можна дозаповнювати пізніше).\n` +
          `⚠️ Після "ЗДАНО/ЗАТВЕРДЖЕНО" редагування буде заборонене.`,
        kb: { inline_keyboard: rows },
      };
    }
if ((x.step as any) === "BULK_COEF_DISC") {
  const p = (x as any).pendingBulkCoef;
  if (!p) {
    return {
      text: "⚠️ Нема екрану коефіцієнтів.",
      kb: {
        inline_keyboard: [
          [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
        ],
      },
    };
  }

  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (const empId of (p.employeeIds ?? []).slice(0, 40)) {
    const val = Number(p.values?.[empId] ?? 1.0);

    rows.push([{ text: `👤 ${empName(x, empId)}`, callback_data: "noop" }]);
    rows.push([
      { text: "−", callback_data: `${cb.BULK_DISC_DEC}${empId}` },
      { text: `Дисц ${val.toFixed(1)}`, callback_data: "noop" },
      { text: "+", callback_data: `${cb.BULK_DISC_INC}${empId}` },
    ]);
  }

  rows.push([{ text: "✅ Далі", callback_data: cb.BULK_COEF_DISC_SAVE }]);
  rows.push([{ text: "⬅️ Назад", callback_data: cb.BULK_COEF_BACK }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `⚖️ Коефіцієнт дисципліни\n\n` +
      `🏗 Обʼєкт: ${objectName(x, p.objectId)}\n` +
      `Крок: 0.1\n` +
      `За замовчуванням: 1.0`,
    kb: { inline_keyboard: rows },
  };
}

if ((x.step as any) === "BULK_COEF_PROD") {
  const p = (x as any).pendingBulkCoef;
  if (!p) {
    return {
      text: "⚠️ Нема екрану коефіцієнтів.",
      kb: {
        inline_keyboard: [
          [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
        ],
      },
    };
  }

  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (const empId of (p.employeeIds ?? []).slice(0, 40)) {
    const val = Number(p.values?.[empId] ?? 1.0);

    rows.push([{ text: `👤 ${empName(x, empId)}`, callback_data: "noop" }]);
    rows.push([
      { text: "−", callback_data: `${cb.BULK_PROD_DEC}${empId}` },
      { text: `Прод ${val.toFixed(1)}`, callback_data: "noop" },
      { text: "+", callback_data: `${cb.BULK_PROD_INC}${empId}` },
    ]);
  }

  rows.push([{ text: "✅ Зберегти", callback_data: cb.BULK_COEF_PROD_SAVE }]);
  rows.push([{ text: "⬅️ Назад", callback_data: cb.BULK_COEF_BACK }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `⚡ Коефіцієнт продуктивності\n\n` +
      `🏗 Обʼєкт: ${objectName(x, p.objectId)}\n` +
      `Крок: 0.1\n` +
      `За замовчуванням: 1.0`,
    kb: { inline_keyboard: rows },
  };
}
    if (x.step === "READY_TO_START") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      if (canStartDay(x))
        rows.push([
          {
            text: TEXTS.roadFlow.buttons.startDay,
            callback_data: cb.START_DAY,
          },
        ]);
      rows.push([
        { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
      ]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `✅ Готово до старту\n\n` +
          `${carLine}\n${odoStartLine}\n${plannedLine}\n\n` +
          `Якщо все ок — натисни START.`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "RUN_DRIVE") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      rows.push([
        {
          text: "👥 Зняти/додати людей (в машині)",
          callback_data: cb.MANAGE_PEOPLE,
        },
      ]);
      rows.push([
        {
          text: "🏗 Обрати/прибрати обʼєкти",
          callback_data: cb.ADD_OBJECTS,
        },
      ]);
      rows.push([{ text: "⏸ Зупинитись (прибули)", callback_data: cb.PAUSE }]);

      rows.push([
        { text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU },
      ]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `🟢 Рух (день)\n\n` +
          `📅 ${date}\n` +
          `${carLine}\n` +
          `${odoStartLine}\n` +
          `${plannedLine}\n` +
          `${inCarLine}\n\n` +
          `Тут можна:\n` +
          `• додавати/знімати людей\n` +
          `• додавати обʼєкти\n` +
          `• ⏸ зупинитись і обрати обʼєкт прибуття`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "PAUSED_PICK_OBJECT") {
const rows: TelegramBot.InlineKeyboardButton[][] = x.plannedObjectIds.map((oid) => {
  const obj = ensureObjectState(x, oid);
  const mark = (obj as any).visited ? "✅ " : "▫️ ";
  return [
    {
      text: `${mark}🏗 ${objectName(x, oid)}`.slice(0, 60),
      callback_data: `${cb.ARRIVE_OBJ}${oid}`,
    },
  ];
});
      rows.push([
        { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}run_drive` },
      ]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `⏸ Зупинка\n\n` +
          `Обери обʼєкт на який прибули`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "AT_OBJECT_MENU") {
      const oid = x.arrivedObjectId!;
      const obj = ensureObjectState(x, oid);
      const leftLine = `🏗 Лишились на обʼєкті: ${joinEmpNames(x, obj.leftOnObjectIds)}`;

      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      const unvisitedOthers = (x.plannedObjectIds ?? []).filter((id) => {
        if (String(id) === String(oid)) return false;
        const o = ensureObjectState(x, id);
        return !(o as any).visited;
      });
      const isLastObject = unvisitedOthers.length === 0;

      rows.push([
        {
          text: "👥 Зняти/залишити людей на обʼєкті",
          callback_data: cb.AT_OBJ_DROP_PICK,
        },
      ]);

      rows.push([
        {
          text: "🧱 Почати роботи на обʼєкті",
          callback_data: cb.START_WORK_ON_OBJ,
        },
      ]);

      if ((obj.works ?? []).length) {
        rows.push([
          {
            text: "🧮 Змінити обсяги",
            callback_data: `${cb.QTY_OBJ}${oid}`,
          },
        ]);
      }

      if (!isLastObject) {
        rows.push([{ text: "▶️ Продовжити рух", callback_data: cb.RESUME }]);
      }

      rows.push([
        {
          text: "⏹ STOP (останній обʼєкт) → Повернення",
          callback_data: cb.FINISH_DAY,
        },
      ]);

      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `🏗 Прибули на обʼєкт\n\n` +
          `${objectName(x, oid)}\n\n` +
          `${inCarLine}\n` +
          `${leftLine}\n\n` +
          `${isLastObject ? "Останній обʼєкт. Можна тільки завершити день і перейти до повернення." : "Що робимо?"}`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "AT_OBJECT_DROP_PICK") {
      const oid = x.arrivedObjectId!;
      const obj = ensureObjectState(x, oid);

      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      rows.push([
        {
          text: "🧹 Зняти одразу всіх (лишити на обʼєкті)",
          callback_data: cb.DROP_ALL,
        },
      ]);
const car = x.inCarIds ?? [];
const left = obj.leftOnObjectIds ?? [];

const pool = uniq([...car, ...left]).slice(0, 40);

for (const empId of pool) {
  const inCar = car.includes(empId);

  rows.push([
    {
      text: inCar
        ? `➖ Зняти — ${empName(x, empId)}`
        : `➕ Посадити — ${empName(x, empId)}`,
      callback_data: `${cb.AT_OBJ_TOGGLE}${empId}`,
    },
  ]);
}

if ((obj.leftOnObjectIds ?? []).length > 0) {
  rows.push([
    {
      text: "🚗 Посадити всіх в машину",
      callback_data: cb.PICKUP_ALL_FROM_OBJECT,
    },
  ]);
}

      rows.push([{ text: "✅ Готово", callback_data: cb.ARRIVE_CONFIRM }]);
      rows.push([
        {
  text: TEXTS.ui.buttons.back,
  callback_data: (x as any).editReturned
    ? cb.RETURN_EDIT_OBJECT_PICK + (x.activeObjectId || x.arrivedObjectId || "")
    : `${cb.BACK}at_obj`,
},
      ]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `${(x as any).editReturned ? "👥 Редагування людей на обʼєкті" : "👥 Зняти/лишити людей на обʼєкті"}\n\n` +
          `Обʼєкт: ${mdEscapeSimple(objectName(x, oid))}\n` +
          `В машині зараз: ${joinEmpNames(x, x.inCarIds)}\n\n` +
          `Натискай на людину, щоб “зняти” (вона лишиться працювати на обʼєкті).`,
        kb: { inline_keyboard: rows },
      };
    }

if (x.step === "AT_OBJECT_RUN") {
  const oid = x.arrivedObjectId!;
  const obj = ensureObjectState(x, oid);
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const roster = obj.leftOnObjectIds ?? [];

  if (!roster.length) {
    rows.push([
      {
        text: "⚠️ Нема людей на обʼєкті (спочатку зніми когось)",
        callback_data: cb.AT_OBJ_DROP_PICK,
      },
    ]);
  } else if (!obj.works.length) {
    rows.push([
      {
        text: "⚠️ Нема план-робіт (додай в плані)",
        callback_data: cb.PLAN_OBJECT_MENU_FROM_OBJRUN,
      },
    ]);
  } else {
    for (const empId of roster.slice(0, 40)) {
      const name = empName(x, empId);
      const hasOpen = hasOpenSessionForEmployeeOnObject(obj, empId);
      const mark = hasOpen ? "🟢" : "⚪";

      rows.push([
        {
          text: `${mark} ${name}`.slice(0, 60),
          callback_data: `${cb.EMP_SESSIONS}${empId}`,
        },
      ]);
    }
  }

  rows.push([
    {
      text: "⏹ Завершити роботи на обʼєкті",
      callback_data: `${cb.STOP_OBJ_WORK}${oid}`,
    },
  ]);
  rows.push([
    { text: "⬅️ Назад до обʼєкта", callback_data: `${cb.BACK}at_obj` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `🧱 Роботи на обʼєкті\n\n` +
      `Обʼєкт: ${mdEscapeSimple(objectName(x, oid))}\n` +
      `Люди на обʼєкті: ${joinEmpNames(x, roster)}\n` +
      `План-роботи: ${obj.works.length ? obj.works.map((w) => w.name).join(", ") : "—"}\n` +
      `Людей працює: ${(obj.open ?? []).length}\n\n` +
      `Натисни на людину, щоб зупинити роботу`,
    kb: { inline_keyboard: rows },
  };
}
    if (x.step === "RETURN_MENU") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      rows.push([
        {
          text: "🏗 Обрати обʼєкт для забору",
          callback_data: cb.RETURN_PICK_OBJECT,
        },
      ]);

      rows.push([
        {
          text: "👥 Зняти/додати людей (в машині)",
          callback_data: cb.MANAGE_PEOPLE,
        },
      ]);

      const hasWorksForQty = (x.plannedObjectIds ?? []).some((oid) => {
        const obj = ensureObjectState(x, oid);
        return (obj.works ?? []).length > 0;
      });

      if (hasWorksForQty) {
        rows.push([
          { text: "🧮 Змінити обсяги", callback_data: cb.QTY_MENU },
        ]);
      }

      if (canStartReturn(x)) {
        rows.push([
          { text: "🌙 START (повернення)", callback_data: cb.START_RETURN },
        ]);
      }

      if (x.phase === "RETURN_DRIVE" && x.returnActive) {
        rows.push([
          { text: "⏸ Зупинитись (прибули)", callback_data: cb.RETURN_PICK_OBJECT },
        ]);
      }

      if (canStopReturn(x)) {
        rows.push([
          { text: "⏹ STOP (приїхали на базу)", callback_data: cb.STOP_RETURN },
        ]);
      }

      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      const title =
        x.phase === "RETURN_DRIVE" && x.returnActive
          ? "🌙 Повернення на базу — в дорозі"
          : "🌙 Повернення на базу";

      return {
        text:
          `${title}\n\n` +
          `В машині: ${joinEmpNames(x, x.inCarIds)}\n\n` +
          `Якщо треба — заїжджай на обʼєкти й забирай людей.\n` +
          `Коли реально приїхали на базу — натисни STOP.`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "RETURN_PICK_OBJECT") {
const rows: TelegramBot.InlineKeyboardButton[][] = x.plannedObjectIds.map((oid) => {
  const obj = ensureObjectState(x, oid);

  const hasPeople = (obj.leftOnObjectIds ?? []).length > 0;
  const hasOpen = (obj.open ?? []).length > 0;

  const mark = hasPeople ? "👥 " : hasOpen ? "🟢 " : "▫️ ";

  return [
    {
      text: `${mark}🏗 ${objectName(x, oid)}`.slice(0, 60),
      callback_data: `${cb.RETURN_OBJ}${oid}`,
    },
  ];
});
const backStep = (x as any)._pickupBackStep as Step | undefined;
const backTag =
  backStep === "AT_OBJECT_MENU" ? "at_obj" :
  backStep === "RETURN_PICK_OBJECT" ? "return_pick_object" :
  backStep === "RETURN_MENU" ? "return_menu" :
  "return_menu";

rows.push([
  { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}${backTag}` },
]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text: `🏗 Повернення — обери обʼєкт, де треба забрати людей`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "RETURN_PICKUP_DROP") {
      const oid = x.arrivedObjectId!;
      const obj = ensureObjectState(x, oid);

      const hasAnyone = obj.leftOnObjectIds.length > 0;
      const hasOpen = (obj.open ?? []).length > 0;

      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      if (hasOpen) {
        rows.push([
          {
            text: "⏹ Завершити роботи на обʼєкті",
            callback_data: `${cb.STOP_OBJ_WORK}${oid}`,
          },
        ]);
      }

      if (hasAnyone) {
        rows.push([
          {
            text: "🧹 Забрати всіх з обʼєкта",
            callback_data: cb.RETURN_DROP_ALL,
          },
        ]);

        for (const empId of obj.leftOnObjectIds.slice(0, 40)) {
          const name = empName(x, empId);
          rows.push([
            {
              text: `➕ Забрати — ${name}`.slice(0, 60),
              callback_data: `${cb.RETURN_TOGGLE_PICKUP}${empId}`,
            },
          ]);
        }
      } else {
        rows.push([
          {
            text: "✅ Нема кого забирати — Готово",
            callback_data: `${cb.BACK}return_menu`,
          },
        ]);
      }

rows.push([
  { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}pickup_back` },
]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

      return {
        text:
          `Обʼєкт: ${mdEscapeSimple(objectName(x, oid))}\n` +
          `Люди на обʼєкті: ${mdEscapeSimple(joinEmpNames(x, obj.leftOnObjectIds))}\n` +
          `В машині: ${mdEscapeSimple(joinEmpNames(x, x.inCarIds))}\n\n` +
          `Натискай щоб забрати.`,
        kb: { inline_keyboard: rows },
      };
    }

    if (x.step === "ODO_END") {
      return {
        text:
          `🔴 Кінцевий показник спідометра\n\n` +
          `${carLine}\n` +
          `${TEXTS.ui.labels.current} ${fmtNum(x.odoEndKm)} км\n\n` +
          `1) Введи число\n2) Потім фото (або пропусти)`,
        kb: {
          inline_keyboard: [
            [
              {
                text: TEXTS.roadFlow.buttons.enterValue,
                callback_data: cb.ASK_ODO_END_KM,
              },
            ],
            ...(x.odoEndKm !== undefined
              ? [
                  [
                    {
                      text: TEXTS.roadFlow.buttons.sendPhoto,
                      callback_data: cb.ASK_ODO_END_PHOTO,
                    },
                  ],
                ]
              : []),
            ...(x.odoEndKm !== undefined
              ? [
                  [
                    {
                      text: TEXTS.roadFlow.buttons.skipPhoto,
                      callback_data: cb.SKIP_ODO_END_PHOTO,
                    },
                  ],
                ]
              : []),
            [
              {
                text: TEXTS.ui.buttons.back,
                callback_data: `${cb.BACK}return_menu`,
              },
            ],
            [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
          ],
        },
      };
    }

if (x.step === "SAVE") {
  const isReturnedEdit = Boolean((x as any).editReturned);

  return {
    text: isReturnedEdit
      ? "💾 Дані готові до повторної відправки.\n\nЯкщо ти редагував людей / обсяги / коефіцієнти — фінальний перерахунок буде зроблено при натисканні «Зберегти»."
      : savePreviewText || "⚠️ Не вдалося підготувати превʼю.",
    kb: {
      inline_keyboard: [
        [{ text: TEXTS.ui.buttons.save, callback_data: cb.SAVE }],
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    },
  };
}

    return {
      text: "…",
      kb: {
        inline_keyboard: [
          [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
        ],
      },
    };
  });
}

function applyReturnedEditPersonChange(
  st: State,
  objectIdRaw: string,
  empIdRaw: string,
  action: "ADD" | "REMOVE",
) {
  if (!(st as any).editReturned) return;

  const oid = String(objectIdRaw || "").trim();
  const empId = String(empIdRaw || "").trim();
  if (!oid || !empId) return;

  const obj = ensureObjectState(st, oid);

  (st as any).editByObject ??= {};
  (st as any).editByObject[oid] ??= {
    addedPeopleIds: [],
    removedPeopleIds: [],
  };

  const editObj = (st as any).editByObject[oid];

  if (action === "ADD") {
    editObj.removedPeopleIds = (editObj.removedPeopleIds ?? [])
      .filter((x: string) => String(x) !== empId);

    editObj.addedPeopleIds = uniq([
      ...(editObj.addedPeopleIds ?? []),
      empId,
    ]);

    obj.leftOnObjectIds = uniq([
      ...(obj.leftOnObjectIds ?? []),
      empId,
    ]);

    obj.coefDiscipline[empId] ??= 1.0;
    obj.coefProductivity[empId] ??= 1.0;

    if ((obj.works ?? []).length) {
      obj.assigned[empId] = obj.works.map((w) => String(w.workId));
    }
  }

  if (action === "REMOVE") {
    editObj.addedPeopleIds = (editObj.addedPeopleIds ?? [])
      .filter((x: string) => String(x) !== empId);

    editObj.removedPeopleIds = uniq([
      ...(editObj.removedPeopleIds ?? []),
      empId,
    ]);

    obj.leftOnObjectIds = (obj.leftOnObjectIds ?? [])
      .filter((x) => String(x) !== empId);

    obj.open = (obj.open ?? [])
      .filter((x) => String(x.employeeId) !== empId);

    delete obj.assigned[empId];
    delete obj.coefDiscipline[empId];
    delete obj.coefProductivity[empId];
  }
}


function makeEmptyRoadState(foremanTgId: number): State {
  return {
    step: "START",
    date: todayISO(),
    phase: "SETUP",
    plannedObjectIds: [],
    objects: {},
    inCarIds: [],
    members: [],
    driveActive: false,
    returnActive: false,
    qtyUnlocked: false,
    foremanName: `Бригадир ${foremanTgId}`,
  };
}

function eventTs(e: any) {
  const ms = Date.parse(String(e?.ts ?? e?.updatedAt ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function eventEmployeeIds(e: any, payload: any): string[] {
  return uniq([
    ...String(e?.employeeIds ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    ...(Array.isArray(payload?.employeeIds)
      ? payload.employeeIds.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : []),
    String(payload?.employeeId ?? "").trim(),
  ].filter(Boolean));
}

function isApprovedRoadStatus(status: any) {
  const s0 = String(status ?? "").trim().toUpperCase();
  return s0 === "ЗАТВЕРДЖЕНО" || s0 === "ПІДТВЕРДЖЕНО";
}

async function restoreRoadStateFromEvents(params: {
  foremanTgId: number;
  skipRestore?: boolean;
}) {
  const { foremanTgId, skipRestore } = params;
  const date = todayISO();

  if (skipRestore) {
    console.log("[RTS][RESTORE] skip because runtime reset flag is active", { date, foremanTgId });
    return null;
  }

  const events = await fetchEvents({ date, foremanTgId } as any).catch((e: any) => {
    console.warn("[RTS][RESTORE] fetch failed", { date, foremanTgId, error: e?.message ?? String(e) });
    return [];
  });

  const rows = [...(events ?? [])].sort((a, b) => eventTs(a) - eventTs(b));
  const approvedRoadEnds = rows.filter(
    (e: any) => String(e.type ?? "") === "ROAD_END" && isApprovedRoadStatus(e.status),
  );

  console.log("[RTS][RESTORE] scan", {
    date,
    foremanTgId,
    eventsCount: rows.length,
    approvedRoadEnds: approvedRoadEnds.length,
    lastEventId: rows[rows.length - 1]?.eventId ?? "",
    lastType: rows[rows.length - 1]?.type ?? "",
    lastStatus: rows[rows.length - 1]?.status ?? "",
  });

  if (!rows.length) {
    console.log("[RTS][RESTORE] no active day found", { date, foremanTgId });
    return null;
  }

  const st = makeEmptyRoadState(foremanTgId);

  for (const e of rows) {
    const type = String(e.type ?? "");
    const payload = parsePayload(e.payload);
    const oid = String(payload?.objectId ?? e.objectId ?? "").trim();
    const carId = String(payload?.carId ?? e.carId ?? st.carId ?? "").trim();
    const employeeIds = eventEmployeeIds(e, payload);

    if (carId) st.carId = carId;

    if (type === "RTS_SETUP_CAR") {
      st.carId = String(payload?.carId ?? e.carId ?? "").trim() || undefined;
    }

    if (type === "RTS_ODO_START") {
      const km = Number(payload?.odoStartKm ?? payload?.odoKm);
      if (Number.isFinite(km)) st.odoStartKm = km;
    }

    if (type === "RTS_ODO_START_PHOTO") {
      st.odoStartPhotoFileId = String(payload?.fileId ?? payload?.photoFileId ?? payload?.photo ?? "").trim() || st.odoStartPhotoFileId;
    }

    if (type === "RTS_PLAN_OBJECTS") {
      const planned = Array.isArray(payload?.plannedObjectIds)
        ? payload.plannedObjectIds.map((x: any) => String(x ?? "").trim()).filter(Boolean)
        : [];
      if (planned.length) {
        st.plannedObjectIds = uniq(planned);
        for (const id of st.plannedObjectIds) ensureObjectState(st, id);
      }
    }

    if (type === "RTS_PLAN_WORKS" && oid) {
      const obj = ensureObjectState(st, oid);
      if (!st.plannedObjectIds.includes(oid)) st.plannedObjectIds.push(oid);
      if (Array.isArray(payload?.works)) {
        obj.works = payload.works
          .map((w: any) => ({
            workId: String(w.workId ?? w.id ?? "").trim(),
            name: String(w.name ?? w.workName ?? w.workId ?? "").trim(),
            unit: String(w.unit ?? "од.").trim(),
            rate: Number(w.rate ?? w.tariff ?? 0),
          }))
          .filter((w: any) => w.workId);
      }
    }

    if (type === "RTS_DRIVE_START" || type === "RTS_DRIVE_RESUME") {
      st.driveActive = true;
      st.returnActive = false;
      st.phase = "DRIVE_DAY";
      st.step = "RUN_DRIVE";
      st.driveStartedAt = st.driveStartedAt ?? String(payload?.at ?? e.ts ?? "");
    }

    if (type === "RTS_DRIVE_PAUSE" || type === "RTS_ARRIVE_OBJECT") {
      st.driveActive = false;
      st.phase = "PAUSED_AT_OBJECT";
      st.step = "AT_OBJECT_MENU";
      if (oid) {
        st.arrivedObjectId = oid;
        ensureObjectState(st, oid);
      }
    }

    if (type === "RTS_DROP_OFF" && oid) {
      const obj = ensureObjectState(st, oid);
      for (const empId of employeeIds) {
        st.inCarIds = st.inCarIds.filter((id) => id !== empId);
        if (!obj.leftOnObjectIds.includes(empId)) obj.leftOnObjectIds.push(empId);
      }
      st.arrivedObjectId = oid;
      st.phase = "PAUSED_AT_OBJECT";
      st.step = "AT_OBJECT_MENU";
    }

    if (type === "RTS_PICK_UP") {
      if (oid) {
        const obj = ensureObjectState(st, oid);
        obj.leftOnObjectIds = obj.leftOnObjectIds.filter((id) => !employeeIds.includes(id));
      }
      for (const empId of employeeIds) {
        if (!st.inCarIds.includes(empId)) st.inCarIds.push(empId);
      }
    }

    if (type === "RTS_OBJ_WORK_START" && oid) {
      const obj = ensureObjectState(st, oid);
      const workId = String(payload?.workId ?? "").trim();
      for (const empId of employeeIds) {
        if (!obj.leftOnObjectIds.includes(empId)) obj.leftOnObjectIds.push(empId);
        if (workId && !obj.open.some((x) => x.employeeId === empId && x.workId === workId && x.objectId === oid)) {
          obj.open.push({
            objectId: oid,
            employeeId: empId,
            workId,
            startedAt: String(payload?.startedAt ?? e.ts ?? ""),
          });
        }
      }
      st.arrivedObjectId = oid;
      st.phase = "WORKING_AT_OBJECT";
      st.step = "AT_OBJECT_RUN";
    }

    if (type === "RTS_OBJ_WORK_STOP" && oid) {
      const obj = ensureObjectState(st, oid);
      const workId = String(payload?.workId ?? "").trim();
      obj.open = obj.open.filter((x) => {
        if (workId && x.workId !== workId) return true;
        return !employeeIds.includes(x.employeeId);
      });
      st.qtyUnlocked = true;
      st.arrivedObjectId = oid;
      if (!obj.open.length) {
        st.phase = "PAUSED_AT_OBJECT";
        st.step = "AT_OBJECT_MENU";
      }
    }

    if (type === "RTS_DAY_FINISH") {
      st.driveActive = false;
      st.phase = "WAIT_RETURN";
      st.step = "RETURN_MENU";
    }

    if (type === "RTS_RETURN_START") {
      st.returnActive = true;
      st.driveActive = false;
      st.phase = "RETURN_DRIVE";
      st.step = "RETURN_MENU";
      st.returnStartedAt = String(payload?.at ?? e.ts ?? "");
    }

    if (type === "RTS_RETURN_STOP") {
      st.returnActive = false;
      st.phase = "FINISHED";
      st.step = "ODO_END";
      st.returnStoppedAt = String(payload?.at ?? e.ts ?? "");
    }

    if (type === "RTS_ODO_END") {
      const km = Number(payload?.odoEndKm ?? payload?.odoKm);
      if (Number.isFinite(km)) st.odoEndKm = km;
      st.phase = "FINISHED";
      st.step = "SAVE";
    }

    if (type === "RTS_ODO_END_PHOTO") {
      st.odoEndPhotoFileId = String(payload?.fileId ?? payload?.photoFileId ?? payload?.photo ?? "").trim() || st.odoEndPhotoFileId;
    }

    if (type === "ROAD_END" || type === "RTS_SAVE") {
      (st as any).submittedForApproval = true;
      st.phase = "FINISHED";
      st.step = "START";
      if (isApprovedRoadStatus(e.status)) {
        (st as any).approvedRoadEventId = String(e.eventId ?? "");
      }
      if (String(e.status ?? "").trim().toUpperCase() === "ПОВЕРНУТО") {
        (st as any).editReturned = true;
      }
    }
  }

  console.log("[RTS][RESTORE] restored", {
    date,
    foremanTgId,
    step: st.step,
    phase: st.phase,
    carId: st.carId ?? "",
    plannedObjectIds: st.plannedObjectIds,
    inCarIds: st.inCarIds,
    approvedRoadEventId: (st as any).approvedRoadEventId ?? "",
    editReturned: Boolean((st as any).editReturned),
  });

  return st;
}

export const RoadTimesheetFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.roadTimesheet,
  cbPrefix: PREFIX,

start: async (bot, chatId, s) => {
  const foremanTgId = Number((s as any)?.userId ?? (s as any)?.tgId ?? chatId ?? 0);

  const root = getFlowState<Record<number, State>>(s, FLOW) || {};
  const existing = root[foremanTgId] as any;
    
    if (existing) {
      existing.date = existing.date || todayISO();
      existing.phase = existing.phase || "SETUP";
      existing.plannedObjectIds = existing.plannedObjectIds || [];
      existing.objects = existing.objects || {};
      existing.inCarIds = existing.inCarIds || [];
      existing.members = existing.members || [];
        const curStep = String((existing as any).step ?? "");
  if (curStep.startsWith("STATS_")) {
    (existing as any).step = "START";
  }
      existing.step = (existing.step ?? "START") as Step;

      s.mode = "FLOW"; 
      s.flow = FLOW;
      return render(bot, chatId, s, foremanTgId);
    }

    const skipRestore = Boolean((s as any).rtsSkipRestoreByForeman?.[foremanTgId]);
    const restored = await restoreRoadStateFromEvents({ foremanTgId, skipRestore });
    const st: State = restored ?? makeEmptyRoadState(foremanTgId);
    st.foremanName = String(
      (s as any)?.userName ??
      (s as any)?.name ??
      (s as any)?.fullName ??
      st.foremanName ??
      `Бригадир ${foremanTgId}`
    );

    console.log("[RTS][START]", {
      foremanTgId,
      restored: Boolean(restored),
      skipRestore,
      step: st.step,
      phase: st.phase,
      date: st.date,
    });

    root[foremanTgId] = st;
    setFlowState(s, FLOW, root);
    s.mode = "FLOW";
    s.flow = FLOW;
    return render(bot, chatId, s, foremanTgId);
  },

  render: async (bot, chatId, s) => render(bot, chatId, s),

  onCallback: async (bot, q, s, data) => {
    if (!data.startsWith(PREFIX)) return false;

    const chatId = q.message?.chat?.id;
    const msgId = q.message?.message_id;
    if (typeof chatId !== "number" || typeof msgId !== "number") return true;

const foremanTgId = q.from?.id ?? 0;

const root = getFlowState<Record<number, State>>(s, FLOW) || {};
const st = root[foremanTgId] as State | undefined;
s.flow = FLOW;

const renderWorkCategoryPage = async (categoryIndex: number, pageIndex: number) => {
  if (!st) return (gate("Обери обʼєкт."), true);
  const oid = st.activeObjectId;
  if (!oid) return (gate("Обери обʼєкт."), true);

  const category = String((st as any).workCategories?.[categoryIndex] ?? "").trim();
  if (!category) {
    await bot.answerCallbackQuery(q.id, {
      text: "⚠️ Категорію не знайдено",
      show_alert: true,
    });
    return true;
  }

  const obj = ensureObjectState(st, oid);
  const picked = new Set(obj.works.map((w) => String(w.workId)));

  const dict = (st.worksMeta ?? [])
    .filter((w: any) => String(w.active ?? "TRUE").toUpperCase() !== "FALSE")
    .filter((w: any) => {
      const cat = String(
        w.category ??
          w.CATEGORY ??
          w["Категорія"] ??
          w["КАТЕГОРІЯ"] ??
          w["Категория"] ??
          w["КАТЕГОРИЯ"] ??
          "Без категорії",
      ).trim();

      return cat === category;
    });

  const itemsPerPage = 10;
  const totalWorks = dict.length;
  const totalPages = Math.max(1, Math.ceil(totalWorks / itemsPerPage));
  const page = Number.isFinite(pageIndex) && pageIndex >= 0 ? pageIndex : 0;
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);

  (st as any).activeWorkCategoryIndex = categoryIndex;
  (st as any).activeWorkPage = currentPage;

  const pageStart = currentPage * itemsPerPage;
  const pageItems = dict.slice(pageStart, pageStart + itemsPerPage);

  const lines: string[] = [];
  lines.push(`📁 ${category}`);
  lines.push("");
  lines.push(`🏗 ${objectName(st, oid)}`);
  lines.push("");

  if (!pageItems.length) {
    lines.push("Нема робіт у категорії.");
    lines.push("");
  } else {
    for (let idx = 0; idx < pageItems.length; idx += 1) {
      const w = pageItems[idx];
      const number = pageStart + idx + 1;
      const on = picked.has(String(w.id));
      const mark = on ? "☑️" : "◻️";
      lines.push(`${mark} ${number}. ${String(w.name ?? w.id)}`);
      if (idx < pageItems.length - 1) lines.push("");
    }

    lines.push("");
    lines.push("⬇️ Оберіть роботи:");
  }

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (pageItems.length) {
    const buttons: TelegramBot.InlineKeyboardButton[] = pageItems.map((w, idx) => {
      const number = pageStart + idx + 1;
      const on = picked.has(String(w.id));
      return {
        text: `${on ? "☑️ " : ""}${number}`,
        callback_data: `${cb.PLAN_WORK}${String(w.id)}`,
      };
    });

    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(buttons.slice(i, i + 5));
    }
  }

  rows.push([{ text: "✅ Вибрати всі на сторінці", callback_data: cb.PLAN_WORK_PAGE_SELECT_ALL }]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (currentPage > 0) {
    navRow.push({ text: "⬅️ Назад", callback_data: `${cb.PLAN_WORK_PAGE}${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: "➡️ Далі", callback_data: `${cb.PLAN_WORK_PAGE}${currentPage + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  rows.push([{ text: "📚 До категорій", callback_data: cb.PLAN_WORKS }]);
  rows.push([{ text: "✅ Готово", callback_data: cb.PLAN_WORKS_DONE }]);
  rows.push([{ text: "🏠 Назад в меню", callback_data: `${cb.BACK}plan_obj` }]);

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  await safeEditMessageText(bot, chatId, msgId, lines.join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });

  return true;
};

if (data === cb.RESET_STATE) {
  console.log("[RTS][RESET] requested", {
    foremanTgId,
    chatId,
    hasState: Boolean(root[foremanTgId]),
  });

  await safeEditMessageText(
    bot,
    chatId,
    msgId,
    "🧹 Скидання поточного стану\n\n" +
      "Ви точно хочете скинути поточний стан робочого дня? Це очистить поточну сесію бригадира, але не видалить вже записані події з журналу.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Так, скинути", callback_data: cb.RESET_STATE_CONFIRM }],
          [{ text: "❌ Ні, назад", callback_data: cb.RESET_STATE_CANCEL }],
        ],
      },
    },
  );
  return true;
}

if (data === cb.RESET_STATE_CANCEL) {
  console.log("[RTS][RESET] cancelled", { foremanTgId, chatId });
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.RESET_STATE_CONFIRM) {
  const date = todayISO();
  const events = await fetchEvents({ date, foremanTgId } as any).catch(() => []);
  const approvedRoadEnds = (events ?? []).filter(
    (e: any) => String(e.type ?? "") === "ROAD_END" && isApprovedRoadStatus(e.status),
  );

  delete root[foremanTgId];
  setFlowState(s, FLOW, root);
  (s as any).rtsSkipRestoreByForeman ??= {};
  (s as any).rtsSkipRestoreByForeman[foremanTgId] = Date.now();

  const fresh = makeEmptyRoadState(foremanTgId);
  root[foremanTgId] = fresh;
  setFlowState(s, FLOW, root);

  console.log("[RTS][RESET] confirmed", {
    foremanTgId,
    date,
    clearedRuntimeState: true,
    eventsToday: events?.length ?? 0,
    approvedRoadEnds: approvedRoadEnds.length,
    touchedSheets: false,
  });

  await bot.answerCallbackQuery(q.id, { text: "✅ Поточну сесію очищено" }).catch(() => {});
  await render(bot, chatId, s, foremanTgId);
  return true;
}

//    const handledAdmin = await handleRoadAdminCallbacks({ bot, q, data });
//    if (handledAdmin) return true;

    const ensureStatsState = (): State => {
      const existing = root[foremanTgId];
      if (existing) return existing;

      const fresh: State = {
        step: "START",
        date: todayISO(),
        phase: "SETUP",
        plannedObjectIds: [],
        objects: {},
        inCarIds: [],
        members: [],
        driveActive: false,
        returnActive: false,
        qtyUnlocked: false,
      };

      root[foremanTgId] = fresh;
setFlowState(s, FLOW, root);
      return fresh;
    };

    const stStats = ensureStatsState();

    const handledStats = await handleRoadStatsCallbacks({
      bot,
      q,
      s,
      data,
      prefix: PREFIX,
      st: stStats,       
      chatId,
      msgId,
      foremanTgId,
    });

if (handledStats) {
  root[foremanTgId] = stStats;
  setFlowState(s, FLOW, root);

  if ((stStats as any).step === "START") {
    await render(bot, chatId, s, foremanTgId);
  }
  return true;
}

    

    const handledApproval = await handleRoadApprovalCallbacks({
      bot,
      q,
      s,
      data,
    });
    if (handledApproval) return true;

    if (!st) return true;
    await ensureStateReady(st);
    const date = st.date;


if ((st as any).submittedForApproval) {
  const reviewEventId = String((st as any).adminReviewEventId ?? "").trim();
  const reviewEv = reviewEventId ? await getEventById(reviewEventId).catch(() => null) : null;
  const reviewStatus = String((reviewEv as any)?.status ?? "").toUpperCase().trim();

if (reviewStatus === "ПОВЕРНУТО") {
  (st as any).submittedForApproval = false;
  (st as any).adminReviewEventId = "";
  st.step = "RETURN_EDIT_OBJECTS" as any;

  (st as any).editReturned = true;
  (st as any).editAddedPeopleIds ??= [];
  (st as any).editRemovedPeopleIds ??= [];
  (st as any).editOriginalPeopleIds ??= uniq([
    ...((st.members ?? []).map((m: any) => String(m.employeeId)).filter(Boolean)),
    ...((st.inCarIds ?? []).map(String).filter(Boolean)),
  ]);

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
} else if (reviewStatus === "ЗАТВЕРДЖЕНО") {
  root[foremanTgId] = {
    step: "START",
    date: todayISO(),
    phase: "SETUP",
    plannedObjectIds: [],
    objects: {},
    inCarIds: [],
    members: [],
    driveActive: false,
    returnActive: false,
    qtyUnlocked: false,
  } as State;

  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
} else {
  await bot.answerCallbackQuery(q.id, {
    text: "⏳ День вже відправлено адміну. Редагування буде доступне, якщо адмін поверне на редагування.",
    show_alert: true,
  });
  return true;
}
}

    const gate = async (text: string) => {
      await bot.answerCallbackQuery(q.id, {
        text: `⛔ ${text}`,
        show_alert: true,
      });
    };

if (data === cb.RETURN_EDIT_PEOPLE) {
  const oid = st.activeObjectId || st.arrivedObjectId;
  if (!oid) return (gate("Спочатку обери обʼєкт."), true);

  st.arrivedObjectId = oid;
  st.activeObjectId = oid;
  st.step = "AT_OBJECT_DROP_PICK";

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}


if (data === cb.RETURN_EDIT_OBJECTS) {
  st.step = "RETURN_EDIT_OBJECTS" as any;
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.RETURN_EDIT_OBJECT_PICK)) {
  const oid = data.slice(cb.RETURN_EDIT_OBJECT_PICK.length).trim();
  if (!oid) return true;

  st.activeObjectId = oid;
  st.arrivedObjectId = oid;
  ensureObjectState(st, oid);

  st.step = "RETURN_EDIT_OBJECT_MENU" as any;

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.RETURN_EDIT_CAR) {
  (st as any)._afterPickCarStep = "RETURN_EDIT_OBJECTS";
  st.step = "PICK_CAR";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.RETURN_EDIT_WORKS) {
  const oid = st.activeObjectId || st.arrivedObjectId;
  if (!oid) return (gate("Спочатку обери обʼєкт."), true);

  st.activeObjectId = oid;
  ensureObjectState(st, oid);

  st.returnAfterPlanWorksStep = "RETURN_EDIT_OBJECT_MENU" as any;
  st.returnAfterPlanWorksArrivedObjectId = oid;
  st.returnAfterPlanWorksPhase = st.phase;

  st.step = "PLAN_WORKS_PICK";

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.RETURN_EDIT_QTY) {
  const oid = st.activeObjectId || st.arrivedObjectId;
  if (!oid) return (gate("Спочатку обери обʼєкт."), true);

  return RoadTimesheetFlow.onCallback!(
    bot,
    q,
    s,
    `${cb.QTY_OBJ}${oid}`,
  );
}

if (data === cb.RETURN_EDIT_SAVE) {
  st.step = "SAVE";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}


if (data === cb.GO_DRIVE) {
  if (st.phase === "DRIVE_DAY" && st.driveActive) {
    st.step = "RUN_DRIVE";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId);
    return true;
  }

  if (st.phase === "RETURN_DRIVE" && st.returnActive) {
    st.step = "RETURN_MENU";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId);
    return true;
  }

  if (st.phase === "WAIT_RETURN") {
    st.step = "RETURN_MENU";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId); 
    return true;
  }

  if (st.phase === "PAUSED_AT_OBJECT" || st.phase === "WORKING_AT_OBJECT") {
    st.step = st.arrivedObjectId ? "AT_OBJECT_MENU" : "PAUSED_PICK_OBJECT";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId);
    return true;
  }

  await gate("Дорога зараз не активна.");
  return true;
}


if (data.startsWith(cb.MONITOR_ADD_WORKS)) {
  const oid = data.slice(cb.MONITOR_ADD_WORKS.length).trim();
  if (!oid) return true;

  st.activeObjectId = oid;
  ensureObjectState(st, oid);

  st.returnAfterPlanWorksStep = "OBJ_MONITOR_OBJECT" as any;
  st.returnAfterPlanWorksPhase = st.phase;
  st.returnAfterPlanWorksArrivedObjectId = st.arrivedObjectId ?? oid;

  st.step = "PLAN_WORKS_PICK";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}


if (data === cb.OBJ_MONITOR) {
  st.step = "QTY_MENU"; 
  st.step = "OBJ_MONITOR_MENU" as any;
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.OBJ_MONITOR_PICK)) {
  const oid = data.slice(cb.OBJ_MONITOR_PICK.length).trim();
  if (!oid) return true;

  st.arrivedObjectId = oid;

  st.step = "OBJ_MONITOR_OBJECT" as any;

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.EMP_SESSIONS)) {

  const isMonitorContext = String(st.step ?? "") === "OBJ_MONITOR_OBJECT";
  const empId = data.slice(cb.EMP_SESSIONS.length).trim();
  if (!empId) return true;

  const oid = st.arrivedObjectId;
  if (!oid) {
    await bot.answerCallbackQuery(q.id, { text: "⛔ Нема обʼєкта.", show_alert: true });
    return true;
  }

  const obj = ensureObjectState(st, oid);

  const openSessions = (obj.open ?? []).filter(
    (s0) =>
      String(s0.employeeId ?? "") === String(empId) &&
      String(s0.objectId ?? oid) === String(oid),
  );

  if (openSessions.length) {
    const endedAt = now();

    const keysToClose = new Set(openSessions.map((x) => openKey(x)));
    obj.open = (obj.open ?? []).filter((x) => !keysToClose.has(openKey(x)));

    for (const s0 of openSessions) {
      const workId = String(s0.workId ?? "").trim(); 
      const startedAt = String(s0.startedAt ?? "").trim();
      if (!workId || !startedAt) continue;

      const w = obj.works.find((x) => String(x.workId) === workId);
      const workName = String(w?.name ?? workId);
      const unit = String(w?.unit ?? "од.");
      const rate = Number(w?.rate ?? 0);

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        objectId: oid,
        type: "RTS_OBJ_WORK_STOP",
        employeeIds: [empId],
        payload: {
          employeeId: empId,
          workId,
          workName,
          unit,
          rate,
          qty: 0,
          amount: 0,
          startedAt,
          endedAt,
          reason: "STOP_BY_EMP_CLICK",
        },
      });
    }
    st.qtyUnlocked = true;
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);

    await bot.answerCallbackQuery(q.id, {
      text: `⏹ Зупинено: ${empName(st, empId)}`,
      show_alert: false,
    });



st.step = (isMonitorContext ? ("OBJ_MONITOR_OBJECT" as any) : "AT_OBJECT_RUN");
root[foremanTgId] = st;
setFlowState(s, FLOW, root);
await render(bot, chatId, s, foremanTgId);
return true;
  }

  const isOnObject = (obj.leftOnObjectIds ?? []).includes(empId);
  if (!isOnObject) {
    await bot.answerCallbackQuery(q.id, { text: "⛔ Людини нема на обʼєкті", show_alert: true });
    return true;
  }
  if (!obj.works?.length) {
    await bot.answerCallbackQuery(q.id, { text: "⛔ Нема план-робіт (додай у плані)", show_alert: true });
    return true;
  }

  const assigned = (obj.assigned?.[empId] ?? []).filter(Boolean);
  const workId = String((assigned[0] ?? obj.works[0]?.workId ?? "")).trim();

  if (!workId) {
    await bot.answerCallbackQuery(q.id, { text: "⛔ Нема роботи для старту", show_alert: true });
    return true;
  }

  const wPlan = obj.works.find((w) => String(w.workId) === String(workId));
  if (!wPlan) {
    await bot.answerCallbackQuery(q.id, { text: "⛔ Цієї роботи нема в плані", show_alert: true });
    return true;
  }

  const dictW = (st.worksMeta ?? []).find((w) => String(w.id) === String(workId));
  if (dictW) {
    if (Number(wPlan.rate ?? 0) <= 0 && Number(dictW.rate ?? 0) > 0) wPlan.rate = Number(dictW.rate);
    if (!String(wPlan.name ?? "").trim()) wPlan.name = String(dictW.name ?? workId);
    if (!String(wPlan.unit ?? "").trim()) wPlan.unit = String(dictW.unit ?? "од.");
  }

  const rate = Number(wPlan.rate ?? 0);
  if (rate <= 0) {
    await bot.answerCallbackQuery(q.id, {
      text: `⛔ Ставка = 0 (workId=${workId})`,
      show_alert: true,
    });
    return true;
  }

  const startedAt = now();

  obj.open ??= [];
  obj.open.push({ objectId: oid, employeeId: empId, workId, startedAt });

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    carId: st.carId ?? "",
    objectId: oid,
    type: "RTS_OBJ_WORK_START",
    employeeIds: [empId],
    payload: {
      employeeId: empId,
      workId,
      startedAt,
      coef: {
        employeeId: empId,
        discipline: obj.coefDiscipline?.[empId] ?? 1.0,
        productivity: obj.coefProductivity?.[empId] ?? 1.0,
      },
    },
  });

  st.phase = "WORKING_AT_OBJECT";
  st.step = "AT_OBJECT_RUN";

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);

  await bot.answerCallbackQuery(q.id, {
    text: `▶️ Запущено: ${empName(st, empId)}`,
    show_alert: false,
  });

  await render(bot, chatId, s, foremanTgId);
  return true;
}
    
          if (data.startsWith(cb.QTY_OBJ)) {
      const oid = data.slice(cb.QTY_OBJ.length).trim();
      if (!oid) return true;

      const ds = await getDayStatusRow(date, oid, foremanTgId);
      if (isLocked(ds?.status)) {
        await bot.answerCallbackQuery(q.id, {
          text: "🔒 Обʼєкт уже ЗДАНО/ЗАТВЕРДЖЕНО — обсяги редагувати не можна.",
          show_alert: true,
        });
        return true;
      }

      const evsRaw = (await fetchEventsSafe(date, foremanTgId)) ?? [];
      const evs = (evsRaw ?? []).map((e: any) => ({
        ...e,
        type: String(e.type ?? ""),
        objectId: String(e.objectId ?? ""),
        eventId: String(e.eventId ?? e.id ?? ""),
        payload: parsePayload(e.payload),
      }));

      const stopBatches = evs
        .filter((e: any) => e.type === "RTS_OBJ_WORK_STOP" && String(e.objectId) === String(oid))
        .filter((e: any) => String(e.payload?.reason ?? "") === "BULK_STOP_PENDING_QTY")
        .map((e: any) => String(e.payload?.endedAt ?? ""))
        .filter(Boolean);

      const endedAt = stopBatches.sort().pop() || now();

      const payrollEv = evs
        .filter((e: any) => e.type === "RTS_PAYROLL_INPUT" && String(e.payload?.objectId ?? e.objectId) === String(oid))
        .find((e: any) => String(e.payload?.endedAt ?? "") === String(endedAt));

      const obj = ensureObjectState(st, oid);

      let items: any[] = [];
      let employeeIds: string[] = [];
      let savedItems: any[] = [];

      if (payrollEv) {
        const p = payrollEv.payload ?? {};



const objEdit = ((st as any).editByObject ?? {})[String(oid)] ?? {};
const addedForObj = (objEdit.addedPeopleIds ?? []).map(String);
const removedForObj = new Set((objEdit.removedPeopleIds ?? []).map(String));

employeeIds = uniq([
  ...(p.employeeIds ?? []).map(String),
  ...addedForObj,
])
  .filter(Boolean)
  .filter((id) => !removedForObj.has(String(id)));

        savedItems = (p.items ?? []).map((it: any) => ({
          workId: String(it.workId ?? ""),
          workName: String(it.workName ?? it.workId ?? ""),
          unit: String(it.unit ?? "од."),
          rate: Number(it.rate ?? 0),
          qty: Number(it.qty ?? 0),
          sessionsCount: 0,
          sec: 0,
        }));
      } else {
        employeeIds = uniq([
          ...(obj.leftOnObjectIds ?? []).map(String),
          ...(st.inCarIds ?? []).map(String),
        ]).filter(Boolean);
      }

      items = buildBulkQtyItemsFromCurrentWorks({
        st,
        oid,
        savedItems,
      });

      if (!items.length) {
        await bot.answerCallbackQuery(q.id, {
          text: "⚠️ Нема робіт для цього обʼєкта (додай у план робіт).",
          show_alert: true,
        });
        return true;
      }

      st.pendingBulkQty = {
        objectId: oid,
        endedAt,
        employeeIds,
        items,
        backStep: "QTY_MENU",
        afterSaveStep: "QTY_MENU",
        payrollEventId: payrollEv?.eventId || "",
        sourceEventId: payrollEv?.eventId || "",
      };

      st.step = "BULK_QTY";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);

      const scr = buildBulkQtyScreen(st, cb);
      await safeEditMessageText(bot, chatId, msgId, scr.text, {
        parse_mode: "Markdown",
        reply_markup: scr.kb,
      });

      return true;
    }
if (data === cb.MENU) {
  (st as any)._resumeStep = st.step;

  delete st.arrivedObjectId;
  delete (st as any)._pickupBackStep;
  delete (st as any)._pickupBackPhase;
  delete (st as any)._managePeopleContext;

  st.step = "START";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.QTY_MENU) {
  const hasPlannedWorksForQty = (st.plannedObjectIds ?? []).some((oid) => {
    const obj = ensureObjectState(st, oid);
    return (obj.works ?? []).length > 0;
  });

  if (!st.qtyUnlocked && !hasPlannedWorksForQty) {
    await bot.answerCallbackQuery(q.id, {
      text: "⛔ Обсяги доступні після додавання робіт або першої зупинки роботи.",
      show_alert: true,
    });
    return true;
  }

  st.step = "QTY_MENU";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data.startsWith(cb.BULK_QTY_PICK)) {
  if (!st.pendingBulkQty) return (gate("Нема екрану обсягів."), true);

  const workId = data.slice(cb.BULK_QTY_PICK.length).trim();
  if (!workId) return true;

  (st.pendingBulkQty as any).activeWorkId = workId;

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);

  const scr = buildBulkQtyScreen(st, cb);
  await safeEditMessageText(bot, chatId, msgId, scr.text, {
    parse_mode: "Markdown",
    reply_markup: scr.kb,
  });

  return true;
}

    if (data.startsWith(cb.BULK_QTY_ADJ)) {
      const rest = data.slice(cb.BULK_QTY_ADJ.length);
      const [workId, deltaRaw] = rest.split(":");
      const delta = Number(deltaRaw);

      if (!st.pendingBulkQty) return (gate("Нема екрану обсягів."), true);

      const it = st.pendingBulkQty.items.find(
        (x) => String(x.workId) === String(workId),
      );
      if (!it || !Number.isFinite(delta)) return true;

      it.qty = Math.max(0, Math.round((it.qty + delta) * 100) / 100);
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);

      const scr = buildBulkQtyScreen(st, cb);
      await safeEditMessageText(bot, chatId, msgId, scr.text, {
        parse_mode: "Markdown",
        reply_markup: scr.kb,
      });

      return true;
    }

    if (data === cb.BULK_QTY_BACK) {
      const backTo = (st.pendingBulkQty?.backStep as Step) ?? "AT_OBJECT_MENU";
      st.step = backTo;
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.BULK_QTY_SAVE) {
      if (!st.pendingBulkQty) return (gate("Нема екрану обсягів."), true);

      const b = st.pendingBulkQty;
      const oid = b.objectId;

      const employeeIds = uniq(b.employeeIds ?? []).filter(Boolean);
      if (!employeeIds.length)
        return (gate("Нема людей для розподілу обсягів."), true);

      const payload = {
        objectId: oid,
        endedAt: b.endedAt,
        employeeIds,
        items: b.items.map((it) => ({
          workId: it.workId,
          workName: it.workName,
          unit: it.unit,
          rate: it.rate,
          qty: it.qty,
        })),
        split: "EQUAL",
      };

      const existingPayrollId = String((b as any).payrollEventId ?? "").trim();

      if (existingPayrollId) {
        // ✅ оновлюємо існуючий
        await updateEventById(existingPayrollId, {
          payload: JSON.stringify(payload),
          updatedAt: nowISO(),
        } as any);
      } else {
        // ✅ як було — створюємо новий
        const newId = await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          objectId: oid,
          type: "RTS_PAYROLL_INPUT",
          employeeIds,
          payload,
        });

        (b as any).payrollEventId = String(newId ?? "");
      }

(st as any).pendingBulkCoef = {
  objectId: oid,
  employeeIds,
  kind: "discipline",
  values: Object.fromEntries(
    employeeIds.map((empId) => [
      empId,
      Number(ensureObjectState(st, oid).coefDiscipline?.[empId] ?? 1.0),
    ]),
  ),
  backStep: "BULK_QTY",
  afterSaveStep: (b.afterSaveStep as Step) ?? "AT_OBJECT_MENU",
};

st.step = "BULK_COEF_DISC" as any;

root[foremanTgId] = st;
setFlowState(s, FLOW, root);
await bot.answerCallbackQuery(q.id, { text: "✅ Обсяги збережено" });
await render(bot, chatId, s, foremanTgId);
return true;    }

if (data.startsWith(cb.BULK_DISC_DEC) || data.startsWith(cb.BULK_DISC_INC)) {
  const p = (st as any).pendingBulkCoef;
  if (!p) return (gate("Нема екрану коефіцієнтів."), true);

  const isInc = data.startsWith(cb.BULK_DISC_INC);
  const empId = data.slice((isInc ? cb.BULK_DISC_INC : cb.BULK_DISC_DEC).length);
  if (!empId) return true;

  const cur = Number(p.values?.[empId] ?? 1.0);
  const next = Math.max(0, Math.round((cur + (isInc ? 0.1 : -0.1)) * 10) / 10);

  p.values[empId] = next;
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.BULK_PROD_DEC) || data.startsWith(cb.BULK_PROD_INC)) {
  const p = (st as any).pendingBulkCoef;
  if (!p) return (gate("Нема екрану коефіцієнтів."), true);

  const isInc = data.startsWith(cb.BULK_PROD_INC);
  const empId = data.slice((isInc ? cb.BULK_PROD_INC : cb.BULK_PROD_DEC).length);
  if (!empId) return true;

  const cur = Number(p.values?.[empId] ?? 1.0);
  const next = Math.max(0, Math.round((cur + (isInc ? 0.1 : -0.1)) * 10) / 10);

  p.values[empId] = next;
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.BULK_COEF_DISC_SAVE) {
  const p = (st as any).pendingBulkCoef;
  if (!p) return (gate("Нема екрану коефіцієнтів."), true);

  const obj = ensureObjectState(st, p.objectId);

  for (const empId of p.employeeIds ?? []) {
    obj.coefDiscipline[empId] = Number(p.values?.[empId] ?? 1.0);
  }

  (st as any).pendingBulkCoef = {
    objectId: p.objectId,
    employeeIds: p.employeeIds,
    kind: "productivity",
    values: Object.fromEntries(
      (p.employeeIds ?? []).map((empId: string) => [
        empId,
        Number(obj.coefProductivity?.[empId] ?? 1.0),
      ]),
    ),
    backStep: "BULK_COEF_DISC",
    afterSaveStep: p.afterSaveStep ?? "AT_OBJECT_MENU",
  };

  st.step = "BULK_COEF_PROD" as any;

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await bot.answerCallbackQuery(q.id, { text: "✅ Дисципліну збережено" });
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.BULK_COEF_PROD_SAVE) {
  const p = (st as any).pendingBulkCoef;
  if (!p) return (gate("Нема екрану коефіцієнтів."), true);

  const obj = ensureObjectState(st, p.objectId);

  for (const empId of p.employeeIds ?? []) {
    obj.coefProductivity[empId] = Number(p.values?.[empId] ?? 1.0);
  }

  const afterSave = (p.afterSaveStep as Step) ?? "AT_OBJECT_MENU";

  delete (st as any).pendingBulkCoef;
  delete st.pendingBulkQty;

  if (afterSave === "AT_OBJECT_MENU") {
    st.phase = "PAUSED_AT_OBJECT";
  }

  st.step = afterSave;

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await bot.answerCallbackQuery(q.id, { text: "✅ Коефіцієнти збережено" });
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.BULK_COEF_BACK) {
  if (st.step === ("BULK_COEF_DISC" as any)) {
    st.step = "BULK_QTY";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId);
    return true;
  }

  if (st.step === ("BULK_COEF_PROD" as any)) {
    const p = (st as any).pendingBulkCoef;
    if (p) {
      const obj = ensureObjectState(st, p.objectId);

      (st as any).pendingBulkCoef = {
        objectId: p.objectId,
        employeeIds: p.employeeIds,
        kind: "discipline",
        values: Object.fromEntries(
          (p.employeeIds ?? []).map((empId: string) => [
            empId,
            Number(obj.coefDiscipline?.[empId] ?? 1.0),
          ]),
        ),
        backStep: "BULK_QTY",
        afterSaveStep: p.afterSaveStep ?? "AT_OBJECT_MENU",
      };
    }

    st.step = "BULK_COEF_DISC" as any;
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);
    await render(bot, chatId, s, foremanTgId);
    return true;
  }
}

    if (data.startsWith(cb.BACK)) {
      const tag = data.slice(cb.BACK.length);

      if (tag === "start") st.step = "START";
      else if (tag === "run_drive") st.step = "RUN_DRIVE";
      else if (tag === "plan_obj") st.step = "OBJECT_PLAN_MENU";
      else if (tag === "at_obj") st.step = "AT_OBJECT_MENU";
      else if (tag === "return_menu") st.step = "RETURN_MENU";
      else if (tag === "return_pick_object") st.step = "RETURN_PICK_OBJECT";
      else if (tag === "odo_end") st.step = "ODO_END";
      else st.step = "START";

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.PICK_CAR) {
      (st as any)._afterPickCarStep = st.step;

      st.step = "PICK_CAR";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data.startsWith(cb.CAR)) {
  const carId = data.slice(cb.CAR.length);
  if (!carId) return true;

  if (st.carId === carId) {
    delete (st as any).carId;
  } else {
    const busy = await findCarBusyByAnotherForeman({
      date,
      carId,
      selfForemanTgId: foremanTgId,
    });

    if (busy) {
await bot.answerCallbackQuery(q.id); // щоб кнопка "не зависала"

const msg = await bot.sendMessage(
  chatId,
  `⛔ Це авто вже обрав ${busy.foremanName}`
);

setTimeout(() => {
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});
}, 4000);

return true;
    }

    st.carId = carId;
  }

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    carId: st.carId ?? "",
    type: "RTS_SETUP_CAR",
    payload: { carId: st.carId ?? null },
  });

  let nextStep: Step = ((st as any)._afterPickCarStep as Step) ?? "START";
  delete (st as any)._afterPickCarStep;

  if (st.carId && st.odoStartKm === undefined) {
    nextStep = "ODO_START";
  }

  st.step = nextStep;
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}





    
    if (data === cb.ODO_START) {
      if (!st.carId) {
        await gate(TEXTS.roadFlow.guards.needCar);
        return true;
      }
      st.step = "ODO_START";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.ASK_ODO_START_KM) {
      if (!st.carId) return (gate(TEXTS.roadFlow.guards.needCar), true);

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoStartNumber,
        async (msg) => {
          const raw = (msg.text ?? (msg as any)?.caption ?? "").toString();
          const km = parseKm(raw);
          if (km === undefined) {
            await bot.sendMessage(
              chatId,
              TEXTS.roadFlow.errors.notNumberExample.replace("{ex}", "12345"),
            );
            return;
          }

          st.odoStartKm = km;
          st.step = "ODO_START";

          await writeEvent({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            carId: st.carId!,
            type: "RTS_ODO_START",
            payload: { odoStartKm: km },
          });

          root[foremanTgId] = st;
setFlowState(s, FLOW, root);

          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: chatId, message_id: msgId },
            );
          } catch {
          }

          const carLine = st.carId
            ? `${TEXTS.roadFlow.labels.carOk} ${carName(st, st.carId)}`
            : TEXTS.roadFlow.labels.carNone;

          await bot.sendMessage(
            chatId,
            `🟢 Початковий показник спідометра\n\n` +
              `${carLine}\n` +
              `${TEXTS.ui.labels.current} ${fmtNum(st.odoStartKm)} км\n\n` +
              `1) Введи число\n2) Потім надішли фото`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: TEXTS.roadFlow.buttons.enterValue,
                      callback_data: cb.ASK_ODO_START_KM,
                    },
                  ],
                  ...(st.odoStartKm !== undefined
                    ? [
                        [
                          {
                            text: TEXTS.roadFlow.buttons.sendPhoto,
                            callback_data: cb.ASK_ODO_START_PHOTO,
                          },
                        ],
                      ]
                    : []),
                  ...(st.odoStartKm !== undefined
                    ? [
                        [
                          {
                            text: TEXTS.roadFlow.buttons.skipPhoto,
                            callback_data: cb.SKIP_ODO_START_PHOTO,
                          },
                        ],
                      ]
                    : []),
                  [
                    {
                      text: TEXTS.ui.buttons.back,
                      callback_data: `${cb.BACK}start`,
                    },
                  ],
                  [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
                ],
              },
            },
          );
        },
      );

      return true;
    }

    if (data === cb.ASK_ODO_START_PHOTO) {
      if (!st.carId) return (gate(TEXTS.roadFlow.guards.needCar), true);
      if (st.odoStartKm === undefined)
        return (gate(TEXTS.roadFlow.guards.needOdoStart), true);

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoStartPhoto,
        async (msg) => {
          const fileId = fileIdFromPhoto(msg);
          if (!fileId) {
            await bot.sendMessage(chatId, TEXTS.roadFlow.errors.needPhoto);
            return;
          }

          st.odoStartPhotoFileId = fileId;

          await writeEvent({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            carId: st.carId!,
            type: "RTS_ODO_START_PHOTO",
            payload: { fileId },
          });

          st.step = "START";
          root[foremanTgId] = st;
setFlowState(s, FLOW, root);

          await bot.sendMessage(chatId, "✅ Фото початкового показника спідометра прийнято 📷", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "👥 Обрати людей", callback_data: cb.PICK_PEOPLE }],
                [
                  {
                    text: TEXTS.ui.buttons.back,
                    callback_data: `${cb.BACK}start`,
                  },
                ],
                [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
              ],
            },
          });
        },
        2 * 60 * 1000,
        (m) => !!fileIdFromPhoto(m),
      );

      return true;
    }

if (data === cb.SKIP_ODO_START_PHOTO) {
  if (!st.carId) return (gate(TEXTS.roadFlow.guards.needCar), true);
  if (st.odoStartKm === undefined)
    return (gate(TEXTS.roadFlow.guards.needOdoStart), true);

  await bot.answerCallbackQuery(q.id).catch(() => {});

  st.odoStartPhotoFileId = st.odoStartPhotoFileId ?? "";
  st.step = "START";

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  await bot.sendMessage(chatId, "✅ Фото початкового показника спідометра пропущено", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "👥 Обрати людей", callback_data: cb.PICK_PEOPLE }],
        [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    },
  });

  return true;
}

    if (data === cb.PICK_PEOPLE) {
      delete (st as any).activePeopleBrigadeId;
      st.step = "PICK_PEOPLE";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

const decodePeopleBrigadeId = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

if (data.startsWith(cb.PEOPLE_GROUP_OPEN)) {
  const brigadeId = decodePeopleBrigadeId(data.slice(cb.PEOPLE_GROUP_OPEN.length));
  const groups = getPeopleBrigadeGroups(st);
  const found = groups.find((g) => g.id === brigadeId);

  if (!found) {
    await bot.answerCallbackQuery(q.id, {
      text: "⚠️ Бригаду не знайдено",
      show_alert: true,
    });
    return true;
  }

  (st as any).activePeopleBrigadeId = brigadeId;
  st.step = "PICK_PEOPLE";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.PEOPLE_GROUPS_BACK) {
  delete (st as any).activePeopleBrigadeId;
  st.step = "PICK_PEOPLE";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.PEOPLE_GROUP_SELECT_ALL)) {
  const brigadeId = decodePeopleBrigadeId(data.slice(cb.PEOPLE_GROUP_SELECT_ALL.length));
  const group = getPeopleBrigadeGroups(st).find((g) => g.id === brigadeId);
  if (!group) return (gate("Бригаду не знайдено."), true);

  const skipped: string[] = [];
  const ts = now();

  for (const e of group.employees) {
    const empId = String(e.id);
    if (!empId || st.inCarIds.includes(empId)) continue;

    const owner = await findEmployeeBusyByAnotherForeman({
      date,
      employeeId: empId,
      selfForemanTgId: foremanTgId,
    });

    if (owner) {
      skipped.push(String(e.name));
      continue;
    }

    st.inCarIds = uniq([...st.inCarIds, empId]);
    st.members.push({ employeeId: empId, joinedAt: ts });
    applyReturnedEditPersonChange(
      st,
      st.activeObjectId || st.arrivedObjectId || "",
      empId,
      "ADD",
    );

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      type: "RTS_PICK_UP",
      employeeIds: [empId],
      payload: { at: ts, phase: st.phase, from: "PICK_PEOPLE_GROUP_SELECT_ALL" },
    });
  }

  if (skipped.length) {
    await bot.answerCallbackQuery(q.id, {
      text: `Не додано зайнятих: ${skipped.length}`,
      show_alert: false,
    }).catch(() => {});
  }

  (st as any).activePeopleBrigadeId = brigadeId;
  st.step = "PICK_PEOPLE";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.PEOPLE_GROUP_CLEAR_ALL)) {
  const brigadeId = decodePeopleBrigadeId(data.slice(cb.PEOPLE_GROUP_CLEAR_ALL.length));
  const group = getPeopleBrigadeGroups(st).find((g) => g.id === brigadeId);
  if (!group) return (gate("Бригаду не знайдено."), true);

  const ts = now();

  for (const e of group.employees) {
    const empId = String(e.id);
    if (!empId || !st.inCarIds.includes(empId)) continue;

    st.inCarIds = st.inCarIds.filter((x) => x !== empId);

    const lastOpen = [...st.members]
      .reverse()
      .find((m) => m.employeeId === empId && !m.leftAt);
    if (lastOpen) lastOpen.leftAt = ts;

    applyReturnedEditPersonChange(
      st,
      st.activeObjectId || st.arrivedObjectId || "",
      empId,
      "REMOVE",
    );

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      type: "RTS_DROP_OFF",
      employeeIds: [empId],
      payload: { at: ts, phase: st.phase, from: "PICK_PEOPLE_GROUP_CLEAR_ALL" },
    });
  }

  (st as any).activePeopleBrigadeId = brigadeId;
  st.step = "PICK_PEOPLE";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.EMP_TOGGLE) || data.startsWith(cb.PEOPLE_TOGGLE)) {
  const empId = data.startsWith(cb.PEOPLE_TOGGLE)
    ? data.slice(cb.PEOPLE_TOGGLE.length)
    : data.slice(cb.EMP_TOGGLE.length);
  if (!empId) return true;

  const has = st.inCarIds.includes(empId);

if (!has) {
  const owner = await findEmployeeBusyByAnotherForeman({
    date,
    employeeId: empId,
    selfForemanTgId: foremanTgId,
  });

  if (owner) {
    await bot.answerCallbackQuery(q.id).catch(() => {});

    const msg = await bot.sendMessage(
      chatId,
      `⛔ Цю людину вже обрав ${owner.foremanName}`
    );

    setTimeout(() => {
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }, 4000);

    return true;
  }
}

  st.inCarIds = has
    ? st.inCarIds.filter((x) => x !== empId)
    : uniq([...st.inCarIds, empId]);

    applyReturnedEditPersonChange(
  st,
  st.activeObjectId || st.arrivedObjectId || "",
  empId,
  has ? "REMOVE" : "ADD",
);

      const ts = now();
      if (!has) {
        st.members.push({ employeeId: empId, joinedAt: ts });
        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          type: "RTS_PICK_UP",
          employeeIds: [empId],
          payload: { at: ts, phase: st.phase, from: "PICK_PEOPLE" },
        });
      } else {
        const lastOpen = [...st.members]
          .reverse()
          .find((m) => m.employeeId === empId && !m.leftAt);
        if (lastOpen) lastOpen.leftAt = ts;

        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          type: "RTS_DROP_OFF",
          employeeIds: [empId],
          payload: { at: ts, phase: st.phase, from: "PICK_PEOPLE" },
        });
      }

      st.step = "PICK_PEOPLE";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.PEOPLE_DONE) {
      if (!st.inCarIds?.length) {
        await bot.answerCallbackQuery(q.id, {
          text: "Спочатку вибери хоча б одного працівника",
          show_alert: true,
        });
        return true;
      }
      delete (st as any).activePeopleBrigadeId;
      st.step = "START";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.PICK_OBJECTS || data === cb.ADD_OBJECTS) {
      if (!st.carId) return (gate(TEXTS.roadFlow.guards.needCar), true);
      delete (st as any).activeObjectAddressGroupId;
      st.step = "PICK_OBJECTS";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

const decodeObjectAddressGroupId = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const getObjectGroupByShortId = (raw: string) => {
  const index = Number(raw);
  const groups = getObjectAddressGroups(st);
  return Number.isInteger(index) && index >= 0 ? groups[index] : undefined;
};

const getObjectGroupById = (raw: string) => {
  const groupId = decodeObjectAddressGroupId(raw);
  return getObjectAddressGroups(st).find((g) => g.id === groupId);
};

const getActiveObjectAddressGroup = () => {
  const groupId = String((st as any).activeObjectAddressGroupId ?? "").trim();
  if (!groupId) return undefined;
  return getObjectAddressGroups(st).find((g) => g.id === groupId);
};

if (data.startsWith(cb.OBJECT_GROUP_OPEN_SHORT) || data.startsWith(cb.OBJECT_GROUP_OPEN)) {
  const group = data.startsWith(cb.OBJECT_GROUP_OPEN_SHORT)
    ? getObjectGroupByShortId(data.slice(cb.OBJECT_GROUP_OPEN_SHORT.length))
    : getObjectGroupById(data.slice(cb.OBJECT_GROUP_OPEN.length));

  if (!group) {
    await bot.answerCallbackQuery(q.id, {
      text: "⚠️ Адресу не знайдено",
      show_alert: true,
    });
    return true;
  }

  (st as any).activeObjectAddressGroupId = group.id;
  st.step = "PICK_OBJECTS";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data === cb.OBJECT_GROUPS_BACK) {
  delete (st as any).activeObjectAddressGroupId;
  st.step = "PICK_OBJECTS";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.OBJECT_GROUP_SELECT_ALL_SHORT) || data.startsWith(cb.OBJECT_GROUP_SELECT_ALL)) {
  const group = data.startsWith(cb.OBJECT_GROUP_SELECT_ALL_SHORT)
    ? getObjectGroupByShortId(data.slice(cb.OBJECT_GROUP_SELECT_ALL_SHORT.length))
    : getObjectGroupById(data.slice(cb.OBJECT_GROUP_SELECT_ALL.length));
  if (!group) return (gate("Адресу не знайдено."), true);

  for (const o of group.objects) {
    const oid = String(o.id);
    if (!oid || st.plannedObjectIds.includes(oid)) continue;
    st.plannedObjectIds = uniq([...st.plannedObjectIds, oid]);
    ensureObjectState(st, oid);
  }

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    carId: st.carId ?? "",
    type: "RTS_PLAN_OBJECTS",
    payload: { plannedObjectIds: st.plannedObjectIds },
  });

  (st as any).activeObjectAddressGroupId = group.id;
  st.step = "PICK_OBJECTS";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.OBJECT_GROUP_CLEAR_ALL_SHORT) || data.startsWith(cb.OBJECT_GROUP_CLEAR_ALL)) {
  const group = data.startsWith(cb.OBJECT_GROUP_CLEAR_ALL_SHORT)
    ? getObjectGroupByShortId(data.slice(cb.OBJECT_GROUP_CLEAR_ALL_SHORT.length))
    : getObjectGroupById(data.slice(cb.OBJECT_GROUP_CLEAR_ALL.length));
  if (!group) return (gate("Адресу не знайдено."), true);

  const ids = new Set(group.objects.map((o) => String(o.id)));
  st.plannedObjectIds = st.plannedObjectIds.filter((oid) => !ids.has(String(oid)));

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    carId: st.carId ?? "",
    type: "RTS_PLAN_OBJECTS",
    payload: { plannedObjectIds: st.plannedObjectIds },
  });

  (st as any).activeObjectAddressGroupId = group.id;
  st.step = "PICK_OBJECTS";
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data.startsWith(cb.OBJ_TOGGLE) || data.startsWith(cb.OBJECT_TOGGLE) || data.startsWith(cb.OBJECT_TOGGLE_SHORT)) {
      const activeGroup = getActiveObjectAddressGroup();
      const shortObjectIndex = data.startsWith(cb.OBJECT_TOGGLE_SHORT)
        ? Number(data.slice(cb.OBJECT_TOGGLE_SHORT.length))
        : -1;
      const oid = data.startsWith(cb.OBJECT_TOGGLE_SHORT)
        ? String(activeGroup?.objects?.[shortObjectIndex]?.id ?? "")
        : data.startsWith(cb.OBJECT_TOGGLE)
        ? data.slice(cb.OBJECT_TOGGLE.length)
        : data.slice(cb.OBJ_TOGGLE.length);
      if (!oid) return true;

      const has = st.plannedObjectIds.includes(oid);
      st.plannedObjectIds = has
        ? st.plannedObjectIds.filter((x: string) => x !== oid)
        : [...st.plannedObjectIds, oid];
      ensureObjectState(st, oid);

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        type: "RTS_PLAN_OBJECTS",
        payload: { plannedObjectIds: st.plannedObjectIds },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.OBJECTS_DONE) {
      if (!st.plannedObjectIds?.length) {
        await bot.answerCallbackQuery(q.id, {
          text: "Спочатку вибери хоча б один обʼєкт",
          show_alert: true,
        });
        return true;
      }
      delete (st as any).activeObjectAddressGroupId;
      st.step = "START";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.PLAN_OBJECT_MENU_FROM_OBJRUN) {
      st.returnAfterPlanWorksStep = st.step; 
      st.returnAfterPlanWorksPhase = st.phase; 
      if (st.arrivedObjectId) {
        st.returnAfterPlanWorksArrivedObjectId = st.arrivedObjectId;
      } else {
        delete st.returnAfterPlanWorksArrivedObjectId;
      }
      if (!st.plannedObjectIds.length)
        return (gate("Спочатку обери обʼєкти."), true);

      st.step = "OBJECT_PLAN_MENU";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.PLAN_OBJECT_MENU) {
      if (!st.plannedObjectIds.length)
        return (gate("Спочатку обери обʼєкти."), true);
      st.step = "OBJECT_PLAN_MENU";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data.startsWith(cb.PLAN_OBJ)) {
      const oid = data.slice(cb.PLAN_OBJ.length);
      if (!oid) return true;

      st.activeObjectId = oid;
      ensureObjectState(st, oid);

      st.step = "PLAN_WORKS_PICK";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data === cb.PLAN_WORKS) {
  await bot.answerCallbackQuery(q.id, {
    text: "Відкриваю категорії...",
    show_alert: false,
  }).catch(() => {});

  const oid = st.activeObjectId;
  if (!oid) return (gate("Обери обʼєкт."), true);

  const categories = getWorkCategories(st);
  (st as any).workCategories = categories;

  const obj = ensureObjectState(st, oid);
  const picked = new Set(obj.works.map((w) => String(w.workId)));

  const rows: TelegramBot.InlineKeyboardButton[][] = categories.map((cat, index) => {
    const works = getActiveWorks(st).filter((w) => workCategoryOf(w) === cat);
    const selected = works.filter((w) => picked.has(String(w.id))).length;

    return [
      {
        text: `${selected > 0 ? "✅" : "📁"} ${cat} (${selected}/${works.length})`.slice(0, 60),
        callback_data: `${cb.PLAN_WORK_CAT}${index}`,
      },
    ];
  });

  rows.push([{ text: "✅ Готово", callback_data: cb.PLAN_WORKS_DONE }]);
  rows.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}plan_obj` }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  await safeEditMessageText(
    bot,
    chatId,
    msgId,
    `📚 Категорії робіт — ${objectName(st, oid)}\n\n` +
      `Обрано по категоріях:\n${buildSelectedCategoriesText(st, oid)}\n\n` +
      `Обери категорію:`,
    {
      reply_markup: { inline_keyboard: rows },
    },
  );

  return true;
}

if (data.startsWith(cb.PLAN_WORK_CAT)) {
  const categoryIndex = Number(data.slice(cb.PLAN_WORK_CAT.length).trim());
  return renderWorkCategoryPage(categoryIndex, 0);
}

if (data.startsWith(cb.PLAN_WORK_PAGE)) {
  const categoryIndex = Number((st as any).activeWorkCategoryIndex ?? -1);
  const pageIndex = Number(data.slice(cb.PLAN_WORK_PAGE.length).trim());

  if (!Number.isFinite(categoryIndex) || categoryIndex < 0) {
    return (gate("Обери категорію."), true);
  }

  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return true;
  }

  return renderWorkCategoryPage(categoryIndex, pageIndex);
}

if (data === cb.PLAN_WORK_PAGE_SELECT_ALL) {
  const oid = st.activeObjectId;
  if (!oid) return (gate("Обери обʼєкт."), true);

  const categoryIndex = Number((st as any).activeWorkCategoryIndex ?? -1);
  const pageIndex = Number((st as any).activeWorkPage ?? 0);

  if (!Number.isFinite(categoryIndex) || categoryIndex < 0) {
    return (gate("Обери категорію."), true);
  }

  const category = String((st as any).workCategories?.[categoryIndex] ?? "").trim();
  if (!category) {
    await bot.answerCallbackQuery(q.id, {
      text: "⚠️ Категорію не знайдено",
      show_alert: true,
    });
    return true;
  }

  const obj = ensureObjectState(st, oid);
  const currentIds = new Set(obj.works.map((w) => String(w.workId)));

  const dict = (st.worksMeta ?? [])
    .filter((w: any) => String(w.active ?? "TRUE").toUpperCase() !== "FALSE")
    .filter((w: any) => {
      const cat = String(
        w.category ??
          w.CATEGORY ??
          w["Категорія"] ??
          w["КАТЕГОРІЯ"] ??
          w["Категория"] ??
          w["КАТЕГОРИЯ"] ??
          "Без категорії",
      ).trim();

      return cat === category;
    });

  const itemsPerPage = 10;
  const pageStart = Math.max(0, pageIndex) * itemsPerPage;
  const pageItems = dict.slice(pageStart, pageStart + itemsPerPage);

  if (!pageItems.length) {
    await bot.answerCallbackQuery(q.id, {
      text: "⚠️ На сторінці немає робіт",
      show_alert: true,
    });
    return true;
  }

  const added: Array<{ workId: string; name: string; unit: string; rate: number }> = [];
  for (const w of pageItems) {
    const id = String(w.id ?? "").trim();
    if (!id || currentIds.has(id)) continue;

    currentIds.add(id);
    added.push({
      workId: id,
      name: String(w.name ?? id),
      unit: String(w.unit ?? "од."),
      rate: Number(w.rate ?? 0),
    });
  }

  if (added.length) {
    obj.works.push(...added);

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      objectId: oid,
      carId: st.carId ?? "",
      type: "RTS_PLAN_WORKS",
      payload: { objectId: oid, works: obj.works },
    });
  }

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  await bot.answerCallbackQuery(q.id, {
    text: added.length ? `✅ Додано ${added.length} робіт зі сторінки` : "✅ Всі роботи зі сторінки вже вибрані",
    show_alert: false,
  }).catch(() => {});

  return RoadTimesheetFlow.onCallback!(
    bot,
    q,
    s,
    `${cb.PLAN_WORK_PAGE}${pageIndex}`,
  );
}

if (data.startsWith(cb.PLAN_WORK_ALL_CAT)) {
  const oid = st.activeObjectId;
  if (!oid) return (gate("Обери обʼєкт."), true);

const categoryIndex = Number(data.slice(cb.PLAN_WORK_ALL_CAT.length).trim());
const category = String((st as any).workCategories?.[categoryIndex] ?? "").trim();

if (!category) {
  await bot.answerCallbackQuery(q.id, {
    text: "⚠️ Категорію не знайдено",
    show_alert: true,
  });
  return true;
}

  const obj = ensureObjectState(st, oid);

  const dict = (st.worksMeta ?? [])
    .filter((w: any) => String(w.active ?? "TRUE").toUpperCase() !== "FALSE")
    .filter((w: any) => {
      const cat = String(
        w.category ??
          w.CATEGORY ??
          w["Категорія"] ??
          w["КАТЕГОРІЯ"] ??
          w["Категория"] ??
          w["КАТЕГОРИЯ"] ??
          "Без категорії",
      ).trim();

      return cat === category;
    });

  for (const w of dict) {
    const id = String(w.id ?? "").trim();
    if (!id) continue;

    const exists = obj.works.some((x) => String(x.workId) === id);
    if (exists) continue;

    obj.works.push({
      workId: id,
      name: String(w.name ?? id),
      unit: String(w.unit ?? "од."),
      rate: Number(w.rate ?? 0),
    });
  }

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    objectId: oid,
    carId: st.carId ?? "",
    type: "RTS_PLAN_WORKS",
    payload: { objectId: oid, works: obj.works },
  });

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

return RoadTimesheetFlow.onCallback!(
  bot,
  q,
  s,
  `${cb.PLAN_WORK_CAT}${categoryIndex}`,
);
}








    if (data.startsWith(cb.PLAN_WORK)) {
      const wid = String(data.slice(cb.PLAN_WORK.length) ?? "").trim();
      const oid = st.activeObjectId;
      if (!oid || !wid) return true;

      const obj = ensureObjectState(st, oid);
      const dict = st.worksMeta ?? [];
      const found = dict.find((w) => String(w.id) === String(wid));
      const name = found?.name ?? String(wid);
      const unit = found?.unit ?? "од.";
      const rate = found?.rate ?? 0;

      const has = obj.works.some((w) => w.workId === wid);
      if (has) {
        obj.works = obj.works.filter((w) => w.workId !== wid);
        for (const empId of Object.keys(obj.assigned)) {
          obj.assigned[empId] = (obj.assigned[empId] ?? []).filter(
            (x) => x !== wid,
          );
        }
      } else {
        obj.works.push({ workId: wid, name, unit, rate });
      }

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId: oid,
        carId: st.carId ?? "",
        type: "RTS_PLAN_WORKS",
        payload: { objectId: oid, works: obj.works },
      });

root[foremanTgId] = st;
setFlowState(s, FLOW, root);

const categoryIndex = Number((st as any).activeWorkCategoryIndex ?? -1);
const pageIndex = Number((st as any).activeWorkPage ?? 0);

if (Number.isFinite(categoryIndex) && categoryIndex >= 0) {
  return RoadTimesheetFlow.onCallback!(
    bot,
    q,
    s,
    `${cb.PLAN_WORK_PAGE}${pageIndex}`,
  );
}

await render(bot, chatId, s, foremanTgId);
return true;
    }

    if (data === cb.PLAN_WORKS_DONE) {
      if (st.returnAfterPlanWorksStep) {
        const backStep = st.returnAfterPlanWorksStep;
        const backPhase = st.returnAfterPlanWorksPhase;
        const backArrived = st.returnAfterPlanWorksArrivedObjectId;

        delete st.returnAfterPlanWorksStep;
        delete st.returnAfterPlanWorksPhase;
        delete st.returnAfterPlanWorksArrivedObjectId;

        st.step = backStep;
        if (backPhase) st.phase = backPhase;
        if (backArrived) st.arrivedObjectId = backArrived;

        root[foremanTgId] = st;
setFlowState(s, FLOW, root);

        await render(bot, chatId, s, foremanTgId);
        return true;
      }

st.step = "OBJECT_PLAN_MENU"; 
root[foremanTgId] = st;
setFlowState(s, FLOW, root);
await render(bot, chatId, s, foremanTgId);
return true;
    }

    if (data === cb.START_DAY) {
      if (!canStartDay(st))
        return (gate("Не все заповнено: авто/ODO+фото/обʼєкти."), true);

        if (!st.inCarIds?.length) {
    await gate("Машина не може їхати, бо пуста (нема людей в машині).");
    return true;
  }

      st.phase = "DRIVE_DAY";
      st.driveActive = true;
      st.driveStartedAt = now();
      st.step = "RUN_DRIVE";

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId!,
        type: "RTS_DRIVE_START",
        payload: {
          startedAt: st.driveStartedAt,
          odoStartKm: st.odoStartKm,
          plannedObjectIds: st.plannedObjectIds,
        },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data === cb.MANAGE_PEOPLE) {
  const emps = st.employees ?? [];

  const isReturn =
    st.phase === "RETURN_DRIVE" ||
    st.phase === "WAIT_RETURN" ||
    String(st.step ?? "").startsWith("RETURN_") ||
    st.step === "RETURN_MENU" ||
    st.step === "RETURN_PICK_OBJECT" ||
    st.step === "RETURN_PICKUP_DROP";

  const backTag = isReturn ? "return_menu" : "run_drive";

  (st as any)._managePeopleContext = { backTag };
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);

const [evsForPeople, usersForPeople] = await Promise.all([
  fetchEvents({
    date,
    foremanTgId: "" as any,
  }).catch(() => []),
  fetchUsers().catch(() => []),
]);

const busyByEmployeeId = buildBusyEmployeesMap({
  evs: evsForPeople,
  users: usersForPeople,
  selfForemanTgId: foremanTgId,
});

const rows = emps.slice(0, 40).map((e: { id: string; name: string }) => {
  const inCar = st.inCarIds.includes(e.id);
  const owner = busyByEmployeeId.get(String(e.id));

  const label = inCar
    ? `➖ ${e.name}`
    : owner
      ? `🔒 ${e.name} — ${owner.foremanName}`
      : `➕ ${e.name}`;
    return [
      {
        text: label.slice(0, 60),
        callback_data: `${cb.TOGGLE_IN_CAR}${e.id}`,
      },
    ];
  });

  rows.push([
    { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}${backTag}` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  await safeEditMessageText(
    bot,
    chatId,
    msgId,
    `👥 Люди (в машині)\n\nЗараз: ${joinEmpNames(st, st.inCarIds)}\n\nНатискай щоб додати/зняти:`,
    {
      reply_markup: { inline_keyboard: rows },
    },
  );

  return true;
}

if (data.startsWith(cb.TOGGLE_IN_CAR)) {
  const empId = data.slice(cb.TOGGLE_IN_CAR.length);
  if (!empId) return true;

  const inCar = st.inCarIds.includes(empId);

if (!inCar) {
  const owner = await findEmployeeBusyByAnotherForeman({
    date,
    employeeId: empId,
    selfForemanTgId: foremanTgId,
  });

  if (owner) {
    await bot.answerCallbackQuery(q.id).catch(() => {});

    const msg = await bot.sendMessage(
      chatId,
      `⛔ Цю людину вже обрав ${owner.foremanName}`
    );

    setTimeout(() => {
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }, 4000);

    return true;
  }

    st.inCarIds.push(empId);
        st.inCarIds = uniq(st.inCarIds);

        const ts = now();
        st.members.push({ employeeId: empId, joinedAt: ts });

        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          objectId: st.arrivedObjectId ?? "",
          type: "RTS_PICK_UP",
          employeeIds: [empId],
          payload: { at: ts, phase: st.phase },
        });
      } else {
        st.inCarIds = st.inCarIds.filter((x) => x !== empId);

        const ts = now();
        const lastOpen = [...st.members]
          .reverse()
          .find((m) => m.employeeId === empId && !m.leftAt);
        if (lastOpen) lastOpen.leftAt = ts;

        if (st.arrivedObjectId) {
          const obj = ensureObjectState(st, st.arrivedObjectId);
          if (!obj.leftOnObjectIds.includes(empId))
            obj.leftOnObjectIds.push(empId);
          obj.coefDiscipline[empId] ??= 1.0;
          obj.coefProductivity[empId] ??= 1.0;
          obj.assigned[empId] ??= [];
        }

        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          objectId: st.arrivedObjectId ?? "",
          type: "RTS_DROP_OFF",
          employeeIds: [empId],
          payload: {
            at: ts,
            phase: st.phase,
            arrivedObjectId: st.arrivedObjectId ?? null,
          },
        });
      }
applyReturnedEditPersonChange(
  st,
  st.activeObjectId || st.arrivedObjectId || "",
  empId,
  inCar ? "REMOVE" : "ADD",
);
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);

      const ctx = (st as any)._managePeopleContext;
      if (ctx?.backTag) {
        return RoadTimesheetFlow.onCallback!(bot, q, s, cb.MANAGE_PEOPLE);
      }

      if (st.step === "AT_OBJECT_DROP_PICK") {
        await render(bot, chatId, s, foremanTgId);
        return true;
      }

      if (q.message) {
        st.step =
          st.phase === "DRIVE_DAY" ? "RUN_DRIVE" : (st.step ?? "RUN_DRIVE");
        root[foremanTgId] = st;
setFlowState(s, FLOW, root);
        await render(bot, chatId, s, foremanTgId);
        return true;
      }

      return true;
    }

    if (data === cb.PAUSE) {
      if (!canPause(st))
        return (gate("Зупинка доступна тільки під час активного руху."), true);

      st.driveActive = false;
      st.driveStoppedAt = now();
      st.phase = "PAUSED_AT_OBJECT";
      st.step = "PAUSED_PICK_OBJECT";

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        type: "RTS_DRIVE_PAUSE",
        payload: { at: st.driveStoppedAt },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data.startsWith(cb.ARRIVE_OBJ)) {
      const oid = data.slice(cb.ARRIVE_OBJ.length);
      if (!oid) return true;
      if (!st.plannedObjectIds.includes(oid))
        return (gate("Обʼєкт не у плані."), true);

      st.arrivedObjectId = oid;
      ensureObjectState(st, oid);

      const obj = ensureObjectState(st, oid);
      (obj as any).visited = true; 

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        objectId: oid,
        type: "RTS_ARRIVE_OBJECT",
        payload: { objectId: oid, at: now() },
      });

      st.step = "AT_OBJECT_MENU";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data.startsWith(cb.AT_OBJ_TOGGLE)) {
  const empId = data.slice(cb.AT_OBJ_TOGGLE.length);
  const oid = st.arrivedObjectId;
  if (!empId || !oid) return true;

  const obj = ensureObjectState(st, oid);

  const inCar = st.inCarIds.includes(empId);

  if (!inCar) {
  if (obj.open?.length) {
    await bot.answerCallbackQuery(q.id, {
      text: `⛔ Є ${obj.open.length} активних робіт на обʼєкті.\nСпочатку завершіть роботи.`,
      show_alert: true,
    });
    return true;
  }

    obj.leftOnObjectIds =
      (obj.leftOnObjectIds ?? []).filter(x => x !== empId);

    st.inCarIds = uniq([...st.inCarIds, empId]);

    await writeEvent({
      bot, chatId, msgId, date,
      foremanTgId,
      carId: st.carId!,
      objectId: oid,
      type: "RTS_PICK_UP",
      employeeIds: [empId],
      payload: { phase: st.phase },
    });

  } else {

    st.inCarIds = st.inCarIds.filter(x => x !== empId);

    obj.leftOnObjectIds = uniq([
      ...(obj.leftOnObjectIds ?? []),
      empId,
    ]);

    await writeEvent({
      bot, chatId, msgId, date,
      foremanTgId,
      carId: st.carId!,
      objectId: oid,
      type: "RTS_DROP_OFF",
      employeeIds: [empId],
      payload: { phase: st.phase },
    });
  }

  applyReturnedEditPersonChange(
  st,
  oid,
  empId,
  inCar ? "ADD" : "REMOVE",
);

  st.step = "AT_OBJECT_DROP_PICK";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;



}


    if (data === cb.AT_OBJ_DROP_PICK) {
      if (!st.arrivedObjectId)
        return (gate("Спочатку обери обʼєкт прибуття."), true);
      st.step = "AT_OBJECT_DROP_PICK";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data === cb.PICKUP_ALL_FROM_OBJECT) {
  const oid = st.arrivedObjectId;
  if (!oid) return (gate("Нема обʼєкта."), true);

  const obj = ensureObjectState(st, oid);

  if (obj.open?.length) {
    await bot.answerCallbackQuery(q.id, {
      text: "⛔ Є незавершені роботи на обʼєкті.\nСпочатку завершіть роботи.",
      show_alert: true,
    });
    return true;
  }

  const picked = [...(obj.leftOnObjectIds ?? [])];

  if (!picked.length) {
    await bot.answerCallbackQuery(q.id, {
      text: "ℹ️ На обʼєкті нікого нема",
      show_alert: false,
    });
    return true;
  }

  const ts = now();

  for (const empId of picked) {
    if (!st.inCarIds.includes(empId)) st.inCarIds.push(empId);

    st.members.push({
      employeeId: empId,
      joinedAt: ts,
    });

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      objectId: oid,
      type: "RTS_PICK_UP",
      employeeIds: [empId],
      payload: {
        at: ts,
        phase: st.phase,
        from: "PICKUP_ALL_FROM_OBJECT",
      },
    });
  }

  obj.leftOnObjectIds = [];

  st.step = "AT_OBJECT_DROP_PICK";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data === cb.DROP_ALL) {
      if (!st.arrivedObjectId) return (gate("Нема обʼєкта."), true);
      const oid = st.arrivedObjectId;
      const obj = ensureObjectState(st, oid);

      const dropped = [...st.inCarIds];
      for (const empId of dropped) {
        if (!obj.leftOnObjectIds.includes(empId))
          obj.leftOnObjectIds.push(empId);
        obj.coefDiscipline[empId] ??= 1.0;
        obj.coefProductivity[empId] ??= 1.0;
        obj.assigned[empId] ??= [];
      }
      st.inCarIds = [];

      const ts = now();
      for (const empId of dropped) {
        const lastOpen = [...st.members]
          .reverse()
          .find((m) => m.employeeId === empId && !m.leftAt);
        if (lastOpen) lastOpen.leftAt = ts;
      }

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        objectId: oid,
        type: "RTS_DROP_OFF",
        employeeIds: dropped,
        payload: { at: ts, dropAll: true },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.ARRIVE_CONFIRM) {
      st.step = "AT_OBJECT_MENU";
      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.START_WORK_ON_OBJ || data === cb.GO_OBJ_RUN) {
      if (!st.arrivedObjectId) return (gate("Нема обʼєкта."), true);

      const oid = st.arrivedObjectId;
      const obj = ensureObjectState(st, oid);
      const roster = (obj.leftOnObjectIds ?? []).slice();

      if (!roster.length) {
        await gate("Нема людей на обʼєкті. Спочатку зніми людей з машини.");
        return true;
      }

      if (!obj.works?.length) {
        await gate("Нема план-робіт для обʼєкта. Додай план робіт.");
        return true;
      }

      const startedAt = now();

      for (const empId of roster) {
        const assigned = (obj.assigned?.[empId] ?? []).filter(Boolean);

        const workId =
          (assigned.length ? assigned[0] : "") || obj.works[0]?.workId;

        if (!workId) continue;
        if (findOpen(obj, empId, workId)) continue;

        const wPlan = obj.works.find(
          (w) => String(w.workId) === String(workId),
        );
        const dictW = (st.worksMeta ?? []).find(
          (w) => String(w.id) === String(workId),
        );

        if (wPlan && dictW) {
          if (Number(wPlan.rate ?? 0) <= 0 && Number(dictW.rate ?? 0) > 0)
            wPlan.rate = dictW.rate;
          if (!wPlan.name) wPlan.name = dictW.name;
          if (!wPlan.unit) wPlan.unit = dictW.unit;
        }

        const rate = Number(wPlan?.rate ?? dictW?.rate ?? 0);
        if (rate <= 0) continue;

        obj.open.push({ objectId: oid, employeeId: empId, workId, startedAt });

        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          objectId: oid,
          type: "RTS_OBJ_WORK_START",
          employeeIds: [empId],
          payload: {
            employeeId: empId,
            workId,
            startedAt,
            coef: {
              employeeId: empId,
              discipline: obj.coefDiscipline?.[empId] ?? 1.0,
              productivity: obj.coefProductivity?.[empId] ?? 1.0,
            },
          },
        });
      }

      if (obj.phase !== "RUN") {
        obj.phase = "RUN";
        obj.startedAt = now();
      }

      st.phase = "WORKING_AT_OBJECT";
      st.step = "AT_OBJECT_RUN";

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data.startsWith(cb.START_WORK)) {
      if (!st.arrivedObjectId) {
        return (gate("Нема обʼєкта."), true);
      }

      const oid = st.arrivedObjectId;
      const obj = ensureObjectState(st, oid);
      const rest = String(data.slice(cb.START_WORK.length) ?? "");
      const [employeeIdRaw, workIdRaw] = rest.split("||");
      const employeeId = String(employeeIdRaw ?? "").trim();
      const workId = String(workIdRaw ?? "").trim();

      if (!employeeId || !workId) {
        return true;
      }

      const workIdN = String(workId).trim();
      const wPlan = obj.works.find(
        (w) => String(w.workId ?? "").trim() === workIdN,
      );

      if (!wPlan) {
        return (gate("Цієї роботи немає в плані обʼєкта."), true);
      }

      const dictFound = (st.worksMeta ?? []).find(
        (w) => String(w.id ?? "").trim() === workIdN,
      );
      const dictRate = Number(dictFound?.rate ?? 0);
      const planRate = Number(wPlan.rate ?? 0);
      const effectiveRate = planRate > 0 ? planRate : dictRate;

      if (dictFound && effectiveRate > 0) {
        const before = { rate: wPlan.rate, name: wPlan.name, unit: wPlan.unit };

        wPlan.rate = effectiveRate;
        wPlan.name = String(wPlan.name ?? "").trim()
          ? wPlan.name
          : dictFound.name;
        wPlan.unit = String(wPlan.unit ?? "").trim()
          ? wPlan.unit
          : dictFound.unit;
      }

      if (effectiveRate <= 0) {
        return (
          gate(
            `Для цієї роботи ставка = 0. Перевір лист РОБОТИ (workId=${workIdN}).`,
          ),
          true
        );
      }

      const isOnObject = (obj.leftOnObjectIds ?? []).includes(employeeId);
      if (!isOnObject) {
        return (gate("Цієї людини немає на обʼєкті."), true);
      }

      const assignedRaw = obj.assigned[employeeId];
      const assigned =
        assignedRaw && assignedRaw.length
          ? assignedRaw
          : obj.works.map((w) => w.workId);

      const isAssignedOk = assigned.includes(workIdN);

      if (!isAssignedOk) {
        return (gate("Спочатку признач цю роботу людині."), true);
      }

      const alreadyOpen = !!findOpen(obj, employeeId, workIdN);
      if (alreadyOpen) {
        return (gate("Вже запущено."), true);
      }

      const startedAt = now();
      obj.open.push({ objectId: oid, employeeId, workId: workIdN, startedAt });

      const evId = await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        objectId: oid,
        type: "RTS_OBJ_WORK_START",
        employeeIds: [employeeId],
        payload: {
          employeeId,
          workId: workIdN,
          startedAt,
          coef: {
            employeeId,
            discipline: obj.coefDiscipline[employeeId] ?? 1.0,
            productivity: obj.coefProductivity[employeeId] ?? 1.0,
          },
        },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data.startsWith(cb.STOP_WORK)) {
      if (!st.arrivedObjectId) return (gate("Нема обʼєкта."), true);
      const oid = st.arrivedObjectId;
      const obj = ensureObjectState(st, oid);

      const rest = data.slice(cb.STOP_WORK.length);
      const [employeeIdRaw, workIdRaw] = rest.split("||");
      const employeeId = String(employeeIdRaw ?? "").trim();
      const workId = String(workIdRaw ?? "").trim();
      if (!employeeId || !workId) return true;

      const opened = findOpen(obj, employeeId, workId);
      if (!opened) return (gate("Сесія не запущена."), true);

      const w = obj.works.find((x) => x.workId === workId);
      const workName = w?.name ?? workId;
      const unit = w?.unit ?? "од.";
      const rate = w?.rate ?? 0;

      st.pendingQty = {
        objectId: oid,
        employeeId,
        workId,
        workName,
        unit,
        rate,
        startedAt: opened.startedAt,
      };

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        `✍️ Введи обсяг (qty) для роботи:\n\n🧱 ${workName}\n🏗 Обʼєкт: ${objectName(st, oid)}\n👤 Працівник: ${empName(st, employeeId)}\n📏 Одиниця: ${unit}\n\nПриклад: 12 або 12.5`,
        async (msg) => {
          const raw = (msg.text ?? (msg as any)?.caption ?? "").toString();
          const qty = parseQty(raw);
          if (qty === undefined) {
            await bot.sendMessage(
              chatId,
              "⚠️ Не схоже на число. Приклад: 12 або 12.5",
            );
            return;
          }

          const st2 = root[foremanTgId] as State;
          const pending = st2.pendingQty;
          if (!pending) {
            await bot.sendMessage(
              chatId,
              "⚠️ Нема запиту на обсяг (pending). Спробуй ще раз.",
            );
            return;
          }

          const obj2 = ensureObjectState(st2, pending.objectId);
          const opened2 = findOpen(obj2, pending.employeeId, pending.workId);
          if (!opened2) {
            delete st2.pendingQty;
            root[foremanTgId] = st2;
setFlowState(s, FLOW, root);
            await bot.sendMessage(chatId, "⚠️ Сесія вже закрита.");
            await render(bot, chatId, s, foremanTgId);
            return;
          }

          obj2.open = obj2.open.filter((x) => openKey(x) !== openKey(opened2));
          const endedAt = now();

          const amount = Math.round(qty * (pending.rate ?? 0) * 100) / 100;

          await writeEvent({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            carId: st2.carId ?? "",
            objectId: pending.objectId,
            type: "RTS_OBJ_WORK_STOP",
            employeeIds: [pending.employeeId],
            payload: {
              employeeId: pending.employeeId,
              workId: pending.workId,
              workName: pending.workName,
              unit: pending.unit,
              rate: pending.rate,
              qty,
              amount,
              startedAt: pending.startedAt,
              endedAt,
            },
          });

          delete st2.pendingQty;
          root[foremanTgId] = st2;
setFlowState(s, FLOW, root);
          await render(bot, chatId, s, foremanTgId);
        },
        5 * 60 * 1000,
      );

      return true;
    }

if (data.startsWith(cb.STOP_OBJ_WORK)) {
  const oid = data.slice(cb.STOP_OBJ_WORK.length).trim();
  if (!oid) return (gate("Нема обʼєкта."), true);

  const obj = ensureObjectState(st, oid);

  const openSessions = (obj.open ?? []).filter(
    (s0) => String(s0.objectId ?? oid) === String(oid),
  );

  const isReturnContext = st.step === "RETURN_PICKUP_DROP";

  if (!openSessions.length) {
    await startBulkQtyForObject({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      s,
      callbackQueryId: q.id,
      st,
      oid,
      isReturnContext,
    });
    return true;
  }

  const endedAt = now();

  for (const s0 of openSessions) {
    const employeeId = String(s0.employeeId ?? "").trim();
    const workId = String(s0.workId ?? "").trim();
    const startedAt = String(s0.startedAt ?? "").trim();
    if (!employeeId || !workId || !startedAt) continue;

    const w = obj.works.find((x) => String(x.workId) === workId);
    const workName = String(w?.name ?? workId);
    const unit = String(w?.unit ?? "од.");
    const rate = Number(w?.rate ?? 0);

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      objectId: oid,
      type: "RTS_OBJ_WORK_STOP",
      employeeIds: [employeeId],
      payload: {
        employeeId,
        workId,
        workName,
        unit,
        rate,
        qty: 0,
        amount: 0,
        startedAt,
        endedAt,
        reason: "BULK_STOP_PENDING_QTY",
      },
    });
  }
  st.qtyUnlocked = true;
  
  const keysToClose = new Set(openSessions.map((x) => openKey(x)));
  obj.open = (obj.open ?? []).filter((x) => !keysToClose.has(openKey(x)));

  const map = new Map<
    string,
    {
      workId: string;
      workName: string;
      unit: string;
      rate: number;
      sessionsCount: number;
      sec: number;
    }
  >();

  for (const s0 of openSessions) {
    const workId = String(s0.workId ?? "").trim();
    const startedAt = String(s0.startedAt ?? "").trim();

    const sMs = Date.parse(startedAt);
    const eMs = Date.parse(endedAt);
    const sec =
      Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs
        ? Math.floor((eMs - sMs) / 1000)
        : 0;

    const w = obj.works.find((x) => String(x.workId) === workId);
    const workName = String(w?.name ?? workId);
    const unit = String(w?.unit ?? "од.");
    const rate = Number(w?.rate ?? 0);

    const cur =
      map.get(workId) ??
      ({ workId, workName, unit, rate, sessionsCount: 0, sec: 0 } as any);

    cur.sessionsCount += 1;
    cur.sec += sec;

    if ((cur.rate ?? 0) <= 0 && rate > 0) cur.rate = rate;

    map.set(workId, cur);
  }
  st.qtyUnlocked = true;

  const itemsAll = (obj.works ?? [])
    .map((w: any) => {
      const wid = String(w.workId ?? "").trim();
      if (!wid) return null;

      const agg = map.get(wid);

      return {
        workId: wid,
        workName: String(w.name ?? wid),
        unit: String(w.unit ?? "од."),
        rate: Number(w.rate ?? 0),
        sessionsCount: Number(agg?.sessionsCount ?? 0),
        sec: Number(agg?.sec ?? 0),
        qty: 0,
      };
    })
    .filter(Boolean) as any[];

  const rosterIds = uniq([
    ...openSessions.map((x) => String(x.employeeId)).filter(Boolean),
    ...(obj.leftOnObjectIds ?? []).map(String).filter(Boolean),
  ]);

  st.pendingBulkQty = {
    objectId: oid,
    endedAt,
    employeeIds: rosterIds,

    items: itemsAll.length
      ? itemsAll
      : [...map.values()].map((x) => ({
          workId: x.workId,
          workName: x.workName,
          unit: x.unit,
          rate: x.rate,
          sessionsCount: x.sessionsCount,
          sec: x.sec,
          qty: 0,
        })),

    backStep: isReturnContext ? "RETURN_PICKUP_DROP" : "AT_OBJECT_MENU",
    afterSaveStep: isReturnContext ? "RETURN_PICKUP_DROP" : "AT_OBJECT_MENU",
  };

  st.arrivedObjectId = oid;
  st.step = "BULK_QTY";

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);

  const scr = buildBulkQtyScreen(st, cb);
  await safeEditMessageText(bot, chatId, msgId, scr.text, {
    parse_mode: "Markdown",
    reply_markup: scr.kb,
  });

  return true;
}

if (data === cb.RESUME) {
  if (!canResume(st)) return (gate("Зараз не можна продовжити рух."), true);

 

  if (!st.inCarIds?.length) {
    await gate("Нікого нема в машині.");
    return true;
  }

  const fromObjectId = st.arrivedObjectId ?? null;

  delete st.arrivedObjectId;

  st.phase = "DRIVE_DAY";
  st.driveActive = true;
  st.driveStartedAt = st.driveStartedAt ?? now();
  st.step = "RUN_DRIVE";

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);

  await bot.answerCallbackQuery(q.id, { text: "🟢 Рух продовжено" }).catch(() => {});
  try {
    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      type: "RTS_DRIVE_RESUME",
      payload: { at: now(), fromObjectId },
    });
  } catch (e) {
  }

  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data === cb.FINISH_DAY) {
      if (!canFinishDay(st))
        return (gate("STOP дня доступний на зупинці."), true);

      st.phase = "WAIT_RETURN";
      st.driveActive = false;
      st.step = "RETURN_MENU";

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        type: "RTS_DAY_FINISH",
        payload: { at: now(), lastObjectId: st.arrivedObjectId ?? null },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

if (data === cb.RETURN_PICK_OBJECT) {
  delete st.arrivedObjectId;
  delete (st as any)._pickupBackStep;
  delete (st as any)._pickupBackPhase;

  st.step = "RETURN_PICK_OBJECT";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

if (data.startsWith(cb.RETURN_OBJ)) {
  const oid = data.slice(cb.RETURN_OBJ.length);
  if (!oid) return true;

  (st as any)._pickupBackStep = "RETURN_MENU";
  (st as any)._pickupBackPhase = st.phase;

  st.arrivedObjectId = oid;
  ensureObjectState(st, oid);

  st.step = "RETURN_PICKUP_DROP";
  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data === cb.RETURN_DROP_ALL) {
      const oid = st.arrivedObjectId;
      if (!oid) return (gate("Нема обʼєкта."), true);

      const obj = ensureObjectState(st, oid);

      const hasOpenOnObj = (obj.open ?? []).some(
        (s0) => String(s0.objectId ?? oid) === String(oid),
      );
      if (hasOpenOnObj) {
        await bot.answerCallbackQuery(q.id, {
          text: "⛔ Є відкриті роботи. Спочатку введи обсяги (BULK_QTY).",
          show_alert: true,
        });

        const ok = await startBulkQtyForObject({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          s, 
          callbackQueryId: q.id, 
          st,
          oid,
          isReturnContext: st.step === "RETURN_PICKUP_DROP",
        });

        return true;
      }

      const picked = [...obj.leftOnObjectIds];

      for (const empId of picked) {
        if (!st.inCarIds.includes(empId)) st.inCarIds.push(empId);
        const ts = now();
        st.members.push({ employeeId: empId, joinedAt: ts });

        await writeEvent({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          carId: st.carId ?? "",
          objectId: oid,
          type: "RTS_PICK_UP",
          employeeIds: [empId],
          payload: { at: ts, return: true },
        });
      }

obj.leftOnObjectIds = [];

const backStep = (st as any)._pickupBackStep as Step | undefined;
const backPhase = (st as any)._pickupBackPhase as any;

delete (st as any)._pickupBackStep;
delete (st as any)._pickupBackPhase;

if (backStep) {
  st.step = backStep;
  if (backPhase) st.phase = backPhase;

  if (backStep.startsWith("AT_OBJECT")) {
    st.arrivedObjectId = oid;
  }   else {
    delete st.arrivedObjectId;
  }
}

root[foremanTgId] = st;
setFlowState(s, FLOW, root);
await render(bot, chatId, s, foremanTgId);
return true;
    }
    if (data.startsWith(cb.RETURN_TOGGLE_PICKUP)) {
      const empId = data.slice(cb.RETURN_TOGGLE_PICKUP.length);
      const oid = st.arrivedObjectId;
      if (!empId || !oid) return true;

      const obj = ensureObjectState(st, oid);
      if (!obj.leftOnObjectIds.includes(empId)) return true;

      const hasOpenOnObj = (obj.open ?? []).some(
        (s0) => String(s0.objectId ?? oid) === String(oid),
      );
      if (hasOpenOnObj) {
        await bot.answerCallbackQuery(q.id, {
          text: "⛔ Є відкриті роботи. Спочатку введи обсяги (BULK_QTY).",
          show_alert: true,
        });

        const ok = await startBulkQtyForObject({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          s, 
          callbackQueryId: q.id, 
          st,
          oid,
          isReturnContext: st.step === "RETURN_PICKUP_DROP",
        });

        return true;
      }

      obj.leftOnObjectIds = obj.leftOnObjectIds.filter((x) => x !== empId);
      if (!st.inCarIds.includes(empId)) st.inCarIds.push(empId);

      const ts = now();
      st.members.push({ employeeId: empId, joinedAt: ts });

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        objectId: oid,
        type: "RTS_PICK_UP",
        employeeIds: [empId],
        payload: { at: ts, return: true },
      });

if ((obj.leftOnObjectIds ?? []).length === 0) {
  const backStep = (st as any)._pickupBackStep as Step | undefined;
  const backPhase = (st as any)._pickupBackPhase as any;

  delete (st as any)._pickupBackStep;
  delete (st as any)._pickupBackPhase;

  if (backStep) {
    st.step = backStep;
    if (backPhase) st.phase = backPhase;

    if (backStep.startsWith("AT_OBJECT")) {
      st.arrivedObjectId = oid;
    }   else {
    delete st.arrivedObjectId;
  }
  }
}

root[foremanTgId] = st;
setFlowState(s, FLOW, root);
await render(bot, chatId, s, foremanTgId);
return true;
    }

if (data === cb.START_RETURN) {
  if (!canStartReturn(st)) {
    delete st.arrivedObjectId;
    delete (st as any)._pickupBackStep;
    delete (st as any)._pickupBackPhase;

    st.step = "RETURN_MENU";
    root[foremanTgId] = st;
setFlowState(s, FLOW, root);

    await bot.answerCallbackQuery(q.id, {
      text: "Повернення зараз не можна стартувати. Перевір людей у машині.",
      show_alert: true,
    });

    await render(bot, chatId, s, foremanTgId);
    return true;
  }

  if (!st.inCarIds?.length) {
    await gate("Машина не може їхати, бо пуста (нема людей в машині).");
    return true;
  }

  st.phase = "RETURN_DRIVE";
  st.returnActive = true;
  st.returnStartedAt = now();
  st.step = "RETURN_MENU";

  await writeEvent({
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    carId: st.carId ?? "",
    type: "RTS_RETURN_START",
    payload: { at: st.returnStartedAt },
  });

  root[foremanTgId] = st;
setFlowState(s, FLOW, root);
  await render(bot, chatId, s, foremanTgId);
  return true;
}

    if (data === cb.STOP_RETURN) {
      if (!canStopReturn(st)) return (gate("Повернення не активне."), true);

      st.returnActive = false;
      st.returnStoppedAt = now();
      st.phase = "FINISHED";
      st.step = "ODO_END";

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        type: "RTS_RETURN_STOP",
        payload: { at: st.returnStoppedAt },
      });

      root[foremanTgId] = st;
setFlowState(s, FLOW, root);
      await render(bot, chatId, s, foremanTgId);
      return true;
    }

    if (data === cb.ASK_ODO_END_KM) {
      if (!canEnterOdoEnd(st))
        return (gate("Кінцевий показник спідометра доступний після зіпинки на кінцевому об'єкті"), true);

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoEndNumber,
        async (msg) => {
          const raw = (msg.text ?? (msg as any)?.caption ?? "").toString();
          const km = parseKm(raw);
          if (km === undefined) {
            await bot.sendMessage(
              chatId,
              TEXTS.roadFlow.errors.notNumberExample.replace("{ex}", "12500"),
            );
            return;
          }

          st.odoEndKm = km;
          st.step = "ODO_END";

          await writeEvent({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            carId: st.carId ?? "",
            type: "RTS_ODO_END",
            payload: { odoEndKm: km },
          });

          root[foremanTgId] = st;
setFlowState(s, FLOW, root);
          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: chatId, message_id: msgId },
            );
          } catch {
          }

          const carLine = st.carId
            ? `${TEXTS.roadFlow.labels.carOk} ${carName(st, st.carId)}`
            : TEXTS.roadFlow.labels.carNone;

          await bot.sendMessage(
            chatId,
            `🔴 Кінцевий показник спідометра\n\n` +
              `${carLine}\n` +
              `${TEXTS.ui.labels.current} ${fmtNum(st.odoEndKm)} км\n\n` +
              `1) Введи число\n2) Потім фото (або пропусти)`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: TEXTS.roadFlow.buttons.enterValue,
                      callback_data: cb.ASK_ODO_END_KM,
                    },
                  ],
                  ...(st.odoEndKm !== undefined
                    ? [[ { text: TEXTS.roadFlow.buttons.sendPhoto, callback_data: cb.ASK_ODO_END_PHOTO,
                          },
                        ],
                      ]
                    : []),
                   ...(st.odoEndKm !== undefined
  ? [[{ text: TEXTS.roadFlow.buttons.skipPhoto, callback_data: cb.SKIP_ODO_END_PHOTO }]]
  : []), 
                  [
                    {
                      text: TEXTS.ui.buttons.back,
                      callback_data: `${cb.BACK}return_menu`,
                    },
                  ],
                  [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
                ],
              },
            },
          );
        },
      );

      return true;
    }

    if (data === cb.ASK_ODO_END_PHOTO) {
      if (!canEnterOdoEnd(st) || st.odoEndKm === undefined)
        return (gate("Спочатку введи ODO end."), true);

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoEndPhoto,
        async (msg) => {
          const fileId = fileIdFromPhoto(msg);
          if (!fileId) {
            await bot.sendMessage(chatId, TEXTS.roadFlow.errors.needPhoto);
            return;
          }

          st.odoEndPhotoFileId = fileId;
          st.step = "SAVE";

          await writeEvent({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            carId: st.carId ?? "",
            type: "RTS_ODO_END_PHOTO",
            payload: { fileId },
          });

          st.step = "SAVE";
          root[foremanTgId] = st;
setFlowState(s, FLOW, root);

          await bot.sendMessage(chatId, "✅ Фото кінцевого показника спідометра прийнято 📷");
          await uiSave(bot, chatId, foremanTgId, st);
        },
        2 * 60 * 1000,
        (m) => !!fileIdFromPhoto(m), 
      );

      return true;
    }
    
if (data === cb.SKIP_ODO_END_PHOTO) {
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (!canEnterOdoEnd(st) || st.odoEndKm === undefined)
    return (await gate("Спочатку введи ODO end."), true);

  st.odoEndPhotoFileId = st.odoEndPhotoFileId ?? "";
  st.step = "SAVE";

  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  await bot.sendMessage(chatId, "✅ Фото кінцевого показника спідометра пропущено");
  await uiSave(bot, chatId, foremanTgId, st);

  return true;
}


if (data === cb.SAVE) {

      if (!canSave(st)) return (gate("Спочатку ODO start/end."), true);
const saveProblems: string[] = [];

if (!st.carId) saveProblems.push("🚗 Не обрано авто");
if (st.odoStartKm === undefined) saveProblems.push("🟢 Не введено початковий ODO");
if (st.odoEndKm === undefined) saveProblems.push("🔴 Не введено кінцевий ODO");
if (!st.inCarIds?.length && !st.members?.length) saveProblems.push("👥 Не обрано людей");
if (!st.plannedObjectIds?.length) saveProblems.push("🏗 Не обрано обʼєкти");

for (const oid of st.plannedObjectIds ?? []) {
  const obj = ensureObjectState(st, oid);

  if (!obj.works?.length) {
    saveProblems.push(`🧱 ${objectName(st, oid)} — не додано план робіт`);
  }

  if ((obj.open ?? []).length > 0) {
    saveProblems.push(`⏱ ${objectName(st, oid)} — є незавершені роботи`);
  }
}

if (st.pendingBulkQty) {
  saveProblems.push("🧮 Є незбережені обсяги робіт");
}

if (saveProblems.length) {
  await bot.answerCallbackQuery(q.id, {
    text: "⛔ День не можна відправити адміну",
    show_alert: true,
  });

  await bot.sendMessage(
    chatId,
    `⛔ *Не можна відправити на затвердження*\n\n` +
      `Потрібно виправити:\n\n` +
      saveProblems.map((x) => `• ${x}`).join("\n"),
    { parse_mode: "Markdown" },
  );

  return true;
}

const sessionStartTs =
  String(st.driveStartedAt ?? st.members?.[0]?.joinedAt ?? "").trim();

let aggAll = await computeFromRts({ date, foremanTgId });

let roadAgg = await computeRoadSecondsFromRts({ date, foremanTgId });

let workMoneyRows = await computeWorkMoneyFromRts({
  date,
  foremanTgId,
});

if (sessionStartTs) {
  const startMs = Date.parse(sessionStartTs);

  if (Number.isFinite(startMs)) {
    aggAll = aggAll.filter((r: any) => {
      const ts = String(r.endedAt ?? r.startedAt ?? r.ts ?? "").trim();
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms >= startMs : true;
    });

    roadAgg = roadAgg.filter((r: any) => {
      const ts = String(r.endedAt ?? r.startedAt ?? r.ts ?? "").trim();
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms >= startMs : true;
    });

    workMoneyRows = workMoneyRows.filter((r: any) => {
      const ts = String(r.endedAt ?? r.startedAt ?? r.ts ?? "").trim();
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms >= startMs : true;
    });
  }
}

const qtyProblems: string[] = [];

for (const oid of st.plannedObjectIds ?? []) {
  const obj = ensureObjectState(st, oid);

  const objRows = workMoneyRows.filter(
    (r: any) => String(r.objectId) === String(oid),
  );

  for (const w of obj.works ?? []) {
    const workId = String(w.workId ?? "");

    const rowsForWork = objRows.filter(
      (r: any) => String(r.workId) === workId,
    );

    const qtySum = rowsForWork.reduce(
      (a: number, r: any) => a + Number(r.qty ?? 0),
      0,
    );

    if (qtySum <= 0) {
      qtyProblems.push(
        `🧮 ${objectName(st, oid)} — ${w.name ?? workId}: не заповнено обсяг`,
      );
    }
  }
}

if (qtyProblems.length) {
  await bot.answerCallbackQuery(q.id, {
    text: "⛔ Не заповнено обсяги",
    show_alert: true,
  });

  await bot.sendMessage(
    chatId,
    `⛔ *Не можна відправити на затвердження*\n\n` +
      qtyProblems.map((x) => `• ${x}`).join("\n"),
    { parse_mode: "Markdown" },
  );

  return true;
}

 
      let roadTotalSec = roadAgg.reduce((a, x) => a + (x.sec ?? 0), 0);
      const roadSecByEmp = new Map(roadAgg.map((r) => [r.employeeId, r.sec]));
      const roadObjects = st.plannedObjectIds.slice(0, 4); 
      const roadObjCount = roadObjects.length || 0;
      const workSecByEmpObj = new Map<string, number>(); 
      const discByEmpObj = new Map<string, number>(); 
      const prodByEmpObj = new Map<string, number>(); 

      for (const r of aggAll) {
        const key = `${r.employeeId}||${r.objectId}`;
        workSecByEmpObj.set(key, (workSecByEmpObj.get(key) ?? 0) + r.sec);
        discByEmpObj.set(key, r.disciplineCoef ?? 1.0);
        prodByEmpObj.set(key, r.productivityCoef ?? 1.0);
      }


      const editAddedPeopleIds = ((st as any).editAddedPeopleIds ?? []).map(String);
const editRemovedPeopleIds = new Set(
  ((st as any).editRemovedPeopleIds ?? []).map(String),
);

for (const key of [...workSecByEmpObj.keys()]) {
  const [empId] = key.split("||");

  if (editRemovedPeopleIds.has(String(empId))) {
    workSecByEmpObj.delete(key);
    discByEmpObj.delete(key);
    prodByEmpObj.delete(key);
  }
}

for (const removedEmpId of editRemovedPeopleIds) {
  roadSecByEmp.delete(String(removedEmpId));
}

for (const newEmpId of editAddedPeopleIds) {
  for (const oid of st.plannedObjectIds ?? []) {
    const secs = [...workSecByEmpObj.entries()]
      .filter(([key]) => key.endsWith(`||${oid}`))
      .map(([, sec]) => Number(sec ?? 0))
      .filter((sec) => sec > 0);

    if (!secs.length) continue;

    const avgSec = secs.reduce((a, b) => a + b, 0) / secs.length;
    const key = `${newEmpId}||${oid}`;

    workSecByEmpObj.set(key, avgSec);
    discByEmpObj.set(key, 1.0);
    prodByEmpObj.set(key, 1.0);
  }

  const roadSecs = [...roadSecByEmp.values()]
    .map((x) => Number(x ?? 0))
    .filter((x) => x > 0);

  if (roadSecs.length) {
    const avgRoadSec = roadSecs.reduce((a, b) => a + b, 0) / roadSecs.length;
    roadSecByEmp.set(newEmpId, avgRoadSec);
  }
}

roadTotalSec = [...roadSecByEmp.values()]
  .reduce((a, x) => a + Number(x ?? 0), 0);

  if ((st as any).editReturned) {
  const addedSet = new Set(editAddedPeopleIds.map(String));
  const removedSet = editRemovedPeopleIds;
 
  const editByObject = (st as any).editByObject ?? {};

workMoneyRows = workMoneyRows.filter((r: any) => {
  const objEdit = editByObject[String(r.objectId)] ?? {};
  const removedForObj = new Set((objEdit.removedPeopleIds ?? []).map(String));
  return !removedForObj.has(String(r.employeeId));
});

  const rebuiltWorkRows: any[] = [];

  for (const oid of st.plannedObjectIds ?? []) {
    const objEdit = editByObject[String(oid)] ?? {};
const addedForObj = (objEdit.addedPeopleIds ?? []).map(String);
const removedForObj = new Set((objEdit.removedPeopleIds ?? []).map(String));
    const obj = ensureObjectState(st, oid);

    for (const w of obj.works ?? []) {
      const workId = String(w.workId ?? "");

      const rows = workMoneyRows.filter(
        (r: any) =>
          String(r.objectId) === String(oid) &&
          String(r.workId) === workId,
      );

      if (!rows.length) continue;

      const totalQty = rows.reduce(
        (a: number, r: any) => a + Number(r.qty ?? 0),
        0,
      );

      const totalAmount = rows.reduce(
        (a: number, r: any) => a + Number(r.amount ?? 0),
        0,
      );

const people = uniq([
  ...rows.map((r: any) => String(r.employeeId)),
  ...addedForObj,
])
  .filter(Boolean)
  .filter((id) => !removedForObj.has(String(id)));

      if (!people.length) continue;

      const qtyPerPerson = totalQty / people.length;
      const amountPerPerson = totalAmount / people.length;

      const sample = rows[0];

      for (const empId of people) {
        rebuiltWorkRows.push({
          ...sample,
          employeeId: empId,
          qty: Math.round(qtyPerPerson * 100) / 100,
          amount: Math.round(amountPerPerson * 100) / 100,
          sec: Number(workSecByEmpObj.get(`${empId}||${oid}`) ?? sample.sec ?? 0),
        });
      }
    }
  }

  if (rebuiltWorkRows.length) {
    workMoneyRows = rebuiltWorkRows;
  }
       const workTotalsByObj = new Map<
        string,
        { amount: number; qtyByUnit: Record<string, number> }
      >();

      for (const r of workMoneyRows) {
        const cur = workTotalsByObj.get(r.objectId) ?? {
          amount: 0,
          qtyByUnit: {},
        };
        cur.amount += r.amount;
        cur.qtyByUnit[r.unit] = (cur.qtyByUnit[r.unit] ?? 0) + r.qty;
        workTotalsByObj.set(r.objectId, cur);
      }

      const workGrandTotal = [...workTotalsByObj.values()].reduce(
        (a, x) => a + x.amount,
        0,
      );
}

      const payrollPacks: PayrollObjectPack[] = [];
      await ensureEmployees(st);
      const nameById = new Map(
        (st.employees ?? []).map((e) => [String(e.id), String(e.name)]),
      );

      for (const oid of st.plannedObjectIds) {
        const rowsMap = new Map<string, PayrollEmpRow>();

for (const [k, sec] of workSecByEmpObj.entries()) {
  const parts = k.split("||");
  const empId = parts[0];
  const objId = parts[1];

  if (!empId || !objId) continue;
  if (objId !== oid) continue;

  const objState = ensureObjectState(st, oid);
  const d = Number(
    objState.coefDiscipline?.[empId] ??
    discByEmpObj.get(k) ??
    1.0
  );
  const p = Number(
    objState.coefProductivity?.[empId] ??
    prodByEmpObj.get(k) ??
    1.0
  );

  const hoursWork = sec / 3600;

  rowsMap.set(empId, {
    employeeId: empId,
    employeeName: nameById.get(String(empId)) ?? empId,
    hours: hoursWork,
    disciplineCoef: d,
    productivityCoef: p,
    coefTotal: d * p,
    points: 0,
  });
}
if (roadObjCount > 0 && roadObjects.includes(oid)) {
  for (const [empId, secRoad] of roadSecByEmp.entries()) {
    const addHours = secRoad / 3600 / roadObjCount;

    const key = `${empId}||${oid}`;
    const objState = ensureObjectState(st, oid);

    const d = Number(
      objState.coefDiscipline?.[empId] ??
      discByEmpObj.get(key) ??
      1.0
    );
    const p = Number(
      objState.coefProductivity?.[empId] ??
      prodByEmpObj.get(key) ??
      1.0
    );

    const existing = rowsMap.get(empId);
    if (existing) {
      existing.hours += addHours;
      existing.disciplineCoef = d;
      existing.productivityCoef = p;
      existing.coefTotal = d * p;
    } else {
      rowsMap.set(empId, {
        employeeId: empId,
        employeeName: nameById.get(String(empId)) ?? empId,
        hours: addHours,
        disciplineCoef: d,
        productivityCoef: p,
        coefTotal: d * p,
        points: 0,
      });
    }
  }
}

        const rows = [...rowsMap.values()]
          .map((r) => {
            const hoursRounded = roundToQuarterHours(r.hours);
            const coefTotal =
              (r.disciplineCoef ?? 1.0) * (r.productivityCoef ?? 1.0);
            const points = Math.round(hoursRounded * coefTotal * 100) / 100; 
            return { ...r, hours: hoursRounded, coefTotal, points };
          })
          .filter((r) => r.hours > 0);

        payrollPacks.push({
          objectId: oid,
          objectName: objectName(st, oid),
          rows: rows.sort((a, b) =>
            a.employeeName.localeCompare(b.employeeName),
          ),
        });
      }

      const allKeys = new Set<string>();

      for (const k of workSecByEmpObj.keys()) allKeys.add(k);

      if (roadObjCount > 0) {
        for (const oid of roadObjects) {
          for (const empId of roadSecByEmp.keys()) {
            allKeys.add(`${empId}||${oid}`);
          }
        }
      }

      const finalRows: Array<{
        employeeId: string;
        objectId: string;
        sec: number;
        disciplineCoef: number;
        productivityCoef: number;
      }> = [];

      for (const k of allKeys) {
        const [empId, objId] = k.split("||");
        if (!empId || !objId) continue;

        const workSec = workSecByEmpObj.get(k) ?? 0;

        let roadSec = 0;
        if (roadObjCount > 0 && roadObjects.includes(objId)) {
          const totalRoad = roadSecByEmp.get(empId) ?? 0;
          roadSec = totalRoad / roadObjCount;
        }

        const sec = workSec + roadSec;
        if (sec <= 0) continue;

const objState = ensureObjectState(st, objId);

finalRows.push({
  employeeId: empId,
  objectId: objId,
  sec,
  disciplineCoef: Number(
    objState.coefDiscipline?.[empId] ??
    discByEmpObj.get(k) ??
    1.0
  ),
  productivityCoef: Number(
    objState.coefProductivity?.[empId] ??
    prodByEmpObj.get(k) ??
    1.0
  ),
});
      }

      let timesheetWritten = 0;
      const timesheetWrittenByObj: Record<string, number> = {};

const dayStatusByObject = new Map<string, any>();

for (const oid of uniq(finalRows.map((x) => String(x.objectId)).filter(Boolean))) {
  const ds = await getDayStatusRow(date, oid, foremanTgId);
  dayStatusByObject.set(oid, ds);
}

for (const r of finalRows) {
  const ds = dayStatusByObject.get(String(r.objectId));
  if (isLocked(ds?.status)) continue;

  const hours = roundToQuarterHours(r.sec / 3600);

  await upsertTimesheetRow({
    date,
    objectId: r.objectId,
    employeeId: r.employeeId,
    employeeName: nameById.get(String(r.employeeId)) ?? r.employeeId,
    hours,
    source: "RTS_EVENTS_WORK+ROAD",
    productivityCoef: r.productivityCoef,
    disciplineCoef: r.disciplineCoef,
    updatedAt: nowISO(),
  } as any);

  timesheetWritten++;
  timesheetWrittenByObj[r.objectId] =
    (timesheetWrittenByObj[r.objectId] ?? 0) + 1;
}

      await upsertOdometerDay({
        date,
        carId: st.carId!,
        foremanTgId,
        startValue: st.odoStartKm!,
        endValue: st.odoEndKm!,
        startPhoto: st.odoStartPhotoFileId ?? "",
        endPhoto: st.odoEndPhotoFileId ?? "",
        updatedAt: nowISO(),
      } as any);

const riders = uniq([
  ...st.members.map((m: RoadMember) => String(m.employeeId)),
  ...((st as any).editAddedPeopleIds ?? []).map(String),
  ...(st.inCarIds ?? []).map(String),
])
  .filter(Boolean)
  .filter((id) => !editRemovedPeopleIds.has(String(id)));
      const kmDay = Math.max(0, st.odoEndKm! - st.odoStartKm!);
      const tripClass = classifyTripByKm(kmDay);

      const amount =
        (await getSettingNumber(`ROAD_ALLOWANCE_${tripClass}`)) ??
        DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass];

      const perPerson = riders.length ? amount / riders.length : 0;

const brigadierEmployeeIds: string[] = [];

const oneBrigadier = await pickBrigadierFromPeople(riders);
if (oneBrigadier) {
  brigadierEmployeeIds.push(String(oneBrigadier));
}

const seniorEmployeeIds: string[] = [];

for (const empId of riders) {
  if (await isSenior(empId)) {
    seniorEmployeeIds.push(String(empId));
  }
}

const brigadierEmployeeId = brigadierEmployeeIds[0] ?? "";
const seniorEmployeeId = seniorEmployeeIds[0] ?? "";

      const roadEndEventId = makeEventId("ROAD");
      const carTitle = carName(st, st.carId);
      const objectsDetailed = st.plannedObjectIds.map((oid) => ({
        objectId: oid,
        objectName: objectName(st, oid),
      }));

      const workTotalsByObject = st.plannedObjectIds.map((oid) => {
        const rows = workMoneyRows.filter((r) => r.objectId === oid);
        const total = rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
        return { objectId: oid, objectName: objectName(st, oid), total };
      });

const salaryPacks: SalaryPack[] = buildSalaryPacksWithRoles({
  workTotalsByObject,
  payrollPacks,
  brigadierEmployeeIds,
  seniorEmployeeIds,
});

const workedEmployeeIdsByObject: Record<string, string[]> = {};

for (const oid of st.plannedObjectIds) {
workedEmployeeIdsByObject[oid] = uniq(
  workMoneyRows
    .filter((r: any) => String(r.objectId) === String(oid))
    .map((r: any) => String(r.employeeId))
    .filter(Boolean),
);
}

const workGrandTotal = workMoneyRows.reduce(
  (a: number, r: any) => a + Number(r.amount ?? 0),
  0,
);

      const totalToPay = Number(workGrandTotal ?? 0) + Number(amount ?? 0);
      const fullPayload = {
        kmDay,
        tripClass,
        amount,
        perPerson,
        carName: carTitle,
        objectsCount: st.plannedObjectIds.length,
        objectsDetailed,
        workTotalsByObject,
        payrollPacks,
        salaryPacks,
        roadTotalSec,
        workGrandTotal,
        totalToPay,
        workMoneyRows,
        brigadierEmployeeId,
        seniorEmployeeId,
        brigadierEmployeeIds,
        seniorEmployeeIds,
        plannedObjectIds: st.plannedObjectIds,
        workedEmployeeIdsByObject,
        odoStartKm: st.odoStartKm,
        odoEndKm: st.odoEndKm,
        carId: st.carId,
roadAgg: [...roadSecByEmp.entries()].map(([employeeId, sec]) => ({
  employeeId,
  employeeName: nameById.get(String(employeeId)) ?? employeeId,
  sec,
})),

        riders: riders.map((id) => ({
          id,
          name: nameById.get(String(id)) ?? id,
        })),
      };

      await appendEvents([
        {
          eventId: roadEndEventId,
          status: "АКТИВНА",
          ts: nowISO(),
          date,
          foremanTgId,
          type: "ROAD_END",
          objectId: "",
          carId: st.carId ?? "",
          employeeIds: riders.join(","),
          payload: JSON.stringify(fullPayload),
          chatId,
          msgId,
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

await bot.sendMessage(
  chatId,
  `📨 День відправлено на затвердження адміністратору.\n` +
    `📅 Дата: ${date}\n` +
    `🆔 Подія: Робочий день`,
);

      const adminIds = await getAdminTgIds();

      if (!adminIds.length) {
        await bot.sendMessage(
          chatId,
          "⚠️ У листі КОРИСТУВАЧІ не знайдено активних ADMIN (tgId+роль).",
        );
      }

      const adminKb: TelegramBot.InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            {
              text: "✅ Затвердити",
              callback_data: `${cb.ADM_APPROVE}${roadEndEventId}`,
            },
            {
              text: "🔴 Повернути",
              callback_data: `${cb.ADM_RETURN}${roadEndEventId}`,
            },
          ],
        ],
      };

      const adminText = buildRoadAdminTextFromEventPayload({
        date,
        eventId: roadEndEventId,
        carId: st.carId ?? "",
        payload: JSON.stringify(fullPayload),
      });

      for (const adminId of adminIds) {
        try {
await sendLongHtml(bot, adminId, adminText, {
  disable_web_page_preview: true,
  reply_markup: adminKb as any, // ✅
});
        } catch (e: any) {
          await bot
            .sendMessage(
              chatId,
              `⚠️ Не вдалося надіслати адміну (${adminId}).\nПричина: ${e?.message ?? String(e)}`.slice(
                0,
                3500,
              ),
            )
            .catch(() => {});
        }
      }

      await upsertAllowanceRows(
        riders.map(
          (employeeId) =>
            ({
              date,
              foremanTgId,
              type: "ROAD_TRIP",
              employeeId,
              employeeName: nameById.get(String(employeeId)) ?? employeeId,
              objectId: "ROAD",
              amount: perPerson,
              meta: JSON.stringify({
                kmDay,
                tripClass,
                carId: st.carId,
                plannedObjectIds: st.plannedObjectIds,
              }),
              dayStatus: "ЧЕРНЕТКА",
              updatedAt: nowISO(),
            }) as any,
        ),
      );

      for (const oid of st.plannedObjectIds) {
        try {
          await refreshDayChecklist(date, oid, foremanTgId);
        } catch {}
      }

      await writeEvent({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        carId: st.carId ?? "",
        type: "RTS_SAVE",
        payload: {
          kmDay,
          tripClass,
          amount,
          perPerson,
          ridersCount: riders.length,
        },
      });



(st as any).submittedForApproval = true;
(st as any).adminReviewEventId = roadEndEventId;
st.step = "SAVE";

root[foremanTgId] = st;
setFlowState(s, FLOW, root);

await bot.sendMessage(
  chatId,
  "⏳ День відправлено адміну на перевірку. Редагування тимчасово заблоковано."
);

return true;
    }

    return true;
  },
};

export const PeopleTimesheetFlow = RoadTimesheetFlow;
