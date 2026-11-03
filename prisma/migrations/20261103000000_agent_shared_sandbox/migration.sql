-- Shared runtime ownership is separate from the immutable per-session revision.
-- Existing per-conversation mappings and volumes are deliberately untouched:
-- the runtime copies and verifies each full workspace before atomically rebinding
-- its Conversation, native Contexts and WorkSession. Sources remain read-only
-- recovery archives, so deployment does not reset or discard user/native history.
CREATE UNIQUE INDEX "Sandbox_one_shared_runtime_per_agent"
ON "Sandbox" ("workspaceId", (config->>'agentId'))
WHERE config->>'managedBy' = 'agent-conversation'
  AND config->>'scope' = 'agent';
