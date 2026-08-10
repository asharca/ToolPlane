-- CreateTable
CREATE TABLE "AgentEndpoint" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceAgentId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "isolationMode" TEXT NOT NULL DEFAULT 'subject',
    "rpmLimit" INTEGER NOT NULL DEFAULT 60,
    "dailyRequestLimit" INTEGER NOT NULL DEFAULT 10000,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 5,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEndpointRevision" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "runtimeImage" TEXT NOT NULL,
    "providerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deploymentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "installedSkillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toolPolicy" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEndpointRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApiClient" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scopes" TEXT[] DEFAULT ARRAY['responses:create', 'responses:read', 'conversations:read', 'conversations:delete', 'client_tokens:create']::TEXT[],
    "rpmLimit" INTEGER NOT NULL DEFAULT 60,
    "dailyRequestLimit" INTEGER NOT NULL DEFAULT 10000,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApiKey" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEndpointRuntime" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "runtimeAgentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentEndpointRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPublicConversation" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "runtimeAllocationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "deletingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPublicConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "publicConversationId" TEXT,
    "runtimeAllocationId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "inputCharacters" INTEGER NOT NULL DEFAULT 0,
    "outputCharacters" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "outputText" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApiUsageBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApiUsageBucket_pkey" PRIMARY KEY ("key", "windowStart", "windowSeconds")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentEndpoint_publicId_key" ON "AgentEndpoint"("publicId");
CREATE UNIQUE INDEX "AgentEndpoint_sourceAgentId_key" ON "AgentEndpoint"("sourceAgentId");
CREATE UNIQUE INDEX "AgentEndpoint_currentRevisionId_key" ON "AgentEndpoint"("currentRevisionId");
CREATE INDEX "AgentEndpoint_workspaceId_status_idx" ON "AgentEndpoint"("workspaceId", "status");

CREATE UNIQUE INDEX "AgentEndpointRevision_endpointId_version_key" ON "AgentEndpointRevision"("endpointId", "version");
CREATE INDEX "AgentEndpointRevision_endpointId_createdAt_idx" ON "AgentEndpointRevision"("endpointId", "createdAt");

CREATE INDEX "AgentApiClient_endpointId_status_idx" ON "AgentApiClient"("endpointId", "status");

CREATE UNIQUE INDEX "AgentApiKey_tokenHash_key" ON "AgentApiKey"("tokenHash");
CREATE INDEX "AgentApiKey_clientId_revokedAt_idx" ON "AgentApiKey"("clientId", "revokedAt");

CREATE UNIQUE INDEX "AgentEndpointRuntime_runtimeAgentId_key" ON "AgentEndpointRuntime"("runtimeAgentId");
CREATE UNIQUE INDEX "AgentEndpointRuntime_endpointId_revisionId_subjectHash_key" ON "AgentEndpointRuntime"("endpointId", "revisionId", "subjectHash");
CREATE INDEX "AgentEndpointRuntime_endpointId_lastUsedAt_idx" ON "AgentEndpointRuntime"("endpointId", "lastUsedAt");

CREATE UNIQUE INDEX "AgentPublicConversation_publicId_key" ON "AgentPublicConversation"("publicId");
CREATE UNIQUE INDEX "AgentPublicConversation_conversationId_key" ON "AgentPublicConversation"("conversationId");
CREATE INDEX "AgentPublicConversation_endpointId_clientId_subjectHash_cre_idx" ON "AgentPublicConversation"("endpointId", "clientId", "subjectHash", "createdAt");
CREATE INDEX "AgentPublicConversation_runtimeAllocationId_createdAt_idx" ON "AgentPublicConversation"("runtimeAllocationId", "createdAt");

CREATE UNIQUE INDEX "AgentRun_publicId_key" ON "AgentRun"("publicId");
CREATE UNIQUE INDEX "AgentRun_requestId_key" ON "AgentRun"("requestId");
CREATE UNIQUE INDEX "AgentRun_clientId_idempotencyKey_key" ON "AgentRun"("clientId", "idempotencyKey");
CREATE INDEX "AgentRun_endpointId_status_createdAt_idx" ON "AgentRun"("endpointId", "status", "createdAt");
CREATE INDEX "AgentRun_publicConversationId_status_idx" ON "AgentRun"("publicConversationId", "status");
CREATE INDEX "AgentRun_clientId_subjectHash_createdAt_idx" ON "AgentRun"("clientId", "subjectHash", "createdAt");
CREATE INDEX "AgentRun_clientId_createdAt_idx" ON "AgentRun"("clientId", "createdAt");

CREATE INDEX "AgentApiUsageBucket_expiresAt_idx" ON "AgentApiUsageBucket"("expiresAt");

-- AddForeignKey
ALTER TABLE "AgentEndpoint" ADD CONSTRAINT "AgentEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentEndpoint" ADD CONSTRAINT "AgentEndpoint_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentEndpoint" ADD CONSTRAINT "AgentEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentEndpointRevision" ADD CONSTRAINT "AgentEndpointRevision_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentEndpoint" ADD CONSTRAINT "AgentEndpoint_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "AgentEndpointRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentApiClient" ADD CONSTRAINT "AgentApiClient_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApiClient" ADD CONSTRAINT "AgentApiClient_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentApiKey" ADD CONSTRAINT "AgentApiKey_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentEndpointRuntime" ADD CONSTRAINT "AgentEndpointRuntime_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentEndpointRuntime" ADD CONSTRAINT "AgentEndpointRuntime_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentEndpointRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentEndpointRuntime" ADD CONSTRAINT "AgentEndpointRuntime_runtimeAgentId_fkey" FOREIGN KEY ("runtimeAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentPublicConversation" ADD CONSTRAINT "AgentPublicConversation_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPublicConversation" ADD CONSTRAINT "AgentPublicConversation_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentEndpointRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentPublicConversation" ADD CONSTRAINT "AgentPublicConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPublicConversation" ADD CONSTRAINT "AgentPublicConversation_runtimeAllocationId_fkey" FOREIGN KEY ("runtimeAllocationId") REFERENCES "AgentEndpointRuntime"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPublicConversation" ADD CONSTRAINT "AgentPublicConversation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentEndpointRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_publicConversationId_fkey" FOREIGN KEY ("publicConversationId") REFERENCES "AgentPublicConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_runtimeAllocationId_fkey" FOREIGN KEY ("runtimeAllocationId") REFERENCES "AgentEndpointRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;
