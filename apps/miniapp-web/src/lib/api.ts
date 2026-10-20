import { getInitData } from "./telegram";
import { ApiError, withRequestDeadline } from './requestErrors';

const authListeners = new Set<(message: string) => void>();
export function subscribeAuthFailure(callback: (message: string) => void) {
  authListeners.add(callback); return () => { authListeners.delete(callback); };
}

// In production the API is served from the same origin as the frontend
// (miniapp-server serves both), so an empty base means same-origin relative
// requests. VITE_API_BASE_URL only needs to be set for local `vite dev`,
// where the frontend and API run on different ports.
const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

// Field work means patchy signal between objects. A plain fetch failure
// there (a TypeError -- the request never reached the server, as opposed to
// an HTTP error response) shouldn't just drop the action on the floor; retry
// a couple of times with backoff before giving up. GET requests aren't
// retried (dictionary loads should fail fast and visibly).
export type SyncStatus = "idle" | "syncing" | "offline";
let syncStatus: SyncStatus = "idle";
let inflight = 0;
const statusListeners = new Set<(s: SyncStatus) => void>();

function setSyncStatus(s: SyncStatus) {
  syncStatus = s;
  statusListeners.forEach((l) => l(s));
}

export function subscribeSyncStatus(cb: (s: SyncStatus) => void) {
  statusListeners.add(cb);
  cb(syncStatus);
  return () => {
    statusListeners.delete(cb);
  };
}

// A screen's error banner has no way of knowing the trouble has passed: it is
// set from one rejected call and then sits there. A foreman who hit a restart
// mid-day kept staring at a red line long after the server was back. Any
// request that succeeds says so here, and screens clear the banner.
const okListeners = new Set<() => void>();

export function subscribeApiOk(cb: () => void) {
  okListeners.add(cb);
  return () => {
    okListeners.delete(cb);
  };
}

function notifyOk() {
  okListeners.forEach((l) => l());
}

/**
 * Turns an HTTP status into something a foreman can act on.
 *
 * A bare "Request failed: 502" is what Railway's edge returns while the
 * container is restarting -- there is no JSON body to take a message from, and
 * the number means nothing to the person holding the phone.
 */
function messageForStatus(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return "Сервер перезапускається. Зачекайте кілька секунд і спробуйте ще раз — дані не втрачено.";
  }
  if (status === 401) {
    return "Потрібно поновити вхід через Telegram. Не закривайте редактор із непідтвердженими змінами. Відкрийте додаток через кнопку бота в новій вкладці, потім поверніться сюди й повторіть перевірку входу.";
  }
  if (status === 403) return "Немає доступу. Закрийте застосунок повністю і відкрийте знову.";
  if (status === 413) return "Файл завеликий.";
  return `Помилка сервера (${status}). Спробуйте ще раз.`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isMutation = (options.method ?? "GET") !== "GET";
  const delays = isMutation ? [0, 1000, 3000] : [0];
  let lastErr: unknown = new Error("Request failed");

  inflight++;
  setSyncStatus("syncing");
  try {
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      try {
        const perform = async (signal?: AbortSignal) => {
          const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            signal,
            credentials: 'same-origin',
            headers: {
              "Content-Type": "application/json",
              "X-Telegram-Init-Data": getInitData(),
              "X-GreenHand-Client": "miniapp",
              ...options.headers,
            },
          });

          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const message = res.status === 401 ? messageForStatus(401) : body.error || messageForStatus(res.status);
            if (res.status === 401 || res.status === 403) authListeners.forEach(listener => listener(message));
            throw new ApiError(message, res.status);
          }
          return (await res.json()) as T;
        };
        // Bound reads and idempotent draft PUTs. Approval/export and other
        // existing mutations keep their original duration and retry policy.
        const data = !isMutation || (options.method === 'PUT' && path.startsWith('/api/trip-drafts/'))
          ? await withRequestDeadline(perform) : await perform();
        notifyOk();
        return data;
      } catch (e) {
        lastErr = e;
        // A real HTTP/server error (thrown above) shouldn't be retried --
        // it'll just fail the same way again. Only network-level failures
        // (offline, DNS, connection dropped) get another attempt.
        if (!(e instanceof TypeError) && !(e instanceof Error && e.name === 'AbortError')) throw e;
      }
    }
    setSyncStatus("offline");
    throw lastErr;
  } finally {
    inflight--;
    if (inflight === 0 && syncStatus !== "offline") setSyncStatus("idle");
  }
}

