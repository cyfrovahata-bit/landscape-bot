import { fetchEvents } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";

type AnyEvent = any;

type CarDayStat = {
  carId: string;
  objectIds: string[];
  employeeIds: string[];
  currentEmployeeIds: string[];
  odoStartKm?: number;
  odoEndKm?: number;
  roadSec: number;
  statusNow: string;
  whereNowObjectId?: string;
  lastEventType?: string;
  lastEventId?: string;
  lastDriveEventId?: string;
  lastReturnEventId?: string;
  isOnBase?: boolean;
};

type EmployeeDayStat = {
  employeeId: string;
  objectIds: string[];
  carIds: string[];
  secByObject: Record<string, number>;
  statusNow: string;
  whereNowObjectId?: string;
  whereNowCarId?: string;
  currentWorkId?: string;
  currentWorkName?: string;
  lastEventType?: string;
  lastEventId?: string;
};

type ObjectDayStat = {
  objectId: string;
  employeeIds: string[];
  carIds: string[];
  secByEmployee: Record<string, number>;
  statusDay: string;
  statusNow: string;
  workingEmployeeIds: string[];
  presentEmployeeIds: string[];
  lastCarId?: string;
};

type LogisticsDayStat = {
  logisticId: string;
  logisticName: string;
  qty: number;
  employeeIds: string[];
  approvedAmount: number;
  statusCounts: Record<string, number>;
};

export type RoadDayStats = {
  events: AnyEvent[];
  cars: Record<string, CarDayStat>;
  employees: Record<string, EmployeeDayStat>;
  objects: Record<string, ObjectDayStat>;
  logistics: Record<string, LogisticsDayStat>;
};

function parsePayload(raw: any) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

