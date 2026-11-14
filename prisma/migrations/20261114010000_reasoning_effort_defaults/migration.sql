ALTER TABLE "Agent" ADD COLUMN "reasoningEffort" TEXT;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_reasoningEffort_check"
  CHECK ("reasoningEffort" IS NULL OR "reasoningEffort" IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

ALTER TABLE "ChatAssistant" ADD COLUMN "reasoningEffort" TEXT;
ALTER TABLE "ChatAssistant" ADD CONSTRAINT "ChatAssistant_reasoningEffort_check"
  CHECK ("reasoningEffort" IS NULL OR "reasoningEffort" IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
