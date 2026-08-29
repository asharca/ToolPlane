ALTER TABLE "MarketListing" ADD COLUMN "sourceChatAssistantId" TEXT;
ALTER TABLE "ChatAssistant" ADD COLUMN "marketTemplateReleaseId" TEXT;

CREATE UNIQUE INDEX "MarketListing_sourceChatAssistantId_key" ON "MarketListing"("sourceChatAssistantId");
CREATE INDEX "ChatAssistant_marketTemplateReleaseId_idx" ON "ChatAssistant"("marketTemplateReleaseId");

ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceChatAssistantId_fkey"
  FOREIGN KEY ("sourceChatAssistantId") REFERENCES "ChatAssistant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatAssistant" ADD CONSTRAINT "ChatAssistant_marketTemplateReleaseId_fkey"
  FOREIGN KEY ("marketTemplateReleaseId") REFERENCES "MarketRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
