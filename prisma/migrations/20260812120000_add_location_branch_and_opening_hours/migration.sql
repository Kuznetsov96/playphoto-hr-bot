-- Mirrors the canonical location fields the bot previously kept only in hand-seeded local data.
--
-- `branch` distinguishes venues sharing a name: the three Zaporizhzhia Volklands are all named
-- "Volkland" and differed only by a branch the bot never received, so the UI showed one repeated
-- button. `LocationOpeningHours` replaces the free-text `Location.schedule`, which nothing kept
-- in sync with the real hours. Both are filled by the business snapshot sync, not by hand.
ALTER TABLE "Location"
ADD COLUMN "branch" TEXT;

CREATE TABLE "LocationOpeningHours" (
  "id"         TEXT     NOT NULL,
  "locationId" TEXT     NOT NULL,
  -- 1 = Monday … 7 = Sunday, ISO-8601.
  "dayOfWeek"  INTEGER  NOT NULL,
  -- Local wall-clock `HH:MM`; `closes` < `opens` means the shift runs past midnight.
  "opens"      TEXT     NOT NULL,
  "closes"     TEXT     NOT NULL,
  CONSTRAINT "LocationOpeningHours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocationOpeningHours_locationId_dayOfWeek_key"
  ON "LocationOpeningHours"("locationId", "dayOfWeek");

CREATE INDEX "LocationOpeningHours_locationId_idx"
  ON "LocationOpeningHours"("locationId");

ALTER TABLE "LocationOpeningHours"
  ADD CONSTRAINT "LocationOpeningHours_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
