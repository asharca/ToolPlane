-- CreateTable
CREATE TABLE "SandboxSnapshot" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SandboxSnapshot_volumeName_key" ON "SandboxSnapshot"("volumeName");

-- CreateIndex
CREATE INDEX "SandboxSnapshot_sandboxId_createdAt_idx" ON "SandboxSnapshot"("sandboxId", "createdAt");

-- AddForeignKey
ALTER TABLE "SandboxSnapshot" ADD CONSTRAINT "SandboxSnapshot_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
