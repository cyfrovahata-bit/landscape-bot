import type { Flow } from "../core/flowTypes.js";


// =========================
// Consts / callbacks
// =========================

export const PREFIX = "rts:" as const;

export const cb = {
  MENU: `${PREFIX}menu`,
  BACK: `${PREFIX}back:`,
  RESET_STATE: `${PREFIX}reset_state`,
  RESET_STATE_CONFIRM: `${PREFIX}reset_state_confirm`,
  RESET_STATE_CANCEL: `${PREFIX}reset_state_cancel`,

  PICK_PEOPLE: `${PREFIX}pick_people`,
  EMP_TOGGLE: `${PREFIX}emp_toggle:`,
  PEOPLE_GROUP_OPEN: `${PREFIX}people_group:`,
  PEOPLE_GROUP_SELECT_ALL: `${PREFIX}people_group_all:`,
  PEOPLE_GROUP_CLEAR_ALL: `${PREFIX}people_group_clear:`,
  PEOPLE_TOGGLE: `${PREFIX}people_toggle:`,
  PEOPLE_GROUPS_BACK: `${PREFIX}people_groups_back`,
  PEOPLE_DONE: `${PREFIX}people_done`,

  REGISTER_ADMIN: "reg:admin:",
  REGISTER_FOREMAN: "reg:foreman:",
  REGISTER_REJECT: "reg:reject:",

  BULK_QTY_OPEN: `${PREFIX}bulk_qty_open`,
  BULK_QTY_WORK: `${PREFIX}bulk_qty_work:`,      // <workId>
  BULK_QTY_ADJ: `${PREFIX}bulk_qty_adj:`,        // <workId>:<delta>
  BULK_QTY_SAVE: `${PREFIX}bulk_qty_save`,
  BULK_QTY_BACK: `${PREFIX}bulk_qty_back`,

  BULK_QTY_CAT: `${PREFIX}bulk_qty_cat:`,
  BULK_QTY_ALL_CAT: `${PREFIX}bulk_qty_all_cat:`,

  ADM_APPROVE: `${PREFIX}adm:approve:`,
  ADM_RETURN: `${PREFIX}adm:return:`,
  ADM_RETURN_REASON: `${PREFIX}adm:return_reason:`, // ...:<eventId>:<code>
  ADM_RETURN_CANCEL: `${PREFIX}adm:return_cancel:`,

  PICK_CAR: `${PREFIX}pick_car`,
  CAR: `${PREFIX}car:`,

  ODO_START: `${PREFIX}odo_start`,
  ASK_ODO_START_KM: `${PREFIX}ask_odo_start_km`,
  ASK_ODO_START_PHOTO: `${PREFIX}ask_odo_start_photo`,
  SKIP_ODO_START_PHOTO: `${PREFIX}skip_odo_start_photo`,

  PICK_OBJECTS: `${PREFIX}pick_objs`,
  OBJ_TOGGLE: `${PREFIX}obj_toggle:`,
  OBJECT_GROUP_OPEN: `${PREFIX}object_group:`,
  OBJECT_GROUP_SELECT_ALL: `${PREFIX}object_group_all:`,
  OBJECT_GROUP_CLEAR_ALL: `${PREFIX}object_group_clear:`,
  OBJECT_TOGGLE: `${PREFIX}object_toggle:`,
  OBJECT_GROUP_OPEN_SHORT: `${PREFIX}og:`,
  OBJECT_GROUP_SELECT_ALL_SHORT: `${PREFIX}oga:`,
  OBJECT_GROUP_CLEAR_ALL_SHORT: `${PREFIX}ogc:`,
  OBJECT_TOGGLE_SHORT: `${PREFIX}ot:`,
  OBJECT_GROUPS_BACK: `${PREFIX}object_groups_back`,
  OBJECTS_DONE: `${PREFIX}objs_done`,
  

  PLAN_OBJECT_MENU: `${PREFIX}plan_obj_menu`,
  PLAN_OBJ: `${PREFIX}plan_obj:`,
  PLAN_WORKS: `${PREFIX}plan_works`,
  PLAN_WORK: `${PREFIX}plan_work:`,
  PLAN_WORK_CAT: `${PREFIX}plan_work_cat:`,
  PLAN_WORK_PAGE: `${PREFIX}plan_work_page:`,
  PLAN_WORK_ALL_CAT: `${PREFIX}plan_work_all_cat:`,
  PLAN_WORKS_DONE: `${PREFIX}plan_works_done`,
  PLAN_ASSIGN_MENU: `${PREFIX}plan_assign_menu`,
  PLAN_ASSIGN_EMP: `${PREFIX}plan_assign_emp:`,
  PLAN_ASSIGN_TOGGLE: `${PREFIX}plan_assign_toggle:`,
  PLAN_ASSIGN_DONE: `${PREFIX}plan_assign_done`,
  PICKUP_ALL_FROM_OBJECT: `${PREFIX}pickup_all_obj`,
  OBJ_MONITOR: `${PREFIX}OBJ_MONITOR`,
  OBJ_MONITOR_PICK: `${PREFIX}OBJ_MONITOR_PICK:`,
  MONITOR_ADD_WORKS: `${PREFIX}mon_add_works:`,
  BULK_DISC_DEC: `${PREFIX}bulk_disc_dec:`,
BULK_DISC_INC: `${PREFIX}bulk_disc_inc:`,
BULK_PROD_DEC: `${PREFIX}bulk_prod_dec:`,
BULK_PROD_INC: `${PREFIX}bulk_prod_inc:`,
BULK_COEF_DISC_SAVE: `${PREFIX}bulk_coef_disc_save`,
BULK_COEF_PROD_SAVE: `${PREFIX}bulk_coef_prod_save`,
BULK_COEF_BACK: `${PREFIX}bulk_coef_back`,

  READY: `${PREFIX}ready`,
  START_DAY: `${PREFIX}start_day`,
  QTY_MENU: `${PREFIX}qty_menu`,
  QTY_OBJ: `${PREFIX}qty_obj:`, // + objectId
  BULK_QTY_PICK: `${PREFIX}bulk_pick:`,
  EMP_SESSIONS: `${PREFIX}emp_sessions:`,
    EMP_STOP_ALL: `${PREFIX}emp_stop_all:`, // ✅ нове
    AT_OBJ_TOGGLE: `${PREFIX}AT_OBJ_TOGGLE`,

  MANAGE_PEOPLE: `${PREFIX}manage_people`,
  TOGGLE_IN_CAR: `${PREFIX}toggle_in_car:`,
  ADD_OBJECTS: `${PREFIX}add_objects`,
  PAUSE: `${PREFIX}pause`,                 // ⏸ зупинитись (час дороги стоп)
  RESUME: `${PREFIX}resume`,               // ▶️ продовжити рух

  ARRIVE_PICK_OBJECT: `${PREFIX}arrive_pick_object`,
  ARRIVE_OBJ: `${PREFIX}arrive_obj:`,
  ARRIVE_CONFIRM: `${PREFIX}arrive_confirm`,
  RESUME_LAST: `${PREFIX}resume_last`,
  GO_DRIVE: `${PREFIX}:go_drive`,

  AT_OBJ_DROP_PICK: `${PREFIX}at_obj_drop_pick`,
  DROP_ALL: `${PREFIX}drop_all`,
  START_WORK_ON_OBJ: `${PREFIX}start_work_on_obj`,
  GO_OBJ_RUN: `${PREFIX}go_obj_run`,
  STOP_OBJ_WORK: `${PREFIX}stop_obj_work:`,

  START_WORK: `${PREFIX}start_work:`,      // empId||workId
  STOP_WORK: `${PREFIX}stop_work:`,        // empId||workId

  FINISH_DAY: `${PREFIX}finish_day`,       // останній об’єкт -> стоп день -> return menu
  GO_RETURN: `${PREFIX}go_return`,
  RETURN_PICK_OBJECT: `${PREFIX}return_pick_object`,
  RETURN_OBJ: `${PREFIX}return_obj:`,
  RETURN_TOGGLE_PICKUP: `${PREFIX}return_toggle_pickup:`,
  RETURN_DROP_ALL: `${PREFIX}return_drop_all`,
  START_RETURN: `${PREFIX}start_return`,
  STOP_RETURN: `${PREFIX}stop_return`,

  ODO_END: `${PREFIX}odo_end`,
  ASK_ODO_END_KM: `${PREFIX}ask_odo_end_km`,
  ASK_ODO_END_PHOTO: `${PREFIX}ask_odo_end_photo`,
  SKIP_ODO_END_PHOTO: `${PREFIX}skip_odo_end_photo`,
  PLAN_OBJECT_MENU_FROM_OBJRUN: `${PREFIX}plan_obj_from_objrun`,

  STATS: `${PREFIX}STATS`,
  STATS_CARS: `${PREFIX}STATS_CARS`,
  STATS_OBJECTS: `${PREFIX}STATS_OBJECTS`,
  STATS_PEOPLE: `${PREFIX}STATS_PEOPLE`,

  STATS_CAR: `${PREFIX}STATS_CAR:`,         
  STATS_OBJECT: `${PREFIX}STATS_OBJECT:`,   
  STATS_PERSON: `${PREFIX}STATS_PERSON:`,   

  STATS_BACK: `${PREFIX}STATS_BACK:`, 
RETURN_EDIT_OBJECTS: `${PREFIX}return_edit_objects`,
RETURN_EDIT_OBJECT_PICK: `${PREFIX}return_edit_object_pick:`,
RETURN_EDIT_PEOPLE: `${PREFIX}return_edit_people`,
RETURN_EDIT_CAR: `${PREFIX}return_edit_car`,
RETURN_EDIT_WORKS: `${PREFIX}return_edit_works`,
RETURN_EDIT_QTY: `${PREFIX}return_edit_qty`,
RETURN_EDIT_SAVE: `${PREFIX}return_edit_save`,    

  SAVE: `${PREFIX}save`,
} as const;

export const FLOW: Flow = "ROAD_TS";

export const DEFAULT_ROAD_ALLOWANCE_BY_CLASS: Record<"S" | "M" | "L" | "XL", number> = {
  S: 50,
  M: 100,
  L: 150,
  XL: 200,
};

