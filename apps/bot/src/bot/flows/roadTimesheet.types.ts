import type { FlowBaseState } from "../core/flowTypes.js";
import type TelegramBot from "node-telegram-bot-api";


export type Step =
  | "START"
  | "PICK_CAR"
  | "ODO_START"
  | "BULK_QTY"
  | "ODO_START_PHOTO"
  | "PICK_OBJECTS"
  | "OBJECT_PLAN_MENU"     // список planned об’єктів
  | "PLAN_WORKS_PICK"      // вибір робіт з довідника для конкретного об’єкта
  | "PLAN_ASSIGN_MENU"     // призначення робіт людям (опціонально, для кнопок RUN)
  | "PLAN_ASSIGN_EMP"
  | "READY_TO_START"
  | "RUN_DRIVE"
  | "PAUSED_PICK_OBJECT"   // пауза: вибір об’єкта “куди приїхали”
  | "AT_OBJECT_MENU"       // на об’єкті: дроп/пік, старт робіт
  | "AT_OBJECT_DROP_PICK"  // список людей “в машині” (toggle)
  | "AT_OBJECT_RUN"        // RUN робіт на об’єкті
  | "RETURN_MENU"
  | "RETURN_PICK_OBJECT"   // об’єкт для забору людей
  | "RETURN_PICKUP_DROP"   // забрати/зняти при поверненні
  | "ODO_END"
  | "PICK_PEOPLE"
  | "ODO_END_PHOTO"
  | "SAVE"
  | "STATS_MENU"
  | "STATS_CARS"
  | "STATS_OBJECTS"
  | "STATS_PEOPLE"
  | "STATS_CAR_VIEW"
  | "STATS_OBJECT_VIEW"
  | "QTY_MENU"
  | "OBJ_MONITOR_OBJECT"
  | "AT_OBJECT_EMP_SESSIONS"
  | "BULK_COEF_DISC"
  | "BULK_COEF_PROD"
  | "STATS_PERSON_VIEW";
  
export type RoadPhase =
  | "SETUP"
  | "DRIVE_DAY"
  | "PAUSED_AT_OBJECT"
  | "WORKING_AT_OBJECT"
  | "WAIT_RETURN"
  | "RETURN_DRIVE"
  | "FINISHED";

export type RtsType =
  | "RTS_SETUP_CAR"
  | "RTS_ODO_START"
  | "RTS_ODO_START_PHOTO"
  | "RTS_PLAN_OBJECTS"
  | "RTS_PLAN_WORKS"
  | "RTS_PLAN_ASSIGN"
  | "RTS_DRIVE_START"
  | "RTS_DRIVE_PAUSE"
  | "RTS_ARRIVE_OBJECT"
  | "RTS_DROP_OFF"
  | "RTS_PICK_UP"
  | "RTS_OBJ_WORK_START"
  | "RTS_OBJ_WORK_STOP"
  | "RTS_DRIVE_RESUME"
  | "RTS_DAY_FINISH"
  | "RTS_RETURN_START"
  | "RTS_RETURN_STOP"
  | "RTS_ODO_END"
  | "RTS_ODO_END_PHOTO"
  | "RTS_PAYROLL_INPUT"
  
  | "RTS_SAVE";  

export type DictObject = { id: string; name: string; address?: string; active?: boolean };
export type DictEmployee = { id: string; name: string; brigadeId?: string; position?: string; active?: boolean };
export type DictWork = { id: string; name: string; unit: string; rate: number; category?: string; active: boolean };
export type WorkItem = { workId: string; name: string; unit: string; rate: number };

export type PayrollEmpRow = {
  employeeId: string;
  employeeName: string;
  hours: number;                 // hoursRounded (work+road)
  disciplineCoef: number;        // 0.8/1.0
  productivityCoef: number;      // 1.0/1.2/1.5
  coefTotal: number;             // discipline * productivity
  points: number;                // hours * coefTotal
};

export type PayrollObjectPack = {
  objectId: string;
  objectName: string;
  rows: PayrollEmpRow[];
};

export type SalaryRow = {
  employeeId: string;
  employeeName: string;
  hours: number;
  points: number;
  pay: number;
};

export type SalaryPack = {
  objectId: string;
  objectName: string;
  objectTotal: number;
  sumPoints: number;
  rows: SalaryRow[];
};

export type OpenSession = {
  objectId: string;
  workId: string;
  employeeId: string;
  startedAt: string;
};

export type AggRow = {
  objectId: string;
  employeeId: string;
  sec: number;
  disciplineCoef: number;
  productivityCoef: number;
};

export type ObjectTS = {
  objectId: string;
  works: WorkItem[];
  assigned: Record<string, string[]>;

  open: OpenSession[];
  startedAt?: string;
  endedAt?: string;
  phase: "SETUP" | "RUN" | "FINISHED";

  coefDiscipline: Record<string, number>;
  coefProductivity: Record<string, number>;

  leftOnObjectIds: string[];
};

export type RoadMember = {
  employeeId: string;
  joinedAt: string; 
  leftAt?: string;  
};

export type State = FlowBaseState & {
  step: Step;
  date: string;
  foremanName?: string;
  pendingBulkCoef?: {
  objectId: string;
  employeeIds: string[];
  kind: "discipline" | "productivity";
  values: Record<string, number>;
  backStep: Step;
  afterSaveStep: Step;
};

  worksMeta?: DictWork[];
  qtyUnlocked?: boolean;

  employees?: DictEmployee[];
  carsMeta?: { id: string; name: string }[];
  objectsMeta?: DictObject[];

  uiMsgId?: number;
  activeEmployeeId?: string;

  carId?: string;

  phase: RoadPhase;

  odoStartKm?: number;
  odoStartPhotoFileId?: string;
  odoEndKm?: number;
  odoEndPhotoFileId?: string;

  plannedObjectIds: string[];
  objects: Record<string, ObjectTS>;
  activeObjectId?: string; 

  inCarIds: string[];
  members: RoadMember[];

  driveActive: boolean; 
  driveStartedAt?: string;
  driveStoppedAt?: string;

  returnActive: boolean;
  returnStartedAt?: string;
  returnStoppedAt?: string;

    statsScreen?: {
    text: string;
    kb: TelegramBot.InlineKeyboardMarkup;
    parse_mode?: TelegramBot.ParseMode;
  };

  pendingQty?: {
    objectId: string;
    employeeId: string;
    workId: string;
    workName: string;
    unit: string;
    rate: number;
    startedAt: string;
    
  };
  pendingBulkQty?: {
    objectId: string;
    endedAt: string;
    backStep?: Step;
    afterSaveStep?: Step;
    objectName?: string;
    payrollEventId?: string;
    sourceEventId?: string;
    employeeIds: string[];

    items: Array<{
      workId: string;
      workName: string;
      unit: string;
      rate: number;

      sessionsCount: number;

      sec: number;

      qty: number; 
    }>;
  };
  returnAfterPlanWorksStep?: Step;
  returnAfterPlanWorksPhase?: RoadPhase;
  returnAfterPlanWorksArrivedObjectId?: string;
  arrivedObjectId?: string;
};

export type PendingInput = {
  chatId: number;
  fromId: number;
  createdAt: number;
  timer: NodeJS.Timeout;
  listener: (msg: TelegramBot.Message) => Promise<void>;
};
