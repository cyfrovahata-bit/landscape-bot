import { DeductionEditor, type DeductionItem } from "../components/DeductionEditor";
import { useEffect, useState } from "react";
import { api, type Employee, type SalaryPack } from "../lib/api";
import { useClearErrorOnSuccess } from "../lib/useClearErrorOnSuccess";
import { confirmDialog, haptic, useTelegramBackButton } from "../lib/telegram";
import { employeeRole, shortName } from "../lib/employee";
import { BackRow } from "../components/BackRow";
import { fmtHours, MIN_PAID_HOURS } from "../lib/hours";

type PendingObject = {
  objectId: string;
  objectName: string;
  // unit comes from the РОБОТИ dictionary so a volume reads as "1878 м2"
  // rather than a bare number the admin has to guess the meaning of.
  works: { workId: string; workName: string; volume?: string | number; unit?: string | null; employeeIds?: string[] }[];
  // Знімки виконаних робіт з обʼєкта. Єдине, що адмін може подивитись
  // очима, перш ніж затвердити суму.
  photoUrls?: string[];
};
type PendingItem = {
  deductions: DeductionItem[];
  deductionsRevision: number;
  reportRevision: string;
  deductionError?: string;
  deductionTotal: number;
  date: string;
  foremanTgId: number;
  foremanName: string;
  submittedAt: string;
  km: number;
  tripClass: string;
  roadAllowance: { total: number; perPerson: number };
  salaryPacks: SalaryPack[];
  objects: PendingObject[];
  employeeIds: string[];
  selfTransportIds: string[];
};
type PendingResponse = { items: PendingItem[]; reasons: Record<string, string> };

function keyOf(it: PendingItem) {
  return `${it.date}|${it.foremanTgId}`;
}

