ALTER TABLE "A2ATaskFile"
  DROP CONSTRAINT "A2ATaskFile_size_check",
  ADD CONSTRAINT "A2ATaskFile_size_check"
    CHECK ("size" IS NULL OR ("size" >= 0 AND "size" <= 104857600));
