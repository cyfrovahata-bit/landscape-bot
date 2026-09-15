/**
 * БУХЗВІТ — форма рядків. Чиста частина, без Google і без БД.
 *
 * Винесено з `accounting.ts` саме тому, що той файл при імпорті тягне
 * `google/sheets.js` і `db.js`, тобто вимагає env — і перевірити форму
 * рядків, яку читає бухгалтер, було нічим. А ламається вона мовчки:
 * колонки позиційні, тож зсув на один стовпець не дає жодної помилки,
 * просто звіт стає неправильним.
 *
 * Покрито: `packages/core/test/accountingRows.test.ts`.
 */

// Порядок КОЛОНОК тут позиційний, а не по заголовках: appendAccountingReportRows
// складає масив значень і кладе його в A:Z. Тому нову колонку можна додавати
// ЛИШЕ В КІНЕЦЬ -- вставлена посередині зсунула б кожен наступний стовпець,
// а старі рядки в аркуші лишились би зі старим порядком. Саме тому години
// приходять окремим РЯДКОМ, а не дев'ятою колонкою.
export const ACCOUNTING_HEADERS = ["№", "Дата", "Працівник", "Об'єкт", "Роботи", "Обсяг робіт", "Нарахування", "Примітки"] as const;

export function money(n: number) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Splits `total` (money) across `shares` (proportions, need not sum to 1) so
 * the results sum EXACTLY to money(total) in kopecks -- largest-remainder
 * apportionment, not independent per-item rounding. Independently rounding
 * each share (money(total * share)) can over- or under-shoot the true total
 * once several shares round in the same direction, and letting "the last
 * item absorb the rest" breaks the moment that drift goes negative (the
 * last item would need a negative amount, which gets silently dropped
 * instead of subtracted -- the earlier, already-pushed rows then sum to
 * MORE than `total`). This never produces a negative remainder: every
 * item's cents are >= its floor, and only whole leftover cents (which by
 * construction can't exceed the number of items) get redistributed.
 */
