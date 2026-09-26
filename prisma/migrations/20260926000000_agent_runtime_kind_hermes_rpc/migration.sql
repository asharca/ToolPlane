-- The runtime-kind constant gained 'hermes-rpc' (AGENT_RUNTIME_KINDS) without a
-- matching constraint update, so creating such an Agent failed the CHECK.
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_runtimeKind_check";
ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_runtimeKind_check"
CHECK ("runtimeKind" IN ('pi', 'claude-code', 'dsh', 'hermes', 'hermes-rpc'));
