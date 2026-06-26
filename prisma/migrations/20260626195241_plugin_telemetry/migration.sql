-- CreateTable
CREATE TABLE "SkillInvocation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "toolkitId" TEXT,
    "skillSlug" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorClass" TEXT,
    "client" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "toolkitId" TEXT,
    "outcome" TEXT NOT NULL,
    "added" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "client" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillInvocation_workspaceId_createdAt_idx" ON "SkillInvocation"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncEvent_workspaceId_createdAt_idx" ON "SyncEvent"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "SkillInvocation" ADD CONSTRAINT "SkillInvocation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillInvocation" ADD CONSTRAINT "SkillInvocation_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
