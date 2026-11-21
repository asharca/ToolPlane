-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedSecret" JSONB,
    "authMethod" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthCredential" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "oauthClientId" TEXT,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "encryptedAccessToken" JSONB NOT NULL,
    "encryptedRefreshToken" JSONB,
    "expiresAt" TIMESTAMP(3),
    "accountLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "refreshLeaseUntil" TIMESTAMP(3),
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthPending" (
    "stateHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedVerifier" JSONB NOT NULL,
    "resource" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthPending_pkey" PRIMARY KEY ("stateHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_issuer_key" ON "McpOAuthClient"("issuer");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthCredential_deploymentId_key" ON "McpOAuthCredential"("deploymentId");

-- CreateIndex
CREATE INDEX "McpOAuthCredential_workspaceId_idx" ON "McpOAuthCredential"("workspaceId");

-- CreateIndex
CREATE INDEX "McpOAuthPending_expiresAt_idx" ON "McpOAuthPending"("expiresAt");

-- CreateIndex
CREATE INDEX "McpOAuthPending_deploymentId_idx" ON "McpOAuthPending"("deploymentId");

-- AddForeignKey
ALTER TABLE "McpOAuthCredential" ADD CONSTRAINT "McpOAuthCredential_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthCredential" ADD CONSTRAINT "McpOAuthCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthCredential" ADD CONSTRAINT "McpOAuthCredential_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "McpOAuthClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

