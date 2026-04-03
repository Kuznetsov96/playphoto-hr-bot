/**
 * Personal parcels filter — these NP destinations belong to the owner,
 * not to any location. The system must silently ignore them.
 */
export const NP_PERSONAL_FILTER = {
    city: 'Харків',
    warehouses: ['65', '104'],
    addresses: ['ландау'],
};

export const NP_LOCATIONS_MAP = [
    { name: 'Leoland', city: 'Львів', npPoints: ['80', '33826'] },
    { name: 'Drive City', city: 'Львів', npPoints: ['26740'] },
    { name: 'Dragon Park', city: 'Львів', npPoints: ['34023'] },
    { name: 'Fly Kids (Львів)', city: 'Львів', npPoints: ['25'] },
    { name: 'Smile Park (Львів)', city: 'Львів', npPoints: ['36716'] },
    { name: 'Smile Park (Troieshchyna)', city: 'Київ', npPoints: ['38007'] },
    { name: 'Smile Park (Darynok)', city: 'Київ', npPoints: ['3095', '78'] },
    { name: 'Fly Kids (Київ)', city: 'Київ', npPoints: ['371', '39911'] },
    { name: 'Volkland 1 (Бабурка)', city: 'Запоріжжя', npPoints: ['6179', '6'] },
    { name: 'Volkland 2 (Шевчик)', city: 'Запоріжжя', npPoints: ['6177', '50236'] },
    { name: 'Volkland 3 (Перемоги)', city: 'Запоріжжя', npPoints: ['36080'] },
    { name: 'Karamel (Коломия)', city: 'Коломия', npPoints: ['36870'] },
    { name: 'Karamel (Шептицький)', city: 'Шептицький', npPoints: ['36303'] },
    { name: 'Fly Kids (Рівне)', city: 'Рівне', npPoints: ['19', '55207'] },
    { name: 'Fantasy Town', city: 'Черкаси', npPoints: ['32583'] },
    { name: 'Smile Park (Харків)', city: 'Харків', npPoints: ['23410'] },
    { name: 'Karamel (Самбір)', city: 'Самбір', npPoints: ['2', '36699'] },
    { name: 'Dytyache Horyshche', city: 'Хмельницький', npPoints: ['56717'] },
];

