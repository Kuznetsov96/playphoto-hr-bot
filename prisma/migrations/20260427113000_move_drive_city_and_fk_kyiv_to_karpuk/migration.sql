-- Move terminal settlements for "За друк фото 2" and "За друк фото 11" to Karpuk.
-- Keep existing search IDs used for "За друк фото" matching.

UPDATE "Location"
SET "fopId" = 'KARPUK'
WHERE "searchId" IN (2, 11);
