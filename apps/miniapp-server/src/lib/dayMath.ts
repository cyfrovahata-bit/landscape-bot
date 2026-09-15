/**
 * Чиста арифметика дня: злиття поїздок і кілометри роз'їздів.
 *
 * Винесено з `routes/roadTimesheet.ts` НЕ для краси, а щоб це можна було
 * покрити тестами: маршрутний файл при імпорті тягне `db` і Google-конфіг,
 * тож перевірити його функції окремо не виходило. А саме тут і живуть дві
 * помилки, які вже коштували грошей:
 *   - той самий обʼєкт у двох поїздках дня складає години Й обсяги
 *     (08.09: по 15.91 год на людину замість 7.96);
 *   - км роз'їздів, які не вирахували з класу поїздки.
 * Див. `apps/miniapp-server/test/dayMath.test.ts`.
 */

/** Сесія роботи: людину висадили на обʼєкті і (зазвичай) потім забрали. */
export type WorkSession = { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string };

/** employeeIds -- на кого саме закріплена робота. Порожньо = бригадна. */
export type WorkInput = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };

/** Коефіцієнти пишуться на людину, але грошей НЕ рухають (див. CLAUDE.md). */
export type CoefInput = { employeeId: string; disciplineCoef?: number; productivityCoef?: number };

export type ObjectInput = {
  objectId: string;
  objectName: string;
  works: WorkInput[];
  sessions: WorkSession[];
  coefs?: CoefInput[];
  notes?: string;
  photoUrls?: string[];
};

/**
 * Роз'їзд: машина вибула з обʼєкта по справам, поки бригада працювала.
 * Ці км (odoBack − odoOut) виключаються з класу поїздки й доплати за виїзд,
 * але НЕ з реального пробігу одометра.
 */
export type Errand = { driverId?: string; odoOut?: number; odoBack?: number | null };

export function sumErrandKm(errands?: Errand[]): number {
  if (!Array.isArray(errands)) return 0;
  return errands.reduce((acc, e) => {
    const out = Number(e?.odoOut);
    const back = Number(e?.odoBack);
    if (!Number.isFinite(out) || !Number.isFinite(back)) return acc; // відкритий (ще не повернулась) або зламаний -> ігноруємо
    return acc + Math.max(0, back - out);
  }, 0);
}

/**
 * Зіставлення ПІБ між аркушами КОРИСТУВАЧІ й ПРАЦІВНИКИ: спільного id немає,
 * тож імʼя -- єдиний мостик. Прощаємо регістр, подвійні пробіли і три
 * різні апострофи, якими в українському тексті пишуть те саме.
 */
export function normalizeName(v: string): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[’ʼ'`]/g, "ʼ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Зводить списки обʼєктів усіх поїздок дня в один: той самий обʼєкт у
 * кількох поїздках отримує СУМУ обсягів своїх робіт і ЗЧЕПЛЕНІ сесії, щоб
 * години й обсяги за два окремі виїзди додавались, а не затирали одне одного
 * -- reports/timesheet/day-status ключуються по дата+обʼєкт(+робота/людина) і
 * про «поїздку» не знають нічого, тож що дасть це злиття, те й запишеться.
 *
 * Звідси й ціна задвоєної поїздки: це не зайва картка, а подвоєні гроші. */
export function mergeObjects(objectsByLeg: ObjectInput[][]): ObjectInput[] {
  const byObjectId = new Map<string, ObjectInput>();
  for (const objects of objectsByLeg) {
    for (const obj of objects) {
      const existing = byObjectId.get(obj.objectId);
      if (!existing) {
        byObjectId.set(obj.objectId, {
          objectId: obj.objectId,
          objectName: obj.objectName,
          works: (obj.works ?? []).map((w) => ({ ...w })),
          sessions: [...(obj.sessions ?? [])],
          coefs: [...(obj.coefs ?? [])],
          notes: obj.notes,
          photoUrls: obj.photoUrls ? [...obj.photoUrls] : [],
        });
        continue;
      }
      for (const w of obj.works ?? []) {
        const existingWork = existing.works.find((ew) => ew.workId === w.workId);
        if (!existingWork) {
          existing.works.push({ ...w });
          continue;
        }
        const a = Number(existingWork.volume);
        const b = Number(w.volume);
        if (Number.isFinite(a) && Number.isFinite(b)) existingWork.volume = a + b;
        else if (Number.isFinite(b)) existingWork.volume = b;
        // Та сама робота в кількох поїздках -- зливаємо і список закріплених
        // людей, а не лишаємо перший: інакше buildAccountingRows (він тягне
        // оплату роботи по employeeIds) звалився б на спільний поділ для
        // того, хто робив цю роботу лише в другій поїздці.
        if (w.employeeIds?.length) {
          existingWork.employeeIds = [...new Set([...(existingWork.employeeIds ?? []), ...w.employeeIds])];
        }
      }
      existing.sessions = [...existing.sessions, ...(obj.sessions ?? [])];
      if (obj.coefs?.length) {
        const coefByEmployee = new Map((existing.coefs ?? []).map((c) => [c.employeeId, c]));
        for (const c of obj.coefs) coefByEmployee.set(c.employeeId, c);
        existing.coefs = [...coefByEmployee.values()];
      }
    }
  }
  return [...byObjectId.values()];
}
