-- CreateTable
CREATE TABLE "Toolkit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Toolkit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolkitServer" (
    "id" TEXT NOT NULL,
    "toolkitId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,

    CONSTRAINT "ToolkitServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolkitSkill" (
    "id" TEXT NOT NULL,
    "toolkitId" TEXT NOT NULL,
    "installedSkillId" TEXT NOT NULL,

    CONSTRAINT "ToolkitSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Toolkit_workspaceId_slug_key" ON "Toolkit"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ToolkitServer_toolkitId_deploymentId_key" ON "ToolkitServer"("toolkitId", "deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolkitSkill_toolkitId_installedSkillId_key" ON "ToolkitSkill"("toolkitId", "installedSkillId");

-- AddForeignKey
ALTER TABLE "Toolkit" ADD CONSTRAINT "Toolkit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolkitServer" ADD CONSTRAINT "ToolkitServer_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolkitServer" ADD CONSTRAINT "ToolkitServer_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolkitSkill" ADD CONSTRAINT "ToolkitSkill_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolkitSkill" ADD CONSTRAINT "ToolkitSkill_installedSkillId_fkey" FOREIGN KEY ("installedSkillId") REFERENCES "InstalledSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
