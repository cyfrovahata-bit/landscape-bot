import { SHEET_NAMES } from "./names.js";
import {
  USERS_HEADERS,
  EMP_HEADERS,
  OBJECTS_HEADERS,
  WORKS_HEADERS,
  CARS_HEADERS,
  MATERIALS_HEADERS,
  TOOLS_HEADERS,
  LOGISTIC_HEADERS,
  SETTINGS_HEADERS,
} from "./headers.js";

import type {
  UserRow,
  EmployeeRow,
  ObjectRow,
  WorkRow,
  CarRow,
  Role,
  MaterialRow,
  ToolRow,
  SettingsRow,
  PayrollRole,
} from "./types.js";

import { loadSheet, requireHeaders, getCell, appendRows, updateRow } from "./core.js";
import { parseNumber, toBool } from "./utils.js";

import { config } from "../../config.js";




export type LogisticRow = {
  id: string;
  name: string;
  tariff: number;
  active: boolean;
  discountsByQty?: Record<number, number>;
};



function yes(v: unknown) {
  return String(v || "").trim().toLowerCase() === "так";
}

function toNum(v: unknown) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseDiscountsCell(raw: unknown): Record<number, number> {
  const s = String(raw ?? "").trim();
  if (!s) return {};

  const out: Record<number, number> = {};
  const parts = s.split(/[;,\n]+/).map(x => x.trim()).filter(Boolean);

  for (const p of parts) {
    // підтримка "2=50" або "2:50"
    const m = p.match(/^(\d+)\s*[:=]\s*(\d+(?:[.,]\d+)?)$/);
    if (!m) continue;

    const qty = Number(m[1]);
    const disc = Number(String(m[2]).replace(",", "."));

    if (Number.isFinite(qty) && qty >= 2 && Number.isFinite(disc) && disc >= 0) {
      out[Math.floor(qty)] = disc;
    } 
  }

  return out;
}

export async function fetchLogistics(): Promise<LogisticRow[]> {
  const sh = await loadSheet(SHEET_NAMES.logistic);
  requireHeaders(
    sh.map,
    [LOGISTIC_HEADERS.id, LOGISTIC_HEADERS.name, LOGISTIC_HEADERS.tariff, LOGISTIC_HEADERS.discount, LOGISTIC_HEADERS.active],
    SHEET_NAMES.logistic
  );

  const rows = sh.data
    .map((r) => ({
      id: String(getCell(r, sh.map, LOGISTIC_HEADERS.id) ?? "").trim(),
      name: String(getCell(r, sh.map, LOGISTIC_HEADERS.name) ?? "").trim(),
      tariff: toNum(getCell(r, sh.map, LOGISTIC_HEADERS.tariff)),
      discountsByQty: parseDiscountsCell(getCell(r, sh.map, LOGISTIC_HEADERS.discount)),
      active: yes(getCell(r, sh.map, LOGISTIC_HEADERS.active)),
    }))
    .filter((x) => x.id && x.name && x.active);
  return rows;
}

function normalizeCategory(v: string): string | undefined {
  const s = (v ?? "").trim();
  return s ? s : undefined;
}


export async function addUserToSheet(row: any[]) {
  return appendRows(SHEET_NAMES.users, [row]);
}

export async function updateUserRow(rowIndex: number, values: any[]) {
  return updateRow(SHEET_NAMES.users, rowIndex, values);
}


export async function fetchUsers(): Promise<UserRow[]> {
  const sh = await loadSheet(SHEET_NAMES.users);

  requireHeaders(
    sh.map,
    [USERS_HEADERS.tgId, USERS_HEADERS.pib, USERS_HEADERS.role, USERS_HEADERS.active],
    SHEET_NAMES.users
  );

  return sh.data
    .map((r) => {
      const tgId = parseNumber(getCell(r, sh.map, USERS_HEADERS.tgId));
      const role = getCell(r, sh.map, USERS_HEADERS.role) as Role;
      const active = toBool(getCell(r, sh.map, USERS_HEADERS.active));
      const username = getCell(r, sh.map, USERS_HEADERS.username);
      const pib = getCell(r, sh.map, USERS_HEADERS.pib);
      const comment = getCell(r, sh.map, USERS_HEADERS.comment);

      return {
        tgId: Number(tgId),
        pib,
        role,
        active,
        ...(username ? { username } : {}),
        ...(comment ? { comment } : {}),
      } satisfies UserRow;
    })
    .filter((u) => Number.isFinite(u.tgId) && u.tgId > 0 && u.pib && u.role && u.active);
}

