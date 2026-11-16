-- Preserve existing Agent drafts and immutable revisions; only creation paths opt in.
ALTER TABLE "Agent" ADD COLUMN "contextFiles" BOOLEAN NOT NULL DEFAULT false;
