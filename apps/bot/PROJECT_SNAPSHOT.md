# Project Snapshot
Generated: 2026-01-24T21:06:42.456Z

## What this is
- Quick overview of project structure
- Exported functions/types/constants by file
- Env/config keys referenced in code

## Entrypoints / key files
- ✅ `src/index.ts`
- ✅ `src/bot/wizard.ts`
- ✅ `src/bot/ui.ts`
- ✅ `src/bot/texts.ts`
- ✅ `src/bot/core/session.ts`
- ✅ `src/bot/core/flowTypes.ts`
- ✅ `src/bot/core/helpers.ts`
- ✅ `src/bot/core/auth.ts`
- ✅ `src/bot/core/flowRegistry.ts`
- ✅ `src/bot/core/cb.ts`
- ✅ `src/bot/flows/dayStatus.flow.ts`
- ✅ `src/bot/flows/closeDay.flow.ts`
- ✅ `src/bot/flows/logistics.flow.ts`
- ✅ `src/bot/flows/road.flow.ts`
- ✅ `src/google/client.ts`
- ✅ `src/google/drive.ts`
- ✅ `src/config.ts`
- ✅ `src/google/sheets/names.ts`
- ✅ `src/google/sheets/types.ts`
- ✅ `src/google/sheets/headers.ts`
- ✅ `src/google/sheets/core.ts`
- ✅ `src/google/sheets/utils.ts`
- ✅ `src/google/sheets/dictionaries.ts`
- ✅ `src/google/sheets/checklist.ts`
- ✅ `src/google/sheets/working.ts`

