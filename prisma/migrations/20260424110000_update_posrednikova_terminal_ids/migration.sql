-- Update terminal IDs for Posrednikova acquiring locations after Mono terminal replacement.
-- Verified against Monobank payout comments on 2026-04-24.

UPDATE "Location"
SET "terminalId" = 'PQ019896'
WHERE "sheet" = 'SP Київ'
  AND "city" = 'Київ';

UPDATE "Location"
SET "terminalId" = 'PQ019898'
WHERE "sheet" = 'Leoland'
  AND "city" = 'Львів';
