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
    'btn_accept': '✅ Так, заберу',
    'btn_reject': '❌ Не можу',
    'btn_photo': '📸 Сфотографувати вміст',
    'ask_phone': (phone: string) => `Оформлюємо доручення на твій номер <b>${phone}</b>?\n\n<i>(Нова Пошта надішле код саме на цей номер)</i>`,
    'btn_confirm_phone': '✅ Так, номер вірний',
    'btn_change_phone': '✏️ Інший номер',
    'mandatory_pickup': '🚨 <b>ОБОВ’ЯЗКОВО:</b> Посилку потрібно забрати сьогодні, інакше вона поїде назад!',
    'already_taken': (name: string) => `Цю посилку вже забирає <b>${name}</b>.`,
    'photo_received': '✅ Фото отримано! Передаю сапорту для підтвердження. Дякую! ✨'
};

export const LOGISTICS_TEXTS_ADMIN = {
    'menu_title': '📦 Logistics Management',
    'parcel_details': (ttn: string, status: string, loc: string) => `<b>Parcel:</b> <code>${ttn}</code>\n<b>Location:</b> ${loc}\n<b>Status:</b> ${status}`,
    'btn_verify': '✅ Everything is fine',
    'btn_view_photo': '🖼 View Content Photo',
    'alert_not_picked_up': (ttn: string, days: number) => `⚠️ <b>ALARM:</b> Parcel <code>${ttn}</code> has not been picked up for ${days} days!`,
    'confirmed': '✅ Parcel confirmed and cleared from active list.',
    'new_photo_alert': (ttn: string, loc: string) => `📸 <b>New Content Photo Received!</b>\n\nParcel: <code>${ttn}</code>\nLocation: ${loc}\n\nPlease verify the contents.`,
    'new_photo_caption': (p: { ttn: string, location: string, sender: string, time: string }) => 
        `📸 <b>Content Photo for TTN:</b> <code>${p.ttn}</code>\n` +
        `📍 <b>Location:</b> ${p.location}\n` +
        `👤 <b>Photographer:</b> ${p.sender}\n` +
        `🕐 <b>Received:</b> ${p.time}\n\n` +
        `<i>Please verify the contents and confirm receipt.</i> ✨`
};
