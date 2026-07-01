# Landscape Bot — Architecture (Baseline)

Цей документ описує поточну “референсну” архітектуру Telegram-бота для ландшафтних бригад.
Мета: щоб будь-які майбутні доопрацювання не ламали фундамент і були зрозумілі з першого погляду.

---

## 1. Призначення
Telegram-бот для обліку виконаних робіт у ландшафтних проєктах:
- покрокові сценарії (flows)
- мінімум ручного вводу
- запис у Google Sheets
- фото в Google Drive

---

## 2. Технології
- Node.js + TypeScript
- `node-telegram-bot-api` (polling)
- Google Sheets API (v4)
- Google Drive API (v3)
- In-memory sessions: `Map<chatId, Session>`

---

## 3. Структура репо (основне)
- `src/index.ts` — вхідна точка, піднімає бота, роутить події.
- `src/bot/wizard.ts` — роутер/візард: меню → запуск flow → callback routing.
- `src/bot/ui.ts` — welcome + main menu (ReplyKeyboard).
- `src/bot/texts.ts` — всі тексти та кнопки (`TEXTS`).
- `src/bot/core/*` — ядро: cb, session, flow types, registry, helpers.
- `src/bot/flows/*` — flows (логіка сценаріїв).
- `src/google/*` — Google інтеграції (Sheets/Drive/Auth).
- `images/welcome.png` — привітальне зображення.

---

## 4. Вхідна точка

### `src/index.ts`
- створює `TelegramBot({ polling: true })`
- маршрути:
  - `/start` → `onStart(bot, chatId)`
  - `message` → `handleMessage(bot, msg)`
    - ігнорує `msg.text` що починається з `/` (щоб /start не дублювався)
  - `callback_query` → `handleCallback(bot, q)`

---

## 5. Wizard / Router

### `src/bot/wizard.ts`
Центральна логіка:
- реєструє `FLOW_MODULES`:
  - реальні: `LogisticsFlow`, `RoadFlow`
  - заглушки: `StubFlow(...)`
- будує `MENU_TEXT_TO_FLOW` через `makeMenuMap(FLOW_MODULES)`

#### Меню
- `openMenu()`:
  - `s.mode = "MENU"`
  - `delete s.flow`
  - `showMainMenu()`

#### /start
- `onStart()`:
  - `resetSession()`
  - `sendWelcome()` (inline кнопка “Розпочати”)

#### Callback routing
- `handleCallback()`:
  1) глобальні колбеки:
     - `CB.START_MENU` або `CB.MENU` → `openMenu()`
  2) інакше шукає модуль по `cbPrefix` через `routeByPrefix()` і делегує `mod.onCallback()`

#### Message routing
- `handleMessage()`:
  - текст `"меню"` → `openMenu()`
  - якщо `s.mode === "MENU"`:
    - шукає flow по тексту кнопки (ReplyKeyboard)
    - запускає `mod.start(bot, chatId, s)`
  - якщо `s.mode === "FLOW"`:
    - (поки) нема текстових обробок, все керується inline callbacks

---

## 6. UI

### `src/bot/ui.ts`
Два типи меню:
1) Welcome:
   - inline кнопка `"🚀 Розпочати"` → callback `start_menu`
2) Main menu:
   - ReplyKeyboard (кнопки внизу)

Функції:
- `sendWelcome()`:
  - якщо `images/welcome.png` існує → `sendPhoto(...)`
  - інакше → `sendMessage(...)`
- `showMainMenu()`:
  - повідомлення + ReplyKeyboard

---

## 7. Сесії та стейт

### `src/bot/core/session.ts`
- `sessions: Map<number, Session>`
- `ensureSession(chatId)`:
  - якщо нема → створює `{ mode:"MENU", updatedAt, flows:{} }`
- `resetSession(chatId)`:
  - скидає `{ mode:"MENU", updatedAt, flows:{} }`

⚠️ Після рестарту Node всі сесії губляться (in-memory) — це ок.

---

## 8. Flow контракт

### `src/bot/core/flowTypes.ts`
- `Flow` — union всіх модулів.
- `FlowBaseState` — мінімально `messageId?: number`.
- `Session`:
  - `mode: "MENU" | "FLOW"`
  - `flow?: Flow`
  - `flows: Partial<Record<Flow, FlowBaseState & Record<string, any>>>`
