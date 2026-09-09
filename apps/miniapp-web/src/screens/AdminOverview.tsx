import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { todayISO } from "../lib/date";
import { useTelegramBackButton, confirmDialog, haptic } from "../lib/telegram";
import { BackRow } from "../components/BackRow";
import { shortName } from "../lib/employee";

type Checkpoint = { state: string; objectName: string; at: string };
type ActiveTrip = {
  carId: string;
  carName: string;
  foremanTgId: number;
  foremanName: string;
  since: string;
  people: string[];
  /** Empty until the phone reports in -- an older build, or no signal yet. */
  timeline: Checkpoint[];
};
type SubmittedTrip = { tripSeq: number; status: string; submittedAt: string; objects: string[]; km: number };
type SubmittedDay = {
  foremanTgId: number;
  foremanName: string;
  trips: SubmittedTrip[];
  km: number;
  allApproved: boolean;
  timeline: Checkpoint[];
};
type Overview = { date: string; active: ActiveTrip[]; submitted: SubmittedDay[] };

/**
 * Незданий день, як його бачить сервер. До появи дзеркала його не було видно
 * взагалі: бригада, яка ще не відправила звіт, зникала з екрана — і з «у
 * дорозі», і зі «зданих». Саме через це один день пів дня шукали.
 */
type Draft = {
  foremanTgId: string;
  foremanName: string;
  date: string;
  step: string;
  carName: string;
  people: string[];
  objectNames: string;
  tripStartedAt: string | null;
  updatedAt: string;
};

