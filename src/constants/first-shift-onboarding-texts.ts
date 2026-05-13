import type { FirstShiftOnboardingInputType } from "@prisma/client";

export type FirstShiftOnboardingStepConfig = {
    key: string;
    block: string;
    title: string;
    prompt: string;
    inputType: FirstShiftOnboardingInputType;
    requiresMentorApproval?: boolean;
};

export const FIRST_SHIFT_ONBOARDING_TEXTS = {
    notifyCandidate: (date: string, time: string, location: string) =>
        `🚀 <b>Перша зміна</b>\n\n` +
        `Сьогодні твоя перша зміна${location ? ` на локації <b>${location}</b>` : ""}${time ? `, час: <b>${time}</b>` : ""}.\n\n` +
        `На цій зміні тебе буде супроводжувати ментор. Бот проведе тебе по кроках: підготовка стійки, техніки, робота з макетами, друк фото, а в кінці — закриття зміни.\n\n` +
        `Виконуй кроки по черзі. Якщо щось незрозуміло — просто напиши в цей чат, повідомлення побачить ментор.`,
    startButton: "🚀 Почати",
    askMentorButton: "💬 Написати ментору",
    submitted: "✅ Отримано. Очікуємо підтвердження ментора.",
    submittedNoApproval: "✅ Готово. Переходимо далі.",
    sendPhotoExpected: "Будь ласка, надішли фото або скрін для цього кроку.",
    sendTextExpected: "Будь ласка, надішли текст або лінк для цього кроку.",
    questionForwarded: "Повідомлення передано ментору.",
    multiplePhotosHint: "Можеш надіслати кілька фото поспіль. Коли всі фото будуть надіслані, натисни кнопку нижче.",
    multiplePhotosDoneButton: "✅ Усі фото надіслано",
    mentorObservedCandidate: "Цей крок ментор підтверджує після перевірки.",
    approved: "✅ Крок підтверджено ментором.",
    rejected: (comment?: string | null) =>
        `🔁 Ментор попросив переробити цей крок.${comment ? `\n\nКоментар: ${comment}` : ""}`,
    setupCompleted: "✅ Підготовка завершена.\n\nГарної зміни! Підходь до людей, фотографуй, друкуй магніти, допомагай з вибором і продавай. Якщо щось незрозуміло — пиши сюди, ментор побачить повідомлення.\n\nБлок закриття зміни відкриється за 30 хвилин до кінця зміни або за командою ментора.",
    closingOpened: "Починаємо закриття зміни. Виконуй кроки по черзі.",
    waitingFinal: "Усі кроки виконані. Очікуємо фінальне підтвердження ментора.",
    completed: "🎉 Вітаємо з першою зміною в PlayPhoto!\n\nТи пройшла онбординг першої зміни: підготувала стійку, техніку, робочі файли, попрацювала з макетами, перевірила друк фото та правильно закрила зміну.\n\nДалі працюємо за цими ж стандартами кожну зміну:\n- на початку перевіряємо техніку, порядок і готовність до роботи;\n- під час зміни уважно обслуговуємо клієнтів, допомагаємо з вибором і працюємо над продажами;\n- у кінці зміни закриваємо стійку, відправляємо звітність і залишаємо охайне робоче місце.\n\nЯкщо виникають питання — пиши в бот. Після першої зміни звернення вже будуть іти у стандартну підтримку.",
    failed: "Дякуємо за сьогоднішній день і приділений час.\n\nЗа результатом першої зміни ми не продовжуємо співпрацю. Бажаємо тобі успіхів надалі.",
    topicOpened: "🚀 <b>First shift onboarding opened</b>",
    topicClosed: "✅ <b>First shift onboarding completed successfully.</b>",
    topicFailed: "❌ <b>First shift onboarding marked as failed.</b>",
    topicStarted: "▶️ Photographer started onboarding.",
    topicSetupCompleted: "✅ Opening checklist is approved. Photographer is in shift mode. Closing checklist will open 30 minutes before shift end or by mentor command.",
    topicClosingOpened: "🔒 Closing checklist opened.",
    topicAllStepsApproved: "✅ All checklist steps are approved. Waiting for final mentor decision.",
};

