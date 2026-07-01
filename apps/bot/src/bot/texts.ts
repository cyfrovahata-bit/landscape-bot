export const TEXTS = {
  welcome: {
    title: "👋 Привіт!",
    description: "Я бот для обліку виконаних робіт у ландшафтних проєктах.",
    action: "Натисни 🚀 Розпочати 👇",
  },

  menu: {
    opened: "✅ Меню відкрите. Обери дію 👇",
  },

  flows: {
    logistics: "🚚 Логістика",
    road: "🛣 Дорога",
    brigade: "👷 Бригада",
    addWork: "➕ Додати роботи",
    materials: "🧱 Матеріали",
    tools: "🧰 Інструмент",
    editDelete: "✏️ Редагувати/видалити",
    closeDay: "✅ Закрити обʼєкт за день",
    dayStatus: "📊 Статус дня",
  },

  common: {
    backToMenu: "⬅️ Повернутись у меню",
    unknown: "ℹ️ Обери дію з меню нижче 👇",
  },

  // ✅ глобальні (перевикористовувані) кнопки/лейбли/помилки для різних flow
  ui: {
    symbols: {
      emptyDash: "—",
      unknown: "?",
    },

    labels: {
      current: "Пчатковий показник спідометра:",
      category: "Категорія:",
      picked: "Обрано:",
      missing: "Без обсягу:",
      photos: "Фото:",
      works: "Роботи:",
    },

    buttons: {
      back: "⬅️ Назад",
      menu: "⬅️ Меню",
      done: "✅ Готово",
      today: "📅 Сьогодні",
      save: "✅ Зберегти",
      reset: "🔄 Скинути",
      addMore: "➕ Додати ще",
      volumeEmpty: "— (пусто)",
      plus: "+",
      minus: "−",
      yesReset: "✅ Так, скинути",
      no: "↩️ Ні",
    },

    ok: {
      accepted: "✅ Прийнято.",
      photoAccepted: "✅ Фото прийнято.",
      saved: "✅ Збережено.",
    },

    errors: {
      notFound: "⚠️ Не знайдено.",
      backMenu: "✅ Повернувся в меню. Напиши “меню”.",
      timeout: "⏳ Час вийшов. Натисни кнопку ще раз і введи значення.",
    },
  },

  buttons: {
    start: "🚀 Розпочати",
    logistics: "Логістика",
    road: "Дорога",
    brigade: "Бригада",
    addWork: "Додати роботи",
    materials: "Матеріали",
    tools: "Інструмент",
    editDelete: "Редагувати/видалити",
    closeDay: "Закрити обьєкт за день",
    dayStatus: "Статус дня",
    peopleTimesheet: "👥 Люди / Табель",
    roadTimesheet: "🛣 Робочий день",
    stats: "📊 Статистика",
  },

  MENU_MATERIALS: "📦 Матеріали",
  MENU_TOOLS: "🧰 Інструмент",

roadFlow: {
  // Заголовки/лейбли в статусі
  labels: {
    carOk: "✅ Авто:",
    carNone: "❌ Авто: не обрано",
    odoStartOk: "✅ Показник спідометра:",
    odoStartNone: "❌ Показник спідометра: нема",
    odoEndOk: "✅ Кінцевий показник спідометра:",
    odoEndNone: "❌ Немає показника спідометра",
    peopleDay: "👥 Люди",
    peopleReturn: "👥 Люди",
    objects: "🏗 Об’єкти:",
    inCar: "🚐 В машині:",
    picked: "Обрано:",
    busySuffix: "(зайнято)",
    inCarNow: "Зараз в машині:",
    pickPrefix: "Підібрати — {name}",
    dropPrefix: "Зняти — {name}",
  },

  // Стани/фази (рядок під датою)
  phase: {
    noCar: "⚪ Обери авто",
    setup: "⚪ Підготовка",
    day: "🟢 Дорога",
    waitReturn: "🟡 День завершено — чекає повернення",
    returnTrip: "🌙 Дорога",
    finished: "✅ Завершено (очікує збереження)",
  },

  // Кнопки (тільки специфічні для дороги)
  buttons: {
    menuRoad: "В меню дороги",
    pickCar: "🚗 Авто",
    odoStart: "🟢 Початковий показник спідометра",
    odoEnd: "🔴 Кінцевий показник спідометра",
    peopleDay: "👥 Люди",
    peopleReturn: "👥 Люди",
    pickPeople: "👥 Обрати людей",
    objectsCount: "🏗 К-сть об’єктів",
    manageObjects: "🏗 Змінити к-сть об’єктів",
    managePeople: "👥 Зняти/додати людей",
    startDay: "▶️ Почати рух",
    stopDay: "⏹ Кінцевий об'єкт",
    startReturn: "🌙 Почати рух",
    stopReturn: "⏹ Зупинка в гаражі",
    stopGeneric: "⏹ Зупинка в гаражі",
    goReturnMenu: "➡️ Повернення на базу",
    enterValue: "✍️ Ввести показник спідометра",
    sendPhoto: "📷 Надіслати фото",
    skipPhoto: "➡️ Пропустити фото",
    save: "💾 Зберегти",
    reset: "🧹 Скинути",
    stats: "📊 Статистика",
    messageForeman: "✉️ Написати бригадиру",
  },

  // Екрани (тексти)
  screens: {
    pickCar: "🚗 Обери авто (активне авто = те, яким керуєш зараз).\n\nГотово — перейти далі.",
    pickCarShort: "🚗 Обрати авто:",
    odoStartEnter: "🟢 Введіть показник спідометра",
    odoStartOk: "🟢 Показник спідометра прийнято: {km} км",
    peopleDay: "👥 Люди",
    objects: "🏗 Кількість об’єктів\n\nЗараз: {n}\n\nОбери швидко 1..5 або змінюй +/−.",
    runDay: "🟢 Дорога",
    afterStopDay: "✅ День завершено.\n\nВсіх людей знято автоматично.\n\nДалі: повернення на базу.",
    returnMenu: "🌙 Повернення на базу\n\nОбери людей для повернення.",
    peopleReturn: "👥 Люди",
    runReturn: "🌙 Дорога",
    odoEndEnter: "🔴 Введіть кінцевий повказник спідометра",
    odoEndOk: "🔴 Кінцевий показник спідометра {km} км",
    save: "💾 Готово до збереження.",
    statsTitle: "📊 Статистика активних авто",
    statsEmpty: "Нема активних авто зараз.",
    resetConfirm: "🧹 Скинути заповнення?\n\nЦе не “розблокує” машину, якщо вона в дорозі.",
    carBusy: "🚫 Машина {carId} зайнята.",
    carBusyBy: "🚫 Машина {carId} зайнята бригадиром (tg id: {tg}).",
    managePeople: "👥 Висадити/підібрати людей",
  },

  // Підказки
  hints: {
    menu: "Меню дороги",
    tapToToggle: "Натискай щоб додати/прибрати:",
    sendOrSkipPhoto: "Тепер надішли фото (або пропусти).",
    whenReadyStart: "Коли готово — початок дороги",
    runDay:
      "Тут можна:\n• зняти/додати людей (рахуємо час в дорозі)\n• змінити кількість об’єктів (це тільки число N)\n• STOP — автоматично зніме всіх, хто залишився",
    runReturn: "Можеш знімати/додавати людей. STOP — завершення і перехід до ODO end.",
  },

  // Промпти (ввід числа/фото)
  prompts: {
    odoStartNumber: "✍️ Введи початковий показник спідометра (км), тільки число:",
    odoEndNumber: "✍️ Введи кінцевий показник спідометра (км), тільки число:",
    odoStartPhoto: "📷 Надішли фото спідометра:",
    odoEndPhoto: "📷 Надішли фото спідометра:",
  },

  // Гварди (gate alert)
  guards: {
    needCar: "Спочатку обери авто",
    needPickCar: "Обери авто",
    needOdoStart: "Спочатку введи показник спідометра",
    needPeopleDay: "Спочатку обери людей",
    needObjects: "Спочатку вкажи кількість об’єктів",
    needPeopleReturn: "Спочатку обери людей для повернення",
    needOdoEnd: "Спочатку введи показник спідометра",
    carBusy: "Машина зайнята іншим бригадиром.",
  },

  // Помилки
  errors: {
    notNumberExample: "❌ Не схоже на число. Приклад: {ex}",
    needPhoto: "❌ Не бачу фото. Надішли саме фото (не файл).",
    cantStartNow: "Неможливо стартувати зараз.",
    personInOtherCar: "Людина {emp} вже в іншій машині ({car}).",
    dayNotActive: "Дорога (день) ще не активна.",
    needStopDayFirst: "Спочатку заверши день (STOP дорога).",
    returnNotActive: "Повернення ще не активне.",
    odoEndAfterReturnStop: "ODO end доступний після STOP (повернення).",
    objectsOnlyDuringDay: "Змінювати об’єкти можна під час дороги (день).",
    peopleOnlyDuringActive: "Знімати/додавати людей можна тільки під час активної дороги.",
    notActive: "Дорога не активна.",
    needFinishAndOdoEnd: "Спочатку завершити повернення + ввести ODO end.",
  },

  // Повідомлення після збереження
  messages: {
    saved: "✅ Дорога збережена.\n📏 {km} км | 🧩 {class} | 💰 {amount} (по {per} / людина, N={n})",
  },
},


  // ✅ тексти конкретного flow (уникати дублювання стандартних кнопок — брати з TEXTS.ui.buttons)
  addWorkFlow: {
    title: "➕ Додати роботи",

    header: {
      date: "📅 Дата:",
      object: "🏗 Обʼєкт:",
      worksInPack: "🧰 Робіт у пакеті:",
      missingVolume: "🟡 Без обсягу:",
      photos: "📷 Фото:",
    },

    main: {
      actionsTitle: "Дії:",
      bullets: [
        "• Обери роботи",
        '• Для кожної постав обсяг',
        "• Додай фото",
      ],
    },

    pickDate: {
      title: "📅 Обери дату:",
    },

    fillQty: {
      allFilled: "✅ Усі обсяги вже заповнені.",
      title: "🟡 Заповни обсяги",
      hint: 'Натисни на роботу → вистав обсяг або "?"',
    },

    pickObject: {
      title: "🏗 Обери обʼєкт:",
    },

    pickCategory: {
      title: "🧩 Обери категорію робіт",
      next: "Далі покажу список робіт цієї категорії.",
      all: "Усі",
      allBtnOn: "✅ Усі категорії",
      allBtnOff: "▫️ Усі категорії",
      noCatBtn: "🫥 Без категорії",
      notFound: "⚠️ Категорія не знайдена. Відкрий вибір категорії ще раз.",
    },

    pickWorks: {
      title: "🧰 Роботи (пакет)",
      hint: "Після вибору — “Готово”, далі виставиш обсяги.",
      all: "Усі",
      noCat: "Без категорії",
    },

    editVolume: {
      title: "📏 Обсяг для роботи:",
      current: "Поточний:",
      hint: "Можна лишити пустим або поставити “?”",
    },

    photos: {
      title: "📷 Фото пакета",
      sendHint: "Надішли фото повідомленнями в чат.",
      current: "Поточні",
      after: "Після — натисни “Готово”.",
      deletePrefix: "🗑 Видалити #",
    },

    review: {
      title: "👀 Review (без сум)",
      hint: "Щоб змінити обсяг — натисни “✏️ Обсяг” біля роботи.",
      editPrefix: "✏️ Обсяг:",
    },

    saved: {
      ok: "✅ Пакет збережено!",
      works: "🧰 Робіт:",
      photos: "📷 Фото:",
      missingWarnTitle: "🟡 Є роботи без обсягу:",
      missingWarnTail: "Перед здачею дня потрібно заповнити.",
    },

    locked: {
      prefix: "🔒 День уже",
      tail: "Збереження робіт недоступне.",
    },

    errors: {
      needObject: "⛔ Спочатку обери обʼєкт.",
      needWork: "⛔ Додай хоча б 1 роботу у пакет.",
    },

    // кнопки, які специфічні саме для цього flow (не дублюємо back/done/today/reset/menu тощо)
    buttons: {
      date: "📅 Дата",
      object: "🏗 Обʼєкт",
      worksPack: "🧰 Роботи (пакет)",
      photosPack: "📷 Фото (пакет)",
      review: "👀 Review",
      reviewBlocked: "⛔ Review (обери обʼєкт+роботи)",
      savePack: "✅ Зберегти пакет",
      changeCategory: "🧩 Змінити категорію",
      fillQty: "🟡 Заповнити обсяги",
      addMorePack: "➕ Додати ще пакет",
    },
  },

  peopleTimesheetFlow: {
  title: "👥 Табель",

  labels: {
    date: "📅",
    activeObjectOk: "✅ Активний обʼєкт:",
    activeObjectNone: "❌ Активний обʼєкт: —",
    activeObjectsCount: "🟢 Активних обʼєктів:",
    people: "👥 Люди:",
    works: "🧱 Роботи:",
    openSessions: "⏱ Людей працює:",
    totalObjects: "🏗 Всього обʼєктів:",
    totalPeople: "👥 Всього людей:",
    totalHours: "⏱ Всього годин:",
  },

  phase: {
    setup: "⚪ Підготовка",
    run: "🟢 Роботи тривають",
    finished: "✅ Завершено (оцінка/збереження)",
  },

  buttons: {
    pickActiveObject: "🏗 Обрати/змінити активний обʼєкт",
    openActiveMenu: "📌 Відкрити меню активного обʼєкта",
    previewAll: "📋 Preview (усі обʼєкти)",
    pickPeople: "👥 Обрати людей (склад)",
    worksMenu: "🧱 Роботи (зі списку)",
    assignMenu: "🧩 Призначити роботи людям",
    startObj: "▶️ Почати роботи",
    goRun: "🟢 Перейти в RUN екран",
    stopObj: "⏹ Завершити роботи",
    moveEmp: "🔁 Перенести людину між обʼєктами",
    rate: "⭐ Оцінка коефіцієнтів",
    addWork: "➕ Додати роботу зі списку",
    remove: "🗑",
    stopWork: "⏹",
    startWork: "▶️",
  },

  screens: {
    startHint:
      "Обери обʼєкт і керуй ним.\nPreview показує статистику по обʼєктах за день (як у “дорогах”).",

    pickObjectTitle: "🏗 Обʼєкти",
    pickObjectHint: "Оберіть активний обʼєкт.",
    objectMenuTail: "Меню обʼєкта.",
    pickPeopleTitle: "👥 Люди",
    pickPeopleHint: "Обери склад людей для цього обʼєкта:",
    worksTitle: "🧱 Роботи",
    worksHint: "Тут ти обираєш роботи з довідника (таблиці).",
    pickWorkTitle: "📚 Довідник робіт",
    pickWorkHint: "Натисни на роботу, щоб додати її в обʼєкт.",
    runTitle: "🟢 RUN",
    runHint:
      "Під час RUN:\n• запускай/зупиняй роботу (сесії)\n• призначай/знімай роботи\n• перенось людей між обʼєктами",
    moveTitle: "🔁 Перенести людину",
    moveFrom: "Звідки:",
    moveTo: "Куди переносимо?",
    rateTitle: "⭐ Оцінка",
    rateHint:
      "За замовчуванням coef = 1.0.\nМожеш натискати 0.8..1.2 або ввести вручну.",
    previewTitle: "📋 Preview табеля",
    worksEmpty: "— Немає обраних робіт —",
  },

  prompts: {
    coefCustom: "✍️ Введи коефіцієнт для {empId} (наприклад 1 або 1.15):",
  },

  guards: {
    needStartObj: "Спочатку натисни “Почати роботи”.",
    needPeople: "Спочатку обери людей.",
    needWorks: "Спочатку обери роботи.",
    needAssign: "Спочатку признач цю роботу людині.",
    alreadyStarted: "Вже запущено.",
    notRunning: "Роботи не запущені.",
    notActive: "Роботи не активні.",
    noSession: "Сесія не запущена.",
    finishedNoEditPeople: "Обʼєкт уже завершено. Змінювати склад не можна.",
    finishedNoEditWorks: "Обʼєкт уже завершено. Додавати роботи не можна.",
    finishedNoRemoveWorks: "Обʼєкт уже завершено. Видаляти роботи не можна.",
    rateAfterFinish: "Оцінка доступна після завершення робіт.",
    moveOnlyRun: "Переносити людей можна під час RUN.",
    empNotInRoster: "Цієї людини немає в складі обʼєкта.",
    saveNeedStop: "Спочатку заверши роботи (STOP).",
  },

  errors: {
    coefInvalid: "❌ Не схоже на число. Діапазон: 0.1..3. Приклад: 1.15",
    lockedEdit: "🔒 День уже {status}. Редагування табеля недоступне.",
    lockedSave: "🔒 День уже {status}. Збереження табеля недоступне.",
  },

  messages: {
    saved:
      "✅ Табель збережено: {objectId}\nРядків: {rows}\nPreview рахується по TS2_OBJ_START/STOP та TS2_WORK_START/STOP.",
  },
},

materialsFlow: {
  title: "📦 Матеріали",

  // лейбли в fmt()
  labels: {
    date: "📅 Дата:",
    object: "🏠 Обʼєкт:",
    material: "🧱 Матеріал:",
    qty: "🔢 К-сть:",
    type: "🧾 Тип:",
  },

  // кнопки (специфічні для materials)
  buttons: {
    today: "Сьогодні",
    yesterday: "Вчора",
    changeCategory: "🧩 Змінити категорію",
    allCategoriesOn: "✅ Усі категорії",
    allCategoriesOff: "▫️ Усі категорії",
    noCategory: "🫥 Без категорії",
    save: "✅ Зберегти",
    cancel: "❌ Скасувати",
    check: "✅ Перевір",
  },

  // екрани
  screens: {
    pickDate: "{title}\n\nОбери дату:",
    pickObject: "{title}\n\n{fmt}\n\nОбери обʼєкт:",
    pickCategory: "{title}\n\n{fmt}\n\nОбери категорію:",
    pickMaterial: "{title}\n\n{fmt}\n\nКатегорія: *{cat}*\n\nОбери матеріал:",
    enterQty: "{title}\n\n{fmt}\n\nНапиши кількість в чат.\nМожна *?* або пусто → буде пусто.",
    pickType: "{title}\n\n{fmt}\n\nОбери тип руху:",
    review: "{check}\n\n{fmt}\n\nЗберігаємо?",
  },

  // повідомлення/помилки
  messages: {
    canceled: "❌ Скасовано",
    saved: "✅ Матеріали збережено",
  },

  errors: {
    notAllFilled: "❌ Не всі поля заповнені",
    matNotFound: "❌ Матеріал не знайдено",
    enterNumberOrQ: "❌ Введи число (або ?)",
    locked: "🔒 День уже {status}. Збереження матеріалів недоступне.",
  },
},

closeDayFlow: {
  title: "🏁 Закрити обʼєкт за день",

  pickObject: {
    choose: "Оберіть обʼєкт:",
    showingPrefix: "Показую перші",
    showingBetween: "з",
  },

  view: {
    date: "Дата:",
    object: "Обʼєкт:",
    status: "Статус:",
    checklistTitle: "Checklist:",
    notReadyTitle: "❌ Не готово для здачі:",
    readyOk: "✅ Мінімум готовий. Можна здати день.",
    returnReason: "Return reason:",
    approvedBy: "Approved by:",
    approvedAt: "Approved at:",
    updatedAt: "Updated at:",
  },

  checklist: {
    timesheet: "👥 Табель",
    works: "➕ Роботи",
    road: "🚐 Дорога",
    odoStart: "📟 Одометр START",
    odoEnd: "📟 Одометр END",
    logistics: "🚚 Логістика",
    materials: "📦 Матеріали",
  },

  buttons: {
    refresh: "🔄 Оновити checklist",
    submit: "✅ Здати день",
  },

  errors: {
    cannotSubmitTitle: "❌ Не можна здати день — не готово:",
    cannotSubmitHint: "Додай відсутні дані і натисни “🔄 Оновити checklist”.",
  },
},

dayStatusFlow: {
  title: "📊 Статус дня",

  pickObject: {
    choose: "Оберіть обʼєкт:",
    showingPrefix: "Показую перші",
    showingBetween: "з",
  },

  view: {
    date: "Дата:",
    object: "Обʼєкт:",
    status: "Статус:",

    checklistTitle: "Checklist:",

    readyOk: "✅ День готовий до здачі.",
    notReadyTitle: "❌ Не можна здати день, не готово:",

    returnedTitle: "🔁 День ПОВЕРНУТО адміністратором.",
    returnedReason: "📝 Причина:",
    
    approvedBy: "Затвердив:",
    approvedAt: "Затверджено:",
    updatedAt: "Оновлено:",
  },

  checklist: {
    timesheet: "👥 Табель",
    works: "➕ Роботи",
    worksVolumeOk: "📏 Роботи без обсягу",
    road: "🚐 Дорога",
    odoStart: "📟 Одометр START",
    odoStartPhoto: "📸 Фото START",
    odoEnd: "📟 Одометр END",
    odoEndPhoto: "📸 Фото END",
    logistics: "🚚 Логістика",
    materials: "📦 Матеріали",
  },

  submit: {
    locked: "🔒 День уже {status}. Редагування/здача недоступні.",
    refreshHint: "Додай відсутні дані і натисни “🔄 Оновити checklist”.",
  },

  finance: {
    title: "💰 Фонд/нарахування:",
    afterApprovedOnly: "⛔ Доступно після статусу \"ЗАТВЕРДЖЕНО\"",
    fundByWorks: "Фонд по роботам:",
    noPeopleWarn: "⚠️ У табелі немає людей для цього обʼєкта/дня.",
    allowancesTotal: "Доплати всього:",
    pointsSum: "Σ points:",
    calcError: "❌ Помилка розрахунку: {err}",
  },

  person: {
    hoursLine: "• год: {hours}, коеф: {d}×{p}",
    shareLine: "• частка: {share}%",
    byFundLine: "• по фонду: {amount}",
    allowancesLine: "• доплати: {amount}",
    tripLine: "• виїзд: {amount}",
    logisticsLine: "• логістика: {amount}",
    totalLine: "✅ разом: {amount}",
  },

  buttons: {
    refresh: "🔄 Оновити checklist",
    submit: "✅ Здати день",
    resubmit: "✅ Здати повторно",
    lockedStatusPrefix: "🔒", // буде "🔒 {status}"
    back: "⬅️ Назад",        // або можеш не додавати і брати TEXTS.ui.buttons.back
  },

  fixButtons: {
    works: "➕ Заповнити роботи",
    roadOdo: "🚐 Дорога / Одометр",
    timesheet: "👥 Табель",
    logistics: "🚚 Логістика",
    materials: "📦 Матеріали",
  },
},


} as const;