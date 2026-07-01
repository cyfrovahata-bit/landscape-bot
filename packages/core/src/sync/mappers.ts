import { getCell, loadSheet } from "../google/sheets.js";
import { toBool, parseNumber } from "../google/utils.js";
import {
  SHEET_NAMES,
  USERS_HEADERS,
  EMP_HEADERS,
  OBJECTS_HEADERS,
  WORKS_HEADERS,
  CARS_HEADERS,
  MATERIALS_HEADERS,
  TOOLS_HEADERS,
  SETTINGS_HEADERS,
  EVENTS_HEADERS,
  ODOMETER_HEADERS,
  ALLOWANCES_HEADERS,
  DAY_STATUS_HEADERS,
  MATERIALS_MOVE_HEADERS,
  TOOLS_MOVE_HEADERS,
} from "../google/names.js";

function toBigIntOrNull(v: string): bigint | null {
  if (!v) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function toDateOrNull(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function readUsers() {
  const { data, map } = await loadSheet(SHEET_NAMES.users);
  return data
    .map((row) => ({
      tgId: toBigIntOrNull(getCell(row, map, USERS_HEADERS.tgId)),
      username: getCell(row, map, USERS_HEADERS.username) || null,
      pib: getCell(row, map, USERS_HEADERS.pib),
      role: getCell(row, map, USERS_HEADERS.role),
      active: toBool(getCell(row, map, USERS_HEADERS.active)),
      comment: getCell(row, map, USERS_HEADERS.comment) || null,
    }))
    .filter((r) => r.tgId !== null) as any[];
}

export async function readEmployees() {
  const { data, map } = await loadSheet(SHEET_NAMES.employees);
  return data
    .map((row) => ({
      id: getCell(row, map, EMP_HEADERS.id),
      name: getCell(row, map, EMP_HEADERS.name),
      brigadeId: getCell(row, map, EMP_HEADERS.brigadeId) || null,
      position: getCell(row, map, EMP_HEADERS.position) || null,
      active: toBool(getCell(row, map, EMP_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readObjects() {
  const { data, map } = await loadSheet(SHEET_NAMES.objects);
  return data
    .map((row) => ({
      id: getCell(row, map, OBJECTS_HEADERS.id),
      name: getCell(row, map, OBJECTS_HEADERS.name),
      address: getCell(row, map, OBJECTS_HEADERS.address) || null,
      active: toBool(getCell(row, map, OBJECTS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readWorks() {
  const { data, map } = await loadSheet(SHEET_NAMES.works);
  return data
    .map((row) => ({
      id: getCell(row, map, WORKS_HEADERS.id),
      name: getCell(row, map, WORKS_HEADERS.name),
      category: getCell(row, map, WORKS_HEADERS.category) || null,
      unit: getCell(row, map, WORKS_HEADERS.unit) || null,
      tariff: parseNumber(getCell(row, map, WORKS_HEADERS.tariff)) ?? 0,
      active: toBool(getCell(row, map, WORKS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readCars() {
  const { data, map } = await loadSheet(SHEET_NAMES.cars);
  return data
    .map((row) => ({
      id: getCell(row, map, CARS_HEADERS.id),
      name: getCell(row, map, CARS_HEADERS.name),
      plate: getCell(row, map, CARS_HEADERS.plate) || null,
      active: toBool(getCell(row, map, CARS_HEADERS.active)),
    }))
    .filter((r) => r.id);
}

export async function readMaterials() {
  const { data, map } = await loadSheet(SHEET_NAMES.materials);
  return data
    .map((row) => ({
      id: getCell(row, map, MATERIALS_HEADERS.id),
      name: getCell(row, map, MATERIALS_HEADERS.name),
      unit: getCell(row, map, MATERIALS_HEADERS.unit),
      active: toBool(getCell(row, map, MATERIALS_HEADERS.active)),
      category: getCell(row, map, MATERIALS_HEADERS.category) || null,
      comment: getCell(row, map, MATERIALS_HEADERS.comment) || null,
    }))
    .filter((r) => r.id);
}

export async function readTools() {
  const { data, map } = await loadSheet(SHEET_NAMES.tools);
  return data
    .map((row) => ({
      id: getCell(row, map, TOOLS_HEADERS.id),
      name: getCell(row, map, TOOLS_HEADERS.name),
      active: toBool(getCell(row, map, TOOLS_HEADERS.active)),
      category: getCell(row, map, TOOLS_HEADERS.category) || null,
      comment: getCell(row, map, TOOLS_HEADERS.comment) || null,
    }))
    .filter((r) => r.id);
}

export async function readSettings() {
  const { data, map } = await loadSheet(SHEET_NAMES.settings);
  return data
    .map((row) => ({
      key: getCell(row, map, SETTINGS_HEADERS.key),
      value: getCell(row, map, SETTINGS_HEADERS.value),
      comment: getCell(row, map, SETTINGS_HEADERS.comment) || null,
    }))
    .filter((r) => r.key);
}

export async function readEvents() {
  const { data, map } = await loadSheet(SHEET_NAMES.events);
  return data
    .map((row) => ({
      eventId: getCell(row, map, EVENTS_HEADERS.eventId),
      status: getCell(row, map, EVENTS_HEADERS.status) || "АКТИВНА",
      refEventId: getCell(row, map, EVENTS_HEADERS.refEventId) || null,
      chatId: toBigIntOrNull(getCell(row, map, EVENTS_HEADERS.chatId)),
      ts: toDateOrNull(getCell(row, map, EVENTS_HEADERS.ts)) ?? new Date(),
      date: getCell(row, map, EVENTS_HEADERS.date),
      foremanTgId: toBigIntOrNull(getCell(row, map, EVENTS_HEADERS.foremanTgId)) ?? BigInt(0),
      type: getCell(row, map, EVENTS_HEADERS.type),
      objectId: getCell(row, map, EVENTS_HEADERS.objectId) || null,
      carId: getCell(row, map, EVENTS_HEADERS.carId) || null,
      employeeIds: getCell(row, map, EVENTS_HEADERS.employeeIds) || null,
      payload: getCell(row, map, EVENTS_HEADERS.payload) || null,
      msgId: (() => {
        const n = parseNumber(getCell(row, map, EVENTS_HEADERS.msgId));
        return n === null ? null : Math.trunc(n);
      })(),
    }))
    .filter((r) => r.eventId);
}

export async function readOdometerDays() {
  const { data, map } = await loadSheet(SHEET_NAMES.odometerDay);
  return data
    .map((row) => ({
      date: getCell(row, map, ODOMETER_HEADERS.date),
      carId: getCell(row, map, ODOMETER_HEADERS.carId),
      foremanTgId: toBigIntOrNull(getCell(row, map, ODOMETER_HEADERS.foremanTgId)) ?? BigInt(0),
      startValue: parseNumber(getCell(row, map, ODOMETER_HEADERS.startValue)),
      startPhoto: getCell(row, map, ODOMETER_HEADERS.startPhoto) || null,
      endValue: parseNumber(getCell(row, map, ODOMETER_HEADERS.endValue)),
      endPhoto: getCell(row, map, ODOMETER_HEADERS.endPhoto) || null,
      kmDay: parseNumber(getCell(row, map, ODOMETER_HEADERS.kmDay)),
      tripClass: getCell(row, map, ODOMETER_HEADERS.tripClass) || null,
    }))
    .filter((r) => r.date && r.carId);
}

export async function readAllowances() {
  const { data, map } = await loadSheet(SHEET_NAMES.allowances);
  return data
    .map((row) => ({
      date: getCell(row, map, ALLOWANCES_HEADERS.date),
      objectId: getCell(row, map, ALLOWANCES_HEADERS.objectId) || null,
      foremanTgId: toBigIntOrNull(getCell(row, map, ALLOWANCES_HEADERS.foremanTgId)) ?? BigInt(0),
      type: getCell(row, map, ALLOWANCES_HEADERS.type),
      employeeId: getCell(row, map, ALLOWANCES_HEADERS.employeeId),
      employeeName: getCell(row, map, ALLOWANCES_HEADERS.employeeName),
      amount: parseNumber(getCell(row, map, ALLOWANCES_HEADERS.amount)) ?? 0,
      meta: getCell(row, map, ALLOWANCES_HEADERS.meta) || null,
      dayStatus: getCell(row, map, ALLOWANCES_HEADERS.dayStatus) || "ЧЕРНЕТКА",
    }))
    .filter((r) => r.date && r.employeeId);
}

export async function readDayStatuses() {
  const { data, map } = await loadSheet(SHEET_NAMES.dayStatus);
  return data
    .map((row) => ({
      date: getCell(row, map, DAY_STATUS_HEADERS.date),
      objectId: getCell(row, map, DAY_STATUS_HEADERS.objectId),
      foremanTgId: toBigIntOrNull(getCell(row, map, DAY_STATUS_HEADERS.foremanTgId)) ?? BigInt(0),
      status: getCell(row, map, DAY_STATUS_HEADERS.status) || "ЧЕРНЕТКА",
      hasTimesheet: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasTimesheet)),
      hasReports: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasReports)),
      hasReportsVolumeOk: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasReportsVolumeOk)),
      hasRoad: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasRoad)),
      hasOdoStart: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasOdoStart)),
      hasOdoEnd: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasOdoEnd)),
      hasOdoStartPhoto: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasOdoStartPhoto)),
      hasOdoEndPhoto: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasOdoEndPhoto)),
      hasLogistics: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasLogistics)),
      hasMaterials: toBool(getCell(row, map, DAY_STATUS_HEADERS.hasMaterials)),
      returnReason: getCell(row, map, DAY_STATUS_HEADERS.returnReason) || null,
      approvedBy: getCell(row, map, DAY_STATUS_HEADERS.approvedBy) || null,
      approvedAt: toDateOrNull(getCell(row, map, DAY_STATUS_HEADERS.approvedAt)),
    }))
    .filter((r) => r.date && r.objectId);
}

export async function readMaterialMoves() {
  const { data, map } = await loadSheet(SHEET_NAMES.materialsMove);
  return data
    .map((row) => ({
      moveId: getCell(row, map, MATERIALS_MOVE_HEADERS.moveId),
      time: getCell(row, map, MATERIALS_MOVE_HEADERS.time),
      date: getCell(row, map, MATERIALS_MOVE_HEADERS.date),
      objectId: getCell(row, map, MATERIALS_MOVE_HEADERS.objectId),
      foremanTgId: toBigIntOrNull(getCell(row, map, MATERIALS_MOVE_HEADERS.foremanTgId)) ?? BigInt(0),
      materialId: getCell(row, map, MATERIALS_MOVE_HEADERS.materialId),
      materialName: getCell(row, map, MATERIALS_MOVE_HEADERS.materialName),
      qty: parseNumber(getCell(row, map, MATERIALS_MOVE_HEADERS.qty)),
      unit: getCell(row, map, MATERIALS_MOVE_HEADERS.unit),
      moveType: getCell(row, map, MATERIALS_MOVE_HEADERS.moveType),
      purpose: getCell(row, map, MATERIALS_MOVE_HEADERS.purpose) || null,
      photos: getCell(row, map, MATERIALS_MOVE_HEADERS.photos) || null,
      payload: getCell(row, map, MATERIALS_MOVE_HEADERS.payload) || null,
      dayStatus: getCell(row, map, MATERIALS_MOVE_HEADERS.dayStatus) || null,
    }))
    .filter((r) => r.moveId);
}

export async function readToolMoves() {
  const { data, map } = await loadSheet(SHEET_NAMES.toolsMove);
  return data
    .map((row) => ({
      moveId: getCell(row, map, TOOLS_MOVE_HEADERS.moveId),
      time: getCell(row, map, TOOLS_MOVE_HEADERS.time),
      date: getCell(row, map, TOOLS_MOVE_HEADERS.date),
      foremanTgId: toBigIntOrNull(getCell(row, map, TOOLS_MOVE_HEADERS.foremanTgId)) ?? BigInt(0),
      toolId: getCell(row, map, TOOLS_MOVE_HEADERS.toolId),
      toolName: getCell(row, map, TOOLS_MOVE_HEADERS.toolName),
      qty: parseNumber(getCell(row, map, TOOLS_MOVE_HEADERS.qty)) ?? 0,
      moveType: getCell(row, map, TOOLS_MOVE_HEADERS.moveType),
      purpose: getCell(row, map, TOOLS_MOVE_HEADERS.purpose) || null,
      photos: getCell(row, map, TOOLS_MOVE_HEADERS.photos) || null,
      payload: getCell(row, map, TOOLS_MOVE_HEADERS.payload) || null,
    }))
    .filter((r) => r.moveId);
}
