ALTER TABLE "AgentChannelConnection" DROP CONSTRAINT "AgentChannelConnection_agentId_fkey";
ALTER TABLE "AgentChannelConnection" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "AgentChannelConnection" ADD CONSTRAINT "AgentChannelConnection_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
