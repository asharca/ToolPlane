ALTER TABLE "Agent"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "disabledBuiltinTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
