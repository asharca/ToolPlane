ALTER TABLE "AgentListing" ADD COLUMN "publisherKind" TEXT;

UPDATE "AgentListing"
SET "publisherKind" = CASE
  WHEN "publisherWorkspaceId" IS NOT NULL
    OR "sourceAgentId" IS NOT NULL
    OR "publishedById" IS NOT NULL
  THEN 'workspace'
  ELSE 'platform'
END;

ALTER TABLE "AgentListing"
  ALTER COLUMN "publisherKind" SET DEFAULT 'workspace',
  ALTER COLUMN "publisherKind" SET NOT NULL,
  ADD CONSTRAINT "AgentListing_publisherKind_check"
    CHECK ("publisherKind" IN ('platform', 'workspace'));
