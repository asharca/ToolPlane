-- Additive draft settings only. Immutable revision JSON/checksums and session pins are untouched.
ALTER TABLE "Agent"
  ADD COLUMN "subagentMode" TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN "nativeSubagentMaxConcurrency" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "nativeSubagentMaxDepth" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_subagentMode_check" CHECK ("subagentMode" IN ('platform', 'native')),
  ADD CONSTRAINT "Agent_nativeSubagentMaxConcurrency_check" CHECK ("nativeSubagentMaxConcurrency" BETWEEN 1 AND 8),
  ADD CONSTRAINT "Agent_nativeSubagentMaxDepth_check" CHECK ("nativeSubagentMaxDepth" BETWEEN 1 AND 4),
  ADD CONSTRAINT "Agent_nativeSubagentMode_check" CHECK (
    "subagentMode" <> 'native' OR ("runtimeKind" = 'omp' AND NOT "a2aOutboundEnabled"
      AND COALESCE("a2aPolicy"->'targets', '[]'::jsonb) = '[]'::jsonb)
  );
