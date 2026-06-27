-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "curated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Skill" ADD COLUMN     "curated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'user',
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'active';
