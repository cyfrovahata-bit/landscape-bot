// БУХЗВІТ — форма рядків, які бачить бухгалтер.
//
// Ламається це мовчки: колонки позиційні, тож зсув на один стовпець не дає
// жодної помилки — просто звіт стає неправильним, і старі рядки лишаються
// зі старим порядком. Тому порядок колонок і форма кожного «службового»
// рядка (години, доплата за виїзд) пришпилені тут.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccountingRows, formatRoadKm, splitMoneyByShares, ACCOUNTING_HEADERS } from "../src/accountingRows.js";

const base = {
  date: "2026-09-14",
  foremanName: "Дуб Василь Михайлович",
  objects: [
    {
      objectId: "o1",
      objectName: "Рікка",
      works: [{ workId: "w1", workName: "Стрижка газону", volume: 10 }],
    },
  ],
  salaryPacks: [
    { objectId: "o1", objectName: "Рікка", rows: [{ employeeId: "e1", employeeName: "Іванов І.", pay: 700 }] },
  ],
  roadAllowancePerPerson: 0,
  unionEmployeeIds: ["e1"],
  employeeNameById: new Map([["e1", "Іванов І."], ["e2", "Петров П."]]),
  tariffByWorkId: new Map([["w1", 100]]),
  unitByWorkId: new Map([["w1", "м²"]]),
};

const rowsOf = (over: Partial<Parameters<typeof buildAccountingRows>[0]> = {}) =>
  buildAccountingRows({ ...base, ...over });

test("порядок колонок незмінний і рівно 8 — нову можна додавати ЛИШЕ В КІНЕЦЬ", () => {
  // Вставлена посередині зсуває кожен наступний стовпець, а старі рядки в
  // аркуші лишаються зі старим порядком.
  assert.deepEqual(
    [...ACCOUNTING_HEADERS],
    ["№", "Дата", "Працівник", "Об'єкт", "Роботи", "Обсяг робіт", "Нарахування", "Примітки"],
  );
});

test("грошовий рядок: людина × робота, з одиницею виміру в обсязі", () => {
  const rows = rowsOf();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    date: "2026-09-14",
    employeeName: "Іванов І.",
    objectName: "Рікка",
    workName: "Стрижка газону",
    volume: "10 м²",
    amount: 700,
    foremanName: "Дуб Василь Михайлович",
  });
});

test("нульова оплата в БУХЗВІТ не пишеться", () => {
  const rows = rowsOf({
    salaryPacks: [{ objectId: "o1", objectName: "Рікка", rows: [{ employeeId: "e1", employeeName: "Іванов І.", pay: 0 }] }],
  });
  assert.deepEqual(rows, []);
});

test("рядки людини сумуються ТОЧНО в її оплату (до копійки)", () => {
  // Звіт, який не сходиться до копійки, бухгалтеру віддавати не можна.
  const rows = buildAccountingRows({
    ...base,
    objects: [
      {
        objectId: "o1",
        objectName: "Рікка",
        works: [
          { workId: "w1", workName: "A", volume: 1 },
          { workId: "w2", workName: "B", volume: 1 },
          { workId: "w3", workName: "C", volume: 1 },
        ],
      },
    ],
    salaryPacks: [{ objectId: "o1", objectName: "Рікка", rows: [{ employeeId: "e1", employeeName: "Іванов І.", pay: 100 }] }],
    tariffByWorkId: new Map([["w1", 1], ["w2", 1], ["w3", 1]]),
    unitByWorkId: new Map(),
  });
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  assert.equal(sum, 100, "три рівні частки від 100 мусять зійтись, а не дати 99.99");
});

test("закріплена робота: оплата людини йде лише в її роботи", () => {
  const rows = buildAccountingRows({
    ...base,
    objects: [
      {
        objectId: "o1",
        objectName: "Рікка",
        works: [
          { workId: "w1", workName: "Стрижка газону", volume: 10, employeeIds: ["e1"] },
          { workId: "w2", workName: "Прополка", volume: 10, employeeIds: ["e2"] },
        ],
      },
    ],
    tariffByWorkId: new Map([["w1", 100], ["w2", 100]]),
  });
  assert.deepEqual(rows.map((r) => r.workName), ["Стрижка газону"]);
});