export function splitMoneyByShares(total: number, shares: number[]): number[] {
  const totalCents = Math.round(total * 100);
  if (!shares.length || totalCents <= 0) return shares.map(() => 0);
  const shareSum = shares.reduce((a, s) => a + s, 0);
  const raw = shares.map((s) => (shareSum > 0 ? (totalCents * s) / shareSum : totalCents / shares.length));
  const floors = raw.map((c) => Math.floor(c));
  let leftover = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((c, i) => ({ i, frac: c - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const cents = [...floors];
  for (let k = 0; k < order.length && leftover > 0; k++, leftover--) {
    cents[order[k].i] += 1;
  }
  return cents.map((c) => c / 100);
}

/**
 * Обсяг для рядка «Доплата за виїзд»: скільки проїхали, скільки з того
 * оплачувано і який це клас. Роз'їзди («машина вибула по справам») не входять
 * у клас поїздки, тож саме на цю різницю сума й не схожа на одометр.
 *
 * Клас іде сюди, а не в колонку «Роботи»: там назва має лишатись рівно
 * «Доплата за виїзд», бо бухгалтер фільтрує звіт саме по ній, а назва, що
 * міняється від дня до дня, такий фільтр ламає. Формат той самий, що бачить
 * бригадир у застосунку (`190 км · клас M`) — одна цифра не має виглядати
 * двома різними способами в двох місцях.
 */
export function formatRoadKm(km?: number, billableKm?: number, tripClass?: string): string {
  const parts: string[] = [];
  const total = Number.isFinite(km as number) ? Math.round(Number(km)) : null;
  if (total !== null && total > 0) {
    const billable = Number.isFinite(billableKm as number) ? Math.round(Number(billableKm)) : total;
    const excluded = total - billable;
    parts.push(excluded > 0 ? `${billable} км` : `${total} км`);
    if (tripClass) parts.push(`клас ${tripClass}`);
    // Хвіст про роз'їзди — після класу: клас порахований саме з оплачуваних км.
    return excluded > 0
      ? `${parts.join(" · ")} (проїхали ${total}, роз'їзди −${excluded})`
      : parts.join(" · ");
  }
  return tripClass ? `клас ${tripClass}` : "";
}

export type AccountingWork = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
export type AccountingObject = { objectId: string; objectName: string; works: AccountingWork[] };
export type AccountingSalaryRow = { employeeId: string; employeeName: string; pay: number };
export type AccountingSalaryPack = { objectId: string; objectName: string; rows: AccountingSalaryRow[] };
export type AccountingRow = {
  date: string;
  employeeName: string;
  objectName: string;
  workName: string;
  volume: string;
  amount: number;
  foremanName: string;
};

/**
 * Splits each employee's already-computed per-object pay (role/coefficient
 * aware -- see buildSalaryPacksWithRoles) across the specific works they're
 * tagged on at that object (WorkInput.employeeIds), weighted by each work's
 * own money value (volume * tariff). Falls back to splitting across every
 * work at the object if the employee isn't tagged on any specific one, so
 * nobody's pay silently disappears from the report. Uses largest-remainder
 * apportionment (splitMoneyByShares) so a person's rows always sum to
 * EXACTLY the pay figure they're shown in the app -- a bookkeeping report
 * that doesn't tie out to the kopeck isn't fit to hand to an accountant.
 */
export function buildAccountingRows(params: {
  date: string;
  // Whoever submitted/filled this report -- written into the "Примітки"
  // column so the accountant knows which brigadier's numbers each row is.
  foremanName: string;
  objects: AccountingObject[];
  salaryPacks: AccountingSalaryPack[];
  roadAllowancePerPerson: number;
  /** Пробіг дня за одометром і та його частина, з якої рахувалась доплата
   *  (різниця — роз'їзди). Обидва необов'язкові: без них рядок доплати
   *  виглядає як раніше, з порожнім обсягом. */
  roadKm?: number;
  roadBillableKm?: number;
  /** Клас поїздки (S/M/L/XL) — те, з чого й береться сума доплати. */
  roadTripClass?: string;
  unionEmployeeIds: string[];
  employeeNameById: Map<string, string>;
  tariffByWorkId: Map<string, number>;
  unitByWorkId: Map<string, string>;
  /** Години на обʼєкті: objectId -> employeeId -> годин. З того самого
   *  computePayroll, що дав суми, щоб години й гроші не розходились. */
  hoursByObject?: Map<string, Map<string, number>>;
}): AccountingRow[] {
  const { date, foremanName, objects, salaryPacks, roadAllowancePerPerson, roadKm, roadBillableKm, roadTripClass, unionEmployeeIds, employeeNameById, tariffByWorkId, unitByWorkId, hoursByObject } = params;
  const objectsById = new Map(objects.map((o) => [o.objectId, o]));
  const out: AccountingRow[] = [];

  const workValue = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const tariff = tariffByWorkId.get(w.workId) ?? 0;
    return (Number.isFinite(vol) ? vol : 0) * tariff;
  };
  const formatVolume = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const unit = unitByWorkId.get(w.workId) ?? "";
    return [Number.isFinite(vol) ? vol : w.volume, unit].filter((x) => x !== undefined && x !== "").join(" ");
  };

  for (const pack of salaryPacks) {
    const obj = objectsById.get(pack.objectId);
    const works = obj?.works ?? [];
    if (!works.length) continue;

    for (const row of pack.rows) {
      if (!(row.pay > 0)) continue;

      const tagged = works.filter((w) => (w.employeeIds ?? []).includes(row.employeeId));
      const pool = tagged.length ? tagged : works;
      const values = pool.map(workValue);
      const totalValue = values.reduce((a, v) => a + v, 0);
      const shares = totalValue > 0 ? values : pool.map(() => 1);
      const amounts = splitMoneyByShares(row.pay, shares);

      pool.forEach((w, i) => {
        const amount = amounts[i];
        if (amount <= 0) return;
        out.push({
          date,
          employeeName: row.employeeName,
          objectName: pack.objectName,
          workName: w.workName,
          volume: formatVolume(w),
          amount,
          foremanName,
        });
      });
    }
  }

  // Кілометри й клас у колонці «Обсяг робіт»: для рядка доплати обсяг — це і є
  // пробіг, і без нього сума ні з чого не виводиться.
  //
  // Коли були роз'їзди, показуємо ОБИДВА числа: платять за меншу цифру, а
  // бухгалтеру ще й треба бачити, чому вона менша за одометр. Одна цифра
  // тут щоразу виглядала б як помилка — байдуже, яку з двох поставити.
  const volume = formatRoadKm(roadKm, roadBillableKm, roadTripClass);
  // Рядок пишеться і при НУЛЬОВІЙ доплаті: поки тарифи класів у НАЛАШТУВАННЯХ
  // стоять 0, звіт мовчки не мав жодного сліду виїзду — ні кілометрів, ні
  // класу, і «доплату не нарахували» було не відрізнити від «день не
  // експортувався». Нуль у грошах — це теж результат, і його видно.
  // Умова тепер на ЗМІСТ, а не на суму: якщо ні пробігу, ні класу немає,
  // показувати нічого й рядок не з'являється.
  // Години -- окремим рядком на людину за день, тим самим прийомом, що й
  // доплата за виїзд. Колонкою їх зробити не можна: колонки тут позиційні, а
  // рядок = людина × робота, тож те саме число повторилось би стільки разів,
  // скільки в людини робіт, і будь-яка сума по колонці була б неправильною.
  //
  // Один рядок на ДЕНЬ, а не на обʼєкт: бухгалтеру години потрібні для табеля,
  // тобто «скільки людина відпрацювала». Розбивка по обʼєктах уже є вище, у
  // рядках робіт.
  //
  // Годин може не бути в грошових рядках зовсім: людина, що не дотягла до
  // MIN_PAID_HOURS, отримує 0 грн і в БУХЗВІТ не потрапляє. Тут вона
  // зʼявиться зі своїми реальними хвилинами -- саме так помилку й видно.
  if (hoursByObject?.size) {
    const totalByEmployee = new Map<string, number>();
    for (const byEmployee of hoursByObject.values()) {
      for (const [employeeId, hours] of byEmployee) {
        if (!(hours > 0)) continue;
        totalByEmployee.set(employeeId, (totalByEmployee.get(employeeId) ?? 0) + hours);
      }
    }
    for (const [employeeId, hours] of totalByEmployee) {
      out.push({
        date,
        employeeName: employeeNameById.get(employeeId) ?? employeeId,
        objectName: "—",
        workName: "Відпрацьовано годин",
        // Число, а не «7.96 год»: відфільтрувавши колонку «Роботи» по цій
        // назві, бухгалтер має змогу просто просумувати обсяг. Текст із
        // одиницею читався б краще і не сумувався б зовсім.
        volume: String(Math.round(hours * 100) / 100),
        amount: 0,
        foremanName,
      });
    }
  }

  if (roadAllowancePerPerson > 0 || volume) {
    for (const empId of unionEmployeeIds) {
      out.push({
        date,
        employeeName: employeeNameById.get(empId) ?? empId,
        objectName: "—",
        workName: "Доплата за виїзд",
        volume,
        amount: money(roadAllowancePerPerson),
        foremanName,
      });
    }
  }

  return out;
}