export async function fetchEmployees(): Promise<EmployeeRow[]> {
  const sh = await loadSheet(SHEET_NAMES.employees);

  // ✅ раз ти читаєш ці колонки — вони мають існувати
  requireHeaders(
    sh.map,
    [EMP_HEADERS.id, EMP_HEADERS.name, EMP_HEADERS.brigadeId, EMP_HEADERS.position, EMP_HEADERS.active],
    SHEET_NAMES.employees
  );

  return sh.data
    .map((r) => {
      // ✅ стабільні string-значення (trim, щоб не було " EMP_001 ")
      const id = String(getCell(r, sh.map, EMP_HEADERS.id) ?? "").trim();
      const name = String(getCell(r, sh.map, EMP_HEADERS.name) ?? "").trim();

      // ✅ raw-версії для перевірок на пустоту
      const brigadeIdRaw = String(getCell(r, sh.map, EMP_HEADERS.brigadeId) ?? "").trim();
      const positionRaw = String(getCell(r, sh.map, EMP_HEADERS.position) ?? "").trim();

      const active = toBool(getCell(r, sh.map, EMP_HEADERS.active));

      // ✅ залишаємо як було (щоб не міняти поведінку інших місць)
      const brigadeId = getCell(r, sh.map, EMP_HEADERS.brigadeId);
      const position = getCell(r, sh.map, EMP_HEADERS.position);

      return {
        id,
        name,
        active,

        // ✅ логіка додавання полів тепер стабільна (не додаємо пусті/пробіли)
        ...(brigadeIdRaw ? { brigadeId } : {}),
        ...(positionRaw ? { position } : {}),
      } satisfies EmployeeRow;
    })
    .filter((e) => e.id && e.name && e.active);
}

export async function fetchObjects(): Promise<ObjectRow[]> {
  const sh = await loadSheet(SHEET_NAMES.objects);

  requireHeaders(sh.map, [OBJECTS_HEADERS.id, OBJECTS_HEADERS.name, OBJECTS_HEADERS.active], SHEET_NAMES.objects);

  return sh.data
    .map((r) => {
      const id = getCell(r, sh.map, OBJECTS_HEADERS.id);
      const name = getCell(r, sh.map, OBJECTS_HEADERS.name);
      const active = toBool(getCell(r, sh.map, OBJECTS_HEADERS.active));
      const address = getCell(r, sh.map, OBJECTS_HEADERS.address);

      return {
        id,
        name,
        active,
        ...(address ? { address } : {}),
      } satisfies ObjectRow;
    })
    .filter((o) => o.id && o.name && o.active);
}

export async function fetchWorks(): Promise<WorkRow[]> {
  const sh = await loadSheet(SHEET_NAMES.works);

  requireHeaders(
    sh.map,
    [WORKS_HEADERS.id, WORKS_HEADERS.name, WORKS_HEADERS.tariff, WORKS_HEADERS.active],
    SHEET_NAMES.works
  );

  return sh.data
    .map((r) => {
      const id = getCell(r, sh.map, WORKS_HEADERS.id);
      const name = getCell(r, sh.map, WORKS_HEADERS.name);
      const active = toBool(getCell(r, sh.map, WORKS_HEADERS.active));

const category = normalizeCategory(getCell(r, sh.map, WORKS_HEADERS.category));
      const unit = normalizeCategory(getCell(r, sh.map, WORKS_HEADERS.unit));


      const tariff = parseNumber(getCell(r, sh.map, WORKS_HEADERS.tariff));

      return {
        id,
        name,
        tariff,
        active,
        ...(category ? { category } : {}),
        ...(unit ? { unit } : {}),
      } satisfies WorkRow;
    })
    .filter((w) => w.id && w.name && w.active);
}

export async function fetchCars(): Promise<CarRow[]> {
  const sh = await loadSheet(SHEET_NAMES.cars);

  requireHeaders(sh.map, [CARS_HEADERS.id, CARS_HEADERS.name, CARS_HEADERS.active], SHEET_NAMES.cars);

  return sh.data
    .map((r) => {
      const id = getCell(r, sh.map, CARS_HEADERS.id);
      const name = getCell(r, sh.map, CARS_HEADERS.name);
      const active = toBool(getCell(r, sh.map, CARS_HEADERS.active));

      const plate = getCell(r, sh.map, CARS_HEADERS.plate);

      return {
        id,
        name,
        active,
        ...(plate ? { plate } : {}),
      } satisfies CarRow;
    })
    .filter((c) => c.id && c.name && c.active);
}

export async function fetchMaterials(): Promise<MaterialRow[]> {
  const sh = await loadSheet(SHEET_NAMES.materials);

  requireHeaders(
    sh.map,
    [MATERIALS_HEADERS.id, MATERIALS_HEADERS.name, MATERIALS_HEADERS.unit, MATERIALS_HEADERS.active],
    SHEET_NAMES.materials
  );

  return sh.data
    .map((r) => {
      const id = getCell(r, sh.map, MATERIALS_HEADERS.id);
      const name = getCell(r, sh.map, MATERIALS_HEADERS.name);
const unit = String(getCell(r, sh.map, MATERIALS_HEADERS.unit) ?? "").trim();
      const active = toBool(getCell(r, sh.map, MATERIALS_HEADERS.active));

const category = normalizeCategory(getCell(r, sh.map, MATERIALS_HEADERS.category));
      const comment = getCell(r, sh.map, MATERIALS_HEADERS.comment);

      return {
        id,
        name,
        unit,
        active,
        ...(category ? { category } : {}),
        ...(comment ? { comment } : {}),
      } satisfies MaterialRow;
    })
    .filter((m) => m.id && m.name && m.unit && m.active);
}