test("години: окремий РЯДОК на людину за день, обсяг — число без одиниці", () => {
  // Колонкою їх зробити не можна: рядок = людина × робота, тож число
  // повторилось би стільки разів, скільки в людини робіт.
  const rows = rowsOf({
    hoursByObject: new Map([
      ["o1", new Map([["e1", 4.5]])],
      ["o2", new Map([["e1", 3.4567]])],
    ]),
  });
  const hours = rows.filter((r) => r.workName === "Відпрацьовано годин");
  assert.equal(hours.length, 1, "один рядок на ДЕНЬ, а не на обʼєкт");
  assert.equal(hours[0].employeeName, "Іванов І.");
  assert.equal(hours[0].objectName, "—");
  assert.equal(hours[0].volume, "7.96", "число без «год», інакше колонка не сумується");
  assert.equal(hours[0].amount, 0);
  assert.ok(!Number.isNaN(Number(hours[0].volume)), "обсяг мусить бути числом");
});

test("години: той, хто не дотягнув до MIN_PAID_HOURS, у звіті все одно є", () => {
  // У грошових рядках його немає (0 грн не пишеться), і цей рядок — єдине
  // місце, де видно його реальні хвилини, тобто помилку в годинах.
  const rows = rowsOf({
    salaryPacks: [{ objectId: "o1", objectName: "Рікка", rows: [{ employeeId: "e1", employeeName: "Іванов І.", pay: 700 }] }],
    hoursByObject: new Map([["o1", new Map([["e1", 8], ["e2", 0.05]])]]),
  });
  const hours = rows.filter((r) => r.workName === "Відпрацьовано годин");
  assert.deepEqual(hours.map((r) => r.employeeName).sort(), ["Іванов І.", "Петров П."]);
  assert.equal(hours.find((r) => r.employeeName === "Петров П.")?.volume, "0.05");
});

test("доплата за виїзд: рядок пишеться навіть при НУЛЬОВІЙ сумі, якщо є км/клас", () => {
  // Поки тарифи класів у НАЛАШТУВАННЯХ стоять 0, «доплату не нарахували»
  // не має виглядати як «день не експортувався».
  const rows = rowsOf({ roadAllowancePerPerson: 0, roadKm: 190, roadTripClass: "L" });
  const allowance = rows.filter((r) => r.workName === "Доплата за виїзд");
  assert.equal(allowance.length, 1);
  assert.equal(allowance[0].amount, 0);
  assert.equal(allowance[0].volume, "190 км · клас L");
});

test("доплата за виїзд: без км і без класу рядка немає", () => {
  const rows = rowsOf({ roadAllowancePerPerson: 0 });
  assert.equal(rows.filter((r) => r.workName === "Доплата за виїзд").length, 0);
});

test("доплата за виїзд: назва роботи незмінна — по ній фільтрує бухгалтер", () => {
  // Клас іде в «Обсяг робіт», а не в «Роботи»: назва, що міняється від дня
  // до дня, ламає фільтр.
  const rows = rowsOf({ roadAllowancePerPerson: 250, roadKm: 190, roadTripClass: "L" });
  const allowance = rows.find((r) => r.workName === "Доплата за виїзд");
  assert.equal(allowance?.workName, "Доплата за виїзд");
  assert.ok(!allowance?.workName.includes("L"), "клас не має потрапляти в назву");
});

test("формат км: роз'їзди показують ОБИДВА числа", () => {
  // Платять за меншу, і бухгалтеру треба бачити, чому вона не збігається
  // з одометром.
  assert.equal(formatRoadKm(190, 165, "L"), "165 км · клас L (проїхали 190, роз'їзди −25)");
});

test("формат км: без роз'їздів — одна цифра", () => {
  assert.equal(formatRoadKm(190, 190, "L"), "190 км · клас L");
  assert.equal(formatRoadKm(190, undefined, "L"), "190 км · клас L");
});

test("формат км: нульовий пробіг лишає тільки клас, порожнє — порожнє", () => {
  assert.equal(formatRoadKm(0, 0, "S"), "клас S");
  assert.equal(formatRoadKm(undefined, undefined, undefined), "");
});

test("splitMoneyByShares: сума часток завжди дорівнює цілому", () => {
  for (const total of [100, 0.03, 1234.56, 7]) {
    for (const shares of [[1, 1, 1], [1, 2], [0, 5], [3, 3, 3, 3, 3, 3, 3]]) {
      const parts = splitMoneyByShares(total, shares);
      const sum = Math.round(parts.reduce((a, v) => a + v, 0) * 100) / 100;
      assert.equal(sum, Math.round(total * 100) / 100, `${total} / ${shares}`);
    }
  }
});
