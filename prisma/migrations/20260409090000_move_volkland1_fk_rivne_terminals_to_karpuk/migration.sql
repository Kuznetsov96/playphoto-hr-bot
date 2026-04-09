-- Move terminal settlements for Volkland 1 and FK Rivne to Karpuk.
-- Keep existing search IDs used for "За друк фото" matching.

UPDATE "Location"
SET "fopId" = 'KARPUK'
WHERE
    ("name" = 'Volkland' AND "city" = 'Запоріжжя')
    OR ("legacyName" = 'Volkland 1 (Бабурка)' AND "city" = 'Запоріжжя')
    OR ("name" = 'Fly Kids' AND "city" = 'Рівне')
    OR ("legacyName" = 'Fly Kids Рівне' AND "city" = 'Рівне');
