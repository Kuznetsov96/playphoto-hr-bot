import { InlineKeyboard } from "grammy";

export const CANDIDATE_TEXTS = {
    // --- 1. ПРИВІТАННЯ ТА АНКЕТА ---
    "welcome-message": "Привіт! Твій шлях у PlayPhoto починається тут. 📸\n\nДавай познайомимось ближче. Це лише 6 швидких запитань.",
    "ask-name": "Як тебе звати? ✨\nНапиши, будь ласка, своє ім’я та прізвище.",
    "error-name-format": (error: string) => `⚠️ ${error}\n\nБудь ласка, напиши ім’я та прізвище ще раз.`,
    "candidate-greeting-nicetomeet": (fullName: string) => `${fullName}, приємно познайомитись! 🌸\n\nЩоб підібрати зручну локацію, дай відповідь на кілька запитань:`,

    "candidate-ask-birthday": "Коли твій день народження? 🎂\nБудь ласка, вкажи дату у форматі ДД.ММ.РРРР (наприклад, <code>15.05.2005</code>).",
    "candidate-ask-city": "Обери місто, у якому хочеш працювати: 📍",
    "candidate-ask-location-multiple": "У цьому місті є кілька локацій. Обери ту, яка тобі найзручніша: 🏢",
    "candidate-ask-appearance": "Ми працюємо з дітьми, тому маємо певні стандарти зовнішнього вигляду. Скажи, чи маєш ти видимі татуювання (наприклад, на руках чи шиї) або пірсинг на обличчі? ✨",
    "candidate-ask-source": "Майже готово! Підкажи, звідки ти дізналася про нашу вакансію? 🕵️‍♀️",
    "candidate-info-processing": "Дякуємо! Обробляємо твою анкету... ⏳\n\nГотово",
    "candidate-screening-unfinished": (firstName: string) => `<b>Анкету майже завершено! ✨</b>\n\n${firstName}, твій шлях у PlayPhoto розпочато. Залишилося ще кілька кроків, щоб ми могли познайомитися ближче. Давай продовжимо! 📸`,
    "candidate-invite-reminder": (firstName: string) => `<b>Час обрати зручний момент! 🗓️</b>\n\n${firstName}, ми вже чекаємо на зустріч із тобою, але слот для співбесіди ще не обрано. Тисни кнопку нижче, щоб забронювати зручний час для здзвону. ✨`,
    "candidate-discovery-reminder": (firstName: string) => `<b>Час для першого знайомства! ✨</b>\n\n${firstName}, ти вже маєш доступ до матеріалів PlayPhoto. Наступний крок — коротка відеозустріч із наставницею (20 хв). Обери зручний час, щоб ми могли познайомитися ближче! 🗓️`,
    "candidate-training-reminder": (firstName: string) => `<b>Продовжимо твоє навчання? 📸</b>\n\n${firstName}, знайомство пройшло чудово! Залишився останній крок перед виходом на локацію — основне навчання. Обери зручне «вікно» у графіку, щоб розібрати всі тонкощі роботи. ✨`,

    // --- 2. РЕЗУЛЬТАТИ ВІДБОРУ ---
    "candidate-success-screening": "<b>Чудово, анкету отримано! ✨</b>\n\nТвоя анкета у нас. Ми опрацюємо її якнайшвидше і запропонуємо час для співбесіди. Попереду багато цікавого! 📸",
    "candidate-success-manual-review": "Вітаємо! 🎉\n\nТи пройшла первинний етап. Оскільки ти вказала особливості зовнішності, ми розглянемо анкету індивідуально. HR-менеджер скоро напише тобі тут. 🌸",
    "candidate-success-waitlist": "Дякуємо! Хоча зараз команда на цій локації повна, ми зберегли твою анкету в пріоритетний список. ⏳\n\nЯк тільки з'явиться місце — я одразу тобі напишу.",
    "candidate-waitlist-slots": (firstName: string, typeText: string) => `🌸 <b>${firstName}</b>, ми вже готуємо нові вікна у графіку для <b>${typeText}</b>. ✨\n\nЯ надішлю тобі сповіщення, як тільки вони з'являться.`,
    
    "candidate-interview-scheduled": (dateStr: string, timeStr: string, meetLink?: string) => {
        let text = `🗓️ <b>Твоя співбесіда запланована!</b>\n\n📅 Дата: <b>${dateStr}</b>\n⏰ Час: <b>${timeStr}</b>\n`;
        if (meetLink) text += `📹 <a href="${meetLink}">Приєднатися до зустрічі</a>\n`;
        else text += `\nHR надішле посилання на відеозустріч ближче до часу проведення. ✨\n`;
        return text;
    },

    "candidate-accepted-materials": (firstName: string) => `🌸 <b>${firstName}</b>, матеріали вже у тебе!\n\nНаступний крок — наша відеозустріч-знайомство (20 хв). Обери зручний час:`,
    "candidate-accepted-welcome": (firstName: string) => `🎉 <b>Вітаємо, ${firstName}!</b>\n\nТи прийнята в команду PlayPhoto! 🌸✨\n\nНаставниця скоро зв'яжеться з тобою щодо навчання. Ласкаво просимо! 💖`,

    "candidate-training-scheduled": (typeLabel: string, dateStr: string, timeStr: string, meetLink?: string) => {
        let text = `🗓️ <b>Твоє ${typeLabel} заплановане!</b>\n\n📅 Дата: <b>${dateStr}</b>\n⏰ Час: <b>${timeStr}</b>\n`;
        if (meetLink) text += `📹 <a href="${meetLink}">Приєднатися до зустрічі</a>\n`;
        text += `\nТвоя наставниця чекатиме на тебе! ✨`;
        return text;
    },

    "candidate-discovery-completed": (firstName: string) => `🌸 <b>${firstName}</b>, знайомство пройшло чудово! Наступний етап — online-навчання. ✨`,
    "candidate-training-completed-nda": (firstName: string) => `📋 <b>Останній крок перед стажуванням!</b>\n\n${firstName}, ознайомся з правилами команди (NDA). Це займе 2 хвилини! ✨`,
    "candidate-training-completed-quiz": (firstName: string) => `✅ <b>NDA підписано!</b>\n\n${firstName}, тепер ти можеш переходити до тестування. ✨`,

    "candidate-rejected": "🌸 <b>Дякуємо за інтерес до PlayPhoto!</b>\n\nНа жаль, наразі ми не можемо запропонувати тобі місце в команді. Бажаємо успіхів! ✨",
    "candidate-default-status": (firstName: string) => `🌸 <b>Вітаємо, ${firstName}!</b>\n\nТвоя анкета опрацьовується. Ми зв'яжемося з тобою найближчим часом! ✨`,
    "candidate-reject-underage": "На жаль, ми приймаємо в команду дівчат тільки з 17 років. 🎀\n\nМи зберегли твою анкету. Коли тобі виповниться 17, ми обов'язково зв'яжемося. Успіхів!",
    "candidate-info-no-vacancies": (city: string) => `На жаль, наразі у місті ${city} немає відкритих вакансій, доступних для вибору 🌸\n\nМи збережемо твої контакти і напишемо, як тільки з'явиться місце! ✨`,
    "candidate-error-birthday-invalid": "Здається, такої дати не існує або вона введена невірно. Напиши, будь ласка, як у прикладі: 15.05.2005 😊",
    "candidate-error-city-invalid": "Назва міста має містити лише букви та бути не коротшою за 2 символи.",
    "candidate-error-city-already-exists": (city: string) => `О, ми вже працюємо у цьому місті! Просто натисни кнопку "${city}" у списку вище 😊`,
    "candidate-success-other-city": (city: string) => `Дякуємо! Ми поки не працюємо у місті <b>${city}</b>, але ми стрімко розширюємось. Твою анкету збережено в пріоритетний список. Сповіщення надійде одразу, як тільки ми розпочнемо набір у твоєму місті! 🕊️`,
    "candidate-ask-other-city-name": "Напиши, будь ласка, з якого ти міста? ✍️",

    // --- 3. DISCOVERY ТА ОНЛАЙН СТАЖУВАННЯ ---
    "discovery-invite": (firstName: string, kbLink: string) => `${firstName}, тримай посилання на нашу Базу знань. 📚\n\n🔗 <a href="${kbLink}">Перейти до матеріалів</a>\n\nБудь ласка, ознайомся з ними перед нашою відеозустріччю (20 хв). Ми розберемо реальні кейси, щоб ти могла краще зрозуміти свою роль.\n\nОбери зручний час для знайомства:`,
    "discovery-confirm": (mentorName: string, date: string, time: string) => `Чудово, зустріч призначено! 📅\n\nНаставниця <b>${mentorName}</b> чекатиме на тебе. Якщо виникнуть питання — ти можеш написати їй особисто.\n\n⏰ <b>${date}</b> о <b>${time}</b>\n🔗 Посилання на Meet надішлю за 10 хвилин до початку.`,
    "training-manual-invite": (date: string, time: string, channelLink: string, kbLink: string) => `<b>Ти в команді! 📸</b>\n\nНам було дуже приємно познайомитися. Твій наступний крок — online-стажування, де ми разом розберемо всі тонкощі твоєї нової ролі.\n\n📅 <b>${date}</b> о <b>${time}</b>\n\nДоєднуйся до нашої спільноти та зазирни у Гайд. Тут усе, що допоможе тобі стартувати впевнено:\n\n🕊️ <a href="${channelLink}">Канал підтримки</a>\n📚 <a href="${kbLink}">Гайд фотографа</a>\n\nПосилання на зустріч надішлю за 10 хвилин до початку. До зустрічі! 🤍`,

    // --- 4. NDA ---
    "nda-request": (firstName: string, ndaLink: string, jobDetails: string) => `<b>Майже на місці ✨</b>\n\n${firstName}, залишилася остання формальність — ознайомлення з NDA. Це наш стандарт професійної етики та захисту спільної творчості. Це займе не більше 2-х хвилин.\n\n<b>Деталі роботи:</b>${jobDetails}\n\n📄 <b>Договір:</b> <a href="${ndaLink}">Ознайомитись з NDA</a>\n\nБудь ласка, прочитай та підтвердь готовність:`,
    "nda-reminder": (firstName: string, ndaLink: string) => `Привіт, ${firstName}! ✨\n\nНагадую про ознайомлення з NDA. Це необхідний крок перед початком стажування на локації. 📸\n\n🔗 <a href="${ndaLink}">Договір NDA PlayPhoto</a>\n\nПрочитай його уважно і натисни кнопку нижче.`,

    // --- 5. ТЕСТ ТА ОФЛАЙН СТАЖУВАННЯ ---
    "nda-confirmed-start-quiz": "✅ <b>Ознайомлення зафіксовано</b>\n\nТепер переходимо до фінального кроку — тестування за матеріалами навчання. Це допоможе нам переконатися, що ти готова до роботи на локації. 📸\n\nГотова розпочати?",
    "training-test-success": "✨ <b>Тест завершено!</b>\n\nТи успішно підтвердила свої знання. Тепер я передаю твою анкету нашому головному адміністратору для узгодження офлайн-стажування на локації.\n\nЯкщо у тебе є питання або ти хочеш уточнити деталі — ти можеш написати йому за допомогою кнопки нижче! 📞",
    "staging-quiz-success": (score: number, total: number) => `Вітаємо! 🎉\n\nТи успішно пройшла тест (${score}/${total} балів). Твої знання на висоті!\n\nНаступний крок — знайомство з локацією та перше офлайн-стажування. Воно триває 2 години (15:00–17:00).\n\nОбери зручний день для візиту:`,
    "staging-date-confirmed": (date: string) => `Дякуємо! 📅\n\nМи отримали твій запит на <b>${date}</b>.\nСтажування зазвичай проходить з <b>15:00 до 17:00</b>.\n\nАдміністратор перевірить графік та підтвердить візит найближчим часом. Статус з’явиться в головному меню.`,
    "staging-date-confirmed-kb": new InlineKeyboard().text("🗓️ Змінити дату", "start_staging_selection").row().text("👨‍💼 Написати Адміну", "contact_hr"),
    "staging-no-date-available": "✨ <b>Зрозумів!</b>\n\nМи зв'яжемося з тобою найближчим часом, щоб підібрати іншу дату для стажування. На зв'язку! 🌸",
    "staging-cancelled-by-candidate": "🌸 <b>Зрозумів, плани змінилися.</b>\n\nМи зняли твій запис на стажування. Адміністратор зв'яжеться з тобою, щоб підібрати інший час! ✨",
    "staging-success-activation": (firstName: string) => `<b>Вітаємо в команді! 🎉</b>\n\n${firstName}, стажування пройшло успішно. Останній крок — активація твого робочого профілю. Це відкриє доступ до графіку та всіх можливостей бота.\n\nЦе займе не більше 2-х хвилин. Почнемо?`,

    // --- 6. ЖИВА КАРТКА (UI В ГОЛОВНОМУ МЕНЮ) ---
    "status-card-staging-confirmed": (locName: string, date: string, time: string) => `📸 <b>Твоє стажування на локації</b>\n\n📍 <b>${locName}</b>\n📅 <b>${date} • ${time}</b>\n\nНа місці тебе зустріне фотограф і допоможе з усім розібратися. До зустрічі! 📸`,
    "status-card-staging-pending": "📸 <b>Готуємо твоє стажування</b>\n\nМи підбираємо напарника для твого першого виходу на локацію. Скоро підтвердимо візит! 🌸",
    
    // --- 7. UI BUTTONS ---
    "candidate-btn-gender-female": "Я дівчина 👗",
    "candidate-btn-gender-male": "Я хлопець 👔",
    "candidate-btn-city-other": "🌍 Інше місто",
    "candidate-btn-source-instagram": "Instagram 📸",
    "candidate-btn-source-workua": "Work.ua 💼",
    "candidate-btn-source-olx": "OLX 🛒",
    "candidate-btn-source-other": "Інше 🤷‍♀️",
    "candidate-btn-appr-no": "Ні, нічого такого ✨",
    "candidate-btn-appr-yes": "Так, маю 💍",
    "candidate-val-appearance-none": "Без особливостей",
    "candidate-ask-appearance-details": "Зрозуміла! Напиши, будь ласка, детальніше: що саме і де знаходиться? Або просто <b>надішли фото</b> (так буде навіть краще!) 📸✨",
    "candidate-support-welcome": "❤️ <b>Раді тебе бачити!</b>\n\nТвій шлях у PlayPhoto вже розпочався. 📸\n\nЩоб твоє питання було вирішено максимально швидко — будь ласка, скористайся кнопкою <b>'Допомога 🆘'</b> в головному меню або напиши своїй наставниці в особисті повідомлення.",
    "candidate-feedback-sent": "✨ <b>Повідомлення надіслано!</b>\n\nМи отримали твій запит і відповімо найближчим часом. Очікуй сповіщення! 🕊️",
    "candidate-confirm-msg-to-role": (roleLabel: string, text: string) => `🧐 <b>Це повідомлення для ${roleLabel}?</b>\n\nТвій текст: <i>"${text}"</i>\n\nЯкщо так — натисни кнопку нижче, щоб ми його отримали. ✨`,
    "candidate-confirm-photo-to-role": (roleLabel: string) => `🧐 <b>Надіслати це фото ${roleLabel}?</b>\n\nЯкщо так — натисни кнопку нижче. ✨`,
    "candidate-reject-male-location": (locationName: string, city: string) => `На жаль, на локації <b>${locationName}</b> у місті <b>${city}</b> наша команда фотографів вже укомплектована 🌸\n\nДякуємо за інтерес до PlayPhoto! Ми зберегли твої дані і, можливо, зв'яжемось у майбутньому. Успіхів! 👋`,

    // --- 8. WORKER NOTIFICATIONS ---
    "worker-offer-accepted": (firstName: string, mentorDisplay: string) => `Ура, ${firstName}! 🎉 Ти в команді!\n\nМи впевнені, що ти ідеально впишешся в нашу сім'ю PlayPhoto. 📸\n\nНаступний крок — навчання. ${mentorDisplay} зв'яжеться з тобою найближчим часом, щоб домовитись про перший день.\n\nГотуйся створювати магію! ✨`,
    "worker-offer-rejected": "Привіт! 🌸\n\nДякуємо за час та спілкування. Наразі ми не можемо запропонувати тобі оффер. Це було непросте рішення.\n\nБажаємо успіхів у пошуку роботи мрії! Можливо, наші шляхи ще перетнуться в майбутньому. ✨",
    
    "worker-interview-reminder-6h": (firstName: string, timeStr: string, hrDisplay: string) => `🔔 <b>Нагадування</b>\n\nПривіт, ${firstName}! 👋\n\nСьогодні о <b>${timeStr}</b> на тебе чекає ${hrDisplay}. 🌸\nБудь ласка, перевір стабільність інтернету та підготуй гарний настрій!`,
    "worker-interview-reminder-10m": (timeStr: string, hrDisplay: string, meetLink?: string) => {
        let text = `🚀 <b>Співбесіда вже за 10 хвилин!</b>\n\n⏰ Час: <b>${timeStr}</b>\n✨ На тебе чекає ${hrDisplay}.`;
        if (meetLink) text += `\n\n🔗 <b>Meet:</b> <a href="${meetLink}">Приєднатися зараз</a>`;
        return text;
    },

    "worker-training-reminder-6h": (firstName: string, typeText: string, timeStr: string, mentorDisplay: string) => `🔔 <b>Нагадування про ${typeText}</b>\n\nПривіт, ${firstName}! 👋\n\nСьогодні о <b>${timeStr}</b> на тебе чекає ${mentorDisplay}. 🎓\nБудь ласка, переконайся, що в тебе є стабільний інтернет.`,
    "worker-training-reminder-10m": (typeText: string, timeStr: string, mentorDisplay: string, meetLink?: string) => {
        let text = `🚀 <b>${typeText.charAt(0).toUpperCase() + typeText.slice(1)} вже за 10 хвилин!</b>\n\n⏰ Час: <b>${timeStr}</b>\n✨ На тебе чекає ${mentorDisplay}.`;
        if (meetLink) text += `\n\n🔗 <b>Meet:</b> <a href="${meetLink}">Приєднатися</a>`;
        return text;
    },

    "worker-abandoned-screening": "<b>Анкету майже завершено! ✨</b>\n\nТвій шлях у PlayPhoto розпочато. Залишилося ще кілька кроків, щоб ми могли познайомитися ближче. Натисни /start, щоб продовжити з того місця, де ми зупинилися! 📸",
    "worker-abandoned-onboarding": "Привіт! 👋\n\nМи все ще чекаємо на твої документи, щоб офіційно прийняти тебе в команду PlayPhoto. Це займе всього пару хвилин! ✨",

    // --- 9. ADMIN TRIGGERED NOTIFICATIONS ---
    "admin-re-invite-interview": "Привіт! ✨ Ми оновили графік співбесід. Обери зручний час для зустрічі:",
    "admin-re-invite-training": "Привіт! ✨ З'явилися нові вільні вікна для онлайн-навчання. Обери зручний час:",
    
    "admin-staging-confirmation": (firstName: string, locText: string, dateStr: string, stagingTime: string, partnerShortName: string) => 
        `<b>Твоє стажування в PlayPhoto ✨</b>\n\n` +
        `Ми вже чекаємо на тебе, ${firstName}! Це чудовий шанс познайомитися з командою та спробувати себе у справі.\n\n` +
        `${locText}\n` +
        `🗓 <b>${dateStr} • ${stagingTime}</b>\n` +
        `🤝 Напарник: <b>${partnerShortName}</b>\n\n` +
        `Твій напарник зустріне тебе на місці та допоможе з усім розібратися. Просто будь собою та насолоджуйся процесом! 📸`,

    "admin-staging-passed-activation": (firstName: string) =>
        `<b>Ти молодець, ${firstName}! 🎉</b>\n\n` +
        `Стажування пройшло чудово. Ми раді, що ти тепер частина команди PlayPhoto.\n\n` +
        `Залишився останній крок — активація твого робочого профілю. Це відкриє доступ до графіку та всіх можливостей бота. 🕊️\n\n` +
        `Це займе не більше 2-х хвилин. Почнемо?`,
    "admin-final-welcome": (firstName: string) => 
        `✨ <b>Вітаємо у сім'ї PlayPhoto, ${firstName}!</b> 📸\n\nТвій робочий профіль активовано. Тепер тобі доступні всі можливості бота:\n\n` +
        `🗓 <b>Графік</b> — твої зміни та локації.\n` +
        `📊 <b>Статистика</b> — результати та виплати.\n` +
        `📚 <b>База знань</b> — інструкції та правила.\n` +
        `🆘 <b>Підтримка</b> — ми завжди на зв'язку.\n\n` +
        `Натисни кнопку нижче, щоб відкрити свій робочий кабінет:`,

    // --- 10. MENTOR TRIGGERED NOTIFICATIONS ---
    "mentor-training-passed-nda": (firstName: string, ndaLink: string) => 
        `Вітаємо, ${firstName}! 🎉\n\nТи успішно пройшла <b>online-стажування</b>. ✨\n\nНаступний крок — ознайомлення з NDA.\n\n` +
        `🔗 <a href="${ndaLink}">Договір NDA PlayPhoto</a>\n\n` +
        `Прочитай його уважно і натисни кнопку нижче, коли будеш готова продовжувати.`,

    "mentor-manual-discovery-assigned": (date: string, timeStr: string) => 
        `Тобі призначено коротку відеозустріч-знайомство! 🌸\n\n⏰ Час: <b>${date}</b> о <b>${timeStr}</b>\n🔗 Посилання на Meet надішлю перед початком.`,

    "mentor-discovery-failed": "Привіт! 🌸\n\nДякуємо за знайомство. На жаль, за результатами зустрічі ми прийняли рішення не продовжувати співпрацю на даному етапі.\n\nБажаємо успіхів! ✨",
    "mentor-discovery-no-show": "Привіт! 🌸\n\nМи зафіксували, що ти не з'явилася на зустріч-знайомство без попередження. На жаль, через це ми припиняємо розгляд твоєї кандидатури.\n\nБажаємо успіхів! ✨",
    "mentor-training-failed": "На жаль, за результатами навчання ми не готові продовжити співпрацю. Успіхів!",
    "hr-rejection-appearance": "Привіт! 🌸\n\nДякуємо за інтерес до PlayPhoto. На жаль, наразі ми не можемо запропонувати співпрацю через невідповідність нашим внутрішнім правилам щодо зовнішнього вигляду.\n\nБажаємо успіхів у пошуках! ✨",
    "hr-manual-review-approved": "Вітаємо! 🎉\n\nТвоя анкета розглянута та прийнята. Наша HR зв'яжеться з тобою найближчим часом для наступних кроків. ✨",
    "hr-manual-interview-assigned": (dateStr: string) => `Тобі призначено співбесіду! 📅\n\n⏰ Час: <b>${dateStr}</b>\n📍 Локація: Google Meet\n\nБудь ласка, будь на зв'язку! ✨`,
};
