ALTER TABLE "SandboxMcpToken"
  ADD COLUMN "oauthClientId" TEXT,
  ADD COLUMN "oauthResource" TEXT,
  ADD COLUMN "oauthScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "oauthExpiresAt" TIMESTAMP(3);
CREATE TABLE "SandboxMcpOAuthClient" (
  "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "redirectUris" TEXT[] NOT NULL,
  "tokenEndpointAuthMethod" TEXT NOT NULL, "secretHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "SandboxMcpOAuthCode" (
  "codeHash" TEXT NOT NULL PRIMARY KEY, "clientId" TEXT NOT NULL, "sandboxId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "redirectUri" TEXT NOT NULL, "resource" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL, "codeChallenge" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "SandboxMcpOAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "SandboxMcpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SandboxMcpOAuthCode_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SandboxMcpOAuthCode_expiresAt_idx" ON "SandboxMcpOAuthCode"("expiresAt");
CREATE TABLE "SandboxMcpOAuthRefresh" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY, "grantId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "SandboxMcpOAuthRefresh_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "SandboxMcpToken"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SandboxMcpOAuthRefresh_grantId_idx" ON "SandboxMcpOAuthRefresh"("grantId");
CREATE INDEX "SandboxMcpOAuthRefresh_expiresAt_idx" ON "SandboxMcpOAuthRefresh"("expiresAt");
