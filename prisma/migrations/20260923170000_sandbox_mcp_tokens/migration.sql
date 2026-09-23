CREATE TABLE "SandboxMcpToken" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "allowedTools" TEXT[] NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SandboxMcpToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SandboxMcpToken_tokenHash_key" ON "SandboxMcpToken"("tokenHash");
CREATE INDEX "SandboxMcpToken_sandboxId_idx" ON "SandboxMcpToken"("sandboxId");
ALTER TABLE "SandboxMcpToken" ADD CONSTRAINT "SandboxMcpToken_sandboxId_fkey"
  FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
