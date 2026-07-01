import type { TripClass } from "./utils.js";

export type Role = "БРИГАДИР" | "СТАРШИЙ" | "АДМІН";
export type EventStatus = "АКТИВНА" | "ЗАТВЕРДЖЕНО" | "ПОВЕРНУТО" | "СКАСОВАНО";

export type Category = string; // з Sheets: "Земля", "Полив", "Електрика", ...

export type DayChecklist = {
  hasTimesheet: boolean;
  hasReports: boolean;

  hasReportsVolumeOk: boolean;
  hasReportsMissingQty: boolean;

  hasRoad: boolean;

  hasOdoStart: boolean;
  hasOdoEnd: boolean;
  hasOdoStartPhoto: boolean;
  hasOdoEndPhoto: boolean;

  hasLogistics: boolean;
  hasMaterials: boolean;
};

export type SettingsRow = {
  key: string;
  value: string;      
  comment?: string;
};

export type UserRow = {
  tgId: number;
  username?: string;
  pib: string;
  role: Role;
  active: boolean;
  comment?: string;
};


export type PayrollRole = "WORKER" | "BRIGADIER" | "SENIOR";
export type EmployeeRow = {
  id: string;
  name: string;
  brigadeId?: string;
  position?: string;
  active: boolean;
};

export type ObjectRow = {
  id: string;
  name: string;
  address?: string;
  active: boolean;
};

export type WorkRow = {
  id: string;
  name: string;
  category?: Category;
  unit?: string;
  tariff: number;
  active: boolean;
};

export type CarRow = {
  id: string;
  name: string;
  plate?: string;
  active: boolean;
};

export type ReportRow = {
  date: string; // YYYY-MM-DD
  objectId: string;
  foremanTgId: number;
  workId: string;
  workName: string;
  volume?: string | number; // "", "?", число
  volumeStatus: "НЕ_ЗАПОВНЕНО" | "ЗАПОВНЕНО";
  photos?: string; // JSON або csv
  dayStatus: "ЧЕРНЕТКА" | "ЗДАНО" | "ПОВЕРНУТО" | "ЗАТВЕРДЖЕНО";
  createdAt?: string;
  updatedAt?: string;
};

export type TimesheetRow = {
  date: string;
  objectId: string;
  employeeId: string;
  employeeName: string;
  hours: number;
  source: string;
  updatedAt?: string;
  disciplineCoef?: number;
  productivityCoef?: number;
};

export type EventRow = {
  eventId: string;
  status: EventStatus;
  refEventId?: string;
  updatedAt?: string;
  chatId?: number;

  ts: string; // ISO datetime
  date: string; // YYYY-MM-DD
  foremanTgId: number;
  type: string;
  objectId?: string;
  carId?: string;
  employeeIds?: string; // JSON масив
  payload?: string; // JSON
  msgId?: number;
};

export type OdometerDayRow = {
  date: string;
  carId: string;
  foremanTgId: number;
  startValue?: number;
  startPhoto?: string;
  endValue?: number;
  endPhoto?: string;
  kmDay?: number;
  tripClass?: TripClass;
  updatedAt?: string;
};

export type AllowanceRow = {
  date: string;
  objectId?: string;
  foremanTgId: number;
  type: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  meta?: string;
  dayStatus: "ЧЕРНЕТКА" | "ЗДАНО" | "ПОВЕРНУТО" | "ЗАТВЕРДЖЕНО";
  updatedAt?: string;
};

export type DayStatusRow = {
  date: string;
  objectId: string;
  foremanTgId: number;
  status: "ЧЕРНЕТКА" | "ЗДАНО" | "ПОВЕРНУТО" | "ЗАТВЕРДЖЕНО";

  hasTimesheet: boolean;
  hasReports: boolean;

  // ✅ NEW
  hasReportsVolumeOk?: boolean;

  hasRoad: boolean;

  hasOdoStart: boolean;
  hasOdoEnd: boolean;

  // ✅ NEW
  hasOdoStartPhoto?: boolean;
  hasOdoEndPhoto?: boolean;

  hasLogistics: boolean;
  hasMaterials: boolean;

  returnReason?: string;
  approvedBy?: string;
  approvedAt?: string;
  updatedAt?: string;
};


export type ClosureRow = {
  date: string;
  objectId: string;
  foremanTgId: number;
  submittedAt: string;
  submittedBy: string;
  comment?: string;
};

export type MaterialRow = {
  id: string;
  name: string;
  unit: string;
  active: boolean;
  category?: Category;
  comment?: string;
};

export type ToolRow = {
  id: string;
  name: string;
  active: boolean;
  category?: Category;
  comment?: string;
};

export type MaterialMoveType = "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
export type ToolMoveType = "ISSUE" | "RETURN" | "BROKEN" | "LOST" | "FOUND" | "ADJUST";

export type MaterialMoveRow = {
  moveId: string;
  time: string;
  date: string;
  objectId: string;
  foremanTgId: number;
  materialId: string;
  materialName: string;
  qty: number | null;
  unit: string;
  moveType: MaterialMoveType;
  purpose?: string;
  photos?: string;   // text/json
  payload?: string;  // JSON string
  dayStatus?: string;
  updatedAt: string;
};

export type ToolMoveRow = {
  moveId: string;
  time: string;
  date: string;
  foremanTgId: number;
  toolId: string;
  toolName: string;
  qty: number;
  moveType: ToolMoveType;
  purpose?: string;
  photos?: string;
  payload?: string;
  updatedAt: string;
};
