// Години дня. Години вирішують і ХТО потрапляє в поділ 70%, і СКІЛЬКИ він
// отримає, тож помилка тут — це помилка в зарплаті, і бачить її бригадир
// увечері, а не ми.
//
// Кожен тест нижче — реальний випадок з поля, а не вигаданий крайній.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hoursAtObject,
  crewWindowAt,
  stopFinishedWorks,
  withManualHours,
  type Session,
} from "../src/lib/dayHours.js";

const at = (hhmm: string) => `2026-09-14T${hhmm}:00.000Z`;
const ms = (hhmm: string) => new Date(at(hhmm)).getTime();

test("години: закрита сесія рахується від старту до кінця", () => {
  const plan = { sessions: [{ employeeId: "e1", startedAt: at("08:00"), endedAt: at("16:30") }] };
  assert.equal(hoursAtObject(plan, "e1", ms("20:00")), 8.5);
});

test("години: кілька сесій за день складаються", () => {
  const plan = {
    sessions: [
      { employeeId: "e1", startedAt: at("08:00"), endedAt: at("12:00") },
      { employeeId: "e1", startedAt: at("13:00"), endedAt: at("17:00") },
      { employeeId: "e2", startedAt: at("08:00"), endedAt: at("17:00") },
    ],
  };
  assert.equal(hoursAtObject(plan, "e1", ms("20:00")), 8);
  assert.equal(hoursAtObject(plan, "e2", ms("20:00")), 9);
});

test("години: ВІДКРИТА сесія рахується до «зараз» — саме через це звіт заблокований", () => {
  // Сервер рахує незакриту сесію до моменту запиту, тож звіт о 17:30
  // обрізав би людину, яка працює до 19:00. Тут та сама арифметика.
  const plan = { sessions: [{ employeeId: "e1", startedAt: at("08:00") }] };
  assert.equal(hoursAtObject(plan, "e1", ms("17:30")), 9.5);
  assert.equal(hoursAtObject(plan, "e1", ms("19:00")), 11);
});

test("години: людини без сесій на обʼєкті — нуль, а не NaN", () => {
  assert.equal(hoursAtObject({ sessions: [] }, "e1", ms("12:00")), 0);
});

test("вікно бригади: найраніший старт серед ВІДКРИТИХ сесій", () => {
  // Бригадир запускав людей поодинці — новачок отримує найраніший старт.
  const plan = {
    sessions: [
      { employeeId: "e1", startedAt: at("08:00") },
      { employeeId: "e2", startedAt: at("08:10") },
      { employeeId: "e3", startedAt: at("08:20") },
    ],
  };
  assert.deepEqual(crewWindowAt(plan, ["new"]), { startedAt: at("08:00") });
});

test("вікно бригади: закрита сесія НЕ тягне початок новачка на час, коли нікого не було", () => {
  // Людина відпрацювала 06:00–07:00 і поїхала. Якби брали всі сесії поспіль,
  // новачок отримав би 06:00 — годину, коли на обʼєкті ще нікого не було.
  const plan = {
    sessions: [
      { employeeId: "early", startedAt: at("06:00"), endedAt: at("07:00") },
      { employeeId: "e1", startedAt: at("09:00") },
    ],
  };
  assert.deepEqual(crewWindowAt(plan, ["new"]), { startedAt: at("09:00") });
});

test("вікно бригади: коли не працює вже ніхто — повний проміжок обʼєкта", () => {
  // Це режим правки зданого дня: відкритих сесій там не буває.
  const plan = {
    sessions: [
      { employeeId: "e1", startedAt: at("08:00"), endedAt: at("16:00") },
      { employeeId: "e2", startedAt: at("09:00"), endedAt: at("17:00") },
    ],
  };
  assert.deepEqual(crewWindowAt(plan, ["new"]), { startedAt: at("08:00"), endedAt: at("17:00") });
});

test("вікно бригади: порожній обʼєкт не дає вікна — тоді питання про час не ставиться", () => {
  assert.equal(crewWindowAt({ sessions: [] }, ["new"]), null);
});

