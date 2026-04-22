-- Move Leoland and Smile Park Kyiv (Troieshchyna) terminal settlements to Posrednikova.
-- Keep existing terminal IDs/search IDs/acquiring flags unchanged.

UPDATE "Location"
SET "fopId" = 'POSREDNIKOVA'
WHERE
    (
        "sheet" = 'Leoland'
        OR (
            "city" = 'Львів'
            AND (
                "name" IN ('Leoland', 'Leolend')
                OR "legacyName" IN ('Leoland', 'Leolend')
            )
        )
    )
    OR
    (
        "sheet" = 'SP Київ'
        OR (
            "city" = 'Київ'
            AND (
                "terminalId" = 'PQ012663'
                OR "legacyName" = 'Smile Park Київ'
                OR "name" = 'Smile Park Київ'
            )
        )
    );
