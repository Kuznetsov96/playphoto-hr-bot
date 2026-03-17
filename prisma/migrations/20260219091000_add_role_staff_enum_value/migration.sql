-- Add STAFF variant to Role enum (PostgreSQL 15 supports ALTER TYPE ADD VALUE in transactions)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STAFF';
