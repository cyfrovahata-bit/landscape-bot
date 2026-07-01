import { getInitData } from "./telegram";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
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

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

export type Employee = { id: string; name: string; brigadeId: string | null; position: string | null; active: boolean };
export type WorkObject = { id: string; name: string; address: string | null; active: boolean };
export type Work = { id: string; name: string; category: string | null; unit: string | null; tariff: number; active: boolean };
export type Car = { id: string; name: string; plate: string | null; active: boolean };
export type Material = { id: string; name: string; unit: string; active: boolean; category: string | null };
export type LogisticDirection = { id: string; name: string; tariff: number; discountsByQty: Record<string, number> };
