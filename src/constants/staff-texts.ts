export const STAFF_TEXTS = {
  "welcome-message": `Привіт! Ми дуже раді, що ти хочеш приєднатися до нашої команди PlayPhoto 🌸✨\nЯ допоможу тобі пройти шлях до твоєї першої зміни. Це буде цікаво! 📸`,
  "ask-name": `Як тебе звати? 😊
(Напиши, будь ласка, своє ім'я та прізвище)`,
  "error-name-format": (p: { error: string | number }) => `⚠️ ${p.error}
Як тебе звати? 😊
(Напиши, будь ласка, своє ім'я та прізвище)`,
  "candidate-error-name-min": `ПІБ має бути не менше 5 символів`,
  "candidate-error-name-max": `ПІБ занадто довге`,
  "candidate-error-name-parts": `Введіть Ім'я та Прізвище`,
  "candidate-error-name-cmd": `Це схоже на команду, введіть ім'я`,
  "candidate-error-name-digits": `Ім'я не може містити цифри`,
  "candidate-error-age-min": `Мінімальний вік — 14 років`,
  "candidate-error-age-real": `Введіть реальну дату народження`,
  "candidate-error-retry": `Будь ласка, спробуй ще раз.`,
  "candidate-greeting-nicetomeet": (p: { fullName: string | number }) => `${p.fullName}, приємно познайомитись! 🌸✨
Щоб я міг правильно підібрати локацію для тебе, підкажи, будь ласка:`,
  "candidate-btn-gender-female": `Я дівчина 👗`,
  "candidate-btn-gender-male": `Я хлопець 👔`,
  "candidate-ask-birthday": `Коли твій день народження? 🎂\n(Напиши у форматі ДД.ММ.РРРР, наприклад <code>15.05.2005</code>)`,
  "candidate-error-birthday-format": (p: { error: string | number }) => `⚠️ ${p.error}`,
  "candidate-error-birthday-invalid": `Здається, такої дати не існує або вона введена невірно. Напиши, будь ласка, як у прикладі: 15.05.2005 😊`,
  "candidate-ask-city": `Обери місто, в якому ти бажаєш працювати:`,
  "candidate-label-your-city": `Твоє місто:`,
  "candidate-ask-location-multiple": (p: { locList: string | number }) => `У цьому місті у нас кілька локацій. Обери ту, яка тобі найзручніша: 🏢\n${p.locList}`,
  "candidate-status-available": `є вільні місця`,
  "candidate-status-full": `команда повна`,
  "candidate-label-address-unknown": `Адреса уточнюється`,
  "candidate-info-no-vacancies": (p: { city: string | number }) => `На жаль, наразі у місті ${p.city} немає відкритих вакансій, доступних для вибору 🌸
Ми збережемо твої контакти і напишемо, як тільки з'явиться місце! ✨`,
  "candidate-info-location-full-alt": (p: { locationName: string | number }) => `На локації "${p.locationName}" наразі команда повністю укомптована 🌸
Але ми дуже хочемо тебе в PlayPhoto! Можливо, тобі буде зручно працювати на одній з цих локацій, де ми зараз шукаємо фотографів? ✨`,
  "candidate-btn-wait-own-location": `Чекати саме на свою ⏳`,
  "candidate-ask-source": `Майже все! Підкажи, звідки ти дізналась про нашу вакансію? 🕵️‍♀️`,
  "candidate-btn-source-instagram": `Instagram 📸`,
  "candidate-btn-source-workua": `Work.ua 💼`,
  "candidate-btn-source-olx": `OLX 🛒`,
  "candidate-btn-source-other": `Інше 🤷‍♀️`,
  "candidate-val-appearance-none": `Без особливостей`,
  "candidate-ask-appearance": `В нас є певні вимоги до зовнішності, оскільки ми працюємо з дітками. Скажи, чи маєш ти видимі татуювання (зокрема на шиї чи руках) або пірсинг на обличчі? 🎀`,
  "candidate-btn-appr-no": `Ні, нічого такого ✨`,
  "candidate-btn-appr-yes": `Так, маю 💍`,
  "candidate-ask-appearance-details": `Зрозуміла! Напиши, будь ласка, детальніше: що саме і де знаходиться? Або просто <b>надішли фото</b> (так буде навіть краще!) 📸✨`,
  "candidate-val-appearance-photo": (p: { caption: string | number }) => `[Фото надіслано] ${p.caption}`,
  "candidate-info-processing": `Дякую за відповіді! Обробляю твою анкету... ⏳`,
  "candidate-reject-male": `Дякуємо за інтерес до PlayPhoto! ✨ Наразі на цій локації вже знайдено фотографів, але ми обов'язково зв'яжемось з тобою за потреби. Успіхів! 👋`,
  "candidate-reject-male-location": (p: { locationName: string | number, city: string | number }) => `На жаль, на локації <b>${p.locationName}</b> у місті <b>${p.city}</b> наша команда фотографів вже укомплектована 🌸
Дякуємо за інтерес до PlayPhoto! Ми зберегли твої дані і, можливо, зв'яжемось у майбутньому. Успіхів! 👋`,
  "candidate-reject-underage": `Дякуємо, ми зберегли твою анкету 🌸

Зараз для твоєї анкети ще не відкритий наступний етап, але ми не губимо контакт. Щойно з'явиться відповідна можливість, бот сам нагадає про PlayPhoto, і ти зможеш продовжити шлях до команди 📸✨`,
  "candidate-success-manual-review": `Вітаємо! 🎉
Ти успішно пройшла первинний відбір! Твоя анкета вже у нашої HR. Оскільки ти вказала наявність татуювань, ми розглянемо це індивідуально та скоро напишемо тобі сюди! 🌸✨📸🤍`,
  "candidate-success-waitlist": `Дякуємо! Хоча зараз команда на цій локації повна, ми зберегли твою анкету в пріоритетний список очікування ⏳
Як тільки з'явиться місце — мені прийде сигнал, і я одразу тобі напишу! 🌸✨`,
  "candidate-success-screening": `Вітаємо! 🎉
Ти успішно пройшла первинний відбір! Твоя анкета вже у нашої HR. Очікуй, скоро вона надішле тобі пропозицію з датою та часом співбесіди прямо сюди! 🌸✨📸🤍🕊️`,
  "hr-error-format-session": `⚠️ Invalid format. Try again:
DD.MM HH:MM-HH:MM
Example: 05.02 10:00-14:00`,
  "hr-error-past-time": `⚠️ This time has already passed (or date is in the past).`,
  "hr-error-end-before-start": `⚠️ End time must be after start time.`,
  "hr-success-created-slots": (p: { count: string | number, date: string | number }) => `✅ Created ${p.count} slots (15 min each) for ${p.date}! 📅`,
  "hr-error-generic": (p: { error: string | number }) => `❌ Error: ${p.error}`,
  "hr-success-added-single-slot": (p: { dateTime: string | number }) => `✅ Added one slot: ${p.dateTime}`,
  "hr-error-create-slot": `❌ Error creating slot.`,
  "hr-ask-time-for-date": (p: { date: string | number }) => `📅 Date ${p.date} accepted. Now enter start time (e.g., 14:30):`,
  "hr-error-format-date": `⚠️ Invalid format. Enter 'DD.MM HH:MM' or just 'DD.MM'.`,
  "hr-error-time-format": `⚠️ Invalid time. Try again (HH:MM):`,
  "hr-error-no-date-selected": `❌ Error: No date selected. Use calendar.`,
  "hr-error-time-range-format": `⚠️ Invalid format. Try again (HH:MM-HH:MM):`,
  "hr-error-end-before-start-short": `⚠️ End before start.`,
  "hr-success-added-multiple-slots": (p: { count: string | number, date: string | number }) => `✅ Added ${p.count} slots for ${p.date}!`,
  "hr-menu-inbox": (p: { count: number }) => p.count > 0 ? `📥 Inbox (${p.count})` : `📥 Inbox`,
  "hr-menu-leads": (p: { count: number }) => p.count > 0 ? `🔥 Leads (${p.count})` : `📥 Leads`,
  "hr-menu-calendar": (p: { count: number }) => p.count > 0 ? `🗓️ Calendar (${p.count})` : `🗓️ Calendar`,
  "hr-menu-tools": `📣 Broadcasts`,
  "hr-menu-refresh": `🔄 Refresh`,
  "hr-menu-new-candidates": (p: { count: number }) => p.count > 0 ? `🆕 New Apps (${p.count})` : `🆕 New Apps`,
  "hr-menu-broadcast-screening": `📣 Invite New`,
  "hr-menu-sessions": `📅 Schedule`,
  "hr-menu-back": `⬅️ Back`,
  "hr-menu-messages": (p: { count: number }) => p.count > 0 ? `💬 Messages (${p.count})` : `💬 Messages`,
  "hr-menu-decisions": (p: { count: number }) => p.count > 0 ? `⚖️ Decisions (${p.count})` : `⚖️ Decisions`,
  "hr-menu-tattoo": (p: { count: number }) => p.count > 0 ? `💍 Appearance (${p.count})` : `💍 Appearance`,
  "hr-menu-waitlist": (p: { count: number }) => p.count > 0 ? `⏳ Waitlist (${p.count})` : `⏳ Waitlist`,
  "hr-menu-offline-staging": (p: { count: number }) => p.count > 0 ? `📸 Staging (${p.count})` : `📸 Staging`,
  "hr-menu-final-setup": (p: { count: number }) => p.count > 0 ? `📋 Final Step (${p.count})` : `📋 Final Step`,
  "hr-menu-back-home": `🏠 Menu`,
  "hr-btn-back-to-calendar": `⬅️ Back to Calendar`,
  "hr-info-invite-new-confirm": (p: { city: string | number, locationName: string | number, count: string | number, totalNeeded: string | number }) => `🌆 City: <b>${p.city}</b>\n📍 Location: <b>${p.locationName}</b>\n👥 New Apps: <b>${p.count}</b>\n💎 Open Positions: <b>${p.totalNeeded}</b>\n\nSend invitation to all new candidates for this location? ✨`,
  "staff-btn-home": `🏠 Меню`,
  "staff-replacement-accepted": (p: { details: string }) => `✅ <b>Підміну підтверджено</b>

Ця зміна закріплена за вами:
${p.details}

Більше пропозицій на цю дату бот не надсилатиме. У розділі «Мій графік» зміна може з'явитися трохи пізніше після синхронізації адміністратором.`,
  "staff-replacement-other-offer-closed": (p: { details: string }) => `Цю пропозицію закрито для вас, бо ви вже підтвердили іншу зміну на цю дату.

${p.details}`,
  "staff-replacement-canonical-failed": `Не вдалося створити запит на підміну. Спробуй ще раз або напиши в підтримку.`,
  // Бекенд доступний і відповів осмислено: пошук уже триває. Порада
  // «спробуй ще раз» тут марна — повтор упреться в той самий конфлікт.
  "staff-replacement-already-open": `Пошук на цю зміну вже триває. Щойно хтось погодиться — ми одразу напишемо.`,
  "staff-replacement-search-active-hub": `🔎 <i>Шукаємо підміну. Поки її не підтвердили, ця зміна залишається твоєю.</i>`,
  "staff-replacement-search-active-schedule": `🔎 <i>шукаємо підміну — зміна поки твоя</i>`,
  "staff-replacement-pending-sync-hub": `✅ <i>Підміна підтверджена, графік синхронізується</i>`,
  "staff-replacement-pending-sync-schedule": `✅ <i>підміна підтверджена</i>`,
  "staff-replacement-pending-sync-reminder": `✅ Підміну підтверджено. Основний графік ще синхронізується.`,
  "staff-replacement-overridden-requester": `Підтверджену підміну закрито: актуальний графік уже змінено.`,
  "staff-replacement-overridden-acceptor": (p: { details: string }) => `⚠️ <b>Підміну змінено в актуальному графіку</b>

Ця зміна більше не закріплена за тобою:
${p.details}

Орієнтуйся на розділ «Мій графік». Якщо зміна все ж мала залишитися твоєю, напиши в підтримку.`,
  "staff-replacement-confirmed-cancelled-requester": `Підтверджену підміну скасовано адміністратором.

Орієнтуйся на актуальний графік у боті. Якщо інформація не відповідає домовленості, напиши в підтримку.`,
  "staff-replacement-confirmed-cancelled-acceptor": (p: { details: string }) => `⚠️ <b>Підтверджену підміну скасовано адміністратором</b>

Ця зміна більше не закріплена за тобою:
${p.details}

Орієнтуйся на розділ «Мій графік». Якщо це не відповідає домовленості, напиши в підтримку.`,
  // Sent when the candidate had marked this day unavailable. Naming that first
  // is the point: she is being asked anyway, and pretending otherwise reads as
  // if nobody looked at her preferences.
  "staff-replacement-offer-unavailable-wave": (p: { location: string; date: string; time: string }) => `🌸 Знаємо, що ти позначала цей день як зайнятий — і це ок.
Просто на випадок, якщо плани змінилися: зміна ще вільна.

📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛`,
  // The default, and what an older backend that sends no `availabilityKind`
  // falls back to: it claims nothing about what she did or did not mark.
  "staff-replacement-offer": (p: { location: string; date: string; time: string }) => `🔔 Потрібна підміна на зміну — можливо, тобі підійде.

📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛`,
  // Чем заменяется карточка оффера после ответа. Переписывание на месте, а не
  // новое сообщение: исход читается там же, где названа смена, и лента не растёт
  // на девятнадцать сообщений с одного пошуку.
  "staff-replacement-offer-answered-accepted": (p: { location: string; date: string; time: string }) => `✅ <b>Ти виходиш на цю зміну</b>

📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Перевір «Мій графік» 💛`,
  // Отказ — одной строкой: рішення прийнято, повертатися до цієї зміни немає
  // потреби, але слід має лишитися читабельним.
  "staff-replacement-offer-answered-declined": (p: { location: string; date: string }) => `🚫 Ти відмовилась — ${p.location}, ${p.date}`,
  "staff-replacement-offer-answered-gone": (p: { location: string; date: string }) => `⌛️ Зміну вже закрито — хтось відгукнувся раніше.

📍 ${p.location}
📅 ${p.date}`,
  // Когда разбор карточки не удался: деталей нет, но сообщение обязано
  // перестать выглядеть действующим.
  "staff-replacement-offer-answered-accepted-bare": `✅ Ти виходиш на цю зміну. Перевір «Мій графік» 💛`,
  "staff-replacement-offer-answered-declined-bare": `🚫 Ти відмовилась від цієї зміни`,
  "staff-replacement-offer-answered-gone-bare": `⌛️ Зміну вже закрито — хтось відгукнувся раніше`,
  // Вакансія: на зміні ще нікого немає, і ніхто не зникав. Слово «підміна»
  // тут збрехало б — саме тому словник з замінами не перетинається.
  // Єдине сповіщення, адресоване не кандидату, а тій, кого підміняють:
  // власник запустив пошук за неї. Без нього людина дізнавалась про це,
  // побачивши чужого на своїй зміні. Кнопок немає — рішення вже прийняте.
  "staff-search-started": (p: { location: string; date: string; time: string }) => `🔎 Ми шукаємо тобі підміну на цю зміну.

📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Щойно хтось погодиться — напишемо. Поки що зміна лишається твоєю 💛`,
  "staff-open-shift-offer": (p: { location: string; date: string; time: string }) => `🆕 Вільна зміна — можеш взяти.

📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Хто перший погодиться — за тим і зміна 💛`,
  "staff-open-shift-btn-accept": `✅ Беру`,
  "staff-open-shift-btn-decline": `🚫 Не можу`,
  "staff-open-shift-taken": (p: { location: string; date: string }) => `Цю зміну вже взяли: ${p.location}, ${p.date}.`,
  "staff-replacement-offer-btn-accept": `✅ Можу вийти`,
  "staff-replacement-offer-btn-decline": `🚫 Не можу`,
  "staff-replacement-offer-accepted": `Зміна твоя 💛 Перевір «Мій графік».`,
  "staff-replacement-offer-declined": `Зрозуміло, дякуємо за відповідь 💛`,
  "staff-replacement-offer-gone": `Зміну вже закрито — хтось був раніше 💛`,
  /** Узкая всплывашка: обрезается после ~45 символов, поэтому только действие. */
  "staff-replacement-offer-error": `Спробуй ще раз за хвилину 🌸`,
  /** Плашка з кнопкою «ОК» — місця більше, тому тут і куди звертатися. */
  "staff-replacement-offer-error-alert": `Не вдалося зберегти відповідь.

Спробуй ще раз за хвилину. Якщо не вийде — напиши в підтримку 💛`,
  "staff-replacement-offer-closed": (p: { location: string; date: string }) => `Зміну на ${p.location} ${p.date} вже закрито. Дякуємо, що відгукнулася 💛`,
  "staff-replacement-offer-reopened": (p: { location: string; date: string }) => `Зміна на ${p.location} ${p.date} знову вільна — попередня домовленість скасувалася.
Якщо готова, можеш взяти 🌸`,
  "staff-replacement-undo-done": `Скасовано, зміна знову у пошуку 💛`,
  "staff-replacement-accepted-btn-undo": `↩️ Це помилка, скасувати`,
  "staff-replacement-undo-ans-window-closed": `Час на скасування минув — напиши в підтримку.`,
  "staff-replacement-undo-ans-failed": `Спробуй ще раз 🌸`,
  "staff-replacement-reverted-by-owner": (p: { location: string; date: string }) => `Підміну на ${p.location} ${p.date} скасовано адміністратором. Пошук продовжується.`,
  "staff-replacement-reverted-by-candidate": (p: { location: string; date: string }) => `Домовленість на ${p.location} ${p.date} скасувалася — фотографиня, яка погодилась, відмінила це одразу. Пошук заміни триває.`,
  "staff-replacement-owner-review-confirmed": (p: { requesterName: string; candidateName: string; location: string; date: string; time: string }) => `✅ <b>Підміну автоматично підтверджено</b>

${p.requesterName} → ${p.candidateName}
📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Зміна вже переведена на нового фотографа. Якщо потрібно скасувати — натисни кнопку нижче.`,
  "staff-replacement-owner-review-needs-review": (p: { requesterName: string; candidateName: string; location: string; date: string; time: string }) => `⚠️ <b>Підміну прийнято, потрібне твоє рішення</b>

${p.requesterName} → ${p.candidateName}
📍 ${p.location}
📅 ${p.date}
🕐 ${p.time}

Автоматичні перевірки не пройшли — підтвердь або скасуй вручну в адмін-панелі. Кнопка нижче скасовує прийняту пропозицію.`,
  "staff-replacement-owner-review-btn-revert": `↩️ Скасувати підміну`,
  "staff-replacement-revert-ans-done": `Скасовано. Пошук підміни продовжується.`,
  "staff-replacement-revert-ans-failed": `Не вийшло — спробуй з адмін-панелі.`,
  // Second tap of the owner revert button, shown when the backend answers
  // REPLACEMENT_REVERT_NEEDS_ACKNOWLEDGEMENT: the shift starts soon enough
  // that a replacement may not be found in time, and the owner must
  // knowingly confirm rather than be told the action simply "failed".
  "staff-replacement-revert-late-warning": `⚠️ Зміна починається менш ніж за 2 години — заміну можуть не встигнути знайти.

Скасувати підміну попри це?`,
  "staff-replacement-revert-late-btn-confirm": `✅ Так, скасувати`,
  "staff-replacement-revert-late-btn-cancel": `Залишити як є`,
  "hr-help-decisions": `<b>Candidate Decisions</b> ⚖️`,
  "hr-label-all-decisions-made": `✅ All decisions made!`,
  "hr-label-error-id-not-found": `Error: ID not found`,
  "hr-label-candidate-not-found": `Candidate not found.`,
  "hr-btn-personal-invite": `💌 Personal Invite`,
  "hr-ans-personal-invite-sent": (p: { name: string | number }) => `Invitation sent to ${p.name}! ✨`,
  "hr-btn-accept-offer": `🎉 Accept (Offer)`,
  "hr-btn-reject": `❌ Reject`,
  "hr-btn-reschedule": `🗓️ Reschedule`,
  "hr-btn-write-message": `✍️ Message`,
  "hr-btn-change-location": `📍 Change Location`,
  "hr-btn-send-offer-now": `⚡️ Send Offer NOW`,
  "hr-ans-accepted": `Decision: ACCEPTED. Offer in 6 hours. ✅`,
  "hr-ans-rejected": `Decision: REJECTED. ❌`,
  "hr-ask-reply": (p: { userId: string | number }) => `Enter response for candidate (ID: ${p.userId}): ✍️`,
  "hr-btn-cancel": `✖️ Cancel`,
  "hr-label-no-new-candidates": `No new applications.`,
  "hr-label-new-candidates-header": `🆕 <b>New Applications:</b>`,
  "hr-help-new-cand-notice": ``,
  "hr-btn-add-time": `➕ Add Time`,
  "hr-ask-add-time": `✍️ <b>Enter date and time</b>
Choose input format:
📍 <b>Single slot</b>
<code>DD.MM HH:MM</code>
Example: <code>05.02 10:00</code>
📅 <b>Window (multiple slots)</b>
<code>DD.MM HH:MM-HH:MM</code>
Example: <code>05.02 10:00-14:00</code>
<i>(15 min slots will be created)</i>`,
  "mentor-btn-add-time": `➕ Add Time`,
  "mentor-ask-add-time": `✍️ <b>Enter date and time for training</b>
Choose input format:
📍 <b>Single slot</b>
<code>DD.MM HH:MM</code>
Example: <code>10.02 14:00</code>
📅 <b>Window (multiple slots)</b>
<code>DD.MM HH:MM-HH:MM</code>
Example: <code>10.02 14:00-18:00</code>
<i>(60 min slots will be created)</i>`,
  "hr-help-tattoo": `💍 <b>Appearance Check</b>
Candidates who reported tattoos/piercings.
Your approval is needed to proceed to interview booking. ✅/❌`,
  "hr-label-all-tattoos-checked": `All checks completed! ✨\nGreat job, HR! 🌸`,
  "hr-label-tattoo-action-hint": `Action needed:`,
  "hr-label-no-unread-messages": `No unread messages! ✨`,
  "hr-btn-reply-hint": `Click button below to reply!`,
  "hr-btn-reply": `✍️ Reply`,
  "mentor-btn-send-materials": `📚 Send Materials`,
  "mentor-menu-new": (p: { count: number }) => p.count > 0 ? `📥 New (${p.count})` : `📥 New`,
  "mentor-menu-waiting-booking": (p: { count: number }) => p.count > 0 ? `📩 Pending (${p.count})` : `📩 Pending`,
  "mentor-btn-manual-book": `🗓️ Schedule Manually`,
  "mentor-btn-resend-materials": `♻️ Resend Base`,
  "mentor-btn-remind-booking": `🔔 Remind Booking`,
  "hr-help-waitlist": `⏳ <b>Candidate Pools</b>
🗓️ <b>Needs Interview Slot</b> — candidates who could not book an interview time.
📍 <b>Location Reserve</b> — candidates saved for a location that is currently full.
👉 Add interview slots, then notify the Needs Interview Slot pool.`,
  "hr-label-waitlist-empty": `Everyone is scheduled! 🎉`,
  "hr-label-waitlist-location-full-header": `📍 Location reserve`,
  "hr-label-waitlist-no-slot-header": `📅 Needs interview slot`,
  "hr-btn-assign-time": `🗓️ Schedule`,
  "hr-label-no-offline-staging": `No one in offline staging. 🌸`,
  "hr-btn-passed": `✅ Pass`,
  "hr-btn-failed": `❌ Fail`,
  "hr-info-staging-success-cand": `🎉 Вітаємо з успішним проходженням офлайн-стажування!
Ти чудово впоралася на локації. Тепер залишився фінальний юридичний крок перед тим, як ми додамо тебе в офіційний графік:
📝 <b>Заповнення даних для договору NDA.</b>
Натисни кнопку нижче, щоб розпочати!`,
  "hr-btn-start-nda": `📑 Почати NDA`,
  "hr-ans-status-updated-success": `Status updated: Success! 🎉`,
  "hr-btn-schedule-created": `✅ Schedule Ready`,
  "hr-info-cand-schedule-ready": `✨ <b>Твій графік готовий!</b>
Наш адміністратор вніс твої дані в систему та підготував робочий графік. Твій наставник зв'яжеться з тобою для узгодження твоєї першої робочої зміни. Ласкаво просимо! 📸`,
  "hr-ans-mentor-notified": `Done! Mentor notified. 🚀`,
  "hr-info-broadcast-confirm": (p: { city: string | number, count: string | number }) => `🌆 City: <b>${p.city}</b>
👥 Candidates in queue: <b>${p.count}</b>
Are you sure you want to send invitations to all these candidates?`,
  "hr-btn-yes-send-all": `✅ Yes, Send All`,
  "hr-ans-broadcast-started": `Broadcast started... ⏳`,
  "hr-info-broadcast-item": (p: { locationName: string | number }) => `💌 <b>Привіт!</b>\n\nМи уважно розглянули твою анкету і раді запросити тебе на онлайн-співбесіду на локацію <b>${p.locationName}</b>! ✨\n\nБудь ласка, обери зручний для себе час:`,
  "hr-btn-invite-decline": `❌ Вже не актуально`,
  "hr-info-invite-declined": `Дякуємо, що повідомила! Бажаємо успіхів у подальших пошуках. Якщо в майбутньому ти знову захочеш приєднатися до нашої команди — ми будемо раді тебе бачити! 🤍`,
  "hr-btn-choose-time": `🗓️ Обрати час`,
  "hr-btn-invite-individual": `📩 Invite to Interview`,
  "hr-info-broadcast-done": (p: { count: string | number, city: string | number }) => `📢 Broadcast finished! Successfully sent ${p.count} invitations in ${p.city}. 🚀`,
  "hr-label-waitlist-none": `Waitlist is empty 🌸`,
  "hr-info-waitlist-broadcast-confirm": (p: { locationName: string | number, count: string | number }) => `🏢 Location: <b>${p.locationName}</b>\n⏳ Candidates in reserve: <b>${p.count}</b>\n\nSend invitation to all candidates in reserve for this location? ✨`,
  "hr-ans-waitlist-broadcast-started": `Waitlist broadcast started... ⏳`,
  "hr-info-waitlist-broadcast-item": (p: { fullName: string | number, locationName: string | number }) => `Привіт, ${p.fullName}! ✨
Чудові новини! На локації <b>${p.locationName}</b> з'явилося вільне місце. 😍
Ми готові запросити тебе на коротку online-співбесіду у Google Meet. Скоріше обирай зручний час за кнопкою нижче, поки його не забронювали інші — і я одразу надішлю посилання на зустріч!`,
  "hr-info-waitlist-broadcast-done": (p: { count: string | number, locationName: string | number }) => `📢 Broadcast finished! Invited ${p.count} girls to ${p.locationName}. 🚀`,
  "support-ans-already-processing": `Твій запит вже обробляється! 💌`,
  "support-info-already-open": `<b>Твій діалог з куратором вже відкритий.</b>
Просто напиши повідомлення сюди, і я миттєво передам його кураторам. ✨`,
  "support-ask-issue": `📝 <b>Пиши все, що тебе турбує!</b> ✨
Просто опиши своє питання або ситуацію одним повідомленням. Я все передам кураторам.
<i>Можна надсилати текст, фото або навіть кружечки!</i>`,
  "support-ans-assigned": (p: { ticketId: string | number }) => `✅ You assigned ticket #${p.ticketId} to yourself`,
  "support-info-assigned-to-user": `✅ <b>Твоє повідомлення вже в роботі!</b> ✨
Зачекай, будь ласка, ми вже вивчаємо деталі і скоро відповімо.`,
  "support-ans-already-closed": `Ticket already closed.`,
  "support-ask-reply": `💬 <b>Write response to photographer:</b>
Ticket will be closed after sending.`,
  "support-ans-urgent-status": (p: { ticketId: string | number, status: string | number }) => `Ticket #${p.ticketId} marked as ${p.status}`,
  "support-ans-user-not-found": `User not found.`,
  "support-info-transferred-dm": (p: { urgent: string | number, ticketId: string | number, name: string | number, location: string | number, status?: string | number }) => `${p.urgent}🔔 <b>Ticket #${p.ticketId} transferred to you!</b>
👤 <b>Photographer:</b> ${p.name}
📍 <b>Location:</b> ${p.location}
📝 <b>Status:</b> IN PROGRESS`,
  "support-btn-go-to-topic": `➡️ Go to topic`,
  "support-ans-transferred": (p: { adminName: string | number }) => `✅ Transferred to ${p.adminName}`,
  "support-ans-closed": `Ticket closed! ✖️`,
  "support-info-closed-by-user": `🔒 User closed the ticket.`,
  "support-info-closed-by-admin": `🔒 Curator closed the ticket.`,
  "support-info-closed-notice": `<b>Ми закрили твій запит.</b> Дякуємо за довіру! 🌸`,
  "support-info-no-active-ticket": `ℹ️ <b>У тебе наразі немає відкритого запиту.</b>
Якщо у тебе виникло питання або потрібна допомога — натисни кнопку нижче, щоб створити новий тікет. 🌸`,
  "support-btn-write-to-support": `🤍 Написати в сапорт`,
  "support-error-not-found": `⚠️ Ticket not found.`,
  "support-info-reply-from-admin": (p: { text: string | number }) => `💬 <b>Відповідь куратора:</b>
${p.text}`,
  "support-error-reply-failed": `❌ Error sending reply.`,
  "support-info-ticket-created": `✅ <b>Твій запит створено!</b> 🐾✨
Ми вже отримали твоє повідомлення і скоро відповімо. Дякуємо, що ти з нами! 🤍
<i>Можеш продовжувати писати сюди, якщо захочеш щось додати.</i>`,
  "support-info-clarification-sent": `✅ <b>Питання по задачі відправлено!</b> 📤
Куратор отримав твій запит і скоро відпише. Очікуй сповіщення! ⏳`,
  "support-info-clarification-closed": `✅ <b>Питання по задачі закрито.</b> 🌸`,
  "support-error-topic-failed": (p: { ticketId: string | number, error: string | number }) => `🆘 Error creating topic for Ticket #${p.ticketId}. Error: ${p.error}
Please check bot permissions (Manage Topics).`,
  "support-info-restored-ticket": (p: { ticketId: string | number, fullName: string | number, username: string | number, issueText: string | number }) => `<b>Restored ticket #${p.ticketId}</b>
👤 <b>${p.fullName}</b> (@${p.username})
📄 <i>${p.issueText}</i>`,
  "support-btn-close": `🔒 Close`,
  "support-btn-force-close": `🔒 Force Close`,
  "support-ans-force-closed": `✅ Ticket closed (no notification)`,
  "support-info-force-closed": (p: { ticketId: string | number }) => `✅ Ticket #${p.ticketId} force closed.`,
  "support-error-delivery-failed": `❌ Failed to deliver message (bot blocked).`,
  "admin-panel-title": `🤖 <b>PlayPhoto 2.0 Admin Panel</b>`,
  "admin-panel-team": (p: { active: string | number }) => `👥 <b>Team:</b> ${p.active} active`,
  "admin-panel-locations": (p: { active: string | number }) => `📍 <b>Locations:</b> ${p.active} active`,
  "admin-panel-category": `Choose category: 👇`,
  "support-panel-title": `<b>🛠 Support Panel</b>`,
  "support-panel-tickets": (p: { open: string | number, inprogress: string | number }) => `🎫 <b>Tickets:</b> ${p.open} open / ${p.inprogress} active`,
  "support-panel-urgent": (p: { urgent: string | number }) => `🆘 <b>Urgent:</b> ${p.urgent}`,
  "support-panel-tasks": (p: { overdue: string | number }) => `🔴 <b>Tasks:</b> ${p.overdue} overdue`,
  "support-panel-action": `Choose action: 👇`,
  "staff-search-title": `🔎 <b>Staff Search</b>`,
  "staff-search-prompt": `Enter staff name or phone:`,
  "staff-search-wait": `⏳ Searching...`,
  "staff-search-not-found": `❌ Staff member not found.`,
  "status-SCREENING": `Screening`,
  "status-INTERVIEW_SCHEDULED": `Interview Scheduled`,
  "status-INTERVIEW_COMPLETED": `Interview Completed`,
  "status-DECISION_PENDING": `Decision Pending`,
  "status-ACTIVE": `Active`,
  "status-WAITLIST": `Waitlist`,
  "status-REJECTED": `Rejected`,
  "status-HIRED": `Hired`,
  "status-ACCEPTED": `Accepted (Offer)`,
  "status-NOSHOW": `No Show`,
  "status-TRAINING_SCHEDULED": `Training Scheduled`,
  "status-TRAINING_COMPLETED": `Training Completed`,
  "status-OFFLINE_STAGING": `Offline Staging`,
  "status-AWAITING_FIRST_SHIFT": `Awaiting First Shift`,
  "admin-profile-section-basics": `👤 <b>PROFILE</b>`,
  "admin-profile-section-selection": `⚖️ <b>RECRUITMENT (HR)</b>`,
  "admin-profile-section-training": `🎓 <b>TRAINING (MENTOR)</b>`,
  "admin-profile-section-current": `🎯 <b>CURRENT STAGE</b>`,
  "admin-profile-materials": `📚 Training Materials:`,
  "admin-profile-test-passed": `📝 Training Test:`,
  "admin-profile-status-sent": `Sent 📩`,
  "admin-profile-status-not-sent": `Not sent ⏳`,
  "admin-profile-status-passed": `Passed ✅`,
  "admin-profile-status-waiting": `Waiting ⏳`,
  "admin-profile-title-self": `📸 <b>Your PlayPhoto Profile</b>`,
  "admin-profile-title-other": `📸 <b>Staff Profile</b>`,
  "admin-profile-candidate-title": `👤 <b>Candidate Profile</b>`,
  "admin-profile-name": `👤 Name:`,
  "admin-profile-phone": `📞 Phone:`,
  "admin-profile-locations": `📍 Locations:`,
  "admin-profile-age": `🎂 Age:`,
  "admin-profile-city": `🏙️ City:`,
  "admin-profile-source": `🔍 Source:`,
  "admin-profile-appearance": `🎀 Appearance:`,
  "admin-profile-status": `📊 Status:`,
  "admin-profile-interview-time": `🗓️ Time (Interview):`,
  "admin-profile-telegram": `📞 Telegram:`,
  "admin-profile-meet-interview": `📹 Meet (Interview):`,
  "admin-profile-meet-training": `📹 Meet (Training):`,
  "admin-profile-staging-date": `🗓️ Staging Date:`,
  "admin-profile-decision-hr": `⚖️ HR Decision:`,
  "admin-profile-notification-sent": `📧 Broadcast Status:`,
  "admin-profile-notification-status-sent": `Sent ✅`,
  "admin-profile-notification-status-pending": `Pending (6h wait) ⏳`,
  "admin-profile-decision-accepted": `ACCEPTED 🎉`,
  "admin-profile-decision-rejected": `REJECTED ❌`,
  "admin-profile-select-action": `Select action: 👇`,
  "admin-sync-start": `⏳ Starting full sync (Team + Schedule)...`,
  "admin-sync-complete": (p: { created: string | number, updated: string | number, count: string | number }) => `✅ Sync complete!
👥 Team: +${p.created} new, ${p.updated} updated.
📅 Schedule: +${p.count} shifts added.`,
  "admin-sync-enter-sheet": `Enter Google Sheet name (e.g., 'Розклад Березень'): 📋`,
  "admin-bday-scan-start": `🎂 Scanning birthdays...`,
  "admin-bday-check-complete": `✅ Check complete.`,
  "admin-shifts-none": `📭 No shifts found for this day.`,
  "admin-staff-none-loc": `📭 Staff not assigned.`,
  "admin-history-only-super": `⚠️ Super Admin only.`,
  "admin-history-no-selection": `⚠️ No user selected.`,
  "admin-history-user-not-found": `❌ User not found.`,
  "admin-history-empty": `📭 Chat history is empty.`,
  "admin-history-caption": (p: { name: string | number, count: string | number }) => `📋 Chat history: ${p.name} (${p.count} records)`,
  "admin-main-team": `👥 Team`,
  "admin-main-hr": `🚀 HR Hub`,
  "admin-main-finance": `💰 Finance`,
  "admin-main-system": `⚙️ System`,
  "admin-header-role": (p: { role: string | number }) => `👤 Role: ${p.role}`,
  "admin-header-balance": (p: { balance: string | number }) => `💰 Balance: ${p.balance} UAH`,
  "admin-bday-menu-title": `🎂 <b>Birthdays</b>`,
  "admin-bday-select-month": `Select month:`,
  "admin-bday-btn-all-months": `📋 All Months`,
  "admin-bday-no-birthdays": (p: { monthName: string | number }) => `📭 No birthdays in ${p.monthName}.`,
  "admin-bday-no-staff": `📭 No staff with birth dates.`,
  "admin-bday-header-month": (p: { monthName: string | number }) => `🎂 <b>Birthdays — ${p.monthName}</b>`,
  "admin-bday-header-all": `🎂 <b>Birthdays</b>`,
  "admin-topic-btn-fwd": `📩 Fwd to Kuznetsov`,
  "admin-topic-btn-close": `❌ Close Topic`,
  "admin-topic-ans-closed": `✅ Topic closed`,
  "admin-topic-ans-fwd-ok": `✅ Forwarded to Kuznetsov`,
  "admin-topic-info-fwd": `📩 <b>Forwarded from Admin</b>`,
  "admin-topic-info-outgoing": `<i>Outgoing message from Admin</i>`,
  "admin-topic-task-prefix": `📝 <b>TASK:</b>\n`,
  "admin-ticket-summary-header": (p: { id: string | number }) => `🎫 <b>Ticket #${p.id}</b>`,
  "admin-ticket-summary-status": (p: { status: string | number }) => `Status: ${p.status}`,
  "admin-ticket-summary-created": (p: { date: string | number }) => `Created: ${p.date}`,
  "admin-ticket-summary-author": (p: { name: string | number }) => `Author: ${p.name}`,
  "admin-ticket-summary-urgent": `🆘 <b>URGENT</b>`,
  "admin-ticket-summary-issue": `📝 <b>Issue:</b>`,
  "admin-ticket-summary-result": `<b>Result:</b>`,
  "admin-ticket-status-new": `🟡 New`,
  "admin-ticket-status-inprogress": `🟠 In Progress`,
  "admin-ticket-status-closed": `✖️ Closed`,
  "admin-ticket-not-found": `Ticket not found.`,
  "admin-ops-search": `🔍 Candidate Search`,
  "admin-ops-locations": `📍 Locations`,
  "admin-ops-interviews": `🗓️ Interview Slots`,
  "admin-ops-staging": (p: { count: string | number }) => `📸 Offline Staging (${p.count})`,
  "admin-ops-stats": `📊 Statistics`,
  "admin-ops-back": `⬅️ Back`,
  "admin-staging-title": `📸 <b>Offline Staging</b>`,
  "admin-staging-select": `Select candidate to assign staging:`,
  "admin-staging-none": `No candidates for staging 🌸`,
  "admin-staging-details-date": `📅 Set Staging Date`,
  "admin-staging-details-date-confirm": `📅 Confirm/Change Date`,
  "admin-staging-details-partner": `👩‍💼 Choose Partner`,
  "admin-staging-details-back": `⬅️ Back`,
  "admin-staging-ask-date": `Enter staging date (DD.MM.YYYY):`,
  "admin-staging-partner-title": `👩‍💼 <b>Partner Selection</b>`,
  "admin-staging-partner-loc": (p: { location: string | number }) => `Location: <b>${p.location}</b>`,
  "admin-staging-partner-none": `No active photographers on location ❌`,
  "admin-staging-ans-partner-ok": (p: { name: string | number }) => `Partner assigned: ${p.name} ✅`,
  "admin-staging-ans-assigned": (p: { name: string | number }) => `✅ <b>Assigned!</b>\n\nPartner: ${p.name}\nBoth notified.`,
  "admin-staging-select-loc-title": `📍 <b>Select Staging Location:</b>`,
  "admin-staging-select-loc-hint": `(May differ from candidate preference)`,
  "admin-staging-select-loc-filter-hint": `📍 <b>Select Location:</b>
(City or spot for filtering)`,
  "admin-staging-details-time": (p: { time: string | number }) => `⏰ Time: ${p.time}`,
  "admin-staging-details-loc": (p: { loc: string | number }) => `📍 Place: ${p.loc}`,
  "admin-staging-ask-custom-time": `✍️ <b>Enter custom staging time:</b>\n\nExample: 12:00-14:30`,
  "admin-staging-err-select-loc": `Select location first! 📍`,
  "admin-staging-success-title": `✅ <b>Success!</b>`,
  "admin-staging-success-msg": (p: { partner: string | number, candidate: string | number, time: string | number, location: string | number }) => `Photographer <b>${p.partner}</b> assigned as partner for <b>${p.candidate}</b> at ${p.time} in ${p.location}.`,
  "admin-staging-partner-active-title": `✨ Photographers with shifts today:`,
  "admin-staging-partner-none-assigned": `No location selected ❌`,
  "admin-staging-back-btn": `⬅️ Back`,
  "admin-staging-active-none": `No active staging 🌸`,
  "admin-staging-ready-none": `No one waiting for schedule ✨`,
  "admin-staging-label-unassigned": (p: { count: string | number }) => `🆕 Unassigned (${p.count})`,
  "admin-staging-label-active": (p: { count: string | number }) => `⌛ Active Staging (${p.count})`,
  "admin-staging-label-ready": (p: { count: string | number }) => `📋 Ready for Schedule (${p.count})`,
  "admin-staging-header-active": `⌛ <b>Active Staging</b>\nSelect candidate to record results:`,
  "admin-staging-header-ready": `📋 <b>Waiting for Schedule</b>\nSelect candidate to finalize hiring:`,
  "admin-staging-unnamed": `Unnamed`,
  "admin-staging-card-location": (p: { loc: string | number }) => `📍 Location: ${p.loc}`,
  "admin-staging-card-partner": (p: { partner: string | number }) => `📸 Partner: ${p.partner}`,
  "admin-staging-card-result": `Staging result:`,
  "admin-staging-card-status-pass": `✅ Staging Passed`,
  "admin-staging-card-status-docs": `📝 Documents received`,
  "admin-staging-card-final-step": `Final step: confirm that the schedule is created.`,
  "admin-btn-schedule-created": `✅ Schedule Created`,
  "admin-ans-success-notified": `Success recorded! Candidate notified.`,
  "admin-ans-success-hired": `Success! Photographer hired.`,
  "admin-search-staff-not-found": `Staff member not found.`,
  "admin-search-cand-prompt": `Enter Name, Surname or Username to search candidate: 🔍`,
  "admin-search-staff-prompt": `Enter Name or Surname of staff member to search: 🔍`,
  "admin-search-no-results": `No one found. 😔`,
  "admin-search-no-name": `Unnamed`,
  "admin-msg-success": `✅ Message sent to photographer and logged.`,
  "admin-msg-err-delivery": `❌ Send Error: bot blocked or invalid ID.`,
  "admin-btn-main-menu": `🏠 Main Menu`,
  "admin-ans-gen-report": `⏳ Generating report...`,
  "broadcast-ans-success": `✅ Суперово! Твоє підтвердження отримано. Гарного дня! ✨`,
  "broadcast-ans-decline": `🐾 Бачу, що виникли запитання. Напиши деталі сюди, і наша команда допоможе! 💬`,
  "broadcast-ask-decline-reason": `🌸 <b>Будь ласка, напиши причину, чому ти не згодна:</b>\n\nТвоє повідомлення буде передано кураторам у вигляді тікета, і вони зв'яжуться з тобою найближчим часом.`,
  "broadcast-popup-not-found": `⚠️ Не вдалося знайти цю розсилку.`,
  "broadcast-popup-no-pending-confirm": `⚠️ Для тебе тут немає активного підтвердження.`,
  "broadcast-popup-no-pending-decline": `⚠️ Для тебе тут немає активної відповіді.`,
  "broadcast-popup-already-confirmed": `✅ Ти вже підтвердила ознайомлення.`,
  "broadcast-popup-already-declined": `ℹ️ Ти вже позначила, що маєш заперечення.`,
  "broadcast-popup-confirmed": `✅ Підтвердження зафіксовано.`,
  "broadcast-popup-open-decline-form": `✍️ Відкриваю форму для пояснення.`,
  "broadcast-sent-count": (p: { count: string | number }) => `✅ Broadcast sent to ${p.count} recipients!`,
  "admin-err-insufficient-perms": `❌ Insufficient permissions.`,
  "admin-prompt-number": `Enter a number. 🔢`,
  "admin-success-need-updated": (p: { count: string | number }) => `✅ Location need updated: ${p.count}`,
  "admin-success-city-updated": (p: { city: string | number }) => `✅ City changed to: ${p.city}`,
  "admin-success-date-saved": (p: { date: string | number }) => `✅ First shift date saved: ${p.date}\n\nNow choose a partner in the menu.`,
  "admin-success-time-updated": (p: { time: string | number }) => `✅ Staging time changed to: ${p.time}.\n\nNow choose a partner to finish.`,
  "admin-pref-stats-title": `📊 <b>Schedule Preferences Status</b>`,
  "admin-pref-stats-date": (p: { date: string | number }) => `📅 Broadcast Date: <b>${p.date}</b>`,
  "admin-pref-stats-confirmed": (p: { count: string | number }) => `✅ <b>CONFIRMED (${p.count}):</b>`,
  "admin-pref-stats-declined": (p: { count: string | number }) => `🚫 <b>DECLINED (${p.count}):</b>`,
  "admin-pref-stats-pending": (p: { count: string | number }) => `⏳ <b>PENDING (${p.count}):</b>`,
  "admin-pref-stats-none": `<i>none yet</i>`,
  "admin-pref-stats-all-filled": `<i>all filled! 🎉</i>`,
  "admin-pref-stats-err-not-found": `❌ No active preference broadcast found.`,
  "admin-ans-already-processing": `Your request is already being processed! 💌`,
  "admin-btn-refresh": `🔄 Refresh`,
  "admin-btn-home": `🏠 Menu`,
  "admin-err-access-denied": `⛔️ Access denied (Main Admin only)`,
  "admin-staging-candidate-not-found": `Candidate not found.`,
  "stats-funnel-title": `📊 <b>PlayPhoto Recruitment Funnel</b>`,
  "stats-funnel-city": (p: { city: string | number }) => `📍 City: <b>${p.city}</b>`,
  "stats-funnel-total": (p: { count: string | number }) => `📥 Total in DB: <b>${p.count}</b>`,
  "stats-funnel-header-status": `<b>Current Statuses:</b>`,
  "stats-funnel-header-conv": `<b>Funnel Conversion:</b>`,
  "stats-funnel-weekly": (p: { count: string | number }) => `📆 Last 7 days: <b>+${p.count}</b> new apps`,
  "stats-funnel-item-screening": (p: { count: string | number }) => `⬜️ Screening (New): ${p.count}`,
  "stats-funnel-item-waitlist": (p: { count: string | number }) => `⏳ Waitlist: ${p.count}`,
  "stats-funnel-item-manual": (p: { count: string | number }) => `💍 Manual Review (tattoo): ${p.count}`,
  "stats-funnel-item-interview-sch": (p: { count: string | number }) => `📅 Interview Scheduled: ${p.count}`,
  "stats-funnel-item-interview-comp": (p: { count: string | number }) => `✅ Interview Conducted: ${p.count}`,
  "stats-funnel-item-decision": (p: { count: string | number }) => `⚖️ Waiting Decision: ${p.count}`,
  "stats-funnel-item-accepted": (p: { count: string | number }) => `🎉 Accepted (Offer): ${p.count}`,
  "stats-funnel-item-training": (p: { count: string | number }) => `🎓 In Training: ${p.count}`,
  "stats-funnel-item-staging": (p: { count: string | number }) => `📸 Offline Staging: ${p.count}`,
  "stats-funnel-item-hired": (p: { count: string | number }) => `💼 Hired: ${p.count}`,
  "stats-funnel-item-rejected": (p: { count: string | number }) => `❌ Rejected: ${p.count}`,
  "stats-funnel-conv-app-acc": (p: { percent: string | number }) => `App → Accepted: <b>${p.percent}%</b>`,
  "stats-funnel-conv-int-acc": (p: { percent: string | number }) => `Interview → Accepted: <b>${p.percent}%</b>`,
  "admin-err-super-admin-only": `⛔️ Main Admin only`,
  "admin-timeline-history-caption": `📜 Full User History`,
  "btn-cancel": `✖️ Cancel`,
  "btn-back": `⬅️ Back`,
  "admin-btn-pass": `✅ Pass`,
  "admin-btn-fail": `❌ Fail`,
  "admin-finance-balances": `💰 Balances`,
  "admin-finance-report": `📊 Report & Sync`,
  "admin-finance-sync-dds": `🔄 Sync with DDS`,
  "admin-finance-audit": `⚖️ Audit`,
  "admin-finance-statement": `📋 7-day Statement`,
  "admin-finance-collecting": `⏳ Collecting data...`,
  "admin-finance-gen-statement": (p: { fopKey: string | number }) => `⏳ Generating 7-day statement (${p.fopKey})...`,
  "admin-finance-audit-running": (p: { date: string | number }) => `⏳ Running full FOP audit for ${p.date}...`,
  "admin-finance-syncing-dds": (p: { date: string | number }) => `⏳ Syncing DDS for ${p.date}...`,
  "admin-stats-general": `📊 General Stats`,
  "admin-stats-by-city": `🏙️ By Cities`,
  "admin-stats-select-city": `📊 <b>Select city to view stats:</b>`,
  "admin-stats-no-data": `No city data found`,
  "admin-sys-tasks": `📋 Tasks Dashboard`,
  "admin-sys-broadcast": `📢 Broadcasts`,
  "admin-sys-tickets": `🎫 Support Tickets`,
  "admin-sys-back": `⬅️ Back`,
  "admin-sys-err-tasks": (p: { error: string | number }) => `❌ Error opening tasks dashboard: ${p.error}`,
  "admin-tasks-title": (p: { date: string | number }) => `📝 <b>Tasks Dashboard | ${p.date}</b>`,
  "admin-tasks-no-tasks": `📭 No tasks for this date.`,
  "admin-tasks-urgent": `\n🚨 <b>URGENT:</b>\n`,
  "admin-tasks-loc-unknown": `Not set`,
  "admin-tasks-next": `Next ➡️`,
  "admin-tasks-history": `📂 History`,
  "admin-tasks-new": `➕ New Task`,
  "admin-tasks-details-title": `📋 **Task Details**`,
  "admin-tasks-whom": (p: { name: string | number }) => `👤 **To:** ${p.name}`,
  "admin-tasks-date": (p: { date: string | number, deadline: string | number }) => `📅 **Date:** ${p.date}${p.deadline}`,
  "admin-tasks-date-soon": `Next shift`,
  "admin-tasks-city": (p: { city: string | number }) => `🏙️ **City:** ${p.city}`,
  "admin-tasks-location": (p: { location: string | number }) => `📍 **Location:** ${p.location}`,
  "admin-tasks-text": (p: { text: string | number }) => `📝 **Text:**\n> ${p.text}`,
  "admin-tasks-has-file": `📎 **Has attachment**`,
  "admin-tasks-status-label": (p: { status: string | number }) => `📊 **Status:** ${p.status}`,
  "admin-tasks-status-done": `✅ Completed`,
  "admin-tasks-status-pending": `⏳ Pending`,
  "admin-tasks-btn-toggle": `🔄 Toggle Status`,
  "admin-tasks-btn-view-file": `📂 View Attachment`,
  "admin-tasks-btn-msg-staff": `✉️ Message Staff`,
  "admin-tasks-btn-delete": `🗑 Delete Task`,
  "admin-tasks-btn-back-list": `⬅️ Back to List`,
  "admin-tasks-ans-not-found": `❌ Task not found`,
  "admin-tasks-ans-toggled": `Status updated`,
  "admin-tasks-del-conf": `❓ **Are you sure you want to delete this task?**`,
  "admin-tasks-del-yes": `✅ Yes, delete`,
  "admin-tasks-del-no": `✖️ Cancel`,
  "admin-tasks-ans-deleted": `✅ Task deleted`,
  "admin-tasks-calendar-title": `📂 **Select date to view tasks:**`,
  "hr-hub-title": `🚀 <b>HR Hub</b>`,
  "mentor-hub-title": `🎓 <b>Mentor Hub</b>`,
  "list-header-attention": `👇 NEED ATTENTION`,
  "list-header-upcoming": `🕒 UPCOMING`,
  "list-header-completed": `✅ COMPLETED`,
  "list-header-new": `🆕 NEW`,
  "list-header-waitlist": `⏳ RESERVE (SOS)`,
  "month-1": `January`,
  "month-2": `February`,
  "month-3": `March`,
  "month-4": `April`,
  "month-5": `May`,
  "month-6": `June`,
  "month-7": `July`,
  "month-8": `August`,
  "month-9": `September`,
  "month-10": `October`,
  "month-11": `November`,
  "month-12": `December`,
  "hr-ans-user-not-linked": "Candidate not linked",
  "hr-ans-offer-sent-now": "Offer sent NOW",
  "hr-rejection-general": "На жаль, ми не можемо запропонувати тобі співпрацю на даний момент. Дякуємо за інтерес! 🌸",
  "hr-rejection-appearance": "Дякуємо за щирість! На жаль, наразі ми маємо певні обмеження щодо татуювань на видимих частинах тіла. Бажаємо успіхів! ✨",
  "hr-rejection-noshow": "Нам шкода, що сьогодні не вдалося зустрітися для знайомства. Оскільки наша зустріч не відбулася, наразі ми завершуємо розгляд твоєї заявки. Дякуємо за інтерес до команди PlayPhoto та бажаємо успіхів у твоїх пошуках!",
  "hr-msg-reschedule": "Ой! Здається, ти не змогла приєднатися до нашої зустрічі. 🌸\n\nНічого страшного, ми всі люди. Давай спробуємо ще раз? Обери новий зручний час:",
  "support-status-urgent": "🔴 Urgent",
  "support-status-normal": "🟢 Normal",
  "support-ans-ticket-closed": "Ticket closed! ✖️",
  "support-error-ticket-not-found": "⚠️ Ticket not found.",
  "support-info-admin-reply-to-topic": (p: { replyText: string | number }) => `💬 <b>Response:</b> \n${p.replyText}`,
  "staff-deactivated-shield": `<b>Account Inactive</b>\nAccess to PlayPhoto services has been discontinued.`,
  "schedule-notif-normal-title": `🗓 <b>Оновлення у твоєму графіку</b>`,
  "schedule-notif-urgent-title": `🚨 <b>Термінова зміна у графіку</b>`,
  // Кожна подія — одне речення з рядком зміни, а не «Було/Стало» там, де
  // сторона одна: для нової зміни «стало» ні з чого не випливає.
  "schedule-notif-added": (p: { shift: string | number }) => `➕ Нова зміна: ${p.shift}`,
  "schedule-notif-removed": (p: { shift: string | number }) => `➖ Знято зміну: ${p.shift}`,
  "schedule-notif-moved-title": `🔀 Перенесено зміну`,
  "schedule-notif-changed-title": `🔄 Змінено зміну`,
  "schedule-notif-changed": (p: { shift: string | number }) => `🔄 Змінено зміну: ${p.shift}`,
  // Заміни: система знає роль людини в них і каже це прямо.
  "schedule-notif-replacement-taken": (p: { shift: string | number }) =>
    `🔄 Зміну передано тобі: ${p.shift}`,
  "schedule-notif-replacement-given": (p: { shift: string | number }) =>
    `🔄 Твою зміну передано іншому фотографу: ${p.shift}`,
  "schedule-notif-line-was": (p: { details: string | number }) => `Було: ${p.details}`,
  "schedule-notif-line-now": (p: { details: string | number }) => `Стало: ${p.details}`,
  "schedule-notif-added-unknown": `➕ Додано зміну — деталі уточнюються`,
  "schedule-notif-removed-unknown": `➖ Знято зміну — деталі уточнюються`,
  "schedule-notif-moved-unknown": `🔀 Перенесено зміну — деталі уточнюються`,
  "schedule-notif-changed-unknown": `🔄 Змінено зміну — деталі уточнюються`,
  "schedule-notif-summary": (p: { count: string | number }) => `Всього змін: <b>${p.count}</b>`,
  // Терміново означає прохання відповісти — і воно сказане словами, а не
  // лише кнопками. Для знятої зміни питати «чи вийдеш» нема сенсу.
  "schedule-notif-urgent-ask": `Підтверди, будь ласка, чи вийдеш.`,
  "schedule-notif-urgent-ask-seen": `Підтверди, будь ласка, що бачиш це.`,
  "schedule-notif-btn-schedule": `🗓 Мій графік`,
  "schedule-notif-btn-confirm": `✅ Підтверджую`,
  "schedule-notif-btn-decline": `🚫 Не зможу`,
  "schedule-notif-btn-seen": `✅ Бачу`,
  "schedule-notif-ans-confirmed": `Дякуємо! Ми записали твоє підтвердження ✨`,
  "schedule-notif-ans-declined": `Дякуємо, ми записали твою відповідь. Щоб змінити цю зміну, напиши в підтримку 🌸`,
  "schedule-notif-ans-expired": `Це сповіщення вже неактуальне 🌸`,
  "schedule-notif-ans-unavailable": `Спробуй ще раз за хвилину 🌸`,
  /** Плашка з кнопкою «ОК» — місця більше, тому тут і куди звертатися. */
  "schedule-notif-ans-unavailable-alert": `Не вдалося зберегти відповідь.

Спробуй ще раз за хвилину. Якщо не вийде — напиши в підтримку 🌸`,
  // Сбор пожеланий на следующий месяц.
  //
  // Тон дружелюбно-нейтральный: сообщение приходит одному человеку двенадцать
  // раз в год, и бодрость, которая умиляет в первый раз, на пятый раздражает.
  // Родовых форм нет — словарь фотографов их не использует, а состав команды
  // может смениться. Термин «підміна», как во всех остальных текстах.
  "staff-preferences-invite": (p: { monthName: string; deadline: string }) => `📅 <b>Графік на ${p.monthName}</b>

Привіт! Збираємо побажання на наступний місяць.
Познач дні, коли не зможеш вийти — врахуємо їх, коли будемо складати графік.

Заповнити треба до ${p.deadline}.`,

  // Последствие названо здесь, а не в первом сообщении: угроза в приглашении
  // портит тон, а до дедлайна ещё есть время.
  "staff-preferences-reminder": (p: { monthName: string; deadline: string }) => `Нагадуємо про побажання на ${p.monthName} 🙂

Останній день — ${p.deadline}. Якщо не встигнеш, складемо графік без твоїх побажань, і зміни можуть випасти на незручні дні.`,

  // Человеку без ограничений иначе незачем нажимать хоть что-то, и он попадёт
  // в список забывших вместе с теми, кто правда забыл.
  "staff-preferences-no-limits-hint": `Можеш виходити будь-коли цього місяця?
Просто натисни «Готово» — так ми знатимемо, що ти в курсі.`,

  "staff-preferences-window-closed": (p: { monthName: string }) => `Збір побажань на ${p.monthName} уже закрито.

Зараз складаємо графік — щойно буде готовий, надішлемо його тобі сюди.

Якщо якийсь день не підійде, зможеш попросити підміну прямо в графіку.`,

  // Возврат доступа после RESTORE. Ссылка одноразовая, поэтому текст об этом
  // явно предупреждает — иначе человек может переслать её кому-то ещё,
  // рассчитывая, что она сработает снова.
  "access-restore-invite": (p: { link: string }) => `👋 <b>Вітаємо назад!</b>

Тобі знову відкрито доступ до команди PlayPhoto. Приєднуйся за посиланням нижче:

🔗 <a href="${p.link}">Приєднатися до каналу PlayPhoto</a>

Посилання одноразове й діє тільки для тебе ✨`,
};
