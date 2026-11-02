-- Подсчёт магнитов по фото убран из бота 28.10.2026 (решение владельца): таблица и тип больше
-- никем не читаются и не пишутся.
-- DropForeignKey
ALTER TABLE "MagnetCountRun" DROP CONSTRAINT IF EXISTS "MagnetCountRun_adminUserId_fkey";

-- DropTable
DROP TABLE IF EXISTS "MagnetCountRun";

-- DropEnum
DROP TYPE IF EXISTS "MagnetCountConfidence";
