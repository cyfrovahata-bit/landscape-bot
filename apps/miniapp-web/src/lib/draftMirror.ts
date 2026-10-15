import { api } from "./api";
import { alertDialog, getInitDataUser } from "./telegram";
import { DraftWriteQueue } from "./draftWriteQueue";

/**
 * Дзеркало чернетки на сервері.
 *
 * Телефон лишається робочою копією: він працює без звʼязку, і день ведеться
 * саме там. Сюди йде знімок, з відставанням у кілька секунд.
 *
 * Навіщо: до цього незданий день не існував ніде, крім одного телефона. Коли
 * один такий день поїхав учорашньою датою, перевірити було нічим — ні адмін
 * не бачив, ні я не міг подивитись. Тепер бачить сервер.
 *
 * Ті самі три правила, що й для журналу дій: нічого не блокує, помилки
 * ковтаються мовчки, і невдала синхронізація ніяк не впливає на день. Дзеркало,
 * яке заважає роботі, гірше за відсутнє.
 */

const PUSH_DELAY_MS = 5000;

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;
let lastSent = "";
const writes = new DraftWriteQueue();
let blocked = false;
let revision: number | undefined;
const revisionKey = () => `draftServerRevision:v1:${getInitDataUser()?.id ?? "anon"}`;
function rememberRevision(value: number) {
  revision = value;
  try { localStorage.setItem(revisionKey(), String(value)); } catch { /* local draft still works */ }
}
async function ensureRevision() {
  if (revision !== undefined) return revision;
  try {
    const saved = localStorage.getItem(revisionKey());
    if (saved !== null && Number.isSafeInteger(Number(saved))) revision = Number(saved);
  } catch { /* obtain revision from server below */ }
  if (revision === undefined) {
    const remote = await api.get<{ revision: number }>("/api/drafts/mine");
    rememberRevision(remote.revision);
  }
  return revision;
}
function handleSyncError(error: unknown) {
  lastSent = "";
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Захист чернетки:") && !blocked) {
    blocked = true;
    void alertDialog(message);
  }
}

/** Надіслати знімок. Кілька змін підряд згортаються в одну відправку. */
export function mirrorDraft(snapshot: {
  date: string;
  step: string;
  carId: string;
  employeeIds: string[];
  objectNames: string[];
  tripStartedAt: string | null;
  payload: unknown;
}) {
  if (blocked) return;
  pending = snapshot;
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    const body = pending;
    pending = null;
    if (!body) return;
    // Нічого не змінилось -- нема чого і слати: таймери перемальовують екран
    // щосекунди, і без цього ми б лупили в сервер на кожен тік.
    const fingerprint = JSON.stringify(body);
    if (fingerprint === lastSent) return;
    void writes.enqueue(async () => {
      if (blocked) return;
      const baseRevision = await ensureRevision();
      const result = await api.put<{ revision: number }>("/api/drafts", { ...body, baseRevision });
      rememberRevision(result.revision);
      lastSent = fingerprint;
    }).catch(handleSyncError);
  }, PUSH_DELAY_MS);
}

/** День здали або скинули -- дзеркалу тут більше нічого показувати. */
export function clearMirroredDraft() {
  // Спершу зняти ВЛАСНИЙ відкладений знімок, і тільки потім видаляти.
  // Без цього затримка у 5 с била точно в найгіршу мить: остання дія перед
  // здачею (кінцевий одометр) ставила таймер, здача через дві секунди
  // видаляла дзеркало, а таймер ще через три -- клав його назад. День уже
  // зданий, а на сервері лежить «незавершений».
  //
  // 08.09 це коштувало задвоєної поїздки: наступного заходу застосунок
  // запропонував «відновити з сервера», підняв той знімок з editingTripSeq =
  // null, і кнопка на підсумку сказала «📤 Відправити на підтвердження»
  // замість «📤 Оновити звіт». Тап -- і в дні дві поїздки замість однієї,
  // прибрати яку бригадир не може.
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  pending = null;
  lastSent = "";
  writes.invalidate();
  void writes.enqueue(async () => {
    if (blocked) return;
    const baseRevision = await ensureRevision();
    const result = await api.del<{ revision: number }>(`/api/drafts?baseRevision=${baseRevision}`);
    rememberRevision(result.revision);
  }, true).catch(handleSyncError);
}

/** Чернетка з сервера. Потрібна, коли на телефоні порожньо, а день був. */
export async function fetchMirroredDraft<T>(): Promise<{ payload: T; updatedAt: string; revision: number } | null> {
  try {
    const res = await api.get<{ found: boolean; payload: T; updatedAt: string; revision: number }>("/api/drafts/mine");
    if (res.found && res.payload) {
      // The caller is about to offer THIS version for restoration.
      rememberRevision(res.revision);
      return { payload: res.payload, updatedAt: res.updatedAt, revision: res.revision };
    }
    rememberRevision(res.revision);
    return null;
  } catch {
    return null;
  }
}
