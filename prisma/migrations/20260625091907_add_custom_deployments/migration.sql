-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "installCfg" JSONB,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ALTER COLUMN "serverId" DROP NOT NULL;