/** Кроки табеля людською мовою: HUB нічого не каже навіть тому, хто це писав. */
const STEP_NAMES: Record<string, string> = {
  INDEX: "головна",
  HUB: "збирає поїздку",
  PICK_CAR: "вибирає авто",
  ODO_START: "вводить одометр",
  PICK_PEOPLE: "вибирає людей",
  PICK_OBJECTS: "вибирає обʼєкти",
  PLAN: "планує обʼєкт",
  PLAN_WORKS: "заповнює роботи",
  PLAN_VOLUMES: "заповнює обсяги",
  READY: "готові до виїзду",
  DRIVE: "у дорозі",
  ARRIVE_PICK: "прибуття на обʼєкт",
  AT_OBJECT: "на обʼєкті",
  RETURN_PICKUP: "забирає людей",
  RETURN: "повертається",
  REVIEW: "підсумок дня",
  DONE: "день зданий",
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

/** One checkpoint, as the admin reads it: what happened, not what state a machine is in. */
function checkpointLabel(c: Checkpoint): string {
  switch (c.state) {
    case "WORKING":
      return `🛠 почали роботи${c.objectName ? ` · ${c.objectName}` : ""}`;
    case "AT_OBJECT":
      return `📍 прибули${c.objectName ? ` · ${c.objectName}` : ""}`;
    case "RETURNING":
      return "↩️ повертаються";
    case "AT_BASE":
      return "🏁 на базі";
    default:
      return `🚗 в дорозі${c.objectName ? ` → ${c.objectName}` : ""}`;
  }
}

/**
 * What every brigade is doing today, for an admin.
 *
 * Every other screen is scoped to one foreman -- car-status and people-status
 * even hide the caller's own reservations, since their job is to warn about
 * OTHER people. So an admin could approve a finished day but had no way to see
 * a day in progress at all, short of reading the Google Sheet.
 */
export function AdminOverview({ onBack }: { onBack: () => void }) {
  const [date, setDate] = useState(() => todayISO());
  const [data, setData] = useState<Overview | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  useClearErrorOnSuccess(setError);
  const [now, setNow] = useState(Date.now());
  useTelegramBackButton(onBack);

  // The "out for" counters are the point of the screen, so they tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Overview>(`/api/road-timesheet/admin/overview?date=${date}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [date, now]);

  // Незавершені дні не привʼязані до обраної дати: питання «хто ще не здав»
  // не про календар, а про те, що прямо зараз висить.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ drafts: Draft[] }>("/api/drafts/all")
      .then((d) => !cancelled && setDrafts(d.drafts))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [now]);

  // Бригади, які вже показані як "у дорозі", у другому розділі зайві.
  const activeForemen = new Set((data?.active ?? []).map((a) => String(a.foremanTgId)));
  const pendingDrafts = drafts.filter((d) => !activeForemen.has(d.foremanTgId));

  /**
   * Прибрати чужу незавершену чернетку.
   *
   * Розділ не має власного терміну придатності: тестовий прогін і кинутий
   * день висять у ньому доти, доки хтось їх не прибере, і глушать ті, що
   * справді потребують уваги. Питаємо один раз і прямо кажемо, що саме
   * зникне -- незданий день не існує у звітності, але для бригадира це
   * робота, введена руками.
   */
  async function deleteDraft(d: Draft) {
    if (
      !(await confirmDialog(
        `Прибрати незавершений день?\n\n${d.foremanName} · ${d.date}\n\n` +
          `Зникне чернетка на його телефоні — те, що він увів і не здав. ` +
          `Здані звіти не зачіпаються.`,
      ))
    ) {
      return;
    }
    try {
      await api.del(`/api/drafts/${d.foremanTgId}`);
      setDrafts((prev) => prev.filter((x) => x.foremanTgId !== d.foremanTgId));
      haptic("success");
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    }
  }

  const shiftDay = (delta: number) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setData(null);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <div>
      <BackRow onBack={onBack} onHome={onBack} />
      <div className="header">
        <h1>🚚 Поточні поїздки</h1>
        <div className="hint">Що зараз роблять бригади</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}

      <div className="list">
        <div className="cell" style={{ cursor: "default" }}>
          <button className="back-btn" onClick={() => shiftDay(-1)}>‹ попередній</button>
          <span className="cell-title">{date}</span>
          <button className="back-btn" onClick={() => shiftDay(1)} disabled={date >= todayISO()}>
            наступний ›
          </button>
        </div>
      </div>

      {!data && !error && <div className="empty-state">Завантаження…</div>}

      {data && (
        <>
          <div className="section-title">У дорозі зараз</div>
          {data.active.length === 0 ? (
            <div className="empty-state">Жодне авто не в дорозі.</div>
          ) : (
            <div className="list">
              {data.active.map((t) => (
                <div key={t.carId} className="cell" style={{ cursor: "default", display: "block" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <span className="cell-title">🚙 {t.carName}</span>
                    <span className="cell-sub">👤 {shortName(t.foremanName)}</span>
                  </div>

                  {/* Весь день згори вниз.
                      Перша точка -- це коли авто ЗАБРОНЮВАЛИ в застосунку, а
                      не виїзд: бригадир може обрати авто звечора, а поїхати
                      вранці. Через це підпис і не «виїхали»: о 22:13 напередодні
                      таке читається як друга поїздка, якої не було. */}
                  <div className="trip-timeline">
                    {[{ at: t.since, label: "🔑 обрали авто в застосунку" }, ...t.timeline.map((c) => ({ at: c.at, label: checkpointLabel(c) }))]
                      .sort((a, b) => a.at.localeCompare(b.at))
                      .map((point, i) => (
                        <div key={`${point.at}-${i}`} className="trip-point">
                          <span className="trip-time">{clock(point.at)}</span>
                          <span className="trip-label">{point.label}</span>
                        </div>
                      ))}
                  </div>

                  <div className="hint" style={{ marginTop: 6 }}>
                    {t.people.length > 0 ? `${t.people.length} у бригаді` : "бригада не вказана"}
                  </div>
                  {t.people.length > 0 && (
                    <ul className="bullets">
                      {t.people.map((n) => (
                        <li key={n}>{shortName(n)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Тільки ті, кого НЕ видно вище. Бригада в дорозі -- це той самий
              день, і показувати його двічі означає змусити читача щоразу
              звіряти, чи це одна поїздка чи дві. Цінність цього розділу в
              іншому: хто почав день і не виїхав, або повернувся і не здав
              звіт -- саме вони раніше не було видно ніде. */}
          <div className="section-title">Почали, але не здали</div>
          {pendingDrafts.length === 0 ? (
            <div className="empty-state">Таких немає.</div>
          ) : (
            pendingDrafts.map((d) => (
              <div key={d.foremanTgId} className="list" style={{ marginTop: 8 }}>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">👤 {shortName(d.foremanName)}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {/* Дата чернетки, і окремо -- коли вона не сьогоднішня.
                        Саме ця розбіжність і відправила цілий робочий день
                        учорашнім числом, нікому нічого не сказавши. */}
                    {d.date !== data.date && <span className="badge warn">дата {d.date}</span>}
                    <span className="cell-sub">{clock(d.updatedAt)}</span>
                  </span>
                </div>
                <div className="cell" style={{ cursor: "default", display: "block" }}>
                  <div className="cell-sub">
                    {d.carName ? `🚙 ${d.carName}` : "авто не обрано"} · {STEP_NAMES[d.step] ?? d.step ?? "—"}
                    {d.tripStartedAt ? ` · виїхали ${clock(d.tripStartedAt)}` : " · ще не виїхали"}
                  </div>
                  {!!d.objectNames && <div className="cell-sub">📍 {d.objectNames}</div>}
                  {d.people.length > 0 && <div className="cell-sub">👥 {d.people.map(shortName).join(", ")}</div>}
                  <div style={{ marginTop: 8 }}>
                    <button className="chip chip-sm" style={{ color: "#d70015" }} onClick={() => deleteDraft(d)}>
                      🗑 Прибрати
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="section-title">Здані за цей день</div>
          {data.submitted.length === 0 ? (
            <div className="empty-state">Ще нічого не здано.</div>
          ) : (
            data.submitted.map((d) => (
              <div key={d.foremanTgId} className="list" style={{ marginTop: 8 }}>
                <div className="cell" style={{ cursor: "default" }}>
                  <span className="cell-title">👤 {shortName(d.foremanName)}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`badge ${d.allApproved ? "ok" : "warn"}`}>
                      {d.allApproved ? "✅ затверджено" : "очікує"}
                    </span>
                    <span className="cell-sub">{d.km} км</span>
                  </span>
                </div>
                {d.trips.map((t) => (
                  <div key={t.tripSeq} className="cell" style={{ cursor: "default", display: "block" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span className="cell-title">Поїздка {t.tripSeq}</span>
                      <span className="cell-sub">
                        {new Date(t.submittedAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })} · {t.km} км
                      </span>
                    </div>
                    <div className="hint" style={{ marginTop: 2 }}>{t.objects.join(", ") || "без обʼєктів"}</div>
                  </div>
                ))}
                {/* Та сама стрічка, що й у «в дорозі». Доти зданий день
                    показував лише підсумок, тобто саме тоді, коли його стало
                    з чим звіряти, з нього зникало КОЛИ виїхали, коли прибули
                    й коли почали роботи. Стрічка одна на день (не на поїздку):
                    телефон шле «де ми», не знаючи ні про які tripSeq. */}
                {d.timeline.length > 0 && (
                  <div className="cell" style={{ cursor: "default", display: "block" }}>
                    <div className="trip-timeline">
                      {d.timeline
                        .map((c) => ({ at: c.at, label: checkpointLabel(c) }))
                        .sort((a, b) => a.at.localeCompare(b.at))
                        .map((point, i) => (
                          <div key={`${point.at}-${i}`} className="trip-point">
                            <span className="trip-time">{clock(point.at)}</span>
                            <span className="trip-label">{point.label}</span>
                          </div>
                        ))}
                      <div className="trip-point">
                        <span className="trip-time">{clock(d.trips[d.trips.length - 1]?.submittedAt ?? "")}</span>
                        <span className="trip-label">📤 звіт відправлено</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
