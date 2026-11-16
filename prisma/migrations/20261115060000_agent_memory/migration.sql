CREATE TABLE "AgentMemory" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "content" VARCHAR(2000) NOT NULL,
  "conversationId" TEXT,
  "taskId" TEXT,
  "creatorType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentMemory_content_check" CHECK (char_length(btrim("content")) BETWEEN 1 AND 2000),
  CONSTRAINT "AgentMemory_creatorType_check" CHECK ("creatorType" IN ('tool', 'user'))
);
CREATE INDEX "AgentMemory_workspaceId_agentId_createdAt_id_idx"
  ON "AgentMemory"("workspaceId", "agentId", "createdAt", "id");
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentId_workspaceId_fkey"
  FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Serialize all inserts on the owning Agent, including concurrent tool/user writes.
CREATE FUNCTION agent_memory_enforce_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Agent" WHERE "id" = NEW."agentId" AND "workspaceId" = NEW."workspaceId" FOR UPDATE;
  IF (SELECT count(*) FROM "AgentMemory" WHERE "agentId" = NEW."agentId" AND "workspaceId" = NEW."workspaceId") >= 500 THEN
    RAISE EXCEPTION 'AGENT_MEMORY_LIMIT_REACHED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AgentMemory_limit" BEFORE INSERT ON "AgentMemory"
  FOR EACH ROW EXECUTE FUNCTION agent_memory_enforce_limit();
