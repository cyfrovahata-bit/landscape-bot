import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";
import type { State } from "./roadTimesheet.types.js";
import { cb } from "./roadTimesheet.cb.js";
import { canStartDay } from "./roadTimesheet.guards.js";
import { fmtNum, joinEmpNames } from "./roadTimesheet.utils.js";

export type RenderContext = {
  x: State;
  date: string;
  carLine: string;
  odoStartLine: string;
  odoEndLine: string;
  plannedLine: string;
  inCarLine: string;
  phaseLine: string;
  busyByCarId: Map<string, { foremanTgId: number; foremanName: string }>;
  busyByEmployeeId: Map<string, { foremanTgId: number; foremanName: string }>;
};

export function renderStartScreen(ctx: RenderContext) {
  const { x, date, carLine, odoStartLine, odoEndLine, plannedLine, inCarLine, phaseLine } = ctx;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  if ((x as any).editReturned) {
  rows.push([
    {
      text: "✏️ Редагувати повернений день",
      callback_data: cb.RETURN_EDIT_OBJECTS,
    },
  ]);
}

  rows.push([
    { text: TEXTS.roadFlow.buttons.pickCar, callback_data: cb.PICK_CAR },
  ]);
  rows.push([
    { text: TEXTS.roadFlow.buttons.odoStart, callback_data: cb.ODO_START },
  ]);
  rows.push([
    { text: "👥 Люди", callback_data: cb.PICK_PEOPLE },
  ]);
  rows.push([
    { text: "🏗 Обʼєкти", callback_data: cb.PICK_OBJECTS },
  ]);
  if (x.plannedObjectIds.length) {
    rows.push([
      {
        text: "🧱 План робіт по обʼєктах",
        callback_data: cb.PLAN_OBJECT_MENU,
      },
    ]);
  }
  if (
    x.driveActive ||
    x.returnActive ||
    x.phase === "DRIVE_DAY" ||
    x.phase === "PAUSED_AT_OBJECT" ||
    x.phase === "WORKING_AT_OBJECT" ||
    x.phase === "WAIT_RETURN" ||
    x.phase === "RETURN_DRIVE"
  ) {
    const label =
      x.phase === "PAUSED_AT_OBJECT" || x.phase === "WORKING_AT_OBJECT"
        ? "↩️ Назад до обʼєкта"
        : x.phase === "RETURN_DRIVE" || x.phase === "WAIT_RETURN"
          ? "🌙 Повернення (меню)"
          : "🟢 Їдемо (дорога)";

    rows.push([{ text: label, callback_data: cb.GO_DRIVE }]);
  }

  if (canStartDay(x))
    rows.push([
      {
        text: TEXTS.roadFlow.buttons.startDay,
        callback_data: cb.START_DAY,
      },
    ]);

       if (x.qtyUnlocked) {
    rows.push([{ text: "🧮 Обсяги робіт", callback_data: cb.QTY_MENU }]);
  }

if (
  x.phase === "FINISHED" ||
  x.odoEndKm !== undefined ||
  !!x.odoEndPhotoFileId
) {
  rows.push([
    {
      text: "🔴 Кінцевий показник спідометра",
      callback_data: `${cb.BACK}odo_end`,
    },
  ]);

  if (x.odoEndKm !== undefined) {
    rows.push([
      {
        text: "📨 Відправити на перевірку",
        callback_data: cb.SKIP_ODO_END_PHOTO,
      },
    ]);
  }
}

  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);
  return {
    text:
      `🛣 Робочий день\n\n` +
      `📅 ${date}\n\n` +
      `${phaseLine}\n` +
      `${carLine}\n` +
      `${odoStartLine}\n` +
      `${plannedLine}\n` +
      `${odoEndLine}\n` +
      `${inCarLine}\n\n` +
      `Підготовка: авто → показник спідометра → обʼєкти → план робіт → початок`,
    kb: { inline_keyboard: rows },
  };
}

export function renderPickCarScreen(ctx: RenderContext) {
  const { x, busyByCarId } = ctx;
  const cars = x.carsMeta ?? [];
  const slice = cars.slice(0, 24);

  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((c) => {
    const selected = x.carId === c.id;
    const busy = busyByCarId.get(String(c.id));

    const label = selected
      ? `☑️ ${c.name}`
      : busy
        ? `🔒 ${c.name} — ${busy.foremanName}`
        : `${c.name}`;

    return [
      {
        text: label.slice(0, 60),
        callback_data: `${cb.CAR}${c.id}`,
      },
    ];
  });

  rows.push([
    { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text: `🚗 Обери авто\n\nПоказую перші ${slice.length} з ${cars.length}.`,
    kb: { inline_keyboard: rows },
  };
}

export function renderOdoStartScreen(ctx: RenderContext) {
  const { x, carLine } = ctx;
  return {
    text:
      `🟢 Початковий показник спідометра\n\n` +
      `${carLine}\n` +
      `${TEXTS.ui.labels.current} ${fmtNum(x.odoStartKm)} км\n\n` +
      `1) Введи число\n2) Потім надішли фото`,
    kb: {
      inline_keyboard: [
        [
          {
            text: TEXTS.roadFlow.buttons.enterValue,
            callback_data: cb.ASK_ODO_START_KM,
          },
        ],
        ...(x.odoStartKm !== undefined
          ? [
              [
                {
                  text: TEXTS.roadFlow.buttons.sendPhoto,
                  callback_data: cb.ASK_ODO_START_PHOTO,
                },
              ],
            ]
          : []),
        [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    },
  };
}

export function renderPickPeopleScreen(ctx: RenderContext) {
  const { x, busyByEmployeeId } = ctx;
  const emps = x.employees ?? [];
  const slice = emps.slice(0, 40);
  const inCar = new Set(x.inCarIds);
const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((e) => {
  const busy = busyByEmployeeId.get(String(e.id));
  const isMine = inCar.has(e.id);

  const label = isMine
    ? `✅ ${e.name}`
    : busy
      ? `🔒 ${e.name} — ${busy.foremanName}`
      : `▫️ ${e.name}`;

  return [
    {
      text: label.slice(0, 60),
      callback_data: `${cb.EMP_TOGGLE}${e.id}`,
    },
  ];
});

  rows.push([{ text: "✅ Готово", callback_data: cb.PEOPLE_DONE }]);
  rows.push([
    { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);
  return {
    text:
      `👥 Люди в машині\n\n` +
      `Зараз: ${joinEmpNames(x, x.inCarIds)}\n\n` +
      `Натискай щоб додати/прибрати.`,
    kb: { inline_keyboard: rows },
  };
}

export function renderPickObjectsScreen(ctx: RenderContext) {
  const { x, date } = ctx;
  const objs = x.objectsMeta ?? [];
  const slice = objs.slice(0, 30);
  const picked = new Set(x.plannedObjectIds);
  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o) => [
    {
      text: `${picked.has(o.id) ? "✅ " : "▫️ "}${o.name}`.slice(
        0,
        60,
      ),
      callback_data: `${cb.OBJ_TOGGLE}${o.id}`,
    },
  ]);
  rows.push([{ text: "✅ Готово", callback_data: cb.OBJECTS_DONE }]);
  if (canStartDay(x)) {
    rows.push([
      {
        text: TEXTS.roadFlow.buttons.startDay,
        callback_data: cb.START_DAY,
      },
    ]);
  }
  rows.push([
    { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `🏗 Обʼєкти\n\n` +
      `📅 ${date}\n` +
      `Обрано: ${x.plannedObjectIds.length}\n\n` +
      `Натискай щоб додати/прибрати.`,
    kb: { inline_keyboard: rows },
  };
}
