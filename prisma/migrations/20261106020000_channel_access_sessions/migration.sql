-- AlterTable
ALTER TABLE "AgentChannelConnection" ADD COLUMN     "adminUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "groupSessionsPerUser" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "openToAll" BOOLEAN NOT NULL DEFAULT false,
-- Existing rows keep legacy credential semantics (version 1) until the runtime
-- backfill rewrites them explicitly; rows created afterwards use version 2.
ADD COLUMN     "senderPolicyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "threadSessionsPerUser" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unauthorizedDm" TEXT NOT NULL DEFAULT 'pair';

ALTER TABLE "AgentChannelConnection" ALTER COLUMN "senderPolicyVersion" SET DEFAULT 2;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channelSelectedAt" TIMESTAMP(3),
ADD COLUMN     "modelOverride" JSONB;

-- CreateTable
CREATE TABLE "AgentChannelSenderApproval" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "userName" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChannelSenderApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChannelPairingRequest" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "userName" TEXT,
    "chatId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChannelPairingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChannelInboundEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "queueKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChannelInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentChannelSenderApproval_connectionId_platformUserId_key" ON "AgentChannelSenderApproval"("connectionId", "platformUserId");

-- CreateIndex
CREATE INDEX "AgentChannelPairingRequest_connectionId_status_expiresAt_idx" ON "AgentChannelPairingRequest"("connectionId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentChannelPairingRequest_connectionId_platformUserId_stat_idx" ON "AgentChannelPairingRequest"("connectionId", "platformUserId", "status");

-- CreateIndex
CREATE INDEX "AgentChannelInboundEvent_connectionId_status_createdAt_idx" ON "AgentChannelInboundEvent"("connectionId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentChannelInboundEvent_connectionId_dedupeKey_key" ON "AgentChannelInboundEvent"("connectionId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "AgentChannelSenderApproval" ADD CONSTRAINT "AgentChannelSenderApproval_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelSenderApproval" ADD CONSTRAINT "AgentChannelSenderApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelPairingRequest" ADD CONSTRAINT "AgentChannelPairingRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelPairingRequest" ADD CONSTRAINT "AgentChannelPairingRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelInboundEvent" ADD CONSTRAINT "AgentChannelInboundEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
