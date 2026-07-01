// Тут тільки константи назв колонок (UA 1-в-1)

export type HeaderName = string | string[];

// --- КОРИСТУВАЧІ
export const USERS_HEADERS = {
  tgId: "TG_ID",
  username: "USERNAME",
  pib: "ПІБ",
  role: "РОЛЬ",
  active: "АКТИВ",
  comment: "КОМЕНТАР",
} as const;
 
// --- EDIT_LOG
export const EDIT_LOG_HEADERS = {
  editId: "EDIT_ID",
  ts: "TS",
  editorTgId: "EDITOR_TG_ID",
  entity: "ENTITY",
  entityId: "ENTITY_ID",
  date: "DATE",
  objectId: "OBJECT_ID",
  foremanTgId: "FOREMAN_TG_ID",
  patchJson: "PATCH_JSON",
  beforeJson: "BEFORE_JSON",
  afterJson: "AFTER_JSON",
  reason: "REASON",
  chatId: "CHAT_ID",
  msgId: "MSG_ID",
} as const;


// --- ПРАЦІВНИКИ
export const EMP_HEADERS = {
  id: "ID",
  name: "ІМ'Я",
  brigadeId: "БРИГАДА_ID",
  position: "ПОСАДА",
  active: "АКТИВ",
} as const;

// --- ОБʼЄКТИ
export const OBJECTS_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  address: "АДРЕСА",
  active: "АКТИВ",
} as const;

// --- РОБОТИ
export const WORKS_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  category: "КАТЕГОРІЯ",
  unit: "ОДИНИЦЯ",
  tariff: "СТАВКА",
  active: "АКТИВ",
} as const;

// --- РОБОТИ
export const LOGISTIC_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  tariff: "СТАВКА",
  discount: "ЗНИЖКИ",
  active: "АКТИВ",
} as const;

// --- АВТО
export const CARS_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  plate: "НОМЕР",
  active: "АКТИВ",
} as const;

// --- ЗВІТИ
export const REPORTS_HEADERS = {
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  workId: "РОБОТА_ID",
  workName: "НАЗВА_РОБОТИ",
  volume: "ОБСЯГ",
  volumeStatus: "СТАТУС_ОБСЯГУ", // НЕ_ЗАПОВНЕНО | ЗАПОВНЕНО
  photos: "ФОТО", // JSON або csv
  dayStatus: "СТАТУС_ДНЯ", // ЧЕРНЕТКА | ЗДАНО | ПОВЕРНУТО | ЗАТВЕРДЖЕНО
  createdAt: "СТВОРЕНО",
  updatedAt: "ОНОВЛЕНО",
} as const;

// --- ТАБЕЛЬ
export const TIMESHEET_HEADERS = {
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  employeeId: "ПРАЦІВНИК_ID",
  employeeName: "ІМʼЯ_ПРАЦІВНИКА",
  hours: "ГОДИНИ",
  disciplineCoef: "КОЕФ_ДИСЦИПЛІНА",
  productivityCoef: "КОЕФ_ПРОДУКТИВНІСТЬ",
  source: "ДЖЕРЕЛО",
  updatedAt: "ОНОВЛЕНО",
} as const;

// --- ЖУРНАЛ_ПОДІЙ
export const EVENTS_HEADERS = {
  eventId: "ПОДІЯ_ID",
  ts: "ЧАС",
  date: "ДАТА",
  foremanTgId: "БРИГАДИР_TG_ID",
  type: "ТИП_ПОДІЇ",
  objectId: "ОБʼЄКТ_ID",
  carId: "АВТО_ID",
  employeeIds: "ПРАЦІВНИКИ_ID",
  payload: "ДАНІ",
  chatId: "ЧАТ_ID",
  msgId: "MSG_ID",
  status: "СТАТУС", // АКТИВНА | ЗАТВЕРДЖЕНО | ПОВЕРНУТО | СКАСОВАНО
  refEventId: "ПОВʼЯЗАНО_З_ПОДІЄЮ_ID",
  updatedAt: "ОНОВЛЕНО",
  price: "ЦІНА",
  amount: "СУМА",
} as const;