export async function fetchTools(): Promise<ToolRow[]> {
  const sh = await loadSheet(SHEET_NAMES.tools);

  requireHeaders(sh.map, [TOOLS_HEADERS.id, TOOLS_HEADERS.name, TOOLS_HEADERS.active], SHEET_NAMES.tools);

  return sh.data
    .map((r) => {
      const id = getCell(r, sh.map, TOOLS_HEADERS.id);
      const name = getCell(r, sh.map, TOOLS_HEADERS.name);
      const active = toBool(getCell(r, sh.map, TOOLS_HEADERS.active));

const category = normalizeCategory(getCell(r, sh.map, TOOLS_HEADERS.category));
      const comment = getCell(r, sh.map, TOOLS_HEADERS.comment);

      return {
        id,
        name,
        active,
        ...(category ? { category } : {}),
        ...(comment ? { comment } : {}),
      } satisfies ToolRow;
    })
    .filter((t) => t.id && t.name && t.active);
}

export async function fetchSettings(): Promise<SettingsRow[]> {
  const sh = await loadSheet(SHEET_NAMES.settings);

  requireHeaders(sh.map, [SETTINGS_HEADERS.key, SETTINGS_HEADERS.value], SHEET_NAMES.settings);

  return sh.data
    .map((r) => {
const key = String(getCell(r, sh.map, SETTINGS_HEADERS.key) ?? "").trim();
const value = String(getCell(r, sh.map, SETTINGS_HEADERS.value) ?? "").trim();
const comment = String(getCell(r, sh.map, SETTINGS_HEADERS.comment) ?? "").trim();

      return {
        key,
        value,
        ...(comment ? { comment } : {}),
      } satisfies SettingsRow;
    })
    .filter((x) => x.key && x.value);
}

export async function getSettingNumber(key: string): Promise<number | undefined> {
  const rows = await fetchSettings();
  const found = rows.find((r) => r.key === key);
  if (!found) return undefined;

  const n = parseNumber(found.value);
  return Number.isFinite(n) ? n : undefined;
}

function roleFromPosition(position?: string): PayrollRole {
  const s = (position || "").toLowerCase();

  if (s.includes("бригадир")) return "BRIGADIER";
  if (s.includes("старш")) return "SENIOR";

  return "WORKER";
}

export async function fetchEmployeeRoles(): Promise<Map<string, PayrollRole>> {
  const emps = await fetchEmployees();
  const m = new Map<string, PayrollRole>();

  for (const e of emps) {
    if (!e.active) continue;
    m.set(e.id, roleFromPosition(String(e.position ?? "")));
  }

  return m;
}

// ======================
// Fixed allowances (Settings)
// ======================

export type RoadAllowanceConfig = {
  S: number;   // до 20 км
  M: number;   // 21–50 км
  L: number;   // 51–100 км
  XL: number;  // понад 100 км
};

export type FixedAllowances = {
  road: RoadAllowanceConfig;
  // на майбутнє можна додати сюди інші фіксовані доплати:
  // logistics?: number;
  // etc...
};

// keys in SETTINGS sheet
export const SETTINGS_KEYS = {
  ROAD_ALLOWANCE_S: "ROAD_ALLOWANCE_S",
  ROAD_ALLOWANCE_M: "ROAD_ALLOWANCE_M",
  ROAD_ALLOWANCE_L: "ROAD_ALLOWANCE_L",
  ROAD_ALLOWANCE_XL: "ROAD_ALLOWANCE_XL",
} as const;

/**
 * Читає фіксовані суми доплат з SETTINGS.
 * Якщо ключа нема або там сміття — повертає 0 (safe default).
 */
export async function getFixedAllowances(): Promise<FixedAllowances> {
  // 1 раз зчитуємо settings (щоб не дергати Sheet 4 рази)
  const rows = await fetchSettings();
  const kv = new Map<string, string>();
  for (const r of rows) kv.set(r.key, r.value);

  const num = (k: string) => {
    const n = parseNumber(kv.get(k));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };

  return {
    road: {
      S: num(SETTINGS_KEYS.ROAD_ALLOWANCE_S),
      M: num(SETTINGS_KEYS.ROAD_ALLOWANCE_M),
      L: num(SETTINGS_KEYS.ROAD_ALLOWANCE_L),
      XL: num(SETTINGS_KEYS.ROAD_ALLOWANCE_XL),
    },
  };
}