## Env / config keys used in code
- `ADMIN_TG_IDS`
- `BOT_TOKEN`
- `GOOGLE_FOLDER_ID`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SHEET_ID`

## Files & exports
### `src/bot/core/auth.ts`
Notes: ⭐ key file, auth/roles (КОРИСТУВАЧІ), uses sessions
- export type **UserRole** L5
- export function **hydrateAuth** L45

### `src/bot/core/cb.ts`
Notes: ⭐ key file
- export const **CB** L1
- export type **CommonCb** L6

### `src/bot/core/flowRegistry.ts`
Notes: ⭐ key file
- export function **makeMenuMap** L3
- export function **getModuleByFlow** L10
- export function **routeByPrefix** L14

### `src/bot/core/flowTypes.ts`
Notes: ⭐ key file
- export type **Mode** L3
- export type **Flow** L5
- export type **FlowBaseState** L18
- export type **Session** L22
- export type **FlowModule** L31

### `src/bot/core/helpers.ts`
Notes: ⭐ key file, writes to Sheets
- export function **getFlowState** L4
- export function **setFlowState** L11
- export function **clearFlowState** L15
- export function **upsertInline** L19
- export function **todayISO** L57

### `src/bot/core/session.ts`
Notes: ⭐ key file, uses sessions
- export function **ensureSession** L6
- export function **resetSession** L15
- export function **getSessionsMap** L19

### `src/bot/flows/closeDay.flow.ts`
Notes: ⭐ key file, CLOSE_DAY flow (close day wizard), writes to Sheets
- export const **CloseDayFlow** L44

### `src/bot/flows/dayStatus.flow.ts`
Notes: ⭐ key file, DAY_STATUS flow (view + refresh + submit), writes to Sheets
- export const **DayStatusFlow** L48

### `src/bot/flows/logistics.flow.ts`
Notes: ⭐ key file, LOGISTICS flow, writes to Sheets
- export const **LogisticsFlow** L140

### `src/bot/flows/road.flow.ts`
Notes: ⭐ key file, ROAD flow
- export const **RoadFlow** L72

### `src/bot/texts.ts`
Notes: ⭐ key file
- export const **TEXTS** L1

### `src/bot/ui.ts`
Notes: ⭐ key file
- export const **START_INLINE_MENU** L11
- export const **MAIN_MENU** L16
- export function **sendWelcome** L35
- export function **showMainMenu** L65

### `src/bot/wizard.ts`
Notes: ⭐ key file, router/меню/flow registry, uses sessions
- export function **onStart** L54
- export function **handleCallback** L59
- export function **handleMessage** L91

### `src/config.ts`
Notes: ⭐ key file
- export const **config** L3

### `src/google/client.ts`
Notes: ⭐ key file
- export function **getGoogleAuth** L4
- export function **getSheetsClient** L15

### `src/google/drive.ts`
Notes: ⭐ key file
- export function **uploadPhotoFromBuffer** L5

### `src/google/sheets/checklist.ts`
Notes: ⭐ key file, checklist вычисления + getDayStatusRow, uses SHEET_NAMES, writes to Sheets
- export function **getDayStatusRow** L8
- export function **getDayStatus** L52
- export function **computeChecklist** L138

### `src/google/sheets/core.ts`
Notes: ⭐ key file, writes to Sheets
- export function **resolveHeaderIndex** L6
- export function **requireHeaders** L15
- export function **getCell** L30
- export function **buildRowByHeaders** L36
- export function **getHeaderMap** L48
- export function **loadSheet** L67
- export function **appendRows** L94
- export function **updateRow** L110
- export function **upsertRowByKeys** L138

### `src/google/sheets/dictionaries.ts`
Notes: ⭐ key file, dictionaries fetch (objects/employees/etc), uses SHEET_NAMES
- export function **fetchUsers** L7
- export function **fetchEmployees** L37
- export function **fetchObjects** L62
- export function **fetchWorks** L84
- export function **fetchCars** L116

### `src/google/sheets/headers.ts`
Notes: ⭐ key file
- export type **HeaderName** L3
- export const **USERS_HEADERS** L6
- export const **EMP_HEADERS** L16
- export const **OBJECTS_HEADERS** L25
- export const **WORKS_HEADERS** L33
- export const **CARS_HEADERS** L43
- export const **REPORTS_HEADERS** L51
- export const **TIMESHEET_HEADERS** L66
- export const **EVENTS_HEADERS** L79
- export const **ODOMETER_HEADERS** L97
- export const **ALLOWANCES_HEADERS** L110
- export const **DAY_STATUS_HEADERS** L124
- export const **CLOSURES_HEADERS** L145

### `src/google/sheets/names.ts`
Notes: ⭐ key file, uses SHEET_NAMES
- export const **SHEET_NAMES** L1

### `src/google/sheets/types.ts`
Notes: ⭐ key file
- export type **Role** L1
- export type **EventStatus** L2
- export type **DayChecklist** L4
- export type **UserRow** L14
- export type **EmployeeRow** L23
- export type **ObjectRow** L31
- export type **WorkRow** L38
- export type **CarRow** L47
- export type **ReportRow** L54
- export type **TimesheetRow** L68
- export type **EventRow** L80
- export type **OdometerDayRow** L98
- export type **AllowanceRow** L110
- export type **DayStatusRow** L123
- export type **ClosureRow** L143

### `src/google/sheets/utils.ts`
Notes: ⭐ key file
- export function **normalizeHeader** L1
- export function **norm** L10
- export function **toBool** L14
- export function **parseNumber** L19
- export function **nowISO** L25
- export function **sheetRef** L29
- export function **colToA1** L34
- export function **makeEventId** L46

### `src/google/sheets/working.ts`
Notes: ⭐ key file, Sheets working layer (events/upsert + refresh checklist), uses SHEET_NAMES, writes to Sheets
- export function **getTodayTimesheetPreview** L20
- export type **FetchEventsFilter** L49
- export function **fetchEvents** L57
- export function **refreshDayChecklist** L149
- export function **setDayStatus** L193
- export function **appendEvents** L256
- export function **appendReports** L290
- export function **upsertEvent** L326
- export function **updateEventById** L354
- export function **upsertDayStatus** L375
- export function **upsertOdometerDay** L404
- export function **upsertTimesheetRow** L432
- export function **upsertTimesheetRows** L453
- export function **upsertAllowanceRow** L457
- export function **upsertAllowanceRows** L479
- export function **upsertClosure** L483

### `src/index.ts`
Notes: ⭐ key file, entrypoint (bot старт)
- (no exports detected)

### `src/bot/core/guards.ts`
- export function **requireAdmin** L3
- export function **requireBrigadier** L8
- export function **isAdmin** L14

### `src/bot/core/renderFlow.ts`
Notes: writes to Sheets
- export type **FlowView** L6
- export function **renderFlow** L18

### `src/bot/flows/addWork.flow.ts`
Notes: writes to Sheets
- export const **AddWorkFlow** L316

### `src/bot/flows/getTodayTimesheetPreview.ts`
- (no exports detected)

### `src/bot/flows/peopleTimesheet.flow.ts`
Notes: writes to Sheets
- export const **PeopleTimesheetFlow** L90

### `src/bot/flows/stub.flow.ts`
- export const **StubFlow** L5

### `src/bot/flows/timesheet.flow.ts`
Notes: writes to Sheets
- export const **TimesheetFlow** L52

### `src/google/sheets.ts`
- export * from *** (./sheets/index.js)** L1
- export {..} **getTodayTimesheetPreview** L2

### `src/google/sheets/index.ts`
- export * from *** (./names.js)** L1
- export * from *** (./types.js)** L2
- export * from *** (./utils.js)** L3
- export * from *** (./dictionaries.js)** L5
- export * from *** (./working.js)** L6
- export * from *** (./checklist.js)** L9

### `src/google/sheets/timesheetFromEvents.ts`
- export function **computeTimesheetFromEvents** L29

### `src/types.ts`
- export type **Unit** L1
- export type **Dictionaries** L3
- export type **DraftRecord** L10
- export type **FinalRecord** L25
