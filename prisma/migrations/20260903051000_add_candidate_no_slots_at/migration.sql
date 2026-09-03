-- Момент, когда кандидатка нажала "Обрати час" и активных слотов интервью не
-- нашлось вообще. Зеркалится в вебапп (RecruitingCandidateSnapshot.noSlotsAt)
-- и очищается при успешной броне слота.
ALTER TABLE "Candidate" ADD COLUMN "noSlotsAt" TIMESTAMP(3);