function csvToIds(v: string): string[] {
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqPush(arr: string[], value?: string) {
  const v = String(value ?? "").trim();
  if (!v) return;
  if (!arr.includes(v)) arr.push(v);
}

function getEventTsMs(e: any): number {
  const ms = Date.parse(String(e?.ts ?? e?.updatedAt ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeDayStatus(raw?: string) {
  return String(raw ?? "").trim().toUpperCase();
}

function isIgnoredSaveStatus(raw?: string) {
  const s = normalizeDayStatus(raw);
  return s === "ПОВЕРНУТО" || s === "СКАСОВАНО";
}

function detectCarStatusFromType(type: string): string {
  const t = String(type ?? "").trim().toUpperCase();

  if (t === "RTS_SETUP_CAR") return "ПІДГОТОВКА";
  if (t === "RTS_ODO_START") return "В ДОРОЗІ";
  if (t === "RTS_DRIVE_START") return "В ДОРОЗІ";
  if (t === "RTS_DRIVE_RESUME") return "В ДОРОЗІ";
  if (t === "RTS_DRIVE_PAUSE") return "НА ОБʼЄКТІ";
  if (t === "RTS_ARRIVE_OBJECT") return "НА ОБʼЄКТІ";
  if (t === "RTS_DAY_FINISH") return "ГОТОВА ДО ПОВЕРНЕННЯ";
  if (t === "RTS_RETURN_START") return "ПОВЕРТАЄТЬСЯ НА БАЗУ";
  if (t === "RTS_RETURN_STOP") return "НА БАЗІ";
  if (t === "RTS_ODO_END") return "НА БАЗІ";
  if (t === "ROAD_END") return "ДЕНЬ ЗАВЕРШЕНО";
  if (t === "RTS_SAVE") return "ДЕНЬ ЗБЕРЕЖЕНО";
  return "—";
}

function detectEmployeeStatusFromType(type: string): string {
  const t = String(type ?? "").trim().toUpperCase();

  if (t === "RTS_PICK_UP") return "В МАШИНІ";
  if (t === "RTS_DROP_OFF") return "НА ОБʼЄКТІ";
  if (t === "RTS_OBJ_WORK_START") return "ПРАЦЮЄ";
  if (t === "RTS_OBJ_WORK_STOP") return "НА ОБʼЄКТІ";
  if (t === "RTS_RETURN_START") return "ПОВЕРТАЄТЬСЯ";
  if (t === "RTS_RETURN_STOP") return "НА БАЗІ";
  if (t === "ROAD_END") return "ДЕНЬ ЗАВЕРШЕНО";
  if (t === "RTS_SAVE") return "ДЕНЬ ЗБЕРЕЖЕНО";
  return "—";
}

function detectObjectStatusFromType(type: string): string {
  const t = String(type ?? "").trim().toUpperCase();

  if (t === "RTS_ARRIVE_OBJECT") return "Є ЛЮДИ НА ОБʼЄКТІ";
  if (t === "RTS_DROP_OFF") return "Є ЛЮДИ НА ОБʼЄКТІ";
  if (t === "RTS_OBJ_WORK_START") return "ВИКОНУЮТЬ РОБОТИ";
  if (t === "RTS_OBJ_WORK_STOP") return "РОБОТИ ПРИЗУПИНЕНО";
  if (t === "RTS_PICK_UP") return "ЛЮДЕЙ ЗАБРАЛИ";
  if (t === "ROAD_END") return "ДЕНЬ ЗАВЕРШЕНО";
  return "—";
}

export async function buildRoadDayStats(args: {
  date: string;
  foremanTgId: number;
}) : Promise<RoadDayStats> {
  const { date, foremanTgId } = args;

  const events = await fetchEvents({
  date,
  foremanTgId,
});
  const rows = [...(events ?? [])]
    .filter((e: any) => {
      const type = String(e.type ?? "");
      if ((type === "ROAD_END" || type === "RTS_SAVE") && isIgnoredSaveStatus(e.status)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => getEventTsMs(a) - getEventTsMs(b));

  console.log("[RTS_STATS][DAY_DATA]", {
    date,
    foremanTgId,
    eventsFetched: events?.length ?? 0,
    eventsUsed: rows.length,
    ignoredReturnedSaves: (events ?? []).length - rows.length,
    firstEventId: rows[0]?.eventId ?? "",
    lastEventId: rows[rows.length - 1]?.eventId ?? "",
    lastType: rows[rows.length - 1]?.type ?? "",
    lastStatus: rows[rows.length - 1]?.status ?? "",
  });

  const cars: Record<string, CarDayStat> = {};
  const employees: Record<string, EmployeeDayStat> = {};
  const objects: Record<string, ObjectDayStat> = {};
  const logistics: Record<string, LogisticsDayStat> = {};

  const openWork = new Map<string, number>(); // emp||obj||work -> startMs

  const ensureCar = (carId: string): CarDayStat => {
    if (!cars[carId]) {
      cars[carId] = {
        carId,
        objectIds: [],
        employeeIds: [],
        currentEmployeeIds: [],
        roadSec: 0,
        statusNow: "—",
      };
    }
    return cars[carId];
  };

  const ensureEmployee = (employeeId: string): EmployeeDayStat => {
    if (!employees[employeeId]) {
      employees[employeeId] = {
        employeeId,
        objectIds: [],
        carIds: [],
        secByObject: {},
        statusNow: "—",
      };
    }
    return employees[employeeId];
  };

const ensureObject = (objectId: string): ObjectDayStat => {
  if (!objects[objectId]) {
    objects[objectId] = {
      objectId,
      employeeIds: [],
      carIds: [],
      secByEmployee: {},
      statusDay: "",
      statusNow: "—",
      workingEmployeeIds: [],
      presentEmployeeIds: [],
    };
  }
  return objects[objectId];
};

  for (const e of rows) {
    const type = String(e.type ?? "");
    const objectId = String(e.objectId ?? "").trim();
    const carId = String(e.carId ?? "").trim();
    const payload = parsePayload(e.payload);
    const employeeIds = [
      ...new Set([
        ...csvToIds(String(e.employeeIds ?? "")),
        ...(
          Array.isArray(payload.employeeIds)
            ? payload.employeeIds.map((x: any) => String(x ?? "").trim()).filter(Boolean)
            : []
        ),
      ]),
    ];

if (carId) {
  const car = ensureCar(carId);

  if (objectId) uniqPush(car.objectIds, objectId);
  for (const empId of employeeIds) uniqPush(car.employeeIds, empId);

  car.lastEventType = type;
  car.lastEventId = String(e.eventId ?? "");
  car.statusNow = detectCarStatusFromType(type);

  if (type === "RTS_PICK_UP" || type === "RTS_ODO_START" || type === "RTS_DRIVE_START" || type === "RTS_DRIVE_RESUME" || type === "RTS_RETURN_START") {
    for (const empId of employeeIds) uniqPush(car.currentEmployeeIds, empId);
  }

  if (type === "RTS_DROP_OFF") {
    car.currentEmployeeIds = car.currentEmployeeIds.filter((id) => !employeeIds.includes(id));
  }

  if (type === "RTS_RETURN_STOP" || type === "RTS_ODO_END") {
    car.currentEmployeeIds = [];
  }

  if (
    type === "RTS_ARRIVE_OBJECT" ||
    type === "RTS_DROP_OFF" ||
    type === "RTS_OBJ_WORK_START" ||
    type === "RTS_OBJ_WORK_STOP"
  ) {
    if (objectId) car.whereNowObjectId = objectId;
    car.isOnBase = false;
  }

  if (
    type === "RTS_DRIVE_START" ||
    type === "RTS_DRIVE_RESUME" ||
    type === "RTS_RETURN_START" ||
    type === "RTS_ODO_START"
  ) {
    car.lastDriveEventId = String(e.eventId ?? "");
    delete car.whereNowObjectId;
    car.isOnBase = false;
  }

  if (
    type === "RTS_RETURN_STOP" ||
    type === "RTS_ODO_END"
  ) {
    car.lastReturnEventId = String(e.eventId ?? "");
    delete car.whereNowObjectId;
    car.isOnBase = true;
  }

  if (type === "RTS_ODO_START" && Number.isFinite(Number(payload?.odoStartKm))) {
    car.odoStartKm = Number(payload.odoStartKm);
  }

  if (type === "RTS_ODO_END" && Number.isFinite(Number(payload?.odoEndKm))) {
    car.odoEndKm = Number(payload.odoEndKm);
  }
}

if (objectId) {
  const obj = ensureObject(objectId);

  if (carId) {
    uniqPush(obj.carIds, carId);
    obj.lastCarId = carId;
  }

  for (const empId of employeeIds) uniqPush(obj.employeeIds, empId);

  obj.statusNow = detectObjectStatusFromType(type);

  if (type === "RTS_DROP_OFF") {
    for (const empId of employeeIds) uniqPush(obj.presentEmployeeIds, empId);
  }

  if (type === "RTS_PICK_UP") {
    obj.presentEmployeeIds = obj.presentEmployeeIds.filter(
      (id) => !employeeIds.includes(id),
    );
    obj.workingEmployeeIds = obj.workingEmployeeIds.filter(
      (id) => !employeeIds.includes(id),
    );
  }

  if (type === "RTS_OBJ_WORK_START") {
    for (const empId of employeeIds) uniqPush(obj.presentEmployeeIds, empId);
    for (const empId of employeeIds) uniqPush(obj.workingEmployeeIds, empId);
  }

  if (type === "RTS_OBJ_WORK_STOP") {
    obj.workingEmployeeIds = obj.workingEmployeeIds.filter(
      (id) => !employeeIds.includes(id),
    );
  }
}

for (const empId of employeeIds) {
  const emp = ensureEmployee(empId);

  if (objectId) uniqPush(emp.objectIds, objectId);
  if (carId) uniqPush(emp.carIds, carId);

  emp.lastEventType = type;
  emp.lastEventId = String(e.eventId ?? "");
  emp.statusNow = detectEmployeeStatusFromType(type);

  if (type === "RTS_PICK_UP") {
    if (carId) emp.whereNowCarId = carId;
    delete emp.whereNowObjectId;
    delete emp.currentWorkId;
    delete emp.currentWorkName;
  }

  if (type === "RTS_DROP_OFF") {
    if (objectId) emp.whereNowObjectId = objectId;
    delete emp.whereNowCarId;
    delete emp.currentWorkId;
    delete emp.currentWorkName;
  }

  if (type === "RTS_OBJ_WORK_START") {
    if (objectId) emp.whereNowObjectId = objectId;
    delete emp.whereNowCarId;
    emp.currentWorkId = String(payload?.workId ?? "");
    emp.currentWorkName = String(payload?.workName ?? payload?.workId ?? "");
  }

  if (type === "RTS_OBJ_WORK_STOP") {
    if (objectId) emp.whereNowObjectId = objectId;
    delete emp.currentWorkId;
    delete emp.currentWorkName;
  }

  if (type === "RTS_RETURN_START") {
    if (carId) emp.whereNowCarId = carId;
    delete emp.whereNowObjectId;
    delete emp.currentWorkId;
    delete emp.currentWorkName;
  }

  if (type === "RTS_RETURN_STOP" || type === "RTS_ODO_END") {
    delete emp.whereNowCarId;
    delete emp.whereNowObjectId;
    delete emp.currentWorkId;
    delete emp.currentWorkName;
  }
}

    if (type === "RTS_OBJ_WORK_START") {
      const workId = String(payload.workId ?? "");
      const targetEmpId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const ms = getEventTsMs(e);
      if (targetEmpId && objectId && workId && ms > 0) {
        openWork.set(`${targetEmpId}||${objectId}||${workId}`, ms);
      }
      continue;
    }

    if (type === "RTS_OBJ_WORK_STOP") {
      const workId = String(payload.workId ?? "");
      const targetEmpId = String(payload.employeeId ?? employeeIds[0] ?? "");
      const endMs = getEventTsMs(e);
      const key = `${targetEmpId}||${objectId}||${workId}`;
      const startMs = openWork.get(key);

      if (targetEmpId && objectId && startMs && endMs >= startMs) {
        const sec = Math.floor((endMs - startMs) / 1000);

        const emp = ensureEmployee(targetEmpId);
        emp.secByObject[objectId] = (emp.secByObject[objectId] ?? 0) + sec;

        const obj = ensureObject(objectId);
        obj.secByEmployee[targetEmpId] = (obj.secByEmployee[targetEmpId] ?? 0) + sec;

        if (carId) {
          const car = ensureCar(carId);
          if (type === "RTS_OBJ_WORK_STOP") {
            car.whereNowObjectId = objectId;
          }
        }
      }

      openWork.delete(key);
      continue;
    }

    if (type === "ROAD_END") {
      if (carId) {
        const car = ensureCar(carId);
        if (Number.isFinite(Number(payload?.roadSec))) {
          car.roadSec += Number(payload.roadSec);
        }
      }
    }

    if (type === "ЛОГІСТИКА") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const it of items) {
        const logisticId = String(it.logisticId ?? "").trim();
        if (!logisticId) continue;

        if (!logistics[logisticId]) {
          logistics[logisticId] = {
            logisticId,
            logisticName: String(it.logisticName ?? logisticId),
            qty: 0,
            employeeIds: [],
            approvedAmount: 0,
            statusCounts: {},
          };
        }

        const row = logistics[logisticId];
        row.qty += Number(it.qty ?? 0);
        row.logisticName = String(it.logisticName ?? row.logisticName);

        const eventStatus = String(e.status ?? "").trim() || "—";
        row.statusCounts[eventStatus] = (row.statusCounts[eventStatus] ?? 0) + 1;

        const itEmpIds = Array.isArray(it.employeeIds) ? it.employeeIds : [];
        for (const empId of itEmpIds) uniqPush(row.employeeIds, String(empId));

        if (eventStatus.toUpperCase() === "ЗАТВЕРДЖЕНО") {
          row.approvedAmount += Number(it.qty ?? 0) * Number(it.tariff ?? 0);
        }
      }
    }
  }








  const nowMs = Date.now();
  for (const [key, startMs] of openWork.entries()) {
    const [employeeId, objectId] = key.split("||");
    if (!employeeId || !objectId) continue;
    if (!Number.isFinite(startMs) || nowMs < startMs) continue;

    const sec = Math.floor((nowMs - startMs) / 1000);

    const emp = ensureEmployee(employeeId);
    emp.secByObject[objectId] = (emp.secByObject[objectId] ?? 0) + sec;

    const obj = ensureObject(objectId);
    obj.secByEmployee[employeeId] = (obj.secByEmployee[employeeId] ?? 0) + sec;
  }

  await Promise.all(
    Object.keys(objects).map(async (objectId) => {
      try {
        const ds = await getDayStatusRow(date, objectId, foremanTgId);
        objects[objectId]!.statusDay = normalizeDayStatus(ds?.status);
      } catch {
        objects[objectId]!.statusDay = "";
      }
    })
  );

for (const car of Object.values(cars)) {
  if (car.isOnBase) {
    car.statusNow = "НА БАЗІ";
  } else if (car.whereNowObjectId) {
    if (
      String(car.statusNow) === "НА ОБʼЄКТІ" ||
      String(car.statusNow) === "ВИКОНУЮТЬ РОБОТИ"
    ) {
      car.statusNow = "НА ОБʼЄКТІ";
    }
  }
}

for (const emp of Object.values(employees)) {
  if (emp.currentWorkId) {
    emp.statusNow = "ПРАЦЮЄ";
  } else if (emp.whereNowObjectId) {
    emp.statusNow = "НА ОБʼЄКТІ";
  } else if (emp.whereNowCarId) {
    emp.statusNow = "В МАШИНІ";
  } else if (
    emp.lastEventType === "RTS_RETURN_STOP" ||
    emp.lastEventType === "RTS_ODO_END"
  ) {
    emp.statusNow = "НА БАЗІ";
  }
}

for (const obj of Object.values(objects)) {
  if ((obj.workingEmployeeIds ?? []).length > 0) {
    obj.statusNow = "ВИКОНУЮТЬ РОБОТИ";
  } else if ((obj.presentEmployeeIds ?? []).length > 0) {
    obj.statusNow = "Є ЛЮДИ НА ОБʼЄКТІ";
  } else if (String(obj.statusDay ?? "").trim()) {
    obj.statusNow = "РОБОТИ ЗАВЕРШЕНО";
  }
}


  return { events: rows, cars, employees, objects, logistics };
}
