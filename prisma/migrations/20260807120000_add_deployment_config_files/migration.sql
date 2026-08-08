-- CreateTable
CREATE TABLE "DeploymentConfigFile" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pathKey" TEXT NOT NULL,
    "encryptedContent" JSONB NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentConfigFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentConfigFile_deploymentId_pathKey_key" ON "DeploymentConfigFile"("deploymentId", "pathKey");

-- CreateIndex
CREATE INDEX "DeploymentConfigFile_deploymentId_updatedAt_idx" ON "DeploymentConfigFile"("deploymentId", "updatedAt");

-- AddForeignKey
ALTER TABLE "DeploymentConfigFile" ADD CONSTRAINT "DeploymentConfigFile_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
