-- Add new candidate statuses for the refactored funnel
ALTER TYPE "CandidateStatus" ADD VALUE 'NDA';
ALTER TYPE "CandidateStatus" ADD VALUE 'KNOWLEDGE_TEST';
ALTER TYPE "CandidateStatus" ADD VALUE 'STAGING_SETUP';
ALTER TYPE "CandidateStatus" ADD VALUE 'STAGING_ACTIVE';
ALTER TYPE "CandidateStatus" ADD VALUE 'READY_FOR_HIRE';