export const LOGISTICS_TEXTS_STAFF = {
    'expected': (ttn: string, loc: string) => `📦 <b>Очікується посилка!</b>\n\nНа локацію <b>${loc}</b> прямує посилка.\nТТН: <code>${ttn}</code>\n\nЯ повідомлю, як тільки вона прибуде! ✨`,
    'arrived': (ttn: string, loc: string) => `🔔 <b>Посилка прибула!</b>\n\nТТН <code>${ttn}</code> вже чекає у відділенні/поштоматі для <b>${loc}</b>.\n\nЧи зможеш забрати її сьогодні?`,
    'delivered_address': (ttn: string, loc: string) => `🚚 <b>Кур'єр доставив посилку!</b>\n\nТТН <code>${ttn}</code> доставлено на <b>${loc}</b>.\nБудь ласка, розпакуй та сфотографуй вміст. ✨`,
    'delivered_pickup_completed': (ttn: string, loc: string) => `📬 <b>Нова Пошта вже відмітила посилку як отриману.</b>\n\nТТН <code>${ttn}</code> для <b>${loc}</b> вже видано.\n\nЯкщо посилка вже у тебе, додай фото вмісту. Якщо її забрала не ти, напиши в підтримку.`,
    'btn_accept': '✅ Так, заберу',
    'btn_reject': '❌ Не можу',
    'btn_photo': '📸 Сфотографувати вміст',
    'btn_photo_done': '✅ Готово',
    'btn_photo_cancel': '❌ Скасувати',
    'ask_phone': (phone: string) => `Оформлюємо доручення на твій номер <b>${phone}</b>?\n\n<i>(Нова Пошта надішле код саме на цей номер)</i>`,
    'btn_confirm_phone': '✅ Так, номер вірний',
    'btn_change_phone': '✏️ Інший номер',
    'manual_proxy_requested': 'Номер збережено. Передаю сапорту задачу на ручне оформлення доручення в Новій Пошті.\n\nЩойно доручення підтвердять, я попрошу тебе додати фото вмісту посилки. ✨',
    'mandatory_pickup': '🚨 <b>ОБОВ’ЯЗКОВО:</b> Посилку потрібно забрати сьогодні, інакше вона поїде назад!',
    'already_taken': (name: string) => `Цю посилку вже забирає <b>${name}</b>.`,
    'transferred': `Цю посилку вже передано наступній зміні. Гарного дня! 🌿`,
    'pickup_reminder': (ttn: string, endTime: string) => `⏰ <b>Нагадування:</b> посилка <code>${ttn}</code> ще не забрана.\n\nТвоя зміна закінчується о <b>${endTime}</b>. Якщо не зможеш забрати — посилку буде автоматично передано наступній зміні.`,
    'shift_ended_handoff': (ttn: string) => `🔄 Твоя зміна закінчилась. Посилка <code>${ttn}</code> передана наступній зміні.`,
    'leftover_parcel': (ttn: string) => `📦 На твоїй локації є посилка <code>${ttn}</code>, яку не встигли забрати на попередній зміні. Вона очікує в пункті видачі НП.`,
    'photo_upload_prompt': 'Надішли 1 або кілька фото вмісту посилки. Коли завершиш, натисни «Готово».',
    'photo_upload_progress': (count: number) => `📸 Фото збережено: <b>${count}</b>.\n\nМожна надіслати ще або натиснути «Готово».`,
    'photo_upload_empty': 'Спочатку надішли хоча б одне фото, а потім натисни «Готово».',
    'photo_upload_waiting': 'Надішли фото або натисни «Готово», коли завершиш.',
    'photo_upload_cancelled': 'Відправку фото скасовано, фото не передано сапорту. Якщо потрібно, почни ще раз кнопкою «Сфотографувати вміст».',
    'photo_upload_reminder': (count: number) => `⏳ У тебе ще не завершене завантаження фото.\n\nЗбережено фото: <b>${count}</b>.\nЯкщо вже все надіслала, натисни «Готово». Якщо ні, можна додати ще фото.`,
    'photo_received': (count: number) => `✅ Фото отримано: <b>${count}</b>. Передаю сапорту для підтвердження. Дякую! ✨`
};

export const LOGISTICS_TEXTS_ADMIN = {
    'menu_title': '📦 Logistics Management',
    'parcel_details': (ttn: string, status: string, loc: string) => `<b>Parcel:</b> <code>${ttn}</code>\n<b>Location:</b> ${loc}\n<b>Status:</b> ${status}`,
    'btn_mark_picked_up_manual': '📬 Picked Up Manually',
    'btn_mark_manual_proxy_done': '✅ Доручення оформлено',
    'btn_verify': '✅ Everything is fine',
    'btn_view_photo': '🖼 View Content Photo',
    'alert_not_picked_up': (ttn: string, days: number) => `⚠️ <b>ALARM:</b> Parcel <code>${ttn}</code> has not been picked up for ${days} days!`,
    'confirmed': '✅ Parcel confirmed and cleared from active list.',
    'manual_pickup_marked': '📬 Parcel marked as picked up manually. Staff should now finish the photo step.',
    'manual_proxy_requested': (p: { ttn: string; loc: string; staff: string; phone: string }) =>
        `📝 <b>Потрібно оформити доручення вручну</b>\n\n` +
        `ТТН: <code>${p.ttn}</code>\n` +
        `Локація: <b>${p.loc}</b>\n` +
        `Фотограф: ${p.staff}\n` +
        `Номер для доручення: <code>${p.phone}</code>\n\n` +
        `Після оформлення натисни кнопку нижче, щоб відкрити фотографу наступний крок.`,
    'manual_proxy_marked': '✅ Доручення підтверджено. Фотограф може переходити до фото вмісту.',
    'new_photo_alert': (ttn: string, loc: string) => `📸 <b>New Content Photo Received!</b>\n\nParcel: <code>${ttn}</code>\nLocation: ${loc}\n\nPlease verify the contents.`,
    'new_photo_caption': (p: { ttn: string, location: string, sender: string }) =>
        `📸 <b>Content Photo for TTN:</b> <code>${p.ttn}</code>\n` +
        `📍 <b>Location:</b> ${p.location}\n` +
        `👤 <b>Photographer:</b> ${p.sender}\n\n` +
        `<i>Please verify the contents and confirm receipt.</i> ✨`
};
