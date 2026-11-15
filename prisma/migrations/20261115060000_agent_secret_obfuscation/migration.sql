-- Preserve the behavior of every existing Agent; only new drafts opt in.
ALTER TABLE "Agent" ADD COLUMN "secretObfuscation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ALTER COLUMN "secretObfuscation" SET DEFAULT true;
