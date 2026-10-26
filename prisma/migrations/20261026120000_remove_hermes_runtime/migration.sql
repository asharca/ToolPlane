-- Remove the legacy Hermes managed runtime and hermes-rpc sandbox runtime
-- entirely: no replacement runtime currently exposes publicEndpoint or
-- multi-provider capability, so this is a full purge, not a soft disable.
-- Existing Agent rows pinned to these runtime kinds and their cascading
-- conversations/messages/work sessions are deleted. Nullable references (for
-- example channel connections) are detached according to their existing FKs.
-- Sandbox rows, containers and volumes are not deleted by this migration.

-- DropForeignKey (AgentAttachment referenced the runtime it belonged to)
ALTER TABLE "AgentAttachment" DROP CONSTRAINT IF EXISTS "AgentAttachment_runtimeId_fkey";

-- DropTable
DROP TABLE "AgentAttachment";

-- DropTable
DROP TABLE "AgentRuntime";

-- DropTable
DROP TABLE "AgentUploadReservation";

-- Hermes-only multi-provider bindings
DROP TABLE "AgentModelProvider";

-- Delete legacy agents before tightening the runtime-kind constraint.
-- Resource cleanup outside Postgres requires a separate owner-controlled operation.
DELETE FROM "Agent" WHERE "runtimeKind" IN ('hermes', 'hermes-rpc');

-- Remove the retired hosted Telegram setup session, not the channel's saved
-- BotFather credentials, access policy, or generic runner configuration.
UPDATE "AgentChannelConnection"
SET "config" = "config" - 'pairing' - 'pairingSecrets'
WHERE "config"->'pairing'->>'provider' = 'telegram_managed_bot';

-- Drop hermes-only Conversation columns
ALTER TABLE "Conversation" DROP COLUMN "hermesRpcBinding";
ALTER TABLE "Conversation" DROP COLUMN "hermesProfile";
ALTER TABLE "Conversation" DROP COLUMN "hermesProvider";
ALTER TABLE "Conversation" DROP COLUMN "hermesModel";

-- Remove hermes/hermes-rpc from the runtimeKind check constraint
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_runtimeKind_check";
ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_runtimeKind_check"
CHECK ("runtimeKind" IN ('pi', 'pi-sdk', 'claude-code', 'dsh'));