export const FIRST_SHIFT_ONBOARDING_STEPS: FirstShiftOnboardingStepConfig[] = [
    {
        key: "stand_opening",
        block: "Відкриття стійки",
        title: "Відкрити стійку",
        prompt: "Знайди головний ключ від центральної шухляди, відкрий її та відкрий всі маленькі шухляди.",
        inputType: "BUTTON",
        requiresMentorApproval: false,
    },
    {
        key: "laptop_start",
        block: "Ноутбук",
        title: "Підготувати ноутбук",
        prompt: "Підключи ноутбук до мережі, увімкни його кнопкою живлення, натисни скрипт START на робочому столі, перевір робочий стіл і протри ноутбук серветкою. Інформація по скриптам: https://t.me/c/1755838327/110. Перейди в Google Chrome, обери своє прізвище в робочій таблиці й подивись, як вона заповнюється: продали — внесли позицію одразу. Надішли скрін робочого столу.",
        inputType: "SCREENSHOT",
        requiresMentorApproval: true,
    },
    {
        key: "drawers_order",
        block: "Стійка",
        title: "Порядок у шухлядах",
        prompt: "Наведи порядок у всіх шухлядах, акуратно склади речі та протри стійку. Надішли фото кожної шухляди.",
        inputType: "MULTIPLE_PHOTOS",
        requiresMentorApproval: true,
    },
    {
        key: "camera_manual_mode",
        block: "Камера",
        title: "Режим M",
        prompt: "Перевір, що камера у режимі M manual. Надішли фото колеса режимів.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "camera_settings",
        block: "Камера",
        title: "Налаштування камери",
        prompt: "Перевір налаштування камери: ISO 800, f/4.0, 1/160, JPEG, WB auto. Надішли фото головного екрану камери.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "camera_card_format",
        block: "Камера",
        title: "Карта памʼяті",
        prompt: "Обережно встав карту памʼяті в камеру, відформатуй її через меню Canon і перевір AF на обʼєктиві. Надішли фото процесу форматування.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "camera_import_test",
        block: "Камера",
        title: "Тестовий імпорт",
        prompt: "Зроби тестовий знімок, підключи камеру або карту до ноутбука та скинь фото за допомогою скрипта IMPORT на робочому столі.",
        inputType: "BUTTON",
        requiresMentorApproval: true,
    },
    {
        key: "flash_setup",
        block: "Спалах",
        title: "Налаштувати спалах",
        prompt: "Вистав ручний режим M на спалаху, закріпи спалах на камері та встанови розсіювач. Надішли фото екрану спалаху.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "printer_colors",
        block: "Принтер",
        title: "Перевірити принтер",
        prompt: "Перевір, що всіх кольорів у принтері більше половини. Надішли фото підтвердження.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "printer_ready",
        block: "Принтер",
        title: "Підготувати принтер",
        prompt: "Підключи принтер до мережі й ноутбука USB-шнуром, правильно встав папір 10x15 і перевір, що на принтері нічого не лежить. Вставляй папір глянцевою стороною до себе. Надішли фото, як стоїть папір у принтері.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "photoshop_practice",
        block: "Photoshop + макети",
        title: "Практика в макетах",
        prompt: "Перекинь тестові фото в макети, кадруй, застосуй action обробки, корегуй експозицію, перевір шари та друк. Цей крок ментор підтверджує після перевірки через віддалений доступ.",
        inputType: "MENTOR_OBSERVED",
        requiresMentorApproval: true,
    },
    {
        key: "export_test",
        block: "Photoshop + макети",
        title: "Тестовий експорт",
        prompt: "Збережи фото з Photoshop у папку з поточною датою, поклади файл у EXPORT на робочому столі, натисни скрипт EXPORT. Після завантаження скинь лінк із робочого Telegram собі, скопіюй його і надішли в бот.",
        inputType: "LINK",
        requiresMentorApproval: true,
    },
    {
        key: "closing_printer",
        block: "Закриття зміни",
        title: "Закрити принтер",
        prompt: "Вимкни принтер кнопкою, вийми папір і закрий всі слоти. Надішли фото принтера.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "closing_flash",
        block: "Закриття зміни",
        title: "Спалах і акуми",
        prompt: "Відʼєднай спалах від фотоапарату, дістань акуми й постав їх на зарядку. Надішли фото зарядки з акумами.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "closing_camera_battery",
        block: "Закриття зміни",
        title: "Карта й акум камери",
        prompt: "Відформатуй карту памʼяті через фотоапарат, дістань акум з фотоапарата і постав на зарядку. Надішли фото зарядки з акумом.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "closing_desktop_tg",
        block: "Закриття зміни",
        title: "Telegram і робочий стіл",
        prompt: "Закрий Photoshop без збереження змін у макетах, перевір Telegram і робочий стіл. Надішли скрін Telegram або робочого стола за вказівкою ментора.",
        inputType: "SCREENSHOT",
        requiresMentorApproval: true,
    },
    {
        key: "closing_x_report",
        block: "Закриття зміни",
        title: "X-звіт",
        prompt: "Зроби X-звіт на терміналі/Checkbox, якщо він є, і звір дані з таблицею. Надішли фото X-звіту.",
        inputType: "PHOTO",
        requiresMentorApproval: true,
    },
    {
        key: "closing_cash_report",
        block: "Закриття зміни",
        title: "Касова таблиця",
        prompt: "Заповни касову Google-таблицю, але перед відправкою надішли скрін екрану для узгодження.",
        inputType: "SCREENSHOT",
        requiresMentorApproval: true,
    },
    {
        key: "finish_script",
        block: "Закриття зміни",
        title: "FINISH",
        prompt: "Після підтвердження ментора запусти скрипт FINISH.",
        inputType: "BUTTON",
        requiresMentorApproval: true,
    },
];
