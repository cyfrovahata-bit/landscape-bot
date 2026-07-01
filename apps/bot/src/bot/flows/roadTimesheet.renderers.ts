import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";
import type { State } from "./roadTimesheet.types.js";
import { cb } from "./roadTimesheet.cb.js";
import { canStartDay } from "./roadTimesheet.guards.js";
import { getObjectAddressGroups, getPeopleBrigadeGroups } from "./roadTimesheet.domain.js";
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

  rows.push([{ text: "🧹 Скинути поточний стан", callback_data: cb.RESET_STATE }]);
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
  const inCar = new Set(x.inCarIds);
  const groups = getPeopleBrigadeGroups(x);
  const activeBrigadeId = String((x as any).activePeopleBrigadeId ?? "").trim();
  const activeGroup = activeBrigadeId
    ? groups.find((g) => g.id === activeBrigadeId)
    : undefined;

  if (activeGroup) {
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    const selectedCount = activeGroup.employees.filter((e) => inCar.has(String(e.id))).length;

    rows.push([
      {
        text: "✅ Вибрати всіх",
        callback_data: `${cb.PEOPLE_GROUP_SELECT_ALL}${encodeURIComponent(activeGroup.id)}`,
      },
    ]);
    rows.push([
      {
        text: "❌ Зняти всіх",
        callback_data: `${cb.PEOPLE_GROUP_CLEAR_ALL}${encodeURIComponent(activeGroup.id)}`,
      },
    ]);

    for (const e of activeGroup.employees.slice(0, 45)) {
      const busy = busyByEmployeeId.get(String(e.id));
      const isMine = inCar.has(String(e.id));
      const label = isMine
        ? `☑️ ${e.name}`
        : busy
          ? `🔒 ${e.name} — ${busy.foremanName}`
          : `☐ ${e.name}`;

      rows.push([
        {
          text: label.slice(0, 60),
          callback_data: `${cb.PEOPLE_TOGGLE}${e.id}`,
        },
      ]);
    }

    rows.push([{ text: "⬅️ Назад до бригад", callback_data: cb.PEOPLE_GROUPS_BACK }]);
    if (x.inCarIds.length > 0) {
      rows.push([{ text: "➡️ Продовжити", callback_data: cb.PEOPLE_DONE }]);
    }
    rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

    return {
      text:
        `👥 ${activeGroup.title}\n` +
        `Вибрано: ${selectedCount}/${activeGroup.employees.length}`,
      kb: { inline_keyboard: rows },
    };
  }

  const iconFor = (title: string) => {
    const s = title.toLowerCase();
    if (s.includes("полив")) return "🚿";
    if (s.includes("благо")) return "🏡";
    if (s.includes("агр")) return "🌱";
    if (s.includes("догляд")) return "🌿";
    return "👥";
  };

  const rows: TelegramBot.InlineKeyboardButton[][] = groups.map((g) => {
    const selected = g.employees.filter((e) => inCar.has(String(e.id))).length;
    return [
      {
        text: `${iconFor(g.title)} ${g.title} (${selected}/${g.employees.length})`.slice(0, 60),
        callback_data: `${cb.PEOPLE_GROUP_OPEN}${encodeURIComponent(g.id)}`,
      },
    ];
  });

  if (x.inCarIds.length > 0) {
    rows.push([{ text: "➡️ Продовжити", callback_data: cb.PEOPLE_DONE }]);
  }
  rows.push([
    { text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` },
  ]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  return {
    text:
      `👥 Виберіть бригаду\n\n` +
      `Зараз в машині: ${joinEmpNames(x, x.inCarIds)}`,
    kb: { inline_keyboard: rows },
  };
}

function callbackData(text: string, callbackData: string) {
  const bytes = Buffer.byteLength(callbackData, "utf8");
  if (bytes > 64) {
    console.warn(
      `[roadTimesheet.renderers] callback_data too long: text="${text}" bytes=${bytes}`,
    );
  }
  return callbackData;
}

export function renderPickObjectsScreen(ctx: RenderContext) {
  const { x, date } = ctx;
  const picked = new Set(x.plannedObjectIds);
  const groups = getObjectAddressGroups(x);
  const activeGroupId = String((x as any).activeObjectAddressGroupId ?? "").trim();
  const activeGroup = activeGroupId
    ? groups.find((g) => g.id === activeGroupId)
    : undefined;

  if (activeGroup) {
    const activeGroupIndex = groups.findIndex((g) => g.id === activeGroup.id);
    const selectedCount = activeGroup.objects.filter((o) => picked.has(String(o.id))).length;
    const rows: TelegramBot.InlineKeyboardButton[][] = [
      [
        {
          text: "✅ Вибрати всі",
          callback_data: callbackData(
            "✅ Вибрати всі",
            `${cb.OBJECT_GROUP_SELECT_ALL_SHORT}${activeGroupIndex}`,
          ),
        },
      ],
      [
        {
          text: "❌ Зняти всі",
          callback_data: callbackData(
            "❌ Зняти всі",
            `${cb.OBJECT_GROUP_CLEAR_ALL_SHORT}${activeGroupIndex}`,
          ),
        },
      ],
    ];

    for (const [objectIndex, o] of activeGroup.objects.slice(0, 45).entries()) {
      const text = `${picked.has(String(o.id)) ? "☑️ " : "☐ "}${o.name}`.slice(0, 60);
      rows.push([
        {
          text,
          callback_data: callbackData(text, `${cb.OBJECT_TOGGLE_SHORT}${objectIndex}`),
        },
      ]);
    }

    rows.push([{
      text: "⬅️ Назад до адрес",
      callback_data: callbackData("⬅️ Назад до адрес", cb.OBJECT_GROUPS_BACK),
    }]);
    if (x.plannedObjectIds.length > 0) {
      rows.push([{
        text: "➡️ Продовжити",
        callback_data: callbackData("➡️ Продовжити", cb.OBJECTS_DONE),
      }]);
    }
    rows.push([{
      text: TEXTS.common.backToMenu,
      callback_data: callbackData(TEXTS.common.backToMenu, cb.MENU),
    }]);

    return {
      text:
        `📍 ${activeGroup.title}\n` +
        `Вибрано: ${selectedCount}/${activeGroup.objects.length}`,
      kb: { inline_keyboard: rows },
    };
  }

  const rows: TelegramBot.InlineKeyboardButton[][] = groups.map((g, groupIndex) => {
    const selected = g.objects.filter((o) => picked.has(String(o.id))).length;
    const icon = g.title === "Без адреси" ? "📍" : "🏙";
    const text = `${icon} ${g.title} (${selected}/${g.objects.length})`.slice(0, 60);

    return [
      {
        text,
        callback_data: callbackData(text, `${cb.OBJECT_GROUP_OPEN_SHORT}${groupIndex}`),
      },
    ];
  });

  if (x.plannedObjectIds.length > 0) {
    rows.push([{
      text: "➡️ Продовжити",
      callback_data: callbackData("➡️ Продовжити", cb.OBJECTS_DONE),
    }]);
  }
  rows.push([
    {
      text: TEXTS.ui.buttons.back,
      callback_data: callbackData(TEXTS.ui.buttons.back, `${cb.BACK}start`),
    },
  ]);
  rows.push([{
    text: TEXTS.common.backToMenu,
    callback_data: callbackData(TEXTS.common.backToMenu, cb.MENU),
  }]);

  return {
    text:
      `📍 Виберіть місто / адресу\n\n` +
      `📅 ${date}\n` +
      `Обрано: ${x.plannedObjectIds.length}`,
    kb: { inline_keyboard: rows },
  };
}
