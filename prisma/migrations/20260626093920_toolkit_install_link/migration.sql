-- CreateTable
CREATE TABLE "ToolkitInstallLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "toolkitId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolkitInstallLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolkitInstallLink_toolkitId_userId_key" ON "ToolkitInstallLink"("toolkitId", "userId");

-- AddForeignKey
ALTER TABLE "ToolkitInstallLink" ADD CONSTRAINT "ToolkitInstallLink_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