test("вікно бригади: тих, кого додаємо, з розрахунку виключено", () => {
  // Інакше людина, яку додають повторно, задавала б вікно сама собі.
  const plan = { sessions: [{ employeeId: "e1", startedAt: at("08:00") }] };
  assert.equal(crewWindowAt(plan, ["e1"]), null);
});

test("таймер роботи: бригадна йде, поки в зміні хоч хтось", () => {
  const sessions: Session[] = [
    { employeeId: "e1", startedAt: at("08:00"), endedAt: at("12:00") },
    { employeeId: "e2", startedAt: at("08:00") },
  ];
  const works = [{ workId: "w1", workStartedAt: at("08:00"), workAccumulatedMs: 0 }];
  assert.equal(stopFinishedWorks(works, sessions, ms("13:00"))[0].workStartedAt, at("08:00"));
});

test("таймер роботи: закріплена гасне, коли пішла ЇЇ людина, хоч інші працюють", () => {
  // Раніше зупинка була одна на весь обʼєкт («не лишилось нікого»), тож
  // робота людини, яка пішла, годинами показувала «йде».
  const sessions: Session[] = [
    { employeeId: "e1", startedAt: at("08:00"), endedAt: at("12:00") },
    { employeeId: "e2", startedAt: at("08:00") },
  ];
  const works = [{ workId: "w1", employeeIds: ["e1"], workStartedAt: at("08:00"), workAccumulatedMs: 0 }];
  const [w] = stopFinishedWorks(works, sessions, ms("13:00"));
  assert.equal(w.workStartedAt, null);
  assert.equal(w.workAccumulatedMs, 5 * 3_600_000); // 08:00 -> 13:00
});

test("таймер роботи: незапущену не чіпаємо", () => {
  const works = [{ workId: "w1", workStartedAt: null, workAccumulatedMs: 0 }];
  assert.deepEqual(stopFinishedWorks(works, [], ms("13:00")), works);
});

test("ручні години: 4.5 год замінюють помилковий «<1 хв»", () => {
  // Той самий випадок, що 14.09 на «Складі»: таймер дав секунди, бригадир
  // вписує 4.5 год. Сесія мусить стати рівно 4.5 год і бути ЗАКРИТОЮ —
  // відкрита заблокувала б відправку звіту.
  const before: Session[] = [{ employeeId: "e1", startedAt: at("21:59"), endedAt: at("22:00") }];
  const after = withManualHours(before, "e1", 4.5, ms("22:04"));
  assert.equal(after.length, 1);
  assert.equal(hoursAtObject({ sessions: after }, "e1", ms("22:04")), 4.5);
  assert.ok(after[0].endedAt, "сесія мусить бути закрита");
});

test("ручні години: чужі сесії лишаються недоторканими", () => {
  const before: Session[] = [
    { employeeId: "e1", startedAt: at("08:00"), endedAt: at("09:00") },
    { employeeId: "e2", startedAt: at("08:00"), endedAt: at("17:00") },
  ];
  const after = withManualHours(before, "e1", 6, ms("18:00"));
  assert.equal(hoursAtObject({ sessions: after }, "e1", ms("18:00")), 6);
  assert.equal(hoursAtObject({ sessions: after }, "e2", ms("18:00")), 9);
});

test("ручні години: нуль прибирає час людини тут узагалі", () => {
  // Єдиний спосіб стерти помилкову сесію, тож нуль — це дія, а не помилка.
  const before: Session[] = [{ employeeId: "e1", startedAt: at("08:00"), endedAt: at("17:00") }];
  assert.deepEqual(withManualHours(before, "e1", 0, ms("18:00")), []);
});

test("ручні години: відʼємне значення трактується як нуль, а не як майбутня сесія", () => {
  const before: Session[] = [{ employeeId: "e1", startedAt: at("08:00"), endedAt: at("17:00") }];
  assert.deepEqual(withManualHours(before, "e1", -3, ms("18:00")), []);
});
