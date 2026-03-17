-- Fix legacyName for Karamel Sambir to use Cyrillic (matches sheet abbreviation "Карамель С")
UPDATE "Location" SET "legacyName" = 'Карамель Самбір' WHERE "legacyName" = 'Karamel Sambir';

-- Populate finance fields (sheet, fopId, terminalId, searchId, hasAcquiring, cashInEnvelope)
-- Data sourced from Python bot config.yaml

-- Smile Park Київ
UPDATE "Location" SET
    sheet = 'SP Київ',
    "fopId" = 'GUPALOVA',
    "terminalId" = 'PQ012663',
    "hasAcquiring" = true,
    "cashInEnvelope" = false
WHERE name = 'Smile Park' AND city = 'Київ';

-- Smile Park (Darynok)
UPDATE "Location" SET
    sheet = 'SP Даринок',
    "fopId" = 'KUZNETSOV',
    "terminalId" = 'PQ010886',
    "hasAcquiring" = true,
    "cashInEnvelope" = false
WHERE name = 'Smile Park (Darynok)' AND city = 'Київ';

-- Fly Kids Київ
UPDATE "Location" SET
    sheet = 'FK Київ',
    "fopId" = 'KUZNETSOV',
    "searchId" = 11,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Fly Kids' AND city = 'Київ';

-- Leolend
UPDATE "Location" SET
    sheet = 'Leoland',
    "fopId" = 'GUPALOVA',
    "terminalId" = 'PQ012662',
    "hasAcquiring" = true,
    "cashInEnvelope" = false
WHERE name = 'Leolend' AND city = 'Львів';

-- Drive City
UPDATE "Location" SET
    sheet = 'DriveCity',
    "fopId" = 'KUZNETSOV',
    "searchId" = 2,
    "hasAcquiring" = false,
    "cashInEnvelope" = true
WHERE name = 'Drive City' AND city = 'Львів';

-- Dragon Park
UPDATE "Location" SET
    sheet = 'DragonP',
    "fopId" = 'KUZNETSOV',
    "terminalId" = 'PQ011176',
    "hasAcquiring" = true,
    "cashInEnvelope" = true
WHERE name = 'Dragon Park' AND city = 'Львів';

-- Fly Kids Львів (Патона)
UPDATE "Location" SET
    sheet = 'FK Львів',
    "fopId" = 'POSREDNIKOVA',
    "searchId" = 7,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Fly Kids' AND city = 'Львів';

-- Smile Park Lviv
UPDATE "Location" SET
    sheet = 'SP Львів',
    "fopId" = 'POSREDNIKOVA',
    "terminalId" = 'PQ016686',
    "hasAcquiring" = true,
    "cashInEnvelope" = false
WHERE name = 'Smile Park' AND city = 'Львів';

-- Volkland (Бабурка)
UPDATE "Location" SET
    sheet = 'Volkland',
    "fopId" = 'KUZNETSOV',
    "searchId" = 8,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Volkland' AND city = 'Запоріжжя';

-- Volkland 2 (Шевчик)
UPDATE "Location" SET
    sheet = 'Volkland 2',
    "fopId" = 'KUZNETSOV',
    "searchId" = 15,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Volkland 2' AND city = 'Запоріжжя';

-- Volkland 3 (Перемоги)
UPDATE "Location" SET
    sheet = 'Volkland 3',
    "fopId" = 'POSREDNIKOVA',
    "searchId" = 16,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Volkland 3' AND city = 'Запоріжжя';

-- Карамель Коломия
UPDATE "Location" SET
    sheet = 'Карамель К',
    "fopId" = 'POSREDNIKOVA',
    "searchId" = 4,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Karamel' AND city = 'Коломия';

-- Карамель Шептицький
UPDATE "Location" SET
    sheet = 'Карамель Ч',
    "fopId" = 'POSREDNIKOVA',
    "searchId" = 5,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Karamel' AND city = 'Шептицький';

-- Fly Kids Рівне
UPDATE "Location" SET
    sheet = 'FK Рівне',
    "fopId" = 'KUZNETSOV',
    "searchId" = 12,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Fly Kids' AND city = 'Рівне';

-- Fantasy Town Черкаси
UPDATE "Location" SET
    sheet = 'FT Черкаси',
    "fopId" = 'KUZNETSOV',
    "searchId" = 13,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Fantasy Town' AND city = 'Черкаси';

-- Smile Park Kharkiv
UPDATE "Location" SET
    sheet = 'SP Харків',
    "fopId" = 'KUZNETSOV',
    "terminalId" = 'PQ010727',
    "hasAcquiring" = true,
    "cashInEnvelope" = false
WHERE name = 'Smile Park' AND city = 'Харків';

-- Karamel Sambir
UPDATE "Location" SET
    sheet = 'Карамель С',
    "fopId" = 'POSREDNIKOVA',
    "searchId" = 18,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Karamel' AND city = 'Самбір';

-- Dytyache Horyshche Khmelnytskyi
UPDATE "Location" SET
    sheet = 'DH Khmelnytskyi',
    "fopId" = 'KUZNETSOV',
    "searchId" = 19,
    "hasAcquiring" = false,
    "cashInEnvelope" = false
WHERE name = 'Dytyache Horyshche' AND city = 'Хмельницький';
