-- Вложения рассылок из вебаппа: кэш file_id, режим подписи и сообщения-части доставки.
ALTER TABLE "Broadcast"
  ADD COLUMN "mediaFileIds" JSONB,
  ADD COLUMN "textAsCaption" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BroadcastDelivery"
  ADD COLUMN "partMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
