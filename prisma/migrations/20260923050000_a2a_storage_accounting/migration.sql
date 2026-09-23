-- Additive payload accounting for native tasks; do not migrate or replay any execution.
ALTER TABLE "A2ATask" ADD COLUMN "storageBytes" INTEGER NOT NULL DEFAULT 0;
UPDATE "A2ATask" t SET "storageBytes" = (
  octet_length(t.snapshot::text)::bigint + octet_length(t.request::text) + octet_length(t.grant::text)
  + COALESCE((SELECT SUM(octet_length(e.payload::text)) FROM "A2AEvent" e WHERE e."taskId"=t.id),0)
  + 512 * (SELECT COUNT(*) FROM "A2ARequest" r WHERE r."taskId"=t.id)
)::integer;
ALTER TABLE "A2ATask" ADD CONSTRAINT "A2ATask_storageBytes_nonnegative" CHECK ("storageBytes" >= 0);
