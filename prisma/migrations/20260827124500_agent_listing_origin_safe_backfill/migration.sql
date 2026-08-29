-- Legacy nullable ownership columns cannot distinguish a platform template from
-- a workspace listing whose owner, workspace, and source agent were deleted.
-- Fail closed; platform listings created after this migration are explicit.
UPDATE "AgentListing"
SET "publisherKind" = 'workspace'
WHERE "publisherKind" = 'platform'
  AND "publisherWorkspaceId" IS NULL
  AND "sourceAgentId" IS NULL
  AND "publishedById" IS NULL;
