import { getInitData } from "./telegram";

// In production the API is served from the same origin as the frontend
// (miniapp-server serves both), so an empty base means same-origin relative
// requests. VITE_API_BASE_URL only needs to be set for local `vite dev`,
// where the frontend and API run on different ports.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

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
        const res = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Init-Data": getInitData(),
            ...options.headers,
          },
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed: ${res.status}`);
        }

        return (await res.json()) as T;
      } catch (e) {
        lastErr = e;
        // A real HTTP/server error (thrown above) shouldn't be retried --
        // it'll just fail the same way again. Only network-level failures
        // (offline, DNS, connection dropped) get another attempt.
        if (!(e instanceof TypeError)) throw e;
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
      headers: { "X-Telegram-Init-Data": getInitData() },
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed: ${res.status}`);
    }

    return await res.json();
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
  upload: <T>(path: string, file: File | Blob, fieldName = "photo") => upload<T>(path, file, fieldName),
};

export type Employee = { id: string; name: string; brigadeId: string | null; position: string | null; active: boolean };
export type WorkObject = { id: string; name: string; address: string | null; active: boolean };
export type Work = { id: string; name: string; category: string | null; unit: string | null; tariff: number; active: boolean };
export type Car = { id: string; name: string; plate: string | null; active: boolean };
export type Material = { id: string; name: string; unit: string; active: boolean; category: string | null };
export type LogisticDirection = { id: string; name: string; tariff: number; discountsByQty: Record<string, number> };
