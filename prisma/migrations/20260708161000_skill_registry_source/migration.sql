ALTER TABLE "Skill" ADD COLUMN IF NOT EXISTS "sourceRegistry" TEXT;
ALTER TABLE "Skill" ADD COLUMN IF NOT EXISTS "sourcePath" TEXT;
ALTER TABLE "Skill" ADD COLUMN IF NOT EXISTS "sourceSha" TEXT;

CREATE INDEX IF NOT EXISTS "Skill_sourceRegistry_sourcePath_idx" ON "Skill"("sourceRegistry", "sourcePath");
