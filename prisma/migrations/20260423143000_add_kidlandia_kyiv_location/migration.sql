-- Add Kidlandia Kyiv and enable it for candidate selection + finance reconciliation.
-- Terminal settlements should reconcile on KARPUK via Monobank comment "За друк фото 19".

UPDATE "Location"
SET
    "name" = 'Kidlandia',
    "city" = 'Київ',
    "address" = 'Київ, проспект Степана Бандери, 34-В, РЦ «BLOCKBUSTER», 2 поверх',
    "googleMapsLink" = 'https://www.google.com/maps/search/?api=1&query=%D0%9A%D0%B8%D1%97%D0%B2%2C%20%D0%BF%D1%80%D0%BE%D1%81%D0%BF%D0%B5%D0%BA%D1%82%20%D0%A1%D1%82%D0%B5%D0%BF%D0%B0%D0%BD%D0%B0%20%D0%91%D0%B0%D0%BD%D0%B4%D0%B5%D1%80%D0%B8%2C%2034-%D0%92%2C%20%D0%A0%D0%A6%20%C2%ABBLOCKBUSTER%C2%BB%2C%202%20%D0%BF%D0%BE%D0%B2%D0%B5%D1%80%D1%85',
    "schedule" = E'Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00',
    "salary" = E'Пн-Пт — 1 человек 20%\nСб-Нд — 1 человек 30%',
    "sheet" = 'Kidlandia',
    "searchId" = 19,
    "telegramChatId" = -1001982334091,
    "hasAcquiring" = true,
    "cashInEnvelope" = false,
    "fopId" = 'KARPUK',
    "isHidden" = false,
    "isHiddenFromCandidates" = false
WHERE
    ("name" = 'Kidlandia' AND "city" = 'Київ')
    OR ("legacyName" = 'Kidlandia' AND "city" = 'Київ')
    OR ("sheet" = 'Kidlandia');

INSERT INTO "Location" (
    "id",
    "name",
    "city",
    "address",
    "googleMapsLink",
    "schedule",
    "salary",
    "sheet",
    "searchId",
    "telegramChatId",
    "hasAcquiring",
    "cashInEnvelope",
    "fopId",
    "isHidden",
    "isHiddenFromCandidates"
)
SELECT
    'kidlandia_kyiv',
    'Kidlandia',
    'Київ',
    'Київ, проспект Степана Бандери, 34-В, РЦ «BLOCKBUSTER», 2 поверх',
    'https://www.google.com/maps/search/?api=1&query=%D0%9A%D0%B8%D1%97%D0%B2%2C%20%D0%BF%D1%80%D0%BE%D1%81%D0%BF%D0%B5%D0%BA%D1%82%20%D0%A1%D1%82%D0%B5%D0%BF%D0%B0%D0%BD%D0%B0%20%D0%91%D0%B0%D0%BD%D0%B4%D0%B5%D1%80%D0%B8%2C%2034-%D0%92%2C%20%D0%A0%D0%A6%20%C2%ABBLOCKBUSTER%C2%BB%2C%202%20%D0%BF%D0%BE%D0%B2%D0%B5%D1%80%D1%85',
    E'Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00',
    E'Пн-Пт — 1 человек 20%\nСб-Нд — 1 человек 30%',
    'Kidlandia',
    19,
    -1001982334091,
    true,
    false,
    'KARPUK',
    false,
    false
WHERE NOT EXISTS (
    SELECT 1
    FROM "Location"
    WHERE
        ("name" = 'Kidlandia' AND "city" = 'Київ')
        OR ("legacyName" = 'Kidlandia' AND "city" = 'Київ')
        OR ("sheet" = 'Kidlandia')
);
