-- Move Volkland 2 terminal settlements to Posrednikova.
-- Cash accounting remains unchanged and is handled separately in finance sync.

UPDATE "Location"
SET "fopId" = 'POSREDNIKOVA'
WHERE
    "city" = 'Запоріжжя'
    AND (
        "sheet" = 'Volkland 2'
        OR "name" IN ('Volkland 2', 'Volkland 2 (Шевчик)')
        OR "legacyName" IN ('Volkland 2', 'Volkland 2 (Шевчик)')
        OR "searchId" = 15
    );
