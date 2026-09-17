-- Independent sandbox/model binding for Hermes RPC conversations.
-- Legacy Hermes and channel routing fields remain unchanged.
ALTER TABLE "Conversation" ADD COLUMN "hermesRpcBinding" TEXT;
