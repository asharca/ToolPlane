-- CreateTable
CREATE TABLE "AgentSubAgent" (
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,

    CONSTRAINT "AgentSubAgent_pkey" PRIMARY KEY ("parentId","childId")
);

-- AddForeignKey
ALTER TABLE "AgentSubAgent" ADD CONSTRAINT "AgentSubAgent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSubAgent" ADD CONSTRAINT "AgentSubAgent_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
