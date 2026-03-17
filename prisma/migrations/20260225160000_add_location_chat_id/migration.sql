-- AlterTable
ALTER TABLE "Location" ADD COLUMN "telegramChatId" BIGINT;

-- Seed Data (Map existing IDs from code to the DB)
UPDATE "Location" SET "telegramChatId" = -1002323329492 WHERE "name" = 'Dytyache Horyshche' AND "city" = 'Хмельницький';

UPDATE "Location" SET "telegramChatId" = -1002378901316 WHERE "name" = 'Fly Kids' AND "city" = 'Львів';
UPDATE "Location" SET "telegramChatId" = -1003068768533 WHERE "name" = 'Smile Park' AND "city" = 'Львів';
UPDATE "Location" SET "telegramChatId" = -1001956336405 WHERE "name" = 'Leolend' AND "city" = 'Львів';
UPDATE "Location" SET "telegramChatId" = -1001933184668 WHERE "name" = 'Drive City' AND "city" = 'Львів';
UPDATE "Location" SET "telegramChatId" = -1002571420646 WHERE "name" = 'Dragon Park' AND "city" = 'Львів';

UPDATE "Location" SET "telegramChatId" = -1002429009554 WHERE "name" = 'Smile Park (Darynok)' AND "city" = 'Київ';
UPDATE "Location" SET "telegramChatId" = -1002373731296 WHERE "name" = 'Smile Park' AND "city" = 'Київ';
UPDATE "Location" SET "telegramChatId" = -1002625052844 WHERE "name" = 'Fly Kids' AND "city" = 'Київ';

UPDATE "Location" SET "telegramChatId" = -1002331115725 WHERE "name" = 'Volkland' AND "city" = 'Запоріжжя';
UPDATE "Location" SET "telegramChatId" = -1002695718575 WHERE "name" = 'Volkland 2' AND "city" = 'Запоріжжя';
UPDATE "Location" SET "telegramChatId" = -1003005306666 WHERE "name" = 'Volkland 3' AND "city" = 'Запоріжжя';

UPDATE "Location" SET "telegramChatId" = -1002292905493 WHERE "name" = 'Fantasy Town' AND "city" = 'Черкаси';
UPDATE "Location" SET "telegramChatId" = -1003453458076 WHERE "name" = 'Fly Kids' AND "city" = 'Рівне';
UPDATE "Location" SET "telegramChatId" = -1003043444121 WHERE "name" = 'Karamel' AND "city" = 'Самбір';
UPDATE "Location" SET "telegramChatId" = -1002425476970 WHERE "name" = 'Karamel' AND "city" = 'Коломия';
UPDATE "Location" SET "telegramChatId" = -1002446398843 WHERE "name" = 'Karamel' AND "city" = 'Шептицький';
UPDATE "Location" SET "telegramChatId" = -1002649143773 WHERE "name" = 'Smile Park' AND "city" = 'Харків';