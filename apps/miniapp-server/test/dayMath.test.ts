// Арифметика дня на сервері: злиття поїздок і км роз'їздів.
//
// reports / timesheet_entries / allowances не мають виміру «поїздка» — туди
// пишеться те, що дало mergeObjects. Тому все, що ця функція складе, і є
// зарплатою; 08.09 вона склала один обʼєкт двічі й дала по 15.91 год замість
// 7.96. Тести нижче пришпилюють саме це.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeObjects, sumErrandKm, normalizeName, type ObjectInput } from "../src/lib/dayMath.js";

const session = (employeeId: string, from: string, to?: string) => ({
  employeeId,
  employeeName: employeeId,
  droppedAt: `2026-09-08T${from}:00.000Z`,
  pickedUpAt: to ? `2026-09-08T${to}:00.000Z` : undefined,
});

const obj = (over: Partial<ObjectInput> = {}): ObjectInput => ({
  objectId: "o1",
  objectName: "Рікка",
  works: [{ workId: "w1", workName: "Стрижка газону", volume: 10 }],
  sessions: [session("e1", "08:00", "12:00")],
  ...over,
});

test("злиття: одна поїздка проходить наскрізь без змін у числах", () => {
  const [merged] = mergeObjects([[obj()]]);
  assert.equal(merged.works[0].volume, 10);
  assert.equal(merged.sessions.length, 1);
});

test("злиття: ТОЙ САМИЙ обʼєкт у двох поїздках складає і обсяги, і сесії", () => {
  // Це не «зайва картка», а подвоєні гроші: обсяг × тариф дає подвійний
  // фонд, а зчеплені сесії — подвійні години. Рівно це сталось 08.09.
  const [merged] = mergeObjects([[obj()], [obj({ sessions: [session("e1", "13:00", "17:00")] })]]);
  assert.equal(merged.works.length, 1, "робота не мусить задвоїтись рядком");
  assert.equal(merged.works[0].volume, 20, "обсяг складається");
  assert.equal(merged.sessions.length, 2, "сесії зчіплюються");
});

test("злиття: різні обʼєкти лишаються різними", () => {
  const merged = mergeObjects([[obj()], [obj({ objectId: "o2", objectName: "Косино" })]]);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((m) => m.objectId),
    ["o1", "o2"],
  );
});

test("злиття: різні роботи на одному обʼєкті додаються рядками", () => {
  const [merged] = mergeObjects([
    [obj()],
    [obj({ works: [{ workId: "w2", workName: "Прополка", volume: 3 }] })],
  ]);
  assert.equal(merged.works.length, 2);
  assert.equal(merged.works.find((w) => w.workId === "w1")?.volume, 10);
  assert.equal(merged.works.find((w) => w.workId === "w2")?.volume, 3);
});

test("злиття: закріплені люди обʼєднуються, а не лишається список першої поїздки", () => {
  // Інакше buildAccountingRows (він тягне оплату роботи по employeeIds) звалився
  // б на спільний поділ для того, хто робив цю роботу лише в другій поїздці.
  const [merged] = mergeObjects([
    [obj({ works: [{ workId: "w1", workName: "Стрижка газону", volume: 5, employeeIds: ["e1"] }] })],
    [obj({ works: [{ workId: "w1", workName: "Стрижка газону", volume: 5, employeeIds: ["e2"] }] })],
  ]);
  assert.deepEqual(merged.works[0].employeeIds?.sort(), ["e1", "e2"]);
});

test("злиття: обсяг «?» (не введений) не робить з числа NaN", () => {
  // На екрані обсягів незаповнена робота — це порожньо, і воно доїжджає сюди.
  const [merged] = mergeObjects([
    [obj({ works: [{ workId: "w1", workName: "Стрижка газону", volume: "" }] })],
    [obj({ works: [{ workId: "w1", workName: "Стрижка газону", volume: 7 }] })],
  ]);
  assert.equal(merged.works[0].volume, 7);
});

test("злиття: коефіцієнти другої поїздки перекривають першу, а не дублюються", () => {
  const [merged] = mergeObjects([
    [obj({ coefs: [{ employeeId: "e1", disciplineCoef: 0.9 }] })],
    [obj({ coefs: [{ employeeId: "e1", disciplineCoef: 1.2 }] })],
  ]);
  assert.equal(merged.coefs?.length, 1);
  assert.equal(merged.coefs?.[0].disciplineCoef, 1.2);
});

test("злиття: вхід не мутується — виклик двічі дає те саме", () => {
  const legs = [[obj()], [obj()]];
  const first = mergeObjects(legs)[0].works[0].volume;
  const second = mergeObjects(legs)[0].works[0].volume;
  assert.equal(first, second, "mergeObjects не має правити свій аргумент");
});

test("роз'їзди: сума закритих, відкритий ігнорується", () => {
  // Відкритий роз'їзд (машина ще не повернулась) не має чим рахуватись, і
  // вгадувати тут нельзя: помилка піде в клас поїздки, тобто в доплату.
  assert.equal(
    sumErrandKm([
      { odoOut: 1000, odoBack: 1015 },
      { odoOut: 1020, odoBack: 1030 },
      { odoOut: 1040, odoBack: null },
    ]),
    25,
  );
});

test("роз'їзди: рух назад по одометру не віднімає км", () => {
  assert.equal(sumErrandKm([{ odoOut: 1015, odoBack: 1000 }]), 0);
});

test("роз'їзди: немає роз'їздів — нуль", () => {
  assert.equal(sumErrandKm([]), 0);
  assert.equal(sumErrandKm(undefined), 0);
});

test("ПІБ: регістр, подвійні пробіли і три різні апострофи — це те саме імʼя", () => {
  // Єдиний мостик між КОРИСТУВАЧІ й ПРАЦІВНИКИ. Не зійшлось — 20% лишаються
  // фірмі, тобто бригадир мовчки не отримує своє.
  const target = normalizeName("Дубʼяк Василь Михайлович");
  assert.equal(normalizeName("ДУБʼЯК  ВАСИЛЬ МИХАЙЛОВИЧ"), target);
  assert.equal(normalizeName("Дуб'як Василь Михайлович"), target);
  assert.equal(normalizeName("Дуб’як Василь Михайлович"), target);
  assert.equal(normalizeName("  Дубʼяк Василь Михайлович  "), target);
});

test("ПІБ: різні люди не зливаються", () => {
  assert.notEqual(normalizeName("Дуб Василь"), normalizeName("Дуб Василина"));
});