export function Approval({
  onBack,
  focusDate,
  focusForeman,
  isAdmin,
}: {
  onBack: () => void;
  focusDate?: string;
  focusForeman?: number;
  isAdmin?: boolean;
}) {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  useClearErrorOnSuccess(setError);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(focusDate && focusForeman ? `${focusDate}|${focusForeman}` : null);
  const [returningKey, setReturningKey] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string>("OTHER");
  const [note, setNote] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [dirtyDeductions,setDirtyDeductions]=useState<Record<string,boolean>>({});

  const employeeById = new Map(employees.map((e) => [e.id, e]));

  // Otherwise Telegram's native back gesture/button exits the whole mini app
  // instead of stepping back to the menu, same as the in-app "‹ Назад" row.
  useTelegramBackButton(onBack);

  function load() {
    setLoading(true);
    setError(null);
    // Returned (not fire-and-forget) so approve()/confirmReturn() can await
    // the refreshed list before clearing their busy guard -- otherwise the
    // button re-enables the instant the POST resolves, while the just-acted-on
    // row is still showing its stale (pre-approval) state for the ~100-300ms
    // the refetch takes, inviting a second tap to send a duplicate request.
    return Promise.all([api.get<PendingResponse>("/api/road-timesheet/pending"), api.get<Employee[]>("/api/dictionaries/employees")])
      .then(([pending, emps]) => {
        setData(pending);
        setEmployees(emps);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resets the return-reason sub-form -- used both by "Скасувати" and after a
  // successful return, so a leftover reason/comment typed for one foreman's
  // day never carries over and gets attached to a DIFFERENT foreman's return
  // (reasonCode/note are screen-level state shared across every row).
  function closeReturnForm() {
    setReturningKey(null);
    setReasonCode("OTHER");
    setNote("");
  }

  async function approve(it: PendingItem) {
    if (dirtyDeductions[keyOf(it)] || it.deductionError) {setError("Збережіть відрахування перед затвердженням.");return;}
    const ok = await confirmDialog(`Затвердити день ${it.date} для ${it.foremanName}?`);
    if (!ok) return;
    setBusyKey(keyOf(it));
    try {
      await api.post("/api/road-timesheet/pending/approve", { date: it.date, foremanTgId: it.foremanTgId, deductionsRevision: it.deductionsRevision, reportRevision: it.reportRevision });
      haptic("success");
      await load();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Wipes the day entirely -- for a report that should never have existed (a
   * test run, a duplicate, the wrong foreman), not for one that needs fixing:
   * that is what returning it is for. Asked twice because there is no undo.
   */
  async function deleteReport(it: PendingItem) {
    if (!(await confirmDialog(`Видалити звіт ${it.date} — ${it.foremanName}?\n\nЦе не «повернути на редагування»: день зникне повністю.`)))
      return;
    if (!(await confirmDialog("Це неможливо скасувати. Дані буде видалено і з Google Sheets, і з бази. Точно видалити?"))) return;
    setBusyKey(keyOf(it));
    try {
      await api.post("/api/road-timesheet/pending/delete", { date: it.date, foremanTgId: it.foremanTgId });
      haptic("success");
      await load();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmReturn(it: PendingItem) {
    setBusyKey(keyOf(it));
    try {
      await api.post("/api/road-timesheet/pending/return", { date: it.date, foremanTgId: it.foremanTgId, reasonCode, note });
      haptic("success");
      closeReturnForm();
      await load();
    } catch (e) {
      setError((e as Error).message);
      haptic("error");
    } finally {
      setBusyKey(null);
    }
  }

  // Defense-in-depth only -- the server already 403s every /pending* route
  // for a non-admin regardless of this. This just keeps the UI from ever
  // rendering someone else's approval data if this screen were ever reached
  // without going through Menu's admin-only filter or the deep-link's own
  // role check (both gate it today).
  if (isAdmin === false) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <div className="empty-state">⛔️ Доступно лише адміністратору</div>
      </div>
    );
  }

  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>✅ Затвердження</h1>
        <div className="hint">Звіти, що очікують рішення</div>
      </div>

      {error && <div className="empty-state">⚠️ {error}</div>}
      {loading && !data && <div className="empty-state">Завантаження…</div>}
      {data && !data.items.length && <div className="empty-state">🎉 Немає звітів на підтвердження</div>}

      {data && !!data.items.length && (
        <div>
          {data.items.map((it) => {
            const key = keyOf(it);
            const expanded = expandedKey === key;
            const fund = it.salaryPacks.reduce((a, p) => a + p.objectTotal, 0);
            const busy = busyKey === key;
            return (
              <div key={key} className={`approval-card ${expanded ? "open" : ""}`}>
                <button className="cell" onClick={() => setExpandedKey(expanded ? null : key)}>
                  <span className="cell-title">
                    {expanded ? "▾" : "▸"} {it.foremanName}
                  </span>
                  <span className="cell-sub">
                    {it.date} · {it.km} км
                  </span>
                </button>

                {expanded && (
                  <div style={{ padding: "0 16px 16px" }}>
                    {/* Three unlabelled figures used to sit here, and the big
                        one read as travel money. It is the opposite: the fund
                        is what the day's WORK earned (sum of volume x tariff
                        across every object), and the only road figure is the
                        per-person allowance. */}
                    {/* Same compact row shape as the objects below -- three
                        full-height list cells for three numbers pushed the
                        day itself off the screen. */}
                    <div className="approval-object" style={{ marginTop: 0 }}>
                      <div className="approval-rows">
                        <div className="approval-row">
                          <div className="approval-row-main">
                            <span className="approval-row-name">🚗 Дорога</span>
                            <span className="approval-nums">
                              <span className="badge badge-sm">{it.km} км</span>
                              <span className="badge badge-sm">клас {it.tripClass}</span>
                            </span>
                          </div>
                        </div>
                        <div className="approval-row">
                          <div className="approval-row-main">
                            <span className="approval-row-name">💸 Доплата за виїзд</span>
                            <span className="approval-nums">
                              <span className="badge badge-sm">{it.roadAllowance.perPerson} грн/особу</span>
                              <span className="badge badge-sm ok">{it.roadAllowance.total} грн</span>
                            </span>
                          </div>
                        </div>
                        <div className="approval-row">
                          <div className="approval-row-main">
                            <span className="approval-row-name">💰 {it.deductionTotal ? "Фонд після відрахувань" : "Фонд робіт (обсяг × тариф)"}</span>
                            <span className="approval-nums">
                              <span className="badge badge-sm ok">{Math.round(fund * 100) / 100} грн</span>
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="hint" style={{ marginTop: 6 }}>
                        Доплата за виїзд у фонд не входить — вона рахується окремо, від кілометрів.
                      </div>
                    </div>

                    {/* No separate roster: an admin approving money needs to
                        see each person against the object whose fund pays
                        them, with the hours and coefficient behind the
                        figure -- a list of names above it answered nothing. */}
                    <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>
                      📍 Обʼєкти та нарахування
                    </div>
                    {it.objects.map((o) => {
                      const pack = it.salaryPacks.find((p) => p.objectId === o.objectId);
                      return (
                        <div key={o.objectId} className="approval-object">
                          <div className="approval-object-head">
                            <span>{o.objectName}</span>
                            {pack && <span className="badge ok">{pack.objectTotal} грн</span>}
                          </div>

                          {false && (o.photoUrls ?? []).length > 0 && (
                            <div className="picked-panel" style={{ marginTop: 8 }}>
                              {(o.photoUrls ?? []).map((url, i) => (
                                <span key={url} className="picked-item">
                                  <a href={url} target="_blank" rel="noreferrer">📷 фото {i + 1}</a>
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="approval-sub">🛠 Роботи</div>
                          <div className="approval-rows">
                            {o.works.map((w) => (
                              <div key={w.workId} className="approval-row">
                                <div className="approval-row-main">
                                  <span className="approval-row-name wrap">{w.workName}</span>
                                  {w.volume && w.volume !== "?" ? (
                                    <span className="badge ok">
                                      {w.volume}
                                      {w.unit ? ` ${w.unit}` : ""}
                                    </span>
                                  ) : (
                                    <span className="badge warn">без обсягу</span>
                                  )}
                                </div>
                                {/* Робота без призначення ділиться всією бригадою --
                                    показуємо лише виняток, щоб не засмічувати список. */}
                                {!!w.employeeIds?.length && (
                                  <div className="hint" style={{ marginTop: 2 }}>
                                    👤 окремо: {w.employeeIds.map((id) => shortName(employeeById.get(id)?.name ?? id)).join(", ")}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>

                          {!!pack?.rows.length && (
                            <>
                              <div className="approval-sub">👥 Нарахування</div>
                              <div className="approval-rows">
                                {pack.rows.map((r) => {
                                  const emp = employeeById.get(r.employeeId);
                                  const role = emp ? employeeRole(emp) : "робітник";
                                  const selfT = it.selfTransportIds.includes(r.employeeId);
                                  return (
                                    <div key={r.employeeId} className="approval-row">
                                      {/* One line per person: the name gives up
                                          width first (ellipsis), the figures
                                          never wrap -- money that jumps to its
                                          own line stops lining up down the
                                          column, which is how it gets read. */}
                                      <div className="approval-row-main">
                                        <span className="approval-row-name">
                                          {shortName(r.employeeName)}
                                          {role === "бригадир" && <span className="mark lead" title="бригадир"> Б</span>}
                                          {role === "старший" && <span className="mark senior" title="старший садівник"> С</span>}
                                          {selfT && <span className="mark" title="приїхав сам — без доплати за виїзд"> 🚶</span>}
                                        </span>
                                        <span className="approval-nums">
                                          {/* Червоне = ці години не в поділі: або їх
                                              нема, або менше мінімуму. Саме тому в
                                              людини поруч може стояти 0 грн. */}
                                          <span className={`badge badge-sm ${r.hours >= MIN_PAID_HOURS ? "" : "danger"}`}>
                                            {fmtHours(r.hours)}
                                          </span>
                                          {r.coefTotal !== 1 && <span className="badge badge-sm warn">к{r.coefTotal}</span>}
                                          <span className="badge badge-sm ok">{r.pay} грн</span>
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                                {pack.companyPay > 0 && (
                                  <div className="approval-row">
                                    <div className="approval-row-main">
                                      <span className="approval-row-name">🏢 Фірма</span>
                                      <span className="approval-nums">
                                        <span className="badge badge-sm">{pack.companyPay} грн</span>
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="hint" style={{ marginTop: 6 }}>
                                Б — бригадир, С — старший, 🚶 — приїхав сам (без доплати за виїзд)
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}

                    {it.deductionError&&<div role="alert">⚠️ {it.deductionError} Перевірте та збережіть відрахування.</div>}
                    <DeductionEditor key={`${key}|${it.deductionsRevision}|${it.reportRevision}`} items={it.deductions ?? []} busy={busy}
                      onDirty={dirty=>setDirtyDeductions(prev=>({...prev,[key]:dirty}))} onRefresh={()=>load()}
                      onSave={async items=>{
                        setBusyKey(key);
                        try {
                          await api.post('/api/road-timesheet/pending/deductions',{date:it.date,foremanTgId:it.foremanTgId,revision:it.deductionsRevision,reportRevision:it.reportRevision,items});
                          const pending=await api.get<PendingResponse>('/api/road-timesheet/pending');
                          setData(pending);setDirtyDeductions(prev=>({...prev,[key]:false}));haptic('success');
                        } finally {setBusyKey(null);}
                      }}/>

                    {returningKey === key ? (
                      <div style={{ marginTop: 12 }}>
                        <div className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                          Причина повернення
                        </div>
                        <div className="chip-row">
                          {Object.entries(data.reasons).map(([code, label]) => (
                            <button
                              key={code}
                              className={`chip ${reasonCode === code ? "selected" : ""}`}
                              onClick={() => setReasonCode(code)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <input
                          className="search-box"
                          placeholder="Коментар (необовʼязково)…"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button className="chip" onClick={closeReturnForm}>
                            Скасувати
                          </button>
                          <button className="chip danger-btn" onClick={() => confirmReturn(it)} disabled={busy}>
                            {busy ? "Відправлення…" : "🔴 Підтвердити повернення"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          className="chip selected"
                          onClick={() => approve(it)}
                          disabled={busy || dirtyDeductions[key] || !!it.deductionError}
                        >
                          {busy ? "…" : "✅ Підтвердити"}
                        </button>
                        <button
                          className="chip danger-btn"
                          onClick={() => {
                            // Always start from a clean reason/comment -- reasonCode/note
                            // are shared screen-wide state, so opening this for a
                            // different foreman without ever tapping "Скасувати" on the
                            // previous one (e.g. collapse row A, expand row B) must not
                            // carry A's leftover reason/comment into B's return.
                            setReasonCode("OTHER");
                            setNote("");
                            setReturningKey(key);
                          }}
                          disabled={busy}
                        >
                          🔴 Повернути на редагування
                        </button>
                        <button className="back-btn danger-btn" onClick={() => deleteReport(it)} disabled={busy}>
                          🗑 Видалити звіт
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