async function upload<T>(path: string, file: File | Blob, fieldName: string): Promise<T> {
  const form = new FormData();
  form.append(fieldName, file);

  inflight++;
  setSyncStatus("syncing");
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: 'same-origin',
      headers: { "X-Telegram-Init-Data": getInitData(), "X-GreenHand-Client": "miniapp" },
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = res.status === 401 ? messageForStatus(401) : body.error || messageForStatus(res.status);
      if (res.status === 401 || res.status === 403) authListeners.forEach(listener => listener(message));
      throw new ApiError(message, res.status);
    }

    const data = await res.json();
    notifyOk();
    return data;
  } catch (e) {
    if (e instanceof TypeError) setSyncStatus("offline");
    throw e;
  } finally {
    inflight--;
    if (inflight === 0 && syncStatus !== "offline") setSyncStatus("idle");
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, file: File | Blob, fieldName = "photo") => upload<T>(path, file, fieldName),
};

export type Employee = { id: string; name: string; brigadeId: string | null; position: string | null; active: boolean };
export type WorkObject = { id: string; name: string; address: string | null; active: boolean };
export type Work = {
  id: string;
  name: string;
  category: string | null;
  // Optional second level under category -- null when the ПІДКАТЕГОРІЯ cell
  // is empty, which is the normal case (see groupWorks in lib/works.ts).
  subcategory: string | null;
  unit: string | null;
  tariff: number;
  active: boolean;
};
export type Car = { id: string; name: string; plate: string | null; active: boolean };
export type Material = { id: string; name: string; unit: string; active: boolean; category: string | null };
export type LogisticDirection = { id: string; name: string; tariff: number; discountsByQty: Record<string, number> };
export type SalaryRow = { employeeId: string; employeeName: string; hours: number; coefTotal: number; points: number; pay: number };
export type SalaryPack = { objectId: string; objectName: string; objectTotal: number; sumPoints: number; companyPay: number; rows: SalaryRow[] };
export type Me = { tgId: number; pib: string; role: "ADMIN" | "BRIGADIER" };

// --- Trip plans ------------------------------------------------------------
// A trip set up in advance. Lives on the server (not in localStorage as it
// once did) because other brigadiers have to see that a car or a person is
// already spoken for -- see packages/core/src/schema.ts:tripPlans.
export type PlanWork = { workId: string; workName: string; unit?: string | null };
export type PlanObject = { objectId: string; objectName: string; works: PlanWork[] };
export type TripPlan = {
  id: string;
  foremanTgId: number;
  foremanName: string;
  createdByName: string;
  /** An admin planned this FOR the foreman, rather than the foreman planning it. */
  assignedByAdmin: boolean;
  carId: string;
  carName: string;
  employeeIds: string[];
  employeeNames: string[];
  objects: PlanObject[];
  note: string;
  createdAt: string;
  /** The caller's own plan -- the only kind with action buttons. */
  mine: boolean;
};
export type PlanInput = {
  foremanTgId?: number;
  carId: string;
  employeeIds: string[];
  objects: PlanObject[];
  note?: string;
};
export type Foreman = { tgId: number; name: string };
/**
 * Who is already spoken for by SOME active plan -- ids and a name, nothing
 * else. Kept separate from the plan list so the pickers can warn about a
 * conflict without anyone reading another brigade's plans.
 */
export type PlannedResources = {
  cars: { planId: string; carId: string; foremanName: string }[];
  employees: { planId: string; employeeId: string; foremanName: string }[];
};
