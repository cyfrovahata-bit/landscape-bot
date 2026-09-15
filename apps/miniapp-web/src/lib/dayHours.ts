/**
 * Години дня — чиста частина.
 *
 * Це найдорожча логіка в застосунку: години вирішують і хто потрапляє в
 * поділ 70%, і скільки він отримає (частка пропорційна годинам). Досі вона
 * жила закритою всередині `RoadTimesheet.tsx` — функції нічого не брали з
 * стану компонента, але й перевірити їх було нічим, тож кожна правда про
 * них зʼясовувалась на живому дні бригадира.
 *
 * Типи тут — структурні й мінімальні: беруть рівно ті поля, які читають, щоб
 * багатші типи табеля підходили самі, без приведення.
 *
 * Покрито: `apps/miniapp-web/test/dayHours.test.ts`.
 */

export type Session = { employeeId: string; startedAt: string; endedAt?: string };

export type WorkTimer = {
  employeeIds?: string[];
  workStartedAt?: string | null;
  workAccumulatedMs?: number;
};

export type HoursPlan = { sessions: Session[] };

/**
 * Скільки людина відпрацювала на обʼєкті: сума всіх її сесій, відкрита
 * рахується до `nowMs`. Саме це число payroll ділить пропорційно.
 *
 * `nowMs` — параметр, а не `Date.now()` всередині: інакше функцію не
 * перевірити, а «майже правильні» години тут і є помилкою в грошах.
 */
export function hoursAtObject(plan: HoursPlan, employeeId: string, nowMs: number = Date.now()): number {
  const ms = plan.sessions
    .filter((s) => s.employeeId === employeeId)
    .reduce(
      (a, s) =>
        a + Math.max(0, (s.endedAt ? new Date(s.endedAt).getTime() : nowMs) - new Date(s.startedAt).getTime()),
      0,
    );
  return Math.round((ms / 3_600_000) * 10000) / 10000;
}

/**
 * Вікно, яке отримує людина, додана в бригаду на обʼєкті вже після старту.
 *
 * Правило: беремо тих, хто працює ЗАРАЗ, і найраніший з їхніх стартів. Якщо
 * бригадир запускав людей поодинці о 08:00, 08:10 і 08:20 — новачок
 * отримає 08:00.
 *
 * Чому саме ВІДКРИТІ сесії: раніше бралися всі поспіль, включно з давно
 * закритими. Людина, яка відпрацювала з 06:00 до 07:00 і поїхала, тягнула
 * початок новачка на 06:00 — тобто на годину, коли на обʼєкті ще нікого не
 * було. Коли ж не працює вже ніхто, день тут скінчився, і новачок отримує
 * повний проміжок бригади: від найранішого старту до найпізнішого кінця.
 */
export function crewWindowAt(
  plan: HoursPlan,
  excludeIds: string[],
): { startedAt: string; endedAt?: string } | null {
  const exclude = new Set(excludeIds);
  const crew = plan.sessions.filter((s) => !exclude.has(s.employeeId));
  if (!crew.length) return null;
  const open = crew.filter((s) => !s.endedAt);
  if (open.length) {
    return { startedAt: new Date(Math.min(...open.map((s) => new Date(s.startedAt).getTime()))).toISOString() };
  }
  return {
    startedAt: new Date(Math.min(...crew.map((s) => new Date(s.startedAt).getTime()))).toISOString(),
    endedAt: new Date(Math.max(...crew.map((s) => new Date(s.endedAt as string).getTime()))).toISOString(),
  };
}

/**
 * Гасить роботи, над якими вже нікому працювати.
 *
 * Закріплена робота йде, поки хоч один з ЇЇ людей у зміні; бригадна — поки
 * в зміні хоч хтось. Раніше зупинка була одна на весь обʼєкт («не лишилось
 * нікого»), тож знята з обʼєкта людина йшла, а її персональна робота далі
 * накручувала годинник, і бейдж бадьоро показував «йде».
 *
 * Це суто екранні таймери — на сервер вони не йдуть; гроші рахуються з
 * сесій людей і з `обсяг × тариф`.
 */
export function stopFinishedWorks<T extends WorkTimer>(works: T[], sessions: Session[], atMs: number): T[] {
  const openIds = new Set(sessions.filter((s) => !s.endedAt).map((s) => s.employeeId));
  return works.map((w) => {
    if (!w.workStartedAt) return w;
    const assigned = w.employeeIds ?? [];
    const stillWorked = assigned.length ? assigned.some((id) => openIds.has(id)) : openIds.size > 0;
    if (stillWorked) return w;
    return {
      ...w,
      workStartedAt: null,
      workAccumulatedMs: (w.workAccumulatedMs ?? 0) + (atMs - new Date(w.workStartedAt).getTime()),
    };
  });
}

/**
 * Ручні години: замінює всі сесії людини на обʼєкті ОДНОЮ закритою сесією
 * рівно на `hours`. Запобіжник для «забув натиснути Почати роботи».
 *
 * `hours = 0` означає «прибрати її час тут узагалі» — інших способів стерти
 * помилкову сесію немає, тож нуль тут не помилка виклику, а дія.
 */
export function withManualHours(
  sessions: Session[],
  employeeId: string,
  hours: number,
  endMs: number = Date.now(),
): Session[] {
  const others = sessions.filter((s) => s.employeeId !== employeeId);
  if (!(hours > 0)) return others;
  const end = new Date(endMs);
  const start = new Date(endMs - hours * 3_600_000);
  return [...others, { employeeId, startedAt: start.toISOString(), endedAt: end.toISOString() }];
}