- `FlowModule`:
  - `flow`, `menuText`, `cbPrefix`
  - `start()`, `render()`, `onCallback()`

Правило:
- стейт кожного flow живе в `session.flows[FLOW]`
- inline UI оновлюється через `messageId` в стейті

---

## 9. Upsert-inline механіка

### `src/bot/core/helpers.ts`
- `upsertInline()`:
  - якщо `messageId` нема → `sendMessage()`, зберегти `messageId`
  - якщо `messageId` є → `editMessageText()`
  - якщо edit не вдався → шле нове повідомлення і перезаписує `messageId`

📌 Це забезпечує “1 flow = 1 inline message”, яке редагується.

---

## 10. Flow registry

### `src/bot/core/flowRegistry.ts`
- `makeMenuMap(modules)` — текст кнопки → flow
- `getModuleByFlow(modules, flow)`
- `routeByPrefix(modules, data)` — пошук flow по `cbPrefix`

Правило:
- всі callback_data конкретного flow мають починатись з `cbPrefix`

---

## 11. Реальні flows

### `src/bot/flows/logistics.flow.ts`
Flow для фіксації логістики.

Поточний стан:
- вибір обʼєкта
- мультивибір працівників
- review / edit / delete
- save → запис у `ЖУРНАЛ_ПОДІЙ` (type: "ЛОГІСТИКА")

Логістика не створює фінансових записів напряму,
а зберігається як події для подальшої обробки після здачі дня


### `src/bot/flows/road.flow.ts`
Каркас wizard’а:
- START → PICK_PEOPLE → END_PICK_OBJECTS → REVIEW
- поки заглушки, але правильний UX через inline

### `src/bot/flows/stub.flow.ts`
Універсальна заглушка для не реалізованих модулів

---

## 12. Google інтеграції

### `src/google/client.ts`
- JWT auth
- важливо: `privateKey.replace(/\\n/g, "\n")`

### `src/google/sheets.ts`
Універсальний data-layer для Google Sheets.

Підтримує:
- strict header matching (UA, 1-в-1)
- універсальне читання довідників
- append та upsert рядків

#### Довідники (fetch*)
- fetchUsers → КОРИСТУВАЧІ
- fetchEmployees → ПРАЦІВНИКИ
- fetchObjects → ОБЄКТИ
- fetchWorks → РОБОТИ
- fetchCars → АВТО

#### Робочі листи
- appendEvents → ЖУРНАЛ_ПОДІЙ
- appendReports → ЗВІТИ

#### Upsert-механізм
Через універсальну функцію `upsertRowByKeys()`:
- СТАТУС_ДНЯ
- ОДОМЕТР_ДЕНЬ
- ТАБЕЛЬ
- ДОПЛАТИ
- ЗАКРИТТЯ

Upsert працює по складених ключах (date + object/car/employee + tgId),
що дозволяє безпечно оновлювати рядки після “здачі дня”.

### `src/google/drive.ts`
- upload buffer у папку `GOOGLE_FOLDER_ID`
- робить `anyone: reader`
- повертає url `drive.google.com/file/d/{id}/view`

## 12.1 ЖУРНАЛ_ПОДІЙ — подієва модель

`ЖУРНАЛ_ПОДІЙ` є центральним логом усіх дій у системі.

Кожен запис — атомарна подія:
- логістика
- роботи
- дорога
- доплати
- редагування
- системні дії

Подія містить:
- timestamp
- дату
- brigadier tgId
- type (enum/строка)
- objectId / carId (опціонально)
- employeeIds (JSON)
- payload (JSON)

На основі `ЖУРНАЛ_ПОДІЙ` у майбутньому:
- будується табель
- рахуються доплати
- формується “день по обʼєкту”
- реалізується approve/return

---

## 13. Env / Config

### `src/config.ts`
Обовʼязкові env:
- `BOT_TOKEN`
- `GOOGLE_SHEET_ID`
- `GOOGLE_FOLDER_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `ADMIN_TG_IDS`

---

## 14. “Не ламати” правила
1) 1 flow = 1 inline message (через `messageId`)
2) callback routing працює по `cbPrefix`
3) ReplyKeyboard — тільки для запуску flow
4) Inline — для кроків у flow
5) стейт тільки в `session.flows`

---

## 15. Baseline status
- Архітектура стабільна
- LogisticsFlow — робочий
- RoadFlow — каркас
- решта — stub
- Google Sheets/Drive інтеграції підключені
