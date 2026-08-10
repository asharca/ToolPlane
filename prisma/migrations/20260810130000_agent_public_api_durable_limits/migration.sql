ALTER TABLE "Deployment"
ADD COLUMN "publicInvocable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Message"
ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Message_conversationId_sequence_idx"
ON "Message"("conversationId", "sequence");

ALTER TABLE "AgentEndpoint"
ADD COLUMN "dailyOutputCharacterLimit" INTEGER NOT NULL DEFAULT 100000000,
ADD COLUMN "maxStoredCharacters" INTEGER NOT NULL DEFAULT 250000000;

ALTER TABLE "AgentApiClient"
ADD COLUMN "dailyOutputCharacterLimit" INTEGER NOT NULL DEFAULT 20000000,
ADD COLUMN "maxStoredCharacters" INTEGER NOT NULL DEFAULT 50000000;

ALTER TABLE "AgentEndpointRuntime"
ADD COLUMN "operationId" TEXT,
ADD COLUMN "operationExpiresAt" TIMESTAMP(3);

CREATE INDEX "AgentEndpointRuntime_status_operationExpiresAt_idx"
ON "AgentEndpointRuntime"("status", "operationExpiresAt");

ALTER TABLE "AgentPublicConversation"
ADD COLUMN "storedCharacters" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AgentRun"
ADD COLUMN "deadlineAt" TIMESTAMP(3);

UPDATE "AgentRun" r
SET "deadlineAt" = r."createdAt" + (
  LEAST(GREATEST(e."timeoutSeconds", 10), 840) * INTERVAL '1 second'
)
FROM "AgentEndpoint" e
WHERE e."id" = r."endpointId";

ALTER TABLE "AgentRun"
ALTER COLUMN "deadlineAt" SET NOT NULL;

CREATE INDEX "AgentRun_status_deadlineAt_idx"
ON "AgentRun"("status", "deadlineAt");

-- Existing out-of-band values are clamped before installing checks. New
-- writes fail closed even if they bypass the management action.
UPDATE "AgentEndpoint"
SET "timeoutSeconds" = LEAST(GREATEST("timeoutSeconds", 10), 840),
    "maxRuntimes" = LEAST(GREATEST("maxRuntimes", 1), 1000),
    "dailyOutputCharacterLimit" = LEAST(GREATEST("dailyOutputCharacterLimit", 200000), 1000000000),
    "maxStoredCharacters" = LEAST(GREATEST("maxStoredCharacters", 220000), 1000000000);

UPDATE "AgentApiClient"
SET "dailyOutputCharacterLimit" = LEAST(GREATEST("dailyOutputCharacterLimit", 200000), 1000000000),
    "maxStoredCharacters" = LEAST(GREATEST("maxStoredCharacters", 220000), 1000000000);

ALTER TABLE "AgentEndpoint"
ADD CONSTRAINT "AgentEndpoint_timeoutSeconds_check" CHECK ("timeoutSeconds" BETWEEN 10 AND 840),
ADD CONSTRAINT "AgentEndpoint_maxRuntimes_check" CHECK ("maxRuntimes" BETWEEN 1 AND 1000),
ADD CONSTRAINT "AgentEndpoint_dailyOutputCharacterLimit_check" CHECK ("dailyOutputCharacterLimit" BETWEEN 200000 AND 1000000000),
ADD CONSTRAINT "AgentEndpoint_maxStoredCharacters_check" CHECK ("maxStoredCharacters" BETWEEN 220000 AND 1000000000);

ALTER TABLE "AgentApiClient"
ADD CONSTRAINT "AgentApiClient_dailyOutputCharacterLimit_check" CHECK ("dailyOutputCharacterLimit" BETWEEN 200000 AND 1000000000),
ADD CONSTRAINT "AgentApiClient_maxStoredCharacters_check" CHECK ("maxStoredCharacters" BETWEEN 220000 AND 1000000000);