// --- ОДОМЕТР_ДЕНЬ
export const ODOMETER_HEADERS = {
  date: "ДАТА",
  carId: "АВТО_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  startValue: "ОДОМЕТР_СТАРТ",
  startPhoto: "ФОТО_СТАРТ",
  endValue: "ОДОМЕТР_КІНЕЦЬ",
  endPhoto: "ФОТО_КІНЕЦЬ",
  kmDay: "КМ_ЗА_ДЕНЬ",
  tripClass: "КЛАС_ВИЇЗДУ",
  updatedAt: "ОНОВЛЕНО",
} as const;

// --- ДОПЛАТИ
export const ALLOWANCES_HEADERS = {
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  type: "ТИП_ДОПЛАТИ", // ЛОГІСТИКА | ВИЇЗД | ...
  employeeId: "ПРАЦІВНИК_ID",
  employeeName: "ІМʼЯ_ПРАЦІВНИКА",
  amount: "СУМА",
  meta: "МЕТА",
  dayStatus: "СТАТУС_ДНЯ",
  updatedAt: "ОНОВЛЕНО",
} as const;

// --- СТАТУС_ДНЯ
export const DAY_STATUS_HEADERS = {
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  status: "СТАТУС", // ЧЕРНЕТКА | ЗДАНО | ПОВЕРНУТО | ЗАТВЕРДЖЕНО

  hasTimesheet: "Є_ТАБЕЛЬ",
  hasReports: "Є_РОБОТИ",

  hasReportsVolumeOk: "Є_РОБОТИ_ОБСЯГ_OK",
  hasOdoStartPhoto: "Є_ФОТО_ОДОМЕТР_СТАРТ",
  hasOdoEndPhoto: "Є_ФОТО_ОДОМЕТР_КІНЕЦЬ",

  hasRoad: "Є_ДОРОГА",
  hasOdoStart: "Є_ОДОМЕТР_СТАРТ",
  hasOdoEnd: "Є_ОДОМЕТР_КІНЕЦЬ",
  hasLogistics: "Є_ЛОГІСТИКА",
  hasMaterials: "Є_МАТЕРІАЛИ",

  returnReason: "ПРИЧИНА_ПОВЕРНЕННЯ",
  approvedBy: "ЗАТВЕРДИВ",
  approvedAt: "ЗАТВЕРДЖЕНО_В",
  updatedAt: "ОНОВЛЕНО",
} as const;

export const SETTINGS_HEADERS = {
  key: "KEY",
  value: "VALUE",
  comment: "COMMENT",
} as const;

// --- ЗАКРИТТЯ
export const CLOSURES_HEADERS = {
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  submittedAt: "ЗДАНО_В",
  submittedBy: "ЗДАНО_КИМ",
  comment: "КОМЕНТАР",
} as const;

export const MATERIALS_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  category: "КАТЕГОРІЯ",
  unit: "ОДИНИЦЯ",
  active: "АКТИВ",
  comment: "КОМЕНТАР",
} as const;

export const MATERIALS_MOVE_HEADERS = {
  moveId: "РУХ_ID",
  time: "ЧАС",
  date: "ДАТА",
  objectId: "ОБʼЄКТ_ID",
  foremanTgId: "БРИГАДИР_TG_ID",
  materialId: "MATERIAL_ID",
  materialName: "НАЗВА_МАТЕРІАЛУ",
  qty: "QTY",
  unit: "ОДИНИЦЯ",
  moveType: "ТИП_РУХУ",
  purpose: "МЕТА",
  photos: "ФОТО",
  payload: "ДАНІ",
  dayStatus: "СТАТУС_ДНЯ",
  updatedAt: "ОНОВЛЕНО",
} as const;

export const TOOLS_HEADERS = {
  id: "ID",
  name: "НАЗВА",
  category: "КАТЕГОРІЯ",
  active: "АКТИВ",
  comment: "КОМЕНТАР",
} as const;

export const TOOLS_MOVE_HEADERS = {
  moveId: "РУХ_ID",
  time: "ЧАС",
  date: "ДАТА",
  foremanTgId: "БРИГАДИР_TG_ID",
  toolId: "TOOL_ID",
  toolName: "НАЗВА_ІНСТРУМЕНТУ",
  qty: "QTY",
  moveType: "ТИП_РУХУ",
  purpose: "МЕТА",
  photos: "ФОТО",
  payload: "ДАНІ",
  updatedAt: "ОНОВЛЕНО",
} as const;
