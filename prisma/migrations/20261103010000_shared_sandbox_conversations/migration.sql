-- A shared Agent sandbox owns many conversations; session identity and revision
-- remain independently authorized through the Conversation and entry Context.
-- Keep the existing non-unique Conversation_sandboxId_idx for lookups.
DROP INDEX IF EXISTS "Conversation_sandboxId_key";
